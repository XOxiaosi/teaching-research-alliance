import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test, { after, before } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { ApiClientError } from "@teaching-research-alliance/client";

const rootDir = resolve(import.meta.dirname, "..");
const tick = () => new Promise((resolveTick) => setTimeout(resolveTick, 0));
const deferred = () => { let resolvePromise; let rejectPromise; const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; }); return { promise, resolve: resolvePromise, reject: rejectPromise }; };
const reactProps = (element) => element?.[Object.keys(element).find((key) => key.startsWith("__reactProps$"))];
const error = (status, code = "INVALID_INPUT") => new ApiClientError(status, code);
const session = { sessionId: "session-a", accountId: "account-a", personId: "finance-a", currentRoleContext: { subject: "HEADQUARTERS_FINANCE", scope: "GLOBAL" }, roleContexts: [] };
const catalog = { projects: [{ projectNo: 7, displayName: "秋季教研", nameVersion: 3, nameVersionId: "project-v3" }] };
const funds = { items: [{ fundId: "fund-hq", code: "HQ-OPERATING", displayName: "总部业务账户" }] };
const members = { items: [{ id: "person-a", nickname: "王老师" }, { id: "person-b", nickname: "李老师" }] };
const attachmentList = { documentId: "doc-1", attachments: [
  { attachmentId: "support", purpose: "SUPPORTING_DOCUMENT", versions: [{ versionId: "support-v1", versionNo: 1, status: "READY" }] },
  { attachmentId: "screen", purpose: "APPLICATION_SCREENSHOT", versions: [{ versionId: "screen-v1", versionNo: 1, status: "READY" }] },
] };
let Panel;
let tempDir;

before(async () => {
  tempDir = await mkdtemp(resolve(import.meta.dirname, ".project-bonus-mini-"));
  const outfile = resolve(tempDir, "panel.mjs");
  const plugin = { name: "project-bonus-mini-stubs", setup(api) {
    api.onResolve({ filter: /^@tarojs\/taro$/ }, () => ({ path: "taro", namespace: "mini" }));
    api.onLoad({ filter: /^taro$/, namespace: "mini" }, () => ({ loader: "js", contents: `export default {showActionSheet:async o=>globalThis.__sheet?globalThis.__sheet(o):({tapIndex:0}),chooseImage:async o=>globalThis.__image?globalThis.__image(o):({tempFilePaths:["/tmp/a.png"]}),chooseMessageFile:async o=>globalThis.__file?globalThis.__file(o):({tempFiles:[{path:"/tmp/a.pdf",name:"a.pdf"}]})};` }));
    api.onResolve({ filter: /^@tarojs\/components$/ }, () => ({ path: "components", namespace: "mini" }));
    api.onLoad({ filter: /^components$/, namespace: "mini" }, () => ({ loader: "js", contents: `import React from "react";export const View=({children,...p})=>React.createElement("div",p,children);export const Text=({children,...p})=>React.createElement("span",p,children);export const Button=({children,...p})=>React.createElement("button",p,children);export const Input=({onInput,...p})=>React.createElement("input",{...p,onInput});export const Textarea=({onInput,...p})=>React.createElement("textarea",{...p,onInput});export const Picker=({children,range=[],value=0,onChange,...p})=>React.createElement(React.Fragment,null,React.createElement("select",{...p,value:String(value),onChange:e=>onChange?.({detail:{value:e.currentTarget.value}})},range.map((x,i)=>React.createElement("option",{key:i,value:String(i)},x))),children);` }));
    api.onResolve({ filter: /\/services$/ }, () => ({ path: "services", namespace: "mini" }));
    api.onLoad({ filter: /^services$/, namespace: "mini" }, () => ({ loader: "js", contents: `export const readTemporaryFileBytes=async()=>new Uint8Array([137,80,78,71,13,10,26,10]).buffer;export const uploadFinanceAttachmentBytes=async(...args)=>globalThis.__upload?globalThis.__upload(...args):({status:200});` }));
  } };
  await build({ entryPoints: [resolve(rootDir, "src/pages/index/project-bonus-grant-panel.tsx")], bundle: true, format: "esm", platform: "node", outfile, external: ["react", "@teaching-research-alliance/client"], plugins: [plugin] });
  Panel = (await import(`file://${outfile}?${Date.now()}`)).ProjectBonusGrantPanel;
});
after(async () => { await rm(tempDir, { recursive: true, force: true }); });

async function mount(overrides = {}) {
  const dom = new JSDOM("<div id=host></div>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, __sheet: undefined, __image: undefined, __file: undefined, __upload: undefined });
  const host = document.querySelector("#host");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  const events = { directories: 0, creates: [], reserves: [], grants: [], locks: [], invalidated: 0, saved: 0, logout: 0 };
  const shownSession = overrides.session ?? session;
  const { session: _session, ...clientOverrides } = overrides;
  const client = {
    hasRoleContext: true,
    currentSession: shownSession,
    logout: () => { events.logout++; client.currentSession = null; },
    listBonusProjects: async () => { events.directories++; return catalog; },
    listBenefitSourceFunds: async () => funds,
    listManagedCashWageTeachers: async () => members,
    createSalaryBenefitDocumentSubmission: (draft) => ({ draft, idempotencyKey: `document-${events.creates.length}` }),
    createSalaryBenefitDocument: async (command) => { events.creates.push(command); return { id: "doc-1", version: 4 }; },
    listFinanceDocumentAttachments: async () => attachmentList,
    createFinanceAttachmentReservationSubmission: (draft) => ({ draft, idempotencyKey: `attachment-${events.reserves.length}` }),
    reserveFinanceAttachment: async (command) => { events.reserves.push(command); return { versionId: command.draft.purpose === "SUPPORTING_DOCUMENT" ? "support-v1" : "screen-v1" }; },
    getOwnFinanceAttachmentVersion: async (versionId) => ({ versionId, status: "READY" }),
    createBonusGrantSubmission: (draft) => ({ draft, idempotencyKey: `grant-${events.grants.length}` }),
    grantProjectBonus: async (command) => { events.grants.push(command); },
    ...clientOverrides,
  };
  const render = async (nextSession = shownSession, key = "key-a", busy = false) => { await act(async () => { root.render(React.createElement(Panel, { client, session: nextSession, sessionKey: key, busy, onInvalidated: () => events.invalidated++, onSaved: () => events.saved++, onUnconfirmedChange: (value) => events.locks.push(value) })); await tick(); }); };
  await render();
  const buttons = (text) => [...host.querySelectorAll("button")].filter((button) => button.textContent.includes(text));
  const click = async (element) => { assert.ok(element, "missing button"); await act(async () => { element.click(); await tick(); }); };
  const select = async (position, index) => { const element = host.querySelectorAll("select")[position]; assert.ok(element, `missing selector ${position}`); await act(async () => { reactProps(element).onChange({ currentTarget: { value: String(index) } }); await tick(); }); };
  const input = async (position, value) => { const element = host.querySelectorAll("input")[position]; await act(async () => { reactProps(element).onInput({ detail: { value } }); await tick(); }); };
  const reason = async (value) => { const element = host.querySelector("textarea"); await act(async () => { reactProps(element).onInput({ detail: { value } }); await tick(); }); };
  const prepare = async () => { await select(0, 1); await select(1, 1); await select(2, 1); await input(0, "12.50"); await reason("秋季教研奖金"); await click(buttons("创建奖金凭证")[0]); await click(buttons("选择并上传奖金发放凭证")[0]); await click(buttons("选择并上传奖金发放截图")[0]); };
  return { dom, root, host, client, events, render, buttons, click, select, input, reason, prepare, close: async () => { await act(async () => root.unmount()); dom.window.close(); } };
}

test("严格 GLOBAL 财务身份；收款目录使用成员而非工资名单文案", async () => {
  let reads = 0;
  const denied = await mount({ session: { ...session, currentRoleContext: { subject: "HEADQUARTERS_FINANCE", scope: "CAMPUS", campusId: "campus-a" } }, listBonusProjects: async () => { reads++; return catalog; } });
  try {
    assert.match(denied.host.textContent, /没有发放项目奖金的权限/);
    assert.equal(reads, 0);
  } finally { await denied.close(); }
  const view = await mount();
  try { assert.match(view.host.textContent, /收款成员/); assert.equal(view.host.textContent.includes("工资名单"), false); } finally { await view.close(); }
});

test("创建与发放未知结果均重用原 command；两份 READY 原件进入版本化项目奖金", async () => {
  let documentFirst = true;
  let grantFirst = true;
  const view = await mount({
    createSalaryBenefitDocument: async (command) => { view.events.creates.push(command); if (documentFirst) { documentFirst = false; throw new Error("network"); } return { id: "doc-1", version: 4 }; },
    grantProjectBonus: async (command) => { view.events.grants.push(command); if (grantFirst) { grantFirst = false; throw new Error("network"); } },
  });
  try {
    await view.select(0, 1); await view.select(1, 1); await view.select(2, 1); await view.input(0, "12.50"); await view.reason("秋季教研奖金");
    await view.click(view.buttons("创建奖金凭证")[0]);
    await view.click(view.buttons("安全重试创建奖金凭证")[0]);
    assert.equal(view.events.creates.length, 2);
    assert.equal(view.events.creates[0], view.events.creates[1]);
    await view.click(view.buttons("选择并上传奖金发放凭证")[0]);
    await view.click(view.buttons("选择并上传奖金发放截图")[0]);
    await view.click(view.buttons("确认项目奖金发放")[0]);
    const draft = view.events.grants[0].draft;
    assert.deepEqual(draft.attachmentVersionIds, ["support-v1", "screen-v1"]);
    assert.equal(draft.projectNameVersionId, "project-v3");
    assert.equal(draft.recipientPersonId, "person-a");
    assert.equal(draft.sourceFundId, "fund-hq");
    await view.click(view.buttons("安全重试原奖金发放")[0]);
    assert.equal(view.events.grants.length, 2);
    assert.equal(view.events.grants[0], view.events.grants[1]);
    assert.equal(view.events.locks.includes(true), true);
  } finally { await view.close(); }
});

test("确定拒绝保留凭证和原件，并允许更换收款成员后创建新命令", async () => {
  const view = await mount({ grantProjectBonus: async (command) => { view.events.grants.push(command); if (view.events.grants.length === 1) throw error(404, "PERSONAL_ACCOUNT_NOT_FOUND"); } });
  try {
    await view.prepare();
    await view.click(view.buttons("确认项目奖金发放")[0]);
    assert.match(view.host.textContent, /收款成员当前不可用/);
    assert.match(view.host.textContent, /凭证和原件已保留/);
    assert.match(view.host.textContent, /奖金发放凭证：已 READY/);
    await view.select(2, 2);
    await view.click(view.buttons("确认项目奖金发放")[0]);
    assert.equal(view.events.grants.length, 2);
    assert.notEqual(view.events.grants[0], view.events.grants[1]);
    assert.equal(view.events.grants[1].draft.recipientPersonId, "person-b");
  } finally { await view.close(); }
});

test("项目目录 409 刷新目录并要求重新选择；凭证冲突禁止盲发，会话切换丢弃迟到成功", async () => {
  const view = await mount({ grantProjectBonus: async (command) => { view.events.grants.push(command); throw error(409, "BONUS_PROJECT_VERSION_CONFLICT"); } });
  try {
    await view.prepare();
    await view.click(view.buttons("确认项目奖金发放")[0]);
    assert.equal(view.events.grants.length, 1);
    assert.match(view.host.textContent, /请重新选择项目/);
    assert.equal(view.buttons("确认项目奖金发放")[0].disabled, true);
    await view.select(0, 1);
    assert.equal(view.buttons("确认项目奖金发放")[0].disabled, false);
  } finally { await view.close(); }
  const documentConflict = await mount({ grantProjectBonus: async (command) => { documentConflict.events.grants.push(command); throw error(409, "VERSION_CONFLICT"); } });
  try {
    await documentConflict.prepare();
    await documentConflict.click(documentConflict.buttons("确认项目奖金发放")[0]);
    assert.match(documentConflict.host.textContent, /此凭证不能再次提交/);
    assert.equal(documentConflict.buttons("确认项目奖金发放")[0].disabled, true);
    assert.equal(documentConflict.events.locks.at(-1), false);
  } finally { await documentConflict.close(); }
  let resolveGrant;
  const delayed = new Promise((resolveGrantPromise) => { resolveGrant = resolveGrantPromise; });
  const stale = await mount({ grantProjectBonus: async (command) => { stale.events.grants.push(command); return delayed; } });
  try {
    await stale.prepare();
    await stale.click(stale.buttons("确认项目奖金发放")[0]);
    stale.client.currentSession = { ...session, sessionId: "session-b" };
    resolveGrant();
    await act(async () => { await tick(); await tick(); });
    assert.equal(stale.events.saved, 0);
    assert.equal(stale.events.invalidated, 1);
    assert.equal(stale.events.logout, 1);
  } finally { await stale.close(); }
});

test("项目或来源账户目录刷新失败时，旧版本不能被重新选择或提交", async () => {
  let projectReads = 0;
  const project = await mount({
    listBonusProjects: async () => { projectReads++; if (projectReads === 2) throw new Error("offline"); return catalog; },
    grantProjectBonus: async (command) => { project.events.grants.push(command); throw error(409, "BONUS_PROJECT_VERSION_CONFLICT"); },
  });
  try {
    await project.prepare(); await project.click(project.buttons("确认项目奖金发放")[0]);
    assert.equal(project.host.querySelectorAll("select")[0].disabled, true);
    assert.equal(project.buttons("确认项目奖金发放")[0].disabled, true);
    await project.click(project.buttons("重试读取最新项目目录")[0]);
    assert.equal(project.host.querySelectorAll("select")[0].disabled, false);
    assert.equal(project.buttons("确认项目奖金发放")[0].disabled, true);
  } finally { await project.close(); }
  let fundReads = 0;
  const fund = await mount({
    listBenefitSourceFunds: async () => { fundReads++; if (fundReads === 2) throw new Error("offline"); return funds; },
    grantProjectBonus: async (command) => { fund.events.grants.push(command); throw error(409, "COMPANY_FUND_INACTIVE"); },
  });
  try {
    await fund.prepare(); await fund.click(fund.buttons("确认项目奖金发放")[0]);
    assert.equal(fund.host.querySelectorAll("select")[1].disabled, true);
    assert.equal(fund.buttons("确认项目奖金发放")[0].disabled, true);
    await fund.click(fund.buttons("重试读取最新来源账户目录")[0]);
    assert.equal(fund.host.querySelectorAll("select")[1].disabled, false);
    assert.equal(fund.buttons("确认项目奖金发放")[0].disabled, true);
  } finally { await fund.close(); }
});

test("原件未知结果保留同一命令，可分别重试预留、上传与元数据读取", async () => {
  let reserveFirst = true;
  const reserve = await mount({ reserveFinanceAttachment: async (command) => { reserve.events.reserves.push(command); if (reserveFirst) { reserveFirst = false; throw new Error("network"); } return { versionId: "support-v1" }; } });
  try {
    await reserve.select(0, 1); await reserve.select(1, 1); await reserve.select(2, 1); await reserve.input(0, "1"); await reserve.reason("理由"); await reserve.click(reserve.buttons("创建奖金凭证")[0]);
    await reserve.click(reserve.buttons("选择并上传奖金发放凭证")[0]);
    assert.equal(reserve.buttons("安全重试上传奖金发放凭证")[0].disabled, false);
    await reserve.click(reserve.buttons("安全重试上传奖金发放凭证")[0]);
    assert.equal(reserve.events.reserves.length, 2);
    assert.equal(reserve.events.reserves[0], reserve.events.reserves[1]);
  } finally { await reserve.close(); }
  let uploadCalls = 0;
  const binary = await mount({ getOwnFinanceAttachmentVersion: async (versionId) => ({ versionId, status: "UPLOADING" }) });
  try {
    globalThis.__upload = async () => { uploadCalls++; throw new Error("network"); };
    await binary.select(0, 1); await binary.select(1, 1); await binary.select(2, 1); await binary.input(0, "1"); await binary.reason("理由"); await binary.click(binary.buttons("创建奖金凭证")[0]);
    await binary.click(binary.buttons("选择并上传奖金发放凭证")[0]);
    await binary.click(binary.buttons("安全重试上传奖金发放凭证")[0]);
    assert.equal(binary.events.reserves.length, 1);
    assert.equal(uploadCalls, 2);
  } finally { await binary.close(); }
  let metadataFirst = true;
  const metadata = await mount({ getOwnFinanceAttachmentVersion: async (versionId) => { if (metadataFirst) { metadataFirst = false; throw new Error("network"); } return { versionId, status: "READY" }; } });
  try {
    await metadata.select(0, 1); await metadata.select(1, 1); await metadata.select(2, 1); await metadata.input(0, "1"); await metadata.reason("理由"); await metadata.click(metadata.buttons("创建奖金凭证")[0]);
    await metadata.click(metadata.buttons("选择并上传奖金发放凭证")[0]);
    await metadata.click(metadata.buttons("安全重试上传奖金发放凭证")[0]);
    assert.equal(metadata.events.reserves.length, 1);
    assert.match(metadata.host.textContent, /奖金发放凭证：已 READY/);
  } finally { await metadata.close(); }
});

test("手动附件刷新在身份切换后的迟到成功或拒绝不会污染或清除新会话", async () => {
  for (const outcome of ["reject", "resolve"]) {
    let reads = 0;
    const delayed = deferred();
    const view = await mount({ listFinanceDocumentAttachments: async () => { reads++; if (reads === 1) throw new Error("initial read failed"); return delayed.promise; } });
    try {
      await view.select(0, 1); await view.select(1, 1); await view.select(2, 1); await view.input(0, "1"); await view.reason("理由"); await view.click(view.buttons("创建奖金凭证")[0]);
      await view.click(view.buttons("重新读取奖金凭证附件")[0]);
      const nextSession = { ...session, sessionId: `session-${outcome}` };
      view.client.currentSession = nextSession;
      await view.render(nextSession, `key-${outcome}`);
      if (outcome === "reject") delayed.reject(error(403, "FORBIDDEN_SCOPE"));
      else delayed.resolve(attachmentList);
      await act(async () => { await tick(); await tick(); });
      assert.equal(view.events.invalidated, 0);
      assert.equal(view.events.logout, 0);
      assert.equal(view.host.textContent.includes("奖金凭证已创建"), false);
    } finally { await view.close(); }
  }
});
