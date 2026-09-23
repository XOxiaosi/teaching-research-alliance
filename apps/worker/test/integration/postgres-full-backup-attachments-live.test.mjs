import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTestDatabase } from '../../../api/test/integration/postgres-test-database.mjs';
import { LocalAttachmentStore } from '../../../api/dist/local-attachment-store.js';
import { PostgresFinanceAttachmentService } from '../../../api/dist/postgres-finance-attachment-service.js';
import { PostgresFinanceAttachmentUploadService } from '../../../api/dist/postgres-finance-attachment-upload-service.js';
import { PostgresFullBackupSource } from '../../dist/postgres-full-backup-source.js';
import { FullBackupTransformer } from '../../dist/full-backup-transformer.js';
import { FullBackupSpool } from '../../dist/full-backup-spool.js';
import { FullBackupAttachmentExporter } from '../../dist/full-backup-attachment-exporter.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4AWP8DwQMQMDEAAUAPfgEADYYS7QAAAAASUVORK5CYII=', 'base64');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
test('attachment backup keeps READY history and ignores uploads completed after the source snapshot', async () => {
  const database = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), 'alliance-backup-attachment-pg-'));
  try {
    const { pool } = database;
    const personId = randomUUID(), documentId = randomUUID();
    const at = new Date('2026-09-23T00:00:00Z');
    await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES ($1::uuid,'backup-owner','合成用户','ACTIVE')", [personId]);
    await pool.query("INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at) VALUES ($1::uuid,$2::uuid,'REIMBURSEMENT','DRAFT',1,$3::timestamptz,$3::timestamptz)", [documentId, personId, at.toISOString()]);
    const store = await LocalAttachmentStore.create(join(root, 'store'), resolve(import.meta.dirname, '../../../..'));
    const reserve = new PostgresFinanceAttachmentService(pool);
    const uploader = new PostgresFinanceAttachmentUploadService(pool, store);
    const context = { personId, subject: 'TEACHING_TEACHER', scope: 'SELF' };
    const create = key => reserve.reserve(context, documentId, { purpose: 'SUPPORTING_DOCUMENT', originalFilename: key + '.png', declaredMediaType: 'image/png', declaredSizeBytes: png.length, expectedSha256: sha(png) }, key, at);
    const upload = version => uploader.upload(context, version.versionId, (async function* () { yield png; })(), at);
    const first = await create('first'); await upload(first);
    const second = await reserve.reserveNextVersion(context, first.attachmentId, { originalFilename: 'second.png', declaredMediaType: 'image/png', declaredSizeBytes: png.length, expectedSha256: sha(png) }, 'second', at);
    await upload(second);
    assert.equal(second.attachmentId, first.attachmentId);
    assert.equal(second.versionNo, 2);
    const pending = await create('pending');
    const spool = await new FullBackupSpool({
      source: new PostgresFullBackupSource(pool),
      transformer: new FullBackupTransformer({ fingerprint: ({ domain, value }) => sha(domain + ':' + value) }),
      tempRoot: join(root, 'spools'), batchSize: 1,
    }).create();
    await upload(pending);
    const later = await create('later'); await upload(later);
    const reads = [];
    const result = await new FullBackupAttachmentExporter({
      spoolDirectory: join(root, 'spools', spool.spoolId), spool, outputRoot: join(root, 'outputs'),
      readVerified: expected => { reads.push(expected.versionId); return store.readVerified(expected); },
    }).export();
    assert.equal(result.readyCount, '2');
    assert.equal(result.unreadyCount, '1');
    assert.deepEqual(reads.sort(), [first.versionId, second.versionId].sort());
    const indexBytes = await readFile(join(root, 'outputs', result.outputId, result.indexFile));
    assert.equal(sha(indexBytes), result.indexSha256);
    const records = indexBytes.toString().trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 3);
    const snapshotPending = records.find(row => row.id === pending.versionId);
    assert.equal(snapshotPending.status, 'UPLOADING');
    assert.equal(snapshotPending.backup_file, null);
    assert.equal(records.some(row => row.id === later.versionId), false);
    for (const record of records.filter(row => row.status === 'READY')) {
      assert.deepEqual(await readFile(join(root, 'outputs', result.outputId, record.backup_file)), png);
    }
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
