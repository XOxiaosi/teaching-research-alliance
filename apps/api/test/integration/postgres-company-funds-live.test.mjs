import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresCompanyFundService } from "../../dist/postgres-company-fund-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const start = new Date("2026-09-21T04:00:00.000Z");

const context = (personId, subject = "SYSTEM_ADMIN", scope = "GLOBAL", extra = {}) => ({
  personId,
  subject,
  scope,
  ...extra
});

const insertPerson = async (pool, id, label) => {
  await pool.query(
    "INSERT INTO person(id,nickname,legal_name,status) VALUES ($1::uuid,$2,'合成管理员','ACTIVE')",
    [id, `company-fund-${label}-${id}`]
  );
};

test("真实 PostgreSQL 公司财务账户只由严格全局管理员配置，初始零余额且不碰个人账户", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const { pool } = db;
  const [adminId, ownerId, financeId, teacherId] = Array.from({ length: 4 }, () => randomUUID());
  try {
    await Promise.all([
      insertPerson(pool, adminId, "admin"), insertPerson(pool, ownerId, "owner"),
      insertPerson(pool, financeId, "finance"), insertPerson(pool, teacherId, "teacher")
    ]);
    const personAccountId = randomUUID();
    await pool.query(
      `INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status,created_at)
       VALUES($1::uuid,'PERSON',$2::uuid,$3,'ACTIVE',$4::timestamptz)`,
      [personAccountId, teacherId, `person:${teacherId}`, start.toISOString()]
    );
    await pool.query("INSERT INTO account_balance_projection(account_id,balance_cents,updated_at) VALUES($1::uuid,700,$2::timestamptz)", [personAccountId, start.toISOString()]);
    const service = new PostgresCompanyFundService(pool);

    await assert.rejects(service.list(context(financeId, "HEADQUARTERS_FINANCE"), start), /FORBIDDEN_SCOPE/);
    await assert.rejects(service.list(context(adminId, "SYSTEM_ADMIN", "SELF"), start), /FORBIDDEN_SCOPE/);
    await assert.rejects(service.list(context(adminId, "SYSTEM_ADMIN", "GLOBAL", { regionId: randomUUID() }), start), /FORBIDDEN_SCOPE/);

    const created = await service.create(context(adminId), {
      fundCode: "HQ_OPERATING_2026", displayName: " 总部财务业务账户 "
    }, "create-primary", start);
    assert.deepEqual(created, {
      id: created.id,
      accountId: created.accountId,
      accountCode: `company:fund:${created.id}`,
      fundCode: "HQ_OPERATING_2026",
      displayName: "总部财务业务账户",
      status: "ACTIVE",
      version: 1,
      replay: false
    });
    assert.deepEqual((await pool.query(
      `SELECT account.owner_type,account.owner_id::text AS owner_id,balance.balance_cents::text AS balance_cents
         FROM settlement_account account
         JOIN account_balance_projection balance ON balance.account_id=account.id
        WHERE account.id=$1::uuid`, [created.accountId]
    )).rows[0], { owner_type: "COMPANY", owner_id: created.id, balance_cents: "0" });
    assert.equal((await pool.query("SELECT balance_cents::text AS balance_cents FROM account_balance_projection WHERE account_id=$1::uuid", [personAccountId])).rows[0].balance_cents, "700");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM ledger_event")).rows[0].n, 0);

    const replay = await service.create(context(adminId.toUpperCase()), {
      fundCode: "HQ_OPERATING_2026", displayName: "总部财务业务账户"
    }, "create-primary", new Date("2026-10-01T00:00:00.000Z"));
    assert.deepEqual(replay, { ...created, replay: true });
    await assert.rejects(service.create(context(adminId), {
      fundCode: "HQ_OPERATING_2026", displayName: "另一个同码账户"
    }, "create-other-key", start), /COMPANY_FUND_CONFLICT/);
    await assert.rejects(service.create(context(adminId), {
      fundCode: "bad-code", displayName: "格式错误"
    }, "invalid-code", start), /INVALID_INPUT/);
    await assert.rejects(service.create(context(adminId), {
      fundCode: "HQ_ORG", displayName: "非总部组织", organizationUnitId: randomUUID()
    }, "invalid-org", start), /COMPANY_FUND_CONFLICT/);

    const headquartersId = randomUUID();
    await pool.query("INSERT INTO organization_unit(id,unit_type,name) VALUES($1::uuid,'HEADQUARTERS','合成总部')", [headquartersId]);
    const owned = await service.create(context(ownerId, "SYSTEM_OWNER"), {
      fundCode: "HQ_OWNER_2026", displayName: "所有者创建账户", organizationUnitId: headquartersId
    }, "owner-create", start);
    assert.equal(owned.status, "ACTIVE");
    const listed = await service.list(context(adminId), start);
    assert.deepEqual(listed.funds.map((fund) => fund.fundCode), ["HQ_OPERATING_2026", "HQ_OWNER_2026"]);
    assert.equal(listed.currentAssignment, null);
    assert.deepEqual(Object.keys(listed.funds[0]).sort(), ["accountCode", "accountId", "displayName", "fundCode", "id", "status", "version"]);
    await pool.query("UPDATE settlement_account SET status='INACTIVE' WHERE id=$1::uuid", [created.accountId]);
    await assert.rejects(service.list(context(adminId), start), /COMPANY_FUND_CONFLICT/);
    await pool.query("UPDATE settlement_account SET status='ACTIVE' WHERE id=$1::uuid", [created.accountId]);
    await pool.query("UPDATE settlement_account SET account_code='company:wrong' WHERE id=$1::uuid", [created.accountId]);
    await assert.rejects(service.list(context(adminId), start), /COMPANY_FUND_CONFLICT/);
  } finally {
    await db.close();
  }
});

test("公司资金职责映射保留历史，命令可重放，停用与账户状态同事务更新", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const { pool } = db;
  const adminId = randomUUID();
  try {
    await insertPerson(pool, adminId, "lifecycle");
    const service = new PostgresCompanyFundService(pool);
    const first = await service.create(context(adminId), { fundCode: "HQ_FIRST", displayName: "第一个账户" }, "first-create", start);
    const second = await service.create(context(adminId), { fundCode: "HQ_SECOND", displayName: "第二个账户" }, "second-create", start);
    const assignDraft = { fundId: first.id, expectedAssignmentId: null, reason: "首次指定业务账户" };
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => service.assign(context(adminId), assignDraft, "assign-first", start)));
    assert.equal(concurrent.filter((result) => !result.replay).length, 1);
    assert.equal(new Set(concurrent.map((result) => result.id)).size, 1);
    const firstAssignment = concurrent[0];
    assert.equal(firstAssignment.fundId, first.id);
    const sameTarget = await service.assign(context(adminId), {
      fundId: first.id, expectedAssignmentId: firstAssignment.id, reason: "确认当前账户"
    }, "assign-same", new Date(start.getTime() + 1_000));
    assert.deepEqual(sameTarget, {
      id: firstAssignment.id, fundId: first.id, validFrom: firstAssignment.validFrom, previousAssignmentId: null, replay: false
    });
    await assert.rejects(service.assign(context(adminId), {
      fundId: second.id, expectedAssignmentId: null, reason: "使用过期映射"
    }, "assign-stale", new Date(start.getTime() + 1_000)), /COMPANY_FUND_ASSIGNMENT_CONFLICT/);
    await assert.rejects(service.assign(context(adminId), {
      fundId: second.id, expectedAssignmentId: firstAssignment.id, reason: "同时间切换"
    }, "assign-zero-length", start), /COMPANY_FUND_ASSIGNMENT_CONFLICT/);

    const changedAt = new Date(start.getTime() + 2_000);
    const secondAssignment = await service.assign(context(adminId), {
      fundId: second.id, expectedAssignmentId: firstAssignment.id, reason: "切换至第二账户"
    }, "assign-second", changedAt);
    assert.equal(secondAssignment.previousAssignmentId, firstAssignment.id);
    assert.equal(secondAssignment.fundId, second.id);
    const closedAt = (await pool.query(
      "SELECT valid_to::text AS valid_to FROM company_finance_fund_assignment WHERE id=$1::uuid", [firstAssignment.id]
    )).rows[0].valid_to;
    assert.equal(new Date(closedAt).toISOString(), changedAt.toISOString());
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM company_finance_fund_assignment")).rows[0].n, 2);
    await assert.rejects(pool.query("DELETE FROM company_finance_fund_assignment WHERE id=$1::uuid", [firstAssignment.id]), /COMPANY_FUND_ASSIGNMENT_IMMUTABLE/);
    await assert.rejects(pool.query(
      `INSERT INTO company_finance_fund_assignment(id,fund_id,duty_subject,scope_type,scope_id,responsibility_code,valid_from,created_by_person_id,created_at)
       VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'FINANCE_OPERATING_SOURCE',$3::timestamptz,$4::uuid,$3::timestamptz)`,
      [randomUUID(), first.id, new Date(changedAt.getTime() - 1).toISOString(), adminId]
    ), /conflicting key value violates exclusion constraint/);

    await assert.rejects(service.setStatus(context(adminId), second.id, {
      expectedVersion: 2, status: "INACTIVE", reason: "错误版本"
    }, "status-stale", changedAt), /VERSION_CONFLICT/);
    const stopped = await service.setStatus(context(adminId), second.id, {
      expectedVersion: second.version, status: "INACTIVE", reason: "停止此业务账户"
    }, "status-inactive", changedAt);
    assert.equal(stopped.status, "INACTIVE");
    assert.equal(stopped.version, second.version + 1);
    assert.equal((await pool.query("SELECT status FROM settlement_account WHERE id=$1::uuid", [second.accountId])).rows[0].status, "INACTIVE");
    await assert.deepEqual(await service.setStatus(context(adminId), second.id, {
      expectedVersion: second.version, status: "INACTIVE", reason: "停止此业务账户"
    }, "status-inactive", new Date(changedAt.getTime() + 1)), { ...stopped, replay: true });
    await assert.rejects(service.assign(context(adminId), {
      fundId: second.id, expectedAssignmentId: secondAssignment.id, reason: "不能重新指定停用账户"
    }, "assign-inactive", new Date(changedAt.getTime() + 2)), /COMPANY_FUND_INACTIVE/);
    await assert.rejects(pool.query("DELETE FROM company_finance_fund WHERE id=$1::uuid", [first.id]), /COMPANY_FUND_IMMUTABLE/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_event WHERE subject_type='COMPANY_FINANCE_FUND'")).rows[0].n, 6);
    assert.deepEqual(await service.create(context(adminId), { fundCode: "HQ_SECOND", displayName: "第二个账户" }, "second-create", new Date(changedAt.getTime() + 3)), { ...second, replay: true });
  } finally {
    await db.close();
  }
});

test("公司资金审计失败时，创建、职责映射和状态变更均完整回滚", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const { pool } = db;
  const adminId = randomUUID();
  try {
    await insertPerson(pool, adminId, "rollback");
    const service = new PostgresCompanyFundService(pool);
    await pool.query("CREATE FUNCTION fail_company_fund_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'FORCED_COMPANY_FUND_AUDIT_FAILURE'; END; $$");
    await pool.query("CREATE TRIGGER fail_company_fund_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION fail_company_fund_audit()");
    await assert.rejects(service.create(context(adminId), { fundCode: "HQ_ROLLBACK", displayName: "回滚账户" }, "rollback-create", start), /FORCED_COMPANY_FUND_AUDIT_FAILURE/);
    await pool.query("DROP TRIGGER fail_company_fund_audit ON audit_event");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM company_finance_fund")).rows[0].n, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM settlement_account")).rows[0].n, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM company_finance_fund_command_idempotency")).rows[0].n, 0);
    const created = await service.create(context(adminId), { fundCode: "HQ_AUDIT", displayName: "审计回滚账户" }, "audit-base", start);
    await pool.query("CREATE TRIGGER fail_company_fund_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION fail_company_fund_audit()");
    await assert.rejects(service.assign(context(adminId), {
      fundId: created.id, expectedAssignmentId: null, reason: "审计失败不得留映射"
    }, "audit-assign", new Date(start.getTime() + 1_000)), /FORCED_COMPANY_FUND_AUDIT_FAILURE/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM company_finance_fund_assignment")).rows[0].n, 0);
    await assert.rejects(service.setStatus(context(adminId), created.id, {
      expectedVersion: 1, status: "INACTIVE", reason: "审计失败不得停用"
    }, "audit-status", new Date(start.getTime() + 2_000)), /FORCED_COMPANY_FUND_AUDIT_FAILURE/);
    await pool.query("DROP TRIGGER fail_company_fund_audit ON audit_event");
    assert.deepEqual((await pool.query(
      `SELECT fund.status AS fund_status,fund.version::text AS version,account.status AS account_status
         FROM company_finance_fund fund JOIN settlement_account account ON account.owner_id=fund.id AND account.owner_type='COMPANY'
        WHERE fund.id=$1::uuid`, [created.id]
    )).rows[0], { fund_status: "ACTIVE", version: "1", account_status: "ACTIVE" });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM company_finance_fund_command_idempotency WHERE idempotency_key IN ('audit-assign','audit-status')")).rows[0].n, 0);
  } finally {
    await db.close();
  }
});
