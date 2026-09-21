import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DEFAULT_RATE_POLICY_VALUES } from "@teaching-research-alliance/domain";
import { createTestDatabase } from "../apps/api/test/integration/postgres-test-database.mjs";
import { createApiServer, LocalAttachmentStore, PostgresFinanceAttachmentUploadService, PostgresFinanceAttachmentReadService, PostgresSessionService, PostgresPersonalReadService, PostgresTeachingReadService, PostgresReferralCreationService, PostgresSentReferralReadService, PostgresReferralAcceptanceService, PostgresReferralLifecycleService, PostgresFinanceDraftService, PostgresFinanceAttachmentService, PostgresWeeklyFeeService, hashPassword } from "../apps/api/dist/main.js";

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
    "admin", "planner", "planningMentor", "groupLeader", "teachingMentor", "teacher", "teacherB", "platformFinance", "regionFinance",
    "region", "campus", "year", "period", "week", "student", "referral", "venue"
  ].map((key) => [key, randomUUID()]));
    for (const [key, id] of Object.entries(ids)) {
      if (["region", "campus", "year", "period", "week", "student", "referral", "venue"].includes(key)) continue;
      await addPerson(pool, id, `结算测试-${key}-${suffix}`);
    }
    await pool.query(
      `INSERT INTO organization_unit (id, unit_type, name)
       VALUES ($1::uuid, 'REGION', $2), ($3::uuid, 'CAMPUS', $4)`,
      [ids.region, `测试分区-${suffix}`, ids.campus, `测试校区-${suffix}`]
    );
    await pool.query(
      `INSERT INTO teacher_profile (person_id, business_identity, region_id, campus_id, employment_status)
       VALUES ($1::uuid, 'ACADEMIC_PLANNER', $2::uuid, $3::uuid, 'ACTIVE'),
              ($4::uuid, 'TEACHING_TEACHER', $2::uuid, $3::uuid, 'ACTIVE'),
              ($5::uuid, 'TEACHING_TEACHER', $2::uuid, $3::uuid, 'ACTIVE')`,
      [ids.planner, ids.region, ids.campus, ids.teacher, ids.teacherB]
    );
    await pool.query(
      `INSERT INTO person_campus_assignment (person_id, campus_id, region_id, valid_from, created_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::uuid),
              ($6::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::uuid),
              ($7::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::uuid)`,
      [ids.planner, ids.campus, ids.region, validFrom, ids.admin, ids.teacher, ids.teacherB]
    );
    await addRole(pool, ids.planner, "ACADEMIC_PLANNER", "CAMPUS", ids.campus, ids.admin);
    await addRole(pool, ids.planningMentor, "PLANNING_MENTOR", "ASSOCIATED_TEACHERS", ids.planner, ids.admin);
    await addRole(pool, ids.groupLeader, "GROUP_LEADER", "ASSOCIATED_TEACHERS", ids.teacher, ids.admin);
    await addRole(pool, ids.teachingMentor, "TEACHING_MENTOR", "ASSOCIATED_TEACHERS", ids.teacher, ids.admin);
    await addRole(pool, ids.teacher, "TEACHING_TEACHER", "SELF", ids.teacher, ids.admin);
    await addRole(pool, ids.teacherB, "TEACHING_TEACHER", "SELF", ids.teacherB, ids.admin);
    await addRole(pool, ids.platformFinance, "HEADQUARTERS_FINANCE", "GLOBAL", null, ids.admin);
    await addRole(pool, ids.regionFinance, "REGION_FINANCE", "REGION", ids.region, ids.admin);
    await addRelationship(pool, ids.planner, "PLANNING_MENTOR", ids.planningMentor);
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
    const password = "Local-demo-only-2026";
    const hash = await hashPassword(password);
    for (const [personId, phone] of [[ids.teacher,"13800000001"],[ids.planner,"13800000002"]]) {
      await pool.query("INSERT INTO user_account(person_id,phone_normalized,password_hash,login_status) VALUES ($1,$2,$3,'ACTIVE')", [personId,phone,hash]);
    }
    await pool.query("UPDATE person SET nickname='演示授课老师' WHERE id=$1", [ids.teacher]);
    await pool.query("UPDATE person SET nickname='演示规划师' WHERE id=$1", [ids.planner]);
    attachmentRoot=await mkdtemp(join(tmpdir(),"alliance-demo-attachments-"));
    const attachmentStore=await LocalAttachmentStore.create(attachmentRoot,fileURLToPath(new URL("../",import.meta.url)));
    server = createApiServer({sessions:new PostgresSessionService(pool),personal:new PostgresPersonalReadService(pool),teaching:new PostgresTeachingReadService(pool),referrals:new PostgresReferralCreationService(pool),sentReferrals:new PostgresSentReferralReadService(pool),referralAcceptance:new PostgresReferralAcceptanceService(pool),referralLifecycle:new PostgresReferralLifecycleService(pool),financeDrafts:new PostgresFinanceDraftService(pool),financeAttachments:new PostgresFinanceAttachmentService(pool),financeAttachmentUploads:new PostgresFinanceAttachmentUploadService(pool,attachmentStore),financeAttachmentReads:new PostgresFinanceAttachmentReadService(pool,attachmentStore),weeklyFees:new PostgresWeeklyFeeService(pool),now:()=>at});
    await new Promise((resolve,reject) => { server.once('error',reject); server.listen(port,'127.0.0.1',resolve); });
    console.log(`合成演示API http://127.0.0.1:${port}；业务时钟固定为北京时间2026-09-21 12:00；正常退出时删除本次独立演示数据。`);
    console.log(`授课老师：13800000001；规划师：13800000002；合成演示密码：${password}`);
} catch(error) {
  await close();
  throw error;
}
