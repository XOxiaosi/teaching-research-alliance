import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../dist/main.js";

const at = new Date("2026-09-23T00:00:00.000Z");
const ids = Object.fromEntries(["admin", "teacher", "campusA", "campusB", "regionA", "regionB", "principalA", "principalB", "preview", "change", "relationship"].map((key, index) => [key, `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`]));
const owner = { personId: ids.admin, subject: "SYSTEM_OWNER", scope: "GLOBAL" };
const preview = {
  previewId: ids.preview, personId: ids.teacher, targetCampusId: ids.campusB, targetRegionId: ids.regionB,
  targetPrincipalPersonId: ids.principalB, targetPrincipalNickname: "B校长", sourceCampusId: ids.campusA,
  sourceRegionId: ids.regionA, sourcePrincipalPersonId: ids.principalA, effectiveFrom: "2026-09-24T00:00:00.000Z",
  effectiveTo: null, consideredFeeCount: 1, changedFeeCount: 1, excludedRefundCount: 0,
  organizationImpact: { sourceCampusId: ids.campusA, sourceRegionId: ids.regionA, targetCampusId: ids.campusB, targetRegionId: ids.regionB, recordedGrossRevenueCents: "100000", refundedGrossRevenueCents: "0", effectiveGrossRevenueCents: "100000", campusManagementFeeCents: "3000" },
  accountDeltas: [{ accountCode: "company:B", categoryKey: "organization_revenue", amountCents: "100000" }],
};
const published = { changeId: ids.change, previewId: ids.preview, assignmentVersion: 1, resultAssignmentId: ids.teacher, resultCampusPrincipalRelationshipId: ids.relationship, postingStatus: "POSTED", consideredFeeCount: 1, changedFeeCount: 1, excludedRefundCount: 0, replay: false };

const setup = (roleContext = owner, enabled = true) => {
  const calls = [];
  return {
    calls,
    services: {
      now: () => at,
      sessions: { get: () => ({ currentRoleContext: roleContext }) },
      weeklyFees: {},
      ...(enabled ? { personCampusAssignments: {
        listDirectory: (context, receivedAt) => {
          calls.push(["directory", context, receivedAt]);
          return { people: [{ personId: ids.teacher, nickname: "教师", currentCampusId: ids.campusA, currentCampusName: "A校区", currentRegionId: ids.regionA, currentRegionName: "A分区" }], campuses: [{ campusId: ids.campusB, campusName: "B校区" }], regions: [{ regionId: ids.regionB, regionName: "B分区" }] };
        },
        preview: (context, draft, receivedAt) => { calls.push(["preview", context, draft, receivedAt]); return preview; },
        publish: (context, previewId, key, receivedAt) => { calls.push(["publish", context, previewId, key, receivedAt]); return published; },
      } } : {}),
    },
  };
};
const request = (method, path, body = {}, sessionId = "session") => ({ method, path, body, sessionId, query: {} });

test("人员换校区 HTTP 目录、预览、发布只接受严格全局管理员", async () => {
  const { calls, services } = setup();
  const directory = await handleRequest(request("GET", "/v1/admin/organization/person-campus-candidates"), services);
  assert.equal(directory.status, 200);
  assert.equal(directory.body.data.people[0].currentRegionName, "A分区");

  const previewResponse = await handleRequest(request("POST", "/v1/admin/organization/person-campus/preview", {
    personId: ids.teacher, targetCampusId: ids.campusB, effectiveFrom: "2026-09-24T00:00:00.000Z", effectiveTo: null, reason: "换校区",
  }), services);
  assert.equal(previewResponse.status, 200);
  assert.deepEqual(previewResponse.body.data, preview);
  assert.deepEqual(calls[1][2], { personId: ids.teacher, targetCampusId: ids.campusB, effectiveFrom: "2026-09-24T00:00:00.000Z", effectiveTo: null, reason: "换校区" });

  const publishResponse = await handleRequest(request("POST", "/v1/admin/organization/person-campus", { previewId: ids.preview, idempotencyKey: "p27-http" }), services);
  assert.equal(publishResponse.status, 200);
  assert.deepEqual(publishResponse.body.data, published);
  for (const roleContext of [
    { ...owner, subject: "PLANNING_MENTOR", scope: "SELF" },
    { ...owner, subject: "SYSTEM_ADMIN", regionId: ids.regionA },
    { ...owner, subject: "SYSTEM_OWNER", campusId: ids.campusA },
  ]) assert.equal((await handleRequest(request("GET", "/v1/admin/organization/person-campus-candidates"), setup(roleContext).services)).status, 403);
});

test("人员换校区 HTTP 拒绝无效输入并映射预览冲突和缺失", async () => {
  const { services } = setup();
  for (const body of [
    { personId: ids.teacher, targetCampusId: ids.campusB, effectiveFrom: "2026-09-24T00:00:00.000Z", reason: "x", actorPersonId: ids.admin },
    { personId: ids.teacher, targetCampusId: ids.campusB, effectiveFrom: "2026-09-24T00:00:00.000Z", effectiveTo: "", reason: "x" },
    { previewId: ids.preview, idempotencyKey: "p27-http", personId: ids.teacher },
  ]) {
    const path = body.previewId ? "/v1/admin/organization/person-campus" : "/v1/admin/organization/person-campus/preview";
    assert.equal((await handleRequest(request("POST", path, body), services)).status, 400);
  }
  assert.equal((await handleRequest(request("GET", "/v1/admin/organization/person-campus-candidates", {}, null), services)).status, 401);
  assert.equal((await handleRequest(request("GET", "/v1/admin/organization/person-campus-candidates"), setup(owner, false).services)).status, 503);
  const stale = setup();
  stale.services.personCampusAssignments.publish = () => { throw new Error("PERSON_CAMPUS_PREVIEW_STALE"); };
  assert.equal((await handleRequest(request("POST", "/v1/admin/organization/person-campus", { previewId: ids.preview, idempotencyKey: "p27-stale" }), stale.services)).status, 409);
  const missing = setup();
  missing.services.personCampusAssignments.publish = () => { throw new Error("PERSON_CAMPUS_PREVIEW_NOT_FOUND"); };
  assert.equal((await handleRequest(request("POST", "/v1/admin/organization/person-campus", { previewId: ids.preview, idempotencyKey: "p27-missing" }), missing.services)).status, 404);
});
