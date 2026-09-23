import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fixture } from "../../../api/test/integration/refund-review-fixture.mjs";
import { FullBackupDerivedSpoolIndex } from "../../dist/full-backup-derived-spool-index.js";
import {
  FullBackupLocalRunner,
  FullBackupLocalRunnerPublishedCleanupError,
} from "../../dist/full-backup-local-runner.js";
import { FullBackupTransformer } from "../../dist/full-backup-transformer.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");

const assertPackageFiles = async (directory, manifest) => {
  let total = 0n;
  for (const file of manifest.files) {
    const bytes = await readFile(join(directory, file.path));
    assert.equal(hash(bytes), file.sha256, file.path);
    assert.equal(String(bytes.length), file.sizeBytes, file.path);
    total += BigInt(file.sizeBytes);
  }
  assert.equal(total.toString(), manifest.payloadBytes);
  assert.equal(manifest.files.length, Number(manifest.payloadFileCount));
};

const assertCallerPoolOpen = async (pool) => {
  const result = await pool.query("SELECT 1 AS value");
  assert.equal(result.rows[0].value, 1);
};

test("real PG local runner publishes one incomplete package and cleans a later failed attempt", async () => {
  const f = await fixture();
  const root = await mkdtemp(join(tmpdir(), "full-backup-local-runner-pg-"));
  const attemptRoot = join(root, "attempts");
  const packageRoot = join(root, "packages");
  const transformer = new FullBackupTransformer({
    fingerprint: ({ domain, value }) => hash(`${domain}\0${value}`),
  });
  try {
    const refund = await f.pending();
    await f.approve(refund, "local-runner-refund-approval");
    const run = await new FullBackupLocalRunner({
      pool: f.pool,
      transformer,
      readVerifiedAttachment: (expected) => f.store.readVerified(expected),
      attemptRoot,
      packageRoot,
      applicationVersion: "0.1.0",
      generatorVersion: "runner-pg",
    }).run();

    assert.equal(run.mode, "LOCAL_FULL_BACKUP_RUN");
    assert.equal(run.complete, false);
    assert.equal(run.backupStatus, "INCOMPLETE_IMPLEMENTATION");
    assert.equal(run.publication, "LOCAL_PACKAGE_PUBLISHED");
    assert.equal(run.localPackage.complete, false);
    assert.equal(run.localPackage.readyAttachmentCount, "2");
    assert.equal(run.localPackage.packageManifest?.path, "package-manifest.json");
    assert.deepEqual(await readdir(attemptRoot), []);

    const packageDirectory = join(packageRoot, run.localPackage.outputId);
    const manifestBytes = await readFile(join(packageDirectory, "package-manifest.json"));
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.complete, false);
    assert.equal(manifest.backupStatus, "INCOMPLETE_IMPLEMENTATION");
    assert.equal(manifest.context.fileGroupId, run.fileGroupId);
    assert.equal(manifest.context.spoolId, run.spoolId);
    assert.equal(manifest.context.snapshotId, run.snapshotId);
    assert.equal(manifest.context.asOf, run.asOf);
    assert.equal(manifest.context.backupId, null);
    assert.equal(manifest.context.exportJobId, null);
    assert.equal(manifest.context.scheduleId, null);
    assert.equal(manifest.context.requestedBy, null);
    assert.equal(manifest.workbookCount, "20");
    assert.equal(manifest.files.some((file) => file.path === "package-manifest.json"), false);
    assert.equal(manifest.files.filter((file) => file.path.endsWith(".xlsx")).length, 20);
    assert.equal(hash(manifestBytes), run.localPackage.packageManifest.sha256);
    await assertPackageFiles(packageDirectory, manifest);
    await assertCallerPoolOpen(f.pool);

    const beforeNames = await readdir(packageRoot);
    const beforeManifest = Buffer.from(manifestBytes);
    await assert.rejects(
      new FullBackupLocalRunner({
        pool: f.pool,
        transformer,
        readVerifiedAttachment: async () => {
          throw new Error("INJECTED_ATTACHMENT_READER_FAILURE");
        },
        attemptRoot,
        packageRoot,
        applicationVersion: "0.1.0",
        generatorVersion: "runner-pg",
      }).run(),
      /INJECTED_ATTACHMENT_READER_FAILURE/,
    );
    assert.deepEqual(await readdir(packageRoot), beforeNames);
    assert.deepEqual(
      await readFile(join(packageDirectory, "package-manifest.json")),
      beforeManifest,
    );
    await assertPackageFiles(packageDirectory, JSON.parse(beforeManifest));
    assert.deepEqual(await readdir(attemptRoot), []);
    await assertCallerPoolOpen(f.pool);

    const originalClose = FullBackupDerivedSpoolIndex.prototype.close;
    let recoveredPackage;
    try {
      FullBackupDerivedSpoolIndex.prototype.close = async function() {
        await originalClose.call(this);
        throw new Error("INJECTED_INDEX_CLOSE_FAILURE");
      };
      await assert.rejects(
        new FullBackupLocalRunner({
          pool: f.pool,
          transformer,
          readVerifiedAttachment: (expected) => f.store.readVerified(expected),
          attemptRoot,
          packageRoot,
          applicationVersion: "0.1.0",
          generatorVersion: "runner-pg",
        }).run(),
        (error) => {
          assert.ok(error instanceof FullBackupLocalRunnerPublishedCleanupError);
          assert.equal(error.message, "EXPORT_LOCAL_RUNNER_PUBLISHED_CLEANUP_FAILED");
          assert.equal(error.localPackage.complete, false);
          recoveredPackage = error.localPackage;
          return true;
        },
      );
    } finally {
      FullBackupDerivedSpoolIndex.prototype.close = originalClose;
    }
    assert.ok(recoveredPackage);
    assert.ok((await readdir(packageRoot)).includes(recoveredPackage.outputId));
    assert.ok(
      await readFile(
        join(packageRoot, recoveredPackage.outputId, "package-manifest.json"),
      ),
    );
    const recoveredManifest = JSON.parse(
      await readFile(
        join(packageRoot, recoveredPackage.outputId, "package-manifest.json"),
      ),
    );
    await assertPackageFiles(
      join(packageRoot, recoveredPackage.outputId),
      recoveredManifest,
    );
    assert.deepEqual(await readdir(attemptRoot), []);
    await assertCallerPoolOpen(f.pool);
  } finally {
    await rm(root, { recursive: true, force: true });
    await f.close();
  }
});
