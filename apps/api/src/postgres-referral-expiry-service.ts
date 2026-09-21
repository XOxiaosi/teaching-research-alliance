import type { PostgresPool } from "./postgres-ledger-repository.js";

const assertInput = (at: Date, batchSize: number): void => {
  if (!Number.isFinite(at.getTime())
    || !Number.isSafeInteger(batchSize)
    || batchSize < 1
    || batchSize > 1000) throw new Error("INVALID_INPUT");
};

/**
 * Internal worker only. It never guesses expiry for old referrals with a null deadline.
 * `SKIP LOCKED` lets multiple workers claim distinct, due records without serializing the full queue.
 */
export class PostgresReferralExpiryService {
  public constructor(private readonly pool: PostgresPool) {}

  public async run(at: Date, batchSize = 100): Promise<{ archivedReferralIds: string[] }> {
    assertInput(at, batchSize);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const due = await client.query<{ id: string }>(
        `SELECT id::text AS id
           FROM referral_case
          WHERE status IN ('PENDING', 'REACTIVATED')
            AND unaccepted_expires_at IS NOT NULL
            AND unaccepted_expires_at <= $1::timestamptz
          ORDER BY unaccepted_expires_at, id
          LIMIT $2
          FOR UPDATE SKIP LOCKED`,
        [at.toISOString(), batchSize]
      );
      const archivedReferralIds: string[] = [];
      for (const row of due.rows) {
        const archived = await client.query<{ id: string }>(
          `UPDATE referral_case
              SET status = 'ARCHIVED', version = version + 1, updated_at = $2::timestamptz
            WHERE id = $1::uuid
          RETURNING id::text AS id`,
          [row.id, at.toISOString()]
        );
        if (archived.rows.length !== 1) throw new Error("REFERRAL_EXPIRY_UPDATE_FAILED");
        await client.query(
          `INSERT INTO referral_case_event(
             referral_case_id, event_type, actor_person_id, actor_type, reason, created_at
           ) VALUES ($1::uuid, 'ARCHIVED', NULL, 'SYSTEM', 'UNACCEPTED_EXPIRED', $2::timestamptz)`,
          [row.id, at.toISOString()]
        );
        archivedReferralIds.push(row.id);
      }
      await client.query("COMMIT");
      return { archivedReferralIds };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.release();
    }
  }
}
