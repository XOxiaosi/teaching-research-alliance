import type { RoleContext } from "@teaching-research-alliance/contracts";
import { financeYearBounds } from "./finance-year.js";
import type { PostgresClient, PostgresPool } from "./postgres-ledger-repository.js";

const PERSONAL_SUBJECTS = ["TEACHING_TEACHER", "ACADEMIC_PLANNER", "PLANNING_MENTOR"] as const;
const SETTLEMENT_CATEGORIES = [
  "referrer",
  "planningMentor",
  "groupLeader",
  "teachingMentor",
  "venue",
  "campusConsultation",
  "platformFinance",
  "regionFinance",
  "teachingTeacher"
] as const;

type PersonRow = Readonly<{ id: string; nickname: string }>;
type AccountRow = Readonly<{ id: string; balance_cents: string }>;
type IncomeRow = Readonly<{ category_key: string; amount_cents: string }>;
type VenueRow = Readonly<{ id: string; name: string; is_own: boolean }>;

export type PersonalOverview = Readonly<{
  personId: string;
  nickname: string;
  balanceCents: bigint;
  currentYearIncomeByCategory: Readonly<Record<string, bigint>>;
}>;

export type AvailableVenue = Readonly<{
  id: string;
  name: string;
  isOwn: boolean;
}>;

const assertPersonalContext = (context: RoleContext): void => {
  if (!(PERSONAL_SUBJECTS as readonly string[]).includes(context.subject)) {
    throw new Error("FORBIDDEN_SCOPE");
  }
};

const assertTeacherContext = (context: RoleContext): void => {
  if (context.subject !== "TEACHING_TEACHER") throw new Error("FORBIDDEN_SCOPE");
};

const requireSingle = <Row>(rows: readonly Row[], missingCode: string, ambiguousCode: string): Row => {
  if (rows.length === 0) throw new Error(missingCode);
  if (rows.length !== 1) throw new Error(ambiguousCode);
  return rows[0] as Row;
};

export class PostgresPersonalReadService {
  public constructor(private readonly pool: PostgresPool) {}

  private async readOnlyTransaction<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
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

  public async getOwnOverview(context: RoleContext, at: Date): Promise<PersonalOverview> {
    assertPersonalContext(context);
    if (Number.isNaN(at.getTime())) throw new Error("INVALID_INPUT:at");
    return this.readOnlyTransaction(async (client) => {
      const personResult = await client.query<PersonRow>(
        `SELECT id::text AS id, nickname
           FROM person
          WHERE id = $1::uuid AND status = 'ACTIVE'
          LIMIT 2`,
        [context.personId]
      );
      const person = requireSingle(personResult.rows, "PERSON_NOT_FOUND", "PERSON_AMBIGUOUS");

      const accountResult = await client.query<AccountRow>(
        `SELECT account.id::text AS id,
                COALESCE(projection.balance_cents, 0)::text AS balance_cents
           FROM settlement_account account
           LEFT JOIN account_balance_projection projection ON projection.account_id = account.id
          WHERE account.owner_type = 'PERSON'
            AND account.owner_id = $1::uuid
            AND account.status = 'ACTIVE'
          LIMIT 2`,
        [context.personId]
      );
      const account = requireSingle(
        accountResult.rows,
        "PERSONAL_ACCOUNT_NOT_FOUND",
        "PERSONAL_ACCOUNT_AMBIGUOUS"
      );

      const incomeResult = await client.query<IncomeRow>(
        `WITH latest_snapshot AS (
           SELECT DISTINCT ON (snapshot.weekly_fee_entry_id)
                  snapshot.weekly_fee_entry_id,
                  snapshot.snapshot_json,
                  snapshot.context_json
             FROM weekly_fee_allocation_snapshot snapshot
            ORDER BY snapshot.weekly_fee_entry_id, snapshot.sequence_no DESC
         ), personal_income AS (
           SELECT line ->> 'key' AS category_key,
                  (line ->> 'cents')::bigint AS amount_cents
             FROM latest_snapshot snapshot
             JOIN weekly_fee_entry fee ON fee.id = snapshot.weekly_fee_entry_id
             JOIN teaching_week week ON week.id = fee.teaching_week_id
             JOIN academic_period period ON period.id = week.academic_period_id
             JOIN academic_year_plan year_plan ON year_plan.id = period.academic_year_plan_id
             CROSS JOIN LATERAL jsonb_array_elements(snapshot.snapshot_json -> 'lines') line
            WHERE ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
                  BETWEEN year_plan.starts_on AND year_plan.ends_on
              AND line ->> 'key' = ANY($3::text[])
              AND snapshot.context_json -> 'accounts' -> (line ->> 'key') ->> 'accountId' = $1
         )
         SELECT category_key, sum(amount_cents)::text AS amount_cents
           FROM personal_income
          GROUP BY category_key
         HAVING sum(amount_cents) <> 0
          ORDER BY category_key`,
        [account.id, at.toISOString(), SETTLEMENT_CATEGORIES]
      );
      const currentYearIncomeByCategory: Record<string, bigint> = {};
      for (const row of incomeResult.rows) {
        currentYearIncomeByCategory[row.category_key] = BigInt(row.amount_cents);
      }
      const bounds = financeYearBounds(at);
      const reimbursements = await client.query<Readonly<{ amount_cents: string; valid: boolean | null }>>(
        `SELECT transfer.amount_cents::text AS amount_cents,
                (document.kind='SELF_PURCHASE' AND document.status='COMPLETED'
                 AND document.applicant_person_id=$1::uuid
                 AND transfer.destination_person_id=$1::uuid
                 AND transfer.destination_account_id=$2::uuid
                 AND transfer.submitted_by_person_id=$1::uuid
                 AND transfer.processing_mode='SYSTEM_RULE'
                 AND source.owner_type='COMPANY' AND source.owner_id=transfer.source_fund_id
                 AND source.account_code='company:fund:' || transfer.source_fund_id::text
                 AND event.event_type='SELF_PURCHASE_AUTO_COMPLETED'
                 AND event.event_key='self-purchase:' || document.id::text
                 AND entries.total=2 AND entries.income=1 AND entries.expense=1) AS valid
           FROM finance_self_purchase_transfer transfer
           JOIN finance_document document ON document.id=transfer.finance_document_id
           LEFT JOIN settlement_account source ON source.id=transfer.source_account_id
           LEFT JOIN ledger_event event ON event.id=transfer.ledger_event_id
           LEFT JOIN LATERAL (
             SELECT count(*) AS total,
                    count(*) FILTER (WHERE account_id=transfer.destination_account_id
                      AND category_key='selfPurchaseIncome' AND amount_cents=transfer.amount_cents) AS income,
                    count(*) FILTER (WHERE account_id=transfer.source_account_id
                      AND category_key='selfPurchaseExpense' AND amount_cents=-transfer.amount_cents) AS expense
               FROM ledger_entry WHERE event_id=transfer.ledger_event_id
           ) entries ON true
          WHERE (transfer.destination_person_id=$1::uuid OR transfer.destination_account_id=$2::uuid)
            AND transfer.completed_at >= $3::timestamptz AND transfer.completed_at < $4::timestamptz`,
        [context.personId, account.id, bounds.start, bounds.end]
      );
      let reimbursementIncome = 0n;
      for (const row of reimbursements.rows) {
        if (row.valid !== true || !/^[1-9][0-9]*$/.test(row.amount_cents)) {
          throw new Error("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
        }
        reimbursementIncome += BigInt(row.amount_cents);
      }
      if (reimbursementIncome !== 0n) currentYearIncomeByCategory.reimbursementIncome = reimbursementIncome;
      return {
        personId: person.id,
        nickname: person.nickname,
        balanceCents: BigInt(account.balance_cents),
        currentYearIncomeByCategory
      };
    });
  }

  public async listAvailableVenues(context: RoleContext): Promise<readonly AvailableVenue[]> {
    assertTeacherContext(context);
    const client = await this.pool.connect();
    try {
      const result = await client.query<VenueRow>(
        `SELECT id::text AS id, name, owner_person_id = $1::uuid AS is_own
           FROM venue
          WHERE status = 'ACTIVE'
          ORDER BY name, id`,
        [context.personId]
      );
      return result.rows.map((row) => ({ id: row.id, name: row.name, isOwn: row.is_own }));
    } finally {
      await client.release();
    }
  }
}
