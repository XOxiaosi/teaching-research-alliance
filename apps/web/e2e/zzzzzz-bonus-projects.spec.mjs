import {test,expect} from '@playwright/test';
async function login(page,phone){
 await page.goto('/');await page.getByLabel('手机号',{exact:true}).fill(phone);await page.getByLabel('密码',{exact:true}).fill('Local-demo-only-2026');await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();
}
test('管理员维护奖金名称并持久化，丢失响应后同命令重试',async({page})=>{
 test.skip(process.env.ALLIANCE_SYNTHETIC_E2E!=='1','Requires isolated synthetic demo');
 await login(page,'13800000004');await page.getByRole('button',{name:'奖金项目名称',exact:true}).click();
 const panel=page.getByRole('region',{name:'奖金项目名称维护',exact:true});
 const first=panel.locator('article').filter({has:page.getByRole('heading',{name:'项目1',exact:true})});
 const name=panel.getByLabel('项目1新名称',{exact:true});await expect(name).toBeEnabled();const original=await name.inputValue();
 const sent=[];const received=[];
 await page.route('**/v1/admin/bonus-projects/1/name',async route=>{
   sent.push(route.request().postDataJSON());const response=await route.fetch();received.push(await response.json());
   if(sent.length===1)await route.abort('failed');else await route.fulfill({response});
 });
 await name.fill('合成浏览器验证奖金');await panel.getByLabel('项目1变更理由',{exact:true}).fill('合成环境验证响应丢失安全重试');await first.getByRole('button',{name:'保存名称',exact:true}).click();
 await expect(first.getByRole('button',{name:'使用原提交重试',exact:true})).toBeVisible();await expect(name).toBeDisabled();await expect(panel.getByLabel('项目2新名称',{exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'工资管理',exact:true}).click();await expect(panel).toBeVisible();
 await first.getByRole('button',{name:'使用原提交重试',exact:true}).click();await expect(name).toBeEnabled();await expect(first.getByText(/当前名称：合成浏览器验证奖金/)).toBeVisible();
 expect(sent).toHaveLength(2);expect(sent[1]).toEqual(sent[0]);expect(received[1].data.nameVersionId).toEqual(received[0].data.nameVersionId);
 await page.unroute('**/v1/admin/bonus-projects/1/name');
 await name.fill(original);await panel.getByLabel('项目1变更理由',{exact:true}).fill('恢复合成演示项目名称');await first.getByRole('button',{name:'保存名称',exact:true}).click();await expect(first.getByText(new RegExp(`当前名称：${original}`))).toBeVisible();
});
test('总部财务只读奖金目录，个人教师没有入口',async({page})=>{
 test.skip(process.env.ALLIANCE_SYNTHETIC_E2E!=='1','Requires isolated synthetic demo');
 await login(page,'13800000003');await page.getByLabel('当前身份',{exact:true}).selectOption('HEADQUARTERS_FINANCE');await page.getByRole('button',{name:'奖金项目名称',exact:true}).click();
 const panel=page.getByRole('region',{name:'奖金项目名称维护',exact:true});await expect(panel.locator('article')).toHaveCount(10);await expect(panel.getByRole('button',{name:'保存名称',exact:true})).toHaveCount(0);
 await page.getByLabel('当前身份',{exact:true}).selectOption('TEACHING_TEACHER');await expect(page.getByRole('button',{name:'奖金项目名称',exact:true})).toHaveCount(0);await expect(panel).toHaveCount(0);
});
