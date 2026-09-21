import test from "node:test";
import assert from "node:assert/strict";
import { allocateSettlement, allocationDelta, appendLedgerEventOnce, sumLedgerDelta } from "../dist/index.js";

const input = (feeCents) => ({
  feeCents,
  netMonthlyCents: 0n,
  baseIntroRateBasisPoints: 1000n,
  mentorWeightBasisPoints: 2000n,
  groupLeaderRateBasisPoints: 600n,
  teachingMentorRateBasisPoints: 700n,
  venueRateBasisPoints: 0n,
  campusConsultationRateBasisPoints: 200n,
  platformFinanceRateBasisPoints: 200n,
  regionFinanceRateBasisPoints: 100n
});

const accountByKey = {
  referrer: "person-planner",
  planningMentor: "person-mentor",
  groupLeader: "person-group",
  teachingMentor: "person-teaching-mentor",
  venue: "venue-own",
  campusConsultation: "company-campus",
  platformFinance: "company-platform",
  regionFinance: "company-region",
  teachingTeacher: "person-teacher"
};

test("周费用更正只产生新旧分配差额", () => {
  const previous = allocateSettlement(input(100000n));
  const next = allocateSettlement(input(120000n));
  const delta = allocationDelta(previous, next, accountByKey);
  assert.equal(sumLedgerDelta(delta), 20000n);
  assert.deepEqual(Object.fromEntries(delta.map((item) => [item.accountKey, item.amountCents])), {
    "person-planner": 1600n,
    "person-mentor": 400n,
    "person-group": 1200n,
    "person-teaching-mentor": 1400n,
    "company-campus": 400n,
    "company-platform": 400n,
    "company-region": 200n,
    "person-teacher": 14400n
  });
});

test("同一类别换收款人时同时冲旧账户并增加新账户", () => {
  const previous = allocateSettlement(input(100000n));
  const next = allocateSettlement(input(100000n));
  const previousAccounts = { ...accountByKey, groupLeader: "person-group-a" };
  const nextAccounts = { ...accountByKey, groupLeader: "person-group-b" };
  const delta = allocationDelta(previous, next, previousAccounts, nextAccounts);
  assert.deepEqual(Object.fromEntries(delta.map((item) => [item.accountKey, item.amountCents])), {
    "person-group-a": -6000n,
    "person-group-b": 6000n
  });
  assert.equal(sumLedgerDelta(delta), 0n);
});

test("缺少账户映射拒绝生成分录", () => {
  const lines = allocateSettlement(input(100000n));
  assert.throws(() => allocationDelta(lines, lines, {}), /MISSING_ACCOUNT_MAPPING/);
});

test("重复事件不重复追加账本", () => {
  const event = { eventId: "fee-version-2", deltas: [{ accountKey: "person-teacher", categoryKey: "teachingTeacher", amountCents: 14400n }] };
  const once = appendLedgerEventOnce([], event);
  const twice = appendLedgerEventOnce(once, event);
  assert.equal(twice.length, 1);
  assert.deepEqual(twice[0], event);
  assert.throws(
    () => appendLedgerEventOnce(twice, { eventId: "fee-version-2", deltas: [{ accountKey: "person-teacher", categoryKey: "teachingTeacher", amountCents: 1n }] }),
    /LEDGER_EVENT_CONFLICT/
  );
});
