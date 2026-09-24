import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DEFAULT_RATE_POLICY_VALUES } from "@teaching-research-alliance/domain";
import { PostgresPersonCampusAssignmentService } from "../../dist/postgres-person-campus-assignment-service.js";
import { PostgresPersonRelationshipAuditService } from "../../dist/postgres-person-relationship-audit-service.js";
import { PostgresWeeklySettlementService } from "../../dist/postgres-weekly-settlement-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const connectionString = process.env.DATABASE_URL;
const context = (personId) => ({ subject: "SYSTEM_ADMIN", personId, scope: "GLOBAL" });
const stringify = (value) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);

const seed = async (pool) => {
  const ids = Object.fromEntries(["admin","teacher","principalA","principalB","regionA","regionB","campusA","campusB"].map((key) => [key, randomUUID()]));
  for (const key of ["admin","teacher","principalA","principalB"]) await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1,$2,$2,'ACTIVE')", [ids[key], `p27-${key}`]);
  await pool.query("INSERT INTO organization_unit(id,unit_type,name) VALUES($1,'REGION','A'),($2,'REGION','B'),($3,'CAMPUS','A'),($4,'CAMPUS','B')", [ids.regionA,ids.regionB,ids.campusA,ids.campusB]);
  await pool.query("INSERT INTO teacher_profile(person_id,business_identity,region_id,campus_id,employment_status) VALUES($1,'TEACHING_TEACHER',$2,$3,'ACTIVE')", [ids.teacher,ids.regionA,ids.campusA]);
  await pool.query("INSERT INTO campus_region_assignment(campus_id,region_id,valid_from,created_by) VALUES($1,$2,'2026-01-01',$5),($3,$4,'2026-01-01',$5)", [ids.campusA,ids.regionA,ids.campusB,ids.regionB,ids.admin]);
  await pool.query("INSERT INTO person_campus_assignment(person_id,campus_id,region_id,valid_from,created_by) VALUES($1,$2,$3,'2026-01-01',$4)", [ids.teacher,ids.campusA,ids.regionA,ids.admin]);
  await pool.query("INSERT INTO role_assignment(person_id,subject_code,scope_type,scope_id,valid_from,valid_to,created_by) VALUES($1,'SYSTEM_ADMIN','GLOBAL',NULL,'2026-01-01',NULL,$1),($2,'CAMPUS_PRINCIPAL','CAMPUS',$4,'2026-01-01',NULL,$1),($3,'CAMPUS_PRINCIPAL','CAMPUS',$5,'2026-01-01',NULL,$1)", [ids.admin,ids.principalA,ids.principalA,ids.campusA,ids.campusB]);
  await pool.query("INSERT INTO person_relationship(teacher_id,relationship_type,related_person_id,valid_from,effective_scope,created_by) VALUES($1,'CAMPUS_PRINCIPAL',$2,'2026-01-01','CAMPUS',$3)", [ids.teacher,ids.principalA,ids.admin]);
  return ids;
};

const addSettledFee = async (pool, ids) => {
  const more = Object.fromEntries(["planner","group","mentor","hq","regionFinance","venue","year","period","week","student","referral"].map((key) => [key, randomUUID()]));
  for (const key of ["planner","group","mentor","hq","regionFinance"]) {
    await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1,$2,$2,'ACTIVE')", [more[key], `p27-fee-${key}`]);
    await pool.query("INSERT INTO user_account(person_id,phone_normalized,password_hash,login_status) VALUES($1,$2,'x','ACTIVE')", [more[key], `139${String(Object.keys(more).indexOf(key)).padStart(8,"0")}`]);
    await pool.query("INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('PERSON',$1,$2,'ACTIVE')", [more[key], `person:${more[key]}`]);
  }
  await pool.query("INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('PERSON',$1,$2,'ACTIVE')", [ids.teacher,`person:${ids.teacher}`]);
  await pool.query("INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('PERSON',$1,$2,'ACTIVE')", [ids.principalB,`person:${ids.principalB}`]);
  await pool.query("INSERT INTO teacher_profile(person_id,business_identity,region_id,campus_id,employment_status) VALUES($1,'ACADEMIC_PLANNER',$2,$3,'ACTIVE')", [more.planner,ids.regionA,ids.campusA]);
  await pool.query("INSERT INTO person_campus_assignment(person_id,campus_id,region_id,valid_from,created_by) VALUES($1,$2,$3,'2026-01-01',$4)", [more.planner,ids.campusA,ids.regionA,ids.admin]);
  await pool.query("INSERT INTO role_assignment(person_id,subject_code,scope_type,scope_id,valid_from,created_by) VALUES($1,'GROUP_LEADER','ASSOCIATED_TEACHERS',NULL,'2026-01-01',$6),($2,'TEACHING_MENTOR','MENTEES',NULL,'2026-01-01',$6),($3,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'2026-01-01',$6),($4,'REGION_FINANCE','REGION',$5,'2026-01-01',$6)", [more.group,more.mentor,more.hq,more.regionFinance,ids.regionA,ids.admin]);
  await pool.query("INSERT INTO role_assignment(person_id,subject_code,scope_type,scope_id,valid_from,created_by) VALUES($1,'REGION_FINANCE','REGION',$2,'2026-01-01',$3)", [ids.principalB,ids.regionB,ids.admin]);
  await pool.query("INSERT INTO person_relationship(teacher_id,relationship_type,related_person_id,valid_from,effective_scope,created_by) VALUES($1,'GROUP_LEADER',$2,'2026-01-01','CURRENT',$4),($1,'TEACHING_MENTOR',$3,'2026-01-01','CURRENT',$4)", [ids.teacher,more.group,more.mentor,ids.admin]);
  await pool.query("INSERT INTO venue(id,owner_person_id,name,status,default_for_owner) VALUES($1,$2,'fee venue','ACTIVE',true)", [more.venue,ids.teacher]);
  await pool.query("INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('VENUE',$1,$2,'ACTIVE'),('COMPANY',$3,$4,'ACTIVE'),('COMPANY',$5,$6,'ACTIVE')", [more.venue,`venue:${more.venue}`,ids.campusA,`company:${ids.campusA}`,ids.campusB,`company:${ids.campusB}`]);
  await pool.query("INSERT INTO academic_year_plan(id,label,starts_on,ends_on,created_by) VALUES($1,'P27','2026-01-01','2026-12-31',$2)", [more.year,ids.admin]);
  await pool.query("INSERT INTO academic_period(id,academic_year_plan_id,label,starts_on,ends_on) VALUES($1,$2,'P27','2026-01-01','2026-12-31')", [more.period,more.year]);
  await pool.query("INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month,status) VALUES($1,$2,1,'REGULAR','2026-09-24','2026-09-30','2026-09-01','OPEN')", [more.week,more.period]);
  await pool.query("INSERT INTO rate_policy_version(version,effective_from,policy_json,reason,published_by) VALUES(1,'2026-09-01',$1::jsonb,'p27',$2)", [stringify(DEFAULT_RATE_POLICY_VALUES),ids.admin]);
  await pool.query("INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name) VALUES($1,$2,'p27','p27')", [more.student,ids.teacher]);
  await pool.query("INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,version) VALUES($1,$2,$3,$4,'ACADEMIC_PLANNER','ACCEPTED','2026-09-01',1)", [more.referral,more.student,more.planner,ids.teacher]);
  const assignment=(await pool.query("SELECT id::text FROM person_campus_assignment WHERE person_id=$1",[more.planner])).rows[0];
  await pool.query("INSERT INTO referral_creation_snapshot(referral_case_id,source_subject,business_identity_version,campus_assignment_id,campus_id,class_type,collector_person_id,created_by,created_at) VALUES($1,'ACADEMIC_PLANNER',1,$2,$3,'ONE_TO_ONE',$4,$5,'2026-09-01')",[more.referral,assignment.id,ids.campusA,ids.teacher,ids.admin]);
  const fee=await new PostgresWeeklySettlementService(pool).recordAndSettle(ids.teacher,{referralCaseId:more.referral,teachingWeekId:more.week,venueId:more.venue,settlementMonth:"2026-09-01",grossAmountCents:100000n,expectedVersion:0},"p27-fee");
  return {...more,feeId:fee.fee.id};
};

test("真实 PostgreSQL：人员换校区、同校区校长修复、有限续接、陈旧/幂等、双源和审计约束", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  try {
    const ids = await seed(database.pool), service = new PostgresPersonCampusAssignmentService(database.pool), at = new Date("2026-09-23T00:00:00.000Z");
    const first = await service.preview(context(ids.admin), { personId: ids.teacher, targetCampusId: ids.campusB, effectiveFrom: "2026-09-24T00:00:00.000Z", reason: "换校区" }, at);
    assert.equal(first.targetRegionId, ids.regionB);
    const moved = await service.publish(context(ids.admin), first.previewId, "p27-move", at);
    assert.ok(moved.resultAssignmentId);
    const auditItem = (await new PostgresPersonRelationshipAuditService(database.pool).list(context(ids.admin), {
      personId: ids.teacher,
      relationshipType: "CAMPUS_PRINCIPAL",
    }, at)).items.find((item) => item.relationshipId === moved.resultCampusPrincipalRelationshipId);
    assert.deepEqual(auditItem?.sourceChange, { kind: "PERSON_CAMPUS_ASSIGNMENT_CHANGE", changeId: moved.changeId });
    const replay = await service.publish(context(ids.admin), first.previewId, "p27-move", at);
    assert.equal(replay.replay, true);
    await assert.rejects(service.publish(context(ids.admin), first.previewId, "p27-other-key", at), /PERSON_CAMPUS_PREVIEW_STALE/);
    await database.pool.query("UPDATE role_assignment SET valid_to='2026-10-01T00:00:00Z' WHERE person_id=$1 AND subject_code='CAMPUS_PRINCIPAL' AND scope_id=$2", [ids.principalA, ids.campusB]);
    await database.pool.query("INSERT INTO role_assignment(person_id,subject_code,scope_type,scope_id,valid_from,created_by) VALUES($1,'CAMPUS_PRINCIPAL','CAMPUS',$2,'2026-10-01T00:00:00Z',$3)", [ids.principalB, ids.campusB, ids.admin]);
    assert.equal((await database.pool.query("SELECT count(*)::int n FROM role_assignment WHERE subject_code='CAMPUS_PRINCIPAL' AND scope_id=$1 AND valid_from<='2026-10-01' AND (valid_to IS NULL OR valid_to>'2026-10-01')", [ids.campusB])).rows[0].n, 1);
    assert.equal((await database.pool.query("SELECT person_id::text FROM role_assignment WHERE subject_code='CAMPUS_PRINCIPAL' AND scope_id=$1 AND valid_from<='2026-10-01' AND (valid_to IS NULL OR valid_to>'2026-10-01')", [ids.campusB])).rows[0].person_id, ids.principalB);
    assert.equal((await database.pool.query("SELECT person_id::text FROM role_assignment WHERE subject_code='CAMPUS_PRINCIPAL' AND scope_id=$1 AND valid_from<=$2::timestamptz AND (valid_to IS NULL OR valid_to>$2::timestamptz) AND ($3::timestamptz IS NULL OR valid_to IS NULL OR valid_to>=$3::timestamptz)", [ids.campusB, "2026-10-01T00:00:00.000Z", null])).rows[0].person_id, ids.principalB);
    const repair = await service.preview(context(ids.admin), { personId: ids.teacher, targetCampusId: ids.campusB, effectiveFrom: "2026-10-01T00:00:00.000Z", reason: "校长修复" }, at);
    const repaired = await service.publish(context(ids.admin), repair.previewId, "p27-repair", at);
    assert.equal(repaired.resultAssignmentId, null);
    const finite = await service.preview(context(ids.admin), { personId: ids.teacher, targetCampusId: ids.campusA, effectiveFrom: "2026-10-10T00:00:00.000Z", effectiveTo: "2026-10-20T00:00:00.000Z", reason: "有限换校区" }, at);
    await service.publish(context(ids.admin), finite.previewId, "p27-finite", at);
    const assignments = await database.pool.query("SELECT campus_id::text,valid_from::text,valid_to::text FROM person_campus_assignment WHERE person_id=$1 ORDER BY valid_from", [ids.teacher]);
    assert.equal(assignments.rows.at(-1).campus_id, ids.campusB);
    const principals = await database.pool.query("SELECT related_person_id::text,valid_from::text FROM person_relationship WHERE teacher_id=$1 AND relationship_type='CAMPUS_PRINCIPAL' ORDER BY valid_from", [ids.teacher]);
    assert.equal(principals.rows.at(-1).related_person_id, ids.principalB);
    const audits = await database.pool.query("SELECT count(*)::int n FROM audit_event WHERE action_code='PERSON_CAMPUS_ASSIGNMENT_CHANGED'");
    assert.equal(audits.rows[0].n, 3);
    await assert.rejects(database.pool.query("UPDATE campus_region_assignment SET valid_to='2026-09-25' WHERE campus_id=$1", [ids.campusB]), /PERSON_CAMPUS_REGION_ASSIGNMENT_COVERAGE_REQUIRED/);
  } finally { await database.close(); }
});

test("真实 PostgreSQL：已结算费用重算追加快照/effect，退款排除且关系分配不变", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database=await createTestDatabase(connectionString);
  try {
    const ids=await seed(database.pool), extra=await addSettledFee(database.pool,ids), service=new PostgresPersonCampusAssignmentService(database.pool), at=new Date("2026-09-23T00:00:00.000Z");
    const before=await database.pool.query("SELECT count(*)::int n FROM weekly_fee_allocation_snapshot WHERE weekly_fee_entry_id=$1",[extra.feeId]);
    const relationships=await database.pool.query("SELECT teacher_id::text,relationship_type,related_person_id::text,valid_from::text,valid_to::text FROM person_relationship WHERE teacher_id=$1::uuid AND relationship_type IN ('GROUP_LEADER','TEACHING_MENTOR','PLANNING_MENTOR') ORDER BY teacher_id,relationship_type",[ids.teacher]);
    const venue=await database.pool.query("SELECT owner_person_id::text,name,status,default_for_owner FROM venue WHERE id=$1::uuid",[extra.venue]);
    const preview=await service.preview(context(ids.admin),{personId:ids.teacher,targetCampusId:ids.campusB,effectiveFrom:"2026-09-23T00:00:00.000Z",reason:"费用组织归属"},at);
    assert.equal(preview.consideredFeeCount,1); assert.equal(preview.excludedRefundCount,0); assert.equal(preview.organizationImpact.recordedGrossRevenueCents,"100000"); assert.equal(preview.organizationImpact.refundedGrossRevenueCents,"0"); assert.equal(preview.organizationImpact.effectiveGrossRevenueCents,"100000"); assert.ok(preview.accountDeltas.length>0);
    const published=await service.publish(context(ids.admin),preview.previewId,"p27-fee-change",at);
    assert.equal(published.postingStatus,"POSTED"); assert.equal(published.changedFeeCount,1);
    assert.equal((await database.pool.query("SELECT count(*)::int n FROM person_campus_assignment_change_effect")).rows[0].n,1);
    assert.equal((await database.pool.query("SELECT count(*)::int n FROM weekly_fee_allocation_snapshot WHERE weekly_fee_entry_id=$1",[extra.feeId])).rows[0].n,before.rows[0].n+1);
    const run=await database.pool.query("SELECT status,ledger_event_id::text FROM settlement_calculation_run WHERE request_key LIKE 'person-campus-change:%'");
    assert.equal(run.rows.length,1); assert.equal(run.rows[0].status,"POSTED"); assert.ok(run.rows[0].ledger_event_id);
    assert.deepEqual((await database.pool.query("SELECT teacher_id::text,relationship_type,related_person_id::text,valid_from::text,valid_to::text FROM person_relationship WHERE teacher_id=$1::uuid AND relationship_type IN ('GROUP_LEADER','TEACHING_MENTOR','PLANNING_MENTOR') ORDER BY teacher_id,relationship_type",[ids.teacher])).rows,relationships.rows);
    assert.deepEqual((await database.pool.query("SELECT owner_person_id::text,name,status,default_for_owner FROM venue WHERE id=$1::uuid",[extra.venue])).rows,venue.rows);
  } finally { await database.close(); }
});

test("真实 PostgreSQL：退款费用在组织预览中排除", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database=await createTestDatabase(connectionString);
  try {
    const ids=await seed(database.pool), extra=await addSettledFee(database.pool,ids), at=new Date("2026-09-23T00:00:00.000Z"), documentId=randomUUID();
    const snapshot=(await database.pool.query("SELECT id::text,snapshot_json FROM weekly_fee_allocation_snapshot WHERE weekly_fee_entry_id=$1 ORDER BY sequence_no DESC LIMIT 1",[extra.feeId])).rows[0];
    await database.pool.query("INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at) VALUES($1,$2,'REFUND','REFUNDED',1,$3,$3)",[documentId,ids.teacher,at.toISOString()]);
    await database.pool.query("ALTER TABLE weekly_fee_refund_effect DISABLE TRIGGER USER");
    try { await database.pool.query("INSERT INTO weekly_fee_refund_effect(weekly_fee_entry_id,finance_document_id,allocation_snapshot_id,source_weekly_fee_version,gross_amount_cents,snapshot_json,created_at) SELECT $1,$2,$3,version,gross_amount_cents,$4::jsonb,$5 FROM weekly_fee_entry WHERE id=$1",[extra.feeId,documentId,snapshot.id,JSON.stringify(snapshot.snapshot_json),at.toISOString()]); }
    finally { await database.pool.query("ALTER TABLE weekly_fee_refund_effect ENABLE TRIGGER USER"); }
    const preview=await new PostgresPersonCampusAssignmentService(database.pool).preview(context(ids.admin),{personId:ids.teacher,targetCampusId:ids.campusB,effectiveFrom:"2026-09-23T00:00:00.000Z",reason:"退款排除"},at);
    assert.equal(preview.consideredFeeCount,1); assert.equal(preview.excludedRefundCount,1); assert.equal(preview.changedFeeCount,0); assert.equal(preview.organizationImpact.refundedGrossRevenueCents,"100000"); assert.equal(preview.organizationImpact.effectiveGrossRevenueCents,"0");
  } finally { await database.close(); }
});

test("真实 PostgreSQL：金额不变但组织上下文变更仍追加无余额结算快照和 effect", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  try {
    const ids = await seed(database.pool), extra = await addSettledFee(database.pool, ids);
    const service = new PostgresPersonCampusAssignmentService(database.pool), at = new Date("2026-09-23T00:00:00.000Z");
    await database.pool.query("UPDATE campus_region_assignment SET region_id=$2::uuid WHERE campus_id=$1::uuid", [ids.campusB, ids.regionA]);
    const previous = await database.pool.query("SELECT count(*)::int n FROM weekly_fee_allocation_snapshot WHERE weekly_fee_entry_id=$1::uuid", [extra.feeId]);
    const preview = await service.preview(context(ids.admin), { personId: ids.teacher, targetCampusId: ids.campusB, effectiveFrom: "2026-09-23T00:00:00.000Z", reason: "同分区组织归属" }, at);
    assert.equal(preview.changedFeeCount, 0);
    assert.equal(preview.organizationImpact.targetRegionId, ids.regionA);
    const result = await service.publish(context(ids.admin), preview.previewId, "p27-context-only", at);
    assert.equal(result.postingStatus, "NO_BALANCE_CHANGE");
    assert.equal(result.changedFeeCount, 0);
    const run = await database.pool.query("SELECT status,ledger_event_id FROM settlement_calculation_run WHERE request_key LIKE 'person-campus-change:%'");
    assert.deepEqual(run.rows, [{ status: "NO_BALANCE_CHANGE", ledger_event_id: null }]);
    assert.equal((await database.pool.query("SELECT count(*)::int n FROM weekly_fee_allocation_snapshot WHERE weekly_fee_entry_id=$1::uuid", [extra.feeId])).rows[0].n, previous.rows[0].n + 1);
    assert.equal((await database.pool.query("SELECT count(*)::int n FROM person_campus_assignment_change_effect")).rows[0].n, 1);
    const latest = await database.pool.query("SELECT context_json FROM weekly_fee_allocation_snapshot WHERE weekly_fee_entry_id=$1::uuid ORDER BY sequence_no DESC LIMIT 1", [extra.feeId]);
    assert.equal(latest.rows[0].context_json.organization.receiverCampusAssignment.campus_id, ids.campusB);
  } finally { await database.close(); }
});

test("真实 PostgreSQL：两个冻结预览并发发布时只有一个变更生效", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  try {
    const ids = await seed(database.pool);
    const service = new PostgresPersonCampusAssignmentService(database.pool);
    const at = new Date("2026-09-23T00:00:00.000Z");
    const draft = { personId: ids.teacher, targetCampusId: ids.campusB, effectiveFrom: "2026-09-24T00:00:00.000Z", reason: "并发换校区" };
    const [first, second] = await Promise.all([
      service.preview(context(ids.admin), draft, at),
      service.preview(context(ids.admin), draft, at),
    ]);
    const results = await Promise.allSettled([
      service.publish(context(ids.admin), first.previewId, "p27-concurrent-a", at),
      service.publish(context(ids.admin), second.previewId, "p27-concurrent-b", at),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await database.pool.query("SELECT count(*)::int n FROM person_campus_assignment_change WHERE person_id=$1", [ids.teacher])).rows[0].n, 1);
    const rejection = results.find((result) => result.status === "rejected");
    assert.ok(rejection && /PERSON_CAMPUS_(PREVIEW_STALE|ASSIGNMENT_NO_CHANGE)/.test(String(rejection.reason)));
  } finally { await database.close(); }
});

test("真实 PostgreSQL：撤销全局管理员后不能以同键重放既有发布", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  try {
    const ids = await seed(database.pool);
    const service = new PostgresPersonCampusAssignmentService(database.pool);
    const at = new Date("2026-09-23T00:00:00.000Z");
    const preview = await service.preview(context(ids.admin), { personId: ids.teacher, targetCampusId: ids.campusB, effectiveFrom: "2026-09-24T00:00:00.000Z", reason: "撤权重放" }, at);
    await service.publish(context(ids.admin), preview.previewId, "p27-revoked-replay", at);
    await database.pool.query("UPDATE role_assignment SET valid_to='2026-09-22T00:00:00.000Z' WHERE person_id=$1::uuid AND subject_code='SYSTEM_ADMIN'", [ids.admin]);
    await assert.rejects(service.publish(context(ids.admin), preview.previewId, "p27-revoked-replay", at), /FORBIDDEN_SCOPE/);
  } finally { await database.close(); }
});

test("真实 PostgreSQL：目标校长和校区分区职责必须覆盖完整的申请区间", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  try {
    const ids = await seed(database.pool);
    const service = new PostgresPersonCampusAssignmentService(database.pool);
    const at = new Date("2026-09-23T00:00:00.000Z");
    const draft = { personId: ids.teacher, targetCampusId: ids.campusB, effectiveFrom: "2026-09-24T00:00:00.000Z", reason: "边界校验" };
    await database.pool.query("UPDATE role_assignment SET valid_to='2026-09-25T00:00:00.000Z' WHERE person_id=$1::uuid AND subject_code='CAMPUS_PRINCIPAL' AND scope_id=$2::uuid", [ids.principalA, ids.campusB]);
    await assert.rejects(service.preview(context(ids.admin), draft, at), /PERSON_CAMPUS_TARGET_PRINCIPAL_INVALID/);
    await database.pool.query("UPDATE role_assignment SET valid_to=NULL WHERE person_id=$1::uuid AND subject_code='CAMPUS_PRINCIPAL' AND scope_id=$2::uuid", [ids.principalA, ids.campusB]);
    await database.pool.query("UPDATE campus_region_assignment SET valid_to='2026-09-25T00:00:00.000Z' WHERE campus_id=$1::uuid", [ids.campusB]);
    await assert.rejects(service.preview(context(ids.admin), draft, at), /PERSON_CAMPUS_TARGET_REGION_NOT_UNIQUE/);
  } finally { await database.close(); }
});
