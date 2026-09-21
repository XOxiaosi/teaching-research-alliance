import { test, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const evidence=process.env.ALLIANCE_EVIDENCE_DIR ?? resolve(import.meta.dirname,'../../../product-log/evidence/DEV-010-self-purchase-reversal');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4AWP8DwQMQMDEAAUAPfgEADYYS7QAAAAASUVORK5CYII=','base64');
const nav=(page,name)=>page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name,exact:true});
const managed=page=>page.getByRole('region',{name:'采买管理记录',exact:true});
const headers=token=>({authorization:`Bearer ${token}`});
async function request(api,path,token,data){
 const response=data===undefined ? await api.get(path,{headers:headers(token)}) : await api.post(path,{headers:headers(token),data});
 expect(response.ok(),`${path}: ${response.status()} ${await response.text()}`).toBeTruthy();return (await response.json()).data;
}
async function session(api,phone,subject){
 const result=await request(api,'/v1/session',undefined,{phoneNormalized:phone,password:'Local-demo-only-2026'});
 await request(api,'/v1/role-contexts/switch',result.sessionId,{subject});return result.sessionId;
}
async function login(page,phone,subject){
 await page.goto('/');await page.getByLabel('手机号',{exact:true}).fill(phone);await page.getByLabel('密码',{exact:true}).fill('Local-demo-only-2026');
 await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();
 await page.getByLabel('当前身份',{exact:true}).selectOption(subject);await expect(page.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();
}
async function originalDraft(api,token,kind,prefix){
 const draft=await request(api,'/v1/finance/drafts',token,{kind,idempotencyKey:randomUUID()});const ids=[];
 for(const purpose of ['SUPPORTING_DOCUMENT','APPLICATION_SCREENSHOT']){
  const upload=await request(api,`/v1/finance/drafts/${draft.id}/attachment-uploads`,token,{purpose,originalFilename:`${prefix}-${purpose}.png`,declaredMediaType:'image/png',declaredSizeBytes:png.length,expectedSha256:createHash('sha256').update(png).digest('hex'),idempotencyKey:randomUUID()});
  const response=await api.post(`/v1/finance/attachment-uploads/${upload.versionId}/content`,{headers:{...headers(token),'content-type':'image/png'},data:png});
  expect(response.ok()).toBeTruthy();ids.push(upload.versionId);
 }
 return {draft,attachmentVersionIds:ids};
}
async function setup(api,amountCents,reason){
 const admin=await session(api,'13800000004','SYSTEM_ADMIN');
 const config=await request(api,'/v1/admin/company-funds',admin);
 // The demo clock is fixed. Reuse a configured source rather than replacing a mapping at the same instant.
 const fund=config.funds.find(item=>item.id===config.currentAssignment?.fundId) ?? await request(api,'/v1/admin/company-funds',admin,{fundCode:'WEB_REVERSAL_HQ',displayName:'撤销验收原业务账户',idempotencyKey:randomUUID()});
 if(config.currentAssignment?.fundId!==fund.id)await request(api,`/v1/admin/company-funds/${fund.id}/assignment`,admin,{expectedAssignmentId:config.currentAssignment?.id??null,reason:'合成撤销验收支出来源',idempotencyKey:randomUUID()});
 const personal=await session(api,'13800000003','TEACHING_TEACHER');const before=await request(api,'/v1/me',personal);
 const original=await originalDraft(api,personal,'SELF_PURCHASE',reason);
 const purchase=await request(api,`/v1/finance/drafts/${original.draft.id}/self-purchase-submit`,personal,{expectedVersion:original.draft.version,amountCents,reason,attachmentVersionIds:original.attachmentVersionIds,idempotencyKey:randomUUID()});
 return {admin,personal,before,purchase,original,fund};
}
async function openRecord(page,reason){
 await nav(page,'采买记录').click();await managed(page).locator('.finance-list-row').filter({hasText:reason}).getByRole('button',{name:'查看采买详情',exact:true}).click();
}

test('撤销原划拨未知结果同键恢复、个人负余额与原件保留',async({page})=>{
 await mkdir(evidence,{recursive:true});const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const context=await setup(page.request,'1234','REVERSAL_UNKNOWN');
 // Spend the actual available balance through the real withdrawal service before reversal.
 const afterPurchase=await request(page.request,'/v1/me',context.personal);
 const sources=await request(page.request,'/v1/finance/withdrawals/sources',context.personal);
 const withdrawal=await originalDraft(page.request,context.personal,'WITHDRAWAL','reversal-spend');
 await request(page.request,`/v1/finance/drafts/${withdrawal.draft.id}/withdrawal-submit`,context.personal,{expectedVersion:withdrawal.draft.version,sourceAccountId:sources.find(item=>item.sourceType==='PERSON').accountId,amountCents:afterPurchase.balanceCents,recipientName:'合成撤销验收人',bankAccount:'0000000000001234',attachmentVersionIds:withdrawal.attachmentVersionIds,idempotencyKey:randomUUID()});
 expect((await request(page.request,'/v1/me',context.personal)).balanceCents).toBe('0');
 // A personal role is denied by the real service, and has no reversal button.
 const denied=await page.request.post(`/v1/finance/self-purchases/${context.purchase.id}/reverse`,{headers:headers(context.personal),data:{expectedVersion:context.purchase.version,reason:'个人越权验收',idempotencyKey:randomUUID()}});expect(denied.status()).toBe(403);
 await login(page,'13800000003','TEACHING_TEACHER');await nav(page,'财务本人采买').click();
 await expect(page.getByRole('button',{name:'确认撤销采买划拨',exact:true})).toHaveCount(0);
 await page.getByLabel('当前身份',{exact:true}).selectOption('HEADQUARTERS_FINANCE');await openRecord(page,'REVERSAL_UNKNOWN');
 await expect(managed(page)).toContainText('12.34');await expect(managed(page)).toContainText(context.fund.displayName);
 const confirm=managed(page).getByRole('button',{name:'确认撤销采买划拨',exact:true});
 await expect(confirm).toBeDisabled();await page.getByRole('textbox',{name:'撤销原因',exact:true}).fill('合成验收：采买退回，保留期间提现');await expect(confirm).toBeDisabled();
 await page.getByLabel(/我已核对.*原业务账户/).check();
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
 await page.screenshot({path:resolve(evidence,'reversal-confirm-mobile.png'),fullPage:true});await page.setViewportSize({width:1440,height:1000});
 const bodies=[];
 await page.route('**/v1/finance/self-purchases/*/reverse',async route=>{
  bodies.push(route.request().postDataJSON());
  if(bodies.length===1){const response=await route.fetch();expect(response.ok()).toBeTruthy();await route.abort('failed');}else await route.continue();
 });
 await confirm.click();
 await expect(managed(page).getByRole('alert')).toContainText('尚不能确认撤销结果');
 await expect(page.getByRole('textbox',{name:'撤销原因',exact:true})).toBeDisabled();await expect(page.getByLabel(/我已核对.*原业务账户/)).toBeDisabled();
 await expect(page.getByRole('button',{name:'刷新采买记录',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'收起采买详情',exact:true})).toBeDisabled();
 await nav(page,'提现办理').click();await nav(page,'采买记录').click();
 await page.getByRole('button',{name:'退出登录',exact:true}).click();await expect(page.locator('.message')).toContainText('结果待确认');
 await page.route('**/v1/finance/self-purchases/managed',route=>route.abort('failed'),{times:1});
 await page.route(`**/v1/finance/self-purchases/${context.purchase.id}`,route=>route.abort('failed'),{times:1});
 await page.getByRole('button',{name:'安全重试原撤销操作',exact:true}).click();
 await expect(managed(page).locator('.finance-success')).toContainText('采买已撤销');
 await expect(managed(page).getByRole('alert')).toContainText('刷新失败');
 await expect(managed(page).getByRole('button',{name:'确认撤销采买划拨',exact:true})).toHaveCount(0);
 expect(bodies).toHaveLength(2);expect(bodies[1]).toEqual(bodies[0]);
 expect(Object.keys(bodies[0]).sort()).toEqual(['expectedVersion','idempotencyKey','reason']);
 await page.getByRole('button',{name:'刷新采买记录',exact:true}).click();await openRecord(page,'REVERSAL_UNKNOWN');
 await expect(managed(page).locator('dl.finance-detail')).toContainText('已撤销');await expect(managed(page)).toContainText('合成验收：采买退回，保留期间提现');
 await expect(managed(page).getByRole('button',{name:'确认撤销采买划拨',exact:true})).toHaveCount(0);
 const download=page.waitForEvent('download');await managed(page).getByRole('button',{name:'下载原件',exact:true}).first().click();expect(await readFile(await (await download).path())).toEqual(png);
 await page.screenshot({path:resolve(evidence,'reversal-completed.png'),fullPage:true});
 await page.getByLabel('当前身份',{exact:true}).selectOption('TEACHING_TEACHER');await nav(page,'教师工作台').click();await page.getByRole('button',{name:'刷新',exact:true}).click();
 const after=await request(page.request,'/v1/me',context.personal);expect(after.balanceCents).toBe('-1234');
 expect(after.currentYearIncomeByCategory.reimbursementIncome??'0').toBe(context.before.currentYearIncomeByCategory.reimbursementIncome??'0');
 if(BigInt(after.currentYearIncomeByCategory.reimbursementIncome??'0')===0n)await expect(page.locator('.income')).not.toContainText('报销收入');
 await nav(page,'财务本人采买').click();await page.getByRole('region',{name:'本人采买',exact:true}).locator('.finance-list-row').filter({hasText:'REVERSAL_UNKNOWN'}).getByRole('button',{name:'查看采买详情',exact:true}).click();
 await expect(page.getByRole('region',{name:'本人采买',exact:true})).toContainText('已撤销');await expect(page.getByRole('textbox',{name:'撤销原因',exact:true})).toHaveCount(0);
 expect(errors).toEqual([]);
});

test('另一办理人已撤销时真实409重读并清除旧确认',async({page})=>{
 const context=await setup(page.request,'5678','REVERSAL_CONFLICT');
 await login(page,'13800000003','HEADQUARTERS_FINANCE');await openRecord(page,'REVERSAL_CONFLICT');
 await page.getByRole('textbox',{name:'撤销原因',exact:true}).fill('旧表单待撤销');await page.getByLabel(/我已核对.*原业务账户/).check();
 await page.getByRole('button',{name:'收起采买详情',exact:true}).click();await openRecord(page,'REVERSAL_CONFLICT');
 await expect(page.getByRole('textbox',{name:'撤销原因',exact:true})).toHaveValue('');await expect(page.getByLabel(/我已核对.*原业务账户/)).not.toBeChecked();
 await page.getByRole('textbox',{name:'撤销原因',exact:true}).fill('旧表单待撤销');await page.getByLabel(/我已核对.*原业务账户/).check();
 const concurrent=await request(page.request,`/v1/finance/self-purchases/${context.purchase.id}/reverse`,context.admin,{expectedVersion:context.purchase.version,reason:'另一管理员先行撤销',idempotencyKey:randomUUID()});expect(concurrent.status).toBe('REVERSED');
 const posts=[];page.on('request',request=>{if(request.url().endsWith('/reverse')&&request.method()==='POST')posts.push(request.postDataJSON());});
 const failed=page.waitForResponse(response=>response.url().endsWith('/reverse')&&response.status()===409);
 await page.route(`**/v1/finance/self-purchases/${context.purchase.id}`,route=>route.abort('failed'),{times:1});
 await page.getByRole('button',{name:'确认撤销采买划拨',exact:true}).click();await failed;
 await expect(managed(page).getByRole('alert')).toContainText('状态已发生变化');
 await expect(managed(page).getByRole('alert')).toContainText('详情未能读取');
 await expect(managed(page)).toContainText('已撤销');await expect(page.getByLabel(/我已核对.*原业务账户/)).toHaveCount(0);
 await expect(page.getByRole('textbox',{name:'撤销原因',exact:true})).toHaveCount(0);expect(posts).toHaveLength(1);
 await page.getByRole('button',{name:'刷新采买记录',exact:true}).click();await openRecord(page,'REVERSAL_CONFLICT');
 await expect(managed(page)).toContainText('另一管理员先行撤销');await expect(managed(page).locator('dl.finance-detail')).toContainText('56.78');
 await page.screenshot({path:resolve(evidence,'reversal-conflict-resolved.png'),fullPage:true});
 const after=await request(page.request,'/v1/me',context.personal);expect(after.balanceCents).toBe(context.before.balanceCents);
 expect(after.currentYearIncomeByCategory.reimbursementIncome??'0').toBe(context.before.currentYearIncomeByCategory.reimbursementIncome??'0');
});
