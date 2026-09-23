import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

test("real PG approved refund with READY originals packages six facts and both derived workbooks", async () => {
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
    const raw = await new FullBackupWorkbookExporter({
        spoolDirectory,
        spool,
        outputRoot: join(root, "raw"),
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
          profile,
        }).export();
      facts[key] = { directory: join(outputRoot, result.outputId), result };
    }
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
    const evidence = await FullBackupManifestEvidence.collect({spoolDirectory, spool, index, ledger, periods});
    const manifestContext = createFullBackupManifestContext({
      evidence, fileGroupId: "derived-package-pg-manifest", generatedAt: new Date().toISOString(),
      applicationVersion: "0.1.0", generatorVersion: "test-1",
    });
    const incomeResult = await new FullBackupIncomeWorkbook({
        index,
        view: income,
        outputRoot: join(root, "income-book"),
        manifestContext,
      }).export(),
      ledgerResult = await new FullBackupLedgerWorkbook({
        index,
        ledger,
        periods,
        outputRoot: join(root, "ledger-book"),
        manifestContext,
      }).export();
    const incomeBook = await xlsxSheets(
      join(root, "income-book", incomeResult.outputId, incomeResult.file),
    );
    assert.equal(Object.keys(incomeBook)[0], "00_manifest");
    assert.ok(incomeBook["00_manifest"].flat().includes(spool.snapshotId));
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
    assert.equal(Object.keys(ledgerBook)[0], "00_manifest");
    assert.ok(ledgerBook["00_manifest"].flat().includes(spool.snapshotId));
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

    const packaged = await new FullBackupLocalPackageAssembler({
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
    }).assemble();
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
  } finally {
    await periods?.close().catch(() => undefined);
    await ledger?.close().catch(() => undefined);
    await income?.close().catch(() => undefined);
    await index?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await f.close();
  }
});
