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
const ids = { teacher: "00000000-0000-4000-8000-000000000001", leader: "00000000-0000-4000-8000-000000000002", week: "00000000-0000-4000-8000-000000000003" };
const directory = (teacher = "授课老师甲") => ({
  teachers: [{ personId: ids.teacher, nickname: teacher }],
  groupLeaders: [{ personId: ids.leader, nickname: "候选组长乙" }],
  currentWeeks: [{ id: ids.week, startsOn: "2026-09-21", endsOn: "2026-09-27", settlementMonth: "2026-09-01" }],
});
const preview = () => ({
  previewId: "preview-1", teacherPersonId: ids.teacher, sourceRelatedPersonId: "leave-person-must-not-render", sourceRelatedNickname: "已离职组长", newRelatedPersonId: ids.leader,
  effectiveTeachingWeekId: ids.week, effectiveAt: "2026-09-21T00:00:00.000Z", nextBoundaryAt: null,
  consideredFeeCount: 4, movedFeeCount: 3, zeroShareFeeCount: 1, excludedRefundCount: 0, movedAmountCents: "8800",
});
const session = (subject = "SYSTEM_ADMIN", patch = {}) => ({ sessionId: "session", currentRoleContext: { personId: "manager", subject, scope: "GLOBAL", ...patch } });

test.before(async () => {
  temp = await mkdtemp(resolve(import.meta.dirname, ".group-leader-web-"));
  const out = resolve(temp, "panel.mjs");
  await build({ entryPoints: [resolve(import.meta.dirname, "../src/group-leader-change-panel.tsx")], bundle: true, platform: "node", format: "esm", outfile: out, external: ["react", "react-dom", "@teaching-research-alliance/client"] });
  Panel = (await import(out)).GroupLeaderChangePanel;
});
test.after(async () => { await rm(temp, { recursive: true, force: true }); });

async function mount(overrides = {}) {
  const dom = new JSDOM("<div id='host'></div>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.querySelector("#host"); const root = createRoot(host);
  const saved = []; const invalidated = []; const locks = []; let currentSession = session(); let key = "one";
  const client = {
    hasRoleContext: true,
    listGroupLeaderRelationshipCandidates: async () => directory(),
    previewGroupLeaderRelationshipChange: async () => preview(),
    createGroupLeaderRelationshipChangeSubmission: previewId => ({ previewId, idempotencyKey: "stable-publish-key" }),
    publishGroupLeaderRelationshipChange: async () => ({ replay: false }),
    ...overrides,
  };
  const render = async () => { await act(async () => root.render(React.createElement(Panel, { client, session: currentSession, sessionKey: key, onSaved: () => saved.push(true), onInvalidated: () => invalidated.push(true), onUnconfirmedChange: value => locks.push(value) }))); await flush(); };
  await render();
  const button = text => [...host.querySelectorAll("button")].find(node => node.textContent === text);
  const change = async (label, value) => { const node = host.querySelector(`[aria-label="${label}"]`); assert.ok(node, label); await act(async () => reactProps(node).onChange({ target: { value } })); };
  const fill = async () => { await change("授课老师", ids.teacher); await change("新组长", ids.leader); await change("当前普通周", ids.week); await change("变更原因", "当前普通周调整组长"); };
  return { host, client, saved, invalidated, locks, render, fill, button, setSession: (next, nextKey = "two") => { currentSession = next; key = nextKey; }, close: async () => { await act(async () => root.unmount()); dom.window.close(); } };
}

test("publishes only after preview and unknown retry reuses the exact submission", async () => {
  const first = deferred(); const calls = [];
  const v = await mount({ publishGroupLeaderRelationshipChange: command => { calls.push(command); return calls.length === 1 ? first.promise : Promise.resolve({ replay: true }); } });
  try {
    await v.fill(); await act(async () => v.button("生成普通周变更预览").click()); await flush();
    assert.match(v.host.textContent, /已离职组长/); assert.equal(v.host.textContent.includes("leave-person-must-not-render"), false);
    assert.match(v.host.textContent, /北京时间生效起点/); assert.match(v.host.textContent, /不增加新的费用收入/);
    await act(async () => { const publish = v.button("确认发布组长变更"); publish.click(); publish.click(); });
    assert.equal(calls.length, 1); assert.equal(v.locks.at(-1), true);
    await act(async () => first.reject(new Error("network interrupted"))); await flush();
    assert.ok(v.host.querySelector("[data-relationship-action='retry-publish']"));
    await act(async () => v.host.querySelector("[data-relationship-action='retry-publish']").click()); await flush();
    assert.equal(calls.length, 2); assert.strictEqual(calls[0], calls[1]); assert.equal(v.saved.length, 1); assert.equal(v.locks.at(-1), false);
  } finally { await v.close(); }
});

test("stale preview is cleared and never automatically republished", async () => {
  const calls = []; const v = await mount({ publishGroupLeaderRelationshipChange: async command => { calls.push(command); throw new ApiClientError(409, "RELATIONSHIP_PREVIEW_STALE"); } });
  try {
    await v.fill(); await act(async () => v.button("生成普通周变更预览").click()); await flush();
    await act(async () => v.button("确认发布组长变更").click()); await flush();
    assert.equal(calls.length, 1); assert.match(v.host.textContent, /预览已过期，未自动发布/);
    assert.equal(v.host.querySelector("[aria-label='组长变更预览']"), null); assert.equal(v.host.querySelector("[data-relationship-action='retry-publish']"), null);
    assert.ok(v.button("重新生成预览")); assert.equal(v.locks.at(-1), false);
  } finally { await v.close(); }
});

test("late directory, scoped role, and auth failure cannot retain privileged data", async () => {
  const old = deferred(); const fresh = deferred(); let reads = 0;
  const v = await mount({ listGroupLeaderRelationshipCandidates: () => ++reads === 1 ? old.promise : fresh.promise });
  try {
    v.setSession(session("SYSTEM_OWNER"), "one"); await v.render();
    await act(async () => old.resolve(directory("旧身份老师"))); await flush();
    assert.equal(v.host.textContent.includes("旧身份老师"), false);
    await act(async () => fresh.resolve(directory("新身份老师"))); await flush();
    assert.match(v.host.textContent, /新身份老师/);
    v.setSession(session("SYSTEM_ADMIN", { scope: "REGION", regionId: "region" }), "two"); await v.render();
    assert.match(v.host.textContent, /没有管理员全局关系调整权限/);
  } finally { await v.close(); }

  const auth = await mount({ listGroupLeaderRelationshipCandidates: async () => { throw new ApiClientError(403, "FORBIDDEN_SCOPE"); } });
  try { await flush(); assert.equal(auth.invalidated.length, 1); assert.match(auth.host.textContent, /身份已失效/); } finally { await auth.close(); }
});
