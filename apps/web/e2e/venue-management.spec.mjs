import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const evidence = process.env.ALLIANCE_EVIDENCE_DIR ?? resolve(import.meta.dirname, "../../../product-log/evidence/GAP-004-venue-management");
const password = "Local-demo-only-2026";
const navigation = (page, name) => page.getByRole("navigation", { name: "主要导航" }).getByRole("button", { name, exact: true });
const panel = (page) => page.getByRole("region", { name: "我的场地管理", exact: true });

const login = async (page) => {
  await page.goto("/");
  await page.getByLabel("手机号", { exact: true }).fill("13800000001");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
};

test("教师在网页管理场地：安全重试创建、改名默认、分权撤权历史和场地看板", async ({ page }) => {
  await mkdir(evidence, { recursive: true });
  const suffix = randomUUID().slice(0, 8);
  const createdName = `浏览器验收场地${suffix}`;
  const renamedName = `验收已改名场地${suffix}`;
  const createRequests = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await login(page);
  await navigation(page, "我的场地").click();
  const management = panel(page);
  await expect(management).toBeVisible();

  const failAfterCommit = async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    createRequests.push(route.request().postDataJSON());
    if (createRequests.length === 1) {
      const committed = await route.fetch();
      expect(committed.ok()).toBeTruthy();
      await route.abort("failed");
      return;
    }
    await route.continue();
  };
  await page.route("**/v1/venues", failAfterCommit);
  await management.getByLabel("新场地名称", { exact: true }).fill(createdName);
  await management.getByRole("button", { name: "创建场地", exact: true }).click();
  await expect(management).toContainText("上次操作结果尚未确认");
  await expect(management.getByRole("button", { name: "安全重试", exact: true })).toBeEnabled();
  await management.getByRole("button", { name: "安全重试", exact: true }).click();
  await expect(management.getByRole("status")).toContainText("场地已创建");
  await page.unroute("**/v1/venues", failAfterCommit);
  expect(createRequests).toHaveLength(2);
  expect(createRequests[1]).toEqual(createRequests[0]);

  const managedVenue = management.getByLabel("管理场地", { exact: true });
  const createdOption = managedVenue.locator("option").filter({ hasText: createdName });
  await expect(createdOption).toHaveCount(1);
  const venueId = await createdOption.getAttribute("value");
  expect(venueId).toBeTruthy();
  await managedVenue.selectOption(venueId);
  await expect(management.getByRole("heading", { name: createdName, exact: true })).toBeVisible();

  await management.getByLabel("新名称", { exact: true }).fill(renamedName);
  await management.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(management.getByRole("status")).toContainText("场地名称已更新");
  await expect(management.getByRole("heading", { name: renamedName, exact: true })).toBeVisible();
  await expect(management.getByRole("button", { name: "设为默认", exact: true })).toBeEnabled();
  await management.getByRole("button", { name: "设为默认", exact: true }).click();
  await expect(management.getByRole("status")).toContainText("默认场地已更新");
  await expect(management).toContainText("默认场地");

  const teacherSelect = management.getByLabel("邀请授课老师", { exact: true });
  await expect.poll(async () => await teacherSelect.locator("option").count()).toBeGreaterThan(1);
  const teacherOption = teacherSelect.locator("option").nth(1);
  const teacherId = await teacherOption.getAttribute("value");
  const teacherName = await teacherOption.textContent();
  expect(teacherId).toBeTruthy();
  expect(teacherName).toBeTruthy();
  await teacherSelect.selectOption(teacherId);
  const canView = management.getByRole("checkbox", { name: "查看", exact: true });
  const canWithdraw = management.getByRole("checkbox", { name: "提现", exact: true });
  await expect(canView).toBeChecked();
  await expect(canWithdraw).not.toBeChecked();
  await management.getByRole("button", { name: "保存授权", exact: true }).click();
  await expect(management.getByRole("status")).toContainText("授权已更新");
  await expect(management.locator("li")).toContainText(`${teacherName} · 仅查看`);

  await canWithdraw.check();
  await management.getByRole("button", { name: "保存授权", exact: true }).click();
  await expect(management.getByRole("status")).toContainText("授权已更新");
  await expect(management.locator("li").filter({ hasText: `${teacherName} · 查看＋提现` })).toHaveCount(1);

  await canView.uncheck();
  await canWithdraw.uncheck();
  await management.getByRole("button", { name: "保存授权", exact: true }).click();
  await expect(management.getByRole("status")).toContainText("授权已撤销");
  await expect(management.locator("li").filter({ hasText: `${teacherName} · 已结束` })).toHaveCount(2);

  await navigation(page, "场地看板").click();
  const board = page.getByRole("region", { name: "共享场地看板", exact: true });
  await expect(board).toBeVisible();
  const boardVenue = board.getByLabel("场地看板", { exact: true });
  await expect(boardVenue.locator(`option[value="${venueId}"]`)).toHaveCount(1);
  await boardVenue.selectOption(venueId);
  await board.getByLabel("开始日期", { exact: true }).fill("2026-09-21");
  await board.getByLabel("结束日期", { exact: true }).fill("2026-09-27");
  const boardResponse = page.waitForResponse((response) => response.url().includes(`/v1/venues/${venueId}/board?`) && response.status() === 200);
  await board.getByRole("button", { name: "查看看板", exact: true }).click();
  await boardResponse;
  await expect(board).toContainText(renamedName);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: resolve(evidence, `venue-management-${suffix}-mobile.png`), fullPage: true });
  expect(errors).toEqual([]);
});
