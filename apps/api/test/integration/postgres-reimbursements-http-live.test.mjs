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
    const review={expectedVersion:2,reason:'',idempotencyKey:'approve'};
    const approvePath=`/reimbursements/${draft.id}/approve`;
    assert.equal((await request(approvePath,review)).status,403);
    assert.equal((await request(approvePath,review,3)).status,403);
    assert.equal((await request(approvePath,{...review,amountCents:'1'},2)).status,400);
    const approved=await success(await request(approvePath,review,2));assert.equal(approved.status,'APPROVED');
    assert.equal((await success(await request(`/reimbursements/${draft.id}`,undefined,3))).decision.reason,'');
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

test('普通报销execute真实HTTP：权限、严格入参、总部划拨幂等、完成读取与跨财年零副作用',async()=>{
  const db=await createTestDatabase(process.env.DATABASE_URL),pool=db.pool;
  const root=await mkdtemp(join(tmpdir(),'alliance-reimbursement-execute-http-'));
  let at=new Date('2026-09-21T04:00:00Z'),server,missingServiceServer;
  const [applicantId,hqId,adminId,otherId,ownerId]=[randomUUID(),randomUUID(),randomUUID(),randomUUID(),randomUUID()];
  try{
    for(const [id,name] of [[applicantId,'execute-http-applicant'],[hqId,'execute-http-hq'],[adminId,'execute-http-admin'],[otherId,'execute-http-other'],[ownerId,'execute-http-owner']])
      await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1,$2,'合成人员','ACTIVE')",[id,name]);
    const destinationAccountId=randomUUID(),fundId=randomUUID(),sourceAccountId=randomUUID(),assignmentId=randomUUID();
    await pool.query("INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1,'PERSON',$2,$3,'ACTIVE'),($4,'COMPANY',$5,$6,'ACTIVE')",[destinationAccountId,applicantId,`person:${applicantId}`,sourceAccountId,fundId,`company:${fundId}`]);
    await pool.query("INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1,20),($2,1000)",[destinationAccountId,sourceAccountId]);
    await pool.query("INSERT INTO role_assignment(id,person_id,subject_code,scope_type,scope_id,valid_from,created_by,created_at) VALUES($1,$2,'HEADQUARTERS_FINANCE','GLOBAL',NULL,$3,$2,$3)",[randomUUID(),hqId,at.toISOString()]);
    await pool.query("INSERT INTO company_finance_fund(id,kind,fund_code,display_name,organization_unit_id,status,version,created_by_person_id,created_at,updated_at) VALUES($1,'HEADQUARTERS_FINANCE_OPERATING','HQ_HTTP_EXECUTE','总部HTTP执行测试',NULL,'ACTIVE',1,$2,$3,$3)",[fundId,hqId,at.toISOString()]);
    await pool.query("INSERT INTO company_finance_fund_assignment(id,fund_id,duty_subject,scope_type,scope_id,responsibility_code,valid_from,created_by_person_id,created_at) VALUES($1,$2,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'FINANCE_OPERATING_SOURCE',$3,$4,$3)",[assignmentId,fundId,at.toISOString(),hqId]);
    let sequence=0;
    const sessions=new SessionService({accounts:[applicantId,hqId,adminId,otherId,ownerId].map((personId,index)=>({accountId:personId,personId,phoneNormalized:`1360000000${index}`,credentialDigest:'synthetic-only',status:'ACTIVE'})),assignments:[
      {personId:applicantId,subject:'TEACHING_TEACHER',scope:'SELF',validFrom:new Date('2026-01-01')},
      {personId:hqId,subject:'HEADQUARTERS_FINANCE',scope:'GLOBAL',validFrom:new Date('2026-01-01')},
      {personId:adminId,subject:'SYSTEM_ADMIN',scope:'GLOBAL',validFrom:new Date('2026-01-01')},
      {personId:otherId,subject:'TEACHING_TEACHER',scope:'SELF',validFrom:new Date('2026-01-01')},
      {personId:ownerId,subject:'SYSTEM_OWNER',scope:'GLOBAL',validFrom:new Date('2026-01-01')}],sessionIdFactory:()=>`execute-http-token-${++sequence}`});
    for(let i=0;i<5;i++)sessions.login(`1360000000${i}`,'synthetic-only',at);
    sessions.switchRole('execute-http-token-1','TEACHING_TEACHER',at);
    sessions.switchRole('execute-http-token-2','HEADQUARTERS_FINANCE',at);
    sessions.switchRole('execute-http-token-3','SYSTEM_ADMIN',at);
    sessions.switchRole('execute-http-token-4','TEACHING_TEACHER',at);
    sessions.switchRole('execute-http-token-5','SYSTEM_OWNER',at);
    const store=await LocalAttachmentStore.create(root,fileURLToPath(new URL('../../../../',import.meta.url)));
    server=createApiServer({sessions,weeklyFees:{},financeDrafts:new PostgresFinanceDraftService(pool),financeAttachments:new PostgresFinanceAttachmentService(pool),
      financeAttachmentUploads:new PostgresFinanceAttachmentUploadService(pool,store),financeAttachmentReads:new PostgresFinanceAttachmentReadService(pool,store),
      reimbursements:new PostgresReimbursementSubmissionService(pool,store),reimbursementReviews:new PostgresReimbursementReviewService(pool,store),reimbursementReads:new PostgresReimbursementReadService(pool),
      reimbursementTransfers:new (await import('../../dist/postgres-reimbursement-transfer-service.js')).PostgresReimbursementTransferService(pool,store),now:()=>at});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const base=`http://127.0.0.1:${server.address().port}/v1/finance`;
    const request=(path,body,who=2,extra={})=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(who===null?{}:{authorization:`Bearer execute-http-token-${who}`}),...(body instanceof Uint8Array?{}:{'content-type':'application/json'}),...extra},...(body===undefined?{}:{body:body instanceof Uint8Array?body:JSON.stringify(body)})});
    const json=async response=>({status:response.status,body:await response.json()});
    const success=async response=>{const result=await json(response);assert.equal(result.status,200,JSON.stringify(result.body));return result.body.data;};
    const bytes=PNG.sync.write({width:2,height:2,data:Buffer.alloc(16,191)});
    const createApproved=async(key,createdAt=at)=>{
      at=createdAt;
      const draft=await success(await request('/drafts',{kind:'REIMBURSEMENT',idempotencyKey:key},1)),versions=[];
      for(const purpose of ['SUPPORTING_DOCUMENT','APPLICATION_SCREENSHOT']){
        const reserved=await success(await request(`/drafts/${draft.id}/attachment-uploads`,{purpose,originalFilename:'合成报销凭证.png',declaredMediaType:'image/png',declaredSizeBytes:bytes.length,idempotencyKey:key+purpose},1));
        const uploaded=await request(`/attachment-uploads/${reserved.versionId}/content`,bytes,1,{'content-type':'image/png'});assert.equal(uploaded.status,200);
        versions.push(reserved.versionId);
      }
      await success(await request(`/drafts/${draft.id}/reimbursement-submit`,{expectedVersion:1,amountCents:'150',reason:'HTTP执行测试',attachmentVersionIds:versions,idempotencyKey:key+'-submit'},1));
      await success(await request(`/reimbursements/${draft.id}/approve`,{expectedVersion:2,reason:'总部财务审核通过',idempotencyKey:key+'-approve'},2));
      return draft.id;
    };
    const command={sessionId:'ignored-by-bearer',expectedVersion:3,idempotencyKey:'execute-once'};
    const approvedId=await createApproved('execute-main');
    assert.equal((await request(`/reimbursements/${approvedId}/execute`,{expectedVersion:3,idempotencyKey:'execute-once'},null)).status,401);
    assert.equal((await request(`/reimbursements/${approvedId}/execute`,command,1)).status,403);
    assert.equal((await request(`/reimbursements/${approvedId}/execute`,command,3)).status,403);
    assert.equal((await request(`/reimbursements/${approvedId}/execute`,command,5)).status,403);
    assert.equal((await request(`/reimbursements/${approvedId}/execute`,{...command,extra:'reject-me'},2)).status,400);
    missingServiceServer=createApiServer({sessions,weeklyFees:{},now:()=>at});
    await new Promise((resolve,reject)=>{missingServiceServer.once('error',reject);missingServiceServer.listen(0,'127.0.0.1',resolve);});
    const unavailable=await json(await fetch(`http://127.0.0.1:${missingServiceServer.address().port}/v1/finance/reimbursements/${approvedId}/execute`,{method:'POST',headers:{authorization:'Bearer execute-http-token-2','content-type':'application/json'},body:JSON.stringify(command)}));
    assert.equal(unavailable.status,503);assert.equal(unavailable.body.error.code,'FINANCE_SERVICE_UNAVAILABLE');
    await new Promise(resolve=>missingServiceServer.close(resolve));missingServiceServer=undefined;
    assert.equal((await pool.query("SELECT balance_cents::text AS balance FROM account_balance_projection WHERE account_id=$1",[sourceAccountId])).rows[0].balance,'1000');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM ledger_event')).rows[0].count,0);
    const completed=await success(await request(`/reimbursements/${approvedId}/execute`,command,2));
    assert.deepEqual(completed,{id:approvedId,status:'COMPLETED',version:4,replay:false});
    assert.equal((await pool.query("SELECT balance_cents::text AS balance FROM account_balance_projection WHERE account_id=$1",[sourceAccountId])).rows[0].balance,'850');
    assert.equal((await pool.query("SELECT balance_cents::text AS balance FROM account_balance_projection WHERE account_id=$1",[destinationAccountId])).rows[0].balance,'170');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM ledger_event')).rows[0].count,1);
    assert.deepEqual(await success(await request(`/reimbursements/${approvedId}/execute`,command,2)),{...completed,replay:true});
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM ledger_event')).rows[0].count,1);
    const detail=await success(await request(`/reimbursements/${approvedId}`,undefined,2));assert.equal(detail.status,'COMPLETED');assert.equal(detail.management.completion.executedByPersonId,hqId);

    const crossCreated=new Date('2026-08-31T15:00:00Z');
    const crossId=await createApproved('execute-cross',crossCreated);
    at=new Date('2026-08-31T16:00:00Z');
    const cross=await json(await request(`/reimbursements/${crossId}/execute`,{expectedVersion:3,idempotencyKey:'cross-year'},2));
    assert.equal(cross.status,409);assert.equal(cross.body.error.code,'REIMBURSEMENT_CROSS_FINANCE_YEAR_PENDING');
    assert.deepEqual((await pool.query("SELECT status,version::text AS version FROM finance_document WHERE id=$1",[crossId])).rows,[{status:'APPROVED',version:'3'}]);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM ledger_event')).rows[0].count,1);
  }finally{if(missingServiceServer)await new Promise(resolve=>missingServiceServer.close(resolve));if(server)await new Promise(resolve=>server.close(resolve));await db.close();await rm(root,{recursive:true,force:true});}
});
