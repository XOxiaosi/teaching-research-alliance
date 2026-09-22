import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const miniappDirectory = resolve(testDirectory, "..");
const repositoryDirectory = resolve(miniappDirectory, "../..");
const clientModule = await import(pathToFileURL(resolve(repositoryDirectory, "packages/client/dist/index.js")).href);

const success = (data) => ({ status: 200, body: { version: "test", data } });
const session = {
  sessionId: "mini-session-1", accountId: "account-1", personId: "person-1",
  roleContexts: [{ subject: "TEACHING_TEACHER", personId: "person-1", scope: "SELF" }],
  currentRoleContext: { subject: "TEACHING_TEACHER", personId: "person-1", scope: "SELF" }
};
const draft = { id: "draft-1", kind: "WITHDRAWAL", status: "DRAFT", version: 1, createdAt: "2026-09-21T00:00:00.000Z", updatedAt: "2026-09-21T00:00:00.000Z" };
const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer;

const attachment = (attachmentId, purpose, versions) => ({ attachmentId, purpose, createdAt: "2026-09-21T00:00:00.000Z", versions });
const ready = (versionId, versionNo, originalFilename) => ({ versionId, versionNo, status: "READY", originalFilename, declaredMediaType: "image/png", declaredSizeBytes: 8, createdAt: `2026-09-2${versionNo}T00:00:00.000Z` });

const taroPlugin = {
  name: "miniapp-test-taro",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@tarojs\/taro$/ }, () => ({ path: "miniapp-test-taro", namespace: "miniapp-test" }));
    pluginBuild.onResolve({ filter: /^@tarojs\/components$/ }, () => ({ path: "miniapp-test-components", namespace: "miniapp-test" }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "miniapp-test" }, (args) => ({
      loader: "js",
      contents: args.path === "miniapp-test-taro"
        ? "const taro=new Proxy({}, {get: (_target,key) => (...args) => globalThis.__miniappTaro[key](...args)}); export default taro;"
        : `import React from "react";
           export const View=({children,...props})=>React.createElement("div",props,children);
           export const Text=({children,...props})=>React.createElement("span",props,children);
           export const Button=({children,...props})=>React.createElement("button",props,children);
           export const Input=({password,maxlength,onInput,...props})=>React.createElement("input",{...props,...(maxlength===undefined?{}:{maxLength:maxlength}),onInput:(event)=>onInput?.({detail:{value:event.currentTarget.value}})});
           export const Picker=({children,range=[],value=0,onChange,disabled,...props})=>React.createElement("div",props,React.createElement("select",{disabled,value:String(value),onChange:(event)=>onChange?.({detail:{value:event.currentTarget.value}})},range.map((item,index)=>React.createElement("option",{key:index,value:String(index)},String(item)))),children);
           export const ScrollView=({children,scrollY,...props})=>React.createElement("div",props,children);`
    }));
  }
};

const bundleMiniappSource = async (entry, name) => {
  const directory = await mkdtemp(resolve(testDirectory, ".financial-panel-test-"));
  const output = resolve(directory, `${name}.mjs`);
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: output,
    define: { __API_BASE_URL__: JSON.stringify("http://127.0.0.1:3100") },
    external: ["react", "@teaching-research-alliance/client"],
    loader: { ".css": "empty" },
    plugins: [taroPlugin]
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, directory };
};

const bundleFinancialPanel = () => bundleMiniappSource(
  resolve(miniappDirectory, "src/pages/index/financial-panel.tsx"), "financial-panel"
);
const bundleIndexPage = () => bundleMiniappSource(
  resolve(miniappDirectory, "src/pages/index/index.tsx"), "index-page"
);

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
  });
};

const button = (container, label) => {
  const found = [...container.querySelectorAll("button")].find((element) => element.textContent === label);
  assert.ok(found, `button ${label} should exist`);
  return found;
};

const click = async (element) => {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await flush();
};

const select = async (element, value) => {
  await act(async () => {
    element.value = String(value);
    element.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await flush();
};

const input = async (element, value) => {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await flush();
};

const withDom = async (work) => {
  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
  try { await work(dom.window.document.querySelector("#app")); } finally { dom.window.close(); }
};

const mountFinancialPanel = async ({ attachments, reserveStatus = 200, submitFirstUnknown = false, initialDraft = draft, createFirstUnknown = false, listFailsAfterUpload = false }) => {
  const { FinancialPanel } = await bundled.module;
  const requestBodies = [];
  let currentAttachments = attachments;
  let submits = 0;
  let creates = 0;
  let invalidations = 0;
  globalThis.__miniappTaro = {
    showActionSheet: async () => ({ tapIndex: 0 }),
    chooseImage: async () => ({ tempFilePaths: ["wxfile://supporting.png"] }),
    chooseMessageFile: async () => ({ tempFiles: [] }),
    getFileSystemManager: () => ({ readFile: ({ success }) => success({ data: pngBytes }) }),
    request: async (request) => {
      if (request.url.includes("attachment-uploads/version-2/content")) {
        currentAttachments = [
          attachment("slot-support", "SUPPORTING_DOCUMENT", [ready("version-1", 1, "old.png"), ready("version-2", 2, "new.png")]),
          attachment("slot-screenshot", "APPLICATION_SCREENSHOT", [ready("version-3", 1, "screen.png")])
        ];
        return { statusCode: 200, data: { version: "test", data: { attachmentId: "slot-support", versionId: "version-2", versionNo: 2, status: "READY", purpose: "SUPPORTING_DOCUMENT", originalFilename: "supporting_document.image", declaredMediaType: "image/png", declaredSizeBytes: 8, createdAt: "2026-09-22T00:00:00.000Z" } } };
      }
      throw new Error(`unexpected binary request ${request.url}`);
    }
  };
  const client = new clientModule.TeacherApiClient({
    idempotencyKeyFactory: (() => { let sequence = 0; return () => `mini-key-${++sequence}`; })(),
    transport: async (request) => {
      if (request.path === "/v1/session") return success(session);
      if (request.path === "/v1/finance/withdrawals/sources") return success([{ accountId: "source-1", sourceType: "PERSON", label: "个人账户", balanceCents: "10000" }]);
      if (request.path === "/v1/finance/drafts/mine") return success(initialDraft === null && creates === 0 ? [] : [draft]);
      if (request.path === "/v1/finance/withdrawals/mine") return success([]);
      if (request.path === "/v1/finance/documents/draft-1/attachments") {
        if (listFailsAfterUpload && currentAttachments.some((item) => item.versions.some((version) => version.versionId === "version-2"))) throw new Error("list unavailable");
        return success({ documentId: "draft-1", attachments: currentAttachments });
      }
      if (request.path === "/v1/finance/attachments/slot-support/versions") {
        if (reserveStatus !== 200) return { status: reserveStatus, body: { error: { code: reserveStatus === 403 ? "FORBIDDEN_SCOPE" : "INVALID_INPUT", message: "failed" } } };
        return success({ attachmentId: "slot-support", versionId: "version-2", versionNo: 2, status: "UPLOADING", purpose: "SUPPORTING_DOCUMENT", originalFilename: "supporting_document.image", declaredMediaType: "image/png", declaredSizeBytes: 8, createdAt: "2026-09-22T00:00:00.000Z", replay: false });
      }
      if (request.path === "/v1/finance/drafts") {
        requestBodies.push(request.body);
        creates += 1;
        if (createFirstUnknown && creates === 1) throw new Error("network uncertain");
        return success({ ...draft, replay: creates > 1 });
      }
      if (request.path === "/v1/finance/drafts/draft-1/withdrawal-submit") {
        requestBodies.push(request.body);
        submits += 1;
        if (submitFirstUnknown && submits === 1) throw new Error("network uncertain");
        return success({ id: "draft-1", status: "PENDING_TRANSFER", version: 2, replay: submits > 1 });
      }
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  return {
    FinancialPanel, client, requestBodies, invalidations: () => invalidations,
    mount: async (container) => {
      const root = createRoot(container);
      await act(async () => { root.render(React.createElement(FinancialPanel, {
        client, session, onInvalidated: () => { invalidations += 1; }, onSubmitted: async () => {}, onBusyChange: () => {}, onUnconfirmedChange: () => {}, onDataMayChange: () => {}
      })); });
      await flush();
      return root;
    }
  };
};

const bundled = await bundleFinancialPanel();
test.after(async () => { await rm(bundled.directory, { recursive: true, force: true }); });

test("财务面板在同槽上传修订版后刷新，明确提交最新READY版本；未知提交保留原键和锁定字段", async () => {
  const fixture = await mountFinancialPanel({
    attachments: [
      attachment("slot-support", "SUPPORTING_DOCUMENT", [ready("version-1", 1, "old.png")]),
      attachment("slot-screenshot", "APPLICATION_SCREENSHOT", [ready("version-3", 1, "screen.png")])
    ],
    submitFirstUnknown: true
  });
  await withDom(async (container) => {
    const root = await fixture.mount(container);
    await click(button(container, "选择原件"));
    await click(button(container, "上传业务单据"));
    assert.match(container.textContent, /修订版 2 · new\.png/);
    await click(button(container, "刷新提现记录"));
    const pickers = [...container.querySelectorAll("select")];
    await select(pickers[0], 0);
    const inputs = [...container.querySelectorAll("input")];
    await input(inputs[0], "20.00"); await input(inputs[1], "张老师"); await input(inputs[2], "6222020000000000");
    await click(button(container, "提交提现申请"));
    assert.match(container.textContent, /余额待确认/);
    assert.equal(button(container, "安全重试提交").disabled, false);
    assert.equal(inputs[0].disabled, true);
    await click(button(container, "安全重试提交"));
    assert.deepEqual(fixture.requestBodies, [
      { expectedVersion: 1, sourceAccountId: "source-1", amountCents: "2000", recipientName: "张老师", bankAccount: "6222020000000000", attachmentVersionIds: ["version-2", "version-3"], idempotencyKey: "mini-key-2" },
      { expectedVersion: 1, sourceAccountId: "source-1", amountCents: "2000", recipientName: "张老师", bankAccount: "6222020000000000", attachmentVersionIds: ["version-2", "version-3"], idempotencyKey: "mini-key-2" }
    ]);
    await act(async () => root.unmount());
  });
});

test("原件预留明确4xx会解除上传锁，403继续走会话失效清理", async () => {
  const badInput = await mountFinancialPanel({ attachments: [attachment("slot-support", "SUPPORTING_DOCUMENT", [ready("version-1", 1, "old.png")])], reserveStatus: 400 });
  await withDom(async (container) => {
    const root = await badInput.mount(container);
    await click(button(container, "选择原件"));
    await click(button(container, "上传业务单据"));
    assert.equal(button(container, "上传业务单据").disabled, true);
    assert.equal(button(container, "选择原件").disabled, false);
    await act(async () => root.unmount());
  });

  const forbidden = await mountFinancialPanel({ attachments: [attachment("slot-support", "SUPPORTING_DOCUMENT", [ready("version-1", 1, "old.png")])], reserveStatus: 403 });
  await withDom(async (container) => {
    const root = await forbidden.mount(container);
    await click(button(container, "选择原件"));
    await click(button(container, "上传业务单据"));
    assert.equal(forbidden.invalidations(), 1);
    await act(async () => root.unmount());
  });
});

test("未知草稿创建在刷新后仍保留原键重试入口，不从同类草稿猜测成功", async () => {
  const fixture = await mountFinancialPanel({ attachments: [], initialDraft: null, createFirstUnknown: true });
  await withDom(async (container) => {
    const root = await fixture.mount(container);
    await click(button(container, "创建提现草稿"));
    assert.equal(button(container, "安全重试创建提现草稿").disabled, false);
    await click(button(container, "刷新提现记录"));
    assert.ok(button(container, "安全重试创建提现草稿"), "a discovered WITHDRAWAL draft must not replace the unknown command");
    await click(button(container, "安全重试创建提现草稿"));
    assert.deepEqual(fixture.requestBodies, [
      { kind: "WITHDRAWAL", idempotencyKey: "mini-key-1" },
      { kind: "WITHDRAWAL", idempotencyKey: "mini-key-1" }
    ]);
    await act(async () => root.unmount());
  });
});

test("READY 修订版列表刷新失败时不会悄悄提交旧版本", async () => {
  const fixture = await mountFinancialPanel({
    attachments: [
      attachment("slot-support", "SUPPORTING_DOCUMENT", [ready("version-1", 1, "old.png")]),
      attachment("slot-screenshot", "APPLICATION_SCREENSHOT", [ready("version-3", 1, "screen.png")])
    ],
    listFailsAfterUpload: true
  });
  await withDom(async (container) => {
    const root = await fixture.mount(container);
    await click(button(container, "选择原件"));
    await click(button(container, "上传业务单据"));
    await click(button(container, "提交提现申请"));
    assert.match(container.textContent, /请先刷新提现记录确认提交版本/);
    assert.deepEqual(fixture.requestBodies, []);
    await act(async () => root.unmount());
  });
});

test("未知提现时父级刷新、退出和角色切换都锁定，原冻结命令仍可重试", async () => {
  const indexBundle = await bundleIndexPage();
  let refreshes = 0;
  let logouts = 0;
  let submits = 0;
  const submitBodies = [];
  globalThis.__miniappTaro = {
    request: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/v1/session" && request.method === "POST") return { statusCode: 200, data: { version: "test", data: session } };
      if (path === "/v1/session" && request.method === "GET") { refreshes += 1; return { statusCode: 200, data: { version: "test", data: session } }; }
      if (path === "/v1/session/logout") { logouts += 1; return { statusCode: 200, data: { version: "test", data: {} } }; }
      if (path === "/v1/me") return { statusCode: 200, data: { version: "test", data: { nickname: "老师", balanceCents: "10000", currentYearIncomeByCategory: {} } } };
      if (path === "/v1/teaching/referrals") return { statusCode: 200, data: { version: "test", data: [] } };
      if (path === "/v1/teaching/weeks") return { statusCode: 200, data: { version: "test", data: [] } };
      if (path === "/v1/venues/available") return { statusCode: 200, data: { version: "test", data: [] } };
      if (path === "/v1/finance/withdrawals/sources") return { statusCode: 200, data: { version: "test", data: [{ accountId: "source-1", sourceType: "PERSON", label: "个人账户", balanceCents: "10000" }] } };
      if (path === "/v1/finance/drafts/mine") return { statusCode: 200, data: { version: "test", data: [draft] } };
      if (path === "/v1/finance/withdrawals/mine") return { statusCode: 200, data: { version: "test", data: [] } };
      if (path === "/v1/finance/documents/draft-1/attachments") return { statusCode: 200, data: { version: "test", data: { documentId: "draft-1", attachments: [attachment("slot-support", "SUPPORTING_DOCUMENT", [ready("version-1", 1, "old.png")]), attachment("slot-screenshot", "APPLICATION_SCREENSHOT", [ready("version-3", 1, "screen.png")])] } } };
      if (path === "/v1/finance/drafts/draft-1/withdrawal-submit") {
        submitBodies.push(request.data);
        submits += 1;
        if (submits === 1) throw new Error("network uncertain");
        return { statusCode: 200, data: { version: "test", data: { id: "draft-1", status: "PENDING_TRANSFER", version: 2, replay: true } } };
      }
      throw new Error(`unexpected parent request ${request.method} ${path}`);
    },
    showActionSheet: async () => ({ tapIndex: 0 }), chooseImage: async () => ({ tempFilePaths: [] }), chooseMessageFile: async () => ({ tempFiles: [] }), getFileSystemManager: () => ({ readFile: () => {} }), downloadFile: async () => ({ statusCode: 500 })
  };
  try {
    await withDom(async (container) => {
      const root = createRoot(container);
      await act(async () => { root.render(React.createElement(indexBundle.module.default)); });
      await flush();
      const loginInputs = [...container.querySelectorAll("input")];
      await input(loginInputs[0], "13800000000"); await input(loginInputs[1], "password");
      await click(button(container, "登录"));
      const sourcePicker = [...container.querySelectorAll("select")].find((element) => element.textContent.includes("个人账户"));
      assert.ok(sourcePicker);
      await select(sourcePicker, 0);
      const financialInputs = [...container.querySelectorAll("input")];
      await input(financialInputs[0], "20.00"); await input(financialInputs[1], "张老师"); await input(financialInputs[2], "6222020000000000");
      await click(button(container, "提交提现申请"));
      assert.equal(button(container, "刷新").disabled, true);
      assert.equal(button(container, "退出").disabled, true);
      assert.equal([...container.querySelectorAll("select")][0].disabled, true, "role picker is locked too");
      await click(button(container, "刷新")); await click(button(container, "退出"));
      assert.equal(refreshes, 0);
      assert.equal(logouts, 0);
      await click(button(container, "安全重试提交"));
      assert.equal(submitBodies.length, 2);
      assert.equal(submitBodies[0].idempotencyKey, submitBodies[1].idempotencyKey);
      await act(async () => root.unmount());
    });
  } finally { await rm(indexBundle.directory, { recursive: true, force: true }); }
});
