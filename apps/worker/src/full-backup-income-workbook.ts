import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  assertPrivateBackupDirectory,
  hashBackupFile,
  openPrivateBackupFile,
  syncBackupDirectory,
  writeBackupBytes,
} from "./backup-file-io.js";
import { BACKUP_MAX_DATA_ROWS } from "./full-backup-layout.js";
import {
  FullBackupDerivedSpoolIndex,
  type DerivedSpoolIndexMetadata,
  type DerivedSpoolIndexRow,
} from "./full-backup-derived-spool-index.js";
import {
  FullBackupIncomeDerivedView,
  type IncomeDerivedContribution,
  type IncomeDerivedMetadata,
  type IncomeDerivedMonthlyRow,
} from "./full-backup-income-derived-view.js";
import { fullBackupOutputColumns } from "./full-backup-transformer.js";
import { splitBackupLongText } from "./full-backup-long-text.js";
import {
  createManifestWorkbookRows,
  type FullBackupManifestContext,
  type ManifestSheetPart,
} from "./full-backup-manifest.js";
import {
  writeXlsx,
  type XlsxOptions,
  type XlsxSheet,
} from "./openxml-xlsx-writer.js";

type Text = string | null;
type Row = readonly string[];
type Writer = (options: XlsxOptions) => Promise<void>;
const KEYS = [
  "referrer",
  "planningMentor",
  "groupLeader",
  "teachingMentor",
  "venue",
  "campusConsultation",
  "platformFinance",
  "regionFinance",
  "teachingTeacher",
] as const;
const KEY_LABEL: Readonly<Record<(typeof KEYS)[number], string>> =
  Object.freeze({
    referrer: "转介绍",
    planningMentor: "规划导师",
    groupLeader: "教研组长",
    teachingMentor: "教学指导导师",
    venue: "场地使用费",
    campusConsultation: "校区咨询平台费",
    platformFinance: "平台财务",
    regionFinance: "分区财务",
    teachingTeacher: "授课教师",
  });
/** The derived table reads only this declared subset of the frozen RAW index. */
const INCOME_SOURCE_TABLES = Object.freeze([
  "settlement_account",
  "weekly_fee_entry",
  "weekly_fee_entry_version",
  "weekly_fee_allocation_snapshot",
  "finance_document",
  "finance_refund_decision",
  "finance_refund_submission_item",
  "weekly_fee_refund_effect",
  "ledger_event",
  "ledger_entry",
]);
const LONG_COLUMNS = [
  "long_text_ref",
  "source_table",
  "source_record_key",
  "source_row_number",
  "field_name",
  "part_no",
  "part_text",
] as const;
const NULL_COLUMNS = [
  "source_table",
  "source_record_key",
  "source_row_number",
  "field_name",
] as const;
export const FULL_BACKUP_INCOME_WORKBOOK_SCHEMA_VERSION =
  "full-backup-income-workbook.v1";
const fail = (code: string): never => {
  throw new Error(code);
};
const pages = (n: bigint, size: number): number => {
  const p = n === 0n ? 1n : (n + BigInt(size) - 1n) / BigInt(size);
  if (p > 9999n) fail("EXPORT_INCOME_WORKBOOK_PAGE_LIMIT");
  return Number(p);
};
/** Decimal text is created from the signed integer-cent value; Excel never receives a Number or formula. */
const beans = (cents: bigint): string => {
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
};

export type FullBackupIncomeWorkbookOptions = Readonly<{
  index: FullBackupDerivedSpoolIndex;
  view: FullBackupIncomeDerivedView;
  outputRoot: string;
  /** Optional fixed package context. Omit it to preserve the legacy workbook shape. */
  manifestContext?: FullBackupManifestContext;
  writeWorkbook?: Writer;
  maxDataRows?: number;
}>;
export type FullBackupIncomeWorkbookResult = Readonly<{
  mode: "INCOME_DERIVED_WORKBOOK";
  complete: false;
  tableNumber: 3;
  coveredTables: readonly [3];
  schemaVersion: typeof FULL_BACKUP_INCOME_WORKBOOK_SCHEMA_VERSION;
  outputId: string;
  spoolId: string;
  snapshotId: string;
  asOf: string;
  status: IncomeDerivedMetadata["status"];
  publishedVersion: null;
  gaps: readonly string[];
  sourceBasis: IncomeDerivedMetadata["sourceBasis"];
  file: string;
  sizeBytes: string;
  sha256: string;
  monthlyRowCount: string;
  contributionRowCount: string;
  anomalyCount: string;
}>;

class DiskRows {
  private count = 0n;
  private closed = false;
  private constructor(
    private readonly file: FileHandle,
    readonly relative: string,
  ) {}
  static async create(root: string, relative: string): Promise<DiskRows> {
    return new DiskRows(
      await open(join(root, relative), "wx", 0o600),
      relative,
    );
  }
  async add(row: readonly string[]): Promise<void> {
    if (this.closed) fail("EXPORT_INCOME_WORKBOOK_INDEX_CLOSED");
    await writeBackupBytes(
      this.file,
      Buffer.from(`${JSON.stringify(row)}\n`, "utf8"),
    );
    this.count++;
  }
  async seal() {
    if (!this.closed) {
      await this.file.sync();
      await this.file.close();
      this.closed = true;
    }
  }
  async dispose() {
    if (!this.closed) {
      await this.file.close().catch(() => undefined);
      this.closed = true;
    }
  }
  rowCount() {
    return this.count;
  }
}
async function* readRows(
  root: string,
  relative: string,
  width: number,
): AsyncGenerator<Row> {
  const file = await openPrivateBackupFile(root, relative);
  let primary: unknown;
  try {
    const buffer = Buffer.allocUnsafe(65536),
      decoder = new StringDecoder("utf8");
    let pending = "";
    const take = (line: string): Row => {
      let x: unknown;
      try {
        x = JSON.parse(line);
      } catch {
        return fail("EXPORT_INCOME_WORKBOOK_INDEX_INVALID");
      }
      if (
        !Array.isArray(x) ||
        x.length !== width ||
        x.some((v) => typeof v !== "string")
      )
        fail("EXPORT_INCOME_WORKBOOK_INDEX_INVALID");
      return x as Row;
    };
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      pending += decoder.write(buffer.subarray(0, bytesRead));
      for (;;) {
        const i = pending.indexOf("\n");
        if (i < 0) break;
        yield take(pending.slice(0, i).replace(/\r$/u, ""));
        pending = pending.slice(i + 1);
      }
    }
    pending += decoder.end();
    if (pending.length) fail("EXPORT_INCOME_WORKBOOK_INDEX_INVALID");
  } catch (e) {
    primary = e;
    throw e;
  } finally {
    try {
      await file.close();
    } catch (e) {
      if (primary !== undefined)
        throw new AggregateError(
          [primary, e],
          "EXPORT_INCOME_WORKBOOK_INDEX_CLEANUP_FAILED",
          { cause: primary },
        );
      throw e;
    }
  }
}
class Pager {
  private iterator: AsyncIterator<Row> | undefined;
  private next = 1;
  private done = false;
  constructor(
    private readonly root: string,
    private readonly rows: DiskRows,
    private readonly width: number,
    private readonly size: number,
  ) {}
  async *page(page: number): AsyncGenerator<Row> {
    if (page !== this.next || this.done)
      fail("EXPORT_INCOME_WORKBOOK_PAGE_SEQUENCE_INVALID");
    this.iterator ??= readRows(this.root, this.rows.relative, this.width)[
      Symbol.asyncIterator
    ]();
    const remaining =
      this.rows.rowCount() - BigInt(page - 1) * BigInt(this.size);
    const expected = Number(
      remaining > BigInt(this.size) ? BigInt(this.size) : remaining,
    );
    let primary: unknown;
    try {
      for (let i = 0; i < expected; i++) {
        const n = await this.iterator.next();
        if (n.done) fail("EXPORT_INCOME_WORKBOOK_INDEX_EARLY_EOF");
        yield n.value;
      }
      this.next++;
      if (page === pages(this.rows.rowCount(), this.size)) {
        if (!(await this.iterator.next()).done)
          fail("EXPORT_INCOME_WORKBOOK_INDEX_COUNT_CHANGED");
        this.done = true;
      }
    } catch (e) {
      primary = e;
      throw e;
    } finally {
      if (this.done) await this.dispose(primary);
    }
  }
  async dispose(primary?: unknown) {
    const it = this.iterator;
    this.iterator = undefined;
    if (!it) return;
    try {
      await it.return?.();
    } catch (e) {
      if (primary !== undefined)
        throw new AggregateError(
          [primary, e],
          "EXPORT_INCOME_WORKBOOK_INDEX_CLEANUP_FAILED",
          { cause: primary },
        );
      throw e;
    }
  }
}
const mapValues = (row: DerivedSpoolIndexRow, columns: readonly string[]) =>
  Object.fromEntries(columns.map((c, i) => [c, row.values[i]!])) as Record<
    string,
    Text
  >;
const idLookup = async (
  index: FullBackupDerivedSpoolIndex,
  table: string,
  id: string,
): Promise<DerivedSpoolIndexRow | undefined> =>
  index.lookup(table, [["id", id]]);
const columns = async () => import("./full-backup-transformer.js");

const assertManifestSources = async (
  context: FullBackupManifestContext,
  derivedIndex: FullBackupDerivedSpoolIndex,
  index: DerivedSpoolIndexMetadata,
  meta: IncomeDerivedMetadata,
): Promise<void> => {
  if (context.spoolId !== index.spoolId || context.snapshotId !== index.snapshotId ||
    context.asOf !== index.asOf)
    fail("EXPORT_INCOME_WORKBOOK_MANIFEST_SNAPSHOT_MISMATCH");
  const indexed = new Map(index.sources.map((source) => [source.tableName, source]));
  const contextual = new Map(context.rawTables.map((source) => [source.tableName, source]));
  if (indexed.size !== index.sources.length || contextual.size !== context.rawTables.length ||
    contextual.size !== indexed.size)
    fail("EXPORT_INCOME_WORKBOOK_MANIFEST_SOURCE_MISMATCH");
  for (const source of context.rawTables) {
    const indexedSource = indexed.get(source.tableName);
    if (indexedSource === undefined || source.rowCount !== indexedSource.rowCount)
      fail("EXPORT_INCOME_WORKBOOK_MANIFEST_SOURCE_MISMATCH");
    const digest = createHash("sha256");
    digest.update(`${JSON.stringify({ columns: fullBackupOutputColumns(source.tableName) })}\n`, "utf8");
    let rowCount = 0n;
    let firstStableKey: string | null = null;
    let lastStableKey: string | null = null;
    for await (const row of derivedIndex.stream(source.tableName)) {
      rowCount += 1n;
      firstStableKey ??= row.sourceRecordKey;
      lastStableKey = row.sourceRecordKey;
      digest.update(`${JSON.stringify(row.values)}\n`, "utf8");
    }
    if (rowCount.toString() !== source.rowCount ||
      firstStableKey !== source.firstStableKey || lastStableKey !== source.lastStableKey ||
      digest.digest("hex") !== source.logicalDigest)
      fail("EXPORT_INCOME_WORKBOOK_MANIFEST_SOURCE_MISMATCH");
  }
  const declared = new Map(
    meta.sourceBasis.sourceRows.map((source) => [source.tableName, source]),
  );
  if (
    meta.sourceBasis.indexMode !== "DERIVED_SPOOL_INDEX" ||
    declared.size !== meta.sourceBasis.sourceRows.length ||
    declared.size !== INCOME_SOURCE_TABLES.length
  )
    fail("EXPORT_INCOME_WORKBOOK_MANIFEST_SOURCE_MISMATCH");
  for (const tableName of INCOME_SOURCE_TABLES) {
    const declaredSource = declared.get(tableName);
    const indexedSource = indexed.get(tableName);
    if (
      declaredSource === undefined ||
      indexedSource === undefined ||
      declaredSource.rowCount !== indexedSource.rowCount
    )
      fail("EXPORT_INCOME_WORKBOOK_MANIFEST_SOURCE_MISMATCH");
  }
};

/** Fixed table-3 workbook. It accepts only a matching, already materialized derived view and RAW index. */
export class FullBackupIncomeWorkbook {
  private readonly max: number;
  private readonly writer: Writer;
  constructor(private readonly options: FullBackupIncomeWorkbookOptions) {
    this.max = options.maxDataRows ?? BACKUP_MAX_DATA_ROWS;
    if (
      !Number.isInteger(this.max) ||
      this.max < 1 ||
      this.max > BACKUP_MAX_DATA_ROWS
    )
      fail("EXPORT_INCOME_WORKBOOK_PAGE_SIZE_INVALID");
    this.writer = options.writeWorkbook ?? writeXlsx;
  }
  async export(): Promise<FullBackupIncomeWorkbookResult> {
    const meta = this.options.view.metadata(),
      indexMeta = this.options.index.metadata();
    if (
      meta.spoolId !== indexMeta.spoolId ||
      meta.snapshotId !== indexMeta.snapshotId ||
      meta.asOf !== indexMeta.asOf
    )
      fail("EXPORT_INCOME_WORKBOOK_SNAPSHOT_MISMATCH");
    if (this.options.manifestContext !== undefined)
      await assertManifestSources(this.options.manifestContext, this.options.index, indexMeta, meta);
    let out: string | undefined,
      monthly: DiskRows | undefined,
      trace: DiskRows | undefined,
      anomalies: DiskRows | undefined,
      explanationIndex: DiskRows | undefined,
      manifest: DiskRows | undefined,
      long: DiskRows | undefined,
      nil: DiskRows | undefined;
    const pagers: Pager[] = [];
    let primary: unknown;
    let result: FullBackupIncomeWorkbookResult | undefined;
    try {
      await mkdir(this.options.outputRoot, { recursive: true, mode: 0o700 });
      const root = await assertPrivateBackupDirectory(this.options.outputRoot);
      out = await mkdtemp(join(root, "full-backup-income-derived-"));
      await chmod(out, 0o700);
      out = await assertPrivateBackupDirectory(out);
      monthly = await DiskRows.create(out, ".income-monthly.ndjson");
      trace = await DiskRows.create(out, ".income-trace.ndjson");
      anomalies = await DiskRows.create(out, ".income-anomalies.ndjson");
      explanationIndex = await DiskRows.create(
        out,
        ".income-explanation.ndjson",
      );
      if (this.options.manifestContext !== undefined)
        manifest = await DiskRows.create(out, ".income-manifest.ndjson");
      long = await DiskRows.create(out, ".income-long.ndjson");
      nil = await DiskRows.create(out, ".income-null.ndjson");
      const rowNumbers = new Map<string, bigint>();
      const cell = async (
        value: Text,
        table: string,
        key: string,
        rowNumber: bigint,
        field: string,
      ): Promise<string> => {
        if (value === null) {
          await nil!.add([table, key, rowNumber.toString(), field]);
          return "";
        }
        const split = splitBackupLongText(value);
        if (split === null) return value;
        for (const [i, part] of split.chunks.entries())
          await long!.add([
            split.reference,
            table,
            key,
            rowNumber.toString(),
            field,
            String(i + 1),
            part,
          ]);
        return split.reference;
      };
      const cells = async (
        values: readonly Text[],
        table: string,
        key: string,
        fields: readonly string[],
      ): Promise<string[]> => {
        if (values.length !== fields.length)
          fail("EXPORT_INCOME_WORKBOOK_ROW_INVALID");
        const rowNumber = (rowNumbers.get(table) ?? 0n) + 1n;
        rowNumbers.set(table, rowNumber);
        const normalized: string[] = [];
        for (const [index, value] of values.entries())
          normalized.push(
            await cell(value, table, key, rowNumber, fields[index]!),
          );
        return normalized;
      };
      const name = async (
        row: IncomeDerivedMonthlyRow,
      ): Promise<string | null> => {
        if (row.ownerType === "PERSON") {
          const raw = await idLookup(this.options.index, "person", row.ownerId);
          if (!raw) return null;
          const m = mapValues(
            raw,
            (await columns()).fullBackupOutputColumns("person"),
          );
          return m.nickname ?? null;
        }
        if (row.ownerType === "VENUE") {
          const raw = await idLookup(this.options.index, "venue", row.ownerId);
          if (!raw) return null;
          const m = mapValues(
            raw,
            (await columns()).fullBackupOutputColumns("venue"),
          );
          return m.name ?? null;
        }
        return null;
      };
      let group: IncomeDerivedMonthlyRow[] = [];
      const flush = async () => {
        if (!group.length) return;
        const first = group[0]!,
          display = await name(first),
          by = new Map(group.map((r) => [r.allocationKey, r]));
        const key = JSON.stringify([
          ["account_id", first.accountId],
          ["settlement_month", first.settlementMonth],
        ]);
        const base = [
          first.accountId,
          first.accountCode,
          first.ownerType,
          first.ownerId,
          display,
          first.settlementMonth,
          first.financeYear,
        ];
        const values: string[] = [];
        for (const allocationKey of KEYS) {
          const r = by.get(allocationKey),
            positive = r?.positiveCents ?? 0n,
            refund = r?.refundCents ?? 0n,
            net = r?.netCents ?? 0n;
          values.push(
            beans(positive),
            beans(positive),
            beans(refund),
            beans(refund),
            beans(net),
            beans(net),
          );
        }
        await monthly!.add(
          await cells([...base, ...values], "income_monthly", key, [
            "account_id",
            "account_code",
            "owner_type",
            "owner_id",
            "display_name",
            "settlement_month",
            "finance_year",
            ...KEYS.flatMap((k) => [
              `${k}_positive_beans_exact`,
              `${k}_positive_beans_display`,
              `${k}_refund_beans_exact`,
              `${k}_refund_beans_display`,
              `${k}_net_beans_exact`,
              `${k}_net_beans_display`,
            ]),
          ]),
        );
        for (const r of group) {
          for await (const c of this.options.view.streamContributionSources({
            accountId: r.accountId,
            settlementMonth: r.settlementMonth,
            allocationKey: r.allocationKey,
          })) {
            const sourceKey = JSON.stringify([
              ["account_id", c.accountId],
              ["settlement_month", c.settlementMonth],
              ["allocation_key", c.allocationKey],
              ["fee_id", c.feeEntryId],
              ["snapshot_id", c.allocationSnapshotId],
              ["refund_document_id", c.refundFinanceDocumentId],
            ]);
            const vals = [
              c.accountId,
              first.accountCode,
              display,
              c.settlementMonth,
              c.allocationKey,
              c.signedCents.toString(),
              beans(c.signedCents),
              beans(c.signedCents),
              c.refundFinanceDocumentId === null ? "正向分配" : "退款冲回",
              c.feeEntryId,
              c.feeVersion,
              c.allocationSnapshotId,
              c.allocationSnapshotSourceKey,
              c.settlementRunId,
              c.policyVersionId,
              c.refundFinanceDocumentId,
              c.refundEffectSourceKey,
            ];
            await trace!.add(
              await cells(vals, "income_contribution", sourceKey, [
                "account_id",
                "account_code",
                "display_name",
                "settlement_month",
                "allocation_key",
                "signed_cents",
                "signed_beans_exact",
                "signed_beans_display",
                "direction",
                "fee_entry_id",
                "fee_version",
                "allocation_snapshot_id",
                "allocation_snapshot_source_key",
                "settlement_run_id",
                "policy_version_id",
                "refund_finance_document_id",
                "refund_effect_source_key",
              ]),
            );
          }
        }
        group = [];
      };
      for await (const row of this.options.view.streamMonthlyRows()) {
        const same =
          group.length &&
          group[0]!.accountId === row.accountId &&
          group[0]!.settlementMonth === row.settlementMonth;
        if (!same) await flush();
        group.push(row);
      }
      await flush();
      for await (const a of this.options.view.streamAnomalies()) {
        const key = JSON.stringify([
          ["source_table", a.sourceTable],
          ["source_record_key", a.sourceRecordKey],
        ]);
        const vals = [a.code, a.sourceTable, a.sourceRecordKey, a.feeEntryId];
        await anomalies.add(
          await cells(vals, "income_anomaly", key, [
            "code",
            "source_table",
            "source_record_key",
            "fee_entry_id",
          ]),
        );
      }
      const sheets: XlsxSheet[] = [];
      const explanation: readonly (readonly string[])[] = [
        ["导出模式", "INCOME_DERIVED_WORKBOOK"],
        ["完整备份", "false"],
        ["覆盖业务表", "3（月度收入派生）"],
        ["派生状态", meta.status],
        ["已发布结算版本", ""],
        ["处理边界", "仅当前九项冻结分配及已验证退款链；未生成发布结算版本"],
        [
          "公司名称",
          "COMPANY owner_id 未存主体类别，名称不推断；保留账户ID和编号",
        ],
        ["RAW spool", meta.spoolId],
        ["快照", meta.snapshotId],
        ["快照时间", meta.asOf],
        ["异常数", meta.anomalyCount],
        ["未汇总费用数", meta.incompleteFeeCount],
        ["已知缺口", meta.gaps.join(", ")],
      ];
      for (const entry of explanation) {
        const field = entry[0]!;
        const content = entry[1]!;
        await explanationIndex.add(
          await cells([field, content], "income_explanation", field, [
            "field",
            "content",
          ]),
        );
      }
      if (this.options.manifestContext !== undefined) {
        const sheetParts: ManifestSheetPart[] = [];
        const addParts = (prefix: string, source: DiskRows): void => {
          const count = pages(source.rowCount(), this.max);
          for (let part = 1; part <= count; part += 1) {
            const start = BigInt(part - 1) * BigInt(this.max);
            const remaining = source.rowCount() - start;
            sheetParts.push({
              sheetId: count === 1 ? prefix : `${prefix}_${String(part).padStart(4, "0")}`,
              logicalName: prefix,
              partNo: String(part),
              rowCount: (remaining > BigInt(this.max) ? BigInt(this.max) : remaining).toString(),
              sourceTable: null,
              sourceLogicalDigest: null,
              pageLogicalDigest: null,
              summaryScope: "SOURCE_TABLE_DIGEST_ONLY",
            });
          }
        };
        addParts("01_月度收入", monthly!);
        addParts("02_来源明细", trace!);
        addParts("03_异常", anomalies!);
        const rows = createManifestWorkbookRows({
          context: this.options.manifestContext,
          spoolId: indexMeta.spoolId,
          snapshotId: indexMeta.snapshotId,
          asOf: indexMeta.asOf,
          file: "business-table-3-income-derived.xlsx",
          workbookRole: "BUSINESS_DERIVED",
          tableNumbers: [3],
          sheetParts,
        });
        for (const row of rows)
          await manifest!.add(await cells(row, "00_manifest", row[0], ["field", "content"]));
      }
      for (const x of [monthly, trace, anomalies, explanationIndex, long, nil])
        await x.seal();
      await manifest?.seal();
      if (manifest !== undefined) sheets.push({
        name: "00_manifest",
        columns: ["字段", "内容"],
        rows: readRows(out, manifest.relative, 2),
      });
      sheets.push({
        name: "00_说明",
        columns: ["字段", "内容"],
        rows: readRows(out, explanationIndex.relative, 2),
      });
      const add = (
        prefix: string,
        source: DiskRows,
        width: number,
        cols: readonly string[],
      ) => {
        const p = new Pager(out!, source, width, this.max);
        pagers.push(p);
        const count = pages(source.rowCount(), this.max);
        for (let n = 1; n <= count; n++)
          sheets.push({
            name:
              count === 1 ? prefix : `${prefix}_${String(n).padStart(4, "0")}`,
            columns: cols,
            rows: p.page(n),
          });
      };
      add("01_月度收入", monthly, 7 + KEYS.length * 6, [
        "结算账户ID",
        "结算账户编号",
        "账户类型",
        "账户主体ID",
        "账户显示名称",
        "结算月份",
        "财年",
        ...KEYS.flatMap((k) => [
          `${KEY_LABEL[k]}正向_beans_exact`,
          `${KEY_LABEL[k]}正向_beans_display`,
          `${KEY_LABEL[k]}退款_beans_exact`,
          `${KEY_LABEL[k]}退款_beans_display`,
          `${KEY_LABEL[k]}净额_beans_exact`,
          `${KEY_LABEL[k]}净额_beans_display`,
        ]),
      ]);
      add("02_来源明细", trace, 17, [
        "结算账户ID",
        "结算账户编号",
        "账户显示名称",
        "结算月份",
        "分配项目",
        "金额（分）",
        "金额_beans_exact",
        "金额_beans_display",
        "方向",
        "周费用ID",
        "周费用版本",
        "分配快照ID",
        "快照源记录键",
        "结算运行ID",
        "费率版本ID",
        "退款单据ID",
        "退款影响源记录键",
      ]);
      add("03_异常", anomalies, 4, [
        "异常代码",
        "源表",
        "源记录键",
        "周费用ID",
      ]);
      add("14_长文本", long, LONG_COLUMNS.length, LONG_COLUMNS);
      add("15_NULL坐标", nil, NULL_COLUMNS.length, NULL_COLUMNS);
      await this.writer({
        outputPath: join(out, "business-table-3-income-derived.xlsx"),
        sheets,
      });
      for (const x of [monthly, trace, anomalies, explanationIndex, long, nil])
        await rm(join(out, x.relative), { force: true });
      if (manifest !== undefined)
        await rm(join(out, manifest.relative), { force: true });
      await syncBackupDirectory(out);
      const integrity = await hashBackupFile(
        out,
        "business-table-3-income-derived.xlsx",
      );
      await syncBackupDirectory(root);
      result = Object.freeze({
        mode: "INCOME_DERIVED_WORKBOOK",
        complete: false,
        tableNumber: 3,
        coveredTables: [3] as const,
        schemaVersion: FULL_BACKUP_INCOME_WORKBOOK_SCHEMA_VERSION,
        outputId: out.split("/").at(-1)!,
        spoolId: meta.spoolId,
        snapshotId: meta.snapshotId,
        asOf: meta.asOf,
        status: meta.status,
        publishedVersion: null,
        gaps: Object.freeze([...meta.gaps]),
        sourceBasis: meta.sourceBasis,
        file: "business-table-3-income-derived.xlsx",
        sizeBytes: integrity.sizeBytes,
        sha256: integrity.sha256,
        monthlyRowCount: monthly.rowCount().toString(),
        contributionRowCount: trace.rowCount().toString(),
        anomalyCount: anomalies.rowCount().toString(),
      });
    } catch (e) {
      primary = e;
    }
    const cleanup: unknown[] = [];
    for (const p of pagers)
      try {
        await p.dispose(primary);
      } catch (e) {
        cleanup.push(e);
      }
    for (const x of [monthly, trace, anomalies, explanationIndex, manifest, long, nil])
      try {
        await x?.dispose();
      } catch (e) {
        cleanup.push(e);
      }
    if (
      (primary !== undefined || cleanup.length || result === undefined) &&
      out
    )
      try {
        await rm(out, { recursive: true, force: true });
      } catch (e) {
        cleanup.push(e);
      }
    if (primary !== undefined) {
      if (cleanup.length)
        throw new AggregateError(
          [primary, ...cleanup],
          "EXPORT_INCOME_WORKBOOK_CLEANUP_FAILED",
          { cause: primary },
        );
      throw primary;
    }
    if (cleanup.length)
      throw new AggregateError(
        cleanup,
        "EXPORT_INCOME_WORKBOOK_CLEANUP_FAILED",
      );
    return result ?? fail("EXPORT_INCOME_WORKBOOK_RESULT_MISSING");
  }
}
