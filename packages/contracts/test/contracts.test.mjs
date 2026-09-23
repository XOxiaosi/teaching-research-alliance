import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTIONS,
  API_ERROR_CODES,
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

test("普通注册教师只取得个人基础能力，不取得授课与转介绍身份", () => {
  for (const action of [
    "VIEW_OWN_PROFILE",
    "SUBMIT_OWN_REIMBURSEMENT",
    "READ_OWN_REIMBURSEMENT",
    "CREATE_PERSONAL_WITHDRAWAL",
    "SUBMIT_OWN_SELF_PURCHASE",
    "CREATE_VENUE",
    "READ_OWN_VENUES",
  ]) {
    assert.equal(permissionScope("TEACHER", action), "SELF", `${action} should remain personal`);
  }
  for (const action of ["VIEW_SHARED_VENUE_BOARD", "WITHDRAW_FROM_SHARED_VENUE"]) {
    assert.equal(permissionScope("TEACHER", action), "VENUE", `${action} should stay venue-scoped`);
  }
  for (const action of [
    "CREATE_REFERRAL",
    "ACCEPT_REFERRAL",
    "CREATE_WEEKLY_FEE",
    "LIST_OPEN_TEACHING_WEEKS",
    "LIST_AVAILABLE_VENUES",
  ]) {
    assert.equal(hasPermission("TEACHER", action), false, `${action} requires a teaching role`);
  }
});

test("账号访问管理仅授予系统所有者和系统管理员，并声明稳定接口错误", () => {
  for (const subject of ["SYSTEM_OWNER", "SYSTEM_ADMIN"]) {
    assert.equal(permissionScope(subject, "MANAGE_ACCOUNT_ACCESS"), "GLOBAL");
  }
  for (const subject of ["TEACHER", "TEACHING_TEACHER", "HEADQUARTERS_FINANCE", "REGION_FINANCE"]) {
    assert.equal(hasPermission(subject, "MANAGE_ACCOUNT_ACCESS"), false);
  }
  assert.deepEqual(
    ENDPOINT_CONTRACTS.filter((item) => item.path.startsWith("/v1/admin/accounts")),
    [
      {
        method: "GET",
        path: "/v1/admin/accounts",
        action: "MANAGE_ACCOUNT_ACCESS",
        responseVersion: "account-directory.v1",
        requiresRoleContext: true,
      },
      {
        method: "POST",
        path: "/v1/admin/accounts/:accountId/password-reset",
        action: "MANAGE_ACCOUNT_ACCESS",
        responseVersion: "account-password-reset.v1",
        requiresRoleContext: true,
      },
    ],
  );
  assert.deepEqual(
    ENDPOINT_CONTRACTS.find((item) => item.path === "/v1/accounts/register"),
    {
      method: "POST",
      path: "/v1/accounts/register",
      action: "VIEW_OWN_PROFILE",
      responseVersion: "account-registration.v1",
      requiresRoleContext: false,
    },
  );
  for (const code of [
    "LOGIN_RATE_LIMITED",
    "ACCOUNT_ACCESS_SERVICE_UNAVAILABLE",
    "REGISTRATION_PHONE_CONFLICT",
    "REGISTRATION_NICKNAME_CONFLICT",
    "ACCOUNT_NOT_FOUND",
  ]) {
    assert.equal(API_ERROR_CODES.includes(code), true, `${code} must be stable`);
  }
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

test("本人采买从个人入口提交，财务管理读取独立授权",()=>{
  for(const subject of ['TEACHING_TEACHER','ACADEMIC_PLANNER','PLANNING_MENTOR']){
    assert.equal(permissionScope(subject,'SUBMIT_OWN_SELF_PURCHASE'),'SELF');
    assert.equal(hasPermission(subject,'READ_MANAGED_SELF_PURCHASE'),false);
    assert.equal(hasPermission(subject,'REVERSE_MANAGED_SELF_PURCHASE'),false);
  }
  for(const subject of ['HEADQUARTERS_FINANCE','SYSTEM_ADMIN','SYSTEM_OWNER']){
    assert.equal(permissionScope(subject,'READ_MANAGED_SELF_PURCHASE'),'GLOBAL');
    assert.equal(permissionScope(subject,'REVERSE_MANAGED_SELF_PURCHASE'),'GLOBAL');
    assert.equal(hasPermission(subject,'SUBMIT_OWN_SELF_PURCHASE'),false);
  }
  assert.equal(hasPermission('REGION_FINANCE','READ_MANAGED_SELF_PURCHASE'),false);
  for(const subject of ['REGION_FINANCE','CAMPUS_PRINCIPAL','GROUP_LEADER','TEACHING_MENTOR'])assert.equal(hasPermission(subject,'REVERSE_MANAGED_SELF_PURCHASE'),false);
  assert.equal(ENDPOINT_CONTRACTS.find(item=>item.path==='/v1/finance/self-purchases/:documentId/reverse').action,'REVERSE_MANAGED_SELF_PURCHASE');
  assert.deepEqual(ENDPOINT_CONTRACTS.find(item=>item.path==='/v1/finance/self-purchases/:documentId').alternativeActions,['READ_MANAGED_SELF_PURCHASE']);
});

test("场地选用与共享查看/提现是独立能力", () => {
  assert.equal(hasPermission("TEACHING_TEACHER", "CREATE_WEEKLY_FEE"), true);
  assert.equal(hasPermission("TEACHING_TEACHER", "VIEW_SHARED_VENUE_BOARD"), true);
  assert.equal(hasPermission("TEACHING_TEACHER", "WITHDRAW_FROM_SHARED_VENUE"), true);
  assert.equal(ACTIONS.includes("CONFIGURE_RATES"), true);
  assert.equal(hasPermission("VENUE_OWNER", "CONFIGURE_RATES"), false);
});

test("普通报销审核独立于个人提交和管理员查阅，不宣告通用审批接口",()=>{
  for(const subject of ['TEACHING_TEACHER','ACADEMIC_PLANNER','PLANNING_MENTOR']){
    assert.equal(hasPermission(subject,'SUBMIT_OWN_REIMBURSEMENT'),true);
    assert.equal(hasPermission(subject,'READ_OWN_REIMBURSEMENT'),true);
    assert.equal(hasPermission(subject,'REVIEW_REIMBURSEMENT'),false);
  }
  assert.equal(permissionScope('HEADQUARTERS_FINANCE','REVIEW_REIMBURSEMENT'),'GLOBAL');
  for(const subject of ['SYSTEM_ADMIN','SYSTEM_OWNER']){
    assert.equal(permissionScope(subject,'READ_MANAGED_REIMBURSEMENT'),'GLOBAL');
    assert.equal(hasPermission(subject,'REVIEW_REIMBURSEMENT'),false);
  }
  assert.equal(hasPermission('REGION_FINANCE','READ_MANAGED_REIMBURSEMENT'),false);
  assert.equal(ENDPOINT_CONTRACTS.some(item=>item.path==='/v1/finance/documents/:documentId/approve'),false);
  for(const action of ['approve','reject'])assert.equal(ENDPOINT_CONTRACTS.find(item=>item.path===`/v1/finance/reimbursements/:documentId/${action}`).action,'REVIEW_REIMBURSEMENT');
});

test("普通报销执行严格限定总部财务全局动作，系统管理员与所有者仅可读取",()=>{
  assert.equal(ACTIONS.includes("EXECUTE_REIMBURSEMENT"), true);
  assert.equal(permissionScope("HEADQUARTERS_FINANCE", "EXECUTE_REIMBURSEMENT"), "GLOBAL");
  assert.equal(hasPermission("HEADQUARTERS_FINANCE", "EXECUTE_REIMBURSEMENT"), true);
  for (const subject of ["SYSTEM_ADMIN", "SYSTEM_OWNER", "REGION_FINANCE", "CAMPUS_PRINCIPAL", "TEACHING_TEACHER"]) {
    assert.equal(hasPermission(subject, "EXECUTE_REIMBURSEMENT"), false);
  }
  assert.deepEqual(
    ENDPOINT_CONTRACTS.find((item) => item.path === "/v1/finance/reimbursements/:documentId/execute"),
    {
      method: "POST",
      path: "/v1/finance/reimbursements/:documentId/execute",
      action: "EXECUTE_REIMBURSEMENT",
      responseVersion: "reimbursement.v1",
      requiresRoleContext: true,
    },
  );
  assert.equal(API_ERROR_CODES.includes("REIMBURSEMENT_CROSS_FINANCE_YEAR_PENDING"), true);
});

test("普通报销撤销独立于执行，三类全局财务身份可办理",()=>{
  assert.equal(ACTIONS.includes("REVERSE_REIMBURSEMENT"), true);
  for (const subject of ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"]) {
    assert.equal(permissionScope(subject, "REVERSE_REIMBURSEMENT"), "GLOBAL");
    assert.equal(hasPermission(subject, "REVERSE_REIMBURSEMENT"), true);
  }
  for (const subject of ["REGION_FINANCE", "CAMPUS_PRINCIPAL", "TEACHING_TEACHER", "ACADEMIC_PLANNER", "PLANNING_MENTOR"]) {
    assert.equal(hasPermission(subject, "REVERSE_REIMBURSEMENT"), false);
  }
  assert.deepEqual(
    ENDPOINT_CONTRACTS.find((item) => item.path === "/v1/finance/reimbursements/:documentId/reverse"),
    {
      method: "POST",
      path: "/v1/finance/reimbursements/:documentId/reverse",
      action: "REVERSE_REIMBURSEMENT",
      responseVersion: "reimbursement.v1",
      requiresRoleContext: true,
    },
  );
  assert.equal(hasPermission("SYSTEM_ADMIN", "EXECUTE_REIMBURSEMENT"), false);
  assert.equal(hasPermission("SYSTEM_OWNER", "EXECUTE_REIMBURSEMENT"), false);
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
  assert.equal(ENDPOINT_CONTRACTS.find((item) => item.path === "/v1/venues/visible")?.action, "READ_OWN_VENUES");
});

 test("teaching directory reads have independent actions from fee writes", () => {
  for (const [path, action] of [["/v1/teaching/referrals","READ_RECEIVED_REFERRALS"],["/v1/teaching/weeks","LIST_OPEN_TEACHING_WEEKS"],["/v1/venues/available","LIST_AVAILABLE_VENUES"]]) {
    assert.equal(ENDPOINT_CONTRACTS.find(item=>item.path===path).action,action);
    assert.equal(hasPermission("TEACHING_TEACHER",action),true);
    assert.equal(hasPermission("ACADEMIC_PLANNER",action),false);
  }
 });

test('student refunds separate teaching applicants, headquarters approval, and global read access',()=>{
 for(const action of ['SUBMIT_OWN_REFUND','READ_OWN_REFUND']){
  assert.equal(permissionScope('TEACHING_TEACHER',action),'SELF');
  for(const subject of ['ACADEMIC_PLANNER','PLANNING_MENTOR','REGION_FINANCE','CAMPUS_PRINCIPAL'])assert.equal(hasPermission(subject,action),false);
 }
 assert.equal(permissionScope('HEADQUARTERS_FINANCE','REVIEW_REFUND'),'GLOBAL');
 for(const subject of ['SYSTEM_ADMIN','SYSTEM_OWNER']){
  assert.equal(permissionScope(subject,'READ_MANAGED_REFUND'),'GLOBAL');
  assert.equal(hasPermission(subject,'REVIEW_REFUND'),false);
 }
 for(const subject of ['TEACHING_TEACHER','REGION_FINANCE','CAMPUS_PRINCIPAL'])assert.equal(hasPermission(subject,'READ_MANAGED_REFUND'),false);
 for(const action of ['approve','reject'])assert.equal(ENDPOINT_CONTRACTS.find(item=>item.path===`/v1/finance/refunds/:documentId/${action}`).action,'REVIEW_REFUND');
 assert.deepEqual(ENDPOINT_CONTRACTS.find(item=>item.path==='/v1/finance/refunds/:documentId').alternativeActions,['READ_MANAGED_REFUND']);
});

test("工资、奖金和社保写接口统一要求严格全局财务管理动作", () => {
  const paths = [
    "/v1/finance/salary-benefits/documents", "/v1/finance/cash-wage-plans", "/v1/finance/cash-wage-todos/generate",
    "/v1/finance/cash-wages/confirm", "/v1/finance/project-bonuses/grant", "/v1/finance/benefit-plans",
    "/v1/finance/benefit-todos/generate", "/v1/finance/benefits/confirm", "/v1/finance/salary-benefits/reverse"
  ];
  for (const path of paths) {
    const endpoint = ENDPOINT_CONTRACTS.find((item) => item.path === path);
    assert.equal(endpoint?.action, "MANAGE_CASH_WAGES");
    assert.equal(endpoint?.requiresRoleContext, true);
  }
  for (const subject of ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"]) {
    assert.equal(permissionScope(subject, "MANAGE_CASH_WAGES"), "GLOBAL");
  }
  for (const subject of ["REGION_FINANCE", "CAMPUS_PRINCIPAL", "TEACHING_TEACHER"]) {
    assert.equal(hasPermission(subject, "MANAGE_CASH_WAGES"), false);
  }
});

test("福利扣费业务账户目录契约固定为只读全局管理端点", () => {
  assert.deepEqual(
    ENDPOINT_CONTRACTS.find((item) => item.path === "/v1/finance/benefit-source-funds"),
    {
      method: "GET",
      path: "/v1/finance/benefit-source-funds",
      action: "READ_MANAGED_CASH_WAGES",
      responseVersion: "benefit-source-funds.v1",
      requiresRoleContext: true,
    },
  );
});
