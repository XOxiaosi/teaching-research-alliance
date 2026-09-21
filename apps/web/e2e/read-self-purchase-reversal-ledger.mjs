// SELECT-only business verification; synthetic API login/switch/logout changes only auth session state.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
if(process.env.ALLIANCE_SYNTHETIC_E2E!=='1')throw new Error('SYNTHETIC_DEMO_REQUIRED');
const connection=process.env.ALLIANCE_DEMO_DATABASE_URL;
if(!connection || !['127.0.0.1','localhost'].includes(new URL(connection).hostname))throw new Error('LOCAL_DEMO_DATABASE_REQUIRED');
const origin=process.env.ALLIANCE_DEMO_API??'http://127.0.0.1:3114';
if(!['127.0.0.1','localhost'].includes(new URL(origin).hostname))throw new Error('LOCAL_DEMO_API_REQUIRED');
const request=async(path,body,token)=>{
 const response=await fetch(origin+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal(response.ok,true,`request ${path}: ${response.status}`);return (await response.json()).data;
};
const session=await request('/v1/session',{phoneNormalized:'13800000004',password:'Local-demo-only-2026'});
const token=session.sessionId;const pool=new Pool({connectionString:connection});
try{
 await request('/v1/role-contexts/switch',{subject:'SYSTEM_ADMIN'},token);
 const listing=await request('/v1/admin/company-funds',undefined,token);
 const fund=listing.funds.find(item=>item.id===listing.currentAssignment?.fundId);assert.ok(fund);
 assert.ok(['WEB_REVERSAL_HQ','WEB_SYNTHETIC_HQ'].includes(fund.fundCode));
 const namespaces=await pool.query("SELECT nspname FROM pg_namespace WHERE nspname ~ '^integration_[a-f0-9]{32}$'");const matches=[];
 for(const {nspname} of namespaces.rows){
  const table=await pool.query('SELECT to_regclass($1) AS name',[`${nspname}.settlement_account`]);if(!table.rows[0].name)continue;
  const found=await pool.query(`SELECT id FROM "${nspname}".settlement_account WHERE id=$1`,[fund.accountId]);if(found.rowCount===1)matches.push(nspname);
 }
 assert.equal(matches.length,1);const schema=matches[0];
 const originals=(await pool.query(`SELECT t.finance_document_id,t.destination_account_id,t.amount_cents::text,t.reason,t.ledger_event_id,d.status,d.version::text,r.reversal_ledger_event_id,r.actor_subject_code,r.destination_before_cents::text,r.destination_after_cents::text,r.source_before_cents::text,r.source_after_cents::text FROM "${schema}".finance_self_purchase_transfer t JOIN "${schema}".finance_document d ON d.id=t.finance_document_id JOIN "${schema}".finance_self_purchase_reversal r ON r.finance_document_id=t.finance_document_id WHERE t.source_account_id=$1 ORDER BY t.reason`,[fund.accountId])).rows;
 assert.equal(originals.length,2);assert.deepEqual(originals.map(row=>[row.reason,row.amount_cents,row.status,row.version,row.actor_subject_code]),[['REVERSAL_CONFLICT','5678','REVERSED','3','SYSTEM_ADMIN'],['REVERSAL_UNKNOWN','1234','REVERSED','3','HEADQUARTERS_FINANCE']]);
 const verified=[];
 for(const original of originals){
  assert.equal(BigInt(original.source_after_cents)-BigInt(original.source_before_cents),BigInt(original.amount_cents));
  assert.equal(BigInt(original.destination_after_cents)-BigInt(original.destination_before_cents),-BigInt(original.amount_cents));
  const entries=(await pool.query(`SELECT a.owner_type,e.category_key,e.amount_cents::text FROM "${schema}".ledger_entry e JOIN "${schema}".settlement_account a ON a.id=e.account_id WHERE e.event_id=ANY($1::uuid[]) ORDER BY e.category_key`,[[original.ledger_event_id,original.reversal_ledger_event_id]])).rows;
  assert.deepEqual(entries,[{owner_type:'COMPANY',category_key:'selfPurchaseExpense',amount_cents:`-${original.amount_cents}`},{owner_type:'COMPANY',category_key:'selfPurchaseExpenseReversal',amount_cents:original.amount_cents},{owner_type:'PERSON',category_key:'selfPurchaseIncome',amount_cents:original.amount_cents},{owner_type:'PERSON',category_key:'selfPurchaseIncomeReversal',amount_cents:`-${original.amount_cents}`}]);
  const commands=(await pool.query(`SELECT operation,count(*)::int AS count FROM "${schema}".finance_self_purchase_command_idempotency WHERE finance_document_id=$1 GROUP BY operation ORDER BY operation`,[original.finance_document_id])).rows;
  assert.deepEqual(commands,[{operation:'REVERSE',count:1},{operation:'SUBMIT',count:1}]);
  const originalsReady=(await pool.query(`SELECT count(*)::int AS count FROM "${schema}".finance_self_purchase_attachment_binding b JOIN "${schema}".finance_attachment_version v ON v.id=b.finance_attachment_version_id WHERE b.finance_document_id=$1 AND v.status='READY'`,[original.finance_document_id])).rows[0].count;assert.equal(originalsReady,2);
  verified.push({reason:original.reason,amountCents:original.amount_cents,actor:original.actor_subject_code,sourceBeforeCents:original.source_before_cents,sourceAfterCents:original.source_after_cents,personalBeforeCents:original.destination_before_cents,personalAfterCents:original.destination_after_cents,entries,commands,originalsReady});
 }
 const balance=async(accountId)=>(await pool.query(`SELECT balance_cents::text FROM "${schema}".account_balance_projection WHERE account_id=$1`,[accountId])).rows[0].balance_cents;
 const originalSourceBaseline=fund.fundCode==='WEB_REVERSAL_HQ'?'0':'-8765';
 assert.equal(await balance(fund.accountId),originalSourceBaseline);assert.equal(await balance(originals[0].destination_account_id),'-1234');
 for(const original of originals)assert.equal(original.source_after_cents,originalSourceBaseline);
 assert.equal(originals.find(row=>row.reason==='REVERSAL_UNKNOWN').destination_before_cents,'0');
 const withdrawal=(await pool.query(`SELECT d.status,t.amount_cents::text FROM "${schema}".finance_withdrawal_submission t JOIN "${schema}".finance_document d ON d.id=t.finance_document_id WHERE t.source_account_id=$1`,[originals[0].destination_account_id])).rows;
 // Verify the intervening withdrawal remains posted; never restore the pre-purchase historical balance.
 assert.equal(withdrawal.length,1);assert.equal(withdrawal[0].status,'PENDING_TRANSFER');assert.ok(BigInt(withdrawal[0].amount_cents)>0n);
 console.log(JSON.stringify({synthetic:true,readOnlyBusinessData:true,usesSyntheticAuthSession:true,sourceFundCode:fund.fundCode,sourceBalanceCents:originalSourceBaseline,personalBalanceCents:'-1234',interveningWithdrawal:withdrawal,verified},null,2));
}finally{await pool.end();await request('/v1/session/logout',{},token);}
