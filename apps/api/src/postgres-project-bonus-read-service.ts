import type { RoleContext } from "@teaching-research-alliance/contracts";
import type { PostgresClient, PostgresPool } from "./postgres-ledger-repository.js";

type AttachmentPurpose = "SUPPORTING_DOCUMENT" | "APPLICATION_SCREENSHOT";

export type ProjectBonusAttachment = Readonly<{
  versionId: string;
  purpose: AttachmentPurpose;
  originalFilename: string;
  mediaType: "application/pdf" | "image/png" | "image/jpeg";
  sizeBytes: number;
  sha256: string;
}>;
export type ProjectBonusRecipient = Readonly<{
  personId: string;
  currentDisplayName: string | null;
  accountId: string;
  accountCode: string;
}>;
export type ProjectBonusSource = Readonly<{
  fundId: string;
  currentFundCode: string | null;
  currentDisplayName: string | null;
  accountId: string;
  accountCode: string;
}>;
export type ProjectBonusReversal = Readonly<{
  documentId: string;
  version: number;
  reason: string;
  reversedAt: string;
  reversedByPersonId: string;
  reversedByCurrentDisplayName: string | null;
  attachments: readonly ProjectBonusAttachment[];
}>;
export type ProjectBonusPostingSummary = Readonly<{
  documentId: string;
  status: "COMPLETED" | "REVERSED";
  version: number;
  projectNo: number;
  projectName: string;
  amountCents: string;
  reason: string;
  grantedAt: string;
  grantedByPersonId: string;
  grantedByCurrentDisplayName: string | null;
  recipient: ProjectBonusRecipient;
  source: ProjectBonusSource;
  reversal: Omit<ProjectBonusReversal, "attachments"> | null;
  /** Status/reversal eligibility only. A caller must read verified detail before reversing. */
  canReverse: boolean;
}>;
export type ProjectBonusPostingDetail = Omit<ProjectBonusPostingSummary, "reversal"> &
  Readonly<{
    reversal: ProjectBonusReversal | null;
    originalAttachments: readonly ProjectBonusAttachment[];
  }>;
export type ProjectBonusHistoryInput = Readonly<{ cursor?: string; limit?: number }>;
export type ProjectBonusHistoryPage = Readonly<{
  items: readonly ProjectBonusPostingSummary[];
  nextCursor: string | null;
}>;

type BonusRow = Readonly<{
  document_id: string;
  document_kind: string;
  document_status: string;
  document_version: string;
  document_applicant_person_id: string;
  project_no: string;
  project_name: string;
  recipient_person_id: string;
  recipient_display_name: string | null;
  destination_account_id: string;
  destination_account_code: string | null;
  destination_owner_type: string | null;
  destination_owner_id: string | null;
  source_fund_id: string;
  source_fund_code: string | null;
  source_fund_display_name: string | null;
  source_account_id: string;
  source_account_code: string | null;
  source_owner_type: string | null;
  source_owner_id: string | null;
  amount_cents: string;
  reason: string;
  ledger_event_id: string;
  granted_by_person_id: string;
  granted_by_display_name: string | null;
  granted_at: string;
  reversal_document_id: string | null;
  reversal_document_version: string | null;
  reversal_document_kind: string | null;
  reversal_document_status: string | null;
  reversal_document_applicant_person_id: string | null;
  reversal_reason: string | null;
  reversal_created_at: string | null;
  reversed_by_person_id: string | null;
  reversed_by_display_name: string | null;
  original_ledger_event_id: string | null;
  reversal_ledger_event_id: string | null;
  original_event_type: string | null;
  original_event_key: string | null;
  original_entry_count: string;
  original_source_count: string;
  original_source_amount: string | null;
  original_destination_count: string;
  original_destination_amount: string | null;
  original_completed_count: string;
  original_completed_actor_count: string;
  original_reversed_count: string;
  original_reversed_actor_count: string;
  original_reversed_total_count: string;
  reversal_event_type: string | null;
  reversal_event_key: string | null;
  reversal_entry_count: string;
  reversal_source_count: string;
  reversal_source_amount: string | null;
  reversal_destination_count: string;
  reversal_destination_amount: string | null;
  reversal_completed_count: string;
  reversal_completed_actor_count: string;
}>;
type AttachmentRow = Readonly<{
  document_id: string;
  document_version: string;
  version_id: string;
  purpose: string;
  original_filename: string;
  media_type: string | null;
  size_bytes: string | null;
  sha256: string | null;
  status: string;
  attachment_document_id: string;
  attachment_purpose: string;
  bound_by_person_id: string;
  slot_id: string;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;
const SHA256 = /^[0-9a-f]{64}$/;
const fail = (code: string): never => { throw new Error(code); };
const unavailable = (): never => fail("SALARY_BENEFIT_DATA_UNAVAILABLE");
const validUuid = (value: string | null): string => {
  if (value === null || !UUID.test(value)) unavailable();
  return value as string;
};
const text = (value: string | null): string => {
  if (value === null || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) unavailable();
  return (value as string).trim();
};
const optionalText = (value: string | null): string | null => {
  if (value === null) return null;
  return text(value);
};
const count = (value: string | null): number => {
  if (value === null || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) unavailable();
  return Number(value);
};
const positive = (value: string | null): bigint => {
  if (value === null || !/^[1-9]\d*$/.test(value)) unavailable();
  return BigInt(value as string);
};
const integer = (value: string | null): number => {
  if (value === null || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) unavailable();
  return Number(value);
};
const calendarTimestamp = (value: string): boolean => {
  const parts = CURSOR_PARTS.exec(value);
  if (!parts) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction] = parts;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  if (year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  const candidate = new Date(0);
  candidate.setUTCFullYear(year, month - 1, day);
  candidate.setUTCHours(hour, minute, second, Number((fraction as string).slice(0, 3)));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day
    && candidate.getUTCHours() === hour
    && candidate.getUTCMinutes() === minute
    && candidate.getUTCSeconds() === second;
};
const timestamp = (value: string | null): string => {
  if (value === null || !calendarTimestamp(value)) unavailable();
  return value as string;
};
const managed = (context: RoleContext): boolean =>
  ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"].includes(context.subject)
  && context.scope === "GLOBAL"
  && context.regionId === undefined
  && context.campusId === undefined
  && context.venueId === undefined;
const inputDocument = (value: string): string => {
  if (!UUID.test(value)) fail("INVALID_INPUT");
  return value;
};
const cursorEncode = (createdAt: string, documentId: string): string =>
  Buffer.from(JSON.stringify({ createdAt, documentId })).toString("base64url");
const cursorDecode = (value: string | undefined): Readonly<{ createdAt: string; documentId: string }> | null => {
  if (value === undefined) return null;
  if (!value || value.length > 400) fail("INVALID_INPUT");
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) fail("INVALID_INPUT");
    const row = decoded as Record<string, unknown>;
    if (Object.keys(row).length !== 2 || typeof row.createdAt !== "string" || typeof row.documentId !== "string" || !calendarTimestamp(row.createdAt) || !UUID.test(row.documentId)) fail("INVALID_INPUT");
    return { createdAt: row.createdAt as string, documentId: row.documentId as string };
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_INPUT") throw error;
    return fail("INVALID_INPUT");
  }
};
const readTx = async <T>(pool: PostgresPool, work: (client: PostgresClient) => Promise<T>): Promise<T> => {
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

const selectSql = `WITH base AS (
 SELECT document.id::text AS document_id,document.kind AS document_kind,document.status AS document_status,document.version::text AS document_version,document.applicant_person_id::text AS document_applicant_person_id,
   transfer.project_no::text,transfer.project_name,transfer.recipient_person_id::text AS recipient_person_id,recipient.nickname AS recipient_display_name,
   transfer.destination_account_id::text AS destination_account_id,destination.account_code AS destination_account_code,destination.owner_type AS destination_owner_type,destination.owner_id::text AS destination_owner_id,
   transfer.source_fund_id::text AS source_fund_id,fund.fund_code AS source_fund_code,fund.display_name AS source_fund_display_name,
   transfer.source_account_id::text AS source_account_id,source.account_code AS source_account_code,source.owner_type AS source_owner_type,source.owner_id::text AS source_owner_id,
   transfer.amount_cents::text,transfer.reason,transfer.ledger_event_id::text,transfer.granted_by_person_id::text,grantor.nickname AS granted_by_display_name,
   to_char(transfer.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS granted_at
 FROM project_bonus_transfer transfer
 JOIN finance_document document ON document.id=transfer.finance_document_id
 JOIN person recipient ON recipient.id=transfer.recipient_person_id
 JOIN person grantor ON grantor.id=transfer.granted_by_person_id
 JOIN company_finance_fund fund ON fund.id=transfer.source_fund_id
 JOIN settlement_account source ON source.id=transfer.source_account_id
 JOIN settlement_account destination ON destination.id=transfer.destination_account_id
)
SELECT base.*,
 reversal.reversal_finance_document_id::text AS reversal_document_id,reversal_document.version::text AS reversal_document_version,reversal_document.kind AS reversal_document_kind,reversal_document.status AS reversal_document_status,reversal_document.applicant_person_id::text AS reversal_document_applicant_person_id,
 reversal.reason AS reversal_reason,to_char(reversal.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS reversal_created_at,reversal.reversed_by_person_id::text AS reversed_by_person_id,reverser.nickname AS reversed_by_display_name,
 reversal.original_ledger_event_id::text AS original_ledger_event_id,reversal.reversal_ledger_event_id::text AS reversal_ledger_event_id,
 original_event.event_type AS original_event_type,original_event.event_key AS original_event_key,
 (SELECT COUNT(*)::text FROM ledger_entry entry WHERE entry.event_id=base.ledger_event_id::uuid) AS original_entry_count,
 (SELECT COUNT(*)::text FROM ledger_entry entry WHERE entry.event_id=base.ledger_event_id::uuid AND entry.account_id=base.source_account_id::uuid AND entry.category_key='projectBonusExpense') AS original_source_count,
 (SELECT amount_cents::text FROM ledger_entry entry WHERE entry.event_id=base.ledger_event_id::uuid AND entry.account_id=base.source_account_id::uuid AND entry.category_key='projectBonusExpense') AS original_source_amount,
 (SELECT COUNT(*)::text FROM ledger_entry entry WHERE entry.event_id=base.ledger_event_id::uuid AND entry.account_id=base.destination_account_id::uuid AND entry.category_key='projectBonusIncome') AS original_destination_count,
 (SELECT amount_cents::text FROM ledger_entry entry WHERE entry.event_id=base.ledger_event_id::uuid AND entry.account_id=base.destination_account_id::uuid AND entry.category_key='projectBonusIncome') AS original_destination_amount,
 (SELECT COUNT(*)::text FROM finance_document_event event WHERE event.finance_document_id=base.document_id::uuid AND event.event_type='SALARY_BENEFIT_COMPLETED' AND event.result_document_version=2 AND event.ledger_event_id=base.ledger_event_id::uuid) AS original_completed_count,
 (SELECT COUNT(*)::text FROM finance_document_event event WHERE event.finance_document_id=base.document_id::uuid AND event.event_type='SALARY_BENEFIT_COMPLETED' AND event.result_document_version=2 AND event.ledger_event_id=base.ledger_event_id::uuid AND event.actor_person_id=base.granted_by_person_id::uuid) AS original_completed_actor_count,
 (SELECT COUNT(*)::text FROM finance_document_event event WHERE event.finance_document_id=base.document_id::uuid AND event.event_type='SALARY_BENEFIT_REVERSED' AND event.result_document_version=3 AND event.ledger_event_id=reversal.reversal_ledger_event_id) AS original_reversed_count,
 (SELECT COUNT(*)::text FROM finance_document_event event WHERE event.finance_document_id=base.document_id::uuid AND event.event_type='SALARY_BENEFIT_REVERSED' AND event.result_document_version=3 AND event.ledger_event_id=reversal.reversal_ledger_event_id AND event.actor_person_id=reversal.reversed_by_person_id) AS original_reversed_actor_count,
 (SELECT COUNT(*)::text FROM finance_document_event event WHERE event.finance_document_id=base.document_id::uuid AND event.event_type='SALARY_BENEFIT_REVERSED') AS original_reversed_total_count,
 reversal_event.event_type AS reversal_event_type,reversal_event.event_key AS reversal_event_key,
 (SELECT COUNT(*)::text FROM ledger_entry entry WHERE entry.event_id=reversal.reversal_ledger_event_id) AS reversal_entry_count,
 (SELECT COUNT(*)::text FROM ledger_entry entry WHERE entry.event_id=reversal.reversal_ledger_event_id AND entry.account_id=base.source_account_id::uuid AND entry.category_key='projectBonusExpenseReversal') AS reversal_source_count,
 (SELECT amount_cents::text FROM ledger_entry entry WHERE entry.event_id=reversal.reversal_ledger_event_id AND entry.account_id=base.source_account_id::uuid AND entry.category_key='projectBonusExpenseReversal') AS reversal_source_amount,
 (SELECT COUNT(*)::text FROM ledger_entry entry WHERE entry.event_id=reversal.reversal_ledger_event_id AND entry.account_id=base.destination_account_id::uuid AND entry.category_key='projectBonusIncomeReversal') AS reversal_destination_count,
 (SELECT amount_cents::text FROM ledger_entry entry WHERE entry.event_id=reversal.reversal_ledger_event_id AND entry.account_id=base.destination_account_id::uuid AND entry.category_key='projectBonusIncomeReversal') AS reversal_destination_amount,
 (SELECT COUNT(*)::text FROM finance_document_event event WHERE event.finance_document_id=reversal.reversal_finance_document_id AND event.event_type='SALARY_BENEFIT_COMPLETED' AND event.result_document_version=2 AND event.ledger_event_id=reversal.reversal_ledger_event_id) AS reversal_completed_count,
 (SELECT COUNT(*)::text FROM finance_document_event event WHERE event.finance_document_id=reversal.reversal_finance_document_id AND event.event_type='SALARY_BENEFIT_COMPLETED' AND event.result_document_version=2 AND event.ledger_event_id=reversal.reversal_ledger_event_id AND event.actor_person_id=reversal.reversed_by_person_id) AS reversal_completed_actor_count
FROM base
LEFT JOIN salary_benefit_reversal reversal ON reversal.original_finance_document_id=base.document_id::uuid
LEFT JOIN finance_document reversal_document ON reversal_document.id=reversal.reversal_finance_document_id
LEFT JOIN person reverser ON reverser.id=reversal.reversed_by_person_id
LEFT JOIN ledger_event original_event ON original_event.id=base.ledger_event_id::uuid
LEFT JOIN ledger_event reversal_event ON reversal_event.id=reversal.reversal_ledger_event_id`;

const attachmentSql = `SELECT binding.finance_document_id::text AS document_id,binding.document_version::text AS document_version,version.id::text AS version_id,binding.purpose,version.original_filename,version.detected_media_type AS media_type,version.actual_size_bytes::text AS size_bytes,version.sha256,version.status,attachment.finance_document_id::text AS attachment_document_id,attachment.purpose AS attachment_purpose,binding.bound_by_person_id::text,attachment.id::text AS slot_id
FROM salary_benefit_attachment_binding binding
JOIN finance_attachment_version version ON version.id=binding.finance_attachment_version_id
JOIN finance_attachment attachment ON attachment.id=version.finance_attachment_id
WHERE binding.finance_document_id = ANY($1::uuid[])
ORDER BY binding.finance_document_id,binding.purpose,version.id`;

const summary = (row: BonusRow): ProjectBonusPostingSummary => {
  const status = row.document_status;
  if (row.document_kind !== "PROJECT_BONUS" || (status !== "COMPLETED" && status !== "REVERSED")) unavailable();
  const verifiedStatus = status as "COMPLETED" | "REVERSED";
  const version = integer(row.document_version);
  if ((verifiedStatus === "COMPLETED" && version !== 2) || (verifiedStatus === "REVERSED" && version !== 3)) unavailable();
  const documentId = validUuid(row.document_id), sourceId = validUuid(row.source_account_id), destinationId = validUuid(row.destination_account_id), amount = positive(row.amount_cents);
  const projectNo = integer(row.project_no);
  if (projectNo > 10 || row.document_applicant_person_id !== row.granted_by_person_id || row.source_owner_type !== "COMPANY" || row.source_owner_id !== row.source_fund_id || row.destination_owner_type !== "PERSON" || row.destination_owner_id !== row.recipient_person_id || row.original_event_type !== "PROJECT_BONUS_GRANTED" || row.original_event_key !== `project-bonus:${documentId}` || count(row.original_entry_count) !== 2 || count(row.original_source_count) !== 1 || count(row.original_destination_count) !== 1 || row.original_source_amount === null || row.original_destination_amount === null || BigInt(row.original_source_amount) !== -amount || BigInt(row.original_destination_amount) !== amount || count(row.original_completed_count) !== 1 || count(row.original_completed_actor_count) !== 1) unavailable();
  const hasReversal = row.reversal_document_id !== null;
  if ((verifiedStatus === "REVERSED") !== hasReversal) unavailable();
  let reversal: Omit<ProjectBonusReversal, "attachments"> | null = null;
  if (!hasReversal) {
    if (count(row.original_reversed_total_count) !== 0 || count(row.original_reversed_count) !== 0 || count(row.original_reversed_actor_count) !== 0) unavailable();
  } else {
    const reversalId = validUuid(row.reversal_document_id);
    if (row.original_ledger_event_id !== row.ledger_event_id || row.reversal_document_kind !== "PROJECT_BONUS" || row.reversal_document_status !== "COMPLETED" || integer(row.reversal_document_version) !== 2 || row.reversal_document_applicant_person_id !== row.reversed_by_person_id || row.reversal_event_type !== "SALARY_BENEFIT_REVERSED" || row.reversal_event_key !== `salary-benefit-reversal:${reversalId}` || count(row.reversal_entry_count) !== 2 || count(row.reversal_source_count) !== 1 || count(row.reversal_destination_count) !== 1 || row.reversal_source_amount === null || row.reversal_destination_amount === null || BigInt(row.reversal_source_amount) !== amount || BigInt(row.reversal_destination_amount) !== -amount || count(row.reversal_completed_count) !== 1 || count(row.reversal_completed_actor_count) !== 1 || count(row.original_reversed_total_count) !== 1 || count(row.original_reversed_count) !== 1 || count(row.original_reversed_actor_count) !== 1) unavailable();
    reversal = { documentId: reversalId, version: 2, reason: text(row.reversal_reason), reversedAt: timestamp(row.reversal_created_at), reversedByPersonId: validUuid(row.reversed_by_person_id), reversedByCurrentDisplayName: optionalText(row.reversed_by_display_name) };
  }
  return {
    documentId, status: verifiedStatus, version, projectNo, projectName: text(row.project_name), amountCents: amount.toString(), reason: text(row.reason), grantedAt: timestamp(row.granted_at), grantedByPersonId: validUuid(row.granted_by_person_id), grantedByCurrentDisplayName: optionalText(row.granted_by_display_name),
    recipient: { personId: validUuid(row.recipient_person_id), currentDisplayName: optionalText(row.recipient_display_name), accountId: destinationId, accountCode: text(row.destination_account_code) },
    source: { fundId: validUuid(row.source_fund_id), currentFundCode: optionalText(row.source_fund_code), currentDisplayName: optionalText(row.source_fund_display_name), accountId: sourceId, accountCode: text(row.source_account_code) },
    reversal, canReverse: verifiedStatus === "COMPLETED" && reversal === null,
  };
};

const mapAttachments = (rows: readonly AttachmentRow[], documentId: string, documentVersion: number, actor: string): readonly ProjectBonusAttachment[] => {
  if (rows.length < 2 || rows.length > 20 || new Set(rows.map((row) => row.slot_id)).size !== rows.length || new Set(rows.map((row) => row.version_id)).size !== rows.length) unavailable();
  const purposes = new Set<string>();
  const result: ProjectBonusAttachment[] = [];
  for (const row of rows) {
    if (row.document_id !== documentId || row.document_version !== String(documentVersion) || row.attachment_document_id !== documentId || row.attachment_purpose !== row.purpose || row.bound_by_person_id !== actor || row.status !== "READY" || !["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT"].includes(row.purpose) || row.media_type === null || !["application/pdf", "image/png", "image/jpeg"].includes(row.media_type) || row.size_bytes === null || positive(row.size_bytes) > BigInt(Number.MAX_SAFE_INTEGER) || row.sha256 === null || !SHA256.test(row.sha256)) unavailable();
    purposes.add(row.purpose);
    result.push({ versionId: validUuid(row.version_id), purpose: row.purpose as AttachmentPurpose, originalFilename: text(row.original_filename), mediaType: row.media_type as ProjectBonusAttachment["mediaType"], sizeBytes: Number(positive(row.size_bytes)), sha256: row.sha256 as string });
  }
  if (!purposes.has("SUPPORTING_DOCUMENT") || !purposes.has("APPLICATION_SCREENSHOT")) unavailable();
  return result;
};

export class PostgresProjectBonusReadService {
  public constructor(private readonly pool: PostgresPool) {}

  public async list(context: RoleContext, input: ProjectBonusHistoryInput = {}): Promise<ProjectBonusHistoryPage> {
    if (!managed(context)) fail("FORBIDDEN_SCOPE");
    const cursor = cursorDecode(input.cursor);
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("INVALID_INPUT");
    return readTx(this.pool, async (client) => {
      const rows = (await client.query<BonusRow>(`${selectSql}
WHERE ($1::timestamptz IS NULL OR (base.granted_at::timestamptz,base.document_id::uuid)<($1::timestamptz,$2::uuid))
ORDER BY base.granted_at::timestamptz DESC,base.document_id::uuid DESC LIMIT $3::int`, [cursor?.createdAt ?? null, cursor?.documentId ?? null, limit + 1])).rows;
      const more = rows.length > limit;
      const items = rows.slice(0, limit).map(summary);
      const last = items.at(-1);
      return { items, nextCursor: more && last !== undefined ? cursorEncode(last.grantedAt, last.documentId) : null };
    });
  }

  public async getDetail(context: RoleContext, id: string): Promise<ProjectBonusPostingDetail> {
    if (!managed(context)) fail("FORBIDDEN_SCOPE");
    const documentId = inputDocument(id);
    return readTx(this.pool, async (client) => {
      const row = (await client.query<BonusRow>(`${selectSql}\nWHERE base.document_id::uuid=$1::uuid`, [documentId])).rows[0];
      if (!row) fail("FINANCE_DOCUMENT_NOT_FOUND");
      const base = summary(row as BonusRow);
      const documentIds = base.reversal === null ? [base.documentId] : [base.documentId, base.reversal.documentId];
      const rows = (await client.query<AttachmentRow>(attachmentSql, [documentIds])).rows;
      const byDocument = new Map<string, AttachmentRow[]>();
      for (const attachment of rows) {
        const list = byDocument.get(attachment.document_id) ?? [];
        list.push(attachment);
        byDocument.set(attachment.document_id, list);
      }
      const originalAttachments = mapAttachments(byDocument.get(base.documentId) ?? [], base.documentId, 2, base.grantedByPersonId);
      const reversal = base.reversal === null ? null : {
        ...base.reversal,
        attachments: mapAttachments(byDocument.get(base.reversal.documentId) ?? [], base.reversal.documentId, 2, base.reversal.reversedByPersonId),
      };
      return { ...base, reversal, originalAttachments };
    });
  }
}
