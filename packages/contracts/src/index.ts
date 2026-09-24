export const SYSTEM_AUTHORITIES = ["SYSTEM_OWNER", "SYSTEM_ADMIN"] as const;
export type SystemAuthority = (typeof SYSTEM_AUTHORITIES)[number];

/**
 * A registered person's baseline account role.  It is deliberately separate
 * from TEACHING_TEACHER, which is a business identity with teaching and
 * settlement responsibilities.
 */
export const BASE_IDENTITIES = ["TEACHER"] as const;
export type BaseIdentity = (typeof BASE_IDENTITIES)[number];

export const BUSINESS_IDENTITIES = [
  "TEACHING_TEACHER",
  "ACADEMIC_PLANNER",
] as const;
export type BusinessIdentity = (typeof BUSINESS_IDENTITIES)[number];

export const DUTIES = [
  "HEADQUARTERS_FINANCE",
  "REGION_FINANCE",
  "CAMPUS_PRINCIPAL",
  "GROUP_LEADER",
  "TEACHING_MENTOR",
  "PLANNING_MENTOR",
  "VENUE_OWNER",
] as const;
export type Duty = (typeof DUTIES)[number];

export const ACTIONS = [
  "VIEW_OWN_PROFILE",
  "VIEW_OWN_BALANCE",
  "VIEW_OWN_CURRENT_YEAR_SETTLEMENT",
  "CREATE_REFERRAL",
  "ACCEPT_REFERRAL",
  "CREATE_WEEKLY_FEE",
  "READ_RECEIVED_REFERRALS",
  "READ_SENT_REFERRALS",
  "READ_MANAGED_REFERRALS",
  "MANAGE_OWN_REFERRALS",
  "COMPLETE_REFERRAL",
  "LIST_OPEN_TEACHING_WEEKS",
  "LIST_AVAILABLE_VENUES",
  "CREATE_PERSONAL_WITHDRAWAL",
  "CREATE_FINANCE_DOCUMENT",
  "READ_OWN_FINANCE_DRAFT",
  "UPLOAD_OWN_FINANCE_ATTACHMENT",
  "READ_OWN_FINANCE_ATTACHMENT",
  "UPLOAD_FINANCE_RECEIPT",
  "READ_MANAGED_FINANCE_ATTACHMENT",
  "READ_OWN_WITHDRAWAL",
  "READ_MANAGED_WITHDRAWAL",
  "PROCESS_WITHDRAWAL",
  "MANAGE_CASH_WAGES",
  "READ_MANAGED_CASH_WAGES",
  "READ_BONUS_PROJECT_CATALOG",
  "MANAGE_BONUS_PROJECT_CATALOG",
  "MANAGE_COMPANY_FUNDS",
  "SUBMIT_OWN_SELF_PURCHASE",
  "READ_OWN_SELF_PURCHASE",
  "READ_MANAGED_SELF_PURCHASE",
  "REVERSE_MANAGED_SELF_PURCHASE",
  "SUBMIT_OWN_REIMBURSEMENT",
  "READ_OWN_REIMBURSEMENT",
  "READ_MANAGED_REIMBURSEMENT",
  "REVIEW_REIMBURSEMENT",
  "EXECUTE_REIMBURSEMENT",
  "REVERSE_REIMBURSEMENT",
  "SUBMIT_OWN_REFUND",
  "READ_OWN_REFUND",
  "READ_MANAGED_REFUND",
  "REVIEW_REFUND",
  "VIEW_ORGANIZATION_REVENUE",
  "VIEW_REGION_PERSONAL_SUMMARY",
  "VIEW_CAMPUS_SCOPE_SETTLEMENT",
  "VIEW_GROUP_SCOPE_SETTLEMENT",
  "VIEW_MENTEE_SCOPE_SETTLEMENT",
  "MANAGE_OWN_PLANNING_RELATIONSHIPS",
  "CREATE_VENUE",
  "MANAGE_OWN_VENUE",
  "READ_OWN_VENUES",
  "VIEW_SHARED_VENUE_BOARD",
  "WITHDRAW_FROM_SHARED_VENUE",
  "CONFIGURE_RATES",
  "MANAGE_PERSON_RELATIONSHIPS",
  "VIEW_ALL_DATA",
  "EXPORT_FULL_BACKUP",
  "MANAGE_ACCOUNT_ACCESS",
] as const;
export type Action = (typeof ACTIONS)[number];

export type PermissionSubject = SystemAuthority | Duty | BusinessIdentity | BaseIdentity;
export type PermissionScope =
  | "SELF"
  | "REGION"
  | "CAMPUS"
  | "ASSOCIATED_TEACHERS"
  | "MENTEES"
  | "VENUE"
  | "GLOBAL";

export type PermissionRule = Readonly<{
  subject: PermissionSubject;
  action: Action;
  scope: PermissionScope;
}>;

const rule = (
  subject: PermissionSubject,
  action: Action,
  scope: PermissionScope,
): PermissionRule => ({
  subject,
  action,
  scope,
});

/**
 * DEV-001 的服务端权限基础表。它只描述“允许的最小能力”，数据范围仍需在请求中再次校验。
 * 场地所有者是业务主体，不会因为拥有场地而取得公司管理权限。
 */
export const PERMISSION_RULES: readonly PermissionRule[] = [
  rule("SYSTEM_OWNER", "VIEW_ALL_DATA", "GLOBAL"),
  rule("SYSTEM_OWNER", "CONFIGURE_RATES", "GLOBAL"),
  rule("SYSTEM_OWNER", "MANAGE_PERSON_RELATIONSHIPS", "GLOBAL"),
  rule("SYSTEM_OWNER", "READ_MANAGED_REFERRALS", "GLOBAL"),
  rule("SYSTEM_OWNER", "COMPLETE_REFERRAL", "GLOBAL"),
  rule("SYSTEM_OWNER", "EXPORT_FULL_BACKUP", "GLOBAL"),
  rule("SYSTEM_OWNER", "MANAGE_ACCOUNT_ACCESS", "GLOBAL"),
  rule("SYSTEM_ADMIN", "VIEW_ALL_DATA", "GLOBAL"),
  rule("SYSTEM_ADMIN", "CONFIGURE_RATES", "GLOBAL"),
  rule("SYSTEM_ADMIN", "MANAGE_PERSON_RELATIONSHIPS", "GLOBAL"),
  rule("SYSTEM_ADMIN", "READ_MANAGED_REFERRALS", "GLOBAL"),
  rule("SYSTEM_ADMIN", "COMPLETE_REFERRAL", "GLOBAL"),
  rule("SYSTEM_ADMIN", "EXPORT_FULL_BACKUP", "GLOBAL"),
  rule("SYSTEM_ADMIN", "MANAGE_ACCOUNT_ACCESS", "GLOBAL"),
  rule("TEACHER", "VIEW_OWN_PROFILE", "SELF"),
  rule("TEACHER", "VIEW_OWN_BALANCE", "SELF"),
  rule("TEACHER", "VIEW_OWN_CURRENT_YEAR_SETTLEMENT", "SELF"),
  rule("TEACHER", "CREATE_PERSONAL_WITHDRAWAL", "SELF"),
  rule("TEACHER", "CREATE_FINANCE_DOCUMENT", "SELF"),
  rule("TEACHER", "READ_OWN_FINANCE_DRAFT", "SELF"),
  rule("TEACHER", "UPLOAD_OWN_FINANCE_ATTACHMENT", "SELF"),
  rule("TEACHER", "READ_OWN_FINANCE_ATTACHMENT", "SELF"),
  rule("TEACHER", "READ_OWN_WITHDRAWAL", "SELF"),
  rule("TEACHER", "SUBMIT_OWN_SELF_PURCHASE", "SELF"),
  rule("TEACHER", "READ_OWN_SELF_PURCHASE", "SELF"),
  rule("TEACHER", "SUBMIT_OWN_REIMBURSEMENT", "SELF"),
  rule("TEACHER", "READ_OWN_REIMBURSEMENT", "SELF"),
  rule("TEACHER", "CREATE_VENUE", "SELF"),
  rule("TEACHER", "MANAGE_OWN_VENUE", "SELF"),
  rule("TEACHER", "READ_OWN_VENUES", "SELF"),
  rule("TEACHER", "VIEW_SHARED_VENUE_BOARD", "VENUE"),
  rule("TEACHER", "WITHDRAW_FROM_SHARED_VENUE", "VENUE"),
  rule("TEACHING_TEACHER", "VIEW_OWN_PROFILE", "SELF"),
  rule("TEACHING_TEACHER", "VIEW_OWN_BALANCE", "SELF"),
  rule("TEACHING_TEACHER", "VIEW_OWN_CURRENT_YEAR_SETTLEMENT", "SELF"),
  rule("TEACHING_TEACHER", "CREATE_REFERRAL", "SELF"),
  rule("TEACHING_TEACHER", "ACCEPT_REFERRAL", "SELF"),
  rule("TEACHING_TEACHER", "CREATE_WEEKLY_FEE", "SELF"),
  rule("TEACHING_TEACHER", "READ_RECEIVED_REFERRALS", "SELF"),
  rule("TEACHING_TEACHER", "READ_SENT_REFERRALS", "SELF"),
  rule("TEACHING_TEACHER", "COMPLETE_REFERRAL", "SELF"),
  rule("TEACHING_TEACHER", "MANAGE_OWN_REFERRALS", "SELF"),
  rule("TEACHING_TEACHER", "LIST_OPEN_TEACHING_WEEKS", "SELF"),
  rule("TEACHING_TEACHER", "LIST_AVAILABLE_VENUES", "GLOBAL"),
  rule("TEACHING_TEACHER", "CREATE_PERSONAL_WITHDRAWAL", "SELF"),
  rule("TEACHING_TEACHER", "CREATE_FINANCE_DOCUMENT", "SELF"),
  rule("TEACHING_TEACHER", "READ_OWN_FINANCE_DRAFT", "SELF"),
  rule("TEACHING_TEACHER", "UPLOAD_OWN_FINANCE_ATTACHMENT", "SELF"),
  rule("TEACHING_TEACHER", "READ_OWN_FINANCE_ATTACHMENT", "SELF"),
  rule("TEACHING_TEACHER", "CREATE_VENUE", "SELF"),
  rule("TEACHING_TEACHER", "MANAGE_OWN_VENUE", "SELF"),
  rule("TEACHING_TEACHER", "READ_OWN_VENUES", "SELF"),
  rule("TEACHING_TEACHER", "VIEW_SHARED_VENUE_BOARD", "VENUE"),
  rule("TEACHING_TEACHER", "WITHDRAW_FROM_SHARED_VENUE", "VENUE"),
  rule("ACADEMIC_PLANNER", "CREATE_REFERRAL", "SELF"),
  rule("ACADEMIC_PLANNER", "CREATE_VENUE", "SELF"),
  rule("ACADEMIC_PLANNER", "MANAGE_OWN_VENUE", "SELF"),
  rule("ACADEMIC_PLANNER", "READ_OWN_VENUES", "SELF"),
  rule("ACADEMIC_PLANNER", "VIEW_SHARED_VENUE_BOARD", "VENUE"),
  rule("ACADEMIC_PLANNER", "CREATE_FINANCE_DOCUMENT", "SELF"),
  rule("ACADEMIC_PLANNER", "READ_OWN_FINANCE_DRAFT", "SELF"),
  rule("ACADEMIC_PLANNER", "UPLOAD_OWN_FINANCE_ATTACHMENT", "SELF"),
  rule("ACADEMIC_PLANNER", "READ_OWN_FINANCE_ATTACHMENT", "SELF"),
  rule("ACADEMIC_PLANNER", "READ_SENT_REFERRALS", "SELF"),
  rule("ACADEMIC_PLANNER", "MANAGE_OWN_REFERRALS", "SELF"),
  rule("ACADEMIC_PLANNER", "VIEW_OWN_PROFILE", "SELF"),
  rule("ACADEMIC_PLANNER", "VIEW_OWN_BALANCE", "SELF"),
  rule("ACADEMIC_PLANNER", "VIEW_OWN_CURRENT_YEAR_SETTLEMENT", "SELF"),
  rule("PLANNING_MENTOR", "CREATE_REFERRAL", "SELF"),
  rule("PLANNING_MENTOR", "CREATE_FINANCE_DOCUMENT", "SELF"),
  rule("PLANNING_MENTOR", "READ_OWN_FINANCE_DRAFT", "SELF"),
  rule("PLANNING_MENTOR", "UPLOAD_OWN_FINANCE_ATTACHMENT", "SELF"),
  rule("PLANNING_MENTOR", "READ_OWN_FINANCE_ATTACHMENT", "SELF"),
  rule("PLANNING_MENTOR", "READ_SENT_REFERRALS", "SELF"),
  rule("PLANNING_MENTOR", "MANAGE_OWN_REFERRALS", "SELF"),
  rule("PLANNING_MENTOR", "MANAGE_OWN_PLANNING_RELATIONSHIPS", "SELF"),
  rule("PLANNING_MENTOR", "CREATE_VENUE", "SELF"),
  rule("PLANNING_MENTOR", "MANAGE_OWN_VENUE", "SELF"),
  rule("PLANNING_MENTOR", "READ_OWN_VENUES", "SELF"),
  rule("PLANNING_MENTOR", "VIEW_SHARED_VENUE_BOARD", "VENUE"),
  rule("PLANNING_MENTOR", "VIEW_MENTEE_SCOPE_SETTLEMENT", "MENTEES"),
  rule("TEACHING_TEACHER", "READ_OWN_WITHDRAWAL", "SELF"),
  rule("TEACHING_TEACHER", "SUBMIT_OWN_SELF_PURCHASE", "SELF"),
  rule("TEACHING_TEACHER", "READ_OWN_SELF_PURCHASE", "SELF"),
  rule("ACADEMIC_PLANNER", "SUBMIT_OWN_SELF_PURCHASE", "SELF"),
  rule("ACADEMIC_PLANNER", "READ_OWN_SELF_PURCHASE", "SELF"),
  rule("PLANNING_MENTOR", "SUBMIT_OWN_SELF_PURCHASE", "SELF"),
  rule("PLANNING_MENTOR", "READ_OWN_SELF_PURCHASE", "SELF"),
  rule("HEADQUARTERS_FINANCE", "READ_MANAGED_SELF_PURCHASE", "GLOBAL"),
  rule("SYSTEM_ADMIN", "READ_MANAGED_SELF_PURCHASE", "GLOBAL"),
  rule("SYSTEM_OWNER", "READ_MANAGED_SELF_PURCHASE", "GLOBAL"),
  rule("HEADQUARTERS_FINANCE", "REVERSE_MANAGED_SELF_PURCHASE", "GLOBAL"),
  rule("SYSTEM_ADMIN", "REVERSE_MANAGED_SELF_PURCHASE", "GLOBAL"),
  rule("SYSTEM_OWNER", "REVERSE_MANAGED_SELF_PURCHASE", "GLOBAL"),
  rule("TEACHING_TEACHER", "SUBMIT_OWN_REIMBURSEMENT", "SELF"),
  rule("ACADEMIC_PLANNER", "SUBMIT_OWN_REIMBURSEMENT", "SELF"),
  rule("PLANNING_MENTOR", "SUBMIT_OWN_REIMBURSEMENT", "SELF"),
  rule("TEACHING_TEACHER", "READ_OWN_REIMBURSEMENT", "SELF"),
  rule("ACADEMIC_PLANNER", "READ_OWN_REIMBURSEMENT", "SELF"),
  rule("PLANNING_MENTOR", "READ_OWN_REIMBURSEMENT", "SELF"),
  rule("HEADQUARTERS_FINANCE", "READ_MANAGED_REIMBURSEMENT", "GLOBAL"),
  rule("SYSTEM_ADMIN", "READ_MANAGED_REIMBURSEMENT", "GLOBAL"),
  rule("SYSTEM_OWNER", "READ_MANAGED_REIMBURSEMENT", "GLOBAL"),
  rule("HEADQUARTERS_FINANCE", "REVIEW_REIMBURSEMENT", "GLOBAL"),
  rule("HEADQUARTERS_FINANCE", "EXECUTE_REIMBURSEMENT", "GLOBAL"),
  rule("HEADQUARTERS_FINANCE", "REVERSE_REIMBURSEMENT", "GLOBAL"),
  rule("SYSTEM_ADMIN", "REVERSE_REIMBURSEMENT", "GLOBAL"),
  rule("SYSTEM_OWNER", "REVERSE_REIMBURSEMENT", "GLOBAL"),
  rule("TEACHING_TEACHER", "SUBMIT_OWN_REFUND", "SELF"),
  rule("TEACHING_TEACHER", "READ_OWN_REFUND", "SELF"),
  rule("HEADQUARTERS_FINANCE", "READ_MANAGED_REFUND", "GLOBAL"),
  rule("SYSTEM_ADMIN", "READ_MANAGED_REFUND", "GLOBAL"),
  rule("SYSTEM_OWNER", "READ_MANAGED_REFUND", "GLOBAL"),
  rule("HEADQUARTERS_FINANCE", "REVIEW_REFUND", "GLOBAL"),
  rule("ACADEMIC_PLANNER", "READ_OWN_WITHDRAWAL", "SELF"),
  rule("ACADEMIC_PLANNER", "CREATE_PERSONAL_WITHDRAWAL", "SELF"),
  rule("PLANNING_MENTOR", "READ_OWN_WITHDRAWAL", "SELF"),
  rule("PLANNING_MENTOR", "CREATE_PERSONAL_WITHDRAWAL", "SELF"),
  rule("HEADQUARTERS_FINANCE", "READ_MANAGED_FINANCE_ATTACHMENT", "GLOBAL"),
  rule("HEADQUARTERS_FINANCE", "READ_MANAGED_WITHDRAWAL", "GLOBAL"),
  rule("SYSTEM_ADMIN", "READ_MANAGED_FINANCE_ATTACHMENT", "GLOBAL"),
  rule("SYSTEM_ADMIN", "READ_MANAGED_WITHDRAWAL", "GLOBAL"),
  rule("SYSTEM_ADMIN", "MANAGE_COMPANY_FUNDS", "GLOBAL"),
  rule("SYSTEM_ADMIN", "MANAGE_CASH_WAGES", "GLOBAL"),
  rule("SYSTEM_ADMIN", "READ_MANAGED_CASH_WAGES", "GLOBAL"),
  rule("SYSTEM_ADMIN", "READ_BONUS_PROJECT_CATALOG", "GLOBAL"),
  rule("SYSTEM_ADMIN", "MANAGE_BONUS_PROJECT_CATALOG", "GLOBAL"),
  rule("SYSTEM_OWNER", "READ_MANAGED_FINANCE_ATTACHMENT", "GLOBAL"),
  rule("SYSTEM_OWNER", "READ_MANAGED_WITHDRAWAL", "GLOBAL"),
  rule("SYSTEM_OWNER", "MANAGE_COMPANY_FUNDS", "GLOBAL"),
  rule("SYSTEM_OWNER", "MANAGE_CASH_WAGES", "GLOBAL"),
  rule("SYSTEM_OWNER", "READ_MANAGED_CASH_WAGES", "GLOBAL"),
  rule("SYSTEM_OWNER", "READ_BONUS_PROJECT_CATALOG", "GLOBAL"),
  rule("SYSTEM_OWNER", "MANAGE_BONUS_PROJECT_CATALOG", "GLOBAL"),
  rule("HEADQUARTERS_FINANCE", "UPLOAD_FINANCE_RECEIPT", "GLOBAL"),
  rule("HEADQUARTERS_FINANCE", "PROCESS_WITHDRAWAL", "GLOBAL"),
  rule("HEADQUARTERS_FINANCE", "MANAGE_CASH_WAGES", "GLOBAL"),
  rule("HEADQUARTERS_FINANCE", "READ_MANAGED_CASH_WAGES", "GLOBAL"),
  rule("HEADQUARTERS_FINANCE", "READ_BONUS_PROJECT_CATALOG", "GLOBAL"),
  rule("HEADQUARTERS_FINANCE", "VIEW_ALL_DATA", "GLOBAL"),
  rule("SYSTEM_OWNER", "VIEW_ORGANIZATION_REVENUE", "GLOBAL"),
  rule("SYSTEM_ADMIN", "VIEW_ORGANIZATION_REVENUE", "GLOBAL"),
  rule("HEADQUARTERS_FINANCE", "VIEW_ORGANIZATION_REVENUE", "GLOBAL"),
  rule("REGION_FINANCE", "VIEW_ORGANIZATION_REVENUE", "REGION"),
  rule("CAMPUS_PRINCIPAL", "VIEW_ORGANIZATION_REVENUE", "CAMPUS"),
  rule("REGION_FINANCE", "VIEW_REGION_PERSONAL_SUMMARY", "REGION"),
  rule("CAMPUS_PRINCIPAL", "VIEW_CAMPUS_SCOPE_SETTLEMENT", "CAMPUS"),
  rule("GROUP_LEADER", "VIEW_GROUP_SCOPE_SETTLEMENT", "ASSOCIATED_TEACHERS"),
  rule("TEACHING_MENTOR", "VIEW_MENTEE_SCOPE_SETTLEMENT", "MENTEES"),
  rule("VENUE_OWNER", "VIEW_SHARED_VENUE_BOARD", "VENUE"),
  rule("VENUE_OWNER", "WITHDRAW_FROM_SHARED_VENUE", "VENUE"),
];

export const hasPermission = (
  subject: PermissionSubject,
  action: Action,
): boolean =>
  PERMISSION_RULES.some(
    (item) => item.subject === subject && item.action === action,
  );

export const permissionScope = (
  subject: PermissionSubject,
  action: Action,
): PermissionScope | undefined =>
  PERMISSION_RULES.find(
    (item) => item.subject === subject && item.action === action,
  )?.scope;

export type RoleContext = Readonly<{
  subject: PermissionSubject;
  personId: string;
  /** Issued from the active assignment. Global financial access requires an explicit GLOBAL value. */
  scope?: PermissionScope;
  regionId?: string;
  campusId?: string;
  venueId?: string;
}>;

export const assertKnownAction = (value: string): Action => {
  if ((ACTIONS as readonly string[]).includes(value)) return value as Action;
  throw new Error(`UNKNOWN_ACTION:${value}`);
};

export const API_CONTRACT_VERSION = "2026-09-20.dev-001" as const;

/** Finance-only F09/F10 evidence documents. They are intentionally distinct from member-submitted finance drafts. */
export const SALARY_BENEFIT_DOCUMENT_KINDS = [
  "CASH_WAGE",
  "PROJECT_BONUS",
  "FINANCE_BENEFIT",
] as const;
export type SalaryBenefitDocumentKind =
  (typeof SALARY_BENEFIT_DOCUMENT_KINDS)[number];

export const API_ERROR_CODES = [
  "ORGANIZATION_REVENUE_DATA_UNAVAILABLE",
  "ORGANIZATION_REVENUE_SERVICE_UNAVAILABLE",
  "UNAUTHENTICATED",
  "LOGIN_RATE_LIMITED",
  "ACCOUNT_ACCESS_SERVICE_UNAVAILABLE",
  "REGISTRATION_PHONE_CONFLICT",
  "REGISTRATION_NICKNAME_CONFLICT",
  "PROFILE_NICKNAME_CONFLICT",
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
  "REFERRAL_RECEIVER_IDENTITY_INVALID",
  "ACCOUNT_NOT_FOUND",
  "PERSON_NOT_FOUND",
  "PERSON_INACTIVE",
  "ROLE_ASSIGNMENT_NOT_FOUND",
  "ROLE_SCOPE_NOT_FOUND",
  "ROLE_ASSIGNMENT_OVERLAP",
  "INVALID_ROLE_SCOPE",
  "INVALID_ROLE_REVOCATION",
  "ONLY_SYSTEM_OWNER_CAN_MANAGE_ADMIN",
  "CANNOT_DEACTIVATE_SELF",
  "CANNOT_DEACTIVATE_LAST_OWNER",
  "REFERRAL_NOT_FOUND",
  "REFERRAL_ARCHIVED",
  "REFERRER_NOT_ACTIVE",
  "RECEIVER_NOT_ACTIVE",
  "REFERRER_CAMPUS_REQUIRED",
  "REFERRAL_ACCEPTANCE_INVALID",
  "REFERRAL_ALREADY_ACCEPTED",
  "REFERRAL_STATE_CONFLICT",
  "REFERRAL_COPY_TARGET_UNCHANGED",
  "FINANCE_DOCUMENT_NOT_FOUND",
  "FINANCE_ATTACHMENT_NOT_FOUND",
  "FINANCE_ATTACHMENT_LIMIT_EXCEEDED",
  "FINANCE_ATTACHMENT_NOT_READY",
  "FINANCE_ATTACHMENT_FAILED",
  "FINANCE_ATTACHMENT_UPLOAD_FAILED",
  "FINANCE_SERVICE_UNAVAILABLE",
  "FINANCE_RECIPIENT_UNAVAILABLE",
  "FINANCE_WITHDRAWAL_DATA_UNAVAILABLE",
  "INSUFFICIENT_BALANCE",
  "FINANCE_WITHDRAWAL_STATE_CONFLICT",
  "SOURCE_ACCOUNT_NOT_FOUND",
  "SOURCE_ACCOUNT_NOT_ACTIVE",
  "SOURCE_ACCOUNT_NOT_WITHDRAWABLE",
  "SOURCE_ACCOUNT_FORBIDDEN",
  "COMPANY_FUND_NOT_FOUND",
  "COMPANY_FUND_CONFLICT",
  "COMPANY_FUND_ASSIGNMENT_CONFLICT",
  "COMPANY_FUND_INACTIVE",
  "SELF_PURCHASE_STATE_CONFLICT",
  "HEADQUARTERS_FINANCE_ASSIGNMENT_REQUIRED",
  "HEADQUARTERS_FINANCE_ASSIGNMENT_AMBIGUOUS",
  "COMPANY_FUND_ASSIGNMENT_NOT_FOUND",
  "FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE",
  "REIMBURSEMENT_STATE_CONFLICT",
  "REIMBURSEMENT_CROSS_FINANCE_YEAR_PENDING",
  "FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE",
  "FINANCE_REFUND_DATA_UNAVAILABLE",
  "REFUND_STATE_CONFLICT",
  "SALARY_BENEFIT_DATA_UNAVAILABLE",
  "SALARY_BENEFIT_STATE_CONFLICT",
  "CASH_WAGE_TODO_NOT_FOUND",
  "CASH_WAGE_PLAN_NOT_FOUND",
  "CASH_WAGE_AMOUNT_MISMATCH",
  "CASH_WAGE_PLAN_EXCEEDED",
  "CASH_WAGE_PLAN_INACTIVE",
  "CASH_WAGE_CORRECTION_REQUIRED",
  "CASH_WAGE_CORRECTION_INVALID",
  "BONUS_PROJECT_CATALOG_DATA_UNAVAILABLE",
  "BONUS_PROJECT_VERSION_REQUIRED",
  "BONUS_PROJECT_VERSION_CONFLICT",
  "FINANCE_BENEFIT_TODO_NOT_FOUND",
  "FINANCE_BENEFIT_PLAN_NOT_FOUND",
  "FINANCE_BENEFIT_ALREADY_EXECUTED",
  "FINANCE_BENEFIT_PLAN_INACTIVE",
  "WEEKLY_FEE_REFUNDED",
  "ATTACHMENT_PUBLICATION_REQUIRES_RECONCILIATION",
  "ATTACHMENT_STORAGE_UNAVAILABLE",
  "ATTACHMENT_VALIDATOR_BUSY",
  "ATTACHMENT_VALIDATION_TIMEOUT",
  "ATTACHMENT_INTEGRITY_FAILED",
  "ATTACHMENT_UNAVAILABLE",
  "VENUE_NOT_FOUND",
  "DEFAULT_VENUE_NOT_FOUND",
  "VENUE_CHANGE_REQUIRED",
  "VENUE_ACCOUNT_REQUIRED",
  "VENUE_DATA_UNAVAILABLE",
  "TEACHING_WEEK_NOT_FOUND",
  "WEEKLY_FEE_NOT_FOUND",
  "RATE_PREVIEW_NOT_FOUND",
  "RELATIONSHIP_SERVICE_UNAVAILABLE",
  "RELATIONSHIP_PREVIEW_NOT_FOUND",
  "RELATIONSHIP_EFFECTIVE_WEEK_NOT_FOUND",
  "RELATIONSHIP_PREVIEW_STALE",
  "RELATIONSHIP_PREVIEW_ALREADY_PUBLISHED",
  "RELATIONSHIP_EFFECTIVE_WEEK_NOT_CURRENT",
  "RELATIONSHIP_SPECIAL_PERIOD_SCOPE_REQUIRED",
  "GROUP_LEADER_CANDIDATE_NOT_ELIGIBLE",
  "GROUP_LEADER_CANDIDATE_AMBIGUOUS",
  "GROUP_LEADER_RELATIONSHIP_MISSING",
  "GROUP_LEADER_RELATIONSHIP_AMBIGUOUS",
  "TEACHING_MENTOR_CANDIDATE_NOT_ELIGIBLE",
  "TEACHING_MENTOR_CANDIDATE_AMBIGUOUS",
  "TEACHING_MENTOR_RELATIONSHIP_MISSING",
  "TEACHING_MENTOR_RELATIONSHIP_AMBIGUOUS",
  "PLANNING_MENTOR_CANDIDATE_NOT_ELIGIBLE",
  "PLANNING_MENTOR_CANDIDATE_AMBIGUOUS",
  "PLANNING_MENTOR_RELATIONSHIP_MISSING",
  "PLANNING_MENTOR_RELATIONSHIP_AMBIGUOUS",
  "PLANNING_MENTOR_RELATIONSHIP_CONFLICT",
  "PLANNING_MENTOR_RELATIONSHIP_NOT_OWNED",
  "RELATIONSHIP_TARGET_UNCHANGED",
  "RELATIONSHIP_TEACHER_NOT_ELIGIBLE",
  "PERSONAL_ACCOUNT_NOT_FOUND",
  "PERSON_CAMPUS_PREVIEW_NOT_FOUND",
  "PERSON_CAMPUS_PREVIEW_STALE",
  "PERSON_CAMPUS_ASSIGNMENT_NO_CHANGE",
  "PERSON_CAMPUS_ASSIGNMENT_SOURCE_INVALID",
  "PERSON_CAMPUS_TARGET_NOT_FOUND",
  "PERSON_CAMPUS_TARGET_REGION_NOT_UNIQUE",
  "PERSON_CAMPUS_TARGET_PRINCIPAL_INVALID",
  "PERSON_CAMPUS_PRINCIPAL_RELATIONSHIP_AMBIGUOUS",
  "PERSON_CAMPUS_PERSON_NOT_ELIGIBLE",
  "PERSON_CAMPUS_EFFECTIVE_RANGE_INVALID",
  "PERSON_CAMPUS_SETTLEMENT_DATA_UNAVAILABLE",
  "CAMPUS_REGION_PREVIEW_NOT_FOUND",
  "CAMPUS_REGION_PREVIEW_STALE",
  "CAMPUS_REGION_ASSIGNMENT_NO_CHANGE",
  "CAMPUS_REGION_ASSIGNMENT_SOURCE_INVALID",
  "CAMPUS_REGION_CAMPUS_NOT_FOUND",
  "CAMPUS_REGION_TARGET_NOT_FOUND",
  "CAMPUS_REGION_EFFECTIVE_RANGE_INVALID",
  "CAMPUS_REGION_SETTLEMENT_DATA_UNAVAILABLE",
  "INTERNAL_ERROR",
  "FORBIDDEN_SCOPE",
  "ROLE_CONTEXT_REQUIRED",
  "ROLE_CONTEXT_NOT_ASSIGNED",
  "ROLE_CONTEXT_AMBIGUOUS",
  "INVALID_INPUT",
  "VERSION_CONFLICT",
  "PERIOD_LOCKED",
  "INVALID_RELATIONSHIP_SCOPE",
  "INVALID_ALLOCATION_CONFIG",
  "INSUFFICIENT_BALANCE",
  "IDEMPOTENCY_REPLAY",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export type HttpMethod = "GET" | "POST" | "PATCH";

export type EndpointContract = Readonly<{
  method: HttpMethod;
  path: string;
  action: Action;
  alternativeActions?: readonly Action[];
  responseVersion: string;
  requiresRoleContext: boolean;
}>;

export type PersonProfileChangeResult = Readonly<{
  personId: string;
  nickname: string;
  legalName: string;
  profileVersion: string;
  changedAt: string;
  replay: boolean;
}>;

export type PersonBusinessIdentity = "TEACHING_TEACHER" | "ACADEMIC_PLANNER";
export type BusinessIdentityBlockerCode = "PERSON_INACTIVE" | "ACCOUNT_INACTIVE" | "PROFILE_EMPLOYMENT_INACTIVE" | "SETTLEMENT_ACCOUNT_MISSING" | "CAMPUS_ASSIGNMENT_REQUIRED" | "CAMPUS_REGION_MISMATCH" | "PENDING_RECEIVED_REFERRALS" | "ACTIVE_GROUP_LEADER_RELATIONSHIP" | "ACTIVE_TEACHING_MENTOR_RELATIONSHIP" | "ACTIVE_PLANNING_MENTOR_RELATIONSHIP";
export type BusinessIdentityBlocker = Readonly<{ code: BusinessIdentityBlockerCode; count: number }>;
export type PersonBusinessIdentityChangeResult = Readonly<{
  personId: string; businessIdentity: PersonBusinessIdentity; businessIdentityVersion: string;
  gradeSubject: string | null; beforeRoleAssignmentId: string | null; resultRoleAssignmentId: string;
  authVersion: string; changedAt: string; replay: boolean;
}>;

export type PersonRelationshipAuditType = "CAMPUS_PRINCIPAL" | "GROUP_LEADER" | "TEACHING_MENTOR" | "PLANNING_MENTOR";
export type PersonRelationshipAuditStatus = "CURRENT" | "FUTURE" | "ENDED" | "SUPERSEDED" | "ANOMALOUS";
export type PersonRelationshipAuditAnomalyCode =
  | "RELATIONSHIP_INTERVAL_INVALID" | "RELATIONSHIP_OVERLAP"
  | "MEMBER_PERSON_INACTIVE" | "RELATED_PERSON_INACTIVE"
  | "RELATED_ROLE_INVALID" | "RELATED_ROLE_SCOPE_MISMATCH"
  | "SUBJECT_IDENTITY_INVALID" | "RECIPIENT_ACCOUNT_INVALID"
  | "NONZERO_RECIPIENT_MISSING" | "CAMPUS_PRINCIPAL_MISSING"
  | "CAMPUS_PRINCIPAL_MISMATCH" | "SPECIAL_PERIOD_SCOPE_REQUIRED"
  | "HISTORICAL_REFERENCE_MISSING" | "SUPERSESSION_SOURCE_INVALID";
export type PersonRelationshipAuditRepairability =
  | "GROUP_LEADER_REGULAR_WEEK_PREVIEW" | "TEACHING_MENTOR_REGULAR_WEEK_PREVIEW" | "PLANNING_MENTOR_REGULAR_WEEK_PREVIEW" | "READ_ONLY"
  | "REQUIRES_RELATIONSHIP_CORRECTION" | "REQUIRES_P27" | "REQUIRES_SPECIAL_PERIOD_SCOPE";
export type PersonRelationshipAuditPersonDto = Readonly<{
  personId: string; nickname: string; personStatus: "ACTIVE" | "INACTIVE";
}>;
export type PersonRelationshipAuditItemDto = Readonly<{
  auditItemId: string;
  relationshipId: string | null;
  relationshipFingerprint: string;
  relationshipType: PersonRelationshipAuditType;
  member: PersonRelationshipAuditPersonDto;
  relatedPerson: PersonRelationshipAuditPersonDto | null;
  validFrom: string; validTo: string | null; effectiveScope: string | null;
  status: PersonRelationshipAuditStatus;
  matchingRoleAssignmentIds: readonly string[];
  sourceChange: Readonly<{ kind: "GROUP_LEADER_CHANGE" | "TEACHING_MENTOR_CHANGE" | "PLANNING_MENTOR_CHANGE" | "ADMIN_PLANNING_MENTOR_CHANGE" | "PERSON_CAMPUS_ASSIGNMENT_CHANGE"; changeId: string }> | null;
  referenceCounts: Readonly<{ weeklyFees: number; allocationSnapshots: number; referrals: number }>;
  anomalyCodes: readonly PersonRelationshipAuditAnomalyCode[];
  repairability: PersonRelationshipAuditRepairability;
  repairBlockedReason: string | null;
  createdBy: Readonly<{ personId: string; nickname: string }> | null;
  createdAt: string | null;
}>;
export type PersonRelationshipAuditPageDto = Readonly<{
  snapshotAt: string;
  dataVersion: string;
  items: readonly PersonRelationshipAuditItemDto[];
  nextCursor: string | null;
}>;

export type TeachingMentorRelationshipTeacherDto = Readonly<{
  personId: string;
  nickname: string;
  currentMentorPersonId: string | null;
  currentMentorNickname: string | null;
  currentRelationshipId: string | null;
}>;
export type TeachingMentorRelationshipMentorDto = Readonly<{ personId: string; nickname: string; eligibleTeacherPersonIds: readonly string[] | null }>;
export type TeachingMentorRelationshipCurrentWeekDto = Readonly<{ id: string; startsOn: string; endsOn: string; settlementMonth: string }>;
export type TeachingMentorRelationshipCandidatesDto = Readonly<{
  teachers: readonly TeachingMentorRelationshipTeacherDto[];
  mentors: readonly TeachingMentorRelationshipMentorDto[];
  currentWeeks: readonly TeachingMentorRelationshipCurrentWeekDto[];
}>;
export type TeachingMentorRelationshipPreviewDto = Readonly<{
  previewId: string;
  action: "ADD" | "REPLACE";
  teacherPersonId: string;
  sourceRelatedPersonId: string | null;
  sourceRelatedNickname: string | null;
  newRelatedPersonId: string;
  newRelatedNickname: string;
  effectiveTeachingWeekId: string;
  effectiveThroughTeachingWeekId: string | null;
  effectiveAt: string;
  nextBoundaryAt: string | null;
  consideredFeeCount: number;
  movedFeeCount: number;
  zeroShareFeeCount: number;
  excludedRefundCount: number;
  movedAmountCents: string;
}>;
export type TeachingMentorRelationshipPublishDto = Readonly<{
  changeId: string;
  previewId: string;
  relationshipVersion: number;
  resultRelationshipId: string;
  postingStatus: "POSTED" | "NO_BALANCE_CHANGE";
  consideredFeeCount: number;
  movedFeeCount: number;
  excludedRefundCount: number;
  movedAmountCents: string;
  replay: boolean;
}>;

export type AdminPlanningMentorRelationshipAction = "ADD" | "REPLACE" | "REMOVE";
export type AdminPlanningMentorRelationshipPlannerDto = Readonly<{
  personId: string;
  nickname: string;
  currentMentorPersonId: string | null;
  currentMentorNickname: string | null;
  currentRelationshipId: string | null;
}>;
export type AdminPlanningMentorRelationshipMentorDto = Readonly<{ personId: string; nickname: string }>;
export type AdminPlanningMentorRelationshipDirectoryDto = Readonly<{
  planners: readonly AdminPlanningMentorRelationshipPlannerDto[];
  mentors: readonly AdminPlanningMentorRelationshipMentorDto[];
  currentWeeks: readonly TeachingMentorRelationshipCurrentWeekDto[];
}>;
export type AdminPlanningMentorRelationshipPreviewDto = Readonly<{
  previewId: string;
  action: AdminPlanningMentorRelationshipAction;
  plannerPersonId: string;
  plannerNickname: string;
  sourceMentorPersonId: string | null;
  sourceMentorNickname: string | null;
  newMentorPersonId: string | null;
  newMentorNickname: string | null;
  effectiveTeachingWeekId: string;
  effectiveThroughTeachingWeekId: string | null;
  effectiveAt: string;
  nextBoundaryAt: string | null;
  consideredFeeCount: number;
  changedFeeCount: number;
  zeroShareFeeCount: number;
  excludedRefundCount: number;
  plannerDeltaCents: string;
  sourceMentorDeltaCents: string;
  destinationMentorDeltaCents: string;
}>;
export type AdminPlanningMentorRelationshipPublishDto = Readonly<{
  changeId: string;
  previewId: string;
  action: AdminPlanningMentorRelationshipAction;
  relationshipVersion: number;
  resultRelationshipId: string | null;
  postingStatus: "POSTED" | "NO_BALANCE_CHANGE";
  consideredFeeCount: number;
  changedFeeCount: number;
  excludedRefundCount: number;
  plannerDeltaCents: string;
  sourceMentorDeltaCents: string;
  destinationMentorDeltaCents: string;
  replay: boolean;
}>;

export type PersonCampusAssignmentCandidateDirectoryDto = Readonly<{
  people: readonly Readonly<{ personId: string; nickname: string; currentCampusId: string | null; currentCampusName: string | null; currentRegionId: string | null; currentRegionName: string | null }>[];
  campuses: readonly Readonly<{ campusId: string; campusName: string }>[];
  regions: readonly Readonly<{ regionId: string; regionName: string }>[];
}>;
export type PersonCampusAssignmentPreviewDto = Readonly<{
  previewId: string; personId: string; targetCampusId: string; targetRegionId: string; targetPrincipalPersonId: string; targetPrincipalNickname: string;
  sourceCampusId: string; sourceRegionId: string; sourcePrincipalPersonId: string | null; effectiveFrom: string; effectiveTo: string | null;
  consideredFeeCount: number; changedFeeCount: number; excludedRefundCount: number;
  organizationImpact: Readonly<{ sourceCampusId: string; sourceRegionId: string; targetCampusId: string; targetRegionId: string; recordedGrossRevenueCents: string; refundedGrossRevenueCents: string; effectiveGrossRevenueCents: string; campusManagementFeeCents: string }>;
  accountDeltas: readonly Readonly<{ accountCode: string; categoryKey: string; amountCents: string }>[];
}>;
export type PersonCampusAssignmentChangeDto = Readonly<{
  changeId: string; previewId: string; assignmentVersion: number; resultAssignmentId: string | null; resultCampusPrincipalRelationshipId: string;
  postingStatus: "POSTED" | "NO_BALANCE_CHANGE"; consideredFeeCount: number; changedFeeCount: number; excludedRefundCount: number; replay: boolean;
}>;

export type CampusRegionAssignmentCandidateDirectoryDto = Readonly<{
  campuses: readonly Readonly<{ campusId: string; campusName: string; currentRegionId: string | null; currentRegionName: string | null }>[];
  regions: readonly Readonly<{ regionId: string; regionName: string }>[];
}>;
export type CampusRegionAssignmentPreviewDto = Readonly<{
  previewId: string; campusId: string; sourceRegionId: string; targetRegionId: string; effectiveFrom: string; effectiveTo: string | null;
  affectedPersonCount: number; affectedAssignmentCount: number; consideredFeeCount: number; changedFeeCount: number; excludedRefundCount: number;
  organizationImpact: Readonly<{ sourceRegionId: string; targetRegionId: string; recordedGrossRevenueCents: string; refundedGrossRevenueCents: string; effectiveGrossRevenueCents: string; campusManagementFeeCents: string }>;
  accountDeltas: readonly Readonly<{ accountCode: string; categoryKey: string; amountCents: string }>[];
}>;
export type CampusRegionAssignmentChangeDto = Readonly<{
  changeId: string; previewId: string; campusVersion: number; resultCampusRegionAssignmentId: string;
  affectedPersonCount: number; affectedAssignmentCount: number; postingStatus: "POSTED" | "NO_BALANCE_CHANGE";
  consideredFeeCount: number; changedFeeCount: number; excludedRefundCount: number; replay: boolean;
}>;

export type GroupLeaderRelationshipPersonDto = Readonly<{
  personId: string;
  nickname: string;
}>;

export type GroupLeaderRelationshipCurrentWeekDto = Readonly<{
  id: string;
  startsOn: string;
  endsOn: string;
  settlementMonth: string;
}>;

export type GroupLeaderRelationshipCandidatesDto = Readonly<{
  groupLeaders: readonly GroupLeaderRelationshipPersonDto[];
  teachers: readonly GroupLeaderRelationshipPersonDto[];
  currentWeeks: readonly GroupLeaderRelationshipCurrentWeekDto[];
}>;

export type GroupLeaderRelationshipPreviewDto = Readonly<{
  previewId: string;
  teacherPersonId: string;
  sourceRelatedPersonId: string;
  sourceRelatedNickname: string;
  newRelatedPersonId: string;
  effectiveTeachingWeekId: string;
  effectiveAt: string;
  nextBoundaryAt: string | null;
  consideredFeeCount: number;
  movedFeeCount: number;
  zeroShareFeeCount: number;
  excludedRefundCount: number;
  movedAmountCents: string;
}>;

export type GroupLeaderRelationshipPublishDto = Readonly<{
  changeId: string;
  previewId: string;
  relationshipVersion: number;
  resultRelationshipId: string;
  postingStatus: "POSTED" | "NO_BALANCE_CHANGE";
  consideredFeeCount: number;
  movedFeeCount: number;
  excludedRefundCount: number;
  movedAmountCents: string;
  replay: boolean;
}>;

export type PlanningMentorRelationshipPersonDto = Readonly<{
  personId: string;
  nickname: string;
}>;

export type PlanningMentorManagedPlannerDto = Readonly<{
  personId: string;
  nickname: string;
  relationshipId: string;
  validFrom: string;
  validTo: string | null;
}>;

export type PlanningMentorRelationshipCurrentWeekDto = Readonly<{
  id: string;
  startsOn: string;
  endsOn: string;
  settlementMonth: string;
}>;

export type PlanningMentorRelationshipDirectoryDto = Readonly<{
  mentorPersonId: string;
  mentorNickname: string;
  managedPlanners: readonly PlanningMentorManagedPlannerDto[];
  availablePlanners: readonly PlanningMentorRelationshipPersonDto[];
  currentWeeks: readonly PlanningMentorRelationshipCurrentWeekDto[];
}>;

export type PlanningMentorRelationshipPreviewDto = Readonly<{
  previewId: string;
  action: "ADD" | "REMOVE";
  mentorPersonId: string;
  plannerPersonId: string;
  plannerNickname: string;
  effectiveTeachingWeekId: string;
  effectiveAt: string;
  nextBoundaryAt: string | null;
  consideredFeeCount: number;
  changedFeeCount: number;
  zeroShareFeeCount: number;
  excludedRefundCount: number;
  plannerDeltaCents: string;
  mentorDeltaCents: string;
}>;

export type PlanningMentorRelationshipPublishDto = Readonly<{
  changeId: string;
  previewId: string;
  action: "ADD" | "REMOVE";
  relationshipVersion: number;
  resultRelationshipId: string | null;
  postingStatus: "POSTED" | "NO_BALANCE_CHANGE";
  consideredFeeCount: number;
  changedFeeCount: number;
  excludedRefundCount: number;
  plannerDeltaCents: string;
  mentorDeltaCents: string;
  replay: boolean;
}>;

export const ENDPOINT_CONTRACTS: readonly EndpointContract[] = [
  {
    method: "POST",
    path: "/v1/accounts/register",
    action: "VIEW_OWN_PROFILE",
    responseVersion: "account-registration.v1",
    requiresRoleContext: false,
  },
  {
    method: "GET",
    path: "/v1/admin/accounts",
    action: "MANAGE_ACCOUNT_ACCESS",
    responseVersion: "account-directory.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/admin/accounts/:accountId/password-reset",
    action: "MANAGE_ACCOUNT_ACCESS",
    responseVersion: "account-password-reset.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/admin/people",
    action: "MANAGE_ACCOUNT_ACCESS",
    responseVersion: "person-responsibility-directory.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/admin/people/:personId/role-assignments",
    action: "MANAGE_ACCOUNT_ACCESS",
    responseVersion: "person-role-assignment.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/admin/role-assignments/:assignmentId/revoke",
    action: "MANAGE_ACCOUNT_ACCESS",
    responseVersion: "person-role-revocation.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/admin/people/:personId/status",
    action: "MANAGE_ACCOUNT_ACCESS",
    responseVersion: "person-status-change.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/admin/people/:personId/profile",
    action: "MANAGE_ACCOUNT_ACCESS",
    responseVersion: "person-profile-change.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/admin/people/:personId/business-identity",
    action: "MANAGE_ACCOUNT_ACCESS",
    responseVersion: "person-business-identity-change.v1",
    requiresRoleContext: true,
  },
  { method: "GET", path: "/v1/organizations/revenue", action: "VIEW_ORGANIZATION_REVENUE", responseVersion: "organization-revenue.v1", requiresRoleContext: true },
  {
    method: "GET",
    path: "/v1/admin/person-relationships/group-leader-candidates",
    action: "MANAGE_PERSON_RELATIONSHIPS",
    responseVersion: "group-leader-relationship-candidates.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/admin/person-relationships/teaching-mentor-candidates",
    action: "MANAGE_PERSON_RELATIONSHIPS",
    responseVersion: "teaching-mentor-relationship-candidates.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/admin/person-relationships/planning-mentor-candidates",
    action: "MANAGE_PERSON_RELATIONSHIPS",
    responseVersion: "admin-planning-mentor-relationship-candidates.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/admin/person-relationships/audit",
    action: "MANAGE_PERSON_RELATIONSHIPS",
    responseVersion: "person-relationship-audit.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/admin/organization/person-campus-candidates",
    action: "MANAGE_PERSON_RELATIONSHIPS",
    responseVersion: "person-campus-assignment-candidates.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/admin/organization/campus-region-candidates",
    action: "MANAGE_PERSON_RELATIONSHIPS",
    responseVersion: "campus-region-assignment-candidates.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/planning-mentor/relationships",
    action: "MANAGE_OWN_PLANNING_RELATIONSHIPS",
    responseVersion: "planning-mentor-relationship-directory.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/planning-mentor/relationships/preview",
    action: "MANAGE_OWN_PLANNING_RELATIONSHIPS",
    responseVersion: "planning-mentor-relationship-preview.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/planning-mentor/relationships",
    action: "MANAGE_OWN_PLANNING_RELATIONSHIPS",
    responseVersion: "planning-mentor-relationship-change.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/finance/salary-benefits/documents",
    action: "MANAGE_CASH_WAGES",
    responseVersion: "salary-benefit-document.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/finance/cash-wage-plans",
    action: "MANAGE_CASH_WAGES",
    responseVersion: "cash-wage-plan.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/finance/cash-wage-todos/generate",
    action: "MANAGE_CASH_WAGES",
    responseVersion: "cash-wage-todos.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/finance/cash-wages/confirm",
    action: "MANAGE_CASH_WAGES",
    responseVersion: "cash-wage-confirmation.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/finance/cash-wage-teachers",
    action: "MANAGE_CASH_WAGES",
    responseVersion: "cash-wage-teachers.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/finance/benefit-roster",
    action: "READ_MANAGED_CASH_WAGES",
    responseVersion: "benefit-roster.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/finance/benefits/:documentId",
    action: "READ_MANAGED_CASH_WAGES",
    responseVersion: "benefit-detail.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/finance/cash-wage-roster",
    action: "READ_MANAGED_CASH_WAGES",
    responseVersion: "cash-wage-roster.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/finance/cash-wage-confirmations",
    action: "READ_MANAGED_CASH_WAGES",
    responseVersion: "cash-wage-confirmations.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/finance/cash-wages/:documentId",
    action: "READ_MANAGED_CASH_WAGES",
    responseVersion: "cash-wage-detail.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/finance/project-bonuses/grant",
    action: "MANAGE_CASH_WAGES",
    responseVersion: "project-bonus.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/finance/bonus-projects",
    action: "READ_BONUS_PROJECT_CATALOG",
    responseVersion: "bonus-projects.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/finance/benefit-source-funds",
    action: "READ_MANAGED_CASH_WAGES",
    responseVersion: "benefit-source-funds.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/admin/bonus-projects/:projectNo/name",
    action: "MANAGE_BONUS_PROJECT_CATALOG",
    responseVersion: "bonus-project.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/finance/benefit-plans",
    action: "MANAGE_CASH_WAGES",
    responseVersion: "benefit-plan.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/finance/benefit-todos/generate",
    action: "MANAGE_CASH_WAGES",
    responseVersion: "benefit-todos.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/finance/benefits/confirm",
    action: "MANAGE_CASH_WAGES",
    responseVersion: "benefit-confirmation.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/finance/salary-benefits/reverse",
    action: "MANAGE_CASH_WAGES",
    responseVersion: "salary-benefit-reversal.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/finance/drafts/:documentId/reimbursement-submit",
    action: "SUBMIT_OWN_REIMBURSEMENT",
    responseVersion: "reimbursement.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/finance/drafts/:documentId/refund-submit",
    action: "SUBMIT_OWN_REFUND",
    responseVersion: "refund.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/finance/reimbursements/:documentId/approve",
    action: "REVIEW_REIMBURSEMENT",
    responseVersion: "reimbursement.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/finance/reimbursements/:documentId/execute",
    action: "EXECUTE_REIMBURSEMENT",
    responseVersion: "reimbursement.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/finance/reimbursements/:documentId/reverse",
    action: "REVERSE_REIMBURSEMENT",
    responseVersion: "reimbursement.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/finance/refunds/:documentId/approve",
    action: "REVIEW_REFUND",
    responseVersion: "refund.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/finance/reimbursements/:documentId/reject",
    action: "REVIEW_REIMBURSEMENT",
    responseVersion: "reimbursement.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/finance/refunds/:documentId/reject",
    action: "REVIEW_REFUND",
    responseVersion: "refund.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/finance/reimbursements/mine",
    action: "READ_OWN_REIMBURSEMENT",
    responseVersion: "reimbursements.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/finance/refunds/mine",
    action: "READ_OWN_REFUND",
    responseVersion: "refunds.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/finance/reimbursements/managed",
    action: "READ_MANAGED_REIMBURSEMENT",
    responseVersion: "reimbursements.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/finance/refunds/managed",
    action: "READ_MANAGED_REFUND",
    responseVersion: "refunds.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/finance/reimbursements/:documentId",
    action: "READ_OWN_REIMBURSEMENT",
    alternativeActions: ["READ_MANAGED_REIMBURSEMENT"],
    responseVersion: "reimbursement-detail.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/finance/refunds/:documentId",
    action: "READ_OWN_REFUND",
    alternativeActions: ["READ_MANAGED_REFUND"],
    responseVersion: "refund-detail.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/finance/drafts/:documentId/self-purchase-submit",
    action: "SUBMIT_OWN_SELF_PURCHASE",
    responseVersion: "self-purchase.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/finance/self-purchases/:documentId/reverse",
    action: "REVERSE_MANAGED_SELF_PURCHASE",
    responseVersion: "self-purchase.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/finance/self-purchases/mine",
    action: "READ_OWN_SELF_PURCHASE",
    responseVersion: "self-purchases.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/finance/self-purchases/managed",
    action: "READ_MANAGED_SELF_PURCHASE",
    responseVersion: "self-purchases.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/finance/self-purchases/:documentId",
    action: "READ_OWN_SELF_PURCHASE",
    alternativeActions: ["READ_MANAGED_SELF_PURCHASE"],
    responseVersion: "self-purchase-detail.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/admin/company-funds",
    action: "MANAGE_COMPANY_FUNDS",
    responseVersion: "company-fund.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/admin/company-funds",
    action: "MANAGE_COMPANY_FUNDS",
    responseVersion: "company-funds.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/admin/company-funds/:fundId/assignment",
    action: "MANAGE_COMPANY_FUNDS",
    responseVersion: "company-fund-assignment.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/admin/company-funds/:fundId/status",
    action: "MANAGE_COMPANY_FUNDS",
    responseVersion: "company-fund.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/referrals/receiving-teachers",
    action: "CREATE_REFERRAL",
    responseVersion: "receiving-teachers.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/referrals/sent",
    action: "READ_SENT_REFERRALS",
    responseVersion: "sent-referrals.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/referrals/managed",
    action: "READ_MANAGED_REFERRALS",
    responseVersion: "managed-referrals.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/session/logout",
    action: "VIEW_OWN_PROFILE",
    responseVersion: "session-logout.v1",
    requiresRoleContext: false,
  },
  {
    method: "GET",
    path: "/v1/session",
    action: "VIEW_OWN_PROFILE",
    responseVersion: "session.v1",
    requiresRoleContext: false,
  },
  {
    method: "GET",
    path: "/v1/teaching/referrals",
    action: "READ_RECEIVED_REFERRALS",
    responseVersion: "received-referrals.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/teaching/weeks",
    action: "LIST_OPEN_TEACHING_WEEKS",
    responseVersion: "teaching-weeks.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/session",
    action: "VIEW_OWN_PROFILE",
    responseVersion: "session.v1",
    requiresRoleContext: false,
  },
  {
    method: "GET",
    path: "/v1/me",
    action: "VIEW_OWN_PROFILE",
    responseVersion: "me.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/role-contexts/switch",
    action: "VIEW_OWN_PROFILE",
    responseVersion: "role-context.v1",
    requiresRoleContext: false,
  },
  {
    method: "POST",
    path: "/v1/referrals",
    action: "CREATE_REFERRAL",
    responseVersion: "referral.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/referrals/:referralId/copy",
    action: "CREATE_REFERRAL",
    responseVersion: "referral-copy.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/finance/drafts",
    action: "CREATE_FINANCE_DOCUMENT",
    responseVersion: "finance-draft.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/finance/drafts/mine",
    action: "READ_OWN_FINANCE_DRAFT",
    responseVersion: "finance-drafts.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/finance/drafts/:documentId",
    action: "READ_OWN_FINANCE_DRAFT",
    responseVersion: "finance-draft.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/finance/drafts/:documentId/attachment-uploads",
    action: "UPLOAD_OWN_FINANCE_ATTACHMENT",
    alternativeActions: ["UPLOAD_FINANCE_RECEIPT"],
    responseVersion: "attachment-reservation.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/finance/attachment-uploads/:versionId",
    action: "READ_OWN_FINANCE_ATTACHMENT",
    alternativeActions: ["READ_MANAGED_FINANCE_ATTACHMENT"],
    responseVersion: "attachment-metadata.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/finance/attachments/:attachmentId/versions",
    action: "UPLOAD_OWN_FINANCE_ATTACHMENT",
    alternativeActions: ["UPLOAD_FINANCE_RECEIPT"],
    responseVersion: "attachment-reservation.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/finance/documents/:documentId/attachments",
    action: "READ_OWN_FINANCE_ATTACHMENT",
    alternativeActions: ["READ_MANAGED_FINANCE_ATTACHMENT"],
    responseVersion: "document-attachments.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/finance/attachment-uploads/:versionId/content",
    action: "UPLOAD_OWN_FINANCE_ATTACHMENT",
    alternativeActions: ["UPLOAD_FINANCE_RECEIPT"],
    responseVersion: "attachment-upload.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/finance/attachments/:versionId/content",
    action: "READ_OWN_FINANCE_ATTACHMENT",
    alternativeActions: ["READ_MANAGED_FINANCE_ATTACHMENT"],
    responseVersion: "attachment-binary.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/referrals/:referralId/archive",
    action: "MANAGE_OWN_REFERRALS",
    responseVersion: "referral-lifecycle.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/referrals/:referralId/reactivate",
    action: "MANAGE_OWN_REFERRALS",
    responseVersion: "referral-lifecycle.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/referrals/:referralId/complete",
    action: "COMPLETE_REFERRAL",
    responseVersion: "referral-lifecycle.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/referrals/:referralId/accept",
    action: "ACCEPT_REFERRAL",
    responseVersion: "referral.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/referrals/:referralId/weekly-fees",
    action: "CREATE_WEEKLY_FEE",
    responseVersion: "weekly-fee.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/finance/drafts/:documentId/withdrawal-submit",
    action: "CREATE_PERSONAL_WITHDRAWAL",
    responseVersion: "withdrawal-command.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/finance/withdrawals/:documentId/finance-revoke",
    action: "PROCESS_WITHDRAWAL",
    responseVersion: "withdrawal-command.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/finance/withdrawals/:documentId/mark-transferred",
    action: "PROCESS_WITHDRAWAL",
    responseVersion: "withdrawal-command.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/finance/withdrawals/sources",
    action: "READ_OWN_WITHDRAWAL",
    responseVersion: "withdrawal-sources.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/finance/withdrawals/mine",
    action: "READ_OWN_WITHDRAWAL",
    responseVersion: "withdrawals.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/finance/withdrawals/pending-transfer",
    action: "PROCESS_WITHDRAWAL",
    responseVersion: "withdrawals.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/finance/withdrawals/managed",
    action: "READ_MANAGED_WITHDRAWAL",
    responseVersion: "withdrawals.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/finance/withdrawals/:documentId",
    action: "READ_OWN_WITHDRAWAL",
    alternativeActions: ["READ_MANAGED_WITHDRAWAL"],
    responseVersion: "withdrawal-detail.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/finance/documents",
    action: "CREATE_FINANCE_DOCUMENT",
    responseVersion: "finance-document.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/regions/:regionId/person-summaries",
    action: "VIEW_REGION_PERSONAL_SUMMARY",
    responseVersion: "region-person-summary.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/admin/rates/preview",
    action: "CONFIGURE_RATES",
    responseVersion: "rate-policy-preview.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/admin/rates/publish",
    action: "CONFIGURE_RATES",
    responseVersion: "rate-policy.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/admin/person-relationships/teaching-mentor/preview",
    action: "MANAGE_PERSON_RELATIONSHIPS",
    responseVersion: "teaching-mentor-relationship-preview.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/admin/person-relationships/teaching-mentor",
    action: "MANAGE_PERSON_RELATIONSHIPS",
    responseVersion: "teaching-mentor-relationship-change.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/admin/person-relationships/planning-mentor/preview",
    action: "MANAGE_PERSON_RELATIONSHIPS",
    responseVersion: "admin-planning-mentor-relationship-preview.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/admin/person-relationships/planning-mentor",
    action: "MANAGE_PERSON_RELATIONSHIPS",
    responseVersion: "admin-planning-mentor-relationship-change.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/admin/organization/person-campus/preview",
    action: "MANAGE_PERSON_RELATIONSHIPS",
    responseVersion: "person-campus-assignment-preview.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/admin/organization/person-campus",
    action: "MANAGE_PERSON_RELATIONSHIPS",
    responseVersion: "person-campus-assignment-change.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/admin/organization/campus-region/preview",
    action: "MANAGE_PERSON_RELATIONSHIPS",
    responseVersion: "campus-region-assignment-preview.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/admin/organization/campus-region",
    action: "MANAGE_PERSON_RELATIONSHIPS",
    responseVersion: "campus-region-assignment-change.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/admin/person-relationships/preview",
    action: "MANAGE_PERSON_RELATIONSHIPS",
    responseVersion: "relationship-preview.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/admin/person-relationships",
    action: "MANAGE_PERSON_RELATIONSHIPS",
    responseVersion: "relationship-change.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/venues",
    action: "CREATE_VENUE",
    responseVersion: "venue.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/venues/mine",
    action: "READ_OWN_VENUES",
    responseVersion: "venues.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/venues/visible",
    action: "READ_OWN_VENUES",
    responseVersion: "venues.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/venues/:venueId/board",
    action: "VIEW_SHARED_VENUE_BOARD",
    responseVersion: "venue-board.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/venues/:venueId",
    action: "READ_OWN_VENUES",
    responseVersion: "venue-detail.v1",
    requiresRoleContext: true,
  },
  {
    method: "PATCH",
    path: "/v1/venues/:venueId",
    action: "MANAGE_OWN_VENUE",
    responseVersion: "venue.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/venues/:venueId/default",
    action: "MANAGE_OWN_VENUE",
    responseVersion: "venue.v1",
    requiresRoleContext: true,
  },
  {
    method: "POST",
    path: "/v1/venues/:venueId/permissions",
    action: "MANAGE_OWN_VENUE",
    responseVersion: "venue-permission.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/venues/available",
    action: "LIST_AVAILABLE_VENUES",
    responseVersion: "venue-directory.v1",
    requiresRoleContext: true,
  },
  {
    method: "GET",
    path: "/v1/exports/full-backup",
    action: "EXPORT_FULL_BACKUP",
    responseVersion: "export-job.v1",
    requiresRoleContext: true,
  },
];

export const findEndpoint = (
  method: HttpMethod,
  path: string,
): EndpointContract | undefined =>
  ENDPOINT_CONTRACTS.find(
    (endpoint) => endpoint.method === method && endpoint.path === path,
  );
