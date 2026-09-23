import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresCashWageReadService } from "../../dist/postgres-cash-wage-read-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const month = "2026-09-01";
const at = "2026-09-10T00:00:00.000Z";
const global = (personId, subject = "HEADQUARTERS_FINANCE", extra = {}) => ({
  personId,
  subject,
  scope: "GLOBAL",
  ...extra,
});

async function attach(pool, documentId, ownerId, version, suffix) {
  for (const purpose of ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT"]) {
    const attachmentId = randomUUID(),
      versionId = randomUUID();
    await pool.query(
      "INSERT INTO finance_attachment(id,finance_document_id,purpose,created_by_person_id,created_at) VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5::timestamptz)",
      [attachmentId, documentId, purpose, ownerId, at],
    );
    await pool.query(
      "INSERT INTO finance_attachment_version(id,finance_attachment_id,version_no,status,original_filename,declared_media_type,declared_size_bytes,expected_sha256,detected_media_type,actual_size_bytes,sha256,uploaded_by_person_id,created_at,ready_at) VALUES($1::uuid,$2::uuid,1,'READY',$3,'image/png',12,$4,'image/png',12,$4,$5::uuid,$6::timestamptz,$6::timestamptz)",
      [
        versionId,
        attachmentId,
        `${suffix}-${purpose}.png`,
        "a".repeat(64),
        ownerId,
        at,
      ],
    );
    await pool.query(
      "INSERT INTO salary_benefit_attachment_binding(finance_document_id,finance_attachment_version_id,purpose,document_version,bound_by_person_id,bound_at) VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6::timestamptz)",
      [documentId, versionId, purpose, version, ownerId, at],
    );
  }
}

async function fixture() {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const ids = {
    finance: randomUUID(),
    teacher: randomUUID(),
    account: randomUUID(),
    futurePlan: randomUUID(),
    exactPlan: randomUUID(),
    latestExactPlan: randomUUID(),
    todo: randomUUID(),
    original: randomUUID(),
    correction: randomUUID(),
    reversal: randomUUID(),
    originalEvent: randomUUID(),
    correctionEvent: randomUUID(),
    reversalEvent: randomUUID(),
  };
  await db.pool.query(
    "INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,'wage-finance','财务','ACTIVE'),($2::uuid,'wage-teacher','教师','ACTIVE')",
    [ids.finance, ids.teacher],
  );
  await db.pool.query(
    "INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,'PERSON',$2::uuid,'person:wage-read','ACTIVE')",
    [ids.account, ids.teacher],
  );
  await db.pool.query(
    "INSERT INTO cash_wage_plan_version(id,teacher_person_id,salary_month,version_no,planned_cash_cents,planned_deduction_cents,active,changed_by_person_id,changed_at,reason,applies_to_future_months) VALUES($1::uuid,$2::uuid,'2026-08-01',1,90,90,true,$3::uuid,$4::timestamptz,'未来计划',true),($5::uuid,$2::uuid,'2026-09-01',1,100,100,true,$3::uuid,$4::timestamptz,'精确月初版',false),($6::uuid,$2::uuid,'2026-09-01',2,100,100,true,$3::uuid,$4::timestamptz,'精确月修订版',false)",
    [
      ids.futurePlan,
      ids.teacher,
      ids.finance,
      at,
      ids.exactPlan,
      ids.latestExactPlan,
    ],
  );
  await db.pool.query(
    "INSERT INTO cash_wage_todo(id,teacher_person_id,salary_month,plan_version_id,generated_at) VALUES($1::uuid,$2::uuid,$3::date,$4::uuid,$5::timestamptz)",
    [ids.todo, ids.teacher, month, ids.exactPlan, at],
  );
  for (const [id, status] of [
    [ids.original, "COMPLETED"],
    [ids.correction, "COMPLETED"],
    [ids.reversal, "COMPLETED"],
  ]) {
    await db.pool.query(
      "INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at) VALUES($1::uuid,$2::uuid,'CASH_WAGE',$3,2,$4::timestamptz,$4::timestamptz)",
      [id, ids.finance, status, at],
    );
  }
  for (const [id, key, type] of [
    [ids.originalEvent, `cash-wage:${ids.original}`, "CASH_WAGE_CONFIRMED"],
    [ids.correctionEvent, `cash-wage:${ids.correction}`, "CASH_WAGE_CONFIRMED"],
    [
      ids.reversalEvent,
      `salary-benefit-reversal:${ids.reversal}`,
      "SALARY_BENEFIT_REVERSED",
    ],
  ]) {
    await db.pool.query(
      "INSERT INTO ledger_event(id,event_key,event_type,payload_hash) VALUES($1::uuid,$2,$3,$4)",
      [id, key, type, "b".repeat(64)],
    );
  }
  await db.pool.query(
    "INSERT INTO ledger_entry(event_id,account_id,category_key,amount_cents) VALUES($1::uuid,$2::uuid,'cashWageDeduction',-100),($3::uuid,$2::uuid,'cashWageDeduction',-95),($4::uuid,$2::uuid,'cashWageCorrection',100)",
    [ids.originalEvent, ids.account, ids.correctionEvent, ids.reversalEvent],
  );
  await db.pool.query(
    "INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,ledger_event_id,created_at) VALUES($1::uuid,'SALARY_BENEFIT_COMPLETED',$2::uuid,2,$3::uuid,$4::timestamptz),($5::uuid,'SALARY_BENEFIT_COMPLETED',$2::uuid,2,$6::uuid,$4::timestamptz),($7::uuid,'SALARY_BENEFIT_COMPLETED',$2::uuid,2,$8::uuid,$4::timestamptz),($1::uuid,'SALARY_BENEFIT_REVERSED',$2::uuid,3,$8::uuid,$4::timestamptz)",
    [
      ids.original,
      ids.finance,
      ids.originalEvent,
      at,
      ids.correction,
      ids.correctionEvent,
      ids.reversal,
      ids.reversalEvent,
    ],
  );
  await db.pool.query(
    "INSERT INTO cash_wage_confirmation(finance_document_id,todo_id,teacher_person_id,destination_account_id,salary_month,cash_paid_cents,deduction_cents,paid_at,reason,ledger_event_id,confirmed_by_person_id,created_at,correction_of_finance_document_id,destination_before_cents,destination_after_cents) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::date,100,100,$6::timestamptz,'原工资',$7::uuid,$8::uuid,'2026-09-10T00:00:00.000Z',NULL,1000,900),($9::uuid,$2::uuid,$3::uuid,$4::uuid,$5::date,95,95,$6::timestamptz,'更正工资',$10::uuid,$8::uuid,'2026-09-11T00:00:00.000Z',$1::uuid,1000,905)",
    [
      ids.original,
      ids.todo,
      ids.teacher,
      ids.account,
      month,
      at,
      ids.originalEvent,
      ids.finance,
      ids.correction,
      ids.correctionEvent,
    ],
  );
  await db.pool.query(
    "INSERT INTO salary_benefit_reversal(reversal_finance_document_id,original_finance_document_id,original_ledger_event_id,reversal_ledger_event_id,reversed_by_person_id,reason,created_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'撤销后重记',$6::timestamptz)",
    [
      ids.reversal,
      ids.original,
      ids.originalEvent,
      ids.reversalEvent,
      ids.finance,
      at,
    ],
  );
  await attach(db.pool, ids.original, ids.finance, 2, "original");
  await attach(db.pool, ids.correction, ids.finance, 2, "correction");
  await db.pool.query(
    "UPDATE finance_document SET status='REVERSED',version=3,updated_at=$2::timestamptz WHERE id=$1::uuid",
    [ids.original, at],
  );
  return { db, ids };
}

test("工资只读严格限于全局财务，精确月覆盖未来计划；撤销历史可见但不计入累计", async () => {
  const { db, ids } = await fixture();
  try {
    const reads = new PostgresCashWageReadService(db.pool);
    await assert.rejects(
      reads.listRoster(global(ids.finance, "TEACHING_TEACHER"), month),
      /FORBIDDEN_SCOPE/,
    );
    await assert.rejects(
      reads.listRoster(
        global(ids.finance, "HEADQUARTERS_FINANCE", { regionId: randomUUID() }),
        month,
      ),
      /FORBIDDEN_SCOPE/,
    );
    const roster = await reads.listRoster(global(ids.finance), month);
    assert.equal(roster.items.length, 1);
    assert.equal(roster.items[0].plan.sourceMonth, month);
    assert.equal(roster.items[0].plan.id, ids.latestExactPlan);
    assert.equal(roster.items[0].todo.planVersionId, ids.exactPlan);
    assert.equal(roster.items[0].confirmedCashCents, "95");
    assert.equal(roster.items[0].remainingCashCents, "5");
    assert.equal(roster.items[0].status, "PARTIALLY_CONFIRMED");
    const first = await reads.listConfirmations(global(ids.finance), {
      month,
      limit: 1,
    });
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor);
    const second = await reads.listConfirmations(global(ids.finance), {
      month,
      limit: 1,
      cursor: first.nextCursor,
    });
    assert.equal(second.items.length, 1);
    assert.notEqual(second.items[0].documentId, first.items[0].documentId);
    assert.equal(second.items[0].status, "REVERSED");
    const reversedDetail = await reads.getDetail(
      global(ids.finance),
      ids.original,
    );
    assert.equal(reversedDetail.status, "REVERSED");
    assert.equal(reversedDetail.attachments.length, 2);
    assert.equal(reversedDetail.reversal.documentId, ids.reversal);
  } finally {
    await db.close();
  }
});

test("工资详情只返回绑定附件，并对账本或附件证据异常拒绝返回", async () => {
  const { db, ids } = await fixture();
  try {
    const reads = new PostgresCashWageReadService(db.pool);
    const detail = await reads.getDetail(
      global(ids.finance, "SYSTEM_ADMIN"),
      ids.correction,
    );
    assert.equal(detail.attachments.length, 2);
    assert.deepEqual(detail.attachments.map((item) => item.purpose).sort(), [
      "APPLICATION_SCREENSHOT",
      "SUPPORTING_DOCUMENT",
    ]);
    await db.pool.query(
      "ALTER TABLE ledger_entry DISABLE TRIGGER ledger_entry_immutable",
    );
    await db.pool.query(
      "UPDATE ledger_entry SET amount_cents=-94 WHERE event_id=$1::uuid",
      [ids.correctionEvent],
    );
    await db.pool.query(
      "ALTER TABLE ledger_entry ENABLE TRIGGER ledger_entry_immutable",
    );
    await assert.rejects(
      reads.getDetail(global(ids.finance), ids.correction),
      /SALARY_BENEFIT_DATA_UNAVAILABLE/,
    );
  } finally {
    await db.close();
  }
});

test("工资详情拒绝绑定到另一单据键的同类账本事件", async () => {
  const { db, ids } = await fixture();
  try {
    const reads = new PostgresCashWageReadService(db.pool);
    await db.pool.query(
      "ALTER TABLE ledger_event DISABLE TRIGGER ledger_event_immutable",
    );
    await db.pool.query(
      "UPDATE ledger_event SET event_key=$2 WHERE id=$1::uuid",
      [ids.correctionEvent, `cash-wage:${randomUUID()}`],
    );
    await db.pool.query(
      "ALTER TABLE ledger_event ENABLE TRIGGER ledger_event_immutable",
    );
    await assert.rejects(
      reads.getDetail(global(ids.finance), ids.correction),
      /SALARY_BENEFIT_DATA_UNAVAILABLE/,
    );
  } finally {
    await db.close();
  }
});

test("工资撤销详情拒绝绑定到另一撤销单键的同类反向事件", async () => {
  const { db, ids } = await fixture();
  try {
    const reads = new PostgresCashWageReadService(db.pool);
    await db.pool.query(
      "ALTER TABLE ledger_event DISABLE TRIGGER ledger_event_immutable",
    );
    await db.pool.query(
      "UPDATE ledger_event SET event_key=$2 WHERE id=$1::uuid",
      [ids.reversalEvent, `salary-benefit-reversal:${randomUUID()}`],
    );
    await db.pool.query(
      "ALTER TABLE ledger_event ENABLE TRIGGER ledger_event_immutable",
    );
    await assert.rejects(
      reads.getDetail(global(ids.finance), ids.original),
      /SALARY_BENEFIT_DATA_UNAVAILABLE/,
    );
  } finally {
    await db.close();
  }
});

test("工资撤销详情逐项核验原单、反向单、原账本及两侧单据事件", async () => {
  const { db, ids } = await fixture();
  try {
    const reads = new PostgresCashWageReadService(db.pool);
    const rejectAfter = async (corrupt, restore) => {
      await corrupt();
      try {
        await assert.rejects(
          reads.getDetail(global(ids.finance), ids.original),
          /SALARY_BENEFIT_DATA_UNAVAILABLE/,
        );
      } finally {
        await restore();
      }
    };
    await db.pool.query(
      "ALTER TABLE finance_document DISABLE TRIGGER finance_document_withdrawal_mutation_guard",
    );
    await db.pool.query(
      "ALTER TABLE salary_benefit_reversal DISABLE TRIGGER salary_benefit_reversal_immutable",
    );
    await db.pool.query(
      "ALTER TABLE finance_document_event DISABLE TRIGGER finance_document_event_immutable",
    );
    try {
      await rejectAfter(
        () =>
          db.pool.query(
            "UPDATE finance_document SET kind='PROJECT_BONUS' WHERE id=$1::uuid",
            [ids.original],
          ),
        () =>
          db.pool.query(
            "UPDATE finance_document SET kind='CASH_WAGE' WHERE id=$1::uuid",
            [ids.original],
          ),
      );
      await rejectAfter(
        () =>
          db.pool.query(
            "UPDATE salary_benefit_reversal SET original_ledger_event_id=$2::uuid WHERE original_finance_document_id=$1::uuid",
            [ids.original, ids.correctionEvent],
          ),
        () =>
          db.pool.query(
            "UPDATE salary_benefit_reversal SET original_ledger_event_id=$2::uuid WHERE original_finance_document_id=$1::uuid",
            [ids.original, ids.originalEvent],
          ),
      );
      await rejectAfter(
        () =>
          db.pool.query(
            "UPDATE finance_document SET kind='PROJECT_BONUS' WHERE id=$1::uuid",
            [ids.reversal],
          ),
        () =>
          db.pool.query(
            "UPDATE finance_document SET kind='CASH_WAGE' WHERE id=$1::uuid",
            [ids.reversal],
          ),
      );
      await rejectAfter(
        () =>
          db.pool.query(
            "UPDATE finance_document SET status='REVERSED' WHERE id=$1::uuid",
            [ids.reversal],
          ),
        () =>
          db.pool.query(
            "UPDATE finance_document SET status='COMPLETED' WHERE id=$1::uuid",
            [ids.reversal],
          ),
      );
      await rejectAfter(
        () =>
          db.pool.query(
            "UPDATE finance_document_event SET ledger_event_id=$2::uuid WHERE finance_document_id=$1::uuid AND event_type='SALARY_BENEFIT_COMPLETED'",
            [ids.original, ids.correctionEvent],
          ),
        () =>
          db.pool.query(
            "UPDATE finance_document_event SET ledger_event_id=$2::uuid WHERE finance_document_id=$1::uuid AND event_type='SALARY_BENEFIT_COMPLETED'",
            [ids.original, ids.originalEvent],
          ),
      );
      await rejectAfter(
        () =>
          db.pool.query(
            "UPDATE finance_document_event SET result_document_version=1 WHERE finance_document_id=$1::uuid AND event_type='SALARY_BENEFIT_COMPLETED'",
            [ids.reversal],
          ),
        () =>
          db.pool.query(
            "UPDATE finance_document_event SET result_document_version=2 WHERE finance_document_id=$1::uuid AND event_type='SALARY_BENEFIT_COMPLETED'",
            [ids.reversal],
          ),
      );
      await rejectAfter(
        () =>
          db.pool.query(
            "UPDATE finance_document_event SET ledger_event_id=$2::uuid WHERE finance_document_id=$1::uuid AND event_type='SALARY_BENEFIT_REVERSED'",
            [ids.original, ids.originalEvent],
          ),
        () =>
          db.pool.query(
            "UPDATE finance_document_event SET ledger_event_id=$2::uuid WHERE finance_document_id=$1::uuid AND event_type='SALARY_BENEFIT_REVERSED'",
            [ids.original, ids.reversalEvent],
          ),
      );
    } finally {
      await db.pool.query(
        "ALTER TABLE finance_document_event ENABLE TRIGGER finance_document_event_immutable",
      );
      await db.pool.query(
        "ALTER TABLE salary_benefit_reversal ENABLE TRIGGER salary_benefit_reversal_immutable",
      );
      await db.pool.query(
        "ALTER TABLE finance_document ENABLE TRIGGER finance_document_withdrawal_mutation_guard",
      );
    }
  } finally {
    await db.close();
  }
});

test("工资详情在绑定证据缺失时拒绝返回", async () => {
  const { db, ids } = await fixture();
  try {
    const reads = new PostgresCashWageReadService(db.pool);
    await db.pool.query(
      "ALTER TABLE salary_benefit_attachment_binding DISABLE TRIGGER salary_benefit_attachment_binding_immutable",
    );
    await db.pool.query(
      "DELETE FROM salary_benefit_attachment_binding WHERE finance_document_id=$1::uuid AND purpose='APPLICATION_SCREENSHOT'",
      [ids.correction],
    );
    await db.pool.query(
      "ALTER TABLE salary_benefit_attachment_binding ENABLE TRIGGER salary_benefit_attachment_binding_immutable",
    );
    await assert.rejects(
      reads.getDetail(global(ids.finance), ids.correction),
      /SALARY_BENEFIT_DATA_UNAVAILABLE/,
    );
  } finally {
    await db.close();
  }
});

test("单月修订不取消未来工资继承；未来停用版本让后月显示不可执行", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  try {
    const finance = randomUUID(),
      teacher = randomUUID();
    await db.pool.query(
      "INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,'wage-future-finance','财务','ACTIVE'),($2::uuid,'wage-future-teacher','教师','ACTIVE')",
      [finance, teacher],
    );
    await db.pool.query(
      "INSERT INTO cash_wage_plan_version(teacher_person_id,salary_month,version_no,planned_cash_cents,planned_deduction_cents,active,changed_by_person_id,changed_at,reason,applies_to_future_months) VALUES($1::uuid,$2::date,1,100,100,true,$3::uuid,$4::timestamptz,'八月起连续工资',true),($1::uuid,$2::date,2,120,120,true,$3::uuid,$4::timestamptz,'八月版本仅本月有效',false)",
      [teacher, "2026-08-01", finance, at],
    );
    const roster = await new PostgresCashWageReadService(db.pool).listRoster(
      global(finance),
      month,
    );
    assert.equal(roster.items.length, 1);
    assert.equal(roster.items[0].plan.sourceMonth, "2026-08-01");
    assert.equal(roster.items[0].plan.version, 1);
    assert.equal(roster.items[0].plan.plannedCashCents, "100");
    await db.pool.query(
      "INSERT INTO cash_wage_plan_version(teacher_person_id,salary_month,version_no,planned_cash_cents,planned_deduction_cents,active,changed_by_person_id,changed_at,reason,applies_to_future_months) VALUES($1::uuid,$2::date,3,120,120,false,$3::uuid,$4::timestamptz,'停用八月后的未来工资',true)",
      [teacher, "2026-08-01", finance, at],
    );
    const disabled = await new PostgresCashWageReadService(db.pool).listRoster(
      global(finance),
      month,
    );
    assert.equal(disabled.items.length, 1);
    assert.equal(disabled.items[0].plan.version, 3);
    assert.equal(disabled.items[0].plan.active, false);
    assert.equal(disabled.items[0].status, "INACTIVE");
  } finally {
    await db.close();
  }
});

test("已发累计高于调低后的计划时，roster 返回可观察的超额状态", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  try {
    const finance = randomUUID(),
      teacher = randomUUID(),
      account = randomUUID();
    const oldPlan = randomUUID(),
      todo = randomUUID(),
      document = randomUUID(),
      event = randomUUID();
    await db.pool.query(
      "INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,'wage-over-finance','财务','ACTIVE'),($2::uuid,'wage-over-teacher','教师','ACTIVE')",
      [finance, teacher],
    );
    await db.pool.query(
      "INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,'PERSON',$2::uuid,'person:wage-over','ACTIVE')",
      [account, teacher],
    );
    await db.pool.query(
      "INSERT INTO cash_wage_plan_version(id,teacher_person_id,salary_month,version_no,planned_cash_cents,planned_deduction_cents,active,changed_by_person_id,changed_at,reason,applies_to_future_months) VALUES($1::uuid,$2::uuid,$3::date,1,100,100,true,$4::uuid,$5::timestamptz,'原计划',false),($6::uuid,$2::uuid,$3::date,2,90,90,true,$4::uuid,$5::timestamptz,'调低计划',false)",
      [oldPlan, teacher, month, finance, at, randomUUID()],
    );
    await db.pool.query(
      "INSERT INTO cash_wage_todo(id,teacher_person_id,salary_month,plan_version_id,generated_at) VALUES($1::uuid,$2::uuid,$3::date,$4::uuid,$5::timestamptz)",
      [todo, teacher, month, oldPlan, at],
    );
    await db.pool.query(
      "INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at) VALUES($1::uuid,$2::uuid,'CASH_WAGE','COMPLETED',2,$3::timestamptz,$3::timestamptz),($4::uuid,$5::uuid,'CASH_WAGE','COMPLETED',2,$3::timestamptz,$3::timestamptz)",
      [document, finance, at, randomUUID(), finance],
    );
    await db.pool.query(
      "INSERT INTO ledger_event(id,event_key,event_type,payload_hash) VALUES($1::uuid,$2,'CASH_WAGE_CONFIRMED',$3)",
      [event, `cash-wage:${document}`, "c".repeat(64)],
    );
    await db.pool.query(
      "INSERT INTO cash_wage_confirmation(finance_document_id,todo_id,teacher_person_id,destination_account_id,salary_month,cash_paid_cents,deduction_cents,paid_at,reason,ledger_event_id,confirmed_by_person_id,created_at,destination_before_cents,destination_after_cents) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::date,100,100,$6::timestamptz,'历史全额发放',$7::uuid,$8::uuid,$6::timestamptz,1000,900)",
      [document, todo, teacher, account, month, at, event, finance],
    );
    const item = (
      await new PostgresCashWageReadService(db.pool).listRoster(
        global(finance),
        month,
      )
    ).items[0];
    assert.equal(item.status, "OVER_CONFIRMED");
    assert.equal(item.remainingCashCents, "0");
    assert.equal(item.overageCashCents, "10");
  } finally {
    await db.close();
  }
});
