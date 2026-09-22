import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {PostgresRefundReadService} from '../../dist/postgres-refund-read-service.js';
import {fixture} from './refund-review-fixture.mjs';
const at=new Date('2026-09-21T09:00:00Z');

test('refund reads reject independently corrupted amounts, extra entries and missing entries',async()=>{
 const f=await fixture();try{
  const doc=await f.pending();await f.approve(doc);
  const reads=new PostgresRefundReadService(f.pool);
  const healthy=async()=>{
   assert.equal((await reads.getDetail(f.teacherContext,doc.id,at)).status,'REFUNDED');
   assert.equal((await reads.listOwn(f.teacherContext,at)).documents.length,1);
   assert.equal((await reads.listManaged(f.hqContext)).documents.length,1);
  };
  const corrupt=async()=>{
   await assert.rejects(reads.getDetail(f.teacherContext,doc.id,at),/FINANCE_REFUND_DATA_UNAVAILABLE/);
   await assert.rejects(reads.listOwn(f.teacherContext,at),/FINANCE_REFUND_DATA_UNAVAILABLE/);
   await assert.rejects(reads.listManaged(f.hqContext),/FINANCE_REFUND_DATA_UNAVAILABLE/);
  };
  await healthy();
  const entry=(await f.pool.query("SELECT entry.id,entry.event_id,entry.account_id,entry.category_key,entry.amount_cents::text amount FROM ledger_entry entry JOIN ledger_event event ON event.id=entry.event_id WHERE event.event_key=$1 ORDER BY entry.id LIMIT 1",[`weekly-fee-refund:${doc.id}`])).rows[0];
  const alter=async(sql,args)=>{await f.pool.query('ALTER TABLE ledger_entry DISABLE TRIGGER ledger_entry_immutable');try{await f.pool.query(sql,args);}finally{await f.pool.query('ALTER TABLE ledger_entry ENABLE TRIGGER ledger_entry_immutable');}};
  await alter('UPDATE ledger_entry SET amount_cents=amount_cents-1 WHERE id=$1',[entry.id]);
  await corrupt();
  await alter('UPDATE ledger_entry SET amount_cents=$2 WHERE id=$1',[entry.id,entry.amount]);
  await healthy();
  const extra=randomUUID();
  await f.pool.query("INSERT INTO ledger_entry(id,event_id,account_id,category_key,amount_cents) VALUES($1,$2,$3,'unexpected-refund-category',-1)",[extra,entry.event_id,entry.account_id]);
  await corrupt();
  await alter('DELETE FROM ledger_entry WHERE id=$1',[extra]);
  await healthy();
  await alter('DELETE FROM ledger_entry WHERE id=$1',[entry.id]);
  await corrupt();
  await f.pool.query('INSERT INTO ledger_entry(id,event_id,account_id,category_key,amount_cents) VALUES($1,$2,$3,$4,$5)',[entry.id,entry.event_id,entry.account_id,entry.category_key,entry.amount]);
  await healthy();
 }finally{await f.close();}
});
