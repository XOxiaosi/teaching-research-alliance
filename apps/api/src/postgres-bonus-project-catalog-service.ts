import { createHash } from "node:crypto";
import type { RoleContext } from "@teaching-research-alliance/contracts";
import type {
  PostgresClient,
  PostgresPool,
} from "./postgres-ledger-repository.js";

export type BonusProjectNameSource = "MIGRATION_DEFAULT" | "ADMIN";

export type BonusProjectSummary = Readonly<{
  projectNo: number;
  nameVersionId: string;
  nameVersion: number;
  displayName: string;
  changedByPersonId: string | null;
  changeSource: BonusProjectNameSource;
  changedAt: string;
}>;

export type BonusProjectCatalog = Readonly<{
  projects: readonly BonusProjectSummary[];
}>;

export type BonusProjectRenameDraft = Readonly<{
  expectedVersion: number;
  displayName: string;
  reason: string;
}>;

export type BonusProjectRenameResult = BonusProjectSummary &
  Readonly<{
    replay: boolean;
  }>;

type ProjectRow = Readonly<{
  id: string;
  project_no: number;
  version_no: string;
  display_name: string;
  changed_by_person_id: string | null;
  change_source: string;
  created_at: string;
}>;

type IdempotencyRow = Readonly<{
  operation: string;
  request_hash: string;
  result_json: unknown;
}>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const fail = (code: string): never => {
  throw new Error(code);
};

const canonicalUuid = (value: string): string => {
  if (!UUID.test(value)) fail("INVALID_INPUT");
  return value.toLowerCase();
};

const validateProjectNo = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10)
    fail("INVALID_INPUT");
  return value;
};

const validateVersion = (value: number): number => {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value >= Number.MAX_SAFE_INTEGER
  )
    fail("INVALID_INPUT");
  return value;
};

const cleanText = (value: string, maximum: number): string => {
  const result = value.trim();
  if (!result || value.length > maximum || /[\x00-\x1f\x7f]/.test(value))
    fail("INVALID_INPUT");
  return result;
};

const validateAt = (at: Date): void => {
  if (!Number.isFinite(at.getTime())) fail("INVALID_INPUT");
};

const strictGlobalReader = (context: RoleContext): boolean =>
  (context.subject === "HEADQUARTERS_FINANCE" ||
    context.subject === "SYSTEM_ADMIN" ||
    context.subject === "SYSTEM_OWNER") &&
  context.scope === "GLOBAL" &&
  context.regionId === undefined &&
  context.campusId === undefined &&
  context.venueId === undefined;

const strictGlobalAdministrator = (context: RoleContext): boolean =>
  (context.subject === "SYSTEM_ADMIN" || context.subject === "SYSTEM_OWNER") &&
  context.scope === "GLOBAL" &&
  context.regionId === undefined &&
  context.campusId === undefined &&
  context.venueId === undefined;

const assertReader = (context: RoleContext): string => {
  if (!strictGlobalReader(context)) fail("FORBIDDEN_SCOPE");
  return canonicalUuid(context.personId);
};

const assertAdministrator = (context: RoleContext): string => {
  if (!strictGlobalAdministrator(context)) fail("FORBIDDEN_SCOPE");
  return canonicalUuid(context.personId);
};

const canonicalHash = (request: unknown): string =>
  createHash("sha256").update(JSON.stringify(request)).digest("hex");

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("BONUS_PROJECT_CATALOG_DATA_UNAVAILABLE");
  }
  return value as Record<string, unknown>;
};

const mapProject = (row: ProjectRow): BonusProjectSummary => {
  const version = Number(row.version_no);
  const date = new Date(row.created_at);
  if (
    !UUID.test(row.id) ||
    !Number.isSafeInteger(row.project_no) ||
    row.project_no < 1 ||
    row.project_no > 10 ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !row.display_name.trim() ||
    row.display_name.length > 200 ||
    (row.changed_by_person_id !== null &&
      !UUID.test(row.changed_by_person_id)) ||
    (row.change_source !== "MIGRATION_DEFAULT" &&
      row.change_source !== "ADMIN") ||
    !Number.isFinite(date.getTime())
  ) {
    fail("BONUS_PROJECT_CATALOG_DATA_UNAVAILABLE");
  }
  return {
    projectNo: row.project_no,
    nameVersionId: row.id,
    nameVersion: version,
    displayName: row.display_name,
    changedByPersonId: row.changed_by_person_id,
    changeSource: row.change_source as BonusProjectNameSource,
    changedAt: date.toISOString(),
  };
};

const replayProject = (value: unknown): BonusProjectRenameResult => {
  const row = asRecord(value);
  const project = mapProject({
    id: String(row.nameVersionId),
    project_no: Number(row.projectNo),
    version_no: String(row.nameVersion),
    display_name: String(row.displayName),
    changed_by_person_id:
      row.changedByPersonId === null ? null : String(row.changedByPersonId),
    change_source: String(row.changeSource),
    created_at: String(row.changedAt),
  });
  return { ...project, replay: true };
};

const currentProjectSelect = `
  SELECT version.id::text AS id,
         version.project_no,
         version.version_no::text AS version_no,
         version.display_name,
         version.changed_by_person_id::text AS changed_by_person_id,
         version.change_source,
         version.created_at::text AS created_at
    FROM bonus_project_name_version version`;

/** Persistent P18 project-name catalog. Names are versioned; old bonus rows never change. */
export class PostgresBonusProjectCatalogService {
  public constructor(private readonly pool: PostgresPool) {}

  public async list(context: RoleContext): Promise<BonusProjectCatalog> {
    assertReader(context);
    const client = await this.pool.connect();
    let open = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      open = true;
      const rows = (
        await client.query<ProjectRow>(`
        SELECT DISTINCT ON (version.project_no)
               version.id::text AS id,
               version.project_no,
               version.version_no::text AS version_no,
               version.display_name,
               version.changed_by_person_id::text AS changed_by_person_id,
               version.change_source,
               version.created_at::text AS created_at
          FROM bonus_project_name_version version
         ORDER BY version.project_no,version.version_no DESC
      `)
      ).rows;
      const projects = rows.map(mapProject);
      if (
        projects.length !== 10 ||
        projects.some((project, index) => project.projectNo !== index + 1)
      ) {
        fail("BONUS_PROJECT_CATALOG_DATA_UNAVAILABLE");
      }
      await client.query("COMMIT");
      open = false;
      return { projects };
    } catch (error) {
      if (open) await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.release();
    }
  }

  public async rename(
    context: RoleContext,
    projectNoInput: number,
    draft: BonusProjectRenameDraft,
    idempotencyKeyInput: string,
    at: Date,
  ): Promise<BonusProjectRenameResult> {
    const actorId = assertAdministrator(context);
    const projectNo = validateProjectNo(projectNoInput);
    const expectedVersion = validateVersion(draft.expectedVersion);
    const displayName = cleanText(draft.displayName, 200);
    const reason = cleanText(draft.reason, 1_000);
    const idempotencyKey = cleanText(idempotencyKeyInput, 200);
    validateAt(at);
    const request = { projectNo, expectedVersion, displayName, reason };
    const requestHash = canonicalHash([
      "bonus-project-catalog.rename.v1",
      request,
    ]);

    return this.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`bonus-project-catalog-command:${actorId}:${idempotencyKey}`],
      );
      const replay = await this.replay(
        client,
        actorId,
        idempotencyKey,
        requestHash,
      );
      if (replay !== undefined) return replay;
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`bonus-project-catalog:${projectNo}`],
      );

      const currentResult = await client.query<ProjectRow>(
        `${currentProjectSelect}
          WHERE version.project_no=$1
          ORDER BY version.version_no DESC
          LIMIT 1
          FOR UPDATE`,
        [projectNo],
      );
      const currentRow =
        currentResult.rows[0] ?? fail("BONUS_PROJECT_CATALOG_DATA_UNAVAILABLE");
      const current = mapProject(currentRow);
      if (current.nameVersion !== expectedVersion)
        fail("BONUS_PROJECT_VERSION_CONFLICT");

      let next = current;
      if (current.displayName !== displayName) {
        const inserted = await client.query<ProjectRow>(
          `
          INSERT INTO bonus_project_name_version(
            project_no,version_no,display_name,changed_by_person_id,actor_subject_code,actor_scope_type,
            change_source,reason,created_at
          ) VALUES($1,$2,$3,$4::uuid,$5,'GLOBAL','ADMIN',$6,$7::timestamptz)
          RETURNING id::text AS id,project_no,version_no::text AS version_no,display_name,
                    changed_by_person_id::text AS changed_by_person_id,change_source,created_at::text AS created_at
        `,
          [
            projectNo,
            current.nameVersion + 1,
            displayName,
            actorId,
            context.subject,
            reason,
            at.toISOString(),
          ],
        );
        const insertedRow =
          inserted.rows[0] ?? fail("BONUS_PROJECT_CATALOG_DATA_UNAVAILABLE");
        next = mapProject(insertedRow);
      }

      const result: BonusProjectRenameResult = { ...next, replay: false };
      await client.query(
        `
        INSERT INTO audit_event(
          actor_person_id,action_code,subject_type,subject_id,before_json,after_json,reason,created_at
        ) VALUES($1::uuid,'BONUS_PROJECT_NAME_SET','BONUS_PROJECT_NAME_VERSION',$2::uuid,$3::jsonb,$4::jsonb,$5,$6::timestamptz)
      `,
        [
          actorId,
          next.nameVersionId,
          JSON.stringify(current),
          JSON.stringify(next),
          reason,
          at.toISOString(),
        ],
      );
      await client.query(
        `
        INSERT INTO bonus_project_catalog_command_idempotency(
          actor_person_id,idempotency_key,operation,request_hash,result_json,created_at
        ) VALUES($1::uuid,$2,'RENAME',$3,$4::jsonb,$5::timestamptz)
      `,
        [
          actorId,
          idempotencyKey,
          requestHash,
          JSON.stringify(result),
          at.toISOString(),
        ],
      );
      return result;
    });
  }

  private async replay(
    client: PostgresClient,
    actorId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<BonusProjectRenameResult | undefined> {
    const result = await client.query<IdempotencyRow>(
      `
      SELECT operation,request_hash,result_json
        FROM bonus_project_catalog_command_idempotency
       WHERE actor_person_id=$1::uuid AND idempotency_key=$2
       FOR SHARE
    `,
      [actorId, idempotencyKey],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    if (row.operation !== "RENAME" || row.request_hash !== requestHash)
      fail("IDEMPOTENCY_REPLAY");
    return replayProject(row.result_json);
  }

  private async transaction<T>(
    work: (client: PostgresClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let open = false;
    try {
      await client.query("BEGIN");
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
  }
}
