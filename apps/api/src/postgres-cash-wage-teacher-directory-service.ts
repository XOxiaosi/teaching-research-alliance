import type { RoleContext } from "@teaching-research-alliance/contracts";
import type { PostgresClient, PostgresPool } from "./postgres-ledger-repository.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CashWageTeacherDirectoryItem = Readonly<{ personId: string; nickname: string }>;

type PersonRow = Readonly<{ person_id: string; nickname: string }>;

const assertManagedDirectoryScope = (context: RoleContext): void => {
  if (!UUID.test(context.personId)
    || !["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"].includes(context.subject)
    || context.scope !== "GLOBAL"
    || context.regionId !== undefined
    || context.campusId !== undefined
    || context.venueId !== undefined) {
    throw new Error("FORBIDDEN_SCOPE");
  }
};

const readOnly = async <T>(pool: PostgresPool, work: (client: PostgresClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  let open = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    open = true;
    const result = await work(client);
    await client.query("COMMIT");
    open = false;
    return result;
  } catch (error) {
    if (open) await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.release();
  }
};

/**
 * Candidate directory for the cash-wage writer. It deliberately reflects the
 * writer's only eligibility rule: an ACTIVE natural person, regardless of
 * teaching or planning business identity.
 */
export class PostgresCashWageTeacherDirectoryService {
  public constructor(private readonly pool: PostgresPool) {}

  public async list(context: RoleContext): Promise<Readonly<{ items: readonly CashWageTeacherDirectoryItem[] }>> {
    assertManagedDirectoryScope(context);
    return readOnly(this.pool, async (client) => {
      const rows = await client.query<PersonRow>(
        "SELECT id::text AS person_id,nickname FROM person WHERE status='ACTIVE' ORDER BY nickname,id",
      );
      return { items: rows.rows.map((row) => ({ personId: row.person_id, nickname: row.nickname })) };
    });
  }
}
