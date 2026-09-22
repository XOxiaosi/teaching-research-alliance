import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const evidence = process.env.ALLIANCE_EVIDENCE_DIR ?? resolve(import.meta.dirname, "../../../product-log/evidence/DEV-007-venue-board");
const response = (data) => ({ version: "synthetic-venue-board", data });
const weeks = [
  { weekId: "venue-week-1", periodLabel: "场地验收教学周", startsOn: "2026-09-21", endsOn: "2026-09-27", settlementMonth: "2026-09-01" }
];
const venues = [
  { id: "venue-view", name: "共享查看场地", isOwn: false },
  { id: "venue-withdraw", name: "共享提现场地", isOwn: false }
];
const board = ({ canWithdraw, byDate = false }) => ({
  venue: {
    id: canWithdraw ? "venue-withdraw" : "venue-view",
    name: canWithdraw ? "共享提现场地" : "共享查看场地",
    ownerNickname: "场地主理人",
    canWithdraw,
    ...(canWithdraw ? { accountId: "venue-account-1", balanceCents: "8300" } : {})
  },
  period: byDate
    ? { startsOn: "2026-09-21", endsOn: "2026-09-27" }
    : { teachingWeekId: "venue-week-1" },
  members: [
    { personId: "owner-1", nickname: "场地主理人", canView: true, canWithdraw: true, isOwner: true },
    { personId: "viewer-1", nickname: "查看老师", canView: true, canWithdraw: false, isOwner: false },
    { personId: "withdrawer-1", nickname: "提现老师", canView: true, canWithdraw: true, isOwner: false }
  ],
  teachers: [
    {
      teacherPersonId: "teacher-1", teacherNickname: "李老师", totalVenueFeeCents: "1750",
      weeklyFees: [
        { weeklyFeeEntryId: "fee-1", teachingWeekId: "venue-week-1", weekStartsOn: "2026-09-21", weekEndsOn: "2026-09-27", studentRecordId: "student-1", studentDisplayName: "学生甲", courseContextId: "数学", venueFeeCents: "1200" },
        { weeklyFeeEntryId: "fee-2", teachingWeekId: "venue-week-1", weekStartsOn: "2026-09-21", weekEndsOn: "2026-09-27", studentRecordId: "student-2", studentDisplayName: "学生乙", courseContextId: "英语", venueFeeCents: "550" }
      ]
    },
    {
      teacherPersonId: "teacher-2", teacherNickname: "周老师", totalVenueFeeCents: "700",
      weeklyFees: [
        { weeklyFeeEntryId: "fee-3", teachingWeekId: "venue-week-1", weekStartsOn: "2026-09-21", weekEndsOn: "2026-09-27", studentRecordId: "student-3", studentDisplayName: "学生丙", courseContextId: "物理", venueFeeCents: "700" }
      ]
    }
  ],
  totalVenueFeeCents: "2450"
});

const login = async (page) => {
  await page.goto("/");
  await page.getByLabel("手机号", { exact: true }).fill("13800000001");
  await page.getByLabel("密码", { exact: true }).fill("Local-demo-only-2026");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
};

test("共享场地看板按场地和期间显示费用，VIEW 不泄露余额且 WITHDRAW 仅展示独立余额", async ({ page }) => {
  await mkdir(evidence, { recursive: true });
  const requests = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/v1/venues/available", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response(venues)) }));
  await page.route("**/v1/teaching/weeks", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response(weeks)) }));
  await page.route(/\/v1\/venues\/[^/]+\/board(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split("/")[3];
    const filter = Object.fromEntries(url.searchParams.entries());
    requests.push({ id, filter });
    const byDate = filter.startsOn !== undefined;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response(board({ canWithdraw: id === "venue-withdraw", byDate }))) });
  });

  await login(page);
  await page.getByRole("navigation", { name: "主要导航" }).getByRole("button", { name: "场地看板", exact: true }).click();
  const panel = page.getByRole("region", { name: "共享场地看板", exact: true });
  await expect(panel).toBeVisible();

  await panel.getByLabel("场地看板", { exact: true }).selectOption("venue-view");
  await panel.getByLabel("教学周", { exact: true }).selectOption("venue-week-1");
  await panel.getByRole("button", { name: "查看看板", exact: true }).click();
  await expect(panel).toContainText("场地总使用费");
  await expect(panel).toContainText("24.50 豆");
  await expect(panel).toContainText("授课老师2 人");
  await expect(panel).toContainText("学生课程记录3 条");
  for (const value of ["李老师", "周老师", "学生甲", "学生乙", "学生丙", "数学", "英语", "物理", "12.00 豆", "5.50 豆", "7.00 豆", "17.50 豆"]) await expect(panel).toContainText(value);
  await expect(panel).toContainText("场地主理人 · 所有者");
  await expect(panel).toContainText("查看老师 · 仅查看");
  await expect(panel).not.toContainText("场地可提现余额");
  await expect(panel.getByRole("button", { name: /提现/ })).toHaveCount(0);
  expect(requests.at(-1)).toEqual({ id: "venue-view", filter: { weekId: "venue-week-1" } });
  await page.screenshot({ path: resolve(evidence, "web-venue-board-view.png"), fullPage: true });

  await panel.getByLabel("教学周", { exact: true }).selectOption("");
  await panel.getByLabel("开始日期", { exact: true }).fill("2026-09-21");
  await panel.getByLabel("结束日期", { exact: true }).fill("2026-09-27");
  await panel.getByRole("button", { name: "查看看板", exact: true }).click();
  expect(requests.at(-1)).toEqual({ id: "venue-view", filter: { startsOn: "2026-09-21", endsOn: "2026-09-27" } });

  await panel.getByLabel("场地看板", { exact: true }).selectOption("venue-withdraw");
  await panel.getByRole("button", { name: "查看看板", exact: true }).click();
  await expect(panel).toContainText("场地可提现余额");
  await expect(panel).toContainText("83.00 豆");
  await expect(panel).toContainText("提现入口沿用财务页面");
  await expect(panel.getByRole("button", { name: /提现/ })).toHaveCount(0);
  expect(requests.at(-1)).toEqual({ id: "venue-withdraw", filter: { startsOn: "2026-09-21", endsOn: "2026-09-27" } });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: resolve(evidence, "web-venue-board-withdraw-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
});
