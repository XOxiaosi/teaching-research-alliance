import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { postLedgerEvent } from "@teaching-research-alliance/domain";
import { LocalAttachmentStore } from "../../dist/local-attachment-store.js";
import { PostgresCompanyFundService } from "../../dist/postgres-company-fund-service.js";
import { PostgresLedgerRepository } from "../../dist/postgres-ledger-repository.js";
import { PostgresPersonalReadService } from "../../dist/postgres-personal-read-service.js";
import { PostgresReimbursementReadService } from "../../dist/postgres-reimbursement-read-service.js";
import { PostgresReimbursementReversalService } from "../../dist/postgres-reimbursement-reversal-service.js";
import { PostgresReimbursementReviewService } from "../../dist/postgres-reimbursement-review-service.js";
import { PostgresReimbursementSubmissionService } from "../../dist/postgres-reimbursement-submission-service.js";
import { PostgresReimbursementTransferService } from "../../dist/postgres-reimbursement-transfer-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const base = new Date("2026-09-22T09:00:00.000Z");
const at = (milliseconds) => new Date(base.getTime() + milliseconds);
const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 31) });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const chunks = (bytes) => (async function* () { yield bytes; })();
const personal = (personId) => ({ subject: "TEACHING_TEACHER", personId, scope: "SELF" });
const finance = (personId) => ({ subject: "HEADQUARTERS_FINANCE", personId, scope: "GLOBAL" });
const admin = (personId) => ({ subject: "SYSTEM_ADMIN", personId, scope: "GLOBAL" });

const addPerson = (pool, id, nickname) => pool.query(
  "INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,'合成人员','ACTIVE')", [id, nickname],
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
    versionId, originalFilename: `${purpose}.png`, declaredMediaType: "image/png",
    declaredSizeBytes: png.length, expectedSha256: digest,
  }, chunks(png));
  await pool.query(
    `INSERT INTO finance_attachment(id,finance_document_id,purpose,created_by_person_id,created_at)
       SELECT $1::uuid,$2::uuid,$3,applicant_person_id,$4::timestamptz FROM finance_document WHERE id=$2::uuid`,
    [attachmentId, documentId, purpose, createdAt.toISOString()],
  );
  await pool.query(
    `INSERT INTO finance_attachment_version(
       id,finance_attachment_id,version_no,status,original_filename,declared_media_type,declared_size_bytes,
       expected_sha256,detected_media_type,actual_size_bytes,sha256,uploaded_by_person_id,created_at,ready_at
     ) SELECT $1::uuid,$2::uuid,1,'READY',$3,'image/png',$4::bigint,$5,'image/png',$4::bigint,$5,
              applicant_person_id,$6::timestamptz,$6::timestamptz FROM finance_document WHERE id=$7::uuid`,
    [versionId, attachmentId, `${purpose}.png`, png.length, digest, createdAt.toISOString(), documentId],
  );
  return versionId;
};

const createApproved = async (pool, store, applicantId, financeId, createdAt) => {
  const documentId = randomUUID();
  await pool.query(
    `INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at)
     VALUES($1::uuid,$2::uuid,'REIMBURSEMENT','DRAFT',1,$3::timestamptz,$3::timestamptz)`,
    [documentId, applicantId, createdAt.toISOString()],
  );
  await pool.query(
    `INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,created_at)
     VALUES($1::uuid,'CREATED',$2::uuid,1,$3::timestamptz)`, [documentId, applicantId, createdAt.toISOString()],
  );
  const attachmentVersionIds = await Promise.all([
    addReady(pool, store, documentId, "SUPPORTING_DOCUMENT", createdAt),
    addReady(pool, store, documentId, "APPLICATION_SCREENSHOT", createdAt),
  ]);
  await new PostgresReimbursementSubmissionService(pool, store).submit(personal(applicantId), documentId, {
    expectedVersion: 1, amountCents: "100", reason: "撤销读取原报销", attachmentVersionIds,
  }, `reversed-read-submit:${documentId}`, createdAt);
  await new PostgresReimbursementReviewService(pool, store).approve(finance(financeId), documentId, {
    expectedVersion: 2, reason: "撤销读取批准",
  }, `reversed-read-approve:${documentId}`, createdAt);
  return documentId;
};

const corruptReversalAuthorization = async (pool, documentId) => {
  await pool.query("ALTER TABLE finance_reimbursement_reversal DISABLE TRIGGER USER");
  try {
    await pool.query(
      "UPDATE finance_reimbursement_reversal SET authorization_snapshot=jsonb_set(authorization_snapshot,'{actorPersonId}','\"broken\"'::jsonb,true) WHERE finance_document_id=$1::uuid",
      [documentId],
    );
  } finally {
    await pool.query("ALTER TABLE finance_reimbursement_reversal ENABLE TRIGGER USER");
  }
};

const corruptDocumentStatus = async (pool, documentId, status) => {
  await pool.query("ALTER TABLE finance_document DISABLE TRIGGER USER");
  try {
    await pool.query("UPDATE finance_document SET status=$2 WHERE id=$1::uuid", [documentId, status]);
  } finally {
    await pool.query("ALTER TABLE finance_document ENABLE TRIGGER USER");
  }
};

const seedCompleted = async (pool, root, { createdAt = at(10_000), completedAt = at(20_000) } = {}) => {
  const applicantId = randomUUID();
  const financeId = randomUUID();
  const adminId = randomUUID();
  await Promise.all([
    addPerson(pool, applicantId, "reversed-read-applicant"),
    addPerson(pool, financeId, "reversed-read-finance"),
    addPerson(pool, adminId, "reversed-read-admin"),
  ]);
  const destinationAccountId = await addPersonAccount(pool, applicantId);
  const roleAssignmentId = randomUUID();
  const roleValidFrom = new Date(createdAt.getTime() - 10_000).toISOString();
  await pool.query(
    `INSERT INTO role_assignment(id,person_id,subject_code,scope_type,scope_id,valid_from,valid_to,created_by,created_at)
     VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,$3::timestamptz,NULL,$4::uuid,$3::timestamptz)`,
    [roleAssignmentId, financeId, roleValidFrom, adminId],
  );
  await pool.query(
    `INSERT INTO role_assignment(id,person_id,subject_code,scope_type,scope_id,valid_from,valid_to,created_by,created_at)
     VALUES($1::uuid,$2::uuid,'SYSTEM_ADMIN','GLOBAL',NULL,$3::timestamptz,NULL,$2::uuid,$3::timestamptz)`,
    [randomUUID(), adminId, roleValidFrom],
  );
  const funds = new PostgresCompanyFundService(pool);
  const firstFund = await funds.create(admin(adminId), {
    fundCode: `HQ_REVERSED_READ_${applicantId.slice(0, 8).toUpperCase()}`,
    displayName: "撤销读取原资金",
  }, `reversed-read-first-fund:${applicantId}`, new Date(createdAt.getTime() - 10_000));
  const firstAssignment = await funds.assign(admin(adminId), {
    fundId: firstFund.id, expectedAssignmentId: null, reason: "原始资金职责",
  }, `reversed-read-first-assignment:${applicantId}`, new Date(createdAt.getTime() - 10_000));
  await pool.query("UPDATE account_balance_projection SET balance_cents=1000 WHERE account_id=$1::uuid", [firstFund.accountId]);
  const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
  const documentId = await createApproved(pool, store, applicantId, financeId, createdAt);
  await new PostgresReimbursementTransferService(pool, store).execute(
    finance(financeId), documentId, { expectedVersion: 3 }, `reversed-read-execute:${documentId}`, completedAt,
  );
  return { applicantId, financeId, adminId, destinationAccountId, roleAssignmentId, funds, firstFund, firstAssignment, store, documentId, completedAt };
};

test("REVERSED普通报销严格保留完成链、个人仅见业务撤销字段，并按原完成财年净额归零", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-reimbursement-reversed-read-"));
  try {
    const f = await seedCompleted(db.pool, root);
    await postLedgerEvent(new PostgresLedgerRepository(db.pool), {
      eventKey: `reversed-read-spend:${f.documentId}`, eventType: "SYNTHETIC_PERSONAL_SPEND", payloadHash: "reversed-read-spend",
      deltas: [{ accountKey: `person:${f.applicantId}`, categoryKey: "syntheticPersonalSpend", amountCents: -50n }],
    }, randomUUID);
    const secondFund = await f.funds.create(admin(f.adminId), {
      fundCode: `HQ_REVERSED_READ_NEXT_${f.applicantId.slice(0, 8).toUpperCase()}`, displayName: "撤销读取新资金",
    }, "reversed-read-next-fund", at(30_000));
    const secondAssignment = await f.funds.assign(admin(f.adminId), {
      fundId: secondFund.id, expectedAssignmentId: f.firstAssignment.id, reason: "合法资金切换",
    }, "reversed-read-next-assignment", at(40_000));
    assert.equal(secondAssignment.previousAssignmentId, f.firstAssignment.id);

    const reversedAt = at(50_000);
    await new PostgresReimbursementReversalService(db.pool).reverse(
      finance(f.financeId), f.documentId, { expectedVersion: 4, reason: "录入错误撤销" }, "reversed-read", reversedAt,
    );
    const reads = new PostgresReimbursementReadService(db.pool);
    const personalDetail = await reads.getDetail(personal(f.applicantId), f.documentId, at(60_000));
    assert.deepEqual({
      status: personalDetail.status, version: personalDetail.version, completedAt: personalDetail.completedAt,
      reversedAt: personalDetail.reversedAt, reversalReason: personalDetail.reversalReason,
    }, {
      status: "REVERSED", version: 5, completedAt: f.completedAt.toISOString(),
      reversedAt: reversedAt.toISOString(), reversalReason: "录入错误撤销",
    });
    assert.equal(personalDetail.management, undefined);
    for (const field of ["sourceAccountId", "destinationAccountId", "roleAssignmentId", "companyFundAssignmentId", "ledgerEventId", "reversalLedgerEventId", "reversedByPersonId"]) {
      assert.equal(Object.hasOwn(personalDetail, field), false, `个人详情不泄露${field}`);
    }
    assert.equal(JSON.stringify(personalDetail).includes(f.firstFund.accountId), false, "个人详情不泄露公司账户");
    assert.equal(JSON.stringify(personalDetail).includes(f.firstAssignment.id), false, "个人详情不泄露资金职责ID");
    const own = await reads.listOwn(personal(f.applicantId), at(60_000));
    assert.deepEqual(own.documents.map(({ status, reversedAt: rowAt, reversalReason }) => ({ status, rowAt, reversalReason })), [
      { status: "REVERSED", rowAt: reversedAt.toISOString(), reversalReason: "录入错误撤销" },
    ]);
    const managed = await reads.getDetail(admin(f.adminId), f.documentId, at(60_000));
    assert.deepEqual(managed.management?.reversal, {
      sourceAccountId: f.firstFund.accountId, destinationAccountId: f.destinationAccountId,
      originalLedgerEventId: managed.management?.completion?.ledgerEventId,
      reversalLedgerEventId: (await db.pool.query("SELECT reversal_ledger_event_id::text AS id FROM finance_reimbursement_reversal WHERE finance_document_id=$1::uuid", [f.documentId])).rows[0].id,
      reversedByPersonId: f.financeId, actorSubjectCode: "HEADQUARTERS_FINANCE", actorScopeType: "GLOBAL", reversedAt: reversedAt.toISOString(),
    });
    const overview = new PostgresPersonalReadService(db.pool);
    assert.deepEqual((await overview.getOwnOverview(personal(f.applicantId), at(60_000))).currentYearIncomeByCategory, {}, "同财年撤销把原报销收入净至零");
    assert.equal((await overview.getOwnOverview(personal(f.applicantId), at(60_000))).balanceCents, -30n, "余额仍体现已发生的反向划拨和个人支出");

    await corruptReversalAuthorization(db.pool, f.documentId);
    await assert.rejects(reads.getDetail(personal(f.applicantId), f.documentId, at(60_000)), /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/);
    await assert.rejects(overview.getOwnOverview(personal(f.applicantId), at(60_000)), /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("跨财年REVERSED不制造撤销年负收入，且有transfer的损坏状态不能被收入查询静默跳过", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-reimbursement-reversed-cross-year-"));
  try {
    const f = await seedCompleted(db.pool, root);
    const reversalAt = new Date("2027-09-01T00:00:00.000Z");
    await new PostgresReimbursementReversalService(db.pool).reverse(
      admin(f.adminId), f.documentId, { expectedVersion: 4, reason: "跨财年撤销" }, "reversed-read-cross-year", reversalAt,
    );
    const overview = new PostgresPersonalReadService(db.pool);
    const originalYear = new Date("2027-08-31T15:59:59.000Z");
    assert.deepEqual((await overview.getOwnOverview(personal(f.applicantId), originalYear)).currentYearIncomeByCategory, {}, "原完成财年按净额归零");
    assert.deepEqual((await overview.getOwnOverview(personal(f.applicantId), reversalAt)).currentYearIncomeByCategory, {}, "撤销所在新财年不产生负收入");
    assert.equal((await overview.getOwnOverview(personal(f.applicantId), reversalAt)).balanceCents, 20n);

    await corruptDocumentStatus(db.pool, f.documentId, "APPROVED");
    await assert.rejects(overview.getOwnOverview(personal(f.applicantId), originalYear), /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("REVERSED读取对反向事件详情、反向分录和REVERSE命令封口逐项关闭失败", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-reimbursement-reversed-read-integrity-"));
  try {
    const f = await seedCompleted(db.pool, root);
    const reversedAt = at(50_000);
    await new PostgresReimbursementReversalService(db.pool).reverse(
      finance(f.financeId), f.documentId, { expectedVersion: 4, reason: "完整性读取撤销" }, "reversed-read-integrity", reversedAt,
    );
    const reads = new PostgresReimbursementReadService(db.pool);
    const overview = new PostgresPersonalReadService(db.pool);
    const assertRejected = async (label) => {
      await assert.rejects(reads.getDetail(personal(f.applicantId), f.documentId, at(60_000)), /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/, label);
      await assert.rejects(overview.getOwnOverview(personal(f.applicantId), at(60_000)), /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/, label);
    };
    const assertRestored = async () => {
      assert.equal((await reads.getDetail(personal(f.applicantId), f.documentId, at(60_000))).status, "REVERSED");
      assert.deepEqual((await overview.getOwnOverview(personal(f.applicantId), at(60_000))).currentYearIncomeByCategory, {});
    };
    const mutate = async (table, action) => {
      await db.pool.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
      try {
        await action();
      } finally {
        await db.pool.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
      }
    };
    const reversal = (await db.pool.query(
      "SELECT reversal_ledger_event_id::text AS ledger_event_id FROM finance_reimbursement_reversal WHERE finance_document_id=$1::uuid",
      [f.documentId],
    )).rows[0];

    await mutate("finance_document_event", () => db.pool.query(
      "UPDATE finance_document_event SET details_json=jsonb_set(details_json,'{reason}','\"篡改事件详情\"'::jsonb,true) WHERE finance_document_id=$1::uuid AND event_type='REIMBURSEMENT_REVERSED'",
      [f.documentId],
    ));
    await assertRejected("反向事件详情不再与撤销事实匹配");
    await mutate("finance_document_event", () => db.pool.query(
      "UPDATE finance_document_event SET details_json=jsonb_set(details_json,'{reason}','\"完整性读取撤销\"'::jsonb,true) WHERE finance_document_id=$1::uuid AND event_type='REIMBURSEMENT_REVERSED'",
      [f.documentId],
    ));
    await assertRestored();

    await mutate("ledger_entry", () => db.pool.query(
      "UPDATE ledger_entry SET category_key='brokenReversalCategory' WHERE event_id=$1::uuid AND amount_cents<0",
      [reversal.ledger_event_id],
    ));
    await assertRejected("反向分录类别不再是精确两线");
    await mutate("ledger_entry", () => db.pool.query(
      "UPDATE ledger_entry SET category_key='reimbursementIncomeReversal' WHERE event_id=$1::uuid AND amount_cents<0",
      [reversal.ledger_event_id],
    ));
    await assertRestored();

    await mutate("finance_reimbursement_command_idempotency", () => db.pool.query(
      "UPDATE finance_reimbursement_command_idempotency SET actor_person_id=$2::uuid WHERE finance_document_id=$1::uuid AND operation='REVERSE'",
      [f.documentId, f.applicantId],
    ));
    await assertRejected("REVERSE命令封口执行人不再与撤销事实匹配");
    await mutate("finance_reimbursement_command_idempotency", () => db.pool.query(
      "UPDATE finance_reimbursement_command_idempotency SET actor_person_id=$2::uuid WHERE finance_document_id=$1::uuid AND operation='REVERSE'",
      [f.documentId, f.financeId],
    ));
    await assertRestored();
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});
