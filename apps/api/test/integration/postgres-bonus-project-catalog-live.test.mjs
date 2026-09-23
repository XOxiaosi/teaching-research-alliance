import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PostgresBonusProjectCatalogService } from "../../dist/postgres-bonus-project-catalog-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const at = new Date("2026-09-23T04:00:00.000Z");
const context = (personId, subject, extra = {}) => ({
  personId,
  subject,
  scope: "GLOBAL",
  ...extra,
});

const addPerson = async (pool, id, nickname) => {
  await pool.query(
    "INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,$2,'ACTIVE')",
    [id, nickname],
  );
};

test("项目1-10目录仅管理员改名，财务只读，版本并发与历史不可变", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  try {
    const admin = randomUUID();
    const owner = randomUUID();
    const finance = randomUUID();
    const teacher = randomUUID();
    await addPerson(db.pool, admin, "bonus-catalog-admin");
    await addPerson(db.pool, owner, "bonus-catalog-owner");
    await addPerson(db.pool, finance, "bonus-catalog-finance");
    await addPerson(db.pool, teacher, "bonus-catalog-teacher");
    const service = new PostgresBonusProjectCatalogService(db.pool);

    const initial = await service.list(
      context(finance, "HEADQUARTERS_FINANCE"),
    );
    assert.deepEqual(
      initial.projects.map((project) => [
        project.projectNo,
        project.nameVersion,
        project.displayName,
      ]),
      Array.from({ length: 10 }, (_, index) => [
        index + 1,
        1,
        `项目${index + 1}`,
      ]),
    );
    await assert.rejects(
      service.list(context(teacher, "TEACHING_TEACHER", { scope: "SELF" })),
      /FORBIDDEN_SCOPE/,
    );
    await assert.rejects(
      service.list(context(admin, "SYSTEM_ADMIN", { regionId: randomUUID() })),
      /FORBIDDEN_SCOPE/,
    );
    await assert.rejects(
      service.rename(
        context(finance, "HEADQUARTERS_FINANCE"),
        1,
        {
          expectedVersion: 1,
          displayName: "财务不得改名",
          reason: "权限测试",
        },
        "finance-forbidden",
        at,
      ),
      /FORBIDDEN_SCOPE/,
    );

    const renamed = await service.rename(
      context(admin, "SYSTEM_ADMIN"),
      1,
      {
        expectedVersion: 1,
        displayName: "课程研发项目",
        reason: "统一公司项目名称",
      },
      "rename-one",
      at,
    );
    assert.equal(renamed.nameVersion, 2);
    assert.equal(renamed.displayName, "课程研发项目");
    assert.equal(renamed.replay, false);
    const replay = await service.rename(
      context(admin, "SYSTEM_ADMIN"),
      1,
      {
        expectedVersion: 1,
        displayName: "课程研发项目",
        reason: "统一公司项目名称",
      },
      "rename-one",
      new Date(at.getTime() + 1_000),
    );
    assert.equal(replay.nameVersionId, renamed.nameVersionId);
    assert.equal(replay.replay, true);
    await assert.rejects(
      service.rename(
        context(admin, "SYSTEM_ADMIN"),
        1,
        {
          expectedVersion: 1,
          displayName: "复用键伪造名称",
          reason: "不得成功",
        },
        "rename-one",
        at,
      ),
      /IDEMPOTENCY_REPLAY/,
    );
    await assert.rejects(
      service.rename(
        context(admin, "SYSTEM_ADMIN"),
        1,
        {
          expectedVersion: 1,
          displayName: "过期版本",
          reason: "不得成功",
        },
        "stale-version",
        at,
      ),
      /BONUS_PROJECT_VERSION_CONFLICT/,
    );

    const concurrent = await Promise.allSettled([
      service.rename(
        context(admin, "SYSTEM_ADMIN"),
        1,
        {
          expectedVersion: 2,
          displayName: "并发名称A",
          reason: "并发测试A",
        },
        "concurrent-a",
        new Date(at.getTime() + 2_000),
      ),
      service.rename(
        context(owner, "SYSTEM_OWNER"),
        1,
        {
          expectedVersion: 2,
          displayName: "并发名称B",
          reason: "并发测试B",
        },
        "concurrent-b",
        new Date(at.getTime() + 2_000),
      ),
    ]);
    assert.equal(
      concurrent.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      concurrent.filter((result) => result.status === "rejected").length,
      1,
    );
    assert.match(
      String(concurrent.find((result) => result.status === "rejected").reason),
      /BONUS_PROJECT_VERSION_CONFLICT/,
    );

    const current = (await service.list(context(owner, "SYSTEM_OWNER")))
      .projects[0];
    assert.equal(current.nameVersion, 3);
    assert.equal(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM bonus_project_name_version WHERE project_no=1",
        )
      ).rows[0].n,
      3,
    );
    await assert.rejects(
      db.pool.query(
        "UPDATE bonus_project_name_version SET display_name='篡改' WHERE id=$1::uuid",
        [renamed.nameVersionId],
      ),
      /BONUS_PROJECT_CATALOG_IMMUTABLE/,
    );
    assert.equal(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM audit_event WHERE action_code='BONUS_PROJECT_NAME_SET'",
        )
      ).rows[0].n,
      2,
    );
  } finally {
    await db.close();
  }
});

test("新奖金记录冻结当前名称版本并由数据库拒绝旧名称或错配来源账户", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  try {
    const admin = randomUUID();
    const recipient = randomUUID();
    const fund = randomUUID();
    const otherFund = randomUUID();
    const source = randomUUID();
    const wrongSource = randomUUID();
    const destination = randomUUID();
    await addPerson(db.pool, admin, "bonus-transfer-admin");
    await addPerson(db.pool, recipient, "bonus-transfer-recipient");
    for (const [id, code] of [
      [fund, "BONUS_SOURCE"],
      [otherFund, "BONUS_WRONG"],
    ]) {
      await db.pool.query(
        "INSERT INTO company_finance_fund(id,kind,fund_code,display_name,status,version,created_by_person_id,created_at,updated_at) VALUES($1::uuid,'HEADQUARTERS_FINANCE_OPERATING',$2,$2,'ACTIVE',1,$3::uuid,$4,$4)",
        [id, code, admin, at.toISOString()],
      );
    }
    await db.pool.query(
      "INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,'COMPANY',$2::uuid,$3,'ACTIVE'),($4::uuid,'COMPANY',$5::uuid,$6,'ACTIVE'),($7::uuid,'PERSON',$8::uuid,$9,'ACTIVE')",
      [
        source,
        fund,
        `company:bonus:${fund}`,
        wrongSource,
        otherFund,
        `company:bonus:${otherFund}`,
        destination,
        recipient,
        `person:${recipient}`,
      ],
    );
    const service = new PostgresBonusProjectCatalogService(db.pool);
    const legacy = (await service.list(context(admin, "SYSTEM_ADMIN")))
      .projects[0];
    const current = await service.rename(
      context(admin, "SYSTEM_ADMIN"),
      1,
      {
        expectedVersion: 1,
        displayName: "冻结名称项目",
        reason: "奖金发放前统一名称",
      },
      "rename-before-transfer",
      at,
    );

    const seedPosting = async (
      sourceAccount,
      eventType = "PROJECT_BONUS_GRANTED",
      eventKeyPrefix = "project-bonus",
    ) => {
      const document = randomUUID();
      const event = randomUUID();
      await db.pool.query(
        "INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at) VALUES($1::uuid,$2::uuid,'PROJECT_BONUS','COMPLETED',2,$3,$3)",
        [document, admin, at.toISOString()],
      );
      await db.pool.query(
        "INSERT INTO ledger_event(id,event_key,event_type,payload_hash,created_at) VALUES($1::uuid,$2,$3,$4,$5)",
        [
          event,
          `${eventKeyPrefix}:${document}`,
          eventType,
          "d".repeat(64),
          at.toISOString(),
        ],
      );
      await db.pool.query(
        "INSERT INTO ledger_entry(event_id,account_id,category_key,amount_cents,created_at) VALUES($1::uuid,$2::uuid,'projectBonusExpense',-100,$4),($1::uuid,$3::uuid,'projectBonusIncome',100,$4)",
        [event, sourceAccount, destination, at.toISOString()],
      );
      return { document, event };
    };

    const valid = await seedPosting(source);
    await db.pool.query(
      "INSERT INTO project_bonus_transfer(finance_document_id,project_no,project_name,project_name_version_id,recipient_person_id,destination_account_id,source_fund_id,source_account_id,amount_cents,reason,ledger_event_id,granted_by_person_id,created_at) VALUES($1::uuid,1,$2,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,100,'合法冻结',$8::uuid,$9::uuid,$10)",
      [
        valid.document,
        current.displayName,
        current.nameVersionId,
        recipient,
        destination,
        fund,
        source,
        valid.event,
        admin,
        at.toISOString(),
      ],
    );
    assert.deepEqual(
      (
        await db.pool.query(
          "SELECT project_name,project_name_version_id::text AS version_id FROM project_bonus_transfer WHERE finance_document_id=$1::uuid",
          [valid.document],
        )
      ).rows[0],
      { project_name: current.displayName, version_id: current.nameVersionId },
    );

    const stale = await seedPosting(source);
    await assert.rejects(
      db.pool.query(
        "INSERT INTO project_bonus_transfer(finance_document_id,project_no,project_name,project_name_version_id,recipient_person_id,destination_account_id,source_fund_id,source_account_id,amount_cents,reason,ledger_event_id,granted_by_person_id,created_at) VALUES($1::uuid,1,$2,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,100,'旧版本伪造',$8::uuid,$9::uuid,$10)",
        [
          stale.document,
          legacy.displayName,
          legacy.nameVersionId,
          recipient,
          destination,
          fund,
          source,
          stale.event,
          admin,
          at.toISOString(),
        ],
      ),
      /BONUS_PROJECT_VERSION_CONFLICT/,
    );
    const mismatch = await seedPosting(wrongSource);
    await assert.rejects(
      db.pool.query(
        "INSERT INTO project_bonus_transfer(finance_document_id,project_no,project_name,project_name_version_id,recipient_person_id,destination_account_id,source_fund_id,source_account_id,amount_cents,reason,ledger_event_id,granted_by_person_id,created_at) VALUES($1::uuid,1,$2,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,100,'来源错配',$8::uuid,$9::uuid,$10)",
        [
          mismatch.document,
          current.displayName,
          current.nameVersionId,
          recipient,
          destination,
          fund,
          wrongSource,
          mismatch.event,
          admin,
          at.toISOString(),
        ],
      ),
      /PROJECT_BONUS_TRANSFER_INVALID/,
    );

    for (const [eventType, eventKeyPrefix] of [
      ["SYNTHETIC_WRONG_EVENT", "project-bonus"],
      ["PROJECT_BONUS_GRANTED", "wrong-project-bonus"],
    ]) {
      const invalidLedger = await seedPosting(
        source,
        eventType,
        eventKeyPrefix,
      );
      await assert.rejects(
        db.pool.query(
          "INSERT INTO project_bonus_transfer(finance_document_id,project_no,project_name,project_name_version_id,recipient_person_id,destination_account_id,source_fund_id,source_account_id,amount_cents,reason,ledger_event_id,granted_by_person_id,created_at) VALUES($1::uuid,1,$2,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,100,'事件身份错配',$8::uuid,$9::uuid,$10)",
          [
            invalidLedger.document,
            current.displayName,
            current.nameVersionId,
            recipient,
            destination,
            fund,
            source,
            invalidLedger.event,
            admin,
            at.toISOString(),
          ],
        ),
        /PROJECT_BONUS_LEDGER_INVALID/,
      );
    }
  } finally {
    await db.close();
  }
});

test("0025 前向升级保留历史自由名称，仅约束升级后的新奖金", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL, {
    throughMigration: 24,
  });
  try {
    const migration = await readFile(
      new URL(
        "../../../../database/migrations/0025_bonus_project_catalog.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const admin = randomUUID();
    const recipient = randomUUID();
    const fund = randomUUID();
    const source = randomUUID();
    const destination = randomUUID();
    const document = randomUUID();
    const event = randomUUID();
    await addPerson(db.pool, admin, "bonus-upgrade-admin");
    await addPerson(db.pool, recipient, "bonus-upgrade-recipient");
    await db.pool.query(
      "INSERT INTO company_finance_fund(id,kind,fund_code,display_name,status,version,created_by_person_id,created_at,updated_at) VALUES($1::uuid,'HEADQUARTERS_FINANCE_OPERATING','BONUS_UPGRADE','升级基金','ACTIVE',1,$2::uuid,$3,$3)",
      [fund, admin, at.toISOString()],
    );
    await db.pool.query(
      "INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,'COMPANY',$2::uuid,$3,'ACTIVE'),($4::uuid,'PERSON',$5::uuid,$6,'ACTIVE')",
      [
        source,
        fund,
        `company:upgrade:${fund}`,
        destination,
        recipient,
        `person:upgrade:${recipient}`,
      ],
    );
    await db.pool.query(
      "INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at) VALUES($1::uuid,$2::uuid,'PROJECT_BONUS','COMPLETED',2,$3,$3)",
      [document, admin, at.toISOString()],
    );
    await db.pool.query(
      "INSERT INTO ledger_event(id,event_key,event_type,payload_hash) VALUES($1::uuid,$2,'PROJECT_BONUS_GRANTED',$3)",
      [event, `legacy-project-bonus:${document}`, "e".repeat(64)],
    );
    await db.pool.query(
      "INSERT INTO project_bonus_transfer(finance_document_id,project_no,project_name,recipient_person_id,destination_account_id,source_fund_id,source_account_id,amount_cents,reason,ledger_event_id,granted_by_person_id,created_at) VALUES($1::uuid,1,'历史手填名称',$2::uuid,$3::uuid,$4::uuid,$5::uuid,100,'升级前历史',$6::uuid,$7::uuid,$8)",
      [
        document,
        recipient,
        destination,
        fund,
        source,
        event,
        admin,
        at.toISOString(),
      ],
    );
    await db.pool.query(migration);
    assert.deepEqual(
      (
        await db.pool.query(
          "SELECT project_name,project_name_version_id::text AS version_id FROM project_bonus_transfer WHERE finance_document_id=$1::uuid",
          [document],
        )
      ).rows[0],
      { project_name: "历史手填名称", version_id: null },
    );
    assert.equal(
      (await db.pool.query("SELECT count(*)::int AS n FROM bonus_project_slot"))
        .rows[0].n,
      10,
    );
  } finally {
    await db.close();
  }
});
