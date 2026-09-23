import { setTimeout as wait } from "node:timers/promises";
import { createPostgresPool } from "../api/dist/postgres-pool.js";
import { PostgresBenefitTodoSchedulerService } from "../api/dist/postgres-benefit-todo-scheduler-service.js";

const once = process.argv.includes("--once");
const intervalMs = Number(process.env.BENEFIT_TODO_GENERATION_INTERVAL_MS ?? 60000);
if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 3600000) {
  console.error("BENEFIT_TODO_GENERATION_CONFIG_INVALID");
  process.exitCode = 1;
} else {
  let pool;
  let stopping;
  let stop;
  let failureReported = false;
  const reportFailure = (fatal = false) => {
    if (!failureReported) {
      failureReported = true;
      console.error("BENEFIT_TODO_GENERATION_FAILED");
    }
    if (fatal) process.exitCode = 1;
  };
  try {
    pool = createPostgresPool();
    const service = new PostgresBenefitTodoSchedulerService(pool);
    stopping = new AbortController();
    stop = () => stopping.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      do {
        try {
          const result = await service.run(new Date());
          if (result.generatedCount > 0) {
            console.log(JSON.stringify({
              job: "BENEFIT_TODO_GENERATION",
              month: result.month,
              day: result.day,
              generatedCount: result.generatedCount,
            }));
          }
        } catch {
          reportFailure(once);
          if (once) break;
        }
        if (once || stopping.signal.aborted) break;
        await wait(intervalMs, undefined, { signal: stopping.signal }).catch((error) => {
          if (error?.name !== "AbortError") throw error;
        });
      } while (!stopping.signal.aborted);
    } catch {
      reportFailure(true);
    }
  } catch {
    reportFailure(true);
  } finally {
    if (stop) {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
    if (pool) {
      try {
        await pool.end();
      } catch {
        reportFailure(true);
      }
    }
  }
}
