import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LocalAttachmentStore } from "../../dist/local-attachment-store.js";
import { PostgresReimbursementSubmissionService } from "../../dist/postgres-reimbursement-submission-service.js";
import { PostgresReimbursementReviewService } from "../../dist/postgres-reimbursement-review-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const at = new Date("2026-09-21T09:00:00.000Z");
const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 57) });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const chunks = (bytes) => (async function* () { yield bytes; })();
const personal = (personId) => ({ subject: "ACADEMIC_PLANNER", personId, scope: "ASSOCIATED_TEACHERS" });
const hq = (personId) => ({ subject: "HEADQUARTERS_FINANCE", personId, scope: "GLOBAL" });
const addPerson = (pool, id, nickname) => pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,'合成人员','ACTIVE')", [id, nickname]);
const addAccount = async (pool, personId) => {
  const id = randomUUID();
  await pool.query("INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,'PERSON',$2::uuid,$3,'ACTIVE')", [id, personId, `person:${personId}`]);
  await pool.query("INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1::uuid,20)", [id]);
  return id;
};
const addDocument = async (pool, personId) => {
  const id = randomUUID();
  await pool.query("INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at) VALUES($1::uuid,$2::uuid,'REIMBURSEMENT','DRAFT',1,$3::timestamptz,$3::timestamptz)", [id, personId, at.toISOString()]);
  return id;
};
const addReady = async (pool, store, documentId, purpose) => {
  const attachmentId = randomUUID(), versionId = randomUUID(), sha = digest(png);
  await store.put({ versionId, originalFilename: `${purpose}.png`, declaredMediaType: "image/png", declaredSizeBytes: png.length, expectedSha256: sha }, chunks(png));
  await pool.query("INSERT INTO finance_attachment(id,finance_document_id,purpose,created_by_person_id,created_at) SELECT $1::uuid,$2::uuid,$3,applicant_person_id,$4::timestamptz FROM finance_document WHERE id=$2::uuid", [attachmentId, documentId, purpose, at.toISOString()]);
  await pool.query(
    `INSERT INTO finance_attachment_version(id,finance_attachment_id,version_no,status,original_filename,declared_media_type,declared_size_bytes,expected_sha256,detected_media_type,actual_size_bytes,sha256,uploaded_by_person_id,created_at,ready_at)
     SELECT $1::uuid,$2::uuid,1,'READY',$3,'image/png',$4::bigint,$5,'image/png',$4::bigint,$5,applicant_person_id,$6::timestamptz,$6::timestamptz FROM finance_document WHERE id=$7::uuid`,
    [versionId, attachmentId, `${purpose}.png`, png.length, sha, at.toISOString(), documentId]
  );
  return versionId;
};
const submitted = async (pool, store, submitter, personId, key = randomUUID()) => {
  const id = await addDocument(pool, personId);
  const ids = [await addReady(pool, store, id, "SUPPORTING_DOCUMENT"), await addReady(pool, store, id, "APPLICATION_SCREENSHOT")];
  await submitter.submit(personal(personId), id, { expectedVersion: 1, amountCents: "100", reason: "报销审核测试", attachmentVersionIds: ids }, key, at);
  return { id, ids };
};

test("总部财务人工批准冻结决定但不执行报销划拨，财务本人可切换总部角色自审", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-reimbursement-review-"));
  try {
    const [personId, hqId, adminId] = [randomUUID(), randomUUID(), randomUUID()];
    await addPerson(db.pool, personId, "reimbursement-review-applicant"); await addPerson(db.pool, hqId, "reimbursement-review-hq"); await addPerson(db.pool, adminId, "reimbursement-review-admin");
    const accountId = await addAccount(db.pool, personId);
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const submissions = new PostgresReimbursementSubmissionService(db.pool, store), reviews = new PostgresReimbursementReviewService(db.pool, store);
    const first = await submitted(db.pool, store, submissions, personId, "first-submit");
    await assert.rejects(reviews.approve(personal(personId), first.id, { expectedVersion: 2, reason: "越权" }, "personal", at), /FORBIDDEN_SCOPE/);
    await assert.rejects(reviews.approve({ subject: "SYSTEM_ADMIN", personId: adminId, scope: "GLOBAL" }, first.id, { expectedVersion: 2, reason: "管理员非财务" }, "admin", at), /FORBIDDEN_SCOPE/);
    const before = await db.pool.query("SELECT balance_cents::text AS balance FROM account_balance_projection WHERE account_id=$1::uuid", [accountId]);
    const approved = await reviews.approve(hq(hqId), first.id, { expectedVersion: 2, reason: "单据合规" }, "approve", at);
    assert.deepEqual(approved, { id: first.id, status: "APPROVED", version: 3, replay: false });
    assert.deepEqual(await reviews.approve(hq(hqId), first.id, { expectedVersion: 2, reason: "单据合规" }, "approve", new Date("2027-09-01T00:00:00Z")), { ...approved, replay: true });
    await assert.rejects(reviews.reject(hq(hqId), first.id, { expectedVersion: 3, reason: "不能重复审核" }, "reject-after-approve", at), /REIMBURSEMENT_STATE_CONFLICT/);
    assert.deepEqual(await db.pool.query("SELECT balance_cents::text AS balance FROM account_balance_projection WHERE account_id=$1::uuid", [accountId]), before);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM ledger_event")).rows[0].count, 0);
    const decision = (await db.pool.query("SELECT decision,actor_subject_code,actor_scope_type,authorization_snapshot FROM finance_reimbursement_decision WHERE finance_document_id=$1::uuid", [first.id])).rows[0];
    assert.deepEqual([decision.decision, decision.actor_subject_code, decision.actor_scope_type], ["APPROVED", "HEADQUARTERS_FINANCE", "GLOBAL"]);
    assert.equal(decision.authorization_snapshot.reviewerPersonId, hqId);
    assert.equal(decision.authorization_snapshot.submissionDocumentVersion, 2);
    await assert.rejects(db.pool.query("UPDATE finance_reimbursement_decision SET reason='篡改' WHERE finance_document_id=$1::uuid", [first.id]), /FINANCE_REIMBURSEMENT_IMMUTABLE/);

    await db.pool.query("INSERT INTO role_assignment(id,person_id,subject_code,scope_type,scope_id,valid_from,valid_to,created_by,created_at) VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,$3::timestamptz,NULL,$2::uuid,$3::timestamptz)", [randomUUID(), personId, at.toISOString()]);
    const selfReviewed = await submitted(db.pool, store, submissions, personId, "self-submit");
    assert.equal((await reviews.approve(hq(personId), selfReviewed.id, { expectedVersion: 2, reason: "切换总部职责人工自审" }, "self-approve", at)).status, "APPROVED");

    const p43Document = await addDocument(db.pool, personId);
    const p43Screenshot = await addReady(db.pool, store, p43Document, "APPLICATION_SCREENSHOT");
    await submissions.submit(personal(personId), p43Document, { expectedVersion: 1, amountCents: "100", reason: "单图空意见审核", attachmentVersionIds: [p43Screenshot] }, "p43-submit", at);
    assert.deepEqual(await reviews.approve(hq(hqId), p43Document, { expectedVersion: 2, reason: "  " }, "p43-approve", at),
      { id: p43Document, status: "APPROVED", version: 3, replay: false });
    assert.equal((await db.pool.query("SELECT reason FROM finance_reimbursement_decision WHERE finance_document_id=$1::uuid", [p43Document])).rows[0].reason, "");
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("批准必须复验绑定原件；拒绝可处理坏原件，并发审核和末端失败不产生部分状态", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-reimbursement-review-boundary-"));
  try {
    const [personId, firstHqId, secondHqId] = [randomUUID(), randomUUID(), randomUUID()];
    await addPerson(db.pool, personId, "reimbursement-review-boundary-applicant"); await addPerson(db.pool, firstHqId, "reimbursement-review-boundary-one"); await addPerson(db.pool, secondHqId, "reimbursement-review-boundary-two");
    await addAccount(db.pool, personId);
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const submissions = new PostgresReimbursementSubmissionService(db.pool, store), reviews = new PostgresReimbursementReviewService(db.pool, store);
    const broken = await submitted(db.pool, store, submissions, personId, "broken-submit");
    await rm(join(root, "objects", broken.ids[0]));
    await assert.rejects(reviews.approve(hq(firstHqId), broken.id, { expectedVersion: 2, reason: "原件已损坏" }, "broken-approve", at), /ATTACHMENT_INTEGRITY_FAILED/);
    assert.equal((await db.pool.query("SELECT status FROM finance_document WHERE id=$1::uuid", [broken.id])).rows[0].status, "PENDING_APPROVAL");
    assert.equal((await reviews.reject(hq(firstHqId), broken.id, { expectedVersion: 2, reason: "原件无法读取，退回重提" }, "broken-reject", at)).status, "REJECTED");

    const corruptSnapshot = await submitted(db.pool, store, submissions, personId, "corrupt-snapshot-submit");
    await db.pool.query("ALTER TABLE finance_reimbursement_submission DISABLE TRIGGER USER");
    await db.pool.query("UPDATE finance_reimbursement_submission SET applicant_context_snapshot=jsonb_set(applicant_context_snapshot,'{applicantContextVenueId}','\"not-a-uuid\"'::jsonb,true) WHERE finance_document_id=$1::uuid", [corruptSnapshot.id]);
    await db.pool.query("ALTER TABLE finance_reimbursement_submission ENABLE TRIGGER USER");
    await assert.rejects(reviews.reject(hq(firstHqId), corruptSnapshot.id, { expectedVersion: 2, reason: "快照损坏不可处理" }, "corrupt-snapshot-reject", at), /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/);
    assert.equal((await db.pool.query("SELECT status FROM finance_document WHERE id=$1::uuid", [corruptSnapshot.id])).rows[0].status, "PENDING_APPROVAL");

    const corruptDestination = await submitted(db.pool, store, submissions, personId, "corrupt-destination-submit");
    const destination = (await db.pool.query("SELECT destination_account_id::text AS id FROM finance_reimbursement_submission WHERE finance_document_id=$1::uuid", [corruptDestination.id])).rows[0];
    await db.pool.query("UPDATE settlement_account SET owner_id=$2::uuid WHERE id=$1::uuid", [destination.id, secondHqId]);
    await assert.rejects(reviews.approve(hq(firstHqId), corruptDestination.id, { expectedVersion: 2, reason: "收款账户损坏" }, "corrupt-destination-approve", at), /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/);
    assert.equal((await db.pool.query("SELECT status FROM finance_document WHERE id=$1::uuid", [corruptDestination.id])).rows[0].status, "PENDING_APPROVAL");
    await db.pool.query("UPDATE settlement_account SET owner_id=$2::uuid WHERE id=$1::uuid", [destination.id, personId]);

    const concurrent = await submitted(db.pool, store, submissions, personId, "concurrent-submit");
    const attempts = await Promise.allSettled([
      reviews.approve(hq(firstHqId), concurrent.id, { expectedVersion: 2, reason: "批准" }, "concurrent-approve", at),
      reviews.reject(hq(secondHqId), concurrent.id, { expectedVersion: 2, reason: "驳回" }, "concurrent-reject", at)
    ]);
    assert.equal(attempts.filter((value) => value.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((value) => value.status === "rejected").length, 1);
    assert.match(String(attempts.find((value) => value.status === "rejected").reason), /REIMBURSEMENT_STATE_CONFLICT/);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM finance_reimbursement_decision WHERE finance_document_id=$1::uuid", [concurrent.id])).rows[0].count, 1);

    const wrongActorSeal = await submitted(db.pool, store, submissions, personId, "wrong-actor-seal-submit");
    await db.pool.query("UPDATE finance_document SET status='APPROVED',version=3,updated_at=$2::timestamptz WHERE id=$1::uuid", [wrongActorSeal.id, at.toISOString()]);
    await db.pool.query("INSERT INTO finance_reimbursement_command_idempotency(actor_person_id,operation,idempotency_key,request_hash,finance_document_id,result_status,result_document_version,created_at) VALUES($1::uuid,'APPROVE','wrong-actor-seal',$2,$3::uuid,'APPROVED',3,$4::timestamptz)", [firstHqId, "a".repeat(64), wrongActorSeal.id, at.toISOString()]);
    await assert.rejects(db.pool.query("INSERT INTO finance_reimbursement_decision(finance_document_id,source_document_version,result_document_version,decision,reason,decided_by_person_id,actor_subject_code,actor_scope_type,authorization_snapshot,decided_at,created_at) VALUES($1::uuid,2,3,'APPROVED','direct',$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL','{}'::jsonb,$3::timestamptz,$3::timestamptz)", [wrongActorSeal.id, secondHqId, at.toISOString()]), /FINANCE_REIMBURSEMENT_DECISION_INVALID/);
    const wrongTimeSeal = await submitted(db.pool, store, submissions, personId, "wrong-time-seal-submit");
    await db.pool.query("UPDATE finance_document SET status='APPROVED',version=3,updated_at=$2::timestamptz WHERE id=$1::uuid", [wrongTimeSeal.id, at.toISOString()]);
    await db.pool.query("INSERT INTO finance_reimbursement_command_idempotency(actor_person_id,operation,idempotency_key,request_hash,finance_document_id,result_status,result_document_version,created_at) VALUES($1::uuid,'APPROVE','wrong-time-seal',$2,$3::uuid,'APPROVED',3,$4::timestamptz)", [firstHqId, "b".repeat(64), wrongTimeSeal.id, at.toISOString()]);
    const later = new Date(at.getTime() + 1).toISOString();
    await assert.rejects(db.pool.query("INSERT INTO finance_reimbursement_decision(finance_document_id,source_document_version,result_document_version,decision,reason,decided_by_person_id,actor_subject_code,actor_scope_type,authorization_snapshot,decided_at,created_at) VALUES($1::uuid,2,3,'APPROVED','direct',$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL','{}'::jsonb,$3::timestamptz,$3::timestamptz)", [wrongTimeSeal.id, firstHqId, later]), /FINANCE_REIMBURSEMENT_DECISION_INVALID/);

    const rollback = await submitted(db.pool, store, submissions, personId, "rollback-submit");
    await db.pool.query("CREATE FUNCTION force_reimbursement_decision_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST_REIMBURSEMENT_DECISION_FAILURE'; END; $$");
    await db.pool.query("CREATE TRIGGER force_reimbursement_decision_failure BEFORE INSERT ON finance_reimbursement_decision FOR EACH ROW EXECUTE FUNCTION force_reimbursement_decision_failure()");
    await assert.rejects(reviews.approve(hq(firstHqId), rollback.id, { expectedVersion: 2, reason: "末端失败" }, "rollback-approve", at), /TEST_REIMBURSEMENT_DECISION_FAILURE/);
    assert.equal((await db.pool.query("SELECT status FROM finance_document WHERE id=$1::uuid", [rollback.id])).rows[0].status, "PENDING_APPROVAL");
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM finance_reimbursement_command_idempotency WHERE finance_document_id=$1::uuid", [rollback.id])).rows[0].count, 1, "仅原SUBMIT命令保留，审核命令回滚");
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM finance_reimbursement_decision WHERE finance_document_id=$1::uuid", [rollback.id])).rows[0].count, 0);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
