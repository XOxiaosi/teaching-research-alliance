import test from "node:test";
import assert from "node:assert/strict";
import { PostgresLedgerRepository } from "../dist/main.js";
import { postLedgerEvent } from "@teaching-research-alliance/domain";

const createFakePool = ({ entryRowCount = 1 } = {}) => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("FROM ledger_event le")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM settlement_account WHERE account_code") && sql.includes("FOR NO KEY UPDATE")) {
        return {
          rows: [{
            id: "00000000-0000-4000-8000-000000000010",
            owner_type: "PERSON",
            owner_id: "00000000-0000-4000-8000-000000000011",
            account_code: values[0],
            status: "ACTIVE"
          }],
          rowCount: 1
        };
      }
      if (sql.includes("INSERT INTO ledger_event")) return { rows: [], rowCount: 1 };
      if (sql.includes("INSERT INTO ledger_entry")) return { rows: [], rowCount: entryRowCount };
      if (sql.includes("FROM account_balance_projection") && sql.includes("FOR UPDATE")) return { rows: [{ balance_cents: "0" }], rowCount: 1 };
      if (sql.includes("SELECT COALESCE")) return { rows: [{ balance_cents: "72000" }], rowCount: 1 };
      if (sql.includes("INSERT INTO account_balance_projection")) return { rows: [], rowCount: 1 };
      throw new Error(`UNEXPECTED_SQL:${sql}`);
    },
    release() { calls.push({ sql: "RELEASE", values: [] }); }
  };
  return { pool: { async connect() { return client; } }, calls };
};

test("PostgreSQL账本适配器使用参数化SQL并在成功后提交", async () => {
  const fake = createFakePool();
  const repository = new PostgresLedgerRepository(fake.pool);
  const result = await postLedgerEvent(repository, {
    eventKey: "weekly-fee:postgres-1",
    eventType: "WEEKLY_FEE_ALLOCATION",
    payloadHash: "hash-postgres-1",
    deltas: [{ accountKey: "person-teacher", categoryKey: "teachingTeacher", amountCents: 72000n }]
  }, () => "00000000-0000-4000-8000-000000000001");
  assert.equal(result.status, "POSTED");
  const normalizedSql = fake.calls.map((call) => call.sql.replace(/\s+/g, " ").trim());
  assert.equal(normalizedSql[0], "BEGIN");
  assert.equal(normalizedSql.at(-2), "COMMIT");
  assert.equal(normalizedSql.at(-1), "RELEASE");
  const advisoryCalls = fake.calls.filter(call => call.sql.includes("pg_advisory_xact_lock"));
  assert.equal(advisoryCalls.length, 2, "findEvent 与无条件 prepare 在同一事务中可重入同一事件锁");
  assert.deepEqual(advisoryCalls.map(call => call.values), [
    ["ledger-event:weekly-fee:postgres-1"],
    ["ledger-event:weekly-fee:postgres-1"]
  ]);
  const ledgerEntryCall = fake.calls.find((call) => call.sql.includes("INSERT INTO ledger_entry"));
  assert.deepEqual(ledgerEntryCall.values, ["00000000-0000-4000-8000-000000000001", "person-teacher", "teachingTeacher", "72000"]);
});

test("PostgreSQL账户映射缺失时回滚事务", async () => {
  const fake = createFakePool({ entryRowCount: 0 });
  const repository = new PostgresLedgerRepository(fake.pool);
  await assert.rejects(
    () => postLedgerEvent(repository, {
      eventKey: "weekly-fee:postgres-missing",
      eventType: "WEEKLY_FEE_ALLOCATION",
      payloadHash: "hash-postgres-missing",
      deltas: [{ accountKey: "missing-account", categoryKey: "teachingTeacher", amountCents: 72000n }]
    }, () => "00000000-0000-4000-8000-000000000002"),
    /MISSING_ACCOUNT_MAPPING/
  );
  assert.equal(fake.calls.at(-2)?.sql, "ROLLBACK");
  assert.equal(fake.calls.at(-1)?.sql, "RELEASE");
});

test("账本可绑定外层事务，读取多类别按规范排序且不自行提交", async () => {
  const { createPostgresLedgerTransaction } = await import("../dist/postgres-ledger-repository.js");
  const calls = [];
  const transaction = createPostgresLedgerTransaction({
    async query(sql) {
      calls.push(sql);
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      return { rows: ["teachingTeacher", "groupLeader"].map(category => ({
        event_id: "00000000-0000-4000-8000-000000000001", event_key: "shared", event_type: "TEST",
        payload_hash: "hash", account_key: "one-person", category_key: category, amount_cents: "1"
      })) };
    },
    release() { throw new Error("OUTER_TRANSACTION_RELEASED"); }
  });
  const event = await transaction.findEvent("shared");
  assert.deepEqual(event.deltas.map(delta => delta.categoryKey), ["groupLeader", "teachingTeacher"]);
  assert.equal(calls.some(sql => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)), false);
});
