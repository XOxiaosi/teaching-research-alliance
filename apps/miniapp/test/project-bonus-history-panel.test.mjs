import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import test from "node:test";
import { ApiClientError, formatCentsAsBeans } from "@teaching-research-alliance/client";

const rootDir = resolve(import.meta.dirname, "..");
let bundle;
const plugin = {
  name: "project-bonus-history-taro",
  setup(buildApi) {
    buildApi.onResolve({ filter: /^@tarojs\/taro$/ }, () => ({ path: "taro", namespace: "bonus-history" }));
    buildApi.onLoad({ filter: /^taro$/, namespace: "bonus-history" }, () => ({
      loader: "js",
      contents: `export default {
        downloadFile: async () => { if (globalThis.__bonusDownloadPromise) await globalThis.__bonusDownloadPromise; return { statusCode: globalThis.__bonusDownloadStatus || 200, tempFilePath: '/tmp/bonus-file' }; },
        openDocument: async () => { globalThis.__bonusOpened = (globalThis.__bonusOpened || 0) + 1; },
        previewImage: async () => { globalThis.__bonusPreviewed = (globalThis.__bonusPreviewed || 0) + 1; }
      };`,
    }));
    buildApi.onResolve({ filter: /^@tarojs\/components$/ }, () => ({ path: "components", namespace: "bonus-history" }));
    buildApi.onLoad({ filter: /.*/, namespace: "bonus-history" }, () => ({
      loader: "js",
      contents: `import React from 'react';
        export const View=({children,...props})=>React.createElement('div',props,children);
        export const Text=({children,...props})=>React.createElement('span',props,children);
        export const Button=({children,...props})=>React.createElement('button',props,children);`,
    }));
  },
};
const panel = async () => {
  if (bundle) return bundle.module;
  const dir = await mkdtemp(resolve(import.meta.dirname, ".project-bonus-history-"));
  const out = resolve(dir, "panel.mjs");
  await build({
    entryPoints: [resolve(rootDir, "src/pages/index/project-bonus-history-panel.tsx")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    define: { __API_BASE_URL__: JSON.stringify("http://127.0.0.1:3100") },
    external: ["react", "@teaching-research-alliance/client"],
    plugins: [plugin],
  });
  bundle = { dir, module: await import(`file://${out}?${Date.now()}`) };
  return bundle.module;
};
const session = (subject = "HEADQUARTERS_FINANCE", extra = {}) => ({
  sessionId: `session-${subject}`,
  accountId: "account-1",
  personId: "person-1",
  currentRoleContext: { subject, scope: "GLOBAL", ...extra },
  roleContexts: [{ subject, scope: "GLOBAL", ...extra }],
});
const attachment = (versionId, originalFilename, mediaType) => ({
  versionId,
  purpose: "SUPPORTING_DOCUMENT",
  originalFilename,
  mediaType,
  sizeBytes: 8,
  sha256: "a".repeat(64),
});
const summary = (documentId = "bonus-1", patch = {}) => ({
  documentId,
  status: "COMPLETED",
  version: 1,
  projectNo: 11,
  projectName: "发放时项目名",
  amountCents: "9007199254740993123",
  reason: "阶段成果奖励",
  grantedAt: "2026-09-24T00:00:00.000Z",
  grantedByPersonId: "finance-1",
  grantedByCurrentDisplayName: "财务老师",
  recipient: { personId: "teacher-1", currentDisplayName: "王老师", accountId: "account-personal", accountCode: "PERSONAL:teacher-1" },
  source: { fundId: "fund-1", currentFundCode: "BONUS", currentDisplayName: "项目奖金资金", accountId: "account-fund", accountCode: "FUND:BONUS" },
  reversal: null,
  canReverse: true,
  ...patch,
});
const detail = {
  ...summary(),
  originalAttachments: [
    attachment("version-pdf", "发放凭证.pdf", "application/pdf"),
    attachment("version-image", "发放截图.png", "image/png"),
  ],
  reversal: {
    documentId: "reversal-1",
    version: 1,
    reason: "录入有误",
    reversedAt: "2026-09-25T00:00:00.000Z",
    reversedByPersonId: "admin-1",
    reversedByCurrentDisplayName: null,
    attachments: [attachment("version-reversal", "冲回凭证.pdf", "application/pdf")],
  },
  status: "REVERSED",
  canReverse: false,
};
const flush = async () => act(async () => { await Promise.resolve(); await new Promise((done) => setTimeout(done, 0)); });
const deferred = () => {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolveValue, rejectValue) => { resolvePromise = resolveValue; rejectPromise = rejectValue; });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};
const mount = async (element) => {
  const dom = new JSDOM("<div id='host'></div>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const host = dom.window.document.querySelector("#host");
  const root = createRoot(host);
  await act(async () => root.render(element));
  await flush();
  return { dom, host, root };
};
const click = async (view, text) => {
  const button = [...view.host.querySelectorAll("button")].find((node) => node.textContent.includes(text));
  assert.ok(button, `missing button: ${text}`);
  await act(async () => button.dispatchEvent(new view.dom.window.Event("click", { bubbles: true })));
  await flush();
};

test.after(async () => { if (bundle) await rm(bundle.dir, { recursive: true, force: true }); });

test("项目奖金历史展示冻结事实、精确大金额并对分页结果去重", async () => {
  const { ProjectBonusHistoryPanel } = await panel();
  const calls = [];
  const first = summary();
  const client = {
    hasRoleContext: true,
    currentSession: session(),
    listManagedProjectBonuses: async (input) => {
      calls.push(input);
      return input.cursor
        ? { items: [first, summary("bonus-2", { projectName: "第二个项目", recipient: { ...first.recipient, currentDisplayName: null } })], nextCursor: null }
        : { items: [first], nextCursor: "next-page" };
    },
    getManagedProjectBonusDetail: async () => detail,
    logout() { this.currentSession = null; this.hasRoleContext = false; },
  };
  const view = await mount(React.createElement(ProjectBonusHistoryPanel, { client, session: session(), sessionKey: "one" }));
  assert.match(view.host.textContent, /发放时项目名/);
  assert.ok(view.host.textContent.includes(formatCentsAsBeans(first.amountCents)));
  await click(view, "加载更多");
  assert.equal(view.host.querySelectorAll(".venue-board-fee").length, 2);
  assert.match(view.host.textContent, /原收款成员（当前名称不可用）/);
  assert.deepEqual(calls, [{ limit: 20 }, { cursor: "next-page", limit: 20 }]);
  await act(async () => view.root.unmount());
  view.dom.window.close();
});

test("项目奖金详情展示原发放与冲回附件并按 PDF、图片类型打开", async () => {
  const { ProjectBonusHistoryPanel } = await panel();
  const client = {
    hasRoleContext: true,
    currentSession: session(),
    listManagedProjectBonuses: async () => ({ items: [summary()], nextCursor: null }),
    getManagedProjectBonusDetail: async () => detail,
    logout() { this.currentSession = null; this.hasRoleContext = false; },
  };
  globalThis.__bonusOpened = 0;
  globalThis.__bonusPreviewed = 0;
  const view = await mount(React.createElement(ProjectBonusHistoryPanel, { client, session: session(), sessionKey: "detail" }));
  await click(view, "查看详情");
  assert.match(view.host.textContent, /奖金详情/);
  assert.match(view.host.textContent, /冲回原因：录入有误/);
  assert.match(view.host.textContent, /原冲回人（当前名称不可用）/);
  await click(view, "发放凭证.pdf");
  await click(view, "发放截图.png");
  assert.equal(globalThis.__bonusOpened, 1);
  assert.equal(globalThis.__bonusPreviewed, 1);
  await act(async () => view.root.unmount());
  view.dom.window.close();
});

test("身份切换丢弃迟到列表与详情，严格拒绝非总部身份", async () => {
  const { ProjectBonusHistoryPanel } = await panel();
  const oldList = deferred();
  const oldDetail = deferred();
  let listCount = 0;
  const client = {
    hasRoleContext: true,
    currentSession: session(),
    listManagedProjectBonuses: async () => ++listCount === 1 ? oldList.promise : { items: [summary("new-bonus", { projectName: "新身份项目" })], nextCursor: null },
    getManagedProjectBonusDetail: async () => oldDetail.promise,
    logout() { this.currentSession = null; this.hasRoleContext = false; },
  };
  const view = await mount(React.createElement(ProjectBonusHistoryPanel, { client, session: session(), sessionKey: "old" }));
  client.currentSession = session("SYSTEM_ADMIN");
  await act(async () => view.root.render(React.createElement(ProjectBonusHistoryPanel, { client, session: session("SYSTEM_ADMIN"), sessionKey: "new" })));
  await flush();
  await act(async () => oldList.resolve({ items: [summary("old-bonus", { projectName: "旧身份项目" })], nextCursor: null }));
  await flush();
  assert.match(view.host.textContent, /新身份项目/);
  assert.equal(view.host.textContent.includes("旧身份项目"), false);
  await click(view, "查看详情");
  await act(async () => view.root.render(React.createElement(ProjectBonusHistoryPanel, { client, session: session("TEACHING_TEACHER", { scope: "SELF" }), sessionKey: "denied" })));
  await act(async () => oldDetail.resolve(detail));
  await flush();
  assert.match(view.host.textContent, /没有查看总部项目奖金历史的权限/);
  assert.equal(view.host.textContent.includes("奖金详情"), false);
  await act(async () => view.root.unmount());
  view.dom.window.close();
});

test("项目奖金历史遇到 401/403 清空数据并通知父界面", async () => {
  const { ProjectBonusHistoryPanel } = await panel();
  for (const status of [401, 403]) {
    const invalidated = [];
    const client = {
      hasRoleContext: true,
      currentSession: session(),
      listManagedProjectBonuses: async () => { throw new ApiClientError(status, status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN_SCOPE"); },
      getManagedProjectBonusDetail: async () => detail,
      logout() { this.currentSession = null; this.hasRoleContext = false; },
    };
    const view = await mount(React.createElement(ProjectBonusHistoryPanel, { client, session: session(), sessionKey: `error-${status}`, onInvalidated: () => invalidated.push(true) }));
    assert.equal(invalidated.length, 1);
    assert.match(view.host.textContent, /身份已失效/);
    assert.equal(view.host.textContent.includes("发放时项目名"), false);
    await act(async () => view.root.unmount());
    view.dom.window.close();
  }
});

test("附件下载 403 会退出并清空详情，身份切换后的迟到附件不会打开", async () => {
  const { ProjectBonusHistoryPanel } = await panel();
  const invalidated = [];
  const client = {
    hasRoleContext: true,
    currentSession: session(),
    listManagedProjectBonuses: async () => ({ items: [summary()], nextCursor: null }),
    getManagedProjectBonusDetail: async () => detail,
    logout() { this.currentSession = null; this.hasRoleContext = false; },
  };
  globalThis.__bonusOpened = 0;
  globalThis.__bonusPreviewed = 0;
  globalThis.__bonusDownloadStatus = 403;
  const view = await mount(React.createElement(ProjectBonusHistoryPanel, { client, session: session(), sessionKey: "attachment-auth", onInvalidated: () => invalidated.push(true) }));
  await click(view, "查看详情");
  await click(view, "发放凭证.pdf");
  assert.equal(invalidated.length, 1);
  assert.equal(client.currentSession, null);
  assert.match(view.host.textContent, /身份已失效/);
  assert.equal(view.host.querySelector(".finance-detail"), null);

  globalThis.__bonusDownloadStatus = 0;
  client.currentSession = session("SYSTEM_ADMIN");
  client.hasRoleContext = true;
  await act(async () => view.root.render(React.createElement(ProjectBonusHistoryPanel, { client, session: session("SYSTEM_ADMIN"), sessionKey: "attachment-old" })));
  await flush();
  await click(view, "查看详情");
  const pending = deferred();
  globalThis.__bonusDownloadPromise = pending.promise;
  const pdf = [...view.host.querySelectorAll("button")].find((node) => node.textContent.includes("发放凭证.pdf"));
  assert.ok(pdf);
  await act(async () => pdf.dispatchEvent(new view.dom.window.Event("click", { bubbles: true })));
  client.currentSession = session("SYSTEM_OWNER");
  await act(async () => view.root.render(React.createElement(ProjectBonusHistoryPanel, { client, session: session("SYSTEM_OWNER"), sessionKey: "attachment-new" })));
  await act(async () => pending.resolve());
  await flush();
  assert.equal(globalThis.__bonusOpened, 0);
  assert.equal(globalThis.__bonusPreviewed, 0);
  delete globalThis.__bonusDownloadPromise;
  delete globalThis.__bonusDownloadStatus;
  await act(async () => view.root.unmount());
  view.dom.window.close();
});

test("详情编号错配只显示错误且不渲染错误记录", async () => {
  const { ProjectBonusHistoryPanel } = await panel();
  const client = {
    hasRoleContext: true,
    currentSession: session(),
    listManagedProjectBonuses: async () => ({ items: [summary()], nextCursor: null }),
    getManagedProjectBonusDetail: async () => ({ ...detail, documentId: "wrong-document" }),
    logout() { this.currentSession = null; this.hasRoleContext = false; },
  };
  const view = await mount(React.createElement(ProjectBonusHistoryPanel, { client, session: session(), sessionKey: "detail-mismatch" }));
  await click(view, "查看详情");
  assert.match(view.host.textContent, /详情与所选记录不匹配/);
  assert.equal(view.host.querySelector(".finance-detail"), null);
  await act(async () => view.root.unmount());
  view.dom.window.close();
});
