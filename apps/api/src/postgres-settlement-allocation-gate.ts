import type { PostgresClient } from "./postgres-ledger-repository.js";

const SETTLEMENT_ALLOCATION_GATE = "settlement-allocation-gate:v1";

/**
 * Every writer that creates or consumes the latest weekly allocation takes this
 * shared gate before any narrower lock. Relationship publication takes the
 * exclusive form, so even a first fee in a previously empty month cannot race
 * against an effective relationship replacement.
 */
export const lockSettlementAllocationShared = async (client: PostgresClient): Promise<void> => {
  await client.query(
    "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",
    [SETTLEMENT_ALLOCATION_GATE]
  );
};

export const lockSettlementAllocationExclusive = async (client: PostgresClient): Promise<void> => {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    [SETTLEMENT_ALLOCATION_GATE]
  );
};
