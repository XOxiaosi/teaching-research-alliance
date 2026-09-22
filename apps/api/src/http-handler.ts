import {
  API_CONTRACT_VERSION,
  API_ERROR_CODES,
  type HttpMethod,
  type PermissionSubject,
  type RoleContext
} from "@teaching-research-alliance/contracts";
import type { ReferralCreationDraft } from "./postgres-referral-creation-service.js";
import type { FinanceAttachmentReservationDraft } from "./postgres-finance-attachment-service.js";
import type { RatePolicyDraft, WeeklyFeeDraft } from "@teaching-research-alliance/domain";
import { RatePolicyService } from "@teaching-research-alliance/domain";
import { type SessionView } from "./session-service.js";

export type ApiRequest = Readonly<{
  method: HttpMethod;
  path: string;
  body: unknown;
  /** Decoded URL query; the HTTP server rejects duplicate keys before reaching this boundary. */
  query?: Readonly<Record<string, string>>;
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
  venues?: Readonly<{
    create: (context: RoleContext, draft: {name: string; makeDefault?: boolean}, key: string, at: Date) => unknown | Promise<unknown>;
    rename: (context: RoleContext, id: string, draft: {name: string; expectedVersion: number}, key: string, at: Date) => unknown | Promise<unknown>;
    setStatus: (context: RoleContext, id: string, draft: {status: "ACTIVE"|"INACTIVE"; expectedVersion: number}, key: string, at: Date) => unknown | Promise<unknown>;
    setDefault: (context: RoleContext, id: string, draft: {expectedVersion: number}, key: string, at: Date) => unknown | Promise<unknown>;
    setPermission: (context: RoleContext, id: string, draft: {granteePersonId: string; canView: boolean; canWithdraw: boolean; expectedGrantId?: string|null}, key: string, at: Date) => unknown | Promise<unknown>;
  }>;
  venueReads?: Readonly<{ list: (context: RoleContext, at: Date) => unknown | Promise<unknown>; listOwned: (context: RoleContext, at: Date) => unknown | Promise<unknown>; get: (context: RoleContext, id: string, at: Date) => unknown | Promise<unknown>; }>;
  venueBoards?: Readonly<{
    get: (context: RoleContext, id: string, filter: { teachingWeekId?: string; startsOn?: string; endsOn?: string }, at: Date) => unknown | Promise<unknown>;
  }>;
  referrals?: Readonly<{
    create: (context: RoleContext, draft: ReferralCreationDraft, key: string, at: Date) => unknown | Promise<unknown>;
    copy?: (context: RoleContext, sourceReferralId: string, draft: {receiverPersonId: string; courseContextId?: string; classType?: "ONE_TO_ONE" | "SMALL_GROUP"}, key: string, at: Date) => unknown | Promise<unknown>;
    listReceivingTeachers: (context: RoleContext) => unknown | Promise<unknown>;
  }>;
  sentReferrals?: Readonly<{
    list: (context: RoleContext, at: Date) => unknown | Promise<unknown>;
  }>;
  referralAcceptance?: Readonly<{
    accept: (context: RoleContext, referralId: string, draft: {venueId?: string; expectedVersion: number}, key: string, at: Date) => unknown | Promise<unknown>;
  }>;
  referralLifecycle?: Readonly<{
    archive: (context: RoleContext, referralId: string, draft: {expectedVersion: number}, key: string, at: Date) => unknown | Promise<unknown>;
    reactivate: (context: RoleContext, referralId: string, draft: {expectedVersion: number}, key: string, at: Date) => unknown | Promise<unknown>;
  }>;
  financeDrafts?: Readonly<{
    create: (context: RoleContext, draft: {kind: "WITHDRAWAL" | "REIMBURSEMENT" | "EXTERNAL_PAYMENT" | "REFUND" | "SELF_PURCHASE"}, key: string, at: Date) => unknown | Promise<unknown>;
    listOwn: (context: RoleContext, at: Date) => unknown | Promise<unknown>;
    getOwn: (context: RoleContext, id: string, at: Date) => unknown | Promise<unknown>;
  }>;
  companyFunds?: Readonly<{
    create: (context: RoleContext, draft: {fundCode:string;displayName:string;organizationUnitId?:string}, key:string, at:Date) => unknown | Promise<unknown>;
    list: (context:RoleContext, at:Date) => unknown | Promise<unknown>;
    assign: (context:RoleContext, draft:{fundId:string;expectedAssignmentId:string|null;reason:string}, key:string, at:Date) => unknown | Promise<unknown>;
    setStatus: (context:RoleContext, id:string, draft:{expectedVersion:number;status:"ACTIVE"|"INACTIVE";reason:string}, key:string, at:Date) => unknown | Promise<unknown>;
  }>;
  selfPurchases?: Readonly<{
    submit: (context:RoleContext, id:string, draft:{expectedVersion:number;amountCents:string;reason:string;attachmentVersionIds:readonly string[]}, key:string, at:Date) => unknown | Promise<unknown>;
  }>;
  selfPurchaseReversals?: Readonly<{
    reverse: (context:RoleContext, id:string, draft:{expectedVersion:number;reason:string}, key:string, at:Date) => unknown | Promise<unknown>;
  }>;
  refunds?: Readonly<{
    submit: (context:RoleContext, id:string, draft:{expectedVersion:number;weeklyFeeEntryIds:readonly string[];reason:string;attachmentVersionIds:readonly string[]}, key:string, at:Date) => unknown | Promise<unknown>;
  }>;
  refundReviews?: Readonly<{
    approve: (context:RoleContext, id:string, draft:{expectedVersion:number;reason:string}, key:string, at:Date) => unknown | Promise<unknown>;
    reject: (context:RoleContext, id:string, draft:{expectedVersion:number;reason:string}, key:string, at:Date) => unknown | Promise<unknown>;
  }>;
  refundReads?: Readonly<{
    listOwn: (context:RoleContext, at:Date) => unknown | Promise<unknown>;
    listManaged: (context:RoleContext) => unknown | Promise<unknown>;
    getDetail: (context:RoleContext, id:string, at:Date) => unknown | Promise<unknown>;
  }>;
  reimbursements?: Readonly<{
    submit: (context:RoleContext, id:string, draft:{expectedVersion:number;amountCents:string;reason:string;attachmentVersionIds:readonly string[]}, key:string, at:Date) => unknown | Promise<unknown>;
  }>;
  reimbursementReviews?: Readonly<{
    approve: (context:RoleContext, id:string, draft:{expectedVersion:number;reason:string}, key:string, at:Date) => unknown | Promise<unknown>;
    reject: (context:RoleContext, id:string, draft:{expectedVersion:number;reason:string}, key:string, at:Date) => unknown | Promise<unknown>;
  }>;
  reimbursementReads?: Readonly<{
    listOwn: (context:RoleContext, at:Date) => unknown | Promise<unknown>;
    listManaged: (context:RoleContext) => unknown | Promise<unknown>;
    getDetail: (context:RoleContext, id:string, at:Date) => unknown | Promise<unknown>;
  }>;
  selfPurchaseReads?: Readonly<{
    listOwn: (context:RoleContext, at:Date) => unknown | Promise<unknown>;
    listManaged: (context:RoleContext) => unknown | Promise<unknown>;
    getDetail: (context:RoleContext, id:string, at:Date) => unknown | Promise<unknown>;
  }>;
  financeAttachments?: Readonly<{
    reserve: (context: RoleContext, documentId: string, draft: FinanceAttachmentReservationDraft, key: string, at: Date) => unknown | Promise<unknown>;
    getOwnVersion: (context: RoleContext, versionId: string, at: Date) => unknown | Promise<unknown>;
    reserveNextVersion?: (context: RoleContext, attachmentId: string, draft: Omit<FinanceAttachmentReservationDraft, "purpose">, key: string, at: Date) => unknown | Promise<unknown>;
    listDocument?: (context: RoleContext, documentId: string, at: Date) => unknown | Promise<unknown>;
  }>;
  financeAttachmentUploads?: Readonly<{
    upload: (context: RoleContext, versionId: string, chunks: AsyncIterable<Uint8Array>, at: Date) => unknown | Promise<unknown>;
  }>;
  financeAttachmentReads?: Readonly<{
    readOwn: (context: RoleContext, versionId: string, at: Date) => Promise<Readonly<{bytes:Buffer;mediaType:string;originalFilename:string;sha256:string;sizeBytes:number}>>;
  }>;
  withdrawals?: Readonly<{
    submit: (context: RoleContext, id: string, draft: { expectedVersion: number; sourceAccountId: string; amountCents: string; recipientName: string; bankAccount: string; bankName?: string; attachmentVersionIds: readonly string[] }, key: string, at: Date) => unknown | Promise<unknown>;
    revoke: (context: RoleContext, id: string, draft: { expectedVersion: number; reason: string }, key: string, at: Date) => unknown | Promise<unknown>;
    markTransferred: (context: RoleContext, id: string, draft: { expectedVersion: number; attachmentVersionIds: readonly string[] }, key: string, at: Date) => unknown | Promise<unknown>;
  }>;
  withdrawalReads?: Readonly<{
    listSources: (context: RoleContext, at: Date) => unknown | Promise<unknown>;
    listOwn: (context: RoleContext, at: Date) => unknown | Promise<unknown>;
    listPending: (context: RoleContext) => unknown | Promise<unknown>;
    listManaged: (context: RoleContext) => unknown | Promise<unknown>;
    getDetail: (context: RoleContext, id: string, at: Date) => unknown | Promise<unknown>;
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
  if (code === "VENUE_SERVICE_UNAVAILABLE") return 503;
  if (code === "VENUE_DATA_UNAVAILABLE") return 500;
  if(code==="FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE"||code==="FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE"||code==="FINANCE_REFUND_DATA_UNAVAILABLE")return 500;
  if(["REIMBURSEMENT_STATE_CONFLICT","REFUND_STATE_CONFLICT","WEEKLY_FEE_REFUNDED"].includes(code))return 409;
  if(code==="HEADQUARTERS_FINANCE_ASSIGNMENT_REQUIRED")return 403;
  if(["SELF_PURCHASE_STATE_CONFLICT","HEADQUARTERS_FINANCE_ASSIGNMENT_AMBIGUOUS","COMPANY_FUND_ASSIGNMENT_NOT_FOUND"].includes(code))return 409;
  if (code === "INTERNAL_ERROR" || code === "FINANCE_RECIPIENT_UNAVAILABLE" || code === "FINANCE_WITHDRAWAL_DATA_UNAVAILABLE") return 500;
  if (code === "FINANCE_SERVICE_UNAVAILABLE") return 503;
  if (code === "FINANCE_WITHDRAWAL_STATE_CONFLICT" || code === "INSUFFICIENT_BALANCE" || code === "SOURCE_ACCOUNT_NOT_ACTIVE") return 409;
  if (["COMPANY_FUND_CONFLICT","COMPANY_FUND_ASSIGNMENT_CONFLICT","COMPANY_FUND_INACTIVE"].includes(code)) return 409;
  if (code === "SOURCE_ACCOUNT_FORBIDDEN") return 403;
  if (["ATTACHMENT_STORAGE_UNAVAILABLE","ATTACHMENT_VALIDATOR_BUSY","ATTACHMENT_VALIDATION_TIMEOUT","ATTACHMENT_PUBLICATION_REQUIRES_RECONCILIATION"].includes(code)) return 503;
  if (["ATTACHMENT_INTEGRITY_FAILED","ATTACHMENT_UNAVAILABLE"].includes(code)) return 500;
  if (["FINANCE_ATTACHMENT_NOT_READY","FINANCE_ATTACHMENT_FAILED"].includes(code)) return 409;
  if (code === "UNAUTHENTICATED") return 401;
  if (code === "FORBIDDEN_SCOPE" || code === "ROLE_CONTEXT_REQUIRED" || code === "ROLE_CONTEXT_NOT_ASSIGNED" || code === "ROLE_CONTEXT_AMBIGUOUS") return 403;
  if (code.endsWith("_NOT_FOUND")) return 404;
  if (code === "PERIOD_LOCKED" || code === "IDEMPOTENCY_REPLAY" || code === "VERSION_CONFLICT") return 409;
  if (code === "VENUE_CHANGE_REQUIRED" || code === "REFERRAL_ALREADY_ACCEPTED" || code === "REFERRAL_STATE_CONFLICT") return 409;
  return 400;
};

const success = (data: unknown): ApiResponse => ({
  status: 200,
  body: { version: API_CONTRACT_VERSION, data }
});

export const failure = (error: unknown): ApiResponse => {
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
    if (request.method === "POST" && request.path === "/v1/venues") {
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      if (!services.venues) throw new Error("VENUE_SERVICE_UNAVAILABLE");
      const makeDefault = body.makeDefault === undefined ? undefined : body.makeDefault;
      if (makeDefault !== undefined && typeof makeDefault !== "boolean") throw new Error("INVALID_INPUT");
      return success(await services.venues.create(context, { name: requiredString(body, "name"), ...(makeDefault === undefined ? {} : { makeDefault }) }, requiredString(body, "idempotencyKey"), at));
    }
    if (request.method === "GET" && request.path === "/v1/venues/mine") {
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      if (!services.venueReads) throw new Error("VENUE_SERVICE_UNAVAILABLE");
      return success(await services.venueReads.listOwned(context, at));
    }
    const venueBoardPath = request.path.match(/^\/v1\/venues\/([^/]+)\/board$/);
    if (request.method === "GET" && venueBoardPath) {
      const query = request.query ?? {};
      if (Object.keys(query).some((key) => !["weekId", "startsOn", "endsOn"].includes(key))) throw new Error("INVALID_INPUT");
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      if (!services.venueBoards) throw new Error("VENUE_SERVICE_UNAVAILABLE");
      return success(await services.venueBoards.get(context, venueBoardPath[1]!, {
        ...(query.weekId === undefined ? {} : { teachingWeekId: query.weekId }),
        ...(query.startsOn === undefined ? {} : { startsOn: query.startsOn }),
        ...(query.endsOn === undefined ? {} : { endsOn: query.endsOn })
      }, at));
    }
    const venuePath = request.path.match(/^\/v1\/venues\/([^/]+)$/);
    if (request.method === "GET" && venuePath) {
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      if (!services.venueReads) throw new Error("VENUE_SERVICE_UNAVAILABLE");
      return success(await services.venueReads.get(context, venuePath[1]!, at));
    }
    if (venuePath && request.method === "PATCH") {
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      if (!services.venues) throw new Error("VENUE_SERVICE_UNAVAILABLE");
      const expectedVersion = body.expectedVersion;
      if (typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error("INVALID_INPUT");
      const command = requiredString(body, "idempotencyKey");
      if (body.name !== undefined && typeof body.name === "string") return success(await services.venues.rename(context, venuePath[1]!, { name: body.name, expectedVersion }, command, at));
      if (body.status === "ACTIVE" || body.status === "INACTIVE") return success(await services.venues.setStatus(context, venuePath[1]!, { status: body.status, expectedVersion }, command, at));
      throw new Error("INVALID_INPUT");
    }
    const defaultVenuePath = request.path.match(/^\/v1\/venues\/([^/]+)\/default$/);
    if (request.method === "POST" && defaultVenuePath) {
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      if (!services.venues) throw new Error("VENUE_SERVICE_UNAVAILABLE");
      if (typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) throw new Error("INVALID_INPUT");
      return success(await services.venues.setDefault(context, defaultVenuePath[1]!, { expectedVersion: body.expectedVersion }, requiredString(body, "idempotencyKey"), at));
    }
    const permissionVenuePath = request.path.match(/^\/v1\/venues\/([^/]+)\/permissions$/);
    if (request.method === "POST" && permissionVenuePath) {
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      if (!services.venues) throw new Error("VENUE_SERVICE_UNAVAILABLE");
      if (typeof body.canView !== "boolean" || typeof body.canWithdraw !== "boolean") throw new Error("INVALID_INPUT");
      if (body.expectedGrantId !== undefined && body.expectedGrantId !== null && typeof body.expectedGrantId !== "string") throw new Error("INVALID_INPUT");
      const permissionDraft = { granteePersonId: requiredString(body, "granteePersonId"), canView: body.canView, canWithdraw: body.canWithdraw, ...(body.expectedGrantId === undefined ? {} : { expectedGrantId: body.expectedGrantId as string | null }) };
      return success(await services.venues.setPermission(context, permissionVenuePath[1]!, permissionDraft, requiredString(body, "idempotencyKey"), at));
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
    if (request.path === "/v1/finance/drafts" && request.method === "POST") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim()) throw new Error("UNAUTHENTICATED");
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      if (!services.financeDrafts) throw new Error("FINANCE_DRAFT_SERVICE_UNAVAILABLE");
      if (Object.keys(body).some(key => !["sessionId","kind","idempotencyKey"].includes(key))) throw new Error("INVALID_INPUT");
      const kind = requiredString(body,"kind");
      if (kind !== "WITHDRAWAL" && kind !== "REIMBURSEMENT" && kind !== "EXTERNAL_PAYMENT" && kind !== "REFUND" && kind !== "SELF_PURCHASE") throw new Error("INVALID_INPUT");
      return success(await services.financeDrafts.create(context,{kind},requiredString(body,"idempotencyKey"),at));
    }
    if (request.path === "/v1/finance/drafts/mine" && request.method === "GET") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim()) throw new Error("UNAUTHENTICATED");
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      if (!services.financeDrafts) throw new Error("FINANCE_DRAFT_SERVICE_UNAVAILABLE");
      return success(await services.financeDrafts.listOwn(context,at));
    }
    const financeDraftPath = request.path.match(/^\/v1\/finance\/drafts\/([^/]+)$/);
    if (financeDraftPath !== null && request.method === "GET") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim()) throw new Error("UNAUTHENTICATED");
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      if (!services.financeDrafts) throw new Error("FINANCE_DRAFT_SERVICE_UNAVAILABLE");
      return success(await services.financeDrafts.getOwn(context,financeDraftPath[1]!,at));
    }
    const withdrawalSubmitPath=request.path.match(/^\/v1\/finance\/drafts\/([^/]+)\/withdrawal-submit$/);
    const withdrawalActionPath=request.path.match(/^\/v1\/finance\/withdrawals\/([^/]+)\/(finance-revoke|mark-transferred)$/);
    if(request.method==="POST"&&(withdrawalSubmitPath||withdrawalActionPath)){
      if(typeof body.sessionId!=="string"||!body.sessionId.trim())throw new Error("UNAUTHENTICATED");
      const context=currentContext(await services.sessions.get(sessionIdFrom(body),at));
      if(!services.withdrawals)throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      const common=["sessionId","expectedVersion","idempotencyKey"];
      const allowed=withdrawalSubmitPath?[...common,"sourceAccountId","amountCents","recipientName","bankAccount","bankName","attachmentVersionIds"]
        :withdrawalActionPath![2]==="finance-revoke"?[...common,"reason"]:[...common,"attachmentVersionIds"];
      if(Object.keys(body).some(key=>!allowed.includes(key))||typeof body.expectedVersion!=="number"
        ||!Number.isSafeInteger(body.expectedVersion)||body.expectedVersion<1)throw new Error("INVALID_INPUT");
      const expectedVersion=body.expectedVersion,key=requiredString(body,"idempotencyKey");
      if(withdrawalActionPath?.[2]==="finance-revoke")return success(await services.withdrawals.revoke(context,withdrawalActionPath[1]!,{expectedVersion,reason:requiredString(body,"reason")},key,at));
      if(!Array.isArray(body.attachmentVersionIds)||body.attachmentVersionIds.length===0||body.attachmentVersionIds.length>20
        ||body.attachmentVersionIds.some(id=>typeof id!=="string"))throw new Error("INVALID_INPUT");
      const attachmentVersionIds=body.attachmentVersionIds as string[];
      if(withdrawalSubmitPath)return success(await services.withdrawals.submit(context,withdrawalSubmitPath[1]!,{
        expectedVersion,sourceAccountId:requiredString(body,"sourceAccountId"),amountCents:requiredString(body,"amountCents"),
        recipientName:requiredString(body,"recipientName"),bankAccount:requiredString(body,"bankAccount"),
        ...(body.bankName===undefined?{}:{bankName:requiredString(body,"bankName")}),attachmentVersionIds
      },key,at));
      return success(await services.withdrawals.markTransferred(context,withdrawalActionPath![1]!,{expectedVersion,attachmentVersionIds},key,at));
    }
    const withdrawalReadPath=request.path.match(/^\/v1\/finance\/withdrawals\/([^/]+)$/);
    if(request.method==="GET"&&withdrawalReadPath){
      if(typeof body.sessionId!=="string"||!body.sessionId.trim())throw new Error("UNAUTHENTICATED");
      const context=currentContext(await services.sessions.get(sessionIdFrom(body),at));
      if(!services.withdrawalReads)throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      const id=withdrawalReadPath[1]!;
      if(id==="sources")return success(await services.withdrawalReads.listSources(context,at));
      if(id==="mine")return success(await services.withdrawalReads.listOwn(context,at));
      if(id==="pending-transfer")return success(await services.withdrawalReads.listPending(context));
      if(id==="managed")return success(await services.withdrawalReads.listManaged(context));
      return success(await services.withdrawalReads.getDetail(context,id,at));
    }
    const refundSubmitPath=request.path.match(/^\/v1\/finance\/drafts\/([^/]+)\/refund-submit$/);
    if(refundSubmitPath!==null&&request.method==="POST"){
      if(typeof body.sessionId!=="string"||!body.sessionId.trim())throw new Error("UNAUTHENTICATED");
      const context=currentContext(await services.sessions.get(sessionIdFrom(body),at));
      if(!services.refunds)throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      if(Object.keys(body).some(key=>!["sessionId","expectedVersion","weeklyFeeEntryIds","reason","attachmentVersionIds","idempotencyKey"].includes(key))
        ||typeof body.expectedVersion!=="number"||!Number.isSafeInteger(body.expectedVersion)||body.expectedVersion<1
        ||!Array.isArray(body.weeklyFeeEntryIds)||!body.weeklyFeeEntryIds.every(id=>typeof id==="string")
        ||!Array.isArray(body.attachmentVersionIds)||!body.attachmentVersionIds.every(id=>typeof id==="string"))throw new Error("INVALID_INPUT");
      return success(await services.refunds.submit(context,refundSubmitPath[1]!,{
        expectedVersion:body.expectedVersion,weeklyFeeEntryIds:body.weeklyFeeEntryIds as string[],reason:requiredString(body,"reason"),attachmentVersionIds:body.attachmentVersionIds as string[]
      },requiredString(body,"idempotencyKey"),at));
    }
    const refundReviewPath=request.path.match(/^\/v1\/finance\/refunds\/([^/]+)\/(approve|reject)$/);
    if(refundReviewPath!==null&&request.method==="POST"){
      if(typeof body.sessionId!=="string"||!body.sessionId.trim())throw new Error("UNAUTHENTICATED");
      const context=currentContext(await services.sessions.get(sessionIdFrom(body),at));
      if(!services.refundReviews)throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      if(Object.keys(body).some(key=>!["sessionId","expectedVersion","reason","idempotencyKey"].includes(key))
        ||typeof body.expectedVersion!=="number"||!Number.isSafeInteger(body.expectedVersion)||body.expectedVersion<1)throw new Error("INVALID_INPUT");
      return success(await services.refundReviews[refundReviewPath[2] as "approve"|"reject"](context,refundReviewPath[1]!,{
        expectedVersion:body.expectedVersion,reason:requiredString(body,"reason")
      },requiredString(body,"idempotencyKey"),at));
    }
    const refundReadPath=request.path.match(/^\/v1\/finance\/refunds\/([^/]+)$/);
    if(refundReadPath!==null&&request.method==="GET"){
      if(typeof body.sessionId!=="string"||!body.sessionId.trim())throw new Error("UNAUTHENTICATED");
      const context=currentContext(await services.sessions.get(sessionIdFrom(body),at));
      if(!services.refundReads)throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      const id=refundReadPath[1]!;
      if(id==="mine")return success(await services.refundReads.listOwn(context,at));
      if(id==="managed")return success(await services.refundReads.listManaged(context));
      return success(await services.refundReads.getDetail(context,id,at));
    }
    const reimbursementSubmitPath=request.path.match(/^\/v1\/finance\/drafts\/([^/]+)\/reimbursement-submit$/);
    if(reimbursementSubmitPath!==null&&request.method==="POST"){
      if(typeof body.sessionId!=="string"||!body.sessionId.trim())throw new Error("UNAUTHENTICATED");
      const context=currentContext(await services.sessions.get(sessionIdFrom(body),at));
      if(!services.reimbursements)throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      if(Object.keys(body).some(key=>!["sessionId","expectedVersion","amountCents","reason","attachmentVersionIds","idempotencyKey"].includes(key))
        ||typeof body.expectedVersion!=="number"||!Number.isSafeInteger(body.expectedVersion)||body.expectedVersion<1
        ||!Array.isArray(body.attachmentVersionIds)||!body.attachmentVersionIds.every(id=>typeof id==="string"))throw new Error("INVALID_INPUT");
      return success(await services.reimbursements.submit(context,reimbursementSubmitPath[1]!,{
        expectedVersion:body.expectedVersion,amountCents:requiredString(body,"amountCents"),reason:requiredString(body,"reason"),attachmentVersionIds:body.attachmentVersionIds as string[]
      },requiredString(body,"idempotencyKey"),at));
    }
    const reimbursementReviewPath=request.path.match(/^\/v1\/finance\/reimbursements\/([^/]+)\/(approve|reject)$/);
    if(reimbursementReviewPath!==null&&request.method==="POST"){
      if(typeof body.sessionId!=="string"||!body.sessionId.trim())throw new Error("UNAUTHENTICATED");
      const context=currentContext(await services.sessions.get(sessionIdFrom(body),at));
      if(!services.reimbursementReviews)throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      if(Object.keys(body).some(key=>!["sessionId","expectedVersion","reason","idempotencyKey"].includes(key))
        ||typeof body.expectedVersion!=="number"||!Number.isSafeInteger(body.expectedVersion)||body.expectedVersion<1)throw new Error("INVALID_INPUT");
      return success(await services.reimbursementReviews[reimbursementReviewPath[2] as "approve"|"reject"](context,reimbursementReviewPath[1]!,{
        expectedVersion:body.expectedVersion,reason:requiredString(body,"reason")
      },requiredString(body,"idempotencyKey"),at));
    }
    const reimbursementReadPath=request.path.match(/^\/v1\/finance\/reimbursements\/([^/]+)$/);
    if(reimbursementReadPath!==null&&request.method==="GET"){
      if(typeof body.sessionId!=="string"||!body.sessionId.trim())throw new Error("UNAUTHENTICATED");
      const context=currentContext(await services.sessions.get(sessionIdFrom(body),at));
      if(!services.reimbursementReads)throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      const id=reimbursementReadPath[1]!;
      if(id==="mine")return success(await services.reimbursementReads.listOwn(context,at));
      if(id==="managed")return success(await services.reimbursementReads.listManaged(context));
      return success(await services.reimbursementReads.getDetail(context,id,at));
    }
    const selfPurchaseSubmitPath=request.path.match(/^\/v1\/finance\/drafts\/([^/]+)\/self-purchase-submit$/);
    if(selfPurchaseSubmitPath!==null&&request.method==="POST"){
      if(typeof body.sessionId!=="string"||!body.sessionId.trim())throw new Error("UNAUTHENTICATED");
      const context=currentContext(await services.sessions.get(sessionIdFrom(body),at));
      if(!services.selfPurchases)throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      if(Object.keys(body).some(key=>!["sessionId","expectedVersion","amountCents","reason","attachmentVersionIds","idempotencyKey"].includes(key))
        ||typeof body.expectedVersion!=="number"||!Number.isSafeInteger(body.expectedVersion)||body.expectedVersion<1
        ||!Array.isArray(body.attachmentVersionIds)||!body.attachmentVersionIds.every(id=>typeof id==="string"))throw new Error("INVALID_INPUT");
      return success(await services.selfPurchases.submit(context,selfPurchaseSubmitPath[1]!,{
        expectedVersion:body.expectedVersion,amountCents:requiredString(body,"amountCents"),reason:requiredString(body,"reason"),attachmentVersionIds:body.attachmentVersionIds as string[]
      },requiredString(body,"idempotencyKey"),at));
    }
    const selfPurchaseReversePath=request.path.match(/^\/v1\/finance\/self-purchases\/([^/]+)\/reverse$/);
    if(selfPurchaseReversePath!==null&&request.method==="POST"){
      if(typeof body.sessionId!=="string"||!body.sessionId.trim())throw new Error("UNAUTHENTICATED");
      const context=currentContext(await services.sessions.get(sessionIdFrom(body),at));
      if(!services.selfPurchaseReversals)throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      if(Object.keys(body).some(key=>!["sessionId","expectedVersion","reason","idempotencyKey"].includes(key))
        ||typeof body.expectedVersion!=="number"||!Number.isSafeInteger(body.expectedVersion)||body.expectedVersion<1)throw new Error("INVALID_INPUT");
      return success(await services.selfPurchaseReversals.reverse(context,selfPurchaseReversePath[1]!,{
        expectedVersion:body.expectedVersion,reason:requiredString(body,"reason")
      },requiredString(body,"idempotencyKey"),at));
    }
    const selfPurchaseReadPath=request.path.match(/^\/v1\/finance\/self-purchases\/([^/]+)$/);
    if(selfPurchaseReadPath!==null&&request.method==="GET"){
      if(typeof body.sessionId!=="string"||!body.sessionId.trim())throw new Error("UNAUTHENTICATED");
      const context=currentContext(await services.sessions.get(sessionIdFrom(body),at));
      if(!services.selfPurchaseReads)throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      const id=selfPurchaseReadPath[1]!;
      if(id==="mine")return success(await services.selfPurchaseReads.listOwn(context,at));
      if(id==="managed")return success(await services.selfPurchaseReads.listManaged(context));
      return success(await services.selfPurchaseReads.getDetail(context,id,at));
    }
    const companyFundActionPath=request.path.match(/^\/v1\/admin\/company-funds\/([^/]+)\/(assignment|status)$/);
    if((request.path==="/v1/admin/company-funds"&&(request.method==="GET"||request.method==="POST"))
      ||(companyFundActionPath!==null&&request.method==="POST")){
      if(typeof body.sessionId!=="string"||!body.sessionId.trim())throw new Error("UNAUTHENTICATED");
      const context=currentContext(await services.sessions.get(sessionIdFrom(body),at));
      if(!services.companyFunds)throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      if(request.method==="GET")return success(await services.companyFunds.list(context,at));
      if(companyFundActionPath===null){
        if(Object.keys(body).some(key=>!["sessionId","fundCode","displayName","organizationUnitId","idempotencyKey"].includes(key)))throw new Error("INVALID_INPUT");
        return success(await services.companyFunds.create(context,{
          fundCode:requiredString(body,"fundCode"),displayName:requiredString(body,"displayName"),
          ...(body.organizationUnitId===undefined?{}:{organizationUnitId:requiredString(body,"organizationUnitId")})
        },requiredString(body,"idempotencyKey"),at));
      }
      if(companyFundActionPath[2]==="assignment"){
        if(Object.keys(body).some(key=>!["sessionId","expectedAssignmentId","reason","idempotencyKey"].includes(key)))throw new Error("INVALID_INPUT");
        if(body.expectedAssignmentId!==null&&(typeof body.expectedAssignmentId!=="string"||!body.expectedAssignmentId.trim()))throw new Error("INVALID_INPUT");
        return success(await services.companyFunds.assign(context,{fundId:companyFundActionPath[1]!,expectedAssignmentId:body.expectedAssignmentId as string|null,
          reason:requiredString(body,"reason")},requiredString(body,"idempotencyKey"),at));
      }
      if(Object.keys(body).some(key=>!["sessionId","expectedVersion","status","reason","idempotencyKey"].includes(key))
        ||(body.status!=="ACTIVE"&&body.status!=="INACTIVE")||typeof body.expectedVersion!=="number"||!Number.isSafeInteger(body.expectedVersion)||body.expectedVersion<1)throw new Error("INVALID_INPUT");
      return success(await services.companyFunds.setStatus(context,companyFundActionPath[1]!,{expectedVersion:body.expectedVersion,status:body.status,
        reason:requiredString(body,"reason")},requiredString(body,"idempotencyKey"),at));
    }
    const attachmentReservePath = request.path.match(/^\/v1\/finance\/drafts\/([^/]+)\/attachment-uploads$/);
    if (attachmentReservePath !== null && request.method === "POST") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim()) throw new Error("UNAUTHENTICATED");
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      if (!services.financeAttachments) throw new Error("FINANCE_ATTACHMENT_SERVICE_UNAVAILABLE");
      if (Object.keys(body).some(key=>!["sessionId","purpose","originalFilename","declaredMediaType","declaredSizeBytes","expectedSha256","idempotencyKey"].includes(key))) throw new Error("INVALID_INPUT");
      const purpose=requiredString(body,"purpose"),declaredMediaType=requiredString(body,"declaredMediaType"),declaredSizeBytes=body.declaredSizeBytes;
      if ((purpose!=="SUPPORTING_DOCUMENT"&&purpose!=="APPLICATION_SCREENSHOT"&&purpose!=="INVOICE"&&purpose!=="PAYMENT_RECEIPT")
        || (declaredMediaType!=="application/pdf"&&declaredMediaType!=="image/png"&&declaredMediaType!=="image/jpeg")
        || typeof declaredSizeBytes!=="number"||!Number.isSafeInteger(declaredSizeBytes)) throw new Error("INVALID_INPUT");
      return success(await services.financeAttachments.reserve(context,attachmentReservePath[1]!,{
        purpose,originalFilename:requiredString(body,"originalFilename"),declaredMediaType,declaredSizeBytes,
        ...(body.expectedSha256===undefined?{}:{expectedSha256:requiredString(body,"expectedSha256")})
      },requiredString(body,"idempotencyKey"),at));
    }
    const attachmentVersionPath=request.path.match(/^\/v1\/finance\/attachments\/([^/]+)\/versions$/);
    if(attachmentVersionPath!==null&&request.method==="POST"){
      if(typeof body.sessionId!=="string"||!body.sessionId.trim())throw new Error("UNAUTHENTICATED");
      const context=currentContext(await services.sessions.get(sessionIdFrom(body),at));
      if(!services.financeAttachments?.reserveNextVersion)throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      if(Object.keys(body).some(key=>!["sessionId","originalFilename","declaredMediaType","declaredSizeBytes","expectedSha256","idempotencyKey"].includes(key)))throw new Error("INVALID_INPUT");
      const declaredMediaType=requiredString(body,"declaredMediaType"),declaredSizeBytes=body.declaredSizeBytes;
      if((declaredMediaType!=="application/pdf"&&declaredMediaType!=="image/png"&&declaredMediaType!=="image/jpeg")
        ||typeof declaredSizeBytes!=="number"||!Number.isSafeInteger(declaredSizeBytes)||declaredSizeBytes<1)throw new Error("INVALID_INPUT");
      return success(await services.financeAttachments.reserveNextVersion(context,attachmentVersionPath[1]!,{
        originalFilename:requiredString(body,"originalFilename"),declaredMediaType,declaredSizeBytes,
        ...(body.expectedSha256===undefined?{}:{expectedSha256:requiredString(body,"expectedSha256")})
      },requiredString(body,"idempotencyKey"),at));
    }
    const documentAttachmentsPath=request.path.match(/^\/v1\/finance\/documents\/([^/]+)\/attachments$/);
    if(documentAttachmentsPath!==null&&request.method==="GET"){
      if(typeof body.sessionId!=="string"||!body.sessionId.trim())throw new Error("UNAUTHENTICATED");
      const context=currentContext(await services.sessions.get(sessionIdFrom(body),at));
      if(!services.financeAttachments?.listDocument)throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      return success(await services.financeAttachments.listDocument(context,documentAttachmentsPath[1]!,at));
    }
    const attachmentMetadataPath=request.path.match(/^\/v1\/finance\/attachment-uploads\/([^/]+)$/);
    if(attachmentMetadataPath!==null&&request.method==="GET"){
      if (typeof body.sessionId !== "string" || !body.sessionId.trim()) throw new Error("UNAUTHENTICATED");
      const context=currentContext(await services.sessions.get(sessionIdFrom(body),at));
      if(!services.financeAttachments)throw new Error("FINANCE_ATTACHMENT_SERVICE_UNAVAILABLE");
      return success(await services.financeAttachments.getOwnVersion(context,attachmentMetadataPath[1]!,at));
    }
    const copyPath = request.path.match(/^\/v1\/referrals\/([^/]+)\/copy$/);
    if (request.method === "POST" && copyPath !== null) {
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      if (!services.referrals?.copy) throw new Error("REFERRAL_SERVICE_UNAVAILABLE");
      const allowedFields = ["sessionId","receiverPersonId","courseContextId","classType","idempotencyKey"];
      if (Object.keys(body).some(key => !allowedFields.includes(key))) throw new Error("INVALID_INPUT");
      const classType = body.classType;
      if (classType !== undefined && classType !== "ONE_TO_ONE" && classType !== "SMALL_GROUP") throw new Error("INVALID_INPUT");
      return success(await services.referrals.copy(context, copyPath[1]!, {
        receiverPersonId: requiredString(body,"receiverPersonId"),
        ...(body.courseContextId === undefined ? {} : {courseContextId: requiredString(body,"courseContextId")}),
        ...(classType === undefined ? {} : {classType})
      },requiredString(body,"idempotencyKey"),at));
    }
    const lifecyclePath = request.path.match(/^\/v1\/referrals\/([^/]+)\/(archive|reactivate)$/);
    if (request.method === "POST" && lifecyclePath !== null) {
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      if (!services.referralLifecycle) throw new Error("REFERRAL_LIFECYCLE_UNAVAILABLE");
      const allowedFields = ["sessionId","expectedVersion","idempotencyKey"];
      if (Object.keys(body).some(key => !allowedFields.includes(key))) throw new Error("INVALID_INPUT");
      const expectedVersion=body.expectedVersion;
      if (typeof expectedVersion!=="number" || !Number.isSafeInteger(expectedVersion) || expectedVersion<1) throw new Error("INVALID_INPUT");
      const method=lifecyclePath[2]==="archive" ? "archive" : "reactivate";
      return success(await services.referralLifecycle[method](context,lifecyclePath[1]!,{expectedVersion},requiredString(body,"idempotencyKey"),at));
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
