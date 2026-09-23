import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import { fileURLToPath } from "node:url";
import {
  LocalAttachmentStore, PostgresFinanceAttachmentService, PostgresFinanceAttachmentUploadService,
  PostgresSalaryBenefitsService
} from "../../dist/main.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const at = new Date("2026-09-01T00:00:00.000Z");
const finance = (personId) => ({ personId, subject: "HEADQUARTERS_FINANCE", scope: "GLOBAL" });
const balance = async (pool, account) => BigInt((await pool.query("SELECT balance_cents::text AS value FROM account_balance_projection WHERE account_id=$1::uuid", [account])).rows[0].value);

test("工资计划不入账；现金确认、奖金与社保待办各自一次入账且有两份原件", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-salary-benefits-"));
  try {
    const [financeId, teacherId, fundId, sourceAccount, personAccount] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const [id, nickname] of [[financeId, "salary-finance"], [teacherId, "salary-teacher"]]) {
      await db.pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,$2,'ACTIVE')", [id, nickname]);
    }
    await db.pool.query("INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,'COMPANY',$2::uuid,$3,'ACTIVE'),($4::uuid,'PERSON',$5::uuid,$6,'ACTIVE')", [sourceAccount, fundId, `company:fund:${fundId}`, personAccount, teacherId, `person:${teacherId}`]);
    await db.pool.query("INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1::uuid,20000),($2::uuid,6000)", [sourceAccount, personAccount]);
    await db.pool.query("INSERT INTO company_finance_fund(id,kind,fund_code,display_name,organization_unit_id,status,version,created_by_person_id,created_at,updated_at) VALUES($1::uuid,'HEADQUARTERS_FINANCE_OPERATING','HQ_SALARY_TEST','工资财务账户',NULL,'ACTIVE',1,$2::uuid,$3,$3)", [fundId, financeId, at.toISOString()]);
    await db.pool.query("INSERT INTO company_finance_fund_assignment(id,fund_id,duty_subject,scope_type,scope_id,responsibility_code,valid_from,valid_to,created_by_person_id,created_at) VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'FINANCE_OPERATING_SOURCE',$3,NULL,$4::uuid,$3)", [randomUUID(), fundId, new Date(at.getTime() - 1_000).toISOString(), financeId]);

    const store = await LocalAttachmentStore.create(root, resolve(fileURLToPath(new URL("../../../../", import.meta.url))));
    const salary = new PostgresSalaryBenefitsService(db.pool, store);
    const attachments = new PostgresFinanceAttachmentService(db.pool);
    const uploads = new PostgresFinanceAttachmentUploadService(db.pool, store);
    const bytes = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 120) });
    const originals = async (documentId, prefix) => {
      const ids = [];
      for (const purpose of ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT"]) {
        const reserved = await attachments.reserve(finance(financeId), documentId, { purpose, originalFilename: `${prefix}-${purpose}.png`, declaredMediaType: "image/png", declaredSizeBytes: bytes.length }, `${prefix}-${purpose}`, at);
        await uploads.upload(finance(financeId), reserved.versionId, (async function* () { yield bytes; })(), at);
        ids.push(reserved.versionId);
      }
      return ids;
    };

    const plan = await salary.setCashWagePlan(finance(financeId), { teacherPersonId: teacherId, salaryMonth: "2026-09-01", plannedCashCents: "4900", plannedDeductionCents: "4900", active: true, reason: "九月基础工资" }, "wage-plan", at);
    assert.equal(await balance(db.pool, personAccount), 6000n, "保存工资计划不得扣老师豆");
    const generatedWageTodos = await salary.generateCashWageTodos(finance(financeId), "wage-due", at);
    assert.equal(generatedWageTodos.length, 1);
    assert.equal(generatedWageTodos[0].planVersionId, plan.planVersionId, "待办返回其真实工资计划版本");
    const wageDocument = await salary.createEvidenceDocument(finance(financeId), "CASH_WAGE", "wage-doc", at);
    const wageFiles = await originals(wageDocument.id, "wage");
    const confirmed = await salary.confirmCashWage(finance(financeId), { documentId: wageDocument.id, expectedVersion: 1, todoId: (await db.pool.query("SELECT id::text AS id FROM cash_wage_todo")).rows[0].id, cashPaidCents: "4900", deductionCents: "4900", paidAt: at.toISOString(), reason: "现金已发", attachmentVersionIds: wageFiles }, "wage-confirm", at);
    assert.deepEqual(confirmed, { id: wageDocument.id, status: "COMPLETED", version: 2, replay: false });
    assert.equal(await balance(db.pool, personAccount), 1100n);
    assert.equal((await salary.confirmCashWage(finance(financeId), { documentId: wageDocument.id, expectedVersion: 1, todoId: (await db.pool.query("SELECT id::text AS id FROM cash_wage_todo")).rows[0].id, cashPaidCents: "4900", deductionCents: "4900", paidAt: at.toISOString(), reason: "现金已发", attachmentVersionIds: wageFiles }, "wage-confirm", new Date("2026-10-01T00:00:00.000Z"))).replay, true);
    assert.equal(await balance(db.pool, personAccount), 1100n, "工资确认重放不得二扣");
    await salary.setCashWagePlan(finance(financeId), { teacherPersonId: teacherId, salaryMonth: "2026-09-01", plannedCashCents: "5300", plannedDeductionCents: "5300", active: true, reason: "计划修订" }, "wage-plan-revised", at);
    assert.equal(await balance(db.pool, personAccount), 1100n, "改计划不得追扣已发工资");
    const topUp = await salary.createEvidenceDocument(finance(financeId), "CASH_WAGE", "wage-topup-doc", at);
    const topUpFiles = await originals(topUp.id, "wage-topup");
    const todoId = (await db.pool.query("SELECT id::text AS id FROM cash_wage_todo")).rows[0].id;
    await salary.confirmCashWage(finance(financeId), { documentId: topUp.id, expectedVersion: 1, todoId, cashPaidCents: "400", deductionCents: "400", paidAt: at.toISOString(), reason: "补发", attachmentVersionIds: topUpFiles }, "wage-topup", at);
    assert.equal(await balance(db.pool, personAccount), 700n, "补发仅追加对应扣豆");
    const wageReversal = await salary.createEvidenceDocument(finance(financeId), "CASH_WAGE", "wage-reversal-doc", at);
    await db.pool.query("UPDATE settlement_account SET status='INACTIVE' WHERE id=$1::uuid", [personAccount]);
    await salary.reversePosting(finance(financeId), { originalDocumentId: wageDocument.id, reversalDocumentId: wageReversal.id, expectedOriginalVersion: 2, expectedReversalVersion: 1, reason: "工资原记录更正", attachmentVersionIds: await originals(wageReversal.id, "wage-reversal") }, "wage-reverse", at);
    assert.equal(await balance(db.pool, personAccount), 5600n, "冲回工资只反向原确认");
    await db.pool.query("UPDATE settlement_account SET status='ACTIVE' WHERE id=$1::uuid", [personAccount]);
    const missingChain = await salary.createEvidenceDocument(finance(financeId), "CASH_WAGE", "wage-rerecord-missing-chain", at);
    await assert.rejects(() => salary.confirmCashWage(finance(financeId), { documentId: missingChain.id, expectedVersion: 1, todoId, cashPaidCents: "4900", deductionCents: "4900", paidAt: at.toISOString(), reason: "重记工资", attachmentVersionIds: [randomUUID(), randomUUID()] }, "wage-rerecord-missing-chain", at), /CASH_WAGE_CORRECTION_REQUIRED/);
    const wageRerecord = await salary.createEvidenceDocument(finance(financeId), "CASH_WAGE", "wage-rerecord-doc", at);
    await salary.confirmCashWage(finance(financeId), { documentId: wageRerecord.id, expectedVersion: 1, todoId, cashPaidCents: "4800", deductionCents: "4800", paidAt: at.toISOString(), reason: "关联原工资更正重记", attachmentVersionIds: await originals(wageRerecord.id, "wage-rerecord"), correctionOfDocumentId: wageDocument.id }, "wage-rerecord", at);
    assert.equal(await balance(db.pool, personAccount), 800n, "关联更正链可按正确金额重记，不复制错误原金额");
    assert.equal((await db.pool.query("SELECT correction_of_finance_document_id::text AS original FROM cash_wage_confirmation WHERE finance_document_id=$1::uuid", [wageRerecord.id])).rows[0].original, wageDocument.id);

    const bonus = await salary.createEvidenceDocument(finance(financeId), "PROJECT_BONUS", "bonus-doc", at);
    await salary.grantBonus(finance(financeId), { documentId: bonus.id, expectedVersion: 1, projectNo: 1, projectName: "项目一", recipientPersonId: teacherId, sourceFundId: fundId, amountCents: "100", reason: "项目奖金", attachmentVersionIds: await originals(bonus.id, "bonus") }, "bonus-grant", at);
    assert.equal(await balance(db.pool, sourceAccount), 19900n);
    assert.equal(await balance(db.pool, personAccount), 900n, "奖金是职务账户到个人账户的双侧划拨");
    const bonusCorrection = await salary.createEvidenceDocument(finance(financeId), "PROJECT_BONUS", "bonus-correction-doc", at);
    const bonusCorrectionFiles = await originals(bonusCorrection.id, "bonus-correction");
    await db.pool.query("UPDATE settlement_account SET status='INACTIVE' WHERE id IN ($1::uuid,$2::uuid)", [sourceAccount, personAccount]);
    const reversed = await salary.reversePosting(finance(financeId), { originalDocumentId: bonus.id, reversalDocumentId: bonusCorrection.id, expectedOriginalVersion: 2, expectedReversalVersion: 1, reason: "奖金录入更正", attachmentVersionIds: bonusCorrectionFiles }, "bonus-reverse", at);
    assert.equal(reversed.status, "COMPLETED");
    assert.equal(await balance(db.pool, sourceAccount), 20000n);
    assert.equal(await balance(db.pool, personAccount), 800n, "撤销只反向原奖金，不覆盖工资扣减");
    assert.equal((await salary.reversePosting(finance(financeId), { originalDocumentId: bonus.id, reversalDocumentId: bonusCorrection.id, expectedOriginalVersion: 2, expectedReversalVersion: 1, reason: "奖金录入更正", attachmentVersionIds: bonusCorrectionFiles }, "bonus-reverse", at)).replay, true);

    await db.pool.query("UPDATE settlement_account SET status='ACTIVE' WHERE id IN ($1::uuid,$2::uuid)", [sourceAccount, personAccount]);
    await salary.setBenefitPlan(finance(financeId), { benefitKind: "SOCIAL_INSURANCE", beneficiaryPersonId: teacherId, benefitMonth: "2026-09-01", executionDay: 5, amountCents: "800", sourceFundId: fundId, active: true, reason: "九月社保" }, "benefit-plan", at);
    assert.equal((await salary.generateBenefitTodos(finance(financeId), "benefit-not-due", at)).length, 0, "未到执行日不生成待办");
    const dueAt = new Date("2026-09-05T00:00:00.000Z");
    const benefitTodos = await salary.generateBenefitTodos(finance(financeId), "benefit-due", dueAt);
    assert.equal(benefitTodos.length, 1);
    assert.equal(await balance(db.pool, sourceAccount), 20000n, "待办生成不得扣职务账户");
    const benefit = await salary.createEvidenceDocument(finance(financeId), "FINANCE_BENEFIT", "benefit-doc", dueAt);
    await salary.confirmBenefit(finance(financeId), { documentId: benefit.id, expectedVersion: 1, todoId: benefitTodos[0].id, reason: "社保已办理", attachmentVersionIds: await originals(benefit.id, "benefit") }, "benefit-confirm", dueAt);
    assert.equal(await balance(db.pool, sourceAccount), 19200n);
    assert.equal(await balance(db.pool, personAccount), 800n, "社保不扣老师也不加老师");
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM salary_benefit_attachment_binding")).rows[0].n, 14);
    assert.equal(plan.kind, "CASH_WAGE_PLAN");
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("工资与社保待办补办、改计划和多次执行均保持单一业务链", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-salary-benefits-regression-"));
  try {
    const [financeId, teacherId, fundId, sourceAccount, personAccount] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const [id, nickname] of [[financeId, "salary-regression-finance"], [teacherId, "salary-regression-teacher"]]) {
      await db.pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,$2,'ACTIVE')", [id, nickname]);
    }
    await db.pool.query("INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,'COMPANY',$2::uuid,$3,'ACTIVE'),($4::uuid,'PERSON',$5::uuid,$6,'ACTIVE')", [sourceAccount, fundId, `company:regression:${fundId}`, personAccount, teacherId, `person:${teacherId}`]);
    await db.pool.query("INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1::uuid,20000),($2::uuid,1000)", [sourceAccount, personAccount]);
    await db.pool.query("INSERT INTO company_finance_fund(id,kind,fund_code,display_name,organization_unit_id,status,version,created_by_person_id,created_at,updated_at) VALUES($1::uuid,'HEADQUARTERS_FINANCE_OPERATING','HQ_SALARY_REGRESSION','工资回归财务账户',NULL,'ACTIVE',1,$2::uuid,$3,$3)", [fundId, financeId, at.toISOString()]);
    await db.pool.query("INSERT INTO company_finance_fund_assignment(id,fund_id,duty_subject,scope_type,scope_id,responsibility_code,valid_from,valid_to,created_by_person_id,created_at) VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'FINANCE_OPERATING_SOURCE',$3,NULL,$4::uuid,$3)", [randomUUID(), fundId, new Date(at.getTime() - 1_000).toISOString(), financeId]);

    const store = await LocalAttachmentStore.create(root, resolve(fileURLToPath(new URL("../../../../", import.meta.url))));
    const salary = new PostgresSalaryBenefitsService(db.pool, store);
    const attachments = new PostgresFinanceAttachmentService(db.pool);
    const uploads = new PostgresFinanceAttachmentUploadService(db.pool, store);
    const bytes = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 120) });
    const originals = async (documentId, prefix) => {
      const ids = [];
      for (const purpose of ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT"]) {
        const reserved = await attachments.reserve(finance(financeId), documentId, { purpose, originalFilename: `${prefix}-${purpose}.png`, declaredMediaType: "image/png", declaredSizeBytes: bytes.length }, `${prefix}-${purpose}`, at);
        await uploads.upload(finance(financeId), reserved.versionId, (async function* () { yield bytes; })(), at);
        ids.push(reserved.versionId);
      }
      return ids;
    };

    await salary.setCashWagePlan(finance(financeId), { teacherPersonId: teacherId, salaryMonth: "2026-09-01", plannedCashCents: "100", plannedDeductionCents: "100", active: true, reason: "九月工资" }, "regression-wage-september", at);
    assert.equal((await salary.generateCashWageTodos(finance(financeId), "regression-wage-late", new Date("2026-09-03T00:00:00.000Z"))).length, 1, "错过1日仍能补办工资待办");
    await assert.rejects(() => salary.confirmCashWage(finance(financeId), { documentId: randomUUID(), expectedVersion: 1, todoId: randomUUID(), cashPaidCents: "0", deductionCents: "1", paidAt: at.toISOString(), reason: "不得零发", attachmentVersionIds: [randomUUID(), randomUUID()] }, "regression-wage-zero", at), /INVALID_INPUT/);
    await assert.rejects(() => salary.confirmCashWage(finance(financeId), { documentId: randomUUID(), expectedVersion: 1, todoId: randomUUID(), cashPaidCents: "10", deductionCents: "9", paidAt: at.toISOString(), reason: "不得不对应", attachmentVersionIds: [randomUUID(), randomUUID()] }, "regression-wage-mismatch", at), /CASH_WAGE_AMOUNT_MISMATCH/);
    const todoId = (await db.pool.query("SELECT id::text AS id FROM cash_wage_todo WHERE salary_month='2026-09-01'::date")).rows[0].id;
    const first = await salary.createEvidenceDocument(finance(financeId), "CASH_WAGE", "regression-wage-first-doc", at);
    await salary.confirmCashWage(finance(financeId), { documentId: first.id, expectedVersion: 1, todoId, cashPaidCents: "60", deductionCents: "60", paidAt: at.toISOString(), reason: "第一次发放", attachmentVersionIds: await originals(first.id, "regression-wage-first") }, "regression-wage-first", at);
    await salary.setCashWagePlan(finance(financeId), { teacherPersonId: teacherId, salaryMonth: "2026-09-01", plannedCashCents: "80", plannedDeductionCents: "80", active: true, reason: "本月计划改为80" }, "regression-wage-revised", at);
    const topUp = await salary.createEvidenceDocument(finance(financeId), "CASH_WAGE", "regression-wage-topup-doc", at);
    await salary.confirmCashWage(finance(financeId), { documentId: topUp.id, expectedVersion: 1, todoId, cashPaidCents: "20", deductionCents: "20", paidAt: at.toISOString(), reason: "第二次补发", attachmentVersionIds: await originals(topUp.id, "regression-wage-topup") }, "regression-wage-topup", at);
    assert.equal(await balance(db.pool, personAccount), 920n, "多次实发只扣对应金额");
    const overPlan = await salary.createEvidenceDocument(finance(financeId), "CASH_WAGE", "regression-wage-over-doc", at);
    await assert.rejects(() => salary.confirmCashWage(finance(financeId), { documentId: overPlan.id, expectedVersion: 1, todoId, cashPaidCents: "1", deductionCents: "1", paidAt: at.toISOString(), reason: "不得超过计划", attachmentVersionIds: [randomUUID(), randomUUID()] }, "regression-wage-over", at), /CASH_WAGE_PLAN_EXCEEDED/);
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM cash_wage_confirmation WHERE todo_id=$1::uuid", [todoId])).rows[0].n, 2);

    await salary.setCashWagePlan(finance(financeId), { teacherPersonId: teacherId, salaryMonth: "2026-10-01", plannedCashCents: "10", plannedDeductionCents: "10", active: true, reason: "十月原计划" }, "regression-wage-october", at);
    await salary.setCashWagePlan(finance(financeId), { teacherPersonId: teacherId, salaryMonth: "2026-11-01", plannedCashCents: "10", plannedDeductionCents: "10", active: true, reason: "十一月原计划" }, "regression-wage-november", at);
    await salary.setCashWagePlan(finance(financeId), { teacherPersonId: teacherId, salaryMonth: "2026-10-01", plannedCashCents: "15", plannedDeductionCents: "15", active: true, reason: "从十月起调整", applyToFutureMonths: true }, "regression-wage-future", at);
    const futurePlans = await db.pool.query("SELECT DISTINCT ON (salary_month) salary_month::text AS month,planned_cash_cents::text AS cash FROM cash_wage_plan_version WHERE teacher_person_id=$1::uuid AND salary_month IN ('2026-10-01'::date,'2026-11-01'::date) ORDER BY salary_month,version_no DESC", [teacherId]);
    assert.deepEqual(futurePlans.rows, [{ month: "2026-10-01", cash: "15" }, { month: "2026-11-01", cash: "15" }]);
    assert.equal((await salary.generateCashWageTodos(finance(financeId), "regression-wage-next-month-late", new Date("2026-10-04T00:00:00.000Z"))).length, 1, "未来月份也可在1日后补办");
    const inheritedTodos = await salary.generateCashWageTodos(finance(financeId), "regression-wage-inherited-december", new Date("2026-12-03T00:00:00.000Z"));
    assert.equal(inheritedTodos.length, 1, "未预建的后续月份继承从选定月份起的计划");
    const inheritedPlan = (await db.pool.query("SELECT plan.salary_month::text AS source_month,plan.planned_cash_cents::text AS cash,plan.applies_to_future_months FROM cash_wage_todo todo JOIN cash_wage_plan_version plan ON plan.id=todo.plan_version_id WHERE todo.id=$1::uuid", [inheritedTodos[0].id])).rows[0];
    assert.deepEqual(inheritedPlan, { source_month: "2026-10-01", cash: "15", applies_to_future_months: true });

    await assert.rejects(() => salary.setBenefitPlan(finance(financeId), { benefitKind: "SOCIAL_INSURANCE", beneficiaryPersonId: teacherId, benefitMonth: "2026-02-01", executionDay: 31, amountCents: "1", sourceFundId: fundId, active: true, reason: "短月31日" }, "regression-benefit-invalid-day", at), /INVALID_INPUT/);
    await salary.setBenefitPlan(finance(financeId), { benefitKind: "SOCIAL_INSURANCE", beneficiaryPersonId: teacherId, benefitMonth: "2026-09-01", executionDay: 5, amountCents: "700", sourceFundId: fundId, active: true, reason: "原社保计划" }, "regression-benefit-first", at);
    assert.equal((await salary.generateBenefitTodos(finance(financeId), "regression-benefit-not-due", at)).length, 0);
    await salary.setBenefitPlan(finance(financeId), { benefitKind: "HOUSING_FUND", beneficiaryPersonId: teacherId, benefitMonth: "2026-10-01", executionDay: 20, amountCents: "300", sourceFundId: fundId, active: true, reason: "原公积金日期" }, "regression-housing-first", at);
    await salary.setBenefitPlan(finance(financeId), { benefitKind: "HOUSING_FUND", beneficiaryPersonId: teacherId, benefitMonth: "2026-10-01", executionDay: 25, amountCents: "300", sourceFundId: fundId, active: true, reason: "公积金改到25日" }, "regression-housing-later", at);
    assert.equal((await salary.generateBenefitTodos(finance(financeId), "regression-housing-before-latest-date", new Date("2026-10-22T00:00:00.000Z"))).length, 0, "最新计划未到期时不得回退旧日期生成待办");
    await salary.setBenefitPlan(finance(financeId), { benefitKind: "HOUSING_FUND", beneficiaryPersonId: teacherId, benefitMonth: "2026-10-01", executionDay: 21, amountCents: "300", sourceFundId: fundId, active: false, reason: "本月公积金停用" }, "regression-housing-disabled", at);
    assert.equal((await salary.generateBenefitTodos(finance(financeId), "regression-housing-disabled-latest", new Date("2026-10-26T00:00:00.000Z"))).length, 0, "最新计划停用时不得回退旧启用版本");
    await salary.setBenefitPlan(finance(financeId), { benefitKind: "SOCIAL_INSURANCE", beneficiaryPersonId: teacherId, benefitMonth: "2026-09-01", executionDay: 4, amountCents: "800", sourceFundId: fundId, active: true, reason: "改日且改金额" }, "regression-benefit-revised", new Date("2026-09-03T00:00:00.000Z"));
    const benefitTodos = await salary.generateBenefitTodos(finance(financeId), "regression-benefit-late", new Date("2026-09-06T00:00:00.000Z"));
    assert.equal(benefitTodos.length, 1, "错过执行日仍生成一个待办");
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM finance_benefit_todo WHERE benefit_kind='SOCIAL_INSURANCE' AND beneficiary_person_id=$1::uuid AND benefit_month='2026-09-01'::date", [teacherId])).rows[0].n, 1);
    const benefit = await salary.createEvidenceDocument(finance(financeId), "FINANCE_BENEFIT", "regression-benefit-doc", at);
    await salary.confirmBenefit(finance(financeId), { documentId: benefit.id, expectedVersion: 1, todoId: benefitTodos[0].id, reason: "按新计划办理", attachmentVersionIds: await originals(benefit.id, "regression-benefit") }, "regression-benefit-confirm", new Date("2026-09-06T00:00:00.000Z"));
    assert.equal(await balance(db.pool, sourceAccount), 19200n, "未执行待办读取最新计划金额");
    await salary.setBenefitPlan(finance(financeId), { benefitKind: "SOCIAL_INSURANCE", beneficiaryPersonId: teacherId, benefitMonth: "2026-09-01", executionDay: 4, amountCents: "1000", sourceFundId: fundId, active: true, reason: "执行后改计划" }, "regression-benefit-after-execution", at);
    assert.equal((await salary.generateBenefitTodos(finance(financeId), "regression-benefit-after-execution-generate", new Date("2026-09-07T00:00:00.000Z"))).length, 0, "执行后改计划不得再生成业务待办");
    const duplicateBenefit = await salary.createEvidenceDocument(finance(financeId), "FINANCE_BENEFIT", "regression-benefit-duplicate-doc", at);
    await assert.rejects(() => salary.confirmBenefit(finance(financeId), { documentId: duplicateBenefit.id, expectedVersion: 1, todoId: benefitTodos[0].id, reason: "不得重复执行", attachmentVersionIds: [randomUUID(), randomUUID()] }, "regression-benefit-duplicate", at), /FINANCE_BENEFIT_ALREADY_EXECUTED/);
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM finance_benefit_execution WHERE todo_id=$1::uuid", [benefitTodos[0].id])).rows[0].n, 1);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("0024 从已部署的0023前向升级，回填社保业务键且拒绝历史非法工资确认", async () => {
  const migration = await readFile(new URL("../../../../database/migrations/0024_salary_benefit_integrity.sql", import.meta.url), "utf8");
  const seed = async (pool, cashPaidCents, deductionCents) => {
    const [financeId, teacherId, fundId, accountId, documentId, eventId, benefitPlanId] = Array.from({ length: 7 }, () => randomUUID());
    await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,'upgrade-finance','upgrade-finance','ACTIVE'),($2::uuid,'upgrade-teacher','upgrade-teacher','ACTIVE')", [financeId, teacherId]);
    await pool.query("INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,'PERSON',$2::uuid,$3,'ACTIVE')", [accountId, teacherId, `person:upgrade:${teacherId}`]);
    await pool.query("INSERT INTO company_finance_fund(id,kind,fund_code,display_name,organization_unit_id,status,version,created_by_person_id,created_at,updated_at) VALUES($1::uuid,'HEADQUARTERS_FINANCE_OPERATING',$2,'升级测试基金',NULL,'ACTIVE',1,$3::uuid,$4,$4)", [fundId, `UPGRADE_${fundId.replaceAll("-", "").slice(0, 12).toUpperCase()}`, financeId, at.toISOString()]);
    await pool.query("INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at) VALUES($1::uuid,$2::uuid,'CASH_WAGE','COMPLETED',2,$3,$3)", [documentId, financeId, at.toISOString()]);
    await pool.query("INSERT INTO ledger_event(id,event_key,event_type,payload_hash) VALUES($1::uuid,$2,'upgrade','0')", [eventId, `upgrade:${eventId}`]);
    await pool.query("INSERT INTO cash_wage_plan_version(teacher_person_id,salary_month,version_no,planned_cash_cents,planned_deduction_cents,active,changed_by_person_id,changed_at,reason) VALUES($1::uuid,'2026-09-01'::date,1,100,100,true,$2::uuid,$3,'旧单月工资计划')", [teacherId, financeId, at.toISOString()]);
    await pool.query("INSERT INTO cash_wage_confirmation(finance_document_id,todo_id,teacher_person_id,destination_account_id,salary_month,cash_paid_cents,deduction_cents,paid_at,reason,ledger_event_id,confirmed_by_person_id,created_at) VALUES($1::uuid,NULL,$2::uuid,$3::uuid,'2026-09-01'::date,$4::bigint,$5::bigint,$6,'历史确认',$7::uuid,$8::uuid,$6)", [documentId, teacherId, accountId, cashPaidCents, deductionCents, at.toISOString(), eventId, financeId]);
    await pool.query("INSERT INTO finance_benefit_plan_version(id,benefit_kind,beneficiary_person_id,benefit_month,version_no,execution_day,amount_cents,source_fund_id,active,changed_by_person_id,changed_at,reason) VALUES($1::uuid,'SOCIAL_INSURANCE',$2::uuid,'2026-09-01'::date,1,5,100,$3::uuid,true,$4::uuid,$5,'旧社保待办')", [benefitPlanId, teacherId, fundId, financeId, at.toISOString()]);
    await pool.query("INSERT INTO finance_benefit_todo(plan_version_id,generated_at) VALUES($1::uuid,$2)", [benefitPlanId, at.toISOString()]);
    return { financeId, teacherId, fundId, benefitPlanId };
  };
  const valid = await createTestDatabase(process.env.DATABASE_URL, { throughMigration: 23 });
  try {
    const { financeId, teacherId, fundId } = await seed(valid.pool, "100", "100");
    await valid.pool.query(migration);
    assert.deepEqual((await valid.pool.query("SELECT benefit_kind,beneficiary_person_id::text AS beneficiary_person_id,benefit_month::text AS benefit_month FROM finance_benefit_todo")).rows, [{ benefit_kind: "SOCIAL_INSURANCE", beneficiary_person_id: teacherId, benefit_month: "2026-09-01" }]);
    assert.equal((await valid.pool.query("SELECT bool_and(NOT applies_to_future_months) AS legacy_is_single_month FROM cash_wage_plan_version")).rows[0].legacy_is_single_month, true, "旧工资计划升级后保持单月语义");
    await assert.rejects(() => valid.pool.query("INSERT INTO cash_wage_plan_version(teacher_person_id,salary_month,version_no,planned_cash_cents,planned_deduction_cents,active,changed_by_person_id,changed_at,reason) VALUES($1::uuid,'2026-10-01'::date,1,100,99,true,$2::uuid,$3,'非法不等额计划')", [teacherId, financeId, at.toISOString()]), /cash_wage_plan_amount_matches/);
    const mismatchedPlanId = randomUUID();
    await valid.pool.query("INSERT INTO finance_benefit_plan_version(id,benefit_kind,beneficiary_person_id,benefit_month,version_no,execution_day,amount_cents,source_fund_id,active,changed_by_person_id,changed_at,reason) VALUES($1::uuid,'HOUSING_FUND',$2::uuid,'2026-10-01'::date,1,5,100,$3::uuid,true,$4::uuid,$5,'复合外键测试计划')", [mismatchedPlanId, teacherId, fundId, financeId, at.toISOString()]);
    await assert.rejects(() => valid.pool.query("INSERT INTO finance_benefit_todo(plan_version_id,benefit_kind,beneficiary_person_id,benefit_month,generated_at) VALUES($1::uuid,'SOCIAL_INSURANCE',$2::uuid,'2026-10-01'::date,$3)", [mismatchedPlanId, teacherId, at.toISOString()]), /finance_benefit_todo_plan_business_fk/);
  } finally { await valid.close(); }

  const duplicate = await createTestDatabase(process.env.DATABASE_URL, { throughMigration: 23 });
  try {
    const { financeId, teacherId, fundId } = await seed(duplicate.pool, "100", "100");
    const secondPlanId = randomUUID();
    await duplicate.pool.query("INSERT INTO finance_benefit_plan_version(id,benefit_kind,beneficiary_person_id,benefit_month,version_no,execution_day,amount_cents,source_fund_id,active,changed_by_person_id,changed_at,reason) VALUES($1::uuid,'SOCIAL_INSURANCE',$2::uuid,'2026-09-01'::date,2,6,120,$3::uuid,true,$4::uuid,$5,'旧库第二版计划')", [secondPlanId, teacherId, fundId, financeId, at.toISOString()]);
    await duplicate.pool.query("INSERT INTO finance_benefit_todo(plan_version_id,generated_at) VALUES($1::uuid,$2)", [secondPlanId, at.toISOString()]);
    assert.equal((await duplicate.pool.query("SELECT COUNT(*)::int AS n FROM finance_benefit_todo")).rows[0].n, 2);
    await assert.rejects(() => duplicate.pool.query(migration), /FINANCE_BENEFIT_TODO_LEGACY_DUPLICATE/);
    assert.equal((await duplicate.pool.query("SELECT COUNT(*)::int AS n FROM finance_benefit_todo")).rows[0].n, 2, "失败升级不删除或合并旧待办");
    assert.equal((await duplicate.pool.query("SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='finance_benefit_todo' AND column_name='benefit_kind'")).rows[0].n, 0, "失败升级回滚新增列");
    await assert.rejects(() => duplicate.pool.query("UPDATE finance_benefit_todo SET generated_at=generated_at"), /SALARY_BENEFIT_IMMUTABLE/, "失败升级保留旧不可变触发器");
  } finally { await duplicate.close(); }
  for (const [cashPaidCents, deductionCents] of [["0", "1"], ["1", "2"]]) {
    const invalid = await createTestDatabase(process.env.DATABASE_URL, { throughMigration: 23 });
    try {
      await seed(invalid.pool, cashPaidCents, deductionCents);
      await assert.rejects(() => invalid.pool.query(migration), /CASH_WAGE_CONFIRMATION_LEGACY_AMOUNT_INVALID/);
    } finally { await invalid.close(); }
  }
});
