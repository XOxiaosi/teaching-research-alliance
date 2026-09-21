import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTIONS,
  ENDPOINT_CONTRACTS,
  PERMISSION_RULES,
  hasPermission,
  permissionScope
} from "../dist/index.js";

test("权限契约覆盖开发者、管理员和基础教师能力", () => {
  assert.equal(hasPermission("SYSTEM_OWNER", "EXPORT_FULL_BACKUP"), true);
  assert.equal(hasPermission("SYSTEM_ADMIN", "CONFIGURE_RATES"), true);
  assert.equal(hasPermission("TEACHING_TEACHER", "CREATE_WEEKLY_FEE"), true);
  assert.equal(permissionScope("TEACHING_TEACHER", "CREATE_WEEKLY_FEE"), "SELF");
});

test("分区财务只读个人余额与收入汇总，不得到逐笔结算或导出权限", () => {
  assert.equal(hasPermission("REGION_FINANCE", "VIEW_REGION_PERSONAL_SUMMARY"), true);
  assert.equal(hasPermission("REGION_FINANCE", "VIEW_OWN_CURRENT_YEAR_SETTLEMENT"), false);
  assert.equal(hasPermission("REGION_FINANCE", "EXPORT_FULL_BACKUP"), false);
});

test("财务业务账户配置只授予最高维护角色，不跟随财务办理权限",()=>{
  for(const subject of ['SYSTEM_ADMIN','SYSTEM_OWNER'])assert.equal(permissionScope(subject,'MANAGE_COMPANY_FUNDS'),'GLOBAL');
  for(const subject of ['HEADQUARTERS_FINANCE','REGION_FINANCE','TEACHING_TEACHER','CAMPUS_PRINCIPAL'])assert.equal(hasPermission(subject,'MANAGE_COMPANY_FUNDS'),false);
});

test("场地选用与共享查看/提现是独立能力", () => {
  assert.equal(hasPermission("TEACHING_TEACHER", "CREATE_WEEKLY_FEE"), true);
  assert.equal(hasPermission("TEACHING_TEACHER", "VIEW_SHARED_VENUE_BOARD"), true);
  assert.equal(hasPermission("TEACHING_TEACHER", "WITHDRAW_FROM_SHARED_VENUE"), true);
  assert.equal(ACTIONS.includes("CONFIGURE_RATES"), true);
  assert.equal(hasPermission("VENUE_OWNER", "CONFIGURE_RATES"), false);
});

test("契约规则没有重复动作定义", () => {
  const keys = PERMISSION_RULES.map((item) => `${item.subject}:${item.action}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("提现提交、财务办理和凭证查阅各自授权，分区不取得财务能力",()=>{
  for(const subject of ['TEACHING_TEACHER','ACADEMIC_PLANNER','PLANNING_MENTOR']){
    assert.equal(hasPermission(subject,'CREATE_PERSONAL_WITHDRAWAL'),true);
    assert.equal(hasPermission(subject,'READ_OWN_WITHDRAWAL'),true);
    assert.equal(hasPermission(subject,'PROCESS_WITHDRAWAL'),false);
  }
  assert.equal(hasPermission('HEADQUARTERS_FINANCE','PROCESS_WITHDRAWAL'),true);
  for(const action of ['UPLOAD_FINANCE_RECEIPT','READ_MANAGED_FINANCE_ATTACHMENT','PROCESS_WITHDRAWAL','READ_MANAGED_WITHDRAWAL'])assert.equal(hasPermission('REGION_FINANCE',action),false);
  assert.equal(ENDPOINT_CONTRACTS.some(item=>item.path==='/v1/accounts/:accountId/withdrawals'),false);
  const attachment=ENDPOINT_CONTRACTS.find(item=>item.path==='/v1/finance/attachments/:versionId/content');
  assert.deepEqual(attachment.alternativeActions,['READ_MANAGED_FINANCE_ATTACHMENT']);
});

test("端点契约包含分区汇总、关系预览和全正常场地目录", () => {
  assert.equal(ENDPOINT_CONTRACTS.some((item) => item.path === "/v1/regions/:regionId/person-summaries"), true);
  assert.equal(ENDPOINT_CONTRACTS.some((item) => item.path === "/v1/admin/person-relationships/preview"), true);
  assert.equal(ENDPOINT_CONTRACTS.some((item) => item.path === "/v1/venues/available"), true);
});

 test("teaching directory reads have independent actions from fee writes", () => {
  for (const [path, action] of [["/v1/teaching/referrals","READ_RECEIVED_REFERRALS"],["/v1/teaching/weeks","LIST_OPEN_TEACHING_WEEKS"],["/v1/venues/available","LIST_AVAILABLE_VENUES"]]) {
    assert.equal(ENDPOINT_CONTRACTS.find(item=>item.path===path).action,action);
    assert.equal(hasPermission("TEACHING_TEACHER",action),true);
    assert.equal(hasPermission("ACADEMIC_PLANNER",action),false);
  }
 });
