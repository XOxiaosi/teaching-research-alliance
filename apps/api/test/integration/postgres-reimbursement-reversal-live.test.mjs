import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { postLedgerEvent } from "@teaching-research-alliance/domain";
import { PostgresCompanyFundService } from "../../dist/postgres-company-fund-service.js";
import { LocalAttachmentStore } from "../../dist/local-attachment-store.js";
import { PostgresLedgerRepository } from "../../dist/postgres-ledger-repository.js";
import { PostgresReimbursementReversalService } from "../../dist/postgres-reimbursement-reversal-service.js";
import { PostgresReimbursementSubmissionService } from "../../dist/postgres-reimbursement-submission-service.js";
import { PostgresReimbursementReviewService } from "../../dist/postgres-reimbursement-review-service.js";
import { PostgresReimbursementTransferService } from "../../dist/postgres-reimbursement-transfer-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const at = new Date("2026-09-21T09:00:00.000Z");
const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 99) });
const sha = createHash("sha256").update(png).digest("hex");
const chunks = (bytes) => (async function* () { yield bytes; })();
const context = (personId, subject = "HEADQUARTERS_FINANCE", scope = "GLOBAL") => ({ subject, personId, scope });
const personal = (personId) => context(personId, "TEACHING_TEACHER", "SELF");

const addPerson = (pool, id, nickname) => pool.query(
  "INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,'合成人员','ACTIVE')", [id, nickname],
);
const addAccount = async (pool, ownerType, ownerId, code, balance, status = "ACTIVE") => {
  const id = randomUUID();
  await pool.query("INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,$2,$3::uuid,$4,$5)", [id, ownerType, ownerId, code, status]);
  await pool.query("INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1::uuid,$2::bigint)", [id, String(balance)]);
  return id;
};
const addGlobalRole = (pool, personId, subject, from = new Date("2026-01-01T00:00:00.000Z")) => pool.query(
  "INSERT INTO role_assignment(id,person_id,subject_code,scope_type,scope_id,valid_from,valid_to,created_by,created_at) VALUES($1::uuid,$2::uuid,$3,'GLOBAL',NULL,$4::timestamptz,NULL,$2::uuid,$4::timestamptz)",
  [randomUUID(), personId, subject, from.toISOString()],
);
const addEvidence = async (pool, store, documentId, purpose) => {
  const attachmentId = randomUUID(), versionId = randomUUID();
  await store.put({ versionId, originalFilename: `${purpose}.png`, declaredMediaType: "image/png", declaredSizeBytes: png.length, expectedSha256: sha }, chunks(png));
  await pool.query("INSERT INTO finance_attachment(id,finance_document_id,purpose,created_by_person_id,created_at) SELECT $1::uuid,$2::uuid,$3,applicant_person_id,$4::timestamptz FROM finance_document WHERE id=$2::uuid", [attachmentId, documentId, purpose, at.toISOString()]);
  await pool.query(`INSERT INTO finance_attachment_version(id,finance_attachment_id,version_no,status,original_filename,declared_media_type,declared_size_bytes,expected_sha256,detected_media_type,actual_size_bytes,sha256,uploaded_by_person_id,created_at,ready_at)
    SELECT $1::uuid,$2::uuid,1,'READY',$3,'image/png',$4::bigint,$5,'image/png',$4::bigint,$5,applicant_person_id,$6::timestamptz,$6::timestamptz FROM finance_document WHERE id=$7::uuid`,
  [versionId, attachmentId, `${purpose}.png`, png.length, sha, at.toISOString(), documentId]);
  return versionId;
};

const fixture = async (pool, store, amountCents = "100") => {
  const applicantId = randomUUID(), financeId = randomUUID(), adminId = randomUUID(), ownerId = randomUUID();
  const suffix = applicantId.slice(0, 8);
  await Promise.all([
    addPerson(pool, applicantId, `reversal-applicant-${suffix}`), addPerson(pool, financeId, `reversal-finance-${suffix}`),
    addPerson(pool, adminId, `reversal-admin-${suffix}`), addPerson(pool, ownerId, `reversal-owner-${suffix}`),
  ]);
  await Promise.all([
    addGlobalRole(pool, financeId, "HEADQUARTERS_FINANCE"), addGlobalRole(pool, adminId, "SYSTEM_ADMIN"), addGlobalRole(pool, ownerId, "SYSTEM_OWNER"),
  ]);
  const existingFund = (await pool.query(`SELECT assignment.id::text AS assignment_id,assignment.fund_id::text AS fund_id,account.id::text AS account_id
    FROM company_finance_fund_assignment assignment JOIN settlement_account account ON account.owner_type='COMPANY' AND account.owner_id=assignment.fund_id
    WHERE assignment.duty_subject='HEADQUARTERS_FINANCE' AND assignment.scope_type='GLOBAL' AND assignment.scope_id IS NULL
      AND assignment.responsibility_code='FINANCE_OPERATING_SOURCE' AND assignment.valid_to IS NULL`)).rows[0];
  const fundId = existingFund?.fund_id ?? randomUUID();
  let sourceAccountId = existingFund?.account_id;
  let assignmentId = existingFund?.assignment_id;
  if (sourceAccountId === undefined || assignmentId === undefined) {
    await pool.query("INSERT INTO company_finance_fund(id,kind,fund_code,display_name,status,version,created_by_person_id,created_at,updated_at) VALUES($1::uuid,'HEADQUARTERS_FINANCE_OPERATING',$2,'报销撤销资金','ACTIVE',1,$3::uuid,$4::timestamptz,$4::timestamptz)", [fundId, `REV_${fundId.replaceAll('-', '').slice(0, 18).toUpperCase()}`, financeId, at.toISOString()]);
    sourceAccountId = await addAccount(pool, "COMPANY", fundId, `company:fund:${fundId}`, 1000);
    assignmentId = randomUUID();
    await pool.query("INSERT INTO company_finance_fund_assignment(id,fund_id,duty_subject,scope_type,scope_id,responsibility_code,valid_from,valid_to,created_by_person_id,created_at) VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'FINANCE_OPERATING_SOURCE',$3::timestamptz,NULL,$4::uuid,$3::timestamptz)", [assignmentId, fundId, new Date("2026-01-01T00:00:00Z").toISOString(), financeId]);
  }
  const destinationAccountId = await addAccount(pool, "PERSON", applicantId, `person:${applicantId}`, 20);
  const documentId = randomUUID();
  await pool.query("INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at) VALUES($1::uuid,$2::uuid,'REIMBURSEMENT','DRAFT',1,$3::timestamptz,$3::timestamptz)", [documentId, applicantId, at.toISOString()]);
  await pool.query("INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,created_at) VALUES($1::uuid,'CREATED',$2::uuid,1,$3::timestamptz)", [documentId, applicantId, at.toISOString()]);
  const attachmentVersionIds = await Promise.all([addEvidence(pool, store, documentId, "SUPPORTING_DOCUMENT"), addEvidence(pool, store, documentId, "APPLICATION_SCREENSHOT")]);
  await new PostgresReimbursementSubmissionService(pool, store).submit(personal(applicantId), documentId, { expectedVersion: 1, amountCents, reason: "普通报销撤销测试", attachmentVersionIds }, `submit-${documentId}`, at);
  await new PostgresReimbursementReviewService(pool, store).approve(context(financeId), documentId, { expectedVersion: 2, reason: "审核通过" }, `approve-${documentId}`, at);
  await new PostgresReimbursementTransferService(pool, store).execute(context(financeId), documentId, { expectedVersion: 3 }, `execute-${documentId}`, at);
  return { applicantId, financeId, adminId, ownerId, fundId, assignmentId, sourceAccountId, destinationAccountId, documentId };
};
const balance = async (pool, id) => (await pool.query("SELECT balance_cents::text AS value FROM account_balance_projection WHERE account_id=$1::uuid", [id])).rows[0]?.value;

test("普通报销撤销反向原始两账户，保留可追溯事件、四分录并支持三种全局权限", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL); const root = await mkdtemp(join(tmpdir(), "alliance-reimbursement-reversal-"));
  try {
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const f = await fixture(db.pool, store);
    await postLedgerEvent(new PostgresLedgerRepository(db.pool), { eventKey: `synthetic-personal-spend:${f.documentId}`, eventType: "SYNTHETIC_PERSONAL_SPEND", payloadHash: "synthetic-personal-spend", deltas: [{ accountKey: `person:${f.applicantId}`, categoryKey: "syntheticPersonalSpend", amountCents: -50n }] }, randomUUID);
    assert.deepEqual([await balance(db.pool, f.sourceAccountId), await balance(db.pool, f.destinationAccountId)], ["900", "70"]);
    const service = new PostgresReimbursementReversalService(db.pool);
    await db.pool.query("UPDATE settlement_account SET status='INACTIVE' WHERE id=ANY($1::uuid[])", [[f.sourceAccountId, f.destinationAccountId]]);
    const result = await service.reverse(context(f.financeId), f.documentId, { expectedVersion: 4, reason: "撤销普通报销" }, "reverse-1", at);
    assert.deepEqual(result, { id: f.documentId, status: "REVERSED", version: 5, replay: false });
    assert.deepEqual([await balance(db.pool, f.sourceAccountId), await balance(db.pool, f.destinationAccountId)], ["1000", "-30"]);
    const doc = (await db.pool.query("SELECT status,version FROM finance_document WHERE id=$1::uuid", [f.documentId])).rows[0];
    assert.deepEqual(doc, { status: "REVERSED", version: "5" });
    const reversal = (await db.pool.query("SELECT * FROM finance_reimbursement_reversal WHERE finance_document_id=$1::uuid", [f.documentId])).rows[0];
    assert.equal(reversal.source_document_version, "4"); assert.equal(reversal.result_document_version, "5"); assert.equal(reversal.amount_cents, "100");
    assert.deepEqual([reversal.source_before_cents, reversal.source_after_cents, reversal.destination_before_cents, reversal.destination_after_cents], ["900", "1000", "70", "-30"]);
    assert.equal(reversal.authorization_snapshot.processingMode, "MANUAL");
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM ledger_event WHERE event_key=$1", [`reimbursement-reversal:${f.documentId}`])).rows[0].count, 1);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM ledger_entry WHERE event_id IN ((SELECT ledger_event_id FROM finance_reimbursement_transfer WHERE finance_document_id=$1::uuid),(SELECT reversal_ledger_event_id FROM finance_reimbursement_reversal WHERE finance_document_id=$1::uuid))", [f.documentId])).rows[0].count, 4);
    assert.deepEqual((await db.pool.query("SELECT category_key,amount_cents::text AS amount FROM ledger_entry WHERE event_id=$1::uuid ORDER BY category_key", [reversal.reversal_ledger_event_id])).rows, [
      { category_key: "reimbursementExpenseReversal", amount: "100" }, { category_key: "reimbursementIncomeReversal", amount: "-100" },
    ]);
    await assert.rejects(db.pool.query(
      "INSERT INTO finance_reimbursement_command_idempotency(actor_person_id,operation,idempotency_key,request_hash,finance_document_id,result_status,result_document_version,created_at) VALUES($1::uuid,'REVERSE','late-command',$2,$3::uuid,'REVERSED',5,$4::timestamptz)",
      [f.adminId, "a".repeat(64), f.documentId, new Date(at.getTime() + 1).toISOString()],
    ), /FINANCE_REIMBURSEMENT_TERMINAL_IMMUTABLE|finance_reimbursement_reverse_command_once/);
    await assert.rejects(db.pool.query(
      "INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,created_at) VALUES($1::uuid,'REIMBURSEMENT_COMPLETED',$2::uuid,5,$3::timestamptz)",
      [f.documentId, f.adminId, new Date(at.getTime() + 1).toISOString()],
    ), /FINANCE_REIMBURSEMENT_TERMINAL_IMMUTABLE/);
    await assert.rejects(db.pool.query(
      "INSERT INTO ledger_entry(event_id,account_id,category_key,amount_cents) VALUES($1::uuid,$2::uuid,'lateCorruption',1)",
      [reversal.reversal_ledger_event_id, f.sourceAccountId],
    ), /FINANCE_REIMBURSEMENT_LEDGER_IMMUTABLE/);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("普通报销撤销权限、幂等与并发只允许一次，原始快照损坏和末端失败完整回滚", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL); const root = await mkdtemp(join(tmpdir(), "alliance-reimbursement-reversal-boundary-"));
  try {
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../..")); const service = new PostgresReimbursementReversalService(db.pool);
    const f = await fixture(db.pool, store);
    for (const denied of [personal(f.applicantId), context(f.financeId, "REGION_FINANCE", "REGION")]) await assert.rejects(service.reverse(denied, f.documentId, { expectedVersion: 4, reason: "越权" }, `denied-${denied.subject}`, at), /FORBIDDEN_SCOPE/);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM finance_reimbursement_reversal")).rows[0].count, 0);
    const same = await Promise.all([service.reverse(context(f.financeId), f.documentId, { expectedVersion: 4, reason: "同键" }, "same", at), service.reverse(context(f.financeId), f.documentId, { expectedVersion: 4, reason: "同键" }, "same", at)]);
    assert.deepEqual(same.map((x) => x.replay).sort(), [false, true]);
    await assert.rejects(service.reverse(context(f.financeId), f.documentId, { expectedVersion: 4, reason: "改payload" }, "same", at), /IDEMPOTENCY_REPLAY/);
    await assert.rejects(service.reverse(context(f.ownerId), f.documentId, { expectedVersion: 5, reason: "二次" }, "other", at), /REIMBURSEMENT_STATE_CONFLICT/);
    const adminDocument = await fixture(db.pool, store);
    assert.deepEqual(await service.reverse(context(adminDocument.adminId, "SYSTEM_ADMIN"), adminDocument.documentId, { expectedVersion: 4, reason: "管理员撤销" }, "admin-reverse", at), { id: adminDocument.documentId, status: "REVERSED", version: 5, replay: false });
    const concurrentDocument = await fixture(db.pool, store);
    const concurrent = await Promise.allSettled([
      service.reverse(context(concurrentDocument.financeId), concurrentDocument.documentId, { expectedVersion: 4, reason: "并发财务撤销" }, "concurrent-finance", at),
      service.reverse(context(concurrentDocument.adminId, "SYSTEM_ADMIN"), concurrentDocument.documentId, { expectedVersion: 4, reason: "并发管理员撤销" }, "concurrent-admin", at),
    ]);
    assert.equal(concurrent.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter((item) => item.status === "rejected" && /REIMBURSEMENT_STATE_CONFLICT/.test(String(item.reason))).length, 1);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM finance_reimbursement_reversal WHERE finance_document_id=$1::uuid", [concurrentDocument.documentId])).rows[0].count, 1);
    const f2 = await fixture(db.pool, store); const before = [await balance(db.pool, f2.sourceAccountId), await balance(db.pool, f2.destinationAccountId)];
    await db.pool.query("ALTER TABLE finance_reimbursement_transfer DISABLE TRIGGER USER");
    await db.pool.query("UPDATE finance_reimbursement_transfer SET authorization_snapshot=jsonb_set(authorization_snapshot,'{sourceAccountId}','\"broken\"'::jsonb,true) WHERE finance_document_id=$1::uuid", [f2.documentId]);
    await db.pool.query("ALTER TABLE finance_reimbursement_transfer ENABLE TRIGGER USER");
    await assert.rejects(service.reverse(context(f2.ownerId), f2.documentId, { expectedVersion: 4, reason: "快照损坏" }, "broken", at), /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/);
    assert.deepEqual([await balance(db.pool, f2.sourceAccountId), await balance(db.pool, f2.destinationAccountId)], before);

    const missingKey = await fixture(db.pool, store); const missingKeyBefore = [await balance(db.pool, missingKey.sourceAccountId), await balance(db.pool, missingKey.destinationAccountId)];
    await db.pool.query("CREATE FUNCTION strip_reimbursement_reversal_actor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.authorization_snapshot=NEW.authorization_snapshot-'actorPersonId'; RETURN NEW; END; $$");
    await db.pool.query("CREATE TRIGGER aaa_strip_reimbursement_reversal_actor BEFORE INSERT ON finance_reimbursement_reversal FOR EACH ROW EXECUTE FUNCTION strip_reimbursement_reversal_actor()");
    await assert.rejects(service.reverse(context(missingKey.adminId, "SYSTEM_ADMIN"), missingKey.documentId, { expectedVersion: 4, reason: "缺字段应拒绝" }, "missing-key", at), /FINANCE_REIMBURSEMENT_REVERSAL_INVALID/);
    assert.deepEqual([await balance(db.pool, missingKey.sourceAccountId), await balance(db.pool, missingKey.destinationAccountId)], missingKeyBefore);
    assert.deepEqual((await db.pool.query("SELECT status,version FROM finance_document WHERE id=$1::uuid", [missingKey.documentId])).rows[0], { status: "COMPLETED", version: "4" });
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM finance_reimbursement_command_idempotency WHERE finance_document_id=$1::uuid AND operation='REVERSE'", [missingKey.documentId])).rows[0].count, 0);
    await db.pool.query("DROP TRIGGER aaa_strip_reimbursement_reversal_actor ON finance_reimbursement_reversal");
    await db.pool.query("DROP FUNCTION strip_reimbursement_reversal_actor()");

    const rollbackDocument = await fixture(db.pool, store); const rollbackBefore = [await balance(db.pool, rollbackDocument.sourceAccountId), await balance(db.pool, rollbackDocument.destinationAccountId)];
    await db.pool.query("CREATE FUNCTION force_reimbursement_reversal_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST_REVERSAL_INSERT_FAILURE'; END; $$");
    await db.pool.query("CREATE TRIGGER force_reimbursement_reversal_failure BEFORE INSERT ON finance_reimbursement_reversal FOR EACH ROW EXECUTE FUNCTION force_reimbursement_reversal_failure()");
    await assert.rejects(service.reverse(context(rollbackDocument.adminId, "SYSTEM_ADMIN"), rollbackDocument.documentId, { expectedVersion: 4, reason: "末端失败" }, "rollback", at), /TEST_REVERSAL_INSERT_FAILURE/);
    assert.deepEqual([await balance(db.pool, rollbackDocument.sourceAccountId), await balance(db.pool, rollbackDocument.destinationAccountId)], rollbackBefore);
    assert.deepEqual((await db.pool.query("SELECT status,version FROM finance_document WHERE id=$1::uuid", [rollbackDocument.documentId])).rows[0], { status: "COMPLETED", version: "4" });
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM ledger_event WHERE event_key=$1", [`reimbursement-reversal:${rollbackDocument.documentId}`])).rows[0].count, 0);
    await db.pool.query("DROP TRIGGER force_reimbursement_reversal_failure ON finance_reimbursement_reversal");
    await db.pool.query("DROP FUNCTION force_reimbursement_reversal_failure()");

    const missingProjection = await fixture(db.pool, store);
    await db.pool.query("DELETE FROM account_balance_projection WHERE account_id=$1::uuid", [missingProjection.destinationAccountId]);
    await assert.rejects(service.reverse(context(missingProjection.ownerId, "SYSTEM_OWNER"), missingProjection.documentId, { expectedVersion: 4, reason: "投影缺失" }, "missing-projection", at), /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM account_balance_projection WHERE account_id=$1::uuid", [missingProjection.destinationAccountId])).rows[0].count, 0);
    assert.deepEqual((await db.pool.query("SELECT status,version FROM finance_document WHERE id=$1::uuid", [missingProjection.documentId])).rows[0], { status: "COMPLETED", version: "4" });

    const fakeActorDocument = await fixture(db.pool, store); const fakeActorId = randomUUID();
    await addPerson(db.pool, fakeActorId, `reversal-fake-${fakeActorId.slice(0, 8)}`);
    const fakeBefore = [await balance(db.pool, fakeActorDocument.sourceAccountId), await balance(db.pool, fakeActorDocument.destinationAccountId)];
    await assert.rejects(service.reverse(context(fakeActorId, "SYSTEM_ADMIN"), fakeActorDocument.documentId, { expectedVersion: 4, reason: "伪造管理员" }, "fake-actor", at), /FINANCE_REIMBURSEMENT_REVERSAL_INVALID/);
    assert.deepEqual([await balance(db.pool, fakeActorDocument.sourceAccountId), await balance(db.pool, fakeActorDocument.destinationAccountId)], fakeBefore);

    const nakedDocument = await fixture(db.pool, store); const direct = await db.pool.connect();
    try {
      await direct.query("BEGIN");
      await direct.query("UPDATE finance_document SET status='REVERSED',version=5,updated_at=$2::timestamptz WHERE id=$1::uuid", [nakedDocument.documentId, at.toISOString()]);
      await assert.rejects(direct.query("COMMIT"), /FINANCE_REIMBURSEMENT_REVERSED_INCOMPLETE/);
    } finally { direct.release(); }
    assert.deepEqual((await db.pool.query("SELECT status,version FROM finance_document WHERE id=$1::uuid", [nakedDocument.documentId])).rows[0], { status: "COMPLETED", version: "4" });
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("普通报销原执行授权在合法资金切换和任命闭合后仍可按原账户撤销", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL); const root = await mkdtemp(join(tmpdir(), "alliance-reimbursement-reversal-history-"));
  try {
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../..")); const f = await fixture(db.pool, store);
    const funds = new PostgresCompanyFundService(db.pool);
    const closeAt = new Date(at.getTime() + 60_000);
    const nextFund = await funds.create(context(f.adminId, "SYSTEM_ADMIN"), {
      fundCode: `NEXT_${f.fundId.replaceAll("-", "").slice(0, 18).toUpperCase()}`,
      displayName: "报销撤销后继资金",
    }, `next-fund-${f.documentId}`, new Date(at.getTime() + 30_000));
    const successor = await funds.assign(context(f.adminId, "SYSTEM_ADMIN"), {
      fundId: nextFund.id,
      expectedAssignmentId: f.assignmentId,
      reason: "合法切换报销资金",
    }, `next-assignment-${f.documentId}`, closeAt);
    assert.equal(successor.previousAssignmentId, f.assignmentId);
    await db.pool.query("UPDATE role_assignment SET valid_to=$2::timestamptz WHERE person_id=$1::uuid AND subject_code='HEADQUARTERS_FINANCE' AND scope_type='GLOBAL'", [f.financeId, new Date(at.getTime() + 90_000).toISOString()]);
    const result = await new PostgresReimbursementReversalService(db.pool).reverse(
      context(f.adminId, "SYSTEM_ADMIN"), f.documentId, { expectedVersion: 4, reason: "历史授权闭合后撤销" }, "history-reverse", new Date(at.getTime() + 120_000),
    );
    assert.deepEqual(result, { id: f.documentId, status: "REVERSED", version: 5, replay: false });
    const reversal = (await db.pool.query("SELECT source_account_id::text AS source_account_id,authorization_snapshot FROM finance_reimbursement_reversal WHERE finance_document_id=$1::uuid", [f.documentId])).rows[0];
    assert.equal(reversal.source_account_id, f.sourceAccountId);
    assert.equal(reversal.authorization_snapshot.originalTransferAuthorization.companyFundAssignmentId, f.assignmentId);
    assert.deepEqual([await balance(db.pool, f.sourceAccountId), await balance(db.pool, f.destinationAccountId)], ["1000", "20"]);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("跨财年撤销使用原执行财年，且首次跨年执行仍由既有 execute 回归负责", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL); const root = await mkdtemp(join(tmpdir(), "alliance-reimbursement-reversal-cross-year-"));
  try {
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../..")); const f = await fixture(db.pool, store);
    const result = await new PostgresReimbursementReversalService(db.pool).reverse(context(f.ownerId, "SYSTEM_OWNER"), f.documentId, { expectedVersion: 4, reason: "跨财年冲回" }, "cross-year", new Date("2027-01-02T09:00:00Z"));
    assert.deepEqual(result, { id: f.documentId, status: "REVERSED", version: 5, replay: false });
    const entries = (await db.pool.query("SELECT category_key,amount_cents::text AS amount FROM ledger_entry WHERE account_id=$1::uuid ORDER BY category_key", [f.destinationAccountId])).rows;
    assert.deepEqual(entries, [{ category_key: "reimbursementIncome", amount: "100" }, { category_key: "reimbursementIncomeReversal", amount: "-100" }]);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
