import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LocalAttachmentStore } from "../../dist/local-attachment-store.js";
import { PostgresCompanyFundService } from "../../dist/postgres-company-fund-service.js";
import { PostgresPersonalReadService } from "../../dist/postgres-personal-read-service.js";
import { PostgresReimbursementReadService } from "../../dist/postgres-reimbursement-read-service.js";
import { PostgresReimbursementReviewService } from "../../dist/postgres-reimbursement-review-service.js";
import { PostgresReimbursementSubmissionService } from "../../dist/postgres-reimbursement-submission-service.js";
import { PostgresReimbursementTransferService } from "../../dist/postgres-reimbursement-transfer-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const base = new Date("2026-09-21T09:00:00.000Z");
const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 41) });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const chunks = (bytes) => (async function* () { yield bytes; })();
const personal = (personId) => ({ subject: "TEACHING_TEACHER", personId, scope: "SELF" });
const finance = (personId) => ({ subject: "HEADQUARTERS_FINANCE", personId, scope: "GLOBAL" });
const admin = (personId) => ({ subject: "SYSTEM_ADMIN", personId, scope: "GLOBAL" });
const plus = (milliseconds) => new Date(base.getTime() + milliseconds);

const addPerson = (pool, id, nickname) => pool.query(
  "INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,'合成人员','ACTIVE')",
  [id, nickname],
);

const corruptFundAssignmentEnd = async (pool, assignmentId, validTo) => {
  await pool.query("ALTER TABLE company_finance_fund_assignment DISABLE TRIGGER USER");
  try {
    await pool.query(
      "UPDATE company_finance_fund_assignment SET valid_to=$2::timestamptz WHERE id=$1::uuid",
      [assignmentId, validTo.toISOString()],
    );
  } finally {
    await pool.query("ALTER TABLE company_finance_fund_assignment ENABLE TRIGGER USER");
  }
};

const addPersonAccount = async (pool, personId) => {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,'PERSON',$2::uuid,$3,'ACTIVE')",
    [id, personId, `person:${personId}`],
  );
  await pool.query("INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1::uuid,20)", [id]);
  return id;
};

const addReady = async (pool, store, documentId, purpose, at) => {
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
    [attachmentId, documentId, purpose, at.toISOString()],
  );
  await pool.query(
    `INSERT INTO finance_attachment_version(
       id,finance_attachment_id,version_no,status,original_filename,declared_media_type,declared_size_bytes,
       expected_sha256,detected_media_type,actual_size_bytes,sha256,uploaded_by_person_id,created_at,ready_at
     )
     SELECT $1::uuid,$2::uuid,1,'READY',$3,'image/png',$4::bigint,$5,'image/png',$4::bigint,$5,
            applicant_person_id,$6::timestamptz,$6::timestamptz
       FROM finance_document WHERE id=$7::uuid`,
    [versionId, attachmentId, `${purpose}.png`, png.length, digest, at.toISOString(), documentId],
  );
  return versionId;
};

const createApproved = async (pool, store, applicantId, financeId, label, at) => {
  const documentId = randomUUID();
  await pool.query(
    `INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at)
     VALUES($1::uuid,$2::uuid,'REIMBURSEMENT','DRAFT',1,$3::timestamptz,$3::timestamptz)`,
    [documentId, applicantId, at.toISOString()],
  );
  await pool.query(
    `INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,created_at)
     VALUES($1::uuid,'CREATED',$2::uuid,1,$3::timestamptz)`,
    [documentId, applicantId, at.toISOString()],
  );
  const attachmentVersionIds = await Promise.all([
    addReady(pool, store, documentId, "SUPPORTING_DOCUMENT", at),
    addReady(pool, store, documentId, "APPLICATION_SCREENSHOT", at),
  ]);
  const submissions = new PostgresReimbursementSubmissionService(pool, store);
  const reviews = new PostgresReimbursementReviewService(pool, store);
  await submissions.submit(personal(applicantId), documentId, {
    expectedVersion: 1,
    amountCents: "100",
    reason: `历史授权 ${label}`,
    attachmentVersionIds,
  }, `${label}-submit`, at);
  await reviews.approve(finance(financeId), documentId, {
    expectedVersion: 2,
    reason: `审核 ${label}`,
  }, `${label}-approve`, at);
  return documentId;
};

test("已完成普通报销在合法职责/资金切换后仍可读取；破坏历史有效期仍被拒绝", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-reimbursement-history-read-"));
  try {
    const applicantId = randomUUID();
    const financeId = randomUUID();
    const adminId = randomUUID();
    await Promise.all([
      addPerson(db.pool, applicantId, "history-applicant"),
      addPerson(db.pool, financeId, "history-finance"),
      addPerson(db.pool, adminId, "history-admin"),
    ]);
    const destinationAccountId = await addPersonAccount(db.pool, applicantId);
    const roleId = randomUUID();
    await db.pool.query(
      `INSERT INTO role_assignment(id,person_id,subject_code,scope_type,scope_id,valid_from,valid_to,created_by,created_at)
       VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,$3::timestamptz,NULL,$4::uuid,$3::timestamptz)`,
      [roleId, financeId, base.toISOString(), adminId],
    );

    const funds = new PostgresCompanyFundService(db.pool);
    const firstFund = await funds.create(admin(adminId), {
      fundCode: "HQ_HISTORY_FIRST",
      displayName: "历史读取原资金",
    }, "history-first-fund", base);
    const firstAssignment = await funds.assign(admin(adminId), {
      fundId: firstFund.id,
      expectedAssignmentId: null,
      reason: "原始资金职责",
    }, "history-first-assignment", base);
    await db.pool.query(
      "UPDATE account_balance_projection SET balance_cents=1000 WHERE account_id=$1::uuid",
      [firstFund.accountId],
    );

    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const documentId = await createApproved(db.pool, store, applicantId, financeId, "history", plus(10_000));
    const completedAt = plus(20_000);
    const transfers = new PostgresReimbursementTransferService(db.pool, store);
    await transfers.execute(finance(financeId), documentId, { expectedVersion: 3 }, "history-execute", completedAt);

    const closeAt = plus(40_000);
    const secondFund = await funds.create(admin(adminId), {
      fundCode: "HQ_HISTORY_SECOND",
      displayName: "历史读取新资金",
    }, "history-second-fund", plus(30_000));
    const secondAssignment = await funds.assign(admin(adminId), {
      fundId: secondFund.id,
      expectedAssignmentId: firstAssignment.id,
      reason: "合法切换资金职责",
    }, "history-second-assignment", closeAt);
    assert.equal(secondAssignment.previousAssignmentId, firstAssignment.id);
    // role_assignment has no current management endpoint, but this is a schema-valid
    // history close after the completed command and must not invalidate that command.
    const roleCloseAt = plus(50_000);
    await db.pool.query("UPDATE role_assignment SET valid_to=$2::timestamptz WHERE id=$1::uuid", [roleId, roleCloseAt.toISOString()]);

    const authorization = (await db.pool.query(
      `SELECT authorization_snapshot,source_fund_id::text AS source_fund_id,company_fund_assignment_id::text AS assignment_id
         FROM finance_reimbursement_transfer WHERE finance_document_id=$1::uuid`,
      [documentId],
    )).rows[0];
    assert.equal(authorization.source_fund_id, firstFund.id);
    assert.equal(authorization.assignment_id, firstAssignment.id);
    assert.equal(authorization.authorization_snapshot.fundAssignmentValidTo, null);
    assert.equal(authorization.authorization_snapshot.roleValidTo, null);

    const reads = new PostgresReimbursementReadService(db.pool);
    const overview = new PostgresPersonalReadService(db.pool);
    const readAt = plus(60_000);
    assert.equal((await reads.getDetail(personal(applicantId), documentId, readAt)).completedAt, completedAt.toISOString());
    assert.equal((await reads.listOwn(personal(applicantId), readAt)).documents[0]?.id, documentId);
    assert.equal((await overview.getOwnOverview(personal(applicantId), readAt)).currentYearIncomeByCategory.reimbursementIncome, 100n);

    // A legal switch closes the former row exactly where its successor begins.
    const closed = (await db.pool.query(
      "SELECT valid_to::text AS valid_to FROM company_finance_fund_assignment WHERE id=$1::uuid",
      [firstAssignment.id],
    )).rows[0];
    assert.equal(new Date(closed.valid_to).toISOString(), closeAt.toISOString());

    // A closure before execution is not historical handover: it proves the original
    // authorization snapshot and row can no longer describe a valid completed command.
    await corruptFundAssignmentEnd(db.pool, firstAssignment.id, plus(15_000));
    await assert.rejects(reads.getDetail(personal(applicantId), documentId, readAt), /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/);

    // Restore the legitimate closure, then prove that changing an already sealed
    // boundary away from its successor is also corruption, not a new valid history.
    await corruptFundAssignmentEnd(db.pool, firstAssignment.id, closeAt);
    assert.equal((await reads.getDetail(personal(applicantId), documentId, readAt)).id, documentId);
    await corruptFundAssignmentEnd(db.pool, firstAssignment.id, plus(39_000));
    await assert.rejects(reads.listOwn(personal(applicantId), readAt), /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});
