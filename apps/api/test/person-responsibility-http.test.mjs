import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../dist/main.js";

const at = new Date("2026-09-23T00:00:00.000Z");
const actor = { personId: "00000000-0000-4000-8000-000000000001", subject: "SYSTEM_OWNER", scope: "GLOBAL" };
const personId = "00000000-0000-4000-8000-000000000002";
const assignmentId = "00000000-0000-4000-8000-000000000003";
const request = (method, path, body = {}) => ({ method, path, body, sessionId: "session", query: {} });

const setup = () => {
  const calls = [];
  return { calls, services: {
    now: () => at, sessions: { get: () => ({ currentRoleContext: actor }) }, weeklyFees: {},
    accountAccess: {
      listPeople: (context, receivedAt) => { calls.push(["list",context,receivedAt]); return [{ personId, responsibilities: [] }]; },
      assignRole: (context, target, draft, key, receivedAt) => { calls.push(["assign",context,target,draft,key,receivedAt]); return { personId: target, assignment: { assignmentId }, authVersion: "2", replay: false }; },
      revokeRole: (context, target, reason, key, receivedAt) => { calls.push(["revoke",context,target,reason,key,receivedAt]); return { personId, assignment: { assignmentId: target }, authVersion: "3", replay: false }; },
      setPersonStatus: (context, target, status, reason, key, receivedAt) => { calls.push(["status",context,target,status,reason,key,receivedAt]); return { personId: target, personStatus: status, authVersion: "4", replay: false }; },
      updatePersonProfile: (context, target, nickname, legalName, expectedVersion, reason, key, receivedAt) => { calls.push(["profile",context,target,nickname,legalName,expectedVersion,reason,key,receivedAt]); return { personId: target, nickname, legalName, profileVersion: "2", changedAt: receivedAt.toISOString(), replay: false }; },
    },
  }};
};

test("人员职责四条 HTTP 路由传递白名单参数，撤销不接收客户端时间", async () => {
  const { calls, services } = setup();
  assert.equal((await handleRequest(request("GET", "/v1/admin/people"), services)).status, 200);
  assert.equal((await handleRequest(request("GET", "/v1/admin/people", { forged: "field" }), services)).status, 400);
  const assignment = await handleRequest(request("POST", `/v1/admin/people/${personId}/role-assignments`, {
    subject: "TEACHING_TEACHER", scope: "SELF", validFrom: "2026-10-01T00:00:00.000Z", reason: "任命", idempotencyKey: "assign-key",
  }), services);
  assert.equal(assignment.status, 200);
  assert.deepEqual(calls[1]?.slice(2), [personId, { subject: "TEACHING_TEACHER", scope: "SELF", validFrom: "2026-10-01T00:00:00.000Z", reason: "任命" }, "assign-key", at]);
  const revoked = await handleRequest(request("POST", `/v1/admin/role-assignments/${assignmentId}/revoke`, { reason: "撤销", idempotencyKey: "revoke-key" }), services);
  assert.equal(revoked.status, 200);
  assert.deepEqual(calls[2]?.slice(2), [assignmentId, "撤销", "revoke-key", at]);
  const status = await handleRequest(request("POST", `/v1/admin/people/${personId}/status`, { status: "INACTIVE", reason: "离职", idempotencyKey: "status-key" }), services);
  assert.equal(status.status, 200);
  assert.deepEqual(calls[3]?.slice(2), [personId, "INACTIVE", "离职", "status-key", at]);
  const profile = await handleRequest(request("POST", `/v1/admin/people/${personId}/profile`, { nickname: "新昵称", legalName: "新实名", expectedProfileVersion: "1", reason: "资料更正", idempotencyKey: "profile-key" }), services);
  assert.equal(profile.status, 200);
  assert.deepEqual(calls[4]?.slice(2), [personId, "新昵称", "新实名", "1", "资料更正", "profile-key", at]);
  for (const [path, body] of [
    [`/v1/admin/role-assignments/${assignmentId}/revoke`, { reason: "撤销", idempotencyKey: "key", validTo: "forged" }],
    [`/v1/admin/people/${personId}/status`, { status: "INACTIVE", reason: "离职", idempotencyKey: "key", actorPersonId: personId }],
  ]) assert.equal((await handleRequest(request("POST", path, body), services)).status, 400);
});

test("人员职责 HTTP 将治理权限与重叠冲突映射为可预期状态码", async () => {
  const forbidden = setup();
  forbidden.services.accountAccess.assignRole = () => { throw new Error("ONLY_SYSTEM_OWNER_CAN_MANAGE_ADMIN"); };
  const denied = await handleRequest(request("POST", `/v1/admin/people/${personId}/role-assignments`, { subject: "SYSTEM_ADMIN", scope: "GLOBAL", validFrom: "2026-10-01T00:00:00.000Z", reason: "任命", idempotencyKey: "key" }), forbidden.services);
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.body.error, { code: "ONLY_SYSTEM_OWNER_CAN_MANAGE_ADMIN", message: "ONLY_SYSTEM_OWNER_CAN_MANAGE_ADMIN" });
  const conflict = setup();
  conflict.services.accountAccess.assignRole = () => { throw new Error("ROLE_ASSIGNMENT_OVERLAP"); };
  assert.equal((await handleRequest(request("POST", `/v1/admin/people/${personId}/role-assignments`, { subject: "TEACHING_TEACHER", scope: "SELF", validFrom: "2026-10-01T00:00:00.000Z", reason: "重复", idempotencyKey: "key" }), conflict.services)).status, 409);
  const inactive = setup();
  inactive.services.accountAccess.assignRole = () => { throw new Error("PERSON_INACTIVE"); };
  const inactiveResponse = await handleRequest(request("POST", `/v1/admin/people/${personId}/role-assignments`, { subject: "PLANNING_MENTOR", scope: "SELF", validFrom: "2026-10-01T00:00:00.000Z", reason: "停用人员", idempotencyKey: "key" }), inactive.services);
  assert.equal(inactiveResponse.status, 409);
  assert.deepEqual(inactiveResponse.body.error, { code: "PERSON_INACTIVE", message: "PERSON_INACTIVE" });
  const stale = setup();
  stale.services.accountAccess.updatePersonProfile = () => { throw new Error("PROFILE_VERSION_STALE"); };
  const staleResponse = await handleRequest(request("POST", `/v1/admin/people/${personId}/profile`, { nickname: "新昵称", legalName: "新实名", expectedProfileVersion: "1", reason: "资料更正", idempotencyKey: "key" }), stale.services);
  assert.equal(staleResponse.status, 409);
});
