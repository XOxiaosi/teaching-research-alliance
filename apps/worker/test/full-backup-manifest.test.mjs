import assert from "node:assert/strict";
import test from "node:test";
import {
  FULL_BACKUP_MANIFEST_EVIDENCE_COVERAGE_GAPS,
} from "../dist/full-backup-manifest-evidence.js";
import {
  createFullBackupManifestContext,
  createManifestWorkbookRows,
} from "../dist/full-backup-manifest.js";
import { createFullBackupLayout } from "../dist/full-backup-layout.js";

const layout = createFullBackupLayout();
const sha = "a".repeat(64);
const longKey = `[["id","${"x".repeat(40_000)}"]]`;
const secretExclusions = layout.flatMap((item) =>
  item.excludedColumns.map((fieldName) => ({
    tableName: item.tableName,
    fieldName,
    reason:
      item.policy === "AUTH_SECRET_TABLE_EXCLUDED"
        ? "AUTH_SECRET_TABLE_EXCLUDED"
        : "AUTH_SECRET_COLUMN_EXCLUDED",
  })),
);

const evidence = (asOf = "2026-09-23T00:00:00.000Z") => ({
  mode: "FULL_BACKUP_MANIFEST_EVIDENCE",
  schemaVersion: "full-backup-manifest-evidence.v1",
  complete: false,
  spoolId: "spool-1",
  snapshotId: "snapshot-1",
  asOf,
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
    ledgerEntryCount: "2",
    validEntryAmountCount: "2",
    invalidEntryAmountCount: "0",
    validEntryCentsSubtotal: "-9007199254740993",
    exactLedgerEntryCents: "-9007199254740993",
    ledgerAnomalyCount: "0",
    invalidMonthlyRowCount: "0",
    reconciliation: {
      accountCount: "1",
      statusCounts: {
        MATCH: "1",
        MISMATCH: "0",
        MISSING_PROJECTION: "0",
        PROJECTION_INVALID: "0",
        LEDGER_TOTAL_INVALID: "0",
        ACCOUNT_UNRESOLVED: "0",
      },
      validLedgerCentsSubtotal: "-9007199254740993",
      exactLedgerCents: "-9007199254740993",
      validProjectionCentsSubtotal: "0",
      exactProjectionCents: null,
    },
  },
  periods: {
    eventCount: "0",
    sourceLinkCount: "0",
    anomalyCount: "0",
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
});

const context = (asOf = "2026-09-23T00:00:00.000Z") =>
  createFullBackupManifestContext({
    evidence: evidence(asOf),
    fileGroupId: "implementation-group-1",
    generatedAt: "2026-09-23T01:02:03.000Z",
    applicationVersion: "0.1.0",
    generatorVersion: "worker.1",
  });

const rowsByField = (rows) => new Map(rows);
const validPart = () => ({
  sheetId: "t02_person_0001",
  logicalName: "人员",
  partNo: "1",
  rowCount: "1",
  sourceTable: "person",
  sourceLogicalDigest: sha,
  pageLogicalDigest: null,
  summaryScope: "SOURCE_TABLE_DIGEST_ONLY",
});

test("manifest context projects only fixed incomplete evidence and workbook rows preserve exact text/null values", () => {
  const value = context();
  assert.deepEqual(
    {
      mode: value.mode,
      complete: value.complete,
      backupStatus: value.backupStatus,
      backupId: value.backupId,
      exportJobId: value.exportJobId,
      timezone: value.timezone,
    },
    {
      mode: "FULL_BACKUP_MANIFEST_CONTEXT",
      complete: false,
      backupStatus: "INCOMPLETE_IMPLEMENTATION",
      backupId: null,
      exportJobId: null,
      timezone: "Asia/Shanghai",
    },
  );
  assert.equal(value.rawTables.length, layout.filter((item) => item.policy === "RAW_SOURCE").length);
  assert.equal(value.coverageGaps, FULL_BACKUP_MANIFEST_EVIDENCE_COVERAGE_GAPS);
  const rows = createManifestWorkbookRows({
    context: value,
    spoolId: "spool-1",
    snapshotId: "snapshot-1",
    asOf: "2026-09-23T00:00:00.000Z",
    file: "workbook-02.xlsx",
    workbookRole: "RAW",
    tableNumbers: [],
    sheetParts: [validPart()],
  });
  const fields = rowsByField(rows);
  assert.equal(fields.get("complete"), "false");
  assert.equal(fields.get("backup_status"), "INCOMPLETE_IMPLEMENTATION");
  assert.equal(fields.get("backup_id"), null);
  assert.equal(fields.get("export_job_id"), null);
  assert.equal(fields.get("package_manifest_ref"), "package-manifest.json");
  assert.equal(fields.get("money.exact_ledger_entry_cents"), "-9007199254740993");
  assert.equal(fields.get("money.reconciliation.valid_projection_cents_subtotal"), "0");
  assert.equal(fields.get("money.reconciliation.exact_projection_cents"), null);
  assert.equal(fields.get("raw.person.first_stable_key"), longKey);
  assert.equal(fields.get("sheet.t02_person_0001.page_logical_digest"), null);
  assert.equal(fields.get("sheet.t02_person_0001.summary_scope"), "SOURCE_TABLE_DIGEST_ONLY");
  assert.equal(rows.some(([field]) => /sha256|bytes_hash|package_manifest_sha/i.test(field)), false);
});

test("manifest context rejects forged identity, extra keys, bad counts, or a complete claim", () => {
  const invalidIdentity = {
    evidence: evidence(),
    fileGroupId: "../path",
    generatedAt: "2026-09-23T01:02:03.000Z",
    applicationVersion: "0.1.0",
    generatorVersion: "worker.1",
  };
  assert.throws(() => createFullBackupManifestContext(invalidIdentity), /EXPORT_MANIFEST_CONTEXT_INPUT_INVALID/);
  const extra = {
    evidence: evidence(),
    fileGroupId: "group-1",
    generatedAt: "2026-09-23T01:02:03.000Z",
    applicationVersion: "0.1.0",
    generatorVersion: "worker.1",
    secret: "must-not-pass",
  };
  assert.throws(() => createFullBackupManifestContext(extra), /EXPORT_MANIFEST_CONTEXT_INPUT_INVALID/);
  const complete = evidence();
  complete.complete = true;
  assert.throws(
    () =>
      createFullBackupManifestContext({
        evidence: complete,
        fileGroupId: "group-1",
        generatedAt: "2026-09-23T01:02:03.000Z",
        applicationVersion: "0.1.0",
        generatorVersion: "worker.1",
      }),
    /EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID/,
  );
  const badCount = evidence();
  badCount.raw.nonSecretTables[0].rowCount = "01";
  assert.throws(
    () =>
      createFullBackupManifestContext({
        evidence: badCount,
        fileGroupId: "group-1",
        generatedAt: "2026-09-23T01:02:03.000Z",
        applicationVersion: "0.1.0",
        generatorVersion: "worker.1",
      }),
    /EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID/,
  );
  for (const invalidate of [
    (value) => { value.money.validEntryCentsSubtotal = null; },
    (value) => { value.money.reconciliation.validLedgerCentsSubtotal = null; },
    (value) => { value.money.reconciliation.validProjectionCentsSubtotal = null; },
  ]) {
    const invalidSubtotal = evidence();
    invalidate(invalidSubtotal);
    assert.throws(() => createFullBackupManifestContext({
      evidence: invalidSubtotal,
      fileGroupId: "group-1",
      generatedAt: "2026-09-23T01:02:03.000Z",
      applicationVersion: "0.1.0",
      generatorVersion: "worker.1",
    }), /EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID/);
  }
});

test("manifest preserves strict PostgreSQL source timestamps and rejects rolled calendar dates or missing timezones", () => {
  for (const asOf of [
    "2026-02-28 23:59:59.123456+00",
    "2024-02-29 00:00:00.1-07:00",
    "2026-09-23T00:00:00.000Z",
  ]) {
    const value = context(asOf);
    assert.equal(value.asOf, asOf);
    assert.doesNotThrow(() => createManifestWorkbookRows({
      context: value,
      spoolId: value.spoolId,
      snapshotId: value.snapshotId,
      asOf,
      file: "workbook-02.xlsx",
      workbookRole: "RAW",
      tableNumbers: [],
      sheetParts: [validPart()],
    }));
  }
  for (const asOf of [
    "2026-02-29 00:00:00.123456+00",
    "2026-09-23 00:00:00.123456",
    "2026-09-23T00:00:00.000",
  ]) {
    assert.throws(() => createFullBackupManifestContext({
      evidence: evidence(asOf),
      fileGroupId: "group-1",
      generatedAt: "2026-09-23T01:02:03.000Z",
      applicationVersion: "0.1.0",
      generatorVersion: "worker.1",
    }), /EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID/);
  }
  assert.throws(() => createFullBackupManifestContext({
    evidence: evidence(),
    fileGroupId: "group-1",
    generatedAt: "2026-02-29T01:02:03.000Z",
    applicationVersion: "0.1.0",
    generatorVersion: "worker.1",
  }), /EXPORT_MANIFEST_CONTEXT_INPUT_INVALID/);
});

test("workbook rows require same snapshot, fixed file-role-table mapping, and source-level-only main sheet summaries", () => {
  const value = context();
  const base = {
    context: value,
    spoolId: value.spoolId,
    snapshotId: value.snapshotId,
    asOf: value.asOf,
    sheetParts: [validPart()],
  };
  assert.doesNotThrow(() =>
    createManifestWorkbookRows({
      ...base,
      file: "business-table-7-ledger-derived.xlsx",
      workbookRole: "BUSINESS_DERIVED",
      tableNumbers: [7],
    }),
  );
  for (const workbookId of [...new Set(layout
    .filter((item) => item.policy === "RAW_SOURCE")
    .map((item) => item.workbookId))]) {
    assert.doesNotThrow(() => createManifestWorkbookRows({
      ...base,
      file: `workbook-${workbookId}.xlsx`,
      workbookRole: "RAW",
      tableNumbers: [],
    }));
  }
  assert.throws(() => createManifestWorkbookRows({
    ...base,
    snapshotId: "other-snapshot",
    file: "workbook-02.xlsx",
    workbookRole: "RAW",
    tableNumbers: [],
  }), /EXPORT_MANIFEST_WORKBOOK_INPUT_INVALID/);
  assert.throws(() => createManifestWorkbookRows({
    ...base,
    file: "business-table-7-ledger-derived.xlsx",
    workbookRole: "BUSINESS_FACT",
    tableNumbers: [7],
  }), /EXPORT_MANIFEST_WORKBOOK_MAPPING_INVALID/);
  assert.throws(() => createManifestWorkbookRows({
    ...base,
    file: "workbook-02.xlsx",
    workbookRole: "RAW",
    tableNumbers: [7],
  }), /EXPORT_MANIFEST_WORKBOOK_MAPPING_INVALID/);
  assert.throws(() => createManifestWorkbookRows({
    ...base,
    file: "workbook-02.xlsx",
    workbookRole: "RAW",
    tableNumbers: [],
    sheetParts: [{ ...validPart(), pageLogicalDigest: sha }],
  }), /EXPORT_MANIFEST_WORKBOOK_PARTS_INVALID/);
  assert.throws(() => createManifestWorkbookRows({
    ...base,
    file: "workbook-02.xlsx",
    workbookRole: "RAW",
    tableNumbers: [],
    sheetParts: [{ ...validPart(), sourceLogicalDigest: "b".repeat(64) }],
  }), /EXPORT_MANIFEST_WORKBOOK_PARTS_INVALID/);
  assert.throws(() => createManifestWorkbookRows({
    ...base,
    file: "workbook-02.xlsx",
    workbookRole: "RAW",
    tableNumbers: [],
    sheetParts: [validPart(), validPart()],
  }), /EXPORT_MANIFEST_WORKBOOK_PARTS_INVALID/);
  assert.throws(() => createManifestWorkbookRows({
    ...base,
    file: "workbook-02.xlsx",
    workbookRole: "RAW",
    tableNumbers: [],
    sheetParts: [{ ...validPart(), partNo: "0" }],
  }), /EXPORT_MANIFEST_WORKBOOK_PARTS_INVALID/);
  assert.throws(() => createManifestWorkbookRows({
    ...base,
    context: { ...value, complete: true },
    file: "workbook-02.xlsx",
    workbookRole: "RAW",
    tableNumbers: [],
  }), /EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID/);
  assert.throws(() => createManifestWorkbookRows({
    ...base,
    context: { ...value, accidentalSecret: "must-not-pass" },
    file: "workbook-02.xlsx",
    workbookRole: "RAW",
    tableNumbers: [],
  }), /EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID/);
  for (const invalidMoney of [
    { ...value.money, validEntryCentsSubtotal: null },
    {
      ...value.money,
      reconciliation: { ...value.money.reconciliation, validLedgerCentsSubtotal: null },
    },
    {
      ...value.money,
      reconciliation: { ...value.money.reconciliation, validProjectionCentsSubtotal: null },
    },
  ]) {
    assert.throws(() => createManifestWorkbookRows({
      ...base,
      context: { ...value, money: invalidMoney },
      file: "workbook-02.xlsx",
      workbookRole: "RAW",
      tableNumbers: [],
    }), /EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID/);
  }
  assert.throws(() => createManifestWorkbookRows({
    ...base,
    file: "workbook-99.xlsx",
    workbookRole: "RAW",
    tableNumbers: [],
  }), /EXPORT_MANIFEST_WORKBOOK_MAPPING_INVALID/);
});
