import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import {
  LocalAttachmentStore,
  PostgresFinanceAttachmentService,
  PostgresFinanceAttachmentUploadService,
  PostgresSalaryBenefitsService,
} from "../../dist/main.js";
import { PostgresBenefitReadService } from "../../dist/postgres-benefit-read-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const month = "2026-09-01";
const planAt = new Date("2026-09-01T00:00:00.000Z");
const dueAt = new Date("2026-09-05T00:00:00.000Z");
const executeAt = new Date("2026-09-06T00:00:00.000Z");
const reverseAt = new Date("2026-09-07T00:00:00.000Z");

const global = (personId, subject = "HEADQUARTERS_FINANCE", extra = {}) => ({
  personId,
  subject,
  scope: "GLOBAL",
  ...extra,
});

const readBalance = async (pool, accountId) =>
  BigInt(
    (
      await pool.query(
        "SELECT balance_cents::text AS balance FROM account_balance_projection WHERE account_id=$1::uuid",
        [accountId],
      )
    ).rows[0].balance,
  );

const ledgerCount = async (pool) =>
  Number(
    (await pool.query("SELECT COUNT(*)::int AS count FROM ledger_event"))
      .rows[0].count,
  );

async function createHarness() {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const attachmentRoot = await mkdtemp(
    join(tmpdir(), "alliance-benefit-read-"),
  );
  const ids = {
    finance: randomUUID(),
    beneficiary: randomUUID(),
    fund: randomUUID(),
    sourceAccount: randomUUID(),
    beneficiaryAccount: randomUUID(),
    financeAccount: randomUUID(),
  };
  try {
    await db.pool.query(
      "INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,'benefit-finance','财务','ACTIVE'),($2::uuid,'benefit-person','办理对象','ACTIVE')",
      [ids.finance, ids.beneficiary],
    );
    await db.pool.query(
      "INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,'COMPANY',$2::uuid,$3,'ACTIVE'),($4::uuid,'PERSON',$5::uuid,$6,'ACTIVE'),($7::uuid,'PERSON',$8::uuid,$9,'ACTIVE')",
      [
        ids.sourceAccount,
        ids.fund,
        `company:fund:${ids.fund}`,
        ids.beneficiaryAccount,
        ids.beneficiary,
        `person:${ids.beneficiary}`,
        ids.financeAccount,
        ids.finance,
        `person:${ids.finance}`,
      ],
    );
    await db.pool.query(
      "INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1::uuid,2000),($2::uuid,500),($3::uuid,300)",
      [ids.sourceAccount, ids.beneficiaryAccount, ids.financeAccount],
    );
    await db.pool.query(
      "INSERT INTO company_finance_fund(id,kind,fund_code,display_name,status,version,created_by_person_id,created_at,updated_at) VALUES($1::uuid,'HEADQUARTERS_FINANCE_OPERATING','BENEFIT_SOURCE','福利职务账户','ACTIVE',1,$2::uuid,$3,$3)",
      [ids.fund, ids.finance, planAt.toISOString()],
    );
    await db.pool.query(
      "INSERT INTO company_finance_fund_assignment(id,fund_id,duty_subject,scope_type,scope_id,responsibility_code,valid_from,valid_to,created_by_person_id,created_at) VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'FINANCE_OPERATING_SOURCE',$3::timestamptz,NULL,$4::uuid,$3::timestamptz)",
      [
        randomUUID(),
        ids.fund,
        new Date(planAt.getTime() - 1_000).toISOString(),
        ids.finance,
      ],
    );
    const store = await LocalAttachmentStore.create(
      attachmentRoot,
      resolve(fileURLToPath(new URL("../../../../", import.meta.url))),
    );
    const salary = new PostgresSalaryBenefitsService(db.pool, store);
    const attachments = new PostgresFinanceAttachmentService(db.pool);
    const uploads = new PostgresFinanceAttachmentUploadService(db.pool, store);
    const reads = new PostgresBenefitReadService(db.pool);
    const bytes = PNG.sync.write({
      width: 2,
      height: 2,
      data: Buffer.alloc(16, 90),
    });
    const originals = async (documentId, prefix, at) => {
      const versionIds = [];
      for (const purpose of ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT"]) {
        const reserved = await attachments.reserve(
          global(ids.finance),
          documentId,
          {
            purpose,
            originalFilename: `${prefix}-${purpose}.png`,
            declaredMediaType: "image/png",
            declaredSizeBytes: bytes.length,
          },
          `${prefix}-${purpose}`,
          at,
        );
        await uploads.upload(
          global(ids.finance),
          reserved.versionId,
          (async function* () {
            yield bytes;
          })(),
          at,
        );
        versionIds.push(reserved.versionId);
      }
      return versionIds;
    };
    return {
      db,
      ids,
      salary,
      reads,
      originals,
      close: async () => {
        await db.close();
        await rm(attachmentRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await db.close();
    await rm(attachmentRoot, { recursive: true, force: true });
    throw error;
  }
}

async function writeBenefitLifecycle(harness, { reverse = true } = {}) {
  const { db, ids, salary, reads, originals } = harness;
  const firstPlan = await salary.setBenefitPlan(
    global(ids.finance),
    {
      benefitKind: "SOCIAL_INSURANCE",
      beneficiaryPersonId: ids.beneficiary,
      benefitMonth: month,
      executionDay: 5,
      amountCents: "700",
      sourceFundId: ids.fund,
      active: true,
      reason: "社保初始计划",
    },
    "benefit-plan-v1",
    planAt,
  );
  const scheduledRoster = await reads.listRoster(
    global(ids.finance),
    month,
    planAt,
  );
  const dueRoster = await reads.listRoster(global(ids.finance), month, dueAt);
  const todos = await salary.generateBenefitTodos(
    global(ids.finance),
    "benefit-generate",
    dueAt,
  );
  assert.equal(todos.length, 1);
  assert.equal(todos[0].planVersionId, firstPlan.planVersionId);
  const pendingGeneratedRoster = await reads.listRoster(
    global(ids.finance),
    month,
    dueAt,
  );
  const currentPlan = await salary.setBenefitPlan(
    global(ids.finance),
    {
      benefitKind: "SOCIAL_INSURANCE",
      beneficiaryPersonId: ids.beneficiary,
      benefitMonth: month,
      executionDay: 6,
      amountCents: "800",
      sourceFundId: ids.fund,
      active: true,
      reason: "待办生成后修订金额与日期",
    },
    "benefit-plan-v2",
    dueAt,
  );
  const pendingRevisedRoster = await reads.listRoster(
    global(ids.finance),
    month,
    dueAt,
  );
  const afterPlanning = {
    ledgerEvents: await ledgerCount(db.pool),
    source: await readBalance(db.pool, ids.sourceAccount),
    beneficiary: await readBalance(db.pool, ids.beneficiaryAccount),
    finance: await readBalance(db.pool, ids.financeAccount),
  };
  const executionDocument = await salary.createEvidenceDocument(
    global(ids.finance),
    "FINANCE_BENEFIT",
    "benefit-execution-document",
    executeAt,
  );
  const executionAttachmentVersionIds = await originals(
    executionDocument.id,
    "benefit-execution",
    executeAt,
  );
  const execution = await salary.confirmBenefit(
    global(ids.finance),
    {
      documentId: executionDocument.id,
      expectedVersion: 1,
      todoId: todos[0].id,
      reason: "确认社保职务账户扣豆",
      attachmentVersionIds: executionAttachmentVersionIds,
    },
    "benefit-confirm",
    executeAt,
  );
  const afterExecution = {
    ledgerEvents: await ledgerCount(db.pool),
    source: await readBalance(db.pool, ids.sourceAccount),
    beneficiary: await readBalance(db.pool, ids.beneficiaryAccount),
    finance: await readBalance(db.pool, ids.financeAccount),
  };
  const completedRoster = await reads.listRoster(
    global(ids.finance),
    month,
    executeAt,
  );
  const completedDetail = await reads.getDetail(
    global(ids.finance),
    executionDocument.id,
  );
  let reversalDocument = null;
  let reversalAttachmentVersionIds = [];
  if (reverse) {
    reversalDocument = await salary.createEvidenceDocument(
      global(ids.finance),
      "FINANCE_BENEFIT",
      "benefit-reversal-document",
      reverseAt,
    );
    reversalAttachmentVersionIds = await originals(
      reversalDocument.id,
      "benefit-reversal",
      reverseAt,
    );
    await salary.reversePosting(
      global(ids.finance),
      {
        originalDocumentId: executionDocument.id,
        reversalDocumentId: reversalDocument.id,
        expectedOriginalVersion: execution.version,
        expectedReversalVersion: reversalDocument.version,
        reason: "社保执行纠错冲回",
        attachmentVersionIds: reversalAttachmentVersionIds,
      },
      "benefit-reverse",
      reverseAt,
    );
  }
  const afterReversal = {
    ledgerEvents: await ledgerCount(db.pool),
    source: await readBalance(db.pool, ids.sourceAccount),
    beneficiary: await readBalance(db.pool, ids.beneficiaryAccount),
    finance: await readBalance(db.pool, ids.financeAccount),
  };
  const reversedRoster = reverse
    ? await reads.listRoster(global(ids.finance), month, reverseAt)
    : null;
  const reversedDetail = reverse
    ? await reads.getDetail(global(ids.finance), executionDocument.id)
    : null;
  return {
    firstPlan,
    currentPlan,
    todo: todos[0],
    executionDocument,
    execution,
    executionAttachmentVersionIds,
    reversalDocument,
    reversalAttachmentVersionIds,
    afterPlanning,
    afterExecution,
    afterReversal,
    scheduledRoster,
    dueRoster,
    pendingGeneratedRoster,
    pendingRevisedRoster,
    completedRoster,
    completedDetail,
    reversedRoster,
    reversedDetail,
  };
}

const item = (roster) => {
  assert.equal(roster.items.length, 1);
  return roster.items[0];
};

const allKeys = (value, result = new Set()) => {
  if (Array.isArray(value)) {
    for (const entry of value) allKeys(entry, result);
    return result;
  }
  if (value === null || typeof value !== "object") return result;
  for (const [key, entry] of Object.entries(value)) {
    result.add(key);
    allKeys(entry, result);
  }
  return result;
};

const countedRoster = async (pool, context, at) => {
  let queryCount = 0;
  const countedPool = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (...args) => {
          queryCount += 1;
          return client.query(...args);
        },
        release: () => client.release(),
      };
    },
  };
  const reads = new PostgresBenefitReadService(countedPool);
  const roster = await reads.listRoster(context, month, at);
  return { roster, queryCount };
};

test("福利读取区分计划历史、待办计划与实际执行计划，并只改职务账户", async () => {
  const harness = await createHarness();
  try {
    const { ids, reads } = harness;
    await assert.rejects(
      reads.listRoster(
        global(ids.finance, "TEACHING_TEACHER", { scope: "SELF" }),
        month,
        planAt,
      ),
      /FORBIDDEN_SCOPE/,
    );
    await assert.rejects(
      reads.listRoster(
        global(ids.finance, "HEADQUARTERS_FINANCE", {
          regionId: randomUUID(),
        }),
        month,
        planAt,
      ),
      /FORBIDDEN_SCOPE/,
    );
    await assert.rejects(
      reads.listRoster(global(ids.finance), "2026-09-02", planAt),
      /INVALID_INPUT/,
    );
    await assert.rejects(
      reads.listRoster(global(ids.finance), month, new Date("invalid")),
      /INVALID_INPUT/,
    );
    await assert.rejects(
      reads.getDetail(global(ids.finance), "not-a-uuid"),
      /INVALID_INPUT/,
    );

    const lifecycle = await writeBenefitLifecycle(harness);
    assert.deepEqual(lifecycle.afterPlanning, {
      ledgerEvents: 0,
      source: 2000n,
      beneficiary: 500n,
      finance: 300n,
    });
    assert.deepEqual(lifecycle.afterExecution, {
      ledgerEvents: 1,
      source: 1200n,
      beneficiary: 500n,
      finance: 300n,
    });
    assert.deepEqual(lifecycle.afterReversal, {
      ledgerEvents: 2,
      source: 2000n,
      beneficiary: 500n,
      finance: 300n,
    });

    assert.equal(item(lifecycle.scheduledRoster).status, "SCHEDULED");
    assert.equal(item(lifecycle.dueRoster).status, "DUE_NOT_GENERATED");
    const generated = item(lifecycle.pendingGeneratedRoster);
    assert.equal(generated.status, "PENDING");
    assert.equal(
      generated.todo.planVersionId,
      lifecycle.firstPlan.planVersionId,
    );
    assert.equal(generated.currentPlan.id, lifecycle.firstPlan.planVersionId);

    const revised = item(lifecycle.pendingRevisedRoster);
    assert.equal(revised.status, "PENDING");
    assert.deepEqual(
      revised.planVersions.map((plan) => plan.version),
      [1, 2],
    );
    assert.equal(revised.todo.planVersionId, lifecycle.firstPlan.planVersionId);
    assert.equal(revised.currentPlan.id, lifecycle.currentPlan.planVersionId);
    assert.equal(revised.currentPlan.amountCents, "800");
    assert.equal(revised.currentPlan.executionDay, 6);

    const completed = item(lifecycle.completedRoster);
    assert.equal(completed.status, "COMPLETED");
    assert.equal(
      completed.execution.planVersionId,
      lifecycle.currentPlan.planVersionId,
    );
    assert.equal(completed.execution.amountCents, "800");
    assert.equal(lifecycle.completedDetail.status, "COMPLETED");
    assert.equal(lifecycle.completedDetail.todoPlan.version, 1);
    assert.equal(lifecycle.completedDetail.todoPlan.amountCents, "700");
    assert.equal(lifecycle.completedDetail.executionPlan.version, 2);
    assert.equal(lifecycle.completedDetail.executionPlan.amountCents, "800");
    assert.deepEqual(
      lifecycle.completedDetail.attachments
        .map((attachment) => attachment.versionId)
        .sort(),
      [...lifecycle.executionAttachmentVersionIds].sort(),
    );
    assert.deepEqual(lifecycle.completedDetail.reversalAttachments, []);

    const reversed = item(lifecycle.reversedRoster);
    assert.equal(reversed.status, "REVERSED");
    assert.equal(reversed.execution.status, "REVERSED");
    assert.equal(
      reversed.execution.reversal.documentId,
      lifecycle.reversalDocument.id,
    );
    assert.equal(lifecycle.reversedDetail.status, "REVERSED");
    assert.equal(
      lifecycle.reversedDetail.reversal.documentId,
      lifecycle.reversalDocument.id,
    );
    assert.deepEqual(
      lifecycle.reversedDetail.reversalAttachments
        .map((attachment) => attachment.versionId)
        .sort(),
      [...lifecycle.reversalAttachmentVersionIds].sort(),
    );

    const adminRoster = await reads.listRoster(
      global(ids.finance, "SYSTEM_ADMIN"),
      month,
      reverseAt,
    );
    const ownerDetail = await reads.getDetail(
      global(ids.finance, "SYSTEM_OWNER"),
      lifecycle.executionDocument.id,
    );
    assert.equal(item(adminRoster).status, "REVERSED");
    assert.equal(ownerDetail.status, "REVERSED");
    const forbiddenKeys = [
      "balanceCents",
      "sourceAccountId",
      "beneficiaryAccountId",
      "financeAccountId",
      "cashPaidCents",
      "deductionCents",
      "wage",
    ];
    const keys = allKeys({ adminRoster, ownerDetail });
    for (const key of forbiddenKeys) assert.equal(keys.has(key), false, key);
  } finally {
    await harness.close();
  }
});

test("福利完成与撤销读取对单据、账本、办理人、计划和证据损坏全部拒绝", async () => {
  const harness = await createHarness();
  try {
    const { db, ids, salary, reads } = harness;
    const lifecycle = await writeBenefitLifecycle(harness);
    const chain = (
      await db.pool.query(
        `SELECT execution.ledger_event_id::text AS original_event_id,
                reversal.reversal_ledger_event_id::text AS reversal_event_id
           FROM finance_benefit_execution execution
           JOIN salary_benefit_reversal reversal
             ON reversal.original_finance_document_id=execution.finance_document_id
          WHERE execution.finance_document_id=$1::uuid`,
        [lifecycle.executionDocument.id],
      )
    ).rows[0];
    assert.ok(chain);
    const housingPlan = await salary.setBenefitPlan(
      global(ids.finance),
      {
        benefitKind: "HOUSING_FUND",
        beneficiaryPersonId: ids.beneficiary,
        benefitMonth: month,
        executionDay: 8,
        amountCents: "900",
        sourceFundId: ids.fund,
        active: true,
        reason: "用于验证计划业务键不可串换",
      },
      "benefit-housing-plan",
      reverseAt,
    );
    const rejectBothAfter = async (corrupt, restore) => {
      await corrupt();
      try {
        await assert.rejects(
          reads.getDetail(global(ids.finance), lifecycle.executionDocument.id),
          /SALARY_BENEFIT_DATA_UNAVAILABLE/,
        );
        await assert.rejects(
          reads.listRoster(global(ids.finance), month, reverseAt),
          /SALARY_BENEFIT_DATA_UNAVAILABLE/,
        );
      } finally {
        await restore();
      }
    };

    await db.pool.query(
      "ALTER TABLE ledger_event DISABLE TRIGGER ledger_event_immutable",
    );
    await db.pool.query(
      "ALTER TABLE ledger_entry DISABLE TRIGGER ledger_entry_immutable",
    );
    await db.pool.query(
      "ALTER TABLE finance_document DISABLE TRIGGER finance_document_withdrawal_mutation_guard",
    );
    await db.pool.query(
      "ALTER TABLE finance_document_event DISABLE TRIGGER finance_document_event_immutable",
    );
    await db.pool.query(
      "ALTER TABLE finance_benefit_execution DISABLE TRIGGER finance_benefit_execution_immutable",
    );
    await db.pool.query(
      "ALTER TABLE salary_benefit_reversal DISABLE TRIGGER salary_benefit_reversal_immutable",
    );
    await db.pool.query(
      "ALTER TABLE salary_benefit_attachment_binding DISABLE TRIGGER salary_benefit_attachment_binding_immutable",
    );
    try {
      await rejectBothAfter(
        () =>
          db.pool.query(
            "UPDATE ledger_event SET event_key=$2 WHERE id=$1::uuid",
            [chain.original_event_id, `finance-benefit:${randomUUID()}`],
          ),
        () =>
          db.pool.query(
            "UPDATE ledger_event SET event_key=$2 WHERE id=$1::uuid",
            [
              chain.original_event_id,
              `finance-benefit:${lifecycle.executionDocument.id}`,
            ],
          ),
      );
      await rejectBothAfter(
        () =>
          db.pool.query(
            "UPDATE ledger_event SET event_key=$2 WHERE id=$1::uuid",
            [
              chain.reversal_event_id,
              `salary-benefit-reversal:${randomUUID()}`,
            ],
          ),
        () =>
          db.pool.query(
            "UPDATE ledger_event SET event_key=$2 WHERE id=$1::uuid",
            [
              chain.reversal_event_id,
              `salary-benefit-reversal:${lifecycle.reversalDocument.id}`,
            ],
          ),
      );
      await rejectBothAfter(
        () =>
          db.pool.query(
            "UPDATE ledger_entry SET amount_cents=-799 WHERE event_id=$1::uuid",
            [chain.original_event_id],
          ),
        () =>
          db.pool.query(
            "UPDATE ledger_entry SET amount_cents=-800 WHERE event_id=$1::uuid",
            [chain.original_event_id],
          ),
      );
      await rejectBothAfter(
        () =>
          db.pool.query(
            "UPDATE settlement_account SET owner_id=$2::uuid WHERE id=$1::uuid",
            [ids.sourceAccount, ids.beneficiary],
          ),
        () =>
          db.pool.query(
            "UPDATE settlement_account SET owner_id=$2::uuid WHERE id=$1::uuid",
            [ids.sourceAccount, ids.fund],
          ),
      );
      await rejectBothAfter(
        () =>
          db.pool.query(
            "UPDATE finance_benefit_execution SET plan_version_id=$2::uuid WHERE finance_document_id=$1::uuid",
            [lifecycle.executionDocument.id, housingPlan.planVersionId],
          ),
        () =>
          db.pool.query(
            "UPDATE finance_benefit_execution SET plan_version_id=$2::uuid WHERE finance_document_id=$1::uuid",
            [
              lifecycle.executionDocument.id,
              lifecycle.currentPlan.planVersionId,
            ],
          ),
      );
      await rejectBothAfter(
        () =>
          db.pool.query(
            "UPDATE finance_document SET kind='PROJECT_BONUS' WHERE id=$1::uuid",
            [lifecycle.executionDocument.id],
          ),
        () =>
          db.pool.query(
            "UPDATE finance_document SET kind='FINANCE_BENEFIT' WHERE id=$1::uuid",
            [lifecycle.executionDocument.id],
          ),
      );
      await rejectBothAfter(
        () =>
          db.pool.query(
            "UPDATE finance_document SET applicant_person_id=$2::uuid WHERE id=$1::uuid",
            [lifecycle.reversalDocument.id, ids.beneficiary],
          ),
        () =>
          db.pool.query(
            "UPDATE finance_document SET applicant_person_id=$2::uuid WHERE id=$1::uuid",
            [lifecycle.reversalDocument.id, ids.finance],
          ),
      );
      await rejectBothAfter(
        () =>
          db.pool.query(
            "UPDATE finance_document_event SET actor_person_id=$2::uuid WHERE finance_document_id=$1::uuid AND event_type='SALARY_BENEFIT_COMPLETED'",
            [lifecycle.executionDocument.id, ids.beneficiary],
          ),
        () =>
          db.pool.query(
            "UPDATE finance_document_event SET actor_person_id=$2::uuid WHERE finance_document_id=$1::uuid AND event_type='SALARY_BENEFIT_COMPLETED'",
            [lifecycle.executionDocument.id, ids.finance],
          ),
      );
      await rejectBothAfter(
        () =>
          db.pool.query(
            "UPDATE finance_document_event SET actor_person_id=$2::uuid WHERE finance_document_id=$1::uuid AND event_type='SALARY_BENEFIT_COMPLETED'",
            [lifecycle.reversalDocument.id, ids.beneficiary],
          ),
        () =>
          db.pool.query(
            "UPDATE finance_document_event SET actor_person_id=$2::uuid WHERE finance_document_id=$1::uuid AND event_type='SALARY_BENEFIT_COMPLETED'",
            [lifecycle.reversalDocument.id, ids.finance],
          ),
      );
      await rejectBothAfter(
        () =>
          db.pool.query(
            "UPDATE finance_document_event SET actor_person_id=$2::uuid WHERE finance_document_id=$1::uuid AND event_type='SALARY_BENEFIT_REVERSED'",
            [lifecycle.executionDocument.id, ids.beneficiary],
          ),
        () =>
          db.pool.query(
            "UPDATE finance_document_event SET actor_person_id=$2::uuid WHERE finance_document_id=$1::uuid AND event_type='SALARY_BENEFIT_REVERSED'",
            [lifecycle.executionDocument.id, ids.finance],
          ),
      );
      await rejectBothAfter(
        () =>
          db.pool.query(
            "UPDATE salary_benefit_reversal SET original_ledger_event_id=$2::uuid WHERE original_finance_document_id=$1::uuid",
            [lifecycle.executionDocument.id, chain.reversal_event_id],
          ),
        () =>
          db.pool.query(
            "UPDATE salary_benefit_reversal SET original_ledger_event_id=$2::uuid WHERE original_finance_document_id=$1::uuid",
            [lifecycle.executionDocument.id, chain.original_event_id],
          ),
      );
      await rejectBothAfter(
        () =>
          db.pool.query(
            "UPDATE finance_document SET status='REVERSED' WHERE id=$1::uuid",
            [lifecycle.reversalDocument.id],
          ),
        () =>
          db.pool.query(
            "UPDATE finance_document SET status='COMPLETED' WHERE id=$1::uuid",
            [lifecycle.reversalDocument.id],
          ),
      );
      await db.pool.query(
        "DELETE FROM salary_benefit_attachment_binding WHERE finance_document_id=$1::uuid AND purpose='APPLICATION_SCREENSHOT'",
        [lifecycle.executionDocument.id],
      );
      await assert.rejects(
        reads.getDetail(global(ids.finance), lifecycle.executionDocument.id),
        /SALARY_BENEFIT_DATA_UNAVAILABLE/,
      );
      await assert.rejects(
        reads.listRoster(global(ids.finance), month, reverseAt),
        /SALARY_BENEFIT_DATA_UNAVAILABLE/,
      );
    } finally {
      await db.pool.query(
        "ALTER TABLE salary_benefit_attachment_binding ENABLE TRIGGER salary_benefit_attachment_binding_immutable",
      );
      await db.pool.query(
        "ALTER TABLE salary_benefit_reversal ENABLE TRIGGER salary_benefit_reversal_immutable",
      );
      await db.pool.query(
        "ALTER TABLE finance_benefit_execution ENABLE TRIGGER finance_benefit_execution_immutable",
      );
      await db.pool.query(
        "ALTER TABLE finance_document_event ENABLE TRIGGER finance_document_event_immutable",
      );
      await db.pool.query(
        "ALTER TABLE finance_document ENABLE TRIGGER finance_document_withdrawal_mutation_guard",
      );
      await db.pool.query(
        "ALTER TABLE ledger_entry ENABLE TRIGGER ledger_entry_immutable",
      );
      await db.pool.query(
        "ALTER TABLE ledger_event ENABLE TRIGGER ledger_event_immutable",
      );
    }
  } finally {
    await harness.close();
  }
});

test("福利名单对多笔完成与撤销记录保持固定三次集合读取", async () => {
  const harness = await createHarness();
  try {
    const { db, ids, salary, originals } = harness;
    await writeBenefitLifecycle(harness);
    const single = await countedRoster(db.pool, global(ids.finance), reverseAt);
    assert.equal(single.roster.items.length, 1);

    const housingPlan = await salary.setBenefitPlan(
      global(ids.finance),
      {
        benefitKind: "HOUSING_FUND",
        beneficiaryPersonId: ids.beneficiary,
        benefitMonth: month,
        executionDay: 7,
        amountCents: "900",
        sourceFundId: ids.fund,
        active: true,
        reason: "公积金计划",
      },
      "benefit-batch-housing-plan",
      reverseAt,
    );
    const todos = await salary.generateBenefitTodos(
      global(ids.finance),
      "benefit-batch-housing-generate",
      reverseAt,
    );
    const housingTodo = todos.find(
      (todo) => todo.planVersionId === housingPlan.planVersionId,
    );
    assert.ok(housingTodo);
    const document = await salary.createEvidenceDocument(
      global(ids.finance),
      "FINANCE_BENEFIT",
      "benefit-batch-housing-document",
      reverseAt,
    );
    const attachmentVersionIds = await originals(
      document.id,
      "benefit-batch-housing",
      reverseAt,
    );
    await salary.confirmBenefit(
      global(ids.finance),
      {
        documentId: document.id,
        expectedVersion: document.version,
        todoId: housingTodo.id,
        reason: "确认公积金职务账户扣豆",
        attachmentVersionIds,
      },
      "benefit-batch-housing-confirm",
      reverseAt,
    );

    const multiple = await countedRoster(
      db.pool,
      global(ids.finance),
      reverseAt,
    );
    assert.equal(multiple.roster.items.length, 2);
    assert.deepEqual(
      multiple.roster.items.map((entry) => entry.status).sort(),
      ["COMPLETED", "REVERSED"],
    );
    assert.equal(single.queryCount, 5);
    assert.equal(multiple.queryCount, single.queryCount);
  } finally {
    await harness.close();
  }
});
