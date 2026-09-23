import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FullBackupBusinessFactsWorkbookExporter } from "../dist/full-backup-business-facts-workbook-exporter.js";
import { FullBackupDeductionWorkbookExporter } from "../dist/full-backup-deduction-workbook-exporter.js";
import { FullBackupPerformanceConfigurationWorkbookExporter } from "../dist/full-backup-performance-configuration-workbook-exporter.js";
import { BUSINESS_BACKUP_SHEETS } from "../dist/full-backup-business-schema.js";
import { createFullBackupLayout } from "../dist/full-backup-layout.js";
import { EXPORT_SCHEMA_REGISTRY } from "../dist/export-schema-registry.js";
import { fullBackupOutputColumns } from "../dist/full-backup-transformer.js";

const layout = createFullBackupLayout();
const digest = (content) => createHash("sha256").update(content, "utf8").digest("hex");
const valuesFor = (columns, record = {}) => columns.map((column) => record[column] ?? null);
const registeredRecord = (tableName, suffix = "1") => {
  const columns = fullBackupOutputColumns(tableName), registered = EXPORT_SCHEMA_REGISTRY.find((item) => item.name === tableName);
  assert.ok(registered); const record = Object.fromEntries(columns.map((column) => [column, `${tableName}:${column}:${suffix}`]));
  for (const key of registered.orderBy) record[columns.includes(key) ? key : `${key}_fingerprint`] = `${tableName}:key:${key}:${suffix}`;
  return record;
};
const sourcesFor = (tableNumber) => {
  const sheet = BUSINESS_BACKUP_SHEETS.find((item) => item.tableNumber === tableNumber); assert.ok(sheet);
  return [...new Set([...sheet.rowKeyColumns, ...sheet.columns].map((item) => item.sourceTable))];
};
const createSpool = async (records) => {
  const root = await mkdtemp(join(tmpdir(), "deduction-performance-workbook-")), directory = join(root, "spool");
  await mkdir(join(directory, "datasets"), { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const datasets = [];
  for (const [index, item] of layout.entries()) {
    const excluded = item.policy === "AUTH_SECRET_TABLE_EXCLUDED";
    if (excluded) { datasets.push({ tableName: item.tableName, columns: [], rowCount: null, logicalDigest: null, spoolFile: null, excluded: true }); continue; }
    const columns = fullBackupOutputColumns(item.tableName), rows = (records[item.tableName] ?? []).map((record) => valuesFor(columns, record));
    const content = `${JSON.stringify({ columns })}\n${rows.map((row) => `${JSON.stringify(row)}\n`).join("")}`;
    const spoolFile = `datasets/${String(index + 1).padStart(3, "0")}_${item.tableName}.ndjson`;
    await writeFile(join(directory, spoolFile), content, { mode: 0o600 });
    datasets.push({ tableName: item.tableName, columns, rowCount: String(rows.length), logicalDigest: digest(content), spoolFile, excluded: false });
  }
  await writeFile(join(directory, "anomalies.ndjson"), "", { mode: 0o600 });
  return { root, directory, spool: { mode: "RAW_SOURCE_SPOOL", spoolId: "synthetic-table-6-8", snapshotId: "synthetic-table-6-8-snapshot", asOf: "2026-09-23T00:00:00.000Z", datasets, anomalyFile: "anomalies.ndjson", anomalyCount: "0", coverageGaps: ["MONTHLY_INCOME_PUBLISHED_VERSIONS_NOT_IMPLEMENTED", "MANUAL_ADJUSTMENT_WORKFLOW_NOT_IMPLEMENTED", "BACKUP_JOB_AND_SCHEDULE_HISTORY_NOT_IMPLEMENTED", "NICKNAME_CORRECTION_HISTORY_NOT_IMPLEMENTED"] } };
};
const captureWorkbook = async (captured, options) => { captured.push(options); for (const sheet of options.sheets) for await (const _row of sheet.rows) void _row; await writeFile(options.outputPath, "synthetic-workbook", { mode: 0o600 }); };

for (const profile of [
  { name: "deduction", tableNumber: 6, profile: "DEDUCTION", file: "business-table-6-deduction-facts.xlsx", prefix: "T6", Wrapper: FullBackupDeductionWorkbookExporter, title: "扣费事实", boundary: "项目1至10扣费未建模" },
  { name: "performance configuration", tableNumber: 8, profile: "PERFORMANCE_CONFIGURATION", file: "business-table-8-performance-configuration-facts.xlsx", prefix: "T8", Wrapper: FullBackupPerformanceConfigurationWorkbookExporter, title: "绩效配置事实", boundary: "不把全局策略或实际快照冒充个人覆盖或班型配置" },
]) test(`${profile.name} fixed profile exports each declared source independently and stays incomplete`, async () => {
  const records = Object.fromEntries(sourcesFor(profile.tableNumber).map((source) => [source, [registeredRecord(source)]]));
  if (profile.profile === "DEDUCTION") {
    Object.assign(records.finance_benefit_plan_version[0], { id: "plan-001", benefit_kind: "SOCIAL_INSURANCE", amount_cents: "0", execution_day: "15" });
    Object.assign(records.finance_benefit_todo[0], { id: "todo-001", generated_at: null });
    Object.assign(records.finance_benefit_execution[0], { finance_document_id: "benefit-document-001", source_account_id: "account-001", amount_cents: "150" });
  } else {
    Object.assign(records.rate_policy_version[0], { id: "policy-001", version: "2", effective_from: "2026-09-01T00:00:00.000Z", policy_json: '{"teacherBaseRateBasisPoints":"1200"}', published_by: "admin-001" });
    Object.assign(records.weekly_fee_allocation_snapshot[0], { id: "snapshot-001", policy_version_id: "policy-001", context_json: '{"resolvedRates":{"venueRateBasisPoints":"0"}}', snapshot_json: '{"lines":[]}' });
  }
  const fixture = await createSpool(records);
  try {
    const captured = [], outputRoot = join(fixture.root, "out");
    const result = await new profile.Wrapper({ spoolDirectory: fixture.directory, spool: fixture.spool, outputRoot, writeWorkbook: (options) => captureWorkbook(captured, options), maxDataRows: 1 }).export();
    assert.equal(result.complete, false); assert.deepEqual(result.coveredTables, [profile.tableNumber]); assert.equal(result.file, profile.file);
    assert.equal(captured.length, 1); const sheets = captured[0].sheets, explanation = [];
    for await (const row of sheets[0].rows) explanation.push(row);
    assert.equal(explanation.some((row) => row[0] === "完整备份" && row[1] === "false"), true);
    assert.equal(explanation.some((row) => row[0] === "完整关联来源" && row[1].includes(profile.boundary)), true);
    const expectedSources = sourcesFor(profile.tableNumber);
    assert.deepEqual(result.sourceRows.map((source) => source.sourceTable), expectedSources);
    assert.equal(result.sourceRows.every((source) => source.rowCount === "1"), true);
    assert.deepEqual(sheets.filter((sheet) => sheet.name.startsWith(`${profile.prefix}_`)).map((sheet) => sheet.name.split("_").slice(0, 2).join("_")), expectedSources.map((_source, index) => `${profile.prefix}_${String(index + 1).padStart(2, "0")}`));
    if (profile.profile === "DEDUCTION") assert.equal(explanation.some((row) => row[0] === "已知缺口" && row[1].includes("PROJECT_DEDUCTION_1_TO_10_NOT_IMPLEMENTED")), true);
    else assert.equal(explanation.some((row) => row[0] === "已知缺口" && row[1].includes("PER_TEACHER_RATE_OVERRIDE_NOT_IMPLEMENTED") && row[1].includes("CLASS_TYPE_RATE_CONFIG_NOT_IMPLEMENTED")), true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("fixed profile boundary rejects unknown values and removes only the failed deduction attempt", async () => {
  const fixture = await createSpool({ finance_benefit_plan_version: [registeredRecord("finance_benefit_plan_version")] });
  try {
    const outputRoot = join(fixture.root, "out");
    await assert.rejects(() => new FullBackupBusinessFactsWorkbookExporter({ spoolDirectory: fixture.directory, spool: fixture.spool, outputRoot, profile: "DEDUCTION", writeWorkbook: async () => { throw new Error("TEST_WRITER_FAILURE"); } }).export(), /TEST_WRITER_FAILURE/);
    assert.deepEqual(await readdir(outputRoot), []);
    assert.throws(() => new FullBackupBusinessFactsWorkbookExporter({ profile: "UNKNOWN", spoolDirectory: "ignored", spool: null, outputRoot: "ignored" }), /EXPORT_BUSINESS_FACTS_WORKBOOK_PROFILE_INVALID/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
