import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { VenueBoardPanel } from "../dist/venue-board-panel.js";
import { ApiClientError } from "../../../packages/client/dist/index.js";

const data = { venue: { id: "a", name: "旧身份场地", canWithdraw: true, balanceCents: "8300" }, members: [], teachers: [], totalVenueFeeCents: "1200" };
const venues = [{ id: "a", name: "场地A" }, { id: "b", name: "场地B" }];
const weeks = [{ weekId: "w", startsOn: "2026-09-21", endsOn: "2026-09-27" }];

async function mount(client) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const before = new Map(["window", "document", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const host = dom.window.document.getElementById("root");
  const root = createRoot(host);
  const render = async extra => act(async () => root.render(React.createElement(VenueBoardPanel, { client, venues, weeks, sessionKey: "teacher", ...extra })));
  const select = async (label, value) => act(async () => {
    const input = host.querySelector(`select[aria-label="${label}"]`);
    input.value = value;
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  const click = async () => act(async () => host.querySelector("button").click());
  await render();
  return { host, render, select, click, close: async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of before) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  } };
}

test("网页切身份清教学周和旧余额，旧看板响应不能回填", async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const ui = await mount({ getVenueBoard: () => pending });
  try {
    await ui.select("教学周", "w");
    await ui.click();
    await ui.render({ sessionKey: "planner", venues: [], weeks: [] });
    assert.equal(ui.host.querySelector('select[aria-label="场地看板"]').value, "");
    assert.equal(ui.host.querySelectorAll('input[type="date"]').length, 2);
    await act(async () => resolve(data));
    assert.doesNotMatch(ui.host.textContent, /83\.00|旧身份场地/);
    assert.equal(ui.host.querySelector("button").disabled, false);
  } finally { await ui.close(); }
});

test("网页更换场地和查询筛选清空已展示结果", async () => {
  const ui = await mount({ getVenueBoard: async () => data });
  try {
    await ui.select("教学周", "w");
    await ui.click();
    assert.match(ui.host.textContent, /83\.00/);
    await ui.select("场地看板", "b");
    assert.doesNotMatch(ui.host.textContent, /83\.00/);
    await ui.click();
    assert.match(ui.host.textContent, /83\.00/);
    await ui.select("教学周", "");
    assert.doesNotMatch(ui.host.textContent, /83\.00/);
  } finally { await ui.close(); }
});

test("网页看板权限失效传递至父会话并移除结果", async () => {
  let invalidated = 0;
  const ui = await mount({ getVenueBoard: async () => { throw new ApiClientError(403, "FORBIDDEN_SCOPE"); } });
  try {
    await ui.render({ onInvalidated: () => { invalidated += 1; } });
    await ui.select("教学周", "w");
    await ui.click();
    assert.equal(invalidated, 1);
    assert.doesNotMatch(ui.host.textContent, /83\.00/);
  } finally { await ui.close(); }
});
