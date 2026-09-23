import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fixture } from "../../../api/test/integration/refund-review-fixture.mjs";
import { FullBackupAttachmentExporter } from "../../dist/full-backup-attachment-exporter.js";
import { FullBackupBusinessFactsWorkbookExporter } from "../../dist/full-backup-business-facts-workbook-exporter.js";
import { FullBackupDerivedSpoolIndex } from "../../dist/full-backup-derived-spool-index.js";
import { FullBackupIncomeDerivedView } from "../../dist/full-backup-income-derived-view.js";
import { FullBackupIncomeWorkbook } from "../../dist/full-backup-income-workbook.js";
import { FullBackupLedgerBusinessPeriodSource } from "../../dist/full-backup-ledger-business-period-source.js";
import { FullBackupLedgerDerivedView } from "../../dist/full-backup-ledger-derived-view.js";
import { FullBackupLedgerWorkbook } from "../../dist/full-backup-ledger-workbook.js";
import { FullBackupLocalPackageAssembler } from "../../dist/full-backup-local-package-assembler.js";
import { FullBackupSpool } from "../../dist/full-backup-spool.js";
import { FullBackupTransformer } from "../../dist/full-backup-transformer.js";
import { FullBackupWorkbookExporter } from "../../dist/full-backup-workbook-exporter.js";
import { PostgresFullBackupSource } from "../../dist/postgres-full-backup-source.js";

import { FullBackupManifestEvidence } from "../../dist/full-backup-manifest-evidence.js";
import { createFullBackupManifestContext } from "../../dist/full-backup-manifest.js";
const run = promisify(execFile);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const profiles = [
  ["teacher", "TEACHER"],
  ["student", "STUDENT"],
  ["finance", "FINANCE"],
  ["payroll", "PAYROLL"],
  ["deduction", "DEDUCTION"],
  ["performanceConfiguration", "PERFORMANCE_CONFIGURATION"],
];

const xlsxSheets = async (file) => {
  const { stdout } = await run("python3", [
    "-c",
    `import json,sys,zipfile,xml.etree.ElementTree as E
z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None
n={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
book=E.fromstring(z.read('xl/workbook.xml'));rels=E.fromstring(z.read('xl/_rels/workbook.xml.rels'));targets={x.attrib['Id']:x.attrib['Target'] for x in rels};out={}
for sheet in book.findall('.//m:sheet',n):
 rid=sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'];xml=E.fromstring(z.read('xl/'+targets[rid]));rows=[]
 for row in xml.findall('.//m:row',n):
  values=[]
  for cell in row.findall('m:c',n):
   text=cell.find('.//m:t',n);values.append('' if text is None or text.text is None else text.text)
  rows.append(values)
 out[sheet.attrib['name']]=rows
print(json.dumps(out,ensure_ascii=False))`,
    file,
  ]);
  return JSON.parse(stdout);
};

test("real PG final manifest verifies all 20 workbooks, attachment bytes and isolated failed attempts", async () => {
  const f = await fixture();
  const root = await mkdtemp(join(tmpdir(), "derived-package-pg-"));
  let index, income, ledger, periods;
  try {
    const refund = await f.pending();
    await f.approve(refund, "derived-package-refund-approval");

    const spool = await new FullBackupSpool({
        source: new PostgresFullBackupSource(f.pool),
        transformer: new FullBackupTransformer({
          fingerprint: ({ domain, value }) => hash(`${domain}\0${value}`),
        }),
        tempRoot: join(root, "spool"),
        batchSize: 1,
      }).create(),
      spoolDirectory = join(root, "spool", spool.spoolId);
    index = await FullBackupDerivedSpoolIndex.create({
      spoolDirectory,
      spool,
      attemptRoot: join(root, "index"),
    });
    income = await FullBackupIncomeDerivedView.create({
      index,
      attemptRoot: join(root, "income"),
    });
    ledger = await FullBackupLedgerDerivedView.create({
      index,
      attemptRoot: join(root, "ledger"),
    });
    periods = await FullBackupLedgerBusinessPeriodSource.create({
      index,
      attemptRoot: join(root, "periods"),
    });
    const evidence = await FullBackupManifestEvidence.collect({spoolDirectory,spool,index,ledger,periods});
    const manifestContext = createFullBackupManifestContext({evidence,fileGroupId:"pg-final-manifest-group",generatedAt:new Date().toISOString(),applicationVersion:"0.1.0",generatorVersion:"test-1"});
    const raw = await new FullBackupWorkbookExporter({
        spoolDirectory,
        spool,
        outputRoot: join(root, "raw"), manifestContext,
      }).export(),
      attachments = await new FullBackupAttachmentExporter({
        spoolDirectory,
        spool,
        outputRoot: join(root, "attachments"),
        readVerified: (expected) => f.store.readVerified(expected),
      }).export();
    assert.equal(attachments.readyCount, "2");
    assert.equal(attachments.unreadyCount, "0");
    const attachmentRows = (
      await readFile(
        join(root, "attachments", attachments.outputId, attachments.indexFile),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      attachmentRows.map((row) => row.id).sort(),
      [...refund.evidence].sort(),
    );
    for (const row of attachmentRows) {
      assert.equal(row.status, "READY");
      const bytes = await readFile(
        join(root, "attachments", attachments.outputId, row.backup_file),
      );
      assert.equal(hash(bytes), row.sha256);
      assert.deepEqual(
        bytes,
        await f.store.readVerified({
          versionId: row.id,
          mediaType: row.detected_media_type,
          sizeBytes: Number(row.actual_size_bytes),
          sha256: row.sha256,
        }),
      );
    }

    const facts = {};
    for (const [key, profile] of profiles) {
      const outputRoot = join(root, `fact-${key}`),
        result = await new FullBackupBusinessFactsWorkbookExporter({
          spoolDirectory,
          spool,
          outputRoot,
          profile, manifestContext,
        }).export();
      facts[key] = { directory: join(outputRoot, result.outputId), result };
    }
    const incomeResult = await new FullBackupIncomeWorkbook({
        index,
        view: income,
        outputRoot: join(root, "income-book"), manifestContext,
      }).export(),
      ledgerResult = await new FullBackupLedgerWorkbook({
        index,
        ledger,
        periods,
        outputRoot: join(root, "ledger-book"), manifestContext,
      }).export();
    const incomeBook = await xlsxSheets(
      join(root, "income-book", incomeResult.outputId, incomeResult.file),
    );
    const trace = incomeBook["02_来源明细"];
    const traceHeader = trace[0];
    assert.equal(
      trace
        .slice(1)
        .some(
          (row) =>
            row[traceHeader.indexOf("方向")] === "退款冲回" &&
            row[traceHeader.indexOf("金额（分）")].startsWith("-") &&
            row[traceHeader.indexOf("退款单据ID")] === refund.id,
        ),
      true,
    );
    const ledgerBook = await xlsxSheets(
      join(root, "ledger-book", ledgerResult.outputId, ledgerResult.file),
    );
    const ledgerEntries = ledgerBook["01_原始分录"];
    const ledgerHeader = ledgerEntries[0];
    assert.equal(
      ledgerEntries
        .slice(1)
        .some(
          (row) =>
            row[ledgerHeader.indexOf("事件类型")] === "WEEKLY_FEE_REFUND",
        ),
      true,
    );

    const options = {
      spoolDirectory,
      spool,
      workbookDirectory: join(root, "raw", raw.outputId),
      workbooks: raw,
      attachmentDirectory: join(root, "attachments", attachments.outputId),
      attachments,
      outputRoot: join(root, "packages"),
      businessFacts: facts,
      businessDerived: {
        income: {
          directory: join(root, "income-book", incomeResult.outputId),
          result: incomeResult,
        },
        ledger: {
          directory: join(root, "ledger-book", ledgerResult.outputId),
          result: ledgerResult,
        },
      },
      derivedVerificationViews: { income, ledger, periods },
      finalManifest: { context: manifestContext, index },
    };
    const packaged = await new FullBackupLocalPackageAssembler(options).assemble();
    assert.equal(packaged.complete, false);
    assert.equal(packaged.readyAttachmentCount, "2");
    assert.deepEqual(
      packaged.businessDerived.map((x) => x.tableNumber),
      [3, 7],
    );
    const dir = join(root, "packages", packaged.outputId);
    const packageIndex = JSON.parse(
      await readFile(join(dir, packaged.indexFile), "utf8"),
    );
    const packageAttachments = packageIndex.files.filter((row) =>
      row.path.startsWith("attachments/"),
    );
    assert.equal(packageAttachments.length, 2);
    for (const row of [...packaged.businessDerived, ...packageAttachments]) {
      const bytes = await readFile(join(dir, row.file?.path ?? row.path));
      assert.equal(hash(bytes), row.file?.sha256 ?? row.sha256);
      assert.equal(String(bytes.length), row.file?.sizeBytes ?? row.sizeBytes);
    }
    assert.equal(
      packaged.businessDerived.find((x) => x.tableNumber === 3).rowCounts
        .contribution !== "0",
      true,
    );
    const manifestBytes = await readFile(join(dir, "package-manifest.json"));
    const manifest = JSON.parse(manifestBytes);
    assert.deepEqual(packaged.packageManifest, {path:"package-manifest.json",sizeBytes:String(manifestBytes.length),sha256:hash(manifestBytes)});
    assert.equal(manifest.complete,false);
    assert.equal(manifest.businessCorrectness,"NOT_ASSERTED");
    assert.deepEqual(manifest.context,manifestContext);
    assert.equal(manifest.workbookCount,"20");
    assert.equal(manifest.files.length,Number(manifest.payloadFileCount));
    assert.equal(manifest.files.some(x=>x.path==="package-manifest.json"),false);
    assert.equal(new Set(manifest.files.map(x=>x.path)).size,manifest.files.length);
    assert.ok(manifest.files.some(x=>x.path==="raw-source-package-index.json"));
    let bytesTotal=0n,bookCount=0;
    for(const row of manifest.files){
      const bytes=await readFile(join(dir,row.path));
      assert.equal(hash(bytes),row.sha256);assert.equal(String(bytes.length),row.sizeBytes);
      bytesTotal+=BigInt(row.sizeBytes);
      if(row.path.endsWith('.xlsx')){
        bookCount++;
        const sheets=await xlsxSheets(join(dir,row.path));
        assert.equal(Object.keys(sheets)[0],"00_manifest");
        const values=sheets["00_manifest"].flat();
        assert.ok(values.includes(manifestContext.fileGroupId));
        assert.ok(values.includes(manifestContext.snapshotId));
        assert.ok(values.includes("INCOMPLETE_IMPLEMENTATION"));
      }
    }
    assert.equal(bookCount,20);assert.equal(bytesTotal.toString(),manifest.payloadBytes);
    assert.equal(packaged.payloadFileCount,manifest.payloadFileCount);
    assert.equal(packaged.totalBytes,manifest.payloadBytes);
    const before=(await readdir(options.outputRoot)).sort();
    await assert.rejects(()=>new FullBackupLocalPackageAssembler({...options,finalManifest:{...options.finalManifest,context:{...manifestContext,snapshotId:"forged"}}}).assemble(),/EXPORT_PACKAGE_MANIFEST_CONTEXT_MISMATCH/);
    await assert.rejects(()=>new FullBackupLocalPackageAssembler({...options,businessFacts:undefined,businessDerived:undefined}).assemble(),/EXPORT_PACKAGE_MANIFEST_REQUIRES_ALL_WORKBOOKS/);
    // A valid legacy XLSX with a freshly correct byte hash must still be rejected: no manifest.
    const legacy=await new FullBackupWorkbookExporter({spoolDirectory,spool,outputRoot:join(root,"legacy-raw")}).export();
    await assert.rejects(()=>new FullBackupLocalPackageAssembler({...options,workbooks:legacy,workbookDirectory:join(root,"legacy-raw",legacy.outputId)}).assemble(),/XLSX_MANIFEST_WORKBOOK_INVALID/);
    // Each producer receipt is genuine but the workbook belongs to another file group.
    const otherContext=createFullBackupManifestContext({evidence,fileGroupId:"different-group",generatedAt:manifestContext.generatedAt,applicationVersion:"0.1.0",generatorVersion:"test-1"});
    const otherRaw=await new FullBackupWorkbookExporter({spoolDirectory,spool,outputRoot:join(root,"other-raw"),manifestContext:otherContext}).export();
    await assert.rejects(()=>new FullBackupLocalPackageAssembler({...options,workbooks:otherRaw,workbookDirectory:join(root,"other-raw",otherRaw.outputId)}).assemble(),/XLSX_MANIFEST_PREFIX_MISMATCH/);
    assert.deepEqual((await readdir(options.outputRoot)).sort(),before);
    assert.equal(hash(await readFile(join(dir,"package-manifest.json"))),packaged.packageManifest.sha256);
    // Callers retain ownership of all read views after both success and rejected attempts.
    assert.equal((await FullBackupManifestEvidence.collect({spoolDirectory,spool,index,ledger,periods})).snapshotId,spool.snapshotId);
  } finally {
    await periods?.close().catch(() => undefined);
    await ledger?.close().catch(() => undefined);
    await income?.close().catch(() => undefined);
    await index?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await f.close();
  }
});
