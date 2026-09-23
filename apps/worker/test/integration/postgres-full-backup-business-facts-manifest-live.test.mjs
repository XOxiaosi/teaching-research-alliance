import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fixture } from "../../../api/test/integration/refund-review-fixture.mjs";
import { FullBackupDeductionWorkbookExporter } from "../../dist/full-backup-deduction-workbook-exporter.js";
import { FullBackupDerivedSpoolIndex } from "../../dist/full-backup-derived-spool-index.js";
import { FullBackupFinanceWorkbookExporter } from "../../dist/full-backup-finance-workbook-exporter.js";
import { FullBackupLedgerBusinessPeriodSource } from "../../dist/full-backup-ledger-business-period-source.js";
import { FullBackupLedgerDerivedView } from "../../dist/full-backup-ledger-derived-view.js";
import { FullBackupManifestEvidence } from "../../dist/full-backup-manifest-evidence.js";
import { createFullBackupManifestContext } from "../../dist/full-backup-manifest.js";
import { FullBackupPayrollWorkbookExporter } from "../../dist/full-backup-payroll-workbook-exporter.js";
import { FullBackupPerformanceConfigurationWorkbookExporter } from "../../dist/full-backup-performance-configuration-workbook-exporter.js";
import { FullBackupSpool } from "../../dist/full-backup-spool.js";
import { FullBackupStudentWorkbookExporter } from "../../dist/full-backup-student-workbook-exporter.js";
import { FullBackupTeacherWorkbookExporter } from "../../dist/full-backup-teacher-workbook-exporter.js";
import { FullBackupTransformer } from "../../dist/full-backup-transformer.js";
import { PostgresFullBackupSource } from "../../dist/postgres-full-backup-source.js";

const run = promisify(execFile);
const sha = (value) => createHash("sha256").update(value).digest("hex");

const profiles = [
  [1, "teacher", FullBackupTeacherWorkbookExporter],
  [2, "student", FullBackupStudentWorkbookExporter],
  [4, "finance", FullBackupFinanceWorkbookExporter],
  [5, "payroll", FullBackupPayrollWorkbookExporter],
  [6, "deduction", FullBackupDeductionWorkbookExporter],
  [8, "performance-configuration", FullBackupPerformanceConfigurationWorkbookExporter],
];

const readWorkbook = async (file) => {
  const { stdout } = await run("python3", ["-c", `import json,sys,zipfile,xml.etree.ElementTree as E
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
n={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
book=E.fromstring(z.read('xl/workbook.xml')); rels=E.fromstring(z.read('xl/_rels/workbook.xml.rels')); targets={x.attrib['Id']:x.attrib['Target'] for x in rels}; out={}
for sheet in book.findall('.//m:sheet',n):
 rid=sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']; xml=E.fromstring(z.read('xl/'+targets[rid])); rows=[]
 for row in xml.findall('.//m:row',n):
  values=[]
  for cell in row.findall('m:c',n):
   text=cell.find('.//m:t',n); values.append('' if text is None or text.text is None else text.text)
  rows.append(values)
 out[sheet.attrib['name']]=rows
print(json.dumps(out,ensure_ascii=False))`, file]);
  return JSON.parse(stdout);
};

const fields = (rows) => new Map(rows.slice(1));
const isSourceSheet = (name) => !["00_manifest", "00_说明"].includes(name) && !/^(14_|15_)/u.test(name);

const addDeductionPlan = async (f) => {
  const fundId = randomUUID();
  const planId = randomUUID();
  const at = "2026-09-23T00:00:00.000Z";
  await f.pool.query(
    `INSERT INTO company_finance_fund(
       id,kind,fund_code,display_name,status,version,created_by_person_id,created_at,updated_at
     ) VALUES($1::uuid,'HEADQUARTERS_FINANCE_OPERATING','MANIFEST_FACTS','Manifest 事实资金','ACTIVE',1,$2::uuid,$3::timestamptz,$3::timestamptz)`,
    [fundId, f.ids.admin, at],
  );
  await f.pool.query(
    `INSERT INTO finance_benefit_plan_version(
       id,benefit_kind,beneficiary_person_id,benefit_month,version_no,execution_day,
       amount_cents,source_fund_id,active,changed_by_person_id,changed_at,reason
     ) VALUES($1::uuid,'SOCIAL_INSURANCE',$2::uuid,'2026-09-01',1,5,120,$3::uuid,true,$4::uuid,$5::timestamptz,'manifest 真实福利计划')`,
    [planId, f.ids.teacherA, fundId, f.ids.hq, at],
  );
  return planId;
};

test("real PG refund spool writes six fact workbooks with one verified manifest context", async () => {
  const f = await fixture();
  const root = await mkdtemp(join(tmpdir(), "business-facts-manifest-pg-"));
  let index;
  let ledger;
  let periods;
  try {
    const refund = await f.pending();
    await f.approve(refund, "business-facts-manifest-refund");
    const benefitPlanId = await addDeductionPlan(f);

    const spool = await new FullBackupSpool({
      source: new PostgresFullBackupSource(f.pool),
      transformer: new FullBackupTransformer({
        fingerprint: ({ domain, value }) => sha(`${domain}\0${value}`),
      }),
      tempRoot: join(root, "spool"),
      batchSize: 1,
    }).create();
    const spoolDirectory = join(root, "spool", spool.spoolId);
    index = await FullBackupDerivedSpoolIndex.create({
      spoolDirectory,
      spool,
      attemptRoot: join(root, "index"),
    });
    ledger = await FullBackupLedgerDerivedView.create({
      index,
      attemptRoot: join(root, "ledger"),
    });
    periods = await FullBackupLedgerBusinessPeriodSource.create({
      index,
      attemptRoot: join(root, "periods"),
    });
    const evidence = await FullBackupManifestEvidence.collect({
      spoolDirectory,
      spool,
      index,
      ledger,
      periods,
    });
    const manifestContext = createFullBackupManifestContext({
      evidence,
      fileGroupId: "business-facts-manifest-live",
      generatedAt: new Date().toISOString(),
      applicationVersion: "0.1.0",
      generatorVersion: "worker.integration-test",
    });
    assert.equal(manifestContext.spoolId, spool.spoolId);
    assert.equal(manifestContext.snapshotId, spool.snapshotId);
    assert.ok(BigInt(manifestContext.money.ledgerEntryCount) > 0n);
    assert.ok(BigInt(manifestContext.periods.eventCount) > 0n);

    const exported = [];
    for (const [tableNumber, outputName, Exporter] of profiles) {
      const outputRoot = join(root, `facts-${outputName}`);
      const result = await new Exporter({
        spoolDirectory,
        spool,
        outputRoot,
        manifestContext,
      }).export();
      const file = join(outputRoot, result.outputId, result.file);
      const bytes = await readFile(file);
      assert.equal(sha(bytes), result.sha256);
      assert.equal(String(bytes.length), result.sizeBytes);
      exported.push({ tableNumber, result, file });
    }

    for (const { tableNumber, result, file } of exported) {
      const workbook = await readWorkbook(file);
      assert.equal(Object.keys(workbook)[0], "00_manifest");
      assert.ok(Object.hasOwn(workbook, "00_说明"));
      assert.equal(Object.entries(workbook).some(([name, rows]) => isSourceSheet(name) && rows.length > 1), true);

      const manifest = fields(workbook["00_manifest"]);
      assert.equal(manifest.get("complete"), "false");
      assert.equal(manifest.get("workbook_role"), "BUSINESS_FACT");
      assert.equal(manifest.get("covered_table_numbers"), String(tableNumber));
      assert.equal(manifest.get("spool_id"), spool.spoolId);
      assert.equal(manifest.get("snapshot_id"), spool.snapshotId);
      assert.equal(manifest.get("as_of"), spool.asOf);
      assert.equal(manifest.get("file_group_id"), manifestContext.fileGroupId);
      assert.equal(manifest.get("workbook_file"), result.file);
      assert.equal(manifest.get("backup_status"), "INCOMPLETE_IMPLEMENTATION");
      assert.equal(manifest.get("business_validation_status"), "NOT_ASSERTED");
      assert.equal(workbook["00_说明"].some((row) => row[0] === "完整备份" && row[1] === "false"), true);

      const sourceParts = workbook["00_manifest"]
        .filter(([field]) => field.startsWith("sheet.") && field.endsWith(".source_table"))
        .map(([, value]) => value);
      assert.deepEqual(sourceParts, result.sourceRows.map((source) => source.sourceTable));
      for (const source of result.sourceRows) {
        assert.equal(manifest.get(`raw.${source.sourceTable}.row_count`), source.rowCount);
        assert.equal(manifest.get(`raw.${source.sourceTable}.logical_digest`), source.logicalDigest);
      }
    }

    const finance = exported.find((item) => item.tableNumber === 4);
    const deduction = exported.find((item) => item.tableNumber === 6);
    assert.ok(finance); assert.ok(deduction);
    assert.equal(JSON.stringify(await readWorkbook(finance.file)).includes(refund.id), true);
    assert.equal(JSON.stringify(await readWorkbook(deduction.file)).includes(benefitPlanId), true);
  } finally {
    await periods?.close().catch(() => undefined);
    await ledger?.close().catch(() => undefined);
    await index?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await f.close();
  }
});
