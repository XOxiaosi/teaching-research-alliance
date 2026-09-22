import { createHash } from "node:crypto";
import type { RoleContext } from "@teaching-research-alliance/contracts";
import { LocalAttachmentStore, type AttachmentMediaType } from "./local-attachment-store.js";
import type { PostgresClient, PostgresPool } from "./postgres-ledger-repository.js";

export type ReimbursementReviewDraft = Readonly<{ expectedVersion: number; reason: string }>;
export type ReimbursementReviewResult = Readonly<{ id: string; status: "APPROVED" | "REJECTED"; version: number; replay: boolean }>;
type Decision = "APPROVED" | "REJECTED";
type Operation = "APPROVE" | "REJECT";
type DocumentRow = Readonly<{ id: string; applicant_person_id: string; kind: string; status: string; version: string; created_at: string }>;
type SubmissionRow = Readonly<{ source_document_version: string; result_document_version: string; destination_account_id: string; amount_cents: string; reason: string; applicant_context_snapshot: unknown; submitted_by_person_id: string; submitted_at: string; created_at: string }>;
type DestinationAccountRow = Readonly<{ id: string; owner_type: string; owner_id: string }>;
type AttachmentRow = Readonly<{ id: string; attachment_id: string; purpose: string; status: string; detected_media_type: string | null; actual_size_bytes: string | null; sha256: string | null; document_version: string; bound_by_person_id: string }>;
type IdempotencyRow = Readonly<{ request_hash: string; finance_document_id: string; result_status: Decision; result_document_version: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const BIGINT_MAX = 9_223_372_036_854_775_807n;
const REQUIRED_PURPOSES = ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT"] as const;
const PERSONAL_SUBJECTS = ["TEACHING_TEACHER", "ACADEMIC_PLANNER", "PLANNING_MENTOR"] as const;
const PERSONAL_SCOPES = ["SELF", "REGION", "CAMPUS", "ASSOCIATED_TEACHERS", "MENTEES", "VENUE", "GLOBAL"] as const;
const fail = (code: string): never => { throw new Error(code); };
const scopeOf = (context: RoleContext): string | undefined => (context as RoleContext & { scope?: string }).scope;
const canonicalUuid = (value: string): string => { if (!UUID.test(value)) fail("INVALID_INPUT"); return value.toLowerCase(); };
const snapshotId = (value: string | undefined): string | null => { if (value === undefined) return null; return canonicalUuid(value); };
const validKey = (value: string): void => { if (!value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) fail("INVALID_INPUT"); };
const validAt = (value: Date): void => { if (!Number.isFinite(value.getTime())) fail("INVALID_INPUT"); };
const expectedVersion = (value: number): number => { if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) fail("INVALID_INPUT"); return value; };
const versionOf = (value: string): number => { const number = Number(value); if (!Number.isSafeInteger(number) || number < 1 || number >= Number.MAX_SAFE_INTEGER) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE"); return number; };
const reasonOf = (value: string): string => { const reason = value.trim(); if (!reason || reason.length > 1_000 || /[\x00-\x1f\x7f]/.test(reason)) fail("INVALID_INPUT"); return reason; };
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const exactObject = (value: unknown): Record<string, unknown> => { if (typeof value !== "object" || value === null || Array.isArray(value)) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE"); return value as Record<string, unknown>; };
const exactString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  if (typeof value !== "string") fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  return value as string;
};
const exactUuid = (record: Record<string, unknown>, key: string): string => { const value = exactString(record, key); if (!UUID.test(value)) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE"); return value.toLowerCase(); };
const exactNullableUuid = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string") fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  const uuid = value as string;
  if (!UUID.test(uuid)) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  return uuid.toLowerCase();
};
const validTimestamp = (value: string): number => { const parsed = new Date(value).getTime(); if (!Number.isFinite(parsed)) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE"); return parsed; };
const result = (id: string, status: Decision, version: number, replay: boolean): ReimbursementReviewResult => ({ id, status, version, replay });

const assertReviewer = (context: RoleContext): string => {
  if (context.subject !== "HEADQUARTERS_FINANCE" || scopeOf(context) !== "GLOBAL"
    || context.regionId !== undefined || context.campusId !== undefined || context.venueId !== undefined) fail("FORBIDDEN_SCOPE");
  return canonicalUuid(context.personId);
};

/** Records a strict-GLOBAL headquarters review only. Approval deliberately does not execute the future reimbursement transfer. */
export class PostgresReimbursementReviewService {
  public constructor(private readonly pool: PostgresPool, private readonly store: LocalAttachmentStore) {}

  public async approve(context: RoleContext, documentId: string, draft: ReimbursementReviewDraft, idempotencyKey: string, at: Date): Promise<ReimbursementReviewResult> {
    return this.decide(context, documentId, draft, idempotencyKey, at, "APPROVED", "APPROVE");
  }

  public async reject(context: RoleContext, documentId: string, draft: ReimbursementReviewDraft, idempotencyKey: string, at: Date): Promise<ReimbursementReviewResult> {
    return this.decide(context, documentId, draft, idempotencyKey, at, "REJECTED", "REJECT");
  }

  private async decide(context: RoleContext, documentIdInput: string, draft: ReimbursementReviewDraft, idempotencyKey: string, at: Date, decision: Decision, operation: Operation): Promise<ReimbursementReviewResult> {
    const actorId = assertReviewer(context);
    const documentId = canonicalUuid(documentIdInput);
    const version = expectedVersion(draft.expectedVersion);
    const reason = reasonOf(draft.reason);
    validKey(idempotencyKey); validAt(at);
    const request = ["reimbursement.review.v1", operation, actorId, documentId, version, reason];
    const hashed = hash(request);
    return this.inTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`reimbursement:${actorId}:${operation}:${idempotencyKey}`]);
      const replay = await this.replay(client, actorId, operation, idempotencyKey, hashed, decision);
      if (replay !== undefined) return replay;
      const document = await this.lockDocument(client, documentId);
      if (document.kind !== "REIMBURSEMENT" || document.status !== "PENDING_APPROVAL") fail("REIMBURSEMENT_STATE_CONFLICT");
      if (versionOf(document.version) !== version) fail("VERSION_CONFLICT");
      const submission = await this.lockSubmission(client, document);
      await this.assertSubmissionFacts(client, document, submission);
      if (decision === "APPROVED") await this.verifyBoundAttachments(client, document, submission);
      const nextVersion = version + 1;
      const reviewerSnapshot = {
        reviewerPersonId: actorId, reviewerSubjectCode: context.subject, reviewerScopeType: "GLOBAL",
        reviewerContextRegionId: snapshotId(context.regionId), reviewerContextCampusId: snapshotId(context.campusId), reviewerContextVenueId: snapshotId(context.venueId),
        submissionDocumentVersion: version, submissionSnapshot: exactObject(submission.applicant_context_snapshot)
      };
      await client.query("UPDATE finance_document SET status=$2,version=$3::bigint,updated_at=$4::timestamptz WHERE id=$1::uuid", [document.id, decision, nextVersion, at.toISOString()]);
      // The decision trigger requires this immutable command as its seal; an error later rolls the whole transaction back.
      await this.recordCommand(client, actorId, operation, idempotencyKey, hashed, document.id, decision, nextVersion, at);
      await client.query(
        `INSERT INTO finance_reimbursement_decision(finance_document_id,source_document_version,result_document_version,decision,reason,decided_by_person_id,actor_subject_code,actor_scope_type,authorization_snapshot,decided_at,created_at)
         VALUES($1::uuid,$2::bigint,$3::bigint,$4,$5,$6::uuid,'HEADQUARTERS_FINANCE','GLOBAL',$7::jsonb,$8::timestamptz,$8::timestamptz)`,
        [document.id, version, nextVersion, decision, reason, actorId, JSON.stringify(reviewerSnapshot), at.toISOString()]
      );
      await client.query(
        `INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,details_json,created_at)
         VALUES($1::uuid,$2,$3::uuid,$4::bigint,$5::jsonb,$6::timestamptz)`,
        [document.id, decision === "APPROVED" ? "REIMBURSEMENT_APPROVED" : "REIMBURSEMENT_REJECTED", actorId, nextVersion,
          JSON.stringify({ processingMode: "MANUAL", decision, reason, reviewerContext: reviewerSnapshot }), at.toISOString()]
      );
      return result(document.id, decision, nextVersion, false);
    });
  }

  private async inTransaction<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect(); let committed = false;
    try { await client.query("BEGIN"); const value = await work(client); await client.query("COMMIT"); committed = true; return value; }
    catch (error) { if (!committed) await client.query("ROLLBACK"); throw error; }
    finally { await client.release(); }
  }

  private async replay(client: PostgresClient, actorId: string, operation: Operation, key: string, hashed: string, decision: Decision): Promise<ReimbursementReviewResult | undefined> {
    const row = (await client.query<IdempotencyRow>(
      `SELECT request_hash,finance_document_id::text AS finance_document_id,result_status,result_document_version::text AS result_document_version
         FROM finance_reimbursement_command_idempotency WHERE actor_person_id=$1::uuid AND operation=$2 AND idempotency_key=$3 FOR SHARE`, [actorId, operation, key]
    )).rows[0];
    if (row === undefined) return undefined;
    if (row.request_hash !== hashed || row.result_status !== decision) fail("IDEMPOTENCY_REPLAY");
    return result(canonicalUuid(row.finance_document_id), decision, versionOf(row.result_document_version), true);
  }

  private async lockDocument(client: PostgresClient, documentId: string): Promise<DocumentRow> {
    const row = (await client.query<DocumentRow>("SELECT id::text AS id,applicant_person_id::text AS applicant_person_id,kind,status,version::text AS version,created_at::text AS created_at FROM finance_document WHERE id=$1::uuid FOR UPDATE", [documentId])).rows[0];
    if (row === undefined) fail("FINANCE_DOCUMENT_NOT_FOUND"); return row!;
  }

  private async lockSubmission(client: PostgresClient, document: DocumentRow): Promise<SubmissionRow> {
    const row = (await client.query<SubmissionRow>(
      `SELECT source_document_version::text AS source_document_version,result_document_version::text AS result_document_version,destination_account_id::text AS destination_account_id,
              amount_cents::text AS amount_cents,reason,applicant_context_snapshot,submitted_by_person_id::text AS submitted_by_person_id,submitted_at::text AS submitted_at,created_at::text AS created_at
         FROM finance_reimbursement_submission WHERE finance_document_id=$1::uuid FOR SHARE`, [document.id]
    )).rows[0];
    if (row === undefined || row.submitted_by_person_id !== document.applicant_person_id || versionOf(row.result_document_version) !== versionOf(document.version)
      || versionOf(row.source_document_version) + 1 !== versionOf(document.version) || !Number.isFinite(new Date(row.submitted_at).getTime())) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
    return row!;
  }

  /** Validate the same immutable submission facts that the read model relies on before either terminal decision. */
  private async assertSubmissionFacts(client: PostgresClient, document: DocumentRow, submission: SubmissionRow): Promise<void> {
    const submittedAt = validTimestamp(submission.submitted_at);
    if (submittedAt !== validTimestamp(submission.created_at) || submittedAt < validTimestamp(document.created_at)
      || !/^[0-9]+$/.test(submission.amount_cents) || submission.amount_cents.length > 19 || BigInt(submission.amount_cents) < 1n || BigInt(submission.amount_cents) > BIGINT_MAX
      || !submission.reason.trim() || submission.reason.length > 1_000 || /[\x00-\x1f\x7f]/.test(submission.reason)) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
    const destination = (await client.query<DestinationAccountRow>(
      "SELECT id::text AS id,owner_type,owner_id::text AS owner_id FROM settlement_account WHERE id=$1::uuid FOR SHARE", [submission.destination_account_id]
    )).rows[0];
    const snapshot = exactObject(submission.applicant_context_snapshot);
    const subject = exactString(snapshot, "applicantContextSubject");
    const scope = exactString(snapshot, "applicantContextScope");
    const regionId = exactNullableUuid(snapshot, "applicantContextRegionId");
    const campusId = exactNullableUuid(snapshot, "applicantContextCampusId");
    const venueId = exactNullableUuid(snapshot, "applicantContextVenueId");
    if (destination === undefined || destination.owner_type !== "PERSON" || destination.owner_id !== document.applicant_person_id
      || !PERSONAL_SUBJECTS.includes(subject as (typeof PERSONAL_SUBJECTS)[number])
      || !PERSONAL_SCOPES.includes(scope as (typeof PERSONAL_SCOPES)[number])
      || exactUuid(snapshot, "applicantPersonId") !== document.applicant_person_id
      || exactUuid(snapshot, "destinationAccountId") !== submission.destination_account_id) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
    // The three values were parsed above to require explicit UUID-or-null fields in every frozen applicant context.
    void regionId; void campusId; void venueId;
  }

  private async verifyBoundAttachments(client: PostgresClient, document: DocumentRow, submission: SubmissionRow): Promise<void> {
    const rows = (await client.query<AttachmentRow>(
      `SELECT version.id::text AS id,attachment.id::text AS attachment_id,attachment.purpose,version.status,version.detected_media_type,
              version.actual_size_bytes::text AS actual_size_bytes,version.sha256,binding.document_version::text AS document_version,binding.bound_by_person_id::text AS bound_by_person_id
         FROM finance_reimbursement_attachment_binding binding
         JOIN finance_attachment_version version ON version.id=binding.finance_attachment_version_id
         JOIN finance_attachment attachment ON attachment.id=version.finance_attachment_id
        WHERE binding.finance_document_id=$1::uuid AND binding.stage='SUBMISSION' FOR SHARE OF binding,version,attachment`, [document.id]
    )).rows;
    if (rows.length < 2 || new Set(rows.map(row => row.attachment_id)).size !== rows.length
      || REQUIRED_PURPOSES.some(purpose => !rows.some(row => row.purpose === purpose))
      || rows.some(row => row.status !== "READY" || row.document_version !== submission.result_document_version || row.bound_by_person_id !== document.applicant_person_id)) fail("FINANCE_ATTACHMENT_NOT_READY");
    for (const row of rows) {
      const size = row.actual_size_bytes === null ? NaN : Number(row.actual_size_bytes);
      if (row.detected_media_type === null || !Number.isSafeInteger(size) || size < 1 || row.sha256 === null || !SHA256.test(row.sha256)) fail("ATTACHMENT_INTEGRITY_FAILED");
      const sha256 = row.sha256 as string;
      try { await this.store.readVerified({ versionId: row.id, mediaType: row.detected_media_type as AttachmentMediaType, sizeBytes: size, sha256 }); }
      catch { fail("ATTACHMENT_INTEGRITY_FAILED"); }
    }
  }

  private async recordCommand(client: PostgresClient, actorId: string, operation: Operation, key: string, hashed: string, documentId: string, status: Decision, version: number, at: Date): Promise<void> {
    await client.query(
      `INSERT INTO finance_reimbursement_command_idempotency(actor_person_id,operation,idempotency_key,request_hash,finance_document_id,result_status,result_document_version,created_at)
       VALUES($1::uuid,$2,$3,$4,$5::uuid,$6,$7::bigint,$8::timestamptz)`,
      [actorId, operation, key, hashed, documentId, status, version, at.toISOString()]
    );
  }
}
