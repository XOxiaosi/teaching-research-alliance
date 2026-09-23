import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EXPORT_SCHEMA_REGISTRY, type ExportTable } from "./export-schema-registry.js";
import { FullBackupBusinessFactsView } from "./full-backup-business-facts-view.js";
import { createFullBackupLayout } from "./full-backup-layout.js";
import { readBackupSpoolDataset } from "./full-backup-spool-reader.js";
import type { FullBackupSpoolDataset, FullBackupSpoolResult } from "./full-backup-spool.js";
import { fullBackupOutputColumns } from "./full-backup-transformer.js";

type TextValue = string | null;
type SqliteDatabase = InstanceType<typeof import("node:sqlite").DatabaseSync>;
type SqliteConstructor = typeof import("node:sqlite").DatabaseSync;

export type DerivedSpoolIndexKeyPair = readonly [column: string, value: TextValue];

export type DerivedSpoolIndexRow = Readonly<{
  tableName: string;
  /** Canonical JSON pairs in the fixed exported-primary-key order. */
  sourceRecordKey: string;
  /** 1-based source-spool ordinal, never sorted lexically by a primary-key value. */
  ordinal: string;
  values: readonly TextValue[];
}>;

export type DerivedSpoolIndexMetadata = Readonly<{
  mode: "DERIVED_SPOOL_INDEX";
  complete: false;
  spoolId: string;
  snapshotId: string;
  asOf: string;
  sources: readonly Readonly<{ tableName: string; rowCount: string }> [];
}>;

export type FullBackupDerivedSpoolIndexOptions = Readonly<{
  /** An existing, private complete RAW spool; this class never changes it. */
  spoolDirectory: string;
  spool: FullBackupSpoolResult;
  /** Parent used only for a new private, disposable SQLite attempt directory. */
  attemptRoot: string;
}>;

type IndexedTable = Readonly<{
  tableName: string;
  columns: readonly string[];
  keyColumns: readonly string[];
  dataset: FullBackupSpoolDataset;
}>;

const SQLITE_MAX_INTEGER = 9_223_372_036_854_775_807n;
const fail = (code: string): never => { throw new Error(code); };

const textValues = (input: unknown, width: number): readonly TextValue[] => {
  if (!Array.isArray(input) || input.length !== width || input.some((value) => value !== null && typeof value !== "string"))
    fail("EXPORT_DERIVED_INDEX_ROW_INVALID");
  return Object.freeze([...(input as TextValue[])]);
};

const parseStoredRow = (table: IndexedTable, row: Readonly<Record<string, unknown>>): DerivedSpoolIndexRow => {
  const ordinal = row.ordinal;
  const recordKey = row.record_key;
  const valuesJson = row.values_json;
  if (typeof ordinal !== "bigint" || ordinal < 1n || typeof recordKey !== "string" || typeof valuesJson !== "string")
    fail("EXPORT_DERIVED_INDEX_ROW_INVALID");
  const safeOrdinal = ordinal as bigint;
  const safeRecordKey = recordKey as string;
  const safeValuesJson = valuesJson as string;
  const values = (() => {
    try { return textValues(JSON.parse(safeValuesJson), table.columns.length); }
    catch { return fail("EXPORT_DERIVED_INDEX_ROW_INVALID"); }
  })();
  const expectedKey = canonicalKey(table, values);
  if (safeRecordKey !== expectedKey) fail("EXPORT_DERIVED_INDEX_ROW_INVALID");
  return Object.freeze({ tableName: table.tableName, sourceRecordKey: safeRecordKey, ordinal: safeOrdinal.toString(), values });
};

const outputKeyColumns = (table: ExportTable, columns: readonly string[]): readonly string[] =>
  Object.freeze(table.orderBy.map((column) => {
    if (columns.includes(column)) return column;
    const fingerprint = `${column}_fingerprint`;
    if (columns.includes(fingerprint)) return fingerprint;
    return fail("EXPORT_DERIVED_INDEX_KEY_SCHEMA_INVALID");
  }));

const canonicalKey = (table: IndexedTable, values: readonly TextValue[]): string => {
  const pairs = table.keyColumns.map((column) => {
    const index = table.columns.indexOf(column);
    if (index < 0) fail("EXPORT_DERIVED_INDEX_KEY_SCHEMA_INVALID");
    return [column, values[index]!] as const;
  });
  return JSON.stringify(pairs);
};

const assertLookupKey = (table: IndexedTable, pairs: readonly DerivedSpoolIndexKeyPair[]): string => {
  if (!Array.isArray(pairs) || pairs.length !== table.keyColumns.length) fail("EXPORT_DERIVED_INDEX_KEY_INVALID");
  for (const [index, pair] of pairs.entries()) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair[0] !== table.keyColumns[index] || (pair[1] !== null && typeof pair[1] !== "string"))
      fail("EXPORT_DERIVED_INDEX_KEY_INVALID");
  }
  return JSON.stringify(pairs);
};

const nodeVersionSupportsSqlite = (): boolean => {
  const matched = /^(\d+)\.(\d+)\.(\d+)$/.exec(process.versions.node);
  if (matched === null) return false;
  const major = Number(matched[1]);
  const minor = Number(matched[2]);
  return major > 22 || (major === 22 && minor >= 16);
};

const sqliteConstructor = async (): Promise<SqliteConstructor> => {
  if (!nodeVersionSupportsSqlite()) fail("EXPORT_DERIVED_SQLITE_RUNTIME_UNAVAILABLE");
  try {
    const runtime = await import("node:sqlite");
    if (typeof runtime.DatabaseSync !== "function") fail("EXPORT_DERIVED_SQLITE_RUNTIME_UNAVAILABLE");
    return runtime.DatabaseSync;
  } catch (error) {
    if (error instanceof Error && error.message === "EXPORT_DERIVED_SQLITE_RUNTIME_UNAVAILABLE") throw error;
    return fail("EXPORT_DERIVED_SQLITE_RUNTIME_UNAVAILABLE");
  }
};

const stableSpool = (spool: FullBackupSpoolResult): FullBackupSpoolResult => Object.freeze({
  mode: spool.mode,
  spoolId: spool.spoolId,
  snapshotId: spool.snapshotId,
  asOf: spool.asOf,
  datasets: Object.freeze(spool.datasets.map((dataset) => Object.freeze({
    tableName: dataset.tableName,
    columns: Object.freeze([...dataset.columns]),
    rowCount: dataset.rowCount,
    logicalDigest: dataset.logicalDigest,
    spoolFile: dataset.spoolFile,
    excluded: dataset.excluded,
  }))),
  anomalyFile: spool.anomalyFile,
  anomalyCount: spool.anomalyCount,
  coverageGaps: Object.freeze([...spool.coverageGaps]),
});

const assertSqliteCapabilities = (database: SqliteDatabase): void => {
  if (typeof database.prepare !== "function" || typeof database.close !== "function") fail("EXPORT_DERIVED_SQLITE_RUNTIME_UNAVAILABLE");
  const statement = database.prepare("SELECT 1 AS value");
  if (typeof statement.iterate !== "function" || typeof statement.setReadBigInts !== "function")
    fail("EXPORT_DERIVED_SQLITE_RUNTIME_UNAVAILABLE");
  statement.setReadBigInts(true);
  const value = statement.get()?.value;
  if (value !== 1n) fail("EXPORT_DERIVED_SQLITE_RUNTIME_UNAVAILABLE");
};

const prepareAttemptRoot = async (attemptRoot: string): Promise<void> => {
  try {
    const existing = await lstat(attemptRoot);
    if (!existing.isDirectory() || existing.isSymbolicLink()) fail("EXPORT_DERIVED_INDEX_ATTEMPT_ROOT_INVALID");
  } catch (error) {
    if (error instanceof Error && error.message === "EXPORT_DERIVED_INDEX_ATTEMPT_ROOT_INVALID") throw error;
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    await mkdir(attemptRoot, { recursive: true, mode: 0o700 });
  }
  const confirmed = await lstat(attemptRoot);
  if (!confirmed.isDirectory() || confirmed.isSymbolicLink()) fail("EXPORT_DERIVED_INDEX_ATTEMPT_ROOT_INVALID");
};

const indexedTables = (spool: FullBackupSpoolResult): readonly IndexedTable[] => {
  // This constructor is the existing strict complete-RAW metadata gate. It
  // checks all layout positions, output columns, coverage gaps, and exclusions.
  new FullBackupBusinessFactsView({ spoolDirectory: "metadata-only", spool });
  const datasets = new Map(spool.datasets.map((dataset) => [dataset.tableName, dataset]));
  return Object.freeze(createFullBackupLayout().flatMap((item) => {
    if (item.policy !== "RAW_SOURCE") return [];
    const table = EXPORT_SCHEMA_REGISTRY.find((candidate) => candidate.name === item.tableName) ?? fail("EXPORT_DERIVED_INDEX_TABLE_UNKNOWN");
    const sourceDataset = datasets.get(item.tableName) ?? fail("EXPORT_DERIVED_INDEX_METADATA_INVALID");
    if (sourceDataset.excluded || sourceDataset.rowCount === null || sourceDataset.logicalDigest === null || sourceDataset.spoolFile === null)
      fail("EXPORT_DERIVED_INDEX_METADATA_INVALID");
    const fixedDataset: FullBackupSpoolDataset = Object.freeze({
      tableName: sourceDataset.tableName,
      columns: Object.freeze([...sourceDataset.columns]),
      rowCount: sourceDataset.rowCount,
      logicalDigest: sourceDataset.logicalDigest,
      spoolFile: sourceDataset.spoolFile,
      excluded: sourceDataset.excluded,
    });
    const columns = fullBackupOutputColumns(item.tableName);
    if (JSON.stringify(fixedDataset.columns) !== JSON.stringify(columns)) fail("EXPORT_DERIVED_INDEX_METADATA_INVALID");
    return [Object.freeze({ tableName: item.tableName, columns, keyColumns: outputKeyColumns(table, columns), dataset: fixedDataset })];
  }));
};

/**
 * Private, bounded staging for future table-3/table-7 derivations. It reads
 * fixed RAW datasets to EOF before exposing any rows; it does not calculate
 * money, select business periods, query PostgreSQL, or write a workbook.
 */
export class FullBackupDerivedSpoolIndex {
  private closePromise: Promise<void> | undefined;
  private closed = false;
  /** Each closer removes itself before touching native SQLite state. */
  private readonly activeIteratorClosers = new Set<() => void>();

  private constructor(
    private database: SqliteDatabase | undefined,
    private readonly directory: string,
    private readonly tables: ReadonlyMap<string, IndexedTable>,
    private readonly result: DerivedSpoolIndexMetadata,
  ) {}

  public static async create(options: FullBackupDerivedSpoolIndexOptions): Promise<FullBackupDerivedSpoolIndex> {
    const spool = stableSpool(options.spool);
    const tables = indexedTables(spool);
    const Constructor = await sqliteConstructor();
    await prepareAttemptRoot(options.attemptRoot);
    let directory: string | undefined;
    let database: SqliteDatabase | undefined;
    try {
      directory = await mkdtemp(join(options.attemptRoot, "full-backup-derived-index-"));
      await chmod(directory, 0o700);
      const databasePath = join(directory, "derived-spool.sqlite");
      await writeFile(databasePath, "", { flag: "wx", mode: 0o600 });
      database = new Constructor(databasePath, { enableForeignKeyConstraints: true, allowExtension: false });
      await chmod(databasePath, 0o600);
      assertSqliteCapabilities(database);
      database.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE indexed_row(table_name TEXT NOT NULL, ordinal INTEGER NOT NULL, record_key TEXT NOT NULL, values_json TEXT NOT NULL, PRIMARY KEY(table_name, ordinal), UNIQUE(table_name, record_key)); CREATE TABLE indexed_source(table_name TEXT PRIMARY KEY, row_count TEXT NOT NULL);");
      const insert = database.prepare("INSERT OR IGNORE INTO indexed_row(table_name,ordinal,record_key,values_json) VALUES(?,?,?,?)");
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const table of tables) {
          let ordinal = 0n;
          for await (const values of readBackupSpoolDataset(options.spoolDirectory, table.dataset)) {
            ordinal += 1n;
            if (ordinal > SQLITE_MAX_INTEGER) fail("EXPORT_DERIVED_INDEX_ORDINAL_RANGE");
            const normalized = textValues(values, table.columns.length);
            const change = insert.run(table.tableName, ordinal, canonicalKey(table, normalized), JSON.stringify(normalized));
            if (change.changes !== 1) fail("EXPORT_DERIVED_INDEX_DUPLICATE_KEY");
          }
          if (ordinal.toString() !== table.dataset.rowCount) fail("EXPORT_DERIVED_INDEX_COUNT_INVALID");
          database.prepare("INSERT INTO indexed_source(table_name,row_count) VALUES(?,?)").run(table.tableName, ordinal.toString());
        }
        database.exec("COMMIT");
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* preserve the source or index failure */ }
        throw error;
      }
      await chmod(databasePath, 0o600);
      const metadata = Object.freeze({
        mode: "DERIVED_SPOOL_INDEX" as const,
        complete: false as const,
        spoolId: spool.spoolId,
        snapshotId: spool.snapshotId,
        asOf: spool.asOf,
        sources: Object.freeze(tables.map((table) => Object.freeze({ tableName: table.tableName, rowCount: table.dataset.rowCount! }))),
      });
      return new FullBackupDerivedSpoolIndex(database, directory, new Map(tables.map((table) => [table.tableName, table])), metadata);
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try { database?.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      if (directory !== undefined) {
        try { await rm(directory, { recursive: true, force: true }); }
        catch (cleanupError) { cleanupErrors.push(cleanupError); }
      }
      if (cleanupErrors.length > 0)
        throw new AggregateError([error, ...cleanupErrors], "EXPORT_DERIVED_INDEX_CREATE_CLEANUP_FAILED", { cause: error });
      throw error;
    }
  }

  public metadata(): DerivedSpoolIndexMetadata { return this.result; }

  public async *stream(tableName: string): AsyncGenerator<DerivedSpoolIndexRow> {
    const table = this.table(tableName);
    const database = this.openDatabase();
    const statement = database.prepare("SELECT ordinal,record_key,values_json FROM indexed_row WHERE table_name=? ORDER BY ordinal");
    statement.setReadBigInts(true);
    const iterator = statement.iterate(table.tableName)[Symbol.iterator]();
    let iteratorActive = true;
    const closeIterator = (): void => {
      if (!iteratorActive) return;
      iteratorActive = false;
      this.activeIteratorClosers.delete(closeIterator);
      iterator.return?.();
    };
    this.activeIteratorClosers.add(closeIterator);
    try {
      for (;;) {
        if (this.closed) fail("EXPORT_DERIVED_INDEX_CLOSED");
        const next = iterator.next();
        if (next.done) break;
        yield parseStoredRow(table, next.value);
      }
    } finally {
      closeIterator();
    }
  }

  public async lookup(tableName: string, keyPairs: readonly DerivedSpoolIndexKeyPair[]): Promise<DerivedSpoolIndexRow | undefined> {
    const table = this.table(tableName);
    const database = this.openDatabase();
    const statement = database.prepare("SELECT ordinal,record_key,values_json FROM indexed_row WHERE table_name=? AND record_key=?");
    statement.setReadBigInts(true);
    const row = statement.get(table.tableName, assertLookupKey(table, keyPairs));
    return row === undefined ? undefined : parseStoredRow(table, row);
  }

  /** Releases the private SQLite attempt. It never changes the original spool. */
  public close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    const database = this.database;
    this.database = undefined;
    this.closePromise = (async () => {
      const errors: unknown[] = [];
      for (const closeIterator of [...this.activeIteratorClosers]) {
        try { closeIterator(); } catch (error) { errors.push(error); }
      }
      try { database?.close(); } catch (error) { errors.push(error); }
      try { await rm(this.directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1)
        throw new AggregateError(errors, "EXPORT_DERIVED_INDEX_CLOSE_FAILED", { cause: errors[0] });
    })();
    return this.closePromise;
  }

  private table(tableName: string): IndexedTable {
    if (typeof tableName !== "string") fail("EXPORT_DERIVED_INDEX_TABLE_UNKNOWN");
    return this.tables.get(tableName) ?? fail("EXPORT_DERIVED_INDEX_TABLE_UNKNOWN");
  }

  private openDatabase(): SqliteDatabase {
    const database = this.database;
    if (database === undefined) return fail("EXPORT_DERIVED_INDEX_CLOSED");
    if (this.closed) return fail("EXPORT_DERIVED_INDEX_CLOSED");
    return database;
  }
}
