import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresReferralCreationService } from "../../dist/postgres-referral-creation-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const at = new Date("2026-09-21T04:00:00.000Z");
const contextFor = (personId, subject = "ACADEMIC_PLANNER") => ({ personId, subject });

const addFee = async (pool, { referralId, teacherId }) => {
  const [venueId, yearId, periodId, weekId] = Array.from({ length: 4 }, () => randomUUID());
  await pool.query("INSERT INTO venue(id,owner_person_id,name,status) VALUES ($1::uuid,$2::uuid,'复制来源场地','ACTIVE')", [venueId, teacherId]);
  await pool.query("INSERT INTO academic_year_plan(id,label,starts_on,ends_on,created_by) VALUES ($1::uuid,$2,'2026-09-01','2027-08-31',$3::uuid)", [yearId, `copy-${yearId}`, teacherId]);
  await pool.query("INSERT INTO academic_period(id,academic_year_plan_id,label,starts_on,ends_on) VALUES ($1::uuid,$2::uuid,'合成学期','2026-09-01','2027-01-31')", [periodId, yearId]);
  await pool.query("INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month) VALUES ($1::uuid,$2::uuid,1,'REGULAR','2026-09-21','2026-09-27','2026-09-01')", [weekId, periodId]);
  await pool.query(
    `INSERT INTO weekly_fee_entry(referral_case_id,teaching_week_id,settlement_month,gross_amount_cents,venue_id,venue_owner_person_id,is_self_use_snapshot,source_case_version,version,created_by)
     VALUES ($1::uuid,$2::uuid,'2026-09-01',98765,$3::uuid,$4::uuid,true,1,1,$4::uuid)`,
    [referralId, weekId, venueId, teacherId]
  );
};

test("真实 PostgreSQL 再推复制独立建档，不复制费用、场地或接收状态", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const { pool } = db;
  const [plannerId, firstTeacherId, secondTeacherId, outsiderId] = Array.from({ length: 4 }, () => randomUUID());
  const [regionId, campusId] = [randomUUID(), randomUUID()];
  try {
    for (const id of [plannerId, firstTeacherId, secondTeacherId, outsiderId]) {
      await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES ($1::uuid,$2,'合成人员','ACTIVE')", [id, `copy-${id}`]);
    }
    await pool.query("INSERT INTO organization_unit(id,unit_type,name) VALUES ($1::uuid,'REGION','复制分区'),($2::uuid,'CAMPUS','复制校区')", [regionId, campusId]);
    for (const [id, identity] of [[plannerId, "ACADEMIC_PLANNER"], [firstTeacherId, "TEACHING_TEACHER"], [secondTeacherId, "TEACHING_TEACHER"], [outsiderId, "ACADEMIC_PLANNER"]]) {
      await pool.query("INSERT INTO teacher_profile(person_id,business_identity,employment_status) VALUES ($1::uuid,$2,'ACTIVE')", [id, identity]);
      await pool.query("INSERT INTO person_campus_assignment(person_id,campus_id,region_id,valid_from,created_by) VALUES ($1::uuid,$2::uuid,$3::uuid,'2026-01-01',$1::uuid)", [id, campusId, regionId]);
    }
    const service = new PostgresReferralCreationService(pool);
    const source = await service.create(contextFor(plannerId), {
      receiverPersonId: firstTeacherId, studentDisplayName: "同名复制学生", courseContextId: "数学", classType: "ONE_TO_ONE"
    }, "normal-create-key", at);
    assert.equal(source.replay, false);
    await addFee(pool, { referralId: source.referralId, teacherId: firstTeacherId });
    await pool.query("UPDATE referral_case SET status='ARCHIVED',version=version+1 WHERE id=$1", [source.referralId]);
    const originalBefore = await pool.query("SELECT status,version::text AS version,submitted_at::text AS submitted_at FROM referral_case WHERE id=$1", [source.referralId]);

    const results = await Promise.all(Array.from({ length: 4 }, () => service.copy(contextFor(plannerId), source.referralId, {
      receiverPersonId: secondTeacherId
    }, "copy-same-key", at)));
    assert.equal(results.filter((result) => !result.replay).length, 1);
    assert.equal(new Set(results.map((result) => result.referralId)).size, 1);
    const copied = results[0];
    assert.equal(copied.copiedFromReferralId, source.referralId);
    const copyRow = (await pool.query(
      `SELECT referral.copied_from_referral_id::text AS copied_from_referral_id,referral.status,
              referral.unaccepted_expires_at::text AS unaccepted_expires_at,student.owner_teacher_id::text AS owner_teacher_id,
              student.course_context_id,student.display_name
         FROM referral_case referral JOIN teacher_student_record student ON student.id=referral.teacher_student_record_id
        WHERE referral.id=$1`, [copied.referralId]
    )).rows[0];
    assert.deepEqual(copyRow, {
      copied_from_referral_id: source.referralId,
      status: "PENDING",
      unaccepted_expires_at: "2026-10-12 04:00:00+00",
      owner_teacher_id: secondTeacherId,
      course_context_id: "数学",
      display_name: "同名复制学生"
    });
    assert.deepEqual((await pool.query("SELECT class_type,collector_person_id::text AS collector_person_id FROM referral_creation_snapshot WHERE referral_case_id=$1", [copied.referralId])).rows[0], { class_type: "ONE_TO_ONE", collector_person_id: secondTeacherId });
    assert.deepEqual((await pool.query("SELECT event_type,reason,result_referral_version::text AS result_referral_version FROM referral_case_event WHERE referral_case_id=$1", [copied.referralId])).rows[0], { event_type: "COPIED", reason: `COPIED_FROM_REFERRAL:${source.referralId}`, result_referral_version: "1" });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM weekly_fee_entry WHERE referral_case_id=$1", [copied.referralId])).rows[0].n, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM referral_acceptance_snapshot WHERE referral_case_id=$1", [copied.referralId])).rows[0].n, 0);
    assert.deepEqual(await pool.query("SELECT status,version::text AS version,submitted_at::text AS submitted_at FROM referral_case WHERE id=$1", [source.referralId]), originalBefore);

    await pool.query("UPDATE teacher_student_record SET display_name='后改来源学生',course_context_id='后改课程' WHERE id=$1", [source.studentRecordId]);
    await pool.query("UPDATE referral_case SET copied_from_referral_id=NULL WHERE id=$1", [copied.referralId]);
    const replayAfterSourceEdit = await service.copy(contextFor(plannerId), source.referralId, { receiverPersonId: secondTeacherId }, "copy-same-key", new Date("2026-10-01T00:00:00.000Z"));
    assert.deepEqual(replayAfterSourceEdit, { ...copied, replay: true });
    await assert.rejects(service.copy(contextFor(plannerId), source.referralId, { receiverPersonId: secondTeacherId, courseContextId: "英语" }, "copy-same-key", at), /IDEMPOTENCY_REPLAY/);
    await assert.rejects(service.copy(contextFor(plannerId), source.referralId, { receiverPersonId: firstTeacherId, courseContextId: "后改课程" }, "unchanged-target", at), /REFERRAL_COPY_TARGET_UNCHANGED/);
    await assert.rejects(service.copy(contextFor(plannerId), source.referralId, { receiverPersonId: firstTeacherId.toUpperCase(), courseContextId: "后改课程" }, "unchanged-target-uppercase", at), /REFERRAL_COPY_TARGET_UNCHANGED/);
    await assert.rejects(service.copy(contextFor(outsiderId), source.referralId, { receiverPersonId: secondTeacherId }, "not-source", at), /FORBIDDEN_SCOPE/);
    await assert.rejects(service.copy(contextFor(plannerId), source.referralId, { receiverPersonId: secondTeacherId }, "normal-create-key", at), /IDEMPOTENCY_REPLAY/);
  } finally {
    await db.close();
  }
});

test("旧推荐缺少班型快照时必须显式指定，失败不创建半条记录", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const { pool } = db;
  const [plannerId, firstTeacherId, secondTeacherId] = Array.from({ length: 3 }, () => randomUUID());
  const sourceStudentId = randomUUID();
  const sourceReferralId = randomUUID();
  const [regionId, campusId] = [randomUUID(), randomUUID()];
  try {
    for (const id of [plannerId, firstTeacherId, secondTeacherId]) {
      await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES ($1::uuid,$2,'合成人员','ACTIVE')", [id, `legacy-copy-${id}`]);
    }
    await pool.query("INSERT INTO organization_unit(id,unit_type,name) VALUES ($1::uuid,'REGION','旧复制分区'),($2::uuid,'CAMPUS','旧复制校区')", [regionId, campusId]);
    for (const [id, identity] of [[plannerId, "ACADEMIC_PLANNER"], [firstTeacherId, "TEACHING_TEACHER"], [secondTeacherId, "TEACHING_TEACHER"]]) {
      await pool.query("INSERT INTO teacher_profile(person_id,business_identity,employment_status) VALUES ($1::uuid,$2,'ACTIVE')", [id, identity]);
      await pool.query("INSERT INTO person_campus_assignment(person_id,campus_id,region_id,valid_from,created_by) VALUES ($1::uuid,$2::uuid,$3::uuid,'2026-01-01',$1::uuid)", [id, campusId, regionId]);
    }
    await pool.query("INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name) VALUES ($1::uuid,$2::uuid,'旧课程','旧学生')", [sourceStudentId, firstTeacherId]);
    await pool.query("INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,unaccepted_expires_at) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'ACADEMIC_PLANNER','ARCHIVED','2026-09-01','2026-09-22')", [sourceReferralId, sourceStudentId, plannerId, firstTeacherId]);
    const service = new PostgresReferralCreationService(pool);
    const before = await pool.query("SELECT count(*)::int AS n FROM referral_case");
    await assert.rejects(service.copy(contextFor(plannerId), sourceReferralId, { receiverPersonId: secondTeacherId }, "legacy-missing-class", at), /INVALID_INPUT/);
    assert.deepEqual(await pool.query("SELECT count(*)::int AS n FROM referral_case"), before);
    const copied = await service.copy(contextFor(plannerId), sourceReferralId, { receiverPersonId: secondTeacherId, classType: "SMALL_GROUP" }, "legacy-explicit-class", at);
    assert.equal((await pool.query("SELECT class_type FROM referral_creation_snapshot WHERE referral_case_id=$1", [copied.referralId])).rows[0].class_type, "SMALL_GROUP");
    const beforeFailure=(await pool.query(`SELECT (SELECT count(*) FROM teacher_student_record)::int AS students,(SELECT count(*) FROM referral_case)::int AS referrals,(SELECT count(*) FROM referral_case_event)::int AS events`)).rows[0];
    await pool.query(`CREATE FUNCTION reject_copy_idempotency() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_copy_failure'; END $$`);
    await pool.query(`CREATE TRIGGER reject_copy_idempotency BEFORE INSERT ON referral_creation_idempotency FOR EACH ROW EXECUTE FUNCTION reject_copy_idempotency()`);
    await assert.rejects(service.copy(contextFor(plannerId),sourceReferralId,{receiverPersonId:secondTeacherId,classType:'SMALL_GROUP',courseContextId:'失败课程'},'copy-rollback',at),/synthetic_copy_failure/);
    assert.deepEqual((await pool.query(`SELECT (SELECT count(*) FROM teacher_student_record)::int AS students,(SELECT count(*) FROM referral_case)::int AS referrals,(SELECT count(*) FROM referral_case_event)::int AS events`)).rows[0],beforeFailure);

  } finally {
    await db.close();
  }
});
