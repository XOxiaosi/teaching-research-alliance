import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTestDatabase } from "./postgres-test-database.mjs";
import { PostgresAccountAccessService } from "../../dist/main.js";
import { PostgresPersonRelationshipAuditService } from "../../dist/postgres-person-relationship-audit-service.js";
import { PostgresPlanningMentorRelationshipService } from "../../dist/postgres-planning-mentor-relationship-service.js";

const connectionString = process.env.DATABASE_URL;
const at = new Date("2026-09-29T01:00:00.000Z");
const iso = at.toISOString();

test("关系审计真实PG：关系事实、缺关系分润项、状态筛选、分页和隐私", async () => {
  const database = await createTestDatabase(connectionString);
  const access = new PostgresAccountAccessService(database.pool);
  try {
    const owner = await access.register({ nickname: "审计管理员", legalName: "审计管理员", phoneNormalized: "13800009901", password: "audit-owner" }, at);
    const teacher = await access.register({ nickname: "授课成员", legalName: "授课成员", phoneNormalized: "13800009902", password: "audit-teacher" }, at);
    const planner = await access.register({ nickname: "规划成员", legalName: "规划成员", phoneNormalized: "13800009903", password: "audit-planner" }, at);
    const related = await access.register({ nickname: "关系对象", legalName: "关系对象", phoneNormalized: "13800009904", password: "audit-related" }, at);
    const missingTeacher = await access.register({ nickname: "缺组长成员", legalName: "缺组长成员", phoneNormalized: "13800009905", password: "audit-missing" }, at);
    await database.pool.query(`INSERT INTO role_assignment(person_id,subject_code,scope_type,scope_id,valid_from,created_by,created_at) VALUES($1,'SYSTEM_OWNER','GLOBAL',NULL,$5,$1,$5),($2,'TEACHING_TEACHER','SELF',NULL,$5,$1,$5),($3,'ACADEMIC_PLANNER','SELF',NULL,$5,$1,$5),($4,'TEACHING_MENTOR','MENTEES',NULL,$5,$1,$5),($4,'GROUP_LEADER','ASSOCIATED_TEACHERS',NULL,$5,$1,$5),($4,'PLANNING_MENTOR','SELF',NULL,$5,$1,$5),($4,'CAMPUS_PRINCIPAL','CAMPUS',NULL,$5,$1,$5)`, [owner.session.personId, teacher.session.personId, planner.session.personId, related.session.personId, iso]);
    await database.pool.query("INSERT INTO teacher_profile(person_id,business_identity,employment_status) VALUES($1,'TEACHING_TEACHER','ACTIVE'),($2,'ACADEMIC_PLANNER','ACTIVE'),($3,'TEACHING_TEACHER','ACTIVE')", [teacher.session.personId, planner.session.personId, missingTeacher.session.personId]);
    const regionId = randomUUID();
    const campusId = randomUUID();
    await database.pool.query("INSERT INTO organization_unit(id,unit_type,name) VALUES($1,'REGION',$2),($3,'CAMPUS',$4)", [regionId, `audit-region-${regionId}`, campusId, `audit-campus-${campusId}`]);
    await database.pool.query("INSERT INTO person_campus_assignment(person_id,campus_id,region_id,valid_from,created_by) VALUES($1,$2,$3,$4,$5)", [missingTeacher.session.personId, campusId, regionId, iso, owner.session.personId]);
    await database.pool.query("INSERT INTO rate_policy_version(version,effective_from,policy_json,reason,published_by) VALUES(1,'2026-01-01',$1::jsonb,'audit-live',$2)", [JSON.stringify({ groupLeaderRateBasisPoints: 100, teachingMentorRateBasisPoints: 100 }), owner.session.personId]);
    await database.pool.query("INSERT INTO academic_year_plan(id,label,starts_on,ends_on,created_by) VALUES($1,'audit-year','2026-01-01','2026-12-31',$2)", ['00000000-0000-4000-8000-000000000010', owner.session.personId]);
    await database.pool.query("INSERT INTO academic_period(id,academic_year_plan_id,label,starts_on,ends_on) VALUES($1,$2,'audit-period','2026-01-01','2026-12-31')", ['00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000010']);
    await database.pool.query("INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month,status) VALUES($1,$2,1,'REGULAR','2026-09-28','2026-10-04','2026-09-01','OPEN'),($3,$2,2,'SUMMER_SPECIAL','2026-10-05','2026-10-11','2026-10-01','OPEN')", ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000002']);
    const future = new Date(at.getTime() + 86400000).toISOString();
    const ended = new Date(at.getTime() - 86400000).toISOString();
    await database.pool.query(`INSERT INTO person_relationship(teacher_id,relationship_type,related_person_id,valid_from,valid_to,effective_scope,created_by,created_at) VALUES
      ($1,'GROUP_LEADER',$4,$5,NULL,'REGULAR_WEEK:00000000-0000-4000-8000-000000000001',$1,$5),($1,'TEACHING_MENTOR',$4,$6,NULL,'MENTEES',$1,$5),($3,'CAMPUS_PRINCIPAL',$4,$7,$8,'CAMPUS',$1,$5),($2,'GROUP_LEADER',$4,$5,NULL,'SPECIAL_PERIOD',$1,$5)`,
      [teacher.session.personId, planner.session.personId, related.session.personId, related.session.personId, iso, future, ended, iso]);
    await database.pool.query("UPDATE person SET status='INACTIVE' WHERE id=$1", [related.session.personId]);
    const service = new PostgresPersonRelationshipAuditService(database.pool);
    const context = { personId: owner.session.personId, subject: "SYSTEM_OWNER", scope: "GLOBAL" };
    const page = await service.list(context, { limit: 2 }, at);
    assert.equal(page.snapshotAt, iso);
    assert.match(page.dataVersion, new RegExp(`^audit-v1:${iso}:`));
    assert.equal(page.items.length, 2);
    assert.ok(page.nextCursor);
    assert.equal(JSON.stringify(page).includes("phone"), false);
    assert.equal(JSON.stringify(page).includes("balance"), false);
    const second = await service.list(context, { limit: 2, cursor: page.nextCursor }, new Date(at.getTime() + 86400000));
    assert.equal(second.snapshotAt, iso);
    assert.equal(second.dataVersion, page.dataVersion);
    const mutableCursorPage = await service.list(context, { limit: 2 }, at);
    await database.pool.query("INSERT INTO person_relationship(teacher_id,relationship_type,related_person_id,valid_from,effective_scope,created_by,created_at) VALUES($1,'GROUP_LEADER',$2,$3,'REGULAR_WEEK:00000000-0000-4000-8000-000000000002',$4,$3)", [missingTeacher.session.personId, related.session.personId, future, owner.session.personId]);
    const afterLateInsert = await service.list(context, { limit: 2, cursor: mutableCursorPage.nextCursor }, at);
    assert.equal(afterLateInsert.snapshotAt, iso);
    assert.ok(second.items.length >= 1);
    assert.ok(second.items.every((item) => item.auditItemId !== page.items[0].auditItemId && item.auditItemId !== page.items[1].auditItemId));
    await assert.rejects(() => service.list(context, { limit: 2, status: "FUTURE", cursor: page.nextCursor }, at), /INVALID_INPUT/);
    assert.equal((await service.list(context, { status: "FUTURE" }, at)).items.length, 1);
    assert.equal((await service.list(context, { status: "ENDED" }, at)).items.length, 1);
    assert.ok((await service.list(context, { status: "ANOMALOUS" }, at)).items.length >= 1);
    const special = (await service.list(context, { repairability: "REQUIRES_SPECIAL_PERIOD_SCOPE" }, at)).items;
    assert.ok(special.some((item) => item.effectiveScope === "SPECIAL_PERIOD"));
    assert.ok((await service.list(context, { anomalyCode: "RELATED_PERSON_INACTIVE" }, at)).items.length >= 1);
    assert.ok((await service.list(context, { personId: related.session.personId }, at)).items.every((item) => item.relatedPerson?.personId === related.session.personId || item.member.personId === related.session.personId));
    const missing = (await service.list(context, { anomalyCode: "NONZERO_RECIPIENT_MISSING" }, at)).items;
    assert.ok(missing.length >= 1);
    assert.equal(missing[0].relationshipId, null);
    assert.equal(missing[0].relatedPerson, null);
    assert.equal(missing[0].createdBy, null);
    assert.equal(missing[0].anomalyCodes[0], "NONZERO_RECIPIENT_MISSING");
    const missingCampus = (await service.list(context, { anomalyCode: "CAMPUS_PRINCIPAL_MISSING" }, at)).items;
    assert.ok(missingCampus.some((item) => item.member.personId === missingTeacher.session.personId && item.repairability === "REQUIRES_P27"));
    await database.pool.query("UPDATE person SET status='ACTIVE' WHERE id=$1", [related.session.personId]);
    await assert.rejects(() => service.list(context, { limit: 2, cursor: mutableCursorPage.nextCursor }, at), /VERSION_CONFLICT/);
    assert.ok(missing.every((item) => ["GROUP_LEADER", "TEACHING_MENTOR"].includes(item.relationshipType)));
    assert.ok(missing.some((item) => item.member.personId === missingTeacher.session.personId));
    assert.ok(missing.some((item) => item.member.personId === missingTeacher.session.personId && item.relationshipType === "TEACHING_MENTOR" && item.repairability === "TEACHING_MENTOR_REGULAR_WEEK_PREVIEW" && item.repairBlockedReason === null));
    await assert.rejects(() => service.list({ ...context, subject: "TEACHER", scope: "SELF" }, {}, at), /FORBIDDEN_SCOPE/);
    await assert.rejects(() => service.list(context, { cursor: "bad" }, at), /INVALID_INPUT/);
  } finally { await database.close(); }
});

test("关系审计真实PG：正式周、定向职责、换校区间和关系实际引用", async () => {
  const database = await createTestDatabase(connectionString);
  const access = new PostgresAccountAccessService(database.pool);
  try {
    const owner = await access.register({ nickname: "边界审计管理员", legalName: "边界审计管理员", phoneNormalized: "13800009801", password: "audit-owner" }, at);
    const teacher = await access.register({ nickname: "换校授课成员", legalName: "换校授课成员", phoneNormalized: "13800009802", password: "audit-teacher" }, at);
    const legalTeacher = await access.register({ nickname: "合法区间成员", legalName: "合法区间成员", phoneNormalized: "13800009803", password: "audit-legal" }, at);
    const planner = await access.register({ nickname: "有导师规划师", legalName: "有导师规划师", phoneNormalized: "13800009804", password: "audit-planner" }, at);
    const plannerWithoutMentor = await access.register({ nickname: "无导师规划师", legalName: "无导师规划师", phoneNormalized: "13800009805", password: "audit-planner-none" }, at);
    const related = await access.register({ nickname: "关系职责对象", legalName: "关系职责对象", phoneNormalized: "13800009806", password: "audit-related" }, at);
    const missingTeacher = await access.register({ nickname: "缺关系授课成员", legalName: "缺关系授课成员", phoneNormalized: "13800009807", password: "audit-missing" }, at);
    const ids = {
      year: randomUUID(), period: randomUUID(), regularWeek: randomUUID(), specialWeek: randomUUID(),
      region: randomUUID(), campusOne: randomUUID(), campusTwo: randomUUID(), venue: randomUUID(),
      teacherCampusOne: randomUUID(), teacherCampusTwo: randomUUID(), legalCampus: randomUUID(), plannerCampus: randomUUID(), missingCampus: randomUUID(),
      directedLeaderRole: randomUUID(), principalRole: randomUUID(), principalNoAccount: randomUUID(), principalNoAccountRole: randomUUID(), student: randomUUID(), referral: randomUUID(), fee: randomUUID(),
    };
    const regularStart = "2026-09-27T16:00:00.000Z";
    await database.pool.query("INSERT INTO person(id,nickname,legal_name,status,created_at,updated_at) VALUES($1,$2,$2,'ACTIVE','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')", [ids.principalNoAccount, `无个人账户校长-${ids.principalNoAccount}`]);
    await database.pool.query(
      "INSERT INTO teacher_profile(person_id,business_identity,employment_status) VALUES($1,'TEACHING_TEACHER','ACTIVE'),($2,'TEACHING_TEACHER','ACTIVE'),($3,'ACADEMIC_PLANNER','ACTIVE'),($4,'ACADEMIC_PLANNER','ACTIVE'),($5,'TEACHING_TEACHER','ACTIVE')",
      [teacher.session.personId, legalTeacher.session.personId, planner.session.personId, plannerWithoutMentor.session.personId, missingTeacher.session.personId],
    );
    await database.pool.query(
      `INSERT INTO organization_unit(id,unit_type,name) VALUES
       ($1,'REGION',$2),($3,'CAMPUS',$4),($5,'CAMPUS',$6)`,
      [ids.region, `audit-region-${ids.region}`, ids.campusOne, `audit-campus-${ids.campusOne}`, ids.campusTwo, `audit-campus-${ids.campusTwo}`],
    );
    await database.pool.query("INSERT INTO academic_year_plan(id,label,starts_on,ends_on,created_by) VALUES($1,'audit-boundary-year','2026-01-01','2026-12-31',$2)", [ids.year, owner.session.personId]);
    await database.pool.query("INSERT INTO academic_period(id,academic_year_plan_id,label,starts_on,ends_on) VALUES($1,$2,'audit-boundary-period','2026-09-01','2026-10-31')", [ids.period, ids.year]);
    await database.pool.query(
      `INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month,status) VALUES
       ($1,$2,1,'REGULAR','2026-09-28','2026-10-04','2026-09-01','OPEN'),
       ($3,$2,2,'SUMMER_SPECIAL','2026-10-05','2026-10-11','2026-10-01','OPEN')`,
      [ids.regularWeek, ids.period, ids.specialWeek],
    );
    await database.pool.query(
      `INSERT INTO role_assignment(id,person_id,subject_code,scope_type,scope_id,valid_from,created_by,created_at) VALUES
       (gen_random_uuid(),$1,'SYSTEM_OWNER','GLOBAL',NULL,'2026-01-01T00:00:00Z',$1,'2026-01-01T00:00:00Z'),
       ($2,$3,'GROUP_LEADER','ASSOCIATED_TEACHERS',$4,'2026-01-01T00:00:00Z',$1,'2026-01-01T00:00:00Z'),
       (gen_random_uuid(),$3,'TEACHING_MENTOR','MENTEES',NULL,'2026-01-01T00:00:00Z',$1,'2026-01-01T00:00:00Z'),
       (gen_random_uuid(),$3,'PLANNING_MENTOR','SELF',NULL,'2026-01-01T00:00:00Z',$1,'2026-01-01T00:00:00Z'),
       ($5,$3,'CAMPUS_PRINCIPAL','CAMPUS',$6,'2026-09-10T00:00:00Z',$1,'2026-09-10T00:00:00Z'),
       ($7,$8,'CAMPUS_PRINCIPAL','CAMPUS',$6,'2026-09-10T00:00:00Z',$1,'2026-09-10T00:00:00Z')`,
      [owner.session.personId, ids.directedLeaderRole, related.session.personId, teacher.session.personId, ids.principalRole, ids.campusOne, ids.principalNoAccountRole, ids.principalNoAccount],
    );
    await database.pool.query(
      `INSERT INTO person_campus_assignment(id,person_id,campus_id,region_id,valid_from,valid_to,created_by,created_at) VALUES
       ($1,$2,$3,$4,'2026-09-01T00:00:00Z','2026-09-20T00:00:00Z',$5,'2026-09-01T00:00:00Z'),
       ($6,$2,$7,$4,'2026-09-20T00:00:00Z',NULL,$5,'2026-09-20T00:00:00Z'),
       ($8,$9,$3,$4,'2026-09-01T00:00:00Z','2026-09-20T00:00:00Z',$5,'2026-09-01T00:00:00Z'),
       ($10,$11,$3,$4,'2026-09-01T00:00:00Z',NULL,$5,'2026-09-01T00:00:00Z'),
       ($12,$13,$7,$4,'2026-09-01T00:00:00Z',NULL,$5,'2026-09-01T00:00:00Z')`,
      [ids.teacherCampusOne, teacher.session.personId, ids.campusOne, ids.region, owner.session.personId, ids.teacherCampusTwo, ids.campusTwo, ids.legalCampus, legalTeacher.session.personId, ids.plannerCampus, planner.session.personId, ids.missingCampus, missingTeacher.session.personId],
    );
    await database.pool.query("INSERT INTO rate_policy_version(version,effective_from,policy_json,reason,published_by,published_at) VALUES(1,'2026-01-01',$1::jsonb,'audit-boundary',$2,'2026-01-01T00:00:00Z')", [JSON.stringify({ groupLeaderRateBasisPoints: 100, teachingMentorRateBasisPoints: 0 }), owner.session.personId]);
    const relationships = (await database.pool.query(
      `INSERT INTO person_relationship(teacher_id,relationship_type,related_person_id,valid_from,valid_to,effective_scope,created_by,created_at) VALUES
       ($1,'GROUP_LEADER',$2,$3,NULL,$4,$5,$3),
       ($1,'CAMPUS_PRINCIPAL',$2,'2026-09-10T00:00:00Z',NULL,'CAMPUS',$5,'2026-09-10T00:00:00Z'),
       ($6,'CAMPUS_PRINCIPAL',$9,'2026-09-10T00:00:00Z','2026-09-15T00:00:00Z','CAMPUS',$5,'2026-09-10T00:00:00Z'),
       ($7,'GROUP_LEADER',$2,$3,NULL,$8,$5,$3)
       RETURNING id::text,teacher_id::text,relationship_type,effective_scope`,
      [teacher.session.personId, related.session.personId, regularStart, `REGULAR_WEEK:${ids.regularWeek}`, owner.session.personId, legalTeacher.session.personId, planner.session.personId, `REGULAR_WEEK:${ids.specialWeek}`, ids.principalNoAccount],
    )).rows;
    const groupRelationship = relationships.find((row) => row.teacher_id === teacher.session.personId && row.relationship_type === "GROUP_LEADER");
    assert.ok(groupRelationship);
    const planningService = new PostgresPlanningMentorRelationshipService(database.pool);
    const planningContext = { personId: related.session.personId, subject: "PLANNING_MENTOR", scope: "SELF" };
    const planningPreview = await planningService.preview(planningContext, { action: "ADD", plannerPersonId: planner.session.personId, effectiveTeachingWeekId: ids.regularWeek, reason: "审计真实引用夹具" }, at);
    const planningPublished = await planningService.publish(planningContext, planningPreview.previewId, "audit-boundary-planning-add", at);
    assert.ok(planningPublished.resultRelationshipId);
    await database.pool.query("INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name,created_at,updated_at) VALUES($1,$2,'audit-course','审计学生',$3,$3)", [ids.student, teacher.session.personId, iso]);
    await database.pool.query(
      `INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,version,created_at,updated_at)
       VALUES($1,$2,$3,$4,'ACADEMIC_PLANNER','ACCEPTED',$5,1,$5,$5)`,
      [ids.referral, ids.student, planner.session.personId, teacher.session.personId, iso],
    );
    await database.pool.query(
      `INSERT INTO referral_creation_snapshot(referral_case_id,source_subject,business_identity_version,campus_assignment_id,campus_id,planning_mentor_relationship_id,class_type,collector_person_id,created_by,created_at)
       VALUES($1,'ACADEMIC_PLANNER',1,$2,$3,$4,'ONE_TO_ONE',$5,$6,$7)`,
      [ids.referral, ids.plannerCampus, ids.campusOne, planningPublished.resultRelationshipId, teacher.session.personId, planner.session.personId, iso],
    );
    await database.pool.query("INSERT INTO venue(id,owner_person_id,name,status,default_for_owner,created_at,updated_at) VALUES($1,$2,'审计场地','ACTIVE',true,$3,$3)", [ids.venue, teacher.session.personId, iso]);
    await database.pool.query(
      `INSERT INTO weekly_fee_entry(id,referral_case_id,teaching_week_id,settlement_month,gross_amount_cents,venue_id,venue_owner_person_id,is_self_use_snapshot,source_case_version,version,created_by,created_at,updated_at)
       VALUES($1,$2,$3,'2026-09-01',10000,$4,$5,true,1,1,$5,$6,$6)`,
      [ids.fee, ids.referral, ids.regularWeek, ids.venue, teacher.session.personId, iso],
    );
    const policyId = (await database.pool.query("SELECT id::text FROM rate_policy_version WHERE version=1")).rows[0].id;
    const contextJson = { relationships: { groupLeader: { id: groupRelationship.id }, planningMentor: { id: planningPublished.resultRelationshipId } } };
    for (let index = 0; index < 2; index += 1) {
      const runId = randomUUID();
      await database.pool.query("INSERT INTO settlement_calculation_run(id,request_key,fee_entry_id,fee_version,actor_person_id,status,ledger_event_id,created_at) VALUES($1,$2,$3,1,$4,'NO_BALANCE_CHANGE',NULL,$5)", [runId, `audit-boundary-run-${index}`, ids.fee, owner.session.personId, iso]);
      await database.pool.query("INSERT INTO weekly_fee_allocation_snapshot(run_id,weekly_fee_entry_id,source_weekly_fee_version,policy_version_id,net_monthly_cents,snapshot_json,context_json,created_at) VALUES($1,$2,1,$3,10000,'{}'::jsonb,$4::jsonb,$5)", [runId, ids.fee, policyId, JSON.stringify(contextJson), iso]);
    }
    const service = new PostgresPersonRelationshipAuditService(database.pool);
    const adminContext = { personId: owner.session.personId, subject: "SYSTEM_OWNER", scope: "GLOBAL" };
    const directed = (await service.list(adminContext, { personId: teacher.session.personId, relationshipType: "GROUP_LEADER" }, at)).items.find((item) => item.relationshipId === groupRelationship.id);
    assert.ok(directed);
    assert.deepEqual(directed.matchingRoleAssignmentIds, [ids.directedLeaderRole]);
    assert.equal(directed.anomalyCodes.includes("RELATED_ROLE_INVALID"), false);
    assert.equal(directed.anomalyCodes.includes("SPECIAL_PERIOD_SCOPE_REQUIRED"), false);
    assert.deepEqual(directed.referenceCounts, { weeklyFees: 1, allocationSnapshots: 2, referrals: 0 });
    const planning = (await service.list(adminContext, { personId: planner.session.personId, relationshipType: "PLANNING_MENTOR" }, at)).items.find((item) => item.relationshipId === planningPublished.resultRelationshipId);
    assert.ok(planning);
    assert.deepEqual(planning.referenceCounts, { weeklyFees: 1, allocationSnapshots: 2, referrals: 1 });
    assert.equal(planning.repairability, "PLANNING_MENTOR_REGULAR_WEEK_PREVIEW");
    assert.equal(planning.repairBlockedReason, null);
    const plannerCampusMissing = (await service.list(adminContext, { personId: planner.session.personId, relationshipType: "CAMPUS_PRINCIPAL" }, at)).items;
    assert.ok(plannerCampusMissing.some((item) => item.relationshipId === null && item.anomalyCodes.includes("CAMPUS_PRINCIPAL_MISSING") && item.repairability === "REQUIRES_P27"));
    const special = (await service.list(adminContext, { personId: planner.session.personId, anomalyCode: "SPECIAL_PERIOD_SCOPE_REQUIRED" }, at)).items;
    assert.ok(special.some((item) => item.effectiveScope === `REGULAR_WEEK:${ids.specialWeek}` && item.repairability === "REQUIRES_SPECIAL_PERIOD_SCOPE"));
    const movedCampus = (await service.list(adminContext, { personId: teacher.session.personId, relationshipType: "CAMPUS_PRINCIPAL" }, at)).items[0];
    assert.ok(movedCampus.anomalyCodes.includes("CAMPUS_PRINCIPAL_MISMATCH"));
    assert.equal(movedCampus.anomalyCodes.includes("RECIPIENT_ACCOUNT_INVALID"), false);
    const legalCampus = (await service.list(adminContext, { personId: legalTeacher.session.personId, relationshipType: "CAMPUS_PRINCIPAL" }, at)).items[0];
    assert.equal(legalCampus.anomalyCodes.includes("CAMPUS_PRINCIPAL_MISMATCH"), false);
    assert.equal(legalCampus.anomalyCodes.includes("RELATED_ROLE_SCOPE_MISMATCH"), false);
    assert.equal(legalCampus.anomalyCodes.includes("RECIPIENT_ACCOUNT_INVALID"), false);
    assert.deepEqual((await service.list(adminContext, { personId: plannerWithoutMentor.session.personId, relationshipType: "PLANNING_MENTOR" }, at)).items, []);
    const missing = (await service.list(adminContext, { personId: missingTeacher.session.personId, anomalyCode: "NONZERO_RECIPIENT_MISSING" }, at)).items;
    assert.ok(missing.some((item) => item.relationshipType === "GROUP_LEADER"));
    assert.ok(missing.every((item) => item.referenceCounts.weeklyFees === 0 && item.referenceCounts.allocationSnapshots === 0 && item.referenceCounts.referrals === 0));
  } finally {
    await database.close();
  }
});
