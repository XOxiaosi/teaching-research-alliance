import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PostgresBenefitSourceFundDirectoryService } from "../../dist/postgres-benefit-source-fund-directory-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const at = new Date("2026-09-21T04:00:00.000Z");
const global = (personId, subject = "HEADQUARTERS_FINANCE", extra = {}) => ({ personId, subject, scope: "GLOBAL", ...extra });

const addPerson = async (pool, id, label) => {
  await pool.query(
    "INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,$3,'ACTIVE')",
    [id, `benefit-source-${label}`, `合成${label}`],
  );
};

const addFund = async (pool, { id, code, displayName, createdBy, status = "ACTIVE" }) => {
  await pool.query(
    `INSERT INTO company_finance_fund(id,kind,fund_code,display_name,status,version,created_by_person_id,created_at,updated_at)
     VALUES($1::uuid,'HEADQUARTERS_FINANCE_OPERATING',$2,$3,$4,1,$5::uuid,$6::timestamptz,$6::timestamptz)`,
    [id, code, displayName, status, createdBy, at.toISOString()],
  );
};

const addAssignment = async (pool, { id, fundId, from, to = null, createdBy }) => {
  await pool.query(
    `INSERT INTO company_finance_fund_assignment(
       id,fund_id,duty_subject,scope_type,scope_id,responsibility_code,valid_from,valid_to,created_by_person_id,created_at
     ) VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'FINANCE_OPERATING_SOURCE',$3::timestamptz,$4::timestamptz,$5::uuid,$3::timestamptz)`,
    [id, fundId, from, to, createdBy],
  );
};

const addCompanyAccount = async (pool, { id, fundId, status = "ACTIVE" }) => {
  await pool.query(
    `INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status,created_at)
     VALUES($1::uuid,'COMPANY',$2::uuid,$3,$4,'2026-01-01T00:00:00Z'::timestamptz)`,
    [id, fundId, `company:fund:${fundId}`, status],
  );
};

test("福利扣费业务账户目录只返回当前有效 ACTIVE 总部业务账户的三字段", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  try {
    const ids = {
      owner: randomUUID(), admin: randomUUID(), finance: randomUUID(),
      oldFund: randomUUID(), currentFund: randomUUID(), futureFund: randomUUID(), inactiveFund: randomUUID(),
      missingAccountFund: randomUUID(),
      oldAssignment: randomUUID(), currentAssignment: randomUUID(), futureAssignment: randomUUID(), inactiveAssignment: randomUUID(),
      missingAccountAssignment: randomUUID(),
      oldAccount: randomUUID(), currentAccount: randomUUID(), futureAccount: randomUUID(), inactiveAccount: randomUUID(),
    };
    await Promise.all([
      addPerson(db.pool, ids.owner, "owner"), addPerson(db.pool, ids.admin, "admin"), addPerson(db.pool, ids.finance, "finance"),
    ]);
    await addFund(db.pool, { id: ids.oldFund, code: "OLD_OPERATING", displayName: "历史业务账户", createdBy: ids.admin });
    await addFund(db.pool, { id: ids.currentFund, code: "CURRENT_OPERATING", displayName: "当前业务账户", createdBy: ids.admin });
    await addFund(db.pool, { id: ids.futureFund, code: "FUTURE_OPERATING", displayName: "未来业务账户", createdBy: ids.admin });
    await addFund(db.pool, { id: ids.inactiveFund, code: "INACTIVE_OPERATING", displayName: "停用业务账户", createdBy: ids.admin, status: "INACTIVE" });
    await addFund(db.pool, { id: ids.missingAccountFund, code: "MISSING_ACCOUNT", displayName: "缺失结算账户", createdBy: ids.admin });
    await addCompanyAccount(db.pool, { id: ids.oldAccount, fundId: ids.oldFund });
    await addCompanyAccount(db.pool, { id: ids.currentAccount, fundId: ids.currentFund });
    await addCompanyAccount(db.pool, { id: ids.futureAccount, fundId: ids.futureFund });
    await addCompanyAccount(db.pool, { id: ids.inactiveAccount, fundId: ids.inactiveFund, status: "INACTIVE" });
    await addAssignment(db.pool, { id: ids.oldAssignment, fundId: ids.oldFund, from: "2026-01-01T00:00:00Z", to: "2026-09-01T00:00:00Z", createdBy: ids.admin });
    await addAssignment(db.pool, { id: ids.currentAssignment, fundId: ids.currentFund, from: "2026-09-01T00:00:00Z", to: "2026-10-01T00:00:00Z", createdBy: ids.admin });
    await addAssignment(db.pool, { id: ids.futureAssignment, fundId: ids.futureFund, from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z", createdBy: ids.admin });
    await addAssignment(db.pool, { id: ids.inactiveAssignment, fundId: ids.inactiveFund, from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z", createdBy: ids.admin });
    await addAssignment(db.pool, { id: ids.missingAccountAssignment, fundId: ids.missingAccountFund, from: "2026-12-01T00:00:00Z", to: "2027-01-01T00:00:00Z", createdBy: ids.admin });

    const service = new PostgresBenefitSourceFundDirectoryService(db.pool);
    const expected = [{ fundId: ids.currentFund, code: "CURRENT_OPERATING", displayName: "当前业务账户" }];
    for (const [personId, subject] of [[ids.owner, "SYSTEM_OWNER"], [ids.admin, "SYSTEM_ADMIN"], [ids.finance, "HEADQUARTERS_FINANCE"]]) {
      const result = await service.list(global(personId, subject), at);
      assert.deepEqual(result.items, expected);
      assert.deepEqual(Object.keys(result.items[0]).sort(), ["code", "displayName", "fundId"]);
      assert.equal(JSON.stringify(result).includes("balance"), false);
      assert.equal(JSON.stringify(result).includes("account"), false);
    }

    const future = await service.list(global(ids.finance), new Date("2026-10-15T04:00:00.000Z"));
    assert.deepEqual(future.items, [{ fundId: ids.futureFund, code: "FUTURE_OPERATING", displayName: "未来业务账户" }]);
    const inactive = await service.list(global(ids.finance), new Date("2026-11-15T04:00:00.000Z"));
    assert.deepEqual(inactive.items, []);
    const missingAccount = await service.list(global(ids.finance), new Date("2026-12-15T04:00:00.000Z"));
    assert.deepEqual(missingAccount.items, []);
  } finally {
    await db.close();
  }
});

test("福利扣费业务账户目录拒绝非管理角色、窄范围及无效输入", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  try {
    const personId = randomUUID();
    await addPerson(db.pool, personId, "operator");
    const service = new PostgresBenefitSourceFundDirectoryService(db.pool);
    const forbidden = [
      { personId, subject: "TEACHING_TEACHER", scope: "SELF" },
      { personId, subject: "ACADEMIC_PLANNER", scope: "SELF" },
      global(personId, "REGION_FINANCE", { scope: "REGION", regionId: randomUUID() }),
      global(personId, "HEADQUARTERS_FINANCE", { regionId: randomUUID() }),
      global(personId, "SYSTEM_ADMIN", { campusId: randomUUID() }),
      global(personId, "SYSTEM_OWNER", { venueId: randomUUID() }),
      { personId: "not-a-uuid", subject: "SYSTEM_ADMIN", scope: "GLOBAL" },
    ];
    for (const context of forbidden) await assert.rejects(service.list(context, at), /FORBIDDEN_SCOPE/);
    await assert.rejects(service.list(global(personId), new Date("invalid")), /INVALID_INPUT/);
  } finally {
    await db.close();
  }
});
