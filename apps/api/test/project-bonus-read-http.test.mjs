import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../dist/main.js";

const at = new Date("2026-09-23T00:00:00.000Z");
const hq = { subject: "HEADQUARTERS_FINANCE", personId: "finance-person", scope: "GLOBAL" };
const servicesFor = (context = hq) => {
  const calls = [];
  return {
    calls,
    services: {
      sessions: { get: () => ({ currentRoleContext: context }) },
      weeklyFees: {},
      now: () => at,
      projectBonusReads: {
        list: (...args) => { calls.push(["list", ...args]); return { items: [], nextCursor: null }; },
        getDetail: (...args) => { calls.push(["detail", ...args]); return { documentId: args[1] }; },
      },
    },
  };
};

test("奖金历史 HTTP 路由透传分页、详情和当前上下文", async () => {
  const { calls, services } = servicesFor();
  const list = await handleRequest({ method: "GET", path: "/v1/finance/project-bonuses", sessionId: "session", body: {}, query: { cursor: "abc", limit: "25" } }, services);
  assert.equal(list.status, 200);
  assert.deepEqual(calls[0], ["list", hq, { cursor: "abc", limit: 25 }]);
  const detail = await handleRequest({ method: "GET", path: "/v1/finance/project-bonuses/document-1", sessionId: "session", body: {}, query: {} }, services);
  assert.equal(detail.status, 200);
  assert.deepEqual(calls[1], ["detail", hq, "document-1"]);
});

test("奖金历史 HTTP 路由拒绝非法查询、非空请求字段和缺失服务", async () => {
  const { calls, services } = servicesFor();
  for (const request of [
    { path: "/v1/finance/project-bonuses", query: { limit: "0" } },
    { path: "/v1/finance/project-bonuses", query: { limit: "101" } },
    { path: "/v1/finance/project-bonuses", query: { unknown: "x" } },
    { path: "/v1/finance/project-bonuses/document-1", query: { cursor: "x" } },
  ]) {
    const response = await handleRequest({ method: "GET", ...request, sessionId: "session", body: {} }, services);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_INPUT");
  }
  const forged = await handleRequest({ method: "GET", path: "/v1/finance/project-bonuses", sessionId: "session", body: { personId: "attacker" }, query: {} }, services);
  assert.equal(forged.status, 400);
  assert.equal(calls.length, 0);
  const unavailable = await handleRequest({ method: "GET", path: "/v1/finance/project-bonuses", sessionId: "session", body: {}, query: {} }, { sessions: services.sessions, weeklyFees: {}, now: () => at });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.error.code, "FINANCE_SERVICE_UNAVAILABLE");
});

test("奖金历史 HTTP 路由保留服务端越权隔离错误", async () => {
  const { services } = servicesFor({ subject: "REGION_FINANCE", personId: "regional", scope: "REGION", regionId: "region-1" });
  services.projectBonusReads.list = () => { throw new Error("FORBIDDEN_SCOPE"); };
  const response = await handleRequest({ method: "GET", path: "/v1/finance/project-bonuses", sessionId: "session", body: {}, query: {} }, services);
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "FORBIDDEN_SCOPE");
});
