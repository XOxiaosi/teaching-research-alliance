import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LocalAttachmentStore } from "../../dist/local-attachment-store.js";
import { PostgresCompanyFundService } from "../../dist/postgres-company-fund-service.js";
import { readValidatedCompletedReimbursement } from "../../dist/postgres-reimbursement-read-service.js";
import { PostgresReimbursementReviewService } from "../../dist/postgres-reimbursement-review-service.js";
import { PostgresReimbursementSubmissionService } from "../../dist/postgres-reimbursement-submission-service.js";
import { PostgresReimbursementTransferService } from "../../dist/postgres-reimbursement-transfer-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const base = new Date("2026-09-22T09:00:00.000Z");
const at = (milliseconds) => new Date(base.getTime() + milliseconds);
const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 64) });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const chunks = (bytes) => (async function* () { yield bytes; })();
const personal = (personId) => ({ subject: "TEACHING_TEACHER", personId, scope: "SELF" });
const finance = (personId) => ({ subject: "HEADQUARTERS_FINANCE", personId, scope: "GLOBAL" });
const admin = (personId) => ({ subject: "SYSTEM_ADMIN", personId, scope: "GLOBAL" });

const addPerson = (pool, id, nickname) => pool.query(
  "INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,'合成人员','ACTIVE')",
  [id, nickname],
);

const addPersonAccount = async (pool, personId) => {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,'PERSON',$2::uuid,$3,'ACTIVE')",
    [id, personId, `person:${personId}`],
  );
  await pool.query("INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1::uuid,20)", [id]);
  return id;
};

const addReady = async (pool, store, documentId, purpose, createdAt) => {
  const attachmentId = randomUUID();
  const versionId = randomUUID();
  const digest = sha256(png);
  await store.put({
    versionId,
    originalFilename: `${purpose}.png`,
    declaredMediaType: "image/png",
    declaredSizeBytes: png.length,
    expectedSha256: digest,
  }, chunks(png));
  await pool.query(
    `INSERT INTO finance_attachment(id,finance_document_id,purpose,created_by_person_id,created_at)
       SELECT $1::uuid,$2::uuid,$3,applicant_person_id,$4::timestamptz
         FROM finance_document WHERE id=$2::uuid`,
    [attachmentId, documentId, purpose, createdAt.toISOString()],
  );
  await pool.query(
    `INSERT INTO finance_attachment_version(
       id,finance_attachment_id,version_no,status,original_filename,declared_media_type,declared_size_bytes,
       expected_sha256,detected_media_type,actual_size_bytes,sha256,uploaded_by_person_id,created_at,ready_at
     )
     SELECT $1::uuid,$2::uuid,1,'READY',$3,'image/png',$4::bigint,$5,'image/png',$4::bigint,$5,
            applicant_person_id,$6::timestamptz,$6::timestamptz
       FROM finance_document WHERE id=$7::uuid`,
    [versionId, attachmentId, `${purpose}.png`, png.length, digest, createdAt.toISOString(), documentId],
  );
  return versionId;
};

const createApproved = async (pool, store, applicantId, financeId) => {
  const documentId = randomUUID();
  const createdAt = at(10_000);
  await pool.query(
    `INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at)
     VALUES($1::uuid,$2::uuid,'REIMBURSEMENT','DRAFT',1,$3::timestamptz,$3::timestamptz)`,
    [documentId, applicantId, createdAt.toISOString()],
  );
  await pool.query(
    `INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,created_at)
     VALUES($1::uuid,'CREATED',$2::uuid,1,$3::timestamptz)`,
    [documentId, applicantId, createdAt.toISOString()],
  );
  const attachmentVersionIds = await Promise.all([
    addReady(pool, store, documentId, "SUPPORTING_DOCUMENT", createdAt),
    addReady(pool, store, documentId, "APPLICATION_SCREENSHOT", createdAt),
  ]);
  await new PostgresReimbursementSubmissionService(pool, store).submit(personal(applicantId), documentId, {
    expectedVersion: 1, amountCents: "100", reason: "完成链内部辅助", attachmentVersionIds,
  }, `completed-helper-submit:${documentId}`, createdAt);
  await new PostgresReimbursementReviewService(pool, store).approve(finance(financeId), documentId, {
    expectedVersion: 2, reason: "完成链审批",
  }, `completed-helper-approve:${documentId}`, createdAt);
  return documentId;
};

const withLockedDocument = async (pool, documentId, action) => {
  const client = await pool.connect();
  let open = false;
  try {
    await client.query("BEGIN");
    open = true;
    const locked = await client.query("SELECT id FROM finance_document WHERE id=$1::uuid FOR UPDATE", [documentId]);
    assert.equal(locked.rowCount, 1, "调用者先在同一事务锁住原单据");
    const result = await action(client);
    await client.query("COMMIT");
    open = false;
    return result;
  } catch (error) {
    if (open) await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.release();
  }
};

const documentWriteCounts = async (pool, documentId) => (await pool.query(
  `SELECT (SELECT count(*)::int FROM finance_document_event WHERE finance_document_id=$1::uuid) AS document_event_count,
          (SELECT count(*)::int FROM ledger_event WHERE event_key=$2) AS ledger_event_count`,
  [documentId, `reimbursement:${documentId}`],
)).rows[0];

const corruptApprovalSnapshot = async (pool, documentId, reviewerId) => {
  await pool.query("ALTER TABLE finance_reimbursement_decision DISABLE TRIGGER USER");
  try {
    await pool.query(
      "UPDATE finance_reimbursement_decision SET authorization_snapshot=jsonb_set(authorization_snapshot,'{reviewerPersonId}',to_jsonb($2::text),true) WHERE finance_document_id=$1::uuid",
      [documentId, reviewerId],
    );
  } finally {
    await pool.query("ALTER TABLE finance_reimbursement_decision ENABLE TRIGGER USER");
  }
};

test("已完成普通报销内部辅助只复用严格完成链，历史资金切换可读且损坏审批链拒绝", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-reimbursement-completed-helper-"));
  try {
    const applicantId = randomUUID();
    const financeId = randomUUID();
    const adminId = randomUUID();
    await Promise.all([
      addPerson(db.pool, applicantId, "completed-helper-applicant"),
      addPerson(db.pool, financeId, "completed-helper-finance"),
      addPerson(db.pool, adminId, "completed-helper-admin"),
    ]);
    const destinationAccountId = await addPersonAccount(db.pool, applicantId);
    const roleAssignmentId = randomUUID();
    await db.pool.query(
      `INSERT INTO role_assignment(id,person_id,subject_code,scope_type,scope_id,valid_from,valid_to,created_by,created_at)
       VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,$3::timestamptz,NULL,$4::uuid,$3::timestamptz)`,
      [roleAssignmentId, financeId, base.toISOString(), adminId],
    );

    const funds = new PostgresCompanyFundService(db.pool);
    const firstFund = await funds.create(admin(adminId), {
      fundCode: "HQ_COMPLETED_HELPER_FIRST", displayName: "完成链辅助原资金",
    }, "completed-helper-first-fund", base);
    const firstAssignment = await funds.assign(admin(adminId), {
      fundId: firstFund.id, expectedAssignmentId: null, reason: "原始资金职责",
    }, "completed-helper-first-assignment", base);
    await db.pool.query("UPDATE account_balance_projection SET balance_cents=1000 WHERE account_id=$1::uuid", [firstFund.accountId]);

    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const documentId = await createApproved(db.pool, store, applicantId, financeId);
    const completedAt = at(20_000);
    await new PostgresReimbursementTransferService(db.pool, store).execute(
      finance(financeId), documentId, { expectedVersion: 3 }, "completed-helper-execute", completedAt,
    );
    const auditBefore = (await db.pool.query("SELECT count(*)::int AS count FROM audit_event")).rows[0].count;
    const writesBefore = await documentWriteCounts(db.pool, documentId);

    const normal = await withLockedDocument(db.pool, documentId, (client) => readValidatedCompletedReimbursement(client, documentId));
    assert.deepEqual({
      id: normal.id, version: normal.version, amountCents: normal.amountCents, reason: normal.reason,
      applicantPersonId: normal.applicantPersonId, submittedAt: normal.submittedAt, completedAt: normal.completedAt,
      sourceFundId: normal.sourceFundId, sourceAccountId: normal.sourceAccountId, destinationAccountId: normal.destinationAccountId,
      roleAssignmentId: normal.roleAssignmentId, companyFundAssignmentId: normal.companyFundAssignmentId,
      executedByPersonId: normal.executedByPersonId,
    }, {
      id: documentId, version: 4, amountCents: 100n, reason: "完成链内部辅助",
      applicantPersonId: applicantId, submittedAt: at(10_000).toISOString(), completedAt: completedAt.toISOString(),
      sourceFundId: firstFund.id, sourceAccountId: firstFund.accountId, destinationAccountId,
      roleAssignmentId, companyFundAssignmentId: firstAssignment.id, executedByPersonId: financeId,
    });
    assert.equal(normal.authorizationSnapshot.executorPersonId, financeId);
    assert.equal(normal.authorizationSnapshot.sourceFundId, firstFund.id);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM audit_event")).rows[0].count, auditBefore, "内部辅助不得写审计事件");
    assert.deepEqual(await documentWriteCounts(db.pool, documentId), writesBefore, "内部辅助不得写单据或账务事件");

    const approvedOnlyDocumentId = await createApproved(db.pool, store, applicantId, financeId);
    const auditBeforeApprovedOnlyRead = (await db.pool.query("SELECT count(*)::int AS count FROM audit_event")).rows[0].count;
    await assert.rejects(
      withLockedDocument(db.pool, approvedOnlyDocumentId, (client) => readValidatedCompletedReimbursement(client, approvedOnlyDocumentId)),
      /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/,
    );
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM audit_event")).rows[0].count, auditBeforeApprovedOnlyRead, "非完成态拒绝时不得写审计事件");

    const secondFund = await funds.create(admin(adminId), {
      fundCode: "HQ_COMPLETED_HELPER_SECOND", displayName: "完成链辅助新资金",
    }, "completed-helper-second-fund", at(30_000));
    const secondAssignment = await funds.assign(admin(adminId), {
      fundId: secondFund.id, expectedAssignmentId: firstAssignment.id, reason: "合法切换资金职责",
    }, "completed-helper-second-assignment", at(40_000));
    assert.equal(secondAssignment.previousAssignmentId, firstAssignment.id);
    const historical = await withLockedDocument(db.pool, documentId, (client) => readValidatedCompletedReimbursement(client, documentId));
    assert.equal(historical.sourceFundId, firstFund.id);
    assert.equal(historical.companyFundAssignmentId, firstAssignment.id);

    const auditBeforeRejectedRead = (await db.pool.query("SELECT count(*)::int AS count FROM audit_event")).rows[0].count;
    const writesBeforeRejectedRead = await documentWriteCounts(db.pool, documentId);
    await corruptApprovalSnapshot(db.pool, documentId, applicantId);
    await assert.rejects(
      withLockedDocument(db.pool, documentId, (client) => readValidatedCompletedReimbursement(client, documentId)),
      /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/,
    );
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM audit_event")).rows[0].count, auditBeforeRejectedRead, "内部辅助拒绝时也不得写审计事件");
    assert.deepEqual(await documentWriteCounts(db.pool, documentId), writesBeforeRejectedRead, "内部辅助拒绝时也不得写单据或账务事件");
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});
