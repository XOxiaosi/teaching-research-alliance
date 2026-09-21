import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresReferralAcceptanceService } from "../../dist/postgres-referral-acceptance-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const at = new Date("2026-09-21T04:00:00.000Z");
const contextFor = (personId) => ({ personId, subject: "TEACHING_TEACHER" });

const addReferral = async (pool, { referrerId, receiverId, status = "PENDING", expiresAt = new Date("2026-10-12T04:00:00.000Z") }) => {
  const studentId = randomUUID();
  const referralId = randomUUID();
  await pool.query(
    `INSERT INTO teacher_student_record(id, owner_teacher_id, course_context_id, display_name)
     VALUES ($1::uuid, $2::uuid, $3, '合成接收学生')`,
    [studentId, receiverId, `course-${studentId}`]
  );
  await pool.query(
    `INSERT INTO referral_case(
       id, teacher_student_record_id, referrer_person_id, receiver_person_id, referrer_identity,
       status, submitted_at, unaccepted_expires_at
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACADEMIC_PLANNER', $5, $6::timestamptz, $7::timestamptz)`,
    [referralId, studentId, referrerId, receiverId, status, "2026-09-01T04:00:00.000Z", expiresAt]
  );
  return referralId;
};

const addVenue = async (pool, { ownerId, active = true, defaultForOwner = false, withAccount = true }) => {
  const venueId = randomUUID();
  await pool.query(
    `INSERT INTO venue(id, owner_person_id, name, status, default_for_owner)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
    [venueId, ownerId, `合成场地-${venueId}`, active ? "ACTIVE" : "INACTIVE", defaultForOwner]
  );
  if (withAccount) {
    await pool.query(
      `INSERT INTO settlement_account(owner_type, owner_id, account_code, status)
       VALUES ('VENUE', $1::uuid, $2, 'ACTIVE')`,
      [venueId, `venue-${venueId}`]
    );
  }
  return venueId;
};

const addWeek = async (pool, actorId) => {
  const [yearId, periodId, weekId] = [randomUUID(), randomUUID(), randomUUID()];
  await pool.query(
    `INSERT INTO academic_year_plan(id, label, starts_on, ends_on, created_by)
     VALUES ($1::uuid, $2, '2026-09-01', '2027-08-31', $3::uuid)`,
    [yearId, `合成学年-${yearId}`, actorId]
  );
  await pool.query(
    `INSERT INTO academic_period(id, academic_year_plan_id, label, starts_on, ends_on)
     VALUES ($1::uuid, $2::uuid, '合成学期', '2026-09-01', '2027-01-31')`,
    [periodId, yearId]
  );
  await pool.query(
    `INSERT INTO teaching_week(id, academic_period_id, sequence_no, week_kind, starts_on, ends_on, settlement_month)
     VALUES ($1::uuid, $2::uuid, 1, 'REGULAR', '2026-09-21', '2026-09-27', '2026-09-01')`,
    [weekId, periodId]
  );
  return weekId;
};

test("真实 PostgreSQL 首次接收锁定场地、账户与幂等快照", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const { pool } = db;
  const [plannerId, teacherId, otherTeacherId] = Array.from({ length: 3 }, () => randomUUID());
  try {
    for (const id of [plannerId, teacherId, otherTeacherId]) {
      await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES ($1::uuid,$2,'合成人员','ACTIVE')", [id, `accept-${id}`]);
    }
    const service = new PostgresReferralAcceptanceService(pool);
    const ownDefaultVenueId = await addVenue(pool, { ownerId: teacherId, defaultForOwner: true });
    const sharedVenueId = await addVenue(pool, { ownerId: otherTeacherId });
    const referralId = await addReferral(pool, { referrerId: plannerId, receiverId: teacherId });

    const results = await Promise.all(Array.from({ length: 5 }, () => service.accept(
      contextFor(teacherId), referralId, { venueId: sharedVenueId, expectedVersion: 1 }, "accept-same-key", at
    )));
    assert.equal(results.filter((result) => !result.replay).length, 1);
    assert.deepEqual(new Set(results.map((result) => result.referralId)), new Set([referralId]));
    assert.equal(results[0].version, 2);
    assert.equal(results[0].venueId, sharedVenueId);
    assert.equal(results[0].venueOwnerPersonId, otherTeacherId);
    assert.equal(results[0].isSelfUse, false);
    assert.equal(results[0].acceptedAt, at.toISOString());
    assert.equal((await pool.query("SELECT status,version::text FROM referral_case WHERE id=$1", [referralId])).rows[0].status, "ACCEPTED");
    assert.equal((await pool.query("SELECT status,version::text FROM referral_case WHERE id=$1", [referralId])).rows[0].version, "2");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM referral_case_event WHERE referral_case_id=$1 AND event_type='ACCEPTED'", [referralId])).rows[0].n, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM referral_acceptance_idempotency WHERE referral_case_id=$1", [referralId])).rows[0].n, 1);
    assert.deepEqual((await pool.query("SELECT selection_source,accepted_referral_version::text AS accepted_referral_version FROM referral_acceptance_snapshot WHERE referral_case_id=$1", [referralId])).rows[0], { selection_source: "EXPLICIT", accepted_referral_version: "2" });
    await assert.rejects(
      service.accept(contextFor(teacherId), referralId, { venueId: sharedVenueId, expectedVersion: 2 }, "another-key", at),
      /REFERRAL_ALREADY_ACCEPTED/
    );
    await assert.rejects(
      service.accept(contextFor(teacherId), referralId, { venueId: ownDefaultVenueId, expectedVersion: 1 }, "accept-same-key", at),
      /IDEMPOTENCY_REPLAY/
    );
    await assert.rejects(
      pool.query("UPDATE referral_acceptance_snapshot SET is_self_use=true WHERE referral_case_id=$1", [referralId]),
      /REFERRAL_ACCEPTANCE_IMMUTABLE/
    );
    await pool.query("UPDATE referral_case SET status='ARCHIVED',version=version+1 WHERE id=$1", [referralId]);
    const afterLifecycleReplay = await service.accept(contextFor(teacherId), referralId, { venueId: sharedVenueId, expectedVersion: 1 }, "accept-same-key", at);
    assert.equal(afterLifecycleReplay.replay, true);
    assert.equal(afterLifecycleReplay.version, 2);

    const defaultReferralId = await addReferral(pool, { referrerId: plannerId, receiverId: teacherId });
    const selfResult = await service.accept(contextFor(teacherId), defaultReferralId, { expectedVersion: 1 }, "accept-own-default", at);
    assert.equal(selfResult.venueId, ownDefaultVenueId);
    assert.equal(selfResult.venueOwnerPersonId, teacherId);
    assert.equal(selfResult.isSelfUse, true);
    assert.equal((await pool.query("SELECT selection_source FROM referral_acceptance_snapshot WHERE referral_case_id=$1", [defaultReferralId])).rows[0].selection_source, "OWNER_DEFAULT");

    const wrongReceiverReferralId = await addReferral(pool, { referrerId: plannerId, receiverId: teacherId });
    await assert.rejects(service.accept(contextFor(otherTeacherId), wrongReceiverReferralId, { venueId: sharedVenueId, expectedVersion: 1 }, "wrong-receiver", at), /FORBIDDEN_SCOPE/);
    await assert.rejects(service.accept({ personId: teacherId, subject: "ACADEMIC_PLANNER" }, wrongReceiverReferralId, { venueId: sharedVenueId, expectedVersion: 1 }, "wrong-role", at), /FORBIDDEN_SCOPE/);
  } finally {
    await db.close();
  }
});

test("首次接收拒绝期限、错误版本、缺失场地账户和既有费用场地冲突且不动账务", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const { pool } = db;
  const [plannerId, teacherId, otherTeacherId] = Array.from({ length: 3 }, () => randomUUID());
  try {
    for (const id of [plannerId, teacherId, otherTeacherId]) {
      await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES ($1::uuid,$2,'合成人员','ACTIVE')", [id, `failure-${id}`]);
    }
    const service = new PostgresReferralAcceptanceService(pool);
    const ownVenueId = await addVenue(pool, { ownerId: teacherId });
    const externalVenueId = await addVenue(pool, { ownerId: otherTeacherId });
    const noAccountVenueId = await addVenue(pool, { ownerId: otherTeacherId, withAccount: false });
    const inactiveVenueId = await addVenue(pool, { ownerId: otherTeacherId, active: false });

    const noDefaultReferralId = await addReferral(pool, { referrerId: plannerId, receiverId: teacherId });
    await assert.rejects(service.accept(contextFor(teacherId), noDefaultReferralId, { expectedVersion: 1 }, "no-default", at), /DEFAULT_VENUE_NOT_FOUND/);
    await assert.rejects(service.accept(contextFor(teacherId), noDefaultReferralId, { venueId: inactiveVenueId, expectedVersion: 1 }, "inactive-venue", at), /VENUE_NOT_FOUND/);
    await assert.rejects(service.accept(contextFor(teacherId), noDefaultReferralId, { venueId: noAccountVenueId, expectedVersion: 1 }, "venue-without-account", at), /VENUE_ACCOUNT_REQUIRED/);
    await assert.rejects(service.accept(contextFor(teacherId), noDefaultReferralId, { venueId: externalVenueId, expectedVersion: 3 }, "wrong-version", at), /VERSION_CONFLICT/);
    await assert.rejects(service.accept(contextFor(teacherId), "not-a-uuid", { venueId: externalVenueId, expectedVersion: 1 }, "bad-id", at), /INVALID_INPUT/);

    const expiredReferralId = await addReferral(pool, { referrerId: plannerId, receiverId: teacherId, expiresAt: at });
    await assert.rejects(service.accept(contextFor(teacherId), expiredReferralId, { venueId: externalVenueId, expectedVersion: 1 }, "expired", at), /REFERRAL_ACCEPTANCE_INVALID/);
    const noExpiryReferralId = await addReferral(pool, { referrerId: plannerId, receiverId: teacherId, expiresAt: null });
    await assert.rejects(service.accept(contextFor(teacherId), noExpiryReferralId, { venueId: externalVenueId, expectedVersion: 1 }, "legacy-no-expiry", at), /REFERRAL_ACCEPTANCE_INVALID/);

    const conflictReferralId = await addReferral(pool, { referrerId: plannerId, receiverId: teacherId });
    const weekId = await addWeek(pool, teacherId);
    await pool.query(
      `INSERT INTO weekly_fee_entry(
         referral_case_id, teaching_week_id, settlement_month, gross_amount_cents,
         venue_id, venue_owner_person_id, is_self_use_snapshot, source_case_version, version, created_by
       ) VALUES ($1::uuid, $2::uuid, '2026-09-01', 10000, $3::uuid, $4::uuid, true, 1, 1, $4::uuid)`,
      [conflictReferralId, weekId, ownVenueId, teacherId]
    );
    const ledgerBefore = await pool.query("SELECT (SELECT count(*) FROM ledger_event)::int AS events, (SELECT count(*) FROM ledger_entry)::int AS entries, (SELECT count(*) FROM account_balance_projection)::int AS projections");
    await assert.rejects(service.accept(contextFor(teacherId), conflictReferralId, { venueId: externalVenueId, expectedVersion: 1 }, "venue-conflict", at), /VENUE_CHANGE_REQUIRED/);
    assert.deepEqual((await pool.query("SELECT status,version::text FROM referral_case WHERE id=$1", [conflictReferralId])).rows[0], { status: "PENDING", version: "1" });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM referral_acceptance_snapshot WHERE referral_case_id=$1", [conflictReferralId])).rows[0].n, 0);
    assert.deepEqual((await pool.query("SELECT venue_id::text AS venue_id,gross_amount_cents::text AS gross_amount_cents,version::text AS version FROM weekly_fee_entry WHERE referral_case_id=$1", [conflictReferralId])).rows[0], { venue_id: ownVenueId, gross_amount_cents: "10000", version: "1" });
    assert.deepEqual((await pool.query("SELECT (SELECT count(*) FROM ledger_event)::int AS events, (SELECT count(*) FROM ledger_entry)::int AS entries, (SELECT count(*) FROM account_balance_projection)::int AS projections")).rows[0], ledgerBefore.rows[0]);

    const sameVenueReferralId = await addReferral(pool, { referrerId: plannerId, receiverId: teacherId });
    const secondWeekId = await addWeek(pool, teacherId);
    await pool.query(
      `INSERT INTO weekly_fee_entry(
         referral_case_id, teaching_week_id, settlement_month, gross_amount_cents,
         venue_id, venue_owner_person_id, is_self_use_snapshot, source_case_version, version, created_by
       ) VALUES ($1::uuid, $2::uuid, '2026-09-01', 10000, $3::uuid, $4::uuid, false, 1, 1, $5::uuid)`,
      [sameVenueReferralId, secondWeekId, externalVenueId, otherTeacherId, teacherId]
    );
    assert.equal((await service.accept(contextFor(teacherId), sameVenueReferralId, { venueId: externalVenueId, expectedVersion: 1 }, "matching-existing-fee", at)).venueId, externalVenueId);

    const legacyAcceptedReferralId = await addReferral(pool, { referrerId: plannerId, receiverId: teacherId, status: "ACCEPTED" });
    await assert.rejects(service.accept(contextFor(teacherId), legacyAcceptedReferralId, { venueId: externalVenueId, expectedVersion: 1 }, "no-legacy-snapshot", at), /REFERRAL_ALREADY_ACCEPTED/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM referral_acceptance_snapshot WHERE referral_case_id=$1", [legacyAcceptedReferralId])).rows[0].n, 0);
  } finally {
    await db.close();
  }
});
