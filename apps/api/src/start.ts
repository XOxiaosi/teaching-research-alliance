import { PostgresReferralCreationService } from "./postgres-referral-creation-service.js";
import { PostgresSentReferralReadService } from "./postgres-sent-referral-read-service.js";
import { PostgresReferralAcceptanceService } from "./postgres-referral-acceptance-service.js";
import { PostgresReferralLifecycleService } from "./postgres-referral-lifecycle-service.js";
import { createApiServer } from "./http-server.js";
import { createPostgresPool } from "./postgres-pool.js";
import { PostgresSessionService } from "./postgres-session-service.js";
import { PostgresPersonalReadService } from "./postgres-personal-read-service.js";
import { PostgresWeeklyFeeService } from "./postgres-weekly-fee-service.js";
import { PostgresTeachingReadService } from "./postgres-teaching-read-service.js";

const port = Number(process.env.PORT ?? "3100");
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("INVALID_PORT");
const pool = createPostgresPool();
const server = createApiServer({
  sessions: new PostgresSessionService(pool),
  weeklyFees: new PostgresWeeklyFeeService(pool),
  personal: new PostgresPersonalReadService(pool),
  teaching: new PostgresTeachingReadService(pool),
  referrals: new PostgresReferralCreationService(pool),
  sentReferrals: new PostgresSentReferralReadService(pool),
  referralAcceptance: new PostgresReferralAcceptanceService(pool),
  referralLifecycle: new PostgresReferralLifecycleService(pool),
  now: () => new Date()
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Local API listening at http://127.0.0.1:${port}`);
});
let closing = false;
const close = (): void => {
  if (closing) return;
  closing = true;
  server.close(() => { void pool.end(); });
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
