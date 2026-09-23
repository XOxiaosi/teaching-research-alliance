import { chmod, mkdir, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { BUSINESS_BACKUP_COVERAGE_GAPS } from "./full-backup-business-schema.js";
import {
  FullBackupBusinessFactsView,
  type BusinessFactsViewDescription,
  type BusinessFactsViewRow,
  type BusinessFactsViewSource,
} from "./full-backup-business-facts-view.js";
import { BACKUP_MAX_DATA_ROWS } from "./full-backup-layout.js";
import { splitBackupLongText } from "./full-backup-long-text.js";
import { writeXlsx, type XlsxOptions, type XlsxSheet } from "./openxml-xlsx-writer.js";
import type { FullBackupSpoolResult } from "./full-backup-spool.js";
import {
  assertPrivateBackupDirectory,
  hashBackupFile,
  openPrivateBackupFile,
  syncBackupDirectory,
  writeBackupBytes,
} from "./backup-file-io.js";

type TextValue = string | null;
type TextRow = readonly TextValue[];
type WorkbookWriter = (options: XlsxOptions) => Promise<void>;

export type BusinessFactsWorkbookProfile = "TEACHER" | "STUDENT" | "FINANCE" | "PAYROLL" | "DEDUCTION" | "PERFORMANCE_CONFIGURATION";

export type FullBackupBusinessFactsWorkbookExportResult = Readonly<{
  mode: "BUSINESS_FACTS_WORKBOOK";
  complete: false;
  outputId: string;
  spoolId: string;
  snapshotId: string;
  asOf: string;
  file: string;
  sizeBytes: string;
  sha256: string;
  coveredTables: readonly [1] | readonly [2] | readonly [4] | readonly [5] | readonly [6] | readonly [8];
  /** Explicit known omissions; a caller must not infer a complete business backup. */
  gaps: readonly string[];
  schemaVersion: string;
  sourceRows: readonly Readonly<{ sourceTable: string; rowCount: string; logicalDigest: string }> [];
}>;

export type FullBackupBusinessFactsWorkbookExporterOptions = Readonly<{
  /** Internal, integrity-checked RAW spool. Its path is never put in the result. */
  spoolDirectory: string;
  spool: FullBackupSpoolResult;
  /** Only the fixed internal profiles below are accepted at runtime. */
  profile: BusinessFactsWorkbookProfile;
  /** Parent for this attempt's new private output directory. */
  outputRoot: string;
  /** @internal Test seam. Production always uses the OpenXML writer. */
  writeWorkbook?: WorkbookWriter;
  /** @internal Test seam, bounded to the production Excel page limit. */
  maxDataRows?: number;
}>;

const MAX_PARTS = 9_999;
const LONG_TEXT_COLUMNS = ["long_text_ref", "source_table", "source_record_key", "source_row_number", "field_name", "part_no", "part_text"] as const;
const NULL_COORDINATE_COLUMNS = ["source_table", "source_record_key", "source_row_number", "field_name"] as const;
const DERIVED_SCOPE_GAP = "DERIVED_TABLES_3_AND_7_NOT_GENERATED";

type FixedProfile = Readonly<{
  tableNumber: 1 | 2 | 4 | 5 | 6 | 8;
  file: string;
  attemptPrefix: string;
  temporaryIndexPrefix: string;
  sheetPrefix: "T1" | "T2" | "T4" | "T5" | "T6" | "T8";
  coveredTableLabel: string;
  tableScopeGap: string;
  completeSourceBoundary: string;
  sourceTitles: Readonly<Record<string, string>>;
}>;

const FIXED_PROFILES: Readonly<Record<BusinessFactsWorkbookProfile, FixedProfile>> = Object.freeze({
  TEACHER: Object.freeze({
    tableNumber: 1,
    file: "business-table-1-teacher-facts.xlsx",
    attemptPrefix: "full-backup-teacher-facts-",
    temporaryIndexPrefix: ".teacher",
    sheetPrefix: "T1",
    coveredTableLabel: "1（教师信息事实）",
    tableScopeGap: "BUSINESS_TABLES_2_TO_8_NOT_INCLUDED",
    completeSourceBoundary: "仅导出当前已声明字段；各源保留独立事实行，不按教师关联、筛选或汇总；user_account 不含密码、会话或认证秘密",
    sourceTitles: Object.freeze({
      person: "人员", user_account: "用户账号", teacher_profile: "教师资料", person_campus_assignment: "人员校区归属",
      role_assignment: "角色授予", person_relationship: "人员关系", organization_unit: "组织单元", venue: "场地",
      venue_permission_grant: "场地权限", settlement_account: "结算账户",
    }),
  }),
  STUDENT: Object.freeze({
    tableNumber: 2,
    file: "business-table-2-student-facts.xlsx",
    attemptPrefix: "full-backup-student-facts-",
    temporaryIndexPrefix: ".student",
    sheetPrefix: "T2",
    coveredTableLabel: "2（学生业务流水事实）",
    tableScopeGap: "BUSINESS_TABLES_1_3_TO_8_NOT_INCLUDED",
    completeSourceBoundary: "仅导出当前已声明字段；学生记录、推荐、接收快照、周费用及期间均为独立事实行，不按学生名合并、不生成收入或结算",
    sourceTitles: Object.freeze({
      teacher_student_record: "教师学生记录", referral_case: "推荐流水", referral_acceptance_snapshot: "推荐接收快照",
      weekly_fee_entry: "周费用", weekly_fee_entry_version: "周费用版本", weekly_fee_event: "周费用事件",
      weekly_fee_refund_effect: "周费用退款影响", teaching_week: "教学周", academic_period: "学期期间",
    }),
  }),
  DEDUCTION: Object.freeze({
    tableNumber: 6,
    file: "business-table-6-deduction-facts.xlsx",
    attemptPrefix: "full-backup-deduction-facts-",
    temporaryIndexPrefix: ".deduction",
    sheetPrefix: "T6",
    coveredTableLabel: "6（扣费事实）",
    tableScopeGap: "BUSINESS_TABLES_1_TO_5_7_TO_8_NOT_INCLUDED",
    completeSourceBoundary: "仅导出当前已声明字段；福利计划、待办与执行均为独立事实行，不关联、汇总或将计划待办当作已执行扣费；项目1至10扣费未建模",
    sourceTitles: Object.freeze({
      finance_benefit_plan_version: "福利计划版本", finance_benefit_todo: "福利扣费待办", finance_benefit_execution: "福利扣费执行",
    }),
  }),
  PERFORMANCE_CONFIGURATION: Object.freeze({
    tableNumber: 8,
    file: "business-table-8-performance-configuration-facts.xlsx",
    attemptPrefix: "full-backup-performance-configuration-facts-",
    temporaryIndexPrefix: ".performance-configuration",
    sheetPrefix: "T8",
    coveredTableLabel: "8（绩效配置事实）",
    tableScopeGap: "BUSINESS_TABLES_1_TO_7_NOT_INCLUDED",
    completeSourceBoundary: "仅导出当前已声明字段；全局策略版本与逐笔分配快照均为独立事实行，不按办理人或岗位比例裁剪，不把全局策略或实际快照冒充个人覆盖或班型配置",
    sourceTitles: Object.freeze({
      rate_policy_version: "费率策略版本", weekly_fee_allocation_snapshot: "逐笔分配快照",
    }),
  }),
  PAYROLL: Object.freeze({
    tableNumber: 5,
    file: "business-table-5-payroll-facts.xlsx",
    attemptPrefix: "full-backup-payroll-facts-",
    temporaryIndexPrefix: ".payroll",
    sheetPrefix: "T5",
    coveredTableLabel: "5（工资奖金事实）",
    tableScopeGap: "BUSINESS_TABLES_1_TO_4_6_TO_8_NOT_INCLUDED",
    completeSourceBoundary: "finance_document、ledger_entry 保留其完整关联事实源，未按工资或奖金筛选；不得据此混算金额",
    sourceTitles: Object.freeze({
      finance_document: "财务单据", cash_wage_plan_version: "工资计划版本", cash_wage_todo: "工资待办",
      cash_wage_confirmation: "工资确认", project_bonus_transfer: "项目奖金划拨",
      bonus_project_name_version: "奖金项目名称版本", salary_benefit_reversal: "工资福利冲回", ledger_entry: "账本分录",
    }),
  }),
  FINANCE: Object.freeze({
    tableNumber: 4,
    file: "business-table-4-finance-facts.xlsx",
    attemptPrefix: "full-backup-finance-facts-",
    temporaryIndexPrefix: ".finance",
    sheetPrefix: "T4",
    coveredTableLabel: "4（财务单据事实）",
    tableScopeGap: "BUSINESS_TABLES_1_TO_3_5_TO_8_NOT_INCLUDED",
    completeSourceBoundary: "仅导出当前已声明字段；finance_refund_submission 仅导出单据键，尚未映射完整提交字段；不按类型筛选或混算金额",
    sourceTitles: Object.freeze({
      finance_document: "财务单据", finance_document_event: "财务单据事件",
      finance_withdrawal_submission: "提现提交", finance_withdrawal_transfer: "提现办理", finance_withdrawal_reversal: "提现撤回",
      finance_reimbursement_submission: "报销提交", finance_reimbursement_decision: "报销审批",
      finance_reimbursement_attachment_binding: "报销附件绑定", finance_reimbursement_command_idempotency: "报销命令封口",
      finance_reimbursement_transfer: "报销内部划拨", finance_self_purchase_transfer: "自采买划拨",
      finance_reimbursement_reversal: "报销内部冲回", finance_self_purchase_reversal: "自采买冲回", finance_refund_submission: "退款提交",
      finance_refund_decision: "退款审批", finance_attachment: "财务附件", finance_attachment_version: "财务附件版本",
    }),
  }),
});

const fail = (code: string): never => { throw new Error(code); };
const pageCount = (rowCount: bigint, maxDataRows: number): number => {
  const pages = rowCount === 0n ? 1n : (rowCount + BigInt(maxDataRows) - 1n) / BigInt(maxDataRows);
  if (pages > BigInt(MAX_PARTS)) fail("EXPORT_BUSINESS_FACTS_WORKBOOK_PAGE_LIMIT");
  return Number(pages);
};
/** A bounded on-disk index: data-sheet cells use references while this sheet stores chunks. */
class NdjsonIndex {
  private closed = false;
  private count = 0n;

  private constructor(private readonly file: FileHandle, private readonly relative: string) {}

  static async create(directory: string, relative: string): Promise<NdjsonIndex> {
    return new NdjsonIndex(await open(join(directory, relative), "wx", 0o600), relative);
  }

  async add(row: readonly string[]): Promise<void> {
    if (this.closed) fail("EXPORT_BUSINESS_FACTS_WORKBOOK_INDEX_CLOSED");
    await writeBackupBytes(this.file, Buffer.from(`${JSON.stringify(row)}\n`, "utf8"));
    this.count += 1n;
  }

  async seal(): Promise<void> {
    if (!this.closed) {
      await this.file.sync();
      await this.file.close();
      this.closed = true;
    }
  }

  async dispose(): Promise<void> {
    if (!this.closed) {
      await this.file.close().catch(() => undefined);
      this.closed = true;
    }
  }

  rowCount(): bigint { return this.count; }
  path(): string { return this.relative; }
}

async function* readIndexRows(root: string, relative: string, width: number): AsyncGenerator<TextRow> {
  const handle = await openPrivateBackupFile(root, relative);
  let primaryError: unknown;
  try {
    const bytes = Buffer.allocUnsafe(64 * 1024);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    for (;;) {
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, null);
      if (bytesRead === 0) break;
      pending += decoder.write(bytes.subarray(0, bytesRead));
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline).replace(/\r$/u, "");
        pending = pending.slice(newline + 1);
        let value: unknown;
        try { value = JSON.parse(line); } catch { fail("EXPORT_BUSINESS_FACTS_WORKBOOK_INDEX_INVALID"); }
        if (!Array.isArray(value) || value.length !== width || value.some((cell) => typeof cell !== "string"))
          fail("EXPORT_BUSINESS_FACTS_WORKBOOK_INDEX_INVALID");
        yield value as TextRow;
      }
    }
    pending += decoder.end();
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline).replace(/\r$/u, "");
      pending = pending.slice(newline + 1);
      let value: unknown;
      try { value = JSON.parse(line); } catch { fail("EXPORT_BUSINESS_FACTS_WORKBOOK_INDEX_INVALID"); }
      if (!Array.isArray(value) || value.length !== width || value.some((cell) => typeof cell !== "string"))
        fail("EXPORT_BUSINESS_FACTS_WORKBOOK_INDEX_INVALID");
      yield value as TextRow;
    }
    if (pending.length !== 0) fail("EXPORT_BUSINESS_FACTS_WORKBOOK_INDEX_INVALID");
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try { await handle.close(); }
    catch (cleanupError) {
      if (primaryError !== undefined)
        throw new AggregateError([primaryError, cleanupError], "EXPORT_BUSINESS_FACTS_WORKBOOK_INDEX_CLEANUP_FAILED", { cause: primaryError });
      throw cleanupError;
    }
  }
}

const assertRow = (source: BusinessFactsViewSource, row: BusinessFactsViewRow): void => {
  if (row.sourceTable !== source.sourceTable || row.values.length !== source.columns.length || !/^(0|[1-9]\d*)$/.test(row.rowNumber))
    fail("EXPORT_BUSINESS_FACTS_WORKBOOK_ROW_INVALID");
};

const workbookValue = (value: TextValue): string => value === null ? "" : (splitBackupLongText(value)?.reference ?? value);

class SourcePager {
  private iterator: AsyncIterator<BusinessFactsViewRow> | undefined;
  private nextPage = 1;
  private complete = false;

  constructor(
    private readonly view: FullBackupBusinessFactsView,
    private readonly tableNumber: 1 | 2 | 4 | 5 | 6 | 8,
    private readonly source: BusinessFactsViewSource,
    private readonly count: bigint,
    private readonly maxDataRows: number,
  ) {}

  async *rowsForPage(page: number): AsyncGenerator<TextRow> {
    if (page !== this.nextPage || this.complete) fail("EXPORT_BUSINESS_FACTS_WORKBOOK_PAGE_SEQUENCE_INVALID");
    this.iterator ??= this.view.readSourceRows(this.tableNumber, this.source.sourceTable)[Symbol.asyncIterator]();
    const start = BigInt(page - 1) * BigInt(this.maxDataRows);
    const remaining = this.count - start;
    const expected = Number(remaining > BigInt(this.maxDataRows) ? BigInt(this.maxDataRows) : remaining);
    let primaryError: unknown;
    try {
      for (let index = 0; index < expected; index += 1) {
        const next = await this.iterator.next();
        if (next.done) fail("EXPORT_BUSINESS_FACTS_WORKBOOK_SOURCE_EARLY_EOF");
        assertRow(this.source, next.value);
        yield [next.value.sourceRecordKey, next.value.rowNumber, ...next.value.values.map(workbookValue)];
      }
      this.nextPage += 1;
      if (page === pageCount(this.count, this.maxDataRows)) {
        if (!(await this.iterator.next()).done) fail("EXPORT_BUSINESS_FACTS_WORKBOOK_SOURCE_ROW_COUNT_CHANGED");
        this.complete = true;
      }
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (this.complete) await this.dispose(primaryError);
    }
  }

  async dispose(primaryError?: unknown): Promise<void> {
    const iterator = this.iterator;
    this.iterator = undefined;
    if (iterator === undefined) return;
    try { await iterator.return?.(); }
    catch (cleanupError) {
      if (primaryError !== undefined)
        throw new AggregateError([primaryError, cleanupError], "EXPORT_BUSINESS_FACTS_WORKBOOK_SOURCE_CLEANUP_FAILED", { cause: primaryError });
      throw cleanupError;
    }
  }
}

class IndexPager {
  private iterator: AsyncIterator<TextRow> | undefined;
  private nextPage = 1;
  private complete = false;

  constructor(private readonly root: string, private readonly relative: string, private readonly width: number, private readonly count: bigint, private readonly maxDataRows: number) {}

  async *rowsForPage(page: number): AsyncGenerator<TextRow> {
    if (page !== this.nextPage || this.complete) fail("EXPORT_BUSINESS_FACTS_WORKBOOK_INDEX_PAGE_SEQUENCE_INVALID");
    this.iterator ??= readIndexRows(this.root, this.relative, this.width)[Symbol.asyncIterator]();
    const start = BigInt(page - 1) * BigInt(this.maxDataRows);
    const remaining = this.count - start;
    const expected = Number(remaining > BigInt(this.maxDataRows) ? BigInt(this.maxDataRows) : remaining);
    let primaryError: unknown;
    try {
      for (let index = 0; index < expected; index += 1) {
        const next = await this.iterator.next();
        if (next.done) fail("EXPORT_BUSINESS_FACTS_WORKBOOK_INDEX_EARLY_EOF");
        yield next.value;
      }
      this.nextPage += 1;
      if (page === pageCount(this.count, this.maxDataRows)) {
        if (!(await this.iterator.next()).done) fail("EXPORT_BUSINESS_FACTS_WORKBOOK_INDEX_ROW_COUNT_CHANGED");
        this.complete = true;
      }
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (this.complete) await this.dispose(primaryError);
    }
  }

  async dispose(primaryError?: unknown): Promise<void> {
    const iterator = this.iterator;
    this.iterator = undefined;
    if (iterator === undefined) return;
    try { await iterator.return?.(); }
    catch (cleanupError) {
      if (primaryError !== undefined)
        throw new AggregateError([primaryError, cleanupError], "EXPORT_BUSINESS_FACTS_WORKBOOK_INDEX_CLEANUP_FAILED", { cause: primaryError });
      throw cleanupError;
    }
  }
}

const sourceSheetName = (profile: FixedProfile, index: number, source: BusinessFactsViewSource, page: number, pages: number): string => {
  const prefix = `${profile.sheetPrefix}_${String(index + 1).padStart(2, "0")}_`;
  const suffix = pages > 1 ? `_${String(page).padStart(4, "0")}` : "";
  return `${prefix}${profile.sourceTitles[source.sourceTable] ?? source.sourceTable}`.slice(0, 31 - suffix.length) + suffix;
};

const gapsFor = (profile: FixedProfile, spool: FullBackupSpoolResult): readonly string[] => Object.freeze([
  profile.tableScopeGap,
  DERIVED_SCOPE_GAP,
  ...spool.coverageGaps,
  ...BUSINESS_BACKUP_COVERAGE_GAPS.map((gap) => gap.code),
]);

const explanationRows = (profile: FixedProfile, description: BusinessFactsViewDescription, spool: FullBackupSpoolResult, gaps: readonly string[], sourceRows: readonly { sourceTable: string; rowCount: string; logicalDigest: string }[]): readonly TextRow[] => [
  ["导出模式", "BUSINESS_FACTS_WORKBOOK"],
  ["完整备份", "false"],
  ["覆盖业务表", profile.coveredTableLabel],
  ["行模型", "仅原始 source rows；各事实源分 sheet"],
  ["处理边界", "不跨源关联、不汇总金额、不推导表 3 或表 7"],
  ["完整关联来源", profile.completeSourceBoundary],
  ["业务映射版本", description.schemaVersion],
  ["快照", description.snapshotId],
  ["快照时间", description.asOf],
  ["RAW spool", spool.spoolId],
  ["业务表标题", description.title],
  ["事实源", description.sources.map((source) => source.sourceTable).join(", ")],
  ...sourceRows.flatMap((source) => [[`源行数 ${source.sourceTable}`, source.rowCount], [`源逻辑摘要 ${source.sourceTable}`, source.logicalDigest]] as TextRow[]),
  ["已知缺口", gaps.join(", ")],
];

/**
 * Writes one fixed stored-fact business table from an already complete RAW
 * spool. It cannot accept caller-defined sheets, columns, paths, or profiles.
 */
export class FullBackupBusinessFactsWorkbookExporter {
  private readonly maxDataRows: number;
  private readonly writeWorkbook: WorkbookWriter;
  private readonly profile: FixedProfile;

  public constructor(private readonly options: FullBackupBusinessFactsWorkbookExporterOptions) {
    if (options.profile !== "TEACHER" && options.profile !== "STUDENT" && options.profile !== "FINANCE" && options.profile !== "PAYROLL" && options.profile !== "DEDUCTION" && options.profile !== "PERFORMANCE_CONFIGURATION")
      fail("EXPORT_BUSINESS_FACTS_WORKBOOK_PROFILE_INVALID");
    this.profile = FIXED_PROFILES[options.profile];
    this.maxDataRows = options.maxDataRows ?? BACKUP_MAX_DATA_ROWS;
    if (!Number.isInteger(this.maxDataRows) || this.maxDataRows < 1 || this.maxDataRows > BACKUP_MAX_DATA_ROWS)
      fail("EXPORT_BUSINESS_FACTS_WORKBOOK_PAGE_SIZE_INVALID");
    this.writeWorkbook = options.writeWorkbook ?? writeXlsx;
  }

  public async export(): Promise<FullBackupBusinessFactsWorkbookExportResult> {
    const view = new FullBackupBusinessFactsView({ spoolDirectory: this.options.spoolDirectory, spool: this.options.spool });
    const description = view.describe(this.profile.tableNumber);
    if (description.mode !== "BUSINESS_FACTS_VIEW" || description.complete || description.rowModel !== "SOURCE_ROWS_ONLY" || description.tableNumber !== this.profile.tableNumber)
      fail("EXPORT_BUSINESS_FACTS_WORKBOOK_DESCRIPTION_INVALID");
    const gaps = gapsFor(this.profile, this.options.spool);
    let outputDirectory: string | undefined;
    let result: FullBackupBusinessFactsWorkbookExportResult | undefined;
    let primaryError: unknown;
    let longIndex: NdjsonIndex | undefined;
    let nullIndex: NdjsonIndex | undefined;
    const pagers: SourcePager[] = [];
    const indexPagers: IndexPager[] = [];
    try {
      await mkdir(this.options.outputRoot, { recursive: true, mode: 0o700 });
      const outputRoot = await assertPrivateBackupDirectory(this.options.outputRoot);
      outputDirectory = await mkdtemp(join(outputRoot, this.profile.attemptPrefix));
      await chmod(outputDirectory, 0o700);
      outputDirectory = await assertPrivateBackupDirectory(outputDirectory);
      longIndex = await NdjsonIndex.create(outputDirectory, `${this.profile.temporaryIndexPrefix}-long-text.ndjson`);
      nullIndex = await NdjsonIndex.create(outputDirectory, `${this.profile.temporaryIndexPrefix}-null-coordinates.ndjson`);

      const sourceRows: Array<{ sourceTable: string; rowCount: string; logicalDigest: string }> = [];
      const datasets = new Map(this.options.spool.datasets.map((dataset) => [dataset.tableName, dataset]));
      for (const source of description.sources) {
        let count = 0n;
        for await (const row of view.readSourceRows(this.profile.tableNumber, source.sourceTable)) {
          assertRow(source, row);
          for (const [index, value] of row.values.entries()) {
            const field = source.columns[index]!.sourceColumn;
            if (value === null) {
              await nullIndex.add([source.sourceTable, row.sourceRecordKey, row.rowNumber, field]);
              continue;
            }
            const split = splitBackupLongText(value);
            if (split !== null) for (const [part, chunk] of split.chunks.entries()) {
              await longIndex.add([split.reference, source.sourceTable, row.sourceRecordKey, row.rowNumber, field, String(part + 1), chunk]);
            }
          }
          count += 1n;
        }
        const logicalDigest = datasets.get(source.sourceTable)?.logicalDigest;
        if (typeof logicalDigest !== "string") fail("EXPORT_BUSINESS_FACTS_WORKBOOK_SOURCE_METADATA_INVALID");
        const sourceDigest = logicalDigest as string;
        sourceRows.push({ sourceTable: source.sourceTable, rowCount: count.toString(), logicalDigest: sourceDigest });
        pagers.push(new SourcePager(view, this.profile.tableNumber, source, count, this.maxDataRows));
      }
      await longIndex.seal();
      await nullIndex.seal();
      const longPager = new IndexPager(outputDirectory, longIndex.path(), LONG_TEXT_COLUMNS.length, longIndex.rowCount(), this.maxDataRows);
      const nullPager = new IndexPager(outputDirectory, nullIndex.path(), NULL_COORDINATE_COLUMNS.length, nullIndex.rowCount(), this.maxDataRows);
      indexPagers.push(longPager, nullPager);

      const sheets: XlsxSheet[] = [{ name: "00_说明", columns: ["字段", "内容"], rows: explanationRows(this.profile, description, this.options.spool, gaps, sourceRows) }];
      for (const [index, source] of description.sources.entries()) {
        const sourceCount = BigInt(sourceRows[index]!.rowCount);
        const pages = pageCount(sourceCount, this.maxDataRows);
        const pager = pagers[index]!;
        if (source.columns.length + 2 > 16_384) fail("EXPORT_BUSINESS_FACTS_WORKBOOK_COLUMN_LIMIT");
        for (let page = 1; page <= pages; page += 1) {
          sheets.push({
            name: sourceSheetName(this.profile, index, source, page, pages),
            columns: ["源记录键", "源行号", ...source.columns.map((column) => `${column.label} [${column.sourceColumn}]`)],
            rows: pager.rowsForPage(page),
          });
        }
      }
      const longPages = pageCount(longIndex.rowCount(), this.maxDataRows);
      for (let page = 1; page <= longPages; page += 1) sheets.push({
        name: longPages === 1 ? "14_长文本" : `14_长文本_${String(page).padStart(4, "0")}`,
        columns: LONG_TEXT_COLUMNS, rows: longPager.rowsForPage(page),
      });
      const nullPages = pageCount(nullIndex.rowCount(), this.maxDataRows);
      for (let page = 1; page <= nullPages; page += 1) sheets.push({
        name: nullPages === 1 ? "15_NULL坐标" : `15_NULL坐标_${String(page).padStart(4, "0")}`,
        columns: NULL_COORDINATE_COLUMNS, rows: nullPager.rowsForPage(page),
      });

      await this.writeWorkbook({ outputPath: join(outputDirectory, this.profile.file), sheets });
      await rm(join(outputDirectory, longIndex.path()), { force: true });
      await rm(join(outputDirectory, nullIndex.path()), { force: true });
      await syncBackupDirectory(outputDirectory);
      const integrity = await hashBackupFile(outputDirectory, this.profile.file);
      await syncBackupDirectory(outputRoot);
      result = Object.freeze({
        mode: "BUSINESS_FACTS_WORKBOOK", complete: false, outputId: outputDirectory.split("/").at(-1)!,
        spoolId: this.options.spool.spoolId, snapshotId: description.snapshotId, asOf: description.asOf,
        file: this.profile.file, sizeBytes: integrity.sizeBytes, sha256: integrity.sha256,
        coveredTables: [this.profile.tableNumber] as readonly [1] | readonly [2] | readonly [4] | readonly [5] | readonly [6] | readonly [8],
        gaps, schemaVersion: description.schemaVersion, sourceRows: Object.freeze(sourceRows.map((source) => Object.freeze(source))),
      });
    } catch (error) {
      primaryError = error;
    }

    const cleanupErrors: unknown[] = [];
    const cleanup = async (operation: () => Promise<void>): Promise<void> => {
      try { await operation(); } catch (error) { cleanupErrors.push(error); }
    };
    for (const pager of [...pagers, ...indexPagers]) await cleanup(() => pager.dispose(primaryError));
    if (longIndex) await cleanup(() => longIndex!.dispose());
    if (nullIndex) await cleanup(() => nullIndex!.dispose());
    if ((primaryError !== undefined || cleanupErrors.length > 0 || result === undefined) && outputDirectory !== undefined)
      await cleanup(() => rm(outputDirectory!, { recursive: true, force: true }));

    if (primaryError !== undefined) {
      if (cleanupErrors.length > 0)
        throw new AggregateError([primaryError, ...cleanupErrors], "EXPORT_BUSINESS_FACTS_WORKBOOK_CLEANUP_FAILED", { cause: primaryError });
      throw primaryError;
    }
    if (cleanupErrors.length > 0)
      throw new AggregateError(cleanupErrors, "EXPORT_BUSINESS_FACTS_WORKBOOK_CLEANUP_FAILED");
    return result ?? fail("EXPORT_BUSINESS_FACTS_WORKBOOK_RESULT_MISSING");
  }
}
