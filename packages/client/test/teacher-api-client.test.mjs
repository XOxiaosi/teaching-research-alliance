import assert from "node:assert/strict";
import test from "node:test";
import {
  ApiClientError,
  formatCentsAsBeans,
  parseBeanAmountToCents,
  RoleSelectionRequiredError,
  SubmissionInProgressError,
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

const administratorSession = (subject = "SYSTEM_ADMIN", extra = {}) => ({
  sessionId: "admin-session-1",
  accountId: "admin-account-1",
  personId: "admin-person-1",
  roleContexts: [{ subject, personId: "admin-person-1", scope: "GLOBAL", ...extra }],
  currentRoleContext: { subject, personId: "admin-person-1", scope: "GLOBAL", ...extra }
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

test("可见场地目录使用独立路径，不复用授课可选场地目录", async () => {
  const paths = [];
  const client = new TeacherApiClient({
    transport: async (request) => {
      if (request.path === "/v1/session") return success(teacherSession("ACADEMIC_PLANNER"));
      paths.push(request.path);
      return success([{ id: "shared-venue" }]);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  assert.deepEqual(await client.listVisibleVenues(), [{ id: "shared-venue" }]);
  assert.deepEqual(paths, ["/v1/venues/visible"]);
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

test("财务草稿只提交冻结元数据，同键重试、读取与跨会话保护", async () => {
  const createBodies = [];
  let createAttempts = 0;
  let loginRequests = 0;
  const metadata = {
    id: "draft-1", kind: "REIMBURSEMENT", status: "DRAFT", version: 1,
    createdAt: "2026-09-21T00:00:00.000Z", updatedAt: "2026-09-21T00:00:00.000Z"
  };
  const client = new TeacherApiClient({
    idempotencyKeyFactory: (() => {
      let index = 0;
      return () => `finance-key-${++index}`;
    })(),
    transport: async (request) => {
      if (request.path === "/v1/session") {
        loginRequests += 1;
        return success({ ...teacherSession("ACADEMIC_PLANNER"), sessionId: `session-${loginRequests}` });
      }
      if (request.path === "/v1/finance/drafts" && request.method === "POST") {
        createBodies.push(request.body);
        createAttempts += 1;
        if (createAttempts === 1) throw new Error("network uncertain");
        return success({ ...metadata, replay: true });
      }
      if (request.path === "/v1/finance/drafts/mine") return success([metadata]);
      if (request.path === "/v1/finance/drafts/draft-1") return success(metadata);
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const submission = client.createFinanceDraftSubmission({
    kind: "REIMBURSEMENT", amountCents: "100", bankAccountId: "forged", status: "APPROVED", actorPersonId: "forged"
  });
  assert.equal(Object.isFrozen(submission), true);
  assert.equal(Object.isFrozen(submission.draft), true);
  assert.throws(() => { submission.draft.kind = "WITHDRAWAL"; }, TypeError);
  await assert.rejects(client.createFinanceDraft(submission), /network uncertain/);
  assert.equal(client.submissionStatus(submission), "FAILED");
  assert.equal((await client.createFinanceDraft(submission)).replay, true);
  assert.equal(client.submissionStatus(submission), "SUCCEEDED");
  assert.deepEqual(createBodies.map((body) => body.idempotencyKey), ["finance-key-1", "finance-key-1"]);
  assert.deepEqual(Object.keys(createBodies[0]).sort(), ["idempotencyKey", "kind"]);
  assert.equal(createBodies[0].amountCents, undefined);
  assert.equal(createBodies[0].bankAccountId, undefined);
  assert.equal(createBodies[0].status, undefined);
  assert.equal(createBodies[0].actorPersonId, undefined);
  assert.deepEqual(await client.listOwnFinanceDrafts(), [metadata]);
  assert.deepEqual(await client.getOwnFinanceDraft("draft-1"), metadata);

  const stale = client.createFinanceDraftSubmission({ kind: "WITHDRAWAL" });
  client.logout();
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  await assert.rejects(client.createFinanceDraft(stale), StaleResponseError);
  assert.equal(createBodies.length, 2);
  assert.equal(client.submissionStatus(stale), "FAILED");
  assert.throws(() => client.createFinanceDraftSubmission({ kind: "APPROVED" }), ApiClientError);
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

test("附件预留冻结元数据、未知结果使用同键重试且不发送伪造字段", async () => {
  const bodies = [];
  let attempts = 0;
  const reservation = {
    attachmentId: "attachment-1", versionId: "version-1", versionNo: 1, status: "UPLOADING",
    purpose: "SUPPORTING_DOCUMENT", originalFilename: "合成凭证.pdf", declaredMediaType: "application/pdf",
    declaredSizeBytes: 42, expectedSha256: "a".repeat(64), createdAt: "2026-09-21T00:00:00.000Z", replay: true
  };
  const client = new TeacherApiClient({
    idempotencyKeyFactory: () => "attachment-key-1",
    transport: async (request) => {
      if (request.path === "/v1/session") return success(teacherSession("ACADEMIC_PLANNER"));
      if (request.path === "/v1/finance/drafts/draft-1/attachment-uploads") {
        bodies.push(request.body);
        attempts += 1;
        if (attempts === 1) throw new Error("network uncertain");
        return success(reservation);
      }
      if (request.path === "/v1/finance/attachment-uploads/version-1") {
        const { replay: _replay, ...metadata } = reservation;
        return success(metadata);
      }
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const submission = client.createFinanceAttachmentReservationSubmission({
    documentId: "draft-1", purpose: "SUPPORTING_DOCUMENT", originalFilename: "合成凭证.pdf",
    declaredMediaType: "application/pdf", declaredSizeBytes: 42, expectedSha256: "a".repeat(64),
    status: "READY", attachmentId: "forged", uploadedByPersonId: "forged", storagePath: "/private/original"
  });
  assert.equal(Object.isFrozen(submission), true);
  assert.equal(Object.isFrozen(submission.draft), true);
  assert.throws(() => { submission.draft.originalFilename = "rewritten.pdf"; }, TypeError);
  await assert.rejects(client.reserveFinanceAttachment(submission), /network uncertain/);
  assert.equal(client.submissionStatus(submission), "FAILED");
  assert.deepEqual(await client.reserveFinanceAttachment(submission), reservation);
  assert.equal(client.submissionStatus(submission), "SUCCEEDED");
  assert.deepEqual(bodies.map((body) => body.idempotencyKey), ["attachment-key-1", "attachment-key-1"]);
  assert.deepEqual(Object.keys(bodies[0]).sort(), [
    "declaredMediaType", "declaredSizeBytes", "expectedSha256", "idempotencyKey", "originalFilename", "purpose"
  ]);
  assert.equal(bodies[0].attachmentId, undefined);
  assert.equal(bodies[0].uploadedByPersonId, undefined);
  assert.equal(bodies[0].storagePath, undefined);
  const { replay: _replay, ...metadata } = reservation;
  assert.deepEqual(await client.getOwnFinanceAttachmentVersion("version-1"), metadata);
});

test("附件预留校验文件元数据，并在角色变化后拒绝旧提交或旧读取", async () => {
  const reading = deferred();
  let reserveRequests = 0;
  const client = new TeacherApiClient({
    transport: async (request) => {
      if (request.path === "/v1/session") return success(teacherSession());
      if (request.path === "/v1/role-contexts/switch") return success(teacherSession("ACADEMIC_PLANNER"));
      if (request.path === "/v1/finance/attachment-uploads/version-1") return reading.promise;
      if (request.path.includes("/attachment-uploads")) {
        reserveRequests += 1;
        return success({});
      }
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const submission = client.createFinanceAttachmentReservationSubmission({
    documentId: "draft-1", purpose: "INVOICE", originalFilename: "invoice.pdf",
    declaredMediaType: "application/pdf", declaredSizeBytes: 1
  });
  const oldRead = client.getOwnFinanceAttachmentVersion("version-1");
  await client.switchRole("ACADEMIC_PLANNER");
  reading.resolve(success({ versionId: "version-1" }));
  await assert.rejects(oldRead, StaleResponseError);
  await assert.rejects(client.reserveFinanceAttachment(submission), StaleResponseError);
  assert.equal(reserveRequests, 0);

  const valid = {
    documentId: "draft-1", purpose: "INVOICE", originalFilename: "invoice.pdf",
    declaredMediaType: "application/pdf", declaredSizeBytes: 1
  };
  for (const draft of [
    { ...valid, documentId: "" },
    { ...valid, purpose: "UNKNOWN" },
    { ...valid, originalFilename: "../invoice.pdf" },
    { ...valid, originalFilename: "测".repeat(86) },
    { ...valid, declaredMediaType: "text/plain" },
    { ...valid, declaredSizeBytes: 0 },
    { ...valid, declaredSizeBytes: 20 * 1024 * 1024 + 1 },
    { ...valid, expectedSha256: "A".repeat(64) }
  ]) {
    assert.throws(() => client.createFinanceAttachmentReservationSubmission(draft), ApiClientError);
  }
});

test("文档附件列表保留槽、版本和绑定元数据，并在角色切换后作废旧响应", async () => {
  const pending = deferred();
  let requests = 0;
  const documentAttachments = {
    documentId: "draft-1",
    attachments: [{
      attachmentId: "attachment-1", purpose: "SUPPORTING_DOCUMENT", createdAt: "2026-09-21T00:00:00.000Z",
      versions: [{
        versionId: "version-2", versionNo: 2, status: "READY", originalFilename: "更正凭证.pdf",
        declaredMediaType: "application/pdf", declaredSizeBytes: 42, expectedSha256: "a".repeat(64),
        createdAt: "2026-09-21T01:00:00.000Z",
        binding: { stage: "SUBMISSION", documentVersion: 2, boundAt: "2026-09-21T02:00:00.000Z" }
      }]
    }]
  };
  const client = new TeacherApiClient({
    transport: async (request) => {
      if (request.path === "/v1/session") return success(teacherSession());
      if (request.path === "/v1/role-contexts/switch") return success(teacherSession("ACADEMIC_PLANNER"));
      if (request.path === "/v1/finance/documents/draft-1/attachments") {
        requests += 1;
        return requests === 1 ? pending.promise : success(documentAttachments);
      }
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const oldRead = client.listFinanceDocumentAttachments("draft-1");
  await client.switchRole("ACADEMIC_PLANNER");
  pending.resolve(success(documentAttachments));
  await assert.rejects(oldRead, StaleResponseError);
  assert.deepEqual(await client.listFinanceDocumentAttachments("draft-1"), documentAttachments);
  await assert.rejects(client.listFinanceDocumentAttachments(""), ApiClientError);
});

test("同槽附件版本冻结并以同一键重试，只发送版本元数据白名单", async () => {
  const bodies = [];
  let attempts = 0;
  const reservation = {
    attachmentId: "attachment-1", versionId: "version-2", versionNo: 2, status: "UPLOADING",
    purpose: "SUPPORTING_DOCUMENT", originalFilename: "更正凭证.pdf", declaredMediaType: "application/pdf",
    declaredSizeBytes: 42, expectedSha256: "a".repeat(64), createdAt: "2026-09-21T00:00:00.000Z", replay: true
  };
  const client = new TeacherApiClient({
    idempotencyKeyFactory: () => "attachment-version-key-1",
    transport: async (request) => {
      if (request.path === "/v1/session") return success(teacherSession());
      if (request.path === "/v1/finance/attachments/attachment-1/versions") {
        bodies.push(request.body);
        attempts += 1;
        if (attempts === 1) throw new Error("network uncertain");
        return success(reservation);
      }
      if (request.path === "/v1/role-contexts/switch") return success(teacherSession("ACADEMIC_PLANNER"));
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const submission = client.createFinanceAttachmentVersionSubmission({
    attachmentId: "attachment-1", originalFilename: "更正凭证.pdf", declaredMediaType: "application/pdf",
    declaredSizeBytes: 42, expectedSha256: "a".repeat(64), documentId: "forged", purpose: "PAYMENT_RECEIPT", status: "READY"
  });
  assert.equal(Object.isFrozen(submission), true);
  assert.equal(Object.isFrozen(submission.draft), true);
  assert.throws(() => { submission.draft.attachmentId = "other"; }, TypeError);
  await assert.rejects(client.reserveFinanceAttachmentVersion(submission), /network uncertain/);
  assert.equal(client.submissionStatus(submission), "FAILED");
  assert.deepEqual(await client.reserveFinanceAttachmentVersion(submission), reservation);
  assert.deepEqual(bodies.map((body) => body.idempotencyKey), ["attachment-version-key-1", "attachment-version-key-1"]);
  assert.deepEqual(Object.keys(bodies[0]).sort(), [
    "declaredMediaType", "declaredSizeBytes", "expectedSha256", "idempotencyKey", "originalFilename"
  ]);
  assert.equal(bodies[0].documentId, undefined);
  assert.equal(bodies[0].purpose, undefined);

  const stale = client.createFinanceAttachmentVersionSubmission({
    attachmentId: "attachment-1", originalFilename: "再次更正.pdf", declaredMediaType: "application/pdf", declaredSizeBytes: 42
  });
  await client.switchRole("ACADEMIC_PLANNER");
  await assert.rejects(client.reserveFinanceAttachmentVersion(stale), StaleResponseError);
  assert.equal(attempts, 2);
  assert.throws(() => client.createFinanceAttachmentVersionSubmission({
    attachmentId: "", originalFilename: "x.pdf", declaredMediaType: "application/pdf", declaredSizeBytes: 1
  }), ApiClientError);
});

test("附件预留的401清会话，403清角色上下文", async () => {
  let loginCount = 0;
  const client = new TeacherApiClient({
    transport: async (request) => {
      if (request.path === "/v1/session") {
        loginCount += 1;
        return success({ ...teacherSession(), sessionId: `attachment-session-${loginCount}` });
      }
      if (request.path === "/v1/finance/drafts/draft-1/attachment-uploads") {
        return { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "expired" } } };
      }
      if (request.path === "/v1/finance/attachment-uploads/version-1") {
        return { status: 403, body: { error: { code: "FORBIDDEN_SCOPE", message: "role" } } };
      }
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const submission = client.createFinanceAttachmentReservationSubmission({
    documentId: "draft-1", purpose: "INVOICE", originalFilename: "invoice.pdf",
    declaredMediaType: "application/pdf", declaredSizeBytes: 1
  });
  await assert.rejects(client.reserveFinanceAttachment(submission), (error) => {
    assert.ok(error instanceof ApiClientError);
    assert.equal(error.code, "UNAUTHENTICATED");
    return true;
  });
  assert.equal(client.currentSession, null);
  assert.equal(client.submissionStatus(submission), "FAILED");

  await client.login({ phoneNormalized: "13800000000", password: "password" });
  await assert.rejects(client.getOwnFinanceAttachmentVersion("version-1"), RoleSelectionRequiredError);
  assert.equal(client.currentSession?.currentRoleContext, null);
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

test("提现提交冻结银行文本与附件快照，以同一键重试且不发送伪造字段", async () => {
  const bodies = [];
  let attempts = 0;
  const attachmentVersionIds = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const client = new TeacherApiClient({
    idempotencyKeyFactory: () => "withdrawal-submit-key-1",
    transport: async (request) => {
      if (request.path === "/v1/session") return success(teacherSession());
      if (request.path === "/v1/finance/drafts/draft-1/withdrawal-submit") {
        bodies.push(request.body);
        attempts += 1;
        if (attempts === 1) throw new Error("network uncertain");
        return success({ id: "draft-1", status: "PENDING_TRANSFER", version: 2, replay: true });
      }
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const submission = client.createWithdrawalSubmitSubmission({
    documentId: "draft-1", expectedVersion: 1, sourceAccountId: "account-1", amountCents: "600",
    recipientName: "张老师", bankAccount: " 0012 3400 ", bankName: " 中国银行 ", attachmentVersionIds,
    applicantPersonId: "forged", status: "TRANSFERRED", bankAccountLast4: "9999"
  });
  attachmentVersionIds.push("later-ui-change");
  assert.equal(Object.isFrozen(submission), true);
  assert.equal(Object.isFrozen(submission.draft), true);
  assert.equal(Object.isFrozen(submission.draft.attachmentVersionIds), true);
  await assert.rejects(client.submitWithdrawal(submission), /network uncertain/);
  assert.equal(client.submissionStatus(submission), "FAILED");
  assert.equal((await client.submitWithdrawal(submission)).replay, true);
  assert.deepEqual(bodies.map((body) => body.idempotencyKey), ["withdrawal-submit-key-1", "withdrawal-submit-key-1"]);
  assert.deepEqual(bodies[0], {
    expectedVersion: 1, sourceAccountId: "account-1", amountCents: "600", recipientName: "张老师",
    bankAccount: " 0012 3400 ", bankName: " 中国银行 ", attachmentVersionIds: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
    idempotencyKey: "withdrawal-submit-key-1"
  });
  assert.equal(bodies[0].applicantPersonId, undefined);
  assert.equal(bodies[0].status, undefined);
  assert.throws(() => client.createWithdrawalSubmitSubmission({
    documentId: "draft-1", expectedVersion: 1, sourceAccountId: "account-1", amountCents: "9223372036854775808",
    recipientName: "张老师", bankAccount: "0012", attachmentVersionIds: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]
  }), ApiClientError);
  assert.throws(() => client.createWithdrawalSubmitSubmission({
    documentId: "draft-1", expectedVersion: 1, sourceAccountId: "account-1", amountCents: "600",
    recipientName: "张老师", bankAccount: "0012", attachmentVersionIds: ["11111111-1111-4111-8111-111111111111"]
  }), ApiClientError);
});

test("提现命令拒绝跨角色复用，并阻止同一提交并发执行", async () => {
  const request = deferred();
  let posts = 0;
  const client = new TeacherApiClient({
    transport: async (transportRequest) => {
      if (transportRequest.path === "/v1/session") return success(teacherSession());
      if (transportRequest.path === "/v1/role-contexts/switch") return success(teacherSession("ACADEMIC_PLANNER"));
      if (transportRequest.path === "/v1/finance/drafts/draft-1/withdrawal-submit") {
        posts += 1;
        return request.promise;
      }
      throw new Error(`unexpected ${transportRequest.method} ${transportRequest.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const stale = client.createWithdrawalSubmitSubmission({
    documentId: "draft-1", expectedVersion: 1, sourceAccountId: "account-1", amountCents: "1",
    recipientName: "张老师", bankAccount: "0012", attachmentVersionIds: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]
  });
  await client.switchRole("ACADEMIC_PLANNER");
  await assert.rejects(client.submitWithdrawal(stale), StaleResponseError);
  assert.equal(posts, 0);

  const current = client.createWithdrawalSubmitSubmission({
    documentId: "draft-1", expectedVersion: 1, sourceAccountId: "account-1", amountCents: "1",
    recipientName: "张老师", bankAccount: "0012", attachmentVersionIds: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]
  });
  const first = client.submitWithdrawal(current);
  await assert.rejects(client.submitWithdrawal(current), SubmissionInProgressError);
  request.resolve(success({ id: "draft-1", status: "PENDING_TRANSFER", version: 2, replay: false }));
  await first;
  assert.equal(posts, 1);
});

test("提现读取路径、财务撤回和转账完成命令使用严格 JSON 白名单", async () => {
  const requests = [];
  const client = new TeacherApiClient({
    idempotencyKeyFactory: (() => { let sequence = 0; return () => `withdrawal-key-${++sequence}`; })(),
    transport: async (request) => {
      if (request.path === "/v1/session") return success(teacherSession("HEADQUARTERS_FINANCE"));
      requests.push(request);
      if (request.method === "GET") return success([]);
      if (request.path.endsWith("finance-revoke")) return success({ id: "draft-1", status: "FINANCE_REVOKED", version: 3, replay: false });
      if (request.path.endsWith("mark-transferred")) return success({ id: "draft-1", status: "TRANSFERRED", version: 3, replay: false });
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  await client.listWithdrawalSources();
  await client.listOwnWithdrawals();
  await client.listPendingTransferWithdrawals();
  await client.listManagedWithdrawals();
  await client.getWithdrawalDetail("draft/1");
  assert.deepEqual(requests.slice(0, 5).map((request) => request.path), [
    "/v1/finance/withdrawals/sources", "/v1/finance/withdrawals/mine", "/v1/finance/withdrawals/pending-transfer",
    "/v1/finance/withdrawals/managed", "/v1/finance/withdrawals/draft%2F1"
  ]);
  const revoke = client.createWithdrawalRevokeSubmission({ documentId: "draft-1", expectedVersion: 2, reason: " 人工核对失败 ", actorPersonId: "forged" });
  const transferred = client.createWithdrawalMarkTransferredSubmission({
    documentId: "draft-2", expectedVersion: 2, attachmentVersionIds: ["receipt-1"], status: "PENDING_TRANSFER"
  });
  assert.equal((await client.revokeWithdrawal(revoke)).status, "FINANCE_REVOKED");
  assert.equal((await client.markWithdrawalTransferred(transferred)).status, "TRANSFERRED");
  assert.deepEqual(requests[5].body, { expectedVersion: 2, reason: " 人工核对失败 ", idempotencyKey: "withdrawal-key-1" });
  assert.deepEqual(requests[6].body, { expectedVersion: 2, attachmentVersionIds: ["receipt-1"], idempotencyKey: "withdrawal-key-2" });
});

test("提现读取沿用 401 清会话与 403 清角色上下文", async () => {
  let loginCount = 0;
  const client = new TeacherApiClient({
    transport: async (request) => {
      if (request.path === "/v1/session") {
        loginCount += 1;
        return success({ ...teacherSession(), sessionId: `withdrawal-session-${loginCount}` });
      }
      if (request.path === "/v1/finance/withdrawals/sources") {
        return { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "expired" } } };
      }
      if (request.path === "/v1/finance/withdrawals/pending-transfer") {
        return { status: 403, body: { error: { code: "FORBIDDEN_SCOPE", message: "role" } } };
      }
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  await assert.rejects(client.listWithdrawalSources(), ApiClientError);
  assert.equal(client.currentSession, null);
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  await assert.rejects(client.listPendingTransferWithdrawals(), RoleSelectionRequiredError);
  assert.equal(client.currentSession?.currentRoleContext, null);
});

test("本人采买冻结金额、理由和附件，未知网络以同键重试且只发送固定字段", async () => {
  const bodies = [];
  let attempts = 0;
  const attachmentVersionIds = ["attachment-1", "attachment-2"];
  const client = new TeacherApiClient({
    idempotencyKeyFactory: () => "self-purchase-key-1",
    transport: async (request) => {
      if (request.path === "/v1/session") return success(teacherSession());
      if (request.path === "/v1/finance/drafts/draft-1/self-purchase-submit") {
        bodies.push(request.body);
        attempts += 1;
        if (attempts === 1) throw new Error("network uncertain");
        return success({ id: "draft-1", status: "COMPLETED", version: 2, replay: true });
      }
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const submission = client.createSelfPurchaseSubmission({
    documentId: "draft-1", expectedVersion: 1, amountCents: "9007199254740991", reason: " 合成教具采买 ", attachmentVersionIds,
    sourceFundId: "forged", sourceAccountId: "forged", applicantPersonId: "forged", processingMode: "MANUAL"
  });
  attachmentVersionIds.push("later-ui-change");
  assert.equal(Object.isFrozen(submission), true);
  assert.equal(Object.isFrozen(submission.draft), true);
  assert.equal(Object.isFrozen(submission.draft.attachmentVersionIds), true);
  await assert.rejects(client.submitSelfPurchase(submission), /network uncertain/);
  assert.equal(client.submissionStatus(submission), "FAILED");
  assert.deepEqual(await client.submitSelfPurchase(submission), { id: "draft-1", status: "COMPLETED", version: 2, replay: true });
  assert.deepEqual(bodies, [
    { expectedVersion: 1, amountCents: "9007199254740991", reason: " 合成教具采买 ", attachmentVersionIds: ["attachment-1", "attachment-2"], idempotencyKey: "self-purchase-key-1" },
    { expectedVersion: 1, amountCents: "9007199254740991", reason: " 合成教具采买 ", attachmentVersionIds: ["attachment-1", "attachment-2"], idempotencyKey: "self-purchase-key-1" }
  ]);
  assert.throws(() => client.createSelfPurchaseSubmission({
    documentId: "draft-1", expectedVersion: 1, amountCents: "0", reason: "采买", attachmentVersionIds: ["one", "two"]
  }), ApiClientError);
  assert.throws(() => client.createSelfPurchaseSubmission({
    documentId: "draft-1", expectedVersion: 1, amountCents: "1", reason: "采买", attachmentVersionIds: ["same", "same"]
  }), ApiClientError);
});

test("采买读取路径遵循财年服务端裁决，旧会话命令和成功前读取不会污染当前状态", async () => {
  const oldMine = deferred();
  let logins = 0;
  let posts = 0;
  const client = new TeacherApiClient({
    transport: async (request) => {
      if (request.path === "/v1/session") {
        logins += 1;
        return success({ ...teacherSession(), sessionId: `self-session-${logins}` });
      }
      if (request.path === "/v1/finance/self-purchases/mine") return oldMine.promise;
      if (request.path === "/v1/finance/drafts/draft-1/self-purchase-submit") {
        posts += 1;
        return success({ id: "draft-1", status: "COMPLETED", version: 2, replay: false });
      }
      if (request.path === "/v1/finance/self-purchases/managed") return success({ documents: [] });
      if (request.path === "/v1/finance/self-purchases/draft%2F1") return success({ id: "draft/1", attachments: [] });
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const earlyMine = client.listOwnSelfPurchases();
  const current = client.createSelfPurchaseSubmission({
    documentId: "draft-1", expectedVersion: 1, amountCents: "1", reason: "采买", attachmentVersionIds: ["one", "two"]
  });
  await client.submitSelfPurchase(current);
  oldMine.resolve(success({ documents: [] }));
  await assert.rejects(earlyMine, StaleResponseError);
  await client.getSelfPurchaseDetail("draft/1");
  await client.listManagedSelfPurchases();

  const stale = client.createSelfPurchaseSubmission({
    documentId: "draft-2", expectedVersion: 1, amountCents: "1", reason: "采买", attachmentVersionIds: ["three", "four"]
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  await assert.rejects(client.submitSelfPurchase(stale), StaleResponseError);
  assert.equal(posts, 1);
});

test("采买提交拒绝跨角色复用，并阻止同一冻结命令并发出站", async () => {
  const pending = deferred();
  let submissions = 0;
  const client = new TeacherApiClient({
    transport: async (request) => {
      if (request.path === "/v1/session") return success(teacherSession());
      if (request.path === "/v1/role-contexts/switch") return success(teacherSession("ACADEMIC_PLANNER"));
      if (request.path === "/v1/finance/drafts/draft-1/self-purchase-submit") {
        submissions += 1;
        return pending.promise;
      }
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const stale = client.createSelfPurchaseSubmission({
    documentId: "draft-1", expectedVersion: 1, amountCents: "1", reason: "采买", attachmentVersionIds: ["one", "two"]
  });
  await client.switchRole("ACADEMIC_PLANNER");
  await assert.rejects(client.submitSelfPurchase(stale), StaleResponseError);
  assert.equal(submissions, 0);

  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const current = client.createSelfPurchaseSubmission({
    documentId: "draft-1", expectedVersion: 1, amountCents: "1", reason: "采买", attachmentVersionIds: ["one", "two"]
  });
  const first = client.submitSelfPurchase(current);
  await assert.rejects(client.submitSelfPurchase(current), SubmissionInProgressError);
  pending.resolve(success({ id: "draft-1", status: "COMPLETED", version: 2, replay: false }));
  await first;
  assert.equal(submissions, 1);
});

test("采买撤销冻结命令以同键重试，只允许严格GLOBAL办理人且作废旧读取", async () => {
  const oldList = deferred();
  const requests = [];
  let attempts = 0;
  const client = new TeacherApiClient({
    idempotencyKeyFactory: () => "self-reversal-key-1",
    transport: async (request) => {
      if (request.path === "/v1/session") return success(administratorSession("HEADQUARTERS_FINANCE"));
      requests.push(request);
      if (request.path === "/v1/finance/self-purchases/managed") return oldList.promise;
      if (request.path === "/v1/finance/self-purchases/draft-1/reverse") {
        attempts += 1;
        if (attempts === 1) throw new Error("network uncertain");
        return success({ id: "draft-1", status: "REVERSED", version: 3, replay: true });
      }
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const earlyRead = client.listManagedSelfPurchases();
  const reversal = client.createSelfPurchaseReversalSubmission({
    documentId: "draft-1", expectedVersion: 2, reason: " 采购取消 ", amountCents: "999", actorPersonId: "forged"
  });
  assert.equal(Object.isFrozen(reversal), true);
  assert.equal(Object.isFrozen(reversal.draft), true);
  await assert.rejects(client.reverseSelfPurchase(reversal), /network uncertain/);
  assert.equal(client.submissionStatus(reversal), "FAILED");
  assert.deepEqual(await client.reverseSelfPurchase(reversal), { id: "draft-1", status: "REVERSED", version: 3, replay: true });
  oldList.resolve(success({ documents: [] }));
  await assert.rejects(earlyRead, StaleResponseError);
  assert.deepEqual(requests.slice(1), [
    {
      method: "POST", path: "/v1/finance/self-purchases/draft-1/reverse", headers: requests[1].headers,
      body: { expectedVersion: 2, reason: " 采购取消 ", idempotencyKey: "self-reversal-key-1" }
    },
    {
      method: "POST", path: "/v1/finance/self-purchases/draft-1/reverse", headers: requests[2].headers,
      body: { expectedVersion: 2, reason: " 采购取消 ", idempotencyKey: "self-reversal-key-1" }
    }
  ]);
  assert.equal(requests[1].body.amountCents, undefined);
  assert.equal(requests[1].body.actorPersonId, undefined);
});

test("采买撤销拒绝个人、局部HQ和跨会话复用的冻结命令", async () => {
  const personalClient = new TeacherApiClient({ transport: async (request) => {
    if (request.path === "/v1/session") return success(teacherSession());
    throw new Error("personal reversal must not be sent");
  } });
  await personalClient.login({ phoneNormalized: "13800000000", password: "password" });
  assert.throws(() => personalClient.createSelfPurchaseReversalSubmission({ documentId: "draft-1", expectedVersion: 2, reason: "取消" }), ApiClientError);

  let logins = 0;
  let posts = 0;
  const client = new TeacherApiClient({ transport: async (request) => {
    if (request.path === "/v1/session") {
      logins += 1;
      return success({ ...administratorSession("HEADQUARTERS_FINANCE"), sessionId: `hq-session-${logins}` });
    }
    if (request.path === "/v1/finance/self-purchases/draft-1/reverse") posts += 1;
    throw new Error("old reversal must not be sent");
  } });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const submission = client.createSelfPurchaseReversalSubmission({ documentId: "draft-1", expectedVersion: 2, reason: "取消" });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  await assert.rejects(client.reverseSelfPurchase(submission), StaleResponseError);
  assert.equal(posts, 0);

  const localHq = new TeacherApiClient({ transport: async (request) => {
    if (request.path === "/v1/session") return success(administratorSession("HEADQUARTERS_FINANCE", { venueId: "venue-1" }));
    throw new Error("local reversal must not be sent");
  } });
  await localHq.login({ phoneNormalized: "13800000000", password: "password" });
  assert.throws(() => localHq.createSelfPurchaseReversalSubmission({ documentId: "draft-1", expectedVersion: 2, reason: "取消" }), ApiClientError);
});

test("公司资金仅严格GLOBAL管理员配置，命令冻结重试且不发送账户或余额字段", async () => {
  const requests = [];
  let createAttempts = 0;
  const client = new TeacherApiClient({
    idempotencyKeyFactory: (() => { let index = 0; return () => `fund-key-${++index}`; })(),
    transport: async (request) => {
      if (request.path === "/v1/session") return success(administratorSession());
      requests.push(request);
      if (request.method === "GET") return success({ funds: [], currentAssignment: null });
      if (request.path === "/v1/admin/company-funds") {
        createAttempts += 1;
        if (createAttempts === 1) throw new Error("network uncertain");
        return success({ id: "fund-1", accountId: "account-1", accountCode: "company:fund:fund-1", fundCode: "HQ_OPERATING", displayName: "总部业务资金", status: "ACTIVE", version: 1, replay: true });
      }
      if (request.path.endsWith("/assignment")) return success({ id: "assignment-1", fundId: "fund-1", validFrom: "2026-09-21T00:00:00.000Z", previousAssignmentId: null, replay: false });
      if (request.path.endsWith("/status")) return success({ id: "fund-1", accountId: "account-1", accountCode: "company:fund:fund-1", fundCode: "HQ_OPERATING", displayName: "总部业务资金", status: "INACTIVE", version: 2, replay: false });
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  assert.deepEqual(await client.listCompanyFunds(), { funds: [], currentAssignment: null });
  const create = client.createCompanyFundSubmission({
    fundCode: "HQ_OPERATING", displayName: "总部业务资金", openingBalanceCents: "999", ownerId: "forged", accountCode: "forged"
  });
  await assert.rejects(client.createCompanyFund(create), /network uncertain/);
  assert.equal((await client.createCompanyFund(create)).replay, true);
  const assignment = client.createCompanyFundAssignmentSubmission({ fundId: "fund-1", expectedAssignmentId: null, reason: "首次指定", personId: "forged" });
  const status = client.createCompanyFundStatusSubmission({ fundId: "fund-1", expectedVersion: 1, status: "INACTIVE", reason: "停用", accountId: "forged" });
  assert.equal((await client.assignCompanyFund(assignment)).fundId, "fund-1");
  assert.equal((await client.setCompanyFundStatus(status)).status, "INACTIVE");
  assert.equal(Object.isFrozen(create.draft), true);
  assert.deepEqual(requests.map((request) => request.path), [
    "/v1/admin/company-funds", "/v1/admin/company-funds", "/v1/admin/company-funds", "/v1/admin/company-funds/fund-1/assignment", "/v1/admin/company-funds/fund-1/status"
  ]);
  assert.deepEqual(requests[1].body, { fundCode: "HQ_OPERATING", displayName: "总部业务资金", idempotencyKey: "fund-key-1" });
  assert.deepEqual(requests[3].body, { expectedAssignmentId: null, reason: "首次指定", idempotencyKey: "fund-key-2" });
  assert.deepEqual(requests[4].body, { expectedVersion: 1, status: "INACTIVE", reason: "停用", idempotencyKey: "fund-key-3" });
  assert.equal(requests[1].body.openingBalanceCents, undefined);
  assert.equal(requests[1].body.ownerId, undefined);
});

test("HQ和带局部资源的管理员不能读取或提交公司资金配置，403清角色上下文", async () => {
  let calls = 0;
  const client = new TeacherApiClient({
    transport: async (request) => {
      if (request.path === "/v1/session") return success(administratorSession());
      calls += 1;
      return { status: 403, body: { error: { code: "FORBIDDEN_SCOPE", message: "role" } } };
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  await assert.rejects(client.listCompanyFunds(), RoleSelectionRequiredError);
  assert.equal(client.currentSession?.currentRoleContext, null);
  assert.equal(calls, 1);

  const hq = new TeacherApiClient({ transport: async (request) => {
    if (request.path === "/v1/session") return success(administratorSession("HEADQUARTERS_FINANCE"));
    throw new Error("configuration request must not be sent");
  } });
  await hq.login({ phoneNormalized: "13800000000", password: "password" });
  await assert.rejects(hq.listCompanyFunds(), ApiClientError);
  const localAdmin = new TeacherApiClient({ transport: async (request) => {
    if (request.path === "/v1/session") return success(administratorSession("SYSTEM_ADMIN", { campusId: "campus-1" }));
    throw new Error("configuration request must not be sent");
  } });
  await localAdmin.login({ phoneNormalized: "13800000000", password: "password" });
  assert.throws(() => localAdmin.createCompanyFundSubmission({ fundCode: "HQ_LOCAL", displayName: "局部管理员" }), ApiClientError);
});

test("福利扣费业务账户目录只读严格GLOBAL三类角色，GET不带query或body", async () => {
  const subjects = ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"];
  for (const subject of subjects) {
    const requests = [];
    const client = new TeacherApiClient({
      transport: async (request) => {
        if (request.path === "/v1/session") return success(administratorSession(subject));
        requests.push(request);
        return success({ items: [{ fundId: "fund-1", code: "HQ_OPERATING", displayName: "总部业务资金" }] });
      },
    });
    await client.login({ phoneNormalized: "13800000000", password: "password" });
    assert.deepEqual(await client.listBenefitSourceFunds(), {
      items: [{ fundId: "fund-1", code: "HQ_OPERATING", displayName: "总部业务资金" }],
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "GET");
    assert.equal(requests[0].path, "/v1/finance/benefit-source-funds");
    assert.match(requests[0].headers.authorization, /^Bearer /);
    assert.equal(requests[0].body, undefined);
    assert.equal(requests[0].path.includes("?"), false);
  }
});

test("福利扣费业务账户目录拒绝普通角色和窄范围角色，并沿用401/403认证语义", async () => {
  const forbidden = [
    ["TEACHING_TEACHER", { scope: "SELF" }],
    ["REGION_FINANCE", { scope: "REGION", regionId: "region-1" }],
    ["CAMPUS_PRINCIPAL", { scope: "CAMPUS", campusId: "campus-1" }],
    ["HEADQUARTERS_FINANCE", { scope: "GLOBAL", regionId: "region-1" }],
    ["HEADQUARTERS_FINANCE", { scope: "GLOBAL", campusId: "campus-1" }],
    ["HEADQUARTERS_FINANCE", { scope: "GLOBAL", venueId: "venue-1" }],
  ];
  for (const [subject, extra] of forbidden) {
    let calls = 0;
    const client = new TeacherApiClient({
      transport: async (request) => {
        if (request.path === "/v1/session") return success(administratorSession(subject, extra));
        calls += 1;
        throw new Error("forbidden local role must not call API");
      },
    });
    await client.login({ phoneNormalized: "13800000000", password: "password" });
    await assert.rejects(client.listBenefitSourceFunds(), ApiClientError);
    assert.equal(calls, 0);
  }

  const unauthenticated = new TeacherApiClient({
    transport: async (request) => {
      if (request.path === "/v1/session") return success(administratorSession());
      return { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "expired" } } };
    },
  });
  await unauthenticated.login({ phoneNormalized: "13800000000", password: "password" });
  await assert.rejects(unauthenticated.listBenefitSourceFunds(), ApiClientError);
  assert.equal(unauthenticated.currentSession, null);

  const forbiddenServer = new TeacherApiClient({
    transport: async (request) => {
      if (request.path === "/v1/session") return success(administratorSession());
      return { status: 403, body: { error: { code: "FORBIDDEN_SCOPE", message: "role" } } };
    },
  });
  await forbiddenServer.login({ phoneNormalized: "13800000000", password: "password" });
  await assert.rejects(forbiddenServer.listBenefitSourceFunds(), ApiClientError);
  assert.equal(forbiddenServer.currentSession?.currentRoleContext, null);
});

test("普通报销冻结金额理由和图片原件，未知结果以同键重试且不发送伪造字段", async () => {
  const bodies = [];
  let attempts = 0;
  const attachmentVersionIds = ["receipt-1", "screenshot-1"];
  const client = new TeacherApiClient({
    idempotencyKeyFactory: () => "reimbursement-submit-key-1",
    transport: async (request) => {
      if (request.path === "/v1/session") return success(teacherSession());
      if (request.path === "/v1/finance/drafts/draft-1/reimbursement-submit") {
        bodies.push(request.body);
        attempts += 1;
        if (attempts === 1) throw new Error("network uncertain");
        return success({ id: "draft-1", status: "PENDING_APPROVAL", version: 2, replay: true });
      }
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const submission = client.createReimbursementSubmission({
    documentId: "draft-1", expectedVersion: 1, amountCents: "9007199254740991", reason: " 教材报销 ", attachmentVersionIds,
    applicantPersonId: "forged", destinationAccountId: "forged", status: "APPROVED"
  });
  attachmentVersionIds.push("later-ui-change");
  assert.equal(Object.isFrozen(submission), true);
  assert.equal(Object.isFrozen(submission.draft), true);
  assert.equal(Object.isFrozen(submission.draft.attachmentVersionIds), true);
  await assert.rejects(client.submitReimbursement(submission), /network uncertain/);
  assert.equal(client.submissionStatus(submission), "FAILED");
  assert.deepEqual(await client.submitReimbursement(submission), {
    id: "draft-1", status: "PENDING_APPROVAL", version: 2, replay: true
  });
  assert.deepEqual(bodies, [
    { expectedVersion: 1, amountCents: "9007199254740991", reason: " 教材报销 ", attachmentVersionIds: ["receipt-1", "screenshot-1"], idempotencyKey: "reimbursement-submit-key-1" },
    { expectedVersion: 1, amountCents: "9007199254740991", reason: " 教材报销 ", attachmentVersionIds: ["receipt-1", "screenshot-1"], idempotencyKey: "reimbursement-submit-key-1" }
  ]);
  assert.equal(bodies[0].applicantPersonId, undefined);
  assert.equal(bodies[0].destinationAccountId, undefined);
  assert.deepEqual(client.createReimbursementSubmission({
    documentId: "draft-1", expectedVersion: 1, amountCents: "1", reason: "单张图片", attachmentVersionIds: ["screenshot-1"]
  }).draft.attachmentVersionIds, ["screenshot-1"]);
  assert.throws(() => client.createReimbursementSubmission({
    documentId: "draft-1", expectedVersion: 1, amountCents: "1", reason: "缺附件", attachmentVersionIds: []
  }), ApiClientError);
});

test("普通报销读取使用固定路径并由服务端裁决管理和个人范围，403清角色上下文", async () => {
  const paths = [];
  const client = new TeacherApiClient({
    transport: async (request) => {
      if (request.path === "/v1/session") return success(teacherSession("PLANNING_MENTOR"));
      paths.push(request.path);
      if (request.path === "/v1/finance/reimbursements/mine") return success({ documents: [{
        id: "draft-1", status: "PENDING_APPROVAL", version: 2, amountCents: "101", reason: "教材",
        applicantPersonId: "person-1", applicantDisplayName: "老师", submittedAt: "2026-09-21T00:00:00.000Z"
      }] });
      if (request.path === "/v1/finance/reimbursements/managed") return success({ documents: [] });
      if (request.path === "/v1/finance/reimbursements/draft%2F1") return success({
        id: "draft/1", status: "APPROVED", version: 3, amountCents: "101", reason: "教材",
        applicantPersonId: "person-1", applicantDisplayName: "老师", submittedAt: "2026-09-21T00:00:00.000Z",
        attachments: [{ versionId: "version-1", purpose: "SUPPORTING_DOCUMENT", originalFilename: "evidence.png", mediaType: "image/png", sizeBytes: 100, sha256: "a".repeat(64) }],
        decision: { decision: "APPROVED", reason: "已核对", decidedAt: "2026-09-22T00:00:00.000Z" }
      });
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  assert.equal((await client.listOwnReimbursements()).documents[0].applicantDisplayName, "老师");
  assert.deepEqual(await client.listManagedReimbursements(), { documents: [] });
  assert.equal((await client.getReimbursementDetail("draft/1")).decision?.decision, "APPROVED");
  assert.deepEqual(paths, [
    "/v1/finance/reimbursements/mine", "/v1/finance/reimbursements/managed", "/v1/finance/reimbursements/draft%2F1"
  ]);

  const forbidden = new TeacherApiClient({ transport: async (request) => {
    if (request.path === "/v1/session") return success(teacherSession());
    return { status: 403, body: { error: { code: "FORBIDDEN_SCOPE", message: "scope" } } };
  } });
  await forbidden.login({ phoneNormalized: "13800000000", password: "password" });
  await assert.rejects(forbidden.listManagedReimbursements(), RoleSelectionRequiredError);
  assert.equal(forbidden.currentSession?.currentRoleContext, null);
});

test("普通报销审核冻结动作和会话范围，只允许严格GLOBAL总部财务并作废早期读取", async () => {
  const earlyList = deferred();
  const requests = [];
  let attempts = 0;
  const input = { documentId: "draft-1", expectedVersion: 2, reason: " 资料齐全 ", decision: "APPROVE" };
  const client = new TeacherApiClient({
    idempotencyKeyFactory: () => "reimbursement-review-key-1",
    transport: async (request) => {
      if (request.path === "/v1/session") return success(administratorSession("HEADQUARTERS_FINANCE"));
      requests.push(request);
      if (request.path === "/v1/finance/reimbursements/managed") return earlyList.promise;
      if (request.path === "/v1/finance/reimbursements/draft-1/approve") {
        attempts += 1;
        if (attempts === 1) throw new Error("network uncertain");
        return success({ id: "draft-1", status: "APPROVED", version: 3, replay: true });
      }
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const oldRead = client.listManagedReimbursements();
  const review = client.createReimbursementReviewSubmission(input);
  assert.equal(client.createReimbursementReviewSubmission({ documentId: 'draft-1', expectedVersion: 2, reason: '', decision: 'REJECT' }).draft.reason, '');
  input.decision = "REJECT";
  input.reason = "篡改";
  assert.equal(Object.isFrozen(review), true);
  assert.equal(Object.isFrozen(review.draft), true);
  await assert.rejects(client.reviewReimbursement(review), /network uncertain/);
  assert.equal(client.submissionStatus(review), "FAILED");
  assert.deepEqual(await client.reviewReimbursement(review), { id: "draft-1", status: "APPROVED", version: 3, replay: true });
  earlyList.resolve(success({ documents: [] }));
  await assert.rejects(oldRead, StaleResponseError);
  assert.deepEqual(requests.slice(1).map((request) => ({ path: request.path, body: request.body })), [
    { path: "/v1/finance/reimbursements/draft-1/approve", body: { expectedVersion: 2, reason: " 资料齐全 ", idempotencyKey: "reimbursement-review-key-1" } },
    { path: "/v1/finance/reimbursements/draft-1/approve", body: { expectedVersion: 2, reason: " 资料齐全 ", idempotencyKey: "reimbursement-review-key-1" } }
  ]);

  const administrator = new TeacherApiClient({ transport: async (request) => {
    if (request.path === "/v1/session") return success(administratorSession());
    throw new Error("administrator review must not be sent");
  } });
  await administrator.login({ phoneNormalized: "13800000000", password: "password" });
  assert.throws(() => administrator.createReimbursementReviewSubmission({ ...input, decision: "APPROVE" }), ApiClientError);
  const localHq = new TeacherApiClient({ transport: async (request) => {
    if (request.path === "/v1/session") return success(administratorSession("HEADQUARTERS_FINANCE", { campusId: "campus-1" }));
    throw new Error("local review must not be sent");
  } });
  await localHq.login({ phoneNormalized: "13800000000", password: "password" });
  assert.throws(() => localHq.createReimbursementReviewSubmission({ ...input, decision: "APPROVE" }), ApiClientError);
});

test("普通报销冻结提交和审核都拒绝跨会话复用，且不会发出POST", async () => {
  let sessions = 0;
  let posts = 0;
  const personal = new TeacherApiClient({ transport: async (request) => {
    if (request.path === "/v1/session") {
      sessions += 1;
      return success({ ...teacherSession(), sessionId: `personal-session-${sessions}` });
    }
    posts += 1;
    throw new Error("stale submission must not be sent");
  } });
  await personal.login({ phoneNormalized: "13800000000", password: "password" });
  const submission = personal.createReimbursementSubmission({
    documentId: "draft-1", expectedVersion: 1, amountCents: "1", reason: "教材", attachmentVersionIds: ["one", "two"]
  });
  await personal.login({ phoneNormalized: "13800000000", password: "password" });
  await assert.rejects(personal.submitReimbursement(submission), StaleResponseError);

  sessions = 0;
  const reviewer = new TeacherApiClient({ transport: async (request) => {
    if (request.path === "/v1/session") {
      sessions += 1;
      return success({ ...administratorSession("HEADQUARTERS_FINANCE"), sessionId: `hq-session-${sessions}` });
    }
    posts += 1;
    throw new Error("stale review must not be sent");
  } });
  await reviewer.login({ phoneNormalized: "13800000000", password: "password" });
  const review = reviewer.createReimbursementReviewSubmission({ documentId: "draft-1", expectedVersion: 2, reason: "审核", decision: "REJECT" });
  await reviewer.login({ phoneNormalized: "13800000000", password: "password" });
  await assert.rejects(reviewer.reviewReimbursement(review), StaleResponseError);
  assert.equal(posts, 0);
  assert.throws(() => reviewer.createReimbursementReviewSubmission({ documentId: "draft-1", expectedVersion: 2, reason: "审核", decision: "APPROVED" }), ApiClientError);
});

test("退款提交冻结费用与原件数组，允许授课老师的个人组织范围并以原键安全重试", async () => {
  const bodies = [];
  let attempts = 0;
  const weeklyFeeEntryIds = ["fee-1", "fee-2"];
  const attachmentVersionIds = ["evidence-1", "screenshot-1"];
  const campusTeacher = {
    ...teacherSession(),
    roleContexts: [{ subject: "TEACHING_TEACHER", personId: "person-1", scope: "CAMPUS", campusId: "campus-1" }],
    currentRoleContext: { subject: "TEACHING_TEACHER", personId: "person-1", scope: "CAMPUS", campusId: "campus-1" }
  };
  const client = new TeacherApiClient({
    idempotencyKeyFactory: () => "refund-submit-key-1",
    transport: async (request) => {
      if (request.path === "/v1/session") return success(campusTeacher);
      if (request.path === "/v1/finance/drafts/draft-1/refund-submit") {
        bodies.push(request.body);
        attempts += 1;
        if (attempts === 1) throw new Error("network uncertain");
        return success({ id: "draft-1", status: "PENDING_APPROVAL", version: 2, replay: true });
      }
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const submission = client.createRefundSubmission({
    documentId: "draft-1", expectedVersion: 1, reason: " 学生退费 ", weeklyFeeEntryIds, attachmentVersionIds,
    amountCents: "999", sourceAccountId: "forged", parentBankAccount: "forged"
  });
  weeklyFeeEntryIds.push("fee-later"); attachmentVersionIds.push("attachment-later");
  assert.equal(Object.isFrozen(submission), true);
  assert.equal(Object.isFrozen(submission.draft), true);
  assert.equal(Object.isFrozen(submission.draft.weeklyFeeEntryIds), true);
  assert.equal(Object.isFrozen(submission.draft.attachmentVersionIds), true);
  await assert.rejects(client.submitRefund(submission), /network uncertain/);
  assert.equal(client.submissionStatus(submission), "FAILED");
  assert.deepEqual(await client.submitRefund(submission), { id: "draft-1", status: "PENDING_APPROVAL", version: 2, replay: true });
  assert.deepEqual(bodies, [
    { expectedVersion: 1, reason: " 学生退费 ", weeklyFeeEntryIds: ["fee-1", "fee-2"], attachmentVersionIds: ["evidence-1", "screenshot-1"], idempotencyKey: "refund-submit-key-1" },
    { expectedVersion: 1, reason: " 学生退费 ", weeklyFeeEntryIds: ["fee-1", "fee-2"], attachmentVersionIds: ["evidence-1", "screenshot-1"], idempotencyKey: "refund-submit-key-1" }
  ]);
  assert.equal(bodies[0].amountCents, undefined);
  assert.equal(bodies[0].sourceAccountId, undefined);
  assert.throws(() => client.createRefundSubmission({ documentId: "draft-1", expectedVersion: 1, reason: "退款", weeklyFeeEntryIds: ["same", "same"], attachmentVersionIds: ["one", "two"] }), ApiClientError);
  assert.throws(() => client.createRefundSubmission({ documentId: "draft-1", expectedVersion: 1, reason: "退款", weeklyFeeEntryIds: ["fee-1"], attachmentVersionIds: ["one"] }), ApiClientError);
});

test("退款审核冻结动作、作废早期读取，并拒绝管理员审核和旧身份命令", async () => {
  const oldRead = deferred();
  const requests = [];
  let attempts = 0;
  const reviewInput = { documentId: "draft-1", expectedVersion: 2, reason: " 退款条件成立 ", decision: "APPROVE" };
  const reviewer = new TeacherApiClient({
    idempotencyKeyFactory: () => "refund-review-key-1",
    transport: async (request) => {
      if (request.path === "/v1/session") return success(administratorSession("HEADQUARTERS_FINANCE"));
      requests.push(request);
      if (request.path === "/v1/me") return oldRead.promise;
      if (request.path === "/v1/finance/refunds/draft-1/approve") {
        attempts += 1;
        if (attempts === 1) throw new Error("network uncertain");
        return success({ id: "draft-1", status: "REFUNDED", version: 3, replay: true });
      }
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await reviewer.login({ phoneNormalized: "13800000000", password: "password" });
  const earlyRead = reviewer.getOwnOverview();
  const review = reviewer.createRefundReviewSubmission(reviewInput);
  reviewInput.decision = "REJECT"; reviewInput.reason = "篡改";
  assert.equal(Object.isFrozen(review), true);
  assert.equal(Object.isFrozen(review.draft), true);
  await assert.rejects(reviewer.reviewRefund(review), /network uncertain/);
  assert.deepEqual(await reviewer.reviewRefund(review), { id: "draft-1", status: "REFUNDED", version: 3, replay: true });
  oldRead.resolve(success({ balanceCents: "old" }));
  await assert.rejects(earlyRead, StaleResponseError);
  assert.deepEqual(requests.slice(1).map((request) => ({ path: request.path, body: request.body })), [
    { path: "/v1/finance/refunds/draft-1/approve", body: { expectedVersion: 2, reason: " 退款条件成立 ", idempotencyKey: "refund-review-key-1" } },
    { path: "/v1/finance/refunds/draft-1/approve", body: { expectedVersion: 2, reason: " 退款条件成立 ", idempotencyKey: "refund-review-key-1" } }
  ]);

  const administrator = new TeacherApiClient({ transport: async (request) => {
    if (request.path === "/v1/session") return success(administratorSession());
    throw new Error("administrator review must not be sent");
  } });
  await administrator.login({ phoneNormalized: "13800000000", password: "password" });
  assert.throws(() => administrator.createRefundReviewSubmission({ ...reviewInput, decision: "REJECT" }), ApiClientError);

  let posts = 0;
  const teacher = new TeacherApiClient({ transport: async (request) => {
    if (request.path === "/v1/session") return success(teacherSession("ACADEMIC_PLANNER"));
    posts += 1;
    throw new Error("non-teacher refund must not be sent");
  } });
  await teacher.login({ phoneNormalized: "13800000000", password: "password" });
  assert.throws(() => teacher.createRefundSubmission({ documentId: "draft-1", expectedVersion: 1, reason: "退款", weeklyFeeEntryIds: ["fee-1"], attachmentVersionIds: ["one", "two"] }), ApiClientError);
  assert.equal(posts, 0);
});

test("退款冻结提交在角色变化后拒绝出站，并保留403清角色上下文", async () => {
  let posts = 0;
  const client = new TeacherApiClient({ transport: async (request) => {
    if (request.path === "/v1/session") return success(teacherSession());
    if (request.path === "/v1/role-contexts/switch") return success(teacherSession("ACADEMIC_PLANNER"));
    posts += 1;
    return { status: 403, body: { error: { code: "FORBIDDEN_SCOPE", message: "scope" } } };
  } });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const stale = client.createRefundSubmission({ documentId: "draft-1", expectedVersion: 1, reason: "退款", weeklyFeeEntryIds: ["fee-1"], attachmentVersionIds: ["one", "two"] });
  await client.switchRole("ACADEMIC_PLANNER");
  await assert.rejects(client.submitRefund(stale), StaleResponseError);
  assert.equal(posts, 0);

  const hq = new TeacherApiClient({ transport: async (request) => {
    if (request.path === "/v1/session") return success(administratorSession("HEADQUARTERS_FINANCE"));
    return { status: 403, body: { error: { code: "FORBIDDEN_SCOPE", message: "scope" } } };
  } });
  await hq.login({ phoneNormalized: "13800000000", password: "password" });
  const review = hq.createRefundReviewSubmission({ documentId: "draft-1", expectedVersion: 2, reason: "拒绝", decision: "REJECT" });
  await assert.rejects(hq.reviewRefund(review), RoleSelectionRequiredError);
  assert.equal(hq.currentSession?.currentRoleContext, null);
});

test('refund reads preserve scope generations and encode document identifiers',async()=>{
 const slow=deferred(),requests=[];
 const client=new TeacherApiClient({transport:async request=>{
  if(request.path==='/v1/session')return success(teacherSession());
  if(request.path==='/v1/role-contexts/switch')return success(teacherSession('ACADEMIC_PLANNER'));
  requests.push(request);
  if(request.path==='/v1/finance/refunds/mine')return slow.promise;
  return success({documents:[],id:'encoded'});
 }});
 await client.login({phoneNormalized:'13800000000',password:'password'});
 const pending=client.listOwnRefunds();
 await client.switchRole('ACADEMIC_PLANNER');slow.resolve(success({documents:[{id:'old-private'}]}));
 await assert.rejects(pending,StaleResponseError);
 await client.listManagedRefunds();await client.getRefundDetail('document/a b');
 assert.deepEqual(requests.map(request=>request.path),['/v1/finance/refunds/mine','/v1/finance/refunds/managed','/v1/finance/refunds/document%2Fa%20b']);
 await assert.rejects(client.getRefundDetail(' '),ApiClientError);
});

test("普通报销执行冻结版本并以同键重试，拒绝个人、管理员和过期会话", async () => {
  const requests = [];
  let attempts = 0;
  const client = new TeacherApiClient({
    idempotencyKeyFactory: () => "reimbursement-execute-key-1",
    transport: async (request) => {
      if (request.path === "/v1/session") return success(administratorSession("HEADQUARTERS_FINANCE"));
      requests.push(request);
      if (request.path === "/v1/finance/reimbursements/approved-1/execute") {
        attempts += 1;
        if (attempts === 1) throw new Error("network uncertain");
        return success({ id: "approved-1", status: "COMPLETED", version: 4, replay: true });
      }
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const submission = client.createReimbursementExecuteSubmission({ documentId: "approved-1", expectedVersion: 3, sourceAccountId: "forged", amountCents: "1" });
  assert.equal(Object.isFrozen(submission), true); assert.equal(Object.isFrozen(submission.draft), true);
  await assert.rejects(client.executeReimbursement(submission), /network uncertain/);
  assert.equal(client.submissionStatus(submission), "FAILED");
  assert.deepEqual(await client.executeReimbursement(submission), { id: "approved-1", status: "COMPLETED", version: 4, replay: true });
  assert.deepEqual(requests.map((request) => ({ path: request.path, body: request.body })), [
    { path: "/v1/finance/reimbursements/approved-1/execute", body: { expectedVersion: 3, idempotencyKey: "reimbursement-execute-key-1" } },
    { path: "/v1/finance/reimbursements/approved-1/execute", body: { expectedVersion: 3, idempotencyKey: "reimbursement-execute-key-1" } }
  ]);

  const administrator = new TeacherApiClient({ transport: async (request) => {
    if (request.path === "/v1/session") return success(administratorSession());
    throw new Error("administrator execution must not be sent");
  } });
  await administrator.login({ phoneNormalized: "13800000000", password: "password" });
  assert.throws(() => administrator.createReimbursementExecuteSubmission({ documentId: "approved-1", expectedVersion: 3 }), ApiClientError);

  let sessions = 0; let posts = 0;
  const reviewer = new TeacherApiClient({ transport: async (request) => {
    if (request.path === "/v1/session") { sessions += 1; return success({ ...administratorSession("HEADQUARTERS_FINANCE"), sessionId: `execute-session-${sessions}` }); }
    posts += 1; throw new Error("stale execution must not be sent");
  } });
  await reviewer.login({ phoneNormalized: "13800000000", password: "password" });
  const stale = reviewer.createReimbursementExecuteSubmission({ documentId: "approved-1", expectedVersion: 3 });
  await reviewer.login({ phoneNormalized: "13800000000", password: "password" });
  await assert.rejects(reviewer.executeReimbursement(stale), StaleResponseError);
  assert.equal(posts, 0);
});

test("普通报销撤销冻结命令以同键重试，仅允许严格GLOBAL办理人", async () => {
  const oldList = deferred();
  const requests = [];
  let attempts = 0;
  const client = new TeacherApiClient({
    idempotencyKeyFactory: () => "reimbursement-reversal-key-1",
    transport: async (request) => {
      if (request.path === "/v1/session") return success(administratorSession("SYSTEM_ADMIN"));
      requests.push(request);
      if (request.path === "/v1/finance/reimbursements/managed") return oldList.promise;
      if (request.path === "/v1/finance/reimbursements/completed-1/reverse") {
        attempts += 1;
        if (attempts === 1) throw new Error("network uncertain");
        return success({ id: "completed-1", status: "REVERSED", version: 5, replay: true });
      }
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const earlyRead = client.listManagedReimbursements();
  const submission = client.createReimbursementReversalSubmission({ documentId: "completed-1", expectedVersion: 4, reason: " 录入错误，冲回原划拨 ", sourceAccountId: "forged", amountCents: "1" });
  assert.equal(Object.isFrozen(submission), true);
  assert.equal(Object.isFrozen(submission.draft), true);
  await assert.rejects(client.reverseReimbursement(submission), /network uncertain/);
  assert.equal(client.submissionStatus(submission), "FAILED");
  assert.deepEqual(await client.reverseReimbursement(submission), { id: "completed-1", status: "REVERSED", version: 5, replay: true });
  oldList.resolve(success({ documents: [] }));
  await assert.rejects(earlyRead, StaleResponseError);
  assert.deepEqual(requests.slice(1).map((request) => ({ path: request.path, body: request.body })), [
    { path: "/v1/finance/reimbursements/completed-1/reverse", body: { expectedVersion: 4, reason: " 录入错误，冲回原划拨 ", idempotencyKey: "reimbursement-reversal-key-1" } },
    { path: "/v1/finance/reimbursements/completed-1/reverse", body: { expectedVersion: 4, reason: " 录入错误，冲回原划拨 ", idempotencyKey: "reimbursement-reversal-key-1" } }
  ]);
  assert.equal(requests[1].body.sourceAccountId, undefined);
  assert.equal(requests[1].body.amountCents, undefined);

  for (const subject of ["HEADQUARTERS_FINANCE", "SYSTEM_OWNER"]) {
    const allowed = new TeacherApiClient({ transport: async (request) => {
      if (request.path === "/v1/session") return success(administratorSession(subject));
      if (request.path === "/v1/finance/reimbursements/completed-1/reverse") return success({ id: "completed-1", status: "REVERSED", version: 5, replay: false });
      throw new Error(`unexpected ${request.path}`);
    } });
    await allowed.login({ phoneNormalized: "13800000000", password: "password" });
    const permitted = allowed.createReimbursementReversalSubmission({ documentId: "completed-1", expectedVersion: 4, reason: "撤销" });
    await allowed.reverseReimbursement(permitted);
  }
});

test("普通报销撤销拒绝个人、局部办理人和跨会话冻结命令", async () => {
  const personal = new TeacherApiClient({ transport: async (request) => {
    if (request.path === "/v1/session") return success(teacherSession());
    throw new Error("personal reversal must not be sent");
  } });
  await personal.login({ phoneNormalized: "13800000000", password: "password" });
  assert.throws(() => personal.createReimbursementReversalSubmission({ documentId: "completed-1", expectedVersion: 4, reason: "撤销" }), ApiClientError);

  const local = new TeacherApiClient({ transport: async (request) => {
    if (request.path === "/v1/session") return success(administratorSession("SYSTEM_OWNER", { venueId: "venue-1" }));
    throw new Error("local reversal must not be sent");
  } });
  await local.login({ phoneNormalized: "13800000000", password: "password" });
  assert.throws(() => local.createReimbursementReversalSubmission({ documentId: "completed-1", expectedVersion: 4, reason: "撤销" }), ApiClientError);

  let sessions = 0; let posts = 0;
  const stale = new TeacherApiClient({ transport: async (request) => {
    if (request.path === "/v1/session") { sessions += 1; return success({ ...administratorSession("HEADQUARTERS_FINANCE"), sessionId: `reversal-session-${sessions}` }); }
    posts += 1; throw new Error("stale reversal must not be sent");
  } });
  await stale.login({ phoneNormalized: "13800000000", password: "password" });
  const submission = stale.createReimbursementReversalSubmission({ documentId: "completed-1", expectedVersion: 4, reason: "撤销" });
  await stale.login({ phoneNormalized: "13800000000", password: "password" });
  await assert.rejects(stale.reverseReimbursement(submission), StaleResponseError);
  assert.equal(posts, 0);
});

test("管理推荐目录仅严格 GLOBAL 系统管理员可读", async () => {
  const personal = new TeacherApiClient({ transport: async (request) => {
    if (request.path === "/v1/session") return success(teacherSession());
    throw new Error("managed referral read must not be sent");
  } });
  await personal.login({ phoneNormalized: "13800000000", password: "password" });
  await assert.rejects(personal.listManagedReferrals(), ApiClientError);

  const local = new TeacherApiClient({ transport: async (request) => {
    if (request.path === "/v1/session") return success(administratorSession("SYSTEM_ADMIN", { venueId: "venue-1" }));
    throw new Error("scoped managed referral read must not be sent");
  } });
  await local.login({ phoneNormalized: "13800000000", password: "password" });
  await assert.rejects(local.listManagedReferrals(), ApiClientError);

  const requests = [];
  const admin = new TeacherApiClient({ transport: async (request) => {
    if (request.path === "/v1/session") return success(administratorSession("SYSTEM_OWNER"));
    requests.push(request);
    return success([{ referralId: "ref-1", studentDisplayName: "学生", courseContextId: "数学", receiverPersonId: "receiver-1", receiverNickname: "接收老师", referrerPersonId: "referrer-1", referrerNickname: "推荐老师", referralStatus: "ACCEPTED", version: 2, submittedAt: "2026-09-21T00:00:00Z" }]);
  } });
  await admin.login({ phoneNormalized: "13800000000", password: "password" });
  assert.deepEqual(await admin.listManagedReferrals(), [{ referralId: "ref-1", studentDisplayName: "学生", courseContextId: "数学", receiverPersonId: "receiver-1", receiverNickname: "接收老师", referrerPersonId: "referrer-1", referrerNickname: "推荐老师", referralStatus: "ACCEPTED", version: 2, submittedAt: "2026-09-21T00:00:00Z" }]);
  assert.deepEqual(requests.map((request) => [request.method, request.path]), [["GET", "/v1/referrals/managed"]]);
});

test("推荐完结冻结 expectedVersion 与幂等键，网络不确定时同键重试并拒绝伪造字段", async () => {
  const requests = [];
  let attempts = 0;
  const client = new TeacherApiClient({
    idempotencyKeyFactory: () => "complete-key-1",
    transport: async (request) => {
      if (request.path === "/v1/session") return success(administratorSession("SYSTEM_ADMIN"));
      requests.push(request);
      attempts += 1;
      if (attempts === 1) throw new Error("network uncertain");
      return success({ referralId: "ref-1", status: "COMPLETED", version: 3, unacceptedExpiresAt: null, replay: true });
    },
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const submission = client.createReferralLifecycleSubmission({
    referralId: "ref-1", expectedVersion: 2, command: "COMPLETE", actorPersonId: "forged", status: "ACCEPTED",
  });
  assert.equal(Object.isFrozen(submission), true);
  assert.equal(Object.isFrozen(submission.draft), true);
  assert.throws(() => { submission.draft.expectedVersion = 9; }, TypeError);
  await assert.rejects(client.changeReferralLifecycle(submission), /network uncertain/);
  assert.equal(client.submissionStatus(submission), "FAILED");
  assert.deepEqual(await client.changeReferralLifecycle(submission), { referralId: "ref-1", status: "COMPLETED", version: 3, unacceptedExpiresAt: null, replay: true });
  assert.deepEqual(requests.map((request) => request.body), [
    { expectedVersion: 2, idempotencyKey: "complete-key-1" },
    { expectedVersion: 2, idempotencyKey: "complete-key-1" },
  ]);
});

test("推荐完结命令跨会话或局部 GLOBAL 变化后不发请求", async () => {
  let sessions = 0;
  let completeRequests = 0;
  const client = new TeacherApiClient({
    transport: async (request) => {
      if (request.path === "/v1/session") {
        sessions += 1;
        return success({ ...administratorSession("SYSTEM_ADMIN"), sessionId: `admin-session-${sessions}` });
      }
      if (request.path === "/v1/role-contexts/switch") return success(administratorSession("SYSTEM_ADMIN", { venueId: "venue-1" }));
      completeRequests += 1;
      throw new Error("stale completion must not be sent");
    },
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const submission = client.createReferralLifecycleSubmission({ referralId: "ref-1", expectedVersion: 2, command: "COMPLETE" });
  await client.switchRole("SYSTEM_ADMIN");
  await assert.rejects(client.changeReferralLifecycle(submission), StaleResponseError);
  assert.equal(completeRequests, 0);
  assert.equal(client.submissionStatus(submission), "FAILED");
});

test("接收授课老师可以冻结并提交推荐完结命令", async () => {
  const requests = [];
  const client = new TeacherApiClient({
    idempotencyKeyFactory: () => "receiver-complete-key",
    transport: async (request) => {
      if (request.path === "/v1/session") return success(teacherSession("TEACHING_TEACHER"));
      requests.push(request);
      return success({ referralId: "ref-1", status: "COMPLETED", version: 3, unacceptedExpiresAt: null, replay: false });
    },
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const submission = client.createReferralLifecycleSubmission({ referralId: "ref-1", expectedVersion: 2, command: "COMPLETE" });
  assert.equal((await client.changeReferralLifecycle(submission)).status, "COMPLETED");
  assert.deepEqual(requests[0].body, { expectedVersion: 2, idempotencyKey: "receiver-complete-key" });
});
