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
 const reason=`WEB_REIMBURSE_APPROVE_${randomUUID()}`;
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const teacherRead=await session(page.request,'13800000001','TEACHING_TEACHER');
 await login(page,'13800000001','TEACHING_TEACHER');
 await expect(nav(page,'周费用录入')).toHaveAttribute('aria-current','page');
 await nav(page,'我的报销').click();
 const before=await request(page.request,'/v1/me',teacherRead);
 await page.getByRole('button',{name:'新建报销申请',exact:true}).click();
 await page.getByLabel('报销金额（欢乐豆）',{exact:true}).fill('43.21');
 await page.getByLabel('报销原因',{exact:true}).fill(reason);
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
 await expect(nav(page,'周费用录入')).toBeDisabled();
 await expect(nav(page,'教师工作台')).toBeDisabled();
 await page.getByRole('button',{name:'退出登录',exact:true}).click();
 await expect(page.locator('.message')).toContainText('结果待确认');
 await page.route('**/v1/finance/reimbursements/mine',route=>route.abort('failed'),{times:1});
 await mine(page).getByRole('button',{name:'安全重试原报销申请',exact:true}).click();
 await expect(mine(page).locator('.finance-success')).toContainText('报销申请已提交');
 await expect(mine(page).getByRole('alert')).toContainText('刷新失败');
 await expect(nav(page,'周费用录入')).toBeEnabled();
 expect(submitBodies).toHaveLength(2);expect(submitBodies[1]).toEqual(submitBodies[0]);
 expect(Object.keys(submitBodies[0]).sort()).toEqual(['amountCents','attachmentVersionIds','expectedVersion','idempotencyKey','reason']);
 await page.getByRole('button',{name:'刷新报销记录',exact:true}).click();
 await mine(page).locator('.finance-list-row').filter({hasText:reason}).getByRole('button',{name:'查看报销详情',exact:true}).click();
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
 await login(page,'13800000003','HEADQUARTERS_FINANCE'); await openManaged(page,reason);
 await expect(managed(page)).toContainText('申请人：演示授课老师');
 await expect(managed(page).getByRole('button',{name:'批准报销申请',exact:true})).toBeDisabled();
 const reviewReason=`${reason}_REVIEW`;
 await page.getByRole('textbox',{name:'审核原因',exact:true}).fill(reviewReason);
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
 await expect(nav(page,'提现办理')).toBeDisabled();
 await expect(nav(page,'报销记录')).toBeDisabled();
 await page.route('**/v1/finance/reimbursements/managed',route=>route.abort('failed'),{times:1});
 await page.getByRole('button',{name:'安全重试原审核操作',exact:true}).click();
 await expect(managed(page).locator('.finance-success')).toContainText('审核已通过');
 await expect(managed(page).getByRole('alert')).toContainText('刷新失败');
 await expect(nav(page,'提现办理')).toBeEnabled();
 expect(approvalBodies).toHaveLength(2);expect(approvalBodies[1]).toEqual(approvalBodies[0]);
 await page.getByRole('button',{name:'刷新报销记录',exact:true}).click();await openManaged(page,reason);
 await expect(managed(page).locator('dl.finance-detail')).toContainText('审核通过');
 await expect(managed(page)).toContainText(reviewReason);
 await expect(managed(page).locator('dl.finance-detail')).not.toContainText('已完成');
 await expect(managed(page).getByRole('button',{name:'执行内部欢乐豆划拨',exact:true})).toBeEnabled();
 await page.screenshot({path:resolve(evidence,'reimbursement-approved.png'),fullPage:true});
 const afterApprove=await request(page.request,'/v1/me',teacherRead);
 expect(afterApprove.balanceCents).toBe(before.balanceCents);
 expect(afterApprove.currentYearIncomeByCategory.reimbursementIncome??'0').toBe(before.currentYearIncomeByCategory.reimbursementIncome??'0');
 const own=(await request(page.request,'/v1/finance/reimbursements/mine',teacherRead)).documents;
 const approved=own.find(item=>item.reason===reason);expect(approved).toBeDefined();
 const admin=await session(page.request,'13800000004','SYSTEM_ADMIN');
 const denied=await page.request.post('/v1/finance/reimbursements/'+encodeURIComponent(approved.id)+'/approve',{headers:headers(admin),data:{expectedVersion:approved.version,reason:'管理员越权验收',idempotencyKey:randomUUID()}});
 expect(denied.status()).toBe(403);
 await page.getByRole('button',{name:'退出登录',exact:true}).click();
 await login(page,'13800000004','SYSTEM_ADMIN');await openManaged(page,reason);
 await expect(managed(page).getByRole('button',{name:'批准报销申请',exact:true})).toHaveCount(0);
 await expect(managed(page).getByRole('button',{name:'驳回报销申请',exact:true})).toHaveCount(0);
 expect(errors).toEqual([]);
});

test('另一总部会话先驳回时真实409重读，旧审核不自动再次提交',async({page})=>{
 const teacher=await session(page.request,'13800000001','TEACHING_TEACHER');
 const beforeReject=await request(page.request,'/v1/me',teacher);
 const reason=`WEB_REIMBURSE_REJECT_OTHER_${randomUUID()}`;
 const created=await createApiReimbursement(page.request,teacher,'1234',reason);
 const otherHq=await session(page.request,'13800000003','HEADQUARTERS_FINANCE');
 await login(page,'13800000004','SYSTEM_ADMIN');await openManaged(page,reason);
 await expect(managed(page).getByRole('button',{name:'批准报销申请',exact:true})).toHaveCount(0);
 await expect(managed(page).getByRole('button',{name:'驳回报销申请',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'退出登录',exact:true}).click();
 await login(page,'13800000003','HEADQUARTERS_FINANCE'); await openManaged(page,reason);
 await page.getByRole('textbox',{name:'审核原因',exact:true}).fill('旧审核原因，应该在冲突后清除');
 const reviewReason=`${reason}_REVIEW`;
 const other=await request(page.request,`/v1/finance/reimbursements/${created.id}/reject`,otherHq,{expectedVersion:created.version,reason:reviewReason,idempotencyKey:randomUUID()});
 expect(other.status).toBe('REJECTED');
 const reviewPosts=[];page.on('request',request=>{if(request.url().endsWith('/approve')&&request.method()==='POST')reviewPosts.push(request.postDataJSON());});
 const conflict=page.waitForResponse(response=>response.url().endsWith('/approve')&&response.status()===409);
 await page.getByRole('button',{name:'批准报销申请',exact:true}).click();await conflict;
 await expect(managed(page).getByRole('alert')).toContainText('状态已发生变化');
 await expect(managed(page)).toContainText('已驳回');
 await expect(page.getByRole('textbox',{name:'审核原因',exact:true})).toHaveCount(0);
 await expect(managed(page).getByRole('button',{name:'批准报销申请',exact:true})).toHaveCount(0);
 expect(reviewPosts).toHaveLength(1);
 await page.getByRole('button',{name:'刷新报销记录',exact:true}).click();await openManaged(page,reason);
 await expect(managed(page)).toContainText(reviewReason);
 await expect(managed(page).locator('dl.finance-detail')).toContainText('12.34');
 await page.screenshot({path:resolve(evidence,'reimbursement-conflict-resolved.png'),fullPage:true});
 const afterReject=await request(page.request,'/v1/me',teacher);
 expect(afterReject.balanceCents).toBe(beforeReject.balanceCents);
 expect(afterReject.currentYearIncomeByCategory.reimbursementIncome??'0').toBe(beforeReject.currentYearIncomeByCategory.reimbursementIncome??'0');
});

test('已完成报销在真实网页组件保留原件和内部划拨时间；全局办理人可撤销，个人不见管理关系',async({page})=>{
 const id='11111111-1111-4111-8111-111111111111';
 const completed={id,status:'COMPLETED',version:4,amountCents:'7000',reason:'WEB_COMPLETED_RENDER',applicantPersonId:'22222222-2222-4222-8222-222222222222',applicantDisplayName:'完成态老师',submittedAt:'2026-09-21T00:00:00.000Z',completedAt:'2026-09-22T00:00:00.000Z'};
 const detail={...completed,decision:{decision:'APPROVED',reason:'资料核验完成',decidedAt:'2026-09-21T01:00:00.000Z'},attachments:[
  {versionId:'33333333-3333-4333-8333-333333333333',purpose:'SUPPORTING_DOCUMENT',originalFilename:'completed-support.png',mediaType:'image/png',sizeBytes:8,sha256:'a'.repeat(64)},
  {versionId:'44444444-4444-4444-8444-444444444444',purpose:'APPLICATION_SCREENSHOT',originalFilename:'completed-screen.png',mediaType:'image/png',sizeBytes:8,sha256:'b'.repeat(64)}
 ],management:{destinationAccountId:'destination-account',submittedByPersonId:'22222222-2222-4222-8222-222222222222',applicantContextSubject:'TEACHING_TEACHER',applicantContextScope:'SELF',completion:{roleAssignmentId:'role-assignment',companyFundAssignmentId:'fund-assignment',sourceAccountId:'source-account',destinationAccountId:'destination-account',ledgerEventId:'ledger-event',executedByPersonId:'executor-person',executedAt:'2026-09-22T00:00:00.000Z'}}};
 const envelope=data=>({version:'test',data});
 await page.route('**/v1/finance/reimbursements/managed',route=>route.fulfill({contentType:'application/json',body:JSON.stringify(envelope({documents:[completed]}))}));
 await page.route(`**/v1/finance/reimbursements/${id}`,route=>route.fulfill({contentType:'application/json',body:JSON.stringify(envelope(detail))}));
 await login(page,'13800000003','HEADQUARTERS_FINANCE');await openManaged(page,'WEB_COMPLETED_RENDER');
 await expect(managed(page).locator('dl.finance-detail')).toContainText('已完成');
 await expect(managed(page).locator('dl.finance-detail')).toContainText('审核通过');
 await expect(managed(page).locator('dl.finance-detail')).not.toContainText('审核通过·待划拨');
 await expect(managed(page)).toContainText('内部划拨完成时间');
 await expect(managed(page)).toContainText('completed-support.png');await expect(managed(page)).toContainText('completed-screen.png');
 await expect(managed(page)).toContainText('source-account');await expect(managed(page)).toContainText('destination-account');
 await expect(managed(page).getByRole('button',{name:'下载原件',exact:true})).toHaveCount(2);
 const reverse=managed(page).getByRole('button',{name:'撤销划拨',exact:true});
 await expect(reverse).toBeVisible();await expect(reverse).toBeDisabled();
 await page.getByRole('textbox',{name:'撤销原因',exact:true}).fill('仅验证可撤销入口，不执行');
 await expect(reverse).toBeEnabled();
 await expect(managed(page).getByRole('button',{name:/批准报销申请|驳回报销申请|执行内部欢乐豆划拨/})).toHaveCount(0);
 await page.getByRole('button',{name:'退出登录',exact:true}).click();
 await page.route('**/v1/finance/reimbursements/mine',route=>route.fulfill({contentType:'application/json',body:JSON.stringify(envelope({documents:[completed]}))}));
 await login(page,'13800000001','TEACHING_TEACHER');await nav(page,'我的报销').click();
 await mine(page).locator('.finance-list-row').filter({hasText:'WEB_COMPLETED_RENDER'}).getByRole('button',{name:'查看报销详情',exact:true}).click();
 await expect(mine(page)).toContainText('已完成');await expect(mine(page)).toContainText('completed-support.png');await expect(mine(page)).toContainText('不表示银行卡到账');
 await expect(mine(page)).not.toContainText('source-account');await expect(mine(page)).not.toContainText('destination-account');
 await expect(mine(page).getByRole('button',{name:'撤销划拨',exact:true})).toHaveCount(0);
 await expect(mine(page).getByRole('button',{name:/批准报销申请|驳回报销申请|执行内部欢乐豆划拨/})).toHaveCount(0);
});

test('总部财务在真实网页组件以同一请求安全重试已批准报销的内部划拨',async({page})=>{
 const id='55555555-5555-4555-8555-555555555555';
 let state='APPROVED';
 const summary=()=>({id,status:state,version:state==='APPROVED'?3:4,amountCents:'7000',reason:'WEB_EXECUTE_RENDER',applicantPersonId:'22222222-2222-4222-8222-222222222222',applicantDisplayName:'划拨老师',submittedAt:'2026-09-21T00:00:00.000Z',...(state==='COMPLETED'?{completedAt:'2026-09-22T00:00:00.000Z'}:{})});
 const detail=()=>({...summary(),decision:{decision:'APPROVED',reason:'资料核验完成',decidedAt:'2026-09-21T01:00:00.000Z'},attachments:[
  {versionId:'66666666-6666-4666-8666-666666666666',purpose:'SUPPORTING_DOCUMENT',originalFilename:'execute-support.png',mediaType:'image/png',sizeBytes:8,sha256:'a'.repeat(64)},
  {versionId:'77777777-7777-4777-8777-777777777777',purpose:'APPLICATION_SCREENSHOT',originalFilename:'execute-screen.png',mediaType:'image/png',sizeBytes:8,sha256:'b'.repeat(64)}
 ],management:{destinationAccountId:'destination-account',submittedByPersonId:'22222222-2222-4222-8222-222222222222',applicantContextSubject:'TEACHING_TEACHER',applicantContextScope:'SELF',...(state==='COMPLETED'?{completion:{roleAssignmentId:'role-assignment',companyFundAssignmentId:'fund-assignment',sourceAccountId:'source-account',destinationAccountId:'destination-account',ledgerEventId:'ledger-event',executedByPersonId:'executor-person',executedAt:'2026-09-22T00:00:00.000Z'}}:{})}});
 const envelope=data=>({version:'test',data}); const bodies=[];
 await page.route('**/v1/finance/reimbursements/managed',route=>route.fulfill({contentType:'application/json',body:JSON.stringify(envelope({documents:[summary()]}))}));
 await page.route(`**/v1/finance/reimbursements/${id}`,route=>route.fulfill({contentType:'application/json',body:JSON.stringify(envelope(detail()))}));
 await page.route(`**/v1/finance/reimbursements/${id}/execute`,async route=>{
  bodies.push(route.request().postDataJSON()); state='COMPLETED';
  if(bodies.length===1) await route.abort('failed');
  else await route.fulfill({contentType:'application/json',body:JSON.stringify(envelope({id,status:'COMPLETED',version:4,replay:true}))});
 });
 await login(page,'13800000003','HEADQUARTERS_FINANCE');await openManaged(page,'WEB_EXECUTE_RENDER');
 await expect(managed(page).getByRole('button',{name:'执行内部欢乐豆划拨',exact:true})).toBeEnabled();
 await managed(page).getByRole('button',{name:'执行内部欢乐豆划拨',exact:true}).click();
 await expect(managed(page).getByRole('button',{name:'安全重试原内部划拨',exact:true})).toBeEnabled();
 await expect(managed(page).getByRole('button',{name:'执行内部欢乐豆划拨',exact:true})).toBeDisabled();
 await managed(page).getByRole('button',{name:'安全重试原内部划拨',exact:true}).click();
 expect(bodies).toHaveLength(2);expect(bodies[1]).toEqual(bodies[0]);
 expect(bodies[0]).toMatchObject({expectedVersion:3});expect(bodies[0].sourceAccountId).toBeUndefined();expect(bodies[0].amountCents).toBeUndefined();
 await expect(managed(page).locator('dl.finance-detail')).toContainText('已完成');
 await expect(managed(page)).toContainText('内部划拨完成时间');await expect(managed(page)).toContainText('execute-support.png');await expect(managed(page)).toContainText('execute-screen.png');
 await expect(managed(page).getByRole('button',{name:/执行内部欢乐豆划拨|批准报销申请|驳回报销申请/})).toHaveCount(0);
});

test('总部财务在真实网页组件以同一请求安全重试撤销划拨，并显示冲回而非银行退款',async({page})=>{
 const id='88888888-8888-4888-8888-888888888888';let state='COMPLETED';const reason='WEB_REVERSE_RENDER';
 const summary=()=>({id,status:state,version:state==='COMPLETED'?4:5,amountCents:'7000',reason,applicantPersonId:'22222222-2222-4222-8222-222222222222',applicantDisplayName:'撤销老师',submittedAt:'2026-09-21T00:00:00.000Z',completedAt:'2026-09-22T00:00:00.000Z',...(state==='REVERSED'?{reversedAt:'2026-09-23T00:00:00.000Z',reversalReason:'重复划拨，冲回原欢乐豆'}:{})});
 const detail=()=>({...summary(),decision:{decision:'APPROVED',reason:'资料核验完成',decidedAt:'2026-09-21T01:00:00.000Z'},attachments:[],management:{destinationAccountId:'destination-account',submittedByPersonId:'22222222-2222-4222-8222-222222222222',applicantContextSubject:'TEACHING_TEACHER',applicantContextScope:'SELF',completion:{roleAssignmentId:'role-assignment',companyFundAssignmentId:'fund-assignment',sourceAccountId:'source-account',destinationAccountId:'destination-account',ledgerEventId:'ledger-event',executedByPersonId:'executor-person',executedAt:'2026-09-22T00:00:00.000Z'},...(state==='REVERSED'?{reversal:{sourceAccountId:'source-account',destinationAccountId:'destination-account',originalLedgerEventId:'original-ledger',reversalLedgerEventId:'reversal-ledger',reversedByPersonId:'executor-person',actorSubjectCode:'HEADQUARTERS_FINANCE',actorScopeType:'GLOBAL',reversedAt:'2026-09-23T00:00:00.000Z'}}:{})}});
 const envelope=data=>({version:'test',data});const bodies=[];
 await page.route('**/v1/finance/reimbursements/managed',route=>route.fulfill({contentType:'application/json',body:JSON.stringify(envelope({documents:[summary()]}))}));
 await page.route(`**/v1/finance/reimbursements/${id}`,route=>route.fulfill({contentType:'application/json',body:JSON.stringify(envelope(detail()))}));
 await page.route(`**/v1/finance/reimbursements/${id}/reverse`,async route=>{bodies.push(route.request().postDataJSON());state='REVERSED';if(bodies.length===1)await route.abort('failed');else await route.fulfill({contentType:'application/json',body:JSON.stringify(envelope({id,status:'REVERSED',version:5,replay:true}))});});
 await login(page,'13800000003','HEADQUARTERS_FINANCE');await openManaged(page,reason);
 await page.getByRole('textbox',{name:'撤销原因',exact:true}).fill('重复划拨，冲回原欢乐豆');await page.getByRole('button',{name:'撤销划拨',exact:true}).click();
 await expect(managed(page).getByRole('button',{name:'安全重试原撤销划拨',exact:true})).toBeEnabled();
 await expect(managed(page).getByRole('button',{name:'撤销划拨',exact:true})).toBeDisabled();
 await managed(page).getByRole('button',{name:'安全重试原撤销划拨',exact:true}).click();
 expect(bodies).toHaveLength(2);expect(bodies[1]).toEqual(bodies[0]);expect(bodies[0]).toEqual({expectedVersion:4,reason:'重复划拨，冲回原欢乐豆',idempotencyKey:bodies[0].idempotencyKey});
 await expect(managed(page).locator('dl.finance-detail')).toContainText('已撤销');await expect(managed(page)).toContainText('内部划拨完成时间');await expect(managed(page)).toContainText('撤销划拨时间');await expect(managed(page)).toContainText('不是银行退款');
 await expect(managed(page).getByRole('button',{name:'撤销划拨',exact:true})).toHaveCount(0);
});

test('真实合成API：总部财务执行已批准报销后，申请人收入和完成记录同步更新',async({page})=>{
 const teacher=await session(page.request,'13800000001','TEACHING_TEACHER');
 const reason=`WEB_EXECUTE_LIVE_${randomUUID()}`;
 const before=await request(page.request,'/v1/me',teacher);
 const submitted=await createApiReimbursement(page.request,teacher,'7000',reason);
 const hq=await session(page.request,'13800000003','HEADQUARTERS_FINANCE');
 const approved=await request(page.request,`/v1/finance/reimbursements/${submitted.id}/approve`,hq,{expectedVersion:submitted.version,reason:'WEB_EXECUTE_LIVE_APPROVED',idempotencyKey:randomUUID()});
 expect(approved.status).toBe('APPROVED');
 await login(page,'13800000003','HEADQUARTERS_FINANCE');await openManaged(page,reason);
 await expect(managed(page).getByRole('button',{name:'执行内部欢乐豆划拨',exact:true})).toBeEnabled();
 await managed(page).getByRole('button',{name:'执行内部欢乐豆划拨',exact:true}).click();
 await expect(managed(page).locator('.finance-success')).toContainText('内部欢乐豆划拨已完成');
 await expect(managed(page).locator('dl.finance-detail')).toContainText('已完成');
 await expect(managed(page).getByRole('button',{name:/执行内部欢乐豆划拨|批准报销申请|驳回报销申请/})).toHaveCount(0);
 const own=(await request(page.request,'/v1/finance/reimbursements/mine',teacher)).documents;
 const completed=own.find(item=>item.id===submitted.id);expect(completed?.status).toBe('COMPLETED');expect(completed?.completedAt).toBeTruthy();
 const after=await request(page.request,'/v1/me',teacher);
 expect(after.balanceCents).toBe((BigInt(before.balanceCents)+7000n).toString());
 expect(after.currentYearIncomeByCategory.reimbursementIncome??'0').toBe(((BigInt(before.currentYearIncomeByCategory.reimbursementIncome??'0'))+7000n).toString());
});

test('真实合成API：总部财务撤销已完成报销，原件保留且个人余额和收入冲回',async({page})=>{
 await mkdir(evidence,{recursive:true});
 const teacher=await session(page.request,'13800000001','TEACHING_TEACHER');
 const reason=`WEB_REVERSE_LIVE_${randomUUID()}`;
 const reversalReason=`${reason}_CORRECTION`;
 const before=await request(page.request,'/v1/me',teacher);
 const submitted=await createApiReimbursement(page.request,teacher,'7000',reason);
 const hq=await session(page.request,'13800000003','HEADQUARTERS_FINANCE');
 const approved=await request(page.request,`/v1/finance/reimbursements/${submitted.id}/approve`,hq,{expectedVersion:submitted.version,reason:'WEB_REVERSE_LIVE_APPROVED',idempotencyKey:randomUUID()});
 const completed=await request(page.request,`/v1/finance/reimbursements/${submitted.id}/execute`,hq,{expectedVersion:approved.version,idempotencyKey:randomUUID()});
 expect(completed).toMatchObject({id:submitted.id,status:'COMPLETED',version:4});
 const afterExecute=await request(page.request,'/v1/me',teacher);
 expect(afterExecute.balanceCents).toBe((BigInt(before.balanceCents)+7000n).toString());
 await login(page,'13800000003','HEADQUARTERS_FINANCE');await openManaged(page,reason);
 await expect(managed(page).locator('[data-reimbursement-action="reverse"]')).toBeVisible();
 await page.getByRole('textbox',{name:'撤销原因',exact:true}).fill(reversalReason);
 await managed(page).getByRole('button',{name:'撤销划拨',exact:true}).click();
 await expect(managed(page).locator('.finance-success')).toContainText('撤销划拨已完成');
 await expect(managed(page).locator('dl.finance-detail')).toContainText('已撤销');
 await expect(managed(page).locator('dl.finance-detail')).toContainText('撤销划拨时间');
 await expect(managed(page).locator('dl.finance-detail')).toContainText(reversalReason);
 await expect(managed(page).getByRole('button',{name:/撤销划拨|执行内部欢乐豆划拨|批准报销申请|驳回报销申请/})).toHaveCount(0);
 await page.screenshot({path:resolve(evidence,'reimbursement-reversed.png'),fullPage:true});
 const downloaded=page.waitForEvent('download');
 await managed(page).getByRole('button',{name:'下载原件',exact:true}).first().click();
 expect(await readFile(await (await downloaded).path())).toEqual(png);
 const own=(await request(page.request,'/v1/finance/reimbursements/mine',teacher)).documents;
 expect(own.find(item=>item.id===submitted.id)).toMatchObject({status:'REVERSED',version:5,reversalReason});
 const afterReverse=await request(page.request,'/v1/me',teacher);
 expect(afterReverse.balanceCents).toBe(before.balanceCents);
 expect(afterReverse.currentYearIncomeByCategory.reimbursementIncome??'0').toBe(before.currentYearIncomeByCategory.reimbursementIncome??'0');
 await page.getByRole('button',{name:'退出登录',exact:true}).click();
 await login(page,'13800000001','TEACHING_TEACHER');await nav(page,'我的报销').click();
 await mine(page).locator('.finance-list-row').filter({hasText:reason}).getByRole('button',{name:'查看报销详情',exact:true}).click();
 await expect(mine(page).locator('dl.finance-detail')).toContainText('已撤销');
 await expect(mine(page)).toContainText('撤销划拨时间');
 await expect(mine(page)).toContainText(reversalReason);
 await expect(mine(page).getByRole('button',{name:/撤销划拨|执行内部欢乐豆划拨|批准报销申请|驳回报销申请/})).toHaveCount(0);
});

test('撤销409重读最新记录且不自动重发旧撤销命令',async({page})=>{
 const id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';const reason='WEB_REVERSE_CONFLICT';let state='COMPLETED';const bodies=[];
 const summary=()=>({id,status:state,version:state==='COMPLETED'?4:5,amountCents:'7000',reason,applicantPersonId:'22222222-2222-4222-8222-222222222222',applicantDisplayName:'冲突老师',submittedAt:'2026-09-21T00:00:00.000Z',completedAt:'2026-09-22T00:00:00.000Z',...(state==='REVERSED'?{reversedAt:'2026-09-23T00:00:00.000Z',reversalReason:'其他财务已撤销'}:{})});
 const detail=()=>({...summary(),decision:{decision:'APPROVED',reason:'资料核验完成',decidedAt:'2026-09-21T01:00:00.000Z'},attachments:[{versionId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',purpose:'SUPPORTING_DOCUMENT',originalFilename:'conflict-support.png',mediaType:'image/png',sizeBytes:8,sha256:'a'.repeat(64)},{versionId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',purpose:'APPLICATION_SCREENSHOT',originalFilename:'conflict-screen.png',mediaType:'image/png',sizeBytes:8,sha256:'b'.repeat(64)}],management:{destinationAccountId:'destination-account',submittedByPersonId:'22222222-2222-4222-8222-222222222222',applicantContextSubject:'TEACHING_TEACHER',applicantContextScope:'SELF',completion:{roleAssignmentId:'role-assignment',companyFundAssignmentId:'fund-assignment',sourceAccountId:'source-account',destinationAccountId:'destination-account',ledgerEventId:'ledger-event',executedByPersonId:'executor-person',executedAt:'2026-09-22T00:00:00.000Z'},...(state==='REVERSED'?{reversal:{sourceAccountId:'source-account',destinationAccountId:'destination-account',originalLedgerEventId:'ledger-event',reversalLedgerEventId:'conflict-ledger-event',reversedByPersonId:'other-finance',actorSubjectCode:'SYSTEM_ADMIN',actorScopeType:'GLOBAL',reversedAt:'2026-09-23T00:00:00.000Z'}}:{})}});
 const envelope=data=>({version:'test',data});
 await page.route('**/v1/finance/reimbursements/managed',route=>route.fulfill({contentType:'application/json',body:JSON.stringify(envelope({documents:[summary()]}))}));
 await page.route(`**/v1/finance/reimbursements/${id}`,route=>route.fulfill({contentType:'application/json',body:JSON.stringify(envelope(detail()))}));
 await page.route(`**/v1/finance/reimbursements/${id}/reverse`,async route=>{bodies.push(route.request().postDataJSON());state='REVERSED';await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({version:'test',error:{code:'VERSION_CONFLICT',message:'VERSION_CONFLICT'}})});});
 await login(page,'13800000003','HEADQUARTERS_FINANCE');await openManaged(page,reason);
 await page.getByRole('textbox',{name:'撤销原因',exact:true}).fill('旧撤销原因应在冲突后清除');
 await managed(page).getByRole('button',{name:'撤销划拨',exact:true}).click();
 await expect(managed(page).getByRole('alert')).toContainText('单据状态已发生变化');
 await expect(managed(page).locator('dl.finance-detail')).toContainText('已撤销');
 await expect(managed(page).locator('dl.finance-detail')).toContainText('其他财务已撤销');
 await expect(page.getByRole('textbox',{name:'撤销原因',exact:true})).toHaveCount(0);
 await expect(managed(page).getByRole('button',{name:/安全重试原撤销划拨|撤销划拨/})).toHaveCount(0);
 expect(bodies).toHaveLength(1);
});
