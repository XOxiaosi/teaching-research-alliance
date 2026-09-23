import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  LocalAttachmentStore,
  PostgresFinanceAttachmentService,
  PostgresFinanceAttachmentUploadService,
  PostgresSalaryBenefitsService,
} from "../../../api/dist/main.js";
import { PostgresWeeklySettlementService } from "../../../api/dist/postgres-weekly-settlement-service.js";
import { createTestDatabase } from "../../../api/test/integration/postgres-test-database.mjs";
import { FullBackupBusinessFactsView } from "../../dist/full-backup-business-facts-view.js";
import { FullBackupDeductionWorkbookExporter } from "../../dist/full-backup-deduction-workbook-exporter.js";
import { FullBackupPerformanceConfigurationWorkbookExporter } from "../../dist/full-backup-performance-configuration-workbook-exporter.js";
import { FullBackupSpool } from "../../dist/full-backup-spool.js";
import { FullBackupTransformer } from "../../dist/full-backup-transformer.js";
import { PostgresFullBackupSource } from "../../dist/postgres-full-backup-source.js";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const at = new Date("2026-09-21T09:00:00.000Z");
const dueAt = new Date("2026-09-05T00:00:00.000Z");
const month = "2026-09-01";
const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 124) });
const pngSha256 = createHash("sha256").update(png).digest("hex");
const hq = (personId) => ({ personId, subject: "HEADQUARTERS_FINANCE", scope: "GLOBAL" });
const json = (value) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);

const policy = {
  plannerBaseRateBasisPoints: 0n,
  teacherBaseRateBasisPoints: 0n,
  planningMentorWeightBasisPoints: 0n,
  groupLeaderRateBasisPoints: 0n,
  teachingMentorRateBasisPoints: 0n,
  venueRateBasisPoints: 0n,
  campusConsultationForPlannerRateBasisPoints: 0n,
  campusConsultationForTeacherRateBasisPoints: 0n,
  platformFinanceRateBasisPoints: 0n,
  regionFinanceRateBasisPoints: 0n,
  dynamicTiers: [
    { label: "低", maxInclusive: 50000n, adjustmentBasisPoints: 0n },
    { label: "中", minExclusive: 50000n, maxInclusive: 150000n, adjustmentBasisPoints: 0n },
    { label: "高", minExclusive: 150000n, adjustmentBasisPoints: 0n },
  ],
};

const addPerson = (pool, id, nickname) => pool.query(
  "INSERT INTO person(id,nickname,legal_name,status,created_at,updated_at) VALUES($1::uuid,$2,$2,'ACTIVE',$3::timestamptz,$3::timestamptz)",
  [id, nickname, at.toISOString()],
);

const addAccount = async (pool, ownerType, ownerId, code, balance) => {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status,created_at) VALUES($1::uuid,$2,$3::uuid,$4,'ACTIVE',$5::timestamptz)",
    [id, ownerType, ownerId, code, at.toISOString()],
  );
  await pool.query("INSERT INTO account_balance_projection(account_id,balance_cents,updated_at) VALUES($1::uuid,$2::bigint,$3::timestamptz)", [id, String(balance), at.toISOString()]);
  return id;
};

const attachmentVersions = async (attachments, uploads, context, documentId) => {
  const versionIds = [];
  for (const purpose of ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT"]) {
    const reserved = await attachments.reserve(context, documentId, {
      purpose,
      originalFilename: `${purpose}.png`,
      declaredMediaType: "image/png",
      declaredSizeBytes: png.length,
    }, `${documentId}:${purpose}`, dueAt);
    await uploads.upload(context, reserved.versionId, (async function* () { yield png; })(), dueAt);
    versionIds.push(reserved.versionId);
  }
  return versionIds;
};

const sheetsFrom = async (path) => {
  const { stdout } = await run("python3", ["-c", `import zipfile,xml.etree.ElementTree as E,json,sys
z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None
ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
b=E.fromstring(z.read('xl/workbook.xml'));rels=E.fromstring(z.read('xl/_rels/workbook.xml.rels'));t={r.attrib['Id']:r.attrib['Target'] for r in rels};out={}
for s in b.findall('.//m:sheet',ns):
 root=E.fromstring(z.read('xl/'+t[s.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]))
 assert not root.findall('.//m:f',ns); rows=[]
 for row in root.findall('.//m:row',ns):
  cells=row.findall('m:c',ns); assert all(c.attrib.get('t')=='inlineStr' for c in cells)
  rows.append([c.find('.//m:t',ns).text or '' for c in cells])
 out[s.attrib['name']]=rows
print(json.dumps(out,ensure_ascii=False))`, path], { maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
};

const sourceSheet = (sheets, prefix, index) => Object.entries(sheets)
  .find(([name]) => name.startsWith(`${prefix}_${String(index + 1).padStart(2, "0")}_`))?.[1];

const createSpool = (pool, root) => new FullBackupSpool({
  source: new PostgresFullBackupSource(pool),
  transformer: new FullBackupTransformer({
    fingerprint: ({ domain, value }) => createHash("sha256").update(`${domain}:${value}`).digest("hex"),
  }),
  tempRoot: join(root, "spool"),
  batchSize: 1,
}).create();

const sourceValues = async (view, tableNumber, source) => {
  const rows = [];
  for await (const row of view.readSourceRows(tableNumber, source.sourceTable)) {
    rows.push({
      key: row.sourceRecordKey,
      rowNumber: row.rowNumber,
      values: Object.fromEntries(source.columns.map((column, index) => [column.sourceColumn, row.values[index]])),
    });
  }
  return rows;
};

const assertWorkbookMatchesView = async ({ exporter, view, tableNumber, prefix, root, expectedFile, expectedSources, expectedGap }) => {
  const description = view.describe(tableNumber);
  assert.equal(description.mode, "BUSINESS_FACTS_VIEW");
  assert.equal(description.complete, false);
  assert.equal(description.rowModel, "SOURCE_ROWS_ONLY");
  assert.deepEqual(description.sources.map((source) => source.sourceTable), expectedSources);
  const workbook = await exporter.export();
  assert.equal(workbook.mode, "BUSINESS_FACTS_WORKBOOK");
  assert.equal(workbook.complete, false);
  assert.deepEqual(workbook.coveredTables, [tableNumber]);
  assert.equal(workbook.file, expectedFile);
  assert.equal(workbook.schemaVersion, description.schemaVersion);
  assert.equal(JSON.stringify(workbook).includes(root), false);
  assert.equal(workbook.gaps.includes(expectedGap), true);
  const directory = join(root, "out", workbook.outputId);
  assert.deepEqual(await readdir(directory), [workbook.file]);
  const path = join(directory, workbook.file);
  const bytes = await readFile(path);
  assert.equal(workbook.sizeBytes, String(bytes.length));
  assert.equal(workbook.sha256, createHash("sha256").update(bytes).digest("hex"));
  const sheets = await sheetsFrom(path);
  assert.equal(sheets["00_说明"].some((row) => row[0] === "完整备份" && row[1] === "false"), true);
  assert.equal(sheets["00_说明"].some((row) => row[0] === "处理边界" && row[1].includes("不跨源关联、不汇总金额")), true);
  for (const [index, source] of description.sources.entries()) {
    const sheet = sourceSheet(sheets, prefix, index);
    assert.ok(sheet, source.sourceTable);
    assert.deepEqual(sheet[0], ["源记录键", "源行号", ...source.columns.map((column) => `${column.label} [${column.sourceColumn}]`)]);
    const actual = await sourceValues(view, tableNumber, source);
    assert.deepEqual(sheet.slice(1), actual.map((row) => [row.key, row.rowNumber, ...source.columns.map((column) => row.values[column.sourceColumn] ?? "")]));
    assert.equal(workbook.sourceRows.find((item) => item.sourceTable === source.sourceTable)?.rowCount, String(actual.length));
  }
  return { description, workbook, sheets };
};

test("real PG table-6 and table-8 XLSX preserve current benefit and policy allocation facts without joins", async () => {
  const database = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-deduction-performance-workbook-pg-"));
  try {
    const financeId = randomUUID();
    const teacherId = randomUUID();
    const fundId = randomUUID();
    const venueId = randomUUID();
    const yearId = randomUUID();
    const periodId = randomUUID();
    const weekId = randomUUID();
    const studentId = randomUUID();
    const referralId = randomUUID();
    await addPerson(database.pool, financeId, "扣费绩效财务");
    await addPerson(database.pool, teacherId, "扣费绩效教师");
    const sourceAccountId = await addAccount(database.pool, "COMPANY", fundId, `company:${fundId}`, 1000);
    const teacherAccountId = await addAccount(database.pool, "PERSON", teacherId, `person:${teacherId}`, 0);
    await database.pool.query(
      "INSERT INTO company_finance_fund(id,kind,fund_code,display_name,status,version,created_by_person_id,created_at,updated_at) VALUES($1::uuid,'HEADQUARTERS_FINANCE_OPERATING','TABLE_6_8','表6表8真实资金','ACTIVE',1,$2::uuid,$3::timestamptz,$3::timestamptz)",
      [fundId, financeId, at.toISOString()],
    );
    await database.pool.query(
      "INSERT INTO company_finance_fund_assignment(id,fund_id,duty_subject,scope_type,responsibility_code,valid_from,created_by_person_id,created_at) VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL','FINANCE_OPERATING_SOURCE',$3::timestamptz,$4::uuid,$3::timestamptz)",
      [randomUUID(), fundId, "2026-01-01T00:00:00.000Z", financeId],
    );

    const context = hq(financeId);
    const store = await LocalAttachmentStore.create(join(root, "attachments"), resolve(import.meta.dirname, "../../../.."));
    const salary = new PostgresSalaryBenefitsService(database.pool, store);
    const attachments = new PostgresFinanceAttachmentService(database.pool);
    const uploads = new PostgresFinanceAttachmentUploadService(database.pool, store);
    const plan = await salary.setBenefitPlan(context, {
      benefitKind: "SOCIAL_INSURANCE", beneficiaryPersonId: teacherId, benefitMonth: month,
      executionDay: 5, amountCents: "120", sourceFundId: fundId, active: true, reason: "表6真实福利计划",
    }, "table-6-plan", at);
    const todos = await salary.generateBenefitTodos(context, "table-6-generate", dueAt);
    assert.equal(todos.length, 1);
    const document = await salary.createEvidenceDocument(context, "FINANCE_BENEFIT", "table-6-document", dueAt);
    await salary.confirmBenefit(context, {
      documentId: document.id, expectedVersion: 1, todoId: todos[0].id, expectedPlanVersionId: plan.planVersionId,
      reason: "表6真实福利执行", attachmentVersionIds: await attachmentVersions(attachments, uploads, context, document.id),
    }, "table-6-confirm", dueAt);

    await database.pool.query("INSERT INTO venue(id,owner_person_id,name,status,default_for_owner,created_at,updated_at) VALUES($1::uuid,$2::uuid,'表8真实场地','ACTIVE',true,$3::timestamptz,$3::timestamptz)", [venueId, teacherId, at.toISOString()]);
    await database.pool.query("INSERT INTO academic_year_plan(id,label,starts_on,ends_on,created_by,created_at) VALUES($1::uuid,'表8学年','2026-09-01','2027-08-31',$2::uuid,$3::timestamptz)", [yearId, financeId, at.toISOString()]);
    await database.pool.query("INSERT INTO academic_period(id,academic_year_plan_id,label,starts_on,ends_on,created_at) VALUES($1::uuid,$2::uuid,'表8秋季','2026-09-01','2026-12-31',$3::timestamptz)", [periodId, yearId, at.toISOString()]);
    await database.pool.query("INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month,status,created_at) VALUES($1::uuid,$2::uuid,1,'REGULAR','2026-09-07','2026-09-13',$3::date,'OPEN',$4::timestamptz)", [weekId, periodId, month, at.toISOString()]);
    await database.pool.query("INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name,created_at,updated_at) VALUES($1::uuid,$2::uuid,'table-8-course','表8学生',$3::timestamptz,$3::timestamptz)", [studentId, teacherId, at.toISOString()]);
    await database.pool.query("INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,version,created_at,updated_at) VALUES($1::uuid,$2::uuid,$3::uuid,$3::uuid,'TEACHING_TEACHER','ACCEPTED',$4::timestamptz,2,$4::timestamptz,$4::timestamptz)", [referralId, studentId, teacherId, at.toISOString()]);
    const policyVersionId = randomUUID();
    await database.pool.query("INSERT INTO rate_policy_version(id,version,effective_from,policy_json,reason,published_by,published_at) VALUES($1::uuid,1,$2::date,$3::jsonb,'表8真实策略',$4::uuid,$5::timestamptz)", [policyVersionId, month, json(policy), financeId, at.toISOString()]);
    const weekly = new PostgresWeeklySettlementService(database.pool);
    const settled = await weekly.recordAndSettle(teacherId, {
      referralCaseId: referralId, teachingWeekId: weekId, venueId, settlementMonth: month,
      grossAmountCents: 300n, expectedVersion: 0,
    }, "table-8-weekly-settlement");
    assert.equal(settled.replay, false);

    const spool = await createSpool(database.pool, root);
    const view = new FullBackupBusinessFactsView({ spoolDirectory: join(root, "spool", spool.spoolId), spool });
    const deduction = await assertWorkbookMatchesView({
      exporter: new FullBackupDeductionWorkbookExporter({ spoolDirectory: join(root, "spool", spool.spoolId), spool, outputRoot: join(root, "out") }),
      view, tableNumber: 6, prefix: "T6", root, expectedFile: "business-table-6-deduction-facts.xlsx",
      expectedSources: ["finance_benefit_plan_version", "finance_benefit_todo", "finance_benefit_execution"],
      expectedGap: "PROJECT_DEDUCTION_1_TO_10_NOT_IMPLEMENTED",
    });
    const plans = await sourceValues(view, 6, deduction.description.sources[0]);
    const todosFromView = await sourceValues(view, 6, deduction.description.sources[1]);
    const executions = await sourceValues(view, 6, deduction.description.sources[2]);
    assert.equal(plans.some((row) => row.key === `[["id","${plan.planVersionId}"]]` && row.values.amount_cents === "120"), true);
    assert.equal(todosFromView.some((row) => row.key === `[["id","${todos[0].id}"]]`), true);
    assert.equal(executions.some((row) => row.key === `[["finance_document_id","${document.id}"]]` && row.values.source_account_id === sourceAccountId && row.values.amount_cents === "120"), true);

    const performance = await assertWorkbookMatchesView({
      exporter: new FullBackupPerformanceConfigurationWorkbookExporter({ spoolDirectory: join(root, "spool", spool.spoolId), spool, outputRoot: join(root, "out") }),
      view, tableNumber: 8, prefix: "T8", root, expectedFile: "business-table-8-performance-configuration-facts.xlsx",
      expectedSources: ["rate_policy_version", "weekly_fee_allocation_snapshot"],
      expectedGap: "PER_TEACHER_RATE_OVERRIDE_NOT_IMPLEMENTED",
    });
    assert.equal(performance.workbook.gaps.includes("CLASS_TYPE_RATE_CONFIG_NOT_IMPLEMENTED"), true);
    const policies = await sourceValues(view, 8, performance.description.sources[0]);
    const allocations = await sourceValues(view, 8, performance.description.sources[1]);
    assert.equal(policies.some((row) => row.key === `[["id","${policyVersionId}"]]` && row.values.version === "1" && JSON.parse(row.values.policy_json).teacherBaseRateBasisPoints === "0"), true);
    const allocation = allocations.find((row) => row.values.policy_version_id === policyVersionId);
    assert.ok(allocation, "real weekly settlement creates a persisted allocation snapshot");
    assert.equal(JSON.parse(allocation.values.context_json).feeEntryId, settled.fee.id);
    assert.deepEqual(JSON.parse(allocation.values.snapshot_json).accountByKey, { teachingTeacher: `person:${teacherId}` });
    const exportedLines = JSON.parse(allocation.values.snapshot_json).lines;
    assert.equal(exportedLines.find((line) => line.key === "teachingTeacher")?.cents, "300");
    assert.equal(exportedLines.reduce((total, line) => total + BigInt(line.cents), 0n), 300n);
    assert.equal(JSON.parse(allocation.values.context_json).accounts.teachingTeacher.accountId, teacherAccountId);
  } finally {
    await rm(root, { recursive: true, force: true });
    await database.close();
  }
});
