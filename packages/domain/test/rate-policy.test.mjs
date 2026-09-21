import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RATE_POLICY_VALUES,
  RatePolicyService,
  calculateReferralRates,
  validateRatePolicyDraft
} from "../dist/index.js";

const draft = (overrides = {}) => ({
  ...DEFAULT_RATE_POLICY_VALUES,
  effectiveFrom: "2026-09-01",
  reason: "管理员配置测试",
  ...overrides
});

test("默认费率配置可通过校验，管理员可预览并发布版本", () => {
  const service = new RatePolicyService({
    previewIdFactory: () => "preview-1",
    now: () => "2026-09-20T10:00:00.000Z"
  });
  assert.deepEqual(validateRatePolicyDraft(draft()), []);
  const preview = service.preview("SYSTEM_ADMIN", draft());
  assert.equal(preview.valid, true);
  assert.deepEqual(preview.errors, []);
  const published = service.publish("SYSTEM_ADMIN", "preview-1");
  assert.equal(published.version, 1);
  assert.equal(published.publishedBy, "SYSTEM_ADMIN");
  assert.equal(service.historyVersions("SYSTEM_OWNER").length, 1);
});

test("非管理员不能预览、发布或读取完整配置", () => {
  const service = new RatePolicyService();
  assert.throws(() => service.preview("GROUP_LEADER", draft()), /FORBIDDEN_SCOPE/);
  assert.throws(() => service.historyVersions("REGION_FINANCE"), /FORBIDDEN_SCOPE/);
  const view = service.viewFor("GROUP_LEADER");
  assert.deepEqual(Object.keys(view.visibleRates), ["groupLeaderRateBasisPoints"]);
  assert.equal(view.visibleRates.groupLeaderRateBasisPoints, 600n);
});

test("配置发布校验区间连续性和总比例，错误版本不能发布", () => {
  const service = new RatePolicyService({ previewIdFactory: () => "invalid-preview" });
  const preview = service.preview("SYSTEM_ADMIN", draft({
    platformFinanceRateBasisPoints: 10_000n,
    dynamicTiers: [{ label: "only", adjustmentBasisPoints: 0n, minExclusive: 1n }]
  }));
  assert.equal(preview.valid, false);
  assert.ok(preview.errors.includes("DYNAMIC_TIER_FIRST_MIN_MUST_BE_OPEN"));
  assert.ok(preview.errors.some((error) => error.startsWith("PLANNER_TOTAL_EXCEEDS_100:")));
  assert.throws(() => service.publish("SYSTEM_ADMIN", "invalid-preview"), /INVALID_RATE_POLICY/);
});

test("制度费率发布保留历史，个人职责只能看到对应比例", () => {
  const service = new RatePolicyService({
    previewIdFactory: (() => {
      let index = 0;
      return () => `preview-${++index}`;
    })(),
    now: () => "2026-09-20T10:00:00.000Z"
  });
  service.publish("SYSTEM_OWNER", service.preview("SYSTEM_OWNER", draft({
    groupLeaderRateBasisPoints: 625n,
    reason: "调整组长比例"
  })).previewId);
  assert.equal(service.current().version, 1);
  assert.equal(service.viewFor("GROUP_LEADER").visibleRates.groupLeaderRateBasisPoints, 625n);
  assert.deepEqual(Object.keys(service.viewFor("CAMPUS_PRINCIPAL").visibleRates), ["campusConsultationForPlannerRateBasisPoints"]);
});

test("发布的自定义动态档位可被纯计算读取", () => {
  const dynamicTiers = [{ label: "all", adjustmentBasisPoints: -100n }];
  const result = calculateReferralRates({
    baseRateBasisPoints: 1000n,
    netMonthlyCents: 500000n,
    mentorWeightBasisPoints: 2000n,
    dynamicTiers
  });
  assert.equal(result.adjustmentBasisPoints, -100n);
  assert.equal(result.actualPoolBasisPoints, 900n);
  assert.equal(result.referrerBasisPointsNumerator, 7200000n);
});
