import { chmod, mkdir, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { assertPrivateBackupDirectory, hashBackupFile, openPrivateBackupFile, syncBackupDirectory, writeBackupBytes } from "./backup-file-io.js";
import { BACKUP_MAX_DATA_ROWS } from "./full-backup-layout.js";
import { FullBackupDerivedSpoolIndex, type DerivedSpoolIndexRow } from "./full-backup-derived-spool-index.js";
import { FullBackupLedgerBusinessPeriodSource } from "./full-backup-ledger-business-period-source.js";
import { FullBackupLedgerDerivedView, type LedgerDerivedEntry, type LedgerDerivedMonthlyRow, type LedgerDerivedReconciliationRow } from "./full-backup-ledger-derived-view.js";
import { splitBackupLongText } from "./full-backup-long-text.js";
import { writeXlsx, type XlsxOptions, type XlsxSheet } from "./openxml-xlsx-writer.js";

type Text = string | null;
type Row = readonly string[];
type Writer = (options: XlsxOptions) => Promise<void>;
const LONG_COLUMNS = ["long_text_ref", "source_table", "source_record_key", "source_row_number", "field_name", "part_no", "part_text"] as const;
const NULL_COLUMNS = ["source_table", "source_record_key", "source_row_number", "field_name"] as const;
export const LEDGER_WORKBOOK_SCHEMA_VERSION = "ledger-workbook.v1";
export const LEDGER_WORKBOOK_FIXED_GAPS = Object.freeze(["TABLE_7_LEDGER_DERIVED_ONLY", "PUBLISHED_SETTLEMENT_SNAPSHOTS_NOT_IMPLEMENTED", "BUSINESS_PERIOD_SOURCE_PARTIAL"]);
/** Reconstructable package metadata. Ledger coverage comes only from the matching view. */
export const ledgerWorkbookGaps = (ledgerCoverageGaps: readonly string[]): readonly string[] => Object.freeze([...ledgerCoverageGaps, ...LEDGER_WORKBOOK_FIXED_GAPS]);
const fail = (code: string): never => { throw new Error(code); };
const pages = (count: bigint, size: number): number => {
  const value = count === 0n ? 1n : (count + BigInt(size) - 1n) / BigInt(size);
  if (value > 9999n) fail("EXPORT_LEDGER_WORKBOOK_PAGE_LIMIT");
  return Number(value);
};
const centsToBeans = (value: Text): Text => {
  if (value === null || !/^-?(?:0|[1-9]\d*)$/.test(value)) return null;
  const negative = value.startsWith("-");
  const digits = (negative ? value.slice(1) : value).padStart(3, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)}`;
};
const controlledText = (value: string): string => {
  if (splitBackupLongText(value) !== null) fail("EXPORT_LEDGER_WORKBOOK_METADATA_TOO_LONG");
  return value;
};

export type FullBackupLedgerWorkbookOptions = Readonly<{
  index: FullBackupDerivedSpoolIndex;
  ledger: FullBackupLedgerDerivedView;
  periods: FullBackupLedgerBusinessPeriodSource;
  outputRoot: string;
  /** @internal Test seam. Production always uses the OpenXML string-only writer. */
  writeWorkbook?: Writer;
  /** @internal Test seam bounded by the production page limit. */
  maxDataRows?: number;
}>;

export type FullBackupLedgerWorkbookResult = Readonly<{
  mode: "LEDGER_DERIVED_WORKBOOK";
  complete: false;
  tableNumber: 7;
  schemaVersion: typeof LEDGER_WORKBOOK_SCHEMA_VERSION;
  outputId: string;
  spoolId: string;
  snapshotId: string;
  asOf: string;
  file: "business-table-7-ledger-derived.xlsx";
  sizeBytes: string;
  sha256: string;
  coveredTables: readonly [7];
  gaps: readonly string[];
  entryRowCount: string;
  monthlyRowCount: string;
  reconciliationRowCount: string;
  ledgerAnomalyCount: string;
  periodEventCount: string;
  periodLinkCount: string;
  periodAnomalyCount: string;
}>;

class DiskRows {
  private count = 0n;
  private sealed = false;
  private constructor(private readonly file: FileHandle, readonly relative: string) {}
  static async create(root: string, relative: string): Promise<DiskRows> {
    return new DiskRows(await open(join(root, relative), "wx", 0o600), relative);
  }
  async add(row: readonly string[]): Promise<void> {
    if (this.sealed) fail("EXPORT_LEDGER_WORKBOOK_INDEX_CLOSED");
    await writeBackupBytes(this.file, Buffer.from(`${JSON.stringify(row)}\n`, "utf8"));
    this.count++;
  }
  async seal(): Promise<void> { if (!this.sealed) { await this.file.sync(); await this.file.close(); this.sealed = true; } }
  async dispose(): Promise<void> { if (!this.sealed) { await this.file.close().catch(() => undefined); this.sealed = true; } }
  rowCount(): bigint { return this.count; }
}

async function* readRows(root: string, relative: string, width: number): AsyncGenerator<Row> {
  const file = await openPrivateBackupFile(root, relative); let primary: unknown;
  const parse = (line: string): Row => {
    let value: unknown;
    try { value = JSON.parse(line); } catch { return fail("EXPORT_LEDGER_WORKBOOK_INDEX_INVALID"); }
    if (!Array.isArray(value) || value.length !== width || value.some((cell) => typeof cell !== "string")) fail("EXPORT_LEDGER_WORKBOOK_INDEX_INVALID");
    return value as Row;
  };
  try {
    const buffer = Buffer.allocUnsafe(65536), decoder = new StringDecoder("utf8"); let pending = "";
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
      pending += decoder.write(buffer.subarray(0, bytesRead));
      for (;;) { const at = pending.indexOf("\n"); if (at < 0) break; yield parse(pending.slice(0, at).replace(/\r$/u, "")); pending = pending.slice(at + 1); }
    }
    pending += decoder.end(); if (pending.length) fail("EXPORT_LEDGER_WORKBOOK_INDEX_INVALID");
  } catch (error) { primary = error; throw error; }
  finally {
    try { await file.close(); }
    catch (error) {
      if (primary !== undefined)
        throw new AggregateError([primary, error], "EXPORT_LEDGER_WORKBOOK_INDEX_CLEANUP_FAILED", { cause: primary });
      throw error;
    }
  }
}

class Pager {
  private iterator: AsyncIterator<Row> | undefined; private next = 1; private done = false;
  constructor(private readonly root: string, private readonly rows: DiskRows, private readonly width: number, private readonly size: number) {}
  async *page(page: number): AsyncGenerator<Row> {
    if (page !== this.next || this.done) fail("EXPORT_LEDGER_WORKBOOK_PAGE_SEQUENCE_INVALID");
    this.iterator ??= readRows(this.root, this.rows.relative, this.width)[Symbol.asyncIterator]();
    const remaining = this.rows.rowCount() - BigInt(page - 1) * BigInt(this.size);
    const expected = Number(remaining > BigInt(this.size) ? BigInt(this.size) : remaining); let primary: unknown;
    try {
      for (let i = 0; i < expected; i++) { const row = await this.iterator.next(); if (row.done) fail("EXPORT_LEDGER_WORKBOOK_INDEX_EARLY_EOF"); yield row.value; }
      this.next++;
      if (page === pages(this.rows.rowCount(), this.size)) { if (!(await this.iterator.next()).done) fail("EXPORT_LEDGER_WORKBOOK_INDEX_COUNT_CHANGED"); this.done = true; }
    } catch (error) { primary = error; throw error; }
    finally { if (this.done) await this.dispose(primary); }
  }
  async dispose(primary?: unknown): Promise<void> {
    const iterator = this.iterator; this.iterator = undefined; if (!iterator) return;
    try { await iterator.return?.(); }
    catch (error) {
      if (primary !== undefined)
        throw new AggregateError([primary, error], "EXPORT_LEDGER_WORKBOOK_INDEX_CLEANUP_FAILED", { cause: primary });
      throw error;
    }
  }
}

const rowValues = (row: DerivedSpoolIndexRow, columns: readonly string[]) =>
  Object.fromEntries(columns.map((column, index) => [column, row.values[index]!])) as Record<string, Text>;
const outputColumns = async () => (await import("./full-backup-transformer.js")).fullBackupOutputColumns;

/**
 * Fixed table-7 evidence workbook. It serializes bounded derived streams to
 * private NDJSON before paging them into XLSX; no event or entry collection is
 * retained in process memory.
 */
export class FullBackupLedgerWorkbook {
  private readonly max: number;
  private readonly writer: Writer;
  public constructor(private readonly options: FullBackupLedgerWorkbookOptions) {
    this.max = options.maxDataRows ?? BACKUP_MAX_DATA_ROWS;
    if (!Number.isInteger(this.max) || this.max < 1 || this.max > BACKUP_MAX_DATA_ROWS) fail("EXPORT_LEDGER_WORKBOOK_PAGE_SIZE_INVALID");
    this.writer = options.writeWorkbook ?? writeXlsx;
  }
  public async export(): Promise<FullBackupLedgerWorkbookResult> {
    const index = this.options.index.metadata(), ledger = this.options.ledger.metadata(), periods = this.options.periods.metadata();
    if (index.spoolId !== ledger.spoolId || index.snapshotId !== ledger.snapshotId || index.asOf !== ledger.asOf ||
        index.spoolId !== periods.spoolId || index.snapshotId !== periods.snapshotId || index.asOf !== periods.asOf)
      fail("EXPORT_LEDGER_WORKBOOK_SNAPSHOT_MISMATCH");
    let out: string | undefined; let primary: unknown; let result: FullBackupLedgerWorkbookResult | undefined;
    let entry: DiskRows | undefined, monthly: DiskRows | undefined, reconciliation: DiskRows | undefined, ledgerAnomaly: DiskRows | undefined;
    let period: DiskRows | undefined, link: DiskRows | undefined, periodAnomaly: DiskRows | undefined, long: DiskRows | undefined, nil: DiskRows | undefined;
    const pagers: Pager[] = [];
    try {
      await mkdir(this.options.outputRoot, { recursive: true, mode: 0o700 }); const root = await assertPrivateBackupDirectory(this.options.outputRoot);
      out = await mkdtemp(join(root, "full-backup-ledger-derived-")); await chmod(out, 0o700); out = await assertPrivateBackupDirectory(out);
      entry = await DiskRows.create(out, ".ledger-entry.ndjson");
      monthly = await DiskRows.create(out, ".ledger-monthly.ndjson");
      reconciliation = await DiskRows.create(out, ".ledger-reconciliation.ndjson");
      ledgerAnomaly = await DiskRows.create(out, ".ledger-anomaly.ndjson");
      period = await DiskRows.create(out, ".ledger-period.ndjson");
      link = await DiskRows.create(out, ".ledger-period-link.ndjson");
      periodAnomaly = await DiskRows.create(out, ".ledger-period-anomaly.ndjson");
      long = await DiskRows.create(out, ".ledger-long.ndjson");
      nil = await DiskRows.create(out, ".ledger-null.ndjson");
      const rowNumbers = new Map<string, bigint>();
      const cell = async (value: Text, table: string, key: string, rowNumber: string, field: string): Promise<string> => {
        if (value === null) { await nil!.add([table, key, rowNumber, field]); return ""; }
        const split = splitBackupLongText(value); if (split === null) return value;
        for (const [part, text] of split.chunks.entries()) await long!.add([split.reference, table, key, rowNumber, field, String(part + 1), text]);
        return split.reference;
      };
      const ownerName = async (ownerType: Text, ownerId: Text): Promise<Text> => {
        if (ownerId === null || (ownerType !== "PERSON" && ownerType !== "VENUE")) return null;
        const table = ownerType === "PERSON" ? "person" : "venue";
        const source = await this.options.index.lookup(table, [["id", ownerId]]); if (!source) return null;
        const values = rowValues(source, (await outputColumns())(table)); return ownerType === "PERSON" ? values.nickname ?? null : values.name ?? null;
      };
      const record = async (target: DiskRows, table: string, key: string, columns: readonly string[], values: readonly Text[]) => {
        const rowNumber = ((rowNumbers.get(table) ?? 0n) + 1n).toString();
        rowNumbers.set(table, BigInt(rowNumber));
        const cells: string[] = [];
        for (const [index, value] of values.entries()) cells.push(await cell(value, table, key, rowNumber, columns[index]!));
        await target.add(cells);
      };
      const entryColumns = [
        "源记录键", "源行号", "分录ID", "事件ID", "账户ID", "分类",
        "金额原始分 [amount_cents_raw]", "金额豆精确 [amount_beans_exact]",
        "金额豆展示 [amount_beans_display]", "分录创建时间", "事件源记录键",
        "事件键指纹", "事件类型", "事件载荷哈希", "事件入账时间",
        "账户源记录键", "账户主体类型", "账户主体ID", "账户编号", "账户状态",
        "账户显示名称", "入账月", "财年开始", "来源链状态",
      ];
      for await (const row of this.options.ledger.streamEntries()) {
        const key = row.sourceRecordKey, beans = centsToBeans(row.amountCents), name = await ownerName(row.accountOwnerType, row.accountOwnerId);
        await record(entry, "ledger_entry", key, entryColumns, [
          row.sourceRecordKey, row.sourceRowNumber, row.entryId, row.eventId, row.accountId,
          row.categoryKey, row.amountCents, beans, beans, row.entryCreatedAt,
          row.eventSourceRecordKey, row.eventKeyFingerprint, row.eventType, row.eventPayloadHash,
          row.eventCreatedAt, row.accountSourceRecordKey, row.accountOwnerType, row.accountOwnerId,
          row.accountCode, row.accountStatus, name, row.postMonth, row.fiscalYearStart,
          row.sourceChainStatus,
        ]);
      }
      const monthlyColumns = [
        "账户ID", "入账月", "财年开始", "分类", "净额原始分 [signed_net_cents_raw]",
        "净额豆精确 [signed_net_beans_exact]", "净额豆展示 [signed_net_beans_display]",
        "分录数", "非法金额数", "状态", "账户类型", "账户主体ID", "账户编号", "账户显示名称",
      ];
      for await (const row of this.options.ledger.streamMonthlyRows()) {
        const account = await accountDetail(this.options.index, row.accountId);
        const beans = centsToBeans(row.signedNetCents);
        const key = JSON.stringify([row.accountId, row.postMonth, row.categoryKey]);
        await record(monthly, "ledger_monthly", key, monthlyColumns, [
          row.accountId, row.postMonth, row.fiscalYearStart, row.categoryKey, row.signedNetCents,
          beans, beans, row.entryCount, row.invalidAmountCount, row.status, account.ownerType,
          account.ownerId, account.accountCode, await ownerName(account.ownerType, account.ownerId),
        ]);
      }
      const reconciliationColumns = [
        "账户ID", "账户源记录键", "账户类型", "账户主体ID", "账户编号", "账户显示名称",
        "账本净额原始分 [ledger_net_cents_raw]", "账本净额豆精确 [ledger_net_beans_exact]",
        "账本净额豆展示 [ledger_net_beans_display]", "余额投影原始分 [projection_balance_cents_raw]",
        "余额投影豆精确 [projection_balance_beans_exact]", "余额投影豆展示 [projection_balance_beans_display]", "状态",
      ];
      for await (const row of this.options.ledger.streamReconciliations()) {
        const ledgerBeans = centsToBeans(row.ledgerNetCents), projectionBeans = centsToBeans(row.projectionBalanceCents);
        await record(reconciliation, "ledger_reconciliation", row.accountId, reconciliationColumns, [
          row.accountId, row.accountSourceRecordKey, row.accountOwnerType, row.accountOwnerId,
          row.accountCode, await ownerName(row.accountOwnerType, row.accountOwnerId),
          row.ledgerNetCents, ledgerBeans, ledgerBeans, row.projectionBalanceCents,
          projectionBeans, projectionBeans, row.status,
        ]);
      }
      const ledgerAnomalyColumns = ["异常代码", "源表", "源记录键", "源行号", "字段"];
      for await (const row of this.options.ledger.streamAnomalies()) {
        await record(ledgerAnomaly, "ledger_anomaly", row.sourceRecordKey, ledgerAnomalyColumns, [
          row.code, row.sourceTable, row.sourceRecordKey, row.sourceRowNumber, row.field,
        ]);
      }
      const periodColumns = ["事件ID", "事件源记录键", "事件类型", "业务期间状态", "唯一锁定结算月", "不同月份数", "来源链接数", "异常数"];
      for await (const row of this.options.periods.streamEventPeriods()) {
        await record(period, "business_period", row.eventSourceRecordKey, periodColumns, [
          row.eventId, row.eventSourceRecordKey, row.eventType, row.status,
          row.uniqueLockedSettlementMonth, row.distinctMonthCount, row.sourceLinkCount, row.anomalyCount,
        ]);
      }
      const linkColumns = ["事件ID", "事件源记录键", "关系", "源表", "源记录键", "源行号", "财务单据ID", "结算运行ID", "分配快照ID", "周费用ID", "周费用版本", "锁定结算月"];
      for await (const row of this.options.periods.streamSourceLinks()) {
        await record(link, "business_period_link", row.sourceRecordKey, linkColumns, [
          row.eventId, row.eventSourceRecordKey, row.relation, row.sourceTable, row.sourceRecordKey,
          row.sourceRowNumber, row.financeDocumentId, row.runId, row.allocationSnapshotId,
          row.weeklyFeeEntryId, row.weeklyFeeVersion, row.lockedSettlementMonth,
        ]);
      }
      const periodAnomalyColumns = ["异常代码", "事件ID", "事件源记录键", "源表", "源记录键", "源行号"];
      for await (const row of this.options.periods.streamAnomalies()) {
        await record(periodAnomaly, "business_period_anomaly", row.eventSourceRecordKey, periodAnomalyColumns, [
          row.code, row.eventId, row.eventSourceRecordKey, row.sourceTable, row.sourceRecordKey, row.sourceRowNumber,
        ]);
      }
      for (const rows of [entry, monthly, reconciliation, ledgerAnomaly, period, link, periodAnomaly, long, nil]) await rows.seal();
      const sheets: XlsxSheet[] = [{ name: "00_说明", columns: ["字段", "内容"], rows: [
        ["导出模式", "LEDGER_DERIVED_WORKBOOK"], ["完整备份", "false"],
        ["覆盖业务表", "7（账本派生）"], ["schema_version", LEDGER_WORKBOOK_SCHEMA_VERSION],
        ["RAW spool", controlledText(index.spoolId)], ["快照", controlledText(index.snapshotId)],
        ["快照时间", controlledText(index.asOf)],
        ["入账月口径", "仅 ledger_event.created_at 的 Asia/Shanghai 月；不等同业务结算月"],
        ["业务期间口径", "跨月事件唯一锁定结算月为空，状态为 MULTIPLE_BUSINESS_PERIODS；不复制或分摊原金额"],
        ["公司账户名称", "COMPANY owner_id 无主体类别，不推断名称；保留账户ID、编号及 owner_id"],
        ["金额", "金额原始分与 beans_exact/beans_display 均为字符串；非法原始金额仅保留原文，豆金额为空"],
        ["已发布结算", "未实现；本工作簿不声明已发布结算或完整F14"],
        ["账本异常数", controlledText(ledger.anomalyCount)],
        ["业务期间异常数", controlledText(periods.anomalyCount)],
        ["已知缺口", controlledText(ledgerWorkbookGaps(ledger.coverageGaps).join(", "))],
      ] }];
      const add = (name: string, rows: DiskRows, columns: readonly string[]) => {
        const pager = new Pager(out!, rows, columns.length, this.max);
        pagers.push(pager);
        const count = pages(rows.rowCount(), this.max);
        for (let page = 1; page <= count; page++) {
          sheets.push({
            name: count === 1 ? name : `${name}_${String(page).padStart(4, "0")}`,
            columns,
            rows: pager.page(page),
          });
        }
      };
      add("01_原始分录", entry, entryColumns);
      add("02_入账月汇总", monthly, monthlyColumns);
      add("03_账户余额对账", reconciliation, reconciliationColumns);
      add("04_账本异常", ledgerAnomaly, ledgerAnomalyColumns);
      add("05_业务期间", period, periodColumns);
      add("06_业务期间链接", link, linkColumns);
      add("07_业务期间异常", periodAnomaly, periodAnomalyColumns);
      add("14_长文本", long, LONG_COLUMNS);
      add("15_NULL坐标", nil, NULL_COLUMNS);
      const file = "business-table-7-ledger-derived.xlsx";
      await this.writer({ outputPath: join(out, file), sheets });
      for (const rows of [entry, monthly, reconciliation, ledgerAnomaly, period, link, periodAnomaly, long, nil]) await rm(join(out, rows.relative), { force: true });
      await syncBackupDirectory(out); const integrity = await hashBackupFile(out, file); await syncBackupDirectory(root);
      result = Object.freeze({
        mode: "LEDGER_DERIVED_WORKBOOK",
        complete: false,
        tableNumber: 7,
        schemaVersion: LEDGER_WORKBOOK_SCHEMA_VERSION,
        outputId: out.split("/").at(-1)!,
        spoolId: index.spoolId,
        snapshotId: index.snapshotId,
        asOf: index.asOf,
        file,
        sizeBytes: integrity.sizeBytes,
        sha256: integrity.sha256,
        coveredTables: [7] as const,
        gaps: ledgerWorkbookGaps(ledger.coverageGaps),
        entryRowCount: entry.rowCount().toString(),
        monthlyRowCount: monthly.rowCount().toString(),
        reconciliationRowCount: reconciliation.rowCount().toString(),
        ledgerAnomalyCount: ledgerAnomaly.rowCount().toString(),
        periodEventCount: period.rowCount().toString(),
        periodLinkCount: link.rowCount().toString(),
        periodAnomalyCount: periodAnomaly.rowCount().toString(),
      });
    } catch (error) { primary = error; }
    const cleanup: unknown[] = [];
    for (const pager of pagers) try { await pager.dispose(primary); } catch (error) { cleanup.push(error); }
    for (const rows of [entry, monthly, reconciliation, ledgerAnomaly, period, link, periodAnomaly, long, nil]) {
      try { await rows?.dispose(); } catch (error) { cleanup.push(error); }
    }
    if ((primary !== undefined || cleanup.length > 0 || result === undefined) && out) {
      try { await rm(out, { recursive: true, force: true }); } catch (error) { cleanup.push(error); }
    }
    if (primary !== undefined) { if (cleanup.length) throw new AggregateError([primary, ...cleanup], "EXPORT_LEDGER_WORKBOOK_CLEANUP_FAILED", { cause: primary }); throw primary; }
    if (cleanup.length) throw new AggregateError(cleanup, "EXPORT_LEDGER_WORKBOOK_CLEANUP_FAILED");
    return result ?? fail("EXPORT_LEDGER_WORKBOOK_RESULT_MISSING");
  }
}

const accountDetail = async (index: FullBackupDerivedSpoolIndex, accountId: string): Promise<{ ownerType: Text; ownerId: Text; accountCode: Text }> => {
  const row = await index.lookup("settlement_account", [["id", accountId]]); if (!row) return { ownerType: null, ownerId: null, accountCode: null };
  const values = rowValues(row, (await outputColumns())("settlement_account"));
  return { ownerType: values.owner_type ?? null, ownerId: values.owner_id ?? null, accountCode: values.account_code ?? null };
};
