import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ApiClientError } from "@teaching-research-alliance/client";

const here = dirname(fileURLToPath(import.meta.url)); const rootDir = resolve(here, "../.."); let bundle;
const taro = { name: "venue-taro", setup(api) { api.onResolve({ filter: /^@tarojs\/components$/ }, () => ({ path: "venue-components", namespace: "venue-test" })); api.onLoad({ filter: /.*/, namespace: "venue-test" }, () => ({ loader: "js", contents: `import React from "react"; export const View=({children,...p})=>React.createElement("div",p,children); export const Text=({children,...p})=>React.createElement("span",p,children); export const Button=({children,onClick,...p})=>React.createElement("button",{...p,onClick},children); export const Input=({onInput,...p})=>React.createElement("input",{...p,onInput:e=>onInput?.({detail:{value:e.currentTarget.value}})}); export const Picker=({children,onChange,...p})=>React.createElement("select",{...p,onChange:e=>onChange?.({detail:{value:e.currentTarget.value}})},children);` })); } };
const panel = async () => { if (bundle) return bundle.module; const dir = await mkdtemp(resolve(here, ".venue-panel-test-")); const output = resolve(dir, "panel.mjs"); await build({ entryPoints: [resolve(rootDir, "miniapp/src/pages/index/venue-management-panel.tsx")], bundle: true, format: "esm", platform: "node", outfile: output, external: ["react", "@teaching-research-alliance/client"], plugins: [taro] }); bundle = { dir, module: await import(`${pathToFileURL(output).href}?${Date.now()}`) }; return bundle.module; };
test.after(async () => { if (bundle) await rm(bundle.dir, { recursive: true, force: true }); });
const flush = async () => { await act(async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const withDom = async (work) => { const dom = new JSDOM("<!doctype html><div id=app></div>", { url: "http://localhost" }); Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true }); try { await work(document.querySelector("#app")); } finally { dom.window.close(); } };
const click = async (element) => { await act(async () => element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))); await flush(); };
const input = async (element, value) => { await act(async () => { element.value = value; element.dispatchEvent(new window.Event("input", { bubbles: true })); }); await flush(); };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const sessionVenue = { id: "v1", name: "一号场地", status: "ACTIVE", defaultForOwner: false, version: 1, grants: [{ id: "old", granteePersonId: "p1", granteeNickname: "老师甲", canView: true, canWithdraw: false, validFrom: "2026-01-01", validTo: "2026-02-01", version: 1 }, { id: "current", granteePersonId: "p1", granteeNickname: "老师甲", canView: false, canWithdraw: true, validFrom: "2026-02-02", validTo: null, version: 2 }] };
const clientBase = (overrides = {}) => ({ listOwnVenues: async () => [sessionVenue], listReceivingTeachers: async () => [{ personId: "p1", nickname: "老师甲" }], createVenue: async () => ({}), renameVenue: async () => ({}), setVenueStatus: async () => ({}), setDefaultVenue: async () => ({}), setVenuePermission: async () => ({}), ...overrides });

test("未知创建结果冻结原名称并用同一幂等键重试，历史显示仅提现与已结束", async () => { await withDom(async (container) => { const calls = []; let count = 0; const client = clientBase({ createVenue: async (draft, key) => { calls.push({ draft, key }); if (++count === 1) throw new Error("timeout"); } }); const events = []; const { VenueManagementPanel } = await panel(); const root = createRoot(container); await act(async () => root.render(React.createElement(VenueManagementPanel, { client, sessionKey: "s1", onUnconfirmedChange: (value) => events.push(value) }))); await flush(); assert.match(container.textContent, /仅提现/); assert.match(container.textContent, /已结束/); const inputs = container.querySelectorAll("input"); await input(inputs[0], "新场地"); await click([...container.querySelectorAll("button")].find((button) => button.textContent === "创建场地")); assert.match(container.textContent, /尚未确认/); assert.equal(inputs[0].value, "新场地"); assert.equal(events.at(-1), true); await click([...container.querySelectorAll("button")].find((button) => button.textContent === "安全重试")); assert.equal(calls.length, 2); assert.deepEqual(calls[0].draft, calls[1].draft); assert.equal(calls[0].key, calls[1].key); assert.equal(events.at(-1), false); await act(async () => root.unmount()); }); });

for (const status of [401, 403]) test(`身份失效${status}通知上层`, async () => { await withDom(async (container) => { const invalidated = []; const client = clientBase({ listOwnVenues: async () => { throw new ApiClientError(status, status === 401 ? "UNAUTHORIZED" : "FORBIDDEN_SCOPE"); } }); const { VenueManagementPanel } = await panel(); const root = createRoot(container); await act(async () => root.render(React.createElement(VenueManagementPanel, { client, sessionKey: `s-${status}`, onInvalidated: () => invalidated.push(true) }))); await flush(); assert.deepEqual(invalidated, [true]); await act(async () => root.unmount()); }); });

test("身份切换后迟到的场地和老师目录不能回填新页面", async () => { await withDom(async (container) => {
  const oldVenues = deferred(); const oldTeachers = deferred(); let venueReads = 0; let teacherReads = 0;
  const client = clientBase({
    listOwnVenues: () => ++venueReads === 1 ? oldVenues.promise : Promise.resolve([{ ...sessionVenue, id: "new", name: "新身份场地", grants: [] }]),
    listReceivingTeachers: () => ++teacherReads === 1 ? oldTeachers.promise : Promise.resolve([{ personId: "new-teacher", nickname: "新身份老师" }]),
  });
  const { VenueManagementPanel } = await panel(); const root = createRoot(container);
  await act(async () => root.render(React.createElement(VenueManagementPanel, { client, sessionKey: "old" }))); await flush();
  await act(async () => root.render(React.createElement(VenueManagementPanel, { client, sessionKey: "new" }))); await flush();
  assert.match(container.textContent, /新身份场地/);
  await act(async () => { oldVenues.resolve([{ ...sessionVenue, name: "旧身份场地" }]); oldTeachers.resolve([{ personId: "old-teacher", nickname: "旧身份老师" }]); }); await flush();
  assert.doesNotMatch(container.textContent, /旧身份场地|旧身份老师/); assert.match(container.textContent, /新身份场地/);
  await act(async () => root.unmount());
}); });
