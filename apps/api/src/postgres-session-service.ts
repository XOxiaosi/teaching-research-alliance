import { createHash, randomBytes } from "node:crypto";
import {
  BUSINESS_IDENTITIES,
  DUTIES,
  SYSTEM_AUTHORITIES,
  type PermissionSubject,
  type RoleContext
} from "@teaching-research-alliance/contracts";
import { roleContextsFor } from "@teaching-research-alliance/domain";
import { verifyPassword } from "./password.js";
import { PostgresIdentityRepository } from "./postgres-identity-repository.js";
import type { PostgresClient, PostgresPool } from "./postgres-ledger-repository.js";
import type { SessionView } from "./session-service.js";

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const KNOWN_SUBJECTS: readonly string[] = [...SYSTEM_AUTHORITIES, ...DUTIES, ...BUSINESS_IDENTITIES];

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

export type PostgresSessionServiceOptions = Readonly<{
  sessionTtlMs?: number;
}>;

const assertValidDate = (at: Date): void => {
  if (Number.isNaN(at.getTime())) throw new Error("INVALID_INPUT:at");
};

const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");

const unauthenticated = (): never => {
  throw new Error("UNAUTHENTICATED");
};

const knownSubject = (value: string): value is PermissionSubject => KNOWN_SUBJECTS.includes(value);

export class PostgresSessionService {
  public readonly credentialField = "password" as const;
  private readonly sessionTtlMs: number;

  public constructor(private readonly pool: PostgresPool, options: PostgresSessionServiceOptions = {}) {
    const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs <= 0) {
      throw new Error("SESSION_TTL_INVALID");
    }
    this.sessionTtlMs = sessionTtlMs;
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

  public async login(phoneNormalized: string, password: string, at: Date): Promise<SessionView> {
    assertValidDate(at);
    return this.transaction(async (client) => {
      const identity = new PostgresIdentityRepository(client);
      const candidate = await identity.findAccountByPhone(phoneNormalized);
      if (
        candidate === undefined
        || candidate.status !== "ACTIVE"
        || !(await verifyPassword(password, candidate.credentialDigest))
      ) return unauthenticated();

      const lockedResult = await client.query<LockedAccountRow>(
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
      );
      const locked = lockedResult.rows[0];
      if (
        locked === undefined
        || locked.login_status !== "ACTIVE"
        || locked.person_status !== "ACTIVE"
        || locked.password_hash !== candidate.credentialDigest
      ) return unauthenticated();

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
      return this.view(token, {
        session_id: sessionId,
        account_id: locked.account_id,
        person_id: locked.person_id,
        auth_version: locked.auth_version,
        current_subject: currentSubject
      }, contexts);
    });
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
