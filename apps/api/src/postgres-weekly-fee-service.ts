import type { RoleContext } from "@teaching-research-alliance/contracts";
import type { WeeklyFeeDraft } from "@teaching-research-alliance/domain";
import type { WeeklyFeeApiService } from "./http-handler.js";
import type { PostgresPool } from "./postgres-ledger-repository.js";
import { PostgresWeeklyFeeRepository } from "./postgres-weekly-fee-repository.js";
import { PostgresWeeklySettlementService } from "./postgres-weekly-settlement-service.js";

const assertTeacherContext = (context: RoleContext): void => {
  if (context.subject !== "TEACHING_TEACHER") throw new Error("FORBIDDEN_SCOPE");
};

/**
 * 把HTTP会话中的教师职责接到PostgreSQL周费用与结算事务。
 * 操作人只来自服务端RoleContext，不接受请求体中的personId。
 */
export class PostgresWeeklyFeeService implements WeeklyFeeApiService {
  private readonly fees: PostgresWeeklyFeeRepository;
  private readonly settlements: PostgresWeeklySettlementService;

  public constructor(pool: PostgresPool) {
    this.fees = new PostgresWeeklyFeeRepository(pool);
    this.settlements = new PostgresWeeklySettlementService(pool);
  }

  public async acceptReferral(context: RoleContext, referralId: string): Promise<unknown> {
    assertTeacherContext(context);
    return this.fees.acceptReferral(referralId, context.personId);
  }

  public async recordWeeklyFee(
    context: RoleContext,
    draft: WeeklyFeeDraft,
    idempotencyKey: string
  ): Promise<unknown> {
    assertTeacherContext(context);
    const result = await this.settlements.recordAndSettle(context.personId, draft, idempotencyKey);
    return {
      fee: result.fee,
      runId: result.runId,
      status: result.status,
      replay: result.replay
    };
  }
}
