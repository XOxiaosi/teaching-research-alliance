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
import { PostgresReimbursementTransferService } from "../../dist/postgres-reimbursement-transfer-service.js";
import { PostgresPersonalReadService } from "../../dist/postgres-personal-read-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";
import { FullBackupSpool } from "../../../worker/dist/full-backup-spool.js";
import { FullBackupTransformer } from "../../../worker/dist/full-backup-transformer.js";
import { PostgresFullBackupSource } from "../../../worker/dist/postgres-full-backup-source.js";
import { readBackupSpoolDataset } from "../../../worker/dist/full-backup-spool-reader.js";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 164) });
const sha256 = createHash("sha256").update(png).digest("hex");
const chunks = (bytes) => (async function* () { yield bytes; })();
const at = new Date("2026-09-21T09:00:00.000Z");
const hq = (personId) => ({ subject: "HEADQUARTERS_FINANCE", personId, scope: "GLOBAL" });
const personal = (personId) => ({ subject: "TEACHING_TEACHER", personId, scope: "SELF" });

const addPerson = (pool, id, nickname) => pool.query(
  "INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,'合成人员','ACTIVE')", [id, nickname]
);
const addAccount = async (pool, ownerType, ownerId, code, balance, status = "ACTIVE") => {
  const id = randomUUID();
  await pool.query("INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,$2,$3::uuid,$4,$5)", [id, ownerType, ownerId, code, status]);
  await pool.query("INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1::uuid,$2::bigint)", [id, String(balance)]);
  return id;
};
const addRole = (pool, personId, from = new Date("2026-01-01T00:00:00.000Z"), to = null) => pool.query(
  "INSERT INTO role_assignment(id,person_id,subject_code,scope_type,scope_id,valid_from,valid_to,created_by,created_at) VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,$3::timestamptz,$4::timestamptz,$2::uuid,$3::timestamptz)",
  [randomUUID(), personId, from.toISOString(), to?.toISOString() ?? null]
);
const addEvidence = async (pool, store, documentId, purpose, createdAt) => {
  const attachmentId = randomUUID(), versionId = randomUUID();
  await store.put({ versionId, originalFilename: `${purpose}.png`, declaredMediaType: "image/png", declaredSizeBytes: png.length, expectedSha256: sha256 }, chunks(png));
  await pool.query(
    "INSERT INTO finance_attachment(id,finance_document_id,purpose,created_by_person_id,created_at) SELECT $1::uuid,$2::uuid,$3,applicant_person_id,$4::timestamptz FROM finance_document WHERE id=$2::uuid",
    [attachmentId, documentId, purpose, createdAt.toISOString()]
  );
  await pool.query(
    `INSERT INTO finance_attachment_version(id,finance_attachment_id,version_no,status,original_filename,declared_media_type,declared_size_bytes,expected_sha256,detected_media_type,actual_size_bytes,sha256,uploaded_by_person_id,created_at,ready_at)
     SELECT $1::uuid,$2::uuid,1,'READY',$3,'image/png',$4::bigint,$5,'image/png',$4::bigint,$5,applicant_person_id,$6::timestamptz,$6::timestamptz FROM finance_document WHERE id=$7::uuid`,
    [versionId, attachmentId, `${purpose}.png`, png.length, sha256, createdAt.toISOString(), documentId]
  );
  return versionId;
};

const seed = async (pool, sourceBalance = 100) => {
  const applicantId = randomUUID(), financeId = randomUUID(), secondFinanceId = randomUUID(), fundId = randomUUID();
  await addPerson(pool, applicantId, "reimbursement-transfer-applicant");
  await addPerson(pool, financeId, "reimbursement-transfer-finance");
  await addPerson(pool, secondFinanceId, "reimbursement-transfer-second-finance");
  const destinationAccountId = await addAccount(pool, "PERSON", applicantId, `person:${applicantId}`, 20);
  const financePersonalAccountId = await addAccount(pool, "PERSON", financeId, `person:${financeId}`, 7);
  const sourceAccountId = await addAccount(pool, "COMPANY", fundId, `company:fund:${fundId}`, sourceBalance);
  await addRole(pool, financeId); await addRole(pool, secondFinanceId);
  await pool.query(
    "INSERT INTO company_finance_fund(id,kind,fund_code,display_name,organization_unit_id,status,version,created_by_person_id,created_at,updated_at) VALUES($1::uuid,'HEADQUARTERS_FINANCE_OPERATING','HQ_REIMBURSEMENT_TEST','普通报销财务账户',NULL,'ACTIVE',1,$2::uuid,$3::timestamptz,$3::timestamptz)",
    [fundId, financeId, at.toISOString()]
  );
  const fundAssignmentId = randomUUID();
  await pool.query(
    "INSERT INTO company_finance_fund_assignment(id,fund_id,duty_subject,scope_type,scope_id,responsibility_code,valid_from,valid_to,created_by_person_id,created_at) VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'FINANCE_OPERATING_SOURCE',$3::timestamptz,NULL,$4::uuid,$3::timestamptz)",
    [fundAssignmentId, fundId, new Date("2026-01-01T00:00:00.000Z").toISOString(), financeId]
  );
  return { applicantId, financeId, secondFinanceId, fundId, fundAssignmentId, sourceAccountId, destinationAccountId, financePersonalAccountId };
};

const approve = async (pool, store, applicantId, financeId, { amountCents = "150", at: now = at } = {}) => {
  const documentId = randomUUID();
  await pool.query("INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at) VALUES($1::uuid,$2::uuid,'REIMBURSEMENT','DRAFT',1,$3::timestamptz,$3::timestamptz)", [documentId, applicantId, now.toISOString()]);
  await pool.query(
    `INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,created_at)
       VALUES($1::uuid,'CREATED',$2::uuid,1,$3::timestamptz)`,
    [documentId, applicantId, now.toISOString()],
  );
  const attachmentVersionIds = await Promise.all([
    addEvidence(pool, store, documentId, "SUPPORTING_DOCUMENT", now),
    addEvidence(pool, store, documentId, "APPLICATION_SCREENSHOT", now)
  ]);
  const submissions = new PostgresReimbursementSubmissionService(pool, store);
  const reviews = new PostgresReimbursementReviewService(pool, store);
  await submissions.submit(personal(applicantId), documentId, { expectedVersion: 1, amountCents, reason: "普通报销真实划拨" , attachmentVersionIds }, `submit-${documentId}`, now);
  const approved = await reviews.approve(hq(financeId), documentId, { expectedVersion: 2, reason: "审核通过待执行" }, `approve-${documentId}`, now);
  assert.deepEqual(approved, { id: documentId, status: "APPROVED", version: 3, replay: false });
  return { documentId, attachmentVersionIds };
};

test("普通报销执行冻结审批链，允许负源余额且只入账一次", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-reimbursement-transfer-"));
  try {
    const accounts = await seed(db.pool, 100);
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const transfer = new PostgresReimbursementTransferService(db.pool, store);
    const personalReads = new PostgresPersonalReadService(db.pool);
    const { documentId, attachmentVersionIds } = await approve(db.pool, store, accounts.applicantId, accounts.financeId);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM ledger_event")).rows[0].count, 0, "批准本身不入账");
    assert.equal((await db.pool.query("SELECT balance_cents::text AS balance FROM account_balance_projection WHERE account_id=$1::uuid", [accounts.destinationAccountId])).rows[0].balance, "20");
    assert.deepEqual(await personalReads.getOwnOverview(personal(accounts.applicantId), at), {
      personId: accounts.applicantId,
      nickname: "reimbursement-transfer-applicant",
      balanceCents: 20n,
      currentYearIncomeByCategory: {},
    });

    const completed = await transfer.execute(hq(accounts.financeId), documentId, { expectedVersion: 3 }, "execute-once", at);
    assert.deepEqual(completed, { id: documentId, status: "COMPLETED", version: 4, replay: false });
    assert.deepEqual(await personalReads.getOwnOverview(personal(accounts.applicantId), at), {
      personId: accounts.applicantId,
      nickname: "reimbursement-transfer-applicant",
      balanceCents: 170n,
      currentYearIncomeByCategory: { reimbursementIncome: 150n },
    });
    assert.deepEqual(await transfer.execute(hq(accounts.financeId), documentId, { expectedVersion: 3 }, "execute-once", new Date("2027-09-01T00:00:00.000Z")), { ...completed, replay: true });
    assert.equal((await personalReads.getOwnOverview(personal(accounts.applicantId), at)).currentYearIncomeByCategory.reimbursementIncome, 150n, "同键重放不重复统计收入");
    assert.deepEqual(await personalReads.getOwnOverview(personal(accounts.financeId), at), {
      personId: accounts.financeId,
      nickname: "reimbursement-transfer-finance",
      balanceCents: 7n,
      currentYearIncomeByCategory: {},
    }, "支出财务的个人账户不混入申请人的普通报销收入");
    assert.deepEqual(await personalReads.getOwnOverview(personal(accounts.applicantId), new Date("2027-08-31T16:00:00.000Z")), {
      personId: accounts.applicantId,
      nickname: "reimbursement-transfer-applicant",
      balanceCents: 170n,
      currentYearIncomeByCategory: {},
    }, "跨财年余额承接，旧年度普通报销不计入新年度收入");
    await assert.rejects(transfer.execute(hq(accounts.financeId), documentId, { expectedVersion: 4 }, "execute-again", at), /REIMBURSEMENT_STATE_CONFLICT/);

    const balances = await db.pool.query("SELECT account_id::text AS id,balance_cents::text AS balance FROM account_balance_projection WHERE account_id=ANY($1::uuid[]) ORDER BY account_id", [[accounts.sourceAccountId, accounts.destinationAccountId]]);
    assert.deepEqual(Object.fromEntries(balances.rows.map(row => [row.id, row.balance])), { [accounts.destinationAccountId]: "170", [accounts.sourceAccountId]: "-50" });
    const transferRow = (await db.pool.query(
      `SELECT source_document_version::text AS source_version,result_document_version::text AS result_version,role_assignment_id::text AS role_id,
              company_fund_assignment_id::text AS fund_assignment_id,source_fund_id::text AS fund_id,source_account_id::text AS source_account,
              destination_account_id::text AS destination_account,amount_cents::text AS amount,reason,executed_by_person_id::text AS executor,
              source_before_cents::text AS source_before,source_after_cents::text AS source_after,destination_before_cents::text AS destination_before,
              destination_after_cents::text AS destination_after,authorization_snapshot FROM finance_reimbursement_transfer WHERE finance_document_id=$1::uuid`, [documentId]
    )).rows[0];
    assert.deepEqual([transferRow.source_version, transferRow.result_version, transferRow.fund_assignment_id, transferRow.fund_id, transferRow.source_account, transferRow.destination_account, transferRow.amount, transferRow.reason, transferRow.executor], ["3", "4", accounts.fundAssignmentId, accounts.fundId, accounts.sourceAccountId, accounts.destinationAccountId, "150", "普通报销真实划拨", accounts.financeId]);
    assert.deepEqual([transferRow.source_before, transferRow.source_after, transferRow.destination_before, transferRow.destination_after], ["100", "-50", "20", "170"]);
    assert.equal(transferRow.authorization_snapshot.executorSubjectCode, "HEADQUARTERS_FINANCE");
    assert.equal(transferRow.authorization_snapshot.sourceAccountId, accounts.sourceAccountId);
    assert.equal(transferRow.authorization_snapshot.destinationAccountId, accounts.destinationAccountId);
    assert.deepEqual((await db.pool.query("SELECT event_key,event_type FROM ledger_event")).rows, [{ event_key: `reimbursement:${documentId}`, event_type: "REIMBURSEMENT_COMPLETED" }]);
    assert.deepEqual((await db.pool.query("SELECT category_key,amount_cents::text AS amount FROM ledger_entry ORDER BY category_key")).rows, [{ category_key: "reimbursementExpense", amount: "-150" }, { category_key: "reimbursementIncome", amount: "150" }]);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM finance_reimbursement_attachment_binding WHERE finance_document_id=$1::uuid AND stage='SUBMISSION' AND document_version=2", [documentId])).rows[0].count, attachmentVersionIds.length);
    await assert.rejects(db.pool.query("UPDATE finance_reimbursement_transfer SET amount_cents=1 WHERE finance_document_id=$1::uuid", [documentId]), /FINANCE_REIMBURSEMENT_TRANSFER_IMMUTABLE/);

    const spool = await new FullBackupSpool({
      source: new PostgresFullBackupSource(db.pool),
      transformer: new FullBackupTransformer({ fingerprint: ({ domain, value }) => createHash("sha256").update(`${domain}:${value}`).digest("hex") }),
      tempRoot: join(root, "spool"),
      batchSize: 1,
    }).create();
    assert.equal(spool.datasets.length, 78, "完整源表目录包括普通报销划拨事实");
    const rowsFor = async (tableName) => {
      const dataset = spool.datasets.find(dataset => dataset.tableName === tableName);
      assert.ok(dataset && !dataset.excluded, tableName);
      const rows = [];
      for await (const values of readBackupSpoolDataset(join(root, "spool", spool.spoolId), dataset))
        rows.push(Object.fromEntries(dataset.columns.map((column, index) => [column, values[index]])));
      return rows;
    };
    const exportedTransfer = (await rowsFor("finance_reimbursement_transfer")).find(row => row.finance_document_id === documentId);
    assert.ok(exportedTransfer);
    assert.deepEqual([exportedTransfer.source_account_id, exportedTransfer.destination_account_id, exportedTransfer.source_after_cents, exportedTransfer.destination_after_cents], [accounts.sourceAccountId, accounts.destinationAccountId, "-50", "170"]);
    const exportedSnapshot = JSON.parse(exportedTransfer.authorization_snapshot);
    assert.equal(exportedSnapshot.executorPersonId, accounts.financeId);
    assert.equal(exportedSnapshot.sourceFundId, accounts.fundId);
    assert.equal(exportedSnapshot.destinationAccountId, accounts.destinationAccountId);
    const exportedEvent = (await rowsFor("finance_document_event")).find(row => row.finance_document_id === documentId && row.event_type === "REIMBURSEMENT_COMPLETED");
    assert.deepEqual(JSON.parse(exportedEvent.details_json), { processingMode: "MANUAL", amountCents: "150", sourceAccountId: accounts.sourceAccountId, destinationAccountId: accounts.destinationAccountId });

    await db.pool.query("ALTER TABLE ledger_entry DISABLE TRIGGER USER");
    await db.pool.query("UPDATE ledger_entry SET category_key='corruptedReimbursementIncome' WHERE event_id=(SELECT ledger_event_id FROM finance_reimbursement_transfer WHERE finance_document_id=$1::uuid) AND amount_cents>0", [documentId]);
    await db.pool.query("ALTER TABLE ledger_entry ENABLE TRIGGER USER");
    await assert.rejects(personalReads.getOwnOverview(personal(accounts.applicantId), at), /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/);
    const assertRestoredIncome = async () => assert.equal((await personalReads.getOwnOverview(personal(accounts.applicantId), at)).currentYearIncomeByCategory.reimbursementIncome, 150n);
    await db.pool.query("ALTER TABLE ledger_entry DISABLE TRIGGER USER");
    await db.pool.query("UPDATE ledger_entry SET category_key='reimbursementIncome' WHERE event_id=(SELECT ledger_event_id FROM finance_reimbursement_transfer WHERE finance_document_id=$1::uuid) AND amount_cents>0", [documentId]);
    await db.pool.query("ALTER TABLE ledger_entry ENABLE TRIGGER USER");
    await assertRestoredIncome();

    await db.pool.query("ALTER TABLE finance_reimbursement_decision DISABLE TRIGGER USER");
    await db.pool.query("UPDATE finance_reimbursement_decision SET authorization_snapshot=jsonb_set(authorization_snapshot,'{reviewerPersonId}',to_jsonb($2::text),true) WHERE finance_document_id=$1::uuid", [documentId, accounts.secondFinanceId]);
    await db.pool.query("ALTER TABLE finance_reimbursement_decision ENABLE TRIGGER USER");
    await assert.rejects(personalReads.getOwnOverview(personal(accounts.applicantId), at), /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/);
    await db.pool.query("ALTER TABLE finance_reimbursement_decision DISABLE TRIGGER USER");
    await db.pool.query("UPDATE finance_reimbursement_decision SET authorization_snapshot=jsonb_set(authorization_snapshot,'{reviewerPersonId}',to_jsonb($2::text),true) WHERE finance_document_id=$1::uuid", [documentId, accounts.financeId]);
    await db.pool.query("ALTER TABLE finance_reimbursement_decision ENABLE TRIGGER USER");
    await assertRestoredIncome();

    for (const operation of ["SUBMIT", "APPROVE"]) {
      await db.pool.query("ALTER TABLE finance_reimbursement_command_idempotency DISABLE TRIGGER USER");
      await db.pool.query("UPDATE finance_reimbursement_command_idempotency SET created_at=$3::timestamptz WHERE finance_document_id=$1::uuid AND operation=$2", [documentId, operation, new Date(at.getTime() - 1_000).toISOString()]);
      await db.pool.query("ALTER TABLE finance_reimbursement_command_idempotency ENABLE TRIGGER USER");
      await assert.rejects(personalReads.getOwnOverview(personal(accounts.applicantId), at), /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/, `${operation} 封口被篡改必须拒绝个人收入读取`);
      await db.pool.query("ALTER TABLE finance_reimbursement_command_idempotency DISABLE TRIGGER USER");
      await db.pool.query("UPDATE finance_reimbursement_command_idempotency SET created_at=$3::timestamptz WHERE finance_document_id=$1::uuid AND operation=$2", [documentId, operation, at.toISOString()]);
      await db.pool.query("ALTER TABLE finance_reimbursement_command_idempotency ENABLE TRIGGER USER");
      await assertRestoredIncome();
    }
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("普通报销执行拒绝越权、跨财年和损坏的已绑定原件，且不产生部分账务", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-reimbursement-transfer-boundary-"));
  try {
    const accounts = await seed(db.pool, 1000);
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const transfer = new PostgresReimbursementTransferService(db.pool, store);
    const unauthorized = await approve(db.pool, store, accounts.applicantId, accounts.financeId);
    await assert.rejects(transfer.execute(personal(accounts.applicantId), unauthorized.documentId, { expectedVersion: 3 }, "not-finance", at), /FORBIDDEN_SCOPE/);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM ledger_event WHERE event_key=$1", [`reimbursement:${unauthorized.documentId}`])).rows[0].count, 0);
    const impersonated = await approve(db.pool, store, accounts.applicantId, accounts.financeId);
    await assert.rejects(transfer.execute(hq(accounts.applicantId), impersonated.documentId, { expectedVersion: 3 }, "hq-without-assignment", at), /HEADQUARTERS_FINANCE_ASSIGNMENT_AMBIGUOUS/);

    const inactiveFund = await approve(db.pool, store, accounts.applicantId, accounts.financeId);
    await db.pool.query("UPDATE company_finance_fund SET status='INACTIVE',version=2,updated_at=$2::timestamptz WHERE id=$1::uuid", [accounts.fundId, at.toISOString()]);
    await assert.rejects(transfer.execute(hq(accounts.financeId), inactiveFund.documentId, { expectedVersion: 3 }, "inactive-fund", at), /COMPANY_FUND_ASSIGNMENT_NOT_FOUND/);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM ledger_event WHERE event_key=$1", [`reimbursement:${inactiveFund.documentId}`])).rows[0].count, 0);
    await db.pool.query("UPDATE company_finance_fund SET status='ACTIVE',version=3,updated_at=$2::timestamptz WHERE id=$1::uuid", [accounts.fundId, at.toISOString()]);

    const crossAt = new Date("2026-08-31T15:59:00.000Z");
    const cross = await approve(db.pool, store, accounts.applicantId, accounts.financeId, { at: crossAt });
    await assert.rejects(transfer.execute(hq(accounts.financeId), cross.documentId, { expectedVersion: 3 }, "cross-year", new Date("2026-08-31T16:00:00.000Z")), /REIMBURSEMENT_CROSS_FINANCE_YEAR_PENDING/);
    assert.deepEqual((await db.pool.query("SELECT status,version::text AS version FROM finance_document WHERE id=$1::uuid", [cross.documentId])).rows, [{ status: "APPROVED", version: "3" }]);

    const corrupted = await approve(db.pool, store, accounts.applicantId, accounts.financeId);
    await rm(join(root, "objects", corrupted.attachmentVersionIds[0]), { force: true });
    await assert.rejects(transfer.execute(hq(accounts.financeId), corrupted.documentId, { expectedVersion: 3 }, "corrupted-evidence", at), /ATTACHMENT_INTEGRITY_FAILED/);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM ledger_event WHERE event_key=$1", [`reimbursement:${corrupted.documentId}`])).rows[0].count, 0);
    assert.deepEqual((await db.pool.query("SELECT status,version::text AS version FROM finance_document WHERE id=$1::uuid", [corrupted.documentId])).rows, [{ status: "APPROVED", version: "3" }]);

    const tamperedSnapshot = await approve(db.pool, store, accounts.applicantId, accounts.financeId);
    await db.pool.query("ALTER TABLE finance_reimbursement_decision DISABLE TRIGGER USER");
    await db.pool.query("UPDATE finance_reimbursement_decision SET authorization_snapshot=jsonb_set(authorization_snapshot,'{reviewerPersonId}',to_jsonb($2::text),true) WHERE finance_document_id=$1::uuid", [tamperedSnapshot.documentId, accounts.secondFinanceId]);
    await db.pool.query("ALTER TABLE finance_reimbursement_decision ENABLE TRIGGER USER");
    await assert.rejects(transfer.execute(hq(accounts.financeId), tamperedSnapshot.documentId, { expectedVersion: 3 }, "tampered-decision-snapshot", at), /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM ledger_event WHERE event_key=$1", [`reimbursement:${tamperedSnapshot.documentId}`])).rows[0].count, 0);
    assert.deepEqual((await db.pool.query("SELECT status FROM finance_document WHERE id=$1::uuid", [tamperedSnapshot.documentId])).rows, [{ status: "APPROVED" }]);

    const tamperedSeal = await approve(db.pool, store, accounts.applicantId, accounts.financeId);
    await db.pool.query("ALTER TABLE finance_reimbursement_command_idempotency DISABLE TRIGGER USER");
    await db.pool.query("UPDATE finance_reimbursement_command_idempotency SET created_at=$2::timestamptz WHERE finance_document_id=$1::uuid AND operation='APPROVE'", [tamperedSeal.documentId, new Date(at.getTime() - 1_000).toISOString()]);
    await db.pool.query("ALTER TABLE finance_reimbursement_command_idempotency ENABLE TRIGGER USER");
    await assert.rejects(transfer.execute(hq(accounts.financeId), tamperedSeal.documentId, { expectedVersion: 3 }, "tampered-approval-seal", at), /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM ledger_event WHERE event_key=$1", [`reimbursement:${tamperedSeal.documentId}`])).rows[0].count, 0);

    const futureApprovalAt = new Date(at.getTime() + 60_000);
    const futureApproval = await approve(db.pool, store, accounts.applicantId, accounts.financeId, { at: futureApprovalAt });
    await assert.rejects(transfer.execute(hq(accounts.financeId), futureApproval.documentId, { expectedVersion: 3 }, "before-approval", at), /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM ledger_event WHERE event_key=$1", [`reimbursement:${futureApproval.documentId}`])).rows[0].count, 0);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("普通报销并发执行与末端存储失败均不重复或遗留单边账务", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-reimbursement-transfer-atomic-"));
  try {
    const accounts = await seed(db.pool, 1000);
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const transfer = new PostgresReimbursementTransferService(db.pool, store);
    const concurrent = await approve(db.pool, store, accounts.applicantId, accounts.financeId);
    const attempts = await Promise.allSettled([
      transfer.execute(hq(accounts.financeId), concurrent.documentId, { expectedVersion: 3 }, "first", at),
      transfer.execute(hq(accounts.secondFinanceId), concurrent.documentId, { expectedVersion: 3 }, "second", at)
    ]);
    assert.equal(attempts.filter(attempt => attempt.status === "fulfilled").length, 1);
    assert.match(String(attempts.find(attempt => attempt.status === "rejected")?.reason), /REIMBURSEMENT_STATE_CONFLICT/);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM ledger_event WHERE event_key=$1", [`reimbursement:${concurrent.documentId}`])).rows[0].count, 1);

    const rollback = await approve(db.pool, store, accounts.applicantId, accounts.financeId);
    await db.pool.query("CREATE FUNCTION force_reimbursement_transfer_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST_REIMBURSEMENT_TRANSFER_FAILURE'; END; $$");
    await db.pool.query("CREATE TRIGGER force_reimbursement_transfer_failure BEFORE INSERT ON finance_reimbursement_transfer FOR EACH ROW EXECUTE FUNCTION force_reimbursement_transfer_failure()");
    await assert.rejects(transfer.execute(hq(accounts.financeId), rollback.documentId, { expectedVersion: 3 }, "rollback", at), /TEST_REIMBURSEMENT_TRANSFER_FAILURE/);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM ledger_event WHERE event_key=$1", [`reimbursement:${rollback.documentId}`])).rows[0].count, 0);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM finance_reimbursement_command_idempotency WHERE finance_document_id=$1::uuid AND operation='EXECUTE'", [rollback.documentId])).rows[0].count, 0);
    assert.deepEqual((await db.pool.query("SELECT status,version::text AS version FROM finance_document WHERE id=$1::uuid", [rollback.documentId])).rows, [{ status: "APPROVED", version: "3" }]);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
