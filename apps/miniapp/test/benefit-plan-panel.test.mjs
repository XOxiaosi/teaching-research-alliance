import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ApiClientError } from "@teaching-research-alliance/client";

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const props = node => node[Object.keys(node).find(k => k.startsWith("__reactProps$"))];
const session = (subject = "HEADQUARTERS_FINANCE") => ({ sessionId: "s", currentRoleContext: { personId: "person", subject, scope: "GLOBAL" } });

let Panel;
let temp;
test.before(async () => {
  temp = await mkdtemp(resolve(import.meta.dirname, ".benefit-plan-test-"));
  const out = resolve(temp, "panel.mjs");
  await build({
    entryPoints: [resolve(import.meta.dirname, "../src/pages/index/benefit-plan-panel.tsx")], bundle: true, platform: "node", format: "esm", outfile: out,
    external: ["react", "react-dom", "@teaching-research-alliance/client"],
    plugins: [{ name: "taro", setup(b) { b.onResolve({ filter: /^@tarojs\/components$/ }, () => ({ path: "stub", namespace: "taro" })); b.onLoad({ filter: /.*/, namespace: "taro" }, () => ({ loader: "js", contents: `import React from 'react';export const View=({children,...p})=>React.createElement('div',p,children);export const Text=({children,...p})=>React.createElement('span',p,children);export const Button=({children,...p})=>React.createElement('button',p,children);export const Input=({onInput,...p})=>React.createElement('input',{...p,onInput,onChange:()=>{}});export const Textarea=({onInput,...p})=>React.createElement('textarea',{...p,onInput,onChange:()=>{}});export const Picker=({children:_children,onChange,range=[],value,mode,...p})=>React.createElement('select',{...p,'data-picker':mode,value,onChange,'data-range':range.join('|')},range.map((label,index)=>React.createElement('option',{key:index,value:index},label)));` })); } }],
  });
  Panel = (await import(out)).BenefitPlanPanel;
});
test.after(async () => { await rm(temp, { recursive: true, force: true }); });

async function mount(overrides = {}, subject = "HEADQUARTERS_FINANCE", contextPatch = {}, panelProps = {}) {
  const dom = new JSDOM("<div id='host'></div>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.querySelector("#host"); const root = createRoot(host); let invalidated = 0; let saved = 0; const locks = [];
  const client = { hasRoleContext: true, listManagedCashWageTeachers: async () => ({ items: [{ id: "teacher", nickname: "王老师" }] }), listBenefitSourceFunds: async () => ({ items: [{ fundId: "fund", code: "FINANCE", displayName: "运营资金" }] }), createBenefitPlanSubmission: draft => ({ draft, idempotencyKey: `key-${Date.now()}-${Math.random()}` }), setBenefitPlan: async () => ({}), listManagedBenefitRoster: async month => ({ benefitMonth: month, items: [] }), ...overrides };
  const render = async (key = "s") => { await act(async () => root.render(React.createElement(Panel, { ...panelProps, client, session: { ...session(subject), currentRoleContext: { ...session(subject).currentRoleContext, ...contextPatch } }, sessionKey: key, onSaved: () => saved++, onInvalidated: () => invalidated++, onUnconfirmedChange: value => locks.push(value) }))); await flush(); };
  await render();
  const button = text => [...host.querySelectorAll("button")].find(x => x.textContent === text);
  const click = async text => { await act(async () => { button(text).click(); }); await flush(); };
  const input = async (node, value) => act(async () => { props(node).onInput({ detail: { value } }); });
  const fill = async () => { const fields = host.querySelectorAll("input"); await input(fields[0], "15"); await input(fields[1], "15"); await input(host.querySelector("textarea"), "按月福利计划"); };
  return { host, client, render, fill, input, button, click, locks, saved: () => saved, invalidated: () => invalidated, close: async () => { await act(async () => root.unmount()); dom.window.close(); } };
}

test("mini benefit plan saves with active directory and does not post a second command on double click", async () => {
  const calls = []; const wait = deferred(); const v = await mount({ setBenefitPlan: async submission => { calls.push(submission); return wait.promise; } });
  try { await v.fill(); await act(async () => { v.button("保存福利计划").click(); v.button("保存福利计划").click(); }); await flush(); assert.equal(calls.length, 1); assert.equal(calls[0].draft.benefitMonth.slice(-3), "-01"); assert.equal(calls[0].draft.amountCents, "1500"); await act(async () => { wait.resolve({}); }); await flush(); assert.equal(v.saved(), 1); assert.equal(v.locks.at(-1), false); } finally { await v.close(); }
});

test("unknown freezes the original submission and explicit retry reuses its key", async () => {
  const pending = deferred(); const calls = []; const v = await mount({ setBenefitPlan: submission => { calls.push(submission); return pending.promise; } });
  try { await v.fill(); await v.click("保存福利计划"); assert.equal(v.locks.at(-1), true); assert.ok([...v.host.querySelectorAll("input,textarea,select")].every(x => x.disabled)); await act(async () => { pending.reject(new Error("offline")); }); await flush(); assert.ok(v.host.textContent.includes("结果未确认")); await v.click("使用原提交重试"); assert.equal(calls.length, 2); assert.strictEqual(calls[0], calls[1]); } finally { await v.close(); }
});

test("400 releases the draft and 409 refreshes the current month for manual review", async () => {
  let n = 0; let rosterCalls = 0; const v = await mount({ setBenefitPlan: async () => { n++; throw new ApiClientError(n === 1 ? 400 : 409, "CONFLICT"); }, listManagedBenefitRoster: async month => { rosterCalls++; return { benefitMonth: month, items: [{ benefitKind: "SOCIAL_INSURANCE", beneficiaryPersonId: "teacher", beneficiaryDisplayName: "王老师", benefitMonth: month, currentPlan: { version: 3, executionDay: 20, amountCents: "1500", sourceFund: { displayName: "运营资金", code: "FINANCE" }, active: true }, planVersions: [], todo: null, execution: null, status: "SCHEDULED" }] }; } });
  try { await v.fill(); await v.click("保存福利计划"); assert.equal(v.locks.at(-1), false); await v.click("保存福利计划"); assert.equal(rosterCalls, 1); assert.ok(v.host.textContent.includes("第 3 版")); } finally { await v.close(); }
});

test("all global finance roles can read and write, while non-global roles are denied without directory calls", async () => {
  for (const subject of ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"]) { const calls = []; const v = await mount({ setBenefitPlan: async submission => calls.push(submission) }, subject); try { assert.ok(v.host.textContent.includes("福利计划")); await v.fill(); await v.click("保存福利计划"); assert.equal(calls.length, 1); } finally { await v.close(); } }
  const denied = await mount({}, "TEACHING_TEACHER"); try { assert.ok(denied.host.textContent.includes("没有维护总部福利计划")); } finally { await denied.close(); }
});

test("regional, campus, self and narrowed global contexts never load or write", async () => {
  for (const contextPatch of [{ scope: "REGION", regionId: "r" }, { scope: "CAMPUS", campusId: "c" }, { scope: "SELF" }, { regionId: "r" }, { campusId: "c" }, { venueId: "v" }]) {
    let reads = 0; const v = await mount({ listManagedCashWageTeachers: async () => { reads++; return { items: [] }; } }, "SYSTEM_ADMIN", contextPatch);
    try { assert.equal(reads, 0); assert.ok(v.host.textContent.includes("没有维护总部福利计划")); } finally { await v.close(); }
  }
});

test("conflict with no matching roster item stays locked until explicit acknowledgement", async () => {
  let writes = 0; const v = await mount({ setBenefitPlan: async () => { writes++; throw new ApiClientError(409, "CONFLICT"); }, listManagedBenefitRoster: async month => ({ benefitMonth: month, items: [] }) });
  try { await v.fill(); await v.click("保存福利计划"); assert.equal(writes, 1); assert.ok(v.host.textContent.includes("最新名单中无该计划")); assert.equal(v.locks.at(-1), true); await v.click("我已核对，允许重新提交"); assert.equal(v.locks.at(-1), false); assert.equal(writes, 1); } finally { await v.close(); }
});

test("conflict refresh failure keeps parent locked and offers a retry", async () => {
  let refreshes = 0; const v = await mount({ setBenefitPlan: async () => { throw new ApiClientError(409, "CONFLICT"); }, listManagedBenefitRoster: async () => { refreshes++; throw new Error("offline"); } });
  try { await v.fill(); await v.click("保存福利计划"); assert.equal(refreshes, 1); assert.equal(v.locks.at(-1), true); assert.ok(v.button("重试读取最新计划")); await v.click("重试读取最新计划"); assert.equal(refreshes, 2); } finally { await v.close(); }
});

test("directory 401/403 invalidates the parent", async () => {
  for (const status of [401, 403]) { const v = await mount({ listBenefitSourceFunds: async () => { throw new ApiClientError(status, "FORBIDDEN_SCOPE"); } }); try { await flush(); assert.equal(v.invalidated(), 1); } finally { await v.close(); } }
});


test("parent busy blocks plan controls and direct save handler", async () => {
  let writes = 0;
  const v = await mount({ setBenefitPlan: async () => writes++ }, "HEADQUARTERS_FINANCE", {}, { busy: true });
  try {
    assert.equal(v.button("保存福利计划").disabled, true);
    await v.fill();
    await act(async () => props(v.button("保存福利计划")).onClick());
    assert.equal(writes, 0);
  } finally { await v.close(); }
});
