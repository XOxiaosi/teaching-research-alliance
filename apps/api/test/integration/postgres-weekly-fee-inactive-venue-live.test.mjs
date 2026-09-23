import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { PostgresWeeklyFeeRepository } from "../../dist/postgres-weekly-fee-repository.js";
import { createTestDatabase } from "./postgres-test-database.mjs";
import { fixture } from "./refund-review-fixture.mjs";

const connectionString = process.env.DATABASE_URL;

test("停用场地只阻止新选择，允许同一历史周费用改错", async () => {
  const { pool, close } = await createTestDatabase(connectionString);
  const ids = Object.fromEntries([
    "teacher", "planner", "year", "period", "weekA", "weekB", "studentA", "studentB", "referralA", "referralB", "venueA", "venueB"
  ].map((key) => [key, randomUUID()]));
  const month = "2026-09-01";
  try {
    await pool.query(
      `INSERT INTO person(id,nickname,legal_name,status) VALUES
       ($1::uuid,'停用场地老师','停用场地老师','ACTIVE'),
       ($2::uuid,'停用场地规划师','停用场地规划师','ACTIVE')`,
      [ids.teacher, ids.planner]
    );
    await pool.query(
      `INSERT INTO academic_year_plan(id,label,starts_on,ends_on,created_by)
       VALUES($1::uuid,'停用场地学年','2026-09-01','2027-08-31',$2::uuid)`,
      [ids.year, ids.teacher]
    );
    await pool.query(
      `INSERT INTO academic_period(id,academic_year_plan_id,label,starts_on,ends_on)
       VALUES($1::uuid,$2::uuid,'停用场地学期','2026-09-01','2027-01-31')`,
      [ids.period, ids.year]
    );
    await pool.query(
      `INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month,status) VALUES
       ($1::uuid,$3::uuid,1,'REGULAR','2026-09-07','2026-09-13',$4::date,'OPEN'),
       ($2::uuid,$3::uuid,2,'REGULAR','2026-09-14','2026-09-20',$4::date,'OPEN')`,
      [ids.weekA, ids.weekB, ids.period, month]
    );
    await pool.query(
      `INSERT INTO venue(id,owner_person_id,name,status) VALUES
       ($1::uuid,$3::uuid,'原场地','ACTIVE'),
       ($2::uuid,$3::uuid,'已停用新场地','INACTIVE')`,
      [ids.venueA, ids.venueB, ids.teacher]
    );
    await pool.query(
      `INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name) VALUES
       ($1::uuid,$3::uuid,'inactive-course-a','学生甲'),
       ($2::uuid,$3::uuid,'inactive-course-b','学生乙')`,
      [ids.studentA, ids.studentB, ids.teacher]
    );
    await pool.query(
      `INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,version) VALUES
       ($1::uuid,$3::uuid,$5::uuid,$4::uuid,'ACADEMIC_PLANNER','ACCEPTED',now(),1),
       ($2::uuid,$3::uuid,$5::uuid,$4::uuid,'ACADEMIC_PLANNER','ACCEPTED',now(),1)`,
      [ids.referralA, ids.referralB, ids.studentA, ids.teacher, ids.planner]
    );

    const repository = new PostgresWeeklyFeeRepository(pool);
    const record = async (draft, key) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await repository.recordWeeklyFeeInTransaction(client, ids.teacher, draft, key);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    };
    const original = {
      referralCaseId: ids.referralA,
      teachingWeekId: ids.weekA,
      venueId: ids.venueA,
      settlementMonth: month,
      grossAmountCents: 100000n,
      expectedVersion: 0
    };
    const first = await record(original, "inactive-original");
    assert.equal(first.version, 1);
    await pool.query("UPDATE venue SET status='INACTIVE' WHERE id=$1::uuid", [ids.venueA]);

    const corrected = await record({ ...original, grossAmountCents: 120000n, expectedVersion: 1 }, "inactive-correction");
    assert.equal(corrected.version, 2);
    assert.equal(corrected.venueId, ids.venueA);
    assert.equal(corrected.grossAmountCents, 120000n);

    await assert.rejects(
      record({ ...original, venueId: ids.venueB, grossAmountCents: 130000n, expectedVersion: 2 }, "inactive-change"),
      /VENUE_NOT_ACTIVE/
    );
    await assert.rejects(
      record({
        referralCaseId: ids.referralB,
        teachingWeekId: ids.weekB,
        venueId: ids.venueA,
        settlementMonth: month,
        grossAmountCents: 100000n,
        expectedVersion: 0
      }, "inactive-new"),
      /VENUE_NOT_ACTIVE/
    );
    const history = await repository.listHistory(ids.referralA, ids.weekA);
    assert.deepEqual(history.map((entry) => [entry.version, entry.venueId, entry.grossAmountCents]), [
      [1, ids.venueA, 100000n],
      [2, ids.venueA, 120000n]
    ]);
  } finally {
    await close();
  }
});

test("停用原场地后金额更正只增加差额，重复请求不重复入账", async () => {
  const f = await fixture();
  try {
    const before = await f.balances();
    await f.pool.query("UPDATE venue SET status='INACTIVE' WHERE id=$1::uuid", [f.ids.venueA]);
    const corrected = await f.record(120000n, "inactive-settlement-correction");
    assert.equal(corrected.fee.id, f.refundFee.fee.id);
    assert.equal(corrected.fee.version, 2);
    assert.equal(corrected.fee.venueId, f.ids.venueA);
    const after = await f.balances();
    assert.equal(after.reduce((sum, value) => sum + value, 0n) - before.reduce((sum, value) => sum + value, 0n), 20000n);
    await f.record(120000n, "inactive-settlement-correction");
    assert.deepEqual(await f.balances(), after);
  } finally { await f.close(); }
});
