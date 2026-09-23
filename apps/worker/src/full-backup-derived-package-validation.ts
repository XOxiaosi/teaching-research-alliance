import { FullBackupIncomeDerivedView } from "./full-backup-income-derived-view.js";
import {
  FullBackupLedgerDerivedView,
  LEDGER_DERIVED_VIEW_COVERAGE_GAPS,
} from "./full-backup-ledger-derived-view.js";
import { FullBackupLedgerBusinessPeriodSource } from "./full-backup-ledger-business-period-source.js";
import {
  FULL_BACKUP_INCOME_WORKBOOK_SCHEMA_VERSION,
  type FullBackupIncomeWorkbookResult,
} from "./full-backup-income-workbook.js";
import {
  LEDGER_WORKBOOK_SCHEMA_VERSION,
  ledgerWorkbookGaps,
  type FullBackupLedgerWorkbookResult,
} from "./full-backup-ledger-workbook.js";
import type { FullBackupSpoolResult } from "./full-backup-spool.js";
import { fullBackupOutputColumns } from "./full-backup-transformer.js";

export type FullBackupDerivedBundle = Readonly<{
  income: Readonly<{
    directory: string;
    result: FullBackupIncomeWorkbookResult;
  }>;
  ledger: Readonly<{
    directory: string;
    result: FullBackupLedgerWorkbookResult;
  }>;
}>;
/** Caller-owned, live readers constructed from the same immutable RAW spool. */
export type FullBackupDerivedVerificationViews = Readonly<{
  income: FullBackupIncomeDerivedView;
  ledger: FullBackupLedgerDerivedView;
  periods: FullBackupLedgerBusinessPeriodSource;
}>;
export type DerivedPackageMetadata = Readonly<{
  tableNumber: 3 | 7;
  schemaVersion: string;
  complete: false;
  publishedVersion: null;
  status: "DERIVED_UNPUBLISHED" | "PARTIAL";
  gaps: readonly string[];
  rowCounts: Readonly<Record<string, string>>;
  sourceRows: readonly Readonly<{
    tableName: string;
    columns: readonly string[];
    rowCount: string;
    logicalDigest: string;
  }>[];
  contributionDigest: string | null;
  periodStatusCounts: Readonly<Record<string, string>> | null;
  reconciliationStatusCounts: Readonly<Record<string, string>> | null;
}>;
export type VerifiedDerivedComponent = Readonly<{
  key: "income" | "ledger";
  directory: string;
  file: string;
  expectedBytes: bigint;
  expectedSha256: string;
  metadata: DerivedPackageMetadata;
}>;

const fail = (): never => {
  throw new Error("EXPORT_PACKAGE_DERIVED_INVALID");
};
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail();
const keys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean =>
  JSON.stringify(Object.keys(value).sort()) ===
  JSON.stringify([...expected].sort());
const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
const countText = (value: unknown): string =>
  typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) ? value : fail();
const SHA = /^[a-f0-9]{64}$/;
const INCOME_GAPS = Object.freeze([
  "SETTLEMENT_PUBLISHED_SNAPSHOTS_NOT_IMPLEMENTED",
]);
const LEDGER_GAPS = ledgerWorkbookGaps(LEDGER_DERIVED_VIEW_COVERAGE_GAPS);
const PERIOD_STATUSES = [
  "UNIQUE_LOCKED_SETTLEMENT_MONTH",
  "MULTIPLE_BUSINESS_PERIODS",
  "UNRESOLVED",
  "UNIMPLEMENTED_EVENT_TYPE",
] as const;
const LEDGER_SOURCES = new Set([
  "person",
  "venue",
  "settlement_account",
  "account_balance_projection",
  "ledger_entry",
  "ledger_event",
  "settlement_calculation_run",
  "weekly_fee_allocation_snapshot",
  "weekly_fee_entry_version",
  "finance_refund_decision",
  "weekly_fee_refund_effect",
  "finance_refund_submission_item",
]);
const assertSnapshot = (
  metadata: { spoolId: string; snapshotId: string; asOf: string },
  spool: FullBackupSpoolResult,
): void => {
  if (
    metadata.spoolId !== spool.spoolId ||
    metadata.snapshotId !== spool.snapshotId ||
    metadata.asOf !== spool.asOf
  )
    fail();
};
const sourceReceipt = (
  spool: FullBackupSpoolResult,
  names: ReadonlySet<string>,
): DerivedPackageMetadata["sourceRows"] => {
  const rows = spool.datasets.filter((row) => names.has(row.tableName));
  if (rows.length !== names.size) fail();
  return Object.freeze(
    rows.map((row) => {
      if (
        row.excluded ||
        row.rowCount === null ||
        row.logicalDigest === null ||
        !SHA.test(row.logicalDigest)
      )
        return fail();
      return Object.freeze({
        tableName: row.tableName,
        columns: Object.freeze([...fullBackupOutputColumns(row.tableName)]),
        rowCount: countText(row.rowCount),
        logicalDigest: row.logicalDigest,
      });
    }),
  );
};
const countRows = async (rows: AsyncIterable<unknown>): Promise<string> => {
  let count = 0n;
  for await (const _row of rows) count++;
  return count.toString();
};

/** Reconciles receipts against live fixed-schema readers, never producer JSON alone. */
export async function verifyDerivedComponents(
  spool: FullBackupSpoolResult,
  bundle: FullBackupDerivedBundle | undefined,
  views: FullBackupDerivedVerificationViews | undefined,
  hasAllBusinessFacts: boolean,
): Promise<readonly VerifiedDerivedComponent[]> {
  if (bundle === undefined) {
    if (views !== undefined) fail();
    return [];
  }
  if (
    !views ||
    !hasAllBusinessFacts ||
    !keys(object(bundle), ["income", "ledger"]) ||
    !keys(object(views), ["income", "ledger", "periods"])
  )
    fail();
  const trusted = views!;
  const income = trusted.income.metadata(),
    ledger = trusted.ledger.metadata(),
    periods = trusted.periods.metadata();
  for (const metadata of [income, ledger, periods])
    assertSnapshot(metadata, spool);
  if (
    income.mode !== "INCOME_DERIVED_VIEW" ||
    income.complete !== false ||
    income.publishedVersion !== null ||
    ledger.mode !== "DERIVED_POSTED_LEDGER_VIEW" ||
    ledger.complete !== false ||
    periods.mode !== "LEDGER_BUSINESS_PERIOD_SOURCE" ||
    periods.complete !== false ||
    !same(income.gaps, INCOME_GAPS) ||
    !same(ledger.coverageGaps, LEDGER_DERIVED_VIEW_COVERAGE_GAPS) ||
    ledger.sourceValidation !== "LEDGER_EVENT_AND_ACCOUNT_REFERENCE_ONLY"
  )
    fail();

  const base = (
    key: "income" | "ledger",
    table: 3 | 7,
    mode: string,
    file: string,
    schemaVersion: string,
    gaps: readonly string[],
  ) => {
    const input = object(bundle[key]);
    if (
      !keys(input, ["directory", "result"]) ||
      typeof input.directory !== "string" ||
      input.directory.length === 0
    )
      fail();
    const receipt = object(input.result);
    if (
      receipt.mode !== mode ||
      receipt.complete !== false ||
      receipt.tableNumber !== table ||
      !same(receipt.coveredTables, [table]) ||
      receipt.schemaVersion !== schemaVersion ||
      receipt.file !== file ||
      receipt.spoolId !== spool.spoolId ||
      receipt.snapshotId !== spool.snapshotId ||
      receipt.asOf !== spool.asOf ||
      !same(receipt.gaps, gaps) ||
      typeof receipt.sha256 !== "string" ||
      !SHA.test(receipt.sha256) ||
      BigInt(countText(receipt.sizeBytes)) <= 0n
    )
      fail();
    return {
      receipt,
      component: {
        key,
        directory: input.directory as string,
        file,
        expectedBytes: BigInt(receipt.sizeBytes as string),
        expectedSha256: receipt.sha256 as string,
      },
    };
  };
  const incomeBase = base(
    "income",
    3,
    "INCOME_DERIVED_WORKBOOK",
    "business-table-3-income-derived.xlsx",
    FULL_BACKUP_INCOME_WORKBOOK_SCHEMA_VERSION,
    INCOME_GAPS,
  );
  let monthlyCount = 0n,
    contributionCount = 0n;
  let previousAccount: string | undefined, previousMonth: string | undefined;
  for await (const row of trusted.income.streamMonthlyRows()) {
    if (
      row.accountId !== previousAccount ||
      row.settlementMonth !== previousMonth
    )
      monthlyCount++;
    previousAccount = row.accountId;
    previousMonth = row.settlementMonth;
    contributionCount += BigInt(countText(row.contributionCount));
  }
  const incomeAnomalyCount = await countRows(trusted.income.streamAnomalies());
  const sourceNames = new Set(
    income.sourceBasis.sourceRows.map((row) => row.tableName),
  );
  if (
    sourceNames.size !== income.sourceBasis.sourceRows.length ||
    income.sourceBasis.indexMode !== "DERIVED_SPOOL_INDEX" ||
    !SHA.test(income.sourceBasis.contributionDigest)
  )
    fail();
  const incomeSources = sourceReceipt(spool, sourceNames);
  const expectedSourceCounts = incomeSources.map(({ tableName, rowCount }) => ({
    tableName,
    rowCount,
  }));
  if (!same(expectedSourceCounts, income.sourceBasis.sourceRows)) fail();
  if (
    income.status !==
      (incomeAnomalyCount === "0" ? "DERIVED_UNPUBLISHED" : "PARTIAL") ||
    income.anomalyCount !== incomeAnomalyCount ||
    incomeBase.receipt.status !== income.status ||
    incomeBase.receipt.publishedVersion !== null ||
    !same(incomeBase.receipt.sourceBasis, income.sourceBasis) ||
    incomeBase.receipt.monthlyRowCount !== monthlyCount.toString() ||
    incomeBase.receipt.contributionRowCount !== contributionCount.toString() ||
    incomeBase.receipt.anomalyCount !== incomeAnomalyCount
  )
    fail();
  const incomeMetadata: DerivedPackageMetadata = Object.freeze({
    tableNumber: 3,
    schemaVersion: FULL_BACKUP_INCOME_WORKBOOK_SCHEMA_VERSION,
    complete: false,
    publishedVersion: null,
    status: income.status,
    gaps: INCOME_GAPS,
    sourceRows: sourceReceipt(
      spool,
      new Set([...sourceNames, "person", "venue"]),
    ),
    contributionDigest: income.sourceBasis.contributionDigest,
    periodStatusCounts: null,
    reconciliationStatusCounts: null,
    rowCounts: Object.freeze({
      monthly: monthlyCount.toString(),
      contribution: contributionCount.toString(),
      anomaly: incomeAnomalyCount,
      incompleteFee: countText(income.incompleteFeeCount),
    }),
  });

  const ledgerBase = base(
    "ledger",
    7,
    "LEDGER_DERIVED_WORKBOOK",
    "business-table-7-ledger-derived.xlsx",
    LEDGER_WORKBOOK_SCHEMA_VERSION,
    LEDGER_GAPS,
  );
  const reconciliationStatuses = [
    "MATCH",
    "MISMATCH",
    "MISSING_PROJECTION",
    "PROJECTION_INVALID",
    "LEDGER_TOTAL_INVALID",
    "ACCOUNT_UNRESOLVED",
  ] as const;
  const reconciliationCounts = Object.fromEntries(
    reconciliationStatuses.map((status) => [status, 0n]),
  ) as Record<(typeof reconciliationStatuses)[number], bigint>;
  let reconciliationCount = 0n;
  for await (const row of trusted.ledger.streamReconciliations()) {
    if (!Object.hasOwn(reconciliationCounts, row.status)) fail();
    reconciliationCounts[row.status]++;
    reconciliationCount++;
  }
  const rowCounts: Record<string, string> = {
    entryRowCount: await countRows(trusted.ledger.streamEntries()),
    monthlyRowCount: await countRows(trusted.ledger.streamMonthlyRows()),
    reconciliationRowCount: reconciliationCount.toString(),
    ledgerAnomalyCount: await countRows(trusted.ledger.streamAnomalies()),
    periodLinkCount: await countRows(trusted.periods.streamSourceLinks()),
    periodAnomalyCount: await countRows(trusted.periods.streamAnomalies()),
  };
  const statusCounts = Object.fromEntries(
    PERIOD_STATUSES.map((status) => [status, 0n]),
  ) as Record<(typeof PERIOD_STATUSES)[number], bigint>;
  let eventCount = 0n;
  for await (const row of trusted.periods.streamEventPeriods()) {
    if (!Object.hasOwn(statusCounts, row.status)) fail();
    statusCounts[row.status]++;
    eventCount++;
  }
  rowCounts.periodEventCount = eventCount.toString();
  for (const [key, value] of Object.entries(rowCounts))
    if (ledgerBase.receipt[key] !== value) fail();
  if (
    ledger.anomalyCount !== rowCounts.ledgerAnomalyCount ||
    periods.anomalyCount !== rowCounts.periodAnomalyCount
  )
    fail();
  const ledgerSources = sourceReceipt(spool, LEDGER_SOURCES);
  if (
    ledgerSources.find((row) => row.tableName === "ledger_entry")?.rowCount !==
      rowCounts.entryRowCount ||
    ledgerSources.find((row) => row.tableName === "ledger_event")?.rowCount !==
      rowCounts.periodEventCount
  )
    fail();
  const ledgerMetadata: DerivedPackageMetadata = Object.freeze({
    tableNumber: 7,
    schemaVersion: LEDGER_WORKBOOK_SCHEMA_VERSION,
    complete: false,
    publishedVersion: null,
    status:
      rowCounts.ledgerAnomalyCount !== "0" ||
      rowCounts.periodAnomalyCount !== "0" ||
      statusCounts.UNRESOLVED > 0n ||
      statusCounts.UNIMPLEMENTED_EVENT_TYPE > 0n ||
      reconciliationCount !== reconciliationCounts.MATCH
        ? "PARTIAL"
        : "DERIVED_UNPUBLISHED",
    gaps: LEDGER_GAPS,
    rowCounts: Object.freeze(rowCounts),
    sourceRows: ledgerSources,
    contributionDigest: null,
    reconciliationStatusCounts: Object.freeze(
      Object.fromEntries(
        reconciliationStatuses.map((status) => [
          status,
          reconciliationCounts[status].toString(),
        ]),
      ),
    ),
    periodStatusCounts: Object.freeze(
      Object.fromEntries(
        PERIOD_STATUSES.map((status) => [
          status,
          statusCounts[status].toString(),
        ]),
      ),
    ),
  });
  return Object.freeze([
    Object.freeze({ ...incomeBase.component, metadata: incomeMetadata }),
    Object.freeze({ ...ledgerBase.component, metadata: ledgerMetadata }),
  ]);
}
