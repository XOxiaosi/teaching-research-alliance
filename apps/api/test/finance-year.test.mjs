import test from 'node:test';
import assert from 'node:assert/strict';
import { financeYearBounds } from '../dist/finance-year.js';

test('财年以北京时间九月一日零点切换，结束边界不含下一年',()=>{
  assert.deepEqual(financeYearBounds(new Date('2026-08-31T15:59:59.999Z')),{start:'2025-08-31T16:00:00.000Z',end:'2026-08-31T16:00:00.000Z'});
  assert.deepEqual(financeYearBounds(new Date('2026-08-31T16:00:00.000Z')),{start:'2026-08-31T16:00:00.000Z',end:'2027-08-31T16:00:00.000Z'});
  assert.throws(()=>financeYearBounds(new Date('invalid')),/INVALID_INPUT/);
});
