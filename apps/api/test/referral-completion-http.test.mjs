import assert from "node:assert/strict";
import test from "node:test";

import { handleRequest } from "../dist/main.js";

const at = new Date("2026-09-24T04:00:00.000Z");
const context = {
  personId: "00000000-0000-4000-8000-000000000001",
  subject: "SYSTEM_ADMIN",
  scope: "GLOBAL",
};
const referralId = "00000000-0000-4000-8000-000000000002";

const setup = () => {
  const calls = [];
  return {
    calls,
    services: {
      now: () => at,
      sessions: { get: (sessionId) => {
        calls.push(["session", sessionId]);
        return { currentRoleContext: context };
      } },
      weeklyFees: {},
      managedReferrals: { list: (...args) => {
        calls.push(["managed", ...args]);
        return [];
      } },
      referralLifecycle: {
        archive: () => { throw new Error("NOT_USED"); },
        reactivate: () => { throw new Error("NOT_USED"); },
        complete: (...args) => {
          calls.push(["complete", ...args]);
          return { referralId, status: "COMPLETED", version: 3, unacceptedExpiresAt: null, replay: false };
        },
      },
    },
  };
};

test("管理推荐目录接受 Bearer 注入的唯一 sessionId，并拒绝客户端筛选", async () => {
  const { calls, services } = setup();
  const response = await handleRequest({
    method: "GET", path: "/v1/referrals/managed", sessionId: "admin-session", body: {}, query: {},
  }, services);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data, []);
  assert.deepEqual(calls, [["session", "admin-session"], ["managed", context, at]]);

  for (const changed of [{ body: { status: "ACCEPTED" } }, { query: { receiverPersonId: "forged" } }]) {
    const denied = await handleRequest({
      method: "GET", path: "/v1/referrals/managed", sessionId: "admin-session", body: {}, query: {}, ...changed,
    }, services);
    assert.equal(denied.status, 400);
    assert.equal(denied.body.error.code, "INVALID_INPUT");
  }
});

test("完结 HTTP 只传可信角色、版本、幂等键和服务端时钟", async () => {
  const { calls, services } = setup();
  const response = await handleRequest({
    method: "POST",
    path: `/v1/referrals/${referralId}/complete`,
    sessionId: "teacher-session",
    body: { expectedVersion: 2, idempotencyKey: "complete-key" },
    query: {},
  }, services);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    ["session", "teacher-session"],
    ["complete", context, referralId, { expectedVersion: 2 }, "complete-key", at],
  ]);
  const forged = await handleRequest({
    method: "POST",
    path: `/v1/referrals/${referralId}/complete`,
    sessionId: "teacher-session",
    body: { expectedVersion: 2, idempotencyKey: "complete-key", actorPersonId: "forged" },
    query: {},
  }, services);
  assert.equal(forged.status, 400);
  assert.equal(forged.body.error.code, "INVALID_INPUT");
});
