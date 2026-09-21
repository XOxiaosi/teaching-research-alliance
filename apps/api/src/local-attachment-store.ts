import { constants } from "node:fs";
import { mkdir, open, realpath, lstat, link, unlink } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type AttachmentMediaType = "application/pdf" | "image/png" | "image/jpeg";
export type StoredAttachment = Readonly<{
  versionId: string;
  mediaType: AttachmentMediaType;
  sizeBytes: number;
  sha256: string;
}>;
export type AttachmentUpload = Readonly<{
  versionId: string;
  originalFilename: string;
  declaredMediaType: AttachmentMediaType;
  declaredSizeBytes: number;
  expectedSha256?: string;
}>;
/** The caller must reconcile this version; a fresh upload must not replace the published object. */
export class AttachmentPublicationError extends Error {
  public constructor(public readonly stored: StoredAttachment, public readonly durable: boolean, public readonly cleanupRequired: boolean, public readonly stagingObjectId: string) {
    super("ATTACHMENT_PUBLICATION_REQUIRES_RECONCILIATION");
  }
}
/** Internal audit identifier only; never include this error's fields in public API responses. */
export class AttachmentCleanupError extends Error {
  public constructor(public readonly stagingObjectId: string, cause: unknown) {
    super("ATTACHMENT_CLEANUP_FAILED", { cause });
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const inside = (path: string, root: string): boolean => path === root || path.startsWith(root + sep);
const detect = (bytes: Buffer): AttachmentMediaType | undefined => {
  if (bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) return "application/pdf";
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  return undefined;
};

/**
 * Private byte-storage primitive, not a document parser or authorization service.
 * Deployment must keep its root's ancestors trusted and non-replaceable by untrusted users.
 * Directory permission checks do not sandbox a hostile local process running as the same user.
 */
export class LocalAttachmentStore {
  private constructor(private readonly root: string, public readonly maxFileBytes: number, private readonly openFile: typeof open) {}

  public static async create(root: string, sourceRoot: string, maxFileBytes = 20 * 1024 * 1024, openFile: typeof open = open): Promise<LocalAttachmentStore> {
    if (!root.trim() || !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 8 || maxFileBytes > 20 * 1024 * 1024) throw new Error("ATTACHMENT_STORE_CONFIG_INVALID");
    const location = resolve(root);
    const source = await realpath(sourceRoot);
    if (inside(location, source)) throw new Error("ATTACHMENT_STORE_INSIDE_SOURCE");
    await mkdir(location, { recursive: true, mode: 0o700 });
    const canonical = await realpath(location);
    const rootInfo = await lstat(location);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || inside(canonical, source)) throw new Error("ATTACHMENT_STORE_PATH_INVALID");
    if ((rootInfo.mode & 0o077) !== 0) throw new Error("ATTACHMENT_STORE_PERMISSIONS_INVALID");
    if (process.getuid && rootInfo.uid !== process.getuid()) throw new Error("ATTACHMENT_STORE_PERMISSIONS_INVALID");
    const store = new LocalAttachmentStore(canonical, maxFileBytes, openFile);
    await store.directory("staging");
    await store.directory("objects");
    return store;
  }

  private async directory(name: "staging" | "objects"): Promise<string> {
    const path = join(this.root, name);
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error("ATTACHMENT_STORE_PATH_INVALID");
    if ((info.mode & 0o077) !== 0) throw new Error("ATTACHMENT_STORE_PERMISSIONS_INVALID");
    if (process.getuid && info.uid !== process.getuid()) throw new Error("ATTACHMENT_STORE_PERMISSIONS_INVALID");
    return path;
  }

  private validateId(id: string): void {
    if (!UUID.test(id)) throw new Error("ATTACHMENT_VERSION_INVALID");
  }

  public async put(upload: AttachmentUpload, chunks: AsyncIterable<Uint8Array>, validateContent?: (bytes: Buffer) => Promise<void>): Promise<StoredAttachment> {
    this.validateId(upload.versionId);
    if (!upload.originalFilename.trim() || Buffer.byteLength(upload.originalFilename, "utf8") > 255
      || /[\x00-\x1f\x7f/\\]/.test(upload.originalFilename)
      || !Number.isSafeInteger(upload.declaredSizeBytes) || upload.declaredSizeBytes < 1 || upload.declaredSizeBytes > this.maxFileBytes
      || (upload.expectedSha256 !== undefined && !SHA256.test(upload.expectedSha256))) throw new Error("ATTACHMENT_METADATA_INVALID");
    const staging = await this.directory("staging");
    const objects = await this.directory("objects");
    const stagingObjectId = `${upload.versionId}-${randomUUID()}.part`;
    const temporary = join(staging, stagingObjectId);
    const destination = join(objects, upload.versionId);
    const file = await this.openFile(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let failure: unknown;
    let result: StoredAttachment | undefined;
    let published = false;
    let durable = false;
    try {
      const hash = createHash("sha256");
      let size = 0;
      let prefix = Buffer.alloc(0);
      for await (const chunk of chunks) {
        if (chunk.byteLength > this.maxFileBytes - size || chunk.byteLength > upload.declaredSizeBytes - size) throw new Error("ATTACHMENT_TOO_LARGE");
        const data = Buffer.from(chunk);
        size += data.length;
        if (size > this.maxFileBytes || size > upload.declaredSizeBytes) throw new Error("ATTACHMENT_TOO_LARGE");
        if (prefix.length < 8) prefix = Buffer.concat([prefix, data.subarray(0, 8 - prefix.length)]);
        hash.update(data);
        // FileHandle.write may complete only part of a buffer.
        let offset = 0;
        while (offset < data.length) {
          const written = await file.write(data, offset, data.length - offset);
          if (written.bytesWritten === 0) throw new Error("ATTACHMENT_WRITE_FAILED");
          offset += written.bytesWritten;
        }
      }
      if (size !== upload.declaredSizeBytes) throw new Error("ATTACHMENT_SIZE_MISMATCH");
      const mediaType = detect(prefix);
      if (mediaType === undefined || mediaType !== upload.declaredMediaType) throw new Error("ATTACHMENT_TYPE_INVALID");
      const sha256 = hash.digest("hex");
      if (upload.expectedSha256 !== undefined && upload.expectedSha256 !== sha256) throw new Error("ATTACHMENT_HASH_MISMATCH");
      await file.sync();
      result = { versionId: upload.versionId, mediaType, sizeBytes: size, sha256 };
    } catch (error) { failure = error; }
    finally {
      try { await file.close(); }
      catch (error) { failure ??= error; }
    }
    if (failure === undefined) {
      try {
        // Business callers validate parseability before an object becomes permanent.
        if (validateContent) await validateContent(await this.readPathVerified(temporary, result!));
        // Atomic no-replace publication: unlike rename, link cannot overwrite an existing version.
        await link(temporary, destination);
        published = true;
        const directory = await this.openFile(objects, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await directory.sync(); durable = true; } finally { await directory.close(); }
      } catch (error) {
        failure = (error as NodeJS.ErrnoException).code === "EEXIST" ? new Error("ATTACHMENT_VERSION_EXISTS") : error;
      }
    }
    let cleanupFailed = false;
    try { await unlink(temporary); }
    catch { cleanupFailed = true; }
    if (published && (failure !== undefined || cleanupFailed)) throw new AttachmentPublicationError(result!, durable, cleanupFailed, stagingObjectId);
    if (cleanupFailed) throw new AttachmentCleanupError(stagingObjectId, failure);
    if (failure !== undefined) throw failure;
    return result!;
  }

  /** Verify the exact immutable bytes before a caller starts sending a response or backup. */
  public async readVerified(expected: StoredAttachment): Promise<Buffer> {
    this.validateId(expected.versionId);
    if (!SHA256.test(expected.sha256) || !Number.isSafeInteger(expected.sizeBytes)
      || expected.sizeBytes < 1 || expected.sizeBytes > this.maxFileBytes) throw new Error("ATTACHMENT_METADATA_INVALID");
    const objects = await this.directory("objects");
    return this.readPathVerified(join(objects, expected.versionId), expected);
  }

  /** Recover a published object after a database failure; never overwrite it with retry bytes. */
  public async reconcilePublished(upload: AttachmentUpload, validateContent: (bytes: Buffer) => Promise<void>): Promise<StoredAttachment> {
    this.validateId(upload.versionId);
    if(!Number.isSafeInteger(upload.declaredSizeBytes)||upload.declaredSizeBytes<1||upload.declaredSizeBytes>this.maxFileBytes)throw new Error("ATTACHMENT_METADATA_INVALID");
    const objects=await this.directory("objects");
    const path=join(objects,upload.versionId);
    let file;
    try{file=await this.openFile(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
    catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")throw new Error("ATTACHMENT_OBJECT_NOT_FOUND");throw new Error("ATTACHMENT_UNAVAILABLE");}
    let bytes:Buffer;
    try{
      const info=await file.stat();
      if(!info.isFile()||info.size!==upload.declaredSizeBytes)throw new Error("ATTACHMENT_INTEGRITY_FAILED");
      bytes=Buffer.alloc(info.size);let offset=0;
      while(offset<bytes.length){const read=await file.read(bytes,offset,bytes.length-offset,offset);if(!read.bytesRead)throw new Error("ATTACHMENT_INTEGRITY_FAILED");offset+=read.bytesRead;}
      if((await file.read(Buffer.alloc(1),0,1,offset)).bytesRead)throw new Error("ATTACHMENT_INTEGRITY_FAILED");
    }finally{await file.close();}
    const mediaType=detect(bytes),sha256=createHash("sha256").update(bytes).digest("hex");
    if(mediaType!==upload.declaredMediaType||(upload.expectedSha256!==undefined&&sha256!==upload.expectedSha256))throw new Error("ATTACHMENT_INTEGRITY_FAILED");
    await validateContent(bytes);
    const directory=await this.openFile(objects,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{await directory.sync();}finally{await directory.close();}
    return {versionId:upload.versionId,mediaType,sizeBytes:bytes.length,sha256};
  }

  private async readPathVerified(path: string, expected: StoredAttachment): Promise<Buffer> {
    let file;
    try { file = await this.openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch { throw new Error("ATTACHMENT_UNAVAILABLE"); }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size !== expected.sizeBytes) throw new Error("ATTACHMENT_INTEGRITY_FAILED");
      // Fixed allocation keeps a concurrently enlarged file from exhausting memory.
      const bytes = Buffer.alloc(expected.sizeBytes);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await file.read(bytes, offset, bytes.length - offset, offset);
        if (read.bytesRead === 0) throw new Error("ATTACHMENT_INTEGRITY_FAILED");
        offset += read.bytesRead;
      }
      const extra = Buffer.alloc(1);
      if ((await file.read(extra, 0, 1, offset)).bytesRead !== 0
        || createHash("sha256").update(bytes).digest("hex") !== expected.sha256
        || detect(bytes) !== expected.mediaType) throw new Error("ATTACHMENT_INTEGRITY_FAILED");
      return bytes;
    } finally { await file.close(); }
  }
}
