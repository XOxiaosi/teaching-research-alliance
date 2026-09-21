import type {
  Cents,
  LedgerEventRecord,
  LedgerRepository,
  LedgerTransaction
} from "@teaching-research-alliance/domain";
import { prepareLedgerPosting } from "./postgres-ledger-locks.js";

export type SqlQueryResult<Row> = Readonly<{
  rows: readonly Row[];
  rowCount?: number;
}>;

export type PostgresClient = Readonly<{
  query: <Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => Promise<SqlQueryResult<Row>>;
  release: () => void | Promise<void>;
}>;

export type PostgresPool = Readonly<{
  connect: () => Promise<PostgresClient>;
}>;

type LedgerEventRow = Readonly<{
  event_id: string;
  event_key: string;
  event_type: string;
  payload_hash: string;
  account_key: string | null;
  category_key: string | null;
  amount_cents: string | null;
}>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const mapEventRows = (rows: readonly LedgerEventRow[]): LedgerEventRecord | undefined => {
  const first = rows[0];
  if (first === undefined) return undefined;
  const deltas = rows
    .filter((row) => row.account_key !== null && row.category_key !== null && row.amount_cents !== null)
    .map((row) => ({
      accountKey: row.account_key as string,
      categoryKey: row.category_key as string,
      amountCents: BigInt(row.amount_cents as string)
    })).sort((left, right) => `${left.accountKey}:${left.categoryKey}`.localeCompare(`${right.accountKey}:${right.categoryKey}`));
  return {
    eventId: first.event_id,
    eventKey: first.event_key,
    eventType: first.event_type,
    payloadHash: first.payload_hash,
    deltas
  };
};

export class PostgresLedgerRepository implements LedgerRepository {
  public constructor(private readonly pool: PostgresPool) {}

  public async transaction<T>(work: (transaction: LedgerTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const transaction = createPostgresLedgerTransaction(client);
      const result = await work(transaction);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.release();
    }
  }
}

/** Bind ledger operations to an existing transaction without managing its lifetime. */
export const createPostgresLedgerTransaction = (client: PostgresClient): LedgerTransaction => {
  return {
    findEvent: async (eventKey) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`ledger-event:${eventKey}`]);
      const result = await client.query<LedgerEventRow>(
        `SELECT le.id::text AS event_id,
                le.event_key,
                le.event_type,
                le.payload_hash,
                sa.account_code AS account_key,
                entry.category_key,
                entry.amount_cents::text AS amount_cents
           FROM ledger_event le
           LEFT JOIN ledger_entry entry ON entry.event_id = le.id
           LEFT JOIN settlement_account sa ON sa.id = entry.account_id
          WHERE le.event_key = $1
          ORDER BY entry.id`,
        [eventKey]
      );
      return mapEventRows(result.rows);
    },
    insertEvent: async (event) => {
      if (!UUID_PATTERN.test(event.eventId)) throw new Error("LEDGER_EVENT_ID_INVALID");
      // This is deliberately unconditional: every ledger writer receives the same event/account/balance lock order.
      await prepareLedgerPosting(client, event.eventKey, event.deltas.map((delta) => delta.accountKey));
      await client.query(
        `INSERT INTO ledger_event (id, event_key, event_type, payload_hash)
         VALUES ($1::uuid, $2, $3, $4)`,
        [event.eventId, event.eventKey, event.eventType, event.payloadHash]
      );
      for (const delta of event.deltas) {
        const result = await client.query(
          `INSERT INTO ledger_entry (event_id, account_id, category_key, amount_cents)
           SELECT $1::uuid, account.id, $3, $4::bigint
             FROM settlement_account account
            WHERE account.account_code = $2`,
          [event.eventId, delta.accountKey, delta.categoryKey, delta.amountCents.toString()]
        );
        if (result.rowCount === 0) throw new Error("MISSING_ACCOUNT_MAPPING");
      }
    },
    getBalance: async (accountKey): Promise<Cents> => {
      const result = await client.query<{ balance_cents: string }>(
        `SELECT COALESCE(projection.balance_cents, 0)::text AS balance_cents
           FROM settlement_account account
           LEFT JOIN account_balance_projection projection ON projection.account_id = account.id
          WHERE account.account_code = $1`,
        [accountKey]
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("MISSING_ACCOUNT_MAPPING");
      return BigInt(row.balance_cents);
    },
    applyBalance: async (accountKey, amountCents) => {
      const result = await client.query(
        `INSERT INTO account_balance_projection (account_id, balance_cents)
         SELECT account.id, $2::bigint
           FROM settlement_account account
          WHERE account.account_code = $1
         ON CONFLICT (account_id) DO UPDATE
           SET balance_cents = account_balance_projection.balance_cents + EXCLUDED.balance_cents,
               updated_at = now()`,
        [accountKey, amountCents.toString()]
      );
      if (result.rowCount === 0) throw new Error("MISSING_ACCOUNT_MAPPING");
    }
  };
};
