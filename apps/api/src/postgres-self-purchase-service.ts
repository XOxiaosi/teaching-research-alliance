import { createHash, randomUUID } from "node:crypto";
import type { RoleContext } from "@teaching-research-alliance/contracts";
import { postLedgerEvent } from "@teaching-research-alliance/domain";
import { financeYearBounds } from "./finance-year.js";
import { LocalAttachmentStore, type AttachmentMediaType } from "./local-attachment-store.js";
import { createPostgresLedgerTransaction, type PostgresClient, type PostgresPool } from "./postgres-ledger-repository.js";
import { prepareLedgerPosting, type PreparedLedgerAccount } from "./postgres-ledger-locks.js";

export type SelfPurchaseSubmissionDraft = Readonly<{
  expectedVersion: number;
  amountCents: string;
  reason: string;
  attachmentVersionIds: readonly string[];
}>;

export type SelfPurchaseResult = Readonly<{
  id: string;
  status: "COMPLETED";
  version: number;
  replay: boolean;
}>;

type DocumentRow = Readonly<{ id: string; applicant_person_id: string; kind: string; status: string; version: string }>;
type RoleAssignmentRow = Readonly<{ id: string; valid_from: string; valid_to: string | null }>;
type FundAssignmentRow = Readonly<{ id: string; fund_id: string; valid_from: string; valid_to: string | null }>;
type FundRow = Readonly<{ id: string; fund_code: string; status: string }>;
type AccountCandidate = Readonly<{ id: string; owner_type: "PERSON" | "VENUE" | "COMPANY"; owner_id: string; account_code: string; status: "ACTIVE" | "INACTIVE" }>;
type AttachmentRow = Readonly<{ id: string; attachment_id: string; purpose: string; detected_media_type: AttachmentMediaType | null; actual_size_bytes: string | null; sha256: string | null; status: string }>;
type IdempotencyRow = Readonly<{ request_hash: string; finance_document_id: string; result_status: string; result_document_version: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const PERSONAL_SUBJECTS = ["TEACHER", "TEACHING_TEACHER", "ACADEMIC_PLANNER", "PLANNING_MENTOR"] as const;
const KNOWN_PERSONAL_SCOPES = ["SELF", "REGION", "CAMPUS", "ASSOCIATED_TEACHERS", "MENTEES", "VENUE", "GLOBAL"] as const;
const REQUIRED_PURPOSES = ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT"] as const;
const ALLOWED_PURPOSES = ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT", "INVOICE"] as const;

const fail = (code: string): never => { throw new Error(code); };
const scopeOf = (context: RoleContext): string | undefined => (context as RoleContext & { scope?: string }).scope;
const canonicalUuid = (value: string): string => {
  if (!UUID.test(value)) fail("INVALID_INPUT");
  return value.toLowerCase();
};
const validAt = (at: Date): void => { if (!Number.isFinite(at.getTime())) fail("INVALID_INPUT"); };
const validKey = (key: string): void => {
  if (!key.trim() || key.length > 200 || /[\x00-\x1f\x7f]/.test(key)) fail("INVALID_INPUT");
};
const parseVersion = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) fail("INVALID_INPUT");
  return value;
};
const parseAmount = (value: string): bigint => {
  if (!/^[0-9]+$/.test(value) || value.length > 19) fail("INVALID_INPUT");
  const amount = BigInt(value);
  if (amount < 1n || amount > 9_223_372_036_854_775_807n) fail("INVALID_INPUT");
  return amount;
};
const normalizeReason = (value: string): string => {
  const result = value.trim();
  if (!result || result.length > 1_000 || /[\x00-\x1f\x7f]/.test(result)) fail("INVALID_INPUT");
  return result;
};
const attachmentIds = (value: readonly string[]): readonly string[] => {
  if (!Array.isArray(value) || value.length < REQUIRED_PURPOSES.length || value.length > 20) fail("INVALID_INPUT");
  const result = value.map(canonicalUuid).sort();
  if (new Set(result).size !== result.length) fail("INVALID_INPUT");
  return result;
};
const assertApplicantContext = (context: RoleContext): string => {
  if (!PERSONAL_SUBJECTS.includes(context.subject as (typeof PERSONAL_SUBJECTS)[number])
    || !KNOWN_PERSONAL_SCOPES.includes(scopeOf(context) as (typeof KNOWN_PERSONAL_SCOPES)[number])) fail("FORBIDDEN_SCOPE");
  return canonicalUuid(context.personId);
};
const versionOf = (value: string): number => {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1 || version >= Number.MAX_SAFE_INTEGER) fail("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
  return version;
};
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const asIso = (value: string, code: string): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail(code);
  return date.toISOString();
};
const result = (id: string, version: number, replay: boolean): SelfPurchaseResult => ({ id, status: "COMPLETED", version, replay });

/** Atomically records a HQ-finance employee's own procurement transfer. */
export class PostgresSelfPurchaseService {
  public constructor(private readonly pool: PostgresPool, private readonly store: LocalAttachmentStore) {}

  public async submit(
    context: RoleContext,
    documentIdInput: string,
    draft: SelfPurchaseSubmissionDraft,
    idempotencyKey: string,
    at: Date
  ): Promise<SelfPurchaseResult> {
    const actorId = assertApplicantContext(context);
    const documentId = canonicalUuid(documentIdInput);
    const expectedVersion = parseVersion(draft.expectedVersion);
    const amount = parseAmount(draft.amountCents);
    const reason = normalizeReason(draft.reason);
    const selectedAttachmentIds = attachmentIds(draft.attachmentVersionIds);
    validKey(idempotencyKey);
    validAt(at);
    const canonicalRequest = ["self-purchase.submit.v1", actorId, documentId, expectedVersion, amount.toString(), reason, selectedAttachmentIds];
    const requestHash = hash(canonicalRequest);

    return this.inTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`self-purchase:${actorId}:SUBMIT:${idempotencyKey}`]);
      // The immutable command result is intentionally checked before year/state/appointment tests.
      const replay = await this.replay(client, actorId, idempotencyKey, requestHash);
      if (replay !== undefined) return replay;

      const document = await this.lockApplicantDraft(client, documentId, actorId, at);
      if (document.kind !== "SELF_PURCHASE" || document.status !== "DRAFT") fail("SELF_PURCHASE_STATE_CONFLICT");
      if (versionOf(document.version) !== expectedVersion) fail("VERSION_CONFLICT");

      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('company-fund-global-config',0))");
      const role = await this.lockCurrentRoleAssignment(client, actorId, at);
      const fundAssignment = await this.lockCurrentFundAssignment(client, at);
      const fund = await this.lockActiveFund(client, fundAssignment.fund_id);
      const attachments = await this.lockReadyAttachments(client, document.id, selectedAttachmentIds);
      await this.verifyAttachments(attachments);

      const sourceCandidate = await this.readAccountCandidate(client, "COMPANY", fund.id);
      const destinationCandidate = await this.readAccountCandidate(client, "PERSON", actorId);
      const eventKey = `self-purchase:${document.id}`;
      const prepared = await prepareLedgerPosting(client, eventKey, [sourceCandidate.account_code, destinationCandidate.account_code]);
      const source = this.revalidatePrepared(prepared, sourceCandidate, "COMPANY", fund.id);
      const destination = this.revalidatePrepared(prepared, destinationCandidate, "PERSON", actorId);
      if (source.accountCode !== `company:fund:${fund.id}`) fail("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
      if (source.status !== "ACTIVE" || destination.status !== "ACTIVE") fail("SOURCE_ACCOUNT_NOT_ACTIVE");

      const sourceBefore = source.balanceCents;
      const destinationBefore = destination.balanceCents;
      const posted = await this.postLedger(client, eventKey, source.accountCode, destination.accountCode, amount, {
        financeDocumentId: document.id,
        sourceFundId: fund.id,
        sourceAccountId: source.id,
        destinationPersonId: actorId,
        destinationAccountId: destination.id,
        amountCents: amount.toString(),
        processingMode: "SYSTEM_RULE"
      });
      if (posted.status !== "POSTED" || posted.balances[source.accountCode] !== sourceBefore - amount
        || posted.balances[destination.accountCode] !== destinationBefore + amount) fail("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
      const nextVersion = expectedVersion + 1;
      const sourceAfter = sourceBefore - amount;
      const destinationAfter = destinationBefore + amount;
      const authorizationSnapshot = {
        roleAssignmentId: role.id,
        rolePersonId: actorId,
        roleSubjectCode: "HEADQUARTERS_FINANCE",
        roleScopeType: "GLOBAL",
        roleScopeId: null,
        roleValidFrom: asIso(role.valid_from, "FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE"),
        roleValidTo: role.valid_to === null ? null : asIso(role.valid_to, "FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE"),
        companyFundAssignmentId: fundAssignment.id,
        fundAssignmentValidFrom: asIso(fundAssignment.valid_from, "FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE"),
        fundAssignmentValidTo: fundAssignment.valid_to === null ? null : asIso(fundAssignment.valid_to, "FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE"),
        sourceFundId: fund.id,
        sourceFundCode: fund.fund_code,
        sourceAccountId: source.id,
        destinationPersonId: actorId,
        destinationAccountId: destination.id,
        applicantContextSubject: context.subject,
        applicantContextScope: scopeOf(context),
        applicantContextRegionId: context.regionId ?? null,
        applicantContextCampusId: context.campusId ?? null,
        applicantContextVenueId: context.venueId ?? null
      };
      await client.query("UPDATE finance_document SET status='COMPLETED',version=$2::bigint,updated_at=$3::timestamptz WHERE id=$1::uuid", [document.id, nextVersion, at.toISOString()]);
      await client.query(
        `INSERT INTO finance_self_purchase_transfer(
           finance_document_id,role_assignment_id,company_fund_assignment_id,source_fund_id,source_account_id,destination_person_id,destination_account_id,
           amount_cents,reason,authorization_snapshot,ledger_event_id,processing_mode,submitted_by_person_id,submitted_at,completed_at,created_at,
           source_before_cents,source_after_cents,destination_before_cents,destination_after_cents
         ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::bigint,$9,$10::jsonb,$11::uuid,'SYSTEM_RULE',$6::uuid,$12::timestamptz,$12::timestamptz,$12::timestamptz,$13::bigint,$14::bigint,$15::bigint,$16::bigint)`,
        [document.id, role.id, fundAssignment.id, fund.id, source.id, actorId, destination.id, amount.toString(), reason, JSON.stringify(authorizationSnapshot), posted.eventId, at.toISOString(), sourceBefore.toString(), sourceAfter.toString(), destinationBefore.toString(), destinationAfter.toString()]
      );
      for (const attachment of attachments) {
        await client.query(
          `INSERT INTO finance_self_purchase_attachment_binding(finance_document_id,finance_attachment_version_id,purpose,document_version,bound_by_person_id,bound_at,created_at)
           VALUES ($1::uuid,$2::uuid,$3,$4::bigint,$5::uuid,$6::timestamptz,$6::timestamptz)`,
          [document.id, attachment.id, attachment.purpose, nextVersion, actorId, at.toISOString()]
        );
      }
      await client.query(
        `INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,ledger_event_id,details_json,created_at)
         VALUES ($1::uuid,'AUTO_COMPLETED',$2::uuid,$3::bigint,$4::uuid,$5::jsonb,$6::timestamptz)`,
        [document.id, actorId, nextVersion, posted.eventId, JSON.stringify({ processingMode: "SYSTEM_RULE", amountCents: amount.toString(), sourceAccountId: source.id, destinationAccountId: destination.id, applicantContextSubject: context.subject, applicantContextScope: scopeOf(context), applicantContextRegionId: context.regionId ?? null, applicantContextCampusId: context.campusId ?? null, applicantContextVenueId: context.venueId ?? null }), at.toISOString()]
      );
      await client.query(
        `INSERT INTO finance_self_purchase_command_idempotency(actor_person_id,operation,idempotency_key,request_hash,finance_document_id,result_status,result_document_version,created_at)
         VALUES ($1::uuid,'SUBMIT',$2,$3,$4::uuid,'COMPLETED',$5::bigint,$6::timestamptz)`,
        [actorId, idempotencyKey, requestHash, document.id, nextVersion, at.toISOString()]
      );
      return result(document.id, nextVersion, false);
    });
  }

  private async inTransaction<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const value = await work(client);
      await client.query("COMMIT");
      committed = true;
      return value;
    } catch (error) {
      if (!committed) await client.query("ROLLBACK");
      throw error;
    } finally { await client.release(); }
  }

  private async replay(client: PostgresClient, actorId: string, key: string, requestHash: string): Promise<SelfPurchaseResult | undefined> {
    const row = (await client.query<IdempotencyRow>(
      `SELECT request_hash,finance_document_id::text AS finance_document_id,result_status,result_document_version::text AS result_document_version
         FROM finance_self_purchase_command_idempotency
        WHERE actor_person_id=$1::uuid AND operation='SUBMIT' AND idempotency_key=$2 FOR SHARE`,
      [actorId, key]
    )).rows[0];
    if (row === undefined) return undefined;
    if (row.request_hash !== requestHash || row.result_status !== "COMPLETED") fail("IDEMPOTENCY_REPLAY");
    return result(canonicalUuid(row.finance_document_id), versionOf(row.result_document_version), true);
  }

  private async lockApplicantDraft(client: PostgresClient, documentId: string, actorId: string, at: Date): Promise<DocumentRow> {
    const bounds = financeYearBounds(at);
    const rows = (await client.query<DocumentRow>(
      `SELECT id::text AS id,applicant_person_id::text AS applicant_person_id,kind,status,version::text AS version
         FROM finance_document
        WHERE id=$1::uuid AND applicant_person_id=$2::uuid
          AND created_at >= $3::timestamptz AND created_at < $4::timestamptz
        FOR UPDATE`,
      [documentId, actorId, bounds.start, bounds.end]
    )).rows;
    if (rows.length !== 1) fail("FINANCE_DOCUMENT_NOT_FOUND");
    return rows[0]!;
  }

  private async lockCurrentRoleAssignment(client: PostgresClient, actorId: string, at: Date): Promise<RoleAssignmentRow> {
    const rows = (await client.query<RoleAssignmentRow>(
      `SELECT id::text AS id,valid_from::text AS valid_from,valid_to::text AS valid_to
         FROM role_assignment
        WHERE person_id=$1::uuid AND subject_code='HEADQUARTERS_FINANCE' AND scope_type='GLOBAL' AND scope_id IS NULL
          AND valid_from <= $2::timestamptz AND (valid_to IS NULL OR valid_to > $2::timestamptz)
        ORDER BY valid_from DESC,id DESC LIMIT 2 FOR SHARE`,
      [actorId, at.toISOString()]
    )).rows;
    if (rows.length === 0) fail("HEADQUARTERS_FINANCE_ASSIGNMENT_REQUIRED");
    if (rows.length !== 1) fail("HEADQUARTERS_FINANCE_ASSIGNMENT_AMBIGUOUS");
    return rows[0]!;
  }

  private async lockCurrentFundAssignment(client: PostgresClient, at: Date): Promise<FundAssignmentRow> {
    const rows = (await client.query<FundAssignmentRow>(
      `SELECT id::text AS id,fund_id::text AS fund_id,valid_from::text AS valid_from,valid_to::text AS valid_to
         FROM company_finance_fund_assignment
        WHERE duty_subject='HEADQUARTERS_FINANCE' AND scope_type='GLOBAL' AND scope_id IS NULL
          AND responsibility_code='FINANCE_OPERATING_SOURCE'
          AND valid_from <= $1::timestamptz AND (valid_to IS NULL OR valid_to > $1::timestamptz)
        ORDER BY valid_from DESC,id DESC LIMIT 2 FOR SHARE`,
      [at.toISOString()]
    )).rows;
    if (rows.length !== 1) fail("COMPANY_FUND_ASSIGNMENT_NOT_FOUND");
    return rows[0]!;
  }

  private async lockActiveFund(client: PostgresClient, id: string): Promise<FundRow> {
    const row = (await client.query<FundRow>(
      "SELECT id::text AS id,fund_code,status FROM company_finance_fund WHERE id=$1::uuid FOR SHARE", [id]
    )).rows[0];
    if (row === undefined) throw new Error("COMPANY_FUND_ASSIGNMENT_NOT_FOUND");
    if (row.status !== "ACTIVE") fail("COMPANY_FUND_INACTIVE");
    return row!;
  }

  private async lockReadyAttachments(client: PostgresClient, documentId: string, ids: readonly string[]): Promise<readonly AttachmentRow[]> {
    const rows = (await client.query<AttachmentRow>(
      `SELECT version.id::text AS id,attachment.id::text AS attachment_id,attachment.purpose,version.detected_media_type,version.actual_size_bytes::text AS actual_size_bytes,version.sha256,version.status
         FROM finance_attachment_version version JOIN finance_attachment attachment ON attachment.id=version.finance_attachment_id
        WHERE attachment.finance_document_id=$1::uuid AND version.id=ANY($2::uuid[])
        FOR SHARE OF attachment,version`,
      [documentId, ids]
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
      const mediaType = row.detected_media_type;
      const sha256 = row.sha256;
      try { await this.store.readVerified({ versionId: row.id, mediaType: mediaType!, sizeBytes: size, sha256: sha256! }); }
      catch { fail("ATTACHMENT_INTEGRITY_FAILED"); }
    }
  }

  private async readAccountCandidate(client: PostgresClient, ownerType: "COMPANY" | "PERSON", ownerId: string): Promise<AccountCandidate> {
    const rows = (await client.query<AccountCandidate>(
      "SELECT id::text AS id,owner_type,owner_id::text AS owner_id,account_code,status FROM settlement_account WHERE owner_type=$1 AND owner_id=$2::uuid",
      [ownerType, ownerId]
    )).rows;
    if (rows.length !== 1) fail(ownerType === "PERSON" ? "PERSONAL_ACCOUNT_NOT_FOUND" : "COMPANY_FUND_ASSIGNMENT_NOT_FOUND");
    return rows[0]!;
  }

  private revalidatePrepared(prepared: readonly PreparedLedgerAccount[], candidate: AccountCandidate, ownerType: "COMPANY" | "PERSON", ownerId: string): PreparedLedgerAccount {
    const account = prepared.find(item => item.accountCode === candidate.account_code);
    if (account === undefined || account.id !== candidate.id || account.ownerType !== ownerType || account.ownerId !== ownerId) fail("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
    return account!;
  }

  private async postLedger(client: PostgresClient, eventKey: string, sourceCode: string, destinationCode: string, amount: bigint, payload: unknown): Promise<{ eventId: string; status: "POSTED" | "REPLAY"; balances: Readonly<Record<string, bigint>> }> {
    const transaction = createPostgresLedgerTransaction(client);
    const posted = await postLedgerEvent({ transaction: work => work(transaction) }, {
      eventKey,
      eventType: "SELF_PURCHASE_AUTO_COMPLETED",
      payloadHash: hash(payload),
      deltas: [
        { accountKey: sourceCode, categoryKey: "selfPurchaseExpense", amountCents: -amount },
        { accountKey: destinationCode, categoryKey: "selfPurchaseIncome", amountCents: amount }
      ]
    }, randomUUID);
    return { eventId: posted.event.eventId, status: posted.status, balances: posted.balances };
  }
}
