import test from "node:test";
import assert from "node:assert/strict";
import { assertValidWeeklyFeeDraft, validateWeeklyFeeDraft } from "../dist/index.js";

const validDraft = {
  referralCaseId: "referral-1",
  teachingWeekId: "week-1",
  venueId: "venue-1",
  settlementMonth: "2026-09-01",
  grossAmountCents: 0n
};

test("0豆周费用合法保存，空白月份和空场地不转成默认值", () => {
  assert.deepEqual(validateWeeklyFeeDraft(validDraft), []);
  assert.deepEqual(validateWeeklyFeeDraft({ ...validDraft, settlementMonth: "", venueId: "" }), [
    "VENUE_REQUIRED",
    "SETTLEMENT_MONTH_MUST_BE_MONTH_START"
  ]);
});

test("周费用拒绝负数并保留字段级错误", () => {
  assert.throws(
    () => assertValidWeeklyFeeDraft({ ...validDraft, grossAmountCents: -1n }),
    /INVALID_WEEKLY_FEE:GROSS_AMOUNT_NEGATIVE/
  );
});
