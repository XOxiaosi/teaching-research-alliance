import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { FullBackupPayrollWorkbookExporter } from "../dist/full-backup-payroll-workbook-exporter.js";
import { BACKUP_MAX_DATA_ROWS, createFullBackupLayout } from "../dist/full-backup-layout.js";
import { fullBackupOutputColumns } from "../dist/full-backup-transformer.js";
import { splitBackupLongText, restoreBackupLongText } from "../dist/full-backup-long-text.js";

const run = promisify(execFile);
const digest = (content) => createHash("sha256").update(content, "utf8").digest("hex");
const valuesFor = (columns, record = {}) => columns.map((column) => record[column] ?? null);
const layout = createFullBackupLayout();

const createCompleteSpool = async (records = {}) => {
  const root = await mkdtemp(join(tmpdir(), "payroll-workbook-"));
  const directory = join(root, "spool");
  await mkdir(join(directory, "datasets"), { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await chmod(join(directory, "datasets"), 0o700);
  const datasets = [];
  for (const [index, item] of layout.entries()) {
    const excluded = item.policy === "AUTH_SECRET_TABLE_EXCLUDED";
    if (excluded) {
      datasets.push({ tableName: item.tableName, columns: [], rowCount: null, logicalDigest: null, spoolFile: null, excluded: true });
      continue;
    }
    const columns = fullBackupOutputColumns(item.tableName);
    const rows = (records[item.tableName] ?? []).map((record) => valuesFor(columns, record));
    const content = `${JSON.stringify({ columns })}\n${rows.map((row) => `${JSON.stringify(row)}\n`).join("")}`;
    const spoolFile = `datasets/${String(index + 1).padStart(3, "0")}_${item.tableName}.ndjson`;
    await writeFile(join(directory, spoolFile), content, { mode: 0o600 });
    datasets.push({ tableName: item.tableName, columns, rowCount: String(rows.length), logicalDigest: digest(content), spoolFile, excluded: false });
  }
  await writeFile(join(directory, "anomalies.ndjson"), "", { mode: 0o600 });
  return {
    root, directory, datasets,
    spool: {
      mode: "RAW_SOURCE_SPOOL", spoolId: "synthetic-payroll-spool", snapshotId: "synthetic-payroll-snapshot", asOf: "2026-09-23T00:00:00.000Z",
      datasets, anomalyFile: "anomalies.ndjson", anomalyCount: "0", coverageGaps: [
        "MONTHLY_INCOME_PUBLISHED_VERSIONS_NOT_IMPLEMENTED",
        "MANUAL_ADJUSTMENT_WORKFLOW_NOT_IMPLEMENTED",
        "BACKUP_JOB_AND_SCHEDULE_HISTORY_NOT_IMPLEMENTED",
      ],
    },
    datasetFile: (tableName) => join(directory, datasets.find((dataset) => dataset.tableName === tableName).spoolFile),
  };
};

const workbookSheets = async (workbook) => {
  const { stdout } = await run("python3", ["-c", `import zipfile,xml.etree.ElementTree as E,json,sys
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
book=E.fromstring(z.read('xl/workbook.xml')); rels=E.fromstring(z.read('xl/_rels/workbook.xml.rels'))
targets={r.attrib['Id']:r.attrib['Target'] for r in rels}; out={}
for s in book.findall('.//m:sheet',ns):
 root=E.fromstring(z.read('xl/'+targets[s.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]))
 assert not root.findall('.//m:f',ns)
 rows=[]
 for row in root.findall('.//m:row',ns):
  cells=row.findall('m:c',ns); assert all(c.attrib.get('t')=='inlineStr' for c in cells)
  rows.append([c.find('.//m:t',ns).text or '' for c in cells])
 out[s.attrib['name']]=rows
print(json.dumps(out,ensure_ascii=False))`, workbook], { maxBuffer: 12 * 1024 * 1024 });
  return JSON.parse(stdout);
};

const sourceFacts = (longReason) => ({
  finance_document: [
    { id: "payroll-doc", applicant_person_id: "teacher-1", kind: "CASH_WAGE", status: "CONFIRMED", version: "1", created_at: "2026-09-23T00:00:00.000Z", updated_at: "2026-09-23T00:00:00.000Z" },
    { id: "unrelated-refund-doc", applicant_person_id: "student-1", kind: "REFUND", status: "APPROVED", version: "7", created_at: "2026-09-23T00:00:00.000Z", updated_at: "2026-09-23T00:00:00.000Z" },
  ],
  cash_wage_plan_version: [{ id: "plan-v1", teacher_person_id: "teacher-1", salary_month: "2026-09", version_no: "1", planned_cash_cents: "5300", planned_deduction_cents: null, active: "true", changed_by_person_id: "admin-1", changed_at: "2026-09-01T00:00:00.000Z", reason: longReason, applies_to_future_months: "false" }],
  cash_wage_todo: [{ id: "todo-1", teacher_person_id: "teacher-1", salary_month: "2026-09", plan_version_id: "plan-v1", generated_at: "2026-09-01T00:00:00.000Z" }],
  cash_wage_confirmation: [{ finance_document_id: "payroll-doc", todo_id: "todo-1", teacher_person_id: "teacher-1", destination_account_id: "teacher-account", salary_month: "2026-09", cash_paid_cents: "5300", deduction_cents: "50", paid_at: "2026-09-02T00:00:00.000Z", reason: "confirmed", ledger_event_id: "ledger-event-1", confirmed_by_person_id: "admin-1", created_at: "2026-09-02T00:00:00.000Z", correction_of_finance_document_id: null, destination_before_cents: "100", destination_after_cents: "50" }],
  project_bonus_transfer: [{ finance_document_id: "bonus-doc", project_no: "P1", project_name: "奖金一", recipient_person_id: "teacher-1", destination_account_id: "teacher-account", source_fund_id: "fund-1", source_account_id: "fund-account", amount_cents: "80", reason: "bonus", ledger_event_id: "ledger-event-2", granted_by_person_id: "admin-1", created_at: "2026-09-03T00:00:00.000Z", project_name_version_id: "project-name-v1" }],
  bonus_project_name_version: [{ id: "project-name-v1", project_no: "P1", version_no: "1", display_name: "奖金一", changed_by_person_id: "admin-1", actor_subject_code: "ADMIN", actor_scope_type: "GLOBAL", change_source: "RENAME", reason: "initial", created_at: "2026-09-01T00:00:00.000Z" }],
  salary_benefit_reversal: [{ reversal_finance_document_id: "reversal-doc", original_finance_document_id: "payroll-doc", original_ledger_event_id: "ledger-event-1", reversal_ledger_event_id: "ledger-event-3", reversed_by_person_id: "admin-1", reason: "correction", created_at: "2026-09-04T00:00:00.000Z" }],
  ledger_entry: [
    { id: "ledger-1", event_id: "ledger-event-1", account_id: "teacher-account", category_key: "CASH_WAGE", amount_cents: "-50", created_at: "2026-09-02T00:00:00.000Z" },
    { id: "ledger-unrelated", event_id: "refund-event", account_id: "refund-account", category_key: "REFUND", amount_cents: "-77", created_at: "2026-09-03T00:00:00.000Z" },
  ],
});

test("exports table 5 source facts without joins, preserving long text and NULL coordinates in the same XLSX", async () => {
  const longReason = `原因-${"汉".repeat(32_000)}😀`;
  const expectedLong = splitBackupLongText(longReason);
  const fixture = await createCompleteSpool(sourceFacts(longReason));
  try {
    const outputRoot = join(fixture.root, "out");
    const result = await new FullBackupPayrollWorkbookExporter({ spoolDirectory: fixture.directory, spool: fixture.spool, outputRoot }).export();
    assert.equal(result.mode, "BUSINESS_FACTS_WORKBOOK");
    assert.equal(result.complete, false);
    assert.deepEqual(result.coveredTables, [5]);
    assert.equal(result.snapshotId, "synthetic-payroll-snapshot");
    assert.equal(result.spoolId, "synthetic-payroll-spool");
    assert.equal(result.gaps.includes("BUSINESS_TABLES_1_TO_4_6_TO_8_NOT_INCLUDED"), true);
    assert.equal(result.sourceRows.find((row) => row.sourceTable === "finance_document").rowCount, "2");
    assert.equal(result.sourceRows.find((row) => row.sourceTable === "ledger_entry").rowCount, "2");
    const directory = join(outputRoot, result.outputId);
    assert.deepEqual(await readdir(directory), [result.file]);
    assert.equal((await stat(directory)).mode & 0o077, 0);
    const bytes = await readFile(join(directory, result.file));
    assert.equal(result.sizeBytes, String(bytes.byteLength));
    assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));

    const sheets = await workbookSheets(join(directory, result.file));
    const explanation = sheets["00_说明"];
    assert.ok(explanation);
    assert.equal(explanation.some((row) => row[0] === "完整备份" && row[1] === "false"), true);
    assert.equal(explanation.some((row) => row[0] === "完整关联来源" && row[1].includes("筛选")), true);
    const planSheet = Object.values(sheets).find((rows) => rows[0]?.some((cell) => cell.endsWith("[reason]")) && rows.some((row) => row.includes("plan-v1")));
    const financeSheet = Object.values(sheets).find((rows) => rows[0]?.some((cell) => cell.endsWith("[kind]")) && rows.some((row) => row.includes("unrelated-refund-doc")));
    const ledgerSheet = Object.values(sheets).find((rows) => rows[0]?.some((cell) => cell.endsWith("[category_key]")) && rows.some((row) => row.includes("ledger-unrelated")));
    assert.ok(planSheet); assert.ok(financeSheet); assert.ok(ledgerSheet);
    const reasonColumn = planSheet[0].findIndex((cell) => cell.endsWith("[reason]"));
    const deductionColumn = planSheet[0].findIndex((cell) => cell.endsWith("[planned_deduction_cents]"));
    assert.equal(planSheet[1][reasonColumn], expectedLong.reference);
    assert.equal(planSheet[1][deductionColumn], "");
    assert.equal(financeSheet.some((row) => row.includes("REFUND")), true);
    assert.equal(ledgerSheet.some((row) => row.includes("REFUND")), true);
    const longSheet = sheets["14_长文本"];
    const nullSheet = sheets["15_NULL坐标"];
    assert.ok(longSheet); assert.ok(nullSheet);
    assert.equal(longSheet[0].join(","), "long_text_ref,source_table,source_record_key,source_row_number,field_name,part_no,part_text");
    assert.equal(nullSheet[0].join(","), "source_table,source_record_key,source_row_number,field_name");
    const chunks = longSheet.slice(1).filter((row) => row[4] === "reason").map((row) => row[6]);
    assert.equal(restoreBackupLongText({ ...expectedLong, chunks }), longReason);
    const planKey = JSON.stringify([["id", "plan-v1"]]);
    assert.equal(nullSheet.slice(1).some((row) => row.join("/") === `cash_wage_plan_version/${planKey}/1/planned_deduction_cents`), true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("rejects a changed table-5 spool and removes only its new attempt directory", async () => {
  const fixture = await createCompleteSpool(sourceFacts("normal"));
  try {
    const file = fixture.datasetFile("cash_wage_plan_version");
    const original = await readFile(file, "utf8");
    await writeFile(file, original.replace("normal", "tampered"), { mode: 0o600 });
    const outputRoot = join(fixture.root, "out");
    await assert.rejects(
      () => new FullBackupPayrollWorkbookExporter({ spoolDirectory: fixture.directory, spool: fixture.spool, outputRoot }).export(),
      /EXPORT_SPOOL_INTEGRITY_FAILED/,
    );
    assert.deepEqual(await readdir(outputRoot), []);
    assert.equal((await readdir(fixture.directory)).includes("datasets"), true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("uses one sequential pager for source, long-text and NULL pages while preserving multi-byte UTF-8 across read chunks", async () => {
  const longReason = `跨块-${"汉".repeat(96_000)}😀`;
  const expectedLong = splitBackupLongText(longReason);
  const facts = sourceFacts(longReason);
  facts.cash_wage_plan_version = [
    ...facts.cash_wage_plan_version,
    { ...facts.cash_wage_plan_version[0], id: "plan-v2", version_no: "2", reason: "second", planned_deduction_cents: null },
    { ...facts.cash_wage_plan_version[0], id: "plan-v3", version_no: "3", reason: "third", planned_deduction_cents: null },
  ];
  const fixture = await createCompleteSpool(facts);
  try {
    const result = await new FullBackupPayrollWorkbookExporter({
      spoolDirectory: fixture.directory, spool: fixture.spool, outputRoot: join(fixture.root, "out"), maxDataRows: 1,
    }).export();
    const sheets = await workbookSheets(join(fixture.root, "out", result.outputId, result.file));
    const planPages = Object.entries(sheets).filter(([name]) => name.startsWith("T5_02_工资计划版本_")).map(([, rows]) => rows);
    const longPages = Object.entries(sheets).filter(([name]) => name.startsWith("14_长文本_")).map(([, rows]) => rows);
    const nullPages = Object.entries(sheets).filter(([name]) => name.startsWith("15_NULL坐标_")).map(([, rows]) => rows);
    assert.equal(planPages.length, 3);
    assert.ok(longPages.length >= 3);
    assert.ok(nullPages.length >= 3);
    assert.deepEqual(planPages.map((rows) => rows[1][0]), [
      JSON.stringify([["id", "plan-v1"]]), JSON.stringify([["id", "plan-v2"]]), JSON.stringify([["id", "plan-v3"]]),
    ]);
    const chunks = longPages.flatMap((rows) => rows.slice(1)).filter((row) => row[4] === "reason").map((row) => row[6]);
    assert.equal(restoreBackupLongText({ ...expectedLong, chunks }), longReason);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("writer failure after indexed rows closes the attempt and retains a prior successful package", async () => {
  const fixture = await createCompleteSpool(sourceFacts(`failure-${"汉".repeat(32_000)}`));
  try {
    const outputRoot = join(fixture.root, "out");
    const stable = await new FullBackupPayrollWorkbookExporter({ spoolDirectory: fixture.directory, spool: fixture.spool, outputRoot }).export();
    const stableFile = join(outputRoot, stable.outputId, stable.file);
    const stableHash = createHash("sha256").update(await readFile(stableFile)).digest("hex");
    let reachedLongText = false;
    await assert.rejects(
      () => new FullBackupPayrollWorkbookExporter({
        spoolDirectory: fixture.directory, spool: fixture.spool, outputRoot, maxDataRows: 1,
        async writeWorkbook({ sheets }) {
          for (const sheet of sheets) {
            if (sheet.rows) for await (const _ of sheet.rows) {
              if (sheet.name.startsWith("14_长文本")) {
                reachedLongText = true;
                throw new Error("TEST_PAYROLL_WORKBOOK_WRITER_FAILURE");
              }
            }
          }
        },
      }).export(),
      /TEST_PAYROLL_WORKBOOK_WRITER_FAILURE/,
    );
    assert.equal(reachedLongText, true);
    assert.deepEqual(await readdir(outputRoot), [stable.outputId]);
    assert.equal(createHash("sha256").update(await readFile(stableFile)).digest("hex"), stableHash);
    assert.throws(
      () => new FullBackupPayrollWorkbookExporter({ spoolDirectory: fixture.directory, spool: fixture.spool, outputRoot, maxDataRows: BACKUP_MAX_DATA_ROWS + 1 }),
      /EXPORT_PAYROLL_WORKBOOK_PAGE_SIZE_INVALID/,
    );
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
