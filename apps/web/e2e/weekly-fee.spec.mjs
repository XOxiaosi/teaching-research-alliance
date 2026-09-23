import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const evidence=process.env.ALLIANCE_EVIDENCE_DIR ?? resolve(import.meta.dirname,'../../../product-log/evidence/DEV-010-weekly-first');
const feePath='**/v1/referrals/*/weekly-fees';
const login=async(page,phone='13800000001')=>{
  await page.getByLabel('手机号',{exact:true}).fill(phone);
  await page.getByLabel('密码',{exact:true}).fill('Local-demo-only-2026');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();
};
const choose=async(page)=>{
  await page.getByLabel('教学期间',{exact:true}).selectOption({index:1});
  const studentOption=page.getByLabel('学生及课程',{exact:true}).locator('option').filter({hasText:'演示学生 小禾 · 数学'});
  await page.getByLabel('学生及课程',{exact:true}).selectOption(await studentOption.getAttribute('value'));
  await page.getByLabel('实际授课场地',{exact:true}).selectOption({index:1});
};
const save=async(page,value)=>{
  await page.getByLabel('本期间累计金额',{exact:true}).fill(value);
  await page.getByRole('button',{name:/^(保存|更新)累计费用$/}).click();
  await expect(page.locator('.fee-receipt')).toContainText('已确认保存');
  await expect(page.locator('.fee-receipt-details')).toContainText('费用版本');
  await expect(page.getByLabel('学生及课程',{exact:true})).toHaveValue('');
};

test('首屏录费、累计更正、故障安全重试、推荐回归与手机操作',async({page})=>{
  await mkdir(evidence,{recursive:true});
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  let token='';
  page.on('response',async(response)=>{
    if(response.url().endsWith('/v1/session')&&response.ok()) token=(await response.json()).data.sessionId;
  });
  await page.goto('/');
  await login(page);
  await expect(page.getByRole('heading',{name:'周费用录入',level:1,exact:true})).toBeVisible();
  const firstNavigationButton=page.getByRole('navigation',{name:'主要导航'}).getByRole('button').first();
  await expect(firstNavigationButton).toHaveText('周费用录入');
  await expect(firstNavigationButton.locator('svg.nav-icon[aria-hidden="true"]')).toHaveCount(1);
  await expect(page.locator('.overview')).not.toBeVisible();
  await choose(page);
  let posts=0;
  page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/weekly-fees'))posts++;});
  await page.getByLabel('本期间累计金额',{exact:true}).fill('');
  await page.getByRole('button',{name:/^(保存|更新)累计费用$/}).click();
  await expect(page.locator('#fee-amount-error')).toContainText('请填写');
  for(const invalid of ['-1','1.234']){
    await page.getByLabel('本期间累计金额',{exact:true}).fill(invalid);
    await page.getByRole('button',{name:/^(保存|更新)累计费用$/}).click();
    await expect(page.locator('#fee-amount-error')).toContainText('非负金额');
  }
  expect(posts).toBe(0);
  await save(page,'0');
  await choose(page);
  await expect(page.locator('.fee-comparison')).toContainText('0.00 欢乐豆');
  await expect(page.locator('.fee-metrics')).toContainText('已录记录');
  await save(page,'1000');
  await page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name:'教师工作台'}).click();
  // The shared demo also contains a confirmed 49.00-bean cash-wage deduction.
  await expect(page.locator('.balance strong')).toHaveText('671.00');
  await page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name:'周费用录入'}).click();
  await choose(page);
  await expect(page.getByLabel('本期间累计金额',{exact:true})).toHaveValue('1000.00');
  await save(page,'1200');
  await page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name:'教师工作台'}).click();
  await expect(page.locator('.balance strong')).toHaveText('815.00');
  await page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name:'周费用录入'}).click();

  const keys=[];
  await page.route(feePath,async(route)=>{
    keys.push(route.request().postDataJSON().idempotencyKey);
    if(keys.length===1){const response=await route.fetch();expect(response.ok()).toBeTruthy();await route.abort('failed');}
    else await route.continue();
  });
  await choose(page);
  await page.getByLabel('本期间累计金额',{exact:true}).fill('1300');
  await page.getByRole('button',{name:'更新累计费用'}).click();
  await expect(page.getByRole('button',{name:'安全重试这次保存'})).toBeVisible();
  await expect(page.getByLabel('本期间累计金额',{exact:true})).toBeDisabled();
  await page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name:'教师工作台'}).click();
  await page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name:'周费用录入'}).click();
  await page.getByRole('button',{name:'安全重试这次保存'}).click();
  await expect(page.getByLabel('学生及课程',{exact:true})).toHaveValue('');
  expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);
  await page.unroute(feePath);
  await choose(page);
  await expect(page.getByLabel('本期间累计金额',{exact:true})).toHaveValue('1300.00');

  // A write succeeds even when its following overview refresh fails.
  await page.route('**/v1/me',r=>r.abort('failed'));
  await page.getByLabel('本期间累计金额',{exact:true}).fill('1350');
  await page.getByRole('button',{name:'更新累计费用'}).click();
  await expect(page.locator('.fee-receipt')).toContainText('已确认保存');
  await expect(page.getByRole('button',{name:'重新读取最新数据'})).toBeVisible();
  await page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name:'教师工作台'}).click();
  await expect(page.locator('.balance strong')).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'个人余额与收入正在等待更新'})).toBeVisible();
  await page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name:'周费用录入'}).click();
  await expect(page.getByLabel('本期间累计金额',{exact:true})).toBeDisabled();
  await page.unroute('**/v1/me');
  await page.getByRole('button',{name:'重新读取最新数据'}).click();
  await expect(page.getByLabel('学生及课程',{exact:true})).toHaveValue('');

  // A real second writer changes the same fee; the stale UI must not overwrite it.
  await choose(page);
  const referralId=await page.getByLabel('学生及课程',{exact:true}).inputValue();
  const teachingWeekId=await page.getByLabel('教学期间',{exact:true}).inputValue();
  const venueId=await page.getByLabel('实际授课场地',{exact:true}).inputValue();
  const auth={authorization:`Bearer ${token}`};
  const records=(await (await page.request.get('/v1/teaching/referrals',{headers:auth})).json()).data;
  const previous=records.find(r=>r.referralId===referralId).weeklyFees.find(f=>f.teachingWeekId===teachingWeekId);
  const res=await page.request.post(`/v1/referrals/${referralId}/weekly-fees`,{headers:auth,data:{referralCaseId:referralId,teachingWeekId,venueId,settlementMonth:previous.settlementMonth,grossAmountCents:'140000',expectedVersion:previous.version,idempotencyKey:crypto.randomUUID()}});
  expect(res.ok()).toBeTruthy();
  // Refresh changes props but must never upgrade the version captured with an old draft.
  await page.getByRole('button',{name:'刷新',exact:true}).click();
  await expect(page.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();
  await page.getByLabel('本期间累计金额',{exact:true}).fill('1500');
  await page.getByRole('button',{name:'更新累计费用'}).click();
  await expect(page.locator('.fee-notice')).toContainText('核对服务器金额');
  await choose(page);
  await expect(page.getByLabel('本期间累计金额',{exact:true})).toHaveValue('1400.00');
  await save(page,'1500');
  await choose(page);
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:resolve(evidence,'desktop-weekly-fee.png'),fullPage:true});

  // Keep the other task's newly handed-off referral flow working.
  await page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name:'学生推荐'}).click();
  await page.getByLabel('接收老师',{exact:true}).selectOption({index:1});
  const student=`合成回归-${Date.now()}`;
  await page.getByLabel('学生名字',{exact:true}).fill(student);
  await page.getByLabel('课程',{exact:true}).fill('英语');
  await page.getByRole('button',{name:'提交推荐',exact:true}).click();
  await expect(page.locator('.sent-referrals')).toContainText(student);
  await expect(page.locator('.sent-referrals article').filter({hasText:student})).toHaveCount(1);
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:resolve(evidence,'desktop-referrals.png'),fullPage:true});
  await page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name:'教师工作台'}).click();
  await expect(page.locator('.balance strong')).toHaveText('1031.00');
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:resolve(evidence,'desktop-workspace.png'),fullPage:true});

  await page.setViewportSize({width:390,height:844});
  await page.getByRole('navigation',{name:'手机导航'}).getByRole('button',{name:'周费用录入'}).click();
  await choose(page);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:resolve(evidence,'mobile-weekly-fee.png'),fullPage:true});
  await save(page,'1500.01');
  await expect(page.locator('.fee-receipt')).toContainText('已确认保存');
  // HTTP 403 fault injection verifies UI role clearing (server permissions have separate integration tests).
  await choose(page);
  await page.route(feePath, r=>r.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:{code:'FORBIDDEN_SCOPE',message:'FORBIDDEN_SCOPE'}})}));
  await page.getByLabel('本期间累计金额',{exact:true}).fill('1600');
  await page.getByRole('button',{name:'更新累计费用'}).click();
  await expect(page.locator('.fee-panel')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();
  await expect(page.getByRole('button',{name:'安全重试这次保存'})).toHaveCount(0);
  await page.unroute(feePath);
  await page.getByLabel('当前身份',{exact:true}).selectOption('TEACHING_TEACHER');
  await expect(page.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();
  // Real server revocation clears scoped data on the next write.
  await choose(page);
  await page.request.post('/v1/session/logout',{headers:auth});
  await page.getByLabel('本期间累计金额',{exact:true}).fill('1600');
  await page.getByRole('button',{name:'更新累计费用'}).click();
  await expect(page.getByLabel('手机号',{exact:true})).toBeVisible();
  await expect(page.locator('.fee-panel')).toHaveCount(0);
  await login(page,'13800000002');
  await expect(page.getByRole('heading',{name:'学生推荐',level:1})).toBeVisible();
  await expect(page.locator('.fee-panel')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('读取失败不伪装空记录，真正无期间时明确提示',async({page})=>{
  await page.route('**/v1/teaching/weeks',r=>r.abort('failed'));
  await page.goto('/');
  await login(page);
  await expect(page.locator('.fee-empty')).toHaveText('录费资料尚未读取成功，请点击页面上方的刷新后重试。');
  await expect(page.getByText('暂无分配给你的学生课程记录',{exact:false})).toHaveCount(0);
  await page.unroute('**/v1/teaching/weeks');
  await page.route('**/v1/teaching/weeks',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:[]})}));
  await page.getByRole('button',{name:'刷新',exact:true}).click();
  await expect(page.locator('.fee-empty')).toContainText('暂无开放的教学期间');
  await expect(page.getByRole('button',{name:'保存累计费用'})).toHaveCount(0);
  await page.unroute('**/v1/teaching/weeks');
  await page.getByRole('button',{name:'刷新',exact:true}).click();
  await expect(page.getByLabel('教学期间',{exact:true})).toBeEnabled();
});
