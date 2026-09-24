import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, randomBytes } from "node:crypto";
import { DEFAULT_RATE_POLICY_VALUES } from "@teaching-research-alliance/domain";
import { createTestDatabase } from "../apps/api/test/integration/postgres-test-database.mjs";
import { PostgresAccountAccessService, PostgresRefundSubmissionService, PostgresRefundReviewService, PostgresRefundReadService, PostgresReimbursementSubmissionService, PostgresReimbursementReviewService, PostgresReimbursementReadService, PostgresReimbursementTransferService, PostgresReimbursementReversalService, createApiServer, PostgresSelfPurchaseReversalService, PostgresSelfPurchaseService, PostgresSelfPurchaseReadService, PostgresCompanyFundService, FinanceSensitiveFieldCrypto, PostgresWithdrawalService, PostgresWithdrawalReadService, LocalAttachmentStore, PostgresFinanceAttachmentUploadService, PostgresFinanceAttachmentReadService, PostgresSessionService, PostgresPersonalReadService, PostgresTeachingReadService, PostgresReferralCreationService, PostgresSentReferralReadService, PostgresReferralAcceptanceService, PostgresReferralLifecycleService, PostgresFinanceDraftService, PostgresFinanceAttachmentService, PostgresWeeklyFeeService, PostgresVenueService, PostgresVenueReadService, PostgresVenueBoardReadService, PostgresBenefitSourceFundDirectoryService, PostgresBenefitReadService, PostgresCashWageReadService, PostgresCashWageTeacherDirectoryService, PostgresOrganizationRevenueReadService, PostgresSalaryBenefitsService, PostgresBonusProjectCatalogService, PostgresProjectBonusReadService, PostgresGroupLeaderRelationshipService, PostgresGroupLeaderDirectoryService, PostgresTeachingMentorRelationshipService, PostgresAdminPlanningMentorRelationshipService, PostgresPersonRelationshipAuditService, hashPassword } from "../apps/api/dist/main.js";

// Explicitly synthetic, isolated, disposable local demonstration data.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL_REQUIRED");
const connection = new URL(process.env.DATABASE_URL);
if (!["localhost", "127.0.0.1", "[::1]"].includes(connection.hostname)) throw new Error("LOCAL_DEMO_DATABASE_REQUIRED");
const port = Number(process.env.PORT ?? "3100");
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("INVALID_PORT");
const effectiveFrom = "2026-09-01";
const validFrom = "2026-01-01T00:00:00Z";
const at = new Date("2026-09-21T04:00:00Z");
const stringifyPolicy = (policy) => JSON.stringify(policy, (_, value) => typeof value === "bigint" ? value.toString() : value);
const demoNicknames = {
  teacher: "演示授课老师", planner: "演示规划师", platformFinance: "演示总部财务", admin: "演示管理员",
  groupLeader: "演示原组长", groupLeaderCandidateA: "演示候选组长甲", groupLeaderCandidateB: "演示候选组长乙",
};

const addPerson = async (pool, id, name) => {
  await pool.query(
    `INSERT INTO person (id, nickname, legal_name, status)
     VALUES ($1::uuid, $2, $2, 'ACTIVE')`,
    [id, name]
  );
};

const addAccount = async (pool, ownerType, ownerId, code) => {
  await pool.query(
    `INSERT INTO settlement_account (owner_type, owner_id, account_code, status)
     VALUES ($1, $2::uuid, $3, 'ACTIVE')`,
    [ownerType, ownerId, code]
  );
};

const addRole = async (pool, personId, subjectCode, scopeType, scopeId, createdBy) => {
  await pool.query(
    `INSERT INTO role_assignment (person_id, subject_code, scope_type, scope_id, valid_from, created_by)
     VALUES ($1::uuid, $2, $3, $4::uuid, $5::timestamptz, $6::uuid)`,
    [personId, subjectCode, scopeType, scopeId, validFrom, createdBy]
  );
};

const addRelationship = async (pool, teacherId, relationshipType, relatedPersonId, from = validFrom) => {
  await pool.query(
    `INSERT INTO person_relationship (teacher_id, relationship_type, related_person_id, valid_from, effective_scope, created_by)
     VALUES ($1::uuid, $2, $3::uuid, $4::timestamptz, 'CURRENT', $1::uuid)`,
    [teacherId, relationshipType, relatedPersonId, from]
  );
};


const database = await createTestDatabase(process.env.DATABASE_URL);
const { pool } = database;
let server;
let attachmentRoot;
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  try { await database.close(); } finally { if(attachmentRoot) await rm(attachmentRoot,{recursive:true,force:true}); }
};
process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
try {
  const suffix = randomUUID();
  const ids = Object.fromEntries([
    "admin", "planner", "planningMentor", "groupLeader", "groupLeaderCandidateA", "groupLeaderCandidateB", "teachingMentor", "teacher", "teacherB", "platformFinance", "regionFinance",
    "region", "campus", "year", "period", "week", "student", "referral", "venue"
  ].map((key) => [key, randomUUID()]));
    for (const [key, id] of Object.entries(ids)) {
      if (["region", "campus", "year", "period", "week", "student", "referral", "venue"].includes(key)) continue;
      await addPerson(pool, id, demoNicknames[key] ?? `结算测试-${key}-${suffix}`);
    }
    await pool.query(
      `INSERT INTO organization_unit (id, unit_type, name)
       VALUES ($1::uuid, 'REGION', $2), ($3::uuid, 'CAMPUS', $4)`,
      [ids.region, `测试分区-${suffix}`, ids.campus, `测试校区-${suffix}`]
    );
    await pool.query("INSERT INTO campus_region_assignment(campus_id,region_id,valid_from,created_by) VALUES($1::uuid,$2::uuid,$3::timestamptz,$4::uuid)", [ids.campus,ids.region,validFrom,ids.admin]);
    await pool.query(
      `INSERT INTO teacher_profile (person_id, business_identity, region_id, campus_id, employment_status)
       VALUES ($1::uuid, 'ACADEMIC_PLANNER', $2::uuid, $3::uuid, 'ACTIVE'),
              ($4::uuid, 'TEACHING_TEACHER', $2::uuid, $3::uuid, 'ACTIVE'),
              ($5::uuid, 'TEACHING_TEACHER', $2::uuid, $3::uuid, 'ACTIVE'),
              ($6::uuid, 'TEACHING_TEACHER', $2::uuid, $3::uuid, 'ACTIVE')`,
      [ids.planner, ids.region, ids.campus, ids.teacher, ids.teacherB, ids.platformFinance]
    );
    await pool.query(
      `INSERT INTO person_campus_assignment (person_id, campus_id, region_id, valid_from, created_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::uuid),
              ($6::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::uuid),
              ($7::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::uuid),
              ($8::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::uuid)`,
      [ids.planner, ids.campus, ids.region, validFrom, ids.admin, ids.teacher, ids.teacherB, ids.platformFinance]
    );
    await addRole(pool, ids.planner, "ACADEMIC_PLANNER", "SELF", null, ids.admin);
    await addRole(pool, ids.planningMentor, "PLANNING_MENTOR", "SELF", null, ids.admin);
    await addRole(pool, ids.groupLeader, "GROUP_LEADER", "ASSOCIATED_TEACHERS", ids.teacher, ids.admin);
    // Two independent, login-enabled candidates make the real browser group-leader flow selectable.
    await addRole(pool, ids.groupLeaderCandidateA, "GROUP_LEADER", "ASSOCIATED_TEACHERS", null, ids.admin);
    await addRole(pool, ids.groupLeaderCandidateB, "GROUP_LEADER", "ASSOCIATED_TEACHERS", null, ids.admin);
    await addRole(pool, ids.teachingMentor, "TEACHING_MENTOR", "ASSOCIATED_TEACHERS", ids.teacher, ids.admin);
    await addRole(pool, ids.teacher, "TEACHING_TEACHER", "SELF", null, ids.admin);
    await addRole(pool, ids.teacherB, "TEACHING_TEACHER", "SELF", null, ids.admin);
    await addRole(pool, ids.platformFinance, "HEADQUARTERS_FINANCE", "GLOBAL", null, ids.admin);
    await addRole(pool, ids.platformFinance, "TEACHING_TEACHER", "SELF", null, ids.admin);
    await addRole(pool, ids.platformFinance, "CAMPUS_PRINCIPAL", "CAMPUS", ids.campus, ids.admin);
    await addRole(pool, ids.admin, "SYSTEM_ADMIN", "GLOBAL", null, ids.admin);
    await addRole(pool, ids.regionFinance, "REGION_FINANCE", "REGION", ids.region, ids.admin);
    await addRelationship(pool, ids.teacher, "GROUP_LEADER", ids.groupLeader);
    await addRelationship(pool, ids.teacher, "TEACHING_MENTOR", ids.teachingMentor);
    await addRelationship(pool, ids.teacherB, "GROUP_LEADER", ids.groupLeader);
    await addRelationship(pool, ids.teacherB, "TEACHING_MENTOR", ids.teachingMentor);
    await pool.query(
      `INSERT INTO venue (id, owner_person_id, name, status, default_for_owner)
       VALUES ($1::uuid, $2::uuid, $3, 'ACTIVE', true)`,
      [ids.venue, ids.teacher, "老师本人的教室"]
    );
    await pool.query(
      `INSERT INTO academic_year_plan (id, label, starts_on, ends_on, created_by)
       VALUES ($1::uuid, $2, DATE '2026-09-01', DATE '2027-08-31', $3::uuid)`,
      [ids.year, `测试学年-${suffix}`, ids.admin]
    );
    await pool.query(
      `INSERT INTO academic_period (id, academic_year_plan_id, label, starts_on, ends_on)
       VALUES ($1::uuid, $2::uuid, '普通学期', DATE '2026-09-01', DATE '2027-01-31')`,
      [ids.period, ids.year]
    );
    await pool.query(
      `INSERT INTO teaching_week (id, academic_period_id, sequence_no, week_kind, starts_on, ends_on, settlement_month)
       VALUES ($1::uuid, $2::uuid, 1, 'REGULAR', DATE '2026-09-21', DATE '2026-09-27', DATE '2026-09-01')`,
      [ids.week, ids.period]
    );
    await addAccount(pool, "PERSON", ids.planner, `person:planner:${suffix}`);
    await addAccount(pool, "PERSON", ids.planningMentor, `person:planning-mentor:${suffix}`);
    await addAccount(pool, "PERSON", ids.groupLeader, `person:group-leader:${suffix}`);
    await addAccount(pool, "PERSON", ids.groupLeaderCandidateA, `person:group-leader-candidate-a:${suffix}`);
    await addAccount(pool, "PERSON", ids.groupLeaderCandidateB, `person:group-leader-candidate-b:${suffix}`);
    await addAccount(pool, "PERSON", ids.teachingMentor, `person:teaching-mentor:${suffix}`);
    await addAccount(pool, "PERSON", ids.teacher, `person:teacher:${suffix}`);
    await addAccount(pool, "PERSON", ids.teacherB, `person:teacher-b:${suffix}`);
    await addAccount(pool, "PERSON", ids.platformFinance, `person:platform-finance:${suffix}`);
    await addAccount(pool, "PERSON", ids.regionFinance, `person:region-finance:${suffix}`);
    await addAccount(pool, "COMPANY", ids.campus, `company:campus:${suffix}`);
    await addAccount(pool, "VENUE", ids.venue, `venue:${suffix}`);
    await pool.query(
      `INSERT INTO rate_policy_version (version, effective_from, policy_json, reason, published_by)
       VALUES (1, $1::date, $2::jsonb, 'SYSTEM_DEFAULT', $3::uuid)`,
      [effectiveFrom, stringifyPolicy(DEFAULT_RATE_POLICY_VALUES), ids.admin]
    );


    await pool.query("INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name) VALUES ($1,$2,'数学','演示学生 小禾')", [ids.student,ids.teacher]);
    await pool.query("INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,unaccepted_expires_at) VALUES ($1,$2,$3,$4,'ACADEMIC_PLANNER','PENDING',$5,$6)", [ids.referral,ids.student,ids.planner,ids.teacher,at,new Date(at.getTime()+21*86400000)]);
    if (process.env.DEMO_WITH_ORGANIZATION_FEES === "1") {
      const teacherContext = { personId: ids.teacher, subject: "TEACHING_TEACHER", scope: "SELF" };
      await new PostgresReferralAcceptanceService(pool).accept(teacherContext, ids.referral, { venueId: ids.venue, expectedVersion: 1 }, `demo-org-accept-${suffix}`, at);
      await new PostgresWeeklyFeeService(pool).recordWeeklyFee(teacherContext, { referralCaseId: ids.referral, teachingWeekId: ids.week, venueId: ids.venue, settlementMonth: "2026-09-01", grossAmountCents: 100000n }, `demo-org-fee-${suffix}`);
    }
    const password = "Local-demo-only-2026";
    const hash = await hashPassword(password);
    for (const [personId, phone] of [[ids.teacher,"13800000001"],[ids.planner,"13800000002"],[ids.platformFinance,"13800000003"],[ids.admin,"13800000004"],[ids.regionFinance,"13800000005"],[ids.groupLeaderCandidateA,"13800000006"],[ids.groupLeaderCandidateB,"13800000007"]]) {
      await pool.query("INSERT INTO user_account(person_id,phone_normalized,password_hash,login_status) VALUES ($1,$2,$3,'ACTIVE')", [personId,phone,hash]);
    }
    if (process.env.DEMO_WITH_ACCOUNT_ACCESS === "1") {
      const ownerId = randomUUID();
      await addPerson(pool, ownerId, "演示开发者");
      await addRole(pool, ownerId, "SYSTEM_OWNER", "GLOBAL", null, ownerId);
      await pool.query("INSERT INTO user_account(person_id,phone_normalized,password_hash,login_status) VALUES ($1,'13800000008',$2,'ACTIVE')", [ownerId, hash]);
    }
    attachmentRoot=await mkdtemp(join(tmpdir(),"alliance-demo-attachments-"));
    const attachmentStore=await LocalAttachmentStore.create(attachmentRoot,fileURLToPath(new URL("../",import.meta.url)));
    const financeCrypto=new FinanceSensitiveFieldCrypto("synthetic-demo",{"synthetic-demo":randomBytes(32).toString("hex")});
    const salary = new PostgresSalaryBenefitsService(pool, attachmentStore);
    const salaryFundId = randomUUID();
    await pool.query("INSERT INTO company_finance_fund(id,kind,fund_code,display_name,organization_unit_id,status,version,created_by_person_id,created_at,updated_at) VALUES($1::uuid,'HEADQUARTERS_FINANCE_OPERATING',$2,$3,NULL,'ACTIVE',1,$4::uuid,$5,$5)", [salaryFundId, "HQ_SALARY", "演示工资账户", ids.platformFinance, at.toISOString()]);
    await pool.query("INSERT INTO company_finance_fund_assignment(id,fund_id,duty_subject,scope_type,scope_id,responsibility_code,valid_from,created_by_person_id,created_at) VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'FINANCE_OPERATING_SOURCE',$3,$4::uuid,$3)", [randomUUID(), salaryFundId, at.toISOString(), ids.platformFinance]);
    await addAccount(pool, "COMPANY", salaryFundId, `company:fund:${salaryFundId}`);
    const salaryContext = { personId: ids.platformFinance, subject: "HEADQUARTERS_FINANCE", scope: "GLOBAL" };
    const salaryPlan = await salary.setCashWagePlan(salaryContext, { teacherPersonId: ids.teacher, salaryMonth: "2026-09-01", plannedCashCents: "4900", plannedDeductionCents: "4900", active: true, reason: "演示九月工资" }, `demo-salary-plan-${suffix}`, at);
    const salaryTodos = await salary.generateCashWageTodos(salaryContext, `demo-salary-todo-${suffix}`, at);
    const salaryDocument = await salary.createEvidenceDocument(salaryContext, "CASH_WAGE", `demo-salary-doc-${suffix}`, at);
    const salaryBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4AWP8DwQMQMDEAAUAPfgEADYYS7QAAAAASUVORK5CYII=", "base64");
    const salaryAttachmentIds = [];
    for (const purpose of ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT"]) {
      const reserved = await new PostgresFinanceAttachmentService(pool).reserve(salaryContext, salaryDocument.id, { purpose, originalFilename: `演示工资-${purpose}.png`, declaredMediaType: "image/png", declaredSizeBytes: salaryBytes.length }, `demo-salary-attachment-${purpose}-${suffix}`, at);
      await new PostgresFinanceAttachmentUploadService(pool, attachmentStore).upload(salaryContext, reserved.versionId, (async function* () { yield salaryBytes; })(), at);
      salaryAttachmentIds.push(reserved.versionId);
    }
    await salary.confirmCashWage(salaryContext, { documentId: salaryDocument.id, expectedVersion: 1, todoId: salaryTodos[0].id, cashPaidCents: "4900", deductionCents: "4900", paidAt: at.toISOString(), reason: "演示工资已发", attachmentVersionIds: salaryAttachmentIds }, `demo-salary-confirm-${suffix}`, at);
    if (process.env.DEMO_WITH_BENEFITS === "1") {
      const benefitDraft = { benefitKind: "SOCIAL_INSURANCE", beneficiaryPersonId: ids.teacher, benefitMonth: "2026-09-01", executionDay: 5, amountCents: "7000", sourceFundId: salaryFundId, active: true, reason: "Synthetic benefit initial plan" };
      await salary.setBenefitPlan(salaryContext, benefitDraft, `demo-benefit-plan1-${suffix}`, at);
      const benefitTodos = await salary.generateBenefitTodos(salaryContext, `demo-benefit-todos-${suffix}`, at);
      const benefitPlan = await salary.setBenefitPlan(salaryContext, { ...benefitDraft, amountCents: "8000", reason: "Synthetic benefit execution plan" }, `demo-benefit-plan2-${suffix}`, at);
      const benefitDoc = await salary.createEvidenceDocument(salaryContext, "FINANCE_BENEFIT", `demo-benefit-doc-${suffix}`, at);
      const benefitAttachments = [];
      for (const purpose of ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT"]) {
        const reserved = await new PostgresFinanceAttachmentService(pool).reserve(salaryContext, benefitDoc.id, { purpose, originalFilename: `benefit-${purpose}.png`, declaredMediaType: "image/png", declaredSizeBytes: salaryBytes.length }, `demo-benefit-file-${purpose}-${suffix}`, at);
        await new PostgresFinanceAttachmentUploadService(pool, attachmentStore).upload(salaryContext, reserved.versionId, (async function* () { yield salaryBytes; })(), at);
        benefitAttachments.push(reserved.versionId);
      }
      await salary.confirmBenefit(salaryContext, { documentId: benefitDoc.id, expectedVersion: 1, todoId: benefitTodos[0].id, expectedPlanVersionId: benefitPlan.planVersionId, reason: "Synthetic benefit executed", attachmentVersionIds: benefitAttachments }, `demo-benefit-confirm-${suffix}`, at);
    }
    const groupLeaderRelationships = new PostgresGroupLeaderRelationshipService(pool);
    const teachingMentorRelationships = new PostgresTeachingMentorRelationshipService(pool);
    const adminPlanningMentorRelationships = new PostgresAdminPlanningMentorRelationshipService(pool);
    server = createApiServer({accountAccess:new PostgresAccountAccessService(pool),sessions:new PostgresSessionService(pool),personal:new PostgresPersonalReadService(pool),teaching:new PostgresTeachingReadService(pool),referrals:new PostgresReferralCreationService(pool),sentReferrals:new PostgresSentReferralReadService(pool),referralAcceptance:new PostgresReferralAcceptanceService(pool),referralLifecycle:new PostgresReferralLifecycleService(pool),refunds:new PostgresRefundSubmissionService(pool,attachmentStore),refundReviews:new PostgresRefundReviewService(pool,attachmentStore),refundReads:new PostgresRefundReadService(pool),reimbursements:new PostgresReimbursementSubmissionService(pool,attachmentStore),reimbursementReviews:new PostgresReimbursementReviewService(pool,attachmentStore),reimbursementReads:new PostgresReimbursementReadService(pool),reimbursementTransfers:new PostgresReimbursementTransferService(pool,attachmentStore),reimbursementReversals:new PostgresReimbursementReversalService(pool),selfPurchases:new PostgresSelfPurchaseService(pool,attachmentStore),selfPurchaseReversals:new PostgresSelfPurchaseReversalService(pool),selfPurchaseReads:new PostgresSelfPurchaseReadService(pool),companyFunds:new PostgresCompanyFundService(pool),financeDrafts:new PostgresFinanceDraftService(pool),financeAttachments:new PostgresFinanceAttachmentService(pool),financeAttachmentUploads:new PostgresFinanceAttachmentUploadService(pool,attachmentStore),financeAttachmentReads:new PostgresFinanceAttachmentReadService(pool,attachmentStore),withdrawals:new PostgresWithdrawalService(pool,attachmentStore,financeCrypto),withdrawalReads:new PostgresWithdrawalReadService(pool,financeCrypto),weeklyFees:new PostgresWeeklyFeeService(pool),venues:new PostgresVenueService(pool),venueReads:new PostgresVenueReadService(pool),venueBoards:new PostgresVenueBoardReadService(pool),benefitSourceFunds:new PostgresBenefitSourceFundDirectoryService(pool),benefitReads:new PostgresBenefitReadService(pool),salaryBenefits:salary,bonusProjects:new PostgresBonusProjectCatalogService(pool),projectBonusReads:new PostgresProjectBonusReadService(pool),cashWageTeacherDirectory:new PostgresCashWageTeacherDirectoryService(pool),cashWageReads:new PostgresCashWageReadService(pool),organizationRevenue:new PostgresOrganizationRevenueReadService(pool),groupLeaderRelationships,groupLeaderDirectory:new PostgresGroupLeaderDirectoryService(pool,groupLeaderRelationships),teachingMentorRelationships,adminPlanningMentorRelationships,personRelationshipAudit:new PostgresPersonRelationshipAuditService(pool),now:()=>at});
    await new Promise((resolve,reject) => { server.once('error',reject); server.listen(port,'127.0.0.1',resolve); });
    console.log(`合成演示API http://127.0.0.1:${port}；业务时钟固定为北京时间2026-09-21 12:00；正常退出时删除本次独立演示数据。`);
    console.log(`授课老师：13800000001；规划师：13800000002；总部财务：13800000003；管理员：13800000004；合成演示密码：${password}`);
} catch(error) {
  await close();
  throw error;
}
