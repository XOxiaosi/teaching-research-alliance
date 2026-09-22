import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PNG} from 'pngjs';
import {createApiServer,SessionService,LocalAttachmentStore,PostgresFinanceDraftService,
  PostgresFinanceAttachmentService,PostgresFinanceAttachmentUploadService,PostgresFinanceAttachmentReadService,
  PostgresReimbursementSubmissionService,PostgresReimbursementReviewService,PostgresReimbursementReadService} from '../../dist/main.js';
import {createTestDatabase} from './postgres-test-database.mjs';

test('普通报销真实HTTP：提交锁定原件，财务审核不划豆，管理员只读，跨年原键可恢复',async()=>{
  const db=await createTestDatabase(process.env.DATABASE_URL),pool=db.pool;
  const root=await mkdtemp(join(tmpdir(),'alliance-reimbursement-http-'));
  const people=[randomUUID(),randomUUID(),randomUUID(),randomUUID()];
  let at=new Date('2026-09-21T04:00:00Z'),server;
  try{
    for(const id of people)await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1,$2,'合成人员','ACTIVE')",[id,`reimbursement-http-${id}`]);
    const account=randomUUID();
    await pool.query("INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1,'PERSON',$2,$3,'ACTIVE')",[account,people[0],`person:${people[0]}`]);
    await pool.query('INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1,2000)',[account]);
    const store=await LocalAttachmentStore.create(root,fileURLToPath(new URL('../../../../',import.meta.url)));
    let sequence=0;
    const subjects=['TEACHING_TEACHER','HEADQUARTERS_FINANCE','SYSTEM_ADMIN','TEACHING_TEACHER'];
    const sessions=new SessionService({accounts:people.map((personId,index)=>({accountId:personId,personId,phoneNormalized:`1350000000${index}`,credentialDigest:'synthetic-only',status:'ACTIVE'})),
      assignments:people.map((personId,index)=>({personId,subject:subjects[index],scope:index===1||index===2?'GLOBAL':'SELF',validFrom:new Date('2026-01-01')})),sessionIdFactory:()=>`reimbursement-token-${++sequence}`});
    for(let i=0;i<4;i++){sessions.login(`1350000000${i}`,'synthetic-only',at);sessions.switchRole(`reimbursement-token-${i+1}`,subjects[i],at);}
    server=createApiServer({sessions,weeklyFees:{},financeDrafts:new PostgresFinanceDraftService(pool),financeAttachments:new PostgresFinanceAttachmentService(pool),
      financeAttachmentUploads:new PostgresFinanceAttachmentUploadService(pool,store),financeAttachmentReads:new PostgresFinanceAttachmentReadService(pool,store),
      reimbursements:new PostgresReimbursementSubmissionService(pool,store),reimbursementReviews:new PostgresReimbursementReviewService(pool,store),reimbursementReads:new PostgresReimbursementReadService(pool),now:()=>at});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const base=`http://127.0.0.1:${server.address().port}/v1/finance`;
    const request=(path,body,who=1)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer reimbursement-token-${who}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const success=async response=>{assert.equal(response.status,200,JSON.stringify(await response.clone().json()));return (await response.json()).data;};
    const bytes=PNG.sync.write({width:2,height:2,data:Buffer.alloc(16,190)});
    const create=async key=>{
      const draft=await success(await request('/drafts',{kind:'REIMBURSEMENT',idempotencyKey:key})),versions=[];
      for(const purpose of ['SUPPORTING_DOCUMENT','APPLICATION_SCREENSHOT']){
        const reserved=await success(await request(`/drafts/${draft.id}/attachment-uploads`,{purpose,originalFilename:'合成报销凭证.png',declaredMediaType:'image/png',declaredSizeBytes:bytes.length,idempotencyKey:key+purpose}));
        await success(await fetch(`${base}/attachment-uploads/${reserved.versionId}/content`,{method:'POST',headers:{authorization:'Bearer reimbursement-token-1','content-type':'image/png'},body:bytes}));
        versions.push(reserved.versionId);
      }
      return {draft,versions};
    };
    const {draft,versions}=await create('approve-draft');
    const command={expectedVersion:1,amountCents:'10000',reason:'合成教具报销',attachmentVersionIds:versions,idempotencyKey:'submit'};
    const path=`/drafts/${draft.id}/reimbursement-submit`;
    assert.equal((await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(command)})).status,401);
    for(const extra of ['sourceAccountId','destinationAccountId','fundId','personId','bankAccount'])assert.equal((await request(path,{...command,[extra]:randomUUID()})).status,400);
    assert.equal((await request(path,command,4)).status,404);
    const submitted=await success(await request(path,command));assert.equal(submitted.status,'PENDING_APPROVAL');
    assert.equal((await success(await request(path,command))).replay,true);
    assert.equal((await success(await request('/reimbursements/mine'))).documents.length,1);
    const detail=await success(await request(`/reimbursements/${draft.id}`));assert.equal(detail.attachments.length,2);assert.equal(detail.management,undefined);
    assert.equal((await request(`/reimbursements/${draft.id}`,undefined,4)).status,404);
    assert.equal((await request('/reimbursements/managed')).status,403);
    assert.equal((await success(await request('/reimbursements/managed',undefined,3))).documents.length,1);
    const attachmentList=await success(await request(`/documents/${draft.id}/attachments`));
    assert.deepEqual(attachmentList.attachments.flatMap(slot=>slot.versions).map(version=>version.binding.stage),['SUBMISSION','SUBMISSION']);
    const download=await fetch(`${base}/attachments/${versions[0]}/content`,{headers:{authorization:'Bearer reimbursement-token-2'}});assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
    const review={expectedVersion:2,reason:'原件核对通过',idempotencyKey:'approve'};
    const approvePath=`/reimbursements/${draft.id}/approve`;
    assert.equal((await request(approvePath,review)).status,403);
    assert.equal((await request(approvePath,review,3)).status,403);
    assert.equal((await request(approvePath,{...review,amountCents:'1'},2)).status,400);
    const approved=await success(await request(approvePath,review,2));assert.equal(approved.status,'APPROVED');
    assert.equal((await success(await request(approvePath,review,2))).replay,true);
    assert.equal((await request(`/reimbursements/${draft.id}/reject`,{...review,idempotencyKey:'late-reject'},2)).status,409);
    const rejectedCase=await create('reject-draft');
    await success(await request(`/drafts/${rejectedCase.draft.id}/reimbursement-submit`,{...command,attachmentVersionIds:rejectedCase.versions,idempotencyKey:'submit-reject'}));
    const rejected=await success(await request(`/reimbursements/${rejectedCase.draft.id}/reject`,{...review,reason:'原件用途不符',idempotencyKey:'reject'},2));assert.equal(rejected.status,'REJECTED');
    assert.equal((await success(await request(`/reimbursements/${rejected.id}`))).decision.reason,'原件用途不符');
    assert.equal((await pool.query('SELECT balance_cents::text balance FROM account_balance_projection WHERE account_id=$1',[account])).rows[0].balance,'2000');
    assert.equal((await pool.query('SELECT count(*)::int n FROM ledger_event')).rows[0].n,0);
    at=new Date('2027-08-31T16:00:00Z');
    assert.equal((await success(await request('/reimbursements/mine'))).documents.length,0);
    assert.equal((await request(`/documents/${draft.id}/attachments`)).status,404);
    assert.equal((await request(`/reimbursements/${draft.id}`)).status,404);
    assert.equal((await success(await request(path,command))).replay,true);
    assert.equal((await success(await request(approvePath,review,2))).replay,true);
    assert.equal((await success(await request(`/reimbursements/${draft.id}`,undefined,3))).decision.decision,'APPROVED');
    assert.equal((await success(await request(`/documents/${draft.id}/attachments`,undefined,3))).attachments.length,2);
  }finally{if(server)await new Promise(resolve=>server.close(resolve));await db.close();await rm(root,{recursive:true,force:true});}
});
