import { PostgresBenefitReadService } from "./postgres-benefit-read-service.js";
import { PostgresBenefitSourceFundDirectoryService } from "./postgres-benefit-source-fund-directory-service.js";
import { PostgresOrganizationRevenueReadService } from "./postgres-organization-revenue-read-service.js";
import { PostgresRefundSubmissionService } from "./postgres-refund-submission-service.js";
import { PostgresRefundReviewService } from "./postgres-refund-review-service.js";
import { PostgresRefundReadService } from "./postgres-refund-read-service.js";
import { PostgresReimbursementSubmissionService } from "./postgres-reimbursement-submission-service.js";
import { PostgresReimbursementReviewService } from "./postgres-reimbursement-review-service.js";
import { PostgresReimbursementReadService } from "./postgres-reimbursement-read-service.js";
import { PostgresReimbursementTransferService } from "./postgres-reimbursement-transfer-service.js";
import { fileURLToPath } from "node:url";
import { LocalAttachmentStore } from "./local-attachment-store.js";
import { PostgresFinanceAttachmentUploadService } from "./postgres-finance-attachment-upload-service.js";
import { PostgresFinanceAttachmentReadService } from "./postgres-finance-attachment-read-service.js";
import { FinanceSensitiveFieldCrypto } from "./finance-sensitive-field-crypto.js";
import { PostgresWithdrawalService } from "./postgres-withdrawal-service.js";
import { PostgresWithdrawalReadService } from "./postgres-withdrawal-read-service.js";
import { PostgresReferralCreationService } from "./postgres-referral-creation-service.js";
import { PostgresSentReferralReadService } from "./postgres-sent-referral-read-service.js";
import { PostgresReferralAcceptanceService } from "./postgres-referral-acceptance-service.js";
import { PostgresReferralLifecycleService } from "./postgres-referral-lifecycle-service.js";
import { PostgresFinanceDraftService } from "./postgres-finance-draft-service.js";
import { PostgresCompanyFundService } from "./postgres-company-fund-service.js";
import { PostgresBonusProjectCatalogService } from "./postgres-bonus-project-catalog-service.js";
import { PostgresSelfPurchaseService } from "./postgres-self-purchase-service.js";
import { PostgresSelfPurchaseReversalService } from "./postgres-self-purchase-reversal-service.js";
import { PostgresSelfPurchaseReadService } from "./postgres-self-purchase-read-service.js";
import { PostgresFinanceAttachmentService } from "./postgres-finance-attachment-service.js";
import { createApiServer } from "./http-server.js";
import { createPostgresPool } from "./postgres-pool.js";
import { PostgresSessionService } from "./postgres-session-service.js";
import { PostgresPersonalReadService } from "./postgres-personal-read-service.js";
import { PostgresWeeklyFeeService } from "./postgres-weekly-fee-service.js";
import { PostgresTeachingReadService } from "./postgres-teaching-read-service.js";
import { PostgresVenueService } from "./postgres-venue-service.js";
import { PostgresVenueReadService } from "./postgres-venue-read-service.js";
import { PostgresVenueBoardReadService } from "./postgres-venue-board-read-service.js";
import { PostgresSalaryBenefitsService } from "./postgres-salary-benefits-service.js";
import { PostgresCashWageReadService } from "./postgres-cash-wage-read-service.js";
import { PostgresCashWageTeacherDirectoryService } from "./postgres-cash-wage-teacher-directory-service.js";

const port = Number(process.env.PORT ?? "3100");
if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
  throw new Error("INVALID_PORT");
const attachmentRoot = process.env.FINANCE_ATTACHMENT_ROOT;
const attachmentStore = attachmentRoot
  ? await LocalAttachmentStore.create(
      attachmentRoot,
      fileURLToPath(new URL("../../../", import.meta.url)),
    )
  : undefined;
let financeCrypto: FinanceSensitiveFieldCrypto | undefined;
if (process.env.FINANCE_KEY_RING_JSON) {
  try {
    const config = JSON.parse(process.env.FINANCE_KEY_RING_JSON) as {
      activeKeyId: string;
      keys: Record<string, string>;
    };
    financeCrypto = new FinanceSensitiveFieldCrypto(
      config.activeKeyId,
      config.keys,
    );
  } catch {
    throw new Error("FINANCE_KEY_CONFIG_INVALID");
  }
}
const pool = createPostgresPool();
const server = createApiServer({
  organizationRevenue: new PostgresOrganizationRevenueReadService(pool),
  sessions: new PostgresSessionService(pool),
  weeklyFees: new PostgresWeeklyFeeService(pool),
  personal: new PostgresPersonalReadService(pool),
  teaching: new PostgresTeachingReadService(pool),
  venues: new PostgresVenueService(pool),
  venueReads: new PostgresVenueReadService(pool),
  venueBoards: new PostgresVenueBoardReadService(pool),
  referrals: new PostgresReferralCreationService(pool),
  sentReferrals: new PostgresSentReferralReadService(pool),
  referralAcceptance: new PostgresReferralAcceptanceService(pool),
  referralLifecycle: new PostgresReferralLifecycleService(pool),
  financeDrafts: new PostgresFinanceDraftService(pool),
  companyFunds: new PostgresCompanyFundService(pool),
  bonusProjects: new PostgresBonusProjectCatalogService(pool),
  refundReads: new PostgresRefundReadService(pool),
  ...(attachmentStore
    ? {
        refunds: new PostgresRefundSubmissionService(pool, attachmentStore),
        refundReviews: new PostgresRefundReviewService(pool, attachmentStore),
      }
    : {}),
  reimbursementReads: new PostgresReimbursementReadService(pool),
  ...(attachmentStore
    ? {
        reimbursements: new PostgresReimbursementSubmissionService(
          pool,
          attachmentStore,
        ),
        reimbursementReviews: new PostgresReimbursementReviewService(
          pool,
          attachmentStore,
        ),
        reimbursementTransfers: new PostgresReimbursementTransferService(
          pool,
          attachmentStore,
        ),
      }
    : {}),
  selfPurchaseReads: new PostgresSelfPurchaseReadService(pool),
  selfPurchaseReversals: new PostgresSelfPurchaseReversalService(pool),
  ...(attachmentStore
    ? { selfPurchases: new PostgresSelfPurchaseService(pool, attachmentStore) }
    : {}),
  ...(attachmentStore
    ? {
        salaryBenefits: new PostgresSalaryBenefitsService(
          pool,
          attachmentStore,
        ),
      }
    : {}),
  benefitReads: new PostgresBenefitReadService(pool),
  benefitSourceFunds: new PostgresBenefitSourceFundDirectoryService(pool),
  cashWageReads: new PostgresCashWageReadService(pool),
  cashWageTeacherDirectory: new PostgresCashWageTeacherDirectoryService(pool),
  financeAttachments: new PostgresFinanceAttachmentService(pool),
  ...(attachmentStore
    ? {
        financeAttachmentUploads: new PostgresFinanceAttachmentUploadService(
          pool,
          attachmentStore,
        ),
        financeAttachmentReads: new PostgresFinanceAttachmentReadService(
          pool,
          attachmentStore,
        ),
      }
    : {}),
  ...(financeCrypto && attachmentStore
    ? {
        withdrawals: new PostgresWithdrawalService(
          pool,
          attachmentStore,
          financeCrypto,
        ),
        withdrawalReads: new PostgresWithdrawalReadService(pool, financeCrypto),
      }
    : {}),
  now: () => new Date(),
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Local API listening at http://127.0.0.1:${port}`);
});
let closing = false;
const close = (): void => {
  if (closing) return;
  closing = true;
  server.close(() => {
    void pool.end();
  });
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
