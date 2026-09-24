import { createHash, randomUUID } from "node:crypto";
import type { RoleContext } from "@teaching-research-alliance/contracts";
import { postLedgerEvent } from "@teaching-research-alliance/domain";
import { financeYearBounds } from "./finance-year.js";
import { LocalAttachmentStore, type AttachmentMediaType } from "./local-attachment-store.js";
import { createPostgresLedgerTransaction, type PostgresClient, type PostgresPool } from "./postgres-ledger-repository.js";
import { prepareLedgerPosting, type PreparedLedgerAccount } from "./postgres-ledger-locks.js";

export type ReimbursementTransferDraft = Readonly<{ expectedVersion: number }>;
export type ReimbursementTransferResult = Readonly<{ id: string; status: "COMPLETED"; version: number; replay: boolean }>;

type DocumentRow = Readonly<{ id: string; applicant_person_id: string; kind: string; status: string; version: string; created_at: string }>;
type SubmissionRow = Readonly<{
  source_document_version: string; result_document_version: string; destination_account_id: string;
  amount_cents: string; reason: string; applicant_context_snapshot: unknown; submitted_by_person_id: string; submitted_at: string; created_at: string;
}>;
type DecisionRow = Readonly<{
  source_document_version: string; result_document_version: string; decision: string; decided_by_person_id: string;
  actor_subject_code: string; actor_scope_type: string; authorization_snapshot: unknown; decided_at: string; created_at: string;
}>;
type AttachmentRow = Readonly<{
  id: string; attachment_id: string; purpose: string; status: string; detected_media_type: string | null;
  actual_size_bytes: string | null; sha256: string | null; document_version: string; bound_by_person_id: string;
}>;
type RoleAssignmentRow = Readonly<{ id: string; valid_from: string; valid_to: string | null }>;
type FundAssignmentRow = Readonly<{ id: string; fund_id: string; valid_from: string; valid_to: string | null }>;
type FundRow = Readonly<{ id: string; fund_code: string; status: string }>;
type AccountCandidate = Readonly<{ id: string; owner_type: "PERSON" | "COMPANY"; owner_id: string; account_code: string; status: "ACTIVE" | "INACTIVE" }>;
type IdempotencyRow = Readonly<{ request_hash: string; finance_document_id: string; result_status: string; result_document_version: string }>;
type HistoricalCommandRow = Readonly<{ actor_person_id: string; result_status: string; result_document_version: string; created_at: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const BIGINT_MAX = 9_223_372_036_854_775_807n;
const REQUIRED_PURPOSE = "APPLICATION_SCREENSHOT";
const PERSONAL_SUBJECTS = ["TEACHER", "TEACHING_TEACHER", "ACADEMIC_PLANNER", "PLANNING_MENTOR"] as const;
const PERSONAL_SCOPES = ["SELF", "REGION", "CAMPUS", "ASSOCIATED_TEACHERS", "MENTEES", "VENUE", "GLOBAL"] as const;

const fail = (code: string): never => { throw new Error(code); };
const scopeOf = (context: RoleContext): string | undefined => (context as RoleContext & { scope?: string }).scope;
const canonicalUuid = (value: string): string => { if (!UUID.test(value)) fail("INVALID_INPUT"); return value.toLowerCase(); };
const versionOf = (value: string): number => { const result = Number(value); if (!Number.isSafeInteger(result) || result < 1 || result >= Number.MAX_SAFE_INTEGER) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE"); return result; };
const expectedVersion = (value: number): number => { if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) fail("INVALID_INPUT"); return value; };
const validAt = (value: Date): void => { if (!Number.isFinite(value.getTime())) fail("INVALID_INPUT"); };
const validKey = (value: string): void => { if (!value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) fail("INVALID_INPUT"); };
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const exactObject = (value: unknown): Record<string, unknown> => { if (typeof value !== "object" || value === null || Array.isArray(value)) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE"); return value as Record<string, unknown>; };
const exactString = (record: Record<string, unknown>, key: string): string => { const value = record[key]; if (typeof value !== "string") fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE"); return value as string; };
const exactUuid = (record: Record<string, unknown>, key: string): string => canonicalUuid(exactString(record, key));
const exactNullableUuid = (record: Record<string, unknown>, key: string): string | null => { const value = record[key]; if (value === null) return null; if (typeof value !== "string") fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE"); return canonicalUuid(value as string); };
const asIso = (value: string, code = "FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE"): string => { const date = new Date(value); if (!Number.isFinite(date.getTime())) fail(code); return date.toISOString(); };
const exactVersion = (record: Record<string, unknown>, key: string): number => { const value = record[key]; if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE"); return value as number; };
const stableJson = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE"); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
};
const result = (id: string, version: number, replay: boolean): ReimbursementTransferResult => ({ id, status: "COMPLETED", version, replay });

const assertExecutor = (context: RoleContext): string => {
  if (context.subject !== "HEADQUARTERS_FINANCE" || scopeOf(context) !== "GLOBAL"
    || context.regionId !== undefined || context.campusId !== undefined || context.venueId !== undefined) fail("FORBIDDEN_SCOPE");
  return canonicalUuid(context.personId);
};

/** Executes an already-approved ordinary reimbursement as one auditable internal ledger transfer. */
export class PostgresReimbursementTransferService {
  public constructor(private readonly pool: PostgresPool, private readonly store: LocalAttachmentStore) {}

  public async execute(
    context: RoleContext,
    documentIdInput: string,
    draft: ReimbursementTransferDraft,
    idempotencyKey: string,
    at: Date
  ): Promise<ReimbursementTransferResult> {
    const actorId = assertExecutor(context);
    const documentId = canonicalUuid(documentIdInput);
    const version = expectedVersion(draft.expectedVersion);
    validKey(idempotencyKey); validAt(at);
    const requestHash = hash(["reimbursement.execute.v1", actorId, documentId, version]);

    return this.inTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`reimbursement:${actorId}:EXECUTE:${idempotencyKey}`]);
      const replay = await this.replay(client, actorId, idempotencyKey, requestHash);
      if (replay !== undefined) return replay;

      const document = await this.lockDocument(client, documentId);
      if (document.kind !== "REIMBURSEMENT" || document.status !== "APPROVED") fail("REIMBURSEMENT_STATE_CONFLICT");
      if (versionOf(document.version) !== version) fail("VERSION_CONFLICT");
      const submission = await this.lockSubmission(client, document);
      const decision = await this.lockApprovedDecision(client, document, submission);
      this.assertExecutionTimeline(document, submission, decision, at);
      this.assertSameFinanceYear(submission.submitted_at, at);
      await this.assertSubmissionFacts(client, document, submission);
      await this.verifyBoundAttachments(client, document, submission);

      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('company-fund-global-config',0))");
      const role = await this.lockCurrentRoleAssignment(client, actorId, at);
      const fundAssignment = await this.lockCurrentFundAssignment(client, at);
      const fund = await this.lockActiveFund(client, fundAssignment.fund_id);
      const sourceCandidate = await this.readAccountCandidate(client, "COMPANY", fund.id);
      const destinationCandidate = await this.readAccountById(client, submission.destination_account_id);
      const eventKey = `reimbursement:${document.id}`;
      const prepared = await prepareLedgerPosting(client, eventKey, [sourceCandidate.account_code, destinationCandidate.account_code]);
      const source = this.revalidatePrepared(prepared, sourceCandidate, "COMPANY", fund.id);
      const destination = this.revalidatePrepared(prepared, destinationCandidate, "PERSON", document.applicant_person_id);
      if (source.status !== "ACTIVE" || destination.status !== "ACTIVE") fail("SOURCE_ACCOUNT_NOT_ACTIVE");

      const amount = this.amountOf(submission.amount_cents);
      const sourceBefore = source.balanceCents;
      const destinationBefore = destination.balanceCents;
      const nextVersion = version + 1;
      const authorizationSnapshot = {
        executorPersonId: actorId,
        executorSubjectCode: "HEADQUARTERS_FINANCE",
        executorScopeType: "GLOBAL",
        roleAssignmentId: role.id,
        roleValidFrom: asIso(role.valid_from),
        roleValidTo: role.valid_to === null ? null : asIso(role.valid_to),
        companyFundAssignmentId: fundAssignment.id,
        fundAssignmentValidFrom: asIso(fundAssignment.valid_from),
        fundAssignmentValidTo: fundAssignment.valid_to === null ? null : asIso(fundAssignment.valid_to),
        sourceFundId: fund.id,
        sourceFundCode: fund.fund_code,
        sourceAccountId: source.id,
        destinationAccountId: destination.id,
        applicantPersonId: document.applicant_person_id,
        submittedAt: asIso(submission.submitted_at),
        approvedAt: asIso(decision.decided_at),
        submissionDocumentVersion: versionOf(submission.result_document_version),
        decisionDocumentVersion: versionOf(decision.result_document_version)
      };
      const posted = await this.postLedger(client, eventKey, source.accountCode, destination.accountCode, amount, {
        financeDocumentId: document.id,
        sourceFundId: fund.id,
        sourceAccountId: source.id,
        destinationAccountId: destination.id,
        applicantPersonId: document.applicant_person_id,
        amountCents: amount.toString(),
        reason: submission.reason,
        authorizationSnapshot
      });
      if (posted.status !== "POSTED" || posted.balances[source.accountCode] !== sourceBefore - amount
        || posted.balances[destination.accountCode] !== destinationBefore + amount) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
      const sourceAfter = sourceBefore - amount;
      const destinationAfter = destinationBefore + amount;

      await client.query("UPDATE finance_document SET status='COMPLETED',version=$2::bigint,updated_at=$3::timestamptz WHERE id=$1::uuid", [document.id, nextVersion, at.toISOString()]);
      await this.recordCommand(client, actorId, idempotencyKey, requestHash, document.id, nextVersion, at);
      await client.query(
        `INSERT INTO finance_reimbursement_transfer(
           finance_document_id,source_document_version,result_document_version,role_assignment_id,company_fund_assignment_id,
           source_fund_id,source_account_id,destination_account_id,amount_cents,reason,authorization_snapshot,ledger_event_id,
           executed_by_person_id,executed_at,created_at,source_before_cents,source_after_cents,destination_before_cents,destination_after_cents
         ) VALUES($1::uuid,$2::bigint,$3::bigint,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,$9::bigint,$10,$11::jsonb,$12::uuid,$13::uuid,$14::timestamptz,$14::timestamptz,$15::bigint,$16::bigint,$17::bigint,$18::bigint)`,
        [document.id, version, nextVersion, role.id, fundAssignment.id, fund.id, source.id, destination.id, amount.toString(), submission.reason,
          JSON.stringify(authorizationSnapshot), posted.eventId, actorId, at.toISOString(), sourceBefore.toString(), sourceAfter.toString(), destinationBefore.toString(), destinationAfter.toString()]
      );
      await client.query(
        `INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,ledger_event_id,details_json,created_at)
         VALUES($1::uuid,'REIMBURSEMENT_COMPLETED',$2::uuid,$3::bigint,$4::uuid,$5::jsonb,$6::timestamptz)`,
        [document.id, actorId, nextVersion, posted.eventId, JSON.stringify({ processingMode: "MANUAL", amountCents: amount.toString(), sourceAccountId: source.id, destinationAccountId: destination.id }), at.toISOString()]
      );
      return result(document.id, nextVersion, false);
    });
  }

  private async inTransaction<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect(); let committed = false;
    try { await client.query("BEGIN"); const value = await work(client); await client.query("COMMIT"); committed = true; return value; }
    catch (error) { if (!committed) await client.query("ROLLBACK"); throw error; }
    finally { await client.release(); }
  }

  private async replay(client: PostgresClient, actorId: string, key: string, requestHash: string): Promise<ReimbursementTransferResult | undefined> {
    const row = (await client.query<IdempotencyRow>(
      `SELECT request_hash,finance_document_id::text AS finance_document_id,result_status,result_document_version::text AS result_document_version
         FROM finance_reimbursement_command_idempotency
        WHERE actor_person_id=$1::uuid AND operation='EXECUTE' AND idempotency_key=$2 FOR SHARE`, [actorId, key]
    )).rows[0];
    if (row === undefined) return undefined;
    if (row.request_hash !== requestHash || row.result_status !== "COMPLETED") fail("IDEMPOTENCY_REPLAY");
    return result(canonicalUuid(row.finance_document_id), versionOf(row.result_document_version), true);
  }

  private async lockDocument(client: PostgresClient, documentId: string): Promise<DocumentRow> {
    const row = (await client.query<DocumentRow>(
      "SELECT id::text AS id,applicant_person_id::text AS applicant_person_id,kind,status,version::text AS version,created_at::text AS created_at FROM finance_document WHERE id=$1::uuid FOR UPDATE", [documentId]
    )).rows[0];
    if (row === undefined) fail("FINANCE_DOCUMENT_NOT_FOUND");
    return row!;
  }

  private async lockSubmission(client: PostgresClient, document: DocumentRow): Promise<SubmissionRow> {
    const row = (await client.query<SubmissionRow>(
      `SELECT source_document_version::text AS source_document_version,result_document_version::text AS result_document_version,
              destination_account_id::text AS destination_account_id,amount_cents::text AS amount_cents,reason,applicant_context_snapshot,
              submitted_by_person_id::text AS submitted_by_person_id,submitted_at::text AS submitted_at,created_at::text AS created_at
         FROM finance_reimbursement_submission WHERE finance_document_id=$1::uuid FOR SHARE`, [document.id]
    )).rows[0];
    if (row === undefined || row.submitted_by_person_id !== document.applicant_person_id
      || versionOf(row.source_document_version) + 1 !== versionOf(row.result_document_version)) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
    return row!;
  }

  private async lockApprovedDecision(client: PostgresClient, document: DocumentRow, submission: SubmissionRow): Promise<DecisionRow> {
    const row = (await client.query<DecisionRow>(
      `SELECT source_document_version::text AS source_document_version,result_document_version::text AS result_document_version,decision,
              decided_by_person_id::text AS decided_by_person_id,actor_subject_code,actor_scope_type,authorization_snapshot,
              decided_at::text AS decided_at,created_at::text AS created_at
         FROM finance_reimbursement_decision WHERE finance_document_id=$1::uuid FOR SHARE`, [document.id]
    )).rows[0];
    if (row === undefined || row.decision !== "APPROVED" || row.actor_subject_code !== "HEADQUARTERS_FINANCE" || row.actor_scope_type !== "GLOBAL"
      || versionOf(row.source_document_version) !== versionOf(submission.result_document_version)
      || versionOf(row.result_document_version) !== versionOf(document.version)
      || versionOf(row.source_document_version) + 1 !== versionOf(row.result_document_version)
      || asIso(row.decided_at) !== asIso(row.created_at)) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
    await this.assertHistoricalCommand(client, document.id, "SUBMIT", submission.submitted_by_person_id, "PENDING_APPROVAL", submission.result_document_version, submission.submitted_at);
    await this.assertHistoricalCommand(client, document.id, "APPROVE", row!.decided_by_person_id, "APPROVED", row!.result_document_version, row!.decided_at);
    const authorization = exactObject(row!.authorization_snapshot);
    if (exactUuid(authorization, "reviewerPersonId") !== row!.decided_by_person_id
      || exactString(authorization, "reviewerSubjectCode") !== "HEADQUARTERS_FINANCE"
      || exactString(authorization, "reviewerScopeType") !== "GLOBAL"
      || exactNullableUuid(authorization, "reviewerContextRegionId") !== null
      || exactNullableUuid(authorization, "reviewerContextCampusId") !== null
      || exactNullableUuid(authorization, "reviewerContextVenueId") !== null
      || exactVersion(authorization, "submissionDocumentVersion") !== versionOf(submission.result_document_version)
      || stableJson(authorization.submissionSnapshot) !== stableJson(submission.applicant_context_snapshot)) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
    return row!;
  }

  private async assertHistoricalCommand(
    client: PostgresClient,
    documentId: string,
    operation: "SUBMIT" | "APPROVE",
    actorId: string,
    status: "PENDING_APPROVAL" | "APPROVED",
    version: string,
    createdAt: string
  ): Promise<void> {
    const rows = (await client.query<HistoricalCommandRow>(
      `SELECT actor_person_id::text AS actor_person_id,result_status,result_document_version::text AS result_document_version,created_at::text AS created_at
         FROM finance_reimbursement_command_idempotency
        WHERE finance_document_id=$1::uuid AND operation=$2 FOR SHARE`, [documentId, operation]
    )).rows;
    if (rows.length !== 1 || rows[0]!.actor_person_id !== actorId || rows[0]!.result_status !== status
      || versionOf(rows[0]!.result_document_version) !== versionOf(version) || asIso(rows[0]!.created_at) !== asIso(createdAt)) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  }

  private assertExecutionTimeline(document: DocumentRow, submission: SubmissionRow, decision: DecisionRow, at: Date): void {
    const documentCreatedAt = asIso(document.created_at);
    const submittedAt = asIso(submission.submitted_at);
    const decidedAt = asIso(decision.decided_at);
    if (new Date(submittedAt).getTime() < new Date(documentCreatedAt).getTime()
      || new Date(decidedAt).getTime() < new Date(submittedAt).getTime()
      || at.getTime() < new Date(decidedAt).getTime()) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  }

  private assertSameFinanceYear(submittedAt: string, at: Date): void {
    const submitted = new Date(submittedAt);
    if (!Number.isFinite(submitted.getTime())) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
    const executionBounds = financeYearBounds(at);
    const submissionBounds = financeYearBounds(submitted);
    if (executionBounds.start !== submissionBounds.start || executionBounds.end !== submissionBounds.end) fail("REIMBURSEMENT_CROSS_FINANCE_YEAR_PENDING");
  }

  private amountOf(value: string): bigint {
    if (!/^[0-9]+$/.test(value) || value.length > 19) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
    const amount = BigInt(value);
    if (amount < 1n || amount > BIGINT_MAX) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
    return amount;
  }

  private async assertSubmissionFacts(client: PostgresClient, document: DocumentRow, submission: SubmissionRow): Promise<void> {
    if (asIso(submission.submitted_at) !== asIso(submission.created_at) || !submission.reason.trim()
      || submission.reason.length > 1_000 || /[\x00-\x1f\x7f]/.test(submission.reason)) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
    this.amountOf(submission.amount_cents);
    const destination = await this.readAccountById(client, submission.destination_account_id);
    const snapshot = exactObject(submission.applicant_context_snapshot);
    const subject = exactString(snapshot, "applicantContextSubject");
    const scope = exactString(snapshot, "applicantContextScope");
    const regionId = exactNullableUuid(snapshot, "applicantContextRegionId");
    const campusId = exactNullableUuid(snapshot, "applicantContextCampusId");
    const venueId = exactNullableUuid(snapshot, "applicantContextVenueId");
    if (destination.owner_type !== "PERSON" || destination.owner_id !== document.applicant_person_id
      || !PERSONAL_SUBJECTS.includes(subject as (typeof PERSONAL_SUBJECTS)[number])
      || !PERSONAL_SCOPES.includes(scope as (typeof PERSONAL_SCOPES)[number])
      || exactUuid(snapshot, "applicantPersonId") !== document.applicant_person_id
      || exactUuid(snapshot, "destinationAccountId") !== submission.destination_account_id) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
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
    if (rows.length < 1 || new Set(rows.map(row => row.attachment_id)).size !== rows.length
      || !rows.some(row => row.purpose === REQUIRED_PURPOSE && ["image/png", "image/jpeg"].includes(row.detected_media_type ?? ""))
      || rows.some(row => row.status !== "READY" || row.document_version !== submission.result_document_version || row.bound_by_person_id !== document.applicant_person_id)) fail("FINANCE_ATTACHMENT_NOT_READY");
    for (const row of rows) {
      const size = row.actual_size_bytes === null ? NaN : Number(row.actual_size_bytes);
      if (row.detected_media_type === null || !Number.isSafeInteger(size) || size < 1 || row.sha256 === null || !SHA256.test(row.sha256)) fail("ATTACHMENT_INTEGRITY_FAILED");
      try { await this.store.readVerified({ versionId: row.id, mediaType: row.detected_media_type as AttachmentMediaType, sizeBytes: size, sha256: row.sha256 as string }); }
      catch { fail("ATTACHMENT_INTEGRITY_FAILED"); }
    }
  }

  private async lockCurrentRoleAssignment(client: PostgresClient, actorId: string, at: Date): Promise<RoleAssignmentRow> {
    const rows = (await client.query<RoleAssignmentRow>(
      `SELECT id::text AS id,valid_from::text AS valid_from,valid_to::text AS valid_to FROM role_assignment
        WHERE person_id=$1::uuid AND subject_code='HEADQUARTERS_FINANCE' AND scope_type='GLOBAL' AND scope_id IS NULL
          AND valid_from<=$2::timestamptz AND (valid_to IS NULL OR valid_to>$2::timestamptz)
        ORDER BY valid_from DESC,id DESC LIMIT 2 FOR SHARE`, [actorId, at.toISOString()]
    )).rows;
    if (rows.length !== 1) fail("HEADQUARTERS_FINANCE_ASSIGNMENT_AMBIGUOUS");
    return rows[0]!;
  }

  private async lockCurrentFundAssignment(client: PostgresClient, at: Date): Promise<FundAssignmentRow> {
    const rows = (await client.query<FundAssignmentRow>(
      `SELECT id::text AS id,fund_id::text AS fund_id,valid_from::text AS valid_from,valid_to::text AS valid_to
         FROM company_finance_fund_assignment
        WHERE duty_subject='HEADQUARTERS_FINANCE' AND scope_type='GLOBAL' AND scope_id IS NULL AND responsibility_code='FINANCE_OPERATING_SOURCE'
          AND valid_from<=$1::timestamptz AND (valid_to IS NULL OR valid_to>$1::timestamptz)
        ORDER BY valid_from DESC,id DESC LIMIT 2 FOR SHARE`, [at.toISOString()]
    )).rows;
    if (rows.length !== 1) fail("COMPANY_FUND_ASSIGNMENT_NOT_FOUND");
    return rows[0]!;
  }

  private async lockActiveFund(client: PostgresClient, id: string): Promise<FundRow> {
    const row = (await client.query<FundRow>("SELECT id::text AS id,fund_code,status FROM company_finance_fund WHERE id=$1::uuid FOR SHARE", [id])).rows[0];
    if (row === undefined || row.status !== "ACTIVE") fail("COMPANY_FUND_ASSIGNMENT_NOT_FOUND");
    return row!;
  }

  private async readAccountCandidate(client: PostgresClient, ownerType: "PERSON" | "COMPANY", ownerId: string): Promise<AccountCandidate> {
    const rows = (await client.query<AccountCandidate>(
      "SELECT id::text AS id,owner_type,owner_id::text AS owner_id,account_code,status FROM settlement_account WHERE owner_type=$1 AND owner_id=$2::uuid", [ownerType, ownerId]
    )).rows;
    if (rows.length !== 1) fail(ownerType === "PERSON" ? "PERSONAL_ACCOUNT_NOT_FOUND" : "COMPANY_FUND_ASSIGNMENT_NOT_FOUND");
    return rows[0]!;
  }

  private async readAccountById(client: PostgresClient, id: string): Promise<AccountCandidate> {
    const row = (await client.query<AccountCandidate>(
      "SELECT id::text AS id,owner_type,owner_id::text AS owner_id,account_code,status FROM settlement_account WHERE id=$1::uuid FOR SHARE", [id]
    )).rows[0];
    if (row === undefined) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
    return row!;
  }

  private revalidatePrepared(prepared: readonly PreparedLedgerAccount[], candidate: AccountCandidate, ownerType: "PERSON" | "COMPANY", ownerId: string): PreparedLedgerAccount {
    const account = prepared.find(item => item.accountCode === candidate.account_code);
    if (account === undefined || account.id !== candidate.id || account.ownerType !== ownerType || account.ownerId !== ownerId) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
    return account!;
  }

  private async postLedger(client: PostgresClient, eventKey: string, sourceCode: string, destinationCode: string, amount: bigint, payload: unknown): Promise<{ eventId: string; status: "POSTED" | "REPLAY"; balances: Readonly<Record<string, bigint>> }> {
    const transaction = createPostgresLedgerTransaction(client);
    const posted = await postLedgerEvent({ transaction: work => work(transaction) }, {
      eventKey,
      eventType: "REIMBURSEMENT_COMPLETED",
      payloadHash: hash(payload),
      deltas: [
        { accountKey: sourceCode, categoryKey: "reimbursementExpense", amountCents: -amount },
        { accountKey: destinationCode, categoryKey: "reimbursementIncome", amountCents: amount }
      ]
    }, randomUUID);
    return { eventId: posted.event.eventId, status: posted.status, balances: posted.balances };
  }

  private async recordCommand(client: PostgresClient, actorId: string, key: string, requestHash: string, documentId: string, version: number, at: Date): Promise<void> {
    await client.query(
      `INSERT INTO finance_reimbursement_command_idempotency(actor_person_id,operation,idempotency_key,request_hash,finance_document_id,result_status,result_document_version,created_at)
       VALUES($1::uuid,'EXECUTE',$2,$3,$4::uuid,'COMPLETED',$5::bigint,$6::timestamptz)`,
      [actorId, key, requestHash, documentId, version, at.toISOString()]
    );
  }
}
