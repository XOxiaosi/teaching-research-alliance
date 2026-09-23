import test from "node:test";
import assert from "node:assert/strict";
import {
  ApiClientError,
  TeacherApiClient,
} from "../dist/index.js";
import { ENDPOINT_CONTRACTS } from "@teaching-research-alliance/contracts";

const sessionFor = (context) => ({
  sessionId: "salary-session",
  accountId: "account-1",
  personId: "finance-1",
  roleContexts: [context],
  currentRoleContext: context,
});

const global = {
  personId: "finance-1",
  subject: "HEADQUARTERS_FINANCE",
  scope: "GLOBAL",
};

test("工资候选目录使用工资管理契约且只请求固定路径", async () => {
  const requests = [];
  const client = new TeacherApiClient({
    transport: async (request) => {
      requests.push(request);
      if (request.path === "/v1/session")
        return { status: 200, body: { data: sessionFor(global) } };
      return {
        status: 200,
        body: { data: { items: [{ id: "teacher-1", nickname: "林老师" }] } },
      };
    },
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  assert.deepEqual(await client.listManagedCashWageTeachers(), {
    items: [{ id: "teacher-1", nickname: "林老师" }],
  });
  assert.deepEqual(requests[1], {
    method: "GET",
    path: "/v1/finance/cash-wage-teachers",
    headers: { authorization: "Bearer salary-session" },
  });
  assert.deepEqual(
    ENDPOINT_CONTRACTS.find((item) => item.path === "/v1/finance/cash-wage-teachers"),
    {
      method: "GET",
      path: "/v1/finance/cash-wage-teachers",
      action: "MANAGE_CASH_WAGES",
      responseVersion: "cash-wage-teachers.v1",
      requiresRoleContext: true,
    },
  );
});

test("工资候选目录客户端只接受三个严格全局工资管理上下文", async () => {
  for (const subject of [
    "SYSTEM_OWNER",
    "SYSTEM_ADMIN",
    "HEADQUARTERS_FINANCE",
  ]) {
    const client = new TeacherApiClient({
      transport: async (request) =>
        request.path === "/v1/session"
          ? { status: 200, body: { data: sessionFor({ ...global, subject }) } }
          : { status: 200, body: { data: { items: [] } } },
    });
    await client.login({ phoneNormalized: "13800000000", password: "password" });
    assert.deepEqual(await client.listManagedCashWageTeachers(), { items: [] });
  }

  for (const context of [
    { ...global, subject: "TEACHING_TEACHER", scope: "SELF" },
    { ...global, regionId: "region-1" },
    { ...global, campusId: "campus-1" },
    { ...global, venueId: "venue-1" },
  ]) {
    let requests = 0;
    const client = new TeacherApiClient({
      transport: async () => {
        requests += 1;
        return { status: 200, body: { data: sessionFor(context) } };
      },
    });
    await client.login({ phoneNormalized: "13800000000", password: "password" });
    await assert.rejects(
      client.listManagedCashWageTeachers(),
      (error) => error instanceof ApiClientError && error.code === "FORBIDDEN_SCOPE",
    );
    assert.equal(requests, 1);
  }
});

test("工资候选目录服务端撤权清角色，失效会话清会话", async () => {
  for (const [status, check] of [
    [403, (client) => assert.equal(client.hasRoleContext, false)],
    [401, (client) => assert.equal(client.currentSession, null)],
  ]) {
    const client = new TeacherApiClient({
      transport: async (request) =>
        request.path === "/v1/session"
          ? { status: 200, body: { data: sessionFor(global) } }
          : {
              status,
              body: {
                error: {
                  code: status === 403 ? "FORBIDDEN_SCOPE" : "UNAUTHENTICATED",
                  message: "denied",
                },
              },
            },
    });
    await client.login({ phoneNormalized: "13800000000", password: "password" });
    await assert.rejects(
      client.listManagedCashWageTeachers(),
      (error) =>
        error.code === (status === 403 ? "FORBIDDEN_SCOPE" : "UNAUTHENTICATED"),
    );
    check(client);
  }
});
