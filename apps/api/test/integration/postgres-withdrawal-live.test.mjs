import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { LocalAttachmentStore } from "../../dist/local-attachment-store.js";
import { FinanceSensitiveFieldCrypto } from "../../dist/finance-sensitive-field-crypto.js";
import { PostgresWithdrawalService } from "../../dist/postgres-withdrawal-service.js";
import { PostgresWithdrawalReadService } from "../../dist/postgres-withdrawal-read-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const at = new Date("2026-09-21T09:00:00.000Z");
const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const self = (personId) => ({ subject: "TEACHING_TEACHER", personId, scope: "SELF" });
const headquarters = (personId) => ({ subject: "HEADQUARTERS_FINANCE", personId, scope: "GLOBAL" });
const chunks = (bytes) => (async function* () { yield bytes; })();

const addPerson = async (pool, id, nickname) => pool.query(
  "INSERT INTO person(id,nickname,legal_name,status) VALUES ($1::uuid,$2,'合成人员','ACTIVE')", [id, nickname]
);
const addDocument = async (pool, personId) => {
  const id = randomUUID();
  await pool.query("INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at) VALUES ($1::uuid,$2::uuid,'WITHDRAWAL','DRAFT',1,$3::timestamptz,$3::timestamptz)", [id, personId, at.toISOString()]);
  return id;
};
const addAccount = async (pool, ownerType, ownerId, balance, status = "ACTIVE") => {
  const id = randomUUID();
  await pool.query("INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES ($1::uuid,$2,$3::uuid,$4,$5)", [id, ownerType, ownerId, `withdrawal:${id}`, status]);
  await pool.query("INSERT INTO account_balance_projection(account_id,balance_cents) VALUES ($1::uuid,$2::bigint)", [id, String(balance)]);
  return id;
};
const addReadyAttachment = async (pool, store, documentId, purpose, bytes = png) => {
  const attachmentId = randomUUID();
  const versionId = randomUUID();
  const digest = sha256(bytes);
  await store.put({ versionId, originalFilename: `${purpose}.png`, declaredMediaType: "image/png", declaredSizeBytes: bytes.length, expectedSha256: digest }, chunks(bytes));
  await pool.query("INSERT INTO finance_attachment(id,finance_document_id,purpose,created_by_person_id,created_at) SELECT $1::uuid,$2::uuid,$3,applicant_person_id,$4::timestamptz FROM finance_document WHERE id=$2::uuid", [attachmentId, documentId, purpose, at.toISOString()]);
  await pool.query(
    `INSERT INTO finance_attachment_version(id,finance_attachment_id,version_no,status,original_filename,declared_media_type,declared_size_bytes,expected_sha256,detected_media_type,actual_size_bytes,sha256,uploaded_by_person_id,created_at,ready_at)
     SELECT $1::uuid,$2::uuid,1,'READY',$3,'image/png',$4::bigint,$5,'image/png',$4::bigint,$5,applicant_person_id,$6::timestamptz,$6::timestamptz FROM finance_document WHERE id=$7::uuid`,
    [versionId, attachmentId, `${purpose}.png`, bytes.length, digest, at.toISOString(), documentId]
  );
  return versionId;
};
const submissionDraft = (sourceAccountId, attachmentVersionIds, overrides = {}) => ({
  expectedVersion: 1, sourceAccountId, amountCents: "600", recipientName: "收款老师", bankAccount: "6222020202020202", bankName: "合成银行", attachmentVersionIds, ...overrides
});

test("招生身份的组织范围不阻止本人提现，也不扩大到他人账户", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-withdrawal-scope-"));
  try {
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const crypto = new FinanceSensitiveFieldCrypto("test", {test: randomBytes(32).toString("hex")});
    const service = new PostgresWithdrawalService(db.pool, store, crypto);
    const reads = new PostgresWithdrawalReadService(db.pool, crypto);
    const contexts = [
      { personId: randomUUID(), subject: "ACADEMIC_PLANNER", scope: "CAMPUS", campusId: randomUUID() },
      { personId: randomUUID(), subject: "PLANNING_MENTOR", scope: "ASSOCIATED_TEACHERS" }
    ];
    const documents = [];
    for (const context of contexts) {
      await addPerson(db.pool, context.personId, context.subject);
      const accountId = await addAccount(db.pool, "PERSON", context.personId, 1000);
      const documentId = await addDocument(db.pool, context.personId);
      const attachments = await Promise.all(["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT"].map(purpose => addReadyAttachment(db.pool, store, documentId, purpose)));
      assert.deepEqual((await reads.listSources(context, at)).map(source => source.accountId), [accountId]);
      await service.submit(context, documentId, submissionDraft(accountId, attachments), `scope-${context.subject}`, at);
      assert.equal((await reads.getDetail(context, documentId, at)).id, documentId);
      assert.deepEqual((await reads.listOwn(context, at)).map(item => item.id), [documentId]);
      documents.push({documentId, accountId, attachments});
    }
    await assert.rejects(reads.getDetail(contexts[0], documents[1].documentId, at), /FINANCE_DOCUMENT_NOT_FOUND/);
    await assert.rejects(service.submit(contexts[0], documents[1].documentId, submissionDraft(documents[1].accountId, documents[1].attachments), "other-doc", at), /FINANCE_DOCUMENT_NOT_FOUND/);
    const ownDraft = await addDocument(db.pool, contexts[0].personId);
    await assert.rejects(service.submit(contexts[0], ownDraft, submissionDraft(documents[1].accountId, documents[0].attachments), "other-account", at), /FORBIDDEN_SCOPE/);
    const nextYear = new Date("2027-09-01T00:00:00Z");
    assert.equal((await service.submit(contexts[0], documents[0].documentId, submissionDraft(documents[0].accountId, documents[0].attachments), "scope-ACADEMIC_PLANNER", nextYear)).replay, true);
    await assert.rejects(service.submit(contexts[0], documents[0].documentId, submissionDraft(documents[0].accountId, documents[0].attachments, {amountCents:"601"}), "scope-ACADEMIC_PLANNER", nextYear), /IDEMPOTENCY_REPLAY/);
    await assert.rejects(service.submit(contexts[0], ownDraft, submissionDraft(documents[0].accountId, documents[0].attachments), "old-draft", nextYear), /FINANCE_DOCUMENT_NOT_FOUND/);
    assert.equal((await db.pool.query("SELECT COUNT(*)::int AS n FROM ledger_event WHERE event_type='WITHDRAWAL_DEBIT'")).rows[0].n, 2);
  } finally { await db.close(); await rm(root, {recursive:true, force:true}); }
});

test("提现提交扣豆、冻结敏感资料、轮换HMAC重放及个人范围均可核验", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-withdrawal-"));
  const [applicantId, otherId] = [randomUUID(), randomUUID()];
  try {
    await addPerson(db.pool, applicantId, "withdrawal-applicant");
    await addPerson(db.pool, otherId, "withdrawal-other");
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const oldKey = randomBytes(32).toString("hex");
    const service = new PostgresWithdrawalService(db.pool, store, new FinanceSensitiveFieldCrypto("old", { old: oldKey }));
    const documentId = await addDocument(db.pool, applicantId);
    const accountId = await addAccount(db.pool, "PERSON", applicantId, 1_000);
    const supporting = await addReadyAttachment(db.pool, store, documentId, "SUPPORTING_DOCUMENT");
    const screenshot = await addReadyAttachment(db.pool, store, documentId, "APPLICATION_SCREENSHOT");
    const invoice = await addReadyAttachment(db.pool, store, documentId, "INVOICE");
    const submitted = await service.submit(self(applicantId), documentId, submissionDraft(accountId, [screenshot.toUpperCase(), supporting, invoice]), "submit-key", at);
    assert.deepEqual(submitted, { id: documentId, status: "PENDING_TRANSFER", version: 2, replay: false });
    assert.equal((await db.pool.query("SELECT balance_cents::text AS amount FROM account_balance_projection WHERE account_id=$1::uuid", [accountId])).rows[0].amount, "400");
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM ledger_event WHERE event_type='WITHDRAWAL_DEBIT'")).rows[0].n, 1);
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM finance_withdrawal_attachment_binding WHERE finance_document_id=$1::uuid AND stage='SUBMISSION'", [documentId])).rows[0].n, 3);
    const encrypted = (await db.pool.query("SELECT recipient_ciphertext,authorization_snapshot::text AS snapshot FROM finance_withdrawal_submission WHERE finance_document_id=$1::uuid", [documentId])).rows[0];
    assert.equal(encrypted.recipient_ciphertext.includes("6222020202020202"), false);
    assert.equal(encrypted.recipient_ciphertext.includes("收款老师"), false);
    assert.equal(encrypted.snapshot.includes("6222020202020202"), false);

    const duplicateEventDocument = await addDocument(db.pool, applicantId);
    await assert.rejects(db.pool.query(
      `INSERT INTO finance_withdrawal_submission(finance_document_id,source_account_id,source_owner_type,source_owner_id,authorization_kind,authorization_grant_id,authorization_snapshot,amount_cents,recipient_key_id,recipient_nonce,recipient_ciphertext,recipient_auth_tag,bank_account_last4,debit_ledger_event_id,submitted_by_person_id,submitted_at,created_at)
       SELECT $1::uuid,source_account_id,source_owner_type,source_owner_id,authorization_kind,authorization_grant_id,authorization_snapshot,amount_cents,recipient_key_id,recipient_nonce,recipient_ciphertext,recipient_auth_tag,bank_account_last4,debit_ledger_event_id,submitted_by_person_id,submitted_at,created_at
         FROM finance_withdrawal_submission WHERE finance_document_id=$2::uuid`,
      [duplicateEventDocument, documentId]
    ), /finance_withdrawal_submission_debit_ledger_event_id_key/);

    const draftMutation = await addDocument(db.pool, applicantId);
    await assert.rejects(db.pool.query("UPDATE finance_document SET applicant_person_id=$2::uuid WHERE id=$1::uuid", [draftMutation, otherId]), /FINANCE_DOCUMENT_IDENTITY_IMMUTABLE/);
    await assert.rejects(db.pool.query("UPDATE finance_document SET kind='REFUND' WHERE id=$1::uuid", [draftMutation]), /FINANCE_DOCUMENT_IDENTITY_IMMUTABLE/);
    await db.pool.query("UPDATE finance_document SET version=2,updated_at=$2::timestamptz WHERE id=$1::uuid", [draftMutation, at.toISOString()]);
    await assert.rejects(db.pool.query("UPDATE finance_document SET version=4 WHERE id=$1::uuid", [draftMutation]), /FINANCE_DOCUMENT_WITHDRAWAL_TRANSITION_INVALID/);

    const nextKey = randomBytes(32).toString("hex");
    const afterRotation = new PostgresWithdrawalService(db.pool, store, new FinanceSensitiveFieldCrypto("next", { old: oldKey, next: nextKey }));
    assert.deepEqual(await afterRotation.submit(self(applicantId), documentId.toUpperCase(), submissionDraft(accountId.toUpperCase(), [invoice, supporting, screenshot]), "submit-key", at), { ...submitted, replay: true });
    await assert.rejects(afterRotation.submit(self(applicantId), documentId, submissionDraft(accountId, [supporting, screenshot, invoice], { amountCents: "601" }), "submit-key", at), /IDEMPOTENCY_REPLAY/);
    await assert.rejects(afterRotation.submit(self(otherId), documentId, submissionDraft(accountId, [supporting, screenshot, invoice]), "other-person", at), /FINANCE_DOCUMENT_NOT_FOUND/);
    const impossible = await addDocument(db.pool, applicantId);
    await assert.rejects(afterRotation.submit(self(applicantId), impossible, submissionDraft(accountId, [], { amountCents: "9223372036854775808" }), "too-large", at), /INVALID_INPUT/);
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM ledger_event WHERE event_type='WITHDRAWAL_DEBIT'")).rows[0].n, 1);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("场地授权提交、撤权后财务撤回、回执完成及互斥状态不重复入账", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-withdrawal-"));
  const [applicantId, venueOwnerId, financeId] = [randomUUID(), randomUUID(), randomUUID()];
  try {
    for (const [id, name] of [[applicantId, "withdrawal-grantee"], [venueOwnerId, "withdrawal-owner"], [financeId, "withdrawal-finance"]]) await addPerson(db.pool, id, name);
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const service = new PostgresWithdrawalService(db.pool, store, new FinanceSensitiveFieldCrypto("test", { test: randomBytes(32).toString("hex") }));
    const venueId = randomUUID();
    await db.pool.query("INSERT INTO venue(id,owner_person_id,name,status,default_for_owner) VALUES ($1::uuid,$2::uuid,'合成场地','INACTIVE',false)", [venueId, venueOwnerId]);
    const venueAccount = await addAccount(db.pool, "VENUE", venueId, 1_000);
    const grantId = randomUUID();
    await db.pool.query("INSERT INTO venue_permission_grant(id,venue_id,grantee_person_id,can_view,can_withdraw,valid_from,granted_by,created_at) VALUES ($1::uuid,$2::uuid,$3::uuid,false,true,$4::timestamptz,$5::uuid,$4::timestamptz)", [grantId, venueId, applicantId, new Date(at.getTime() - 1_000).toISOString(), venueOwnerId]);
    const documentId = await addDocument(db.pool, applicantId);
    const supporting = await addReadyAttachment(db.pool, store, documentId, "SUPPORTING_DOCUMENT");
    const screenshot = await addReadyAttachment(db.pool, store, documentId, "APPLICATION_SCREENSHOT");
    const pending = await service.submit(self(applicantId), documentId, submissionDraft(venueAccount, [supporting, screenshot]), "venue-submit", at);
    assert.equal(pending.status, "PENDING_TRANSFER");
    const snapshot = (await db.pool.query("SELECT authorization_snapshot FROM finance_withdrawal_submission WHERE finance_document_id=$1::uuid", [documentId])).rows[0].authorization_snapshot;
    assert.deepEqual(snapshot, { authorizationKind: "VENUE_GRANT", venueId, venueOwnerPersonId: venueOwnerId, grantId, granteePersonId: applicantId, validFrom: new Date(at.getTime() - 1_000).toISOString(), validTo: null });
    await db.pool.query("UPDATE venue_permission_grant SET valid_to=$3::timestamptz WHERE id=$1::uuid AND venue_id=$2::uuid", [grantId, venueId, at.toISOString()]);
    const revoked = await service.revoke(headquarters(financeId), documentId, { expectedVersion: 2, reason: "财务撤回" }, "venue-revoke", at);
    assert.deepEqual(revoked, { id: documentId, status: "FINANCE_REVOKED", version: 3, replay: false });
    assert.equal((await db.pool.query("SELECT balance_cents::text AS amount FROM account_balance_projection WHERE account_id=$1::uuid", [venueAccount])).rows[0].amount, "1000");
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM ledger_event WHERE event_type='WITHDRAWAL_REVERSAL'")).rows[0].n, 1);
    const duplicateReversalDocument = await addDocument(db.pool, applicantId);
    await assert.rejects(db.pool.query(
      `INSERT INTO finance_withdrawal_reversal(finance_document_id,reversal_ledger_event_id,reason,revoked_by_person_id,revoked_at,created_at)
       SELECT $1::uuid,reversal_ledger_event_id,reason,revoked_by_person_id,revoked_at,created_at
         FROM finance_withdrawal_reversal WHERE finance_document_id=$2::uuid`,
      [duplicateReversalDocument, documentId]
    ), /finance_withdrawal_reversal_reversal_ledger_event_id_key/);
    await assert.rejects(service.markTransferred(headquarters(financeId), documentId, { expectedVersion: 3, attachmentVersionIds: [] }, "after-revoke", at), /INVALID_INPUT|FINANCE_WITHDRAWAL_STATE_CONFLICT/);

    await db.pool.query("INSERT INTO venue_permission_grant(id,venue_id,grantee_person_id,can_view,can_withdraw,valid_from,granted_by,created_at) VALUES ($1::uuid,$2::uuid,$3::uuid,true,true,$4::timestamptz,$5::uuid,$4::timestamptz)", [randomUUID(), venueId, applicantId, at.toISOString(), venueOwnerId]);
    const transferDocument = await addDocument(db.pool, applicantId);
    const transferSupporting = await addReadyAttachment(db.pool, store, transferDocument, "SUPPORTING_DOCUMENT");
    const transferScreenshot = await addReadyAttachment(db.pool, store, transferDocument, "APPLICATION_SCREENSHOT");
    await service.submit(self(applicantId), transferDocument, submissionDraft(venueAccount, [transferSupporting, transferScreenshot]), "transfer-submit", at);
    const receipt = await addReadyAttachment(db.pool, store, transferDocument, "PAYMENT_RECEIPT");
    const transferred = await service.markTransferred(headquarters(financeId), transferDocument, { expectedVersion: 2, attachmentVersionIds: [receipt] }, "transfer-complete", at);
    assert.deepEqual(transferred, { id: transferDocument, status: "TRANSFERRED", version: 3, replay: false });
    assert.equal((await db.pool.query("SELECT balance_cents::text AS amount FROM account_balance_projection WHERE account_id=$1::uuid", [venueAccount])).rows[0].amount, "400");
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM finance_withdrawal_attachment_binding WHERE finance_document_id=$1::uuid AND stage='COMPLETION'", [transferDocument])).rows[0].n, 1);
    await assert.rejects(service.revoke(headquarters(financeId), transferDocument, { expectedVersion: 3, reason: "不能撤回" }, "transferred-revoke", at), /FINANCE_WITHDRAWAL_STATE_CONFLICT/);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("附件不足、并发提交及末端数据库失败均不留下部分扣款", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-withdrawal-"));
  const [applicantId, financeId] = [randomUUID(), randomUUID()];
  try {
    await addPerson(db.pool, applicantId, "withdrawal-race"); await addPerson(db.pool, financeId, "withdrawal-race-finance");
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const service = new PostgresWithdrawalService(db.pool, store, new FinanceSensitiveFieldCrypto("test", { test: randomBytes(32).toString("hex") }));
    const accountId = await addAccount(db.pool, "PERSON", applicantId, 1_000);
    const invalidDocument = await addDocument(db.pool, applicantId);
    const onlySupporting = await addReadyAttachment(db.pool, store, invalidDocument, "SUPPORTING_DOCUMENT");
    const anotherSupporting = await addReadyAttachment(db.pool, store, invalidDocument, "SUPPORTING_DOCUMENT");
    await assert.rejects(service.submit(self(applicantId), invalidDocument, submissionDraft(accountId, [onlySupporting, anotherSupporting]), "bad-attachment", at), /FINANCE_ATTACHMENT_NOT_READY/);
    assert.equal((await db.pool.query("SELECT balance_cents::text AS amount FROM account_balance_projection WHERE account_id=$1::uuid", [accountId])).rows[0].amount, "1000");

    const raceDocument = await addDocument(db.pool, applicantId);
    const supporting = await addReadyAttachment(db.pool, store, raceDocument, "SUPPORTING_DOCUMENT");
    const screenshot = await addReadyAttachment(db.pool, store, raceDocument, "APPLICATION_SCREENSHOT");
    const secondRaceDocument = await addDocument(db.pool, applicantId);
    const secondSupporting = await addReadyAttachment(db.pool, store, secondRaceDocument, "SUPPORTING_DOCUMENT");
    const secondScreenshot = await addReadyAttachment(db.pool, store, secondRaceDocument, "APPLICATION_SCREENSHOT");
    const race = await Promise.allSettled([
      service.submit(self(applicantId), raceDocument, submissionDraft(accountId, [supporting, screenshot]), "race-a", at),
      service.submit(self(applicantId), secondRaceDocument, submissionDraft(accountId, [secondSupporting, secondScreenshot]), "race-b", at)
    ]);
    assert.equal(race.filter(item => item.status === "fulfilled").length, 1);
    assert.match(race.find(item=>item.status==='rejected').reason.message,/INSUFFICIENT_BALANCE/);
    assert.equal((await db.pool.query("SELECT balance_cents::text AS amount FROM account_balance_projection WHERE account_id=$1::uuid", [accountId])).rows[0].amount, "400");
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM ledger_event WHERE event_type='WITHDRAWAL_DEBIT'")).rows[0].n, 1);

    const failureDocument = await addDocument(db.pool, applicantId);
    const failureSupporting = await addReadyAttachment(db.pool, store, failureDocument, "SUPPORTING_DOCUMENT");
    const failureScreenshot = await addReadyAttachment(db.pool, store, failureDocument, "APPLICATION_SCREENSHOT");
    await db.pool.query("CREATE FUNCTION fail_withdrawal_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='SUBMITTED' THEN RAISE EXCEPTION 'FORCED_WITHDRAWAL_EVENT_FAILURE'; END IF; RETURN NEW; END; $$");
    await db.pool.query("CREATE TRIGGER fail_withdrawal_event BEFORE INSERT ON finance_document_event FOR EACH ROW EXECUTE FUNCTION fail_withdrawal_event()");
    await assert.rejects(service.submit(self(applicantId), failureDocument, submissionDraft(accountId, [failureSupporting, failureScreenshot], { amountCents: "100" }), "forced-failure", at), /FORCED_WITHDRAWAL_EVENT_FAILURE/);
    await db.pool.query("DROP TRIGGER fail_withdrawal_event ON finance_document_event");
    assert.equal((await db.pool.query("SELECT status FROM finance_document WHERE id=$1::uuid", [failureDocument])).rows[0].status, "DRAFT");
    assert.equal((await db.pool.query("SELECT balance_cents::text AS amount FROM account_balance_projection WHERE account_id=$1::uuid", [accountId])).rows[0].amount, "400");
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM finance_withdrawal_submission WHERE finance_document_id=$1::uuid", [failureDocument])).rows[0].n, 0);
    const successfulDocument=race.find(item=>item.status==='fulfilled').value.id;
    const receipt=await addReadyAttachment(db.pool,store,successfulDocument,'PAYMENT_RECEIPT');
    // An independent synthetic balance change must survive either financial action.
    await db.pool.query('UPDATE account_balance_projection SET balance_cents=balance_cents+50 WHERE account_id=$1',[accountId]);
    const revokeDraft={expectedVersion:2,reason:'竞争撤回'};
    const transferDraft={expectedVersion:2,attachmentVersionIds:[receipt]};
    const competing=await Promise.allSettled([
      service.revoke(headquarters(financeId),successfulDocument,revokeDraft,'competing-revoke',at),
      service.markTransferred(headquarters(financeId),successfulDocument,transferDraft,'competing-transfer',at)
    ]);
    assert.equal(competing.filter(item=>item.status==='fulfilled').length,1);
    assert.match(competing.find(item=>item.status==='rejected').reason.message,/FINANCE_WITHDRAWAL_STATE_CONFLICT/);
    const outcome=competing.find(item=>item.status==='fulfilled').value;
    const expectedBalance=outcome.status==='FINANCE_REVOKED'?'1050':'450';
    assert.equal((await db.pool.query('SELECT balance_cents::text AS amount FROM account_balance_projection WHERE account_id=$1',[accountId])).rows[0].amount,expectedBalance);
    const repeat=outcome.status==='FINANCE_REVOKED'
      ?await service.revoke(headquarters(financeId),successfulDocument,revokeDraft,'competing-revoke',at)
      :await service.markTransferred(headquarters(financeId),successfulDocument,transferDraft,'competing-transfer',at);
    assert.equal(repeat.replay,true);
    assert.equal((await db.pool.query('SELECT balance_cents::text AS amount FROM account_balance_projection WHERE account_id=$1',[accountId])).rows[0].amount,expectedBalance);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
