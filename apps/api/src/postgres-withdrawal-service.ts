import { createHash, randomUUID } from "node:crypto";
import type { RoleContext } from "@teaching-research-alliance/contracts";
import { postLedgerEvent } from "@teaching-research-alliance/domain";
import { FinanceSensitiveFieldCrypto, validateFinancialRecipient } from "./finance-sensitive-field-crypto.js";
import { financeYearBounds } from "./finance-year.js";
import { LocalAttachmentStore, type AttachmentMediaType } from "./local-attachment-store.js";
import { createPostgresLedgerTransaction, type PostgresClient, type PostgresPool } from "./postgres-ledger-repository.js";

export type WithdrawalResult = Readonly<{ id: string; status: "PENDING_TRANSFER" | "TRANSFERRED" | "FINANCE_REVOKED"; version: number; replay: boolean }>;
export type WithdrawalSubmissionDraft = Readonly<{
  expectedVersion: number;
  sourceAccountId: string;
  amountCents: string;
  recipientName: string;
  bankAccount: string;
  bankName?: string;
  attachmentVersionIds: readonly string[];
}>;
export type WithdrawalRevokeDraft = Readonly<{ expectedVersion: number; reason: string }>;
export type WithdrawalTransferDraft = Readonly<{ expectedVersion: number; attachmentVersionIds: readonly string[] }>;

type DocumentRow = Readonly<{ id: string; applicant_person_id: string; kind: string; status: string; version: string }>;
type AccountRow = Readonly<{ id: string; owner_type: "PERSON" | "VENUE" | "COMPANY"; owner_id: string; account_code: string; status: "ACTIVE" | "INACTIVE" }>;
type AttachmentRow = Readonly<{ id: string; purpose: string; status: string; detected_media_type: AttachmentMediaType | null; actual_size_bytes: string | null; sha256: string | null }>;
type IdempotencyRow = Readonly<{ request_hmac: string; hmac_key_id: string; finance_document_id: string; result_status: WithdrawalResult["status"]; result_document_version: string }>;
type SubmissionRow = Readonly<{ source_account_id: string; amount_cents: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const personalSubjects = ["TEACHING_TEACHER", "ACADEMIC_PLANNER", "PLANNING_MENTOR"] as const;
const SUBMISSION_PURPOSES = ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT"] as const;
const SUBMISSION_ALLOWED_PURPOSES = ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT", "INVOICE"] as const;
const COMPLETION_PURPOSES = ["PAYMENT_RECEIPT"] as const;

const error = (code: string): never => { throw new Error(code); };
const canonicalUuid = (value: string): string => {
  if (!UUID.test(value)) error("INVALID_INPUT");
  return value.toLowerCase();
};
const parseVersion = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) error("INVALID_INPUT");
  return value;
};
const parseAmount = (value: string): bigint => {
  if (!/^[0-9]+$/.test(value) || value.length > 19) error("INVALID_INPUT");
  const amount = BigInt(value);
  if (amount < 1n || amount > 9_223_372_036_854_775_807n) error("INVALID_INPUT");
  return amount;
};
const attachmentIds = (ids: readonly string[], minimumCount: number): readonly string[] => {
  if (!Array.isArray(ids) || ids.length < minimumCount || ids.length > 20) error("INVALID_INPUT");
  const result = ids.map(canonicalUuid).sort();
  if (new Set(result).size !== result.length) error("INVALID_INPUT");
  return result;
};
const validKey = (key: string): void => {
  if (!key.trim() || key.length > 200) error("INVALID_INPUT");
};
const validReason = (reason: string): void => {
  if (!reason.trim() || reason.length > 1_000 || /[\x00-\x1f\x7f]/.test(reason)) error("INVALID_INPUT");
};
const validAt = (at: Date): void => { if (!Number.isFinite(at.getTime())) error("INVALID_INPUT"); };
const versionOf = (row: { version: string }): number => {
  const value = Number(row.version);
  if (!Number.isSafeInteger(value) || value < 1) error("FINANCE_WITHDRAWAL_PERSISTENCE_INVALID");
  return value;
};
const safeStringify = (value: unknown): string => JSON.stringify(value);
const eventPayloadHash = (value: unknown): string => createHash("sha256").update(safeStringify(value)).digest("hex");
const scope = (context: RoleContext): string | undefined => (context as RoleContext & { scope?: string }).scope;
const assertApplicant = (context: RoleContext): void => {
  // Assignment scope does not widen personal funds: document ownership and source grants are checked below.
  if (!personalSubjects.includes(context.subject as (typeof personalSubjects)[number])
    || !["SELF", "REGION", "CAMPUS", "ASSOCIATED_TEACHERS", "MENTEES", "VENUE", "GLOBAL"].includes(scope(context) ?? "")) error("FORBIDDEN_SCOPE");
};
const assertHeadquartersFinance = (context: RoleContext): void => {
  if (context.subject !== "HEADQUARTERS_FINANCE" || scope(context) !== "GLOBAL"
    || context.regionId !== undefined || context.campusId !== undefined || context.venueId !== undefined) error("FORBIDDEN_SCOPE");
};

const result = (id: string, status: WithdrawalResult["status"], version: number, replay: boolean): WithdrawalResult => ({ id, status, version, replay });

/** Withdrawal state changes and their ledger events are written in one PostgreSQL transaction. */
export class PostgresWithdrawalService {
  public constructor(private readonly pool: PostgresPool, private readonly store: LocalAttachmentStore, private readonly crypto: FinanceSensitiveFieldCrypto) {}

  public async submit(context: RoleContext, documentId: string, draft: WithdrawalSubmissionDraft, idempotencyKey: string, at: Date): Promise<WithdrawalResult> {
    assertApplicant(context);
    const normalizedDocumentId = canonicalUuid(documentId);
    const expectedVersion = parseVersion(draft.expectedVersion);
    const normalizedSourceAccountId = canonicalUuid(draft.sourceAccountId);
    const amount = parseAmount(draft.amountCents);
    const selectedAttachments = attachmentIds(draft.attachmentVersionIds, SUBMISSION_PURPOSES.length);
    validKey(idempotencyKey); validAt(at);
    validateFinancialRecipient({ recipientName: draft.recipientName, bankAccount: draft.bankAccount, ...(draft.bankName === undefined ? {} : { bankName: draft.bankName }) });
    const canonicalRequest = safeStringify(["withdrawal.submit.v1", normalizedDocumentId, expectedVersion, normalizedSourceAccountId, amount.toString(), draft.recipientName, draft.bankAccount, draft.bankName ?? null, selectedAttachments]);
    return this.inTransaction(async (client) => {
      await this.lockCommand(client, context, "SUBMIT", idempotencyKey);
      // An exact retry confirms an already committed personal command, including across the fiscal boundary.
      const replay = await this.replay(client, context, "SUBMIT", idempotencyKey, canonicalRequest);
      if (replay) return replay;
      const document = await this.lockDocument(client, normalizedDocumentId, context.personId, at);
      if (document.kind !== "WITHDRAWAL" || document.status !== "DRAFT") error("FINANCE_WITHDRAWAL_STATE_CONFLICT");
      if (versionOf(document) !== expectedVersion) error("VERSION_CONFLICT");

      const account = await this.lockActiveSourceAccount(client, normalizedSourceAccountId);
      const authorization = await this.assertSourceAuthorization(client, context, account, at);
      const balance = await this.lockBalance(client, account.id);
      if (balance < amount) error("INSUFFICIENT_BALANCE");
      const attachments = await this.lockReadyAttachments(client, document.id, selectedAttachments, SUBMISSION_ALLOWED_PURPOSES, SUBMISSION_PURPOSES);
      await this.verifyAttachments(attachments);
      const encrypted = this.crypto.encrypt({ recipientName: draft.recipientName, bankAccount: draft.bankAccount, ...(draft.bankName === undefined ? {} : { bankName: draft.bankName }) }, {
        documentId: document.id, applicantPersonId: document.applicant_person_id, sourceAccountId: account.id, amountCents: amount.toString()
      });
      const debit = await this.postLedger(client, `withdrawal-debit:${document.id}`, "WITHDRAWAL_DEBIT", account, -amount, {
        documentId: document.id, sourceAccountId: account.id, amountCents: amount.toString()
      });
      const nextVersion = expectedVersion + 1;
      await client.query("UPDATE finance_document SET status='PENDING_TRANSFER',version=$2::bigint,updated_at=$3::timestamptz WHERE id=$1::uuid", [document.id, nextVersion, at.toISOString()]);
      await client.query(
        `INSERT INTO finance_withdrawal_submission(finance_document_id,source_account_id,source_owner_type,source_owner_id,authorization_kind,authorization_grant_id,authorization_snapshot,amount_cents,recipient_key_id,recipient_nonce,recipient_ciphertext,recipient_auth_tag,bank_account_last4,debit_ledger_event_id,submitted_by_person_id,submitted_at,created_at)
         VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5,$6::uuid,$7::jsonb,$8::bigint,$9,$10,$11,$12,$13,$14::uuid,$15::uuid,$16::timestamptz,$16::timestamptz)`,
        [document.id, account.id, account.owner_type, account.owner_id, authorization.kind, authorization.grantId ?? null, safeStringify(authorization.snapshot), amount.toString(), encrypted.keyId, encrypted.nonce, encrypted.ciphertext, encrypted.authTag, encrypted.bankAccountLast4, debit.eventId, context.personId, at.toISOString()]
      );
      await this.bindAttachments(client, document.id, "SUBMISSION", attachments, nextVersion, context.personId, at);
      await this.insertDocumentEvent(client, document.id, "SUBMITTED", context.personId, nextVersion, debit.eventId, {
        approvalMode: "SYSTEM_RULE", sourceAccountId: account.id, sourceOwnerType: account.owner_type, amountCents: amount.toString(), authorizationKind: authorization.kind
      }, at);
      await this.recordCommand(client, context, "SUBMIT", idempotencyKey, canonicalRequest, document.id, "PENDING_TRANSFER", nextVersion, at);
      return result(document.id, "PENDING_TRANSFER", nextVersion, false);
    });
  }

  public async revoke(context: RoleContext, documentId: string, draft: WithdrawalRevokeDraft, idempotencyKey: string, at: Date): Promise<WithdrawalResult> {
    assertHeadquartersFinance(context);
    const normalizedDocumentId = canonicalUuid(documentId);
    const expectedVersion = parseVersion(draft.expectedVersion);
    validReason(draft.reason); validKey(idempotencyKey); validAt(at);
    const canonicalRequest = safeStringify(["withdrawal.revoke.v1", normalizedDocumentId, expectedVersion, draft.reason]);
    return this.inTransaction(async (client) => {
      await this.lockCommand(client, context, "REVOKE", idempotencyKey);
      const document = await this.lockDocument(client, normalizedDocumentId);
      const replay = await this.replay(client, context, "REVOKE", idempotencyKey, canonicalRequest);
      if (replay) return replay;
      if (document.kind !== "WITHDRAWAL" || document.status !== "PENDING_TRANSFER") error("FINANCE_WITHDRAWAL_STATE_CONFLICT");
      if (versionOf(document) !== expectedVersion) error("VERSION_CONFLICT");
      const submission = this.one((await client.query<SubmissionRow>(
        "SELECT source_account_id::text AS source_account_id,amount_cents::text AS amount_cents FROM finance_withdrawal_submission WHERE finance_document_id=$1::uuid FOR SHARE", [document.id]
      )).rows, "FINANCE_WITHDRAWAL_PERSISTENCE_INVALID");
      const account = this.one((await client.query<AccountRow>(
        "SELECT id::text AS id,owner_type,owner_id::text AS owner_id,account_code,status FROM settlement_account WHERE id=$1::uuid FOR UPDATE", [submission.source_account_id]
      )).rows, "SOURCE_ACCOUNT_NOT_FOUND");
      await this.lockBalance(client, account.id);
      const amount = BigInt(submission.amount_cents);
      const reversal = await this.postLedger(client, `withdrawal-reversal:${document.id}`, "WITHDRAWAL_REVERSAL", account, amount, {
        documentId: document.id, sourceAccountId: account.id, amountCents: amount.toString()
      });
      const nextVersion = expectedVersion + 1;
      await client.query("UPDATE finance_document SET status='FINANCE_REVOKED',version=$2::bigint,updated_at=$3::timestamptz WHERE id=$1::uuid", [document.id, nextVersion, at.toISOString()]);
      await client.query(
        "INSERT INTO finance_withdrawal_reversal(finance_document_id,reversal_ledger_event_id,reason,revoked_by_person_id,revoked_at,created_at) VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5::timestamptz,$5::timestamptz)",
        [document.id, reversal.eventId, draft.reason, context.personId, at.toISOString()]
      );
      await this.insertDocumentEvent(client, document.id, "REVOKED", context.personId, nextVersion, reversal.eventId, { reason: draft.reason, amountCents: amount.toString() }, at);
      await this.recordCommand(client, context, "REVOKE", idempotencyKey, canonicalRequest, document.id, "FINANCE_REVOKED", nextVersion, at);
      return result(document.id, "FINANCE_REVOKED", nextVersion, false);
    });
  }

  public async markTransferred(context: RoleContext, documentId: string, draft: WithdrawalTransferDraft, idempotencyKey: string, at: Date): Promise<WithdrawalResult> {
    assertHeadquartersFinance(context);
    const normalizedDocumentId = canonicalUuid(documentId);
    const expectedVersion = parseVersion(draft.expectedVersion);
    const selectedAttachments = attachmentIds(draft.attachmentVersionIds, COMPLETION_PURPOSES.length);
    validKey(idempotencyKey); validAt(at);
    const canonicalRequest = safeStringify(["withdrawal.mark-transferred.v1", normalizedDocumentId, expectedVersion, selectedAttachments]);
    return this.inTransaction(async (client) => {
      await this.lockCommand(client, context, "MARK_TRANSFERRED", idempotencyKey);
      const document = await this.lockDocument(client, normalizedDocumentId);
      const replay = await this.replay(client, context, "MARK_TRANSFERRED", idempotencyKey, canonicalRequest);
      if (replay) return replay;
      if (document.kind !== "WITHDRAWAL" || document.status !== "PENDING_TRANSFER") error("FINANCE_WITHDRAWAL_STATE_CONFLICT");
      if (versionOf(document) !== expectedVersion) error("VERSION_CONFLICT");
      const attachments = await this.lockReadyAttachments(client, document.id, selectedAttachments, COMPLETION_PURPOSES, COMPLETION_PURPOSES);
      await this.verifyAttachments(attachments);
      const nextVersion = expectedVersion + 1;
      await client.query("UPDATE finance_document SET status='TRANSFERRED',version=$2::bigint,updated_at=$3::timestamptz WHERE id=$1::uuid", [document.id, nextVersion, at.toISOString()]);
      await client.query("INSERT INTO finance_withdrawal_transfer(finance_document_id,transferred_by_person_id,transferred_at,created_at) VALUES ($1::uuid,$2::uuid,$3::timestamptz,$3::timestamptz)", [document.id, context.personId, at.toISOString()]);
      await this.bindAttachments(client, document.id, "COMPLETION", attachments, nextVersion, context.personId, at);
      await this.insertDocumentEvent(client, document.id, "TRANSFERRED", context.personId, nextVersion, null, { completionAttachmentCount: attachments.length }, at);
      await this.recordCommand(client, context, "MARK_TRANSFERRED", idempotencyKey, canonicalRequest, document.id, "TRANSFERRED", nextVersion, at);
      return result(document.id, "TRANSFERRED", nextVersion, false);
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
    } catch (failure) {
      if (!committed) await client.query("ROLLBACK");
      throw failure;
    } finally { await client.release(); }
  }

  private async lockCommand(client: PostgresClient, context: RoleContext, operation: "SUBMIT" | "REVOKE" | "MARK_TRANSFERRED", key: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`withdrawal:${context.personId}:${operation}:${key}`]);
  }
  private async lockDocument(client: PostgresClient, documentId: string, applicantPersonId?: string, at?: Date): Promise<DocumentRow> {
    if (applicantPersonId !== undefined) {
      if (at === undefined) error("INVALID_INPUT");
      const {start,end} = financeYearBounds(at as Date);
      return this.one((await client.query<DocumentRow>(
        `SELECT document.id::text AS id,document.applicant_person_id::text AS applicant_person_id,document.kind,document.status,document.version::text AS version
           FROM finance_document document LEFT JOIN finance_withdrawal_submission submission ON submission.finance_document_id=document.id
          WHERE document.id=$1::uuid AND document.applicant_person_id=$2::uuid
            AND COALESCE(submission.submitted_at,document.created_at)>=$3::timestamptz
            AND COALESCE(submission.submitted_at,document.created_at)<$4::timestamptz FOR UPDATE OF document`,
        [documentId,applicantPersonId,start,end])).rows,"FINANCE_DOCUMENT_NOT_FOUND");
    }
    return this.one((await client.query<DocumentRow>("SELECT id::text AS id,applicant_person_id::text AS applicant_person_id,kind,status,version::text AS version FROM finance_document WHERE id=$1::uuid FOR UPDATE", [documentId])).rows, "FINANCE_DOCUMENT_NOT_FOUND");
  }
  private async replay(client: PostgresClient, context: RoleContext, operation: "SUBMIT" | "REVOKE" | "MARK_TRANSFERRED", key: string, canonicalRequest: string): Promise<WithdrawalResult | undefined> {
    const stored = (await client.query<IdempotencyRow>(
      `SELECT request_hmac,hmac_key_id,finance_document_id::text AS finance_document_id,result_status,result_document_version::text AS result_document_version
         FROM finance_withdrawal_command_idempotency WHERE actor_person_id=$1::uuid AND operation=$2 AND idempotency_key=$3 FOR SHARE`,
      [context.personId, operation, key]
    )).rows[0];
    if (!stored) return undefined;
    if (this.crypto.requestHmac(canonicalRequest, stored.hmac_key_id) !== stored.request_hmac) error("IDEMPOTENCY_REPLAY");
    return result(stored.finance_document_id, stored.result_status, versionOf({ version: stored.result_document_version }), true);
  }
  private async lockActiveSourceAccount(client: PostgresClient, id: string): Promise<AccountRow> {
    const account = this.one((await client.query<AccountRow>(
      "SELECT id::text AS id,owner_type,owner_id::text AS owner_id,account_code,status FROM settlement_account WHERE id=$1::uuid FOR UPDATE", [id]
    )).rows, "SOURCE_ACCOUNT_NOT_FOUND");
    if (account.status !== "ACTIVE" || (account.owner_type !== "PERSON" && account.owner_type !== "VENUE")) error("SOURCE_ACCOUNT_NOT_WITHDRAWABLE");
    return account;
  }
  private async assertSourceAuthorization(client: PostgresClient, context: RoleContext, account: AccountRow, at: Date): Promise<{kind: "PERSON_OWNER" | "VENUE_OWNER" | "VENUE_GRANT"; grantId?: string; snapshot: Record<string, unknown>}> {
    if (account.owner_type === "PERSON") {
      if (account.owner_id !== context.personId.toLowerCase()) error("FORBIDDEN_SCOPE");
      return { kind: "PERSON_OWNER", snapshot: { authorizationKind: "PERSON_OWNER", sourceAccountId: account.id, personId: context.personId.toLowerCase() } };
    }
    const venue = this.one((await client.query<{owner_person_id:string}>(
      "SELECT owner_person_id::text AS owner_person_id FROM venue WHERE id=$1::uuid FOR SHARE", [account.owner_id]
    )).rows, "SOURCE_ACCOUNT_NOT_WITHDRAWABLE");
    if (venue.owner_person_id === context.personId.toLowerCase()) return { kind: "VENUE_OWNER", snapshot: { authorizationKind: "VENUE_OWNER", venueId: account.owner_id, venueOwnerPersonId: venue.owner_person_id } };
    const grant = (await client.query<{id:string;valid_from:string;valid_to:string|null;grantee_person_id:string}>(
      `SELECT id::text AS id,valid_from::text AS valid_from,valid_to::text AS valid_to,grantee_person_id::text AS grantee_person_id FROM venue_permission_grant
        WHERE venue_id=$1::uuid AND grantee_person_id=$2::uuid AND can_withdraw=true
          AND valid_from <= $3::timestamptz AND (valid_to IS NULL OR valid_to > $3::timestamptz)
        FOR SHARE`, [account.owner_id, context.personId, at.toISOString()]
    )).rows[0];
    if (grant === undefined) throw new Error("FORBIDDEN_SCOPE");
    return { kind: "VENUE_GRANT", grantId: grant.id, snapshot: { authorizationKind: "VENUE_GRANT", venueId: account.owner_id, venueOwnerPersonId: venue.owner_person_id, grantId: grant.id, granteePersonId: grant.grantee_person_id, validFrom: new Date(grant.valid_from).toISOString(), validTo: grant.valid_to === null ? null : new Date(grant.valid_to).toISOString() } };
  }
  private async lockBalance(client: PostgresClient, accountId: string): Promise<bigint> {
    await client.query("INSERT INTO account_balance_projection(account_id,balance_cents) VALUES ($1::uuid,0) ON CONFLICT (account_id) DO NOTHING", [accountId]);
    const row = this.one((await client.query<{balance_cents:string}>(
      "SELECT balance_cents::text AS balance_cents FROM account_balance_projection WHERE account_id=$1::uuid FOR UPDATE", [accountId]
    )).rows, "SOURCE_ACCOUNT_NOT_FOUND");
    return BigInt(row.balance_cents);
  }
  private async lockReadyAttachments(client: PostgresClient, documentId: string, ids: readonly string[], allowedPurposes: readonly string[], requiredPurposes: readonly string[]): Promise<readonly AttachmentRow[]> {
    const rows = (await client.query<AttachmentRow>(
      `SELECT version.id::text AS id,attachment.purpose,version.status,version.detected_media_type,version.actual_size_bytes::text AS actual_size_bytes,version.sha256
         FROM finance_attachment_version version JOIN finance_attachment attachment ON attachment.id=version.finance_attachment_id
        WHERE attachment.finance_document_id=$1::uuid AND version.id=ANY($2::uuid[])
        FOR SHARE OF attachment,version`, [documentId, ids]
    )).rows;
    if (rows.length !== ids.length || rows.some(row => row.status !== "READY" || !allowedPurposes.includes(row.purpose))) error("FINANCE_ATTACHMENT_NOT_READY");
    if (requiredPurposes.some(purpose => !rows.some(row => row.purpose === purpose))) error("FINANCE_ATTACHMENT_NOT_READY");
    return rows;
  }
  private async verifyAttachments(rows: readonly AttachmentRow[]): Promise<void> {
    for (const row of rows) {
      const size = row.actual_size_bytes === null ? NaN : Number(row.actual_size_bytes);
      if (!row.detected_media_type || !Number.isSafeInteger(size) || size < 1 || row.sha256 === null || !SHA256.test(row.sha256)) error("ATTACHMENT_INTEGRITY_FAILED");
      const mediaType = row.detected_media_type as AttachmentMediaType;
      const sha256 = row.sha256 as string;
      try { await this.store.readVerified({ versionId: row.id, mediaType, sizeBytes: size, sha256 }); }
      catch { error("ATTACHMENT_INTEGRITY_FAILED"); }
    }
  }
  private async postLedger(client: PostgresClient, eventKey: string, eventType: string, account: AccountRow, amount: bigint, payload: unknown): Promise<{eventId:string}> {
    const bound = createPostgresLedgerTransaction(client);
    const posted = await postLedgerEvent({ transaction: work => work(bound) }, {
      eventKey, eventType, payloadHash: eventPayloadHash(payload), deltas: [{ accountKey: account.account_code, categoryKey: "withdrawal", amountCents: amount }]
    }, randomUUID);
    return { eventId: posted.event.eventId };
  }
  private async bindAttachments(client: PostgresClient, documentId: string, stage: "SUBMISSION" | "COMPLETION", rows: readonly AttachmentRow[], documentVersion: number, actorId: string, at: Date): Promise<void> {
    for (const row of rows) await client.query(
      `INSERT INTO finance_withdrawal_attachment_binding(finance_document_id,stage,purpose,finance_attachment_version_id,document_version,bound_by_person_id,bound_at,created_at)
       VALUES ($1::uuid,$2,$3,$4::uuid,$5::bigint,$6::uuid,$7::timestamptz,$7::timestamptz)`,
      [documentId, stage, row.purpose, row.id, documentVersion, actorId, at.toISOString()]
    );
  }
  private async insertDocumentEvent(client: PostgresClient, documentId: string, type: "SUBMITTED" | "TRANSFERRED" | "REVOKED", actorId: string, version: number, ledgerEventId: string | null, details: Record<string, unknown>, at: Date): Promise<void> {
    await client.query(
      `INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,ledger_event_id,details_json,created_at)
       VALUES ($1::uuid,$2,$3::uuid,$4::bigint,$5::uuid,$6::jsonb,$7::timestamptz)`,
      [documentId, type, actorId, version, ledgerEventId, safeStringify(details), at.toISOString()]
    );
  }
  private async recordCommand(client: PostgresClient, context: RoleContext, operation: "SUBMIT" | "REVOKE" | "MARK_TRANSFERRED", key: string, canonicalRequest: string, documentId: string, status: WithdrawalResult["status"], version: number, at: Date): Promise<void> {
    const hmacKeyId = this.crypto.activeKeyId;
    await client.query(
      `INSERT INTO finance_withdrawal_command_idempotency(actor_person_id,operation,idempotency_key,request_hmac,hmac_key_id,finance_document_id,result_status,result_document_version,created_at)
       VALUES ($1::uuid,$2,$3,$4,$5,$6::uuid,$7,$8::bigint,$9::timestamptz)`,
      [context.personId, operation, key, this.crypto.requestHmac(canonicalRequest, hmacKeyId), hmacKeyId, documentId, status, version, at.toISOString()]
    );
  }
  private one<Row>(rows: readonly Row[], code: string): Row { if (rows.length !== 1) error(code); return rows[0]!; }
}
