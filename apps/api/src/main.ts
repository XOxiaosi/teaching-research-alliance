export const serviceName = "teaching-research-alliance-api";

export const health = (): Readonly<{ service: string; status: "ok" }> => ({
  service: serviceName,
  status: "ok"
});

export { SessionService } from "./session-service.js";
export { WeeklyFeeService } from "./weekly-fee-service.js";
