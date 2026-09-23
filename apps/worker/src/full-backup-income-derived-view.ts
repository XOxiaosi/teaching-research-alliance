import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FullBackupDerivedSpoolIndex, type DerivedSpoolIndexRow } from "./full-backup-derived-spool-index.js";
import { fullBackupOutputColumns } from "./full-backup-transformer.js";

type TextValue = string | null;
type SqliteDatabase = InstanceType<typeof import("node:sqlite").DatabaseSync>;
type SqliteConstructor = typeof import("node:sqlite").DatabaseSync;
type SqliteStatement = ReturnType<SqliteDatabase["prepare"]>;

type AllocationKey = "referrer" | "planningMentor" | "groupLeader" | "teachingMentor" | "venue" | "campusConsultation" | "platformFinance" | "regionFinance" | "teachingTeacher";
const ALLOCATION_KEYS: readonly AllocationKey[] = Object.freeze(["referrer", "planningMentor", "groupLeader", "teachingMentor", "venue", "campusConsultation", "platformFinance", "regionFinance", "teachingTeacher"]);
const INTEGER = /^-?\d+$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])-01$/;
const SQLITE_MAX_INTEGER = 9_223_372_036_854_775_807n;

export type IncomeDerivedAnomaly = Readonly<{
  code: string;
  sourceTable: string;
  sourceRecordKey: string;
  feeEntryId: string | null;
}>;

export type FullBackupIncomeDerivedViewOptions = Readonly<{
  index: FullBackupDerivedSpoolIndex;
  /** Parent only for a new, disposable private derived-view attempt. */
  attemptRoot: string;
}>;

export type IncomeDerivedMonthlyRow = Readonly<{
  accountId: string;
  ownerType: "PERSON" | "COMPANY" | "VENUE";
  ownerId: string;
  accountCode: string;
  settlementMonth: string;
  /** Asia/Shanghai fiscal-year label, derived only from the locked settlement month. */
  financeYear: string;
  allocationKey: AllocationKey;
  positiveCents: bigint;
  refundCents: bigint;
  netCents: bigint;
  contributionCount: string;
}>;

export type IncomeDerivedContributionKey = Readonly<{
  accountId: string;
  settlementMonth: string;
  allocationKey: AllocationKey;
}>;

export type IncomeDerivedContribution = Readonly<IncomeDerivedContributionKey & {
  signedCents: bigint;
  feeEntryId: string;
  feeVersion: string;
  allocationSnapshotId: string;
  allocationSnapshotSourceKey: string;
  settlementRunId: string;
  policyVersionId: string;
  refundFinanceDocumentId: string | null;
  refundEffectSourceKey: string | null;
}>;

export type IncomeDerivedMetadata = Readonly<{
  mode: "INCOME_DERIVED_VIEW";
  complete: false;
  tableNumber: 3;
  /** PARTIAL never represents a complete table-3 income result. */
  status: "DERIVED_UNPUBLISHED" | "PARTIAL";
  spoolId: string;
  snapshotId: string;
  asOf: string;
  publishedVersion: null;
  gaps: readonly ["SETTLEMENT_PUBLISHED_SNAPSHOTS_NOT_IMPLEMENTED"];
  anomalyCount: string;
  incompleteFeeCount: string;
  /** Counts from the frozen full RAW index, not a publication/version identifier. */
  sourceBasis: Readonly<{
    indexMode: "DERIVED_SPOOL_INDEX";
    sourceRows: readonly Readonly<{ tableName: string; rowCount: string }>[];
    contributionDigest: string;
  }>;
}>;

const fail = (code: string): never => { throw new Error(code); };
const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string => typeof value === "string" ? value : fail("EXPORT_INCOME_DERIVED_VALUE_INVALID");
const canonical = (value: unknown): string => JSON.stringify(value);

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

const assertSqliteCapabilities = (database: SqliteDatabase): void => {
  const statement = database.prepare("SELECT 1 AS value");
  if (typeof statement.iterate !== "function" || typeof statement.setReadBigInts !== "function")
    fail("EXPORT_DERIVED_SQLITE_RUNTIME_UNAVAILABLE");
  statement.setReadBigInts(true);
  if (statement.get()?.value !== 1n) fail("EXPORT_DERIVED_SQLITE_RUNTIME_UNAVAILABLE");
};

const prepareAttemptRoot = async (attemptRoot: string): Promise<void> => {
  try {
    const existing = await lstat(attemptRoot);
    if (!existing.isDirectory() || existing.isSymbolicLink()) fail("EXPORT_INCOME_DERIVED_ATTEMPT_ROOT_INVALID");
  } catch (error) {
    if (error instanceof Error && error.message === "EXPORT_INCOME_DERIVED_ATTEMPT_ROOT_INVALID") throw error;
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    await mkdir(attemptRoot, { recursive: true, mode: 0o700 });
  }
  const confirmed = await lstat(attemptRoot);
  if (!confirmed.isDirectory() || confirmed.isSymbolicLink()) fail("EXPORT_INCOME_DERIVED_ATTEMPT_ROOT_INVALID");
};

const valuesByColumn = (tableName: string, row: DerivedSpoolIndexRow): Readonly<Record<string, TextValue>> => {
  const columns = fullBackupOutputColumns(tableName);
  if (row.values.length !== columns.length) fail("EXPORT_INCOME_DERIVED_INDEX_ROW_INVALID");
  return Object.freeze(Object.fromEntries(columns.map((column, index) => [column, row.values[index]!])));
};

const required = (values: Readonly<Record<string, TextValue>>, column: string): string => {
  const value = values[column];
  if (value === null || value === undefined || value === "") fail("EXPORT_INCOME_DERIVED_VALUE_INVALID");
  return value as string;
};

const nonnegativeCents = (value: string): bigint => {
  if (!/^\d+$/.test(value)) fail("EXPORT_INCOME_DERIVED_VALUE_INVALID");
  return BigInt(value);
};

const signedCents = (value: string): bigint => {
  if (!INTEGER.test(value)) fail("EXPORT_INCOME_DERIVED_VALUE_INVALID");
  return BigInt(value);
};

const sequence = (value: string): bigint => {
  if (!POSITIVE_INTEGER.test(value)) fail("EXPORT_INCOME_DERIVED_VALUE_INVALID");
  const parsed = BigInt(value);
  if (parsed > SQLITE_MAX_INTEGER) fail("EXPORT_INCOME_DERIVED_SEQUENCE_RANGE");
  return parsed;
};

const month = (value: string): string => {
  if (!MONTH.test(value)) fail("EXPORT_INCOME_DERIVED_VALUE_INVALID");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail("EXPORT_INCOME_DERIVED_VALUE_INVALID");
  return value;
};

/** Matches financeYearBounds: fiscal years start 1 September in Asia/Shanghai. */
const financeYearForMonth = (settlementMonth: string): string => {
  const validated = month(settlementMonth);
  const calendarYear = Number(validated.slice(0, 4));
  const fiscalStart = Number(validated.slice(5, 7)) < 9 ? calendarYear - 1 : calendarYear;
  return `${fiscalStart}-${fiscalStart + 1}`;
};

const allocationKey = (value: unknown): AllocationKey => {
  if (typeof value !== "string" || !(ALLOCATION_KEYS as readonly string[]).includes(value)) fail("EXPORT_INCOME_DERIVED_SNAPSHOT_INVALID");
  return value as AllocationKey;
};

type DecodedLine = Readonly<{ key: AllocationKey; cents: bigint; accountId: string | null; accountOwnerType: string | null; accountOwnerId: string | null; accountCode: string | null }>;

const decodeFrozenSnapshot = (snapshotJson: string, contextJson: string, gross: bigint, feeId: string, feeVersion: string, settlementMonth: string): readonly DecodedLine[] => {
  let snapshot: unknown;
  let context: unknown;
  try { snapshot = JSON.parse(snapshotJson); context = JSON.parse(contextJson); }
  catch { return fail("EXPORT_INCOME_DERIVED_SNAPSHOT_INVALID"); }
  if (!isObject(snapshot) || !isObject(context)) fail("EXPORT_INCOME_DERIVED_SNAPSHOT_INVALID");
  const snapshotObject = snapshot as Readonly<Record<string, unknown>>;
  const contextObject = context as Readonly<Record<string, unknown>>;
  if (contextObject.feeEntryId !== feeId || String(contextObject.feeVersion) !== feeVersion || contextObject.settlementMonth !== settlementMonth)
    fail("EXPORT_INCOME_DERIVED_SNAPSHOT_INVALID");
  if (!Array.isArray(snapshotObject.lines) || !isObject(snapshotObject.accountByKey) || !isObject(contextObject.accounts) || snapshotObject.lines.length !== ALLOCATION_KEYS.length)
    fail("EXPORT_INCOME_DERIVED_SNAPSHOT_INVALID");
  const snapshotLines = snapshotObject.lines as readonly unknown[];
  const snapshotAccounts = snapshotObject.accountByKey as Readonly<Record<string, unknown>>;
  const contextAccounts = contextObject.accounts as Readonly<Record<string, unknown>>;
  const seen = new Set<AllocationKey>();
  const decoded: readonly DecodedLine[] = snapshotLines.map((raw: unknown): DecodedLine => {
    if (!isObject(raw)) fail("EXPORT_INCOME_DERIVED_SNAPSHOT_INVALID");
    const lineObject = raw as Readonly<Record<string, unknown>>;
    const key = allocationKey(lineObject.key);
    if (seen.has(key)) fail("EXPORT_INCOME_DERIVED_SNAPSHOT_INVALID");
    seen.add(key);
    const cents = nonnegativeCents(text(lineObject.cents));
    if (cents === 0n) return Object.freeze({ key, cents, accountId: null, accountOwnerType: null, accountOwnerId: null, accountCode: null });
    const snapshotCode = snapshotAccounts[key];
    const account = contextAccounts[key];
    if (typeof snapshotCode !== "string" || !isObject(account) || account.accountCode !== snapshotCode
      || typeof account.accountId !== "string" || typeof account.ownerType !== "string" || typeof account.ownerId !== "string"
      || !["PERSON", "COMPANY", "VENUE"].includes(account.ownerType)) fail("EXPORT_INCOME_DERIVED_SNAPSHOT_INVALID");
    const accountObject = account as Readonly<Record<string, unknown>>;
    return Object.freeze({ key, cents, accountId: accountObject.accountId as string, accountOwnerType: accountObject.ownerType as string, accountOwnerId: accountObject.ownerId as string, accountCode: snapshotCode as string });
  });
  if (seen.size !== ALLOCATION_KEYS.length || ALLOCATION_KEYS.some((key) => !seen.has(key)) || decoded.reduce((sum: bigint, line: DecodedLine) => sum + line.cents, 0n) !== gross)
    fail("EXPORT_INCOME_DERIVED_SNAPSHOT_INVALID");
  return Object.freeze(decoded);
};

/** The refund decision is document-scoped, so this is intentionally derived
 * from every frozen effect on that document rather than from one fee alone. */
const frozenSnapshotHasNonzeroLine = (snapshotJson: string): boolean => {
  let snapshot: unknown;
  try { snapshot = JSON.parse(snapshotJson); } catch { return fail("EXPORT_INCOME_DERIVED_SNAPSHOT_INVALID"); }
  if (!isObject(snapshot) || !Array.isArray(snapshot.lines) || snapshot.lines.length !== ALLOCATION_KEYS.length)
    fail("EXPORT_INCOME_DERIVED_SNAPSHOT_INVALID");
  const snapshotObject = snapshot as Readonly<Record<string, unknown>>;
  const seen = new Set<AllocationKey>();
  let hasNonzero = false;
  for (const raw of snapshotObject.lines as readonly unknown[]) {
    if (!isObject(raw)) fail("EXPORT_INCOME_DERIVED_SNAPSHOT_INVALID");
    const line = raw as Readonly<Record<string, unknown>>;
    const key = allocationKey(line.key);
    if (seen.has(key)) fail("EXPORT_INCOME_DERIVED_SNAPSHOT_INVALID");
    seen.add(key);
    if (nonnegativeCents(text(line.cents)) !== 0n) hasNonzero = true;
  }
  if (seen.size !== ALLOCATION_KEYS.length || ALLOCATION_KEYS.some((key) => !seen.has(key)))
    fail("EXPORT_INCOME_DERIVED_SNAPSHOT_INVALID");
  return hasNonzero;
};

const sourceTables = Object.freeze([
  "settlement_account", "weekly_fee_entry", "weekly_fee_entry_version", "weekly_fee_allocation_snapshot",
  "finance_document", "finance_refund_decision", "finance_refund_submission_item", "weekly_fee_refund_effect",
  "ledger_event", "ledger_entry",
]);

type StoredRow = Readonly<Record<string, unknown>>;

const storedText = (row: StoredRow, name: string): string => typeof row[name] === "string" ? row[name] as string : fail("EXPORT_INCOME_DERIVED_STORE_INVALID");
const storedBigint = (row: StoredRow, name: string): bigint => typeof row[name] === "bigint" ? row[name] as bigint : fail("EXPORT_INCOME_DERIVED_STORE_INVALID");
const storedCount = (row: StoredRow, name: string): string => {
  const value = row[name];
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  return fail("EXPORT_INCOME_DERIVED_STORE_INVALID");
};

/**
 * Table-3 derivation over a previously verified private index. It never revisits
 * PostgreSQL, recomputes allocation policy, creates a publication, or writes XLSX.
 */
export class FullBackupIncomeDerivedView {
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private readonly activeIteratorClosers = new Set<() => void>();

  private constructor(
    private database: SqliteDatabase | undefined,
    private readonly directory: string,
    private readonly result: IncomeDerivedMetadata,
  ) {}

  public static async create(options: FullBackupIncomeDerivedViewOptions): Promise<FullBackupIncomeDerivedView> {
    const indexMetadata = options.index.metadata();
    const Constructor = await sqliteConstructor();
    await prepareAttemptRoot(options.attemptRoot);
    let directory: string | undefined;
    let database: SqliteDatabase | undefined;
    let insertAnomaly: SqliteStatement | undefined;
    let insertIncompleteFee: SqliteStatement | undefined;
    const issue = (code: string, sourceTable: string, sourceRecordKey: string, feeId: string | null = null): void => {
      insertAnomaly?.run(code, sourceTable, sourceRecordKey, feeId);
      if (feeId !== null) insertIncompleteFee?.run(feeId);
    };
    const read = async (
      tableName: string,
      work: (values: Readonly<Record<string, TextValue>>, row: DerivedSpoolIndexRow) => void,
      onInvalid?: (values: Readonly<Record<string, TextValue>>, row: DerivedSpoolIndexRow) => void,
    ): Promise<void> => {
      for await (const row of options.index.stream(tableName)) {
        const values = valuesByColumn(tableName, row);
        let sourceError: unknown;
        database!.exec("SAVEPOINT income_source_row");
        try {
          work(values, row);
          database!.exec("RELEASE SAVEPOINT income_source_row");
        } catch (error) {
          sourceError = error;
          try { database!.exec("ROLLBACK TO SAVEPOINT income_source_row"); database!.exec("RELEASE SAVEPOINT income_source_row"); }
          catch { /* the source error remains authoritative */ }
        }
        if (sourceError !== undefined) {
          try { onInvalid?.(values, row); }
          catch (markerError) { throw new AggregateError([sourceError, markerError], "EXPORT_INCOME_DERIVED_SOURCE_MARKER_FAILED", { cause: sourceError }); }
          const feeColumn = tableName === "weekly_fee_entry" ? "id" : ["weekly_fee_entry_version", "weekly_fee_allocation_snapshot", "finance_refund_submission_item", "weekly_fee_refund_effect"].includes(tableName) ? "weekly_fee_entry_id" : undefined;
          const candidateFeeId = feeColumn === undefined ? null : values[feeColumn] ?? null;
          issue("SOURCE_ROW_INVALID", tableName, row.sourceRecordKey, candidateFeeId);
        }
      }
    };
    try {
      directory = await mkdtemp(join(options.attemptRoot, "full-backup-income-derived-"));
      await chmod(directory, 0o700);
      const databasePath = join(directory, "income-derived.sqlite");
      await writeFile(databasePath, "", { flag: "wx", mode: 0o600 });
      database = new Constructor(databasePath, { enableForeignKeyConstraints: true, allowExtension: false });
      assertSqliteCapabilities(database);
      database.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
        CREATE TABLE account_fact(account_id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, account_code TEXT NOT NULL);
        CREATE TABLE fee_current(fee_id TEXT PRIMARY KEY, version TEXT NOT NULL, settlement_month TEXT NOT NULL, gross_cents TEXT NOT NULL, source_key TEXT NOT NULL);
        CREATE TABLE fee_version(fee_id TEXT NOT NULL, version TEXT NOT NULL, settlement_month TEXT NOT NULL, gross_cents TEXT NOT NULL, source_key TEXT NOT NULL, PRIMARY KEY(fee_id,version));
        CREATE TABLE latest_snapshot(fee_id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, sequence_no INTEGER NOT NULL, run_id TEXT NOT NULL, source_version TEXT NOT NULL, policy_version_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, context_json TEXT NOT NULL, source_key TEXT NOT NULL);
        CREATE TABLE refund_document(document_id TEXT PRIMARY KEY, document_version TEXT NOT NULL, status TEXT NOT NULL, source_key TEXT NOT NULL, decision TEXT, posting_status TEXT, ledger_event_id TEXT, approved_gross_cents TEXT, decision_source_key TEXT);
        CREATE TABLE refund_item(document_id TEXT NOT NULL, fee_id TEXT NOT NULL, fee_version TEXT NOT NULL, gross_cents TEXT NOT NULL, settlement_month TEXT NOT NULL, source_key TEXT NOT NULL, PRIMARY KEY(document_id,fee_id));
        CREATE TABLE refund_effect(fee_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, source_version TEXT NOT NULL, gross_cents TEXT NOT NULL, snapshot_json TEXT NOT NULL, source_key TEXT NOT NULL);
        CREATE TABLE refund_document_effect_summary(document_id TEXT PRIMARY KEY, effect_count INTEGER NOT NULL, nonzero_effect_count INTEGER NOT NULL);
        CREATE TABLE refund_document_fee(document_id TEXT NOT NULL, fee_id TEXT NOT NULL, PRIMARY KEY(document_id,fee_id));
        CREATE TABLE refund_document_invalid(document_id TEXT PRIMARY KEY, code TEXT NOT NULL, source_table TEXT NOT NULL, source_record_key TEXT NOT NULL);
        CREATE TABLE expected_refund_ledger(event_id TEXT NOT NULL, account_id TEXT NOT NULL, category_key TEXT NOT NULL, amount_cents TEXT NOT NULL, PRIMARY KEY(event_id,account_id,category_key));
        CREATE TABLE actual_refund_ledger(event_id TEXT NOT NULL, account_id TEXT NOT NULL, category_key TEXT NOT NULL, amount_cents TEXT NOT NULL, PRIMARY KEY(event_id,account_id,category_key));
        CREATE TABLE refund_event(event_id TEXT PRIMARY KEY);
        CREATE TABLE refund_fee_event(fee_id TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(fee_id,event_id));
        CREATE TABLE ledger_event_fact(event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL);
        CREATE TABLE income_anomaly(anomaly_no INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, source_table TEXT NOT NULL, source_record_key TEXT NOT NULL, fee_id TEXT);
        CREATE TABLE incomplete_fee(fee_id TEXT PRIMARY KEY);
        CREATE TABLE contribution(contribution_no INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, account_code TEXT NOT NULL, settlement_month TEXT NOT NULL, allocation_key TEXT NOT NULL, signed_cents TEXT NOT NULL, fee_id TEXT NOT NULL, fee_version TEXT NOT NULL, snapshot_id TEXT NOT NULL, snapshot_source_key TEXT NOT NULL, run_id TEXT NOT NULL, policy_version_id TEXT NOT NULL, refund_document_id TEXT, refund_source_key TEXT);
        CREATE INDEX contribution_summary_order ON contribution(account_id,settlement_month,allocation_key,contribution_no);
        CREATE INDEX contribution_trace_lookup ON contribution(account_id,settlement_month,allocation_key,contribution_no);`);
      insertAnomaly = database.prepare("INSERT INTO income_anomaly(code,source_table,source_record_key,fee_id) VALUES(?,?,?,?)");
      insertIncompleteFee = database.prepare("INSERT OR IGNORE INTO incomplete_fee(fee_id) VALUES(?)");
      database.exec("BEGIN IMMEDIATE");
      try {
        const upsertAccount = database.prepare("INSERT INTO account_fact(account_id,owner_type,owner_id,account_code) VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET owner_type=excluded.owner_type,owner_id=excluded.owner_id,account_code=excluded.account_code WHERE account_fact.owner_type=excluded.owner_type AND account_fact.owner_id=excluded.owner_id AND account_fact.account_code=excluded.account_code");
        await read("settlement_account", (values) => {
          const result = upsertAccount.run(required(values, "id"), required(values, "owner_type"), required(values, "owner_id"), required(values, "account_code"));
          if (result.changes !== 1) fail("EXPORT_INCOME_DERIVED_ACCOUNT_DUPLICATE");
        });
        const insertFee = database.prepare("INSERT INTO fee_current(fee_id,version,settlement_month,gross_cents,source_key) VALUES(?,?,?,?,?)");
        await read("weekly_fee_entry", (values, row) => {
          const feeId = required(values, "id"), version = required(values, "version"), settlementMonth = month(required(values, "settlement_month")), gross = required(values, "gross_amount_cents");
          nonnegativeCents(gross);
          if (insertFee.run(feeId, version, settlementMonth, gross, row.sourceRecordKey).changes !== 1) fail("EXPORT_INCOME_DERIVED_FEE_DUPLICATE");
        });
        const insertVersion = database.prepare("INSERT INTO fee_version(fee_id,version,settlement_month,gross_cents,source_key) VALUES(?,?,?,?,?)");
        await read("weekly_fee_entry_version", (values, row) => {
          const feeId = required(values, "weekly_fee_entry_id"), version = required(values, "version"), settlementMonth = month(required(values, "settlement_month")), gross = required(values, "gross_amount_cents");
          nonnegativeCents(gross);
          if (insertVersion.run(feeId, version, settlementMonth, gross, row.sourceRecordKey).changes !== 1) fail("EXPORT_INCOME_DERIVED_VERSION_DUPLICATE");
        });
        const upsertSnapshot = database.prepare(`INSERT INTO latest_snapshot(fee_id,snapshot_id,sequence_no,run_id,source_version,policy_version_id,snapshot_json,context_json,source_key) VALUES(?,?,?,?,?,?,?,?,?)
          ON CONFLICT(fee_id) DO UPDATE SET snapshot_id=excluded.snapshot_id,sequence_no=excluded.sequence_no,run_id=excluded.run_id,source_version=excluded.source_version,policy_version_id=excluded.policy_version_id,snapshot_json=excluded.snapshot_json,context_json=excluded.context_json,source_key=excluded.source_key WHERE excluded.sequence_no>latest_snapshot.sequence_no`);
        await read("weekly_fee_allocation_snapshot", (values, row) => {
          const next = upsertSnapshot.run(required(values, "weekly_fee_entry_id"), required(values, "id"), sequence(required(values, "sequence_no")), required(values, "run_id"), required(values, "source_weekly_fee_version"), required(values, "policy_version_id"), required(values, "snapshot_json"), required(values, "context_json"), row.sourceRecordKey);
          if (next.changes !== 0 && next.changes !== 1) fail("EXPORT_INCOME_DERIVED_SNAPSHOT_DUPLICATE");
        });
        const insertDocument = database.prepare("INSERT INTO refund_document(document_id,document_version,status,source_key) VALUES(?,?,?,?)");
        const insertDocumentFee = database.prepare("INSERT OR IGNORE INTO refund_document_fee(document_id,fee_id) VALUES(?,?)");
        const insertInvalidDocument = database.prepare("INSERT OR IGNORE INTO refund_document_invalid(document_id,code,source_table,source_record_key) VALUES(?,?,?,?)");
        const markInvalidDocument = (values: Readonly<Record<string, TextValue>>, row: DerivedSpoolIndexRow, code = "REFUND_DOCUMENT_MEMBER_INVALID"): void => {
          const documentId = values.finance_document_id ?? values.id;
          if (typeof documentId !== "string" || documentId === "") return;
          const feeId = values.weekly_fee_entry_id;
          if (typeof feeId === "string" && feeId !== "") insertDocumentFee.run(documentId, feeId);
          insertInvalidDocument.run(documentId, code, row.tableName, row.sourceRecordKey);
        };
        await read("finance_document", (values, row) => {
          if (required(values, "kind") !== "REFUND") return;
          if (insertDocument.run(required(values, "id"), required(values, "version"), required(values, "status"), row.sourceRecordKey).changes !== 1) fail("EXPORT_INCOME_DERIVED_DOCUMENT_DUPLICATE");
        }, markInvalidDocument);
        const updateDecision = database.prepare("UPDATE refund_document SET decision=?,posting_status=?,ledger_event_id=?,approved_gross_cents=?,decision_source_key=? WHERE document_id=?");
        await read("finance_refund_decision", (values, row) => {
          const decision = required(values, "decision"), postingStatus = required(values, "posting_status"), approved = required(values, "approved_gross_amount_cents");
          nonnegativeCents(approved);
          const eventId = values.ledger_event_id ?? null;
          if (eventId !== null && eventId === "") fail("EXPORT_INCOME_DERIVED_VALUE_INVALID");
          if (updateDecision.run(decision, postingStatus, eventId, approved, row.sourceRecordKey, required(values, "finance_document_id")).changes !== 1)
            fail("EXPORT_INCOME_DERIVED_DECISION_ORPHAN");
        }, markInvalidDocument);
        const insertItem = database.prepare("INSERT INTO refund_item(document_id,fee_id,fee_version,gross_cents,settlement_month,source_key) VALUES(?,?,?,?,?,?)");
        await read("finance_refund_submission_item", (values, row) => {
          const gross = required(values, "submitted_gross_amount_cents"); nonnegativeCents(gross);
          const documentId = required(values, "finance_document_id"), feeId = required(values, "weekly_fee_entry_id");
          if (insertItem.run(documentId, feeId, required(values, "submitted_fee_version"), gross, month(required(values, "settlement_month")), row.sourceRecordKey).changes !== 1)
            fail("EXPORT_INCOME_DERIVED_REFUND_ITEM_DUPLICATE");
          insertDocumentFee.run(documentId, feeId);
        }, markInvalidDocument);
        const insertEffect = database.prepare("INSERT INTO refund_effect(fee_id,document_id,snapshot_id,source_version,gross_cents,snapshot_json,source_key) VALUES(?,?,?,?,?,?,?)");
        const incrementDocumentEffectSummary = database.prepare(`INSERT INTO refund_document_effect_summary(document_id,effect_count,nonzero_effect_count) VALUES(?,?,?)
          ON CONFLICT(document_id) DO UPDATE SET effect_count=refund_document_effect_summary.effect_count+1, nonzero_effect_count=refund_document_effect_summary.nonzero_effect_count+excluded.nonzero_effect_count`);
        await read("weekly_fee_refund_effect", (values, row) => {
          const gross = required(values, "gross_amount_cents"); nonnegativeCents(gross);
          const snapshotJson = required(values, "snapshot_json");
          const documentId = required(values, "finance_document_id");
          const feeId = required(values, "weekly_fee_entry_id");
          if (insertEffect.run(feeId, documentId, required(values, "allocation_snapshot_id"), required(values, "source_weekly_fee_version"), gross, snapshotJson, row.sourceRecordKey).changes !== 1)
            fail("EXPORT_INCOME_DERIVED_REFUND_EFFECT_DUPLICATE");
          if (incrementDocumentEffectSummary.run(documentId, 1, frozenSnapshotHasNonzeroLine(snapshotJson) ? 1 : 0).changes !== 1)
            fail("EXPORT_INCOME_DERIVED_REFUND_EFFECT_SUMMARY_INVALID");
          insertDocumentFee.run(documentId, feeId);
        }, markInvalidDocument);

        const documentInvalid = database.prepare("SELECT code FROM refund_document_invalid WHERE document_id=?");
        const documentItemEffectMismatch = database.prepare(`WITH only_item AS (
            SELECT fee_id FROM refund_item WHERE document_id=?
            EXCEPT SELECT fee_id FROM refund_effect WHERE document_id=?
          ), only_effect AS (
            SELECT fee_id FROM refund_effect WHERE document_id=?
            EXCEPT SELECT fee_id FROM refund_item WHERE document_id=?
          ) SELECT fee_id FROM only_item UNION SELECT fee_id FROM only_effect`);
        const documentUnknownFee = database.prepare(`SELECT link.fee_id FROM refund_document_fee link
          LEFT JOIN fee_current fee ON fee.fee_id=link.fee_id
          WHERE link.document_id=? AND fee.fee_id IS NULL`);
        const completedRefundDocuments = database.prepare("SELECT document_id,source_key FROM refund_document WHERE status='REFUNDED' AND decision='APPROVED' ORDER BY document_id");
        for (const rawDocument of completedRefundDocuments.iterate()) {
          const document = rawDocument as StoredRow;
          const documentId = storedText(document, "document_id");
          if (documentInvalid.get(documentId) !== undefined) continue;
          const documentSourceKey = storedText(document, "source_key");
          let invalid = false;
          for (const rawFee of documentItemEffectMismatch.iterate(documentId, documentId, documentId, documentId)) {
            const feeId = storedText(rawFee as StoredRow, "fee_id");
            issue("REFUND_DOCUMENT_ITEM_EFFECT_SET_MISMATCH", "finance_document", documentSourceKey, feeId);
            invalid = true;
          }
          for (const rawFee of documentUnknownFee.iterate(documentId)) {
            const feeId = storedText(rawFee as StoredRow, "fee_id");
            issue("REFUND_DOCUMENT_FEE_UNKNOWN", "finance_document", documentSourceKey, feeId);
            invalid = true;
          }
          if (invalid) insertInvalidDocument.run(documentId, "REFUND_DOCUMENT_MEMBER_SET_INVALID", "finance_document", documentSourceKey);
        }

        const contribution = database.prepare("INSERT INTO contribution(account_id,owner_type,owner_id,account_code,settlement_month,allocation_key,signed_cents,fee_id,fee_version,snapshot_id,snapshot_source_key,run_id,policy_version_id,refund_document_id,refund_source_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
        const deleteFeeContributions = database.prepare("DELETE FROM contribution WHERE fee_id=?");
        const insertRefundFeeEvent = database.prepare("INSERT INTO refund_fee_event(fee_id,event_id) VALUES(?,?)");
        const expectedLedger = database.prepare("SELECT amount_cents FROM expected_refund_ledger WHERE event_id=? AND account_id=? AND category_key=?");
        const updateExpected = database.prepare("UPDATE expected_refund_ledger SET amount_cents=? WHERE event_id=? AND account_id=? AND category_key=?");
        const insertExpected = database.prepare("INSERT INTO expected_refund_ledger(event_id,account_id,category_key,amount_cents) VALUES(?,?,?,?)");
        const accountFact = database.prepare("SELECT owner_type,owner_id,account_code FROM account_fact WHERE account_id=?");
        const isIncompleteFee = database.prepare("SELECT 1 FROM incomplete_fee WHERE fee_id=?");
        const invalidDocumentForFee = database.prepare(`SELECT invalid.code,invalid.source_table,invalid.source_record_key FROM refund_document_invalid invalid
          JOIN refund_document_fee link ON link.document_id=invalid.document_id
          WHERE link.fee_id=? ORDER BY invalid.document_id LIMIT 1`);
        const selected = database.prepare(`SELECT fee.fee_id,fee.version AS current_version,fee.settlement_month AS current_month,fee.gross_cents AS current_gross,fee.source_key AS fee_source_key,
                 version.settlement_month AS version_month,version.gross_cents AS version_gross,version.source_key AS version_source_key,
                 snapshot.snapshot_id,snapshot.sequence_no,snapshot.run_id,snapshot.source_version,snapshot.policy_version_id,snapshot.snapshot_json,snapshot.context_json,snapshot.source_key AS snapshot_source_key,
                 effect.document_id,effect.snapshot_id AS effect_snapshot_id,effect.source_version AS effect_source_version,effect.gross_cents AS effect_gross,effect.snapshot_json AS effect_snapshot_json,effect.source_key AS effect_source_key,
                 document.document_version,document.status,document.decision,document.posting_status,document.ledger_event_id,document.approved_gross_cents,document.decision_source_key,
                 summary.effect_count AS document_effect_count,summary.nonzero_effect_count AS document_nonzero_effect_count,
                 item.fee_version AS item_version,item.gross_cents AS item_gross,item.settlement_month AS item_month,item.source_key AS item_source_key
            FROM fee_current fee LEFT JOIN fee_version version ON version.fee_id=fee.fee_id AND version.version=fee.version
            LEFT JOIN latest_snapshot snapshot ON snapshot.fee_id=fee.fee_id
            LEFT JOIN refund_effect effect ON effect.fee_id=fee.fee_id
            LEFT JOIN refund_document document ON document.document_id=effect.document_id
            LEFT JOIN refund_document_effect_summary summary ON summary.document_id=effect.document_id
            LEFT JOIN refund_item item ON item.document_id=effect.document_id AND item.fee_id=fee.fee_id
           ORDER BY fee.fee_id`);
        selected.setReadBigInts(true);
        for (const raw of selected.iterate()) {
          const row = raw as StoredRow;
          const feeId = storedText(row, "fee_id");
          const sourceKey = storedText(row, "fee_source_key");
          database.exec("SAVEPOINT income_fee");
          try {
            if (isIncompleteFee.get(feeId) !== undefined) {
              database.exec("RELEASE SAVEPOINT income_fee");
              continue;
            }
            if (invalidDocumentForFee.get(feeId) !== undefined) fail("EXPORT_INCOME_DERIVED_REFUND_DOCUMENT_INVALID");
            const currentVersion = storedText(row, "current_version"), currentMonth = month(storedText(row, "current_month")), currentGross = nonnegativeCents(storedText(row, "current_gross"));
            if (row.version_month === null || row.version_gross === null || row.snapshot_id === null) fail("EXPORT_INCOME_DERIVED_CURRENT_CHAIN_MISSING");
            const versionMonth = month(storedText(row, "version_month")), versionGross = nonnegativeCents(storedText(row, "version_gross"));
            if (versionMonth !== currentMonth || versionGross !== currentGross) fail("EXPORT_INCOME_DERIVED_CURRENT_VERSION_MISMATCH");
            if (storedText(row, "source_version") !== currentVersion) fail("EXPORT_INCOME_DERIVED_LATEST_SNAPSHOT_VERSION_MISMATCH");
            const snapshotId = storedText(row, "snapshot_id"), runId = storedText(row, "run_id"), policyVersionId = storedText(row, "policy_version_id"), snapshotSourceKey = storedText(row, "snapshot_source_key");
            storedBigint(row, "sequence_no");
            const lines = decodeFrozenSnapshot(storedText(row, "snapshot_json"), storedText(row, "context_json"), currentGross, feeId, currentVersion, versionMonth);
            const refundDocumentId = row.document_id === null ? null : storedText(row, "document_id");
            if (refundDocumentId !== null) {
              if (storedText(row, "effect_snapshot_id") !== snapshotId || storedText(row, "effect_source_version") !== currentVersion
                || nonnegativeCents(storedText(row, "effect_gross")) !== currentGross || storedText(row, "effect_snapshot_json") !== storedText(row, "snapshot_json")
                || row.item_version === null || storedText(row, "item_version") !== currentVersion || nonnegativeCents(storedText(row, "item_gross")) !== currentGross
                || month(storedText(row, "item_month")) !== versionMonth || row.status !== "REFUNDED" || row.decision !== "APPROVED"
                || (row.posting_status !== "POSTED" && row.posting_status !== "NO_BALANCE_CHANGE")) fail("EXPORT_INCOME_DERIVED_REFUND_CHAIN_INVALID");
              if (row.document_effect_count === null || row.document_nonzero_effect_count === null) fail("EXPORT_INCOME_DERIVED_REFUND_CHAIN_INVALID");
              const documentHasNonzero = storedBigint(row, "document_nonzero_effect_count") > 0n;
              if (documentHasNonzero && (row.posting_status !== "POSTED" || row.ledger_event_id === null)) fail("EXPORT_INCOME_DERIVED_REFUND_LEDGER_INVALID");
              if (!documentHasNonzero && (row.posting_status !== "NO_BALANCE_CHANGE" || row.ledger_event_id !== null)) fail("EXPORT_INCOME_DERIVED_REFUND_LEDGER_INVALID");
              const hasNonzero = lines.some((line) => line.cents !== 0n);
              if (hasNonzero && insertRefundFeeEvent.run(feeId, storedText(row, "ledger_event_id")).changes !== 1) fail("EXPORT_INCOME_DERIVED_REFUND_LEDGER_INVALID");
            }
            for (const line of lines) {
              if (line.cents === 0n) continue;
              const fact = accountFact.get(line.accountId) as StoredRow | undefined;
              if (fact === undefined || storedText(fact, "owner_type") !== line.accountOwnerType || storedText(fact, "owner_id") !== line.accountOwnerId || storedText(fact, "account_code") !== line.accountCode)
                fail("EXPORT_INCOME_DERIVED_ACCOUNT_IDENTITY_INVALID");
              const insert = (amount: bigint, documentId: string | null, refundSourceKey: string | null): void => {
                contribution.run(line.accountId, line.accountOwnerType, line.accountOwnerId, line.accountCode, versionMonth, line.key, amount.toString(), feeId, currentVersion, snapshotId, snapshotSourceKey, runId, policyVersionId, documentId, refundSourceKey);
              };
              insert(line.cents, null, null);
              if (refundDocumentId !== null) {
                const negative = -line.cents;
                insert(negative, refundDocumentId, storedText(row, "effect_source_key"));
                const eventId = storedText(row, "ledger_event_id");
                const prior = expectedLedger.get(eventId, line.accountId, line.key) as StoredRow | undefined;
                const next = (prior === undefined ? 0n : signedCents(storedText(prior, "amount_cents"))) + negative;
                if (prior === undefined) insertExpected.run(eventId, line.accountId, line.key, next.toString());
                else updateExpected.run(next.toString(), eventId, line.accountId, line.key);
              }
            }
            database.exec("RELEASE SAVEPOINT income_fee");
          } catch (error) {
            database.exec("ROLLBACK TO SAVEPOINT income_fee");
            database.exec("RELEASE SAVEPOINT income_fee");
            deleteFeeContributions.run(feeId);
            issue(error instanceof Error && error.message.startsWith("EXPORT_INCOME_DERIVED_") ? error.message : "DERIVATION_CHAIN_INVALID", "weekly_fee_allocation_snapshot", row.snapshot_source_key === null ? sourceKey : storedText(row, "snapshot_source_key"), feeId);
          }
        }

        const insertEvent = database.prepare("INSERT INTO ledger_event_fact(event_id,event_type) VALUES(?,?)");
        await read("ledger_event", (values) => {
          if (insertEvent.run(required(values, "id"), required(values, "event_type")).changes !== 1) fail("EXPORT_INCOME_DERIVED_LEDGER_EVENT_DUPLICATE");
        });
        const expectedEvents = database.prepare("SELECT DISTINCT event_id FROM expected_refund_ledger");
        const invalidateEventFees = (eventId: string, code: string, sourceTable: string, sourceRecordKey: string): void => {
          const fees = database!.prepare("SELECT fee_id FROM refund_fee_event WHERE event_id=?");
          for (const rawFee of fees.iterate(eventId)) {
            const feeId = storedText(rawFee as StoredRow, "fee_id");
            deleteFeeContributions.run(feeId);
            issue(code, sourceTable, sourceRecordKey, feeId);
          }
        };
        for (const raw of expectedEvents.iterate()) {
          const eventId = storedText(raw as StoredRow, "event_id");
          const fact = database.prepare("SELECT event_type FROM ledger_event_fact WHERE event_id=?").get(eventId) as StoredRow | undefined;
          if (fact === undefined || storedText(fact, "event_type") !== "WEEKLY_FEE_REFUND") invalidateEventFees(eventId, "REFUND_LEDGER_EVENT_INVALID", "finance_refund_decision", eventId);
          else database.prepare("INSERT INTO refund_event(event_id) VALUES(?)").run(eventId);
        }
        const actualLedger = database.prepare("SELECT amount_cents FROM actual_refund_ledger WHERE event_id=? AND account_id=? AND category_key=?");
        const updateActual = database.prepare("UPDATE actual_refund_ledger SET amount_cents=? WHERE event_id=? AND account_id=? AND category_key=?");
        const insertActual = database.prepare("INSERT INTO actual_refund_ledger(event_id,account_id,category_key,amount_cents) VALUES(?,?,?,?)");
        const expectedEvent = database.prepare("SELECT 1 FROM refund_event WHERE event_id=?");
        await read("ledger_entry", (values, row) => {
          const eventId = required(values, "event_id");
          if (expectedEvent.get(eventId) === undefined) return;
          const amount = signedCents(required(values, "amount_cents"));
          const accountId = required(values, "account_id"), category = required(values, "category_key");
          const prior = actualLedger.get(eventId, accountId, category) as StoredRow | undefined;
          const next = (prior === undefined ? 0n : signedCents(storedText(prior, "amount_cents"))) + amount;
          if (prior === undefined) insertActual.run(eventId, accountId, category, next.toString());
          else updateActual.run(next.toString(), eventId, accountId, category);
          if (amount === 0n) issue("REFUND_LEDGER_ZERO_ENTRY", "ledger_entry", row.sourceRecordKey);
        });
        const mismatch = database.prepare(`SELECT event_id,account_id,category_key FROM expected_refund_ledger expected
          WHERE NOT EXISTS (SELECT 1 FROM actual_refund_ledger actual WHERE actual.event_id=expected.event_id AND actual.account_id=expected.account_id AND actual.category_key=expected.category_key AND actual.amount_cents=expected.amount_cents)
          UNION ALL SELECT event_id,account_id,category_key FROM actual_refund_ledger actual
          WHERE NOT EXISTS (SELECT 1 FROM expected_refund_ledger expected WHERE expected.event_id=actual.event_id AND expected.account_id=actual.account_id AND expected.category_key=actual.category_key AND expected.amount_cents=actual.amount_cents)`);
        for (const raw of mismatch.iterate()) {
          const row = raw as StoredRow;
          invalidateEventFees(storedText(row, "event_id"), "REFUND_LEDGER_MISMATCH", "ledger_entry", canonical([storedText(row, "event_id"), storedText(row, "account_id"), storedText(row, "category_key")]));
        }

        database.exec("COMMIT");
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* primary error remains authoritative */ }
        throw error;
      }
      const digest = createHash("sha256");
      const digestRows = database.prepare("SELECT account_id,settlement_month,allocation_key,signed_cents,fee_id,fee_version,snapshot_id,refund_document_id FROM contribution ORDER BY account_id,settlement_month,allocation_key,contribution_no");
      for (const row of digestRows.iterate()) digest.update(`${canonical(row)}\n`, "utf8");
      const sourceRows = indexMetadata.sources.filter((source) => sourceTables.includes(source.tableName));
      const anomalyCountStatement = database.prepare("SELECT count(*) AS value FROM income_anomaly"); anomalyCountStatement.setReadBigInts(true);
      const incompleteFeeCountStatement = database.prepare("SELECT count(*) AS value FROM incomplete_fee"); incompleteFeeCountStatement.setReadBigInts(true);
      const anomalyCount = storedCount(anomalyCountStatement.get() as StoredRow, "value");
      const incompleteFeeCount = storedCount(incompleteFeeCountStatement.get() as StoredRow, "value");
      const metadata: IncomeDerivedMetadata = Object.freeze({
        mode: "INCOME_DERIVED_VIEW", complete: false, tableNumber: 3, status: anomalyCount === "0" ? "DERIVED_UNPUBLISHED" : "PARTIAL",
        spoolId: indexMetadata.spoolId, snapshotId: indexMetadata.snapshotId, asOf: indexMetadata.asOf, publishedVersion: null,
        gaps: ["SETTLEMENT_PUBLISHED_SNAPSHOTS_NOT_IMPLEMENTED"] as const, anomalyCount, incompleteFeeCount,
        sourceBasis: Object.freeze({ indexMode: "DERIVED_SPOOL_INDEX", sourceRows: Object.freeze(sourceRows.map((source) => Object.freeze({ ...source }))), contributionDigest: digest.digest("hex") }),
      });
      await chmod(databasePath, 0o600);
      return new FullBackupIncomeDerivedView(database, directory, metadata);
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try { database?.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      if (directory !== undefined) {
        try { await rm(directory, { recursive: true, force: true }); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      }
      if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], "EXPORT_INCOME_DERIVED_CREATE_CLEANUP_FAILED", { cause: error });
      throw error;
    }
  }

  public metadata(): IncomeDerivedMetadata { return this.result; }

  /** Every bad chain remains observable without turning a valid RAW spool into a failed backup. */
  public async *streamAnomalies(): AsyncGenerator<IncomeDerivedAnomaly> {
    const database = this.openDatabase();
    const statement = database.prepare("SELECT code,source_table,source_record_key,fee_id FROM income_anomaly ORDER BY anomaly_no");
    statement.setReadBigInts(true);
    const iterator = statement.iterate()[Symbol.iterator]();
    let active = true;
    const closeIterator = (): void => { if (!active) return; active = false; this.activeIteratorClosers.delete(closeIterator); iterator.return?.(); };
    this.activeIteratorClosers.add(closeIterator);
    try {
      for (;;) {
        if (this.closed) fail("EXPORT_INCOME_DERIVED_CLOSED");
        const next = iterator.next();
        if (next.done) break;
        const row = next.value as StoredRow;
        yield Object.freeze({ code: storedText(row, "code"), sourceTable: storedText(row, "source_table"), sourceRecordKey: storedText(row, "source_record_key"), feeEntryId: row.fee_id === null ? null : storedText(row, "fee_id") });
      }
    } finally { closeIterator(); }
  }

  public async *streamMonthlyRows(): AsyncGenerator<IncomeDerivedMonthlyRow> {
    const database = this.openDatabase();
    const statement = database.prepare("SELECT account_id,owner_type,owner_id,account_code,settlement_month,allocation_key,signed_cents FROM contribution ORDER BY account_id,settlement_month,allocation_key,contribution_no");
    statement.setReadBigInts(true);
    const iterator = statement.iterate()[Symbol.iterator]();
    let active = true;
    const closeIterator = (): void => { if (!active) return; active = false; this.activeIteratorClosers.delete(closeIterator); iterator.return?.(); };
    this.activeIteratorClosers.add(closeIterator);
    try {
      let current: { accountId: string; ownerType: "PERSON" | "COMPANY" | "VENUE"; ownerId: string; accountCode: string; settlementMonth: string; allocationKey: AllocationKey; positive: bigint; refund: bigint; count: bigint } | undefined;
      for (;;) {
        if (this.closed) fail("EXPORT_INCOME_DERIVED_CLOSED");
        const next = iterator.next();
        if (next.done) break;
        const row = next.value as StoredRow;
        const accountId = storedText(row, "account_id"), settlementMonth = month(storedText(row, "settlement_month")), key = allocationKey(storedText(row, "allocation_key"));
        const ownerType = storedText(row, "owner_type");
        if (!( ["PERSON", "COMPANY", "VENUE"] as readonly string[]).includes(ownerType)) fail("EXPORT_INCOME_DERIVED_STORE_INVALID");
        const same = current !== undefined && current.accountId === accountId && current.settlementMonth === settlementMonth && current.allocationKey === key;
        if (!same && current !== undefined) yield Object.freeze({ accountId: current.accountId, ownerType: current.ownerType, ownerId: current.ownerId, accountCode: current.accountCode, settlementMonth: current.settlementMonth, financeYear: financeYearForMonth(current.settlementMonth), allocationKey: current.allocationKey, positiveCents: current.positive, refundCents: current.refund, netCents: current.positive + current.refund, contributionCount: current.count.toString() });
        if (!same) current = { accountId, ownerType: ownerType as "PERSON" | "COMPANY" | "VENUE", ownerId: storedText(row, "owner_id"), accountCode: storedText(row, "account_code"), settlementMonth, allocationKey: key, positive: 0n, refund: 0n, count: 0n };
        const amount = signedCents(storedText(row, "signed_cents"));
        if (amount >= 0n) current!.positive += amount; else current!.refund += amount;
        current!.count += 1n;
      }
      if (current !== undefined) yield Object.freeze({ accountId: current.accountId, ownerType: current.ownerType, ownerId: current.ownerId, accountCode: current.accountCode, settlementMonth: current.settlementMonth, financeYear: financeYearForMonth(current.settlementMonth), allocationKey: current.allocationKey, positiveCents: current.positive, refundCents: current.refund, netCents: current.positive + current.refund, contributionCount: current.count.toString() });
    } finally { closeIterator(); }
  }

  public async *streamContributionSources(key: IncomeDerivedContributionKey): AsyncGenerator<IncomeDerivedContribution> {
    if (!isObject(key) || typeof key.accountId !== "string" || !MONTH.test(key.settlementMonth) || !(ALLOCATION_KEYS as readonly string[]).includes(key.allocationKey)) fail("EXPORT_INCOME_DERIVED_KEY_INVALID");
    const database = this.openDatabase();
    const statement = database.prepare("SELECT account_id,settlement_month,allocation_key,signed_cents,fee_id,fee_version,snapshot_id,snapshot_source_key,run_id,policy_version_id,refund_document_id,refund_source_key FROM contribution WHERE account_id=? AND settlement_month=? AND allocation_key=? ORDER BY contribution_no");
    statement.setReadBigInts(true);
    const iterator = statement.iterate(key.accountId, key.settlementMonth, key.allocationKey)[Symbol.iterator]();
    let active = true;
    const closeIterator = (): void => { if (!active) return; active = false; this.activeIteratorClosers.delete(closeIterator); iterator.return?.(); };
    this.activeIteratorClosers.add(closeIterator);
    try {
      for (;;) {
        if (this.closed) fail("EXPORT_INCOME_DERIVED_CLOSED");
        const next = iterator.next();
        if (next.done) break;
        const row = next.value as StoredRow;
        yield Object.freeze({ accountId: storedText(row, "account_id"), settlementMonth: month(storedText(row, "settlement_month")), allocationKey: allocationKey(storedText(row, "allocation_key")), signedCents: signedCents(storedText(row, "signed_cents")), feeEntryId: storedText(row, "fee_id"), feeVersion: storedText(row, "fee_version"), allocationSnapshotId: storedText(row, "snapshot_id"), allocationSnapshotSourceKey: storedText(row, "snapshot_source_key"), settlementRunId: storedText(row, "run_id"), policyVersionId: storedText(row, "policy_version_id"), refundFinanceDocumentId: row.refund_document_id === null ? null : storedText(row, "refund_document_id"), refundEffectSourceKey: row.refund_source_key === null ? null : storedText(row, "refund_source_key") });
      }
    } finally { closeIterator(); }
  }

  public close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    const database = this.database;
    this.database = undefined;
    this.closePromise = (async () => {
      const errors: unknown[] = [];
      for (const closeIterator of [...this.activeIteratorClosers]) { try { closeIterator(); } catch (error) { errors.push(error); } }
      try { database?.close(); } catch (error) { errors.push(error); }
      try { await rm(this.directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "EXPORT_INCOME_DERIVED_CLOSE_FAILED", { cause: errors[0] });
    })();
    return this.closePromise;
  }

  private openDatabase(): SqliteDatabase {
    if (this.closed || this.database === undefined) return fail("EXPORT_INCOME_DERIVED_CLOSED");
    return this.database;
  }
}
