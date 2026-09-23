import test from "node:test";
import assert from "node:assert/strict";
import { WeeklyFeeService } from "../dist/weekly-fee-service.js";

test("内存周费用服务与数据库一致：停用原场地仍可改错但不可新选", () => {
  const venue = { id: "venue", status: "ACTIVE" };
  const context = { personId: "teacher", subject: "TEACHING_TEACHER", scope: "SELF" };
  const service = new WeeklyFeeService({
    referrals: [{ id: "referral", receiverPersonId: "teacher", status: "ACCEPTED" }],
    teachingWeeks: ["week", "next-week"].map(id => ({ id, settlementMonth: "2026-09-01", status: "OPEN" })),
    venues: [venue, { id: "other", status: "INACTIVE" }]
  });
  const draft = { referralCaseId: "referral", teachingWeekId: "week", venueId: "venue", settlementMonth: "2026-09-01", grossAmountCents: 100000n, expectedVersion: 0 };
  service.recordWeeklyFee(context, draft, "first");
  venue.status = "INACTIVE";
  const correction = { ...draft, grossAmountCents: 120000n, expectedVersion: 1 };
  assert.equal(service.recordWeeklyFee(context, correction, "correct").version, 2);
  assert.equal(service.recordWeeklyFee(context, correction, "correct").version, 2);
  assert.throws(() => service.recordWeeklyFee(context, { ...correction, venueId: "other", expectedVersion: 2 }, "change"), /VENUE_NOT_ACTIVE/);
  assert.throws(() => service.recordWeeklyFee(context, { ...draft, teachingWeekId: "next-week" }, "new"), /VENUE_NOT_ACTIVE/);
  assert.throws(() => service.recordWeeklyFee({ ...context, personId: "outsider" }, { ...correction, expectedVersion: 2 }, "outsider"), /FORBIDDEN_SCOPE/);
  assert.deepEqual(service.listHistory("referral", "week").map(row => row.grossAmountCents), [100000n, 120000n]);
});
