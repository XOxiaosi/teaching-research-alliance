import { test, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const evidence=process.env.ALLIANCE_EVIDENCE_DIR ?? resolve(import.meta.dirname,'../../../product-log/evidence/DEV-010-self-purchase');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4AWP8DwQMQMDEAAUAPfgEADYYS7QAAAAASUVORK5CYII=','base64');
const nav=(page,name)=>page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name,exact:true});
const login=async(page,phone,role)=>{
 await page.getByLabel('手机号',{exact:true}).fill(phone);
 await page.getByLabel('密码',{exact:true}).fill('Local-demo-only-2026');
 await page.getByRole('button',{name:'登录',exact:true}).click();
 await expect(page.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();
 if(role){await page.getByLabel('当前身份',{exact:true}).selectOption(role);await expect(page.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();}
};
const upload=async(page,label,name)=>{
 await page.getByLabel(label,{exact:true}).setInputFiles({name,mimeType:'image/png',buffer:png});
 await page.getByRole('button',{name:`上传${label}`,exact:true}).click();
 await expect(page.getByText(`${name} 已完整上传。`,{exact:true})).toBeVisible();
};

test('管理员业务账户、真实版本冲突、财务本人采买原键恢复与报销收入',async({page})=>{
 await mkdir(evidence,{recursive:true});
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 let token='';
 page.on('response',async r=>{if(r.url().endsWith('/v1/session')&&r.ok())token=(await r.json()).data.sessionId;});
 await page.goto('/'); await login(page,'13800000004','SYSTEM_ADMIN');
 await expect(page.getByRole('heading',{name:'业务账户配置',level:1})).toBeVisible();
 await expect(page.getByText('暂无公司资金账户，可先创建账户。',{exact:true})).toBeVisible();
 await page.getByLabel('账户编码',{exact:true}).fill('WEB_SYNTHETIC_HQ');
 await page.getByLabel('账户名称',{exact:true}).fill('网页验收总部资金');
 const creationKeys=[];
 await page.route('**/v1/admin/company-funds',async route=>{
  if(route.request().method()!=='POST'){await route.continue();return;}
  creationKeys.push(route.request().postDataJSON().idempotencyKey);
  if(creationKeys.length===1){const r=await route.fetch();expect(r.ok()).toBeTruthy();await route.abort('failed');}else await route.continue();
 });
 await page.getByRole('button',{name:'创建公司资金账户',exact:true}).click();
 await expect(page.getByRole('button',{name:'安全重试原配置操作',exact:true})).toBeEnabled();
 await expect(page.getByLabel('账户编码',{exact:true})).toBeDisabled();
 await nav(page,'采买记录').click(); await nav(page,'业务账户配置').click();
 await page.getByRole('button',{name:'退出登录',exact:true}).click();
 await expect(page.locator('.message')).toContainText('结果待确认');
 await page.getByRole('button',{name:'安全重试原配置操作',exact:true}).click();
 await expect(page.locator('.finance-success')).toContainText('已创建业务账户');
 expect(creationKeys.length).toBe(2);expect(creationKeys[0]).toBe(creationKeys[1]);
 await page.unroute('**/v1/admin/company-funds');
 await page.getByLabel('总部财务支出账户',{exact:true}).selectOption({index:1});
 await page.getByLabel('职责映射调整原因',{exact:true}).fill('合成验收配置总部业务资金');
 await page.getByLabel(/我已核对，将总部财务/).check();
 await page.getByRole('button',{name:'保存职责支出来源',exact:true}).click();
 await expect(page.locator('.finance-success')).toContainText('支出来源已更新');
 const auth={authorization:`Bearer ${token}`};
 const config=(await (await page.request.get('/v1/admin/company-funds',{headers:auth})).json()).data;
 expect(config.funds).toHaveLength(1);const fund=config.funds[0];
 expect(config.currentAssignment.fundId).toBe(fund.id);
 // A real second writer changes account version before the original UI submits.
 await page.getByLabel('启停账户',{exact:true}).selectOption(fund.id);
 await page.getByLabel('账户启停原因',{exact:true}).fill('合成验收停用');
 await page.getByLabel(/我已核对，确认停用/).check();
 const changed=await page.request.post(`/v1/admin/company-funds/${fund.id}/status`,{headers:auth,data:{expectedVersion:fund.version,status:'INACTIVE',reason:'另一管理员合成并发',idempotencyKey:crypto.randomUUID()}});
 expect(changed.ok()).toBeTruthy();
 await page.getByRole('button',{name:'停用账户',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('已读取最新账户和职责映射');
 await expect(page.getByLabel('启停账户',{exact:true})).toHaveValue('');
 await page.getByLabel('启停账户',{exact:true}).selectOption(fund.id);
 await page.getByLabel('账户启停原因',{exact:true}).fill('重新启用以验证采买');
 await page.getByLabel(/我已核对，确认启用/).check();
 await page.getByRole('button',{name:'启用账户',exact:true}).click();
 await expect(page.locator('.finance-success')).toContainText('业务账户已启用');
 await page.evaluate(()=>window.scrollTo(0,0)); await page.screenshot({path:resolve(evidence,'company-funds.png'),fullPage:true});
 await page.getByRole('button',{name:'退出登录',exact:true}).click();
 await login(page,'13800000003','TEACHING_TEACHER');
 await expect(nav(page,'周费用录入')).toHaveAttribute('aria-current','page');
 await expect(nav(page,'业务账户配置')).toHaveCount(0);
 await nav(page,'财务本人采买').click();
 const baseline=(await (await page.request.get('/v1/me',{headers:{authorization:`Bearer ${token}`}})).json()).data;
 await page.getByRole('button',{name:'新建采买申请',exact:true}).click();
 await page.getByLabel('采买金额（欢乐豆）',{exact:true}).fill('87.65');
 await page.getByLabel('采买原因',{exact:true}).fill('合成验收购买教学用品');
 await expect(page.getByLabel('银行卡账户',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'确认采买并划拨',exact:true})).toBeDisabled();
 await upload(page,'采买业务单据','purchase-document.png'); await upload(page,'采买申请截图','purchase-application.png');
 // Form validation happens before any purchase command.
 let submits=0;page.on('request',r=>{if(r.url().includes('/self-purchase-submit'))submits++;});
 await page.getByLabel('采买金额（欢乐豆）',{exact:true}).fill('0');
 await page.getByRole('button',{name:'确认采买并划拨',exact:true}).click();
 await expect(page.getByRole('region',{name:'本人采买',exact:true}).locator('.finance-notice')).toContainText('正数');expect(submits).toBe(0);
 await page.getByLabel('采买原因',{exact:true}).fill('合成验收购买教学用品，修正说明');
 await expect(page.getByRole('region',{name:'本人采买',exact:true}).getByRole('alert')).toContainText('正数');
 await page.getByLabel('采买金额（欢乐豆）',{exact:true}).fill('87.65');
 await expect(page.getByRole('region',{name:'本人采买',exact:true}).getByRole('alert')).toHaveCount(0);
 await page.setViewportSize({width:390,height:844});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
 await page.evaluate(()=>window.scrollTo(0,0)); await page.screenshot({path:resolve(evidence,'purchase-mobile.png'),fullPage:true});
 await page.setViewportSize({width:1440,height:1000});
 const keys=[];
 await page.route('**/v1/finance/drafts/*/self-purchase-submit',async route=>{
  keys.push(route.request().postDataJSON().idempotencyKey);
  if(keys.length===1){const r=await route.fetch();expect(r.ok()).toBeTruthy();await route.abort('failed');}else await route.continue();
 });
 await page.getByRole('button',{name:'确认采买并划拨',exact:true}).click();
 await expect(page.getByRole('button',{name:'安全重试原采买申请',exact:true})).toBeEnabled();
 await expect(page.getByLabel('采买金额（欢乐豆）',{exact:true})).toBeDisabled();
 await expect(page.getByRole('region',{name:'本人采买',exact:true}).getByRole('alert')).toContainText('尚不能确认划拨结果');
 await nav(page,'我的提现').click(); await nav(page,'财务本人采买').click();
 await page.getByRole('button',{name:'退出登录',exact:true}).click();
 await expect(page.locator('.message')).toContainText('结果待确认');
 await page.route('**/v1/finance/self-purchases/mine',r=>r.abort('failed'),{times:1});
 await page.getByRole('button',{name:'安全重试原采买申请',exact:true}).click();
 await expect(page.getByRole('region',{name:'本人采买',exact:true}).locator('.finance-success')).toContainText('采买已完成');
 await expect(page.getByRole('region',{name:'本人采买',exact:true}).locator('.finance-notice')).toContainText('结果已确认');
 expect(keys.length).toBe(2);expect(keys[0]).toBe(keys[1]);
 await page.getByRole('button',{name:'刷新采买记录',exact:true}).click();
 await page.getByRole('button',{name:'查看采买详情',exact:true}).click();
 await expect(page.getByRole('region',{name:'本人采买',exact:true}).locator('dl.finance-detail')).toContainText('87.65');
 const downloaded=page.waitForEvent('download');await page.getByRole('region',{name:'本人采买',exact:true}).getByRole('button',{name:'下载原件',exact:true}).first().click();
 expect(await readFile(await (await downloaded).path())).toEqual(png);
 await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:resolve(evidence,'purchase-completed.png'),fullPage:true});
 await nav(page,'教师工作台').click();await page.getByRole('button',{name:'刷新',exact:true}).click();
 await expect(page.locator('.income')).toContainText('报销收入');
 const now=(await (await page.request.get('/v1/me',{headers:{authorization:`Bearer ${token}`}})).json()).data;
 expect(BigInt(now.balanceCents)-BigInt(baseline.balanceCents)).toBe(8765n);expect(now.currentYearIncomeByCategory.reimbursementIncome).toBe('8765');
 await page.getByLabel('当前身份',{exact:true}).selectOption('HEADQUARTERS_FINANCE');
 await expect(nav(page,'业务账户配置')).toHaveCount(0);await expect(nav(page,'财务本人采买')).toHaveCount(0);
 await nav(page,'采买记录').click();await expect(page.getByRole('button',{name:'新建采买申请',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'查看采买详情',exact:true}).click();
 await expect(page.getByRole('region',{name:'采买管理记录',exact:true})).toContainText('网页验收总部资金');
 await expect(page.getByRole('region',{name:'采买管理记录',exact:true})).toContainText('申请人：演示总部财务');
 const denied=await page.request.get('/v1/admin/company-funds',{headers:{authorization:`Bearer ${token}`}});expect(denied.status()).toBe(403);
 await page.getByRole('button',{name:'退出登录',exact:true}).click();await login(page,'13800000001');
 await expect(nav(page,'财务本人采买')).toHaveCount(0);await expect(nav(page,'业务账户配置')).toHaveCount(0);await expect(nav(page,'采买记录')).toHaveCount(0);
 expect(errors).toEqual([]);
});

test('已显示入口的财务资格失效时明确提示并清理申请',async({page})=>{
 await page.goto('/');await login(page,'13800000003','TEACHING_TEACHER');await nav(page,'财务本人采买').click();
 await page.getByRole('button',{name:'新建采买申请',exact:true}).click();
 await page.getByLabel('采买金额（欢乐豆）',{exact:true}).fill('1');await page.getByLabel('采买原因',{exact:true}).fill('合成资格失效验收');
 await upload(page,'采买业务单据','denied-document.png');await upload(page,'采买申请截图','denied-application.png');
 await page.route('**/v1/finance/drafts/*/self-purchase-submit',r=>r.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:{code:'HEADQUARTERS_FINANCE_ASSIGNMENT_REQUIRED'}})}));
 await page.getByRole('button',{name:'确认采买并划拨',exact:true}).click();
 await expect(page.locator('.message')).toContainText('没有有效总部财务任职');
 await expect(page.getByLabel('采买金额（欢乐豆）',{exact:true})).toHaveCount(0);
 await expect(page.getByLabel('当前身份',{exact:true})).toHaveValue('');
});


test('刷新任职后采买资格消失时返回录费首屏',async({page})=>{
 await page.goto('/');await login(page,'13800000003','TEACHING_TEACHER');await nav(page,'财务本人采买').click();
 await expect(page.getByRole('button',{name:'新建采买申请',exact:true})).toBeEnabled();
 await page.route('**/v1/session',async route=>{
  if(route.request().method()!=='GET'){await route.continue();return;}
  const response=await route.fetch();const body=await response.json();
  body.data.roleContexts=body.data.roleContexts.filter(role=>role.subject!=='HEADQUARTERS_FINANCE');
  await route.fulfill({response,json:body});
 });
 await page.getByRole('button',{name:'刷新',exact:true}).click();
 await expect(page.getByRole('heading',{name:'周费用录入',level:1,exact:true})).toBeVisible();
 await expect(nav(page,'财务本人采买')).toHaveCount(0);
 await expect(nav(page,'周费用录入')).toHaveAttribute('aria-current','page');
});
