import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { RoleContext } from "@teaching-research-alliance/contracts";
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
    await client.query("LOCK TABLE role_assignment IN SHARE MODE");
    const result = await client.query(
      `SELECT id
         FROM role_assignment
        WHERE person_id = $1::uuid
          AND subject_code = $2
          AND scope_type = 'GLOBAL'
          AND scope_id IS NULL
          AND valid_from <= $3::timestamptz
          AND (valid_to IS NULL OR $3::timestamptz < valid_to)
        LIMIT 2`,
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
}
