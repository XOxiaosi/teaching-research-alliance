import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { postLedgerEvent } from "@teaching-research-alliance/domain";
import { createPostgresPool, PostgresLedgerRepository } from "../../dist/main.js";

const connectionString = process.env.DATABASE_URL;

test("真实PostgreSQL账本发布与重复请求只入账一次", async () => {
  if (connectionString === undefined || connectionString.trim() === "") {
    throw new Error("DATABASE_URL_REQUIRED_FOR_POSTGRES_INTEGRATION");
  }

  const pool = createPostgresPool(connectionString);
  const suffix = randomUUID();
  const nickname = `集成验收教师-${suffix}`;
  const accountCode = `integration:teacher:${suffix}`;
  const eventKey = `integration:weekly-fee:${suffix}`;
  const eventId = randomUUID();

  try {
    const seed = await pool.query(
      `INSERT INTO person (nickname, legal_name, status)
       VALUES ($1, $1, 'ACTIVE')
       RETURNING id`,
      [nickname]
    );
    const personId = seed.rows[0]?.id;
    assert.equal(typeof personId, "string");
    await pool.query(
      `INSERT INTO settlement_account (owner_type, owner_id, account_code, status)
       VALUES ('PERSON', $1::uuid, $2, 'ACTIVE')`,
      [personId, accountCode]
    );

    const repository = new PostgresLedgerRepository(pool);
    const command = {
      eventKey,
      eventType: "WEEKLY_FEE_ALLOCATION",
      payloadHash: `hash:${suffix}`,
      deltas: [{ accountKey: accountCode, categoryKey: "teachingTeacher", amountCents: 72000n }]
    };
    const posted = await postLedgerEvent(repository, command, () => eventId);
    assert.equal(posted.status, "POSTED");
    assert.equal(posted.balances[accountCode], 72000n);

    const replay = await postLedgerEvent(repository, command, () => randomUUID());
    assert.equal(replay.status, "REPLAY");
    assert.equal(replay.event.eventId, eventId);
    assert.equal(replay.balances[accountCode], 72000n);

    const counts = await pool.query(
      `SELECT
         (SELECT count(*) FROM ledger_event WHERE event_key = $1) AS event_count,
         (SELECT count(*) FROM ledger_entry entry JOIN ledger_event event ON event.id = entry.event_id WHERE event.event_key = $1) AS entry_count,
         (SELECT projection.balance_cents FROM account_balance_projection projection JOIN settlement_account account ON account.id = projection.account_id WHERE account.account_code = $2) AS balance_cents`,
      [eventKey, accountCode]
    );
    assert.deepEqual(counts.rows[0], { event_count: "1", entry_count: "1", balance_cents: "72000" });
  } finally {
    await pool.end();
  }
});
