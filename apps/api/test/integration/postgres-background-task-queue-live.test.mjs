import assert from "node:assert/strict";
import test from "node:test";
import { PostgresBackgroundTaskQueueService } from "../../dist/postgres-background-task-queue-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const at = new Date("2026-09-23T04:00:00.000Z");
const later = (milliseconds) => new Date(at.getTime() + milliseconds);

const fixture = async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  return { db, queue: new PostgresBackgroundTaskQueueService(db.pool) };
};

test("持久任务按类型和幂等键只创建一次，且拒绝重用键的不同请求", async () => {
  const { db, queue } = await fixture();
  try {
    const first = await queue.enqueue({ taskType: "BACKUP_EXPORT", idempotencyKey: "backup-2026-09-23", payload: { scope: "ALL" }, maxAttempts: 3 }, at);
    const replay = await queue.enqueue({ taskType: "BACKUP_EXPORT", idempotencyKey: "backup-2026-09-23", payload: { scope: "ALL" }, maxAttempts: 3 }, later(1000));
    assert.equal(first.id, replay.id); assert.equal(replay.status, "PENDING"); assert.equal(replay.attemptCount, 0);
    await assert.rejects(queue.enqueue({ taskType: "BACKUP_EXPORT", idempotencyKey: "backup-2026-09-23", payload: { scope: "CURRENT_YEAR" }, maxAttempts: 3 }, later(2000)), /TASK_IDEMPOTENCY_CONFLICT/);
    await assert.rejects(queue.enqueue({ taskType: "bad-type", idempotencyKey: "x" }, at), /TASK_TYPE_INVALID/);
    await assert.rejects(queue.enqueue({ taskType: "BACKUP_EXPORT", idempotencyKey: " " }, at), /TASK_IDEMPOTENCY_KEY_INVALID/);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM background_task")).rows[0].count, 1);
  } finally { await db.close(); }
});

test("真实 PostgreSQL 的 SKIP LOCKED 将并发领取和被锁记录分开", async () => {
  const { db, queue } = await fixture();
  try {
    const first = await queue.enqueue({ taskType: "RATE_RECALCULATION", idempotencyKey: "first" }, at);
    const second = await queue.enqueue({ taskType: "RATE_RECALCULATION", idempotencyKey: "second" }, at);
    const locked = await db.pool.connect();
    try {
      await locked.query("BEGIN");
      await locked.query("SELECT id FROM background_task WHERE id=$1::uuid FOR UPDATE", [first.id]);
      const claimed = await queue.claim(at, 60_000, ["RATE_RECALCULATION"], 2);
      assert.deepEqual(claimed.map((item) => item.task.id), [second.id]);
      await locked.query("ROLLBACK");
    } finally { locked.release(); }
    const [a, b] = await Promise.all([
      queue.claim(later(1000), 60_000, ["RATE_RECALCULATION"]),
      queue.claim(later(1000), 60_000, ["RATE_RECALCULATION"]),
    ]);
    const ids = [...a, ...b].map((item) => item.task.id);
    assert.deepEqual(ids, [first.id]);
    const all = await db.pool.query("SELECT id::text AS id,status,attempt_count FROM background_task ORDER BY id");
    assert.equal(all.rows.filter((row) => row.status === "RUNNING").length, 2);
    assert.equal(all.rows.find((row) => row.id === first.id).attempt_count, 1);
    assert.equal(all.rows.find((row) => row.id === second.id).attempt_count, 1);
  } finally { await db.close(); }
});

test("过期租约可恢复，旧执行者不能覆盖新领取结果", async () => {
  const { db, queue } = await fixture();
  try {
    const task = await queue.enqueue({ taskType: "MONTHLY_PREPARE", idempotencyKey: "2026-10", maxAttempts: 2 }, at);
    const oldLease = (await queue.claim(at, 1_000, ["MONTHLY_PREPARE"]))[0];
    assert.ok(oldLease);
    await assert.rejects(queue.succeed(task.id, oldLease.leaseToken, later(1_001)), /TASK_LEASE_LOST/);
    const currentLease = (await queue.claim(later(1_001), 1_000, ["MONTHLY_PREPARE"]))[0];
    assert.ok(currentLease); assert.notEqual(currentLease.leaseToken, oldLease.leaseToken);
    await assert.rejects(queue.succeed(task.id, oldLease.leaseToken, later(1_002)), /TASK_LEASE_LOST/);
    const completed = await queue.succeed(task.id, currentLease.leaseToken, later(1_003));
    assert.equal(completed.status, "SUCCEEDED"); assert.equal(completed.attemptCount, 2);
    const replayed = await queue.succeed(task.id, currentLease.leaseToken, later(1_004));
    assert.equal(replayed.status, "SUCCEEDED"); assert.equal(replayed.id, task.id);
    await assert.rejects(queue.fail(task.id, currentLease.leaseToken, { code: "WRONG_RESULT", reason: "A completed lease cannot be changed." }, later(1_005)), /TASK_RESULT_CONFLICT/);
    const attempts = await db.pool.query("SELECT attempt_no,outcome,failure_code FROM background_task_attempt WHERE task_id=$1::uuid ORDER BY attempt_no", [task.id]);
    assert.deepEqual(attempts.rows, [
      { attempt_no: 1, outcome: "LEASE_EXPIRED", failure_code: "LEASE_EXPIRED" },
      { attempt_no: 2, outcome: "SUCCEEDED", failure_code: null }
    ]);
  } finally { await db.close(); }
});

test("失败原因、延后重试和停机后耗尽租约均持久可核对", async () => {
  const { db, queue } = await fixture();
  try {
    const retryable = await queue.enqueue({ taskType: "FULL_BACKUP", idempotencyKey: "retryable", maxAttempts: 2 }, at);
    const first = (await queue.claim(at, 1_000, ["FULL_BACKUP"]))[0]; assert.ok(first);
    const rescheduled = await queue.fail(retryable.id, first.leaseToken, { code: "SOURCE_UNAVAILABLE", reason: "Synthetic source was unavailable." }, later(1), later(5_000));
    assert.equal(rescheduled.status, "PENDING"); assert.equal(rescheduled.lastFailureCode, "SOURCE_UNAVAILABLE");
    const rescheduledReplay = await queue.fail(retryable.id, first.leaseToken, { code: "SOURCE_UNAVAILABLE", reason: "Synthetic source was unavailable." }, later(2), later(5_000));
    assert.equal(rescheduledReplay.status, "PENDING"); assert.equal(rescheduledReplay.id, retryable.id);
    await assert.rejects(queue.fail(retryable.id, first.leaseToken, { code: "SOURCE_UNAVAILABLE", reason: "Different failure payload." }, later(3), later(5_000)), /TASK_RESULT_CONFLICT/);
    assert.deepEqual(await queue.claim(later(4_999), 1_000, ["FULL_BACKUP"]), []);
    const second = (await queue.claim(later(5_000), 1_000, ["FULL_BACKUP"]))[0]; assert.ok(second);
    const terminal = await queue.fail(retryable.id, second.leaseToken, { code: "SOURCE_UNAVAILABLE", reason: "Synthetic source stayed unavailable." }, later(5_001));
    assert.equal(terminal.status, "FAILED"); assert.equal(terminal.lastFailureReason, "Synthetic source stayed unavailable.");
    const terminalReplay = await queue.fail(retryable.id, second.leaseToken, { code: "SOURCE_UNAVAILABLE", reason: "Synthetic source stayed unavailable." }, later(5_002));
    assert.equal(terminalReplay.status, "FAILED"); assert.equal(terminalReplay.id, retryable.id);
    await assert.rejects(queue.retry(retryable.id, later(5_003)), /TASK_RETRY_NOT_ALLOWED/);

    const exhausted = await queue.enqueue({ taskType: "REFERRAL_EXPIRY", idempotencyKey: "lease-exhausted", maxAttempts: 1 }, at);
    const abandoned = (await queue.claim(at, 1_000, ["REFERRAL_EXPIRY"]))[0]; assert.ok(abandoned);
    assert.deepEqual(await queue.claim(later(1_001), 1_000, ["REFERRAL_EXPIRY"]), []);
    const recovered = await queue.get(exhausted.id);
    assert.equal(recovered?.status, "FAILED"); assert.equal(recovered?.lastFailureCode, "LEASE_EXPIRED_RETRY_EXHAUSTED");
    const abandonedAttempt = await db.pool.query("SELECT outcome,failure_code FROM background_task_attempt WHERE task_id=$1::uuid", [exhausted.id]);
    assert.deepEqual(abandonedAttempt.rows, [{ outcome: "LEASE_EXPIRED", failure_code: "LEASE_EXPIRED_RETRY_EXHAUSTED" }]);
  } finally { await db.close(); }
});

test("领取必须显式限制为已注册类型，未注册任务保持待处理", async () => {
  const { db, queue } = await fixture();
  try {
    const referral = await queue.enqueue({ taskType: "REFERRAL_EXPIRY", idempotencyKey: "registered" }, at);
    const backup = await queue.enqueue({ taskType: "FULL_BACKUP", idempotencyKey: "unregistered" }, at);
    const claimed = await queue.claim(at, 1_000, ["REFERRAL_EXPIRY"]);
    assert.deepEqual(claimed.map((item) => item.task.id), [referral.id]);
    assert.equal((await queue.get(backup.id))?.status, "PENDING");
    await assert.rejects(queue.claim(at, 1_000, []), /TASK_CLAIM_TYPES_REQUIRED/);
    await assert.rejects(queue.claim(at, 1_000, ["REFERRAL_EXPIRY", "REFERRAL_EXPIRY"]), /TASK_CLAIM_TYPES_INVALID/);
  } finally { await db.close(); }
});

test("续租延长同一执行者窗口，失效令牌既不能续租也不能确认", async () => {
  const { db, queue } = await fixture();
  try {
    const renewedTask = await queue.enqueue({ taskType: "REFERRAL_EXPIRY", idempotencyKey: "renewed" }, at);
    const lease = (await queue.claim(at, 1_000, ["REFERRAL_EXPIRY"]))[0];
    assert.ok(lease);
    const renewed = await queue.renew(renewedTask.id, lease.leaseToken, later(500), 1_000);
    assert.equal(renewed.leaseToken, lease.leaseToken);
    assert.equal(renewed.leaseExpiresAt, later(1_500).toISOString());
    assert.deepEqual(await queue.claim(later(1_001), 1_000, ["REFERRAL_EXPIRY"]), []);
    assert.equal((await queue.succeed(renewedTask.id, lease.leaseToken, later(1_001))).status, "SUCCEEDED");

    const staleTask = await queue.enqueue({ taskType: "REFERRAL_EXPIRY", idempotencyKey: "stale", maxAttempts: 2 }, at);
    const oldLease = (await queue.claim(at, 1_000, ["REFERRAL_EXPIRY"]))[0];
    assert.ok(oldLease);
    const currentLease = (await queue.claim(later(1_001), 1_000, ["REFERRAL_EXPIRY"]))[0];
    assert.ok(currentLease);
    await assert.rejects(queue.renew(staleTask.id, oldLease.leaseToken, later(1_002), 1_000), /TASK_LEASE_LOST/);
    await assert.rejects(queue.succeed(staleTask.id, oldLease.leaseToken, later(1_003)), /TASK_LEASE_LOST/);
    assert.equal((await queue.renew(staleTask.id, currentLease.leaseToken, later(1_004), 1_000)).task.status, "RUNNING");
    assert.equal((await queue.succeed(staleTask.id, currentLease.leaseToken, later(1_005))).status, "SUCCEEDED");
  } finally { await db.close(); }
});
