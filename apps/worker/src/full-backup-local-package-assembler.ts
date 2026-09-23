import { constants, type Dirent } from "node:fs";
import { createReadStream } from "node:fs";
import { mkdir, open, opendir, rename, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  assertPrivateBackupDirectory,
  copyVerifiedBackupFile,
  hashBackupFile,
  openPrivateBackupFile,
  syncBackupDirectory,
  writeBackupBytes,
} from "./backup-file-io.js";
import type { BackupAttachmentFiles } from "./full-backup-attachment-exporter.js";
import { FULL_BACKUP_KNOWN_COVERAGE_GAPS, FULL_BACKUP_LAYOUT_VERSION, createFullBackupLayout } from "./full-backup-layout.js";
import { readBackupSpoolDataset } from "./full-backup-spool-reader.js";
import type { FullBackupSpoolResult } from "./full-backup-spool.js";
import { fullBackupOutputColumns } from "./full-backup-transformer.js";
import type { FullBackupWorkbookExportResult } from "./full-backup-workbook-exporter.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const EXTENSIONS = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg" } as const;
const FIXED_WORKBOOKS = ["01", "02", "03", "04", "06", "07", "08", "09", "10", "11", "12", "13"] as const;
const INCOMPLETE_REASONS = [
  "BUSINESS_VIEWS_NOT_IMPLEMENTED",
  "00_MANIFEST_NOT_IMPLEMENTED",
  "FINAL_PACKAGE_MANIFEST_NOT_IMPLEMENTED",
] as const;

type AttachmentMediaType = keyof typeof EXTENSIONS;
type JsonRecord = Record<string, unknown>;

export type RawSourcePackageFile = Readonly<{ path: string; sizeBytes: string; sha256: string }>;
export type FullBackupLocalPackage = Readonly<{
  mode: "RAW_SOURCE_PACKAGE";
  complete: false;
  outputId: string;
  snapshotId: string;
  asOf: string;
  workbooks: readonly RawSourcePackageFile[];
  attachmentIndex: RawSourcePackageFile;
  anomalies: RawSourcePackageFile;
  indexFile: "raw-source-package-index.json";
  indexSha256: string;
  payloadFileCount: string;
  totalBytes: string;
  readyAttachmentCount: string;
  unreadyAttachmentCount: string;
  coverageGaps: readonly string[];
  incompleteReasons: readonly string[];
}>;
export type FullBackupLocalPackageAssemblerOptions = Readonly<{
  spoolDirectory: string;
  spool: FullBackupSpoolResult;
  workbookDirectory: string;
  workbooks: FullBackupWorkbookExportResult;
  attachmentDirectory: string;
  attachments: BackupAttachmentFiles;
  outputRoot: string;
}>;

function fail(code: string): never { throw new Error(code); }
const same = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);
const own = (value: unknown): JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : fail("EXPORT_PACKAGE_INVALID_INDEX");

async function countDirectory(root: string, expected: (name: string, entry: Dirent) => boolean): Promise<number> {
  const directory = await opendir(root);
  let count = 0;
  try {
    for await (const entry of directory) {
      if (!expected(entry.name, entry)) fail("EXPORT_PACKAGE_EXTRA_FILE");
      count += 1;
    }
  } finally { await directory.close().catch(() => undefined); }
  return count;
}

async function* lines(root: string, relative: string): AsyncGenerator<string> {
  const handle = await openPrivateBackupFile(root, relative);
  const stream = handle.createReadStream({ autoClose: false, encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try { for await (const line of reader) yield line; }
  finally { reader.close(); stream.destroy(); await handle.close(); }
}

async function createPrivateDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: false, mode: 0o700 });
  return assertPrivateBackupDirectory(path);
}

async function openOutput(root: string, relative: string): Promise<FileHandle> {
  const parts = relative.split("/");
  if (!relative || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) fail("EXPORT_PACKAGE_INVALID_PATH");
  const path = join(root, ...parts);
  return open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
}

async function writeLine(file: FileHandle, value: string): Promise<void> {
  await writeBackupBytes(file, Buffer.from(`${value}\n`, "utf8"));
}

function assertSnapshots(options: FullBackupLocalPackageAssemblerOptions): void {
  const { spool, workbooks, attachments } = options;
  if (spool.mode !== "RAW_SOURCE_SPOOL" || workbooks.mode !== "RAW_SOURCE_WORKBOOKS" || attachments.mode !== "ATTACHMENT_FILES" ||
      workbooks.spoolId !== spool.spoolId || workbooks.snapshotId !== spool.snapshotId || attachments.snapshotId !== spool.snapshotId ||
      workbooks.asOf !== spool.asOf || attachments.asOf !== spool.asOf || !same(workbooks.coverageGaps, spool.coverageGaps) ||
      !same(spool.coverageGaps, FULL_BACKUP_KNOWN_COVERAGE_GAPS)) fail("EXPORT_PACKAGE_SNAPSHOT_MISMATCH");
  const layout = createFullBackupLayout();
  if (spool.datasets.length !== layout.length) fail("EXPORT_PACKAGE_SPOOL_LAYOUT_INVALID");
  for (const [index, item] of layout.entries()) {
    const dataset = spool.datasets[index];
    const expectedExcluded = item.policy === "AUTH_SECRET_TABLE_EXCLUDED";
    const expectedColumns = expectedExcluded ? [] : fullBackupOutputColumns(item.tableName);
    const expectedFile = expectedExcluded ? null : `datasets/${String(index + 1).padStart(3, "0")}_${item.tableName}.ndjson`;
    if (dataset === undefined || dataset.tableName !== item.tableName || dataset.excluded !== expectedExcluded || !same(dataset.columns, expectedColumns) || dataset.spoolFile !== expectedFile ||
        (expectedExcluded ? dataset.rowCount !== null || dataset.logicalDigest !== null : dataset.rowCount === null || !/^(0|[1-9]\d*)$/.test(dataset.rowCount) || dataset.logicalDigest === null || !SHA256.test(dataset.logicalDigest)))
      fail("EXPORT_PACKAGE_SPOOL_LAYOUT_INVALID");
  }
  const ids = workbooks.workbooks.map((item) => item.workbookId);
  const expectedCounts = new Map<string, number>();
  for (const item of createFullBackupLayout()) if (item.policy === "RAW_SOURCE") expectedCounts.set(item.workbookId, (expectedCounts.get(item.workbookId) ?? 0) + 1);
  if (!same(ids, FIXED_WORKBOOKS) || new Set(workbooks.workbooks.map((item) => item.file)).size !== FIXED_WORKBOOKS.length ||
      workbooks.workbooks.some((item) => item.file !== `workbook-${item.workbookId}.xlsx` || item.datasetCount !== String(expectedCounts.get(item.workbookId)) ||
        typeof item.sizeBytes !== "string" || !/^[1-9]\d*$/.test(item.sizeBytes) || typeof item.sha256 !== "string" || !SHA256.test(item.sha256))) fail("EXPORT_PACKAGE_WORKBOOKS_INVALID");
}

function attachmentDataset(spool: FullBackupSpoolResult) {
  const dataset = spool.datasets.find((item) => item.tableName === "finance_attachment_version");
  if (dataset === undefined || dataset.excluded) fail("EXPORT_PACKAGE_ATTACHMENT_DATASET_INVALID");
  return dataset!;
}

function expectedAttachment(row: JsonRecord): Readonly<{ id: string; status: string; media?: AttachmentMediaType; bytes?: bigint; hash?: string }> {
  const id = row.id;
  const status = row.status;
  if (typeof id !== "string" || !UUID.test(id) || (status !== "READY" && status !== "UPLOADING" && status !== "FAILED"))
    fail("EXPORT_PACKAGE_INVALID_INDEX");
  const validId: string = id;
  const validStatus: "READY" | "UPLOADING" | "FAILED" = status;
  if (validStatus !== "READY") return { id: validId, status: validStatus };
  const media = row.detected_media_type;
  const bytes = row.actual_size_bytes;
  const hash = row.sha256;
  if (typeof media !== "string" || !Object.hasOwn(EXTENSIONS, media) || typeof bytes !== "string" || !/^[1-9]\d*$/.test(bytes) ||
      typeof hash !== "string" || !SHA256.test(hash)) fail("EXPORT_PACKAGE_INVALID_INDEX");
  return { id: validId, status: validStatus, media: media as AttachmentMediaType, bytes: BigInt(bytes), hash };
}

function safeAnomaly(value: unknown): void {
  const row = own(value);
  const keys = Object.keys(row).sort();
  if (!same(keys, row.field === undefined ? ["code", "columnName", "rowNumber", "tableName"] : ["code", "columnName", "field", "rowNumber", "tableName"]) ||
      row.code !== "TRANSFORM_VALUE_ANOMALY" || typeof row.tableName !== "string" || typeof row.columnName !== "string" ||
      typeof row.rowNumber !== "string" || !/^[a-z_][a-z0-9_]*$/.test(row.tableName) || !/^[a-z_][a-z0-9_]*$/.test(row.columnName) ||
      !/^(0|[1-9]\d*)$/.test(row.rowNumber) || (row.field !== undefined && (typeof row.field !== "string" || !SAFE_FIELD.test(row.field))))
    fail("EXPORT_PACKAGE_ANOMALY_INVALID");
}

/** Assembles already-verified raw components; it never represents a complete F14 backup. */
export class FullBackupLocalPackageAssembler {
  public constructor(private readonly options: FullBackupLocalPackageAssemblerOptions) {}

  public async assemble(): Promise<FullBackupLocalPackage> {
    assertSnapshots(this.options);
    const workbookRoot = await assertPrivateBackupDirectory(this.options.workbookDirectory);
    const attachmentRoot = await assertPrivateBackupDirectory(this.options.attachmentDirectory);
    const spoolRoot = await assertPrivateBackupDirectory(this.options.spoolDirectory);
    await mkdir(this.options.outputRoot, { recursive: true, mode: 0o700 });
    const outputRoot = await assertPrivateBackupDirectory(this.options.outputRoot);
    const stageName = `.raw-source-package-stage-${crypto.randomUUID()}`;
    const finalName = `raw-source-package-${crypto.randomUUID()}`;
    const stage = await createPrivateDirectory(join(outputRoot, stageName));
    const finalDirectory = join(outputRoot, finalName);
    let renamed = false;
    let published = false;
    let payloadIndex: FileHandle | undefined;
    let outputIndex: FileHandle | undefined;
    let outputAnomalies: FileHandle | undefined;
    let sourceRows: AsyncIterator<readonly (string | null)[]> | undefined;
    let primaryError: unknown;
    try {
      const workbookFiles = new Map(this.options.workbooks.workbooks.map((item) => [item.file, item]));
      if (await countDirectory(workbookRoot, (name, entry) => entry.isFile() && workbookFiles.has(name)) !== FIXED_WORKBOOKS.length)
        fail("EXPORT_PACKAGE_EXTRA_FILE");
      const destinationWorkbooks = await createPrivateDirectory(join(stage, "workbooks"));
      const metadataDirectory = await createPrivateDirectory(join(stage, "metadata"));
      const payloadIndexPath = "metadata/.payloads.ndjson";
      payloadIndex = await openOutput(stage, payloadIndexPath);
      let payloadFileCount = 0n, totalBytes = 0n;
      const addPayload = async (file: RawSourcePackageFile): Promise<void> => {
        await writeLine(payloadIndex!, JSON.stringify(file));
        payloadFileCount += 1n;
        totalBytes += BigInt(file.sizeBytes);
      };
      const workbookResults: RawSourcePackageFile[] = [];
      for (const id of FIXED_WORKBOOKS) {
        const file = `workbook-${id}.xlsx`;
        const expected = workbookFiles.get(file)!;
        const copied = await copyVerifiedBackupFile({ sourceRoot: workbookRoot, sourcePath: file, destinationRoot: stage, destinationPath: `workbooks/${file}`,
          expectedBytes: BigInt(expected.sizeBytes), expectedSha256: expected.sha256 });
        workbookResults.push(copied);
        await addPayload(copied);
      }
      await syncBackupDirectory(destinationWorkbooks);

      if (await countDirectory(attachmentRoot, (name, entry) => (name === this.options.attachments.indexFile && entry.isFile()) || (name === "attachments" && entry.isDirectory())) !== 2)
        fail("EXPORT_PACKAGE_EXTRA_FILE");
      const sourceAttachments = await assertPrivateBackupDirectory(join(attachmentRoot, "attachments"));
      const destinationAttachments = await createPrivateDirectory(join(stage, "attachments"));
      const dataset = attachmentDataset(this.options.spool);
      sourceRows = readBackupSpoolDataset(spoolRoot, dataset)[Symbol.asyncIterator]();
      const indexHash = await hashBackupFile(attachmentRoot, this.options.attachments.indexFile);
      if (indexHash.sha256 !== this.options.attachments.indexSha256) fail("EXPORT_PACKAGE_ATTACHMENT_INDEX_HASH");
      outputIndex = await openOutput(stage, "metadata/attachment-index.ndjson");
      let ready = 0n, unready = 0n, readyBytes = 0n, previousId = "";
      try {
        for await (const line of lines(attachmentRoot, this.options.attachments.indexFile)) {
          let indexRow!: JsonRecord;
          try { indexRow = own(JSON.parse(line)); } catch { fail("EXPORT_PACKAGE_INVALID_INDEX"); }
          const source = await sourceRows!.next();
          if (source.done) fail("EXPORT_PACKAGE_ATTACHMENT_LOCKSTEP");
          const sourceRow = Object.fromEntries(dataset.columns.map((column, index) => [column, source.value[index]]));
          const expectedKeys = [...dataset.columns, "backup_anomalies", "backup_file", "backup_state"].sort();
          if (!same(Object.keys(indexRow).sort(), expectedKeys) || dataset.columns.some((column) => indexRow[column] !== sourceRow[column]))
            fail("EXPORT_PACKAGE_ATTACHMENT_LOCKSTEP");
          const expected = expectedAttachment(sourceRow);
          if (expected.id <= previousId) fail("EXPORT_PACKAGE_ATTACHMENT_ORDER");
          previousId = expected.id;
          if (!Array.isArray(indexRow.backup_anomalies) || indexRow.backup_anomalies.some((item) => typeof item !== "string" || !/^[A-Z_]+$/.test(item)))
            fail("EXPORT_PACKAGE_INVALID_INDEX");
          if (expected.status === "READY") {
            const sourceFile = `attachments/${expected.id}.${EXTENSIONS[expected.media!]}`;
            if (indexRow.backup_state !== "COPIED" || indexRow.backup_file !== sourceFile) fail("EXPORT_PACKAGE_ATTACHMENT_LOCKSTEP");
            const copied = await copyVerifiedBackupFile({ sourceRoot: attachmentRoot, sourcePath: sourceFile, destinationRoot: stage, destinationPath: sourceFile,
              expectedBytes: expected.bytes!, expectedSha256: expected.hash!, expectedMediaType: expected.media! });
            if (copied.path !== sourceFile) fail("EXPORT_PACKAGE_ATTACHMENT_LOCKSTEP");
            await addPayload(copied);
            readyBytes += BigInt(copied.sizeBytes);
            ready += 1n;
          } else {
            if (indexRow.backup_state !== "UNREADY" || indexRow.backup_file !== null) fail("EXPORT_PACKAGE_ATTACHMENT_LOCKSTEP");
            unready += 1n;
          }
          await writeLine(outputIndex!, line);
        }
        const trailing = await sourceRows!.next();
        if (!trailing.done) fail("EXPORT_PACKAGE_ATTACHMENT_LOCKSTEP");
      } finally {
        if (outputIndex !== undefined) { await outputIndex.sync(); await outputIndex.close(); outputIndex = undefined; }
        if (sourceRows?.return !== undefined) { await sourceRows.return(undefined as never); sourceRows = undefined; }
      }
      if (ready.toString() !== this.options.attachments.readyCount || unready.toString() !== this.options.attachments.unreadyCount ||
          readyBytes.toString() !== this.options.attachments.totalBytes)
        fail("EXPORT_PACKAGE_ATTACHMENT_LOCKSTEP");
      if (await countDirectory(sourceAttachments, (name, entry) => entry.isFile() && UUID.test(name.slice(0, 36)) && /\.(pdf|png|jpg)$/.test(name)) !== Number(ready))
        fail("EXPORT_PACKAGE_EXTRA_FILE");
      if (await countDirectory(destinationAttachments, (name, entry) => entry.isFile() && UUID.test(name.slice(0, 36)) && /\.(pdf|png|jpg)$/.test(name)) !== Number(ready))
        fail("EXPORT_PACKAGE_EXTRA_FILE");
      const outputIndexHash = await hashBackupFile(stage, "metadata/attachment-index.ndjson");
      if (outputIndexHash.sha256 !== indexHash.sha256) fail("EXPORT_PACKAGE_ATTACHMENT_INDEX_HASH");
      const attachmentIndex: RawSourcePackageFile = { path: "metadata/attachment-index.ndjson", ...outputIndexHash };
      await addPayload(attachmentIndex);
      await syncBackupDirectory(destinationAttachments);

      outputAnomalies = await openOutput(stage, "metadata/transform-anomalies.ndjson");
      let anomalyCount = 0n;
      try {
        for await (const line of lines(spoolRoot, this.options.spool.anomalyFile)) {
          let value: unknown;
          try { value = JSON.parse(line); } catch { fail("EXPORT_PACKAGE_ANOMALY_INVALID"); }
          safeAnomaly(value);
          await writeLine(outputAnomalies!, line);
          anomalyCount += 1n;
        }
      } finally {
        if (outputAnomalies !== undefined) { await outputAnomalies.sync(); await outputAnomalies.close(); outputAnomalies = undefined; }
      }
      if (anomalyCount.toString() !== this.options.spool.anomalyCount) fail("EXPORT_PACKAGE_ANOMALY_COUNT");
      const anomalyHash = await hashBackupFile(stage, "metadata/transform-anomalies.ndjson");
      const anomalies: RawSourcePackageFile = { path: "metadata/transform-anomalies.ndjson", ...anomalyHash };
      await addPayload(anomalies);
      await payloadIndex.sync();
      await payloadIndex.close();
      payloadIndex = undefined;
      const finalIndex = await openOutput(stage, "raw-source-package-index.json");
      try {
        const datasetSummary = this.options.spool.datasets.map((item) => ({ tableName: item.tableName, rowCount: item.rowCount, logicalDigest: item.logicalDigest, excluded: item.excluded }));
        const prefix = `{"mode":"RAW_SOURCE_PACKAGE","complete":false,"snapshotId":${JSON.stringify(this.options.spool.snapshotId)},"asOf":${JSON.stringify(this.options.spool.asOf)},"sourceIds":${JSON.stringify({ spoolId: this.options.spool.spoolId, workbookOutputId: this.options.workbooks.outputId, attachmentOutputId: this.options.attachments.outputId })},"layoutVersion":${JSON.stringify(FULL_BACKUP_LAYOUT_VERSION)},"datasets":${JSON.stringify(datasetSummary)},"attachmentIndex":${JSON.stringify(attachmentIndex)},"readyAttachmentCount":${JSON.stringify(ready.toString())},"unreadyAttachmentCount":${JSON.stringify(unready.toString())},"anomalyCount":${JSON.stringify(anomalyCount.toString())},"coverageGaps":${JSON.stringify(this.options.spool.coverageGaps)},"incompleteReasons":${JSON.stringify(INCOMPLETE_REASONS)},"files":[`;
        await writeBackupBytes(finalIndex, Buffer.from(prefix));
        let first = true;
        for await (const line of lines(stage, payloadIndexPath)) {
          JSON.parse(line);
          await writeBackupBytes(finalIndex, Buffer.from(`${first ? "" : ","}${line}`));
          first = false;
        }
        await writeBackupBytes(finalIndex, Buffer.from("]}"));
        await finalIndex.sync();
      } finally { await finalIndex.close(); }
      await rm(join(stage, payloadIndexPath), { force: true });
      const packageIndexHash = await hashBackupFile(stage, "raw-source-package-index.json");
      await syncBackupDirectory(metadataDirectory);
      await syncBackupDirectory(stage);
      try { await open(finalDirectory, constants.O_RDONLY | constants.O_NOFOLLOW).then((handle) => handle.close().then(() => fail("EXPORT_PACKAGE_TARGET_EXISTS"))).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
      catch { fail("EXPORT_PACKAGE_TARGET_EXISTS"); }
      await rename(stage, finalDirectory);
      renamed = true;
      await syncBackupDirectory(outputRoot);
      published = true;
      return { mode: "RAW_SOURCE_PACKAGE", complete: false, outputId: finalName, snapshotId: this.options.spool.snapshotId, asOf: this.options.spool.asOf,
        workbooks: workbookResults, attachmentIndex, anomalies, indexFile: "raw-source-package-index.json", indexSha256: packageIndexHash.sha256,
        payloadFileCount: payloadFileCount.toString(), totalBytes: totalBytes.toString(), readyAttachmentCount: ready.toString(), unreadyAttachmentCount: unready.toString(),
        coverageGaps: [...this.options.spool.coverageGaps], incompleteReasons: [...INCOMPLETE_REASONS] };
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      const cleanup = await Promise.allSettled([
        ...(payloadIndex === undefined ? [] : [payloadIndex.close()]),
        ...(outputIndex === undefined ? [] : [outputIndex.close()]),
        ...(outputAnomalies === undefined ? [] : [outputAnomalies.close()]),
        ...(sourceRows?.return === undefined ? [] : [sourceRows.return(undefined as never)]),
      ]);
      if (!published) {
        await rm(stage, { recursive: true, force: true });
        if (renamed) await rm(finalDirectory, { recursive: true, force: true });
      }
      if (primaryError === undefined && cleanup.some((result) => result.status === "rejected"))
        throw new AggregateError(cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason), "EXPORT_PACKAGE_RESOURCE_CLEANUP_FAILED");
    }
  }
}
