import assert from "node:assert/strict";
import test from "node:test";
import {
  ApiClientError,
  formatCentsAsBeans,
  parseBeanAmountToCents,
  RoleSelectionRequiredError,
  StaleResponseError,
  TeacherApiClient
} from "../dist/index.js";

const teacherSession = (subject = "TEACHING_TEACHER") => ({
  sessionId: "session-1",
  accountId: "account-1",
  personId: "person-1",
  roleContexts: [{ subject: "TEACHING_TEACHER", personId: "person-1" }, { subject: "ACADEMIC_PLANNER", personId: "person-1" }],
  currentRoleContext: { subject, personId: "person-1" }
});

const success = (data) => ({ status: 200, body: { version: "test", data } });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
};

test("欢乐豆金额以BigInt精确解析和格式化", () => {
  assert.equal(parseBeanAmountToCents("0"), "0");
  assert.equal(parseBeanAmountToCents("0.01"), "1");
  assert.equal(parseBeanAmountToCents("9007199254740993.01"), "900719925474099301");
  assert.equal(formatCentsAsBeans("0"), "0.00");
  assert.equal(formatCentsAsBeans("1"), "0.01");
  assert.equal(formatCentsAsBeans("900719925474099301"), "9007199254740993.01");
  assert.equal(formatCentsAsBeans("-1"), "-0.01");
  assert.equal(formatCentsAsBeans("-900719925474099301"), "-9007199254740993.01");
  for (const value of ["", "-1", "1.234", "1e3", "0x10"]) {
    assert.throws(() => parseBeanAmountToCents(value), ApiClientError);
  }
  for (const value of ["", "1.0", "1e3", "0x10"]) {
    assert.throws(() => formatCentsAsBeans(value), ApiClientError);
  }
});

test("角色切换作废在途响应且不把旧角色数据写入缓存", async () => {
  const me = deferred();
  let meRequests = 0;
  const client = new TeacherApiClient({
    transport: async (request) => {
      if (request.path === "/v1/session" && request.method === "POST") return success(teacherSession());
      if (request.path === "/v1/me") {
        meRequests += 1;
        if (meRequests === 1) return me.promise;
        return success({ role: "ACADEMIC_PLANNER" });
      }
      if (request.path === "/v1/role-contexts/switch") return success(teacherSession("ACADEMIC_PLANNER"));
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const oldRequest = client.getMe();
  await client.switchRole("ACADEMIC_PLANNER");
  me.resolve(success({ role: "TEACHING_TEACHER" }));
  await assert.rejects(oldRequest, StaleResponseError);
  assert.deepEqual(await client.getMe(), { role: "ACADEMIC_PLANNER" });
  assert.equal(meRequests, 2);
});

test("本地退出作废在途响应并清除会话", async () => {
  const venues = deferred();
  const client = new TeacherApiClient({
    transport: async (request) => {
      if (request.path === "/v1/session") return success(teacherSession());
      if (request.path === "/v1/venues/available") return venues.promise;
      throw new Error(`unexpected ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const oldRequest = client.listAvailableVenues();
  client.logout();
  venues.resolve(success([{ id: "venue-1" }]));
  await assert.rejects(oldRequest, StaleResponseError);
  assert.equal(client.currentSession, null);
});

test("读取每次向服务端刷新，成功写入作废更早读取", async () => {
  const oldOverview = deferred();
  let overviewRequests = 0;
  const client = new TeacherApiClient({
    transport: async (request) => {
      if (request.path === "/v1/session") return success(teacherSession());
      if (request.path === "/v1/referrals/ref-1/accept") return success({ referralStatus: "ACCEPTED" });
      if (request.path === "/v1/me") {
        overviewRequests += 1;
        if (overviewRequests === 1) return oldOverview.promise;
        return success({ balanceCents: String(overviewRequests) });
      }
      throw new Error(`unexpected ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const earlyRead = client.getOwnOverview();
  await client.acceptReferral("ref-1");
  oldOverview.resolve(success({ balanceCents: "old" }));
  await assert.rejects(earlyRead, StaleResponseError);
  assert.deepEqual(await client.getOwnOverview(), { balanceCents: "2" });
  assert.deepEqual(await client.getOwnOverview(), { balanceCents: "3" });
  assert.equal(overviewRequests, 3);
});

test("周费用失败后重试保持同一幂等键，修改参数建立新提交", async () => {
  const keys = [];
  let attempt = 0;
  const client = new TeacherApiClient({
    idempotencyKeyFactory: (() => {
      let id = 0;
      return () => `key-${++id}`;
    })(),
    transport: async (request) => {
      if (request.path === "/v1/session") return success(teacherSession());
      if (request.path === "/v1/referrals/ref-1/weekly-fees") {
        keys.push(request.body.idempotencyKey);
        attempt += 1;
        if (attempt === 1) throw new Error("network uncertain");
        return success({ grossAmountCents: request.body.grossAmountCents });
      }
      throw new Error(`unexpected ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const first = client.createWeeklyFeeSubmission({
    referralCaseId: "ref-1", teachingWeekId: "week-1", venueId: "venue-1",
    settlementMonth: "2026-09-01", grossAmountCents: "9007199254740993", expectedVersion: 4
  });
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.draft), true);
  assert.throws(() => { first.draft.grossAmountCents = "1"; }, TypeError);
  await assert.rejects(client.recordWeeklyFee(first), /network uncertain/);
  assert.equal(client.submissionStatus(first), "FAILED");
  assert.deepEqual(await client.recordWeeklyFee(first), { grossAmountCents: "9007199254740993" });
  assert.equal(client.submissionStatus(first), "SUCCEEDED");
  const changed = client.createWeeklyFeeSubmission({ ...first.draft, grossAmountCents: "9007199254740994" });
  assert.notEqual(changed.idempotencyKey, first.idempotencyKey);
  assert.deepEqual(keys, ["key-1", "key-1"]);
});

test("金额和版本在客户端校验，401清会话，403返回角色选择", async () => {
  const client = new TeacherApiClient({
    transport: async (request) => {
      if (request.path === "/v1/session" && request.method === "POST") return success(teacherSession());
      if (request.path === "/v1/venues/available") return { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "UNAUTHENTICATED" } } };
      if (request.path === "/v1/me") return { status: 403, body: { error: { code: "FORBIDDEN_SCOPE", message: "FORBIDDEN_SCOPE" } } };
      throw new Error(`unexpected ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  assert.throws(() => client.createWeeklyFeeSubmission({
    referralCaseId: "ref", teachingWeekId: "week", venueId: "venue", settlementMonth: "2026-09-01",
    grossAmountCents: "12.34", expectedVersion: 0
  }), ApiClientError);
  await assert.rejects(client.listAvailableVenues(), ApiClientError);
  assert.equal(client.currentSession, null);
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  await assert.rejects(client.getMe(), RoleSelectionRequiredError);
  assert.equal(client.currentSession?.currentRoleContext, null);
});
