import test from "node:test";
import assert from "node:assert/strict";
import { allocateCents, sumCents } from "../dist/index.js";

test("最大余数分币守恒并按稳定顺序处理尾差", () => {
  const lines = allocateCents(10003n, [
    { key: "first", rateBasisPoints: 3333n },
    { key: "second", rateBasisPoints: 3333n },
    { key: "teacher", rateBasisPoints: 3334n }
  ]);
  assert.deepEqual(lines.map((line) => line.cents), [3334n, 3334n, 3335n]);
  assert.equal(sumCents(lines), 10003n);
});

test("零金额保留零分配", () => {
  const lines = allocateCents(0n, [
    { key: "planner", rateBasisPoints: 1000n },
    { key: "teacher", rateBasisPoints: 9000n }
  ]);
  assert.deepEqual(lines.map((line) => line.cents), [0n, 0n]);
});

test("非法比例或负金额被拒绝", () => {
  assert.throws(() => allocateCents(100n, [{ key: "bad", rateBasisPoints: 10001n }]), /INVALID_ALLOCATION_RATES/);
  assert.throws(() => allocateCents(100n, [{ key: "partial", rateBasisPoints: 5000n }]), /INVALID_ALLOCATION_RATES/);
  assert.throws(() => allocateCents(-1n, []), /NEGATIVE_TOTAL/);
});
