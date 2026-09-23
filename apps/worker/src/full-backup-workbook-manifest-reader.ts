import type { FileHandle } from "node:fs/promises";
import { openPrivateBackupFile } from "./backup-file-io.js";
import { BUSINESS_BACKUP_SHEETS } from "./full-backup-business-schema.js";
import { createFullBackupLayout } from "./full-backup-layout.js";
import { splitBackupLongText } from "./full-backup-long-text.js";
import {
  createManifestWorkbookRows,
  type FullBackupManifestContext,
  type ManifestSheetPart,
  type ManifestWorkbookRole,
} from "./full-backup-manifest.js";

const EOCD_BYTES = 22;
const CENTRAL_HEADER_BYTES = 46;
const LOCAL_HEADER_BYTES = 30;
const DATA_DESCRIPTOR_BYTES = 16;
const MAX_CENTRAL_DIRECTORY_BYTES = 4 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_TEXT_UNITS = 32_767;
const MAX_ROWS = 1_048_576;
const MAX_COLS = 16_384;
const CHUNK_BYTES = 64 * 1024;

const ZIP_EOCD = 0x0605_4b50;
const ZIP_CENTRAL = 0x0201_4b50;
const ZIP_LOCAL = 0x0403_4b50;
const ZIP_DESCRIPTOR = 0x0807_4b50;
const ZIP_FLAGS = 0x0808;
const ZIP32_MAX = 0xffff_ffff;

const WORKBOOK_PREFIX = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>';
const WORKBOOK_SUFFIX = "</sheets></workbook>";
const RELATIONSHIPS_PREFIX = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
const RELATIONSHIPS_SUFFIX = "</Relationships>";
const ROOT_RELATIONSHIPS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
const SHEET_PREFIX = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
const SHEET_SUFFIX = "</sheetData></worksheet>";
const HEADER_ROW = Object.freeze(["字段", "内容"]);

const crcTable = new Uint32Array(256);
for (let number = 0; number < 256; number += 1) {
  let value = number;
  for (let bit = 0; bit < 8; bit += 1)
    value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  crcTable[number] = value >>> 0;
}

const fail = (code: string): never => { throw new Error(code); };
const u16 = (data: Buffer, offset: number): number => data.readUInt16LE(offset);
const u32 = (data: Buffer, offset: number): number => data.readUInt32LE(offset);
const crc32 = (seed: number, data: Uint8Array): number => {
  let value = seed;
  for (const byte of data) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return value >>> 0;
};

type Entry = Readonly<{
  name: string;
  crc: number;
  size: number;
  offset: number;
}>;

type StatSnapshot = Readonly<{
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  ino: bigint;
  dev: bigint;
}>;

export type VerifyWorkbookManifestInput = Readonly<{
  /** Private package root; never included in the result. */
  root: string;
  /** Safe relative XLSX location below root; never included in the result. */
  relativePath: string;
  context: FullBackupManifestContext;
  file: string;
  workbookRole: ManifestWorkbookRole;
  tableNumbers: readonly number[];
}>;

export type VerifiedWorkbookManifest = Readonly<{
  manifestRowCount: string;
  mainSheetPartCount: string;
}>;

const snapshot = async (handle: FileHandle): Promise<StatSnapshot> => {
  const stat = await handle.stat({ bigint: true });
  if (!stat.isFile() || stat.size < 0n || stat.size > BigInt(ZIP32_MAX))
    fail("XLSX_MANIFEST_FILE_INVALID");
  return Object.freeze({
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    ino: stat.ino,
    dev: stat.dev,
  });
};

const unchanged = (left: StatSnapshot, right: StatSnapshot): void => {
  if (left.size !== right.size || left.mtimeNs !== right.mtimeNs ||
      left.ctimeNs !== right.ctimeNs || left.ino !== right.ino || left.dev !== right.dev)
    fail("XLSX_MANIFEST_FILE_CHANGED");
};

const readExact = async (
  handle: FileHandle,
  position: number,
  length: number,
): Promise<Buffer> => {
  if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0)
    fail("XLSX_MANIFEST_ZIP_INVALID");
  const output = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const read = await handle.read(output, offset, length - offset, position + offset);
    if (read.bytesRead <= 0) fail("XLSX_MANIFEST_ZIP_TRUNCATED");
    offset += read.bytesRead;
  }
  return output;
};

const safeName = (value: Buffer): string => {
  const name = value.toString("utf8");
  if (!Buffer.from(name, "utf8").equals(value) || !name || name.startsWith("/") ||
      name.includes("\\") || name.split("/").some((part) => !part || part === "." || part === ".."))
    fail("XLSX_MANIFEST_ZIP_PATH_INVALID");
  return name;
};

const entryNames = (sheetCount: number): readonly string[] => Object.freeze([
  "[Content_Types].xml",
  "_rels/.rels",
  "xl/workbook.xml",
  "xl/_rels/workbook.xml.rels",
  ...Array.from({ length: sheetCount }, (_, index) => `xl/worksheets/sheet${index + 1}.xml`),
]);

const parseCentralDirectory = async (
  handle: FileHandle,
  size: number,
): Promise<ReadonlyMap<string, Entry>> => {
  if (size < EOCD_BYTES) fail("XLSX_MANIFEST_ZIP_TRUNCATED");
  const eocd = await readExact(handle, size - EOCD_BYTES, EOCD_BYTES);
  if (u32(eocd, 0) !== ZIP_EOCD || u16(eocd, 4) !== 0 || u16(eocd, 6) !== 0 ||
      u16(eocd, 8) !== u16(eocd, 10) || u16(eocd, 20) !== 0 ||
      u16(eocd, 8) === 0xffff || u32(eocd, 12) === ZIP32_MAX || u32(eocd, 16) === ZIP32_MAX)
    fail("XLSX_MANIFEST_ZIP_INVALID");
  const count = u16(eocd, 8);
  const centralSize = u32(eocd, 12);
  const centralOffset = u32(eocd, 16);
  if (count === 0 || centralSize > MAX_CENTRAL_DIRECTORY_BYTES ||
      centralOffset + centralSize !== size - EOCD_BYTES)
    fail("XLSX_MANIFEST_ZIP_INVALID");
  const central = await readExact(handle, centralOffset, centralSize);
  const entries = new Map<string, Entry>();
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + CENTRAL_HEADER_BYTES > central.length || u32(central, cursor) !== ZIP_CENTRAL ||
        u16(central, cursor + 4) !== 20 || u16(central, cursor + 6) !== 20 ||
        u16(central, cursor + 8) !== ZIP_FLAGS || u16(central, cursor + 10) !== 0 ||
        u16(central, cursor + 12) !== 0 || u16(central, cursor + 14) !== 0 ||
        u16(central, cursor + 30) !== 0 || u16(central, cursor + 32) !== 0 ||
        u16(central, cursor + 34) !== 0 || u16(central, cursor + 36) !== 0 ||
        u32(central, cursor + 38) !== 0)
      fail("XLSX_MANIFEST_ZIP_INVALID");
    const nameLength = u16(central, cursor + 28);
    const end = cursor + CENTRAL_HEADER_BYTES + nameLength;
    if (end > central.length) fail("XLSX_MANIFEST_ZIP_TRUNCATED");
    const name = safeName(central.subarray(cursor + CENTRAL_HEADER_BYTES, end));
    const entry = Object.freeze({
      name,
      crc: u32(central, cursor + 16),
      size: u32(central, cursor + 20),
      offset: u32(central, cursor + 42),
    });
    if (entry.size !== u32(central, cursor + 24) || entries.has(name))
      fail("XLSX_MANIFEST_ZIP_INVALID");
    entries.set(name, entry);
    cursor = end;
  }
  if (cursor !== central.length) fail("XLSX_MANIFEST_ZIP_INVALID");

  const sheets = [...entries.keys()].filter((name) => /^xl\/worksheets\/sheet[1-9]\d*\.xml$/u.test(name));
  const expected = entryNames(sheets.length);
  if (entries.size !== expected.length || [...entries.keys()].some((name, index) => name !== expected[index]))
    fail("XLSX_MANIFEST_ZIP_INVALID");
  let expectedOffset = 0;
  for (const name of expected) {
    const entry = entries.get(name)!;
    if (entry.offset !== expectedOffset || entry.offset + LOCAL_HEADER_BYTES + Buffer.byteLength(name) + entry.size + DATA_DESCRIPTOR_BYTES > centralOffset)
      fail("XLSX_MANIFEST_ZIP_INVALID");
    expectedOffset += LOCAL_HEADER_BYTES + Buffer.byteLength(name) + entry.size + DATA_DESCRIPTOR_BYTES;
  }
  if (expectedOffset !== centralOffset) fail("XLSX_MANIFEST_ZIP_INVALID");
  return entries;
};

const validateLocalEntry = async (handle: FileHandle, entry: Entry): Promise<number> => {
  const local = await readExact(handle, entry.offset, LOCAL_HEADER_BYTES);
  if (u32(local, 0) !== ZIP_LOCAL || u16(local, 4) !== 20 || u16(local, 6) !== ZIP_FLAGS ||
      u16(local, 8) !== 0 || u16(local, 10) !== 0 || u16(local, 12) !== 0 ||
      u32(local, 14) !== 0 || u32(local, 18) !== 0 || u32(local, 22) !== 0 ||
      u16(local, 28) !== 0 || u16(local, 26) !== Buffer.byteLength(entry.name))
    fail("XLSX_MANIFEST_LOCAL_HEADER_INVALID");
  const name = await readExact(handle, entry.offset + LOCAL_HEADER_BYTES, Buffer.byteLength(entry.name));
  if (!name.equals(Buffer.from(entry.name, "utf8"))) fail("XLSX_MANIFEST_LOCAL_HEADER_INVALID");
  return entry.offset + LOCAL_HEADER_BYTES + name.length;
};

const readEntry = async (
  handle: FileHandle,
  entry: Entry,
  consume: (data: Buffer) => void | Promise<void>,
): Promise<void> => {
  const start = await validateLocalEntry(handle, entry);
  let position = start;
  let remaining = entry.size;
  let crc = 0xffff_ffff;
  while (remaining > 0) {
    const length = Math.min(CHUNK_BYTES, remaining);
    const data = await readExact(handle, position, length);
    crc = crc32(crc, data);
    await consume(data);
    position += length;
    remaining -= length;
  }
  const descriptor = await readExact(handle, position, DATA_DESCRIPTOR_BYTES);
  const actualCrc = (crc ^ 0xffff_ffff) >>> 0;
  if (u32(descriptor, 0) !== ZIP_DESCRIPTOR || u32(descriptor, 4) !== entry.crc ||
      u32(descriptor, 8) !== entry.size || u32(descriptor, 12) !== entry.size || actualCrc !== entry.crc)
    fail("XLSX_MANIFEST_CRC_INVALID");
};

const collectEntryText = async (handle: FileHandle, entry: Entry): Promise<string> => {
  if (entry.size > MAX_METADATA_BYTES) fail("XLSX_MANIFEST_METADATA_TOO_LARGE");
  const chunks: Buffer[] = [];
  await readEntry(handle, entry, (data) => { chunks.push(data); });
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { return fail("XLSX_MANIFEST_XML_INVALID"); }
};

const decodeXmlText = (value: string): string => {
  if (value.includes("<") || value.includes(">") || value.includes("\"") || value.includes("'") || value.includes("\r"))
    fail("XLSX_MANIFEST_XML_INVALID");
  let output = "";
  for (let index = 0; index < value.length;) {
    const next = value[index]!;
    if (next !== "&") { output += next; index += 1; continue; }
    const end = value.indexOf(";", index + 1);
    if (end < 0) fail("XLSX_MANIFEST_XML_INVALID");
    const entity = value.slice(index, end + 1);
    const decoded = entity === "&amp;" ? "&" : entity === "&lt;" ? "<" : entity === "&gt;" ? ">" :
      entity === "&quot;" ? "\"" : entity === "&apos;" ? "'" : entity === "&#xD;" ? "\r" : undefined;
    if (decoded === undefined) fail("XLSX_MANIFEST_XML_INVALID");
    output += decoded;
    index = end + 1;
  }
  const restored = output.replace(/_x005F_x([0-9A-Fa-f]{4})_/gu, "_x$1_");
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u.test(restored) ||
      /[\uD800-\uDFFF]/u.test(restored.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, "")))
    fail("XLSX_MANIFEST_XML_INVALID");
  return restored;
};

const normalizeDecodedText = (value: string): string => {
  const restored = value.replace(/_x005F_x([0-9A-Fa-f]{4})_/gu, "_x$1_");
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u.test(restored) ||
      /[\uD800-\uDFFF]/u.test(restored.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, "")))
    fail("XLSX_MANIFEST_XML_INVALID");
  return restored;
};

const parseWorkbook = (xml: string): readonly string[] => {
  if (!xml.startsWith(WORKBOOK_PREFIX) || !xml.endsWith(WORKBOOK_SUFFIX))
    fail("XLSX_MANIFEST_WORKBOOK_INVALID");
  const body = xml.slice(WORKBOOK_PREFIX.length, -WORKBOOK_SUFFIX.length);
  const names: string[] = [];
  let position = 0;
  while (position < body.length) {
    const prefix = '<sheet name="';
    if (!body.startsWith(prefix, position)) fail("XLSX_MANIFEST_WORKBOOK_INVALID");
    position += prefix.length;
    const nameEnd = body.indexOf('" sheetId="', position);
    if (nameEnd < 0) fail("XLSX_MANIFEST_WORKBOOK_INVALID");
    const name = decodeXmlText(body.slice(position, nameEnd));
    position = nameEnd + '" sheetId="'.length;
    const sheetEnd = body.indexOf('" r:id="rId', position);
    if (sheetEnd < 0) fail("XLSX_MANIFEST_WORKBOOK_INVALID");
    const sheetId = body.slice(position, sheetEnd);
    position = sheetEnd + '" r:id="rId'.length;
    const relationEnd = body.indexOf('"/>', position);
    if (relationEnd < 0) fail("XLSX_MANIFEST_WORKBOOK_INVALID");
    const relationId = body.slice(position, relationEnd);
    position = relationEnd + 3;
    const expected = String(names.length + 1);
    if (name.length === 0 || sheetId !== expected || relationId !== expected ||
        names.some((candidate) => candidate.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US")))
      fail("XLSX_MANIFEST_WORKBOOK_INVALID");
    names.push(name);
  }
  if (names.length === 0 || names[0] !== "00_manifest") fail("XLSX_MANIFEST_WORKBOOK_INVALID");
  return Object.freeze(names);
};

const relationshipsXml = (sheetCount: number): string => `${RELATIONSHIPS_PREFIX}${Array.from(
  { length: sheetCount },
  (_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
).join("")}${RELATIONSHIPS_SUFFIX}`;

const contentTypesXml = (sheetCount: number): string =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  Array.from(
    { length: sheetCount },
    (_, index) => '<Override PartName="/xl/worksheets/sheet' + String(index + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
  ).join("") +
  "</Types>";

const workbookValue = (value: string | null): string =>
  value === null ? "" : (splitBackupLongText(value)?.reference ?? value);

const columnName = (number: number): string => {
  if (!Number.isInteger(number) || number < 1 || number > MAX_COLS)
    fail("XLSX_MANIFEST_SHEET_INVALID");
  let output = "";
  for (let value = number; value > 0; value = Math.floor((value - 1) / 26))
    output = String.fromCharCode(65 + ((value - 1) % 26)) + output;
  return output;
};

const expectedManifestRows = (
  input: VerifyWorkbookManifestInput,
  sheetParts: readonly ManifestSheetPart[],
) => createManifestWorkbookRows({
  context: input.context,
  spoolId: input.context.spoolId,
  snapshotId: input.context.snapshotId,
  asOf: input.context.asOf,
  file: input.file,
  workbookRole: input.workbookRole,
  tableNumbers: input.tableNumbers,
  sheetParts,
});

const DERIVED_LOGICAL_NAMES: Readonly<Record<number, readonly string[]>> = Object.freeze({
  3: Object.freeze(["01_月度收入", "02_来源明细", "03_异常"]),
  7: Object.freeze([
    "01_原始分录", "02_入账月汇总", "03_账户余额对账", "04_账本异常",
    "05_业务期间", "06_业务期间链接", "07_业务期间异常",
  ]),
});

const expectedLogicalNames = (input: VerifyWorkbookManifestInput): readonly string[] => {
  if (input.workbookRole === "RAW") {
    const tables = createFullBackupLayout()
      .filter((item) => item.policy === "RAW_SOURCE" && input.file === "workbook-" + item.workbookId + ".xlsx")
      .map((item) => item.tableName);
    if (tables.length === 0) fail("XLSX_MANIFEST_WORKBOOK_SCOPE_INVALID");
    return Object.freeze(tables);
  }
  if (input.workbookRole === "BUSINESS_FACT") {
    const tables: string[] = [];
    for (const tableNumber of input.tableNumbers) {
      const sheet = BUSINESS_BACKUP_SHEETS.find((candidate) => candidate.tableNumber === tableNumber)
        ?? fail("XLSX_MANIFEST_WORKBOOK_SCOPE_INVALID");
      if (sheet.mode !== "STORED_FACTS") fail("XLSX_MANIFEST_WORKBOOK_SCOPE_INVALID");
      for (const source of [...sheet.rowKeyColumns, ...sheet.columns])
        if (!tables.includes(source.sourceTable)) tables.push(source.sourceTable);
    }
    if (tables.length === 0) fail("XLSX_MANIFEST_WORKBOOK_SCOPE_INVALID");
    return Object.freeze(tables);
  }
  const tables: string[] = [];
  for (const tableNumber of input.tableNumbers) {
    const names = DERIVED_LOGICAL_NAMES[tableNumber] ?? fail("XLSX_MANIFEST_WORKBOOK_SCOPE_INVALID");
    tables.push(...names);
  }
  if (tables.length === 0) fail("XLSX_MANIFEST_WORKBOOK_SCOPE_INVALID");
  return Object.freeze(tables);
};

class InlineCell {
  private value = "";
  private entity = "";

  push(value: string): void {
    if (this.entity) {
      this.entity += value;
      if (this.entity.length > 6) fail("XLSX_MANIFEST_XML_INVALID");
      if (value !== ";") return;
      this.value += decodeXmlText(this.entity);
      this.entity = "";
    } else if (value === "&") {
      this.entity = "&";
    } else {
      if (value === ">" || value === "\"" || value === "'" || value === "\r" || value === "<")
        fail("XLSX_MANIFEST_XML_INVALID");
      this.value += value;
    }
    if (this.value.length > MAX_TEXT_UNITS) fail("XLSX_MANIFEST_CELL_TOO_LARGE");
  }

  finish(): string {
    if (this.entity) fail("XLSX_MANIFEST_XML_INVALID");
    return normalizeDecodedText(this.value);
  }
}

/**
 * Strictly consumes current writer sheet XML without retaining business cells.
 * Its row count excludes the writer's first column-header row.
 */
class WorkbookSheetReader {
  private expected = "";
  private expectedIndex = 0;
  private expectedDone: (() => void) | undefined;
  private branch = "";
  private rowNumber: string | undefined;
  private rowOpen = false;
  private rowCellCount = 0;
  private headerWidth: number | undefined;
  private cell: InlineCell | undefined;
  private rows = 0;
  private ended = false;

  constructor() {
    this.expect(SHEET_PREFIX, () => this.rowOrEnd());
  }

  push(chunk: string): void {
    for (const character of chunk) {
      if (this.ended) fail("XLSX_MANIFEST_SHEET_INVALID");
      this.pushCharacter(character);
    }
  }

  finish(): string {
    if (!this.ended || this.expected || this.branch || this.rowNumber !== undefined || this.rowOpen || this.cell !== undefined ||
        this.rows === 0)
      fail("XLSX_MANIFEST_SHEET_INVALID");
    return String(this.rows - 1);
  }

  private pushCharacter(character: string): void {
    if (this.expected) {
      if (character !== this.expected[this.expectedIndex]) fail("XLSX_MANIFEST_SHEET_INVALID");
      this.expectedIndex += 1;
      if (this.expectedIndex === this.expected.length) {
        const done = this.expectedDone;
        this.expected = "";
        this.expectedIndex = 0;
        this.expectedDone = undefined;
        done?.();
      }
      return;
    }
    if (this.cell !== undefined) {
      if (character === "<") {
        const cell = this.cell;
        this.cell = undefined;
        cell.finish();
        this.expect("/t></is></c>", () => this.afterCell());
      } else {
        this.cell.push(character);
      }
      return;
    }
    if (this.rowNumber !== undefined) {
      if (character === "\"") {
        if (!/^[1-9]\d*$/u.test(this.rowNumber) || Number(this.rowNumber) !== this.rows + 1 ||
            Number(this.rowNumber) > MAX_ROWS)
          fail("XLSX_MANIFEST_SHEET_INVALID");
        this.rowNumber = undefined;
        this.expect(">", () => this.afterCell());
      } else {
        if (!/\d/u.test(character) || this.rowNumber.length >= 7) fail("XLSX_MANIFEST_SHEET_INVALID");
        this.rowNumber += character;
      }
      return;
    }
    this.branch += character;
    const rowPrefix = '<row r="';
    const cellPrefix = '<c r="';
    const allowed = this.rowOpen
      ? [cellPrefix, "</row>"]
      : [rowPrefix, SHEET_SUFFIX];
    if (allowed.some((prefix) => prefix.startsWith(this.branch))) {
      if (this.branch === rowPrefix) {
        this.branch = "";
        this.rowNumber = "";
        this.rowOpen = true;
        this.rowCellCount = 0;
      } else if (this.branch === cellPrefix) {
        if (!this.rowOpen) fail("XLSX_MANIFEST_SHEET_INVALID");
        this.branch = "";
        this.rowCellCount += 1;
        this.expect(
          columnName(this.rowCellCount) + String(this.rows + 1) +
            '" t="inlineStr"><is><t xml:space="preserve">',
          () => { this.cell = new InlineCell(); },
        );
      } else if (this.branch === "</row>") {
        this.branch = "";
        this.completeRow();
      } else if (this.branch === SHEET_SUFFIX) {
        this.branch = "";
        if (this.rowOpen) fail("XLSX_MANIFEST_SHEET_INVALID");
        this.ended = true;
      }
      return;
    }
    fail("XLSX_MANIFEST_SHEET_INVALID");
  }

  private expect(value: string, done: () => void): void {
    if (!value || this.expected || this.cell !== undefined) fail("XLSX_MANIFEST_SHEET_INVALID");
    this.expected = value;
    this.expectedDone = done;
  }

  private rowOrEnd(): void { this.branch = ""; }
  private afterCell(): void { this.branch = ""; }

  private completeRow(): void {
    if (!this.rowOpen || this.rowCellCount === 0) fail("XLSX_MANIFEST_SHEET_INVALID");
    this.rows += 1;
    if (this.rows === 1) this.headerWidth = this.rowCellCount;
    else if (this.rowCellCount !== this.headerWidth) fail("XLSX_MANIFEST_SHEET_INVALID");
    this.rowOpen = false;
    this.rowOrEnd();
  }
}

type ParsedManifest = Readonly<{
  result: VerifiedWorkbookManifest;
  mainSheetParts: readonly Readonly<{ sheetId: string; rowCount: string }>[];
}>;

class ManifestSheetReader {
  private expected = "";
  private expectedIndex = 0;
  private expectedDone: (() => void) | undefined;
  private branch = "";
  private rowNumber: string | undefined;
  private currentRow: string[] = [];
  private cell: InlineCell | undefined;
  private cellColumn: "A" | "B" | undefined;
  private rows = 0;
  private partRows: string[][] = [];
  private parts = 0;
  private readonly seenSheetIds = new Set<string>();
  private expectedLogicalIndex = 0;
  private currentLogicalName: string | undefined;
  private currentLogicalPartNo = 0;
  private currentLogicalRowCount = 0n;
  private readonly mainSheetParts: Array<Readonly<{ sheetId: string; rowCount: string }>> = [];
  private ended = false;

  constructor(
    private readonly input: VerifyWorkbookManifestInput,
    private readonly prefixRows: readonly (readonly [string, string | null])[],
    private readonly mainSheetNames: readonly string[],
    private readonly expectedLogicalNames: readonly string[],
  ) {
    this.expect(SHEET_PREFIX, () => this.rowOrEnd());
  }

  push(chunk: string): void {
    for (const character of chunk) {
      if (this.ended) fail("XLSX_MANIFEST_SHEET_INVALID");
      this.pushCharacter(character);
    }
  }

  finish(): ParsedManifest {
    if (!this.ended || this.expected || this.branch || this.rowNumber !== undefined || this.cell !== undefined ||
        this.partRows.length !== 0 || this.parts !== this.mainSheetNames.length ||
        this.expectedLogicalIndex + 1 !== this.expectedLogicalNames.length)
      fail("XLSX_MANIFEST_SHEET_INVALID");
    this.validateLogicalGroup();
    if (this.rows !== this.prefixRows.length + 1) {
      // Valid sheet parts add seven rows each; this equality only holds when
      // there are no parts, so use the parser's own validated total below.
      const minimum = this.prefixRows.length + 1;
      if (this.rows < minimum) fail("XLSX_MANIFEST_SHEET_INVALID");
    }
    return Object.freeze({
      result: Object.freeze({ manifestRowCount: String(this.rows - 1), mainSheetPartCount: String(this.parts) }),
      mainSheetParts: Object.freeze(this.mainSheetParts),
    });
  }

  private pushCharacter(character: string): void {
    if (this.expected) {
      if (character !== this.expected[this.expectedIndex]) fail("XLSX_MANIFEST_SHEET_INVALID");
      this.expectedIndex += 1;
      if (this.expectedIndex === this.expected.length) {
        const done = this.expectedDone;
        this.expected = "";
        this.expectedIndex = 0;
        this.expectedDone = undefined;
        done?.();
      }
      return;
    }
    if (this.cell !== undefined) {
      if (character === "<") {
        const cell = this.cell;
        this.cell = undefined;
        this.currentRow.push(cell.finish());
        this.expect("/t></is></c>", () => this.closeCell());
      } else {
        this.cell.push(character);
      }
      return;
    }
    if (this.rowNumber !== undefined) {
      if (character === "\"") {
        if (!/^[1-9]\d*$/u.test(this.rowNumber) || Number(this.rowNumber) !== this.rows + 1 || Number(this.rowNumber) > MAX_ROWS)
          fail("XLSX_MANIFEST_SHEET_INVALID");
        const row = this.rowNumber;
        this.rowNumber = undefined;
        this.expect(`><c r="A${row}" t="inlineStr"><is><t xml:space="preserve">`, () => this.openCell("A"));
      } else {
        if (!/\d/u.test(character) || this.rowNumber.length >= 7) fail("XLSX_MANIFEST_SHEET_INVALID");
        this.rowNumber += character;
      }
      return;
    }
    this.branch += character;
    const rowPrefix = '<row r="';
    if (rowPrefix.startsWith(this.branch) || SHEET_SUFFIX.startsWith(this.branch)) {
      if (this.branch === rowPrefix) {
        this.branch = "";
        this.rowNumber = "";
      } else if (this.branch === SHEET_SUFFIX) {
        this.branch = "";
        this.ended = true;
      }
      return;
    }
    fail("XLSX_MANIFEST_SHEET_INVALID");
  }

  private expect(value: string, done: () => void): void {
    if (!value || this.expected || this.cell !== undefined) fail("XLSX_MANIFEST_SHEET_INVALID");
    this.expected = value;
    this.expectedDone = done;
  }

  private rowOrEnd(): void { this.branch = ""; }

  private openCell(column: "A" | "B"): void {
    if (this.cell !== undefined || this.cellColumn !== undefined) fail("XLSX_MANIFEST_SHEET_INVALID");
    this.cellColumn = column;
    this.cell = new InlineCell();
  }

  private closeCell(): void {
    const column = this.cellColumn;
    this.cellColumn = undefined;
    if (column === "A") {
      const row = String(this.rows + 1);
      this.expect(`<c r="B${row}" t="inlineStr"><is><t xml:space="preserve">`, () => this.openCell("B"));
    } else if (column === "B") {
      this.expect("</row>", () => this.completeRow());
    } else {
      fail("XLSX_MANIFEST_SHEET_INVALID");
    }
  }

  private completeRow(): void {
    if (this.currentRow.length !== 2) fail("XLSX_MANIFEST_SHEET_INVALID");
    this.rows += 1;
    const row = this.currentRow;
    this.currentRow = [];
    if (this.rows === 1) {
      if (row[0] !== HEADER_ROW[0] || row[1] !== HEADER_ROW[1]) fail("XLSX_MANIFEST_SHEET_INVALID");
    } else if (this.rows <= this.prefixRows.length + 1) {
      const expected = this.prefixRows[this.rows - 2]!;
      if (row[0] !== workbookValue(expected[0]) || row[1] !== workbookValue(expected[1]))
        fail("XLSX_MANIFEST_PREFIX_MISMATCH");
    } else {
      this.partRows.push(row);
      if (this.partRows.length === 7) this.completePart();
    }
    this.rowOrEnd();
  }

  private completePart(): void {
    const rows = this.partRows;
    this.partRows = [];
    const first = rows[0]!;
    const suffix = ".logical_name";
    const firstField = first[0] ?? fail("XLSX_MANIFEST_PART_INVALID");
    if (!firstField.startsWith("sheet.") || !firstField.endsWith(suffix))
      fail("XLSX_MANIFEST_PART_INVALID");
    const sheetId = firstField.slice("sheet.".length, -suffix.length);
    if (!sheetId || this.seenSheetIds.has(sheetId.toLocaleLowerCase("en-US"))) fail("XLSX_MANIFEST_PART_INVALID");
    if (sheetId !== this.mainSheetNames[this.parts]) fail("XLSX_MANIFEST_PART_INVALID");
    const fields = [
      "logical_name", "part_no", "row_count", "source_table",
      "source_logical_digest", "page_logical_digest", "summary_scope",
    ];
    if (rows.some((row, index) => row[0] !== `sheet.${sheetId}.${fields[index]!}`))
      fail("XLSX_MANIFEST_PART_INVALID");
    const part: ManifestSheetPart = Object.freeze({
      sheetId,
      logicalName: first[1]!,
      partNo: rows[1]![1]!,
      rowCount: rows[2]![1]!,
      sourceTable: rows[3]![1] === "" ? null : rows[3]![1]!,
      sourceLogicalDigest: rows[4]![1] === "" ? null : rows[4]![1]!,
      pageLogicalDigest: rows[5]![1] === "" ? null : fail("XLSX_MANIFEST_PART_INVALID"),
      summaryScope: rows[6]![1] === "SOURCE_TABLE_DIGEST_ONLY" ? "SOURCE_TABLE_DIGEST_ONLY" : fail("XLSX_MANIFEST_PART_INVALID"),
    });
    if (this.currentLogicalName === undefined) {
      this.currentLogicalName = part.logicalName;
      this.currentLogicalPartNo = 0;
      this.currentLogicalRowCount = 0n;
    } else if (part.logicalName !== this.currentLogicalName) {
      this.validateLogicalGroup();
      this.expectedLogicalIndex += 1;
      if (part.logicalName !== this.expectedLogicalNames[this.expectedLogicalIndex]) fail("XLSX_MANIFEST_PART_INVALID");
      this.currentLogicalName = part.logicalName;
      this.currentLogicalPartNo = 0;
      this.currentLogicalRowCount = 0n;
    }
    if (part.logicalName !== this.expectedLogicalNames[this.expectedLogicalIndex])
      fail("XLSX_MANIFEST_PART_INVALID");
    this.currentLogicalPartNo += 1;
    if (part.partNo !== String(this.currentLogicalPartNo)) fail("XLSX_MANIFEST_PART_INVALID");
    if (this.input.workbookRole === "BUSINESS_DERIVED") {
      if (part.sourceTable !== null || part.sourceLogicalDigest !== null) fail("XLSX_MANIFEST_PART_INVALID");
    } else {
      const source = this.input.context.rawTables.find((table) => table.tableName === part.logicalName);
      if (source === undefined || part.sourceTable !== part.logicalName ||
          part.sourceLogicalDigest !== source.logicalDigest)
        fail("XLSX_MANIFEST_PART_INVALID");
      this.currentLogicalRowCount += BigInt(part.rowCount);
    }
    const expected = expectedManifestRows(this.input, [part])
      .slice(this.prefixRows.length)
      .map((row) => [workbookValue(row[0]), workbookValue(row[1])] as const);
    if (expected.length !== rows.length || expected.some((row, index) => row[0] !== rows[index]![0] || row[1] !== rows[index]![1]))
      fail("XLSX_MANIFEST_PART_INVALID");
    this.seenSheetIds.add(sheetId.toLocaleLowerCase("en-US"));
    this.mainSheetParts.push(Object.freeze({ sheetId, rowCount: part.rowCount }));
    this.parts += 1;
  }

  private validateLogicalGroup(): void {
    if (this.currentLogicalName === undefined) fail("XLSX_MANIFEST_PART_INVALID");
    if (this.input.workbookRole === "BUSINESS_DERIVED") return;
    const source = this.input.context.rawTables.find((table) => table.tableName === this.currentLogicalName)
      ?? fail("XLSX_MANIFEST_PART_INVALID");
    if (this.currentLogicalRowCount !== BigInt(source.rowCount)) fail("XLSX_MANIFEST_PART_INVALID");
  }
}

const readWorksheet = async <T>(
  handle: FileHandle,
  entry: Entry,
  reader: Readonly<{ push(chunk: string): void; finish(): T }>,
): Promise<T> => {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  await readEntry(handle, entry, (chunk) => {
    let decoded = "";
    try { decoded = decoder.decode(chunk, { stream: true }); }
    catch { fail("XLSX_MANIFEST_XML_INVALID"); }
    reader.push(decoded);
  });
  let finalText = "";
  try { finalText = decoder.decode(); }
  catch { fail("XLSX_MANIFEST_XML_INVALID"); }
  reader.push(finalText);
  return reader.finish();
};

/**
 * Verifies every ZIP32/STORE worksheet while retaining only manifest metadata.
 * Main sheet payloads are streamed only far enough to prove their row counts.
 */
export async function verifyWorkbookManifest(
  input: VerifyWorkbookManifestInput,
): Promise<VerifiedWorkbookManifest> {
  const prefixRows = expectedManifestRows(input, []);
  const handle = await openPrivateBackupFile(input.root, input.relativePath);
  let primaryError: unknown;
  try {
    const before = await snapshot(handle);
    const size = Number(before.size);
    const entries = await parseCentralDirectory(handle, size);
    const workbook = await collectEntryText(handle, entries.get("xl/workbook.xml")!);
    const names = parseWorkbook(workbook);
    if (entries.size !== entryNames(names.length).length) fail("XLSX_MANIFEST_WORKBOOK_INVALID");
    const contentTypes = await collectEntryText(handle, entries.get("[Content_Types].xml")!);
    if (contentTypes !== contentTypesXml(names.length)) fail("XLSX_MANIFEST_WORKBOOK_INVALID");
    const rootRelationships = await collectEntryText(handle, entries.get("_rels/.rels")!);
    if (rootRelationships !== ROOT_RELATIONSHIPS) fail("XLSX_MANIFEST_WORKBOOK_INVALID");
    const relationships = await collectEntryText(handle, entries.get("xl/_rels/workbook.xml.rels")!);
    if (relationships !== relationshipsXml(names.length)) fail("XLSX_MANIFEST_WORKBOOK_INVALID");
    const mainSheetNames = names.slice(1).filter((name) =>
      name !== "00_说明" && !name.startsWith("14_") && !name.startsWith("15_"),
    );
    const reader = new ManifestSheetReader(input, prefixRows, mainSheetNames, expectedLogicalNames(input));
    const manifest = await readWorksheet(handle, entries.get("xl/worksheets/sheet1.xml")!, reader);
    const mainParts = new Map(manifest.mainSheetParts.map((part) => [part.sheetId, part]));
    if (mainParts.size !== manifest.mainSheetParts.length) fail("XLSX_MANIFEST_PART_INVALID");
    for (let index = 1; index < names.length; index += 1) {
      const sheetName = names[index]!;
      const actualRows = await readWorksheet(
        handle,
        entries.get("xl/worksheets/sheet" + String(index + 1) + ".xml")!,
        new WorkbookSheetReader(),
      );
      const part = mainParts.get(sheetName);
      if (part !== undefined && actualRows !== part.rowCount) fail("XLSX_MANIFEST_PART_ROW_COUNT_INVALID");
    }
    unchanged(before, await snapshot(handle));
    return manifest.result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try { await handle.close(); }
    catch (cleanupError) {
      if (primaryError !== undefined)
        throw new AggregateError([primaryError, cleanupError], "XLSX_MANIFEST_FILE_CLEANUP_FAILED", { cause: primaryError });
      throw cleanupError;
    }
  }
}
