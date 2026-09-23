import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FullBackupAttachmentExporter } from "../dist/full-backup-attachment-exporter.js";
import { FullBackupBusinessFactsWorkbookExporter } from "../dist/full-backup-business-facts-workbook-exporter.js";
import { FullBackupLocalPackageAssembler } from "../dist/full-backup-local-package-assembler.js";
import { FULL_BACKUP_KNOWN_COVERAGE_GAPS, createFullBackupLayout } from "../dist/full-backup-layout.js";
import { FullBackupWorkbookExporter } from "../dist/full-backup-workbook-exporter.js";
import { fullBackupOutputColumns } from "../dist/full-backup-transformer.js";

const layout = createFullBackupLayout();
const sha = (value) => createHash("sha256").update(value).digest("hex");
const profiles = [
  ["teacher", "TEACHER"], ["student", "STUDENT"], ["finance", "FINANCE"],
  ["payroll", "PAYROLL"], ["deduction", "DEDUCTION"], ["performanceConfiguration", "PERFORMANCE_CONFIGURATION"],
];

async function createSpool(root) {
  const spoolId = `business-package-${randomUUID()}`;
  const directory = join(root, spoolId);
  await mkdir(join(directory, "datasets"), { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700); await chmod(join(directory, "datasets"), 0o700);
  const datasets = [];
  for (const [index, item] of layout.entries()) {
    const excluded = item.policy === "AUTH_SECRET_TABLE_EXCLUDED";
    if (excluded) {
      datasets.push({ tableName: item.tableName, columns: [], rowCount: null, logicalDigest: null, spoolFile: null, excluded: true });
      continue;
    }
    const columns = fullBackupOutputColumns(item.tableName);
    const content = `${JSON.stringify({ columns })}\n`;
    const spoolFile = `datasets/${String(index + 1).padStart(3, "0")}_${item.tableName}.ndjson`;
    await writeFile(join(directory, spoolFile), content, { mode: 0o600 });
    datasets.push({ tableName: item.tableName, columns, rowCount: "0", logicalDigest: sha(content), spoolFile, excluded: false });
  }
  await writeFile(join(directory, "anomalies.ndjson"), "", { mode: 0o600 });
  return {
    directory,
    spool: {
      mode: "RAW_SOURCE_SPOOL", spoolId, snapshotId: `snapshot-${randomUUID()}`, asOf: "2026-09-23T00:00:00.000Z",
      datasets, anomalyFile: "anomalies.ndjson", anomalyCount: "0", coverageGaps: [...FULL_BACKUP_KNOWN_COVERAGE_GAPS],
    },
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "alliance-business-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { directory: spoolDirectory, spool } = await createSpool(join(root, "spools"));
  const workbooks = await new FullBackupWorkbookExporter({ spoolDirectory, spool, outputRoot: join(root, "raw-workbooks") }).export();
  const attachments = await new FullBackupAttachmentExporter({
    spoolDirectory, spool, outputRoot: join(root, "attachments"),
    readVerified: async () => { throw new Error("no READY attachment in fixture"); },
  }).export();
  const bundle = {};
  for (const [key, profile] of profiles) {
    const outputRoot = join(root, `fact-${key}`);
    const result = await new FullBackupBusinessFactsWorkbookExporter({ spoolDirectory, spool, outputRoot, profile }).export();
    bundle[key] = { directory: join(outputRoot, result.outputId), result };
  }
  const outputRoot = join(root, "packages");
  const options = {
    spoolDirectory, spool,
    workbookDirectory: join(root, "raw-workbooks", workbooks.outputId), workbooks,
    attachmentDirectory: join(root, "attachments", attachments.outputId), attachments,
    outputRoot,
  };
  return {
    root, outputRoot, bundle, options,
    assemble: (businessFacts) => new FullBackupLocalPackageAssembler({ ...options, ...(businessFacts === undefined ? {} : { businessFacts }) }).assemble(),
  };
}

async function previous(outputRoot) {
  await mkdir(join(outputRoot, "previous-success"), { recursive: true, mode: 0o700 });
  await writeFile(join(outputRoot, "previous-success", "keep.txt"), "keep", { mode: 0o600 });
}
const assertOnlyPrevious = async (outputRoot) => assert.deepEqual((await readdir(outputRoot)).sort(), ["previous-success"]);

test("fixed six business facts are copied from one spool with reconstructed safe metadata while raw-only remains unchanged", async (t) => {
  const f = await fixture(t);
  const raw = await f.assemble();
  assert.equal(raw.complete, false);
  assert.equal(raw.businessFacts, undefined);
  assert.deepEqual(raw.incompleteReasons, ["BUSINESS_VIEWS_NOT_IMPLEMENTED", "00_MANIFEST_NOT_IMPLEMENTED", "FINAL_PACKAGE_MANIFEST_NOT_IMPLEMENTED"]);
  const rawIndex = JSON.parse(await readFile(join(f.outputRoot, raw.outputId, raw.indexFile), "utf8"));
  assert.equal(Object.hasOwn(rawIndex, "businessFacts"), false);

  const producerOnlyMetadata = "/untrusted/producer-secret-metadata";
  const guardedBundle = {
    ...f.bundle,
    finance: { ...f.bundle.finance, result: { ...f.bundle.finance.result, outputId: producerOnlyMetadata, gaps: [producerOnlyMetadata] } },
  };
  const packaged = await f.assemble(guardedBundle);
  assert.equal(packaged.mode, "RAW_SOURCE_PACKAGE"); assert.equal(packaged.complete, false);
  assert.deepEqual(packaged.businessFacts.map((item) => item.tableNumber), [1, 2, 4, 5, 6, 8]);
  assert.equal(packaged.incompleteReasons.includes("BUSINESS_TABLES_3_AND_7_DERIVED_PENDING"), true);
  const indexBytes = await readFile(join(f.outputRoot, packaged.outputId, packaged.indexFile));
  const index = JSON.parse(indexBytes);
  assert.equal(index.complete, false);
  assert.deepEqual(index.businessFacts.map((item) => item.tableNumber), [1, 2, 4, 5, 6, 8]);
  assert.equal(index.businessFacts.find((item) => item.tableNumber === 6).gaps.includes("PROJECT_DEDUCTION_1_TO_10_NOT_IMPLEMENTED"), true);
  assert.equal(index.businessFacts.find((item) => item.tableNumber === 8).gaps.includes("PER_TEACHER_RATE_OVERRIDE_NOT_IMPLEMENTED"), true);
  assert.equal(index.businessFacts.find((item) => item.tableNumber === 8).gaps.includes("CLASS_TYPE_RATE_CONFIG_NOT_IMPLEMENTED"), true);
  assert.equal(index.businessFacts.every((item) => item.sources.every((source) => Object.keys(source).sort().join(",") === "columns,logicalDigest,rowCount,sourceTable")), true);
  assert.equal(index.businessFacts.every((item) => item.file.path.startsWith("business-facts/") && /^[a-f0-9]{64}$/.test(item.file.sha256)), true);
  assert.equal(index.files.filter((item) => item.path.startsWith("business-facts/")).length, 6);
  assert.equal(index.files.length, 20);
  assert.equal(indexBytes.includes(Buffer.from(f.root)), false);
  assert.equal(indexBytes.includes(Buffer.from(producerOnlyMetadata)), false);
  assert.equal(/password|session|secret/i.test(JSON.stringify(index.businessFacts)), false);
});

test("forged fact receipt, cross-snapshot input, and changed fact bytes reject without replacing an old package", async (t) => {
  await t.test("source receipt", async (t) => {
    const f = await fixture(t); await previous(f.outputRoot);
    const forged = { ...f.bundle, teacher: { ...f.bundle.teacher, result: { ...f.bundle.teacher.result, sourceRows: f.bundle.teacher.result.sourceRows.map((row, index) => index === 0 ? { ...row, rowCount: "1" } : row) } } };
    await assert.rejects(() => f.assemble(forged), /EXPORT_PACKAGE_BUSINESS_FACT_SOURCE_MISMATCH/);
    await assertOnlyPrevious(f.outputRoot);
  });
  await t.test("cross snapshot", async (t) => {
    const f = await fixture(t); await previous(f.outputRoot);
    const forged = { ...f.bundle, student: { ...f.bundle.student, result: { ...f.bundle.student.result, snapshotId: "other-snapshot" } } };
    await assert.rejects(() => f.assemble(forged), /EXPORT_PACKAGE_BUSINESS_FACTS_INVALID/);
    await assertOnlyPrevious(f.outputRoot);
  });
  await t.test("same-size content change", async (t) => {
    const f = await fixture(t); await previous(f.outputRoot);
    const path = join(f.bundle.payroll.directory, f.bundle.payroll.result.file);
    const bytes = await readFile(path); bytes[bytes.length - 1] ^= 1;
    await writeFile(path, bytes, { mode: 0o600 });
    await assert.rejects(() => f.assemble(f.bundle), /BACKUP_FILE_INVALID/);
    await assertOnlyPrevious(f.outputRoot);
  });
});

test("missing or extra business-fact producer files fail as one new attempt and preserve an old package", async (t) => {
  for (const mutation of ["missing", "extra"]) await t.test(mutation, async (t) => {
    const f = await fixture(t); await previous(f.outputRoot);
    const directory = f.bundle.deduction.directory;
    if (mutation === "missing") await rm(join(directory, f.bundle.deduction.result.file));
    else await writeFile(join(directory, "unexpected.xlsx"), "extra", { mode: 0o600 });
    await assert.rejects(() => f.assemble(f.bundle), /EXPORT_PACKAGE_BUSINESS_FACT_FILE_INVALID|EXPORT_PACKAGE_EXTRA_FILE/);
    await assertOnlyPrevious(f.outputRoot);
  });
});
