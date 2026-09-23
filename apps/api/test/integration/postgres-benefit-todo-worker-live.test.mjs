import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createTestDatabase } from "./postgres-test-database.mjs";

const execFileAsync = promisify(execFile);
const workerPath = fileURLToPath(new URL("../../../worker/run-benefit-todos.mjs", import.meta.url));

const waitUntil = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) assert.fail("timed out waiting for worker output");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const beijingParts = (date) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(({ type }) => type !== "literal").map(({ type, value }) => [type, Number(value)]));
};

const monthKey = ({ year, month }) =>
  `${year}-${String(month).padStart(2, "0")}-01`;

const isolatedDatabaseUrl = (database) => {
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("options", `-c search_path=${database.schemaName},public`);
  return url.toString();
};

const runOnce = (database, extraEnv = {}) => execFileAsync(
  process.execPath,
  [workerPath, "--once"],
  {
    env: { ...process.env, DATABASE_URL: isolatedDatabaseUrl(database), ...extraEnv },
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  },
);

const createFixture = async () => {
  const database = await createTestDatabase(process.env.DATABASE_URL);
  const { pool } = database;
  const ids = {
    finance: randomUUID(),
    teacher: randomUUID(),
    fund: randomUUID(),
    account: randomUUID(),
    currentPlan: randomUUID(),
    nextPlan: randomUUID(),
  };
  const now = new Date();
  const current = beijingParts(now);
  const currentMonth = monthKey(current);
  const next = new Date(Date.UTC(current.year, current.month, 1));
  const nextMonth = monthKey({
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
  });
  try {
    await pool.query(
      "INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,'福利 Worker 财务','合成','ACTIVE'),($2::uuid,'福利 Worker 教师','合成','ACTIVE')",
      [ids.finance, ids.teacher],
    );
    await pool.query(
      "INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,'COMPANY',$2::uuid,$3,'ACTIVE')",
      [ids.account, ids.fund, `company:fund:${ids.fund}`],
    );
    await pool.query(
      "INSERT INTO company_finance_fund(id,kind,fund_code,display_name,organization_unit_id,status,version,created_by_person_id,created_at,updated_at) VALUES($1::uuid,'HEADQUARTERS_FINANCE_OPERATING',$2,'福利 Worker 合成账户',NULL,'ACTIVE',1,$3::uuid,$4,$4)",
      [ids.fund, "BENEFIT_WORKER", ids.finance, now],
    );
    await pool.query(
      "INSERT INTO company_finance_fund_assignment(id,fund_id,duty_subject,scope_type,scope_id,responsibility_code,valid_from,valid_to,created_by_person_id,created_at) VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'FINANCE_OPERATING_SOURCE',$3,NULL,$4::uuid,$3)",
      [randomUUID(), ids.fund, now, ids.finance],
    );
    await pool.query(
      "INSERT INTO finance_benefit_plan_version(id,benefit_kind,beneficiary_person_id,benefit_month,version_no,execution_day,amount_cents,source_fund_id,active,changed_by_person_id,changed_at,reason) VALUES($1::uuid,'SOCIAL_INSURANCE',$3::uuid,$4::date,1,1,100,$6::uuid,true,$7::uuid,$8,'Worker 当前月计划'),($2::uuid,'SOCIAL_INSURANCE',$3::uuid,$5::date,1,1,100,$6::uuid,true,$7::uuid,$8,'Worker 下一月边界计划')",
      [ids.currentPlan, ids.nextPlan, ids.teacher, currentMonth, nextMonth, ids.fund, ids.finance, now],
    );
    return {
      database,
      ids,
      months: [currentMonth, nextMonth],
      close: () => database.close(),
    };
  } catch (error) {
    await database.close();
    throw error;
  }
};

test("福利待办 Worker 首次、重复和多进程并发只生成一条", { timeout: 30_000 }, async () => {
  const fixture = await createFixture();
  const { database, ids, months } = fixture;
  try {
    const runs = [
      ...(await Promise.all([runOnce(database), runOnce(database)])),
      await runOnce(database),
    ];
    assert.ok(runs.every(({ stderr }) => stderr === ""));
    const outputs = runs
      .map(({ stdout }) => stdout.trim())
      .filter(Boolean)
      .map(JSON.parse);
    assert.ok(outputs.length >= 1 && outputs.length <= 2);
    assert.equal(new Set(outputs.map(({ month }) => month)).size, outputs.length);
    for (const output of outputs) {
      assert.equal(output.job, "BENEFIT_TODO_GENERATION");
      assert.ok(months.includes(output.month));
      assert.ok(Number.isSafeInteger(output.day) && output.day >= 1 && output.day <= 31);
      assert.equal(output.generatedCount, 1);
    }
    const counts = await database.pool.query(
      "SELECT benefit_month::text AS month,count(*)::int AS n FROM finance_benefit_todo WHERE benefit_kind='SOCIAL_INSURANCE' AND beneficiary_person_id=$1::uuid GROUP BY benefit_month ORDER BY benefit_month",
      [ids.teacher],
    );
    assert.deepEqual(
      counts.rows,
      outputs
        .map(({ month }) => ({ month, n: 1 }))
        .sort((left, right) => left.month.localeCompare(right.month)),
    );
  } finally {
    await fixture.close();
  }
});

test("福利待办 Worker 固定脱敏失败、拒绝非法配置并响应 SIGTERM", { timeout: 30_000 }, async () => {
  const fixture = await createFixture();
  const { database } = fixture;
  let daemon;
  try {
    const { DATABASE_URL: _databaseUrl, ...withoutDatabaseUrl } = process.env;
    await assert.rejects(
      execFileAsync(process.execPath, [workerPath, "--once"], {
        env: withoutDatabaseUrl,
        timeout: 5_000,
      }),
      (error) => error.code === 1 && error.stdout === "" && error.stderr.trim() === "BENEFIT_TODO_GENERATION_FAILED" && !error.stderr.includes("Error"),
    );
    await database.pool.query("CREATE FUNCTION fail_benefit_worker_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SENSITIVE_SYNTHETIC_DATABASE_DETAIL'; END; $$;");
    await database.pool.query("CREATE TRIGGER fail_benefit_worker_fixture BEFORE INSERT ON finance_benefit_todo FOR EACH ROW EXECUTE FUNCTION fail_benefit_worker_fixture();");
    await assert.rejects(
      runOnce(database),
      (error) => error.code === 1 && error.stdout === "" && error.stderr.trim() === "BENEFIT_TODO_GENERATION_FAILED",
    );
    await assert.rejects(
      execFileAsync(process.execPath, [workerPath, "--once"], {
        env: { ...process.env, DATABASE_URL: isolatedDatabaseUrl(database), BENEFIT_TODO_GENERATION_INTERVAL_MS: "0" },
        timeout: 5_000,
      }),
      (error) => error.code === 1 && error.stdout === "" && error.stderr.trim() === "BENEFIT_TODO_GENERATION_CONFIG_INVALID" && !error.stderr.includes("Error"),
    );
    daemon = spawn(process.execPath, [workerPath], {
      env: { ...process.env, DATABASE_URL: isolatedDatabaseUrl(database), BENEFIT_TODO_GENERATION_INTERVAL_MS: "1000" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    daemon.stdout.on("data", (chunk) => { stdout += chunk; });
    daemon.stderr.on("data", (chunk) => { stderr += chunk; });
    await waitUntil(() => stderr.includes("BENEFIT_TODO_GENERATION_FAILED"));
    await database.pool.query("DROP TRIGGER fail_benefit_worker_fixture ON finance_benefit_todo; DROP FUNCTION fail_benefit_worker_fixture();");
    await waitUntil(() => stdout.trim().length > 0);
    daemon.kill("SIGTERM");
    const exit = await new Promise((resolve, reject) => {
      daemon.once("error", reject);
      daemon.once("exit", (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(exit, { code: 0, signal: null });
    const output = JSON.parse(stdout);
    assert.equal(output.job, "BENEFIT_TODO_GENERATION");
    assert.ok(fixture.months.includes(output.month));
    assert.ok(Number.isSafeInteger(output.day) && output.day >= 1 && output.day <= 31);
    assert.equal(output.generatedCount, 1);
    assert.equal(stderr, "BENEFIT_TODO_GENERATION_FAILED\n");
  } finally {
    if (daemon && daemon.exitCode === null) daemon.kill("SIGKILL");
    await fixture.close();
  }
});

test("福利待办 Worker 收到 SIGTERM 时等待在途事务完成后退出", { timeout: 30_000 }, async () => {
  const fixture = await createFixture();
  const { database, ids } = fixture;
  let daemon;
  try {
    await database.pool.query(`
      CREATE FUNCTION slow_benefit_worker_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(2);
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER slow_benefit_worker_fixture
      BEFORE INSERT ON finance_benefit_todo
      FOR EACH ROW EXECUTE FUNCTION slow_benefit_worker_fixture();
    `);
    daemon = spawn(process.execPath, [workerPath], {
      env: {
        ...process.env,
        DATABASE_URL: isolatedDatabaseUrl(database),
        BENEFIT_TODO_GENERATION_INTERVAL_MS: "60000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    daemon.stdout.on("data", (chunk) => { stdout += chunk; });
    daemon.stderr.on("data", (chunk) => { stderr += chunk; });
    await waitUntil(async () => {
      const active = await database.pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE application_name='teaching-research-alliance-api' AND state='active' AND wait_event='PgSleep' AND query LIKE 'INSERT INTO finance_benefit_todo%'",
      );
      return active.rows.length > 0;
    });
    daemon.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(daemon.exitCode, null, "信号不得中断仍在执行的数据库事务");
    const exit = await new Promise((resolve, reject) => {
      daemon.once("error", reject);
      daemon.once("exit", (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(stderr, "");
    const output = JSON.parse(stdout);
    assert.equal(output.job, "BENEFIT_TODO_GENERATION");
    assert.ok(fixture.months.includes(output.month));
    assert.equal(output.generatedCount, 1);
    assert.equal(
      (
        await database.pool.query(
          "SELECT count(*)::int AS n FROM finance_benefit_todo WHERE beneficiary_person_id=$1::uuid",
          [ids.teacher],
        )
      ).rows[0].n,
      1,
      "收到信号前已开始的事务必须完整提交",
    );
  } finally {
    if (daemon && daemon.exitCode === null) daemon.kill("SIGKILL");
    await fixture.close();
  }
});
