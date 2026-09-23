import {
  FULL_BACKUP_MANIFEST_EVIDENCE_COVERAGE_GAPS,
  FULL_BACKUP_MANIFEST_EVIDENCE_SCHEMA_VERSION,
  type FullBackupManifestEvidenceResult,
} from "./full-backup-manifest-evidence.js";
import { createFullBackupLayout } from "./full-backup-layout.js";

type Text = string | null;

export const FULL_BACKUP_MANIFEST_SCHEMA_VERSION =
  "full-backup-manifest.v1";

export type ManifestWorkbookRole =
  | "RAW"
  | "BUSINESS_FACT"
  | "BUSINESS_DERIVED";

/**
 * These summaries describe main data sheets only. Writers append their own
 * long-text and NULL-coordinate sheets after this factory has returned.
 */
export type ManifestSheetPart = Readonly<{
  sheetId: string;
  logicalName: string;
  partNo: string;
  rowCount: string;
  sourceTable: string | null;
  sourceLogicalDigest: string | null;
  pageLogicalDigest: null;
  summaryScope: "SOURCE_TABLE_DIGEST_ONLY";
}>;

export type FullBackupManifestContext = Readonly<{
  mode: "FULL_BACKUP_MANIFEST_CONTEXT";
  schemaVersion: typeof FULL_BACKUP_MANIFEST_SCHEMA_VERSION;
  complete: false;
  backupStatus: "INCOMPLETE_IMPLEMENTATION";
  businessValidationStatus: "NOT_ASSERTED";
  reportReconciliationStatus: "NOT_ASSERTED";
  backupId: null;
  exportJobId: null;
  scheduleId: null;
  scheduledWindowStart: null;
  requestedBy: null;
  requestedAt: null;
  authorizationScope: null;
  exportType: "IMPLEMENTATION_ARTIFACT";
  fileGroupId: string;
  generatedAt: string;
  applicationVersion: string;
  generatorVersion: string;
  timezone: "Asia/Shanghai";
  spoolId: string;
  snapshotId: string;
  asOf: string;
  rawTables: readonly Readonly<{
    tableName: string;
    rowCount: string;
    firstStableKey: Text;
    lastStableKey: Text;
    logicalDigest: string;
  }>[];
  secretExclusions: readonly Readonly<{
    tableName: string;
    fieldName: string;
    reason:
      | "AUTH_SECRET_TABLE_EXCLUDED"
      | "AUTH_SECRET_COLUMN_EXCLUDED";
  }>[];
  money: Readonly<{
    ledgerEntryCount: string;
    validEntryAmountCount: string;
    invalidEntryAmountCount: string;
    validEntryCentsSubtotal: string;
    exactLedgerEntryCents: Text;
    ledgerAnomalyCount: string;
    invalidMonthlyRowCount: string;
    reconciliation: Readonly<{
      accountCount: string;
      statusCounts: Readonly<Record<string, string>>;
      validLedgerCentsSubtotal: string;
      exactLedgerCents: Text;
      validProjectionCentsSubtotal: string;
      exactProjectionCents: Text;
    }>;
  }>;
  periods: Readonly<{
    eventCount: string;
    sourceLinkCount: string;
    anomalyCount: string;
    statusCounts: Readonly<Record<string, string>>;
  }>;
  coverageGaps: readonly string[];
}>;

export type FullBackupManifestContextInput = Readonly<{
  evidence: FullBackupManifestEvidenceResult;
  fileGroupId: string;
  generatedAt: string;
  applicationVersion: string;
  generatorVersion: string;
}>;

export type ManifestWorkbookRowsInput = Readonly<{
  context: FullBackupManifestContext;
  spoolId: string;
  snapshotId: string;
  asOf: string;
  file: string;
  workbookRole: ManifestWorkbookRole;
  tableNumbers: readonly number[];
  sheetParts: readonly ManifestSheetPart[];
}>;

export type ManifestRows = readonly (readonly [field: string, value: Text])[];

const SHA = /^[a-f0-9]{64}$/;
const COUNT = /^(0|[1-9]\d*)$/;
const INTEGER = /^-?(?:0|[1-9]\d*)$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const POSTGRES_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?[+-](?:0\d|1[0-4])(?::[0-5]\d)?$/;
const CALENDAR_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/;
const SHEET = /^(?!')[^:\\/?*\[\]]{1,31}(?<!')$/u;
const RECONCILIATION_STATUSES = [
  "MATCH",
  "MISMATCH",
  "MISSING_PROJECTION",
  "PROJECTION_INVALID",
  "LEDGER_TOTAL_INVALID",
  "ACCOUNT_UNRESOLVED",
] as const;
const PERIOD_STATUSES = [
  "UNIQUE_LOCKED_SETTLEMENT_MONTH",
  "MULTIPLE_BUSINESS_PERIODS",
  "UNRESOLVED",
  "UNIMPLEMENTED_EVENT_TYPE",
] as const;

const fail = (code: string): never => {
  throw new Error(code);
};

const own = (value: unknown, code: string): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail(code);

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) =>
    key === [...expected].sort()[index]);
};

const text = (value: unknown, code: string): string =>
  typeof value === "string" ? value : fail(code);

const nullableText = (value: unknown, code: string): Text =>
  value === null || typeof value === "string" ? value : fail(code);

const same = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const count = (value: unknown, code: string): string => {
  const result = text(value, code);
  return COUNT.test(result) ? result : fail(code);
};

const integer = (value: unknown, code: string): Text => {
  const result = nullableText(value, code);
  return result === null || INTEGER.test(result) ? result : fail(code);
};

const requiredInteger = (value: unknown, code: string): string => {
  const result = text(value, code);
  return INTEGER.test(result) ? result : fail(code);
};

const hasValidCalendarTime = (value: string): boolean => {
  const match = CALENDAR_TIMESTAMP.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year === 0 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59)
    return false;
  const daysInMonth = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1]!;
};

const isStrictIsoTimestamp = (value: string): boolean =>
  ISO_TIMESTAMP.test(value) && hasValidCalendarTime(value);

/** The source preserves `transaction_timestamp()::text` verbatim. */
const isStrictAsOfTimestamp = (value: string): boolean =>
  (ISO_TIMESTAMP.test(value) || POSTGRES_TIMESTAMP.test(value)) &&
  hasValidCalendarTime(value);

const exactCountRecord = (
  value: unknown,
  keys: readonly string[],
  code: string,
): Readonly<Record<string, string>> => {
  const record = own(value, code);
  if (!exactKeys(record, keys)) fail(code);
  const output: Record<string, string> = {};
  for (const key of keys) output[key] = count(record[key], code);
  return Object.freeze(output);
};

const rawLayout = () => createFullBackupLayout();

const rawFiles = (): readonly string[] =>
  Object.freeze(
    [...new Set(rawLayout()
      .filter((item) => item.policy === "RAW_SOURCE")
      .map((item) => item.workbookId))]
      .sort()
      .map((workbookId) => `workbook-${workbookId}.xlsx`),
  );

const FACT_FILES: Readonly<Record<string, number>> = Object.freeze({
  "business-table-1-teacher-facts.xlsx": 1,
  "business-table-2-student-facts.xlsx": 2,
  "business-table-4-finance-facts.xlsx": 4,
  "business-table-5-payroll-facts.xlsx": 5,
  "business-table-6-deduction-facts.xlsx": 6,
  "business-table-8-performance-configuration-facts.xlsx": 8,
});
const DERIVED_FILES: Readonly<Record<string, number>> = Object.freeze({
  "business-table-3-income-derived.xlsx": 3,
  "business-table-7-ledger-derived.xlsx": 7,
});

const expectedSecretExclusions = () =>
  rawLayout().flatMap((item) =>
    item.excludedColumns.map((fieldName) =>
      Object.freeze({
        tableName: item.tableName,
        fieldName,
        reason: item.policy === "AUTH_SECRET_TABLE_EXCLUDED"
          ? "AUTH_SECRET_TABLE_EXCLUDED" as const
          : "AUTH_SECRET_COLUMN_EXCLUDED" as const,
      }),
    ),
  );

const validateEvidence = (
  value: unknown,
): Omit<FullBackupManifestContext, keyof {
  mode: never;
  schemaVersion: never;
  complete: never;
  backupStatus: never;
  businessValidationStatus: never;
  reportReconciliationStatus: never;
  backupId: never;
  exportJobId: never;
  scheduleId: never;
  scheduledWindowStart: never;
  requestedBy: never;
  requestedAt: never;
  authorizationScope: never;
  exportType: never;
  fileGroupId: never;
  generatedAt: never;
  applicationVersion: never;
  generatorVersion: never;
  timezone: never;
}> => {
  const evidence = own(value, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID");
  if (!exactKeys(evidence, [
    "mode", "schemaVersion", "complete", "spoolId", "snapshotId", "asOf",
    "raw", "money", "periods", "integrity", "businessCorrectness", "coverageGaps",
  ]) || evidence.mode !== "FULL_BACKUP_MANIFEST_EVIDENCE" ||
    evidence.schemaVersion !== FULL_BACKUP_MANIFEST_EVIDENCE_SCHEMA_VERSION ||
    evidence.complete !== false || !same(
      Array.isArray(evidence.coverageGaps) ? evidence.coverageGaps as string[] : [],
      FULL_BACKUP_MANIFEST_EVIDENCE_COVERAGE_GAPS,
    ))
    fail("EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID");
  const spoolId = text(evidence.spoolId, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID");
  const snapshotId = text(evidence.snapshotId, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID");
  const asOf = text(evidence.asOf, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID");
  if (!ID.test(spoolId) || !ID.test(snapshotId) || !isStrictAsOfTimestamp(asOf))
    fail("EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID");

  const integrity = own(evidence.integrity, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID");
  const correctness = own(evidence.businessCorrectness, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID");
  if (!exactKeys(integrity, ["status", "scope", "completeBackup"]) ||
    integrity.status !== "VERIFIED_PARTIAL" ||
    integrity.scope !== "REGISTERED_RAW_AND_LEDGER_EVIDENCE_ONLY" ||
    integrity.completeBackup !== false ||
    !exactKeys(correctness, ["status", "scope"]) ||
    correctness.status !== "NOT_ASSERTED" ||
    correctness.scope !== "NO_COMPLETE_BUSINESS_CORRECTNESS_ASSERTION")
    fail("EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID");

  const raw = own(evidence.raw, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID");
  if (!exactKeys(raw, ["registeredDatasetCount", "nonSecretTables", "secretExclusions"]) ||
    count(raw.registeredDatasetCount, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID") !== String(rawLayout().length) ||
    !Array.isArray(raw.nonSecretTables) || !Array.isArray(raw.secretExclusions))
    fail("EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID");
  const nonSecretTables = raw.nonSecretTables as unknown[];
  const secretExclusions = raw.secretExclusions as unknown[];
  const expectedTables = rawLayout().filter((item) => item.policy === "RAW_SOURCE");
  if (nonSecretTables.length !== expectedTables.length) fail("EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID");
  const rawTables = nonSecretTables.map((candidate, index) => {
    const table = own(candidate, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID");
    const expected = expectedTables[index]!;
    if (!exactKeys(table, ["tableName", "rowCount", "firstStableKey", "lastStableKey", "logicalDigest"]) ||
      table.tableName !== expected.tableName || !SHA.test(text(table.logicalDigest, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID")))
      fail("EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID");
    return Object.freeze({
      tableName: expected.tableName,
      rowCount: count(table.rowCount, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID"),
      firstStableKey: nullableText(table.firstStableKey, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID"),
      lastStableKey: nullableText(table.lastStableKey, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID"),
      logicalDigest: text(table.logicalDigest, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID"),
    });
  });
  const exclusions = expectedSecretExclusions();
  if (secretExclusions.length !== exclusions.length) fail("EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID");
  for (const [index, candidate] of secretExclusions.entries()) {
    const exclusion = own(candidate, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID");
    const expected = exclusions[index]!;
    if (!exactKeys(exclusion, ["tableName", "fieldName", "reason"]) ||
      exclusion.tableName !== expected.tableName || exclusion.fieldName !== expected.fieldName ||
      exclusion.reason !== expected.reason)
      fail("EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID");
  }

  const money = own(evidence.money, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID");
  if (!exactKeys(money, [
    "ledgerEntryCount", "validEntryAmountCount", "invalidEntryAmountCount",
    "validEntryCentsSubtotal", "exactLedgerEntryCents", "ledgerAnomalyCount",
    "invalidMonthlyRowCount", "reconciliation",
  ])) fail("EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID");
  const reconciliation = own(money.reconciliation, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID");
  if (!exactKeys(reconciliation, [
    "accountCount", "statusCounts", "validLedgerCentsSubtotal", "exactLedgerCents",
    "validProjectionCentsSubtotal", "exactProjectionCents",
  ])) fail("EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID");
  const moneyProjection = Object.freeze({
    ledgerEntryCount: count(money.ledgerEntryCount, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID"),
    validEntryAmountCount: count(money.validEntryAmountCount, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID"),
    invalidEntryAmountCount: count(money.invalidEntryAmountCount, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID"),
    validEntryCentsSubtotal: requiredInteger(money.validEntryCentsSubtotal, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID"),
    exactLedgerEntryCents: integer(money.exactLedgerEntryCents, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID"),
    ledgerAnomalyCount: count(money.ledgerAnomalyCount, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID"),
    invalidMonthlyRowCount: count(money.invalidMonthlyRowCount, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID"),
    reconciliation: Object.freeze({
      accountCount: count(reconciliation.accountCount, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID"),
      statusCounts: exactCountRecord(reconciliation.statusCounts, RECONCILIATION_STATUSES, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID"),
      validLedgerCentsSubtotal: requiredInteger(reconciliation.validLedgerCentsSubtotal, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID"),
      exactLedgerCents: integer(reconciliation.exactLedgerCents, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID"),
      validProjectionCentsSubtotal: requiredInteger(reconciliation.validProjectionCentsSubtotal, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID"),
      exactProjectionCents: integer(reconciliation.exactProjectionCents, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID"),
    }),
  });

  const periods = own(evidence.periods, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID");
  if (!exactKeys(periods, ["eventCount", "sourceLinkCount", "anomalyCount", "statusCounts"]))
    fail("EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID");
  const periodProjection = Object.freeze({
    eventCount: count(periods.eventCount, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID"),
    sourceLinkCount: count(periods.sourceLinkCount, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID"),
    anomalyCount: count(periods.anomalyCount, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID"),
    statusCounts: exactCountRecord(periods.statusCounts, PERIOD_STATUSES, "EXPORT_MANIFEST_CONTEXT_EVIDENCE_INVALID"),
  });
  return Object.freeze({
    spoolId, snapshotId, asOf,
    rawTables: Object.freeze(rawTables),
    secretExclusions: Object.freeze(exclusions),
    money: moneyProjection,
    periods: periodProjection,
    coverageGaps: FULL_BACKUP_MANIFEST_EVIDENCE_COVERAGE_GAPS,
  });
};

/** Creates only a fixed, incomplete projection. It never creates task identity. */
export function createFullBackupManifestContext(
  input: FullBackupManifestContextInput,
): FullBackupManifestContext {
  const record = own(input, "EXPORT_MANIFEST_CONTEXT_INPUT_INVALID");
  if (!exactKeys(record, ["evidence", "fileGroupId", "generatedAt", "applicationVersion", "generatorVersion"]))
    fail("EXPORT_MANIFEST_CONTEXT_INPUT_INVALID");
  const fileGroupId = text(record.fileGroupId, "EXPORT_MANIFEST_CONTEXT_INPUT_INVALID");
  const generatedAt = text(record.generatedAt, "EXPORT_MANIFEST_CONTEXT_INPUT_INVALID");
  const applicationVersion = text(record.applicationVersion, "EXPORT_MANIFEST_CONTEXT_INPUT_INVALID");
  const generatorVersion = text(record.generatorVersion, "EXPORT_MANIFEST_CONTEXT_INPUT_INVALID");
  if (!ID.test(fileGroupId) || !isStrictIsoTimestamp(generatedAt) || !VERSION.test(applicationVersion) || !VERSION.test(generatorVersion))
    fail("EXPORT_MANIFEST_CONTEXT_INPUT_INVALID");
  const evidence = validateEvidence(record.evidence);
  return Object.freeze({
    mode: "FULL_BACKUP_MANIFEST_CONTEXT",
    schemaVersion: FULL_BACKUP_MANIFEST_SCHEMA_VERSION,
    complete: false,
    backupStatus: "INCOMPLETE_IMPLEMENTATION",
    businessValidationStatus: "NOT_ASSERTED",
    reportReconciliationStatus: "NOT_ASSERTED",
    backupId: null, exportJobId: null, scheduleId: null, scheduledWindowStart: null,
    requestedBy: null, requestedAt: null, authorizationScope: null,
    exportType: "IMPLEMENTATION_ARTIFACT",
    fileGroupId, generatedAt, applicationVersion, generatorVersion,
    timezone: "Asia/Shanghai",
    ...evidence,
  });
}

const expectedWorkbook = (
  file: string,
  role: ManifestWorkbookRole,
  tableNumbers: readonly number[],
): void => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.xlsx$/.test(file))
    fail("EXPORT_MANIFEST_WORKBOOK_FILE_INVALID");
  if (role === "RAW") {
    if (!rawFiles().includes(file) || tableNumbers.length !== 0)
      fail("EXPORT_MANIFEST_WORKBOOK_MAPPING_INVALID");
    return;
  }
  const mapping = role === "BUSINESS_FACT" ? FACT_FILES : DERIVED_FILES;
  const expected = mapping[file];
  if (expected === undefined || tableNumbers.length !== 1 || tableNumbers[0] !== expected)
    fail("EXPORT_MANIFEST_WORKBOOK_MAPPING_INVALID");
};

const validateContextForRows = (value: unknown): FullBackupManifestContext => {
  const context = own(value, "EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID");
  if (!exactKeys(context, [
    "mode", "schemaVersion", "complete", "backupStatus", "businessValidationStatus",
    "reportReconciliationStatus", "backupId", "exportJobId", "scheduleId",
    "scheduledWindowStart", "requestedBy", "requestedAt", "authorizationScope",
    "exportType", "fileGroupId", "generatedAt", "applicationVersion",
    "generatorVersion", "timezone", "spoolId", "snapshotId", "asOf", "rawTables",
    "secretExclusions", "money", "periods", "coverageGaps",
  ]) || context.mode !== "FULL_BACKUP_MANIFEST_CONTEXT" ||
    context.schemaVersion !== FULL_BACKUP_MANIFEST_SCHEMA_VERSION ||
    context.complete !== false || context.backupStatus !== "INCOMPLETE_IMPLEMENTATION" ||
    context.businessValidationStatus !== "NOT_ASSERTED" ||
    context.reportReconciliationStatus !== "NOT_ASSERTED" ||
    context.backupId !== null || context.exportJobId !== null || context.scheduleId !== null ||
    context.scheduledWindowStart !== null || context.requestedBy !== null ||
    context.requestedAt !== null || context.authorizationScope !== null ||
    context.exportType !== "IMPLEMENTATION_ARTIFACT" || context.timezone !== "Asia/Shanghai" ||
    !Array.isArray(context.coverageGaps) || !same(context.coverageGaps as string[], FULL_BACKUP_MANIFEST_EVIDENCE_COVERAGE_GAPS))
    fail("EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID");
  for (const identifier of ["fileGroupId", "spoolId", "snapshotId"] as const) {
    if (!ID.test(text(context[identifier], "EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID")))
      fail("EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID");
  }
  const rawTables = context.rawTables;
  const secretExclusions = context.secretExclusions;
  if (!isStrictIsoTimestamp(text(context.generatedAt, "EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID")) ||
    !isStrictAsOfTimestamp(text(context.asOf, "EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID")) ||
    !VERSION.test(text(context.applicationVersion, "EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID")) ||
    !VERSION.test(text(context.generatorVersion, "EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID")) ||
    !Array.isArray(rawTables) || !Array.isArray(secretExclusions))
    fail("EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID");
  const validatedRawTables = rawTables as unknown[];
  const validatedSecretExclusions = secretExclusions as unknown[];
  const expectedTables = rawLayout().filter((item) => item.policy === "RAW_SOURCE");
  if (validatedRawTables.length !== expectedTables.length) fail("EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID");
  for (const [index, candidate] of validatedRawTables.entries()) {
    const table = own(candidate, "EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID");
    if (!exactKeys(table, ["tableName", "rowCount", "firstStableKey", "lastStableKey", "logicalDigest"]) ||
      table.tableName !== expectedTables[index]!.tableName ||
      !COUNT.test(text(table.rowCount, "EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID")) ||
      !SHA.test(text(table.logicalDigest, "EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID")) ||
      nullableText(table.firstStableKey, "EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID") === undefined ||
      nullableText(table.lastStableKey, "EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID") === undefined)
      fail("EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID");
  }
  const exclusions = expectedSecretExclusions();
  if (validatedSecretExclusions.length !== exclusions.length) fail("EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID");
  for (const [index, candidate] of validatedSecretExclusions.entries()) {
    const exclusion = own(candidate, "EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID");
    const expected = exclusions[index]!;
    if (!exactKeys(exclusion, ["tableName", "fieldName", "reason"]) ||
      exclusion.tableName !== expected.tableName || exclusion.fieldName !== expected.fieldName ||
      exclusion.reason !== expected.reason)
      fail("EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID");
  }
  const money = own(context.money, "EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID");
  const periods = own(context.periods, "EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID");
  if (!exactKeys(money, [
    "ledgerEntryCount", "validEntryAmountCount", "invalidEntryAmountCount",
    "validEntryCentsSubtotal", "exactLedgerEntryCents", "ledgerAnomalyCount",
    "invalidMonthlyRowCount", "reconciliation",
  ]) || !exactKeys(periods, ["eventCount", "sourceLinkCount", "anomalyCount", "statusCounts"]))
    fail("EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID");
  for (const field of ["ledgerEntryCount", "validEntryAmountCount", "invalidEntryAmountCount", "ledgerAnomalyCount", "invalidMonthlyRowCount"])
    count(money[field], "EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID");
  requiredInteger(money.validEntryCentsSubtotal, "EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID");
  integer(money.exactLedgerEntryCents, "EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID");
  const reconciliation = own(money.reconciliation, "EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID");
  if (!exactKeys(reconciliation, [
    "accountCount", "statusCounts", "validLedgerCentsSubtotal", "exactLedgerCents",
    "validProjectionCentsSubtotal", "exactProjectionCents",
  ])) fail("EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID");
  count(reconciliation.accountCount, "EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID");
  exactCountRecord(reconciliation.statusCounts, RECONCILIATION_STATUSES, "EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID");
  requiredInteger(reconciliation.validLedgerCentsSubtotal, "EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID");
  integer(reconciliation.exactLedgerCents, "EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID");
  requiredInteger(reconciliation.validProjectionCentsSubtotal, "EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID");
  integer(reconciliation.exactProjectionCents, "EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID");
  for (const field of ["eventCount", "sourceLinkCount", "anomalyCount"])
    count(periods[field], "EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID");
  exactCountRecord(periods.statusCounts, PERIOD_STATUSES, "EXPORT_MANIFEST_WORKBOOK_CONTEXT_INVALID");
  return context as FullBackupManifestContext;
};

const validateSheetParts = (
  value: readonly ManifestSheetPart[],
  context: FullBackupManifestContext,
): readonly ManifestSheetPart[] => {
  if (!Array.isArray(value)) fail("EXPORT_MANIFEST_WORKBOOK_PARTS_INVALID");
  const seen = new Set<string>();
  const rawByName = new Map(context.rawTables.map((table) => [table.tableName, table]));
  return Object.freeze(value.map((candidate) => {
    const part = own(candidate, "EXPORT_MANIFEST_WORKBOOK_PARTS_INVALID");
    if (!exactKeys(part, [
      "sheetId", "logicalName", "partNo", "rowCount", "sourceTable",
      "sourceLogicalDigest", "pageLogicalDigest", "summaryScope",
    ]) || part.pageLogicalDigest !== null || part.summaryScope !== "SOURCE_TABLE_DIGEST_ONLY")
      fail("EXPORT_MANIFEST_WORKBOOK_PARTS_INVALID");
    const sheetId = text(part.sheetId, "EXPORT_MANIFEST_WORKBOOK_PARTS_INVALID");
    const logicalName = text(part.logicalName, "EXPORT_MANIFEST_WORKBOOK_PARTS_INVALID");
    const partNo = count(part.partNo, "EXPORT_MANIFEST_WORKBOOK_PARTS_INVALID");
    const rowCount = count(part.rowCount, "EXPORT_MANIFEST_WORKBOOK_PARTS_INVALID");
    const sourceTable = nullableText(part.sourceTable, "EXPORT_MANIFEST_WORKBOOK_PARTS_INVALID");
    const sourceLogicalDigest = nullableText(part.sourceLogicalDigest, "EXPORT_MANIFEST_WORKBOOK_PARTS_INVALID");
    if (!SHEET.test(sheetId) || sheetId === "00_manifest" || /^1[45]_/.test(sheetId) ||
      logicalName.length === 0 || partNo === "0" ||
      seen.has(sheetId.toLocaleLowerCase("en-US")))
      fail("EXPORT_MANIFEST_WORKBOOK_PARTS_INVALID");
    seen.add(sheetId.toLocaleLowerCase("en-US"));
    if (sourceTable === null) {
      if (sourceLogicalDigest !== null) fail("EXPORT_MANIFEST_WORKBOOK_PARTS_INVALID");
    } else {
      const source = rawByName.get(sourceTable);
      if (source === undefined || sourceLogicalDigest !== source.logicalDigest)
        fail("EXPORT_MANIFEST_WORKBOOK_PARTS_INVALID");
    }
    return Object.freeze({
      sheetId, logicalName, partNo, rowCount, sourceTable, sourceLogicalDigest,
      pageLogicalDigest: null,
      summaryScope: "SOURCE_TABLE_DIGEST_ONLY" as const,
    });
  }));
};

const add = (rows: Array<readonly [string, Text]>, field: string, value: Text): void => {
  rows.push(Object.freeze([field, value]));
};

/**
 * Produces text/null cells only. The caller must feed these through its own
 * long-text and NULL-coordinate spool before passing them to writeXlsx.
 */
export function createManifestWorkbookRows(
  input: ManifestWorkbookRowsInput,
): ManifestRows {
  const record = own(input, "EXPORT_MANIFEST_WORKBOOK_INPUT_INVALID");
  if (!exactKeys(record, [
    "context", "spoolId", "snapshotId", "asOf", "file", "workbookRole",
    "tableNumbers", "sheetParts",
  ])) fail("EXPORT_MANIFEST_WORKBOOK_INPUT_INVALID");
  const context = validateContextForRows(record.context);
  const spoolId = text(record.spoolId, "EXPORT_MANIFEST_WORKBOOK_INPUT_INVALID");
  const snapshotId = text(record.snapshotId, "EXPORT_MANIFEST_WORKBOOK_INPUT_INVALID");
  const asOf = text(record.asOf, "EXPORT_MANIFEST_WORKBOOK_INPUT_INVALID");
  const file = text(record.file, "EXPORT_MANIFEST_WORKBOOK_INPUT_INVALID");
  const workbookRole = text(record.workbookRole, "EXPORT_MANIFEST_WORKBOOK_INPUT_INVALID") as ManifestWorkbookRole;
  if ((workbookRole !== "RAW" && workbookRole !== "BUSINESS_FACT" && workbookRole !== "BUSINESS_DERIVED") ||
    !Array.isArray(record.tableNumbers) || spoolId !== context.spoolId ||
    snapshotId !== context.snapshotId || asOf !== context.asOf)
    fail("EXPORT_MANIFEST_WORKBOOK_INPUT_INVALID");
  const tableNumbers: number[] = [];
  for (const value of record.tableNumbers as unknown[]) {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
      fail("EXPORT_MANIFEST_WORKBOOK_MAPPING_INVALID");
    tableNumbers.push(value as number);
  }
  expectedWorkbook(file, workbookRole, tableNumbers);
  const sheetParts = validateSheetParts(record.sheetParts as readonly ManifestSheetPart[], context);
  const rows: Array<readonly [string, Text]> = [];
  add(rows, "manifest_schema_version", FULL_BACKUP_MANIFEST_SCHEMA_VERSION);
  add(rows, "evidence_schema_version", FULL_BACKUP_MANIFEST_EVIDENCE_SCHEMA_VERSION);
  add(rows, "complete", "false");
  add(rows, "backup_status", "INCOMPLETE_IMPLEMENTATION");
  add(rows, "business_validation_status", "NOT_ASSERTED");
  add(rows, "report_reconciliation_status", "NOT_ASSERTED");
  add(rows, "backup_id", null); add(rows, "export_job_id", null);
  add(rows, "schedule_id", null); add(rows, "scheduled_window_start", null);
  add(rows, "requested_by", null); add(rows, "requested_at", null);
  add(rows, "authorization_scope", null);
  add(rows, "export_type", "IMPLEMENTATION_ARTIFACT");
  add(rows, "file_group_id", context.fileGroupId);
  add(rows, "generated_at", context.generatedAt);
  add(rows, "application_version", context.applicationVersion);
  add(rows, "generator_version", context.generatorVersion);
  add(rows, "timezone", context.timezone);
  add(rows, "spool_id", context.spoolId);
  add(rows, "snapshot_id", context.snapshotId);
  add(rows, "as_of", context.asOf);
  add(rows, "filters", "FULL_EXPORT_NO_BUSINESS_FILTERS");
  add(rows, "text_encoding", "xlsx_string_v1");
  add(rows, "package_manifest_ref", "package-manifest.json");
  add(rows, "workbook_file", file);
  add(rows, "workbook_role", workbookRole);
  add(rows, "covered_table_numbers", tableNumbers.join(","));
  add(rows, "registered_dataset_count", String(rawLayout().length));
  for (const table of context.rawTables) {
    add(rows, `raw.${table.tableName}.row_count`, table.rowCount);
    add(rows, `raw.${table.tableName}.first_stable_key`, table.firstStableKey);
    add(rows, `raw.${table.tableName}.last_stable_key`, table.lastStableKey);
    add(rows, `raw.${table.tableName}.logical_digest`, table.logicalDigest);
  }
  for (const secret of context.secretExclusions)
    add(rows, `secret_exclusion.${secret.tableName}.${secret.fieldName}`, secret.reason);
  add(rows, "money.ledger_entry_count", context.money.ledgerEntryCount);
  add(rows, "money.valid_entry_amount_count", context.money.validEntryAmountCount);
  add(rows, "money.invalid_entry_amount_count", context.money.invalidEntryAmountCount);
  add(rows, "money.valid_entry_cents_subtotal", context.money.validEntryCentsSubtotal);
  add(rows, "money.exact_ledger_entry_cents", context.money.exactLedgerEntryCents);
  add(rows, "money.ledger_anomaly_count", context.money.ledgerAnomalyCount);
  add(rows, "money.invalid_monthly_row_count", context.money.invalidMonthlyRowCount);
  add(rows, "money.reconciliation.account_count", context.money.reconciliation.accountCount);
  for (const status of RECONCILIATION_STATUSES)
    add(rows, `money.reconciliation.${status}`, context.money.reconciliation.statusCounts[status]!);
  add(rows, "money.reconciliation.valid_ledger_cents_subtotal", context.money.reconciliation.validLedgerCentsSubtotal);
  add(rows, "money.reconciliation.exact_ledger_cents", context.money.reconciliation.exactLedgerCents);
  add(rows, "money.reconciliation.valid_projection_cents_subtotal", context.money.reconciliation.validProjectionCentsSubtotal);
  add(rows, "money.reconciliation.exact_projection_cents", context.money.reconciliation.exactProjectionCents);
  add(rows, "period.event_count", context.periods.eventCount);
  add(rows, "period.source_link_count", context.periods.sourceLinkCount);
  add(rows, "period.anomaly_count", context.periods.anomalyCount);
  for (const status of PERIOD_STATUSES)
    add(rows, `period.${status}`, context.periods.statusCounts[status]!);
  for (const gap of context.coverageGaps) add(rows, "coverage_gap", gap);
  for (const part of sheetParts) {
    add(rows, `sheet.${part.sheetId}.logical_name`, part.logicalName);
    add(rows, `sheet.${part.sheetId}.part_no`, part.partNo);
    add(rows, `sheet.${part.sheetId}.row_count`, part.rowCount);
    add(rows, `sheet.${part.sheetId}.source_table`, part.sourceTable);
    add(rows, `sheet.${part.sheetId}.source_logical_digest`, part.sourceLogicalDigest);
    add(rows, `sheet.${part.sheetId}.page_logical_digest`, null);
    add(rows, `sheet.${part.sheetId}.summary_scope`, "SOURCE_TABLE_DIGEST_ONLY");
  }
  return Object.freeze(rows);
}
