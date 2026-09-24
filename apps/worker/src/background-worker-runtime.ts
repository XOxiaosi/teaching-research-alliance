/**
 * A process-local runtime for durable internal work. Business packages supply
 * their own registrations; this module deliberately ships with none.
 */
export type WorkerTaskPayload = unknown;

export type WorkerTask = Readonly<{
  id: string;
  taskType: string;
  payload: WorkerTaskPayload;
  attemptCount: number;
  maxAttempts: number;
}>;

export type ClaimedWorkerTask = Readonly<{
  task: WorkerTask;
  leaseToken: string;
  leaseExpiresAt: string;
}>;

export type WorkerQueue = Readonly<{
  claim: (at: Date, leaseMs: number, taskTypes: readonly string[], limit?: number) => Promise<readonly ClaimedWorkerTask[]>;
  renew: (taskId: string, leaseToken: string, at: Date, leaseMs: number) => Promise<unknown>;
  succeed: (taskId: string, leaseToken: string, at: Date) => Promise<unknown>;
  fail: (taskId: string, leaseToken: string, failure: Readonly<{ code: string; reason: string }>, at: Date, retryAt?: Date) => Promise<unknown>;
}>;

export type WorkerTaskContext = Readonly<{
  task: WorkerTask;
  signal: AbortSignal;
}>;

export type WorkerTaskRegistration = Readonly<{
  taskType: string;
  /** Rejecting payload happens before the business handler and is terminal. */
  validatePayload: (payload: WorkerTaskPayload) => boolean;
  handle: (context: WorkerTaskContext) => Promise<void>;
}>;

export type WorkerLogEvent =
  | "BACKGROUND_WORKER_CLAIM_FAILED"
  | "BACKGROUND_WORKER_ACK_FAILED"
  | "BACKGROUND_WORKER_LEASE_LOST"
  | "BACKGROUND_WORKER_TASK_FAILED";

export type WorkerLogger = Readonly<{
  error: (event: WorkerLogEvent) => void;
}>;

export type BackgroundWorkerRuntimeOptions = Readonly<{
  queue: WorkerQueue;
  registrations: readonly WorkerTaskRegistration[];
  concurrency: number;
  leaseMs: number;
  heartbeatMs: number;
  pollMs: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  clock?: () => Date;
  logger?: WorkerLogger;
}>;

export class WorkerTaskTransientError extends Error {
  public constructor() {
    super("WORKER_TASK_TRANSIENT_FAILURE");
    this.name = "WorkerTaskTransientError";
  }
}

const TASK_TYPE = /^[A-Z][A-Z0-9_]{0,99}$/;
const fixedLogger: WorkerLogger = { error: () => {} };

const fail = (code: string): never => { throw new Error(code); };

const isPositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 1;

const sleep = async (milliseconds: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
};

/**
 * Claims only registered task types. It never logs an exception object or an
 * untrusted handler message, and shutdown leaves current leases for recovery.
 */
export class BackgroundWorkerRuntime {
  private readonly registrations: ReadonlyMap<string, WorkerTaskRegistration>;
  private readonly taskTypes: readonly string[];
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly clock: () => Date;
  private readonly logger: WorkerLogger;

  public constructor(private readonly options: BackgroundWorkerRuntimeOptions) {
    if (!isPositiveInteger(options.concurrency) || options.concurrency > 100) fail("WORKER_CONCURRENCY_INVALID");
    if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 1_000 || options.leaseMs > 3_600_000) fail("WORKER_LEASE_DURATION_INVALID");
    if (!isPositiveInteger(options.heartbeatMs) || options.heartbeatMs * 2 >= options.leaseMs) fail("WORKER_HEARTBEAT_INVALID");
    if (!isPositiveInteger(options.pollMs) || options.pollMs > 3_600_000) fail("WORKER_POLL_INTERVAL_INVALID");
    this.retryBaseMs = options.retryBaseMs ?? 1_000;
    this.retryMaxMs = options.retryMaxMs ?? 60_000;
    if (!isPositiveInteger(this.retryBaseMs) || !isPositiveInteger(this.retryMaxMs) || this.retryBaseMs > this.retryMaxMs || this.retryMaxMs > 3_600_000)
      fail("WORKER_RETRY_DELAY_INVALID");
    const registrations = new Map<string, WorkerTaskRegistration>();
    for (const registration of options.registrations) {
      if (!TASK_TYPE.test(registration.taskType) || registrations.has(registration.taskType)) fail("WORKER_REGISTRATION_INVALID");
      registrations.set(registration.taskType, registration);
    }
    if (registrations.size === 0) fail("WORKER_REGISTRATIONS_REQUIRED");
    this.registrations = registrations;
    this.taskTypes = [...registrations.keys()];
    this.clock = options.clock ?? (() => new Date());
    this.logger = options.logger ?? fixedLogger;
  }

  /** Claims at most one concurrent batch and waits for each claimed handler. Useful for tests and supervised callers. */
  public async runOnce(signal: AbortSignal): Promise<number> {
    if (signal.aborted) return 0;
    let claimed: readonly ClaimedWorkerTask[];
    try {
      claimed = await this.options.queue.claim(this.now(), this.options.leaseMs, this.taskTypes, this.options.concurrency);
    } catch {
      this.logger.error("BACKGROUND_WORKER_CLAIM_FAILED");
      return 0;
    }
    if (signal.aborted) return 0;
    await Promise.all(claimed.map((task) => this.execute(task, signal)));
    return claimed.length;
  }

  /** Runs until the supplied signal aborts. Aborting interrupts polling and asks active handlers to stop. */
  public async run(signal: AbortSignal): Promise<void> {
    const active = new Set<Promise<void>>();
    while (!signal.aborted) {
      let claimedAny = false;
      while (!signal.aborted && active.size < this.options.concurrency) {
        const capacity = this.options.concurrency - active.size;
        let claimed: readonly ClaimedWorkerTask[];
        try {
          claimed = await this.options.queue.claim(this.now(), this.options.leaseMs, this.taskTypes, capacity);
        } catch {
          this.logger.error("BACKGROUND_WORKER_CLAIM_FAILED");
          break;
        }
        if (signal.aborted || claimed.length === 0) break;
        claimedAny = true;
        for (const task of claimed) {
          const work = this.execute(task, signal).finally(() => active.delete(work));
          active.add(work);
        }
      }
      if (signal.aborted) break;
      if (active.size === 0) {
        await sleep(this.options.pollMs, signal);
      } else if (!claimedAny) {
        await Promise.race([Promise.all(active), sleep(this.options.pollMs, signal)]);
      }
    }
    // A process shutdown cannot wait forever for a faulty handler that ignores
    // AbortSignal. Its abort listener has already stopped heartbeats, so its
    // unacknowledged lease remains RUNNING and becomes recoverable after expiry.
  }

  private async execute(claimed: ClaimedWorkerTask, parentSignal: AbortSignal): Promise<void> {
    const registration = this.registrations.get(claimed.task.taskType);
    if (registration === undefined) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;
    const stopHeartbeatTimer = (): void => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    const abort = () => {
      stopHeartbeatTimer();
      controller.abort();
    };
    parentSignal.addEventListener("abort", abort, { once: true });
    let leaseLost = false;
    let renewal: Promise<void> | undefined;
    const heartbeat = (): void => {
      if (renewal !== undefined || controller.signal.aborted) return;
      renewal = this.options.queue.renew(claimed.task.id, claimed.leaseToken, this.now(), this.options.leaseMs)
        .then(() => undefined)
        .catch(() => {
          leaseLost = true;
          controller.abort();
          this.logger.error("BACKGROUND_WORKER_LEASE_LOST");
        })
        .finally(() => { renewal = undefined; });
    };
    timer = setInterval(heartbeat, this.options.heartbeatMs);
    const stopHeartbeats = async (): Promise<void> => {
      stopHeartbeatTimer();
      const pending = renewal;
      if (pending !== undefined) await pending;
    };
    try {
      let validPayload = false;
      try { validPayload = registration.validatePayload(claimed.task.payload); } catch { validPayload = false; }
      if (!validPayload) {
        await stopHeartbeats();
        await this.ackFailure(claimed, { code: "TASK_PAYLOAD_INVALID", reason: "The registered task payload was invalid." }, undefined, controller.signal, leaseLost);
        return;
      }
      try {
        await registration.handle({ task: claimed.task, signal: controller.signal });
        await stopHeartbeats();
        if (!controller.signal.aborted && !leaseLost) await this.ackSuccess(claimed);
      } catch (error) {
        await stopHeartbeats();
        if (controller.signal.aborted || leaseLost) return;
        if (error instanceof WorkerTaskTransientError) {
          const retryAt = new Date(this.now().getTime() + this.retryDelay(claimed.task.attemptCount));
          await this.ackFailure(claimed, { code: "WORKER_TASK_RETRY", reason: "A retryable worker handler failure was recorded." }, retryAt, controller.signal, leaseLost);
        } else {
          this.logger.error("BACKGROUND_WORKER_TASK_FAILED");
          await this.ackFailure(claimed, { code: "WORKER_TASK_FAILED", reason: "A worker handler failed." }, undefined, controller.signal, leaseLost);
        }
      }
    } finally {
      await stopHeartbeats();
      parentSignal.removeEventListener("abort", abort);
    }
  }

  private async ackSuccess(claimed: ClaimedWorkerTask): Promise<void> {
    try { await this.options.queue.succeed(claimed.task.id, claimed.leaseToken, this.now()); }
    catch { this.logger.error("BACKGROUND_WORKER_ACK_FAILED"); }
  }

  private async ackFailure(
    claimed: ClaimedWorkerTask,
    failure: Readonly<{ code: string; reason: string }>,
    retryAt: Date | undefined,
    signal: AbortSignal,
    leaseLost: boolean,
  ): Promise<void> {
    if (signal.aborted || leaseLost) return;
    try { await this.options.queue.fail(claimed.task.id, claimed.leaseToken, failure, this.now(), retryAt); }
    catch { this.logger.error("BACKGROUND_WORKER_ACK_FAILED"); }
  }

  private retryDelay(attemptCount: number): number {
    const multiplier = 2 ** Math.min(Math.max(0, attemptCount - 1), 20);
    return Math.min(this.retryMaxMs, this.retryBaseMs * multiplier);
  }

  private now(): Date {
    const value = this.clock();
    if (!Number.isFinite(value.getTime())) fail("WORKER_CLOCK_INVALID");
    return value;
  }
}
