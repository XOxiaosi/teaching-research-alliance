import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { FullBackupAttachmentExporter } from "../dist/full-backup-attachment-exporter.js";
import { createFullBackupLayout } from "../dist/full-backup-layout.js";
import { fullBackupOutputColumns } from "../dist/full-backup-transformer.js";
import { LocalAttachmentStore } from "../../api/dist/local-attachment-store.js";

const layout = createFullBackupLayout();
const versionTable = "finance_attachment_version";
const versionColumns = fullBackupOutputColumns(versionTable);
const versionIndex = layout.findIndex((item) => item.tableName === versionTable);
const sourceRoot = resolve(import.meta.dirname, "../../..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const privateMode = async (path, mode) => assert.equal((await stat(path)).mode & 0o777, mode);

async function* chunks(bytes) {
  yield bytes.subarray(0, 4);
  yield bytes.subarray(4);
}

async function fileHandlePrototype(root) {
  const probe = join(root, "file-handle-prototype-probe");
  const handle = await open(probe, "wx", 0o600);
  try { return Object.getPrototypeOf(handle); }
  finally { await handle.close(); await rm(probe, { force: true }); }
}

const attachmentRow = (overrides = {}) => {
  const values = Object.fromEntries(versionColumns.map((column) => [column, null]));
  return {
    ...values,
    id: randomUUID(),
    finance_attachment_id: randomUUID(),
    version_no: "1",
    status: "UPLOADING",
    original_filename: "evidence.pdf",
    declared_media_type: "application/pdf",
    declared_size_bytes: "1",
    expected_sha256: "a".repeat(64),
    uploaded_by_person_id: randomUUID(),
    created_at: "2026-09-23T00:00:00.000Z",
    ...overrides,
  };
};

async function createSpool(root, rows, { digestOverride } = {}) {
  const spoolId = `spool-${randomUUID()}`;
  const directory = join(root, spoolId);
  const datasetsDirectory = join(directory, "datasets");
  await mkdir(datasetsDirectory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await chmod(datasetsDirectory, 0o700);
  const datasets = [];
  for (const [index, item] of layout.entries()) {
    if (item.policy === "AUTH_SECRET_TABLE_EXCLUDED") {
      datasets.push({ tableName: item.tableName, columns: [], rowCount: null, logicalDigest: null, spoolFile: null, excluded: true });
      continue;
    }
    const columns = fullBackupOutputColumns(item.tableName);
    const values = item.tableName === versionTable ? rows : [];
    const content = `${JSON.stringify({ columns })}\n${values.map((row) => `${JSON.stringify(columns.map((column) => row[column]))}\n`).join("")}`;
    const spoolFile = `datasets/${String(index + 1).padStart(3, "0")}_${item.tableName}.ndjson`;
    await writeFile(join(directory, spoolFile), content, { mode: 0o600, flag: "wx" });
    await chmod(join(directory, spoolFile), 0o600);
    datasets.push({
      tableName: item.tableName,
      columns,
      rowCount: String(values.length),
      logicalDigest: item.tableName === versionTable && digestOverride !== undefined ? digestOverride : sha(content),
      spoolFile,
      excluded: false,
    });
  }
  await writeFile(join(directory, "anomalies.ndjson"), "", { mode: 0o600, flag: "wx" });
  return {
    directory,
    spool: {
      mode: "RAW_SOURCE_SPOOL",
      spoolId,
      snapshotId: "attachment-snapshot",
      asOf: "2026-09-23T00:00:00.000Z",
      datasets,
      anomalyFile: "anomalies.ndjson",
      anomalyCount: "0",
      coverageGaps: [],
    },
  };
}

async function putPdf(store, versionId, bytes, originalFilename = "source.pdf") {
  const digest = sha(bytes);
  const saved = await store.put({
    versionId,
    originalFilename,
    declaredMediaType: "application/pdf",
    declaredSizeBytes: bytes.length,
    expectedSha256: digest,
  }, chunks(bytes));
  return { ...saved, bytes };
}

const readyRow = (stored, financeAttachmentId, versionNo, originalFilename = "evidence.pdf") => attachmentRow({
  id: stored.versionId,
  finance_attachment_id: financeAttachmentId,
  version_no: String(versionNo),
  status: "READY",
  original_filename: originalFilename,
  declared_media_type: stored.mediaType,
  declared_size_bytes: String(stored.sizeBytes),
  expected_sha256: stored.sha256,
  detected_media_type: stored.mediaType,
  actual_size_bytes: String(stored.sizeBytes),
  sha256: stored.sha256,
  ready_at: "2026-09-23T00:00:00.000Z",
});

async function makeStore(root) {
  return LocalAttachmentStore.create(join(root, "object-store"), sourceRoot, 1024 * 1024);
}

test("复制同一附件的两份 READY 历史版本，非 READY 只进入索引", async () => {
  const root = await mkdtemp(join(tmpdir(), "alliance-attachment-export-"));
  try {
    const store = await makeStore(root);
    const attachmentId = randomUUID();
    const first = await putPdf(store, randomUUID(), Buffer.from("%PDF-1.7\nhistorical v1\n%%EOF"));
    const second = await putPdf(store, randomUUID(), Buffer.from("%PDF-1.7\nhistorical v2\n%%EOF"));
    const rows = [
      readyRow(first, attachmentId, 1, "../../malicious-name.pdf"),
      readyRow(second, attachmentId, 2),
      attachmentRow({ status: "UPLOADING", failure_code: null }),
      attachmentRow({ status: "FAILED", failure_code: "VIRUS_SCAN_FAILED" }),
    ];
    const { directory: spoolDirectory, spool } = await createSpool(join(root, "spools"), rows);
    await privateMode(spoolDirectory, 0o700);
    await privateMode(join(spoolDirectory, "datasets"), 0o700);
    const result = await new FullBackupAttachmentExporter({
      spoolDirectory,
      spool,
      outputRoot: join(root, "out"),
      readVerified: (expected) => store.readVerified(expected),
    }).export();
    assert.deepEqual(
      { mode: result.mode, snapshotId: result.snapshotId, asOf: result.asOf, readyCount: result.readyCount, unreadyCount: result.unreadyCount, totalBytes: result.totalBytes },
      { mode: "ATTACHMENT_FILES", snapshotId: "attachment-snapshot", asOf: "2026-09-23T00:00:00.000Z", readyCount: "2", unreadyCount: "2", totalBytes: String(first.bytes.length + second.bytes.length) },
    );
    const output = join(root, "out", result.outputId);
    await privateMode(output, 0o700);
    await privateMode(join(output, "attachments"), 0o700);
    assert.deepEqual(await readFile(join(output, "attachments", `${first.versionId}.pdf`)), first.bytes);
    assert.deepEqual(await readFile(join(output, "attachments", `${second.versionId}.pdf`)), second.bytes);
    assert.deepEqual((await readdir(join(output, "attachments"))).sort(), [`${first.versionId}.pdf`, `${second.versionId}.pdf`].sort());
    assert.equal((await readdir(output)).some((name) => name.includes("malicious")), false);
    const index = await readFile(join(output, result.indexFile));
    assert.equal(sha(index), result.indexSha256);
    const indexed = index.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(indexed.length, 4);
    assert.deepEqual(indexed.filter((row) => row.backup_state === "COPIED").map((row) => row.backup_file).sort(), [
      `attachments/${first.versionId}.pdf`, `attachments/${second.versionId}.pdf`,
    ].sort());
    assert.deepEqual(indexed.filter((row) => row.backup_state === "UNREADY").map((row) => row.backup_file), [null, null]);
    await privateMode(join(output, result.indexFile), 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("READY 原件缺失、哈希或大小不符会失败，只清本次尝试", async () => {
  const root = await mkdtemp(join(tmpdir(), "alliance-attachment-failure-"));
  try {
    const store = await makeStore(root);
    const stored = await putPdf(store, randomUUID(), Buffer.from("%PDF-1.7\nimmutable\n%%EOF"));
    const existing = join(root, "out", "previous-success");
    await mkdir(existing, { recursive: true, mode: 0o700 });
    await writeFile(join(existing, "keep.txt"), "old-success", { mode: 0o600 });
    const cases = [
      ["missing", readyRow({ ...stored, versionId: randomUUID() }, randomUUID(), 1)],
      ["hash", readyRow({ ...stored, sha256: "f".repeat(64) }, randomUUID(), 1)],
      ["size", readyRow({ ...stored, sizeBytes: stored.sizeBytes + 1 }, randomUUID(), 1)],
    ];
    for (const [_name, row] of cases) {
      const { directory: spoolDirectory, spool } = await createSpool(join(root, "spools"), [row]);
      await assert.rejects(
        () => new FullBackupAttachmentExporter({
          spoolDirectory,
          spool,
          outputRoot: join(root, "out"),
          readVerified: (expected) => store.readVerified(expected),
        }).export(),
        /ATTACHMENT_(UNAVAILABLE|INTEGRITY_FAILED)/,
      );
      assert.equal(await readFile(join(existing, "keep.txt"), "utf8"), "old-success");
      assert.deepEqual((await readdir(join(root, "out"))).sort(), ["previous-success"]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("spool EOF 摘要失配发生在复制后仍使本次附件输出无产物", async () => {
  const root = await mkdtemp(join(tmpdir(), "alliance-attachment-spool-eof-"));
  try {
    const store = await makeStore(root);
    const stored = await putPdf(store, randomUUID(), Buffer.from("%PDF-1.7\ncopy then fail digest\n%%EOF"));
    const { directory: spoolDirectory, spool } = await createSpool(
      join(root, "spools"),
      [readyRow(stored, randomUUID(), 1)],
      { digestOverride: "0".repeat(64) },
    );
    let reads = 0;
    const outputRoot = join(root, "out");
    await assert.rejects(
      () => new FullBackupAttachmentExporter({
        spoolDirectory,
        spool,
        outputRoot,
        readVerified: async (expected) => { reads += 1; return store.readVerified(expected); },
      }).export(),
      /EXPORT_SPOOL_INTEGRITY_FAILED/,
    );
    assert.equal(reads, 1);
    assert.deepEqual(await readdir(outputRoot), []);
    assert.deepEqual(await store.readVerified(stored), stored.bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("READY 的声明元数据不一致仍复制已验证原件并写出业务异常", async () => {
  const root = await mkdtemp(join(tmpdir(), "alliance-attachment-declared-anomaly-"));
  try {
    const store = await makeStore(root);
    const stored = await putPdf(store, randomUUID(), Buffer.from("%PDF-1.7\nactual media wins\n%%EOF"));
    const row = readyRow(stored, randomUUID(), 1, "../../untrusted-display-name.pdf");
    row.declared_media_type = "image/png";
    row.declared_size_bytes = String(stored.sizeBytes + 1);
    row.expected_sha256 = "e".repeat(64);
    const { directory: spoolDirectory, spool } = await createSpool(join(root, "spools"), [row]);
    const result = await new FullBackupAttachmentExporter({
      spoolDirectory,
      spool,
      outputRoot: join(root, "out"),
      readVerified: (expected) => store.readVerified(expected),
    }).export();
    const output = join(root, "out", result.outputId);
    assert.deepEqual(await readFile(join(output, "attachments", `${stored.versionId}.pdf`)), stored.bytes);
    const [indexed] = (await readFile(join(output, result.indexFile), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(indexed.backup_state, "COPIED");
    assert.equal(indexed.backup_file, `attachments/${stored.versionId}.pdf`);
    assert.deepEqual(indexed.backup_anomalies, [
      "DECLARED_MEDIA_TYPE_MISMATCH",
      "DECLARED_SIZE_MISMATCH",
      "EXPECTED_HASH_MISMATCH",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("拒绝不私密或符号链接输出根，不读取 spool 或原件", async () => {
  const root = await mkdtemp(join(tmpdir(), "alliance-attachment-output-root-"));
  try {
    const { directory: spoolDirectory, spool } = await createSpool(join(root, "spools"), []);
    let reads = 0;
    const readVerified = async () => { reads += 1; throw new Error("TEST_STORAGE_MUST_NOT_RUN"); };
    const publicRoot = join(root, "public-out");
    await mkdir(publicRoot, { recursive: true, mode: 0o700 });
    await chmod(publicRoot, 0o755);
    await assert.rejects(
      () => new FullBackupAttachmentExporter({ spoolDirectory, spool, outputRoot: publicRoot, readVerified }).export(),
      /EXPORT_ATTACHMENT_UNSAFE_DIRECTORY/,
    );
    const realRoot = join(root, "real-out");
    await mkdir(realRoot, { recursive: true, mode: 0o700 });
    await chmod(realRoot, 0o700);
    const aliasRoot = join(root, "out-alias");
    await symlink(realRoot, aliasRoot);
    await assert.rejects(
      () => new FullBackupAttachmentExporter({ spoolDirectory, spool, outputRoot: aliasRoot, readVerified }).export(),
      /EXPORT_ATTACHMENT_UNSAFE_DIRECTORY/,
    );
    assert.equal(reads, 0);
    assert.deepEqual(await readdir(realRoot), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("目录 fsync 失败会拒绝附件输出并清理本次 attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "alliance-attachment-directory-sync-"));
  let prototype;
  let originalSync;
  try {
    const store = await makeStore(root);
    const stored = await putPdf(store, randomUUID(), Buffer.from("%PDF-1.7\ndirectory fsync\n%%EOF"));
    const { directory: spoolDirectory, spool } = await createSpool(join(root, "spools"), [readyRow(stored, randomUUID(), 1)]);
    const outputRoot = join(root, "out");
    await mkdir(join(outputRoot, "previous-success"), { recursive: true, mode: 0o700 });
    await writeFile(join(outputRoot, "previous-success", "keep.txt"), "keep", { mode: 0o600 });
    prototype = await fileHandlePrototype(root);
    originalSync = prototype.sync;
    let calls = 0;
    prototype.sync = async function () {
      calls += 1;
      if (calls === 5) throw new Error("TEST_DIRECTORY_FSYNC_FAILED");
      return originalSync.call(this);
    };
    await assert.rejects(
      () => new FullBackupAttachmentExporter({
        spoolDirectory,
        spool,
        outputRoot,
        readVerified: (expected) => store.readVerified(expected),
      }).export(),
      /TEST_DIRECTORY_FSYNC_FAILED/,
    );
    assert.equal(calls, 5);
    assert.equal(await readFile(join(outputRoot, "previous-success", "keep.txt"), "utf8"), "keep");
    assert.deepEqual(await readdir(outputRoot), ["previous-success"]);
  } finally {
    if (prototype !== undefined) prototype.sync = originalSync;
    await rm(root, { recursive: true, force: true });
  }
});

test("正数 short write 被完整补写，零字节 write 会失败并清理", async () => {
  const root = await mkdtemp(join(tmpdir(), "alliance-attachment-short-write-"));
  let prototype;
  let originalWrite;
  try {
    const store = await makeStore(root);
    const stored = await putPdf(store, randomUUID(), Buffer.from("%PDF-1.7\n" + "short-write-".repeat(30) + "\n%%EOF"));
    const { directory: goodSpoolDirectory, spool: goodSpool } = await createSpool(join(root, "good-spools"), [readyRow(stored, randomUUID(), 1)]);
    const { directory: badSpoolDirectory, spool: badSpool } = await createSpool(join(root, "bad-spools"), [readyRow(stored, randomUUID(), 1)]);
    prototype = await fileHandlePrototype(root);
    originalWrite = prototype.write;
    prototype.write = async function (buffer, offset, length, position) {
      return originalWrite.call(this, buffer, offset, Math.min(length, 3), position);
    };
    const good = await new FullBackupAttachmentExporter({
      spoolDirectory: goodSpoolDirectory,
      spool: goodSpool,
      outputRoot: join(root, "good-out"),
      readVerified: (expected) => store.readVerified(expected),
    }).export();
    assert.deepEqual(await readFile(join(root, "good-out", good.outputId, "attachments", `${stored.versionId}.pdf`)), stored.bytes);
    const index = await readFile(join(root, "good-out", good.outputId, good.indexFile));
    assert.equal(sha(index), good.indexSha256);
    prototype.write = async function (buffer) { return { bytesWritten: 0, buffer }; };
    const badOutput = join(root, "bad-out");
    await assert.rejects(
      () => new FullBackupAttachmentExporter({
        spoolDirectory: badSpoolDirectory,
        spool: badSpool,
        outputRoot: badOutput,
        readVerified: (expected) => store.readVerified(expected),
      }).export(),
      /EXPORT_ATTACHMENT_WRITE_FAILED/,
    );
    assert.deepEqual(await readdir(badOutput), []);
  } finally {
    if (prototype !== undefined) prototype.write = originalWrite;
    await rm(root, { recursive: true, force: true });
  }
});
