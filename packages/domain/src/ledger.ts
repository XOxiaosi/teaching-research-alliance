import type { AllocationLine, Cents } from "./index.js";

export type LedgerDelta = Readonly<{
  accountKey: string;
  amountCents: Cents;
}>;

export type LedgerEvent = Readonly<{
  eventId: string;
  deltas: readonly LedgerDelta[];
}>;

export const allocationDelta = (
  previous: readonly AllocationLine[],
  next: readonly AllocationLine[],
  accountByKey: Readonly<Record<string, string>>
): readonly LedgerDelta[] => {
  const previousByKey = new Map(previous.map((line) => [line.key, line.cents]));
  const nextByKey = new Map(next.map((line) => [line.key, line.cents]));
  const keys = [...new Set([...previousByKey.keys(), ...nextByKey.keys()])];
  return keys
    .map((key) => ({
      accountKey: accountByKey[key] ?? key,
      amountCents: (nextByKey.get(key) ?? 0n) - (previousByKey.get(key) ?? 0n)
    }))
    .filter((line) => line.amountCents !== 0n);
};

export const sumLedgerDelta = (deltas: readonly LedgerDelta[]): Cents =>
  deltas.reduce((sum, delta) => sum + delta.amountCents, 0n);

/** 事件ID是账本幂等边界；重复重试返回原事件，不再追加第二组分录。 */
export const appendLedgerEventOnce = (
  events: readonly LedgerEvent[],
  event: LedgerEvent
): readonly LedgerEvent[] => {
  const existing = events.find((item) => item.eventId === event.eventId);
  if (existing) return events;
  return [...events, event];
};
