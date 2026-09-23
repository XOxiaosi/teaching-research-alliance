import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const evidence = process.env.ALLIANCE_EVIDENCE_DIR ?? resolve(import.meta.dirname, '../../../product-log/evidence/DEV-007-venue-board');
const password = 'Local-demo-only-2026';

async function login(page, phone, role) {
  await page.getByLabel('手机号', { exact: true }).fill(phone);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  if (role) {
    await page.getByLabel('当前身份', { exact: true }).selectOption(role);
    await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  }
}

test('真实演示登录后的教师、规划师和兼任财务身份读取共享场地目录', async ({ page }) => {
  await mkdir(evidence, { recursive: true });
  const checks = [
    { phone: '13800000001', role: undefined, label: '教师' },
    { phone: '13800000002', role: 'ACADEMIC_PLANNER', label: '规划师' },
    { phone: '13800000003', role: 'TEACHING_TEACHER', label: '兼任财务教师视角' }
  ];
  const observed = [];
  page.on('response', async (response) => {
    if (response.url().endsWith('/v1/venues/visible')) {
      observed.push({ status: response.status(), body: await response.json() });
    }
  });
  for (const check of checks) {
    await page.goto('/');
    await login(page, check.phone, check.role);
    await expect.poll(() => observed.length, { timeout: 5000 }).toBeGreaterThan(0);
    const latest = observed.at(-1);
    expect(latest.status, check.label).toBe(200);
    expect(Array.isArray(latest.body.data), check.label).toBeTruthy();

    await expect(page.getByRole('button', { name: '场地看板', exact: true })).toBeVisible();
    if (check.label === '规划师') {
      for (const [buttonName, heading] of [['学生推荐', '学生推荐'], ['我的提现', '我的提现'], ['场地看板', '共享场地看板']]) {
        await page.getByRole('button', { name: buttonName, exact: true }).click();
        await expect(page.locator('h1').filter({ hasText: heading })).toBeVisible();
      }
    }
    await page.screenshot({ path: resolve(evidence, `real-directory-${check.label}.png`), fullPage: true });
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    observed.length = 0;
  }
});
