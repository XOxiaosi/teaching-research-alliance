import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createTestDatabase } from "../../../api/test/integration/postgres-test-database.mjs";
import { FullBackupSpool } from "../../dist/full-backup-spool.js";
import { FullBackupTransformer } from "../../dist/full-backup-transformer.js";
import { PostgresFullBackupSource } from "../../dist/postgres-full-backup-source.js";
import { readBackupSpoolDataset } from "../../dist/full-backup-spool-reader.js";

const connectionString = process.env.DATABASE_URL;

test("真实79表只读快照可流式spool，秘密会话表不计数不读取", async () => {
  const database = await createTestDatabase(connectionString);
  const tempRoot = await mkdtemp(join(tmpdir(), "alliance-spool-pg-"));
  try {
    await database.pool.query(
      "INSERT INTO person(nickname,legal_name,status,created_at,updated_at) VALUES('spool老师','spool老师','ACTIVE',now(),now())",
    );
    const spool = await new FullBackupSpool({
      source: new PostgresFullBackupSource(database.pool),
      transformer: new FullBackupTransformer({
        fingerprint: ({ domain, value }) => createHash("sha256").update(`${domain}\u0000${value}`).digest("hex"),
      }),
      tempRoot,
      batchSize: 1,
    }).create();
    assert.equal(spool.mode, "RAW_SOURCE_SPOOL");
    assert.equal(spool.datasets.length, 79);
    const session = spool.datasets.find((dataset) => dataset.tableName === "user_session");
    assert.deepEqual(session, {
      tableName: "user_session", columns: [], rowCount: null, logicalDigest: null, spoolFile: null, excluded: true,
    });
    const people = spool.datasets.find((dataset) => dataset.tableName === "person");
    assert.equal(people.rowCount, "1");
    const text = await readFile(join(tempRoot, spool.spoolId, people.spoolFile), "utf8");
    assert.equal(text.includes("spool老师"), true);
    assert.equal(text.split("\n").length, 3, "header plus one data row");
    for (const dataset of spool.datasets) {
      if (dataset.excluded) continue;
      let count = 0n;
      for await (const row of readBackupSpoolDataset(join(tempRoot, spool.spoolId), dataset)) {
        assert.equal(row.length, dataset.columns.length);
        count += 1n;
      }
      assert.equal(count.toString(), dataset.rowCount);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await database.close();
  }
});
