import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fixture } from "../../../api/test/integration/refund-review-fixture.mjs";
import { FullBackupDerivedSpoolIndex } from "../../dist/full-backup-derived-spool-index.js";
import { FullBackupIncomeDerivedView } from "../../dist/full-backup-income-derived-view.js";
import { FullBackupIncomeWorkbook } from "../../dist/full-backup-income-workbook.js";
import { FullBackupSpool } from "../../dist/full-backup-spool.js";
import { FullBackupTransformer } from "../../dist/full-backup-transformer.js";
import { PostgresFullBackupSource } from "../../dist/postgres-full-backup-source.js";
const hash = (value) => createHash("sha256").update(value).digest("hex");
test("real PostgreSQL derived income workbook keeps snapshot/account identity and exact-text XLSX", async () => {
  const f = await fixture();
  const root = await mkdtemp(join(tmpdir(), "income-workbook-pg-"));
  let index, view;
  try {
    const spool = await new FullBackupSpool({
      source: new PostgresFullBackupSource(f.pool),
      transformer: new FullBackupTransformer({
        fingerprint: ({ domain, value }) => hash(`${domain}\0${value}`),
      }),
      tempRoot: join(root, "spool"),
      batchSize: 1,
    }).create();
    index = await FullBackupDerivedSpoolIndex.create({
      spoolDirectory: join(root, "spool", spool.spoolId),
      spool,
      attemptRoot: join(root, "index"),
    });
    view = await FullBackupIncomeDerivedView.create({
      index,
      attemptRoot: join(root, "view"),
    });
    const result = await new FullBackupIncomeWorkbook({
      index,
      view,
      outputRoot: join(root, "out"),
      maxDataRows: 1,
    }).export();
    assert.equal(result.complete, false);
    assert.equal(result.spoolId, spool.spoolId);
    assert.equal(result.status, "DERIVED_UNPUBLISHED");
    const dir = join(root, "out", result.outputId),
      bytes = await readFile(join(dir, result.file));
    assert.equal(result.sha256, hash(bytes));
    assert.deepEqual(await readdir(dir), [result.file]);
    assert.equal(bytes.subarray(0, 2).toString(), "PK");
    assert.equal(result.monthlyRowCount !== "0", true);
    assert.equal(result.contributionRowCount !== "0", true);
  } finally {
    await view?.close().catch(() => undefined);
    await index?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await f.close();
  }
});
