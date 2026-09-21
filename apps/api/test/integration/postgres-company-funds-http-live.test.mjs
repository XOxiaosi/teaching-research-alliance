import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApiServer,SessionService} from '../../dist/main.js';
import {PostgresCompanyFundService} from '../../dist/postgres-company-fund-service.js';
import {createTestDatabase} from './postgres-test-database.mjs';

test('财务业务账户真实HTTP：仅管理员配置、资金主体稳定、切换与停用不改个人账',async()=>{
  const db=await createTestDatabase(process.env.DATABASE_URL),pool=db.pool;
  const admin=randomUUID(),finance=randomUUID(),teacher=randomUUID();
  let at=new Date('2026-09-21T04:00:00Z'),server;
  try{
    for(const [id,name] of [[admin,'admin'],[finance,'finance'],[teacher,'teacher']])await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1,$2,'合成成员','ACTIVE')",[id,`fund-http-${name}`]);
    const personAccount=randomUUID();
    await pool.query("INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1,'PERSON',$2,$3,'ACTIVE')",[personAccount,finance,`person:${finance}`]);
    await pool.query('INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1,2000)',[personAccount]);
    const subjects=['SYSTEM_ADMIN','HEADQUARTERS_FINANCE','TEACHING_TEACHER'];
    let counter=0;
    const sessions=new SessionService({accounts:[admin,finance,teacher].map((id,index)=>({accountId:id,personId:id,phoneNormalized:`1370000000${index}`,credentialDigest:'synthetic-only',status:'ACTIVE'})),
      assignments:[admin,finance,teacher].map((personId,index)=>({personId,subject:subjects[index],scope:index===2?'SELF':'GLOBAL',validFrom:new Date('2026-01-01')})),sessionIdFactory:()=>`fund-token-${++counter}`});
    subjects.forEach((subject,index)=>{sessions.login(`1370000000${index}`,'synthetic-only',at);sessions.switchRole(`fund-token-${index+1}`,subject,at);});
    server=createApiServer({sessions,weeklyFees:{},companyFunds:new PostgresCompanyFundService(pool),now:()=>at});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const base=`http://127.0.0.1:${server.address().port}/v1/admin/company-funds`;
    const request=(path='',body,who=1)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer fund-token-${who}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const success=async response=>{assert.equal(response.status,200,JSON.stringify(await response.clone().json()));return (await response.json()).data;};
    assert.equal((await fetch(base)).status,401);
    assert.equal((await request('',undefined,2)).status,403);
    const create={fundCode:'HQ_OPERATING_TEST',displayName:'合成财务业务账户',idempotencyKey:'fund-create'};
    for(const extra of ['ownerId','ownerType','initialBalanceCents','accountCode','personId'])assert.equal((await request('',{...create,[extra]:'forged'})).status,400);
    assert.equal((await request('',create,3)).status,403);
    const fund=await success(await request('',create));
    assert.equal((await success(await request('',create))).id,fund.id);
    assert.equal((await request(`/${fund.id}/status`,{expectedVersion:1,status:'INACTIVE',reason:'unauthorized',idempotencyKey:'hq-status'},2)).status,403);
    assert.equal((await request(`/${randomUUID()}/status`,{expectedVersion:1,status:'INACTIVE',reason:'missing',idempotencyKey:'missing-status'})).status,404);
    assert.equal((await request('/not-a-uuid/status',{expectedVersion:1,status:'INACTIVE',reason:'invalid',idempotencyKey:'invalid-status'})).status,400);
    const saved=(await pool.query('SELECT owner_type,owner_id::text AS owner_id FROM settlement_account WHERE id=$1',[fund.accountId])).rows[0];
    assert.deepEqual(saved,{owner_type:'COMPANY',owner_id:fund.id});assert.notEqual(fund.id,finance);
    assert.equal((await request('',{...create,displayName:'different'})).status,409);
    assert.equal((await request(`/${fund.id}/assignment`,{reason:'缺少旧映射校验',idempotencyKey:'invalid-assign'})).status,400);
    const assign={expectedAssignmentId:null,reason:'配置首个财务支出账户',idempotencyKey:'fund-assign'};
    const assigned=await success(await request(`/${fund.id}/assignment`,assign));
    assert.equal(assigned.fundId,fund.id);
    assert.equal((await success(await request(`/${fund.id}/assignment`,assign))).id,assigned.id);
    const second=await success(await request('',{fundCode:'HQ_SECOND_TEST',displayName:'合成第二账户',idempotencyKey:'fund-create-second'}));
    at=new Date(at.getTime()+1000);
    assert.equal((await request(`/${second.id}/assignment`,{...assign,idempotencyKey:'stale-mapping'})).status,409);
    const next=await success(await request(`/${second.id}/assignment`,{expectedAssignmentId:assigned.id,reason:'后续业务改用第二账户',idempotencyKey:'fund-reassign'}));
    assert.equal(next.previousAssignmentId,assigned.id);
    const response=await request();assert.equal(response.headers.get('cache-control'),'private, no-store');
    const list=await success(response);assert.equal(list.funds.length,2);assert.equal(list.currentAssignment.id,next.id);
    const statusCommand={expectedVersion:second.version,status:'INACTIVE',reason:'停用测试业务账户',idempotencyKey:'fund-stop'};
    const stopped=await success(await request(`/${second.id}/status`,statusCommand));assert.equal(stopped.status,'INACTIVE');
    assert.equal((await success(await request(`/${second.id}/status`,statusCommand))).replay,true);
    assert.equal((await pool.query('SELECT status FROM settlement_account WHERE id=$1',[second.accountId])).rows[0].status,'INACTIVE');
    assert.equal((await pool.query('SELECT balance_cents::text AS amount FROM account_balance_projection WHERE account_id=$1',[personAccount])).rows[0].amount,'2000');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ledger_event')).rows[0].n,0);
  }finally{if(server)await new Promise(resolve=>server.close(resolve));await db.close();}
});
