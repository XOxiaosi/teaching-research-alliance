import { createHash } from "node:crypto";
import type { RoleContext } from "@teaching-research-alliance/contracts";
import {
  FINANCE_ATTACHMENT_MEDIA_TYPES,
  FINANCE_ATTACHMENT_PURPOSES,
  canReadFinanceAttachment,
  canReplayFinanceAttachmentReservation,
  canReserveFinanceAttachment,
  isGlobalAttachmentReader,
  isHeadquartersFinanceGlobal,
  isPersonalAttachmentContext,
  isWithinPersonalFinanceYear,
  isReceiptPurpose,
  type FinanceAttachmentMediaType,
  type FinanceAttachmentPurpose,
  type FinanceAttachmentVersionAuthorization
} from "./finance-attachment-authorization.js";
import type { PostgresClient, PostgresPool } from "./postgres-ledger-repository.js";
import { financeYearBounds } from "./finance-year.js";

export { FINANCE_ATTACHMENT_MEDIA_TYPES, FINANCE_ATTACHMENT_PURPOSES } from "./finance-attachment-authorization.js";
export type { FinanceAttachmentMediaType, FinanceAttachmentPurpose } from "./finance-attachment-authorization.js";

export type FinanceAttachmentReservation = Readonly<{
  attachmentId: string;
  versionId: string;
  versionNo: number;
  status: "UPLOADING";
  purpose: FinanceAttachmentPurpose;
  originalFilename: string;
  declaredMediaType: FinanceAttachmentMediaType;
  declaredSizeBytes: number;
  expectedSha256?: string;
  createdAt: string;
  replay: boolean;
}>;
export type FinanceAttachmentVersionMetadata = Readonly<{
  attachmentId: string;
  versionId: string;
  versionNo: number;
  status: "UPLOADING" | "READY" | "FAILED";
  purpose: FinanceAttachmentPurpose;
  originalFilename: string;
  declaredMediaType: FinanceAttachmentMediaType;
  declaredSizeBytes: number;
  expectedSha256?: string;
  createdAt: string;
}>;
export type FinanceAttachmentLimits = Readonly<{ maxFileBytes: number; maxDocumentBytes: number; maxActiveVersions: number }>;
export type FinanceAttachmentReservationDraft = Readonly<{
  purpose: FinanceAttachmentPurpose;
  originalFilename: string;
  declaredMediaType: FinanceAttachmentMediaType;
  declaredSizeBytes: number;
  expectedSha256?: string;
}>;
export type FinanceAttachmentNextVersionDraft = Omit<FinanceAttachmentReservationDraft, "purpose">;
export type FinanceAttachmentDocumentList = Readonly<{
  documentId: string;
  attachments: readonly Readonly<{
    attachmentId: string;
    purpose: FinanceAttachmentPurpose;
    createdAt: string;
    versions: readonly Readonly<{
      versionId: string;
      versionNo: number;
      status: "UPLOADING" | "READY" | "FAILED";
      originalFilename: string;
      declaredMediaType: FinanceAttachmentMediaType;
      declaredSizeBytes: number;
      expectedSha256?: string;
      createdAt: string;
      binding?: Readonly<{ stage: "SUBMISSION" | "COMPLETION"; documentVersion: number; boundAt: string }>;
    }>[];
  }>[];
}>;

type DocumentRow = Readonly<{ document_id: string; applicant_person_id: string; document_kind: string; document_status: string; business_at: string }>;
type VersionRow = Readonly<{
  attachment_id: string; version_id: string; version_no: string; status: "UPLOADING" | "READY" | "FAILED";
  purpose: FinanceAttachmentPurpose; original_filename: string; declared_media_type: FinanceAttachmentMediaType;
  declared_size_bytes: string; expected_sha256: string | null; created_at: string;
  applicant_person_id: string; document_kind: string; document_status: string;
  created_by_person_id: string; uploaded_by_person_id: string;
  business_at: string;
}>;
type DocumentListRow = Readonly<{
  document_id: string; applicant_person_id: string; business_at: string;
  attachment_id: string | null; purpose: string | null; attachment_created_at: string | null;
  version_id: string | null; version_no: string | null; status: string | null;
  original_filename: string | null; declared_media_type: string | null; declared_size_bytes: string | null;
  expected_sha256: string | null; version_created_at: string | null;
  binding_stage: string | null; binding_document_version: string | null; binding_bound_at: string | null;
}>;
type AttachmentSlotRow = Readonly<{ attachment_id: string; document_id: string; purpose: FinanceAttachmentPurpose }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const defaults: FinanceAttachmentLimits = { maxFileBytes: 20 * 1024 * 1024, maxDocumentBytes: 100 * 1024 * 1024, maxActiveVersions: 20 };
const STORE_MAX_FILE_BYTES = 20 * 1024 * 1024;
const KNOWN_PERSONAL_SCOPES = ["SELF", "REGION", "CAMPUS", "ASSOCIATED_TEACHERS", "MENTEES", "VENUE", "GLOBAL"] as const;

const one = <Row>(rows: readonly Row[], errorCode: string): Row => {
  if (rows.length !== 1) throw new Error(errorCode);
  return rows[0]!;
};
const isPurpose = (value: string): value is FinanceAttachmentPurpose => (FINANCE_ATTACHMENT_PURPOSES as readonly string[]).includes(value);
const isMediaType = (value: string): value is FinanceAttachmentMediaType => (FINANCE_ATTACHMENT_MEDIA_TYPES as readonly string[]).includes(value);
const isKnownScopedPersonal = (context: RoleContext): boolean =>
  isPersonalAttachmentContext(context) && KNOWN_PERSONAL_SCOPES.includes((context.scope ?? "") as (typeof KNOWN_PERSONAL_SCOPES)[number]);
const positiveSafeInteger = (value: string, field: string): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`FINANCE_ATTACHMENT_PERSISTENCE_INVALID:${field}`);
  return result;
};
const isoTimestamp = (value: string | null, field: string): string => {
  if (value === null || !Number.isFinite(new Date(value).getTime())) throw new Error(`FINANCE_ATTACHMENT_PERSISTENCE_INVALID:${field}`);
  return new Date(value).toISOString();
};
const documentState = (row: Pick<VersionRow, "applicant_person_id" | "document_kind" | "document_status">) => ({
  applicantPersonId: row.applicant_person_id, kind: row.document_kind, status: row.document_status
});
const authorization = (row: VersionRow): FinanceAttachmentVersionAuthorization => ({
  ...documentState(row), purpose: row.purpose, createdByPersonId: row.created_by_person_id, uploadedByPersonId: row.uploaded_by_person_id
});
const mapReservation = (row: VersionRow, replay: boolean): FinanceAttachmentReservation => ({
  attachmentId: row.attachment_id, versionId: row.version_id, versionNo: positiveSafeInteger(row.version_no, "versionNo"), status: "UPLOADING",
  purpose: row.purpose, originalFilename: row.original_filename, declaredMediaType: row.declared_media_type,
  declaredSizeBytes: positiveSafeInteger(row.declared_size_bytes, "declaredSizeBytes"),
  ...(row.expected_sha256 === null ? {} : { expectedSha256: row.expected_sha256 }), createdAt: new Date(row.created_at).toISOString(), replay
});
const mapVersionMetadata = (row: VersionRow): FinanceAttachmentVersionMetadata => ({
  attachmentId: row.attachment_id, versionId: row.version_id, versionNo: positiveSafeInteger(row.version_no, "versionNo"), status: row.status,
  purpose: row.purpose, originalFilename: row.original_filename, declaredMediaType: row.declared_media_type,
  declaredSizeBytes: positiveSafeInteger(row.declared_size_bytes, "declaredSizeBytes"),
  ...(row.expected_sha256 === null ? {} : { expectedSha256: row.expected_sha256 }), createdAt: new Date(row.created_at).toISOString()
});

const validateReservationDraft = (draft: FinanceAttachmentNextVersionDraft, limits: FinanceAttachmentLimits): void => {
  if (!isMediaType(draft.declaredMediaType)
    || !draft.originalFilename.trim() || Buffer.byteLength(draft.originalFilename, "utf8") > 255
    || /[\x00-\x1f\x7f/\\]/.test(draft.originalFilename)
    || !Number.isSafeInteger(draft.declaredSizeBytes) || draft.declaredSizeBytes < 1 || draft.declaredSizeBytes > limits.maxFileBytes
    || (draft.expectedSha256 !== undefined && !SHA256.test(draft.expectedSha256))) throw new Error("INVALID_INPUT");
};

const versionSelect = `
  SELECT attachment.id::text AS attachment_id,version.id::text AS version_id,version.version_no::text AS version_no,version.status,
         attachment.purpose,version.original_filename,version.declared_media_type,version.declared_size_bytes::text AS declared_size_bytes,
         version.expected_sha256,to_char(version.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
         document.applicant_person_id::text AS applicant_person_id,document.kind AS document_kind,document.status AS document_status,
         attachment.created_by_person_id::text AS created_by_person_id,version.uploaded_by_person_id::text AS uploaded_by_person_id,
         to_char(COALESCE(withdrawal_submission.submitted_at,document.created_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS business_at
    FROM finance_attachment_version version
    JOIN finance_attachment attachment ON attachment.id=version.finance_attachment_id
    JOIN finance_document document ON document.id=attachment.finance_document_id
    LEFT JOIN finance_withdrawal_submission withdrawal_submission ON withdrawal_submission.finance_document_id=document.id`;

/** Metadata reservation for personal DRAFT evidence and HQ_GLOBAL withdrawal payment receipts. */
export class PostgresFinanceAttachmentService {
  private readonly limits: FinanceAttachmentLimits;

  public constructor(private readonly pool: PostgresPool, limits: Partial<FinanceAttachmentLimits> = {}) {
    this.limits = { ...defaults, ...limits };
    if (!Number.isSafeInteger(this.limits.maxFileBytes) || this.limits.maxFileBytes < 1 || this.limits.maxFileBytes > STORE_MAX_FILE_BYTES
      || !Number.isSafeInteger(this.limits.maxDocumentBytes) || this.limits.maxDocumentBytes < this.limits.maxFileBytes
      || !Number.isSafeInteger(this.limits.maxActiveVersions) || this.limits.maxActiveVersions < 1) throw new Error("FINANCE_ATTACHMENT_LIMIT_CONFIG_INVALID");
  }

  public async reserve(context: RoleContext, documentId: string, draft: FinanceAttachmentReservationDraft, idempotencyKey: string, at: Date): Promise<FinanceAttachmentReservation> {
    if (!UUID.test(documentId) || !isPurpose(draft.purpose) || !isMediaType(draft.declaredMediaType)
      || !draft.originalFilename.trim() || Buffer.byteLength(draft.originalFilename, "utf8") > 255
      || /[\x00-\x1f\x7f/\\]/.test(draft.originalFilename)
      || !Number.isSafeInteger(draft.declaredSizeBytes) || draft.declaredSizeBytes < 1 || draft.declaredSizeBytes > this.limits.maxFileBytes
      || (draft.expectedSha256 !== undefined && !SHA256.test(draft.expectedSha256))
      || !idempotencyKey.trim() || idempotencyKey.length > 200 || !Number.isFinite(at.getTime())) throw new Error("INVALID_INPUT");
    this.assertReservationRole(context, draft.purpose);
    const hash = createHash("sha256").update(JSON.stringify([documentId,draft.purpose,draft.originalFilename,draft.declaredMediaType,draft.declaredSizeBytes,draft.expectedSha256 ?? null])).digest("hex");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`finance-attachment:${context.personId}:${idempotencyKey}`]);
      const replay = await client.query<{request_hash:string;finance_attachment_version_id:string}>(
        `SELECT request_hash,finance_attachment_version_id::text AS finance_attachment_version_id FROM finance_attachment_reservation_idempotency WHERE actor_person_id=$1::uuid AND idempotency_key=$2 FOR SHARE`,
        [context.personId, idempotencyKey]
      );
      if (replay.rows[0] !== undefined) {
        if (replay.rows[0].request_hash !== hash) throw new Error("IDEMPOTENCY_REPLAY");
        const saved = await this.lockVersionAfterDocument(client, replay.rows[0].finance_attachment_version_id);
        if (saved === undefined || saved.created_by_person_id !== context.personId || saved.uploaded_by_person_id !== context.personId) throw new Error("FINANCE_ATTACHMENT_NOT_FOUND");
        if (isPersonalAttachmentContext(context) && !isWithinPersonalFinanceYear(saved.business_at, at)) throw new Error("FINANCE_ATTACHMENT_NOT_FOUND");
        if (!canReplayFinanceAttachmentReservation(context, authorization(saved))) {
          if (this.isCurrentRoleAllowedForPurpose(context, saved.purpose)) throw new Error("FINANCE_ATTACHMENT_NOT_READY");
          throw new Error("FORBIDDEN_SCOPE");
        }
        await client.query("COMMIT");
        return mapReservation(saved, true);
      }
      const document = one((await client.query<DocumentRow>(
        `SELECT document.id::text AS document_id,document.applicant_person_id::text AS applicant_person_id,document.kind AS document_kind,document.status AS document_status,
                to_char(COALESCE(withdrawal_submission.submitted_at,document.created_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS business_at
           FROM finance_document document
           LEFT JOIN finance_withdrawal_submission withdrawal_submission ON withdrawal_submission.finance_document_id=document.id
          WHERE document.id=$1::uuid FOR UPDATE OF document`,
        [documentId]
      )).rows, "FINANCE_DOCUMENT_NOT_FOUND");
      if (isPersonalAttachmentContext(context) && !isWithinPersonalFinanceYear(document.business_at, at)) throw new Error("FINANCE_DOCUMENT_NOT_FOUND");
      if (!canReserveFinanceAttachment(context, { applicantPersonId: document.applicant_person_id, kind: document.document_kind, status: document.document_status }, draft.purpose)) {
        if (isPersonalAttachmentContext(context) && document.applicant_person_id !== context.personId) throw new Error("FINANCE_DOCUMENT_NOT_FOUND");
        throw new Error("FINANCE_ATTACHMENT_NOT_READY");
      }
      const budget = one((await client.query<{total_bytes:string;version_count:string}>(
        `SELECT COALESCE(SUM(version.declared_size_bytes),0)::text AS total_bytes,COUNT(*)::text AS version_count
           FROM finance_attachment attachment
           JOIN finance_attachment_version version ON version.finance_attachment_id=attachment.id
          WHERE attachment.finance_document_id=$1::uuid
            AND version.status IN ('UPLOADING','READY')
            AND (attachment.purpose='PAYMENT_RECEIPT') = ($2::boolean)`,
        [documentId, isReceiptPurpose(draft.purpose)]
      )).rows, "FINANCE_ATTACHMENT_BUDGET_QUERY_FAILED");
      if (BigInt(budget.total_bytes) + BigInt(draft.declaredSizeBytes) > BigInt(this.limits.maxDocumentBytes) || Number(budget.version_count) + 1 > this.limits.maxActiveVersions) throw new Error("FINANCE_ATTACHMENT_LIMIT_EXCEEDED");
      const attachment = one((await client.query<{id:string}>(
        `INSERT INTO finance_attachment(finance_document_id,purpose,created_by_person_id,created_at) VALUES ($1::uuid,$2,$3::uuid,$4::timestamptz) RETURNING id::text AS id`,
        [documentId,draft.purpose,context.personId,at.toISOString()]
      )).rows, "FINANCE_ATTACHMENT_RESERVE_FAILED");
      const version = one((await client.query<VersionRow>(
        `INSERT INTO finance_attachment_version(finance_attachment_id,version_no,status,original_filename,declared_media_type,declared_size_bytes,expected_sha256,uploaded_by_person_id,created_at)
         VALUES ($1::uuid,1,'UPLOADING',$2,$3,$4::bigint,$5,$6::uuid,$7::timestamptz)
         RETURNING $1::text AS attachment_id,id::text AS version_id,version_no::text AS version_no,status,$8::text AS purpose,original_filename,declared_media_type,declared_size_bytes::text AS declared_size_bytes,expected_sha256,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,$9::text AS applicant_person_id,$10::text AS document_kind,$11::text AS document_status,$6::text AS created_by_person_id,uploaded_by_person_id::text AS uploaded_by_person_id`,
        [attachment.id,draft.originalFilename,draft.declaredMediaType,draft.declaredSizeBytes,draft.expectedSha256 ?? null,context.personId,at.toISOString(),draft.purpose,document.applicant_person_id,document.document_kind,document.document_status]
      )).rows, "FINANCE_ATTACHMENT_RESERVE_FAILED");
      await client.query(`INSERT INTO finance_attachment_event(finance_attachment_version_id,event_type,actor_person_id,result_version_no,created_at) VALUES ($1::uuid,'RESERVED',$2::uuid,1,$3::timestamptz)`, [version.version_id,context.personId,at.toISOString()]);
      await client.query(`INSERT INTO finance_attachment_reservation_idempotency(actor_person_id,idempotency_key,request_hash,finance_attachment_id,finance_attachment_version_id,result_version_no,created_at) VALUES ($1::uuid,$2,$3,$4::uuid,$5::uuid,1,$6::timestamptz)`, [context.personId,idempotencyKey,hash,attachment.id,version.version_id,at.toISOString()]);
      await client.query("COMMIT");
      return mapReservation(version, false);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { await client.release(); }
  }

  /** Creates a new immutable version within an existing attachment slot; it never replaces the older original or binding. */
  public async reserveNextVersion(
    context: RoleContext,
    attachmentId: string,
    draft: FinanceAttachmentNextVersionDraft,
    idempotencyKey: string,
    at: Date
  ): Promise<FinanceAttachmentReservation> {
    if (!UUID.test(attachmentId) || !idempotencyKey.trim() || idempotencyKey.length > 200 || !Number.isFinite(at.getTime())) throw new Error("INVALID_INPUT");
    validateReservationDraft(draft, this.limits);
    if (!isKnownScopedPersonal(context) && !isHeadquartersFinanceGlobal(context)) throw new Error("FORBIDDEN_SCOPE");
    const normalizedAttachmentId = attachmentId.toLowerCase();
    const hash = createHash("sha256").update(JSON.stringify([
      "finance-attachment.reserve-next-version.v1", normalizedAttachmentId, draft.originalFilename,
      draft.declaredMediaType, draft.declaredSizeBytes, draft.expectedSha256 ?? null
    ])).digest("hex");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`finance-attachment:${context.personId}:${idempotencyKey}`]);
      const document = await this.lockDocumentForAttachment(client, normalizedAttachmentId);
      if (document === undefined) throw new Error("FINANCE_ATTACHMENT_NOT_FOUND");
      if (isKnownScopedPersonal(context) && (!isWithinPersonalFinanceYear(document.business_at, at) || document.applicant_person_id !== context.personId)) {
        throw new Error("FINANCE_ATTACHMENT_NOT_FOUND");
      }
      const slot = await this.lockAttachmentSlot(client, normalizedAttachmentId);
      if (slot === undefined || slot.document_id !== document.document_id) throw new Error("FINANCE_ATTACHMENT_NOT_FOUND");
      if (!canReserveFinanceAttachment(context, {
        applicantPersonId: document.applicant_person_id, kind: document.document_kind, status: document.document_status
      }, slot.purpose)) throw new Error("FINANCE_ATTACHMENT_NOT_READY");
      const latest = await this.lockLatestVersion(client, normalizedAttachmentId);
      if (latest === undefined) throw new Error("FINANCE_ATTACHMENT_PERSISTENCE_INVALID:missingVersion");
      const replay = await client.query<{request_hash: string; finance_attachment_version_id: string}>(
        `SELECT request_hash,finance_attachment_version_id::text AS finance_attachment_version_id
           FROM finance_attachment_reservation_idempotency
          WHERE actor_person_id=$1::uuid AND idempotency_key=$2 FOR SHARE`, [context.personId, idempotencyKey]
      );
      if (replay.rows[0] !== undefined) {
        if (replay.rows[0].request_hash !== hash) throw new Error("IDEMPOTENCY_REPLAY");
        const saved = await this.lockVersionForSlot(client, replay.rows[0].finance_attachment_version_id, normalizedAttachmentId);
        if (saved === undefined || saved.uploaded_by_person_id !== context.personId) throw new Error("FINANCE_ATTACHMENT_NOT_FOUND");
        if (isKnownScopedPersonal(context) && !isWithinPersonalFinanceYear(saved.business_at, at)) throw new Error("FINANCE_ATTACHMENT_NOT_FOUND");
        if (!canReserveFinanceAttachment(context, documentState(saved), saved.purpose)) throw new Error("FINANCE_ATTACHMENT_NOT_READY");
        await client.query("COMMIT");
        return mapReservation(saved, true);
      }
      const budget = await this.documentBudget(client, document.document_id, isReceiptPurpose(slot.purpose));
      if (BigInt(budget.total_bytes) + BigInt(draft.declaredSizeBytes) > BigInt(this.limits.maxDocumentBytes)
        || Number(budget.version_count) + 1 > this.limits.maxActiveVersions) throw new Error("FINANCE_ATTACHMENT_LIMIT_EXCEEDED");
      const nextVersionNo = positiveSafeInteger(latest.version_no, "versionNo") + 1;
      if (!Number.isSafeInteger(nextVersionNo)) throw new Error("FINANCE_ATTACHMENT_PERSISTENCE_INVALID:versionNo");
      const version = one((await client.query<VersionRow>(
        `INSERT INTO finance_attachment_version(finance_attachment_id,version_no,status,original_filename,declared_media_type,declared_size_bytes,expected_sha256,uploaded_by_person_id,created_at)
         VALUES ($1::uuid,$2::integer,'UPLOADING',$3,$4,$5::bigint,$6,$7::uuid,$8::timestamptz)
         RETURNING $1::text AS attachment_id,id::text AS version_id,version_no::text AS version_no,status,$9::text AS purpose,original_filename,declared_media_type,declared_size_bytes::text AS declared_size_bytes,expected_sha256,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at,$10::text AS applicant_person_id,$11::text AS document_kind,$12::text AS document_status,$7::text AS created_by_person_id,uploaded_by_person_id::text AS uploaded_by_person_id,$13::text AS business_at`,
        [normalizedAttachmentId,nextVersionNo,draft.originalFilename,draft.declaredMediaType,draft.declaredSizeBytes,draft.expectedSha256 ?? null,context.personId,at.toISOString(),slot.purpose,document.applicant_person_id,document.document_kind,document.document_status,document.business_at]
      )).rows, "FINANCE_ATTACHMENT_RESERVE_FAILED");
      await client.query(`INSERT INTO finance_attachment_event(finance_attachment_version_id,event_type,actor_person_id,result_version_no,created_at) VALUES ($1::uuid,'RESERVED',$2::uuid,$3::integer,$4::timestamptz)`, [version.version_id,context.personId,nextVersionNo,at.toISOString()]);
      await client.query(
        `INSERT INTO finance_attachment_reservation_idempotency(actor_person_id,idempotency_key,request_hash,finance_attachment_id,finance_attachment_version_id,result_version_no,created_at)
         VALUES ($1::uuid,$2,$3,$4::uuid,$5::uuid,$6::integer,$7::timestamptz)`,
        [context.personId,idempotencyKey,hash,normalizedAttachmentId,version.version_id,nextVersionNo,at.toISOString()]
      );
      await client.query("COMMIT");
      return mapReservation(version, false);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { await client.release(); }
  }

  /** One statement produces a coherent attachment/version/binding view; malformed rows reject the entire response. */
  public async listDocument(context: RoleContext, documentId: string, at: Date): Promise<FinanceAttachmentDocumentList> {
    if (!UUID.test(documentId) || !Number.isFinite(at.getTime())) throw new Error("INVALID_INPUT");
    if (!isKnownScopedPersonal(context) && !isGlobalAttachmentReader(context)) throw new Error("FORBIDDEN_SCOPE");
    const personal = isKnownScopedPersonal(context);
    const normalizedDocumentId = documentId.toLowerCase();
    const bounds = personal ? financeYearBounds(at) : undefined;
    const client = await this.pool.connect();
    try {
      const rows = (await client.query<DocumentListRow>(
        `SELECT document.id::text AS document_id,document.applicant_person_id::text AS applicant_person_id,
                to_char(COALESCE(withdrawal_submission.submitted_at,document.created_at) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS business_at,
                attachment.id::text AS attachment_id,attachment.purpose,to_char(attachment.created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS attachment_created_at,
                version.id::text AS version_id,version.version_no::text AS version_no,version.status,version.original_filename,version.declared_media_type,version.declared_size_bytes::text AS declared_size_bytes,version.expected_sha256,
                to_char(version.created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS version_created_at,
                binding.stage AS binding_stage,binding.document_version::text AS binding_document_version,
                to_char(binding.bound_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS binding_bound_at
           FROM finance_document document
           LEFT JOIN finance_withdrawal_submission withdrawal_submission ON withdrawal_submission.finance_document_id=document.id
           LEFT JOIN finance_attachment attachment ON attachment.finance_document_id=document.id
           LEFT JOIN finance_attachment_version version ON version.finance_attachment_id=attachment.id
           LEFT JOIN finance_withdrawal_attachment_binding binding ON binding.finance_attachment_version_id=version.id
          WHERE document.id=$1::uuid
            AND ($2::boolean OR (document.applicant_person_id=$3::uuid
              AND COALESCE(withdrawal_submission.submitted_at,document.created_at)>=$4::timestamptz
              AND COALESCE(withdrawal_submission.submitted_at,document.created_at)<$5::timestamptz))
          ORDER BY attachment.created_at NULLS LAST,attachment.id NULLS LAST,version.version_no NULLS LAST`,
        [normalizedDocumentId, !personal, personal ? context.personId : null, bounds?.start ?? null, bounds?.end ?? null]
      )).rows;
      const first = rows[0];
      if (first === undefined) throw new Error("FINANCE_DOCUMENT_NOT_FOUND");
      if (personal && (first.applicant_person_id !== context.personId || !isWithinPersonalFinanceYear(first.business_at, at))) {
        throw new Error("FINANCE_DOCUMENT_NOT_FOUND");
      }
      return this.mapDocumentList(normalizedDocumentId, rows);
    } finally { await client.release(); }
  }

  /** Personal callers read only their own document; GLOBAL HQ, SYSTEM_ADMIN, and SYSTEM_OWNER may read all. */
  public async getOwnVersion(context: RoleContext, versionId: string, at: Date): Promise<FinanceAttachmentVersionMetadata> {
    if (!UUID.test(versionId) || !Number.isFinite(at.getTime())) throw new Error("INVALID_INPUT");
    if (!isPersonalAttachmentContext(context) && !isGlobalAttachmentReader(context)) throw new Error("FORBIDDEN_SCOPE");
    const client = await this.pool.connect();
    try {
      const row = one((await client.query<VersionRow>(`${versionSelect} WHERE version.id=$1::uuid`, [versionId])).rows, "FINANCE_ATTACHMENT_NOT_FOUND");
      if (!canReadFinanceAttachment(context, documentState(row))) throw new Error("FINANCE_ATTACHMENT_NOT_FOUND");
      if (isPersonalAttachmentContext(context) && !isWithinPersonalFinanceYear(row.business_at, at)) throw new Error("FINANCE_ATTACHMENT_NOT_FOUND");
      return mapVersionMetadata(row);
    } finally { await client.release(); }
  }

  private async lockDocumentForAttachment(client: PostgresClient, attachmentId: string): Promise<DocumentRow | undefined> {
    const document = await client.query<DocumentRow>(
      `SELECT document.id::text AS document_id,document.applicant_person_id::text AS applicant_person_id,document.kind AS document_kind,document.status AS document_status,
              to_char(COALESCE(withdrawal_submission.submitted_at,document.created_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS business_at
         FROM finance_document document
         JOIN finance_attachment attachment ON attachment.finance_document_id=document.id
         LEFT JOIN finance_withdrawal_submission withdrawal_submission ON withdrawal_submission.finance_document_id=document.id
        WHERE attachment.id=$1::uuid FOR UPDATE OF document`, [attachmentId]
    );
    return document.rows[0];
  }

  private async lockAttachmentSlot(client: PostgresClient, attachmentId: string): Promise<AttachmentSlotRow | undefined> {
    const slot = await client.query<AttachmentSlotRow>(
      `SELECT id::text AS attachment_id,finance_document_id::text AS document_id,purpose
         FROM finance_attachment WHERE id=$1::uuid FOR UPDATE`, [attachmentId]
    );
    return slot.rows[0];
  }

  private async lockLatestVersion(client: PostgresClient, attachmentId: string): Promise<VersionRow | undefined> {
    const version = await client.query<VersionRow>(
      `${versionSelect} WHERE attachment.id=$1::uuid ORDER BY version.version_no DESC LIMIT 1 FOR UPDATE OF version`, [attachmentId]
    );
    return version.rows[0];
  }

  private async lockVersionForSlot(client: PostgresClient, versionId: string, attachmentId: string): Promise<VersionRow | undefined> {
    const version = await client.query<VersionRow>(
      `${versionSelect} WHERE version.id=$1::uuid AND attachment.id=$2::uuid FOR UPDATE OF version`, [versionId, attachmentId]
    );
    return version.rows[0];
  }

  private async documentBudget(client: PostgresClient, documentId: string, receipt: boolean): Promise<Readonly<{ total_bytes: string; version_count: string }>> {
    return one((await client.query<{ total_bytes: string; version_count: string }>(
      `SELECT COALESCE(SUM(version.declared_size_bytes),0)::text AS total_bytes,COUNT(*)::text AS version_count
         FROM finance_attachment attachment
         JOIN finance_attachment_version version ON version.finance_attachment_id=attachment.id
        WHERE attachment.finance_document_id=$1::uuid
          AND version.status IN ('UPLOADING','READY')
          AND (attachment.purpose='PAYMENT_RECEIPT') = ($2::boolean)`, [documentId, receipt]
    )).rows, "FINANCE_ATTACHMENT_BUDGET_QUERY_FAILED");
  }

  private mapDocumentList(documentId: string, rows: readonly DocumentListRow[]): FinanceAttachmentDocumentList {
    const attachments = new Map<string, {
      attachmentId: string; purpose: FinanceAttachmentPurpose; createdAt: string;
      versions: Array<{
        versionId: string; versionNo: number; status: "UPLOADING" | "READY" | "FAILED";
        originalFilename: string; declaredMediaType: FinanceAttachmentMediaType; declaredSizeBytes: number;
        expectedSha256?: string; createdAt: string;
        binding?: { stage: "SUBMISSION" | "COMPLETION"; documentVersion: number; boundAt: string };
      }>;
    }>();
    for (const row of rows) {
      if (!UUID.test(row.document_id) || row.document_id !== documentId || !UUID.test(row.applicant_person_id)) {
        throw new Error("FINANCE_ATTACHMENT_PERSISTENCE_INVALID:document");
      }
      isoTimestamp(row.business_at, "businessAt");
      if (row.attachment_id === null) {
        if ([row.purpose,row.attachment_created_at,row.version_id,row.version_no,row.status,row.original_filename,row.declared_media_type,row.declared_size_bytes,row.expected_sha256,row.version_created_at,row.binding_stage,row.binding_document_version,row.binding_bound_at].some(value => value !== null)) {
          throw new Error("FINANCE_ATTACHMENT_PERSISTENCE_INVALID:emptyAttachment");
        }
        continue;
      }
      if (!UUID.test(row.attachment_id) || row.purpose === null || !isPurpose(row.purpose) || row.attachment_created_at === null
        || row.version_id === null || !UUID.test(row.version_id) || row.version_no === null || row.status === null
        || row.original_filename === null || row.declared_media_type === null || row.declared_size_bytes === null || row.version_created_at === null) {
        throw new Error("FINANCE_ATTACHMENT_PERSISTENCE_INVALID:attachment");
      }
      if (row.status !== "UPLOADING" && row.status !== "READY" && row.status !== "FAILED") throw new Error("FINANCE_ATTACHMENT_PERSISTENCE_INVALID:status");
      const status = row.status as "UPLOADING" | "READY" | "FAILED";
      if (!isMediaType(row.declared_media_type) || (row.expected_sha256 !== null && !SHA256.test(row.expected_sha256))) {
        throw new Error("FINANCE_ATTACHMENT_PERSISTENCE_INVALID:metadata");
      }
      const version = {
        versionId: row.version_id,
        versionNo: positiveSafeInteger(row.version_no, "versionNo"),
        status,
        originalFilename: row.original_filename,
        declaredMediaType: row.declared_media_type,
        declaredSizeBytes: positiveSafeInteger(row.declared_size_bytes, "declaredSizeBytes"),
        ...(row.expected_sha256 === null ? {} : { expectedSha256: row.expected_sha256 }),
        createdAt: isoTimestamp(row.version_created_at, "versionCreatedAt")
      };
      const bindingValues = [row.binding_stage,row.binding_document_version,row.binding_bound_at];
      if (bindingValues.some(value => value !== null)) {
        if (row.binding_stage !== "SUBMISSION" && row.binding_stage !== "COMPLETION") throw new Error("FINANCE_ATTACHMENT_PERSISTENCE_INVALID:binding");
        if (row.binding_document_version === null || row.binding_bound_at === null) throw new Error("FINANCE_ATTACHMENT_PERSISTENCE_INVALID:binding");
        Object.assign(version, { binding: {
          stage: row.binding_stage,
          documentVersion: positiveSafeInteger(row.binding_document_version, "bindingDocumentVersion"),
          boundAt: isoTimestamp(row.binding_bound_at, "bindingBoundAt")
        } });
      }
      const existing = attachments.get(row.attachment_id);
      const createdAt = isoTimestamp(row.attachment_created_at, "attachmentCreatedAt");
      if (existing !== undefined) {
        if (existing.purpose !== row.purpose || existing.createdAt !== createdAt) throw new Error("FINANCE_ATTACHMENT_PERSISTENCE_INVALID:slot");
        existing.versions.push(version);
      } else {
        attachments.set(row.attachment_id, { attachmentId: row.attachment_id, purpose: row.purpose, createdAt, versions: [version] });
      }
    }
    return { documentId, attachments: [...attachments.values()].map((attachment) => ({
      attachmentId: attachment.attachmentId, purpose: attachment.purpose, createdAt: attachment.createdAt,
      versions: attachment.versions
    })) };
  }

  private assertReservationRole(context: RoleContext, purpose: FinanceAttachmentPurpose): void {
    if (!this.isCurrentRoleAllowedForPurpose(context, purpose)) throw new Error("FORBIDDEN_SCOPE");
  }

  private isCurrentRoleAllowedForPurpose(context: RoleContext, purpose: FinanceAttachmentPurpose): boolean {
    return (isPersonalAttachmentContext(context) && !isReceiptPurpose(purpose)) || (isHeadquartersFinanceGlobal(context) && isReceiptPurpose(purpose));
  }

  /** Document is locked before its version, so a withdrawal state transition cannot race a replay. */
  private async lockVersionAfterDocument(client: PostgresClient, versionId: string): Promise<VersionRow | undefined> {
    const document = await client.query<DocumentRow>(
      `SELECT document.id::text AS document_id,document.applicant_person_id::text AS applicant_person_id,document.kind AS document_kind,document.status AS document_status,
              to_char(COALESCE(withdrawal_submission.submitted_at,document.created_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS business_at
         FROM finance_document document JOIN finance_attachment attachment ON attachment.finance_document_id=document.id JOIN finance_attachment_version version ON version.finance_attachment_id=attachment.id
         LEFT JOIN finance_withdrawal_submission withdrawal_submission ON withdrawal_submission.finance_document_id=document.id
        WHERE version.id=$1::uuid FOR UPDATE OF document`, [versionId]
    );
    if (document.rows[0] === undefined) return undefined;
    const version = await client.query<VersionRow>(`${versionSelect} WHERE version.id=$1::uuid FOR UPDATE OF version`, [versionId]);
    return version.rows[0];
  }
}
