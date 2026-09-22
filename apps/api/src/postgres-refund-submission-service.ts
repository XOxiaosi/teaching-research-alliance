import { createHash } from "node:crypto";
import type { RoleContext } from "@teaching-research-alliance/contracts";
import { financeYearBounds } from "./finance-year.js";
import { LocalAttachmentStore, type AttachmentMediaType } from "./local-attachment-store.js";
import type { PostgresClient, PostgresPool } from "./postgres-ledger-repository.js";

export type RefundSubmissionDraft = Readonly<{
  expectedVersion: number;
  reason: string;
  weeklyFeeEntryIds: readonly string[];
  attachmentVersionIds: readonly string[];
}>;
export type RefundSubmissionResult = Readonly<{ id: string; status: "PENDING_APPROVAL"; version: number; replay: boolean }>;

type DocumentRow = Readonly<{ id: string; applicant_person_id: string; kind: string; status: string; version: string }>;
type FeeMonthRow = Readonly<{ id: string; settlement_month: string }>;
type FeeRow = Readonly<{
  id: string; version: string; gross_amount_cents: string; teaching_week_id: string; settlement_month: string;
  referral_case_id: string; receiver_person_id: string; teacher_student_record_id: string;
}>;
type AttachmentRow = Readonly<{
  id: string; attachment_id: string; purpose: string; status: string; detected_media_type: string | null;
  actual_size_bytes: string | null; sha256: string | null;
}>;
type IdempotencyRow = Readonly<{ request_hash: string; finance_document_id: string; result_document_version: string; result_status: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const PERSONAL_SCOPES = ["SELF", "REGION", "CAMPUS", "ASSOCIATED_TEACHERS", "MENTEES", "VENUE", "GLOBAL"] as const;
const ALLOWED_PURPOSES = ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT", "INVOICE"] as const;
const REQUIRED_PURPOSES = ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT"] as const;

const fail = (code: string): never => { throw new Error(code); };
const scopeOf = (context: RoleContext): string | undefined => (context as RoleContext & { scope?: string }).scope;
const canonicalUuid = (value: string): string => { if (!UUID.test(value)) fail("INVALID_INPUT"); return value.toLowerCase(); };
const snapshotId = (value: string | undefined): string | null => value === undefined ? null : canonicalUuid(value);
const validKey = (value: string): void => { if (!value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) fail("INVALID_INPUT"); };
const validAt = (value: Date): void => { if (!Number.isFinite(value.getTime())) fail("INVALID_INPUT"); };
const expectedVersion = (value: number): number => { if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) fail("INVALID_INPUT"); return value; };
const versionOf = (value: string, code = "FINANCE_REFUND_DATA_UNAVAILABLE"): number => {
  const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed >= Number.MAX_SAFE_INTEGER) fail(code); return parsed;
};
const reasonOf = (value: string): string => { const reason = value.trim(); if (!reason || reason.length > 1_000 || /[\x00-\x1f\x7f]/.test(reason)) fail("INVALID_INPUT"); return reason; };
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const assertApplicant = (context: RoleContext): string => {
  if (context.subject !== "TEACHING_TEACHER" || !PERSONAL_SCOPES.includes(scopeOf(context) as (typeof PERSONAL_SCOPES)[number])) fail("FORBIDDEN_SCOPE");
  return canonicalUuid(context.personId);
};

/** Freezes a teacher's selected weekly fees and exact evidence. It never posts balances. */
export class PostgresRefundSubmissionService {
  public constructor(private readonly pool: PostgresPool, private readonly store: LocalAttachmentStore) {}

  public async submit(context: RoleContext, documentIdInput: string, draft: RefundSubmissionDraft, idempotencyKey: string, at: Date): Promise<RefundSubmissionResult> {
    const actorId = assertApplicant(context);
    const documentId = canonicalUuid(documentIdInput);
    const version = expectedVersion(draft.expectedVersion);
    const reason = reasonOf(draft.reason);
    validKey(idempotencyKey); validAt(at);
    const feeIds = this.canonicalIds(draft.weeklyFeeEntryIds, true);
    const attachmentIds = this.canonicalIds(draft.attachmentVersionIds, true, 20);
    const request = ["refund.submit.v1", actorId, documentId, version, reason, feeIds, attachmentIds];
    const hashed = hash(request);

    return this.inTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`refund:${actorId}:SUBMIT:${idempotencyKey}`]);
      const replay = await this.replay(client, actorId, idempotencyKey, hashed);
      if (replay !== undefined) return replay;

      const document = await this.lockOwnCurrentYearDraft(client, documentId, actorId, at);
      if (document.kind !== "REFUND" || document.status !== "DRAFT") fail("REFUND_STATE_CONFLICT");
      if (versionOf(document.version) !== version) fail("VERSION_CONFLICT");

      // Determine the sorted month lock set before locking rows, then re-check every fee under the locks.
      const proposedMonths = await this.readFeeMonths(client, feeIds);
      const months = [...new Set(proposedMonths.map(row => row.settlement_month))].sort();
      for (const month of months) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`settlement-month:${month}`]);
      const fees = await this.lockFees(client, feeIds, actorId, at);
      if (new Set(fees.map(fee => fee.settlement_month)).size !== months.length
        || fees.some(fee => !months.includes(fee.settlement_month))) fail("FINANCE_REFUND_DATA_UNAVAILABLE");
      const referralId = fees[0]!.referral_case_id;
      const studentId = fees[0]!.teacher_student_record_id;
      if (fees.some(fee => fee.referral_case_id !== referralId || fee.teacher_student_record_id !== studentId || fee.receiver_person_id !== actorId)) fail("FORBIDDEN_SCOPE");

      const attachments = await this.lockReadyAttachments(client, document.id, attachmentIds);
      await this.verifyAttachments(attachments);

      const nextVersion = version + 1;
      const applicantSnapshot = {
        applicantPersonId: actorId,
        applicantContextSubject: context.subject,
        applicantContextScope: scopeOf(context),
        applicantContextRegionId: snapshotId(context.regionId),
        applicantContextCampusId: snapshotId(context.campusId),
        applicantContextVenueId: snapshotId(context.venueId),
        referralCaseId: referralId,
        studentRecordId: studentId
      };
      await client.query(
        "UPDATE finance_document SET status='PENDING_APPROVAL',version=$2::bigint,updated_at=$3::timestamptz WHERE id=$1::uuid",
        [document.id, nextVersion, at.toISOString()]
      );
      await client.query(
        `INSERT INTO finance_refund_submission(
           finance_document_id,referral_case_id,student_record_id,source_document_version,result_document_version,
           reason,applicant_context_snapshot,submitted_by_person_id,submitted_at,created_at
         ) VALUES($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::bigint,$6,$7::jsonb,$8::uuid,$9::timestamptz,$9::timestamptz)`,
        [document.id, referralId, studentId, version, nextVersion, reason, JSON.stringify(applicantSnapshot), actorId, at.toISOString()]
      );
      for (const fee of fees) {
        await client.query(
          `INSERT INTO finance_refund_submission_item(
             finance_document_id,weekly_fee_entry_id,submitted_fee_version,submitted_gross_amount_cents,teaching_week_id,settlement_month
           ) VALUES($1::uuid,$2::uuid,$3::bigint,$4::bigint,$5::uuid,$6::date)`,
          [document.id, fee.id, fee.version, fee.gross_amount_cents, fee.teaching_week_id, fee.settlement_month]
        );
      }
      for (const attachment of attachments) {
        await client.query(
          `INSERT INTO finance_refund_attachment_binding(
             finance_document_id,stage,purpose,finance_attachment_version_id,document_version,bound_by_person_id,bound_at,created_at
           ) VALUES($1::uuid,'SUBMISSION',$2,$3::uuid,$4::bigint,$5::uuid,$6::timestamptz,$6::timestamptz)`,
          [document.id, attachment.purpose, attachment.id, nextVersion, actorId, at.toISOString()]
        );
      }
      await client.query(
        `INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,details_json,created_at)
         VALUES($1::uuid,'REFUND_SUBMITTED',$2::uuid,$3::bigint,$4::jsonb,$5::timestamptz)`,
        [document.id, actorId, nextVersion, JSON.stringify({ reason, referralCaseId: referralId, studentRecordId: studentId, weeklyFeeEntryIds: feeIds, applicantContext: applicantSnapshot }), at.toISOString()]
      );
      await client.query(
        `INSERT INTO finance_refund_command_idempotency(
           actor_person_id,operation,idempotency_key,request_hash,finance_document_id,result_status,result_document_version,created_at
         ) VALUES($1::uuid,'SUBMIT',$2,$3,$4::uuid,'PENDING_APPROVAL',$5::bigint,$6::timestamptz)`,
        [actorId, idempotencyKey, hashed, document.id, nextVersion, at.toISOString()]
      );
      return { id: document.id, status: "PENDING_APPROVAL", version: nextVersion, replay: false };
    });
  }

  private canonicalIds(values: readonly string[], required: boolean, maximum?: number): readonly string[] {
    if (!required || values.length === 0 || (maximum !== undefined && values.length > maximum)) fail("INVALID_INPUT");
    const ids = values.map(canonicalUuid).sort();
    if (new Set(ids).size !== ids.length) fail("INVALID_INPUT");
    return ids;
  }

  private async inTransaction<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect(); let committed = false;
    try { await client.query("BEGIN"); const value = await work(client); await client.query("COMMIT"); committed = true; return value; }
    catch (error) { if (!committed) await client.query("ROLLBACK"); throw error; }
    finally { await client.release(); }
  }

  private async replay(client: PostgresClient, actorId: string, key: string, hashed: string): Promise<RefundSubmissionResult | undefined> {
    const row = (await client.query<IdempotencyRow>(
      `SELECT request_hash,finance_document_id::text AS finance_document_id,result_document_version::text AS result_document_version,result_status
         FROM finance_refund_command_idempotency
        WHERE actor_person_id=$1::uuid AND operation='SUBMIT' AND idempotency_key=$2 FOR SHARE`, [actorId, key]
    )).rows[0];
    if (row === undefined) return undefined;
    if (row.request_hash !== hashed || row.result_status !== "PENDING_APPROVAL") fail("IDEMPOTENCY_REPLAY");
    return { id: canonicalUuid(row.finance_document_id), status: "PENDING_APPROVAL", version: versionOf(row.result_document_version), replay: true };
  }

  private async lockOwnCurrentYearDraft(client: PostgresClient, documentId: string, actorId: string, at: Date): Promise<DocumentRow> {
    const bounds = financeYearBounds(at);
    const row = (await client.query<DocumentRow>(
      `SELECT id::text AS id,applicant_person_id::text AS applicant_person_id,kind,status,version::text AS version
         FROM finance_document
        WHERE id=$1::uuid AND applicant_person_id=$2::uuid AND created_at >= $3::timestamptz AND created_at < $4::timestamptz
        FOR UPDATE`, [documentId, actorId, bounds.start, bounds.end]
    )).rows[0];
    if (row === undefined) fail("FINANCE_DOCUMENT_NOT_FOUND");
    return row!;
  }

  private async readFeeMonths(client: PostgresClient, ids: readonly string[]): Promise<readonly FeeMonthRow[]> {
    const rows = (await client.query<FeeMonthRow>(
      "SELECT id::text AS id,settlement_month::text AS settlement_month FROM weekly_fee_entry WHERE id=ANY($1::uuid[]) ORDER BY id", [ids]
    )).rows;
    if (rows.length !== ids.length) fail("FINANCE_REFUND_DATA_UNAVAILABLE");
    return rows;
  }

  private async lockFees(client: PostgresClient, ids: readonly string[], actorId: string, at: Date): Promise<readonly FeeRow[]> {
    const rows = (await client.query<FeeRow>(
      `SELECT fee.id::text AS id,fee.version::text AS version,fee.gross_amount_cents::text AS gross_amount_cents,
              fee.teaching_week_id::text AS teaching_week_id,fee.settlement_month::text AS settlement_month,
              referral.id::text AS referral_case_id,referral.receiver_person_id::text AS receiver_person_id,
              referral.teacher_student_record_id::text AS teacher_student_record_id
         FROM weekly_fee_entry fee
         JOIN referral_case referral ON referral.id=fee.referral_case_id
        WHERE fee.id=ANY($1::uuid[]) AND referral.receiver_person_id=$2::uuid
          AND EXISTS (
            SELECT 1 FROM teaching_week week
            JOIN academic_period period ON period.id=week.academic_period_id
            JOIN academic_year_plan year_plan ON year_plan.id=period.academic_year_plan_id
            WHERE week.id=fee.teaching_week_id
              AND ($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date BETWEEN year_plan.starts_on AND year_plan.ends_on
          )
        ORDER BY fee.id FOR UPDATE OF fee`, [ids, actorId, at.toISOString()]
    )).rows;
    if (rows.length !== ids.length) fail("FORBIDDEN_SCOPE");
    // Check state only after ownership and financial-year authorization. The
    // month locks also serialize this check with refund approval.
    const refunded = await client.query(
      "SELECT 1 FROM weekly_fee_refund_effect WHERE weekly_fee_entry_id=ANY($1::uuid[]) LIMIT 1", [ids]
    );
    if (refunded.rows.length !== 0) fail("WEEKLY_FEE_REFUNDED");
    return rows;
  }

  private async lockReadyAttachments(client: PostgresClient, documentId: string, ids: readonly string[]): Promise<readonly AttachmentRow[]> {
    const rows = (await client.query<AttachmentRow>(
      `SELECT version.id::text AS id,attachment.id::text AS attachment_id,attachment.purpose,version.status,
              version.detected_media_type,version.actual_size_bytes::text AS actual_size_bytes,version.sha256
         FROM finance_attachment_version version
         JOIN finance_attachment attachment ON attachment.id=version.finance_attachment_id
        WHERE attachment.finance_document_id=$1::uuid AND version.id=ANY($2::uuid[])
        FOR SHARE OF attachment,version`, [documentId, ids]
    )).rows;
    if (rows.length !== ids.length || new Set(rows.map(row => row.attachment_id)).size !== rows.length
      || rows.some(row => row.status !== "READY" || !ALLOWED_PURPOSES.includes(row.purpose as (typeof ALLOWED_PURPOSES)[number]))
      || REQUIRED_PURPOSES.some(purpose => !rows.some(row => row.purpose === purpose))) fail("FINANCE_ATTACHMENT_NOT_READY");
    return rows;
  }

  private async verifyAttachments(rows: readonly AttachmentRow[]): Promise<void> {
    for (const row of rows) {
      const size = row.actual_size_bytes === null ? NaN : Number(row.actual_size_bytes);
      if (!row.detected_media_type || !Number.isSafeInteger(size) || size < 1 || row.sha256 === null || !SHA256.test(row.sha256)) fail("ATTACHMENT_INTEGRITY_FAILED");
      try { await this.store.readVerified({ versionId: row.id, mediaType: row.detected_media_type as AttachmentMediaType, sizeBytes: size, sha256: row.sha256 as string }); }
      catch { fail("ATTACHMENT_INTEGRITY_FAILED"); }
    }
  }
}
