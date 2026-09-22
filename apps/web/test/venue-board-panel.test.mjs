import test from "node:test";
import assert from "node:assert/strict";
import { summarizeVenueBoard, boardErrorMessage } from "../dist/venue-board-panel.js";
import { ApiClientError } from "../../../packages/client/dist/index.js";

const board = { totalVenueFeeCents: "1200", teachers: [{ weeklyFees: [{}, {}] }], venue: {}, members: [] };

test("共享场地看板汇总老师、学生课程和总场地费", () => {
  assert.deepEqual(summarizeVenueBoard(board), { teacherCount: 1, studentCount: 2, totalVenueFeeCents: "1200" });
});

test("看板错误给出无权限和通用提示", () => {
  assert.equal(boardErrorMessage(new ApiClientError(403, "FORBIDDEN_SCOPE")), "当前身份没有该场地看板权限。");
  assert.equal(boardErrorMessage(new Error("network")), "场地看板读取失败，请稍后重试。");
});
