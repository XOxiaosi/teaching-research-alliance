import { createHash } from "node:crypto";
import {
  assertValidWeeklyFeeDraft,
  type WeeklyFeeDraft
} from "@teaching-research-alliance/domain";
import type { PostgresClient, PostgresPool } from "./postgres-ledger-repository.js";

export type PersistedReferralStatus = "PENDING" | "ACCEPTED" | "ARCHIVED" | "REACTIVATED";

export type PersistedReferral = Readonly<{
  id: string;
  referrerPersonId: string;
  receiverPersonId: string;
  referrerIdentity: "TEACHING_TEACHER" | "ACADEMIC_PLANNER";
  status: PersistedReferralStatus;
  version: number;
}>;

export type PersistedWeeklyFeeRecord = Readonly<WeeklyFeeDraft & {
  id: string;
  entryKey: string;
  version: number;
  recordedByPersonId: string;
  idempotencyKey: string;
  venueOwnerPersonId: string;
  isSelfUseSnapshot: boolean;
  sourceCaseVersion: number;
}>;

type ReferralRow = Readonly<{
  id: string;
  referrer_person_id: string;
  receiver_person_id: string;
  referrer_identity: "TEACHING_TEACHER" | "ACADEMIC_PLANNER";
  status: PersistedReferralStatus;
  version: string;
}>;

type WeekRow = Readonly<{ settlement_month: string; status: "OPEN" | "LOCKED" }>;
type VenueRow = Readonly<{ id: string; owner_person_id: string; status: "ACTIVE" | "INACTIVE" }>;

type FeeRow = Readonly<{
  id: string;
  referral_case_id: string;
  teaching_week_id: string;
  settlement_month: string;
  gross_amount_cents: string;
  venue_id: string;
  venue_owner_person_id: string;
  is_self_use_snapshot: boolean;
  source_case_version: string;
  version: string;
  created_by: string;
  idempotency_key: string | null;
}>;

type IdempotencyRow = Readonly<{
  idempotency_key: string;
  request_hash: string;
  actor_person_id: string;
  referral_case_id: string;
  teaching_week_id: string;
  weekly_fee_entry_id: string;
  version: string;
}>;

const requestHash = (actorPersonId: string, draft: WeeklyFeeDraft): string => createHash("sha256")
  .update(JSON.stringify({
    actorPersonId,
    referralCaseId: draft.referralCaseId,
    teachingWeekId: draft.teachingWeekId,
    venueId: draft.venueId,
    settlementMonth: draft.settlementMonth,
    expectedVersion: draft.expectedVersion,
    grossAmountCents: draft.grossAmountCents.toString()
  }))
  .digest("hex");

const mapReferral = (row: ReferralRow): PersistedReferral => ({
  id: row.id,
  referrerPersonId: row.referrer_person_id,
  receiverPersonId: row.receiver_person_id,
  referrerIdentity: row.referrer_identity,
  status: row.status,
  version: Number(row.version)
});

const mapFee = (row: FeeRow): PersistedWeeklyFeeRecord => ({
  id: row.id,
  referralCaseId: row.referral_case_id,
  teachingWeekId: row.teaching_week_id,
  venueId: row.venue_id,
  settlementMonth: row.settlement_month,
  grossAmountCents: BigInt(row.gross_amount_cents),
  entryKey: `${row.referral_case_id}:${row.teaching_week_id}`,
  version: Number(row.version),
  recordedByPersonId: row.created_by,
  idempotencyKey: row.idempotency_key ?? "",
  venueOwnerPersonId: row.venue_owner_person_id,
  isSelfUseSnapshot: row.is_self_use_snapshot,
  sourceCaseVersion: Number(row.source_case_version)
});

const feeSelect = `
  SELECT entry.id::text AS id,
         entry.referral_case_id::text AS referral_case_id,
         entry.teaching_week_id::text AS teaching_week_id,
         entry.settlement_month::text AS settlement_month,
         entry.gross_amount_cents::text AS gross_amount_cents,
         entry.venue_id::text AS venue_id,
         entry.venue_owner_person_id::text AS venue_owner_person_id,
         entry.is_self_use_snapshot,
         entry.source_case_version::text AS source_case_version,
         entry.version::text AS version,
         entry.created_by::text AS created_by,
         idem.idempotency_key
    FROM weekly_fee_entry entry
    LEFT JOIN LATERAL (
      SELECT idempotency_key
        FROM weekly_fee_idempotency
       WHERE weekly_fee_entry_id = entry.id AND version = entry.version
       ORDER BY created_at DESC
       LIMIT 1
    ) idem ON true`;

const historySelect = `
  SELECT version_entry.weekly_fee_entry_id::text AS id,
         version_entry.referral_case_id::text AS referral_case_id,
         version_entry.teaching_week_id::text AS teaching_week_id,
         version_entry.settlement_month::text AS settlement_month,
         version_entry.gross_amount_cents::text AS gross_amount_cents,
         version_entry.venue_id::text AS venue_id,
         version_entry.venue_owner_person_id::text AS venue_owner_person_id,
         version_entry.is_self_use_snapshot,
         version_entry.source_case_version::text AS source_case_version,
         version_entry.version::text AS version,
         version_entry.recorded_by::text AS created_by,
         idem.idempotency_key
    FROM weekly_fee_entry_version version_entry
    LEFT JOIN weekly_fee_idempotency idem
      ON idem.weekly_fee_entry_id = version_entry.weekly_fee_entry_id
     AND idem.version = version_entry.version`;

export class PostgresWeeklyFeeRepository {
  public constructor(private readonly pool: PostgresPool) {}

  private async transaction<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.release();
    }
  }

  public async findReferral(referralCaseId: string): Promise<PersistedReferral | undefined> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<ReferralRow>(
        `SELECT id::text AS id,
                referrer_person_id::text AS referrer_person_id,
                receiver_person_id::text AS receiver_person_id,
                referrer_identity,
                status,
                version::text AS version
           FROM referral_case
          WHERE id = $1::uuid`,
        [referralCaseId]
      );
      const row = result.rows[0];
      return row === undefined ? undefined : mapReferral(row);
    } finally {
      await client.release();
    }
  }

  public async acceptReferral(referralCaseId: string, receiverPersonId: string): Promise<PersistedReferral> {
    return this.transaction(async (client) => {
      const result = await client.query<ReferralRow>(
        `SELECT id::text AS id,
                referrer_person_id::text AS referrer_person_id,
                receiver_person_id::text AS receiver_person_id,
                referrer_identity,
                status,
                version::text AS version
           FROM referral_case
          WHERE id = $1::uuid
          FOR UPDATE`,
        [referralCaseId]
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("REFERRAL_NOT_FOUND");
      if (row.receiver_person_id !== receiverPersonId) throw new Error("FORBIDDEN_SCOPE");
      if (row.status === "ACCEPTED") return mapReferral(row);
      if (row.status !== "PENDING" && row.status !== "REACTIVATED") throw new Error("REFERRAL_NOT_ACCEPTABLE");
      const updated = await client.query<ReferralRow>(
        `UPDATE referral_case
            SET status = 'ACCEPTED', version = version + 1, updated_at = now()
          WHERE id = $1::uuid
        RETURNING id::text AS id,
                  referrer_person_id::text AS referrer_person_id,
                  receiver_person_id::text AS receiver_person_id,
                  referrer_identity,
                  status,
                  version::text AS version`,
        [referralCaseId]
      );
      await client.query(
        `INSERT INTO referral_case_event (referral_case_id, event_type, actor_person_id)
         VALUES ($1::uuid, 'ACCEPTED', $2::uuid)`,
        [referralCaseId, receiverPersonId]
      );
      const accepted = updated.rows[0];
      if (accepted === undefined) throw new Error("REFERRAL_UPDATE_FAILED");
      return mapReferral(accepted);
    });
  }

  /** Uses the caller's transaction so fee and settlement can commit or roll back together. */
  public async recordWeeklyFeeInTransaction(
    client: PostgresClient,
    receiverPersonId: string,
    draft: WeeklyFeeDraft,
    idempotencyKey: string
  ): Promise<PersistedWeeklyFeeRecord> {
    assertValidWeeklyFeeDraft(draft);
    if (idempotencyKey.trim() === "") throw new Error("INVALID_INPUT:IDEMPOTENCY_KEY_REQUIRED");
    const hash = requestHash(receiverPersonId, draft);
    // Lock absent keys as well as existing requests; row locks alone cannot do this.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`weekly-request:${idempotencyKey}`]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`weekly-entry:${draft.referralCaseId}:${draft.teachingWeekId}`]);
    const replay = await client.query<IdempotencyRow>(
      `SELECT idempotency_key,
              request_hash,
              actor_person_id::text AS actor_person_id,
              referral_case_id::text AS referral_case_id,
              teaching_week_id::text AS teaching_week_id,
              weekly_fee_entry_id::text AS weekly_fee_entry_id,
              version::text AS version
         FROM weekly_fee_idempotency
        WHERE idempotency_key = $1
        FOR UPDATE`,
      [idempotencyKey]
    );
    const replayRow = replay.rows[0];
    if (replayRow !== undefined) {
      if (replayRow.request_hash !== hash) throw new Error("IDEMPOTENCY_REPLAY");
      const existing = await client.query<FeeRow>(
        `${historySelect}
          WHERE version_entry.weekly_fee_entry_id = $1::uuid AND version_entry.version = $2::bigint`,
        [replayRow.weekly_fee_entry_id, replayRow.version]
      );
      const existingRow = existing.rows[0];
      if (existingRow === undefined) throw new Error("WEEKLY_FEE_IDEMPOTENCY_CORRUPT");
      return mapFee(existingRow);
    }

    const referralResult = await client.query<ReferralRow>(
      `SELECT id::text AS id,
              referrer_person_id::text AS referrer_person_id,
              receiver_person_id::text AS receiver_person_id,
              referrer_identity,
              status,
              version::text AS version
         FROM referral_case
        WHERE id = $1::uuid
        FOR SHARE`,
      [draft.referralCaseId]
    );
    const referral = referralResult.rows[0];
    if (referral === undefined) throw new Error("REFERRAL_NOT_FOUND");
    if (referral.receiver_person_id !== receiverPersonId) {
      throw new Error("FORBIDDEN_SCOPE");
    }

    const weekResult = await client.query<WeekRow>(
      `SELECT settlement_month::text AS settlement_month, status
         FROM teaching_week
        WHERE id = $1::uuid
        FOR SHARE`,
      [draft.teachingWeekId]
    );
    const week = weekResult.rows[0];
    if (week === undefined) throw new Error("TEACHING_WEEK_NOT_FOUND");
    if (week.status !== "OPEN") throw new Error("PERIOD_LOCKED");
    if (week.settlement_month !== draft.settlementMonth) throw new Error("PERIOD_MONTH_MISMATCH");

    const venueResult = await client.query<VenueRow>(
      `SELECT id::text AS id, owner_person_id::text AS owner_person_id, status
         FROM venue
        WHERE id = $1::uuid
        FOR SHARE`,
      [draft.venueId]
    );
    const venue = venueResult.rows[0];
    if (venue === undefined || venue.status !== "ACTIVE") throw new Error("VENUE_NOT_ACTIVE");

    const current = await client.query<FeeRow>(
      `${feeSelect}
        WHERE entry.referral_case_id = $1::uuid
          AND entry.teaching_week_id = $2::uuid
        FOR UPDATE OF entry`,
      [draft.referralCaseId, draft.teachingWeekId]
    );
    const previous = current.rows[0];
    if (previous !== undefined) {
      const refunded = await client.query<{ refunded: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM weekly_fee_refund_effect
            WHERE weekly_fee_entry_id = $1::uuid
         ) AS refunded`,
        [previous.id]
      );
      if (refunded.rows[0]?.refunded === true) throw new Error("WEEKLY_FEE_REFUNDED");
    }
    if (referral.status === "ARCHIVED" && previous === undefined) throw new Error("REFERRAL_ARCHIVED");
    if (draft.expectedVersion !== undefined && draft.expectedVersion !== Number(previous?.version ?? 0)) {
      throw new Error("VERSION_CONFLICT");
    }
    const nextVersion = previous === undefined ? 1 : Number(previous.version) + 1;
    let entryId: string;
    if (previous === undefined) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO weekly_fee_entry (
           referral_case_id, teaching_week_id, settlement_month, gross_amount_cents,
           venue_id, venue_owner_person_id, is_self_use_snapshot, source_case_version,
           version, created_by
         ) VALUES ($1::uuid, $2::uuid, $3::date, $4::bigint, $5::uuid, $6::uuid, $7::boolean, $8::bigint, $9::bigint, $10::uuid)
         RETURNING id::text AS id`,
        [draft.referralCaseId, draft.teachingWeekId, draft.settlementMonth, draft.grossAmountCents.toString(), draft.venueId, venue.owner_person_id, venue.owner_person_id === receiverPersonId, referral.version, nextVersion, receiverPersonId]
      );
      const insertedRow = inserted.rows[0];
      if (insertedRow === undefined) throw new Error("WEEKLY_FEE_INSERT_FAILED");
      entryId = insertedRow.id;
    } else {
      entryId = previous.id;
      await client.query(
        `UPDATE weekly_fee_entry
            SET settlement_month = $3::date,
                gross_amount_cents = $4::bigint,
                venue_id = $5::uuid,
                venue_owner_person_id = $6::uuid,
                is_self_use_snapshot = $7::boolean,
                source_case_version = $8::bigint,
                version = $9::bigint,
                created_by = $10::uuid,
                updated_at = now()
          WHERE referral_case_id = $1::uuid AND teaching_week_id = $2::uuid`,
        [draft.referralCaseId, draft.teachingWeekId, draft.settlementMonth, draft.grossAmountCents.toString(), draft.venueId, venue.owner_person_id, venue.owner_person_id === receiverPersonId, referral.version, nextVersion, receiverPersonId]
      );
    }
    await client.query(
      `INSERT INTO weekly_fee_event (weekly_fee_entry_id, event_type, actor_person_id)
       VALUES ($1::uuid, $2, $3::uuid)`,
      [entryId, previous === undefined ? "CREATED" : "CORRECTED", receiverPersonId]
    );
    await client.query(
      `INSERT INTO weekly_fee_idempotency (
         idempotency_key, request_hash, actor_person_id, referral_case_id,
         teaching_week_id, weekly_fee_entry_id, version
       ) VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::bigint)`,
      [idempotencyKey, hash, receiverPersonId, draft.referralCaseId, draft.teachingWeekId, entryId, nextVersion]
    );
    const saved = await client.query<FeeRow>(
      `${feeSelect}
        WHERE entry.id = $1::uuid AND entry.version = $2::bigint`,
      [entryId, nextVersion]
    );
    const savedRow = saved.rows[0];
    if (savedRow === undefined) throw new Error("WEEKLY_FEE_READBACK_FAILED");
    return mapFee(savedRow);
  }

  public async listHistory(referralCaseId: string, teachingWeekId: string): Promise<readonly PersistedWeeklyFeeRecord[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<FeeRow>(
        `${historySelect}
          WHERE version_entry.referral_case_id = $1::uuid
            AND version_entry.teaching_week_id = $2::uuid
          ORDER BY version_entry.version`,
        [referralCaseId, teachingWeekId]
      );
      return result.rows.map(mapFee);
    } finally {
      await client.release();
    }
  }
}
