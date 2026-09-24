import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../dist/main.js";

const at = new Date("2026-09-24T12:00:00.000Z");
const owner = { personId: "00000000-0000-4000-8000-000000000001", subject: "SYSTEM_OWNER", scope: "GLOBAL" };
const plannerId = "00000000-0000-4000-8000-000000000011";
const sourceMentorId = "00000000-0000-4000-8000-000000000012";
const destinationMentorId = "00000000-0000-4000-8000-000000000013";
const weekId = "00000000-0000-4000-8000-000000000014";
const throughWeekId = "00000000-0000-4000-8000-000000000015";
const preview = {
  previewId: "00000000-0000-4000-8000-000000000020",
  baseHash: "private",
  action: "REPLACE",
  plannerPersonId: plannerId,
  plannerNickname: "规划师",
  sourceMentorPersonId: sourceMentorId,
  sourceMentorNickname: "原规划导师",
  newMentorPersonId: destinationMentorId,
  newMentorNickname: "新规划导师",
  effectiveTeachingWeekId: weekId,
  effectiveThroughTeachingWeekId: throughWeekId,
  effectiveAt: "2026-09-20T16:00:00.000Z",
  nextBoundaryAt: "2026-10-04T16:00:00.000Z",
  consideredFeeCount: 3,
  changedFeeCount: 2,
  zeroShareFeeCount: 1,
  excludedRefundCount: 1,
  plannerDeltaCents: "0",
  sourceMentorDeltaCents: "-2500",
  destinationMentorDeltaCents: "2500",
};
const published = {
  changeId: "00000000-0000-4000-8000-000000000021",
  previewId: preview.previewId,
  action: "REPLACE",
  relationshipVersion: 2,
  resultRelationshipId: "00000000-0000-4000-8000-000000000022",
  postingStatus: "POSTED",
  consideredFeeCount: 3,
  changedFeeCount: 2,
  excludedRefundCount: 1,
  plannerDeltaCents: "0",
  sourceMentorDeltaCents: "-2500",
  destinationMentorDeltaCents: "2500",
  replay: false,
};

const setup = (context = owner, enabled = true) => {
  const calls = [];
  return {
    calls,
    services: {
      now: () => at,
      sessions: { get: () => ({ currentRoleContext: context }) },
      weeklyFees: {},
      ...(enabled ? {
        adminPlanningMentorRelationships: {
          listDirectory: (received, receivedAt) => {
            calls.push(["directory", received, receivedAt]);
            return {
              planners: [{ personId: plannerId, nickname: "规划师", currentMentorPersonId: sourceMentorId, currentMentorNickname: "原规划导师", currentRelationshipId: "00000000-0000-4000-8000-000000000030" }],
              mentors: [{ personId: destinationMentorId, nickname: "新规划导师" }],
              currentWeeks: [{ id: weekId, startsOn: "2026-09-21", endsOn: "2026-09-27", settlementMonth: "2026-09-01" }],
            };
          },
          preview: (received, draft, receivedAt) => { calls.push(["preview", received, draft, receivedAt]); return preview; },
          publish: (received, previewId, key, receivedAt) => { calls.push(["publish", received, previewId, key, receivedAt]); return published; },
        },
      } : {}),
    },
  };
};
const request = (method, path, body = {}) => ({ method, path, sessionId: "session", body, query: {} });

test("管理员规划导师目录、三方预览和发布只接受严格GLOBAL管理员", async () => {
  const { calls, services } = setup();
  const directory = await handleRequest(request("GET", "/v1/admin/person-relationships/planning-mentor-candidates"), services);
  assert.equal(directory.status, 200);
  assert.equal(directory.body.data.planners[0].currentMentorPersonId, sourceMentorId);

  const response = await handleRequest(request("POST", "/v1/admin/person-relationships/planning-mentor/preview", {
    action: "REPLACE",
    plannerPersonId: plannerId,
    newMentorPersonId: destinationMentorId,
    effectiveTeachingWeekId: weekId,
    effectiveThroughTeachingWeekId: throughWeekId,
    reason: "纠正规划导师",
  }), services);
  assert.equal(response.status, 200);
  assert.equal("baseHash" in response.body.data, false);
  assert.deepEqual(calls[1]?.[2], {
    action: "REPLACE",
    plannerPersonId: plannerId,
    newMentorPersonId: destinationMentorId,
    effectiveTeachingWeekId: weekId,
    effectiveThroughTeachingWeekId: throughWeekId,
    reason: "纠正规划导师",
  });
  const { baseHash: _privateHash, ...publicPreview } = preview;
  assert.deepEqual(response.body.data, publicPreview);

  const publish = await handleRequest(request("POST", "/v1/admin/person-relationships/planning-mentor", {
    previewId: preview.previewId,
    idempotencyKey: "stable-key",
  }), services);
  assert.equal(publish.status, 200);
  assert.deepEqual(publish.body.data, published);

  for (const context of [
    { ...owner, subject: "PLANNING_MENTOR", scope: "SELF" },
    { ...owner, subject: "SYSTEM_ADMIN", regionId: "00000000-0000-4000-8000-000000000040" },
    { ...owner, subject: "SYSTEM_OWNER", campusId: "00000000-0000-4000-8000-000000000041" },
  ]) {
    assert.equal((await handleRequest(request("GET", "/v1/admin/person-relationships/planning-mentor-candidates"), setup(context).services)).status, 403);
  }
});

test("管理员规划导师HTTP约束三种动作、白名单和预览冲突", async () => {
  const { services } = setup();
  for (const body of [
    { action: "REMOVE", plannerPersonId: plannerId, newMentorPersonId: destinationMentorId, effectiveTeachingWeekId: weekId, reason: "x" },
    { action: "ADD", plannerPersonId: plannerId, newMentorPersonId: null, effectiveTeachingWeekId: weekId, reason: "x" },
    { action: "REPLACE", plannerPersonId: plannerId, newMentorPersonId: destinationMentorId, effectiveTeachingWeekId: weekId, effectiveThroughTeachingWeekId: "", reason: "x" },
    { action: "REPLACE", plannerPersonId: plannerId, newMentorPersonId: destinationMentorId, effectiveTeachingWeekId: weekId, reason: "x", actorPersonId: owner.personId },
    { previewId: preview.previewId, idempotencyKey: "key", relationshipType: "PLANNING_MENTOR" },
  ]) {
    const path = body.previewId ? "/v1/admin/person-relationships/planning-mentor" : "/v1/admin/person-relationships/planning-mentor/preview";
    assert.equal((await handleRequest(request("POST", path, body), services)).status, 400);
  }
  assert.equal((await handleRequest({ ...request("GET", "/v1/admin/person-relationships/planning-mentor-candidates"), sessionId: undefined }, services)).status, 401);
  assert.equal((await handleRequest(request("GET", "/v1/admin/person-relationships/planning-mentor-candidates"), setup(owner, false).services)).status, 503);

  const stale = setup();
  stale.services.adminPlanningMentorRelationships.publish = () => { throw new Error("RELATIONSHIP_PREVIEW_STALE"); };
  assert.equal((await handleRequest(request("POST", "/v1/admin/person-relationships/planning-mentor", { previewId: preview.previewId, idempotencyKey: "key" }), stale.services)).status, 409);
  const missing = setup();
  missing.services.adminPlanningMentorRelationships.publish = () => { throw new Error("RELATIONSHIP_PREVIEW_NOT_FOUND"); };
  assert.equal((await handleRequest(request("POST", "/v1/admin/person-relationships/planning-mentor", { previewId: preview.previewId, idempotencyKey: "key" }), missing.services)).status, 404);
});
