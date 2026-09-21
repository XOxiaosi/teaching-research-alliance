import type { PermissionScope, PermissionSubject, RoleContext } from "@teaching-research-alliance/contracts";

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

export type ReferralClassType = "ONE_TO_ONE" | "SMALL_GROUP";

/** The client can select only a receiving teacher; the server fixes the referrer and source identity. */
export type ReferralCreationDraft = Readonly<{
  receiverPersonId: string;
  studentDisplayName: string;
  courseContextId: string;
  classType: ReferralClassType;
}>;

export type ReferralCreationSubmission = Readonly<{
  draft: ReferralCreationDraft;
  idempotencyKey: string;
}>;

export type ReceivingTeacher = Readonly<{
  personId: string;
  nickname: string;
}>;

export type ReferralCreationResult = Readonly<{
  referralId: string;
  studentRecordId: string;
  version: number;
  replay: boolean;
}>;

/**
 * Creates a new recommendation from an existing referral's student context.
 * The server remains responsible for checking that the source belongs to the caller.
 */
export type ReferralCopyDraft = Readonly<{
  sourceReferralId: string;
  receiverPersonId: string;
  courseContextId?: string;
  classType?: ReferralClassType;
}>;

export type ReferralCopySubmission = Readonly<{
  draft: ReferralCopyDraft;
  idempotencyKey: string;
}>;

export type ReferralCopyResult = Readonly<{
  referralId: string;
  studentRecordId: string;
  version: number;
  replay: boolean;
  copiedFromReferralId: string;
}>;

/** The receiving teacher may optionally select an allowed venue when accepting a referral. */
export type ReferralAcceptanceDraft = Readonly<{
  referralId: string;
  venueId?: string;
  expectedVersion: number;
}>;

/**
 * An acceptance submission is bound to the current session and role generation when
 * it is created. It cannot be replayed after an identity or role change.
 */
export type ReferralAcceptanceSubmission = Readonly<{
  draft: ReferralAcceptanceDraft;
  idempotencyKey: string;
}>;

export type ReferralAcceptanceResult = Readonly<{
  referralId: string;
  version: number;
  venueId: string;
  venueOwnerPersonId: string;
  isSelfUse: boolean;
  acceptedAt: string;
  replay: boolean;
}>;

export type ReferralLifecycleCommand = "ARCHIVE" | "REACTIVATE";

/** A referrer can only change the lifecycle of a record they originally sent. */
export type ReferralLifecycleDraft = Readonly<{
  referralId: string;
  expectedVersion: number;
  command: ReferralLifecycleCommand;
}>;

export type ReferralLifecycleSubmission = Readonly<{
  draft: ReferralLifecycleDraft;
  idempotencyKey: string;
}>;

export type ReferralLifecycleResult = Readonly<{
  referralId: string;
  status: "ARCHIVED" | "REACTIVATED";
  version: number;
  unacceptedExpiresAt: string | null;
  replay: boolean;
}>;

export const FINANCE_DRAFT_KINDS = [
  "WITHDRAWAL",
  "REIMBURSEMENT",
  "EXTERNAL_PAYMENT",
  "REFUND",
  "SELF_PURCHASE"
] as const;

export type FinanceDraftKind = (typeof FINANCE_DRAFT_KINDS)[number];

/** Financial drafts contain workflow metadata only. They do not contain money, bank, or ledger data. */
export type FinanceDraftMetadata = Readonly<{
  id: string;
  kind: FinanceDraftKind;
  status: "DRAFT";
  version: number;
  createdAt: string;
  updatedAt: string;
}>;

export type FinanceDraftSubmission = Readonly<{
  draft: Readonly<{ kind: FinanceDraftKind }>;
  idempotencyKey: string;
}>;

export type FinanceDraftCreateResult = FinanceDraftMetadata & Readonly<{ replay: boolean }>;

export const FINANCE_ATTACHMENT_PURPOSES = [
  "SUPPORTING_DOCUMENT",
  "APPLICATION_SCREENSHOT",
  "INVOICE",
  "PAYMENT_RECEIPT"
] as const;

export const FINANCE_ATTACHMENT_MEDIA_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;

export type FinanceAttachmentPurpose = (typeof FINANCE_ATTACHMENT_PURPOSES)[number];
export type FinanceAttachmentMediaType = (typeof FINANCE_ATTACHMENT_MEDIA_TYPES)[number];

/** JSON metadata only. Uploading the original bytes is deliberately a separate transport contract. */
export type FinanceAttachmentReservationDraft = Readonly<{
  documentId: string;
  purpose: FinanceAttachmentPurpose;
  originalFilename: string;
  declaredMediaType: FinanceAttachmentMediaType;
  declaredSizeBytes: number;
  expectedSha256?: string;
}>;

export type FinanceAttachmentReservationSubmission = Readonly<{
  draft: FinanceAttachmentReservationDraft;
  idempotencyKey: string;
}>;

export type FinanceAttachmentReservation = Readonly<{
  attachmentId: string;
  versionId: string;
  versionNo: number;
  status: "UPLOADING";
  purpose: FinanceAttachmentPurpose;
  originalFilename: string;
  declaredMediaType: FinanceAttachmentMediaType;
  declaredSizeBytes: number;
  expectedSha256?: string;
  createdAt: string;
  replay: boolean;
}>;

export type FinanceAttachmentVersionMetadata = Readonly<{
  attachmentId: string;
  versionId: string;
  versionNo: number;
  status: "UPLOADING" | "READY" | "FAILED";
  purpose: FinanceAttachmentPurpose;
  originalFilename: string;
  declaredMediaType: FinanceAttachmentMediaType;
  declaredSizeBytes: number;
  expectedSha256?: string;
  createdAt: string;
}>;

export type FinanceAttachmentBinding = Readonly<{
  stage: "SUBMISSION" | "COMPLETION";
  documentVersion: number;
  boundAt: string;
}>;

/** Version history is grouped by its immutable attachment slot. */
export type FinanceDocumentAttachmentVersion = Readonly<{
  versionId: string;
  versionNo: number;
  status: "UPLOADING" | "READY" | "FAILED";
  originalFilename: string;
  declaredMediaType: FinanceAttachmentMediaType;
  declaredSizeBytes: number;
  expectedSha256?: string;
  createdAt: string;
  binding?: FinanceAttachmentBinding;
}>;

export type FinanceDocumentAttachment = Readonly<{
  attachmentId: string;
  purpose: FinanceAttachmentPurpose;
  createdAt: string;
  versions: readonly FinanceDocumentAttachmentVersion[];
}>;

export type FinanceDocumentAttachments = Readonly<{
  documentId: string;
  attachments: readonly FinanceDocumentAttachment[];
}>;

/** Adds a new immutable version within an existing attachment slot. */
export type FinanceAttachmentVersionDraft = Readonly<{
  attachmentId: string;
  originalFilename: string;
  declaredMediaType: FinanceAttachmentMediaType;
  declaredSizeBytes: number;
  expectedSha256?: string;
}>;

export type FinanceAttachmentVersionSubmission = Readonly<{
  draft: FinanceAttachmentVersionDraft;
  idempotencyKey: string;
}>;

export type WithdrawalStatus = "PENDING_TRANSFER" | "TRANSFERRED" | "FINANCE_REVOKED";
export type WithdrawalSourceType = "PERSON" | "VENUE";

/** A currently withdrawable settlement account; the server remains authoritative for its balance and grant. */
export type WithdrawalSource = Readonly<{
  accountId: string;
  sourceType: WithdrawalSourceType;
  label: string;
  balanceCents: string;
  venueId?: string;
}>;

/** This list item deliberately exposes only a masked recipient account. */
export type WithdrawalSummary = Readonly<{
  id: string;
  applicantPersonId: string;
  applicantName: string;
  status: WithdrawalStatus;
  version: number;
  amountCents: string;
  sourceAccountId: string;
  sourceType: WithdrawalSourceType;
  venueId?: string;
  venueName?: string;
  bankAccountLast4: string;
  submittedAt: string;
}>;

export type WithdrawalRecipient = Readonly<{
  recipientName: string;
  bankAccount: string;
  bankName?: string;
}>;

export type WithdrawalAttachment = Readonly<{
  stage: "SUBMISSION" | "COMPLETION";
  purpose: FinanceAttachmentPurpose;
  versionId: string;
  originalFilename: string;
  mediaType: FinanceAttachmentMediaType;
  sizeBytes: number;
  sha256: string;
}>;

export type WithdrawalDetail = WithdrawalSummary & Readonly<{
  recipient: WithdrawalRecipient;
  attachments: readonly WithdrawalAttachment[];
}>;

export type WithdrawalCommandResult = Readonly<{
  id: string;
  status: WithdrawalStatus;
  version: number;
  replay: boolean;
}>;

export type WithdrawalSubmitDraft = Readonly<{
  documentId: string;
  expectedVersion: number;
  sourceAccountId: string;
  amountCents: string;
  recipientName: string;
  bankAccount: string;
  bankName?: string;
  attachmentVersionIds: readonly string[];
}>;

export type WithdrawalRevokeDraft = Readonly<{
  documentId: string;
  expectedVersion: number;
  reason: string;
}>;

export type WithdrawalMarkTransferredDraft = Readonly<{
  documentId: string;
  expectedVersion: number;
  attachmentVersionIds: readonly string[];
}>;

export type WithdrawalSubmitSubmission = Readonly<{
  draft: WithdrawalSubmitDraft;
  idempotencyKey: string;
}>;

export type WithdrawalRevokeSubmission = Readonly<{
  draft: WithdrawalRevokeDraft;
  idempotencyKey: string;
}>;

export type WithdrawalMarkTransferredSubmission = Readonly<{
  draft: WithdrawalMarkTransferredDraft;
  idempotencyKey: string;
}>;

export type SelfPurchaseSubmissionDraft = Readonly<{
  documentId: string;
  expectedVersion: number;
  amountCents: string;
  reason: string;
  attachmentVersionIds: readonly string[];
}>;

export type SelfPurchaseSubmission = Readonly<{
  draft: SelfPurchaseSubmissionDraft;
  idempotencyKey: string;
}>;

export type SelfPurchaseResult = Readonly<{
  id: string;
  status: "COMPLETED";
  version: number;
  replay: boolean;
}>;

export type SelfPurchaseSummary = Readonly<{
  id: string;
  status: "COMPLETED";
  version: number;
  amountCents: string;
  reason: string;
  applicantPersonId: string;
  sourceFund: Readonly<{ id: string; displayName: string }>;
  processingMode: "SYSTEM_RULE";
  submittedAt: string;
  completedAt: string;
}>;

export type SelfPurchaseAttachment = Readonly<{
  versionId: string;
  purpose: "SUPPORTING_DOCUMENT" | "APPLICATION_SCREENSHOT" | "INVOICE";
  originalFilename: string;
  mediaType: FinanceAttachmentMediaType;
  sizeBytes: number;
  sha256: string;
}>;

export type SelfPurchaseDetail = SelfPurchaseSummary & Readonly<{
  attachments: readonly SelfPurchaseAttachment[];
  management?: Readonly<{
    roleAssignmentId: string;
    companyFundAssignmentId: string;
    sourceAccountId: string;
    destinationAccountId: string;
    ledgerEventId: string;
  }>;
}>;

export type CompanyFundStatus = "ACTIVE" | "INACTIVE";

/** Stable COMPANY business account metadata. Balance and person ownership are deliberately absent. */
export type CompanyFundSummary = Readonly<{
  id: string;
  accountId: string;
  accountCode: string;
  fundCode: string;
  displayName: string;
  status: CompanyFundStatus;
  version: number;
}>;

export type CompanyFundCommandResult = CompanyFundSummary & Readonly<{ replay: boolean }>;

export type CompanyFundAssignment = Readonly<{
  id: string;
  fundId: string;
  validFrom: string;
}>;

export type CompanyFundAssignmentResult = CompanyFundAssignment & Readonly<{
  previousAssignmentId: string | null;
  replay: boolean;
}>;

export type CompanyFundList = Readonly<{
  funds: readonly CompanyFundSummary[];
  currentAssignment: CompanyFundAssignment | null;
}>;

export type CompanyFundCreateDraft = Readonly<{
  fundCode: string;
  displayName: string;
  organizationUnitId?: string;
}>;

export type CompanyFundCreateSubmission = Readonly<{
  draft: CompanyFundCreateDraft;
  idempotencyKey: string;
}>;

export type CompanyFundAssignmentDraft = Readonly<{
  fundId: string;
  expectedAssignmentId: string | null;
  reason: string;
}>;

export type CompanyFundAssignmentSubmission = Readonly<{
  draft: CompanyFundAssignmentDraft;
  idempotencyKey: string;
}>;

export type CompanyFundStatusDraft = Readonly<{
  fundId: string;
  expectedVersion: number;
  status: CompanyFundStatus;
  reason: string;
}>;

export type CompanyFundStatusSubmission = Readonly<{
  draft: CompanyFundStatusDraft;
  idempotencyKey: string;
}>;

export type SentReferralWeeklyFee = Readonly<{
  entryId: string;
  teachingWeekId: string;
  weekStartsOn: string;
  weekEndsOn: string;
  grossAmountCents: string;
}>;

export type SentReferral = Readonly<{
  referralId: string;
  studentRecordId: string;
  version: number;
  studentDisplayName: string;
  courseContextId: string;
  receiverPersonId: string;
  receiverNickname: string;
  referralStatus: string;
  submittedAt: string;
  sourceSubject: string | null;
  classType: string | null;
  weeklyFees: readonly SentReferralWeeklyFee[];
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

type Submission = WeeklyFeeSubmission | ReferralCreationSubmission | ReferralCopySubmission | ReferralAcceptanceSubmission | ReferralLifecycleSubmission | FinanceDraftSubmission | FinanceAttachmentReservationSubmission | FinanceAttachmentVersionSubmission | WithdrawalSubmitSubmission | WithdrawalRevokeSubmission | WithdrawalMarkTransferredSubmission | SelfPurchaseSubmission | CompanyFundCreateSubmission | CompanyFundAssignmentSubmission | CompanyFundStatusSubmission;

/**
 * Submission ownership deliberately excludes the response generation. A successful
 * write invalidates reads, but must not make a network-failed retry unsafe for the
 * same signed-in person and role.
 */
type SubmissionScope = Readonly<{
  sessionId: string;
  accountId: string;
  personId: string;
  roleSubject: PermissionSubject | null;
  rolePersonId: string | null;
  roleScope: PermissionScope | null;
  roleRegionId: string | null;
  roleCampusId: string | null;
  roleVenueId: string | null;
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

const validateReferralCreationDraft = (draft: ReferralCreationDraft): void => {
  requireNonBlank(draft.receiverPersonId, "receiverPersonId");
  requireNonBlank(draft.studentDisplayName, "studentDisplayName");
  requireNonBlank(draft.courseContextId, "courseContextId");
  if (draft.classType !== "ONE_TO_ONE" && draft.classType !== "SMALL_GROUP") {
    throw new ApiClientError(400, "INVALID_INPUT", "INVALID_INPUT:classType");
  }
};

const validateReferralCopyDraft = (draft: ReferralCopyDraft): void => {
  requireNonBlank(draft.sourceReferralId, "sourceReferralId");
  requireNonBlank(draft.receiverPersonId, "receiverPersonId");
  if (draft.courseContextId !== undefined) requireNonBlank(draft.courseContextId, "courseContextId");
  if (draft.classType !== undefined && draft.classType !== "ONE_TO_ONE" && draft.classType !== "SMALL_GROUP") {
    throw new ApiClientError(400, "INVALID_INPUT", "INVALID_INPUT:classType");
  }
};

const validateReferralAcceptanceDraft = (draft: ReferralAcceptanceDraft): void => {
  requireNonBlank(draft.referralId, "referralId");
  if (draft.venueId !== undefined) requireNonBlank(draft.venueId, "venueId");
  if (!Number.isSafeInteger(draft.expectedVersion) || draft.expectedVersion < 1) {
    throw new ApiClientError(400, "INVALID_INPUT", "INVALID_INPUT:expectedVersion");
  }
};

const validateReferralLifecycleDraft = (draft: ReferralLifecycleDraft): void => {
  requireNonBlank(draft.referralId, "referralId");
  if (!Number.isSafeInteger(draft.expectedVersion) || draft.expectedVersion < 1) {
    throw new ApiClientError(400, "INVALID_INPUT", "INVALID_INPUT:expectedVersion");
  }
  if (draft.command !== "ARCHIVE" && draft.command !== "REACTIVATE") {
    throw new ApiClientError(400, "INVALID_INPUT", "INVALID_INPUT:command");
  }
};

const validateFinanceDraftKind = (kind: string): kind is FinanceDraftKind => {
  if (!(FINANCE_DRAFT_KINDS as readonly string[]).includes(kind)) {
    throw new ApiClientError(400, "INVALID_INPUT", "INVALID_INPUT:kind");
  }
  return true;
};

/** UTF-8 byte length without relying on browser, Node, or miniapp-specific globals. */
const utf8ByteLength = (value: string): number => {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x80) length += 1;
    else if (codeUnit < 0x800) length += 2;
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4;
        index += 1;
      } else length += 3;
    } else length += 3;
  }
  return length;
};

const validateFinanceAttachmentVersionFields = (draft: Readonly<{
  originalFilename: string;
  declaredMediaType: FinanceAttachmentMediaType;
  declaredSizeBytes: number;
  expectedSha256?: string;
}>): void => {
  requireNonBlank(draft.originalFilename, "originalFilename");
  if (utf8ByteLength(draft.originalFilename) > 255 || /[\x00-\x1f\x7f/\\]/.test(draft.originalFilename)) {
    throw new ApiClientError(400, "INVALID_INPUT", "INVALID_INPUT:originalFilename");
  }
  if (!(FINANCE_ATTACHMENT_MEDIA_TYPES as readonly string[]).includes(draft.declaredMediaType)) {
    throw new ApiClientError(400, "INVALID_INPUT", "INVALID_INPUT:declaredMediaType");
  }
  if (!Number.isSafeInteger(draft.declaredSizeBytes) || draft.declaredSizeBytes < 1 || draft.declaredSizeBytes > 20 * 1024 * 1024) {
    throw new ApiClientError(400, "INVALID_INPUT", "INVALID_INPUT:declaredSizeBytes");
  }
  if (draft.expectedSha256 !== undefined && !/^[0-9a-f]{64}$/.test(draft.expectedSha256)) {
    throw new ApiClientError(400, "INVALID_INPUT", "INVALID_INPUT:expectedSha256");
  }
};

const validateFinanceAttachmentDraft = (draft: FinanceAttachmentReservationDraft): void => {
  requireNonBlank(draft.documentId, "documentId");
  if (!(FINANCE_ATTACHMENT_PURPOSES as readonly string[]).includes(draft.purpose)) {
    throw new ApiClientError(400, "INVALID_INPUT", "INVALID_INPUT:purpose");
  }
  validateFinanceAttachmentVersionFields(draft);
};

const validateFinanceAttachmentVersionDraft = (draft: FinanceAttachmentVersionDraft): void => {
  requireNonBlank(draft.attachmentId, "attachmentId");
  validateFinanceAttachmentVersionFields(draft);
};

const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

const validateExpectedWithdrawalVersion = (value: number): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ApiClientError(400, "INVALID_INPUT", "INVALID_INPUT:expectedVersion");
  }
};

const validateWithdrawalAmount = (value: string): void => {
  if (!/^\d+$/.test(value) || value.length > 19 || BigInt(value) < 1n || BigInt(value) > MAX_POSTGRES_BIGINT) {
    throw new ApiClientError(400, "INVALID_INPUT", "INVALID_INPUT:amountCents");
  }
};

/** Validate whitespace and control characters without rewriting bank text that must be submitted verbatim. */
const validateFinancialText = (value: string | undefined, field: string, maximum: number, optional = false): void => {
  if (value === undefined && optional) return;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ApiClientError(400, "INVALID_INPUT", `INVALID_INPUT:${field}`);
  }
};

const freezeAttachmentVersionIds = (ids: readonly string[], minimumCount = 1): readonly string[] => {
  if (!Array.isArray(ids) || ids.length < minimumCount || ids.length > 20) {
    throw new ApiClientError(400, "INVALID_INPUT", "INVALID_INPUT:attachmentVersionIds");
  }
  const copied = ids.map((id) => {
    requireNonBlank(id, "attachmentVersionIds");
    return id;
  });
  if (new Set(copied).size !== copied.length) {
    throw new ApiClientError(400, "INVALID_INPUT", "INVALID_INPUT:attachmentVersionIds");
  }
  return Object.freeze(copied);
};

const validateWithdrawalSubmitDraft = (draft: WithdrawalSubmitDraft): void => {
  requireNonBlank(draft.documentId, "documentId");
  validateExpectedWithdrawalVersion(draft.expectedVersion);
  requireNonBlank(draft.sourceAccountId, "sourceAccountId");
  validateWithdrawalAmount(draft.amountCents);
  validateFinancialText(draft.recipientName, "recipientName", 200);
  validateFinancialText(draft.bankAccount, "bankAccount", 256);
  validateFinancialText(draft.bankName, "bankName", 200, true);
  freezeAttachmentVersionIds(draft.attachmentVersionIds, 2);
};

const validateWithdrawalRevokeDraft = (draft: WithdrawalRevokeDraft): void => {
  requireNonBlank(draft.documentId, "documentId");
  validateExpectedWithdrawalVersion(draft.expectedVersion);
  validateFinancialText(draft.reason, "reason", 1_000);
};

const validateWithdrawalMarkTransferredDraft = (draft: WithdrawalMarkTransferredDraft): void => {
  requireNonBlank(draft.documentId, "documentId");
  validateExpectedWithdrawalVersion(draft.expectedVersion);
  freezeAttachmentVersionIds(draft.attachmentVersionIds);
};

const validateSelfPurchaseDraft = (draft: SelfPurchaseSubmissionDraft): void => {
  requireNonBlank(draft.documentId, "documentId");
  validateExpectedWithdrawalVersion(draft.expectedVersion);
  validateWithdrawalAmount(draft.amountCents);
  validateFinancialText(draft.reason, "reason", 1_000);
  freezeAttachmentVersionIds(draft.attachmentVersionIds, 2);
};

const validateCompanyFundCreateDraft = (draft: CompanyFundCreateDraft): void => {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(draft.fundCode)) {
    throw new ApiClientError(400, "INVALID_INPUT", "INVALID_INPUT:fundCode");
  }
  validateFinancialText(draft.displayName, "displayName", 200);
  if (draft.organizationUnitId !== undefined) requireNonBlank(draft.organizationUnitId, "organizationUnitId");
};

const validateCompanyFundAssignmentDraft = (draft: CompanyFundAssignmentDraft): void => {
  requireNonBlank(draft.fundId, "fundId");
  if (draft.expectedAssignmentId !== null) requireNonBlank(draft.expectedAssignmentId, "expectedAssignmentId");
  validateFinancialText(draft.reason, "reason", 1_000);
};

const validateCompanyFundStatusDraft = (draft: CompanyFundStatusDraft): void => {
  requireNonBlank(draft.fundId, "fundId");
  validateExpectedWithdrawalVersion(draft.expectedVersion);
  if (draft.status !== "ACTIVE" && draft.status !== "INACTIVE") {
    throw new ApiClientError(400, "INVALID_INPUT", "INVALID_INPUT:status");
  }
  validateFinancialText(draft.reason, "reason", 1_000);
};

const sameRoleContext = (left: RoleContext | null, right: RoleContext | null): boolean =>
  left?.subject === right?.subject
  && left?.personId === right?.personId
  && left?.scope === right?.scope
  && left?.regionId === right?.regionId
  && left?.campusId === right?.campusId
  && left?.venueId === right?.venueId;

const sameSubmissionScope = (left: SessionSnapshot | null, right: SessionSnapshot): boolean =>
  left !== null
  && left.sessionId === right.sessionId
  && left.accountId === right.accountId
  && left.personId === right.personId
  && sameRoleContext(left.currentRoleContext, right.currentRoleContext);

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
  private readonly submissionStatuses = new WeakMap<Submission, SubmissionStatus>();
  private readonly submissionScopes = new WeakMap<Submission, SubmissionScope>();
  private session: SessionSnapshot | null = null;
  private epoch = 0;
  private submissionScopeEpoch = 0;

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

  public async listReceivingTeachers(): Promise<readonly ReceivingTeacher[]> {
    return this.authenticatedRequest<readonly ReceivingTeacher[]>("GET", "/v1/referrals/receiving-teachers");
  }

  public async listSentReferrals(): Promise<readonly SentReferral[]> {
    return this.authenticatedRequest<readonly SentReferral[]>("GET", "/v1/referrals/sent");
  }

  public async listOwnFinanceDrafts(): Promise<readonly FinanceDraftMetadata[]> {
    return this.authenticatedRequest<readonly FinanceDraftMetadata[]>("GET", "/v1/finance/drafts/mine");
  }

  public async getOwnFinanceDraft(documentId: string): Promise<FinanceDraftMetadata> {
    requireNonBlank(documentId, "documentId");
    return this.authenticatedRequest<FinanceDraftMetadata>("GET", `/v1/finance/drafts/${encodeURIComponent(documentId)}`);
  }

  public async getOwnFinanceAttachmentVersion(versionId: string): Promise<FinanceAttachmentVersionMetadata> {
    requireNonBlank(versionId, "versionId");
    return this.authenticatedRequest<FinanceAttachmentVersionMetadata>(
      "GET",
      `/v1/finance/attachment-uploads/${encodeURIComponent(versionId)}`
    );
  }

  public async listFinanceDocumentAttachments(documentId: string): Promise<FinanceDocumentAttachments> {
    requireNonBlank(documentId, "documentId");
    return this.authenticatedRequest<FinanceDocumentAttachments>(
      "GET",
      `/v1/finance/documents/${encodeURIComponent(documentId)}/attachments`
    );
  }

  public async listWithdrawalSources(): Promise<readonly WithdrawalSource[]> {
    return this.authenticatedRequest<readonly WithdrawalSource[]>("GET", "/v1/finance/withdrawals/sources");
  }

  public async listOwnWithdrawals(): Promise<readonly WithdrawalSummary[]> {
    return this.authenticatedRequest<readonly WithdrawalSummary[]>("GET", "/v1/finance/withdrawals/mine");
  }

  public async listPendingTransferWithdrawals(): Promise<readonly WithdrawalSummary[]> {
    return this.authenticatedRequest<readonly WithdrawalSummary[]>("GET", "/v1/finance/withdrawals/pending-transfer");
  }

  public async listManagedWithdrawals(): Promise<readonly WithdrawalSummary[]> {
    return this.authenticatedRequest<readonly WithdrawalSummary[]>("GET", "/v1/finance/withdrawals/managed");
  }

  public async getWithdrawalDetail(documentId: string): Promise<WithdrawalDetail> {
    requireNonBlank(documentId, "documentId");
    return this.authenticatedRequest<WithdrawalDetail>("GET", `/v1/finance/withdrawals/${encodeURIComponent(documentId)}`);
  }

  public async listOwnSelfPurchases(): Promise<Readonly<{ documents: readonly SelfPurchaseSummary[] }>> {
    return this.authenticatedRequest<Readonly<{ documents: readonly SelfPurchaseSummary[] }>>(
      "GET", "/v1/finance/self-purchases/mine"
    );
  }

  public async listManagedSelfPurchases(): Promise<Readonly<{ documents: readonly SelfPurchaseSummary[] }>> {
    return this.authenticatedRequest<Readonly<{ documents: readonly SelfPurchaseSummary[] }>>(
      "GET", "/v1/finance/self-purchases/managed"
    );
  }

  public async getSelfPurchaseDetail(documentId: string): Promise<SelfPurchaseDetail> {
    requireNonBlank(documentId, "documentId");
    return this.authenticatedRequest<SelfPurchaseDetail>(
      "GET", `/v1/finance/self-purchases/${encodeURIComponent(documentId)}`
    );
  }

  public async listCompanyFunds(): Promise<CompanyFundList> {
    this.requireCompanyFundAdministrator();
    return this.authenticatedRequest<CompanyFundList>("GET", "/v1/admin/company-funds");
  }

  /**
   * A submission is immutable. Retry the same object after an uncertain network failure;
   * create a new object after editing any field so the old idempotency key is never reused.
   */
  public createWeeklyFeeSubmission(draft: WeeklyFeeDraftInput): WeeklyFeeSubmission {
    validateWeeklyFeeDraft(draft);
    const scope = this.captureSubmissionScope();
    const idempotencyKey = (this.options.idempotencyKeyFactory ?? defaultIdempotencyKeyFactory)();
    requireNonBlank(idempotencyKey, "idempotencyKey");
    const frozenDraft = Object.freeze({ ...draft });
    const submission = Object.freeze({ draft: frozenDraft, idempotencyKey });
    this.submissionStatuses.set(submission, "READY");
    this.submissionScopes.set(submission, scope);
    return submission;
  }

  /**
   * The submission excludes referrer fields by design. Retry this same object after
   * an uncertain network result; change any form field to create a new request key.
   */
  public createReferralSubmission(draft: ReferralCreationDraft): ReferralCreationSubmission {
    validateReferralCreationDraft(draft);
    const scope = this.captureSubmissionScope();
    const idempotencyKey = (this.options.idempotencyKeyFactory ?? defaultIdempotencyKeyFactory)();
    requireNonBlank(idempotencyKey, "idempotencyKey");
    const frozenDraft = Object.freeze({ ...draft });
    const submission = Object.freeze({ draft: frozenDraft, idempotencyKey });
    this.submissionStatuses.set(submission, "READY");
    this.submissionScopes.set(submission, scope);
    return submission;
  }

  /** Omitted course or class fields keep the source recommendation's server-side values. */
  public createReferralCopySubmission(draft: ReferralCopyDraft): ReferralCopySubmission {
    validateReferralCopyDraft(draft);
    const scope = this.captureSubmissionScope();
    const idempotencyKey = (this.options.idempotencyKeyFactory ?? defaultIdempotencyKeyFactory)();
    requireNonBlank(idempotencyKey, "idempotencyKey");
    const frozenDraft = Object.freeze({ ...draft });
    const submission = Object.freeze({ draft: frozenDraft, idempotencyKey });
    this.submissionStatuses.set(submission, "READY");
    this.submissionScopes.set(submission, scope);
    return submission;
  }

  /**
   * Capture the active authentication generation with this immutable submission.
   * A retry is safe only while the same person and role generation remain active.
   */
  public createReferralAcceptanceSubmission(draft: ReferralAcceptanceDraft): ReferralAcceptanceSubmission {
    validateReferralAcceptanceDraft(draft);
    const scope = this.captureSubmissionScope();
    const idempotencyKey = (this.options.idempotencyKeyFactory ?? defaultIdempotencyKeyFactory)();
    requireNonBlank(idempotencyKey, "idempotencyKey");
    const frozenDraft = Object.freeze({ ...draft });
    const submission = Object.freeze({ draft: frozenDraft, idempotencyKey });
    this.submissionStatuses.set(submission, "READY");
    this.submissionScopes.set(submission, scope);
    return submission;
  }

  /**
   * Lifecycle changes are immutable commands. An uncertain result must retry this
   * object, not create a fresh command or idempotency key.
   */
  public createReferralLifecycleSubmission(draft: ReferralLifecycleDraft): ReferralLifecycleSubmission {
    validateReferralLifecycleDraft(draft);
    const scope = this.captureSubmissionScope();
    const idempotencyKey = (this.options.idempotencyKeyFactory ?? defaultIdempotencyKeyFactory)();
    requireNonBlank(idempotencyKey, "idempotencyKey");
    const frozenDraft = Object.freeze({ ...draft });
    const submission = Object.freeze({ draft: frozenDraft, idempotencyKey });
    this.submissionStatuses.set(submission, "READY");
    this.submissionScopes.set(submission, scope);
    return submission;
  }

  /** A financial draft starts as metadata only; later financial details require a separate contract. */
  public createFinanceDraftSubmission(draft: Readonly<{ kind: FinanceDraftKind }>): FinanceDraftSubmission {
    validateFinanceDraftKind(draft.kind);
    const scope = this.captureSubmissionScope();
    const idempotencyKey = (this.options.idempotencyKeyFactory ?? defaultIdempotencyKeyFactory)();
    requireNonBlank(idempotencyKey, "idempotencyKey");
    const frozenDraft = Object.freeze({ kind: draft.kind });
    const submission = Object.freeze({ draft: frozenDraft, idempotencyKey });
    this.submissionStatuses.set(submission, "READY");
    this.submissionScopes.set(submission, scope);
    return submission;
  }

  /** Reserve immutable attachment metadata before starting the separate binary upload flow. */
  public createFinanceAttachmentReservationSubmission(
    draft: FinanceAttachmentReservationDraft
  ): FinanceAttachmentReservationSubmission {
    validateFinanceAttachmentDraft(draft);
    const scope = this.captureSubmissionScope();
    const idempotencyKey = (this.options.idempotencyKeyFactory ?? defaultIdempotencyKeyFactory)();
    requireNonBlank(idempotencyKey, "idempotencyKey");
    const frozenDraft = Object.freeze({
      documentId: draft.documentId,
      purpose: draft.purpose,
      originalFilename: draft.originalFilename,
      declaredMediaType: draft.declaredMediaType,
      declaredSizeBytes: draft.declaredSizeBytes,
      ...(draft.expectedSha256 === undefined ? {} : { expectedSha256: draft.expectedSha256 })
    });
    const submission = Object.freeze({ draft: frozenDraft, idempotencyKey });
    this.submissionStatuses.set(submission, "READY");
    this.submissionScopes.set(submission, scope);
    return submission;
  }

  /** Keep the slot identity and immutable file metadata together for an uncertain version-reservation retry. */
  public createFinanceAttachmentVersionSubmission(
    draft: FinanceAttachmentVersionDraft
  ): FinanceAttachmentVersionSubmission {
    validateFinanceAttachmentVersionDraft(draft);
    const scope = this.captureSubmissionScope();
    const idempotencyKey = (this.options.idempotencyKeyFactory ?? defaultIdempotencyKeyFactory)();
    requireNonBlank(idempotencyKey, "idempotencyKey");
    const frozenDraft = Object.freeze({
      attachmentId: draft.attachmentId,
      originalFilename: draft.originalFilename,
      declaredMediaType: draft.declaredMediaType,
      declaredSizeBytes: draft.declaredSizeBytes,
      ...(draft.expectedSha256 === undefined ? {} : { expectedSha256: draft.expectedSha256 })
    });
    const submission = Object.freeze({ draft: frozenDraft, idempotencyKey });
    this.submissionStatuses.set(submission, "READY");
    this.submissionScopes.set(submission, scope);
    return submission;
  }

  /** Freeze all sensitive form text and attachment IDs so uncertain retries reproduce the original request exactly. */
  public createWithdrawalSubmitSubmission(draft: WithdrawalSubmitDraft): WithdrawalSubmitSubmission {
    validateWithdrawalSubmitDraft(draft);
    const scope = this.captureSubmissionScope();
    const idempotencyKey = (this.options.idempotencyKeyFactory ?? defaultIdempotencyKeyFactory)();
    requireNonBlank(idempotencyKey, "idempotencyKey");
    const attachmentVersionIds = freezeAttachmentVersionIds(draft.attachmentVersionIds, 2);
    const frozenDraft = Object.freeze({
      documentId: draft.documentId,
      expectedVersion: draft.expectedVersion,
      sourceAccountId: draft.sourceAccountId,
      amountCents: draft.amountCents,
      recipientName: draft.recipientName,
      bankAccount: draft.bankAccount,
      ...(draft.bankName === undefined ? {} : { bankName: draft.bankName }),
      attachmentVersionIds
    });
    const submission = Object.freeze({ draft: frozenDraft, idempotencyKey });
    this.submissionStatuses.set(submission, "READY");
    this.submissionScopes.set(submission, scope);
    return submission;
  }

  public createWithdrawalRevokeSubmission(draft: WithdrawalRevokeDraft): WithdrawalRevokeSubmission {
    validateWithdrawalRevokeDraft(draft);
    const scope = this.captureSubmissionScope();
    const idempotencyKey = (this.options.idempotencyKeyFactory ?? defaultIdempotencyKeyFactory)();
    requireNonBlank(idempotencyKey, "idempotencyKey");
    const submission = Object.freeze({
      draft: Object.freeze({ documentId: draft.documentId, expectedVersion: draft.expectedVersion, reason: draft.reason }),
      idempotencyKey
    });
    this.submissionStatuses.set(submission, "READY");
    this.submissionScopes.set(submission, scope);
    return submission;
  }

  public createWithdrawalMarkTransferredSubmission(
    draft: WithdrawalMarkTransferredDraft
  ): WithdrawalMarkTransferredSubmission {
    validateWithdrawalMarkTransferredDraft(draft);
    const scope = this.captureSubmissionScope();
    const idempotencyKey = (this.options.idempotencyKeyFactory ?? defaultIdempotencyKeyFactory)();
    requireNonBlank(idempotencyKey, "idempotencyKey");
    const submission = Object.freeze({
      draft: Object.freeze({
        documentId: draft.documentId,
        expectedVersion: draft.expectedVersion,
        attachmentVersionIds: freezeAttachmentVersionIds(draft.attachmentVersionIds)
      }),
      idempotencyKey
    });
    this.submissionStatuses.set(submission, "READY");
    this.submissionScopes.set(submission, scope);
    return submission;
  }

  /** An automatic own-procurement transfer may only retry this exact frozen command. */
  public createSelfPurchaseSubmission(draft: SelfPurchaseSubmissionDraft): SelfPurchaseSubmission {
    validateSelfPurchaseDraft(draft);
    const scope = this.captureSubmissionScope();
    const idempotencyKey = (this.options.idempotencyKeyFactory ?? defaultIdempotencyKeyFactory)();
    requireNonBlank(idempotencyKey, "idempotencyKey");
    const submission = Object.freeze({
      draft: Object.freeze({
        documentId: draft.documentId,
        expectedVersion: draft.expectedVersion,
        amountCents: draft.amountCents,
        reason: draft.reason,
        attachmentVersionIds: freezeAttachmentVersionIds(draft.attachmentVersionIds, 2)
      }),
      idempotencyKey
    });
    this.submissionStatuses.set(submission, "READY");
    this.submissionScopes.set(submission, scope);
    return submission;
  }

  public createCompanyFundSubmission(draft: CompanyFundCreateDraft): CompanyFundCreateSubmission {
    validateCompanyFundCreateDraft(draft);
    this.requireCompanyFundAdministrator();
    const scope = this.captureSubmissionScope();
    const idempotencyKey = (this.options.idempotencyKeyFactory ?? defaultIdempotencyKeyFactory)();
    requireNonBlank(idempotencyKey, "idempotencyKey");
    const submission = Object.freeze({
      draft: Object.freeze({
        fundCode: draft.fundCode,
        displayName: draft.displayName,
        ...(draft.organizationUnitId === undefined ? {} : { organizationUnitId: draft.organizationUnitId })
      }),
      idempotencyKey
    });
    this.submissionStatuses.set(submission, "READY");
    this.submissionScopes.set(submission, scope);
    return submission;
  }

  public createCompanyFundAssignmentSubmission(
    draft: CompanyFundAssignmentDraft
  ): CompanyFundAssignmentSubmission {
    validateCompanyFundAssignmentDraft(draft);
    this.requireCompanyFundAdministrator();
    const scope = this.captureSubmissionScope();
    const idempotencyKey = (this.options.idempotencyKeyFactory ?? defaultIdempotencyKeyFactory)();
    requireNonBlank(idempotencyKey, "idempotencyKey");
    const submission = Object.freeze({
      draft: Object.freeze({ fundId: draft.fundId, expectedAssignmentId: draft.expectedAssignmentId, reason: draft.reason }),
      idempotencyKey
    });
    this.submissionStatuses.set(submission, "READY");
    this.submissionScopes.set(submission, scope);
    return submission;
  }

  public createCompanyFundStatusSubmission(draft: CompanyFundStatusDraft): CompanyFundStatusSubmission {
    validateCompanyFundStatusDraft(draft);
    this.requireCompanyFundAdministrator();
    const scope = this.captureSubmissionScope();
    const idempotencyKey = (this.options.idempotencyKeyFactory ?? defaultIdempotencyKeyFactory)();
    requireNonBlank(idempotencyKey, "idempotencyKey");
    const submission = Object.freeze({
      draft: Object.freeze({
        fundId: draft.fundId, expectedVersion: draft.expectedVersion, status: draft.status, reason: draft.reason
      }),
      idempotencyKey
    });
    this.submissionStatuses.set(submission, "READY");
    this.submissionScopes.set(submission, scope);
    return submission;
  }

  public submissionStatus(submission: Submission): SubmissionStatus {
    return this.submissionStatuses.get(submission) ?? "READY";
  }

  public async recordWeeklyFee<T = unknown>(submission: WeeklyFeeSubmission): Promise<T> {
    const previous = this.submissionStatus(submission);
    if (previous === "SUBMITTING") throw new SubmissionInProgressError();
    this.requireCurrentSubmissionScope(submission);
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

  public async createReferral(submission: ReferralCreationSubmission): Promise<ReferralCreationResult> {
    const previous = this.submissionStatus(submission);
    if (previous === "SUBMITTING") throw new SubmissionInProgressError();
    this.requireCurrentSubmissionScope(submission);
    this.submissionStatuses.set(submission, "SUBMITTING");
    try {
      const result = await this.authenticatedRequest<ReferralCreationResult>("POST", "/v1/referrals", {
        ...submission.draft,
        idempotencyKey: submission.idempotencyKey
      });
      this.submissionStatuses.set(submission, "SUCCEEDED");
      this.advanceResponseGeneration();
      return result;
    } catch (error) {
      this.submissionStatuses.set(submission, "FAILED");
      throw error;
    }
  }

  public async copyReferral(submission: ReferralCopySubmission): Promise<ReferralCopyResult> {
    const previous = this.submissionStatus(submission);
    if (previous === "SUBMITTING") throw new SubmissionInProgressError();
    this.requireCurrentSubmissionScope(submission);
    this.submissionStatuses.set(submission, "SUBMITTING");
    try {
      const result = await this.authenticatedRequest<ReferralCopyResult>(
        "POST",
        `/v1/referrals/${encodeURIComponent(submission.draft.sourceReferralId)}/copy`,
        {
          receiverPersonId: submission.draft.receiverPersonId,
          ...(submission.draft.courseContextId === undefined ? {} : { courseContextId: submission.draft.courseContextId }),
          ...(submission.draft.classType === undefined ? {} : { classType: submission.draft.classType }),
          idempotencyKey: submission.idempotencyKey
        }
      );
      this.submissionStatuses.set(submission, "SUCCEEDED");
      this.advanceResponseGeneration();
      return result;
    } catch (error) {
      this.submissionStatuses.set(submission, "FAILED");
      throw error;
    }
  }

  public async acceptReferral(submission: ReferralAcceptanceSubmission): Promise<ReferralAcceptanceResult> {
    const previous = this.submissionStatus(submission);
    if (previous === "SUBMITTING") throw new SubmissionInProgressError();
    this.requireCurrentSubmissionScope(submission);
    this.submissionStatuses.set(submission, "SUBMITTING");
    try {
      const body = {
        ...(submission.draft.venueId === undefined ? {} : { venueId: submission.draft.venueId }),
        expectedVersion: submission.draft.expectedVersion,
        idempotencyKey: submission.idempotencyKey
      };
      const result = await this.authenticatedRequest<ReferralAcceptanceResult>(
        "POST",
        `/v1/referrals/${encodeURIComponent(submission.draft.referralId)}/accept`,
        body
      );
      this.submissionStatuses.set(submission, "SUCCEEDED");
      this.advanceResponseGeneration();
      return result;
    } catch (error) {
      this.submissionStatuses.set(submission, "FAILED");
      throw error;
    }
  }

  public async changeReferralLifecycle(submission: ReferralLifecycleSubmission): Promise<ReferralLifecycleResult> {
    const previous = this.submissionStatus(submission);
    if (previous === "SUBMITTING") throw new SubmissionInProgressError();
    this.requireCurrentSubmissionScope(submission);
    this.submissionStatuses.set(submission, "SUBMITTING");
    try {
      const operation = submission.draft.command === "ARCHIVE" ? "archive" : "reactivate";
      const result = await this.authenticatedRequest<ReferralLifecycleResult>(
        "POST",
        `/v1/referrals/${encodeURIComponent(submission.draft.referralId)}/${operation}`,
        {
          expectedVersion: submission.draft.expectedVersion,
          idempotencyKey: submission.idempotencyKey
        }
      );
      this.submissionStatuses.set(submission, "SUCCEEDED");
      this.advanceResponseGeneration();
      return result;
    } catch (error) {
      this.submissionStatuses.set(submission, "FAILED");
      throw error;
    }
  }

  public async createFinanceDraft(submission: FinanceDraftSubmission): Promise<FinanceDraftCreateResult> {
    const previous = this.submissionStatus(submission);
    if (previous === "SUBMITTING") throw new SubmissionInProgressError();
    this.requireCurrentSubmissionScope(submission);
    this.submissionStatuses.set(submission, "SUBMITTING");
    try {
      const result = await this.authenticatedRequest<FinanceDraftCreateResult>("POST", "/v1/finance/drafts", {
        kind: submission.draft.kind,
        idempotencyKey: submission.idempotencyKey
      });
      this.submissionStatuses.set(submission, "SUCCEEDED");
      this.advanceResponseGeneration();
      return result;
    } catch (error) {
      this.submissionStatuses.set(submission, "FAILED");
      throw error;
    }
  }

  public async reserveFinanceAttachment(
    submission: FinanceAttachmentReservationSubmission
  ): Promise<FinanceAttachmentReservation> {
    const previous = this.submissionStatus(submission);
    if (previous === "SUBMITTING") throw new SubmissionInProgressError();
    this.requireCurrentSubmissionScope(submission);
    this.submissionStatuses.set(submission, "SUBMITTING");
    try {
      const result = await this.authenticatedRequest<FinanceAttachmentReservation>(
        "POST",
        `/v1/finance/drafts/${encodeURIComponent(submission.draft.documentId)}/attachment-uploads`,
        {
          purpose: submission.draft.purpose,
          originalFilename: submission.draft.originalFilename,
          declaredMediaType: submission.draft.declaredMediaType,
          declaredSizeBytes: submission.draft.declaredSizeBytes,
          ...(submission.draft.expectedSha256 === undefined ? {} : { expectedSha256: submission.draft.expectedSha256 }),
          idempotencyKey: submission.idempotencyKey
        }
      );
      this.submissionStatuses.set(submission, "SUCCEEDED");
      this.advanceResponseGeneration();
      return result;
    } catch (error) {
      this.submissionStatuses.set(submission, "FAILED");
      throw error;
    }
  }

  public async reserveFinanceAttachmentVersion(
    submission: FinanceAttachmentVersionSubmission
  ): Promise<FinanceAttachmentReservation> {
    const previous = this.submissionStatus(submission);
    if (previous === "SUBMITTING") throw new SubmissionInProgressError();
    this.requireCurrentSubmissionScope(submission);
    this.submissionStatuses.set(submission, "SUBMITTING");
    try {
      const result = await this.authenticatedRequest<FinanceAttachmentReservation>(
        "POST",
        `/v1/finance/attachments/${encodeURIComponent(submission.draft.attachmentId)}/versions`,
        {
          originalFilename: submission.draft.originalFilename,
          declaredMediaType: submission.draft.declaredMediaType,
          declaredSizeBytes: submission.draft.declaredSizeBytes,
          ...(submission.draft.expectedSha256 === undefined ? {} : { expectedSha256: submission.draft.expectedSha256 }),
          idempotencyKey: submission.idempotencyKey
        }
      );
      this.submissionStatuses.set(submission, "SUCCEEDED");
      this.advanceResponseGeneration();
      return result;
    } catch (error) {
      this.submissionStatuses.set(submission, "FAILED");
      throw error;
    }
  }

  public async submitWithdrawal(submission: WithdrawalSubmitSubmission): Promise<WithdrawalCommandResult> {
    const previous = this.submissionStatus(submission);
    if (previous === "SUBMITTING") throw new SubmissionInProgressError();
    this.requireCurrentSubmissionScope(submission);
    this.submissionStatuses.set(submission, "SUBMITTING");
    try {
      const result = await this.authenticatedRequest<WithdrawalCommandResult>(
        "POST",
        `/v1/finance/drafts/${encodeURIComponent(submission.draft.documentId)}/withdrawal-submit`,
        {
          expectedVersion: submission.draft.expectedVersion,
          sourceAccountId: submission.draft.sourceAccountId,
          amountCents: submission.draft.amountCents,
          recipientName: submission.draft.recipientName,
          bankAccount: submission.draft.bankAccount,
          ...(submission.draft.bankName === undefined ? {} : { bankName: submission.draft.bankName }),
          attachmentVersionIds: [...submission.draft.attachmentVersionIds],
          idempotencyKey: submission.idempotencyKey
        }
      );
      this.submissionStatuses.set(submission, "SUCCEEDED");
      this.advanceResponseGeneration();
      return result;
    } catch (error) {
      this.submissionStatuses.set(submission, "FAILED");
      throw error;
    }
  }

  public async revokeWithdrawal(submission: WithdrawalRevokeSubmission): Promise<WithdrawalCommandResult> {
    const previous = this.submissionStatus(submission);
    if (previous === "SUBMITTING") throw new SubmissionInProgressError();
    this.requireCurrentSubmissionScope(submission);
    this.submissionStatuses.set(submission, "SUBMITTING");
    try {
      const result = await this.authenticatedRequest<WithdrawalCommandResult>(
        "POST",
        `/v1/finance/withdrawals/${encodeURIComponent(submission.draft.documentId)}/finance-revoke`,
        {
          expectedVersion: submission.draft.expectedVersion,
          reason: submission.draft.reason,
          idempotencyKey: submission.idempotencyKey
        }
      );
      this.submissionStatuses.set(submission, "SUCCEEDED");
      this.advanceResponseGeneration();
      return result;
    } catch (error) {
      this.submissionStatuses.set(submission, "FAILED");
      throw error;
    }
  }

  public async markWithdrawalTransferred(
    submission: WithdrawalMarkTransferredSubmission
  ): Promise<WithdrawalCommandResult> {
    const previous = this.submissionStatus(submission);
    if (previous === "SUBMITTING") throw new SubmissionInProgressError();
    this.requireCurrentSubmissionScope(submission);
    this.submissionStatuses.set(submission, "SUBMITTING");
    try {
      const result = await this.authenticatedRequest<WithdrawalCommandResult>(
        "POST",
        `/v1/finance/withdrawals/${encodeURIComponent(submission.draft.documentId)}/mark-transferred`,
        {
          expectedVersion: submission.draft.expectedVersion,
          attachmentVersionIds: [...submission.draft.attachmentVersionIds],
          idempotencyKey: submission.idempotencyKey
        }
      );
      this.submissionStatuses.set(submission, "SUCCEEDED");
      this.advanceResponseGeneration();
      return result;
    } catch (error) {
      this.submissionStatuses.set(submission, "FAILED");
      throw error;
    }
  }

  public async submitSelfPurchase(submission: SelfPurchaseSubmission): Promise<SelfPurchaseResult> {
    const previous = this.submissionStatus(submission);
    if (previous === "SUBMITTING") throw new SubmissionInProgressError();
    this.requireCurrentSubmissionScope(submission);
    this.submissionStatuses.set(submission, "SUBMITTING");
    try {
      const result = await this.authenticatedRequest<SelfPurchaseResult>(
        "POST",
        `/v1/finance/drafts/${encodeURIComponent(submission.draft.documentId)}/self-purchase-submit`,
        {
          expectedVersion: submission.draft.expectedVersion,
          amountCents: submission.draft.amountCents,
          reason: submission.draft.reason,
          attachmentVersionIds: [...submission.draft.attachmentVersionIds],
          idempotencyKey: submission.idempotencyKey
        }
      );
      this.submissionStatuses.set(submission, "SUCCEEDED");
      this.advanceResponseGeneration();
      return result;
    } catch (error) {
      this.submissionStatuses.set(submission, "FAILED");
      throw error;
    }
  }

  public async createCompanyFund(submission: CompanyFundCreateSubmission): Promise<CompanyFundCommandResult> {
    return this.runCompanyFundCommand<CompanyFundCommandResult>(submission, "/v1/admin/company-funds", () => ({
      fundCode: submission.draft.fundCode,
      displayName: submission.draft.displayName,
      ...(submission.draft.organizationUnitId === undefined ? {} : { organizationUnitId: submission.draft.organizationUnitId }),
      idempotencyKey: submission.idempotencyKey
    }));
  }

  public async assignCompanyFund(
    submission: CompanyFundAssignmentSubmission
  ): Promise<CompanyFundAssignmentResult> {
    return this.runCompanyFundCommand<CompanyFundAssignmentResult>(submission, `/v1/admin/company-funds/${encodeURIComponent(submission.draft.fundId)}/assignment`, () => ({
      expectedAssignmentId: submission.draft.expectedAssignmentId,
      reason: submission.draft.reason,
      idempotencyKey: submission.idempotencyKey
    }));
  }

  public async setCompanyFundStatus(submission: CompanyFundStatusSubmission): Promise<CompanyFundCommandResult> {
    return this.runCompanyFundCommand<CompanyFundCommandResult>(submission, `/v1/admin/company-funds/${encodeURIComponent(submission.draft.fundId)}/status`, () => ({
      expectedVersion: submission.draft.expectedVersion,
      status: submission.draft.status,
      reason: submission.draft.reason,
      idempotencyKey: submission.idempotencyKey
    }));
  }

  private async runCompanyFundCommand<T>(
    submission: CompanyFundCreateSubmission | CompanyFundAssignmentSubmission | CompanyFundStatusSubmission,
    path: string,
    body: () => Record<string, unknown>
  ): Promise<T> {
    const previous = this.submissionStatus(submission);
    if (previous === "SUBMITTING") throw new SubmissionInProgressError();
    this.requireCurrentSubmissionScope(submission);
    this.requireCompanyFundAdministrator();
    this.submissionStatuses.set(submission, "SUBMITTING");
    try {
      const result = await this.authenticatedRequest<T>("POST", path, body());
      this.submissionStatuses.set(submission, "SUCCEEDED");
      this.advanceResponseGeneration();
      return result;
    } catch (error) {
      this.submissionStatuses.set(submission, "FAILED");
      throw error;
    }
  }

  /** This is an early UX guard; the server remains authoritative for active assignments. */
  private requireCompanyFundAdministrator(): void {
    const context = this.session?.currentRoleContext;
    if ((context?.subject !== "SYSTEM_ADMIN" && context?.subject !== "SYSTEM_OWNER")
      || context.scope !== "GLOBAL"
      || context.regionId !== undefined
      || context.campusId !== undefined
      || context.venueId !== undefined) {
      throw new ApiClientError(403, "FORBIDDEN_SCOPE");
    }
  }

  private requireAuthentication(): Authentication {
    if (this.session === null) throw new ApiClientError(401, "UNAUTHENTICATED");
    return { sessionId: this.session.sessionId, epoch: this.epoch };
  }

  private captureSubmissionScope(): SubmissionScope {
    const session = this.session;
    if (session === null) throw new ApiClientError(401, "UNAUTHENTICATED");
    return {
      sessionId: session.sessionId,
      accountId: session.accountId,
      personId: session.personId,
      roleSubject: session.currentRoleContext?.subject ?? null,
      rolePersonId: session.currentRoleContext?.personId ?? null,
      roleScope: session.currentRoleContext?.scope ?? null,
      roleRegionId: session.currentRoleContext?.regionId ?? null,
      roleCampusId: session.currentRoleContext?.campusId ?? null,
      roleVenueId: session.currentRoleContext?.venueId ?? null,
      epoch: this.submissionScopeEpoch
    };
  }

  private requireCurrentSubmissionScope(submission: Submission): void {
    const scope = this.submissionScopes.get(submission);
    const session = this.session;
    if (
      scope === undefined
      || session === null
      || scope.epoch !== this.submissionScopeEpoch
      || scope.sessionId !== session.sessionId
      || scope.accountId !== session.accountId
      || scope.personId !== session.personId
      || scope.roleSubject !== (session.currentRoleContext?.subject ?? null)
      || scope.rolePersonId !== (session.currentRoleContext?.personId ?? null)
      || scope.roleScope !== (session.currentRoleContext?.scope ?? null)
      || scope.roleRegionId !== (session.currentRoleContext?.regionId ?? null)
      || scope.roleCampusId !== (session.currentRoleContext?.campusId ?? null)
      || scope.roleVenueId !== (session.currentRoleContext?.venueId ?? null)
    ) {
      this.submissionStatuses.set(submission, "FAILED");
      throw new StaleResponseError();
    }
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
    if (!sameSubmissionScope(this.session, session)) this.submissionScopeEpoch += 1;
    this.session = session;
    this.epoch += 1;
  }

  private clearSessionState(): void {
    this.session = null;
    this.epoch += 1;
    this.submissionScopeEpoch += 1;
  }

  private clearRoleState(): void {
    if (this.session !== null) {
      this.session = { ...this.session, currentRoleContext: null };
    }
    this.epoch += 1;
    this.submissionScopeEpoch += 1;
  }

  /** A successful write may change overview values and record versions, so earlier reads become stale. */
  private advanceResponseGeneration(): void {
    this.epoch += 1;
  }
}
