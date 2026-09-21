import test from "node:test";
import assert from "node:assert/strict";
import { PostgresIdentityRepository } from "../dist/main.js";

const createFakePool = () => {
  const calls = [];
  const pool = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes("FROM user_account")) {
        return {
          rows: [{
            account_id: "account-1",
            person_id: "person-1",
            phone_normalized: "13800000000",
            password_hash: "argon2-hash",
            login_status: "ACTIVE"
          }],
          rowCount: 1
        };
      }
      if (sql.includes("FROM role_assignment")) {
        return {
          rows: [{
            person_id: "person-1",
            subject_code: "GROUP_LEADER",
            scope_type: "ASSOCIATED_TEACHERS",
            scope_id: null,
            valid_from: "2026-01-01T00:00:00.000Z",
            valid_to: null
          }, {
            person_id: "person-1",
            subject_code: "CAMPUS_PRINCIPAL",
            scope_type: "CAMPUS",
            scope_id: "campus-1",
            valid_from: new Date("2026-02-01T00:00:00.000Z"),
            valid_to: new Date("2026-08-01T00:00:00.000Z")
          }],
          rowCount: 2
        };
      }
      if (sql.includes("UPDATE user_account")) return { rows: [], rowCount: 1 };
      throw new Error(`UNEXPECTED_SQL:${sql}`);
    }
  };
  return { pool, calls };
};

test("PostgreSQL身份仓储读取账号、岗位历史并保留密码哈希边界", async () => {
  const fake = createFakePool();
  const repository = new PostgresIdentityRepository(fake.pool);
  const account = await repository.findAccountByPhone("13800000000");
  assert.deepEqual(account, {
    accountId: "account-1",
    personId: "person-1",
    phoneNormalized: "13800000000",
    credentialDigest: "argon2-hash",
    status: "ACTIVE"
  });
  const assignments = await repository.listRoleAssignments("person-1");
  assert.equal(assignments.length, 2);
  assert.deepEqual(assignments[0], {
    personId: "person-1",
    subject: "GROUP_LEADER",
    scope: "ASSOCIATED_TEACHERS",
    validFrom: new Date("2026-01-01T00:00:00.000Z")
  });
  assert.deepEqual(assignments[1], {
    personId: "person-1",
    subject: "CAMPUS_PRINCIPAL",
    scope: "CAMPUS",
    scopeId: "campus-1",
    validFrom: new Date("2026-02-01T00:00:00.000Z"),
    validTo: new Date("2026-08-01T00:00:00.000Z")
  });
  await repository.revokeAccount("account-1");
  assert.equal(fake.calls.filter((call) => call.sql.includes("$1")).length, 3);
});

test("身份仓储拒绝数据库中未登记的岗位编码", async () => {
  const fake = createFakePool();
  fake.pool.query = async (sql, values = []) => {
    fake.calls.push({ sql, values });
    if (sql.includes("FROM role_assignment")) return {
      rows: [{
        person_id: "person-1",
        subject_code: "UNKNOWN_ROLE",
        scope_type: "SELF",
        scope_id: null,
        valid_from: "2026-01-01T00:00:00.000Z",
        valid_to: null
      }],
      rowCount: 1
    };
    return { rows: [], rowCount: 0 };
  };
  const repository = new PostgresIdentityRepository(fake.pool);
  await assert.rejects(() => repository.listRoleAssignments("person-1"), /INVALID_ROLE_ASSIGNMENT_SUBJECT/);
});
