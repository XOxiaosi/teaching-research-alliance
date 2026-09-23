import { createHash, randomBytes } from "node:crypto";
import {
  BASE_IDENTITIES,
  BUSINESS_IDENTITIES,
  DUTIES,
  SYSTEM_AUTHORITIES,
  type PermissionSubject,
  type RoleContext
} from "@teaching-research-alliance/contracts";
import { roleContextsFor } from "@teaching-research-alliance/domain";
import { verifyPassword } from "./password.js";
import { phoneForLogin } from "./identity-input.js";
import { PostgresIdentityRepository } from "./postgres-identity-repository.js";
import type { PostgresClient, PostgresPool } from "./postgres-ledger-repository.js";
import type { SessionView } from "./session-service.js";

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_FAILURE_WINDOW_MS = 15 * 60 * 1_000;
const DEFAULT_BLOCK_DURATION_MS = 15 * 60 * 1_000;
const DEFAULT_ACCOUNT_FAILURE_LIMIT = 5;
const DEFAULT_IP_FAILURE_LIMIT = 20;
const DUMMY_PASSWORD_HASH = "scrypt-v1$32768$8$3$KPhADXGQFqhanRNzJlTEQA$QaXPgEL6lQGtC1x0DJKrH88kOG3h73US1ydONYGlFiI";
const PASSWORD_HASH_PATTERN = /^scrypt-v1\$32768\$8\$3\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/;
const KNOWN_SUBJECTS: readonly string[] = [
  ...SYSTEM_AUTHORITIES,
  ...BASE_IDENTITIES,
  ...DUTIES,
  ...BUSINESS_IDENTITIES,
];

type LockedAccountRow = Readonly<{
  account_id: string;
  person_id: string;
  password_hash: string;
  login_status: "ACTIVE" | "REVOKED";
  auth_version: string;
  person_status: "ACTIVE" | "INACTIVE";
}>;

type SessionRow = Readonly<{
  session_id: string;
  account_id: string;
  person_id: string;
  auth_version: string;
  current_subject: string | null;
}>;

type ThrottleRow = Readonly<{
  dimension_type: "ACCOUNT" | "IP";
  dimension_key: string;
  window_started_at: Date | string;
  failure_count: number;
  blocked_until: Date | string | null;
}>;

type ThrottleDimension = Readonly<{
  type: "ACCOUNT" | "IP";
  key: string;
  limit: number;
}>;

type LoginOutcome =
  | Readonly<{ kind: "SUCCESS"; view: SessionView }>
  | Readonly<{ kind: "FAIL" }>
  | Readonly<{ kind: "RATE_LIMITED" }>;

export type PostgresSessionServiceOptions = Readonly<{
  sessionTtlMs?: number;
  failureWindowMs?: number;
  blockDurationMs?: number;
  accountFailureLimit?: number;
  ipFailureLimit?: number;
  dummyPasswordHash?: string;
}>;

const assertValidDate = (at: Date): void => {
  if (Number.isNaN(at.getTime())) throw new Error("INVALID_INPUT:at");
};

const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");

const dimensionKey = (type: "ACCOUNT" | "IP", value: string): string =>
  createHash("sha256").update(`login-throttle.v1:${type}:${value}`).digest("hex");

const sourceIpKey = (value: string): string => {
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  return normalized.length === 0 ? "unknown" : normalized.slice(0, 256);
};

const dateValue = (value: Date | string): number => {
  const result = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(result)) throw new Error("AUTH_THROTTLE_DATA_INVALID");
  return result;
};

const unauthenticated = (): never => {
  throw new Error("UNAUTHENTICATED");
};

const knownSubject = (value: string): value is PermissionSubject => KNOWN_SUBJECTS.includes(value);

export class PostgresSessionService {
  public readonly credentialField = "password" as const;
  private readonly sessionTtlMs: number;
  private readonly failureWindowMs: number;
  private readonly blockDurationMs: number;
  private readonly accountFailureLimit: number;
  private readonly ipFailureLimit: number;
  private readonly dummyPasswordHash: string;

  public constructor(private readonly pool: PostgresPool, options: PostgresSessionServiceOptions = {}) {
    const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs <= 0) {
      throw new Error("SESSION_TTL_INVALID");
    }
    this.sessionTtlMs = sessionTtlMs;
    this.failureWindowMs = options.failureWindowMs ?? DEFAULT_FAILURE_WINDOW_MS;
    this.blockDurationMs = options.blockDurationMs ?? DEFAULT_BLOCK_DURATION_MS;
    this.accountFailureLimit = options.accountFailureLimit ?? DEFAULT_ACCOUNT_FAILURE_LIMIT;
    this.ipFailureLimit = options.ipFailureLimit ?? DEFAULT_IP_FAILURE_LIMIT;
    this.dummyPasswordHash = options.dummyPasswordHash ?? DUMMY_PASSWORD_HASH;
    for (const value of [this.failureWindowMs, this.blockDurationMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("LOGIN_RATE_LIMIT_CONFIG_INVALID");
    }
    for (const value of [this.accountFailureLimit, this.ipFailureLimit]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("LOGIN_RATE_LIMIT_CONFIG_INVALID");
    }
    if (!PASSWORD_HASH_PATTERN.test(this.dummyPasswordHash)) {
      throw new Error("LOGIN_DUMMY_PASSWORD_HASH_INVALID");
    }
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

  private async contexts(client: PostgresClient, personId: string, at: Date): Promise<readonly RoleContext[]> {
    const identity = new PostgresIdentityRepository(client);
    const assignments = await identity.listRoleAssignments(personId);
    return roleContextsFor(personId, assignments, at);
  }

  private activeThrottle(
    row: ThrottleRow | undefined,
    dimension: ThrottleDimension,
    at: Date,
  ): boolean {
    if (row === undefined) return false;
    const now = at.getTime();
    const started = dateValue(row.window_started_at);
    const blocked = row.blocked_until === null ? undefined : dateValue(row.blocked_until);
    if (blocked !== undefined && blocked > now) return true;
    return now >= started
      && now - started < this.failureWindowMs
      && row.failure_count >= dimension.limit;
  }

  private async lockThrottleRows(
    client: PostgresClient,
    dimensions: readonly ThrottleDimension[],
  ): Promise<ReadonlyMap<string, ThrottleRow>> {
    for (const dimension of [...dimensions].sort((left, right) =>
      `${left.type}:${left.key}`.localeCompare(`${right.type}:${right.key}`))) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`login-throttle:${dimension.type}:${dimension.key}`],
      );
    }
    const result = await client.query<ThrottleRow>(
      `SELECT dimension_type,dimension_key,window_started_at,failure_count,blocked_until
         FROM auth_login_throttle
        WHERE (dimension_type=$1 AND dimension_key=$2)
           OR (dimension_type=$3 AND dimension_key=$4)
        FOR UPDATE`,
      [
        dimensions[0]!.type,
        dimensions[0]!.key,
        dimensions[1]!.type,
        dimensions[1]!.key,
      ],
    );
    return new Map(
      result.rows.map((row) => [`${row.dimension_type}:${row.dimension_key}`, row]),
    );
  }

  private async recordLoginFailure(
    client: PostgresClient,
    dimensions: readonly ThrottleDimension[],
    rows: ReadonlyMap<string, ThrottleRow>,
    at: Date,
  ): Promise<boolean> {
    let limited = false;
    const now = at.getTime();
    for (const dimension of dimensions) {
      const row = rows.get(`${dimension.type}:${dimension.key}`);
      const started = row === undefined ? now : dateValue(row.window_started_at);
      const continuesWindow = now >= started && now - started < this.failureWindowMs;
      const windowStartedAt = continuesWindow ? new Date(started) : at;
      const failureCount = continuesWindow ? (row?.failure_count ?? 0) + 1 : 1;
      const blockedUntil = failureCount >= dimension.limit
        ? new Date(now + this.blockDurationMs)
        : null;
      limited ||= blockedUntil !== null;
      await client.query(
        `INSERT INTO auth_login_throttle(
           dimension_type,dimension_key,window_started_at,failure_count,blocked_until,updated_at,created_at
         ) VALUES($1,$2,$3::timestamptz,$4,$5::timestamptz,$6::timestamptz,$6::timestamptz)
         ON CONFLICT(dimension_type,dimension_key) DO UPDATE
           SET window_started_at=EXCLUDED.window_started_at,
               failure_count=EXCLUDED.failure_count,
               blocked_until=EXCLUDED.blocked_until,
               updated_at=EXCLUDED.updated_at`,
        [
          dimension.type,
          dimension.key,
          windowStartedAt.toISOString(),
          failureCount,
          blockedUntil?.toISOString() ?? null,
          at.toISOString(),
        ],
      );
    }
    return limited;
  }

  private view(
    token: string,
    session: SessionRow,
    contexts: readonly RoleContext[]
  ): SessionView {
    let currentRoleContext: RoleContext | null = null;
    if (session.current_subject !== null) {
      if (!knownSubject(session.current_subject)) return unauthenticated();
      const matching = contexts.filter((context) => context.subject === session.current_subject);
      currentRoleContext = matching.length === 1 ? matching[0] as RoleContext : null;
    }
    return {
      sessionId: token,
      accountId: session.account_id,
      personId: session.person_id,
      roleContexts: contexts,
      currentRoleContext
    };
  }

  private async loadSession(
    client: PostgresClient,
    token: string,
    at: Date,
    forUpdate: boolean
  ): Promise<SessionRow> {
    const lockClause = forUpdate
      ? "FOR UPDATE OF session_record FOR SHARE OF account, person"
      : "FOR SHARE OF session_record, account, person";
    const result = await client.query<SessionRow>(
      `SELECT session_record.id::text AS session_id,
              session_record.account_id::text AS account_id,
              account.person_id::text AS person_id,
              session_record.auth_version::text AS auth_version,
              session_record.current_subject
         FROM user_session session_record
         JOIN user_account account ON account.id = session_record.account_id
         JOIN person ON person.id = account.person_id
        WHERE session_record.token_hash = $1
          AND session_record.created_at <= $2::timestamptz
          AND session_record.expires_at > $2::timestamptz
          AND session_record.auth_version = account.auth_version
          AND account.login_status = 'ACTIVE'
          AND person.status = 'ACTIVE'
        ${lockClause}`,
      [tokenHash(token), at.toISOString()]
    );
    const session = result.rows[0];
    if (session === undefined || result.rows.length !== 1) return unauthenticated();
    return session;
  }

  public async login(
    phoneInput: string,
    password: string,
    at: Date,
    sourceIp = "unknown",
  ): Promise<SessionView> {
    assertValidDate(at);
    const phoneNormalized = phoneForLogin(phoneInput);
    const accountDimensionValue = phoneNormalized
      ?? createHash("sha256").update(phoneInput.normalize("NFKC")).digest("hex");
    const dimensions: readonly ThrottleDimension[] = [
      {
        type: "ACCOUNT",
        key: dimensionKey("ACCOUNT", accountDimensionValue),
        limit: this.accountFailureLimit,
      },
      {
        type: "IP",
        key: dimensionKey("IP", sourceIpKey(sourceIp)),
        limit: this.ipFailureLimit,
      },
    ];
    const outcome = await this.transaction<LoginOutcome>(async (client) => {
      const throttleRows = await this.lockThrottleRows(client, dimensions);
      if (dimensions.some((dimension) =>
        this.activeThrottle(
          throttleRows.get(`${dimension.type}:${dimension.key}`),
          dimension,
          at,
        ))) {
        return { kind: "RATE_LIMITED" };
      }

      const identity = new PostgresIdentityRepository(client);
      const candidate = phoneNormalized === undefined
        ? undefined
        : await identity.findAccountByPhone(phoneNormalized);
      const usableCandidateHash = candidate !== undefined
        && PASSWORD_HASH_PATTERN.test(candidate.credentialDigest);
      const verificationPassword = password.length >= 8 && password.length <= 1_024
        ? password
        : "invalid-password-input";
      const passwordMatches = await verifyPassword(
        verificationPassword,
        usableCandidateHash ? candidate.credentialDigest : this.dummyPasswordHash,
      );

      const lockedResult = candidate !== undefined
        && candidate.status === "ACTIVE"
        && password.length >= 8
        && password.length <= 1_024
        && passwordMatches
        ? await client.query<LockedAccountRow>(
        `SELECT account.id::text AS account_id,
                account.person_id::text AS person_id,
                account.password_hash,
                account.login_status,
                account.auth_version::text AS auth_version,
                person.status AS person_status
           FROM user_account account
           JOIN person ON person.id = account.person_id
          WHERE account.id = $1::uuid
          FOR SHARE OF account, person`,
        [candidate.accountId]
      ) : { rows: [] as readonly LockedAccountRow[] };
      const locked = lockedResult.rows[0];
      if (
        locked === undefined
        || locked.login_status !== "ACTIVE"
        || locked.person_status !== "ACTIVE"
        || locked.password_hash !== candidate?.credentialDigest
      ) {
        const limited = await this.recordLoginFailure(
          client,
          dimensions,
          throttleRows,
          at,
        );
        return { kind: limited ? "RATE_LIMITED" : "FAIL" };
      }

      const contexts = await this.contexts(client, locked.person_id, at);
      const currentSubject = contexts.length === 1 ? contexts[0]?.subject ?? null : null;
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(at.getTime() + this.sessionTtlMs);
      if (Number.isNaN(expiresAt.getTime())) throw new Error("SESSION_TTL_INVALID");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO user_session (
           token_hash, account_id, auth_version, current_subject, expires_at, created_at
         ) VALUES ($1, $2::uuid, $3::bigint, $4, $5::timestamptz, $6::timestamptz)
         RETURNING id::text AS id`,
        [
          tokenHash(token),
          locked.account_id,
          locked.auth_version,
          currentSubject,
          expiresAt.toISOString(),
          at.toISOString()
        ]
      );
      const sessionId = inserted.rows[0]?.id;
      if (sessionId === undefined) throw new Error("SESSION_CREATE_FAILED");
      await client.query(
        "DELETE FROM auth_login_throttle WHERE dimension_type='ACCOUNT' AND dimension_key=$1",
        [dimensions[0]!.key],
      );
      return { kind: "SUCCESS", view: this.view(token, {
        session_id: sessionId,
        account_id: locked.account_id,
        person_id: locked.person_id,
        auth_version: locked.auth_version,
        current_subject: currentSubject
      }, contexts) };
    });
    if (outcome.kind === "SUCCESS") return outcome.view;
    if (outcome.kind === "RATE_LIMITED") throw new Error("LOGIN_RATE_LIMITED");
    return unauthenticated();
  }

  public async get(token: string, at: Date): Promise<SessionView> {
    assertValidDate(at);
    if (token.trim() === "") return unauthenticated();
    return this.transaction(async (client) => {
      const session = await this.loadSession(client, token, at, false);
      const contexts = await this.contexts(client, session.person_id, at);
      return this.view(token, session, contexts);
    });
  }

  public async logout(token: string): Promise<void> {
    if (!token.trim()) return unauthenticated();
    await this.transaction(async (client) => {
      await client.query("DELETE FROM user_session WHERE token_hash=$1", [tokenHash(token)]);
    });
  }

  public async switchRole(token: string, subject: PermissionSubject, at: Date): Promise<SessionView> {
    assertValidDate(at);
    if (token.trim() === "") return unauthenticated();
    if (!knownSubject(subject)) throw new Error("ROLE_CONTEXT_NOT_ASSIGNED");
    return this.transaction(async (client) => {
      const session = await this.loadSession(client, token, at, true);
      const contexts = await this.contexts(client, session.person_id, at);
      const matching = contexts.filter((context) => context.subject === subject);
      if (matching.length === 0) throw new Error("ROLE_CONTEXT_NOT_ASSIGNED");
      if (matching.length > 1) throw new Error("ROLE_CONTEXT_AMBIGUOUS");
      await client.query(
        `UPDATE user_session
            SET current_subject = $2
          WHERE id = $1::uuid`,
        [session.session_id, subject]
      );
      return this.view(token, { ...session, current_subject: subject }, contexts);
    });
  }
}
