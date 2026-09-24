import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { BackgroundWorkerRuntime, WorkerTaskTransientError } from "../dist/background-worker-runtime.js";

const at = new Date("2026-09-23T05:00:00.000Z");
const task = (overrides = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  taskType: "SYNTHETIC_TASK",
  payload: { approved: true },
  attemptCount: 1,
  maxAttempts: 3,
  ...overrides,
});

class SyntheticQueue {
  constructor(tasks) {
    this.tasks = [...tasks];
    this.claims = [];
    this.renewals = [];
    this.successes = [];
    this.failures = [];
  }

  async claim(_at, _leaseMs, taskTypes, limit) {
    this.claims.push([...taskTypes]);
    const claimed = this.tasks.filter((item) => taskTypes.includes(item.task.taskType)).splice(0, limit);
    this.tasks = this.tasks.filter((item) => !claimed.includes(item));
    return claimed;
  }

  async renew(taskId, leaseToken, atValue, leaseMs) {
    this.renewals.push({ taskId, leaseToken, at: atValue, leaseMs });
  }

  async succeed(taskId, leaseToken, atValue) {
    this.successes.push({ taskId, leaseToken, at: atValue });
  }

  async fail(taskId, leaseToken, failure, atValue, retryAt) {
    this.failures.push({ taskId, leaseToken, failure, at: atValue, retryAt });
  }
}

const claimed = (value) => ({
  task: value,
  leaseToken: "22222222-2222-4222-8222-222222222222",
  leaseExpiresAt: new Date(at.getTime() + 1_000).toISOString(),
});

const runtime = (queue, registration, options = {}) => new BackgroundWorkerRuntime({
  queue,
  registrations: [registration],
  concurrency: 2,
  leaseMs: 1_000,
  heartbeatMs: 5,
  pollMs: 5,
  retryBaseMs: 100,
  retryMaxMs: 1_000,
  clock: () => at,
  ...options,
});

test("runtime 只领取真实注册类型、续租并确认合成处理器的成功结果", async () => {
  const queue = new SyntheticQueue([
    claimed(task()),
    claimed(task({ id: "33333333-3333-4333-8333-333333333333", taskType: "UNREGISTERED_TASK" })),
  ]);
  const observed = [];
  const worker = runtime(queue, {
    taskType: "SYNTHETIC_TASK",
    validatePayload: (payload) => payload?.approved === true,
    handle: async ({ task: handled }) => {
      observed.push(handled.id);
      await wait(20);
    },
  });
  const controller = new AbortController();
  assert.equal(await worker.runOnce(controller.signal), 1);
  assert.deepEqual(queue.claims, [["SYNTHETIC_TASK"]]);
  assert.deepEqual(observed, ["11111111-1111-4111-8111-111111111111"]);
  assert.equal(queue.renewals.length >= 1, true);
  assert.equal(queue.successes.length, 1);
  assert.equal(queue.failures.length, 0);
  assert.equal(queue.tasks.length, 1);
});

test("非法 payload 直接终态失败，瞬时失败按有界延后重试", async () => {
  const invalidQueue = new SyntheticQueue([claimed(task({ payload: { approved: false } }))]);
  const invalidWorker = runtime(invalidQueue, {
    taskType: "SYNTHETIC_TASK",
    validatePayload: (payload) => payload?.approved === true,
    handle: async () => assert.fail("invalid payload must not reach handler"),
  });
  assert.equal(await invalidWorker.runOnce(new AbortController().signal), 1);
  assert.deepEqual(invalidQueue.failures.map((entry) => entry.failure), [{ code: "TASK_PAYLOAD_INVALID", reason: "The registered task payload was invalid." }]);
  assert.equal(invalidQueue.failures[0].retryAt, undefined);

  const transientQueue = new SyntheticQueue([claimed(task({ attemptCount: 2 }))]);
  const transientWorker = runtime(transientQueue, {
    taskType: "SYNTHETIC_TASK",
    validatePayload: () => true,
    handle: async () => { throw new WorkerTaskTransientError(); },
  });
  assert.equal(await transientWorker.runOnce(new AbortController().signal), 1);
  assert.deepEqual(transientQueue.failures.map((entry) => entry.failure), [{ code: "WORKER_TASK_RETRY", reason: "A retryable worker handler failure was recorded." }]);
  assert.equal(transientQueue.failures[0].retryAt?.toISOString(), new Date(at.getTime() + 200).toISOString());
});

test("停止会中止处理器且不确认正在执行的租约", async () => {
  const queue = new SyntheticQueue([claimed(task())]);
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const worker = runtime(queue, {
    taskType: "SYNTHETIC_TASK",
    validatePayload: () => true,
    handle: async ({ signal }) => {
      started();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    },
  });
  const controller = new AbortController();
  const running = worker.run(controller.signal);
  await startedPromise;
  controller.abort();
  await running;
  assert.equal(queue.successes.length, 0);
  assert.equal(queue.failures.length, 0);
});

test("停止不会等待忽略 AbortSignal 的处理器，且不会继续续租或确认", async () => {
  const queue = new SyntheticQueue([claimed(task())]);
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const worker = runtime(queue, {
    taskType: "SYNTHETIC_TASK",
    validatePayload: () => true,
    handle: async () => {
      started();
      await new Promise(() => {});
    },
  });
  const controller = new AbortController();
  const running = worker.run(controller.signal);
  await startedPromise;
  await wait(15);
  const renewalCountAtStop = queue.renewals.length;
  controller.abort();
  await running;
  await wait(15);
  assert.equal(queue.renewals.length, renewalCountAtStop);
  assert.equal(queue.successes.length, 0);
  assert.equal(queue.failures.length, 0);
});
