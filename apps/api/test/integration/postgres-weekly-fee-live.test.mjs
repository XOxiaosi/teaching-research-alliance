import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresWeeklyFeeRepository } from "../../dist/postgres-weekly-fee-repository.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const connectionString = process.env.DATABASE_URL;

test("真实PostgreSQL推荐接收与周费用版本/幂等流程", async () => {
  if (connectionString === undefined || connectionString.trim() === "") {
    throw new Error("DATABASE_URL_REQUIRED_FOR_POSTGRES_INTEGRATION");
  }
  const { pool, close: cleanup } = await createTestDatabase(connectionString);
  const suffix = randomUUID();
  const plannerId = randomUUID();
  const teacherId = randomUUID();
  const yearId = randomUUID();
  const periodId = randomUUID();
  const weekId = randomUUID();
  const studentId = randomUUID();
  const referralId = randomUUID();
  const venueId = randomUUID();
  try {
    await pool.query(
      `INSERT INTO person (id, nickname, legal_name, status)
       VALUES ($1::uuid, $2, $3, 'ACTIVE'), ($4::uuid, $5, $6, 'ACTIVE')`,
      [plannerId, `集成规划师-${suffix}`, `集成规划师-${suffix}`, teacherId, `集成教师-${suffix}`, `集成教师-${suffix}`]
    );
    await pool.query(
      `INSERT INTO academic_year_plan (id, label, starts_on, ends_on, created_by)
       VALUES ($1::uuid, $2, DATE '2026-09-01', DATE '2027-08-31', $3::uuid)`,
      [yearId, `集成学年-${suffix}`, teacherId]
    );
    await pool.query(
      `INSERT INTO academic_period (id, academic_year_plan_id, label, starts_on, ends_on)
       VALUES ($1::uuid, $2::uuid, '普通学期', DATE '2026-09-01', DATE '2027-01-31')`,
      [periodId, yearId]
    );
    await pool.query(
      `INSERT INTO teaching_week (id, academic_period_id, sequence_no, week_kind, starts_on, ends_on, settlement_month)
       VALUES ($1::uuid, $2::uuid, 1, 'REGULAR', DATE '2026-09-21', DATE '2026-09-27', DATE '2026-09-01')`,
      [weekId, periodId]
    );
    await pool.query(
      `INSERT INTO teacher_student_record (id, owner_teacher_id, course_context_id, display_name)
       VALUES ($1::uuid, $2::uuid, $3, '集成学生')`,
      [studentId, teacherId, `course-${suffix}`]
    );
    await pool.query(
      `INSERT INTO referral_case (id, teacher_student_record_id, referrer_person_id, receiver_person_id, referrer_identity, status, submitted_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACADEMIC_PLANNER', 'PENDING', now())`,
      [referralId, studentId, plannerId, teacherId]
    );
    await pool.query(
      `INSERT INTO venue (id, owner_person_id, name, status)
       VALUES ($1::uuid, $2::uuid, '集成场地', 'ACTIVE')`,
      [venueId, teacherId]
    );

    const repository = new PostgresWeeklyFeeRepository(pool);
    // Isolated repository test only. Application writes use recordAndSettle.
    const recordWeeklyFee = async (...args) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await repository.recordWeeklyFeeInTransaction(client, ...args);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    };
    const accepted = await repository.acceptReferral(referralId, teacherId);
    assert.equal(accepted.status, "ACCEPTED");
    assert.equal(accepted.version, 2);

    const firstRequests = await Promise.all(Array.from({ length: 4 }, () => recordWeeklyFee(teacherId, {
      referralCaseId: referralId,
      teachingWeekId: weekId,
      venueId,
      settlementMonth: "2026-09-01",
      grossAmountCents: 100000n
    }, "weekly-request-1")));
    assert.deepEqual(firstRequests.map(record => record.version), [1, 1, 1, 1]);
    const first = firstRequests[0];
    assert.equal(first.version, 1);
    assert.equal(first.grossAmountCents, 100000n);
    assert.equal(first.isSelfUseSnapshot, true);

    const replay = await recordWeeklyFee(teacherId, {
      referralCaseId: referralId,
      teachingWeekId: weekId,
      venueId,
      settlementMonth: "2026-09-01",
      grossAmountCents: 100000n
    }, "weekly-request-1");
    assert.equal(replay.version, 1);
    assert.equal(replay.grossAmountCents, 100000n);

    const corrected = await recordWeeklyFee(teacherId, {
      referralCaseId: referralId,
      teachingWeekId: weekId,
      venueId,
      settlementMonth: "2026-09-01",
      grossAmountCents: 120000n
    }, "weekly-request-2");
    assert.equal(corrected.version, 2);
    assert.equal(corrected.grossAmountCents, 120000n);

    const history = await repository.listHistory(referralId, weekId);
    assert.deepEqual(history.map((record) => [record.version, record.grossAmountCents.toString()]), [[1, "100000"], [2, "120000"]]);
    const originalDraft = { referralCaseId: referralId, teachingWeekId: weekId, venueId, settlementMonth: "2026-09-01", grossAmountCents: 100000n };
    const oldReplay = await recordWeeklyFee(teacherId, originalDraft, "weekly-request-1");
    assert.equal(oldReplay.version, 1);
    assert.equal(oldReplay.grossAmountCents, 100000n);
    await assert.rejects(recordWeeklyFee(teacherId, { ...originalDraft, grossAmountCents: 1n }, "weekly-request-1"), /IDEMPOTENCY_REPLAY/);
    const concurrent = await Promise.all(Array.from({ length: 5 }, () => recordWeeklyFee(teacherId, { ...originalDraft, grossAmountCents: 130000n }, "weekly-request-concurrent")));
    assert.deepEqual(concurrent.map(record => record.version), [3, 3, 3, 3, 3]);
    const distinct = await Promise.all([140000n, 150000n].map((grossAmountCents, index) => recordWeeklyFee(teacherId, { ...originalDraft, grossAmountCents }, `weekly-request-distinct-${index}`)));
    assert.deepEqual(distinct.map(record => record.version).sort(), [4, 5]);
    assert.equal((await repository.listHistory(referralId, weekId)).length, 5);
    await assert.rejects(recordWeeklyFee(plannerId, originalDraft, "forbidden-request"), /FORBIDDEN_SCOPE/);
    await pool.query("UPDATE teaching_week SET status = 'LOCKED' WHERE id = $1", [weekId]);
    await assert.rejects(recordWeeklyFee(teacherId, originalDraft, "locked-request"), /PERIOD_LOCKED/);
    assert.equal((await repository.listHistory(referralId, weekId)).length, 5);
    const requests = await pool.query("SELECT count(*)::int AS count FROM weekly_fee_idempotency");
    assert.equal(requests.rows[0].count, 5);
  } finally {
    await cleanup();
  }
});
