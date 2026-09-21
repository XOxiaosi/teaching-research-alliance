import { createHash } from "node:crypto";
import type { RoleContext } from "@teaching-research-alliance/contracts";
import type { PostgresPool } from "./postgres-ledger-repository.js";

export const FINANCE_DRAFT_KINDS = [
  "WITHDRAWAL",
  "REIMBURSEMENT",
  "EXTERNAL_PAYMENT",
  "REFUND",
  "SELF_PURCHASE"
] as const;

export type FinanceDraftKind = (typeof FINANCE_DRAFT_KINDS)[number];
export type FinanceDraftMetadata = Readonly<{
  id: string;
  kind: FinanceDraftKind;
  status: "DRAFT";
  version: number;
  createdAt: string;
  updatedAt: string;
}>;
export type FinanceDraftCreateResult = FinanceDraftMetadata & Readonly<{ replay: boolean }>;

type FinanceDocumentRow = Readonly<{
  id: string;
  kind: FinanceDraftKind;
  status: "DRAFT";
  version: string;
  created_at: string;
  updated_at: string;
}>;

type IdempotencyRow = Readonly<{
  request_hash: string;
  finance_document_id: string;
  result_document_version: string;
  created_at: string;
}>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedSubjects = ["TEACHING_TEACHER", "ACADEMIC_PLANNER", "PLANNING_MENTOR"] as const;

const assertContext = (context: RoleContext): void => {
  if (!allowedSubjects.includes(context.subject as (typeof allowedSubjects)[number])) throw new Error("FORBIDDEN_SCOPE");
};

const assertKind = (kind: string): kind is FinanceDraftKind =>
  (FINANCE_DRAFT_KINDS as readonly string[]).includes(kind);

const toMetadata = (row: FinanceDocumentRow, version = Number(row.version)): FinanceDraftMetadata => {
  if (!Number.isSafeInteger(version) || version < 1 || !assertKind(row.kind) || row.status !== "DRAFT") throw new Error("FINANCE_DRAFT_READ_MODEL_CORRUPT");
  return ({
  id: row.id,
  kind: row.kind,
  status: row.status,
  version,
  createdAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString()
  });
};

const financeDocumentSelect = `
  SELECT id::text AS id,
         kind,
         status,
         version::text AS version,
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
         to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM finance_document`;

export class PostgresFinanceDraftService {
  public constructor(private readonly pool: PostgresPool) {}

  public async create(
    context: RoleContext,
    draft: Readonly<{ kind: FinanceDraftKind }>,
    idempotencyKey: string,
    at: Date
  ): Promise<FinanceDraftCreateResult> {
    assertContext(context);
    if (!assertKind(draft.kind)
      || !idempotencyKey.trim()
      || idempotencyKey.length > 200
      || !Number.isFinite(at.getTime())) throw new Error("INVALID_INPUT");
    const requestHash = createHash("sha256").update(JSON.stringify({ kind: draft.kind })).digest("hex");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `finance-draft:${context.personId}:${idempotencyKey}`
      ]);
      const previous = await client.query<IdempotencyRow>(
        `SELECT request_hash,
                finance_document_id::text AS finance_document_id,
                result_document_version::text AS result_document_version,
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
           FROM finance_draft_idempotency
          WHERE actor_person_id = $1::uuid AND idempotency_key = $2
          FOR SHARE`,
        [context.personId, idempotencyKey]
      );
      const previousRow = previous.rows[0];
      if (previousRow !== undefined) {
        if (previousRow.request_hash !== requestHash) throw new Error("IDEMPOTENCY_REPLAY");
        const row: FinanceDocumentRow = {id:previousRow.finance_document_id,kind:draft.kind,status:"DRAFT",
          version:previousRow.result_document_version,created_at:previousRow.created_at,updated_at:previousRow.created_at};
        await client.query("COMMIT");
        return { ...toMetadata(row, Number(previousRow.result_document_version)), replay: true };
      }
      const created = await client.query<FinanceDocumentRow>(
        `INSERT INTO finance_document(applicant_person_id,kind,status,version,created_at,updated_at)
         VALUES ($1::uuid,$2,'DRAFT',1,$3::timestamptz,$3::timestamptz)
         RETURNING id::text AS id,
                   kind,
                   status,
                   version::text AS version,
                   to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
                   to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at`,
        [context.personId, draft.kind, at.toISOString()]
      );
      const document = created.rows[0];
      if (document === undefined) throw new Error("FINANCE_DRAFT_CREATE_FAILED");
      await client.query(
        `INSERT INTO finance_document_event(
           finance_document_id,event_type,actor_person_id,result_document_version,created_at
         ) VALUES ($1::uuid,'CREATED',$2::uuid,1,$3::timestamptz)`,
        [document.id, context.personId, at.toISOString()]
      );
      await client.query(
        `INSERT INTO finance_draft_idempotency(
           actor_person_id,idempotency_key,request_hash,finance_document_id,result_document_version,created_at
         ) VALUES ($1::uuid,$2,$3,$4::uuid,1,$5::timestamptz)`,
        [context.personId, idempotencyKey, requestHash, document.id, at.toISOString()]
      );
      await client.query("COMMIT");
      return { ...toMetadata(document), replay: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.release();
    }
  }

  public async getOwn(context: RoleContext, documentId: string): Promise<FinanceDraftMetadata> {
    assertContext(context);
    if (!UUID_PATTERN.test(documentId)) throw new Error("INVALID_INPUT");
    const client = await this.pool.connect();
    try {
      const result = await client.query<FinanceDocumentRow>(
        `${financeDocumentSelect}
          WHERE id = $1::uuid AND applicant_person_id = $2::uuid AND status='DRAFT'`,
        [documentId, context.personId]
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("FINANCE_DOCUMENT_NOT_FOUND");
      return toMetadata(row);
    } finally {
      await client.release();
    }
  }

  public async listOwn(context: RoleContext): Promise<readonly FinanceDraftMetadata[]> {
    assertContext(context);
    const client = await this.pool.connect();
    try {
      const result = await client.query<FinanceDocumentRow>(
        `${financeDocumentSelect}
          WHERE applicant_person_id = $1::uuid AND status='DRAFT'
          ORDER BY created_at DESC, id DESC`,
        [context.personId]
      );
      return result.rows.map((row) => toMetadata(row));
    } finally {
      await client.release();
    }
  }
}
