import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../dist/main.js";

const at = new Date("2026-09-24T16:00:00.000Z");
const owner = { personId: "00000000-0000-4000-8000-000000000001", subject: "SYSTEM_OWNER", scope: "GLOBAL" };
const item = {
  auditItemId: "relationship:00000000-0000-4000-8000-000000000010",
  relationshipId: "00000000-0000-4000-8000-000000000010",
  relationshipFingerprint: "sha256:synthetic",
  relationshipType: "TEACHING_MENTOR",
  member: { personId: "00000000-0000-4000-8000-000000000011", nickname: "成员", personStatus: "ACTIVE" },
  relatedPerson: { personId: "00000000-0000-4000-8000-000000000012", nickname: "导师", personStatus: "ACTIVE" },
  validFrom: at.toISOString(), validTo: null, effectiveScope: "MENTEES", status: "CURRENT",
  matchingRoleAssignmentIds: [], sourceChange: null,
  referenceCounts: { weeklyFees: 0, allocationSnapshots: 0, referrals: 0 },
  anomalyCodes: [], repairability: "READ_ONLY", repairBlockedReason: null,
  createdBy: { personId: owner.personId, nickname: "管理员" }, createdAt: at.toISOString(),
};

const request = (query = {}, sessionId = "session") => ({
  method: "GET", path: "/v1/admin/person-relationships/audit", query, body: {}, sessionId,
});

const setup = (context = owner, enabled = true) => {
  const calls = [];
  return {
    calls,
    services: {
      now: () => at,
      sessions: { get: () => ({ currentRoleContext: context }) },
      weeklyFees: {},
      ...(enabled ? { personRelationshipAudit: { list: (received, filter, receivedAt) => {
        calls.push({ received, filter, receivedAt });
        return { snapshotAt: at.toISOString(), dataVersion: "snapshot-v1", items: [item], nextCursor: null };
      } } } : {}),
    },
  };
};

test("人员关系审计 HTTP 只投影白名单筛选并返回隐私最小化结果", async () => {
  const { calls, services } = setup();
  const result = await handleRequest(request({
    personId: item.member.personId,
    relationshipType: "TEACHING_MENTOR",
    status: "ANOMALOUS",
    anomalyCode: "RELATED_ROLE_INVALID",
    repairability: "REQUIRES_RELATIONSHIP_CORRECTION",
    cursor: "opaque-cursor",
    limit: "25",
  }), services);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data, { snapshotAt: at.toISOString(), dataVersion: "snapshot-v1", items: [item], nextCursor: null });
  assert.deepEqual(calls, [{
    received: owner,
    filter: {
      personId: item.member.personId,
      relationshipType: "TEACHING_MENTOR",
      status: "ANOMALOUS",
      anomalyCode: "RELATED_ROLE_INVALID",
      repairability: "REQUIRES_RELATIONSHIP_CORRECTION",
      cursor: "opaque-cursor",
      limit: 25,
    },
    receivedAt: at,
  }]);
  assert.equal(JSON.stringify(result).includes("phone"), false);
  assert.equal(JSON.stringify(result).includes("balance"), false);
});

test("人员关系审计 HTTP 拒绝非 GLOBAL 管理者、伪造字段、非法分页和缺失服务", async () => {
  for (const context of [
    { ...owner, subject: "HEADQUARTERS_FINANCE" },
    { ...owner, scope: "REGION", regionId: "region" },
    { ...owner, campusId: "campus" },
    { ...owner, venueId: "venue" },
  ]) assert.equal((await handleRequest(request(), setup(context).services)).status, 403);

  assert.equal((await handleRequest({ ...request(), sessionId: undefined }, setup().services)).status, 401);
  assert.equal((await handleRequest(request({ actorPersonId: owner.personId }), setup().services)).status, 400);
  for (const limit of ["", "0", "101", "1.5", "-1"]) {
    assert.equal((await handleRequest(request({ limit }), setup().services)).status, 400);
  }
  assert.equal((await handleRequest(request(), setup(owner, false).services)).status, 503);
});
