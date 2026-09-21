import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTestDatabase } from "./postgres-test-database.mjs";
import { hashPassword, verifyPassword } from "../../dist/password.js";
import { PostgresSessionService } from "../../dist/postgres-session-service.js";
import { createApiServer, PostgresPersonalReadService, PostgresWeeklyFeeService } from "../../dist/main.js";

const at = new Date("2026-09-28T00:00:00Z");
const later = new Date("2026-09-28T00:01:00Z");

test("数据库密码登录、重启续用、职责变化、密码重置和离职撤销", async () => {
  const database = await createTestDatabase(process.env.DATABASE_URL);
  const { pool } = database;
  const personId = randomUUID();
  const accountId = randomUUID();
  const password = "synthetic-password-only";
  try {
    const passwordHash = await hashPassword(password);
    const secondHash = await hashPassword(password);
    assert.notEqual(passwordHash, secondHash);
    assert.equal(await verifyPassword(password, passwordHash), true);
    assert.equal(await verifyPassword("wrong-password", passwordHash), false);
    assert.equal(await verifyPassword(password, "plaintext-not-a-hash"), false);
    assert.equal(await verifyPassword("x".repeat(2000), passwordHash), false);
    await pool.query("INSERT INTO person(id, nickname, legal_name, status) VALUES ($1, '合成登录教师', '合成姓名', 'ACTIVE')", [personId]);
    await pool.query("INSERT INTO user_account(id, person_id, phone_normalized, password_hash, login_status) VALUES ($1, $2, '13800000001', $3, 'ACTIVE')", [accountId, personId, passwordHash]);
    await pool.query("INSERT INTO settlement_account(owner_type, owner_id, account_code, status) VALUES ('PERSON', $1, 'session-test-person', 'ACTIVE')", [personId]);
    await pool.query("INSERT INTO role_assignment(person_id,subject_code,scope_type,valid_from,created_by) VALUES ($1,'TEACHING_TEACHER','SELF','2026-01-01',$1)", [personId]);
    const sessions = new PostgresSessionService(pool);
    await assert.rejects(sessions.login("13800000001", "wrong-password", at), /UNAUTHENTICATED/);
    await assert.rejects(sessions.login("13999999999", password, at), /UNAUTHENTICATED/);
    const login = await sessions.login("13800000001", password, at);
    assert.equal(login.personId, personId);
    assert.equal(login.currentRoleContext.subject, "TEACHING_TEACHER");
    assert.ok(login.sessionId.length >= 40);
    assert.equal(JSON.stringify(login).includes(passwordHash), false);
    const stored = await pool.query("SELECT token_hash FROM user_session WHERE account_id=$1", [accountId]);
    assert.equal(stored.rows.length, 1);
    assert.match(stored.rows[0].token_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(stored.rows[0].token_hash, login.sessionId);
    await assert.rejects(sessions.get(login.sessionId, new Date(at.getTime()-1)), /UNAUTHENTICATED/);
    const restored = await new PostgresSessionService(pool).get(login.sessionId, later);
    assert.equal(restored.accountId, accountId);
    assert.equal(restored.currentRoleContext.subject, "TEACHING_TEACHER");
    await assert.rejects(sessions.switchRole(login.sessionId, "SYSTEM_ADMIN", at), /ROLE_CONTEXT_NOT_ASSIGNED/);
    await pool.query("INSERT INTO role_assignment(person_id,subject_code,scope_type,valid_from,created_by) VALUES ($1,'ACADEMIC_PLANNER','SELF','2026-01-01',$1)", [personId]);
    assert.equal((await sessions.get(login.sessionId, at)).roleContexts.length, 2);
    assert.equal((await sessions.switchRole(login.sessionId, "ACADEMIC_PLANNER", at)).currentRoleContext.subject, "ACADEMIC_PLANNER");
    await pool.query("UPDATE role_assignment SET valid_to = $2 WHERE person_id = $1 AND subject_code = 'ACADEMIC_PLANNER'", [personId, at]);
    assert.equal((await sessions.get(login.sessionId, later)).currentRoleContext, null);
    const shortSessions = new PostgresSessionService(pool, { sessionTtlMs: 1000 });
    const shortLogin = await shortSessions.login("13800000001", password, at);
    await assert.rejects(shortSessions.get(shortLogin.sessionId, later), /UNAUTHENTICATED/);
    const resetHash = await hashPassword("replacement-password");
    await pool.query("UPDATE user_account SET password_hash=$2 WHERE id=$1", [accountId, resetHash]);
    await assert.rejects(sessions.get(login.sessionId, later), /UNAUTHENTICATED/);
    await assert.rejects(sessions.login("13800000001", password, later), /UNAUTHENTICATED/);
    const resetLogin = await sessions.login("13800000001", "replacement-password", later);
    await pool.query("UPDATE user_account SET login_status='REVOKED' WHERE id=$1", [accountId]);
    await assert.rejects(sessions.get(resetLogin.sessionId, later), /UNAUTHENTICATED/);
    await pool.query("UPDATE user_account SET login_status='ACTIVE' WHERE id=$1", [accountId]);
    await assert.rejects(sessions.get(resetLogin.sessionId, later), /UNAUTHENTICATED/);
    const employedLogin = await sessions.login("13800000001", "replacement-password", later);
    await pool.query("UPDATE person SET status='INACTIVE' WHERE id=$1", [personId]);
    await assert.rejects(sessions.get(employedLogin.sessionId, later), /UNAUTHENTICATED/);
    await pool.query("UPDATE person SET status='ACTIVE' WHERE id=$1", [personId]);
    await assert.rejects(sessions.get(employedLogin.sessionId, later), /UNAUTHENTICATED/);

    const server = createApiServer({ sessions, weeklyFees: new PostgresWeeklyFeeService(pool), personal: new PostgresPersonalReadService(pool), now: () => later });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const response = await fetch(`${base}/v1/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phoneNormalized: "13800000001", password: "replacement-password" }) });
      assert.equal(response.status, 200);
      const data = (await response.json()).data;
      const me = await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${data.sessionId}` } });
      assert.equal(me.status, 200);
      assert.equal((await me.json()).data.personId, personId);
      const wrong = await fetch(`${base}/v1/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phoneNormalized: "13800000001", password: "bad" }) });
      assert.equal(wrong.status, 401);
      for (let attempt=0; attempt<2; attempt++) {
        const logout = await fetch(`${base}/v1/session/logout`, {method:"POST",headers:{authorization:`Bearer ${data.sessionId}`}});
        assert.equal(logout.status, 200);
      }
      const ended = await fetch(`${base}/v1/me`, {headers:{authorization:`Bearer ${data.sessionId}`}});
      assert.equal(ended.status, 401);
    } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  } finally { await database.close(); }
});
