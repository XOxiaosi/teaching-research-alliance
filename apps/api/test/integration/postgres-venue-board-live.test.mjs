import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PostgresVenueBoardReadService } from "../../dist/postgres-venue-board-read-service.js";
import { fixture } from "./refund-review-fixture.mjs";

const at = new Date("2026-09-21T09:00:00.000Z");
const stringify = (value) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);

const boardPolicy = {
  plannerBaseRateBasisPoints: 0n,
  teacherBaseRateBasisPoints: 0n,
  planningMentorWeightBasisPoints: 0n,
  groupLeaderRateBasisPoints: 0n,
  teachingMentorRateBasisPoints: 0n,
  venueRateBasisPoints: 500n,
  campusConsultationForPlannerRateBasisPoints: 0n,
  campusConsultationForTeacherRateBasisPoints: 0n,
  platformFinanceRateBasisPoints: 0n,
  regionFinanceRateBasisPoints: 0n,
  dynamicTiers: [{ label: "all", adjustmentBasisPoints: 0n }]
};

const addVenueAccount = async (pool, venueId, suffix) => {
  const accountId = randomUUID();
  await pool.query("INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,'VENUE',$2::uuid,$3,'ACTIVE')", [accountId, venueId, `venue:board:${suffix}`]);
  await pool.query("INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1::uuid,23000)", [accountId]);
  return accountId;
};

test("共享场地看板按最新场地分润展示学生周费用，退款排除且VIEW/WITHDRAW字段隔离", async () => {
  const seeded = await fixture();
  const { pool, ids } = seeded;
  try {
    const [venueAAccount] = await Promise.all([
      addVenueAccount(pool, ids.venueA, "a"),
      addVenueAccount(pool, ids.venueB, "b"),
      addVenueAccount(pool, ids.venueC, "c")
    ]);
    await pool.query(
      "INSERT INTO rate_policy_version(version,effective_from,policy_json,reason,published_by) VALUES(2,'2026-09-01',$1::jsonb,'场地看板测试',$2::uuid)",
      [stringify(boardPolicy), ids.admin]
    );
    await pool.query(
      `INSERT INTO venue_permission_grant(venue_id,grantee_person_id,can_view,can_withdraw,valid_from,granted_by,created_at)
       VALUES($1::uuid,$2::uuid,true,false,'2026-01-01T00:00:00Z',$3::uuid,'2026-01-01T00:00:00Z'),
             ($1::uuid,$4::uuid,true,true,'2026-01-01T00:00:00Z',$3::uuid,'2026-01-01T00:00:00Z')`,
      [ids.venueA, ids.teacherB, ids.teacherA, ids.teacherC]
    );
    const studentId = randomUUID();
    const referralId = randomUUID();
    await pool.query(
      "INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name) VALUES($1::uuid,$2::uuid,'venue-board-course','场地学生')",
      [studentId, ids.teacherB]
    );
    await pool.query(
      `INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,version)
       VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'TEACHING_TEACHER','ACCEPTED',$5::timestamptz,1)`,
      [referralId, studentId, ids.teacherC, ids.teacherB, at.toISOString()]
    );
    const first = await seeded.weekly.recordAndSettle(ids.teacherB, {
      referralCaseId: referralId, teachingWeekId: ids.weekB, venueId: ids.venueA,
      settlementMonth: "2026-09-01", grossAmountCents: 100000n, expectedVersion: 0
    }, "venue-board-shared-first");
    await seeded.weekly.recordAndSettle(ids.teacherB, {
      referralCaseId: referralId, teachingWeekId: ids.weekB, venueId: ids.venueA,
      settlementMonth: "2026-09-01", grossAmountCents: 140000n, expectedVersion: first.fee.version
    }, "venue-board-shared-corrected");
    const pending = await seeded.pending();
    await seeded.approve(pending);

    const service = new PostgresVenueBoardReadService(pool);
    const filter = { startsOn: "2026-09-01", endsOn: "2026-09-30" };
    const owner = await service.get({ subject: "TEACHING_TEACHER", personId: ids.teacherA, scope: "SELF" }, ids.venueA, filter, at);
    assert.equal(owner.venue.accountId, venueAAccount);
    assert.equal(owner.venue.balanceCents, 30000n);
    assert.equal(owner.totalVenueFeeCents, 7000n);
    assert.equal(owner.members.length, 3);
    assert.deepEqual(owner.members.map(member => [member.personId, member.canView, member.canWithdraw, member.isOwner]), [
      [ids.teacherA, true, true, true], [ids.teacherB, true, false, false], [ids.teacherC, true, true, false]
    ]);
    const sharedTeacher = owner.teachers.find(teacher => teacher.teacherPersonId === ids.teacherB);
    assert.equal(sharedTeacher?.totalVenueFeeCents, 7000n);
    assert.deepEqual(sharedTeacher?.weeklyFees, [{
      weeklyFeeEntryId: first.fee.id,
      teachingWeekId: ids.weekB,
      weekStartsOn: "2026-09-21",
      weekEndsOn: "2026-09-27",
      studentRecordId: studentId,
      studentDisplayName: "场地学生",
      courseContextId: "venue-board-course",
      venueFeeCents: 7000n
    }]);
    const ownerSelfRows = owner.teachers.find(teacher => teacher.teacherPersonId === ids.teacherA)?.weeklyFees ?? [];
    assert.equal(ownerSelfRows.length, 1);
    assert.equal(ownerSelfRows[0]?.venueFeeCents, 0n);
    assert.equal(ownerSelfRows.some(row => row.weeklyFeeEntryId === seeded.refundFee.fee.id), false);

    const viewOnly = await service.get({ subject: "TEACHING_TEACHER", personId: ids.teacherB, scope: "SELF" }, ids.venueA, { teachingWeekId: ids.weekB }, at);
    assert.equal(viewOnly.totalVenueFeeCents, 7000n);
    assert.equal("accountId" in viewOnly.venue, false);
    assert.equal("balanceCents" in viewOnly.venue, false);
    const withdrawer = await service.get({ subject: "TEACHING_TEACHER", personId: ids.teacherC, scope: "SELF" }, ids.venueA, { teachingWeekId: ids.weekB }, at);
    assert.equal(withdrawer.venue.accountId, venueAAccount);
    await pool.query("UPDATE account_balance_projection SET balance_cents=-1234 WHERE account_id=$1::uuid", [venueAAccount]);
    const negativeOwner = await service.get({ subject: "TEACHING_TEACHER", personId: ids.teacherA, scope: "SELF" }, ids.venueA, filter, at);
    assert.equal(negativeOwner.venue.balanceCents, -1234n);
    assert.equal(negativeOwner.totalVenueFeeCents, 7000n);
    const negativeViewer = await service.get({ subject: "TEACHING_TEACHER", personId: ids.teacherB, scope: "SELF" }, ids.venueA, filter, at);
    assert.equal("balanceCents" in negativeViewer.venue, false);
    assert.equal(negativeViewer.totalVenueFeeCents, 7000n);
    await assert.rejects(
      service.get({ subject: "HEADQUARTERS_FINANCE", personId: ids.hq, scope: "GLOBAL" }, ids.venueA, { teachingWeekId: ids.weekB }, at),
      /FORBIDDEN_SCOPE/
    );
    await assert.rejects(
      service.get({ subject: "TEACHING_TEACHER", personId: ids.teacherB, scope: "SELF" }, ids.venueA, { startsOn: "2026-09-21" }, at),
      /INVALID_INPUT/
    );
  } finally {
    await seeded.close();
  }
});
