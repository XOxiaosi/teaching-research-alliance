import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
    assert.equal((await salary.generateCashWageTodos(finance(financeId), "wage-due", at)).length, 1);
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

    const bonus = await salary.createEvidenceDocument(finance(financeId), "PROJECT_BONUS", "bonus-doc", at);
    await salary.grantBonus(finance(financeId), { documentId: bonus.id, expectedVersion: 1, projectNo: 1, projectName: "项目一", recipientPersonId: teacherId, sourceFundId: fundId, amountCents: "100", reason: "项目奖金", attachmentVersionIds: await originals(bonus.id, "bonus") }, "bonus-grant", at);
    assert.equal(await balance(db.pool, sourceAccount), 19900n);
    assert.equal(await balance(db.pool, personAccount), 800n, "奖金是职务账户到个人账户的双侧划拨");
    const bonusCorrection = await salary.createEvidenceDocument(finance(financeId), "PROJECT_BONUS", "bonus-correction-doc", at);
    const bonusCorrectionFiles = await originals(bonusCorrection.id, "bonus-correction");
    const reversed = await salary.reversePosting(finance(financeId), { originalDocumentId: bonus.id, reversalDocumentId: bonusCorrection.id, expectedOriginalVersion: 2, expectedReversalVersion: 1, reason: "奖金录入更正", attachmentVersionIds: bonusCorrectionFiles }, "bonus-reverse", at);
    assert.equal(reversed.status, "COMPLETED");
    assert.equal(await balance(db.pool, sourceAccount), 20000n);
    assert.equal(await balance(db.pool, personAccount), 700n, "撤销只反向原奖金，不覆盖工资扣减");
    assert.equal((await salary.reversePosting(finance(financeId), { originalDocumentId: bonus.id, reversalDocumentId: bonusCorrection.id, expectedOriginalVersion: 2, expectedReversalVersion: 1, reason: "奖金录入更正", attachmentVersionIds: bonusCorrectionFiles }, "bonus-reverse", at)).replay, true);

    await salary.setBenefitPlan(finance(financeId), { benefitKind: "SOCIAL_INSURANCE", beneficiaryPersonId: teacherId, benefitMonth: "2026-09-01", executionDay: 5, amountCents: "800", sourceFundId: fundId, active: true, reason: "九月社保" }, "benefit-plan", at);
    assert.equal((await salary.generateBenefitTodos(finance(financeId), "benefit-not-due", at)).length, 0, "未到执行日不生成待办");
    const dueAt = new Date("2026-09-05T00:00:00.000Z");
    const benefitTodos = await salary.generateBenefitTodos(finance(financeId), "benefit-due", dueAt);
    assert.equal(benefitTodos.length, 1);
    assert.equal(await balance(db.pool, sourceAccount), 20000n, "待办生成不得扣职务账户");
    const benefit = await salary.createEvidenceDocument(finance(financeId), "FINANCE_BENEFIT", "benefit-doc", dueAt);
    await salary.confirmBenefit(finance(financeId), { documentId: benefit.id, expectedVersion: 1, todoId: benefitTodos[0].id, reason: "社保已办理", attachmentVersionIds: await originals(benefit.id, "benefit") }, "benefit-confirm", dueAt);
    assert.equal(await balance(db.pool, sourceAccount), 19200n);
    assert.equal(await balance(db.pool, personAccount), 700n, "社保不扣老师也不加老师");
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM salary_benefit_attachment_binding")).rows[0].n, 10);
    assert.equal(plan.kind, "CASH_WAGE_PLAN");
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
