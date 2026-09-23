import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fixture } from "../../../api/test/integration/refund-review-fixture.mjs";
import { FullBackupDerivedSpoolIndex } from "../../dist/full-backup-derived-spool-index.js";
import { FullBackupLedgerBusinessPeriodSource } from "../../dist/full-backup-ledger-business-period-source.js";
import { FullBackupLedgerDerivedView } from "../../dist/full-backup-ledger-derived-view.js";
import { FullBackupLedgerWorkbook } from "../../dist/full-backup-ledger-workbook.js";
import { FullBackupSpool } from "../../dist/full-backup-spool.js";
import { FullBackupTransformer } from "../../dist/full-backup-transformer.js";
import { PostgresFullBackupSource } from "../../dist/postgres-full-backup-source.js";

const run = promisify(execFile);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const sheets = async (file) => {
  const { stdout } = await run("python3", ["-c", `import zipfile,xml.etree.ElementTree as E,json,sys
z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None
ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
b=E.fromstring(z.read('xl/workbook.xml'));rels=E.fromstring(z.read('xl/_rels/workbook.xml.rels'));targets={x.attrib['Id']:x.attrib['Target'] for x in rels};out={}
for s in b.findall('.//m:sheet',ns):
 r=E.fromstring(z.read('xl/'+targets[s.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]))
 assert not r.findall('.//m:f',ns);out[s.attrib['name']]=[[c.find('.//m:t',ns).text or '' for c in row.findall('m:c',ns)] for row in r.findall('.//m:row',ns)]
print(json.dumps(out,ensure_ascii=False))`, file]);
  return JSON.parse(stdout);
};

test("real PostgreSQL table-7 workbook renders settled and approved-refund ledger evidence from one immutable spool", async () => {
  const f = await fixture();
  const root = await mkdtemp(join(tmpdir(), "ledger-workbook-pg-"));
  let index, ledger, periods;
  try {
    const document = await f.pending();
    await f.approve(document, "ledger-workbook-refund-approval");
    const spool = await new FullBackupSpool({ source: new PostgresFullBackupSource(f.pool), transformer: new FullBackupTransformer({ fingerprint: ({ domain, value }) => sha(`${domain}\0${value}`) }), tempRoot: join(root, "spool"), batchSize: 1 }).create();
    const spoolDirectory = join(root, "spool", spool.spoolId);
    index = await FullBackupDerivedSpoolIndex.create({ spoolDirectory, spool, attemptRoot: join(root, "index") });
    ledger = await FullBackupLedgerDerivedView.create({ index, attemptRoot: join(root, "ledger") });
    periods = await FullBackupLedgerBusinessPeriodSource.create({ index, attemptRoot: join(root, "period") });
    const result = await new FullBackupLedgerWorkbook({ index, ledger, periods, outputRoot: join(root, "out") }).export();
    assert.deepEqual({ mode: result.mode, complete: result.complete, tableNumber: result.tableNumber, coveredTables: result.coveredTables, spoolId: result.spoolId, snapshotId: result.snapshotId }, { mode:"LEDGER_DERIVED_WORKBOOK", complete:false, tableNumber:7, coveredTables:[7], spoolId:spool.spoolId, snapshotId:spool.snapshotId });
    assert.ok(BigInt(result.entryRowCount) > 0n); assert.ok(BigInt(result.monthlyRowCount) > 0n); assert.ok(BigInt(result.periodEventCount) > 0n); assert.ok(BigInt(result.periodLinkCount) > 0n);
    const directory = join(root, "out", result.outputId), file = join(directory, result.file);
    const bytes = await readFile(file); assert.equal(result.sizeBytes, String(bytes.byteLength)); assert.equal(result.sha256, sha(bytes)); assert.deepEqual(await readdir(directory), [result.file]);
    const book = await sheets(file);
    for (const name of ["00_说明", "01_原始分录", "02_入账月汇总", "03_账户余额对账", "04_账本异常", "05_业务期间", "06_业务期间链接", "07_业务期间异常", "14_长文本", "15_NULL坐标"]) assert.ok(book[name], name);
    assert.equal(book["00_说明"].some((row) => row[0] === "完整备份" && row[1] === "false"), true);
    assert.equal(book["00_说明"].some((row) => row[0] === "已发布结算" && row[1].includes("未实现")), true);
    const rawHeader = book["01_原始分录"][0];
    assert.equal(book["01_原始分录"].slice(1).some((row) => row[rawHeader.indexOf("事件类型")] === "WEEKLY_FEE_REFUND"), true);
    assert.equal(book["01_原始分录"].slice(1).every((row) => /^-?\d+\.\d{2}$/.test(row[rawHeader.indexOf("金额豆精确 [amount_beans_exact]")]) || row[rawHeader.indexOf("金额豆精确 [amount_beans_exact]")] === ""), true);
    const periodHeader = book["05_业务期间"][0];
    assert.equal(book["05_业务期间"].slice(1).some((row) => row[periodHeader.indexOf("事件类型")] === "WEEKLY_FEE_REFUND" && row[periodHeader.indexOf("业务期间状态")] === "UNIQUE_LOCKED_SETTLEMENT_MONTH"), true);
  } finally {
    await periods?.close().catch(() => undefined); await ledger?.close().catch(() => undefined); await index?.close().catch(() => undefined);
    await rm(root, { recursive:true, force:true }); await f.close();
  }
});
