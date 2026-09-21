import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const evidence = process.env.ALLIANCE_EVIDENCE_DIR ?? resolve(import.meta.dirname,'../../../product-log/evidence/DEV-010-withdrawal');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4AWP8DwQMQMDEAAUAPfgEADYYS7QAAAAASUVORK5CYII=','base64');
const login = async(page,phone='13800000001') => {
  await page.getByLabel('手机号',{exact:true}).fill(phone);
  await page.getByLabel('密码',{exact:true}).fill('Local-demo-only-2026');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();
  if(phone==='13800000003'){
    await page.getByLabel('当前身份',{exact:true}).selectOption('HEADQUARTERS_FINANCE');
    await expect(page.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();
  }
};
const nav = (page,label) => page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name:label,exact:true});
const upload = async(page,label,name) => {
  await page.getByLabel(label,{exact:true}).setInputFiles({name,mimeType:'image/png',buffer:png});
  await page.getByRole('button',{name:`上传${label}`,exact:true}).click();
  await expect(page.getByText(`${name} 已完整上传。`,{exact:true})).toBeVisible();
};
const form = async(page,amount) => {
  await page.getByLabel('支出来源',{exact:true}).selectOption({index:1});
  await page.getByLabel('提现金额（欢乐豆）',{exact:true}).fill(amount);
  await page.getByLabel('收款姓名',{exact:true}).fill('合成验收收款人');
  await page.getByLabel('银行卡账户',{exact:true}).fill('0000123400005678');
};

test('真实原件、草稿恢复、提现扣豆、未知结果同键重试、总部回执与撤回返还',async({page})=>{
  await mkdir(evidence,{recursive:true});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  let token='';
  page.on('response',async r=>{if(r.url().endsWith('/v1/session')&&r.ok())token=(await r.json()).data.sessionId;});
  await page.goto('/'); await login(page);
  await expect(nav(page,'周费用录入')).toHaveAttribute('aria-current','page');
  expect(await page.getByRole('navigation',{name:'主要导航'}).getByRole('button').first().innerText()).toContain('周费用录入');
  // Generate an actual teaching settlement to fund this disposable synthetic account.
  await page.getByLabel('教学期间',{exact:true}).selectOption({index:1});
  const option=page.getByLabel('学生及课程',{exact:true}).locator('option').filter({hasText:'演示学生 小禾 · 数学'});
  await page.getByLabel('学生及课程',{exact:true}).selectOption(await option.getAttribute('value'));
  await page.getByLabel('实际授课场地',{exact:true}).selectOption({index:1});
  await page.getByLabel('本期间累计金额',{exact:true}).fill('2000');
  await page.getByRole('button',{name:/^(保存|更新)累计费用$/}).click();
  await expect(page.locator('.fee-receipt')).toContainText('已确认保存');
  await nav(page,'我的提现').click();
  await expect(page.getByRole('button',{name:'新建提现申请',exact:true})).toBeEnabled();
  const sources=async()=> (await (await page.request.get('/v1/finance/withdrawals/sources',{headers:{authorization:`Bearer ${token}`}})).json()).data;
  const baseline=BigInt((await sources()).find(x=>x.sourceType==='PERSON').balanceCents);
  expect(baseline).toBeGreaterThan(20000n);
  await page.getByRole('button',{name:'新建提现申请',exact:true}).click();
  await expect(page.getByLabel('支出来源',{exact:true})).toBeVisible();
  await form(page,'100');
  await expect(page.getByRole('button',{name:'确认提交并扣豆',exact:true})).toBeDisabled();
  // Explicit reservation rejection must unlock the file and identity controls.
  await page.route('**/v1/finance/drafts/*/attachment-uploads',r=>r.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{code:'FINANCE_ATTACHMENT_LIMIT_EXCEEDED'}})}),{times:1});
  await page.getByLabel('业务单据',{exact:true}).setInputFiles({name:'synthetic-rejected.png',mimeType:'image/png',buffer:png});
  await page.getByRole('button',{name:'上传业务单据',exact:true}).click();
  await expect(page.getByLabel('业务单据',{exact:true})).toBeEnabled();
  await expect(page.getByRole('button',{name:'上传业务单据',exact:true})).toBeEnabled();
  // Server stores the binary, but browser loses the response. Retry reads READY, no new reservation.
  let uploads=0;
  await page.route('**/v1/finance/attachment-uploads/*/content',async route=>{
    uploads++; if(uploads===1){const r=await route.fetch();expect(r.ok()).toBeTruthy();await route.abort('failed');}else await route.continue();
  });
  await page.getByLabel('业务单据',{exact:true}).setInputFiles({name:'synthetic-document.png',mimeType:'image/png',buffer:png});
  await page.getByRole('button',{name:'上传业务单据',exact:true}).click();
  await expect(page.getByRole('button',{name:'安全重试上传业务单据',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'安全重试上传业务单据',exact:true}).click();
  await expect(page.getByText('synthetic-document.png 已完整上传。',{exact:true})).toBeVisible();
  expect(uploads).toBe(1); await page.unroute('**/v1/finance/attachment-uploads/*/content');
  await upload(page,'申请截图','synthetic-application.png');
  // A reload recovers originals, with fresh explicit selection and no persisted bank text.
  await page.reload(); await login(page); await nav(page,'我的提现').click();
  await page.getByRole('button',{name:'继续填写',exact:true}).first().click();
  await expect(page.getByLabel('银行卡账户',{exact:true})).toHaveValue('');
  await page.getByLabel(/选用 synthetic-document.png/).check();
  await page.getByLabel(/选用 synthetic-application.png/).check();
  await form(page,'100');
  // Insufficient balance is a 409 but must preserve the form, with an explicit amount message.
  await page.route('**/v1/finance/drafts/*/withdrawal-submit',r=>r.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{code:'INSUFFICIENT_BALANCE'}})}),{times:1});
  await page.getByRole('button',{name:'确认提交并扣豆',exact:true}).click();
  await expect(page.locator('.finance-notice')).toContainText('超出可用金额');
  await expect(page.getByLabel('银行卡账户',{exact:true})).toHaveValue('0000123400005678');
  await page.getByRole('button',{name:'刷新提现记录',exact:true}).click();
  await expect(page.getByRole('button',{name:'确认提交并扣豆',exact:true})).toBeEnabled();
  const submitKeys=[];
  await page.route('**/v1/finance/drafts/*/withdrawal-submit',async route=>{
    submitKeys.push(route.request().postDataJSON().idempotencyKey);
    if(submitKeys.length===1){const r=await route.fetch();expect(r.ok()).toBeTruthy();await route.abort('failed');}else await route.continue();
  });
  await page.getByRole('button',{name:'确认提交并扣豆',exact:true}).click();
  await expect(page.getByRole('button',{name:'安全重试原提现申请',exact:true})).toBeEnabled();
  await expect(page.getByLabel('银行卡账户',{exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'退出登录',exact:true}).click();
  await expect(page.locator('.message')).toContainText('财务操作或上传结果待确认');
  await nav(page,'周费用录入').click(); await nav(page,'我的提现').click();
  await page.getByRole('button',{name:'安全重试原提现申请',exact:true}).click();
  await expect(page.locator('.finance-success')).toContainText('提现申请已通过');
  expect(submitKeys.length).toBe(2); expect(submitKeys[0]).toBe(submitKeys[1]);
  expect(BigInt((await sources()).find(x=>x.sourceType==='PERSON').balanceCents)).toBe(baseline-10000n);
  await expect(page.locator('.finance-list-row')).not.toContainText('0000123400005678');
  await page.unroute('**/v1/finance/drafts/*/withdrawal-submit');
  await page.screenshot({path:resolve(evidence,'personal-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await expect(page.getByRole('navigation',{name:'手机导航'}).getByRole('button').first()).toContainText('周费用录入');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.screenshot({path:resolve(evidence,'personal-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  // Second request will be revoked by finance, returning only its own amount.
  await page.getByRole('button',{name:'新建提现申请',exact:true}).click(); await form(page,'50');
  await upload(page,'业务单据','synthetic-second-document.png'); await upload(page,'申请截图','synthetic-second-application.png');
  await page.getByRole('button',{name:'确认提交并扣豆',exact:true}).click();
  await expect(page.locator('.finance-success')).toContainText('提现申请已通过');
  await page.getByRole('button',{name:'退出登录',exact:true}).click(); await login(page,'13800000003');
  await expect(page.getByRole('heading',{name:'提现办理',level:1})).toBeVisible();
  await expect(page.locator('.finance-list-item')).toHaveCount(2);
  await expect(page.getByRole('region',{name:'提现办理',exact:true}).locator('.finance-list')).not.toContainText('0000123400005678');
  await page.locator('.finance-list-item').filter({hasText:'100.00 欢乐豆'}).getByRole('button').click();
  await expect(page.locator('.finance-account')).toHaveText('0000123400005678');
  const download=page.waitForEvent('download'); await page.locator('div.finance-detail .finance-attachments > div').filter({hasText:'synthetic-document.png'}).getByRole('button',{name:'下载原件',exact:true}).click();
  expect((await download).suggestedFilename()).toBe('synthetic-document.png');
  await expect(page.getByRole('button',{name:'登记为已转账',exact:true})).toBeDisabled();
  await upload(page,'上传付款回执','synthetic-receipt.png');
  await page.getByLabel(/我已在线下核实/).check();
  await expect(page.getByText('此职务的业务页面尚未接通。请切换至已开放的个人身份办理业务。',{exact:true})).toHaveCount(0);
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:resolve(evidence,'finance-detail.png'),fullPage:true});
  const completeKeys=[];
  await page.route('**/v1/finance/withdrawals/*/mark-transferred',async route=>{
    completeKeys.push(route.request().postDataJSON().idempotencyKey);
    if(completeKeys.length===1){const r=await route.fetch();expect(r.ok()).toBeTruthy();await route.abort('failed');}else await route.continue();
  });
  await page.getByRole('button',{name:'登记为已转账',exact:true}).click();
  await expect(page.getByRole('button',{name:'重试原转账确认操作',exact:true})).toBeEnabled();
  await expect(page.getByRole('button',{name:'撤回申请并返还欢乐豆',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'重试原转账确认操作',exact:true}).click();
  await expect(page.locator('.finance-success')).toContainText('已转账');
  expect(completeKeys.length).toBe(2);expect(completeKeys[0]).toBe(completeKeys[1]);
  await page.locator('.finance-list-item').filter({hasText:'50.00 欢乐豆'}).getByRole('button').click();
  await page.getByLabel('撤回原因',{exact:true}).fill('合成验收：收款资料有误，未做银行转账');
  await page.getByRole('button',{name:'撤回申请并返还欢乐豆',exact:true}).click();
  await expect(page.locator('.finance-success')).toContainText('撤回');
  await page.getByRole('button',{name:/办理历史/}).click();
  await expect(page.locator('.finance-list-item')).toHaveCount(2);
  await page.getByRole('button',{name:'退出登录',exact:true}).click(); await login(page);
  await expect(page.getByRole('heading',{name:'周费用录入',level:1})).toBeVisible();
  await nav(page,'我的提现').click();
  await expect(page.getByText('财务已撤回 · 已退回原账户',{exact:false})).toBeVisible();
  expect(BigInt((await sources()).find(x=>x.sourceType==='PERSON').balanceCents)).toBe(baseline-10000n);
  await expect(page.getByRole('button',{name:'提现办理',exact:true})).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('原件下载权限失效时清除已展开的银行卡详情',async({page})=>{
  await page.goto('/'); await login(page); await nav(page,'我的提现').click();
  await page.getByRole('button',{name:'查看收款及凭证',exact:true}).first().click();
  await expect(page.locator('dl.finance-detail')).toContainText('0000123400005678');
  await page.route('**/v1/finance/attachments/*/content',r=>r.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:{code:'FORBIDDEN_SCOPE'}})}));
  await page.getByRole('button',{name:'下载原件',exact:true}).first().click();
  await expect(page.getByRole('heading',{name:'登录你的账户',exact:true})).toBeVisible();
  await expect(page.getByText('0000123400005678',{exact:true})).toHaveCount(0);
});
