import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { FullBackupLedgerWorkbook } from "../dist/full-backup-ledger-workbook.js";
import { createFullBackupManifestContext } from "../dist/full-backup-manifest.js";
import {
  FULL_BACKUP_MANIFEST_EVIDENCE_COVERAGE_GAPS,
} from "../dist/full-backup-manifest-evidence.js";
import { createFullBackupLayout } from "../dist/full-backup-layout.js";
import { fullBackupOutputColumns } from "../dist/full-backup-transformer.js";

const run = promisify(execFile);
const collectWorkbook = async (file) => {
  const { stdout } = await run("python3", ["-c", `import zipfile,xml.etree.ElementTree as E,json,sys
z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None
ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
b=E.fromstring(z.read('xl/workbook.xml'));rels=E.fromstring(z.read('xl/_rels/workbook.xml.rels'));targets={x.attrib['Id']:x.attrib['Target'] for x in rels};out={}
for s in b.findall('.//m:sheet',ns):
 r=E.fromstring(z.read('xl/'+targets[s.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]))
 assert not r.findall('.//m:f',ns);out[s.attrib['name']]=[[c.find('.//m:t',ns).text or '' for c in row.findall('m:c',ns)] for row in r.findall('.//m:row',ns)]
print(json.dumps(out,ensure_ascii=False))`, file]);
  return JSON.parse(stdout);
};
const stream = async function* (rows) { yield* rows; };
const layout = createFullBackupLayout();
const rawSources = layout
  .filter((item) => item.policy === "RAW_SOURCE")
  .map((item) => ({ tableName: item.tableName, rowCount: "0" }));
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
    spoolId: "spool",
    snapshotId: "snapshot",
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
      ledgerEntryCount: "0",
      validEntryAmountCount: "0",
      invalidEntryAmountCount: "0",
      validEntryCentsSubtotal: "0",
      exactLedgerEntryCents: null,
      ledgerAnomalyCount: "0",
      invalidMonthlyRowCount: "0",
      reconciliation: {
        accountCount: "0",
        statusCounts: {
          MATCH: "0", MISMATCH: "0", MISSING_PROJECTION: "0",
          PROJECTION_INVALID: "0", LEDGER_TOTAL_INVALID: "0", ACCOUNT_UNRESOLVED: "0",
        },
        validLedgerCentsSubtotal: "0",
        exactLedgerCents: null,
        validProjectionCentsSubtotal: "0",
        exactProjectionCents: null,
      },
    },
    periods: {
      eventCount: "0",
      sourceLinkCount: "0",
      anomalyCount: "0",
      statusCounts: {
        UNIQUE_LOCKED_SETTLEMENT_MONTH: "0", MULTIPLE_BUSINESS_PERIODS: "0",
        UNRESOLVED: "0", UNIMPLEMENTED_EVENT_TYPE: "0",
      },
    },
    integrity: {
      status: "VERIFIED_PARTIAL",
      scope: "REGISTERED_RAW_AND_LEDGER_EVIDENCE_ONLY",
      completeBackup: false,
    },
    businessCorrectness: {
      status: "NOT_ASSERTED",
      scope: "NO_COMPLETE_BUSINESS_CORRECTNESS_ASSERTION",
    },
    coverageGaps: [...FULL_BACKUP_MANIFEST_EVIDENCE_COVERAGE_GAPS],
  },
  fileGroupId: "ledger-workbook-group",
  generatedAt: "2026-09-23T00:00:00.000Z",
  applicationVersion: "0.1.0",
  generatorVersion: "worker.1",
});
const meta = {
  spoolId: "spool",
  snapshotId: "snapshot",
  asOf: "2026-09-23T00:00:00.000Z",
  sources: rawSources,
};

test("table-7 workbook pages bounded streams, preserves exact beans and keeps unsupported business periods explicit", async () => {
  const root = await mkdtemp(join(tmpdir(), "ledger-workbook-unit-"));
  const longCode = `=${"A".repeat(32_100)}`;
  const index = {
    metadata: () => meta,
    stream: () => stream([]),
    lookup: async () => undefined,
  };
  const ledger = {
    metadata: () => ({ ...meta, coverageGaps: ["SETTLEMENT_PUBLISHED_SNAPSHOTS_NOT_IMPLEMENTED"], anomalyCount: "1" }),
    streamEntries: () => stream([
      { sourceRecordKey:"entry-key",sourceRowNumber:"1",entryId:"entry",eventId:"event",accountId:"company",categoryKey:"=category",amountCents:"-1",entryCreatedAt:null,eventSourceRecordKey:"event-key",eventKeyFingerprint:"f".repeat(64),eventType:"=FUTURE",eventPayloadHash:"p",eventCreatedAt:"2026-09-23T00:00:00Z",accountSourceRecordKey:"account-key",accountOwnerType:"COMPANY",accountOwnerId:"company-owner",accountCode:longCode,accountStatus:"ACTIVE",postMonth:"2026-09-01",fiscalYearStart:"2026-09-01",sourceChainStatus:"RESOLVED_UNVERIFIED" },
    ]),
    streamMonthlyRows: () => stream([{ accountId:"company",postMonth:"2026-09-01",fiscalYearStart:"2026-09-01",categoryKey:"=category",signedNetCents:"-1",entryCount:"1",invalidAmountCount:"0",status:"VALID" }]),
    streamReconciliations: () => stream([{ accountId:"company",accountSourceRecordKey:"account-key",accountOwnerType:"COMPANY",accountOwnerId:"company-owner",accountCode:longCode,ledgerNetCents:"-1",projectionBalanceCents:"-1",status:"MATCH" }]),
    streamAnomalies: () => stream([{ code:"LEDGER_ENTRY_AMOUNT_INVALID",sourceTable:"ledger_entry",sourceRecordKey:"entry-key",sourceRowNumber:"1",field:"amount_cents" }]),
  };
  const periods = {
    metadata: () => ({ ...meta, anomalyCount: "1" }),
    streamEventPeriods: () => stream([
      { eventId:"settlement",eventSourceRecordKey:"settlement-key",eventType:"WEEKLY_FEE_SETTLEMENT",status:"MULTIPLE_BUSINESS_PERIODS",uniqueLockedSettlementMonth:null,distinctMonthCount:"2",sourceLinkCount:"2",anomalyCount:"0" },
      { eventId:"event",eventSourceRecordKey:"event-key",eventType:"FUTURE_F14_EVENT",status:"UNIMPLEMENTED_EVENT_TYPE",uniqueLockedSettlementMonth:null,distinctMonthCount:"0",sourceLinkCount:"0",anomalyCount:"0" },
    ]),
    streamSourceLinks: () => stream([{ eventId:"settlement",eventSourceRecordKey:"settlement-key",relation:"WEEKLY_FEE_VERSION",sourceTable:"weekly_fee_entry_version",sourceRecordKey:"version-key",sourceRowNumber:"1",financeDocumentId:null,runId:null,allocationSnapshotId:null,weeklyFeeEntryId:"fee",weeklyFeeVersion:"1",lockedSettlementMonth:"2026-09-01" }]),
    streamAnomalies: () => stream([{ code:"REFUND_MONTH_MISMATCH",eventId:"event",eventSourceRecordKey:"event-key",sourceTable:"weekly_fee_refund_effect",sourceRecordKey:"effect-key",sourceRowNumber:"1" }]),
  };
  try {
    const result = await new FullBackupLedgerWorkbook({ index, ledger, periods, outputRoot: root, manifestContext: manifestContext(), maxDataRows: 1 }).export();
    assert.deepEqual({ mode: result.mode, complete: result.complete, tableNumber: result.tableNumber, schemaVersion: result.schemaVersion, coveredTables: result.coveredTables }, { mode:"LEDGER_DERIVED_WORKBOOK",complete:false,tableNumber:7,schemaVersion:"ledger-workbook.v1",coveredTables:[7] });
    const directory = join(root, result.outputId), file = join(directory, result.file);
    const bytes = await readFile(file); assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex")); assert.equal(result.sizeBytes, String(bytes.byteLength));
    const sheets = await collectWorkbook(file);
    assert.equal(Object.keys(sheets)[0], "00_manifest");
    assert.equal(sheets["00_manifest"].some((row) => row[0] === "complete" && row[1] === "false"), true);
    assert.equal(sheets["00_manifest"].some((row) => row[0] === "sheet.01_原始分录.source_table" && row[1] === ""), true);
    const sheet = (name) => Object.entries(sheets).find(([candidate]) => candidate === name || candidate.startsWith(`${name}_`))?.[1];
    assert.ok(sheet("01_原始分录") && sheet("02_入账月汇总") && sheet("03_账户余额对账") && sheet("04_账本异常") && sheet("05_业务期间") && sheet("06_业务期间链接") && sheet("07_业务期间异常") && sheet("14_长文本") && sheet("15_NULL坐标"));
    const entryHeader = sheet("01_原始分录")[0], entry = sheet("01_原始分录")[1];
    assert.equal(entry[entryHeader.indexOf("金额原始分 [amount_cents_raw]")], "-1"); assert.equal(entry[entryHeader.indexOf("金额豆精确 [amount_beans_exact]")], "-0.01"); assert.equal(entry[entryHeader.indexOf("事件类型")], "=FUTURE");
    assert.equal(entry[entryHeader.indexOf("账户编号")].startsWith("long_text_ref:sha256:"), true);
    assert.equal(Object.values(sheets).some((rows) => rows.slice(1).some((row) => row.at(-1) === longCode.slice(0, 32000))), true);
    const periodHeader = sheet("05_业务期间")[0], periodRows = Object.values(sheets).flatMap((rows) => rows.slice(1)).filter((row) => row.length === periodHeader.length && row[periodHeader.indexOf("业务期间状态")] !== undefined);
    assert.equal(periodRows.some((row) => row[periodHeader.indexOf("业务期间状态")] === "MULTIPLE_BUSINESS_PERIODS" && row[periodHeader.indexOf("唯一锁定结算月")] === ""), true);
    assert.equal(periodRows.some((row) => row[periodHeader.indexOf("事件类型")] === "FUTURE_F14_EVENT" && row[periodHeader.indexOf("业务期间状态")] === "UNIMPLEMENTED_EVENT_TYPE"), true);
    assert.equal(sheet("04_账本异常").length, 2); assert.equal(sheet("07_业务期间异常").length, 2);
    assert.equal((await readdir(directory)).length, 1, "private NDJSON indexes are removed after a successful workbook");
    const valid = manifestContext();
    await assert.rejects(new FullBackupLedgerWorkbook({
      index,
      ledger,
      periods,
      outputRoot: root,
      manifestContext: { ...valid, snapshotId: "other-snapshot" },
    }).export(), /EXPORT_LEDGER_WORKBOOK_MANIFEST_SNAPSHOT_MISMATCH/);
    await assert.rejects(new FullBackupLedgerWorkbook({
      index,
      ledger,
      periods,
      outputRoot: root,
      manifestContext: {
        ...valid,
        rawTables: valid.rawTables.map((source, index) =>
          index === 0 ? { ...source, rowCount: "1" } : source),
      },
    }).export(), /EXPORT_LEDGER_WORKBOOK_MANIFEST_SOURCE_MISMATCH/);
    await assert.rejects(new FullBackupLedgerWorkbook({
      index,
      ledger,
      periods,
      outputRoot: root,
      manifestContext: {
        ...valid,
        rawTables: valid.rawTables.map((source, index) =>
          index === 0 ? { ...source, logicalDigest: "b".repeat(64) } : source),
      },
    }).export(), /EXPORT_LEDGER_WORKBOOK_MANIFEST_SOURCE_MISMATCH/);
    for (const key of ["firstStableKey", "lastStableKey"]) {
      await assert.rejects(new FullBackupLedgerWorkbook({
        index,
        ledger,
        periods,
        outputRoot: root,
        manifestContext: {
          ...valid,
          rawTables: valid.rawTables.map((source, index) =>
            index === 0 ? { ...source, [key]: '[\["id","forged"\]]' } : source),
        },
      }).export(), /EXPORT_LEDGER_WORKBOOK_MANIFEST_SOURCE_MISMATCH/);
    }
  } finally { await rm(root, { recursive:true, force:true }); }
});
