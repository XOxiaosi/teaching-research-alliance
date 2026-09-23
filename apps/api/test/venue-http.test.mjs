import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../dist/http-handler.js";
import { PostgresVenueReadService } from "../dist/postgres-venue-read-service.js";
import { PostgresPersonalReadService } from "../dist/postgres-personal-read-service.js";

const id = "11111111-1111-4111-8111-111111111111";
const context = { personId: id, subject: "TEACHING_TEACHER", scope: "SELF" };
const services = (capture) => ({
  now: () => new Date("2026-09-21T04:00:00.000Z"),
  sessions: { get: async () => ({ sessionId: "s", accountId: "a", personId: id, roleContexts: [context], currentRoleContext: context }), login: async () => { throw new Error("UNUSED"); } },
  weeklyFees: { acceptReferral: async () => {}, recordWeeklyFee: async () => {} },
  venues: { create: async (...args) => { capture.args = args; return { id, replay: false }; } },
  venueReads: { listOwned: async () => [], list: async () => [], get: async () => ({}) }
});

test("HTTP 场地创建路由只从会话主体取所有者并保留幂等键", async () => {
  const capture = {};
  const response = await handleRequest({ method: "POST", path: "/v1/venues", body: { sessionId: "s", name: "我的场地", makeDefault: true, idempotencyKey: "http-venue-1", ownerPersonId: "22222222-2222-4222-8222-222222222222" } }, services(capture));
  assert.equal(response.status, 200);
  assert.equal(capture.args[0].personId, id);
  assert.deepEqual(capture.args[1], { name: "我的场地", makeDefault: true });
  assert.equal(capture.args[2], "http-venue-1");
});

test("可见看板目录支持三类个人身份，授课目录仍仅授课老师可用", async () => {
  for (const subject of ["TEACHING_TEACHER", "ACADEMIC_PLANNER", "PLANNING_MENTOR", "VENUE_OWNER"]) {
    const role = { ...context, subject };
    const queries = [];
    const pool = { connect: async () => ({ query: async (sql, values) => { queries.push({ sql, values }); return { rows: [] }; }, release: async () => {} }) };
    const api = { ...services({}),
      sessions: { get: async () => ({ sessionId: "s", accountId: "a", personId: id, roleContexts: [role], currentRoleContext: role }) },
      venueReads: new PostgresVenueReadService(pool), personal: new PostgresPersonalReadService(pool)
    };
    const visible = await handleRequest({ method: "GET", path: "/v1/venues/visible", body: { sessionId: "s", personId: "untrusted" } }, api);
    assert.equal(visible.status, subject === "VENUE_OWNER" ? 403 : 200, subject);
    if (subject !== "VENUE_OWNER") {
      assert.deepEqual(visible.body.data, []);
      assert.equal(queries.length, 1);
      assert.equal(queries[0].values[0], id);
      assert.match(queries[0].sql, /venue_permission_grant/);
    } else assert.equal(queries.length, 0);
    const available = await handleRequest({ method: "GET", path: "/v1/venues/available", body: { sessionId: "s" } }, api);
    assert.equal(available.status, subject === "TEACHING_TEACHER" ? 200 : 403, subject);
  }
});
