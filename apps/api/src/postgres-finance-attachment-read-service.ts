import type { RoleContext } from "@teaching-research-alliance/contracts";
import { LocalAttachmentStore, type AttachmentMediaType } from "./local-attachment-store.js";
import { canReadFinanceAttachment, isGlobalAttachmentReader, isPersonalAttachmentContext, isWithinPersonalFinanceYear } from "./finance-attachment-authorization.js";
import type { PostgresClient, PostgresPool } from "./postgres-ledger-repository.js";

export type FinanceAttachmentDownload = Readonly<{
  bytes: Buffer;
  mediaType: AttachmentMediaType;
  originalFilename: string;
  sha256: string;
  sizeBytes: number;
}>;

type DocumentRow = Readonly<{ document_id: string; applicant_person_id: string; document_kind: string; document_status: string; business_at: string }>;
type AttachmentRow = Readonly<{
  version_id: string; status: string; original_filename: string; detected_media_type: string | null;
  actual_size_bytes: string | null; sha256: string | null; ready_at: string | null;
  applicant_person_id: string; document_kind: string; document_status: string;
  business_at: string;
}>;
type AuditAction = "ATTACHMENT_DOWNLOAD_SUCCEEDED" | "ATTACHMENT_DOWNLOAD_DENIED" | "ATTACHMENT_INTEGRITY_FAILED";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const mediaTypes = ["application/pdf", "image/png", "image/jpeg"] as const;
const isMediaType = (value: string | null): value is AttachmentMediaType => value !== null && mediaTypes.includes(value as AttachmentMediaType);
const asPositiveSafeInteger = (value: string | null): number | undefined => {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};
const isReadyAt = (value: string | null): boolean => value !== null && Number.isFinite(new Date(value).getTime());

const insertAudit = async (client: PostgresClient, context: RoleContext, versionId: string, action: AuditAction, reason: string, at: Date): Promise<void> => {
  await client.query(
    `INSERT INTO audit_event(actor_person_id,action_code,subject_type,subject_id,after_json,reason,created_at)
     VALUES ($1::uuid,$2,'FINANCE_ATTACHMENT_VERSION',$3::uuid,jsonb_build_object('contextSubject',$4::text),$5,$6::timestamptz)`,
    [context.personId,action,versionId,context.subject,reason,at.toISOString()]
  );
};

const versionSelect = `
  SELECT version.id::text AS version_id,version.status,version.original_filename,version.detected_media_type,
         version.actual_size_bytes::text AS actual_size_bytes,version.sha256,
         to_char(version.ready_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ready_at,
         document.applicant_person_id::text AS applicant_person_id,document.kind AS document_kind,document.status AS document_status,
         to_char(COALESCE(withdrawal_submission.submitted_at,document.created_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS business_at
    FROM finance_attachment_version version
    JOIN finance_attachment attachment ON attachment.id=version.finance_attachment_id
    JOIN finance_document document ON document.id=attachment.finance_document_id
    LEFT JOIN finance_withdrawal_submission withdrawal_submission ON withdrawal_submission.finance_document_id=document.id`;

/** Reads only an authorized READY original. The document is locked before the version through the integrity check. */
export class PostgresFinanceAttachmentReadService {
  public constructor(private readonly pool: PostgresPool, private readonly store: LocalAttachmentStore) {}

  public async readOwn(context: RoleContext, versionId: string, at: Date): Promise<FinanceAttachmentDownload> {
    if (!UUID.test(versionId) || !Number.isFinite(at.getTime())) throw new Error("INVALID_INPUT");
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      const failAfterAudit = async (action: AuditAction, reason: string, code: string): Promise<never> => {
        await insertAudit(client, context, versionId, action, reason, at);
        await client.query("COMMIT");
        transactionOpen = false;
        throw new Error(code);
      };
      if (!isPersonalAttachmentContext(context) && !isGlobalAttachmentReader(context)) {
        return await failAfterAudit("ATTACHMENT_DOWNLOAD_DENIED", "FORBIDDEN_SCOPE", "FORBIDDEN_SCOPE");
      }
      const document = await client.query<DocumentRow>(
        `SELECT document.id::text AS document_id,document.applicant_person_id::text AS applicant_person_id,document.kind AS document_kind,document.status AS document_status,
                to_char(COALESCE(withdrawal_submission.submitted_at,document.created_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS business_at
           FROM finance_document document JOIN finance_attachment attachment ON attachment.finance_document_id=document.id JOIN finance_attachment_version version ON version.finance_attachment_id=attachment.id
           LEFT JOIN finance_withdrawal_submission withdrawal_submission ON withdrawal_submission.finance_document_id=document.id
          WHERE version.id=$1::uuid FOR SHARE OF document`, [versionId]
      );
      if (document.rows[0] === undefined) return await failAfterAudit("ATTACHMENT_DOWNLOAD_DENIED", "NOT_FOUND_OR_FORBIDDEN", "FINANCE_ATTACHMENT_NOT_FOUND");
      const result = await client.query<AttachmentRow>(`${versionSelect} WHERE version.id=$1::uuid FOR SHARE OF version`, [versionId]);
      const row = result.rows[0];
      if (row === undefined || !canReadFinanceAttachment(context, { applicantPersonId: document.rows[0].applicant_person_id, kind: document.rows[0].document_kind, status: document.rows[0].document_status })) {
        return await failAfterAudit("ATTACHMENT_DOWNLOAD_DENIED", "NOT_FOUND_OR_FORBIDDEN", "FINANCE_ATTACHMENT_NOT_FOUND");
      }
      if (isPersonalAttachmentContext(context) && !isWithinPersonalFinanceYear(document.rows[0].business_at, at)) {
        return await failAfterAudit("ATTACHMENT_DOWNLOAD_DENIED", "NOT_FOUND_OR_FORBIDDEN", "FINANCE_ATTACHMENT_NOT_FOUND");
      }
      if (row.status === "UPLOADING" || row.status === "FAILED") {
        return await failAfterAudit("ATTACHMENT_DOWNLOAD_DENIED", "ATTACHMENT_NOT_READY", "FINANCE_ATTACHMENT_NOT_READY");
      }
      const sizeBytes = asPositiveSafeInteger(row.actual_size_bytes);
      if (row.status !== "READY" || !isMediaType(row.detected_media_type) || sizeBytes === undefined || row.sha256 === null || !SHA256.test(row.sha256) || !isReadyAt(row.ready_at)) {
        return await failAfterAudit("ATTACHMENT_INTEGRITY_FAILED", "READY_METADATA_INVALID", "ATTACHMENT_INTEGRITY_FAILED");
      }
      let bytes: Buffer;
      try {
        bytes = await this.store.readVerified({ versionId: row.version_id, mediaType: row.detected_media_type, sizeBytes, sha256: row.sha256 });
      } catch {
        return await failAfterAudit("ATTACHMENT_INTEGRITY_FAILED", "OBJECT_VERIFICATION_FAILED", "ATTACHMENT_INTEGRITY_FAILED");
      }
      await insertAudit(client, context, versionId, "ATTACHMENT_DOWNLOAD_SUCCEEDED", "READY_OBJECT_VERIFIED", at);
      await client.query("COMMIT");
      transactionOpen = false;
      return { bytes, mediaType: row.detected_media_type, originalFilename: row.original_filename, sha256: row.sha256, sizeBytes };
    } catch (error) {
      if (transactionOpen) await client.query("ROLLBACK");
      throw error;
    } finally { await client.release(); }
  }
}
