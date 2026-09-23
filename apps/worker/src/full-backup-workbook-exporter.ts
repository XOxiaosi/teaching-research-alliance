import { createReadStream } from "node:fs";
import { chmod, mkdir, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import {
  BACKUP_MAX_DATA_ROWS,
  FULL_BACKUP_KNOWN_COVERAGE_GAPS,
  backupSheetPartId,
  createFullBackupLayout,
  type FullBackupLayoutItem,
} from "./full-backup-layout.js";
import { splitBackupLongText } from "./full-backup-long-text.js";
import { EXPORT_SCHEMA_REGISTRY } from "./export-schema-registry.js";
import { writeXlsx, type XlsxOptions, type XlsxSheet } from "./openxml-xlsx-writer.js";
import type { FullBackupSpoolDataset, FullBackupSpoolResult } from "./full-backup-spool.js";
import { readBackupSpoolDataset } from "./full-backup-spool-reader.js";
import { fullBackupOutputColumns } from "./full-backup-transformer.js";

type TextRow = readonly (string | null)[];
type SpoolDatasetReader = (directory: string, dataset: FullBackupSpoolDataset) => AsyncIterable<TextRow>;
type WorkbookWriter = (options: XlsxOptions) => Promise<void>;
type IndexFileRemover = (path: string) => Promise<void>;
const removeIndexFile: IndexFileRemover = async (path) => { await rm(path, { force: true }); };

export type FullBackupWorkbook = Readonly<{
  workbookId: string;
  file: string;
  datasetCount: string;
}>;

export type FullBackupWorkbookExportResult = Readonly<{
  mode: "RAW_SOURCE_WORKBOOKS";
  outputId: string;
  spoolId: string;
  snapshotId: string;
  asOf: string;
  workbooks: readonly FullBackupWorkbook[];
  coverageGaps: readonly string[];
}>;

export type FullBackupWorkbookExporterOptions = Readonly<{
  /** Internal, validated spool directory. It is never copied into result metadata. */
  spoolDirectory: string;
  spool: FullBackupSpoolResult;
  /** Parent for this attempt's newly-created 0700 output directory. */
  outputRoot: string;
  /** Internal test seam; production always uses the validated spool reader. */
  readDataset?: SpoolDatasetReader;
  /** Internal test seam; production always uses the OpenXML writer. */
  writeWorkbook?: WorkbookWriter;
  /** Internal test seam for verifying failed temporary-index cleanup. */
  removeIndexFile?: IndexFileRemover;
}>;

const MAX_PARTS = 9_999;
const LONG_TEXT_COLUMNS = ["long_text_ref", "source_table", "source_record_key", "source_row_number", "field_name", "part_no", "part_text"] as const;

const fail = (code: string): never => { throw new Error(code); };

const sourceRecordKey = (tableName: string, columns: readonly string[], row: TextRow): string => {
  const table = EXPORT_SCHEMA_REGISTRY.find((candidate) => candidate.name === tableName);
  if (table === undefined) return fail("EXPORT_WORKBOOK_RECORD_KEY_INVALID");
  const entries = table.orderBy.map((sourceColumn) => {
    const outputColumn = columns.includes(sourceColumn)
      ? sourceColumn
      : columns.includes(`${sourceColumn}_fingerprint`)
        ? `${sourceColumn}_fingerprint`
        : fail("EXPORT_WORKBOOK_RECORD_KEY_INVALID");
    const value = row[columns.indexOf(outputColumn)];
    if (typeof value !== "string" || value.length === 0) fail("EXPORT_WORKBOOK_RECORD_KEY_INVALID");
    return [outputColumn, value] as const;
  });
  const key = JSON.stringify(entries);
  if (key.length > 32_767) fail("EXPORT_WORKBOOK_RECORD_KEY_INVALID");
  return key;
};

const same = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const writeAll = async (file: FileHandle, text: string): Promise<void> => {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.write(bytes, offset, bytes.length - offset);
    if (result.bytesWritten <= 0) fail("EXPORT_WORKBOOK_TEMP_WRITE_FAILED");
    offset += result.bytesWritten;
  }
};

class LongTextIndex {
  private closed = false;
  private count = 0n;
  private lineIterator: AsyncIterator<string> | undefined;
  private lineStream: ReturnType<typeof createReadStream> | undefined;
  private lines: ReturnType<typeof createInterface> | undefined;
  private nextPart = 1;
  private finished = false;

  private constructor(
    private readonly file: FileHandle,
    private readonly path: string,
    private readonly removeFile: IndexFileRemover,
  ) {}

  static async create(directory: string, workbookId: string, removeFile: IndexFileRemover): Promise<LongTextIndex> {
    const path = join(directory, `.long-text-${workbookId}.ndjson`);
    return new LongTextIndex(await open(path, "wx", 0o600), path, removeFile);
  }

  async collect(tableName: string, sourceKey: string, columns: readonly string[], rowNumber: bigint, row: TextRow): Promise<void> {
    if (this.closed || row.length !== columns.length) fail("EXPORT_WORKBOOK_ROW_SHAPE_INVALID");
    for (let index = 0; index < row.length; index += 1) {
      const value = row[index]!;
      if (value === null) continue;
      const split = splitBackupLongText(value);
      if (split === null) continue;
      for (const [partIndex, chunk] of split.chunks.entries()) {
        await writeAll(this.file, `${JSON.stringify([
          split.reference,
          tableName,
          sourceKey,
          rowNumber.toString(),
          columns[index]!,
          String(partIndex + 1),
          chunk,
        ])}\n`);
        this.count += 1n;
      }
    }
  }

  references(columns: readonly string[], row: TextRow): TextRow {
    if (row.length !== columns.length) fail("EXPORT_WORKBOOK_ROW_SHAPE_INVALID");
    return row.map((value) => value === null ? null : (splitBackupLongText(value)?.reference ?? value));
  }

  pageCount(): number {
    const parts = this.count === 0n ? 1n : (this.count + BigInt(BACKUP_MAX_DATA_ROWS) - 1n) / BigInt(BACKUP_MAX_DATA_ROWS);
    if (parts > BigInt(MAX_PARTS)) fail("EXPORT_WORKBOOK_PAGE_LIMIT");
    return Number(parts);
  }

  private async startReading(): Promise<void> {
    if (this.lineIterator !== undefined) return;
    if (!this.closed) {
      await this.file.sync();
      await this.file.close();
      this.closed = true;
    }
    this.lineStream = createReadStream(this.path, { encoding: "utf8" });
    this.lines = createInterface({ input: this.lineStream, crlfDelay: Infinity });
    this.lineIterator = this.lines[Symbol.asyncIterator]();
  }

  private parseLine(line: string): TextRow {
    let row: unknown;
    try { row = JSON.parse(line); } catch { return fail("EXPORT_LONG_TEXT_INDEX_INVALID"); }
    if (!Array.isArray(row) || row.length !== LONG_TEXT_COLUMNS.length || row.some((value) => typeof value !== "string"))
      fail("EXPORT_LONG_TEXT_INDEX_INVALID");
    return row as TextRow;
  }

  async *rowsForPart(part: number): AsyncGenerator<TextRow> {
    if (part !== this.nextPart || this.finished) fail("EXPORT_WORKBOOK_PAGE_SEQUENCE_INVALID");
    await this.startReading();
    const start = BigInt(part - 1) * BigInt(BACKUP_MAX_DATA_ROWS);
    const remaining = this.count - start;
    const expected = Number(remaining > BigInt(BACKUP_MAX_DATA_ROWS) ? BigInt(BACKUP_MAX_DATA_ROWS) : remaining);
    try {
      for (let index = 0; index < expected; index += 1) {
        const next = await this.lineIterator!.next();
        if (next.done) fail("EXPORT_LONG_TEXT_INDEX_INVALID");
        yield this.parseLine(next.value);
      }
      this.nextPart += 1;
      if (part === this.pageCount()) {
        if (!(await this.lineIterator!.next()).done) fail("EXPORT_LONG_TEXT_INDEX_INVALID");
        this.finished = true;
      }
    } finally {
      if (this.finished) {
        this.lines?.close();
        this.lineStream?.destroy();
      }
    }
  }

  async dispose(): Promise<void> {
    if (!this.closed) {
      await this.file.close().catch(() => undefined);
      this.closed = true;
    }
    this.lines?.close();
    this.lineStream?.destroy();
    await this.removeFile(this.path);
  }
}

const NULL_COORDINATE_COLUMNS = ["source_table", "source_record_key", "source_row_number", "field_name"] as const;

class NullCoordinateIndex {
  private closed = false;
  private count = 0n;
  private lineIterator: AsyncIterator<string> | undefined;
  private lineStream: ReturnType<typeof createReadStream> | undefined;
  private lines: ReturnType<typeof createInterface> | undefined;
  private nextPart = 1;
  private finished = false;

  private constructor(
    private readonly file: FileHandle,
    private readonly path: string,
    private readonly removeFile: IndexFileRemover,
  ) {}

  static async create(directory: string, workbookId: string, removeFile: IndexFileRemover): Promise<NullCoordinateIndex> {
    const path = join(directory, `.null-coordinates-${workbookId}.ndjson`);
    return new NullCoordinateIndex(await open(path, "wx", 0o600), path, removeFile);
  }

  async collect(tableName: string, sourceKey: string, columns: readonly string[], rowNumber: bigint, row: TextRow): Promise<void> {
    if (this.closed || row.length !== columns.length) fail("EXPORT_WORKBOOK_ROW_SHAPE_INVALID");
    for (let index = 0; index < row.length; index += 1) {
      if (row[index] !== null) continue;
      await writeAll(this.file, `${JSON.stringify([tableName, sourceKey, rowNumber.toString(), columns[index]!])}\n`);
      this.count += 1n;
    }
  }

  pageCount(): number {
    const parts = this.count === 0n ? 1n : (this.count + BigInt(BACKUP_MAX_DATA_ROWS) - 1n) / BigInt(BACKUP_MAX_DATA_ROWS);
    if (parts > BigInt(MAX_PARTS)) fail("EXPORT_WORKBOOK_PAGE_LIMIT");
    return Number(parts);
  }

  private async startReading(): Promise<void> {
    if (this.lineIterator !== undefined) return;
    if (!this.closed) {
      await this.file.sync();
      await this.file.close();
      this.closed = true;
    }
    this.lineStream = createReadStream(this.path, { encoding: "utf8" });
    this.lines = createInterface({ input: this.lineStream, crlfDelay: Infinity });
    this.lineIterator = this.lines[Symbol.asyncIterator]();
  }

  private parseLine(line: string): TextRow {
    let row: unknown;
    try { row = JSON.parse(line); } catch { return fail("EXPORT_NULL_COORDINATE_INDEX_INVALID"); }
    if (!Array.isArray(row) || row.length !== NULL_COORDINATE_COLUMNS.length || row.some((value) => typeof value !== "string"))
      fail("EXPORT_NULL_COORDINATE_INDEX_INVALID");
    return row as TextRow;
  }

  async *rowsForPart(part: number): AsyncGenerator<TextRow> {
    if (part !== this.nextPart || this.finished) fail("EXPORT_WORKBOOK_PAGE_SEQUENCE_INVALID");
    await this.startReading();
    const start = BigInt(part - 1) * BigInt(BACKUP_MAX_DATA_ROWS);
    const remaining = this.count - start;
    const expected = Number(remaining > BigInt(BACKUP_MAX_DATA_ROWS) ? BigInt(BACKUP_MAX_DATA_ROWS) : remaining);
    try {
      for (let index = 0; index < expected; index += 1) {
        const next = await this.lineIterator!.next();
        if (next.done) fail("EXPORT_NULL_COORDINATE_INDEX_INVALID");
        yield this.parseLine(next.value);
      }
      this.nextPart += 1;
      if (part === this.pageCount()) {
        if (!(await this.lineIterator!.next()).done) fail("EXPORT_NULL_COORDINATE_INDEX_INVALID");
        this.finished = true;
      }
    } finally {
      if (this.finished) {
        this.lines?.close();
        this.lineStream?.destroy();
      }
    }
  }

  async dispose(): Promise<void> {
    if (!this.closed) {
      await this.file.close().catch(() => undefined);
      this.closed = true;
    }
    this.lines?.close();
    this.lineStream?.destroy();
    await this.removeFile(this.path);
  }
}

class DatasetPager {
  private iterator: AsyncIterator<TextRow> | undefined;
  private nextPart = 1;
  private finished = false;

  constructor(
    private readonly spoolDirectory: string,
    private readonly dataset: FullBackupSpoolDataset,
    private readonly layout: FullBackupLayoutItem,
    private readonly readDataset: SpoolDatasetReader,
  ) {}

  pageCount(): number {
    const rowCount = this.dataset.rowCount ?? fail("EXPORT_WORKBOOK_DATASET_EXCLUDED");
    const count = BigInt(rowCount);
    const parts = count === 0n ? 1n : (count + BigInt(BACKUP_MAX_DATA_ROWS) - 1n) / BigInt(BACKUP_MAX_DATA_ROWS);
    if (parts > BigInt(MAX_PARTS)) fail("EXPORT_WORKBOOK_PAGE_LIMIT");
    return Number(parts);
  }

  async *rowsFor(part: number, longText: LongTextIndex): AsyncGenerator<TextRow> {
    if (part !== this.nextPart || this.finished) fail("EXPORT_WORKBOOK_PAGE_SEQUENCE_INVALID");
    const pageCount = this.pageCount();
    const total = BigInt(this.dataset.rowCount!);
    const start = BigInt(part - 1) * BigInt(BACKUP_MAX_DATA_ROWS);
    const remaining = total - start;
    const expected = Number(remaining > BigInt(BACKUP_MAX_DATA_ROWS) ? BigInt(BACKUP_MAX_DATA_ROWS) : remaining);
    if (this.iterator === undefined)
      this.iterator = this.readDataset(this.spoolDirectory, this.dataset)[Symbol.asyncIterator]();
    for (let offset = 0; offset < expected; offset += 1) {
      const next = await this.iterator.next();
      if (next.done) fail("EXPORT_SPOOL_INTEGRITY_FAILED");
      const rowNumber = start + BigInt(offset) + 1n;
      yield longText.references(this.dataset.columns, next.value);
    }
    this.nextPart += 1;
    if (part === pageCount) {
      const next = await this.iterator.next();
      if (!next.done) fail("EXPORT_SPOOL_INTEGRITY_FAILED");
      this.finished = true;
    }
  }

  async dispose(): Promise<void> {
    const iterator = this.iterator;
    this.iterator = undefined;
    this.finished = true;
    if (iterator?.return !== undefined) await iterator.return();
  }
}

const assertSpoolMatchesLayout = (spool: FullBackupSpoolResult, layout: readonly FullBackupLayoutItem[]): ReadonlyMap<string, FullBackupSpoolDataset> => {
  if (spool.mode !== "RAW_SOURCE_SPOOL" || spool.datasets.length !== layout.length) fail("EXPORT_WORKBOOK_SPOOL_LAYOUT_MISMATCH");
  const datasets = new Map<string, FullBackupSpoolDataset>();
  for (const [index, item] of layout.entries()) {
    const dataset = spool.datasets[index] ?? fail("EXPORT_WORKBOOK_SPOOL_LAYOUT_MISMATCH");
    if (dataset.tableName !== item.tableName || dataset.excluded !== (item.policy === "AUTH_SECRET_TABLE_EXCLUDED"))
      fail("EXPORT_WORKBOOK_SPOOL_LAYOUT_MISMATCH");
    const expectedColumns = item.policy === "AUTH_SECRET_TABLE_EXCLUDED" ? [] : fullBackupOutputColumns(item.tableName);
    if (!same(dataset.columns, expectedColumns)) fail("EXPORT_WORKBOOK_SPOOL_LAYOUT_MISMATCH");
    if (dataset.excluded) {
      if (dataset.rowCount !== null || dataset.logicalDigest !== null || dataset.spoolFile !== null) fail("EXPORT_WORKBOOK_SPOOL_LAYOUT_MISMATCH");
    } else if (dataset.rowCount === null || dataset.logicalDigest === null || dataset.spoolFile === null) {
      fail("EXPORT_WORKBOOK_SPOOL_LAYOUT_MISMATCH");
    }
    datasets.set(item.tableName, dataset);
  }
  return datasets;
};

/**
 * Internal raw-spool to XLSX renderer. It deliberately stops before package
 * manifests, attachments, task state, download authorization, and a complete
 * F14 success assertion.
 */
export class FullBackupWorkbookExporter {
  public constructor(private readonly options: FullBackupWorkbookExporterOptions) {}

  async export(): Promise<FullBackupWorkbookExportResult> {
    let directory: string | undefined;
    try {
      const layout = createFullBackupLayout();
      const datasets = assertSpoolMatchesLayout(this.options.spool, layout);
      await mkdir(this.options.outputRoot, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(this.options.outputRoot, "full-backup-workbooks-"));
      await chmod(directory, 0o700);
      const groups = new Map<string, FullBackupLayoutItem[]>();
      for (const item of layout) {
        if (item.policy === "AUTH_SECRET_TABLE_EXCLUDED") continue;
        const entries = groups.get(item.workbookId) ?? [];
        entries.push(item);
        groups.set(item.workbookId, entries);
      }

      const workbooks: FullBackupWorkbook[] = [];
      const readDataset = this.options.readDataset ?? readBackupSpoolDataset;
      const writeWorkbook = this.options.writeWorkbook ?? writeXlsx;
      for (const [workbookId, items] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const indexRemover = this.options.removeIndexFile ?? removeIndexFile;
        const longText = await LongTextIndex.create(directory, workbookId, indexRemover);
        let nullCoordinates: NullCoordinateIndex | undefined;
        const pagers: DatasetPager[] = [];
        let primaryError: unknown;
        try {
          nullCoordinates = await NullCoordinateIndex.create(directory, workbookId, indexRemover);
          // First pass validates every spool dataset at EOF and writes only
          // overflow chunks to a private index. The second pass streams the
          // same immutable spool rows into XLSX without retaining data rows.
          for (const item of items) {
            const dataset = datasets.get(item.tableName) ?? fail("EXPORT_WORKBOOK_SPOOL_LAYOUT_MISMATCH");
            let rowNumber = 0n;
            for await (const row of readDataset(this.options.spoolDirectory, dataset)) {
              rowNumber += 1n;
              const recordKey = sourceRecordKey(item.tableName, dataset.columns, row);
              await longText.collect(item.tableName, recordKey, dataset.columns, rowNumber, row);
              await nullCoordinates.collect(item.tableName, recordKey, dataset.columns, rowNumber, row);
            }
          }
          const sheets: XlsxSheet[] = [];
          for (const item of items) {
            const dataset = datasets.get(item.tableName) ?? fail("EXPORT_WORKBOOK_SPOOL_LAYOUT_MISMATCH");
            const pager = new DatasetPager(this.options.spoolDirectory, dataset, item, readDataset);
            pagers.push(pager);
            for (let part = 1; part <= pager.pageCount(); part += 1) {
              sheets.push({
                name: backupSheetPartId(item, part),
                columns: dataset.columns,
                rows: pager.rowsFor(part, longText),
              });
            }
          }
          for (let part = 1; part <= longText.pageCount(); part += 1) {
            sheets.push({
              name: `14_长文本分片_${String(part).padStart(4, "0")}`,
              columns: LONG_TEXT_COLUMNS,
              rows: longText.rowsForPart(part),
            });
          }
          for (let part = 1; part <= nullCoordinates.pageCount(); part += 1) {
            sheets.push({
              name: `15_NULL坐标_${String(part).padStart(4, "0")}`,
              columns: NULL_COORDINATE_COLUMNS,
              rows: nullCoordinates.rowsForPart(part),
            });
          }
          const file = `workbook-${workbookId}.xlsx`;
          await writeWorkbook({ outputPath: join(directory, file), sheets });
          workbooks.push({ workbookId, file, datasetCount: String(items.length) });
        } catch (error) {
          primaryError = error;
          throw error;
        } finally {
          const pagerCleanup = await Promise.allSettled(pagers.map((pager) => pager.dispose()));
          const indexCleanup = await Promise.allSettled([
            longText.dispose(),
            ...(nullCoordinates === undefined ? [] : [nullCoordinates.dispose()]),
          ]);
          if (primaryError === undefined && indexCleanup.some((result) => result.status === "rejected"))
            fail("EXPORT_WORKBOOK_TEMP_CLEANUP_FAILED");
          if (primaryError === undefined && pagerCleanup.some((result) => result.status === "rejected"))
            fail("EXPORT_WORKBOOK_READER_CLEANUP_FAILED");
        }
      }
      return {
        mode: "RAW_SOURCE_WORKBOOKS",
        outputId: basename(directory),
        spoolId: this.options.spool.spoolId,
        snapshotId: this.options.spool.snapshotId,
        asOf: this.options.spool.asOf,
        workbooks,
        coverageGaps: [...FULL_BACKUP_KNOWN_COVERAGE_GAPS],
      };
    } catch (error) {
      if (directory !== undefined) await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
}
