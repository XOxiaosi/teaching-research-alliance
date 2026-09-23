import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeXlsx } from "../dist/openxml-xlsx-writer.js";
const run = promisify(execFile);
const py = async (file) => (await run("python3", ["-c", `import zipfile,xml.etree.ElementTree as E,sys
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
assert 'xl/workbook.xml' in z.namelist() and 'xl/_rels/workbook.xml.rels' in z.namelist()
rels=E.fromstring(z.read('xl/_rels/workbook.xml.rels')); assert rels.find('.//{http://schemas.openxmlformats.org/package/2006/relationships}Relationship').attrib['Target']=='worksheets/sheet1.xml'
raw=z.read('xl/worksheets/sheet1.xml'); assert b'_x005F_x1234_' in raw
root=E.fromstring(raw); ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
cells=root.findall('.//m:c',ns); vals=[c.find('.//m:t',ns).text for c in cells]; assert all(c.attrib.get('t')=='inlineStr' for c in cells)
assert all(x in vals for x in ['编号001234567890123','<script>','=1+1','中文'])
assert any(chr(13) in x for x in vals)`, file])).stdout;
test("writes valid Unicode inlineStr xlsx and Python validates CRC/relationships", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xlsx-writer-")); const file = join(dir, "backup.xlsx");
  await writeXlsx({ outputPath: file, sheets: [{ name: "00_manifest", columns: ["编号", "内容", "公式"], rows: [["编号001234567890123", "<script>", "=1+1", "中文"], ["line\rbreak", "_x1234_", "🙂"]] }] });
  await py(file); assert.equal((await stat(file)).mode & 0o777, 0o600);
});
test("writes empty sheet", async () => { const dir = await mkdtemp(join(tmpdir(), "xlsx-empty-")); const file = join(dir, "empty.xlsx"); await writeXlsx({ outputPath: file, sheets: [{ name: "空表" }] }); assert.match((await readFile(file)).toString("binary"), /PK/); });
for (const [name, make] of [["illegal XML control", () => ({ sheets: [{ name: "x", rows: [["bad\u0001"]] }] })], ["long cell", () => ({ sheets: [{ name: "x", rows: [["x".repeat(32768)]] }] })], ["bad name", () => ({ sheets: [{ name: "a/b" }] })]]) {
  test(`rejects ${name} and cleans temp`, async () => { const dir = await mkdtemp(join(tmpdir(), "xlsx-fail-")); const file = join(dir, "fail.xlsx"); await assert.rejects(writeXlsx({ outputPath: file, ...make() })); assert.equal((await readdir(dir)).length, 0); });
}
test("does not overwrite existing output", async () => { const dir = await mkdtemp(join(tmpdir(), "xlsx-no-overwrite-")); const file = join(dir, "same.xlsx"); await writeXlsx({ outputPath: file, sheets: [{ name: "x" }] }); await assert.rejects(writeXlsx({ outputPath: file, sheets: [{ name: "x" }] }), /overwrite/); });
test("rejects unsafe or duplicate ZIP entries", async () => { const { ZipStoreWriter } = await import("../dist/zip-store-writer.js"); for (const name of ["../escape", "/absolute", "C:/escape", "a//b", "a/./b", "a/../b", "a/"]) { const dir = await mkdtemp(join(tmpdir(), "zip-fail-")); const zip = await ZipStoreWriter.create(join(dir, "x.zip")); await assert.rejects(zip.addEntry(name, ["x"])); await zip.abort(); } });
test("rejects lone surrogate and case-insensitive sheet duplicates", async () => { const dir = await mkdtemp(join(tmpdir(), "xlsx-limit-")); await assert.rejects(writeXlsx({ outputPath: join(dir, "surrogate.xlsx"), sheets: [{ name: "x", rows: [["\uD800"]] }] })); await assert.rejects(writeXlsx({ outputPath: join(dir, "duplicate.xlsx"), sheets: [{ name: "Sheet", }, { name: "sheet" }] }), /duplicate/); });
