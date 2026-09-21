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
