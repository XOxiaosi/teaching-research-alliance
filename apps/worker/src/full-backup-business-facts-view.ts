import {
  FULL_BACKUP_BUSINESS_SCHEMA_VERSION,
  BUSINESS_BACKUP_SHEETS,
  type BusinessBackupSheet,
} from "./full-backup-business-schema.js";
import { FULL_BACKUP_KNOWN_COVERAGE_GAPS, createFullBackupLayout } from "./full-backup-layout.js";
import { readBackupSpoolDataset } from "./full-backup-spool-reader.js";
import type { FullBackupSpoolDataset, FullBackupSpoolResult } from "./full-backup-spool.js";
import { fullBackupOutputColumns } from "./full-backup-transformer.js";

type TextValue = string | null;
type DatasetReader = (directory: string, dataset: FullBackupSpoolDataset) => AsyncIterable<readonly TextValue[]>;

export type BusinessFactsViewSource = Readonly<{
  sourceTable: string;
  rowKeyColumns: readonly string[];
  columns: readonly Readonly<{ sourceColumn: string; label: string }>[];
}>;

export type BusinessFactsViewDescription = Readonly<{
  mode: "BUSINESS_FACTS_VIEW";
  complete: false;
  schemaVersion: typeof FULL_BACKUP_BUSINESS_SCHEMA_VERSION;
  snapshotId: string;
  asOf: string;
  tableNumber: number;
  sheetId: string;
  title: string;
  rowModel: "SOURCE_ROWS_ONLY";
  sources: readonly BusinessFactsViewSource[];
}>;

export type BusinessFactsViewRow = Readonly<{
  sourceTable: string;
  /** Canonical JSON pairs in the source's registered primary-key order. */
  sourceRecordKey: string;
  /** 1-based source stream position; represented as text to avoid integer loss. */
  rowNumber: string;
  values: readonly TextValue[];
}>;

export type FullBackupBusinessFactsViewOptions = Readonly<{
  spoolDirectory: string;
  spool: FullBackupSpoolResult;
  /** @internal Test seam only. Production reads through the integrity-checking spool reader. */
  readDataset?: DatasetReader;
}>;

const fail = (code: string): never => { throw new Error(code); };
const same = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const fixedSources = (sheet: BusinessBackupSheet): readonly BusinessFactsViewSource[] => {
  const sourceTables: string[] = [];
  for (const item of [...sheet.rowKeyColumns, ...sheet.columns]) {
    if (!sourceTables.includes(item.sourceTable)) sourceTables.push(item.sourceTable);
  }
  return Object.freeze(sourceTables.map((sourceTable) => {
    const rowKeyColumns = sheet.rowKeyColumns
      .filter((item) => item.sourceTable === sourceTable)
      .map((item) => item.sourceColumn);
    const columns: Array<{ sourceColumn: string; label: string }> = [];
    for (const sourceColumn of rowKeyColumns) {
      const mapped = sheet.columns.find((item) => item.sourceTable === sourceTable && item.sourceColumn === sourceColumn);
      columns.push({ sourceColumn, label: mapped?.label ?? `原始键：${sourceColumn}` });
    }
    for (const item of sheet.columns) {
      if (item.sourceTable === sourceTable && !columns.some((column) => column.sourceColumn === item.sourceColumn))
        columns.push({ sourceColumn: item.sourceColumn, label: item.label });
    }
    return Object.freeze({
      sourceTable,
      rowKeyColumns: Object.freeze(rowKeyColumns),
      columns: Object.freeze(columns.map((column) => Object.freeze(column))),
    });
  }));
};

const businessSheet = (tableNumber: number): BusinessBackupSheet => {
  const sheet = BUSINESS_BACKUP_SHEETS.find((candidate) => candidate.tableNumber === tableNumber) ?? fail("EXPORT_BUSINESS_FACTS_UNKNOWN_TABLE");
  if (sheet.mode === "DERIVED_REQUIRED") fail("EXPORT_BUSINESS_FACTS_DERIVED_REQUIRED");
  return sheet;
};

/** Requires an untouched, complete RAW spool manifest before any business fact is exposed. */
const assertCompleteSpoolMetadata = (spool: FullBackupSpoolResult): ReadonlyMap<string, FullBackupSpoolDataset> => {
  if (spool.mode !== "RAW_SOURCE_SPOOL" || !spool.spoolId || !spool.snapshotId || !spool.asOf ||
      spool.anomalyFile !== "anomalies.ndjson" || !/^(0|[1-9]\d*)$/.test(spool.anomalyCount) ||
      !same(spool.coverageGaps, FULL_BACKUP_KNOWN_COVERAGE_GAPS))
    fail("EXPORT_BUSINESS_FACTS_SPOOL_METADATA_INVALID");
  const layout = createFullBackupLayout();
  if (spool.datasets.length !== layout.length) fail("EXPORT_BUSINESS_FACTS_SPOOL_METADATA_INVALID");
  const datasets = new Map<string, FullBackupSpoolDataset>();
  for (const [index, item] of layout.entries()) {
    const dataset = spool.datasets[index] ?? fail("EXPORT_BUSINESS_FACTS_SPOOL_METADATA_INVALID");
    const excluded = item.policy === "AUTH_SECRET_TABLE_EXCLUDED";
    const expectedColumns = excluded ? [] : fullBackupOutputColumns(item.tableName);
    const expectedFile = excluded ? null : `datasets/${String(index + 1).padStart(3, "0")}_${item.tableName}.ndjson`;
    if (dataset === undefined || dataset.tableName !== item.tableName || dataset.excluded !== excluded ||
        !same(dataset.columns, expectedColumns) || dataset.spoolFile !== expectedFile ||
        (excluded
          ? dataset.rowCount !== null || dataset.logicalDigest !== null
          : dataset.rowCount === null || !/^(0|[1-9]\d*)$/.test(dataset.rowCount) ||
            dataset.logicalDigest === null || !/^[a-f0-9]{64}$/.test(dataset.logicalDigest)))
      fail("EXPORT_BUSINESS_FACTS_SPOOL_METADATA_INVALID");
    datasets.set(dataset.tableName, dataset);
  }
  return datasets;
};

/**
 * Projects independently stored rows from an already verified RAW spool. It
 * intentionally cannot make a business workbook, join rows, or calculate a
 * derived table.
 */
export class FullBackupBusinessFactsView {
  private readonly datasets: ReadonlyMap<string, FullBackupSpoolDataset>;
  private readonly readDataset: DatasetReader;

  public constructor(private readonly options: FullBackupBusinessFactsViewOptions) {
    this.datasets = assertCompleteSpoolMetadata(options.spool);
    this.readDataset = options.readDataset ?? readBackupSpoolDataset;
  }

  public describe(tableNumber: number): BusinessFactsViewDescription {
    const sheet = businessSheet(tableNumber);
    return Object.freeze({
      mode: "BUSINESS_FACTS_VIEW",
      complete: false,
      schemaVersion: FULL_BACKUP_BUSINESS_SCHEMA_VERSION,
      snapshotId: this.options.spool.snapshotId,
      asOf: this.options.spool.asOf,
      tableNumber: sheet.tableNumber,
      sheetId: sheet.sheetId,
      title: sheet.title,
      rowModel: "SOURCE_ROWS_ONLY",
      sources: fixedSources(sheet),
    });
  }

  public async *readSourceRows(tableNumber: number, sourceTable: string): AsyncGenerator<BusinessFactsViewRow> {
    const description = this.describe(tableNumber);
    const source = description.sources.find((candidate) => candidate.sourceTable === sourceTable) ?? fail("EXPORT_BUSINESS_FACTS_SOURCE_NOT_DECLARED");
    const dataset = this.datasets.get(sourceTable) ?? fail("EXPORT_BUSINESS_FACTS_SOURCE_NOT_DECLARED");
    if (dataset.excluded) fail("EXPORT_BUSINESS_FACTS_SOURCE_NOT_DECLARED");
    const sourceIndexes = source.columns.map(({ sourceColumn }) => {
      const index = dataset.columns.indexOf(sourceColumn);
      if (index < 0) fail("EXPORT_BUSINESS_FACTS_SOURCE_COLUMN_MISSING");
      return index;
    });
    const keyIndexes = source.rowKeyColumns.map((column) => {
      const index = dataset.columns.indexOf(column);
      if (index < 0) fail("EXPORT_BUSINESS_FACTS_SOURCE_COLUMN_MISSING");
      return index;
    });
    let rowNumber = 0n;
    const iterator = this.readDataset(this.options.spoolDirectory, dataset)[Symbol.asyncIterator]();
    let primaryError: unknown;
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        const row = next.value;
        if (row.length !== dataset.columns.length) fail("EXPORT_BUSINESS_FACTS_SOURCE_ROW_INVALID");
        rowNumber += 1n;
        const values = Object.freeze(sourceIndexes.map((index) => row[index]!));
        const keyPairs = source.rowKeyColumns.map((column, index) => [column, row[keyIndexes[index]!]!] as const);
        yield Object.freeze({
          sourceTable,
          sourceRecordKey: JSON.stringify(keyPairs),
          rowNumber: rowNumber.toString(),
          values,
        });
      }
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        await iterator.return?.();
      } catch (cleanupError) {
        if (primaryError !== undefined)
          throw new AggregateError([primaryError, cleanupError], "EXPORT_BUSINESS_FACTS_READER_CLEANUP_FAILED", { cause: primaryError });
        throw cleanupError;
      }
    }
  }
}
