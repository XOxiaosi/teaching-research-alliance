import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../dist/main.js";

const at = new Date("2026-09-24T12:00:00.000Z");
const owner = { personId: "00000000-0000-4000-8000-000000000001", subject: "SYSTEM_OWNER", scope: "GLOBAL" };
const teacherId = "00000000-0000-4000-8000-000000000011";
const mentorId = "00000000-0000-4000-8000-000000000012";
const weekId = "00000000-0000-4000-8000-000000000013";
const throughWeekId = "00000000-0000-4000-8000-000000000014";
const preview = {
  previewId: "00000000-0000-4000-8000-000000000020",
  baseHash: "private",
  action: "ADD",
  teacherPersonId: teacherId,
  sourceRelatedPersonId: null,
  sourceRelatedNickname: null,
  newRelatedPersonId: mentorId,
  newRelatedNickname: "教学导师",
  effectiveTeachingWeekId: weekId,
  effectiveThroughTeachingWeekId: throughWeekId,
  effectiveAt: "2026-09-20T16:00:00.000Z",
  nextBoundaryAt: "2026-10-04T16:00:00.000Z",
  consideredFeeCount: 2,
  movedFeeCount: 0,
  zeroShareFeeCount: 2,
  excludedRefundCount: 1,
  movedAmountCents: "0",
};
const published = {
  changeId: "00000000-0000-4000-8000-000000000021",
  previewId: preview.previewId,
  relationshipVersion: 1,
  resultRelationshipId: "00000000-0000-4000-8000-000000000022",
  postingStatus: "NO_BALANCE_CHANGE",
  consideredFeeCount: 2,
  movedFeeCount: 0,
  excludedRefundCount: 1,
  movedAmountCents: "0",
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
        teachingMentorRelationships: {
          listDirectory: (received, receivedAt) => {
            calls.push(["directory", received, receivedAt]);
            return {
              teachers: [{ personId: teacherId, nickname: "授课老师", currentMentorPersonId: null, currentMentorNickname: null, currentRelationshipId: null }],
              mentors: [{ personId: mentorId, nickname: "教学导师", eligibleTeacherPersonIds: [teacherId] }],
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

test("教学导师目录、预览和发布只接受严格GLOBAL管理员并投影白名单", async () => {
  const { calls, services } = setup();
  const directory = await handleRequest(request("GET", "/v1/admin/person-relationships/teaching-mentor-candidates"), services);
  assert.equal(directory.status, 200);
  assert.deepEqual(directory.body.data, {
    teachers: [{ personId: teacherId, nickname: "授课老师", currentMentorPersonId: null, currentMentorNickname: null, currentRelationshipId: null }],
    mentors: [{ personId: mentorId, nickname: "教学导师", eligibleTeacherPersonIds: [teacherId] }],
    currentWeeks: [{ id: weekId, startsOn: "2026-09-21", endsOn: "2026-09-27", settlementMonth: "2026-09-01" }],
  });
  const response = await handleRequest(request("POST", "/v1/admin/person-relationships/teaching-mentor/preview", {
    teacherPersonId: teacherId,
    newRelatedPersonId: mentorId,
    effectiveTeachingWeekId: weekId,
    effectiveThroughTeachingWeekId: throughWeekId,
    reason: "补齐教学指导关系",
  }), services);
  assert.equal(response.status, 200);
  assert.equal("baseHash" in response.body.data, false);
  assert.deepEqual(calls[1]?.[2], {
    teacherPersonId: teacherId,
    newRelatedPersonId: mentorId,
    effectiveTeachingWeekId: weekId,
    effectiveThroughTeachingWeekId: throughWeekId,
    reason: "补齐教学指导关系",
  });
  const { baseHash: _privateHash, ...publicPreview } = preview;
  assert.deepEqual(response.body.data, publicPreview);
  const publish = await handleRequest(request("POST", "/v1/admin/person-relationships/teaching-mentor", {
    previewId: preview.previewId,
    idempotencyKey: "stable-key",
  }), services);
  assert.equal(publish.status, 200);
  assert.deepEqual(publish.body.data, published);
  for (const context of [
    { ...owner, subject: "TEACHING_MENTOR", scope: "MENTEES" },
    { ...owner, regionId: "00000000-0000-4000-8000-000000000030" },
    { ...owner, campusId: "00000000-0000-4000-8000-000000000031" },
  ]) {
    assert.equal((await handleRequest(request("GET", "/v1/admin/person-relationships/teaching-mentor-candidates"), setup(context).services)).status, 403);
  }
});

test("教学导师HTTP拒绝伪造字段和非法可选边界并映射预览冲突", async () => {
  const { services } = setup();
  for (const body of [
    { teacherPersonId: teacherId, newRelatedPersonId: mentorId, effectiveTeachingWeekId: weekId, effectiveThroughTeachingWeekId: "", reason: "x" },
    { teacherPersonId: teacherId, newRelatedPersonId: mentorId, effectiveTeachingWeekId: weekId, reason: "x", actorPersonId: owner.personId },
    { previewId: preview.previewId, idempotencyKey: "key", relationshipType: "TEACHING_MENTOR" },
  ]) {
    const path = body.previewId ? "/v1/admin/person-relationships/teaching-mentor" : "/v1/admin/person-relationships/teaching-mentor/preview";
    assert.equal((await handleRequest(request("POST", path, body), services)).status, 400);
  }
  assert.equal((await handleRequest({ ...request("GET", "/v1/admin/person-relationships/teaching-mentor-candidates"), sessionId: undefined }, services)).status, 401);
  assert.equal((await handleRequest(request("GET", "/v1/admin/person-relationships/teaching-mentor-candidates"), setup(owner, false).services)).status, 503);
  const stale = setup();
  stale.services.teachingMentorRelationships.publish = () => { throw new Error("RELATIONSHIP_PREVIEW_STALE"); };
  assert.equal((await handleRequest(request("POST", "/v1/admin/person-relationships/teaching-mentor", { previewId: preview.previewId, idempotencyKey: "key" }), stale.services)).status, 409);
  const missing = setup();
  missing.services.teachingMentorRelationships.publish = () => { throw new Error("RELATIONSHIP_PREVIEW_NOT_FOUND"); };
  assert.equal((await handleRequest(request("POST", "/v1/admin/person-relationships/teaching-mentor", { previewId: preview.previewId, idempotencyKey: "key" }), missing.services)).status, 404);
});
