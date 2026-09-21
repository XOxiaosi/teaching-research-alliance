import type { PermissionSubject, RoleContext } from "@teaching-research-alliance/contracts";
import { roleContextsFor, switchRoleContext, type RoleAssignmentRecord } from "@teaching-research-alliance/domain";

export type LoginAccount = Readonly<{
  accountId: string;
  personId: string;
  phoneNormalized: string;
  credentialDigest: string;
  status: "ACTIVE" | "REVOKED";
}>;

export type SessionView = Readonly<{
  sessionId: string;
  accountId: string;
  personId: string;
  roleContexts: readonly RoleContext[];
  currentRoleContext: RoleContext | null;
}>;

type SessionRecord = Readonly<{
  sessionId: string;
  accountId: string;
  personId: string;
  currentSubject?: PermissionSubject;
}>;

export type SessionServiceOptions = Readonly<{
  accounts: readonly LoginAccount[];
  assignments: readonly RoleAssignmentRecord[];
  sessionIdFactory?: () => string;
}>;

const defaultSessionIdFactory = (() => {
  let sequence = 0;
  return (): string => `session-synthetic-${++sequence}`;
})();

const assertCredential = (account: LoginAccount | undefined, credentialDigest: string): LoginAccount => {
  if (account === undefined || account.status !== "ACTIVE" || account.credentialDigest !== credentialDigest) {
    throw new Error("UNAUTHENTICATED");
  }
  return account;
};

export class SessionService {
  private readonly accounts: Map<string, LoginAccount>;
  private readonly assignments: readonly RoleAssignmentRecord[];
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly sessionIdFactory: () => string;

  public constructor(options: SessionServiceOptions) {
    this.accounts = new Map(options.accounts.map((account) => [account.phoneNormalized, account]));
    this.assignments = options.assignments;
    this.sessionIdFactory = options.sessionIdFactory ?? defaultSessionIdFactory;
  }

  public login(phoneNormalized: string, credentialDigest: string, at: Date): SessionView {
    const account = assertCredential(this.accounts.get(phoneNormalized), credentialDigest);
    const sessionId = this.sessionIdFactory();
    this.sessions.set(sessionId, { sessionId, accountId: account.accountId, personId: account.personId });
    return this.view(this.sessions.get(sessionId) as SessionRecord, at);
  }

  public switchRole(sessionId: string, subject: PermissionSubject, at: Date): SessionView {
    const session = this.requireSession(sessionId);
    const account = this.requireActiveAccount(session.accountId);
    switchRoleContext(session.personId, subject, this.assignments, at);
    const next: SessionRecord = { ...session, currentSubject: subject };
    this.sessions.set(sessionId, next);
    return this.view(next, at, account);
  }

  public get(sessionId: string, at: Date): SessionView {
    const session = this.requireSession(sessionId);
    return this.view(session, at);
  }

  public revokeAccount(accountId: string): void {
    const account = [...this.accounts.values()].find((item) => item.accountId === accountId);
    if (account === undefined) return;
    this.accounts.set(account.phoneNormalized, { ...account, status: "REVOKED" });
  }

  private requireSession(sessionId: string): SessionRecord {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error("UNAUTHENTICATED");
    return session;
  }

  private requireActiveAccount(accountId: string): LoginAccount {
    const account = [...this.accounts.values()].find((item) => item.accountId === accountId);
    if (account === undefined || account.status !== "ACTIVE") throw new Error("UNAUTHENTICATED");
    return account;
  }

  private view(session: SessionRecord, at: Date, knownAccount?: LoginAccount): SessionView {
    const account = knownAccount ?? this.requireActiveAccount(session.accountId);
    const contexts = roleContextsFor(session.personId, this.assignments, at);
    const currentRoleContext = session.currentSubject === undefined
      ? null
      : contexts.find((context) => context.subject === session.currentSubject) ?? null;
    return {
      sessionId: session.sessionId,
      accountId: account.accountId,
      personId: account.personId,
      roleContexts: contexts,
      currentRoleContext
    };
  }
}
