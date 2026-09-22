import { test, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const evidence=process.env.ALLIANCE_EVIDENCE_DIR ?? resolve(import.meta.dirname,'../../../product-log/evidence/DEV-010-reimbursement');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4AWP8DwQMQMDEAAUAPfgEADYYS7QAAAAASUVORK5CYII=','base64');
const nav=(page,name)=>page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name,exact:true});
const mine=page=>page.locator('[data-finance-module="reimbursement"][data-mode="personal"]');
const managed=page=>page.locator('[data-finance-module="reimbursement"][data-mode="managed"]');
const headers=token=>({authorization:`Bearer ${token}`});

async function request(api,path,token,data){
 const response=data===undefined?await api.get(path,{headers:headers(token)}):await api.post(path,{headers:headers(token),data});
 expect(response.ok(),`${path}: ${response.status()} ${await response.text()}`).toBeTruthy();
 return (await response.json()).data;
}
async function session(api,phone,subject){
 const result=await request(api,'/v1/session',undefined,{phoneNormalized:phone,password:'Local-demo-only-2026'});
 if(subject)await request(api,'/v1/role-contexts/switch',result.sessionId,{subject});
 return result.sessionId;
}
async function login(page,phone,subject){
 await page.goto('/');
 await page.getByLabel('手机号',{exact:true}).fill(phone);
 await page.getByLabel('密码',{exact:true}).fill('Local-demo-only-2026');
 await page.getByRole('button',{name:'登录',exact:true}).click();
 await expect(page.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();
 if(subject){
  await page.getByLabel('当前身份',{exact:true}).selectOption(subject);
  await expect(page.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();
 }
}
async function upload(page,label,name){
 await page.getByLabel(label,{exact:true}).setInputFiles({name,mimeType:'image/png',buffer:png});
 await page.getByRole('button',{name:`上传${label}`,exact:true}).click();
 await expect(page.getByText(`${name} 已完整上传。`,{exact:true})).toBeVisible();
}
async function createApiReimbursement(api,token,amountCents,reason){
 const draft=await request(api,'/v1/finance/drafts',token,{kind:'REIMBURSEMENT',idempotencyKey:randomUUID()});
 const attachmentVersionIds=[];
 for(const purpose of ['SUPPORTING_DOCUMENT','APPLICATION_SCREENSHOT']){
  const reserved=await request(api,`/v1/finance/drafts/${draft.id}/attachment-uploads`,token,{
   purpose,originalFilename:`${reason}-${purpose}.png`,declaredMediaType:'image/png',declaredSizeBytes:png.length,
   expectedSha256:createHash('sha256').update(png).digest('hex'),idempotencyKey:randomUUID()
  });
  const uploaded=await api.post(`/v1/finance/attachment-uploads/${reserved.versionId}/content`,{headers:{...headers(token),'content-type':'image/png'},data:png});
  expect(uploaded.ok()).toBeTruthy(); attachmentVersionIds.push(reserved.versionId);
 }
 return request(api,`/v1/finance/drafts/${draft.id}/reimbursement-submit`,token,{expectedVersion:draft.version,amountCents,reason,attachmentVersionIds,idempotencyKey:randomUUID()});
}
async function openManaged(page,reason){
 await nav(page,'报销记录').click();
 await managed(page).locator('.finance-list-row').filter({hasText:reason}).getByRole('button',{name:'查看报销详情',exact:true}).click();
}

test('教师真实原件申请、未知提交同键恢复，HQ批准待划拨且不改余额',async({page})=>{
 await mkdir(evidence,{recursive:true});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const teacherRead=await session(page.request,'13800000001','TEACHING_TEACHER');
 await login(page,'13800000001','TEACHING_TEACHER');
 await expect(nav(page,'周费用录入')).toHaveAttribute('aria-current','page');
 await nav(page,'我的报销').click();
 const before=await request(page.request,'/v1/me',teacherRead);
 await page.getByRole('button',{name:'新建报销申请',exact:true}).click();
 await page.getByLabel('报销金额（欢乐豆）',{exact:true}).fill('43.21');
 await page.getByLabel('报销原因',{exact:true}).fill('WEB_REIMBURSE_APPROVE');
 await upload(page,'报销业务单据','reimbursement-document.png');
 await upload(page,'报销申请截图','reimbursement-application.png');
 await page.setViewportSize({width:390,height:844});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
 await page.screenshot({path:resolve(evidence,'reimbursement-submit-mobile.png'),fullPage:true});
 await page.setViewportSize({width:1440,height:1000});
 const submitBodies=[];
 await page.route('**/v1/finance/drafts/*/reimbursement-submit',async route=>{
  submitBodies.push(route.request().postDataJSON());
  if(submitBodies.length===1){const response=await route.fetch();expect(response.ok()).toBeTruthy();await route.abort('failed');}
  else await route.continue();
 });
 await mine(page).getByRole('button',{name:'确认提交报销申请',exact:true}).click();
 await expect(mine(page).getByRole('button',{name:'安全重试原报销申请',exact:true})).toBeEnabled();
 await expect(page.getByLabel('报销金额（欢乐豆）',{exact:true})).toBeDisabled();
 await expect(mine(page).getByRole('alert')).toContainText('尚不能确认');
 await nav(page,'周费用录入').click(); await nav(page,'我的报销').click();
 await page.getByRole('button',{name:'退出登录',exact:true}).click();
 await expect(page.locator('.message')).toContainText('结果待确认');
 await page.route('**/v1/finance/reimbursements/mine',route=>route.abort('failed'),{times:1});
 await mine(page).getByRole('button',{name:'安全重试原报销申请',exact:true}).click();
 await expect(mine(page).locator('.finance-success')).toContainText('报销申请已提交');
 await expect(mine(page).getByRole('alert')).toContainText('刷新失败');
 expect(submitBodies).toHaveLength(2);expect(submitBodies[1]).toEqual(submitBodies[0]);
 expect(Object.keys(submitBodies[0]).sort()).toEqual(['amountCents','attachmentVersionIds','expectedVersion','idempotencyKey','reason']);
 await page.getByRole('button',{name:'刷新报销记录',exact:true}).click();
 await mine(page).locator('.finance-list-row').filter({hasText:'WEB_REIMBURSE_APPROVE'}).getByRole('button',{name:'查看报销详情',exact:true}).click();
 await expect(mine(page).locator('dl.finance-detail')).toContainText('待审核');
 await expect(mine(page).getByRole('button',{name:'批准报销申请',exact:true})).toHaveCount(0);
 const downloaded=page.waitForEvent('download');
 await mine(page).getByRole('button',{name:'下载原件',exact:true}).first().click();
 expect(await readFile(await (await downloaded).path())).toEqual(png);
 // The request endpoint must not emit a balance event before a later, separate transfer feature exists.
 const afterSubmit=await request(page.request,'/v1/me',teacherRead);
 expect(afterSubmit.balanceCents).toBe(before.balanceCents);
 expect(afterSubmit.currentYearIncomeByCategory.reimbursementIncome??'0').toBe(before.currentYearIncomeByCategory.reimbursementIncome??'0');
 await nav(page,'教师工作台').click();
 await expect(page.locator('.overview')).toBeVisible();
 await expect(page.getByRole('heading',{name:'个人余额与收入正在等待更新',exact:true})).toHaveCount(0);
 await expect(page.getByText('账户可能已有新收支，最新余额尚未确认。请先确认操作结果，再刷新数据。',{exact:true})).toHaveCount(0);
 await nav(page,'我的报销').click();
 await page.getByRole('button',{name:'退出登录',exact:true}).click();
 await login(page,'13800000003','HEADQUARTERS_FINANCE'); await openManaged(page,'WEB_REIMBURSE_APPROVE');
 await expect(managed(page)).toContainText('申请人：演示授课老师');
 await expect(managed(page).getByRole('button',{name:'批准报销申请',exact:true})).toBeDisabled();
 await page.getByRole('textbox',{name:'审核原因',exact:true}).fill('WEB_REIMBURSE_APPROVE_REVIEW');
 const approvalBodies=[];
 await page.route('**/v1/finance/reimbursements/*/approve',async route=>{
  approvalBodies.push(route.request().postDataJSON());
  if(approvalBodies.length===1){const response=await route.fetch();expect(response.ok()).toBeTruthy();await route.abort('failed');}
  else await route.continue();
 });
 await page.getByRole('button',{name:'批准报销申请',exact:true}).click();
 await expect(managed(page).getByRole('button',{name:'安全重试原审核操作',exact:true})).toBeEnabled();
 await expect(page.getByRole('textbox',{name:'审核原因',exact:true})).toBeDisabled();
 await expect(managed(page).getByRole('button',{name:'驳回报销申请',exact:true})).toBeDisabled();
 await nav(page,'提现办理').click(); await nav(page,'报销记录').click();
 await page.route('**/v1/finance/reimbursements/managed',route=>route.abort('failed'),{times:1});
 await page.getByRole('button',{name:'安全重试原审核操作',exact:true}).click();
 await expect(managed(page).locator('.finance-success')).toContainText('审核已通过');
 await expect(managed(page).getByRole('alert')).toContainText('刷新失败');
 expect(approvalBodies).toHaveLength(2);expect(approvalBodies[1]).toEqual(approvalBodies[0]);
 await page.getByRole('button',{name:'刷新报销记录',exact:true}).click();await openManaged(page,'WEB_REIMBURSE_APPROVE');
 await expect(managed(page).locator('dl.finance-detail')).toContainText('审核通过');
 await expect(managed(page)).toContainText('WEB_REIMBURSE_APPROVE_REVIEW');
 await expect(managed(page)).not.toContainText('已完成');
 await expect(managed(page).getByRole('button',{name:/划拨|转账|执行/,exact:false})).toHaveCount(0);
 await page.screenshot({path:resolve(evidence,'reimbursement-approved.png'),fullPage:true});
 const afterApprove=await request(page.request,'/v1/me',teacherRead);
 expect(afterApprove.balanceCents).toBe(before.balanceCents);
 expect(afterApprove.currentYearIncomeByCategory.reimbursementIncome??'0').toBe(before.currentYearIncomeByCategory.reimbursementIncome??'0');
 const own=(await request(page.request,'/v1/finance/reimbursements/mine',teacherRead)).documents;
 const approved=own.find(item=>item.reason==='WEB_REIMBURSE_APPROVE');expect(approved).toBeDefined();
 const admin=await session(page.request,'13800000004','SYSTEM_ADMIN');
 const denied=await page.request.post('/v1/finance/reimbursements/'+encodeURIComponent(approved.id)+'/approve',{headers:headers(admin),data:{expectedVersion:approved.version,reason:'管理员越权验收',idempotencyKey:randomUUID()}});
 expect(denied.status()).toBe(403);
 await page.getByRole('button',{name:'退出登录',exact:true}).click();
 await login(page,'13800000004','SYSTEM_ADMIN');await openManaged(page,'WEB_REIMBURSE_APPROVE');
 await expect(managed(page).getByRole('button',{name:'批准报销申请',exact:true})).toHaveCount(0);
 await expect(managed(page).getByRole('button',{name:'驳回报销申请',exact:true})).toHaveCount(0);
 expect(errors).toEqual([]);
});

test('另一总部会话先驳回时真实409重读，旧审核不自动再次提交',async({page})=>{
 const teacher=await session(page.request,'13800000001','TEACHING_TEACHER');
 const beforeReject=await request(page.request,'/v1/me',teacher);
 const created=await createApiReimbursement(page.request,teacher,'1234','WEB_REIMBURSE_REJECT_OTHER');
 const otherHq=await session(page.request,'13800000003','HEADQUARTERS_FINANCE');
 await login(page,'13800000004','SYSTEM_ADMIN');await openManaged(page,'WEB_REIMBURSE_REJECT_OTHER');
 await expect(managed(page).getByRole('button',{name:'批准报销申请',exact:true})).toHaveCount(0);
 await expect(managed(page).getByRole('button',{name:'驳回报销申请',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'退出登录',exact:true}).click();
 await login(page,'13800000003','HEADQUARTERS_FINANCE'); await openManaged(page,'WEB_REIMBURSE_REJECT_OTHER');
 await page.getByRole('textbox',{name:'审核原因',exact:true}).fill('旧审核原因，应该在冲突后清除');
 const other=await request(page.request,`/v1/finance/reimbursements/${created.id}/reject`,otherHq,{expectedVersion:created.version,reason:'WEB_REIMBURSE_REJECT_OTHER_REVIEW',idempotencyKey:randomUUID()});
 expect(other.status).toBe('REJECTED');
 const reviewPosts=[];page.on('request',request=>{if(request.url().endsWith('/approve')&&request.method()==='POST')reviewPosts.push(request.postDataJSON());});
 const conflict=page.waitForResponse(response=>response.url().endsWith('/approve')&&response.status()===409);
 await page.getByRole('button',{name:'批准报销申请',exact:true}).click();await conflict;
 await expect(managed(page).getByRole('alert')).toContainText('状态已发生变化');
 await expect(managed(page)).toContainText('已驳回');
 await expect(page.getByRole('textbox',{name:'审核原因',exact:true})).toHaveCount(0);
 await expect(managed(page).getByRole('button',{name:'批准报销申请',exact:true})).toHaveCount(0);
 expect(reviewPosts).toHaveLength(1);
 await page.getByRole('button',{name:'刷新报销记录',exact:true}).click();await openManaged(page,'WEB_REIMBURSE_REJECT_OTHER');
 await expect(managed(page)).toContainText('WEB_REIMBURSE_REJECT_OTHER_REVIEW');
 await expect(managed(page).locator('dl.finance-detail')).toContainText('12.34');
 await page.screenshot({path:resolve(evidence,'reimbursement-conflict-resolved.png'),fullPage:true});
 const afterReject=await request(page.request,'/v1/me',teacher);
 expect(afterReject.balanceCents).toBe(beforeReject.balanceCents);
 expect(afterReject.currentYearIncomeByCategory.reimbursementIncome??'0').toBe(beforeReject.currentYearIncomeByCategory.reimbursementIncome??'0');
});
