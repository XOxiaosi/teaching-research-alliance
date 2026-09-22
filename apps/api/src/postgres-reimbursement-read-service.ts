import type { RoleContext } from "@teaching-research-alliance/contracts";
import { financeYearBounds } from "./finance-year.js";
import type { PostgresClient, PostgresPool } from "./postgres-ledger-repository.js";

export type ReimbursementSummary = Readonly<{
  id: string;
  status: "PENDING_APPROVAL" | "APPROVED" | "REJECTED";
  version: number;
  amountCents: string;
  reason: string;
  applicantPersonId: string;
  applicantDisplayName: string;
  submittedAt: string;
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
  event_count: string;
  created_event_count: string;
  submitted_event_count: string;
  decision_event_count: string;
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
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const personalSubjects = ["TEACHING_TEACHER", "ACADEMIC_PLANNER", "PLANNING_MENTOR"] as const;
const knownPersonalScopes = ["SELF", "REGION", "CAMPUS", "ASSOCIATED_TEACHERS", "MENTEES", "VENUE", "GLOBAL"] as const;
const statuses = ["PENDING_APPROVAL", "APPROVED", "REJECTED"] as const;
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
         events.event_count::text AS event_count,events.created_event_count::text AS created_event_count,
         events.submitted_event_count::text AS submitted_event_count,events.decision_event_count::text AS decision_event_count,
         bindings.binding_count::text AS binding_count,bindings.binding_slot_count::text AS binding_slot_count,
         bindings.supporting_count::text AS supporting_count,bindings.screenshot_count::text AS screenshot_count,
         bindings.invalid_binding_count::text AS invalid_binding_count
    FROM finance_document document
    JOIN person applicant ON applicant.id=document.applicant_person_id
    LEFT JOIN finance_reimbursement_submission submission ON submission.finance_document_id=document.id
    LEFT JOIN settlement_account destination ON destination.id=submission.destination_account_id
    LEFT JOIN finance_reimbursement_decision decision ON decision.finance_document_id=document.id
    LEFT JOIN LATERAL (
      SELECT count(*) AS event_count,
             count(*) FILTER (WHERE event.event_type='CREATED' AND event.actor_person_id=document.applicant_person_id AND event.result_document_version=1) AS created_event_count,
             count(*) FILTER (WHERE event.event_type='REIMBURSEMENT_SUBMITTED' AND event.actor_person_id=submission.submitted_by_person_id
               AND event.result_document_version=submission.result_document_version) AS submitted_event_count,
             count(*) FILTER (WHERE event.event_type=CASE decision.decision WHEN 'APPROVED' THEN 'REIMBURSEMENT_APPROVED'
               WHEN 'REJECTED' THEN 'REIMBURSEMENT_REJECTED' ELSE NULL END AND event.actor_person_id=decision.decided_by_person_id
               AND event.result_document_version=decision.result_document_version) AS decision_event_count
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
   WHERE document.kind='REIMBURSEMENT' AND document.status IN ('PENDING_APPROVAL','APPROVED','REJECTED')`;

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
    || count(row.created_event_count) !== 1 || count(row.submitted_event_count) !== 1) {
    invalid("FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE");
  }
  const applicantSnapshot = validateApplicantSnapshot(row.applicant_context_snapshot, applicantId, destinationAccountId);

  let decidedByPersonId: string | null = null;
  if (status === "PENDING_APPROVAL") {
    if (documentVersion !== submissionVersion || count(row.event_count) !== 2 || count(row.decision_event_count) !== 0
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
    if (row.decision_document_id !== row.id || decisionSourceVersion !== submissionVersion
      || decisionResultVersion !== decisionSourceVersion + 1 || decisionResultVersion !== documentVersion
      || row.decision !== status || row.actor_subject_code !== "HEADQUARTERS_FINANCE" || row.actor_scope_type !== "GLOBAL"
      || row.decision_reason === null || !row.decision_reason.trim() || row.decision_reason.length > 1000
      || CONTROL_CHARACTERS.test(row.decision_reason)
      || decisionCreatedAt !== decidedAt || new Date(decidedAt).getTime() < new Date(submittedAt).getTime()
      || count(row.event_count) !== 3 || count(row.decision_event_count) !== 1) {
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
  }

  return {
    summary: {
      id: validUuid(row.id), status, version: documentVersion, amountCents: amount.toString(), reason: row.reason.trim(),
      applicantPersonId: applicantId, applicantDisplayName: row.applicant_display_name, submittedAt
    },
    destinationAccountId, submittedByPersonId,
    applicantContextSubject: applicantSnapshot.subject, applicantContextScope: applicantSnapshot.scope,
    applicantContextRegionId: applicantSnapshot.regionId, applicantContextCampusId: applicantSnapshot.campusId,
    applicantContextVenueId: applicantSnapshot.venueId, decidedByPersonId
  };
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
          })
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
