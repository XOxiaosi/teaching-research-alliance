import {
  BUSINESS_IDENTITIES,
  DUTIES,
  SYSTEM_AUTHORITIES,
  type PermissionScope,
  type PermissionSubject
} from "@teaching-research-alliance/contracts";
import type { RoleAssignmentRecord } from "@teaching-research-alliance/domain";
import type { LoginAccount } from "./session-service.js";

export type IdentityQueryResult<Row> = Readonly<{
  rows: readonly Row[];
  rowCount?: number;
}>;

export type IdentityQueryPool = Readonly<{
  query: <Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => Promise<IdentityQueryResult<Row>>;
}>;

type AccountRow = Readonly<{
  account_id: string;
  person_id: string;
  phone_normalized: string;
  password_hash: string;
  login_status: "ACTIVE" | "REVOKED";
}>;

type AssignmentRow = Readonly<{
  person_id: string;
  subject_code: string;
  scope_type: string;
  scope_id: string | null;
  valid_from: Date | string;
  valid_to: Date | string | null;
}>;

const SUBJECTS: readonly string[] = [...SYSTEM_AUTHORITIES, ...DUTIES, ...BUSINESS_IDENTITIES];
const SCOPES: readonly string[] = ["SELF", "REGION", "CAMPUS", "ASSOCIATED_TEACHERS", "MENTEES", "VENUE", "GLOBAL"];

const asDate = (value: Date | string): Date => {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("INVALID_ROLE_ASSIGNMENT_DATE");
  return date;
};

const mapAssignment = (row: AssignmentRow): RoleAssignmentRecord => {
  if (!SUBJECTS.includes(row.subject_code)) throw new Error("INVALID_ROLE_ASSIGNMENT_SUBJECT");
  if (!SCOPES.includes(row.scope_type)) throw new Error("INVALID_ROLE_ASSIGNMENT_SCOPE");
  const assignment = {
    personId: row.person_id,
    subject: row.subject_code as PermissionSubject,
    scope: row.scope_type as PermissionScope,
    validFrom: asDate(row.valid_from)
  };
  return {
    ...assignment,
    ...(row.scope_id === null ? {} : { scopeId: row.scope_id }),
    ...(row.valid_to === null ? {} : { validTo: asDate(row.valid_to) })
  } satisfies RoleAssignmentRecord;
};

export class PostgresIdentityRepository {
  public constructor(private readonly pool: IdentityQueryPool) {}

  public async findAccountByPhone(phoneNormalized: string): Promise<LoginAccount | undefined> {
    const result = await this.pool.query<AccountRow>(
      `SELECT id::text AS account_id,
              person_id::text AS person_id,
              phone_normalized,
              password_hash,
              login_status
         FROM user_account
        WHERE phone_normalized = $1`,
      [phoneNormalized]
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      accountId: row.account_id,
      personId: row.person_id,
      phoneNormalized: row.phone_normalized,
      credentialDigest: row.password_hash,
      status: row.login_status
    };
  }

  public async listRoleAssignments(personId: string): Promise<readonly RoleAssignmentRecord[]> {
    const result = await this.pool.query<AssignmentRow>(
      `SELECT person_id::text AS person_id,
              subject_code,
              scope_type,
              scope_id::text AS scope_id,
              valid_from,
              valid_to
         FROM role_assignment
        WHERE person_id = $1::uuid
        ORDER BY valid_from, id`,
      [personId]
    );
    return result.rows.map(mapAssignment);
  }

  public async revokeAccount(accountId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE user_account
          SET login_status = 'REVOKED', updated_at = now()
        WHERE id = $1::uuid`,
      [accountId]
    );
    if (result.rowCount !== 1) throw new Error("ACCOUNT_NOT_FOUND");
  }
}
