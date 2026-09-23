import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ApiClientError } from "@teaching-research-alliance/client";

let Panel;
let temp;
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const reactProps = node => node[Object.keys(node).find(key => key.startsWith("__reactProps$"))];
const ids = { teacher: "00000000-0000-4000-8000-000000000011", leader: "00000000-0000-4000-8000-000000000012", week: "00000000-0000-4000-8000-000000000013" };
const directory = (teacher = "授课老师甲") => ({ teachers: [{ personId: ids.teacher, nickname: teacher }], groupLeaders: [{ personId: ids.leader, nickname: "候选组长乙" }], currentWeeks: [{ id: ids.week, startsOn: "2026-09-21", endsOn: "2026-09-27", settlementMonth: "2026-09-01" }] });
const preview = () => ({ previewId: "preview-mini", teacherPersonId: ids.teacher, sourceRelatedPersonId: "old-hidden", sourceRelatedNickname: "已离职组长", newRelatedPersonId: ids.leader, effectiveTeachingWeekId: ids.week, effectiveAt: "2026-09-21T00:00:00.000Z", nextBoundaryAt: "2026-10-01T00:00:00.000Z", consideredFeeCount: 3, movedFeeCount: 2, zeroShareFeeCount: 1, excludedRefundCount: 0, movedAmountCents: "6600" });
const session = (subject = "SYSTEM_ADMIN", patch = {}) => ({ sessionId: "session", currentRoleContext: { personId: "manager", subject, scope: "GLOBAL", ...patch } });

test.before(async () => {
  temp = await mkdtemp(resolve(import.meta.dirname, ".group-leader-mini-"));
  const out = resolve(temp, "panel.mjs");
  await build({
    entryPoints: [resolve(import.meta.dirname, "../src/pages/index/group-leader-change-panel.tsx")], bundle: true, platform: "node", format: "esm", outfile: out, external: ["react", "react-dom", "@teaching-research-alliance/client"],
    plugins: [{ name: "taro", setup(buildApi) { buildApi.onResolve({ filter: /^@tarojs\/components$/ }, () => ({ path: "taro", namespace: "stub" })); buildApi.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ loader: "js", contents: `import React from 'react';export const View=({children,...p})=>React.createElement('div',p,children);export const Text=({children,...p})=>React.createElement('span',p,children);export const Button=({children,...p})=>React.createElement('button',p,children);export const Textarea=({onInput,...p})=>React.createElement('textarea',{...p,onInput});export const Picker=({children,onChange,...p})=>React.createElement('div',{...p,onChange,'data-picker':'true'},children);` })); } }],
  });
  Panel = (await import(out)).GroupLeaderChangePanel;
});
test.after(async () => { await rm(temp, { recursive: true, force: true }); });

async function mount(overrides = {}) {
  const dom = new JSDOM("<div id='host'></div>", { url: "http://localhost" }); Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.querySelector("#host"); const root = createRoot(host); const locks = []; const saved = []; const invalidated = []; let currentSession = session(); let key = "one";
  const client = { hasRoleContext: true, listGroupLeaderRelationshipCandidates: async () => directory(), previewGroupLeaderRelationshipChange: async () => preview(), createGroupLeaderRelationshipChangeSubmission: previewId => ({ previewId, idempotencyKey: "stable-mini-key" }), publishGroupLeaderRelationshipChange: async () => ({ replay: false }), ...overrides };
  const render = async () => { await act(async () => root.render(React.createElement(Panel, { client, session: currentSession, sessionKey: key, onSaved: () => saved.push(true), onInvalidated: () => invalidated.push(true), onUnconfirmedChange: value => locks.push(value) }))); await flush(); };
  await render();
  const buttons = text => [...host.querySelectorAll("button")].find(node => node.textContent === text);
  const pick = async (index, value) => { const node = host.querySelectorAll("[data-picker='true']")[index]; assert.ok(node, `picker ${index}`); await act(async () => reactProps(node).onChange({ detail: { value: String(value) } })); };
  const fill = async () => { await pick(0, 1); await pick(1, 1); await pick(2, 1); const textarea = host.querySelector("textarea"); await act(async () => reactProps(textarea).onInput({ detail: { value: "当前普通周调整组长" } })); };
  return { host, locks, saved, invalidated, render, fill, button: buttons, setSession: (next, nextKey = "two") => { currentSession = next; key = nextKey; }, close: async () => { await act(async () => root.unmount()); dom.window.close(); } };
}

test("mini preserves exact submission through an unknown result and blocks double publish", async () => {
  const wait = deferred(); const commands = []; const v = await mount({ publishGroupLeaderRelationshipChange: command => { commands.push(command); return commands.length === 1 ? wait.promise : Promise.resolve({ replay: true }); } });
  try {
    await v.fill(); await act(async () => v.button("生成普通周变更预览").click()); await flush();
    assert.match(v.host.textContent, /已离职组长/); assert.equal(v.host.textContent.includes("old-hidden"), false); assert.match(v.host.textContent, /下一关系边界/);
    await act(async () => { const publish = v.button("确认发布组长变更"); publish.click(); publish.click(); }); assert.equal(commands.length, 1);
    await act(async () => wait.reject(new Error("offline"))); await flush(); assert.equal(v.locks.at(-1), true);
    await act(async () => v.host.querySelector("[data-relationship-action='retry-publish']").click()); await flush();
    assert.equal(commands.length, 2); assert.strictEqual(commands[0], commands[1]); assert.equal(v.saved.length, 1); assert.equal(v.locks.at(-1), false);
  } finally { await v.close(); }
});

test("mini conflict clears preview and requires a new manual preview", async () => {
  const v = await mount({ publishGroupLeaderRelationshipChange: async () => { throw new ApiClientError(409, "RELATIONSHIP_PREVIEW_STALE"); } });
  try {
    await v.fill(); await act(async () => v.button("生成普通周变更预览").click()); await flush(); await act(async () => v.button("确认发布组长变更").click()); await flush();
    assert.match(v.host.textContent, /预览已过期，未自动发布/); assert.equal(v.host.querySelector("[data-relationship-action='retry-publish']"), null); assert.ok(v.button("重新生成预览")); assert.equal(v.locks.at(-1), false);
  } finally { await v.close(); }
});

test("mini discards a late prior identity directory and invalidates on 401/403", async () => {
  const old = deferred(); const fresh = deferred(); let reads = 0; const v = await mount({ listGroupLeaderRelationshipCandidates: () => ++reads === 1 ? old.promise : fresh.promise });
  try {
    v.setSession(session("SYSTEM_OWNER"), "one"); await v.render(); await act(async () => old.resolve(directory("旧身份老师"))); await flush(); assert.equal(v.host.textContent.includes("旧身份老师"), false);
    await act(async () => fresh.resolve(directory("新身份老师"))); await flush(); assert.ok(reactProps(v.host.querySelector("[data-picker='true']")).range.includes("新身份老师"));
  } finally { await v.close(); }
  for (const status of [401, 403]) { const auth = await mount({ listGroupLeaderRelationshipCandidates: async () => { throw new ApiClientError(status, "AUTH"); } }); try { await flush(); assert.equal(auth.invalidated.length, 1); assert.match(auth.host.textContent, /身份已失效/); } finally { await auth.close(); } }
});
