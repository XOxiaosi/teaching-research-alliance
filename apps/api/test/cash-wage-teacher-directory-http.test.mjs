import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApiServer, handleRequest } from "../dist/main.js";

const at = new Date("2026-09-23T00:00:00Z");
const path = "/v1/finance/cash-wage-teachers";
const global = {
  personId: "finance-1",
  subject: "HEADQUARTERS_FINANCE",
  scope: "GLOBAL",
};

const setup = (context = global, withDirectory = true) => {
  const calls = [];
  return {
    calls,
    services: {
      now: () => at,
      sessions: { get: () => ({ currentRoleContext: context }) },
      weeklyFees: {},
      ...(withDirectory
        ? {
            cashWageTeacherDirectory: {
              list: (received) => {
                calls.push(received);
                return {
                  items: [
                    { personId: "teacher-1", nickname: "林老师" },
                  ],
                };
              },
            },
          }
        : {}),
    },
  };
};

const request = {
  method: "GET",
  path,
  sessionId: "session",
  body: {},
  query: {},
};

test("工资候选目录只向严格全局工资管理角色公开，并投影为公共 id/nickname", async () => {
  for (const subject of [
    "SYSTEM_OWNER",
    "SYSTEM_ADMIN",
    "HEADQUARTERS_FINANCE",
  ]) {
    const { calls, services } = setup({ ...global, subject });
    const result = await handleRequest(request, services);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data, {
      items: [{ id: "teacher-1", nickname: "林老师" }],
    });
    assert.deepEqual(calls, [{ ...global, subject }]);
  }

  for (const context of [
    { ...global, subject: "TEACHING_TEACHER", scope: "SELF" },
    { ...global, subject: "REGION_FINANCE", scope: "REGION", regionId: "r1" },
    { ...global, regionId: "r1" },
    { ...global, campusId: "c1" },
    { ...global, venueId: "v1" },
  ]) {
    const { calls, services } = setup(context);
    assert.equal((await handleRequest(request, services)).status, 403);
    assert.equal(calls.length, 0);
  }
});

test("工资候选目录拒绝未登录和全部客户筛选，并清楚报告服务缺失", async () => {
  const { calls, services } = setup();
  assert.equal(
    (await handleRequest({ ...request, sessionId: undefined }, services)).status,
    401,
  );
  for (const changed of [
    { body: { teacherPersonId: "teacher-1" } },
    { body: { scope: "GLOBAL" } },
    { query: { search: "林" } },
  ]) {
    assert.equal((await handleRequest({ ...request, ...changed }, services)).status, 400);
  }
  assert.equal(calls.length, 0);
  assert.equal((await handleRequest(request, setup(global, false).services)).status, 503);
});

test("工资候选目录的实际 HTTP 响应禁止缓存", async () => {
  const { services } = setup();
  const server = createApiServer(services);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}${path}`,
      { headers: { authorization: "Bearer session" } },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual((await response.json()).data, {
      items: [{ id: "teacher-1", nickname: "林老师" }],
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
