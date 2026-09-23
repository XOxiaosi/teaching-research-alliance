import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer, SessionService, WeeklyFeeService } from "../dist/main.js";

const now = new Date("2026-09-20T10:00:00.000Z");

test("管理员人员关系入口在认证或解析失败时也禁止缓存", async () => {
  const server = createApiServer(createServices());
  const baseUrl = await listen(server);
  try {
    for (const [path, options] of [
      ["/v1/admin/person-relationships/group-leader-candidates", {}],
      ["/v1/admin/person-relationships/preview", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }],
      ["/v1/admin/person-relationships", { method: "DELETE" }],
    ]) {
      const response = await fetch(baseUrl + path, options);
      assert.ok(response.status >= 400);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      await response.arrayBuffer();
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

const createServices = () => {
  const sessions = new SessionService({
    accounts: [{
      accountId: "account-server",
      personId: "teacher-server",
      phoneNormalized: "13800000001",
      credentialDigest: "digest-server",
      status: "ACTIVE"
    }],
    assignments: [{
      personId: "teacher-server",
      subject: "TEACHING_TEACHER",
      scope: "SELF",
      validFrom: new Date("2026-01-01")
    }],
    sessionIdFactory: () => "session-server"
  });
  return {
    sessions,
    referralAcceptance: { accept: async (context, referralId, draft, key) => {
      assert.equal(context.personId, "teacher-server");
      assert.deepEqual(draft, {expectedVersion: 1, venueId: "venue-server"});
      assert.equal(key, "accept-server");
      return {referralId, version: 2, venueId: draft.venueId, replay: false};
    } },
    weeklyFees: new WeeklyFeeService({
      referrals: [{ id: "ref-server", receiverPersonId: "teacher-server", status: "PENDING" }],
      teachingWeeks: [{ id: "week-server", settlementMonth: "2026-09-01", status: "OPEN" }],
      venues: [{ id: "venue-server", status: "ACTIVE" }]
    }),
    now: () => now,
    personal: {
      getOwnOverview: async context => ({ personId: context.personId, balanceCents: -100n }),
      listAvailableVenues: async () => [{ id: "venue-server", name: "合成场地", isOwn: true }]
    }
  };
};

const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}`;
};

test("真实HTTP监听器提供健康检查并序列化周费用金额", async () => {
  const server = createApiServer(createServices());
  const baseUrl = await listen(server);
  try {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { service: "teaching-research-alliance-api", status: "ok" });

    const login = await fetch(`${baseUrl}/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phoneNormalized: "13800000001", credentialDigest: "digest-server" })
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json();
    assert.equal(loginBody.data.sessionId, "session-server");

    const switchRole = await fetch(`${baseUrl}/v1/role-contexts/switch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "session-server", subject: "TEACHING_TEACHER" })
    });
    assert.equal(switchRole.status, 200);
    const own = await fetch(`${baseUrl}/v1/me?personId=another-teacher`, { headers: { authorization: "Bearer session-server" } });
    assert.equal(own.status, 200);
    assert.deepEqual((await own.json()).data, { personId: "teacher-server", balanceCents: "-100" });
    const venues = await fetch(`${baseUrl}/v1/venues/available`, { headers: { authorization: "Bearer session-server" } });
    assert.equal(venues.status, 200);
    assert.equal((await venues.json()).data[0].id, "venue-server");
    assert.equal((await fetch(`${baseUrl}/v1/me`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/v1/me`, { headers: { authorization: "Basic forged" } })).status, 401);

    const accepted = await fetch(`${baseUrl}/v1/referrals/ref-server/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "session-server", expectedVersion: 1, venueId: "venue-server", idempotencyKey: "accept-server" })
    });
    assert.equal(accepted.status, 200);

    const fee = await fetch(`${baseUrl}/v1/referrals/ref-server/weekly-fees`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-server",
        teachingWeekId: "week-server",
        venueId: "venue-server",
        settlementMonth: "2026-09-01",
        grossAmountCents: "100000",
        expectedVersion: 0,
        idempotencyKey: "server-request-1"
      })
    });
    assert.equal(fee.status, 200);
    const feeBody = await fee.json();
    assert.equal(feeBody.data.grossAmountCents, "100000");

    const unsupported = await fetch(`${baseUrl}/v1/session`, { method: "PUT" });
    assert.equal(unsupported.status, 405);
    assert.equal((await unsupported.json()).error.code, "METHOD_NOT_ALLOWED");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('附件二进制流独立于JSON上限，仍验证会话并隐藏内部异常',async()=>{
 const services=createServices();let calls=0;
 services.sessions.login('13800000001','digest-server',now);
 services.sessions.switchRole('session-server','TEACHING_TEACHER',now);
 const payload=Buffer.alloc(1_048_577,7);
 services.financeAttachmentUploads={upload:async(context,version,chunks)=>{
  calls++;assert.equal(context.personId,'teacher-server');
  if(version==='forbidden')throw new Error('FORBIDDEN_SCOPE');
  if(version==='internal')throw new Error('private database and filesystem details');
  let size=0;for await(const chunk of chunks){size+=chunk.length;assert.ok(chunk.every(byte=>byte===7));}
  assert.equal(size,payload.length);return {versionId:version,status:'READY',actualSizeBytes:size};
 }};
 const server=createApiServer(services);const baseUrl=await listen(server);
 const post=(version,body=payload,headers={authorization:'Bearer session-server','content-type':'application/octet-stream'})=>fetch(`${baseUrl}/v1/finance/attachment-uploads/${version}/content`,{method:'POST',headers,body});
 try{
  const response=await post('synthetic-version');assert.equal(response.status,200);assert.equal((await response.json()).data.actualSizeBytes,payload.length);
  assert.equal((await post('unauthenticated',Buffer.from('small'),{'content-type':'application/octet-stream'})).status,401);
  assert.equal((await post('invalid-type',Buffer.from('small'),{authorization:'Bearer session-server','content-type':'multipart/form-data'})).status,400);
  assert.equal(calls,1);
  assert.equal((await post('forbidden',Buffer.from('small'))).status,403);
  const internal=await post('internal',Buffer.from('small'));assert.equal(internal.status,500);
  assert.deepEqual((await internal.json()).error,{code:'INTERNAL_ERROR',message:'INTERNAL_ERROR'});
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('附件下载完成授权后才发送原件，禁缓存并安全编码文件名',async()=>{
 const services=createServices();let calls=0;
 services.sessions.login('13800000001','digest-server',now);
 services.sessions.switchRole('session-server','TEACHING_TEACHER',now);
 const bytes=Buffer.from('%PDF- synthetic download');
 services.financeAttachmentReads={readOwn:async(context,version)=>{
  calls++;assert.equal(context.personId,'teacher-server');
  if(version==='corrupt')throw new Error('ATTACHMENT_INTEGRITY_FAILED');
  return {bytes,mediaType:'application/pdf',originalFilename:"凭证'(1).pdf",sha256:'synthetic',sizeBytes:bytes.length};
 }};
 const server=createApiServer(services);const baseUrl=await listen(server);
 try{
  const url=`${baseUrl}/v1/finance/attachments/synthetic/content`;
  assert.equal((await fetch(url)).status,401);assert.equal(calls,0);
  const response=await fetch(url,{headers:{authorization:'Bearer session-server'}});
  assert.equal(response.status,200);assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.equal(response.headers.get('content-type'),'application/pdf');
  assert.match(response.headers.get('content-disposition'),/^attachment; filename\*=UTF-8''/);
  assert.match(response.headers.get('content-disposition'),/%27%281%29\.pdf$/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  const corrupt=await fetch(`${baseUrl}/v1/finance/attachments/corrupt/content`,{headers:{authorization:'Bearer session-server'}});
  assert.equal(corrupt.status,500);assert.equal((await corrupt.json()).error.code,'ATTACHMENT_INTEGRITY_FAILED');
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('未配置财务存储或密钥时明确不可用，不伪造上传或提现成功',async()=>{
 const services=createServices();
 services.sessions.login('13800000001','digest-server',now);
 services.sessions.switchRole('session-server','TEACHING_TEACHER',now);
 const server=createApiServer(services),baseUrl=await listen(server);
 const headers={authorization:'Bearer session-server'};
 try{
  for(const [path,method,body,type] of [
   ['/v1/finance/attachment-uploads/version/content','POST',Buffer.from('test'),'application/octet-stream'],
   ['/v1/finance/attachments/version/content','GET',undefined,undefined],
   ['/v1/finance/drafts/document/withdrawal-submit','POST','{}','application/json'],
   ['/v1/finance/attachments/attachment/versions','POST','{}','application/json'],
   ['/v1/finance/documents/document/attachments','GET',undefined,undefined]
  ]){
   const response=await fetch(baseUrl+path,{method,headers:{...headers,...(type?{'content-type':type}:{})},...(body===undefined?{}:{body})});
   assert.equal(response.status,503);assert.equal(response.headers.get('cache-control'),'private, no-store');
   const envelope=await response.json();assert.equal(envelope.data,undefined);
   assert.ok(['ATTACHMENT_STORAGE_UNAVAILABLE','FINANCE_SERVICE_UNAVAILABLE'].includes(envelope.error.code));
  }
 }finally{await new Promise(resolve=>server.close(resolve));}
});
