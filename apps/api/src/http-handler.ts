import {
  API_CONTRACT_VERSION,
  API_ERROR_CODES,
  type HttpMethod,
  type PermissionSubject,
  type RoleContext
} from "@teaching-research-alliance/contracts";
import type { ReferralCreationDraft } from "./postgres-referral-creation-service.js";
import type { RatePolicyDraft, WeeklyFeeDraft } from "@teaching-research-alliance/domain";
import { RatePolicyService } from "@teaching-research-alliance/domain";
import { type SessionView } from "./session-service.js";

export type ApiRequest = Readonly<{
  method: HttpMethod;
  path: string;
  body: unknown;
  sessionId?: string;
}>;

export type ApiResponse = Readonly<{
  status: number;
  body: Readonly<{
    version: string;
    data?: unknown;
    error?: Readonly<{ code: string; message: string }>;
  }>;
}>;

export type WeeklyFeeApiService = Readonly<{
  acceptReferral: (context: RoleContext, referralId: string) => unknown | Promise<unknown>;
  recordWeeklyFee: (
    context: RoleContext,
    draft: WeeklyFeeDraft,
    idempotencyKey: string
  ) => unknown | Promise<unknown>;
}>;

export type SessionApiService = Readonly<{
  credentialField?: "password";
  logout?: (sessionId: string) => void | Promise<void>;
  login: (phone: string, credential: string, at: Date) => SessionView | Promise<SessionView>;
  get: (sessionId: string, at: Date) => SessionView | Promise<SessionView>;
  switchRole: (sessionId: string, subject: PermissionSubject, at: Date) => SessionView | Promise<SessionView>;
}>;

export type ApiServices = Readonly<{
  sessions: SessionApiService;
  weeklyFees: WeeklyFeeApiService;
  ratePolicies?: RatePolicyService;
  personal?: Readonly<{
    getOwnOverview: (context: RoleContext, at: Date) => unknown | Promise<unknown>;
    listAvailableVenues: (context: RoleContext) => unknown | Promise<unknown>;
  }>;
  referrals?: Readonly<{
    create: (context: RoleContext, draft: ReferralCreationDraft, key: string, at: Date) => unknown | Promise<unknown>;
    listReceivingTeachers: (context: RoleContext) => unknown | Promise<unknown>;
  }>;
  sentReferrals?: Readonly<{
    list: (context: RoleContext, at: Date) => unknown | Promise<unknown>;
  }>;
  referralAcceptance?: Readonly<{
    accept: (context: RoleContext, referralId: string, draft: {venueId?: string; expectedVersion: number}, key: string, at: Date) => unknown | Promise<unknown>;
  }>;
  teaching?: Readonly<{
    listReceivedReferrals: (context: RoleContext, at: Date) => unknown | Promise<unknown>;
    listOpenTeachingWeeks: (context: RoleContext, at: Date) => unknown | Promise<unknown>;
  }>;
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
  if (code === "INTERNAL_ERROR") return 500;
  if (code === "UNAUTHENTICATED") return 401;
  if (code === "FORBIDDEN_SCOPE" || code === "ROLE_CONTEXT_REQUIRED" || code === "ROLE_CONTEXT_NOT_ASSIGNED" || code === "ROLE_CONTEXT_AMBIGUOUS") return 403;
  if (code.endsWith("_NOT_FOUND")) return 404;
  if (code === "PERIOD_LOCKED" || code === "IDEMPOTENCY_REPLAY" || code === "VERSION_CONFLICT") return 409;
  if (code === "VENUE_CHANGE_REQUIRED" || code === "REFERRAL_ALREADY_ACCEPTED") return 409;
  return 400;
};

const success = (data: unknown): ApiResponse => ({
  status: 200,
  body: { version: API_CONTRACT_VERSION, data }
});

const failure = (error: unknown): ApiResponse => {
  const rawCode = error instanceof Error ? error.message.split(":", 1)[0] : undefined;
  const inputErrors = ["INVALID_WEEKLY_FEE", "PERIOD_MONTH_MISMATCH", "VENUE_NOT_ACTIVE", "REFERRAL_NOT_ACCEPTABLE"];
  const code = rawCode && (API_ERROR_CODES as readonly string[]).includes(rawCode)
    ? rawCode : rawCode && inputErrors.includes(rawCode) ? "INVALID_INPUT" : "INTERNAL_ERROR";
  return {
    status: errorStatus(code),
    body: { version: API_CONTRACT_VERSION, error: { code, message: code } }
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
    if (!/^\d+$/.test(value)) throw new Error("INVALID_INPUT:grossAmountCents");
    try {
      return BigInt(value);
    } catch {
      throw new Error("INVALID_INPUT:grossAmountCents");
    }
  })(),
  expectedVersion: (() => {
    const value = body.expectedVersion;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error("INVALID_INPUT:expectedVersion");
    }
    return value;
  })()
});

const requiredBigInt = (body: Record<string, unknown>, key: string): bigint => {
  const value = requiredString(body, key);
  try {
    return BigInt(value);
  } catch {
    throw new Error(`INVALID_INPUT:${key}`);
  }
};

const optionalBigInt = (value: unknown, key: string): bigint | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new Error(`INVALID_INPUT:${key}`);
  try {
    return BigInt(value);
  } catch {
    throw new Error(`INVALID_INPUT:${key}`);
  }
};

const ratePolicyDraft = (body: Record<string, unknown>): RatePolicyDraft => {
  const rawTiers = body.dynamicTiers;
  if (!Array.isArray(rawTiers)) throw new Error("INVALID_INPUT:dynamicTiers");
  const dynamicTiers = rawTiers.map((rawTier, index) => {
    if (typeof rawTier !== "object" || rawTier === null || Array.isArray(rawTier)) {
      throw new Error(`INVALID_INPUT:dynamicTiers[${index}]`);
    }
    const tier = rawTier as Record<string, unknown>;
    const parsed: { label: string; adjustmentBasisPoints: bigint; minExclusive?: bigint; maxInclusive?: bigint } = {
      label: requiredString(tier, "label"),
      adjustmentBasisPoints: requiredBigInt(tier, "adjustmentBasisPoints")
    };
    const minExclusive = optionalBigInt(tier.minExclusive, `dynamicTiers[${index}].minExclusive`);
    if (minExclusive !== undefined) parsed.minExclusive = minExclusive;
    const maxInclusive = optionalBigInt(tier.maxInclusive, `dynamicTiers[${index}].maxInclusive`);
    if (maxInclusive !== undefined) parsed.maxInclusive = maxInclusive;
    return parsed;
  });
  return {
    plannerBaseRateBasisPoints: requiredBigInt(body, "plannerBaseRateBasisPoints"),
    teacherBaseRateBasisPoints: requiredBigInt(body, "teacherBaseRateBasisPoints"),
    planningMentorWeightBasisPoints: requiredBigInt(body, "planningMentorWeightBasisPoints"),
    groupLeaderRateBasisPoints: requiredBigInt(body, "groupLeaderRateBasisPoints"),
    teachingMentorRateBasisPoints: requiredBigInt(body, "teachingMentorRateBasisPoints"),
    venueRateBasisPoints: requiredBigInt(body, "venueRateBasisPoints"),
    campusConsultationForPlannerRateBasisPoints: requiredBigInt(body, "campusConsultationForPlannerRateBasisPoints"),
    campusConsultationForTeacherRateBasisPoints: requiredBigInt(body, "campusConsultationForTeacherRateBasisPoints"),
    platformFinanceRateBasisPoints: requiredBigInt(body, "platformFinanceRateBasisPoints"),
    regionFinanceRateBasisPoints: requiredBigInt(body, "regionFinanceRateBasisPoints"),
    dynamicTiers,
    effectiveFrom: requiredString(body, "effectiveFrom"),
    reason: requiredString(body, "reason")
  };
};

export const handleRequest = async (request: ApiRequest, services: ApiServices): Promise<ApiResponse> => {
  try {
    const at = services.now();
    const parsedBody = objectBody(request.body);
    const body = request.sessionId === undefined ? parsedBody : { ...parsedBody, sessionId: request.sessionId };
    if (request.method === "POST" && request.path === "/v1/session/logout") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim()) throw new Error("UNAUTHENTICATED");
      if (!services.sessions.logout) throw new Error("SESSION_LOGOUT_UNAVAILABLE");
      await services.sessions.logout(sessionIdFrom(body));
      return success({ loggedOut: true });
    }
    if (request.method === "GET" && request.path === "/v1/session") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim()) throw new Error("UNAUTHENTICATED");
      return success(sessionData(await services.sessions.get(sessionIdFrom(body), at)));
    }
    if (request.method === "GET" && ["/v1/teaching/referrals", "/v1/teaching/weeks"].includes(request.path)) {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim()) throw new Error("UNAUTHENTICATED");
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      if (!services.teaching) throw new Error("TEACHING_SERVICE_UNAVAILABLE");
      return success(request.path === "/v1/teaching/referrals"
        ? await services.teaching.listReceivedReferrals(context, at)
        : await services.teaching.listOpenTeachingWeeks(context, at));
    }
    if (request.method === "GET" && (request.path === "/v1/me" || request.path === "/v1/venues/available")) {
      if (typeof body.sessionId !== "string" || body.sessionId.trim() === "") throw new Error("UNAUTHENTICATED");
      const session = await services.sessions.get(sessionIdFrom(body), at);
      const context = currentContext(session);
      if (services.personal === undefined) throw new Error("PERSONAL_SERVICE_UNAVAILABLE");
      return success(request.path === "/v1/me"
        ? await services.personal.getOwnOverview(context, at)
        : await services.personal.listAvailableVenues(context));
    }
    if (request.method === "POST" && request.path === "/v1/session") {
      const view = await services.sessions.login(
        requiredString(body, "phoneNormalized"),
        requiredString(body, services.sessions.credentialField ?? "credentialDigest"),
        at
      );
      return success(sessionData(view));
    }
    if (request.method === "POST" && request.path === "/v1/role-contexts/switch") {
      const view = await services.sessions.switchRole(
        sessionIdFrom(body),
        subjectFrom(requiredString(body, "subject")),
        at
      );
      return success(sessionData(view));
    }
    if (request.method === "POST" && request.path === "/v1/admin/rates/preview") {
      if (services.ratePolicies === undefined) throw new Error("RATE_POLICY_SERVICE_UNAVAILABLE");
      const session = await services.sessions.get(sessionIdFrom(body), at);
      return success(services.ratePolicies.preview(currentContext(session).subject, ratePolicyDraft(body)));
    }
    if (request.method === "POST" && request.path === "/v1/admin/rates/publish") {
      if (services.ratePolicies === undefined) throw new Error("RATE_POLICY_SERVICE_UNAVAILABLE");
      const session = await services.sessions.get(sessionIdFrom(body), at);
      return success(services.ratePolicies.publish(currentContext(session).subject, requiredString(body, "previewId")));
    }
    if (request.method === "GET" && request.path === "/v1/referrals/sent") {
      const session = await services.sessions.get(request.sessionId ?? "", at);
      if (!services.sentReferrals) throw new Error("REFERRAL_SERVICE_UNAVAILABLE");
      return success(await services.sentReferrals.list(currentContext(session), at));
    }
    if (request.method === "GET" && request.path === "/v1/referrals/receiving-teachers") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim()) throw new Error("UNAUTHENTICATED");
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      if (!services.referrals) throw new Error("REFERRAL_SERVICE_UNAVAILABLE");
      return success(await services.referrals.listReceivingTeachers(context));
    }
    if (request.method === "POST" && request.path === "/v1/referrals") {
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      if (!services.referrals) throw new Error("REFERRAL_SERVICE_UNAVAILABLE");
      for (const key of ["referrerPersonId","referrerIdentity","sourceSubject","campusId","planningMentorPersonId"]) {
        if (key in body) throw new Error("INVALID_INPUT");
      }
      const classType = requiredString(body, "classType");
      if (classType !== "ONE_TO_ONE" && classType !== "SMALL_GROUP") throw new Error("INVALID_INPUT");
      return success(await services.referrals.create(context, {
        receiverPersonId: requiredString(body,"receiverPersonId"),
        studentDisplayName: requiredString(body,"studentDisplayName"),
        courseContextId: requiredString(body,"courseContextId"), classType
      }, requiredString(body,"idempotencyKey"), at));
    }
    const acceptPath = request.path.match(/^\/v1\/referrals\/([^/]+)\/accept$/);
    if (request.method === "POST" && acceptPath !== null) {
      const referralId = acceptPath[1];
      if (referralId === undefined || referralId.trim() === "") throw new Error("INVALID_INPUT:referralId");
      const session = await services.sessions.get(sessionIdFrom(body), at);
      if (!services.referralAcceptance) throw new Error("REFERRAL_ACCEPTANCE_UNAVAILABLE");
      for (const key of ["personId", "receiverPersonId", "venueOwnerPersonId", "isSelfUse", "acceptedBy"]) {
        if (key in body) throw new Error("INVALID_INPUT");
      }
      const expectedVersion = body.expectedVersion;
      if (typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error("INVALID_INPUT");
      return success(await services.referralAcceptance.accept(currentContext(session), referralId, {
        expectedVersion, ...(body.venueId === undefined ? {} : {venueId: requiredString(body, "venueId")})
      }, requiredString(body, "idempotencyKey"), at));
    }
    const weeklyFeePath = request.path.match(/^\/v1\/referrals\/([^/]+)\/weekly-fees$/);
    if (request.method === "POST" && weeklyFeePath !== null) {
      const referralCaseId = weeklyFeePath[1];
      if (referralCaseId === undefined || referralCaseId.trim() === "") throw new Error("INVALID_INPUT:referralCaseId");
      const session = await services.sessions.get(sessionIdFrom(body), at);
      const idempotencyKey = requiredString(body, "idempotencyKey");
      return success(await services.weeklyFees.recordWeeklyFee(
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
