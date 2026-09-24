import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTestDatabase } from "./postgres-test-database.mjs";
import {
  createApiServer,
  PostgresAccountAccessService,
  PostgresFinanceDraftService,
  PostgresPersonalReadService,
  PostgresSessionService,
  PostgresTeachingReadService,
} from "../../dist/main.js";

const connectionString = process.env.DATABASE_URL;
const at = new Date("2026-09-29T01:00:00.000Z");
const later = new Date("2026-09-29T01:01:00.000Z");

const register = (service, suffix, overrides = {}) => service.register({
  nickname: `合成普通成员${suffix}`,
  legalName: `合成姓名${suffix}`,
  phoneNormalized: `1380000${String(suffix).padStart(4, "0")}`,
  password: `synthetic-password-${suffix}`,
  ...overrides,
}, at);

const addAuthority = async (pool, personId, subject) => {
  await pool.query(
    `INSERT INTO role_assignment(
       person_id,subject_code,scope_type,scope_id,valid_from,created_by,created_at
     ) VALUES($1::uuid,$2,'GLOBAL',NULL,$3::timestamptz,$1::uuid,$3::timestamptz)`,
    [personId, subject, new Date(at.getTime() - 1_000).toISOString()],
  );
};

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

test("普通注册原子建立基础账号、个人钱包和TEACHER会话，不取得授课身份", async () => {
  const database = await createTestDatabase(connectionString);
  const access = new PostgresAccountAccessService(database.pool);
  try {
    const created = await access.register({
      nickname: "  合成普通老师  ",
      legalName: "合成姓名",
      phoneNormalized: "+86 138-0000-1001",
      password: "synthetic-registration-password",
    }, at);
    assert.equal(created.nickname, "合成普通老师");
    assert.equal(created.session.currentRoleContext.subject, "TEACHER");
    assert.equal(created.session.currentRoleContext.scope, "SELF");
    assert.deepEqual(created.session.roleContexts.map((item) => item.subject), ["TEACHER"]);

    const facts = await database.pool.query(
      `SELECT
         (SELECT count(*)::int FROM person WHERE id=$1::uuid) AS persons,
         (SELECT count(*)::int FROM user_account WHERE id=$2::uuid AND phone_normalized='13800001001') AS accounts,
         (SELECT count(*)::int FROM settlement_account WHERE owner_type='PERSON' AND owner_id=$1::uuid AND account_code=$3) AS wallets,
         (SELECT count(*)::int FROM account_balance_projection projection JOIN settlement_account account ON account.id=projection.account_id WHERE account.owner_id=$1::uuid AND projection.balance_cents=0) AS balances,
         (SELECT count(*)::int FROM role_assignment WHERE person_id=$1::uuid AND subject_code='TEACHER' AND scope_type='SELF' AND scope_id IS NULL) AS base_roles,
         (SELECT count(*)::int FROM user_session WHERE account_id=$2::uuid AND current_subject='TEACHER') AS sessions,
         (SELECT count(*)::int FROM teacher_profile WHERE person_id=$1::uuid) AS profiles,
         (SELECT count(*)::int FROM person_campus_assignment WHERE person_id=$1::uuid) AS campuses,
         (SELECT count(*)::int FROM person_relationship WHERE teacher_id=$1::uuid OR related_person_id=$1::uuid) AS relationships`,
      [created.session.personId, created.session.accountId, `person:${created.session.personId}`],
    );
    assert.deepEqual(facts.rows[0], {
      persons: 1,
      accounts: 1,
      wallets: 1,
      balances: 1,
      base_roles: 1,
      sessions: 1,
      profiles: 0,
      campuses: 0,
      relationships: 0,
    });

    const sessions = new PostgresSessionService(database.pool);
    const restored = await sessions.get(created.session.sessionId, later);
    assert.equal(restored.currentRoleContext.subject, "TEACHER");
    const overview = await new PostgresPersonalReadService(database.pool)
      .getOwnOverview(restored.currentRoleContext, later);
    assert.equal(overview.balanceCents, 0n);
    const draft = await new PostgresFinanceDraftService(database.pool).create(
      restored.currentRoleContext,
      { kind: "REIMBURSEMENT" },
      "ordinary-reimbursement-draft",
      later,
    );
    assert.equal(draft.status, "DRAFT");
    await assert.rejects(
      new PostgresTeachingReadService(database.pool)
        .listOpenTeachingWeeks(restored.currentRoleContext, later),
      /FORBIDDEN_SCOPE/,
    );

    const registrationServer = createApiServer({
      sessions,
      accountAccess: access,
      personal: new PostgresPersonalReadService(database.pool),
      weeklyFees: {},
      now: () => later,
    });
    const registrationBase = await listen(registrationServer);
    try {
      const response = await fetch(`${registrationBase}/v1/accounts/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nickname: "HTTP注册成员",
          legalName: "HTTP合成姓名",
          phoneNormalized: "13800001007",
          password: "http-registration-password",
        }),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      const envelope = await response.json();
      assert.equal(envelope.data.currentRoleContext.subject, "TEACHER");
      const own = await fetch(`${registrationBase}/v1/me`, {
        headers: { authorization: `Bearer ${envelope.data.sessionId}` },
      });
      assert.equal(own.status, 200);
      assert.equal((await own.json()).data.balanceCents, "0");
      const forged = await fetch(`${registrationBase}/v1/accounts/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nickname: "伪造角色注册",
          legalName: "伪造角色姓名",
          phoneNormalized: "13800001008",
          password: "forged-registration-password",
          role: "SYSTEM_ADMIN",
        }),
      });
      assert.equal(forged.status, 400);
      assert.equal((await database.pool.query("SELECT count(*)::int AS n FROM user_account WHERE phone_normalized='13800001008'")).rows[0].n, 0);
    } finally {
      await closeServer(registrationServer);
    }

    const samePhone = await Promise.allSettled([
      register(access, 1002, { phoneNormalized: "13800001002", nickname: "并发手机号甲" }),
      register(access, 1003, { phoneNormalized: "13800001002", nickname: "并发手机号乙" }),
    ]);
    assert.equal(samePhone.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(samePhone.filter((item) => item.status === "rejected").length, 1);
    assert.match(samePhone.find((item) => item.status === "rejected").reason.message, /REGISTRATION_PHONE_CONFLICT/);
    assert.equal((await database.pool.query("SELECT count(*)::int AS n FROM person WHERE nickname IN ('并发手机号甲','并发手机号乙')")).rows[0].n, 1);

    const sameNickname = await Promise.allSettled([
      register(access, 1004, { phoneNormalized: "13800001004", nickname: "并发同昵称" }),
      register(access, 1005, { phoneNormalized: "13800001005", nickname: "并发同昵称" }),
    ]);
    assert.equal(sameNickname.filter((item) => item.status === "fulfilled").length, 1);
    assert.match(sameNickname.find((item) => item.status === "rejected").reason.message, /REGISTRATION_NICKNAME_CONFLICT/);
    assert.equal((await database.pool.query("SELECT count(*)::int AS n FROM person WHERE nickname='并发同昵称'")).rows[0].n, 1);

    await database.pool.query(`CREATE FUNCTION fail_account_registration_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action_code='ACCOUNT_REGISTERED' THEN RAISE EXCEPTION 'FORCED_REGISTRATION_FAILURE'; END IF; RETURN NEW; END; $$`);
    await database.pool.query("CREATE TRIGGER fail_account_registration_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION fail_account_registration_audit()");
    await assert.rejects(
      register(access, 1006, { phoneNormalized: "13800001006", nickname: "应整体回滚" }),
      /FORCED_REGISTRATION_FAILURE/,
    );
    const rolledBack = await database.pool.query(
      `SELECT
         (SELECT count(*)::int FROM person WHERE nickname='应整体回滚') AS persons,
         (SELECT count(*)::int FROM user_account WHERE phone_normalized='13800001006') AS accounts,
         (SELECT count(*)::int FROM settlement_account WHERE account_code LIKE 'person:%' AND owner_id NOT IN (SELECT id FROM person)) AS orphan_wallets`,
    );
    assert.deepEqual(rolledBack.rows[0], { persons: 0, accounts: 0, orphan_wallets: 0 });
  } finally {
    await database.close();
  }
});

test("管理员重置遵守真实GLOBAL层级，同键不二次失效且目录不泄露资金或秘密", async () => {
  const database = await createTestDatabase(connectionString);
  const access = new PostgresAccountAccessService(database.pool);
  const sessions = new PostgresSessionService(database.pool);
  try {
    const owner = await register(access, 1101);
    const admin = await register(access, 1102);
    const target = await register(access, 1103);
    await addAuthority(database.pool, owner.session.personId, "SYSTEM_OWNER");
    await addAuthority(database.pool, admin.session.personId, "SYSTEM_ADMIN");
    const ownerSession = await sessions.switchRole(owner.session.sessionId, "SYSTEM_OWNER", later);
    const adminSession = await sessions.switchRole(admin.session.sessionId, "SYSTEM_ADMIN", later);
    const targetOldSession = target.session.sessionId;

    const first = await access.resetPassword(
      adminSession.currentRoleContext,
      target.session.accountId,
      "replacement-password-1103",
      "成员忘记密码，管理员现场核验后重置",
      "reset-target-1103",
      later,
    );
    assert.equal(first.replay, false);
    assert.equal(first.authVersion, "2");
    await assert.rejects(sessions.get(targetOldSession, later), /UNAUTHENTICATED/);
    const replay = await access.resetPassword(
      adminSession.currentRoleContext,
      target.session.accountId,
      "replacement-password-1103",
      "成员忘记密码，管理员现场核验后重置",
      "reset-target-1103",
      later,
    );
    assert.equal(replay.replay, true);
    assert.equal(replay.authVersion, "2");
    assert.equal((await database.pool.query("SELECT auth_version::text AS version FROM user_account WHERE id=$1", [target.session.accountId])).rows[0].version, "2");
    assert.equal((await database.pool.query("SELECT count(*)::int AS n FROM audit_event WHERE action_code='ACCOUNT_PASSWORD_RESET' AND subject_id=$1", [target.session.accountId])).rows[0].n, 1);
    await assert.rejects(
      access.resetPassword(adminSession.currentRoleContext, target.session.accountId, "different-password-1103", "成员忘记密码，管理员现场核验后重置", "reset-target-1103", later),
      /IDEMPOTENCY_REPLAY/,
    );
    assert.equal((await sessions.login("13800001103", "replacement-password-1103", later, "198.51.100.3")).personId, target.session.personId);

    await assert.rejects(
      access.resetPassword(adminSession.currentRoleContext, owner.session.accountId, "forbidden-owner-reset", "越权重置", "reset-owner", later),
      /FORBIDDEN_SCOPE/,
    );
    await assert.rejects(
      access.resetPassword(adminSession.currentRoleContext, admin.session.accountId, "forbidden-admin-reset", "越权重置", "reset-admin-self", later),
      /FORBIDDEN_SCOPE/,
    );
    const ownerReset = await access.resetPassword(
      ownerSession.currentRoleContext,
      admin.session.accountId,
      "owner-reset-admin-password",
      "开发者重置管理员密码",
      "owner-reset-admin",
      later,
    );
    assert.equal(ownerReset.authVersion, "2");
    await assert.rejects(
      access.listAccounts({ ...adminSession.currentRoleContext, personId: target.session.personId }, later),
      /FORBIDDEN_SCOPE/,
    );

    const directory = await access.listAccounts(ownerSession.currentRoleContext, later);
    const serializedDirectory = JSON.stringify(directory);
    assert.equal(serializedDirectory.includes("balance"), false);
    assert.equal(serializedDirectory.includes("password"), false);
    assert.equal(serializedDirectory.includes("authVersion"), false);
    assert.equal(serializedDirectory.includes("session"), false);
    assert.ok(directory.some((item) => item.accountId === admin.session.accountId && item.activeSystemAuthorities.includes("SYSTEM_ADMIN")));

    const adminServer = createApiServer({
      sessions,
      accountAccess: access,
      weeklyFees: {},
      now: () => later,
    });
    const adminBase = await listen(adminServer);
    try {
      assert.equal((await fetch(`${adminBase}/v1/admin/accounts`)).status, 401);
      const directoryResponse = await fetch(`${adminBase}/v1/admin/accounts`, {
        headers: { authorization: `Bearer ${ownerSession.sessionId}` },
      });
      assert.equal(directoryResponse.status, 200);
      assert.equal(directoryResponse.headers.get("cache-control"), "private, no-store");
      const directoryText = await directoryResponse.text();
      for (const forbidden of ["passwordHash", "authVersion", "balanceCents", "sessionId"]) {
        assert.equal(directoryText.includes(forbidden), false);
      }
      const httpReset = await fetch(`${adminBase}/v1/admin/accounts/${target.session.accountId}/password-reset`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ownerSession.sessionId}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          newPassword: "owner-second-reset-password",
          reason: "开发者再次处理成员密码",
          idempotencyKey: "owner-second-target-reset",
        }),
      });
      assert.equal(httpReset.status, 200);
      assert.equal((await httpReset.json()).data.authVersion, "3");
    } finally {
      await closeServer(adminServer);
    }

    const audits = await database.pool.query("SELECT before_json::text,after_json::text,reason FROM audit_event WHERE action_code='ACCOUNT_PASSWORD_RESET'");
    for (const secretProbe of ["owner-reset-admin-password", "owner-second-reset-password", "replacement-password-1103"]) {
      assert.equal(JSON.stringify(audits.rows).includes(secretProbe), false);
    }
    const command = await database.pool.query("SELECT password_hash,reason,result_auth_version::text AS version FROM auth_password_reset_command WHERE target_account_id=$1", [admin.session.accountId]);
    assert.match(command.rows[0].password_hash, /^scrypt-v1\$/);
    assert.notEqual(command.rows[0].password_hash, "owner-reset-admin-password");
    assert.equal(command.rows[0].version, "2");
    await assert.rejects(
      database.pool.query(
        `INSERT INTO auth_password_reset_command(
           actor_person_id,idempotency_key,target_account_id,reason,password_hash,result_auth_version,
           actor_subject_code,actor_scope_type,created_at
         ) VALUES($1::uuid,'forged-subject',$2::uuid,'伪造命令',$3,3,'TEACHER','GLOBAL',$4::timestamptz)`,
        [owner.session.personId, target.session.accountId, command.rows[0].password_hash, later.toISOString()],
      ),
      /check constraint/,
    );
    await assert.rejects(
      database.pool.query(
        `INSERT INTO auth_password_reset_command(
           actor_person_id,idempotency_key,target_account_id,reason,password_hash,result_auth_version,
           actor_subject_code,actor_scope_type,created_at
         ) VALUES($1::uuid,'forged-scope',$2::uuid,'伪造命令',$3,3,'SYSTEM_OWNER','SELF',$4::timestamptz)`,
        [owner.session.personId, target.session.accountId, command.rows[0].password_hash, later.toISOString()],
      ),
      /check constraint/,
    );
  } finally {
    await database.close();
  }
});

test("账号与真实来源IP限流并发不丢计数、重启保留，HTTP忽略X-Forwarded-For", async () => {
  const database = await createTestDatabase(connectionString);
  const access = new PostgresAccountAccessService(database.pool);
  try {
    await register(access, 1201);
    const accountLimited = new PostgresSessionService(database.pool, {
      accountFailureLimit: 3,
      ipFailureLimit: 50,
    });
    const accountAttempts = await Promise.allSettled([
      accountLimited.login("13800001201", "wrong-password-a", at, "198.51.100.11"),
      accountLimited.login("13800001201", "wrong-password-b", at, "198.51.100.12"),
      accountLimited.login("13800001201", "wrong-password-c", at, "198.51.100.13"),
    ]);
    assert.equal(accountAttempts.filter((item) => item.status === "rejected" && item.reason.message === "UNAUTHENTICATED").length, 2);
    assert.equal(accountAttempts.filter((item) => item.status === "rejected" && item.reason.message === "LOGIN_RATE_LIMITED").length, 1);
    const accountThrottle = await database.pool.query("SELECT failure_count,blocked_until IS NOT NULL AS blocked FROM auth_login_throttle WHERE dimension_type='ACCOUNT'");
    assert.deepEqual(accountThrottle.rows, [{ failure_count: 3, blocked: true }]);
    await assert.rejects(
      new PostgresSessionService(database.pool, { accountFailureLimit: 3, ipFailureLimit: 50 })
        .login("13800001201", "synthetic-password-1201", later, "203.0.113.1"),
      /LOGIN_RATE_LIMITED/,
    );
    const afterWindow = new Date(at.getTime() + 16 * 60_000);
    assert.equal((await accountLimited.login("13800001201", "synthetic-password-1201", afterWindow, "203.0.113.1")).currentRoleContext.subject, "TEACHER");

    await database.pool.query("DELETE FROM auth_login_throttle");
    const ipLimited = new PostgresSessionService(database.pool, {
      accountFailureLimit: 10,
      ipFailureLimit: 3,
    });
    const ipAttempts = await Promise.allSettled([
      ipLimited.login("13900000001", "missing-password-a", at, "192.0.2.77"),
      ipLimited.login("13900000002", "missing-password-b", at, "192.0.2.77"),
      ipLimited.login("13900000003", "missing-password-c", at, "192.0.2.77"),
    ]);
    assert.equal(ipAttempts.filter((item) => item.status === "rejected" && item.reason.message === "LOGIN_RATE_LIMITED").length, 1);
    const ipThrottle = await database.pool.query("SELECT failure_count,blocked_until IS NOT NULL AS blocked FROM auth_login_throttle WHERE dimension_type='IP'");
    assert.deepEqual(ipThrottle.rows, [{ failure_count: 3, blocked: true }]);
    await assert.rejects(
      new PostgresSessionService(database.pool, { accountFailureLimit: 10, ipFailureLimit: 3 })
        .login("13800001201", "synthetic-password-1201", later, "192.0.2.77"),
      /LOGIN_RATE_LIMITED/,
    );

    await database.pool.query("DELETE FROM auth_login_throttle");
    const httpSessions = new PostgresSessionService(database.pool, {
      accountFailureLimit: 20,
      ipFailureLimit: 2,
    });
    const server = createApiServer({
      sessions: httpSessions,
      accountAccess: access,
      weeklyFees: {},
      now: () => at,
    });
    const base = await listen(server);
    try {
      const login = async (forwardedFor) => fetch(`${base}/v1/session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": forwardedFor,
        },
        body: JSON.stringify({
          phoneNormalized: `13900000${forwardedFor === "10.0.0.1" ? "101" : "102"}`,
          password: "missing-http-password",
        }),
      });
      const first = await login("10.0.0.1");
      const second = await login("10.0.0.2");
      assert.equal(first.status, 401);
      assert.equal(second.status, 429);
      assert.deepEqual((await first.json()).error, { code: "UNAUTHENTICATED", message: "UNAUTHENTICATED" });
      assert.deepEqual((await second.json()).error, { code: "LOGIN_RATE_LIMITED", message: "LOGIN_RATE_LIMITED" });
      assert.equal(first.headers.get("cache-control"), "private, no-store");
      const ipRows = await database.pool.query("SELECT count(*)::int AS n,max(failure_count)::int AS failures FROM auth_login_throttle WHERE dimension_type='IP'");
      assert.deepEqual(ipRows.rows[0], { n: 1, failures: 2 });
    } finally {
      await closeServer(server);
    }
  } finally {
    await database.close();
  }
});

test("职责任免、停复用都审计并立即使旧会话失效，系统管理权不会锁死", async () => {
  const database = await createTestDatabase(connectionString);
  const access = new PostgresAccountAccessService(database.pool);
  const sessions = new PostgresSessionService(database.pool);
  try {
    const owner = await register(access, 1301);
    const otherOwner = await register(access, 1302);
    const admin = await register(access, 1303);
    const target = await register(access, 1304);
    const futureTarget = await register(access, 1305);
    const statusOnlyTarget = await register(access, 1306);
    const scheduledAdministrator = await register(access, 1310);
    await addAuthority(database.pool, owner.session.personId, "SYSTEM_OWNER");
    await addAuthority(database.pool, otherOwner.session.personId, "SYSTEM_OWNER");
    await addAuthority(database.pool, admin.session.personId, "SYSTEM_ADMIN");
    const ownerContext = (await sessions.switchRole(owner.session.sessionId, "SYSTEM_OWNER", later)).currentRoleContext;
    const otherOwnerContext = (await sessions.switchRole(otherOwner.session.sessionId, "SYSTEM_OWNER", later)).currentRoleContext;
    const adminContext = (await sessions.switchRole(admin.session.sessionId, "SYSTEM_ADMIN", later)).currentRoleContext;
    const scheduledAdministratorAt = new Date(later.getTime() + 24 * 60 * 60_000);
    await database.pool.query(
      `INSERT INTO role_assignment(person_id,subject_code,scope_type,scope_id,valid_from,created_by,created_at)
       VALUES($1::uuid,'SYSTEM_ADMIN','GLOBAL',NULL,$2::timestamptz,$3::uuid,$4::timestamptz)`,
      [scheduledAdministrator.session.personId, scheduledAdministratorAt.toISOString(), owner.session.personId, later.toISOString()],
    );
    await assert.rejects(
      access.setPersonStatus(adminContext, scheduledAdministrator.session.personId, "INACTIVE", "管理员不能绕过已安排系统身份", "future-admin-status", later), /FORBIDDEN_SCOPE/,
    );
    const people = await access.listPeople(ownerContext, later);
    const ownerDirectory = people.find((item) => item.personId === owner.session.personId);
    assert.equal(ownerDirectory?.responsibilities.some((item) => item.subject === "SYSTEM_OWNER" && item.scope === "GLOBAL"), true);
    const serializedDirectory = JSON.stringify(people);
    for (const sensitiveField of ["salary", "bank", "balance", "token", "password", "authVersion"]) {
      assert.equal(serializedDirectory.toLowerCase().includes(sensitiveField.toLowerCase()), false);
    }

    await assert.rejects(
      access.assignRole(adminContext, target.session.personId, {
        subject: "SYSTEM_ADMIN", scope: "GLOBAL", validFrom: later.toISOString(), reason: "管理员不得任免系统管理员",
      }, "admin-system-admin", later), /ONLY_SYSTEM_OWNER_CAN_MANAGE_ADMIN/,
    );
    await assert.rejects(
      access.assignRole(ownerContext, target.session.personId, {
        subject: "REGION_FINANCE", scope: "GLOBAL", validFrom: later.toISOString(), reason: "范围错误",
      }, "bad-scope", later), /INVALID_ROLE_SCOPE/,
    );
    for (const subject of ["TEACHER", "TEACHING_TEACHER", "ACADEMIC_PLANNER", "VENUE_OWNER"]) {
      await assert.rejects(
        access.assignRole(ownerContext, target.session.personId, {
          subject, scope: subject === "VENUE_OWNER" ? "VENUE" : "SELF", validFrom: later.toISOString(), reason: "不得手工任命派生或基础职责",
        }, `forbidden-${subject}`, later), /FORBIDDEN_SCOPE/,
      );
    }
    const baseTeacher = await database.pool.query(
      "SELECT id::text AS id FROM role_assignment WHERE person_id=$1::uuid AND subject_code='TEACHER'", [target.session.personId],
    );
    await assert.rejects(
      access.revokeRole(ownerContext, baseTeacher.rows[0].id, "基础身份不可撤销", "forbidden-revoke-teacher", later), /FORBIDDEN_SCOPE/,
    );
    const grant = await access.assignRole(ownerContext, target.session.personId, {
      subject: "PLANNING_MENTOR", scope: "SELF", validFrom: later.toISOString(), reason: "承担规划导师职责",
    }, "grant-teaching", later);
    assert.equal(grant.replay, false);
    await assert.rejects(() => sessions.get(target.session.sessionId, later), /UNAUTHENTICATED/);
    const replay = await access.assignRole(ownerContext, target.session.personId, {
      subject: "PLANNING_MENTOR", scope: "SELF", validFrom: later.toISOString(), reason: "承担规划导师职责",
    }, "grant-teaching", later);
    assert.equal(replay.replay, true);
    await assert.rejects(
      access.assignRole(ownerContext, target.session.personId, {
        subject: "PLANNING_MENTOR", scope: "SELF", validFrom: later.toISOString(), reason: "重复职责",
      }, "grant-overlap", later), /ROLE_ASSIGNMENT_OVERLAP/,
    );
    const revokeAt = later;
    const revoked = await access.revokeRole(ownerContext, grant.assignment.assignmentId, "职责结束", "revoke-teaching", later);
    assert.equal(revoked.assignment.validTo, revokeAt.toISOString());

    const futureStart = new Date(later.getTime() + 24 * 60 * 60_000);
    const futureGrant = await access.assignRole(ownerContext, futureTarget.session.personId, {
      subject: "PLANNING_MENTOR", scope: "SELF", validFrom: futureStart.toISOString(), reason: "未来规划导师安排",
    }, "future-grant", later);
    await assert.rejects(() => sessions.get(futureTarget.session.sessionId, later), /UNAUTHENTICATED/);
    const futureCancelled = await access.revokeRole(ownerContext, futureGrant.assignment.assignmentId, "未来安排取消", "future-cancel", later);
    assert.equal(futureCancelled.assignment.validTo, futureStart.toISOString());
    const futureLogin = await sessions.login("13800001305", "synthetic-password-1305", new Date(futureStart.getTime() + 1_000));
    assert.equal(futureLogin.roleContexts.some((item) => item.subject === "PLANNING_MENTOR"), false);

    await assert.rejects(
      access.setPersonStatus(adminContext, owner.session.personId, "INACTIVE", "管理员不得停用系统身份", "admin-owner-status", later), /FORBIDDEN_SCOPE/,
    );
    await assert.rejects(
      access.setPersonStatus(ownerContext, owner.session.personId, "INACTIVE", "不得停用自己", "owner-self-status", later), /CANNOT_DEACTIVATE_SELF/,
    );
    const deactivated = await access.setPersonStatus(ownerContext, target.session.personId, "INACTIVE", "离职停用", "target-inactive", later);
    assert.equal(deactivated.personStatus, "INACTIVE");
    const restored = await access.setPersonStatus(ownerContext, target.session.personId, "ACTIVE", "返聘恢复账号", "target-active", new Date(later.getTime() + 1_000));
    assert.equal(restored.personStatus, "ACTIVE");
    await assert.rejects(() => sessions.get(target.session.sessionId, new Date(later.getTime() + 2_000)), /UNAUTHENTICATED/);
    const statusOnlyInitial = await database.pool.query("SELECT auth_version::text AS auth_version FROM user_account WHERE id=$1::uuid", [statusOnlyTarget.session.accountId]);
    await access.setPersonStatus(ownerContext, statusOnlyTarget.session.personId, "INACTIVE", "单独验证停用", "status-only-inactive", later);
    await assert.rejects(() => sessions.get(statusOnlyTarget.session.sessionId, later), /UNAUTHENTICATED/);
    await assert.rejects(
      access.assignRole(ownerContext, statusOnlyTarget.session.personId, {
        subject: "PLANNING_MENTOR", scope: "SELF", validFrom: later.toISOString(), reason: "停用人员不可任命",
      }, "inactive-person-role", later), /PERSON_INACTIVE/,
    );
    await access.setPersonStatus(ownerContext, statusOnlyTarget.session.personId, "ACTIVE", "单独验证恢复", "status-only-active", new Date(later.getTime() + 1_000));
    await assert.rejects(() => sessions.get(statusOnlyTarget.session.sessionId, new Date(later.getTime() + 2_000)), /UNAUTHENTICATED/);
    const statusOnlyFinal = await database.pool.query("SELECT auth_version::text AS auth_version FROM user_account WHERE id=$1::uuid", [statusOnlyTarget.session.accountId]);
    assert.equal(BigInt(statusOnlyFinal.rows[0].auth_version), BigInt(statusOnlyInitial.rows[0].auth_version) + 2n);
    const responsibility = await database.pool.query("SELECT valid_to::text AS valid_to FROM role_assignment WHERE id=$1::uuid", [grant.assignment.assignmentId]);
    assert.equal(new Date(responsibility.rows[0].valid_to).toISOString(), revokeAt.toISOString());
    const audit = await database.pool.query("SELECT action_code,before_json,after_json,reason FROM audit_event WHERE action_code IN ('ROLE_ASSIGNED','ROLE_REVOKED','PERSON_STATUS_CHANGED') ORDER BY created_at");
    assert.ok(audit.rows.some((row) =>
      row.action_code === "ROLE_ASSIGNED"
      && row.before_json === null
      && row.after_json?.subject === "PLANNING_MENTOR"
      && row.after_json?.scope === "SELF",
    ));
    assert.ok(audit.rows.some((row) =>
      row.action_code === "PERSON_STATUS_CHANGED"
      && row.before_json?.status === "INACTIVE"
      && row.after_json?.status === "ACTIVE",
    ));
    assert.ok(audit.rows.some((row) =>
      row.action_code === "ROLE_REVOKED"
      && row.before_json?.validTo === undefined
      && row.after_json?.validTo === futureStart.toISOString(),
    ));

    const mutualOwnerDeactivation = await Promise.allSettled([
      access.setPersonStatus(ownerContext, otherOwner.session.personId, "INACTIVE", "并发治理测试", "owner-b-stops-c", later),
      access.setPersonStatus(otherOwnerContext, owner.session.personId, "INACTIVE", "并发治理测试", "owner-c-stops-b", later),
      access.setPersonStatus(adminContext, owner.session.personId, "INACTIVE", "管理员不能绕过治理", "admin-stops-owner", later),
    ]);
    const ownerOutcomes = mutualOwnerDeactivation.slice(0, 2);
    assert.equal(ownerOutcomes.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(ownerOutcomes.filter((item) => item.status === "rejected").length, 1);
    assert.equal(mutualOwnerDeactivation[2]?.status, "rejected");
    if (mutualOwnerDeactivation[2]?.status === "rejected") assert.match(mutualOwnerDeactivation[2].reason.message, /FORBIDDEN_SCOPE/);
    const liveOwners = await database.pool.query(
      `SELECT account.phone_normalized FROM role_assignment authority
        JOIN person owner_person ON owner_person.id=authority.person_id AND owner_person.status='ACTIVE'
        JOIN user_account account ON account.person_id=owner_person.id AND account.login_status='ACTIVE'
       WHERE authority.subject_code='SYSTEM_OWNER' AND authority.scope_type='GLOBAL' AND authority.scope_id IS NULL
         AND authority.valid_from <= $1::timestamptz AND (authority.valid_to IS NULL OR $1::timestamptz < authority.valid_to)`, [later.toISOString()],
    );
    assert.ok(liveOwners.rows.length >= 1);
    const survivingPhone = liveOwners.rows[0].phone_normalized;
    const survivingSuffix = Number(survivingPhone.slice(-4));
    const survivingSession = await sessions.login(survivingPhone, `synthetic-password-${survivingSuffix}`, new Date(later.getTime() + 2_000));
    assert.equal(survivingSession.roleContexts.some((item) => item.subject === "SYSTEM_OWNER"), true);
    const survivingOwnerContext = (await sessions.switchRole(survivingSession.sessionId, "SYSTEM_OWNER", new Date(later.getTime() + 2_000))).currentRoleContext;
    const overlapTarget = await register(access, 1307);
    const sameResponsibility = { subject: "PLANNING_MENTOR", scope: "SELF", validFrom: later.toISOString(), reason: "并发同职责" };
    const sameTargetOutcomes = await Promise.allSettled([
      access.assignRole(survivingOwnerContext, overlapTarget.session.personId, sameResponsibility, "same-responsibility-a", later),
      access.assignRole(survivingOwnerContext, overlapTarget.session.personId, sameResponsibility, "same-responsibility-b", later),
    ]);
    assert.equal(sameTargetOutcomes.filter((item) => item.status === "fulfilled").length, 1);
    const rejectedOverlap = sameTargetOutcomes.find((item) => item.status === "rejected");
    if (rejectedOverlap?.status === "rejected") assert.match(rejectedOverlap.reason.message, /ROLE_ASSIGNMENT_OVERLAP/);
    const replayKey = sameTargetOutcomes[0]?.status === "fulfilled" ? "same-responsibility-a" : "same-responsibility-b";
    assert.equal((await access.assignRole(survivingOwnerContext, overlapTarget.session.personId, sameResponsibility, replayKey, later)).replay, true);
    const differentTarget = await register(access, 1308);
    const differentDutyTarget = await register(access, 1309);
    const unrelatedOutcomes = await Promise.allSettled([
      access.assignRole(survivingOwnerContext, differentTarget.session.personId, { subject: "TEACHING_MENTOR", scope: "MENTEES", validFrom: later.toISOString(), reason: "并发不同对象" }, "different-target", later),
      access.assignRole(survivingOwnerContext, differentDutyTarget.session.personId, { subject: "HEADQUARTERS_FINANCE", scope: "GLOBAL", validFrom: later.toISOString(), reason: "并发不同职责" }, "different-duty", later),
    ]);
    assert.equal(unrelatedOutcomes.every((item) => item.status === "fulfilled"), true);
  } finally {
    await database.close();
  }
});
