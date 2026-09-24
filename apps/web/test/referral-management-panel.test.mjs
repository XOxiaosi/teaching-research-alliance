import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ApiClientError } from "../../../packages/client/dist/index.js";

const dirs = [];
const deferred = () => { let resolve; let reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const received = (id, name = "同名学生", status = "PENDING") => ({ referralId: id, studentRecordId: `student-${id}`, studentDisplayName: name, courseContextId: id === "one" ? "数学" : "英语", referralStatus: status, version: 1, initialVenueId: null, submittedAt: "2026-09-20T00:00:00Z", unacceptedExpiresAt: "2026-10-11T00:00:00Z", weeklyFees: [] });
const sent = (id, name = "同名学生", status = "PENDING") => ({ referralId: id, studentRecordId: `student-${id}`, studentDisplayName: name, courseContextId: id === "one" ? "数学" : "英语", receiverPersonId: `receiver-${id}`, receiverNickname: `接收老师${id}`, referralStatus: status, version: 1, submittedAt: "2026-09-20T00:00:00Z", sourceSubject: "TEACHING_TEACHER", classType: "ONE_TO_ONE", weeklyFees: [] });
const flush = async () => act(async () => { await new Promise((done) => setTimeout(done, 0)); });

async function loadPanel() {
  const directory = await mkdtemp(resolve(import.meta.dirname, ".referral-management-"));
  dirs.push(directory);
  const output = resolve(directory, "panel.mjs");
  await build({ entryPoints: [resolve(import.meta.dirname, "../src/referral-management-panel.tsx")], bundle: true, format: "esm", platform: "node", outfile: output, external: ["react", "react-dom/client", "@teaching-research-alliance/client"] });
  return (await import(output)).ReferralManagementPanel;
}

const clientBase = () => ({
  listReceivedReferrals: async () => [], listSentReferrals: async () => [], listReceivingTeachers: async () => [],
  createReferralAcceptanceSubmission: (draft) => ({ draft, idempotencyKey: "accept-key" }), acceptReferral: async () => ({}),
  createReferralLifecycleSubmission: (draft) => ({ draft, idempotencyKey: "life-key" }), changeReferralLifecycle: async () => ({}),
  createReferralCopySubmission: (draft) => ({ draft, idempotencyKey: "copy-key" }), copyReferral: async () => ({}),
});

async function mount(client, props = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const before = new Map(["window", "document", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const host = dom.window.document.getElementById("root");
  const root = createRoot(host);
  const Panel = await loadPanel();
  let invalidations = 0;
  const render = async (extra = {}) => { await act(async () => root.render(React.createElement(Panel, { client, venues: [{ id: "venue-a", name: "A场地" }], sessionKey: "teacher", onInvalidated: () => { invalidations += 1; }, ...props, ...extra }))); await flush(); };
  const select = async (label, value) => act(async () => { const input = host.querySelector(`select[aria-label="${label}"]`); assert.ok(input, label); input.value = value; input.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  const click = async (text) => { const button = [...host.querySelectorAll("button")].find((item) => item.textContent === text); assert.ok(button, text); await act(async () => button.click()); await flush(); };
  await render();
  return { host, render, select, click, invalidations: () => invalidations, close: async () => { await act(async () => root.unmount()); dom.window.close(); for (const [key, descriptor] of before) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } } };
}

test.after(async () => { for (const directory of dirs) await rm(directory, { recursive: true, force: true }); });

test("切换身份后迟到的接收列表不能回填新页面", async () => {
  const old = deferred(); const client = clientBase(); let calls = 0;
  client.listReceivedReferrals = () => ++calls === 1 ? old.promise : Promise.resolve([]);
  const ui = await mount(client);
  try {
    await ui.render({ sessionKey: "planner", venues: [] });
    await act(async () => old.resolve([received("old", "旧身份学生")])); await flush();
    assert.equal(ui.host.textContent.includes("旧身份学生"), false);
    assert.match(ui.host.textContent, /暂无可处理的学生/);
  } finally { await ui.close(); }
});

test("读取401或403清空列表并通知父会话", async () => {
  const client = clientBase(); client.listReceivedReferrals = async () => { throw new ApiClientError(403, "FORBIDDEN_SCOPE"); };
  const ui = await mount(client);
  try {
    await flush();
    assert.equal(ui.invalidations(), 1);
    assert.match(ui.host.textContent, /登录或身份已失效/);
    assert.doesNotMatch(ui.host.textContent, /同名学生/);
  } finally { await ui.close(); }
});

test("未知接收结果冻结原命令并以同一幂等键安全重试", async () => {
  const client = clientBase(); const calls = [];
  client.listReceivedReferrals = async () => [received("one")];
  client.listReceivingTeachers = async () => [{ personId: "teacher-b", nickname: "老师B" }];
  client.acceptReferral = async (submission) => { calls.push(submission); if (calls.length === 1) throw new Error("network"); return {}; };
  const ui = await mount(client);
  try {
    await ui.select("接收场地-one", "venue-a");
    await ui.click("接收学生");
    assert.match(ui.host.textContent, /结果尚未确认/);
    assert.ok(ui.host.querySelector('select[aria-label="接收场地-one"]').disabled);
    await ui.click("安全重试原操作");
    assert.equal(calls.length, 2);
    assert.equal(calls[0], calls[1]);
    assert.equal(calls[0].idempotencyKey, "accept-key");
  } finally { await ui.close(); }
});

test("同名学生的独立推荐和生命周期操作各自显示", async () => {
  const client = clientBase(); const lifecycle = [];
  client.listSentReferrals = async () => [sent("one"), sent("two")];
  client.changeReferralLifecycle = async (submission) => { lifecycle.push(submission); return {}; };
  const ui = await mount(client);
  try {
    assert.match(ui.host.textContent, /推荐编号 one/);
    assert.match(ui.host.textContent, /推荐编号 two/);
    assert.match(ui.host.textContent, /数学/);
    assert.match(ui.host.textContent, /英语/);
    await ui.click("归档推荐");
    assert.equal(lifecycle.length, 1);
    assert.equal(lifecycle[0].draft.referralId, "one");
  } finally { await ui.close(); }
});

test("接收老师只能将已接收课程完结，未知结果保留同一命令", async () => {
  const client = clientBase(); const calls = [];
  client.listReceivedReferrals = async () => [received("one", "学生甲", "ACCEPTED")];
  client.changeReferralLifecycle = async (submission) => { calls.push(submission); if (calls.length === 1) throw new Error("network"); return {}; };
  const ui = await mount(client);
  try {
    await ui.click("完结课程");
    assert.match(ui.host.textContent, /结果尚未确认/);
    await ui.click("安全重试原操作");
    assert.equal(calls.length, 2); assert.equal(calls[0], calls[1]); assert.equal(calls[0].draft.command, "COMPLETE");
  } finally { await ui.close(); }
});

for (const [status, button, expectedCommand] of [["PENDING", "归档推荐", "ARCHIVE"], ["ARCHIVED", "重新激活", "REACTIVATE"]]) test(`${button}未知结果复用原生命周期命令`, async () => {
  const client = clientBase(); const calls = [];
  client.listSentReferrals = async () => [sent("one", "学生甲", status)];
  client.changeReferralLifecycle = async (submission) => { calls.push(submission); if (calls.length === 1) throw new Error("network"); return {}; };
  const ui = await mount(client);
  try {
    await ui.click(button);
    assert.match(ui.host.textContent, /结果尚未确认/);
    await ui.click("安全重试原操作");
    assert.equal(calls.length, 2); assert.equal(calls[0], calls[1]);
    assert.equal(calls[0].idempotencyKey, "life-key"); assert.equal(calls[0].draft.command, expectedCommand);
  } finally { await ui.close(); }
});

test("复制推荐未知结果复用原独立推荐命令", async () => {
  const client = clientBase(); const calls = [];
  client.listSentReferrals = async () => [sent("one", "学生甲")];
  client.listReceivingTeachers = async () => [{ personId: "receiver-one", nickname: "原老师" }, { personId: "teacher-b", nickname: "老师B" }];
  client.copyReferral = async (submission) => { calls.push(submission); if (calls.length === 1) throw new Error("network"); return {}; };
  const ui = await mount(client);
  try {
    await ui.click("再推给其他老师"); await ui.select("新的接收老师", "teacher-b"); await ui.click("创建独立推荐");
    assert.match(ui.host.textContent, /结果尚未确认/);
    await ui.click("安全重试原操作");
    assert.equal(calls.length, 2); assert.equal(calls[0], calls[1]); assert.equal(calls[0].idempotencyKey, "copy-key");
  } finally { await ui.close(); }
});
