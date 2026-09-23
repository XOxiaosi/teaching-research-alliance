import test from "node:test";
import assert from "node:assert/strict";
import { ApiClientError, TeacherApiClient } from "../dist/index.js";

const session = {
  sessionId: "salary-session", accountId: "account-1", personId: "finance-1",
  roleContexts: [{ subject: "HEADQUARTERS_FINANCE", personId: "finance-1", scope: "GLOBAL" }],
  currentRoleContext: { subject: "HEADQUARTERS_FINANCE", personId: "finance-1", scope: "GLOBAL" }
};

test("工资计划与工资确认冻结请求、复用幂等键，并不提交客户端处理时间", async () => {
  const requests = [];
  const client = new TeacherApiClient({
    idempotencyKeyFactory: () => "salary-command-key",
    transport: async request => {
      requests.push(request);
      if (request.path === "/v1/session") return { status: 200, body: { data: session } };
      if (request.path === "/v1/finance/cash-wage-plans") return { status: 200, body: { data: { id: "plan", planVersionId: "plan", subjectPersonId: "teacher-1", month: "2026-09-01", kind: "CASH_WAGE_PLAN" } } };
      return { status: 200, body: { data: { id: "document-1", status: "COMPLETED", version: 2, replay: false } } };
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  const plan = client.createCashWagePlanSubmission({ teacherPersonId: "teacher-1", salaryMonth: "2026-09-01", plannedCashCents: "490000", plannedDeductionCents: "490000", active: true, applyToFutureMonths: true, reason: "九月计划" });
  await client.setCashWagePlan(plan);
  const confirmation = client.createCashWageConfirmationSubmission({ documentId: "document-1", expectedVersion: 1, todoId: "todo-1", cashPaidCents: "490000", deductionCents: "490000", reason: "已发现金", attachmentVersionIds: ["file-1", "file-2"], correctionOfDocumentId: "reversed-wage-document" });
  await client.confirmCashWage(confirmation);
  assert.deepEqual(requests.slice(1).map(request => request.path), ["/v1/finance/cash-wage-plans", "/v1/finance/cash-wages/confirm"]);
  assert.equal(requests[1].body.idempotencyKey, "salary-command-key");
  assert.equal(requests[2].body.paidAt, undefined);
  assert.deepEqual(requests[2].body.attachmentVersionIds, ["file-1", "file-2"]);
  assert.equal(requests[2].body.correctionOfDocumentId, "reversed-wage-document");
  assert.throws(() => client.createCashWagePlanSubmission({ teacherPersonId: "teacher-1", salaryMonth: "2026-09-01", plannedCashCents: "490000", plannedDeductionCents: "490001", active: true, reason: "不允许工资与扣豆不同" }), error => error instanceof ApiClientError && error.code === "CASH_WAGE_AMOUNT_MISMATCH");
});

test("客户端仅在严格全局财务上下文中创建工资奖金社保写命令", async () => {
  const client = new TeacherApiClient({ transport: async () => ({ status: 200, body: { data: { sessionId: "teacher", accountId: "a", personId: "teacher", roleContexts: [], currentRoleContext: { subject: "TEACHING_TEACHER", personId: "teacher", scope: "SELF" } } } }) });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  assert.throws(() => client.createBenefitTodoGenerationSubmission(), error => error instanceof ApiClientError && error.code === "FORBIDDEN_SCOPE");
});
