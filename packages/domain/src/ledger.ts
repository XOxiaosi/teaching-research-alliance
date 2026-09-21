import type { AllocationLine, Cents } from "./index.js";

export type LedgerDelta = Readonly<{
  accountKey: string;
  categoryKey: string;
  amountCents: Cents;
}>;

export type LedgerEvent = Readonly<{
  eventId: string;
  deltas: readonly LedgerDelta[];
}>;

export const allocationDelta = (
  previous: readonly AllocationLine[],
  next: readonly AllocationLine[],
  previousAccountByKey: Readonly<Record<string, string>>,
  nextAccountByKey: Readonly<Record<string, string>> = previousAccountByKey
): readonly LedgerDelta[] => {
  const previousByKey = new Map(previous.map((line) => [line.key, line.cents]));
  const nextByKey = new Map(next.map((line) => [line.key, line.cents]));
  const keys = [...new Set([...previousByKey.keys(), ...nextByKey.keys()])];
  const deltas = new Map<string, LedgerDelta>();
  const append = (categoryKey: string, accountKey: string | undefined, amountCents: Cents): void => {
    if (accountKey === undefined || accountKey.trim() === "") throw new Error("MISSING_ACCOUNT_MAPPING");
    const key = `${accountKey}:${categoryKey}`;
    const previous = deltas.get(key);
    deltas.set(key, {
      accountKey,
      categoryKey,
      amountCents: (previous?.amountCents ?? 0n) + amountCents
    });
  };
  for (const key of keys) {
    const previousAmount = previousByKey.get(key) ?? 0n;
    const nextAmount = nextByKey.get(key) ?? 0n;
    if (previousAmount !== 0n) append(key, previousAccountByKey[key], -previousAmount);
    if (nextAmount !== 0n) append(key, nextAccountByKey[key], nextAmount);
  }
  return [...deltas.values()].filter((delta) => delta.amountCents !== 0n);
};

export const sumLedgerDelta = (deltas: readonly LedgerDelta[]): Cents =>
  deltas.reduce((sum, delta) => sum + delta.amountCents, 0n);

/** 事件ID是账本幂等边界；重复重试返回原事件，不再追加第二组分录。 */
export const appendLedgerEventOnce = (
  events: readonly LedgerEvent[],
  event: LedgerEvent
): readonly LedgerEvent[] => {
  const existing = events.find((item) => item.eventId === event.eventId);
  if (existing) {
    const normalize = (value: LedgerEvent): string => value.deltas
      .map((delta) => `${delta.accountKey}:${delta.categoryKey}:${delta.amountCents.toString()}`)
      .sort()
      .join("|");
    if (normalize(existing) !== normalize(event)) throw new Error("LEDGER_EVENT_CONFLICT");
    return events;
  }
  return [...events, event];
};
