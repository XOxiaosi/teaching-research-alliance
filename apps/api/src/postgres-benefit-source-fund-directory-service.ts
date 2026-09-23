import type { RoleContext } from "@teaching-research-alliance/contracts";
import type { PostgresClient, PostgresPool } from "./postgres-ledger-repository.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FUND_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const GLOBAL_READERS = ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"] as const;

export type BenefitSourceFundDirectoryItem = Readonly<{
  fundId: string;
  code: string;
  displayName: string;
}>;

export type BenefitSourceFundDirectory = Readonly<{
  items: readonly BenefitSourceFundDirectoryItem[];
}>;

type SourceFundRow = Readonly<{
  fund_id: string;
  code: string;
  display_name: string;
}>;

const fail = (code: string): never => { throw new Error(code); };

const assertGlobalReader = (context: RoleContext): void => {
  if (!context || typeof context.personId !== "string"
    || !UUID.test(context.personId)
    || !(GLOBAL_READERS as readonly string[]).includes(context.subject)
    || context.scope !== "GLOBAL"
    || context.regionId !== undefined
    || context.campusId !== undefined
    || context.venueId !== undefined) {
    fail("FORBIDDEN_SCOPE");
  }
};

const assertAt = (at: Date): void => {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) fail("INVALID_INPUT");
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

const mapRow = (row: SourceFundRow): BenefitSourceFundDirectoryItem => {
  if (!UUID.test(row.fund_id)
    || !FUND_CODE.test(row.code)
    || !row.display_name.trim()
    || row.display_name.length > 200
    || /[\u0000-\u001f\u007f]/.test(row.display_name)) {
    fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
  }
  return { fundId: row.fund_id, code: row.code, displayName: row.display_name };
};

export class PostgresBenefitSourceFundDirectoryService {
  public constructor(private readonly pool: PostgresPool) {}

  public async list(context: RoleContext, at: Date): Promise<BenefitSourceFundDirectory> {
    assertGlobalReader(context);
    assertAt(at);
    return readOnly(this.pool, async (client) => {
      const result = await client.query<SourceFundRow>(
        `SELECT fund.id::text AS fund_id,fund.fund_code AS code,fund.display_name
           FROM company_finance_fund fund
           JOIN company_finance_fund_assignment assignment ON assignment.fund_id=fund.id
          WHERE fund.kind='HEADQUARTERS_FINANCE_OPERATING'
            AND fund.status='ACTIVE'
            AND EXISTS (
              SELECT 1 FROM settlement_account account
               WHERE account.owner_type='COMPANY' AND account.owner_id=fund.id AND account.status='ACTIVE'
            )
            AND assignment.duty_subject='HEADQUARTERS_FINANCE'
            AND assignment.scope_type='GLOBAL'
            AND assignment.scope_id IS NULL
            AND assignment.responsibility_code='FINANCE_OPERATING_SOURCE'
            AND assignment.valid_from <= $1::timestamptz
            AND (assignment.valid_to IS NULL OR assignment.valid_to > $1::timestamptz)
          ORDER BY fund.fund_code,fund.id`,
        [at.toISOString()],
      );
      return { items: result.rows.map(mapRow) };
    });
  }
}
