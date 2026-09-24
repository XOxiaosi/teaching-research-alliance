import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PostgresTeachingMentorRelationshipService } from "../../../api/dist/postgres-teaching-mentor-relationship-service.js";
import { PostgresWeeklySettlementService } from "../../../api/dist/postgres-weekly-settlement-service.js";
import { createTestDatabase } from "../../../api/test/integration/postgres-test-database.mjs";
import { FullBackupSpool } from "../../dist/full-backup-spool.js";
import { readBackupSpoolDataset } from "../../dist/full-backup-spool-reader.js";
import { FullBackupTransformer, fullBackupOutputColumns } from "../../dist/full-backup-transformer.js";
import { PostgresFullBackupSource } from "../../dist/postgres-full-backup-source.js";

const at = new Date("2026-09-23T08:00:00.000Z");
const month = "2026-09-01";
const admin = (personId) => ({ personId, subject: "SYSTEM_ADMIN", scope: "GLOBAL" });
const json = (value) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);
const policy = {
  plannerBaseRateBasisPoints: 0n, teacherBaseRateBasisPoints: 0n, planningMentorWeightBasisPoints: 0n,
  groupLeaderRateBasisPoints: 0n, teachingMentorRateBasisPoints: 500n, venueRateBasisPoints: 0n,
  campusConsultationForPlannerRateBasisPoints: 0n, campusConsultationForTeacherRateBasisPoints: 0n,
  platformFinanceRateBasisPoints: 0n, regionFinanceRateBasisPoints: 0n,
  dynamicTiers: [{ label: "全量", adjustmentBasisPoints: 0n }],
};

const addPerson = (pool, id, nickname) => pool.query(
  "INSERT INTO person(id,nickname,legal_name,status,created_at,updated_at) VALUES($1::uuid,$2,$2,'ACTIVE',$3::timestamptz,$3::timestamptz)",
  [id, nickname, at.toISOString()],
);
const addPersonalAccount = async (pool, personId, name) => {
  const id = randomUUID();
  await pool.query("INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status,created_at) VALUES($1::uuid,'PERSON',$2::uuid,$3,'ACTIVE',$4::timestamptz)", [id, personId, `person:${name}:${personId}`, at.toISOString()]);
  await pool.query("INSERT INTO account_balance_projection(account_id,balance_cents,updated_at) VALUES($1::uuid,0,$2::timestamptz)", [id, at.toISOString()]);
  return id;
};
const addTeachingMentorCandidate = async (pool, id, nickname, adminId) => {
  await addPerson(pool, id, nickname);
  const accountId = await addPersonalAccount(pool, id, nickname);
  const roleId = randomUUID();
  await pool.query("INSERT INTO user_account(id,person_id,phone_normalized,password_hash,login_status,created_at,updated_at) VALUES($1::uuid,$2::uuid,$3,$4,'ACTIVE',$5::timestamptz,$5::timestamptz)", [randomUUID(), id, `138${Math.floor(Math.random() * 90000000 + 10000000)}`, `$argon2id$${nickname}-secret`, at.toISOString()]);
  await pool.query("INSERT INTO role_assignment(id,person_id,subject_code,scope_type,scope_id,valid_from,created_by,created_at) VALUES($1::uuid,$2::uuid,'TEACHING_MENTOR','MENTEES',NULL,'2026-01-01T00:00:00.000Z',$3::uuid,$4::timestamptz)", [roleId, id, adminId, at.toISOString()]);
  return { accountId, roleId };
};
const spoolRows = async (root, spool, tableName) => {
  const dataset = spool.datasets.find((item) => item.tableName === tableName);
  assert.ok(dataset && !dataset.excluded, tableName);
  const rows = [];
  for await (const row of readBackupSpoolDataset(join(root, "spool", spool.spoolId), dataset)) rows.push(Object.fromEntries(dataset.columns.map((column, index) => [column, row[index]])));
  return rows;
};

test("real teaching-mentor change facts are traceable from PostgreSQL into the protected spool", async (t) => {
  if (!process.env.DATABASE_URL) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-teaching-mentor-backup-pg-"));
  try {
    const ids = Object.fromEntries(["admin", "teacher", "mentorA", "mentorB", "venue", "year", "period", "week", "throughWeek", "student", "referral", "policy"].map((key) => [key, randomUUID()]));
    await addPerson(database.pool, ids.admin, "教学导师变更管理员");
    await database.pool.query("INSERT INTO role_assignment(id,person_id,subject_code,scope_type,scope_id,valid_from,created_by,created_at) VALUES($1::uuid,$2::uuid,'SYSTEM_ADMIN','GLOBAL',NULL,'2026-01-01T00:00:00.000Z',$2::uuid,$3::timestamptz)", [randomUUID(), ids.admin, at.toISOString()]);
    await addPerson(database.pool, ids.teacher, "被调教学导师教师");
    await addPersonalAccount(database.pool, ids.teacher, "teacher");
    const mentorA = await addTeachingMentorCandidate(database.pool, ids.mentorA, "教学导师A", ids.admin);
    const mentorB = await addTeachingMentorCandidate(database.pool, ids.mentorB, "教学导师B", ids.admin);
    await database.pool.query("INSERT INTO teacher_profile(person_id,business_identity,employment_status,created_at,updated_at) VALUES($1::uuid,'TEACHING_TEACHER','ACTIVE',$2::timestamptz,$2::timestamptz)", [ids.teacher, at.toISOString()]);
    const oldRelationshipId = randomUUID();
    await database.pool.query("INSERT INTO person_relationship(id,teacher_id,relationship_type,related_person_id,valid_from,effective_scope,created_by,created_at) VALUES($1::uuid,$2::uuid,'TEACHING_MENTOR',$3::uuid,'2026-01-01T00:00:00.000Z','REGULAR_WEEK:legacy',$4::uuid,$5::timestamptz)", [oldRelationshipId, ids.teacher, ids.mentorA, ids.admin, at.toISOString()]);
    await database.pool.query("INSERT INTO venue(id,owner_person_id,name,status,default_for_owner,created_at,updated_at) VALUES($1::uuid,$2::uuid,'教学导师变更场地','ACTIVE',true,$3::timestamptz,$3::timestamptz)", [ids.venue, ids.teacher, at.toISOString()]);
    await database.pool.query("INSERT INTO academic_year_plan(id,label,starts_on,ends_on,created_by,created_at) VALUES($1::uuid,'教学导师变更学年','2026-09-01','2027-08-31',$2::uuid,$3::timestamptz)", [ids.year, ids.admin, at.toISOString()]);
    await database.pool.query("INSERT INTO academic_period(id,academic_year_plan_id,label,starts_on,ends_on,created_at) VALUES($1::uuid,$2::uuid,'教学导师变更秋季','2026-09-01','2027-01-31',$3::timestamptz)", [ids.period, ids.year, at.toISOString()]);
    await database.pool.query("INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month,status,created_at) VALUES($1::uuid,$2::uuid,1,'REGULAR','2026-09-21','2026-09-27',$3::date,'OPEN',$4::timestamptz)", [ids.week, ids.period, month, at.toISOString()]);
    await database.pool.query("INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month,status,created_at) VALUES($1::uuid,$2::uuid,2,'REGULAR','2026-09-28','2026-10-04',$3::date,'OPEN',$4::timestamptz)", [ids.throughWeek, ids.period, "2026-10-01", at.toISOString()]);
    await database.pool.query("INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name,created_at,updated_at) VALUES($1::uuid,$2::uuid,'teaching-mentor-course','教学导师变更学生',$3::timestamptz,$3::timestamptz)", [ids.student, ids.teacher, at.toISOString()]);
    await database.pool.query("INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,version,created_at,updated_at) VALUES($1::uuid,$2::uuid,$3::uuid,$3::uuid,'TEACHING_TEACHER','ACCEPTED',$4::timestamptz,2,$4::timestamptz,$4::timestamptz)", [ids.referral, ids.student, ids.teacher, at.toISOString()]);
    await database.pool.query("INSERT INTO rate_policy_version(id,version,effective_from,policy_json,reason,published_by,published_at) VALUES($1::uuid,1,$2::date,$3::jsonb,'教学导师变更费率',$4::uuid,$5::timestamptz)", [ids.policy, month, json(policy), ids.admin, at.toISOString()]);
    await new PostgresWeeklySettlementService(database.pool).recordAndSettle(ids.teacher, { referralCaseId: ids.referral, teachingWeekId: ids.week, venueId: ids.venue, settlementMonth: month, grossAmountCents: 1000n, expectedVersion: 0 }, "teaching-mentor-initial-settlement");

    const service = new PostgresTeachingMentorRelationshipService(database.pool);
    assert.deepEqual((await service.listCandidates(admin(ids.admin), at)).map((item) => item.personId).sort(), [ids.mentorA, ids.mentorB].sort());
    const preview = await service.preview(admin(ids.admin), { teacherPersonId: ids.teacher, newRelatedPersonId: ids.mentorB, effectiveTeachingWeekId: ids.week, reason: "改为教学导师B" }, at);
    assert.deepEqual([preview.consideredFeeCount, preview.movedFeeCount, preview.movedAmountCents], [1, 1, "50"]);
    assert.equal(preview.effectiveThroughTeachingWeekId, null);
    const change = await service.publish(admin(ids.admin), preview.previewId, "teaching-mentor-original-key", at);
    assert.equal(change.postingStatus, "POSTED");

    // The production service change above exercises the published balance-moving
    // path.  Seed one already-persisted bounded replacement too, so the export
    // must retain the continuation edge added by migration 0038.  Constraint
    // triggers are bypassed only for this archival fixture; its JSON follows
    // the exact persisted service shape and is validated by the transformer.
    const firstAfter = (await database.pool.query("SELECT after_json FROM teaching_mentor_relationship_change WHERE id=$1::uuid", [change.changeId])).rows[0].after_json;
    const manualPreviewId = randomUUID();
    const manualChangeId = randomUUID();
    const manualResultId = randomUUID();
    const continuationId = randomUUID();
    const boundedFrom = "2026-09-27T16:00:00.000Z";
    const boundedTo = "2026-10-04T16:00:00.000Z";
    const manualSource = { ...firstAfter.resultRelationship, validTo: boundedFrom };
    const manualResult = { ...manualSource, id: manualResultId, relatedPersonId: ids.mentorA, validFrom: boundedFrom, validTo: boundedTo, effectiveScope: `REGULAR_WEEK:${ids.throughWeek}`, createdByPersonId: ids.admin, createdAt: at.toISOString(), supersededAt: null, supersededByChangeId: null };
    const continuation = { ...manualSource, id: continuationId, validFrom: boundedTo, validTo: null, effectiveScope: manualSource.effectiveScope, createdByPersonId: ids.admin, createdAt: at.toISOString(), supersededAt: null, supersededByChangeId: null };
    const boundedImpact = {
      schemaVersion: "teaching-mentor-change-preview.v1", teacherPersonId: ids.teacher,
      effectiveWeek: { id: ids.throughWeek, startsOn: "2026-09-28", endsOn: "2026-10-04", settlementMonth: "2026-10-01", kind: "REGULAR" },
      effectiveAt: boundedFrom, nextBoundaryAt: boundedTo, effectiveThroughTeachingWeekId: ids.throughWeek,
      sourceRelationship: manualSource, nextRelationship: null,
      candidate: { personId: ids.mentorA, nickname: "教学导师A", userAccountId: randomUUID(), roleAssignmentId: mentorA.roleId, roleValidFrom: "2026-01-01T00:00:00.000Z", roleValidTo: null },
      destinationAccount: { id: mentorA.accountId, code: `person:教学导师A:${ids.mentorA}`, ownerType: "PERSON", ownerId: ids.mentorA, status: "ACTIVE" },
      reason: "限定两周后恢复原教学导师", fees: [], totals: { consideredFeeCount: 0, movedFeeCount: 0, zeroShareFeeCount: 0, excludedRefundCount: 0, movedAmountCents: "0" },
    };
    const fixture = await database.pool.connect();
    try {
      await fixture.query("SET session_replication_role = replica");
      await fixture.query("UPDATE person_relationship SET valid_to=$2::timestamptz WHERE id=$1::uuid", [change.resultRelationshipId, boundedFrom]);
      await fixture.query("INSERT INTO person_relationship(id,teacher_id,relationship_type,related_person_id,valid_from,valid_to,effective_scope,created_by,created_at) VALUES($1::uuid,$2::uuid,'TEACHING_MENTOR',$3::uuid,$4::timestamptz,$5::timestamptz,$6,$7::uuid,$8::timestamptz)", [manualResultId, ids.teacher, ids.mentorA, boundedFrom, boundedTo, `REGULAR_WEEK:${ids.throughWeek}`, ids.admin, at.toISOString()]);
      await fixture.query("INSERT INTO person_relationship(id,teacher_id,relationship_type,related_person_id,valid_from,valid_to,effective_scope,created_by,created_at) VALUES($1::uuid,$2::uuid,'TEACHING_MENTOR',$3::uuid,$4::timestamptz,NULL,$5,$6::uuid,$7::timestamptz)", [continuationId, ids.teacher, ids.mentorB, boundedTo, manualSource.effectiveScope, ids.admin, at.toISOString()]);
      await fixture.query("INSERT INTO teaching_mentor_relationship_change_preview(id,action,relationship_type,teacher_person_id,source_relationship_id,source_related_person_id,new_related_person_id,candidate_role_assignment_id,effective_teaching_week_id,effective_through_teaching_week_id,effective_at,next_boundary_at,reason,base_hash,impact_json,created_by_person_id,actor_subject_code,actor_scope_type,created_at) VALUES($1::uuid,'REPLACE','TEACHING_MENTOR',$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,$9::timestamptz,$10::timestamptz,$11,$12,$13::jsonb,$14::uuid,'SYSTEM_ADMIN','GLOBAL',$15::timestamptz)", [manualPreviewId, ids.teacher, change.resultRelationshipId, ids.mentorB, ids.mentorA, mentorA.roleId, ids.throughWeek, ids.throughWeek, boundedFrom, boundedTo, "限定两周后恢复原教学导师", "b".repeat(64), json(boundedImpact), ids.admin, at.toISOString()]);
      await fixture.query("INSERT INTO teaching_mentor_relationship_change(id,preview_id,action,relationship_type,teacher_person_id,relationship_version,source_relationship_id,result_relationship_id,continuation_relationship_id,source_related_person_id,new_related_person_id,candidate_role_assignment_id,effective_teaching_week_id,effective_through_teaching_week_id,effective_at,next_boundary_at,reason,idempotency_key,request_hash,base_hash,posting_status,settlement_calculation_run_id,ledger_event_id,considered_fee_count,moved_fee_count,excluded_refund_count,moved_amount_cents,before_json,after_json,published_by_person_id,actor_subject_code,actor_scope_type,published_at,created_at) VALUES($1::uuid,$2::uuid,'REPLACE','TEACHING_MENTOR',$3::uuid,2,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,$9::uuid,$10::uuid,$11::uuid,$12::timestamptz,$13::timestamptz,$14,'fixture-idempotency-key',$15,$16,'NO_BALANCE_CHANGE',NULL,NULL,0,0,0,0,$17::jsonb,$18::jsonb,$19::uuid,'SYSTEM_ADMIN','GLOBAL',$20::timestamptz,$20::timestamptz)", [manualChangeId, manualPreviewId, ids.teacher, change.resultRelationshipId, manualResultId, continuationId, ids.mentorB, ids.mentorA, mentorA.roleId, ids.throughWeek, ids.throughWeek, boundedFrom, boundedTo, "限定两周后恢复原教学导师", "c".repeat(64), "b".repeat(64), json({ sourceRelationship: manualSource }), json({ sourceRelationship: manualSource, resultRelationship: manualResult, continuationRelationship: continuation }), ids.admin, at.toISOString()]);
    } finally {
      await fixture.query("SET session_replication_role = origin");
      fixture.release();
    }

    const sourceJson = await database.pool.query("SELECT 'preview' AS kind,id::text,impact_json::text AS payload FROM teaching_mentor_relationship_change_preview UNION ALL SELECT 'change-before',id::text,before_json::text FROM teaching_mentor_relationship_change UNION ALL SELECT 'change-after',id::text,after_json::text FROM teaching_mentor_relationship_change ORDER BY kind,id");
    const jsonBytes = new Map(sourceJson.rows.map((row) => [`${row.kind}:${row.id}`, row.payload]));
    const spool = await new FullBackupSpool({ source: new PostgresFullBackupSource(database.pool), transformer: new FullBackupTransformer({ fingerprint: ({ domain, value }) => createHash("sha256").update(`${domain}:${value}`).digest("hex") }), tempRoot: join(root, "spool"), batchSize: 1 }).create();
    for (const tableName of ["teaching_mentor_relationship_change_preview", "teaching_mentor_relationship_change", "teaching_mentor_relationship_change_effect"]) assert.equal(fullBackupOutputColumns(tableName).includes("idempotency_key"), false, `${tableName} excludes raw idempotency keys`);
    assert.equal(fullBackupOutputColumns("teaching_mentor_relationship_change").includes("idempotency_key_fingerprint"), true);
    const previews = await spoolRows(root, spool, "teaching_mentor_relationship_change_preview");
    const changes = await spoolRows(root, spool, "teaching_mentor_relationship_change");
    const effects = await spoolRows(root, spool, "teaching_mentor_relationship_change_effect");
    assert.deepEqual([previews.length, changes.length, effects.length], [2, 2, 1]);
    assert.equal(JSON.stringify({ previews, changes, effects }).includes("teaching-mentor-original-key"), false);
    assert.equal(JSON.stringify({ previews, changes, effects }).includes("fixture-idempotency-key"), false);
    const publishedChange = changes.find((row) => row.id === change.changeId);
    const boundedChange = changes.find((row) => row.id === manualChangeId);
    assert.ok(publishedChange && boundedChange);
    assert.equal(publishedChange.idempotency_key_fingerprint.length, 64);
    assert.equal(boundedChange.idempotency_key_fingerprint.length, 64);
    assert.equal(previews.find((row) => row.id === preview.previewId).impact_json, jsonBytes.get(`preview:${preview.previewId}`));
    assert.equal(previews.find((row) => row.id === manualPreviewId).impact_json, jsonBytes.get(`preview:${manualPreviewId}`));
    assert.equal(publishedChange.before_json, jsonBytes.get(`change-before:${change.changeId}`));
    assert.equal(publishedChange.after_json, jsonBytes.get(`change-after:${change.changeId}`));
    assert.equal(boundedChange.before_json, jsonBytes.get(`change-before:${manualChangeId}`));
    assert.equal(boundedChange.after_json, jsonBytes.get(`change-after:${manualChangeId}`));
    assert.equal(publishedChange.effective_through_teaching_week_id, null);
    assert.equal(boundedChange.effective_through_teaching_week_id, ids.throughWeek);
    assert.equal(boundedChange.continuation_relationship_id, continuationId);
    const afterJson = JSON.parse(boundedChange.after_json);
    assert.deepEqual(afterJson.continuationRelationship, continuation);
    assert.deepEqual([effects[0].source_account_id, effects[0].destination_account_id, effects[0].teaching_mentor_amount_cents], [mentorA.accountId, mentorB.accountId, "50"]);
    const relationships = await spoolRows(root, spool, "person_relationship");
    const sourceRelationship = relationships.find((row) => row.id === oldRelationshipId);
    assert.ok(sourceRelationship, "source relationship remains a RAW fact");
    assert.equal(sourceRelationship.superseded_by_teaching_mentor_change_id, null);
    assert.equal(new Date(sourceRelationship.valid_to).toISOString(), "2026-09-20T16:00:00.000Z");
    const continuationRow = relationships.find((row) => row.id === boundedChange.continuation_relationship_id);
    assert.ok(continuationRow, "截止周后原教学导师以续接关系保留");
    assert.deepEqual([continuationRow.related_person_id, new Date(continuationRow.valid_from).toISOString()], [ids.mentorB, "2026-10-04T16:00:00.000Z"]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await database.close();
  }
});
