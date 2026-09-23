import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createTestDatabase } from '../../../api/test/integration/postgres-test-database.mjs';
import { PostgresFullBackupSource } from '../../dist/postgres-full-backup-source.js';
import { FullBackupTransformer } from '../../dist/full-backup-transformer.js';
import { FullBackupSpool } from '../../dist/full-backup-spool.js';
import { FullBackupWorkbookExporter } from '../../dist/full-backup-workbook-exporter.js';

test('actual PostgreSQL snapshot produces fixed raw workbooks without private index leftovers', async () => {
  const database = await createTestDatabase(process.env.DATABASE_URL);
  const directory = await mkdtemp(join(tmpdir(), 'alliance-workbooks-pg-'));
  try {
    await database.pool.query("INSERT INTO person(nickname,legal_name,status,created_at,updated_at) VALUES('000001老师','合成老师','ACTIVE',now(),now())");
    const spool = await new FullBackupSpool({
      source: new PostgresFullBackupSource(database.pool),
      transformer: new FullBackupTransformer({ fingerprint: ({ domain, value }) => createHash('sha256').update(domain + ':' + value).digest('hex') }),
      tempRoot: directory,
      batchSize: 1,
    }).create();
    const result = await new FullBackupWorkbookExporter({ spoolDirectory: join(directory, spool.spoolId), spool, outputRoot: directory }).export();
    assert.equal(result.mode, 'RAW_SOURCE_WORKBOOKS');
    assert.equal(result.snapshotId, spool.snapshotId);
    assert.equal(result.asOf, spool.asOf);
    assert.equal(result.workbooks.length, 12);
    assert.equal(result.workbooks.reduce((sum, book) => sum + Number(book.datasetCount), 0), 77);
    assert.equal(result.coverageGaps.length, 4);
    assert.deepEqual((await readdir(join(directory, result.outputId))).sort(), result.workbooks.map(book => book.file).sort());
    for (const book of result.workbooks) {
      const metadata = await stat(join(directory, result.outputId, book.file));
      assert.ok(metadata.size > 0);
      assert.equal(metadata.mode & 0o077, 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
    await database.close();
  }
});
