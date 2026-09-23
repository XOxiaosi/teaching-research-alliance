import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FullBackupDerivedSpoolIndex,
} from "./full-backup-derived-spool-index.js";
import { fullBackupOutputColumns } from "./full-backup-transformer.js";

type SqliteDatabase = InstanceType<typeof import("node:sqlite").DatabaseSync>;
type SqliteConstructor = typeof import("node:sqlite").DatabaseSync;
type Text = string | null;
const fail = (code: string): never => {
  throw new Error(code);
};
const tables = [
  "ledger_event",
  "settlement_calculation_run",
  "weekly_fee_allocation_snapshot",
  "weekly_fee_entry_version",
  "finance_refund_decision",
  "weekly_fee_refund_effect",
  "finance_refund_submission_item",
] as const;
type Table = (typeof tables)[number];

export type LedgerBusinessPeriodStatus =
  | "UNIQUE_LOCKED_SETTLEMENT_MONTH"
  | "MULTIPLE_BUSINESS_PERIODS"
  | "UNRESOLVED"
  | "UNIMPLEMENTED_EVENT_TYPE";
export type LedgerBusinessPeriodMetadata = Readonly<{
  mode: "LEDGER_BUSINESS_PERIOD_SOURCE";
  complete: false;
  spoolId: string;
  snapshotId: string;
  asOf: string;
  anomalyCount: string;
}>;
export type LedgerBusinessPeriod = Readonly<{
  eventId: string;
  eventSourceRecordKey: string;
  eventType: Text;
  status: LedgerBusinessPeriodStatus;
  uniqueLockedSettlementMonth: Text;
  distinctMonthCount: string;
  sourceLinkCount: string;
  anomalyCount: string;
}>;
export type LedgerBusinessPeriodSourceLink = Readonly<{
  eventId: string;
  eventSourceRecordKey: string;
  relation:
    | "SETTLEMENT_RUN"
    | "ALLOCATION_SNAPSHOT"
    | "WEEKLY_FEE_VERSION"
    | "REFUND_DECISION"
    | "REFUND_EFFECT"
    | "REFUND_SUBMISSION_ITEM";
  sourceTable: Table;
  sourceRecordKey: string;
  sourceRowNumber: string;
  financeDocumentId: Text;
  runId: Text;
  allocationSnapshotId: Text;
  weeklyFeeEntryId: Text;
  weeklyFeeVersion: Text;
  lockedSettlementMonth: Text;
}>;
export type LedgerBusinessPeriodAnomaly = Readonly<{
  code: string;
  eventId: string;
  eventSourceRecordKey: string;
  sourceTable: Table;
  sourceRecordKey: Text;
  sourceRowNumber: Text;
}>;
export type FullBackupLedgerBusinessPeriodSourceOptions = Readonly<{
  index: FullBackupDerivedSpoolIndex;
  attemptRoot: string;
}>;

const nodeSqlite = async (): Promise<SqliteConstructor> => {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major === undefined || minor === undefined || major < 22 || (major === 22 && minor < 16))
    return fail("EXPORT_LEDGER_PERIOD_SQLITE_RUNTIME_UNAVAILABLE");
  try {
    const m = await import("node:sqlite");
    if (typeof m.DatabaseSync !== "function")
      return fail("EXPORT_LEDGER_PERIOD_SQLITE_RUNTIME_UNAVAILABLE");
    return m.DatabaseSync;
  } catch {
    return fail("EXPORT_LEDGER_PERIOD_SQLITE_RUNTIME_UNAVAILABLE");
  }
};
const root = async (path: string) => {
  try {
    const s = await lstat(path);
    if (!s.isDirectory() || s.isSymbolicLink())
      fail("EXPORT_LEDGER_PERIOD_ATTEMPT_ROOT_INVALID");
  } catch (e) {
    if (
      e instanceof Error &&
      e.message === "EXPORT_LEDGER_PERIOD_ATTEMPT_ROOT_INVALID"
    )
      throw e;
    if (!(e && typeof e === "object" && "code" in e && e.code === "ENOENT"))
      throw e;
    await mkdir(path, { recursive: true, mode: 0o700 });
    const created = await lstat(path);
    if (!created.isDirectory() || created.isSymbolicLink())
      fail("EXPORT_LEDGER_PERIOD_ATTEMPT_ROOT_INVALID");
  }
};
const text = (row: Readonly<Record<string, unknown>>, key: string): Text => {
  const value = row[key];
  return value === null || typeof value === "string"
    ? value
    : fail("EXPORT_LEDGER_PERIOD_STORAGE_INVALID");
};
const count = (db: SqliteDatabase, sql: string, ...args: string[]): string => {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  const r = statement.get(...args) as { n: bigint } | undefined;
  const safe = r ?? fail("EXPORT_LEDGER_PERIOD_STORAGE_INVALID");
  return String(safe.n);
};
const month = (value: Text): string | undefined =>
  value !== null && /^(?!0000)\d{4}-(0[1-9]|1[0-2])-01$/.test(value) ? value : undefined;

export class FullBackupLedgerBusinessPeriodSource {
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private readonly active = new Set<() => void>();
  private constructor(
    private db: SqliteDatabase | undefined,
    private readonly dir: string,
    private readonly meta: LedgerBusinessPeriodMetadata,
  ) {}
  static async create(
    options: FullBackupLedgerBusinessPeriodSourceOptions,
  ): Promise<FullBackupLedgerBusinessPeriodSource> {
    const Constructor = await nodeSqlite();
    await root(options.attemptRoot);
    let dir: string | undefined;
    let db: SqliteDatabase | undefined;
    try {
      dir = await mkdtemp(
        join(options.attemptRoot, "full-backup-ledger-period-"),
      );
      await chmod(dir, 0o700);
      const file = join(dir, "period.sqlite");
      await writeFile(file, "", { flag: "wx", mode: 0o600 });
      db = new Constructor(file, { allowExtension: false });
      db.exec(
        "PRAGMA journal_mode=DELETE; PRAGMA temp_store=FILE; PRAGMA cache_size=-4096; CREATE TABLE raw(t TEXT,o INTEGER,k TEXT,v TEXT,PRIMARY KEY(t,o)); CREATE TABLE result(event_id TEXT PRIMARY KEY,event_key TEXT,event_type TEXT,status TEXT,unique_month TEXT,month_count TEXT,link_count TEXT,anomaly_count TEXT); CREATE TABLE link(o INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT,event_key TEXT,relation TEXT,source_table TEXT,source_key TEXT,source_row TEXT,document_id TEXT,run_id TEXT,snapshot_id TEXT,fee_id TEXT,fee_version TEXT,locked_month TEXT); CREATE TABLE anomaly(o INTEGER PRIMARY KEY AUTOINCREMENT,code TEXT,event_id TEXT,event_key TEXT,source_table TEXT,source_key TEXT,source_row TEXT);",
      );
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const table of tables) {
          const insert = db.prepare("INSERT INTO raw(t,o,k,v) VALUES(?,?,?,?)");
          for await (const row of options.index.stream(table)) {
            insert.run(
              table,
              BigInt(row.ordinal),
              row.sourceRecordKey,
              JSON.stringify(row.values),
            );
          }
        }
        createLookupIndexes(db);
        build(db);
        db.exec("COMMIT");
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw e;
      }
      const im = options.index.metadata();
      return new FullBackupLedgerBusinessPeriodSource(
        db,
        dir,
        Object.freeze({
          mode: "LEDGER_BUSINESS_PERIOD_SOURCE",
          complete: false,
          spoolId: im.spoolId,
          snapshotId: im.snapshotId,
          asOf: im.asOf,
          anomalyCount: count(db, "SELECT count(*) n FROM anomaly"),
        }),
      );
    } catch (e) {
      const errors: unknown[] = [];
      try { db?.close(); } catch (error) { errors.push(error); }
      if (dir) {
        try { await rm(dir, { recursive: true, force: true }); }
        catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError([e, ...errors], "EXPORT_LEDGER_PERIOD_CREATE_CLEANUP_FAILED", { cause: e });
      throw e;
    }
  }
  metadata() {
    return this.meta;
  }
  async *streamEventPeriods(): AsyncGenerator<LedgerBusinessPeriod> {
    yield* this.rows("SELECT * FROM result ORDER BY event_id", (r) =>
      Object.freeze({
        eventId: text(r, "event_id")!,
        eventSourceRecordKey: text(r, "event_key")!,
        eventType: text(r, "event_type"),
        status: status(text(r, "status")),
        uniqueLockedSettlementMonth: text(r, "unique_month"),
        distinctMonthCount: text(r, "month_count")!,
        sourceLinkCount: text(r, "link_count")!,
        anomalyCount: text(r, "anomaly_count")!,
      }),
    );
  }
  async *streamSourceLinks(): AsyncGenerator<LedgerBusinessPeriodSourceLink> {
    yield* this.rows("SELECT * FROM link ORDER BY event_id,o", (r) =>
      Object.freeze({
        eventId: text(r, "event_id")!,
        eventSourceRecordKey: text(r, "event_key")!,
        relation: relation(text(r, "relation")),
        sourceTable: table(text(r, "source_table")),
        sourceRecordKey: text(r, "source_key")!,
        sourceRowNumber: text(r, "source_row")!,
        financeDocumentId: text(r, "document_id"),
        runId: text(r, "run_id"),
        allocationSnapshotId: text(r, "snapshot_id"),
        weeklyFeeEntryId: text(r, "fee_id"),
        weeklyFeeVersion: text(r, "fee_version"),
        lockedSettlementMonth: text(r, "locked_month"),
      }),
    );
  }
  async *streamAnomalies(): AsyncGenerator<LedgerBusinessPeriodAnomaly> {
    yield* this.rows("SELECT * FROM anomaly ORDER BY o", (r) =>
      Object.freeze({
        code: text(r, "code")!,
        eventId: text(r, "event_id")!,
        eventSourceRecordKey: text(r, "event_key")!,
        sourceTable: table(text(r, "source_table")),
        sourceRecordKey: text(r, "source_key"),
        sourceRowNumber: text(r, "source_row"),
      }),
    );
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const db = this.db;
    this.db = undefined;
    this.closePromise = (async () => {
      const errors: unknown[] = [];
      for (const f of [...this.active]) {
        try { f(); } catch (error) { errors.push(error); }
      }
      try { db?.close(); } catch (error) { errors.push(error); }
      try { await rm(this.dir, { recursive: true, force: true }); }
      catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "EXPORT_LEDGER_PERIOD_CLOSE_FAILED", { cause: errors[0] });
    })();
    return this.closePromise;
  }
  private open() {
    const db = this.db;
    if (this.closed || !db) return fail("EXPORT_LEDGER_PERIOD_CLOSED");
    return db;
  }
  private async *rows<T>(
    sql: string,
    map: (row: Readonly<Record<string, unknown>>) => T,
  ): AsyncGenerator<T> {
    const s = this.open().prepare(sql);
    s.setReadBigInts(true);
    const it = s.iterate()[Symbol.iterator]();
    let on = true;
    const close = () => {
      if (on) {
        on = false;
        this.active.delete(close);
        it.return?.();
      }
    };
    this.active.add(close);
    try {
      for (;;) {
        if (this.closed) fail("EXPORT_LEDGER_PERIOD_CLOSED");
        const n = it.next();
        if (n.done) break;
        yield map(n.value as Readonly<Record<string, unknown>>);
      }
    } finally {
      close();
    }
  }
}
const table = (v: Text): Table =>
  tables.includes(v as Table)
    ? (v as Table)
    : fail("EXPORT_LEDGER_PERIOD_STORAGE_INVALID");
const status = (v: Text): LedgerBusinessPeriodStatus =>
  v === "UNIQUE_LOCKED_SETTLEMENT_MONTH" ||
  v === "MULTIPLE_BUSINESS_PERIODS" ||
  v === "UNRESOLVED" ||
  v === "UNIMPLEMENTED_EVENT_TYPE"
    ? v
    : fail("EXPORT_LEDGER_PERIOD_STORAGE_INVALID");
const relation = (v: Text): LedgerBusinessPeriodSourceLink["relation"] =>
  [
    "SETTLEMENT_RUN",
    "ALLOCATION_SNAPSHOT",
    "WEEKLY_FEE_VERSION",
    "REFUND_DECISION",
    "REFUND_EFFECT",
    "REFUND_SUBMISSION_ITEM",
  ].includes(v ?? "")
    ? (v as LedgerBusinessPeriodSourceLink["relation"])
    : fail("EXPORT_LEDGER_PERIOD_STORAGE_INVALID");

type RawRow = Readonly<{ o: string; k: string; v: Text[] }>;

// Every lookup field is a fixed source-schema column, never user SQL. Values are
// bound parameters. Indexes and intermediate distinct-month sets remain on disk.
const expression = (table: Table, column: string): string => {
  const index = fullBackupOutputColumns(table).indexOf(column);
  if (index < 0) return fail("EXPORT_LEDGER_PERIOD_SOURCE_SCHEMA_INVALID");
  return `json_extract(v,'$[${index}]')`;
};
const createLookupIndexes = (db: SqliteDatabase): void => {
  const lookups: readonly (readonly [Table, readonly string[]])[] = [
    ["settlement_calculation_run", ["ledger_event_id"]],
    ["weekly_fee_allocation_snapshot", ["run_id"]],
    ["weekly_fee_allocation_snapshot", ["id"]],
    ["weekly_fee_entry_version", ["weekly_fee_entry_id", "version"]],
    ["finance_refund_decision", ["ledger_event_id"]],
    ["weekly_fee_refund_effect", ["finance_document_id"]],
    ["finance_refund_submission_item", ["finance_document_id", "weekly_fee_entry_id"]],
  ];
  for (const [i, [table, fields]] of lookups.entries())
    db.exec(`CREATE INDEX raw_lookup_${i} ON raw(t,${fields.map((f) => expression(table, f)).join(",")})`);
  db.exec("CREATE INDEX link_event ON link(event_id); CREATE INDEX anomaly_event ON anomaly(event_id); CREATE TABLE event_month(event_id TEXT,month TEXT,PRIMARY KEY(event_id,month))");
};
const field = (table: Table, row: RawRow, name: string): Text => {
  const i = fullBackupOutputColumns(table).indexOf(name);
  return i < 0 ? fail("EXPORT_LEDGER_PERIOD_SOURCE_SCHEMA_INVALID") : row.v[i]!;
};
const decode = (row: Readonly<Record<string, unknown>>, table: Table): RawRow => {
  const values: unknown = JSON.parse(text(row, "v")!);
  if (!Array.isArray(values) || values.length !== fullBackupOutputColumns(table).length ||
      values.some((value) => value !== null && typeof value !== "string"))
    return fail("EXPORT_LEDGER_PERIOD_SOURCE_SCHEMA_INVALID");
  return { o: String(row.o), k: text(row, "k")!, v: values as Text[] };
};
type Conditions = readonly (readonly [string, Text])[];
const predicate = (table: Table, conditions: Conditions) =>
  `t=?${conditions.map(([key]) => ` AND ${expression(table, key)}=?`).join("")}`;
function* rawRows(db: SqliteDatabase, table: Table, conditions: Conditions = []): Generator<RawRow> {
  const statement = db.prepare(`SELECT o,k,v FROM raw WHERE ${predicate(table, conditions)} ORDER BY o`);
  statement.setReadBigInts(true);
  for (const row of statement.iterate(table, ...conditions.map(([, value]) => value)))
    yield decode(row as Record<string, unknown>, table);
}
const rawCount = (db: SqliteDatabase, table: Table, conditions: Conditions = []): bigint => {
  const statement = db.prepare(`SELECT count(*) n FROM raw WHERE ${predicate(table, conditions)}`);
  statement.setReadBigInts(true);
  return (statement.get(table, ...conditions.map(([, value]) => value)) as { n: bigint }).n;
};
const single = (db: SqliteDatabase, table: Table, conditions: Conditions): RawRow | undefined => {
  if (rawCount(db, table, conditions) !== 1n) return undefined;
  for (const row of rawRows(db, table, conditions)) return row;
  return undefined;
};

const build = (db: SqliteDatabase): void => {
  const insertResult = db.prepare("INSERT INTO result VALUES(?,?,?,?,?,?,?,?)");
  const insertLink = db.prepare("INSERT INTO link(event_id,event_key,relation,source_table,source_key,source_row,document_id,run_id,snapshot_id,fee_id,fee_version,locked_month) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
  const insertAnomaly = db.prepare("INSERT INTO anomaly(code,event_id,event_key,source_table,source_key,source_row) VALUES(?,?,?,?,?,?)");
  const insertMonth = db.prepare("INSERT OR IGNORE INTO event_month VALUES(?,?)");
  for (const event of rawRows(db, "ledger_event")) {
    const eventId = field("ledger_event", event, "id");
    if (!eventId) return fail("EXPORT_LEDGER_PERIOD_EVENT_ID_MISSING");
    const eventType = field("ledger_event", event, "event_type");
    let valid = true;
    let linkCount = 0n;
    let anomalyCount = 0n;
    const bad = (code: string, table: Table, row: RawRow = event) => {
      valid = false;
      anomalyCount++;
      insertAnomaly.run(code, eventId, event.k, table, row.k, row.o);
    };
    const link = (
      relation: LedgerBusinessPeriodSourceLink["relation"], table: Table, row: RawRow,
      doc: Text = null, run: Text = null, snapshot: Text = null,
      fee: Text = null, version: Text = null, lockedMonth: Text = null,
    ) => {
      linkCount++;
      insertLink.run(eventId,event.k,relation,table,row.k,row.o,doc,run,snapshot,fee,version,lockedMonth);
    };
    const historical = (fee: Text, version: Text) => {
      if (!fee || !version || !/^[1-9]\d*$/.test(version)) return undefined;
      return single(db, "weekly_fee_entry_version", [["weekly_fee_entry_id", fee], ["version", version]]);
    };
    const addHistorical = (fee: Text, version: Text, doc: Text, run: Text, snapshot: Text): Text => {
      const row = historical(fee, version);
      if (!row) return null;
      const lockedMonth = month(field("weekly_fee_entry_version", row, "settlement_month")) ?? null;
      link("WEEKLY_FEE_VERSION", "weekly_fee_entry_version", row, doc, run, snapshot, fee, version, lockedMonth);
      if (lockedMonth) insertMonth.run(eventId, lockedMonth);
      return lockedMonth;
    };
    if (eventType === "WEEKLY_FEE_SETTLEMENT") {
      const runCondition: Conditions = [["ledger_event_id", eventId]];
      if (rawCount(db, "settlement_calculation_run", runCondition) !== 1n)
        bad("SETTLEMENT_RUN_UNRESOLVED", "ledger_event");
      for (const run of rawRows(db, "settlement_calculation_run", runCondition)) {
        const runId = field("settlement_calculation_run", run, "id");
        link("SETTLEMENT_RUN", "settlement_calculation_run", run, null, runId);
        if (!runId || field("settlement_calculation_run", run, "status") !== "POSTED")
          bad("SETTLEMENT_RUN_STATUS_INVALID", "settlement_calculation_run", run);
        const snapshotCondition: Conditions = [["run_id", runId]];
        if (rawCount(db, "weekly_fee_allocation_snapshot", snapshotCondition) === 0n)
          bad("SETTLEMENT_SNAPSHOT_MISSING", "settlement_calculation_run", run);
        for (const snapshot of rawRows(db, "weekly_fee_allocation_snapshot", snapshotCondition)) {
          const fee = field("weekly_fee_allocation_snapshot", snapshot, "weekly_fee_entry_id");
          const version = field("weekly_fee_allocation_snapshot", snapshot, "source_weekly_fee_version");
          const snapshotId = field("weekly_fee_allocation_snapshot", snapshot, "id");
          link("ALLOCATION_SNAPSHOT", "weekly_fee_allocation_snapshot", snapshot, null, runId, snapshotId, fee, version);
          if (!snapshotId || !addHistorical(fee, version, null, runId, snapshotId))
            bad("SETTLEMENT_FEE_VERSION_UNRESOLVED", "weekly_fee_allocation_snapshot", snapshot);
        }
      }
    } else if (eventType === "WEEKLY_FEE_REFUND") {
      const decisionCondition: Conditions = [["ledger_event_id", eventId]];
      if (rawCount(db, "finance_refund_decision", decisionCondition) !== 1n)
        bad("REFUND_DECISION_UNRESOLVED", "ledger_event");
      for (const decision of rawRows(db, "finance_refund_decision", decisionCondition)) {
        const doc = field("finance_refund_decision", decision, "finance_document_id");
        link("REFUND_DECISION", "finance_refund_decision", decision, doc);
        if (!doc || field("finance_refund_decision", decision, "decision") !== "APPROVED" ||
            field("finance_refund_decision", decision, "posting_status") !== "POSTED")
          bad("REFUND_DECISION_INVALID", "finance_refund_decision", decision);
        const docCondition: Conditions = [["finance_document_id", doc]];
        const effectsCount = rawCount(db, "weekly_fee_refund_effect", docCondition);
        const itemsCount = rawCount(db, "finance_refund_submission_item", docCondition);
        if (effectsCount === 0n || effectsCount !== itemsCount)
          bad("REFUND_EFFECT_OR_ITEM_MISSING", "finance_refund_decision", decision);
        // Preserve every item, including orphan items that have no matching effect.
        for (const item of rawRows(db, "finance_refund_submission_item", docCondition)) {
          const fee = field("finance_refund_submission_item", item, "weekly_fee_entry_id");
          link("REFUND_SUBMISSION_ITEM", "finance_refund_submission_item", item, doc, null, null, fee,
            field("finance_refund_submission_item", item, "submitted_fee_version"),
            field("finance_refund_submission_item", item, "settlement_month"));
          if (!fee || rawCount(db, "weekly_fee_refund_effect", [...docCondition, ["weekly_fee_entry_id", fee]]) !== 1n)
            bad("REFUND_ITEM_EFFECT_MISMATCH", "finance_refund_submission_item", item);
        }
        for (const effect of rawRows(db, "weekly_fee_refund_effect", docCondition)) {
          const fee = field("weekly_fee_refund_effect", effect, "weekly_fee_entry_id");
          const version = field("weekly_fee_refund_effect", effect, "source_weekly_fee_version");
          const snapshotId = field("weekly_fee_refund_effect", effect, "allocation_snapshot_id");
          link("REFUND_EFFECT", "weekly_fee_refund_effect", effect, doc, null, snapshotId, fee, version);
          const item = single(db, "finance_refund_submission_item", [...docCondition, ["weekly_fee_entry_id", fee]]);
          if (!item || field("finance_refund_submission_item", item, "submitted_fee_version") !== version)
            bad("REFUND_EFFECT_ITEM_MISMATCH", "weekly_fee_refund_effect", effect);
          const snapshot = snapshotId ? single(db, "weekly_fee_allocation_snapshot", [["id", snapshotId]]) : undefined;
          if (snapshot) {
            link("ALLOCATION_SNAPSHOT", "weekly_fee_allocation_snapshot", snapshot, doc,
              field("weekly_fee_allocation_snapshot", snapshot, "run_id"), snapshotId,
              field("weekly_fee_allocation_snapshot", snapshot, "weekly_fee_entry_id"),
              field("weekly_fee_allocation_snapshot", snapshot, "source_weekly_fee_version"));
          }
          if (!snapshot || field("weekly_fee_allocation_snapshot", snapshot, "weekly_fee_entry_id") !== fee ||
              field("weekly_fee_allocation_snapshot", snapshot, "source_weekly_fee_version") !== version)
            bad("REFUND_ALLOCATION_SNAPSHOT_UNRESOLVED", "weekly_fee_refund_effect", effect);
          const lockedMonth = addHistorical(fee, version, doc, null, snapshotId);
          if (!lockedMonth) bad("REFUND_FEE_VERSION_UNRESOLVED", "weekly_fee_refund_effect", effect);
          else if (!item || field("finance_refund_submission_item", item, "settlement_month") !== lockedMonth)
            bad("REFUND_MONTH_MISMATCH", "weekly_fee_refund_effect", effect);
        }
      }
    }
    const supported = eventType === "WEEKLY_FEE_SETTLEMENT" || eventType === "WEEKLY_FEE_REFUND";
    const monthCount = BigInt(count(db, "SELECT count(*) n FROM event_month WHERE event_id=?", eventId));
    const status: LedgerBusinessPeriodStatus = !supported ? "UNIMPLEMENTED_EVENT_TYPE" :
      !valid || monthCount === 0n ? "UNRESOLVED" : monthCount === 1n ? "UNIQUE_LOCKED_SETTLEMENT_MONTH" : "MULTIPLE_BUSINESS_PERIODS";
    const uniqueMonth = status === "UNIQUE_LOCKED_SETTLEMENT_MONTH"
      ? text(db.prepare("SELECT month FROM event_month WHERE event_id=? LIMIT 1").get(eventId) as Record<string, unknown>, "month") : null;
    insertResult.run(eventId,event.k,eventType,status,uniqueMonth,monthCount.toString(),linkCount.toString(),anomalyCount.toString());
  }
};
