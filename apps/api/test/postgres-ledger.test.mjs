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
      if (sql.includes("FROM ledger_event le")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO ledger_event")) return { rows: [], rowCount: 1 };
      if (sql.includes("INSERT INTO ledger_entry")) return { rows: [], rowCount: entryRowCount };
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
  assert.deepEqual(normalizedSql, [
    "BEGIN",
    "SELECT le.id::text AS event_id, le.event_key, le.event_type, le.payload_hash, sa.account_code AS account_key, entry.category_key, entry.amount_cents::text AS amount_cents FROM ledger_event le LEFT JOIN ledger_entry entry ON entry.event_id = le.id LEFT JOIN settlement_account sa ON sa.id = entry.account_id WHERE le.event_key = $1 ORDER BY entry.id",
    "INSERT INTO ledger_event (id, event_key, event_type, payload_hash) VALUES ($1::uuid, $2, $3, $4)",
    "INSERT INTO ledger_entry (event_id, account_id, category_key, amount_cents) SELECT $1::uuid, account.id, $3, $4::bigint FROM settlement_account account WHERE account.account_code = $2",
    "INSERT INTO account_balance_projection (account_id, balance_cents) SELECT account.id, $2::bigint FROM settlement_account account WHERE account.account_code = $1 ON CONFLICT (account_id) DO UPDATE SET balance_cents = account_balance_projection.balance_cents + EXCLUDED.balance_cents, updated_at = now()",
    "SELECT COALESCE(projection.balance_cents, 0)::text AS balance_cents FROM settlement_account account LEFT JOIN account_balance_projection projection ON projection.account_id = account.id WHERE account.account_code = $1",
    "COMMIT",
    "RELEASE"
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
