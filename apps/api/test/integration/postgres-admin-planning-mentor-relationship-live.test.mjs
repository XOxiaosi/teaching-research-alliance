import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_RATE_POLICY_VALUES,
} from "@teaching-research-alliance/domain";
import { PostgresAdminPlanningMentorRelationshipService } from "../../dist/postgres-admin-planning-mentor-relationship-service.js";
import { PostgresPlanningMentorRelationshipService } from "../../dist/postgres-planning-mentor-relationship-service.js";
import { PostgresWeeklySettlementService } from "../../dist/postgres-weekly-settlement-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const connectionString = process.env.DATABASE_URL;
const stringify = (value) => JSON.stringify(value, (_, item) =>
  typeof item === "bigint" ? item.toString() : item,
);
const mentorContext = (personId) => ({
  subject: "PLANNING_MENTOR",
  personId,
  scope: "SELF",
});

const seed = async (pool) => {
  const keys = [
    "admin", "mentor", "planner", "receiver", "groupLeader", "teachingMentor",
    "platformFinance", "regionFinance", "region", "campus", "venue", "year",
    "period", "previousWeek", "currentWeek", "nextWeek", "specialWeek", "laterWeek", "student", "referral",
  ];
  const ids = Object.fromEntries(keys.map((key) => [key, randomUUID()]));
  const people = [
    "admin", "mentor", "planner", "receiver", "groupLeader", "teachingMentor",
    "platformFinance", "regionFinance",
  ];
  for (const key of people) {
    await pool.query(
      "INSERT INTO person(id,nickname,legal_name,status) VALUES($1,$2,$2,'ACTIVE')",
      [ids[key], `mentor-live-${key}-${ids[key]}`],
    );
    await pool.query(
      "INSERT INTO user_account(person_id,phone_normalized,password_hash,login_status) VALUES($1,$2,$3,'ACTIVE')",
      [ids[key], `137${String(people.indexOf(key)).padStart(8, "0")}`, `synthetic-${key}`],
    );
    await pool.query(
      "INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('PERSON',$1,$2,'ACTIVE')",
      [ids[key], `person:${ids[key]}`],
    );
  }
  await pool.query(
    "INSERT INTO organization_unit(id,unit_type,name) VALUES($1,'REGION',$2),($3,'CAMPUS',$4)",
    [ids.region, `region-${ids.region}`, ids.campus, `campus-${ids.campus}`],
  );
  await pool.query(
    "INSERT INTO campus_region_assignment(campus_id,region_id,valid_from,created_by) VALUES($1,$2,'2026-01-01T00:00:00Z',$3)",
    [ids.campus, ids.region, ids.admin],
  );
  await pool.query(
    `INSERT INTO teacher_profile(person_id,business_identity,region_id,campus_id,employment_status)
       VALUES($1,'ACADEMIC_PLANNER',$2,$3,'ACTIVE'),($4,'TEACHING_TEACHER',$2,$3,'ACTIVE')`,
    [ids.planner, ids.region, ids.campus, ids.receiver],
  );
  await pool.query(
    `INSERT INTO person_campus_assignment(person_id,campus_id,region_id,valid_from,created_by)
       VALUES($1,$2,$3,'2026-01-01T00:00:00Z',$4),($5,$2,$3,'2026-01-01T00:00:00Z',$4)`,
    [ids.planner, ids.campus, ids.region, ids.admin, ids.receiver],
  );
  await pool.query(
    `INSERT INTO role_assignment(person_id,subject_code,scope_type,scope_id,valid_from,created_by)
       VALUES($1,'PLANNING_MENTOR','SELF',NULL,'2026-01-01T00:00:00Z',$2),
             ($2,'SYSTEM_ADMIN','GLOBAL',NULL,'2026-01-01T00:00:00Z',$2),
             ($3,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'2026-01-01T00:00:00Z',$2),
             ($4,'REGION_FINANCE','REGION',$5,'2026-01-01T00:00:00Z',$2)`,
    [ids.mentor, ids.admin, ids.platformFinance, ids.regionFinance, ids.region],
  );
  await pool.query(
    `INSERT INTO person_relationship(teacher_id,relationship_type,related_person_id,valid_from,effective_scope,created_by)
       VALUES($1,'GROUP_LEADER',$2,'2026-01-01T00:00:00Z','CURRENT',$3),
             ($1,'TEACHING_MENTOR',$4,'2026-01-01T00:00:00Z','CURRENT',$3)`,
    [ids.receiver, ids.groupLeader, ids.admin, ids.teachingMentor],
  );
  await pool.query(
    "INSERT INTO venue(id,owner_person_id,name,status,default_for_owner) VALUES($1,$2,$3,'ACTIVE',true)",
    [ids.venue, ids.receiver, `venue-${ids.venue}`],
  );
  await pool.query(
    "INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('VENUE',$1,$2,'ACTIVE'),('COMPANY',$3,$4,'ACTIVE')",
    [ids.venue, `venue:${ids.venue}`, ids.campus, `company:${ids.campus}`],
  );
  await pool.query(
    "INSERT INTO academic_year_plan(id,label,starts_on,ends_on,created_by) VALUES($1,'DEV-007','2026-01-01','2026-12-31',$2)",
    [ids.year, ids.admin],
  );
  await pool.query(
    "INSERT INTO academic_period(id,academic_year_plan_id,label,starts_on,ends_on) VALUES($1,$2,'regular','2026-09-01','2026-12-31')",
    [ids.period, ids.year],
  );
  for (const [key, sequence, startsOn, endsOn] of [
    ["previousWeek", 1, "2026-09-14", "2026-09-20"],
    ["currentWeek", 2, "2026-09-21", "2026-09-27"],
    ["nextWeek", 3, "2026-09-28", "2026-10-04"],
  ]) {
    await pool.query(
      "INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month,status) VALUES($1,$2,$3,'REGULAR',$4,$5,'2026-09-01','OPEN')",
      [ids[key], ids.period, sequence, startsOn, endsOn],
    );
  }
  await pool.query(
    "INSERT INTO rate_policy_version(version,effective_from,policy_json,reason,published_by) VALUES(1,'2026-09-01',$1::jsonb,'synthetic',$2)",
    [stringify(DEFAULT_RATE_POLICY_VALUES), ids.admin],
  );
  await pool.query(
    "INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name) VALUES($1,$2,'dev-007-course','DEV-007 student')",
    [ids.student, ids.receiver],
  );
  await pool.query(
    `INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,version)
       VALUES($1,$2,$3,$4,'ACADEMIC_PLANNER','ACCEPTED','2026-09-01T00:00:00Z',2)`,
    [ids.referral, ids.student, ids.planner, ids.receiver],
  );
  return ids;
};

const latest = async (pool, feeId) => (await pool.query(
  `SELECT id::text,run_id::text,sequence_no::text,snapshot_json,context_json
     FROM weekly_fee_allocation_snapshot snapshot
    WHERE snapshot.weekly_fee_entry_id=$1
    ORDER BY snapshot.sequence_no DESC LIMIT 1`,
  [feeId],
)).rows[0];

const balance = async (pool, personId) => BigInt((await pool.query(
  `SELECT COALESCE(projection.balance_cents,0)::text AS value
     FROM settlement_account account
     LEFT JOIN account_balance_projection projection ON projection.account_id=account.id
    WHERE account.owner_type='PERSON' AND account.owner_id=$1`,
  [personId],
)).rows[0].value);

const recordReferralSource = async (pool, ids, sourceSubject) => {
  const assignment = (await pool.query(
    "SELECT id::text FROM person_campus_assignment WHERE person_id=$1",
    [ids.planner],
  )).rows[0];
  await pool.query(
    `INSERT INTO referral_creation_snapshot(
       referral_case_id,source_subject,business_identity_version,campus_assignment_id,campus_id,
       planning_mentor_relationship_id,class_type,collector_person_id,created_by,created_at
     ) VALUES($1,$2,1,$3,$4,NULL,'ONE_TO_ONE',$5,$6,'2026-09-01T00:00:00Z')`,
    [ids.referral, sourceSubject, assignment.id, ids.campus, ids.receiver, ids.admin],
  );
};

const addPlanningMentor = async (pool, ids, label) => {
  const personId = randomUUID();
  await pool.query(
    "INSERT INTO person(id,nickname,legal_name,status) VALUES($1,$2,$2,'ACTIVE')",
    [personId, `planning-mentor-${label}`],
  );
  await pool.query(
    "INSERT INTO user_account(person_id,phone_normalized,password_hash,login_status) VALUES($1,$2,'synthetic','ACTIVE')",
    [personId, `136${label === "conflict" ? "00000001" : "00000002"}`],
  );
  await pool.query(
    "INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('PERSON',$1,$2,'ACTIVE')",
    [personId, `person:${personId}`],
  );
  await pool.query(
    `INSERT INTO role_assignment(person_id,subject_code,scope_type,valid_from,created_by)
     VALUES($1,'PLANNING_MENTOR','SELF','2026-01-01T00:00:00Z',$2)`,
    [personId, ids.admin],
  );
  return personId;
};

const settle = (pool, ids, weekId, amount, key = randomUUID(), referralId = ids.referral) =>
  new PostgresWeeklySettlementService(pool).recordAndSettle(ids.receiver, {
    referralCaseId: referralId,
    teachingWeekId: weekId,
    venueId: ids.venue,
    settlementMonth: "2026-09-01",
    grossAmountCents: amount,
    expectedVersion: 0,
  }, key);

const artifactCounts = async (pool) => (await pool.query(
  `SELECT
     (SELECT count(*)::int FROM planning_mentor_relationship_change) AS changes,
     (SELECT count(*)::int FROM planning_mentor_relationship_change_effect) AS effects,
     (SELECT count(*)::int FROM settlement_calculation_run
       WHERE request_key LIKE 'planning-mentor-change:%') AS runs,
     (SELECT count(*)::int FROM ledger_event
       WHERE event_key LIKE 'weekly-settlement:planning-mentor-change:%') AS events,
     (SELECT count(*)::int FROM person_relationship
       WHERE relationship_type='PLANNING_MENTOR') AS relationships`,
)).rows[0];

const assertProjectionMatchesLedger = async (pool, accountId) => {
  const row = (await pool.query(
    `SELECT COALESCE((SELECT sum(amount_cents) FROM ledger_entry WHERE account_id=$1),0)::text AS ledger,
            COALESCE((SELECT balance_cents FROM account_balance_projection WHERE account_id=$1),0)::text AS projection`,
    [accountId],
  )).rows[0];
  assert.equal(row.projection, row.ledger, "projection must equal the entire immutable ledger");
};

const personAccountId = async (pool, personId) => (await pool.query(
  "SELECT id::text FROM settlement_account WHERE owner_type='PERSON' AND owner_id=$1",
  [personId],
)).rows[0].id;

const adminContext = (personId) => ({ subject: "SYSTEM_ADMIN", personId, scope: "GLOBAL" });

const addReferral = async (pool, ids, label) => {
  const student = randomUUID(), referral = randomUUID();
  await pool.query(
    "INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name) VALUES($1,$2,$3,$3)",
    [student, ids.receiver, `admin-planning-${label}`],
  );
  await pool.query(
    `INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,version)
       VALUES($1,$2,$3,$4,'ACADEMIC_PLANNER','ACCEPTED','2026-09-01T00:00:00Z',2)`,
    [referral, student, ids.planner, ids.receiver],
  );
  const assignment = (await pool.query(
    "SELECT id::text FROM person_campus_assignment WHERE person_id=$1", [ids.planner],
  )).rows[0];
  await pool.query(
    `INSERT INTO referral_creation_snapshot(referral_case_id,source_subject,business_identity_version,campus_assignment_id,campus_id,planning_mentor_relationship_id,class_type,collector_person_id,created_by,created_at)
     VALUES($1,'ACADEMIC_PLANNER',1,$2,$3,NULL,'ONE_TO_ONE',$4,$5,'2026-09-01T00:00:00Z')`,
    [referral, assignment.id, ids.campus, ids.receiver, ids.admin],
  );
  return referral;
};

const freezeRefund = async (pool, ids, feeId, at) => {
  const snapshot = await latest(pool, feeId), documentId = randomUUID();
  await pool.query(
    "INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at) VALUES($1,$2,'REFUND','REFUNDED',1,$3,$3)",
    [documentId, ids.receiver, at.toISOString()],
  );
  await pool.query("ALTER TABLE weekly_fee_refund_effect DISABLE TRIGGER USER");
  try {
    await pool.query(
      `INSERT INTO weekly_fee_refund_effect(weekly_fee_entry_id,finance_document_id,allocation_snapshot_id,source_weekly_fee_version,gross_amount_cents,snapshot_json,created_at)
       SELECT $1,$2,$3,version,gross_amount_cents,$4::jsonb,$5 FROM weekly_fee_entry WHERE id=$1`,
      [feeId, documentId, snapshot.id, stringify(snapshot.snapshot_json), at.toISOString()],
    );
  } finally {
    await pool.query("ALTER TABLE weekly_fee_refund_effect ENABLE TRIGGER USER");
  }
  return snapshot;
};

test("真实 PostgreSQL：目录、ADD、有限 REPLACE、失活源导师 REMOVE、退款与三方金额完整闭环", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  try {
    const { pool } = database, ids = await seed(pool);
    const at = new Date("2026-09-23T04:00:00.000Z"), context = adminContext(ids.admin);
    const mentorB = await addPlanningMentor(pool, ids, "admin-b");
    await recordReferralSource(pool, ids, "ACADEMIC_PLANNER");
    const refundReferral = await addReferral(pool, ids, "refund");
    const current = await settle(pool, ids, ids.currentWeek, 100000n, "admin-planning-current");
    const next = await settle(pool, ids, ids.nextWeek, 100000n, "admin-planning-next");
    const refunded = await settle(pool, ids, ids.currentWeek, 100000n, "admin-planning-refund", refundReferral);
    const refundBefore = await freezeRefund(pool, ids, refunded.fee.id, at);
    const service = new PostgresAdminPlanningMentorRelationshipService(pool);

    const directory = await service.listDirectory(context, at);
    assert.deepEqual(directory.currentWeeks.map((week) => week.id), [ids.currentWeek, ids.nextWeek]);
    assert.ok(directory.planners.some((planner) => planner.personId === ids.planner));
    assert.deepEqual(new Set(directory.mentors.map((mentor) => mentor.personId)), new Set([ids.mentor, mentorB]));
    await pool.query(
      `INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month,status) VALUES
       ($1,$3,4,'WINTER_SPECIAL','2026-10-05','2026-10-11','2026-10-01','OPEN'),
       ($2,$3,5,'REGULAR','2026-10-12','2026-10-18','2026-10-01','OPEN')`,
      [ids.specialWeek, ids.laterWeek, ids.period],
    );
    await assert.rejects(service.preview(context, {
      action: "ADD", plannerPersonId: ids.planner, newMentorPersonId: ids.mentor,
      effectiveTeachingWeekId: ids.previousWeek, reason: "历史周必须拒绝",
    }, at), /RELATIONSHIP_EFFECTIVE_WEEK_NOT_CURRENT/);
    await assert.rejects(service.preview(context, {
      action: "ADD", plannerPersonId: ids.planner, newMentorPersonId: ids.mentor,
      effectiveTeachingWeekId: ids.specialWeek, reason: "特殊期必须拒绝",
    }, at), /RELATIONSHIP_SPECIAL_PERIOD_SCOPE_REQUIRED/);
    await assert.rejects(service.preview(context, {
      action: "ADD", plannerPersonId: ids.planner, newMentorPersonId: ids.mentor,
      effectiveTeachingWeekId: ids.currentWeek, effectiveThroughTeachingWeekId: ids.laterWeek,
      reason: "连续范围不得跨越特殊期",
    }, at), /RELATIONSHIP_SPECIAL_PERIOD_SCOPE_REQUIRED/);

    const addPreview = await service.preview(context, {
      action: "ADD", plannerPersonId: ids.planner, newMentorPersonId: ids.mentor,
      effectiveTeachingWeekId: ids.currentWeek, effectiveThroughTeachingWeekId: ids.nextWeek,
      reason: "管理员补齐规划导师",
    }, at);
    assert.equal(addPreview.consideredFeeCount, 2);
    assert.equal(addPreview.excludedRefundCount, 1);
    assert.equal(BigInt(addPreview.plannerDeltaCents) < 0n, true);
    assert.equal(addPreview.sourceMentorDeltaCents, "0");
    assert.equal(BigInt(addPreview.destinationMentorDeltaCents) > 0n, true);
    assert.equal(BigInt(addPreview.plannerDeltaCents) + BigInt(addPreview.destinationMentorDeltaCents), 0n);
    const addPublished = await service.publish(context, addPreview.previewId, "admin-planning-add", at);
    assert.equal(addPublished.replay, false);
    assert.equal((await service.publish(context, addPreview.previewId, "admin-planning-add", at)).replay, true);

    const replacePreview = await service.preview(context, {
      action: "REPLACE", plannerPersonId: ids.planner, newMentorPersonId: mentorB,
      effectiveTeachingWeekId: ids.currentWeek, effectiveThroughTeachingWeekId: ids.currentWeek,
      reason: "仅本普通周更正导师",
    }, at);
    assert.equal(replacePreview.plannerDeltaCents, "0");
    assert.equal(BigInt(replacePreview.sourceMentorDeltaCents) < 0n, true);
    assert.equal(BigInt(replacePreview.destinationMentorDeltaCents) > 0n, true);
    assert.equal(BigInt(replacePreview.sourceMentorDeltaCents) + BigInt(replacePreview.destinationMentorDeltaCents), 0n);
    const replacePublished = await service.publish(context, replacePreview.previewId, "admin-planning-replace", at);
    const replaceChange = (await pool.query(
      `SELECT source_relationship_id::text,result_relationship_id::text,continuation_relationship_id::text,
              planner_delta_cents::text,source_mentor_delta_cents::text,destination_mentor_delta_cents::text,
              before_json,after_json FROM admin_planning_mentor_relationship_change WHERE id=$1`,
      [replacePublished.changeId],
    )).rows[0];
    assert.equal(replaceChange.planner_delta_cents, "0");
    assert.equal(replaceChange.before_json.sourceRelationship.id, replaceChange.source_relationship_id);
    assert.equal(replaceChange.after_json.resultRelationship.id, replaceChange.result_relationship_id);
    assert.equal(replaceChange.after_json.continuationRelationship.id, replaceChange.continuation_relationship_id);
    const continuation = (await pool.query(
      "SELECT related_person_id::text,valid_from::text FROM person_relationship WHERE id=$1",
      [replaceChange.continuation_relationship_id],
    )).rows[0];
    assert.equal(continuation.related_person_id, ids.mentor);
    assert.equal(new Date(continuation.valid_from).toISOString(), "2026-09-27T16:00:00.000Z");
    assert.equal((await latest(pool, current.fee.id)).context_json.relationships.planningMentor.personId, mentorB);
    assert.equal((await latest(pool, next.fee.id)).context_json.relationships.planningMentor.personId, ids.mentor);

    await pool.query("UPDATE person SET status='INACTIVE' WHERE id=$1", [mentorB]);
    await pool.query("UPDATE user_account SET login_status='REVOKED' WHERE person_id=$1", [mentorB]);
    await pool.query("UPDATE role_assignment SET valid_to='2026-09-22T00:00:00Z' WHERE person_id=$1 AND subject_code='PLANNING_MENTOR'", [mentorB]);
    await pool.query("UPDATE settlement_account SET status='INACTIVE' WHERE owner_type='PERSON' AND owner_id=$1", [mentorB]);
    const removePreview = await service.preview(context, {
      action: "REMOVE", plannerPersonId: ids.planner,
      effectiveTeachingWeekId: ids.currentWeek, effectiveThroughTeachingWeekId: ids.currentWeek,
      reason: "清理已失活源导师",
    }, at);
    assert.equal(BigInt(removePreview.plannerDeltaCents) > 0n, true);
    assert.equal(BigInt(removePreview.sourceMentorDeltaCents) < 0n, true);
    assert.equal(removePreview.destinationMentorDeltaCents, "0");
    const removePublished = await service.publish(context, removePreview.previewId, "admin-planning-remove", at);
    assert.equal(removePublished.postingStatus, "POSTED");
    const removeChange = (await pool.query(
      `SELECT planner_delta_cents::text,source_mentor_delta_cents::text,destination_mentor_delta_cents::text,
              result_relationship_id,continuation_relationship_id,before_json,after_json
         FROM admin_planning_mentor_relationship_change WHERE id=$1`, [removePublished.changeId],
    )).rows[0];
    assert.equal(BigInt(removeChange.planner_delta_cents) + BigInt(removeChange.source_mentor_delta_cents) + BigInt(removeChange.destination_mentor_delta_cents), 0n);
    assert.equal(removeChange.result_relationship_id, null);
    assert.equal(removeChange.after_json.resultRelationship, null);
    assert.equal((await latest(pool, current.fee.id)).context_json.relationships.planningMentor, null);
    assert.equal((await latest(pool, refunded.fee.id)).id, refundBefore.id);

    const effects = (await pool.query(
      `SELECT change_id::text,planner_delta_cents::text,source_mentor_delta_cents::text,destination_mentor_delta_cents::text
         FROM admin_planning_mentor_relationship_change_effect ORDER BY created_at,change_id`,
    )).rows;
    assert.ok(effects.length >= 4);
    for (const effect of effects) {
      assert.equal(BigInt(effect.planner_delta_cents) + BigInt(effect.source_mentor_delta_cents) + BigInt(effect.destination_mentor_delta_cents), 0n);
    }
    const auditCodes = (await pool.query(
      "SELECT action_code FROM audit_event WHERE action_code LIKE 'PLANNING_MENTOR_RELATIONSHIP_%_BY_ADMIN' ORDER BY created_at,action_code",
    )).rows.map((row) => row.action_code);
    assert.deepEqual(new Set(auditCodes), new Set([
      "PLANNING_MENTOR_RELATIONSHIP_ADDED_BY_ADMIN",
      "PLANNING_MENTOR_RELATIONSHIP_REPLACED_BY_ADMIN",
      "PLANNING_MENTOR_RELATIONSHIP_REMOVED_BY_ADMIN",
    ]));
    for (const personId of [ids.planner, ids.mentor, mentorB]) {
      await assertProjectionMatchesLedger(pool, await personAccountId(pool, personId));
    }

    await assert.rejects(pool.query(
      "UPDATE person_relationship SET valid_to='2026-12-31T00:00:00Z' WHERE id=$1",
      [replaceChange.continuation_relationship_id],
    ), /PLANNING_MENTOR_PUBLISHED_RELATIONSHIP_IMMUTABLE/);
    const fakePlanner = randomUUID();
    await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1,'fake-planner','fake-planner','ACTIVE')", [fakePlanner]);
    await assert.rejects(pool.query(
      `INSERT INTO person_relationship(teacher_id,relationship_type,related_person_id,valid_from,effective_scope,created_by)
       VALUES($1,'PLANNING_MENTOR',$2,'2027-01-01T00:00:00Z','REGULAR_WEEK:'||$3::text,$4)`,
      [fakePlanner, ids.mentor, ids.nextWeek, ids.admin],
    ), /PLANNING_MENTOR_PUBLISHED_RELATIONSHIP_INSERT_INVALID/);
    await assert.rejects(pool.query(
      `INSERT INTO audit_event(actor_person_id,action_code,subject_type,subject_id,before_json,after_json,reason,created_at)
       SELECT actor_person_id,action_code,subject_type,subject_id,before_json,after_json,reason,created_at
         FROM audit_event WHERE action_code='PLANNING_MENTOR_RELATIONSHIP_ADDED_BY_ADMIN' LIMIT 1`,
    ), /ADMIN_PLANNING_MENTOR_RELATIONSHIP_AUDIT_PARENT_INVALID|ADMIN_PLANNING_MENTOR_RELATIONSHIP_CHANGE_AUDIT_INVALID/);
    await assert.rejects(pool.query(
      `INSERT INTO audit_event(actor_person_id,action_code,subject_type,subject_id,reason,created_at)
       VALUES($1,'PLANNING_MENTOR_RELATIONSHIP_ADDED_BY_ADMIN','PERSON_RELATIONSHIP',$2,'伪造',$3)`,
      [ids.admin, replaceChange.continuation_relationship_id, at.toISOString()],
    ), /ADMIN_PLANNING_MENTOR_RELATIONSHIP_AUDIT_PARENT_INVALID/);
  } finally { await database.close(); }
});

test("真实 PostgreSQL：预览陈旧、同预览并发、幂等换预览与撤权重放", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  try {
    const { pool } = database, ids = await seed(pool), at = new Date("2026-09-23T04:00:00.000Z");
    await recordReferralSource(pool, ids, "ACADEMIC_PLANNER");
    await settle(pool, ids, ids.currentWeek, 100000n, "admin-planning-concurrency");
    const service = new PostgresAdminPlanningMentorRelationshipService(pool), context = adminContext(ids.admin);
    await pool.query("UPDATE role_assignment SET valid_to='2026-10-31T00:00:00Z' WHERE person_id=$1 AND subject_code='PLANNING_MENTOR'", [ids.mentor]);
    await assert.rejects(service.preview(context, { action: "ADD", plannerPersonId: ids.planner,
      newMentorPersonId: ids.mentor, effectiveTeachingWeekId: ids.currentWeek,
      reason: "无限关系要求导师任职无结束时间" }, at), /RELATIONSHIP_DATA_UNAVAILABLE/);
    await pool.query("UPDATE role_assignment SET valid_to=NULL WHERE person_id=$1 AND subject_code='PLANNING_MENTOR'", [ids.mentor]);
    const stale = await service.preview(context, { action: "ADD", plannerPersonId: ids.planner,
      newMentorPersonId: ids.mentor, effectiveTeachingWeekId: ids.currentWeek, reason: "资格变化应使预览过期" }, at);
    await pool.query("UPDATE role_assignment SET valid_to='2026-09-20T00:00:00Z' WHERE person_id=$1 AND subject_code='PLANNING_MENTOR'", [ids.mentor]);
    await assert.rejects(service.publish(context, stale.previewId, "admin-planning-stale", at), /RELATIONSHIP_PREVIEW_STALE/);
    await pool.query("UPDATE role_assignment SET valid_to=NULL WHERE person_id=$1 AND subject_code='PLANNING_MENTOR'", [ids.mentor]);

    const preview = await service.preview(context, { action: "ADD", plannerPersonId: ids.planner,
      newMentorPersonId: ids.mentor, effectiveTeachingWeekId: ids.currentWeek, reason: "同预览并发只能成功一次" }, at);
    const concurrent = await Promise.allSettled([
      service.publish(context, preview.previewId, "admin-planning-concurrent-a", at),
      service.publish(context, preview.previewId, "admin-planning-concurrent-b", at),
    ]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await pool.query("SELECT count(*)::int n FROM admin_planning_mentor_relationship_change WHERE preview_id=$1", [preview.previewId])).rows[0].n, 1);
    assert.match(String(concurrent.find((result) => result.status === "rejected")?.reason), /RELATIONSHIP_PREVIEW_ALREADY_PUBLISHED/);
    const success = concurrent.find((result) => result.status === "fulfilled").value;
    const usedKey = success.replay ? "admin-planning-concurrent-b" :
      concurrent[0].status === "fulfilled" ? "admin-planning-concurrent-a" : "admin-planning-concurrent-b";
    const mentorB = await addPlanningMentor(pool, ids, "conflict");
    const otherPreview = await service.preview(context, { action: "REPLACE", plannerPersonId: ids.planner,
      newMentorPersonId: mentorB, effectiveTeachingWeekId: ids.nextWeek, reason: "换预览不得复用幂等键" }, at);
    await assert.rejects(service.publish(context, otherPreview.previewId, usedKey, at), /IDEMPOTENCY_REPLAY/);
    await pool.query("UPDATE role_assignment SET valid_to='2026-09-24T00:00:00Z' WHERE person_id=$1 AND subject_code='SYSTEM_ADMIN'", [ids.admin]);
    await assert.rejects(service.publish(context, preview.previewId, usedKey, new Date("2026-09-25T04:00:00Z")), /FORBIDDEN_SCOPE/);
  } finally { await database.close(); }
});

test("真实 PostgreSQL：0035 SELF ADD/REMOVE 在 0039 扩展后保持可用", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  try {
    const { pool } = database, ids = await seed(pool), at = new Date("2026-09-23T04:00:00.000Z");
    await recordReferralSource(pool, ids, "ACADEMIC_PLANNER");
    await settle(pool, ids, ids.currentWeek, 100000n, "planning-self-regression");
    const service = new PostgresPlanningMentorRelationshipService(pool), context = mentorContext(ids.mentor);
    const add = await service.preview(context, { action: "ADD", plannerPersonId: ids.planner,
      effectiveTeachingWeekId: ids.currentWeek, reason: "0035 ADD 回归" }, at);
    const added = await service.publish(context, add.previewId, "planning-self-add-regression", at);
    assert.equal(added.action, "ADD");
    const remove = await service.preview(context, { action: "REMOVE", plannerPersonId: ids.planner,
      effectiveTeachingWeekId: ids.currentWeek, reason: "0035 REMOVE 回归" }, at);
    const removed = await service.publish(context, remove.previewId, "planning-self-remove-regression", at);
    assert.equal(removed.action, "REMOVE");
    assert.equal((await pool.query("SELECT count(*)::int n FROM planning_mentor_relationship_change")).rows[0].n, 2);
  } finally { await database.close(); }
});

test("真实 PostgreSQL：有限 ADD 到边界恢复无关系，有限 REMOVE 续接原导师，零差额不造账", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  try {
    const { pool } = database, ids = await seed(pool), at = new Date("2026-09-23T04:00:00.000Z");
    const service = new PostgresAdminPlanningMentorRelationshipService(pool), context = adminContext(ids.admin);
    const finiteAdd = await service.preview(context, {
      action: "ADD", plannerPersonId: ids.planner, newMentorPersonId: ids.mentor,
      effectiveTeachingWeekId: ids.currentWeek, effectiveThroughTeachingWeekId: ids.currentWeek,
      reason: "仅当前周临时补导师",
    }, at);
    assert.equal(finiteAdd.changedFeeCount, 0);
    const finiteAdded = await service.publish(context, finiteAdd.previewId, "admin-finite-add", at);
    assert.equal(finiteAdded.postingStatus, "NO_BALANCE_CHANGE");
    const finiteAddChange = (await pool.query(
      "SELECT continuation_relationship_id,settlement_calculation_run_id,ledger_event_id FROM admin_planning_mentor_relationship_change WHERE id=$1",
      [finiteAdded.changeId],
    )).rows[0];
    assert.deepEqual(finiteAddChange, {
      continuation_relationship_id: null,
      settlement_calculation_run_id: null,
      ledger_event_id: null,
    });
    assert.equal((await pool.query(
      `SELECT count(*)::int n FROM person_relationship WHERE teacher_id=$1 AND relationship_type='PLANNING_MENTOR'
       AND superseded_at IS NULL AND valid_from<='2026-09-28T00:00:00+08:00' AND (valid_to IS NULL OR valid_to>'2026-09-28T00:00:00+08:00')`,
      [ids.planner],
    )).rows[0].n, 0, "bounded ADD must restore no relationship at the boundary");

    const openAdd = await service.preview(context, {
      action: "ADD", plannerPersonId: ids.planner, newMentorPersonId: ids.mentor,
      effectiveTeachingWeekId: ids.nextWeek, reason: "下一周起长期导师",
    }, at);
    await service.publish(context, openAdd.previewId, "admin-open-add-next", at);
    const finiteRemove = await service.preview(context, {
      action: "REMOVE", plannerPersonId: ids.planner,
      effectiveTeachingWeekId: ids.nextWeek, effectiveThroughTeachingWeekId: ids.nextWeek,
      reason: "下一周临时移除后恢复",
    }, at);
    const removed = await service.publish(context, finiteRemove.previewId, "admin-finite-remove-next", at);
    assert.equal(removed.postingStatus, "NO_BALANCE_CHANGE");
    const removeChange = (await pool.query(
      "SELECT continuation_relationship_id::text,settlement_calculation_run_id,ledger_event_id,after_json FROM admin_planning_mentor_relationship_change WHERE id=$1",
      [removed.changeId],
    )).rows[0];
    assert.notEqual(removeChange.continuation_relationship_id, null);
    assert.equal(removeChange.after_json.resultRelationship, null);
    assert.equal(removeChange.after_json.continuationRelationship.id, removeChange.continuation_relationship_id);
    assert.equal(removeChange.settlement_calculation_run_id, null);
    assert.equal(removeChange.ledger_event_id, null);
    const continued = (await pool.query(
      "SELECT related_person_id::text,valid_from::text FROM person_relationship WHERE id=$1",
      [removeChange.continuation_relationship_id],
    )).rows[0];
    assert.equal(continued.related_person_id, ids.mentor);
    assert.equal(new Date(continued.valid_from).toISOString(), "2026-10-04T16:00:00.000Z");
  } finally { await database.close(); }
});
