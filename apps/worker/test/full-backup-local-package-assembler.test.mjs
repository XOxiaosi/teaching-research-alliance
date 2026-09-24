import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FullBackupAttachmentExporter } from "../dist/full-backup-attachment-exporter.js";
import { FullBackupLocalPackageAssembler } from "../dist/full-backup-local-package-assembler.js";
import { FULL_BACKUP_KNOWN_COVERAGE_GAPS, createFullBackupLayout } from "../dist/full-backup-layout.js";
import { FullBackupWorkbookExporter } from "../dist/full-backup-workbook-exporter.js";
import { fullBackupOutputColumns } from "../dist/full-backup-transformer.js";

const layout = createFullBackupLayout();
const attachmentTable = "finance_attachment_version";
const attachmentColumns = fullBackupOutputColumns(attachmentTable);
const coverageGaps = [...FULL_BACKUP_KNOWN_COVERAGE_GAPS];
const pdf = Buffer.from("%PDF-1.7\nassembler fixture\n%%EOF");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

const readyRow = (id) => Object.fromEntries(attachmentColumns.map((column) => [column, ({
  id, finance_attachment_id: randomUUID(), version_no: "1", status: "READY",
  original_filename: "fixture.pdf", declared_media_type: "application/pdf",
  declared_size_bytes: String(pdf.length), expected_sha256: sha(pdf),
  detected_media_type: "application/pdf", actual_size_bytes: String(pdf.length), sha256: sha(pdf),
  failure_code: null, uploaded_by_person_id: randomUUID(),
  created_at: "2026-09-23T00:00:00.000Z", ready_at: "2026-09-23T00:00:00.000Z",
})[column] ?? null]));

const uploadingRow = (id) => Object.fromEntries(attachmentColumns.map((column) => [column, ({
  id, finance_attachment_id: randomUUID(), version_no: "1", status: "UPLOADING",
  original_filename: "pending.pdf", declared_media_type: "application/pdf", declared_size_bytes: "1",
  expected_sha256: "a".repeat(64), uploaded_by_person_id: randomUUID(),
  created_at: "2026-09-23T00:00:00.000Z",
})[column] ?? null]));

async function createSpool(root, rows, anomalies = []) {
  const spoolId = `spool-${randomUUID()}`;
  const directory = join(root, spoolId);
  await mkdir(join(directory, "datasets"), { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await chmod(join(directory, "datasets"), 0o700);
  const datasets = [];
  for (const [index, item] of layout.entries()) {
    if (item.policy === "AUTH_SECRET_TABLE_EXCLUDED") {
      datasets.push({ tableName: item.tableName, columns: [], rowCount: null, logicalDigest: null, spoolFile: null, excluded: true });
      continue;
    }
    const columns = fullBackupOutputColumns(item.tableName);
    const records = item.tableName === attachmentTable ? rows : [];
    const content = `${JSON.stringify({ columns })}\n${records.map((row) => `${JSON.stringify(columns.map((column) => row[column]))}\n`).join("")}`;
    const spoolFile = `datasets/${String(index + 1).padStart(3, "0")}_${item.tableName}.ndjson`;
    await writeFile(join(directory, spoolFile), content, { mode: 0o600, flag: "wx" });
    await chmod(join(directory, spoolFile), 0o600);
    datasets.push({ tableName: item.tableName, columns, rowCount: String(records.length), logicalDigest: sha(content), spoolFile, excluded: false });
  }
  const anomalyText = anomalies.map((value) => `${JSON.stringify(value)}\n`).join("");
  await writeFile(join(directory, "anomalies.ndjson"), anomalyText, { mode: 0o600, flag: "wx" });
  return {
    directory,
    spool: {
      mode: "RAW_SOURCE_SPOOL", spoolId, snapshotId: "assembler-snapshot", asOf: "2026-09-23T00:00:00.000Z",
      datasets, anomalyFile: "anomalies.ndjson", anomalyCount: String(anomalies.length), coverageGaps,
    },
  };
}

async function fixture(t, { anomalies = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "alliance-package-assembler-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const readyId = randomUUID();
  const rows = [readyRow(readyId), uploadingRow(randomUUID())].sort((left, right) => left.id.localeCompare(right.id));
  const { directory: spoolDirectory, spool } = await createSpool(join(root, "spools"), rows, anomalies);
  const workbooks = await new FullBackupWorkbookExporter({ spoolDirectory, spool, outputRoot: join(root, "workbooks") }).export();
  const attachments = await new FullBackupAttachmentExporter({
    spoolDirectory, spool, outputRoot: join(root, "attachment-components"),
    readVerified: async (expected) => {
      assert.equal(expected.versionId, readyId);
      assert.equal(expected.mediaType, "application/pdf");
      return pdf;
    },
  }).export();
  const outputRoot = join(root, "packages");
  const options = {
    spoolDirectory, spool,
    workbookDirectory: join(root, "workbooks", workbooks.outputId), workbooks,
    attachmentDirectory: join(root, "attachment-components", attachments.outputId), attachments,
    outputRoot,
  };
  return { root, readyId, spoolDirectory, spool, attachments, outputRoot, options, assemble: () => new FullBackupLocalPackageAssembler(options).assemble() };
}

async function addPrevious(outputRoot) {
  await mkdir(join(outputRoot, "previous-success"), { recursive: true, mode: 0o700 });
  await writeFile(join(outputRoot, "previous-success", "keep.txt"), "old package", { mode: 0o600 });
}
const assertOnlyPrevious = async (outputRoot) => assert.deepEqual((await readdir(outputRoot)).sort(), ["previous-success"]);

test("在触碰任何目录前拒绝跨快照组件", async () => {
  const spool = { mode: "RAW_SOURCE_SPOOL", spoolId: "spool-a", snapshotId: "snapshot-a", asOf: "2026-09-23T00:00:00.000Z", datasets: [], anomalyFile: "anomalies.ndjson", anomalyCount: "0", coverageGaps };
  const workbooks = { mode: "RAW_SOURCE_WORKBOOKS", outputId: "workbooks-a", spoolId: "spool-a", snapshotId: "snapshot-b", asOf: spool.asOf, workbooks: [], coverageGaps };
  const attachments = { mode: "ATTACHMENT_FILES", outputId: "attachments-a", snapshotId: spool.snapshotId, asOf: spool.asOf, indexFile: "attachment-index.ndjson", indexSha256: "0".repeat(64), readyCount: "0", unreadyCount: "0", totalBytes: "0" };
  await assert.rejects(() => new FullBackupLocalPackageAssembler({ spoolDirectory: "/does-not-exist/spool", spool, workbookDirectory: "/does-not-exist/workbooks", workbooks, attachmentDirectory: "/does-not-exist/attachments", attachments, outputRoot: "/does-not-exist/output" }).assemble(), /EXPORT_PACKAGE_SNAPSHOT_MISMATCH/);
});

test("拒绝截断或错序的固定101表 spool 清单，且不触碰目录", async () => {
  const datasets = layout.map((item, index) => {
    const excluded = item.policy === "AUTH_SECRET_TABLE_EXCLUDED";
    return { tableName: item.tableName, excluded, columns: excluded ? [] : fullBackupOutputColumns(item.tableName), rowCount: excluded ? null : "0", logicalDigest: excluded ? null : "0".repeat(64), spoolFile: excluded ? null : `datasets/${String(index + 1).padStart(3, "0")}_${item.tableName}.ndjson` };
  });
  const counts = new Map();
  for (const item of layout) if (item.policy === "RAW_SOURCE") counts.set(item.workbookId, (counts.get(item.workbookId) ?? 0) + 1);
  const ids = ["01", "02", "03", "04", "06", "07", "08", "09", "10", "11", "12", "13"];
  const spool = { mode: "RAW_SOURCE_SPOOL", spoolId: "spool-a", snapshotId: "snapshot-a", asOf: "2026-09-23T00:00:00.000Z", datasets: [...datasets.slice(0, -1), datasets[1], datasets[0]], anomalyFile: "anomalies.ndjson", anomalyCount: "0", coverageGaps };
  const workbooks = { mode: "RAW_SOURCE_WORKBOOKS", outputId: "workbooks-a", spoolId: "spool-a", snapshotId: "snapshot-a", asOf: spool.asOf, coverageGaps, workbooks: ids.map((workbookId) => ({ workbookId, file: `workbook-${workbookId}.xlsx`, datasetCount: String(counts.get(workbookId)) })) };
  const attachments = { mode: "ATTACHMENT_FILES", outputId: "attachments-a", snapshotId: spool.snapshotId, asOf: spool.asOf, indexFile: "attachment-index.ndjson", indexSha256: "0".repeat(64), readyCount: "0", unreadyCount: "0", totalBytes: "0" };
  await assert.rejects(() => new FullBackupLocalPackageAssembler({ spoolDirectory: "/does-not-exist/spool", spool, workbookDirectory: "/does-not-exist/workbooks", workbooks, attachmentDirectory: "/does-not-exist/attachments", attachments, outputRoot: "/does-not-exist/output" }).assemble(), /EXPORT_PACKAGE_SPOOL_LAYOUT_INVALID/);
});

test("篡改或删掉 READY 原件会拒绝本次包，并保留旧包", async (t) => {
  for (const mutation of ["tamper", "missing"]) await t.test(mutation, async (t) => {
    const f = await fixture(t);
    await mkdir(f.outputRoot, { recursive: true, mode: 0o700 });
    await addPrevious(f.outputRoot);
    const file = join(f.options.attachmentDirectory, "attachments", `${f.readyId}.pdf`);
    if (mutation === "tamper") await writeFile(file, Buffer.from("%PDF-1.7\naltered\n%%EOF"), { mode: 0o600 });
    else await unlink(file);
    await assert.rejects(f.assemble, /BACKUP_FILE_INVALID|ENOENT/);
    await assertOnlyPrevious(f.outputRoot);
  });
});

test("附件 index 删尾并重算自身哈希仍因与 spool 锁步失败", async (t) => {
  const f = await fixture(t);
  await mkdir(f.outputRoot, { recursive: true, mode: 0o700 });
  await addPrevious(f.outputRoot);
  const indexPath = join(f.options.attachmentDirectory, f.attachments.indexFile);
  const [first] = (await readFile(indexPath, "utf8")).trim().split("\n");
  const shortened = `${first}\n`;
  await writeFile(indexPath, shortened, { mode: 0o600 });
  f.attachments.indexSha256 = sha(shortened);
  await assert.rejects(f.assemble, /EXPORT_PACKAGE_ATTACHMENT_LOCKSTEP/);
  await assertOnlyPrevious(f.outputRoot);
});

test("workbook producer 摘要绑定落盘字节，篡改或删除 XLSX 会拒绝本次包", async (t) => {
  await t.test("producer 摘要", async (t) => {
    const f = await fixture(t);
    for (const workbook of f.options.workbooks.workbooks) {
      const bytes = await readFile(join(f.options.workbookDirectory, workbook.file));
      assert.equal(workbook.sizeBytes, String(bytes.length));
      assert.equal(workbook.sha256, sha(bytes));
    }
  });
  for (const mutation of ["same-size-tamper", "missing"]) await t.test(mutation, async (t) => {
    const f = await fixture(t);
    await mkdir(f.outputRoot, { recursive: true, mode: 0o700 });
    await addPrevious(f.outputRoot);
    const file = join(f.options.workbookDirectory, "workbook-01.xlsx");
    if (mutation === "same-size-tamper") {
      const bytes = await readFile(file);
      bytes[bytes.length - 1] ^= 1;
      await writeFile(file, bytes, { mode: 0o600 });
    } else await unlink(file);
    await assert.rejects(f.assemble, /BACKUP_FILE_INVALID|ENOENT|EXPORT_PACKAGE_EXTRA_FILE/);
    await assertOnlyPrevious(f.outputRoot);
  });
});

test("拒绝附件源目录的额外文件和链接，并不删除旧包", async (t) => {
  const f = await fixture(t);
  await mkdir(f.outputRoot, { recursive: true, mode: 0o700 });
  await addPrevious(f.outputRoot);
  const directory = join(f.options.attachmentDirectory, "attachments");
  const rogue = join(directory, "rogue.pdf");
  await writeFile(rogue, pdf, { mode: 0o600 });
  await assert.rejects(f.assemble, /EXPORT_PACKAGE_EXTRA_FILE/);
  await assertOnlyPrevious(f.outputRoot);
  await unlink(rogue);
  await symlink(join(directory, `${f.readyId}.pdf`), join(directory, "alias.pdf"));
  await assert.rejects(f.assemble, /EXPORT_PACKAGE_EXTRA_FILE/);
  await assertOnlyPrevious(f.outputRoot);
});

test("非法异常记录和异常计数不一致都会清理当次包", async (t) => {
  await t.test("非法记录", async (t) => {
    const f = await fixture(t, { anomalies: [{ code: "INVALID" }] });
    await mkdir(f.outputRoot, { recursive: true, mode: 0o700 });
    await addPrevious(f.outputRoot);
    await assert.rejects(f.assemble, /EXPORT_PACKAGE_ANOMALY_INVALID/);
    await assertOnlyPrevious(f.outputRoot);
  });
  await t.test("数量不一致", async (t) => {
    const valid = { code: "TRANSFORM_VALUE_ANOMALY", tableName: "person", columnName: "nickname", rowNumber: "1" };
    const f = await fixture(t, { anomalies: [valid] });
    await mkdir(f.outputRoot, { recursive: true, mode: 0o700 });
    await addPrevious(f.outputRoot);
    f.spool.anomalyCount = "0";
    await assert.rejects(f.assemble, /EXPORT_PACKAGE_ANOMALY_COUNT/);
    await assertOnlyPrevious(f.outputRoot);
  });
});

test("rename 后父目录同步失败只清当前包并保留旧包", async (t) => {
  const f = await fixture(t);
  await mkdir(f.outputRoot, { recursive: true, mode: 0o700 });
  await addPrevious(f.outputRoot);
  const probePath = join(f.root, "prototype-probe");
  const probe = await open(probePath, "wx", 0o600);
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  await unlink(probePath);
  const originalSync = prototype.sync;
  let calls = 0;
  prototype.sync = async function (...args) {
    calls += 1;
    if (calls === 22) throw new Error("TEST_PARENT_DIRECTORY_SYNC_FAILED");
    return originalSync.apply(this, args);
  };
  try {
    await assert.rejects(f.assemble, /TEST_PARENT_DIRECTORY_SYNC_FAILED/);
    assert.equal(calls, 22);
    await assertOnlyPrevious(f.outputRoot);
  } finally {
    prototype.sync = originalSync;
  }
});
