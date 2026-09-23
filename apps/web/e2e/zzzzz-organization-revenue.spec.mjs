import { test, expect } from '@playwright/test';

test('合成组织营收按总部、分区和校区切换，个人视角不保留营收入口', async ({page}) => {
 await page.clock.setFixedTime(new Date('2026-09-23T04:00:00Z'));
 for(const [subject, scope, phone] of [['HEADQUARTERS_FINANCE','GLOBAL','13800000003'],['REGION_FINANCE','REGION','13800000005'],['CAMPUS_PRINCIPAL','CAMPUS','13800000003']]){
  await page.goto('/');
  await page.getByLabel('手机号',{exact:true}).fill(phone);
  await page.getByLabel('密码',{exact:true}).fill('Local-demo-only-2026');
  const responsePromise=page.waitForResponse(r=>r.url().includes('/v1/organizations/revenue?'));
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();
  if(await page.getByLabel('当前身份',{exact:true}).inputValue() !== subject) await page.getByLabel('当前身份',{exact:true}).selectOption(subject);
  const response=await responsePromise;expect(response.status()).toBe(200);
  const body=(await response.json()).data;expect(body.scope.scope).toBe(scope);
  expect(body.total.recordedGrossRevenueCents).toBe('100000');
  expect(body.total.effectiveGrossRevenueCents).toBe('100000');
  expect(body.total.campusManagementFeeCents).toBe('2000');
  await page.getByRole('button',{name:'组织营收',exact:true}).click();
  await expect(page.getByRole('heading',{name:'范围内课时营收汇总',exact:true})).toBeVisible();
  const total=page.getByRole('region',{name:'范围总计'});
  await expect(total.getByText('1000.00 欢乐豆',{exact:true})).toHaveCount(2);
  await expect(total.getByText('20.00 欢乐豆',{exact:true})).toBeVisible();
  if(scope==='CAMPUS'){
   expect(body.regions).toEqual([]);expect(body.total.regionFinanceIncomeCents).toBeUndefined();
   await expect(page.getByRole('region',{name:'分区营收',exact:true})).toHaveCount(0);
  } else await expect(page.getByRole('region',{name:'分区营收',exact:true})).toBeVisible();
  if(scope !== 'CAMPUS') await page.getByRole('button',{name:'退出登录',exact:true}).click();
 }
 await page.getByLabel('当前身份',{exact:true}).selectOption('TEACHING_TEACHER');
 await expect(page.getByRole('button',{name:'组织营收',exact:true})).toHaveCount(0);
 await expect(page.getByRole('heading',{name:'范围内课时营收汇总',exact:true})).toHaveCount(0);
});
