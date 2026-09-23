import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LocalAttachmentStore,
  PostgresSalaryBenefitsService,
} from "../../dist/main.js";
import { PostgresBenefitTodoSchedulerService } from "../../dist/postgres-benefit-todo-scheduler-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const finance = (personId) => ({
  personId,
  subject: "HEADQUARTERS_FINANCE",
  scope: "GLOBAL",
});

const createFixture = async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-benefit-scheduler-"));
  const ids = {
    finance: randomUUID(),
    teacher: randomUUID(),
    teacherTwo: randomUUID(),
    fund: randomUUID(),
    account: randomUUID(),
  };
  try {
    for (const [id, nickname] of [
      [ids.finance, "福利调度财务"],
      [ids.teacher, "福利调度教师甲"],
      [ids.teacherTwo, "福利调度教师乙"],
    ]) {
      await db.pool.query(
        "INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,$2,'ACTIVE')",
        [id, nickname],
      );
    }
    await db.pool.query(
      "INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,'COMPANY',$2::uuid,$3,'ACTIVE')",
      [ids.account, ids.fund, `company:fund:${ids.fund}`],
    );
    await db.pool.query(
      "INSERT INTO company_finance_fund(id,kind,fund_code,display_name,organization_unit_id,status,version,created_by_person_id,created_at,updated_at) VALUES($1::uuid,'HEADQUARTERS_FINANCE_OPERATING',$2,'福利调度合成账户',NULL,'ACTIVE',1,$3::uuid,$4,$4)",
      [ids.fund, `BENEFIT_SCHEDULER_${ids.fund.slice(0, 8).toUpperCase()}`, ids.finance, new Date("2026-01-01T00:00:00.000Z")],
    );
    await db.pool.query(
      "INSERT INTO company_finance_fund_assignment(id,fund_id,duty_subject,scope_type,scope_id,responsibility_code,valid_from,valid_to,created_by_person_id,created_at) VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'FINANCE_OPERATING_SOURCE',$3,NULL,$4::uuid,$3)",
      [randomUUID(), ids.fund, new Date("2026-01-01T00:00:00.000Z"), ids.finance],
    );
    const store = await LocalAttachmentStore.create(
      root,
      resolve(fileURLToPath(new URL("../../../../", import.meta.url))),
    );
    return {
      db,
      ids,
      store,
      service: new PostgresSalaryBenefitsService(db.pool, store),
      scheduler: new PostgresBenefitTodoSchedulerService(db.pool),
      close: async () => {
        await db.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await db.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
};

const setPlan = (fixture, input) =>
  fixture.service.setBenefitPlan(
    finance(fixture.ids.finance),
    {
      benefitKind: input.kind,
      beneficiaryPersonId: input.person ?? fixture.ids.teacher,
      benefitMonth: input.month,
      executionDay: input.executionDay,
      amountCents: "100",
      sourceFundId: fixture.ids.fund,
      active: input.active ?? true,
      reason: input.reason ?? `调度测试计划 ${input.kind}`,
    },
    input.key ?? `plan-${randomUUID()}`,
    input.at ?? new Date("2026-01-01T00:00:00.000Z"),
  );

const todoCount = async (pool, where = []) =>
  (
    await pool.query(
      `SELECT count(*)::int AS n FROM finance_benefit_todo${where.length ? ` WHERE ${where[0]}` : ""}`,
      where.slice(1),
    )
  ).rows[0].n;

test("系统调度只扫描可信北京时间当前月，尊重最新启停版本且不补历史漏项", { timeout: 20_000 }, async () => {
  const fixture = await createFixture();
  const { db, scheduler } = fixture;
  try {
    await setPlan(fixture, {
      kind: "SOCIAL_INSURANCE",
      month: "2026-09-01",
      executionDay: 30,
      key: "scheduler-september",
    });
    await setPlan(fixture, {
      kind: "HOUSING_FUND",
      month: "2026-10-01",
      executionDay: 1,
      key: "scheduler-october",
      person: fixture.ids.teacherTwo,
    });
    const beforeBoundary = await scheduler.run(new Date("2026-09-29T15:59:59.999Z"));
    assert.deepEqual(beforeBoundary, { month: "2026-09-01", day: 29, generatedCount: 0 });
    const currentMonth = await scheduler.run(new Date("2026-09-30T16:00:00.000Z"));
    assert.deepEqual(currentMonth, { month: "2026-10-01", day: 1, generatedCount: 1 });
    assert.equal(await todoCount(db.pool), 1, "十月运行不能补生成九月漏项");

    await setPlan(fixture, {
      kind: "SOCIAL_INSURANCE",
      month: "2026-10-01",
      executionDay: 1,
      active: true,
      key: "scheduler-inactive-v1",
      at: new Date("2026-10-01T00:00:00.000Z"),
      person: fixture.ids.teacherTwo,
    });
    await setPlan(fixture, {
      kind: "SOCIAL_INSURANCE",
      month: "2026-10-01",
      executionDay: 1,
      active: false,
      key: "scheduler-inactive-v2",
      at: new Date("2026-10-02T00:00:00.000Z"),
      person: fixture.ids.teacherTwo,
    });
    assert.deepEqual(
      await scheduler.run(new Date("2026-10-02T00:00:00.000Z")),
      { month: "2026-10-01", day: 2, generatedCount: 0 },
      "最新停用版本应阻止系统生成",
    );
    assert.equal(await todoCount(db.pool), 1);
    assert.equal(
      (await db.pool.query("SELECT count(*)::int AS n FROM salary_benefit_command_idempotency WHERE operation='GENERATE_BENEFIT_TODOS'")).rows[0].n,
      0,
      "系统调度不得写人工幂等记录",
    );
    assert.equal(
      (await db.pool.query("SELECT count(*)::int AS n FROM ledger_event")).rows[0].n,
      0,
      "系统调度不得写账本",
    );
  } finally {
    await fixture.close();
  }
});

test("系统调度并发及系统与人工生成并发最终各业务键只生成一条", { timeout: 20_000 }, async () => {
  const fixture = await createFixture();
  const { db, ids, scheduler, service } = fixture;
  try {
    await setPlan(fixture, {
      kind: "SOCIAL_INSURANCE",
      month: "2026-10-01",
      executionDay: 1,
      key: "scheduler-concurrent-social",
    });
    const at = new Date("2026-10-01T00:00:00.000Z");
    const systemRuns = await Promise.all([scheduler.run(at), scheduler.run(at)]);
    assert.equal(systemRuns[0].generatedCount + systemRuns[1].generatedCount, 1);
    assert.equal(await todoCount(db.pool), 1);

    await setPlan(fixture, {
      kind: "HOUSING_FUND",
      month: "2026-10-01",
      executionDay: 1,
      key: "scheduler-concurrent-housing",
      person: ids.teacherTwo,
    });
    const mixed = await Promise.all([
      scheduler.run(at),
      service.generateBenefitTodos(finance(ids.finance), "manual-concurrent", at),
    ]);
    assert.equal(
      mixed[0].generatedCount + mixed[1].length,
      1,
      "系统和人工入口并发仍只能新增一个住房福利待办",
    );
    assert.equal(await todoCount(db.pool), 2);
    assert.equal(
      (await db.pool.query("SELECT count(*)::int AS n FROM salary_benefit_command_idempotency WHERE operation='GENERATE_BENEFIT_TODOS'")).rows[0].n,
      1,
    );
  } finally {
    await fixture.close();
  }
});

test("当前月第二项生成失败时系统调度整轮回滚，修复最新版后可恢复", { timeout: 20_000 }, async () => {
  const fixture = await createFixture();
  const { db, scheduler } = fixture;
  try {
    await setPlan(fixture, {
      kind: "SOCIAL_INSURANCE",
      month: "2026-10-01",
      executionDay: 1,
      key: "scheduler-rollback-social",
    });
    await setPlan(fixture, {
      kind: "HOUSING_FUND",
      month: "2026-10-01",
      executionDay: 1,
      key: "scheduler-rollback-housing",
      person: fixture.ids.teacherTwo,
    });
    await db.pool.query(`
      CREATE FUNCTION fail_benefit_scheduler_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.benefit_kind = 'SOCIAL_INSURANCE' THEN
          RAISE EXCEPTION 'synthetic second item failure';
        END IF;
        RETURN NEW;
      END $$;
    `);
    await db.pool.query(
      "CREATE TRIGGER fail_benefit_scheduler_insert BEFORE INSERT ON finance_benefit_todo FOR EACH ROW EXECUTE FUNCTION fail_benefit_scheduler_insert()",
    );
    await assert.rejects(
      scheduler.run(new Date("2026-10-01T00:00:00.000Z")),
      /synthetic second item failure/,
    );
    assert.equal(await todoCount(db.pool), 0, "事务失败不得留下第一项待办");
    await db.pool.query("DROP TRIGGER fail_benefit_scheduler_insert ON finance_benefit_todo");
    await db.pool.query("DROP FUNCTION fail_benefit_scheduler_insert()");
    const recovered = await scheduler.run(new Date("2026-10-01T00:00:00.000Z"));
    assert.deepEqual(recovered, { month: "2026-10-01", day: 1, generatedCount: 2 });
    assert.equal(await todoCount(db.pool), 2);
  } finally {
    await fixture.close();
  }
});

test("二月短月非法 execution_day 固定失败并整轮回滚，新增合法最新版后恢复", { timeout: 20_000 }, async () => {
  const fixture = await createFixture();
  const { db, scheduler } = fixture;
  try {
    await db.pool.query(
      "INSERT INTO finance_benefit_plan_version(benefit_kind,beneficiary_person_id,benefit_month,version_no,execution_day,amount_cents,source_fund_id,active,changed_by_person_id,changed_at,reason) VALUES('SOCIAL_INSURANCE',$1::uuid,'2026-02-01'::date,1,31,100,$2::uuid,true,$3::uuid,$4,'测试非法短月计划')",
      [fixture.ids.teacher, fixture.ids.fund, fixture.ids.finance, new Date("2026-01-01T00:00:00.000Z")],
    );
    await assert.rejects(
      scheduler.run(new Date("2026-02-28T00:00:00.000Z")),
      (error) => error instanceof Error && error.message === "BENEFIT_PLAN_EXECUTION_DAY_INVALID_FOR_MONTH",
    );
    assert.equal(await todoCount(db.pool), 0);
    await setPlan(fixture, {
      kind: "SOCIAL_INSURANCE",
      month: "2026-02-01",
      executionDay: 28,
      key: "scheduler-february-valid",
      at: new Date("2026-02-01T00:00:00.000Z"),
    });
    assert.deepEqual(
      await scheduler.run(new Date("2026-02-28T00:00:00.000Z")),
      { month: "2026-02-01", day: 28, generatedCount: 1 },
    );
    assert.equal(await todoCount(db.pool), 1);
  } finally {
    await fixture.close();
  }
});
