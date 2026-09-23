import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createApiServer, handleRequest } from "../dist/main.js";

const at = new Date("2026-09-23T00:00:00.000Z");
const path = "/v1/finance/benefit-source-funds";
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
            benefitSourceFunds: {
              list: (...received) => {
                calls.push(received);
                return {
                  items: [
                    {
                      fundId: "fund-1",
                      code: "HQ_OPERATING",
                      displayName: "总部运营账户",
                    },
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

test("福利扣费业务账户目录只向三类严格 GLOBAL 财务角色公开", async () => {
  for (const subject of [
    "SYSTEM_OWNER",
    "SYSTEM_ADMIN",
    "HEADQUARTERS_FINANCE",
  ]) {
    const context = { ...global, subject };
    const { calls, services } = setup(context);
    const result = await handleRequest(request, services);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data, {
      items: [
        {
          fundId: "fund-1",
          code: "HQ_OPERATING",
          displayName: "总部运营账户",
        },
      ],
    });
    assert.deepEqual(calls, [[context, at]]);
  }
});

test("福利扣费业务账户目录拒绝其他角色与全部窄范围或夹带范围", async () => {
  const otherRoles = [
    "TEACHING_TEACHER",
    "ACADEMIC_PLANNER",
    "REGION_FINANCE",
    "CAMPUS_PRINCIPAL",
    "GROUP_LEADER",
    "TEACHING_MENTOR",
    "PLANNING_MENTOR",
    "VENUE_OWNER",
  ];
  const deniedContexts = [
    ...otherRoles.map((subject) => ({ ...global, subject, scope: "SELF" })),
    { ...global, scope: "SELF" },
    { ...global, scope: "REGION", regionId: "region-1" },
    { ...global, scope: "CAMPUS", campusId: "campus-1" },
    { ...global, scope: "VENUE", venueId: "venue-1" },
    { ...global, regionId: "region-1" },
    { ...global, campusId: "campus-1" },
    { ...global, venueId: "venue-1" },
  ];
  for (const context of deniedContexts) {
    const { calls, services } = setup(context);
    const result = await handleRequest(request, services);
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, "FORBIDDEN_SCOPE");
    assert.equal(calls.length, 0);
  }
});

test("福利扣费业务账户目录拒绝未登录、客户端筛选与缺失服务", async () => {
  const { calls, services } = setup();
  assert.equal(
    (await handleRequest({ ...request, sessionId: undefined }, services)).status,
    401,
  );
  for (const changed of [
    { body: { sourceFundId: "fund-1" } },
    { body: { scope: "GLOBAL" } },
    { query: { search: "总部" } },
    { query: { includeInactive: "true" } },
  ]) {
    const result = await handleRequest({ ...request, ...changed }, services);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, "INVALID_INPUT");
  }
  assert.equal(calls.length, 0);
  const unavailable = await handleRequest(request, setup(global, false).services);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.error.code, "FINANCE_SERVICE_UNAVAILABLE");
});

test("福利扣费业务账户目录的实际 HTTP 响应禁止缓存", async () => {
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
      items: [
        {
          fundId: "fund-1",
          code: "HQ_OPERATING",
          displayName: "总部运营账户",
        },
      ],
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("福利扣费业务账户目录的真实 GET 拒绝请求体中的伪造 sessionId", async () => {
  const { calls, services } = setup();
  const server = createApiServer(services);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const payload = JSON.stringify({ sessionId: "body-value" });
    const response = await new Promise((resolve, reject) => {
      const outgoing = httpRequest(
        {
          host: "127.0.0.1",
          port: server.address().port,
          path,
          method: "GET",
          headers: {
            authorization: "Bearer session",
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
          },
        },
        (incoming) => {
          const chunks = [];
          incoming.on("data", (chunk) => chunks.push(chunk));
          incoming.on("end", () =>
            resolve({
              status: incoming.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            }),
          );
        },
      );
      outgoing.on("error", reject);
      outgoing.end(payload);
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_INPUT");
    assert.equal(calls.length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
