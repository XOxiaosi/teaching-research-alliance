import assert from "node:assert/strict";
import test from "node:test";
import { ApiClientError, TeacherApiClient } from "../dist/index.js";

const session = { sessionId: "s", accountId: "a", personId: "admin", roleContexts: [{ subject: "SYSTEM_ADMIN", scope: "GLOBAL", personId: "admin" }], currentRoleContext: { subject: "SYSTEM_ADMIN", scope: "GLOBAL", personId: "admin" } };
const success = (data) => ({ status: 200, body: { version: "test", data } });
const setup = async () => {
  const calls = [];
  const client = new TeacherApiClient({ idempotencyKeyFactory: () => "apm-key", transport: async (request) => { calls.push(request); return request.path === "/v1/session" ? success(session) : success({}); } });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  return { client, calls };
};

test("管理员规划导师目录、预览和发布使用独立正式端点", async () => {
  const { client, calls } = await setup();
  await client.listAdminPlanningMentorRelationshipCandidates();
  await client.previewAdminPlanningMentorRelationshipChange({ action: "REPLACE", plannerPersonId: "planner", newMentorPersonId: "mentor-b", effectiveTeachingWeekId: "week", effectiveThroughTeachingWeekId: null, reason: "更正归属" });
  const command = client.createAdminPlanningMentorRelationshipChangeSubmission("preview-1");
  assert.deepEqual(command, { draft: { previewId: "preview-1" }, idempotencyKey: "apm-key" });
  await client.publishAdminPlanningMentorRelationshipChange(command);
  assert.equal(calls[1].path, "/v1/admin/person-relationships/planning-mentor-candidates");
  assert.deepEqual(calls[2].body, { action: "REPLACE", plannerPersonId: "planner", newMentorPersonId: "mentor-b", effectiveTeachingWeekId: "week", effectiveThroughTeachingWeekId: null, reason: "更正归属" });
  assert.equal(calls[3].path, "/v1/admin/person-relationships/planning-mentor");
  assert.equal(calls[3].body.idempotencyKey, "apm-key");
});

test("管理员规划导师三动作校验目标导师和严格GLOBAL权限", async () => {
  const { client } = await setup();
  await assert.rejects(() => client.previewAdminPlanningMentorRelationshipChange({ action: "ADD", plannerPersonId: "planner", newMentorPersonId: null, effectiveTeachingWeekId: "week", reason: "x" }), ApiClientError);
  await assert.rejects(() => client.previewAdminPlanningMentorRelationshipChange({ action: "REMOVE", plannerPersonId: "planner", newMentorPersonId: "mentor", effectiveTeachingWeekId: "week", reason: "x" }), ApiClientError);
  await assert.rejects(() => client.previewAdminPlanningMentorRelationshipChange({ action: "ADD", plannerPersonId: "planner", newMentorPersonId: "planner", effectiveTeachingWeekId: "week", reason: "x" }), ApiClientError);
  const scoped = new TeacherApiClient({ transport: async (request) => request.path === "/v1/session" ? success({ ...session, currentRoleContext: { subject: "SYSTEM_ADMIN", scope: "REGION", personId: "admin" } }) : success({}) });
  await scoped.login({ phoneNormalized: "13800000000", password: "password" });
  assert.throws(() => scoped.createAdminPlanningMentorRelationshipChangeSubmission("preview"), (error) => error.status === 403);
});
