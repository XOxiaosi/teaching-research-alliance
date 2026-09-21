import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { postLedgerEvent } from "@teaching-research-alliance/domain";
import { prepareLedgerPosting } from "../../dist/postgres-ledger-locks.js";
import { createPostgresLedgerTransaction, PostgresLedgerRepository } from "../../dist/postgres-ledger-repository.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const withTimeout = async (promise, milliseconds = 2_000) => {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("LEDGER_LOCK_TIMEOUT")), milliseconds); });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer); }
};

const postWithinClient = async (client, command) => postLedgerEvent({
  transaction: (work) => work(createPostgresLedgerTransaction(client))
}, command, randomUUID);

test("真实 PostgreSQL：账本事件、代码单元账户顺序与余额投影以统一锁序完成", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const { pool } = db;
  const suffix = randomUUID();
  const personIds = [randomUUID(), randomUUID()];
  const lowerCode = `a-ledger-${suffix}`;
  const upperCode = `B-ledger-${suffix}`;
  try {
    for (const [index, personId] of personIds.entries()) {
      await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,'合成人员','ACTIVE')", [personId, `ledger-${suffix}-${index}`]);
      await pool.query("INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('PERSON',$1::uuid,$2,'ACTIVE')", [personId, [lowerCode, upperCode][index]]);
    }

    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query("BEGIN");
      const prepared = await prepareLedgerPosting(first, `prepared:first:${suffix}`, [lowerCode, lowerCode, upperCode]);
      assert.deepEqual(prepared.map((account) => account.accountCode), [upperCode, lowerCode], "锁账户按代码单元而非 localeCompare 排序");
      assert.deepEqual(prepared.map((account) => account.balanceCents), [0n, 0n]);
      await second.query("BEGIN");
      // This starts only after the first transaction holds both account locks. Releasing first is the deterministic gate.
      const waiting = prepareLedgerPosting(second, `prepared:second:${suffix}`, [lowerCode, upperCode]);
      await first.query("COMMIT");
      const secondPrepared = await withTimeout(waiting);
      assert.deepEqual(secondPrepared.map((account) => account.accountCode), [upperCode, lowerCode]);
      await second.query("COMMIT");
    } catch (error) {
      await first.query("ROLLBACK").catch(() => {});
      await second.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      await first.release();
      await second.release();
    }

    const preparedCommand = {
      eventKey: `prepared-post:${suffix}`, eventType: "SYNTHETIC_ADJUSTMENT", payloadHash: `prepared:${suffix}`,
      // Domain normalization sorts this by `${accountKey}:${categoryKey}` (lowerCode then upperCode), while account locks are upperCode then lowerCode.
      deltas: [
        { accountKey: lowerCode, categoryKey: "z-category", amountCents: 3n },
        { accountKey: upperCode, categoryKey: "a-category", amountCents: -3n }
      ]
    };
    const direct = await pool.connect();
    try {
      await direct.query("BEGIN");
      await prepareLedgerPosting(direct, preparedCommand.eventKey, [upperCode, lowerCode]);
      const posted = await postWithinClient(direct, preparedCommand);
      assert.equal(posted.status, "POSTED");
      await direct.query("COMMIT");
    } catch (error) {
      await direct.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { await direct.release(); }
    const repository = new PostgresLedgerRepository(pool);
    assert.equal((await withTimeout(postLedgerEvent(repository, preparedCommand, randomUUID))).status, "REPLAY", "普通发布和已 prepare 的同事件安全重入");

    const forward = {
      eventKey: `cross:forward:${suffix}`, eventType: "SYNTHETIC_ADJUSTMENT", payloadHash: `forward:${suffix}`,
      deltas: [
        { accountKey: lowerCode, categoryKey: "z-category", amountCents: 20n },
        { accountKey: upperCode, categoryKey: "a-category", amountCents: -20n }
      ]
    };
    const reverse = {
      eventKey: `cross:reverse:${suffix}`, eventType: "SYNTHETIC_ADJUSTMENT", payloadHash: `reverse:${suffix}`,
      deltas: [
        { accountKey: upperCode, categoryKey: "z-category", amountCents: 5n },
        { accountKey: lowerCode, categoryKey: "a-category", amountCents: -5n }
      ]
    };
    // Deterministic crossing: T1 explicitly prepares [A,B], T2 enters a normal
    // repository post for [B,A], then T1 performs its ordinary post and commits.
    // The gate is raised only after T2 has issued its first account-lock query.
    const crossingFirst = await pool.connect();
    const crossingSecond = await pool.connect();
    let notifyLockRequested;
    const lockRequested = new Promise((resolve) => { notifyLockRequested = resolve; });
    let notified = false;
    const observedSecond = {
      query(sql, values) {
        const pending = crossingSecond.query(sql, values);
        if (!notified && sql.includes("FROM settlement_account WHERE account_code") && sql.includes("FOR NO KEY UPDATE")) {
          notified = true;
          notifyLockRequested();
        }
        return pending;
      },
      release() { return crossingSecond.release(); }
    };
    let firstCommitted = false;
    let secondCommitted = false;
    try {
      await crossingFirst.query("BEGIN");
      await crossingFirst.query("SET LOCAL lock_timeout = '2s'");
      await prepareLedgerPosting(crossingFirst, forward.eventKey, [upperCode, lowerCode]);

      await crossingSecond.query("BEGIN");
      await crossingSecond.query("SET LOCAL lock_timeout = '2s'");
      const reversePost = postWithinClient(observedSecond, reverse);
      await withTimeout(lockRequested);
      assert.equal(notified, true, "普通入账已发出账户锁请求，等待显式 prepare 持有的同一账户集合");

      const forwardResult = await postWithinClient(crossingFirst, forward);
      assert.equal(forwardResult.status, "POSTED");
      await crossingFirst.query("COMMIT");
      firstCommitted = true;

      const reverseResult = await withTimeout(reversePost);
      assert.equal(reverseResult.status, "POSTED");
      await crossingSecond.query("COMMIT");
      secondCommitted = true;
    } finally {
      if (!firstCommitted) await crossingFirst.query("ROLLBACK").catch(() => {});
      if (!secondCommitted) await crossingSecond.query("ROLLBACK").catch(() => {});
      await crossingFirst.release();
      await crossingSecond.release();
    }
    const balances = await pool.query(
      `SELECT account.account_code,projection.balance_cents::text AS balance_cents
         FROM settlement_account account JOIN account_balance_projection projection ON projection.account_id=account.id
        WHERE account.account_code=ANY($1::text[]) ORDER BY account.account_code`, [[upperCode, lowerCode]]
    );
    assert.deepEqual(balances.rows, [
      { account_code: upperCode, balance_cents: "-18" },
      { account_code: lowerCode, balance_cents: "18" }
    ]);
  } finally {
    await db.close();
  }
});
