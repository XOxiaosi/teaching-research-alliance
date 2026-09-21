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
  PostgresCompanyFundService} from '../../dist/main.js';
import {PostgresSelfPurchaseService} from '../../dist/postgres-self-purchase-service.js';
import {PostgresSelfPurchaseReadService} from '../../dist/postgres-self-purchase-read-service.js';
import {PostgresSelfPurchaseReversalService} from '../../dist/postgres-self-purchase-reversal-service.js';
import {createTestDatabase} from './postgres-test-database.mjs';

test('财务本人采买真实HTTP：真实任职、两份原件、业务扣豆与本人加豆同时完成',async()=>{
  const db=await createTestDatabase(process.env.DATABASE_URL),pool=db.pool;
  const root=await mkdtemp(join(tmpdir(),'alliance-self-purchase-http-'));
  const [finance,other,admin]=[randomUUID(),randomUUID(),randomUUID()];
  let at=new Date('2026-09-21T04:00:00Z'),server;
  try{
    for(const id of [finance,other,admin])await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1,$2,'合成人员','ACTIVE')",[id,`purchase-http-${id}`]);
    const personalAccount=randomUUID();
    await pool.query("INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1,'PERSON',$2,$3,'ACTIVE')",[personalAccount,finance,`person:${finance}`]);
    await pool.query('INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1,2000)',[personalAccount]);
    const funds=new PostgresCompanyFundService(pool),adminContext={personId:admin,subject:'SYSTEM_ADMIN',scope:'GLOBAL'};
    const fund=await funds.create(adminContext,{fundCode:'HQ_SELF_PURCHASE_HTTP',displayName:'合成总部业务资金'},'http-fund',at);
    await funds.assign(adminContext,{fundId:fund.id,expectedAssignmentId:null,reason:'合成配置'},'http-assign',at);
    await pool.query('UPDATE account_balance_projection SET balance_cents=5000 WHERE account_id=$1',[fund.accountId]);
    const store=await LocalAttachmentStore.create(root,fileURLToPath(new URL('../../../../',import.meta.url)));
    let sequence=0;
    const sessions=new SessionService({accounts:[finance,other,admin].map((personId,index)=>({accountId:personId,personId,phoneNormalized:`1360000000${index}`,credentialDigest:'synthetic-only',status:'ACTIVE'})),
      assignments:[finance,other,admin].map(personId=>({personId,subject:'TEACHING_TEACHER',scope:'SELF',validFrom:new Date('2026-01-01')})).concat([{personId:admin,subject:'SYSTEM_ADMIN',scope:'GLOBAL',validFrom:new Date('2026-01-01')}]),sessionIdFactory:()=>`purchase-token-${++sequence}`});
    for(let i=0;i<3;i++){sessions.login(`1360000000${i}`,'synthetic-only',at);sessions.switchRole(`purchase-token-${i+1}`,i===2?'SYSTEM_ADMIN':'TEACHING_TEACHER',at);}
    server=createApiServer({sessions,weeklyFees:{},financeDrafts:new PostgresFinanceDraftService(pool),financeAttachments:new PostgresFinanceAttachmentService(pool),
      financeAttachmentUploads:new PostgresFinanceAttachmentUploadService(pool,store),financeAttachmentReads:new PostgresFinanceAttachmentReadService(pool,store),
      selfPurchases:new PostgresSelfPurchaseService(pool,store),selfPurchaseReads:new PostgresSelfPurchaseReadService(pool),
      selfPurchaseReversals:new PostgresSelfPurchaseReversalService(pool),now:()=>at});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const base=`http://127.0.0.1:${server.address().port}/v1/finance`;
    const request=(path,body,who=1)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer purchase-token-${who}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const success=async response=>{assert.equal(response.status,200,JSON.stringify(await response.clone().json()));return (await response.json()).data;};
    const draft=await success(await request('/drafts',{kind:'SELF_PURCHASE',idempotencyKey:'purchase-draft'}));
    const bytes=PNG.sync.write({width:2,height:2,data:Buffer.alloc(16,190)}),versions=[];
    for(const purpose of ['SUPPORTING_DOCUMENT','APPLICATION_SCREENSHOT']){
      const reserved=await success(await request(`/drafts/${draft.id}/attachment-uploads`,{purpose,originalFilename:'合成采买凭证.png',declaredMediaType:'image/png',declaredSizeBytes:bytes.length,idempotencyKey:purpose}));
      await success(await fetch(`${base}/attachment-uploads/${reserved.versionId}/content`,{method:'POST',headers:{authorization:'Bearer purchase-token-1','content-type':'image/png'},body:bytes}));
      versions.push(reserved.versionId);
    }
    const command={expectedVersion:1,amountCents:'10000',reason:'合成教具采买',attachmentVersionIds:versions,idempotencyKey:'purchase-submit'};
    const path=`/drafts/${draft.id}/self-purchase-submit`;
    assert.equal((await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(command)})).status,401);
    for(const extra of ['sourceAccountId','destinationAccountId','fundId','personId','bankAccount'])assert.equal((await request(path,{...command,[extra]:randomUUID()})).status,400);
    assert.equal((await request(path,command)).status,403,'个人入口不代表已经具有真实财务任职');
    assert.equal((await pool.query('SELECT count(*)::int n FROM ledger_event')).rows[0].n,0);
    await pool.query("INSERT INTO role_assignment(person_id,subject_code,scope_type,scope_id,valid_from,created_by) VALUES($1,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'2026-01-01',$2)",[finance,admin]);
    assert.equal((await request(path,command,2)).status,404);
    const inactive=await funds.setStatus(adminContext,fund.id,{expectedVersion:1,status:'INACTIVE',reason:'合成停用检查'},'stop-before-submit',at);
    const refused=await request(path,command);assert.equal(refused.status,409);assert.equal((await refused.json()).error.code,'COMPANY_FUND_INACTIVE');
    await funds.setStatus(adminContext,fund.id,{expectedVersion:inactive.version,status:'ACTIVE',reason:'恢复合成流程'},'restore-before-submit',at);
    const submitted=await success(await request(path,command));assert.equal(submitted.status,'COMPLETED');
    assert.equal((await success(await request(path,command))).replay,true);
    const balances=await pool.query('SELECT account_id::text,balance_cents::text FROM account_balance_projection WHERE account_id=ANY($1::uuid[])',[[fund.accountId,personalAccount]]);
    assert.deepEqual(Object.fromEntries(balances.rows.map(row=>[row.account_id,row.balance_cents])),{[fund.accountId]:'-5000',[personalAccount]:'12000'});
    const mine=await success(await request('/self-purchases/mine'));assert.equal(mine.documents.length,1);
    const detailResponse=await request(`/self-purchases/${draft.id}`);assert.equal(detailResponse.headers.get('cache-control'),'private, no-store');
    const detail=await success(detailResponse);assert.equal(detail.processingMode,'SYSTEM_RULE');assert.equal(detail.amountCents,'10000');assert.equal(detail.attachments.length,2);
    assert.equal(detail.applicantDisplayName,`purchase-http-${finance}`);
    assert.equal((await request(`/self-purchases/${draft.id}`,undefined,2)).status,404);
    assert.equal((await request('/self-purchases/managed')).status,403);
    assert.equal((await success(await request('/self-purchases/managed',undefined,3))).documents.length,1);
    const attachmentList=await success(await request(`/documents/${draft.id}/attachments`));
    assert.deepEqual(attachmentList.attachments.flatMap(slot=>slot.versions).map(version=>version.binding.stage),['SUBMISSION','SUBMISSION']);
    const download=await fetch(`${base}/attachments/${versions[0]}/content`,{headers:{authorization:'Bearer purchase-token-1'}});assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
    assert.equal((await request(`/drafts/${draft.id}/attachment-uploads`,{purpose:'SUPPORTING_DOCUMENT',originalFilename:'late.png',declaredMediaType:'image/png',declaredSizeBytes:bytes.length,idempotencyKey:'late'})).status,409);
    const reversePath=`/self-purchases/${draft.id}/reverse`;
    const reversal={expectedVersion:submitted.version,reason:'合成重复采买登记更正',idempotencyKey:'purchase-reverse'};
    assert.equal((await fetch(base+reversePath,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(reversal)})).status,401);
    assert.equal((await request(reversePath,reversal)).status,403,'个人身份不能撤销已完成划拨');
    for(const extra of ['amountCents','sourceAccountId','destinationAccountId','attachmentVersionIds','bankAccount']){
      assert.equal((await request(reversePath,{...reversal,[extra]:'forbidden'},3)).status,400);
    }
    const stale=await request(reversePath,{...reversal,expectedVersion:1},3);
    assert.equal(stale.status,409);assert.equal((await stale.json()).error.code,'VERSION_CONFLICT');
    at=new Date('2027-08-31T16:00:00Z');
    assert.equal((await success(await request('/self-purchases/mine'))).documents.length,0);
    assert.equal((await request(`/self-purchases/${draft.id}`)).status,404);
    assert.equal((await request(`/documents/${draft.id}/attachments`)).status,404);
    assert.equal((await success(await request(path,command))).replay,true);
    assert.equal((await success(await request(`/self-purchases/${draft.id}`,undefined,3))).status,'COMPLETED');
    assert.equal((await pool.query('SELECT count(*)::int n FROM ledger_event')).rows[0].n,1);
    const reversed=await success(await request(reversePath,reversal,3));
    assert.equal(reversed.status,'REVERSED');assert.equal(reversed.version,submitted.version+1);
    assert.equal((await success(await request(reversePath,reversal,3))).replay,true);
    const changed=await request(reversePath,{...reversal,reason:'different'},3);
    assert.equal(changed.status,409);assert.equal((await changed.json()).error.code,'IDEMPOTENCY_REPLAY');
    assert.equal((await request(reversePath,{...reversal,idempotencyKey:'another-reverse'},3)).status,409);
    const reversedDetail=await success(await request(`/self-purchases/${draft.id}`,undefined,3));
    assert.equal(reversedDetail.status,'REVERSED');assert.equal(reversedDetail.amountCents,'10000');
    assert.equal(reversedDetail.applicantDisplayName,`purchase-http-${finance}`);
    assert.equal(reversedDetail.reversal.reason,reversal.reason);assert.equal(reversedDetail.attachments.length,2);
    assert.equal((await success(await request('/self-purchases/managed',undefined,3))).documents[0].status,'REVERSED');
    assert.equal((await request(`/self-purchases/${draft.id}`)).status,404);
    assert.equal((await success(await request(path,command))).replay,true,'原成功申请的重试只确认旧命令，不重新划拨');
    const originalEvidence=await success(await request(`/documents/${draft.id}/attachments`,undefined,3));
    assert.deepEqual(originalEvidence.attachments.flatMap(slot=>slot.versions).map(version=>version.binding.documentVersion),[submitted.version,submitted.version]);
    const adminDownload=await fetch(`${base}/attachments/${versions[0]}/content`,{headers:{authorization:'Bearer purchase-token-3'}});
    assert.equal(adminDownload.status,200);assert.deepEqual(Buffer.from(await adminDownload.arrayBuffer()),bytes);
    const finalBalances=await pool.query('SELECT account_id::text,balance_cents::text FROM account_balance_projection WHERE account_id=ANY($1::uuid[])',[[fund.accountId,personalAccount]]);
    assert.deepEqual(Object.fromEntries(finalBalances.rows.map(row=>[row.account_id,row.balance_cents])),{[fund.accountId]:'5000',[personalAccount]:'2000'});
    assert.equal((await pool.query('SELECT count(*)::int n FROM ledger_event')).rows[0].n,2);
  }finally{if(server)await new Promise(resolve=>server.close(resolve));await db.close();await rm(root,{recursive:true,force:true});}
});
