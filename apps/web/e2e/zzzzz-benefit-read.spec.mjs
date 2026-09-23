import {test,expect} from '@playwright/test';
test('总部医社保读取区分待办计划与实际执行计划，切个人后不可访问',async({page})=>{
 test.skip(process.env.ALLIANCE_SYNTHETIC_E2E!=='1','Requires isolated synthetic demo with DEMO_WITH_BENEFITS=1');
 await page.clock.setFixedTime(new Date('2026-09-23T04:00:00Z'));
 let token='';page.on('response',async r=>{if(r.url().endsWith('/v1/session')&&r.ok())token=(await r.json()).data.sessionId;});
 await page.goto('/');await page.getByLabel('手机号',{exact:true}).fill('13800000003');await page.getByLabel('密码',{exact:true}).fill('Local-demo-only-2026');await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();await page.getByLabel('当前身份',{exact:true}).selectOption('HEADQUARTERS_FINANCE');await page.getByRole('button',{name:'医社保与公积金',exact:true}).click();
 const panel=page.getByRole('region',{name:'福利管理',exact:true});await expect(panel.getByRole('heading',{name:'当前计划 v2',exact:true})).toBeVisible();await expect(panel.getByRole('heading',{name:'完整计划历史',exact:true})).toBeVisible();await expect(panel.locator('strong').filter({hasText:'80.00 欢乐豆'})).toBeVisible();
 await panel.getByRole('button',{name:/查看实际执行/}).click();const detail=panel.getByLabel('福利执行详情',{exact:true});await expect(detail.getByText(/待办计划：v1.*70\.00 欢乐豆/)).toBeVisible();await expect(detail.getByText(/实际执行计划：v2.*80\.00 欢乐豆/)).toBeVisible();await expect(detail.getByText(/实际执行计划：v2.*HQ_SALARY/)).toBeVisible();await expect(detail.getByText(/待办生成：北京时间 2026-09-21 12:00/)).toBeVisible();
 const downloaded=page.waitForResponse(r=>r.url().endsWith('/content')&&r.url().includes('/v1/finance/attachments/'));await detail.getByRole('button',{name:'下载原件',exact:true}).first().click();expect((await downloaded).status()).toBe(200);
 await page.getByLabel('当前身份',{exact:true}).selectOption('TEACHING_TEACHER');await expect(page.getByRole('button',{name:'医社保与公积金',exact:true})).toHaveCount(0);await expect(panel).toHaveCount(0);const forbidden=await page.request.get('/v1/finance/benefit-roster?month=2026-09-01',{headers:{authorization:`Bearer ${token}`}});expect(forbidden.status()).toBe(403);
});
for(const status of [401,403])test(`福利读取${status}后父页面保留失效提示`,async({page})=>{
 await page.clock.setFixedTime(new Date('2026-09-23T04:00:00Z'));
 await page.route('**/v1/finance/benefit-roster?*',route=>route.fulfill({status,contentType:'application/json',body:JSON.stringify({error:{code:status===401?'UNAUTHENTICATED':'FORBIDDEN_SCOPE',message:'synthetic expiry'}})}));
 await page.goto('/');await page.getByLabel('手机号',{exact:true}).fill('13800000003');await page.getByLabel('密码',{exact:true}).fill('Local-demo-only-2026');await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();await page.getByLabel('当前身份',{exact:true}).selectOption('HEADQUARTERS_FINANCE');
 await expect(page.getByText('登录或身份已失效，请重新登录或选择身份。',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'医社保与公积金',exact:true})).toHaveCount(0);
});
