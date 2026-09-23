import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../dist/main.js";

const at = new Date("2026-09-01T00:00:00.000Z");
const hq = { subject: "HEADQUARTERS_FINANCE", personId: "finance-person", scope: "GLOBAL" };
const servicesFor = (context = hq) => {
  const calls = [];
  const salaryBenefits = {
    createEvidenceDocument: (...args) => { calls.push(["document", ...args]); return { id: "document-1", kind: args[1], version: 1, replay: false }; },
    setCashWagePlan: (...args) => { calls.push(["wage-plan", ...args]); return { id: "plan-1", planVersionId: "plan-1", subjectPersonId: args[1].teacherPersonId, month: args[1].salaryMonth, kind: "CASH_WAGE_PLAN" }; },
    generateCashWageTodos: (...args) => { calls.push(["wage-todos", ...args]); return []; },
    confirmCashWage: (...args) => { calls.push(["wage-confirm", ...args]); return { id: args[1].documentId, status: "COMPLETED", version: 2, replay: false }; },
    grantBonus: (...args) => { calls.push(["bonus", ...args]); return { id: args[1].documentId, status: "COMPLETED", version: 2, replay: false }; },
    setBenefitPlan: (...args) => { calls.push(["benefit-plan", ...args]); return { id: "benefit-plan-1", planVersionId: "benefit-plan-1", subjectPersonId: args[1].beneficiaryPersonId, month: args[1].benefitMonth, kind: args[1].benefitKind }; },
    generateBenefitTodos: (...args) => { calls.push(["benefit-todos", ...args]); return []; },
    confirmBenefit: (...args) => { calls.push(["benefit-confirm", ...args]); return { id: args[1].documentId, status: "COMPLETED", version: 2, replay: false }; },
    reversePosting: (...args) => { calls.push(["reverse", ...args]); return { id: args[1].reversalDocumentId, status: "COMPLETED", version: 2, replay: false }; }
  };
  return { calls, services: { sessions: { get: () => ({ currentRoleContext: context }) }, weeklyFees: {}, salaryBenefits, now: () => at } };
};

test("工资奖金社保写接口仅使用当前全局角色、白名单和可信时钟", async () => {
  const { calls, services } = servicesFor();
  const plan = await handleRequest({ method: "POST", path: "/v1/finance/cash-wage-plans", sessionId: "session", body: {
    teacherPersonId: "teacher-1", salaryMonth: "2026-09-01", plannedCashCents: "490000", plannedDeductionCents: "490000",
    active: true, applyToFutureMonths: true, reason: "九月计划", idempotencyKey: "wage-plan-1"
  } }, services);
  assert.equal(plan.status, 200);
  assert.deepEqual(calls[0], ["wage-plan", hq, {
    teacherPersonId: "teacher-1", salaryMonth: "2026-09-01", plannedCashCents: "490000", plannedDeductionCents: "490000",
    active: true, applyToFutureMonths: true, reason: "九月计划"
  }, "wage-plan-1", at]);

  const confirmation = await handleRequest({ method: "POST", path: "/v1/finance/cash-wages/confirm", sessionId: "session", body: {
    documentId: "wage-document", expectedVersion: 1, todoId: "wage-todo", cashPaidCents: "490000", deductionCents: "490000",
    reason: "已发现金", attachmentVersionIds: ["attachment-a", "attachment-b"], correctionOfDocumentId: "reversed-wage-document", idempotencyKey: "wage-confirm-1"
  } }, services);
  assert.equal(confirmation.status, 200);
  assert.equal(calls[1][2].paidAt, at.toISOString(), "客户端不控制工资确认的处理时间");
  assert.equal(calls[1][2].correctionOfDocumentId, "reversed-wage-document");
  assert.deepEqual(calls[1].slice(0, 2), ["wage-confirm", hq]);

  const forged = await handleRequest({ method: "POST", path: "/v1/finance/project-bonuses/grant", sessionId: "session", body: {
    documentId: "bonus-document", expectedVersion: 1, projectNo: 1, projectName: "项目", recipientPersonId: "teacher-1", sourceFundId: "fund-1",
    amountCents: "100", reason: "奖金", attachmentVersionIds: ["attachment-a", "attachment-b"], idempotencyKey: "bonus-1", grantedByPersonId: "attacker"
  } }, services);
  assert.equal(forged.status, 400);
  assert.equal(forged.body.error.code, "INVALID_INPUT");
  assert.equal(calls.length, 2);
});

test("工资奖金社保写接口拒绝非严格全局财务上下文，并稳定映射服务错误", async () => {
  const { calls, services } = servicesFor({ subject: "REGION_FINANCE", personId: "regional-finance", scope: "REGION", regionId: "region-1" });
  const denied = await handleRequest({ method: "POST", path: "/v1/finance/benefit-todos/generate", sessionId: "session", body: { idempotencyKey: "benefit-todos-1" } }, services);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "FORBIDDEN_SCOPE");
  assert.equal(calls.length, 0, "HTTP 边界拒绝后不调用写服务");

  const unavailable = await handleRequest({ method: "POST", path: "/v1/finance/salary-benefits/documents", sessionId: "session", body: { kind: "CASH_WAGE", idempotencyKey: "document-1" } }, {
    sessions: { get: () => ({ currentRoleContext: hq }) }, weeklyFees: {}, now: () => at
  });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.error.code, "FINANCE_SERVICE_UNAVAILABLE");
});

test("福利确认要求并精确透传 expectedPlanVersionId", async () => {
  const validBody = {
    documentId: "benefit-document",
    expectedVersion: 1,
    expectedPlanVersionId: "benefit-plan-version-7",
    todoId: "benefit-todo",
    reason: "确认九月福利",
    attachmentVersionIds: ["attachment-a", "attachment-b"],
    idempotencyKey: "benefit-confirm-1",
  };

  for (const [label, mutate] of [
    ["missing", (body) => { delete body.expectedPlanVersionId; }],
    ["empty", (body) => { body.expectedPlanVersionId = ""; }],
    ["unknown field", (body) => { body.unexpected = "forged"; }],
  ]) {
    const { calls, services } = servicesFor();
    const body = { ...validBody };
    mutate(body);
    const response = await handleRequest({
      method: "POST",
      path: "/v1/finance/benefits/confirm",
      sessionId: "session",
      body,
    }, services);
    assert.equal(response.status, 400, label);
    assert.equal(response.body.error.code, "INVALID_INPUT", label);
    assert.equal(calls.length, 0, `${label}: invalid request must not call service`);
  }

  const { calls, services } = servicesFor();
  const response = await handleRequest({
    method: "POST",
    path: "/v1/finance/benefits/confirm",
    sessionId: "session",
    body: validBody,
  }, services);
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0], [
    "benefit-confirm",
    hq,
    {
      documentId: "benefit-document",
      expectedVersion: 1,
      expectedPlanVersionId: "benefit-plan-version-7",
      todoId: "benefit-todo",
      reason: "确认九月福利",
      attachmentVersionIds: ["attachment-a", "attachment-b"],
    },
    "benefit-confirm-1",
    at,
  ]);
});
