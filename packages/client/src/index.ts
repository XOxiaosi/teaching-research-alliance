import type { PermissionSubject, RoleContext } from "@teaching-research-alliance/contracts";

export type ApiEnvelope<T> = Readonly<{
  version?: string;
  data?: T;
  error?: Readonly<{ code: string; message: string }>;
}>;

export type TransportRequest = Readonly<{
  method: "GET" | "POST";
  path: string;
  headers: Readonly<Record<string, string>>;
  body?: unknown;
}>;

export type TransportResponse<T = unknown> = Readonly<{
  status: number;
  body: ApiEnvelope<T>;
}>;

/** The only environment-specific dependency; web and miniapp adapt their own HTTP stack to it. */
export type TeacherApiTransport = <T = unknown>(request: TransportRequest) => Promise<TransportResponse<T>>;

export type SessionSnapshot = Readonly<{
  sessionId: string;
  accountId: string;
  personId: string;
  roleContexts: readonly RoleContext[];
  currentRoleContext: RoleContext | null;
}>;

export type LoginInput = Readonly<{
  phoneNormalized: string;
  password: string;
}>;

/** Monetary values stay decimal integer text in cents; callers must never provide a number. */
export type WeeklyFeeDraftInput = Readonly<{
  referralCaseId: string;
  teachingWeekId: string;
  venueId: string;
  settlementMonth: string;
  grossAmountCents: string;
  expectedVersion: number;
}>;

export type WeeklyFeeSubmission = Readonly<{
  draft: WeeklyFeeDraftInput;
  idempotencyKey: string;
}>;

export type SubmissionStatus = "READY" | "SUBMITTING" | "FAILED" | "SUCCEEDED";

export type TeacherApiClientOptions = Readonly<{
  transport: TeacherApiTransport;
  idempotencyKeyFactory?: () => string;
}>;

export class ApiClientError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message = code
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

/** A response for an account/role generation which is no longer active. It must not update UI state. */
export class StaleResponseError extends Error {
  public constructor() {
    super("STALE_RESPONSE");
    this.name = "StaleResponseError";
  }
}

/** A 403 preserves the session but removes role-scoped data so the UI can return to role selection. */
export class RoleSelectionRequiredError extends ApiClientError {
  public constructor(code: string) {
    super(403, code);
    this.name = "RoleSelectionRequiredError";
  }
}

export class SubmissionInProgressError extends Error {
  public constructor() {
    super("SUBMISSION_IN_PROGRESS");
    this.name = "SubmissionInProgressError";
  }
}

type Authentication = Readonly<{
  sessionId: string;
  epoch: number;
}>;

const isSuccess = (status: number): boolean => status >= 200 && status < 300;

const requireNonBlank = (value: string, field: string): void => {
  if (value.trim() === "") throw new ApiClientError(400, "INVALID_INPUT", `INVALID_INPUT:${field}`);
};

const invalidBeanAmount = (): never => {
  throw new ApiClientError(400, "INVALID_INPUT", "INVALID_INPUT:beanAmount");
};

/**
 * Converts a non-negative 欢乐豆 text input to integer cents without a JavaScript number.
 * Accepted inputs have zero, one, or two fractional digits; scientific and hexadecimal
 * notation are deliberately not numeric input formats.
 */
export const parseBeanAmountToCents = (value: string): string => {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (match === null) return invalidBeanAmount();
  const whole = match[1];
  if (whole === undefined) return invalidBeanAmount();
  const fractional = match[2] ?? "";
  const cents = BigInt(whole) * 100n + BigInt(`${fractional}00`.slice(0, 2));
  return cents.toString();
};

/** Formats integer cents as 欢乐豆 text. Negative values are allowed for displayed balances. */
export const formatCentsAsBeans = (value: string): string => {
  if (!/^-?\d+$/.test(value)) return invalidBeanAmount();
  const cents = BigInt(value);
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = absolute / 100n;
  const fractional = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fractional}`;
};

const validateWeeklyFeeDraft = (draft: WeeklyFeeDraftInput): void => {
  requireNonBlank(draft.referralCaseId, "referralCaseId");
  requireNonBlank(draft.teachingWeekId, "teachingWeekId");
  requireNonBlank(draft.venueId, "venueId");
  if (!/^\d{4}-\d{2}-01$/.test(draft.settlementMonth)) {
    throw new ApiClientError(400, "INVALID_INPUT", "INVALID_INPUT:settlementMonth");
  }
  if (!/^\d+$/.test(draft.grossAmountCents)) {
    throw new ApiClientError(400, "INVALID_INPUT", "INVALID_INPUT:grossAmountCents");
  }
  if (!Number.isSafeInteger(draft.expectedVersion) || draft.expectedVersion < 0) {
    throw new ApiClientError(400, "INVALID_INPUT", "INVALID_INPUT:expectedVersion");
  }
};

let fallbackIdSequence = 0;

const defaultIdempotencyKeyFactory = (): string => {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  fallbackIdSequence += 1;
  // This identifies a retry, not an authentication secret. Entropy avoids collisions
  // between devices that start their local sequence during the same millisecond.
  return `client-${Date.now()}-${fallbackIdSequence}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
};

/**
 * Shared F01/F03/F07 client state. It deliberately owns no UI state. The current
 * session is the only authority for requests; callers may inspect, never mutate it.
 */
export class TeacherApiClient {
  private readonly submissionStatuses = new WeakMap<WeeklyFeeSubmission, SubmissionStatus>();
  private session: SessionSnapshot | null = null;
  private epoch = 0;

  public constructor(private readonly options: TeacherApiClientOptions) {}

  public get currentSession(): SessionSnapshot | null {
    return this.session;
  }

  public get hasRoleContext(): boolean {
    return this.session?.currentRoleContext !== null && this.session !== null;
  }

  /** Starts a new local authentication generation; a failed login does not retain the old local session. */
  public async login(input: LoginInput): Promise<SessionSnapshot> {
    requireNonBlank(input.phoneNormalized, "phoneNormalized");
    requireNonBlank(input.password, "password");
    this.clearSessionState();
    const epoch = this.epoch;
    const response = await this.options.transport<SessionSnapshot>({
      method: "POST",
      path: "/v1/session",
      headers: { "content-type": "application/json" },
      body: input
    });
    if (epoch !== this.epoch) throw new StaleResponseError();
    const session = this.readResponse(response);
    this.installSession(session);
    return session;
  }

  /** Restores the server's current role context. It never trusts a locally cached role. */
  public async refreshSession(): Promise<SessionSnapshot> {
    const next = await this.authenticatedRequest<SessionSnapshot>("GET", "/v1/session");
    this.installSession(next);
    return next;
  }

  public async switchRole(subject: PermissionSubject): Promise<SessionSnapshot> {
    const next = await this.authenticatedRequest<SessionSnapshot>("POST", "/v1/role-contexts/switch", { subject });
    this.installSession(next);
    return next;
  }

  /** Clear local state immediately, then revoke the server session; transport failure remains visible. */
  public async endSession(): Promise<void> {
    const token = this.session?.sessionId;
    this.clearSessionState();
    if (!token) return;
    const response = await this.options.transport({method:"POST",path:"/v1/session/logout",headers:{authorization:`Bearer ${token}`}});
    this.readResponse(response);
  }

  public logout(): void {
    this.clearSessionState();
  }

  public async getMe<T = unknown>(): Promise<T> {
    return this.authenticatedRequest<T>("GET", "/v1/me");
  }

  /** F01/F07 wording used by both clients; it is the same `/v1/me` personal overview. */
  public async getOwnOverview<T = unknown>(): Promise<T> {
    return this.getMe<T>();
  }

  public async listAvailableVenues<T = unknown>(): Promise<T> {
    return this.authenticatedRequest<T>("GET", "/v1/venues/available");
  }

  public async listReceivedReferrals<T = unknown>(): Promise<T> {
    return this.authenticatedRequest<T>("GET", "/v1/teaching/referrals");
  }

  public async listOpenTeachingWeeks<T = unknown>(): Promise<T> {
    return this.authenticatedRequest<T>("GET", "/v1/teaching/weeks");
  }

  public async acceptReferral<T = unknown>(referralId: string): Promise<T> {
    requireNonBlank(referralId, "referralId");
    const result = await this.authenticatedRequest<T>("POST", `/v1/referrals/${encodeURIComponent(referralId)}/accept`);
    this.advanceResponseGeneration();
    return result;
  }

  /**
   * A submission is immutable. Retry the same object after an uncertain network failure;
   * create a new object after editing any field so the old idempotency key is never reused.
   */
  public createWeeklyFeeSubmission(draft: WeeklyFeeDraftInput): WeeklyFeeSubmission {
    validateWeeklyFeeDraft(draft);
    const idempotencyKey = (this.options.idempotencyKeyFactory ?? defaultIdempotencyKeyFactory)();
    requireNonBlank(idempotencyKey, "idempotencyKey");
    const frozenDraft = Object.freeze({ ...draft });
    const submission = Object.freeze({ draft: frozenDraft, idempotencyKey });
    this.submissionStatuses.set(submission, "READY");
    return submission;
  }

  public submissionStatus(submission: WeeklyFeeSubmission): SubmissionStatus {
    return this.submissionStatuses.get(submission) ?? "READY";
  }

  public async recordWeeklyFee<T = unknown>(submission: WeeklyFeeSubmission): Promise<T> {
    const previous = this.submissionStatus(submission);
    if (previous === "SUBMITTING") throw new SubmissionInProgressError();
    this.submissionStatuses.set(submission, "SUBMITTING");
    try {
      const result = await this.authenticatedRequest<T>(
        "POST",
        `/v1/referrals/${encodeURIComponent(submission.draft.referralCaseId)}/weekly-fees`,
        { ...submission.draft, idempotencyKey: submission.idempotencyKey }
      );
      this.submissionStatuses.set(submission, "SUCCEEDED");
      this.advanceResponseGeneration();
      return result;
    } catch (error) {
      this.submissionStatuses.set(submission, "FAILED");
      throw error;
    }
  }

  private requireAuthentication(): Authentication {
    if (this.session === null) throw new ApiClientError(401, "UNAUTHENTICATED");
    return { sessionId: this.session.sessionId, epoch: this.epoch };
  }

  private async authenticatedRequest<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const authentication = this.requireAuthentication();
    const response = await this.options.transport<T>({
      method,
      path,
      headers: {
        authorization: `Bearer ${authentication.sessionId}`,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body })
    });
    if (!this.isCurrent(authentication)) throw new StaleResponseError();
    if (response.status === 401) {
      this.clearSessionState();
      throw this.responseError(response);
    }
    if (response.status === 403) {
      this.clearRoleState();
      throw new RoleSelectionRequiredError(response.body.error?.code ?? "FORBIDDEN_SCOPE");
    }
    return this.readResponse(response);
  }

  private readResponse<T>(response: TransportResponse<T>): T {
    if (!isSuccess(response.status)) throw this.responseError(response);
    return response.body.data as T;
  }

  private responseError(response: TransportResponse<unknown>): ApiClientError {
    const error = response.body.error;
    return new ApiClientError(response.status, error?.code ?? "INTERNAL_ERROR", error?.message);
  }

  private isCurrent(authentication: Authentication): boolean {
    return this.epoch === authentication.epoch && this.session?.sessionId === authentication.sessionId;
  }

  private installSession(session: SessionSnapshot): void {
    this.session = session;
    this.epoch += 1;
  }

  private clearSessionState(): void {
    this.session = null;
    this.epoch += 1;
  }

  private clearRoleState(): void {
    if (this.session !== null) {
      this.session = { ...this.session, currentRoleContext: null };
    }
    this.epoch += 1;
  }

  /** A successful write may change overview values and record versions, so earlier reads become stale. */
  private advanceResponseGeneration(): void {
    this.epoch += 1;
  }
}
