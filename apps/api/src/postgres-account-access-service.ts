import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PermissionScope, PermissionSubject, RoleContext } from "@teaching-research-alliance/contracts";
import {
  assertIdempotencyKey,
  assertPasswordInput,
  normalizeLegalName,
  normalizeNickname,
  normalizePhone,
  normalizeResetReason,
} from "./identity-input.js";
import { hashPassword, verifyPassword } from "./password.js";
import type {
  PostgresClient,
  PostgresPool,
} from "./postgres-ledger-repository.js";
import type { SessionView } from "./session-service.js";

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MANAGED_SUBJECTS: readonly PermissionSubject[] = [
  "SYSTEM_ADMIN",
  "HEADQUARTERS_FINANCE", "REGION_FINANCE", "CAMPUS_PRINCIPAL", "GROUP_LEADER",
  "TEACHING_MENTOR", "PLANNING_MENTOR",
];

/** Owners are visible in the read-only directory, but never valid appointment targets. */
const DIRECTORY_SUBJECTS: readonly PermissionSubject[] = [
  "SYSTEM_OWNER", "TEACHER", "TEACHING_TEACHER", "ACADEMIC_PLANNER", "VENUE_OWNER",
  ...MANAGED_SUBJECTS,
];

const expectedScope = (subject: PermissionSubject): PermissionScope | undefined => {
  switch (subject) {
    case "SYSTEM_ADMIN": case "HEADQUARTERS_FINANCE": return "GLOBAL";
    case "TEACHER": case "TEACHING_TEACHER": case "ACADEMIC_PLANNER": case "PLANNING_MENTOR": return "SELF";
    case "REGION_FINANCE": return "REGION";
    case "CAMPUS_PRINCIPAL": return "CAMPUS";
    case "GROUP_LEADER": return "ASSOCIATED_TEACHERS";
    case "TEACHING_MENTOR": return "MENTEES";
    case "VENUE_OWNER": return "VENUE";
    default: return undefined;
  }
};

const normalizedTimestamp = (input: string): string => {
  const value = new Date(input);
  if (!Number.isFinite(value.getTime())) throw new Error("INVALID_INPUT");
  return value.toISOString();
};

const managedSubject = (value: string): value is PermissionSubject =>
  MANAGED_SUBJECTS.includes(value as PermissionSubject);

const directorySubject = (value: string): value is PermissionSubject =>
  DIRECTORY_SUBJECTS.includes(value as PermissionSubject);

const managedScope = (value: string): value is PermissionScope =>
  ["GLOBAL", "REGION", "CAMPUS", "ASSOCIATED_TEACHERS", "MENTEES", "VENUE", "SELF"].includes(value);

export type RegistrationDraft = Readonly<{
  nickname: string;
  legalName: string;
  phoneNormalized: string;
  password: string;
}>;

export type RegistrationResult = Readonly<{
  nickname: string;
  session: SessionView;
}>;

export type AccountDirectoryItem = Readonly<{
  accountId: string;
  personId: string;
  nickname: string;
  phoneNormalized: string;
  loginStatus: "ACTIVE" | "REVOKED";
  personStatus: "ACTIVE" | "INACTIVE";
  activeSystemAuthorities: readonly ("SYSTEM_OWNER" | "SYSTEM_ADMIN")[];
}>;

export type PasswordResetResult = Readonly<{
  accountId: string;
  personId: string;
  authVersion: string;
  resetAt: string;
  replay: boolean;
}>;

export type ManagedRoleAssignment = Readonly<{
  assignmentId: string;
  subject: PermissionSubject;
  scope: PermissionScope;
  scopeId?: string;
  validFrom: string;
  validTo?: string;
  reason: string | null;
  createdByPersonId: string;
}>;

export type PersonResponsibilityDirectoryItem = Readonly<{
  accountId: string;
  personId: string;
  nickname: string;
  legalName: string;
  profileVersion: string;
  phoneNormalized: string;
  loginStatus: "ACTIVE" | "REVOKED";
  personStatus: "ACTIVE" | "INACTIVE";
  responsibilities: readonly ManagedRoleAssignment[];
}>;

export type RoleAssignmentDraft = Readonly<{
  subject: PermissionSubject;
  scope: PermissionScope;
  scopeId?: string;
  validFrom: string;
  validTo?: string;
  reason: string;
}>;

export type RoleAssignmentChangeResult = Readonly<{
  personId: string;
  assignment: ManagedRoleAssignment;
  authVersion: string;
  replay: boolean;
}>;

export type PersonStatusChangeResult = Readonly<{
  personId: string;
  personStatus: "ACTIVE" | "INACTIVE";
  authVersion: string;
  replay: boolean;
}>;

export type PersonProfileChangeResult = Readonly<{
  personId: string;
  nickname: string;
  legalName: string;
  profileVersion: string;
  changedAt: string;
  replay: boolean;
}>;

type AccountRow = Readonly<{
  account_id: string;
  person_id: string;
  login_status: "ACTIVE" | "REVOKED";
  person_status: "ACTIVE" | "INACTIVE";
  auth_version: string;
}>;

type ResetCommandRow = Readonly<{
  target_account_id: string;
  reason: string;
  password_hash: string;
  result_auth_version: string;
  created_at: string;
}>;

type DirectoryRow = Readonly<{
  account_id: string;
  person_id: string;
  nickname: string;
  phone_normalized: string;
  login_status: "ACTIVE" | "REVOKED";
  person_status: "ACTIVE" | "INACTIVE";
  active_system_authorities: readonly string[] | null;
  legal_name: string;
  profile_version: string;
}>;

type ResponsibilityRow = Readonly<{
  assignment_id: string; person_id: string; subject_code: string; scope_type: string;
  scope_id: string | null; valid_from: string; valid_to: string | null;
  reason: string | null; created_by_person_id: string;
}>;

type ResponsibilityCommandRow = Readonly<{
  command_kind: "ASSIGN" | "REVOKE" | "PERSON_STATUS"; target_person_id: string;
  role_assignment_id: string | null; subject_code: string | null; scope_type: string | null;
  scope_id: string | null; valid_from: string | null; valid_to: string | null;
  next_person_status: "ACTIVE" | "INACTIVE" | null; reason: string; result_auth_version: string;
}>;

type PgError = Readonly<{ code?: unknown; constraint?: unknown }>;

const tokenHash = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

const strictGlobalAuthority = (
  context: RoleContext,
): "SYSTEM_OWNER" | "SYSTEM_ADMIN" => {
  if (
    (context.subject !== "SYSTEM_OWNER" && context.subject !== "SYSTEM_ADMIN") ||
    context.scope !== "GLOBAL" ||
    context.regionId !== undefined ||
    context.campusId !== undefined ||
    context.venueId !== undefined
  ) {
    throw new Error("FORBIDDEN_SCOPE");
  }
  return context.subject;
};

const validAt = (at: Date): string => {
  if (!Number.isFinite(at.getTime())) throw new Error("INVALID_INPUT");
  return at.toISOString();
};

const registrationConflict = (error: unknown): never => {
  const candidate = error as PgError;
  if (candidate.code === "23505") {
    if (candidate.constraint === "person_nickname_key") {
      throw new Error("REGISTRATION_NICKNAME_CONFLICT");
    }
    if (candidate.constraint === "user_account_phone_normalized_key") {
      throw new Error("REGISTRATION_PHONE_CONFLICT");
    }
  }
  throw error;
};

export class PostgresAccountAccessService {
  private readonly sessionTtlMs: number;

  public constructor(
    private readonly pool: PostgresPool,
    options: Readonly<{ sessionTtlMs?: number }> = {},
  ) {
    const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs <= 0) {
      throw new Error("SESSION_TTL_INVALID");
    }
    this.sessionTtlMs = sessionTtlMs;
  }

  private async transaction<T>(
    work: (client: PostgresClient) => Promise<T>,
  ): Promise<T> {
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

  private async assertCurrentAuthority(
    client: PostgresClient,
    context: RoleContext,
    at: string,
  ): Promise<"SYSTEM_OWNER" | "SYSTEM_ADMIN"> {
    const subject = strictGlobalAuthority(context);
    const result = await client.query(
      `SELECT authority.id
         FROM role_assignment authority
         JOIN person actor_person ON actor_person.id=authority.person_id AND actor_person.status='ACTIVE'
         JOIN user_account actor_account ON actor_account.person_id=authority.person_id AND actor_account.login_status='ACTIVE'
        WHERE authority.person_id = $1::uuid
          AND authority.subject_code = $2
          AND authority.scope_type = 'GLOBAL'
          AND authority.scope_id IS NULL
          AND authority.valid_from <= $3::timestamptz
          AND (authority.valid_to IS NULL OR $3::timestamptz < authority.valid_to)
        LIMIT 2
        FOR SHARE OF authority,actor_person,actor_account`,
      [context.personId, subject, at],
    );
    if (result.rows.length !== 1) throw new Error("FORBIDDEN_SCOPE");
    return subject;
  }

  public async register(
    draft: RegistrationDraft,
    at: Date,
  ): Promise<RegistrationResult> {
    const atIso = validAt(at);
    const nickname = normalizeNickname(draft.nickname);
    const legalName = normalizeLegalName(draft.legalName);
    const phoneNormalized = normalizePhone(draft.phoneNormalized);
    assertPasswordInput(draft.password);
    const passwordHash = await hashPassword(draft.password);
    const personId = randomUUID();
    const accountId = randomUUID();
    const settlementAccountId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(at.getTime() + this.sessionTtlMs);
    if (!Number.isFinite(expiresAt.getTime())) throw new Error("SESSION_TTL_INVALID");

    try {
      return await this.transaction(async (client) => {
        await client.query(
          `INSERT INTO person(id,nickname,legal_name,status,created_at,updated_at)
           VALUES($1::uuid,$2,$3,'ACTIVE',$4::timestamptz,$4::timestamptz)`,
          [personId, nickname, legalName, atIso],
        );
        const account = await client.query<{ auth_version: string }>(
          `INSERT INTO user_account(
             id,person_id,phone_normalized,password_hash,login_status,created_at,updated_at
           ) VALUES($1::uuid,$2::uuid,$3,$4,'ACTIVE',$5::timestamptz,$5::timestamptz)
           RETURNING auth_version::text AS auth_version`,
          [accountId, personId, phoneNormalized, passwordHash, atIso],
        );
        const authVersion = account.rows[0]?.auth_version;
        if (authVersion === undefined) throw new Error("ACCOUNT_CREATE_FAILED");
        await client.query(
          `INSERT INTO settlement_account(
             id,owner_type,owner_id,account_code,status,created_at
           ) VALUES($1::uuid,'PERSON',$2::uuid,$3,'ACTIVE',$4::timestamptz)`,
          [settlementAccountId, personId, `person:${personId}`, atIso],
        );
        await client.query(
          `INSERT INTO account_balance_projection(account_id,balance_cents,updated_at)
           VALUES($1::uuid,0,$2::timestamptz)`,
          [settlementAccountId, atIso],
        );
        await client.query(
          `INSERT INTO role_assignment(
             person_id,subject_code,scope_type,scope_id,valid_from,created_by,created_at
           ) VALUES($1::uuid,'TEACHER','SELF',NULL,$2::timestamptz,$1::uuid,$2::timestamptz)`,
          [personId, atIso],
        );
        await client.query(
          `INSERT INTO audit_event(
             actor_person_id,action_code,subject_type,subject_id,after_json,reason,created_at
           ) VALUES(
             $1::uuid,'ACCOUNT_REGISTERED','USER_ACCOUNT',$2::uuid,
             $3::jsonb,'SELF_REGISTRATION',$4::timestamptz
           )`,
          [
            personId,
            accountId,
            JSON.stringify({ baseSubject: "TEACHER", scope: "SELF" }),
            atIso,
          ],
        );
        await client.query(
          `INSERT INTO user_session(
             token_hash,account_id,auth_version,current_subject,expires_at,created_at
           ) VALUES($1,$2::uuid,$3::bigint,'TEACHER',$4::timestamptz,$5::timestamptz)`,
          [
            tokenHash(token),
            accountId,
            authVersion,
            expiresAt.toISOString(),
            atIso,
          ],
        );
        return {
          nickname,
          session: {
            sessionId: token,
            accountId,
            personId,
            roleContexts: [
              { subject: "TEACHER", personId, scope: "SELF" },
            ],
            currentRoleContext: {
              subject: "TEACHER",
              personId,
              scope: "SELF",
            },
          },
        };
      });
    } catch (error) {
      return registrationConflict(error);
    }
  }

  public async listAccounts(
    context: RoleContext,
    at: Date,
  ): Promise<readonly AccountDirectoryItem[]> {
    const atIso = validAt(at);
    return this.transaction(async (client) => {
      await this.assertCurrentAuthority(client, context, atIso);
      const result = await client.query<DirectoryRow>(
        `SELECT account.id::text AS account_id,
                person.id::text AS person_id,
                person.nickname,
                account.phone_normalized,
                account.login_status,
                person.status AS person_status,
                COALESCE(array_agg(DISTINCT authority.subject_code)
                  FILTER (WHERE authority.subject_code IS NOT NULL), '{}') AS active_system_authorities
           FROM user_account account
           JOIN person ON person.id = account.person_id
           LEFT JOIN role_assignment authority
             ON authority.person_id = person.id
            AND authority.subject_code IN ('SYSTEM_OWNER','SYSTEM_ADMIN')
            AND authority.scope_type = 'GLOBAL'
            AND authority.scope_id IS NULL
            AND authority.valid_from <= $1::timestamptz
            AND (authority.valid_to IS NULL OR $1::timestamptz < authority.valid_to)
          GROUP BY account.id, person.id
          ORDER BY person.nickname, person.id`,
        [atIso],
      );
      return result.rows.map((row) => ({
        accountId: row.account_id,
        personId: row.person_id,
        nickname: row.nickname,
        phoneNormalized: row.phone_normalized,
        loginStatus: row.login_status,
        personStatus: row.person_status,
        activeSystemAuthorities: (row.active_system_authorities ?? []).filter(
          (subject): subject is "SYSTEM_OWNER" | "SYSTEM_ADMIN" =>
            subject === "SYSTEM_OWNER" || subject === "SYSTEM_ADMIN",
        ),
      }));
    });
  }

  public async resetPassword(
    context: RoleContext,
    accountIdInput: string,
    newPassword: string,
    reasonInput: string,
    idempotencyKeyInput: string,
    at: Date,
  ): Promise<PasswordResetResult> {
    const atIso = validAt(at);
    const accountId = accountIdInput.toLowerCase();
    if (!UUID_PATTERN.test(accountId)) throw new Error("INVALID_INPUT");
    assertPasswordInput(newPassword);
    const reason = normalizeResetReason(reasonInput);
    const idempotencyKey = assertIdempotencyKey(idempotencyKeyInput);

    return this.transaction(async (client) => {
      const subject = await this.assertCurrentAuthority(client, context, atIso);
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`account-password-reset:${context.personId}:${idempotencyKey}`],
      );
      const existing = await client.query<ResetCommandRow>(
        `SELECT target_account_id::text AS target_account_id,
                reason,
                password_hash,
                result_auth_version::text AS result_auth_version,
                to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
           FROM auth_password_reset_command
          WHERE actor_person_id=$1::uuid AND idempotency_key=$2
          FOR SHARE`,
        [context.personId, idempotencyKey],
      );
      const replay = existing.rows[0];
      if (replay !== undefined) {
        if (
          replay.target_account_id !== accountId ||
          replay.reason !== reason ||
          !(await verifyPassword(newPassword, replay.password_hash))
        ) {
          throw new Error("IDEMPOTENCY_REPLAY");
        }
        const target = await client.query<{ person_id: string }>(
          "SELECT person_id::text AS person_id FROM user_account WHERE id=$1::uuid",
          [accountId],
        );
        const personId = target.rows[0]?.person_id;
        if (personId === undefined) throw new Error("ACCOUNT_NOT_FOUND");
        return {
          accountId,
          personId,
          authVersion: replay.result_auth_version,
          resetAt: new Date(replay.created_at).toISOString(),
          replay: true,
        };
      }

      const targetResult = await client.query<AccountRow>(
        `SELECT account.id::text AS account_id,
                account.person_id::text AS person_id,
                account.login_status,
                person.status AS person_status,
                account.auth_version::text AS auth_version
           FROM user_account account
           JOIN person ON person.id=account.person_id
          WHERE account.id=$1::uuid
          FOR UPDATE OF account, person`,
        [accountId],
      );
      const target = targetResult.rows[0];
      if (target === undefined) throw new Error("ACCOUNT_NOT_FOUND");
      if (target.login_status !== "ACTIVE" || target.person_status !== "ACTIVE") {
        throw new Error("FORBIDDEN_SCOPE");
      }
      if (subject === "SYSTEM_ADMIN") {
        const protectedAuthority = await client.query(
          `SELECT id
             FROM role_assignment
            WHERE person_id=$1::uuid
              AND subject_code IN ('SYSTEM_OWNER','SYSTEM_ADMIN')
              AND valid_from <= $2::timestamptz
              AND (valid_to IS NULL OR $2::timestamptz < valid_to)
            LIMIT 1`,
          [target.person_id, atIso],
        );
        if (protectedAuthority.rows.length > 0) throw new Error("FORBIDDEN_SCOPE");
      }

      const passwordHash = await hashPassword(newPassword);
      const updated = await client.query<{ auth_version: string }>(
        `UPDATE user_account
            SET password_hash=$2,updated_at=$3::timestamptz
          WHERE id=$1::uuid
          RETURNING auth_version::text AS auth_version`,
        [accountId, passwordHash, atIso],
      );
      const authVersion = updated.rows[0]?.auth_version;
      if (authVersion === undefined) throw new Error("ACCOUNT_NOT_FOUND");
      await client.query(
        `INSERT INTO audit_event(
           actor_person_id,action_code,subject_type,subject_id,before_json,after_json,reason,created_at
         ) VALUES($1::uuid,'ACCOUNT_PASSWORD_RESET','USER_ACCOUNT',$2::uuid,$3::jsonb,$4::jsonb,$5,$6::timestamptz)`,
        [
          context.personId,
          accountId,
          JSON.stringify({ authVersion: target.auth_version }),
          JSON.stringify({ authVersion }),
          reason,
          atIso,
        ],
      );
      await client.query(
        `INSERT INTO auth_password_reset_command(
           actor_person_id,idempotency_key,target_account_id,reason,password_hash,
           result_auth_version,actor_subject_code,actor_scope_type,created_at
         ) VALUES($1::uuid,$2,$3::uuid,$4,$5,$6::bigint,$7,'GLOBAL',$8::timestamptz)`,
        [
          context.personId,
          idempotencyKey,
          accountId,
          reason,
          passwordHash,
          authVersion,
          subject,
          atIso,
        ],
      );
      return {
        accountId,
        personId: target.person_id,
        authVersion,
        resetAt: atIso,
        replay: false,
      };
    });
  }

  private mapResponsibility(row: ResponsibilityRow): ManagedRoleAssignment {
    if (!directorySubject(row.subject_code) || !managedScope(row.scope_type)) {
      throw new Error("ROLE_ASSIGNMENT_DATA_INVALID");
    }
    return {
      assignmentId: row.assignment_id,
      subject: row.subject_code,
      scope: row.scope_type,
      ...(row.scope_id === null ? {} : { scopeId: row.scope_id }),
      validFrom: new Date(row.valid_from).toISOString(),
      ...(row.valid_to === null ? {} : { validTo: new Date(row.valid_to).toISOString() }),
      reason: row.reason,
      createdByPersonId: row.created_by_person_id,
    };
  }

  private async authVersion(client: PostgresClient, personId: string): Promise<string> {
    const result = await client.query<{ auth_version: string }>(
      "SELECT auth_version::text AS auth_version FROM user_account WHERE person_id=$1::uuid",
      [personId],
    );
    const authVersion = result.rows[0]?.auth_version;
    if (authVersion === undefined) throw new Error("ACCOUNT_NOT_FOUND");
    return authVersion;
  }

  private assertManagementAuthority(
    actor: "SYSTEM_OWNER" | "SYSTEM_ADMIN",
    subject: PermissionSubject,
  ): void {
    if (subject === "SYSTEM_OWNER" || !managedSubject(subject)) throw new Error("FORBIDDEN_SCOPE");
    if (subject === "SYSTEM_ADMIN" && actor !== "SYSTEM_OWNER") {
      throw new Error("ONLY_SYSTEM_OWNER_CAN_MANAGE_ADMIN");
    }
  }

  private async assertScopeResource(
    client: PostgresClient,
    scope: PermissionScope,
    scopeId: string | undefined,
  ): Promise<void> {
    const needsId = scope === "REGION" || scope === "CAMPUS" || scope === "VENUE";
    if (needsId !== (scopeId !== undefined)) throw new Error("INVALID_ROLE_SCOPE");
    if (scopeId === undefined) return;
    if (!UUID_PATTERN.test(scopeId)) throw new Error("INVALID_INPUT");
    const resource = scope === "VENUE"
      ? await client.query("SELECT id FROM venue WHERE id=$1::uuid", [scopeId])
      : await client.query(
          "SELECT id FROM organization_unit WHERE id=$1::uuid AND unit_type=$2",
          [scopeId, scope === "REGION" ? "REGION" : "CAMPUS"],
        );
    if (resource.rows.length !== 1) throw new Error("ROLE_SCOPE_NOT_FOUND");
  }

  public async listPeople(
    context: RoleContext,
    at: Date,
  ): Promise<readonly PersonResponsibilityDirectoryItem[]> {
    const atIso = validAt(at);
    return this.transaction(async (client) => {
      await this.assertCurrentAuthority(client, context, atIso);
      const people = await client.query<DirectoryRow>(
        `SELECT account.id::text AS account_id,person.id::text AS person_id,person.nickname,person.legal_name,person.profile_version::text AS profile_version,account.phone_normalized,
                account.login_status,person.status AS person_status,'{}'::text[] AS active_system_authorities
           FROM user_account account JOIN person ON person.id=account.person_id
          ORDER BY person.nickname,person.id`,
      );
      const roles = await client.query<ResponsibilityRow>(
        `SELECT id::text AS assignment_id,person_id::text AS person_id,subject_code,scope_type,scope_id::text AS scope_id,
                valid_from::text AS valid_from,valid_to::text AS valid_to,reason,created_by::text AS created_by_person_id
           FROM role_assignment ORDER BY person_id,valid_from,id`,
      );
      const grouped = new Map<string, ManagedRoleAssignment[]>();
      for (const role of roles.rows) {
        const list = grouped.get(role.person_id) ?? [];
        list.push(this.mapResponsibility(role));
        grouped.set(role.person_id, list);
      }
      return people.rows.map((person) => ({
        accountId: person.account_id, personId: person.person_id, nickname: person.nickname,
        phoneNormalized: person.phone_normalized, legalName: person.legal_name, profileVersion: person.profile_version,
        loginStatus: person.login_status,
        personStatus: person.person_status, responsibilities: grouped.get(person.person_id) ?? [],
      }));
    });
  }

  public async updatePersonProfile(
    context: RoleContext, personIdInput: string, nicknameInput: string,
    legalNameInput: string, expectedProfileVersionInput: string,
    reasonInput: string, idempotencyKeyInput: string, at: Date,
  ): Promise<PersonProfileChangeResult> {
    const atIso = validAt(at);
    const personId = personIdInput.toLowerCase();
    if (!UUID_PATTERN.test(personId)) throw new Error("INVALID_INPUT");
    const nickname = normalizeNickname(nicknameInput);
    const legalName = normalizeLegalName(legalNameInput);
    const reason = normalizeResetReason(reasonInput);
    const idempotencyKey = assertIdempotencyKey(idempotencyKeyInput);
    let expectedProfileVersion: bigint;
    try { expectedProfileVersion = BigInt(expectedProfileVersionInput); } catch { throw new Error("INVALID_INPUT"); }
    if (expectedProfileVersion < 1n) throw new Error("INVALID_INPUT");
    return this.transaction(async (client) => {
      const actor = await this.assertCurrentAuthority(client, context, atIso);
      await client.query("SELECT id FROM person WHERE id=$1::uuid FOR UPDATE", [personId]);
      if (actor === "SYSTEM_ADMIN") {
        const protectedTarget = await client.query(
          `SELECT 1 FROM role_assignment
             WHERE person_id=$1::uuid AND subject_code IN ('SYSTEM_OWNER','SYSTEM_ADMIN')
               AND scope_type='GLOBAL' AND scope_id IS NULL
               AND (valid_to IS NULL OR $2::timestamptz < valid_to)
               AND (valid_to IS NULL OR valid_to > valid_from)
             LIMIT 1`, [personId, atIso]);
        if (protectedTarget.rows.length !== 0) throw new Error("FORBIDDEN_SCOPE");
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`person-profile:${personId}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`person-profile-command:${context.personId}:${idempotencyKey}`]);
      const existing = await client.query<{ person_id: string; source_profile_version: string; before_nickname: string; before_legal_name: string; after_nickname: string; after_legal_name: string; reason: string; result_profile_version: string; changed_at: string }>(
        `SELECT person_id::text,source_profile_version::text,before_nickname,before_legal_name,after_nickname,after_legal_name,reason,result_profile_version::text,
                changed_at::text FROM person_profile_change WHERE actor_person_id=$1::uuid AND idempotency_key=$2 FOR SHARE`,
        [context.personId, idempotencyKey]);
      const replay = existing.rows[0];
      if (replay !== undefined) {
        if (replay.person_id !== personId || replay.source_profile_version !== expectedProfileVersion.toString() || replay.after_nickname !== nickname || replay.after_legal_name !== legalName || replay.reason !== reason) throw new Error("IDEMPOTENCY_REPLAY");
        return { personId, nickname: replay.after_nickname, legalName: replay.after_legal_name, profileVersion: replay.result_profile_version, changedAt: new Date(replay.changed_at).toISOString(), replay: true };
      }
      const current = await client.query<{ nickname: string; legal_name: string; profile_version: string }>(
        `SELECT nickname,legal_name,profile_version::text FROM person WHERE id=$1::uuid FOR UPDATE`, [personId]);
      const before = current.rows[0];
      if (before === undefined) throw new Error("PERSON_NOT_FOUND");
      if (BigInt(before.profile_version) !== expectedProfileVersion) throw new Error("PROFILE_VERSION_STALE");
      if (before.nickname === nickname && before.legal_name === legalName) throw new Error("PROFILE_NO_CHANGE");
      const nextVersion = expectedProfileVersion + 1n;
      await client.query("SELECT set_config('app.person_profile_write_context','service-v1',true)");
      try {
        await client.query(`UPDATE person SET nickname=$2,legal_name=$3,profile_version=$4::bigint,updated_at=$5::timestamptz WHERE id=$1::uuid`, [personId,nickname,legalName,nextVersion.toString(),atIso]);
      } catch (error) {
        if ((error as PgError).code === "23505" && (error as PgError).constraint === "person_nickname_key") throw new Error("PROFILE_NICKNAME_CONFLICT");
        throw error;
      }
      const auditEventId = randomUUID();
      const inserted = await client.query<{ id: string; changed_at: string }>(
        `INSERT INTO person_profile_change(audit_event_id,person_id,source_profile_version,result_profile_version,before_nickname,before_legal_name,after_nickname,after_legal_name,actor_person_id,actor_subject_code,reason,idempotency_key,changed_at,created_at)
         VALUES($1::uuid,$2::uuid,$3::bigint,$4::bigint,$5,$6,$7,$8,$9::uuid,$10,$11,$12,$13::timestamptz,$13::timestamptz) RETURNING id::text,changed_at::text`,
        [auditEventId,personId,expectedProfileVersion.toString(),nextVersion.toString(),before.nickname,before.legal_name,nickname,legalName,context.personId,actor,reason,idempotencyKey,atIso]);
      await client.query(`INSERT INTO audit_event(id,actor_person_id,action_code,subject_type,subject_id,before_json,after_json,reason,created_at) VALUES($1::uuid,$2::uuid,'PERSON_PROFILE_CHANGED','PERSON',$3::uuid,$4::jsonb,$5::jsonb,$6,$7::timestamptz)`, [auditEventId,context.personId,personId,JSON.stringify({nickname: before.nickname, legalName: before.legal_name, profileVersion: expectedProfileVersion.toString()}),JSON.stringify({nickname,legalName,profileVersion: nextVersion.toString()}),reason,atIso]);
      const changedAt = inserted.rows[0]?.changed_at ?? atIso;
      return { personId, nickname, legalName, profileVersion: nextVersion.toString(), changedAt: new Date(changedAt).toISOString(), replay: false };
    });
  }

  public async assignRole(
    context: RoleContext, personIdInput: string, draft: RoleAssignmentDraft,
    idempotencyKeyInput: string, at: Date,
  ): Promise<RoleAssignmentChangeResult> {
    const atIso = validAt(at);
    const personId = personIdInput.toLowerCase();
    if (!UUID_PATTERN.test(personId) || !managedScope(draft.scope) || !directorySubject(draft.subject)) throw new Error("INVALID_INPUT");
    if (!managedSubject(draft.subject)) throw new Error("FORBIDDEN_SCOPE");
    const expected = expectedScope(draft.subject);
    if (expected !== draft.scope) throw new Error("INVALID_ROLE_SCOPE");
    const validFrom = normalizedTimestamp(draft.validFrom);
    const validTo = draft.validTo === undefined ? undefined : normalizedTimestamp(draft.validTo);
    if (validTo !== undefined && validTo <= validFrom) throw new Error("INVALID_INPUT");
    const reason = normalizeResetReason(draft.reason);
    const key = assertIdempotencyKey(idempotencyKeyInput);
    return this.transaction(async (client) => {
      const actor = await this.assertCurrentAuthority(client, context, atIso);
      this.assertManagementAuthority(actor, draft.subject);
      await this.assertScopeResource(client, draft.scope, draft.scopeId);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`role-command:${context.personId}:${key}`]);
      const existing = await client.query<ResponsibilityCommandRow>(
        `SELECT command_kind,target_person_id::text AS target_person_id,role_assignment_id::text AS role_assignment_id,subject_code,scope_type,scope_id::text AS scope_id,
                valid_from::text AS valid_from,valid_to::text AS valid_to,next_person_status,reason,result_auth_version::text AS result_auth_version
           FROM person_responsibility_command WHERE actor_person_id=$1::uuid AND idempotency_key=$2 FOR SHARE`,
        [context.personId, key],
      );
      const replay = existing.rows[0];
      if (replay !== undefined) {
        if (replay.command_kind !== "ASSIGN" || replay.target_person_id !== personId || replay.subject_code !== draft.subject || replay.scope_type !== draft.scope ||
          replay.scope_id !== (draft.scopeId ?? null) || new Date(replay.valid_from ?? "").toISOString() !== validFrom ||
          (replay.valid_to === null ? undefined : new Date(replay.valid_to).toISOString()) !== validTo || replay.reason !== reason) throw new Error("IDEMPOTENCY_REPLAY");
        const row = await client.query<ResponsibilityRow>(this.responsibilitySelect("id=$1::uuid"), [replay.role_assignment_id]);
        if (!row.rows[0]) throw new Error("ROLE_ASSIGNMENT_NOT_FOUND");
        return { personId, assignment: this.mapResponsibility(row.rows[0]), authVersion: replay.result_auth_version, replay: true };
      }
      const target = await client.query<{ status: string }>("SELECT status FROM person WHERE id=$1::uuid FOR UPDATE", [personId]);
      if (!target.rows[0]) throw new Error("PERSON_NOT_FOUND");
      if (target.rows[0].status !== "ACTIVE") throw new Error("PERSON_INACTIVE");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`role-overlap:${personId}:${draft.subject}:${draft.scope}:${draft.scopeId ?? ""}`]);
      let inserted: ResponsibilityRow;
      try {
        const result = await client.query<ResponsibilityRow>(
          `INSERT INTO role_assignment(person_id,subject_code,scope_type,scope_id,valid_from,valid_to,reason,created_by,created_at)
           VALUES($1::uuid,$2,$3,$4::uuid,$5::timestamptz,$6::timestamptz,$7,$8::uuid,$9::timestamptz)
           RETURNING id::text AS assignment_id,person_id::text AS person_id,subject_code,scope_type,scope_id::text AS scope_id,valid_from::text AS valid_from,valid_to::text AS valid_to,reason,created_by::text AS created_by_person_id`,
          [personId,draft.subject,draft.scope,draft.scopeId ?? null,validFrom,validTo ?? null,reason,context.personId,atIso],
        );
        inserted = result.rows[0]!;
      } catch (error) {
        if ((error as PgError).code === "23P01") throw new Error("ROLE_ASSIGNMENT_OVERLAP");
        throw error;
      }
      const authVersion = await this.bumpRoleAuthVersion(client, personId, atIso);
      const assignment = this.mapResponsibility(inserted);
      await this.auditResponsibility(client, context.personId, "ROLE_ASSIGNED", inserted.assignment_id, null, assignment, reason, atIso);
      await client.query(
        `INSERT INTO person_responsibility_command(actor_person_id,idempotency_key,command_kind,target_person_id,role_assignment_id,subject_code,scope_type,scope_id,valid_from,valid_to,reason,result_auth_version,actor_subject_code,created_at)
         VALUES($1::uuid,$2,'ASSIGN',$3::uuid,$4::uuid,$5,$6,$7::uuid,$8::timestamptz,$9::timestamptz,$10,$11::bigint,$12,$13::timestamptz)`,
        [context.personId,key,personId,inserted.assignment_id,draft.subject,draft.scope,draft.scopeId ?? null,validFrom,validTo ?? null,reason,authVersion,actor,atIso],
      );
      return { personId, assignment, authVersion, replay: false };
    });
  }

  private responsibilitySelect(where: string): string {
    return `SELECT id::text AS assignment_id,person_id::text AS person_id,subject_code,scope_type,scope_id::text AS scope_id,
                   valid_from::text AS valid_from,valid_to::text AS valid_to,reason,created_by::text AS created_by_person_id
              FROM role_assignment WHERE ${where}`;
  }

  private async bumpRoleAuthVersion(client: PostgresClient, personId: string, at: string): Promise<string> {
    const result = await client.query<{ auth_version: string }>(
      `UPDATE user_account SET auth_version=auth_version+1,updated_at=$2::timestamptz
        WHERE person_id=$1::uuid RETURNING auth_version::text AS auth_version`, [personId, at],
    );
    const authVersion = result.rows[0]?.auth_version;
    if (authVersion === undefined) throw new Error("ACCOUNT_NOT_FOUND");
    return authVersion;
  }

  private async auditResponsibility(
    client: PostgresClient, actorId: string, action: string, subjectId: string,
    before: unknown, after: unknown, reason: string, at: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_event(actor_person_id,action_code,subject_type,subject_id,before_json,after_json,reason,created_at)
       VALUES($1::uuid,$2,'ROLE_ASSIGNMENT',$3::uuid,$4::jsonb,$5::jsonb,$6,$7::timestamptz)`,
      [actorId,action,subjectId,JSON.stringify(before),JSON.stringify(after),reason,at],
    );
  }

  public async revokeRole(
    context: RoleContext, assignmentIdInput: string, reasonInput: string,
    idempotencyKeyInput: string, at: Date,
  ): Promise<RoleAssignmentChangeResult> {
    const atIso = validAt(at); const assignmentId = assignmentIdInput.toLowerCase();
    if (!UUID_PATTERN.test(assignmentId)) throw new Error("INVALID_INPUT");
    const reason = normalizeResetReason(reasonInput);
    const key = assertIdempotencyKey(idempotencyKeyInput);
    return this.transaction(async (client) => {
      const actor = await this.assertCurrentAuthority(client, context, atIso);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`role-command:${context.personId}:${key}`]);
      const existing = await client.query<ResponsibilityCommandRow>(
        `SELECT command_kind,target_person_id::text AS target_person_id,role_assignment_id::text AS role_assignment_id,subject_code,scope_type,scope_id::text AS scope_id,
                valid_from::text AS valid_from,valid_to::text AS valid_to,next_person_status,reason,result_auth_version::text AS result_auth_version
           FROM person_responsibility_command WHERE actor_person_id=$1::uuid AND idempotency_key=$2 FOR SHARE`, [context.personId,key],
      );
      const replay = existing.rows[0];
      if (replay !== undefined) {
        if (replay.command_kind !== "REVOKE" || replay.role_assignment_id !== assignmentId ||
          replay.reason !== reason) throw new Error("IDEMPOTENCY_REPLAY");
        const row = await client.query<ResponsibilityRow>(this.responsibilitySelect("id=$1::uuid"), [assignmentId]);
        if (!row.rows[0]) throw new Error("ROLE_ASSIGNMENT_NOT_FOUND");
        return { personId: row.rows[0].person_id, assignment: this.mapResponsibility(row.rows[0]), authVersion: replay.result_auth_version, replay: true };
      }
      const current = await client.query<ResponsibilityRow>(`${this.responsibilitySelect("id=$1::uuid")} FOR UPDATE`, [assignmentId]);
      const row = current.rows[0]; if (!row) throw new Error("ROLE_ASSIGNMENT_NOT_FOUND");
      if (!managedSubject(row.subject_code)) throw new Error("FORBIDDEN_SCOPE");
      this.assertManagementAuthority(actor, row.subject_code);
      const before = this.mapResponsibility(row);
      const startsAt = new Date(before.validFrom).getTime();
      const now = new Date(atIso).getTime();
      if (before.validTo !== undefined && new Date(before.validTo).getTime() <= now) throw new Error("INVALID_ROLE_REVOCATION");
      const validTo = startsAt > now ? before.validFrom : atIso;
      const changed = await client.query<ResponsibilityRow>(
        `UPDATE role_assignment SET valid_to=$2::timestamptz
          WHERE id=$1::uuid
          RETURNING id::text AS assignment_id,person_id::text AS person_id,subject_code,scope_type,scope_id::text AS scope_id,valid_from::text AS valid_from,valid_to::text AS valid_to,reason,created_by::text AS created_by_person_id`,
        [assignmentId,validTo],
      );
      const assignment = this.mapResponsibility(changed.rows[0]!);
      const authVersion = await this.bumpRoleAuthVersion(client,row.person_id,atIso);
      await this.auditResponsibility(client,"" + context.personId,"ROLE_REVOKED",assignmentId,before,assignment,reason,atIso);
      await client.query(
        `INSERT INTO person_responsibility_command(actor_person_id,idempotency_key,command_kind,target_person_id,role_assignment_id,valid_to,reason,result_auth_version,actor_subject_code,created_at)
         VALUES($1::uuid,$2,'REVOKE',$3::uuid,$4::uuid,$5::timestamptz,$6,$7::bigint,$8,$9::timestamptz)`,
        [context.personId,key,row.person_id,assignmentId,validTo,reason,authVersion,actor,atIso],
      );
      return { personId: row.person_id, assignment, authVersion, replay: false };
    });
  }

  public async setPersonStatus(
    context: RoleContext, personIdInput: string, status: "ACTIVE" | "INACTIVE",
    reasonInput: string, idempotencyKeyInput: string, at: Date,
  ): Promise<PersonStatusChangeResult> {
    const atIso = validAt(at); const personId = personIdInput.toLowerCase();
    if (!UUID_PATTERN.test(personId) || (status !== "ACTIVE" && status !== "INACTIVE")) throw new Error("INVALID_INPUT");
    const reason = normalizeResetReason(reasonInput); const key = assertIdempotencyKey(idempotencyKeyInput);
    return this.transaction(async (client) => {
      // All owner-affecting status changes share this lock. Recheck authority under
      // it so a concurrently deactivated owner cannot use a previously loaded context.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["person-governance-status"]);
      const actor = await this.assertCurrentAuthority(client, context, atIso);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`role-command:${context.personId}:${key}`]);
      const existing = await client.query<ResponsibilityCommandRow>(
        `SELECT command_kind,target_person_id::text AS target_person_id,role_assignment_id::text AS role_assignment_id,subject_code,scope_type,scope_id::text AS scope_id,
                valid_from::text AS valid_from,valid_to::text AS valid_to,next_person_status,reason,result_auth_version::text AS result_auth_version
           FROM person_responsibility_command WHERE actor_person_id=$1::uuid AND idempotency_key=$2 FOR SHARE`, [context.personId,key],
      );
      const replay = existing.rows[0];
      if (replay !== undefined) {
        if (replay.command_kind !== "PERSON_STATUS" || replay.target_person_id !== personId || replay.next_person_status !== status || replay.reason !== reason) throw new Error("IDEMPOTENCY_REPLAY");
        return { personId, personStatus: status, authVersion: replay.result_auth_version, replay: true };
      }
      const target = await client.query<{ status: "ACTIVE" | "INACTIVE" }>("SELECT status FROM person WHERE id=$1::uuid FOR UPDATE", [personId]);
      const before = target.rows[0]; if (!before) throw new Error("PERSON_NOT_FOUND");
      const targetAuthorities = await client.query<{ subject_code: "SYSTEM_OWNER" | "SYSTEM_ADMIN" }>(
        `SELECT subject_code FROM role_assignment
          WHERE person_id=$1::uuid AND subject_code IN ('SYSTEM_OWNER','SYSTEM_ADMIN')
            AND scope_type='GLOBAL' AND scope_id IS NULL
            AND (valid_to IS NULL OR $2::timestamptz < valid_to)
            AND (valid_to IS NULL OR valid_to > valid_from)`, [personId,atIso],
      );
      const protectedTarget = targetAuthorities.rows.some((row) => row.subject_code === "SYSTEM_OWNER" || row.subject_code === "SYSTEM_ADMIN");
      if (actor === "SYSTEM_ADMIN" && protectedTarget) throw new Error("FORBIDDEN_SCOPE");
      if (actor === "SYSTEM_OWNER" && status === "INACTIVE") {
        if (personId === context.personId) throw new Error("CANNOT_DEACTIVATE_SELF");
        if (targetAuthorities.rows.some((row) => row.subject_code === "SYSTEM_OWNER")) {
          const owners = await client.query(
            `SELECT authority.id FROM role_assignment authority
              JOIN person owner_person ON owner_person.id=authority.person_id AND owner_person.status='ACTIVE'
              JOIN user_account owner_account ON owner_account.person_id=authority.person_id AND owner_account.login_status='ACTIVE'
             WHERE authority.subject_code='SYSTEM_OWNER' AND authority.scope_type='GLOBAL' AND authority.scope_id IS NULL
               AND authority.valid_from <= $1::timestamptz AND (authority.valid_to IS NULL OR $1::timestamptz < authority.valid_to)`, [atIso],
          );
          if (owners.rows.length <= 1) throw new Error("CANNOT_DEACTIVATE_LAST_OWNER");
        }
      }
      await client.query("UPDATE person SET status=$2,updated_at=$3::timestamptz WHERE id=$1::uuid", [personId,status,atIso]);
      const authVersion = await this.authVersion(client,personId);
      await client.query(
        `INSERT INTO audit_event(actor_person_id,action_code,subject_type,subject_id,before_json,after_json,reason,created_at)
         VALUES($1::uuid,'PERSON_STATUS_CHANGED','PERSON',$2::uuid,$3::jsonb,$4::jsonb,$5,$6::timestamptz)`,
        [context.personId,personId,JSON.stringify({status:before.status}),JSON.stringify({status}),reason,atIso],
      );
      await client.query(
        `INSERT INTO person_responsibility_command(actor_person_id,idempotency_key,command_kind,target_person_id,next_person_status,reason,result_auth_version,actor_subject_code,created_at)
         VALUES($1::uuid,$2,'PERSON_STATUS',$3::uuid,$4,$5,$6::bigint,$7,$8::timestamptz)`,
        [context.personId,key,personId,status,reason,authVersion,actor,atIso],
      );
      return { personId, personStatus: status, authVersion, replay: false };
    });
  }
}
