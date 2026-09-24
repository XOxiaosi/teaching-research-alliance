import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  createApiServer,
  PostgresManagedReferralReadService,
  PostgresReferralLifecycleService,
} from "../../dist/main.js";
import { PostgresWeeklyFeeRepository } from "../../dist/postgres-weekly-fee-repository.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const at = new Date("2026-09-24T04:00:00.000Z");

const listen = async (server) => {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
};

const closeServer = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};

test("真实 PostgreSQL 与 HTTP：接收方或全局管理员完结，历史费用可更正而不能新增", async () => {
  const database = await createTestDatabase(process.env.DATABASE_URL);
  const { pool } = database;
  const ids = Object.fromEntries([
    "teacher", "planner", "admin", "otherTeacher", "student", "referral", "venue", "year", "period", "weekA", "weekB",
  ].map((key) => [key, randomUUID()]));
  const teacher = { personId: ids.teacher, subject: "TEACHING_TEACHER", scope: "SELF" };
  const admin = { personId: ids.admin, subject: "SYSTEM_ADMIN", scope: "GLOBAL" };
  try {
    for (const [kind, id] of Object.entries({ teacher: ids.teacher, planner: ids.planner, admin: ids.admin, other: ids.otherTeacher })) {
      await pool.query(
        "INSERT INTO person(id,nickname,legal_name,status) VALUES ($1::uuid,$2,$2,'ACTIVE')",
        [id, `完结合成人员-${kind}`],
      );
    }
    await pool.query(
      `INSERT INTO user_account(person_id,phone_normalized,password_hash,login_status) VALUES
       ($1::uuid,'18800000001','synthetic','ACTIVE'),
       ($2::uuid,'18800000002','synthetic','ACTIVE')`,
      [ids.teacher, ids.admin],
    );
    await pool.query(
      `INSERT INTO role_assignment(person_id,subject_code,scope_type,scope_id,valid_from,created_by,created_at)
       VALUES
       ($1::uuid,'SYSTEM_ADMIN','GLOBAL',NULL,$3::timestamptz,$1::uuid,$3::timestamptz),
       ($2::uuid,'TEACHING_TEACHER','SELF',NULL,$3::timestamptz,$1::uuid,$3::timestamptz)`,
      [ids.admin, ids.teacher, new Date(at.getTime() - 1_000).toISOString()],
    );
    await pool.query(
      `INSERT INTO academic_year_plan(id,label,starts_on,ends_on,created_by)
       VALUES($1::uuid,'完结合成学年','2026-09-01','2027-08-31',$2::uuid)`,
      [ids.year, ids.teacher],
    );
    await pool.query(
      `INSERT INTO academic_period(id,academic_year_plan_id,label,starts_on,ends_on)
       VALUES($1::uuid,$2::uuid,'完结合成学期','2026-09-01','2027-01-31')`,
      [ids.period, ids.year],
    );
    await pool.query(
      `INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month,status) VALUES
       ($1::uuid,$3::uuid,1,'REGULAR','2026-09-21','2026-09-27','2026-09-01','OPEN'),
       ($2::uuid,$3::uuid,2,'REGULAR','2026-09-28','2026-10-04','2026-09-01','OPEN')`,
      [ids.weekA, ids.weekB, ids.period],
    );
    await pool.query(
      "INSERT INTO venue(id,owner_person_id,name,status) VALUES($1::uuid,$2::uuid,'完结合成场地','ACTIVE')",
      [ids.venue, ids.teacher],
    );
    await pool.query(
      `INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name)
       VALUES($1::uuid,$2::uuid,'completion-course','完结学生')`,
      [ids.student, ids.teacher],
    );
    await pool.query(
      `INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,version)
       VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'ACADEMIC_PLANNER','ACCEPTED',$5::timestamptz,2)`,
      [ids.referral, ids.student, ids.planner, ids.teacher, at.toISOString()],
    );

    const fees = new PostgresWeeklyFeeRepository(pool);
    const record = async (draft, key) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fees.recordWeeklyFeeInTransaction(client, ids.teacher, draft, key);
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
      referralCaseId: ids.referral, teachingWeekId: ids.weekA, venueId: ids.venue,
      settlementMonth: "2026-09-01", grossAmountCents: 10_000n, expectedVersion: 0,
    };
    assert.equal((await record(original, "completion-fee-first")).version, 1);

    const lifecycle = new PostgresReferralLifecycleService(pool);
    const managed = new PostgresManagedReferralReadService(pool);
    const server = createApiServer({
      sessions: {
        login: async () => { throw new Error("NOT_USED"); },
        get: async (sessionId) => ({
          currentRoleContext: sessionId === "teacher-session" ? teacher : sessionId === "admin-session" ? admin : null,
        }),
        switchRole: async () => { throw new Error("NOT_USED"); },
      },
      weeklyFees: {},
      referralLifecycle: lifecycle,
      managedReferrals: managed,
      now: () => at,
    });
    const baseUrl = await listen(server);
    try {
      const completed = await fetch(`${baseUrl}/v1/referrals/${ids.referral}/complete`, {
        method: "POST",
        headers: { authorization: "Bearer teacher-session", "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: 2, idempotencyKey: "completion-http-key" }),
      });
      assert.equal(completed.status, 200);
      assert.deepEqual((await completed.json()).data, {
        referralId: ids.referral, status: "COMPLETED", version: 3, unacceptedExpiresAt: null, replay: false,
      });

      const replay = await fetch(`${baseUrl}/v1/referrals/${ids.referral}/complete`, {
        method: "POST",
        headers: { authorization: "Bearer teacher-session", "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: 2, idempotencyKey: "completion-http-key" }),
      });
      assert.equal(replay.status, 200);
      assert.equal((await replay.json()).data.replay, true);

      const alteredReplay = await fetch(`${baseUrl}/v1/referrals/${ids.referral}/complete`, {
        method: "POST",
        headers: { authorization: "Bearer teacher-session", "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: 3, idempotencyKey: "completion-http-key" }),
      });
      assert.equal(alteredReplay.status, 409);
      assert.equal((await alteredReplay.json()).error.code, "IDEMPOTENCY_REPLAY");

      const directory = await fetch(`${baseUrl}/v1/referrals/managed`, {
        headers: { authorization: "Bearer admin-session" },
      });
      assert.equal(directory.status, 200);
      assert.equal(directory.headers.get("cache-control"), "private, no-store");
      assert.equal(directory.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual((await directory.json()).data, [{
        referralId: ids.referral, studentDisplayName: "完结学生", courseContextId: "completion-course",
        receiverPersonId: ids.teacher, receiverNickname: "完结合成人员-teacher",
        referrerPersonId: ids.planner, referrerNickname: "完结合成人员-planner",
        referralStatus: "COMPLETED", version: 3, submittedAt: "2026-09-24T04:00:00Z",
      }]);
      const forbiddenDirectory = await fetch(`${baseUrl}/v1/referrals/managed`, {
        headers: { authorization: "Bearer teacher-session" },
      });
      assert.equal(forbiddenDirectory.status, 403);
    } finally {
      await closeServer(server);
    }

    assert.deepEqual(
      (await pool.query("SELECT status,version::text FROM referral_case WHERE id=$1::uuid", [ids.referral])).rows[0],
      { status: "COMPLETED", version: "3" },
    );
    assert.deepEqual(
      (await pool.query("SELECT event_type,reason,result_referral_version::text AS version FROM referral_case_event WHERE referral_case_id=$1::uuid ORDER BY created_at DESC,id DESC LIMIT 1", [ids.referral])).rows[0],
      { event_type: "COMPLETED", reason: "RECEIVER_COMPLETED", version: "3" },
    );
    assert.equal((await record({ ...original, expectedVersion: 1, grossAmountCents: 12_000n }, "completion-fee-correction")).version, 2);
    await assert.rejects(
      record({ ...original, teachingWeekId: ids.weekB, expectedVersion: 0 }, "completion-new-week"),
      /REFERRAL_STATE_CONFLICT/,
    );
    await assert.rejects(
      lifecycle.reactivate({ personId: ids.planner, subject: "ACADEMIC_PLANNER", scope: "SELF" }, ids.referral, { expectedVersion: 3 }, "no-reactivation", at),
      /REFERRAL_STATE_CONFLICT/,
    );
    const adminStudent = randomUUID();
    const adminReferral = randomUUID();
    await pool.query(
      `INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name)
       VALUES($1::uuid,$2::uuid,'admin-completion-course','管理员完结学生')`,
      [adminStudent, ids.teacher],
    );
    await pool.query(
      `INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,version)
       VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'ACADEMIC_PLANNER','ACCEPTED',$5::timestamptz,2)`,
      [adminReferral, adminStudent, ids.planner, ids.otherTeacher, at.toISOString()],
    );
    const completedByAdmin = await lifecycle.complete(admin, adminReferral, { expectedVersion: 2 }, "admin-completion", at);
    assert.deepEqual(completedByAdmin, {
      referralId: adminReferral, status: "COMPLETED", version: 3, unacceptedExpiresAt: null, replay: false,
    });
    assert.equal((await pool.query(
      "SELECT reason FROM referral_case_event WHERE referral_case_id=$1::uuid AND event_type='COMPLETED'",
      [adminReferral],
    )).rows[0].reason, "GLOBAL_ADMIN_COMPLETED");

    const assertRevokedCannotComplete = async (actor, receiverPersonId, subject, suffix) => {
      const studentId = randomUUID();
      const referralId = randomUUID();
      await pool.query(
        `INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name)
         VALUES($1::uuid,$2::uuid,$3,$4)`,
        [studentId, ids.teacher, `revoked-${suffix}`, `撤权完结学生-${suffix}`],
      );
      await pool.query(
        `INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,version)
         VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'ACADEMIC_PLANNER','ACCEPTED',$5::timestamptz,2)`,
        [referralId, studentId, ids.planner, receiverPersonId, at.toISOString()],
      );
      const revokedAt = new Date(at.getTime() + 1_000);
      await pool.query(
        "UPDATE role_assignment SET valid_to=$3::timestamptz WHERE person_id=$1::uuid AND subject_code=$2",
        [actor.personId, subject, revokedAt.toISOString()],
      );
      await assert.rejects(
        lifecycle.complete(actor, referralId, { expectedVersion: 2 }, `revoked-${suffix}`, new Date(at.getTime() + 2_000)),
        /FORBIDDEN_SCOPE/,
      );
      assert.equal((await pool.query("SELECT status FROM referral_case WHERE id=$1::uuid", [referralId])).rows[0].status, "ACCEPTED");
    };
    await assertRevokedCannotComplete(admin, ids.otherTeacher, "SYSTEM_ADMIN", "admin");
    await assertRevokedCannotComplete(teacher, ids.teacher, "TEACHING_TEACHER", "teacher");
  } finally {
    await database.close();
  }
});
