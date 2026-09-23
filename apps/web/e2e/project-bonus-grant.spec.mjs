import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bonusLedgerState } from './bonus-ledger-state.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4AWP8DwQMQMDEAAUAPfgEADYYS7QAAAAASUVORK5CYII=', 'base64');
const evidence = process.env.ALLIANCE_EVIDENCE_DIR ?? '/tmp/alliance-project-bonus-browser';
const nav = (page, name) => page.getByRole('navigation', { name: '主要导航' }).getByRole('button', { name, exact: true });
const grantPanel = page => page.getByRole('region', { name: '项目奖金发放', exact: true });
async function api(page, method, path, token, data) {
  const response = await page.request.fetch(path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(data ? { data } : {}) });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBeTruthy();
  return (await response.json()).data;
}
async function start(page) {
  await page.goto('/');
  const sessionPromise = page.waitForResponse(response => response.url().endsWith('/v1/session') && response.ok());
  await page.getByLabel('手机号', { exact: true }).fill('13800000003');
  await page.getByLabel('密码', { exact: true }).fill('Local-demo-only-2026');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const session = (await (await sessionPromise).json()).data;
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  await page.getByLabel('当前身份', { exact: true }).selectOption('HEADQUARTERS_FINANCE');
  await nav(page, '项目奖金').click();
  const headersToken = session.sessionId;
  const [directory, funds, projects] = await Promise.all([
    api(page, 'GET', '/v1/finance/cash-wage-teachers', headersToken),
    api(page, 'GET', '/v1/finance/benefit-source-funds', headersToken),
    api(page, 'GET', '/v1/finance/bonus-projects', headersToken),
  ]);
  const recipient = directory.items.find(item => item.nickname === '演示授课老师');
  const finance = directory.items.find(item => item.nickname === '演示总部财务');
  expect(recipient).toBeTruthy(); expect(finance).toBeTruthy(); expect(funds.items).toHaveLength(1);
  return { token: headersToken, recipientPersonId: recipient.id, financePersonId: finance.id, fundId: funds.items[0].fundId, projects: projects.projects };
}
async function prepare(page, state, projectNo, amount, recoverUnknown = false) {
  const panel = grantPanel(page);
  await panel.getByLabel('项目', { exact: true }).selectOption(String(projectNo));
  await panel.getByLabel('收款成员', { exact: true }).selectOption(state.recipientPersonId);
  await panel.getByLabel('支出账户', { exact: true }).selectOption(state.fundId);
  await panel.getByLabel('奖金金额', { exact: true }).fill(amount);
  await panel.getByLabel('发放理由', { exact: true }).fill('本地合成项目奖金验收');
  await panel.getByRole('button', { name: '创建奖金凭证', exact: true }).click();
  if (recoverUnknown) {
    await expect(page.getByLabel('当前身份', { exact: true })).toBeDisabled();
    await panel.getByRole('button', { name: '安全重试创建凭证', exact: true }).click();
  }
  for (const label of ['奖金支持原件', '奖金申请截图']) {
    await panel.getByLabel(label, { exact: true }).setInputFiles({ name: `${label}.png`, mimeType: 'image/png', buffer: png });
    await panel.getByRole('button', { name: `上传${label}`, exact: true }).click();
    if (recoverUnknown && label === '奖金支持原件') {
      await panel.getByRole('button', { name: `安全重试上传${label}`, exact: true }).click();
    }
    await expect(panel.getByText(`${label}.png 已完整上传。`, { exact: true })).toBeVisible();
  }
  return panel;
}

test('真实奖金划拨：丢失响应原命令重试，业务账户扣、收款个人加、财务个人不变', async ({ page }) => {
  // Exercise numeric catalog ordering across the v9/v10 boundary through the real HTTP writer.
  const administrator = await api(page, 'POST', '/v1/session', null, { phoneNormalized: '13800000004', password: 'Local-demo-only-2026' });
  let current = (await api(page, 'GET', '/v1/finance/bonus-projects', administrator.sessionId)).projects.find(item => item.projectNo === 1);
  while (current.nameVersion < 11) {
    current = await api(page, 'POST', '/v1/admin/bonus-projects/1/name', administrator.sessionId, {
      expectedVersion: current.nameVersion, displayName: `浏览器数值版本${current.nameVersion + 1}`,
      reason: '合成奖金版本边界验证', idempotencyKey: randomUUID(),
    });
  }
  await api(page, 'POST', '/v1/session/logout', administrator.sessionId, {});
  const state = await start(page);
  const before = await bonusLedgerState(state);
  const creations = [], created = [];
  await page.route('**/v1/finance/salary-benefits/documents', async route => {
    creations.push(route.request().postDataJSON());
    const response = await route.fetch(); expect(response.status()).toBe(200);
    created.push((await response.json()).data);
    if (creations.length === 1) await route.abort('failed'); else await route.fulfill({ response });
  });
  let uploadCalls = 0;
  await page.route('**/v1/finance/attachment-uploads/*/content', async route => {
    uploadCalls++;
    const response = await route.fetch(); expect(response.status()).toBe(200);
    if (uploadCalls === 1) await route.abort('failed'); else await route.fulfill({ response });
  });
  const panel = await prepare(page, state, 1, '123.45', true);
  expect(creations).toHaveLength(2); expect(creations[1]).toEqual(creations[0]);
  expect(created[1].id).toBe(created[0].id);
  expect(uploadCalls).toBe(2); // First READY original is read back, not uploaded again; second original is separate.
  const commands = [], results = [];
  await page.route('**/v1/finance/project-bonuses/grant', async route => {
    commands.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    results.push((await response.json()).data);
    if (commands.length === 1) await route.abort('failed'); else await route.fulfill({ response });
  });
  await panel.getByRole('button', { name: '确认发放', exact: true }).click();
  const retry = panel.getByRole('button', { name: '安全重试原发放', exact: true });
  await expect(retry).toBeEnabled();
  await expect(page.getByLabel('当前身份', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeDisabled();
  await expect(nav(page, '工资管理')).toBeDisabled();
  await expect(panel.getByLabel('奖金金额', { exact: true })).toBeDisabled();
  await retry.click();
  await expect(panel).toContainText('项目奖金已发放，来源业务账户已扣减，收款成员个人账户已增加。');
  expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0]);
  expect(results.map(item => item.replay)).toEqual([false, true]);
  expect(results[1].id).toBe(results[0].id);
  const after = await bonusLedgerState({ ...state, documentId: results[0].id });
  expect(BigInt(after.balances[state.fundId]) - BigInt(before.balances[state.fundId])).toBe(-12345n);
  expect(BigInt(after.balances[state.recipientPersonId]) - BigInt(before.balances[state.recipientPersonId])).toBe(12345n);
  expect(after.balances[state.financePersonId]).toBe(before.balances[state.financePersonId]);
  expect(after.postings.map(item => [item.owner_type, item.owner_id, item.category_key, item.entry_cents])).toEqual([
    ['COMPANY', state.fundId, 'projectBonusExpense', '-12345'],
    ['PERSON', state.recipientPersonId, 'projectBonusIncome', '12345'],
  ]);
  expect(after.postings.every(item => item.status === 'COMPLETED' && item.project_name_version_id === commands[0].projectNameVersionId)).toBeTruthy();
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: resolve(evidence, 'project-bonus-completed.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: resolve(evidence, 'project-bonus-mobile.png'), fullPage: true });
  await page.getByLabel('当前身份', { exact: true }).selectOption('TEACHING_TEACHER');
  await expect(panel).toHaveCount(0); await expect(nav(page, '项目奖金')).toHaveCount(0);
});

test('项目改名冲突不入账，保留原件，重新核对项目后才发放', async ({ page }) => {
  const state = await start(page);
  const before = await bonusLedgerState(state);
  const panel = await prepare(page, state, 10, '20.01');
  const admin = await api(page, 'POST', '/v1/session', null, { phoneNormalized: '13800000004', password: 'Local-demo-only-2026' });
  const project = state.projects.find(item => item.projectNo === 10);
  const renamedTitle = `合成改名冲突奖金-${randomUUID().slice(0, 6)}`;
  const renamed = await api(page, 'POST', '/v1/admin/bonus-projects/10/name', admin.sessionId, { expectedVersion: project.nameVersion, displayName: renamedTitle, reason: '模拟另一管理员更新目录', idempotencyKey: randomUUID() });
  const commands = [], responses = [];
  await page.route('**/v1/finance/project-bonuses/grant', async route => {
    commands.push(route.request().postDataJSON());
    const response = await route.fetch(); responses.push(response.status()); await route.fulfill({ response });
  });
  await panel.getByRole('button', { name: '确认发放', exact: true }).click();
  await expect.poll(() => responses.length).toBe(1); expect(responses[0]).toBe(409);
  await expect(panel.getByLabel('项目', { exact: true })).toHaveValue('');
  await expect(panel.getByRole('button', { name: '确认发放', exact: true })).toBeDisabled();
  const rejected = await bonusLedgerState({ ...state, documentId: commands[0].documentId });
  expect(rejected.balances).toEqual(before.balances); expect(rejected.postings).toEqual([]);
  await expect(panel.getByLabel('项目', { exact: true }).locator('option[value="10"]')).toContainText(renamedTitle);
  await panel.getByLabel('项目', { exact: true }).selectOption('10');
  await panel.getByRole('button', { name: '确认发放', exact: true }).click();
  await expect(panel).toContainText('项目奖金已发放，来源业务账户已扣减，收款成员个人账户已增加。');
  expect(responses).toEqual([409, 200]); expect(commands[1].documentId).toBe(commands[0].documentId);
  expect(commands[1].attachmentVersionIds).toEqual(commands[0].attachmentVersionIds);
  expect(commands[1].idempotencyKey).not.toBe(commands[0].idempotencyKey);
  expect(commands[1].projectNameVersionId).toBe(renamed.nameVersionId);
  const after = await bonusLedgerState({ ...state, documentId: commands[1].documentId });
  expect(after.postings).toHaveLength(2);
  expect(BigInt(after.balances[state.fundId]) - BigInt(before.balances[state.fundId])).toBe(-2001n);
  expect(BigInt(after.balances[state.recipientPersonId]) - BigInt(before.balances[state.recipientPersonId])).toBe(2001n);
  expect(after.balances[state.financePersonId]).toBe(before.balances[state.financePersonId]);
  await api(page, 'POST', '/v1/admin/bonus-projects/10/name', admin.sessionId, { expectedVersion: renamed.nameVersion, displayName: project.displayName, reason: '恢复合成目录名称', idempotencyKey: randomUUID() });
  await api(page, 'POST', '/v1/session/logout', admin.sessionId, {});
});

test('收款人无可用个人账户时明确拒绝，改选后沿用原凭证与原件', async ({ page }) => {
  const state = await start(page);
  const directory = await api(page, 'GET', '/v1/finance/cash-wage-teachers', state.token);
  const unavailable = directory.items.find(item => item.nickname === '演示管理员');
  expect(unavailable).toBeTruthy();
  const before = await bonusLedgerState(state);
  const panel = await prepare(page, { ...state, recipientPersonId: unavailable.id }, 2, '3.21');
  const commands = [], statuses = [];
  await page.route('**/v1/finance/project-bonuses/grant', async route => {
    commands.push(route.request().postDataJSON());
    const response = await route.fetch(); statuses.push(response.status()); await route.fulfill({ response });
  });
  await panel.getByRole('button', { name: '确认发放', exact: true }).click();
  await expect(panel).toContainText('该收款成员当前不可用');
  expect(statuses).toEqual([404]);
  const failed = await bonusLedgerState({ ...state, documentId: commands[0].documentId });
  expect(failed.balances).toEqual(before.balances); expect(failed.postings).toEqual([]);
  await panel.getByLabel('收款成员', { exact: true }).selectOption(state.recipientPersonId);
  await panel.getByRole('button', { name: '确认发放', exact: true }).click();
  await expect(panel).toContainText('项目奖金已发放，来源业务账户已扣减，收款成员个人账户已增加。');
  expect(statuses).toEqual([404, 200]);
  expect(commands[1].documentId).toBe(commands[0].documentId);
  expect(commands[1].attachmentVersionIds).toEqual(commands[0].attachmentVersionIds);
  expect(commands[1].idempotencyKey).not.toBe(commands[0].idempotencyKey);
  const after = await bonusLedgerState({ ...state, documentId: commands[1].documentId });
  expect(after.postings).toHaveLength(2);
  expect(BigInt(after.balances[state.fundId]) - BigInt(before.balances[state.fundId])).toBe(-321n);
  expect(BigInt(after.balances[state.recipientPersonId]) - BigInt(before.balances[state.recipientPersonId])).toBe(321n);
  expect(after.balances[state.financePersonId]).toBe(before.balances[state.financePersonId]);
});
