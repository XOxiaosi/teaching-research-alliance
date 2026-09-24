import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { createApiServer, handleRequest } from "../dist/main.js";

const at = new Date("2026-09-23T00:00:00.000Z");
const mentor = {
  personId: "00000000-0000-4000-8000-000000000001",
  subject: "PLANNING_MENTOR",
  scope: "SELF",
};
const plannerId = "00000000-0000-4000-8000-000000000002";
const weekId = "00000000-0000-4000-8000-000000000003";
const preview = {
  previewId: "00000000-0000-4000-8000-000000000004",
  action: "ADD",
  mentorPersonId: mentor.personId,
  plannerPersonId: plannerId,
  plannerNickname: "规划师甲",
  effectiveTeachingWeekId: weekId,
  effectiveAt: "2026-09-20T16:00:00.000Z",
  nextBoundaryAt: null,
  consideredFeeCount: 2,
  changedFeeCount: 1,
  zeroShareFeeCount: 1,
  excludedRefundCount: 0,
  plannerDeltaCents: "-120",
  mentorDeltaCents: "120",
};
const published = {
  changeId: "00000000-0000-4000-8000-000000000005",
  previewId: preview.previewId,
  action: "ADD",
  relationshipVersion: 1,
  resultRelationshipId: "00000000-0000-4000-8000-000000000006",
  postingStatus: "POSTED",
  consideredFeeCount: 2,
  changedFeeCount: 1,
  excludedRefundCount: 0,
  plannerDeltaCents: "-120",
  mentorDeltaCents: "120",
  replay: false,
};

const request = (method, path, body = {}) => ({
  method,
  path,
  sessionId: "session",
  body,
  query: {},
});

const setup = (context = mentor, enabled = true) => {
  const calls = [];
  return {
    calls,
    services: {
      now: () => at,
      sessions: { get: () => ({ currentRoleContext: context }) },
      weeklyFees: {},
      ...(enabled
        ? {
            planningMentorRelationships: {
              listDirectory: (received, receivedAt) => {
                calls.push(["directory", received, receivedAt]);
                return {
                  mentorPersonId: mentor.personId,
                  mentorNickname: "规划导师",
                  managedPlanners: [{
                    personId: plannerId,
                    nickname: "规划师甲",
                    relationshipId: published.resultRelationshipId,
                    validFrom: preview.effectiveAt,
                    validTo: null,
                    privateField: "must-not-leak",
                  }],
                  availablePlanners: [{ personId: "00000000-0000-4000-8000-000000000007", nickname: "规划师乙", privateField: "must-not-leak" }],
                  currentWeeks: [{ id: weekId, startsOn: "2026-09-21", endsOn: "2026-09-27", settlementMonth: "2026-09-01", ignored: true }],
                  privateField: "must-not-leak",
                };
              },
              preview: (received, draft, receivedAt) => {
                calls.push(["preview", received, draft, receivedAt]);
                return { ...preview, baseHash: "private" };
              },
              publish: (received, previewId, key, receivedAt) => {
                calls.push(["publish", received, previewId, key, receivedAt]);
                return { ...published, idempotencyFingerprint: "private" };
              },
            },
          }
        : {}),
    },
  };
};

test("规划导师关系目录、预览和发布只接受本人关联规划师职责，并投影公开字段", async () => {
  const { calls, services } = setup();
  const directory = await handleRequest(
    request("GET", "/v1/planning-mentor/relationships"),
    services,
  );
  assert.equal(directory.status, 200);
  assert.deepEqual(directory.body.data, {
    mentorPersonId: mentor.personId,
    mentorNickname: "规划导师",
    managedPlanners: [{
      personId: plannerId,
      nickname: "规划师甲",
      relationshipId: published.resultRelationshipId,
      validFrom: preview.effectiveAt,
      validTo: null,
    }],
    availablePlanners: [{ personId: "00000000-0000-4000-8000-000000000007", nickname: "规划师乙" }],
    currentWeeks: [{ id: weekId, startsOn: "2026-09-21", endsOn: "2026-09-27", settlementMonth: "2026-09-01" }],
  });
  const pre = await handleRequest(request(
    "POST",
    "/v1/planning-mentor/relationships/preview",
    { action: "ADD", plannerPersonId: plannerId, effectiveTeachingWeekId: weekId, reason: "本周接管" },
  ), services);
  assert.equal(pre.status, 200);
  assert.deepEqual(pre.body.data, preview);
  assert.deepEqual(calls[1], ["preview", mentor, {
    action: "ADD", plannerPersonId: plannerId, effectiveTeachingWeekId: weekId, reason: "本周接管",
  }, at]);
  const publish = await handleRequest(request(
    "POST",
    "/v1/planning-mentor/relationships",
    { previewId: preview.previewId, idempotencyKey: "stable-key" },
  ), services);
  assert.equal(publish.status, 200);
  assert.deepEqual(publish.body.data, published);
  assert.deepEqual(calls[2], ["publish", mentor, preview.previewId, "stable-key", at]);
});

test("规划导师关系 HTTP 拒绝错误职责范围、严格 body/query、无服务和稳定业务错误", async () => {
  for (const context of [
    { ...mentor, scope: "ASSOCIATED_TEACHERS" },
    { ...mentor, scope: "MENTEES" },
    { ...mentor, regionId: "region" },
    { ...mentor, campusId: "campus" },
    { ...mentor, venueId: "venue" },
    { ...mentor, subject: "ACADEMIC_PLANNER", scope: "SELF" },
  ]) {
    const result = await handleRequest(
      request("GET", "/v1/planning-mentor/relationships"),
      setup(context).services,
    );
    assert.equal(result.status, 403);
  }
  const { services } = setup();
  for (const [path, body] of [
    ["/v1/planning-mentor/relationships/preview", { action: "REPLACE", plannerPersonId: plannerId, effectiveTeachingWeekId: weekId, reason: "x" }],
    ["/v1/planning-mentor/relationships/preview", { action: "ADD", plannerPersonId: plannerId, effectiveTeachingWeekId: weekId, reason: "x", mentorPersonId: mentor.personId }],
    ["/v1/planning-mentor/relationships", { previewId: preview.previewId, idempotencyKey: "key", actorPersonId: mentor.personId }],
    ["/v1/planning-mentor/relationships/preview", { action: "ADD", plannerPersonId: plannerId, effectiveTeachingWeekId: weekId, reason: "x", sessionId: "forged" }],
    ["/v1/planning-mentor/relationships", { previewId: preview.previewId, idempotencyKey: "key", sessionId: "forged" }],
  ]) {
    const result = await handleRequest(request("POST", path, body), services);
    assert.equal(result.status, 400);
  }
  const queried = await handleRequest({
    ...request("GET", "/v1/planning-mentor/relationships"),
    query: { forged: "true" },
  }, services);
  assert.equal(queried.status, 400);
  assert.equal((await handleRequest({
    ...request("GET", "/v1/planning-mentor/relationships"),
    sessionId: undefined,
  }, services)).status, 401);
  assert.equal((await handleRequest(
    request("GET", "/v1/planning-mentor/relationships"),
    setup(mentor, false).services,
  )).status, 503);

  const stale = setup();
  stale.services.planningMentorRelationships.publish = () => { throw new Error("RELATIONSHIP_PREVIEW_STALE"); };
  assert.equal((await handleRequest(request(
    "POST", "/v1/planning-mentor/relationships", { previewId: preview.previewId, idempotencyKey: "key" },
  ), stale.services)).status, 409);
  const conflict = setup();
  conflict.services.planningMentorRelationships.preview = () => { throw new Error("PLANNING_MENTOR_RELATIONSHIP_CONFLICT"); };
  assert.equal((await handleRequest(request(
    "POST", "/v1/planning-mentor/relationships/preview", { action: "ADD", plannerPersonId: plannerId, effectiveTeachingWeekId: weekId, reason: "x" },
  ), conflict.services)).status, 409);
  const replay = setup();
  replay.services.planningMentorRelationships.publish = () => { throw new Error("IDEMPOTENCY_REPLAY"); };
  assert.equal((await handleRequest(request(
    "POST", "/v1/planning-mentor/relationships", { previewId: preview.previewId, idempotencyKey: "key" },
  ), replay.services)).status, 409);
});

test("规划导师关系发布如服务确认同一预览和幂等键重放，HTTP 保留 replay 标识", async () => {
  const { services } = setup();
  services.planningMentorRelationships.publish = () => ({ ...published, replay: true });
  const response = await handleRequest(request(
    "POST",
    "/v1/planning-mentor/relationships",
    { previewId: preview.previewId, idempotencyKey: "stable-key" },
  ), services);
  assert.equal(response.status, 200);
  assert.equal(response.body.data.replay, true);
});

const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}`;
};

const rawJson = (baseUrl, path, { method = "GET", headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest(url, {
      method,
      headers: payload === undefined
        ? headers
        : { ...headers, "content-length": Buffer.byteLength(payload) },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: text ? JSON.parse(text) : null,
        });
      });
    });
    request.on("error", reject);
    request.end(payload);
  });

test("规划导师三端点仅从 Bearer 注入会话，拒绝 JSON 中伪造 token 并禁缓存", async () => {
  const { services } = setup();
  const server = createApiServer({
    ...services,
    sessions: {
      get: (sessionId) => {
        if (sessionId !== "bearer-session") throw new Error("UNAUTHENTICATED");
        return { currentRoleContext: mentor };
      },
    },
  });
  const baseUrl = await listen(server);
  const authorization = { authorization: "Bearer bearer-session", "content-type": "application/json" };
  const operations = [
    { method: "GET", path: "/v1/planning-mentor/relationships", body: undefined },
    { method: "POST", path: "/v1/planning-mentor/relationships/preview", body: { action: "ADD", plannerPersonId: plannerId, effectiveTeachingWeekId: weekId, reason: "本周接管" } },
    { method: "POST", path: "/v1/planning-mentor/relationships", body: { previewId: preview.previewId, idempotencyKey: "http-key" } },
  ];
  try {
    for (const operation of operations) {
      const successful = await rawJson(baseUrl, operation.path, {
        method: operation.method,
        headers: authorization,
        body: operation.body,
      });
      assert.equal(successful.status, 200);
      assert.equal(successful.headers["cache-control"], "private, no-store");
      assert.equal(successful.headers["x-content-type-options"], "nosniff");

      const unauthenticated = await rawJson(baseUrl, operation.path, {
        method: operation.method,
        headers: { "content-type": "application/json" },
        body: operation.body,
      });
      assert.equal(unauthenticated.status, 401);

      const forgedBodyToken = await rawJson(baseUrl, operation.path, {
        method: operation.method,
        headers: authorization,
        body: { ...(operation.body ?? {}), sessionId: "body-token" },
      });
      assert.equal(forgedBodyToken.status, 400);
      assert.equal(forgedBodyToken.body.error.code, "INVALID_INPUT");
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
