import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { ApiClientError } from "@teaching-research-alliance/client";

const p = (id, version, amountCents = "1200") => ({ id, version, amountCents, sourceFund: { id: `fund-${id}`, code: `F-${id}`, displayName: `财务账户-${id}` } });
const roster = { salaryMonth: "2026-09-01", items: [
  { beneficiaryPersonId: "teacher-a", beneficiaryDisplayName: "王老师", benefitKind: "SOCIAL_INSURANCE", benefitMonth: "2026-09-01", status: "PENDING", todo: { id: "todo-social", planVersionId: "plan-old", generatedAt: "" }, execution: null, planVersions: [p("plan-old", 1, "1000"), p("plan-current", 2)], currentPlan: p("plan-current", 2) },
  { beneficiaryPersonId: "teacher-a", beneficiaryDisplayName: "王老师", benefitKind: "HOUSING_FUND", benefitMonth: "2026-09-01", status: "PENDING", todo: { id: "todo-house", planVersionId: "plan-house", generatedAt: "" }, execution: null, planVersions: [p("plan-house", 1)], currentPlan: p("plan-house", 1) },
  { beneficiaryPersonId: "teacher-b", beneficiaryDisplayName: "李老师", benefitKind: "SOCIAL_INSURANCE", benefitMonth: "2026-09-01", status: "COMPLETED", todo: { id: "done", planVersionId: "plan-done", generatedAt: "" }, execution: { id: "done" }, planVersions: [p("plan-done", 1)], currentPlan: p("plan-done", 1) },
] };
const session = { sessionId: "session-a", accountId: "account-a", personId: "finance-a", currentRoleContext: { subject: "HEADQUARTERS_FINANCE", scope: "GLOBAL" }, roleContexts: [] };
const attachmentList = { documentId: "doc-1", attachments: [
  { attachmentId: "support", purpose: "SUPPORTING_DOCUMENT", versions: [{ versionId: "support-v1", versionNo: 1, status: "READY" }] },
  { attachmentId: "screen", purpose: "APPLICATION_SCREENSHOT", versions: [{ versionId: "screen-v1", versionNo: 1, status: "READY" }] },
] };
const deferred = () => { let resolvePromise; let rejectPromise; const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; }); return { promise, resolve: resolvePromise, reject: rejectPromise }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const reactProps = element => element && element[Object.keys(element).find(key => key.startsWith("__reactProps$"))];
const error = status => new ApiClientError(status, status === 409 ? "STATE_CONFLICT" : "INVALID_INPUT");
let Panel, tempDir;

before(async () => {
  tempDir = await mkdtemp(resolve(import.meta.dirname, ".benefit-confirm-mini-"));
  const outfile = resolve(tempDir, "panel.mjs");
  const plugin = { name: "mini-benefit-stubs", setup(api) {
    api.onResolve({ filter: /^@tarojs\/taro$/ }, () => ({ path: "taro", namespace: "mini" }));
    api.onLoad({ filter: /^taro$/, namespace: "mini" }, () => ({ loader: "js", contents: `export default {showActionSheet:async o=>globalThis.__sheet?globalThis.__sheet(o):({tapIndex:0}),chooseImage:async o=>globalThis.__image?globalThis.__image(o):({tempFilePaths:["/tmp/a.png"]}),chooseMessageFile:async o=>globalThis.__file?globalThis.__file(o):({tempFiles:[{path:"/tmp/a.pdf",name:"a.pdf"}]})};` }));
    api.onResolve({ filter: /^@tarojs\/components$/ }, () => ({ path: "components", namespace: "mini" }));
    api.onLoad({ filter: /^components$/, namespace: "mini" }, () => ({ loader: "js", contents: `import React from "react";export const View=({children,...p})=>React.createElement("div",p,children);export const Text=({children,...p})=>React.createElement("span",p,children);export const Button=({children,...p})=>React.createElement("button",p,children);export const Textarea=({onInput,...p})=>React.createElement("textarea",{...p,onInput});export const Picker=({children,range=[],value=0,onChange,...p})=>React.createElement(React.Fragment,null,React.createElement("select",{...p,value:String(value),onChange:e=>onChange?.({detail:{value:e.currentTarget.value}})},range.map((x,i)=>React.createElement("option",{key:i,value:String(i)},x))),children);` }));
    api.onResolve({ filter: /\/services$/ }, () => ({ path: "services", namespace: "mini" }));
    api.onLoad({ filter: /^services$/, namespace: "mini" }, () => ({ loader: "js", contents: `export const readTemporaryFileBytes=async path=>(new Uint8Array([137,80,78,71,13,10,26,10])).buffer;export const uploadFinanceAttachmentBytes=async(...args)=>globalThis.__upload?globalThis.__upload(...args):({status:200});` }));
  } };
  await build({ entryPoints: [resolve(import.meta.dirname, "../src/pages/index/benefit-confirmation-panel.tsx")], bundle: true, format: "esm", platform: "node", outfile, external: ["react", "@teaching-research-alliance/client"], plugins: [plugin] });
  Panel = (await import(`file://${outfile}?${Date.now()}`)).BenefitConfirmationPanel;
});
after(async () => { await rm(tempDir, { recursive: true, force: true }); });

async function mount(overrides = {}, taro = {}) {
  const dom = new JSDOM("<div id=host></div>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, __sheet: taro.sheet, __image: taro.image, __file: taro.file, __upload: taro.upload });
  const host = document.querySelector("#host"); const { createRoot } = await import("react-dom/client"); const root = createRoot(host);
  const events = { reads: 0, generates: [], creates: [], reserves: [], confirms: [], saved: 0, invalidated: 0, locks: [] };
  let shownSession = overrides.session ?? session; const { session: _unused, ...clientOverrides } = overrides;
  const client = { hasRoleContext: true, currentSession: shownSession,
    listManagedBenefitRoster: async () => { events.reads++; return roster; },
    createBenefitTodoGenerationSubmission: () => ({ idempotencyKey: `generate-${events.generates.length}` }), generateBenefitTodos: async command => { events.generates.push(command); },
    createSalaryBenefitDocumentSubmission: draft => ({ draft, idempotencyKey: `doc-${events.creates.length}` }), createSalaryBenefitDocument: async command => { events.creates.push(command); return { id: "doc-1", version: 1 }; }, listFinanceDocumentAttachments: async () => attachmentList,
    createFinanceAttachmentReservationSubmission: draft => ({ draft, idempotencyKey: `attach-${events.reserves.length}` }), reserveFinanceAttachment: async command => { events.reserves.push(command); return { versionId: command.draft.purpose === "SUPPORTING_DOCUMENT" ? "support-v1" : "screen-v1" }; }, getOwnFinanceAttachmentVersion: async versionId => ({ versionId, status: "READY" }),
    createBenefitConfirmationSubmission: draft => ({ draft, idempotencyKey: `confirm-${events.confirms.length}` }), confirmBenefit: async command => { events.confirms.push(command); return { status: "COMPLETED" }; }, ...clientOverrides };
  const render = async (key = "key-a", nextSession = shownSession) => { shownSession = nextSession; await act(async () => { root.render(React.createElement(Panel, { client, session: shownSession, sessionKey: key, onSaved: () => events.saved++, onInvalidated: () => events.invalidated++, onUnconfirmedChange: value => events.locks.push(value) })); await tick(); }); };
  await render();
  const buttons = text => [...host.querySelectorAll("button")].filter(button => button.textContent.includes(text));
  const click = async element => { assert.ok(element, "missing element"); await act(async () => { element.click(); await tick(); }); };
  const selectItem = async index => { const element = host.querySelectorAll("select")[1]; assert.ok(element); await act(async () => { reactProps(element).onChange({ currentTarget: { value: String(index) } }); await tick(); }); };
  const chooseMonth = async value => { const element = host.querySelector("select"); await act(async () => { reactProps(element).onChange({ currentTarget: { value } }); await tick(); }); };
  const prepare = async () => { await selectItem(0); await click(buttons("核对对象、金额")[0]); const textarea = host.querySelector("textarea"); await act(async () => { reactProps(textarea).onInput({ detail: { value: "已核对福利资料" } }); await tick(); }); await click(buttons("创建福利确认凭证")[0]); await click(buttons("选择并上传福利原始凭证")[0]); await click(buttons("选择并上传福利确认截图")[0]); };
  return { dom, root, host, client, events, render, click, buttons, selectItem, chooseMonth, prepare, close: async () => { await act(async () => root.unmount()); dom.window.close(); } };
}

test("权限为零读取；PENDING 的双福利待办各自显示冻结与当前计划", async () => {
  let unauthorizedReads = 0; const denied = await mount({ session: { ...session, currentRoleContext: { subject: "CAMPUS_FINANCE", scope: "CAMPUS", campusId: "c" } }, listManagedBenefitRoster: async () => { unauthorizedReads++; throw new Error("read"); } });
  try { assert.match(denied.host.textContent, /没有福利确认权限/); assert.equal(unauthorizedReads, 0); } finally { await denied.close(); }
  const view = await mount(); try { assert.equal(view.host.querySelectorAll("select")[1].querySelectorAll("option").length, 2); await view.selectItem(0); assert.match(view.host.textContent, /待办冻结计划/); assert.match(view.host.textContent, /当前执行计划/); assert.match(view.host.textContent, /按当前版本执行/); await view.selectItem(1); assert.match(view.host.textContent, /财务账户-plan-house/); } finally { await view.close(); }
  const missing = { ...roster, items: [{ ...roster.items[0], planVersions: [] }] }; const broken = await mount({ listManagedBenefitRoster: async () => missing });
  try { await broken.selectItem(0); assert.match(broken.host.textContent, /冻结计划缺失/); assert.equal(broken.buttons("创建福利确认凭证")[0].disabled, true); } finally { await broken.close(); }
});

test("生成仅限 BJT 当前月，未知重试原 command，成功刷新失败只重读", async () => {
  let first = true; let reads = 0; const view = await mount({ generateBenefitTodos: async command => { view.events.generates.push(command); if (first) { first = false; throw new Error("network"); } }, listManagedBenefitRoster: async () => { reads++; if (reads > 1) throw new Error("offline"); return roster; } });
  try { await view.chooseMonth("2020-01"); assert.equal(view.buttons("生成今日到期福利待办（不扣豆）")[0].disabled, true); assert.match(view.host.textContent, /历史月仅可读取和核对/); const now = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).format(new Date()); await view.chooseMonth(now); await view.click(view.buttons("生成今日到期福利待办（不扣豆）")[0]); await view.click(view.buttons("安全重试生成待办")[0]); assert.equal(view.events.generates.length, 2); assert.equal(view.events.generates[0], view.events.generates[1]); assert.equal(view.events.saved, 1); assert.equal(view.buttons("重试读取最新待办").length, 1); assert.equal(view.buttons("生成今日到期福利待办（不扣豆）")[0].disabled, true); assert.equal(view.host.querySelector("select").disabled, true); await view.click(view.buttons("重试读取最新待办")[0]); assert.equal(view.buttons("重试读取最新待办").length, 1); assert.equal(view.events.generates.length, 2); } finally { await view.close(); }
});

test("初始读取失败提供纯读取恢复；确认后关键刷新期间父锁保持", async () => {
  let fail = true; const initial = await mount({ listManagedBenefitRoster: async () => { if (fail) throw new Error("offline"); return roster; } });
  try { assert.equal(initial.buttons("重新读取福利待办").length, 1); fail = false; await initial.click(initial.buttons("重新读取福利待办")[0]); assert.equal(initial.host.textContent.includes("王老师"), true); } finally { await initial.close(); }
  let reads = 0; const refresh = deferred(); const view = await mount({ listManagedBenefitRoster: async () => ++reads === 1 ? roster : refresh.promise });
  try { await view.prepare(); await view.click(view.buttons("确认福利并扣财务职务账户")[0]); assert.equal(view.events.locks.at(-1), true); assert.equal(view.buttons("生成今日到期福利待办（不扣豆）")[0].disabled, true); assert.equal(view.host.querySelector("select").disabled, true); assert.equal(view.host.querySelectorAll("select").length, 1); refresh.resolve(roster); await act(async () => { await tick(); await tick(); }); assert.equal(view.events.locks.at(-1), false); } finally { await view.close(); }
});

test("刷新后原选项已完成时，不再渲染建单或确认入口", async () => {
  let reads = 0; const completed = { ...roster, items: [{ ...roster.items[0], status: "COMPLETED", execution: { id: "execution-a" } }, roster.items[1]] };
  const view = await mount({ listManagedBenefitRoster: async () => ++reads === 1 ? roster : completed });
  try { await view.selectItem(0); await view.click(view.buttons("生成今日到期福利待办（不扣豆）")[0]); assert.equal(view.buttons("创建福利确认凭证").length, 0); assert.equal(view.buttons("确认福利并扣财务职务账户").length, 0); } finally { await view.close(); }
});

test("创建 unknown 和同步双击均不会产生新的单据 command", async () => {
  let first = true; const view = await mount({ createSalaryBenefitDocument: async command => { view.events.creates.push(command); if (first) { first = false; throw new Error("network"); } return { id: "doc-1", version: 1 }; } });
  try { await view.selectItem(0); await view.click(view.buttons("创建福利确认凭证")[0]); await view.click(view.buttons("安全重试创建凭证")[0]); assert.equal(view.events.creates.length, 2); assert.equal(view.events.creates[0], view.events.creates[1]); } finally { await view.close(); }
  const wait = deferred(); let doubleWrites = 0; const double = await mount({ createSalaryBenefitDocument: command => { doubleWrites++; double.events.creates.push(command); return wait.promise; } });
  try { await double.selectItem(0); const button = double.buttons("创建福利确认凭证")[0]; await act(async () => { reactProps(button).onClick({}); reactProps(button).onClick({}); await tick(); }); assert.equal(doubleWrites, 1); wait.resolve({ id: "doc-1", version: 1 }); await act(async () => { await tick(); }); } finally { await double.close(); }
});

test("两用途上传保留 unknown 文件，FAILED 释放，身份迟到不污染", async () => {
  let first = true; let picked = 0; const view = await mount({ reserveFinanceAttachment: async command => { view.events.reserves.push(command); if (first) { first = false; throw new Error("network"); } return { versionId: "support-v1" }; } }, { image: async () => { picked++; return { tempFilePaths: ["/tmp/a.png"] }; } });
  try { await view.selectItem(0); await view.click(view.buttons("创建福利确认凭证")[0]); await view.click(view.buttons("选择并上传福利原始凭证")[0]); await view.click(view.buttons("安全重试上传福利原始凭证")[0]); assert.equal(picked, 1); assert.equal(view.events.reserves.length, 2); assert.equal(view.events.reserves[0], view.events.reserves[1]); assert.equal(view.events.locks.includes(true), true); } finally { await view.close(); }
  const failed = await mount({ getOwnFinanceAttachmentVersion: async versionId => ({ versionId, status: "FAILED" }) });
  try { await failed.selectItem(0); await failed.click(failed.buttons("创建福利确认凭证")[0]); await failed.click(failed.buttons("选择并上传福利原始凭证")[0]); assert.match(failed.host.textContent, /未通过校验/); assert.equal(failed.buttons("选择并上传福利原始凭证")[0].disabled, false); } finally { await failed.close(); }
  const wait = deferred(); const stale = await mount({}, { image: () => wait.promise });
  try { await stale.selectItem(0); await stale.click(stale.buttons("创建福利确认凭证")[0]); await stale.click(stale.buttons("选择并上传福利原始凭证")[0]); stale.client.currentSession = { ...session, sessionId: "changed" }; wait.resolve({ tempFilePaths: ["/tmp/a.png"] }); await act(async () => { await tick(); await tick(); }); assert.equal(stale.events.invalidated, 1); assert.equal(stale.events.reserves.length, 0); } finally { await stale.close(); }
});

test("确认使用两个 READY、理由与当前计划版本，unknown 复用原 submission", async () => {
  let first = true; const view = await mount({ confirmBenefit: async command => { view.events.confirms.push(command); if (first) { first = false; throw new Error("network"); } return { status: "COMPLETED" }; } });
  try { await view.prepare(); await view.click(view.buttons("确认福利并扣财务职务账户")[0]); const draft = view.events.confirms[0].draft; assert.equal(draft.expectedPlanVersionId, "plan-current"); assert.deepEqual(draft.attachmentVersionIds, ["support-v1", "screen-v1"]); await view.click(view.buttons("安全重试原确认")[0]); assert.equal(view.events.confirms.length, 2); assert.equal(view.events.confirms[0], view.events.confirms[1]); } finally { await view.close(); }
});

test("409 清空旧视图，无自动确认，重读失败后成功仍要求新单据", async () => {
  let reads = 0; const view = await mount({ listManagedBenefitRoster: async () => { reads++; if (reads === 2) throw new Error("offline"); return roster; }, confirmBenefit: async command => { view.events.confirms.push(command); throw error(409); } });
  try { await view.prepare(); await view.click(view.buttons("确认福利并扣财务职务账户")[0]); assert.equal(view.host.textContent.includes("王老师"), false); assert.equal(view.events.confirms.length, 1); await view.click(view.buttons("重新读取并核对")[0]); assert.equal(view.buttons("重新读取并核对").length, 1); await view.click(view.buttons("重新读取并核对")[0]); await view.selectItem(0); assert.equal(view.buttons("创建福利确认凭证").length, 1); assert.equal(view.events.confirms.length, 1); } finally { await view.close(); }
});

test("确认成功刷新失败只读不重发，401/403 与身份迟到正确失效", async () => {
  let reads = 0; const view = await mount({ listManagedBenefitRoster: async () => { reads++; if (reads > 1) throw new Error("offline"); return roster; } });
  try { await view.prepare(); await view.click(view.buttons("确认福利并扣财务职务账户")[0]); assert.equal(view.events.confirms.length, 1); assert.equal(view.events.saved, 1); await view.click(view.buttons("重试读取最新待办")[0]); assert.equal(view.events.confirms.length, 1); } finally { await view.close(); }
  for (const status of [401, 403]) { const denied = await mount({ listManagedBenefitRoster: async () => { throw error(status); } }); try { await tick(); assert.equal(denied.events.invalidated, 1); assert.equal(denied.host.textContent.includes("正在读取福利待办"), false); assert.equal(denied.buttons("生成今日到期福利待办（不扣豆）")[0].disabled, false); } finally { await denied.close(); } }
  for (const status of [401, 403]) { let reads = 0; const afterWrite = await mount({ listManagedBenefitRoster: async () => { reads++; if (reads > 1) throw error(status); return roster; } }); try { await afterWrite.prepare(); await afterWrite.click(afterWrite.buttons("确认福利并扣财务职务账户")[0]); assert.equal(afterWrite.events.saved, 1); assert.equal(afterWrite.events.invalidated, 1); } finally { await afterWrite.close(); } }
  for (const status of [401, 403]) { const attachmentAuth = await mount({ listFinanceDocumentAttachments: async () => { throw error(status); } }); try { await attachmentAuth.selectItem(0); await attachmentAuth.click(attachmentAuth.buttons("创建福利确认凭证")[0]); assert.equal(attachmentAuth.events.invalidated, 1); assert.equal(attachmentAuth.buttons("安全重试创建凭证").length, 0); assert.equal(attachmentAuth.buttons("确认福利并扣财务职务账户").length, 0); } finally { await attachmentAuth.close(); } }
  const sessionWait = deferred(); const sessionStale = await mount({ confirmBenefit: () => sessionWait.promise });
  try { await sessionStale.prepare(); await sessionStale.click(sessionStale.buttons("确认福利并扣财务职务账户")[0]); sessionStale.client.currentSession = { ...session, sessionId: "session-c" }; sessionWait.resolve({ status: "COMPLETED" }); await act(async () => { await tick(); }); assert.equal(sessionStale.events.saved, 0); assert.equal(sessionStale.events.invalidated, 1); } finally { await sessionStale.close(); }
  const wait = deferred(); const stale = await mount({ confirmBenefit: () => wait.promise });
  try { await stale.prepare(); await stale.click(stale.buttons("确认福利并扣财务职务账户")[0]); await stale.render("key-b", { ...session, sessionId: "session-b" }); wait.resolve({ status: "COMPLETED" }); await act(async () => { await tick(); }); assert.equal(stale.events.saved, 0); assert.equal(stale.events.locks.at(-1), false); } finally { await stale.close(); }
});
