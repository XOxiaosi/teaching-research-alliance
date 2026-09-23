import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4AWP8DwQMQMDEAAUAPfgEADYYS7QAAAAASUVORK5CYII=', 'base64');

test('福利确认真实原件及响应丢失重试只执行一次，个人账户不变', async ({ page }) => {
  test.skip(process.env.ALLIANCE_SYNTHETIC_E2E !== '1', 'Requires isolated synthetic demo');
  await page.clock.setFixedTime(new Date('2026-09-23T04:00:00Z'));
  const teacherLogin = await page.request.post('/v1/session', { data: { phoneNormalized: '13800000001', password: 'Local-demo-only-2026' } });
  expect(teacherLogin.status()).toBe(200);
  const teacher = (await teacherLogin.json()).data;
  const teacherHeaders = { authorization: `Bearer ${teacher.sessionId}` };
  const personal = async headers => {
    const response = await page.request.get('/v1/me', { headers });
    expect(response.status()).toBe(200);
    const value = (await response.json()).data;
    expect(typeof value.balanceCents).toBe('string');
    return value;
  };
  const before = await personal(teacherHeaders);
  const financePersonalLogin = await page.request.post('/v1/session', { data: { phoneNormalized: '13800000003', password: 'Local-demo-only-2026' } });
  expect(financePersonalLogin.status()).toBe(200);
  const financePersonalHeaders = { authorization: `Bearer ${(await financePersonalLogin.json()).data.sessionId}` };
  const personalSwitch = await page.request.post('/v1/role-contexts/switch', { headers: financePersonalHeaders, data: { subject: 'TEACHING_TEACHER' } });
  expect(personalSwitch.status()).toBe(200);
  const financeBefore = await personal(financePersonalHeaders);
  let token = '';
  page.on('response', async response => { if (response.url().endsWith('/v1/session') && response.ok()) token = (await response.json()).data.sessionId; });
  await page.goto('/');
  await page.getByLabel('手机号', { exact: true }).fill('13800000003');
  await page.getByLabel('密码', { exact: true }).fill('Local-demo-only-2026');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  await page.getByLabel('当前身份', { exact: true }).selectOption('HEADQUARTERS_FINANCE');
  const headers = { authorization: `Bearer ${token}` };
  const rosterBefore = await page.request.get('/v1/finance/benefit-roster?month=2026-09-01', { headers });
  expect(rosterBefore.status()).toBe(200);
  const existing = (await rosterBefore.json()).data.items;
  const receiver = existing.find(item => item.benefitKind === 'SOCIAL_INSURANCE').beneficiaryPersonId;
  const funds = (await (await page.request.get('/v1/finance/benefit-source-funds', { headers })).json()).data.items;
  const createPlan = await page.request.post('/v1/finance/benefit-plans', { headers, data: {
    benefitKind: 'HOUSING_FUND', beneficiaryPersonId: receiver, benefitMonth: '2026-09-01', executionDay: 5,
    amountCents: '9000', sourceFundId: funds[0].fundId, active: true, reason: '合成福利确认验收', idempotencyKey: randomUUID(),
  } });
  expect(createPlan.status()).toBe(200);
  await page.getByRole('button', { name: '医社保与公积金', exact: true }).click();
  const panel = page.getByRole('region', { name: '福利扣豆确认', exact: true });
  await panel.getByRole('button', { name: '生成今日到期福利待办（不扣豆）', exact: true }).click();
  const select = panel.getByLabel('确认福利对象', { exact: true });
  const selection = `${receiver}:HOUSING_FUND`;
  await expect(select.locator(`option[value="${selection}"]`)).toHaveCount(1);
  await select.selectOption(selection);
  await panel.getByLabel('确认理由', { exact: true }).fill('核对真实合成原件后确认');
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: '创建福利扣豆凭证', exact: true }).click();
  await expect(page.getByRole('region', { name: '福利计划维护', exact: true }).getByRole('button', { name: '保存计划', exact: true })).toBeDisabled();
  for (const label of ['福利支持原件', '福利申请截图']) {
    await panel.getByLabel(label, { exact: true }).setInputFiles({ name: `${label}.png`, mimeType: 'image/png', buffer: png });
    await panel.getByRole('button', { name: `上传${label}`, exact: true }).click();
    await expect(panel.getByRole('button', { name: `上传${label}`, exact: true })).toHaveCount(0);
  }
  const commands = [], results = [];
  await page.route('**/v1/finance/benefits/confirm', async route => {
    commands.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    results.push((await response.json()).data);
    if (commands.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  await panel.getByRole('button', { name: '确认福利扣豆', exact: true }).click();
  const retry = panel.getByRole('button', { name: '安全重试原确认', exact: true });
  await expect(retry).toBeEnabled();
  await expect(page.getByLabel('当前身份', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '医社保与公积金', exact: true })).toBeDisabled();
  await retry.click();
  await expect(panel.getByText('此前操作已提交，最新福利待办已读取；未重复执行。', { exact: true })).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  expect(commands[0].expectedPlanVersionId).toBeTruthy();
  expect(results[0].id).toBeTruthy();
  expect(results[1].id).toBe(results[0].id);
  expect(results[0].replay).toBe(false);
  expect(results[1].replay).toBe(true);
  const rosterAfter = await page.request.get('/v1/finance/benefit-roster?month=2026-09-01', { headers });
  const executed = (await rosterAfter.json()).data.items.find(item => item.benefitKind === 'HOUSING_FUND' && item.beneficiaryPersonId === receiver);
  expect(executed.execution.amountCents).toBe('9000');
  expect(executed.execution.status).toBe('COMPLETED');
  expect(executed.execution.documentId).toBe(results[0].id);
  expect(executed.execution.sourceFund.id).toBe(funds[0].fundId);
  const after = await personal(teacherHeaders);
  const financeAfter = await personal(financePersonalHeaders);
  expect(after.balanceCents).toBe(before.balanceCents);
  expect(after.currentYearIncomeByCategory).toEqual(before.currentYearIncomeByCategory);
  expect(financeAfter.balanceCents).toBe(financeBefore.balanceCents);
  await page.getByLabel('当前身份', { exact: true }).selectOption('TEACHING_TEACHER');
  await expect(panel).toHaveCount(0);
});
