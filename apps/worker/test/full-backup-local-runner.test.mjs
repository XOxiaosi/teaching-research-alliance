import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FullBackupLocalRunner } from "../dist/full-backup-local-runner.js";

const options = (attemptRoot, packageRoot, onConnect) => ({
  attemptRoot,
  packageRoot,
  applicationVersion: "0.1.0",
  generatorVersion: "runner-unit",
  pool: {
    async connect() {
      onConnect();
      throw new Error("UNIT_POOL_MUST_NOT_CONNECT");
    },
  },
  transformer: {},
  readVerifiedAttachment: async () => Buffer.alloc(0),
});

test("rejects equal and nested local roots before opening the caller pool", async () => {
  const root = await mkdtemp(join(tmpdir(), "full-backup-runner-unit-"));
  try {
    for (const [attemptRoot, packageRoot] of [
      [root, root],
      [root, join(root, "packages")],
      [join(root, "attempts"), root],
    ]) {
      let connected = false;
      await assert.rejects(
        new FullBackupLocalRunner(
          options(attemptRoot, packageRoot, () => {
            connected = true;
          }),
        ).run(),
        /EXPORT_LOCAL_RUNNER_ROOTS_OVERLAP/,
      );
      assert.equal(connected, false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
