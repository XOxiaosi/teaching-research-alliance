import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../dist/main.js";

const at = new Date("2026-09-23T04:00:00.000Z");
const hq = {
  subject: "HEADQUARTERS_FINANCE",
  personId: "finance-person",
  scope: "GLOBAL",
};
const admin = {
  subject: "SYSTEM_ADMIN",
  personId: "admin-person",
  scope: "GLOBAL",
};

const servicesFor = (context = hq) => {
  const calls = [];
  return {
    calls,
    services: {
      sessions: { get: () => ({ currentRoleContext: context }) },
      weeklyFees: {},
      cashWageReads: {
        listRoster: (...args) => {
          calls.push(["roster", ...args]);
          return { salaryMonth: args[1], items: [] };
        },
        listConfirmations: (...args) => {
          calls.push(["confirmations", ...args]);
          return { items: [], nextCursor: null };
        },
        getDetail: (...args) => {
          calls.push(["detail", ...args]);
          return { documentId: args[1] };
        },
      },
      bonusProjects: {
        list: (...args) => {
          calls.push(["catalog", ...args]);
          return { projects: [] };
        },
        rename: (...args) => {
          calls.push(["rename", ...args]);
          return { projectNo: args[1], replay: false };
        },
      },
      now: () => at,
    },
  };
};

test("工资三组GET仅传当前角色与白名单查询，目录GET不接受多余参数", async () => {
  const { calls, services } = servicesFor();
  const roster = await handleRequest(
    {
      method: "GET",
      path: "/v1/finance/cash-wage-roster",
      query: { month: "2026-09-01" },
      sessionId: "session",
      body: {},
    },
    services,
  );
  assert.equal(roster.status, 200);
  assert.deepEqual(calls[0], ["roster", hq, "2026-09-01"]);

  const confirmations = await handleRequest(
    {
      method: "GET",
      path: "/v1/finance/cash-wage-confirmations",
      query: {
        month: "2026-09-01",
        teacherPersonId: "teacher",
        cursor: "cursor",
        limit: "25",
      },
      sessionId: "session",
      body: {},
    },
    services,
  );
  assert.equal(confirmations.status, 200);
  assert.deepEqual(calls[1], [
    "confirmations",
    hq,
    {
      month: "2026-09-01",
      teacherPersonId: "teacher",
      cursor: "cursor",
      limit: 25,
    },
  ]);

  const detail = await handleRequest(
    {
      method: "GET",
      path: "/v1/finance/cash-wages/document-id",
      sessionId: "session",
      body: {},
    },
    services,
  );
  assert.equal(detail.status, 200);
  assert.deepEqual(calls[2], ["detail", hq, "document-id"]);

  const catalog = await handleRequest(
    {
      method: "GET",
      path: "/v1/finance/bonus-projects",
      sessionId: "session",
      body: {},
    },
    services,
  );
  assert.equal(catalog.status, 200);
  assert.deepEqual(calls[3], ["catalog", hq]);

  const invalid = await handleRequest(
    {
      method: "GET",
      path: "/v1/finance/bonus-projects",
      query: { personId: "forged" },
      sessionId: "session",
      body: {},
    },
    services,
  );
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, "INVALID_INPUT");
  assert.equal(calls.length, 4);
});

test("项目改名HTTP固定项目号、可信时钟和幂等键，并映射版本冲突", async () => {
  const { calls, services } = servicesFor(admin);
  const renamed = await handleRequest(
    {
      method: "POST",
      path: "/v1/admin/bonus-projects/3/name",
      sessionId: "session",
      body: {
        expectedVersion: 2,
        displayName: "校本课程项目",
        reason: "统一命名",
        idempotencyKey: "rename-three",
      },
    },
    services,
  );
  assert.equal(renamed.status, 200);
  assert.deepEqual(calls[0], [
    "rename",
    admin,
    3,
    { expectedVersion: 2, displayName: "校本课程项目", reason: "统一命名" },
    "rename-three",
    at,
  ]);

  const conflict = await handleRequest(
    {
      method: "POST",
      path: "/v1/admin/bonus-projects/3/name",
      sessionId: "session",
      body: {
        expectedVersion: 2,
        displayName: "冲突",
        reason: "冲突",
        idempotencyKey: "conflict",
      },
    },
    {
      ...services,
      bonusProjects: {
        ...services.bonusProjects,
        rename: () => {
          throw new Error("BONUS_PROJECT_VERSION_CONFLICT");
        },
      },
    },
  );
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "BONUS_PROJECT_VERSION_CONFLICT");
});

test("奖金发放HTTP透传不可变目录版本，不接受客户端伪造操作者", async () => {
  const calls = [];
  const services = {
    sessions: { get: () => ({ currentRoleContext: hq }) },
    weeklyFees: {},
    salaryBenefits: {
      grantBonus: (...args) => {
        calls.push(args);
        return {
          id: args[1].documentId,
          status: "COMPLETED",
          version: 2,
          replay: false,
        };
      },
    },
    now: () => at,
  };
  const body = {
    documentId: "bonus-document",
    expectedVersion: 1,
    projectNo: 1,
    projectName: "课程研发项目",
    projectNameVersionId: "project-version-id",
    recipientPersonId: "teacher",
    sourceFundId: "fund",
    amountCents: "100",
    reason: "奖金",
    attachmentVersionIds: ["support", "screenshot"],
    idempotencyKey: "bonus",
  };
  const response = await handleRequest(
    {
      method: "POST",
      path: "/v1/finance/project-bonuses/grant",
      sessionId: "session",
      body,
    },
    services,
  );
  assert.equal(response.status, 200);
  assert.equal(calls[0][1].projectNameVersionId, "project-version-id");
  assert.equal(calls[0][1].grantedByPersonId, undefined);

  const forged = await handleRequest(
    {
      method: "POST",
      path: "/v1/finance/project-bonuses/grant",
      sessionId: "session",
      body: { ...body, grantedByPersonId: "attacker" },
    },
    services,
  );
  assert.equal(forged.status, 400);
  assert.equal(calls.length, 1);
});
