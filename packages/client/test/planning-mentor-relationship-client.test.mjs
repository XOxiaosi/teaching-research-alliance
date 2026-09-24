import assert from "node:assert/strict";
import test from "node:test";
import { ApiClientError, StaleResponseError, TeacherApiClient } from "../dist/index.js";

const success = data => ({ status: 200, body: { version: "test", data } });
const sessionFor = (scope = "SELF", suffix = "1") => {
  const context = { subject: "PLANNING_MENTOR", personId: "mentor-1", scope };
  return { sessionId: `mentor-session-${suffix}`, accountId: "account-1", personId: "mentor-1", roleContexts: [context], currentRoleContext: context };
};
const directory = {
  mentorPersonId: "mentor-1", mentorNickname: "规划导师甲",
  managedPlanners: [{ personId: "planner-1", nickname: "规划师甲", relationshipId: "relationship-1", validFrom: "2026-09-20T16:00:00.000Z", validTo: null }],
  availablePlanners: [{ personId: "planner-2", nickname: "规划师乙" }],
  currentWeeks: [{ id: "week-1", startsOn: "2026-09-21", endsOn: "2026-09-27", settlementMonth: "2026-09-01" }],
};
const draft = { action: "ADD", plannerPersonId: "planner-2", effectiveTeachingWeekId: "week-1", reason: "本周纳入管理" };
const preview = { previewId: "preview-1", ...draft, mentorPersonId: "mentor-1", plannerNickname: "规划师乙", effectiveAt: "2026-09-20T16:00:00.000Z", nextBoundaryAt: null, consideredFeeCount: 2, changedFeeCount: 1, zeroShareFeeCount: 1, excludedRefundCount: 0, plannerDeltaCents: "-200", mentorDeltaCents: "200" };
const published = { changeId: "change-1", previewId: "preview-1", action: "ADD", relationshipVersion: 1, resultRelationshipId: "relationship-2", postingStatus: "POSTED", consideredFeeCount: 2, changedFeeCount: 1, excludedRefundCount: 0, plannerDeltaCents: "-200", mentorDeltaCents: "200", replay: true };

test("规划导师关系客户端只发送本人普通周预览字段", async () => {
  const requests = [];
  const client = new TeacherApiClient({ transport: async request => {
    if (request.path === "/v1/session") return success(sessionFor());
    requests.push(request);
    return success(request.path.endsWith("/preview") ? preview : directory);
  }});
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  assert.deepEqual(await client.listPlanningMentorRelationships(), directory);
  assert.deepEqual(await client.previewPlanningMentorRelationshipChange({ ...draft, actorPersonId: "forged" }), preview);
  assert.deepEqual(requests.map(({ method, path, body }) => ({ method, path, body })), [
    { method: "GET", path: "/v1/planning-mentor/relationships", body: undefined },
    { method: "POST", path: "/v1/planning-mentor/relationships/preview", body: draft },
  ]);
  await assert.rejects(client.previewPlanningMentorRelationshipChange({ ...draft, reason: " " }), error => error instanceof ApiClientError && error.code === "INVALID_INPUT");
});

test("规划导师关系发布未知结果复用冻结的同一提交", async () => {
  const requests = []; let attempts = 0;
  const client = new TeacherApiClient({ idempotencyKeyFactory: () => "mentor-change-key", transport: async request => {
    if (request.path === "/v1/session") return success(sessionFor());
    requests.push(request); attempts += 1;
    if (attempts === 1) throw new Error("network uncertain");
    return success(published);
  }});
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const submission = client.createPlanningMentorRelationshipChangeSubmission("preview-1");
  assert.equal(Object.isFrozen(submission), true); assert.equal(Object.isFrozen(submission.draft), true);
  await assert.rejects(client.publishPlanningMentorRelationshipChange(submission), /network uncertain/);
  assert.deepEqual(await client.publishPlanningMentorRelationshipChange(submission), published);
  assert.deepEqual(requests.map(({ path, body }) => ({ path, body })), [
    { path: "/v1/planning-mentor/relationships", body: { previewId: "preview-1", idempotencyKey: "mentor-change-key" } },
    { path: "/v1/planning-mentor/relationships", body: { previewId: "preview-1", idempotencyKey: "mentor-change-key" } },
  ]);
});

test("规划导师关系客户端只允许 PLANNING_MENTOR SELF", async () => {
  for (const session of [sessionFor("ASSOCIATED_TEACHERS"), { ...sessionFor(), currentRoleContext: { personId: "mentor-1", subject: "ACADEMIC_PLANNER", scope: "SELF" } }]) {
    const client = new TeacherApiClient({ transport: async request => request.path === "/v1/session" ? success(session) : success(directory) });
    await client.login({ phoneNormalized: "13800000000", password: "password" });
    await assert.rejects(client.listPlanningMentorRelationships(), error => error instanceof ApiClientError && error.code === "FORBIDDEN_SCOPE");
  }
});

test("规划导师关系提交不能跨会话发布", async () => {
  let sessions = 0; let writes = 0;
  const client = new TeacherApiClient({ idempotencyKeyFactory: () => "stale-key", transport: async request => {
    if (request.path === "/v1/session") return success(sessionFor("SELF", String(++sessions)));
    writes += 1; return success(published);
  }});
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const submission = client.createPlanningMentorRelationshipChangeSubmission("preview-1");
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  await assert.rejects(client.publishPlanningMentorRelationshipChange(submission), StaleResponseError);
  assert.equal(writes, 0);
});
