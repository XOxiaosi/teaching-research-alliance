export type Cents = bigint;

export type AllocationInput = Readonly<{
  key: string;
  rateBasisPoints: bigint;
}>;

export type AllocationLine = Readonly<{
  key: string;
  cents: Cents;
}>;

/**
 * 用最大余数法把正向金额按百分比（1%=100 basis points）分到分。
 * 调用方必须先完成业务规则校验；本函数不接受负金额或超过100%的比例。
 */
export const allocateCents = (total: Cents, inputs: readonly AllocationInput[]): readonly AllocationLine[] => {
  if (total < 0n) throw new Error("NEGATIVE_TOTAL");
  const totalRate = inputs.reduce((sum, item) => sum + item.rateBasisPoints, 0n);
  if (inputs.some((item) => item.rateBasisPoints < 0n) || totalRate !== 10_000n) {
    throw new Error("INVALID_ALLOCATION_RATES");
  }
  const exactNumerators = inputs.map((item) => total * item.rateBasisPoints);
  const floors = exactNumerators.map((numerator) => numerator / 10_000n);
  let remainder = total - floors.reduce((sum, value) => sum + value, 0n);
  const order = exactNumerators
    .map((numerator, index) => ({ index, remainder: numerator % 10_000n }))
    .sort((left, right) => {
      if (left.remainder === right.remainder) return left.index - right.index;
      return left.remainder > right.remainder ? -1 : 1;
    });
  const result = [...floors];
  for (const item of order) {
    if (remainder === 0n) break;
    result[item.index] = (result[item.index] ?? 0n) + 1n;
    remainder -= 1n;
  }
  return inputs.map((item, index) => ({ key: item.key, cents: result[index] ?? 0n }));
};

export const sumCents = (lines: readonly AllocationLine[]): Cents =>
  lines.reduce((sum, line) => sum + line.cents, 0n);
