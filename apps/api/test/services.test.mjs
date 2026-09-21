import test from "node:test";
import assert from "node:assert/strict";
import { SessionService, WeeklyFeeService, handleRequest } from "../dist/main.js";
import { DEFAULT_RATE_POLICY_VALUES, RatePolicyService } from "@teaching-research-alliance/domain";

const now = new Date("2026-09-20T10:00:00.000Z");
const teacherContext = { subject: "TEACHING_TEACHER", personId: "teacher-1" };

test("登录只返回当前有效职责，切换职责不合并权限", () => {
  const service = new SessionService({
    accounts: [{
      accountId: "account-1",
      personId: "teacher-1",
      phoneNormalized: "13800000000",
      credentialDigest: "digest-1",
      status: "ACTIVE"
    }],
    assignments: [
      { personId: "teacher-1", subject: "TEACHING_TEACHER", scope: "SELF", validFrom: new Date("2026-01-01") },
      { personId: "teacher-1", subject: "GROUP_LEADER", scope: "ASSOCIATED_TEACHERS", validFrom: new Date("2026-01-01") },
      { personId: "teacher-1", subject: "CAMPUS_PRINCIPAL", scope: "CAMPUS", scopeId: "campus-old", validFrom: new Date("2026-10-01") }
    ],
    sessionIdFactory: () => "session-1"
  });
  const loggedIn = service.login("13800000000", "digest-1", now);
  assert.deepEqual(loggedIn.roleContexts.map((context) => context.subject), ["TEACHING_TEACHER", "GROUP_LEADER"]);
  assert.equal(loggedIn.currentRoleContext, null);
  const switched = service.switchRole("session-1", "GROUP_LEADER", now);
  assert.equal(switched.currentRoleContext?.subject, "GROUP_LEADER");
  assert.equal(switched.currentRoleContext?.personId, "teacher-1");
  assert.throws(() => service.switchRole("session-1", "CAMPUS_PRINCIPAL", now), /ROLE_CONTEXT_NOT_ASSIGNED/);
  service.revokeAccount("account-1");
  assert.throws(() => service.get("session-1", now), /UNAUTHENTICATED/);
});

test("教师接收推荐后可在正常场地登记周累计费用，并按版本保留历史", () => {
  const service = new WeeklyFeeService({
    referrals: [{ id: "ref-1", receiverPersonId: "teacher-1", status: "PENDING" }],
    teachingWeeks: [{ id: "week-1", settlementMonth: "2026-09-01", status: "OPEN" }],
    venues: [
      { id: "venue-1", status: "ACTIVE" },
      { id: "venue-disabled", status: "INACTIVE" }
    ]
  });
  assert.equal(service.acceptReferral(teacherContext, "ref-1").status, "ACCEPTED");
  const first = service.recordWeeklyFee(teacherContext, {
    referralCaseId: "ref-1",
    teachingWeekId: "week-1",
    venueId: "venue-1",
    settlementMonth: "2026-09-01",
    grossAmountCents: 100000n,
    expectedVersion: 0
  }, "request-1");
  const replay = service.recordWeeklyFee(teacherContext, {
    referralCaseId: "ref-1",
    teachingWeekId: "week-1",
    venueId: "venue-1",
    settlementMonth: "2026-09-01",
    grossAmountCents: 100000n,
    expectedVersion: 0
  }, "request-1");
  assert.equal(replay.version, 1);
  assert.equal(service.listHistory("ref-1", "week-1").length, 1);
  const corrected = service.recordWeeklyFee(teacherContext, {
    referralCaseId: "ref-1",
    teachingWeekId: "week-1",
    venueId: "venue-1",
    settlementMonth: "2026-09-01",
    grossAmountCents: 120000n,
    expectedVersion: 1
  }, "request-2");
  assert.equal(corrected.version, 2);
  assert.equal(service.getCurrent("ref-1", "week-1")?.grossAmountCents, 120000n);
  assert.equal(service.listHistory("ref-1", "week-1").length, 2);
  assert.throws(() => service.recordWeeklyFee(teacherContext, {
    referralCaseId: "ref-1",
    teachingWeekId: "week-1",
    venueId: "venue-disabled",
    settlementMonth: "2026-09-01",
    grossAmountCents: 120000n,
    expectedVersion: 2
  }, "request-3"), /VENUE_NOT_ACTIVE/);
  assert.throws(() => service.recordWeeklyFee(teacherContext, {
    referralCaseId: "ref-1",
    teachingWeekId: "week-1",
    venueId: "venue-1",
    settlementMonth: "2026-10-01",
    grossAmountCents: 120000n,
    expectedVersion: 2
  }, "request-4"), /PERIOD_MONTH_MISMATCH/);
  assert.throws(() => service.recordWeeklyFee(teacherContext, {
    referralCaseId: "ref-1",
    teachingWeekId: "week-1",
    venueId: "venue-1",
    settlementMonth: "2026-09-01",
    grossAmountCents: 130000n,
    expectedVersion: 1
  }, "request-2"), /IDEMPOTENCY_REPLAY/);
});

test("HTTP请求处理器复用服务层并统一返回版本和错误码", async () => {
  const sessions = new SessionService({
    accounts: [{
      accountId: "account-1",
      personId: "teacher-1",
      phoneNormalized: "13800000000",
      credentialDigest: "digest-1",
      status: "ACTIVE"
    }],
    assignments: [{ personId: "teacher-1", subject: "TEACHING_TEACHER", scope: "SELF", validFrom: new Date("2026-01-01") }],
    sessionIdFactory: () => "session-http"
  });
  const weeklyFees = new WeeklyFeeService({
    referrals: [{ id: "ref-http", receiverPersonId: "teacher-1", status: "PENDING" }],
    teachingWeeks: [{ id: "week-http", settlementMonth: "2026-09-01", status: "OPEN" }],
    venues: [{ id: "venue-http", status: "ACTIVE" }]
  });
  const services = {
    sessions,
    referralAcceptance: { accept: async (context, referralId, draft, key) => {
      assert.deepEqual(draft, {expectedVersion: 1, venueId: "venue-http"});
      assert.equal(key, "accept-http");
      return weeklyFees.acceptReferral(context, referralId);
    } },
    weeklyFees: {
      acceptReferral: async (context, referralId) => weeklyFees.acceptReferral(context, referralId),
      recordWeeklyFee: async (context, draft, idempotencyKey) => weeklyFees.recordWeeklyFee(context, draft, idempotencyKey)
    },
    now: () => now
  };
  const login = await handleRequest({
    method: "POST",
    path: "/v1/session",
    body: { phoneNormalized: "13800000000", credentialDigest: "digest-1" }
  }, services);
  assert.equal(login.status, 200);
  assert.equal(login.body.version, "2026-09-20.dev-001");
  assert.equal(login.body.data?.sessionId, "session-http");
  const switched = await handleRequest({
    method: "POST",
    path: "/v1/role-contexts/switch",
    body: { sessionId: "session-http", subject: "TEACHING_TEACHER" }
  }, services);
  assert.equal(switched.status, 200);
  const accepted = await handleRequest({
    method: "POST",
    path: "/v1/referrals/ref-http/accept",
    body: { sessionId: "session-http", expectedVersion: 1, venueId: "venue-http", idempotencyKey: "accept-http" }
  }, services);
  assert.equal(accepted.status, 200);
  const missingVersion = await handleRequest({
    method: "POST",
    path: "/v1/referrals/ref-http/weekly-fees",
    body: {
      sessionId: "session-http",
      teachingWeekId: "week-http",
      venueId: "venue-http",
      settlementMonth: "2026-09-01",
      grossAmountCents: "100000",
      idempotencyKey: "http-request-missing-version"
    }
  }, services);
  assert.equal(missingVersion.status, 400);
  assert.equal(missingVersion.body.error?.code, "INVALID_INPUT");
  for (const [grossAmountCents, idempotencyKey] of [["0x10", "http-request-hex"], ["10.5", "http-request-decimal"]]) {
    const invalidAmount = await handleRequest({
      method: "POST",
      path: "/v1/referrals/ref-http/weekly-fees",
      body: {
        sessionId: "session-http",
        teachingWeekId: "week-http",
        venueId: "venue-http",
        settlementMonth: "2026-09-01",
        grossAmountCents,
        expectedVersion: 0,
        idempotencyKey
      }
    }, services);
    assert.equal(invalidAmount.status, 400);
    assert.equal(invalidAmount.body.error?.code, "INVALID_INPUT");
  }
  const recorded = await handleRequest({
    method: "POST",
    path: "/v1/referrals/ref-http/weekly-fees",
    body: {
      sessionId: "session-http",
      teachingWeekId: "week-http",
      venueId: "venue-http",
      settlementMonth: "2026-09-01",
      grossAmountCents: "100000",
      expectedVersion: 0,
      idempotencyKey: "http-request-1",
      personId: "attacker-cannot-override-session"
    }
  }, services);
  assert.equal(recorded.status, 200);
  assert.equal(recorded.body.data?.version, 1);
  const invalid = await handleRequest({
    method: "POST",
    path: "/v1/referrals/ref-http/weekly-fees",
    body: {
      sessionId: "session-http",
      teachingWeekId: "week-http",
      venueId: "venue-http",
      settlementMonth: "2026-09-01",
      grossAmountCents: "100000",
      expectedVersion: 0,
      idempotencyKey: "http-request-1"
    }
  }, services);
  assert.equal(invalid.status, 200);
  const corrected = await handleRequest({
    method: "POST",
    path: "/v1/referrals/ref-http/weekly-fees",
    body: {
      sessionId: "session-http",
      teachingWeekId: "week-http",
      venueId: "venue-http",
      settlementMonth: "2026-09-01",
      grossAmountCents: "120000",
      expectedVersion: 1,
      idempotencyKey: "http-request-correction-a"
    }
  }, services);
  assert.equal(corrected.status, 200);
  assert.equal(corrected.body.data?.version, 2);
  const staleCorrection = await handleRequest({
    method: "POST",
    path: "/v1/referrals/ref-http/weekly-fees",
    body: {
      sessionId: "session-http",
      teachingWeekId: "week-http",
      venueId: "venue-http",
      settlementMonth: "2026-09-01",
      grossAmountCents: "130000",
      expectedVersion: 1,
      idempotencyKey: "http-request-correction-b"
    }
  }, services);
  assert.equal(staleCorrection.status, 409);
  assert.equal(staleCorrection.body.error?.code, "VERSION_CONFLICT");
  const missing = await handleRequest({ method: "GET", path: "/v1/unknown", body: {} }, services);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error?.code, "NOT_FOUND");
});

test("管理员费率预览与发布通过HTTP边界保留版本", async () => {
  const sessions = new SessionService({
    accounts: [{ accountId: "admin-account", personId: "admin-1", phoneNormalized: "13900000000", credentialDigest: "admin-digest", status: "ACTIVE" }],
    assignments: [{ personId: "admin-1", subject: "SYSTEM_ADMIN", scope: "GLOBAL", validFrom: new Date("2026-01-01") }],
    sessionIdFactory: () => "admin-session"
  });
  const ratePolicies = new RatePolicyService({ previewIdFactory: () => "http-rate-preview", now: () => "2026-09-20T10:00:00.000Z" });
  const services = {
    sessions,
    weeklyFees: new WeeklyFeeService({ referrals: [], teachingWeeks: [], venues: [] }),
    ratePolicies,
    now: () => now
  };
  const login = await handleRequest({ method: "POST", path: "/v1/session", body: { phoneNormalized: "13900000000", credentialDigest: "admin-digest" } }, services);
  assert.equal(login.status, 200);
  const switched = await handleRequest({ method: "POST", path: "/v1/role-contexts/switch", body: { sessionId: "admin-session", subject: "SYSTEM_ADMIN" } }, services);
  assert.equal(switched.status, 200);
  const preview = await handleRequest({
    method: "POST",
    path: "/v1/admin/rates/preview",
    body: {
      sessionId: "admin-session",
      ...Object.fromEntries(Object.entries(DEFAULT_RATE_POLICY_VALUES).filter(([key]) => key !== "dynamicTiers").map(([key, value]) => [key, value.toString()])),
      dynamicTiers: DEFAULT_RATE_POLICY_VALUES.dynamicTiers.map((tier) => ({
        label: tier.label,
        adjustmentBasisPoints: tier.adjustmentBasisPoints.toString(),
        ...(tier.minExclusive === undefined ? {} : { minExclusive: tier.minExclusive.toString() }),
        ...(tier.maxInclusive === undefined ? {} : { maxInclusive: tier.maxInclusive.toString() })
      })),
      effectiveFrom: "2026-09-01",
      reason: "HTTP费率发布测试"
    }
  }, services);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.data?.previewId, "http-rate-preview");
  const published = await handleRequest({ method: "POST", path: "/v1/admin/rates/publish", body: { sessionId: "admin-session", previewId: "http-rate-preview" } }, services);
  assert.equal(published.status, 200);
  assert.equal(published.body.data?.version, 1);
});

test("个人读取使用稳定404错误码，未装配服务返回500且不泄露内部原因", async () => {
  const context = { subject: "TEACHING_TEACHER", personId: "teacher-read" };
  const services = { sessions: { get: () => ({ currentRoleContext: context }) }, weeklyFees: {}, now: () => new Date() };
  const request = { method: "GET", path: "/v1/me", body: {}, sessionId: "read-session" };
  const unavailable = await handleRequest(request, services);
  assert.equal(unavailable.status, 500);
  assert.deepEqual(unavailable.body.error, { code: "INTERNAL_ERROR", message: "INTERNAL_ERROR" });
  const missing = await handleRequest(request, { ...services, personal: { getOwnOverview: () => { throw new Error("PERSONAL_ACCOUNT_NOT_FOUND"); } } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "PERSONAL_ACCOUNT_NOT_FOUND");
});

 test("unexpected database errors never expose internal details", async () => {
  const result = await handleRequest({method: "POST", path: "/v1/session", body: {phoneNormalized: "13800000000", credentialDigest: "bad"}}, {
    sessions: {login() { throw new Error('relation user_session password_hash does not exist'); }},
    weeklyFees: {}, now: () => now
  });
  assert.equal(result.status, 500);
  assert.deepEqual(result.body.error, {code: "INTERNAL_ERROR", message: "INTERNAL_ERROR"});
 });

test("teaching reads and session restore use authenticated actor and trusted clock", async () => {
  const context = { subject: "TEACHING_TEACHER", personId: "teacher-authenticated" };
  const view = { sessionId: "token", personId: context.personId, accountId: "account", currentRoleContext: context, roleContexts: [context] };
  const calls = [];
  let clockReads = 0;
  const services = {
    sessions: {get(token, at) { assert.equal(token, "token"); assert.equal(at, now); return view; }},
    weeklyFees: {},
    teaching: {
      listReceivedReferrals(actor, at) { calls.push([actor, at]); return [{referralId: "own-referral"}]; },
      listOpenTeachingWeeks(actor, at) { calls.push([actor, at]); return [{weekId: "open-week"}]; }
    }, now: () => { clockReads++; return now; }
  };
  for (const path of ["/v1/teaching/referrals", "/v1/teaching/weeks"]) {
    const before = clockReads;
    const result = await handleRequest({method: "GET", path, sessionId: "token", body: {personId: "another-person", sessionId: "forged"}}, services);
    assert.equal(result.status, 200);
    assert.deepEqual(calls.at(-1), [context, now]);
    assert.equal(clockReads-before, 1);
    const missing = await handleRequest({method: "GET", path, body: {}}, services);
    assert.equal(missing.status, 401);
  }
  const restored = await handleRequest({method: "GET", path: "/v1/session", sessionId: "token", body: {}}, services);
  assert.deepEqual(restored.body.data.currentRoleContext, context);
});
