import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createTestDatabase } from "./postgres-test-database.mjs";
import { PostgresAccountAccessService } from "../../dist/main.js";

const connectionString = process.env.DATABASE_URL;
const at = new Date("2026-09-23T00:00:00.000Z");
const ownerContext = (personId) => ({ personId, subject: "SYSTEM_OWNER", scope: "GLOBAL" });
const adminContext = (personId) => ({ personId, subject: "SYSTEM_ADMIN", scope: "GLOBAL" });

const setup = async () => {
  const database = await createTestDatabase(connectionString, { throughMigration: 35 });
  const ids = { owner: randomUUID(), admin: randomUUID(), target: randomUUID(), futureOwner: randomUUID(), futureAdmin: randomUUID(), cancelledAdmin: randomUUID() };
  for (const [key, nickname] of Object.entries(ids)) {
    await database.pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1,$2,$3,'ACTIVE')", [nickname, `profile-${key}-${nickname}`, `legal-${key}-${nickname}`]);
    await database.pool.query("INSERT INTO user_account(person_id,phone_normalized,password_hash,login_status) VALUES($1,$2,'synthetic','ACTIVE')", [nickname, `139${nickname.replaceAll('-', '').slice(0, 8)}`]);
    const settlement = await database.pool.query("INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('PERSON',$1,$2,'ACTIVE') RETURNING id", [nickname, `person:${nickname}`]);
    await database.pool.query("INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1,1234)", [settlement.rows[0].id]);
  }
  await database.pool.query("INSERT INTO role_assignment(person_id,subject_code,scope_type,valid_from,created_by) VALUES($1,'TEACHER','SELF',$2,$1)", [ids.target, "2026-01-01T00:00:00Z"]);
  const targetAccount = await database.pool.query("SELECT id FROM user_account WHERE person_id=$1", [ids.target]);
  await database.pool.query("INSERT INTO user_session(token_hash,account_id,auth_version,current_subject,expires_at,created_at) VALUES(encode(digest('profile-live-session','sha256'),'hex'),$1,1,'TEACHER','2026-12-31T00:00:00Z','2026-09-01T00:00:00Z')", [targetAccount.rows[0].id]);
  for (const [personId, subject] of [[ids.owner, "SYSTEM_OWNER"], [ids.admin, "SYSTEM_ADMIN"]]) {
    await database.pool.query("INSERT INTO role_assignment(person_id,subject_code,scope_type,valid_from,created_by) VALUES($1,$2,'GLOBAL',$3,$1)", [personId, subject, "2026-01-01T00:00:00Z"]);
  }
  await database.pool.query(await readFile(new URL("../../../../database/migrations/0036_person_profile_corrections.sql", import.meta.url), "utf8"));
  return { database, ids };
};

test("0035 到 0036 升级保留既有人员并默认 profile_version=1", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const { database, ids } = await setup();
  try {
    const row = await database.pool.query("SELECT profile_version::text FROM person WHERE id=$1", [ids.target]);
    assert.equal(row.rows[0].profile_version, "1");
  } finally { await database.close(); }
});

test("资料更正的权限、目录、回放、stale、唯一性、不可变和回滚边界", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const { database, ids } = await setup();
  const access = new PostgresAccountAccessService(database.pool);
  try {
    const beforeIdentity = await database.pool.query(`
      SELECT person.id::text AS person_id, user_account.id::text AS account_id, user_account.auth_version::text,
             user_account.login_status, settlement_account.id::text AS settlement_id,
             settlement_account.account_code, settlement_account.status AS settlement_status,
             account_balance_projection.balance_cents::text AS balance,
             (SELECT jsonb_agg(to_jsonb(role_assignment) ORDER BY role_assignment.id) FROM role_assignment WHERE role_assignment.person_id=person.id) AS roles,
             (SELECT jsonb_agg(to_jsonb(user_session) ORDER BY user_session.id) FROM user_session WHERE user_session.account_id=user_account.id AND user_session.expires_at > $2::timestamptz) AS sessions
        FROM person JOIN user_account ON user_account.person_id=person.id
        JOIN settlement_account ON settlement_account.owner_type='PERSON' AND settlement_account.owner_id=person.id
        JOIN account_balance_projection ON account_balance_projection.account_id=settlement_account.id
       WHERE person.id=$1`, [ids.target, at.toISOString()]);
    assert.equal(beforeIdentity.rows.length, 1);
    const first = await access.updatePersonProfile(ownerContext(ids.owner), ids.target, "新昵称", "新实名", "1", "资料纠正", "profile-1", at);
    assert.equal(first.profileVersion, "2");
    const directory = await access.listPeople(ownerContext(ids.owner), at);
    assert.equal(directory.find((item) => item.personId === ids.target)?.legalName, "新实名");
    assert.equal(directory.find((item) => item.personId === ids.target)?.profileVersion, "2");
    const afterIdentity = await database.pool.query(`
      SELECT person.id::text AS person_id, user_account.id::text AS account_id, user_account.auth_version::text,
             user_account.login_status, settlement_account.id::text AS settlement_id,
             settlement_account.account_code, settlement_account.status AS settlement_status,
             account_balance_projection.balance_cents::text AS balance,
             (SELECT jsonb_agg(to_jsonb(role_assignment) ORDER BY role_assignment.id) FROM role_assignment WHERE role_assignment.person_id=person.id) AS roles,
             (SELECT jsonb_agg(to_jsonb(user_session) ORDER BY user_session.id) FROM user_session WHERE user_session.account_id=user_account.id AND user_session.expires_at > $2::timestamptz) AS sessions
        FROM person JOIN user_account ON user_account.person_id=person.id
        JOIN settlement_account ON settlement_account.owner_type='PERSON' AND settlement_account.owner_id=person.id
        JOIN account_balance_projection ON account_balance_projection.account_id=settlement_account.id
       WHERE person.id=$1`, [ids.target, at.toISOString()]);
    assert.deepEqual(afterIdentity.rows[0], beforeIdentity.rows[0]);
    const updateOnly = await database.pool.connect();
    try {
      await updateOnly.query("BEGIN");
      await updateOnly.query("SELECT set_config('app.person_profile_write_context','service-v1',true)");
      await updateOnly.query("UPDATE person SET nickname='只改当前值',legal_name='只改当前实名',profile_version=3 WHERE id=$1", [ids.target]);
      await assert.rejects(updateOnly.query("COMMIT"), /PERSON_PROFILE_TRIPLE_INCOMPLETE/);
    } finally { await updateOnly.query("ROLLBACK").catch(() => {}); updateOnly.release(); }
    const splitWrite = await database.pool.connect();
    const splitAuditId = randomUUID();
    try {
      await splitWrite.query("BEGIN");
      await splitWrite.query("SELECT set_config('app.person_profile_write_context','service-v1',true)");
      await splitWrite.query(
        "INSERT INTO audit_event(id,actor_person_id,action_code,subject_type,subject_id,before_json,after_json,reason,created_at) VALUES($1,$2,'PERSON_PROFILE_CHANGED','PERSON',$3,'{}','{}','拆写',$4)",
        [splitAuditId, ids.owner, ids.target, at.toISOString()],
      );
      await splitWrite.query(
        "INSERT INTO person_profile_change(audit_event_id,person_id,source_profile_version,result_profile_version,before_nickname,before_legal_name,after_nickname,after_legal_name,actor_person_id,actor_subject_code,reason,idempotency_key,changed_at,created_at) VALUES($1,$2,2,3,'新昵称','新实名','拆写昵称','拆写实名',$3,'SYSTEM_OWNER','拆写','split-write',$4,$4)",
        [splitAuditId, ids.target, ids.owner, at.toISOString()],
      );
      await assert.rejects(splitWrite.query("COMMIT"), /PERSON_PROFILE_TRIPLE_INCOMPLETE/);
    } finally { await splitWrite.query("ROLLBACK").catch(() => {}); splitWrite.release(); }
    const replay = await access.updatePersonProfile(ownerContext(ids.owner), ids.target, "新昵称", "新实名", "1", "资料纠正", "profile-1", at);
    assert.equal(replay.replay, true);
    await assert.rejects(access.updatePersonProfile(ownerContext(ids.owner), ids.target, "新昵称", "新实名", "1", "另一原因", "profile-1", at), /IDEMPOTENCY_REPLAY/);
    await assert.rejects(access.updatePersonProfile(ownerContext(ids.owner), ids.target, "新昵称", "新实名", "2", "资料纠正", "profile-1", at), /IDEMPOTENCY_REPLAY/);
    await assert.rejects(access.updatePersonProfile(ownerContext(ids.owner), ids.target, "字段冲突", "新实名", "1", "资料纠正", "profile-1", at), /IDEMPOTENCY_REPLAY/);
    await assert.rejects(access.updatePersonProfile(ownerContext(ids.owner), ids.target, "另一个", "新实名", "1", "资料纠正", "profile-2", at), /PROFILE_VERSION_STALE/);
    await assert.rejects(access.updatePersonProfile(ownerContext(ids.owner), ids.target, "新昵称", "新实名", "2", "无变化", "profile-3", at), /PROFILE_NO_CHANGE/);

    await database.pool.query("INSERT INTO role_assignment(person_id,subject_code,scope_type,valid_from,created_by) VALUES($1,'SYSTEM_OWNER','GLOBAL',$2,$1)", [ids.futureOwner, "2026-10-01T00:00:00Z"]);
    await database.pool.query("INSERT INTO role_assignment(person_id,subject_code,scope_type,valid_from,created_by) VALUES($1,'SYSTEM_ADMIN','GLOBAL',$2,$1)", [ids.futureAdmin, "2026-10-01T00:00:00Z"]);
    await assert.rejects(access.updatePersonProfile(adminContext(ids.admin), ids.futureOwner, "管理员不能改", "管理员不能改", "1", "保护测试", "protected-owner", at), /FORBIDDEN_SCOPE/);
    await assert.rejects(access.updatePersonProfile(adminContext(ids.admin), ids.futureAdmin, "管理员不能改", "管理员不能改", "1", "保护测试", "protected-admin", at), /FORBIDDEN_SCOPE/);
    await database.pool.query("ALTER TABLE role_assignment DROP CONSTRAINT role_assignment_valid_time_order");
    await database.pool.query("INSERT INTO role_assignment(person_id,subject_code,scope_type,valid_from,valid_to,created_by) VALUES($1,'SYSTEM_ADMIN','GLOBAL',$2,$2,$1)", [ids.cancelledAdmin, "2026-10-01T00:00:00Z"]);
    const cancelled = await access.updatePersonProfile(adminContext(ids.admin), ids.cancelledAdmin, "已取消未来任命", "已取消未来任命", "1", "取消任命后可改", "cancelled-future", at);
    assert.equal(cancelled.profileVersion, "2");

    await database.pool.query("UPDATE role_assignment SET valid_to=$2 WHERE person_id=$1 AND subject_code='SYSTEM_ADMIN'", [ids.admin, at.toISOString()]);
    await assert.rejects(access.updatePersonProfile(adminContext(ids.admin), ids.target, "被撤权", "被撤权", "2", "撤权后", "revoked-admin", at), /FORBIDDEN_SCOPE/);

    const history = await database.pool.query("SELECT * FROM person_profile_change WHERE person_id=$1", [ids.target]);
    await assert.rejects(
      database.pool.query("UPDATE person SET nickname='旁路修改' WHERE id=$1", [ids.target]),
      /PERSON_PROFILE_WRITE_FORBIDDEN/,
    );
    await assert.rejects(
      database.pool.query(
        "INSERT INTO person_profile_change(audit_event_id,person_id,source_profile_version,result_profile_version,before_nickname,before_legal_name,after_nickname,after_legal_name,actor_person_id,actor_subject_code,reason,idempotency_key,changed_at,created_at) VALUES($1,$2,2,3,'新昵称','新实名','伪造历史','伪造实名',$3,'SYSTEM_OWNER','伪造','forged-history',$4,$4)",
        [randomUUID(), ids.target, ids.owner, at.toISOString()],
      ),
      /PERSON_PROFILE_WRITE_FORBIDDEN/,
    );
    await assert.rejects(database.pool.query("UPDATE person_profile_change SET reason='tamper' WHERE id=$1", [history.rows[0].id]), /PERSON_PROFILE_CHANGE_IMMUTABLE/);
    await assert.rejects(database.pool.query("DELETE FROM person_profile_change WHERE id=$1", [history.rows[0].id]), /PERSON_PROFILE_CHANGE_IMMUTABLE/);
    const profileAudit = await database.pool.query("SELECT id FROM audit_event WHERE action_code='PERSON_PROFILE_CHANGED' AND subject_id=$1", [ids.target]);
    await assert.rejects(database.pool.query("UPDATE audit_event SET reason='tamper' WHERE id=$1", [profileAudit.rows[0].id]), /PERSON_PROFILE_AUDIT_IMMUTABLE/);
    await assert.rejects(database.pool.query("DELETE FROM audit_event WHERE id=$1", [profileAudit.rows[0].id]), /PERSON_PROFILE_AUDIT_IMMUTABLE/);

    await database.pool.query("CREATE FUNCTION fail_profile_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action_code='PERSON_PROFILE_CHANGED' THEN RAISE EXCEPTION 'FORCED_PROFILE_AUDIT_FAILURE'; END IF; RETURN NEW; END; $$");
    await database.pool.query("CREATE TRIGGER fail_profile_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION fail_profile_audit()");
    await assert.rejects(access.updatePersonProfile(ownerContext(ids.owner), ids.target, "不得落库", "不得落库", "2", "强制回滚", "rollback-profile", at), /FORCED_PROFILE_AUDIT_FAILURE/);
    const unchanged = await database.pool.query("SELECT nickname,legal_name,profile_version::text FROM person WHERE id=$1", [ids.target]);
    assert.deepEqual(unchanged.rows[0], { nickname: "新昵称", legal_name: "新实名", profile_version: "2" });
    assert.equal((await database.pool.query("SELECT count(*)::int AS n FROM person_profile_change WHERE idempotency_key='rollback-profile'")).rows[0].n, 0);
  } finally { await database.close(); }
});

test("资料更正并发版本与昵称唯一性只保留一个完整结果", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const { database, ids } = await setup();
  const access = new PostgresAccountAccessService(database.pool);
  try {
    const results = await Promise.allSettled([
      access.updatePersonProfile(ownerContext(ids.owner), ids.target, "并发一", "并发一", "1", "并发", "concurrent-1", at),
      access.updatePersonProfile(ownerContext(ids.owner), ids.target, "并发二", "并发二", "1", "并发", "concurrent-2", at),
    ]);
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(results.filter((item) => item.status === "rejected" && /PROFILE_VERSION_STALE/.test(item.reason.message)).length, 1);
    const winner = results.find((item) => item.status === "fulfilled").value;
    const target = await database.pool.query("SELECT nickname,legal_name,profile_version::text FROM person WHERE id=$1", [ids.target]);
    assert.equal(target.rows[0].nickname, winner.nickname);
    assert.equal(target.rows[0].profile_version, "2");
    assert.equal((await database.pool.query("SELECT count(*)::int AS n FROM person_profile_change WHERE person_id=$1", [ids.target])).rows[0].n, 1);

    const second = randomUUID();
    await database.pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1,'抢名二','抢名二','ACTIVE')", [second]);
    await database.pool.query("INSERT INTO user_account(person_id,phone_normalized,password_hash,login_status) VALUES($1,$2,'synthetic','ACTIVE')", [second, `138${second.replaceAll('-', '').slice(0, 8)}`]);
    await database.pool.query("INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('PERSON',$1,$2,'ACTIVE')", [second, `person:${second}`]);
    const collision = await Promise.allSettled([
      access.updatePersonProfile(ownerContext(ids.owner), ids.target, "唯一抢名", "实名一", "2", "抢名", "collision-1", at),
      access.updatePersonProfile(ownerContext(ids.owner), second, "唯一抢名", "实名二", "1", "抢名", "collision-2", at),
    ]);
    assert.equal(collision.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(collision.filter((item) => item.status === "rejected" && /PROFILE_NICKNAME_CONFLICT/.test(item.reason.message)).length, 1);
    assert.equal((await database.pool.query("SELECT count(*)::int AS n FROM person_profile_change WHERE idempotency_key IN ('collision-1','collision-2')")).rows[0].n, 1);
  } finally { await database.close(); }
});
