import {
  generateDueBenefitTodosInTransaction,
  resolveBenefitGenerationDate,
} from "./postgres-benefit-todo-generator.js";
import type { PostgresPool } from "./postgres-ledger-repository.js";

export type BenefitTodoGenerationRun = Readonly<{
  month: string;
  day: number;
  generatedCount: number;
}>;

/** Internal system entrypoint. It has no personal RoleContext and never posts ledger entries. */
export class PostgresBenefitTodoSchedulerService {
  public constructor(private readonly pool: PostgresPool) {}

  public async run(at: Date): Promise<BenefitTodoGenerationRun> {
    const schedule = resolveBenefitGenerationDate(at);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const generated = await generateDueBenefitTodosInTransaction(
        client,
        at,
        schedule,
      );
      await client.query("COMMIT");
      return {
        month: schedule.month,
        day: schedule.day,
        generatedCount: generated.length,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.release();
    }
  }
}
