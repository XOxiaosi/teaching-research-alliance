// SELECT-only business verification for the disposable reimbursement browser scenarios.
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
 const listing=await request('/v1/finance/reimbursements/managed',undefined,token);
 const documents=listing.documents.filter(item=>item.reason.startsWith('WEB_REIMBURSE_'));
 assert.equal(documents.length,2,'exactly two synthetic reimbursement documents');
 const namespaces=await pool.query("SELECT nspname FROM pg_namespace WHERE nspname ~ '^integration_[a-f0-9]{32}$'");const matches=[];
 for(const {nspname} of namespaces.rows){
  const table=await pool.query('SELECT to_regclass($1) AS name',[`${nspname}.finance_reimbursement_submission`]);if(!table.rows[0].name)continue;
  const found=await pool.query(`SELECT finance_document_id FROM "${nspname}".finance_reimbursement_submission WHERE finance_document_id=$1`,[documents[0].id]);if(found.rowCount===1)matches.push(nspname);
 }
 assert.equal(matches.length,1);const schema=matches[0];
 const rows=(await pool.query(`SELECT d.id,d.status,d.version::text,s.amount_cents::text,s.reason,s.destination_account_id,r.decision,r.reason AS review_reason,r.actor_subject_code,r.actor_scope_type FROM "${schema}".finance_document d JOIN "${schema}".finance_reimbursement_submission s ON s.finance_document_id=d.id JOIN "${schema}".finance_reimbursement_decision r ON r.finance_document_id=d.id ORDER BY s.amount_cents DESC`)).rows;
 assert.equal(rows.length,2);assert.deepEqual(rows.map(row=>[row.status,row.version,row.amount_cents,row.decision,row.actor_subject_code,row.actor_scope_type]),[['APPROVED','3','4321','APPROVED','HEADQUARTERS_FINANCE','GLOBAL'],['REJECTED','3','1234','REJECTED','HEADQUARTERS_FINANCE','GLOBAL']]);
 const verified=[];
 for(const row of rows){
  const operation=row.status==='APPROVED'?'APPROVE':'REJECT';
  const commands=(await pool.query(`SELECT operation,count(*)::int AS count FROM "${schema}".finance_reimbursement_command_idempotency WHERE finance_document_id=$1 GROUP BY operation ORDER BY operation`,[row.id])).rows;
  assert.deepEqual(commands,[{operation,count:1},{operation:'SUBMIT',count:1}]);
  const events=(await pool.query(`SELECT event_type,count(*)::int AS count FROM "${schema}".finance_document_event WHERE finance_document_id=$1 GROUP BY event_type ORDER BY event_type`,[row.id])).rows;
  assert.deepEqual(events,[{event_type:'CREATED',count:1},{event_type:`REIMBURSEMENT_${row.status}`,count:1},{event_type:'REIMBURSEMENT_SUBMITTED',count:1}]);
  const attachments=(await pool.query(`SELECT b.purpose,v.status FROM "${schema}".finance_reimbursement_attachment_binding b JOIN "${schema}".finance_attachment_version v ON v.id=b.finance_attachment_version_id WHERE b.finance_document_id=$1 ORDER BY b.purpose`,[row.id])).rows;
  assert.deepEqual(attachments,[{purpose:'APPLICATION_SCREENSHOT',status:'READY'},{purpose:'SUPPORTING_DOCUMENT',status:'READY'}]);
  const projection=(await pool.query(`SELECT balance_cents::text FROM "${schema}".account_balance_projection WHERE account_id=$1`,[row.destination_account_id])).rows;
  verified.push({reason:row.reason,amountCents:row.amount_cents,status:row.status,reviewReason:row.review_reason,commands,events,attachments,balanceCents:projection[0]?.balance_cents??'0'});
 }
 const ledgerCount=(await pool.query(`SELECT count(*)::int AS count FROM "${schema}".ledger_event`)).rows[0].count;
 const expectEmpty=process.env.ALLIANCE_EXPECT_EMPTY_LEDGER==='1';
 if(expectEmpty){
  assert.equal(ledgerCount,0,'submitting and reviewing reimbursements must never post funds');
  const nonzero=(await pool.query(`SELECT count(*)::int AS count FROM "${schema}".account_balance_projection WHERE balance_cents<>0`)).rows[0].count;assert.equal(nonzero,0);
 }
 const reimbursementLedger=(await pool.query(`SELECT count(*)::int AS count FROM "${schema}".ledger_event WHERE event_type ILIKE '%REIMBURSE%' OR event_key ILIKE '%reimburse%'`)).rows[0].count;assert.equal(reimbursementLedger,0);
 console.log(JSON.stringify({synthetic:true,readOnlyBusinessData:true,usesSyntheticAuthSession:true,expectEmptyLedger:expectEmpty,ledgerCount,reimbursementLedger,verified},null,2));
}finally{await pool.end();await request('/v1/session/logout',{},token);}
