import { createHash, randomUUID } from "node:crypto";
import type { RoleContext } from "@teaching-research-alliance/contracts";
import { postLedgerEvent } from "@teaching-research-alliance/domain";
import { createPostgresLedgerTransaction, type PostgresClient, type PostgresPool } from "./postgres-ledger-repository.js";
import { prepareLedgerPosting, type PreparedLedgerAccount } from "./postgres-ledger-locks.js";
import { readValidatedCompletedReimbursement } from "./postgres-reimbursement-read-service.js";

export type ReimbursementReversalDraft = Readonly<{ expectedVersion: number; reason: string }>;
export type ReimbursementReversalResult = Readonly<{ id: string; status: "REVERSED"; version: number; replay: boolean }>;

type DocumentRow = Readonly<{
  id: string;
  applicant_person_id: string;
  kind: string;
  status: string;
  version: string;
}>;

type AccountRow = Readonly<{
  id: string;
  owner_type: "PERSON" | "VENUE" | "COMPANY";
  owner_id: string;
  account_code: string;
  status: "ACTIVE" | "INACTIVE";
}>;

type ProjectionRow = Readonly<{ account_id: string }>;
type IdempotencyRow = Readonly<{
  request_hash: string;
  finance_document_id: string;
  result_status: string;
  result_document_version: string;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GLOBAL_REVERSERS = ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"] as const;

const fail = (code: string): never => { throw new Error(code); };
const scopeOf = (context: RoleContext): string | undefined => (context as RoleContext & { scope?: string }).scope;
const canonicalUuid = (value: string): string => { if (!UUID.test(value)) fail("INVALID_INPUT"); return value.toLowerCase(); };
const validAt = (value: Date): void => { if (!Number.isFinite(value.getTime())) fail("INVALID_INPUT"); };
const validKey = (value: string): void => { if (!value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) fail("INVALID_INPUT"); };
const expectedVersion = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) fail("INVALID_INPUT");
  return value;
};
const versionOf = (value: string): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result >= Number.MAX_SAFE_INTEGER) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  return result;
};
const normalizeReason = (value: string): string => {
  const result = value.trim();
  if (!result || result.length > 1_000 || /[\x00-\x1f\x7f]/.test(result)) fail("INVALID_INPUT");
  return result;
};
const exactObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  return value as Record<string, unknown>;
};
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const result = (id: string, version: number, replay: boolean): ReimbursementReversalResult => ({ id, status: "REVERSED", version, replay });

const assertReverser = (context: RoleContext): { actorId: string; actorSubject: (typeof GLOBAL_REVERSERS)[number] } => {
  if (!GLOBAL_REVERSERS.includes(context.subject as (typeof GLOBAL_REVERSERS)[number]) || scopeOf(context) !== "GLOBAL"
    || context.regionId !== undefined || context.campusId !== undefined || context.venueId !== undefined) fail("FORBIDDEN_SCOPE");
  return { actorId: canonicalUuid(context.personId), actorSubject: context.subject as (typeof GLOBAL_REVERSERS)[number] };
};

/** Reverses one completed ordinary reimbursement from its immutable original transfer chain. */
export class PostgresReimbursementReversalService {
  public constructor(private readonly pool: PostgresPool) {}

  public async reverse(
    context: RoleContext,
    documentIdInput: string,
    draft: ReimbursementReversalDraft,
    idempotencyKey: string,
    at: Date
  ): Promise<ReimbursementReversalResult> {
    const { actorId, actorSubject } = assertReverser(context);
    const documentId = canonicalUuid(documentIdInput);
    const version = expectedVersion(draft.expectedVersion);
    const reason = normalizeReason(draft.reason);
    validKey(idempotencyKey);
    validAt(at);
    const requestHash = hash(["reimbursement.reverse.v1", actorId, actorSubject, documentId, version, reason]);

    return this.inTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`reimbursement:${actorId}:REVERSE:${idempotencyKey}`]);
      const replay = await this.replay(client, actorId, idempotencyKey, requestHash);
      if (replay !== undefined) return replay;

      const document = await this.lockDocument(client, documentId);
      if (document.kind !== "REIMBURSEMENT" || document.status !== "COMPLETED") fail("REIMBURSEMENT_STATE_CONFLICT");
      if (versionOf(document.version) !== version) fail("VERSION_CONFLICT");

      const original = await readValidatedCompletedReimbursement(client, document.id);
      if (original.id !== document.id || original.version !== version || original.applicantPersonId !== document.applicant_person_id
        || original.amountCents < 1n || !UUID.test(original.sourceFundId) || !UUID.test(original.roleAssignmentId)
        || !UUID.test(original.companyFundAssignmentId) || !UUID.test(original.ledgerEventId)
        || !UUID.test(original.executedByPersonId)) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
      const completedAt = new Date(original.completedAt);
      if (!Number.isFinite(completedAt.getTime()) || at.getTime() < completedAt.getTime()) fail("INVALID_INPUT");

      const sourceCandidate = await this.readAccount(client, original.sourceAccountId);
      const destinationCandidate = await this.readAccount(client, original.destinationAccountId);
      await this.assertProjectionsExist(client, sourceCandidate.id, destinationCandidate.id);

      const eventKey = `reimbursement-reversal:${document.id}`;
      const prepared = await prepareLedgerPosting(client, eventKey, [sourceCandidate.account_code, destinationCandidate.account_code]);
      const source = this.revalidatePrepared(prepared, sourceCandidate, "COMPANY", original.sourceFundId);
      const destination = this.revalidatePrepared(prepared, destinationCandidate, "PERSON", original.applicantPersonId);
      if (source.accountCode !== `company:fund:${original.sourceFundId}`) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");

      const sourceBefore = source.balanceCents;
      const destinationBefore = destination.balanceCents;
      const ledgerPayload = {
        financeDocumentId: document.id,
        originalLedgerEventId: original.ledgerEventId,
        sourceFundId: original.sourceFundId,
        sourceAccountId: source.id,
        destinationAccountId: destination.id,
        applicantPersonId: original.applicantPersonId,
        amountCents: original.amountCents.toString(),
        reason,
        processingMode: "MANUAL",
        actorPersonId: actorId,
        actorSubjectCode: actorSubject,
        actorScopeType: "GLOBAL"
      };
      const posted = await this.postLedger(client, eventKey, source.accountCode, destination.accountCode, original.amountCents, ledgerPayload);
      if (posted.status !== "POSTED" || posted.balances[source.accountCode] !== sourceBefore + original.amountCents
        || posted.balances[destination.accountCode] !== destinationBefore - original.amountCents) {
        fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
      }

      const nextVersion = version + 1;
      const sourceAfter = sourceBefore + original.amountCents;
      const destinationAfter = destinationBefore - original.amountCents;
      const authorizationSnapshot = {
        originalTransferAuthorization: exactObject(original.authorizationSnapshot),
        originalLedgerEventId: original.ledgerEventId,
        originalExecutedByPersonId: original.executedByPersonId,
        actorPersonId: actorId,
        actorSubjectCode: actorSubject,
        actorScopeType: "GLOBAL",
        processingMode: "MANUAL"
      };

      await client.query(
        "UPDATE finance_document SET status='REVERSED',version=$2::bigint,updated_at=$3::timestamptz WHERE id=$1::uuid",
        [document.id, nextVersion, at.toISOString()]
      );
      await this.recordCommand(client, actorId, idempotencyKey, requestHash, document.id, nextVersion, at);
      await client.query(
        `INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,ledger_event_id,details_json,created_at)
         VALUES($1::uuid,'REIMBURSEMENT_REVERSED',$2::uuid,$3::bigint,$4::uuid,$5::jsonb,$6::timestamptz)`,
        [document.id, actorId, nextVersion, posted.eventId, JSON.stringify({
          processingMode: "MANUAL", reason, originalLedgerEventId: original.ledgerEventId,
          actorSubjectCode: actorSubject, actorScopeType: "GLOBAL"
        }), at.toISOString()]
      );
      await client.query(
        `INSERT INTO finance_reimbursement_reversal(
           finance_document_id,source_document_version,result_document_version,source_account_id,destination_account_id,amount_cents,
           original_ledger_event_id,reversal_ledger_event_id,reason,reversed_by_person_id,actor_subject_code,actor_scope_type,
           authorization_snapshot,reversed_at,created_at,source_before_cents,source_after_cents,destination_before_cents,destination_after_cents
         ) VALUES($1::uuid,$2::bigint,$3::bigint,$4::uuid,$5::uuid,$6::bigint,$7::uuid,$8::uuid,$9,$10::uuid,$11,'GLOBAL',
                  $12::jsonb,$13::timestamptz,$13::timestamptz,$14::bigint,$15::bigint,$16::bigint,$17::bigint)`,
        [document.id, version, nextVersion, source.id, destination.id, original.amountCents.toString(), original.ledgerEventId,
          posted.eventId, reason, actorId, actorSubject, JSON.stringify(authorizationSnapshot), at.toISOString(),
          sourceBefore.toString(), sourceAfter.toString(), destinationBefore.toString(), destinationAfter.toString()]
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
    } finally {
      await client.release();
    }
  }

  private async replay(client: PostgresClient, actorId: string, key: string, requestHash: string): Promise<ReimbursementReversalResult | undefined> {
    const row = (await client.query<IdempotencyRow>(
      `SELECT request_hash,finance_document_id::text AS finance_document_id,result_status,result_document_version::text AS result_document_version
         FROM finance_reimbursement_command_idempotency
        WHERE actor_person_id=$1::uuid AND operation='REVERSE' AND idempotency_key=$2 FOR SHARE`, [actorId, key]
    )).rows[0];
    if (row === undefined) return undefined;
    if (row.request_hash !== requestHash || row.result_status !== "REVERSED") fail("IDEMPOTENCY_REPLAY");
    return result(canonicalUuid(row.finance_document_id), versionOf(row.result_document_version), true);
  }

  private async lockDocument(client: PostgresClient, documentId: string): Promise<DocumentRow> {
    const row = (await client.query<DocumentRow>(
      "SELECT id::text AS id,applicant_person_id::text AS applicant_person_id,kind,status,version::text AS version FROM finance_document WHERE id=$1::uuid FOR UPDATE",
      [documentId]
    )).rows[0];
    if (row === undefined) fail("FINANCE_DOCUMENT_NOT_FOUND");
    return row!;
  }

  private async readAccount(client: PostgresClient, accountId: string): Promise<AccountRow> {
    const row = (await client.query<AccountRow>(
      "SELECT id::text AS id,owner_type,owner_id::text AS owner_id,account_code,status FROM settlement_account WHERE id=$1::uuid",
      [accountId]
    )).rows[0];
    if (row === undefined) fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
    return row!;
  }

  private async assertProjectionsExist(client: PostgresClient, sourceId: string, destinationId: string): Promise<void> {
    const rows = (await client.query<ProjectionRow>(
      "SELECT account_id::text AS account_id FROM account_balance_projection WHERE account_id=ANY($1::uuid[])",
      [[sourceId, destinationId]]
    )).rows;
    if (sourceId === destinationId || rows.length !== 2 || new Set(rows.map(row => row.account_id)).size !== 2) {
      fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
    }
  }

  private revalidatePrepared(
    prepared: readonly PreparedLedgerAccount[],
    candidate: AccountRow,
    ownerType: "COMPANY" | "PERSON",
    ownerId: string
  ): PreparedLedgerAccount {
    const account = prepared.find(item => item.accountCode === candidate.account_code);
    if (account === undefined || account.id !== candidate.id || account.ownerType !== ownerType || account.ownerId !== ownerId) {
      fail("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
    }
    return account!;
  }

  private async postLedger(
    client: PostgresClient,
    eventKey: string,
    sourceCode: string,
    destinationCode: string,
    amount: bigint,
    payload: unknown
  ): Promise<{ eventId: string; status: "POSTED" | "REPLAY"; balances: Readonly<Record<string, bigint>> }> {
    const transaction = createPostgresLedgerTransaction(client);
    const posted = await postLedgerEvent({ transaction: work => work(transaction) }, {
      eventKey,
      eventType: "REIMBURSEMENT_REVERSED",
      payloadHash: hash(payload),
      deltas: [
        { accountKey: sourceCode, categoryKey: "reimbursementExpenseReversal", amountCents: amount },
        { accountKey: destinationCode, categoryKey: "reimbursementIncomeReversal", amountCents: -amount }
      ]
    }, randomUUID);
    return { eventId: posted.event.eventId, status: posted.status, balances: posted.balances };
  }

  private async recordCommand(
    client: PostgresClient,
    actorId: string,
    key: string,
    requestHash: string,
    documentId: string,
    version: number,
    at: Date
  ): Promise<void> {
    await client.query(
      `INSERT INTO finance_reimbursement_command_idempotency(
         actor_person_id,operation,idempotency_key,request_hash,finance_document_id,result_status,result_document_version,created_at
       ) VALUES($1::uuid,'REVERSE',$2,$3,$4::uuid,'REVERSED',$5::bigint,$6::timestamptz)`,
      [actorId, key, requestHash, documentId, version, at.toISOString()]
    );
  }
}
