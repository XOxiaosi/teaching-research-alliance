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
      if (request.path === "/v1/referrals/ref-1/accept") {
        return success({
          referralId: "ref-1", version: 2, venueId: "venue-1", venueOwnerPersonId: "person-1",
          isSelfUse: true, acceptedAt: "2026-09-21T00:00:00Z", replay: false
        });
      }
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
  const acceptance = client.createReferralAcceptanceSubmission({ referralId: "ref-1", expectedVersion: 1 });
  await client.acceptReferral(acceptance);
  oldOverview.resolve(success({ balanceCents: "old" }));
  await assert.rejects(earlyRead, StaleResponseError);
  assert.deepEqual(await client.getOwnOverview(), { balanceCents: "2" });
  assert.deepEqual(await client.getOwnOverview(), { balanceCents: "3" });
  assert.equal(overviewRequests, 3);
});

test("接收推荐冻结草稿并以同一幂等键重试，提交体不允许伪造字段", async () => {
  const requestBodies = [];
  let attempts = 0;
  const client = new TeacherApiClient({
    idempotencyKeyFactory: () => "accept-key-1",
    transport: async (request) => {
      if (request.path === "/v1/session") return success(teacherSession());
      if (request.path === "/v1/referrals/ref-1/accept") {
        requestBodies.push(request.body);
        attempts += 1;
        if (attempts === 1) throw new Error("network uncertain");
        return success({
          referralId: "ref-1", version: 2, venueId: "venue-1", venueOwnerPersonId: "person-1",
          isSelfUse: true, acceptedAt: "2026-09-21T00:00:00Z", replay: true
        });
      }
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const submission = client.createReferralAcceptanceSubmission({
    referralId: "ref-1", venueId: "venue-1", expectedVersion: 1,
    referrerPersonId: "forged"
  });
  assert.equal(Object.isFrozen(submission), true);
  assert.equal(Object.isFrozen(submission.draft), true);
  assert.throws(() => { submission.draft.expectedVersion = 9; }, TypeError);
  await assert.rejects(client.acceptReferral(submission), /network uncertain/);
  assert.equal(client.submissionStatus(submission), "FAILED");
  assert.equal((await client.acceptReferral(submission)).replay, true);
  assert.equal(client.submissionStatus(submission), "SUCCEEDED");
  assert.deepEqual(requestBodies.map((body) => body.idempotencyKey), ["accept-key-1", "accept-key-1"]);
  assert.deepEqual(Object.keys(requestBodies[0]).sort(), ["expectedVersion", "idempotencyKey", "venueId"]);
  assert.equal(requestBodies[0].referrerPersonId, undefined);
  assert.throws(() => client.createReferralAcceptanceSubmission({ referralId: "ref-1", venueId: "", expectedVersion: 1 }), ApiClientError);
  assert.throws(() => client.createReferralAcceptanceSubmission({ referralId: "ref-1", expectedVersion: 0 }), ApiClientError);
});

test("推荐归档与重新推送冻结命令、同键重试且不发送伪造字段", async () => {
  const requests = [];
  let archiveAttempts = 0;
  const client = new TeacherApiClient({
    idempotencyKeyFactory: (() => {
      let index = 0;
      return () => `lifecycle-key-${++index}`;
    })(),
    transport: async (request) => {
      if (request.path === "/v1/session") return success(teacherSession("ACADEMIC_PLANNER"));
      if (request.path === "/v1/referrals/ref-1/archive") {
        requests.push(request);
        archiveAttempts += 1;
        if (archiveAttempts === 1) throw new Error("network uncertain");
        return success({ referralId: "ref-1", status: "ARCHIVED", version: 2, unacceptedExpiresAt: "2026-10-12T00:00:00.000Z", replay: true });
      }
      if (request.path === "/v1/referrals/ref-1/reactivate") {
        requests.push(request);
        return success({ referralId: "ref-1", status: "REACTIVATED", version: 3, unacceptedExpiresAt: "2026-10-21T00:00:00.000Z", replay: false });
      }
      if (request.path === "/v1/role-contexts/switch") return success(teacherSession("PLANNING_MENTOR"));
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const archive = client.createReferralLifecycleSubmission({
    referralId: "ref-1", expectedVersion: 1, command: "ARCHIVE", actorPersonId: "forged", status: "ACCEPTED", unacceptedExpiresAt: null
  });
  assert.equal(Object.isFrozen(archive), true);
  assert.equal(Object.isFrozen(archive.draft), true);
  assert.throws(() => { archive.draft.command = "REACTIVATE"; }, TypeError);
  await assert.rejects(client.changeReferralLifecycle(archive), /network uncertain/);
  assert.equal(client.submissionStatus(archive), "FAILED");
  assert.equal((await client.changeReferralLifecycle(archive)).replay, true);
  assert.deepEqual(requests.slice(0, 2).map((request) => request.body.idempotencyKey), ["lifecycle-key-1", "lifecycle-key-1"]);
  assert.deepEqual(Object.keys(requests[0].body).sort(), ["expectedVersion", "idempotencyKey"]);
  assert.equal(requests[0].body.actorPersonId, undefined);
  assert.equal(requests[0].body.status, undefined);
  assert.equal(requests[0].body.unacceptedExpiresAt, undefined);

  const reactivate = client.createReferralLifecycleSubmission({ referralId: "ref-1", expectedVersion: 2, command: "REACTIVATE" });
  assert.equal((await client.changeReferralLifecycle(reactivate)).status, "REACTIVATED");
  assert.equal(requests[2].path, "/v1/referrals/ref-1/reactivate");
  assert.notEqual(reactivate.idempotencyKey, archive.idempotencyKey);

  const stale = client.createReferralLifecycleSubmission({ referralId: "ref-1", expectedVersion: 3, command: "ARCHIVE" });
  await client.switchRole("PLANNING_MENTOR");
  await assert.rejects(client.changeReferralLifecycle(stale), StaleResponseError);
  assert.equal(requests.length, 3);
  assert.equal(client.submissionStatus(stale), "FAILED");
  assert.throws(() => client.createReferralLifecycleSubmission({ referralId: "ref-1", expectedVersion: 0, command: "ARCHIVE" }), ApiClientError);
});

test("身份或角色变化拒绝重用旧接收、推荐和周费用提交", async () => {
  let acceptRequests = 0;
  let referralRequests = 0;
  let weeklyFeeRequests = 0;
  const client = new TeacherApiClient({
    transport: async (request) => {
      if (request.path === "/v1/session") return success(teacherSession());
      if (request.path === "/v1/role-contexts/switch") return success(teacherSession("ACADEMIC_PLANNER"));
      if (request.path === "/v1/referrals/ref-1/accept") {
        acceptRequests += 1;
        return success({});
      }
      if (request.path === "/v1/referrals") {
        referralRequests += 1;
        return success({});
      }
      if (request.path === "/v1/referrals/ref-1/weekly-fees") {
        weeklyFeeRequests += 1;
        return success({});
      }
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const acceptance = client.createReferralAcceptanceSubmission({ referralId: "ref-1", expectedVersion: 1 });
  const referral = client.createReferralSubmission({
    receiverPersonId: "teacher-2", studentDisplayName: "学生", courseContextId: "数学", classType: "ONE_TO_ONE"
  });
  const weeklyFee = client.createWeeklyFeeSubmission({
    referralCaseId: "ref-1", teachingWeekId: "week-1", venueId: "venue-1",
    settlementMonth: "2026-09-01", grossAmountCents: "100", expectedVersion: 1
  });
  await client.switchRole("ACADEMIC_PLANNER");
  await assert.rejects(client.acceptReferral(acceptance), StaleResponseError);
  await assert.rejects(client.createReferral(referral), StaleResponseError);
  await assert.rejects(client.recordWeeklyFee(weeklyFee), StaleResponseError);
  assert.equal(acceptRequests, 0);
  assert.equal(referralRequests, 0);
  assert.equal(weeklyFeeRequests, 0);
  assert.equal(client.submissionStatus(acceptance), "FAILED");
  assert.equal(client.submissionStatus(referral), "FAILED");
  assert.equal(client.submissionStatus(weeklyFee), "FAILED");
});

test("退出后即使同一人员角色重新登录，也拒绝旧会话的三类提交且不发 POST", async () => {
  let loginRequests = 0;
  let mutationRequests = 0;
  const client = new TeacherApiClient({
    transport: async (request) => {
      if (request.path === "/v1/session") {
        loginRequests += 1;
        return success({ ...teacherSession(), sessionId: `session-${loginRequests}` });
      }
      if (
        request.path === "/v1/referrals/ref-1/accept"
        || request.path === "/v1/referrals"
        || request.path === "/v1/referrals/ref-1/weekly-fees"
      ) {
        mutationRequests += 1;
        return success({});
      }
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const acceptance = client.createReferralAcceptanceSubmission({ referralId: "ref-1", expectedVersion: 1 });
  const referral = client.createReferralSubmission({
    receiverPersonId: "teacher-2", studentDisplayName: "学生", courseContextId: "数学", classType: "ONE_TO_ONE"
  });
  const weeklyFee = client.createWeeklyFeeSubmission({
    referralCaseId: "ref-1", teachingWeekId: "week-1", venueId: "venue-1",
    settlementMonth: "2026-09-01", grossAmountCents: "100", expectedVersion: 1
  });
  client.logout();
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  assert.equal(client.currentSession?.sessionId, "session-2");
  await assert.rejects(client.acceptReferral(acceptance), StaleResponseError);
  await assert.rejects(client.createReferral(referral), StaleResponseError);
  await assert.rejects(client.recordWeeklyFee(weeklyFee), StaleResponseError);
  assert.equal(mutationRequests, 0);
  assert.equal(client.submissionStatus(acceptance), "FAILED");
  assert.equal(client.submissionStatus(referral), "FAILED");
  assert.equal(client.submissionStatus(weeklyFee), "FAILED");
});

test("成功写入只作废旧读取，不废弃同一身份下的待提交草稿", async () => {
  let referralRequests = 0;
  const client = new TeacherApiClient({
    transport: async (request) => {
      if (request.path === "/v1/session") return success(teacherSession());
      if (request.path === "/v1/referrals/ref-1/accept") {
        return success({
          referralId: "ref-1", version: 2, venueId: "venue-1", venueOwnerPersonId: "person-1",
          isSelfUse: true, acceptedAt: "2026-09-21T00:00:00Z", replay: false
        });
      }
      if (request.path === "/v1/referrals") {
        referralRequests += 1;
        return success({ referralId: "ref-2", studentRecordId: "student-2", version: 1, replay: false });
      }
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const referral = client.createReferralSubmission({
    receiverPersonId: "teacher-2", studentDisplayName: "学生", courseContextId: "数学", classType: "SMALL_GROUP"
  });
  const acceptance = client.createReferralAcceptanceSubmission({ referralId: "ref-1", expectedVersion: 1 });
  await client.acceptReferral(acceptance);
  await client.createReferral(referral);
  assert.equal(referralRequests, 1);
  assert.equal(client.submissionStatus(referral), "SUCCEEDED");
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

test("推荐创建以冻结提交对象安全重试，同名再次提交使用新键", async () => {
  const requestBodies = [];
  let createAttempts = 0;
  const client = new TeacherApiClient({
    idempotencyKeyFactory: (() => {
      let id = 0;
      return () => `referral-key-${++id}`;
    })(),
    transport: async (request) => {
      if (request.path === "/v1/session") return success(teacherSession("ACADEMIC_PLANNER"));
      if (request.path === "/v1/referrals/receiving-teachers") {
        return success([{ personId: "teacher-1", nickname: "接收老师" }]);
      }
      if (request.path === "/v1/referrals/sent") {
        return success([{
          referralId: "sent-1", studentRecordId: "student-1", studentDisplayName: "已推荐学生",
          version: 1,
          courseContextId: "数学", receiverPersonId: "teacher-1", receiverNickname: "接收老师",
          referralStatus: "PENDING", submittedAt: "2026-09-21T00:00:00Z",
          sourceSubject: null, classType: "ONE_TO_ONE", weeklyFees: []
        }]);
      }
      if (request.path === "/v1/referrals") {
        requestBodies.push(request.body);
        createAttempts += 1;
        if (createAttempts === 1) throw new Error("network uncertain");
        return success({ referralId: `ref-${createAttempts}`, studentRecordId: `student-${createAttempts}`, version: 1, replay: createAttempts === 2 });
      }
      throw new Error(`unexpected ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  assert.deepEqual(await client.listReceivingTeachers(), [{ personId: "teacher-1", nickname: "接收老师" }]);
  assert.equal((await client.listSentReferrals())[0].studentDisplayName, "已推荐学生");
  const first = client.createReferralSubmission({
    receiverPersonId: "teacher-1", studentDisplayName: "同名学生", courseContextId: "数学", classType: "ONE_TO_ONE"
  });
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.draft), true);
  await assert.rejects(client.createReferral(first), /network uncertain/);
  assert.equal(client.submissionStatus(first), "FAILED");
  assert.equal((await client.createReferral(first)).replay, true);
  const sameNameAgain = client.createReferralSubmission(first.draft);
  await client.createReferral(sameNameAgain);
  assert.notEqual(sameNameAgain.idempotencyKey, first.idempotencyKey);
  assert.deepEqual(requestBodies.map((body) => body.idempotencyKey), ["referral-key-1", "referral-key-1", "referral-key-2"]);
  assert.deepEqual(Object.keys(requestBodies[0]).sort(), ["classType", "courseContextId", "idempotencyKey", "receiverPersonId", "studentDisplayName"]);
});

test("复制推荐冻结草稿、同键重试、可选字段白名单并拒绝跨会话提交", async () => {
  const requests = [];
  let loginRequests = 0;
  let firstCopyAttempts = 0;
  const client = new TeacherApiClient({
    idempotencyKeyFactory: (() => {
      let index = 0;
      return () => `copy-key-${++index}`;
    })(),
    transport: async (request) => {
      if (request.path === "/v1/session") {
        loginRequests += 1;
        return success({ ...teacherSession("ACADEMIC_PLANNER"), sessionId: `session-${loginRequests}` });
      }
      if (request.path === "/v1/referrals/source-1/copy") {
        requests.push(request);
        firstCopyAttempts += 1;
        if (firstCopyAttempts === 1) throw new Error("network uncertain");
        return success({ referralId: "copy-1", studentRecordId: "student-1", version: 1, replay: true, copiedFromReferralId: "source-1" });
      }
      if (request.path === "/v1/referrals/source-2/copy") {
        requests.push(request);
        return success({ referralId: "copy-2", studentRecordId: "student-2", version: 1, replay: false, copiedFromReferralId: "source-2" });
      }
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const sourceOnly = client.createReferralCopySubmission({
    sourceReferralId: "source-1", receiverPersonId: "teacher-2", actorPersonId: "forged", referralStatus: "ARCHIVED"
  });
  assert.equal(Object.isFrozen(sourceOnly), true);
  assert.equal(Object.isFrozen(sourceOnly.draft), true);
  assert.throws(() => { sourceOnly.draft.receiverPersonId = "teacher-3"; }, TypeError);
  await assert.rejects(client.copyReferral(sourceOnly), /network uncertain/);
  assert.equal(client.submissionStatus(sourceOnly), "FAILED");
  assert.equal((await client.copyReferral(sourceOnly)).copiedFromReferralId, "source-1");
  assert.deepEqual(requests.slice(0, 2).map((request) => request.body.idempotencyKey), ["copy-key-1", "copy-key-1"]);
  assert.deepEqual(Object.keys(requests[0].body).sort(), ["idempotencyKey", "receiverPersonId"]);
  assert.equal(requests[0].body.actorPersonId, undefined);
  assert.equal(requests[0].body.referralStatus, undefined);

  const detailed = client.createReferralCopySubmission({
    sourceReferralId: "source-2", receiverPersonId: "teacher-3", courseContextId: "数学", classType: "SMALL_GROUP"
  });
  assert.equal((await client.copyReferral(detailed)).referralId, "copy-2");
  assert.deepEqual(Object.keys(requests[2].body).sort(), ["classType", "courseContextId", "idempotencyKey", "receiverPersonId"]);

  const stale = client.createReferralCopySubmission({ sourceReferralId: "source-1", receiverPersonId: "teacher-2" });
  client.logout();
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  await assert.rejects(client.copyReferral(stale), StaleResponseError);
  assert.equal(requests.length, 3);
  assert.equal(client.submissionStatus(stale), "FAILED");
  assert.throws(() => client.createReferralCopySubmission({ sourceReferralId: "", receiverPersonId: "teacher-2" }), ApiClientError);
  assert.throws(() => client.createReferralCopySubmission({ sourceReferralId: "source-1", receiverPersonId: "", classType: "UNKNOWN" }), ApiClientError);
});

test("退出后在途推荐创建不能写回当前会话", async () => {
  const creating = deferred();
  const client = new TeacherApiClient({
    transport: async (request) => {
      if (request.path === "/v1/session") return success(teacherSession("ACADEMIC_PLANNER"));
      if (request.path === "/v1/referrals") return creating.promise;
      throw new Error(`unexpected ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const submission = client.createReferralSubmission({
    receiverPersonId: "teacher-1", studentDisplayName: "学生", courseContextId: "语文", classType: "SMALL_GROUP"
  });
  const pending = client.createReferral(submission);
  client.logout();
  creating.resolve(success({ referralId: "ref-old", studentRecordId: "student-old", version: 1, replay: false }));
  await assert.rejects(pending, StaleResponseError);
  assert.equal(client.currentSession, null);
  assert.equal(client.submissionStatus(submission), "FAILED");
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

test("server sign-out clears local state even if the logout request fails", async () => {
  const client = new TeacherApiClient({transport:async request => {
    if(request.path==='/v1/session') return success(teacherSession());
    assert.equal(request.path,'/v1/session/logout');
    assert.equal(request.headers.authorization,'Bearer session-1');
    throw new Error('network');
  }});
  await client.login({phoneNormalized:'13800000000',password:'password'});
  await assert.rejects(client.endSession(), /network/);
  assert.equal(client.currentSession,null);
});
