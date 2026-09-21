import { allocateRationalCents, type AllocationLine, type Cents } from "./index.js";
import { calculateReferralRates } from "./rates.js";

export type SettlementInput = Readonly<{
  feeCents: Cents;
  netMonthlyCents: Cents;
  baseIntroRateBasisPoints: bigint;
  mentorWeightBasisPoints: bigint;
  groupLeaderRateBasisPoints: bigint;
  teachingMentorRateBasisPoints: bigint;
  venueRateBasisPoints: bigint;
  campusConsultationRateBasisPoints: bigint;
  platformFinanceRateBasisPoints: bigint;
  regionFinanceRateBasisPoints: bigint;
}>;

export const SETTLEMENT_KEYS = [
  "referrer",
  "planningMentor",
  "groupLeader",
  "teachingMentor",
  "venue",
  "campusConsultation",
  "platformFinance",
  "regionFinance",
  "teachingTeacher"
] as const;

const BASIS_POINT_DENOMINATOR = 10_000n;
const RATIONAL_DENOMINATOR = BASIS_POINT_DENOMINATOR * BASIS_POINT_DENOMINATOR;

const toRationalNumerator = (rateBasisPoints: bigint): bigint => rateBasisPoints * BASIS_POINT_DENOMINATOR;

export const allocateSettlement = (input: SettlementInput): readonly AllocationLine[] => {
  if (input.feeCents < 0n) throw new Error("NEGATIVE_FEE");
  const referral = calculateReferralRates({
    baseRateBasisPoints: input.baseIntroRateBasisPoints,
    netMonthlyCents: input.netMonthlyCents,
    mentorWeightBasisPoints: input.mentorWeightBasisPoints
  });
  const fixedNumerators = [
    input.groupLeaderRateBasisPoints,
    input.teachingMentorRateBasisPoints,
    input.venueRateBasisPoints,
    input.campusConsultationRateBasisPoints,
    input.platformFinanceRateBasisPoints,
    input.regionFinanceRateBasisPoints
  ].map(toRationalNumerator);
  const referralNumerators = [
    referral.referrerBasisPointsNumerator,
    referral.mentorBasisPointsNumerator
  ];
  const usedNumerator = [...referralNumerators, ...fixedNumerators].reduce((sum, value) => sum + value, 0n);
  const teacherNumerator = RATIONAL_DENOMINATOR - usedNumerator;
  if (teacherNumerator < 0n) throw new Error("ALLOCATION_EXCEEDS_FEE");
  const rates = [
    referralNumerators[0] ?? 0n,
    referralNumerators[1] ?? 0n,
    ...fixedNumerators,
    teacherNumerator
  ];
  return allocateRationalCents(input.feeCents, RATIONAL_DENOMINATOR, SETTLEMENT_KEYS.map((key, index) => ({
    key,
    numerator: rates[index] ?? 0n
  })));
};
