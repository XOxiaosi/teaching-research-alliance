import { test, expect } from "@playwright/test";

const referralPath = "**/v1/teaching/referrals";
const feePath = "**/v1/referrals/*/weekly-fees";
const login = async (page) => {
  await page.goto("/");
  await page.getByLabel("手机号", { exact: true }).fill("13800000001");
  await page.getByLabel("密码", { exact: true }).fill("Local-demo-only-2026");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
};
const selectedIds = async (page) => ({
  weekId: await page.getByLabel("教学期间", { exact: true }).locator("option").nth(1).getAttribute("value"),
  referralId: await page.getByLabel("学生及课程", { exact: true }).locator("option").nth(1).getAttribute("value"),
  venueId: await page.getByLabel("实际授课场地", { exact: true }).locator("option").nth(1).getAttribute("value")
});
const selectFee = async (page, ids) => {
  await page.getByLabel("教学期间", { exact: true }).selectOption(ids.weekId);
  await page.getByLabel("学生及课程", { exact: true }).selectOption(ids.referralId);
};
const withSyntheticRefund = (payload, ids, refunded) => ({
  ...payload,
  data: payload.data.map((referral) => referral.referralId === ids.referralId ? {
    ...referral,
    weeklyFees: [{
      teachingWeekId: ids.weekId,
      grossAmountCents: "123400",
      version: 7,
      venueId: ids.venueId,
      ...(refunded ? { refundStatus: "REFUNDED" } : {})
    }]
  } : referral)
});

test("退款周费用保留原金额，只允许继续切换学生和教学期间", async ({ page }) => {
  await login(page);
  const ids = await selectedIds(page);
  await page.route(referralPath, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: withSyntheticRefund(await response.json(), ids, true) });
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  await selectFee(page, ids);

  await expect(page.getByLabel("本期间累计金额", { exact: true })).toHaveValue("1234.00");
  await expect(page.getByLabel("本期间累计金额", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("实际授课场地", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "已退款，不可修改", exact: true })).toBeDisabled();
  await expect(page.locator(".fee-notice")).toContainText("这笔周费用已退款，保留原登记金额供核对，不能再修改。");
  await expect(page.getByLabel("教学期间", { exact: true })).toBeEnabled();
  await expect(page.getByLabel("学生及课程", { exact: true })).toBeEnabled();
});

test("保存返回 WEEKLY_FEE_REFUNDED 后重读合成记录，禁止覆盖退款原金额", async ({ page }) => {
  await login(page);
  const ids = await selectedIds(page);
  let refunded = false;
  await page.route(referralPath, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: withSyntheticRefund(await response.json(), ids, refunded) });
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await selectFee(page, ids);
  await expect(page.getByLabel("本期间累计金额", { exact: true })).toHaveValue("1234.00");
  await expect(page.getByLabel("本期间累计金额", { exact: true })).toBeEnabled();

  let writes = 0;
  await page.route(feePath, async (route) => {
    writes += 1;
    refunded = true;
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "WEEKLY_FEE_REFUNDED", message: "WEEKLY_FEE_REFUNDED" } }) });
  });
  await page.getByLabel("本期间累计金额", { exact: true }).fill("1500");
  await page.getByRole("button", { name: "更新累计费用", exact: true }).click();
  await expect(page.locator(".fee-notice")).toContainText("这笔周费用已退款");
  expect(writes).toBe(1);

  await selectFee(page, ids);
  await expect(page.getByLabel("本期间累计金额", { exact: true })).toHaveValue("1234.00");
  await expect(page.getByLabel("本期间累计金额", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("实际授课场地", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "已退款，不可修改", exact: true })).toBeDisabled();
});
