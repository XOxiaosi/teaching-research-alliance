import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LocalAttachmentStore } from "../../dist/local-attachment-store.js";
import { PostgresReimbursementReadService } from "../../dist/postgres-reimbursement-read-service.js";
import { PostgresReimbursementReviewService } from "../../dist/postgres-reimbursement-review-service.js";
import { PostgresReimbursementSubmissionService } from "../../dist/postgres-reimbursement-submission-service.js";
import { PostgresReimbursementTransferService } from "../../dist/postgres-reimbursement-transfer-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const at = new Date("2026-09-21T09:00:00.000Z");
const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 73) });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const chunks = (bytes) => (async function* () { yield bytes; })();
const personal = (personId) => ({ subject: "TEACHING_TEACHER", personId, scope: "SELF" });
const hq = (personId) => ({ subject: "HEADQUARTERS_FINANCE", personId, scope: "GLOBAL" });

const addPerson = (pool, id, nickname) => pool.query(
  "INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,'合成人员','ACTIVE')", [id, nickname]
);
const addPersonAccount = async (pool, personId, balance = 20) => {
  const id = randomUUID();
  await pool.query("INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,'PERSON',$2::uuid,$3,'ACTIVE')", [id, personId, `person:${personId}`]);
  await pool.query("INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1::uuid,$2::bigint)", [id, balance]);
  return id;
};
const addFund = async (pool, hqId) => {
  const fundId = randomUUID(), fundAccountId = randomUUID(), assignmentId = randomUUID();
  await pool.query(
    `INSERT INTO company_finance_fund(id,kind,fund_code,display_name,status,version,created_by_person_id,created_at,updated_at)
     VALUES($1::uuid,'HEADQUARTERS_FINANCE_OPERATING','HQ_READ_TEST','总部读取测试资金','ACTIVE',1,$2::uuid,$3::timestamptz,$3::timestamptz)`,
    [fundId, hqId, at.toISOString()]
  );
  await pool.query("INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,'COMPANY',$2::uuid,$3,'ACTIVE')", [fundAccountId, fundId, `company:${fundId}`]);
  await pool.query("INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1::uuid,1000)", [fundAccountId]);
  await pool.query(
    `INSERT INTO company_finance_fund_assignment(id,fund_id,duty_subject,scope_type,scope_id,responsibility_code,valid_from,valid_to,created_by_person_id,created_at)
     VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'FINANCE_OPERATING_SOURCE',$3::timestamptz,NULL,$4::uuid,$3::timestamptz)`,
    [assignmentId, fundId, at.toISOString(), hqId]
  );
  return { fundId, fundAccountId, assignmentId };
};
const addRole = (pool, hqId) => {
  const id = randomUUID();
  return pool.query(
    `INSERT INTO role_assignment(id,person_id,subject_code,scope_type,scope_id,valid_from,valid_to,created_by,created_at)
     VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,$3::timestamptz,NULL,$2::uuid,$3::timestamptz)`,
    [id, hqId, at.toISOString()]
  ).then(() => id);
};
const addReady = async (pool, store, documentId, purpose) => {
  const attachmentId = randomUUID(), versionId = randomUUID(), digest = sha256(png);
  await store.put({ versionId, originalFilename: `${purpose}.png`, declaredMediaType: "image/png", declaredSizeBytes: png.length, expectedSha256: digest }, chunks(png));
  await pool.query(
    `INSERT INTO finance_attachment(id,finance_document_id,purpose,created_by_person_id,created_at)
       SELECT $1::uuid,$2::uuid,$3,applicant_person_id,$4::timestamptz FROM finance_document WHERE id=$2::uuid`,
    [attachmentId, documentId, purpose, at.toISOString()]
  );
  await pool.query(
    `INSERT INTO finance_attachment_version(id,finance_attachment_id,version_no,status,original_filename,declared_media_type,declared_size_bytes,expected_sha256,detected_media_type,actual_size_bytes,sha256,uploaded_by_person_id,created_at,ready_at)
       SELECT $1::uuid,$2::uuid,1,'READY',$3,'image/png',$4::bigint,$5,'image/png',$4::bigint,$5,applicant_person_id,$6::timestamptz,$6::timestamptz FROM finance_document WHERE id=$7::uuid`,
    [versionId, attachmentId, `${purpose}.png`, png.length, digest, at.toISOString(), documentId]
  );
  return versionId;
};
const createApproved = async (pool, store, applicantId, hqId) => {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at) VALUES($1::uuid,$2::uuid,'REIMBURSEMENT','DRAFT',1,$3::timestamptz,$3::timestamptz)",
    [id, applicantId, at.toISOString()]
  );
  await pool.query(
    `INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,created_at)
       VALUES($1::uuid,'CREATED',$2::uuid,1,$3::timestamptz)`, [id, applicantId, at.toISOString()]
  );
  const attachmentVersionIds = [
    await addReady(pool, store, id, "SUPPORTING_DOCUMENT"),
    await addReady(pool, store, id, "APPLICATION_SCREENSHOT"),
  ];
  const submit = new PostgresReimbursementSubmissionService(pool, store);
  const review = new PostgresReimbursementReviewService(pool, store);
  await submit.submit(personal(applicantId), id, { expectedVersion: 1, amountCents: "100", reason: "完成读取报销", attachmentVersionIds }, "completion-submit", at);
  await review.approve(hq(hqId), id, { expectedVersion: 2, reason: "审核后内部划拨" }, "completion-approve", at);
  return { id, attachmentVersionIds };
};

test("COMPLETED普通报销保留提交原件，个人可见完成时间而严格GLOBAL管理可核执行关系", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-reimbursement-completion-read-"));
  try {
    const applicantId = randomUUID(), hqId = randomUUID(), otherId = randomUUID();
    await addPerson(db.pool, applicantId, "completion-applicant");
    await addPerson(db.pool, hqId, "completion-hq");
    await addPerson(db.pool, otherId, "completion-other");
    const destinationAccountId = await addPersonAccount(db.pool, applicantId);
    await addPersonAccount(db.pool, otherId);
    const roleAssignmentId = await addRole(db.pool, hqId);
    const { fundAccountId, assignmentId } = await addFund(db.pool, hqId);
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const approved = await createApproved(db.pool, store, applicantId, hqId);
    const transfers = new PostgresReimbursementTransferService(db.pool, store);
    const completedAt = new Date(at.getTime() + 60_000);
    assert.deepEqual(await transfers.execute(hq(hqId), approved.id, { expectedVersion: 3 }, "completion-execute", completedAt), {
      id: approved.id, status: "COMPLETED", version: 4, replay: false
    });

    const reads = new PostgresReimbursementReadService(db.pool);
    const own = await reads.listOwn(personal(applicantId), at);
    assert.deepEqual(own.documents, [{
      id: approved.id, status: "COMPLETED", version: 4, amountCents: "100", reason: "完成读取报销",
      applicantPersonId: applicantId, applicantDisplayName: `completion-applicant`, submittedAt: at.toISOString(), completedAt: completedAt.toISOString()
    }]);
    const personalDetail = await reads.getDetail(personal(applicantId), approved.id, at);
    assert.equal(personalDetail.completedAt, completedAt.toISOString());
    assert.equal(personalDetail.management, undefined);
    assert.equal(personalDetail.attachments.length, 2);
    assert.equal((await db.pool.query("SELECT DISTINCT document_version::text AS version FROM finance_reimbursement_attachment_binding WHERE finance_document_id=$1::uuid", [approved.id])).rows[0].version, "2");
    const transferRow = (await db.pool.query(
      "SELECT ledger_event_id::text AS ledger_event_id,authorization_snapshot FROM finance_reimbursement_transfer WHERE finance_document_id=$1::uuid", [approved.id]
    )).rows[0];
    const management = await reads.getDetail(hq(hqId), approved.id, at);
    assert.deepEqual(management.management?.completion, {
      roleAssignmentId, companyFundAssignmentId: assignmentId, sourceAccountId: fundAccountId, destinationAccountId,
      ledgerEventId: transferRow.ledger_event_id, executedByPersonId: hqId, executedAt: completedAt.toISOString()
    });
    assert.equal(management.decision?.decision, "APPROVED");
    assert.equal((await db.pool.query("SELECT balance_cents::text AS balance FROM account_balance_projection WHERE account_id=$1::uuid", [fundAccountId])).rows[0].balance, "900");
    assert.equal((await db.pool.query("SELECT balance_cents::text AS balance FROM account_balance_projection WHERE account_id=$1::uuid", [destinationAccountId])).rows[0].balance, "120");
    await assert.rejects(reads.getDetail(personal(otherId), approved.id, at), /FINANCE_DOCUMENT_NOT_FOUND/);
    await assert.rejects(reads.listManaged({ ...hq(hqId), regionId: randomUUID() }), /FORBIDDEN_SCOPE/);

    await db.pool.query("ALTER TABLE finance_reimbursement_transfer DISABLE TRIGGER USER");
    await db.pool.query(
      `UPDATE finance_reimbursement_transfer
          SET authorization_snapshot=jsonb_set(authorization_snapshot,'{sourceAccountId}','"00000000-0000-4000-8000-000000000001"'::jsonb,true)
        WHERE finance_document_id=$1::uuid`, [approved.id]
    );
    await assert.rejects(reads.getDetail(hq(hqId), approved.id, at), /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/);
    await assert.rejects(reads.listOwn(personal(applicantId), at), /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/);
    await db.pool.query("UPDATE finance_reimbursement_transfer SET authorization_snapshot=$2::jsonb WHERE finance_document_id=$1::uuid", [approved.id, JSON.stringify(transferRow.authorization_snapshot)]);
    await db.pool.query("UPDATE finance_reimbursement_transfer SET source_document_version=2,result_document_version=3 WHERE finance_document_id=$1::uuid", [approved.id]);
    await assert.rejects(reads.listManaged(hq(hqId)), /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
