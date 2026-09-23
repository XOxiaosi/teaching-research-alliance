import type { RoleContext } from "@teaching-research-alliance/contracts";
import { financeYearBounds } from "./finance-year.js";
import type { PostgresClient, PostgresPool } from "./postgres-ledger-repository.js";

export type ReimbursementSummary = Readonly<{
  id: string;
  status: "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "COMPLETED" | "REVERSED";
  version: number;
  amountCents: string;
  reason: string;
  applicantPersonId: string;
  applicantDisplayName: string;
  submittedAt: string;
  completedAt?: string;
  reversedAt?: string;
  reversalReason?: string;
}>;

export type ReimbursementDetail = ReimbursementSummary & Readonly<{
  attachments: readonly Readonly<{
    versionId: string;
    purpose: "SUPPORTING_DOCUMENT" | "APPLICATION_SCREENSHOT" | "INVOICE";
    originalFilename: string;
    mediaType: "application/pdf" | "image/png" | "image/jpeg";
    sizeBytes: number;
    sha256: string;
  }>[];
  decision?: Readonly<{
    decision: "APPROVED" | "REJECTED";
    reason: string;
    decidedAt: string;
  }>;
  management?: Readonly<{
    destinationAccountId: string;
    submittedByPersonId: string;
    applicantContextSubject: "TEACHING_TEACHER" | "ACADEMIC_PLANNER" | "PLANNING_MENTOR";
    applicantContextScope: string;
    applicantContextRegionId?: string;
    applicantContextCampusId?: string;
    applicantContextVenueId?: string;
    decidedByPersonId?: string;
    decisionActorSubject?: "HEADQUARTERS_FINANCE";
    decisionActorScope?: "GLOBAL";
    completion?: Readonly<{
      roleAssignmentId: string;
      companyFundAssignmentId: string;
      sourceAccountId: string;
      destinationAccountId: string;
      ledgerEventId: string;
      executedByPersonId: string;
      executedAt: string;
    }>;
    reversal?: Readonly<{
      sourceAccountId: string;
      destinationAccountId: string;
      originalLedgerEventId: string;
      reversalLedgerEventId: string;
      reversedByPersonId: string;
      actorSubjectCode: "HEADQUARTERS_FINANCE" | "SYSTEM_ADMIN" | "SYSTEM_OWNER";
      actorScopeType: "GLOBAL";
      reversedAt: string;
    }>;
  }>;
}>;

type SummaryRow = Readonly<{
  id: string;
  document_kind: string;
  status: string;
  version: string;
  document_created_at: string;
  applicant_person_id: string;
  applicant_display_name: string | null;
  submission_document_id: string | null;
  source_document_version: string | null;
  result_document_version: string | null;
  destination_account_id: string | null;
  amount_cents: string | null;
  reason: string | null;
  applicant_context_snapshot: unknown;
  submitted_by_person_id: string | null;
  submitted_at: string | null;
  submission_created_at: string | null;
  destination_owner_type: string | null;
  destination_owner_id: string | null;
  decision_document_id: string | null;
  decision_source_document_version: string | null;
  decision_result_document_version: string | null;
  decision: string | null;
  decision_reason: string | null;
  decided_by_person_id: string | null;
  actor_subject_code: string | null;
  actor_scope_type: string | null;
  decision_authorization_snapshot: unknown;
  decided_at: string | null;
  decision_created_at: string | null;
  transfer_document_id: string | null;
  transfer_source_document_version: string | null;
  transfer_result_document_version: string | null;
  role_assignment_id: string | null;
  company_fund_assignment_id: string | null;
  source_fund_id: string | null;
  source_account_id: string | null;
  transfer_destination_account_id: string | null;
  transfer_amount_cents: string | null;
  transfer_reason: string | null;
  transfer_authorization_snapshot: unknown;
  transfer_ledger_event_id: string | null;
  transfer_ledger_event_type: string | null;
  transfer_ledger_event_key: string | null;
  executed_by_person_id: string | null;
  executed_at: string | null;
  transfer_created_at: string | null;
  source_before_cents: string | null;
  source_after_cents: string | null;
  destination_before_cents: string | null;
  destination_after_cents: string | null;
  source_owner_type: string | null;
  source_owner_id: string | null;
  transfer_destination_owner_type: string | null;
  transfer_destination_owner_id: string | null;
  source_fund_code: string | null;
  role_person_id: string | null;
  role_subject_code: string | null;
  role_scope_type: string | null;
  role_scope_id: string | null;
  role_valid_from: string | null;
  role_valid_to: string | null;
  fund_assignment_fund_id: string | null;
  fund_assignment_subject: string | null;
  fund_assignment_scope: string | null;
  fund_assignment_scope_id: string | null;
  fund_assignment_responsibility: string | null;
  fund_assignment_valid_from: string | null;
  fund_assignment_valid_to: string | null;
  fund_assignment_closure_valid: boolean;
  reversal_document_id: string | null;
  reversal_source_document_version: string | null;
  reversal_result_document_version: string | null;
  reversal_source_account_id: string | null;
  reversal_destination_account_id: string | null;
  reversal_amount_cents: string | null;
  reversal_original_ledger_event_id: string | null;
  reversal_ledger_event_id: string | null;
  reversal_reason: string | null;
  reversed_by_person_id: string | null;
  reversal_actor_subject_code: string | null;
  reversal_actor_scope_type: string | null;
  reversal_authorization_snapshot: unknown;
  reversed_at: string | null;
  reversal_created_at: string | null;
  reversal_source_before_cents: string | null;
  reversal_source_after_cents: string | null;
  reversal_destination_before_cents: string | null;
  reversal_destination_after_cents: string | null;
  reversal_original_authorization_matches: boolean | null;
  reversal_ledger_event_type: string | null;
  reversal_ledger_event_key: string | null;
  reversal_entry_count: string | null;
  reversal_source_entries: string | null;
  reversal_destination_entries: string | null;
  reversal_other_entries: string | null;
  ledger_entry_count: string | null;
  source_ledger_entries: string | null;
  destination_ledger_entries: string | null;
  other_ledger_entries: string | null;
  command_count: string;
  submit_command_count: string;
  decision_command_count: string;
  execute_command_count: string;
  reverse_command_count: string;
  event_count: string;
  created_event_count: string;
  submitted_event_count: string;
  decision_event_count: string;
  completed_event_count: string;
  reversed_event_count: string;
  binding_count: string;
  binding_slot_count: string;
  supporting_count: string;
  screenshot_count: string;
  invalid_binding_count: string;
}>;

type AttachmentRow = Readonly<{
  version_id: string;
  binding_stage: string;
  binding_purpose: string;
  attachment_purpose: string;
  attachment_slot_id: string;
  attachment_document_id: string;
  attachment_created_by_person_id: string;
  uploaded_by_person_id: string;
  document_version: string;
  bound_by_person_id: string;
  bound_at: string;
  binding_created_at: string;
  status: string;
  original_filename: string;
  media_type: string | null;
  size_bytes: string | null;
  sha256: string | null;
  ready_at: string | null;
}>;

type ParsedSummary = Readonly<{
  summary: ReimbursementSummary;
  destinationAccountId: string;
  submittedByPersonId: string;
  applicantContextSubject: "TEACHING_TEACHER" | "ACADEMIC_PLANNER" | "PLANNING_MENTOR";
  applicantContextScope: string;
  applicantContextRegionId: string | null;
  applicantContextCampusId: string | null;
  applicantContextVenueId: string | null;
  decidedByPersonId: string | null;
  completedSourceFundId: string | null;
  reversal: Readonly<{
    sourceAccountId: string;
    destinationAccountId: string;
    originalLedgerEventId: string;
    reversalLedgerEventId: string;
    reason: string;
    reversedByPersonId: string;
    actorSubjectCode: "HEADQUARTERS_FINANCE" | "SYSTEM_ADMIN" | "SYSTEM_OWNER";
    actorScopeType: "GLOBAL";
    reversedAt: string;
  }> | null;
  completion: Readonly<{
    roleAssignmentId: string;
    companyFundAssignmentId: string;
    sourceAccountId: string;
    destinationAccountId: string;
    ledgerEventId: string;
    executedByPersonId: string;
    executedAt: string;
  }> | null;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const personalSubjects = ["TEACHING_TEACHER", "ACADEMIC_PLANNER", "PLANNING_MENTOR"] as const;
const knownPersonalScopes = ["SELF", "REGION", "CAMPUS", "ASSOCIATED_TEACHERS", "MENTEES", "VENUE", "GLOBAL"] as const;
const statuses = ["PENDING_APPROVAL", "APPROVED", "REJECTED", "COMPLETED", "REVERSED"] as const;
const reversalSubjects = ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"] as const;
type ReversalSubject = (typeof reversalSubjects)[number];
const attachmentPurposes = ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT", "INVOICE"] as const;
const mediaTypes = ["application/pdf", "image/png", "image/jpeg"] as const;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function invalid(code: string): never { throw new Error(code); }
const validDate = (at: Date): void => { if (!Number.isFinite(at.getTime())) invalid("INVALID_INPUT"); };
const isPersonalReader = (context: RoleContext): boolean =>
  personalSubjects.includes(context.subject as (typeof personalSubjects)[number])
  && knownPersonalScopes.includes((context.scope ?? "") as (typeof knownPersonalScopes)[number]);
const isManagedReader = (context: RoleContext): boolean =>
  (context.subject === "HEADQUARTERS_FINANCE" || context.subject === "SYSTEM_ADMIN" || context.subject === "SYSTEM_OWNER")
  && context.scope === "GLOBAL"
  && context.regionId === undefined && context.campusId === undefined && context.venueId === undefined;
const parseVersion = (value: string | null): number => {
  if (value === null) invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  return parsed;
};
const count = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  return parsed;
};
const validCents = (value: string | null): bigint => {
  if (value === null || !/^[0-9]+$/.test(value)) invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  const parsed = BigInt(value);
  if (parsed <= 0n) invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  return parsed;
};
const validUuid = (value: string | null): string => {
  if (value === null || !UUID.test(value)) invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  return value;
};
const validTimestamp = (value: string | null): string => {
  if (value === null || !Number.isFinite(new Date(value).getTime())) invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  return new Date(value).toISOString();
};
const validReversalSubject = (value: string | null): ReversalSubject => {
  if (!reversalSubjects.includes(value as ReversalSubject)) invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  return value as ReversalSubject;
};
const snapshot = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  return value as Record<string, unknown>;
};
const snapshotString = (record: Record<string, unknown>, field: string): string => {
  const value = record[field];
  if (typeof value !== "string") invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  return value;
};
const snapshotUuid = (record: Record<string, unknown>, field: string): string => {
  const value = snapshotString(record, field);
  if (!UUID.test(value)) invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  return value;
};
const snapshotNullableUuid = (record: Record<string, unknown>, field: string): string | null => {
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== "string" || !UUID.test(value)) invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  return value;
};
const snapshotVersion = (record: Record<string, unknown>, field: string): number => {
  const value = record[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  return value;
};
const snapshotTime = (record: Record<string, unknown>, field: string): string => {
  const value = snapshotString(record, field);
  if (!Number.isFinite(new Date(value).getTime())) invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  return new Date(value).toISOString();
};
const snapshotNullableTime = (record: Record<string, unknown>, field: string): string | null => {
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(new Date(value).getTime())) invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  return new Date(value).toISOString();
};

const validateApplicantSnapshot = (
  value: unknown,
  applicantId: string,
  destinationAccountId: string
): Readonly<{
  subject: (typeof personalSubjects)[number];
  scope: string;
  regionId: string | null;
  campusId: string | null;
  venueId: string | null;
  record: Record<string, unknown>;
}> => {
  const record = snapshot(value);
  const subject = snapshotString(record, "applicantContextSubject");
  const scope = snapshotString(record, "applicantContextScope");
  const regionId = snapshotNullableUuid(record, "applicantContextRegionId");
  const campusId = snapshotNullableUuid(record, "applicantContextCampusId");
  const venueId = snapshotNullableUuid(record, "applicantContextVenueId");
  if (snapshotUuid(record, "applicantPersonId") !== applicantId
    || snapshotUuid(record, "destinationAccountId") !== destinationAccountId
    || !personalSubjects.includes(subject as (typeof personalSubjects)[number])
    || !knownPersonalScopes.includes(scope as (typeof knownPersonalScopes)[number])) {
    invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  }
  return { subject: subject as (typeof personalSubjects)[number], scope, regionId, campusId, venueId, record };
};

const summarySelect = `
  SELECT document.id::text AS id,document.kind AS document_kind,document.status,document.version::text AS version,
         to_char(document.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS document_created_at,
         document.applicant_person_id::text AS applicant_person_id,applicant.nickname AS applicant_display_name,
         submission.finance_document_id::text AS submission_document_id,
         submission.source_document_version::text AS source_document_version,submission.result_document_version::text AS result_document_version,
         submission.destination_account_id::text AS destination_account_id,submission.amount_cents::text AS amount_cents,
         submission.reason,submission.applicant_context_snapshot,submission.submitted_by_person_id::text AS submitted_by_person_id,
         to_char(submission.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS submitted_at,
         to_char(submission.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS submission_created_at,
         destination.owner_type AS destination_owner_type,destination.owner_id::text AS destination_owner_id,
         decision.finance_document_id::text AS decision_document_id,
         decision.source_document_version::text AS decision_source_document_version,
         decision.result_document_version::text AS decision_result_document_version,decision.decision,
         decision.reason AS decision_reason,decision.decided_by_person_id::text AS decided_by_person_id,
         decision.actor_subject_code,decision.actor_scope_type,decision.authorization_snapshot AS decision_authorization_snapshot,
         to_char(decision.decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at,
         to_char(decision.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decision_created_at,
         transfer.finance_document_id::text AS transfer_document_id,
         transfer.source_document_version::text AS transfer_source_document_version,
         transfer.result_document_version::text AS transfer_result_document_version,
         transfer.role_assignment_id::text AS role_assignment_id,transfer.company_fund_assignment_id::text AS company_fund_assignment_id,
         transfer.source_fund_id::text AS source_fund_id,transfer.source_account_id::text AS source_account_id,
         transfer.destination_account_id::text AS transfer_destination_account_id,transfer.amount_cents::text AS transfer_amount_cents,
         transfer.reason AS transfer_reason,transfer.authorization_snapshot AS transfer_authorization_snapshot,
         transfer.ledger_event_id::text AS transfer_ledger_event_id,ledger_event.event_type AS transfer_ledger_event_type,
         ledger_event.event_key AS transfer_ledger_event_key,transfer.executed_by_person_id::text AS executed_by_person_id,
         to_char(transfer.executed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS executed_at,
         to_char(transfer.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS transfer_created_at,
         transfer.source_before_cents::text AS source_before_cents,transfer.source_after_cents::text AS source_after_cents,
         transfer.destination_before_cents::text AS destination_before_cents,transfer.destination_after_cents::text AS destination_after_cents,
         source.owner_type AS source_owner_type,source.owner_id::text AS source_owner_id,
         transfer_destination.owner_type AS transfer_destination_owner_type,transfer_destination.owner_id::text AS transfer_destination_owner_id,
         fund.fund_code AS source_fund_code,role.person_id::text AS role_person_id,role.subject_code AS role_subject_code,
         role.scope_type AS role_scope_type,role.scope_id::text AS role_scope_id,
         to_char(role.valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS role_valid_from,
         to_char(role.valid_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS role_valid_to,
         assignment.fund_id::text AS fund_assignment_fund_id,assignment.duty_subject AS fund_assignment_subject,
         assignment.scope_type AS fund_assignment_scope,assignment.scope_id::text AS fund_assignment_scope_id,
         assignment.responsibility_code AS fund_assignment_responsibility,
         to_char(assignment.valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS fund_assignment_valid_from,
         to_char(assignment.valid_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS fund_assignment_valid_to,
         (SELECT count(*)=1
            FROM company_finance_fund_assignment successor
            JOIN company_finance_fund_command_idempotency closure_command
              ON closure_command.operation='ASSIGN'
             AND closure_command.result_json->>'previousAssignmentId'=assignment.id::text
             AND closure_command.result_json->>'id'=successor.id::text
             AND closure_command.result_json->>'fundId'=successor.fund_id::text
             AND closure_command.result_json->>'validFrom'=to_char(successor.valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
             AND closure_command.actor_person_id=successor.created_by_person_id
             AND closure_command.created_at=successor.created_at
           WHERE assignment.valid_to IS NOT NULL AND successor.valid_from=assignment.valid_to
             AND successor.duty_subject=assignment.duty_subject AND successor.scope_type=assignment.scope_type
             AND successor.scope_id IS NOT DISTINCT FROM assignment.scope_id
             AND successor.responsibility_code=assignment.responsibility_code
         ) AS fund_assignment_closure_valid,
         reversal.finance_document_id::text AS reversal_document_id,
         reversal.source_document_version::text AS reversal_source_document_version,
         reversal.result_document_version::text AS reversal_result_document_version,
         reversal.source_account_id::text AS reversal_source_account_id,reversal.destination_account_id::text AS reversal_destination_account_id,
         reversal.amount_cents::text AS reversal_amount_cents,reversal.original_ledger_event_id::text AS reversal_original_ledger_event_id,
         reversal.reversal_ledger_event_id::text AS reversal_ledger_event_id,reversal.reason AS reversal_reason,
         reversal.reversed_by_person_id::text AS reversed_by_person_id,reversal.actor_subject_code AS reversal_actor_subject_code,
         reversal.actor_scope_type AS reversal_actor_scope_type,reversal.authorization_snapshot AS reversal_authorization_snapshot,
         to_char(reversal.reversed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS reversed_at,
         to_char(reversal.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS reversal_created_at,
         reversal.source_before_cents::text AS reversal_source_before_cents,reversal.source_after_cents::text AS reversal_source_after_cents,
         reversal.destination_before_cents::text AS reversal_destination_before_cents,reversal.destination_after_cents::text AS reversal_destination_after_cents,
         (reversal.authorization_snapshot->'originalTransferAuthorization'=transfer.authorization_snapshot) AS reversal_original_authorization_matches,
         reversal_ledger_event.event_type AS reversal_ledger_event_type,reversal_ledger_event.event_key AS reversal_ledger_event_key,
         reversal_ledger_counts.entry_count::text AS reversal_entry_count,reversal_ledger_counts.source_entries::text AS reversal_source_entries,
         reversal_ledger_counts.destination_entries::text AS reversal_destination_entries,reversal_ledger_counts.other_entries::text AS reversal_other_entries,
         ledger_counts.entry_count::text AS ledger_entry_count,ledger_counts.source_entries::text AS source_ledger_entries,
         ledger_counts.destination_entries::text AS destination_ledger_entries,ledger_counts.other_entries::text AS other_ledger_entries,
         commands.command_count::text AS command_count,commands.submit_command_count::text AS submit_command_count,
         commands.decision_command_count::text AS decision_command_count,commands.execute_command_count::text AS execute_command_count,
         commands.reverse_command_count::text AS reverse_command_count,
         events.event_count::text AS event_count,events.created_event_count::text AS created_event_count,
         events.submitted_event_count::text AS submitted_event_count,events.decision_event_count::text AS decision_event_count,
         events.completed_event_count::text AS completed_event_count,events.reversed_event_count::text AS reversed_event_count,
         bindings.binding_count::text AS binding_count,bindings.binding_slot_count::text AS binding_slot_count,
         bindings.supporting_count::text AS supporting_count,bindings.screenshot_count::text AS screenshot_count,
         bindings.invalid_binding_count::text AS invalid_binding_count
    FROM finance_document document
    JOIN person applicant ON applicant.id=document.applicant_person_id
    LEFT JOIN finance_reimbursement_submission submission ON submission.finance_document_id=document.id
    LEFT JOIN settlement_account destination ON destination.id=submission.destination_account_id
    LEFT JOIN finance_reimbursement_decision decision ON decision.finance_document_id=document.id
    LEFT JOIN finance_reimbursement_transfer transfer ON transfer.finance_document_id=document.id
    LEFT JOIN settlement_account source ON source.id=transfer.source_account_id
    LEFT JOIN settlement_account transfer_destination ON transfer_destination.id=transfer.destination_account_id
    LEFT JOIN company_finance_fund fund ON fund.id=transfer.source_fund_id
    LEFT JOIN role_assignment role ON role.id=transfer.role_assignment_id
    LEFT JOIN company_finance_fund_assignment assignment ON assignment.id=transfer.company_fund_assignment_id
    LEFT JOIN ledger_event ledger_event ON ledger_event.id=transfer.ledger_event_id
    LEFT JOIN finance_reimbursement_reversal reversal ON reversal.finance_document_id=document.id
    LEFT JOIN ledger_event reversal_ledger_event ON reversal_ledger_event.id=reversal.reversal_ledger_event_id
    LEFT JOIN LATERAL (
      SELECT count(*) AS command_count,
             count(*) FILTER (WHERE command.operation='SUBMIT' AND command.actor_person_id=submission.submitted_by_person_id
               AND command.result_status='PENDING_APPROVAL' AND command.result_document_version=submission.result_document_version
               AND command.created_at=submission.submitted_at) AS submit_command_count,
             count(*) FILTER (WHERE command.operation=CASE decision.decision WHEN 'APPROVED' THEN 'APPROVE' WHEN 'REJECTED' THEN 'REJECT' ELSE NULL END
               AND command.actor_person_id=decision.decided_by_person_id AND command.result_status=decision.decision
               AND command.result_document_version=decision.result_document_version AND command.created_at=decision.decided_at) AS decision_command_count,
             count(*) FILTER (WHERE command.operation='EXECUTE' AND command.actor_person_id=transfer.executed_by_person_id
               AND command.result_status='COMPLETED' AND command.result_document_version=transfer.result_document_version
               AND command.created_at=transfer.executed_at) AS execute_command_count,
             count(*) FILTER (WHERE command.operation='REVERSE' AND command.actor_person_id=reversal.reversed_by_person_id
               AND command.result_status='REVERSED' AND command.result_document_version=reversal.result_document_version
               AND command.created_at=reversal.reversed_at) AS reverse_command_count
        FROM finance_reimbursement_command_idempotency command WHERE command.finance_document_id=document.id
    ) commands ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS entry_count,
             count(*) FILTER (WHERE entry.account_id=transfer.source_account_id AND entry.category_key='reimbursementExpense'
               AND entry.amount_cents=-transfer.amount_cents) AS source_entries,
             count(*) FILTER (WHERE entry.account_id=transfer.destination_account_id AND entry.category_key='reimbursementIncome'
               AND entry.amount_cents=transfer.amount_cents) AS destination_entries,
             count(*) FILTER (WHERE entry.account_id NOT IN (transfer.source_account_id,transfer.destination_account_id)) AS other_entries
        FROM ledger_entry entry WHERE entry.event_id=transfer.ledger_event_id
    ) ledger_counts ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS entry_count,
             count(*) FILTER (WHERE entry.account_id=reversal.source_account_id AND entry.category_key='reimbursementExpenseReversal'
               AND entry.amount_cents=reversal.amount_cents) AS source_entries,
             count(*) FILTER (WHERE entry.account_id=reversal.destination_account_id AND entry.category_key='reimbursementIncomeReversal'
               AND entry.amount_cents=-reversal.amount_cents) AS destination_entries,
             count(*) FILTER (WHERE entry.account_id NOT IN (reversal.source_account_id,reversal.destination_account_id)) AS other_entries
        FROM ledger_entry entry WHERE entry.event_id=reversal.reversal_ledger_event_id
    ) reversal_ledger_counts ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS event_count,
             count(*) FILTER (WHERE event.event_type='CREATED' AND event.actor_person_id=document.applicant_person_id AND event.result_document_version=1) AS created_event_count,
             count(*) FILTER (WHERE event.event_type='REIMBURSEMENT_SUBMITTED' AND event.actor_person_id=submission.submitted_by_person_id
               AND event.result_document_version=submission.result_document_version) AS submitted_event_count,
             count(*) FILTER (WHERE event.event_type=CASE decision.decision WHEN 'APPROVED' THEN 'REIMBURSEMENT_APPROVED'
               WHEN 'REJECTED' THEN 'REIMBURSEMENT_REJECTED' ELSE NULL END AND event.actor_person_id=decision.decided_by_person_id
               AND event.result_document_version=decision.result_document_version) AS decision_event_count,
             count(*) FILTER (WHERE event.event_type='REIMBURSEMENT_COMPLETED' AND event.actor_person_id=transfer.executed_by_person_id
               AND event.result_document_version=transfer.result_document_version AND event.ledger_event_id=transfer.ledger_event_id
               AND event.created_at=transfer.executed_at) AS completed_event_count,
             count(*) FILTER (WHERE event.event_type='REIMBURSEMENT_REVERSED' AND event.actor_person_id=reversal.reversed_by_person_id
               AND event.result_document_version=reversal.result_document_version AND event.ledger_event_id=reversal.reversal_ledger_event_id
               AND event.created_at=reversal.reversed_at AND event.details_json->>'processingMode'='MANUAL'
               AND event.details_json->>'reason'=reversal.reason AND event.details_json->>'originalLedgerEventId'=reversal.original_ledger_event_id::text
               AND event.details_json->>'actorSubjectCode'=reversal.actor_subject_code AND event.details_json->>'actorScopeType'=reversal.actor_scope_type) AS reversed_event_count
        FROM finance_document_event event WHERE event.finance_document_id=document.id
    ) events ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS binding_count,count(DISTINCT version.finance_attachment_id) AS binding_slot_count,
             count(*) FILTER (WHERE binding.purpose='SUPPORTING_DOCUMENT') AS supporting_count,
             count(*) FILTER (WHERE binding.purpose='APPLICATION_SCREENSHOT') AS screenshot_count,
             count(*) FILTER (WHERE binding.stage<>'SUBMISSION' OR binding.document_version<>submission.result_document_version
               OR binding.bound_by_person_id<>document.applicant_person_id OR binding.bound_at<>submission.submitted_at
               OR binding.created_at<>binding.bound_at OR attachment.finance_document_id<>document.id
               OR attachment.purpose<>binding.purpose OR attachment.created_by_person_id<>document.applicant_person_id
               OR version.uploaded_by_person_id<>document.applicant_person_id OR version.status<>'READY'
               OR version.detected_media_type NOT IN ('application/pdf','image/png','image/jpeg')
               OR version.actual_size_bytes IS NULL OR version.actual_size_bytes<=0 OR version.sha256 IS NULL
               OR version.sha256 !~ '^[0-9a-f]{64}$' OR version.ready_at IS NULL) AS invalid_binding_count
        FROM finance_reimbursement_attachment_binding binding
        LEFT JOIN finance_attachment_version version ON version.id=binding.finance_attachment_version_id
        LEFT JOIN finance_attachment attachment ON attachment.id=version.finance_attachment_id
       WHERE binding.finance_document_id=document.id
    ) bindings ON true
   WHERE document.kind='REIMBURSEMENT' AND document.status IN ('PENDING_APPROVAL','APPROVED','REJECTED','COMPLETED','REVERSED')`;

const attachmentSelect = `
  SELECT version.id::text AS version_id,binding.stage AS binding_stage,binding.purpose AS binding_purpose,
         attachment.purpose AS attachment_purpose,attachment.id::text AS attachment_slot_id,
         attachment.finance_document_id::text AS attachment_document_id,
         attachment.created_by_person_id::text AS attachment_created_by_person_id,
         version.uploaded_by_person_id::text AS uploaded_by_person_id,binding.document_version::text AS document_version,
         binding.bound_by_person_id::text AS bound_by_person_id,
         to_char(binding.bound_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS bound_at,
         to_char(binding.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS binding_created_at,
         version.status,version.original_filename,version.detected_media_type AS media_type,
         version.actual_size_bytes::text AS size_bytes,version.sha256,
         to_char(version.ready_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ready_at
    FROM finance_reimbursement_attachment_binding binding
    JOIN finance_attachment_version version ON version.id=binding.finance_attachment_version_id
    JOIN finance_attachment attachment ON attachment.id=version.finance_attachment_id
   WHERE binding.finance_document_id=$1::uuid
   ORDER BY binding.purpose,attachment.id,version.id`;

const validSignedCents = (value: string | null): bigint => {
  if (value === null || !/^-?[0-9]+$/.test(value)) invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  return BigInt(value);
};

const noTransfer = (row: SummaryRow): boolean => [
  row.transfer_document_id,row.transfer_source_document_version,row.transfer_result_document_version,row.role_assignment_id,
  row.company_fund_assignment_id,row.source_fund_id,row.source_account_id,row.transfer_destination_account_id,
  row.transfer_amount_cents,row.transfer_reason,row.transfer_authorization_snapshot,row.transfer_ledger_event_id,
  row.transfer_ledger_event_type,row.transfer_ledger_event_key,row.executed_by_person_id,row.executed_at,row.transfer_created_at,
  row.source_before_cents,row.source_after_cents,row.destination_before_cents,row.destination_after_cents,row.source_owner_type,
  row.source_owner_id,row.transfer_destination_owner_type,row.transfer_destination_owner_id,row.source_fund_code,row.role_person_id,
  row.role_subject_code,row.role_scope_type,row.role_scope_id,row.role_valid_from,row.role_valid_to,row.fund_assignment_fund_id,
  row.fund_assignment_subject,row.fund_assignment_scope,row.fund_assignment_scope_id,row.fund_assignment_responsibility,
  row.fund_assignment_valid_from,row.fund_assignment_valid_to,
].every((value) => value === null)
  && row.ledger_entry_count === "0" && row.source_ledger_entries === "0" && row.destination_ledger_entries === "0" && row.other_ledger_entries === "0";

const noReversal = (row: SummaryRow): boolean => [
  row.reversal_document_id,row.reversal_source_document_version,row.reversal_result_document_version,
  row.reversal_source_account_id,row.reversal_destination_account_id,row.reversal_amount_cents,
  row.reversal_original_ledger_event_id,row.reversal_ledger_event_id,row.reversal_reason,row.reversed_by_person_id,
  row.reversal_actor_subject_code,row.reversal_actor_scope_type,row.reversal_authorization_snapshot,row.reversed_at,
  row.reversal_created_at,row.reversal_source_before_cents,row.reversal_source_after_cents,
  row.reversal_destination_before_cents,row.reversal_destination_after_cents,row.reversal_original_authorization_matches,
  row.reversal_ledger_event_type,row.reversal_ledger_event_key,
].every((value) => value === null)
  && row.reversal_entry_count === "0" && row.reversal_source_entries === "0"
  && row.reversal_destination_entries === "0" && row.reversal_other_entries === "0";

// A later assignment closure does not change the authorization that existed at execution.
// A previously fixed end remains immutable; both historical and frozen identities are still checked.
const matchesHistoricalEnd = (frozen: string | null, current: string | null, executedAt: string): boolean =>
  frozen === current || (frozen === null && current !== null
    && new Date(current).getTime() > new Date(executedAt).getTime());

const toParsedSummary = (row: SummaryRow): ParsedSummary => {
  const status = row.status as (typeof statuses)[number];
  const documentVersion = parseVersion(row.version);
  const sourceVersion = parseVersion(row.source_document_version);
  const submissionVersion = parseVersion(row.result_document_version);
  const submittedAt = validTimestamp(row.submitted_at);
  const submissionCreatedAt = validTimestamp(row.submission_created_at);
  const documentCreatedAt = validTimestamp(row.document_created_at);
  const applicantId = validUuid(row.applicant_person_id);
  const destinationAccountId = validUuid(row.destination_account_id);
  const submittedByPersonId = validUuid(row.submitted_by_person_id);
  const amount = validCents(row.amount_cents);
  if (row.document_kind !== "REIMBURSEMENT" || !statuses.includes(status)
    || row.submission_document_id !== row.id || sourceVersion + 1 !== submissionVersion
    || submittedByPersonId !== applicantId || row.destination_owner_type !== "PERSON" || row.destination_owner_id !== applicantId
    || row.applicant_display_name === null || !row.applicant_display_name.trim() || row.reason === null || !row.reason.trim()
    || row.reason.length > 1000 || CONTROL_CHARACTERS.test(row.reason) || submissionCreatedAt !== submittedAt
    || new Date(submittedAt).getTime() < new Date(documentCreatedAt).getTime()
    || count(row.binding_count) < 2 || count(row.binding_count) !== count(row.binding_slot_count)
    || count(row.supporting_count) < 1 || count(row.screenshot_count) < 1 || count(row.invalid_binding_count) !== 0
    || count(row.created_event_count) !== 1 || count(row.submitted_event_count) !== 1 || count(row.submit_command_count) !== 1) {
    invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  }
  const applicantSnapshot = validateApplicantSnapshot(row.applicant_context_snapshot, applicantId, destinationAccountId);

  let decidedByPersonId: string | null = null;
  let completedSourceFundId: string | null = null;
  let reversal: ParsedSummary["reversal"] = null;
  let completion: ParsedSummary["completion"] = null;
  if (status === "PENDING_APPROVAL") {
    if (documentVersion !== submissionVersion || count(row.event_count) !== 2 || count(row.command_count) !== 1
      || count(row.decision_event_count) !== 0 || count(row.completed_event_count) !== 0
      || count(row.decision_command_count) !== 0 || count(row.execute_command_count) !== 0 || count(row.reverse_command_count) !== 0
      || count(row.reversed_event_count) !== 0 || !noTransfer(row) || !noReversal(row)
      || row.decision_document_id !== null || row.decision_source_document_version !== null || row.decision_result_document_version !== null
      || row.decision !== null || row.decision_reason !== null || row.decided_by_person_id !== null
      || row.actor_subject_code !== null || row.actor_scope_type !== null || row.decision_authorization_snapshot !== null
      || row.decided_at !== null || row.decision_created_at !== null) {
      invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
    }
  } else {
    const decisionSourceVersion = parseVersion(row.decision_source_document_version);
    const decisionResultVersion = parseVersion(row.decision_result_document_version);
    decidedByPersonId = validUuid(row.decided_by_person_id);
    const decidedAt = validTimestamp(row.decided_at);
    const decisionCreatedAt = validTimestamp(row.decision_created_at);
    const expectedDecision = status === "REJECTED" ? "REJECTED" : "APPROVED";
    const completedDocumentVersion = status === "REVERSED" ? documentVersion - 1 : documentVersion;
    const expectedDecisionVersion = (status === "COMPLETED" || status === "REVERSED")
      ? completedDocumentVersion - 1 : documentVersion;
    if (row.decision_document_id !== row.id || decisionSourceVersion !== submissionVersion
      || decisionResultVersion !== decisionSourceVersion + 1 || decisionResultVersion !== expectedDecisionVersion
      || row.decision !== expectedDecision || row.actor_subject_code !== "HEADQUARTERS_FINANCE" || row.actor_scope_type !== "GLOBAL"
      || row.decision_reason === null || !row.decision_reason.trim() || row.decision_reason.length > 1000
      || CONTROL_CHARACTERS.test(row.decision_reason) || decisionCreatedAt !== decidedAt
      || new Date(decidedAt).getTime() < new Date(submittedAt).getTime() || count(row.decision_event_count) !== 1
      || count(row.decision_command_count) !== 1) {
      invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
    }
    const authorization = snapshot(row.decision_authorization_snapshot);
    if (snapshotUuid(authorization, "reviewerPersonId") !== decidedByPersonId
      || snapshotString(authorization, "reviewerSubjectCode") !== "HEADQUARTERS_FINANCE"
      || snapshotString(authorization, "reviewerScopeType") !== "GLOBAL"
      || snapshotNullableUuid(authorization, "reviewerContextRegionId") !== null
      || snapshotNullableUuid(authorization, "reviewerContextCampusId") !== null
      || snapshotNullableUuid(authorization, "reviewerContextVenueId") !== null
      || snapshotVersion(authorization, "submissionDocumentVersion") !== submissionVersion) {
      invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
    }
    const nestedSubmission = validateApplicantSnapshot(authorization.submissionSnapshot, applicantId, destinationAccountId);
    if (nestedSubmission.subject !== applicantSnapshot.subject || nestedSubmission.scope !== applicantSnapshot.scope
      || nestedSubmission.regionId !== applicantSnapshot.regionId || nestedSubmission.campusId !== applicantSnapshot.campusId
      || nestedSubmission.venueId !== applicantSnapshot.venueId) invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");

    if (status === "COMPLETED" || status === "REVERSED") {
      const transferSourceVersion = parseVersion(row.transfer_source_document_version);
      const transferResultVersion = parseVersion(row.transfer_result_document_version);
      const roleAssignmentId = validUuid(row.role_assignment_id);
      const companyFundAssignmentId = validUuid(row.company_fund_assignment_id);
      const sourceFundId = validUuid(row.source_fund_id);
      const sourceAccountId = validUuid(row.source_account_id);
      const transferDestinationAccountId = validUuid(row.transfer_destination_account_id);
      const ledgerEventId = validUuid(row.transfer_ledger_event_id);
      const executedByPersonId = validUuid(row.executed_by_person_id);
      const executedAt = validTimestamp(row.executed_at);
      if (row.transfer_document_id !== row.id || transferSourceVersion !== decisionResultVersion
        || transferResultVersion !== transferSourceVersion + 1 || transferResultVersion !== completedDocumentVersion
        || transferDestinationAccountId !== destinationAccountId || validCents(row.transfer_amount_cents) !== amount
        || row.transfer_reason !== row.reason || row.transfer_created_at === null || validTimestamp(row.transfer_created_at) !== executedAt
        || row.source_owner_type !== "COMPANY" || row.source_owner_id !== sourceFundId
        || row.transfer_destination_owner_type !== "PERSON" || row.transfer_destination_owner_id !== applicantId
        || row.role_person_id !== executedByPersonId || row.role_subject_code !== "HEADQUARTERS_FINANCE"
        || row.role_scope_type !== "GLOBAL" || row.role_scope_id !== null || row.fund_assignment_fund_id !== sourceFundId
        || row.fund_assignment_subject !== "HEADQUARTERS_FINANCE" || row.fund_assignment_scope !== "GLOBAL"
        || row.fund_assignment_scope_id !== null || row.fund_assignment_responsibility !== "FINANCE_OPERATING_SOURCE"
        || row.source_fund_code === null || !row.source_fund_code.trim()
        || row.transfer_ledger_event_type !== "REIMBURSEMENT_COMPLETED" || row.transfer_ledger_event_key !== `reimbursement:${row.id}`
        || count(row.event_count) !== (status === "REVERSED" ? 5 : 4) || count(row.command_count) !== (status === "REVERSED" ? 4 : 3)
        || count(row.completed_event_count) !== 1 || count(row.execute_command_count) !== 1 || count(row.reverse_command_count) !== (status === "REVERSED" ? 1 : 0)
        || count(row.reversed_event_count) !== (status === "REVERSED" ? 1 : 0)
        || row.ledger_entry_count !== "2" || row.source_ledger_entries !== "1"
        || row.destination_ledger_entries !== "1" || row.other_ledger_entries !== "0"
        || (status === "COMPLETED" && !noReversal(row))
        || validSignedCents(row.source_before_cents) - amount !== validSignedCents(row.source_after_cents)
        || validSignedCents(row.destination_before_cents) + amount !== validSignedCents(row.destination_after_cents)
        || new Date(executedAt).getTime() < new Date(decidedAt).getTime()
        || financeYearBounds(new Date(executedAt)).start !== financeYearBounds(new Date(submittedAt)).start) {
        invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
      }
      const authorization = snapshot(row.transfer_authorization_snapshot);
      const roleValidFrom = validTimestamp(row.role_valid_from);
      const roleValidTo = row.role_valid_to === null ? null : validTimestamp(row.role_valid_to);
      const assignmentValidFrom = validTimestamp(row.fund_assignment_valid_from);
      const assignmentValidTo = row.fund_assignment_valid_to === null ? null : validTimestamp(row.fund_assignment_valid_to);
      if (snapshotUuid(authorization, "executorPersonId") !== executedByPersonId
        || snapshotString(authorization, "executorSubjectCode") !== "HEADQUARTERS_FINANCE"
        || snapshotString(authorization, "executorScopeType") !== "GLOBAL"
        || snapshotUuid(authorization, "roleAssignmentId") !== roleAssignmentId
        || snapshotTime(authorization, "roleValidFrom") !== roleValidFrom || !matchesHistoricalEnd(snapshotNullableTime(authorization, "roleValidTo"), roleValidTo, executedAt)
        || snapshotUuid(authorization, "companyFundAssignmentId") !== companyFundAssignmentId
        || snapshotTime(authorization, "fundAssignmentValidFrom") !== assignmentValidFrom || !matchesHistoricalEnd(snapshotNullableTime(authorization, "fundAssignmentValidTo"), assignmentValidTo, executedAt)
        || (snapshotNullableTime(authorization, "fundAssignmentValidTo") === null && assignmentValidTo !== null
          && row.fund_assignment_closure_valid !== true)
        || snapshotUuid(authorization, "sourceFundId") !== sourceFundId || snapshotString(authorization, "sourceFundCode") !== row.source_fund_code
        || snapshotUuid(authorization, "sourceAccountId") !== sourceAccountId || snapshotUuid(authorization, "destinationAccountId") !== destinationAccountId
        || snapshotUuid(authorization, "applicantPersonId") !== applicantId || snapshotTime(authorization, "submittedAt") !== submittedAt
        || snapshotTime(authorization, "approvedAt") !== decidedAt || snapshotVersion(authorization, "submissionDocumentVersion") !== submissionVersion
        || snapshotVersion(authorization, "decisionDocumentVersion") !== decisionResultVersion
        || new Date(executedAt).getTime() < new Date(roleValidFrom).getTime()
        || (roleValidTo !== null && new Date(executedAt).getTime() >= new Date(roleValidTo).getTime())
        || new Date(executedAt).getTime() < new Date(assignmentValidFrom).getTime()
        || (assignmentValidTo !== null && new Date(executedAt).getTime() >= new Date(assignmentValidTo).getTime())) {
        invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
      }
      completedSourceFundId = sourceFundId;
      completion = { roleAssignmentId, companyFundAssignmentId, sourceAccountId, destinationAccountId, ledgerEventId, executedByPersonId, executedAt };
      if (status === "REVERSED") {
        const reversalSourceVersion = parseVersion(row.reversal_source_document_version);
        const reversalResultVersion = parseVersion(row.reversal_result_document_version);
        const reversalSourceAccountId = validUuid(row.reversal_source_account_id);
        const reversalDestinationAccountId = validUuid(row.reversal_destination_account_id);
        const reversalAmount = validCents(row.reversal_amount_cents);
        const originalLedgerEventId = validUuid(row.reversal_original_ledger_event_id);
        const reversalLedgerEventId = validUuid(row.reversal_ledger_event_id);
        const reversedByPersonId = validUuid(row.reversed_by_person_id);
        const reversedAt = validTimestamp(row.reversed_at);
        const reversalCreatedAt = validTimestamp(row.reversal_created_at);
        const reversalReason = row.reversal_reason;
        const actorSubjectCode = validReversalSubject(row.reversal_actor_subject_code);
        const actorScopeType = row.reversal_actor_scope_type;
        if (row.reversal_document_id !== row.id || reversalSourceVersion !== transferResultVersion
          || reversalResultVersion !== reversalSourceVersion + 1 || reversalResultVersion !== documentVersion
          || reversalSourceAccountId !== sourceAccountId || reversalDestinationAccountId !== destinationAccountId || reversalAmount !== amount
          || originalLedgerEventId !== ledgerEventId || reversalLedgerEventId === originalLedgerEventId
          || reversalReason === null || !reversalReason.trim() || reversalReason.length > 1000 || CONTROL_CHARACTERS.test(reversalReason)
          || reversalCreatedAt !== reversedAt || new Date(reversedAt).getTime() < new Date(executedAt).getTime()
          || actorScopeType !== "GLOBAL"
          || row.reversal_ledger_event_type !== "REIMBURSEMENT_REVERSED" || row.reversal_ledger_event_key !== `reimbursement-reversal:${row.id}`
          || row.reversal_entry_count !== "2" || row.reversal_source_entries !== "1" || row.reversal_destination_entries !== "1" || row.reversal_other_entries !== "0"
          || validSignedCents(row.reversal_source_after_cents) !== validSignedCents(row.reversal_source_before_cents) + amount
          || validSignedCents(row.reversal_destination_after_cents) !== validSignedCents(row.reversal_destination_before_cents) - amount
          || row.reversal_original_authorization_matches !== true) {
          invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
        }
        const reversalAuthorization = snapshot(row.reversal_authorization_snapshot);
        if (snapshotUuid(reversalAuthorization, "originalLedgerEventId") !== ledgerEventId
          || snapshotUuid(reversalAuthorization, "originalExecutedByPersonId") !== executedByPersonId
          || snapshotUuid(reversalAuthorization, "actorPersonId") !== reversedByPersonId
          || snapshotString(reversalAuthorization, "actorSubjectCode") !== actorSubjectCode
          || snapshotString(reversalAuthorization, "actorScopeType") !== "GLOBAL"
          || snapshotString(reversalAuthorization, "processingMode") !== "MANUAL") {
          invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
        }
        snapshot(reversalAuthorization.originalTransferAuthorization);
        reversal = {
          sourceAccountId: reversalSourceAccountId, destinationAccountId: reversalDestinationAccountId,
          originalLedgerEventId, reversalLedgerEventId, reason: reversalReason.trim(), reversedByPersonId,
          actorSubjectCode, actorScopeType: "GLOBAL", reversedAt,
        };
      }
    } else if (documentVersion !== decisionResultVersion || count(row.event_count) !== 3 || count(row.command_count) !== 2
      || count(row.completed_event_count) !== 0 || count(row.execute_command_count) !== 0 || count(row.reverse_command_count) !== 0
      || count(row.reversed_event_count) !== 0 || !noTransfer(row) || !noReversal(row)) {
      invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
    }
  }

  return {
    summary: {
      id: validUuid(row.id), status, version: documentVersion, amountCents: amount.toString(), reason: row.reason.trim(),
      applicantPersonId: applicantId, applicantDisplayName: row.applicant_display_name, submittedAt,
      ...(completion === null ? {} : { completedAt: completion.executedAt }),
      ...(reversal === null ? {} : { reversedAt: reversal.reversedAt, reversalReason: reversal.reason })
    },
    destinationAccountId, submittedByPersonId,
    applicantContextSubject: applicantSnapshot.subject, applicantContextScope: applicantSnapshot.scope,
    applicantContextRegionId: applicantSnapshot.regionId, applicantContextCampusId: applicantSnapshot.campusId,
    applicantContextVenueId: applicantSnapshot.venueId, decidedByPersonId, completedSourceFundId, reversal, completion
  };
};

export type ValidatedCompletedReimbursement = Readonly<{
  id: string;
  version: number;
  amountCents: bigint;
  reason: string;
  applicantPersonId: string;
  submittedAt: string;
  completedAt: string;
  sourceFundId: string;
  sourceAccountId: string;
  destinationAccountId: string;
  roleAssignmentId: string;
  companyFundAssignmentId: string;
  ledgerEventId: string;
  executedByPersonId: string;
  authorizationSnapshot: unknown;
}>;

/**
 * Internal transfer primitive. The caller must already hold `finance_document FOR UPDATE`
 * and must validate its expected version in the same transaction before invoking this read.
 * It opens no transaction and performs no audit write.
 */
export const readValidatedCompletedReimbursement = async (
  client: PostgresClient, documentId: string
): Promise<ValidatedCompletedReimbursement> => {
  if (!UUID.test(documentId)) invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  const result = await client.query<SummaryRow>(`${summarySelect} AND document.id=$1::uuid`, [documentId]);
  if (result.rows.length !== 1) invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  const row = result.rows[0]!;
  const parsed = toParsedSummary(row);
  const completion = parsed.completion;
  if (parsed.summary.status !== "COMPLETED" || completion === null || parsed.completedSourceFundId === null) {
    invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  }
  return {
    id: parsed.summary.id,
    version: parsed.summary.version,
    amountCents: BigInt(parsed.summary.amountCents),
    reason: parsed.summary.reason,
    applicantPersonId: parsed.summary.applicantPersonId,
    submittedAt: parsed.summary.submittedAt,
    completedAt: completion.executedAt,
    sourceFundId: parsed.completedSourceFundId,
    sourceAccountId: completion.sourceAccountId,
    destinationAccountId: completion.destinationAccountId,
    roleAssignmentId: completion.roleAssignmentId,
    companyFundAssignmentId: completion.companyFundAssignmentId,
    ledgerEventId: completion.ledgerEventId,
    executedByPersonId: completion.executedByPersonId,
    authorizationSnapshot: row.transfer_authorization_snapshot,
  };
};

/** Internal overview read: reuse the full immutable completion chain in the caller's snapshot. */
export const readCompletedReimbursementIncome = async (
  client: PostgresClient, personId: string, destinationAccountId: string,
  bounds: Readonly<{ start: string; end: string }>
): Promise<bigint> => {
  const rows = await client.query<SummaryRow>(
    `${summarySelect}
       AND (document.applicant_person_id=$1::uuid OR submission.destination_account_id=$2::uuid
            OR transfer.destination_account_id=$2::uuid)
       AND (document.status IN ('COMPLETED','REVERSED') OR transfer.finance_document_id IS NOT NULL
            OR reversal.finance_document_id IS NOT NULL)
       AND ((submission.submitted_at >= $3::timestamptz AND submission.submitted_at < $4::timestamptz)
            OR (transfer.executed_at >= $3::timestamptz AND transfer.executed_at < $4::timestamptz))`,
    [personId, destinationAccountId, bounds.start, bounds.end]
  );
  let total = 0n;
  for (const row of rows.rows) {
    const parsed = toParsedSummary(row);
    if ((parsed.summary.status !== "COMPLETED" && parsed.summary.status !== "REVERSED") || parsed.completion === null
      || parsed.summary.applicantPersonId !== personId || parsed.destinationAccountId !== destinationAccountId
      || parsed.completion.destinationAccountId !== destinationAccountId
      || new Date(parsed.completion.executedAt).getTime() < new Date(bounds.start).getTime()
      || new Date(parsed.completion.executedAt).getTime() >= new Date(bounds.end).getTime()) {
      invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
    }
    if (parsed.summary.status === "COMPLETED") total += BigInt(parsed.summary.amountCents);
  }
  return total;
};

const toAttachments = (rows: readonly AttachmentRow[], row: SummaryRow): ReimbursementDetail["attachments"] => {
  const submissionVersion = parseVersion(row.result_document_version);
  const submittedAt = validTimestamp(row.submitted_at);
  const applicantId = validUuid(row.applicant_person_id);
  const purposes = new Set<string>();
  const slots = new Set<string>();
  const attachments = rows.map((attachment) => {
    const slot = validUuid(attachment.attachment_slot_id);
    if (slots.has(slot) || !UUID.test(attachment.version_id) || attachment.binding_stage !== "SUBMISSION"
      || !attachmentPurposes.includes(attachment.binding_purpose as (typeof attachmentPurposes)[number])
      || attachment.attachment_purpose !== attachment.binding_purpose || attachment.attachment_document_id !== row.id
      || attachment.attachment_created_by_person_id !== applicantId || attachment.uploaded_by_person_id !== applicantId
      || parseVersion(attachment.document_version) !== submissionVersion || attachment.bound_by_person_id !== applicantId
      || validTimestamp(attachment.bound_at) !== submittedAt || validTimestamp(attachment.binding_created_at) !== submittedAt
      || attachment.status !== "READY" || attachment.media_type === null
      || !mediaTypes.includes(attachment.media_type as (typeof mediaTypes)[number])
      || attachment.size_bytes === null || !Number.isSafeInteger(Number(attachment.size_bytes)) || Number(attachment.size_bytes) < 1
      || attachment.sha256 === null || !SHA256.test(attachment.sha256)
      || attachment.ready_at === null || !Number.isFinite(new Date(attachment.ready_at).getTime())) {
      invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
    }
    slots.add(slot);
    purposes.add(attachment.binding_purpose);
    return {
      versionId: attachment.version_id,
      purpose: attachment.binding_purpose as ReimbursementDetail["attachments"][number]["purpose"],
      originalFilename: attachment.original_filename,
      mediaType: attachment.media_type as ReimbursementDetail["attachments"][number]["mediaType"],
      sizeBytes: Number(attachment.size_bytes), sha256: attachment.sha256
    };
  });
  if (!purposes.has("SUPPORTING_DOCUMENT") || !purposes.has("APPLICATION_SCREENSHOT")) {
    invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  }
  return attachments;
};

const insertAudit = async (
  client: PostgresClient, context: RoleContext, documentId: string, action: string, reason: string, at: Date
): Promise<void> => {
  await client.query(
    `INSERT INTO audit_event(actor_person_id,action_code,subject_type,subject_id,after_json,reason,created_at)
     VALUES($1::uuid,$2,'FINANCE_REIMBURSEMENT',$3::uuid,jsonb_build_object('contextSubject',$4::text),$5,$6::timestamptz)`,
    [context.personId, action, documentId, context.subject, reason, at.toISOString()]
  );
};

export class PostgresReimbursementReadService {
  public constructor(private readonly pool: PostgresPool) {}

  public async listOwn(context: RoleContext, at: Date): Promise<Readonly<{ documents: readonly ReimbursementSummary[] }>> {
    if (!isPersonalReader(context)) invalid("FORBIDDEN_SCOPE");
    validDate(at);
    const bounds = financeYearBounds(at);
    return this.list(`${summarySelect} AND document.applicant_person_id=$1::uuid
      AND submission.submitted_at >= $2::timestamptz AND submission.submitted_at < $3::timestamptz
      ORDER BY submission.submitted_at DESC,document.id DESC`, [context.personId, bounds.start, bounds.end]);
  }

  public async listManaged(context: RoleContext): Promise<Readonly<{ documents: readonly ReimbursementSummary[] }>> {
    if (!isManagedReader(context)) invalid("FORBIDDEN_SCOPE");
    return this.list(`${summarySelect} ORDER BY submission.submitted_at DESC NULLS LAST,document.id DESC`, []);
  }

  public async getDetail(context: RoleContext, documentId: string, at: Date): Promise<ReimbursementDetail> {
    if (!UUID.test(documentId)) invalid("INVALID_INPUT");
    validDate(at);
    const personal = isPersonalReader(context);
    const managed = isManagedReader(context);
    const client = await this.pool.connect();
    let open = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      open = true;
      const fail = async (action: "REIMBURSEMENT_DETAIL_DENIED" | "REIMBURSEMENT_DETAIL_INTEGRITY_FAILED", reason: string, code: string): Promise<never> => {
        await insertAudit(client, context, documentId, action, reason, at);
        await client.query("COMMIT");
        open = false;
        throw new Error(code);
      };
      if (!personal && !managed) return await fail("REIMBURSEMENT_DETAIL_DENIED", "FORBIDDEN_SCOPE", "FORBIDDEN_SCOPE");
      const basicResult = await client.query<Readonly<{
        id: string; applicant_person_id: string; document_kind: string; status: string; submitted_at: string | null;
      }>>(
        `SELECT document.id::text AS id,document.applicant_person_id::text AS applicant_person_id,
                document.kind AS document_kind,document.status,
                to_char(submission.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS submitted_at
           FROM finance_document document
           LEFT JOIN finance_reimbursement_submission submission ON submission.finance_document_id=document.id
          WHERE document.id=$1::uuid FOR SHARE OF document`, [documentId]
      );
      const basic = basicResult.rows[0];
      if (basic === undefined || basic.document_kind !== "REIMBURSEMENT" || !statuses.includes(basic.status as (typeof statuses)[number])
        || (personal && basic.applicant_person_id !== context.personId)) {
        return await fail("REIMBURSEMENT_DETAIL_DENIED", "NOT_FOUND_OR_FORBIDDEN", "FINANCE_DOCUMENT_NOT_FOUND");
      }
      if (basic.submitted_at === null || !Number.isFinite(new Date(basic.submitted_at).getTime())) {
        return await fail("REIMBURSEMENT_DETAIL_INTEGRITY_FAILED", "SUBMISSION_INVALID", "FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
      }
      if (personal) {
        const bounds = financeYearBounds(at);
        const submitted = new Date(basic.submitted_at).getTime();
        if (submitted < new Date(bounds.start).getTime() || submitted >= new Date(bounds.end).getTime()) {
          return await fail("REIMBURSEMENT_DETAIL_DENIED", "NOT_FOUND_OR_FORBIDDEN", "FINANCE_DOCUMENT_NOT_FOUND");
        }
      }
      const result = await client.query<SummaryRow>(`${summarySelect} AND document.id=$1::uuid FOR SHARE OF document`, [documentId]);
      const row = result.rows[0];
      if (row === undefined) {
        return await fail("REIMBURSEMENT_DETAIL_INTEGRITY_FAILED", "SUBMISSION_RELATION_INVALID", "FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
      }
      let parsed: ParsedSummary;
      let attachments: ReimbursementDetail["attachments"];
      try {
        parsed = toParsedSummary(row);
        attachments = toAttachments((await client.query<AttachmentRow>(attachmentSelect, [documentId])).rows, row);
      } catch (error) {
        if (error instanceof Error && error.message === "FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE") {
          return await fail("REIMBURSEMENT_DETAIL_INTEGRITY_FAILED", "REIMBURSEMENT_RECORD_INVALID", error.message);
        }
        throw error;
      }
      await insertAudit(client, context, documentId, "REIMBURSEMENT_DETAIL_READ", "AUTHORIZED_RECORD_READ", at);
      await client.query("COMMIT");
      open = false;
      return {
        ...parsed.summary,
        attachments,
        ...(row.decision === "APPROVED" || row.decision === "REJECTED" ? { decision: {
          decision: row.decision, reason: row.decision_reason!.trim(), decidedAt: validTimestamp(row.decided_at)
        } } : {}),
        ...(managed ? { management: {
          destinationAccountId: parsed.destinationAccountId, submittedByPersonId: parsed.submittedByPersonId,
          applicantContextSubject: parsed.applicantContextSubject, applicantContextScope: parsed.applicantContextScope,
          ...(parsed.applicantContextRegionId === null ? {} : { applicantContextRegionId: parsed.applicantContextRegionId }),
          ...(parsed.applicantContextCampusId === null ? {} : { applicantContextCampusId: parsed.applicantContextCampusId }),
          ...(parsed.applicantContextVenueId === null ? {} : { applicantContextVenueId: parsed.applicantContextVenueId }),
          ...(parsed.decidedByPersonId === null ? {} : {
            decidedByPersonId: parsed.decidedByPersonId,
            decisionActorSubject: "HEADQUARTERS_FINANCE" as const,
            decisionActorScope: "GLOBAL" as const
          }),
          ...(parsed.completion === null ? {} : { completion: parsed.completion }),
          ...(parsed.reversal === null ? {} : { reversal: {
            sourceAccountId: parsed.reversal.sourceAccountId, destinationAccountId: parsed.reversal.destinationAccountId,
            originalLedgerEventId: parsed.reversal.originalLedgerEventId, reversalLedgerEventId: parsed.reversal.reversalLedgerEventId,
            reversedByPersonId: parsed.reversal.reversedByPersonId, actorSubjectCode: parsed.reversal.actorSubjectCode,
            actorScopeType: parsed.reversal.actorScopeType, reversedAt: parsed.reversal.reversedAt,
          } })
        } } : {})
      };
    } catch (error) {
      if (open) await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.release();
    }
  }

  private async list(query: string, values: readonly unknown[]): Promise<Readonly<{ documents: readonly ReimbursementSummary[] }>> {
    const client = await this.pool.connect();
    try {
      return { documents: (await client.query<SummaryRow>(query, values)).rows.map((row) => toParsedSummary(row).summary) };
    } finally {
      await client.release();
    }
  }
}
