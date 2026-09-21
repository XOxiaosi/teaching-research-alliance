import test from "node:test";
import assert from "node:assert/strict";
import { calculateReferralRates, dynamicAdjustmentBasisPoints } from "../dist/index.js";

test("15档动态费率的边界按左开右闭命中", () => {
  assert.equal(dynamicAdjustmentBasisPoints(-3000000n), -200n);
  assert.equal(dynamicAdjustmentBasisPoints(-2999999n), -160n);
  assert.equal(dynamicAdjustmentBasisPoints(-1000000n), -40n);
  assert.equal(dynamicAdjustmentBasisPoints(-999999n), 0n);
  assert.equal(dynamicAdjustmentBasisPoints(600000n), 0n);
  assert.equal(dynamicAdjustmentBasisPoints(600001n), 50n);
  assert.equal(dynamicAdjustmentBasisPoints(1500000n), 400n);
  assert.equal(dynamicAdjustmentBasisPoints(1500001n), 450n);
});

test("规划师介绍费负动态按池内权重缩放", () => {
  const result = calculateReferralRates({
    baseRateBasisPoints: 1000n,
    netMonthlyCents: 0n,
    mentorWeightBasisPoints: 2000n
  });
  assert.deepEqual(result, {
    adjustmentBasisPoints: 0n,
    actualPoolBasisPoints: 1000n,
    splitDenominator: 10000n,
    referrerBasisPointsNumerator: 8000000n,
    mentorBasisPointsNumerator: 2000000n
  });

  const negative = calculateReferralRates({
    baseRateBasisPoints: 1000n,
    netMonthlyCents: -3000000n,
    mentorWeightBasisPoints: 2000n
  });
  assert.deepEqual(negative, {
    adjustmentBasisPoints: -200n,
    actualPoolBasisPoints: 800n,
    splitDenominator: 10000n,
    referrerBasisPointsNumerator: 6400000n,
    mentorBasisPointsNumerator: 1600000n
  });
});

test("非整数基点权重保留分子，不提前舍入", () => {
  const result = calculateReferralRates({
    baseRateBasisPoints: 1001n,
    netMonthlyCents: 0n,
    mentorWeightBasisPoints: 2000n
  });
  assert.equal(result.referrerBasisPointsNumerator, 8008000n);
  assert.equal(result.mentorBasisPointsNumerator, 2002000n);
  assert.equal(
    result.referrerBasisPointsNumerator + result.mentorBasisPointsNumerator,
    result.actualPoolBasisPoints * result.splitDenominator
  );
});
