import type { Cents } from "./index.js";

export type DynamicTier = Readonly<{
  label: string;
  minExclusive?: Cents;
  maxInclusive?: Cents;
  adjustmentBasisPoints: bigint;
}>;

const bean = (value: number): Cents => BigInt(Math.round(value * 100));

/** 1%=100 basis points；区间按PRODUCT的左开右闭规则保存。 */
export const DYNAMIC_TIERS: readonly DynamicTier[] = [
  { label: "<=-30000", maxInclusive: bean(-30_000), adjustmentBasisPoints: -200n },
  { label: "(-30000,-25000]", minExclusive: bean(-30_000), maxInclusive: bean(-25_000), adjustmentBasisPoints: -160n },
  { label: "(-25000,-20000]", minExclusive: bean(-25_000), maxInclusive: bean(-20_000), adjustmentBasisPoints: -120n },
  { label: "(-20000,-15000]", minExclusive: bean(-20_000), maxInclusive: bean(-15_000), adjustmentBasisPoints: -80n },
  { label: "(-15000,-10000]", minExclusive: bean(-15_000), maxInclusive: bean(-10_000), adjustmentBasisPoints: -40n },
  { label: "(-10000,6000]", minExclusive: bean(-10_000), maxInclusive: bean(6_000), adjustmentBasisPoints: 0n },
  { label: "(6000,8000]", minExclusive: bean(6_000), maxInclusive: bean(8_000), adjustmentBasisPoints: 50n },
  { label: "(8000,9000]", minExclusive: bean(8_000), maxInclusive: bean(9_000), adjustmentBasisPoints: 100n },
  { label: "(9000,10000]", minExclusive: bean(9_000), maxInclusive: bean(10_000), adjustmentBasisPoints: 150n },
  { label: "(10000,11000]", minExclusive: bean(10_000), maxInclusive: bean(11_000), adjustmentBasisPoints: 200n },
  { label: "(11000,12000]", minExclusive: bean(11_000), maxInclusive: bean(12_000), adjustmentBasisPoints: 250n },
  { label: "(12000,13000]", minExclusive: bean(12_000), maxInclusive: bean(13_000), adjustmentBasisPoints: 300n },
  { label: "(13000,14000]", minExclusive: bean(13_000), maxInclusive: bean(14_000), adjustmentBasisPoints: 350n },
  { label: "(14000,15000]", minExclusive: bean(14_000), maxInclusive: bean(15_000), adjustmentBasisPoints: 400n },
  { label: ">15000", minExclusive: bean(15_000), adjustmentBasisPoints: 450n }
];

export const dynamicAdjustmentBasisPoints = (
  netMonthlyCents: Cents,
  tiers: readonly DynamicTier[] = DYNAMIC_TIERS
): bigint => {
  const tier = tiers.find((item) =>
    (item.minExclusive === undefined || netMonthlyCents > item.minExclusive) &&
    (item.maxInclusive === undefined || netMonthlyCents <= item.maxInclusive)
  );
  if (!tier) throw new Error("DYNAMIC_TIER_NOT_FOUND");
  return tier.adjustmentBasisPoints;
};

export type ReferralRateInput = Readonly<{
  baseRateBasisPoints: bigint;
  netMonthlyCents: Cents;
  mentorWeightBasisPoints: bigint;
  dynamicTiers?: readonly DynamicTier[];
}>;

export type ReferralRateResult = Readonly<{
  adjustmentBasisPoints: bigint;
  actualPoolBasisPoints: bigint;
  /** 子项比例必须保留分子，不能在这里整除丢掉中间精度。 */
  splitDenominator: bigint;
  referrerBasisPointsNumerator: bigint;
  mentorBasisPointsNumerator: bigint;
}>;

export const calculateReferralRates = (input: ReferralRateInput): ReferralRateResult => {
  if (input.baseRateBasisPoints < 0n || input.baseRateBasisPoints > 10_000n) throw new Error("INVALID_BASE_RATE");
  if (input.mentorWeightBasisPoints < 0n || input.mentorWeightBasisPoints > 10_000n) throw new Error("INVALID_MENTOR_WEIGHT");
  const adjustmentBasisPoints = dynamicAdjustmentBasisPoints(input.netMonthlyCents, input.dynamicTiers ?? DYNAMIC_TIERS);
  const actualPoolBasisPoints = input.baseRateBasisPoints + adjustmentBasisPoints;
  if (actualPoolBasisPoints < 0n || actualPoolBasisPoints > 10_000n) throw new Error("INVALID_REFERRAL_POOL");
  return {
    adjustmentBasisPoints,
    actualPoolBasisPoints,
    splitDenominator: 10_000n,
    referrerBasisPointsNumerator: actualPoolBasisPoints * (10_000n - input.mentorWeightBasisPoints),
    mentorBasisPointsNumerator: actualPoolBasisPoints * input.mentorWeightBasisPoints
  };
};
