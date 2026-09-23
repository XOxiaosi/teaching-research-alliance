import { createHash, randomUUID } from "node:crypto";
import { allocationDelta, allocateSettlement, postLedgerEvent, type WeeklyFeeDraft } from "@teaching-research-alliance/domain";
import { createPostgresLedgerTransaction, type PostgresPool } from "./postgres-ledger-repository.js";
import { lockSettlementAllocationShared } from "./postgres-settlement-allocation-gate.js";
import { PostgresWeeklyFeeRepository, type PersistedWeeklyFeeRecord } from "./postgres-weekly-fee-repository.js";
import { resolveSettlementContext } from "./postgres-settlement-context.js";
import type { SettlementSnapshot } from "./settlement-posting-service.js";

const stringify = (value: unknown): string => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);
const decodeSnapshot = (value: { lines: { key: string; cents: string }[]; accountByKey: Record<string, string> }): SettlementSnapshot => ({
  lines: value.lines.map(line => ({ key: line.key, cents: BigInt(line.cents) })),
  accountByKey: value.accountByKey
});

export type WeeklySettlementResult = Readonly<{
  fee: PersistedWeeklyFeeRecord;
  runId: string;
  status: "POSTED" | "NO_BALANCE_CHANGE";
  replay: boolean;
}>;

/** Internal application service. Caller must supply an authenticated teacher identity. */
export class PostgresWeeklySettlementService {
  public constructor(private readonly pool: PostgresPool) {}

  public async recordAndSettle(personId: string, draft: WeeklyFeeDraft, requestKey: string): Promise<WeeklySettlementResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockSettlementAllocationShared(client);
      // A whole-month lock also protects aggregate queries against concurrent first inserts.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`settlement-month:${draft.settlementMonth}`]);
      const fees = new PostgresWeeklyFeeRepository(this.pool);
      const fee = await fees.recordWeeklyFeeInTransaction(client, personId, draft, requestKey);
      const priorRun = await client.query<{ id: string; status: "POSTED" | "NO_BALANCE_CHANGE" }>(
        "SELECT id::text, status FROM settlement_calculation_run WHERE request_key = $1", [requestKey]);
      if (priorRun.rows[0]) {
        await client.query("COMMIT");
        return { fee, runId: priorRun.rows[0].id, status: priorRun.rows[0].status, replay: true };
      }
      const source = await client.query<{ id: string; referrer_person_id: string; receiver_person_id: string }>(
        `SELECT entry.id::text, referral.referrer_person_id::text, referral.receiver_person_id::text
         FROM weekly_fee_entry entry JOIN referral_case referral ON referral.id = entry.referral_case_id
         WHERE entry.referral_case_id = $1 AND entry.teaching_week_id = $2`, [draft.referralCaseId, draft.teachingWeekId]);
      const trigger = source.rows[0];
      if (!trigger) throw new Error("WEEKLY_FEE_NOT_FOUND");
      const affected = await client.query<{ id: string; version: string }>(
        `WITH affected_person AS (
           SELECT unnest($2::uuid[]) AS person_id
           UNION
           SELECT refund_referral.receiver_person_id
             FROM weekly_fee_refund_effect refund
             JOIN weekly_fee_entry refunded_entry ON refunded_entry.id = refund.weekly_fee_entry_id
             JOIN referral_case refund_referral ON refund_referral.id = refunded_entry.referral_case_id
            WHERE refunded_entry.settlement_month = $1::date
           UNION
           SELECT refund_referral.referrer_person_id
             FROM weekly_fee_refund_effect refund
             JOIN weekly_fee_entry refunded_entry ON refunded_entry.id = refund.weekly_fee_entry_id
             JOIN referral_case refund_referral ON refund_referral.id = refunded_entry.referral_case_id
            WHERE refunded_entry.settlement_month = $1::date
         )
         SELECT entry.id::text, entry.version::text
           FROM weekly_fee_entry entry
           JOIN referral_case referral ON referral.id = entry.referral_case_id
          WHERE entry.settlement_month = $1::date
            AND referral.receiver_person_id IN (SELECT person_id FROM affected_person)
            AND NOT EXISTS (
              SELECT 1
                FROM weekly_fee_refund_effect refund
               WHERE refund.weekly_fee_entry_id = entry.id
            )
          ORDER BY entry.id
          FOR UPDATE OF entry`,
        [draft.settlementMonth, [trigger.referrer_person_id, trigger.receiver_person_id]]
      );
      const snapshots = [];
      const deltas = [];
      for (const entry of affected.rows) {
        const context = await resolveSettlementContext(client, entry.id);
        const next: SettlementSnapshot = { lines: allocateSettlement(context.input), accountByKey: context.accountByKey };
        const previousResult = await client.query<{ snapshot_json: Parameters<typeof decodeSnapshot>[0] }>(
          `SELECT snapshot_json FROM weekly_fee_allocation_snapshot WHERE weekly_fee_entry_id = $1
           ORDER BY sequence_no DESC LIMIT 1`, [entry.id]);
        const previous = previousResult.rows[0] ? decodeSnapshot(previousResult.rows[0].snapshot_json) : { lines: [], accountByKey: {} };
        deltas.push(...allocationDelta(previous.lines, next.lines, previous.accountByKey, next.accountByKey));
        snapshots.push({ entry, context, next });
      }
      // Different fee corrections may cancel at the account/category level.
      const aggregated = new Map<string, (typeof deltas)[number]>();
      for (const delta of deltas) {
        const key = JSON.stringify([delta.accountKey, delta.categoryKey]);
        aggregated.set(key, { ...delta, amountCents: (aggregated.get(key)?.amountCents ?? 0n) + delta.amountCents });
      }
      const nonzero = [...aggregated.values()].filter(delta => delta.amountCents !== 0n);
      const runId = randomUUID();
      let ledgerEventId: string | null = null;
      if (nonzero.length > 0) {
        const bound = createPostgresLedgerTransaction(client);
        const posted = await postLedgerEvent({ transaction: work => work(bound) }, {
          eventKey: `weekly-settlement:${requestKey}`,
          eventType: "WEEKLY_FEE_SETTLEMENT",
          payloadHash: createHash("sha256").update(stringify(snapshots)).digest("hex"),
          deltas: nonzero
        }, randomUUID);
        ledgerEventId = posted.event.eventId;
      }
      const status = ledgerEventId === null ? "NO_BALANCE_CHANGE" : "POSTED";
      await client.query(
        `INSERT INTO settlement_calculation_run (id, request_key, fee_entry_id, fee_version, actor_person_id, status, ledger_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`, [runId, requestKey, trigger.id, fee.version, personId, status, ledgerEventId]);
      for (const { entry, context, next } of snapshots) {
        await client.query(
          `INSERT INTO weekly_fee_allocation_snapshot (run_id, weekly_fee_entry_id, source_weekly_fee_version, policy_version_id, net_monthly_cents, snapshot_json, context_json)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
          [runId, entry.id, entry.version, context.policyVersionId, context.input.netMonthlyCents.toString(), stringify(next), stringify(context.contextJson)]);
      }
      await client.query("COMMIT");
      return { fee, runId, status, replay: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.release();
    }
  }
}
