import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const miniappDirectory = resolve(testDirectory, "..");
const board = ({ id, canWithdraw, byDate = false }) => ({
  venue: { id, name: canWithdraw ? "提现共享场地" : "查看共享场地", ownerNickname: "场地主理人", canWithdraw, ...(canWithdraw ? { accountId: "venue-account", balanceCents: "8300" } : {}) },
  period: byDate ? { startsOn: "2026-09-21", endsOn: "2026-09-27" } : { teachingWeekId: "week-1" },
  members: [
    { personId: "owner", nickname: "场地主理人", canView: true, canWithdraw: true, isOwner: true },
    { personId: "viewer", nickname: "查看老师", canView: true, canWithdraw: false, isOwner: false }
  ],
  teachers: [{
    teacherPersonId: "teacher", teacherNickname: "王老师", totalVenueFeeCents: "1750",
    weeklyFees: [
      { weeklyFeeEntryId: "fee-1", teachingWeekId: "week-1", weekStartsOn: "2026-09-21", weekEndsOn: "2026-09-27", studentRecordId: "student-1", studentDisplayName: "学生甲", courseContextId: "数学", venueFeeCents: "1200" },
      { weeklyFeeEntryId: "fee-2", teachingWeekId: "week-1", weekStartsOn: "2026-09-21", weekEndsOn: "2026-09-27", studentRecordId: "student-2", studentDisplayName: "学生乙", courseContextId: "英语", venueFeeCents: "550" }
    ]
  }],
  totalVenueFeeCents: "1750"
});

const taroPlugin = {
  name: "venue-board-live-taro",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@tarojs\/taro$/ }, () => ({ path: "venue-board-taro", namespace: "venue-board-live" }));
    pluginBuild.onResolve({ filter: /^@tarojs\/components$/ }, () => ({ path: "venue-board-components", namespace: "venue-board-live" }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "venue-board-live" }, (args) => ({
      loader: "js",
      contents: args.path === "venue-board-taro"
        ? "export default new Proxy({}, { get: (_target, key) => (...args) => globalThis.__venueBoardTaro[key](...args) });"
        : `import React from "react";
           export const View=({children,...props})=>React.createElement("div",props,children);
           export const Text=({children,...props})=>React.createElement("span",props,children);
           export const Image=({src,...props})=>React.createElement("img",{...props,src});
           export const Button=({children,...props})=>React.createElement("button",props,children);
           export const Input=({onInput,...props})=>React.createElement("input",{...props,onInput:event=>onInput?.({detail:{value:event.currentTarget.value}})});
           export const Textarea=({onInput,...props})=>React.createElement("textarea",{...props,onInput:event=>onInput?.({detail:{value:event.currentTarget.value}})});
           export const Picker=({children,range=[],value=0,onChange,disabled,...props})=>React.createElement("div",props,React.createElement("select",{disabled,value:String(value),onChange:event=>onChange?.({detail:{value:event.currentTarget.value}})},range.map((item,index)=>React.createElement("option",{key:index,value:String(index)},String(item)))),children);
           export const ScrollView=({children,...props})=>React.createElement("div",props,children);`
    }));
  }
};

const bundle = async (entry, name) => {
  const directory = await mkdtemp(resolve(testDirectory, ".venue-board-live-"));
  const output = resolve(directory, `${name}.mjs`);
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: output, define: { __API_BASE_URL__: JSON.stringify("http://127.0.0.1:3100") }, external: ["react", "@teaching-research-alliance/client"], loader: { ".css": "empty" }, plugins: [taroPlugin] });
  return { module: await import(`${pathToFileURL(output).href}?${Date.now()}`), directory };
};
const flush = async () => { await act(async () => { await Promise.resolve(); await new Promise((done) => setTimeout(done, 0)); }); };
const click = async (element) => { assert.ok(element); await act(async () => element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))); await flush(); };
const select = async (element, value) => { assert.ok(element); await act(async () => { element.value = String(value); element.dispatchEvent(new window.Event("change", { bubbles: true })); }); await flush(); };
const input = async (element, value) => { assert.ok(element); await act(async () => { element.value = value; element.dispatchEvent(new window.Event("input", { bubbles: true })); }); await flush(); };
const button = (container, label) => {
  const found = [...container.querySelectorAll("button")].find((element) => element.textContent === label);
  assert.ok(found, `button ${label} should exist`);
  return found;
};
const withDom = async (work) => {
  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
  try { await work(dom.window.document.querySelector("#app")); } finally { dom.window.close(); }
};

let panelBundle;
let indexBundle;
const panelModule = async () => {
  if (panelBundle === undefined) panelBundle = await bundle(resolve(miniappDirectory, "src/pages/index/venue-board-panel.tsx"), "venue-board-panel");
  return panelBundle.module;
};
const indexModule = async () => {
  if (indexBundle === undefined) indexBundle = await bundle(resolve(miniappDirectory, "src/pages/index/index.tsx"), "index-page");
  return indexBundle.module;
};
test.after(async () => {
  await Promise.all([panelBundle, indexBundle].filter(Boolean).map(({ directory }) => rm(directory, { recursive: true, force: true })));
});

test("小程序共享看板按教学周和日期传递筛选，VIEW 展示老师、学生与费用而不展示余额", async () => {
  const { VenueBoardPanel } = await panelModule();
  const calls = [];
  const client = { getVenueBoard: async (venueId, filter) => { calls.push({ venueId, filter }); return board({ id: venueId, canWithdraw: false, byDate: filter.startsOn !== undefined }); } };
  await withDom(async (container) => {
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(VenueBoardPanel, { client, venues: [{ id: "venue-view", name: "查看共享场地" }], weeks: [{ weekId: "week-1", periodLabel: "验收教学周", startsOn: "2026-09-21", endsOn: "2026-09-27" }] })));
    const selects = container.querySelectorAll("select");
    await select(selects[1], 1);
    await click(button(container, "查看看板"));
    assert.deepEqual(calls[0], { venueId: "venue-view", filter: { teachingWeekId: "week-1" } });
    for (const value of ["场地总使用费", "17.50 豆", "王老师", "学生甲", "学生乙", "12.00 豆", "5.50 豆", "查看老师 · 仅查看"]) assert.ok(container.textContent.includes(value), value);
    assert.equal(container.textContent.includes("场地可提现余额"), false);
    assert.equal([...container.querySelectorAll("button")].some((element) => /提现/.test(element.textContent)), false);

    await select(container.querySelectorAll("select")[1], 0);
    const dateInputs = container.querySelectorAll('input[placeholder="YYYY-MM-DD"]');
    await input(dateInputs[0], "2026-09-21");
    await input(dateInputs[1], "2026-09-27");
    await click(button(container, "查看看板"));
    assert.deepEqual(calls[1], { venueId: "venue-view", filter: { startsOn: "2026-09-21", endsOn: "2026-09-27" } });
    await act(async () => root.unmount());
  });
});

test("小程序 WITHDRAW 看板只展示该场地余额，所有者上下文固定自身场地并可按日期读取", async () => {
  const { VenueBoardPanel } = await panelModule();
  const withdrawCalls = [];
  const withdrawClient = { getVenueBoard: async (venueId, filter) => { withdrawCalls.push({ venueId, filter }); return board({ id: venueId, canWithdraw: true }); } };
  await withDom(async (container) => {
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(VenueBoardPanel, { client: withdrawClient, venues: [{ id: "venue-withdraw", name: "提现共享场地" }], weeks: [{ weekId: "week-1", startsOn: "2026-09-21", endsOn: "2026-09-27" }] })));
    await select(container.querySelectorAll("select")[1], 1);
    await click(button(container, "查看看板"));
    assert.deepEqual(withdrawCalls[0], { venueId: "venue-withdraw", filter: { teachingWeekId: "week-1" } });
    assert.ok(container.textContent.includes("场地可提现余额"));
    assert.ok(container.textContent.includes("83.00 豆"));
    assert.equal([...container.querySelectorAll("button")].some((element) => /提现/.test(element.textContent)), false, "看板没有提现执行按钮");
    await act(async () => root.unmount());
  });

  const IndexPage = (await indexModule()).default;
  const ownerCalls = [];
  const ownerSession = {
    sessionId: "owner-session", accountId: "owner-account", personId: "owner-person",
    roleContexts: [{ subject: "VENUE_OWNER", personId: "owner-person", scope: "VENUE", venueId: "owner-venue" }],
    currentRoleContext: { subject: "VENUE_OWNER", personId: "owner-person", scope: "VENUE", venueId: "owner-venue" }
  };
  globalThis.__venueBoardTaro = {
    request: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v1/session" && request.method === "POST") return { statusCode: 200, data: { version: "test", data: ownerSession } };
      if (url.pathname === "/v1/venues/owner-venue/board") {
        ownerCalls.push(Object.fromEntries(url.searchParams.entries()));
        return { statusCode: 200, data: { version: "test", data: board({ id: "owner-venue", canWithdraw: true, byDate: true }) } };
      }
      throw new Error(`unexpected owner request ${request.method} ${url.pathname}`);
    }
  };
  await withDom(async (container) => {
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(IndexPage)));
    const inputs = container.querySelectorAll("input");
    await input(inputs[0], "13800000001"); await input(inputs[1], "password");
    await click(button(container, "登录"));
    assert.ok(container.textContent.includes("共享场地看板"));
    const selects = container.querySelectorAll("select");
    assert.equal(selects[1].disabled, true, "VENUE_OWNER 的场地固定为当前上下文");
    const dateInputs = container.querySelectorAll('input[placeholder="YYYY-MM-DD"]');
    await input(dateInputs[0], "2026-09-21"); await input(dateInputs[1], "2026-09-27");
    await click(button(container, "查看看板"));
    assert.deepEqual(ownerCalls, [{ startsOn: "2026-09-21", endsOn: "2026-09-27" }]);
    assert.ok(container.textContent.includes("83.00 豆"));
    await act(async () => root.unmount());
  });
});

test("看板身份切换清空旧筛选并丢弃旧请求响应", async () => {
  const { VenueBoardPanel } = await panelModule();
  let resolveOld;
  const oldResponse = new Promise((resolve) => { resolveOld = resolve; });
  const client = { getVenueBoard: async () => oldResponse };
  await withDom(async (container) => {
    const root = createRoot(container);
    const props = { client, sessionKey: "teacher", venues: [{ id: "venue-1", name: "场地一" }], weeks: [{ weekId: "week-1", periodLabel: "第一周", startsOn: "2026-09-21", endsOn: "2026-09-27" }] };
    await act(async () => root.render(React.createElement(VenueBoardPanel, props)));
    await select(container.querySelectorAll("select")[1], 1);
    await click(button(container, "查看看板"));
    await act(async () => root.render(React.createElement(VenueBoardPanel, { ...props, sessionKey: "planner", venues: [], weeks: [] })));
    assert.equal(container.querySelectorAll('input[placeholder="YYYY-MM-DD"]').length, 2, "身份切换后日期筛选恢复");
    resolveOld(board({ id: "venue-1", canWithdraw: false }));
    await flush();
    assert.equal(container.textContent.includes("学生甲"), false, "旧身份响应不得回填");
    await act(async () => root.unmount());
  });
});
