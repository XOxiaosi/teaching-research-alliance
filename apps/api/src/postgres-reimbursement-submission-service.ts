import { createHash } from "node:crypto";
import type { RoleContext } from "@teaching-research-alliance/contracts";
import { financeYearBounds } from "./finance-year.js";
import { LocalAttachmentStore, type AttachmentMediaType } from "./local-attachment-store.js";
import type { PostgresClient, PostgresPool } from "./postgres-ledger-repository.js";

export type ReimbursementSubmissionDraft = Readonly<{
  expectedVersion: number;
  amountCents: string;
  reason: string;
  attachmentVersionIds: readonly string[];
}>;
export type ReimbursementSubmissionResult = Readonly<{ id: string; status: "PENDING_APPROVAL"; version: number; replay: boolean }>;

type DocumentRow = Readonly<{ id: string; applicant_person_id: string; kind: string; status: string; version: string }>;
type AccountRow = Readonly<{ id: string; owner_type: string; owner_id: string; status: string }>;
type AttachmentRow = Readonly<{
  id: string; attachment_id: string; purpose: string; status: string; detected_media_type: string | null; actual_size_bytes: string | null; sha256: string | null;
}>;
type IdempotencyRow = Readonly<{ request_hash: string; finance_document_id: string; result_status: string; result_document_version: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const BIGINT_MAX = 9_223_372_036_854_775_807n;
const PERSONAL_SUBJECTS = ["TEACHER", "TEACHING_TEACHER", "ACADEMIC_PLANNER", "PLANNING_MENTOR"] as const;
const PERSONAL_SCOPES = ["SELF", "REGION", "CAMPUS", "ASSOCIATED_TEACHERS", "MENTEES", "VENUE", "GLOBAL"] as const;
const ALLOWED_PURPOSES = ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT", "INVOICE"] as const;
const REQUIRED_PURPOSE = "APPLICATION_SCREENSHOT";
const SCREENSHOT_MEDIA_TYPES = ["image/png", "image/jpeg"] as const;
const fail = (code: string): never => { throw new Error(code); };
const scopeOf = (context: RoleContext): string | undefined => (context as RoleContext & { scope?: string }).scope;
const canonicalUuid = (value: string): string => { if (!UUID.test(value)) fail("INVALID_INPUT"); return value.toLowerCase(); };
const snapshotId = (value: string | undefined): string | null => { if (value === undefined) return null; return canonicalUuid(value); };
const validKey = (value: string): void => { if (!value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) fail("INVALID_INPUT"); };
const validAt = (value: Date): void => { if (!Number.isFinite(value.getTime())) fail("INVALID_INPUT"); };
const versionOf = (value: string): number => { const number = Number(value); if (!Number.isSafeInteger(number) || number < 1 || number >= Number.MAX_SAFE_INTEGER) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE"); return number; };
const expectedVersion = (value: number): number => { if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) fail("INVALID_INPUT"); return value; };
const amountOf = (value: string): bigint => {
  if (!/^[0-9]+$/.test(value) || value.length > 19) fail("INVALID_INPUT");
  const amount = BigInt(value); if (amount < 1n || amount > BIGINT_MAX) fail("INVALID_INPUT"); return amount;
};
const reasonOf = (value: string): string => { const reason = value.trim(); if (!reason || reason.length > 1_000 || /[\x00-\x1f\x7f]/.test(reason)) fail("INVALID_INPUT"); return reason; };
const requestHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const result = (id: string, version: number, replay: boolean): ReimbursementSubmissionResult => ({ id, status: "PENDING_APPROVAL", version, replay });

const assertApplicant = (context: RoleContext): string => {
  if (!PERSONAL_SUBJECTS.includes(context.subject as (typeof PERSONAL_SUBJECTS)[number])
    || !PERSONAL_SCOPES.includes(scopeOf(context) as (typeof PERSONAL_SCOPES)[number])) fail("FORBIDDEN_SCOPE");
  return canonicalUuid(context.personId);
};

/** Freezes a normal reimbursement request and its exact READY evidence. No balance or ledger is changed here. */
export class PostgresReimbursementSubmissionService {
  public constructor(private readonly pool: PostgresPool, private readonly store: LocalAttachmentStore) {}

  public async submit(context: RoleContext, documentIdInput: string, draft: ReimbursementSubmissionDraft, idempotencyKey: string, at: Date): Promise<ReimbursementSubmissionResult> {
    const actorId = assertApplicant(context);
    const documentId = canonicalUuid(documentIdInput);
    const version = expectedVersion(draft.expectedVersion);
    const amount = amountOf(draft.amountCents);
    const reason = reasonOf(draft.reason);
    validKey(idempotencyKey); validAt(at);
    const attachmentIds = this.canonicalAttachments(draft.attachmentVersionIds);
    const canonicalRequest = ["reimbursement.submit.v1", actorId, documentId, version, amount.toString(), reason, attachmentIds];
    const hashed = requestHash(canonicalRequest);
    return this.inTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`reimbursement:${actorId}:SUBMIT:${idempotencyKey}`]);
      const replay = await this.replay(client, actorId, idempotencyKey, hashed);
      if (replay !== undefined) return replay;
      const document = await this.lockApplicantDraft(client, documentId, actorId, at);
      if (document.kind !== "REIMBURSEMENT" || document.status !== "DRAFT") fail("REIMBURSEMENT_STATE_CONFLICT");
      if (versionOf(document.version) !== version) fail("VERSION_CONFLICT");
      const destination = await this.lockDestinationAccount(client, actorId);
      const attachments = await this.lockReadyAttachments(client, document.id, attachmentIds);
      await this.verifyAttachments(attachments);
      const nextVersion = version + 1;
      const snapshot = {
        applicantPersonId: actorId,
        applicantContextSubject: context.subject,
        applicantContextScope: scopeOf(context),
        applicantContextRegionId: snapshotId(context.regionId),
        applicantContextCampusId: snapshotId(context.campusId),
        applicantContextVenueId: snapshotId(context.venueId),
        destinationAccountId: destination.id
      };
      await client.query("UPDATE finance_document SET status='PENDING_APPROVAL',version=$2::bigint,updated_at=$3::timestamptz WHERE id=$1::uuid", [document.id, nextVersion, at.toISOString()]);
      await client.query(
        `INSERT INTO finance_reimbursement_submission(finance_document_id,source_document_version,result_document_version,destination_account_id,amount_cents,reason,applicant_context_snapshot,submitted_by_person_id,submitted_at,created_at)
         VALUES($1::uuid,$2::bigint,$3::bigint,$4::uuid,$5::bigint,$6,$7::jsonb,$8::uuid,$9::timestamptz,$9::timestamptz)`,
        [document.id, version, nextVersion, destination.id, amount.toString(), reason, JSON.stringify(snapshot), actorId, at.toISOString()]
      );
      for (const attachment of attachments) await client.query(
        `INSERT INTO finance_reimbursement_attachment_binding(finance_document_id,stage,purpose,finance_attachment_version_id,document_version,bound_by_person_id,bound_at,created_at)
         VALUES($1::uuid,'SUBMISSION',$2,$3::uuid,$4::bigint,$5::uuid,$6::timestamptz,$6::timestamptz)`,
        [document.id, attachment.purpose, attachment.id, nextVersion, actorId, at.toISOString()]
      );
      await client.query(
        `INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,details_json,created_at)
         VALUES($1::uuid,'REIMBURSEMENT_SUBMITTED',$2::uuid,$3::bigint,$4::jsonb,$5::timestamptz)`,
        [document.id, actorId, nextVersion, JSON.stringify({ amountCents: amount.toString(), reason, destinationAccountId: destination.id, applicantContext: snapshot }), at.toISOString()]
      );
      await client.query(
        `INSERT INTO finance_reimbursement_command_idempotency(actor_person_id,operation,idempotency_key,request_hash,finance_document_id,result_status,result_document_version,created_at)
         VALUES($1::uuid,'SUBMIT',$2,$3,$4::uuid,'PENDING_APPROVAL',$5::bigint,$6::timestamptz)`,
        [actorId, idempotencyKey, hashed, document.id, nextVersion, at.toISOString()]
      );
      return result(document.id, nextVersion, false);
    });
  }

  private canonicalAttachments(ids: readonly string[]): readonly string[] {
    if (ids.length < 1 || ids.length > 20) fail("INVALID_INPUT");
    const result = ids.map(canonicalUuid).sort();
    if (new Set(result).size !== result.length) fail("INVALID_INPUT");
    return result;
  }

  private async inTransaction<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect(); let committed = false;
    try { await client.query("BEGIN"); const value = await work(client); await client.query("COMMIT"); committed = true; return value; }
    catch (error) { if (!committed) await client.query("ROLLBACK"); throw error; }
    finally { await client.release(); }
  }

  private async replay(client: PostgresClient, actorId: string, key: string, hashed: string): Promise<ReimbursementSubmissionResult | undefined> {
    const row = (await client.query<IdempotencyRow>(
      `SELECT request_hash,finance_document_id::text AS finance_document_id,result_status,result_document_version::text AS result_document_version
         FROM finance_reimbursement_command_idempotency WHERE actor_person_id=$1::uuid AND operation='SUBMIT' AND idempotency_key=$2 FOR SHARE`, [actorId, key]
    )).rows[0];
    if (row === undefined) return undefined;
    if (row.request_hash !== hashed || row.result_status !== "PENDING_APPROVAL") fail("IDEMPOTENCY_REPLAY");
    return result(canonicalUuid(row.finance_document_id), versionOf(row.result_document_version), true);
  }

  private async lockApplicantDraft(client: PostgresClient, documentId: string, actorId: string, at: Date): Promise<DocumentRow> {
    const bounds = financeYearBounds(at);
    const row = (await client.query<DocumentRow>(
      `SELECT id::text AS id,applicant_person_id::text AS applicant_person_id,kind,status,version::text AS version
         FROM finance_document WHERE id=$1::uuid AND applicant_person_id=$2::uuid
           AND created_at >= $3::timestamptz AND created_at < $4::timestamptz FOR UPDATE`,
      [documentId, actorId, bounds.start, bounds.end]
    )).rows[0];
    if (row === undefined) fail("FINANCE_DOCUMENT_NOT_FOUND");
    return row!;
  }

  private async lockDestinationAccount(client: PostgresClient, actorId: string): Promise<AccountRow> {
    const rows = (await client.query<AccountRow>(
      `SELECT id::text AS id,owner_type,owner_id::text AS owner_id,status FROM settlement_account
        WHERE owner_type='PERSON' AND owner_id=$1::uuid AND status='ACTIVE' ORDER BY id LIMIT 2 FOR SHARE`, [actorId]
    )).rows;
    if (rows.length !== 1) fail("PERSONAL_ACCOUNT_NOT_FOUND");
    return rows[0]!;
  }

  private async lockReadyAttachments(client: PostgresClient, documentId: string, ids: readonly string[]): Promise<readonly AttachmentRow[]> {
    const rows = (await client.query<AttachmentRow>(
      `SELECT version.id::text AS id,attachment.id::text AS attachment_id,attachment.purpose,version.status,version.detected_media_type,
              version.actual_size_bytes::text AS actual_size_bytes,version.sha256
         FROM finance_attachment_version version JOIN finance_attachment attachment ON attachment.id=version.finance_attachment_id
        WHERE attachment.finance_document_id=$1::uuid AND version.id=ANY($2::uuid[]) FOR SHARE OF attachment,version`, [documentId, ids]
    )).rows;
    if (rows.length !== ids.length || new Set(rows.map(row => row.attachment_id)).size !== rows.length
      || rows.some(row => row.status !== "READY" || !ALLOWED_PURPOSES.includes(row.purpose as (typeof ALLOWED_PURPOSES)[number]))
      || rows.some(row => row.purpose === REQUIRED_PURPOSE
        && !SCREENSHOT_MEDIA_TYPES.includes(row.detected_media_type as (typeof SCREENSHOT_MEDIA_TYPES)[number]))
      || !rows.some(row => row.purpose === REQUIRED_PURPOSE)) fail("FINANCE_ATTACHMENT_NOT_READY");
    return rows;
  }

  private async verifyAttachments(rows: readonly AttachmentRow[]): Promise<void> {
    for (const row of rows) {
      const size = row.actual_size_bytes === null ? NaN : Number(row.actual_size_bytes);
      if (row.detected_media_type === null || !Number.isSafeInteger(size) || size < 1 || row.sha256 === null || !SHA256.test(row.sha256)) fail("ATTACHMENT_INTEGRITY_FAILED");
      const sha256 = row.sha256 as string;
      try { await this.store.readVerified({ versionId: row.id, mediaType: row.detected_media_type as AttachmentMediaType, sizeBytes: size, sha256 }); }
      catch { fail("ATTACHMENT_INTEGRITY_FAILED"); }
    }
  }
}
