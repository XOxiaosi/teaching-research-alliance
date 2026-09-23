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
import { createTestDatabase } from "./postgres-test-database.mjs";

const planAt = new Date("2026-09-01T00:00:00.000Z");
const dueAt = new Date("2026-09-05T00:00:00.000Z");
const globalFinance = (personId) => ({
  personId,
  subject: "HEADQUARTERS_FINANCE",
  scope: "GLOBAL",
});
const deferred = () => {
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
};
const settleWithin = async (promise, milliseconds) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolveTimeout) => {
        timer = setTimeout(
          () => resolveTimeout({ state: "timeout" }),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const wrappedPool = (pool, hook) => ({
  connect: async () => {
    const client = await pool.connect();
    return {
      query: (...args) => hook(args, () => client.query(...args)),
      release: () => client.release(),
    };
  },
});
const isBusinessLock = (args, key) =>
  String(args[0]).includes("pg_advisory_xact_lock") && args[1]?.[0] === key;

const createFixture = async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-benefit-generation-"));
  const ids = {
    financeA: randomUUID(),
    financeB: randomUUID(),
    teacherA: randomUUID(),
    teacherB: randomUUID(),
    teacherC: randomUUID(),
    fund: randomUUID(),
    account: randomUUID(),
  };
  try {
    for (const [id, nickname] of [
      [ids.financeA, "福利并发财务甲"],
      [ids.financeB, "福利并发财务乙"],
      [ids.teacherA, "福利并发老师甲"],
      [ids.teacherB, "福利并发老师乙"],
      [ids.teacherC, "福利并发老师丙"],
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
      "INSERT INTO company_finance_fund(id,kind,fund_code,display_name,organization_unit_id,status,version,created_by_person_id,created_at,updated_at) VALUES($1::uuid,'HEADQUARTERS_FINANCE_OPERATING',$2,'福利并发合成账户',NULL,'ACTIVE',1,$3::uuid,$4,$4)",
      [ids.fund, "BENEFIT_CONCURRENCY", ids.financeA, planAt],
    );
    await db.pool.query(
      "INSERT INTO company_finance_fund_assignment(id,fund_id,duty_subject,scope_type,scope_id,responsibility_code,valid_from,valid_to,created_by_person_id,created_at) VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'FINANCE_OPERATING_SOURCE',$3,NULL,$4::uuid,$3)",
      [randomUUID(), ids.fund, new Date(planAt.getTime() - 1_000), ids.financeA],
    );
    const store = await LocalAttachmentStore.create(
      root,
      resolve(fileURLToPath(new URL("../../../../", import.meta.url))),
    );
    return {
      db,
      root,
      ids,
      store,
      service: new PostgresSalaryBenefitsService(db.pool, store),
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

const setPlan = (service, actor, ids, input) =>
  service.setBenefitPlan(
    globalFinance(actor),
    {
      benefitKind: input.kind,
      beneficiaryPersonId: input.person,
      benefitMonth: "2026-09-01",
      executionDay: 5,
      amountCents: input.amount ?? "100",
      sourceFundId: ids.fund,
      active: input.active ?? true,
      reason: input.reason,
    },
    input.key,
    planAt,
  );

test("福利待办并发生成按命令和业务键幂等，不让唯一约束变成请求失败", { timeout: 15_000 }, async () => {
  const fixture = await createFixture();
  const { db, ids, service } = fixture;
  try {
    await setPlan(service, ids.financeA, ids, {
      kind: "SOCIAL_INSURANCE",
      person: ids.teacherA,
      reason: "甲老师社保",
      key: "plan-social-a",
    });
    const sameKey = await Promise.all([
      service.generateBenefitTodos(
        globalFinance(ids.financeA),
        "generate-same",
        dueAt,
      ),
      service.generateBenefitTodos(
        globalFinance(ids.financeA),
        "generate-same",
        dueAt,
      ),
    ]);
    assert.deepEqual(sameKey[0], sameKey[1]);
    assert.equal(sameKey[0].length, 1);
    await assert.rejects(
      service.generateBenefitTodos(
        globalFinance(ids.financeA),
        "generate-same",
        new Date("2026-09-06T00:00:00.000Z"),
      ),
      /IDEMPOTENCY_REPLAY/,
      "同一个命令键不能跨北京时间日期改写请求摘要",
    );

    await setPlan(service, ids.financeA, ids, {
      kind: "HOUSING_FUND",
      person: ids.teacherA,
      reason: "甲老师公积金",
      key: "plan-housing-a",
    });
    const differentKeys = await Promise.all([
      service.generateBenefitTodos(
        globalFinance(ids.financeA),
        "generate-different-a",
        dueAt,
      ),
      service.generateBenefitTodos(
        globalFinance(ids.financeA),
        "generate-different-b",
        dueAt,
      ),
    ]);
    assert.equal(
      differentKeys[0].length + differentKeys[1].length,
      1,
      "不同命令键并发只有一方新增业务待办，另一方正常返回空列表",
    );
    assert.deepEqual(
      await service.generateBenefitTodos(
        globalFinance(ids.financeA),
        "generate-different-a",
        dueAt,
      ),
      differentKeys[0],
    );
    assert.deepEqual(
      await service.generateBenefitTodos(
        globalFinance(ids.financeA),
        "generate-different-b",
        dueAt,
      ),
      differentKeys[1],
    );

    await setPlan(service, ids.financeA, ids, {
      kind: "SOCIAL_INSURANCE",
      person: ids.teacherB,
      reason: "乙老师社保",
      key: "plan-social-b",
    });
    const differentActors = await Promise.all([
      service.generateBenefitTodos(
        globalFinance(ids.financeA),
        "generate-shared-key",
        dueAt,
      ),
      service.generateBenefitTodos(
        globalFinance(ids.financeB),
        "generate-shared-key",
        dueAt,
      ),
    ]);
    assert.equal(differentActors[0].length + differentActors[1].length, 1);

    await Promise.all([
      setPlan(service, ids.financeA, ids, {
        kind: "SOCIAL_INSURANCE",
        person: ids.teacherC,
        reason: "丙老师社保",
        key: "plan-social-c",
      }),
      setPlan(service, ids.financeA, ids, {
        kind: "HOUSING_FUND",
        person: ids.teacherC,
        reason: "丙老师公积金",
        key: "plan-housing-c",
      }),
    ]);
    const multipleKeys = await Promise.all([
      service.generateBenefitTodos(
        globalFinance(ids.financeA),
        "generate-multiple-a",
        dueAt,
      ),
      service.generateBenefitTodos(
        globalFinance(ids.financeB),
        "generate-multiple-b",
        dueAt,
      ),
    ]);
    assert.equal(
      multipleKeys[0].length + multipleKeys[1].length,
      2,
      "多个业务键按稳定顺序加锁且全部只生成一次",
    );
    assert.equal(
      (await db.pool.query("SELECT count(*)::int AS n FROM finance_benefit_todo"))
        .rows[0].n,
      5,
    );
    assert.equal(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM salary_benefit_command_idempotency WHERE operation='GENERATE_BENEFIT_TODOS'",
        )
      ).rows[0].n,
      7,
      "相同actor同key只记录一次，不同命令或actor分别留痕",
    );
  } finally {
    await fixture.close();
  }
});

test("计划保存和待办生成复用业务锁，先获得锁的一方定义冻结计划", { timeout: 15_000 }, async () => {
  const fixture = await createFixture();
  const { db, ids, store, service } = fixture;
  try {
    const socialV1 = await setPlan(service, ids.financeA, ids, {
      kind: "SOCIAL_INSURANCE",
      person: ids.teacherA,
      amount: "100",
      reason: "社保初版",
      key: "social-v1",
    });
    const socialLock = `benefit-plan:SOCIAL_INSURANCE:${ids.teacherA}:2026-09-01`;
    const updateHeld = deferred();
    const releaseUpdate = deferred();
    const updater = new PostgresSalaryBenefitsService(
      wrappedPool(db.pool, async (args, run) => {
        const result = await run();
        if (isBusinessLock(args, socialLock)) {
          updateHeld.resolve();
          await releaseUpdate.promise;
        }
        return result;
      }),
      store,
    );
    const socialUpdate = setPlan(updater, ids.financeA, ids, {
      kind: "SOCIAL_INSURANCE",
      person: ids.teacherA,
      amount: "200",
      reason: "社保新版先提交",
      key: "social-v2",
    });
    await updateHeld.promise;

    const generationAttempted = deferred();
    let generationAcquired = false;
    const waitingGenerator = new PostgresSalaryBenefitsService(
      wrappedPool(db.pool, async (args, run) => {
        if (isBusinessLock(args, socialLock)) generationAttempted.resolve();
        const result = await run();
        if (isBusinessLock(args, socialLock)) generationAcquired = true;
        return result;
      }),
      store,
    );
    const socialGeneration = waitingGenerator.generateBenefitTodos(
      globalFinance(ids.financeB),
      "generate-after-update",
      dueAt,
    );
    await generationAttempted.promise;
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    assert.equal(generationAcquired, false, "计划写事务持锁时生成必须等待");
    releaseUpdate.resolve();
    const [socialV2, generatedSocial] = await Promise.all([
      socialUpdate,
      socialGeneration,
    ]);
    assert.notEqual(socialV1.planVersionId, socialV2.planVersionId);
    assert.equal(generatedSocial[0].planVersionId, socialV2.planVersionId);

    const housingV1 = await setPlan(service, ids.financeA, ids, {
      kind: "HOUSING_FUND",
      person: ids.teacherA,
      amount: "300",
      reason: "公积金初版",
      key: "housing-v1",
    });
    const housingLock = `benefit-plan:HOUSING_FUND:${ids.teacherA}:2026-09-01`;
    const generationHeld = deferred();
    const releaseGeneration = deferred();
    const leadingGenerator = new PostgresSalaryBenefitsService(
      wrappedPool(db.pool, async (args, run) => {
        const result = await run();
        if (isBusinessLock(args, housingLock)) {
          generationHeld.resolve();
          await releaseGeneration.promise;
        }
        return result;
      }),
      store,
    );
    const housingGeneration = leadingGenerator.generateBenefitTodos(
      globalFinance(ids.financeA),
      "generate-before-update",
      dueAt,
    );
    await generationHeld.promise;

    const updateAttempted = deferred();
    let updateAcquired = false;
    const waitingUpdater = new PostgresSalaryBenefitsService(
      wrappedPool(db.pool, async (args, run) => {
        if (isBusinessLock(args, housingLock)) updateAttempted.resolve();
        const result = await run();
        if (isBusinessLock(args, housingLock)) updateAcquired = true;
        return result;
      }),
      store,
    );
    const housingUpdate = setPlan(waitingUpdater, ids.financeA, ids, {
      kind: "HOUSING_FUND",
      person: ids.teacherA,
      amount: "400",
      reason: "公积金新版后提交",
      key: "housing-v2",
    });
    await updateAttempted.promise;
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    assert.equal(updateAcquired, false, "生成事务持锁时计划保存必须等待");
    releaseGeneration.resolve();
    const [generatedHousing, housingV2] = await Promise.all([
      housingGeneration,
      housingUpdate,
    ]);
    assert.equal(generatedHousing[0].planVersionId, housingV1.planVersionId);
    assert.notEqual(housingV1.planVersionId, housingV2.planVersionId);

    const frozen = (
      await db.pool.query(
        "SELECT id::text AS id,plan_version_id::text AS plan_version_id,generated_at::text AS generated_at FROM finance_benefit_todo WHERE benefit_kind='HOUSING_FUND' AND beneficiary_person_id=$1::uuid AND benefit_month='2026-09-01'::date",
        [ids.teacherA],
      )
    ).rows[0];
    assert.deepEqual(
      await service.generateBenefitTodos(
        globalFinance(ids.financeA),
        "generate-existing-housing",
        dueAt,
      ),
      [],
    );
    assert.deepEqual(
      (
        await db.pool.query(
          "SELECT id::text AS id,plan_version_id::text AS plan_version_id,generated_at::text AS generated_at FROM finance_benefit_todo WHERE id=$1::uuid",
          [frozen.id],
        )
      ).rows[0],
      frozen,
      "已有待办不能被当前计划版本覆盖",
    );

    const rowLocker = await db.pool.connect();
    try {
      await rowLocker.query("BEGIN");
      await rowLocker.query(
        "SELECT id FROM finance_benefit_todo WHERE id=$1::uuid FOR UPDATE",
        [frozen.id],
      );
      const whileConfirmed = await settleWithin(
        service
          .generateBenefitTodos(
            globalFinance(ids.financeB),
            "generate-while-todo-row-locked",
            dueAt,
          )
          .then((value) => ({ state: "done", value })),
        1_000,
      );
      assert.deepEqual(whileConfirmed, { state: "done", value: [] });
    } finally {
      await rowLocker.query("ROLLBACK");
      rowLocker.release();
    }
  } finally {
    await fixture.close();
  }
});

test("幂等记录失败会回滚同事务内新建的福利待办", { timeout: 15_000 }, async () => {
  const fixture = await createFixture();
  const { db, ids, service } = fixture;
  try {
    await setPlan(service, ids.financeA, ids, {
      kind: "SOCIAL_INSURANCE",
      person: ids.teacherA,
      reason: "回滚验证计划",
      key: "rollback-plan",
    });
    await assert.rejects(
      service.generateBenefitTodos(
        globalFinance(randomUUID()),
        "record-fails",
        dueAt,
      ),
    );
    assert.equal(
      (await db.pool.query("SELECT count(*)::int AS n FROM finance_benefit_todo"))
        .rows[0].n,
      0,
      "幂等记录外键失败后不能留下半成品待办",
    );
    assert.equal(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM salary_benefit_command_idempotency WHERE operation='GENERATE_BENEFIT_TODOS'",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await service.generateBenefitTodos(
          globalFinance(ids.financeA),
          "record-succeeds",
          dueAt,
        )
      ).length,
      1,
    );
  } finally {
    await fixture.close();
  }
});
