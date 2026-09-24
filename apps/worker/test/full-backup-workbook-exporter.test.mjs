import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { createFullBackupLayout } from "../dist/full-backup-layout.js";
import { FullBackupSpool } from "../dist/full-backup-spool.js";
import { FullBackupTransformer, fullBackupOutputColumns } from "../dist/full-backup-transformer.js";
import { FullBackupWorkbookExporter } from "../dist/full-backup-workbook-exporter.js";
import { writeXlsx } from "../dist/openxml-xlsx-writer.js";
import { restoreBackupLongText, splitBackupLongText } from "../dist/full-backup-long-text.js";

const run = promisify(execFile);
const layout = createFullBackupLayout();

const sourceFor = (rowsByTable) => ({
  async open() {
    return {
      mode: "SOURCE_ONLY",
      snapshotId: "workbook-snapshot",
      asOf: "2026-09-23T00:00:00.000Z",
      datasets: layout.map((item) => ({ tableName: item.tableName })),
      async countRows(tableName) { return BigInt(rowsByTable[tableName]?.length ?? 0); },
      async openStream(tableName) {
        let emitted = false;
        const rows = rowsByTable[tableName] ?? [];
        return {
          async next() {
            if (emitted || rows.length === 0) return { done: true, value: undefined };
            emitted = true;
            return { done: false, value: { datasetName: tableName, rows } };
          },
          async return() { return { done: true, value: undefined }; },
          async close() {},
          [Symbol.asyncIterator]() { return this; },
        };
      },
      async close() {},
    };
  },
});

const person = (longText, nickname = "=SUM(1,1)") => {
  const values = Object.fromEntries(fullBackupOutputColumns("person").map((column) => [column, null]));
  Object.assign(values, {
    id: "00000000000000000000000000000001",
    nickname,
    legal_name: longText,
    status: "ACTIVE",
    created_at: "2026-09-23T00:00:00.000Z",
    updated_at: "2026-09-23T00:00:00.000Z",
  });
  return { exportValues: values, transformValues: new Map() };
};

const createSpool = async (root, longText, nickname) => new FullBackupSpool({
  source: sourceFor({ person: [person(longText, nickname)] }),
  transformer: new FullBackupTransformer({
    fingerprint: ({ domain, value }) => createHash("sha256").update(`${domain}\u0000${value}`).digest("hex"),
  }),
  tempRoot: root,
  batchSize: 1,
}).create();

test("spool完整消费后生成可解压XLSX，长文本无损索引且业务文本始终是字符串", async () => {
  const root = await mkdtemp(join(tmpdir(), "alliance-workbook-"));
  try {
    const raw = "x".repeat(31_999) + "😀" + "\r\n=文本".repeat(2_000);
    const expectedLong = splitBackupLongText(raw);
    const spool = await createSpool(join(root, "spools"), raw);
    const spoolDirectory = join(root, "spools", spool.spoolId);
    const result = await new FullBackupWorkbookExporter({ spoolDirectory, spool, outputRoot: join(root, "out") }).export();
    assert.equal(result.mode, "RAW_SOURCE_WORKBOOKS");
    assert.equal(result.workbooks.length, 13);
    assert.equal(result.workbooks.some((item) => item.workbookId === "02"), true);
    assert.deepEqual(
      (await readdir(join(root, "out", result.outputId))).sort(),
      result.workbooks.map((item) => item.file).sort(),
    );
    const workbook = join(root, "out", result.outputId, "workbook-02.xlsx");
    const { stdout } = await run("python3", ["-c", `import zipfile,xml.etree.ElementTree as E,json,sys
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
book=E.fromstring(z.read('xl/workbook.xml')); rels=E.fromstring(z.read('xl/_rels/workbook.xml.rels'))
targets={r.attrib['Id']:r.attrib['Target'] for r in rels}
out={}
for s in book.findall('.//m:sheet',ns):
 root=E.fromstring(z.read('xl/'+targets[s.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]))
 assert not root.findall('.//m:f',ns)
 rows=[]
 for row in root.findall('.//m:row',ns):
  cells=row.findall('m:c',ns); assert all(c.attrib.get('t')=='inlineStr' for c in cells)
  rows.append([c.find('.//m:t',ns).text or '' for c in cells])
 out[s.attrib['name']]=rows
print(json.dumps(out,ensure_ascii=False))`, workbook], { maxBuffer: 12 * 1024 * 1024 });
    const sheets = JSON.parse(stdout);
    const personSheet = Object.values(sheets).find((rows) => rows[0]?.includes("legal_name"));
    const longSheet = Object.entries(sheets).find(([name]) => name.startsWith("14_长文本分片_"))?.[1];
    assert.ok(personSheet);
    assert.ok(longSheet);
    const legalNameIndex = personSheet[0].indexOf("legal_name");
    const reference = personSheet[1][legalNameIndex];
    assert.equal(reference, expectedLong.reference);
    assert.equal(personSheet[1][personSheet[0].indexOf("nickname")], "=SUM(1,1)");
    const parts = longSheet.slice(1).map((row) => row[6]);
    assert.equal(restoreBackupLongText({ ...expectedLong, chunks: parts }), raw);
    assert.equal(longSheet[0].join(","), "long_text_ref,source_table,source_record_key,source_row_number,field_name,part_no,part_text");
    assert.equal(longSheet[1][2], JSON.stringify([["id", "00000000000000000000000000000001"]]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("损坏 spool 由 reader 拒绝，导出器只清理本次输出目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "alliance-workbook-corrupt-"));
  try {
    const spool = await createSpool(join(root, "spools"), "正常");
    const spoolDirectory = join(root, "spools", spool.spoolId);
    const people = spool.datasets.find((dataset) => dataset.tableName === "person");
    const file = join(spoolDirectory, people.spoolFile);
    const original = await readFile(file, "utf8");
    await writeFile(file, original.slice(0, -1));
    const outputRoot = join(root, "out");
    await assert.rejects(
      () => new FullBackupWorkbookExporter({ spoolDirectory, spool, outputRoot }).export(),
      /EXPORT_SPOOL_INTEGRITY_FAILED/,
    );
    assert.equal((await readdir(outputRoot)).length, 0);
    assert.equal((await readdir(spoolDirectory)).includes("datasets"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writer 中断后关闭尚未耗尽的 dataset reader 并清理本次目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "alliance-workbook-writer-failure-"));
  try {
    const spool = await createSpool(join(root, "spools"), "正常");
    const spoolDirectory = join(root, "spools", spool.spoolId);
    let personReturns = 0;
    const readDataset = (_directory, dataset) => {
      const row = dataset.tableName === "person"
        ? fullBackupOutputColumns("person").map((column) => person("正常").exportValues[column])
        : undefined;
      let emitted = false;
      let closed = false;
      return {
        async next() {
          if (closed || row === undefined || emitted) return { done: true, value: undefined };
          emitted = true;
          return { done: false, value: row };
        },
        async return() {
          closed = true;
          if (dataset.tableName === "person") personReturns += 1;
          return { done: true, value: undefined };
        },
        [Symbol.asyncIterator]() { return this; },
      };
    };
    const writeWorkbook = async (options) => {
      const { sheets } = options;
      if (!sheets.some(sheet => sheet.columns?.includes("nickname"))) return writeXlsx(options);
      for (const sheet of sheets) {
        if (sheet.rows === undefined) continue;
        const iterator = sheet.rows[Symbol.asyncIterator]();
        if (sheet.columns?.includes("nickname")) {
          assert.equal((await iterator.next()).done, false);
          throw new Error("TEST_WORKBOOK_WRITE_FAILED");
        }
        for await (const _row of { [Symbol.asyncIterator]: () => iterator }) {
          // Consume prior workbooks exactly as a real writer does.
        }
      }
    };
    const outputRoot = join(root, "out");
    await assert.rejects(
      () => new FullBackupWorkbookExporter({ spoolDirectory, spool, outputRoot, readDataset, writeWorkbook }).export(),
      /TEST_WORKBOOK_WRITE_FAILED/,
    );
    assert.equal(personReturns, 1);
    assert.equal((await readdir(outputRoot)).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("NULL 坐标索引保留 null 与真实空字符串的可逆区别", async () => {
  const root = await mkdtemp(join(tmpdir(), "alliance-workbook-null-index-"));
  try {
    const spool = await createSpool(join(root, "spools"), null, "");
    const spoolDirectory = join(root, "spools", spool.spoolId);
    const result = await new FullBackupWorkbookExporter({ spoolDirectory, spool, outputRoot: join(root, "out") }).export();
    const workbook = join(root, "out", result.outputId, "workbook-02.xlsx");
    const { stdout } = await run("python3", ["-c", `import zipfile,xml.etree.ElementTree as E,json,sys
z=zipfile.ZipFile(sys.argv[1]); ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
book=E.fromstring(z.read('xl/workbook.xml')); rels=E.fromstring(z.read('xl/_rels/workbook.xml.rels')); targets={r.attrib['Id']:r.attrib['Target'] for r in rels}; out={}
for s in book.findall('.//m:sheet',ns):
 root=E.fromstring(z.read('xl/'+targets[s.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]))
 out[s.attrib['name']]=[[c.find('.//m:t',ns).text or '' for c in row.findall('m:c',ns)] for row in root.findall('.//m:row',ns)]
print(json.dumps(out,ensure_ascii=False))`, workbook]);
    const sheets = JSON.parse(stdout);
    const personSheet = Object.values(sheets).find((rows) => rows[0]?.includes("legal_name"));
    const nullSheet = Object.entries(sheets).find(([name]) => name.startsWith("15_NULL坐标_"))?.[1];
    assert.ok(personSheet);
    assert.ok(nullSheet);
    assert.equal(personSheet[1][personSheet[0].indexOf("nickname")], "");
    assert.equal(personSheet[1][personSheet[0].indexOf("legal_name")], "");
    const coordinates = nullSheet.slice(1).map((row) => row.join("/"));
    const recordKey = JSON.stringify([["id", "00000000000000000000000000000001"]]);
    assert.equal(coordinates.includes(`person/${recordKey}/1/legal_name`), true);
    assert.equal(coordinates.includes(`person/${recordKey}/1/nickname`), false);
    assert.equal(nullSheet[0].join(","), "source_table,source_record_key,source_row_number,field_name");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("复合主键中的幂等键仅以 fingerprint 进入长文本坐标", async () => {
  const root = await mkdtemp(join(tmpdir(), "alliance-workbook-record-key-"));
  try {
    const rawIdempotencyKey = "raw-idempotency-key-must-not-export";
    const referralRow = {
      exportValues: {
        actor_person_id: "actor-0001",
        request_hash: "R".repeat(32_001),
        referral_case_id: "case-0001",
        created_at: "2026-09-23T00:00:00.000Z",
        accepted_referral_version: "1",
      },
      transformValues: new Map([["idempotency_key", rawIdempotencyKey]]),
    };
    const spool = await new FullBackupSpool({
      source: sourceFor({ referral_acceptance_idempotency: [referralRow] }),
      transformer: new FullBackupTransformer({
        fingerprint: ({ domain, value }) => createHash("sha256").update(`${domain}\u0000${value}`).digest("hex"),
      }),
      tempRoot: join(root, "spools"),
      batchSize: 1,
    }).create();
    const result = await new FullBackupWorkbookExporter({
      spoolDirectory: join(root, "spools", spool.spoolId),
      spool,
      outputRoot: join(root, "out"),
    }).export();
    const workbook = join(root, "out", result.outputId, "workbook-03.xlsx");
    const { stdout } = await run("python3", ["-c", `import zipfile,xml.etree.ElementTree as E,json,sys
z=zipfile.ZipFile(sys.argv[1]); ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
book=E.fromstring(z.read('xl/workbook.xml')); rels=E.fromstring(z.read('xl/_rels/workbook.xml.rels')); targets={r.attrib['Id']:r.attrib['Target'] for r in rels}; out={}
for s in book.findall('.//m:sheet',ns):
 root=E.fromstring(z.read('xl/'+targets[s.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]))
 out[s.attrib['name']]=[[c.find('.//m:t',ns).text or '' for c in row.findall('m:c',ns)] for row in root.findall('.//m:row',ns)]
print(json.dumps(out,ensure_ascii=False))`, workbook]);
    const sheets = JSON.parse(stdout);
    const sourceSheet = Object.values(sheets).find((rows) => rows[0]?.includes("idempotency_key_fingerprint"));
    const longSheet = Object.entries(sheets).find(([name]) => name.startsWith("14_长文本分片_"))?.[1];
    assert.ok(sourceSheet);
    assert.ok(longSheet);
    const fingerprint = sourceSheet[1][sourceSheet[0].indexOf("idempotency_key_fingerprint")];
    assert.match(fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(sheets).includes(rawIdempotencyKey), false);
    assert.deepEqual(JSON.parse(longSheet[1][2]), [
      ["actor_person_id", "actor-0001"],
      ["idempotency_key_fingerprint", fingerprint],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("完整性主错误优先于 reader 释放错误", async () => {
  const root = await mkdtemp(join(tmpdir(), "alliance-workbook-primary-error-"));
  try {
    const spool = await createSpool(join(root, "spools"), "正常");
    const spoolDirectory = join(root, "spools", spool.spoolId);
    let personReads = 0;
    const readDataset = (_directory, dataset) => {
      const values = dataset.tableName === "person"
        ? fullBackupOutputColumns("person").map((column) => person("正常").exportValues[column])
        : undefined;
      const isSecondPersonRead = dataset.tableName === "person" && personReads++ > 0;
      let emitted = false;
      return {
        async next() {
          if (isSecondPersonRead) throw new Error("EXPORT_SPOOL_INTEGRITY_FAILED");
          if (emitted || values === undefined) return { done: true, value: undefined };
          emitted = true;
          return { done: false, value: values };
        },
        async return() {
          if (isSecondPersonRead) throw new Error("TEST_READER_RETURN_FAILED");
          return { done: true, value: undefined };
        },
        [Symbol.asyncIterator]() { return this; },
      };
    };
    const writeWorkbook = async (options) => {
      const { sheets } = options;
      if (!sheets.some(sheet => sheet.columns?.includes("nickname"))) return writeXlsx(options);
      for (const sheet of sheets) {
        if (sheet.rows === undefined) continue;
        for await (const _row of sheet.rows) {
          // The person sheet's second reader fails inside this normal writer loop.
        }
      }
    };
    await assert.rejects(
      () => new FullBackupWorkbookExporter({ spoolDirectory, spool, outputRoot: join(root, "out"), readDataset, writeWorkbook }).export(),
      /EXPORT_SPOOL_INTEGRITY_FAILED/,
    );
    assert.equal((await readdir(join(root, "out"))).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("成功写盘后私有索引清理失败会使整次导出失败", async () => {
  const root = await mkdtemp(join(tmpdir(), "alliance-workbook-cleanup-failure-"));
  try {
    const spool = await createSpool(join(root, "spools"), "正常");
    const outputRoot = join(root, "out");
    await assert.rejects(
      () => new FullBackupWorkbookExporter({
        spoolDirectory: join(root, "spools", spool.spoolId),
        spool,
        outputRoot,
        removeIndexFile: async () => { throw new Error("TEST_INDEX_REMOVE_FAILED"); },
      }).export(),
      /EXPORT_WORKBOOK_TEMP_CLEANUP_FAILED/,
    );
    assert.equal((await readdir(outputRoot)).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RAW manifest uses verified same-snapshot evidence in all thirteen workbooks and preserves NULL coordinates", async () => {
  const { FullBackupDerivedSpoolIndex } = await import('../dist/full-backup-derived-spool-index.js');
  const { FullBackupLedgerDerivedView } = await import('../dist/full-backup-ledger-derived-view.js');
  const { FullBackupLedgerBusinessPeriodSource } = await import('../dist/full-backup-ledger-business-period-source.js');
  const { FullBackupManifestEvidence } = await import('../dist/full-backup-manifest-evidence.js');
  const { createFullBackupManifestContext } = await import('../dist/full-backup-manifest.js');
  const root = await mkdtemp(join(tmpdir(), 'alliance-raw-manifest-'));
  let index, ledger, periods;
  try {
    const spool = await createSpool(join(root, 'spools'), 'manifest-source');
    const spoolDirectory = join(root, 'spools', spool.spoolId);
    index = await FullBackupDerivedSpoolIndex.create({spoolDirectory,spool,attemptRoot:join(root,'index')});
    ledger = await FullBackupLedgerDerivedView.create({index,attemptRoot:join(root,'ledger')});
    periods = await FullBackupLedgerBusinessPeriodSource.create({index,attemptRoot:join(root,'periods')});
    const evidence = await FullBackupManifestEvidence.collect({spoolDirectory,spool,index,ledger,periods});
    const context = createFullBackupManifestContext({evidence,fileGroupId:'synthetic-file-group',generatedAt:'2026-09-23T01:00:00.000Z',applicationVersion:'0.1.0',generatorVersion:'test-1'});
    const outputRoot=join(root,'out');
    const result=await new FullBackupWorkbookExporter({spoolDirectory,spool,outputRoot,manifestContext:context}).export();
    assert.equal(result.workbooks.length,13);
    const {stdout}=await run('python3',['-c',`import zipfile,xml.etree.ElementTree as E,json,sys,pathlib
ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
result=[]
for p in sorted(pathlib.Path(sys.argv[1]).glob('*.xlsx')):
 z=zipfile.ZipFile(p); book=E.fromstring(z.read('xl/workbook.xml'))
 names=[s.attrib['name'] for s in book.findall('.//m:sheet',ns)]
 assert names[0]=='00_manifest',names
 doc=E.fromstring(z.read('xl/worksheets/sheet1.xml'))
 assert not doc.findall('.//m:f',ns)
 rows=[[ ''.join(c.itertext()) for c in r.findall('m:c',ns)] for r in doc.findall('.//m:row',ns)]
 flat=json.dumps(rows,ensure_ascii=False)
 assert 'synthetic-file-group' in flat and 'INCOMPLETE_IMPLEMENTATION' in flat
 assert 'package-manifest.json' in flat
 assert '${spool.snapshotId}' in flat
 null_idx=next(i for i,n in enumerate(names) if n.startswith('15_NULL'))
 null_data=z.read('xl/worksheets/sheet'+str(null_idx+1)+'.xml').decode()
 assert '00_manifest' in null_data and 'backup_id' in null_data
 result.append(p.name)
print(json.dumps(result))`,join(outputRoot,result.outputId)]);
    assert.equal(JSON.parse(stdout).length,13);
    await assert.rejects(new FullBackupWorkbookExporter({spoolDirectory,spool,outputRoot,manifestContext:{...context,snapshotId:'another-snapshot'}}).export(),/MANIFEST/);
    const changed={...context,rawTables:context.rawTables.map(row=>row.tableName==='person'?{...row,rowCount:'2'}:row)};
    await assert.rejects(new FullBackupWorkbookExporter({spoolDirectory,spool,outputRoot,manifestContext:changed}).export(),/MANIFEST/);
    for (const field of ['firstStableKey', 'lastStableKey']) {
      const forged = {...context,rawTables:context.rawTables.map(row=>row.tableName==='person'?{...row,[field]:'forged-record-key'}:row)};
      await assert.rejects(new FullBackupWorkbookExporter({spoolDirectory,spool,outputRoot,manifestContext:forged}).export(),/EXPORT_WORKBOOK_MANIFEST_SOURCE_MISMATCH/);
    }
    assert.deepEqual(await readdir(outputRoot),[result.outputId]);
  } finally {
    await periods?.close();await ledger?.close();await index?.close();
    await rm(root,{recursive:true,force:true});
  }
});
