import type { RoleContext } from "@teaching-research-alliance/contracts";
import type {
  PostgresClient,
  PostgresPool,
} from "./postgres-ledger-repository.js";

export type CashWageRosterItem = Readonly<{
  teacherPersonId: string;
  teacherDisplayName: string;
  salaryMonth: string;
  plan: Readonly<{
    id: string;
    sourceMonth: string;
    version: number;
    plannedCashCents: string;
    plannedDeductionCents: string;
    active: boolean;
    appliesToFutureMonths: boolean;
    reason: string;
    changedAt: string;
    changedByPersonId: string;
  }>;
  todo: Readonly<{
    id: string;
    generatedAt: string;
    planVersionId: string;
  }> | null;
  confirmedCashCents: string;
  confirmedDeductionCents: string;
  remainingCashCents: string;
  remainingDeductionCents: string;
  overageCashCents: string;
  overageDeductionCents: string;
  status:
    | "OVER_CONFIRMED"
    | "INACTIVE"
    | "NOT_GENERATED"
    | "PENDING"
    | "PARTIALLY_CONFIRMED"
    | "CONFIRMED";
}>;
export type CashWageConfirmation = Readonly<{
  documentId: string;
  status: "COMPLETED" | "REVERSED";
  version: number;
  teacherPersonId: string;
  teacherDisplayName: string;
  todoId: string | null;
  salaryMonth: string;
  cashPaidCents: string;
  deductionCents: string;
  balanceBeforeCents: string | null;
  balanceAfterCents: string | null;
  paidAt: string;
  reason: string;
  confirmedByPersonId: string;
  confirmedByDisplayName: string;
  createdAt: string;
  attachmentCount: number;
  reversal: Readonly<{
    documentId: string;
    reason: string;
    reversedAt: string;
    reversedByPersonId: string;
  }> | null;
  correctionOfDocumentId: string | null;
  correctionDocumentId: string | null;
}>;
export type CashWageDetail = CashWageConfirmation &
  Readonly<{
    plan: CashWageRosterItem["plan"] | null;
    todo: CashWageRosterItem["todo"];
    attachments: readonly Readonly<{
      versionId: string;
      purpose: "SUPPORTING_DOCUMENT" | "APPLICATION_SCREENSHOT";
      originalFilename: string;
      mediaType: "application/pdf" | "image/png" | "image/jpeg";
      sizeBytes: number;
      sha256: string;
    }>[];
  }>;

type RosterRow = Readonly<{
  teacher_person_id: string;
  teacher_display_name: string | null;
  plan_id: string;
  salary_month: string;
  source_month: string;
  version_no: string;
  planned_cash_cents: string;
  planned_deduction_cents: string;
  active: boolean;
  applies_to_future_months: boolean;
  reason: string;
  changed_at: string;
  changed_by_person_id: string;
  todo_id: string | null;
  todo_plan_version_id: string | null;
  generated_at: string | null;
  confirmed_cash_cents: string;
  confirmed_deduction_cents: string;
}>;
type ConfirmationRow = Readonly<{
  document_id: string;
  status: string;
  version: string;
  teacher_person_id: string;
  teacher_display_name: string | null;
  todo_id: string | null;
  salary_month: string;
  cash_paid_cents: string;
  deduction_cents: string;
  destination_before_cents: string | null;
  destination_after_cents: string | null;
  paid_at: string;
  reason: string;
  confirmed_by_person_id: string;
  confirmed_by_display_name: string | null;
  created_at: string;
  attachment_count: string;
  reversal_document_id: string | null;
  reversal_reason: string | null;
  reversal_created_at: string | null;
  reversed_by_person_id: string | null;
  correction_of_document_id: string | null;
  correction_document_id: string | null;
}>;
type DetailRow = ConfirmationRow &
  Readonly<{
    document_kind: string;
    ledger_event_id: string;
    destination_account_id: string;
    plan_id: string | null;
    plan_source_month: string | null;
    plan_version_no: string | null;
    plan_cash: string | null;
    plan_deduction: string | null;
    plan_active: boolean | null;
    plan_future: boolean | null;
    plan_reason: string | null;
    plan_changed_at: string | null;
    plan_changed_by: string | null;
    todo_plan_version_id: string | null;
    todo_generated_at: string | null;
    ledger_type: string | null;
    ledger_key: string | null;
    completion_event_count: string;
    ledger_entry_count: string;
    deduction_entry_count: string;
    deduction_amount: string | null;
    original_ledger_event_id: string | null;
    reversal_ledger_event_id: string | null;
    reversal_document_kind: string | null;
    reversal_document_status: string | null;
    reversal_document_version: string | null;
    reversal_event_type: string | null;
    reversal_event_key: string | null;
    reversal_document_event_count: string;
    original_reversed_event_count: string;
    reversal_entry_count: string;
    correction_entry_count: string;
    correction_amount: string | null;
  }>;
type AttachmentRow = Readonly<{
  version_id: string;
  purpose: string;
  original_filename: string;
  media_type: string | null;
  size_bytes: string | null;
  sha256: string | null;
  status: string;
  attachment_document_id: string;
  binding_document_version: string;
  bound_by_person_id: string;
  document_version: string;
  attachment_count: string;
}>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONTH = /^\d{4}-\d{2}-01$/;
const timestamp = (value: string | null): string => {
  if (value === null || !Number.isFinite(new Date(value).getTime()))
    throw new Error("SALARY_BENEFIT_DATA_UNAVAILABLE");
  return new Date(value).toISOString();
};
const uuid = (value: string | null): string => {
  if (value === null || !UUID.test(value))
    throw new Error("SALARY_BENEFIT_DATA_UNAVAILABLE");
  return value;
};
const nonNegative = (value: string | null): bigint => {
  if (value === null || !/^[0-9]+$/.test(value))
    throw new Error("SALARY_BENEFIT_DATA_UNAVAILABLE");
  return BigInt(value);
};
const signedCents = (value: string | null): bigint => {
  if (value === null || !/^-?[0-9]+$/.test(value))
    throw new Error("SALARY_BENEFIT_DATA_UNAVAILABLE");
  return BigInt(value);
};
const positiveInt = (value: string | null): number => {
  if (
    value === null ||
    !/^[1-9][0-9]*$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new Error("SALARY_BENEFIT_DATA_UNAVAILABLE");
  return Number(value);
};
const count = (value: string | null): number => {
  if (
    value === null ||
    !/^[0-9]+$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new Error("SALARY_BENEFIT_DATA_UNAVAILABLE");
  return Number(value);
};
const fail = (code: string): never => {
  throw new Error(code);
};
const required = <T>(value: T | undefined, code: string): T => {
  if (value === undefined) throw new Error(code);
  return value;
};
const managed = (context: RoleContext): boolean =>
  ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"].includes(
    context.subject,
  ) &&
  context.scope === "GLOBAL" &&
  context.regionId === undefined &&
  context.campusId === undefined &&
  context.venueId === undefined;
const month = (value: string): string => {
  if (!MONTH.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
    fail("INVALID_INPUT");
  return value;
};
const documentId = (value: string): string => {
  if (!UUID.test(value)) fail("INVALID_INPUT");
  return value;
};
const cursorEncode = (createdAt: string, id: string): string =>
  Buffer.from(JSON.stringify({ createdAt, id })).toString("base64url");
const cursorDecode = (
  value: string | undefined,
): Readonly<{ createdAt: string; id: string }> | null => {
  if (value === undefined) return null;
  if (!value || value.length > 400) fail("INVALID_INPUT");
  try {
    const item = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    if (typeof item !== "object" || item === null || Array.isArray(item))
      fail("INVALID_INPUT");
    const row = item as Record<string, unknown>,
      createdAt = row.createdAt,
      id = row.id;
    if (
      Object.keys(row).length !== 2 ||
      typeof createdAt !== "string" ||
      typeof id !== "string" ||
      !UUID.test(id) ||
      !Number.isFinite(new Date(createdAt).getTime())
    )
      fail("INVALID_INPUT");
    return {
      createdAt: new Date(createdAt as string).toISOString(),
      id: id as string,
    };
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_INPUT")
      throw error;
    return fail("INVALID_INPUT");
  }
};
const readTx = async <T>(
  pool: PostgresPool,
  work: (client: PostgresClient) => Promise<T>,
): Promise<T> => {
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
const display = (value: string | null): string => {
  if (value === null) fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
  const result = value as string;
  if (!result.trim() || /[\u0000-\u001f\u007f]/.test(result))
    fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
  return result;
};
const planFrom = (
  row: Pick<
    RosterRow,
    | "plan_id"
    | "source_month"
    | "version_no"
    | "planned_cash_cents"
    | "planned_deduction_cents"
    | "active"
    | "applies_to_future_months"
    | "reason"
    | "changed_at"
    | "changed_by_person_id"
  >,
): CashWageRosterItem["plan"] => {
  const cash = nonNegative(row.planned_cash_cents),
    deduction = nonNegative(row.planned_deduction_cents);
  if (cash !== deduction || !MONTH.test(row.source_month) || !row.reason.trim())
    fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
  return {
    id: uuid(row.plan_id),
    sourceMonth: row.source_month,
    version: positiveInt(row.version_no),
    plannedCashCents: cash.toString(),
    plannedDeductionCents: deduction.toString(),
    active: row.active,
    appliesToFutureMonths: row.applies_to_future_months,
    reason: row.reason.trim(),
    changedAt: timestamp(row.changed_at),
    changedByPersonId: uuid(row.changed_by_person_id),
  };
};
const todoFrom = (
  id: string | null,
  planId: string | null,
  at: string | null,
): CashWageRosterItem["todo"] => {
  if (id === null && planId === null && at === null) return null;
  if (id === null || planId === null || at === null)
    fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
  return {
    id: uuid(id),
    planVersionId: uuid(planId),
    generatedAt: timestamp(at),
  };
};
const confirmationFrom = (row: ConfirmationRow): CashWageConfirmation => {
  if (!["COMPLETED", "REVERSED"].includes(row.status))
    fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
  const cash = nonNegative(row.cash_paid_cents),
    deduction = nonNegative(row.deduction_cents);
  if (
    cash < 1n ||
    cash !== deduction ||
    !MONTH.test(row.salary_month) ||
    !row.reason.trim()
  )
    fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
  const reversed = row.status === "REVERSED";
  if (reversed !== (row.reversal_document_id !== null))
    fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
  const reversal = !reversed
    ? null
    : {
        documentId: uuid(row.reversal_document_id),
        reason: (row.reversal_reason ?? "").trim(),
        reversedAt: timestamp(row.reversal_created_at),
        reversedByPersonId: uuid(row.reversed_by_person_id),
      };
  if (reversal !== null && !reversal.reason)
    fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
  const hasBalanceSnapshot =
    row.destination_before_cents !== null ||
    row.destination_after_cents !== null;
  let balanceBeforeCents: string | null = null;
  let balanceAfterCents: string | null = null;
  if (hasBalanceSnapshot) {
    const before = signedCents(row.destination_before_cents);
    const after = signedCents(row.destination_after_cents);
    if (after !== before - deduction) fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
    balanceBeforeCents = before.toString();
    balanceAfterCents = after.toString();
  }
  return {
    documentId: uuid(row.document_id),
    status: row.status as "COMPLETED" | "REVERSED",
    version: positiveInt(row.version),
    teacherPersonId: uuid(row.teacher_person_id),
    teacherDisplayName: display(row.teacher_display_name),
    todoId: row.todo_id === null ? null : uuid(row.todo_id),
    salaryMonth: row.salary_month,
    cashPaidCents: cash.toString(),
    deductionCents: deduction.toString(),
    balanceBeforeCents,
    balanceAfterCents,
    paidAt: timestamp(row.paid_at),
    reason: row.reason.trim(),
    confirmedByPersonId: uuid(row.confirmed_by_person_id),
    confirmedByDisplayName: display(row.confirmed_by_display_name),
    createdAt: timestamp(row.created_at),
    attachmentCount: count(row.attachment_count),
    reversal,
    correctionOfDocumentId:
      row.correction_of_document_id === null
        ? null
        : uuid(row.correction_of_document_id),
    correctionDocumentId:
      row.correction_document_id === null
        ? null
        : uuid(row.correction_document_id),
  };
};

const rosterSql = `WITH effective_plan AS (
 SELECT DISTINCT ON (plan.teacher_person_id)
   plan.id,plan.teacher_person_id,plan.salary_month AS source_month,plan.version_no,
   plan.planned_cash_cents,plan.planned_deduction_cents,plan.active,
   plan.applies_to_future_months,plan.reason,plan.changed_at,plan.changed_by_person_id
 FROM cash_wage_plan_version plan
 WHERE plan.salary_month=$1::date
    OR (plan.applies_to_future_months AND plan.salary_month<$1::date)
 ORDER BY plan.teacher_person_id,(plan.salary_month=$1::date) DESC,plan.salary_month DESC,plan.version_no DESC
), completed AS (
 SELECT confirmation.todo_id,COALESCE(SUM(confirmation.cash_paid_cents),0)::text AS cash,COALESCE(SUM(confirmation.deduction_cents),0)::text AS deduction
 FROM cash_wage_confirmation confirmation JOIN finance_document document ON document.id=confirmation.finance_document_id AND document.status='COMPLETED'
 GROUP BY confirmation.todo_id
)
SELECT plan.teacher_person_id::text,person.nickname AS teacher_display_name,plan.id::text AS plan_id,$1::date::text AS salary_month,plan.source_month::text,plan.version_no::text,plan.planned_cash_cents::text,plan.planned_deduction_cents::text,plan.active,plan.applies_to_future_months,plan.reason,plan.changed_at::text,plan.changed_by_person_id::text,todo.id::text AS todo_id,todo.plan_version_id::text AS todo_plan_version_id,todo.generated_at::text,COALESCE(completed.cash,'0') AS confirmed_cash_cents,COALESCE(completed.deduction,'0') AS confirmed_deduction_cents
FROM effective_plan plan JOIN person ON person.id=plan.teacher_person_id LEFT JOIN cash_wage_todo todo ON todo.teacher_person_id=plan.teacher_person_id AND todo.salary_month=$1::date LEFT JOIN completed ON completed.todo_id=todo.id ORDER BY person.nickname,plan.teacher_person_id`;
const confirmationSql = `SELECT document.id::text AS document_id,document.status,document.version::text,confirmation.teacher_person_id::text,teacher.nickname AS teacher_display_name,confirmation.todo_id::text,confirmation.salary_month::text,confirmation.cash_paid_cents::text,confirmation.deduction_cents::text,confirmation.destination_before_cents::text,confirmation.destination_after_cents::text,confirmation.paid_at::text,confirmation.reason,confirmation.confirmed_by_person_id::text,operator.nickname AS confirmed_by_display_name,confirmation.created_at::text,COUNT(binding.finance_attachment_version_id)::text AS attachment_count,reversal.reversal_finance_document_id::text AS reversal_document_id,reversal.reason AS reversal_reason,reversal.created_at::text AS reversal_created_at,reversal.reversed_by_person_id::text,confirmation.correction_of_finance_document_id::text AS correction_of_document_id,correction.finance_document_id::text AS correction_document_id
FROM cash_wage_confirmation confirmation JOIN finance_document document ON document.id=confirmation.finance_document_id JOIN person teacher ON teacher.id=confirmation.teacher_person_id JOIN person operator ON operator.id=confirmation.confirmed_by_person_id LEFT JOIN salary_benefit_attachment_binding binding ON binding.finance_document_id=document.id LEFT JOIN salary_benefit_reversal reversal ON reversal.original_finance_document_id=document.id LEFT JOIN cash_wage_confirmation correction ON correction.correction_of_finance_document_id=document.id
WHERE confirmation.salary_month=$1::date AND ($2::uuid IS NULL OR confirmation.teacher_person_id=$2::uuid) AND ($3::timestamptz IS NULL OR (confirmation.created_at,document.id)<($3::timestamptz,$4::uuid))
GROUP BY document.id,confirmation.finance_document_id,teacher.id,operator.id,reversal.reversal_finance_document_id,correction.finance_document_id ORDER BY confirmation.created_at DESC,document.id DESC LIMIT $5::int`;

export class PostgresCashWageReadService {
  public constructor(private readonly pool: PostgresPool) {}
  public async listRoster(
    context: RoleContext,
    salaryMonth: string,
  ): Promise<
    Readonly<{ salaryMonth: string; items: readonly CashWageRosterItem[] }>
  > {
    if (!managed(context)) fail("FORBIDDEN_SCOPE");
    const target = month(salaryMonth);
    return readTx(this.pool, async (client) => {
      const rows = (await client.query<RosterRow>(rosterSql, [target])).rows;
      return {
        salaryMonth: target,
        items: rows.map((row) => {
          const plan = planFrom(row),
            todo = todoFrom(
              row.todo_id,
              row.todo_plan_version_id,
              row.generated_at,
            ),
            cash = nonNegative(row.confirmed_cash_cents),
            deduction = nonNegative(row.confirmed_deduction_cents);
          if (cash !== deduction) fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
          const plannedCash = BigInt(plan.plannedCashCents);
          const plannedDeduction = BigInt(plan.plannedDeductionCents);
          const overageCash = cash > plannedCash ? cash - plannedCash : 0n;
          const overageDeduction =
            deduction > plannedDeduction ? deduction - plannedDeduction : 0n;
          const status =
            overageCash > 0n || overageDeduction > 0n
              ? "OVER_CONFIRMED"
              : !plan.active
                ? "INACTIVE"
                : todo === null
                  ? "NOT_GENERATED"
                  : cash === 0n
                    ? "PENDING"
                    : cash === plannedCash
                      ? "CONFIRMED"
                      : "PARTIALLY_CONFIRMED";
          return {
            teacherPersonId: uuid(row.teacher_person_id),
            teacherDisplayName: display(row.teacher_display_name),
            salaryMonth: target,
            plan,
            todo,
            confirmedCashCents: cash.toString(),
            confirmedDeductionCents: deduction.toString(),
            remainingCashCents: (plannedCash - cash < 0n
              ? 0n
              : plannedCash - cash
            ).toString(),
            remainingDeductionCents: (plannedDeduction - deduction < 0n
              ? 0n
              : plannedDeduction - deduction
            ).toString(),
            overageCashCents: overageCash.toString(),
            overageDeductionCents: overageDeduction.toString(),
            status,
          };
        }),
      };
    });
  }
  public async listConfirmations(
    context: RoleContext,
    input: Readonly<{
      month: string;
      teacherPersonId?: string;
      cursor?: string;
      limit?: number;
    }>,
  ): Promise<
    Readonly<{
      items: readonly CashWageConfirmation[];
      nextCursor: string | null;
    }>
  > {
    if (!managed(context)) fail("FORBIDDEN_SCOPE");
    const target = month(input.month);
    const teacher =
      input.teacherPersonId === undefined
        ? null
        : documentId(input.teacherPersonId);
    const cursor = cursorDecode(input.cursor);
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      fail("INVALID_INPUT");
    return readTx(this.pool, async (client) => {
      const rows = (
        await client.query<ConfirmationRow>(confirmationSql, [
          target,
          teacher,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          limit + 1,
        ])
      ).rows;
      const more = rows.length > limit;
      const items = rows.slice(0, limit).map(confirmationFrom);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          more && last !== undefined
            ? cursorEncode(last.createdAt, last.documentId)
            : null,
      };
    });
  }
  public async getDetail(
    context: RoleContext,
    id: string,
  ): Promise<CashWageDetail> {
    if (!managed(context)) fail("FORBIDDEN_SCOPE");
    const document = documentId(id);
    return readTx(this.pool, async (client) => {
      const row = required(
        (
          await client.query<DetailRow>(
            `WITH base AS (
               SELECT confirmation.finance_document_id::text AS document_id,
                      document.kind AS document_kind,document.status,document.version::text,
                      confirmation.teacher_person_id::text,teacher.nickname AS teacher_display_name,
                      confirmation.todo_id::text,confirmation.salary_month::text,
                      confirmation.cash_paid_cents::text,confirmation.deduction_cents::text,
                      confirmation.destination_before_cents::text,confirmation.destination_after_cents::text,
                      confirmation.paid_at::text,confirmation.reason,
                      confirmation.confirmed_by_person_id::text,operator.nickname AS confirmed_by_display_name,
                      confirmation.created_at::text,COUNT(binding.finance_attachment_version_id)::text AS attachment_count,
                      reversal.reversal_finance_document_id::text AS reversal_document_id,
                      reversal.reason AS reversal_reason,reversal.created_at::text AS reversal_created_at,
                      reversal.reversed_by_person_id::text,
                      confirmation.correction_of_finance_document_id::text AS correction_of_document_id,
                      correction.finance_document_id::text AS correction_document_id,
                      confirmation.ledger_event_id,confirmation.destination_account_id,
                      plan.id::text AS plan_id,plan.salary_month::text AS plan_source_month,
                      plan.version_no::text AS plan_version_no,plan.planned_cash_cents::text AS plan_cash,
                      plan.planned_deduction_cents::text AS plan_deduction,plan.active AS plan_active,
                      plan.applies_to_future_months AS plan_future,plan.reason AS plan_reason,
                      plan.changed_at::text AS plan_changed_at,plan.changed_by_person_id::text AS plan_changed_by,
                      todo.plan_version_id::text AS todo_plan_version_id,todo.generated_at::text AS todo_generated_at
                 FROM cash_wage_confirmation confirmation
                 JOIN finance_document document ON document.id=confirmation.finance_document_id
                 JOIN person teacher ON teacher.id=confirmation.teacher_person_id
                 JOIN person operator ON operator.id=confirmation.confirmed_by_person_id
                 LEFT JOIN cash_wage_todo todo ON todo.id=confirmation.todo_id
                 LEFT JOIN cash_wage_plan_version plan ON plan.id=todo.plan_version_id
                 LEFT JOIN salary_benefit_attachment_binding binding ON binding.finance_document_id=document.id
                 LEFT JOIN salary_benefit_reversal reversal ON reversal.original_finance_document_id=document.id
                 LEFT JOIN cash_wage_confirmation correction ON correction.correction_of_finance_document_id=document.id
                WHERE document.id=$1::uuid
                GROUP BY confirmation.finance_document_id,document.id,teacher.id,operator.id,todo.id,plan.id,
                         reversal.reversal_finance_document_id,correction.finance_document_id
             )
             SELECT base.*,ledger.event_type AS ledger_type,ledger.event_key AS ledger_key,
                    (SELECT COUNT(*)::text FROM finance_document_event event
                      WHERE event.finance_document_id=base.document_id::uuid
                        AND event.event_type='SALARY_BENEFIT_COMPLETED'
                        AND event.result_document_version=CASE WHEN base.status='REVERSED' THEN base.version::bigint-1 ELSE base.version::bigint END
                        AND event.ledger_event_id=base.ledger_event_id) AS completion_event_count,
                    (SELECT COUNT(*)::text FROM ledger_entry entry WHERE entry.event_id=base.ledger_event_id) AS ledger_entry_count,
                    (SELECT COUNT(*)::text FROM ledger_entry entry WHERE entry.event_id=base.ledger_event_id AND entry.account_id=base.destination_account_id AND entry.category_key='cashWageDeduction') AS deduction_entry_count,
                    (SELECT amount_cents::text FROM ledger_entry entry WHERE entry.event_id=base.ledger_event_id AND entry.account_id=base.destination_account_id AND entry.category_key='cashWageDeduction') AS deduction_amount,
                    reversal.original_ledger_event_id::text,reversal.reversal_ledger_event_id::text,
                    reversal_document.kind AS reversal_document_kind,reversal_document.status AS reversal_document_status,
                    reversal_document.version::text AS reversal_document_version,
                    reversal_ledger.event_type AS reversal_event_type,reversal_ledger.event_key AS reversal_event_key,
                    (SELECT COUNT(*)::text FROM finance_document_event event
                      WHERE event.finance_document_id=reversal.reversal_finance_document_id
                        AND event.event_type='SALARY_BENEFIT_COMPLETED'
                        AND event.result_document_version=reversal_document.version
                        AND event.ledger_event_id=reversal.reversal_ledger_event_id) AS reversal_document_event_count,
                    (SELECT COUNT(*)::text FROM finance_document_event event
                      WHERE event.finance_document_id=base.document_id::uuid
                        AND event.event_type='SALARY_BENEFIT_REVERSED'
                        AND event.result_document_version=base.version::bigint
                        AND event.ledger_event_id=reversal.reversal_ledger_event_id) AS original_reversed_event_count,
                    (SELECT COUNT(*)::text FROM ledger_entry entry WHERE entry.event_id=reversal.reversal_ledger_event_id) AS reversal_entry_count,
                    (SELECT COUNT(*)::text FROM ledger_entry entry WHERE entry.event_id=reversal.reversal_ledger_event_id AND entry.account_id=base.destination_account_id AND entry.category_key='cashWageCorrection') AS correction_entry_count,
                    (SELECT amount_cents::text FROM ledger_entry entry WHERE entry.event_id=reversal.reversal_ledger_event_id AND entry.account_id=base.destination_account_id AND entry.category_key='cashWageCorrection') AS correction_amount
               FROM base
               LEFT JOIN ledger_event ledger ON ledger.id=base.ledger_event_id
               LEFT JOIN salary_benefit_reversal reversal ON reversal.original_finance_document_id=base.document_id::uuid
               LEFT JOIN finance_document reversal_document ON reversal_document.id=reversal.reversal_finance_document_id
               LEFT JOIN ledger_event reversal_ledger ON reversal_ledger.id=reversal.reversal_ledger_event_id`,
            [document],
          )
        ).rows[0],
        "FINANCE_DOCUMENT_NOT_FOUND",
      );
      const detail = confirmationFrom(row);
      if (
        row.document_kind !== "CASH_WAGE" ||
        row.ledger_type !== "CASH_WAGE_CONFIRMED" ||
        row.ledger_key !== `cash-wage:${document}` ||
        count(row.completion_event_count) !== 1 ||
        count(row.ledger_entry_count) !== 1 ||
        count(row.deduction_entry_count) !== 1 ||
        row.deduction_amount === null ||
        BigInt(row.deduction_amount) !== -BigInt(detail.deductionCents)
      )
        fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
      const reversed = detail.status === "REVERSED";
      if (
        reversed !== (row.reversal_ledger_event_id !== null) ||
        (reversed &&
          (row.original_ledger_event_id !== row.ledger_event_id ||
            row.reversal_document_kind !== "CASH_WAGE" ||
            row.reversal_document_status !== "COMPLETED" ||
            row.reversal_document_version === null ||
            row.reversal_event_type !== "SALARY_BENEFIT_REVERSED" ||
            row.reversal_event_key !==
              `salary-benefit-reversal:${row.reversal_document_id}` ||
            count(row.reversal_document_event_count) !== 1 ||
            count(row.original_reversed_event_count) !== 1 ||
            count(row.reversal_entry_count) !== 1 ||
            count(row.correction_entry_count) !== 1 ||
            row.correction_amount === null ||
            BigInt(row.correction_amount) !== BigInt(detail.deductionCents)))
      )
        fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
      const plan =
        row.plan_id === null
          ? null
          : planFrom({
              plan_id: row.plan_id,
              source_month: row.plan_source_month!,
              version_no: row.plan_version_no!,
              planned_cash_cents: row.plan_cash!,
              planned_deduction_cents: row.plan_deduction!,
              active: row.plan_active!,
              applies_to_future_months: row.plan_future!,
              reason: row.plan_reason!,
              changed_at: row.plan_changed_at!,
              changed_by_person_id: row.plan_changed_by!,
            });
      const todo = todoFrom(
        row.todo_id,
        row.todo_plan_version_id,
        row.todo_generated_at,
      );
      if ((plan === null) !== (todo === null))
        fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
      const attachmentRows = (
        await client.query<AttachmentRow>(
          `SELECT version.id::text AS version_id,binding.purpose,version.original_filename,version.detected_media_type AS media_type,version.actual_size_bytes::text AS size_bytes,version.sha256,version.status,attachment.finance_document_id::text AS attachment_document_id,binding.document_version::text AS binding_document_version,binding.bound_by_person_id::text,document.version::text AS document_version,COUNT(*) OVER()::text AS attachment_count FROM salary_benefit_attachment_binding binding JOIN finance_attachment_version version ON version.id=binding.finance_attachment_version_id JOIN finance_attachment attachment ON attachment.id=version.finance_attachment_id JOIN finance_document document ON document.id=binding.finance_document_id WHERE binding.finance_document_id=$1::uuid ORDER BY binding.purpose,version.id`,
          [document],
        )
      ).rows;
      if (attachmentRows.length !== 2 || detail.attachmentCount !== 2)
        fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
      const completedDocumentVersion =
        detail.status === "COMPLETED"
          ? positiveInt(row.version)
          : positiveInt(row.version) - 1;
      if (completedDocumentVersion < 1) fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
      const attachments = attachmentRows.map((a) => {
        if (
          !["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT"].includes(
            a.purpose,
          ) ||
          a.status !== "READY" ||
          a.attachment_document_id !== document ||
          a.bound_by_person_id !== detail.confirmedByPersonId ||
          a.binding_document_version !== completedDocumentVersion.toString() ||
          a.document_version !== row.version ||
          a.media_type === null ||
          a.size_bytes === null ||
          a.sha256 === null ||
          !/^[0-9a-f]{64}$/.test(a.sha256) ||
          !["application/pdf", "image/png", "image/jpeg"].includes(
            a.media_type,
          ) ||
          nonNegative(a.size_bytes) < 1n
        )
          fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
        return {
          versionId: uuid(a.version_id),
          purpose: a.purpose as
            "SUPPORTING_DOCUMENT" | "APPLICATION_SCREENSHOT",
          originalFilename: display(a.original_filename),
          mediaType: a.media_type as
            "application/pdf" | "image/png" | "image/jpeg",
          sizeBytes: Number(nonNegative(a.size_bytes)),
          sha256: a.sha256 as string,
        };
      });
      if (new Set(attachments.map((a) => a.purpose)).size !== 2)
        fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
      return { ...detail, plan, todo, attachments };
    });
  }
}
