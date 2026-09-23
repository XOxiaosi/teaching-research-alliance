import {
  EXPORT_SCHEMA_REGISTRY,
  readableColumnsFor,
  type ExportTable,
} from "./export-schema-registry.js";
import {
  assertExportCatalogMatchesRegistry,
  EXPORT_CATALOG_SQL,
  quoteExportIdentifier,
  type PostgresExportClient,
  type PostgresExportPool,
} from "./postgres-export-preflight.js";

type TextValue = string | null;
type TextRow = Record<string, TextValue>;
type CatalogRow = Readonly<{ table_name: string; column_name: string }>;
type SnapshotRow = Readonly<{ snapshot_id: string; as_of: string }>;
type CountRow = Readonly<{ row_count: string }>;

const WITHDRAWAL_APPLICANT_CONTEXT_COLUMN = "__backup_withdrawal_applicant_person_id";
const WITHDRAWAL_SUBMISSION_TABLE = "finance_withdrawal_submission";

export type FullBackupDataset = Readonly<{
  tableName: string;
  exportColumns: readonly string[];
  transformColumns: readonly string[];
  orderBy: readonly string[];
}>;

export type FullBackupRow = Readonly<{
  /** Safe fields a later writer may serialize only after its own manifest checks. */
  exportValues: Readonly<Record<string, TextValue>>;
  /** Raw sensitive business fields reserved for a future explicit transformer. */
  transformValues: ReadonlyMap<string, TextValue>;
  /** Internal AAD only.  It is neither a registered source column nor export data. */
  transformContext?: Readonly<{
    withdrawalRecipient: Readonly<{ applicantPersonId: string }>;
  }>;
}>;

export type FullBackupBatch = Readonly<{
  datasetName: string;
  rows: readonly FullBackupRow[];
}>;

export type FullBackupDatasetStream = AsyncIterableIterator<FullBackupBatch> &
  Readonly<{
    close(): Promise<void>;
  }>;

export type FullBackupSourceSnapshot = Readonly<{
  mode: "SOURCE_ONLY";
  snapshotId: string;
  asOf: string;
  datasets: readonly FullBackupDataset[];
  openStream(
    datasetName: string,
    batchSize: number,
  ): Promise<FullBackupDatasetStream>;
  countRows(datasetName: string): Promise<bigint>;
  close(): Promise<void>;
}>;

const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 1_000;

const readableDataset = (table: ExportTable): FullBackupDataset => ({
  tableName: table.name,
  exportColumns: table.columns
    .filter((column) => column.disposition === "EXPORT")
    .map((column) => column.name),
  transformColumns: table.columns
    .filter((column) => column.disposition === "TRANSFORM")
    .map((column) => column.name),
  orderBy: table.orderBy,
});

const readColumns = (table: ExportTable): readonly string[] =>
  readableColumnsFor(table).map((column) => column.name);

const selectTextColumns = (columns: readonly string[], tableAlias?: string): string =>
  columns
    .map(
      (column) =>
        `${tableAlias === undefined ? quoteExportIdentifier(column) : `${quoteExportIdentifier(tableAlias)}.${quoteExportIdentifier(column)}`}::text AS ${quoteExportIdentifier(column)}`,
    )
    .join(", ");

const makeRow = (table: ExportTable, row: TextRow): FullBackupRow => {
  const exportValues: Record<string, TextValue> = {};
  const transformValues = new Map<string, TextValue>();
  for (const column of table.columns) {
    if (column.disposition === "SECRET_EXCLUDED") continue;
    const value = row[column.name];
    if (value !== null && typeof value !== "string")
      throw new Error("EXPORT_SOURCE_VALUE_NOT_TEXT");
    if (column.disposition === "EXPORT") exportValues[column.name] = value;
    else transformValues.set(column.name, value);
  }
  const applicantPersonId = row[WITHDRAWAL_APPLICANT_CONTEXT_COLUMN];
  if (table.name === WITHDRAWAL_SUBMISSION_TABLE && applicantPersonId !== null && typeof applicantPersonId === "string" && applicantPersonId.length > 0) {
    return {
      exportValues,
      transformValues,
      transformContext: { withdrawalRecipient: { applicantPersonId } },
    };
  }
  return { exportValues, transformValues };
};

const cursorIdentifier = (sequence: number): string =>
  `full_backup_cursor_${sequence}`;

/**
 * Internal F14 data source.  It owns one REPEATABLE READ / READ ONLY connection
 * and exposes only fixed registered datasets.  It neither creates a file nor
 * represents a completed backup.
 */
export class PostgresFullBackupSource {
  public constructor(private readonly pool: PostgresExportPool) {}

  public async open(): Promise<FullBackupSourceSnapshot> {
    const client = await this.pool.connect();
    let closed = false;
    let closing = false;
    let activeCursor: string | undefined;
    let openingStream = false;
    let cursorSequence = 0;
    let tables = new Map<string, ExportTable>();
    let serialized = Promise.resolve();
    let closePromise: Promise<void> | undefined;

    const withSourceLock = async <T>(work: () => Promise<T>): Promise<T> => {
      const previous = serialized;
      let release: (() => void) | undefined;
      serialized = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release!();
      }
    };

    const finish = async (commit: boolean): Promise<void> => {
      if (closed) return;
      closed = true;
      let closeFailure: unknown;
      if (activeCursor !== undefined) {
        const cursor = activeCursor;
        activeCursor = undefined;
        try {
          await client.query(`CLOSE ${quoteExportIdentifier(cursor)}`);
        } catch (error) {
          closeFailure = error;
        }
      }
      try {
        await client.query(commit && closeFailure === undefined ? "COMMIT" : "ROLLBACK");
      } finally {
        await client.release();
      }
      if (closeFailure !== undefined) throw closeFailure;
    };

    const closeCursor = async (cursor: string): Promise<void> => {
      if (activeCursor !== cursor) return;
      activeCursor = undefined;
      await client.query(`CLOSE ${quoteExportIdentifier(cursor)}`);
    };

    const closeSource = (): Promise<void> => {
      if (closePromise !== undefined) return closePromise;
      closing = true;
      closePromise = withSourceLock(async () => {
        await finish(true);
      });
      return closePromise;
    };

    const countRows = async (datasetName: string): Promise<bigint> => {
      if (closed || closing) throw new Error("EXPORT_SOURCE_CLOSED");
      return withSourceLock(async () => {
        if (closed || closing) throw new Error("EXPORT_SOURCE_CLOSED");
        const table = tables.get(datasetName);
        if (table === undefined) throw new Error("EXPORT_DATASET_UNKNOWN");
        // Counting a table with no readable columns would still read an
        // authentication-only dataset such as user_session.  It is excluded
        // by the same rule as streaming.
        if (readColumns(table).length === 0)
          throw new Error("EXPORT_DATASET_NO_READABLE_COLUMNS");
        const result = await client.query<CountRow>(
          `SELECT count(*)::text AS row_count FROM ${quoteExportIdentifier(table.name)}`,
        );
        if (closed || closing) throw new Error("EXPORT_SOURCE_CLOSED");
        const row = result.rows[0];
        if (
          result.rows.length !== 1 ||
          row === undefined ||
          !/^[0-9]+$/.test(row.row_count)
        )
          throw new Error("EXPORT_SNAPSHOT_UNAVAILABLE");
        return BigInt(row.row_count);
      });
    };

    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const catalog = await client.query<CatalogRow>(EXPORT_CATALOG_SQL);
      assertExportCatalogMatchesRegistry(catalog.rows);
      const snapshot = await client.query<SnapshotRow>(
        "SELECT pg_export_snapshot() AS snapshot_id, transaction_timestamp()::text AS as_of",
      );
      const snapshotRow = snapshot.rows[0];
      if (
        snapshot.rows.length !== 1 ||
        snapshotRow === undefined ||
        snapshotRow.snapshot_id.length === 0 ||
        snapshotRow.as_of.length === 0
      )
        throw new Error("EXPORT_SNAPSHOT_UNAVAILABLE");

      tables = new Map(EXPORT_SCHEMA_REGISTRY.map((table) => [table.name, table]));
      const datasets = EXPORT_SCHEMA_REGISTRY.map(readableDataset);
      return {
        mode: "SOURCE_ONLY",
        snapshotId: snapshotRow.snapshot_id,
        asOf: snapshotRow.as_of,
        datasets,
        openStream: async (
          datasetName: string,
          batchSize: number,
        ): Promise<FullBackupDatasetStream> => {
          if (closed || closing) throw new Error("EXPORT_SOURCE_CLOSED");
          if (openingStream || activeCursor !== undefined)
            throw new Error("EXPORT_STREAM_BUSY");
          openingStream = true;
          try {
            return await withSourceLock(async (): Promise<FullBackupDatasetStream> => {
              if (closed || closing) throw new Error("EXPORT_SOURCE_CLOSED");
              if (!Number.isSafeInteger(batchSize) || batchSize < MIN_BATCH_SIZE || batchSize > MAX_BATCH_SIZE)
                throw new Error("INVALID_EXPORT_BATCH_SIZE");
              if (activeCursor !== undefined) throw new Error("EXPORT_STREAM_BUSY");
              const table = tables.get(datasetName);
              if (table === undefined) throw new Error("EXPORT_DATASET_UNKNOWN");
              const columns = readColumns(table);
              if (columns.length === 0) throw new Error("EXPORT_DATASET_NO_READABLE_COLUMNS");

              const cursor = cursorIdentifier(++cursorSequence);
              const statement = table.name === WITHDRAWAL_SUBMISSION_TABLE
                ? `DECLARE ${quoteExportIdentifier(cursor)} NO SCROLL CURSOR FOR SELECT ${selectTextColumns(columns, "submission")}, ${quoteExportIdentifier("document")}.${quoteExportIdentifier("applicant_person_id")}::text AS ${quoteExportIdentifier(WITHDRAWAL_APPLICANT_CONTEXT_COLUMN)} FROM ${quoteExportIdentifier(table.name)} AS ${quoteExportIdentifier("submission")} LEFT JOIN ${quoteExportIdentifier("finance_document")} AS ${quoteExportIdentifier("document")} ON ${quoteExportIdentifier("document")}.${quoteExportIdentifier("id")}=${quoteExportIdentifier("submission")}.${quoteExportIdentifier("finance_document_id")} ORDER BY ${table.orderBy.map((column) => `${quoteExportIdentifier("submission")}.${quoteExportIdentifier(column)}`).join(", ")}`
                : `DECLARE ${quoteExportIdentifier(cursor)} NO SCROLL CURSOR FOR SELECT ${selectTextColumns(columns)} FROM ${quoteExportIdentifier(table.name)} ORDER BY ${table.orderBy.map(quoteExportIdentifier).join(", ")}`;
              try {
                await client.query(statement);
                activeCursor = cursor;
              } catch (error) {
                await finish(false);
                throw error;
              }
              if (closed || closing) {
                await finish(false);
                throw new Error("EXPORT_SOURCE_CLOSED");
              }

              let streamClosed = false;
              let inFlight = false;
              const stop = async (cancelled: boolean): Promise<void> => {
                if (streamClosed) return;
                streamClosed = true;
                if (cancelled) await closeSource();
                else {
                  await withSourceLock(async () => {
                    if (!closed) await closeCursor(cursor);
                  });
                }
              };
              const stream: FullBackupDatasetStream = {
                async next(): Promise<IteratorResult<FullBackupBatch>> {
                  if (closed || closing) throw new Error("EXPORT_SOURCE_CLOSED");
                  if (streamClosed) return { done: true, value: undefined };
                  if (inFlight) throw new Error("EXPORT_STREAM_CONCURRENT_CONSUMPTION");
                  inFlight = true;
                  try {
                    return await withSourceLock(async () => {
                      if (closed || closing) throw new Error("EXPORT_SOURCE_CLOSED");
                      const fetched = await client.query<TextRow>(
                        `FETCH FORWARD ${batchSize} FROM ${quoteExportIdentifier(cursor)}`,
                      );
                      if (closed || closing) throw new Error("EXPORT_SOURCE_CLOSED");
                      if (fetched.rows.length === 0) {
                        streamClosed = true;
                        await closeCursor(cursor);
                        return { done: true, value: undefined };
                      }
                      return {
                        done: false,
                        value: {
                          datasetName,
                          rows: fetched.rows.map((row) => makeRow(table, row)),
                        },
                      };
                    });
                  } catch (error) {
                    await finish(false);
                    streamClosed = true;
                    throw error;
                  } finally {
                    inFlight = false;
                  }
                },
                async return(): Promise<IteratorResult<FullBackupBatch>> {
                  await stop(true);
                  return { done: true, value: undefined };
                },
                async throw(error?: unknown): Promise<IteratorResult<FullBackupBatch>> {
                  await finish(false);
                  streamClosed = true;
                  throw error;
                },
                async close(): Promise<void> {
                  await stop(true);
                },
                [Symbol.asyncIterator](): AsyncIterableIterator<FullBackupBatch> {
                  return this;
                },
              };
              return stream;
            });
          } finally {
            openingStream = false;
          }
        },
        countRows,
        close: closeSource,
      };
    } catch (error) {
      await finish(false);
      throw error;
    }
  }
}
