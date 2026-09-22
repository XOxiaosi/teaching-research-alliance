import test from "node:test";
import assert from "node:assert/strict";
import { miniBoardSummary } from "../dist/pages/index/venue-board-helpers.js";

test("小程序场地看板汇总老师和学生课程", () => {
  assert.deepEqual(miniBoardSummary({ teachers: [{ weeklyFees: [{}, {}] }, { weeklyFees: [{}] }] }), { teacherCount: 2, studentCount: 3 });
});
