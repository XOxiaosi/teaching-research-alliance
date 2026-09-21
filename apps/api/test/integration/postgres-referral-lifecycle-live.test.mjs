import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresReferralLifecycleService } from "../../dist/postgres-referral-lifecycle-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const at = new Date("2026-09-21T04:00:00.000Z");
const contextFor = (personId, subject = "ACADEMIC_PLANNER") => ({ personId, subject });

const addReferral = async (pool, { referrerId, receiverId, status = "PENDING", expiresAt = new Date("2026-10-12T04:00:00.000Z") }) => {
  const studentId = randomUUID();
  const referralId = randomUUID();
  await pool.query("INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name) VALUES ($1::uuid,$2::uuid,$3,'合成生命周期学生')", [studentId, receiverId, `course-${studentId}`]);
  await pool.query(
    `INSERT INTO referral_case(
       id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,
       status,submitted_at,unaccepted_expires_at
     ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'ACADEMIC_PLANNER',$5,'2026-09-01T04:00:00.000Z',$6::timestamptz)`,
    [referralId, studentId, referrerId, receiverId, status, expiresAt]
  );
  return { referralId, studentId };
};

const addFee = async (pool, { referralId, teacherId }) => {
  const [venueId, yearId, periodId, weekId] = Array.from({ length: 4 }, () => randomUUID());
  await pool.query("INSERT INTO venue(id,owner_person_id,name,status) VALUES ($1::uuid,$2::uuid,'生命周期场地','ACTIVE')", [venueId, teacherId]);
  await pool.query("INSERT INTO academic_year_plan(id,label,starts_on,ends_on,created_by) VALUES ($1::uuid,$2,'2026-09-01','2027-08-31',$3::uuid)", [yearId, `lifecycle-${yearId}`, teacherId]);
  await pool.query("INSERT INTO academic_period(id,academic_year_plan_id,label,starts_on,ends_on) VALUES ($1::uuid,$2::uuid,'合成学期','2026-09-01','2027-01-31')", [periodId, yearId]);
  await pool.query("INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month) VALUES ($1::uuid,$2::uuid,1,'REGULAR','2026-09-21','2026-09-27','2026-09-01')", [weekId, periodId]);
  await pool.query(
    `INSERT INTO weekly_fee_entry(
       referral_case_id,teaching_week_id,settlement_month,gross_amount_cents,venue_id,
       venue_owner_person_id,is_self_use_snapshot,source_case_version,version,created_by
     ) VALUES ($1::uuid,$2::uuid,'2026-09-01',76543,$3::uuid,$4::uuid,true,1,1,$4::uuid)`,
    [referralId, weekId, venueId, teacherId]
  );
  return venueId;
};

test("真实 PostgreSQL 推荐软归档与重推冻结原结果，保留学生、费用和账务", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const { pool } = db;
  const [plannerId, receiverId, otherId] = Array.from({ length: 3 }, () => randomUUID());
  try {
    for (const id of [plannerId, receiverId, otherId]) {
      await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES ($1::uuid,$2,'合成人员','ACTIVE')", [id, `lifecycle-${id}`]);
    }
    const service = new PostgresReferralLifecycleService(pool);
    const record = await addReferral(pool, { referrerId: plannerId, receiverId });
    const feeVenueId = await addFee(pool, { referralId: record.referralId, teacherId: receiverId });
    const ledgerBefore = await pool.query("SELECT (SELECT count(*) FROM ledger_event)::int AS events,(SELECT count(*) FROM ledger_entry)::int AS entries,(SELECT count(*) FROM account_balance_projection)::int AS projections");

    const archived = await service.archive(contextFor(plannerId), record.referralId, { expectedVersion: 1 }, "archive-key", at);
    assert.deepEqual(archived, { referralId: record.referralId, status: "ARCHIVED", version: 2, unacceptedExpiresAt: "2026-10-12T04:00:00.000Z", replay: false });
    assert.deepEqual((await pool.query("SELECT submitted_at::text AS submitted_at,status,version::text AS version FROM referral_case WHERE id=$1", [record.referralId])).rows[0], { submitted_at: "2026-09-01 04:00:00+00", status: "ARCHIVED", version: "2" });
    assert.deepEqual((await pool.query("SELECT venue_id::text AS venue_id,gross_amount_cents::text AS gross_amount_cents,version::text AS version FROM weekly_fee_entry WHERE referral_case_id=$1", [record.referralId])).rows[0], { venue_id: feeVenueId, gross_amount_cents: "76543", version: "1" });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM teacher_student_record WHERE id=$1", [record.studentId])).rows[0].n, 1);
    assert.deepEqual((await pool.query("SELECT (SELECT count(*) FROM ledger_event)::int AS events,(SELECT count(*) FROM ledger_entry)::int AS entries,(SELECT count(*) FROM account_balance_projection)::int AS projections")).rows[0], ledgerBefore.rows[0]);
    assert.deepEqual((await pool.query("SELECT actor_person_id::text AS actor_person_id,actor_type,reason,result_referral_version::text AS result_referral_version FROM referral_case_event WHERE referral_case_id=$1", [record.referralId])).rows[0], { actor_person_id: plannerId, actor_type: "PERSON", reason: "REFERRER_ARCHIVED", result_referral_version: "2" });

    const reactivated = await service.reactivate(contextFor(plannerId, "PLANNING_MENTOR"), record.referralId, { expectedVersion: 2 }, "reactivate-key", at);
    assert.deepEqual(reactivated, { referralId: record.referralId, status: "REACTIVATED", version: 3, unacceptedExpiresAt: "2026-10-12T04:00:00.000Z", replay: false });
    const archiveReplay = await service.archive(contextFor(plannerId), record.referralId, { expectedVersion: 1 }, "archive-key", new Date("2026-10-01T00:00:00.000Z"));
    assert.deepEqual(archiveReplay, { ...archived, replay: true });
    await assert.rejects(service.reactivate(contextFor(plannerId), record.referralId, { expectedVersion: 3 }, "archive-key", at), /IDEMPOTENCY_REPLAY/);
    await assert.rejects(service.archive(contextFor(otherId), record.referralId, { expectedVersion: 3 }, "other-person", at), /FORBIDDEN_SCOPE/);
    await assert.rejects(service.archive({ personId: plannerId, subject: "REGION_FINANCE" }, record.referralId, { expectedVersion: 3 }, "wrong-role", at), /FORBIDDEN_SCOPE/);
    await assert.rejects(service.reactivate(contextFor(plannerId), record.referralId, { expectedVersion: 3 }, "state-conflict", at), /REFERRAL_STATE_CONFLICT/);
    await assert.rejects(service.archive(contextFor(plannerId), "not-a-uuid", { expectedVersion: 3 }, "invalid", at), /INVALID_INPUT/);
    await assert.rejects(pool.query("UPDATE referral_lifecycle_idempotency SET result_status='ARCHIVED' WHERE actor_person_id=$1", [plannerId]), /REFERRAL_LIFECYCLE_IDEMPOTENCY_IMMUTABLE/);
  } finally {
    await db.close();
  }
});

test("生命周期行锁避免并发重复，事件失败时没有部分写入", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const { pool } = db;
  const [plannerId, receiverId] = [randomUUID(), randomUUID()];
  try {
    for (const id of [plannerId, receiverId]) {
      await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES ($1::uuid,$2,'合成人员','ACTIVE')", [id, `lifecycle-race-${id}`]);
    }
    const service = new PostgresReferralLifecycleService(pool);
    const concurrentRecord = await addReferral(pool, { referrerId: plannerId, receiverId });
    const concurrent = await Promise.allSettled([
      service.archive(contextFor(plannerId), concurrentRecord.referralId, { expectedVersion: 1 }, "archive-concurrent-one", at),
      service.archive(contextFor(plannerId), concurrentRecord.referralId, { expectedVersion: 1 }, "archive-concurrent-two", at)
    ]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter((result) => result.status === "rejected").length, 1);
    assert.match(concurrent.find((result) => result.status === "rejected").reason.message, /VERSION_CONFLICT|REFERRAL_STATE_CONFLICT/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM referral_case_event WHERE referral_case_id=$1", [concurrentRecord.referralId])).rows[0].n, 1);

    const rollbackRecord = await addReferral(pool, { referrerId: plannerId, receiverId });
    await pool.query("CREATE FUNCTION fail_lifecycle_event_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'FORCED_LIFECYCLE_EVENT_FAILURE'; END; $$");
    await pool.query("CREATE TRIGGER fail_lifecycle_event_insert BEFORE INSERT ON referral_case_event FOR EACH ROW EXECUTE FUNCTION fail_lifecycle_event_insert()");
    await assert.rejects(service.archive(contextFor(plannerId), rollbackRecord.referralId, { expectedVersion: 1 }, "forced-rollback", at), /FORCED_LIFECYCLE_EVENT_FAILURE/);
    await pool.query("DROP TRIGGER fail_lifecycle_event_insert ON referral_case_event");
    assert.deepEqual((await pool.query("SELECT status,version::text AS version FROM referral_case WHERE id=$1", [rollbackRecord.referralId])).rows[0], { status: "PENDING", version: "1" });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM referral_case_event WHERE referral_case_id=$1", [rollbackRecord.referralId])).rows[0].n, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM referral_lifecycle_idempotency WHERE referral_case_id=$1", [rollbackRecord.referralId])).rows[0].n, 0);
  } finally {
    await db.close();
  }
});
