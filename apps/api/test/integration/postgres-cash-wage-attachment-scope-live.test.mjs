import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { createTestDatabase } from './postgres-test-database.mjs';
import { LocalAttachmentStore, PostgresSalaryBenefitsService, PostgresFinanceAttachmentService, PostgresFinanceAttachmentUploadService, PostgresFinanceAttachmentReadService } from '../../dist/main.js';

test('同一财务人员切个人身份不能读取或修改本人经办的工资原件', async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const directory = await mkdtemp(join(tmpdir(), 'alliance-wage-attachment-scope-'));
  try {
    const personId = randomUUID();
    await db.pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,'合成兼任财务','合成人员','ACTIVE')", [personId]);
    const context = { personId, subject: 'HEADQUARTERS_FINANCE', scope: 'GLOBAL' };
    const personal = { personId, subject: 'TEACHING_TEACHER', scope: 'SELF' };
    const at = new Date('2026-09-23T00:00:00Z');
    const store = await LocalAttachmentStore.create(directory, resolve(import.meta.dirname, '../../../..'));
    const salary = new PostgresSalaryBenefitsService(db.pool, store);
    const attachments = new PostgresFinanceAttachmentService(db.pool);
    const uploads = new PostgresFinanceAttachmentUploadService(db.pool, store);
    const reads = new PostgresFinanceAttachmentReadService(db.pool, store);
    const doc = await salary.createEvidenceDocument(context, 'CASH_WAGE', 'scope-wage-doc', at);
    const bytes = PNG.sync.write({width:2,height:2,data:Buffer.alloc(16,120)});
    const draft = {purpose:'SUPPORTING_DOCUMENT',originalFilename:'合成工资单.png',declaredMediaType:'image/png',declaredSizeBytes:bytes.length,expectedSha256:createHash('sha256').update(bytes).digest('hex')};
    await assert.rejects(attachments.reserve(personal, doc.id, draft, 'personal-reserve', at), /FINANCE_ATTACHMENT_NOT_READY/);
    assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM finance_attachment')).rows[0].n, 0);
    const slot = await attachments.reserve(context, doc.id, draft, 'global-reserve', at);
    async function* content() { yield bytes; }
    await assert.rejects(uploads.upload(personal, slot.versionId, content(), at), /FINANCE_ATTACHMENT_NOT_READY/);
    await uploads.upload(context, slot.versionId, content(), at);
    assert.deepEqual((await reads.readOwn(context, slot.versionId, at)).bytes, bytes);
    assert.equal((await attachments.getOwnVersion(context, slot.versionId, at)).originalFilename, draft.originalFilename);
    assert.ok(await attachments.listDocument(context, doc.id, at));
    for (const role of [personal, {...personal,subject:'ACADEMIC_PLANNER'}, {...personal,subject:'PLANNING_MENTOR'}]) {
      await assert.rejects(reads.readOwn(role, slot.versionId, at), /FINANCE_ATTACHMENT_NOT_FOUND/);
      await assert.rejects(attachments.getOwnVersion(role, slot.versionId, at), /FINANCE_ATTACHMENT_NOT_FOUND/);
      await assert.rejects(attachments.listDocument(role, doc.id, at), /FINANCE_DOCUMENT_NOT_FOUND/);
    }
  } finally { await db.close(); await rm(directory, {recursive:true,force:true}); }
});
