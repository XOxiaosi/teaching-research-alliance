import assert from "node:assert/strict";
import test from "node:test";
import { TeacherApiClient } from "../dist/index.js";

const ok = (data) => ({ status: 200, body: { data } });
const session = (subject = "SYSTEM_ADMIN", scope = "GLOBAL") => {
  const context = { personId: "admin-1", subject, scope };
  return { sessionId: "session-1", accountId: "account-1", personId: "admin-1", roleContexts: [context], currentRoleContext: context };
};
const page = { snapshotAt: "2026-09-24T00:00:00.000Z", dataVersion: "v1", items: [], nextCursor: null };

test("关系审计客户端发送受控筛选并保留服务端快照", async () => {
  const requests = [];
  const client = new TeacherApiClient({ transport: async (request) => {
    if (request.path === "/v1/session") return ok(session());
    requests.push(request); return ok(page);
  }});
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  assert.deepEqual(await client.listPersonRelationshipAudit({
    personId: "person/1", relationshipType: "TEACHING_MENTOR", status: "ANOMALOUS",
    anomalyCode: "RELATED_ROLE_INVALID", repairability: "REQUIRES_RELATIONSHIP_CORRECTION",
    limit: 25, cursor: "cursor value",
  }), page);
  assert.deepEqual(requests, [{
    method: "GET",
    path: "/v1/admin/person-relationships/audit?personId=person%2F1&relationshipType=TEACHING_MENTOR&status=ANOMALOUS&anomalyCode=RELATED_ROLE_INVALID&repairability=REQUIRES_RELATIONSHIP_CORRECTION&limit=25&cursor=cursor+value",
    headers: { authorization: "Bearer session-1" },
  }]);
});

test("关系审计客户端在发送前拒绝越权和非法分页", async () => {
  for (const [subject, scope] of [["TEACHER", "SELF"], ["PLANNING_MENTOR", "SELF"], ["SYSTEM_ADMIN", "SELF"]]) {
    let calls = 0;
    const client = new TeacherApiClient({ transport: async (request) => {
      calls += 1; return request.path === "/v1/session" ? ok(session(subject, scope)) : ok(page);
    }});
    await client.login({ phoneNormalized: "13800000000", password: "password" });
    await assert.rejects(client.listPersonRelationshipAudit(), (error) => error.code === "FORBIDDEN_SCOPE");
    assert.equal(calls, 1);
  }
  const client = new TeacherApiClient({ transport: async () => ok(session()) });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  await assert.rejects(client.listPersonRelationshipAudit({ limit: 0 }), /INVALID_INPUT/);
});
