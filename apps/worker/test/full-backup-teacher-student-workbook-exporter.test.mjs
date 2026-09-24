import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FullBackupBusinessFactsWorkbookExporter } from "../dist/full-backup-business-facts-workbook-exporter.js";
import { FullBackupStudentWorkbookExporter } from "../dist/full-backup-student-workbook-exporter.js";
import { FullBackupTeacherWorkbookExporter } from "../dist/full-backup-teacher-workbook-exporter.js";
import { BUSINESS_BACKUP_SHEETS } from "../dist/full-backup-business-schema.js";
import { createFullBackupLayout } from "../dist/full-backup-layout.js";
import { EXPORT_SCHEMA_REGISTRY } from "../dist/export-schema-registry.js";
import { fullBackupOutputColumns } from "../dist/full-backup-transformer.js";

const layout = createFullBackupLayout();
const digest = (content) => createHash("sha256").update(content, "utf8").digest("hex");
const valuesFor = (columns, record = {}) => columns.map((column) => record[column] ?? null);
const registeredRecord = (tableName, suffix = "1") => {
  const columns = fullBackupOutputColumns(tableName);
  const registered = EXPORT_SCHEMA_REGISTRY.find((item) => item.name === tableName);
  assert.ok(registered);
  const record = Object.fromEntries(columns.map((column) => [column, `${tableName}:${column}:${suffix}`]));
  for (const key of registered.orderBy) record[columns.includes(key) ? key : `${key}_fingerprint`] = `${tableName}:key:${key}:${suffix}`;
  return record;
};
const sourcesFor = (tableNumber) => {
  const sheet = BUSINESS_BACKUP_SHEETS.find((item) => item.tableNumber === tableNumber);
  assert.ok(sheet);
  return [...new Set([...sheet.rowKeyColumns, ...sheet.columns].map((item) => item.sourceTable))];
};
const createSpool = async (records) => {
  const root = await mkdtemp(join(tmpdir(), "teacher-student-workbook-"));
  const directory = join(root, "spool");
  await mkdir(join(directory, "datasets"), { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
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
  return { root, directory, spool: { mode: "RAW_SOURCE_SPOOL", spoolId: "synthetic-table-1-2", snapshotId: "synthetic-table-1-2-snapshot", asOf: "2026-09-23T00:00:00.000Z", datasets, anomalyFile: "anomalies.ndjson", anomalyCount: "0", coverageGaps: ["MONTHLY_INCOME_PUBLISHED_VERSIONS_NOT_IMPLEMENTED", "MANUAL_ADJUSTMENT_WORKFLOW_NOT_IMPLEMENTED", "BACKUP_JOB_AND_SCHEDULE_HISTORY_NOT_IMPLEMENTED"] } };
};
const consumeWorkbook = async (captured, options) => {
  captured.push(options);
  for (const sheet of options.sheets) for await (const _row of sheet.rows) void _row;
  await writeFile(options.outputPath, "synthetic-workbook", { mode: 0o600 });
};

for (const profile of [
  { name: "teacher", tableNumber: 1, profile: "TEACHER", file: "business-table-1-teacher-facts.xlsx", prefix: "T1", Wrapper: FullBackupTeacherWorkbookExporter, title: "教师信息事实" },
  { name: "student", tableNumber: 2, profile: "STUDENT", file: "business-table-2-student-facts.xlsx", prefix: "T2", Wrapper: FullBackupStudentWorkbookExporter, title: "学生业务流水事实" },
]) test(`${profile.name} fixed workbook profile exports every declared source independently and remains incomplete`, async () => {
  const records = Object.fromEntries(sourcesFor(profile.tableNumber).map((source) => [source, [registeredRecord(source)]]));
  if (profile.profile === "TEACHER") Object.assign(records.person[0], { id: "person-001", nickname: "0007老师", status: "INACTIVE" });
  else {
    Object.assign(records.teacher_student_record[0], { id: "student-record-001", display_name: "独立学生甲" });
    Object.assign(records.referral_acceptance_snapshot[0], { referral_case_id: "referral-001", accepted_referral_version: "2", venue_id: "venue-001" });
    Object.assign(records.weekly_fee_entry_version[0], { id: "weekly-version-001", version: "2" });
  }
  const fixture = await createSpool(records);
  try {
    const captured = [], outputRoot = join(fixture.root, "out");
    const result = await new profile.Wrapper({ spoolDirectory: fixture.directory, spool: fixture.spool, outputRoot, writeWorkbook: (options) => consumeWorkbook(captured, options), maxDataRows: 1 }).export();
    assert.equal(result.mode, "BUSINESS_FACTS_WORKBOOK"); assert.equal(result.complete, false);
    assert.deepEqual(result.coveredTables, [profile.tableNumber]); assert.equal(result.file, profile.file);
    assert.equal(result.gaps.some((gap) => gap.startsWith("BUSINESS_TABLES_")), true);
    assert.equal(captured.length, 1); const sheets = captured[0].sheets;
    assert.equal(sheets[0].name, "00_说明");
    const rows = []; for await (const row of sheets[0].rows) rows.push(row);
    assert.equal(rows.some((row) => row[0] === "完整备份" && row[1] === "false"), true);
    assert.equal(rows.some((row) => row[0] === "覆盖业务表" && row[1].includes(profile.title)), true);
    const expectedSources = sourcesFor(profile.tableNumber);
    assert.deepEqual(result.sourceRows.map((source) => source.sourceTable), expectedSources);
    assert.equal(result.sourceRows.every((source) => source.rowCount === "1"), true);
    assert.deepEqual(sheets.filter((sheet) => sheet.name.startsWith(`${profile.prefix}_`)).map((sheet) => sheet.name.split("_").slice(0, 2).join("_")), expectedSources.map((_source, index) => `${profile.prefix}_${String(index + 1).padStart(2, "0")}`));
    const headers = sheets.filter((sheet) => sheet.name.startsWith(`${profile.prefix}_`)).flatMap((sheet) => sheet.columns);
    assert.equal(headers.some((header) => /password|session|secret/i.test(header)), false);
    if (profile.profile === "STUDENT") {
      const acceptance = sheets.find((sheet) => sheet.name.startsWith("T2_03_"));
      assert.deepEqual(acceptance.columns.slice(0, 4), ["源记录键", "源行号", "原始键：referral_case_id [referral_case_id]", "原始键：accepted_referral_version [accepted_referral_version]"]);
    }
    if (profile.profile === "TEACHER") assert.equal(headers.includes("教师昵称 [nickname]"), true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("generic core keeps its fixed profile boundary and removes only its failed new teacher attempt", async () => {
  const fixture = await createSpool({ person: [registeredRecord("person")] });
  try {
    const outputRoot = join(fixture.root, "out");
    await assert.rejects(() => new FullBackupBusinessFactsWorkbookExporter({ spoolDirectory: fixture.directory, spool: fixture.spool, outputRoot, profile: "TEACHER", writeWorkbook: async () => { throw new Error("TEST_WRITER_FAILURE"); } }).export(), /TEST_WRITER_FAILURE/);
    assert.deepEqual(await readdir(outputRoot), []);
    assert.throws(() => new FullBackupBusinessFactsWorkbookExporter({ profile: "UNKNOWN", spoolDirectory: "ignored", spool: null, outputRoot: "ignored" }), /EXPORT_BUSINESS_FACTS_WORKBOOK_PROFILE_INVALID/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
