import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  FullBackupTeacherWorkbookExporter,
} from "../dist/full-backup-teacher-workbook-exporter.js";
import {
  FullBackupStudentWorkbookExporter,
} from "../dist/full-backup-student-workbook-exporter.js";
import {
  FullBackupFinanceWorkbookExporter,
} from "../dist/full-backup-finance-workbook-exporter.js";
import {
  FullBackupPayrollWorkbookExporter,
} from "../dist/full-backup-payroll-workbook-exporter.js";
import {
  FullBackupDeductionWorkbookExporter,
} from "../dist/full-backup-deduction-workbook-exporter.js";
import {
  FullBackupPerformanceConfigurationWorkbookExporter,
} from "../dist/full-backup-performance-configuration-workbook-exporter.js";
import { BUSINESS_BACKUP_SHEETS } from "../dist/full-backup-business-schema.js";
import { FULL_BACKUP_MANIFEST_EVIDENCE_COVERAGE_GAPS } from "../dist/full-backup-manifest-evidence.js";
import { createFullBackupManifestContext } from "../dist/full-backup-manifest.js";
import { createFullBackupLayout } from "../dist/full-backup-layout.js";
import { EXPORT_SCHEMA_REGISTRY } from "../dist/export-schema-registry.js";
import { fullBackupOutputColumns } from "../dist/full-backup-transformer.js";

const run = promisify(execFile);
const layout = createFullBackupLayout();
const digest = (content) => createHash("sha256").update(content, "utf8").digest("hex");
const storedTables = [1, 2, 4, 5, 6, 8];

const sourceTablesFor = (tableNumber) => {
  const sheet = BUSINESS_BACKUP_SHEETS.find((candidate) => candidate.tableNumber === tableNumber);
  assert.ok(sheet);
  return [...new Set([...sheet.rowKeyColumns, ...sheet.columns].map((column) => column.sourceTable))];
};

const allFactSources = [...new Set(storedTables.flatMap(sourceTablesFor))];

const recordFor = (tableName, suffix = "1") => {
  const columns = fullBackupOutputColumns(tableName);
  const registered = EXPORT_SCHEMA_REGISTRY.find((candidate) => candidate.name === tableName);
  assert.ok(registered);
  const record = Object.fromEntries(columns.map((column) => [column, `${tableName}:${column}:${suffix}`]));
  for (const key of registered.orderBy) {
    const output = columns.includes(key) ? key : `${key}_fingerprint`;
    record[output] = `${tableName}:key:${key}:${suffix}`;
  }
  return record;
};

const stableKey = (tableName, columns, record) => {
  const registered = EXPORT_SCHEMA_REGISTRY.find((candidate) => candidate.name === tableName);
  assert.ok(registered);
  return JSON.stringify(registered.orderBy.map((column) => {
    const output = columns.includes(column) ? column : `${column}_fingerprint`;
    return [output, record[output]];
  }));
};

const createFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "business-facts-manifest-"));
  const directory = join(root, "spool");
  await mkdir(join(directory, "datasets"), { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await chmod(join(directory, "datasets"), 0o700);

  const records = Object.fromEntries(allFactSources.map((tableName) => [tableName, [recordFor(tableName)]]));
  const manifestOnlyTable = layout.find((item) => item.policy === "RAW_SOURCE" && !allFactSources.includes(item.tableName));
  assert.ok(manifestOnlyTable);
  records[manifestOnlyTable.tableName] = [recordFor(manifestOnlyTable.tableName)];
  const manifestOnlyColumns = fullBackupOutputColumns(manifestOnlyTable.tableName);
  const manifestOnlyKey = EXPORT_SCHEMA_REGISTRY.find((candidate) => candidate.name === manifestOnlyTable.tableName).orderBy[0];
  const manifestOnlyOutputKey = manifestOnlyColumns.includes(manifestOnlyKey) ? manifestOnlyKey : `${manifestOnlyKey}_fingerprint`;
  records[manifestOnlyTable.tableName][0][manifestOnlyOutputKey] = `manifest-only-long-key-${"汉".repeat(40_000)}😀`;
  if (Object.hasOwn(records.finance_reimbursement_submission[0], "reason"))
    records.finance_reimbursement_submission[0].reason = `长报销原因-${"文".repeat(40_000)}😀`;
  if (Object.hasOwn(records.finance_document_event[0], "ledger_event_id"))
    records.finance_document_event[0].ledger_event_id = null;

  const datasets = [];
  const sourceMetadata = new Map();
  for (const [index, item] of layout.entries()) {
    const excluded = item.policy === "AUTH_SECRET_TABLE_EXCLUDED";
    if (excluded) {
      datasets.push({ tableName: item.tableName, columns: [], rowCount: null, logicalDigest: null, spoolFile: null, excluded: true });
      continue;
    }
    const columns = fullBackupOutputColumns(item.tableName);
    const tableRows = records[item.tableName] ?? [];
    const rows = tableRows.map((record) => columns.map((column) => record[column] ?? null));
    const content = `${JSON.stringify({ columns })}\n${rows.map((row) => `${JSON.stringify(row)}\n`).join("")}`;
    const spoolFile = `datasets/${String(index + 1).padStart(3, "0")}_${item.tableName}.ndjson`;
    await writeFile(join(directory, spoolFile), content, { mode: 0o600 });
    const logicalDigest = digest(content);
    datasets.push({ tableName: item.tableName, columns, rowCount: String(rows.length), logicalDigest, spoolFile, excluded: false });
    sourceMetadata.set(item.tableName, {
      rowCount: String(rows.length),
      firstStableKey: rows.length === 0 ? null : stableKey(item.tableName, columns, tableRows[0]),
      lastStableKey: rows.length === 0 ? null : stableKey(item.tableName, columns, tableRows.at(-1)),
      logicalDigest,
    });
  }
  await writeFile(join(directory, "anomalies.ndjson"), "", { mode: 0o600 });
  const spool = {
    mode: "RAW_SOURCE_SPOOL",
    spoolId: "business-facts-manifest-spool",
    snapshotId: "business-facts-manifest-snapshot",
    asOf: "2026-09-23T00:00:00.000Z",
    datasets,
    anomalyFile: "anomalies.ndjson",
    anomalyCount: "0",
    coverageGaps: [
      "MONTHLY_INCOME_PUBLISHED_VERSIONS_NOT_IMPLEMENTED",
      "MANUAL_ADJUSTMENT_WORKFLOW_NOT_IMPLEMENTED",
      "BACKUP_JOB_AND_SCHEDULE_HISTORY_NOT_IMPLEMENTED",
      "NICKNAME_CORRECTION_HISTORY_NOT_IMPLEMENTED",
    ],
  };
  const context = createFullBackupManifestContext({
    evidence: {
      mode: "FULL_BACKUP_MANIFEST_EVIDENCE",
      schemaVersion: "full-backup-manifest-evidence.v1",
      complete: false,
      spoolId: spool.spoolId,
      snapshotId: spool.snapshotId,
      asOf: spool.asOf,
      raw: {
        registeredDatasetCount: String(layout.length),
        nonSecretTables: layout.filter((item) => item.policy === "RAW_SOURCE").map((item) => ({
          tableName: item.tableName,
          ...sourceMetadata.get(item.tableName),
        })),
        secretExclusions: layout.flatMap((item) => item.excludedColumns.map((fieldName) => ({
          tableName: item.tableName,
          fieldName,
          reason: item.policy === "AUTH_SECRET_TABLE_EXCLUDED" ? "AUTH_SECRET_TABLE_EXCLUDED" : "AUTH_SECRET_COLUMN_EXCLUDED",
        }))),
      },
      money: {
        ledgerEntryCount: "0", validEntryAmountCount: "0", invalidEntryAmountCount: "0",
        validEntryCentsSubtotal: "0", exactLedgerEntryCents: "0", ledgerAnomalyCount: "0", invalidMonthlyRowCount: "0",
        reconciliation: {
          accountCount: "0",
          statusCounts: { MATCH: "0", MISMATCH: "0", MISSING_PROJECTION: "0", PROJECTION_INVALID: "0", LEDGER_TOTAL_INVALID: "0", ACCOUNT_UNRESOLVED: "0" },
          validLedgerCentsSubtotal: "0", exactLedgerCents: "0", validProjectionCentsSubtotal: "0", exactProjectionCents: "0",
        },
      },
      periods: {
        eventCount: "0", sourceLinkCount: "0", anomalyCount: "0",
        statusCounts: { UNIQUE_LOCKED_SETTLEMENT_MONTH: "0", MULTIPLE_BUSINESS_PERIODS: "0", UNRESOLVED: "0", UNIMPLEMENTED_EVENT_TYPE: "0" },
      },
      integrity: { status: "VERIFIED_PARTIAL", scope: "REGISTERED_RAW_AND_LEDGER_EVIDENCE_ONLY", completeBackup: false },
      businessCorrectness: { status: "NOT_ASSERTED", scope: "NO_COMPLETE_BUSINESS_CORRECTNESS_ASSERTION" },
      coverageGaps: [...FULL_BACKUP_MANIFEST_EVIDENCE_COVERAGE_GAPS],
    },
    fileGroupId: "business-facts-group",
    generatedAt: "2026-09-23T01:02:03.000Z",
    applicationVersion: "0.1.0",
    generatorVersion: "worker.test",
  });
  return { root, directory, spool, context };
};

const readWorkbook = async (path) => {
  const { stdout } = await run("python3", ["-c", `import json,sys,zipfile,xml.etree.ElementTree as E
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
m='http://schemas.openxmlformats.org/spreadsheetml/2006/main'; r='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
book=E.fromstring(z.read('xl/workbook.xml')); rels=E.fromstring(z.read('xl/_rels/workbook.xml.rels')); targets={x.attrib['Id']:x.attrib['Target'] for x in rels}
out=[]
for s in book.findall('.//{'+m+'}sheet'):
 root=E.fromstring(z.read('xl/'+targets[s.attrib['{'+r+'}id']]))
 rows=[]
 for row in root.findall('.//{'+m+'}row'):
  cells=[]
  for cell in row.findall('{'+m+'}c'):
   text=cell.find('.//{'+m+'}t'); cells.append('' if text is None or text.text is None else text.text)
  rows.append(cells)
 out.append([s.attrib['name'],rows])
print(json.dumps(out,ensure_ascii=False))`, path], { maxBuffer: 40 * 1024 * 1024 });
  return JSON.parse(stdout);
};

const fields = (rows) => new Map(rows.slice(1));
const profiles = [
  [1, "business-table-1-teacher-facts.xlsx", FullBackupTeacherWorkbookExporter],
  [2, "business-table-2-student-facts.xlsx", FullBackupStudentWorkbookExporter],
  [4, "business-table-4-finance-facts.xlsx", FullBackupFinanceWorkbookExporter],
  [5, "business-table-5-payroll-facts.xlsx", FullBackupPayrollWorkbookExporter],
  [6, "business-table-6-deduction-facts.xlsx", FullBackupDeductionWorkbookExporter],
  [8, "business-table-8-performance-configuration-facts.xlsx", FullBackupPerformanceConfigurationWorkbookExporter],
];

test("all six fixed fact wrappers prepend a verified 00_manifest with only source-table summaries", async () => {
  const fixture = await createFixture();
  try {
    const outputRoot = join(fixture.root, "out");
    for (const [tableNumber, file, Exporter] of profiles) {
      const result = await new Exporter({
        spoolDirectory: fixture.directory,
        spool: fixture.spool,
        outputRoot,
        manifestContext: fixture.context,
      }).export();
      const workbook = await readWorkbook(join(outputRoot, result.outputId, result.file));
      assert.equal(workbook[0][0], "00_manifest");
      assert.equal(workbook[1][0], "00_说明");
      const manifest = fields(workbook[0][1]);
      assert.equal(manifest.get("complete"), "false");
      assert.equal(manifest.get("workbook_file"), file);
      assert.equal(manifest.get("workbook_role"), "BUSINESS_FACT");
      assert.equal(manifest.get("covered_table_numbers"), String(tableNumber));
      assert.equal(manifest.get("spool_id"), fixture.spool.spoolId);
      assert.equal(manifest.get("snapshot_id"), fixture.spool.snapshotId);
      const sourceParts = workbook[0][1].filter(([field]) => field.endsWith(".source_table"));
      assert.deepEqual(sourceParts.map(([, value]) => value), sourceTablesFor(tableNumber));
      for (const [field, value] of workbook[0][1]) {
        if (field.endsWith(".page_logical_digest")) assert.equal(value, "");
        if (field.endsWith(".summary_scope")) assert.equal(value, "SOURCE_TABLE_DIGEST_ONLY");
      }
      assert.deepEqual(result.sourceRows.map((source) => source.sourceTable), sourceTablesFor(tableNumber));
    }

    const teacher = await new FullBackupTeacherWorkbookExporter({
      spoolDirectory: fixture.directory,
      spool: fixture.spool,
      outputRoot,
      manifestContext: fixture.context,
    }).export();
    const teacherBook = await readWorkbook(join(outputRoot, teacher.outputId, teacher.file));
    const longSheet = teacherBook.find(([name]) => name.startsWith("14_长文本"))?.[1];
    const nullSheet = teacherBook.find(([name]) => name.startsWith("15_NULL坐标"))?.[1];
    assert.ok(longSheet); assert.ok(nullSheet);
    assert.equal(longSheet.slice(1).some((row) => row[1] === "00_manifest" && row[4] === "内容"), true);
    assert.equal(nullSheet.slice(1).some((row) => row[0] === "00_manifest" && row[3] === "内容"), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("no manifest context preserves 00_说明 first, while mismatched context deletes only its new attempt", async () => {
  const fixture = await createFixture();
  try {
    const outputRoot = join(fixture.root, "out");
    const stable = await new FullBackupTeacherWorkbookExporter({
      spoolDirectory: fixture.directory,
      spool: fixture.spool,
      outputRoot,
    }).export();
    const stableBook = await readWorkbook(join(outputRoot, stable.outputId, stable.file));
    assert.equal(stableBook[0][0], "00_说明");
    assert.equal(stableBook.some(([name]) => name === "00_manifest"), false);

    const badSnapshot = { ...fixture.context, snapshotId: "another-snapshot" };
    await assert.rejects(
      () => new FullBackupTeacherWorkbookExporter({ spoolDirectory: fixture.directory, spool: fixture.spool, outputRoot, manifestContext: badSnapshot }).export(),
      /EXPORT_BUSINESS_FACTS_WORKBOOK_MANIFEST_SNAPSHOT_MISMATCH/,
    );
    const badDigest = {
      ...fixture.context,
      rawTables: fixture.context.rawTables.map((table) => table.tableName === "person" ? { ...table, logicalDigest: "b".repeat(64) } : table),
    };
    await assert.rejects(
      () => new FullBackupTeacherWorkbookExporter({ spoolDirectory: fixture.directory, spool: fixture.spool, outputRoot, manifestContext: badDigest }).export(),
      /EXPORT_BUSINESS_FACTS_WORKBOOK_MANIFEST_SOURCE_MISMATCH/,
    );
    assert.deepEqual(await readdir(outputRoot), [stable.outputId]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
