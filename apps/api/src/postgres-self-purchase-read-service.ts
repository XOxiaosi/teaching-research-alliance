import type { RoleContext } from "@teaching-research-alliance/contracts";
import { financeYearBounds } from "./finance-year.js";
import type { PostgresClient, PostgresPool } from "./postgres-ledger-repository.js";

export type SelfPurchaseSummary = Readonly<{
  id: string;
  status: "COMPLETED";
  version: number;
  amountCents: string;
  reason: string;
  applicantPersonId: string;
  sourceFund: Readonly<{ id: string; displayName: string }>;
  processingMode: "SYSTEM_RULE";
  submittedAt: string;
  completedAt: string;
}>;

export type SelfPurchaseDetail = SelfPurchaseSummary & Readonly<{
  attachments: readonly Readonly<{
    versionId: string;
    purpose: "SUPPORTING_DOCUMENT" | "APPLICATION_SCREENSHOT" | "INVOICE";
    originalFilename: string;
    mediaType: "application/pdf" | "image/png" | "image/jpeg";
    sizeBytes: number;
    sha256: string;
  }>[];
  management?: Readonly<{
    roleAssignmentId: string;
    companyFundAssignmentId: string;
    sourceAccountId: string;
    destinationAccountId: string;
    ledgerEventId: string;
  }>;
}>;

type SummaryRow = Readonly<{
  id: string;
  document_kind: string;
  status: string;
  version: string;
  applicant_person_id: string;
  transfer_document_id: string | null;
  role_assignment_id: string | null;
  company_fund_assignment_id: string | null;
  source_fund_id: string | null;
  source_account_id: string | null;
  destination_person_id: string | null;
  destination_account_id: string | null;
  amount_cents: string | null;
  reason: string | null;
  authorization_snapshot: unknown;
  ledger_event_id: string | null;
  ledger_event_type: string | null;
  ledger_event_key: string | null;
  processing_mode: string | null;
  submitted_by_person_id: string | null;
  submitted_at: string | null;
  completed_at: string | null;
  source_before_cents: string | null;
  source_after_cents: string | null;
  destination_before_cents: string | null;
  destination_after_cents: string | null;
  source_fund_code: string | null;
  source_fund_display_name: string | null;
  source_owner_type: string | null;
  source_owner_id: string | null;
  destination_owner_type: string | null;
  destination_owner_id: string | null;
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
  ledger_entry_count: string | null;
  source_ledger_entries: string | null;
  destination_ledger_entries: string | null;
  other_ledger_entries: string | null;
}>;

type AttachmentRow = Readonly<{
  version_id: string;
  binding_purpose: string;
  attachment_purpose: string;
  document_version: string;
  status: string;
  original_filename: string;
  media_type: string | null;
  size_bytes: string | null;
  sha256: string | null;
  ready_at: string | null;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const personalSubjects = ["TEACHING_TEACHER", "ACADEMIC_PLANNER", "PLANNING_MENTOR"] as const;
const knownPersonalScopes = ["SELF", "REGION", "CAMPUS", "ASSOCIATED_TEACHERS", "MENTEES", "VENUE", "GLOBAL"] as const;
const attachmentPurposes = ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT", "INVOICE"] as const;
const mediaTypes = ["application/pdf", "image/png", "image/jpeg"] as const;

function invalid(code: string): never { throw new Error(code); }
const validDate = (at: Date): void => { if (!Number.isFinite(at.getTime())) invalid("INVALID_INPUT"); };
const isPersonalReader = (context: RoleContext): boolean =>
  personalSubjects.includes(context.subject as (typeof personalSubjects)[number])
  && knownPersonalScopes.includes((context.scope ?? "") as (typeof knownPersonalScopes)[number]);
const isManagedReader = (context: RoleContext): boolean =>
  (context.subject === "HEADQUARTERS_FINANCE" || context.subject === "SYSTEM_ADMIN" || context.subject === "SYSTEM_OWNER")
  && context.scope === "GLOBAL"
  && context.regionId === undefined && context.campusId === undefined && context.venueId === undefined;
const parseVersion = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) invalid("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
  return parsed;
};
const validCents = (value: string | null, positive = false): bigint => {
  if (value === null || !/^-?[0-9]+$/.test(value)) invalid("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
  const parsed = BigInt(value!);
  if (positive && parsed <= 0n) invalid("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
  return parsed;
};
const validTimestamp = (value: string | null): string => {
  if (value === null || !Number.isFinite(new Date(value).getTime())) invalid("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
  return new Date(value!).toISOString();
};
const validUuid = (value: string | null): string => {
  if (value === null || !UUID.test(value)) invalid("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
  return value!;
};
const snapshot = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
  return value as Record<string, unknown>;
};
const snapshotId = (record: Record<string, unknown>, field: string): string => {
  const value = record[field];
  if (typeof value !== "string" || !UUID.test(value)) invalid("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
  return value as string;
};
const snapshotString = (record: Record<string, unknown>, field: string): string => {
  const value = record[field];
  if (typeof value !== "string") invalid("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
  return value as string;
};
const snapshotNullableUuid = (record: Record<string, unknown>, field: string): string | null => {
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== "string" || !UUID.test(value)) invalid("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
  return value as string;
};
const snapshotTime = (record: Record<string, unknown>, field: string): string => {
  const value = snapshotString(record, field);
  if (!Number.isFinite(new Date(value).getTime())) invalid("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
  return new Date(value as string).toISOString();
};
const snapshotNullableTime = (record: Record<string, unknown>, field: string): string | null => {
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(new Date(value).getTime())) invalid("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
  return new Date(value as string).toISOString();
};

const summarySelect = `
  SELECT document.id::text AS id,document.kind AS document_kind,document.status,document.version::text AS version,
         document.applicant_person_id::text AS applicant_person_id,
         transfer.finance_document_id::text AS transfer_document_id,
         transfer.role_assignment_id::text AS role_assignment_id,
         transfer.company_fund_assignment_id::text AS company_fund_assignment_id,
         transfer.source_fund_id::text AS source_fund_id,transfer.source_account_id::text AS source_account_id,
         transfer.destination_person_id::text AS destination_person_id,transfer.destination_account_id::text AS destination_account_id,
         transfer.amount_cents::text AS amount_cents,transfer.reason,transfer.authorization_snapshot,
         transfer.ledger_event_id::text AS ledger_event_id,ledger_event.event_type AS ledger_event_type,ledger_event.event_key AS ledger_event_key,transfer.processing_mode,
         transfer.submitted_by_person_id::text AS submitted_by_person_id,
         to_char(transfer.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS submitted_at,
         to_char(transfer.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS completed_at,
         transfer.source_before_cents::text AS source_before_cents,transfer.source_after_cents::text AS source_after_cents,
         transfer.destination_before_cents::text AS destination_before_cents,transfer.destination_after_cents::text AS destination_after_cents,
         fund.fund_code AS source_fund_code,fund.display_name AS source_fund_display_name,source.owner_type AS source_owner_type,source.owner_id::text AS source_owner_id,
         destination.owner_type AS destination_owner_type,destination.owner_id::text AS destination_owner_id,
         role.person_id::text AS role_person_id,role.subject_code AS role_subject_code,role.scope_type AS role_scope_type,
         role.scope_id::text AS role_scope_id,to_char(role.valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS role_valid_from,
         to_char(role.valid_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS role_valid_to,
         fund_assignment.fund_id::text AS fund_assignment_fund_id,fund_assignment.duty_subject AS fund_assignment_subject,
         fund_assignment.scope_type AS fund_assignment_scope,fund_assignment.scope_id::text AS fund_assignment_scope_id,
         fund_assignment.responsibility_code AS fund_assignment_responsibility,
         to_char(fund_assignment.valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS fund_assignment_valid_from,
         to_char(fund_assignment.valid_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS fund_assignment_valid_to,
         ledger_counts.entry_count::text AS ledger_entry_count,ledger_counts.source_entries::text AS source_ledger_entries,
         ledger_counts.destination_entries::text AS destination_ledger_entries,ledger_counts.other_entries::text AS other_ledger_entries
    FROM finance_document document
    LEFT JOIN finance_self_purchase_transfer transfer ON transfer.finance_document_id=document.id
    LEFT JOIN company_finance_fund fund ON fund.id=transfer.source_fund_id
    LEFT JOIN settlement_account source ON source.id=transfer.source_account_id
    LEFT JOIN settlement_account destination ON destination.id=transfer.destination_account_id
    LEFT JOIN role_assignment role ON role.id=transfer.role_assignment_id
    LEFT JOIN company_finance_fund_assignment fund_assignment ON fund_assignment.id=transfer.company_fund_assignment_id
    LEFT JOIN ledger_event ledger_event ON ledger_event.id=transfer.ledger_event_id
    LEFT JOIN LATERAL (
      SELECT count(*) AS entry_count,
             count(*) FILTER (WHERE entry.account_id=transfer.source_account_id AND entry.category_key='selfPurchaseExpense' AND entry.amount_cents=-transfer.amount_cents) AS source_entries,
             count(*) FILTER (WHERE entry.account_id=transfer.destination_account_id AND entry.category_key='selfPurchaseIncome' AND entry.amount_cents=transfer.amount_cents) AS destination_entries,
             count(*) FILTER (WHERE entry.account_id NOT IN (transfer.source_account_id,transfer.destination_account_id)) AS other_entries
        FROM ledger_entry entry WHERE entry.event_id=transfer.ledger_event_id
    ) ledger_counts ON true
   WHERE document.kind='SELF_PURCHASE' AND document.status='COMPLETED'`;

const attachmentSelect = `
  SELECT version.id::text AS version_id,binding.purpose AS binding_purpose,attachment.purpose AS attachment_purpose,
         binding.document_version::text AS document_version,version.status,version.original_filename,version.detected_media_type AS media_type,
         version.actual_size_bytes::text AS size_bytes,version.sha256,
         to_char(version.ready_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ready_at
    FROM finance_self_purchase_attachment_binding binding
    JOIN finance_attachment_version version ON version.id=binding.finance_attachment_version_id
    JOIN finance_attachment attachment ON attachment.id=version.finance_attachment_id
   WHERE binding.finance_document_id=$1::uuid
   ORDER BY binding.purpose,version.id`;

const toSummary = (row: SummaryRow): SelfPurchaseSummary => {
  const ids = [row.id,row.applicant_person_id,row.transfer_document_id,row.role_assignment_id,row.company_fund_assignment_id,
    row.source_fund_id,row.source_account_id,row.destination_person_id,row.destination_account_id,row.ledger_event_id,
    row.submitted_by_person_id,row.source_owner_id,row.destination_owner_id,row.role_person_id,row.fund_assignment_fund_id];
  if (!ids.every((id) => id !== null && UUID.test(id)) || row.document_kind !== "SELF_PURCHASE" || row.status !== "COMPLETED"
    || row.transfer_document_id !== row.id || row.processing_mode !== "SYSTEM_RULE" || row.applicant_person_id !== row.destination_person_id
    || row.applicant_person_id !== row.submitted_by_person_id || row.source_owner_type !== "COMPANY" || row.source_owner_id !== row.source_fund_id
    || row.destination_owner_type !== "PERSON" || row.destination_owner_id !== row.destination_person_id
    || row.fund_assignment_fund_id !== row.source_fund_id || row.fund_assignment_subject !== "HEADQUARTERS_FINANCE"
    || row.fund_assignment_scope !== "GLOBAL" || row.fund_assignment_scope_id !== null || row.fund_assignment_responsibility !== "FINANCE_OPERATING_SOURCE"
    || row.source_fund_display_name === null || !row.reason?.trim()) invalid("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
  const amount = validCents(row.amount_cents, true);
  const submittedAt = validTimestamp(row.submitted_at);
  const completedAt = validTimestamp(row.completed_at);
  const authorization = snapshot(row.authorization_snapshot);
  const applicantContextSubject = snapshotString(authorization, "applicantContextSubject");
  const applicantContextScope = snapshotString(authorization, "applicantContextScope");
  // Personal organization scopes legitimately carry a resource ID. They are historical applicant context, not HQ authorization.
  snapshotNullableUuid(authorization, "applicantContextRegionId");
  snapshotNullableUuid(authorization, "applicantContextCampusId");
  snapshotNullableUuid(authorization, "applicantContextVenueId");
  const roleValidFrom = snapshotTime(authorization, "roleValidFrom");
  const roleValidTo = snapshotNullableTime(authorization, "roleValidTo");
  const fundAssignmentValidFrom = snapshotTime(authorization, "fundAssignmentValidFrom");
  const fundAssignmentValidTo = snapshotNullableTime(authorization, "fundAssignmentValidTo");
  if (snapshotId(authorization, "roleAssignmentId") !== row.role_assignment_id
    || snapshotId(authorization, "companyFundAssignmentId") !== row.company_fund_assignment_id
    || snapshotId(authorization, "sourceFundId") !== row.source_fund_id
    || snapshotId(authorization, "sourceAccountId") !== row.source_account_id
    || snapshotId(authorization, "destinationPersonId") !== row.destination_person_id
    || snapshotId(authorization, "destinationAccountId") !== row.destination_account_id
    || !snapshotString(authorization, "sourceFundCode") || snapshotString(authorization, "sourceFundCode") !== row.source_fund_code
    || snapshotId(authorization, "rolePersonId") !== row.applicant_person_id
    || snapshotString(authorization, "roleSubjectCode") !== "HEADQUARTERS_FINANCE"
    || snapshotString(authorization, "roleScopeType") !== "GLOBAL"
    || snapshotNullableUuid(authorization, "roleScopeId") !== null
    || !personalSubjects.includes(applicantContextSubject as (typeof personalSubjects)[number])
    || !knownPersonalScopes.includes(applicantContextScope as (typeof knownPersonalScopes)[number])
    || new Date(completedAt).getTime() < new Date(roleValidFrom).getTime()
    || (roleValidTo !== null && new Date(completedAt).getTime() >= new Date(roleValidTo).getTime())
    || new Date(completedAt).getTime() < new Date(fundAssignmentValidFrom).getTime()
    || (fundAssignmentValidTo !== null && new Date(completedAt).getTime() >= new Date(fundAssignmentValidTo).getTime())
    || new Date(completedAt).getTime() < new Date(submittedAt).getTime()
    || validCents(row.source_before_cents) - amount !== validCents(row.source_after_cents)
    || validCents(row.destination_before_cents) + amount !== validCents(row.destination_after_cents)
    || row.ledger_event_type !== "SELF_PURCHASE_AUTO_COMPLETED" || row.ledger_event_key !== `self-purchase:${row.id}`
    || row.ledger_entry_count !== "2" || row.source_ledger_entries !== "1" || row.destination_ledger_entries !== "1" || row.other_ledger_entries !== "0") {
    invalid("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
  }
  return {
    id: validUuid(row.id), status: "COMPLETED", version: parseVersion(row.version), amountCents: amount.toString(), reason: row.reason!.trim(),
    applicantPersonId: validUuid(row.applicant_person_id), sourceFund: { id: validUuid(row.source_fund_id), displayName: row.source_fund_display_name! },
    processingMode: "SYSTEM_RULE", submittedAt, completedAt
  };
};

const toAttachments = (rows: readonly AttachmentRow[], version: number): SelfPurchaseDetail["attachments"] => {
  const required = new Set<string>();
  const attachments = rows.map((row) => {
    if (!UUID.test(row.version_id) || !attachmentPurposes.includes(row.binding_purpose as (typeof attachmentPurposes)[number])
      || row.attachment_purpose !== row.binding_purpose || parseVersion(row.document_version) !== version || row.status !== "READY"
      || row.media_type === null || !mediaTypes.includes(row.media_type as (typeof mediaTypes)[number])
      || row.size_bytes === null || !Number.isSafeInteger(Number(row.size_bytes)) || Number(row.size_bytes) < 1
      || row.sha256 === null || !SHA256.test(row.sha256) || row.ready_at === null || !Number.isFinite(new Date(row.ready_at).getTime())) {
      invalid("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
    }
    required.add(row.binding_purpose);
    return { versionId: row.version_id, purpose: row.binding_purpose as "SUPPORTING_DOCUMENT" | "APPLICATION_SCREENSHOT" | "INVOICE",
      originalFilename: row.original_filename, mediaType: row.media_type as "application/pdf" | "image/png" | "image/jpeg",
      sizeBytes: Number(row.size_bytes), sha256: row.sha256! };
  });
  if (!required.has("SUPPORTING_DOCUMENT") || !required.has("APPLICATION_SCREENSHOT")) invalid("FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
  return attachments;
};

const insertAudit = async (client: PostgresClient, context: RoleContext, documentId: string, action: string, reason: string, at: Date): Promise<void> => {
  await client.query(
    `INSERT INTO audit_event(actor_person_id,action_code,subject_type,subject_id,after_json,reason,created_at)
     VALUES($1::uuid,$2,'FINANCE_SELF_PURCHASE',$3::uuid,jsonb_build_object('contextSubject',$4::text),$5,$6::timestamptz)`,
    [context.personId, action, documentId, context.subject, reason, at.toISOString()]
  );
};

export class PostgresSelfPurchaseReadService {
  public constructor(private readonly pool: PostgresPool) {}

  public async listOwn(context: RoleContext, at: Date): Promise<Readonly<{ documents: readonly SelfPurchaseSummary[] }>> {
    if (!isPersonalReader(context)) invalid("FORBIDDEN_SCOPE");
    validDate(at);
    const bounds = financeYearBounds(at);
    return this.list(`${summarySelect} AND document.applicant_person_id=$1::uuid
      AND transfer.completed_at >= $2::timestamptz AND transfer.completed_at < $3::timestamptz
      ORDER BY transfer.completed_at DESC,document.id DESC`, [context.personId, bounds.start, bounds.end]);
  }

  public async listManaged(context: RoleContext): Promise<Readonly<{ documents: readonly SelfPurchaseSummary[] }>> {
    if (!isManagedReader(context)) invalid("FORBIDDEN_SCOPE");
    return this.list(`${summarySelect} ORDER BY transfer.completed_at DESC NULLS LAST,document.id DESC`, []);
  }

  public async getDetail(context: RoleContext, documentId: string, at: Date): Promise<SelfPurchaseDetail> {
    if (!UUID.test(documentId) || !Number.isFinite(at.getTime())) invalid("INVALID_INPUT");
    const personal = isPersonalReader(context);
    const managed = isManagedReader(context);
    const client = await this.pool.connect();
    let open = false;
    try {
      await client.query("BEGIN");
      open = true;
      const fail = async (action: "SELF_PURCHASE_DETAIL_DENIED" | "SELF_PURCHASE_DETAIL_INTEGRITY_FAILED", reason: string, code: string): Promise<never> => {
        await insertAudit(client, context, documentId, action, reason, at);
        await client.query("COMMIT");
        open = false;
        throw new Error(code);
      };
      if (!personal && !managed) return await fail("SELF_PURCHASE_DETAIL_DENIED", "FORBIDDEN_SCOPE", "FORBIDDEN_SCOPE");
      const document = await client.query<Readonly<{ id: string; applicant_person_id: string; completed_at: string | null }>>(
        `SELECT document.id::text AS id,document.applicant_person_id::text AS applicant_person_id,
                to_char(transfer.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS completed_at
           FROM finance_document document LEFT JOIN finance_self_purchase_transfer transfer ON transfer.finance_document_id=document.id
          WHERE document.id=$1::uuid AND document.kind='SELF_PURCHASE' AND document.status='COMPLETED' FOR SHARE OF document`,
        [documentId]
      );
      const basic = document.rows[0];
      const bounds = financeYearBounds(at);
      if (basic === undefined || (!managed && (basic.applicant_person_id !== context.personId || basic.completed_at === null
        || new Date(basic.completed_at).getTime() < new Date(bounds.start).getTime() || new Date(basic.completed_at).getTime() >= new Date(bounds.end).getTime()))) {
        return await fail("SELF_PURCHASE_DETAIL_DENIED", "NOT_FOUND_OR_FORBIDDEN", "FINANCE_DOCUMENT_NOT_FOUND");
      }
      const rows = await client.query<SummaryRow>(`${summarySelect} AND document.id=$1::uuid FOR SHARE OF document`, [documentId]);
      const row = rows.rows[0];
      if (row === undefined) return await fail("SELF_PURCHASE_DETAIL_INTEGRITY_FAILED", "TRANSFER_OR_ACCOUNT_RELATION_INVALID", "FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE");
      let summary: SelfPurchaseSummary;
      let attachments: SelfPurchaseDetail["attachments"];
      try {
        summary = toSummary(row);
        attachments = toAttachments((await client.query<AttachmentRow>(attachmentSelect, [documentId])).rows, summary.version);
      } catch (error) {
        if (error instanceof Error && error.message === "FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE") {
          return await fail("SELF_PURCHASE_DETAIL_INTEGRITY_FAILED", "COMPLETED_RECORD_INVALID", error.message);
        }
        throw error;
      }
      await insertAudit(client, context, documentId, "SELF_PURCHASE_DETAIL_READ", "AUTHORIZED_COMPLETED_RECORD_READ", at);
      await client.query("COMMIT");
      open = false;
      return {
        ...summary,
        attachments,
        ...(managed ? { management: {
          roleAssignmentId: validUuid(row.role_assignment_id), companyFundAssignmentId: validUuid(row.company_fund_assignment_id),
          sourceAccountId: validUuid(row.source_account_id), destinationAccountId: validUuid(row.destination_account_id), ledgerEventId: validUuid(row.ledger_event_id)
        } } : {})
      };
    } catch (error) {
      if (open) await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.release();
    }
  }

  private async list(query: string, values: readonly unknown[]): Promise<Readonly<{ documents: readonly SelfPurchaseSummary[] }>> {
    const client = await this.pool.connect();
    try {
      return { documents: (await client.query<SummaryRow>(query, values)).rows.map(toSummary) };
    } finally {
      await client.release();
    }
  }
}
