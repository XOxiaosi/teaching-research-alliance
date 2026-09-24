import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FULL_BACKUP_MANIFEST_EVIDENCE_COVERAGE_GAPS } from "../dist/full-backup-manifest-evidence.js";
import {
  createFullBackupManifestContext,
  createManifestWorkbookRows,
} from "../dist/full-backup-manifest.js";
import { createFullBackupLayout } from "../dist/full-backup-layout.js";
import { splitBackupLongText } from "../dist/full-backup-long-text.js";
import { verifyWorkbookManifest } from "../dist/full-backup-workbook-manifest-reader.js";
import { writeXlsx } from "../dist/openxml-xlsx-writer.js";

const layout = createFullBackupLayout();
const sha = "a".repeat(64);
const longKey = '[["id","' + "x".repeat(40_000) + '"]]';
const secretExclusions = layout.flatMap((item) =>
  item.excludedColumns.map((fieldName) => ({
    tableName: item.tableName,
    fieldName,
    reason: item.policy === "AUTH_SECRET_TABLE_EXCLUDED"
      ? "AUTH_SECRET_TABLE_EXCLUDED"
      : "AUTH_SECRET_COLUMN_EXCLUDED",
  })),
);

const context = () => createFullBackupManifestContext({
  evidence: {
    mode: "FULL_BACKUP_MANIFEST_EVIDENCE",
    schemaVersion: "full-backup-manifest-evidence.v1",
    complete: false,
    spoolId: "spool-1",
    snapshotId: "snapshot-1",
    asOf: "2026-09-23T00:00:00.000Z",
    raw: {
      registeredDatasetCount: String(layout.length),
      nonSecretTables: layout
        .filter((item) => item.policy === "RAW_SOURCE")
        .map((item) => ({
          tableName: item.tableName,
          rowCount: item.tableName === "person" ? "1" : "0",
          firstStableKey: item.tableName === "person" ? longKey : null,
          lastStableKey: item.tableName === "person" ? longKey : null,
          logicalDigest: sha,
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
      eventCount: "0", sourceLinkCount: "0", anomalyCount: "0",
      statusCounts: {
        UNIQUE_LOCKED_SETTLEMENT_MONTH: "0",
        MULTIPLE_BUSINESS_PERIODS: "0",
        UNRESOLVED: "0",
        UNIMPLEMENTED_EVENT_TYPE: "0",
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
  fileGroupId: "group-1",
  generatedAt: "2026-09-23T01:00:00.000Z",
  applicationVersion: "0.1.0",
  generatorVersion: "test.1",
});

const part = () => ({
  sheetId: layout.find((item) => item.tableName === "person").sheetId + "_0001",
  logicalName: "person",
  partNo: "1",
  rowCount: "1",
  sourceTable: "person",
  sourceLogicalDigest: sha,
  pageLogicalDigest: null,
  summaryScope: "SOURCE_TABLE_DIGEST_ONLY",
});

const profileChangePart = () => ({
  sheetId: layout.find((item) => item.tableName === "person_profile_change").sheetId + "_0001",
  logicalName: "person_profile_change",
  partNo: "1",
  rowCount: "0",
  sourceTable: "person_profile_change",
  sourceLogicalDigest: sha,
  pageLogicalDigest: null,
  summaryScope: "SOURCE_TABLE_DIGEST_ONLY",
});

const teacherPart = () => ({
  sheetId: layout.find((item) => item.tableName === "teacher_profile").sheetId + "_0001",
  logicalName: "teacher_profile",
  partNo: "1",
  rowCount: "0",
  sourceTable: "teacher_profile",
  sourceLogicalDigest: sha,
  pageLogicalDigest: null,
  summaryScope: "SOURCE_TABLE_DIGEST_ONLY",
});

const render = (value) => value === null ? "" : (splitBackupLongText(value)?.reference ?? value);
const rows = (value, parts = [part(), profileChangePart(), teacherPart()]) => createManifestWorkbookRows({
  context: value,
  spoolId: value.spoolId,
  snapshotId: value.snapshotId,
  asOf: value.asOf,
  file: "workbook-02.xlsx",
  workbookRole: "RAW",
  tableNumbers: [],
  sheetParts: parts,
});

const input = (root, value) => ({
  root,
  relativePath: "workbook-02.xlsx",
  context: value,
  file: "workbook-02.xlsx",
  workbookRole: "RAW",
  tableNumbers: [],
});

const defaultMainSheets = () => [
  { name: part().sheetId, rows: [["row"]] },
  { name: profileChangePart().sheetId, rows: [] },
  { name: teacherPart().sheetId, rows: [] },
];

async function writeWorkbook(root, manifestRows, firstSheet = "00_manifest", mainSheets = defaultMainSheets()) {
  const outputPath = join(root, "workbook-02.xlsx");
  await writeXlsx({
    outputPath,
    sheets: [
      { name: firstSheet, columns: ["字段", "内容"], rows: manifestRows.map((row) => row.map(render)) },
      ...(firstSheet === "00_manifest"
        ? mainSheets
        : [{ name: "00_manifest", rows: [["row"]] }, ...mainSheets])
        .map((sheet) => ({ name: sheet.name, columns: sheet.columns ?? ["source"], rows: sheet.rows })),
    ],
  });
  return outputPath;
}

function centralEntry(bytes, name) {
  const eocd = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(eocd), 0x06054b50);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  const count = bytes.readUInt16LE(eocd + 8);
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const candidate = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (candidate === name) return { central: offset, local: bytes.readUInt32LE(offset + 42), nameLength };
    offset += 46 + nameLength;
  }
  throw new Error("test entry missing");
}

const crcTable = new Uint32Array(256);
for (let number = 0; number < 256; number += 1) {
  let value = number;
  for (let bit = 0; bit < 8; bit += 1)
    value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  crcTable[number] = value >>> 0;
}

function rewriteEntryCrc(bytes, entry) {
  const size = bytes.readUInt32LE(entry.central + 20);
  const dataOffset = entry.local + 30 + entry.nameLength;
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(dataOffset, dataOffset + size))
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const final = (crc ^ 0xffffffff) >>> 0;
  bytes.writeUInt32LE(final, entry.central + 16);
  bytes.writeUInt32LE(final, dataOffset + size + 4);
}

test("真实 writeXlsx 清单逐行校验可信 context、长文本引用和分片摘要", async () => {
  const root = await mkdtemp(join(tmpdir(), "alliance-manifest-reader-"));
  try {
    const trusted = context();
    const manifestRows = rows(trusted);
    await writeWorkbook(root, manifestRows);
    assert.deepEqual(await verifyWorkbookManifest(input(root, trusted)), {
      manifestRowCount: String(manifestRows.length),
      mainSheetPartCount: "3",
    });
    await assert.rejects(
      () => verifyWorkbookManifest(input(root, { ...trusted, snapshotId: "snapshot-2" })),
      /XLSX_MANIFEST_PREFIX_MISMATCH/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("主表逐页流式计数，合法多页通过而重写空页不能沿用旧 manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "alliance-manifest-reader-pages-"));
  try {
    const base = context();
    const trusted = {
      ...base,
      rawTables: base.rawTables.map((table) => table.tableName === "person" ? { ...table, rowCount: "2" } : table),
    };
    const first = part();
    const second = { ...part(), sheetId: part().sheetId.replace("_0001", "_0002"), partNo: "2" };
    const manifestRows = rows(trusted, [first, second, profileChangePart(), teacherPart()]);
    await writeWorkbook(root, manifestRows, "00_manifest", [
      { name: first.sheetId, rows: [["first"]] },
      { name: second.sheetId, rows: [["second"]] },
      { name: profileChangePart().sheetId, rows: [] },
      { name: teacherPart().sheetId, rows: [] },
    ]);
    assert.deepEqual(await verifyWorkbookManifest(input(root, trusted)), {
      manifestRowCount: String(manifestRows.length),
      mainSheetPartCount: "4",
    });
    const path = join(root, "workbook-02.xlsx");
    await rm(path);
    await writeWorkbook(root, manifestRows, "00_manifest", [
      { name: first.sheetId, rows: [] },
      { name: second.sheetId, rows: [["second"]] },
      { name: profileChangePart().sheetId, rows: [] },
      { name: teacherPart().sheetId, rows: [] },
    ]);
    await assert.rejects(
      () => verifyWorkbookManifest(input(root, trusted)),
      /XLSX_MANIFEST_PART_ROW_COUNT_INVALID/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("伪造 complete、首工作表和公式形式均不能作为本项目 manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "alliance-manifest-reader-forge-"));
  try {
    const trusted = context();
    const forged = rows(trusted).map((row) => row[0] === "complete" ? [row[0], "true"] : row);
    await writeWorkbook(root, forged);
    await assert.rejects(() => verifyWorkbookManifest(input(root, trusted)), /XLSX_MANIFEST_PREFIX_MISMATCH/);
    await rm(join(root, "workbook-02.xlsx"));
    await writeWorkbook(root, rows(trusted), "not_manifest");
    await assert.rejects(() => verifyWorkbookManifest(input(root, trusted)), /XLSX_MANIFEST_WORKBOOK_INVALID/);
    await rm(join(root, "workbook-02.xlsx"));
    await writeWorkbook(root, rows(trusted));
    const path = join(root, "workbook-02.xlsx");
    const bytes = await readFile(path);
    const sheet = centralEntry(bytes, "xl/worksheets/sheet1.xml");
    const dataOffset = sheet.local + 30 + sheet.nameLength;
    const close = bytes.indexOf(Buffer.from("</is>"), dataOffset);
    assert.ok(close >= dataOffset);
    bytes.write("<f/> ", close, "utf8");
    await writeFile(path, bytes);
    await assert.rejects(() => verifyWorkbookManifest(input(root, trusted)), /XLSX_MANIFEST_SHEET_INVALID/);
    await rm(path);
    await writeWorkbook(root, rows(trusted));
    const businessBytes = await readFile(path);
    const business = centralEntry(businessBytes, "xl/worksheets/sheet2.xml");
    const businessDataOffset = business.local + 30 + business.nameLength;
    const businessClose = businessBytes.indexOf(Buffer.from("</is>"), businessDataOffset);
    assert.ok(businessClose >= businessDataOffset);
    businessBytes.write("<f/> ", businessClose, "utf8");
    await writeFile(path, businessBytes);
    await assert.rejects(() => verifyWorkbookManifest(input(root, trusted)), /XLSX_MANIFEST_SHEET_INVALID/);
    await rm(path);
    await writeWorkbook(root, rows(trusted, []));
    await assert.rejects(() => verifyWorkbookManifest(input(root, trusted)), /XLSX_MANIFEST_SHEET_INVALID/);
    await rm(path);
    await writeWorkbook(root, rows(trusted, [{ ...part(), sheetId: part().sheetId.replace("_0001", "_0002") }, profileChangePart(), teacherPart()]));
    await assert.rejects(() => verifyWorkbookManifest(input(root, trusted)), /XLSX_MANIFEST_PART_INVALID/);
    await rm(path);
    await writeWorkbook(root, rows(trusted, [{ ...part(), sourceTable: "teacher_profile" }, profileChangePart(), teacherPart()]));
    await assert.rejects(() => verifyWorkbookManifest(input(root, trusted)), /XLSX_MANIFEST_PART_INVALID/);
    await rm(path);
    await writeWorkbook(root, rows(trusted, [{ ...part(), rowCount: "0" }, profileChangePart(), teacherPart()]));
    await assert.rejects(() => verifyWorkbookManifest(input(root, trusted)), /XLSX_MANIFEST_PART_INVALID/);
    await rm(path);
    await writeWorkbook(root, rows(trusted), "00_manifest", [
      { name: part().sheetId, columns: ["source", "extra"], rows: [["row"]] },
      { name: profileChangePart().sheetId, rows: [] },
      { name: teacherPart().sheetId, rows: [] },
    ]);
    await assert.rejects(() => verifyWorkbookManifest(input(root, trusted)), /XLSX_MANIFEST_SHEET_INVALID/);
    await rm(path);
    await writeWorkbook(root, rows(trusted));
    const malformedBytes = await readFile(path);
    const malformed = centralEntry(malformedBytes, "xl/worksheets/sheet2.xml");
    const malformedDataOffset = malformed.local + 30 + malformed.nameLength;
    const rowClose = malformedBytes.indexOf(Buffer.from("</row>"), malformedDataOffset);
    assert.ok(rowClose >= malformedDataOffset);
    malformedBytes.write("<row> ", rowClose, "utf8");
    rewriteEntryCrc(malformedBytes, malformed);
    await writeFile(path, malformedBytes);
    await assert.rejects(() => verifyWorkbookManifest(input(root, trusted)), /XLSX_MANIFEST_SHEET_INVALID/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("截断、CRC 和中央目录偏移损坏都会在有界 ZIP32 读取中拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "alliance-manifest-reader-zip-"));
  try {
    const trusted = context();
    const manifestRows = rows(trusted);
    const path = await writeWorkbook(root, manifestRows);
    const original = await readFile(path);
    await truncate(path, original.length - 1);
    await assert.rejects(() => verifyWorkbookManifest(input(root, trusted)), /XLSX_MANIFEST_ZIP_(TRUNCATED|INVALID)/);
    await writeFile(path, original);
    const crcCorrupt = Buffer.from(original);
    const workbook = centralEntry(crcCorrupt, "xl/workbook.xml");
    crcCorrupt.writeUInt32LE((crcCorrupt.readUInt32LE(workbook.central + 16) ^ 1) >>> 0, workbook.central + 16);
    await writeFile(path, crcCorrupt);
    await assert.rejects(() => verifyWorkbookManifest(input(root, trusted)), /XLSX_MANIFEST_CRC_INVALID/);
    const mainCrcCorrupt = Buffer.from(original);
    const main = centralEntry(mainCrcCorrupt, "xl/worksheets/sheet2.xml");
    mainCrcCorrupt.writeUInt32LE((mainCrcCorrupt.readUInt32LE(main.central + 16) ^ 1) >>> 0, main.central + 16);
    await writeFile(path, mainCrcCorrupt);
    await assert.rejects(() => verifyWorkbookManifest(input(root, trusted)), /XLSX_MANIFEST_CRC_INVALID/);
    const typesCrcCorrupt = Buffer.from(original);
    const types = centralEntry(typesCrcCorrupt, "[Content_Types].xml");
    typesCrcCorrupt.writeUInt32LE((typesCrcCorrupt.readUInt32LE(types.central + 16) ^ 1) >>> 0, types.central + 16);
    await writeFile(path, typesCrcCorrupt);
    await assert.rejects(() => verifyWorkbookManifest(input(root, trusted)), /XLSX_MANIFEST_CRC_INVALID/);
    const offsetCorrupt = Buffer.from(original);
    const sheet = centralEntry(offsetCorrupt, "xl/worksheets/sheet1.xml");
    offsetCorrupt.writeUInt32LE(sheet.local + 1, sheet.central + 42);
    await writeFile(path, offsetCorrupt);
    await assert.rejects(() => verifyWorkbookManifest(input(root, trusted)), /XLSX_MANIFEST_ZIP_INVALID/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("私有文件入口拒绝秘密路径与符号链接", async () => {
  const root = await mkdtemp(join(tmpdir(), "alliance-manifest-reader-private-"));
  try {
    const trusted = context();
    const path = await writeWorkbook(root, rows(trusted));
    await assert.rejects(
      () => verifyWorkbookManifest({ ...input(root, trusted), relativePath: "../workbook-02.xlsx" }),
      /BACKUP_FILE_INVALID/,
    );
    await symlink(path, join(root, "link.xlsx"));
    await assert.rejects(
      () => verifyWorkbookManifest({ ...input(root, trusted), relativePath: "link.xlsx" }),
      /BACKUP_FILE_INVALID|ELOOP/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
