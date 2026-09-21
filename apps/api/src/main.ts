export const serviceName = "teaching-research-alliance-api";

export const health = (): Readonly<{ service: string; status: "ok" }> => ({
  service: serviceName,
  status: "ok"
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
