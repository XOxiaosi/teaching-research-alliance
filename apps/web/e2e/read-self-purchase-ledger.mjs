// Read-only post-browser verification against the explicitly supplied disposable demo database.
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
const token=session.sessionId;
const pool=new Pool({connectionString:connection});
try{
 await request('/v1/role-contexts/switch',{subject:'SYSTEM_ADMIN'},token);
 const listing=await request('/v1/admin/company-funds',undefined,token);
 const fund=listing.funds.find(item=>item.fundCode==='WEB_SYNTHETIC_HQ');assert.ok(fund);
 // Match the exact account issued by this running API; never guess a schema by recency.
 const namespaces=await pool.query("SELECT nspname FROM pg_namespace WHERE nspname ~ '^integration_[a-f0-9]{32}$'");
 const matches=[];
 for(const {nspname} of namespaces.rows){
  const table=await pool.query('SELECT to_regclass($1) AS name',[`${nspname}.settlement_account`]);if(!table.rows[0].name)continue;
  const found=await pool.query(`SELECT id FROM "${nspname}".settlement_account WHERE id=$1`,[fund.accountId]);
  if(found.rowCount===1)matches.push(nspname);
 }
 assert.equal(matches.length,1,'exact demo account must identify one schema');const schema=matches[0];
 const balance=await pool.query(`SELECT balance_cents::text FROM "${schema}".account_balance_projection WHERE account_id=$1`,[fund.accountId]);
 assert.equal(balance.rows[0].balance_cents,'-8765');
 // Target the original 87.65 purchase; the full suite also creates separately verified reversals.
 const entries=await pool.query(`SELECT a.owner_type,e.category_key,e.amount_cents::text FROM "${schema}".ledger_entry e JOIN "${schema}".settlement_account a ON a.id=e.account_id WHERE e.event_id IN (SELECT event_id FROM "${schema}".ledger_entry WHERE account_id=$1 AND category_key='selfPurchaseExpense' AND amount_cents=-8765) ORDER BY e.category_key`,[fund.accountId]);
 assert.deepEqual(entries.rows,[{owner_type:'COMPANY',category_key:'selfPurchaseExpense',amount_cents:'-8765'},{owner_type:'PERSON',category_key:'selfPurchaseIncome',amount_cents:'8765'}]);
 console.log(JSON.stringify({synthetic:true,readOnlyBusinessData:true,usesSyntheticAuthSession:true,sourceFundCode:fund.fundCode,sourceBalanceCents:balance.rows[0].balance_cents,entries:entries.rows,verified:'one exact debit and credit after lost-response retry'},null,2));
}finally{await pool.end();await request('/v1/session/logout',{},token);}
