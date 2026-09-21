import { createHash } from "node:crypto";
import type { RoleContext } from "@teaching-research-alliance/contracts";
import type { PostgresClient, PostgresPool } from "./postgres-ledger-repository.js";

export type ReferralAcceptanceDraft = Readonly<{
  venueId?: string;
  expectedVersion: number;
}>;

export type ReferralAcceptanceResult = Readonly<{
  referralId: string;
  version: number;
  venueId: string;
  venueOwnerPersonId: string;
  isSelfUse: boolean;
  acceptedAt: string;
  replay: boolean;
}>;

type ReferralRow = Readonly<{
  id: string;
  receiver_person_id: string;
  status: "PENDING" | "ACCEPTED" | "ARCHIVED" | "REACTIVATED";
  version: string;
  unaccepted_expires_at: string | null;
}>;

type VenueRow = Readonly<{
  id: string;
  owner_person_id: string;
  selection_source: "EXPLICIT" | "OWNER_DEFAULT";
}>;
type SnapshotRow = Readonly<{
  venue_id: string;
  venue_owner_person_id: string;
  is_self_use: boolean;
  accepted_referral_version: string;
  accepted_at: string;
}>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const assertTeacherContext = (context: RoleContext): void => {
  if (context.subject !== "TEACHING_TEACHER") throw new Error("FORBIDDEN_SCOPE");
};

const requestHash = (referralId: string, draft: ReferralAcceptanceDraft): string =>
  createHash("sha256")
    .update(JSON.stringify({ referralId, venueId: draft.venueId ?? null, expectedVersion: draft.expectedVersion }))
    .digest("hex");

const mapResult = (
  referralId: string,
  snapshot: SnapshotRow,
  replay: boolean
): ReferralAcceptanceResult => ({
  referralId,
  version: Number(snapshot.accepted_referral_version),
  venueId: snapshot.venue_id,
  venueOwnerPersonId: snapshot.venue_owner_person_id,
  isSelfUse: snapshot.is_self_use,
  acceptedAt: new Date(snapshot.accepted_at).toISOString(),
  replay
});

const one = <Row>(rows: readonly Row[], errorCode: string): Row => {
  if (rows.length !== 1) throw new Error(errorCode);
  return rows[0]!;
};

export class PostgresReferralAcceptanceService {
  public constructor(private readonly pool: PostgresPool) {}

  private async selectSnapshot(client: PostgresClient, referralId: string, version: string): Promise<SnapshotRow> {
    return one((await client.query<SnapshotRow>(
      `SELECT venue_id::text AS venue_id,
              venue_owner_person_id::text AS venue_owner_person_id,
              is_self_use,
              accepted_referral_version::text AS accepted_referral_version,
              to_char(accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS accepted_at
         FROM referral_acceptance_snapshot
        WHERE referral_case_id = $1::uuid AND accepted_referral_version=$2::bigint`,
      [referralId, version]
    )).rows, "REFERRAL_ACCEPTANCE_INVALID");
  }

  private async resolveVenue(
    client: PostgresClient,
    receiverPersonId: string,
    requestedVenueId: string | undefined
  ): Promise<VenueRow> {
    if (requestedVenueId !== undefined) {
      return one((await client.query<VenueRow>(
        `SELECT id::text AS id, owner_person_id::text AS owner_person_id, 'EXPLICIT'::text AS selection_source
           FROM venue
          WHERE id = $1::uuid AND status = 'ACTIVE'
          FOR SHARE`,
        [requestedVenueId]
      )).rows, "VENUE_NOT_FOUND");
    }
    return one((await client.query<VenueRow>(
      `SELECT id::text AS id, owner_person_id::text AS owner_person_id, 'OWNER_DEFAULT'::text AS selection_source
         FROM venue
        WHERE owner_person_id = $1::uuid
          AND status = 'ACTIVE'
          AND default_for_owner = true
        FOR SHARE`,
      [receiverPersonId]
    )).rows, "DEFAULT_VENUE_NOT_FOUND");
  }

  public async accept(
    context: RoleContext,
    referralId: string,
    draft: ReferralAcceptanceDraft,
    idempotencyKey: string,
    at: Date
  ): Promise<ReferralAcceptanceResult> {
    assertTeacherContext(context);
    if (!UUID_PATTERN.test(referralId)
      || (draft.venueId !== undefined && !UUID_PATTERN.test(draft.venueId))
      || !Number.isSafeInteger(draft.expectedVersion) || draft.expectedVersion < 1
      || !idempotencyKey.trim() || idempotencyKey.length > 200
      || !Number.isFinite(at.getTime())) throw new Error("INVALID_INPUT");

    const hash = requestHash(referralId, draft);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `referral-accept:${context.personId}:${idempotencyKey}`
      ]);

      const previous = await client.query<{ request_hash: string; referral_case_id: string; accepted_referral_version: string }>(
        `SELECT command.request_hash,
                command.referral_case_id::text AS referral_case_id,
                command.accepted_referral_version::text AS accepted_referral_version
           FROM referral_acceptance_idempotency command
          WHERE command.actor_person_id = $1::uuid
            AND command.idempotency_key = $2
          FOR SHARE`,
        [context.personId, idempotencyKey]
      );
      const previousRow = previous.rows[0];
      if (previousRow !== undefined) {
        if (previousRow.request_hash !== hash) throw new Error("IDEMPOTENCY_REPLAY");
        const snapshot = await this.selectSnapshot(client, previousRow.referral_case_id, previousRow.accepted_referral_version);
        await client.query("COMMIT");
        return mapResult(previousRow.referral_case_id, snapshot, true);
      }

      const referral = one((await client.query<ReferralRow>(
        `SELECT id::text AS id,
                receiver_person_id::text AS receiver_person_id,
                status,
                version::text AS version,
                to_char(unaccepted_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS unaccepted_expires_at
           FROM referral_case
          WHERE id = $1::uuid
          FOR UPDATE`,
        [referralId]
      )).rows, "REFERRAL_NOT_FOUND");
      if (referral.receiver_person_id !== context.personId) throw new Error("FORBIDDEN_SCOPE");
      if (referral.status === "ACCEPTED") throw new Error("REFERRAL_ALREADY_ACCEPTED");
      if ((referral.status !== "PENDING" && referral.status !== "REACTIVATED")
        || referral.unaccepted_expires_at === null
        || at.getTime() >= new Date(referral.unaccepted_expires_at).getTime()) {
        throw new Error("REFERRAL_ACCEPTANCE_INVALID");
      }
      if (Number(referral.version) !== draft.expectedVersion) throw new Error("VERSION_CONFLICT");

      const venue = await this.resolveVenue(client, context.personId, draft.venueId);
      const previousAcceptance = await client.query<{venue_id:string}>(
        `SELECT venue_id::text AS venue_id FROM referral_acceptance_snapshot
          WHERE referral_case_id=$1::uuid ORDER BY accepted_referral_version DESC LIMIT 1`,[referralId]);
      if (previousAcceptance.rows[0] && previousAcceptance.rows[0].venue_id !== venue.id) throw new Error("VENUE_CHANGE_REQUIRED");
      const venueAccount = await client.query<{ id: string }>(
        `SELECT id::text AS id
           FROM settlement_account
          WHERE owner_type = 'VENUE'
            AND owner_id = $1::uuid
            AND status = 'ACTIVE'
          FOR SHARE`,
        [venue.id]
      );
      if (venueAccount.rows.length !== 1) throw new Error("VENUE_ACCOUNT_REQUIRED");

      const conflictingFee = await client.query<{ id: string }>(
        `SELECT id::text AS id
           FROM weekly_fee_entry
          WHERE referral_case_id = $1::uuid
            AND venue_id <> $2::uuid
          LIMIT 1
          FOR SHARE`,
        [referralId, venue.id]
      );
      if (conflictingFee.rows.length !== 0) throw new Error("VENUE_CHANGE_REQUIRED");

      const isSelfUse = venue.owner_person_id === context.personId;
      const updated = one((await client.query<{ version: string }>(
        `UPDATE referral_case
            SET status = 'ACCEPTED', version = version + 1, updated_at = $2::timestamptz
          WHERE id = $1::uuid
        RETURNING version::text AS version`,
        [referralId, at.toISOString()]
      )).rows, "REFERRAL_ACCEPTANCE_INVALID");
      await client.query(
        `INSERT INTO referral_acceptance_snapshot(
           referral_case_id, venue_id, venue_owner_person_id, is_self_use, selection_source,
           accepted_referral_version, accepted_by_person_id, accepted_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::boolean, $5, $6::bigint, $7::uuid, $8::timestamptz)`,
        [referralId, venue.id, venue.owner_person_id, isSelfUse, venue.selection_source, updated.version, context.personId, at.toISOString()]
      );
      await client.query(
        `INSERT INTO referral_case_event(referral_case_id, event_type, actor_person_id, reason, created_at, result_referral_version)
         VALUES ($1::uuid, 'ACCEPTED', $2::uuid, 'ACCEPTANCE_VENUE_SNAPSHOT', $3::timestamptz, $4::bigint)`,
        [referralId, context.personId, at.toISOString(), updated.version]
      );
      await client.query(
        `INSERT INTO referral_acceptance_idempotency(
           actor_person_id, idempotency_key, request_hash, referral_case_id, created_at, accepted_referral_version
         ) VALUES ($1::uuid, $2, $3, $4::uuid, $5::timestamptz, $6::bigint)`,
        [context.personId, idempotencyKey, hash, referralId, at.toISOString(), updated.version]
      );
      const snapshot = await this.selectSnapshot(client, referralId, updated.version);
      await client.query("COMMIT");
      return mapResult(referralId, snapshot, false);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.release();
    }
  }
}
