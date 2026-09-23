import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FullBackupDerivedSpoolIndex,
  type DerivedSpoolIndexRow,
} from "./full-backup-derived-spool-index.js";
import { fullBackupOutputColumns } from "./full-backup-transformer.js";

type TextValue = string | null;
type SqliteDatabase = InstanceType<typeof import("node:sqlite").DatabaseSync>;
type SqliteConstructor = typeof import("node:sqlite").DatabaseSync;

export const LEDGER_DERIVED_VIEW_COVERAGE_GAPS = Object.freeze([
  "SETTLEMENT_PUBLISHED_SNAPSHOTS_NOT_IMPLEMENTED",
  "BUSINESS_PERIOD_NOT_RESOLVED",
  "LEDGER_SOURCE_CHAIN_NOT_VERIFIED",
] as const);

export type LedgerDerivedViewCoverageGap = typeof LEDGER_DERIVED_VIEW_COVERAGE_GAPS[number];

export type LedgerDerivedViewMetadata = Readonly<{
  mode: "DERIVED_POSTED_LEDGER_VIEW";
  complete: false;
  spoolId: string;
  snapshotId: string;
  asOf: string;
  coverageGaps: readonly LedgerDerivedViewCoverageGap[];
  /** Count of preserved source anomalies found while deriving this view. */
  anomalyCount: string;
  /** Monthly groups that cannot safely publish a signed subtotal. */
  invalidMonthlyRowCount: string;
  /** This view does not validate business provenance or a published settlement snapshot. */
  sourceValidation: "LEDGER_EVENT_AND_ACCOUNT_REFERENCE_ONLY";
}>;

export type LedgerDerivedEntry = Readonly<{
  sourceRecordKey: string;
  sourceRowNumber: string;
  entryId: TextValue;
  eventId: TextValue;
  accountId: TextValue;
  categoryKey: TextValue;
  /** Exact exported text; never converted through Number. */
  amountCents: TextValue;
  /** Retained source value. It is never used to select posting month or fiscal year. */
  entryCreatedAt: TextValue;
  eventSourceRecordKey: TextValue;
  /** Export-safe transformed event idempotency key, never the original event_key. */
  eventKeyFingerprint: TextValue;
  eventType: TextValue;
  eventPayloadHash: TextValue;
  eventCreatedAt: TextValue;
  accountSourceRecordKey: TextValue;
  accountOwnerType: TextValue;
  accountOwnerId: TextValue;
  accountCode: TextValue;
  accountStatus: TextValue;
  /** Asia/Shanghai calendar month derived only from ledger_event.created_at. */
  postMonth: TextValue;
  /** September 1 Asia/Shanghai fiscal-year start derived only from ledger_event.created_at. */
  fiscalYearStart: TextValue;
  sourceChainStatus: "RESOLVED_UNVERIFIED" | "EVENT_UNRESOLVED" | "ACCOUNT_UNRESOLVED" | "EVENT_AND_ACCOUNT_UNRESOLVED";
}>;

export type LedgerDerivedMonthlyRow = Readonly<{
  accountId: string;
  postMonth: string;
  fiscalYearStart: string;
  categoryKey: string;
  /** Null when any source amount in this exact group is invalid text. */
  signedNetCents: TextValue;
  entryCount: string;
  invalidAmountCount: string;
  status: "VALID" | "AMOUNT_INVALID";
}>;

export type LedgerDerivedReconciliationRow = Readonly<{
  accountId: string;
  accountSourceRecordKey: TextValue;
  accountOwnerType: TextValue;
  accountOwnerId: TextValue;
  accountCode: TextValue;
  /** Null means one or more source amounts for this account were not integer text. */
  ledgerNetCents: TextValue;
  projectionBalanceCents: TextValue;
  status: "MATCH" | "MISMATCH" | "MISSING_PROJECTION" | "PROJECTION_INVALID" | "LEDGER_TOTAL_INVALID" | "ACCOUNT_UNRESOLVED";
}>;

export type LedgerDerivedAnomaly = Readonly<{
  code:
    | "LEDGER_ENTRY_AMOUNT_INVALID"
    | "LEDGER_ENTRY_CATEGORY_UNRESOLVED"
    | "LEDGER_EVENT_UNRESOLVED"
    | "LEDGER_EVENT_TIMESTAMP_INVALID"
    | "LEDGER_ACCOUNT_UNRESOLVED"
    | "ACCOUNT_PROJECTION_AMOUNT_INVALID"
    | "ACCOUNT_PROJECTION_ACCOUNT_UNRESOLVED";
  sourceTable: "ledger_entry" | "account_balance_projection";
  sourceRecordKey: string;
  sourceRowNumber: string;
  field: "amount_cents" | "category_key" | "event_id" | "event_created_at" | "account_id" | "balance_cents";
}>;

export type FullBackupLedgerDerivedViewOptions = Readonly<{
  /** An already-built bounded index over a complete immutable RAW spool. It remains caller-owned. */
  index: FullBackupDerivedSpoolIndex;
  /** Parent for this view's own 0700 temporary SQLite attempt only. */
  attemptRoot: string;
}>;

const SQLITE_MAX_INTEGER = 9_223_372_036_854_775_807n;
const fail = (code: string): never => { throw new Error(code); };
const integerText = (value: TextValue): value is string => value !== null && /^-?(?:0|[1-9]\d*)$/.test(value);
const text = (row: Readonly<Record<string, unknown>>, name: string): TextValue => {
  const value = row[name];
  return value === null || typeof value === "string" ? value : fail("EXPORT_LEDGER_DERIVED_STORAGE_INVALID");
};
const integer = (row: Readonly<Record<string, unknown>>, name: string): bigint => {
  const value = row[name];
  if (typeof value !== "bigint" || value < 0n || value > SQLITE_MAX_INTEGER) fail("EXPORT_LEDGER_DERIVED_STORAGE_INVALID");
  return value as bigint;
};
const requiredColumn = (row: DerivedSpoolIndexRow, column: string): TextValue => {
  if (row.tableName !== "ledger_entry" && row.tableName !== "ledger_event" && row.tableName !== "settlement_account" && row.tableName !== "account_balance_projection")
    fail("EXPORT_LEDGER_DERIVED_SOURCE_SCHEMA_INVALID");
  const columnsForTable = fullBackupOutputColumns(row.tableName);
  const index = columnsForTable.indexOf(column);
  if (index < 0 || row.values.length !== columnsForTable.length) fail("EXPORT_LEDGER_DERIVED_SOURCE_SCHEMA_INVALID");
  return row.values[index]!;
};

const nodeVersionSupportsSqlite = (): boolean => {
  const matched = /^(\d+)\.(\d+)\.(\d+)$/.exec(process.versions.node);
  if (matched === null) return false;
  const major = Number(matched[1]);
  const minor = Number(matched[2]);
  return major > 22 || (major === 22 && minor >= 16);
};

const sqliteConstructor = async (): Promise<SqliteConstructor> => {
  if (!nodeVersionSupportsSqlite()) fail("EXPORT_LEDGER_DERIVED_SQLITE_RUNTIME_UNAVAILABLE");
  try {
    const runtime = await import("node:sqlite");
    if (typeof runtime.DatabaseSync !== "function") fail("EXPORT_LEDGER_DERIVED_SQLITE_RUNTIME_UNAVAILABLE");
    return runtime.DatabaseSync;
  } catch (error) {
    if (error instanceof Error && error.message === "EXPORT_LEDGER_DERIVED_SQLITE_RUNTIME_UNAVAILABLE") throw error;
    return fail("EXPORT_LEDGER_DERIVED_SQLITE_RUNTIME_UNAVAILABLE");
  }
};

const assertSqliteCapabilities = (database: SqliteDatabase): void => {
  const statement = database.prepare("SELECT 1 AS value");
  if (typeof statement.iterate !== "function" || typeof statement.setReadBigInts !== "function")
    fail("EXPORT_LEDGER_DERIVED_SQLITE_RUNTIME_UNAVAILABLE");
  statement.setReadBigInts(true);
  if (statement.get()?.value !== 1n) fail("EXPORT_LEDGER_DERIVED_SQLITE_RUNTIME_UNAVAILABLE");
};

const prepareAttemptRoot = async (attemptRoot: string): Promise<void> => {
  try {
    const existing = await lstat(attemptRoot);
    if (!existing.isDirectory() || existing.isSymbolicLink()) fail("EXPORT_LEDGER_DERIVED_ATTEMPT_ROOT_INVALID");
  } catch (error) {
    if (error instanceof Error && error.message === "EXPORT_LEDGER_DERIVED_ATTEMPT_ROOT_INVALID") throw error;
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    await mkdir(attemptRoot, { recursive: true, mode: 0o700 });
  }
  const confirmed = await lstat(attemptRoot);
  if (!confirmed.isDirectory() || confirmed.isSymbolicLink()) fail("EXPORT_LEDGER_DERIVED_ATTEMPT_ROOT_INVALID");
};

const postingPeriod = (eventCreatedAt: TextValue): Readonly<{ postMonth: string; fiscalYearStart: string }> | undefined => {
  if (eventCreatedAt === null) return undefined;
  // PostgreSQL timestamptz::text always has an explicit offset. Never let a
  // host-local parser choose a zone for legacy/corrupt raw text.
  const parts = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.exec(eventCreatedAt);
  if (parts === null) return undefined;
  const sourceYear = Number(parts[1]);
  const sourceMonth = Number(parts[2]);
  const sourceDay = Number(parts[3]);
  if (sourceYear < 1 || sourceMonth < 1 || sourceMonth > 12
    || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59) return undefined;
  const leapYear = sourceYear % 4 === 0 && (sourceYear % 100 !== 0 || sourceYear % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][sourceMonth - 1]!;
  // Date silently normalizes February 30 and 24:00; a derived report must not
  // manufacture a posting date from malformed stored text.
  if (sourceDay < 1 || sourceDay > daysInMonth) return undefined;
  const instant = new Date(eventCreatedAt);
  if (!Number.isFinite(instant.getTime())) return undefined;
  // Asia/Shanghai has no daylight-savings transition in the supported finance calendar.
  const local = new Date(instant.getTime() + 8 * 60 * 60 * 1000);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth() + 1;
  const postingYear = String(year).padStart(4, "0");
  const postingMonth = `${postingYear}-${String(month).padStart(2, "0")}-01`;
  const fiscalYear = year - (month < 9 ? 1 : 0);
  return Object.freeze({ postMonth: postingMonth, fiscalYearStart: `${String(fiscalYear).padStart(4, "0")}-09-01` });
};

const status = (eventResolved: boolean, accountResolved: boolean): LedgerDerivedEntry["sourceChainStatus"] =>
  eventResolved && accountResolved ? "RESOLVED_UNVERIFIED"
    : eventResolved ? "ACCOUNT_UNRESOLVED"
      : accountResolved ? "EVENT_UNRESOLVED" : "EVENT_AND_ACCOUNT_UNRESOLVED";

type StoredEntry = Readonly<Record<string, unknown>>;

/**
 * A bounded, source-only ledger projection. It deliberately does not infer a
 * teaching/settlement business month from entries, event types, or creation time.
 */
export class FullBackupLedgerDerivedView {
  private closePromise: Promise<void> | undefined;
  private closed = false;
  private readonly activeIteratorClosers = new Set<() => void>();

  private constructor(
    private database: SqliteDatabase | undefined,
    private readonly directory: string,
    private readonly result: LedgerDerivedViewMetadata,
  ) {}

  public static async create(options: FullBackupLedgerDerivedViewOptions): Promise<FullBackupLedgerDerivedView> {
    const indexMetadata = options.index.metadata();
    const Constructor = await sqliteConstructor();
    await prepareAttemptRoot(options.attemptRoot);
    let directory: string | undefined;
    let database: SqliteDatabase | undefined;
    try {
      directory = await mkdtemp(join(options.attemptRoot, "full-backup-ledger-derived-"));
      await chmod(directory, 0o700);
      const path = join(directory, "ledger-derived.sqlite");
      await writeFile(path, "", { flag: "wx", mode: 0o600 });
      database = new Constructor(path, { enableForeignKeyConstraints: true, allowExtension: false });
      await chmod(path, 0o600);
      assertSqliteCapabilities(database);
      database.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
        CREATE TABLE raw_entry(ordinal INTEGER PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, entry_id TEXT, event_id TEXT, account_id TEXT, category_key TEXT, amount_cents TEXT, entry_created_at TEXT);
        CREATE TABLE entry_fact(ordinal INTEGER PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, entry_id TEXT, event_id TEXT, account_id TEXT, category_key TEXT, amount_cents TEXT, entry_created_at TEXT, event_source_key TEXT, event_key_fingerprint TEXT, event_type TEXT, event_payload_hash TEXT, event_created_at TEXT, account_source_key TEXT, account_owner_type TEXT, account_owner_id TEXT, account_code TEXT, account_status TEXT, post_month TEXT, fiscal_year_start TEXT, source_chain_status TEXT NOT NULL);
        CREATE TABLE account_fact(account_id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, ordinal INTEGER NOT NULL, owner_type TEXT, owner_id TEXT, account_code TEXT, status TEXT);
        CREATE TABLE projection_fact(account_id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, ordinal INTEGER NOT NULL, balance_cents TEXT, account_source_key TEXT, account_owner_type TEXT, account_owner_id TEXT, account_code TEXT, amount_valid INTEGER NOT NULL);
        CREATE TABLE monthly_aggregate(account_id TEXT NOT NULL, post_month TEXT NOT NULL, fiscal_year_start TEXT NOT NULL, category_key TEXT NOT NULL, signed_net_cents TEXT, entry_count TEXT NOT NULL, invalid_amount_count TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(account_id, post_month, fiscal_year_start, category_key));
        CREATE TABLE account_sum(account_id TEXT PRIMARY KEY, signed_net_cents TEXT, amount_valid INTEGER NOT NULL);
        CREATE TABLE reconciliation(account_id TEXT PRIMARY KEY, account_source_key TEXT, account_owner_type TEXT, account_owner_id TEXT, account_code TEXT, ledger_net_cents TEXT, projection_balance_cents TEXT, status TEXT NOT NULL);
        CREATE TABLE anomaly(ordinal INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, source_table TEXT NOT NULL, source_key TEXT NOT NULL, source_row_number TEXT NOT NULL, field TEXT NOT NULL);`);

      database.exec("BEGIN IMMEDIATE");
      try {
        await materializeRawEntries(database, options.index);
        await materializeEntries(database, options.index);
        await materializeAccounts(database, options.index);
        await materializeProjections(database, options.index);
        materializeAggregates(database);
        materializeReconciliations(database);
        database.exec("COMMIT");
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* preserve the derivation failure */ }
        throw error;
      }
      await chmod(path, 0o600);
      const metadata: LedgerDerivedViewMetadata = Object.freeze({
        mode: "DERIVED_POSTED_LEDGER_VIEW",
        complete: false,
        spoolId: indexMetadata.spoolId,
        snapshotId: indexMetadata.snapshotId,
        asOf: indexMetadata.asOf,
        coverageGaps: LEDGER_DERIVED_VIEW_COVERAGE_GAPS,
        anomalyCount: countRows(database, "anomaly"),
        invalidMonthlyRowCount: countRows(database, "monthly_aggregate WHERE status='AMOUNT_INVALID'"),
        sourceValidation: "LEDGER_EVENT_AND_ACCOUNT_REFERENCE_ONLY",
      });
      return new FullBackupLedgerDerivedView(database, directory, metadata);
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try { database?.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      if (directory !== undefined) {
        try { await rm(directory, { recursive: true, force: true }); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      }
      if (cleanupErrors.length > 0)
        throw new AggregateError([error, ...cleanupErrors], "EXPORT_LEDGER_DERIVED_CREATE_CLEANUP_FAILED", { cause: error });
      throw error;
    }
  }

  public metadata(): LedgerDerivedViewMetadata { return this.result; }

  public async *streamEntries(): AsyncGenerator<LedgerDerivedEntry> {
    const database = this.openDatabase();
    const statement = database.prepare("SELECT * FROM entry_fact ORDER BY ordinal");
    statement.setReadBigInts(true);
    const iterator = statement.iterate()[Symbol.iterator]();
    const closeIterator = this.registerIterator(iterator);
    try {
      for (;;) {
        if (this.closed) fail("EXPORT_LEDGER_DERIVED_CLOSED");
        const next = iterator.next();
        if (next.done) break;
        const row = next.value as StoredEntry;
        const eventResolved = text(row, "event_source_key") !== null;
        const accountResolved = text(row, "account_source_key") !== null;
        yield Object.freeze({
          sourceRecordKey: text(row, "source_key") ?? fail("EXPORT_LEDGER_DERIVED_STORAGE_INVALID"),
          sourceRowNumber: integer(row, "ordinal").toString(),
          entryId: text(row, "entry_id"), eventId: text(row, "event_id"), accountId: text(row, "account_id"),
          categoryKey: text(row, "category_key"), amountCents: text(row, "amount_cents"), entryCreatedAt: text(row, "entry_created_at"),
          eventSourceRecordKey: text(row, "event_source_key"), eventKeyFingerprint: text(row, "event_key_fingerprint"), eventType: text(row, "event_type"),
          eventPayloadHash: text(row, "event_payload_hash"), eventCreatedAt: text(row, "event_created_at"),
          accountSourceRecordKey: text(row, "account_source_key"), accountOwnerType: text(row, "account_owner_type"),
          accountOwnerId: text(row, "account_owner_id"), accountCode: text(row, "account_code"), accountStatus: text(row, "account_status"),
          postMonth: text(row, "post_month"), fiscalYearStart: text(row, "fiscal_year_start"),
          sourceChainStatus: status(eventResolved, accountResolved),
        });
      }
    } finally { closeIterator(); }
  }

  public async *streamMonthlyRows(): AsyncGenerator<LedgerDerivedMonthlyRow> {
    yield* this.streamRows("SELECT account_id,post_month,fiscal_year_start,category_key,signed_net_cents,entry_count,invalid_amount_count,status FROM monthly_aggregate ORDER BY account_id,post_month,category_key", (row) => Object.freeze({
      accountId: text(row, "account_id") ?? fail("EXPORT_LEDGER_DERIVED_STORAGE_INVALID"),
      postMonth: text(row, "post_month") ?? fail("EXPORT_LEDGER_DERIVED_STORAGE_INVALID"),
      fiscalYearStart: text(row, "fiscal_year_start") ?? fail("EXPORT_LEDGER_DERIVED_STORAGE_INVALID"),
      categoryKey: text(row, "category_key") ?? fail("EXPORT_LEDGER_DERIVED_STORAGE_INVALID"),
      signedNetCents: text(row, "signed_net_cents"),
      entryCount: text(row, "entry_count") ?? fail("EXPORT_LEDGER_DERIVED_STORAGE_INVALID"),
      invalidAmountCount: text(row, "invalid_amount_count") ?? fail("EXPORT_LEDGER_DERIVED_STORAGE_INVALID"),
      status: monthlyStatus(text(row, "status")),
    }));
  }

  public async *streamReconciliations(): AsyncGenerator<LedgerDerivedReconciliationRow> {
    yield* this.streamRows("SELECT * FROM reconciliation ORDER BY account_id", (row) => Object.freeze({
      accountId: text(row, "account_id") ?? fail("EXPORT_LEDGER_DERIVED_STORAGE_INVALID"),
      accountSourceRecordKey: text(row, "account_source_key"), accountOwnerType: text(row, "account_owner_type"),
      accountOwnerId: text(row, "account_owner_id"), accountCode: text(row, "account_code"),
      ledgerNetCents: text(row, "ledger_net_cents"),
      projectionBalanceCents: text(row, "projection_balance_cents"),
      status: reconciliationStatus(text(row, "status")),
    }));
  }

  public async *streamAnomalies(): AsyncGenerator<LedgerDerivedAnomaly> {
    yield* this.streamRows("SELECT code,source_table,source_key,source_row_number,field FROM anomaly ORDER BY ordinal", (row) => Object.freeze({
      code: anomalyCode(text(row, "code")), sourceTable: anomalyTable(text(row, "source_table")),
      sourceRecordKey: text(row, "source_key") ?? fail("EXPORT_LEDGER_DERIVED_STORAGE_INVALID"),
      sourceRowNumber: text(row, "source_row_number") ?? fail("EXPORT_LEDGER_DERIVED_STORAGE_INVALID"),
      field: anomalyField(text(row, "field")),
    }));
  }

  /** Releases only this view's private attempt. The caller continues to own the source index. */
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
      if (errors.length > 1) throw new AggregateError(errors, "EXPORT_LEDGER_DERIVED_CLOSE_FAILED", { cause: errors[0] });
    })();
    return this.closePromise;
  }

  private openDatabase(): SqliteDatabase {
    const database = this.database;
    if (this.closed) fail("EXPORT_LEDGER_DERIVED_CLOSED");
    if (database === undefined) fail("EXPORT_LEDGER_DERIVED_CLOSED");
    return database as SqliteDatabase;
  }

  private registerIterator(iterator: Iterator<unknown>): () => void {
    let active = true;
    const closeIterator = (): void => {
      if (!active) return;
      active = false;
      this.activeIteratorClosers.delete(closeIterator);
      iterator.return?.();
    };
    this.activeIteratorClosers.add(closeIterator);
    return closeIterator;
  }

  private async *streamRows<T>(sql: string, map: (row: Readonly<Record<string, unknown>>) => T): AsyncGenerator<T> {
    const database = this.openDatabase();
    const statement = database.prepare(sql);
    statement.setReadBigInts(true);
    const iterator = statement.iterate()[Symbol.iterator]();
    const closeIterator = this.registerIterator(iterator);
    try {
      for (;;) {
        if (this.closed) fail("EXPORT_LEDGER_DERIVED_CLOSED");
        const next = iterator.next();
        if (next.done) break;
        yield map(next.value as Readonly<Record<string, unknown>>);
      }
    } finally { closeIterator(); }
  }
}

const insertAnomaly = (database: SqliteDatabase, anomaly: LedgerDerivedAnomaly): void => {
  database.prepare("INSERT INTO anomaly(code,source_table,source_key,source_row_number,field) VALUES(?,?,?,?,?)")
    .run(anomaly.code, anomaly.sourceTable, anomaly.sourceRecordKey, anomaly.sourceRowNumber, anomaly.field);
};

const rawEntry = (row: DerivedSpoolIndexRow): Readonly<{ id: TextValue; eventId: TextValue; accountId: TextValue; categoryKey: TextValue; amountCents: TextValue; createdAt: TextValue }> => Object.freeze({
  id: requiredColumn(row, "id"), eventId: requiredColumn(row, "event_id"), accountId: requiredColumn(row, "account_id"),
  categoryKey: requiredColumn(row, "category_key"), amountCents: requiredColumn(row, "amount_cents"), createdAt: requiredColumn(row, "created_at"),
});

const materializeRawEntries = async (database: SqliteDatabase, index: FullBackupDerivedSpoolIndex): Promise<void> => {
  const insert = database.prepare("INSERT INTO raw_entry(ordinal,source_key,entry_id,event_id,account_id,category_key,amount_cents,entry_created_at) VALUES(?,?,?,?,?,?,?,?)");
  let count = 0n;
  for await (const row of index.stream("ledger_entry")) {
    const entry = rawEntry(row);
    count += 1n;
    if (count > SQLITE_MAX_INTEGER || row.ordinal !== count.toString()) fail("EXPORT_LEDGER_DERIVED_SOURCE_ORDER_INVALID");
    insert.run(count, row.sourceRecordKey, entry.id, entry.eventId, entry.accountId, entry.categoryKey, entry.amountCents, entry.createdAt);
  }
};

const values = (row: DerivedSpoolIndexRow): Readonly<Record<string, TextValue>> => Object.freeze({
  id: requiredColumn(row, "id"),
  event_key_fingerprint: row.tableName === "ledger_event" ? requiredColumn(row, "event_key_fingerprint") : null,
  event_type: row.tableName === "ledger_event" ? requiredColumn(row, "event_type") : null,
  payload_hash: row.tableName === "ledger_event" ? requiredColumn(row, "payload_hash") : null,
  created_at: requiredColumn(row, "created_at"),
  owner_type: row.tableName === "settlement_account" ? requiredColumn(row, "owner_type") : null,
  owner_id: row.tableName === "settlement_account" ? requiredColumn(row, "owner_id") : null,
  account_code: row.tableName === "settlement_account" ? requiredColumn(row, "account_code") : null,
  status: row.tableName === "settlement_account" ? requiredColumn(row, "status") : null,
});

const materializeEntries = async (database: SqliteDatabase, index: FullBackupDerivedSpoolIndex): Promise<void> => {
  const nextRaw = database.prepare("SELECT * FROM raw_entry WHERE ordinal=?"); nextRaw.setReadBigInts(true);
  const insert = database.prepare("INSERT INTO entry_fact(ordinal,source_key,entry_id,event_id,account_id,category_key,amount_cents,entry_created_at,event_source_key,event_key_fingerprint,event_type,event_payload_hash,event_created_at,account_source_key,account_owner_type,account_owner_id,account_code,account_status,post_month,fiscal_year_start,source_chain_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  for (let ordinal = 1n;; ordinal += 1n) {
    const stored = nextRaw.get(ordinal) as StoredEntry | undefined;
    if (stored === undefined) break;
    const sourceKey = text(stored, "source_key") ?? fail("EXPORT_LEDGER_DERIVED_STORAGE_INVALID");
    const sourceRowNumber = ordinal.toString();
    const eventId = text(stored, "event_id");
    const accountId = text(stored, "account_id");
    let event: DerivedSpoolIndexRow | undefined;
    if (eventId !== null && eventId.length > 0) event = await index.lookup("ledger_event", [["id", eventId]]);
    let account: DerivedSpoolIndexRow | undefined;
    if (accountId !== null && accountId.length > 0) account = await index.lookup("settlement_account", [["id", accountId]]);
    if (event === undefined) insertAnomaly(database, { code: "LEDGER_EVENT_UNRESOLVED", sourceTable: "ledger_entry", sourceRecordKey: sourceKey, sourceRowNumber, field: "event_id" });
    if (account === undefined) insertAnomaly(database, { code: "LEDGER_ACCOUNT_UNRESOLVED", sourceTable: "ledger_entry", sourceRecordKey: sourceKey, sourceRowNumber, field: "account_id" });
    const eventValues = event === undefined ? undefined : values(event);
    const accountValues = account === undefined ? undefined : values(account);
    const period = eventValues === undefined ? undefined : postingPeriod(eventValues.created_at ?? null);
    if (eventValues !== undefined && period === undefined)
      insertAnomaly(database, { code: "LEDGER_EVENT_TIMESTAMP_INVALID", sourceTable: "ledger_entry", sourceRecordKey: sourceKey, sourceRowNumber, field: "event_created_at" });
    const amount = text(stored, "amount_cents");
    if (!integerText(amount)) insertAnomaly(database, { code: "LEDGER_ENTRY_AMOUNT_INVALID", sourceTable: "ledger_entry", sourceRecordKey: sourceKey, sourceRowNumber, field: "amount_cents" });
    const category = text(stored, "category_key");
    if (category === null || category.length === 0) insertAnomaly(database, { code: "LEDGER_ENTRY_CATEGORY_UNRESOLVED", sourceTable: "ledger_entry", sourceRecordKey: sourceKey, sourceRowNumber, field: "category_key" });
    insert.run(ordinal, sourceKey, text(stored, "entry_id"), eventId, accountId, category, amount, text(stored, "entry_created_at"),
      event?.sourceRecordKey ?? null, eventValues?.event_key_fingerprint ?? null, eventValues?.event_type ?? null, eventValues?.payload_hash ?? null, eventValues?.created_at ?? null,
      account?.sourceRecordKey ?? null, accountValues?.owner_type ?? null, accountValues?.owner_id ?? null, accountValues?.account_code ?? null, accountValues?.status ?? null,
      period?.postMonth ?? null, period?.fiscalYearStart ?? null, status(event !== undefined, account !== undefined));
  }
};

const materializeProjections = async (database: SqliteDatabase, index: FullBackupDerivedSpoolIndex): Promise<void> => {
  const insert = database.prepare("INSERT INTO projection_fact(account_id,source_key,ordinal,balance_cents,account_source_key,account_owner_type,account_owner_id,account_code,amount_valid) VALUES(?,?,?,?,?,?,?,?,?)");
  for await (const row of index.stream("account_balance_projection")) {
    const accountId = requiredColumn(row, "account_id");
    const balance = requiredColumn(row, "balance_cents");
    if (accountId === null || accountId.length === 0) fail("EXPORT_LEDGER_DERIVED_PROJECTION_KEY_INVALID");
    const account = await index.lookup("settlement_account", [["id", accountId]]);
    const accountValues = account === undefined ? undefined : values(account);
    if (account === undefined) insertAnomaly(database, { code: "ACCOUNT_PROJECTION_ACCOUNT_UNRESOLVED", sourceTable: "account_balance_projection", sourceRecordKey: row.sourceRecordKey, sourceRowNumber: row.ordinal, field: "account_id" });
    const valid = integerText(balance);
    if (!valid) insertAnomaly(database, { code: "ACCOUNT_PROJECTION_AMOUNT_INVALID", sourceTable: "account_balance_projection", sourceRecordKey: row.sourceRecordKey, sourceRowNumber: row.ordinal, field: "balance_cents" });
    insert.run(accountId, row.sourceRecordKey, BigInt(row.ordinal), balance, account?.sourceRecordKey ?? null, accountValues?.owner_type ?? null, accountValues?.owner_id ?? null, accountValues?.account_code ?? null, valid ? 1 : 0);
  }
};

const materializeAccounts = async (database: SqliteDatabase, index: FullBackupDerivedSpoolIndex): Promise<void> => {
  const insert = database.prepare("INSERT INTO account_fact(account_id,source_key,ordinal,owner_type,owner_id,account_code,status) VALUES(?,?,?,?,?,?,?)");
  for await (const row of index.stream("settlement_account")) {
    const accountId = requiredColumn(row, "id");
    if (accountId === null || accountId.length === 0) fail("EXPORT_LEDGER_DERIVED_ACCOUNT_KEY_INVALID");
    insert.run(accountId, row.sourceRecordKey, BigInt(row.ordinal), requiredColumn(row, "owner_type"), requiredColumn(row, "owner_id"), requiredColumn(row, "account_code"), requiredColumn(row, "status"));
  }
};

const materializeAggregates = (database: SqliteDatabase): void => {
  const statement = database.prepare("SELECT account_id,post_month,fiscal_year_start,category_key,amount_cents FROM entry_fact WHERE account_id IS NOT NULL AND account_id<>'' AND post_month IS NOT NULL AND fiscal_year_start IS NOT NULL AND category_key IS NOT NULL AND category_key<>'' ORDER BY account_id,post_month,fiscal_year_start,category_key,ordinal");
  statement.setReadBigInts(true);
  const insertMonthly = database.prepare("INSERT INTO monthly_aggregate(account_id,post_month,fiscal_year_start,category_key,signed_net_cents,entry_count,invalid_amount_count,status) VALUES(?,?,?,?,?,?,?,?)");
  const allTime = database.prepare("SELECT account_id,amount_cents FROM entry_fact WHERE account_id IS NOT NULL AND account_id<>'' ORDER BY account_id,ordinal");
  allTime.setReadBigInts(true);
  const insertAccount = database.prepare("INSERT INTO account_sum(account_id,signed_net_cents,amount_valid) VALUES(?,?,?)");
  let currentMonthly: { accountId: string; postMonth: string; fiscalYearStart: string; categoryKey: string; total: bigint; count: bigint; invalidAmountCount: bigint } | undefined;
  let currentAccount: { accountId: string; total: bigint; amountValid: boolean } | undefined;
  const flushMonthly = (): void => {
    if (currentMonthly === undefined) return;
    const valid = currentMonthly.invalidAmountCount === 0n;
    insertMonthly.run(currentMonthly.accountId, currentMonthly.postMonth, currentMonthly.fiscalYearStart, currentMonthly.categoryKey,
      valid ? currentMonthly.total.toString() : null, currentMonthly.count.toString(), currentMonthly.invalidAmountCount.toString(), valid ? "VALID" : "AMOUNT_INVALID");
  };
  const flushAccount = (): void => { if (currentAccount !== undefined) insertAccount.run(currentAccount.accountId, currentAccount.amountValid ? currentAccount.total.toString() : null, currentAccount.amountValid ? 1 : 0); };
  for (const candidate of statement.iterate()) {
    const row = candidate as Readonly<Record<string, unknown>>;
    const amount = text(row, "amount_cents");
    const accountId = text(row, "account_id")!;
    const postMonth = text(row, "post_month")!;
    const fiscalYearStart = text(row, "fiscal_year_start")!;
    const categoryKey = text(row, "category_key")!;
    if (currentMonthly === undefined || currentMonthly.accountId !== accountId || currentMonthly.postMonth !== postMonth || currentMonthly.fiscalYearStart !== fiscalYearStart || currentMonthly.categoryKey !== categoryKey) {
      flushMonthly(); currentMonthly = { accountId, postMonth, fiscalYearStart, categoryKey, total: 0n, count: 0n, invalidAmountCount: 0n };
    }
    currentMonthly.count += 1n;
    if (!integerText(amount)) currentMonthly.invalidAmountCount += 1n;
    else currentMonthly.total += BigInt(amount);
  }
  flushMonthly();
  for (const candidate of allTime.iterate()) {
    const row = candidate as Readonly<Record<string, unknown>>;
    const accountId = text(row, "account_id")!;
    const amount = text(row, "amount_cents");
    if (currentAccount === undefined || currentAccount.accountId !== accountId) {
      flushAccount(); currentAccount = { accountId, total: 0n, amountValid: true };
    }
    if (!integerText(amount)) currentAccount.amountValid = false;
    else currentAccount.total += BigInt(amount);
  }
  flushAccount();
};

const materializeReconciliations = (database: SqliteDatabase): void => {
  const statement = database.prepare("SELECT account_id FROM account_fact UNION SELECT account_id FROM account_sum UNION SELECT account_id FROM projection_fact ORDER BY account_id");
  const sum = database.prepare("SELECT signed_net_cents,amount_valid FROM account_sum WHERE account_id=?");
  const projection = database.prepare("SELECT * FROM projection_fact WHERE account_id=?");
  const account = database.prepare("SELECT account_source_key,account_owner_type,account_owner_id,account_code FROM entry_fact WHERE account_id=? AND account_source_key IS NOT NULL ORDER BY ordinal LIMIT 1");
  const sourceAccount = database.prepare("SELECT source_key AS account_source_key,owner_type AS account_owner_type,owner_id AS account_owner_id,account_code FROM account_fact WHERE account_id=?");
  const insert = database.prepare("INSERT INTO reconciliation(account_id,account_source_key,account_owner_type,account_owner_id,account_code,ledger_net_cents,projection_balance_cents,status) VALUES(?,?,?,?,?,?,?,?)");
  for (const candidate of statement.iterate()) {
    const accountId = text(candidate as Readonly<Record<string, unknown>>, "account_id") ?? fail("EXPORT_LEDGER_DERIVED_STORAGE_INVALID");
    const sumRow = sum.get(accountId) as StoredEntry | undefined;
    const projectionRow = projection.get(accountId) as StoredEntry | undefined;
    const projectionAccount = projectionRow !== undefined && text(projectionRow, "account_source_key") !== null ? projectionRow : undefined;
    const sourceAccountRow = sourceAccount.get(accountId) as StoredEntry | undefined;
    const entryAccountRow = account.get(accountId) as StoredEntry | undefined;
    const accountRow = projectionAccount ?? sourceAccountRow ?? entryAccountRow;
    const net = sumRow === undefined ? "0" : text(sumRow, "signed_net_cents");
    const ledgerValid = sumRow === undefined || sumRow.amount_valid === 1n || sumRow.amount_valid === 1;
    const projectionBalance = projectionRow === undefined ? null : text(projectionRow, "balance_cents");
    const projectionValid = projectionRow !== undefined && (projectionRow.amount_valid === 1n || projectionRow.amount_valid === 1);
    const accountResolved = accountRow !== undefined && text(accountRow, "account_source_key") !== null;
    const reconciliation = !accountResolved ? "ACCOUNT_UNRESOLVED" : !ledgerValid ? "LEDGER_TOTAL_INVALID" : projectionRow === undefined ? "MISSING_PROJECTION" : !projectionValid ? "PROJECTION_INVALID" : BigInt(net!) === BigInt(projectionBalance!) ? "MATCH" : "MISMATCH";
    insert.run(accountId, accountRow === undefined ? null : text(accountRow, "account_source_key"), accountRow === undefined ? null : text(accountRow, "account_owner_type"), accountRow === undefined ? null : text(accountRow, "account_owner_id"), accountRow === undefined ? null : text(accountRow, "account_code"), net, projectionBalance, reconciliation);
  }
};

const reconciliationStatus = (value: TextValue): LedgerDerivedReconciliationRow["status"] => {
  if (value === "MATCH" || value === "MISMATCH" || value === "MISSING_PROJECTION" || value === "PROJECTION_INVALID" || value === "LEDGER_TOTAL_INVALID" || value === "ACCOUNT_UNRESOLVED") return value;
  return fail("EXPORT_LEDGER_DERIVED_STORAGE_INVALID");
};
const monthlyStatus = (value: TextValue): LedgerDerivedMonthlyRow["status"] => {
  if (value === "VALID" || value === "AMOUNT_INVALID") return value;
  return fail("EXPORT_LEDGER_DERIVED_STORAGE_INVALID");
};
const countRows = (database: SqliteDatabase, source: "anomaly" | "monthly_aggregate WHERE status='AMOUNT_INVALID'"): string => {
  const row = database.prepare(`SELECT count(*) AS count FROM ${source}`).get() as Readonly<Record<string, unknown>> | undefined;
  const confirmed = row ?? fail("EXPORT_LEDGER_DERIVED_STORAGE_INVALID");
  const count = confirmed.count;
  if (typeof count === "bigint" && count >= 0n) return count.toString();
  if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) return String(count);
  return fail("EXPORT_LEDGER_DERIVED_STORAGE_INVALID");
};
const anomalyCode = (value: TextValue): LedgerDerivedAnomaly["code"] => {
  if (value === "LEDGER_ENTRY_AMOUNT_INVALID" || value === "LEDGER_ENTRY_CATEGORY_UNRESOLVED" || value === "LEDGER_EVENT_UNRESOLVED" || value === "LEDGER_EVENT_TIMESTAMP_INVALID" || value === "LEDGER_ACCOUNT_UNRESOLVED" || value === "ACCOUNT_PROJECTION_AMOUNT_INVALID" || value === "ACCOUNT_PROJECTION_ACCOUNT_UNRESOLVED") return value;
  return fail("EXPORT_LEDGER_DERIVED_STORAGE_INVALID");
};
const anomalyTable = (value: TextValue): LedgerDerivedAnomaly["sourceTable"] => {
  if (value === "ledger_entry" || value === "account_balance_projection") return value;
  return fail("EXPORT_LEDGER_DERIVED_STORAGE_INVALID");
};
const anomalyField = (value: TextValue): LedgerDerivedAnomaly["field"] => {
  if (value === "amount_cents" || value === "category_key" || value === "event_id" || value === "event_created_at" || value === "account_id" || value === "balance_cents") return value;
  return fail("EXPORT_LEDGER_DERIVED_STORAGE_INVALID");
};
