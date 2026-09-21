import {
  API_CONTRACT_VERSION,
  type HttpMethod,
  type PermissionSubject
} from "@teaching-research-alliance/contracts";
import { SessionService, type SessionView } from "./session-service.js";
import { WeeklyFeeService } from "./weekly-fee-service.js";

export type ApiRequest = Readonly<{
  method: HttpMethod;
  path: string;
  body: unknown;
}>;

export type ApiResponse = Readonly<{
  status: number;
  body: Readonly<{
    version: string;
    data?: unknown;
    error?: Readonly<{ code: string; message: string }>;
  }>;
}>;

export type ApiServices = Readonly<{
  sessions: SessionService;
  weeklyFees: WeeklyFeeService;
  now: () => Date;
}>;

const objectBody = (body: unknown): Record<string, unknown> => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("INVALID_INPUT");
  return body as Record<string, unknown>;
};

const requiredString = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`INVALID_INPUT:${key}`);
  return value;
};

const sessionIdFrom = (body: Record<string, unknown>): string => requiredString(body, "sessionId");

const errorStatus = (code: string): number => {
  if (code === "UNAUTHENTICATED") return 401;
  if (code === "FORBIDDEN_SCOPE" || code === "ROLE_CONTEXT_REQUIRED") return 403;
  if (code.endsWith("_NOT_FOUND")) return 404;
  if (code === "PERIOD_LOCKED" || code === "IDEMPOTENCY_REPLAY") return 409;
  return 400;
};

const success = (data: unknown): ApiResponse => ({
  status: 200,
  body: { version: API_CONTRACT_VERSION, data }
});

const failure = (error: unknown): ApiResponse => {
  const message = error instanceof Error ? error.message : "INVALID_INPUT";
  const [code] = message.split(":", 1);
  return {
    status: errorStatus(code ?? "INVALID_INPUT"),
    body: { version: API_CONTRACT_VERSION, error: { code: code ?? "INVALID_INPUT", message } }
  };
};

const currentContext = (view: SessionView) => {
  if (view.currentRoleContext === null) throw new Error("ROLE_CONTEXT_REQUIRED");
  return view.currentRoleContext;
};

const subjectFrom = (value: string): PermissionSubject => {
  const subjects: readonly PermissionSubject[] = [
    "SYSTEM_OWNER", "SYSTEM_ADMIN", "TEACHING_TEACHER", "ACADEMIC_PLANNER",
    "HEADQUARTERS_FINANCE", "REGION_FINANCE", "CAMPUS_PRINCIPAL", "GROUP_LEADER",
    "TEACHING_MENTOR", "PLANNING_MENTOR", "VENUE_OWNER"
  ];
  if (!subjects.includes(value as PermissionSubject)) throw new Error("INVALID_INPUT:subject");
  return value as PermissionSubject;
};

const sessionData = (view: SessionView): Readonly<Record<string, unknown>> => ({
  sessionId: view.sessionId,
  accountId: view.accountId,
  personId: view.personId,
  roleContexts: view.roleContexts,
  currentRoleContext: view.currentRoleContext
});

const weeklyDraft = (body: Record<string, unknown>) => ({
  referralCaseId: requiredString(body, "referralCaseId"),
  teachingWeekId: requiredString(body, "teachingWeekId"),
  venueId: requiredString(body, "venueId"),
  settlementMonth: requiredString(body, "settlementMonth"),
  grossAmountCents: (() => {
    const value = requiredString(body, "grossAmountCents");
    try {
      return BigInt(value);
    } catch {
      throw new Error("INVALID_INPUT:grossAmountCents");
    }
  })()
});

export const handleRequest = (request: ApiRequest, services: ApiServices): ApiResponse => {
  try {
    const body = objectBody(request.body);
    if (request.method === "POST" && request.path === "/v1/session") {
      const view = services.sessions.login(
        requiredString(body, "phoneNormalized"),
        requiredString(body, "credentialDigest"),
        services.now()
      );
      return success(sessionData(view));
    }
    if (request.method === "POST" && request.path === "/v1/role-contexts/switch") {
      const view = services.sessions.switchRole(
        sessionIdFrom(body),
        subjectFrom(requiredString(body, "subject")),
        services.now()
      );
      return success(sessionData(view));
    }
    const acceptPath = request.path.match(/^\/v1\/referrals\/([^/]+)\/accept$/);
    if (request.method === "POST" && acceptPath !== null) {
      const referralId = acceptPath[1];
      if (referralId === undefined || referralId.trim() === "") throw new Error("INVALID_INPUT:referralId");
      const session = services.sessions.get(sessionIdFrom(body), services.now());
      return success(services.weeklyFees.acceptReferral(currentContext(session), referralId));
    }
    const weeklyFeePath = request.path.match(/^\/v1\/referrals\/([^/]+)\/weekly-fees$/);
    if (request.method === "POST" && weeklyFeePath !== null) {
      const referralCaseId = weeklyFeePath[1];
      if (referralCaseId === undefined || referralCaseId.trim() === "") throw new Error("INVALID_INPUT:referralCaseId");
      const session = services.sessions.get(sessionIdFrom(body), services.now());
      const idempotencyKey = requiredString(body, "idempotencyKey");
      return success(services.weeklyFees.recordWeeklyFee(
        currentContext(session),
        weeklyDraft({ ...body, referralCaseId }),
        idempotencyKey
      ));
    }
    throw new Error("NOT_FOUND");
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_FOUND") {
      return { status: 404, body: { version: API_CONTRACT_VERSION, error: { code: "NOT_FOUND", message: "NOT_FOUND" } } };
    }
    return failure(error);
  }
};
