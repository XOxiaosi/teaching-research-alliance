import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresTeachingReadService } from "../../dist/postgres-teaching-read-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

test("教师只读取本人接收生源的当前周费用和开放教学周", async () => {
  const database = await createTestDatabase(process.env.DATABASE_URL);
  const { pool } = database;
  const teacherId = randomUUID();
  const otherTeacherId = randomUUID();
  const plannerId = randomUUID();
  const previousYearId = randomUUID();
  const yearId = randomUUID();
  const previousPeriodId = randomUUID();
  const periodId = randomUUID();
  const previousWeekId = randomUUID();
  const openWeekId = randomUUID();
  const futureWeekId = randomUUID();
  const lockedWeekId = randomUUID();
  const studentId = randomUUID();
  const otherStudentId = randomUUID();
  const archivedStudentId = randomUUID();
  const referralId = randomUUID();
  const otherReferralId = randomUUID();
  const archivedReferralId = randomUUID();
  const venueId = randomUUID();
  const previousFeeId = randomUUID();
  const feeId = randomUUID();
  const beforeYearBoundary = new Date("2026-08-31T15:59:59.999Z");
  const atYearBoundary = new Date("2026-08-31T16:00:00.000Z");
  try {
    await pool.query(
      `INSERT INTO person (id, nickname, legal_name, status) VALUES
       ($1, '读取教师', '合成姓名1', 'ACTIVE'),
       ($2, '其他教师', '合成姓名2', 'ACTIVE'),
       ($3, '读取规划师', '合成姓名3', 'ACTIVE')`,
      [teacherId, otherTeacherId, plannerId]
    );
    await pool.query(
      `INSERT INTO academic_year_plan (id, label, starts_on, ends_on, created_by) VALUES
       ($1, '2025学年', '2025-09-01', '2026-08-31', $3),
       ($2, '2026学年', '2026-09-01', '2027-08-31', $3)`,
      [previousYearId, yearId, teacherId]
    );
    await pool.query(
      `INSERT INTO academic_period (id, academic_year_plan_id, label, starts_on, ends_on) VALUES
       ($1, $3, '上一学年暑期', '2026-07-01', '2026-08-31'),
       ($2, $4, '秋季学期', '2026-09-01', '2027-01-31')`,
      [previousPeriodId, periodId, previousYearId, yearId]
    );
    await pool.query(
      `INSERT INTO teaching_week (
         id, academic_period_id, sequence_no, week_kind, starts_on, ends_on, settlement_month, status
       ) VALUES
       ($1, $5, 1, 'REGULAR', '2026-08-24', '2026-08-30', '2026-08-01', 'OPEN'),
       ($2, $6, 1, 'REGULAR', '2026-09-21', '2026-09-27', '2026-09-01', 'OPEN'),
       ($3, $6, 2, 'REGULAR', '2026-11-02', '2026-11-08', '2026-11-01', 'OPEN'),
       ($4, $6, 3, 'REGULAR', '2026-09-28', '2026-10-04', '2026-10-01', 'LOCKED')`,
      [previousWeekId, openWeekId, futureWeekId, lockedWeekId, previousPeriodId, periodId]
    );
    await pool.query(
      `INSERT INTO teacher_student_record (id, owner_teacher_id, course_context_id, display_name) VALUES
       ($1, $3, 'math-one-to-one', '学生甲'),
       ($2, $4, 'physics-one-to-one', '学生乙'),
       ($5, $3, 'history-archived', '旧年归档学生')`,
      [studentId, otherStudentId, teacherId, otherTeacherId, archivedStudentId]
    );
    await pool.query(
      `INSERT INTO referral_case (
         id, teacher_student_record_id, referrer_person_id, receiver_person_id,
         referrer_identity, status, submitted_at, unaccepted_expires_at
       ) VALUES
       ($1, $4, $6, $7, 'ACADEMIC_PLANNER', 'ACCEPTED', '2026-08-20T00:00:00Z', NULL),
       ($2, $5, $6, $8, 'ACADEMIC_PLANNER', 'PENDING', '2026-09-19T00:00:00Z', '2026-10-10T00:00:00Z'),
       ($3, $9, $6, $7, 'ACADEMIC_PLANNER', 'ARCHIVED', '2026-01-10T00:00:00Z', '2026-01-31T00:00:00Z')`,
      [
        referralId, otherReferralId, archivedReferralId, studentId, otherStudentId,
        plannerId, teacherId, otherTeacherId, archivedStudentId
      ]
    );
    await pool.query(
      `INSERT INTO venue (id, owner_person_id, name, status)
       VALUES ($1, $2, '教师自有场地', 'ACTIVE')`,
      [venueId, teacherId]
    );
    await pool.query(
      `INSERT INTO weekly_fee_entry (
         id, referral_case_id, teaching_week_id, settlement_month, gross_amount_cents,
         venue_id, venue_owner_person_id, is_self_use_snapshot, source_case_version, version, created_by
       ) VALUES
       ($1, $3, $4, '2026-08-01', 65432, $6, $7, true, 1, 1, $7),
       ($2, $3, $5, '2026-09-01', 123456, $6, $7, true, 1, 2, $7)`,
      [previousFeeId, feeId, referralId, previousWeekId, openWeekId, venueId, teacherId]
    );

    const service = new PostgresTeachingReadService(pool);
    const teacherContext = { subject: "TEACHING_TEACHER", personId: teacherId };
    const referrals = await service.listReceivedReferrals(teacherContext, atYearBoundary);
    assert.equal(referrals.length, 1);
    assert.deepEqual(referrals[0], {
      referralId,
      studentRecordId: studentId,
      studentDisplayName: "学生甲",
      courseContextId: "math-one-to-one",
      referralStatus: "ACCEPTED",
      submittedAt: "2026-08-20T00:00:00Z",
      unacceptedExpiresAt: null,
      referrerIdentity: "ACADEMIC_PLANNER",
      weeklyFees: [{
        entryId: feeId,
        teachingWeekId: openWeekId,
        weekStartsOn: "2026-09-21",
        weekEndsOn: "2026-09-27",
        settlementMonth: "2026-09-01",
        grossAmountCents: 123456n,
        version: 2,
        venueId,
        venueName: "教师自有场地",
        isSelfUseSnapshot: true
      }]
    });

    const weeks = await service.listOpenTeachingWeeks(teacherContext, atYearBoundary);
    assert.deepEqual(weeks, [
      {
        weekId: openWeekId,
        yearLabel: "2026学年",
        periodLabel: "秋季学期",
        sequenceNo: 1,
        weekKind: "REGULAR",
        startsOn: "2026-09-21",
        endsOn: "2026-09-27",
        settlementMonth: "2026-09-01"
      },
      {
        weekId: futureWeekId,
        yearLabel: "2026学年",
        periodLabel: "秋季学期",
        sequenceNo: 2,
        weekKind: "REGULAR",
        startsOn: "2026-11-02",
        endsOn: "2026-11-08",
        settlementMonth: "2026-11-01"
      }
    ]);
    const previousYearReferrals = await service.listReceivedReferrals(teacherContext, beforeYearBoundary);
    assert.equal(previousYearReferrals.length, 2);
    const previousYearActive = previousYearReferrals.find((item) => item.referralId === referralId);
    assert.equal(previousYearActive?.weeklyFees.length, 1);
    assert.equal(previousYearActive?.weeklyFees[0]?.entryId, previousFeeId);
    assert.deepEqual(await service.listOpenTeachingWeeks(teacherContext, beforeYearBoundary), [{
      weekId: previousWeekId,
      yearLabel: "2025学年",
      periodLabel: "上一学年暑期",
      sequenceNo: 1,
      weekKind: "REGULAR",
      startsOn: "2026-08-24",
      endsOn: "2026-08-30",
      settlementMonth: "2026-08-01"
    }]);
    const plannerContext = { subject: "ACADEMIC_PLANNER", personId: plannerId };
    await assert.rejects(service.listReceivedReferrals(plannerContext, atYearBoundary), /FORBIDDEN_SCOPE/);
    await assert.rejects(service.listOpenTeachingWeeks(plannerContext, atYearBoundary), /FORBIDDEN_SCOPE/);
  } finally {
    await database.close();
  }
});
