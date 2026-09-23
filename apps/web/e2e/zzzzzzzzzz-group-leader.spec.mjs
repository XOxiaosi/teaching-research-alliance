import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

const evidence = process.env.ALLIANCE_EVIDENCE_DIR
  ?? resolve(import.meta.dirname, "../../../product-log/evidence/DEV-007-group-leader");
const password = "Local-demo-only-2026";
const nav = (page, name) => page.getByRole("navigation", { name: "主要导航" })
  .getByRole("button", { name, exact: true });
const auth = (sessionId) => ({ authorization: `Bearer ${sessionId}` });

const login = async (page, phone) => {
  await page.goto("/");
  await page.getByLabel("手机号", { exact: true }).fill(phone);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
};

const api = async (request, path, sessionId, data) => {
  const response = data === undefined
    ? await request.get(path, { headers: auth(sessionId) })
    : await request.post(path, { headers: auth(sessionId), data });
  expect(response.ok(), `${path}: ${response.status()} ${await response.text()}`).toBeTruthy();
  return (await response.json()).data;
};

test("管理员真实预览/发布组长变更：丢失响应原键重试、阻断离开和过期预览", async ({ page }) => {
  test.skip(process.env.ALLIANCE_SYNTHETIC_E2E !== "1", "Requires isolated synthetic demo");
  await mkdir(evidence, { recursive: true });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await login(page, "13800000004");
  await expect(nav(page, "普通周组长变更")).toBeEnabled();
  await nav(page, "普通周组长变更").click();
  const panel = page.getByRole("region", { name: "普通周组长变更", exact: true });
  await expect(panel.getByLabel("授课老师", { exact: true })).toBeEnabled();
  await expect(panel.getByLabel("新组长", { exact: true })).toBeEnabled();
  await expect(panel.getByLabel("当前普通周", { exact: true })).toBeEnabled();

  const teacher = panel.getByLabel("授课老师", { exact: true });
  const leader = panel.getByLabel("新组长", { exact: true });
  const week = panel.getByLabel("当前普通周", { exact: true });
  const candidateA = await leader.locator("option", { hasText: "演示候选组长甲" }).getAttribute("value");
  const candidateB = await leader.locator("option", { hasText: "演示候选组长乙" }).getAttribute("value");
  const teacherId = await teacher.locator("option", { hasText: "演示授课老师" }).getAttribute("value");
  const weekId = await week.locator("option").nth(1).getAttribute("value");
  expect(candidateA).toBeTruthy();
  expect(candidateB).toBeTruthy();
  expect(teacherId).toBeTruthy();
  expect(weekId).toBeTruthy();

  await teacher.selectOption(teacherId);
  await leader.selectOption(candidateA);
  await week.selectOption(weekId);
  await panel.getByLabel("变更原因", { exact: true }).fill("合成浏览器验收：本周组长交接");
  await panel.getByRole("button", { name: "生成普通周变更预览", exact: true }).click();
  const preview = panel.getByRole("article", { name: "组长变更预览", exact: true });
  await expect(preview).toContainText("原组长：演示原组长");
  await expect(leader.locator("option", { hasText: "演示原组长" })).toHaveCount(0);
  await expect(preview).toContainText("新组长：演示候选组长甲");
  await expect(preview).toContainText("实际迁移 1 笔");

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: resolve(evidence, "group-leader-preview-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });

  const publishBodies = [];
  const publishResults = [];
  await page.route("**/v1/admin/person-relationships", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    publishBodies.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok(), `publish: ${response.status()}`).toBeTruthy();
    publishResults.push((await response.json()).data);
    if (publishBodies.length === 1) await route.abort("failed");
    else await route.fulfill({ response });
  });
  await preview.getByRole("button", { name: "确认发布组长变更", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("发布结果未确认");
  await expect(preview.getByRole("button", { name: "使用原发布请求重试", exact: true })).toBeEnabled();
  await expect(page.getByLabel("当前身份", { exact: true })).toBeDisabled();
  await expect(nav(page, "工资管理")).toBeDisabled();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page.locator(".message")).toContainText("结果待确认");
  await expect(panel).toBeVisible();

  await preview.getByRole("button", { name: "使用原发布请求重试", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("组长变更已确认，未重复发布");
  expect(publishBodies).toHaveLength(2);
  expect(publishBodies[1]).toEqual(publishBodies[0]);
  expect(Object.keys(publishBodies[0]).sort()).toEqual(["idempotencyKey", "previewId"]);
  expect(publishResults[0].replay).toBe(false);
  expect(publishResults[1].replay).toBe(true);
  await page.unroute("**/v1/admin/person-relationships");

  // A separate valid administrator session publishes the same target first; the UI must reject its stale preview.
  await leader.selectOption(candidateB);
  await panel.getByLabel("变更原因", { exact: true }).fill("合成浏览器验收：验证预览过期");
  await panel.getByRole("button", { name: "生成普通周变更预览", exact: true }).click();
  await expect(preview).toContainText("新组长：演示候选组长乙");
  const concurrentSession = await api(page.request, "/v1/session", undefined, {
    phoneNormalized: "13800000004",
    password,
  });
  await api(page.request, "/v1/role-contexts/switch", concurrentSession.sessionId, { subject: "SYSTEM_ADMIN" });
  const competingPreview = await api(
    page.request,
    "/v1/admin/person-relationships/preview",
    concurrentSession.sessionId,
    {
      teacherPersonId: teacherId,
      newRelatedPersonId: candidateB,
      effectiveTeachingWeekId: weekId,
      reason: "另一管理员先行发布",
    },
  );
  const competingPublish = await api(
    page.request,
    "/v1/admin/person-relationships",
    concurrentSession.sessionId,
    { previewId: competingPreview.previewId, idempotencyKey: randomUUID() },
  );
  expect(competingPublish.replay).toBe(false);
  await page.request.post("/v1/session/logout", { headers: auth(concurrentSession.sessionId) });

  const stale = page.waitForResponse((response) => response.url().endsWith("/v1/admin/person-relationships") && response.status() === 409);
  await preview.getByRole("button", { name: "确认发布组长变更", exact: true }).click();
  await stale;
  await expect(panel.getByRole("status")).toContainText("预览已过期，未自动发布");
  await expect(panel.getByRole("button", { name: "重新生成预览", exact: true })).toBeEnabled();
  await expect(preview).toHaveCount(0);

  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page.getByLabel("手机号", { exact: true })).toBeVisible();
  await login(page, "13800000001");
  await expect(nav(page, "普通周组长变更")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "普通周组长变更", exact: true })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
