import { constants } from "node:fs";
import { lstat, open, realpath, rm, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const fail = (): never => { throw new Error("BACKUP_FILE_INVALID"); };
const privateMode = (mode: number, uid: number): void => {
  if ((mode & 0o077) !== 0 || (process.getuid && uid !== process.getuid())) fail();
};

export async function assertPrivateBackupDirectory(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail();
  privateMode(info.mode, info.uid);
  return realpath(path);
}

async function checkedPath(root: string, relative: string): Promise<string> {
  if (!relative || !/^[a-zA-Z0-9_.\/-]+$/.test(relative)) fail();
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) fail();
  let current = await assertPrivateBackupDirectory(root);
  for (const part of parts.slice(0, -1)) {
    current = await assertPrivateBackupDirectory(join(current, part));
  }
  return join(current, parts[parts.length - 1]!);
}

export async function openPrivateBackupFile(root: string, relative: string): Promise<FileHandle> {
  const path = await checkedPath(root, relative);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail();
    privateMode(info.mode, info.uid);
    return handle;
  } catch (error) { await handle.close().catch(() => {}); throw error; }
}

export async function writeBackupBytes(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > bytes.byteLength - offset) fail();
    offset += bytesWritten;
  }
}

export async function syncBackupDirectory(path: string): Promise<void> {
  const canonical = await assertPrivateBackupDirectory(path);
  const handle = await open(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

function mediaMatches(prefix: Buffer, media: string): boolean {
  if (media === "application/pdf") return prefix.subarray(0, 5).equals(Buffer.from("%PDF-"));
  if (media === "image/png") return prefix.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (media === "image/jpeg") return prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255;
  return false;
}

async function scan(handle: FileHandle, consume?: (bytes: Buffer) => Promise<void>) {
  const before = await handle.stat({ bigint: true });
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  const prefix = Buffer.alloc(8);
  let prefixLength = 0;
  let size = 0n;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (!bytesRead) break;
    const bytes = buffer.subarray(0, bytesRead);
    const take = Math.min(8 - prefixLength, bytesRead);
    bytes.copy(prefix, prefixLength, 0, take);
    prefixLength += take;
    hash.update(bytes);
    size += BigInt(bytesRead);
    if (consume) await consume(bytes);
  }
  const after = await handle.stat({ bigint: true });
  if (size !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail();
  return { sizeBytes: size.toString(), sha256: hash.digest("hex"), prefix: prefix.subarray(0, prefixLength) };
}

export async function hashBackupFile(root: string, relative: string): Promise<{ sizeBytes: string; sha256: string }> {
  const handle = await openPrivateBackupFile(root, relative);
  try { const { sizeBytes, sha256 } = await scan(handle); return { sizeBytes, sha256 }; }
  finally { await handle.close(); }
}

export async function copyVerifiedBackupFile(options: {
  sourceRoot: string; sourcePath: string; destinationRoot: string; destinationPath: string;
  expectedBytes?: bigint; expectedSha256?: string;
  expectedMediaType?: "application/pdf" | "image/png" | "image/jpeg";
}): Promise<{ path: string; sizeBytes: string; sha256: string }> {
  const source = await openPrivateBackupFile(options.sourceRoot, options.sourcePath);
  let destination: FileHandle | undefined;
  let createdPath: string | undefined;
  let error: unknown;
  let result: { path: string; sizeBytes: string; sha256: string } | undefined;
  try {
    const path = await checkedPath(options.destinationRoot, options.destinationPath);
    destination = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    createdPath = path;
    const data = await scan(source, (bytes) => writeBackupBytes(destination!, bytes));
    if ((options.expectedBytes !== undefined && BigInt(data.sizeBytes) !== options.expectedBytes)
      || (options.expectedSha256 !== undefined && data.sha256 !== options.expectedSha256)
      || (options.expectedMediaType !== undefined && !mediaMatches(data.prefix, options.expectedMediaType))) fail();
    await destination.sync();
    result = { path: options.destinationPath, sizeBytes: data.sizeBytes, sha256: data.sha256 };
  } catch (caught) { error = caught; }
  for (const handle of [destination, source]) {
    if (handle) try { await handle.close(); } catch (caught) { error ??= caught; }
  }
  if (error !== undefined) {
    if (createdPath) try { await rm(createdPath, { force: true }); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "BACKUP_FILE_CLEANUP_FAILED", { cause: error }); }
    throw error;
  }
  return result ?? fail();
}
