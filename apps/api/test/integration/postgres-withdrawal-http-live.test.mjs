import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { createApiServer, SessionService, PostgresFinanceDraftService, PostgresFinanceAttachmentService,
  PostgresFinanceAttachmentUploadService, PostgresFinanceAttachmentReadService, LocalAttachmentStore,
  FinanceSensitiveFieldCrypto, PostgresWithdrawalService, PostgresWithdrawalReadService } from '../../dist/main.js';
import { createTestDatabase } from './postgres-test-database.mjs';

test('提现真实HTTP闭环：上传证据、足额扣豆、受限详情、财务回执和转账确认',async()=>{
  const db=await createTestDatabase(process.env.DATABASE_URL),pool=db.pool;
  const root=await mkdtemp(join(tmpdir(),'alliance-withdrawal-http-'));
  const at=new Date('2026-09-21T04:00:00Z');
  const [owner,other,finance]=[randomUUID(),randomUUID(),randomUUID()];
  const account=randomUUID();let server;
  try{
    for(const id of [owner,other,finance])await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1,$2,'合成老师','ACTIVE')",[id,`withdraw-http-${id}`]);
    await pool.query("INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1,'PERSON',$2,$3,'ACTIVE')",[account,owner,`person:${owner}`]);
    await pool.query('INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1,100000)',[account]);
    const store=await LocalAttachmentStore.create(root,fileURLToPath(new URL('../../../../',import.meta.url)));
    const crypto=new FinanceSensitiveFieldCrypto('synthetic',{synthetic:randomBytes(32).toString('hex')});
    const reads=new PostgresWithdrawalReadService(pool,crypto);
    const stoppedVenue=randomUUID(),sharedVenue=randomUUID(),viewOnlyVenue=randomUUID();
    for(const [id,venueOwner] of [[stoppedVenue,owner],[sharedVenue,other],[viewOnlyVenue,other]]){
      await pool.query("INSERT INTO venue(id,owner_person_id,name,status) VALUES($1,$2,'合成停用场地','INACTIVE')",[id,venueOwner]);
      await pool.query("INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('VENUE',$1,$2,'ACTIVE')",[id,`venue:${id}`]);
    }
    for(const [venueId,canWithdraw] of [[sharedVenue,true],[viewOnlyVenue,false]])await pool.query(
      "INSERT INTO venue_permission_grant(venue_id,grantee_person_id,can_view,can_withdraw,valid_from,granted_by) VALUES($1,$2,true,$3,'2026-01-01',$4)",[venueId,owner,canWithdraw,other]);
    const personalContext={personId:owner,subject:'TEACHING_TEACHER',scope:'SELF'};
    const sources=await reads.listSources(personalContext,at);
    assert.deepEqual(sources.filter(row=>row.sourceType==='VENUE').map(row=>row.venueId).sort(),[stoppedVenue,sharedVenue].sort());
    await pool.query('UPDATE venue_permission_grant SET valid_to=$2 WHERE venue_id=$1',[sharedVenue,at]);
    assert.deepEqual((await reads.listSources(personalContext,at)).filter(row=>row.sourceType==='VENUE').map(row=>row.venueId),[stoppedVenue]);
    await assert.rejects(reads.listSources(personalContext,new Date('invalid')),/INVALID_INPUT/);
    let counter=0;
    const sessions=new SessionService({accounts:[owner,other,finance].map((id,index)=>({accountId:id,personId:id,phoneNormalized:`1380000000${index}`,credentialDigest:'synthetic-only',status:'ACTIVE'})),assignments:[owner,other,finance].map(personId=>({personId,subject:'TEACHING_TEACHER',scope:'SELF',validFrom:new Date('2026-01-01')})).concat([{personId:finance,subject:'HEADQUARTERS_FINANCE',scope:'GLOBAL',validFrom:new Date('2026-01-01')}]),sessionIdFactory:()=>`withdrawal-token-${++counter}`});
    for(let i=0;i<3;i++){sessions.login(`1380000000${i}`,'synthetic-only',at);sessions.switchRole(`withdrawal-token-${i+1}`,i===2?'HEADQUARTERS_FINANCE':'TEACHING_TEACHER',at);}
    server=createApiServer({sessions,weeklyFees:{},financeDrafts:new PostgresFinanceDraftService(pool),financeAttachments:new PostgresFinanceAttachmentService(pool),financeAttachmentUploads:new PostgresFinanceAttachmentUploadService(pool,store),financeAttachmentReads:new PostgresFinanceAttachmentReadService(pool,store),withdrawals:new PostgresWithdrawalService(pool,store,crypto),withdrawalReads:reads,now:()=>at});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const base=`http://127.0.0.1:${server.address().port}/v1/finance`;
    const request=(path,body,who=1)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer withdrawal-token-${who}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const success=async response=>{assert.equal(response.status,200,JSON.stringify(await response.clone().json()));return (await response.json()).data;};
    const draft=await success(await request('/drafts',{kind:'WITHDRAWAL',idempotencyKey:'withdrawal-http-draft'}));
    const bytes=PNG.sync.write({width:2,height:2,data:Buffer.alloc(16,255)});
    const addAttachment=async(purpose,key,who=1)=>{
      const reservation=await success(await request(`/drafts/${draft.id}/attachment-uploads`,{purpose,originalFilename:'合成凭证.png',declaredMediaType:'image/png',declaredSizeBytes:bytes.length,idempotencyKey:key},who));
      await success(await fetch(`${base}/attachment-uploads/${reservation.versionId}/content`,{method:'POST',headers:{authorization:`Bearer withdrawal-token-${who}`,'content-type':'image/png'},body:bytes}));
      return reservation.versionId;
    };
    const supporting=await addAttachment('SUPPORTING_DOCUMENT','supporting');
    const screenshot=await addAttachment('APPLICATION_SCREENSHOT','screenshot');
    const command={expectedVersion:1,sourceAccountId:account,amountCents:'60000',recipientName:'合成收款人',bankAccount:' 0012 3400 ',bankName:'合成银行',attachmentVersionIds:[supporting,screenshot],idempotencyKey:'withdrawal-submit'};
    const submitPath=`/drafts/${draft.id}/withdrawal-submit`;
    assert.equal((await request(submitPath,{...command,personId:other})).status,400);
    assert.equal((await request(submitPath,{...command,attachmentVersionIds:[]})).status,400);
    const broken=Buffer.from(bytes);broken[broken.length-1]^=1;
    await writeFile(join(root,'objects',supporting),broken);
    const blocked=await request(submitPath,command);assert.equal(blocked.status,500);
    assert.equal((await blocked.json()).error.code,'ATTACHMENT_INTEGRITY_FAILED');
    assert.equal((await pool.query('SELECT balance_cents::text AS balance FROM account_balance_projection WHERE account_id=$1',[account])).rows[0].balance,'100000');
    assert.equal((await pool.query('SELECT count(*)::int n FROM finance_withdrawal_submission')).rows[0].n,0);
    await writeFile(join(root,'objects',supporting),bytes);
    const submitted=await success(await request(submitPath,command));assert.equal(submitted.status,'PENDING_TRANSFER');
    assert.equal((await success(await request(submitPath,command))).replay,true);
    const balance=async()=>BigInt((await pool.query('SELECT balance_cents::text FROM account_balance_projection WHERE account_id=$1',[account])).rows[0].balance_cents);
    assert.equal(await balance(),40000n);
    const mine=await success(await request('/withdrawals/mine'));assert.equal(mine.length,1);assert.equal(JSON.stringify(mine).includes(command.bankAccount),false);
    const detailResponse=await request(`/withdrawals/${draft.id}`);assert.equal(detailResponse.headers.get('cache-control'),'private, no-store');
    const detail=await success(detailResponse);assert.deepEqual(detail.recipient,{recipientName:command.recipientName,bankAccount:command.bankAccount,bankName:command.bankName});assert.equal(detail.attachments.length,2);
    assert.equal((await request(`/withdrawals/${draft.id}`,undefined,2)).status,404);
    assert.equal((await request('/withdrawals/pending-transfer')).status,403);
    assert.equal((await request(`/withdrawals/${draft.id}/finance-revoke`,{expectedVersion:submitted.version,reason:'尝试自行撤回',idempotencyKey:'self-revoke'})).status,403);
    const pending=await success(await request('/withdrawals/pending-transfer',undefined,3));assert.equal(pending.length,1);assert.ok(!JSON.stringify(pending).includes(command.bankAccount));
    assert.equal((await success(await request(`/withdrawals/${draft.id}`,undefined,3))).recipient.bankAccount,command.bankAccount);
    const receipt=await addAttachment('PAYMENT_RECEIPT','payment-receipt',3);
    const ownReceipt=await fetch(`${base}/attachments/${receipt}/content`,{headers:{authorization:'Bearer withdrawal-token-1'}});assert.equal(ownReceipt.status,200);assert.deepEqual(Buffer.from(await ownReceipt.arrayBuffer()),bytes);
    const complete={expectedVersion:submitted.version,attachmentVersionIds:[receipt],idempotencyKey:'transfer-complete'};
    assert.equal((await success(await request(`/withdrawals/${draft.id}/mark-transferred`,complete,3))).status,'TRANSFERRED');
    assert.equal((await success(await request(`/withdrawals/${draft.id}/mark-transferred`,complete,3))).replay,true);
    assert.equal(await balance(),40000n);assert.equal((await success(await request('/withdrawals/pending-transfer',undefined,3))).length,0);
    assert.equal((await request(`/withdrawals/${draft.id}/finance-revoke`,{expectedVersion:submitted.version+1,reason:'完成后禁止撤回',idempotencyKey:'late-revoke'},3)).status,409);
    const detailAfter=await success(await request(`/withdrawals/${draft.id}`));assert.equal(detailAfter.attachments.filter(item=>item.stage==='COMPLETION').length,1);
    for(const context of [{personId:finance,subject:'HEADQUARTERS_FINANCE'},{personId:finance,subject:'HEADQUARTERS_FINANCE',scope:'REGION'},{personId:owner,subject:'TEACHING_TEACHER'}])await assert.rejects(reads.getDetail(context,draft.id,at),/FORBIDDEN_SCOPE/);
    for(const subject of ['SYSTEM_ADMIN','SYSTEM_OWNER']){
      const context={personId:finance,subject,scope:'GLOBAL'};
      assert.equal((await reads.getDetail(context,draft.id,at)).recipient.bankAccount,command.bankAccount);
      assert.equal((await reads.listManaged(context)).length,1);
      await assert.rejects(reads.listPending(context),/FORBIDDEN_SCOPE/);
    }
    const nextYear=new Date('2027-08-31T16:00:00Z');
    assert.deepEqual(await reads.listOwn(personalContext,nextYear),[]);
    await assert.rejects(reads.getDetail(personalContext,draft.id,nextYear),/FINANCE_DOCUMENT_NOT_FOUND/);
    assert.equal((await reads.getDetail({personId:finance,subject:'HEADQUARTERS_FINANCE',scope:'GLOBAL'},draft.id,nextYear)).recipient.bankAccount,command.bankAccount);
    const missingKeyReads=new PostgresWithdrawalReadService(pool,new FinanceSensitiveFieldCrypto('other',{other:randomBytes(32).toString('hex')}));
    await assert.rejects(missingKeyReads.getDetail({personId:owner,subject:'TEACHING_TEACHER',scope:'SELF'},draft.id,at),/FINANCE_RECIPIENT_UNAVAILABLE/);
    assert.equal((await pool.query("SELECT count(*)::int n FROM audit_event WHERE action_code='WITHDRAWAL_DETAIL_INTEGRITY_FAILED'")).rows[0].n,1);
    const saved=(await pool.query('SELECT * FROM finance_withdrawal_submission WHERE finance_document_id=$1',[draft.id])).rows[0];
    assert.ok(!JSON.stringify(saved).includes(command.bankAccount));
    assert.equal((await pool.query("SELECT count(*)::int n FROM ledger_event WHERE event_type='WITHDRAWAL_DEBIT'")).rows[0].n,1);
  }finally{if(server)await new Promise(resolve=>server.close(resolve));await db.close();await rm(root,{recursive:true,force:true});}
});
