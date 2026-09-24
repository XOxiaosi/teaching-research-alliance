import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_RATE_POLICY_VALUES } from "@teaching-research-alliance/domain";
import { PostgresCampusRegionAssignmentService } from "../../../api/dist/postgres-campus-region-assignment-service.js";
import { PostgresWeeklySettlementService } from "../../../api/dist/postgres-weekly-settlement-service.js";
import { createTestDatabase } from "../../../api/test/integration/postgres-test-database.mjs";
import { FullBackupSpool } from "../../dist/full-backup-spool.js";
import { readBackupSpoolDataset } from "../../dist/full-backup-spool-reader.js";
import { FullBackupTransformer } from "../../dist/full-backup-transformer.js";
import { PostgresFullBackupSource } from "../../dist/postgres-full-backup-source.js";

const connectionString = process.env.DATABASE_URL;
const at = new Date("2026-09-23T00:00:00.000Z");
const context = (personId) => ({ subject: "SYSTEM_ADMIN", personId, scope: "GLOBAL" });
const json = (value) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);

const seed = async (pool) => {
  const ids = Object.fromEntries(["admin", "teacher", "regionA", "regionB", "campusA", "venue", "year", "period", "week", "student", "referral", "policy"].map((key) => [key, randomUUID()]));
  for (const key of ["admin", "teacher"]) await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1,$2,$2,'ACTIVE')", [ids[key], `c2-backup-${key}`]);
  await pool.query("INSERT INTO organization_unit(id,unit_type,name) VALUES($1,'REGION','C2-A'),($2,'REGION','C2-B'),($3,'CAMPUS','C2-A')", [ids.regionA, ids.regionB, ids.campusA]);
  await pool.query("INSERT INTO teacher_profile(person_id,business_identity,region_id,campus_id,employment_status) VALUES($1,'TEACHING_TEACHER',$2,$3,'ACTIVE')", [ids.teacher, ids.regionA, ids.campusA]);
  await pool.query("INSERT INTO campus_region_assignment(campus_id,region_id,valid_from,created_by) VALUES($1,$2,'2026-01-01',$3)", [ids.campusA, ids.regionA, ids.admin]);
  await pool.query("INSERT INTO person_campus_assignment(person_id,campus_id,region_id,valid_from,created_by) VALUES($1,$2,$3,'2026-01-01',$4)", [ids.teacher, ids.campusA, ids.regionA, ids.admin]);
  await pool.query("INSERT INTO role_assignment(person_id,subject_code,scope_type,scope_id,valid_from,created_by) VALUES($1,'SYSTEM_ADMIN','GLOBAL',NULL,'2026-01-01',$1)", [ids.admin]);
  await pool.query("INSERT INTO venue(id,owner_person_id,name,status,default_for_owner) VALUES($1,$2,'c2 venue','ACTIVE',true)", [ids.venue, ids.teacher]);
  await pool.query("INSERT INTO academic_year_plan(id,label,starts_on,ends_on,created_by) VALUES($1,'C2','2026-01-01','2026-12-31',$2)", [ids.year, ids.admin]);
  await pool.query("INSERT INTO academic_period(id,academic_year_plan_id,label,starts_on,ends_on) VALUES($1,$2,'C2','2026-01-01','2026-12-31')", [ids.period, ids.year]);
  await pool.query("INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month,status) VALUES($1,$2,1,'REGULAR','2026-09-24','2026-09-30','2026-09-01','OPEN')", [ids.week, ids.period]);
  await pool.query("INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('PERSON',$1,$2,'ACTIVE')", [ids.teacher, `person:${ids.teacher}`]);
  const policy = { ...DEFAULT_RATE_POLICY_VALUES, groupLeaderRateBasisPoints: 0n, teachingMentorRateBasisPoints: 0n, planningMentorWeightBasisPoints: 0n, venueRateBasisPoints: 0n, campusConsultationForPlannerRateBasisPoints: 0n, campusConsultationForTeacherRateBasisPoints: 0n, platformFinanceRateBasisPoints: 0n, regionFinanceRateBasisPoints: 0n };
  await pool.query("INSERT INTO rate_policy_version(id,version,effective_from,policy_json,reason,published_by) VALUES($1,1,'2026-09-01',$2::jsonb,'c2 backup',$3)", [ids.policy, json(policy), ids.admin]);
  await pool.query("INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name) VALUES($1,$2,'c2','c2')", [ids.student, ids.teacher]);
  await pool.query("INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,version) VALUES($1,$2,$3,$3,'ACADEMIC_PLANNER','ACCEPTED','2026-09-01',1)", [ids.referral, ids.student, ids.teacher]);
  await pool.query("INSERT INTO referral_creation_snapshot(referral_case_id,source_subject,business_identity_version,campus_assignment_id,campus_id,class_type,collector_person_id,created_by,created_at) SELECT $1,'ACADEMIC_PLANNER',1,id,$2,'ONE_TO_ONE',$3,$3,'2026-09-01' FROM person_campus_assignment WHERE person_id=$3", [ids.referral, ids.campusA, ids.teacher]);
  await new PostgresWeeklySettlementService(pool).recordAndSettle(ids.teacher, { referralCaseId: ids.referral, teachingWeekId: ids.week, venueId: ids.venue, settlementMonth: "2026-09-01", grossAmountCents: 1000n, expectedVersion: 0 }, "c2-backup-fee");
  return ids;
};

const rows = async (root, spool, tableName) => {
  const dataset = spool.datasets.find((item) => item.tableName === tableName);
  assert.ok(dataset && !dataset.excluded, tableName);
  const output = [];
  for await (const row of readBackupSpoolDataset(join(root, "spool", spool.spoolId), dataset)) output.push(Object.fromEntries(dataset.columns.map((column, index) => [column, row[index]])));
  return output;
};

test("真实 PostgreSQL：校区大区归属纠正的 105 表备份回读完整且不泄露幂等键", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  const root = await mkdtemp(join(tmpdir(), "alliance-c2-campus-region-backup-pg-"));
  try {
    const ids = await seed(database.pool);
    const service = new PostgresCampusRegionAssignmentService(database.pool);
    const preview = await service.preview(context(ids.admin), { campusId: ids.campusA, targetRegionId: ids.regionB, effectiveFrom: "2026-09-23T00:00:00.000Z", reason: "备份验收校区大区纠正" }, at);
    assert.equal(preview.consideredFeeCount, 1);
    assert.equal(preview.organizationImpact.recordedGrossRevenueCents, "1000");
    assert.equal(preview.organizationImpact.refundedGrossRevenueCents, "0");
    const published = await service.publish(context(ids.admin), preview.previewId, "c2-backup-idempotency", at);
    assert.equal(published.consideredFeeCount, 1);
    assert.equal((await database.pool.query("SELECT count(*)::int n FROM campus_region_assignment_settlement_effect WHERE change_id=$1", [published.changeId])).rows[0].n, 1);
    assert.equal((await database.pool.query("SELECT count(*)::int n FROM weekly_fee_allocation_snapshot")).rows[0].n, 2);
    const spool = await new FullBackupSpool({ source: new PostgresFullBackupSource(database.pool), transformer: new FullBackupTransformer({ fingerprint: ({ domain, value }) => createHash("sha256").update(`${domain}:${value}`).digest("hex") }), tempRoot: join(root, "spool"), batchSize: 1 }).create();
    assert.equal(spool.datasets.length, 105);
    for (const tableName of ["campus_region_assignment_change_preview", "campus_region_assignment_change", "campus_region_assignment_person_effect", "campus_region_assignment_settlement_effect"]) assert.ok((await rows(root, spool, tableName)).length > 0, tableName);
    const changes = await rows(root, spool, "campus_region_assignment_change");
    assert.equal(changes.length, 1);
    assert.equal(changes[0].idempotency_key, undefined);
    assert.match(changes[0].idempotency_key_fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(changes).includes("c2-backup-idempotency"), false);
    assert.ok(JSON.parse(changes[0].before_json).campusRegionAssignment);
    assert.ok(JSON.parse(changes[0].after_json).campusRegionAssignment);
    const campuses = await rows(root, spool, "campus_region_assignment");
    assert.ok(campuses.some((row) => row.superseded_by_campus_region_change_id === published.changeId));
    assert.ok(campuses.some((row) => row.campus_region_change_id === published.changeId));
    const assignments = await rows(root, spool, "person_campus_assignment");
    assert.ok(assignments.some((row) => row.campus_region_change_id === published.changeId));
    assert.ok(assignments.some((row) => row.superseded_by_campus_region_change_id === published.changeId));
    const people = await rows(root, spool, "campus_region_assignment_person_effect");
    assert.ok(JSON.parse(people[0].before_json).personId);
    assert.ok(JSON.parse(people[0].after_json).regionId);
    const effects = await rows(root, spool, "campus_region_assignment_settlement_effect");
    assert.ok(JSON.parse(effects[0].delta_json).entries);
  } finally { await rm(root, { recursive: true, force: true }); await database.close(); }
});
