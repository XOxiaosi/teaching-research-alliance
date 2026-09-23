import { ZipStoreWriter } from "./zip-store-writer.js";

const MAX_ROWS = 1_048_576, MAX_COLS = 16_384, MAX_CHARS = 32_767;
const invalidXml = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u;
const xml = (value: unknown): string => { const text = String(value ?? ""); if (invalidXml.test(text) || /[\uD800-\uDFFF]/u.test(text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, ""))) throw new Error("value contains an illegal XML character"); if (text.length > MAX_CHARS) throw new Error("cell exceeds Excel 32,767 UTF-16 character limit"); return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;").replaceAll("\r", "&#xD;").replace(/_x([0-9A-Fa-f]{4})_/g, "_x005F_x$1_"); };
const col = (n: number): string => { if (!Number.isInteger(n) || n < 1 || n > MAX_COLS) throw new Error("Excel column limit exceeded"); let s = ""; for (let x = n; x; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s; return s; };
const sheetName = (name: string, seen: Set<string>): void => { if (!name || name.length > 31 || /^'|'$/u.test(name) || /[:\\/?*\[\]]/u.test(name)) throw new Error(`invalid Excel worksheet name: ${name}`); const key = name.toLocaleLowerCase("en-US"); if (seen.has(key)) throw new Error(`duplicate worksheet name: ${name}`); seen.add(key); };
const entry = async (zip: ZipStoreWriter, name: string, value: string) => zip.addEntry(name, [value]);

export type XlsxSheet = Readonly<{ name: string; columns?: readonly unknown[]; rows?: AsyncIterable<readonly unknown[]> | Iterable<readonly unknown[]> }>;
export type XlsxOptions = Readonly<{ outputPath: string; sheets: readonly XlsxSheet[] }>;

export async function writeXlsx(options: XlsxOptions): Promise<void> {
  if (!options.sheets.length) throw new Error("at least one worksheet is required");
  const seen = new Set<string>(); options.sheets.forEach((s) => sheetName(s.name, seen));
  const zip = await ZipStoreWriter.create(options.outputPath);
  try {
    await entry(zip, "[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${options.sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`);
    await entry(zip, "_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
    await entry(zip, "xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${options.sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`);
    await entry(zip, "xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${options.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`);
    for (let index = 0; index < options.sheets.length; index += 1) {
      const sheet = options.sheets[index]!; let rowNumber = 0;
      const writeRow = (values: readonly unknown[]): string => { if (values.length > MAX_COLS) throw new Error("Excel column limit exceeded"); rowNumber += 1; if (rowNumber > MAX_ROWS) throw new Error("Excel row limit exceeded"); return `<row r="${rowNumber}">${values.map((v, i) => `<c r="${col(i + 1)}${rowNumber}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`).join("")}</row>`; };
      const sheetChunks = async function* (): AsyncIterable<string> {
        yield `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`;
        if (sheet.columns) yield writeRow(sheet.columns);
        if (sheet.rows) for await (const values of sheet.rows) yield writeRow(values);
        yield "</sheetData></worksheet>";
      };
      await zip.addEntry(`xl/worksheets/sheet${index + 1}.xml`, sheetChunks());
    }
    await zip.close();
  } catch (error) { await zip.abort(); throw error; }
}

export const xlsxLimits = { MAX_ROWS, MAX_COLS, MAX_CHARS } as const;
