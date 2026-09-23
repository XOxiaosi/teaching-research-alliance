import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import test from "node:test";
import { ApiClientError } from "@teaching-research-alliance/client";

const rootDir = resolve(import.meta.dirname, "..");
let bundle;
const plugin = {
  name: "benefit-taro",
  setup(buildApi) {
    buildApi.onResolve({ filter: /^@tarojs\/taro$/ }, () => ({
      path: "taro",
      namespace: "benefit",
    }));
    buildApi.onLoad({ filter: /^taro$/, namespace: "benefit" }, () => ({
      loader: "js",
      contents:
        "export default { downloadFile: async () => { if (globalThis.__benefitDownloadPromise) await globalThis.__benefitDownloadPromise; return { statusCode: 200, tempFilePath: '/tmp/file' }; }, openDocument: async () => { globalThis.__benefitOpened = (globalThis.__benefitOpened || 0) + 1; }, previewImage: async () => { globalThis.__benefitPreviewed = (globalThis.__benefitPreviewed || 0) + 1; } };",
    }));
    buildApi.onResolve({ filter: /^@tarojs\/components$/ }, () => ({
      path: "components",
      namespace: "benefit",
    }));
    buildApi.onLoad({ filter: /.*/, namespace: "benefit" }, () => ({
      loader: "js",
      contents: `import React from 'react'; export const View=({children,...p})=>React.createElement('div',p,children); export const Text=({children,...p})=>React.createElement('span',p,children); export const Button=({children,...p})=>React.createElement('button',p,children); export const Picker=({children,value,onChange,...p})=>React.createElement('div',p,React.createElement('button',{onClick:()=>onChange?.({detail:{value:'2026-10'}})},'切换月份'),children);`,
    }));
  },
};
const panel = async () => {
  if (bundle) return bundle;
  const dir = await mkdtemp(resolve(import.meta.dirname, ".benefit-panel-"));
  const out = resolve(dir, "panel.mjs");
  await build({
    entryPoints: [resolve(rootDir, "src/pages/index/benefit-panel.tsx")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    define: { __API_BASE_URL__: JSON.stringify("http://127.0.0.1:3100") },
    external: ["react", "@teaching-research-alliance/client"],
    plugins: [plugin],
  });
  bundle = { dir, module: await import(`file://${out}?${Date.now()}`) };
  return bundle;
};
const session = (subject = "HEADQUARTERS_FINANCE", extra = {}) => ({
  sessionId: "s1",
  accountId: "a",
  personId: "p",
  currentRoleContext: { subject, scope: "GLOBAL", ...extra },
  roleContexts: [{ subject, scope: "GLOBAL", ...extra }],
});
const roster = {
  benefitMonth: "2026-09-01",
  items: [
    {
      benefitKind: "SOCIAL_INSURANCE",
      beneficiaryPersonId: "person-1",
      beneficiaryDisplayName: "王老师",
      benefitMonth: "2026-09-01",
      planVersions: [
        {
          id: "plan-1",
          version: 1,
          executionDay: 5,
          amountCents: "700",
          sourceFund: {
            id: "fund-1",
            code: "BENEFIT",
            displayName: "总部福利资金",
          },
          active: false,
          reason: "初版",
          changedAt: "2026-09-01T00:00:00Z",
          changedByPersonId: "finance",
        },
        {
          id: "plan-2",
          version: 2,
          executionDay: 6,
          amountCents: "800",
          sourceFund: {
            id: "fund-1",
            code: "BENEFIT",
            displayName: "总部福利资金",
          },
          active: true,
          reason: "社保调整",
          changedAt: "2026-09-02T00:00:00Z",
          changedByPersonId: "finance",
        },
      ],
      currentPlan: {
        id: "plan-2",
        version: 2,
        executionDay: 6,
        amountCents: "800",
        sourceFund: {
          id: "fund-1",
          code: "BENEFIT",
          displayName: "总部福利资金",
        },
        active: true,
        reason: "社保调整",
        changedAt: "2026-09-02T00:00:00Z",
        changedByPersonId: "finance",
      },
      todo: {
        id: "todo-1",
        planVersionId: "plan-1",
        generatedAt: "2026-09-04T00:00:00Z",
      },
      execution: {
        documentId: "doc-1",
        status: "REVERSED",
        version: 1,
        planVersionId: "plan-2",
        sourceFund: {
          id: "fund-1",
          code: "BENEFIT",
          displayName: "总部福利资金",
        },
        amountCents: "800",
        executedByPersonId: "finance",
        executedByDisplayName: "财务人员",
        executedAt: "2026-09-06T17:00:00Z",
        reason: "已办理",
        reversal: {
          documentId: "rev-1",
          reason: "资料更正",
          reversedAt: "2026-09-07T00:00:00Z",
          reversedByPersonId: "admin",
        },
      },
      status: "REVERSED",
    },
  ],
};
const detail = {
  ...roster.items[0].execution,
  ...roster.items[0],
  todo: roster.items[0].todo,
  todoPlan: roster.items[0].planVersions[0],
  executionPlan: {
    ...roster.items[0].planVersions[1],
    sourceFund: {
      id: "fund-2",
      code: "BENEFIT_FROZEN",
      displayName: "冻结福利资金",
    },
  },
  attachments: [
    {
      versionId: "original-pdf",
      purpose: "SUPPORTING_DOCUMENT",
      originalFilename: "原执行.pdf",
      mediaType: "application/pdf",
      sizeBytes: 2,
      sha256: "a",
    },
    {
      versionId: "original-image",
      purpose: "APPLICATION_SCREENSHOT",
      originalFilename: "原执行.png",
      mediaType: "image/png",
      sizeBytes: 2,
      sha256: "b",
    },
  ],
  reversalAttachments: [
    {
      versionId: "reversal-pdf",
      purpose: "SUPPORTING_DOCUMENT",
      originalFilename: "撤销.pdf",
      mediaType: "application/pdf",
      sizeBytes: 2,
      sha256: "c",
    },
  ],
};
const flush = async () =>
  act(async () => {
    await Promise.resolve();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  });
const deferred = () => {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};
const mount = async (element) => {
  const dom = new JSDOM("<div id=a></div>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.querySelector("#a");
  const root = createRoot(host);
  await act(async () => root.render(element));
  await flush();
  return { dom, host, root };
};
test.after(async () => {
  if (bundle) await rm(bundle.dir, { recursive: true, force: true });
});

test("福利读页严格权限、月份切换与迟到 roster 不污染同一 mounted root", async () => {
  const { module } = await panel();
  const pending = new Map();
  const client = {
    hasRoleContext: true,
    currentSession: session(),
    listManagedBenefitRoster: async (month) => {
      const request = deferred();
      pending.set(month, request);
      return request.promise;
    },
    getManagedBenefitDetail: async () => detail,
    logout() {
      this.hasRoleContext = false;
    },
  };
  let view = await mount(
    React.createElement(module.BenefitPanel, {
      client,
      session: session(),
      sessionKey: "one",
    }),
  );
  assert.ok(view.host.textContent.includes("正在读取福利计划"));
  await act(async () =>
    view.host
      .querySelector("button")
      ?.dispatchEvent(new view.dom.window.Event("click", { bubbles: true })),
  );
  assert.ok(pending.has("2026-09-01"));
  assert.ok(pending.has("2026-10-01"));
  await act(async () => pending.get("2026-09-01").resolve(roster));
  assert.equal(view.host.textContent.includes("王老师"), false);
  const october = { ...roster, benefitMonth: "2026-10-01", items: [] };
  await act(async () => pending.get("2026-10-01").resolve(october));
  await flush();
  assert.ok(view.host.textContent.includes("本月暂无有效福利计划"));
  await act(async () =>
    view.root.render(
      React.createElement(module.BenefitPanel, {
        client,
        session: session("TEACHING_TEACHER"),
        sessionKey: "two",
      }),
    ),
  );
  assert.ok(view.host.textContent.includes("没有读取总部福利数据的权限"));
  assert.equal(view.host.textContent.includes("王老师"), false);
  await act(async () => view.root.unmount());
  view.dom.window.close();
});

test("福利详情、双侧附件及 detail/download 迟到响应隔离", async () => {
  const { module } = await panel();
  const detailRequest = deferred();
  const downloadRequest = deferred();
  const client = {
    hasRoleContext: true,
    currentSession: session(),
    listManagedBenefitRoster: async () => roster,
    getManagedBenefitDetail: async () => detailRequest.promise,
    logout() {
      this.hasRoleContext = false;
    },
  };
  const view = await mount(
    React.createElement(module.BenefitPanel, {
      client,
      session: session(),
      sessionKey: "detail",
    }),
  );
  await flush();
  await act(async () =>
    view.host
      .querySelector(".venue-board-fee")
      ?.dispatchEvent(new view.dom.window.Event("click", { bubbles: true })),
  );
  await act(async () =>
    view.root.render(
      React.createElement(module.BenefitPanel, {
        client,
        session: session("SYSTEM_ADMIN"),
        sessionKey: "new-identity",
      }),
    ),
  );
  await act(async () => detailRequest.resolve(detail));
  await flush();
  assert.equal(view.host.textContent.includes("执行详情"), false);
  client.currentSession = session("SYSTEM_ADMIN");
  client.getManagedBenefitDetail = async () => detail;
  await act(async () =>
    view.root.render(
      React.createElement(module.BenefitPanel, {
        client,
        session: session("SYSTEM_ADMIN"),
        sessionKey: "detail-again",
      }),
    ),
  );
  await flush();
  await act(async () =>
    view.host
      .querySelector(".venue-board-fee")
      ?.dispatchEvent(new view.dom.window.Event("click", { bubbles: true })),
  );
  await flush();
  assert.ok(view.host.textContent.includes("不同版本"));
  assert.ok(view.host.textContent.includes("原执行原件"));
  assert.ok(view.host.textContent.includes("撤销原件"));
  assert.ok(view.host.textContent.includes("北京时间"));
  assert.ok(view.host.textContent.includes("欢乐豆"));
  assert.ok(view.host.textContent.includes("2026/09/07 01:00:00"));
  assert.ok(view.host.textContent.includes("冻结福利资金（BENEFIT_FROZEN）"));
  assert.ok(view.host.textContent.includes("撤销办理人编号 admin"));
  assert.ok(view.host.textContent.includes("变更办理人编号 finance"));
  assert.equal(view.host.textContent.includes("元"), false);
  assert.equal(view.host.textContent.includes("余额"), false);
  assert.equal(view.host.textContent.includes("工资"), false);
  let release;
  globalThis.__benefitDownloadPromise = downloadRequest.promise;
  const downloadButton = [...view.host.querySelectorAll("button")].find(
    (button) => button.textContent.includes("原执行.pdf"),
  );
  assert.ok(downloadButton);
  await act(async () =>
    downloadButton.dispatchEvent(
      new view.dom.window.Event("click", { bubbles: true }),
    ),
  );
  await act(async () =>
    view.host
      .querySelector(".venue-board-fee")
      ?.dispatchEvent(new view.dom.window.Event("click", { bubbles: true })),
  );
  await act(async () =>
    view.root.render(
      React.createElement(module.BenefitPanel, {
        client,
        session: session("HEADQUARTERS_FINANCE"),
        sessionKey: "download-new-identity",
      }),
    ),
  );
  client.currentSession = session("HEADQUARTERS_FINANCE");
  await act(async () => downloadRequest.resolve());
  await flush();
  assert.equal(globalThis.__benefitOpened || 0, 0);
  await act(async () => view.root.unmount());
  view.dom.window.close();
  delete globalThis.__benefitDownloadPromise;
});

test("福利读页真实 ApiClientError 401/403 清空数据并通知父界面", async () => {
  const { module } = await panel();
  for (const status of [401, 403]) {
    const invalidated = [];
    const client = {
      hasRoleContext: true,
      currentSession: session(),
      listManagedBenefitRoster: async () => {
        throw new ApiClientError(
          status,
          status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN_SCOPE",
        );
      },
      getManagedBenefitDetail: async () => detail,
      logout() {
        this.currentSession = null;
        this.hasRoleContext = false;
      },
    };
    const view = await mount(
      React.createElement(module.BenefitPanel, {
        client,
        session: session(),
        sessionKey: `error-${status}`,
        onInvalidated: () => invalidated.push(true),
      }),
    );
    await flush();
    assert.equal(invalidated.length, 1);
    assert.ok(view.host.textContent.includes("身份已失效"));
    assert.equal(view.host.textContent.includes("王老师"), false);
    await act(async () => view.root.unmount());
    view.dom.window.close();
  }
});

test("同月切换不同 execution 时，A 附件迟到不能打开并污染 B 详情", async () => {
  const { module } = await panel();
  const itemB = {
    ...roster.items[0],
    beneficiaryPersonId: "person-2",
    beneficiaryDisplayName: "李老师",
    execution: {
      ...roster.items[0].execution,
      documentId: "doc-b",
      executedByDisplayName: "另一位财务",
    },
  };
  const rosterAB = { ...roster, items: [roster.items[0], itemB] };
  const detailB = {
    ...detail,
    beneficiaryPersonId: "person-2",
    beneficiaryDisplayName: "李老师",
    documentId: "doc-b",
    execution: undefined,
  };
  const downloadRequest = deferred();
  const client = {
    hasRoleContext: true,
    currentSession: session(),
    listManagedBenefitRoster: async () => rosterAB,
    getManagedBenefitDetail: async (documentId) =>
      documentId === "doc-b" ? detailB : detail,
    logout() {
      this.hasRoleContext = false;
    },
  };
  globalThis.__benefitOpened = 0;
  globalThis.__benefitPreviewed = 0;
  globalThis.__benefitDownloadPromise = downloadRequest.promise;
  const view = await mount(
    React.createElement(module.BenefitPanel, {
      client,
      session: session(),
      sessionKey: "same-month",
    }),
  );
  const entries = [...view.host.querySelectorAll(".venue-board-fee")];
  assert.equal(entries.length, 2);
  await act(async () =>
    entries[0].dispatchEvent(
      new view.dom.window.Event("click", { bubbles: true }),
    ),
  );
  await flush();
  assert.ok(view.host.textContent.includes("王老师 · 执行详情"));
  const attachment = [...view.host.querySelectorAll("button")].find((button) =>
    button.textContent.includes("原执行.pdf"),
  );
  assert.ok(attachment);
  await act(async () =>
    attachment.dispatchEvent(
      new view.dom.window.Event("click", { bubbles: true }),
    ),
  );
  await act(async () =>
    entries[1].dispatchEvent(
      new view.dom.window.Event("click", { bubbles: true }),
    ),
  );
  await flush();
  assert.ok(view.host.textContent.includes("李老师 · 执行详情"));
  await act(async () => downloadRequest.resolve());
  await flush();
  assert.equal(globalThis.__benefitOpened, 0);
  assert.equal(globalThis.__benefitPreviewed, 0);
  assert.ok(view.host.textContent.includes("李老师 · 执行详情"));
  await act(async () => view.root.unmount());
  view.dom.window.close();
  delete globalThis.__benefitDownloadPromise;
});

test("附件成功下载后按类型打开 PDF 与图片，且不触发父条目详情重载", async () => {
  const { module } = await panel();
  const client = {
    hasRoleContext: true,
    currentSession: session(),
    listManagedBenefitRoster: async () => roster,
    getManagedBenefitDetail: async () => detail,
    logout() {
      this.hasRoleContext = false;
    },
  };
  globalThis.__benefitOpened = 0;
  globalThis.__benefitPreviewed = 0;
  delete globalThis.__benefitDownloadPromise;
  const view = await mount(
    React.createElement(module.BenefitPanel, {
      client,
      session: session(),
      sessionKey: "attachment-success",
    }),
  );
  await act(async () =>
    view.host
      .querySelector(".venue-board-fee")
      ?.dispatchEvent(new view.dom.window.Event("click", { bubbles: true })),
  );
  await flush();
  const pdf = [...view.host.querySelectorAll("button")].find((button) =>
    button.textContent.includes("原执行.pdf"),
  );
  const image = [...view.host.querySelectorAll("button")].find((button) =>
    button.textContent.includes("原执行.png"),
  );
  assert.ok(pdf);
  assert.ok(image);
  await act(async () =>
    pdf.dispatchEvent(new view.dom.window.Event("click", { bubbles: true })),
  );
  await flush();
  assert.equal(globalThis.__benefitOpened, 1);
  assert.ok(view.host.textContent.includes("王老师 · 执行详情"));
  await act(async () =>
    image.dispatchEvent(new view.dom.window.Event("click", { bubbles: true })),
  );
  await flush();
  assert.equal(globalThis.__benefitPreviewed, 1);
  assert.ok(view.host.textContent.includes("王老师 · 执行详情"));
  await act(async () => view.root.unmount());
  view.dom.window.close();
});
