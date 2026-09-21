import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresReferralExpiryService } from "../../dist/postgres-referral-expiry-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const at = new Date("2026-09-21T04:00:00.000Z");

const addReferral = async (pool, { referrerId, receiverId, status = "PENDING", expiresAt }) => {
  const studentId = randomUUID();
  const referralId = randomUUID();
  await pool.query(
    `INSERT INTO teacher_student_record(id, owner_teacher_id, course_context_id, display_name)
     VALUES ($1::uuid, $2::uuid, $3, '合成到期学生')`,
    [studentId, receiverId, `course-${studentId}`]
  );
  await pool.query(
    `INSERT INTO referral_case(
       id, teacher_student_record_id, referrer_person_id, receiver_person_id, referrer_identity,
       status, submitted_at, unaccepted_expires_at
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACADEMIC_PLANNER', $5, '2026-09-01T04:00:00.000Z', $6::timestamptz)`,
    [referralId, studentId, referrerId, receiverId, status, expiresAt]
  );
  return { referralId, studentId };
};

const addFee = async (pool, { referralId, teacherId }) => {
  const [venueId, yearId, periodId, weekId] = Array.from({ length: 4 }, () => randomUUID());
  await pool.query("INSERT INTO venue(id,owner_person_id,name,status) VALUES ($1::uuid,$2::uuid,'合成场地','ACTIVE')", [venueId, teacherId]);
  await pool.query("INSERT INTO academic_year_plan(id,label,starts_on,ends_on,created_by) VALUES ($1::uuid,$2,'2026-09-01','2027-08-31',$3::uuid)", [yearId, `expiry-${yearId}`, teacherId]);
  await pool.query("INSERT INTO academic_period(id,academic_year_plan_id,label,starts_on,ends_on) VALUES ($1::uuid,$2::uuid,'合成学期','2026-09-01','2027-01-31')", [periodId, yearId]);
  await pool.query("INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month) VALUES ($1::uuid,$2::uuid,1,'REGULAR','2026-09-21','2026-09-27','2026-09-01')", [weekId, periodId]);
  await pool.query(
    `INSERT INTO weekly_fee_entry(
       referral_case_id,teaching_week_id,settlement_month,gross_amount_cents,venue_id,
       venue_owner_person_id,is_self_use_snapshot,source_case_version,version,created_by
     ) VALUES ($1::uuid,$2::uuid,'2026-09-01',45678,$3::uuid,$4::uuid,true,1,1,$4::uuid)`,
    [referralId, weekId, venueId, teacherId]
  );
  return venueId;
};

test("真实 PostgreSQL 到期任务精确归档待接收记录，保留费用、账务和系统审计", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const { pool } = db;
  const [plannerId, teacherId] = [randomUUID(), randomUUID()];
  try {
    for (const id of [plannerId, teacherId]) {
      await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES ($1::uuid,$2,'合成人员','ACTIVE')", [id, `expiry-${id}`]);
    }
    const service = new PostgresReferralExpiryService(pool);
    const exact = await addReferral(pool, { referrerId: plannerId, receiverId: teacherId, expiresAt: at });
    const reactivated = await addReferral(pool, { referrerId: plannerId, receiverId: teacherId, status: "REACTIVATED", expiresAt: new Date(at.getTime() - 1) });
    const afterBoundary = await addReferral(pool, { referrerId: plannerId, receiverId: teacherId, expiresAt: new Date(at.getTime() + 1) });
    const noExpiry = await addReferral(pool, { referrerId: plannerId, receiverId: teacherId, expiresAt: null });
    const accepted = await addReferral(pool, { referrerId: plannerId, receiverId: teacherId, status: "ACCEPTED", expiresAt: new Date(at.getTime() - 1) });
    const archived = await addReferral(pool, { referrerId: plannerId, receiverId: teacherId, status: "ARCHIVED", expiresAt: new Date(at.getTime() - 1) });
    const feeVenueId = await addFee(pool, { referralId: exact.referralId, teacherId });
    const ledgerBefore = await pool.query("SELECT (SELECT count(*) FROM ledger_event)::int AS events,(SELECT count(*) FROM ledger_entry)::int AS entries,(SELECT count(*) FROM account_balance_projection)::int AS projections");

    const result = await service.run(at, 100);
    assert.deepEqual(result.archivedReferralIds.sort(), [exact.referralId, reactivated.referralId].sort());
    const rows = await pool.query("SELECT id::text,status,version::text FROM referral_case ORDER BY id", []);
    const statusById = new Map(rows.rows.map((row) => [row.id, `${row.status}:${row.version}`]));
    assert.equal(statusById.get(exact.referralId), "ARCHIVED:2");
    assert.equal(statusById.get(reactivated.referralId), "ARCHIVED:2");
    assert.equal(statusById.get(afterBoundary.referralId), "PENDING:1");
    assert.equal(statusById.get(noExpiry.referralId), "PENDING:1");
    assert.equal(statusById.get(accepted.referralId), "ACCEPTED:1");
    assert.equal(statusById.get(archived.referralId), "ARCHIVED:1");
    assert.deepEqual((await pool.query("SELECT venue_id::text AS venue_id,gross_amount_cents::text AS gross_amount_cents,version::text AS version FROM weekly_fee_entry WHERE referral_case_id=$1", [exact.referralId])).rows[0], { venue_id: feeVenueId, gross_amount_cents: "45678", version: "1" });
    assert.deepEqual((await pool.query("SELECT (SELECT count(*) FROM ledger_event)::int AS events,(SELECT count(*) FROM ledger_entry)::int AS entries,(SELECT count(*) FROM account_balance_projection)::int AS projections")).rows[0], ledgerBefore.rows[0]);

    const systemEvents = await pool.query(
      "SELECT referral_case_id::text AS referral_case_id,actor_person_id,actor_type,reason FROM referral_case_event WHERE event_type='ARCHIVED' ORDER BY referral_case_id"
    );
    assert.deepEqual(systemEvents.rows, [
      { referral_case_id: exact.referralId, actor_person_id: null, actor_type: "SYSTEM", reason: "UNACCEPTED_EXPIRED" },
      { referral_case_id: reactivated.referralId, actor_person_id: null, actor_type: "SYSTEM", reason: "UNACCEPTED_EXPIRED" }
    ].sort((left, right) => left.referral_case_id.localeCompare(right.referral_case_id)));
    await assert.rejects(pool.query("UPDATE referral_case_event SET reason='rewritten' WHERE referral_case_id=$1", [exact.referralId]), /REFERRAL_CASE_EVENT_IMMUTABLE/);
    assert.deepEqual(await service.run(at, 100), { archivedReferralIds: [] });
    await assert.rejects(service.run(new Date("invalid")), /INVALID_INPUT/);
    await assert.rejects(service.run(at, 0), /INVALID_INPUT/);
    await assert.rejects(service.run(at, 1001), /INVALID_INPUT/);
  } finally {
    await db.close();
  }
});

test("多任务不重复领取，到期事件失败时整批回滚", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const { pool } = db;
  const [plannerId, teacherId] = [randomUUID(), randomUUID()];
  try {
    for (const id of [plannerId, teacherId]) {
      await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES ($1::uuid,$2,'合成人员','ACTIVE')", [id, `race-${id}`]);
    }
    const service = new PostgresReferralExpiryService(pool);
    const due = await Promise.all(Array.from({ length: 4 }, () => addReferral(pool, {
      referrerId: plannerId, receiverId: teacherId, expiresAt: new Date(at.getTime() - 1)
    })));
    const concurrent = await Promise.all([service.run(at, 3), service.run(at, 3)]);
    const claimed = concurrent.flatMap((result) => result.archivedReferralIds);
    assert.equal(new Set(claimed).size, 4);
    assert.deepEqual(new Set(claimed), new Set(due.map((item) => item.referralId)));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM referral_case_event WHERE event_type='ARCHIVED'")).rows[0].n, 4);

    const rollbackReferral = await addReferral(pool, { referrerId: plannerId, receiverId: teacherId, expiresAt: new Date(at.getTime() - 1) });
    await pool.query("CREATE FUNCTION fail_expiry_event_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'FORCED_EXPIRY_EVENT_FAILURE'; END; $$");
    await pool.query("CREATE TRIGGER fail_expiry_event_insert BEFORE INSERT ON referral_case_event FOR EACH ROW EXECUTE FUNCTION fail_expiry_event_insert()");
    await assert.rejects(service.run(at, 100), /FORCED_EXPIRY_EVENT_FAILURE/);
    await pool.query("DROP TRIGGER fail_expiry_event_insert ON referral_case_event");
    assert.deepEqual((await pool.query("SELECT status,version::text AS version FROM referral_case WHERE id=$1", [rollbackReferral.referralId])).rows[0], { status: "PENDING", version: "1" });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM referral_case_event WHERE referral_case_id=$1", [rollbackReferral.referralId])).rows[0].n, 0);
  } finally {
    await db.close();
  }
});
