import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { FinanceSensitiveFieldCrypto } from "../../dist/finance-sensitive-field-crypto.js";
import { LocalAttachmentStore } from "../../dist/local-attachment-store.js";
import { PostgresWithdrawalService } from "../../dist/postgres-withdrawal-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const at = new Date("2026-09-21T09:00:00.000Z");
const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const chunks = (bytes) => (async function* () { yield bytes; })();
const applicant = (personId) => ({ subject: "TEACHING_TEACHER", personId, scope: "SELF" });
const headquarters = (personId) => ({ subject: "HEADQUARTERS_FINANCE", personId, scope: "GLOBAL" });

const addPerson = (pool, id, nickname) => pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,'合成人员','ACTIVE')", [id, nickname]);
const addDocument = async (pool, personId) => {
  const id = randomUUID();
  await pool.query("INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at) VALUES($1::uuid,$2::uuid,'WITHDRAWAL','DRAFT',1,$3::timestamptz,$3::timestamptz)", [id, personId, at.toISOString()]);
  return id;
};
const addAccount = async (pool, personId, balance = 1_000) => {
  const id = randomUUID();
  await pool.query("INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,'PERSON',$2::uuid,$3,'ACTIVE')", [id, personId, `withdrawal-evidence:${id}`]);
  await pool.query("INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1::uuid,$2::bigint)", [id, String(balance)]);
  return id;
};
const addReadyAttachment = async (pool, store, documentId, purpose, { attachmentId, uploaderId } = {}) => {
  const slotId = attachmentId ?? randomUUID();
  const versionId = randomUUID();
  const digest = sha256(png);
  await store.put({ versionId, originalFilename: `${purpose}-${versionId}.png`, declaredMediaType: "image/png", declaredSizeBytes: png.length, expectedSha256: digest }, chunks(png));
  if (attachmentId === undefined) await pool.query(
    "INSERT INTO finance_attachment(id,finance_document_id,purpose,created_by_person_id,created_at) SELECT $1::uuid,$2::uuid,$3,applicant_person_id,$4::timestamptz FROM finance_document WHERE id=$2::uuid",
    [slotId, documentId, purpose, at.toISOString()]
  );
  const nextVersion = attachmentId === undefined ? 1 : 2;
  await pool.query(
    `INSERT INTO finance_attachment_version(id,finance_attachment_id,version_no,status,original_filename,declared_media_type,declared_size_bytes,expected_sha256,detected_media_type,actual_size_bytes,sha256,uploaded_by_person_id,created_at,ready_at)
     SELECT $1::uuid,$2::uuid,$3,'READY',$4,'image/png',$5::bigint,$6,'image/png',$5::bigint,$6,COALESCE($7::uuid,document.applicant_person_id),$8::timestamptz,$8::timestamptz
       FROM finance_document document WHERE document.id=$9::uuid`,
    [versionId, slotId, nextVersion, `${purpose}-${nextVersion}.png`, png.length, digest, uploaderId ?? null, at.toISOString(), documentId]
  );
  return { attachmentId: slotId, versionId };
};
const submitDraft = (accountId, attachmentVersionIds, overrides = {}) => ({ expectedVersion: 1, sourceAccountId: accountId, amountCents: "600", recipientName: "收款人", bankAccount: "6222020202020202", attachmentVersionIds, ...overrides });
const balance = async (pool, accountId) => (await pool.query("SELECT balance_cents::text AS value FROM account_balance_projection WHERE account_id=$1::uuid", [accountId])).rows[0].value;
const bind = (pool, { documentId, stage, purpose, versionId, documentVersion, actorId }) => pool.query(
  "INSERT INTO finance_withdrawal_attachment_binding(finance_document_id,stage,purpose,finance_attachment_version_id,document_version,bound_by_person_id,bound_at,created_at) VALUES($1::uuid,$2,$3,$4::uuid,$5::bigint,$6::uuid,$7::timestamptz,$7::timestamptz)",
  [documentId, stage, purpose, versionId, documentVersion, actorId, at.toISOString()]
);

test("提现两阶段证据合法绑定，并在成功命令后由数据库封口", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-withdrawal-evidence-"));
  try {
    const [teacherId, hqAId, hqBId, otherId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const [id, name] of [[teacherId, "evidence-teacher"], [hqAId, "evidence-hq-a"], [hqBId, "evidence-hq-b"], [otherId, "evidence-other"]]) await addPerson(db.pool, id, name);
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const service = new PostgresWithdrawalService(db.pool, store, new FinanceSensitiveFieldCrypto("test", { test: randomBytes(32).toString("hex") }));
    const accountId = await addAccount(db.pool, teacherId);
    const documentId = await addDocument(db.pool, teacherId);
    const supporting = await addReadyAttachment(db.pool, store, documentId, "SUPPORTING_DOCUMENT");
    const screenshot = await addReadyAttachment(db.pool, store, documentId, "APPLICATION_SCREENSHOT");
    await service.submit(applicant(teacherId), documentId, submitDraft(accountId, [supporting.versionId, screenshot.versionId]), "submit-legal", at);
    const receiptV1 = await addReadyAttachment(db.pool, store, documentId, "PAYMENT_RECEIPT", { uploaderId: hqAId });
    const receiptV2 = await addReadyAttachment(db.pool, store, documentId, "PAYMENT_RECEIPT", { attachmentId: receiptV1.attachmentId, uploaderId: hqAId });
    const extraReceipt = await addReadyAttachment(db.pool, store, documentId, "PAYMENT_RECEIPT", { uploaderId: hqAId });
    const transferred = await service.markTransferred(headquarters(hqBId), documentId, { expectedVersion: 2, attachmentVersionIds: [receiptV2.versionId] }, "transfer-legal", at);
    assert.deepEqual(transferred, { id: documentId, status: "TRANSFERRED", version: 3, replay: false });
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM finance_withdrawal_attachment_binding WHERE finance_document_id=$1::uuid", [documentId])).rows[0].n, 3);
    assert.equal((await db.pool.query("SELECT finance_attachment_version_id::text AS version_id FROM finance_withdrawal_attachment_binding WHERE finance_document_id=$1::uuid AND stage='COMPLETION'", [documentId])).rows[0].version_id, receiptV2.versionId, "PENDING期间同槽v1→v2修订后，只绑定实际办理时选定的v2");
    const bindingCount = (await db.pool.query("SELECT count(*)::int AS n FROM finance_withdrawal_attachment_binding WHERE finance_document_id=$1::uuid", [documentId])).rows[0].n;
    await assert.rejects(bind(db.pool, { documentId, stage: "COMPLETION", purpose: "PAYMENT_RECEIPT", versionId: extraReceipt.versionId, documentVersion: 3, actorId: hqBId }), /FINANCE_WITHDRAWAL_ATTACHMENT_INVALID/);
    await assert.rejects(bind(db.pool, { documentId, stage: "COMPLETION", purpose: "PAYMENT_RECEIPT", versionId: receiptV1.versionId, documentVersion: 3, actorId: hqBId }), /FINANCE_WITHDRAWAL_ATTACHMENT_INVALID/);
    await assert.rejects(bind(db.pool, { documentId, stage: "COMPLETION", purpose: "PAYMENT_RECEIPT", versionId: extraReceipt.versionId, documentVersion: 2, actorId: hqBId }), /FINANCE_WITHDRAWAL_ATTACHMENT_INVALID/);
    await assert.rejects(bind(db.pool, { documentId, stage: "COMPLETION", purpose: "PAYMENT_RECEIPT", versionId: extraReceipt.versionId, documentVersion: 3, actorId: otherId }), /FINANCE_WITHDRAWAL_ATTACHMENT_INVALID/);
    await assert.rejects(bind(db.pool, { documentId, stage: "SUBMISSION", purpose: "SUPPORTING_DOCUMENT", versionId: supporting.versionId, documentVersion: 3, actorId: teacherId }), /FINANCE_WITHDRAWAL_ATTACHMENT_INVALID/);
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM finance_withdrawal_attachment_binding WHERE finance_document_id=$1::uuid", [documentId])).rows[0].n, bindingCount);

    const selfPurchaseId = randomUUID();
    await db.pool.query("INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at) VALUES($1::uuid,$2::uuid,'SELF_PURCHASE','DRAFT',1,$3::timestamptz,$3::timestamptz)", [selfPurchaseId, teacherId, at.toISOString()]);
    const selfEvidence = await addReadyAttachment(db.pool, store, selfPurchaseId, "SUPPORTING_DOCUMENT");
    await assert.rejects(bind(db.pool, { documentId: selfPurchaseId, stage: "SUBMISSION", purpose: "SUPPORTING_DOCUMENT", versionId: selfEvidence.versionId, documentVersion: 1, actorId: teacherId }), /FINANCE_WITHDRAWAL_ATTACHMENT_INVALID/);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("提现服务拒绝同逻辑槽多个版本，撤回只返还原单源账户", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-withdrawal-evidence-slots-"));
  try {
    const [teacherId, hqId] = [randomUUID(), randomUUID()];
    await addPerson(db.pool, teacherId, "evidence-slot-teacher"); await addPerson(db.pool, hqId, "evidence-slot-hq");
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const service = new PostgresWithdrawalService(db.pool, store, new FinanceSensitiveFieldCrypto("test", { test: randomBytes(32).toString("hex") }));
    const accountA = await addAccount(db.pool, teacherId);
    const accountB = await addAccount(db.pool, hqId);
    const duplicateSubmission = await addDocument(db.pool, teacherId);
    const supportV1 = await addReadyAttachment(db.pool, store, duplicateSubmission, "SUPPORTING_DOCUMENT");
    const supportV2 = await addReadyAttachment(db.pool, store, duplicateSubmission, "SUPPORTING_DOCUMENT", { attachmentId: supportV1.attachmentId });
    const duplicateScreenshot = await addReadyAttachment(db.pool, store, duplicateSubmission, "APPLICATION_SCREENSHOT");
    await assert.rejects(service.submit(applicant(teacherId), duplicateSubmission, submitDraft(accountA, [supportV1.versionId, supportV2.versionId, duplicateScreenshot.versionId]), "duplicate-submission-slot", at), /FINANCE_ATTACHMENT_NOT_READY/);
    assert.equal(await balance(db.pool, accountA), "1000");

    const duplicateCompletion = await addDocument(db.pool, teacherId);
    const completionSupport = await addReadyAttachment(db.pool, store, duplicateCompletion, "SUPPORTING_DOCUMENT");
    const completionScreenshot = await addReadyAttachment(db.pool, store, duplicateCompletion, "APPLICATION_SCREENSHOT");
    await service.submit(applicant(teacherId), duplicateCompletion, submitDraft(accountA, [completionSupport.versionId, completionScreenshot.versionId]), "completion-submit", at);
    const receiptV1 = await addReadyAttachment(db.pool, store, duplicateCompletion, "PAYMENT_RECEIPT", { uploaderId: hqId });
    const receiptV2 = await addReadyAttachment(db.pool, store, duplicateCompletion, "PAYMENT_RECEIPT", { attachmentId: receiptV1.attachmentId, uploaderId: hqId });
    await assert.rejects(service.markTransferred(headquarters(hqId), duplicateCompletion, { expectedVersion: 2, attachmentVersionIds: [receiptV1.versionId, receiptV2.versionId] }, "duplicate-completion-slot", at), /FINANCE_ATTACHMENT_NOT_READY/);
    assert.equal((await db.pool.query("SELECT status FROM finance_document WHERE id=$1::uuid", [duplicateCompletion])).rows[0].status, "PENDING_TRANSFER");
    assert.equal(await balance(db.pool, accountA), "400");

    const revocable = await addDocument(db.pool, teacherId);
    const revokeSupport = await addReadyAttachment(db.pool, store, revocable, "SUPPORTING_DOCUMENT");
    const revokeScreenshot = await addReadyAttachment(db.pool, store, revocable, "APPLICATION_SCREENSHOT");
    await service.submit(applicant(teacherId), revocable, submitDraft(accountA, [revokeSupport.versionId, revokeScreenshot.versionId], { amountCents: "100" }), "revoke-submit", at);
    await service.revoke(headquarters(hqId), revocable, { expectedVersion: 2, reason: "证据修复回归" }, "revoke", at);
    assert.equal(await balance(db.pool, accountA), "400", "撤回只返还该原单的源账户，另一个已提交单保持扣款");
    assert.equal(await balance(db.pool, accountB), "1000", "无关账户不受撤回影响");
    const revokedReceipt = await addReadyAttachment(db.pool, store, revocable, "PAYMENT_RECEIPT", { uploaderId: hqId });
    await assert.rejects(bind(db.pool, { documentId: revocable, stage: "COMPLETION", purpose: "PAYMENT_RECEIPT", versionId: revokedReceipt.versionId, documentVersion: 3, actorId: hqId }), /FINANCE_WITHDRAWAL_ATTACHMENT_INVALID/);

    const orphanTeacherId = randomUUID();
    await addPerson(db.pool, orphanTeacherId, "evidence-orphan-teacher");
    const orphanAccount = await addAccount(db.pool, orphanTeacherId);
    const orphanDebitDocument = await addDocument(db.pool, orphanTeacherId);
    const orphanDebitSupporting = await addReadyAttachment(db.pool, store, orphanDebitDocument, "SUPPORTING_DOCUMENT");
    const orphanDebitScreenshot = await addReadyAttachment(db.pool, store, orphanDebitDocument, "APPLICATION_SCREENSHOT");
    const orphanDebitEvent = randomUUID();
    const orphanDebitPayload = { documentId: orphanDebitDocument, sourceAccountId: orphanAccount, amountCents: "600" };
    await db.pool.query("INSERT INTO ledger_event(id,event_key,event_type,payload_hash) VALUES($1::uuid,$2,'WITHDRAWAL_DEBIT',$3)", [orphanDebitEvent, `withdrawal-debit:${orphanDebitDocument}`, sha256(Buffer.from(JSON.stringify(orphanDebitPayload)))]);
    await db.pool.query("INSERT INTO ledger_entry(event_id,account_id,category_key,amount_cents) VALUES($1::uuid,$2::uuid,'withdrawal',-600)", [orphanDebitEvent, orphanAccount]);
    await assert.rejects(service.submit(applicant(orphanTeacherId), orphanDebitDocument, submitDraft(orphanAccount, [orphanDebitSupporting.versionId, orphanDebitScreenshot.versionId]), "orphan-debit", at), /FINANCE_WITHDRAWAL_PERSISTENCE_INVALID/);
    assert.equal((await db.pool.query("SELECT status FROM finance_document WHERE id=$1::uuid", [orphanDebitDocument])).rows[0].status, "DRAFT");
    assert.equal(await balance(db.pool, orphanAccount), "1000");

    const orphanReversalDocument = await addDocument(db.pool, orphanTeacherId);
    const orphanReversalSupporting = await addReadyAttachment(db.pool, store, orphanReversalDocument, "SUPPORTING_DOCUMENT");
    const orphanReversalScreenshot = await addReadyAttachment(db.pool, store, orphanReversalDocument, "APPLICATION_SCREENSHOT");
    await service.submit(applicant(orphanTeacherId), orphanReversalDocument, submitDraft(orphanAccount, [orphanReversalSupporting.versionId, orphanReversalScreenshot.versionId]), "orphan-reversal-submit", at);
    const orphanReversalEvent = randomUUID();
    const orphanReversalPayload = { documentId: orphanReversalDocument, sourceAccountId: orphanAccount, amountCents: "600" };
    await db.pool.query("INSERT INTO ledger_event(id,event_key,event_type,payload_hash) VALUES($1::uuid,$2,'WITHDRAWAL_REVERSAL',$3)", [orphanReversalEvent, `withdrawal-reversal:${orphanReversalDocument}`, sha256(Buffer.from(JSON.stringify(orphanReversalPayload)))]);
    await db.pool.query("INSERT INTO ledger_entry(event_id,account_id,category_key,amount_cents) VALUES($1::uuid,$2::uuid,'withdrawal',600)", [orphanReversalEvent, orphanAccount]);
    await assert.rejects(service.revoke(headquarters(hqId), orphanReversalDocument, { expectedVersion: 2, reason: "孤儿账本回归" }, "orphan-reversal", at), /FINANCE_WITHDRAWAL_PERSISTENCE_INVALID/);
    assert.equal((await db.pool.query("SELECT status FROM finance_document WHERE id=$1::uuid", [orphanReversalDocument])).rows[0].status, "PENDING_TRANSFER");
    assert.equal(await balance(db.pool, orphanAccount), "400");
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
