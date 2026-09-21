import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { createApiServer, SessionService, PostgresFinanceDraftService, PostgresFinanceAttachmentService,
  PostgresFinanceAttachmentUploadService, PostgresFinanceAttachmentReadService, LocalAttachmentStore } from '../../dist/main.js';
import { createTestDatabase } from './postgres-test-database.mjs';

test('真实 HTTP/数据库/原件闭环：草稿预留、上传、本人下载、重试与损坏审计', async () => {
  const db=await createTestDatabase(process.env.DATABASE_URL);
  const root=await mkdtemp(join(tmpdir(),'alliance-attachment-http-'));
  const at=new Date('2026-09-21T04:00:00Z');
  const people=[randomUUID(),randomUUID()];
  let server;
  try {
    for(const id of people) await db.pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES ($1,$2,'合成老师','ACTIVE')",[id,`attachment-http-${id}`]);
    let count=0;
    const sessions=new SessionService({accounts:people.map((id,index)=>({accountId:id,personId:id,phoneNormalized:`1380000000${index}`,credentialDigest:'synthetic-only',status:'ACTIVE'})),assignments:people.map(personId=>({personId,subject:'TEACHING_TEACHER',scope:'SELF',validFrom:new Date('2026-01-01')})),sessionIdFactory:()=>`attachment-token-${++count}`});
    for(let i=0;i<2;i++){sessions.login(`1380000000${i}`,'synthetic-only',at);sessions.switchRole(`attachment-token-${i+1}`,'TEACHING_TEACHER',at);}
    const store=await LocalAttachmentStore.create(root,fileURLToPath(new URL('../../../../',import.meta.url)));
    server=createApiServer({sessions,weeklyFees:{},financeDrafts:new PostgresFinanceDraftService(db.pool),financeAttachments:new PostgresFinanceAttachmentService(db.pool),financeAttachmentUploads:new PostgresFinanceAttachmentUploadService(db.pool,store),financeAttachmentReads:new PostgresFinanceAttachmentReadService(db.pool,store),now:()=>at});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const base=`http://127.0.0.1:${server.address().port}/v1/finance`;
    const headers={authorization:'Bearer attachment-token-1'};
    const json=async(path,body)=>{
      const response=await fetch(base+path,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
      assert.equal(response.status,200);return (await response.json()).data;
    };
    const draft=await json('/drafts',{kind:'REIMBURSEMENT',idempotencyKey:'http-original-draft'});
    const bytes=PNG.sync.write({width:2,height:2,data:Buffer.alloc(16,255)});
    const reserved=await json(`/drafts/${draft.id}/attachment-uploads`,{purpose:'INVOICE',originalFilename:'合成凭证.png',declaredMediaType:'image/png',declaredSizeBytes:bytes.length,expectedSha256:createHash('sha256').update(bytes).digest('hex'),idempotencyKey:'http-original-version'});
    const download=`${base}/attachments/${reserved.versionId}/content`;
    assert.equal((await fetch(download,{headers})).status,409);
    const upload=()=>fetch(`${base}/attachment-uploads/${reserved.versionId}/content`,{method:'POST',headers:{...headers,'content-type':'application/octet-stream'},body:bytes});
    const response=await upload();assert.equal(response.status,200);
    const ready=(await response.json()).data;assert.equal(ready.status,'READY');assert.equal(ready.replay,false);
    assert.equal((await (await upload()).json()).data.replay,true);
    const downloaded=await fetch(download,{headers});assert.equal(downloaded.status,200);
    assert.equal(downloaded.headers.get('content-type'),'image/png');
    assert.equal(downloaded.headers.get('cache-control'),'private, no-store');
    assert.equal(downloaded.headers.get('x-content-type-options'),'nosniff');
    assert.match(downloaded.headers.get('content-disposition'),/filename\*=UTF-8''%/);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),bytes);
    assert.equal((await fetch(download,{headers:{authorization:'Bearer attachment-token-2'}})).status,404);
    assert.equal((await fetch(download)).status,401);
    const corrupted=Buffer.from(bytes);corrupted[corrupted.length-1]^=1;
    await writeFile(join(root,'objects',reserved.versionId),corrupted);
    const damaged=await fetch(download,{headers});assert.equal(damaged.status,500);
    assert.equal((await damaged.json()).error.code,'ATTACHMENT_INTEGRITY_FAILED');
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM finance_attachment_event WHERE event_type='READY'")).rows[0].n,1);
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM audit_event WHERE action_code='ATTACHMENT_INTEGRITY_FAILED'")).rows[0].n,1);
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM ledger_event')).rows[0].n,0);
  } finally {
    if(server)await new Promise(resolve=>server.close(resolve));
    await db.close();await rm(root,{recursive:true,force:true});
  }
});
