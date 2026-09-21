import { createHash, randomUUID } from "node:crypto";
import type { RoleContext } from "@teaching-research-alliance/contracts";
import type { PostgresClient, PostgresPool } from "./postgres-ledger-repository.js";

export type CompanyFundStatus = "ACTIVE" | "INACTIVE";

export type CompanyFundSummary = Readonly<{
  id: string;
  accountId: string;
  accountCode: string;
  fundCode: string;
  displayName: string;
  status: CompanyFundStatus;
  version: number;
}>;

export type CompanyFundCommandResult = CompanyFundSummary & Readonly<{ replay: boolean }>;

export type CompanyFundAssignment = Readonly<{
  id: string;
  fundId: string;
  validFrom: string;
}>;

export type CompanyFundAssignmentResult = CompanyFundAssignment & Readonly<{
  previousAssignmentId: string | null;
  replay: boolean;
}>;

export type CompanyFundList = Readonly<{
  funds: readonly CompanyFundSummary[];
  currentAssignment: CompanyFundAssignment | null;
}>;

export type CompanyFundCreateDraft = Readonly<{
  fundCode: string;
  displayName: string;
  organizationUnitId?: string;
}>;

export type CompanyFundAssignmentDraft = Readonly<{
  fundId: string;
  expectedAssignmentId: string | null;
  reason: string;
}>;

export type CompanyFundStatusDraft = Readonly<{
  expectedVersion: number;
  status: CompanyFundStatus;
  reason: string;
}>;

type FundRow = Readonly<{
  id: string;
  account_id: string;
  account_code: string;
  fund_code: string;
  display_name: string;
  status: string;
  account_status: string;
  version: string;
}>;

type AssignmentRow = Readonly<{
  id: string;
  fund_id: string;
  valid_from: string;
}>;

type IdempotencyRow = Readonly<{
  operation: string;
  request_hash: string;
  result_json: unknown;
}>;

type OrganizationRow = Readonly<{ id: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FUND_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const STATUSES = ["ACTIVE", "INACTIVE"] as const;
const OPERATIONS = ["CREATE", "ASSIGN", "SET_STATUS"] as const;
const assignmentIdentity = ["HEADQUARTERS_FINANCE", "GLOBAL", "FINANCE_OPERATING_SOURCE"] as const;

const fail = (code: string): never => { throw new Error(code); };
const validAt = (at: Date): void => { if (!Number.isFinite(at.getTime())) fail("INVALID_INPUT"); };
const canonicalUuid = (value: string): string => {
  if (!UUID.test(value)) fail("INVALID_INPUT");
  return value.toLowerCase();
};
const validKey = (value: string): void => {
  if (!value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) fail("INVALID_INPUT");
};
const validReason = (value: string): void => {
  if (!value.trim() || value.length > 1_000 || /[\x00-\x1f\x7f]/.test(value)) fail("INVALID_INPUT");
};
const validDisplayName = (value: string): void => {
  if (!value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) fail("INVALID_INPUT");
};
const validVersion = (value: number): void => {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) fail("INVALID_INPUT");
};
const isStatus = (value: string): value is CompanyFundStatus => (STATUSES as readonly string[]).includes(value);
const strictGlobalAdministrator = (context: RoleContext): boolean =>
  (context.subject === "SYSTEM_ADMIN" || context.subject === "SYSTEM_OWNER")
  && context.scope === "GLOBAL"
  && context.regionId === undefined
  && context.campusId === undefined
  && context.venueId === undefined;
const assertAdministrator = (context: RoleContext): string => {
  if (!strictGlobalAdministrator(context)) fail("FORBIDDEN_SCOPE");
  return canonicalUuid(context.personId);
};
const canonicalHash = (operation: (typeof OPERATIONS)[number], request: unknown): string =>
  createHash("sha256").update(JSON.stringify({ operation, request })).digest("hex");
const toIso = (value: string): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail("COMPANY_FUND_CONFLICT");
  return date.toISOString();
};
const toVersion = (value: string): number => {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) fail("COMPANY_FUND_CONFLICT");
  return version;
};
const fundFromRow = (row: FundRow): CompanyFundSummary => {
  if (!UUID.test(row.id) || !UUID.test(row.account_id) || row.account_code !== `company:fund:${row.id}`
    || !FUND_CODE.test(row.fund_code)) fail("COMPANY_FUND_CONFLICT");
  if (!isStatus(row.status)) throw new Error("COMPANY_FUND_CONFLICT");
  if (row.account_status !== row.status) fail("COMPANY_FUND_CONFLICT");
  return {
    id: row.id,
    accountId: row.account_id,
    accountCode: row.account_code,
    fundCode: row.fund_code,
    displayName: row.display_name,
    status: row.status,
    version: toVersion(row.version)
  };
};
const assignmentFromRow = (row: AssignmentRow): CompanyFundAssignment => {
  if (!UUID.test(row.id) || !UUID.test(row.fund_id)) fail("COMPANY_FUND_ASSIGNMENT_CONFLICT");
  return { id: row.id, fundId: row.fund_id, validFrom: toIso(row.valid_from) };
};
const jsonRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("COMPANY_FUND_CONFLICT");
  return value as Record<string, unknown>;
};
const replayFundResult = (value: unknown): CompanyFundCommandResult => {
  const row = jsonRecord(value);
  const candidate: FundRow = {
    id: String(row.id), account_id: String(row.accountId), account_code: String(row.accountCode),
    fund_code: String(row.fundCode), display_name: String(row.displayName), status: String(row.status),
    account_status: String(row.status), version: String(row.version)
  };
  return { ...fundFromRow(candidate), replay: true };
};
const replayAssignmentResult = (value: unknown): CompanyFundAssignmentResult => {
  const row = jsonRecord(value);
  const assignment = assignmentFromRow({ id: String(row.id), fund_id: String(row.fundId), valid_from: String(row.validFrom) });
  const previous = row.previousAssignmentId;
  if (previous !== null && (typeof previous !== "string" || !UUID.test(previous))) fail("COMPANY_FUND_CONFLICT");
  return { ...assignment, previousAssignmentId: previous as string | null, replay: true };
};

const fundSelect = `
  SELECT fund.id::text AS id,
         account.id::text AS account_id,
         account.account_code,
         fund.fund_code,
         fund.display_name,
         fund.status,
         account.status AS account_status,
         fund.version::text AS version
    FROM company_finance_fund fund
    JOIN settlement_account account ON account.owner_type='COMPANY' AND account.owner_id=fund.id`;

export class PostgresCompanyFundService {
  public constructor(private readonly pool: PostgresPool) {}

  public async create(
    context: RoleContext,
    draft: CompanyFundCreateDraft,
    idempotencyKey: string,
    at: Date
  ): Promise<CompanyFundCommandResult> {
    const actorId = assertAdministrator(context);
    validAt(at);
    validKey(idempotencyKey);
    if (!FUND_CODE.test(draft.fundCode)) fail("INVALID_INPUT");
    validDisplayName(draft.displayName);
    const displayName = draft.displayName.trim();
    const organizationUnitId = draft.organizationUnitId === undefined ? null : canonicalUuid(draft.organizationUnitId);
    const request = { fundCode: draft.fundCode, displayName, organizationUnitId };
    const requestHash = canonicalHash("CREATE", request);
    return this.transaction(async (client) => {
      await this.commandLock(client, actorId, idempotencyKey);
      await this.globalConfigLock(client);
      const replay = await this.replay(client, actorId, idempotencyKey, "CREATE", requestHash, replayFundResult);
      if (replay !== undefined) return replay;

      const duplicate = await client.query<Readonly<{ id: string }>>(
        `SELECT id::text AS id FROM company_finance_fund WHERE fund_code=$1 FOR SHARE`,
        [draft.fundCode]
      );
      if (duplicate.rows[0] !== undefined) fail("COMPANY_FUND_CONFLICT");
      if (organizationUnitId !== null) {
        const organization = await client.query<OrganizationRow>(
          `SELECT id::text AS id FROM organization_unit WHERE id=$1::uuid AND unit_type='HEADQUARTERS' FOR SHARE`,
          [organizationUnitId]
        );
        if (organization.rows[0] === undefined) fail("COMPANY_FUND_CONFLICT");
      }

      const fundId = randomUUID();
      const accountId = randomUUID();
      const accountCode = `company:fund:${fundId}`;
      await client.query(
        `INSERT INTO company_finance_fund(
           id,kind,fund_code,display_name,organization_unit_id,status,version,created_by_person_id,created_at,updated_at
         ) VALUES ($1::uuid,'HEADQUARTERS_FINANCE_OPERATING',$2,$3,$4::uuid,'ACTIVE',1,$5::uuid,$6::timestamptz,$6::timestamptz)`,
        [fundId, draft.fundCode, displayName, organizationUnitId, actorId, at.toISOString()]
      );
      await client.query(
        `INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status,created_at)
         VALUES ($1::uuid,'COMPANY',$2::uuid,$3,'ACTIVE',$4::timestamptz)`,
        [accountId, fundId, accountCode, at.toISOString()]
      );
      const created = await client.query<FundRow>(`${fundSelect} WHERE fund.id=$1::uuid`, [fundId]);
      const row = created.rows[0];
      if (row === undefined) throw new Error("COMPANY_FUND_CONFLICT");
      const result = fundFromRow(row);
      await client.query(
        `INSERT INTO account_balance_projection(account_id,balance_cents,updated_at)
         VALUES ($1::uuid,0,$2::timestamptz)`,
        [result.accountId, at.toISOString()]
      );
      await this.audit(client, actorId, "COMPANY_FUND_CREATED", result.id, null, result, "SYSTEM_CREATE", at);
      await this.saveCommand(client, actorId, idempotencyKey, "CREATE", requestHash, result, at);
      return { ...result, replay: false };
    });
  }

  public async list(context: RoleContext, at: Date): Promise<CompanyFundList> {
    assertAdministrator(context);
    validAt(at);
    const client = await this.pool.connect();
    let open = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      open = true;
      const funds = (await client.query<FundRow>(`${fundSelect} ORDER BY fund.fund_code,fund.id`)).rows.map(fundFromRow);
      const assignment = await client.query<AssignmentRow>(
        `SELECT id::text AS id,fund_id::text AS fund_id,
                to_char(valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS valid_from
           FROM company_finance_fund_assignment
          WHERE duty_subject=$1 AND scope_type=$2 AND responsibility_code=$3
            AND valid_from <= $4::timestamptz AND (valid_to IS NULL OR valid_to > $4::timestamptz)
          ORDER BY valid_from DESC,id DESC
          LIMIT 1`,
        [...assignmentIdentity, at.toISOString()]
      );
      const result = { funds, currentAssignment: assignment.rows[0] === undefined ? null : assignmentFromRow(assignment.rows[0]) };
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

  public async assign(
    context: RoleContext,
    draft: CompanyFundAssignmentDraft,
    idempotencyKey: string,
    at: Date
  ): Promise<CompanyFundAssignmentResult> {
    const actorId = assertAdministrator(context);
    validAt(at);
    validKey(idempotencyKey);
    const fundId = canonicalUuid(draft.fundId);
    const expectedAssignmentId = draft.expectedAssignmentId === null ? null : canonicalUuid(draft.expectedAssignmentId);
    validReason(draft.reason);
    const request = { fundId, expectedAssignmentId, reason: draft.reason.trim() };
    const requestHash = canonicalHash("ASSIGN", request);
    return this.transaction(async (client) => {
      await this.commandLock(client, actorId, idempotencyKey);
      await this.globalConfigLock(client);
      const replay = await this.replay(client, actorId, idempotencyKey, "ASSIGN", requestHash, replayAssignmentResult);
      if (replay !== undefined) return replay;

      const current = await client.query<AssignmentRow>(
        `SELECT id::text AS id,fund_id::text AS fund_id,
                to_char(valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS valid_from
           FROM company_finance_fund_assignment
          WHERE duty_subject=$1 AND scope_type=$2 AND responsibility_code=$3 AND valid_to IS NULL
          ORDER BY valid_from DESC,id DESC
          LIMIT 1 FOR UPDATE`,
        assignmentIdentity
      );
      const currentAssignment = current.rows[0] === undefined ? null : assignmentFromRow(current.rows[0]);
      if ((currentAssignment?.id ?? null) !== expectedAssignmentId) fail("COMPANY_FUND_ASSIGNMENT_CONFLICT");

      const targetFund = fundFromRow(await this.lockFundAndAccount(client, fundId));
      if (targetFund.status !== "ACTIVE") fail("COMPANY_FUND_INACTIVE");

      if (currentAssignment?.fundId === fundId) {
        const noChange: CompanyFundAssignmentResult = { ...currentAssignment, previousAssignmentId: null, replay: false };
        await this.audit(client, actorId, "COMPANY_FUND_ASSIGNMENT_CONFIRMED", fundId, currentAssignment, currentAssignment, draft.reason.trim(), at);
        await this.saveCommand(client, actorId, idempotencyKey, "ASSIGN", requestHash, noChange, at);
        return noChange;
      }

      if (currentAssignment !== null && new Date(currentAssignment.validFrom).getTime() >= at.getTime()) {
        fail("COMPANY_FUND_ASSIGNMENT_CONFLICT");
      }
      if (currentAssignment !== null) {
        await client.query(
          `UPDATE company_finance_fund_assignment
              SET valid_to=$2::timestamptz
            WHERE id=$1::uuid AND valid_to IS NULL`,
          [currentAssignment.id, at.toISOString()]
        );
      }
      const id = randomUUID();
      const inserted = await client.query<AssignmentRow>(
        `INSERT INTO company_finance_fund_assignment(
           id,fund_id,duty_subject,scope_type,scope_id,responsibility_code,valid_from,valid_to,created_by_person_id,created_at
         ) VALUES ($1::uuid,$2::uuid,$3,$4,NULL,$5,$6::timestamptz,NULL,$7::uuid,$6::timestamptz)
         RETURNING id::text AS id,fund_id::text AS fund_id,
                   to_char(valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS valid_from`,
        [id, fundId, ...assignmentIdentity, at.toISOString(), actorId]
      );
      const insertedRow = inserted.rows[0];
      if (insertedRow === undefined) throw new Error("COMPANY_FUND_ASSIGNMENT_CONFLICT");
      const assignment = assignmentFromRow(insertedRow);
      const result: CompanyFundAssignmentResult = {
        ...assignment,
        previousAssignmentId: currentAssignment?.id ?? null,
        replay: false
      };
      await this.audit(client, actorId, "COMPANY_FUND_ASSIGNED", fundId, currentAssignment, assignment, draft.reason.trim(), at);
      await this.saveCommand(client, actorId, idempotencyKey, "ASSIGN", requestHash, result, at);
      return result;
    });
  }

  public async setStatus(
    context: RoleContext,
    fundIdInput: string,
    draft: CompanyFundStatusDraft,
    idempotencyKey: string,
    at: Date
  ): Promise<CompanyFundCommandResult> {
    const actorId = assertAdministrator(context);
    validAt(at);
    validKey(idempotencyKey);
    const fundId = canonicalUuid(fundIdInput);
    validVersion(draft.expectedVersion);
    if (!isStatus(draft.status)) fail("INVALID_INPUT");
    validReason(draft.reason);
    const request = { fundId, expectedVersion: draft.expectedVersion, status: draft.status, reason: draft.reason.trim() };
    const requestHash = canonicalHash("SET_STATUS", request);
    return this.transaction(async (client) => {
      await this.commandLock(client, actorId, idempotencyKey);
      await this.globalConfigLock(client);
      const replay = await this.replay(client, actorId, idempotencyKey, "SET_STATUS", requestHash, replayFundResult);
      if (replay !== undefined) return replay;
      const before = fundFromRow(await this.lockFundAndAccount(client, fundId));
      if (before.version !== draft.expectedVersion) fail("VERSION_CONFLICT");
      let after = before;
      if (before.status !== draft.status) {
        await client.query(
          `UPDATE company_finance_fund
              SET status=$2,version=version+1,updated_at=$3::timestamptz
            WHERE id=$1::uuid`,
          [fundId, draft.status, at.toISOString()]
        );
      }
      const account = await client.query(
        `UPDATE settlement_account SET status=$2 WHERE id=$1::uuid AND owner_type='COMPANY'`,
        [after.accountId, draft.status]
      );
      if (account.rowCount !== 1) fail("COMPANY_FUND_CONFLICT");
      after = fundFromRow(await this.readFund(client, fundId));
      await this.audit(client, actorId, "COMPANY_FUND_STATUS_SET", before.id, before, after, draft.reason.trim(), at);
      await this.saveCommand(client, actorId, idempotencyKey, "SET_STATUS", requestHash, after, at);
      return { ...after, replay: false };
    });
  }

  private async transaction<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.release();
    }
  }

  private async commandLock(client: PostgresClient, actorId: string, idempotencyKey: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`company-fund-command:${actorId}:${idempotencyKey}`]);
  }

  private async globalConfigLock(client: PostgresClient): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('company-fund-global-config',0))");
  }

  /** Config writers always lock the fund before its COMPANY account. */
  private async lockFundAndAccount(client: PostgresClient, fundId: string): Promise<FundRow> {
    const fund = await client.query<Readonly<{ id: string }>>(
      "SELECT id::text AS id FROM company_finance_fund WHERE id=$1::uuid FOR UPDATE",
      [fundId]
    );
    if (fund.rows[0] === undefined) throw new Error("COMPANY_FUND_NOT_FOUND");
    const account = await client.query<Readonly<{ id: string }>>(
      `SELECT id::text AS id FROM settlement_account
        WHERE owner_type='COMPANY' AND owner_id=$1::uuid FOR UPDATE`,
      [fundId]
    );
    if (account.rows[0] === undefined) throw new Error("COMPANY_FUND_CONFLICT");
    return this.readFund(client, fundId);
  }

  private async readFund(client: PostgresClient, fundId: string): Promise<FundRow> {
    const result = await client.query<FundRow>(`${fundSelect} WHERE fund.id=$1::uuid`, [fundId]);
    const row = result.rows[0];
    if (row === undefined) throw new Error("COMPANY_FUND_CONFLICT");
    return row;
  }

  private async replay<T>(
    client: PostgresClient,
    actorId: string,
    idempotencyKey: string,
    operation: (typeof OPERATIONS)[number],
    requestHash: string,
    map: (result: unknown) => T
  ): Promise<T | undefined> {
    const result = await client.query<IdempotencyRow>(
      `SELECT operation,request_hash,result_json
         FROM company_finance_fund_command_idempotency
        WHERE actor_person_id=$1::uuid AND idempotency_key=$2
        FOR SHARE`,
      [actorId, idempotencyKey]
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    if (row.operation !== operation || row.request_hash !== requestHash) fail("IDEMPOTENCY_REPLAY");
    return map(row.result_json);
  }

  private async saveCommand(
    client: PostgresClient,
    actorId: string,
    idempotencyKey: string,
    operation: (typeof OPERATIONS)[number],
    requestHash: string,
    result: object,
    at: Date
  ): Promise<void> {
    await client.query(
      `INSERT INTO company_finance_fund_command_idempotency(
         actor_person_id,idempotency_key,operation,request_hash,result_json,created_at
       ) VALUES ($1::uuid,$2,$3,$4,$5::jsonb,$6::timestamptz)`,
      [actorId, idempotencyKey, operation, requestHash, JSON.stringify(result), at.toISOString()]
    );
  }

  private async audit(
    client: PostgresClient,
    actorId: string,
    action: string,
    fundId: string,
    before: object | null,
    after: object,
    reason: string,
    at: Date
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_event(actor_person_id,action_code,subject_type,subject_id,before_json,after_json,reason,created_at)
       VALUES ($1::uuid,$2,'COMPANY_FINANCE_FUND',$3::uuid,$4::jsonb,$5::jsonb,$6,$7::timestamptz)`,
      [actorId, action, fundId, before === null ? null : JSON.stringify(before), JSON.stringify(after), reason, at.toISOString()]
    );
  }
}
