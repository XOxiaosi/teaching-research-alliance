import { test, expect } from '@playwright/test';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const demoPassword = 'Local-demo-only-2026';
const evidence = process.env.ALLIANCE_EVIDENCE_DIR ?? '/tmp/alliance-account-access-browser';
const nav = (page, name) => page.getByRole('navigation', { name: '主要导航' }).getByRole('button', { name, exact: true });
const login = async (page, phone, password = demoPassword) => {
  await page.getByLabel('手机号', { exact: true }).fill(phone);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
};
const registration = async (page, nickname, phone, password) => {
  await page.getByRole('tab', { name: '注册普通老师账户', exact: true }).click();
  await page.getByLabel('注册昵称', { exact: true }).fill(nickname);
  await page.getByLabel('注册姓名', { exact: true }).fill('合成验收姓名');
  await page.getByLabel('手机号', { exact: true }).fill(phone);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByLabel('确认密码', { exact: true }).fill(password);
};
const resetForm = async (panel, nickname, password) => {
  const value = await panel.getByLabel('目标账号', { exact: true }).locator('option', { hasText: nickname }).getAttribute('value');
  expect(value).toBeTruthy();
  await panel.getByLabel('目标账号', { exact: true }).selectOption(value);
  await panel.getByLabel('新密码', { exact: true }).fill(password);
  await panel.getByLabel('确认新密码', { exact: true }).fill(password);
  await panel.getByLabel('重置理由', { exact: true }).fill('合成浏览器验收密码重置');
  return value;
};

test('真实注册与密码重置：基础权限、丢失结果同键重试及本人旧会话失效', async ({ page }) => {
  test.skip(process.env.DEMO_WITH_ACCOUNT_ACCESS !== '1', 'Requires isolated account-access demo owner');
  await mkdir(evidence, { recursive: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const nickname = `注册验收-${randomUUID().slice(0, 8)}`;
  const phone = `139${String(randomInt(10000000, 99999999))}`;
  const firstPassword = 'Synthetic-first-password';
  const nextPassword = 'Synthetic-reset-password';
  await page.goto('/');
  await registration(page, nickname, phone, firstPassword);
  await page.getByRole('button', { name: '注册并进入工作台', exact: true }).click();
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  await expect(page.getByLabel('当前身份', { exact: true })).toContainText('普通老师');
  await expect(nav(page, '学生推荐')).toHaveCount(0);
  await expect(nav(page, '账号管理')).toHaveCount(0);
  await expect(nav(page, '我的提现')).toBeVisible();
  await expect(nav(page, '我的报销')).toBeVisible();
  await nav(page, '我的提现').click();
  await expect(page.getByRole('heading', { name: '我的提现', exact: true }).first()).toBeVisible();
  await nav(page, '教师工作台').click();
  await expect(page.getByRole('heading', { name: '当前财年收入', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: resolve(evidence, 'registered-personal-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '退出登录', exact: true }).click();

  await login(page, '13800000004');
  await nav(page, '账号管理').click();
  const panel = page.getByRole('region', { name: '账号管理', exact: true });
  await resetForm(panel, nickname, nextPassword);
  const requests = [], responses = [];
  await page.route('**/v1/admin/accounts/*/password-reset', async route => {
    requests.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    responses.push((await response.json()).data);
    if (requests.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  await panel.getByRole('button', { name: '确认重置密码', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('结果尚未确认');
  await expect(panel.getByLabel('新密码', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('当前身份', { exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: '安全重试原密码重置', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('未重复执行');
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(responses.map(value => value.replay)).toEqual([false, true]);
  await expect(panel.getByLabel('新密码', { exact: true })).toHaveValue('');
  await page.unroute('**/v1/admin/accounts/*/password-reset');
  await page.screenshot({ path: resolve(evidence, 'password-reset-confirmed.png'), fullPage: true });
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await login(page, phone, nextPassword);
  await page.getByRole('button', { name: '退出登录', exact: true }).click();

  await login(page, '13800000008');
  await nav(page, '账号管理').click();
  await resetForm(panel, '演示开发者', 'Synthetic-owner-new-password');
  await panel.getByRole('button', { name: '确认重置密码', exact: true }).click();
  await expect(page.getByLabel('手机号', { exact: true })).toBeVisible();
  await expect(panel).toHaveCount(0);
  await login(page, '13800000008', 'Synthetic-owner-new-password');
  expect(errors).toEqual([]);
});

test('真实注册响应丢失后以原凭据登录，不重复创建账号', async ({ page }) => {
  test.skip(process.env.DEMO_WITH_ACCOUNT_ACCESS !== '1', 'Requires isolated account-access demo');
  const phone = `137${String(randomInt(10000000, 99999999))}`;
  const password = 'Synthetic-unknown-registration';
  let calls = 0;
  await page.goto('/');
  await registration(page, `注册未知-${randomUUID().slice(0, 8)}`, phone, password);
  await page.route('**/v1/accounts/register', async route => {
    calls++;
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    await route.abort('failed');
  });
  await page.getByRole('button', { name: '注册并进入工作台', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('注册结果尚未确认');
  await expect(page.getByRole('tab', { name: '注册普通老师账户', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: '登录', exact: true }).click();
  await expect(page.getByLabel('密码', { exact: true })).toHaveValue(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  expect(calls).toBe(1);
});
