export const serviceName = "teaching-research-alliance-api";

export const health = (): Readonly<{ service: string; status: "ok" }> => ({
  service: serviceName,
  status: "ok",
});

export { SessionService } from "./session-service.js";
export { WeeklyFeeService } from "./weekly-fee-service.js";
export { handleRequest } from "./http-handler.js";
export { PostgresLedgerRepository } from "./postgres-ledger-repository.js";
export { createPostgresPool } from "./postgres-pool.js";
export { createApiServer } from "./http-server.js";
export { SettlementPostingService } from "./settlement-posting-service.js";
export { PostgresIdentityRepository } from "./postgres-identity-repository.js";
export { PostgresWeeklySettlementService } from "./postgres-weekly-settlement-service.js";
export { PostgresWeeklyFeeService } from "./postgres-weekly-fee-service.js";
export { PostgresPersonalReadService } from "./postgres-personal-read-service.js";

export { PostgresSessionService } from "./postgres-session-service.js";
export { hashPassword, verifyPassword } from "./password.js";
export { PostgresTeachingReadService } from "./postgres-teaching-read-service.js";
export { PostgresReferralCreationService } from "./postgres-referral-creation-service.js";
export { PostgresSentReferralReadService } from "./postgres-sent-referral-read-service.js";
export { PostgresReferralAcceptanceService } from "./postgres-referral-acceptance-service.js";
export { PostgresReferralExpiryService } from "./postgres-referral-expiry-service.js";
export { PostgresReferralLifecycleService } from "./postgres-referral-lifecycle-service.js";
export { PostgresFinanceDraftService } from "./postgres-finance-draft-service.js";
export { PostgresFinanceAttachmentService } from "./postgres-finance-attachment-service.js";

export { PostgresFinanceAttachmentUploadService } from "./postgres-finance-attachment-upload-service.js";
export { PostgresFinanceAttachmentReadService } from "./postgres-finance-attachment-read-service.js";
export { LocalAttachmentStore } from "./local-attachment-store.js";
export { FinanceSensitiveFieldCrypto } from "./finance-sensitive-field-crypto.js";
export { PostgresWithdrawalService } from "./postgres-withdrawal-service.js";
export { PostgresWithdrawalReadService } from "./postgres-withdrawal-read-service.js";
export { PostgresCompanyFundService } from "./postgres-company-fund-service.js";
export { PostgresBonusProjectCatalogService } from "./postgres-bonus-project-catalog-service.js";
export { PostgresSelfPurchaseService } from "./postgres-self-purchase-service.js";
export { PostgresSelfPurchaseReversalService } from "./postgres-self-purchase-reversal-service.js";
export { PostgresSelfPurchaseReadService } from "./postgres-self-purchase-read-service.js";
export { PostgresReimbursementSubmissionService } from "./postgres-reimbursement-submission-service.js";
export { PostgresReimbursementReviewService } from "./postgres-reimbursement-review-service.js";
export { PostgresReimbursementReadService } from "./postgres-reimbursement-read-service.js";
export { PostgresReimbursementTransferService } from "./postgres-reimbursement-transfer-service.js";
export { PostgresReimbursementReversalService } from "./postgres-reimbursement-reversal-service.js";

export { PostgresRefundSubmissionService } from "./postgres-refund-submission-service.js";
export { PostgresRefundReviewService } from "./postgres-refund-review-service.js";
export { PostgresRefundReadService } from "./postgres-refund-read-service.js";
export { PostgresVenueService } from "./postgres-venue-service.js";
export { PostgresVenueReadService } from "./postgres-venue-read-service.js";
export { PostgresVenueBoardReadService } from "./postgres-venue-board-read-service.js";
export { PostgresSalaryBenefitsService } from "./postgres-salary-benefits-service.js";
export { PostgresCashWageReadService } from "./postgres-cash-wage-read-service.js";
export { PostgresCashWageTeacherDirectoryService } from "./postgres-cash-wage-teacher-directory-service.js";
export { PostgresGroupLeaderRelationshipService } from "./postgres-group-leader-relationship-service.js";
export { PostgresGroupLeaderDirectoryService } from "./postgres-group-leader-directory-service.js";

export { PostgresOrganizationRevenueReadService } from "./postgres-organization-revenue-read-service.js";

export { PostgresBenefitReadService } from "./postgres-benefit-read-service.js";
export { PostgresBenefitSourceFundDirectoryService } from "./postgres-benefit-source-fund-directory-service.js";
export { PostgresBenefitTodoSchedulerService } from "./postgres-benefit-todo-scheduler-service.js";
