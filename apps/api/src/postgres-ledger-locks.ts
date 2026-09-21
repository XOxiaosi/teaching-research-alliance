import type { PostgresClient } from "./postgres-ledger-repository.js";

export type PreparedLedgerAccount = Readonly<{
  id: string;
  ownerType: "PERSON" | "VENUE" | "COMPANY";
  ownerId: string;
  accountCode: string;
  status: "ACTIVE" | "INACTIVE";
  balanceCents: bigint;
}>;

const compareCodeUnits = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

/**
 * Establishes the only ledger lock order: event advisory key, account code, then balance row.
 * PostgreSQL permits re-acquiring the same transaction advisory/row lock, so callers may prepare
 * before domain posting and the repository may defensively prepare again in insertEvent.
 */
export const prepareLedgerPosting = async (
  client: PostgresClient,
  eventKey: string,
  accountKeys: readonly string[]
): Promise<readonly PreparedLedgerAccount[]> => {
  if (!eventKey.trim()) throw new Error("LEDGER_EVENT_KEY_REQUIRED");
  const codes = [...new Set(accountKeys)].sort(compareCodeUnits);
  if (codes.length === 0 || codes.some(code => !code.trim())) throw new Error("MISSING_ACCOUNT_MAPPING");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`ledger-event:${eventKey}`]);
  const accounts: Array<Omit<PreparedLedgerAccount, "balanceCents">> = [];
  for (const accountCode of codes) {
    const row = (await client.query<{
      id: string; owner_type: "PERSON" | "VENUE" | "COMPANY"; owner_id: string; account_code: string; status: "ACTIVE" | "INACTIVE";
    }>(
      `SELECT id::text AS id,owner_type,owner_id::text AS owner_id,account_code,status
         FROM settlement_account WHERE account_code=$1 FOR NO KEY UPDATE`, [accountCode]
    )).rows[0];
    if (row === undefined) throw new Error("MISSING_ACCOUNT_MAPPING");
    accounts.push({ id: row.id, ownerType: row.owner_type, ownerId: row.owner_id, accountCode: row.account_code, status: row.status });
  }
  const prepared: PreparedLedgerAccount[] = [];
  for (const account of accounts) {
    await client.query("INSERT INTO account_balance_projection(account_id,balance_cents) VALUES ($1::uuid,0) ON CONFLICT (account_id) DO NOTHING", [account.id]);
    const balance = (await client.query<{ balance_cents: string }>(
      "SELECT balance_cents::text AS balance_cents FROM account_balance_projection WHERE account_id=$1::uuid FOR UPDATE", [account.id]
    )).rows[0];
    if (balance === undefined) throw new Error("MISSING_ACCOUNT_MAPPING");
    prepared.push({ ...account, balanceCents: BigInt(balance.balance_cents) });
  }
  return prepared;
};
