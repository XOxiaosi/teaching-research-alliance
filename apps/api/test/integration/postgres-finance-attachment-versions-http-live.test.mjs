import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PNG} from 'pngjs';
import {createApiServer,SessionService,PostgresFinanceDraftService,PostgresFinanceAttachmentService,
  PostgresFinanceAttachmentUploadService,PostgresFinanceAttachmentReadService,LocalAttachmentStore} from '../../dist/main.js';
import {createTestDatabase} from './postgres-test-database.mjs';

test('附件版本真实HTTP：刷新恢复原预留、修订不覆盖、字段及本人范围受限',async()=>{
  const db=await createTestDatabase(process.env.DATABASE_URL);
  const root=await mkdtemp(join(tmpdir(),'alliance-version-http-'));
  const ids=[randomUUID(),randomUUID()];
  const at=new Date('2026-09-21T04:00:00Z');let server;
  try{
    for(const id of ids)await db.pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1,$2,'合成人员','ACTIVE')",[id,`version-http-${id}`]);
    let counter=0;
    const sessions=new SessionService({accounts:ids.map((id,index)=>({accountId:id,personId:id,phoneNormalized:`1390000000${index}`,credentialDigest:'synthetic-only',status:'ACTIVE'})),
      assignments:ids.map(personId=>({personId,subject:'TEACHING_TEACHER',scope:'SELF',validFrom:new Date('2026-01-01')})),sessionIdFactory:()=>`version-token-${++counter}`});
    ids.forEach((_,index)=>{
      sessions.login(`1390000000${index}`,'synthetic-only',at);
      sessions.switchRole(`version-token-${index+1}`,'TEACHING_TEACHER',at);
    });
    const store=await LocalAttachmentStore.create(root,fileURLToPath(new URL('../../../../',import.meta.url)));
    server=createApiServer({sessions,weeklyFees:{},financeDrafts:new PostgresFinanceDraftService(db.pool),financeAttachments:new PostgresFinanceAttachmentService(db.pool),
      financeAttachmentUploads:new PostgresFinanceAttachmentUploadService(db.pool,store),financeAttachmentReads:new PostgresFinanceAttachmentReadService(db.pool,store),now:()=>at});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const base=`http://127.0.0.1:${server.address().port}/v1/finance`;
    const request=(path,body,who=1)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer version-token-${who}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const success=async response=>{assert.equal(response.status,200,JSON.stringify(await response.clone().json()));return (await response.json()).data;};
    const doc=await success(await request('/drafts',{kind:'WITHDRAWAL',idempotencyKey:'version-draft'}));
    const listPath=`/documents/${doc.id}/attachments`;
    assert.deepEqual(await success(await request(listPath)),{documentId:doc.id,attachments:[]});
    const bytes=PNG.sync.write({width:2,height:2,data:Buffer.alloc(16,255)});
    const metadata={originalFilename:'合成证据.png',declaredMediaType:'image/png',declaredSizeBytes:bytes.length,expectedSha256:createHash('sha256').update(bytes).digest('hex')};
    const first=await success(await request(`/drafts/${doc.id}/attachment-uploads`,{...metadata,purpose:'SUPPORTING_DOCUMENT',idempotencyKey:'original-slot'}));
    const restored=await success(await request(listPath));
    assert.equal(restored.attachments[0].versions[0].versionId,first.versionId);
    assert.equal(restored.attachments[0].versions[0].status,'UPLOADING');
    const upload=(versionId,payload=bytes)=>fetch(`${base}/attachment-uploads/${versionId}/content`,{method:'POST',headers:{authorization:'Bearer version-token-1','content-type':'image/png'},body:payload});
    await success(await upload(restored.attachments[0].versions[0].versionId));
    const nextPath=`/attachments/${first.attachmentId}/versions`;
    const revisedBytes=PNG.sync.write({width:2,height:2,data:Buffer.alloc(16,128)});
    const nextCommand={...metadata,originalFilename:'修正版.png',declaredSizeBytes:revisedBytes.length,
      expectedSha256:createHash('sha256').update(revisedBytes).digest('hex'),idempotencyKey:'revision-2'};
    for(const forbidden of ['purpose','documentId','uploadedByPersonId','versionNo','personId']){
      assert.equal((await request(nextPath,{...nextCommand,[forbidden]:'forged'})).status,400);
    }
    assert.equal((await request(nextPath,nextCommand,2)).status,404);
    const next=await success(await request(nextPath,nextCommand));
    assert.equal(next.attachmentId,first.attachmentId);assert.equal(next.versionNo,2);assert.notEqual(next.versionId,first.versionId);
    assert.equal((await success(await request(nextPath,nextCommand))).versionId,next.versionId);
    assert.equal((await request(nextPath,{...nextCommand,originalFilename:'different.png'})).status,409);
    await success(await upload(next.versionId,revisedBytes));
    const listedResponse=await request(listPath);
    assert.equal(listedResponse.headers.get('cache-control'),'private, no-store');
    const listed=await success(listedResponse);
    assert.deepEqual(listed.attachments[0].versions.map(item=>[item.versionNo,item.status]),[[1,'READY'],[2,'READY']]);
    for(const [version,expected] of [[listed.attachments[0].versions[0],metadata],[listed.attachments[0].versions[1],nextCommand]]){
      for(const field of ['originalFilename','declaredMediaType','declaredSizeBytes','expectedSha256'])assert.equal(version[field],expected[field]);
    }
    assert.deepEqual(Object.keys(listed).sort(),['attachments','documentId']);
    for(const version of listed.attachments[0].versions){
      assert.equal('binding' in version,false);
      for(const hidden of ['storagePath','uploadedByPersonId','failureCode','idempotencyKey','bankAccount'])assert.equal(hidden in version,false);
      const downloaded=await request(`/attachments/${version.versionId}/content`);
      assert.equal(downloaded.status,200);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),version.versionId===first.versionId?bytes:revisedBytes);
    }
    assert.equal((await request(listPath,undefined,2)).status,404);
    assert.equal((await fetch(base+listPath)).status,401);
    assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM ledger_event')).rows[0].n,0);
  }finally{if(server)await new Promise(resolve=>server.close(resolve));await db.close();await rm(root,{recursive:true,force:true});}
});
