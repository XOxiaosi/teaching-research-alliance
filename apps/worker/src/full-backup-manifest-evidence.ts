import { EXPORT_SCHEMA_REGISTRY } from "./export-schema-registry.js";
import {
  FullBackupDerivedSpoolIndex,
  type DerivedSpoolIndexRow,
} from "./full-backup-derived-spool-index.js";
import {
  FullBackupLedgerDerivedView,
  LEDGER_DERIVED_VIEW_COVERAGE_GAPS,
} from "./full-backup-ledger-derived-view.js";
import {
  FullBackupLedgerBusinessPeriodSource,
  type LedgerBusinessPeriodStatus,
} from "./full-backup-ledger-business-period-source.js";
import { LEDGER_WORKBOOK_FIXED_GAPS } from "./full-backup-ledger-workbook.js";
import {
  FULL_BACKUP_KNOWN_COVERAGE_GAPS,
  createFullBackupLayout,
  type FullBackupLayoutItem,
} from "./full-backup-layout.js";
import { readBackupSpoolDataset } from "./full-backup-spool-reader.js";
import type { FullBackupSpoolDataset, FullBackupSpoolResult } from "./full-backup-spool.js";
import { fullBackupOutputColumns } from "./full-backup-transformer.js";

type Text = string | null;
type IntegerText = string;

export const FULL_BACKUP_MANIFEST_EVIDENCE_SCHEMA_VERSION =
  "full-backup-manifest-evidence.v1";

/**
 * These are implementation coverage limits, reconstructed from exported
 * constants rather than a producer receipt. They make this evidence useful to
 * a future manifest without allowing it to claim a complete F14 backup.
 */
export const FULL_BACKUP_MANIFEST_EVIDENCE_COVERAGE_GAPS = Object.freeze([
  ...FULL_BACKUP_KNOWN_COVERAGE_GAPS,
  ...LEDGER_DERIVED_VIEW_COVERAGE_GAPS,
  ...LEDGER_WORKBOOK_FIXED_GAPS,
] as const);

export type ManifestEvidenceSecretExclusion = Readonly<{
  tableName: string;
  fieldName: string;
  reason:
    | "AUTH_SECRET_TABLE_EXCLUDED"
    | "AUTH_SECRET_COLUMN_EXCLUDED";
}>;

export type ManifestEvidenceRawTable = Readonly<{
  tableName: string;
  rowCount: IntegerText;
  firstStableKey: string | null;
  lastStableKey: string | null;
  logicalDigest: string;
}>;

export type ManifestEvidenceMoney = Readonly<{
  ledgerEntryCount: IntegerText;
  validEntryAmountCount: IntegerText;
  invalidEntryAmountCount: IntegerText;
  /** Sum of only syntactically valid source amounts; never a substitute total. */
  validEntryCentsSubtotal: IntegerText;
  /** Null if any ledger entry amount is invalid. */
  exactLedgerEntryCents: IntegerText | null;
  ledgerAnomalyCount: IntegerText;
  invalidMonthlyRowCount: IntegerText;
  reconciliation: Readonly<{
    accountCount: IntegerText;
    statusCounts: Readonly<Record<
      | "MATCH"
      | "MISMATCH"
      | "MISSING_PROJECTION"
      | "PROJECTION_INVALID"
      | "LEDGER_TOTAL_INVALID"
      | "ACCOUNT_UNRESOLVED",
      IntegerText
    >>;
    /** Sum only reconciliation rows that retain exact ledger totals. */
    validLedgerCentsSubtotal: IntegerText;
    /** Null if any account lacks a valid exact ledger total. */
    exactLedgerCents: IntegerText | null;
    /** Sum only reconciliation rows that retain exact projection balances. */
    validProjectionCentsSubtotal: IntegerText;
    /** Null if any account lacks a valid exact projection balance. */
    exactProjectionCents: IntegerText | null;
  }>;
}>;

export type ManifestEvidencePeriods = Readonly<{
  eventCount: IntegerText;
  sourceLinkCount: IntegerText;
  anomalyCount: IntegerText;
  statusCounts: Readonly<Record<LedgerBusinessPeriodStatus, IntegerText>>;
}>;

export type FullBackupManifestEvidenceResult = Readonly<{
  mode: "FULL_BACKUP_MANIFEST_EVIDENCE";
  schemaVersion: typeof FULL_BACKUP_MANIFEST_EVIDENCE_SCHEMA_VERSION;
  complete: false;
  spoolId: string;
  snapshotId: string;
  asOf: string;
  raw: Readonly<{
    registeredDatasetCount: IntegerText;
    nonSecretTables: readonly ManifestEvidenceRawTable[];
    secretExclusions: readonly ManifestEvidenceSecretExclusion[];
  }>;
  money: ManifestEvidenceMoney;
  periods: ManifestEvidencePeriods;
  integrity: Readonly<{
    status: "VERIFIED_PARTIAL";
    /** Passing means only registered RAW and bounded ledger evidence matched. */
    scope: "REGISTERED_RAW_AND_LEDGER_EVIDENCE_ONLY";
    completeBackup: false;
  }>;
  businessCorrectness: Readonly<{
    status: "NOT_ASSERTED";
    /** Reconciliation values are preserved as evidence, not a business approval. */
    scope: "NO_COMPLETE_BUSINESS_CORRECTNESS_ASSERTION";
  }>;
  coverageGaps: readonly string[];
}>;

export type FullBackupManifestEvidenceOptions = Readonly<{
  spoolDirectory: string;
  spool: FullBackupSpoolResult;
  /** Caller-owned index; collecting evidence does not close it. */
  index: FullBackupDerivedSpoolIndex;
  /** Caller-owned ledger view; collecting evidence does not close it. */
  ledger: FullBackupLedgerDerivedView;
  /** Caller-owned period view; collecting evidence does not close it. */
  periods: FullBackupLedgerBusinessPeriodSource;
}>;

const SHA256 = /^[a-f0-9]{64}$/;
const INTEGER = /^-?(?:0|[1-9]\d*)$/;
const COUNT = /^(0|[1-9]\d*)$/;
const PERIOD_STATUSES = [
  "UNIQUE_LOCKED_SETTLEMENT_MONTH",
  "MULTIPLE_BUSINESS_PERIODS",
  "UNRESOLVED",
  "UNIMPLEMENTED_EVENT_TYPE",
] as const;
const RECONCILIATION_STATUSES = [
  "MATCH",
  "MISMATCH",
  "MISSING_PROJECTION",
  "PROJECTION_INVALID",
  "LEDGER_TOTAL_INVALID",
  "ACCOUNT_UNRESOLVED",
] as const;

const fail = (code: string): never => {
  throw new Error(code);
};

const same = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const exactInteger = (value: Text): value is string =>
  value !== null && INTEGER.test(value);

const stableKey = (
  item: FullBackupLayoutItem,
  dataset: FullBackupSpoolDataset,
  values: readonly Text[],
): string => {
  const table = EXPORT_SCHEMA_REGISTRY.find((candidate) =>
    candidate.name === item.tableName,
  );
  if (table === undefined || values.length !== dataset.columns.length)
    return fail("EXPORT_MANIFEST_EVIDENCE_RAW_SCHEMA_INVALID");
  const pairs = table.orderBy.map((column) => {
    const outputColumn = dataset.columns.includes(column)
      ? column
      : dataset.columns.includes(`${column}_fingerprint`)
        ? `${column}_fingerprint`
        : fail("EXPORT_MANIFEST_EVIDENCE_RAW_SCHEMA_INVALID");
    const index = dataset.columns.indexOf(outputColumn);
    const value = values[index];
    if (value === undefined || value === null)
      return fail("EXPORT_MANIFEST_EVIDENCE_STABLE_KEY_INVALID");
    return [outputColumn, value] as const;
  });
  return JSON.stringify(pairs);
};

const assertSameSnapshot = (
  metadata: { spoolId: string; snapshotId: string; asOf: string },
  spool: FullBackupSpoolResult,
): void => {
  if (
    metadata.spoolId !== spool.spoolId ||
    metadata.snapshotId !== spool.snapshotId ||
    metadata.asOf !== spool.asOf
  )
    fail("EXPORT_MANIFEST_EVIDENCE_SNAPSHOT_MISMATCH");
};

const frozenCounts = <T extends string>(keys: readonly T[]): Record<T, bigint> =>
  Object.fromEntries(keys.map((key) => [key, 0n])) as Record<T, bigint>;

const textCounts = <T extends string>(
  counts: Readonly<Record<T, bigint>>,
): Readonly<Record<T, string>> => {
  const output = {} as Record<T, string>;
  for (const key of Object.keys(counts) as T[]) output[key] = counts[key].toString();
  return Object.freeze(output);
};

const requireLedgerMetadata = (
  options: FullBackupManifestEvidenceOptions,
): void => {
  const index = options.index.metadata();
  const ledger = options.ledger.metadata();
  const periods = options.periods.metadata();
  if (
    index.mode !== "DERIVED_SPOOL_INDEX" ||
    index.complete !== false ||
    ledger.mode !== "DERIVED_POSTED_LEDGER_VIEW" ||
    ledger.complete !== false ||
    periods.mode !== "LEDGER_BUSINESS_PERIOD_SOURCE" ||
    periods.complete !== false ||
    !same(ledger.coverageGaps, LEDGER_DERIVED_VIEW_COVERAGE_GAPS) ||
    ledger.sourceValidation !== "LEDGER_EVENT_AND_ACCOUNT_REFERENCE_ONLY"
  )
    fail("EXPORT_MANIFEST_EVIDENCE_DERIVED_METADATA_INVALID");
  for (const metadata of [index, ledger, periods])
    assertSameSnapshot(metadata, options.spool);
};

const validateSpoolMetadata = (
  spool: FullBackupSpoolResult,
): readonly FullBackupLayoutItem[] => {
  const layout = createFullBackupLayout();
  if (
    spool.mode !== "RAW_SOURCE_SPOOL" ||
    spool.datasets.length !== layout.length ||
    !same(spool.coverageGaps, FULL_BACKUP_KNOWN_COVERAGE_GAPS)
  )
    fail("EXPORT_MANIFEST_EVIDENCE_SPOOL_LAYOUT_INVALID");
  for (const [index, item] of layout.entries()) {
    const dataset = spool.datasets[index];
    const wholeSecret = item.policy === "AUTH_SECRET_TABLE_EXCLUDED";
    const expectedColumns = wholeSecret
      ? []
      : fullBackupOutputColumns(item.tableName);
    const expectedFile = wholeSecret
      ? null
      : `datasets/${String(index + 1).padStart(3, "0")}_${item.tableName}.ndjson`;
    if (
      dataset === undefined ||
      dataset.tableName !== item.tableName ||
      dataset.excluded !== wholeSecret ||
      !same(dataset.columns, expectedColumns) ||
      dataset.spoolFile !== expectedFile ||
      (wholeSecret
        ? dataset.rowCount !== null || dataset.logicalDigest !== null
        : dataset.rowCount === null ||
          !COUNT.test(dataset.rowCount) ||
          dataset.logicalDigest === null ||
          !SHA256.test(dataset.logicalDigest))
    )
      fail("EXPORT_MANIFEST_EVIDENCE_SPOOL_LAYOUT_INVALID");
  }
  return layout;
};

const collectRawEvidence = async (
  options: FullBackupManifestEvidenceOptions,
  layout: readonly FullBackupLayoutItem[],
): Promise<FullBackupManifestEvidenceResult["raw"]> => {
  const sourceMetadata = options.index.metadata().sources;
  const sourceCounts = new Map<string, string>();
  for (const source of sourceMetadata) {
    if (
      typeof source.tableName !== "string" ||
      !COUNT.test(source.rowCount) ||
      sourceCounts.has(source.tableName)
    )
      fail("EXPORT_MANIFEST_EVIDENCE_INDEX_SOURCES_INVALID");
    sourceCounts.set(source.tableName, source.rowCount);
  }
  const nonSecretTables: ManifestEvidenceRawTable[] = [];
  const secretExclusions: ManifestEvidenceSecretExclusion[] = [];
  for (const [position, item] of layout.entries()) {
    const dataset = options.spool.datasets[position] ?? fail("EXPORT_MANIFEST_EVIDENCE_SPOOL_LAYOUT_INVALID");
    const wholeSecret = item.policy === "AUTH_SECRET_TABLE_EXCLUDED";
    for (const fieldName of item.excludedColumns) {
      secretExclusions.push(
        Object.freeze({
          tableName: item.tableName,
          fieldName,
          reason: wholeSecret
            ? "AUTH_SECRET_TABLE_EXCLUDED"
            : "AUTH_SECRET_COLUMN_EXCLUDED",
        }),
      );
    }
    if (wholeSecret) continue;
    const rowCount = dataset.rowCount;
    const logicalDigest = dataset.logicalDigest;
    if (
      rowCount === null ||
      logicalDigest === null ||
      sourceCounts.get(item.tableName) !== rowCount
    )
      fail("EXPORT_MANIFEST_EVIDENCE_INDEX_SOURCES_INVALID");
    const verifiedRowCount = rowCount as string;
    const verifiedLogicalDigest = logicalDigest as string;
    let count = 0n;
    let firstStableKey: string | null = null;
    let lastStableKey: string | null = null;
    const indexed = options.index.stream(item.tableName)[Symbol.asyncIterator]();
    try {
      for await (const values of readBackupSpoolDataset(
        options.spoolDirectory,
        dataset,
      )) {
        count += 1n;
        const next = await indexed.next();
        if (next.done) fail("EXPORT_MANIFEST_EVIDENCE_INDEX_LOCKSTEP_INVALID");
        const row: DerivedSpoolIndexRow = next.value;
        const key = stableKey(item, dataset, values);
        if (
          row.tableName !== item.tableName ||
          row.ordinal !== count.toString() ||
          row.sourceRecordKey !== key ||
          JSON.stringify(row.values) !== JSON.stringify(values)
        )
          fail("EXPORT_MANIFEST_EVIDENCE_INDEX_LOCKSTEP_INVALID");
        if (firstStableKey === null) firstStableKey = key;
        lastStableKey = key;
      }
      if (!(await indexed.next()).done)
        fail("EXPORT_MANIFEST_EVIDENCE_INDEX_LOCKSTEP_INVALID");
    } finally {
      await indexed.return?.(undefined as never);
    }
    if (count.toString() !== verifiedRowCount)
      fail("EXPORT_MANIFEST_EVIDENCE_COUNT_INVALID");
    nonSecretTables.push(
      Object.freeze({
        tableName: item.tableName,
        rowCount: verifiedRowCount,
        firstStableKey,
        lastStableKey,
        logicalDigest: verifiedLogicalDigest,
      }),
    );
  }
  if (sourceCounts.size !== nonSecretTables.length)
    fail("EXPORT_MANIFEST_EVIDENCE_INDEX_SOURCES_INVALID");
  return Object.freeze({
    registeredDatasetCount: String(layout.length),
    nonSecretTables: Object.freeze(nonSecretTables),
    secretExclusions: Object.freeze(secretExclusions),
  });
};

const sumExact = (
  subtotal: bigint,
  allExact: boolean,
  value: Text,
): Readonly<{ subtotal: bigint; allExact: boolean }> =>
  exactInteger(value)
    ? Object.freeze({ subtotal: subtotal + BigInt(value), allExact })
    : Object.freeze({ subtotal, allExact: false });

const collectMoneyEvidence = async (
  ledger: FullBackupLedgerDerivedView,
  raw: FullBackupManifestEvidenceResult["raw"],
): Promise<ManifestEvidenceMoney> => {
  let ledgerEntryCount = 0n;
  let validEntryAmountCount = 0n;
  let invalidEntryAmountCount = 0n;
  let validEntryCentsSubtotal = 0n;
  let allEntriesExact = true;
  for await (const entry of ledger.streamEntries()) {
    ledgerEntryCount += 1n;
    if (exactInteger(entry.amountCents)) {
      validEntryAmountCount += 1n;
      validEntryCentsSubtotal += BigInt(entry.amountCents);
    } else {
      invalidEntryAmountCount += 1n;
      allEntriesExact = false;
    }
  }
  const rawEntryCount = raw.nonSecretTables.find(
    (table) => table.tableName === "ledger_entry",
  )?.rowCount;
  if (rawEntryCount === undefined || ledgerEntryCount.toString() !== rawEntryCount)
    fail("EXPORT_MANIFEST_EVIDENCE_LEDGER_LOCKSTEP_INVALID");

  let invalidMonthlyRowCount = 0n;
  for await (const row of ledger.streamMonthlyRows()) {
    if (row.status === "AMOUNT_INVALID") invalidMonthlyRowCount += 1n;
  }
  const metadata = ledger.metadata();
  if (metadata.invalidMonthlyRowCount !== invalidMonthlyRowCount.toString())
    fail("EXPORT_MANIFEST_EVIDENCE_LEDGER_METADATA_INVALID");

  let ledgerAnomalyCount = 0n;
  for await (const _anomaly of ledger.streamAnomalies()) ledgerAnomalyCount += 1n;
  if (metadata.anomalyCount !== ledgerAnomalyCount.toString())
    fail("EXPORT_MANIFEST_EVIDENCE_LEDGER_METADATA_INVALID");

  const statusCounts = frozenCounts(RECONCILIATION_STATUSES);
  let accountCount = 0n;
  let validLedgerCentsSubtotal = 0n;
  let validProjectionCentsSubtotal = 0n;
  let allLedgerExact = true;
  let allProjectionExact = true;
  for await (const row of ledger.streamReconciliations()) {
    if (!Object.hasOwn(statusCounts, row.status))
      fail("EXPORT_MANIFEST_EVIDENCE_RECONCILIATION_INVALID");
    statusCounts[row.status] += 1n;
    accountCount += 1n;
    const ledgerTotal = sumExact(
      validLedgerCentsSubtotal,
      allLedgerExact,
      row.ledgerNetCents,
    );
    validLedgerCentsSubtotal = ledgerTotal.subtotal;
    allLedgerExact = ledgerTotal.allExact;
    const projectionTotal = sumExact(
      validProjectionCentsSubtotal,
      allProjectionExact,
      row.projectionBalanceCents,
    );
    validProjectionCentsSubtotal = projectionTotal.subtotal;
    allProjectionExact = projectionTotal.allExact;
  }
  return Object.freeze({
    ledgerEntryCount: ledgerEntryCount.toString(),
    validEntryAmountCount: validEntryAmountCount.toString(),
    invalidEntryAmountCount: invalidEntryAmountCount.toString(),
    validEntryCentsSubtotal: validEntryCentsSubtotal.toString(),
    exactLedgerEntryCents: allEntriesExact
      ? validEntryCentsSubtotal.toString()
      : null,
    ledgerAnomalyCount: ledgerAnomalyCount.toString(),
    invalidMonthlyRowCount: invalidMonthlyRowCount.toString(),
    reconciliation: Object.freeze({
      accountCount: accountCount.toString(),
      statusCounts: textCounts(statusCounts),
      validLedgerCentsSubtotal: validLedgerCentsSubtotal.toString(),
      exactLedgerCents: allLedgerExact
        ? validLedgerCentsSubtotal.toString()
        : null,
      validProjectionCentsSubtotal: validProjectionCentsSubtotal.toString(),
      exactProjectionCents: allProjectionExact
        ? validProjectionCentsSubtotal.toString()
        : null,
    }),
  });
};

const collectPeriodEvidence = async (
  periods: FullBackupLedgerBusinessPeriodSource,
  raw: FullBackupManifestEvidenceResult["raw"],
): Promise<ManifestEvidencePeriods> => {
  const statusCounts = frozenCounts(PERIOD_STATUSES);
  let eventCount = 0n;
  let expectedLinks = 0n;
  for await (const row of periods.streamEventPeriods()) {
    if (!Object.hasOwn(statusCounts, row.status) || !COUNT.test(row.sourceLinkCount))
      fail("EXPORT_MANIFEST_EVIDENCE_PERIOD_INVALID");
    statusCounts[row.status] += 1n;
    eventCount += 1n;
    expectedLinks += BigInt(row.sourceLinkCount);
  }
  const rawEventCount = raw.nonSecretTables.find(
    (table) => table.tableName === "ledger_event",
  )?.rowCount;
  if (rawEventCount === undefined || eventCount.toString() !== rawEventCount)
    fail("EXPORT_MANIFEST_EVIDENCE_PERIOD_LOCKSTEP_INVALID");
  let sourceLinkCount = 0n;
  for await (const _link of periods.streamSourceLinks()) sourceLinkCount += 1n;
  if (sourceLinkCount !== expectedLinks)
    fail("EXPORT_MANIFEST_EVIDENCE_PERIOD_LOCKSTEP_INVALID");
  let anomalyCount = 0n;
  for await (const _anomaly of periods.streamAnomalies()) anomalyCount += 1n;
  if (periods.metadata().anomalyCount !== anomalyCount.toString())
    fail("EXPORT_MANIFEST_EVIDENCE_PERIOD_METADATA_INVALID");
  return Object.freeze({
    eventCount: eventCount.toString(),
    sourceLinkCount: sourceLinkCount.toString(),
    anomalyCount: anomalyCount.toString(),
    statusCounts: textCounts(statusCounts),
  });
};

/**
 * Rebuilds bounded manifest evidence from caller-owned, same-snapshot readers.
 * It produces no files, owns no source handles, and cannot make an incomplete
 * implementation appear to be a completed backup.
 */
export class FullBackupManifestEvidence {
  public static async collect(
    options: FullBackupManifestEvidenceOptions,
  ): Promise<FullBackupManifestEvidenceResult> {
    const layout = validateSpoolMetadata(options.spool);
    requireLedgerMetadata(options);
    const raw = await collectRawEvidence(options, layout);
    const money = await collectMoneyEvidence(options.ledger, raw);
    const periods = await collectPeriodEvidence(options.periods, raw);
    return Object.freeze({
      mode: "FULL_BACKUP_MANIFEST_EVIDENCE",
      schemaVersion: FULL_BACKUP_MANIFEST_EVIDENCE_SCHEMA_VERSION,
      complete: false,
      spoolId: options.spool.spoolId,
      snapshotId: options.spool.snapshotId,
      asOf: options.spool.asOf,
      raw,
      money,
      periods,
      integrity: Object.freeze({
        status: "VERIFIED_PARTIAL",
        scope: "REGISTERED_RAW_AND_LEDGER_EVIDENCE_ONLY",
        completeBackup: false,
      }),
      businessCorrectness: Object.freeze({
        status: "NOT_ASSERTED",
        scope: "NO_COMPLETE_BUSINESS_CORRECTNESS_ASSERTION",
      }),
      coverageGaps: FULL_BACKUP_MANIFEST_EVIDENCE_COVERAGE_GAPS,
    });
  }
}
