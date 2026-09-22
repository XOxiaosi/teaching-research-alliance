import type { RoleContext } from "@teaching-research-alliance/contracts";
import { allocationDelta, type AllocationLine, type LedgerDelta } from "@teaching-research-alliance/domain";
import { financeYearBounds } from "./finance-year.js";
import type { PostgresClient, PostgresPool } from "./postgres-ledger-repository.js";

export type RefundSummary = Readonly<{
  id: string;
  status: "PENDING_APPROVAL" | "REFUNDED" | "REJECTED";
  version: number;
  reason: string;
  applicantPersonId: string;
  applicantDisplayName: string;
  referralCaseId: string;
  studentRecordId: string;
  studentDisplayName: string;
  submittedAt: string;
  submittedGrossAmountCents: string;
  selectedFeeCount: number;
}>;

export type RefundDetail = RefundSummary & Readonly<{
  selectedFees: readonly Readonly<{
    weeklyFeeEntryId: string;
    submittedFeeVersion: number;
    submittedGrossAmountCents: string;
    teachingWeekId: string;
    settlementMonth: string;
    refundStatus: "ACTIVE" | "REFUNDED";
  }>[];
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
    approvedGrossAmountCents: string;
    postingStatus: "POSTED" | "NO_BALANCE_CHANGE" | "REJECTED";
  }>;
  management?: Readonly<{
    submittedByPersonId: string;
    decidedByPersonId?: string;
    decisionActorSubject?: "HEADQUARTERS_FINANCE";
    decisionActorScope?: "GLOBAL";
    ledgerEventId?: string;
  }>;
}>;

type SummaryRow = Readonly<{
  id: string;
  kind: string;
  status: string;
  version: string;
  document_created_at: string;
  applicant_person_id: string;
  applicant_display_name: string | null;
  submission_document_id: string | null;
  referral_case_id: string | null;
  student_record_id: string | null;
  submission_source_version: string | null;
  submission_result_version: string | null;
  submission_reason: string | null;
  applicant_context_snapshot: unknown;
  submitted_by_person_id: string | null;
  submitted_at: string | null;
  submission_created_at: string | null;
  referral_receiver_person_id: string | null;
  referral_student_record_id: string | null;
  student_display_name: string | null;
  item_count: string;
  submitted_gross_amount_cents: string | null;
  invalid_item_count: string;
  decision_document_id: string | null;
  decision_source_version: string | null;
  decision_result_version: string | null;
  decision: string | null;
  decision_reason: string | null;
  decided_by_person_id: string | null;
  actor_subject_code: string | null;
  actor_scope_type: string | null;
  decision_authorization_snapshot: unknown;
  decision_submission_snapshot_matches: boolean | null;
  decided_at: string | null;
  decision_created_at: string | null;
  posting_status: string | null;
  ledger_event_id: string | null;
  ledger_event_type: string | null;
  ledger_event_key: string | null;
  approved_gross_amount_cents: string | null;
  event_count: string;
  created_event_count: string;
  submitted_event_count: string;
  decision_event_count: string;
  binding_count: string;
  binding_slot_count: string;
  supporting_count: string;
  screenshot_count: string;
  invalid_binding_count: string;
  effect_count: string;
  invalid_effect_count: string;
  effect_gross_amount_cents: string | null;
}>;

type FeeRow = Readonly<{
  weekly_fee_entry_id: string;
  submitted_fee_version: string;
  submitted_gross_amount_cents: string;
  teaching_week_id: string;
  settlement_month: string;
  entry_referral_case_id: string | null;
  entry_version: string | null;
  entry_gross_amount_cents: string | null;
  version_referral_case_id: string | null;
  version_teaching_week_id: string | null;
  version_settlement_month: string | null;
  version_gross_amount_cents: string | null;
  effect_document_id: string | null;
  effect_source_weekly_fee_version: string | null;
  effect_gross_amount_cents: string | null;
  allocation_snapshot_id: string | null;
  allocation_fee_entry_id: string | null;
  allocation_source_weekly_fee_version: string | null;
  allocation_snapshot_json: unknown;
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

type EffectLedgerRow = Readonly<{ snapshot_json: unknown; gross_amount_cents: string }>;
type LedgerEntryRow = Readonly<{ account_code: string; category_key: string; amount_cents: string }>;

type ParsedSummary = Readonly<{
  summary: RefundSummary;
  submittedByPersonId: string;
  decidedByPersonId: string | null;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const statuses = ["PENDING_APPROVAL", "REFUNDED", "REJECTED"] as const;
const personalScopes = ["SELF", "REGION", "CAMPUS", "ASSOCIATED_TEACHERS", "MENTEES", "VENUE", "GLOBAL"] as const;
const attachmentPurposes = ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT", "INVOICE"] as const;
const mediaTypes = ["application/pdf", "image/png", "image/jpeg"] as const;
const CONTROL = /[\u0000-\u001f\u007f]/;
const allocationKeys = ["referrer", "planningMentor", "groupLeader", "teachingMentor", "venue", "campusConsultation", "platformFinance", "regionFinance", "teachingTeacher"] as const;

function invalid(code: string): never { throw new Error(code); }
const validDate = (at: Date): void => { if (!Number.isFinite(at.getTime())) invalid("INVALID_INPUT"); };
const isOwnReader = (context: RoleContext): boolean => context.subject === "TEACHING_TEACHER"
  && personalScopes.includes((context.scope ?? "") as (typeof personalScopes)[number]);
const isManagedReader = (context: RoleContext): boolean =>
  (context.subject === "HEADQUARTERS_FINANCE" || context.subject === "SYSTEM_ADMIN" || context.subject === "SYSTEM_OWNER")
  && context.scope === "GLOBAL" && context.regionId === undefined && context.campusId === undefined && context.venueId === undefined;
const version = (value: string | null): number => {
  if (value === null || !/^[1-9][0-9]*$/.test(value)) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
  return parsed;
};
const count = (value: string): number => {
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
  return Number(value);
};
const cents = (value: string | null, allowZero = true): bigint => {
  if (value === null || !/^[0-9]+$/.test(value)) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
  const parsed = BigInt(value);
  if (parsed < 0n || (!allowZero && parsed === 0n)) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
  return parsed;
};
const signedCents = (value: string): bigint => {
  if (!/^-?[0-9]+$/.test(value)) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
  return BigInt(value);
};
const uuid = (value: string | null): string => { if (value === null || !UUID.test(value)) invalid("FINANCE_REFUND_DATA_UNAVAILABLE"); return value; };
const timestamp = (value: string | null): string => {
  if (value === null || !Number.isFinite(new Date(value).getTime())) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
  return new Date(value).toISOString();
};
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
  return value as Record<string, unknown>;
};
const snapshotString = (value: Record<string, unknown>, field: string): string => {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string") invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
  return fieldValue;
};
const snapshotUuid = (value: Record<string, unknown>, field: string): string => {
  const fieldValue = snapshotString(value, field);
  if (!UUID.test(fieldValue)) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
  return fieldValue;
};
const snapshotNullableUuid = (value: Record<string, unknown>, field: string): string | null => {
  const fieldValue = value[field];
  if (fieldValue === null) return null;
  if (typeof fieldValue !== "string" || !UUID.test(fieldValue)) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
  return fieldValue;
};
const snapshotVersion = (value: Record<string, unknown>, field: string): number => {
  const fieldValue = value[field];
  if (typeof fieldValue !== "number" || !Number.isSafeInteger(fieldValue) || fieldValue < 1) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
  return fieldValue;
};
const exactKeys = (value: Record<string, unknown>, fields: readonly string[]): void => {
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
};
const parseAllocationSnapshot = (value: unknown): Readonly<{ lines: readonly AllocationLine[]; accountByKey: Readonly<Record<string, string>> }> => {
  const record = object(value);
  exactKeys(record, ["lines", "accountByKey"]);
  if (!Array.isArray(record.lines)) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
  const accounts = object(record.accountByKey);
  if (record.lines.length !== allocationKeys.length || Object.keys(accounts).some((key) => !allocationKeys.includes(key as (typeof allocationKeys)[number]))) {
    invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
  }
  const lines = record.lines.map((line): AllocationLine => {
    const entry = object(line);
    exactKeys(entry, ["key", "cents"]);
    const key = snapshotString(entry, "key");
    const amount = cents(snapshotString(entry, "cents"));
    if (!allocationKeys.includes(key as (typeof allocationKeys)[number])) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
    return { key, cents: amount };
  });
  if (new Set(lines.map((line) => line.key)).size !== allocationKeys.length) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
  const accountByKey: Record<string, string> = {};
  for (const [key, accountCode] of Object.entries(accounts)) {
    if (typeof accountCode !== "string" || !accountCode.trim()) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
    accountByKey[key] = accountCode;
  }
  if (lines.some((line) => line.cents !== 0n && accountByKey[line.key] === undefined)) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
  return { lines, accountByKey };
};
const aggregateDeltas = (deltas: readonly LedgerDelta[]): readonly LedgerDelta[] => {
  const aggregated = new Map<string, LedgerDelta>();
  for (const delta of deltas) {
    const key = `${delta.accountKey}\u0000${delta.categoryKey}`;
    const previous = aggregated.get(key);
    aggregated.set(key, { ...delta, amountCents: (previous?.amountCents ?? 0n) + delta.amountCents });
  }
  return [...aggregated.values()].filter((delta) => delta.amountCents !== 0n).sort((left, right) =>
    `${left.accountKey}\u0000${left.categoryKey}`.localeCompare(`${right.accountKey}\u0000${right.categoryKey}`));
};

const validateSubmissionSnapshot = (value: unknown, applicantId: string, referralId: string, studentId: string): void => {
  const record = object(value);
  exactKeys(record, ["applicantPersonId", "applicantContextSubject", "applicantContextScope", "applicantContextRegionId", "applicantContextCampusId", "applicantContextVenueId", "referralCaseId", "studentRecordId"]);
  const subject = snapshotString(record, "applicantContextSubject");
  const scope = snapshotString(record, "applicantContextScope");
  if (snapshotUuid(record, "applicantPersonId") !== applicantId || snapshotUuid(record, "referralCaseId") !== referralId
    || snapshotUuid(record, "studentRecordId") !== studentId || subject !== "TEACHING_TEACHER"
    || !personalScopes.includes(scope as (typeof personalScopes)[number])) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
  snapshotNullableUuid(record, "applicantContextRegionId");
  snapshotNullableUuid(record, "applicantContextCampusId");
  snapshotNullableUuid(record, "applicantContextVenueId");
};

const summarySelect = `
  SELECT document.id::text AS id,document.kind,document.status,document.version::text AS version,
         to_char(document.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS document_created_at,
         document.applicant_person_id::text AS applicant_person_id,applicant.nickname AS applicant_display_name,
         submission.finance_document_id::text AS submission_document_id,submission.referral_case_id::text AS referral_case_id,
         submission.student_record_id::text AS student_record_id,submission.source_document_version::text AS submission_source_version,
         submission.result_document_version::text AS submission_result_version,submission.reason AS submission_reason,
         submission.applicant_context_snapshot,submission.submitted_by_person_id::text AS submitted_by_person_id,
         to_char(submission.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS submitted_at,
         to_char(submission.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS submission_created_at,
         referral.receiver_person_id::text AS referral_receiver_person_id,referral.teacher_student_record_id::text AS referral_student_record_id,
         student.display_name AS student_display_name,
         items.item_count::text AS item_count,items.submitted_gross_amount_cents::text AS submitted_gross_amount_cents,
         items.invalid_item_count::text AS invalid_item_count,
         decision.finance_document_id::text AS decision_document_id,decision.source_document_version::text AS decision_source_version,
         decision.result_document_version::text AS decision_result_version,decision.decision,decision.reason AS decision_reason,
         decision.decided_by_person_id::text AS decided_by_person_id,decision.actor_subject_code,decision.actor_scope_type,
         decision.authorization_snapshot AS decision_authorization_snapshot,
         (decision.authorization_snapshot->'submissionSnapshot'=submission.applicant_context_snapshot) AS decision_submission_snapshot_matches,
         to_char(decision.decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at,
         to_char(decision.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decision_created_at,
         decision.posting_status,decision.ledger_event_id::text AS ledger_event_id,ledger.event_type AS ledger_event_type,ledger.event_key AS ledger_event_key,
         decision.approved_gross_amount_cents::text AS approved_gross_amount_cents,
         events.event_count::text AS event_count,events.created_event_count::text AS created_event_count,
         events.submitted_event_count::text AS submitted_event_count,events.decision_event_count::text AS decision_event_count,
         bindings.binding_count::text AS binding_count,bindings.binding_slot_count::text AS binding_slot_count,
         bindings.supporting_count::text AS supporting_count,bindings.screenshot_count::text AS screenshot_count,
         bindings.invalid_binding_count::text AS invalid_binding_count,
         effects.effect_count::text AS effect_count,effects.invalid_effect_count::text AS invalid_effect_count,
         effects.effect_gross_amount_cents::text AS effect_gross_amount_cents
    FROM finance_document document
    JOIN person applicant ON applicant.id=document.applicant_person_id
    LEFT JOIN finance_refund_submission submission ON submission.finance_document_id=document.id
    LEFT JOIN referral_case referral ON referral.id=submission.referral_case_id
    LEFT JOIN teacher_student_record student ON student.id=submission.student_record_id
    LEFT JOIN finance_refund_decision decision ON decision.finance_document_id=document.id
    LEFT JOIN ledger_event ledger ON ledger.id=decision.ledger_event_id
    LEFT JOIN LATERAL (
      SELECT count(*) AS item_count,coalesce(sum(item.submitted_gross_amount_cents),0) AS submitted_gross_amount_cents,
             count(*) FILTER (WHERE entry.referral_case_id IS DISTINCT FROM submission.referral_case_id
               OR historical.referral_case_id IS DISTINCT FROM submission.referral_case_id OR historical.teaching_week_id IS DISTINCT FROM item.teaching_week_id
               OR historical.settlement_month IS DISTINCT FROM item.settlement_month OR historical.gross_amount_cents IS DISTINCT FROM item.submitted_gross_amount_cents) AS invalid_item_count
        FROM finance_refund_submission_item item
        LEFT JOIN weekly_fee_entry entry ON entry.id=item.weekly_fee_entry_id
        LEFT JOIN weekly_fee_entry_version historical ON historical.weekly_fee_entry_id=item.weekly_fee_entry_id
          AND historical.version=item.submitted_fee_version
       WHERE item.finance_document_id=document.id
    ) items ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS event_count,
             count(*) FILTER (WHERE event.event_type='CREATED' AND event.actor_person_id=document.applicant_person_id AND event.result_document_version=1
               AND event.created_at=document.created_at AND event.ledger_event_id IS NULL) AS created_event_count,
             count(*) FILTER (WHERE event.event_type='REFUND_SUBMITTED' AND event.actor_person_id=submission.submitted_by_person_id
               AND event.result_document_version=submission.result_document_version AND event.created_at=submission.submitted_at
               AND event.ledger_event_id IS NULL) AS submitted_event_count,
             count(*) FILTER (WHERE event.event_type=CASE decision.decision WHEN 'APPROVED' THEN 'REFUND_APPROVED' WHEN 'REJECTED' THEN 'REFUND_REJECTED' ELSE NULL END
               AND event.actor_person_id=decision.decided_by_person_id AND event.result_document_version=decision.result_document_version
               AND event.created_at=decision.decided_at AND event.ledger_event_id IS NOT DISTINCT FROM decision.ledger_event_id) AS decision_event_count
        FROM finance_document_event event WHERE event.finance_document_id=document.id
    ) events ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS binding_count,count(DISTINCT version.finance_attachment_id) AS binding_slot_count,
             count(*) FILTER (WHERE binding.purpose='SUPPORTING_DOCUMENT') AS supporting_count,
             count(*) FILTER (WHERE binding.purpose='APPLICATION_SCREENSHOT') AS screenshot_count,
             count(*) FILTER (WHERE binding.stage<>'SUBMISSION' OR binding.document_version<>submission.result_document_version
               OR binding.bound_by_person_id<>document.applicant_person_id OR binding.bound_at<>submission.submitted_at
               OR binding.created_at<>binding.bound_at OR attachment.finance_document_id<>document.id OR attachment.purpose<>binding.purpose
               OR attachment.created_by_person_id<>document.applicant_person_id OR version.uploaded_by_person_id<>document.applicant_person_id
               OR version.status<>'READY' OR version.detected_media_type NOT IN ('application/pdf','image/png','image/jpeg')
               OR version.actual_size_bytes IS NULL OR version.actual_size_bytes<=0 OR version.sha256 IS NULL
               OR version.sha256 !~ '^[0-9a-f]{64}$' OR version.ready_at IS NULL) AS invalid_binding_count
        FROM finance_refund_attachment_binding binding
        LEFT JOIN finance_attachment_version version ON version.id=binding.finance_attachment_version_id
        LEFT JOIN finance_attachment attachment ON attachment.id=version.finance_attachment_id
       WHERE binding.finance_document_id=document.id
    ) bindings ON true
    LEFT JOIN LATERAL (
      SELECT count(effect.weekly_fee_entry_id) FILTER (WHERE effect.finance_document_id=document.id) AS effect_count,
             coalesce(sum(effect.gross_amount_cents) FILTER (WHERE effect.finance_document_id=document.id),0) AS effect_gross_amount_cents,
             count(*) FILTER (WHERE effect.weekly_fee_entry_id IS NOT NULL AND effect.finance_document_id=document.id AND (
               snapshot.weekly_fee_entry_id IS DISTINCT FROM effect.weekly_fee_entry_id OR snapshot.source_weekly_fee_version IS DISTINCT FROM effect.source_weekly_fee_version
               OR effective_fee_version.gross_amount_cents IS DISTINCT FROM effect.gross_amount_cents
               OR effect.snapshot_json IS DISTINCT FROM snapshot.snapshot_json OR jsonb_typeof(effect.snapshot_json) IS DISTINCT FROM 'object')) AS invalid_effect_count
        FROM finance_refund_submission_item item
        LEFT JOIN weekly_fee_refund_effect effect ON effect.weekly_fee_entry_id=item.weekly_fee_entry_id
        LEFT JOIN weekly_fee_allocation_snapshot snapshot ON snapshot.id=effect.allocation_snapshot_id
        LEFT JOIN weekly_fee_entry_version effective_fee_version ON effective_fee_version.weekly_fee_entry_id=effect.weekly_fee_entry_id
          AND effective_fee_version.version=effect.source_weekly_fee_version
       WHERE item.finance_document_id=document.id
    ) effects ON true
   WHERE document.kind='REFUND' AND document.status IN ('PENDING_APPROVAL','REFUNDED','REJECTED')`;

const feeSelect = `
  SELECT item.weekly_fee_entry_id::text AS weekly_fee_entry_id,item.submitted_fee_version::text AS submitted_fee_version,
         item.submitted_gross_amount_cents::text AS submitted_gross_amount_cents,item.teaching_week_id::text AS teaching_week_id,
         item.settlement_month::text AS settlement_month,entry.referral_case_id::text AS entry_referral_case_id,
         entry.version::text AS entry_version,entry.gross_amount_cents::text AS entry_gross_amount_cents,
         historical.referral_case_id::text AS version_referral_case_id,historical.teaching_week_id::text AS version_teaching_week_id,
         historical.settlement_month::text AS version_settlement_month,historical.gross_amount_cents::text AS version_gross_amount_cents,
         effect.finance_document_id::text AS effect_document_id,effect.source_weekly_fee_version::text AS effect_source_weekly_fee_version,
         effect.gross_amount_cents::text AS effect_gross_amount_cents,effect.allocation_snapshot_id::text AS allocation_snapshot_id,
         snapshot.weekly_fee_entry_id::text AS allocation_fee_entry_id,snapshot.source_weekly_fee_version::text AS allocation_source_weekly_fee_version,
         effect.snapshot_json AS allocation_snapshot_json
    FROM finance_refund_submission_item item
    LEFT JOIN weekly_fee_entry entry ON entry.id=item.weekly_fee_entry_id
    LEFT JOIN weekly_fee_entry_version historical ON historical.weekly_fee_entry_id=item.weekly_fee_entry_id AND historical.version=item.submitted_fee_version
    LEFT JOIN weekly_fee_refund_effect effect ON effect.weekly_fee_entry_id=item.weekly_fee_entry_id
    LEFT JOIN weekly_fee_allocation_snapshot snapshot ON snapshot.id=effect.allocation_snapshot_id
   WHERE item.finance_document_id=$1::uuid ORDER BY item.weekly_fee_entry_id`;

const attachmentSelect = `
  SELECT version.id::text AS version_id,binding.stage AS binding_stage,binding.purpose AS binding_purpose,
         attachment.purpose AS attachment_purpose,attachment.id::text AS attachment_slot_id,attachment.finance_document_id::text AS attachment_document_id,
         attachment.created_by_person_id::text AS attachment_created_by_person_id,version.uploaded_by_person_id::text AS uploaded_by_person_id,
         binding.document_version::text AS document_version,binding.bound_by_person_id::text AS bound_by_person_id,
         to_char(binding.bound_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS bound_at,
         to_char(binding.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS binding_created_at,
         version.status,version.original_filename,version.detected_media_type AS media_type,version.actual_size_bytes::text AS size_bytes,version.sha256,
         to_char(version.ready_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ready_at
    FROM finance_refund_attachment_binding binding
    JOIN finance_attachment_version version ON version.id=binding.finance_attachment_version_id
    JOIN finance_attachment attachment ON attachment.id=version.finance_attachment_id
   WHERE binding.finance_document_id=$1::uuid ORDER BY binding.purpose,attachment.id,version.id`;

const toSummary = (row: SummaryRow): ParsedSummary => {
  const status = row.status as (typeof statuses)[number];
  const documentVersion = version(row.version);
  const sourceVersion = version(row.submission_source_version);
  const submissionVersion = version(row.submission_result_version);
  const applicantId = uuid(row.applicant_person_id);
  const referralId = uuid(row.referral_case_id);
  const studentId = uuid(row.student_record_id);
  const submittedBy = uuid(row.submitted_by_person_id);
  const submittedAt = timestamp(row.submitted_at);
  const total = cents(row.submitted_gross_amount_cents);
  if (row.kind !== "REFUND" || !statuses.includes(status) || row.submission_document_id !== row.id || sourceVersion + 1 !== submissionVersion
    || row.applicant_display_name === null || !row.applicant_display_name.trim() || row.student_display_name === null || !row.student_display_name.trim()
    || row.submission_reason === null || !row.submission_reason.trim() || row.submission_reason.length > 1000 || CONTROL.test(row.submission_reason)
    || submittedBy !== applicantId || row.referral_receiver_person_id !== applicantId || row.referral_student_record_id !== studentId
    || timestamp(row.submission_created_at) !== submittedAt || new Date(submittedAt).getTime() < new Date(timestamp(row.document_created_at)).getTime()
    || count(row.item_count) < 1 || count(row.invalid_item_count) !== 0 || count(row.binding_count) < 2
    || count(row.binding_count) !== count(row.binding_slot_count) || count(row.supporting_count) < 1 || count(row.screenshot_count) < 1
    || count(row.invalid_binding_count) !== 0 || count(row.created_event_count) !== 1 || count(row.submitted_event_count) !== 1) {
    invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
  }
  validateSubmissionSnapshot(row.applicant_context_snapshot, applicantId, referralId, studentId);
  let decidedBy: string | null = null;
  if (status === "PENDING_APPROVAL") {
    if (documentVersion !== submissionVersion || count(row.event_count) !== 2 || count(row.decision_event_count) !== 0 || count(row.effect_count) !== 0
      || count(row.invalid_effect_count) !== 0 || row.decision_document_id !== null || row.decision !== null || row.posting_status !== null
      || row.ledger_event_id !== null || row.effect_gross_amount_cents !== "0") invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
  } else {
    const decisionSource = version(row.decision_source_version);
    const decisionResult = version(row.decision_result_version);
    decidedBy = uuid(row.decided_by_person_id);
    const decidedAt = timestamp(row.decided_at);
    if (row.decision_document_id !== row.id || decisionSource !== submissionVersion || decisionResult !== decisionSource + 1
      || decisionResult !== documentVersion || row.decision !== (status === "REFUNDED" ? "APPROVED" : "REJECTED")
      || row.actor_subject_code !== "HEADQUARTERS_FINANCE" || row.actor_scope_type !== "GLOBAL" || row.decision_reason === null
      || !row.decision_reason.trim() || row.decision_reason.length > 1000 || CONTROL.test(row.decision_reason)
      || timestamp(row.decision_created_at) !== decidedAt || new Date(decidedAt).getTime() < new Date(submittedAt).getTime()
      || count(row.event_count) !== 3 || count(row.decision_event_count) !== 1 || row.approved_gross_amount_cents === null) {
      invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
    }
    const authorization = object(row.decision_authorization_snapshot);
    exactKeys(authorization, ["reviewerPersonId", "reviewerSubjectCode", "reviewerScopeType", "reviewerContextRegionId", "reviewerContextCampusId", "reviewerContextVenueId", "submissionDocumentVersion", "submissionSnapshot"]);
    if (snapshotUuid(authorization, "reviewerPersonId") !== decidedBy || snapshotString(authorization, "reviewerSubjectCode") !== "HEADQUARTERS_FINANCE"
      || snapshotString(authorization, "reviewerScopeType") !== "GLOBAL" || snapshotNullableUuid(authorization, "reviewerContextRegionId") !== null
      || snapshotNullableUuid(authorization, "reviewerContextCampusId") !== null || snapshotNullableUuid(authorization, "reviewerContextVenueId") !== null
      || snapshotVersion(authorization, "submissionDocumentVersion") !== submissionVersion || row.decision_submission_snapshot_matches !== true) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
    validateSubmissionSnapshot(authorization.submissionSnapshot, applicantId, referralId, studentId);
    if (status === "REFUNDED") {
      if ((row.posting_status !== "POSTED" && row.posting_status !== "NO_BALANCE_CHANGE")
        || (row.posting_status === "POSTED" && (row.ledger_event_id === null || row.ledger_event_type !== "WEEKLY_FEE_REFUND" || row.ledger_event_key !== `weekly-fee-refund:${row.id}`))
        || (row.posting_status === "NO_BALANCE_CHANGE" && row.ledger_event_id !== null)
        || count(row.effect_count) !== count(row.item_count) || count(row.invalid_effect_count) !== 0
        || cents(row.effect_gross_amount_cents) !== cents(row.approved_gross_amount_cents)) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
    } else if (row.posting_status !== "REJECTED" || row.ledger_event_id !== null || count(row.effect_count) !== 0
      || count(row.invalid_effect_count) !== 0 || cents(row.approved_gross_amount_cents) !== 0n) {
      invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
    }
  }
  return { summary: {
    id: uuid(row.id), status, version: documentVersion, reason: row.submission_reason.trim(), applicantPersonId: applicantId,
    applicantDisplayName: row.applicant_display_name, referralCaseId: referralId, studentRecordId: studentId,
    studentDisplayName: row.student_display_name, submittedAt, submittedGrossAmountCents: total.toString(), selectedFeeCount: count(row.item_count)
  }, submittedByPersonId: submittedBy, decidedByPersonId: decidedBy };
};

const toFees = (rows: readonly FeeRow[], summary: RefundSummary): RefundDetail["selectedFees"] => rows.map((row) => {
  const feeId = uuid(row.weekly_fee_entry_id);
  const submittedVersion = version(row.submitted_fee_version);
  const submittedGross = cents(row.submitted_gross_amount_cents);
  const teachingWeekId = uuid(row.teaching_week_id);
  if (row.entry_referral_case_id !== summary.referralCaseId || row.version_referral_case_id !== summary.referralCaseId
    || row.version_teaching_week_id !== teachingWeekId || row.version_settlement_month !== row.settlement_month
    || cents(row.version_gross_amount_cents) !== submittedGross || !/^\d{4}-\d{2}-\d{2}$/.test(row.settlement_month)) {
    invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
  }
  const refunded = row.effect_document_id !== null;
  if (refunded && (uuid(row.effect_document_id) === "" || version(row.effect_source_weekly_fee_version) < 1
    || row.effect_gross_amount_cents === null || cents(row.effect_gross_amount_cents) < 0n || uuid(row.allocation_snapshot_id) === ""
    || row.allocation_fee_entry_id !== feeId || version(row.allocation_source_weekly_fee_version) < 1
    || version(row.entry_version) !== version(row.effect_source_weekly_fee_version)
    || cents(row.entry_gross_amount_cents) !== cents(row.effect_gross_amount_cents))) {
    invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
  }
  if (refunded) object(row.allocation_snapshot_json);
  if (summary.status === "REFUNDED" && (!refunded || row.effect_document_id !== summary.id)) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
  return { weeklyFeeEntryId: feeId, submittedFeeVersion: submittedVersion, submittedGrossAmountCents: submittedGross.toString(),
    teachingWeekId, settlementMonth: row.settlement_month, refundStatus: refunded ? "REFUNDED" : "ACTIVE" };
});

const toAttachments = (rows: readonly AttachmentRow[], row: SummaryRow): RefundDetail["attachments"] => {
  const submittedAt = timestamp(row.submitted_at);
  const submissionVersion = version(row.submission_result_version);
  const applicantId = uuid(row.applicant_person_id);
  const slots = new Set<string>();
  const purposes = new Set<string>();
  const result = rows.map((attachment) => {
    const slot = uuid(attachment.attachment_slot_id);
    if (slots.has(slot) || !UUID.test(attachment.version_id) || attachment.binding_stage !== "SUBMISSION"
      || !attachmentPurposes.includes(attachment.binding_purpose as (typeof attachmentPurposes)[number])
      || attachment.attachment_purpose !== attachment.binding_purpose || attachment.attachment_document_id !== row.id
      || attachment.attachment_created_by_person_id !== applicantId || attachment.uploaded_by_person_id !== applicantId
      || version(attachment.document_version) !== submissionVersion || attachment.bound_by_person_id !== applicantId
      || timestamp(attachment.bound_at) !== submittedAt || timestamp(attachment.binding_created_at) !== submittedAt
      || attachment.status !== "READY" || attachment.media_type === null || !mediaTypes.includes(attachment.media_type as (typeof mediaTypes)[number])
      || attachment.size_bytes === null || !Number.isSafeInteger(Number(attachment.size_bytes)) || Number(attachment.size_bytes) < 1
      || attachment.sha256 === null || !SHA256.test(attachment.sha256) || attachment.ready_at === null || !Number.isFinite(new Date(attachment.ready_at).getTime())) {
      invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
    }
    slots.add(slot); purposes.add(attachment.binding_purpose);
    return { versionId: attachment.version_id, purpose: attachment.binding_purpose as RefundDetail["attachments"][number]["purpose"],
      originalFilename: attachment.original_filename, mediaType: attachment.media_type as RefundDetail["attachments"][number]["mediaType"],
      sizeBytes: Number(attachment.size_bytes), sha256: attachment.sha256 };
  });
  if (!purposes.has("SUPPORTING_DOCUMENT") || !purposes.has("APPLICATION_SCREENSHOT")) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
  return result;
};

const audit = async (client: PostgresClient, context: RoleContext, documentId: string, action: string, reason: string, at: Date): Promise<void> => {
  await client.query(
    `INSERT INTO audit_event(actor_person_id,action_code,subject_type,subject_id,after_json,reason,created_at)
     VALUES($1::uuid,$2,'FINANCE_REFUND',$3::uuid,jsonb_build_object('contextSubject',$4::text),$5,$6::timestamptz)`,
    [context.personId, action, documentId, context.subject, reason, at.toISOString()]
  );
};

export class PostgresRefundReadService {
  public constructor(private readonly pool: PostgresPool) {}

  public async listOwn(context: RoleContext, at: Date): Promise<Readonly<{ documents: readonly RefundSummary[] }>> {
    if (!isOwnReader(context)) invalid("FORBIDDEN_SCOPE");
    validDate(at);
    const bounds = financeYearBounds(at);
    return this.list(`${summarySelect} AND document.applicant_person_id=$1::uuid AND submission.submitted_at >=$2::timestamptz
      AND submission.submitted_at<$3::timestamptz ORDER BY submission.submitted_at DESC,document.id DESC`, [context.personId, bounds.start, bounds.end]);
  }

  public async listManaged(context: RoleContext): Promise<Readonly<{ documents: readonly RefundSummary[] }>> {
    if (!isManagedReader(context)) invalid("FORBIDDEN_SCOPE");
    return this.list(`${summarySelect} ORDER BY submission.submitted_at DESC NULLS LAST,document.id DESC`, []);
  }

  public async getDetail(context: RoleContext, documentId: string, at: Date): Promise<RefundDetail> {
    if (!UUID.test(documentId)) invalid("INVALID_INPUT");
    validDate(at);
    const own = isOwnReader(context);
    const managed = isManagedReader(context);
    const client = await this.pool.connect();
    let open = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      open = true;
      const fail = async (action: "REFUND_DETAIL_DENIED" | "REFUND_DETAIL_INTEGRITY_FAILED", reason: string, code: string): Promise<never> => {
        await audit(client, context, documentId, action, reason, at);
        await client.query("COMMIT");
        open = false;
        throw new Error(code);
      };
      if (!own && !managed) return await fail("REFUND_DETAIL_DENIED", "FORBIDDEN_SCOPE", "FORBIDDEN_SCOPE");
      const basic = (await client.query<Readonly<{ applicant_person_id: string; submitted_at: string | null }>>(
        `SELECT document.applicant_person_id::text AS applicant_person_id,
                to_char(submission.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS submitted_at
           FROM finance_document document LEFT JOIN finance_refund_submission submission ON submission.finance_document_id=document.id
          WHERE document.id=$1::uuid AND document.kind='REFUND' AND document.status IN ('PENDING_APPROVAL','REFUNDED','REJECTED') FOR SHARE OF document`, [documentId]
      )).rows[0];
      if (basic === undefined || (own && basic.applicant_person_id !== context.personId)) {
        return await fail("REFUND_DETAIL_DENIED", "NOT_FOUND_OR_FORBIDDEN", "FINANCE_DOCUMENT_NOT_FOUND");
      }
      if (basic.submitted_at === null || !Number.isFinite(new Date(basic.submitted_at).getTime())) {
        return await fail("REFUND_DETAIL_INTEGRITY_FAILED", "SUBMISSION_INVALID", "FINANCE_REFUND_DATA_UNAVAILABLE");
      }
      if (own) {
        const bounds = financeYearBounds(at);
        const submittedAt = new Date(basic.submitted_at).getTime();
        if (submittedAt < new Date(bounds.start).getTime() || submittedAt >= new Date(bounds.end).getTime()) {
          return await fail("REFUND_DETAIL_DENIED", "NOT_FOUND_OR_FORBIDDEN", "FINANCE_DOCUMENT_NOT_FOUND");
        }
      }
      const row = (await client.query<SummaryRow>(`${summarySelect} AND document.id=$1::uuid FOR SHARE OF document`, [documentId])).rows[0];
      if (row === undefined) return await fail("REFUND_DETAIL_INTEGRITY_FAILED", "SUBMISSION_RELATION_INVALID", "FINANCE_REFUND_DATA_UNAVAILABLE");
      let parsed: ParsedSummary;
      let fees: RefundDetail["selectedFees"];
      let attachments: RefundDetail["attachments"];
      try {
        parsed = toSummary(row);
        await this.verifyRefundLedger(client, row, parsed.summary);
        fees = toFees((await client.query<FeeRow>(feeSelect, [documentId])).rows, parsed.summary);
        if (fees.length !== parsed.summary.selectedFeeCount) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
        attachments = toAttachments((await client.query<AttachmentRow>(attachmentSelect, [documentId])).rows, row);
      } catch (error) {
        if (error instanceof Error && error.message === "FINANCE_REFUND_DATA_UNAVAILABLE") {
          return await fail("REFUND_DETAIL_INTEGRITY_FAILED", "REFUND_RECORD_INVALID", error.message);
        }
        throw error;
      }
      await audit(client, context, documentId, "REFUND_DETAIL_READ", "AUTHORIZED_RECORD_READ", at);
      await client.query("COMMIT");
      open = false;
      const decision: RefundDetail["decision"] = row.decision === "APPROVED" || row.decision === "REJECTED" ? {
        decision: row.decision as "APPROVED" | "REJECTED", reason: row.decision_reason!.trim(), decidedAt: timestamp(row.decided_at),
        approvedGrossAmountCents: cents(row.approved_gross_amount_cents).toString(),
        postingStatus: row.posting_status as "POSTED" | "NO_BALANCE_CHANGE" | "REJECTED"
      } : undefined;
      return { ...parsed.summary, selectedFees: fees, attachments, ...(decision === undefined ? {} : { decision }), ...(managed ? {
        management: { submittedByPersonId: parsed.submittedByPersonId, ...(parsed.decidedByPersonId === null ? {} : {
          decidedByPersonId: parsed.decidedByPersonId, decisionActorSubject: "HEADQUARTERS_FINANCE" as const,
          decisionActorScope: "GLOBAL" as const, ...(row.ledger_event_id === null ? {} : { ledgerEventId: uuid(row.ledger_event_id) })
        }) }
      } : {}) };
    } catch (error) {
      if (open) await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.release();
    }
  }

  private async list(query: string, values: readonly unknown[]): Promise<Readonly<{ documents: readonly RefundSummary[] }>> {
    const client = await this.pool.connect();
    let open = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      open = true;
      const documents: RefundSummary[] = [];
      for (const row of (await client.query<SummaryRow>(query, values)).rows) {
        const parsed = toSummary(row);
        await this.verifyRefundLedger(client, row, parsed.summary);
        documents.push(parsed.summary);
      }
      await client.query("COMMIT");
      open = false;
      return { documents };
    } catch (error) {
      if (open) await client.query("ROLLBACK");
      throw error;
    } finally { await client.release(); }
  }

  private async verifyRefundLedger(client: PostgresClient, row: SummaryRow, summary: RefundSummary): Promise<void> {
    if (summary.status !== "REFUNDED") return;
    const snapshots = (await client.query<EffectLedgerRow>(
      "SELECT snapshot_json,gross_amount_cents::text AS gross_amount_cents FROM weekly_fee_refund_effect WHERE finance_document_id=$1::uuid ORDER BY weekly_fee_entry_id", [summary.id]
    )).rows;
    const expected = aggregateDeltas(snapshots.flatMap((effect) => {
      const allocation = parseAllocationSnapshot(effect.snapshot_json);
      if (allocation.lines.reduce((sum, line) => sum + line.cents, 0n) !== cents(effect.gross_amount_cents)) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
      return allocationDelta(allocation.lines, [], allocation.accountByKey);
    }));
    if (expected.reduce((sum, delta) => sum + delta.amountCents, 0n) !== -cents(row.approved_gross_amount_cents)) {
      invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
    }
    if (row.posting_status === "NO_BALANCE_CHANGE") {
      if (expected.length !== 0 || row.ledger_event_id !== null) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
      return;
    }
    if (row.posting_status !== "POSTED" || row.ledger_event_id === null || expected.length === 0) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
    const actual = (await client.query<LedgerEntryRow>(
      `SELECT account.account_code,entry.category_key,entry.amount_cents::text AS amount_cents
         FROM ledger_entry entry JOIN settlement_account account ON account.id=entry.account_id
        WHERE entry.event_id=$1::uuid ORDER BY account.account_code,entry.category_key`, [row.ledger_event_id]
    )).rows;
    if (actual.length !== expected.length) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
    const expectedByKey = new Map(expected.map((delta) => [`${delta.accountKey}\u0000${delta.categoryKey}`, delta.amountCents]));
    const seen = new Set<string>();
    for (const entry of actual) {
      if (!entry.account_code || !entry.category_key || signedCents(entry.amount_cents) === 0n) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
      const key = `${entry.account_code}\u0000${entry.category_key}`;
      if (seen.has(key) || expectedByKey.get(key) !== signedCents(entry.amount_cents)) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
      seen.add(key);
    }
    if (seen.size !== expectedByKey.size) invalid("FINANCE_REFUND_DATA_UNAVAILABLE");
  }
}
