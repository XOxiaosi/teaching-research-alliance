import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTestDatabase } from '../../../api/test/integration/postgres-test-database.mjs';
import { PostgresAccountAccessService } from '../../../api/dist/main.js';
import { LocalAttachmentStore } from '../../../api/dist/local-attachment-store.js';
import { PostgresFinanceAttachmentService } from '../../../api/dist/postgres-finance-attachment-service.js';
import { PostgresFinanceAttachmentUploadService } from '../../../api/dist/postgres-finance-attachment-upload-service.js';
import { PostgresFullBackupSource } from '../../dist/postgres-full-backup-source.js';
import { FullBackupTransformer } from '../../dist/full-backup-transformer.js';
import { FullBackupSpool } from '../../dist/full-backup-spool.js';
import { FullBackupWorkbookExporter } from '../../dist/full-backup-workbook-exporter.js';
import { FullBackupLocalPackageAssembler } from '../../dist/full-backup-local-package-assembler.js';
import { FullBackupAttachmentExporter } from '../../dist/full-backup-attachment-exporter.js';
import { FullBackupBusinessFactsView } from '../../dist/full-backup-business-facts-view.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4AWP8DwQMQMDEAAUAPfgEADYYS7QAAAAASUVORK5CYII=', 'base64');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
test('raw local package verifies PostgreSQL snapshot workbooks and historical attachment bytes', async () => {
  const database = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), 'alliance-backup-attachment-pg-'));
  try {
    const { pool } = database;
    const personId = randomUUID(), ownerId = randomUUID(), documentId = randomUUID();
    const at = new Date('2026-09-23T00:00:00Z');
    await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES ($1::uuid,'000001老师','合成用户','ACTIVE')", [personId]);
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
    await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES ($1::uuid,'备份管理员','备份管理员','ACTIVE')", [ownerId]);
    await pool.query("INSERT INTO user_account(person_id,phone_normalized,password_hash,login_status) VALUES($1,'13900009999','synthetic','ACTIVE')", [ownerId]);
    await pool.query("INSERT INTO role_assignment(person_id,subject_code,scope_type,valid_from,created_by) VALUES($1,'SYSTEM_OWNER','GLOBAL',$2,$1)", [ownerId, at.toISOString()]);
    await upload(pending);
    const later = await create('later'); await upload(later);
    await new PostgresAccountAccessService(pool).updatePersonProfile(
      { personId: ownerId, subject: 'SYSTEM_OWNER', scope: 'GLOBAL' },
      personId, 'changed-after-snapshot', '更正后姓名', '1', '快照后正式资料更正', 'local-package-profile-change', at,
    );
    const facts = new FullBackupBusinessFactsView({ spoolDirectory: join(root, 'spools', spool.spoolId), spool });
    const describe = facts.describe(1);
    assert.equal(describe.snapshotId, spool.snapshotId);
    assert.equal(describe.asOf, spool.asOf);
    assert.equal(describe.complete, false);
    assert.equal(JSON.stringify(describe).includes(root), false);
    const peopleSource = describe.sources.find(source => source.sourceTable === 'person');
    assert.ok(peopleSource);
    const people = [];
    for await (const row of facts.readSourceRows(1, 'person')) people.push(row);
    assert.equal(people.length, 1);
    assert.equal(people[0].sourceRecordKey, JSON.stringify([['id', personId]]));
    assert.equal(people[0].values[peopleSource.columns.findIndex(column => column.sourceColumn === 'nickname')], '000001老师');
    const attachmentSource = facts.describe(4).sources.find(source => source.sourceTable === 'finance_attachment_version');
    assert.ok(attachmentSource);
    const attachmentFacts = [];
    for await (const row of facts.readSourceRows(4, 'finance_attachment_version')) {
      attachmentFacts.push(Object.fromEntries(attachmentSource.columns.map((column, index) => [column.sourceColumn, row.values[index]])));
      assert.equal(row.sourceRecordKey, JSON.stringify([['id', attachmentFacts.at(-1).id]]));
    }
    assert.equal(attachmentFacts.length, 3);
    assert.equal(attachmentFacts.find(row => row.id === pending.versionId).status, 'UPLOADING');
    assert.deepEqual(attachmentFacts.filter(row => row.status === 'READY').map(row => row.id).sort(), [first.versionId, second.versionId].sort());
    assert.equal(attachmentFacts.some(row => row.id === later.versionId), false);
    for (const table of [3, 7]) assert.throws(() => facts.describe(table), /EXPORT_BUSINESS_FACTS_DERIVED_REQUIRED/);
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
    const workbooks = await new FullBackupWorkbookExporter({
      spoolDirectory: join(root, 'spools', spool.spoolId), spool,
      outputRoot: join(root, 'workbooks'),
    }).export();
    const packaged = await new FullBackupLocalPackageAssembler({
      spoolDirectory: join(root, 'spools', spool.spoolId), spool,
      workbookDirectory: join(root, 'workbooks', workbooks.outputId), workbooks,
      attachmentDirectory: join(root, 'outputs', result.outputId), attachments: result,
      outputRoot: join(root, 'packages'),
    }).assemble();
    assert.equal(packaged.mode, 'RAW_SOURCE_PACKAGE');
    assert.equal(packaged.complete, false);
    assert.equal(packaged.snapshotId, spool.snapshotId);
    assert.equal(packaged.asOf, spool.asOf);
    const packageDirectory = join(root, 'packages', packaged.outputId);
    const packageIndexBytes = await readFile(join(packageDirectory, packaged.indexFile));
    assert.equal(sha(packageIndexBytes), packaged.indexSha256);
    const packageIndex = JSON.parse(packageIndexBytes);
    assert.equal(packageIndex.complete, false);
    assert.equal(packageIndex.files.length, 17);
    let totalBytes = 0n;
    for (const file of packageIndex.files) {
      assert.ok(!file.path.startsWith('/') && !file.path.includes('..'));
      const bytes = await readFile(join(packageDirectory, file.path));
      assert.equal(String(bytes.length), file.sizeBytes);
      assert.equal(sha(bytes), file.sha256);
      if (file.path.startsWith('workbooks/')) {
        const produced = workbooks.workbooks.find(book => file.path === `workbooks/${book.file}`);
        assert.ok(produced);
        assert.equal(file.sizeBytes, produced.sizeBytes);
        assert.equal(file.sha256, produced.sha256);
      }
      totalBytes += BigInt(bytes.length);
    }
    assert.equal(String(totalBytes), packaged.totalBytes);
    assert.equal(packaged.payloadFileCount, '17');
    assert.equal(packageIndex.files.filter(file => file.path.endsWith('.xlsx')).length, 13);
    assert.equal(packageIndex.files.filter(file => file.path.startsWith('attachments/')).length, 2);
    assert.equal(packageIndexBytes.includes(Buffer.from(root)), false);
    assert.equal(packageIndexBytes.includes(Buffer.from('package-manifest.json')), false);

  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
