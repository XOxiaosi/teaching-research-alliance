import test from "node:test";
import assert from "node:assert/strict";
import { allocateSettlement, sumCents } from "../dist/index.js";

const base = {
  netMonthlyCents: 0n,
  baseIntroRateBasisPoints: 1000n,
  mentorWeightBasisPoints: 2000n,
  groupLeaderRateBasisPoints: 600n,
  teachingMentorRateBasisPoints: 700n,
  venueRateBasisPoints: 0n,
  campusConsultationRateBasisPoints: 200n,
  platformFinanceRateBasisPoints: 200n,
  regionFinanceRateBasisPoints: 100n
};

const asBeans = (lines) => Object.fromEntries(lines.map((line) => [line.key, Number(line.cents) / 100]));

test("零动态、本人场地的1000豆九项分配守恒", () => {
  const lines = allocateSettlement({ ...base, feeCents: 100000n });
  assert.deepEqual(asBeans(lines), {
    referrer: 80,
    planningMentor: 20,
    groupLeader: 60,
    teachingMentor: 70,
    venue: 0,
    campusConsultation: 20,
    platformFinance: 20,
    regionFinance: 10,
    teachingTeacher: 720
  });
  assert.equal(sumCents(lines), 100000n);
});

test("修改为1200豆只改变分配结果总差额200豆", () => {
  const lines = allocateSettlement({ ...base, feeCents: 120000n });
  assert.deepEqual(asBeans(lines), {
    referrer: 96,
    planningMentor: 24,
    groupLeader: 72,
    teachingMentor: 84,
    venue: 0,
    campusConsultation: 24,
    platformFinance: 24,
    regionFinance: 12,
    teachingTeacher: 864
  });
  assert.equal(sumCents(lines), 120000n);
});

test("负动态和他人场地按计划算例分配", () => {
  const lines = allocateSettlement({ ...base, feeCents: 100000n, netMonthlyCents: -3000000n, venueRateBasisPoints: 500n });
  assert.deepEqual(asBeans(lines), {
    referrer: 64,
    planningMentor: 16,
    groupLeader: 60,
    teachingMentor: 70,
    venue: 50,
    campusConsultation: 20,
    platformFinance: 20,
    regionFinance: 10,
    teachingTeacher: 690
  });
  assert.equal(sumCents(lines), 100000n);
});
