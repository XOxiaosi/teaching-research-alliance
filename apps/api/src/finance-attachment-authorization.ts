import type { PermissionScope, RoleContext } from "@teaching-research-alliance/contracts";
import { financeYearBounds } from "./finance-year.js";

export const FINANCE_ATTACHMENT_PURPOSES = [
  "SUPPORTING_DOCUMENT",
  "APPLICATION_SCREENSHOT",
  "INVOICE",
  "PAYMENT_RECEIPT"
] as const;

export const FINANCE_ATTACHMENT_MEDIA_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;

export type FinanceAttachmentPurpose = (typeof FINANCE_ATTACHMENT_PURPOSES)[number];
export type FinanceAttachmentMediaType = (typeof FINANCE_ATTACHMENT_MEDIA_TYPES)[number];

export type FinanceAttachmentDocumentState = Readonly<{
  applicantPersonId: string;
  kind: string;
  status: string;
}>;

export type FinanceAttachmentVersionAuthorization = FinanceAttachmentDocumentState & Readonly<{
  purpose: FinanceAttachmentPurpose;
  createdByPersonId: string;
  uploadedByPersonId: string;
}>;

type ScopedRoleContext = RoleContext & Readonly<{ scope?: PermissionScope }>;

const personalSubjects = ["TEACHING_TEACHER", "ACADEMIC_PLANNER", "PLANNING_MENTOR"] as const;

export const isPersonalAttachmentContext = (context: RoleContext): boolean =>
  personalSubjects.includes(context.subject as (typeof personalSubjects)[number]);

/** Global financial access must carry an explicit GLOBAL scope and no narrower resource identifier. */
export const hasStrictGlobalScope = (context: RoleContext): boolean => {
  const scoped = context as ScopedRoleContext;
  return scoped.scope === "GLOBAL"
    && context.regionId === undefined
    && context.campusId === undefined
    && context.venueId === undefined;
};

export const isHeadquartersFinanceGlobal = (context: RoleContext): boolean =>
  context.subject === "HEADQUARTERS_FINANCE" && hasStrictGlobalScope(context);

export const isGlobalAttachmentReader = (context: RoleContext): boolean =>
  hasStrictGlobalScope(context)
  && (context.subject === "HEADQUARTERS_FINANCE" || context.subject === "SYSTEM_ADMIN" || context.subject === "SYSTEM_OWNER");

export const isReceiptPurpose = (purpose: FinanceAttachmentPurpose): boolean => purpose === "PAYMENT_RECEIPT";

export const canReserveFinanceAttachment = (
  context: RoleContext,
  document: FinanceAttachmentDocumentState,
  purpose: FinanceAttachmentPurpose
): boolean => {
  if (isPersonalAttachmentContext(context)) {
    return !isReceiptPurpose(purpose)
      && document.applicantPersonId === context.personId
      && document.status === "DRAFT";
  }
  return isHeadquartersFinanceGlobal(context)
    && isReceiptPurpose(purpose)
    && document.kind === "WITHDRAWAL"
    && document.status === "PENDING_TRANSFER";
};

/** Retrying a reservation needs both the original actor and the current action permission. */
export const canReplayFinanceAttachmentReservation = (
  context: RoleContext,
  version: FinanceAttachmentVersionAuthorization
): boolean =>
  version.createdByPersonId === context.personId
  && version.uploadedByPersonId === context.personId
  && canReserveFinanceAttachment(context, version, version.purpose);

/** Only the actor who reserved the still-actionable attachment version may upload its original. */
export const canUploadFinanceAttachment = (
  context: RoleContext,
  version: FinanceAttachmentVersionAuthorization
): boolean =>
  version.uploadedByPersonId === context.personId
  && canReserveFinanceAttachment(context, version, version.purpose);

export const canReadFinanceAttachment = (
  context: RoleContext,
  document: FinanceAttachmentDocumentState
): boolean =>
  isGlobalAttachmentReader(context)
  || (isPersonalAttachmentContext(context) && document.applicantPersonId === context.personId);

/** Personal attachment access is confined to the Beijing financial year containing `at`. */
export const isWithinPersonalFinanceYear = (businessAt: string, at: Date): boolean => {
  const businessTime = new Date(businessAt).getTime();
  if (!Number.isFinite(businessTime)) throw new Error("FINANCE_ATTACHMENT_PERSISTENCE_INVALID:businessAt");
  const bounds = financeYearBounds(at);
  return businessTime >= new Date(bounds.start).getTime() && businessTime < new Date(bounds.end).getTime();
};
