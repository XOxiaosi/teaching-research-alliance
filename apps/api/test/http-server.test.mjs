import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer, SessionService, WeeklyFeeService } from "../dist/main.js";

const now = new Date("2026-09-20T10:00:00.000Z");

const createServices = () => {
  const sessions = new SessionService({
    accounts: [{
      accountId: "account-server",
      personId: "teacher-server",
      phoneNormalized: "13800000001",
      credentialDigest: "digest-server",
      status: "ACTIVE"
    }],
    assignments: [{
      personId: "teacher-server",
      subject: "TEACHING_TEACHER",
      scope: "SELF",
      validFrom: new Date("2026-01-01")
    }],
    sessionIdFactory: () => "session-server"
  });
  return {
    sessions,
    referralAcceptance: { accept: async (context, referralId, draft, key) => {
      assert.equal(context.personId, "teacher-server");
      assert.deepEqual(draft, {expectedVersion: 1, venueId: "venue-server"});
      assert.equal(key, "accept-server");
      return {referralId, version: 2, venueId: draft.venueId, replay: false};
    } },
    weeklyFees: new WeeklyFeeService({
      referrals: [{ id: "ref-server", receiverPersonId: "teacher-server", status: "PENDING" }],
      teachingWeeks: [{ id: "week-server", settlementMonth: "2026-09-01", status: "OPEN" }],
      venues: [{ id: "venue-server", status: "ACTIVE" }]
    }),
    now: () => now,
    personal: {
      getOwnOverview: async context => ({ personId: context.personId, balanceCents: -100n }),
      listAvailableVenues: async () => [{ id: "venue-server", name: "合成场地", isOwn: true }]
    }
  };
};

const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}`;
};

test("真实HTTP监听器提供健康检查并序列化周费用金额", async () => {
  const server = createApiServer(createServices());
  const baseUrl = await listen(server);
  try {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { service: "teaching-research-alliance-api", status: "ok" });

    const login = await fetch(`${baseUrl}/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phoneNormalized: "13800000001", credentialDigest: "digest-server" })
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json();
    assert.equal(loginBody.data.sessionId, "session-server");

    const switchRole = await fetch(`${baseUrl}/v1/role-contexts/switch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "session-server", subject: "TEACHING_TEACHER" })
    });
    assert.equal(switchRole.status, 200);
    const own = await fetch(`${baseUrl}/v1/me?personId=another-teacher`, { headers: { authorization: "Bearer session-server" } });
    assert.equal(own.status, 200);
    assert.deepEqual((await own.json()).data, { personId: "teacher-server", balanceCents: "-100" });
    const venues = await fetch(`${baseUrl}/v1/venues/available`, { headers: { authorization: "Bearer session-server" } });
    assert.equal(venues.status, 200);
    assert.equal((await venues.json()).data[0].id, "venue-server");
    assert.equal((await fetch(`${baseUrl}/v1/me`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/v1/me`, { headers: { authorization: "Basic forged" } })).status, 401);

    const accepted = await fetch(`${baseUrl}/v1/referrals/ref-server/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "session-server", expectedVersion: 1, venueId: "venue-server", idempotencyKey: "accept-server" })
    });
    assert.equal(accepted.status, 200);

    const fee = await fetch(`${baseUrl}/v1/referrals/ref-server/weekly-fees`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-server",
        teachingWeekId: "week-server",
        venueId: "venue-server",
        settlementMonth: "2026-09-01",
        grossAmountCents: "100000",
        expectedVersion: 0,
        idempotencyKey: "server-request-1"
      })
    });
    assert.equal(fee.status, 200);
    const feeBody = await fee.json();
    assert.equal(feeBody.data.grossAmountCents, "100000");

    const unsupported = await fetch(`${baseUrl}/v1/session`, { method: "PUT" });
    assert.equal(unsupported.status, 405);
    assert.equal((await unsupported.json()).error.code, "METHOD_NOT_ALLOWED");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
