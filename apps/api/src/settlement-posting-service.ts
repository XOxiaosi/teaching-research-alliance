import {
  allocationDelta,
  postLedgerEvent,
  type AllocationLine,
  type LedgerPostResult,
  type LedgerRepository
} from "@teaching-research-alliance/domain";

export type SettlementSnapshot = Readonly<{
  lines: readonly AllocationLine[];
  accountByKey: Readonly<Record<string, string>>;
}>;

export type SettlementPostCommand = Readonly<{
  eventKey: string;
  payloadHash: string;
  previous?: SettlementSnapshot;
  next: SettlementSnapshot;
  eventType?: string;
}>;

/** 将周费用新旧分配快照转换成账本差额，并以事件幂等方式提交。 */
export class SettlementPostingService {
  public constructor(
    private readonly repository: LedgerRepository,
    private readonly eventIdFactory?: () => string
  ) {}

  public post(command: SettlementPostCommand): Promise<LedgerPostResult> {
    const previous = command.previous ?? { lines: [], accountByKey: {} };
    const deltas = allocationDelta(
      previous.lines,
      command.next.lines,
      previous.accountByKey,
      command.next.accountByKey
    );
    return postLedgerEvent(this.repository, {
      eventKey: command.eventKey,
      eventType: command.eventType ?? "WEEKLY_FEE_SETTLEMENT",
      payloadHash: command.payloadHash,
      deltas
    }, this.eventIdFactory);
  }
}
