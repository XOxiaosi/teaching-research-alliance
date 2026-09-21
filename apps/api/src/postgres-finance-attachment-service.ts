import { createHash } from "node:crypto";
import type { RoleContext } from "@teaching-research-alliance/contracts";
import type { PostgresPool } from "./postgres-ledger-repository.js";

export const FINANCE_ATTACHMENT_PURPOSES = ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT", "INVOICE"] as const;
export const FINANCE_ATTACHMENT_MEDIA_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;
export type FinanceAttachmentPurpose = (typeof FINANCE_ATTACHMENT_PURPOSES)[number];
export type FinanceAttachmentMediaType = (typeof FINANCE_ATTACHMENT_MEDIA_TYPES)[number];
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
export type FinanceAttachmentLimits = Readonly<{
  maxFileBytes: number;
  maxDocumentBytes: number;
  maxActiveVersions: number;
}>;
export type FinanceAttachmentReservationDraft = Readonly<{
  purpose: FinanceAttachmentPurpose;
  originalFilename: string;
  declaredMediaType: FinanceAttachmentMediaType;
  declaredSizeBytes: number;
  expectedSha256?: string;
}>;

type VersionRow = Readonly<{
  attachment_id: string;
  version_id: string;
  version_no: string;
  status: "UPLOADING" | "READY" | "FAILED";
  purpose: FinanceAttachmentPurpose;
  original_filename: string;
  declared_media_type: FinanceAttachmentMediaType;
  declared_size_bytes: string;
  expected_sha256: string | null;
  created_at: string;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const allowedSubjects = ["TEACHING_TEACHER", "ACADEMIC_PLANNER", "PLANNING_MENTOR"] as const;
const defaults: FinanceAttachmentLimits = { maxFileBytes: 20 * 1024 * 1024, maxDocumentBytes: 100 * 1024 * 1024, maxActiveVersions: 20 };
const STORE_MAX_FILE_BYTES = 20 * 1024 * 1024;

const assertContext = (context: RoleContext): void => {
  if (!allowedSubjects.includes(context.subject as (typeof allowedSubjects)[number])) throw new Error("FORBIDDEN_SCOPE");
};
const one = <Row>(rows: readonly Row[], errorCode: string): Row => {
  if (rows.length !== 1) throw new Error(errorCode);
  return rows[0]!;
};
const isPurpose = (value: string): value is FinanceAttachmentPurpose => (FINANCE_ATTACHMENT_PURPOSES as readonly string[]).includes(value);
const isMediaType = (value: string): value is FinanceAttachmentMediaType => (FINANCE_ATTACHMENT_MEDIA_TYPES as readonly string[]).includes(value);
const positiveSafeInteger = (value: string, field: string): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`FINANCE_ATTACHMENT_PERSISTENCE_INVALID:${field}`);
  return result;
};
const mapReservation = (row: VersionRow, replay: boolean): FinanceAttachmentReservation => ({
  attachmentId: row.attachment_id,
  versionId: row.version_id,
  versionNo: positiveSafeInteger(row.version_no, "versionNo"),
  status: "UPLOADING",
  purpose: row.purpose,
  originalFilename: row.original_filename,
  declaredMediaType: row.declared_media_type,
  declaredSizeBytes: positiveSafeInteger(row.declared_size_bytes, "declaredSizeBytes"),
  ...(row.expected_sha256 === null ? {} : { expectedSha256: row.expected_sha256 }),
  createdAt: new Date(row.created_at).toISOString(),
  replay
});
const mapVersionMetadata = (row: VersionRow): FinanceAttachmentVersionMetadata => ({
  attachmentId: row.attachment_id,
  versionId: row.version_id,
  versionNo: positiveSafeInteger(row.version_no, "versionNo"),
  status: row.status,
  purpose: row.purpose,
  originalFilename: row.original_filename,
  declaredMediaType: row.declared_media_type,
  declaredSizeBytes: positiveSafeInteger(row.declared_size_bytes, "declaredSizeBytes"),
  ...(row.expected_sha256 === null ? {} : { expectedSha256: row.expected_sha256 }),
  createdAt: new Date(row.created_at).toISOString()
});

const versionSelect = `
  SELECT attachment.id::text AS attachment_id,
         version.id::text AS version_id,
         version.version_no::text AS version_no,
         version.status,
         attachment.purpose,
         version.original_filename,
         version.declared_media_type,
         version.declared_size_bytes::text AS declared_size_bytes,
         version.expected_sha256,
         to_char(version.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
    FROM finance_attachment_version version
    JOIN finance_attachment attachment ON attachment.id = version.finance_attachment_id`;

export class PostgresFinanceAttachmentService {
  private readonly limits: FinanceAttachmentLimits;

  public constructor(private readonly pool: PostgresPool, limits: Partial<FinanceAttachmentLimits> = {}) {
    this.limits = { ...defaults, ...limits };
    if (!Number.isSafeInteger(this.limits.maxFileBytes) || this.limits.maxFileBytes < 1 || this.limits.maxFileBytes > STORE_MAX_FILE_BYTES
      || !Number.isSafeInteger(this.limits.maxDocumentBytes) || this.limits.maxDocumentBytes < this.limits.maxFileBytes
      || !Number.isSafeInteger(this.limits.maxActiveVersions) || this.limits.maxActiveVersions < 1) throw new Error("FINANCE_ATTACHMENT_LIMIT_CONFIG_INVALID");
  }

  public async reserve(
    context: RoleContext,
    documentId: string,
    draft: FinanceAttachmentReservationDraft,
    idempotencyKey: string,
    at: Date
  ): Promise<FinanceAttachmentReservation> {
    assertContext(context);
    if (!UUID.test(documentId) || !isPurpose(draft.purpose) || !isMediaType(draft.declaredMediaType)
      || !draft.originalFilename.trim() || Buffer.byteLength(draft.originalFilename, "utf8") > 255
      || /[\x00-\x1f\x7f/\\]/.test(draft.originalFilename)
      || !Number.isSafeInteger(draft.declaredSizeBytes) || draft.declaredSizeBytes < 1 || draft.declaredSizeBytes > this.limits.maxFileBytes
      || (draft.expectedSha256 !== undefined && !SHA256.test(draft.expectedSha256))
      || !idempotencyKey.trim() || idempotencyKey.length > 200 || !Number.isFinite(at.getTime())) throw new Error("INVALID_INPUT");
    const hash = createHash("sha256").update(JSON.stringify([
      documentId,
      draft.purpose,
      draft.originalFilename,
      draft.declaredMediaType,
      draft.declaredSizeBytes,
      draft.expectedSha256 ?? null
    ])).digest("hex");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`finance-attachment:${context.personId}:${idempotencyKey}`]);
      const replay = await client.query<{request_hash:string;finance_attachment_version_id:string}>(
        `SELECT request_hash,finance_attachment_version_id::text AS finance_attachment_version_id
           FROM finance_attachment_reservation_idempotency
          WHERE actor_person_id=$1::uuid AND idempotency_key=$2 FOR SHARE`, [context.personId,idempotencyKey]);
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== hash) throw new Error("IDEMPOTENCY_REPLAY");
        const saved = one((await client.query<VersionRow>(
          `${versionSelect} JOIN finance_document document ON document.id=attachment.finance_document_id
            WHERE version.id=$1::uuid AND document.applicant_person_id=$2::uuid`, [replay.rows[0].finance_attachment_version_id,context.personId])).rows,"FINANCE_ATTACHMENT_NOT_FOUND");
        await client.query("COMMIT");
        return mapReservation(saved,true);
      }
      const document = await client.query<{id:string}>(
        `SELECT id::text AS id FROM finance_document
          WHERE id=$1::uuid AND applicant_person_id=$2::uuid AND status='DRAFT' FOR UPDATE`, [documentId,context.personId]);
      if (document.rows.length === 0) throw new Error("FINANCE_DOCUMENT_NOT_FOUND");
      const budget = one((await client.query<{total_bytes:string;version_count:string}>(
        `SELECT COALESCE(SUM(version.declared_size_bytes),0)::text AS total_bytes,COUNT(*)::text AS version_count
           FROM finance_attachment attachment JOIN finance_attachment_version version ON version.finance_attachment_id=attachment.id
          WHERE attachment.finance_document_id=$1::uuid AND version.status IN ('UPLOADING','READY')`, [documentId])).rows,"FINANCE_ATTACHMENT_BUDGET_QUERY_FAILED");
      if (BigInt(budget.total_bytes) + BigInt(draft.declaredSizeBytes) > BigInt(this.limits.maxDocumentBytes)
        || Number(budget.version_count) + 1 > this.limits.maxActiveVersions) throw new Error("FINANCE_ATTACHMENT_LIMIT_EXCEEDED");
      const attachment = one((await client.query<{id:string}>(
        `INSERT INTO finance_attachment(finance_document_id,purpose,created_by_person_id,created_at)
         VALUES ($1::uuid,$2,$3::uuid,$4::timestamptz) RETURNING id::text AS id`, [documentId,draft.purpose,context.personId,at.toISOString()])).rows,"FINANCE_ATTACHMENT_RESERVE_FAILED");
      const version = one((await client.query<VersionRow>(
        `INSERT INTO finance_attachment_version(finance_attachment_id,version_no,status,original_filename,declared_media_type,declared_size_bytes,expected_sha256,uploaded_by_person_id,created_at)
         VALUES ($1::uuid,1,'UPLOADING',$2,$3,$4::bigint,$5,$6::uuid,$7::timestamptz)
         RETURNING $1::text AS attachment_id,id::text AS version_id,version_no::text AS version_no,status,$8::text AS purpose,original_filename,declared_media_type,declared_size_bytes::text AS declared_size_bytes,expected_sha256,to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at`,
        [attachment.id,draft.originalFilename,draft.declaredMediaType,draft.declaredSizeBytes,draft.expectedSha256??null,context.personId,at.toISOString(),draft.purpose])).rows,"FINANCE_ATTACHMENT_RESERVE_FAILED");
      await client.query(`INSERT INTO finance_attachment_event(finance_attachment_version_id,event_type,actor_person_id,result_version_no,created_at) VALUES ($1::uuid,'RESERVED',$2::uuid,1,$3::timestamptz)`,[version.version_id,context.personId,at.toISOString()]);
      await client.query(`INSERT INTO finance_attachment_reservation_idempotency(actor_person_id,idempotency_key,request_hash,finance_attachment_id,finance_attachment_version_id,result_version_no,created_at) VALUES ($1::uuid,$2,$3,$4::uuid,$5::uuid,1,$6::timestamptz)`,[context.personId,idempotencyKey,hash,attachment.id,version.version_id,at.toISOString()]);
      await client.query("COMMIT");
      return mapReservation(version,false);
    } catch(error) { await client.query("ROLLBACK"); throw error; }
    finally { await client.release(); }
  }

  public async getOwnVersion(context: RoleContext, versionId: string): Promise<FinanceAttachmentVersionMetadata> {
    assertContext(context);
    if (!UUID.test(versionId)) throw new Error("INVALID_INPUT");
    const client = await this.pool.connect();
    try {
      const row=one((await client.query<VersionRow>(
        `${versionSelect} JOIN finance_document document ON document.id=attachment.finance_document_id
          WHERE version.id=$1::uuid AND document.applicant_person_id=$2::uuid`,[versionId,context.personId])).rows,"FINANCE_ATTACHMENT_NOT_FOUND");
      return mapVersionMetadata(row);
    } finally { await client.release(); }
  }
}
