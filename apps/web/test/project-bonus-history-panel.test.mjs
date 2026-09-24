import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ApiClientError } from "@teaching-research-alliance/client";
import { ProjectBonusHistoryPanel } from "../dist/project-bonus-history-panel.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const context = (subject = "HEADQUARTERS_FINANCE") => ({ personId: `person-${subject}`, subject, scope: "GLOBAL" });
const session = (subject = "HEADQUARTERS_FINANCE") => ({ sessionId: `session-${subject}`, accountId: `account-${subject}`, personId: `person-${subject}`, currentRoleContext: context(subject), roleContexts: [context(subject)] });
const item = (id, status = "COMPLETED") => ({
  documentId: id, status, version: status === "COMPLETED" ? 2 : 3, projectNo: 2, projectName: "历史项目名",
  amountCents: "9007199254740993", reason: "阶段奖励", grantedAt: "2026-09-23T10:00:00.000Z",
  grantedByPersonId: "grantor", grantedByCurrentDisplayName: null,
  recipient: { personId: "recipient", currentDisplayName: "张老师", accountId: "recipient-account", accountCode: "person:recipient" },
  source: { fundId: "fund", currentFundCode: "OPERATING", currentDisplayName: "运营账户", accountId: "fund-account", accountCode: "company:fund" },
  reversal: status === "REVERSED" ? { documentId: "reversal", version: 2, reason: "录入错误", reversedAt: "2026-09-23T11:00:00.000Z", reversedByPersonId: "admin", reversedByCurrentDisplayName: "管理员" } : null,
  canReverse: status === "COMPLETED",
});
const detail = (id) => ({ ...item(id), originalAttachments: [], reversal: null });

async function mount(overrides = {}, subject = "HEADQUARTERS_FINANCE") {
  const dom = new JSDOM('<div id="app"></div>', { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.querySelector("#app");
  const root = createRoot(host);
  const invalidated = [];
  const calls = [];
  const client = {
    currentSession: session(subject), hasRoleContext: true,
    listManagedProjectBonuses: async (input) => { calls.push(["list", input]); return { items: [item("bonus-1")], nextCursor: "next" }; },
    getManagedProjectBonusDetail: async (id) => { calls.push(["detail", id]); return detail(id); },
    ...overrides,
  };
  let currentSession = session(subject);
  let key = "one";
  const render = async (active = true) => {
    client.currentSession = currentSession;
    await act(async () => { root.render(React.createElement(ProjectBonusHistoryPanel, { client, session: currentSession, sessionKey: key, active, onInvalidated: () => invalidated.push(true) })); await flush(); });
  };
  await render();
  return { host, root, dom, client, calls, invalidated, render, replace: (nextSubject, nextKey = "two") => { currentSession = session(nextSubject); key = nextKey; }, close: async () => { await act(async () => root.unmount()); dom.window.close(); } };
}

test("奖金历史保留发放时项目名和精确金额，分页去重并读取详情", async () => {
  let reads = 0;
  const view = await mount({
    listManagedProjectBonuses: async (input) => {
      void input; reads += 1;
      return reads === 1 ? { items: [item("bonus-1")], nextCursor: "next" } : { items: [item("bonus-1"), item("bonus-2", "REVERSED")], nextCursor: null };
    },
  });
  try {
    assert.match(view.host.textContent, /历史项目名/);
    assert.match(view.host.textContent, /90071992547409\.93/);
    await act(async () => [...view.host.querySelectorAll("button")].find((button) => button.textContent === "加载更多").click());
    await flush();
    assert.equal(view.host.querySelectorAll(".finance-list-row").length, 2);
    await act(async () => [...view.host.querySelectorAll("button")].find((button) => button.textContent === "查看详情").click());
    await flush();
    assert.match(view.host.textContent, /奖金详情/);
    assert.match(view.host.textContent, /原发放人（当前名称不可用）/);
    assert.deepEqual(view.calls.at(-1), ["detail", "bonus-1"]);
  } finally { await view.close(); }
});

test("身份切换后丢弃旧奖金历史和迟到详情", async () => {
  let resolveOld;
  const old = new Promise((resolve) => { resolveOld = resolve; });
  let reads = 0;
  const view = await mount({ listManagedProjectBonuses: () => reads++ === 0 ? old : Promise.resolve({ items: [item("fresh")], nextCursor: null }) });
  try {
    view.replace("SYSTEM_ADMIN");
    await view.render();
    await act(async () => { resolveOld({ items: [item("stale")], nextCursor: null }); await flush(); });
    assert.equal(view.host.textContent.includes("stale"), false);
    assert.match(view.host.textContent, /历史项目名/);
  } finally { await view.close(); }
});

test("401和403清空历史并通知父会话", async () => {
  for (const status of [401, 403]) {
    const view = await mount({ listManagedProjectBonuses: async () => { throw new ApiClientError(status, "AUTH"); } });
    try {
      assert.equal(view.invalidated.length, 1);
      assert.match(view.host.textContent, /身份已失效/);
      assert.equal(view.host.querySelectorAll(".finance-list-row").length, 0);
    } finally { await view.close(); }
  }
});
