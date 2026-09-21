import type { Cents } from "./index.js";
import type { LedgerDelta } from "./ledger.js";

export type LedgerEventRecord = Readonly<{
  eventId: string;
  eventKey: string;
  eventType: string;
  payloadHash: string;
  deltas: readonly LedgerDelta[];
}>;

export type LedgerTransaction = Readonly<{
  findEvent: (eventKey: string) => LedgerEventRecord | undefined;
  insertEvent: (event: LedgerEventRecord) => void;
  getBalance: (accountKey: string) => Cents;
  applyBalance: (accountKey: string, amountCents: Cents) => void;
}>;

export type LedgerRepository = Readonly<{
  transaction: <T>(work: (transaction: LedgerTransaction) => Promise<T>) => Promise<T>;
}>;

export type LedgerPostCommand = Readonly<{
  eventKey: string;
  eventType: string;
  payloadHash: string;
  deltas: readonly LedgerDelta[];
}>;

export type LedgerPostResult = Readonly<{
  status: "POSTED" | "REPLAY";
  event: LedgerEventRecord;
  balances: Readonly<Record<string, Cents>>;
}>;

const defaultEventIdFactory = (() => {
  let sequence = 0;
  return (): string => `ledger-event-synthetic-${++sequence}`;
})();

const normalizeDeltas = (deltas: readonly LedgerDelta[]): readonly LedgerDelta[] => {
  const aggregate = new Map<string, LedgerDelta>();
  for (const delta of deltas) {
    if (delta.accountKey.trim() === "") throw new Error("MISSING_ACCOUNT_MAPPING");
    if (delta.categoryKey.trim() === "") throw new Error("LEDGER_CATEGORY_REQUIRED");
    if (delta.amountCents === 0n) continue;
    const key = `${delta.accountKey}:${delta.categoryKey}`;
    const current = aggregate.get(key);
    aggregate.set(key, {
      accountKey: delta.accountKey,
      categoryKey: delta.categoryKey,
      amountCents: (current?.amountCents ?? 0n) + delta.amountCents
    });
  }
  return [...aggregate.values()]
    .filter((delta) => delta.amountCents !== 0n)
    .sort((left, right) => `${left.accountKey}:${left.categoryKey}`.localeCompare(`${right.accountKey}:${right.categoryKey}`));
};

const samePayload = (left: LedgerEventRecord, right: LedgerEventRecord): boolean =>
  left.payloadHash === right.payloadHash &&
  JSON.stringify(left.deltas.map((delta) => ({
    accountKey: delta.accountKey,
    categoryKey: delta.categoryKey,
    amountCents: delta.amountCents.toString()
  }))) === JSON.stringify(right.deltas.map((delta) => ({
    accountKey: delta.accountKey,
    categoryKey: delta.categoryKey,
    amountCents: delta.amountCents.toString()
  })));

export const postLedgerEvent = async (
  repository: LedgerRepository,
  command: LedgerPostCommand,
  eventIdFactory: () => string = defaultEventIdFactory
): Promise<LedgerPostResult> => {
  if (command.eventKey.trim() === "") throw new Error("LEDGER_EVENT_KEY_REQUIRED");
  if (command.eventType.trim() === "") throw new Error("LEDGER_EVENT_TYPE_REQUIRED");
  if (command.payloadHash.trim() === "") throw new Error("LEDGER_PAYLOAD_HASH_REQUIRED");
  const deltas = normalizeDeltas(command.deltas);
  if (deltas.length === 0) throw new Error("LEDGER_EMPTY_EVENT");

  return repository.transaction(async (transaction) => {
    const existing = transaction.findEvent(command.eventKey);
    const candidate: LedgerEventRecord = {
      eventId: existing?.eventId ?? eventIdFactory(),
      eventKey: command.eventKey,
      eventType: command.eventType,
      payloadHash: command.payloadHash,
      deltas
    };
    if (existing !== undefined) {
      if (!samePayload(existing, candidate) || existing.eventType !== command.eventType) {
        throw new Error("LEDGER_EVENT_CONFLICT");
      }
      const balances: Record<string, Cents> = {};
      for (const delta of existing.deltas) balances[delta.accountKey] = transaction.getBalance(delta.accountKey);
      return { status: "REPLAY", event: existing, balances };
    }

    transaction.insertEvent(candidate);
    const balances: Record<string, Cents> = {};
    for (const delta of deltas) {
      transaction.applyBalance(delta.accountKey, delta.amountCents);
      balances[delta.accountKey] = transaction.getBalance(delta.accountKey);
    }
    return { status: "POSTED", event: candidate, balances };
  });
};

export class MemoryLedgerRepository implements LedgerRepository {
  private events = new Map<string, LedgerEventRecord>();
  private balances = new Map<string, Cents>();

  public async transaction<T>(work: (transaction: LedgerTransaction) => Promise<T>): Promise<T> {
    const events = new Map(this.events);
    const balances = new Map(this.balances);
    const transaction: LedgerTransaction = {
      findEvent: (eventKey) => events.get(eventKey),
      insertEvent: (event) => {
        if (events.has(event.eventKey)) throw new Error("LEDGER_EVENT_CONFLICT");
        events.set(event.eventKey, event);
      },
      getBalance: (accountKey) => balances.get(accountKey) ?? 0n,
      applyBalance: (accountKey, amountCents) => balances.set(accountKey, (balances.get(accountKey) ?? 0n) + amountCents)
    };
    const result = await work(transaction);
    this.events = events;
    this.balances = balances;
    return result;
  }

  public findEvent(eventKey: string): LedgerEventRecord | undefined {
    return this.events.get(eventKey);
  }

  public getBalance(accountKey: string): Cents {
    return this.balances.get(accountKey) ?? 0n;
  }
}
