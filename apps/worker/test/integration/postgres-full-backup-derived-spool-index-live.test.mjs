import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestDatabase } from "../../../api/test/integration/postgres-test-database.mjs";
import { FullBackupDerivedSpoolIndex } from "../../dist/full-backup-derived-spool-index.js";
import { FullBackupSpool } from "../../dist/full-backup-spool.js";
import { readBackupSpoolDataset } from "../../dist/full-backup-spool-reader.js";
import { FullBackupTransformer } from "../../dist/full-backup-transformer.js";
import { PostgresFullBackupSource } from "../../dist/postgres-full-backup-source.js";

const sha = (value) => createHash("sha256").update(value).digest("hex");

test("real PostgreSQL RAW spool becomes a bounded derived index without reading secrets", async () => {
  const database = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-derived-spool-index-pg-"));
  let index;
  try {
    const firstId = randomUUID();
    const secondId = randomUUID();
    const at = "2026-09-23T00:00:00.000Z";
    await database.pool.query(
      "INSERT INTO person(id,nickname,legal_name,status,created_at,updated_at) VALUES($1::uuid,'000前导零','索引甲','INACTIVE',$3::timestamptz,$3::timestamptz),($2::uuid,'','索引乙','ACTIVE',$3::timestamptz,$3::timestamptz)",
      [firstId, secondId, at],
    );
    const spool = await new FullBackupSpool({
      source: new PostgresFullBackupSource(database.pool),
      transformer: new FullBackupTransformer({ fingerprint: ({ domain, value }) => sha(`${domain}\u0000${value}`) }),
      tempRoot: join(root, "spool"),
      batchSize: 1,
    }).create();
    const spoolDirectory = join(root, "spool", spool.spoolId);
    const personDataset = spool.datasets.find((dataset) => dataset.tableName === "person");
    assert.ok(personDataset && !personDataset.excluded);
    const expected = [];
    for await (const values of readBackupSpoolDataset(spoolDirectory, personDataset)) expected.push(values);
    assert.equal(expected.length, 2);

    const attemptRoot = join(root, "attempts");
    index = await FullBackupDerivedSpoolIndex.create({ spoolDirectory, spool, attemptRoot });
    assert.equal(index.metadata().sources.find((source) => source.tableName === "person")?.rowCount, "2");
    assert.equal(index.metadata().sources.some((source) => source.tableName === "user_session"), false);
    assert.equal(JSON.stringify(index.metadata()).includes(root), false);

    const rows = [];
    for await (const row of index.stream("person")) rows.push(row);
    assert.deepEqual(rows.map((row) => row.values), expected);
    assert.deepEqual(rows.map((row) => row.ordinal), ["1", "2"]);
    const idPosition = personDataset.columns.indexOf("id");
    assert.ok(idPosition >= 0);
    const targetId = expected[1][idPosition];
    assert.equal(typeof targetId, "string");
    assert.deepEqual(await index.lookup("person", [["id", targetId]]), rows[1]);

    await index.close();
    assert.deepEqual(await readdir(attemptRoot), []);
  } finally {
    await index?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await database.close();
  }
});
