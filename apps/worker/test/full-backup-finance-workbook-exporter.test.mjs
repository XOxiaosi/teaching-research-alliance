import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { FullBackupBusinessFactsWorkbookExporter } from "../dist/full-backup-business-facts-workbook-exporter.js";
import { FullBackupFinanceWorkbookExporter } from "../dist/full-backup-finance-workbook-exporter.js";
import { BUSINESS_BACKUP_SHEETS } from "../dist/full-backup-business-schema.js";
import { createFullBackupLayout } from "../dist/full-backup-layout.js";
import { EXPORT_SCHEMA_REGISTRY } from "../dist/export-schema-registry.js";
import { FullBackupBusinessFactsView } from "../dist/full-backup-business-facts-view.js";
import { fullBackupOutputColumns } from "../dist/full-backup-transformer.js";
import { restoreBackupLongText, splitBackupLongText } from "../dist/full-backup-long-text.js";

const run = promisify(execFile);
const digest = (content) => createHash("sha256").update(content, "utf8").digest("hex");
const layout = createFullBackupLayout();
const table4 = BUSINESS_BACKUP_SHEETS.find((sheet) => sheet.tableNumber === 4);
assert.ok(table4);
const table4Sources = [...new Set([...table4.rowKeyColumns, ...table4.columns].map((column) => column.sourceTable))];
const table4ChineseSourceTitles = [
  "财务单据", "财务单据事件", "提现提交", "提现办理", "提现撤回", "报销提交", "报销审批", "报销附件绑定",
  "报销命令封口", "报销内部冲回", "报销内部划拨", "自采买划拨", "自采买冲回", "退款提交", "退款审批", "财务附件", "财务附件版本",
];

const valuesFor = (columns, record = {}) => columns.map((column) => record[column] ?? null);
const outputKeyRecord = (tableName, suffix = "1") => {
  const columns = fullBackupOutputColumns(tableName);
  const registered = EXPORT_SCHEMA_REGISTRY.find((item) => item.name === tableName);
  assert.ok(registered);
  const record = Object.fromEntries(columns.map((column) => [column, `${tableName}:${column}:${suffix}`]));
  for (const key of registered.orderBy) {
    const output = columns.includes(key) ? key : `${key}_fingerprint`;
    record[output] = `${tableName}:key:${key}:${suffix}`;
  }
  return record;
};
const financeFacts = (longReason) => {
  const records = Object.fromEntries(table4Sources.map((source) => [source, [outputKeyRecord(source)]]));
  const transfer = records.finance_reimbursement_transfer[0];
  Object.assign(transfer, {
    finance_document_id: "reimbursement-document-1", role_assignment_id: "role-assignment-1",
    company_fund_assignment_id: "fund-assignment-1", source_fund_id: "fund-1", source_account_id: "company-account-1",
    destination_account_id: "person-account-1", amount_cents: "150", source_before_cents: "100", source_after_cents: "-50",
    destination_before_cents: "20", destination_after_cents: "170", authorization_snapshot: '{"executorPersonId":"finance-1"}',
  });
  Object.assign(records.finance_reimbursement_submission[0], {
    finance_document_id: "reimbursement-document-1", reason: longReason, amount_cents: "150", destination_account_id: "person-account-1",
  });
  Object.assign(records.finance_reimbursement_attachment_binding[0], {
    finance_document_id: "reimbursement-document-1", stage: "SUBMIT", finance_attachment_version_id: "attachment-version-1",
  });
  Object.assign(records.finance_reimbursement_command_idempotency[0], {
    actor_person_id: "finance-1", operation: "EXECUTE", idempotency_key_fingerprint: "f".repeat(64), finance_document_id: "reimbursement-document-1",
  });
  records.finance_document_event[0].ledger_event_id = null;
  records.finance_document.push(outputKeyRecord("finance_document", "2"));
  return records;
};

const createCompleteSpool = async (records = {}) => {
  const root = await mkdtemp(join(tmpdir(), "finance-workbook-"));
  const directory = join(root, "spool");
  await mkdir(join(directory, "datasets"), { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700); await chmod(join(directory, "datasets"), 0o700);
  const datasets = [];
  for (const [index, item] of layout.entries()) {
    const excluded = item.policy === "AUTH_SECRET_TABLE_EXCLUDED";
    if (excluded) { datasets.push({ tableName: item.tableName, columns: [], rowCount: null, logicalDigest: null, spoolFile: null, excluded: true }); continue; }
    const columns = fullBackupOutputColumns(item.tableName);
    const rows = (records[item.tableName] ?? []).map((record) => valuesFor(columns, record));
    const content = `${JSON.stringify({ columns })}\n${rows.map((row) => `${JSON.stringify(row)}\n`).join("")}`;
    const spoolFile = `datasets/${String(index + 1).padStart(3, "0")}_${item.tableName}.ndjson`;
    await writeFile(join(directory, spoolFile), content, { mode: 0o600 });
    datasets.push({ tableName: item.tableName, columns, rowCount: String(rows.length), logicalDigest: digest(content), spoolFile, excluded: false });
  }
  await writeFile(join(directory, "anomalies.ndjson"), "", { mode: 0o600 });
  return { root, directory, datasets, spool: {
    mode: "RAW_SOURCE_SPOOL", spoolId: "synthetic-finance-spool", snapshotId: "synthetic-finance-snapshot", asOf: "2026-09-23T00:00:00.000Z",
    datasets, anomalyFile: "anomalies.ndjson", anomalyCount: "0", coverageGaps: [
      "MONTHLY_INCOME_PUBLISHED_VERSIONS_NOT_IMPLEMENTED", "MANUAL_ADJUSTMENT_WORKFLOW_NOT_IMPLEMENTED",
      "BACKUP_JOB_AND_SCHEDULE_HISTORY_NOT_IMPLEMENTED",
    ],
  }, datasetFile: (tableName) => join(directory, datasets.find((dataset) => dataset.tableName === tableName).spoolFile) };
};

const workbookSheets = async (workbook) => {
  const { stdout } = await run("python3", ["-c", `import zipfile,xml.etree.ElementTree as E,json,sys
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
book=E.fromstring(z.read('xl/workbook.xml')); rels=E.fromstring(z.read('xl/_rels/workbook.xml.rels')); targets={r.attrib['Id']:r.attrib['Target'] for r in rels}; out={}
for s in book.findall('.//m:sheet',ns):
 root=E.fromstring(z.read('xl/'+targets[s.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]))
 assert not root.findall('.//m:f',ns); rows=[]
 for row in root.findall('.//m:row',ns):
  cells=row.findall('m:c',ns); assert all(c.attrib.get('t')=='inlineStr' for c in cells); rows.append([c.find('.//m:t',ns).text or '' for c in cells])
 out[s.attrib['name']]=rows
print(json.dumps(out,ensure_ascii=False))`, workbook], { maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(stdout);
};

const sourceSheet = (sheets, source) => Object.entries(sheets).find(([, rows]) => rows[0]?.includes(`源记录键`) && rows[0].some((cell) => cell.endsWith(`[${source}]`)))?.[1];

test("exports every current table-4 source as independent Chinese fact sheets with exact text, NULL and long-text coordinates", async () => {
  const longReason = `报销说明-${"汉".repeat(32_000)}😀`;
  const fixture = await createCompleteSpool(financeFacts(longReason));
  try {
    const outputRoot = join(fixture.root, "out");
    const result = await new FullBackupFinanceWorkbookExporter({ spoolDirectory: fixture.directory, spool: fixture.spool, outputRoot }).export();
    assert.equal(result.mode, "BUSINESS_FACTS_WORKBOOK"); assert.equal(result.complete, false);
    assert.deepEqual(result.coveredTables, [4]); assert.equal(result.file, "business-table-4-finance-facts.xlsx");
    assert.equal(result.gaps.includes("BUSINESS_TABLES_1_TO_3_5_TO_8_NOT_INCLUDED"), true);
    const directory = join(outputRoot, result.outputId);
    assert.deepEqual(await readdir(directory), [result.file]); assert.equal((await stat(directory)).mode & 0o077, 0);
    const bytes = await readFile(join(directory, result.file));
    assert.equal(result.sizeBytes, String(bytes.byteLength)); assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
    const sheets = await workbookSheets(join(directory, result.file));
    assert.ok(sheets["00_说明"]); assert.equal(sheets["00_说明"].some((row) => row[0] === "覆盖业务表" && row[1] === "4（财务单据事实）"), true);
    assert.equal(sheets["00_说明"].some((row) => row[0] === "完整关联来源" && row[1].includes("finance_refund_submission 仅导出单据键")), true);
    assert.equal(Object.keys(sheets).some((name) => name.startsWith("T4_01_财务单据")), true);
    const view = new FullBackupBusinessFactsView({ spoolDirectory: fixture.directory, spool: fixture.spool });
    const description = view.describe(4);
    assert.deepEqual(description.sources.map((source) => source.sourceTable), table4Sources);
    assert.equal(description.sources.length, 17);
    for (const [index, title] of table4ChineseSourceTitles.entries())
      assert.equal(Object.hasOwn(sheets, `T4_${String(index + 1).padStart(2, "0")}_${title}`), true);
    for (const [sourceIndex, source] of description.sources.entries()) {
      const rows = Object.entries(sheets).find(([name]) => name.startsWith(`T4_${String(sourceIndex + 1).padStart(2, "0")}_`))?.[1];
      assert.ok(rows, `${source.sourceTable} sheet exists`);
      assert.deepEqual(rows[0], ["源记录键", "源行号", ...source.columns.map((column) => `${column.label} [${column.sourceColumn}]`)]);
      assert.equal(rows.length, source.sourceTable === "finance_document" ? 3 : 2, `${source.sourceTable} preserves every source row`);
    }
    const transferIndex = description.sources.findIndex((source) => source.sourceTable === "finance_reimbursement_transfer");
    const transferRows = Object.entries(sheets).find(([name]) => name.startsWith(`T4_${String(transferIndex + 1).padStart(2, "0")}_`))?.[1];
    assert.ok(transferRows);
    const transferHeader = transferRows[0]; const transfer = transferRows[1];
    const value = (column) => transfer[transferHeader.indexOf(transferHeader.find((cell) => cell.endsWith(`[${column}]`)))];
    assert.deepEqual({
      finance_document_id: value("finance_document_id"), source_account_id: value("source_account_id"), destination_account_id: value("destination_account_id"),
      amount_cents: value("amount_cents"), source_before_cents: value("source_before_cents"), source_after_cents: value("source_after_cents"),
      destination_before_cents: value("destination_before_cents"), destination_after_cents: value("destination_after_cents"),
    }, { finance_document_id: "reimbursement-document-1", source_account_id: "company-account-1", destination_account_id: "person-account-1", amount_cents: "150", source_before_cents: "100", source_after_cents: "-50", destination_before_cents: "20", destination_after_cents: "170" });
    const longSheet = sheets["14_长文本"]; const nullSheet = sheets["15_NULL坐标"];
    assert.ok(longSheet); assert.ok(nullSheet);
    const expectedLong = splitBackupLongText(longReason);
    const chunks = longSheet.slice(1).filter((row) => row[4] === "reason").map((row) => row[6]);
    assert.equal(restoreBackupLongText({ ...expectedLong, chunks }), longReason);
    assert.equal(nullSheet.slice(1).some((row) => row.join("/").includes("finance_document_event") && row.at(-1) === "ledger_event_id"), true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("splits table-4 source sheets and removes only a failed new private attempt", async () => {
  const fixture = await createCompleteSpool(financeFacts("ordinary reimbursement"));
  try {
    const outputRoot = join(fixture.root, "out");
    const stable = await new FullBackupFinanceWorkbookExporter({ spoolDirectory: fixture.directory, spool: fixture.spool, outputRoot, maxDataRows: 1 }).export();
    const sheets = await workbookSheets(join(outputRoot, stable.outputId, stable.file));
    assert.equal(Object.keys(sheets).filter((name) => name.startsWith("T4_01_财务单据_")).length, 2);
    const original = await readFile(fixture.datasetFile("finance_document"), "utf8");
    await writeFile(fixture.datasetFile("finance_document"), original.replace("finance_document:key:id:1", "tampered"), { mode: 0o600 });
    await assert.rejects(() => new FullBackupFinanceWorkbookExporter({ spoolDirectory: fixture.directory, spool: fixture.spool, outputRoot }).export(), /EXPORT_SPOOL_INTEGRITY_FAILED/);
    assert.deepEqual(await readdir(outputRoot), [stable.outputId]);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("generic core rejects an unregistered profile before reading any spool", () => {
  assert.throws(() => new FullBackupBusinessFactsWorkbookExporter({ profile: "UNKNOWN", spoolDirectory: "ignored", spool: null, outputRoot: "ignored" }), /EXPORT_BUSINESS_FACTS_WORKBOOK_PROFILE_INVALID/);
});
