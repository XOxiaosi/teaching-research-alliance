import type { RoleContext } from "@teaching-research-alliance/contracts";
import type {
  PostgresClient,
  PostgresPool,
} from "./postgres-ledger-repository.js";

type BenefitKind = "SOCIAL_INSURANCE" | "HOUSING_FUND";
type AttachmentPurpose = "SUPPORTING_DOCUMENT" | "APPLICATION_SCREENSHOT";

export type BenefitPlanVersion = Readonly<{
  id: string;
  version: number;
  executionDay: number;
  amountCents: string;
  sourceFund: Readonly<{ id: string; code: string; displayName: string }>;
  active: boolean;
  reason: string;
  changedAt: string;
  changedByPersonId: string;
}>;
export type BenefitTodo = Readonly<{
  id: string;
  planVersionId: string;
  generatedAt: string;
}>;
export type BenefitReversal = Readonly<{
  documentId: string;
  reason: string;
  reversedAt: string;
  reversedByPersonId: string;
}>;
export type BenefitExecution = Readonly<{
  documentId: string;
  status: "COMPLETED" | "REVERSED";
  version: number;
  planVersionId: string;
  sourceFund: Readonly<{ id: string; code: string; displayName: string }>;
  amountCents: string;
  executedByPersonId: string;
  executedByDisplayName: string;
  executedAt: string;
  reason: string;
  reversal: BenefitReversal | null;
}>;
export type BenefitRosterItem = Readonly<{
  benefitKind: BenefitKind;
  beneficiaryPersonId: string;
  beneficiaryDisplayName: string;
  benefitMonth: string;
  planVersions: readonly BenefitPlanVersion[];
  currentPlan: BenefitPlanVersion;
  todo: BenefitTodo | null;
  execution: BenefitExecution | null;
  status:
    | "INACTIVE"
    | "SCHEDULED"
    | "DUE_NOT_GENERATED"
    | "PENDING"
    | "COMPLETED"
    | "REVERSED";
}>;
export type BenefitAttachment = Readonly<{
  versionId: string;
  purpose: AttachmentPurpose;
  originalFilename: string;
  mediaType: "application/pdf" | "image/png" | "image/jpeg";
  sizeBytes: number;
  sha256: string;
}>;
export type BenefitDetail = BenefitExecution &
  Readonly<{
    benefitKind: BenefitKind;
    beneficiaryPersonId: string;
    beneficiaryDisplayName: string;
    benefitMonth: string;
    todo: BenefitTodo;
    todoPlan: BenefitPlanVersion;
    executionPlan: BenefitPlanVersion;
    attachments: readonly BenefitAttachment[];
    reversalAttachments: readonly BenefitAttachment[];
  }>;
/** Optional read-only query observation for integration tests. */
export type BenefitRosterReadQueryObserver = (
  query: "ROSTER" | "DETAILS" | "ATTACHMENTS",
) => void;

type RosterRow = Readonly<{
  benefit_kind: string;
  beneficiary_person_id: string;
  beneficiary_display_name: string | null;
  plan_id: string;
  version_no: string;
  execution_day: string;
  amount_cents: string;
  source_fund_id: string;
  source_fund_code: string | null;
  source_fund_display_name: string | null;
  active: boolean;
  reason: string;
  changed_at: string;
  changed_by_person_id: string;
  current_plan_id: string;
  todo_id: string | null;
  todo_plan_version_id: string | null;
  todo_generated_at: string | null;
  execution_document_id: string | null;
  execution_status: string | null;
  execution_version: string | null;
  execution_plan_version_id: string | null;
  execution_source_fund_id: string | null;
  execution_source_fund_code: string | null;
  execution_source_fund_display_name: string | null;
  execution_amount_cents: string | null;
  executed_by_person_id: string | null;
  executed_by_display_name: string | null;
  execution_reason: string | null;
  executed_at: string | null;
  reversal_document_id: string | null;
  reversal_reason: string | null;
  reversal_created_at: string | null;
  reversed_by_person_id: string | null;
}>;
type DetailRow = Readonly<{
  document_id: string;
  document_kind: string;
  document_status: string;
  document_version: string;
  applicant_person_id: string;
  benefit_kind: string;
  beneficiary_person_id: string;
  beneficiary_display_name: string | null;
  benefit_month: string;
  todo_id: string;
  todo_plan_version_id: string;
  todo_generated_at: string;
  todo_plan_kind: string;
  todo_plan_beneficiary_id: string;
  todo_plan_month: string;
  todo_plan_version_no: string;
  todo_plan_execution_day: string;
  todo_plan_amount_cents: string;
  todo_plan_source_fund_id: string;
  todo_plan_source_fund_code: string | null;
  todo_plan_source_fund_display_name: string | null;
  todo_plan_active: boolean;
  todo_plan_reason: string;
  todo_plan_changed_at: string;
  todo_plan_changed_by_person_id: string;
  execution_plan_version_id: string;
  execution_plan_kind: string;
  execution_plan_beneficiary_id: string;
  execution_plan_month: string;
  execution_plan_version_no: string;
  execution_plan_execution_day: string;
  execution_plan_amount_cents: string;
  execution_plan_source_fund_id: string;
  execution_plan_source_fund_code: string | null;
  execution_plan_source_fund_display_name: string | null;
  execution_plan_active: boolean;
  execution_plan_reason: string;
  execution_plan_changed_at: string;
  execution_plan_changed_by_person_id: string;
  source_fund_id: string;
  source_account_id: string;
  source_account_code: string | null;
  source_owner_type: string | null;
  source_owner_id: string | null;
  amount_cents: string;
  ledger_event_id: string;
  executed_by_person_id: string;
  executed_by_display_name: string | null;
  reason: string;
  executed_at: string;
  original_event_type: string | null;
  original_event_key: string | null;
  original_entry_count: string;
  original_expense_count: string;
  original_expense_amount: string | null;
  completed_event_count: string;
  completed_event_actor_count: string;
  reversal_document_id: string | null;
  reversal_original_ledger_event_id: string | null;
  reversal_ledger_event_id: string | null;
  reversal_reason: string | null;
  reversal_created_at: string | null;
  reversed_by_person_id: string | null;
  reversal_document_kind: string | null;
  reversal_document_status: string | null;
  reversal_document_version: string | null;
  reversal_document_applicant_person_id: string | null;
  reversal_event_type: string | null;
  reversal_event_key: string | null;
  reversal_entry_count: string;
  reversal_expense_count: string;
  reversal_expense_amount: string | null;
  reversal_completed_event_count: string;
  reversal_completed_event_actor_count: string;
  original_reversed_event_count: string;
  original_reversed_event_actor_count: string;
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
}>;
type DetailPreloaded = Readonly<{
  row: DetailRow;
  attachmentsByDocument: ReadonlyMap<string, readonly AttachmentRow[]>;
}>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONTH = /^\d{4}-\d{2}-01$/;
const fail = (code: string): never => {
  throw new Error(code);
};
const unavailable = (): never => fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
const present = <T>(value: T | null | undefined): T =>
  value === null || value === undefined ? unavailable() : value;
const validUuid = (value: string | null): string => {
  if (value === null || !UUID.test(value)) unavailable();
  return present(value);
};
const validMonth = (value: string): string => {
  if (!MONTH.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
    unavailable();
  return value;
};
const inputMonth = (value: string): string => {
  if (!MONTH.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
    fail("INVALID_INPUT");
  return value;
};
const validTimestamp = (value: string | null): string => {
  if (value === null || !Number.isFinite(new Date(value).getTime()))
    unavailable();
  return new Date(present(value)).toISOString();
};
const positive = (value: string | null): bigint => {
  if (value === null || !/^[1-9][0-9]*$/.test(value)) unavailable();
  return BigInt(present(value));
};
const positiveInteger = (value: string | null): number => {
  if (value === null || !/^[1-9][0-9]*$/.test(value)) unavailable();
  const result = Number(value);
  if (!Number.isSafeInteger(result)) unavailable();
  return result;
};
const count = (value: string | null): number => {
  if (value === null || !/^[0-9]+$/.test(value)) unavailable();
  const result = Number(value);
  if (!Number.isSafeInteger(result)) unavailable();
  return result;
};
const text = (value: string | null): string => {
  if (value === null || !value.trim() || /[\u0000-\u001f\u007f]/.test(value))
    unavailable();
  return present(value).trim();
};
const benefitKind = (value: string): BenefitKind => {
  if (value !== "SOCIAL_INSURANCE" && value !== "HOUSING_FUND") unavailable();
  return value as BenefitKind;
};
const managed = (context: RoleContext): boolean =>
  ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"].includes(
    context.subject,
  ) &&
  context.scope === "GLOBAL" &&
  context.regionId === undefined &&
  context.campusId === undefined &&
  context.venueId === undefined;
const bjt = (at: Date): Readonly<{ month: string; day: number }> => {
  if (!Number.isFinite(at.getTime())) fail("INVALID_INPUT");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const part = (name: string) =>
    parts.find((item) => item.type === name)?.value;
  const year = part("year"),
    month = part("month"),
    day = part("day");
  if (!year || !month || !day) fail("INVALID_INPUT");
  return { month: `${year}-${month}-01`, day: Number(day) };
};
const daysInMonth = (value: string): number => {
  const [year, month] = value.split("-").map(Number);
  return new Date(Date.UTC(year!, month!, 0)).getUTCDate();
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
const planFrom = (row: {
  id: string;
  version: string;
  executionDay: string;
  amount: string;
  fundId: string;
  fundCode: string | null;
  fundName: string | null;
  active: boolean;
  reason: string;
  changedAt: string;
  changedBy: string;
}): BenefitPlanVersion => {
  const executionDay = positiveInteger(row.executionDay);
  if (executionDay > 31) unavailable();
  return {
    id: validUuid(row.id),
    version: positiveInteger(row.version),
    executionDay,
    amountCents: positive(row.amount).toString(),
    sourceFund: {
      id: validUuid(row.fundId),
      code: text(row.fundCode),
      displayName: text(row.fundName),
    },
    active: row.active,
    reason: text(row.reason),
    changedAt: validTimestamp(row.changedAt),
    changedByPersonId: validUuid(row.changedBy),
  };
};
const todoFrom = (
  id: string | null,
  planVersionId: string | null,
  generatedAt: string | null,
): BenefitTodo | null => {
  if (id === null && planVersionId === null && generatedAt === null)
    return null;
  if (id === null || planVersionId === null || generatedAt === null)
    unavailable();
  return {
    id: validUuid(id),
    planVersionId: validUuid(planVersionId),
    generatedAt: validTimestamp(generatedAt),
  };
};
const executionFrom = (row: RosterRow): BenefitExecution | null => {
  const values = [
    row.execution_document_id,
    row.execution_status,
    row.execution_version,
    row.execution_plan_version_id,
    row.execution_source_fund_id,
    row.execution_source_fund_code,
    row.execution_source_fund_display_name,
    row.execution_amount_cents,
    row.executed_by_person_id,
    row.executed_by_display_name,
    row.execution_reason,
    row.executed_at,
  ];
  if (values.every((value) => value === null)) return null;
  if (values.some((value) => value === null)) unavailable();
  if (
    row.execution_status !== "COMPLETED" &&
    row.execution_status !== "REVERSED"
  )
    unavailable();
  const reversed = row.execution_status === "REVERSED";
  if (
    reversed !== (row.reversal_document_id !== null) ||
    (!reversed &&
      (row.reversal_reason !== null ||
        row.reversal_created_at !== null ||
        row.reversed_by_person_id !== null))
  )
    unavailable();
  const reversal = !reversed
    ? null
    : {
        documentId: validUuid(row.reversal_document_id),
        reason: text(row.reversal_reason),
        reversedAt: validTimestamp(row.reversal_created_at),
        reversedByPersonId: validUuid(row.reversed_by_person_id),
      };
  return {
    documentId: validUuid(row.execution_document_id),
    status: row.execution_status as "COMPLETED" | "REVERSED",
    version: positiveInteger(row.execution_version),
    planVersionId: validUuid(row.execution_plan_version_id),
    sourceFund: {
      id: validUuid(row.execution_source_fund_id),
      code: text(row.execution_source_fund_code),
      displayName: text(row.execution_source_fund_display_name),
    },
    amountCents: positive(row.execution_amount_cents).toString(),
    executedByPersonId: validUuid(row.executed_by_person_id),
    executedByDisplayName: text(row.executed_by_display_name),
    executedAt: validTimestamp(row.executed_at),
    reason: text(row.execution_reason),
    reversal,
  };
};

const rosterSql = `WITH current_plan AS (
  SELECT DISTINCT ON (benefit_kind,beneficiary_person_id,benefit_month)
    id,benefit_kind,beneficiary_person_id,benefit_month
  FROM finance_benefit_plan_version
  WHERE benefit_month=$1::date
  ORDER BY benefit_kind,beneficiary_person_id,benefit_month,version_no DESC,id DESC
), execution AS (
  SELECT execution.*,document.status AS document_status,document.version::text AS document_version,
    fund.fund_code,fund.display_name,operator.nickname AS operator_name,
    reversal.reversal_finance_document_id::text AS reversal_document_id,
    reversal.reason AS reversal_reason,reversal.created_at::text AS reversal_created_at,
    reversal.reversed_by_person_id::text AS reversed_by_person_id
  FROM finance_benefit_execution execution
  JOIN finance_document document ON document.id=execution.finance_document_id
  JOIN company_finance_fund fund ON fund.id=execution.source_fund_id
  JOIN person operator ON operator.id=execution.executed_by_person_id
  LEFT JOIN salary_benefit_reversal reversal ON reversal.original_finance_document_id=execution.finance_document_id
)
SELECT plan.benefit_kind,plan.beneficiary_person_id::text,beneficiary.nickname AS beneficiary_display_name,
  plan.id::text AS plan_id,plan.version_no::text,plan.execution_day::text,plan.amount_cents::text,
  plan.source_fund_id::text,fund.fund_code AS source_fund_code,fund.display_name AS source_fund_display_name,
  plan.active,plan.reason,plan.changed_at::text,plan.changed_by_person_id::text,current_plan.id::text AS current_plan_id,
  todo.id::text AS todo_id,todo.plan_version_id::text AS todo_plan_version_id,todo.generated_at::text AS todo_generated_at,
  execution.finance_document_id::text AS execution_document_id,execution.document_status AS execution_status,execution.document_version AS execution_version,
  execution.plan_version_id::text AS execution_plan_version_id,execution.source_fund_id::text AS execution_source_fund_id,
  execution.fund_code AS execution_source_fund_code,execution.display_name AS execution_source_fund_display_name,
  execution.amount_cents::text AS execution_amount_cents,execution.executed_by_person_id::text,execution.operator_name AS executed_by_display_name,
  execution.reason AS execution_reason,execution.created_at::text AS executed_at,
  execution.reversal_document_id,execution.reversal_reason,execution.reversal_created_at,execution.reversed_by_person_id
FROM finance_benefit_plan_version plan
JOIN current_plan ON current_plan.id=plan.id OR (current_plan.benefit_kind=plan.benefit_kind AND current_plan.beneficiary_person_id=plan.beneficiary_person_id AND current_plan.benefit_month=plan.benefit_month)
JOIN person beneficiary ON beneficiary.id=plan.beneficiary_person_id
JOIN company_finance_fund fund ON fund.id=plan.source_fund_id
LEFT JOIN finance_benefit_todo todo ON todo.benefit_kind=plan.benefit_kind AND todo.beneficiary_person_id=plan.beneficiary_person_id AND todo.benefit_month=plan.benefit_month
LEFT JOIN execution ON execution.todo_id=todo.id
WHERE plan.benefit_month=$1::date
ORDER BY plan.benefit_kind,beneficiary.nickname,plan.beneficiary_person_id,plan.version_no,plan.id`;
const detailSql = `WITH base AS (
 SELECT document.id::text AS document_id,document.kind AS document_kind,document.status AS document_status,document.version::text AS document_version,document.applicant_person_id::text,
   execution.finance_document_id,execution.todo_id::text,execution.plan_version_id::text AS execution_plan_version_id,
   execution.source_fund_id::text,execution.source_account_id::text,source.account_code AS source_account_code,source.owner_type AS source_owner_type,source.owner_id::text AS source_owner_id,
   execution.amount_cents::text,execution.ledger_event_id::text,execution.executed_by_person_id::text,operator.nickname AS executed_by_display_name,execution.reason,execution.created_at::text AS executed_at,
   todo.plan_version_id::text AS todo_plan_version_id,todo.generated_at::text AS todo_generated_at,
   todo_plan.benefit_kind AS todo_plan_kind,todo_plan.beneficiary_person_id::text AS todo_plan_beneficiary_id,todo_plan.benefit_month::text AS todo_plan_month,
   todo_plan.version_no::text AS todo_plan_version_no,todo_plan.execution_day::text AS todo_plan_execution_day,todo_plan.amount_cents::text AS todo_plan_amount_cents,
   todo_plan.source_fund_id::text AS todo_plan_source_fund_id,todo_fund.fund_code AS todo_plan_source_fund_code,todo_fund.display_name AS todo_plan_source_fund_display_name,
   todo_plan.active AS todo_plan_active,todo_plan.reason AS todo_plan_reason,todo_plan.changed_at::text AS todo_plan_changed_at,todo_plan.changed_by_person_id::text AS todo_plan_changed_by_person_id,
   plan.benefit_kind,plan.beneficiary_person_id::text,beneficiary.nickname AS beneficiary_display_name,plan.benefit_month::text,
   plan.benefit_kind AS execution_plan_kind,plan.beneficiary_person_id::text AS execution_plan_beneficiary_id,plan.benefit_month::text AS execution_plan_month,
   plan.version_no::text AS execution_plan_version_no,plan.execution_day::text AS execution_plan_execution_day,plan.amount_cents::text AS execution_plan_amount_cents,
   plan.source_fund_id::text AS execution_plan_source_fund_id,plan_fund.fund_code AS execution_plan_source_fund_code,plan_fund.display_name AS execution_plan_source_fund_display_name,
   plan.active AS execution_plan_active,plan.reason AS execution_plan_reason,plan.changed_at::text AS execution_plan_changed_at,plan.changed_by_person_id::text AS execution_plan_changed_by_person_id
 FROM finance_document document
 JOIN finance_benefit_execution execution ON execution.finance_document_id=document.id
 JOIN finance_benefit_todo todo ON todo.id=execution.todo_id
 JOIN finance_benefit_plan_version todo_plan ON todo_plan.id=todo.plan_version_id
 JOIN finance_benefit_plan_version plan ON plan.id=execution.plan_version_id
 JOIN person beneficiary ON beneficiary.id=plan.beneficiary_person_id
 JOIN person operator ON operator.id=execution.executed_by_person_id
 JOIN company_finance_fund todo_fund ON todo_fund.id=todo_plan.source_fund_id
 JOIN company_finance_fund plan_fund ON plan_fund.id=plan.source_fund_id
 JOIN settlement_account source ON source.id=execution.source_account_id
WHERE document.id = ANY($1::uuid[])
)
SELECT base.*,original_event.event_type AS original_event_type,original_event.event_key AS original_event_key,
  (SELECT COUNT(*)::text FROM ledger_entry WHERE event_id=base.ledger_event_id::uuid) AS original_entry_count,
  (SELECT COUNT(*)::text FROM ledger_entry WHERE event_id=base.ledger_event_id::uuid AND account_id=base.source_account_id::uuid AND category_key='financeBenefitExpense') AS original_expense_count,
  (SELECT amount_cents::text FROM ledger_entry WHERE event_id=base.ledger_event_id::uuid AND account_id=base.source_account_id::uuid AND category_key='financeBenefitExpense') AS original_expense_amount,
  (SELECT COUNT(*)::text FROM finance_document_event event WHERE event.finance_document_id=base.document_id::uuid AND event.event_type='SALARY_BENEFIT_COMPLETED' AND event.result_document_version=CASE WHEN base.document_status='REVERSED' THEN base.document_version::bigint-1 ELSE base.document_version::bigint END AND event.ledger_event_id=base.ledger_event_id::uuid) AS completed_event_count,
  (SELECT COUNT(*)::text FROM finance_document_event event WHERE event.finance_document_id=base.document_id::uuid AND event.event_type='SALARY_BENEFIT_COMPLETED' AND event.result_document_version=CASE WHEN base.document_status='REVERSED' THEN base.document_version::bigint-1 ELSE base.document_version::bigint END AND event.ledger_event_id=base.ledger_event_id::uuid AND event.actor_person_id=base.executed_by_person_id::uuid) AS completed_event_actor_count,
  reversal.reversal_finance_document_id::text AS reversal_document_id,reversal.original_ledger_event_id::text AS reversal_original_ledger_event_id,reversal.reversal_ledger_event_id::text AS reversal_ledger_event_id,reversal.reason AS reversal_reason,reversal.created_at::text AS reversal_created_at,reversal.reversed_by_person_id::text,
  reversal_document.kind AS reversal_document_kind,reversal_document.status AS reversal_document_status,reversal_document.version::text AS reversal_document_version,reversal_document.applicant_person_id::text AS reversal_document_applicant_person_id,
  reversal_event.event_type AS reversal_event_type,reversal_event.event_key AS reversal_event_key,
  (SELECT COUNT(*)::text FROM ledger_entry WHERE event_id=reversal.reversal_ledger_event_id) AS reversal_entry_count,
  (SELECT COUNT(*)::text FROM ledger_entry WHERE event_id=reversal.reversal_ledger_event_id AND account_id=base.source_account_id::uuid AND category_key='financeBenefitExpenseReversal') AS reversal_expense_count,
  (SELECT amount_cents::text FROM ledger_entry WHERE event_id=reversal.reversal_ledger_event_id AND account_id=base.source_account_id::uuid AND category_key='financeBenefitExpenseReversal') AS reversal_expense_amount,
  (SELECT COUNT(*)::text FROM finance_document_event event WHERE event.finance_document_id=reversal.reversal_finance_document_id AND event.event_type='SALARY_BENEFIT_COMPLETED' AND event.result_document_version=reversal_document.version AND event.ledger_event_id=reversal.reversal_ledger_event_id) AS reversal_completed_event_count,
  (SELECT COUNT(*)::text FROM finance_document_event event WHERE event.finance_document_id=reversal.reversal_finance_document_id AND event.event_type='SALARY_BENEFIT_COMPLETED' AND event.result_document_version=reversal_document.version AND event.ledger_event_id=reversal.reversal_ledger_event_id AND event.actor_person_id=reversal.reversed_by_person_id) AS reversal_completed_event_actor_count,
  (SELECT COUNT(*)::text FROM finance_document_event event WHERE event.finance_document_id=base.document_id::uuid AND event.event_type='SALARY_BENEFIT_REVERSED' AND event.result_document_version=base.document_version::bigint AND event.ledger_event_id=reversal.reversal_ledger_event_id) AS original_reversed_event_count,
  (SELECT COUNT(*)::text FROM finance_document_event event WHERE event.finance_document_id=base.document_id::uuid AND event.event_type='SALARY_BENEFIT_REVERSED' AND event.result_document_version=base.document_version::bigint AND event.ledger_event_id=reversal.reversal_ledger_event_id AND event.actor_person_id=reversal.reversed_by_person_id) AS original_reversed_event_actor_count
FROM base
LEFT JOIN ledger_event original_event ON original_event.id=base.ledger_event_id::uuid
LEFT JOIN salary_benefit_reversal reversal ON reversal.original_finance_document_id=base.document_id::uuid
LEFT JOIN finance_document reversal_document ON reversal_document.id=reversal.reversal_finance_document_id
LEFT JOIN ledger_event reversal_event ON reversal_event.id=reversal.reversal_ledger_event_id`;
const attachmentRowsSql = `SELECT version.id::text AS version_id,binding.purpose,version.original_filename,version.detected_media_type AS media_type,version.actual_size_bytes::text AS size_bytes,version.sha256,version.status,attachment.finance_document_id::text AS attachment_document_id,binding.document_version::text AS binding_document_version,binding.bound_by_person_id::text,document.version::text AS document_version
 FROM salary_benefit_attachment_binding binding
 JOIN finance_attachment_version version ON version.id=binding.finance_attachment_version_id
 JOIN finance_attachment attachment ON attachment.id=version.finance_attachment_id
 JOIN finance_document document ON document.id=binding.finance_document_id
WHERE binding.finance_document_id = ANY($1::uuid[])
ORDER BY attachment.finance_document_id,binding.purpose,version.id`;

export class PostgresBenefitReadService {
  public constructor(
    private readonly pool: PostgresPool,
    private readonly observeRosterQuery?: BenefitRosterReadQueryObserver,
  ) {}

  public async listRoster(
    context: RoleContext,
    benefitMonth: string,
    at: Date,
  ): Promise<
    Readonly<{ benefitMonth: string; items: readonly BenefitRosterItem[] }>
  > {
    if (!managed(context)) fail("FORBIDDEN_SCOPE");
    const target = inputMonth(benefitMonth);
    const now = bjt(at);
    return readTx(this.pool, async (client) => {
      this.observeRosterQuery?.("ROSTER");
      const rows = (await client.query<RosterRow>(rosterSql, [target])).rows;
      const details = await this.details(
        client,
        rows.flatMap((row) =>
          row.execution_document_id === null
            ? []
            : [validUuid(row.execution_document_id)],
        ),
        this.observeRosterQuery,
      );
      const items: BenefitRosterItem[] = [];
      for (let start = 0; start < rows.length;) {
        const first = rows[start]!;
        const kind = benefitKind(first.benefit_kind);
        const beneficiary = validUuid(first.beneficiary_person_id);
        let end = start + 1;
        while (
          end < rows.length &&
          rows[end]!.benefit_kind === first.benefit_kind &&
          rows[end]!.beneficiary_person_id === first.beneficiary_person_id
        )
          end += 1;
        const grouped = rows.slice(start, end);
        const plans = grouped.map((row) =>
          planFrom({
            id: row.plan_id,
            version: row.version_no,
            executionDay: row.execution_day,
            amount: row.amount_cents,
            fundId: row.source_fund_id,
            fundCode: row.source_fund_code,
            fundName: row.source_fund_display_name,
            active: row.active,
            reason: row.reason,
            changedAt: row.changed_at,
            changedBy: row.changed_by_person_id,
          }),
        );
        const current = present(
          plans.find((plan) => plan.id === first.current_plan_id),
        );
        if (plans.filter((p) => p.id === current.id).length !== 1)
          unavailable();
        if (current.executionDay > daysInMonth(target)) unavailable();
        const todo = todoFrom(
          first.todo_id,
          first.todo_plan_version_id,
          first.todo_generated_at,
        );
        const execution = executionFrom(first);
        if (execution !== null) {
          const detail = present(details.get(execution.documentId));
          const sameReversal =
            execution.reversal === null
              ? detail.reversal === null
              : detail.reversal !== null &&
                execution.reversal.documentId === detail.reversal.documentId &&
                execution.reversal.reason === detail.reversal.reason &&
                execution.reversal.reversedAt === detail.reversal.reversedAt &&
                execution.reversal.reversedByPersonId ===
                  detail.reversal.reversedByPersonId;
          if (
            detail.benefitKind !== kind ||
            detail.beneficiaryPersonId !== beneficiary ||
            detail.beneficiaryDisplayName !==
              text(first.beneficiary_display_name) ||
            detail.benefitMonth !== target ||
            todo === null ||
            detail.todo.id !== todo.id ||
            detail.todo.planVersionId !== todo.planVersionId ||
            detail.todo.generatedAt !== todo.generatedAt ||
            detail.documentId !== execution.documentId ||
            detail.status !== execution.status ||
            detail.version !== execution.version ||
            detail.planVersionId !== execution.planVersionId ||
            detail.sourceFund.id !== execution.sourceFund.id ||
            detail.sourceFund.code !== execution.sourceFund.code ||
            detail.sourceFund.displayName !==
              execution.sourceFund.displayName ||
            detail.amountCents !== execution.amountCents ||
            detail.executedByPersonId !== execution.executedByPersonId ||
            detail.executedByDisplayName !== execution.executedByDisplayName ||
            detail.executedAt !== execution.executedAt ||
            detail.reason !== execution.reason ||
            !sameReversal ||
            !plans.some(
              (plan) =>
                plan.id === detail.executionPlan.id &&
                plan.version === detail.executionPlan.version &&
                plan.amountCents === detail.executionPlan.amountCents &&
                plan.sourceFund.id === detail.executionPlan.sourceFund.id,
            )
          )
            unavailable();
        }
        for (const row of grouped) {
          if (
            row.current_plan_id !== first.current_plan_id ||
            row.todo_id !== first.todo_id ||
            row.execution_document_id !== first.execution_document_id
          )
            unavailable();
        }
        const status =
          execution?.status === "REVERSED"
            ? "REVERSED"
            : execution?.status === "COMPLETED"
              ? "COMPLETED"
              : !current.active
                ? "INACTIVE"
                : todo !== null
                  ? "PENDING"
                  : now.month > target ||
                      (now.month === target && now.day >= current.executionDay)
                    ? "DUE_NOT_GENERATED"
                    : "SCHEDULED";
        items.push({
          benefitKind: kind,
          beneficiaryPersonId: beneficiary,
          beneficiaryDisplayName: text(first.beneficiary_display_name),
          benefitMonth: target,
          planVersions: plans,
          currentPlan: current,
          todo,
          execution,
          status,
        });
        start = end;
      }
      return { benefitMonth: target, items };
    });
  }

  public async getDetail(
    context: RoleContext,
    id: string,
  ): Promise<BenefitDetail> {
    if (!managed(context)) fail("FORBIDDEN_SCOPE");
    if (!UUID.test(id)) fail("INVALID_INPUT");
    return readTx(this.pool, async (client) => {
      const exists = await client.query<{ id: string }>(
        "SELECT id::text AS id FROM finance_document WHERE id=$1::uuid",
        [id],
      );
      if (exists.rows[0] === undefined) fail("FINANCE_DOCUMENT_NOT_FOUND");
      return this.detail(client, id);
    });
  }

  private async detail(
    client: PostgresClient,
    id: string,
    preloaded?: DetailPreloaded,
  ): Promise<BenefitDetail> {
    const row =
      preloaded?.row ??
      present((await client.query<DetailRow>(detailSql, [[id]])).rows[0]);
    const amount = positive(row.amount_cents);
    if (
      row.document_kind !== "FINANCE_BENEFIT" ||
      (row.document_status !== "COMPLETED" &&
        row.document_status !== "REVERSED") ||
      row.applicant_person_id !== row.executed_by_person_id ||
      benefitKind(row.benefit_kind) !== benefitKind(row.todo_plan_kind) ||
      row.benefit_kind !== row.execution_plan_kind ||
      row.beneficiary_person_id !== row.todo_plan_beneficiary_id ||
      row.beneficiary_person_id !== row.execution_plan_beneficiary_id ||
      validMonth(row.benefit_month) !== validMonth(row.todo_plan_month) ||
      row.benefit_month !== row.execution_plan_month ||
      row.source_fund_id !== row.execution_plan_source_fund_id ||
      row.source_owner_type !== "COMPANY" ||
      row.source_owner_id !== row.source_fund_id ||
      row.source_account_code !== `company:fund:${row.source_fund_id}` ||
      row.original_event_type !== "FINANCE_BENEFIT_EXECUTED" ||
      row.original_event_key !== `finance-benefit:${id}` ||
      count(row.original_entry_count) !== 1 ||
      count(row.original_expense_count) !== 1 ||
      row.original_expense_amount === null ||
      BigInt(row.original_expense_amount) !== -amount ||
      count(row.completed_event_count) !== 1 ||
      count(row.completed_event_actor_count) !== 1
    )
      unavailable();
    const todoPlan = planFrom({
      id: row.todo_plan_version_id,
      version: row.todo_plan_version_no,
      executionDay: row.todo_plan_execution_day,
      amount: row.todo_plan_amount_cents,
      fundId: row.todo_plan_source_fund_id,
      fundCode: row.todo_plan_source_fund_code,
      fundName: row.todo_plan_source_fund_display_name,
      active: row.todo_plan_active,
      reason: row.todo_plan_reason,
      changedAt: row.todo_plan_changed_at,
      changedBy: row.todo_plan_changed_by_person_id,
    });
    const executionPlan = planFrom({
      id: row.execution_plan_version_id,
      version: row.execution_plan_version_no,
      executionDay: row.execution_plan_execution_day,
      amount: row.execution_plan_amount_cents,
      fundId: row.execution_plan_source_fund_id,
      fundCode: row.execution_plan_source_fund_code,
      fundName: row.execution_plan_source_fund_display_name,
      active: row.execution_plan_active,
      reason: row.execution_plan_reason,
      changedAt: row.execution_plan_changed_at,
      changedBy: row.execution_plan_changed_by_person_id,
    });
    if (
      executionPlan.amountCents !== amount.toString() ||
      todoPlan.executionDay > daysInMonth(row.benefit_month) ||
      executionPlan.executionDay > daysInMonth(row.benefit_month)
    )
      unavailable();
    const reversed = row.document_status === "REVERSED";
    if (
      reversed !== (row.reversal_document_id !== null) ||
      (!reversed &&
        (row.reversal_original_ledger_event_id !== null ||
          row.reversal_ledger_event_id !== null ||
          row.reversal_reason !== null ||
          row.reversal_created_at !== null ||
          row.reversed_by_person_id !== null ||
          row.reversal_document_kind !== null ||
          row.reversal_document_status !== null ||
          row.reversal_document_version !== null ||
          row.reversal_event_type !== null ||
          row.reversal_event_key !== null)) ||
      (reversed &&
        (row.reversal_original_ledger_event_id !== row.ledger_event_id ||
          row.reversal_document_kind !== "FINANCE_BENEFIT" ||
          row.reversal_document_status !== "COMPLETED" ||
          row.reversal_document_version === null ||
          row.reversal_document_applicant_person_id !==
            row.reversed_by_person_id ||
          row.reversal_event_type !== "SALARY_BENEFIT_REVERSED" ||
          row.reversal_event_key !==
            `salary-benefit-reversal:${row.reversal_document_id}` ||
          count(row.reversal_entry_count) !== 1 ||
          count(row.reversal_expense_count) !== 1 ||
          row.reversal_expense_amount === null ||
          BigInt(row.reversal_expense_amount) !== amount ||
          count(row.reversal_completed_event_count) !== 1 ||
          count(row.reversal_completed_event_actor_count) !== 1 ||
          count(row.original_reversed_event_count) !== 1 ||
          count(row.original_reversed_event_actor_count) !== 1))
    )
      unavailable();
    const attachments =
      preloaded === undefined
        ? await this.attachments(
            client,
            id,
            positiveInteger(row.document_version) - (reversed ? 1 : 0),
            row.executed_by_person_id,
            positiveInteger(row.document_version),
          )
        : this.attachmentsFromRows(
            preloaded.attachmentsByDocument.get(id) ?? [],
            id,
            positiveInteger(row.document_version) - (reversed ? 1 : 0),
            row.executed_by_person_id,
            positiveInteger(row.document_version),
          );
    if (positiveInteger(row.document_version) - (reversed ? 1 : 0) < 1)
      unavailable();
    const reversalAttachments = !reversed
      ? []
      : preloaded === undefined
        ? await this.attachments(
            client,
            validUuid(row.reversal_document_id),
            positiveInteger(row.reversal_document_version),
            validUuid(row.reversed_by_person_id),
            positiveInteger(row.reversal_document_version),
          )
        : this.attachmentsFromRows(
            preloaded.attachmentsByDocument.get(
              validUuid(row.reversal_document_id),
            ) ?? [],
            validUuid(row.reversal_document_id),
            positiveInteger(row.reversal_document_version),
            validUuid(row.reversed_by_person_id),
            positiveInteger(row.reversal_document_version),
          );
    return {
      documentId: validUuid(row.document_id),
      status: row.document_status as "COMPLETED" | "REVERSED",
      version: positiveInteger(row.document_version),
      planVersionId: executionPlan.id,
      sourceFund: executionPlan.sourceFund,
      amountCents: amount.toString(),
      executedByPersonId: validUuid(row.executed_by_person_id),
      executedByDisplayName: text(row.executed_by_display_name),
      executedAt: validTimestamp(row.executed_at),
      reason: text(row.reason),
      reversal: !reversed
        ? null
        : {
            documentId: validUuid(row.reversal_document_id),
            reason: text(row.reversal_reason),
            reversedAt: validTimestamp(row.reversal_created_at),
            reversedByPersonId: validUuid(row.reversed_by_person_id),
          },
      benefitKind: benefitKind(row.benefit_kind),
      beneficiaryPersonId: validUuid(row.beneficiary_person_id),
      beneficiaryDisplayName: text(row.beneficiary_display_name),
      benefitMonth: validMonth(row.benefit_month),
      todo: {
        id: validUuid(row.todo_id),
        planVersionId: todoPlan.id,
        generatedAt: validTimestamp(row.todo_generated_at),
      },
      todoPlan,
      executionPlan,
      attachments,
      reversalAttachments,
    };
  }

  /**
   * Roster validation uses exactly two set reads after the roster query: one
   * for immutable posting chains and one for all original/reversal evidence.
   */
  private async details(
    client: PostgresClient,
    documentIds: readonly string[],
    observer?: BenefitRosterReadQueryObserver,
  ): Promise<ReadonlyMap<string, BenefitDetail>> {
    const ids = [...new Set(documentIds)];
    if (ids.length === 0) return new Map();
    observer?.("DETAILS");
    const rows = (await client.query<DetailRow>(detailSql, [ids])).rows;
    if (rows.length !== ids.length) unavailable();
    const attachmentsFor = new Set<string>();
    for (const row of rows) {
      attachmentsFor.add(validUuid(row.document_id));
      if (row.reversal_document_id !== null)
        attachmentsFor.add(validUuid(row.reversal_document_id));
    }
    observer?.("ATTACHMENTS");
    const attachmentRows = (
      await client.query<AttachmentRow>(attachmentRowsSql, [
        [...attachmentsFor],
      ])
    ).rows;
    const attachmentsByDocument = new Map<string, AttachmentRow[]>();
    for (const attachment of attachmentRows) {
      const id = validUuid(attachment.attachment_document_id);
      const current = attachmentsByDocument.get(id) ?? [];
      current.push(attachment);
      attachmentsByDocument.set(id, current);
    }
    const result = new Map<string, BenefitDetail>();
    for (const row of rows) {
      const id = validUuid(row.document_id);
      if (result.has(id)) unavailable();
      result.set(
        id,
        await this.detail(client, id, { row, attachmentsByDocument }),
      );
    }
    return result;
  }

  private async attachments(
    client: PostgresClient,
    documentId: string,
    completedVersion: number,
    boundBy: string,
    currentDocumentVersion: number,
  ): Promise<readonly BenefitAttachment[]> {
    if (!Number.isSafeInteger(completedVersion) || completedVersion < 1)
      unavailable();
    const rows = (
      await client.query<AttachmentRow>(attachmentRowsSql, [[documentId]])
    ).rows;
    return this.attachmentsFromRows(
      rows,
      documentId,
      completedVersion,
      boundBy,
      currentDocumentVersion,
    );
  }

  private attachmentsFromRows(
    rows: readonly AttachmentRow[],
    documentId: string,
    completedVersion: number,
    boundBy: string,
    currentDocumentVersion: number,
  ): readonly BenefitAttachment[] {
    if (rows.length !== 2) unavailable();
    const attachments = rows.map((row) => {
      if (
        (row.purpose !== "SUPPORTING_DOCUMENT" &&
          row.purpose !== "APPLICATION_SCREENSHOT") ||
        row.status !== "READY" ||
        row.attachment_document_id !== documentId ||
        row.binding_document_version !== completedVersion.toString() ||
        row.bound_by_person_id !== boundBy ||
        row.media_type === null ||
        !["application/pdf", "image/png", "image/jpeg"].includes(
          row.media_type,
        ) ||
        row.size_bytes === null ||
        positive(row.size_bytes) < 1n ||
        row.sha256 === null ||
        !/^[0-9a-f]{64}$/.test(row.sha256) ||
        positiveInteger(row.document_version) !== currentDocumentVersion
      )
        unavailable();
      return {
        versionId: validUuid(row.version_id),
        purpose: row.purpose as AttachmentPurpose,
        originalFilename: text(row.original_filename),
        mediaType: row.media_type as BenefitAttachment["mediaType"],
        sizeBytes: Number(positive(row.size_bytes)),
        sha256: present(row.sha256),
      };
    });
    if (new Set(attachments.map((attachment) => attachment.purpose)).size !== 2)
      unavailable();
    return attachments;
  }
}
