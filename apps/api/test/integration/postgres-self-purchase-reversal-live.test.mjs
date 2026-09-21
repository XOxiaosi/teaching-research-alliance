import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { postLedgerEvent } from "@teaching-research-alliance/domain";
import { LocalAttachmentStore } from "../../dist/local-attachment-store.js";
import { PostgresLedgerRepository } from "../../dist/postgres-ledger-repository.js";
import { PostgresSelfPurchaseReversalService } from "../../dist/postgres-self-purchase-reversal-service.js";
import { PostgresSelfPurchaseService } from "../../dist/postgres-self-purchase-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const at = new Date("2026-09-21T09:00:00.000Z");
const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
const digest = (value) => createHash("sha256").update(value).digest("hex");
const chunks = (bytes) => (async function* () { yield bytes; })();
const personal = (personId) => ({ subject: "TEACHING_TEACHER", personId, scope: "SELF" });
const globalAdmin = (personId) => ({ subject: "SYSTEM_ADMIN", personId, scope: "GLOBAL" });
const globalHq = (personId) => ({ subject: "HEADQUARTERS_FINANCE", personId, scope: "GLOBAL" });

const addPerson = (pool, id, name) => pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,'合成人员','ACTIVE')", [id, name]);
const addDocument = async (pool, personId) => {
  const id = randomUUID();
  await pool.query("INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at) VALUES($1::uuid,$2::uuid,'SELF_PURCHASE','DRAFT',1,$3::timestamptz,$3::timestamptz)", [id, personId, at.toISOString()]);
  return id;
};
const addAccount = async (pool, ownerType, ownerId, code, balance) => {
  const id = randomUUID();
  await pool.query("INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,$2,$3::uuid,$4,'ACTIVE')", [id, ownerType, ownerId, code]);
  await pool.query("INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1::uuid,$2::bigint)", [id, String(balance)]);
  return id;
};
const addReadyAttachment = async (pool, store, documentId, purpose) => {
  const attachmentId = randomUUID(); const versionId = randomUUID(); const sha = digest(png);
  await store.put({ versionId, originalFilename: `${purpose}.png`, declaredMediaType: "image/png", declaredSizeBytes: png.length, expectedSha256: sha }, chunks(png));
  await pool.query("INSERT INTO finance_attachment(id,finance_document_id,purpose,created_by_person_id,created_at) SELECT $1::uuid,$2::uuid,$3,applicant_person_id,$4::timestamptz FROM finance_document WHERE id=$2::uuid", [attachmentId, documentId, purpose, at.toISOString()]);
  await pool.query(
    `INSERT INTO finance_attachment_version(id,finance_attachment_id,version_no,status,original_filename,declared_media_type,declared_size_bytes,expected_sha256,detected_media_type,actual_size_bytes,sha256,uploaded_by_person_id,created_at,ready_at)
     SELECT $1::uuid,$2::uuid,1,'READY',$3,'image/png',$4::bigint,$5,'image/png',$4::bigint,$5,applicant_person_id,$6::timestamptz,$6::timestamptz FROM finance_document WHERE id=$7::uuid`,
    [versionId, attachmentId, `${purpose}.png`, png.length, sha, at.toISOString(), documentId]
  );
  return versionId;
};
const configure = async (pool, personId, { sourceBalance = 1_000, destinationBalance = 20 } = {}) => {
  const roleId = randomUUID();
  await pool.query("INSERT INTO role_assignment(id,person_id,subject_code,scope_type,scope_id,valid_from,valid_to,created_by,created_at) VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,$3::timestamptz,NULL,$2::uuid,$3::timestamptz)", [roleId, personId, new Date(at.getTime() - 1_000).toISOString()]);
  const fundId = randomUUID();
  await pool.query("INSERT INTO company_finance_fund(id,kind,fund_code,display_name,status,version,created_by_person_id,created_at,updated_at) VALUES($1::uuid,'HEADQUARTERS_FINANCE_OPERATING',$2,'撤销合成资金','ACTIVE',1,$3::uuid,$4::timestamptz,$4::timestamptz)", [fundId, `FUND${fundId.replaceAll('-', '').slice(0, 20).toUpperCase()}`, personId, at.toISOString()]);
  const sourceAccountId = await addAccount(pool, "COMPANY", fundId, `company:fund:${fundId}`, sourceBalance);
  const destinationAccountId = await addAccount(pool, "PERSON", personId, `person:${personId}`, destinationBalance);
  const assignmentId = randomUUID();
  await pool.query("INSERT INTO company_finance_fund_assignment(id,fund_id,duty_subject,scope_type,scope_id,responsibility_code,valid_from,valid_to,created_by_person_id,created_at) VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'FINANCE_OPERATING_SOURCE',$3::timestamptz,NULL,$4::uuid,$3::timestamptz)", [assignmentId, fundId, new Date(at.getTime() - 1_000).toISOString(), personId]);
  return { roleId, fundId, assignmentId, sourceAccountId, destinationAccountId };
};
const balance = async (pool, accountId) => (await pool.query("SELECT balance_cents::text AS value FROM account_balance_projection WHERE account_id=$1::uuid", [accountId])).rows[0].value;
const completedPurchase = async (pool, store, service, personId, key = randomUUID()) => {
  const documentId = await addDocument(pool, personId);
  const supporting = await addReadyAttachment(pool, store, documentId, "SUPPORTING_DOCUMENT");
  const screenshot = await addReadyAttachment(pool, store, documentId, "APPLICATION_SCREENSHOT");
  await service.submit(personal(personId), documentId, { expectedVersion: 1, amountCents: "100", reason: "采购撤销测试", attachmentVersionIds: [supporting, screenshot] }, key, at);
  return documentId;
};

test("采买撤销按原账户全额反向、允许历史停用与个人负余额", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-self-purchase-reversal-"));
  try {
    const [teacherId, adminId] = [randomUUID(), randomUUID()];
    await addPerson(db.pool, teacherId, "reverse-teacher"); await addPerson(db.pool, adminId, "reverse-admin");
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const purchases = new PostgresSelfPurchaseService(db.pool, store);
    const reversals = new PostgresSelfPurchaseReversalService(db.pool);
    const accounts = await configure(db.pool, teacherId);
    const documentId = await completedPurchase(db.pool, store, purchases, teacherId, "complete");
    assert.equal(await balance(db.pool, accounts.sourceAccountId), "900"); assert.equal(await balance(db.pool, accounts.destinationAccountId), "120");
    await postLedgerEvent(new PostgresLedgerRepository(db.pool), {
      eventKey: `synthetic-personal-spend:${documentId}`, eventType: "SYNTHETIC_PERSONAL_SPEND", payloadHash: "synthetic-personal-spend",
      deltas: [{ accountKey: `person:${teacherId}`, categoryKey: "syntheticPersonalSpend", amountCents: -150n }]
    }, randomUUID);
    await db.pool.query("UPDATE settlement_account SET status='INACTIVE' WHERE id=ANY($1::uuid[])", [[accounts.sourceAccountId, accounts.destinationAccountId]]);
    await db.pool.query("UPDATE role_assignment SET valid_to=$2::timestamptz WHERE id=$1::uuid", [accounts.roleId, at.toISOString()]);
    await db.pool.query("UPDATE company_finance_fund_assignment SET valid_to=$2::timestamptz WHERE id=$1::uuid", [accounts.assignmentId, at.toISOString()]);
    await assert.rejects(reversals.reverse(personal(teacherId), documentId, { expectedVersion: 2, reason: "越权" }, "no-scope", at), /FORBIDDEN_SCOPE/);
    const reversed = await reversals.reverse(globalAdmin(adminId), documentId, { expectedVersion: 2, reason: "采购退货" }, "reverse", at);
    assert.deepEqual(reversed, { id: documentId, status: "REVERSED", version: 3, replay: false });
    assert.equal(await balance(db.pool, accounts.sourceAccountId), "1000");
    assert.equal(await balance(db.pool, accounts.destinationAccountId), "-130");
    const reversal = (await db.pool.query("SELECT actor_subject_code,actor_scope_type,source_before_cents::text AS source_before,source_after_cents::text AS source_after,destination_before_cents::text AS destination_before,destination_after_cents::text AS destination_after,authorization_snapshot FROM finance_self_purchase_reversal WHERE finance_document_id=$1::uuid", [documentId])).rows[0];
    assert.equal(reversal.actor_subject_code, "SYSTEM_ADMIN"); assert.equal(reversal.actor_scope_type, "GLOBAL");
    assert.deepEqual([reversal.source_before, reversal.source_after, reversal.destination_before, reversal.destination_after], ["900", "1000", "-30", "-130"]);
    assert.equal(reversal.authorization_snapshot.processingMode, "MANUAL");
    assert.equal((await db.pool.query("SELECT details_json FROM finance_document_event WHERE finance_document_id=$1::uuid AND event_type='TRANSFER_REVERSED'", [documentId])).rows[0].details_json.processingMode, "MANUAL");
    assert.deepEqual(await reversals.reverse(globalAdmin(adminId), documentId, { expectedVersion: 2, reason: "采购退货" }, "reverse", new Date("2027-09-01T00:00:00Z")), { ...reversed, replay: true });
    await assert.rejects(reversals.reverse(globalAdmin(adminId), documentId, { expectedVersion: 2, reason: "改写" }, "reverse", at), /IDEMPOTENCY_REPLAY/);
    await assert.rejects(reversals.reverse(globalHq(randomUUID()), documentId, { expectedVersion: 3, reason: "再次撤销" }, "second", at), /SELF_PURCHASE_STATE_CONFLICT/);
    await assert.rejects(db.pool.query("UPDATE finance_self_purchase_reversal SET reason='篡改' WHERE finance_document_id=$1::uuid", [documentId]), /FINANCE_SELF_PURCHASE_IMMUTABLE/);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("采买撤销遇原始账本、余额投影或反向孤儿事件损坏时完整回滚", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-self-purchase-reversal-invalid-"));
  try {
    const [teacherId, adminId] = [randomUUID(), randomUUID()];
    await addPerson(db.pool, teacherId, "reverse-invalid-teacher"); await addPerson(db.pool, adminId, "reverse-invalid-admin");
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const purchases = new PostgresSelfPurchaseService(db.pool, store); const reversals = new PostgresSelfPurchaseReversalService(db.pool);
    const accounts = await configure(db.pool, teacherId);
    const tamperedDocument = await completedPurchase(db.pool, store, purchases, teacherId, "tampered");
    const originalEvent = (await db.pool.query("SELECT ledger_event_id::text AS id FROM finance_self_purchase_transfer WHERE finance_document_id=$1::uuid", [tamperedDocument])).rows[0].id;
    await db.pool.query("ALTER TABLE ledger_entry DISABLE TRIGGER ledger_entry_immutable");
    await db.pool.query("UPDATE ledger_entry SET category_key='tampered' WHERE event_id=$1::uuid AND category_key='selfPurchaseIncome'", [originalEvent]);
    await db.pool.query("ALTER TABLE ledger_entry ENABLE TRIGGER ledger_entry_immutable");
    await assert.rejects(reversals.reverse(globalAdmin(adminId), tamperedDocument, { expectedVersion: 2, reason: "篡改账本" }, "tampered", at), /FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE/);
    assert.equal((await db.pool.query("SELECT status FROM finance_document WHERE id=$1::uuid", [tamperedDocument])).rows[0].status, "COMPLETED");

    const orphanDocument = await completedPurchase(db.pool, store, purchases, teacherId, "orphan");
    const orphanTransfer = (await db.pool.query(
      "SELECT ledger_event_id::text AS ledger_event_id,source_account_id::text AS source_account_id,destination_account_id::text AS destination_account_id FROM finance_self_purchase_transfer WHERE finance_document_id=$1::uuid", [orphanDocument]
    )).rows[0];
    const orphanPayload = {
      financeDocumentId: orphanDocument, originalLedgerEventId: orphanTransfer.ledger_event_id, sourceAccountId: orphanTransfer.source_account_id,
      destinationAccountId: orphanTransfer.destination_account_id, amountCents: "100", reason: "孤儿反向", processingMode: "MANUAL",
      actorSubjectCode: "SYSTEM_ADMIN", actorScopeType: "GLOBAL"
    };
    await postLedgerEvent(new PostgresLedgerRepository(db.pool), {
      eventKey: `self-purchase-reversal:${orphanDocument}`, eventType: "SELF_PURCHASE_TRANSFER_REVERSED", payloadHash: digest(JSON.stringify(orphanPayload)),
      deltas: [
        { accountKey: `company:fund:${accounts.fundId}`, categoryKey: "selfPurchaseExpenseReversal", amountCents: 100n },
        { accountKey: `person:${teacherId}`, categoryKey: "selfPurchaseIncomeReversal", amountCents: -100n }
      ]
    }, randomUUID);
    const orphanBalances = [await balance(db.pool, accounts.sourceAccountId), await balance(db.pool, accounts.destinationAccountId)];
    await assert.rejects(reversals.reverse(globalAdmin(adminId), orphanDocument, { expectedVersion: 2, reason: "孤儿反向" }, "orphan", at), /FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE/);
    assert.deepEqual([await balance(db.pool, accounts.sourceAccountId), await balance(db.pool, accounts.destinationAccountId)], orphanBalances, "既有同键孤儿账本不得伪造撤销或二次变更余额");
    assert.equal((await db.pool.query("SELECT status FROM finance_document WHERE id=$1::uuid", [orphanDocument])).rows[0].status, "COMPLETED");
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM finance_self_purchase_reversal WHERE finance_document_id=$1::uuid", [orphanDocument])).rows[0].count, 0);

    const originalSourceCode = `company:fund:${accounts.fundId}`;
    await db.pool.query("UPDATE settlement_account SET account_code=$2 WHERE id=$1::uuid", [accounts.sourceAccountId, `damaged:${accounts.fundId}`]);
    await assert.rejects(reversals.reverse(globalAdmin(adminId), orphanDocument, { expectedVersion: 2, reason: "代码损坏" }, "damaged-code", at), /FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE/);
    await db.pool.query("UPDATE settlement_account SET account_code=$2 WHERE id=$1::uuid", [accounts.sourceAccountId, originalSourceCode]);

    const snapshotDocument = await completedPurchase(db.pool, store, purchases, teacherId, "bad-context-snapshot");
    await db.pool.query("ALTER TABLE finance_self_purchase_transfer DISABLE TRIGGER USER");
    await db.pool.query("UPDATE finance_self_purchase_transfer SET authorization_snapshot=jsonb_set(authorization_snapshot,'{applicantContextVenueId}','\"not-a-uuid\"'::jsonb,true) WHERE finance_document_id=$1::uuid", [snapshotDocument]);
    await db.pool.query("ALTER TABLE finance_self_purchase_transfer ENABLE TRIGGER USER");
    await assert.rejects(reversals.reverse(globalAdmin(adminId), snapshotDocument, { expectedVersion: 2, reason: "快照资源损坏" }, "bad-context-snapshot", at), /FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE/);
    assert.equal((await db.pool.query("SELECT status FROM finance_document WHERE id=$1::uuid", [snapshotDocument])).rows[0].status, "COMPLETED");

    const missingProjectionDocument = await completedPurchase(db.pool, store, purchases, teacherId, "missing-projection");
    await db.pool.query("DELETE FROM account_balance_projection WHERE account_id=$1::uuid", [accounts.destinationAccountId]);
    await assert.rejects(reversals.reverse(globalAdmin(adminId), missingProjectionDocument, { expectedVersion: 2, reason: "缺投影" }, "missing-projection", at), /FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE/);
    assert.equal((await db.pool.query("SELECT status FROM finance_document WHERE id=$1::uuid", [missingProjectionDocument])).rows[0].status, "COMPLETED");
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("同键与跨办理人并发撤销只产生一笔反向账本，末端失败回滚全部状态", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-self-purchase-reversal-concurrent-"));
  try {
    const [teacherId, firstAdminId, secondAdminId] = [randomUUID(), randomUUID(), randomUUID()];
    await addPerson(db.pool, teacherId, "reverse-concurrent-teacher");
    await addPerson(db.pool, firstAdminId, "reverse-concurrent-admin-one");
    await addPerson(db.pool, secondAdminId, "reverse-concurrent-admin-two");
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const purchases = new PostgresSelfPurchaseService(db.pool, store); const reversals = new PostgresSelfPurchaseReversalService(db.pool);
    const accounts = await configure(db.pool, teacherId);

    const sameKeyDocument = await completedPurchase(db.pool, store, purchases, teacherId, "same-key-complete");
    const sameKey = await Promise.all([
      reversals.reverse(globalAdmin(firstAdminId), sameKeyDocument, { expectedVersion: 2, reason: "同键并发" }, "same-key", at),
      reversals.reverse(globalAdmin(firstAdminId), sameKeyDocument, { expectedVersion: 2, reason: "同键并发" }, "same-key", at)
    ]);
    assert.equal(new Set(sameKey.map((value) => value.version)).size, 1);
    assert.deepEqual(sameKey.map((value) => value.replay).sort(), [false, true]);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM finance_self_purchase_reversal WHERE finance_document_id=$1::uuid", [sameKeyDocument])).rows[0].count, 1);

    const differentKeyDocument = await completedPurchase(db.pool, store, purchases, teacherId, "different-key-complete");
    const differentKey = await Promise.allSettled([
      reversals.reverse(globalAdmin(firstAdminId), differentKeyDocument, { expectedVersion: 2, reason: "跨办理人并发" }, "one", at),
      reversals.reverse(globalHq(secondAdminId), differentKeyDocument, { expectedVersion: 2, reason: "跨办理人并发" }, "two", at)
    ]);
    assert.equal(differentKey.filter((value) => value.status === "fulfilled").length, 1);
    assert.equal(differentKey.filter((value) => value.status === "rejected").length, 1);
    const rejected = differentKey.find((value) => value.status === "rejected");
    assert.match(String(rejected.reason), /SELF_PURCHASE_STATE_CONFLICT/);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM finance_self_purchase_reversal WHERE finance_document_id=$1::uuid", [differentKeyDocument])).rows[0].count, 1);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM ledger_event WHERE event_key=$1", [`self-purchase-reversal:${differentKeyDocument}`])).rows[0].count, 1);

    const rollbackDocument = await completedPurchase(db.pool, store, purchases, teacherId, "rollback-complete");
    const before = [await balance(db.pool, accounts.sourceAccountId), await balance(db.pool, accounts.destinationAccountId)];
    await db.pool.query("CREATE FUNCTION force_self_purchase_reversal_insert_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST_REVERSAL_INSERT_FAILURE'; END; $$");
    await db.pool.query("CREATE TRIGGER force_self_purchase_reversal_insert_failure BEFORE INSERT ON finance_self_purchase_reversal FOR EACH ROW EXECUTE FUNCTION force_self_purchase_reversal_insert_failure()");
    await assert.rejects(reversals.reverse(globalAdmin(firstAdminId), rollbackDocument, { expectedVersion: 2, reason: "末端失败" }, "rollback", at), /TEST_REVERSAL_INSERT_FAILURE/);
    assert.deepEqual([await balance(db.pool, accounts.sourceAccountId), await balance(db.pool, accounts.destinationAccountId)], before);
    assert.equal((await db.pool.query("SELECT status FROM finance_document WHERE id=$1::uuid", [rollbackDocument])).rows[0].status, "COMPLETED");
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM ledger_event WHERE event_key=$1", [`self-purchase-reversal:${rollbackDocument}`])).rows[0].count, 0);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("0018 已完成的采买升级到 0019 后可在下一财年由全局办理人撤销", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL, { throughMigration: 18 });
  const root = await mkdtemp(join(tmpdir(), "alliance-self-purchase-reversal-upgrade-"));
  try {
    const [teacherId, adminId] = [randomUUID(), randomUUID()];
    await addPerson(db.pool, teacherId, "reverse-upgrade-teacher"); await addPerson(db.pool, adminId, "reverse-upgrade-admin");
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const purchases = new PostgresSelfPurchaseService(db.pool, store);
    await configure(db.pool, teacherId);
    const documentId = await completedPurchase(db.pool, store, purchases, teacherId, "pre-0019-complete");
    await db.pool.query(await readFile(new URL("../../../../database/migrations/0019_self_purchase_reversal.sql", import.meta.url), "utf8"));
    const reversals = new PostgresSelfPurchaseReversalService(db.pool);
    assert.deepEqual(await reversals.reverse(globalAdmin(adminId), documentId, { expectedVersion: 2, reason: "跨财年历史冲回" }, "upgrade-reverse", new Date("2027-09-21T09:00:00.000Z")),
      { id: documentId, status: "REVERSED", version: 3, replay: false });
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
