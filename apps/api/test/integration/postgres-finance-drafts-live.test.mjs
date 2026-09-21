import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresFinanceDraftService } from "../../dist/postgres-finance-draft-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";
import {createApiServer,SessionService,PostgresFinanceAttachmentService} from '../../dist/main.js';

const at = new Date("2026-09-21T04:00:00.000Z");
const contextFor = (personId, subject = "TEACHING_TEACHER") => ({ personId, subject });

test("真实 PostgreSQL 财务草稿仅创建本人元数据，幂等并发且不动账本", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const { pool } = db;
  const [teacherId, plannerId, otherTeacherId] = Array.from({ length: 3 }, () => randomUUID());
  try {
    for (const id of [teacherId, plannerId, otherTeacherId]) {
      await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES ($1::uuid,$2,'合成人员','ACTIVE')", [id, `finance-${id}`]);
    }
    const service = new PostgresFinanceDraftService(pool);
    const ledgerBefore = await pool.query("SELECT (SELECT count(*) FROM ledger_event)::int AS events,(SELECT count(*) FROM ledger_entry)::int AS entries,(SELECT count(*) FROM account_balance_projection)::int AS projections");
    const results = await Promise.all(Array.from({ length: 4 }, () => service.create(
      contextFor(teacherId), { kind: "REIMBURSEMENT" }, "finance-same-key", at
    )));
    assert.equal(results.filter((result) => !result.replay).length, 1);
    assert.equal(new Set(results.map((result) => result.id)).size, 1);
    const created = results[0];
    assert.deepEqual(created, {
      id: created.id,
      kind: "REIMBURSEMENT",
      status: "DRAFT",
      version: 1,
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
      replay: created.replay
    });
    assert.deepEqual(await service.getOwn(contextFor(teacherId), created.id), {
      id: created.id,
      kind: "REIMBURSEMENT",
      status: "DRAFT",
      version: 1,
      createdAt: at.toISOString(),
      updatedAt: at.toISOString()
    });
    assert.deepEqual(await service.listOwn(contextFor(teacherId)), [{
      id: created.id,
      kind: "REIMBURSEMENT",
      status: "DRAFT",
      version: 1,
      createdAt: at.toISOString(),
      updatedAt: at.toISOString()
    }]);
    await assert.rejects(service.getOwn(contextFor(otherTeacherId), created.id), /FINANCE_DOCUMENT_NOT_FOUND/);
    assert.deepEqual(await service.listOwn(contextFor(otherTeacherId)), []);
    await assert.rejects(service.create(contextFor(teacherId), { kind: "WITHDRAWAL" }, "finance-same-key", at), /IDEMPOTENCY_REPLAY/);
    await assert.rejects(service.create({ personId: teacherId, subject: "HEADQUARTERS_FINANCE" }, { kind: "WITHDRAWAL" }, "finance-forbidden", at), /FORBIDDEN_SCOPE/);
    await assert.rejects(service.create(contextFor(plannerId, "ACADEMIC_PLANNER"), { kind: "NOT_A_KIND" }, "finance-invalid", at), /INVALID_INPUT/);
    assert.deepEqual((await pool.query("SELECT event_type,actor_person_id::text AS actor_person_id,result_document_version::text AS result_document_version FROM finance_document_event WHERE finance_document_id=$1", [created.id])).rows[0], { event_type: "CREATED", actor_person_id: teacherId, result_document_version: "1" });
    assert.deepEqual((await pool.query("SELECT (SELECT count(*) FROM ledger_event)::int AS events,(SELECT count(*) FROM ledger_entry)::int AS entries,(SELECT count(*) FROM account_balance_projection)::int AS projections")).rows[0], ledgerBefore.rows[0]);
    await assert.rejects(pool.query("UPDATE finance_document_event SET event_type='CREATED' WHERE finance_document_id=$1", [created.id]), /FINANCE_DOCUMENT_EVENT_IMMUTABLE/);
    await assert.rejects(pool.query("DELETE FROM finance_document_event WHERE finance_document_id=$1",[created.id]),/FINANCE_DOCUMENT_EVENT_IMMUTABLE/);
    await assert.rejects(pool.query("DELETE FROM finance_draft_idempotency WHERE actor_person_id=$1", [teacherId]), /FINANCE_DRAFT_IDEMPOTENCY_IMMUTABLE/);
    await pool.query("UPDATE finance_document SET version=2,kind='WITHDRAWAL',updated_at='2026-09-22' WHERE id=$1",[created.id]);
    assert.deepEqual(await service.create(contextFor(teacherId),{kind:'REIMBURSEMENT'},'finance-same-key',new Date('2026-09-23')),{...created,replay:true});
  } finally {
    await db.close();
  }
});

test("财务草稿事件或幂等写入失败时完整回滚", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const { pool } = db;
  const teacherId = randomUUID();
  try {
    await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES ($1::uuid,$2,'合成人员','ACTIVE')", [teacherId, `finance-rollback-${teacherId}`]);
    const service = new PostgresFinanceDraftService(pool);
    await pool.query("CREATE FUNCTION fail_finance_draft_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'FORCED_FINANCE_EVENT_FAILURE'; END; $$");
    await pool.query("CREATE TRIGGER fail_finance_draft_event BEFORE INSERT ON finance_document_event FOR EACH ROW EXECUTE FUNCTION fail_finance_draft_event()");
    await assert.rejects(service.create(contextFor(teacherId), { kind: "SELF_PURCHASE" }, "finance-rollback", at), /FORCED_FINANCE_EVENT_FAILURE/);
    await pool.query("DROP TRIGGER fail_finance_draft_event ON finance_document_event");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM finance_document")).rows[0].n, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM finance_document_event")).rows[0].n, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM finance_draft_idempotency")).rows[0].n, 0);
    await pool.query("CREATE TRIGGER fail_finance_draft_idem BEFORE INSERT ON finance_draft_idempotency FOR EACH ROW EXECUTE FUNCTION fail_finance_draft_event()");
    await assert.rejects(service.create(contextFor(teacherId),{kind:'SELF_PURCHASE'},'finance-rollback',at),/FORCED_FINANCE_EVENT_FAILURE/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM finance_document")).rows[0].n,0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM finance_document_event")).rows[0].n,0);
  } finally {
    await db.close();
  }
});

test('财务草稿真实HTTP拒绝伪造身份与金额，仅本人可读且创建不等于提交',async()=>{
 const db=await createTestDatabase(process.env.DATABASE_URL);
 const [owner,other]=[randomUUID(),randomUUID()];
 let server;
 try{
  for(const id of [owner,other])await db.pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES ($1,$2,'合成老师','ACTIVE')",[id,`draft-http-${id}`]);
  let counter=0;
  const sessions=new SessionService({accounts:[owner,other].map((id,index)=>({accountId:id,personId:id,phoneNormalized:`1380000000${index}`,credentialDigest:'synthetic-draft',status:'ACTIVE'})),assignments:[owner,other].flatMap(personId=>[{personId,subject:'TEACHING_TEACHER',scope:'SELF',validFrom:new Date('2026-01-01')},{personId,subject:'HEADQUARTERS_FINANCE',scope:'GLOBAL',validFrom:new Date('2026-01-01')}]),sessionIdFactory:()=>`draft-token-${++counter}`});
  for(let i=0;i<2;i++){sessions.login(`1380000000${i}`,'synthetic-draft',at);sessions.switchRole(`draft-token-${i+1}`,'TEACHING_TEACHER',at);}
  server=createApiServer({sessions,weeklyFees:{},financeDrafts:new PostgresFinanceDraftService(db.pool),financeAttachments:new PostgresFinanceAttachmentService(db.pool),now:()=>at});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const url=`http://127.0.0.1:${server.address().port}/v1/finance/drafts`;
  const request=(path='',body,token='draft-token-1')=>fetch(url+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const command={kind:'WITHDRAWAL',idempotencyKey:'http-draft'};
  for(const field of ['applicantPersonId','personId','status','amountCents','bankAccount','balance'])assert.equal((await request('',{...command,[field]:other})).status,400);
  const createdResponse=await request('',command);assert.equal(createdResponse.status,200);
  const created=(await createdResponse.json()).data;assert.equal(created.status,'DRAFT');
  assert.equal((await request(`/${created.id}`)).status,200);
  assert.equal((await (await request('',command)).json()).data.replay,true);
  assert.equal((await request('',{...command,kind:'REFUND'})).status,409);
  assert.equal((await request(`/${created.id}`,undefined,'draft-token-2')).status,404);
  assert.equal((await request(`/${randomUUID()}`,undefined,'draft-token-2')).status,404);
  const mine=(await (await request(`/mine?personId=${other}`)).json()).data;
  assert.equal(mine.length,1);assert.equal(mine[0].id,created.id);
  assert.deepEqual(Object.keys(mine[0]).sort(),['createdAt','id','kind','status','updatedAt','version']);
  assert.equal((await fetch(`${url}/mine`)).status,401);
  const uploadPath=`/${created.id}/attachment-uploads`;
  const upload={purpose:'APPLICATION_SCREENSHOT',originalFilename:'synthetic.png',declaredMediaType:'image/png',declaredSizeBytes:100,idempotencyKey:'http-upload-reservation'};
  for(const field of ['storagePath','status','uploadedBy','actorPersonId','sha256'])assert.equal((await request(uploadPath,{...upload,[field]:other})).status,400);
  assert.equal((await request(uploadPath,upload,'draft-token-2')).status,404);
  const reservedResponse=await request(uploadPath,upload);assert.equal(reservedResponse.status,200);
  const reserved=(await reservedResponse.json()).data;assert.equal(reserved.status,'UPLOADING');
  assert.equal((await (await request(uploadPath,upload)).json()).data.replay,true);
  const attachmentUrl=url.replace(/\/drafts$/,'')+`/attachment-uploads/${reserved.versionId}`;
  const metadataResponse=await fetch(attachmentUrl,{headers:{authorization:'Bearer draft-token-1'}});assert.equal(metadataResponse.status,200);
  const metadata=(await metadataResponse.json()).data;assert.equal(metadata.versionId,reserved.versionId);
  assert.equal(metadata.status,'UPLOADING');assert.equal(metadata.storagePath,undefined);
  assert.equal((await fetch(attachmentUrl,{headers:{authorization:'Bearer draft-token-2'}})).status,404);
  assert.equal((await fetch(attachmentUrl)).status,401);
  sessions.switchRole('draft-token-1','HEADQUARTERS_FINANCE',at);
  assert.equal((await request('/mine')).status,403);
  assert.equal((await request(`/${created.id}`)).status,403);
  assert.equal((await fetch(attachmentUrl,{headers:{authorization:'Bearer draft-token-1'}})).status,403);
  assert.equal((await request('',{...command,idempotencyKey:'hq-draft'})).status,403);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ledger_event')).rows[0].n,0);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await db.close();}
});
