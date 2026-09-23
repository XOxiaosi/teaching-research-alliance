import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../dist/main.js";

const at = new Date("2026-09-23T00:00:00.000Z");
const owner = { personId: "00000000-0000-4000-8000-000000000001", subject: "SYSTEM_OWNER", scope: "GLOBAL" };
const preview = {
  previewId: "00000000-0000-4000-8000-000000000010", baseHash: "private",
  teacherPersonId: "00000000-0000-4000-8000-000000000011", sourceRelatedPersonId: "00000000-0000-4000-8000-000000000012",
  newRelatedPersonId: "00000000-0000-4000-8000-000000000013", effectiveTeachingWeekId: "00000000-0000-4000-8000-000000000014",
  sourceRelatedNickname: "原组长",
  effectiveAt: "2026-09-21T16:00:00.000Z", nextBoundaryAt: null, consideredFeeCount: 2, movedFeeCount: 1,
  zeroShareFeeCount: 1, excludedRefundCount: 0, movedAmountCents: "120",
};
const published = {
  changeId: "00000000-0000-4000-8000-000000000015", previewId: preview.previewId, relationshipVersion: 2,
  resultRelationshipId: "00000000-0000-4000-8000-000000000016", postingStatus: "POSTED", consideredFeeCount: 2,
  movedFeeCount: 1, excludedRefundCount: 0, movedAmountCents: "120", replay: false,
};

const setup = (context = owner, enabled = true) => {
  const calls = [];
  return { calls, services: {
    now: () => at,
    sessions: { get: () => ({ currentRoleContext: context }) }, weeklyFees: {},
    ...(enabled ? {
      groupLeaderDirectory: { list: (received, receivedAt) => { calls.push(["directory", received, receivedAt]); return {
        groupLeaders: [{ personId: preview.newRelatedPersonId, nickname: "新组长" }],
        teachers: [{ personId: preview.teacherPersonId, nickname: "教师" }],
        currentWeeks: [{ id: preview.effectiveTeachingWeekId, startsOn: "2026-09-22", endsOn: "2026-09-28", settlementMonth: "2026-09-01" }],
      }; } },
      groupLeaderRelationships: {
        preview: (received, draft, receivedAt) => { calls.push(["preview", received, draft, receivedAt]); return preview; },
        publish: (received, previewId, key, receivedAt) => { calls.push(["publish", received, previewId, key, receivedAt]); return published; },
      },
    } : {}),
  }};
};
const request = (method, path, body = {}) => ({ method, path, sessionId: "session", body, query: {} });


test("组长关系目录、预览和发布只接受严格 GLOBAL 管理者并投影白名单字段", async () => {
  const { calls, services } = setup();
  const directory = await handleRequest(request("GET", "/v1/admin/person-relationships/group-leader-candidates"), services);
  assert.equal(directory.status, 200);
  assert.deepEqual(directory.body.data, {
    groupLeaders: [{ personId: preview.newRelatedPersonId, nickname: "新组长" }],
    teachers: [{ personId: preview.teacherPersonId, nickname: "教师" }],
    currentWeeks: [{ id: preview.effectiveTeachingWeekId, startsOn: "2026-09-22", endsOn: "2026-09-28", settlementMonth: "2026-09-01" }],
  });
  const pre = await handleRequest(request("POST", "/v1/admin/person-relationships/preview", {
    teacherPersonId: preview.teacherPersonId, newRelatedPersonId: preview.newRelatedPersonId,
    effectiveTeachingWeekId: preview.effectiveTeachingWeekId, reason: "调整",
  }), services);
  assert.equal(pre.status, 200);
  assert.equal("baseHash" in pre.body.data, false);
  assert.equal(pre.body.data.sourceRelatedNickname, "原组长");
  assert.deepEqual(calls[1]?.[2], { teacherPersonId: preview.teacherPersonId, newRelatedPersonId: preview.newRelatedPersonId, effectiveTeachingWeekId: preview.effectiveTeachingWeekId, reason: "调整" });
  const publish = await handleRequest(request("POST", "/v1/admin/person-relationships", { previewId: preview.previewId, idempotencyKey: "same-key" }), services);
  assert.equal(publish.status, 200);
  assert.deepEqual(publish.body.data, published);
  for (const context of [
    { ...owner, subject: "HEADQUARTERS_FINANCE" }, { ...owner, regionId: "r" },
    { ...owner, campusId: "c" }, { ...owner, venueId: "v" },
  ]) assert.equal((await handleRequest(request("GET", "/v1/admin/person-relationships/group-leader-candidates"), setup(context).services)).status, 403);
});

test("组长关系 HTTP 拒绝伪造范围、额外字段和缺失服务，并正确映射可预期冲突", async () => {
  const { services } = setup();
  for (const body of [
    { teacherPersonId: preview.teacherPersonId, newRelatedPersonId: preview.newRelatedPersonId, effectiveTeachingWeekId: preview.effectiveTeachingWeekId, reason: "x", at: "forged" },
    { previewId: preview.previewId, idempotencyKey: "key", actorPersonId: owner.personId },
  ]) assert.equal((await handleRequest(request("POST", body.previewId ? "/v1/admin/person-relationships" : "/v1/admin/person-relationships/preview", body), services)).status, 400);
  assert.equal((await handleRequest({ ...request("GET", "/v1/admin/person-relationships/group-leader-candidates"), sessionId: undefined }, services)).status, 401);
  assert.equal((await handleRequest(request("GET", "/v1/admin/person-relationships/group-leader-candidates"), setup(owner, false).services)).status, 503);
  const stale = setup(); stale.services.groupLeaderRelationships.publish = () => { throw new Error("RELATIONSHIP_PREVIEW_STALE"); };
  assert.equal((await handleRequest(request("POST", "/v1/admin/person-relationships", { previewId: preview.previewId, idempotencyKey: "key" }), stale.services)).status, 409);
  const missing = setup(); missing.services.groupLeaderRelationships.publish = () => { throw new Error("RELATIONSHIP_PREVIEW_NOT_FOUND"); };
  assert.equal((await handleRequest(request("POST", "/v1/admin/person-relationships", { previewId: preview.previewId, idempotencyKey: "key" }), missing.services)).status, 404);
  const internal = setup(); internal.services.groupLeaderRelationships.preview = () => { throw new Error("RELATIONSHIP_DATA_UNAVAILABLE"); };
  const result = await handleRequest(request("POST", "/v1/admin/person-relationships/preview", { teacherPersonId: preview.teacherPersonId, newRelatedPersonId: preview.newRelatedPersonId, effectiveTeachingWeekId: preview.effectiveTeachingWeekId, reason: "x" }), internal.services);
  assert.deepEqual(result.body.error, { code: "INTERNAL_ERROR", message: "INTERNAL_ERROR" });
});
