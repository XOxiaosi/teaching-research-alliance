import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertPrivateBackupDirectory, copyVerifiedBackupFile, hashBackupFile, openPrivateBackupFile, syncBackupDirectory, writeBackupBytes } from "../dist/backup-file-io.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "backup-io-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "source");
  const destinationRoot = join(root, "destination");
  await mkdir(sourceRoot, { mode: 0o700 });
  await mkdir(destinationRoot, { mode: 0o700 });
  return { root, sourceRoot, destinationRoot, sourcePath: "source.pdf", destinationPath: "copy.pdf" };
}
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("backup IO copies a multi-chunk file, verifies bytes and retains no absolute metadata", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(200_000, 97)]);
  await writeFile(join(f.sourceRoot, f.sourcePath), bytes, { mode: 0o600 });
  const result = await copyVerifiedBackupFile({ ...f, expectedBytes: BigInt(bytes.length), expectedSha256: sha(bytes), expectedMediaType: "application/pdf" });
  assert.deepEqual(result, { path: "copy.pdf", sizeBytes: String(bytes.length), sha256: sha(bytes) });
  assert.deepEqual(await readFile(join(f.destinationRoot, "copy.pdf")), bytes);
  assert.equal((await stat(join(f.destinationRoot, "copy.pdf"))).mode & 0o777, 0o600);
  assert.deepEqual(await hashBackupFile(f.destinationRoot, "copy.pdf"), { sizeBytes: String(bytes.length), sha256: sha(bytes) });
  await syncBackupDirectory(f.destinationRoot);
});

test("backup IO rejects traversal, symlinks, directories and public file/directory permissions", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.sourceRoot, f.sourcePath), "data", { mode: 0o600 });
  for (const path of ["../source/source.pdf", "/source.pdf", "a//b", "a/./b", "a/../b", "a\\b", ""]) {
    await assert.rejects(openPrivateBackupFile(f.sourceRoot, path));
  }
  await symlink(join(f.sourceRoot, f.sourcePath), join(f.sourceRoot, "link.pdf"));
  await assert.rejects(openPrivateBackupFile(f.sourceRoot, "link.pdf"));
  await symlink(f.sourceRoot, join(f.root, "alias"));
  await assert.rejects(assertPrivateBackupDirectory(join(f.root, "alias")));
  await symlink(f.sourceRoot, join(f.sourceRoot, "alias"));
  await assert.rejects(openPrivateBackupFile(f.sourceRoot, "alias/source.pdf"));
  await mkdir(join(f.sourceRoot, "directory"), { mode: 0o700 });
  await assert.rejects(openPrivateBackupFile(f.sourceRoot, "directory"));
  await chmod(join(f.sourceRoot, f.sourcePath), 0o644);
  await assert.rejects(openPrivateBackupFile(f.sourceRoot, f.sourcePath));
  await chmod(f.sourceRoot, 0o755);
  await assert.rejects(assertPrivateBackupDirectory(f.sourceRoot));
});

test("backup IO mismatch removes only the new destination and never replaces existing content", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.sourceRoot, f.sourcePath), "%PDF-1.7\n", { mode: 0o600 });
  for (const expectation of [{ expectedBytes: 1n }, { expectedSha256: "0".repeat(64) }, { expectedMediaType: "image/png" }]) {
    await assert.rejects(copyVerifiedBackupFile({ ...f, ...expectation }));
    assert.deepEqual(await readdir(f.destinationRoot), []);
  }
  await writeFile(join(f.destinationRoot, f.destinationPath), "existing", { mode: 0o600 });
  await assert.rejects(copyVerifiedBackupFile(f));
  assert.equal(await readFile(join(f.destinationRoot, f.destinationPath), "utf8"), "existing");
});

test("backup IO handles positive short writes and rejects zero progress", async () => {
  const received = [];
  await writeBackupBytes({ write: async (bytes, offset, length) => {
    const take = Math.min(3, length);
    received.push(Buffer.from(bytes.subarray(offset, offset + take)));
    return { bytesWritten: take };
  } }, Buffer.from("abcdefghij"));
  assert.equal(Buffer.concat(received).toString(), "abcdefghij");
  await assert.rejects(writeBackupBytes({ write: async () => ({ bytesWritten: 0 }) }, Buffer.from("x")));
});

test("backup IO closes handles and removes new output on destination fsync failure", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.sourceRoot, f.sourcePath), "%PDF-1.7\n", { mode: 0o600 });
  const probe = await open(join(f.sourceRoot, f.sourcePath));
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalSync = prototype.sync;
  const originalRead = prototype.read;
  const handles = new Set();
  prototype.sync = async function () { handles.add(this); throw new Error("injected-fsync"); };
  prototype.read = async function (...args) { handles.add(this); return originalRead.apply(this, args); };
  try {
    await assert.rejects(copyVerifiedBackupFile(f), /injected-fsync/);
    assert.equal(handles.size, 2);
    for (const handle of handles) await assert.rejects(handle.stat(), { code: "EBADF" });
    assert.deepEqual(await readdir(f.destinationRoot), []);
  } finally { prototype.sync = originalSync; prototype.read = originalRead; }
});

test("backup IO detects a source changed during its opened-handle read", async (t) => {
  const f = await fixture(t);
  const source = join(f.sourceRoot, f.sourcePath);
  await writeFile(source, Buffer.alloc(150_000, 65), { mode: 0o600 });
  const probe = await open(source);
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalRead = prototype.read;
  let mutated = false;
  prototype.read = async function (...args) {
    const result = await originalRead.apply(this, args);
    if (!mutated && result.bytesRead > 0) { mutated = true; await writeFile(source, "changed"); }
    return result;
  };
  try {
    await assert.rejects(copyVerifiedBackupFile(f), /BACKUP_FILE_INVALID/);
    assert.deepEqual(await readdir(f.destinationRoot), []);
  } finally { prototype.read = originalRead; }
});

test("backup IO surfaces cleanup failure together with the original failure", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.sourceRoot, f.sourcePath), "%PDF-1.7\n", { mode: 0o600 });
  const probe = await open(join(f.sourceRoot, f.sourcePath));
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalSync = prototype.sync;
  const primary = new Error("injected-primary");
  prototype.sync = async function () {
    await rm(join(f.destinationRoot, f.destinationPath));
    await mkdir(join(f.destinationRoot, f.destinationPath), { mode: 0o700 });
    throw primary;
  };
  try {
    await assert.rejects(copyVerifiedBackupFile(f), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, "BACKUP_FILE_CLEANUP_FAILED");
      assert.equal(error.cause, primary);
      assert.equal(error.errors[0], primary);
      assert.equal(error.errors.length, 2);
      assert.ok(error.errors[1].code);
      return true;
    });
  } finally { prototype.sync = originalSync; }
});
