import test from "node:test";
import assert from "node:assert/strict";
import { ApiClientError, TeacherApiClient } from "../dist/index.js";

const session = {
  sessionId: "salary-session",
  accountId: "account-1",
  personId: "finance-1",
  roleContexts: [
    { subject: "HEADQUARTERS_FINANCE", personId: "finance-1", scope: "GLOBAL" },
  ],
  currentRoleContext: {
    subject: "HEADQUARTERS_FINANCE",
    personId: "finance-1",
    scope: "GLOBAL",
  },
};

test("工资计划与工资确认冻结请求、复用幂等键，并不提交客户端处理时间", async () => {
  const requests = [];
  const client = new TeacherApiClient({
    idempotencyKeyFactory: () => "salary-command-key",
    transport: async (request) => {
      requests.push(request);
      if (request.path === "/v1/session")
        return { status: 200, body: { data: session } };
      if (request.path === "/v1/finance/cash-wage-plans")
        return {
          status: 200,
          body: {
            data: {
              id: "plan",
              planVersionId: "plan",
              subjectPersonId: "teacher-1",
              month: "2026-09-01",
              kind: "CASH_WAGE_PLAN",
            },
          },
        };
      return {
        status: 200,
        body: {
          data: {
            id: "document-1",
            status: "COMPLETED",
            version: 2,
            replay: false,
          },
        },
      };
    },
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const plan = client.createCashWagePlanSubmission({
    teacherPersonId: "teacher-1",
    salaryMonth: "2026-09-01",
    plannedCashCents: "490000",
    plannedDeductionCents: "490000",
    active: true,
    applyToFutureMonths: true,
    reason: "九月计划",
  });
  await client.setCashWagePlan(plan);
  const confirmation = client.createCashWageConfirmationSubmission({
    documentId: "document-1",
    expectedVersion: 1,
    todoId: "todo-1",
    cashPaidCents: "490000",
    deductionCents: "490000",
    reason: "已发现金",
    attachmentVersionIds: ["file-1", "file-2"],
    correctionOfDocumentId: "reversed-wage-document",
  });
  await client.confirmCashWage(confirmation);
  assert.deepEqual(
    requests.slice(1).map((request) => request.path),
    ["/v1/finance/cash-wage-plans", "/v1/finance/cash-wages/confirm"],
  );
  assert.equal(requests[1].body.idempotencyKey, "salary-command-key");
  assert.equal(requests[2].body.paidAt, undefined);
  assert.deepEqual(requests[2].body.attachmentVersionIds, ["file-1", "file-2"]);
  assert.equal(
    requests[2].body.correctionOfDocumentId,
    "reversed-wage-document",
  );
  assert.throws(
    () =>
      client.createCashWagePlanSubmission({
        teacherPersonId: "teacher-1",
        salaryMonth: "2026-09-01",
        plannedCashCents: "490000",
        plannedDeductionCents: "490001",
        active: true,
        reason: "不允许工资与扣豆不同",
      }),
    (error) =>
      error instanceof ApiClientError &&
      error.code === "CASH_WAGE_AMOUNT_MISMATCH",
  );
});

test("客户端仅在严格全局财务上下文中创建工资奖金社保写命令", async () => {
  const client = new TeacherApiClient({
    transport: async () => ({
      status: 200,
      body: {
        data: {
          sessionId: "teacher",
          accountId: "a",
          personId: "teacher",
          roleContexts: [],
          currentRoleContext: {
            subject: "TEACHING_TEACHER",
            personId: "teacher",
            scope: "SELF",
          },
        },
      },
    }),
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  assert.throws(
    () => client.createBenefitTodoGenerationSubmission(),
    (error) =>
      error instanceof ApiClientError && error.code === "FORBIDDEN_SCOPE",
  );
});

test("福利确认要求并精确透传当前计划版本，重复提交复用同一命令", async () => {
  const requests = [];
  const client = new TeacherApiClient({
    idempotencyKeyFactory: () => "benefit-confirm-key",
    transport: async (request) => {
      requests.push(request);
      if (request.path === "/v1/session")
        return { status: 200, body: { data: session } };
      return {
        status: 200,
        body: {
          data: {
            id: "benefit-document",
            status: "COMPLETED",
            version: 2,
            replay: requests.length > 2,
          },
        },
      };
    },
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });

  const draft = {
    documentId: "benefit-document",
    expectedVersion: 1,
    todoId: "benefit-todo",
    expectedPlanVersionId: "plan-version-current",
    reason: "确认本月福利",
    attachmentVersionIds: ["proof-1", "proof-2"],
  };
  const submission = client.createBenefitConfirmationSubmission(draft);
  await client.confirmBenefit(submission);
  await client.confirmBenefit(submission);

  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1].body, {
    documentId: "benefit-document",
    expectedVersion: 1,
    todoId: "benefit-todo",
    expectedPlanVersionId: "plan-version-current",
    reason: "确认本月福利",
    attachmentVersionIds: ["proof-1", "proof-2"],
    idempotencyKey: "benefit-confirm-key",
  });
  assert.deepEqual(requests[2].body, requests[1].body);
});

test("福利确认缺少或清空计划版本时本地拒绝且不触发请求", async () => {
  const requests = [];
  const client = new TeacherApiClient({
    transport: async (request) => {
      requests.push(request);
      if (request.path === "/v1/session")
        return { status: 200, body: { data: session } };
      return { status: 200, body: { data: {} } };
    },
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const base = {
    documentId: "benefit-document",
    expectedVersion: 1,
    todoId: "benefit-todo",
    reason: "确认本月福利",
    attachmentVersionIds: ["proof-1", "proof-2"],
  };
  for (const expectedPlanVersionId of [undefined, "", "   "]) {
    assert.throws(
      () =>
        client.createBenefitConfirmationSubmission({
          ...base,
          ...(expectedPlanVersionId === undefined ? {} : { expectedPlanVersionId }),
        }),
      (error) =>
        error instanceof ApiClientError &&
        error.status === 400 &&
        error.code === "INVALID_INPUT",
    );
  }
  assert.equal(requests.length, 1);
});

test("工资管理读取固定月份、分页和详情路径，并在本地拒绝非法筛选", async () => {
  const requests = [];
  const client = new TeacherApiClient({
    transport: async (request) => {
      requests.push(request);
      if (request.path === "/v1/session")
        return { status: 200, body: { data: session } };
      if (request.path.startsWith("/v1/finance/cash-wage-roster"))
        return {
          status: 200,
          body: { data: { salaryMonth: "2026-09-01", items: [] } },
        };
      if (request.path.startsWith("/v1/finance/cash-wage-confirmations"))
        return { status: 200, body: { data: { items: [], nextCursor: null } } };
      if (request.path === "/v1/finance/bonus-projects")
        return { status: 200, body: { data: { projects: [] } } };
      return {
        status: 200,
        body: { data: { documentId: "document-1", attachments: [] } },
      };
    },
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  await client.listManagedCashWageRoster("2026-09-01");
  await client.listManagedCashWageConfirmations({
    month: "2026-09-01",
    teacherPersonId: "teacher-1",
    cursor: "opaque-cursor",
    limit: 25,
  });
  await client.getManagedCashWageDetail("document-1");
  await client.listBonusProjects();
  assert.deepEqual(
    requests.slice(1).map((request) => request.path),
    [
      "/v1/finance/cash-wage-roster?month=2026-09-01",
      "/v1/finance/cash-wage-confirmations?month=2026-09-01&teacherPersonId=teacher-1&cursor=opaque-cursor&limit=25",
      "/v1/finance/cash-wages/document-1",
      "/v1/finance/bonus-projects",
    ],
  );
  await assert.rejects(
    client.listManagedCashWageRoster("2026-09-02"),
    (error) =>
      error instanceof ApiClientError && error.code === "INVALID_INPUT",
  );
  await assert.rejects(
    client.listManagedCashWageConfirmations({
      month: "2026-09-01",
      limit: 101,
    }),
    (error) =>
      error instanceof ApiClientError && error.code === "INVALID_INPUT",
  );
});

test("管理员项目改名与奖金命令冻结目录版本和幂等请求", async () => {
  const requests = [];
  const adminSession = {
    ...session,
    personId: "admin-1",
    roleContexts: [
      { subject: "SYSTEM_ADMIN", personId: "admin-1", scope: "GLOBAL" },
    ],
    currentRoleContext: {
      subject: "SYSTEM_ADMIN",
      personId: "admin-1",
      scope: "GLOBAL",
    },
  };
  let key = 0;
  const client = new TeacherApiClient({
    idempotencyKeyFactory: () => `admin-command-${++key}`,
    transport: async (request) => {
      requests.push(request);
      if (request.path === "/v1/session")
        return { status: 200, body: { data: adminSession } };
      if (request.path.includes("/bonus-projects/"))
        return {
          status: 200,
          body: { data: { projectNo: 1, nameVersion: 2, replay: false } },
        };
      return {
        status: 200,
        body: {
          data: {
            id: "bonus-document",
            status: "COMPLETED",
            version: 2,
            replay: false,
          },
        },
      };
    },
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const rename = client.createBonusProjectRenameSubmission({
    projectNo: 1,
    expectedVersion: 1,
    displayName: "课程研发项目",
    reason: "统一命名",
  });
  await client.renameBonusProject(rename);
  const bonus = client.createBonusGrantSubmission({
    documentId: "bonus-document",
    expectedVersion: 1,
    projectNo: 1,
    projectName: "课程研发项目",
    projectNameVersionId: "catalog-version-2",
    recipientPersonId: "teacher-1",
    sourceFundId: "fund-1",
    amountCents: "100",
    reason: "奖金",
    attachmentVersionIds: ["support", "screenshot"],
  });
  await client.grantProjectBonus(bonus);
  assert.equal(requests[1].path, "/v1/admin/bonus-projects/1/name");
  assert.equal(requests[1].body.idempotencyKey, "admin-command-1");
  assert.equal(requests[2].body.projectNameVersionId, "catalog-version-2");
  assert.equal(requests[2].body.idempotencyKey, "admin-command-2");
  assert.throws(
    () =>
      client.createBonusGrantSubmission({
        documentId: "bonus-document",
        expectedVersion: 1,
        projectNo: 1,
        projectName: "课程研发项目",
        recipientPersonId: "teacher-1",
        sourceFundId: "fund-1",
        amountCents: "100",
        reason: "缺少目录版本",
        attachmentVersionIds: ["support", "screenshot"],
      }),
    (error) =>
      error instanceof ApiClientError && error.code === "INVALID_INPUT",
  );
});
