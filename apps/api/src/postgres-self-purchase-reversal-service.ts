import { createHash, randomUUID } from "node:crypto";
import type { RoleContext } from "@teaching-research-alliance/contracts";
import { postLedgerEvent } from "@teaching-research-alliance/domain";
import { createPostgresLedgerTransaction, type PostgresClient, type PostgresPool } from "./postgres-ledger-repository.js";
import { prepareLedgerPosting, type PreparedLedgerAccount } from "./postgres-ledger-locks.js";

export type SelfPurchaseReversalDraft = Readonly<{ expectedVersion: number; reason: string }>;
export type SelfPurchaseReversalResult = Readonly<{ id: string; status: "REVERSED"; version: number; replay: boolean }>;

type DocumentRow = Readonly<{ id: string; applicant_person_id: string; kind: string; status: string; version: string }>;
type TransferRow = Readonly<{
  finance_document_id: string; role_assignment_id: string; company_fund_assignment_id: string; source_fund_id: string; source_account_id: string;
  destination_person_id: string; destination_account_id: string; amount_cents: string; reason: string; authorization_snapshot: unknown;
  ledger_event_id: string; processing_mode: string; submitted_by_person_id: string; submitted_at: string; completed_at: string;
  source_before_cents: string; source_after_cents: string; destination_before_cents: string; destination_after_cents: string;
}>;
type AccountRow = Readonly<{ id: string; owner_type: "PERSON" | "VENUE" | "COMPANY"; owner_id: string; account_code: string; status: "ACTIVE" | "INACTIVE" }>;
type ProjectionRow = Readonly<{ account_id: string }>;
type LedgerRow = Readonly<{ event_id: string; event_key: string; event_type: string; payload_hash: string; account_id: string; account_code: string; category_key: string; amount_cents: string }>;
type IdempotencyRow = Readonly<{ request_hash: string; finance_document_id: string; result_status: string; result_document_version: string }>;
type HistoricalRoleRow = Readonly<{ id: string }>;
type HistoricalFundAssignmentRow = Readonly<{ id: string; fund_id: string; duty_subject: string; scope_type: string; scope_id: string | null; responsibility_code: string; valid_from: string; valid_to: string | null }>;
type HistoricalFundRow = Readonly<{ id: string; fund_code: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GLOBAL_SUBJECTS = ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"] as const;
const PERSONAL_SUBJECTS = ["TEACHING_TEACHER", "ACADEMIC_PLANNER", "PLANNING_MENTOR"] as const;
const PERSONAL_SCOPES = ["SELF", "REGION", "CAMPUS", "ASSOCIATED_TEACHERS", "MENTEES", "VENUE", "GLOBAL"] as const;
const error = (code: string): never => { throw new Error(code); };
const scope = (context: RoleContext): string | undefined => (context as RoleContext & { scope?: string }).scope;
const canonicalUuid = (value: string): string => { if (!UUID.test(value)) error("INVALID_INPUT"); return value.toLowerCase(); };
const nullableUuid = (value: unknown): boolean => value === null || (typeof value === "string" && UUID.test(value));
const validKey = (value: string): void => { if (!value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) error("INVALID_INPUT"); };
const validAt = (value: Date): void => { if (!Number.isFinite(value.getTime())) error("INVALID_INPUT"); };
const parseVersion = (value: number): number => { if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) error("INVALID_INPUT"); return value; };
const normalizeReason = (value: string): string => { const result = value.trim(); if (!result || result.length > 1_000 || /[\x00-\x1f\x7f]/.test(result)) error("INVALID_INPUT"); return result; };
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const versionOf = (value: string): number => { const result = Number(value); if (!Number.isSafeInteger(result) || result < 1 || result >= Number.MAX_SAFE_INTEGER) error("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE"); return result; };
const amountOf = (value: string): bigint => { if (!/^[0-9]+$/.test(value)) error("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE"); const result = BigInt(value); if (result < 1n) error("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE"); return result; };
const exactObject = (value: unknown): Record<string, unknown> => { if (typeof value !== "object" || value === null || Array.isArray(value)) error("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE"); return value as Record<string, unknown>; };
const result = (id: string, version: number, replay: boolean): SelfPurchaseReversalResult => ({ id, status: "REVERSED", version, replay });

const assertGlobalHandler = (context: RoleContext): string => {
  if (!GLOBAL_SUBJECTS.includes(context.subject as (typeof GLOBAL_SUBJECTS)[number]) || scope(context) !== "GLOBAL"
    || context.regionId !== undefined || context.campusId !== undefined || context.venueId !== undefined) error("FORBIDDEN_SCOPE");
  return canonicalUuid(context.personId);
};

/** Reverses exactly one completed self-purchase from its immutable original transfer snapshot. */
export class PostgresSelfPurchaseReversalService {
  public constructor(private readonly pool: PostgresPool) {}

  public async reverse(context: RoleContext, documentIdInput: string, draft: SelfPurchaseReversalDraft, idempotencyKey: string, at: Date): Promise<SelfPurchaseReversalResult> {
    const actorId = assertGlobalHandler(context);
    const documentId = canonicalUuid(documentIdInput);
    const expectedVersion = parseVersion(draft.expectedVersion);
    const reason = normalizeReason(draft.reason);
    validKey(idempotencyKey); validAt(at);
    const requestHash = hash(["self-purchase.reverse.v1", actorId, documentId, expectedVersion, reason]);
    return this.inTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`self-purchase:${actorId}:REVERSE:${idempotencyKey}`]);
      const replay = await this.replay(client, actorId, idempotencyKey, requestHash);
      if (replay !== undefined) return replay;
      const document = await this.lockDocument(client, documentId);
      if (document.kind !== "SELF_PURCHASE" || document.status !== "COMPLETED") error("SELF_PURCHASE_STATE_CONFLICT");
      if (versionOf(document.version) !== expectedVersion) error("VERSION_CONFLICT");
      const transfer = await this.lockTransfer(client, document.id);
      const amount = amountOf(transfer.amount_cents);
      this.assertTransferConsistency(document, transfer, amount);
      if (at.getTime() < new Date(transfer.completed_at).getTime()) error("INVALID_INPUT");
      await this.assertHistoricalAuthorization(client, document, transfer);
      await this.assertOriginalLedger(client, document.id, transfer, amount);
      const sourceCandidate = await this.readAccount(client, transfer.source_account_id);
      const destinationCandidate = await this.readAccount(client, transfer.destination_account_id);
      await this.assertProjectionsExist(client, sourceCandidate.id, destinationCandidate.id);
      const eventKey = `self-purchase-reversal:${document.id}`;
      const prepared = await prepareLedgerPosting(client, eventKey, [sourceCandidate.account_code, destinationCandidate.account_code]);
      const source = this.revalidatePrepared(prepared, sourceCandidate, "COMPANY", transfer.source_fund_id);
      const destination = this.revalidatePrepared(prepared, destinationCandidate, "PERSON", transfer.destination_person_id);
      if (source.accountCode !== `company:fund:${transfer.source_fund_id}`) error("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
      const sourceBefore = source.balanceCents;
      const destinationBefore = destination.balanceCents;
      const posted = await this.postLedger(client, eventKey, source.accountCode, destination.accountCode, amount, {
        financeDocumentId: document.id, originalLedgerEventId: transfer.ledger_event_id, sourceAccountId: source.id,
        destinationAccountId: destination.id, amountCents: amount.toString(), reason, processingMode: "MANUAL",
        actorSubjectCode: context.subject, actorScopeType: "GLOBAL"
      });
      if (posted.status !== "POSTED" || posted.balances[source.accountCode] !== sourceBefore + amount
        || posted.balances[destination.accountCode] !== destinationBefore - amount) error("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
      const nextVersion = expectedVersion + 1;
      const sourceAfter = sourceBefore + amount;
      const destinationAfter = destinationBefore - amount;
      const reversalSnapshot = {
        originalTransferAuthorization: exactObject(transfer.authorization_snapshot), originalLedgerEventId: transfer.ledger_event_id,
        actorPersonId: actorId, actorSubjectCode: context.subject, actorScopeType: "GLOBAL", processingMode: "MANUAL"
      };
      await client.query("UPDATE finance_document SET status='REVERSED',version=$2::bigint,updated_at=$3::timestamptz WHERE id=$1::uuid", [document.id, nextVersion, at.toISOString()]);
      await client.query(
        `INSERT INTO finance_self_purchase_reversal(
           finance_document_id,source_document_version,result_document_version,source_account_id,destination_account_id,amount_cents,reason,reversal_ledger_event_id,
           reversed_by_person_id,actor_subject_code,actor_scope_type,authorization_snapshot,reversed_at,created_at,
           source_before_cents,source_after_cents,destination_before_cents,destination_after_cents
         ) VALUES($1::uuid,$2::bigint,$3::bigint,$4::uuid,$5::uuid,$6::bigint,$7,$8::uuid,$9::uuid,$10,'GLOBAL',$11::jsonb,$12::timestamptz,$12::timestamptz,$13::bigint,$14::bigint,$15::bigint,$16::bigint)`,
        [document.id, expectedVersion, nextVersion, source.id, destination.id, amount.toString(), reason, posted.eventId, actorId, context.subject, JSON.stringify(reversalSnapshot), at.toISOString(), sourceBefore.toString(), sourceAfter.toString(), destinationBefore.toString(), destinationAfter.toString()]
      );
      await client.query(
        `INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,ledger_event_id,details_json,created_at)
         VALUES($1::uuid,'TRANSFER_REVERSED',$2::uuid,$3::bigint,$4::uuid,$5::jsonb,$6::timestamptz)`,
        [document.id, actorId, nextVersion, posted.eventId, JSON.stringify({ processingMode: "MANUAL", reason, originalLedgerEventId: transfer.ledger_event_id, actorSubjectCode: context.subject, actorScopeType: "GLOBAL" }), at.toISOString()]
      );
      await client.query(
        `INSERT INTO finance_self_purchase_command_idempotency(actor_person_id,operation,idempotency_key,request_hash,finance_document_id,result_status,result_document_version,created_at)
         VALUES($1::uuid,'REVERSE',$2,$3,$4::uuid,'REVERSED',$5::bigint,$6::timestamptz)`,
        [actorId, idempotencyKey, requestHash, document.id, nextVersion, at.toISOString()]
      );
      return result(document.id, nextVersion, false);
    });
  }

  private async inTransaction<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect(); let committed = false;
    try { await client.query("BEGIN"); const value = await work(client); await client.query("COMMIT"); committed = true; return value; }
    catch (failure) { if (!committed) await client.query("ROLLBACK"); throw failure; }
    finally { await client.release(); }
  }

  private async replay(client: PostgresClient, actorId: string, key: string, requestHash: string): Promise<SelfPurchaseReversalResult | undefined> {
    const row = (await client.query<IdempotencyRow>(
      `SELECT request_hash,finance_document_id::text AS finance_document_id,result_status,result_document_version::text AS result_document_version
         FROM finance_self_purchase_command_idempotency WHERE actor_person_id=$1::uuid AND operation='REVERSE' AND idempotency_key=$2 FOR SHARE`,
      [actorId, key]
    )).rows[0];
    if (row === undefined) return undefined;
    if (row.request_hash !== requestHash || row.result_status !== "REVERSED") error("IDEMPOTENCY_REPLAY");
    return result(canonicalUuid(row.finance_document_id), versionOf(row.result_document_version), true);
  }

  private async lockDocument(client: PostgresClient, documentId: string): Promise<DocumentRow> {
    const row = (await client.query<DocumentRow>("SELECT id::text AS id,applicant_person_id::text AS applicant_person_id,kind,status,version::text AS version FROM finance_document WHERE id=$1::uuid FOR UPDATE", [documentId])).rows[0];
    if (row === undefined) error("FINANCE_DOCUMENT_NOT_FOUND");
    return row!;
  }

  private async lockTransfer(client: PostgresClient, documentId: string): Promise<TransferRow> {
    const row = (await client.query<TransferRow>(
      `SELECT finance_document_id::text AS finance_document_id,role_assignment_id::text AS role_assignment_id,company_fund_assignment_id::text AS company_fund_assignment_id,
              source_fund_id::text AS source_fund_id,source_account_id::text AS source_account_id,destination_person_id::text AS destination_person_id,destination_account_id::text AS destination_account_id,
              amount_cents::text AS amount_cents,reason,authorization_snapshot,ledger_event_id::text AS ledger_event_id,processing_mode,submitted_by_person_id::text AS submitted_by_person_id,
              submitted_at::text AS submitted_at,completed_at::text AS completed_at,source_before_cents::text AS source_before_cents,source_after_cents::text AS source_after_cents,
              destination_before_cents::text AS destination_before_cents,destination_after_cents::text AS destination_after_cents
         FROM finance_self_purchase_transfer WHERE finance_document_id=$1::uuid FOR SHARE`, [documentId]
    )).rows[0];
    if (row === undefined) error("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
    return row!;
  }

  private assertTransferConsistency(document: DocumentRow, transfer: TransferRow, amount: bigint): void {
    const snapshot = exactObject(transfer.authorization_snapshot);
    const completedAt = new Date(transfer.completed_at).getTime();
    const roleValidFrom = typeof snapshot.roleValidFrom === "string" ? new Date(snapshot.roleValidFrom).getTime() : NaN;
    const roleValidTo = snapshot.roleValidTo === null ? null : typeof snapshot.roleValidTo === "string" ? new Date(snapshot.roleValidTo).getTime() : NaN;
    const fundValidFrom = typeof snapshot.fundAssignmentValidFrom === "string" ? new Date(snapshot.fundAssignmentValidFrom).getTime() : NaN;
    const fundValidTo = snapshot.fundAssignmentValidTo === null ? null : typeof snapshot.fundAssignmentValidTo === "string" ? new Date(snapshot.fundAssignmentValidTo).getTime() : NaN;
    if (transfer.finance_document_id !== document.id || transfer.destination_person_id !== document.applicant_person_id
      || transfer.submitted_by_person_id !== document.applicant_person_id || transfer.processing_mode !== "SYSTEM_RULE"
      || BigInt(transfer.source_after_cents) !== BigInt(transfer.source_before_cents) - amount
      || BigInt(transfer.destination_after_cents) !== BigInt(transfer.destination_before_cents) + amount
      || !Number.isFinite(completedAt) || !Number.isFinite(roleValidFrom) || !Number.isFinite(fundValidFrom)
      || (roleValidTo !== null && (!Number.isFinite(roleValidTo) || roleValidTo <= roleValidFrom))
      || (fundValidTo !== null && (!Number.isFinite(fundValidTo) || fundValidTo <= fundValidFrom))
      || completedAt < roleValidFrom || (roleValidTo !== null && completedAt >= roleValidTo)
      || completedAt < fundValidFrom || (fundValidTo !== null && completedAt >= fundValidTo)
      || snapshot.roleAssignmentId !== transfer.role_assignment_id || snapshot.rolePersonId !== document.applicant_person_id
      || snapshot.roleSubjectCode !== "HEADQUARTERS_FINANCE" || snapshot.roleScopeType !== "GLOBAL" || snapshot.roleScopeId !== null
      || snapshot.companyFundAssignmentId !== transfer.company_fund_assignment_id
      || snapshot.sourceFundId !== transfer.source_fund_id || snapshot.sourceAccountId !== transfer.source_account_id
      || snapshot.destinationPersonId !== transfer.destination_person_id || snapshot.destinationAccountId !== transfer.destination_account_id
      || !nullableUuid(snapshot.applicantContextRegionId) || !nullableUuid(snapshot.applicantContextCampusId) || !nullableUuid(snapshot.applicantContextVenueId)) {
      error("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
    }
    if (!PERSONAL_SUBJECTS.includes(snapshot.applicantContextSubject as (typeof PERSONAL_SUBJECTS)[number])
      || !PERSONAL_SCOPES.includes(snapshot.applicantContextScope as (typeof PERSONAL_SCOPES)[number])) error("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
  }

  /** Historical FKs must still identify the authorization captured at completion; later role closure cannot revoke an immutable completed transfer. */
  private async assertHistoricalAuthorization(client: PostgresClient, document: DocumentRow, transfer: TransferRow): Promise<void> {
    const snapshot = exactObject(transfer.authorization_snapshot);
    // Keep this explicit role -> assignment -> fund locking order compatible with company-fund configuration writers.
    // The role row is an existence FK only: its mutable validity is deliberately not allowed to rewrite a completed authorization fact.
    const role = await client.query<HistoricalRoleRow>("SELECT id::text AS id FROM role_assignment WHERE id=$1::uuid FOR SHARE", [transfer.role_assignment_id]);
    const assignment = await client.query<HistoricalFundAssignmentRow>("SELECT id::text AS id,fund_id::text AS fund_id,duty_subject,scope_type,scope_id::text AS scope_id,responsibility_code,valid_from::text AS valid_from,valid_to::text AS valid_to FROM company_finance_fund_assignment WHERE id=$1::uuid FOR SHARE", [transfer.company_fund_assignment_id]);
    const fund = await client.query<HistoricalFundRow>("SELECT id::text AS id,fund_code FROM company_finance_fund WHERE id=$1::uuid FOR SHARE", [transfer.source_fund_id]);
    const roleRow = role.rows[0]; const assignmentRow = assignment.rows[0]; const fundRow = fund.rows[0];
    if (role.rows.length !== 1 || assignment.rows.length !== 1 || fund.rows.length !== 1) error("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
    if (roleRow === undefined || assignmentRow === undefined || fundRow === undefined
      || assignmentRow.fund_id !== transfer.source_fund_id || assignmentRow.duty_subject !== "HEADQUARTERS_FINANCE" || assignmentRow.scope_type !== "GLOBAL" || assignmentRow.scope_id !== null || assignmentRow.responsibility_code !== "FINANCE_OPERATING_SOURCE"
      || fundRow.fund_code !== snapshot.sourceFundCode) {
      error("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
    }
  }

  private async assertOriginalLedger(client: PostgresClient, documentId: string, transfer: TransferRow, amount: bigint): Promise<void> {
    const rows = (await client.query<LedgerRow>(
      `SELECT event.id::text AS event_id,event.event_key,event.event_type,event.payload_hash,entry.account_id::text AS account_id,account.account_code,entry.category_key,entry.amount_cents::text AS amount_cents
         FROM ledger_event event JOIN ledger_entry entry ON entry.event_id=event.id JOIN settlement_account account ON account.id=entry.account_id
        WHERE event.id=$1::uuid ORDER BY entry.id`, [transfer.ledger_event_id]
    )).rows;
    const expectedPayload = { financeDocumentId: documentId, sourceFundId: transfer.source_fund_id, sourceAccountId: transfer.source_account_id,
      destinationPersonId: transfer.destination_person_id, destinationAccountId: transfer.destination_account_id, amountCents: amount.toString(), processingMode: "SYSTEM_RULE" };
    if (rows.length !== 2 || rows.some(row => row.event_id !== transfer.ledger_event_id || row.event_key !== `self-purchase:${documentId}`
      || row.event_type !== "SELF_PURCHASE_AUTO_COMPLETED" || row.payload_hash !== hash(expectedPayload))
      || !rows.some(row => row.account_id === transfer.source_account_id && row.category_key === "selfPurchaseExpense" && row.amount_cents === (-amount).toString())
      || !rows.some(row => row.account_id === transfer.destination_account_id && row.category_key === "selfPurchaseIncome" && row.amount_cents === amount.toString())) {
      error("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
    }
  }

  private async readAccount(client: PostgresClient, id: string): Promise<AccountRow> {
    const row = (await client.query<AccountRow>("SELECT id::text AS id,owner_type,owner_id::text AS owner_id,account_code,status FROM settlement_account WHERE id=$1::uuid", [id])).rows[0];
    if (row === undefined) error("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
    return row!;
  }

  private async assertProjectionsExist(client: PostgresClient, sourceId: string, destinationId: string): Promise<void> {
    // Balance projections are ledger-owned immutable account state: their absence is corrupt data, not a request to initialize a new balance here.
    const rows = (await client.query<ProjectionRow>("SELECT account_id::text AS account_id FROM account_balance_projection WHERE account_id=ANY($1::uuid[])", [[sourceId, destinationId]])).rows;
    if (sourceId === destinationId || rows.length !== 2 || new Set(rows.map(row => row.account_id)).size !== 2) error("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
  }

  private revalidatePrepared(prepared: readonly PreparedLedgerAccount[], candidate: AccountRow, ownerType: "COMPANY" | "PERSON", ownerId: string): PreparedLedgerAccount {
    const account = prepared.find(item => item.accountCode === candidate.account_code);
    if (account === undefined || account.id !== candidate.id || account.ownerType !== ownerType || account.ownerId !== ownerId) error("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
    return account!;
  }

  private async postLedger(client: PostgresClient, eventKey: string, sourceCode: string, destinationCode: string, amount: bigint, payload: unknown): Promise<{eventId:string;status:"POSTED"|"REPLAY";balances:Readonly<Record<string,bigint>>}> {
    const transaction = createPostgresLedgerTransaction(client);
    const posted = await postLedgerEvent({ transaction: work => work(transaction) }, {
      eventKey, eventType: "SELF_PURCHASE_TRANSFER_REVERSED", payloadHash: hash(payload),
      deltas: [
        { accountKey: sourceCode, categoryKey: "selfPurchaseExpenseReversal", amountCents: amount },
        { accountKey: destinationCode, categoryKey: "selfPurchaseIncomeReversal", amountCents: -amount }
      ]
    }, randomUUID);
    return { eventId: posted.event.eventId, status: posted.status, balances: posted.balances };
  }
}
