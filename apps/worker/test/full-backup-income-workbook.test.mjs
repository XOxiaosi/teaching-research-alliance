import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FullBackupIncomeWorkbook } from "../dist/full-backup-income-workbook.js";
import {
  createFullBackupManifestContext,
} from "../dist/full-backup-manifest.js";
import {
  FULL_BACKUP_MANIFEST_EVIDENCE_COVERAGE_GAPS,
} from "../dist/full-backup-manifest-evidence.js";
import { createFullBackupLayout } from "../dist/full-backup-layout.js";
import { fullBackupOutputColumns } from "../dist/full-backup-transformer.js";

const collect = async (stream) => {
  const rows = [];
  for await (const row of stream) rows.push(row);
  return rows;
};
const layout = createFullBackupLayout();
const rawSources = layout
  .filter((item) => item.policy === "RAW_SOURCE")
  .map((item) => ({ tableName: item.tableName, rowCount: "0" }));
const incomeSourceTables = new Set([
  "settlement_account",
  "weekly_fee_entry",
  "weekly_fee_entry_version",
  "weekly_fee_allocation_snapshot",
  "finance_document",
  "finance_refund_decision",
  "finance_refund_submission_item",
  "weekly_fee_refund_effect",
  "ledger_event",
  "ledger_entry",
]);
const incomeSources = rawSources.filter((source) =>
  incomeSourceTables.has(source.tableName));
const secretExclusions = layout.flatMap((item) => item.excludedColumns.map((fieldName) => ({
  tableName: item.tableName,
  fieldName,
  reason: item.policy === "AUTH_SECRET_TABLE_EXCLUDED"
    ? "AUTH_SECRET_TABLE_EXCLUDED"
    : "AUTH_SECRET_COLUMN_EXCLUDED",
})));
const sourceDigest = (tableName) => createHash("sha256")
  .update(`${JSON.stringify({ columns: fullBackupOutputColumns(tableName) })}\n`)
  .digest("hex");
const manifestContext = () => createFullBackupManifestContext({
  evidence: {
    mode: "FULL_BACKUP_MANIFEST_EVIDENCE",
    schemaVersion: "full-backup-manifest-evidence.v1",
    complete: false,
    spoolId: "index-spool",
    snapshotId: "index-snapshot",
    asOf: "2026-09-23T00:00:00.000Z",
    raw: {
      registeredDatasetCount: String(layout.length),
      nonSecretTables: rawSources.map((source) => ({
        ...source,
        firstStableKey: null,
        lastStableKey: null,
        logicalDigest: sourceDigest(source.tableName),
      })),
      secretExclusions,
    },
    money: {
      ledgerEntryCount: "0", validEntryAmountCount: "0", invalidEntryAmountCount: "0",
      validEntryCentsSubtotal: "0", exactLedgerEntryCents: null, ledgerAnomalyCount: "0",
      invalidMonthlyRowCount: "0",
      reconciliation: {
        accountCount: "0",
        statusCounts: { MATCH: "0", MISMATCH: "0", MISSING_PROJECTION: "0", PROJECTION_INVALID: "0", LEDGER_TOTAL_INVALID: "0", ACCOUNT_UNRESOLVED: "0" },
        validLedgerCentsSubtotal: "0", exactLedgerCents: null,
        validProjectionCentsSubtotal: "0", exactProjectionCents: null,
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
  fileGroupId: "income-workbook-group",
  generatedAt: "2026-09-23T00:00:00.000Z",
  applicationVersion: "0.1.0",
  generatorVersion: "worker.1",
});
const indexMeta = {
  mode: "DERIVED_SPOOL_INDEX",
  complete: false,
  spoolId: "index-spool",
  snapshotId: "index-snapshot",
  asOf: "2026-09-23T00:00:00.000Z",
  sources: rawSources,
};
const metadata = {
  mode: "INCOME_DERIVED_VIEW",
  complete: false,
  tableNumber: 3,
  status: "PARTIAL",
  spoolId: "index-spool",
  snapshotId: "index-snapshot",
  asOf: "2026-09-23T00:00:00.000Z",
  publishedVersion: null,
  gaps: ["SETTLEMENT_PUBLISHED_SNAPSHOTS_NOT_IMPLEMENTED"],
  anomalyCount: "1",
  incompleteFeeCount: "1",
  sourceBasis: {
    indexMode: "DERIVED_SPOOL_INDEX",
    sourceRows: incomeSources,
    contributionDigest: "a".repeat(64),
  },
};
const personRow = (id, nickname) => ({
  tableName: "person",
  sourceRecordKey: `[[\"id\",\"${id}\"]]`,
  ordinal: "1",
  values: fullBackupOutputColumns("person").map((column) =>
    column === "id" ? id : column === "nickname" ? nickname : null,
  ),
});
const fakeIndex = {
  metadata: () => indexMeta,
  async *stream() {},
  lookup: async (table, pairs) =>
    table === "person" && pairs[0]?.[1] === "person-1"
      ? personRow("person-1", `显示名-${"汉".repeat(32000)}`)
      : undefined,
};
const contributions = {
  groupLeader: [
    {
      accountId: "account-1",
      settlementMonth: "2026-09-01",
      allocationKey: "groupLeader",
      signedCents: 9007199254740993n,
      feeEntryId: "fee-1",
      feeVersion: "1",
      allocationSnapshotId: "snapshot-1",
      allocationSnapshotSourceKey: '[["id","snapshot-1"]]',
      settlementRunId: "run-1",
      policyVersionId: "policy-1",
      refundFinanceDocumentId: null,
      refundEffectSourceKey: null,
    },
    {
      accountId: "account-1",
      settlementMonth: "2026-09-01",
      allocationKey: "groupLeader",
      signedCents: -1n,
      feeEntryId: "fee-1",
      feeVersion: "1",
      allocationSnapshotId: "snapshot-1",
      allocationSnapshotSourceKey: '[["id","snapshot-1"]]',
      settlementRunId: "run-1",
      policyVersionId: "policy-1",
      refundFinanceDocumentId: "refund-1",
      refundEffectSourceKey: '[["fee","fee-1"]]',
    },
    {
      accountId: "account-1",
      settlementMonth: "2026-09-01",
      allocationKey: "groupLeader",
      signedCents: 0n,
      feeEntryId: "fee-zero",
      feeVersion: "1",
      allocationSnapshotId: "snapshot-zero",
      allocationSnapshotSourceKey: '[["id","snapshot-zero"]]',
      settlementRunId: "run-zero",
      policyVersionId: "policy-1",
      refundFinanceDocumentId: "refund-zero",
      refundEffectSourceKey: '[["fee","fee-zero"]]',
    },
  ],
};
const fakeView = {
  metadata: () => metadata,
  async *streamMonthlyRows() {
    yield {
      accountId: "account-1",
      ownerType: "PERSON",
      ownerId: "person-1",
      accountCode: "person:001",
      settlementMonth: "2026-09-01",
      financeYear: "2026-2027",
      allocationKey: "groupLeader",
      positiveCents: 9007199254740993n,
      refundCents: -1n,
      netCents: 9007199254740992n,
      contributionCount: "2",
    };
  },
  async *streamContributionSources(key) {
    for (const row of contributions[key.allocationKey] ?? []) yield row;
  },
  async *streamAnomalies() {
    yield {
      code: "REFUND_LEDGER_MISMATCH",
      sourceTable: "ledger_entry",
      sourceRecordKey: '[["id","ledger-1"]]',
      feeEntryId: "fee-1",
    };
  },
};
const sheets = async (file) =>
  JSON.parse(
    (await import("node:child_process")).execFileSync(
      "python3",
      [
        "-c",
        `import zipfile,xml.etree.ElementTree as E,json,sys
z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None
n={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
b=E.fromstring(z.read('xl/workbook.xml'));rs=E.fromstring(z.read('xl/_rels/workbook.xml.rels'));m={x.attrib['Id']:x.attrib['Target'] for x in rs}
o={}
for s in b.findall('.//m:sheet',n):
 x=E.fromstring(z.read('xl/'+m[s.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]));o[s.attrib['name']]=[[c.find('.//m:t',n).text or '' for c in r.findall('m:c',n)] for r in x.findall('.//m:row',n)]
print(json.dumps(o,ensure_ascii=False))`,
        file,
      ],
      { encoding: "utf8" },
    ),
  );

test("writes fixed Chinese partial table-3 workbook with precise beans, traceability, long text and NULL coordinates", async () => {
  const root = await mkdtemp(join(tmpdir(), "income-workbook-"));
  try {
    const result = await new FullBackupIncomeWorkbook({
      index: fakeIndex,
      view: fakeView,
      outputRoot: join(root, "out"),
      manifestContext: manifestContext(),
      maxDataRows: 1,
    }).export();
    assert.equal(result.mode, "INCOME_DERIVED_WORKBOOK");
    assert.equal(result.complete, false);
    assert.deepEqual(result.coveredTables, [3]);
    assert.equal(result.schemaVersion, "full-backup-income-workbook.v1");
    assert.equal(result.status, "PARTIAL");
    assert.equal(result.file, "business-table-3-income-derived.xlsx");
    const dir = join(root, "out", result.outputId),
      file = join(dir, result.file),
      bytes = await readFile(file);
    assert.equal(
      result.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.equal((await stat(dir)).mode & 0o077, 0);
    assert.deepEqual(await readdir(dir), [result.file]);
    const book = await sheets(file);
    assert.equal(Object.keys(book)[0], "00_manifest");
    assert.equal(book["00_manifest"].some((row) => row[0] === "complete" && row[1] === "false"), true);
    assert.equal(book["00_manifest"].some((row) => row[0] === "sheet.01_月度收入.source_table" && row[1] === ""), true);
    assert.ok(book["00_说明"]);
    assert.ok(book["01_月度收入"]);
    assert.ok(book["02_来源明细_0001"]);
    assert.ok(book["03_异常"]);
    assert.ok(book["14_长文本_0001"]);
    assert.ok(Object.keys(book).some((name) => name.startsWith("15_NULL坐标")));
    const header = book["01_月度收入"][0],
      row = book["01_月度收入"][1];
    const positive = header.indexOf("教研组长正向_beans_exact"),
      refund = header.indexOf("教研组长退款_beans_exact"),
      net = header.indexOf("教研组长净额_beans_exact");
    assert.deepEqual(
      [row[positive], row[refund], row[net]],
      ["90071992547409.93", "-0.01", "90071992547409.92"],
    );
    assert.equal(
      book["02_来源明细_0001"][0].includes("金额_beans_exact"),
      true,
    );
    assert.equal(
      Object.entries(book)
        .filter(([name]) => name.startsWith("02_来源明细"))
        .flatMap(([, rows]) => rows.slice(1))
        .some((row) => row.includes("退款冲回") && row.includes("fee-zero")),
      true,
    );
    assert.equal(
      Object.entries(book)
        .filter(([name]) => name.startsWith("15_NULL坐标"))
        .flatMap(([, rows]) => rows)
        .some((r) => r.includes("refund_finance_document_id") || r.includes("00_manifest")),
      true,
    );
    assert.equal(
      book["00_说明"].some((r) => r[0] === "派生状态" && r[1] === "PARTIAL"),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("rejects mismatched derived/index snapshots", async () => {
  await assert.rejects(
    new FullBackupIncomeWorkbook({
      index: {
        ...fakeIndex,
        metadata: () => ({ ...indexMeta, spoolId: "other" }),
      },
      view: fakeView,
      outputRoot: "/tmp/never",
    }).export(),
    /EXPORT_INCOME_WORKBOOK_SNAPSHOT_MISMATCH/,
  );
});

test("accepts the income source subset but rejects mismatched manifest sources", async () => {
  const valid = manifestContext();
  assert.ok(incomeSources.length < rawSources.length);
  await assert.rejects(new FullBackupIncomeWorkbook({
    index: fakeIndex,
    view: fakeView,
    outputRoot: "/tmp/never",
    manifestContext: { ...valid, snapshotId: "other-snapshot" },
  }).export(), /EXPORT_INCOME_WORKBOOK_MANIFEST_SNAPSHOT_MISMATCH/);
  await assert.rejects(new FullBackupIncomeWorkbook({
    index: fakeIndex,
    view: fakeView,
    outputRoot: "/tmp/never",
    manifestContext: {
      ...valid,
      rawTables: valid.rawTables.map((source, index) =>
        index === 0 ? { ...source, rowCount: "1" } : source),
    },
  }).export(), /EXPORT_INCOME_WORKBOOK_MANIFEST_SOURCE_MISMATCH/);
  await assert.rejects(new FullBackupIncomeWorkbook({
    index: fakeIndex,
    view: fakeView,
    outputRoot: "/tmp/never",
    manifestContext: {
      ...valid,
      rawTables: valid.rawTables.map((source, index) =>
        index === 0 ? { ...source, logicalDigest: "b".repeat(64) } : source),
    },
  }).export(), /EXPORT_INCOME_WORKBOOK_MANIFEST_SOURCE_MISMATCH/);
  for (const key of ["firstStableKey", "lastStableKey"]) {
    await assert.rejects(new FullBackupIncomeWorkbook({
      index: fakeIndex,
      view: fakeView,
      outputRoot: "/tmp/never",
      manifestContext: {
        ...valid,
        rawTables: valid.rawTables.map((source, index) =>
          index === 0 ? { ...source, [key]: '[\["id","forged"\]]' } : source),
      },
    }).export(), /EXPORT_INCOME_WORKBOOK_MANIFEST_SOURCE_MISMATCH/);
  }
  await assert.rejects(new FullBackupIncomeWorkbook({
    index: fakeIndex,
    view: { ...fakeView, metadata: () => ({
      ...metadata,
      sourceBasis: { ...metadata.sourceBasis, sourceRows: incomeSources.slice(1) },
    }) },
    outputRoot: "/tmp/never",
    manifestContext: valid,
  }).export(), /EXPORT_INCOME_WORKBOOK_MANIFEST_SOURCE_MISMATCH/);
  await assert.rejects(new FullBackupIncomeWorkbook({
    index: fakeIndex,
    view: { ...fakeView, metadata: () => ({
      ...metadata,
      sourceBasis: {
        ...metadata.sourceBasis,
        sourceRows: incomeSources.map((source, index) =>
          index === 0 ? { ...source, rowCount: "1" } : source),
      },
    }) },
    outputRoot: "/tmp/never",
    manifestContext: valid,
  }).export(), /EXPORT_INCOME_WORKBOOK_MANIFEST_SOURCE_MISMATCH/);
});
