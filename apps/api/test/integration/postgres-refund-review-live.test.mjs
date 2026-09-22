import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {fixture} from './refund-review-fixture.mjs';
const at=new Date('2026-09-21T09:00:00Z');
const count=async(pool,table)=>(await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;

test('refund approval takes latest settled version, exact replay and competing approvals post once',async()=>{
 const f=await fixture();try{
  const doc=await f.pending(), overlapping=await f.pending();
  await f.record(120000n);
  const before=await f.balances();
  const [first,replay]=await Promise.all([f.approve(doc,'same-key'),f.approve(doc,'same-key')]);
  assert.deepEqual([first.replay,replay.replay].sort(),[false,true]);
  const after=await f.balances();assert.equal(before.reduce((a,b)=>a+b)-after.reduce((a,b)=>a+b),120000n);
  const effect=(await f.pool.query('SELECT source_weekly_fee_version::text v,gross_amount_cents::text gross FROM weekly_fee_refund_effect WHERE finance_document_id=$1',[doc.id])).rows[0];
  assert.deepEqual(effect,{v:'2',gross:'120000'});
  await assert.rejects(f.approve(overlapping),/WEEKLY_FEE_REFUNDED/);
  assert.deepEqual(await f.balances(),after);
  assert.equal((await f.pool.query('SELECT status FROM finance_document WHERE id=$1',[overlapping.id])).rows[0].status,'PENDING_APPROVAL');
  assert.equal(await count(f.pool,'finance_refund_decision'),1);
  await assert.rejects(f.review.approve(f.hqContext,doc.id,{expectedVersion:2,reason:'changed'},'same-key',at),/IDEMPOTENCY_REPLAY/);
  for(const subject of ['SYSTEM_ADMIN','SYSTEM_OWNER','REGION_FINANCE','TEACHING_TEACHER'])await assert.rejects(f.review.approve({...f.hqContext,subject},doc.id,{expectedVersion:2,reason:'verified'},randomUUID(),at),/FORBIDDEN_SCOPE/);
 }finally{await f.close();}
});

test('overlapping multi-fee approval is atomic; rejected applications never change balances',async()=>{
 const f=await fixture();try{
  const second=await f.weekly.recordAndSettle(f.ids.teacherA,{referralCaseId:f.ids.referralRefund,teachingWeekId:f.ids.weekA,venueId:f.ids.venueA,settlementMonth:'2026-09-01',grossAmountCents:50000n,expectedVersion:0},randomUUID());
  const single=await f.pending(),multi=await f.pending([f.refundFee.fee.id,second.fee.id]);
  await f.approve(single);const before=await f.balances();
  await assert.rejects(f.approve(multi),/WEEKLY_FEE_REFUNDED/);
  assert.deepEqual(await f.balances(),before);assert.equal(await count(f.pool,'weekly_fee_refund_effect'),1);
  const rejected=await f.review.reject(f.hqContext,multi.id,{expectedVersion:2,reason:'overlap'},'reject',at);
  assert.equal(rejected.status,'REJECTED');assert.deepEqual(await f.balances(),before);
  assert.equal((await f.pool.query('SELECT posting_status,ledger_event_id FROM finance_refund_decision WHERE finance_document_id=$1',[multi.id])).rows[0].ledger_event_id,null);
 }finally{await f.close();}
});

test('missing original and unposted current version fail closed without partial reversal',async()=>{
 const f=await fixture();try{
  const doc=await f.pending(),before=await f.balances();
  await rm(join(f.root,'objects',doc.evidence[0]));
  await assert.rejects(f.approve(doc),/ATTACHMENT_INTEGRITY_FAILED/);
  assert.deepEqual(await f.balances(),before);assert.equal(await count(f.pool,'finance_refund_decision'),0);
  assert.equal((await f.review.reject(f.hqContext,doc.id,{expectedVersion:2,reason:'original unavailable'},randomUUID(),at)).status,'REJECTED');
  assert.deepEqual(await f.balances(),before);
  const other=await f.pending();
  await f.pool.query('UPDATE weekly_fee_entry SET gross_amount_cents=gross_amount_cents+1,version=version+1 WHERE id=$1',[f.refundFee.fee.id]);
  await assert.rejects(f.approve(other),/FINANCE_REFUND_DATA_UNAVAILABLE/);
  assert.deepEqual(await f.balances(),before);assert.equal(await count(f.pool,'weekly_fee_refund_effect'),0);
  assert.equal(await count(f.pool,'finance_refund_decision'),1);
 }finally{await f.close();}
});

test('zero-fee refund marks source without inventing ledger or balance change',async()=>{
 const f=await fixture();try{
  await f.record(0n);const doc=await f.pending(),before=await f.balances(),events=await count(f.pool,'ledger_event');
  await f.approve(doc);assert.deepEqual(await f.balances(),before);assert.equal(await count(f.pool,'ledger_event'),events);
  const decision=(await f.pool.query('SELECT posting_status,ledger_event_id,approved_gross_amount_cents::text gross FROM finance_refund_decision WHERE finance_document_id=$1',[doc.id])).rows[0];
  assert.deepEqual(decision,{posting_status:'NO_BALANCE_CHANGE',ledger_event_id:null,gross:'0'});
  assert.equal(await count(f.pool,'weekly_fee_refund_effect'),1);
 }finally{await f.close();}
});

test('historical ledger mismatch blocks approval rather than guessing original distribution',async()=>{
 const f=await fixture();try{
  const doc=await f.pending(),before=await f.balances();
  await f.pool.query('ALTER TABLE ledger_entry DISABLE TRIGGER USER');
  try{await f.pool.query('UPDATE ledger_entry SET amount_cents=amount_cents+1 WHERE id=(SELECT id FROM ledger_entry LIMIT 1)');}
  finally{await f.pool.query('ALTER TABLE ledger_entry ENABLE TRIGGER USER');}
  await assert.rejects(f.approve(doc),/FINANCE_REFUND_DATA_UNAVAILABLE/);
  assert.deepEqual(await f.balances(),before);assert.equal(await count(f.pool,'weekly_fee_refund_effect'),0);
 }finally{await f.close();}
});

test('refund preserves prior outflows and permits negative balances on original inactive accounts',async()=>{
 const f=await fixture();try{
  const {postLedgerEvent}=await import('@teaching-research-alliance/domain');
  const {createPostgresLedgerTransaction}=await import('../../dist/postgres-ledger-repository.js');
  const {prepareLedgerPosting}=await import('../../dist/postgres-ledger-locks.js');
  const account=(await f.pool.query("SELECT id,account_code FROM settlement_account WHERE owner_type='PERSON' AND owner_id=$1",[f.ids.teacherA])).rows[0];
  const client=await f.pool.connect();
  try{await client.query('BEGIN');await prepareLedgerPosting(client,'synthetic-prior-outflow',[account.account_code]);
   const tx=createPostgresLedgerTransaction(client);
   await postLedgerEvent({transaction:work=>work(tx)},{eventKey:'synthetic-prior-outflow',eventType:'SYNTHETIC_PRIOR_OUTFLOW',payloadHash:'a'.repeat(64),deltas:[{accountKey:account.account_code,categoryKey:'withdrawal',amountCents:-170000n}]},randomUUID);
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  await f.pool.query("UPDATE settlement_account SET status='INACTIVE' WHERE id=$1",[account.id]);
  const doc=await f.pending();await f.approve(doc);
  assert.deepEqual(await f.balances(),[-84000n,88000n,26000n]);
  assert.equal((await f.pool.query("SELECT count(*)::int n FROM ledger_event WHERE event_key='synthetic-prior-outflow'")).rows[0].n,1);
 }finally{await f.close();}
});

test('concurrent fee correction and approval serialize: latest fee refunded or correction refused',async()=>{
 const f=await fixture();try{
  const doc=await f.pending();
  const results=await Promise.allSettled([f.approve(doc),f.record(120000n)]);
  assert.equal(results[0].status,'fulfilled');
  if(results[1].status==='rejected')assert.match(results[1].reason.message,/WEEKLY_FEE_REFUNDED/);
  const fee=(await f.pool.query('SELECT version::text,gross_amount_cents::text gross FROM weekly_fee_entry WHERE id=$1',[f.refundFee.fee.id])).rows[0];
  const effect=(await f.pool.query('SELECT source_weekly_fee_version::text version,gross_amount_cents::text gross FROM weekly_fee_refund_effect WHERE weekly_fee_entry_id=$1',[f.refundFee.fee.id])).rows[0];
  assert.deepEqual(effect,fee);assert.equal(await count(f.pool,'finance_refund_decision'),1);
 }finally{await f.close();}
});

test('refund follows the effective group leader after a valid allocation correction, not the first recipient',async()=>{
 const f=await fixture();try{
  const oldLeader=randomUUID(),newLeader=randomUUID();
  for(const id of [oldLeader,newLeader]){
   await f.pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1,$2,'synthetic leader','ACTIVE')",[id,`leader-${id}`]);
   await f.pool.query("INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('PERSON',$1,$2,'ACTIVE')",[id,`person:${id}`]);
  }
  for(const teacherId of [f.ids.teacherA,f.ids.teacherB])await f.pool.query("INSERT INTO person_relationship(teacher_id,relationship_type,related_person_id,valid_from,created_by) VALUES($1,'GROUP_LEADER',$2,'2026-09-01T00:00:00Z',$3)",[teacherId,oldLeader,f.ids.admin]);
  await f.pool.query(`INSERT INTO rate_policy_version(version,effective_from,policy_json,reason,published_by)
    SELECT 2,effective_from,jsonb_set(policy_json,'{groupLeaderRateBasisPoints}','"500"'::jsonb),'synthetic policy',$1 FROM rate_policy_version WHERE version=1`,[f.ids.admin]);
  await f.record(100000n);
  const doc=await f.pending();
  // The relation-change application layer is separate; this fixture supplies its effective relation result.
  await f.pool.query("UPDATE person_relationship SET related_person_id=$1 WHERE teacher_id=$2 AND relationship_type='GROUP_LEADER'",[newLeader,f.ids.teacherA]);
  await f.weekly.recordAndSettle(f.ids.teacherA,{referralCaseId:f.ids.referralRefund,teachingWeekId:f.ids.weekRefund,venueId:f.ids.venueA,settlementMonth:'2026-09-01',grossAmountCents:100000n,expectedVersion:2},randomUUID());
  const balance=async id=>BigInt((await f.pool.query('SELECT projection.balance_cents::text n FROM settlement_account account JOIN account_balance_projection projection ON projection.account_id=account.id WHERE account.owner_id=$1',[id])).rows[0].n);
  const before=[await balance(oldLeader),await balance(newLeader)];
  await f.approve(doc);
  assert.deepEqual([await balance(oldLeader),await balance(newLeader)],[before[0],before[1]-5000n]);
  const entries=(await f.pool.query("SELECT account.owner_id::text owner,entry.amount_cents::text amount FROM ledger_entry entry JOIN ledger_event event ON event.id=entry.event_id JOIN settlement_account account ON account.id=entry.account_id WHERE event.event_key=$1 AND entry.category_key='groupLeader'",[`weekly-fee-refund:${doc.id}`])).rows;
  assert.deepEqual(entries,[{owner:newLeader,amount:'-5000'}]);
 }finally{await f.close();}
});

test('late persistence failure rolls back ledger, decision, and command so the original key can recover',async()=>{
 const f=await fixture();try{
  const doc=await f.pending(),before=await f.balances(),events=await count(f.pool,'ledger_event');
  await f.pool.query("CREATE FUNCTION synthetic_refund_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_REFUND_WRITE_FAILURE'; END $$");
  await f.pool.query('CREATE TRIGGER synthetic_refund_failure BEFORE INSERT ON weekly_fee_refund_effect FOR EACH ROW EXECUTE FUNCTION synthetic_refund_failure()');
  await assert.rejects(f.approve(doc,'recover-original-key'),/SYNTHETIC_REFUND_WRITE_FAILURE/);
  assert.deepEqual(await f.balances(),before);assert.equal(await count(f.pool,'ledger_event'),events);
  assert.equal(await count(f.pool,'finance_refund_decision'),0);assert.equal(await count(f.pool,'weekly_fee_refund_effect'),0);
  assert.equal((await f.pool.query("SELECT count(*)::int n FROM finance_refund_command_idempotency WHERE operation='APPROVE'")).rows[0].n,0);
  assert.equal((await f.pool.query('SELECT status,version::text FROM finance_document WHERE id=$1',[doc.id])).rows[0].status,'PENDING_APPROVAL');
  await f.pool.query('DROP TRIGGER synthetic_refund_failure ON weekly_fee_refund_effect');
  assert.equal((await f.approve(doc,'recover-original-key')).replay,false);
  assert.equal((await f.approve(doc,'recover-original-key')).replay,true);
  assert.equal(await count(f.pool,'ledger_event'),events+1);
 }finally{await f.close();}
});

test('two distinct overlapping applications race without double reversal, including a multi-month selection',async()=>{
 const f=await fixture();try{
  const octoberWeek=randomUUID();
  await f.pool.query("INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month,status) VALUES($1,$2,4,'REGULAR','2026-10-05','2026-10-11','2026-10-01','OPEN')",[octoberWeek,f.ids.period]);
  const october=await f.weekly.recordAndSettle(f.ids.teacherA,{referralCaseId:f.ids.referralRefund,teachingWeekId:octoberWeek,venueId:f.ids.venueA,settlementMonth:'2026-10-01',grossAmountCents:50000n,expectedVersion:0},randomUUID());
  const one=await f.pending(),many=await f.pending([f.refundFee.fee.id,october.fee.id]);
  const before=(await f.balances()).reduce((a,b)=>a+b);
  const results=await Promise.allSettled([f.approve(one),f.approve(many)]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.match(results.find(result=>result.status==='rejected').reason.message,/WEEKLY_FEE_REFUNDED/);
  const winner=results[0].status==='fulfilled'?one:many;
  const expected=winner.id===one.id?100000n:150000n;
  assert.equal(before-(await f.balances()).reduce((a,b)=>a+b),expected);
  const effects=(await f.pool.query('SELECT finance_document_id::text id FROM weekly_fee_refund_effect')).rows;
  assert.equal(effects.length,winner.id===one.id?1:2);assert.ok(effects.every(effect=>effect.id===winner.id));
  assert.equal(await count(f.pool,'finance_refund_decision'),1);
 }finally{await f.close();}
});
