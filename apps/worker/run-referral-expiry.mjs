import { setTimeout as wait } from "node:timers/promises";
import { createPostgresPool } from "../api/dist/postgres-pool.js";
import { PostgresReferralExpiryService } from "../api/dist/postgres-referral-expiry-service.js";

// One worker can run repeatedly; database row locks permit multiple workers safely.
const once = process.argv.includes("--once");
const intervalMs = Number(process.env.REFERRAL_EXPIRY_INTERVAL_MS ?? 60000);
if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 3600000) {
  throw new Error("INVALID_REFERRAL_EXPIRY_INTERVAL");
}
const pool = createPostgresPool();
const service = new PostgresReferralExpiryService(pool);
const stopping = new AbortController();
const stop = () => stopping.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  do {
    try {
      let batch;
      do {
        batch = await service.run(new Date(), 100);
        if (batch.archivedReferralIds.length) console.log(JSON.stringify({job:"REFERRAL_EXPIRY",archivedCount:batch.archivedReferralIds.length}));
      } while (batch.archivedReferralIds.length === 100 && !stopping.signal.aborted);
    } catch (error) {
      // Do not print SQL, connection credentials, or student records to job logs.
      console.error("REFERRAL_EXPIRY_FAILED");
      if (once) { process.exitCode = 1; break; }
    }
    if (once || stopping.signal.aborted) break;
    await wait(intervalMs, undefined, {signal:stopping.signal}).catch(error=>{
      if(error.name!=="AbortError")throw error;
    });
  } while (!stopping.signal.aborted);
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  await pool.end();
}
