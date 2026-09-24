import test from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "./postgres-test-database.mjs";
import { PostgresAccountAccessService, PostgresReferralLifecycleService, PostgresSessionService, createApiServer } from "../../dist/main.js";

const connectionString = process.env.DATABASE_URL;
const at = new Date("2026-09-29T01:00:00.000Z");
const later = new Date("2026-09-29T01:05:00.000Z");

const addAuthority = async (pool, personId, subject) => pool.query(
  `INSERT INTO role_assignment(person_id,subject_code,scope_type,scope_id,valid_from,created_by,created_at)
   VALUES($1,$2,'GLOBAL',NULL,$3,$1,$3)`, [personId, subject, new Date(at.getTime() - 1000).toISOString()],
);

const setup = async () => {
  const database = await createTestDatabase(connectionString);
  const access = new PostgresAccountAccessService(database.pool);
  const owner = await access.register({ nickname: "B2 Owner", legalName: "B2 Owner", phoneNormalized: "13800009001", password: "owner-pass" }, at);
  await addAuthority(database.pool, owner.session.personId, "SYSTEM_OWNER");
  const sessions = new PostgresSessionService(database.pool);
  const ownerContext = (await sessions.switchRole(owner.session.sessionId, "SYSTEM_OWNER", at)).currentRoleContext;
  const target = await access.register({ nickname: "B2 Target", legalName: "B2 Target", phoneNormalized: "13800009002", password: "target-pass" }, at);
  const region = (await database.pool.query("INSERT INTO organization_unit(unit_type,name) VALUES('REGION','B2 Region') RETURNING id")).rows[0].id;
  const campus = (await database.pool.query("INSERT INTO organization_unit(unit_type,name,parent_id) VALUES('CAMPUS','B2 Campus',$1) RETURNING id", [region])).rows[0].id;
  const iso = at.toISOString();
  await database.pool.query("INSERT INTO campus_region_assignment(campus_id,region_id,valid_from,created_by) VALUES($1,$2,$3,$4)", [campus, region, iso, owner.session.personId]);
  await database.pool.query("INSERT INTO person_campus_assignment(person_id,campus_id,region_id,valid_from,created_by) VALUES($1,$2,$3,$4,$1)", [target.session.personId, campus, region, iso]);
  return { database, access, sessions, owner, ownerContext, target, region, campus };
};

test("B2真实PG：首配、切换、角色/auth/history/audit联结与replay", async () => {
  const { database, access, ownerContext, target } = await setup();
  try {
    const first = await access.updatePersonBusinessIdentity(ownerContext, target.session.personId, "TEACHING_TEACHER", "数学", null, "首配", "b2-first", at);
    assert.equal(first.businessIdentityVersion, "1");
    assert.equal(first.gradeSubject, "数学");
    await assert.rejects(() => access.updatePersonBusinessIdentity(ownerContext, target.session.personId, "TEACHING_TEACHER", null, null, "首配", "b2-first", at), /IDEMPOTENCY_REPLAY/);
    const replay = await access.updatePersonBusinessIdentity(ownerContext, target.session.personId, "TEACHING_TEACHER", "数学", null, "首配", "b2-first", at);
    assert.equal(replay.replay, true);
    await assert.rejects(() => access.updatePersonBusinessIdentity(ownerContext, target.session.personId, "TEACHING_TEACHER", "英语", null, "异参", "b2-first", at), /IDEMPOTENCY_REPLAY/);
    const switched = await access.updatePersonBusinessIdentity(ownerContext, target.session.personId, "ACADEMIC_PLANNER", null, "1", "转规划", "b2-switch", later);
    assert.equal(switched.businessIdentityVersion, "2");
    assert.equal(switched.gradeSubject, "数学");
    const facts = await database.pool.query(`SELECT p.business_identity,p.business_identity_version::text AS version,p.grade_subject,a.auth_version::text,
      (SELECT count(*) FROM role_assignment WHERE person_id=$1 AND subject_code='TEACHING_TEACHER' AND valid_to=$2) AS closed,
      (SELECT count(*) FROM role_assignment WHERE person_id=$1 AND subject_code='ACADEMIC_PLANNER' AND valid_from=$2) AS opened,
      (SELECT count(*) FROM teacher_profile_identity_change WHERE person_id=$1) AS history,
      (SELECT count(*) FROM audit_event WHERE subject_id=$1 AND action_code='TEACHER_PROFILE_IDENTITY_CHANGED') AS audits
      FROM teacher_profile p JOIN user_account a ON a.person_id=p.person_id WHERE p.person_id=$1`, [target.session.personId, later.toISOString()]);
    assert.deepEqual(facts.rows[0], { business_identity: "ACADEMIC_PLANNER", version: "2", grade_subject: "数学", auth_version: "3", closed: "1", opened: "1", history: "2", audits: "2" });
  } finally { await database.close(); }
});

test("B2真实PG：ADMIN保护Owner、直接部分写入与历史审计篡改失败", async () => {
  const { database, access, ownerContext, owner, target } = await setup();
  try {
    const admin = await access.register({ nickname: "B2 Admin", legalName: "B2 Admin", phoneNormalized: "13800009003", password: "admin-pass" }, at);
    await addAuthority(database.pool, admin.session.personId, "SYSTEM_ADMIN");
    const adminContext = (await new PostgresSessionService(database.pool).switchRole(admin.session.sessionId, "SYSTEM_ADMIN", at)).currentRoleContext;
    await assert.rejects(() => access.updatePersonBusinessIdentity(adminContext, owner.session.personId, "TEACHING_TEACHER", "数学", null, "保护", "b2-protect", at), /FORBIDDEN_SCOPE/);
    await assert.rejects(() => access.updatePersonBusinessIdentity(ownerContext, target.session.personId, "TEACHING_TEACHER", null, null, "无学科", "b2-grade", at), /GRADE_SUBJECT_REQUIRED/);
    await access.updatePersonBusinessIdentity(ownerContext, target.session.personId, "TEACHING_TEACHER", "数学", null, "首配", "b2-direct", at);
    await assert.rejects(() => database.pool.query("UPDATE teacher_profile SET grade_subject='英语' WHERE person_id=$1", [target.session.personId]), /TEACHER_PROFILE_IDENTITY_WRITE_FORBIDDEN/);
    await assert.rejects(() => database.pool.query("UPDATE teacher_profile_identity_change SET reason='tamper' WHERE person_id=$1", [target.session.personId]), /TEACHER_PROFILE_IDENTITY_CHANGE_IMMUTABLE/);
  } finally { await database.close(); }
});

test("B2真实PG：关系阻塞覆盖当前/未来，planner转授课与零长度未来职责", async () => {
  const { database, access, ownerContext, owner, target } = await setup();
  try {
    await access.updatePersonBusinessIdentity(ownerContext, target.session.personId, "TEACHING_TEACHER", "数学", null, "首配", "block-first", at);
    await database.pool.query(`INSERT INTO person_relationship(teacher_id,relationship_type,related_person_id,valid_from,created_by)
      VALUES($1,'GROUP_LEADER',$2,$3,$2)`, [target.session.personId, owner.session.personId, new Date(at.getTime() + 60_000).toISOString()]);
    await assert.rejects(() => access.updatePersonBusinessIdentity(ownerContext, target.session.personId, "ACADEMIC_PLANNER", null, "1", "未来关系", "block-switch", at), /BUSINESS_IDENTITY_RELATIONSHIP_BLOCKED/);
    await database.pool.query("DELETE FROM person_relationship WHERE teacher_id=$1", [target.session.personId]);
    await access.updatePersonBusinessIdentity(ownerContext, target.session.personId, "ACADEMIC_PLANNER", null, "1", "转规划", "planner-switch", at);
    const cancelledAt = new Date(later.getTime() + 120_000).toISOString();
    await database.pool.query(`INSERT INTO role_assignment(person_id,subject_code,scope_type,scope_id,valid_from,valid_to,created_by,created_at,reason)
      VALUES($1,'ACADEMIC_PLANNER','SELF',NULL,$2,$2,$3,$2,'取消的未来任命')`, [target.session.personId, cancelledAt, owner.session.personId]);
    const switched = await access.updatePersonBusinessIdentity(ownerContext, target.session.personId, "TEACHING_TEACHER", "数学", "2", "转授课", "teacher-switch", later);
    assert.deepEqual({ identity: switched.businessIdentity, version: switched.businessIdentityVersion, grade: switched.gradeSubject }, { identity: "TEACHING_TEACHER", version: "3", grade: "数学" });
    assert.equal((await database.pool.query("SELECT count(*)::int AS n FROM person_relationship WHERE teacher_id=$1", [target.session.personId])).rows[0].n, 0);
  } finally { await database.close(); }
});

test("B2真实PG：并发同版本单胜，缺失/多 settlement 与 campus 阻断", async () => {
  const { database, access, ownerContext, target, region, campus } = await setup();
  try {
    const results = await Promise.allSettled([
      access.updatePersonBusinessIdentity(ownerContext, target.session.personId, "TEACHING_TEACHER", "数学", null, "并发1", "race-1", at),
      access.updatePersonBusinessIdentity(ownerContext, target.session.personId, "TEACHING_TEACHER", "数学", null, "并发2", "race-2", at),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    await database.pool.query("UPDATE settlement_account SET status='INACTIVE' WHERE owner_type='PERSON' AND owner_id=$1", [target.session.personId]);
    await assert.rejects(() => access.updatePersonBusinessIdentity(ownerContext, target.session.personId, "ACADEMIC_PLANNER", null, "1", "无结算", "no-settlement", at), /SETTLEMENT_ACCOUNT_MISSING/);
    await database.pool.query("UPDATE settlement_account SET status='ACTIVE' WHERE owner_type='PERSON' AND owner_id=$1", [target.session.personId]);
    await database.pool.query("UPDATE person_campus_assignment SET region_id=$2 WHERE person_id=$1", [target.session.personId, region]);
    await database.pool.query("DELETE FROM campus_region_assignment WHERE campus_id=$1", [campus]);
    await assert.rejects(() => access.updatePersonBusinessIdentity(ownerContext, target.session.personId, "ACADEMIC_PLANNER", null, "1", "校区错配", "campus-mismatch", at), /CAMPUS_ASSIGNMENT_INVALID/);
  } finally { await database.close(); }
});

test("B2真实PG HTTP：成功、stale/grade、非法输入与ADMIN保护状态码", async () => {
  const { database, access, owner, target } = await setup();
  try {
    const sessions = new PostgresSessionService(database.pool);
    const ownerSession = await sessions.switchRole(owner.session.sessionId, "SYSTEM_OWNER", at);
    const server = createApiServer({ sessions, accountAccess: access, weeklyFees: {}, now: () => at });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const missing = await fetch(`${base}/v1/admin/people/${target.session.personId}/business-identity`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: owner.session.sessionId, businessIdentity: "TEACHING_TEACHER", reason: "缺字段", idempotencyKey: "http-missing" }) });
      assert.equal(missing.status, 400);
      const grade = await fetch(`${base}/v1/admin/people/${target.session.personId}/business-identity`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: owner.session.sessionId, businessIdentity: "TEACHING_TEACHER", gradeSubject: null, expectedBusinessIdentityVersion: null, reason: "缺学科", idempotencyKey: "http-grade" }) });
      assert.equal(grade.status, 409);
      const ok = await fetch(`${base}/v1/admin/people/${target.session.personId}/business-identity`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: owner.session.sessionId, businessIdentity: "TEACHING_TEACHER", gradeSubject: "数学", expectedBusinessIdentityVersion: null, reason: "首配", idempotencyKey: "http-ok" }) });
      assert.equal(ok.status, 200);
      const stale = await fetch(`${base}/v1/admin/people/${target.session.personId}/business-identity`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: owner.session.sessionId, businessIdentity: "ACADEMIC_PLANNER", expectedBusinessIdentityVersion: "9", reason: "旧版本", idempotencyKey: "http-stale" }) });
      assert.equal(stale.status, 409);
    } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  } finally { await database.close(); }
});

test("B2真实PG：重新激活与身份切换按profile锁串行，HTTP返回确定409", async () => {
  const { database, access, ownerContext, owner, target } = await setup();
  const actor = { personId: owner.session.personId, subject: "TEACHING_TEACHER", scope: "SELF" };
  const lifecycle = new PostgresReferralLifecycleService(database.pool);
  const createArchivedReferral = async (suffix) => {
    const student = (await database.pool.query(
      `INSERT INTO teacher_student_record(owner_teacher_id,course_context_id,display_name,created_at,updated_at)
       VALUES($1::uuid,$2,$3,$4::timestamptz,$4::timestamptz) RETURNING id::text`,
      [target.session.personId, `b2-lock-${suffix}`, `锁测试-${suffix}`, at.toISOString()],
    )).rows[0].id;
    return (await database.pool.query(
      `INSERT INTO referral_case(teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,version,created_at,updated_at)
       VALUES($1::uuid,$2::uuid,$3::uuid,'TEACHING_TEACHER','ARCHIVED',$4::timestamptz,1,$4::timestamptz,$4::timestamptz)
       RETURNING id::text`,
      [student, owner.session.personId, target.session.personId, at.toISOString()],
    )).rows[0].id;
  };
  try {
    await access.updatePersonBusinessIdentity(ownerContext, target.session.personId, "TEACHING_TEACHER", "数学", null, "首配", "lock-first", at);

    const firstReferral = await createArchivedReferral("reactivate-first");
    const personLock = await database.pool.connect();
    await personLock.query("BEGIN");
    await personLock.query("SELECT id FROM person WHERE id=$1::uuid FOR UPDATE", [target.session.personId]);
    const blockedSwitch = access.updatePersonBusinessIdentity(ownerContext, target.session.personId, "ACADEMIC_PLANNER", null, "1", "激活先行", "lock-switch-after-reactivate", later);
    const reactivated = await lifecycle.reactivate(actor, firstReferral, { expectedVersion: 1 }, "lock-reactivate-first", later);
    assert.equal(reactivated.status, "REACTIVATED");
    await personLock.query("COMMIT");
    personLock.release();
    await assert.rejects(() => blockedSwitch, /BUSINESS_IDENTITY_RELATIONSHIP_BLOCKED/);
    await lifecycle.archive(actor, firstReferral, { expectedVersion: 2 }, "lock-archive-again", new Date(later.getTime() + 1_000));

    const secondReferral = await createArchivedReferral("identity-first");
    const referralLock = await database.pool.connect();
    await referralLock.query("BEGIN");
    await referralLock.query("SELECT id FROM referral_case WHERE id=$1::uuid FOR UPDATE", [secondReferral]);
    const blockedReactivate = lifecycle.reactivate(actor, secondReferral, { expectedVersion: 1 }, "lock-reactivate-after-switch", new Date(later.getTime() + 2_000));
    const switched = await access.updatePersonBusinessIdentity(ownerContext, target.session.personId, "ACADEMIC_PLANNER", null, "1", "切换先行", "lock-switch-first", new Date(later.getTime() + 2_000));
    assert.equal(switched.businessIdentity, "ACADEMIC_PLANNER");
    await referralLock.query("COMMIT");
    referralLock.release();
    await assert.rejects(() => blockedReactivate, /REFERRAL_RECEIVER_IDENTITY_INVALID/);
    assert.deepEqual(
      (await database.pool.query("SELECT status,version::text FROM referral_case WHERE id=$1::uuid", [secondReferral])).rows[0],
      { status: "ARCHIVED", version: "1" },
    );

    const server = createApiServer({
      sessions: { get: async () => ({ currentRoleContext: actor }) },
      referralLifecycle: lifecycle,
      weeklyFees: {},
      now: () => new Date(later.getTime() + 3_000),
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/referrals/${secondReferral}/reactivate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "synthetic-session", expectedVersion: 1, idempotencyKey: "http-reactivate-planner" }),
      });
      assert.equal(response.status, 409);
      assert.deepEqual((await response.json()).error, { code: "REFERRAL_RECEIVER_IDENTITY_INVALID", message: "REFERRAL_RECEIVER_IDENTITY_INVALID" });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  } finally { await database.close(); }
});
