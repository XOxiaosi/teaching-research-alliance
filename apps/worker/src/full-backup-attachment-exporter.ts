import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rm, lstat, realpath, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { readBackupSpoolDataset } from "./full-backup-spool-reader.js";
import type { FullBackupSpoolResult } from "./full-backup-spool.js";

export type BackupAttachmentObject = Readonly<{
  versionId: string;
  mediaType: "application/pdf" | "image/png" | "image/jpeg";
  sizeBytes: number;
  sha256: string;
}>;
export type BackupAttachmentExporterOptions = Readonly<{
  spoolDirectory: string;
  spool: FullBackupSpoolResult;
  outputRoot: string;
  /** Runtime supplies the immutable store's verified reader; no storage paths enter metadata. */
  readVerified: (object: BackupAttachmentObject) => Promise<Uint8Array>;
}>;
export type BackupAttachmentFiles = Readonly<{
  mode: "ATTACHMENT_FILES";
  outputId: string;
  snapshotId: string;
  asOf: string;
  indexFile: "attachment-index.ndjson";
  indexSha256: string;
  readyCount: string;
  unreadyCount: string;
  totalBytes: string;
}>;
function invalid(): never { throw new Error("EXPORT_ATTACHMENT_INVALID_METADATA"); }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha256 = /^[0-9a-f]{64}$/;
const extensions = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg" } as const;
const maxBytes = 20 * 1024 * 1024;
function detectedType(bytes: Uint8Array): BackupAttachmentObject["mediaType"] | undefined {
  const prefix = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 8));
  if (prefix.subarray(0, 5).equals(Buffer.from("%PDF-"))) return "application/pdf";
  if (prefix.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255) return "image/jpeg";
  return undefined;
}
async function writeAll(file: FileHandle, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) {
    const result = await file.write(data, offset, data.byteLength - offset);
    if (result.bytesWritten <= 0) throw new Error("EXPORT_ATTACHMENT_WRITE_FAILED");
    offset += result.bytesWritten;
  }
}
async function privateDirectory(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())) throw new Error("EXPORT_ATTACHMENT_UNSAFE_DIRECTORY");
  return realpath(path);
}
async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}

/** Copies every READY version from the frozen spool, including historical/unbound versions.
 * This is one package component, not a complete backup or a public download. */
export class FullBackupAttachmentExporter {
  public constructor(private readonly options: BackupAttachmentExporterOptions) {}

  public async export(): Promise<BackupAttachmentFiles> {
    const { spool } = this.options;
    const matches = spool.datasets.filter(dataset => dataset.tableName === "finance_attachment_version");
    if (spool.mode !== "RAW_SOURCE_SPOOL" || matches.length !== 1 || matches[0]!.excluded) invalid();
    const dataset = matches[0]!;
    let directory: string | undefined;
    let index: FileHandle | undefined;
    try {
      await mkdir(this.options.outputRoot, { recursive: true, mode: 0o700 });
      const root = await privateDirectory(this.options.outputRoot);
      directory = await mkdtemp(join(root, "full-backup-attachments-"));
      await privateDirectory(directory);
      await mkdir(join(directory, "attachments"), { mode: 0o700 });
      await privateDirectory(join(directory, "attachments"));
      index = await open(join(directory, "attachment-index.ndjson"), "wx", 0o600);
      const digest = createHash("sha256");
      let readyCount = 0n, unreadyCount = 0n, totalBytes = 0n;
      for await (const values of readBackupSpoolDataset(this.options.spoolDirectory, dataset)) {
        const row = Object.fromEntries(dataset.columns.map((column, i) => [column, values[i]]));
        const versionId = row.id;
        if (typeof versionId !== "string" || !uuid.test(versionId) || !["READY", "UPLOADING", "FAILED"].includes(row.status ?? "")) invalid();
        let file: string | null = null;
        const anomalies: string[] = [];
        if (row.status === "READY") {
          const mediaType = row.detected_media_type;
          const sizeText = row.actual_size_bytes;
          const expectedHash = row.sha256;
          if (typeof mediaType !== "string" || !Object.hasOwn(extensions, mediaType) ||
              typeof sizeText !== "string" || !/^[1-9]\d*$/.test(sizeText) ||
              BigInt(sizeText) > BigInt(maxBytes) || typeof expectedHash !== "string" || !sha256.test(expectedHash)) invalid();
          const expected: BackupAttachmentObject = {
            versionId,
            mediaType: mediaType as BackupAttachmentObject["mediaType"],
            sizeBytes: Number(sizeText),
            sha256: expectedHash,
          };
          const bytes = await this.options.readVerified(expected);
          // Independently verify injected storage adapters before accepting any bytes.
          if (!(bytes instanceof Uint8Array) || bytes.byteLength !== expected.sizeBytes ||
              createHash("sha256").update(bytes).digest("hex") !== expected.sha256 || detectedType(bytes) !== expected.mediaType) {
            throw new Error("EXPORT_ATTACHMENT_CONTENT_MISMATCH");
          }
          // Preserve inconsistent declared business metadata, while copying only verified actual bytes.
          if (row.declared_media_type !== mediaType) anomalies.push("DECLARED_MEDIA_TYPE_MISMATCH");
          if (row.declared_size_bytes !== sizeText) anomalies.push("DECLARED_SIZE_MISMATCH");
          if (row.expected_sha256 !== null && row.expected_sha256 !== expectedHash) anomalies.push("EXPECTED_HASH_MISMATCH");
          if (!row.ready_at || !Number.isFinite(Date.parse(row.ready_at))) anomalies.push("READY_TIME_INVALID");
          file = `attachments/${versionId}.${extensions[expected.mediaType]}`;
          const destination = await open(join(directory, file), "wx", 0o600);
          try { await writeAll(destination, bytes); await destination.sync(); }
          finally { await destination.close(); }
          readyCount += 1n;
          totalBytes += BigInt(bytes.byteLength);
        } else {
          // The snapshot controls readiness: never inspect a concurrently published object.
          unreadyCount += 1n;
        }
        const line = Buffer.from(JSON.stringify({ ...row, backup_state: file === null ? "UNREADY" : "COPIED", backup_file: file, backup_anomalies: anomalies }) + "\n");
        await writeAll(index, line);
        digest.update(line);
      }
      // Reaching EOF is mandatory: it validates the source spool's row count and digest.
      await index.sync();
      await index.close(); index = undefined;
      await syncDirectory(join(directory, "attachments"));
      await syncDirectory(directory);
      await syncDirectory(root);
      return {
        mode: "ATTACHMENT_FILES", outputId: basename(directory), snapshotId: spool.snapshotId, asOf: spool.asOf,
        indexFile: "attachment-index.ndjson", indexSha256: digest.digest("hex"),
        readyCount: readyCount.toString(), unreadyCount: unreadyCount.toString(), totalBytes: totalBytes.toString(),
      };
    } catch (error) {
      try { await index?.close(); }
      finally { if (directory !== undefined) await rm(directory, { recursive: true, force: true }); }
      throw error;
    }
  }
}
