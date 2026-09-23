import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  FULL_BACKUP_KNOWN_COVERAGE_GAPS,
  createFullBackupLayout,
} from "./full-backup-layout.js";
import {
  fullBackupOutputColumns,
  type FullBackupTransformer,
} from "./full-backup-transformer.js";
import type {
  FullBackupRow,
  FullBackupSourceSnapshot,
} from "./postgres-full-backup-source.js";

type TextValue = string | null;
type SpoolSource = Readonly<{ open(): Promise<FullBackupSourceSnapshot> }>;
type SpoolTransformer = Pick<FullBackupTransformer, "transformRow">;

export type FullBackupSpoolDataset = Readonly<{
  tableName: string;
  columns: readonly string[];
  rowCount: string | null;
  logicalDigest: string | null;
  spoolFile: string | null;
  excluded: boolean;
}>;

export type FullBackupSpoolAnomaly = Readonly<{
  code: "TRANSFORM_VALUE_ANOMALY";
  tableName: string;
  columnName: string;
  /** 1-based stable stream position; deliberately never a business identifier. */
  rowNumber: string;
  field?: string;
}>;

export type FullBackupSpoolResult = Readonly<{
  mode: "RAW_SOURCE_SPOOL";
  spoolId: string;
  snapshotId: string;
  asOf: string;
  datasets: readonly FullBackupSpoolDataset[];
  anomalyFile: string;
  anomalyCount: string;
  coverageGaps: readonly string[];
}>;

export type FullBackupSpoolOptions = Readonly<{
  source: SpoolSource;
  transformer: SpoolTransformer;
  tempRoot: string;
  batchSize?: number;
  columnsFor?: (tableName: string) => readonly string[];
}>;

const DEFAULT_BATCH_SIZE = 500;
const SAFE_SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;
const SAFE_FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const fail = (code: string): never => { throw new Error(code); };

const sameNames = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length && actual.every((name, index) => name === expected[index]);

const assertTextValues = (values: Readonly<Record<string, TextValue>>, columns: readonly string[]): readonly TextValue[] => {
  const actual = Object.keys(values);
  if (!sameNames(actual, columns)) fail("EXPORT_SPOOL_OUTPUT_COLUMNS_MISMATCH");
  return columns.map((column) => {
    if (!(column in values)) fail("EXPORT_SPOOL_OUTPUT_COLUMNS_MISMATCH");
    const value = values[column]!;
    if (value !== null && typeof value !== "string") fail("EXPORT_SPOOL_VALUE_NOT_TEXT");
    return value;
  });
};

const writeAll = async (file: FileHandle, text: string): Promise<void> => {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = await file.write(bytes, offset, bytes.length - offset);
    if (written.bytesWritten <= 0) fail("EXPORT_SPOOL_WRITE_FAILED");
    offset += written.bytesWritten;
  }
};

const safeAnomaly = (value: Readonly<{ code: string; tableName: string; columnName: string; field?: string }>, rowNumber: bigint): FullBackupSpoolAnomaly => {
  if (value.code !== "TRANSFORM_VALUE_ANOMALY" || !SAFE_SCHEMA_NAME.test(value.tableName) || !SAFE_SCHEMA_NAME.test(value.columnName))
    fail("EXPORT_SPOOL_ANOMALY_INVALID");
  return {
    code: "TRANSFORM_VALUE_ANOMALY",
    tableName: value.tableName,
    columnName: value.columnName,
    rowNumber: rowNumber.toString(),
    ...(value.field !== undefined && SAFE_FIELD.test(value.field) ? { field: value.field } : {}),
  };
};

const relativeDatasetFile = (index: number, tableName: string): string =>
  `datasets/${String(index + 1).padStart(3, "0")}_${tableName}.ndjson`;

/**
 * Spools one fixed, repeatable-read source snapshot as bounded-memory NDJSON.
 * This is raw-source preparation only: it does not produce a workbook, package,
 * scheduled job, or completed F14 backup claim.
 */
export class FullBackupSpool {
  private readonly batchSize: number;
  private readonly columnsFor: (tableName: string) => readonly string[];

  public constructor(private readonly options: FullBackupSpoolOptions) {
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.columnsFor = options.columnsFor ?? fullBackupOutputColumns;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 1_000)
      fail("INVALID_EXPORT_BATCH_SIZE");
  }

  public async create(): Promise<FullBackupSpoolResult> {
    let snapshot: FullBackupSourceSnapshot | undefined;
    let directory: string | undefined;
    let anomalyFile: FileHandle | undefined;
    try {
      snapshot = await this.options.source.open();
      const snapshotId = snapshot.snapshotId;
      const asOf = snapshot.asOf;
      const layout = createFullBackupLayout();
      const expectedNames = layout.map((item) => item.tableName);
      const sourceNames = snapshot.datasets.map((item) => item.tableName);
      if (!sameNames(sourceNames, expectedNames)) fail("EXPORT_SPOOL_SOURCE_DATASET_MISMATCH");

      await mkdir(this.options.tempRoot, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(this.options.tempRoot, "full-backup-spool-"));
      await chmod(directory, 0o700);
      await mkdir(join(directory, "datasets"), { mode: 0o700 });
      anomalyFile = await open(join(directory, "anomalies.ndjson"), "wx", 0o600);

      const datasets: FullBackupSpoolDataset[] = [];
      let anomalyCount = 0n;
      for (const [index, item] of layout.entries()) {
        if (item.policy === "AUTH_SECRET_TABLE_EXCLUDED") {
          const columns = this.columnsFor(item.tableName);
          if (columns.length !== 0) fail("EXPORT_SPOOL_SECRET_LAYOUT_MISMATCH");
          datasets.push({
            tableName: item.tableName,
            columns,
            rowCount: null,
            logicalDigest: null,
            spoolFile: null,
            excluded: true,
          });
          continue;
        }

        const columns = this.columnsFor(item.tableName);
        if (columns.length === 0) fail("EXPORT_SPOOL_LAYOUT_COLUMNS_MISSING");
        const counted = await snapshot.countRows(item.tableName);
        const spoolFile = relativeDatasetFile(index, item.tableName);
        const output = await open(join(directory, spoolFile), "wx", 0o600);
        let written = 0n;
        const digest = createHash("sha256");
        try {
          const header = `${JSON.stringify({ columns })}\n`;
          await writeAll(output, header);
          digest.update(header, "utf8");
          const stream = await snapshot.openStream(item.tableName, this.batchSize);
          try {
            for await (const batch of stream) {
              if (batch.datasetName !== item.tableName) fail("EXPORT_SPOOL_STREAM_DATASET_MISMATCH");
              for (const row of batch.rows) {
                await this.writeTransformedRow(
                  output,
                  digest,
                  anomalyFile,
                  item.tableName,
                  columns,
                  row,
                  written + 1n,
                  (count) => { anomalyCount += count; },
                );
                written += 1n;
              }
            }
          } finally {
            await stream.close();
          }
        } finally {
          await output.close();
        }
        if (written !== counted) fail("EXPORT_SPOOL_ROW_COUNT_MISMATCH");
        datasets.push({
          tableName: item.tableName,
          columns,
          rowCount: written.toString(),
          logicalDigest: digest.digest("hex"),
          spoolFile,
          excluded: false,
        });
      }

      await anomalyFile.close();
      anomalyFile = undefined;
      await snapshot.close();
      snapshot = undefined;
      return {
        mode: "RAW_SOURCE_SPOOL",
        spoolId: basename(directory),
        snapshotId,
        asOf,
        datasets,
        anomalyFile: "anomalies.ndjson",
        anomalyCount: anomalyCount.toString(),
        coverageGaps: [...FULL_BACKUP_KNOWN_COVERAGE_GAPS],
      };
    } catch (error) {
      if (anomalyFile !== undefined) await anomalyFile.close().catch(() => undefined);
      if (snapshot !== undefined) await snapshot.close().catch(() => undefined);
      if (directory !== undefined) await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private async writeTransformedRow(
    output: FileHandle,
    digest: ReturnType<typeof createHash>,
    anomalyFile: FileHandle,
    tableName: string,
    columns: readonly string[],
    row: FullBackupRow,
    rowNumber: bigint,
    incrementAnomalies: (count: bigint) => void,
  ): Promise<void> {
    const transformed = await this.options.transformer.transformRow({
      tableName,
      exportValues: row.exportValues,
      transformValues: row.transformValues,
      ...(row.transformContext === undefined ? {} : { context: row.transformContext }),
    });
    const line = `${JSON.stringify(assertTextValues(transformed.values, columns))}\n`;
    await writeAll(output, line);
    digest.update(line, "utf8");
    for (const anomaly of transformed.anomalies) {
      const safe = safeAnomaly(anomaly, rowNumber);
      await writeAll(anomalyFile, `${JSON.stringify(safe)}\n`);
      incrementAnomalies(1n);
    }
  }
}
