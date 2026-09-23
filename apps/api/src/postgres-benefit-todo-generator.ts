import type { PostgresClient } from "./postgres-ledger-repository.js";

export type BenefitGenerationDate = Readonly<{
  month: string;
  day: number;
  daysInMonth: number;
}>;

export type GeneratedBenefitTodo = Readonly<{
  id: string;
  planVersionId: string;
  subjectPersonId: string;
  month: string;
  kind: string;
}>;

export const resolveBenefitGenerationDate = (
  at: Date,
): BenefitGenerationDate => {
  if (!Number.isFinite(at.getTime())) throw new Error("INVALID_INPUT");
  const fields = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const read = (part: string): string | undefined =>
    fields.find((item) => item.type === part)?.value;
  const year = read("year"),
    monthNo = read("month"),
    dayText = read("day");
  if (!year || !monthNo || !dayText) throw new Error("INVALID_INPUT");
  const day = Number(dayText),
    daysInMonth = new Date(
      Date.UTC(Number(year), Number(monthNo), 0),
    ).getUTCDate();
  if (
    !Number.isSafeInteger(day) ||
    day < 1 ||
    day > daysInMonth ||
    !Number.isSafeInteger(daysInMonth)
  )
    throw new Error("INVALID_INPUT");
  return { month: `${year}-${monthNo}-01`, day, daysInMonth };
};

/**
 * Generates due todos inside the caller's open transaction. All callers share
 * the same business locks and immutable business key; this function never
 * commits, records a personal command, or posts ledger entries.
 */
export const generateDueBenefitTodosInTransaction = async (
  client: PostgresClient,
  at: Date,
  schedule = resolveBenefitGenerationDate(at),
): Promise<readonly GeneratedBenefitTodo[]> => {
  if (!Number.isFinite(at.getTime())) throw new Error("INVALID_INPUT");
  const identities = (
    await client.query<{
      benefit_kind: string;
      beneficiary_person_id: string;
      benefit_month: string;
    }>(
      `SELECT benefit_kind,beneficiary_person_id::text AS beneficiary_person_id,benefit_month::text AS benefit_month FROM finance_benefit_plan_version WHERE benefit_month=$1::date GROUP BY benefit_kind,beneficiary_person_id,benefit_month ORDER BY benefit_kind,beneficiary_person_id,benefit_month`,
      [schedule.month],
    )
  ).rows;
  const result: GeneratedBenefitTodo[] = [];
  for (const identity of identities) {
    const todoExists = async (): Promise<boolean> =>
      (
        await client.query(
          `SELECT 1 FROM finance_benefit_todo WHERE benefit_kind=$1 AND beneficiary_person_id=$2::uuid AND benefit_month=$3::date`,
          [
            identity.benefit_kind,
            identity.beneficiary_person_id,
            identity.benefit_month,
          ],
        )
      ).rows.length > 0;
    // Todos are immutable. Existing rows can be skipped without taking the
    // plan lock, preserving confirmBenefit's todo-row -> plan-lock ordering.
    if (await todoExists()) continue;
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [
        `benefit-plan:${identity.benefit_kind}:${identity.beneficiary_person_id}:${identity.benefit_month}`,
      ],
    );
    if (await todoExists()) continue;
    const current = (
      await client.query<{
        id: string;
        active: boolean;
        execution_day: number;
      }>(
        `SELECT id::text AS id,active,execution_day FROM finance_benefit_plan_version WHERE benefit_kind=$1 AND beneficiary_person_id=$2::uuid AND benefit_month=$3::date ORDER BY version_no DESC LIMIT 1`,
        [
          identity.benefit_kind,
          identity.beneficiary_person_id,
          identity.benefit_month,
        ],
      )
    ).rows[0];
    if (!current?.active) continue;
    if (current.execution_day > schedule.daysInMonth)
      throw new Error("BENEFIT_PLAN_EXECUTION_DAY_INVALID_FOR_MONTH");
    if (current.execution_day > schedule.day) continue;
    const row = (
      await client.query<{
        id: string;
        plan_version_id: string;
        benefit_kind: string;
        beneficiary_person_id: string;
        benefit_month: string;
      }>(
        `INSERT INTO finance_benefit_todo(plan_version_id,benefit_kind,beneficiary_person_id,benefit_month,generated_at) VALUES($1::uuid,$2,$3::uuid,$4::date,$5::timestamptz) ON CONFLICT ON CONSTRAINT finance_benefit_todo_business_key DO NOTHING RETURNING id::text AS id,plan_version_id::text AS plan_version_id,benefit_kind,beneficiary_person_id::text AS beneficiary_person_id,benefit_month::text AS benefit_month`,
        [
          current.id,
          identity.benefit_kind,
          identity.beneficiary_person_id,
          identity.benefit_month,
          at.toISOString(),
        ],
      )
    ).rows[0];
    if (row)
      result.push({
        id: row.id,
        planVersionId: row.plan_version_id,
        subjectPersonId: row.beneficiary_person_id,
        month: row.benefit_month,
        kind: row.benefit_kind,
      });
  }
  return result;
};
