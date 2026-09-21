import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { postLedgerEvent } from "@teaching-research-alliance/domain";
import { PostgresLedgerRepository } from "../../dist/main.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const connectionString = process.env.DATABASE_URL;

test("真实PostgreSQL账本发布与重复请求只入账一次", async () => {
  if (connectionString === undefined || connectionString.trim() === "") {
    throw new Error("DATABASE_URL_REQUIRED_FOR_POSTGRES_INTEGRATION");
  }

  const database = await createTestDatabase(connectionString);
  const { pool } = database;
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
      deltas: [
        { accountKey: accountCode, categoryKey: "teachingTeacher", amountCents: 72000n },
        { accountKey: accountCode, categoryKey: "teachingMentor", amountCents: 8000n }
      ]
    };
    const initialResults = await Promise.all(Array.from({ length: 5 }, () => postLedgerEvent(repository, command, () => eventId)));
    assert.equal(initialResults.filter(result => result.status === "POSTED").length, 1);
    assert.equal(initialResults.filter(result => result.status === "REPLAY").length, 4);
    const posted = initialResults.find(result => result.status === "POSTED");
    assert.equal(posted.status, "POSTED");
    assert.equal(posted.balances[accountCode], 80000n);

    const sameEventResults = await Promise.all(
      Array.from({ length: 5 }, () => postLedgerEvent(repository, command, () => randomUUID()))
    );
    assert.equal(sameEventResults.filter((result) => result.status === "POSTED").length, 0);
    assert.equal(sameEventResults.filter((result) => result.status === "REPLAY").length, 5);
    for (const replay of sameEventResults) {
      assert.equal(replay.event.eventId, eventId);
      assert.equal(replay.balances[accountCode], 80000n);
    }

    const concurrentCommands = Array.from({ length: 5 }, (_, index) => ({
      eventKey: `${eventKey}:concurrent:${index}`,
      eventType: "WEEKLY_FEE_ALLOCATION",
      payloadHash: `hash:${suffix}:concurrent:${index}`,
      deltas: [{ accountKey: accountCode, categoryKey: "teachingTeacher", amountCents: 1000n }]
    }));
    const concurrentResults = await Promise.all(
      concurrentCommands.map((concurrentCommand) =>
        postLedgerEvent(repository, concurrentCommand, () => randomUUID())
      )
    );
    assert.deepEqual(concurrentResults.map((result) => result.status), ["POSTED", "POSTED", "POSTED", "POSTED", "POSTED"]);
    assert.deepEqual(concurrentResults.map((result) => result.balances[accountCode]).sort((left, right) => Number(left - right)), [
      81000n,
      82000n,
      83000n,
      84000n,
      85000n
    ]);

    const counts = await pool.query(
      `SELECT
         (SELECT count(*) FROM ledger_event WHERE event_key = $1) AS event_count,
         (SELECT count(*) FROM ledger_entry entry JOIN ledger_event event ON event.id = entry.event_id WHERE event.event_key = $1) AS entry_count,
         (SELECT count(*) FROM ledger_event WHERE event_key LIKE $3) AS concurrent_event_count,
         (SELECT count(*) FROM ledger_entry entry JOIN ledger_event event ON event.id = entry.event_id WHERE event.event_key LIKE $3) AS concurrent_entry_count,
         (SELECT projection.balance_cents FROM account_balance_projection projection JOIN settlement_account account ON account.id = projection.account_id WHERE account.account_code = $2) AS balance_cents,
         (SELECT count(*) FROM ledger_entry entry JOIN ledger_event event ON event.id = entry.event_id JOIN settlement_account account ON account.id = entry.account_id WHERE event.event_key = $1 AND account.account_code = $2 AND entry.category_key = 'teachingTeacher') AS teaching_teacher_entry_count,
         (SELECT count(*) FROM ledger_entry entry JOIN ledger_event event ON event.id = entry.event_id JOIN settlement_account account ON account.id = entry.account_id WHERE event.event_key = $1 AND account.account_code = $2 AND entry.category_key = 'teachingMentor') AS teaching_mentor_entry_count`,
      [eventKey, accountCode, `${eventKey}:concurrent:%`]
    );
    assert.deepEqual(counts.rows[0], {
      event_count: "1",
      entry_count: "2",
      concurrent_event_count: "5",
      concurrent_entry_count: "5",
      balance_cents: "85000",
      teaching_teacher_entry_count: "1",
      teaching_mentor_entry_count: "1"
    });
  } finally {
    await database.close();
  }
});
