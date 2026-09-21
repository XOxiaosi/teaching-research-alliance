import { createHash } from "node:crypto";
import type { RoleContext } from "@teaching-research-alliance/contracts";
import type { PostgresClient, PostgresPool } from "./postgres-ledger-repository.js";

export type ReferralLifecycleDraft = Readonly<{ expectedVersion: number }>;
export type ReferralLifecycleResult = Readonly<{
  referralId: string;
  status: "ARCHIVED" | "REACTIVATED";
  version: number;
  unacceptedExpiresAt: string | null;
  replay: boolean;
}>;

type LifecycleOperation = "ARCHIVE" | "REACTIVATE";
type ReferralRow = Readonly<{
  id: string;
  referrer_person_id: string;
  status: "PENDING" | "ACCEPTED" | "ARCHIVED" | "REACTIVATED";
  version: string;
  unaccepted_expires_at: string | null;
}>;
type IdempotencyRow = Readonly<{
  request_hash: string;
  referral_case_id: string;
  result_status: "ARCHIVED" | "REACTIVATED";
  result_referral_version: string;
  result_unaccepted_expires_at: string | null;
}>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedSubjects = ["TEACHING_TEACHER", "ACADEMIC_PLANNER", "PLANNING_MENTOR"] as const;

const assertContext = (context: RoleContext): void => {
  if (!allowedSubjects.includes(context.subject as (typeof allowedSubjects)[number])) throw new Error("FORBIDDEN_SCOPE");
};

const assertInput = (referralId: string, draft: ReferralLifecycleDraft, key: string, at: Date): void => {
  if (!UUID_PATTERN.test(referralId)
    || !Number.isSafeInteger(draft.expectedVersion)
    || draft.expectedVersion < 1
    || !key.trim()
    || key.length > 200
    || !Number.isFinite(at.getTime())) throw new Error("INVALID_INPUT");
};

const requestHash = (operation: LifecycleOperation, referralId: string, draft: ReferralLifecycleDraft): string =>
  createHash("sha256")
    .update(JSON.stringify({ operation, referralId, expectedVersion: draft.expectedVersion }))
    .digest("hex");

const one = <Row>(rows: readonly Row[], errorCode: string): Row => {
  if (rows.length !== 1) throw new Error(errorCode);
  return rows[0]!;
};

const dateText = (value: string | null): string | null => value === null ? null : new Date(value).toISOString();

const mapResult = (
  referralId: string,
  status: "ARCHIVED" | "REACTIVATED",
  version: string,
  expiresAt: string | null,
  replay: boolean
): ReferralLifecycleResult => ({
  referralId,
  status,
  version: Number(version),
  unacceptedExpiresAt: dateText(expiresAt),
  replay
});

export class PostgresReferralLifecycleService {
  public constructor(private readonly pool: PostgresPool) {}

  public async archive(
    context: RoleContext,
    referralId: string,
    draft: ReferralLifecycleDraft,
    idempotencyKey: string,
    at: Date
  ): Promise<ReferralLifecycleResult> {
    return this.change("ARCHIVE", context, referralId, draft, idempotencyKey, at);
  }

  public async reactivate(
    context: RoleContext,
    referralId: string,
    draft: ReferralLifecycleDraft,
    idempotencyKey: string,
    at: Date
  ): Promise<ReferralLifecycleResult> {
    return this.change("REACTIVATE", context, referralId, draft, idempotencyKey, at);
  }

  private async findReplay(
    client: PostgresClient,
    actorPersonId: string,
    key: string,
    hash: string
  ): Promise<ReferralLifecycleResult | undefined> {
    const previous = await client.query<IdempotencyRow>(
      `SELECT request_hash,
              referral_case_id::text AS referral_case_id,
              result_status,
              result_referral_version::text AS result_referral_version,
              to_char(result_unaccepted_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS result_unaccepted_expires_at
         FROM referral_lifecycle_idempotency
        WHERE actor_person_id = $1::uuid
          AND idempotency_key = $2
        FOR SHARE`,
      [actorPersonId, key]
    );
    const row = previous.rows[0];
    if (row === undefined) return undefined;
    if (row.request_hash !== hash) throw new Error("IDEMPOTENCY_REPLAY");
    return mapResult(row.referral_case_id, row.result_status, row.result_referral_version, row.result_unaccepted_expires_at, true);
  }

  private async change(
    operation: LifecycleOperation,
    context: RoleContext,
    referralId: string,
    draft: ReferralLifecycleDraft,
    idempotencyKey: string,
    at: Date
  ): Promise<ReferralLifecycleResult> {
    assertContext(context);
    assertInput(referralId, draft, idempotencyKey, at);
    const hash = requestHash(operation, referralId, draft);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `referral-lifecycle:${context.personId}:${idempotencyKey}`
      ]);
      const replay = await this.findReplay(client, context.personId, idempotencyKey, hash);
      if (replay !== undefined) {
        await client.query("COMMIT");
        return replay;
      }
      const referral = one((await client.query<ReferralRow>(
        `SELECT id::text AS id,
                referrer_person_id::text AS referrer_person_id,
                status,
                version::text AS version,
                to_char(unaccepted_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS unaccepted_expires_at
           FROM referral_case
          WHERE id = $1::uuid
          FOR UPDATE`,
        [referralId]
      )).rows, "REFERRAL_NOT_FOUND");
      if (referral.referrer_person_id !== context.personId) throw new Error("FORBIDDEN_SCOPE");
      if (Number(referral.version) !== draft.expectedVersion) throw new Error("VERSION_CONFLICT");
      const archive = operation === "ARCHIVE";
      const validState = archive
        ? ["PENDING", "REACTIVATED", "ACCEPTED"].includes(referral.status)
        : referral.status === "ARCHIVED";
      if (!validState) throw new Error("REFERRAL_STATE_CONFLICT");
      const resultStatus = archive ? "ARCHIVED" : "REACTIVATED";
      const resultExpiresAt = archive
        ? referral.unaccepted_expires_at
        : new Date(at.getTime() + 21 * 24 * 60 * 60 * 1000).toISOString();
      const updated = one((await client.query<{ version: string; unaccepted_expires_at: string | null }>(
        `UPDATE referral_case
            SET status = $2,
                unaccepted_expires_at = $3::timestamptz,
                version = version + 1,
                updated_at = $4::timestamptz
          WHERE id = $1::uuid
        RETURNING version::text AS version,
                  to_char(unaccepted_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS unaccepted_expires_at`,
        [referralId, resultStatus, resultExpiresAt, at.toISOString()]
      )).rows, "REFERRAL_STATE_CONFLICT");
      await client.query(
        `INSERT INTO referral_case_event(
           referral_case_id, event_type, actor_person_id, actor_type, reason, result_referral_version, created_at
         ) VALUES ($1::uuid, $2, $3::uuid, 'PERSON', $4, $5::bigint, $6::timestamptz)`,
        [referralId, resultStatus, context.personId, archive ? "REFERRER_ARCHIVED" : "REFERRER_REACTIVATED", updated.version, at.toISOString()]
      );
      await client.query(
        `INSERT INTO referral_lifecycle_idempotency(
           actor_person_id, idempotency_key, operation, request_hash, referral_case_id,
           result_status, result_referral_version, result_unaccepted_expires_at, created_at
         ) VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6, $7::bigint, $8::timestamptz, $9::timestamptz)`,
        [context.personId, idempotencyKey, operation, hash, referralId, resultStatus, updated.version, updated.unaccepted_expires_at, at.toISOString()]
      );
      await client.query("COMMIT");
      return mapResult(referralId, resultStatus, updated.version, updated.unaccepted_expires_at, false);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.release();
    }
  }
}
