import assert from "node:assert/strict";
import test from "node:test";
import {
  ApiClientError,
  RoleSelectionRequiredError,
  StaleResponseError,
  TeacherApiClient,
} from "../dist/index.js";

const success = (data) => ({ status: 200, body: { version: "test", data } });

const sessionFor = (subject = "SYSTEM_ADMIN", extra = {}, suffix = "1") => {
  const context = {
    subject,
    personId: "admin-person-1",
    scope: "GLOBAL",
    ...extra,
  };
  return {
    sessionId: `relationship-session-${suffix}`,
    accountId: "admin-account-1",
    personId: "admin-person-1",
    roleContexts: [context],
    currentRoleContext: context,
  };
};

const draft = {
  teacherPersonId: "teacher-1",
  newRelatedPersonId: "leader-2",
  effectiveTeachingWeekId: "week-1",
  reason: "常规周调整组长",
};

const preview = {
  previewId: "preview-1",
  teacherPersonId: "teacher-1",
  sourceRelatedPersonId: "leader-1",
  sourceRelatedNickname: "原组长",
  newRelatedPersonId: "leader-2",
  effectiveTeachingWeekId: "week-1",
  effectiveAt: "2026-09-21T16:00:00.000Z",
  nextBoundaryAt: null,
  consideredFeeCount: 3,
  movedFeeCount: 2,
  zeroShareFeeCount: 1,
  excludedRefundCount: 0,
  movedAmountCents: "900",
};

const candidates = {
  groupLeaders: [{ personId: "leader-2", nickname: "新组长" }],
  teachers: [{ personId: "teacher-1", nickname: "张老师" }],
  currentWeeks: [
    {
      id: "week-1",
      startsOn: "2026-09-22",
      endsOn: "2026-09-28",
      settlementMonth: "2026-09-01",
    },
  ],
};

const published = {
  changeId: "change-1",
  previewId: "preview-1",
  relationshipVersion: 4,
  resultRelationshipId: "relationship-2",
  postingStatus: "POSTED",
  consideredFeeCount: 3,
  movedFeeCount: 2,
  excludedRefundCount: 0,
  movedAmountCents: "900",
  replay: true,
};

test("组长关系客户端逐次读取候选和预览，只发送冻结字段", async () => {
  const requests = [];
  const client = new TeacherApiClient({
    transport: async (request) => {
      if (request.path === "/v1/session") return success(sessionFor());
      requests.push(request);
      if (request.path === "/v1/admin/person-relationships/group-leader-candidates")
        return success(candidates);
      if (request.path === "/v1/admin/person-relationships/preview")
        return success(preview);
      throw new Error(`unexpected ${request.method} ${request.path}`);
    },
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });

  assert.deepEqual(await client.listGroupLeaderRelationshipCandidates(), candidates);
  assert.deepEqual(await client.listGroupLeaderRelationshipCandidates(), candidates);
  assert.deepEqual(
    await client.previewGroupLeaderRelationshipChange({
      ...draft,
      actorPersonId: "forged",
      at: "forged",
    }),
    preview,
  );
  assert.deepEqual(
    requests.map(({ method, path, body }) => ({ method, path, body })),
    [
      {
        method: "GET",
        path: "/v1/admin/person-relationships/group-leader-candidates",
        body: undefined,
      },
      {
        method: "GET",
        path: "/v1/admin/person-relationships/group-leader-candidates",
        body: undefined,
      },
      {
        method: "POST",
        path: "/v1/admin/person-relationships/preview",
        body: draft,
      },
    ],
  );
  await assert.rejects(
    client.previewGroupLeaderRelationshipChange({ ...draft, reason: "   " }),
    (error) => error instanceof ApiClientError && error.code === "INVALID_INPUT",
  );
  assert.equal(requests.length, 3);
});

test("组长关系发布冻结 preview 与稳定幂等键，未知结果只可复用原提交重试", async () => {
  const requests = [];
  let publishAttempts = 0;
  const client = new TeacherApiClient({
    idempotencyKeyFactory: () => "relationship-change-key-1",
    transport: async (request) => {
      if (request.path === "/v1/session") return success(sessionFor());
      requests.push(request);
      if (request.path === "/v1/admin/person-relationships") {
        publishAttempts += 1;
        if (publishAttempts === 1) throw new Error("network uncertain");
        return success(published);
      }
      throw new Error(`unexpected ${request.method} ${request.path}`);
    },
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const submission = client.createGroupLeaderRelationshipChangeSubmission("preview-1");
  assert.equal(Object.isFrozen(submission), true);
  assert.equal(Object.isFrozen(submission.draft), true);
  assert.throws(() => {
    submission.draft.previewId = "mutated";
  }, TypeError);

  await assert.rejects(
    client.publishGroupLeaderRelationshipChange(submission),
    /network uncertain/,
  );
  assert.equal(client.submissionStatus(submission), "FAILED");
  assert.deepEqual(
    await client.publishGroupLeaderRelationshipChange(submission),
    published,
  );
  assert.equal(client.submissionStatus(submission), "SUCCEEDED");
  assert.deepEqual(
    requests.map(({ path, body }) => ({ path, body })),
    [
      {
        path: "/v1/admin/person-relationships",
        body: { previewId: "preview-1", idempotencyKey: "relationship-change-key-1" },
      },
      {
        path: "/v1/admin/person-relationships",
        body: { previewId: "preview-1", idempotencyKey: "relationship-change-key-1" },
      },
    ],
  );
});

test("组长关系客户端只允许 SYSTEM_OWNER 或 SYSTEM_ADMIN 的严格 GLOBAL 上下文", async () => {
  for (const subject of ["SYSTEM_OWNER", "SYSTEM_ADMIN"]) {
    const client = new TeacherApiClient({
      transport: async (request) =>
        request.path === "/v1/session"
          ? success(sessionFor(subject))
          : success(candidates),
    });
    await client.login({ phoneNormalized: "13800000000", password: "password" });
    assert.deepEqual(await client.listGroupLeaderRelationshipCandidates(), candidates);
  }

  for (const context of [
    sessionFor("HEADQUARTERS_FINANCE"),
    sessionFor("SYSTEM_OWNER", { regionId: "region-1" }),
    sessionFor("SYSTEM_ADMIN", { campusId: "campus-1" }),
    sessionFor("SYSTEM_ADMIN", { venueId: "venue-1" }),
  ]) {
    let requests = 0;
    const client = new TeacherApiClient({
      transport: async () => {
        requests += 1;
        return success(context);
      },
    });
    await client.login({ phoneNormalized: "13800000000", password: "password" });
    assert.throws(
      () => client.createGroupLeaderRelationshipChangeSubmission("preview-1"),
      (error) => error instanceof ApiClientError && error.code === "FORBIDDEN_SCOPE",
    );
    await assert.rejects(
      client.listGroupLeaderRelationshipCandidates(),
      (error) => error instanceof ApiClientError && error.code === "FORBIDDEN_SCOPE",
    );
    assert.equal(requests, 1);
  }
});

test("组长关系发布拒绝旧会话；401 清会话，403 清角色且不自动重发", async () => {
  let sessions = 0;
  let posts = 0;
  const stale = new TeacherApiClient({
    idempotencyKeyFactory: () => "stale-key",
    transport: async (request) => {
      if (request.path === "/v1/session") {
        sessions += 1;
        return success(sessionFor("SYSTEM_ADMIN", {}, String(sessions)));
      }
      posts += 1;
      throw new Error("stale submission must not leave client");
    },
  });
  await stale.login({ phoneNormalized: "13800000000", password: "password" });
  const staleSubmission = stale.createGroupLeaderRelationshipChangeSubmission("preview-1");
  await stale.login({ phoneNormalized: "13800000000", password: "password" });
  await assert.rejects(
    stale.publishGroupLeaderRelationshipChange(staleSubmission),
    StaleResponseError,
  );
  assert.equal(posts, 0);

  for (const [status, check] of [
    [401, (client) => assert.equal(client.currentSession, null)],
    [403, (client) => assert.equal(client.hasRoleContext, false)],
  ]) {
    const client = new TeacherApiClient({
      transport: async (request) =>
        request.path === "/v1/session"
          ? success(sessionFor())
          : {
              status,
              body: {
                error: {
                  code: status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN_SCOPE",
                  message: "denied",
                },
              },
            },
    });
    await client.login({ phoneNormalized: "13800000000", password: "password" });
    await assert.rejects(
      client.previewGroupLeaderRelationshipChange(draft),
      (error) =>
        status === 403
          ? error instanceof RoleSelectionRequiredError && error.code === "FORBIDDEN_SCOPE"
          : error instanceof ApiClientError && error.code === "UNAUTHENTICATED",
    );
    check(client);
  }
});
