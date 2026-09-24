import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresAdminPlanningMentorRelationshipService } from "../../../api/dist/postgres-admin-planning-mentor-relationship-service.js";
import { PostgresWeeklySettlementService } from "../../../api/dist/postgres-weekly-settlement-service.js";
import { createTestDatabase } from "../../../api/test/integration/postgres-test-database.mjs";
import { FullBackupSpool } from "../../dist/full-backup-spool.js";
import { readBackupSpoolDataset } from "../../dist/full-backup-spool-reader.js";
import { FullBackupTransformer } from "../../dist/full-backup-transformer.js";
import { PostgresFullBackupSource } from "../../dist/postgres-full-backup-source.js";

const connectionString = process.env.DATABASE_URL;
const at = new Date("2026-09-23T08:00:00.000Z");
const policy = {
  plannerBaseRateBasisPoints: 8000n, teacherBaseRateBasisPoints: 0n, planningMentorWeightBasisPoints: 2000n,
  groupLeaderRateBasisPoints: 0n, teachingMentorRateBasisPoints: 0n, venueRateBasisPoints: 0n,
  campusConsultationForPlannerRateBasisPoints: 0n, campusConsultationForTeacherRateBasisPoints: 0n,
  platformFinanceRateBasisPoints: 0n, regionFinanceRateBasisPoints: 0n,
  dynamicTiers: [{ label: "default", adjustmentBasisPoints: 0n }],
};
const json = (value) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);
const context = (personId) => ({ personId, subject: "SYSTEM_ADMIN", scope: "GLOBAL" });

const rows = async (root, spool, name) => {
  const dataset = spool.datasets.find((item) => item.tableName === name);
  assert.ok(dataset && !dataset.excluded, name);
  const result = [];
  for await (const row of readBackupSpoolDataset(join(root, "spool", spool.spoolId), dataset))
    result.push(Object.fromEntries(dataset.columns.map((column, index) => [column, row[index]])));
  return result;
};

test("真实 PostgreSQL：管理员规划导师 ADD 的 105 表 RAW 备份可非空回读且不泄露幂等键", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  const root = await mkdtemp(join(tmpdir(), "alliance-admin-planning-mentor-backup-pg-"));
  try {
    const ids = Object.fromEntries(["admin", "mentor", "planner", "region", "campus", "year", "period", "week", "student", "referral", "venue", "policy"].map((key) => [key, randomUUID()]));
    const iso = at.toISOString();
    for (const key of ["admin", "mentor", "planner"]) {
      await database.pool.query("INSERT INTO person(id,nickname,legal_name,status,created_at,updated_at) VALUES($1,$2,$2,'ACTIVE',$3,$3)", [ids[key], `admin-planning-${key}`, iso]);
      await database.pool.query("INSERT INTO user_account(id,person_id,phone_normalized,password_hash,login_status,created_at,updated_at) VALUES($1,$2,$3,'synthetic-hash','ACTIVE',$4,$4)", [randomUUID(), ids[key], `139${key === "admin" ? "00000001" : key === "mentor" ? "00000002" : "00000003"}`, iso]);
      await database.pool.query("INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status,created_at) VALUES($1,'PERSON',$2,$3,'ACTIVE',$4)", [randomUUID(), ids[key], `person:${key}:${ids[key]}`, iso]);
    }
    await database.pool.query("INSERT INTO role_assignment(id,person_id,subject_code,scope_type,scope_id,valid_from,created_by,created_at) VALUES($1,$2,'SYSTEM_ADMIN','GLOBAL',NULL,'2026-01-01',$2,$3),($4,$5,'PLANNING_MENTOR','SELF',NULL,'2026-01-01',$5,$3)", [randomUUID(), ids.admin, iso, randomUUID(), ids.mentor]);
    await database.pool.query("INSERT INTO organization_unit(id,unit_type,name,created_at) VALUES($1,'REGION','管理员规划分区',$3),($2,'CAMPUS','管理员规划校区',$3)", [ids.region, ids.campus, iso]);
    await database.pool.query("INSERT INTO teacher_profile(person_id,business_identity,employment_status,created_at,updated_at) VALUES($1,'ACADEMIC_PLANNER','ACTIVE',$2,$2)", [ids.planner, iso]);
    await database.pool.query("INSERT INTO person_campus_assignment(id,person_id,campus_id,region_id,valid_from,created_by,created_at) VALUES($1,$2,$3,$4,'2026-01-01',$2,$5)", [randomUUID(), ids.planner, ids.campus, ids.region, iso]);
    await database.pool.query("INSERT INTO venue(id,owner_person_id,name,status,default_for_owner,created_at,updated_at) VALUES($1,$2,'管理员规划场地','ACTIVE',true,$3,$3)", [ids.venue, ids.planner, iso]);
    await database.pool.query("INSERT INTO academic_year_plan(id,label,starts_on,ends_on,created_by,created_at) VALUES($1,'管理员规划学年','2026-09-01','2027-08-31',$2,$3)", [ids.year, ids.admin, iso]);
    await database.pool.query("INSERT INTO academic_period(id,academic_year_plan_id,label,starts_on,ends_on,created_at) VALUES($1,$2,'管理员规划秋季','2026-09-01','2027-01-31',$3)", [ids.period, ids.year, iso]);
    await database.pool.query("INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month,status,created_at) VALUES($1,$2,1,'REGULAR','2026-09-21','2026-09-27','2026-09-01','OPEN',$3)", [ids.week, ids.period, iso]);
    await database.pool.query("INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name,created_at,updated_at) VALUES($1,$2,'admin-planning-course','管理员规划学生',$3,$3)", [ids.student, ids.planner, iso]);
    await database.pool.query("INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,version,created_at,updated_at) VALUES($1,$2,$3,$3,'ACADEMIC_PLANNER','ACCEPTED',$4,1,$4,$4)", [ids.referral, ids.student, ids.planner, iso]);
    await database.pool.query("INSERT INTO referral_creation_snapshot(referral_case_id,source_subject,business_identity_version,campus_assignment_id,campus_id,class_type,collector_person_id,created_by,created_at) VALUES($1,'ACADEMIC_PLANNER',1,(SELECT id FROM person_campus_assignment WHERE person_id=$2),$3,'ONE_TO_ONE',$2,$2,$4)", [ids.referral, ids.planner, ids.campus, iso]);
    await database.pool.query("INSERT INTO rate_policy_version(id,version,effective_from,policy_json,reason,published_by,published_at) VALUES($1,1,'2026-09-01',$2::jsonb,'管理员规划导师备份',$3,$4)", [ids.policy, json(policy), ids.admin, iso]);
    await new PostgresWeeklySettlementService(database.pool).recordAndSettle(ids.planner, { referralCaseId: ids.referral, teachingWeekId: ids.week, venueId: ids.venue, settlementMonth: "2026-09-01", grossAmountCents: 1000n, expectedVersion: 0 }, "admin-planning-backup-fee");
    const service = new PostgresAdminPlanningMentorRelationshipService(database.pool);
    const preview = await service.preview(context(ids.admin), { action: "ADD", plannerPersonId: ids.planner, newMentorPersonId: ids.mentor, effectiveTeachingWeekId: ids.week, reason: "管理员补齐规划导师" }, at);
    const published = await service.publish(context(ids.admin), preview.previewId, "admin-planning-backup-add", at);
    assert.equal(published.action, "ADD");
    const spool = await new FullBackupSpool({ source: new PostgresFullBackupSource(database.pool), transformer: new FullBackupTransformer({ fingerprint: ({ domain, value }) => createHash("sha256").update(`${domain}:${value}`).digest("hex") }), tempRoot: join(root, "spool"), batchSize: 1 }).create();
    for (const tableName of ["admin_planning_mentor_relationship_change_preview", "admin_planning_mentor_relationship_change", "admin_planning_mentor_relationship_change_effect"])
      assert.ok((await rows(root, spool, tableName)).length > 0, tableName);
    const changes = await rows(root, spool, "admin_planning_mentor_relationship_change");
    assert.equal(changes.length, 1);
    assert.equal(changes[0].idempotency_key, undefined);
    assert.match(changes[0].idempotency_key_fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(changes).includes("admin-planning-backup-add"), false);
    const relationships = await rows(root, spool, "person_relationship");
    assert.ok(relationships.some((row) => row.id === published.resultRelationshipId && Object.hasOwn(row, "superseded_by_admin_planning_mentor_change_id")));
    const audits = await rows(root, spool, "audit_event");
    assert.ok(audits.some((row) => row.action_code === "PLANNING_MENTOR_RELATIONSHIP_ADDED_BY_ADMIN" && JSON.parse(row.before_json).sourceRelationship === null && JSON.parse(row.after_json).resultRelationship !== null));
  } finally { await rm(root, { recursive: true, force: true }); await database.close(); }
});
