import assert from 'node:assert/strict';
import test from 'node:test';
import { TeacherApiClient, StaleResponseError } from '../dist/index.js';
const ok = data => ({status:200,body:{data}});
const session = (subject='SYSTEM_ADMIN',extra={}) => {
  const context={subject,scope:'GLOBAL',personId:'person',...extra};
  return {sessionId:'token',accountId:'account',personId:'person',roleContexts:[context],currentRoleContext:context};
};
const registration={nickname:'新成员',legalName:'合成姓名',phoneNormalized:'13800000000',password:'  pass1234  '};
const draft={accountId:'target/id',newPassword:'  new1234  ',reason:'合成重置'};
const login=client=>client.login({phoneNormalized:'13800000000',password:'password'});

test('注册只传普通身份字段且会话不保留密码或响应额外字段',async()=>{
  const requests=[];
  const client=new TeacherApiClient({transport:async request=>{
    requests.push(request);
    return request.path==='/v1/session'?ok(session()):ok({...session('TEACHER',{scope:'SELF'}),nickname:'新成员',password:'forged'});
  }});
  await login(client);
  const result=await client.registerAccount({...registration,subject:'SYSTEM_OWNER'});
  assert.deepEqual(requests[1].body,registration);
  assert.equal(requests[1].headers.authorization,undefined);
  assert.equal(result.password,undefined);
  assert.equal(client.currentSession.password,undefined);
  assert.equal(client.currentSession.currentRoleContext.subject,'TEACHER');
});

test('迟到注册响应不覆盖新的登录，失败注册也不保留旧会话',async()=>{
  let resolve;
  const client=new TeacherApiClient({transport:async r=>r.path==='/v1/session'?ok(session()):new Promise(r=>resolve=r)});
  const pending=client.registerAccount(registration);
  await login(client);
  resolve(ok({...session('TEACHER'),nickname:'新成员'}));
  await assert.rejects(pending,StaleResponseError);
  assert.equal(client.currentSession.currentRoleContext.subject,'SYSTEM_ADMIN');
  const failing=new TeacherApiClient({transport:async r=>r.path==='/v1/session'?ok(session()):{status:409,body:{error:{code:'DUPLICATE',message:'duplicate'}}}});
  await login(failing);
  await assert.rejects(failing.registerAccount(registration));
  assert.equal(failing.currentSession,null);
});

test('账号目录及重置严格要求无附加范围的GLOBAL管理身份',async()=>{
  for(const [subject,extra] of [['TEACHER',{}],['HEADQUARTERS_FINANCE',{}],['SYSTEM_ADMIN',{scope:'SELF'}],['SYSTEM_OWNER',{campusId:'campus'}]]){
    let commands=0;
    const client=new TeacherApiClient({transport:async r=>{if(r.path==='/v1/session')return ok(session(subject,extra));commands++;return ok([]);}});
    await login(client);
    await assert.rejects(client.listAccounts(),e=>e.code==='FORBIDDEN_SCOPE');
    assert.throws(()=>client.createAccountPasswordResetSubmission(draft),e=>e.code==='FORBIDDEN_SCOPE');
    assert.equal(commands,0);
  }
});

test('密码重置冻结目标与密钥，未知结果以同一键重试，目录直接取服务端',async()=>{
  const requests=[];let attempts=0;
  const directory=[{accountId:'target/id',nickname:'目标'}];
  const client=new TeacherApiClient({idempotencyKeyFactory:()=> 'same-key',transport:async r=>{
    if(r.path==='/v1/session')return ok(session());
    requests.push(r);
    if(r.path==='/v1/admin/accounts')return ok(directory);
    if(++attempts===1)throw new Error('lost response');
    return ok({accountId:'target/id',personId:'target',authVersion:'2',resetAt:'2026-09-23T00:00:00Z',replay:true});
  }});
  await login(client);
  assert.deepEqual(await client.listAccounts(),directory);
  const mutable={...draft,actorPersonId:'forged'};
  const submission=client.createAccountPasswordResetSubmission(mutable);
  mutable.newPassword='changed';
  assert.equal(Object.isFrozen(submission.draft),true);
  await assert.rejects(client.resetAccountPassword(submission),/lost response/);
  assert.equal(client.submissionStatus(submission),'FAILED');
  assert.equal((await client.resetAccountPassword(submission)).replay,true);
  assert.deepEqual(requests[1],requests[2]);
  assert.equal(requests[1].path,'/v1/admin/accounts/target%2Fid/password-reset');
  assert.deepEqual(requests[1].body,{newPassword:draft.newPassword,reason:draft.reason,idempotencyKey:'same-key'});
  assert.equal(client.currentSession.accountId,'account');
});

test('退出后旧重置禁止重试；本人重置成功清空失效会话',async()=>{
  let commands=0;
  const client=new TeacherApiClient({transport:async r=>{
    if(r.path==='/v1/session')return ok(session('SYSTEM_OWNER'));
    commands++;return ok({accountId:'account',personId:'person',authVersion:'2',resetAt:'now',replay:false});
  }});
  await login(client);
  const old=client.createAccountPasswordResetSubmission(draft);
  client.logout();await login(client);
  await assert.rejects(client.resetAccountPassword(old));
  assert.equal(commands,0);
  await client.resetAccountPassword(client.createAccountPasswordResetSubmission({...draft,accountId:'account'}));
  assert.equal(client.currentSession,null);
});

test('密码长度校验保持原值，不截断或规范化',async()=>{
  const client=new TeacherApiClient({transport:async()=>ok(session())});
  await login(client);
  for(const password of ['short','x'.repeat(1025)]){
    await assert.rejects(client.registerAccount({...registration,password}),e=>e.code==='INVALID_INPUT');
    assert.throws(()=>client.createAccountPasswordResetSubmission({...draft,newPassword:password}),e=>e.code==='INVALID_INPUT');
  }
});
