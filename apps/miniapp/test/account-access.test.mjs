import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ApiClientError } from "@teaching-research-alliance/client";

let temp;
let AccountAccessPanel;
let canManageMiniAccountAccess;
let IndexPage;
const flush = async () => act(async () => { await Promise.resolve(); await new Promise((done) => setTimeout(done, 0)); });
const deferred = () => { let resolvePromise; let rejectPromise; const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; }); return { promise, resolve: resolvePromise, reject: rejectPromise }; };
const reactProps = (node) => node[Object.keys(node).find((key) => key.startsWith("__reactProps$"))];
const account = (id, nickname = "账户甲") => ({ accountId: id, personId: `person-${id}`, nickname, phoneNormalized: "13800138000", loginStatus: "ACTIVE", personStatus: "ACTIVE", activeSystemAuthorities: [] });
const session = (subject = "SYSTEM_ADMIN", patch = {}) => ({ sessionId: "session", accountId: "account-self", personId: "person-self", roleContexts: [{ personId: "person-self", subject, scope: "GLOBAL", ...patch }], currentRoleContext: { personId: "person-self", subject, scope: "GLOBAL", ...patch } });

const taroPlugin = {
  name: "taro-components",
  setup(buildApi) {
    buildApi.onResolve({ filter: /^@tarojs\/components$/ }, () => ({ path: "taro-components", namespace: "stub" }));
    buildApi.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ loader: "js", resolveDir: resolve(import.meta.dirname, ".."), contents: `import React from 'react';
      export const View=({children,...props})=>React.createElement('div',props,children);
      export const Text=({children,...props})=>React.createElement('span',props,children);
      export const Image=({src,...props})=>React.createElement('img',{...props,src});
      export const Button=({children,...props})=>React.createElement('button',props,children);
      export const Input=({onInput,...props})=>React.createElement('input',{...props,onInput});
      export const Textarea=({onInput,...props})=>React.createElement('textarea',{...props,onInput});
      export const Picker=({children,onChange,...props})=>React.createElement('div',{...props,onChange,'data-picker':'true'},children);
      export const ScrollView=({children,...props})=>React.createElement('div',props,children);` }));
  },
};

const indexPlugin = {
  name: "index-dependencies",
  setup(buildApi) {
    buildApi.onResolve({ filter: /^@teaching-research-alliance\/client$/ }, () => ({ path: "client", namespace: "index-stub" }));
    buildApi.onResolve({ filter: /^\.\.\/\.\.\/services$/ }, () => ({ path: "services", namespace: "index-stub" }));
    buildApi.onResolve({ filter: /^\.\/(referral-panel|financial-panel|reimbursement-panel|refund-panel|venue-board-panel|venue-management-panel|organization-revenue-panel|cash-wage-panel|cash-wage-confirmation-panel|cash-wage-plan-panel|bonus-project-panel|project-bonus-grant-panel|benefit-plan-panel|benefit-confirmation-panel|benefit-panel|group-leader-change-panel|person-relationship-audit-panel|planning-mentor-relationship-panel|account-access-panel|managed-referral-completion-panel|received-referral-completion-panel)$/ }, () => ({ path: "panel", namespace: "index-stub" }));
    buildApi.onLoad({ filter: /^client$/, namespace: "index-stub" }, () => ({ loader: "js", contents: `let session=null;globalThis.__miniRegistrations=[];globalThis.__miniLogins=[];
      export class ApiClientError extends Error { constructor(status,code){super(code);this.status=status;this.code=code;} }
      export class RoleSelectionRequiredError extends Error {} export class StaleResponseError extends Error {}
      export const formatCentsAsBeans=value=>String(value); export const parseBeanAmountToCents=value=>String(value);
      export class TeacherApiClient { constructor(){ } get currentSession(){return session;} get hasRoleContext(){return session?.currentRoleContext!==null;}
        async registerAccount(input){if(globalThis.__miniRegisterFailure){session=null;throw new ApiClientError(500,'INTERNAL_ERROR');}globalThis.__miniRegistrations.push(input);session={sessionId:'registered',accountId:'account-new',personId:'person-new',roleContexts:[{personId:'person-new',subject:'TEACHER',scope:'SELF'}],currentRoleContext:{personId:'person-new',subject:'TEACHER',scope:'SELF'}};return {...session,nickname:input.nickname};}
        async login(input){globalThis.__miniLogins.push(input);session=session??{sessionId:'confirmed',accountId:'account-new',personId:'person-new',roleContexts:[{personId:'person-new',subject:'TEACHER',scope:'SELF'}],currentRoleContext:{personId:'person-new',subject:'TEACHER',scope:'SELF'}};return session;} async getOwnOverview(){return {nickname:'新老师',balanceCents:'0',currentYearIncomeByCategory:{}};} async listVisibleVenues(){return [];} async endSession(){session=null;} async refreshSession(){return session;} async switchRole(){return session;}
      }` }));
    buildApi.onLoad({ filter: /^services$/, namespace: "index-stub" }, () => ({ loader: "js", contents: "export const taroTransport=async()=>({status:500,body:{}});" }));
    buildApi.onLoad({ filter: /^panel$/, namespace: "index-stub" }, () => ({ loader: "js", contents: `const Blank=()=>null; export const ReferralPanel=Blank;export const FinancialPanel=()=>{globalThis.__miniFinancialMounts=(globalThis.__miniFinancialMounts??0)+1;return '我的提现';};export const ReimbursementPanel=Blank;export const RefundPanel=Blank;export const VenueBoardPanel=Blank;export const VenueManagementPanel=Blank;export const OrganizationRevenuePanel=Blank;export const CashWagePanel=Blank;export const CashWageConfirmationPanel=Blank;export const CashWagePlanPanel=Blank;export const BonusProjectPanel=Blank;export const ProjectBonusGrantPanel=Blank;export const BenefitPlanPanel=Blank;export const BenefitConfirmationPanel=Blank;export const BenefitPanel=Blank;export const GroupLeaderChangePanel=Blank;export const TeachingMentorChangePanel=Blank;export const PersonRelationshipAuditPanel=Blank;export const PlanningMentorRelationshipPanel=Blank;export const AccountAccessPanel=Blank;export const ManagedReferralCompletionPanel=Blank;export const ReceivedReferralCompletionPanel=Blank;export const canReadMiniOrganizationRevenue=()=>false;export const canManageMiniAccountAccess=()=>false;` }));
  },
};

test.before(async () => {
  temp = await mkdtemp(resolve(import.meta.dirname, ".account-access-mini-"));
  const panelOut = resolve(temp, "panel.mjs");
  await build({ entryPoints: [resolve(import.meta.dirname, "../src/pages/index/account-access-panel.tsx")], bundle: true, platform: "node", format: "esm", outfile: panelOut, external: ["react", "react-dom", "@teaching-research-alliance/client"], plugins: [taroPlugin] });
  ({ AccountAccessPanel, canManageMiniAccountAccess } = await import(panelOut));
  const indexOut = resolve(temp, "index.mjs");
  await build({ entryPoints: [resolve(import.meta.dirname, "../src/pages/index/index.tsx")], bundle: true, platform: "node", format: "esm", outfile: indexOut, external: ["react", "react-dom"], plugins: [taroPlugin, indexPlugin] });
  IndexPage = (await import(indexOut)).default;
});
test.after(async () => { await rm(temp, { recursive: true, force: true }); });

async function mountPanel(overrides = {}) {
  const dom = new JSDOM("<div id='host'></div>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.querySelector("#host");
  const root = createRoot(host);
  const locks = []; const invalidated = []; const ownResets = [];
  const client = { currentSession: session(), hasRoleContext: true, listAccounts: async () => [account("account-target")], createAccountPasswordResetSubmission: (draft) => Object.freeze({ draft: Object.freeze(draft), idempotencyKey: "stable-key" }), resetAccountPassword: async () => ({ accountId: "account-target", personId: "person-account-target", authVersion: "2", resetAt: "2026-09-23T00:00:00.000Z", replay: false }), ...overrides };
  const render = async (nextSession = session(), key = "one") => { await act(async () => root.render(React.createElement(AccountAccessPanel, { client, session: nextSession, sessionKey: key, onUnconfirmedChange: (value) => locks.push(value), onInvalidated: () => invalidated.push(true), onOwnPasswordReset: () => ownResets.push(true) }))); await flush(); };
  await render();
  const input = async (index, value) => { const node = host.querySelectorAll("input")[index]; await act(async () => reactProps(node).onInput({ detail: { value } })); };
  const fill = async () => { await input(0, "Password-123"); await input(1, "Password-123"); const area = host.querySelector("textarea"); await act(async () => reactProps(area).onInput({ detail: { value: "本人请求密码重置" } })); };
  const button = (text) => [...host.querySelectorAll("button")].find((node) => node.textContent === text);
  return { host, client, locks, invalidated, ownResets, render, fill, button, close: async () => { await act(async () => root.unmount()); dom.window.close(); } };
}

test("注册只提交普通账号字段并进入普通老师会话", async () => {
  globalThis.__miniRegistrations = []; globalThis.__miniLogins = []; globalThis.__miniFinancialMounts = 0;
  const dom = new JSDOM("<div id='host'></div>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.querySelector("#host"); const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(IndexPage))); await flush();
    await act(async () => [...host.querySelectorAll("button")].find((node) => node.textContent === "注册普通账户").click());
    const values = ["新老师", "张三", "13800138000", "Password-123", "Password-123"];
    for (const [index, value] of values.entries()) await act(async () => reactProps(host.querySelectorAll("input")[index]).onInput({ detail: { value } }));
    await act(async () => [...host.querySelectorAll("button")].find((node) => node.textContent === "注册并进入工作台").click()); await flush();
    assert.deepEqual(globalThis.__miniRegistrations, [{ nickname: "新老师", legalName: "张三", phoneNormalized: "13800138000", password: "Password-123" }]);
    assert.match(host.textContent, /我的工作台/);
    assert.equal(host.textContent.includes("授课老师"), false);
    assert.ok(globalThis.__miniFinancialMounts >= 1); assert.match(host.textContent, /我的提现/);
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});

test("注册500结果未知时保留原凭据并引导使用登录确认", async () => {
  globalThis.__miniRegisterFailure = true; globalThis.__miniRegistrations = []; globalThis.__miniLogins = [];
  const dom = new JSDOM("<div id='host'></div>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.querySelector("#host"); const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(IndexPage))); await flush();
    await act(async () => [...host.querySelectorAll("button")].find((node) => node.textContent === "注册普通账户").click());
    const values = ["新老师", "张三", "13800138000", "Password-123", "Password-123"];
    for (const [index, value] of values.entries()) await act(async () => reactProps(host.querySelectorAll("input")[index]).onInput({ detail: { value } }));
    await act(async () => [...host.querySelectorAll("button")].find((node) => node.textContent === "注册并进入工作台").click()); await flush();
    assert.match(host.textContent, /注册结果未确认/); assert.match(host.textContent, /登录你的账户/);
    assert.equal(host.querySelectorAll("input")[0].value, "13800138000"); assert.equal(host.querySelectorAll("input")[1].value, "Password-123");
    const loginTab = [...host.querySelectorAll("button")].find((node) => node.textContent === "账号登录");
    assert.equal(loginTab.disabled, true);
    const registerButton = [...host.querySelectorAll("button")].find((node) => node.textContent === "注册普通账户");
    assert.equal(registerButton.disabled, true); await act(async () => registerButton.click()); await flush();
    assert.equal(globalThis.__miniRegistrations.length, 0);
    await act(async () => [...host.querySelectorAll("button")].find((node) => node.textContent === "登录").click()); await flush();
    assert.deepEqual(globalThis.__miniLogins, [{ phoneNormalized: "13800138000", password: "Password-123" }]);
  } finally { globalThis.__miniRegisterFailure = false; await act(async () => root.unmount()); dom.window.close(); }
});

test("账户目录只向严格GLOBAL开发者或管理员开放", () => {
  assert.equal(canManageMiniAccountAccess(session("SYSTEM_ADMIN")), true);
  assert.equal(canManageMiniAccountAccess(session("SYSTEM_OWNER")), true);
  assert.equal(canManageMiniAccountAccess(session("SYSTEM_ADMIN", { regionId: "region-a" })), false);
  assert.equal(canManageMiniAccountAccess(session("HEADQUARTERS_FINANCE")), false);
});

test("重置500未知结果冻结同一命令并用同一幂等键重试", async () => {
  const delayed = deferred(); const commands = [];
  const view = await mountPanel({ resetAccountPassword: (command) => { commands.push(command); return commands.length === 1 ? delayed.promise : Promise.resolve({ accountId: "account-target", personId: "person-target", authVersion: "2", resetAt: "2026-09-23T00:00:00.000Z", replay: true }); } });
  try {
    await view.fill(); await act(async () => view.button("确认重置密码").click());
    await act(async () => delayed.reject(new ApiClientError(500, "INTERNAL_ERROR"))); await flush();
    assert.match(view.host.textContent, /结果尚未确认/); assert.equal(view.locks.at(-1), true);
    await act(async () => view.button("安全重试原密码重置").click()); await flush();
    assert.equal(commands.length, 2); assert.strictEqual(commands[0], commands[1]); assert.equal(view.locks.at(-1), false);
  } finally { await view.close(); }
});

test("重置4xx清除密码并允许创建新的重置命令", async () => {
  const commands = [];
  const view = await mountPanel({
    createAccountPasswordResetSubmission: (draft) => { const command = Object.freeze({ draft: Object.freeze(draft), idempotencyKey: `fresh-key-${commands.length + 1}` }); commands.push(command); return command; },
    resetAccountPassword: async () => { throw new ApiClientError(409, "IDEMPOTENCY_REPLAY"); },
  });
  try {
    await view.fill(); await act(async () => view.button("确认重置密码").click()); await flush();
    assert.match(view.host.textContent, /密码未重置/); assert.equal(view.host.querySelectorAll("input")[0].value, ""); assert.equal(view.host.querySelectorAll("input")[1].value, "");
    await view.fill(); await act(async () => view.button("确认重置密码").click()); await flush();
    assert.equal(commands.length, 2); assert.notEqual(commands[0].idempotencyKey, commands[1].idempotencyKey);
  } finally { await view.close(); }
});

test("本人重置成功清除组件密码并回到登录回调", async () => {
  const current = session(); const view = await mountPanel({ currentSession: null, resetAccountPassword: async () => ({ accountId: current.accountId, personId: current.personId, authVersion: "2", resetAt: "2026-09-23T00:00:00.000Z", replay: false }) });
  try {
    await view.fill(); await act(async () => view.button("确认重置密码").click()); await flush();
    assert.equal(view.ownResets.length, 1); assert.equal(view.host.querySelectorAll("input").length, 0); assert.equal(view.host.querySelector("textarea"), null);
  } finally { await view.close(); }
});

test("会话切换后迟到的旧目录不会覆盖新身份", async () => {
  const old = deferred(); const fresh = deferred(); let calls = 0;
  const view = await mountPanel({ listAccounts: () => ++calls === 1 ? old.promise : fresh.promise });
  try {
    await view.render(session("SYSTEM_OWNER"), "new-identity");
    await act(async () => old.resolve([account("old", "旧身份账户")])); await flush();
    assert.equal(view.host.textContent.includes("旧身份账户"), false);
    await act(async () => fresh.resolve([account("new", "新身份账户")])); await flush();
    assert.match(view.host.textContent, /新身份账户/);
  } finally { await view.close(); }
});

test("权限丢失会清空密码状态并通知父级切换会话", async () => {
  const view = await mountPanel({ listAccounts: async () => { throw new ApiClientError(403, "FORBIDDEN_SCOPE"); } });
  try { await flush(); assert.equal(view.invalidated.length, 1); assert.equal(view.host.querySelector("textarea"), null); } finally { await view.close(); }
});
