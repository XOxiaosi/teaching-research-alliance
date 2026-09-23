import { createHash, randomUUID } from "node:crypto";
import type { RoleContext } from "@teaching-research-alliance/contracts";
import { postLedgerEvent } from "@teaching-research-alliance/domain";
import {
  LocalAttachmentStore,
  type AttachmentMediaType,
} from "./local-attachment-store.js";
import {
  createPostgresLedgerTransaction,
  type PostgresClient,
  type PostgresPool,
} from "./postgres-ledger-repository.js";

export const SALARY_BENEFIT_DOCUMENT_KINDS = [
  "CASH_WAGE",
  "PROJECT_BONUS",
  "FINANCE_BENEFIT",
] as const;
export type SalaryBenefitDocumentKind =
  (typeof SALARY_BENEFIT_DOCUMENT_KINDS)[number];
export type SalaryBenefitDocument = Readonly<{
  id: string;
  kind: SalaryBenefitDocumentKind;
  version: number;
  replay: boolean;
}>;
export type CashWagePlanDraft = Readonly<{
  teacherPersonId: string;
  salaryMonth: string;
  plannedCashCents: string;
  plannedDeductionCents: string;
  active: boolean;
  reason: string;
  applyToFutureMonths?: boolean;
}>;
export type BenefitPlanDraft = Readonly<{
  benefitKind: "SOCIAL_INSURANCE" | "HOUSING_FUND";
  beneficiaryPersonId: string;
  benefitMonth: string;
  executionDay: number;
  amountCents: string;
  sourceFundId: string;
  active: boolean;
  reason: string;
}>;
export type DueTodo = Readonly<{
  id: string;
  planVersionId: string;
  subjectPersonId: string;
  month: string;
  kind: string;
  replay?: boolean;
}>;
export type CashWageConfirmationDraft = Readonly<{
  documentId: string;
  expectedVersion: number;
  todoId: string;
  cashPaidCents: string;
  deductionCents: string;
  paidAt: string;
  reason: string;
  attachmentVersionIds: readonly string[];
  correctionOfDocumentId?: string;
}>;
export type BonusGrantDraft = Readonly<{
  documentId: string;
  expectedVersion: number;
  projectNo: number;
  projectName: string;
  projectNameVersionId?: string;
  recipientPersonId: string;
  sourceFundId: string;
  amountCents: string;
  reason: string;
  attachmentVersionIds: readonly string[];
}>;
export type BenefitConfirmationDraft = Readonly<{
  documentId: string;
  expectedVersion: number;
  todoId: string;
  reason: string;
  attachmentVersionIds: readonly string[];
}>;
export type SalaryBenefitReversalDraft = Readonly<{
  originalDocumentId: string;
  reversalDocumentId: string;
  expectedOriginalVersion: number;
  expectedReversalVersion: number;
  reason: string;
  attachmentVersionIds: readonly string[];
}>;
export type SalaryBenefitPosting = Readonly<{
  id: string;
  status: "COMPLETED";
  version: number;
  replay: boolean;
}>;

type DocumentRow = Readonly<{
  id: string;
  kind: string;
  status: string;
  version: string;
  applicant_person_id: string;
}>;
type AttachmentRow = Readonly<{
  id: string;
  attachment_id: string;
  purpose: string;
  status: string;
  detected_media_type: AttachmentMediaType | null;
  actual_size_bytes: string | null;
  sha256: string | null;
}>;
type AccountRow = Readonly<{
  id: string;
  account_code: string;
  status: string;
  owner_type: string;
  owner_id: string;
}>;
type FundRow = Readonly<{ id: string; fund_code: string; status: string }>;
type TodoRow = Readonly<{
  id: string;
  person_id: string;
  salary_month: string;
  plan_version_id: string;
  planned_cash_cents: string;
  planned_deduction_cents: string;
}>;
type BenefitTodoRow = Readonly<{
  id: string;
  plan_version_id: string;
  benefit_kind: string;
  beneficiary_person_id: string;
  benefit_month: string;
}>;
type CashWageCurrentPlanRow = Readonly<{
  id: string;
  active: boolean;
  planned_cash_cents: string;
  planned_deduction_cents: string;
  paid_cash_cents: string;
  paid_deduction_cents: string;
}>;
type BenefitCurrentPlanRow = Readonly<{
  id: string;
  active: boolean;
  amount_cents: string;
  source_fund_id: string;
}>;
type BonusProjectRow = Readonly<{
  id: string;
  version_no: string;
  display_name: string;
}>;
type ReplayRow = Readonly<{ request_hash: string; result_json: unknown }>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const REQUIRED_PURPOSES = [
  "SUPPORTING_DOCUMENT",
  "APPLICATION_SCREENSHOT",
] as const;
const MAX = 9_223_372_036_854_775_807n;
const fail = (code: string): never => {
  throw new Error(code);
};
const one = <T>(value: T | undefined, code: string): T => value ?? fail(code);
const scopeOf = (value: RoleContext): string | undefined =>
  (value as RoleContext & { scope?: string }).scope;
const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const uuid = (value: string): string => {
  if (!UUID.test(value)) fail("INVALID_INPUT");
  return value.toLowerCase();
};
const key = (value: string): string => {
  const result = value.trim();
  if (!result || result.length > 200 || /[\x00-\x1f\x7f]/.test(result))
    fail("INVALID_INPUT");
  return result;
};
const reason = (value: string): string => {
  const result = value.trim();
  if (!result || result.length > 1000 || /[\x00-\x1f\x7f]/.test(result))
    fail("INVALID_INPUT");
  return result;
};
const name = (value: string): string => {
  const result = value.trim();
  if (!result || result.length > 200 || /[\x00-\x1f\x7f]/.test(result))
    fail("INVALID_INPUT");
  return result;
};
const amount = (value: string, positive = true): bigint => {
  if (!/^[0-9]+$/.test(value) || value.length > 19) fail("INVALID_INPUT");
  const result = BigInt(value);
  if ((positive && result < 1n) || result > MAX) fail("INVALID_INPUT");
  return result;
};
const version = (value: number): number => {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value >= Number.MAX_SAFE_INTEGER
  )
    fail("INVALID_INPUT");
  return value;
};
const iso = (value: string): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail("INVALID_INPUT");
  return date.toISOString();
};
const month = (value: string): string => {
  if (
    !/^\d{4}-\d{2}-01$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  )
    fail("INVALID_INPUT");
  return value;
};
const daysInMonth = (value: string): number => {
  const [year, monthNo] = value.split("-").map(Number);
  return new Date(Date.UTC(year!, monthNo!, 0)).getUTCDate();
};
const documentKind = (value: string): SalaryBenefitDocumentKind => {
  if (!(SALARY_BENEFIT_DOCUMENT_KINDS as readonly string[]).includes(value))
    fail("INVALID_INPUT");
  return value as SalaryBenefitDocumentKind;
};
const exactVersion = (value: string): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1)
    fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
  return result;
};
const assertOperator = (context: RoleContext): string => {
  if (
    !(
      ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"] as const
    ).includes(context.subject as "HEADQUARTERS_FINANCE") ||
    scopeOf(context) !== "GLOBAL" ||
    context.regionId !== undefined ||
    context.campusId !== undefined ||
    context.venueId !== undefined
  )
    fail("FORBIDDEN_SCOPE");
  return uuid(context.personId);
};
const bjt = (at: Date): Readonly<{ month: string; day: number }> => {
  if (!Number.isFinite(at.getTime())) fail("INVALID_INPUT");
  const fields = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const read = (part: string) =>
    fields.find((item) => item.type === part)?.value;
  const y = read("year"),
    m = read("month"),
    d = read("day");
  if (!y || !m || !d) fail("INVALID_INPUT");
  return { month: `${y}-${m}-01`, day: Number(d) };
};

/** Financial-only F09/F10 writer.  No method returns wage data to a personal role. */
export class PostgresSalaryBenefitsService {
  public constructor(
    private readonly pool: PostgresPool,
    private readonly store: LocalAttachmentStore,
  ) {}

  public async createEvidenceDocument(
    context: RoleContext,
    kindInput: SalaryBenefitDocumentKind,
    idempotencyKey: string,
    at: Date,
  ): Promise<SalaryBenefitDocument> {
    const actor = assertOperator(context),
      kind = documentKind(kindInput),
      idem = key(idempotencyKey);
    const request = hash(["salary-benefit.create-document.v1", actor, kind]);
    return this.inTx(async (client) => {
      const replay = await this.replay<SalaryBenefitDocument>(
        client,
        actor,
        "CREATE_DOCUMENT",
        idem,
        request,
      );
      if (replay) return replay;
      const row = one(
        (
          await client.query<DocumentRow>(
            `INSERT INTO finance_document(applicant_person_id,kind,status,version,created_at,updated_at) VALUES($1::uuid,$2,'DRAFT',1,$3::timestamptz,$3::timestamptz) RETURNING id::text AS id,kind,status,version::text AS version,applicant_person_id::text AS applicant_person_id`,
            [actor, kind, at.toISOString()],
          )
        ).rows[0],
        "FINANCE_DOCUMENT_CREATE_FAILED",
      );
      await client.query(
        `INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,created_at) VALUES($1::uuid,'CREATED',$2::uuid,1,$3::timestamptz)`,
        [row.id, actor, at.toISOString()],
      );
      const result: SalaryBenefitDocument = {
        id: row.id,
        kind,
        version: 1,
        replay: false,
      };
      await this.record(
        client,
        actor,
        "CREATE_DOCUMENT",
        idem,
        request,
        result,
        at,
      );
      return result;
    });
  }

  public async setCashWagePlan(
    context: RoleContext,
    draft: CashWagePlanDraft,
    idempotencyKey: string,
    at: Date,
  ): Promise<DueTodo> {
    const actor = assertOperator(context),
      teacher = uuid(draft.teacherPersonId),
      salaryMonth = month(draft.salaryMonth),
      cash = amount(draft.plannedCashCents, false),
      deduction = amount(draft.plannedDeductionCents, false),
      why = reason(draft.reason),
      idem = key(idempotencyKey);
    if (cash !== deduction) fail("CASH_WAGE_AMOUNT_MISMATCH");
    if (
      draft.applyToFutureMonths !== undefined &&
      typeof draft.applyToFutureMonths !== "boolean"
    )
      fail("INVALID_INPUT");
    const applyToFutureMonths = draft.applyToFutureMonths === true;
    const request = applyToFutureMonths
      ? hash([
          "salary-benefit.set-wage-plan.v2",
          teacher,
          salaryMonth,
          cash.toString(),
          deduction.toString(),
          draft.active,
          why,
          true,
        ])
      : hash([
          "salary-benefit.set-wage-plan.v1",
          teacher,
          salaryMonth,
          cash.toString(),
          deduction.toString(),
          draft.active,
          why,
        ]);
    return this.inTx(async (client) => {
      const replay = await this.replay<DueTodo>(
        client,
        actor,
        "SET_WAGE_PLAN",
        idem,
        request,
      );
      if (replay) return replay;
      await this.requireActivePerson(client, teacher);
      // Every writer for a teacher shares this lock.  That makes a future-range edit
      // and a single-month edit serializable without changing immutable plan rows.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`cash-wage-plan-teacher:${teacher}`],
      );
      const existing = applyToFutureMonths
        ? (
            await client.query<{ salary_month: string }>(
              `SELECT DISTINCT salary_month::text AS salary_month FROM cash_wage_plan_version WHERE teacher_person_id=$1::uuid AND salary_month >= $2::date ORDER BY salary_month`,
              [teacher, salaryMonth],
            )
          ).rows.map((row) => row.salary_month)
        : [];
      const months = existing.includes(salaryMonth)
        ? existing
        : [salaryMonth, ...existing];
      let selectedPlanId: string | undefined;
      for (const targetMonth of months) {
        const current = (
          await client.query<{ n: string }>(
            `SELECT COALESCE(MAX(version_no),0)::text AS n FROM cash_wage_plan_version WHERE teacher_person_id=$1::uuid AND salary_month=$2::date`,
            [teacher, targetMonth],
          )
        ).rows[0];
        const n = Number(current?.n ?? "0") + 1;
        if (!Number.isSafeInteger(n)) fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
        const row = one(
          (
            await client.query<{ id: string }>(
              `INSERT INTO cash_wage_plan_version(teacher_person_id,salary_month,version_no,planned_cash_cents,planned_deduction_cents,active,changed_by_person_id,changed_at,reason,applies_to_future_months) VALUES($1::uuid,$2::date,$3,$4::bigint,$5::bigint,$6,$7::uuid,$8::timestamptz,$9,$10) RETURNING id::text AS id`,
              [
                teacher,
                targetMonth,
                n,
                cash.toString(),
                deduction.toString(),
                draft.active,
                actor,
                at.toISOString(),
                why,
                applyToFutureMonths && targetMonth === salaryMonth,
              ],
            )
          ).rows[0],
          "SALARY_BENEFIT_DATA_UNAVAILABLE",
        );
        if (targetMonth === salaryMonth) selectedPlanId = row.id;
      }
      const planVersionId = one(
        selectedPlanId,
        "SALARY_BENEFIT_DATA_UNAVAILABLE",
      );
      const result: DueTodo = {
        id: planVersionId,
        planVersionId,
        subjectPersonId: teacher,
        month: salaryMonth,
        kind: "CASH_WAGE_PLAN",
      };
      await this.record(
        client,
        actor,
        "SET_WAGE_PLAN",
        idem,
        request,
        result,
        at,
      );
      return result;
    });
  }

  public async generateCashWageTodos(
    context: RoleContext,
    idempotencyKey: string,
    at: Date,
  ): Promise<readonly DueTodo[]> {
    const actor = assertOperator(context),
      idem = key(idempotencyKey),
      now = bjt(at);
    const request = hash(["salary-benefit.generate-wage-todos.v1", now.month]);
    return this.inTx(async (client) => {
      const replay = await this.replay<readonly DueTodo[]>(
        client,
        actor,
        "GENERATE_WAGE_TODOS",
        idem,
        request,
      );
      if (replay) return replay;
      const rows = (
        await client.query<{
          id: string;
          plan_version_id: string;
          teacher_person_id: string;
          salary_month: string;
        }>(
          `WITH latest AS (SELECT DISTINCT ON (teacher_person_id) id,teacher_person_id,$1::date AS salary_month,active FROM cash_wage_plan_version WHERE salary_month=$1::date OR (applies_to_future_months AND salary_month<$1::date) ORDER BY teacher_person_id,(salary_month=$1::date) DESC,salary_month DESC,version_no DESC) INSERT INTO cash_wage_todo(teacher_person_id,salary_month,plan_version_id,generated_at) SELECT latest.teacher_person_id,latest.salary_month,latest.id,$2::timestamptz FROM latest LEFT JOIN cash_wage_todo todo ON todo.teacher_person_id=latest.teacher_person_id AND todo.salary_month=latest.salary_month WHERE latest.active AND todo.id IS NULL RETURNING id::text AS id,plan_version_id::text AS plan_version_id,teacher_person_id::text AS teacher_person_id,salary_month::text AS salary_month`,
          [now.month, at.toISOString()],
        )
      ).rows;
      const result = rows.map((row) => ({
        id: row.id,
        planVersionId: row.plan_version_id,
        subjectPersonId: row.teacher_person_id,
        month: row.salary_month,
        kind: "CASH_WAGE",
      }));
      await this.record(
        client,
        actor,
        "GENERATE_WAGE_TODOS",
        idem,
        request,
        result,
        at,
      );
      return result;
    });
  }

  public async confirmCashWage(
    context: RoleContext,
    draft: CashWageConfirmationDraft,
    idempotencyKey: string,
    at: Date,
  ): Promise<SalaryBenefitPosting> {
    const actor = assertOperator(context),
      doc = uuid(draft.documentId),
      todo = uuid(draft.todoId),
      expected = version(draft.expectedVersion),
      cash = amount(draft.cashPaidCents),
      deduction = amount(draft.deductionCents),
      paid = iso(draft.paidAt),
      why = reason(draft.reason),
      attachments = this.attachments(draft.attachmentVersionIds),
      idem = key(idempotencyKey),
      correction =
        draft.correctionOfDocumentId === undefined
          ? undefined
          : uuid(draft.correctionOfDocumentId);
    if (cash !== deduction) fail("CASH_WAGE_AMOUNT_MISMATCH");
    if (correction === doc) fail("INVALID_INPUT");
    const request =
      correction === undefined
        ? hash([
            "salary-benefit.confirm-wage.v1",
            doc,
            todo,
            expected,
            cash.toString(),
            deduction.toString(),
            paid,
            why,
            attachments,
          ])
        : hash([
            "salary-benefit.confirm-wage.v2",
            doc,
            todo,
            expected,
            cash.toString(),
            deduction.toString(),
            paid,
            why,
            attachments,
            correction,
          ]);
    return this.inTx(async (client) => {
      const replay = await this.replay<SalaryBenefitPosting>(
        client,
        actor,
        "CONFIRM_WAGE",
        idem,
        request,
      );
      if (replay) return { ...replay, replay: true };
      const document = await this.lockDocument(
        client,
        doc,
        actor,
        "CASH_WAGE",
        expected,
      );
      const work = one(
        (
          await client.query<TodoRow>(
            `SELECT todo.id::text AS id,todo.teacher_person_id::text AS person_id,todo.salary_month::text AS salary_month,todo.plan_version_id::text AS plan_version_id,plan.planned_cash_cents::text AS planned_cash_cents,plan.planned_deduction_cents::text AS planned_deduction_cents FROM cash_wage_todo todo JOIN cash_wage_plan_version plan ON plan.id=todo.plan_version_id WHERE todo.id=$1::uuid FOR UPDATE OF todo,plan`,
            [todo],
          )
        ).rows[0],
        "CASH_WAGE_TODO_NOT_FOUND",
      );
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`cash-wage-plan-teacher:${work.person_id}`],
      );
      const current = one(
        (
          await client.query<CashWageCurrentPlanRow>(
            `SELECT plan.id::text AS id,plan.active,plan.planned_cash_cents::text AS planned_cash_cents,plan.planned_deduction_cents::text AS planned_deduction_cents,COALESCE((SELECT SUM(confirmation.cash_paid_cents) FROM cash_wage_confirmation confirmation JOIN finance_document completed ON completed.id=confirmation.finance_document_id WHERE confirmation.todo_id=$1::uuid AND completed.status='COMPLETED'),0)::text AS paid_cash_cents,COALESCE((SELECT SUM(confirmation.deduction_cents) FROM cash_wage_confirmation confirmation JOIN finance_document completed ON completed.id=confirmation.finance_document_id WHERE confirmation.todo_id=$1::uuid AND completed.status='COMPLETED'),0)::text AS paid_deduction_cents FROM cash_wage_plan_version plan WHERE plan.teacher_person_id=$2::uuid AND (plan.salary_month=$3::date OR (plan.applies_to_future_months AND plan.salary_month<$3::date)) ORDER BY (plan.salary_month=$3::date) DESC,plan.salary_month DESC,plan.version_no DESC LIMIT 1 FOR SHARE`,
            [todo, work.person_id, work.salary_month],
          )
        ).rows[0],
        "CASH_WAGE_PLAN_NOT_FOUND",
      );
      if (!current.active) fail("CASH_WAGE_PLAN_INACTIVE");
      if (
        BigInt(current.paid_cash_cents) + cash >
          amount(current.planned_cash_cents, false) ||
        BigInt(current.paid_deduction_cents) + deduction >
          amount(current.planned_deduction_cents, false)
      )
        fail("CASH_WAGE_PLAN_EXCEEDED");
      const unreplaced = (
        await client.query<{ id: string }>(
          `SELECT original.finance_document_id::text AS id FROM cash_wage_confirmation original JOIN finance_document original_document ON original_document.id=original.finance_document_id LEFT JOIN cash_wage_confirmation correction ON correction.correction_of_finance_document_id=original.finance_document_id WHERE original.todo_id=$1::uuid AND original_document.status='REVERSED' AND correction.finance_document_id IS NULL FOR SHARE OF original,original_document`,
          [todo],
        )
      ).rows;
      if (unreplaced.length > 0 && correction === undefined)
        fail("CASH_WAGE_CORRECTION_REQUIRED");
      if (correction !== undefined) {
        const original = one(
          (
            await client.query<{
              todo_id: string;
              cash_paid_cents: string;
              deduction_cents: string;
              status: string;
              reversal_count: string;
            }>(
              `SELECT confirmation.todo_id::text AS todo_id,confirmation.cash_paid_cents::text AS cash_paid_cents,confirmation.deduction_cents::text AS deduction_cents,document.status,COUNT(reversal.original_finance_document_id)::text AS reversal_count FROM cash_wage_confirmation confirmation JOIN finance_document document ON document.id=confirmation.finance_document_id LEFT JOIN salary_benefit_reversal reversal ON reversal.original_finance_document_id=confirmation.finance_document_id WHERE confirmation.finance_document_id=$1::uuid GROUP BY confirmation.todo_id,confirmation.cash_paid_cents,confirmation.deduction_cents,document.status`,
              [correction],
            )
          ).rows[0],
          "CASH_WAGE_CORRECTION_INVALID",
        );
        if (
          original.todo_id !== todo ||
          original.status !== "REVERSED" ||
          original.reversal_count !== "1"
        )
          fail("CASH_WAGE_CORRECTION_INVALID");
        if (
          (
            await client.query(
              "SELECT 1 FROM cash_wage_confirmation WHERE correction_of_finance_document_id=$1::uuid FOR SHARE",
              [correction],
            )
          ).rows.length > 0
        )
          fail("CASH_WAGE_CORRECTION_INVALID");
      }
      const destination = await this.account(client, "PERSON", work.person_id);
      const files = await this.readyAttachments(client, doc, attachments);
      await this.verify(files);
      const posted = await this.post(
        client,
        `cash-wage:${doc}`,
        "CASH_WAGE_CONFIRMED",
        [
          {
            accountKey: destination.account_code,
            categoryKey: "cashWageDeduction",
            amountCents: -deduction,
          },
        ],
        {
          financeDocumentId: doc,
          todoId: todo,
          teacherPersonId: work.person_id,
          salaryMonth: work.salary_month,
          cashPaidCents: cash.toString(),
          deductionCents: deduction.toString(),
        },
      );
      if (posted.status !== "POSTED") fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
      const destinationAfter =
        posted.balances[destination.account_code] ??
        fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
      const destinationBefore = destinationAfter + deduction;
      const next = exactVersion(document.version) + 1;
      await client.query(
        `UPDATE finance_document SET status='COMPLETED',version=$2::bigint,updated_at=$3::timestamptz WHERE id=$1::uuid`,
        [doc, next, at.toISOString()],
      );
      await client.query(
        `INSERT INTO cash_wage_confirmation(finance_document_id,todo_id,teacher_person_id,destination_account_id,salary_month,cash_paid_cents,deduction_cents,paid_at,reason,ledger_event_id,confirmed_by_person_id,created_at,correction_of_finance_document_id,destination_before_cents,destination_after_cents) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::date,$6::bigint,$7::bigint,$8::timestamptz,$9,$10::uuid,$11::uuid,$12::timestamptz,$13::uuid,$14::bigint,$15::bigint)`,
        [
          doc,
          todo,
          work.person_id,
          destination.id,
          work.salary_month,
          cash.toString(),
          deduction.toString(),
          paid,
          why,
          posted.event.eventId,
          actor,
          at.toISOString(),
          correction ?? null,
          destinationBefore.toString(),
          destinationAfter.toString(),
        ],
      );
      await this.bind(client, doc, next, actor, files, at);
      await this.completedEvent(
        client,
        doc,
        actor,
        next,
        posted.event.eventId,
        at,
      );
      const result: SalaryBenefitPosting = {
        id: doc,
        status: "COMPLETED",
        version: next,
        replay: false,
      };
      await this.record(
        client,
        actor,
        "CONFIRM_WAGE",
        idem,
        request,
        result,
        at,
      );
      return result;
    });
  }

  public async grantBonus(
    context: RoleContext,
    draft: BonusGrantDraft,
    idempotencyKey: string,
    at: Date,
  ): Promise<SalaryBenefitPosting> {
    const actor = assertOperator(context);
    const doc = uuid(draft.documentId);
    const expected = version(draft.expectedVersion);
    const recipient = uuid(draft.recipientPersonId);
    const fund = uuid(draft.sourceFundId);
    const value = amount(draft.amountCents);
    const why = reason(draft.reason);
    const project = name(draft.projectName);
    const projectNameVersionId =
      draft.projectNameVersionId === undefined
        ? undefined
        : uuid(draft.projectNameVersionId);
    const files = this.attachments(draft.attachmentVersionIds);
    const idem = key(idempotencyKey);
    if (
      !Number.isSafeInteger(draft.projectNo) ||
      draft.projectNo < 1 ||
      draft.projectNo > 10
    )
      fail("INVALID_INPUT");
    const request =
      projectNameVersionId === undefined
        ? hash([
            "salary-benefit.grant-bonus.v1",
            doc,
            expected,
            draft.projectNo,
            project,
            recipient,
            fund,
            value.toString(),
            why,
            files,
          ])
        : hash([
            "salary-benefit.grant-bonus.v2",
            doc,
            expected,
            draft.projectNo,
            project,
            projectNameVersionId,
            recipient,
            fund,
            value.toString(),
            why,
            files,
          ]);
    return this.inTx(async (client) => {
      const replay = await this.replay<SalaryBenefitPosting>(
        client,
        actor,
        "GRANT_BONUS",
        idem,
        request,
      );
      if (replay) return { ...replay, replay: true };
      if (projectNameVersionId === undefined)
        fail("BONUS_PROJECT_VERSION_REQUIRED");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`bonus-project-catalog:${draft.projectNo}`],
      );
      const projectRow = one(
        (
          await client.query<BonusProjectRow>(
            `
        SELECT id::text AS id,version_no::text AS version_no,display_name
          FROM bonus_project_name_version
         WHERE project_no=$1
         ORDER BY version_no DESC
         LIMIT 1
         FOR SHARE
      `,
            [draft.projectNo],
          )
        ).rows[0],
        "BONUS_PROJECT_CATALOG_DATA_UNAVAILABLE",
      );
      if (
        projectRow.id !== projectNameVersionId ||
        projectRow.display_name !== project
      )
        fail("BONUS_PROJECT_VERSION_CONFLICT");
      exactVersion(projectRow.version_no);
      const document = await this.lockDocument(
        client,
        doc,
        actor,
        "PROJECT_BONUS",
        expected,
      );
      const source = await this.fundAccount(client, fund, at);
      const destination = await this.account(client, "PERSON", recipient);
      const attachments = await this.readyAttachments(client, doc, files);
      await this.verify(attachments);
      const posted = await this.post(
        client,
        `project-bonus:${doc}`,
        "PROJECT_BONUS_GRANTED",
        [
          {
            accountKey: source.account_code,
            categoryKey: "projectBonusExpense",
            amountCents: -value,
          },
          {
            accountKey: destination.account_code,
            categoryKey: "projectBonusIncome",
            amountCents: value,
          },
        ],
        {
          financeDocumentId: doc,
          projectNo: draft.projectNo,
          projectName: project,
          projectNameVersionId,
          recipientPersonId: recipient,
          sourceFundId: fund,
          amountCents: value.toString(),
        },
      );
      if (posted.status !== "POSTED") fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
      const next = exactVersion(document.version) + 1;
      await client.query(
        "UPDATE finance_document SET status='COMPLETED',version=$2::bigint,updated_at=$3::timestamptz WHERE id=$1::uuid",
        [doc, next, at.toISOString()],
      );
      await client.query(
        `
        INSERT INTO project_bonus_transfer(
          finance_document_id,project_no,project_name,project_name_version_id,recipient_person_id,
          destination_account_id,source_fund_id,source_account_id,amount_cents,reason,ledger_event_id,
          granted_by_person_id,created_at
        ) VALUES($1::uuid,$2,$3,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,$9::bigint,$10,$11::uuid,$12::uuid,$13::timestamptz)
      `,
        [
          doc,
          draft.projectNo,
          project,
          projectNameVersionId,
          recipient,
          destination.id,
          fund,
          source.id,
          value.toString(),
          why,
          posted.event.eventId,
          actor,
          at.toISOString(),
        ],
      );
      await this.bind(client, doc, next, actor, attachments, at);
      await this.completedEvent(
        client,
        doc,
        actor,
        next,
        posted.event.eventId,
        at,
      );
      const result: SalaryBenefitPosting = {
        id: doc,
        status: "COMPLETED",
        version: next,
        replay: false,
      };
      await this.record(
        client,
        actor,
        "GRANT_BONUS",
        idem,
        request,
        result,
        at,
      );
      return result;
    });
  }

  public async setBenefitPlan(
    context: RoleContext,
    draft: BenefitPlanDraft,
    idempotencyKey: string,
    at: Date,
  ): Promise<DueTodo> {
    const actor = assertOperator(context),
      kind = draft.benefitKind,
      person = uuid(draft.beneficiaryPersonId),
      benefitMonth = month(draft.benefitMonth),
      value = amount(draft.amountCents),
      fund = uuid(draft.sourceFundId),
      why = reason(draft.reason),
      idem = key(idempotencyKey);
    if (
      !["SOCIAL_INSURANCE", "HOUSING_FUND"].includes(kind) ||
      !Number.isSafeInteger(draft.executionDay) ||
      draft.executionDay < 1 ||
      draft.executionDay > daysInMonth(benefitMonth)
    )
      fail("INVALID_INPUT");
    const request = hash([
      "salary-benefit.set-benefit-plan.v1",
      kind,
      person,
      benefitMonth,
      draft.executionDay,
      value.toString(),
      fund,
      draft.active,
      why,
    ]);
    return this.inTx(async (client) => {
      const replay = await this.replay<DueTodo>(
        client,
        actor,
        "SET_BENEFIT_PLAN",
        idem,
        request,
      );
      if (replay) return replay;
      await this.requireActivePerson(client, person);
      await this.fundAccount(client, fund, at);
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`benefit-plan:${kind}:${person}:${benefitMonth}`],
      );
      const current = (
        await client.query<{ n: string }>(
          `SELECT COALESCE(MAX(version_no),0)::text AS n FROM finance_benefit_plan_version WHERE benefit_kind=$1 AND beneficiary_person_id=$2::uuid AND benefit_month=$3::date`,
          [kind, person, benefitMonth],
        )
      ).rows[0];
      const n = Number(current?.n ?? "0") + 1;
      const row = one(
        (
          await client.query<{ id: string }>(
            `INSERT INTO finance_benefit_plan_version(benefit_kind,beneficiary_person_id,benefit_month,version_no,execution_day,amount_cents,source_fund_id,active,changed_by_person_id,changed_at,reason) VALUES($1,$2::uuid,$3::date,$4,$5,$6::bigint,$7::uuid,$8,$9::uuid,$10::timestamptz,$11) RETURNING id::text AS id`,
            [
              kind,
              person,
              benefitMonth,
              n,
              draft.executionDay,
              value.toString(),
              fund,
              draft.active,
              actor,
              at.toISOString(),
              why,
            ],
          )
        ).rows[0],
        "SALARY_BENEFIT_DATA_UNAVAILABLE",
      );
      const result: DueTodo = {
        id: row.id,
        planVersionId: row.id,
        subjectPersonId: person,
        month: benefitMonth,
        kind,
      };
      await this.record(
        client,
        actor,
        "SET_BENEFIT_PLAN",
        idem,
        request,
        result,
        at,
      );
      return result;
    });
  }

  public async generateBenefitTodos(
    context: RoleContext,
    idempotencyKey: string,
    at: Date,
  ): Promise<readonly DueTodo[]> {
    const actor = assertOperator(context),
      idem = key(idempotencyKey),
      now = bjt(at),
      request = hash([
        "salary-benefit.generate-benefit-todos.v1",
        now.month,
        now.day,
      ]);
    return this.inTx(async (client) => {
      const replay = await this.replay<readonly DueTodo[]>(
        client,
        actor,
        "GENERATE_BENEFIT_TODOS",
        idem,
        request,
      );
      if (replay) return replay;
      const rows = (
        await client.query<{
          id: string;
          plan_version_id: string;
          benefit_kind: string;
          beneficiary_person_id: string;
          benefit_month: string;
        }>(
          `WITH latest AS (SELECT DISTINCT ON (benefit_kind,beneficiary_person_id,benefit_month) id,benefit_kind,beneficiary_person_id,benefit_month,execution_day,active FROM finance_benefit_plan_version WHERE benefit_month=$1::date ORDER BY benefit_kind,beneficiary_person_id,benefit_month,version_no DESC) INSERT INTO finance_benefit_todo(plan_version_id,benefit_kind,beneficiary_person_id,benefit_month,generated_at) SELECT latest.id,latest.benefit_kind,latest.beneficiary_person_id,latest.benefit_month,$3::timestamptz FROM latest LEFT JOIN finance_benefit_todo todo ON todo.benefit_kind=latest.benefit_kind AND todo.beneficiary_person_id=latest.beneficiary_person_id AND todo.benefit_month=latest.benefit_month WHERE latest.active AND latest.execution_day <= $2 AND todo.id IS NULL RETURNING id::text AS id,plan_version_id::text AS plan_version_id,benefit_kind,beneficiary_person_id::text AS beneficiary_person_id,benefit_month::text AS benefit_month`,
          [now.month, now.day, at.toISOString()],
        )
      ).rows;
      const result = rows.map((row) => ({
        id: row.id,
        planVersionId: row.plan_version_id,
        subjectPersonId: row.beneficiary_person_id,
        month: row.benefit_month,
        kind: row.benefit_kind,
      }));
      await this.record(
        client,
        actor,
        "GENERATE_BENEFIT_TODOS",
        idem,
        request,
        result,
        at,
      );
      return result;
    });
  }

  public async confirmBenefit(
    context: RoleContext,
    draft: BenefitConfirmationDraft,
    idempotencyKey: string,
    at: Date,
  ): Promise<SalaryBenefitPosting> {
    const actor = assertOperator(context),
      doc = uuid(draft.documentId),
      expected = version(draft.expectedVersion),
      todo = uuid(draft.todoId),
      why = reason(draft.reason),
      files = this.attachments(draft.attachmentVersionIds),
      idem = key(idempotencyKey),
      request = hash([
        "salary-benefit.confirm-benefit.v1",
        doc,
        expected,
        todo,
        why,
        files,
      ]);
    return this.inTx(async (client) => {
      const replay = await this.replay<SalaryBenefitPosting>(
        client,
        actor,
        "CONFIRM_BENEFIT",
        idem,
        request,
      );
      if (replay) return { ...replay, replay: true };
      const document = await this.lockDocument(
        client,
        doc,
        actor,
        "FINANCE_BENEFIT",
        expected,
      );
      const work = one(
        (
          await client.query<BenefitTodoRow>(
            `SELECT id::text AS id,plan_version_id::text AS plan_version_id,benefit_kind,beneficiary_person_id::text AS beneficiary_person_id,benefit_month::text AS benefit_month FROM finance_benefit_todo WHERE id=$1::uuid FOR UPDATE`,
            [todo],
          )
        ).rows[0],
        "FINANCE_BENEFIT_TODO_NOT_FOUND",
      );
      if (
        (
          await client.query(
            "SELECT 1 FROM finance_benefit_execution WHERE todo_id=$1::uuid FOR SHARE",
            [todo],
          )
        ).rows.length > 0
      )
        fail("FINANCE_BENEFIT_ALREADY_EXECUTED");
      const current = one(
        (
          await client.query<BenefitCurrentPlanRow>(
            `SELECT id::text AS id,active,amount_cents::text AS amount_cents,source_fund_id::text AS source_fund_id FROM finance_benefit_plan_version WHERE benefit_kind=$1 AND beneficiary_person_id=$2::uuid AND benefit_month=$3::date ORDER BY version_no DESC LIMIT 1 FOR SHARE`,
            [work.benefit_kind, work.beneficiary_person_id, work.benefit_month],
          )
        ).rows[0],
        "FINANCE_BENEFIT_PLAN_NOT_FOUND",
      );
      if (!current.active) fail("FINANCE_BENEFIT_PLAN_INACTIVE");
      const source = await this.fundAccount(client, current.source_fund_id, at),
        attachments = await this.readyAttachments(client, doc, files);
      await this.verify(attachments);
      const value = amount(current.amount_cents);
      const posted = await this.post(
        client,
        `finance-benefit:${doc}`,
        "FINANCE_BENEFIT_EXECUTED",
        [
          {
            accountKey: source.account_code,
            categoryKey: "financeBenefitExpense",
            amountCents: -value,
          },
        ],
        {
          financeDocumentId: doc,
          todoId: todo,
          planVersionId: current.id,
          benefitKind: work.benefit_kind,
          beneficiaryPersonId: work.beneficiary_person_id,
          amountCents: value.toString(),
        },
      );
      if (posted.status !== "POSTED") fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
      const next = exactVersion(document.version) + 1;
      await client.query(
        "UPDATE finance_document SET status='COMPLETED',version=$2::bigint,updated_at=$3::timestamptz WHERE id=$1::uuid",
        [doc, next, at.toISOString()],
      );
      await client.query(
        `INSERT INTO finance_benefit_execution(finance_document_id,todo_id,plan_version_id,source_fund_id,source_account_id,amount_cents,ledger_event_id,executed_by_person_id,reason,created_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::bigint,$7::uuid,$8::uuid,$9,$10::timestamptz)`,
        [
          doc,
          todo,
          current.id,
          current.source_fund_id,
          source.id,
          value.toString(),
          posted.event.eventId,
          actor,
          why,
          at.toISOString(),
        ],
      );
      await this.bind(client, doc, next, actor, attachments, at);
      await this.completedEvent(
        client,
        doc,
        actor,
        next,
        posted.event.eventId,
        at,
      );
      const result: SalaryBenefitPosting = {
        id: doc,
        status: "COMPLETED",
        version: next,
        replay: false,
      };
      await this.record(
        client,
        actor,
        "CONFIRM_BENEFIT",
        idem,
        request,
        result,
        at,
      );
      return result;
    });
  }

  /** A correction is an additional evidenced document and a single inverse event; it never rewrites the original event. */
  public async reversePosting(
    context: RoleContext,
    draft: SalaryBenefitReversalDraft,
    idempotencyKey: string,
    at: Date,
  ): Promise<SalaryBenefitPosting> {
    const actor = assertOperator(context),
      originalId = uuid(draft.originalDocumentId),
      reversalId = uuid(draft.reversalDocumentId),
      originalVersion = version(draft.expectedOriginalVersion),
      reversalVersion = version(draft.expectedReversalVersion),
      why = reason(draft.reason),
      files = this.attachments(draft.attachmentVersionIds),
      idem = key(idempotencyKey),
      request = hash([
        "salary-benefit.reverse-posting.v1",
        originalId,
        reversalId,
        originalVersion,
        reversalVersion,
        why,
        files,
      ]);
    if (originalId === reversalId) fail("INVALID_INPUT");
    return this.inTx(async (client) => {
      const replay = await this.replay<SalaryBenefitPosting>(
        client,
        actor,
        "REVERSE_POSTING",
        idem,
        request,
      );
      if (replay) return { ...replay, replay: true };
      const original = one(
        (
          await client.query<DocumentRow>(
            "SELECT id::text AS id,kind,status,version::text AS version,applicant_person_id::text AS applicant_person_id FROM finance_document WHERE id=$1::uuid FOR UPDATE",
            [originalId],
          )
        ).rows[0],
        "FINANCE_DOCUMENT_NOT_FOUND",
      );
      const kind = documentKind(original.kind);
      if (
        original.status !== "COMPLETED" ||
        exactVersion(original.version) !== originalVersion
      )
        fail("SALARY_BENEFIT_STATE_CONFLICT");
      const reversal = await this.lockDocument(
        client,
        reversalId,
        actor,
        kind,
        reversalVersion,
      );
      const attachments = await this.readyAttachments(
        client,
        reversalId,
        files,
      );
      await this.verify(attachments);
      let originalEventId: string,
        deltas: readonly {
          accountKey: string;
          categoryKey: string;
          amountCents: bigint;
        }[];
      if (kind === "CASH_WAGE") {
        const row = one(
          (
            await client.query<{
              ledger_event_id: string;
              destination_account_id: string;
              deduction_cents: string;
            }>(
              "SELECT ledger_event_id::text AS ledger_event_id,destination_account_id::text AS destination_account_id,deduction_cents::text AS deduction_cents FROM cash_wage_confirmation WHERE finance_document_id=$1::uuid FOR SHARE",
              [originalId],
            )
          ).rows[0],
          "SALARY_BENEFIT_DATA_UNAVAILABLE",
        );
        originalEventId = row.ledger_event_id;
        const destination = await this.historicalAccount(
          client,
          row.destination_account_id,
          originalEventId,
          "cashWageDeduction",
          -amount(row.deduction_cents),
        );
        deltas = [
          {
            accountKey: destination.account_code,
            categoryKey: "cashWageCorrection",
            amountCents: amount(row.deduction_cents),
          },
        ];
      } else if (kind === "PROJECT_BONUS") {
        const row = one(
          (
            await client.query<{
              ledger_event_id: string;
              source_account_id: string;
              destination_account_id: string;
              amount_cents: string;
            }>(
              "SELECT ledger_event_id::text AS ledger_event_id,source_account_id::text AS source_account_id,destination_account_id::text AS destination_account_id,amount_cents::text AS amount_cents FROM project_bonus_transfer WHERE finance_document_id=$1::uuid FOR SHARE",
              [originalId],
            )
          ).rows[0],
          "SALARY_BENEFIT_DATA_UNAVAILABLE",
        );
        originalEventId = row.ledger_event_id;
        const value = amount(row.amount_cents),
          source = await this.historicalAccount(
            client,
            row.source_account_id,
            originalEventId,
            "projectBonusExpense",
            -value,
          ),
          destination = await this.historicalAccount(
            client,
            row.destination_account_id,
            originalEventId,
            "projectBonusIncome",
            value,
          );
        deltas = [
          {
            accountKey: source.account_code,
            categoryKey: "projectBonusExpenseReversal",
            amountCents: value,
          },
          {
            accountKey: destination.account_code,
            categoryKey: "projectBonusIncomeReversal",
            amountCents: -value,
          },
        ];
      } else {
        const row = one(
          (
            await client.query<{
              ledger_event_id: string;
              source_account_id: string;
              amount_cents: string;
            }>(
              "SELECT ledger_event_id::text AS ledger_event_id,source_account_id::text AS source_account_id,amount_cents::text AS amount_cents FROM finance_benefit_execution WHERE finance_document_id=$1::uuid FOR SHARE",
              [originalId],
            )
          ).rows[0],
          "SALARY_BENEFIT_DATA_UNAVAILABLE",
        );
        originalEventId = row.ledger_event_id;
        const value = amount(row.amount_cents),
          source = await this.historicalAccount(
            client,
            row.source_account_id,
            originalEventId,
            "financeBenefitExpense",
            -value,
          );
        deltas = [
          {
            accountKey: source.account_code,
            categoryKey: "financeBenefitExpenseReversal",
            amountCents: value,
          },
        ];
      }
      const posted = await this.post(
        client,
        `salary-benefit-reversal:${reversalId}`,
        "SALARY_BENEFIT_REVERSED",
        deltas,
        {
          originalDocumentId: originalId,
          reversalDocumentId: reversalId,
          originalLedgerEventId: originalEventId,
        },
      );
      if (posted.status !== "POSTED") fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
      const originalNext = originalVersion + 1,
        reversalNext = reversalVersion + 1;
      await client.query(
        "UPDATE finance_document SET status='REVERSED',version=$2::bigint,updated_at=$3::timestamptz WHERE id=$1::uuid",
        [originalId, originalNext, at.toISOString()],
      );
      await client.query(
        "UPDATE finance_document SET status='COMPLETED',version=$2::bigint,updated_at=$3::timestamptz WHERE id=$1::uuid",
        [reversalId, reversalNext, at.toISOString()],
      );
      await client.query(
        "INSERT INTO salary_benefit_reversal(reversal_finance_document_id,original_finance_document_id,original_ledger_event_id,reversal_ledger_event_id,reversed_by_person_id,reason,created_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7::timestamptz)",
        [
          reversalId,
          originalId,
          originalEventId,
          posted.event.eventId,
          actor,
          why,
          at.toISOString(),
        ],
      );
      await this.bind(client, reversalId, reversalNext, actor, attachments, at);
      await this.completedEvent(
        client,
        reversalId,
        actor,
        reversalNext,
        posted.event.eventId,
        at,
      );
      await client.query(
        "INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,ledger_event_id,created_at) VALUES($1::uuid,'SALARY_BENEFIT_REVERSED',$2::uuid,$3::bigint,$4::uuid,$5::timestamptz)",
        [
          originalId,
          actor,
          originalNext,
          posted.event.eventId,
          at.toISOString(),
        ],
      );
      const result: SalaryBenefitPosting = {
        id: reversal.id,
        status: "COMPLETED",
        version: reversalNext,
        replay: false,
      };
      await this.record(
        client,
        actor,
        "REVERSE_POSTING",
        idem,
        request,
        result,
        at,
      );
      return result;
    });
  }

  private async inTx<T>(
    work: (client: PostgresClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      committed = true;
      return result;
    } catch (error) {
      if (!committed) await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.release();
    }
  }
  private async replay<T>(
    client: PostgresClient,
    actor: string,
    operation: string,
    idem: string,
    request: string,
  ): Promise<T | undefined> {
    const row = (
      await client.query<ReplayRow>(
        "SELECT request_hash,result_json FROM salary_benefit_command_idempotency WHERE actor_person_id=$1::uuid AND operation=$2 AND idempotency_key=$3 FOR SHARE",
        [actor, operation, idem],
      )
    ).rows[0];
    if (!row) return undefined;
    if (row.request_hash !== request) fail("IDEMPOTENCY_REPLAY");
    return row.result_json as T;
  }
  private async record(
    client: PostgresClient,
    actor: string,
    operation: string,
    idem: string,
    request: string,
    result: unknown,
    at: Date,
  ): Promise<void> {
    await client.query(
      "INSERT INTO salary_benefit_command_idempotency(actor_person_id,operation,idempotency_key,request_hash,result_json,created_at) VALUES($1::uuid,$2,$3,$4,$5::jsonb,$6::timestamptz)",
      [
        actor,
        operation,
        idem,
        request,
        JSON.stringify(result),
        at.toISOString(),
      ],
    );
  }
  private attachments(input: readonly string[]): readonly string[] {
    if (!Array.isArray(input) || input.length < 2 || input.length > 20)
      fail("INVALID_INPUT");
    const out = input.map(uuid).sort();
    if (new Set(out).size !== out.length) fail("INVALID_INPUT");
    return out;
  }
  private async lockDocument(
    client: PostgresClient,
    id: string,
    actor: string,
    kind: SalaryBenefitDocumentKind,
    expected: number,
  ): Promise<DocumentRow> {
    const row = one(
      (
        await client.query<DocumentRow>(
          "SELECT id::text AS id,kind,status,version::text AS version,applicant_person_id::text AS applicant_person_id FROM finance_document WHERE id=$1::uuid FOR UPDATE",
          [id],
        )
      ).rows[0],
      "FINANCE_DOCUMENT_NOT_FOUND",
    );
    if (row.applicant_person_id !== actor) fail("FINANCE_DOCUMENT_NOT_FOUND");
    if (row.kind !== kind || row.status !== "DRAFT")
      fail("SALARY_BENEFIT_STATE_CONFLICT");
    if (exactVersion(row.version) !== expected) fail("VERSION_CONFLICT");
    return row;
  }
  private async readyAttachments(
    client: PostgresClient,
    documentId: string,
    ids: readonly string[],
  ): Promise<readonly AttachmentRow[]> {
    const rows = (
      await client.query<AttachmentRow>(
        `SELECT version.id::text AS id,attachment.id::text AS attachment_id,attachment.purpose,version.status,version.detected_media_type,version.actual_size_bytes::text AS actual_size_bytes,version.sha256 FROM finance_attachment_version version JOIN finance_attachment attachment ON attachment.id=version.finance_attachment_id WHERE attachment.finance_document_id=$1::uuid AND version.id=ANY($2::uuid[]) FOR SHARE OF attachment,version`,
        [documentId, ids],
      )
    ).rows;
    if (
      rows.length !== ids.length ||
      new Set(rows.map((row) => row.attachment_id)).size !== rows.length ||
      rows.some((row) => row.status !== "READY") ||
      REQUIRED_PURPOSES.some(
        (purpose) => !rows.some((row) => row.purpose === purpose),
      )
    )
      fail("FINANCE_ATTACHMENT_NOT_READY");
    return rows;
  }
  private async verify(rows: readonly AttachmentRow[]): Promise<void> {
    for (const row of rows) {
      const size =
        row.actual_size_bytes === null ? NaN : Number(row.actual_size_bytes);
      if (
        !row.detected_media_type ||
        !Number.isSafeInteger(size) ||
        size < 1 ||
        !row.sha256 ||
        !SHA256.test(row.sha256)
      )
        fail("ATTACHMENT_INTEGRITY_FAILED");
      const media = row.detected_media_type as AttachmentMediaType,
        digest = row.sha256 as string;
      try {
        await this.store.readVerified({
          versionId: row.id,
          mediaType: media,
          sizeBytes: size,
          sha256: digest,
        });
      } catch {
        fail("ATTACHMENT_INTEGRITY_FAILED");
      }
    }
  }
  private async bind(
    client: PostgresClient,
    documentId: string,
    documentVersion: number,
    actor: string,
    rows: readonly AttachmentRow[],
    at: Date,
  ): Promise<void> {
    for (const row of rows)
      await client.query(
        "INSERT INTO salary_benefit_attachment_binding(finance_document_id,finance_attachment_version_id,purpose,document_version,bound_by_person_id,bound_at) VALUES($1::uuid,$2::uuid,$3,$4::bigint,$5::uuid,$6::timestamptz)",
        [
          documentId,
          row.id,
          row.purpose,
          documentVersion,
          actor,
          at.toISOString(),
        ],
      );
  }
  private async completedEvent(
    client: PostgresClient,
    documentId: string,
    actor: string,
    docVersion: number,
    ledgerEventId: string,
    at: Date,
  ): Promise<void> {
    await client.query(
      "INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,ledger_event_id,created_at) VALUES($1::uuid,'SALARY_BENEFIT_COMPLETED',$2::uuid,$3::bigint,$4::uuid,$5::timestamptz)",
      [documentId, actor, docVersion, ledgerEventId, at.toISOString()],
    );
  }
  private async requireActivePerson(
    client: PostgresClient,
    id: string,
  ): Promise<void> {
    const row = (
      await client.query<{ id: string }>(
        "SELECT id::text AS id FROM person WHERE id=$1::uuid AND status='ACTIVE' FOR SHARE",
        [id],
      )
    ).rows[0];
    if (!row) fail("PERSON_NOT_FOUND");
  }
  private async account(
    client: PostgresClient,
    type: "PERSON" | "COMPANY",
    owner: string,
  ): Promise<AccountRow> {
    const rows = (
      await client.query<AccountRow>(
        "SELECT id::text AS id,account_code,status,owner_type,owner_id::text AS owner_id FROM settlement_account WHERE owner_type=$1 AND owner_id=$2::uuid FOR SHARE",
        [type, owner],
      )
    ).rows;
    if (rows.length !== 1 || rows[0]!.status !== "ACTIVE")
      fail(
        type === "PERSON"
          ? "PERSONAL_ACCOUNT_NOT_FOUND"
          : "COMPANY_FUND_ASSIGNMENT_NOT_FOUND",
      );
    return rows[0]!;
  }
  private async historicalAccount(
    client: PostgresClient,
    id: string,
    eventId: string,
    category: string,
    amountCents: bigint,
  ): Promise<AccountRow> {
    const row = one(
      (
        await client.query<AccountRow>(
          "SELECT id::text AS id,account_code,status,owner_type,owner_id::text AS owner_id FROM settlement_account WHERE id=$1::uuid FOR SHARE",
          [id],
        )
      ).rows[0],
      "SALARY_BENEFIT_DATA_UNAVAILABLE",
    );
    const entry = (
      await client.query(
        "SELECT 1 FROM ledger_entry WHERE event_id=$1::uuid AND account_id=$2::uuid AND category_key=$3 AND amount_cents=$4::bigint FOR SHARE",
        [eventId, id, category, amountCents.toString()],
      )
    ).rows;
    if (entry.length !== 1) fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
    return row;
  }
  private async fundAccount(
    client: PostgresClient,
    fund: string,
    at: Date,
  ): Promise<AccountRow> {
    const record = (
      await client.query<FundRow>(
        "SELECT id::text AS id,fund_code,status FROM company_finance_fund WHERE id=$1::uuid FOR SHARE",
        [fund],
      )
    ).rows[0];
    if (!record || record.status !== "ACTIVE") fail("COMPANY_FUND_INACTIVE");
    const assignment = (
      await client.query<{ id: string }>(
        `SELECT id::text AS id FROM company_finance_fund_assignment WHERE fund_id=$1::uuid AND duty_subject='HEADQUARTERS_FINANCE' AND scope_type='GLOBAL' AND responsibility_code='FINANCE_OPERATING_SOURCE' AND valid_from<=$2::timestamptz AND (valid_to IS NULL OR valid_to>$2::timestamptz) FOR SHARE`,
        [fund, at.toISOString()],
      )
    ).rows;
    if (assignment.length !== 1) fail("COMPANY_FUND_ASSIGNMENT_NOT_FOUND");
    return this.account(client, "COMPANY", fund);
  }
  private async post(
    client: PostgresClient,
    eventKey: string,
    eventType: string,
    deltas: readonly {
      accountKey: string;
      categoryKey: string;
      amountCents: bigint;
    }[],
    payload: unknown,
  ) {
    return postLedgerEvent(
      { transaction: (work) => work(createPostgresLedgerTransaction(client)) },
      { eventKey, eventType, payloadHash: hash(payload), deltas },
      randomUUID,
    );
  }
}
