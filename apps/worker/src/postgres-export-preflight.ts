import {
  EXPORT_SCHEMA_REGISTRY,
  exportColumnsFor,
  type ExportColumn,
  type ExportTable
} from "./export-schema-registry.js";

type QueryResult<Row> = Readonly<{ rows: readonly Row[] }>;

export type PostgresExportClient = Readonly<{
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[]
  ): Promise<QueryResult<Row>>;
  release(): Promise<void> | void;
}>;

export type PostgresExportPool = Readonly<{
  connect(): Promise<PostgresExportClient>;
}>;

export type ExportPreflightDataset = Readonly<{
  tableName: string;
  exportColumns: readonly string[];
  transformColumns: readonly string[];
  secretExcludedColumns: readonly string[];
  selectSql?: string;
}>;

export type ExportPreflightPlan = Readonly<{
  mode: "PRECHECK_ONLY";
  snapshotId: string;
  datasets: readonly ExportPreflightDataset[];
  countRows(tableName: string): Promise<bigint>;
  close(): Promise<void>;
}>;

type CatalogRow = Readonly<{ table_name: string; column_name: string }>;
type SnapshotRow = Readonly<{ snapshot_id: string }>;
type CountRow = Readonly<{ row_count: string }>;

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

const quoteIdentifier = (value: string): string => {
  if (!IDENTIFIER.test(value)) throw new Error("EXPORT_SCHEMA_REGISTRY_INVALID");
  return `"${value}"`;
};

const columnsWith = (table: ExportTable, disposition: ExportColumn["disposition"]): readonly string[] =>
  table.columns.filter((column) => column.disposition === disposition).map((column) => column.name);

const toDataset = (table: ExportTable): ExportPreflightDataset => {
  const exportColumns = exportColumnsFor(table);
  const selectSql = exportColumns.length === 0
    ? undefined
    : `SELECT ${exportColumns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(table.name)}`;
  return {
    tableName: table.name,
    exportColumns,
    transformColumns: columnsWith(table, "TRANSFORM"),
    secretExcludedColumns: columnsWith(table, "SECRET_EXCLUDED"),
    ...(selectSql === undefined ? {} : { selectSql })
  };
};

const expectedCatalog = (): ReadonlyMap<string, ReadonlySet<string>> =>
  new Map(EXPORT_SCHEMA_REGISTRY.map((table) => [table.name, new Set(table.columns.map((column) => column.name))]));

const assertCatalogMatchesRegistry = (rows: readonly CatalogRow[]): void => {
  const expected = expectedCatalog();
  const actual = new Map<string, Set<string>>();
  for (const row of rows) {
    const columns = actual.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    actual.set(row.table_name, columns);
  }

  if (actual.size !== expected.size) throw new Error("EXPORT_SCHEMA_MISMATCH");
  for (const [tableName, expectedColumns] of expected) {
    const actualColumns = actual.get(tableName);
    if (actualColumns === undefined || actualColumns.size !== expectedColumns.size) throw new Error("EXPORT_SCHEMA_MISMATCH");
    for (const columnName of expectedColumns) {
      if (!actualColumns.has(columnName)) throw new Error("EXPORT_SCHEMA_MISMATCH");
    }
  }
};

const catalogSql = `
  SELECT relation.relname AS table_name, attribute.attname AS column_name
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = relation.oid
   WHERE namespace.oid = pg_catalog.current_schema()::regnamespace
     AND relation.relkind IN ('r', 'p')
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
   ORDER BY relation.relname, attribute.attnum
`;

/**
 * Opens the transaction that a later F14 exporter will use.  This package only
 * classifies the fixed schema and prepares its read-only snapshot; it does not
 * read business rows into an export file or claim backup completion.
 */
export class PostgresExportPreflight {
  public constructor(private readonly pool: PostgresExportPool) {}

  public async open(): Promise<ExportPreflightPlan> {
    const client = await this.pool.connect();
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      try {
        await client.query("COMMIT");
      } finally {
        await client.release();
      }
    };

    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const catalog = await client.query<CatalogRow>(catalogSql);
      assertCatalogMatchesRegistry(catalog.rows);
      const snapshots = await client.query<SnapshotRow>("SELECT pg_export_snapshot() AS snapshot_id");
      const snapshot = snapshots.rows[0];
      if (snapshots.rows.length !== 1 || snapshot === undefined || snapshot.snapshot_id.length === 0) {
        throw new Error("EXPORT_SNAPSHOT_UNAVAILABLE");
      }
      const datasets = EXPORT_SCHEMA_REGISTRY.map(toDataset);
      const registeredTables = new Set(datasets.map((dataset) => dataset.tableName));
      return {
        mode: "PRECHECK_ONLY",
        snapshotId: snapshot.snapshot_id,
        datasets,
        countRows: async (tableName: string): Promise<bigint> => {
          if (closed) throw new Error("EXPORT_PREFLIGHT_CLOSED");
          if (!registeredTables.has(tableName)) throw new Error("EXPORT_SCHEMA_MISMATCH");
          const rows = await client.query<CountRow>(`SELECT count(*)::text AS row_count FROM ${quoteIdentifier(tableName)}`);
          const row = rows.rows[0];
          if (rows.rows.length !== 1 || row === undefined || !/^[0-9]+$/.test(row.row_count)) {
            throw new Error("EXPORT_SNAPSHOT_UNAVAILABLE");
          }
          return BigInt(row.row_count);
        },
        close
      };
    } catch (error) {
      if (!closed) {
        closed = true;
        try {
          await client.query("ROLLBACK");
        } finally {
          await client.release();
        }
      }
      throw error;
    }
  }
}
