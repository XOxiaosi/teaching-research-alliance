import { randomUUID } from "node:crypto";
import type { PostgresClient, PostgresPool } from "./postgres-ledger-repository.js";

export type BackgroundTaskStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
export type BackgroundTaskPayload = null | boolean | number | string | readonly BackgroundTaskPayload[] | { readonly [key: string]: BackgroundTaskPayload };
export type BackgroundTask = Readonly<{
  id: string;
  taskType: string;
  idempotencyKey: string;
  payload: BackgroundTaskPayload;
  status: BackgroundTaskStatus;
  attemptCount: number;
  maxAttempts: number;
  availableAt: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  lastFailureCode?: string;
  lastFailureReason?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}>;
export type ClaimedBackgroundTask = Readonly<{
  task: BackgroundTask;
  leaseToken: string;
  leaseExpiresAt: string;
}>;
export type EnqueueBackgroundTask = Readonly<{
  taskType: string;
  idempotencyKey: string;
  payload?: BackgroundTaskPayload;
  maxAttempts?: number;
  availableAt?: Date;
}>;
export type BackgroundTaskFailure = Readonly<{ code: string; reason: string }>;

type TaskRow = Readonly<{
  id: string; task_type: string; idempotency_key: string; payload: BackgroundTaskPayload; status: BackgroundTaskStatus;
  attempt_count: number; max_attempts: number; available_at: string; lease_token: string | null; lease_expires_at: string | null;
  last_failure_code: string | null; last_failure_reason: string | null; completed_at: string | null; created_at: string; updated_at: string;
}>;

const TYPE = /^[A-Z][A-Z0-9_]{0,99}$/;
const KEY = /^\S(?:.*\S)?$/;
const FAILURE = /^[A-Z][A-Z0-9_]{0,99}$/;
const fail = (code: string): never => { throw new Error(code); };
const requireRow = <Row>(row: Row | undefined, code: string): Row => row === undefined ? fail(code) : row;
const iso = (at: Date): string => { if (!Number.isFinite(at.getTime())) fail("TASK_TIME_INVALID"); return at.toISOString(); };
const requireUuid = (value: string, code: string): void => { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) fail(code); };
const validateEnqueue = (draft: EnqueueBackgroundTask): void => {
  if (!TYPE.test(draft.taskType)) fail("TASK_TYPE_INVALID");
  if (!KEY.test(draft.idempotencyKey) || draft.idempotencyKey.length > 200) fail("TASK_IDEMPOTENCY_KEY_INVALID");
  if (draft.maxAttempts !== undefined && (!Number.isSafeInteger(draft.maxAttempts) || draft.maxAttempts < 1 || draft.maxAttempts > 20)) fail("TASK_MAX_ATTEMPTS_INVALID");
};
const validateFailure = (failure: BackgroundTaskFailure): void => {
  if (!FAILURE.test(failure.code)) fail("TASK_FAILURE_CODE_INVALID");
  if (!KEY.test(failure.reason) || failure.reason.length > 1000) fail("TASK_FAILURE_REASON_INVALID");
};
const map = (row: TaskRow): BackgroundTask => ({
  id: row.id, taskType: row.task_type, idempotencyKey: row.idempotency_key, payload: row.payload, status: row.status,
  attemptCount: row.attempt_count, maxAttempts: row.max_attempts, availableAt: row.available_at, createdAt: row.created_at, updatedAt: row.updated_at,
  ...(row.lease_token === null ? {} : { leaseToken: row.lease_token }), ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
  ...(row.last_failure_code === null ? {} : { lastFailureCode: row.last_failure_code }), ...(row.last_failure_reason === null ? {} : { lastFailureReason: row.last_failure_reason }),
  ...(row.completed_at === null ? {} : { completedAt: row.completed_at })
});

/** Durable internal queue: business processors receive a leased task, never an end-user session or role context. */
export class PostgresBackgroundTaskQueueService {
  public constructor(private readonly pool: PostgresPool) {}

  public async enqueue(draft: EnqueueBackgroundTask, at: Date): Promise<BackgroundTask> {
    validateEnqueue(draft); const now = iso(at); const availableAt = iso(draft.availableAt ?? at); const payload = draft.payload ?? {};
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<TaskRow>(
        `INSERT INTO background_task(task_type,idempotency_key,payload,status,max_attempts,available_at,created_at,updated_at)
         VALUES($1,$2,$3::jsonb,'PENDING',$4,$5::timestamptz,$6::timestamptz,$6::timestamptz)
         ON CONFLICT(task_type,idempotency_key) DO NOTHING
         RETURNING ${taskProjection}`,
        [draft.taskType, draft.idempotencyKey, JSON.stringify(payload), draft.maxAttempts ?? 5, availableAt, now]
      );
      if (inserted.rows[0] !== undefined) { await client.query("COMMIT"); return map(inserted.rows[0]); }
      const existing = await client.query<TaskRow & Readonly<{ same_payload: boolean }>>(
        `SELECT ${taskProjection},payload=$3::jsonb AS same_payload FROM background_task WHERE task_type=$1 AND idempotency_key=$2 FOR SHARE`,
        [draft.taskType, draft.idempotencyKey, JSON.stringify(payload)]
      );
      const row = requireRow(existing.rows[0], "TASK_ENQUEUE_CONFLICT_READ_FAILED");
      if (!row.same_payload || row.max_attempts !== (draft.maxAttempts ?? 5)) fail("TASK_IDEMPOTENCY_CONFLICT");
      await client.query("COMMIT"); return map(row);
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { await client.release(); }
  }

  /** Claims distinct due tasks. Expired leases become immutable failed attempts before a fresh lease is issued. */
  public async claim(at: Date, leaseMs: number, limit = 1): Promise<readonly ClaimedBackgroundTask[]> {
    const now = iso(at);
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3_600_000) fail("TASK_LEASE_DURATION_INVALID");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail("TASK_CLAIM_LIMIT_INVALID");
    const leaseExpiresAt = new Date(at.getTime() + leaseMs).toISOString();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.failExpiredAttemptsAtLimit(client, now);
      const candidates = await client.query<Pick<TaskRow, "id" | "status" | "attempt_count">>(
        `SELECT id::text AS id,status,attempt_count FROM background_task
          WHERE (status='PENDING' AND available_at <= $1::timestamptz)
             OR (status='RUNNING' AND lease_expires_at <= $1::timestamptz AND attempt_count < max_attempts)
          ORDER BY available_at,created_at,id LIMIT $2 FOR UPDATE SKIP LOCKED`, [now, limit]
      );
      const claimed: ClaimedBackgroundTask[] = [];
      for (const candidate of candidates.rows) {
        if (candidate.status === "RUNNING") await client.query(
          `UPDATE background_task_attempt SET outcome='LEASE_EXPIRED',finished_at=$2::timestamptz,failure_code='LEASE_EXPIRED',failure_reason='Worker lease expired before a result was recorded.'
            WHERE task_id=$1::uuid AND outcome='RUNNING'`, [candidate.id, now]
        );
        const token = randomUUID();
        const updated = await client.query<TaskRow>(
          `UPDATE background_task SET status='RUNNING',attempt_count=attempt_count+1,lease_token=$2::uuid,lease_expires_at=$3::timestamptz,updated_at=$4::timestamptz
            WHERE id=$1::uuid RETURNING ${taskProjection}`,
          [candidate.id, token, leaseExpiresAt, now]
        );
        const row = requireRow(updated.rows[0], "TASK_CLAIM_UPDATE_FAILED");
        await client.query(
          `INSERT INTO background_task_attempt(task_id,attempt_no,lease_token,claimed_at,lease_expires_at,outcome)
           VALUES($1::uuid,$2,$3::uuid,$4::timestamptz,$5::timestamptz,'RUNNING')`,
          [row.id, row.attempt_count, token, now, leaseExpiresAt]
        );
        claimed.push({ task: map(row), leaseToken: token, leaseExpiresAt });
      }
      await client.query("COMMIT"); return claimed;
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { await client.release(); }
  }

  public async succeed(taskId: string, leaseToken: string, at: Date): Promise<BackgroundTask> {
    requireUuid(taskId, "TASK_ID_INVALID"); requireUuid(leaseToken, "TASK_LEASE_TOKEN_INVALID"); const now = iso(at);
    return this.finish(taskId, leaseToken, now, undefined);
  }

  /** A worker may schedule a bounded retry. Without retryAt the task remains terminally failed. */
  public async fail(taskId: string, leaseToken: string, failure: BackgroundTaskFailure, at: Date, retryAt?: Date): Promise<BackgroundTask> {
    requireUuid(taskId, "TASK_ID_INVALID"); requireUuid(leaseToken, "TASK_LEASE_TOKEN_INVALID"); validateFailure(failure); const now = iso(at); const retry = retryAt === undefined ? undefined : iso(retryAt);
    if (retry !== undefined && retry < now) fail("TASK_RETRY_TIME_INVALID");
    return this.finish(taskId, leaseToken, now, failure, retry);
  }

  /** Operators may requeue a non-exhausted terminal failure; completed tasks are immutable. */
  public async retry(taskId: string, at: Date, availableAt = at): Promise<BackgroundTask> {
    requireUuid(taskId, "TASK_ID_INVALID"); const now = iso(at); const available = iso(availableAt);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<TaskRow>(
        `UPDATE background_task SET status='PENDING',available_at=$2::timestamptz,updated_at=$3::timestamptz
          WHERE id=$1::uuid AND status='FAILED' AND attempt_count < max_attempts RETURNING ${taskProjection}`,
        [taskId, available, now]
      );
      const row = requireRow(updated.rows[0], "TASK_RETRY_NOT_ALLOWED");
      await client.query("COMMIT"); return map(row);
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { await client.release(); }
  }

  public async get(taskId: string): Promise<BackgroundTask | undefined> {
    requireUuid(taskId, "TASK_ID_INVALID"); const client = await this.pool.connect();
    try { const result = await client.query<TaskRow>(`SELECT ${taskProjection} FROM background_task WHERE id=$1::uuid`, [taskId]); return result.rows[0] === undefined ? undefined : map(result.rows[0]); }
    finally { await client.release(); }
  }

  private async finish(taskId: string, leaseToken: string, now: string, failure?: BackgroundTaskFailure, retryAt?: string): Promise<BackgroundTask> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<Pick<TaskRow, "id" | "attempt_count" | "max_attempts">>(
        `SELECT id::text AS id,attempt_count,max_attempts FROM background_task WHERE id=$1::uuid AND status='RUNNING' AND lease_token=$2::uuid AND lease_expires_at > $3::timestamptz FOR UPDATE`, [taskId, leaseToken, now]
      );
      const task = locked.rows[0];
      if (task === undefined) {
        const finished = await client.query<{ outcome: "SUCCEEDED" | "FAILED" | "LEASE_EXPIRED"; failure_code: string | null; failure_reason: string | null }>(
          `SELECT outcome,failure_code,failure_reason FROM background_task_attempt
            WHERE task_id=$1::uuid AND lease_token=$2::uuid AND outcome<>'RUNNING' FOR SHARE`,
          [taskId, leaseToken]
        );
        const attempt = requireRow(finished.rows[0], "TASK_LEASE_LOST");
        if (attempt.outcome === "LEASE_EXPIRED") fail("TASK_LEASE_LOST");
        const sameResult = failure === undefined
          ? attempt.outcome === "SUCCEEDED"
          : attempt.outcome === "FAILED" && attempt.failure_code === failure.code && attempt.failure_reason === failure.reason;
        if (!sameResult) fail("TASK_RESULT_CONFLICT");
        const existing = await client.query<TaskRow>(
          `SELECT ${taskProjection} FROM background_task WHERE id=$1::uuid FOR SHARE`, [taskId]
        );
        const row = requireRow(existing.rows[0], "TASK_LEASE_LOST");
        await client.query("COMMIT");
        return map(row);
      }
      if (failure === undefined) {
        await client.query(`UPDATE background_task_attempt SET outcome='SUCCEEDED',finished_at=$3::timestamptz WHERE task_id=$1::uuid AND lease_token=$2::uuid AND outcome='RUNNING'`, [taskId, leaseToken, now]);
        const completed = await client.query<TaskRow>(
          `UPDATE background_task SET status='SUCCEEDED',lease_token=NULL,lease_expires_at=NULL,last_failure_code=NULL,last_failure_reason=NULL,completed_at=$3::timestamptz,updated_at=$3::timestamptz
            WHERE id=$1::uuid AND lease_token=$2::uuid RETURNING ${taskProjection}`, [taskId, leaseToken, now]
        );
        const row = requireRow(completed.rows[0], "TASK_LEASE_LOST"); await client.query("COMMIT"); return map(row);
      }
      await client.query(
        `UPDATE background_task_attempt SET outcome='FAILED',finished_at=$4::timestamptz,failure_code=$3,failure_reason=$5
          WHERE task_id=$1::uuid AND lease_token=$2::uuid AND outcome='RUNNING'`, [taskId, leaseToken, failure.code, now, failure.reason]
      );
      const pending = retryAt !== undefined && task.attempt_count < task.max_attempts;
      const result = await client.query<TaskRow>(
        `UPDATE background_task SET status=$3,lease_token=NULL,lease_expires_at=NULL,available_at=CASE WHEN $3='PENDING' THEN $4::timestamptz ELSE available_at END,last_failure_code=$5,last_failure_reason=$6,updated_at=$7::timestamptz
          WHERE id=$1::uuid AND lease_token=$2::uuid RETURNING ${taskProjection}`,
        [taskId, leaseToken, pending ? "PENDING" : "FAILED", retryAt ?? now, failure.code, failure.reason, now]
      );
      const row = requireRow(result.rows[0], "TASK_LEASE_LOST"); await client.query("COMMIT"); return map(row);
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { await client.release(); }
  }

  private async failExpiredAttemptsAtLimit(client: PostgresClient, now: string): Promise<void> {
    const expired = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM background_task WHERE status='RUNNING' AND lease_expires_at <= $1::timestamptz AND attempt_count >= max_attempts
        ORDER BY lease_expires_at,id FOR UPDATE SKIP LOCKED`, [now]
    );
    for (const row of expired.rows) {
      await client.query(`UPDATE background_task_attempt SET outcome='LEASE_EXPIRED',finished_at=$2::timestamptz,failure_code='LEASE_EXPIRED_RETRY_EXHAUSTED',failure_reason='Worker lease expired after the final permitted attempt.' WHERE task_id=$1::uuid AND outcome='RUNNING'`, [row.id, now]);
      await client.query(`UPDATE background_task SET status='FAILED',lease_token=NULL,lease_expires_at=NULL,last_failure_code='LEASE_EXPIRED_RETRY_EXHAUSTED',last_failure_reason='Worker lease expired after the final permitted attempt.',updated_at=$2::timestamptz WHERE id=$1::uuid`, [row.id, now]);
    }
  }
}

const taskProjection = `id::text AS id,task_type,idempotency_key,payload,status,attempt_count,max_attempts,available_at::text AS available_at,lease_token::text AS lease_token,lease_expires_at::text AS lease_expires_at,last_failure_code,last_failure_reason,completed_at::text AS completed_at,created_at::text AS created_at,updated_at::text AS updated_at`;
