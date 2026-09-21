import test from "node:test";
import assert from "node:assert/strict";
import { SessionService, WeeklyFeeService } from "../dist/main.js";

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
    grossAmountCents: 100000n
  }, "request-1");
  const replay = service.recordWeeklyFee(teacherContext, {
    referralCaseId: "ref-1",
    teachingWeekId: "week-1",
    venueId: "venue-1",
    settlementMonth: "2026-09-01",
    grossAmountCents: 100000n
  }, "request-1");
  assert.equal(replay.version, 1);
  assert.equal(service.listHistory("ref-1", "week-1").length, 1);
  const corrected = service.recordWeeklyFee(teacherContext, {
    referralCaseId: "ref-1",
    teachingWeekId: "week-1",
    venueId: "venue-1",
    settlementMonth: "2026-09-01",
    grossAmountCents: 120000n
  }, "request-2");
  assert.equal(corrected.version, 2);
  assert.equal(service.getCurrent("ref-1", "week-1")?.grossAmountCents, 120000n);
  assert.equal(service.listHistory("ref-1", "week-1").length, 2);
  assert.throws(() => service.recordWeeklyFee(teacherContext, {
    referralCaseId: "ref-1",
    teachingWeekId: "week-1",
    venueId: "venue-disabled",
    settlementMonth: "2026-09-01",
    grossAmountCents: 120000n
  }, "request-3"), /VENUE_NOT_ACTIVE/);
  assert.throws(() => service.recordWeeklyFee(teacherContext, {
    referralCaseId: "ref-1",
    teachingWeekId: "week-1",
    venueId: "venue-1",
    settlementMonth: "2026-10-01",
    grossAmountCents: 120000n
  }, "request-4"), /PERIOD_MONTH_MISMATCH/);
  assert.throws(() => service.recordWeeklyFee(teacherContext, {
    referralCaseId: "ref-1",
    teachingWeekId: "week-1",
    venueId: "venue-1",
    settlementMonth: "2026-09-01",
    grossAmountCents: 130000n
  }, "request-2"), /IDEMPOTENCY_REPLAY/);
});
