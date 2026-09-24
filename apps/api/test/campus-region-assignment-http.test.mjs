import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../dist/main.js";

const at = new Date("2026-09-24T00:00:00.000Z");
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ids = { admin: id(1), campus: id(2), sourceRegion: id(3), targetRegion: id(4), preview: id(5), change: id(6), result: id(7) };
const owner = { personId: ids.admin, subject: "SYSTEM_OWNER", scope: "GLOBAL" };
const preview = {
  previewId: ids.preview, campusId: ids.campus, sourceRegionId: ids.sourceRegion, targetRegionId: ids.targetRegion,
  effectiveFrom: "2026-09-25T00:00:00.000Z", effectiveTo: null, affectedPersonCount: 2, affectedAssignmentCount: 2,
  consideredFeeCount: 3, changedFeeCount: 1, excludedRefundCount: 1,
  organizationImpact: { sourceRegionId: ids.sourceRegion, targetRegionId: ids.targetRegion, recordedGrossRevenueCents: "3000", refundedGrossRevenueCents: "1000", effectiveGrossRevenueCents: "2000", campusManagementFeeCents: "40" },
  accountDeltas: [{ accountCode: "region:new", categoryKey: "regionFinance", amountCents: "20" }],
};
const published = { changeId: ids.change, previewId: ids.preview, campusVersion: 1, resultCampusRegionAssignmentId: ids.result, affectedPersonCount: 2, affectedAssignmentCount: 2, postingStatus: "POSTED", consideredFeeCount: 3, changedFeeCount: 1, excludedRefundCount: 1, replay: false };

const setup = (context = owner, enabled = true) => {
  const calls = [];
  return { calls, services: { now: () => at, sessions: { get: () => ({ currentRoleContext: context }) }, weeklyFees: {}, ...(enabled ? { campusRegionAssignments: {
    directory: (role, receivedAt) => { calls.push(["directory", role, receivedAt]); return { campuses: [{ campusId: ids.campus, campusName: "校区", currentRegionId: ids.sourceRegion, currentRegionName: "原分区" }], regions: [{ regionId: ids.targetRegion, regionName: "新分区" }] }; },
    preview: (role, draft, receivedAt) => { calls.push(["preview", role, draft, receivedAt]); return preview; },
    publish: (role, previewId, key, receivedAt) => { calls.push(["publish", role, previewId, key, receivedAt]); return published; },
  } } : {}) } };
};
const request = (method, path, body = {}, sessionId = "session") => ({ method, path, body, sessionId, query: {} });

test("校区换分区 HTTP 目录、冻结预览和发布只接受严格全局管理员", async () => {
  const { calls, services } = setup();
  assert.equal((await handleRequest(request("GET", "/v1/admin/organization/campus-region-candidates"), services)).body.data.campuses[0].currentRegionName, "原分区");
  const result = await handleRequest(request("POST", "/v1/admin/organization/campus-region/preview", { campusId: ids.campus, targetRegionId: ids.targetRegion, effectiveFrom: preview.effectiveFrom, effectiveTo: null, reason: "校区调整分区" }), services);
  assert.deepEqual(result.body.data, preview);
  assert.deepEqual(calls[1][2], { campusId: ids.campus, targetRegionId: ids.targetRegion, effectiveFrom: preview.effectiveFrom, effectiveTo: null, reason: "校区调整分区" });
  assert.deepEqual((await handleRequest(request("POST", "/v1/admin/organization/campus-region", { previewId: ids.preview, idempotencyKey: "c2-http" }), services)).body.data, published);
  for (const role of [{ ...owner, subject: "REGION_FINANCE", scope: "REGION", regionId: ids.sourceRegion }, { ...owner, subject: "SYSTEM_ADMIN", campusId: ids.campus }]) {
    assert.equal((await handleRequest(request("GET", "/v1/admin/organization/campus-region-candidates"), setup(role).services)).status, 403);
  }
});

test("校区换分区 HTTP 拒绝附加字段并映射陈旧、缺失和结算故障", async () => {
  const { services } = setup();
  assert.equal((await handleRequest(request("POST", "/v1/admin/organization/campus-region/preview", { campusId: ids.campus, targetRegionId: ids.targetRegion, effectiveFrom: preview.effectiveFrom, reason: "x", actorPersonId: ids.admin }), services)).status, 400);
  assert.equal((await handleRequest(request("GET", "/v1/admin/organization/campus-region-candidates", {}, null), services)).status, 401);
  assert.equal((await handleRequest(request("GET", "/v1/admin/organization/campus-region-candidates"), setup(owner, false).services)).status, 503);
  for (const [code, status] of [["CAMPUS_REGION_PREVIEW_STALE", 409], ["CAMPUS_REGION_PREVIEW_NOT_FOUND", 404], ["CAMPUS_REGION_CAMPUS_NOT_FOUND", 404], ["CAMPUS_REGION_TARGET_NOT_FOUND", 404], ["CAMPUS_REGION_SETTLEMENT_DATA_UNAVAILABLE", 500]]) {
    const fixture = setup(); fixture.services.campusRegionAssignments.publish = () => { throw new Error(code); };
    assert.equal((await handleRequest(request("POST", "/v1/admin/organization/campus-region", { previewId: ids.preview, idempotencyKey: "c2-error" }), fixture.services)).status, status);
  }
});
