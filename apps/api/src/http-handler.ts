import {
  API_CONTRACT_VERSION,
  API_ERROR_CODES,
  permissionScope,
  SALARY_BENEFIT_DOCUMENT_KINDS,
  type HttpMethod,
  type PermissionSubject,
  type RoleContext,
  type GroupLeaderRelationshipCandidatesDto,
  type GroupLeaderRelationshipPreviewDto,
  type GroupLeaderRelationshipPublishDto,
  type PlanningMentorRelationshipDirectoryDto,
  type PlanningMentorRelationshipPreviewDto,
  type PlanningMentorRelationshipPublishDto,
} from "@teaching-research-alliance/contracts";
import type { ReferralCreationDraft } from "./postgres-referral-creation-service.js";
import type { FinanceAttachmentReservationDraft } from "./postgres-finance-attachment-service.js";
import type {
  RatePolicyDraft,
  WeeklyFeeDraft,
} from "@teaching-research-alliance/domain";
import { RatePolicyService } from "@teaching-research-alliance/domain";
import { type SessionView } from "./session-service.js";
import type {
  GroupLeaderChangePreviewDraft,
  GroupLeaderChangePreviewResult,
  GroupLeaderChangePublishResult,
} from "./postgres-group-leader-relationship-service.js";
import type { GroupLeaderRelationshipDirectory } from "./postgres-group-leader-directory-service.js";
import type {
  PlanningMentorRelationshipDirectory,
  PlanningMentorRelationshipPreviewDraft,
  PlanningMentorRelationshipPreviewResult,
  PlanningMentorRelationshipPublishResult,
} from "./postgres-planning-mentor-relationship-service.js";

export type ApiRequest = Readonly<{
  method: HttpMethod;
  path: string;
  body: unknown;
  /** Decoded URL query; the HTTP server rejects duplicate keys before reaching this boundary. */
  query?: Readonly<Record<string, string>>;
  sessionId?: string;
  /** Trusted transport peer address. Request JSON must never supply this value. */
  sourceIp?: string;
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
  acceptReferral: (
    context: RoleContext,
    referralId: string,
  ) => unknown | Promise<unknown>;
  recordWeeklyFee: (
    context: RoleContext,
    draft: WeeklyFeeDraft,
    idempotencyKey: string,
  ) => unknown | Promise<unknown>;
}>;

export type SessionApiService = Readonly<{
  credentialField?: "password";
  logout?: (sessionId: string) => void | Promise<void>;
  login: (
    phone: string,
    credential: string,
    at: Date,
    sourceIp?: string,
  ) => SessionView | Promise<SessionView>;
  get: (sessionId: string, at: Date) => SessionView | Promise<SessionView>;
  switchRole: (
    sessionId: string,
    subject: PermissionSubject,
    at: Date,
  ) => SessionView | Promise<SessionView>;
}>;

export type ApiServices = Readonly<{
  sessions: SessionApiService;
  accountAccess?: Readonly<{
    register: (
      draft: {
        nickname: string;
        legalName: string;
        phoneNormalized: string;
        password: string;
      },
      at: Date,
    ) => Promise<{ nickname: string; session: SessionView }>;
    listAccounts: (
      context: RoleContext,
      at: Date,
    ) => unknown | Promise<unknown>;
    resetPassword: (
      context: RoleContext,
      accountId: string,
      newPassword: string,
      reason: string,
      idempotencyKey: string,
      at: Date,
    ) => unknown | Promise<unknown>;
    listPeople: (context: RoleContext, at: Date) => unknown | Promise<unknown>;
    updatePersonProfile: (context: RoleContext, personId: string, nickname: string, legalName: string, expectedProfileVersion: string, reason: string, idempotencyKey: string, at: Date) => unknown | Promise<unknown>;
    updatePersonBusinessIdentity: (context: RoleContext, personId: string, businessIdentity: "TEACHING_TEACHER" | "ACADEMIC_PLANNER", gradeSubject: string | null | undefined, expectedVersion: string | null, reason: string, idempotencyKey: string, at: Date) => unknown | Promise<unknown>;
    assignRole: (context: RoleContext, personId: string, draft: {
      subject: PermissionSubject; scope: import("@teaching-research-alliance/contracts").PermissionScope;
      scopeId?: string; validFrom: string; validTo?: string; reason: string;
    }, idempotencyKey: string, at: Date) => unknown | Promise<unknown>;
    revokeRole: (context: RoleContext, assignmentId: string, reason: string, idempotencyKey: string, at: Date) => unknown | Promise<unknown>;
    setPersonStatus: (context: RoleContext, personId: string, status: "ACTIVE" | "INACTIVE", reason: string, idempotencyKey: string, at: Date) => unknown | Promise<unknown>;
  }>;
  weeklyFees: WeeklyFeeApiService;
  ratePolicies?: RatePolicyService;
  groupLeaderRelationships?: Readonly<{
    preview: (context: RoleContext, draft: GroupLeaderChangePreviewDraft, at: Date) => GroupLeaderChangePreviewResult | Promise<GroupLeaderChangePreviewResult>;
    publish: (context: RoleContext, previewId: string, idempotencyKey: string, at: Date) => GroupLeaderChangePublishResult | Promise<GroupLeaderChangePublishResult>;
  }>;
  groupLeaderDirectory?: Readonly<{
    list: (context: RoleContext, at: Date) => GroupLeaderRelationshipDirectory | Promise<GroupLeaderRelationshipDirectory>;
  }>;
  planningMentorRelationships?: Readonly<{
    listDirectory: (context: RoleContext, at: Date) => PlanningMentorRelationshipDirectory | Promise<PlanningMentorRelationshipDirectory>;
    preview: (context: RoleContext, draft: PlanningMentorRelationshipPreviewDraft, at: Date) => PlanningMentorRelationshipPreviewResult | Promise<PlanningMentorRelationshipPreviewResult>;
    publish: (context: RoleContext, previewId: string, idempotencyKey: string, at: Date) => PlanningMentorRelationshipPublishResult | Promise<PlanningMentorRelationshipPublishResult>;
  }>;
  organizationRevenue?: Readonly<{
    get: (context: RoleContext, filter: {fromMonth: string; toMonth: string}, at: Date) => unknown | Promise<unknown>;
  }>;
  personal?: Readonly<{
    getOwnOverview: (
      context: RoleContext,
      at: Date,
    ) => unknown | Promise<unknown>;
    listAvailableVenues: (context: RoleContext) => unknown | Promise<unknown>;
  }>;
  venues?: Readonly<{
    create: (
      context: RoleContext,
      draft: { name: string; makeDefault?: boolean },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
    rename: (
      context: RoleContext,
      id: string,
      draft: { name: string; expectedVersion: number },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
    setStatus: (
      context: RoleContext,
      id: string,
      draft: { status: "ACTIVE" | "INACTIVE"; expectedVersion: number },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
    setDefault: (
      context: RoleContext,
      id: string,
      draft: { expectedVersion: number },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
    setPermission: (
      context: RoleContext,
      id: string,
      draft: {
        granteePersonId: string;
        canView: boolean;
        canWithdraw: boolean;
        expectedGrantId?: string | null;
      },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
  }>;
  venueReads?: Readonly<{
    list: (context: RoleContext, at: Date) => unknown | Promise<unknown>;
    listOwned: (context: RoleContext, at: Date) => unknown | Promise<unknown>;
    get: (
      context: RoleContext,
      id: string,
      at: Date,
    ) => unknown | Promise<unknown>;
  }>;
  venueBoards?: Readonly<{
    get: (
      context: RoleContext,
      id: string,
      filter: { teachingWeekId?: string; startsOn?: string; endsOn?: string },
      at: Date,
    ) => unknown | Promise<unknown>;
  }>;
  referrals?: Readonly<{
    create: (
      context: RoleContext,
      draft: ReferralCreationDraft,
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
    copy?: (
      context: RoleContext,
      sourceReferralId: string,
      draft: {
        receiverPersonId: string;
        courseContextId?: string;
        classType?: "ONE_TO_ONE" | "SMALL_GROUP";
      },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
    listReceivingTeachers: (context: RoleContext) => unknown | Promise<unknown>;
  }>;
  sentReferrals?: Readonly<{
    list: (context: RoleContext, at: Date) => unknown | Promise<unknown>;
  }>;
  referralAcceptance?: Readonly<{
    accept: (
      context: RoleContext,
      referralId: string,
      draft: { venueId?: string; expectedVersion: number },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
  }>;
  referralLifecycle?: Readonly<{
    archive: (
      context: RoleContext,
      referralId: string,
      draft: { expectedVersion: number },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
    reactivate: (
      context: RoleContext,
      referralId: string,
      draft: { expectedVersion: number },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
    complete: (
      context: RoleContext,
      referralId: string,
      draft: { expectedVersion: number },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
  }>;
  managedReferrals?: Readonly<{
    list: (context: RoleContext, at: Date) => unknown | Promise<unknown>;
  }>;
  financeDrafts?: Readonly<{
    create: (
      context: RoleContext,
      draft: {
        kind:
          | "WITHDRAWAL"
          | "REIMBURSEMENT"
          | "EXTERNAL_PAYMENT"
          | "REFUND"
          | "SELF_PURCHASE";
      },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
    listOwn: (context: RoleContext, at: Date) => unknown | Promise<unknown>;
    getOwn: (
      context: RoleContext,
      id: string,
      at: Date,
    ) => unknown | Promise<unknown>;
  }>;
  companyFunds?: Readonly<{
    create: (
      context: RoleContext,
      draft: {
        fundCode: string;
        displayName: string;
        organizationUnitId?: string;
      },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
    list: (context: RoleContext, at: Date) => unknown | Promise<unknown>;
    assign: (
      context: RoleContext,
      draft: {
        fundId: string;
        expectedAssignmentId: string | null;
        reason: string;
      },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
    setStatus: (
      context: RoleContext,
      id: string,
      draft: {
        expectedVersion: number;
        status: "ACTIVE" | "INACTIVE";
        reason: string;
      },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
  }>;
  bonusProjects?: Readonly<{
    list: (context: RoleContext) => unknown | Promise<unknown>;
    rename: (
      context: RoleContext,
      projectNo: number,
      draft: { expectedVersion: number; displayName: string; reason: string },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
  }>;
  projectBonusReads?: Readonly<{
    list: (context: RoleContext, input: { cursor?: string; limit?: number }) => unknown | Promise<unknown>;
    getDetail: (context: RoleContext, id: string) => unknown | Promise<unknown>;
  }>;
  selfPurchases?: Readonly<{
    submit: (
      context: RoleContext,
      id: string,
      draft: {
        expectedVersion: number;
        amountCents: string;
        reason: string;
        attachmentVersionIds: readonly string[];
      },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
  }>;
  selfPurchaseReversals?: Readonly<{
    reverse: (
      context: RoleContext,
      id: string,
      draft: { expectedVersion: number; reason: string },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
  }>;
  refunds?: Readonly<{
    submit: (
      context: RoleContext,
      id: string,
      draft: {
        expectedVersion: number;
        weeklyFeeEntryIds: readonly string[];
        reason: string;
        attachmentVersionIds: readonly string[];
      },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
  }>;
  refundReviews?: Readonly<{
    approve: (
      context: RoleContext,
      id: string,
      draft: { expectedVersion: number; reason: string },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
    reject: (
      context: RoleContext,
      id: string,
      draft: { expectedVersion: number; reason: string },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
  }>;
  refundReads?: Readonly<{
    listOwn: (context: RoleContext, at: Date) => unknown | Promise<unknown>;
    listManaged: (context: RoleContext) => unknown | Promise<unknown>;
    getDetail: (
      context: RoleContext,
      id: string,
      at: Date,
    ) => unknown | Promise<unknown>;
  }>;
  reimbursements?: Readonly<{
    submit: (
      context: RoleContext,
      id: string,
      draft: {
        expectedVersion: number;
        amountCents: string;
        reason: string;
        attachmentVersionIds: readonly string[];
      },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
  }>;
  reimbursementReviews?: Readonly<{
    approve: (
      context: RoleContext,
      id: string,
      draft: { expectedVersion: number; reason: string },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
    reject: (
      context: RoleContext,
      id: string,
      draft: { expectedVersion: number; reason: string },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
  }>;
  reimbursementTransfers?: Readonly<{
    execute: (
      context: RoleContext,
      id: string,
      draft: { expectedVersion: number },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
  }>;
  reimbursementReversals?: Readonly<{
    reverse: (
      context: RoleContext,
      id: string,
      draft: { expectedVersion: number; reason: string },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
  }>;
  reimbursementReads?: Readonly<{
    listOwn: (context: RoleContext, at: Date) => unknown | Promise<unknown>;
    listManaged: (context: RoleContext) => unknown | Promise<unknown>;
    getDetail: (
      context: RoleContext,
      id: string,
      at: Date,
    ) => unknown | Promise<unknown>;
  }>;
  selfPurchaseReads?: Readonly<{
    listOwn: (context: RoleContext, at: Date) => unknown | Promise<unknown>;
    listManaged: (context: RoleContext) => unknown | Promise<unknown>;
    getDetail: (
      context: RoleContext,
      id: string,
      at: Date,
    ) => unknown | Promise<unknown>;
  }>;
  salaryBenefits?: Readonly<{
    createEvidenceDocument: (
      context: RoleContext,
      kind: (typeof SALARY_BENEFIT_DOCUMENT_KINDS)[number],
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
    setCashWagePlan: (
      context: RoleContext,
      draft: {
        teacherPersonId: string;
        salaryMonth: string;
        plannedCashCents: string;
        plannedDeductionCents: string;
        active: boolean;
        reason: string;
        applyToFutureMonths?: boolean;
      },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
    generateCashWageTodos: (
      context: RoleContext,
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
    confirmCashWage: (
      context: RoleContext,
      draft: {
        documentId: string;
        expectedVersion: number;
        todoId: string;
        cashPaidCents: string;
        deductionCents: string;
        paidAt: string;
        reason: string;
        attachmentVersionIds: readonly string[];
        correctionOfDocumentId?: string;
      },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
    grantBonus: (
      context: RoleContext,
      draft: {
        documentId: string;
        expectedVersion: number;
        projectNo: number;
        projectName: string;
        projectNameVersionId?: string;
        recipientPersonId: string;
        sourceFundId: string;
        amountCents: string;
        reason: string;
        attachmentVersionIds: readonly string[];
      },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
    setBenefitPlan: (
      context: RoleContext,
      draft: {
        benefitKind: "SOCIAL_INSURANCE" | "HOUSING_FUND";
        beneficiaryPersonId: string;
        benefitMonth: string;
        executionDay: number;
        amountCents: string;
        sourceFundId: string;
        active: boolean;
        reason: string;
      },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
    generateBenefitTodos: (
      context: RoleContext,
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
    confirmBenefit: (
      context: RoleContext,
      draft: {
        documentId: string;
        expectedVersion: number;
        expectedPlanVersionId: string;
        todoId: string;
        reason: string;
        attachmentVersionIds: readonly string[];
      },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
    reversePosting: (
      context: RoleContext,
      draft: {
        originalDocumentId: string;
        reversalDocumentId: string;
        expectedOriginalVersion: number;
        expectedReversalVersion: number;
        reason: string;
        attachmentVersionIds: readonly string[];
      },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
  }>;
  benefitReads?: Readonly<{
    listRoster: (context: RoleContext, month: string, at: Date) => unknown | Promise<unknown>;
    getDetail: (context: RoleContext, id: string) => unknown | Promise<unknown>;
  }>;
  benefitSourceFunds?: Readonly<{
    list: (
      context: RoleContext,
      at: Date,
    ) =>
      | Readonly<{
          items: readonly Readonly<{
            fundId: string;
            code: string;
            displayName: string;
          }>[];
        }>
      | Promise<
          Readonly<{
            items: readonly Readonly<{
              fundId: string;
              code: string;
              displayName: string;
            }>[];
          }>
        >;
  }>;
  cashWageReads?: Readonly<{
    listRoster: (
      context: RoleContext,
      month: string,
    ) => unknown | Promise<unknown>;
    listConfirmations: (
      context: RoleContext,
      input: {
        month: string;
        teacherPersonId?: string;
        cursor?: string;
        limit?: number;
      },
    ) => unknown | Promise<unknown>;
    getDetail: (context: RoleContext, id: string) => unknown | Promise<unknown>;
  }>;
  cashWageTeacherDirectory?: Readonly<{
    list: (
      context: RoleContext,
    ) =>
      | Readonly<{
          items: readonly Readonly<{ personId: string; nickname: string }>[];
        }>
      | Promise<
          Readonly<{
            items: readonly Readonly<{ personId: string; nickname: string }>[];
          }>
        >;
  }>;
  financeAttachments?: Readonly<{
    reserve: (
      context: RoleContext,
      documentId: string,
      draft: FinanceAttachmentReservationDraft,
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
    getOwnVersion: (
      context: RoleContext,
      versionId: string,
      at: Date,
    ) => unknown | Promise<unknown>;
    reserveNextVersion?: (
      context: RoleContext,
      attachmentId: string,
      draft: Omit<FinanceAttachmentReservationDraft, "purpose">,
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
    listDocument?: (
      context: RoleContext,
      documentId: string,
      at: Date,
    ) => unknown | Promise<unknown>;
  }>;
  financeAttachmentUploads?: Readonly<{
    upload: (
      context: RoleContext,
      versionId: string,
      chunks: AsyncIterable<Uint8Array>,
      at: Date,
    ) => unknown | Promise<unknown>;
  }>;
  financeAttachmentReads?: Readonly<{
    readOwn: (
      context: RoleContext,
      versionId: string,
      at: Date,
    ) => Promise<
      Readonly<{
        bytes: Buffer;
        mediaType: string;
        originalFilename: string;
        sha256: string;
        sizeBytes: number;
      }>
    >;
  }>;
  withdrawals?: Readonly<{
    submit: (
      context: RoleContext,
      id: string,
      draft: {
        expectedVersion: number;
        sourceAccountId: string;
        amountCents: string;
        recipientName: string;
        bankAccount: string;
        bankName?: string;
        attachmentVersionIds: readonly string[];
      },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
    revoke: (
      context: RoleContext,
      id: string,
      draft: { expectedVersion: number; reason: string },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
    markTransferred: (
      context: RoleContext,
      id: string,
      draft: {
        expectedVersion: number;
        attachmentVersionIds: readonly string[];
      },
      key: string,
      at: Date,
    ) => unknown | Promise<unknown>;
  }>;
  withdrawalReads?: Readonly<{
    listSources: (context: RoleContext, at: Date) => unknown | Promise<unknown>;
    listOwn: (context: RoleContext, at: Date) => unknown | Promise<unknown>;
    listPending: (context: RoleContext) => unknown | Promise<unknown>;
    listManaged: (context: RoleContext) => unknown | Promise<unknown>;
    getDetail: (
      context: RoleContext,
      id: string,
      at: Date,
    ) => unknown | Promise<unknown>;
  }>;
  teaching?: Readonly<{
    listReceivedReferrals: (
      context: RoleContext,
      at: Date,
    ) => unknown | Promise<unknown>;
    listOpenTeachingWeeks: (
      context: RoleContext,
      at: Date,
    ) => unknown | Promise<unknown>;
  }>;
  now: () => Date;
}>;

const objectBody = (body: unknown): Record<string, unknown> => {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new Error("INVALID_INPUT");
  return body as Record<string, unknown>;
};

const requiredString = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`INVALID_INPUT:${key}`);
  return value;
};

const sessionIdFrom = (body: Record<string, unknown>): string =>
  requiredString(body, "sessionId");

const errorStatus = (code: string): number => {
  if (code === "LOGIN_RATE_LIMITED") return 429;
  if (code === "ACCOUNT_ACCESS_SERVICE_UNAVAILABLE") return 503;
  if (
    code === "REGISTRATION_PHONE_CONFLICT" ||
    code === "REGISTRATION_NICKNAME_CONFLICT" ||
    code === "PROFILE_NICKNAME_CONFLICT"
  ) return 409;
  if (code === "RELATIONSHIP_SERVICE_UNAVAILABLE") return 503;
  if (code === "ORGANIZATION_REVENUE_DATA_UNAVAILABLE") return 500;
  if (code === "ORGANIZATION_REVENUE_SERVICE_UNAVAILABLE") return 503;
  if (code === "VENUE_SERVICE_UNAVAILABLE") return 503;
  if (code === "VENUE_DATA_UNAVAILABLE") return 500;
  if (
    code === "FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE" ||
    code === "FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE" ||
    code === "FINANCE_REFUND_DATA_UNAVAILABLE"
  )
    return 500;
  if (
    code === "SALARY_BENEFIT_DATA_UNAVAILABLE" ||
    code === "BONUS_PROJECT_CATALOG_DATA_UNAVAILABLE"
  )
    return 500;
  if (
    [
      "REIMBURSEMENT_STATE_CONFLICT",
      "REIMBURSEMENT_CROSS_FINANCE_YEAR_PENDING",
      "REFUND_STATE_CONFLICT",
      "WEEKLY_FEE_REFUNDED",
      "SALARY_BENEFIT_STATE_CONFLICT",
      "CASH_WAGE_AMOUNT_MISMATCH",
      "CASH_WAGE_PLAN_EXCEEDED",
      "CASH_WAGE_PLAN_INACTIVE",
      "CASH_WAGE_CORRECTION_REQUIRED",
      "CASH_WAGE_CORRECTION_INVALID",
      "FINANCE_BENEFIT_ALREADY_EXECUTED",
      "FINANCE_BENEFIT_PLAN_INACTIVE",
      "BONUS_PROJECT_VERSION_REQUIRED",
      "BONUS_PROJECT_VERSION_CONFLICT",
      "RELATIONSHIP_PREVIEW_STALE",
      "RELATIONSHIP_PREVIEW_ALREADY_PUBLISHED",
      "RELATIONSHIP_EFFECTIVE_WEEK_NOT_CURRENT",
      "RELATIONSHIP_SPECIAL_PERIOD_SCOPE_REQUIRED",
      "GROUP_LEADER_CANDIDATE_AMBIGUOUS",
      "GROUP_LEADER_RELATIONSHIP_MISSING",
      "GROUP_LEADER_RELATIONSHIP_AMBIGUOUS",
      "PLANNING_MENTOR_CANDIDATE_AMBIGUOUS",
      "PLANNING_MENTOR_RELATIONSHIP_MISSING",
      "PLANNING_MENTOR_RELATIONSHIP_AMBIGUOUS",
      "PLANNING_MENTOR_RELATIONSHIP_CONFLICT",
      "PLANNING_MENTOR_RELATIONSHIP_NOT_OWNED",
      "ROLE_ASSIGNMENT_OVERLAP",
      "PERSON_INACTIVE",
      "INVALID_ROLE_REVOCATION",
      "CANNOT_DEACTIVATE_SELF",
      "CANNOT_DEACTIVATE_LAST_OWNER",
      "PROFILE_VERSION_STALE",
      "PROFILE_NO_CHANGE",
      "BUSINESS_IDENTITY_VERSION_STALE",
      "BUSINESS_IDENTITY_NO_CHANGE",
      "BUSINESS_IDENTITY_FUTURE_ROLE_CONFLICT",
      "BUSINESS_IDENTITY_ROLE_CONFLICT",
      "BUSINESS_IDENTITY_RELATIONSHIP_BLOCKED",
      "CAMPUS_ASSIGNMENT_INVALID",
      "SETTLEMENT_ACCOUNT_MISSING",
      "ACCOUNT_INACTIVE",
      "PROFILE_EMPLOYMENT_INACTIVE",
      "GRADE_SUBJECT_REQUIRED",
    ].includes(code)
  )
    return 409;
  if (code === "HEADQUARTERS_FINANCE_ASSIGNMENT_REQUIRED") return 403;
  if (
    [
      "SELF_PURCHASE_STATE_CONFLICT",
      "HEADQUARTERS_FINANCE_ASSIGNMENT_AMBIGUOUS",
      "COMPANY_FUND_ASSIGNMENT_NOT_FOUND",
    ].includes(code)
  )
    return 409;
  if (
    code === "INTERNAL_ERROR" ||
    code === "FINANCE_RECIPIENT_UNAVAILABLE" ||
    code === "FINANCE_WITHDRAWAL_DATA_UNAVAILABLE"
  )
    return 500;
  if (code === "FINANCE_SERVICE_UNAVAILABLE") return 503;
  if (
    code === "FINANCE_WITHDRAWAL_STATE_CONFLICT" ||
    code === "INSUFFICIENT_BALANCE" ||
    code === "SOURCE_ACCOUNT_NOT_ACTIVE"
  )
    return 409;
  if (
    [
      "COMPANY_FUND_CONFLICT",
      "COMPANY_FUND_ASSIGNMENT_CONFLICT",
      "COMPANY_FUND_INACTIVE",
    ].includes(code)
  )
    return 409;
  if (code === "SOURCE_ACCOUNT_FORBIDDEN") return 403;
  if (
    [
      "ATTACHMENT_STORAGE_UNAVAILABLE",
      "ATTACHMENT_VALIDATOR_BUSY",
      "ATTACHMENT_VALIDATION_TIMEOUT",
      "ATTACHMENT_PUBLICATION_REQUIRES_RECONCILIATION",
    ].includes(code)
  )
    return 503;
  if (["ATTACHMENT_INTEGRITY_FAILED", "ATTACHMENT_UNAVAILABLE"].includes(code))
    return 500;
  if (
    ["FINANCE_ATTACHMENT_NOT_READY", "FINANCE_ATTACHMENT_FAILED"].includes(code)
  )
    return 409;
  if (code === "UNAUTHENTICATED") return 401;
  if (
    code === "FORBIDDEN_SCOPE" ||
    code === "ONLY_SYSTEM_OWNER_CAN_MANAGE_ADMIN" ||
    code === "ROLE_CONTEXT_REQUIRED" ||
    code === "ROLE_CONTEXT_NOT_ASSIGNED" ||
    code === "ROLE_CONTEXT_AMBIGUOUS"
  )
    return 403;
  if (code.endsWith("_NOT_FOUND")) return 404;
  if (
    code === "PERIOD_LOCKED" ||
    code === "IDEMPOTENCY_REPLAY" ||
    code === "VERSION_CONFLICT"
  )
    return 409;
  if (
    code === "VENUE_CHANGE_REQUIRED" ||
    code === "REFERRAL_ALREADY_ACCEPTED" ||
    code === "REFERRAL_STATE_CONFLICT" ||
    code === "REFERRAL_RECEIVER_IDENTITY_INVALID"
  )
    return 409;
  if (code === "INTERNAL_ERROR" || ["TEACHER_PROFILE_IDENTITY_WRITE_FORBIDDEN", "TEACHER_PROFILE_IDENTITY_TRIPLE_INCOMPLETE", "TEACHER_PROFILE_IDENTITY_CHANGE_IMMUTABLE", "TEACHER_PROFILE_IDENTITY_AUDIT_IMMUTABLE"].includes(code)) return 500;
  return 400;
};

const success = (data: unknown): ApiResponse => ({
  status: 200,
  body: { version: API_CONTRACT_VERSION, data },
});

export const failure = (error: unknown): ApiResponse => {
  const rawCode =
    error instanceof Error ? error.message.split(":", 1)[0] : undefined;
  const inputErrors = [
    "INVALID_WEEKLY_FEE",
    "PERIOD_MONTH_MISMATCH",
    "VENUE_NOT_ACTIVE",
    "REFERRAL_NOT_ACCEPTABLE",
  ];
  const code =
    rawCode && (API_ERROR_CODES as readonly string[]).includes(rawCode)
      ? rawCode
      : rawCode && inputErrors.includes(rawCode)
        ? "INVALID_INPUT"
        : "INTERNAL_ERROR";
  return {
    status: errorStatus(code),
    body: { version: API_CONTRACT_VERSION, error: { code, message: code } },
  };
};

const currentContext = (view: SessionView) => {
  if (view.currentRoleContext === null)
    throw new Error("ROLE_CONTEXT_REQUIRED");
  return view.currentRoleContext;
};

const assertRelationshipManager = (context: RoleContext): void => {
  if (permissionScope(context.subject, "MANAGE_PERSON_RELATIONSHIPS") !== "GLOBAL"
    || context.scope !== "GLOBAL" || context.regionId !== undefined
    || context.campusId !== undefined || context.venueId !== undefined
    || !["SYSTEM_OWNER", "SYSTEM_ADMIN"].includes(context.subject)) {
    throw new Error("FORBIDDEN_SCOPE");
  }
};

const assertPlanningMentorRelationshipManager = (context: RoleContext): void => {
  if (
    context.subject !== "PLANNING_MENTOR"
    || permissionScope(context.subject, "MANAGE_OWN_PLANNING_RELATIONSHIPS") !== "SELF"
    || context.scope !== "SELF"
    || context.regionId !== undefined
    || context.campusId !== undefined
    || context.venueId !== undefined
  ) throw new Error("FORBIDDEN_SCOPE");
};

const relationshipPreviewResponse = (result: GroupLeaderChangePreviewResult): GroupLeaderRelationshipPreviewDto => ({
  previewId: result.previewId,
  teacherPersonId: result.teacherPersonId,
  sourceRelatedPersonId: result.sourceRelatedPersonId,
  sourceRelatedNickname: result.sourceRelatedNickname,
  newRelatedPersonId: result.newRelatedPersonId,
  effectiveTeachingWeekId: result.effectiveTeachingWeekId,
  effectiveAt: result.effectiveAt,
  nextBoundaryAt: result.nextBoundaryAt,
  consideredFeeCount: result.consideredFeeCount,
  movedFeeCount: result.movedFeeCount,
  zeroShareFeeCount: result.zeroShareFeeCount,
  excludedRefundCount: result.excludedRefundCount,
  movedAmountCents: result.movedAmountCents,
});

const relationshipPublishResponse = (result: GroupLeaderChangePublishResult): GroupLeaderRelationshipPublishDto => ({
  changeId: result.changeId,
  previewId: result.previewId,
  relationshipVersion: result.relationshipVersion,
  resultRelationshipId: result.resultRelationshipId,
  postingStatus: result.postingStatus,
  consideredFeeCount: result.consideredFeeCount,
  movedFeeCount: result.movedFeeCount,
  excludedRefundCount: result.excludedRefundCount,
  movedAmountCents: result.movedAmountCents,
  replay: result.replay,
});

const relationshipCandidatesResponse = (directory: GroupLeaderRelationshipDirectory): GroupLeaderRelationshipCandidatesDto => ({
  groupLeaders: directory.groupLeaders.map((item) => ({ personId: item.personId, nickname: item.nickname })),
  teachers: directory.teachers.map((item) => ({ personId: item.personId, nickname: item.nickname })),
  currentWeeks: directory.currentWeeks.map((week) => ({
    id: week.id, startsOn: week.startsOn, endsOn: week.endsOn, settlementMonth: week.settlementMonth,
  })),
});

const planningMentorDirectoryResponse = (
  directory: PlanningMentorRelationshipDirectory,
): PlanningMentorRelationshipDirectoryDto => ({
  mentorPersonId: directory.mentorPersonId,
  mentorNickname: directory.mentorNickname,
  managedPlanners: directory.managedPlanners.map((planner) => ({
    personId: planner.personId,
    nickname: planner.nickname,
    relationshipId: planner.relationshipId,
    validFrom: planner.validFrom,
    validTo: planner.validTo,
  })),
  availablePlanners: directory.availablePlanners.map((planner) => ({
    personId: planner.personId,
    nickname: planner.nickname,
  })),
  currentWeeks: directory.currentWeeks.map((week) => ({
    id: week.id,
    startsOn: week.startsOn,
    endsOn: week.endsOn,
    settlementMonth: week.settlementMonth,
  })),
});

const planningMentorPreviewResponse = (
  result: PlanningMentorRelationshipPreviewResult,
): PlanningMentorRelationshipPreviewDto => ({
  previewId: result.previewId,
  action: result.action,
  mentorPersonId: result.mentorPersonId,
  plannerPersonId: result.plannerPersonId,
  plannerNickname: result.plannerNickname,
  effectiveTeachingWeekId: result.effectiveTeachingWeekId,
  effectiveAt: result.effectiveAt,
  nextBoundaryAt: result.nextBoundaryAt,
  consideredFeeCount: result.consideredFeeCount,
  changedFeeCount: result.changedFeeCount,
  zeroShareFeeCount: result.zeroShareFeeCount,
  excludedRefundCount: result.excludedRefundCount,
  plannerDeltaCents: result.plannerDeltaCents,
  mentorDeltaCents: result.mentorDeltaCents,
});

const planningMentorPublishResponse = (
  result: PlanningMentorRelationshipPublishResult,
): PlanningMentorRelationshipPublishDto => ({
  changeId: result.changeId,
  previewId: result.previewId,
  action: result.action,
  relationshipVersion: result.relationshipVersion,
  resultRelationshipId: result.resultRelationshipId,
  postingStatus: result.postingStatus,
  consideredFeeCount: result.consideredFeeCount,
  changedFeeCount: result.changedFeeCount,
  excludedRefundCount: result.excludedRefundCount,
  plannerDeltaCents: result.plannerDeltaCents,
  mentorDeltaCents: result.mentorDeltaCents,
  replay: result.replay,
});

const subjectFrom = (value: string): PermissionSubject => {
  const subjects: readonly PermissionSubject[] = [
    "SYSTEM_OWNER",
    "SYSTEM_ADMIN",
    "TEACHER",
    "TEACHING_TEACHER",
    "ACADEMIC_PLANNER",
    "HEADQUARTERS_FINANCE",
    "REGION_FINANCE",
    "CAMPUS_PRINCIPAL",
    "GROUP_LEADER",
    "TEACHING_MENTOR",
    "PLANNING_MENTOR",
    "VENUE_OWNER",
  ];
  if (!subjects.includes(value as PermissionSubject))
    throw new Error("INVALID_INPUT:subject");
  return value as PermissionSubject;
};

const sessionData = (view: SessionView): Readonly<Record<string, unknown>> => ({
  sessionId: view.sessionId,
  accountId: view.accountId,
  personId: view.personId,
  roleContexts: view.roleContexts,
  currentRoleContext: view.currentRoleContext,
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
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      throw new Error("INVALID_INPUT:expectedVersion");
    }
    return value;
  })(),
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
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`INVALID_INPUT:${key}`);
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
    if (
      typeof rawTier !== "object" ||
      rawTier === null ||
      Array.isArray(rawTier)
    ) {
      throw new Error(`INVALID_INPUT:dynamicTiers[${index}]`);
    }
    const tier = rawTier as Record<string, unknown>;
    const parsed: {
      label: string;
      adjustmentBasisPoints: bigint;
      minExclusive?: bigint;
      maxInclusive?: bigint;
    } = {
      label: requiredString(tier, "label"),
      adjustmentBasisPoints: requiredBigInt(tier, "adjustmentBasisPoints"),
    };
    const minExclusive = optionalBigInt(
      tier.minExclusive,
      `dynamicTiers[${index}].minExclusive`,
    );
    if (minExclusive !== undefined) parsed.minExclusive = minExclusive;
    const maxInclusive = optionalBigInt(
      tier.maxInclusive,
      `dynamicTiers[${index}].maxInclusive`,
    );
    if (maxInclusive !== undefined) parsed.maxInclusive = maxInclusive;
    return parsed;
  });
  return {
    plannerBaseRateBasisPoints: requiredBigInt(
      body,
      "plannerBaseRateBasisPoints",
    ),
    teacherBaseRateBasisPoints: requiredBigInt(
      body,
      "teacherBaseRateBasisPoints",
    ),
    planningMentorWeightBasisPoints: requiredBigInt(
      body,
      "planningMentorWeightBasisPoints",
    ),
    groupLeaderRateBasisPoints: requiredBigInt(
      body,
      "groupLeaderRateBasisPoints",
    ),
    teachingMentorRateBasisPoints: requiredBigInt(
      body,
      "teachingMentorRateBasisPoints",
    ),
    venueRateBasisPoints: requiredBigInt(body, "venueRateBasisPoints"),
    campusConsultationForPlannerRateBasisPoints: requiredBigInt(
      body,
      "campusConsultationForPlannerRateBasisPoints",
    ),
    campusConsultationForTeacherRateBasisPoints: requiredBigInt(
      body,
      "campusConsultationForTeacherRateBasisPoints",
    ),
    platformFinanceRateBasisPoints: requiredBigInt(
      body,
      "platformFinanceRateBasisPoints",
    ),
    regionFinanceRateBasisPoints: requiredBigInt(
      body,
      "regionFinanceRateBasisPoints",
    ),
    dynamicTiers,
    effectiveFrom: requiredString(body, "effectiveFrom"),
    reason: requiredString(body, "reason"),
  };
};

export const handleRequest = async (
  request: ApiRequest,
  services: ApiServices,
): Promise<ApiResponse> => {
  try {
    const at = services.now();
    const parsedBody = objectBody(request.body);
    const body =
      request.sessionId === undefined
        ? parsedBody
        : { ...parsedBody, sessionId: request.sessionId };
    if (request.method === "POST" && request.path === "/v1/accounts/register") {
      if (
        Object.keys(body).some(
          (key) => !["nickname", "legalName", "phoneNormalized", "password"].includes(key),
        )
      ) throw new Error("INVALID_INPUT");
      if (!services.accountAccess) throw new Error("ACCOUNT_ACCESS_SERVICE_UNAVAILABLE");
      const registration = await services.accountAccess.register(
        {
          nickname: requiredString(body, "nickname"),
          legalName: requiredString(body, "legalName"),
          phoneNormalized: requiredString(body, "phoneNormalized"),
          password: requiredString(body, "password"),
        },
        at,
      );
      return success({
        nickname: registration.nickname,
        ...sessionData(registration.session),
      });
    }
    if (request.method === "GET" && request.path === "/v1/admin/accounts") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.accountAccess) throw new Error("ACCOUNT_ACCESS_SERVICE_UNAVAILABLE");
      return success(await services.accountAccess.listAccounts(context, at));
    }
    if (request.method === "GET" && request.path === "/v1/admin/people") {
      if (Object.keys(body).some((key) => key !== "sessionId")) throw new Error("INVALID_INPUT");
      if (typeof body.sessionId !== "string" || !body.sessionId.trim()) throw new Error("UNAUTHENTICATED");
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      if (!services.accountAccess) throw new Error("ACCOUNT_ACCESS_SERVICE_UNAVAILABLE");
      return success(await services.accountAccess.listPeople(context, at));
    }
    const profilePath = request.path.match(/^\/v1\/admin\/people\/([^/]+)\/profile$/);
    if (request.method === "POST" && profilePath !== null) {
      if (Object.keys(body).some((key) => !["sessionId","nickname","legalName","expectedProfileVersion","reason","idempotencyKey"].includes(key))) throw new Error("INVALID_INPUT");
      if (typeof body.sessionId !== "string" || !body.sessionId.trim()) throw new Error("UNAUTHENTICATED");
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      if (!services.accountAccess) throw new Error("ACCOUNT_ACCESS_SERVICE_UNAVAILABLE");
      return success(await services.accountAccess.updatePersonProfile(context, profilePath[1]!, requiredString(body,"nickname"), requiredString(body,"legalName"), requiredString(body,"expectedProfileVersion"), requiredString(body,"reason"), requiredString(body,"idempotencyKey"), at));
    }
    const businessIdentityPath = request.path.match(/^\/v1\/admin\/people\/([^/]+)\/business-identity$/);
    if (request.method === "POST" && businessIdentityPath !== null) {
      if (Object.keys(body).some((key) => !["sessionId","businessIdentity","gradeSubject","expectedBusinessIdentityVersion","reason","idempotencyKey"].includes(key))) throw new Error("INVALID_INPUT");
      if (typeof body.sessionId !== "string" || !body.sessionId.trim()) throw new Error("UNAUTHENTICATED");
      if (typeof body.businessIdentity !== "string" || (body.gradeSubject !== undefined && body.gradeSubject !== null && typeof body.gradeSubject !== "string")) throw new Error("INVALID_INPUT");
      if (body.expectedBusinessIdentityVersion !== null && typeof body.expectedBusinessIdentityVersion !== "string") throw new Error("INVALID_INPUT");
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      if (!services.accountAccess) throw new Error("ACCOUNT_ACCESS_SERVICE_UNAVAILABLE");
      return success(await services.accountAccess.updatePersonBusinessIdentity(context, businessIdentityPath[1]!, body.businessIdentity as "TEACHING_TEACHER" | "ACADEMIC_PLANNER", body.gradeSubject as string | null | undefined, body.expectedBusinessIdentityVersion as string | null, requiredString(body,"reason"), requiredString(body,"idempotencyKey"), at));
    }
    const roleAssignmentPath = request.path.match(/^\/v1\/admin\/people\/([^/]+)\/role-assignments$/);
    if (request.method === "POST" && roleAssignmentPath !== null) {
      if (Object.keys(body).some((key) => !["sessionId","subject","scope","scopeId","validFrom","validTo","reason","idempotencyKey"].includes(key))) throw new Error("INVALID_INPUT");
      if (typeof body.sessionId !== "string" || !body.sessionId.trim()) throw new Error("UNAUTHENTICATED");
      if (typeof body.subject !== "string" || typeof body.scope !== "string") throw new Error("INVALID_INPUT");
      if (body.scopeId !== undefined && typeof body.scopeId !== "string") throw new Error("INVALID_INPUT");
      if (body.validTo !== undefined && typeof body.validTo !== "string") throw new Error("INVALID_INPUT");
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      if (!services.accountAccess) throw new Error("ACCOUNT_ACCESS_SERVICE_UNAVAILABLE");
      return success(await services.accountAccess.assignRole(context, roleAssignmentPath[1]!, {
        subject: body.subject as PermissionSubject, scope: body.scope as import("@teaching-research-alliance/contracts").PermissionScope,
        ...(body.scopeId === undefined ? {} : { scopeId: body.scopeId }), validFrom: requiredString(body,"validFrom"),
        ...(body.validTo === undefined ? {} : { validTo: body.validTo }), reason: requiredString(body,"reason"),
      }, requiredString(body,"idempotencyKey"), at));
    }
    const roleRevokePath = request.path.match(/^\/v1\/admin\/role-assignments\/([^/]+)\/revoke$/);
    if (request.method === "POST" && roleRevokePath !== null) {
      if (Object.keys(body).some((key) => !["sessionId","reason","idempotencyKey"].includes(key))) throw new Error("INVALID_INPUT");
      if (typeof body.sessionId !== "string" || !body.sessionId.trim()) throw new Error("UNAUTHENTICATED");
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      if (!services.accountAccess) throw new Error("ACCOUNT_ACCESS_SERVICE_UNAVAILABLE");
      return success(await services.accountAccess.revokeRole(context, roleRevokePath[1]!, requiredString(body,"reason"), requiredString(body,"idempotencyKey"), at));
    }
    const statusPath = request.path.match(/^\/v1\/admin\/people\/([^/]+)\/status$/);
    if (request.method === "POST" && statusPath !== null) {
      if (Object.keys(body).some((key) => !["sessionId","status","reason","idempotencyKey"].includes(key))) throw new Error("INVALID_INPUT");
      if (typeof body.sessionId !== "string" || !body.sessionId.trim()) throw new Error("UNAUTHENTICATED");
      const status = requiredString(body,"status"); if (status !== "ACTIVE" && status !== "INACTIVE") throw new Error("INVALID_INPUT");
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      if (!services.accountAccess) throw new Error("ACCOUNT_ACCESS_SERVICE_UNAVAILABLE");
      return success(await services.accountAccess.setPersonStatus(context, statusPath[1]!, status, requiredString(body,"reason"), requiredString(body,"idempotencyKey"), at));
    }
    const passwordResetPath = request.path.match(
      /^\/v1\/admin\/accounts\/([^/]+)\/password-reset$/,
    );
    if (request.method === "POST" && passwordResetPath !== null) {
      if (
        Object.keys(body).some(
          (key) => !["sessionId", "newPassword", "reason", "idempotencyKey"].includes(key),
        )
      ) throw new Error("INVALID_INPUT");
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.accountAccess) throw new Error("ACCOUNT_ACCESS_SERVICE_UNAVAILABLE");
      return success(await services.accountAccess.resetPassword(
        context,
        passwordResetPath[1]!,
        requiredString(body, "newPassword"),
        requiredString(body, "reason"),
        requiredString(body, "idempotencyKey"),
        at,
      ));
    }
    if (request.method === "POST" && request.path === "/v1/session/logout") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      if (!services.sessions.logout)
        throw new Error("SESSION_LOGOUT_UNAVAILABLE");
      await services.sessions.logout(sessionIdFrom(body));
      return success({ loggedOut: true });
    }
    if (request.method === "GET" && request.path === "/v1/session") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      return success(
        sessionData(await services.sessions.get(sessionIdFrom(body), at)),
      );
    }
    if (
      request.method === "GET" &&
      ["/v1/teaching/referrals", "/v1/teaching/weeks"].includes(request.path)
    ) {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.teaching) throw new Error("TEACHING_SERVICE_UNAVAILABLE");
      return success(
        request.path === "/v1/teaching/referrals"
          ? await services.teaching.listReceivedReferrals(context, at)
          : await services.teaching.listOpenTeachingWeeks(context, at),
      );
    }
    if (
      request.method === "GET" &&
      (request.path === "/v1/me" || request.path === "/v1/venues/available")
    ) {
      if (typeof body.sessionId !== "string" || body.sessionId.trim() === "")
        throw new Error("UNAUTHENTICATED");
      const session = await services.sessions.get(sessionIdFrom(body), at);
      const context = currentContext(session);
      if (services.personal === undefined)
        throw new Error("PERSONAL_SERVICE_UNAVAILABLE");
      return success(
        request.path === "/v1/me"
          ? await services.personal.getOwnOverview(context, at)
          : await services.personal.listAvailableVenues(context),
      );
    }
    if (request.method === "POST" && request.path === "/v1/venues") {
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.venues) throw new Error("VENUE_SERVICE_UNAVAILABLE");
      const makeDefault =
        body.makeDefault === undefined ? undefined : body.makeDefault;
      if (makeDefault !== undefined && typeof makeDefault !== "boolean")
        throw new Error("INVALID_INPUT");
      return success(
        await services.venues.create(
          context,
          {
            name: requiredString(body, "name"),
            ...(makeDefault === undefined ? {} : { makeDefault }),
          },
          requiredString(body, "idempotencyKey"),
          at,
        ),
      );
    }
    if (request.method === "GET" && request.path === "/v1/venues/mine") {
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.venueReads) throw new Error("VENUE_SERVICE_UNAVAILABLE");
      return success(await services.venueReads.listOwned(context, at));
    }
    if (request.method === "GET" && request.path === "/v1/venues/visible") {
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.venueReads) throw new Error("VENUE_SERVICE_UNAVAILABLE");
      return success(await services.venueReads.list(context, at));
    }
    const venueBoardPath = request.path.match(/^\/v1\/venues\/([^/]+)\/board$/);
    if (request.method === "GET" && venueBoardPath) {
      const query = request.query ?? {};
      if (
        Object.keys(query).some(
          (key) => !["weekId", "startsOn", "endsOn"].includes(key),
        )
      )
        throw new Error("INVALID_INPUT");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.venueBoards) throw new Error("VENUE_SERVICE_UNAVAILABLE");
      return success(
        await services.venueBoards.get(
          context,
          venueBoardPath[1]!,
          {
            ...(query.weekId === undefined
              ? {}
              : { teachingWeekId: query.weekId }),
            ...(query.startsOn === undefined
              ? {}
              : { startsOn: query.startsOn }),
            ...(query.endsOn === undefined ? {} : { endsOn: query.endsOn }),
          },
          at,
        ),
      );
    }
    const venuePath = request.path.match(/^\/v1\/venues\/([^/]+)$/);
    if (request.method === "GET" && venuePath) {
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.venueReads) throw new Error("VENUE_SERVICE_UNAVAILABLE");
      return success(await services.venueReads.get(context, venuePath[1]!, at));
    }
    if (venuePath && request.method === "PATCH") {
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.venues) throw new Error("VENUE_SERVICE_UNAVAILABLE");
      const expectedVersion = body.expectedVersion;
      if (
        typeof expectedVersion !== "number" ||
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 1
      )
        throw new Error("INVALID_INPUT");
      const command = requiredString(body, "idempotencyKey");
      if (body.name !== undefined && typeof body.name === "string")
        return success(
          await services.venues.rename(
            context,
            venuePath[1]!,
            { name: body.name, expectedVersion },
            command,
            at,
          ),
        );
      if (body.status === "ACTIVE" || body.status === "INACTIVE")
        return success(
          await services.venues.setStatus(
            context,
            venuePath[1]!,
            { status: body.status, expectedVersion },
            command,
            at,
          ),
        );
      throw new Error("INVALID_INPUT");
    }
    const defaultVenuePath = request.path.match(
      /^\/v1\/venues\/([^/]+)\/default$/,
    );
    if (request.method === "POST" && defaultVenuePath) {
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.venues) throw new Error("VENUE_SERVICE_UNAVAILABLE");
      if (
        typeof body.expectedVersion !== "number" ||
        !Number.isSafeInteger(body.expectedVersion) ||
        body.expectedVersion < 1
      )
        throw new Error("INVALID_INPUT");
      return success(
        await services.venues.setDefault(
          context,
          defaultVenuePath[1]!,
          { expectedVersion: body.expectedVersion },
          requiredString(body, "idempotencyKey"),
          at,
        ),
      );
    }
    const permissionVenuePath = request.path.match(
      /^\/v1\/venues\/([^/]+)\/permissions$/,
    );
    if (request.method === "POST" && permissionVenuePath) {
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.venues) throw new Error("VENUE_SERVICE_UNAVAILABLE");
      if (
        typeof body.canView !== "boolean" ||
        typeof body.canWithdraw !== "boolean"
      )
        throw new Error("INVALID_INPUT");
      if (
        body.expectedGrantId !== undefined &&
        body.expectedGrantId !== null &&
        typeof body.expectedGrantId !== "string"
      )
        throw new Error("INVALID_INPUT");
      const permissionDraft = {
        granteePersonId: requiredString(body, "granteePersonId"),
        canView: body.canView,
        canWithdraw: body.canWithdraw,
        ...(body.expectedGrantId === undefined
          ? {}
          : { expectedGrantId: body.expectedGrantId as string | null }),
      };
      return success(
        await services.venues.setPermission(
          context,
          permissionVenuePath[1]!,
          permissionDraft,
          requiredString(body, "idempotencyKey"),
          at,
        ),
      );
    }
    if (request.method === "POST" && request.path === "/v1/session") {
      const credentialField = services.sessions.credentialField ?? "credentialDigest";
      if (
        Object.keys(body).some(
          (key) => !["phoneNormalized", credentialField].includes(key),
        )
      ) throw new Error("INVALID_INPUT");
      const view = await services.sessions.login(
        requiredString(body, "phoneNormalized"),
        requiredString(body, credentialField),
        at,
        request.sourceIp,
      );
      return success(sessionData(view));
    }
    if (
      request.method === "POST" &&
      request.path === "/v1/role-contexts/switch"
    ) {
      const view = await services.sessions.switchRole(
        sessionIdFrom(body),
        subjectFrom(requiredString(body, "subject")),
        at,
      );
      return success(sessionData(view));
    }
    if (
      request.method === "POST" &&
      request.path === "/v1/admin/rates/preview"
    ) {
      if (services.ratePolicies === undefined)
        throw new Error("RATE_POLICY_SERVICE_UNAVAILABLE");
      const session = await services.sessions.get(sessionIdFrom(body), at);
      return success(
        services.ratePolicies.preview(
          currentContext(session).subject,
          ratePolicyDraft(body),
        ),
      );
    }
    if (
      request.method === "POST" &&
      request.path === "/v1/admin/rates/publish"
    ) {
      if (services.ratePolicies === undefined)
        throw new Error("RATE_POLICY_SERVICE_UNAVAILABLE");
      const session = await services.sessions.get(sessionIdFrom(body), at);
      return success(
        services.ratePolicies.publish(
          currentContext(session).subject,
          requiredString(body, "previewId"),
        ),
      );
    }
    if (
      request.method === "GET" &&
      request.path === "/v1/admin/person-relationships/group-leader-candidates"
    ) {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      if (Object.keys(body).some((field) => field !== "sessionId") || Object.keys(request.query ?? {}).length !== 0)
        throw new Error("INVALID_INPUT");
      if (!services.groupLeaderDirectory) throw new Error("RELATIONSHIP_SERVICE_UNAVAILABLE");
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      assertRelationshipManager(context);
      return success(relationshipCandidatesResponse(await services.groupLeaderDirectory.list(context, at)));
    }
    if (
      request.method === "POST" &&
      request.path === "/v1/admin/person-relationships/preview"
    ) {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      if (Object.keys(body).some((field) => !["sessionId", "teacherPersonId", "newRelatedPersonId", "effectiveTeachingWeekId", "reason"].includes(field))
        || Object.keys(request.query ?? {}).length !== 0) throw new Error("INVALID_INPUT");
      if (!services.groupLeaderRelationships) throw new Error("RELATIONSHIP_SERVICE_UNAVAILABLE");
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      assertRelationshipManager(context);
      return success(relationshipPreviewResponse(await services.groupLeaderRelationships.preview(context, {
        teacherPersonId: requiredString(body, "teacherPersonId"),
        newRelatedPersonId: requiredString(body, "newRelatedPersonId"),
        effectiveTeachingWeekId: requiredString(body, "effectiveTeachingWeekId"),
        reason: requiredString(body, "reason"),
      }, at)));
    }
    if (
      request.method === "POST" &&
      request.path === "/v1/admin/person-relationships"
    ) {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      if (Object.keys(body).some((field) => !["sessionId", "previewId", "idempotencyKey"].includes(field))
        || Object.keys(request.query ?? {}).length !== 0) throw new Error("INVALID_INPUT");
      if (!services.groupLeaderRelationships) throw new Error("RELATIONSHIP_SERVICE_UNAVAILABLE");
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      assertRelationshipManager(context);
      return success(relationshipPublishResponse(await services.groupLeaderRelationships.publish(
        context, requiredString(body, "previewId"), requiredString(body, "idempotencyKey"), at,
      )));
    }
    if (request.method === "GET" && request.path === "/v1/planning-mentor/relationships") {
      if (typeof request.sessionId !== "string" || !request.sessionId.trim()) throw new Error("UNAUTHENTICATED");
      if (Object.keys(parsedBody).length !== 0 || Object.keys(request.query ?? {}).length !== 0) throw new Error("INVALID_INPUT");
      if (!services.planningMentorRelationships) throw new Error("RELATIONSHIP_SERVICE_UNAVAILABLE");
      const context = currentContext(await services.sessions.get(request.sessionId, at));
      assertPlanningMentorRelationshipManager(context);
      return success(planningMentorDirectoryResponse(await services.planningMentorRelationships.listDirectory(context, at)));
    }
    if (request.method === "POST" && request.path === "/v1/planning-mentor/relationships/preview") {
      if (typeof request.sessionId !== "string" || !request.sessionId.trim()) throw new Error("UNAUTHENTICATED");
      if (Object.keys(parsedBody).some((field) => !["action", "plannerPersonId", "effectiveTeachingWeekId", "reason"].includes(field))
        || Object.keys(request.query ?? {}).length !== 0) throw new Error("INVALID_INPUT");
      const action = requiredString(body, "action");
      if (action !== "ADD" && action !== "REMOVE") throw new Error("INVALID_INPUT");
      if (!services.planningMentorRelationships) throw new Error("RELATIONSHIP_SERVICE_UNAVAILABLE");
      const context = currentContext(await services.sessions.get(request.sessionId, at));
      assertPlanningMentorRelationshipManager(context);
      return success(planningMentorPreviewResponse(await services.planningMentorRelationships.preview(context, {
        action, plannerPersonId: requiredString(body, "plannerPersonId"),
        effectiveTeachingWeekId: requiredString(body, "effectiveTeachingWeekId"), reason: requiredString(body, "reason"),
      }, at)));
    }
    if (request.method === "POST" && request.path === "/v1/planning-mentor/relationships") {
      if (typeof request.sessionId !== "string" || !request.sessionId.trim()) throw new Error("UNAUTHENTICATED");
      if (Object.keys(parsedBody).some((field) => !["previewId", "idempotencyKey"].includes(field))
        || Object.keys(request.query ?? {}).length !== 0) throw new Error("INVALID_INPUT");
      if (!services.planningMentorRelationships) throw new Error("RELATIONSHIP_SERVICE_UNAVAILABLE");
      const context = currentContext(await services.sessions.get(request.sessionId, at));
      assertPlanningMentorRelationshipManager(context);
      return success(planningMentorPublishResponse(await services.planningMentorRelationships.publish(
        context, requiredString(body, "previewId"), requiredString(body, "idempotencyKey"), at,
      )));
    }
    if (request.method === "GET" && request.path === "/v1/referrals/sent") {
      const session = await services.sessions.get(request.sessionId ?? "", at);
      if (!services.sentReferrals)
        throw new Error("REFERRAL_SERVICE_UNAVAILABLE");
      return success(
        await services.sentReferrals.list(currentContext(session), at),
      );
    }
    if (request.method === "GET" && request.path === "/v1/referrals/managed") {
      if (Object.keys(body).some((field) => field !== "sessionId")
        || Object.keys(request.query ?? {}).length !== 0)
        throw new Error("INVALID_INPUT");
      if (!services.managedReferrals) throw new Error("REFERRAL_SERVICE_UNAVAILABLE");
      const session = await services.sessions.get(request.sessionId ?? "", at);
      return success(await services.managedReferrals.list(currentContext(session), at));
    }
    if (
      request.method === "GET" &&
      request.path === "/v1/referrals/receiving-teachers"
    ) {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.referrals) throw new Error("REFERRAL_SERVICE_UNAVAILABLE");
      return success(await services.referrals.listReceivingTeachers(context));
    }
    if (request.method === "POST" && request.path === "/v1/referrals") {
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.referrals) throw new Error("REFERRAL_SERVICE_UNAVAILABLE");
      for (const key of [
        "referrerPersonId",
        "referrerIdentity",
        "sourceSubject",
        "campusId",
        "planningMentorPersonId",
      ]) {
        if (key in body) throw new Error("INVALID_INPUT");
      }
      const classType = requiredString(body, "classType");
      if (classType !== "ONE_TO_ONE" && classType !== "SMALL_GROUP")
        throw new Error("INVALID_INPUT");
      return success(
        await services.referrals.create(
          context,
          {
            receiverPersonId: requiredString(body, "receiverPersonId"),
            studentDisplayName: requiredString(body, "studentDisplayName"),
            courseContextId: requiredString(body, "courseContextId"),
            classType,
          },
          requiredString(body, "idempotencyKey"),
          at,
        ),
      );
    }
    if (
      request.method === "GET" &&
      request.path === "/v1/finance/bonus-projects"
    ) {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      if (Object.keys(request.query ?? {}).length > 0)
        throw new Error("INVALID_INPUT");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.bonusProjects)
        throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      return success(await services.bonusProjects.list(context));
    }
    if (
      request.method === "GET" &&
      request.path === "/v1/finance/project-bonuses"
    ) {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      if (Object.keys(body).some((field) => field !== "sessionId"))
        throw new Error("INVALID_INPUT");
      const query = request.query ?? {};
      if (Object.keys(query).some((field) => !["cursor", "limit"].includes(field)))
        throw new Error("INVALID_INPUT");
      let limit: number | undefined;
      if (query.limit !== undefined) {
        limit = Number(query.limit);
        if (!/^\d+$/.test(query.limit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          throw new Error("INVALID_INPUT");
      }
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      if (!services.projectBonusReads) throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      return success(await services.projectBonusReads.list(context, {
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(limit === undefined ? {} : { limit }),
      }));
    }
    const projectBonusDetailPath = request.path.match(/^\/v1\/finance\/project-bonuses\/([^/]+)$/);
    if (request.method === "GET" && projectBonusDetailPath !== null) {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      if (Object.keys(body).some((field) => field !== "sessionId") || Object.keys(request.query ?? {}).length > 0)
        throw new Error("INVALID_INPUT");
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      if (!services.projectBonusReads) throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      return success(await services.projectBonusReads.getDetail(context, projectBonusDetailPath[1]!));
    }
    const bonusProjectRenamePath = request.path.match(
      /^\/v1\/admin\/bonus-projects\/([^/]+)\/name$/,
    );
    if (request.method === "POST" && bonusProjectRenamePath !== null) {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      if (
        Object.keys(body).some(
          (field) =>
            ![
              "sessionId",
              "expectedVersion",
              "displayName",
              "reason",
              "idempotencyKey",
            ].includes(field),
        )
      )
        throw new Error("INVALID_INPUT");
      const projectNo = Number(bonusProjectRenamePath[1]);
      if (
        !Number.isSafeInteger(projectNo) ||
        projectNo < 1 ||
        projectNo > 10 ||
        typeof body.expectedVersion !== "number" ||
        !Number.isSafeInteger(body.expectedVersion) ||
        body.expectedVersion < 1
      )
        throw new Error("INVALID_INPUT");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.bonusProjects)
        throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      return success(
        await services.bonusProjects.rename(
          context,
          projectNo,
          {
            expectedVersion: body.expectedVersion,
            displayName: requiredString(body, "displayName"),
            reason: requiredString(body, "reason"),
          },
          requiredString(body, "idempotencyKey"),
          at,
        ),
      );
    }
    if (request.method === "GET" && request.path === "/v1/organizations/revenue") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim()) throw new Error("UNAUTHENTICATED");
      const query = request.query ?? {};
      if (Object.keys(body).some((key) => key !== "sessionId")
        || Object.keys(query).some((key) => key !== "fromMonth" && key !== "toMonth")
        || query.fromMonth === undefined || query.toMonth === undefined) throw new Error("INVALID_INPUT");
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      const scope = permissionScope(context.subject, "VIEW_ORGANIZATION_REVENUE");
      if (scope === undefined || scope !== context.scope || context.venueId !== undefined
        || (scope === "GLOBAL" && (context.regionId !== undefined || context.campusId !== undefined))
        || (scope === "REGION" && (!context.regionId || context.campusId !== undefined))
        || (scope === "CAMPUS" && (!context.campusId || context.regionId !== undefined))) throw new Error("FORBIDDEN_SCOPE");
      if (!services.organizationRevenue) throw new Error("ORGANIZATION_REVENUE_SERVICE_UNAVAILABLE");
      return success(await services.organizationRevenue.get(context, {fromMonth: query.fromMonth, toMonth: query.toMonth}, at));
    }
    if (
      request.method === "GET" &&
      request.path === "/v1/finance/cash-wage-teachers"
    ) {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const query = request.query ?? {};
      if (
        Object.keys(body).some((field) => field !== "sessionId") ||
        Object.keys(query).length > 0
      )
        throw new Error("INVALID_INPUT");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (
        permissionScope(context.subject, "MANAGE_CASH_WAGES") !== "GLOBAL" ||
        context.scope !== "GLOBAL" ||
        context.regionId !== undefined ||
        context.campusId !== undefined ||
        context.venueId !== undefined
      )
        throw new Error("FORBIDDEN_SCOPE");
      if (!services.cashWageTeacherDirectory)
        throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      const directory = await services.cashWageTeacherDirectory.list(context);
      return success({
        items: directory.items.map((item) => ({
          id: item.personId,
          nickname: item.nickname,
        })),
      });
    }
    if (
      request.method === "GET" &&
      request.path === "/v1/finance/cash-wage-roster"
    ) {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const query = request.query ?? {};
      if (
        Object.keys(query).some((field) => field !== "month") ||
        query.month === undefined
      )
        throw new Error("INVALID_INPUT");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.cashWageReads)
        throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      return success(
        await services.cashWageReads.listRoster(context, query.month),
      );
    }
    if (
      request.method === "GET" &&
      request.path === "/v1/finance/cash-wage-confirmations"
    ) {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const query = request.query ?? {};
      if (
        Object.keys(query).some(
          (field) =>
            !["month", "teacherPersonId", "cursor", "limit"].includes(field),
        ) ||
        query.month === undefined
      )
        throw new Error("INVALID_INPUT");
      let limit: number | undefined;
      if (query.limit !== undefined) {
        limit = Number(query.limit);
        if (
          !/^\d+$/.test(query.limit) ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 100
        )
          throw new Error("INVALID_INPUT");
      }
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.cashWageReads)
        throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      return success(
        await services.cashWageReads.listConfirmations(context, {
          month: query.month,
          ...(query.teacherPersonId === undefined
            ? {}
            : { teacherPersonId: query.teacherPersonId }),
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          ...(limit === undefined ? {} : { limit }),
        }),
      );
    }
    const cashWageDetailPath = request.path.match(
      /^\/v1\/finance\/cash-wages\/([^/]+)$/,
    );
    if (request.method === "GET" && cashWageDetailPath !== null) {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      if (Object.keys(request.query ?? {}).length > 0)
        throw new Error("INVALID_INPUT");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.cashWageReads)
        throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      return success(
        await services.cashWageReads.getDetail(context, cashWageDetailPath[1]!),
      );
    }
    if (
      request.method === "GET" &&
      request.path === "/v1/finance/benefit-source-funds"
    ) {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      if (
        Object.keys(parsedBody).length > 0 ||
        Object.keys(request.query ?? {}).length > 0
      )
        throw new Error("INVALID_INPUT");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (
        (context.subject !== "HEADQUARTERS_FINANCE" &&
          context.subject !== "SYSTEM_ADMIN" &&
          context.subject !== "SYSTEM_OWNER") ||
        context.scope !== "GLOBAL" ||
        context.regionId !== undefined ||
        context.campusId !== undefined ||
        context.venueId !== undefined
      )
        throw new Error("FORBIDDEN_SCOPE");
      if (!services.benefitSourceFunds)
        throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      return success(await services.benefitSourceFunds.list(context, at));
    }
    const benefitDetailPath = request.path.match(/^\/v1\/finance\/benefits\/([^/]+)$/);
    if (request.method === "GET" && (request.path === "/v1/finance/benefit-roster" || benefitDetailPath !== null)) {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim()) throw new Error("UNAUTHENTICATED");
      const query = request.query ?? {};
      const roster = benefitDetailPath === null;
      if (Object.keys(body).some(field => field !== "sessionId") ||
          Object.keys(query).some(field => !roster || field !== "month") ||
          (roster && (query.month === undefined || !/^\d{4}-(0[1-9]|1[0-2])-01$/.test(query.month)))) throw new Error("INVALID_INPUT");
      const context = currentContext(await services.sessions.get(sessionIdFrom(body), at));
      if (permissionScope(context.subject, "READ_MANAGED_CASH_WAGES") !== "GLOBAL" || context.scope !== "GLOBAL" || context.regionId !== undefined || context.campusId !== undefined || context.venueId !== undefined) throw new Error("FORBIDDEN_SCOPE");
      if (!services.benefitReads) throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      return success(roster
        ? await services.benefitReads.listRoster(context, query.month!, at)
        : await services.benefitReads.getDetail(context, benefitDetailPath![1]!));
    }
    const salaryBenefitAction =
      request.method === "POST" ? request.path : undefined;
    if (
      salaryBenefitAction !== undefined &&
      [
        "/v1/finance/salary-benefits/documents",
        "/v1/finance/cash-wage-plans",
        "/v1/finance/cash-wage-todos/generate",
        "/v1/finance/cash-wages/confirm",
        "/v1/finance/project-bonuses/grant",
        "/v1/finance/benefit-plans",
        "/v1/finance/benefit-todos/generate",
        "/v1/finance/benefits/confirm",
        "/v1/finance/salary-benefits/reverse",
      ].includes(salaryBenefitAction)
    ) {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      if (!services.salaryBenefits)
        throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (
        (context.subject !== "HEADQUARTERS_FINANCE" &&
          context.subject !== "SYSTEM_ADMIN" &&
          context.subject !== "SYSTEM_OWNER") ||
        context.scope !== "GLOBAL" ||
        context.regionId !== undefined ||
        context.campusId !== undefined ||
        context.venueId !== undefined
      ) {
        throw new Error("FORBIDDEN_SCOPE");
      }
      const idempotencyKey = requiredString(body, "idempotencyKey");
      const only = (keys: readonly string[]): void => {
        if (Object.keys(body).some((key) => !keys.includes(key)))
          throw new Error("INVALID_INPUT");
      };
      const expectedVersion = (key = "expectedVersion"): number => {
        const value = body[key];
        if (
          typeof value !== "number" ||
          !Number.isSafeInteger(value) ||
          value < 1
        )
          throw new Error("INVALID_INPUT");
        return value;
      };
      const attachmentVersionIds = (): readonly string[] => {
        const value = body.attachmentVersionIds;
        if (
          !Array.isArray(value) ||
          value.length < 2 ||
          value.length > 20 ||
          value.some((id) => typeof id !== "string" || !id.trim())
        ) {
          throw new Error("INVALID_INPUT");
        }
        return value as readonly string[];
      };
      if (salaryBenefitAction === "/v1/finance/salary-benefits/documents") {
        only(["sessionId", "kind", "idempotencyKey"]);
        const kind = requiredString(body, "kind");
        if (
          !(SALARY_BENEFIT_DOCUMENT_KINDS as readonly string[]).includes(kind)
        )
          throw new Error("INVALID_INPUT");
        return success(
          await services.salaryBenefits.createEvidenceDocument(
            context,
            kind as (typeof SALARY_BENEFIT_DOCUMENT_KINDS)[number],
            idempotencyKey,
            at,
          ),
        );
      }
      if (salaryBenefitAction === "/v1/finance/cash-wage-plans") {
        only([
          "sessionId",
          "teacherPersonId",
          "salaryMonth",
          "plannedCashCents",
          "plannedDeductionCents",
          "active",
          "reason",
          "applyToFutureMonths",
          "idempotencyKey",
        ]);
        if (
          typeof body.active !== "boolean" ||
          (body.applyToFutureMonths !== undefined &&
            typeof body.applyToFutureMonths !== "boolean")
        )
          throw new Error("INVALID_INPUT");
        return success(
          await services.salaryBenefits.setCashWagePlan(
            context,
            {
              teacherPersonId: requiredString(body, "teacherPersonId"),
              salaryMonth: requiredString(body, "salaryMonth"),
              plannedCashCents: requiredString(body, "plannedCashCents"),
              plannedDeductionCents: requiredString(
                body,
                "plannedDeductionCents",
              ),
              active: body.active,
              reason: requiredString(body, "reason"),
              ...(body.applyToFutureMonths === undefined
                ? {}
                : { applyToFutureMonths: body.applyToFutureMonths }),
            },
            idempotencyKey,
            at,
          ),
        );
      }
      if (salaryBenefitAction === "/v1/finance/cash-wage-todos/generate") {
        only(["sessionId", "idempotencyKey"]);
        return success(
          await services.salaryBenefits.generateCashWageTodos(
            context,
            idempotencyKey,
            at,
          ),
        );
      }
      if (salaryBenefitAction === "/v1/finance/cash-wages/confirm") {
        only([
          "sessionId",
          "documentId",
          "expectedVersion",
          "todoId",
          "cashPaidCents",
          "deductionCents",
          "reason",
          "attachmentVersionIds",
          "correctionOfDocumentId",
          "idempotencyKey",
        ]);
        if (
          body.correctionOfDocumentId !== undefined &&
          (typeof body.correctionOfDocumentId !== "string" ||
            !body.correctionOfDocumentId.trim())
        )
          throw new Error("INVALID_INPUT");
        return success(
          await services.salaryBenefits.confirmCashWage(
            context,
            {
              documentId: requiredString(body, "documentId"),
              expectedVersion: expectedVersion(),
              todoId: requiredString(body, "todoId"),
              cashPaidCents: requiredString(body, "cashPaidCents"),
              deductionCents: requiredString(body, "deductionCents"),
              paidAt: at.toISOString(),
              reason: requiredString(body, "reason"),
              attachmentVersionIds: attachmentVersionIds(),
              ...(body.correctionOfDocumentId === undefined
                ? {}
                : { correctionOfDocumentId: body.correctionOfDocumentId }),
            },
            idempotencyKey,
            at,
          ),
        );
      }
      if (salaryBenefitAction === "/v1/finance/project-bonuses/grant") {
        only([
          "sessionId",
          "documentId",
          "expectedVersion",
          "projectNo",
          "projectName",
          "projectNameVersionId",
          "recipientPersonId",
          "sourceFundId",
          "amountCents",
          "reason",
          "attachmentVersionIds",
          "idempotencyKey",
        ]);
        if (
          typeof body.projectNo !== "number" ||
          !Number.isSafeInteger(body.projectNo)
        )
          throw new Error("INVALID_INPUT");
        if (
          body.projectNameVersionId !== undefined &&
          (typeof body.projectNameVersionId !== "string" ||
            !body.projectNameVersionId.trim())
        )
          throw new Error("INVALID_INPUT");
        return success(
          await services.salaryBenefits.grantBonus(
            context,
            {
              documentId: requiredString(body, "documentId"),
              expectedVersion: expectedVersion(),
              projectNo: body.projectNo,
              projectName: requiredString(body, "projectName"),
              recipientPersonId: requiredString(body, "recipientPersonId"),
              sourceFundId: requiredString(body, "sourceFundId"),
              amountCents: requiredString(body, "amountCents"),
              reason: requiredString(body, "reason"),
              attachmentVersionIds: attachmentVersionIds(),
              ...(body.projectNameVersionId === undefined
                ? {}
                : { projectNameVersionId: body.projectNameVersionId }),
            },
            idempotencyKey,
            at,
          ),
        );
      }
      if (salaryBenefitAction === "/v1/finance/benefit-plans") {
        only([
          "sessionId",
          "benefitKind",
          "beneficiaryPersonId",
          "benefitMonth",
          "executionDay",
          "amountCents",
          "sourceFundId",
          "active",
          "reason",
          "idempotencyKey",
        ]);
        const benefitKind = requiredString(body, "benefitKind");
        if (
          (benefitKind !== "SOCIAL_INSURANCE" &&
            benefitKind !== "HOUSING_FUND") ||
          typeof body.executionDay !== "number" ||
          !Number.isSafeInteger(body.executionDay) ||
          typeof body.active !== "boolean"
        )
          throw new Error("INVALID_INPUT");
        return success(
          await services.salaryBenefits.setBenefitPlan(
            context,
            {
              benefitKind,
              beneficiaryPersonId: requiredString(body, "beneficiaryPersonId"),
              benefitMonth: requiredString(body, "benefitMonth"),
              executionDay: body.executionDay,
              amountCents: requiredString(body, "amountCents"),
              sourceFundId: requiredString(body, "sourceFundId"),
              active: body.active,
              reason: requiredString(body, "reason"),
            },
            idempotencyKey,
            at,
          ),
        );
      }
      if (salaryBenefitAction === "/v1/finance/benefit-todos/generate") {
        only(["sessionId", "idempotencyKey"]);
        return success(
          await services.salaryBenefits.generateBenefitTodos(
            context,
            idempotencyKey,
            at,
          ),
        );
      }
      if (salaryBenefitAction === "/v1/finance/benefits/confirm") {
        only([
          "sessionId",
          "documentId",
          "expectedVersion",
          "expectedPlanVersionId",
          "todoId",
          "reason",
          "attachmentVersionIds",
          "idempotencyKey",
        ]);
        return success(
          await services.salaryBenefits.confirmBenefit(
            context,
            {
              documentId: requiredString(body, "documentId"),
              expectedVersion: expectedVersion(),
              expectedPlanVersionId: requiredString(body, "expectedPlanVersionId"),
              todoId: requiredString(body, "todoId"),
              reason: requiredString(body, "reason"),
              attachmentVersionIds: attachmentVersionIds(),
            },
            idempotencyKey,
            at,
          ),
        );
      }
      only([
        "sessionId",
        "originalDocumentId",
        "reversalDocumentId",
        "expectedOriginalVersion",
        "expectedReversalVersion",
        "reason",
        "attachmentVersionIds",
        "idempotencyKey",
      ]);
      return success(
        await services.salaryBenefits.reversePosting(
          context,
          {
            originalDocumentId: requiredString(body, "originalDocumentId"),
            reversalDocumentId: requiredString(body, "reversalDocumentId"),
            expectedOriginalVersion: expectedVersion("expectedOriginalVersion"),
            expectedReversalVersion: expectedVersion("expectedReversalVersion"),
            reason: requiredString(body, "reason"),
            attachmentVersionIds: attachmentVersionIds(),
          },
          idempotencyKey,
          at,
        ),
      );
    }
    if (request.path === "/v1/finance/drafts" && request.method === "POST") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.financeDrafts)
        throw new Error("FINANCE_DRAFT_SERVICE_UNAVAILABLE");
      if (
        Object.keys(body).some(
          (key) => !["sessionId", "kind", "idempotencyKey"].includes(key),
        )
      )
        throw new Error("INVALID_INPUT");
      const kind = requiredString(body, "kind");
      if (
        kind !== "WITHDRAWAL" &&
        kind !== "REIMBURSEMENT" &&
        kind !== "EXTERNAL_PAYMENT" &&
        kind !== "REFUND" &&
        kind !== "SELF_PURCHASE"
      )
        throw new Error("INVALID_INPUT");
      return success(
        await services.financeDrafts.create(
          context,
          { kind },
          requiredString(body, "idempotencyKey"),
          at,
        ),
      );
    }
    if (
      request.path === "/v1/finance/drafts/mine" &&
      request.method === "GET"
    ) {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.financeDrafts)
        throw new Error("FINANCE_DRAFT_SERVICE_UNAVAILABLE");
      return success(await services.financeDrafts.listOwn(context, at));
    }
    const financeDraftPath = request.path.match(
      /^\/v1\/finance\/drafts\/([^/]+)$/,
    );
    if (financeDraftPath !== null && request.method === "GET") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.financeDrafts)
        throw new Error("FINANCE_DRAFT_SERVICE_UNAVAILABLE");
      return success(
        await services.financeDrafts.getOwn(context, financeDraftPath[1]!, at),
      );
    }
    const withdrawalSubmitPath = request.path.match(
      /^\/v1\/finance\/drafts\/([^/]+)\/withdrawal-submit$/,
    );
    const withdrawalActionPath = request.path.match(
      /^\/v1\/finance\/withdrawals\/([^/]+)\/(finance-revoke|mark-transferred)$/,
    );
    if (
      request.method === "POST" &&
      (withdrawalSubmitPath || withdrawalActionPath)
    ) {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.withdrawals) throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      const common = ["sessionId", "expectedVersion", "idempotencyKey"];
      const allowed = withdrawalSubmitPath
        ? [
            ...common,
            "sourceAccountId",
            "amountCents",
            "recipientName",
            "bankAccount",
            "bankName",
            "attachmentVersionIds",
          ]
        : withdrawalActionPath![2] === "finance-revoke"
          ? [...common, "reason"]
          : [...common, "attachmentVersionIds"];
      if (
        Object.keys(body).some((key) => !allowed.includes(key)) ||
        typeof body.expectedVersion !== "number" ||
        !Number.isSafeInteger(body.expectedVersion) ||
        body.expectedVersion < 1
      )
        throw new Error("INVALID_INPUT");
      const expectedVersion = body.expectedVersion,
        key = requiredString(body, "idempotencyKey");
      if (withdrawalActionPath?.[2] === "finance-revoke")
        return success(
          await services.withdrawals.revoke(
            context,
            withdrawalActionPath[1]!,
            { expectedVersion, reason: requiredString(body, "reason") },
            key,
            at,
          ),
        );
      if (
        !Array.isArray(body.attachmentVersionIds) ||
        body.attachmentVersionIds.length === 0 ||
        body.attachmentVersionIds.length > 20 ||
        body.attachmentVersionIds.some((id) => typeof id !== "string")
      )
        throw new Error("INVALID_INPUT");
      const attachmentVersionIds = body.attachmentVersionIds as string[];
      if (withdrawalSubmitPath)
        return success(
          await services.withdrawals.submit(
            context,
            withdrawalSubmitPath[1]!,
            {
              expectedVersion,
              sourceAccountId: requiredString(body, "sourceAccountId"),
              amountCents: requiredString(body, "amountCents"),
              recipientName: requiredString(body, "recipientName"),
              bankAccount: requiredString(body, "bankAccount"),
              ...(body.bankName === undefined
                ? {}
                : { bankName: requiredString(body, "bankName") }),
              attachmentVersionIds,
            },
            key,
            at,
          ),
        );
      return success(
        await services.withdrawals.markTransferred(
          context,
          withdrawalActionPath![1]!,
          { expectedVersion, attachmentVersionIds },
          key,
          at,
        ),
      );
    }
    const withdrawalReadPath = request.path.match(
      /^\/v1\/finance\/withdrawals\/([^/]+)$/,
    );
    if (request.method === "GET" && withdrawalReadPath) {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.withdrawalReads)
        throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      const id = withdrawalReadPath[1]!;
      if (id === "sources")
        return success(await services.withdrawalReads.listSources(context, at));
      if (id === "mine")
        return success(await services.withdrawalReads.listOwn(context, at));
      if (id === "pending-transfer")
        return success(await services.withdrawalReads.listPending(context));
      if (id === "managed")
        return success(await services.withdrawalReads.listManaged(context));
      return success(await services.withdrawalReads.getDetail(context, id, at));
    }
    const refundSubmitPath = request.path.match(
      /^\/v1\/finance\/drafts\/([^/]+)\/refund-submit$/,
    );
    if (refundSubmitPath !== null && request.method === "POST") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.refunds) throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      if (
        Object.keys(body).some(
          (key) =>
            ![
              "sessionId",
              "expectedVersion",
              "weeklyFeeEntryIds",
              "reason",
              "attachmentVersionIds",
              "idempotencyKey",
            ].includes(key),
        ) ||
        typeof body.expectedVersion !== "number" ||
        !Number.isSafeInteger(body.expectedVersion) ||
        body.expectedVersion < 1 ||
        !Array.isArray(body.weeklyFeeEntryIds) ||
        !body.weeklyFeeEntryIds.every((id) => typeof id === "string") ||
        !Array.isArray(body.attachmentVersionIds) ||
        !body.attachmentVersionIds.every((id) => typeof id === "string")
      )
        throw new Error("INVALID_INPUT");
      return success(
        await services.refunds.submit(
          context,
          refundSubmitPath[1]!,
          {
            expectedVersion: body.expectedVersion,
            weeklyFeeEntryIds: body.weeklyFeeEntryIds as string[],
            reason: requiredString(body, "reason"),
            attachmentVersionIds: body.attachmentVersionIds as string[],
          },
          requiredString(body, "idempotencyKey"),
          at,
        ),
      );
    }
    const refundReviewPath = request.path.match(
      /^\/v1\/finance\/refunds\/([^/]+)\/(approve|reject)$/,
    );
    if (refundReviewPath !== null && request.method === "POST") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.refundReviews)
        throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      if (
        Object.keys(body).some(
          (key) =>
            ![
              "sessionId",
              "expectedVersion",
              "reason",
              "idempotencyKey",
            ].includes(key),
        ) ||
        typeof body.expectedVersion !== "number" ||
        !Number.isSafeInteger(body.expectedVersion) ||
        body.expectedVersion < 1
      )
        throw new Error("INVALID_INPUT");
      return success(
        await services.refundReviews[
          refundReviewPath[2] as "approve" | "reject"
        ](
          context,
          refundReviewPath[1]!,
          {
            expectedVersion: body.expectedVersion,
            reason: requiredString(body, "reason"),
          },
          requiredString(body, "idempotencyKey"),
          at,
        ),
      );
    }
    const refundReadPath = request.path.match(
      /^\/v1\/finance\/refunds\/([^/]+)$/,
    );
    if (refundReadPath !== null && request.method === "GET") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.refundReads) throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      const id = refundReadPath[1]!;
      if (id === "mine")
        return success(await services.refundReads.listOwn(context, at));
      if (id === "managed")
        return success(await services.refundReads.listManaged(context));
      return success(await services.refundReads.getDetail(context, id, at));
    }
    const reimbursementSubmitPath = request.path.match(
      /^\/v1\/finance\/drafts\/([^/]+)\/reimbursement-submit$/,
    );
    if (reimbursementSubmitPath !== null && request.method === "POST") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.reimbursements)
        throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      if (
        Object.keys(body).some(
          (key) =>
            ![
              "sessionId",
              "expectedVersion",
              "amountCents",
              "reason",
              "attachmentVersionIds",
              "idempotencyKey",
            ].includes(key),
        ) ||
        typeof body.expectedVersion !== "number" ||
        !Number.isSafeInteger(body.expectedVersion) ||
        body.expectedVersion < 1 ||
        !Array.isArray(body.attachmentVersionIds) ||
        !body.attachmentVersionIds.every((id) => typeof id === "string")
      )
        throw new Error("INVALID_INPUT");
      return success(
        await services.reimbursements.submit(
          context,
          reimbursementSubmitPath[1]!,
          {
            expectedVersion: body.expectedVersion,
            amountCents: requiredString(body, "amountCents"),
            reason: requiredString(body, "reason"),
            attachmentVersionIds: body.attachmentVersionIds as string[],
          },
          requiredString(body, "idempotencyKey"),
          at,
        ),
      );
    }
    const reimbursementReviewPath = request.path.match(
      /^\/v1\/finance\/reimbursements\/([^/]+)\/(approve|reject)$/,
    );
    if (reimbursementReviewPath !== null && request.method === "POST") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.reimbursementReviews)
        throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      if (
        Object.keys(body).some(
          (key) =>
            ![
              "sessionId",
              "expectedVersion",
              "reason",
              "idempotencyKey",
            ].includes(key),
        ) ||
        typeof body.expectedVersion !== "number" ||
        !Number.isSafeInteger(body.expectedVersion) ||
        body.expectedVersion < 1 ||
        typeof body.reason !== "string"
      )
        throw new Error("INVALID_INPUT");
      return success(
        await services.reimbursementReviews[
          reimbursementReviewPath[2] as "approve" | "reject"
        ](
          context,
          reimbursementReviewPath[1]!,
          {
            expectedVersion: body.expectedVersion,
            reason: body.reason,
          },
          requiredString(body, "idempotencyKey"),
          at,
        ),
      );
    }
    const reimbursementExecutePath = request.path.match(
      /^\/v1\/finance\/reimbursements\/([^/]+)\/execute$/,
    );
    if (reimbursementExecutePath !== null && request.method === "POST") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.reimbursementTransfers)
        throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      if (
        Object.keys(body).some(
          (key) =>
            ![
              "sessionId",
              "expectedVersion",
              "idempotencyKey",
            ].includes(key),
        ) ||
        typeof body.expectedVersion !== "number" ||
        !Number.isSafeInteger(body.expectedVersion) ||
        body.expectedVersion < 1
      )
        throw new Error("INVALID_INPUT");
      return success(
        await services.reimbursementTransfers.execute(
          context,
          reimbursementExecutePath[1]!,
          { expectedVersion: body.expectedVersion },
          requiredString(body, "idempotencyKey"),
          at,
        ),
      );
    }
    const reimbursementReversePath = request.path.match(
      /^\/v1\/finance\/reimbursements\/([^/]+)\/reverse$/,
    );
    if (reimbursementReversePath !== null && request.method === "POST") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.reimbursementReversals)
        throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      if (
        Object.keys(body).some(
          (key) =>
            ![
              "sessionId",
              "expectedVersion",
              "reason",
              "idempotencyKey",
            ].includes(key),
        ) ||
        typeof body.expectedVersion !== "number" ||
        !Number.isSafeInteger(body.expectedVersion) ||
        body.expectedVersion < 1
      )
        throw new Error("INVALID_INPUT");
      return success(
        await services.reimbursementReversals.reverse(
          context,
          reimbursementReversePath[1]!,
          {
            expectedVersion: body.expectedVersion,
            reason: requiredString(body, "reason"),
          },
          requiredString(body, "idempotencyKey"),
          at,
        ),
      );
    }
    const reimbursementReadPath = request.path.match(
      /^\/v1\/finance\/reimbursements\/([^/]+)$/,
    );
    if (reimbursementReadPath !== null && request.method === "GET") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.reimbursementReads)
        throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      const id = reimbursementReadPath[1]!;
      if (id === "mine")
        return success(await services.reimbursementReads.listOwn(context, at));
      if (id === "managed")
        return success(await services.reimbursementReads.listManaged(context));
      return success(
        await services.reimbursementReads.getDetail(context, id, at),
      );
    }
    const selfPurchaseSubmitPath = request.path.match(
      /^\/v1\/finance\/drafts\/([^/]+)\/self-purchase-submit$/,
    );
    if (selfPurchaseSubmitPath !== null && request.method === "POST") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.selfPurchases)
        throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      if (
        Object.keys(body).some(
          (key) =>
            ![
              "sessionId",
              "expectedVersion",
              "amountCents",
              "reason",
              "attachmentVersionIds",
              "idempotencyKey",
            ].includes(key),
        ) ||
        typeof body.expectedVersion !== "number" ||
        !Number.isSafeInteger(body.expectedVersion) ||
        body.expectedVersion < 1 ||
        !Array.isArray(body.attachmentVersionIds) ||
        !body.attachmentVersionIds.every((id) => typeof id === "string")
      )
        throw new Error("INVALID_INPUT");
      return success(
        await services.selfPurchases.submit(
          context,
          selfPurchaseSubmitPath[1]!,
          {
            expectedVersion: body.expectedVersion,
            amountCents: requiredString(body, "amountCents"),
            reason: requiredString(body, "reason"),
            attachmentVersionIds: body.attachmentVersionIds as string[],
          },
          requiredString(body, "idempotencyKey"),
          at,
        ),
      );
    }
    const selfPurchaseReversePath = request.path.match(
      /^\/v1\/finance\/self-purchases\/([^/]+)\/reverse$/,
    );
    if (selfPurchaseReversePath !== null && request.method === "POST") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.selfPurchaseReversals)
        throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      if (
        Object.keys(body).some(
          (key) =>
            ![
              "sessionId",
              "expectedVersion",
              "reason",
              "idempotencyKey",
            ].includes(key),
        ) ||
        typeof body.expectedVersion !== "number" ||
        !Number.isSafeInteger(body.expectedVersion) ||
        body.expectedVersion < 1
      )
        throw new Error("INVALID_INPUT");
      return success(
        await services.selfPurchaseReversals.reverse(
          context,
          selfPurchaseReversePath[1]!,
          {
            expectedVersion: body.expectedVersion,
            reason: requiredString(body, "reason"),
          },
          requiredString(body, "idempotencyKey"),
          at,
        ),
      );
    }
    const selfPurchaseReadPath = request.path.match(
      /^\/v1\/finance\/self-purchases\/([^/]+)$/,
    );
    if (selfPurchaseReadPath !== null && request.method === "GET") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.selfPurchaseReads)
        throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      const id = selfPurchaseReadPath[1]!;
      if (id === "mine")
        return success(await services.selfPurchaseReads.listOwn(context, at));
      if (id === "managed")
        return success(await services.selfPurchaseReads.listManaged(context));
      return success(
        await services.selfPurchaseReads.getDetail(context, id, at),
      );
    }
    const companyFundActionPath = request.path.match(
      /^\/v1\/admin\/company-funds\/([^/]+)\/(assignment|status)$/,
    );
    if (
      (request.path === "/v1/admin/company-funds" &&
        (request.method === "GET" || request.method === "POST")) ||
      (companyFundActionPath !== null && request.method === "POST")
    ) {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.companyFunds)
        throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      if (request.method === "GET")
        return success(await services.companyFunds.list(context, at));
      if (companyFundActionPath === null) {
        if (
          Object.keys(body).some(
            (key) =>
              ![
                "sessionId",
                "fundCode",
                "displayName",
                "organizationUnitId",
                "idempotencyKey",
              ].includes(key),
          )
        )
          throw new Error("INVALID_INPUT");
        return success(
          await services.companyFunds.create(
            context,
            {
              fundCode: requiredString(body, "fundCode"),
              displayName: requiredString(body, "displayName"),
              ...(body.organizationUnitId === undefined
                ? {}
                : {
                    organizationUnitId: requiredString(
                      body,
                      "organizationUnitId",
                    ),
                  }),
            },
            requiredString(body, "idempotencyKey"),
            at,
          ),
        );
      }
      if (companyFundActionPath[2] === "assignment") {
        if (
          Object.keys(body).some(
            (key) =>
              ![
                "sessionId",
                "expectedAssignmentId",
                "reason",
                "idempotencyKey",
              ].includes(key),
          )
        )
          throw new Error("INVALID_INPUT");
        if (
          body.expectedAssignmentId !== null &&
          (typeof body.expectedAssignmentId !== "string" ||
            !body.expectedAssignmentId.trim())
        )
          throw new Error("INVALID_INPUT");
        return success(
          await services.companyFunds.assign(
            context,
            {
              fundId: companyFundActionPath[1]!,
              expectedAssignmentId: body.expectedAssignmentId as string | null,
              reason: requiredString(body, "reason"),
            },
            requiredString(body, "idempotencyKey"),
            at,
          ),
        );
      }
      if (
        Object.keys(body).some(
          (key) =>
            ![
              "sessionId",
              "expectedVersion",
              "status",
              "reason",
              "idempotencyKey",
            ].includes(key),
        ) ||
        (body.status !== "ACTIVE" && body.status !== "INACTIVE") ||
        typeof body.expectedVersion !== "number" ||
        !Number.isSafeInteger(body.expectedVersion) ||
        body.expectedVersion < 1
      )
        throw new Error("INVALID_INPUT");
      return success(
        await services.companyFunds.setStatus(
          context,
          companyFundActionPath[1]!,
          {
            expectedVersion: body.expectedVersion,
            status: body.status,
            reason: requiredString(body, "reason"),
          },
          requiredString(body, "idempotencyKey"),
          at,
        ),
      );
    }
    const attachmentReservePath = request.path.match(
      /^\/v1\/finance\/drafts\/([^/]+)\/attachment-uploads$/,
    );
    if (attachmentReservePath !== null && request.method === "POST") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.financeAttachments)
        throw new Error("FINANCE_ATTACHMENT_SERVICE_UNAVAILABLE");
      if (
        Object.keys(body).some(
          (key) =>
            ![
              "sessionId",
              "purpose",
              "originalFilename",
              "declaredMediaType",
              "declaredSizeBytes",
              "expectedSha256",
              "idempotencyKey",
            ].includes(key),
        )
      )
        throw new Error("INVALID_INPUT");
      const purpose = requiredString(body, "purpose"),
        declaredMediaType = requiredString(body, "declaredMediaType"),
        declaredSizeBytes = body.declaredSizeBytes;
      if (
        (purpose !== "SUPPORTING_DOCUMENT" &&
          purpose !== "APPLICATION_SCREENSHOT" &&
          purpose !== "INVOICE" &&
          purpose !== "PAYMENT_RECEIPT") ||
        (declaredMediaType !== "application/pdf" &&
          declaredMediaType !== "image/png" &&
          declaredMediaType !== "image/jpeg") ||
        typeof declaredSizeBytes !== "number" ||
        !Number.isSafeInteger(declaredSizeBytes)
      )
        throw new Error("INVALID_INPUT");
      return success(
        await services.financeAttachments.reserve(
          context,
          attachmentReservePath[1]!,
          {
            purpose,
            originalFilename: requiredString(body, "originalFilename"),
            declaredMediaType,
            declaredSizeBytes,
            ...(body.expectedSha256 === undefined
              ? {}
              : { expectedSha256: requiredString(body, "expectedSha256") }),
          },
          requiredString(body, "idempotencyKey"),
          at,
        ),
      );
    }
    const attachmentVersionPath = request.path.match(
      /^\/v1\/finance\/attachments\/([^/]+)\/versions$/,
    );
    if (attachmentVersionPath !== null && request.method === "POST") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.financeAttachments?.reserveNextVersion)
        throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      if (
        Object.keys(body).some(
          (key) =>
            ![
              "sessionId",
              "originalFilename",
              "declaredMediaType",
              "declaredSizeBytes",
              "expectedSha256",
              "idempotencyKey",
            ].includes(key),
        )
      )
        throw new Error("INVALID_INPUT");
      const declaredMediaType = requiredString(body, "declaredMediaType"),
        declaredSizeBytes = body.declaredSizeBytes;
      if (
        (declaredMediaType !== "application/pdf" &&
          declaredMediaType !== "image/png" &&
          declaredMediaType !== "image/jpeg") ||
        typeof declaredSizeBytes !== "number" ||
        !Number.isSafeInteger(declaredSizeBytes) ||
        declaredSizeBytes < 1
      )
        throw new Error("INVALID_INPUT");
      return success(
        await services.financeAttachments.reserveNextVersion(
          context,
          attachmentVersionPath[1]!,
          {
            originalFilename: requiredString(body, "originalFilename"),
            declaredMediaType,
            declaredSizeBytes,
            ...(body.expectedSha256 === undefined
              ? {}
              : { expectedSha256: requiredString(body, "expectedSha256") }),
          },
          requiredString(body, "idempotencyKey"),
          at,
        ),
      );
    }
    const documentAttachmentsPath = request.path.match(
      /^\/v1\/finance\/documents\/([^/]+)\/attachments$/,
    );
    if (documentAttachmentsPath !== null && request.method === "GET") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.financeAttachments?.listDocument)
        throw new Error("FINANCE_SERVICE_UNAVAILABLE");
      return success(
        await services.financeAttachments.listDocument(
          context,
          documentAttachmentsPath[1]!,
          at,
        ),
      );
    }
    const attachmentMetadataPath = request.path.match(
      /^\/v1\/finance\/attachment-uploads\/([^/]+)$/,
    );
    if (attachmentMetadataPath !== null && request.method === "GET") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim())
        throw new Error("UNAUTHENTICATED");
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.financeAttachments)
        throw new Error("FINANCE_ATTACHMENT_SERVICE_UNAVAILABLE");
      return success(
        await services.financeAttachments.getOwnVersion(
          context,
          attachmentMetadataPath[1]!,
          at,
        ),
      );
    }
    const copyPath = request.path.match(/^\/v1\/referrals\/([^/]+)\/copy$/);
    if (request.method === "POST" && copyPath !== null) {
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.referrals?.copy)
        throw new Error("REFERRAL_SERVICE_UNAVAILABLE");
      const allowedFields = [
        "sessionId",
        "receiverPersonId",
        "courseContextId",
        "classType",
        "idempotencyKey",
      ];
      if (Object.keys(body).some((key) => !allowedFields.includes(key)))
        throw new Error("INVALID_INPUT");
      const classType = body.classType;
      if (
        classType !== undefined &&
        classType !== "ONE_TO_ONE" &&
        classType !== "SMALL_GROUP"
      )
        throw new Error("INVALID_INPUT");
      return success(
        await services.referrals.copy(
          context,
          copyPath[1]!,
          {
            receiverPersonId: requiredString(body, "receiverPersonId"),
            ...(body.courseContextId === undefined
              ? {}
              : { courseContextId: requiredString(body, "courseContextId") }),
            ...(classType === undefined ? {} : { classType }),
          },
          requiredString(body, "idempotencyKey"),
          at,
        ),
      );
    }
    const lifecyclePath = request.path.match(
      /^\/v1\/referrals\/([^/]+)\/(archive|reactivate|complete)$/,
    );
    if (request.method === "POST" && lifecyclePath !== null) {
      const context = currentContext(
        await services.sessions.get(sessionIdFrom(body), at),
      );
      if (!services.referralLifecycle)
        throw new Error("REFERRAL_LIFECYCLE_UNAVAILABLE");
      const allowedFields = ["sessionId", "expectedVersion", "idempotencyKey"];
      if (Object.keys(body).some((key) => !allowedFields.includes(key)))
        throw new Error("INVALID_INPUT");
      const expectedVersion = body.expectedVersion;
      if (
        typeof expectedVersion !== "number" ||
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 1
      )
        throw new Error("INVALID_INPUT");
      const method = lifecyclePath[2] === "archive"
        ? "archive"
        : lifecyclePath[2] === "reactivate"
          ? "reactivate"
          : "complete";
      return success(
        await services.referralLifecycle[method](
          context,
          lifecyclePath[1]!,
          { expectedVersion },
          requiredString(body, "idempotencyKey"),
          at,
        ),
      );
    }
    const acceptPath = request.path.match(/^\/v1\/referrals\/([^/]+)\/accept$/);
    if (request.method === "POST" && acceptPath !== null) {
      const referralId = acceptPath[1];
      if (referralId === undefined || referralId.trim() === "")
        throw new Error("INVALID_INPUT:referralId");
      const session = await services.sessions.get(sessionIdFrom(body), at);
      if (!services.referralAcceptance)
        throw new Error("REFERRAL_ACCEPTANCE_UNAVAILABLE");
      for (const key of [
        "personId",
        "receiverPersonId",
        "venueOwnerPersonId",
        "isSelfUse",
        "acceptedBy",
      ]) {
        if (key in body) throw new Error("INVALID_INPUT");
      }
      const expectedVersion = body.expectedVersion;
      if (
        typeof expectedVersion !== "number" ||
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 1
      )
        throw new Error("INVALID_INPUT");
      return success(
        await services.referralAcceptance.accept(
          currentContext(session),
          referralId,
          {
            expectedVersion,
            ...(body.venueId === undefined
              ? {}
              : { venueId: requiredString(body, "venueId") }),
          },
          requiredString(body, "idempotencyKey"),
          at,
        ),
      );
    }
    const weeklyFeePath = request.path.match(
      /^\/v1\/referrals\/([^/]+)\/weekly-fees$/,
    );
    if (request.method === "POST" && weeklyFeePath !== null) {
      const referralCaseId = weeklyFeePath[1];
      if (referralCaseId === undefined || referralCaseId.trim() === "")
        throw new Error("INVALID_INPUT:referralCaseId");
      const session = await services.sessions.get(sessionIdFrom(body), at);
      const idempotencyKey = requiredString(body, "idempotencyKey");
      return success(
        await services.weeklyFees.recordWeeklyFee(
          currentContext(session),
          weeklyDraft({ ...body, referralCaseId }),
          idempotencyKey,
        ),
      );
    }
    throw new Error("NOT_FOUND");
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_FOUND") {
      return {
        status: 404,
        body: {
          version: API_CONTRACT_VERSION,
          error: { code: "NOT_FOUND", message: "NOT_FOUND" },
        },
      };
    }
    return failure(error);
  }
};
