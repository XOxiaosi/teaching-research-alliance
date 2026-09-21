export const SYSTEM_AUTHORITIES = ["SYSTEM_OWNER", "SYSTEM_ADMIN"] as const;
export type SystemAuthority = (typeof SYSTEM_AUTHORITIES)[number];

export const BUSINESS_IDENTITIES = ["TEACHING_TEACHER", "ACADEMIC_PLANNER"] as const;
export type BusinessIdentity = (typeof BUSINESS_IDENTITIES)[number];

export const DUTIES = [
  "HEADQUARTERS_FINANCE",
  "REGION_FINANCE",
  "CAMPUS_PRINCIPAL",
  "GROUP_LEADER",
  "TEACHING_MENTOR",
  "PLANNING_MENTOR",
  "VENUE_OWNER"
] as const;
export type Duty = (typeof DUTIES)[number];

export const ACTIONS = [
  "VIEW_OWN_PROFILE",
  "VIEW_OWN_BALANCE",
  "VIEW_OWN_CURRENT_YEAR_SETTLEMENT",
  "CREATE_REFERRAL",
  "ACCEPT_REFERRAL",
  "CREATE_WEEKLY_FEE",
  "CREATE_PERSONAL_WITHDRAWAL",
  "CREATE_FINANCE_DOCUMENT",
  "APPROVE_FINANCE_DOCUMENT",
  "MANAGE_CASH_WAGES",
  "VIEW_REGION_PERSONAL_SUMMARY",
  "VIEW_CAMPUS_SCOPE_SETTLEMENT",
  "VIEW_GROUP_SCOPE_SETTLEMENT",
  "VIEW_MENTEE_SCOPE_SETTLEMENT",
  "MANAGE_OWN_PLANNING_RELATIONSHIPS",
  "CREATE_VENUE",
  "VIEW_SHARED_VENUE_BOARD",
  "WITHDRAW_FROM_SHARED_VENUE",
  "CONFIGURE_RATES",
  "MANAGE_PERSON_RELATIONSHIPS",
  "VIEW_ALL_DATA",
  "EXPORT_FULL_BACKUP"
] as const;
export type Action = (typeof ACTIONS)[number];

export type PermissionSubject = SystemAuthority | Duty | BusinessIdentity;
export type PermissionScope = "SELF" | "REGION" | "CAMPUS" | "ASSOCIATED_TEACHERS" | "MENTEES" | "VENUE" | "GLOBAL";

export type PermissionRule = Readonly<{
  subject: PermissionSubject;
  action: Action;
  scope: PermissionScope;
}>;

const rule = (subject: PermissionSubject, action: Action, scope: PermissionScope): PermissionRule => ({
  subject,
  action,
  scope
});

/**
 * DEV-001 的服务端权限基础表。它只描述“允许的最小能力”，数据范围仍需在请求中再次校验。
 * 场地所有者是业务主体，不会因为拥有场地而取得公司管理权限。
 */
export const PERMISSION_RULES: readonly PermissionRule[] = [
  rule("SYSTEM_OWNER", "VIEW_ALL_DATA", "GLOBAL"),
  rule("SYSTEM_OWNER", "CONFIGURE_RATES", "GLOBAL"),
  rule("SYSTEM_OWNER", "MANAGE_PERSON_RELATIONSHIPS", "GLOBAL"),
  rule("SYSTEM_OWNER", "EXPORT_FULL_BACKUP", "GLOBAL"),
  rule("SYSTEM_ADMIN", "VIEW_ALL_DATA", "GLOBAL"),
  rule("SYSTEM_ADMIN", "CONFIGURE_RATES", "GLOBAL"),
  rule("SYSTEM_ADMIN", "MANAGE_PERSON_RELATIONSHIPS", "GLOBAL"),
  rule("SYSTEM_ADMIN", "EXPORT_FULL_BACKUP", "GLOBAL"),
  rule("TEACHING_TEACHER", "VIEW_OWN_PROFILE", "SELF"),
  rule("TEACHING_TEACHER", "VIEW_OWN_BALANCE", "SELF"),
  rule("TEACHING_TEACHER", "VIEW_OWN_CURRENT_YEAR_SETTLEMENT", "SELF"),
  rule("TEACHING_TEACHER", "CREATE_REFERRAL", "SELF"),
  rule("TEACHING_TEACHER", "ACCEPT_REFERRAL", "SELF"),
  rule("TEACHING_TEACHER", "CREATE_WEEKLY_FEE", "SELF"),
  rule("TEACHING_TEACHER", "CREATE_PERSONAL_WITHDRAWAL", "SELF"),
  rule("TEACHING_TEACHER", "CREATE_FINANCE_DOCUMENT", "SELF"),
  rule("TEACHING_TEACHER", "CREATE_VENUE", "SELF"),
  rule("TEACHING_TEACHER", "VIEW_SHARED_VENUE_BOARD", "VENUE"),
  rule("TEACHING_TEACHER", "WITHDRAW_FROM_SHARED_VENUE", "VENUE"),
  rule("ACADEMIC_PLANNER", "CREATE_REFERRAL", "SELF"),
  rule("ACADEMIC_PLANNER", "VIEW_OWN_PROFILE", "SELF"),
  rule("ACADEMIC_PLANNER", "VIEW_OWN_BALANCE", "SELF"),
  rule("ACADEMIC_PLANNER", "VIEW_OWN_CURRENT_YEAR_SETTLEMENT", "SELF"),
  rule("PLANNING_MENTOR", "MANAGE_OWN_PLANNING_RELATIONSHIPS", "SELF"),
  rule("PLANNING_MENTOR", "VIEW_MENTEE_SCOPE_SETTLEMENT", "MENTEES"),
  rule("HEADQUARTERS_FINANCE", "APPROVE_FINANCE_DOCUMENT", "GLOBAL"),
  rule("HEADQUARTERS_FINANCE", "MANAGE_CASH_WAGES", "GLOBAL"),
  rule("HEADQUARTERS_FINANCE", "VIEW_ALL_DATA", "GLOBAL"),
  rule("REGION_FINANCE", "VIEW_REGION_PERSONAL_SUMMARY", "REGION"),
  rule("CAMPUS_PRINCIPAL", "VIEW_CAMPUS_SCOPE_SETTLEMENT", "CAMPUS"),
  rule("GROUP_LEADER", "VIEW_GROUP_SCOPE_SETTLEMENT", "ASSOCIATED_TEACHERS"),
  rule("TEACHING_MENTOR", "VIEW_MENTEE_SCOPE_SETTLEMENT", "MENTEES"),
  rule("VENUE_OWNER", "VIEW_SHARED_VENUE_BOARD", "VENUE"),
  rule("VENUE_OWNER", "WITHDRAW_FROM_SHARED_VENUE", "VENUE")
];

export const hasPermission = (subject: PermissionSubject, action: Action): boolean =>
  PERMISSION_RULES.some((item) => item.subject === subject && item.action === action);

export const permissionScope = (subject: PermissionSubject, action: Action): PermissionScope | undefined =>
  PERMISSION_RULES.find((item) => item.subject === subject && item.action === action)?.scope;

export type RoleContext = Readonly<{
  subject: PermissionSubject;
  personId: string;
  regionId?: string;
  campusId?: string;
  venueId?: string;
}>;

export const assertKnownAction = (value: string): Action => {
  if ((ACTIONS as readonly string[]).includes(value)) return value as Action;
  throw new Error(`UNKNOWN_ACTION:${value}`);
};

export const API_CONTRACT_VERSION = "2026-09-20.dev-001" as const;

export const API_ERROR_CODES = [
  "UNAUTHENTICATED",
  "PERSON_NOT_FOUND",
  "REFERRAL_NOT_FOUND",
  "REFERRAL_ARCHIVED",
  "TEACHING_WEEK_NOT_FOUND",
  "WEEKLY_FEE_NOT_FOUND",
  "RATE_PREVIEW_NOT_FOUND",
  "PERSONAL_ACCOUNT_NOT_FOUND",
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
  "IDEMPOTENCY_REPLAY"
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export type HttpMethod = "GET" | "POST" | "PATCH";

export type EndpointContract = Readonly<{
  method: HttpMethod;
  path: string;
  action: Action;
  responseVersion: string;
  requiresRoleContext: boolean;
}>;

export const ENDPOINT_CONTRACTS: readonly EndpointContract[] = [
  { method: "POST", path: "/v1/session/logout", action: "VIEW_OWN_PROFILE", responseVersion: "session-logout.v1", requiresRoleContext: false },
  { method: "GET", path: "/v1/session", action: "VIEW_OWN_PROFILE", responseVersion: "session.v1", requiresRoleContext: false },
  { method: "GET", path: "/v1/teaching/referrals", action: "CREATE_WEEKLY_FEE", responseVersion: "received-referrals.v1", requiresRoleContext: true },
  { method: "GET", path: "/v1/teaching/weeks", action: "CREATE_WEEKLY_FEE", responseVersion: "teaching-weeks.v1", requiresRoleContext: true },
  { method: "POST", path: "/v1/session", action: "VIEW_OWN_PROFILE", responseVersion: "session.v1", requiresRoleContext: false },
  { method: "GET", path: "/v1/me", action: "VIEW_OWN_PROFILE", responseVersion: "me.v1", requiresRoleContext: true },
  { method: "POST", path: "/v1/role-contexts/switch", action: "VIEW_OWN_PROFILE", responseVersion: "role-context.v1", requiresRoleContext: false },
  { method: "POST", path: "/v1/referrals", action: "CREATE_REFERRAL", responseVersion: "referral.v1", requiresRoleContext: true },
  { method: "POST", path: "/v1/referrals/:referralId/accept", action: "ACCEPT_REFERRAL", responseVersion: "referral.v1", requiresRoleContext: true },
  { method: "POST", path: "/v1/referrals/:referralId/weekly-fees", action: "CREATE_WEEKLY_FEE", responseVersion: "weekly-fee.v1", requiresRoleContext: true },
  { method: "POST", path: "/v1/accounts/:accountId/withdrawals", action: "CREATE_PERSONAL_WITHDRAWAL", responseVersion: "withdrawal.v1", requiresRoleContext: true },
  { method: "POST", path: "/v1/finance/documents", action: "CREATE_FINANCE_DOCUMENT", responseVersion: "finance-document.v1", requiresRoleContext: true },
  { method: "POST", path: "/v1/finance/documents/:documentId/approve", action: "APPROVE_FINANCE_DOCUMENT", responseVersion: "finance-document.v1", requiresRoleContext: true },
  { method: "GET", path: "/v1/regions/:regionId/person-summaries", action: "VIEW_REGION_PERSONAL_SUMMARY", responseVersion: "region-person-summary.v1", requiresRoleContext: true },
  { method: "POST", path: "/v1/admin/rates/preview", action: "CONFIGURE_RATES", responseVersion: "rate-policy-preview.v1", requiresRoleContext: true },
  { method: "POST", path: "/v1/admin/rates/publish", action: "CONFIGURE_RATES", responseVersion: "rate-policy.v1", requiresRoleContext: true },
  { method: "POST", path: "/v1/admin/person-relationships/preview", action: "MANAGE_PERSON_RELATIONSHIPS", responseVersion: "relationship-preview.v1", requiresRoleContext: true },
  { method: "POST", path: "/v1/admin/person-relationships", action: "MANAGE_PERSON_RELATIONSHIPS", responseVersion: "relationship-change.v1", requiresRoleContext: true },
  { method: "POST", path: "/v1/venues", action: "CREATE_VENUE", responseVersion: "venue.v1", requiresRoleContext: true },
  { method: "GET", path: "/v1/venues/available", action: "CREATE_WEEKLY_FEE", responseVersion: "venue-directory.v1", requiresRoleContext: true },
  { method: "GET", path: "/v1/exports/full-backup", action: "EXPORT_FULL_BACKUP", responseVersion: "export-job.v1", requiresRoleContext: true }
];

export const findEndpoint = (method: HttpMethod, path: string): EndpointContract | undefined =>
  ENDPOINT_CONTRACTS.find((endpoint) => endpoint.method === method && endpoint.path === path);
