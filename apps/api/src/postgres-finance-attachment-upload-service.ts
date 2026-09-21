import type { RoleContext } from "@teaching-research-alliance/contracts";
import {
  AttachmentCleanupError,
  AttachmentPublicationError,
  LocalAttachmentStore,
  type AttachmentMediaType,
  type AttachmentUpload,
  type StoredAttachment
} from "./local-attachment-store.js";
import { validateAttachmentFormat } from "./attachment-format-validator.js";
import type { PostgresPool } from "./postgres-ledger-repository.js";

export type FinanceAttachmentUploadResult = Readonly<{
  versionId: string;
  status: "READY";
  detectedMediaType: AttachmentMediaType;
  actualSizeBytes: number;
  sha256: string;
  readyAt: string;
  replay: boolean;
}>;

type UploadingVersionRow = Readonly<{
  version_id: string;
  version_no: string;
  status: "UPLOADING" | "READY" | "FAILED";
  original_filename: string;
  declared_media_type: AttachmentMediaType;
  declared_size_bytes: string;
  expected_sha256: string | null;
  detected_media_type: AttachmentMediaType | null;
  actual_size_bytes: string | null;
  sha256: string | null;
  ready_at: string | null;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const allowedSubjects = ["TEACHING_TEACHER", "ACADEMIC_PLANNER", "PLANNING_MENTOR"] as const;

const assertContext = (context: RoleContext): void => {
  if (!allowedSubjects.includes(context.subject as (typeof allowedSubjects)[number])) throw new Error("FORBIDDEN_SCOPE");
};
const asPositiveSafeInteger = (value: string | null, field: string): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`FINANCE_ATTACHMENT_PERSISTENCE_INVALID:${field}`);
  return result;
};
const errorCode = (error: unknown): string | undefined => {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.message : undefined;
};
const isRetryableValidationError = (error: unknown): boolean => {
  const code = errorCode(error);
  return code === "ATTACHMENT_VALIDATOR_BUSY" || code === "ATTACHMENT_VALIDATION_TIMEOUT";
};
const isTerminalUploadValidationError = (error: unknown): boolean => {
  const code = errorCode(error);
  return code === "ATTACHMENT_TOO_LARGE"
    || code === "ATTACHMENT_SIZE_MISMATCH"
    || code === "ATTACHMENT_TYPE_INVALID"
    || code === "ATTACHMENT_HASH_MISMATCH"
    || code === "ATTACHMENT_UNREADABLE"
    || code === "ATTACHMENT_STREAM_INTERRUPTED";
};
const isRecoverableStorageError = (error: unknown): boolean => {
  const code = errorCode(error);
  return error instanceof AttachmentPublicationError || error instanceof AttachmentCleanupError
    || code === "ATTACHMENT_VERSION_EXISTS"
    || code === "ATTACHMENT_UNAVAILABLE"
    || code === "ATTACHMENT_INTEGRITY_FAILED"
    || code === "ATTACHMENT_METADATA_INVALID"
    || code === "ATTACHMENT_STORE_PATH_INVALID"
    || code === "ATTACHMENT_STORE_PERMISSIONS_INVALID";
};
/** Normalize only producer iteration failures. Store write failures happen after yield and must retain their own classification. */
const normalizedInputChunks = async function* (chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  try {
    for await (const chunk of chunks) yield chunk;
  } catch {
    throw new Error("ATTACHMENT_STREAM_INTERRUPTED");
  }
};

const toStored = (row: UploadingVersionRow): StoredAttachment => {
  if (row.detected_media_type === null || row.actual_size_bytes === null || row.sha256 === null) {
    throw new Error("FINANCE_ATTACHMENT_PERSISTENCE_INVALID:readyMetadata");
  }
  if (row.detected_media_type !== row.declared_media_type || row.sha256.length !== 64 || !SHA256.test(row.sha256)) {
    throw new Error("FINANCE_ATTACHMENT_PERSISTENCE_INVALID:readyMetadata");
  }
  const size = asPositiveSafeInteger(row.actual_size_bytes, "actualSizeBytes");
  if (size !== asPositiveSafeInteger(row.declared_size_bytes, "declaredSizeBytes")) {
    throw new Error("FINANCE_ATTACHMENT_PERSISTENCE_INVALID:readyMetadata");
  }
  return { versionId: row.version_id, mediaType: row.detected_media_type, sizeBytes: size, sha256: row.sha256 };
};
const mapReady = (row: UploadingVersionRow, replay: boolean): FinanceAttachmentUploadResult => {
  const stored = toStored(row);
  if (row.ready_at === null) throw new Error("FINANCE_ATTACHMENT_PERSISTENCE_INVALID:readyAt");
  return {
    versionId: row.version_id,
    status: "READY",
    detectedMediaType: stored.mediaType,
    actualSizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    readyAt: new Date(row.ready_at).toISOString(),
    replay
  };
};

const versionSelect = `
  SELECT version.id::text AS version_id,
         version.version_no::text AS version_no,
         version.status,
         version.original_filename,
         version.declared_media_type,
         version.declared_size_bytes::text AS declared_size_bytes,
         version.expected_sha256,
         version.detected_media_type,
         version.actual_size_bytes::text AS actual_size_bytes,
         version.sha256,
         to_char(version.ready_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ready_at
    FROM finance_attachment_version version
    JOIN finance_attachment attachment ON attachment.id = version.finance_attachment_id`;

/** Completes an already-authorized DRAFT attachment reservation without changing any ledger state. */
export class PostgresFinanceAttachmentUploadService {
  public constructor(private readonly pool: PostgresPool, private readonly store: LocalAttachmentStore) {}

  public async upload(
    context: RoleContext,
    versionId: string,
    chunks: AsyncIterable<Uint8Array>,
    at: Date
  ): Promise<FinanceAttachmentUploadResult> {
    assertContext(context);
    if (!UUID.test(versionId) || !Number.isFinite(at.getTime())) throw new Error("INVALID_INPUT");
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      // Keep this order aligned with reservation: document before attachment version.
      const document = await client.query<{ id: string }>(
        `SELECT document.id::text AS id
           FROM finance_document document
           JOIN finance_attachment attachment ON attachment.finance_document_id = document.id
           JOIN finance_attachment_version version ON version.finance_attachment_id = attachment.id
          WHERE version.id=$1::uuid
            AND document.applicant_person_id=$2::uuid
            AND document.status='DRAFT'
          FOR UPDATE OF document`,
        [versionId, context.personId]
      );
      const documentRow = document.rows[0];
      if (documentRow === undefined) throw new Error("FINANCE_ATTACHMENT_NOT_FOUND");
      const result = await client.query<UploadingVersionRow>(
        `${versionSelect}
          WHERE version.id=$1::uuid AND attachment.finance_document_id=$2::uuid
          FOR UPDATE OF version`,
        [versionId, documentRow.id]
      );
      const version = result.rows[0];
      if (version === undefined) throw new Error("FINANCE_ATTACHMENT_NOT_FOUND");

      if (version.status === "FAILED") throw new Error("FINANCE_ATTACHMENT_FAILED");
      if (version.status === "READY") {
        const stored = toStored(version);
        try {
          await this.store.readVerified(stored);
        } catch {
          throw new Error("ATTACHMENT_INTEGRITY_FAILED");
        }
        await client.query("COMMIT");
        committed = true;
        return mapReady(version, true);
      }

      const upload: AttachmentUpload = {
        versionId: version.version_id,
        originalFilename: version.original_filename,
        declaredMediaType: version.declared_media_type,
        declaredSizeBytes: asPositiveSafeInteger(version.declared_size_bytes, "declaredSizeBytes"),
        ...(version.expected_sha256 === null ? {} : { expectedSha256: version.expected_sha256 })
      };
      const validate = async (bytes: Buffer): Promise<void> => {
        await validateAttachmentFormat(bytes, upload.declaredMediaType);
      };
      let stored: StoredAttachment;
      try {
        stored = await this.store.reconcilePublished(upload, validate);
      } catch (reconcileError) {
        if (errorCode(reconcileError) !== "ATTACHMENT_OBJECT_NOT_FOUND") {
          if (isRetryableValidationError(reconcileError)) throw reconcileError;
          if (errorCode(reconcileError) === "ATTACHMENT_INTEGRITY_FAILED") throw new Error("ATTACHMENT_INTEGRITY_FAILED");
          throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
        }
        try {
          stored = await this.store.put(upload, normalizedInputChunks(chunks), validate);
        } catch (putError) {
          if (isRetryableValidationError(putError)) throw putError;
          if (isRecoverableStorageError(putError)) throw new Error("ATTACHMENT_PUBLICATION_REQUIRES_RECONCILIATION");
          if (isTerminalUploadValidationError(putError)) {
            await this.markFailed(client, version, context, at, "UPLOAD_VALIDATION_FAILED");
            await client.query("COMMIT");
            committed = true;
            throw new Error("FINANCE_ATTACHMENT_UPLOAD_FAILED");
          }
          throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
        }
      }

      if (stored.mediaType !== upload.declaredMediaType || stored.sizeBytes !== upload.declaredSizeBytes
        || (upload.expectedSha256 !== undefined && stored.sha256 !== upload.expectedSha256)) {
        throw new Error("ATTACHMENT_INTEGRITY_FAILED");
      }
      const ready = await client.query<UploadingVersionRow>(
        `UPDATE finance_attachment_version
            SET status='READY',detected_media_type=$2,actual_size_bytes=$3::bigint,sha256=$4,ready_at=$5::timestamptz
          WHERE id=$1::uuid
          RETURNING id::text AS version_id,version_no::text AS version_no,status,original_filename,declared_media_type,
                    declared_size_bytes::text AS declared_size_bytes,expected_sha256,detected_media_type,
                    actual_size_bytes::text AS actual_size_bytes,sha256,
                    to_char(ready_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ready_at`,
        [version.version_id, stored.mediaType, stored.sizeBytes, stored.sha256, at.toISOString()]
      );
      const readyVersion = ready.rows[0];
      if (readyVersion === undefined) throw new Error("FINANCE_ATTACHMENT_COMPLETE_FAILED");
      await client.query(
        `INSERT INTO finance_attachment_event(finance_attachment_version_id,event_type,actor_person_id,result_version_no,created_at,error_code)
         VALUES ($1::uuid,'READY',$2::uuid,$3::integer,$4::timestamptz,NULL)`,
        [version.version_id, context.personId, version.version_no, at.toISOString()]
      );
      await client.query("COMMIT");
      committed = true;
      return mapReady(readyVersion, false);
    } catch (error) {
      if (!committed) await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.release();
    }
  }

  private async markFailed(
    client: Awaited<ReturnType<PostgresPool["connect"]>>,
    version: UploadingVersionRow,
    context: RoleContext,
    at: Date,
    failureCode: string
  ): Promise<void> {
    await client.query(
      `UPDATE finance_attachment_version
          SET status='FAILED',failure_code=$2
        WHERE id=$1::uuid`,
      [version.version_id, failureCode]
    );
    await client.query(
      `INSERT INTO finance_attachment_event(finance_attachment_version_id,event_type,actor_person_id,result_version_no,created_at,error_code)
       VALUES ($1::uuid,'FAILED',$2::uuid,$3::integer,$4::timestamptz,$5)`,
      [version.version_id, context.personId, version.version_no, at.toISOString(), failureCode]
    );
  }
}
