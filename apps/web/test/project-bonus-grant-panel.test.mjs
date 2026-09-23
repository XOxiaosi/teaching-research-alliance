import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { ApiClientError } from "@teaching-research-alliance/client";

const session = (subject = "HEADQUARTERS_FINANCE", scope = "GLOBAL") => ({ sessionId: `session-${subject}`, accountId: "account-a", personId: "operator-a", currentRoleContext: { subject, scope }, roleContexts: [] });
const catalog = (name = "秋季激励", version = 1) => ({ projects: [{ projectNo: 10, nameVersionId: `project-name-${version}`, nameVersion: version, displayName: name }] });
const recipients = { items: [{ id: "person-a", nickname: "王老师" }, { id: "person-b", nickname: "李老师" }] };
const funds = { items: [{ fundId: "fund-a", code: "HQ", displayName: "总部业务账户" }] };
const refreshedFunds = { items: [{ fundId: "fund-b", code: "HQ-NEW", displayName: "更新后的总部业务账户" }] };
const attachments = { documentId: "document-a", attachments: [
  { attachmentId: "attachment-supporting", purpose: "SUPPORTING_DOCUMENT", versions: [{ versionId: "supporting-ready", status: "READY" }] },
  { attachmentId: "attachment-screenshot", purpose: "APPLICATION_SCREENSHOT", versions: [{ versionId: "screenshot-ready", status: "READY" }] },
] };
const deferred = () => { let resolvePromise; let rejectPromise; const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; }); return { promise, resolve: resolvePromise, reject: rejectPromise }; };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const reactProps = (element) => element[Object.keys(element).find((key) => key.startsWith("__reactProps$"))];

let Panel;
let tempDir;

before(async () => {
  tempDir = await mkdtemp(resolve(import.meta.dirname, ".project-bonus-grant-test-"));
  const output = resolve(tempDir, "panel.mjs");
  const plugin = {
    name: "finance-shared-test-double",
    setup(api) {
      api.onResolve({ filter: /finance-shared\.js$/ }, () => ({ path: "finance-shared-test-double", namespace: "finance-test" }));
      api.onLoad({ filter: /.*/, namespace: "finance-test" }, () => ({ loader: "js", contents: `
        import React from "react";
        const pendingRetryAttempts = {};
        export const financeError = error => error instanceof Error ? error.message : "error";
        export const AttachmentPicker = ({ purpose, label, disabled, onReady, onPendingChange, run }) => React.createElement("div", { "data-purpose": purpose },
          React.createElement("span", null, label),
          React.createElement("button", { type: "button", disabled, "data-ready": purpose, onClick: () => onReady(purpose === "SUPPORTING_DOCUMENT" ? "supporting-ready" : "screenshot-ready") }, "选用 READY 原件"),
          React.createElement("button", { type: "button", disabled, "data-pending": purpose, onClick: () => onPendingChange(true) }, "开始上传"),
          React.createElement("button", { type: "button", disabled, "data-pending-end": purpose, onClick: () => onPendingChange(false) }, "结束上传"),
          React.createElement("button", { type: "button", disabled, "data-upload-hold": purpose, onClick: async () => { await run(() => new Promise(resolve => setTimeout(resolve, 25))); } }, "上传进行中"),
          React.createElement("button", { type: "button", disabled, "data-upload-fail": purpose, onClick: async () => { pendingRetryAttempts[purpose] = (pendingRetryAttempts[purpose] ?? 0) + 1; onPendingChange(true); try { await run(async () => { if (pendingRetryAttempts[purpose] === 1) throw new Error("upload failed"); }); onReady(purpose === "SUPPORTING_DOCUMENT" ? "supporting-ready" : "screenshot-ready"); onPendingChange(false); } catch (_) {} } }, "上传失败")
        );
      ` }));
    },
  };
  await build({ entryPoints: [resolve(import.meta.dirname, "../src/project-bonus-grant-panel.tsx")], bundle: true, format: "esm", platform: "node", outfile: output, external: ["react", "@teaching-research-alliance/client"], plugins: [plugin] });
  Panel = (await import(`file://${output}?${Date.now()}`)).ProjectBonusGrantPanel;
});
after(async () => { await rm(tempDir, { recursive: true, force: true }); });

async function mount(overrides = {}) {
  const dom = new JSDOM("<div id=host></div>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const host = dom.window.document.querySelector("#host");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  const events = { documents: [], grants: [], saved: 0, invalidated: 0, pending: [] };
  const client = {
    hasRoleContext: true,
    listBonusProjects: async () => catalog(),
    listManagedCashWageTeachers: async () => recipients,
    listBenefitSourceFunds: async () => funds,
    createSalaryBenefitDocumentSubmission: () => ({ draft: { kind: "PROJECT_BONUS" }, idempotencyKey: `document-key-${events.documents.length}` }),
    createSalaryBenefitDocument: async (submission) => { events.documents.push(submission); return { id: "document-a", kind: "PROJECT_BONUS", version: 7 }; },
    listFinanceDocumentAttachments: async () => attachments,
    createBonusGrantSubmission: (draft) => ({ draft, idempotencyKey: `grant-key-${events.grants.length}` }),
    grantProjectBonus: async (submission) => { events.grants.push(submission); return { status: "COMPLETED" }; },
    ...overrides,
  };
  let currentSession = session();
  let currentKey = "key-a";
  let currentBusy = false;
  const render = async (next = {}) => {
    if (next.session !== undefined) currentSession = next.session;
    if (next.sessionKey !== undefined) currentKey = next.sessionKey;
    if (next.busy !== undefined) currentBusy = next.busy;
    await act(async () => { root.render(React.createElement(Panel, { client, session: currentSession, sessionKey: currentKey, busy: currentBusy, onSaved: () => { events.saved += 1; }, onInvalidated: () => { events.invalidated += 1; }, onUnconfirmedChange: (pending) => { events.pending.push(pending); } })); await tick(); });
  };
  await render();
  const click = async (element) => { assert.ok(element); await act(async () => { reactProps(element).onClick({ preventDefault() {} }); await tick(); }); };
  const set = async (element, value) => { assert.ok(element); await act(async () => { reactProps(element).onChange({ target: { value } }); await tick(); }); };
  const label = (name) => host.querySelector(`[aria-label="${name}"]`);
  const button = (text) => [...host.querySelectorAll("button")].find((element) => element.textContent === text);
  const fill = async (recipientId = "person-a") => {
    await set(label("项目"), "10");
    await set(label("收款成员"), recipientId);
    await set(label("支出账户"), "fund-a");
    await set(label("奖金金额"), "9007199254740993.01");
    await set(label("发放理由"), "完成秋季项目目标");
  };
  const createReady = async () => {
    await click(button("创建奖金凭证"));
    await click(host.querySelector('[data-ready="SUPPORTING_DOCUMENT"]'));
    await click(host.querySelector('[data-ready="APPLICATION_SCREENSHOT"]'));
  };
  return { dom, root, host, client, events, render, click, set, label, button, fill, createReady, close: async () => { await act(async () => root.unmount()); dom.window.close(); } };
}

test("严格 GLOBAL 财务可从三目录创建项目奖金凭证并精确保留分", async () => {
  const view = await mount();
  try {
    await view.fill();
    await view.click(view.button("创建奖金凭证"));
    assert.equal(view.events.documents.length, 1);
    assert.equal(view.button("确认发放").disabled, true);
    await view.click(view.host.querySelector('[data-ready="SUPPORTING_DOCUMENT"]'));
    assert.equal(view.button("确认发放").disabled, true);
    await view.click(view.host.querySelector('[data-ready="APPLICATION_SCREENSHOT"]'));
    assert.equal(view.button("确认发放").disabled, false);
    await view.click(view.button("确认发放"));
    assert.equal(view.events.grants.length, 1);
    assert.equal(view.events.grants[0].draft.amountCents, "900719925474099301");
    assert.equal(view.events.grants[0].draft.projectName, "秋季激励");
    assert.equal(view.events.grants[0].draft.projectNameVersionId, "project-name-1");
    assert.deepEqual(view.events.grants[0].draft.attachmentVersionIds, ["supporting-ready", "screenshot-ready"]);
    assert.equal(view.events.saved, 1);
    assert.equal(view.host.textContent.includes("project-name-1"), false);
  } finally { await view.close(); }
});

test("奖金金额必须大于零，创建与发放按钮均不会把零金额送到服务端", async () => {
  const view = await mount();
  try {
    await view.fill();
    await view.set(view.label("奖金金额"), "0.00");
    assert.equal(view.button("创建奖金凭证").disabled, true);
    await view.click(view.button("创建奖金凭证"));
    assert.equal(view.events.documents.length, 0);
    await view.set(view.label("奖金金额"), "0.01");
    assert.equal(view.button("创建奖金凭证").disabled, false);
    await view.createReady();
    await view.set(view.label("奖金金额"), "0");
    assert.equal(view.button("确认发放").disabled, true);
    await view.click(view.button("确认发放"));
    assert.equal(view.events.grants.length, 0);
  } finally { await view.close(); }
});

test("非严格 GLOBAL 身份不读取奖金目录或渲染表单", async () => {
  let reads = 0;
  const view = await mount({ listBonusProjects: async () => { reads += 1; return catalog(); } });
  try {
    await view.render({ session: session("SYSTEM_ADMIN", "REGION"), sessionKey: "regional" });
    assert.equal(reads, 1);
    assert.match(view.host.textContent, /没有查看总部项目奖金/);
    assert.equal(view.host.querySelectorAll("input, select, textarea, button").length, 0);
  } finally { await view.close(); }
});

test("未知发放锁定并复用同一 immutable submission", async () => {
  let first = true;
  const view = await mount({ grantProjectBonus: async (submission) => { view.events.grants.push(submission); if (first) { first = false; throw new Error("timeout"); } return { status: "COMPLETED" }; } });
  try {
    await view.fill();
    await view.createReady();
    await view.click(view.button("确认发放"));
    assert.equal(view.events.pending.includes(true), true);
    assert.equal(view.button("安全重试原发放").disabled, false);
    assert.equal(view.host.querySelector("fieldset").disabled, true);
    await view.click(view.button("安全重试原发放"));
    assert.equal(view.events.grants.length, 2);
    assert.equal(view.events.grants[0], view.events.grants[1]);
  } finally { await view.close(); }
});

test("未知创建奖金凭证复用原 submission，附件旧会话回调不会污染新会话", async () => {
  let first = true;
  const view = await mount({ createSalaryBenefitDocument: async (submission) => { view.events.documents.push(submission); if (first) { first = false; throw new Error("timeout"); } return { id: "document-a", kind: "PROJECT_BONUS", version: 7 }; } });
  try {
    await view.fill();
    await view.click(view.button("创建奖金凭证"));
    assert.equal(view.events.pending.includes(true), true);
    assert.ok(view.button("安全重试创建凭证"));
    await view.click(view.button("安全重试创建凭证"));
    assert.equal(view.events.documents.length, 2);
    assert.equal(view.events.documents[0], view.events.documents[1]);
    const oldReady = reactProps(view.host.querySelector('[data-ready="SUPPORTING_DOCUMENT"]')).onClick;
    await view.render({ session: session("SYSTEM_OWNER"), sessionKey: "owner-session" });
    await act(async () => { oldReady({ preventDefault() {} }); await tick(); });
    assert.equal(view.host.querySelectorAll("[data-purpose]").length, 0);
    assert.equal(view.button("确认发放"), undefined);
  } finally { await view.close(); }
});

test("目录过期会刷新、清空项目并要求重新选择，保留凭证和 READY 原件", async () => {
  let reads = 0;
  const view = await mount({ listBonusProjects: async () => { reads += 1; return catalog(reads === 1 ? "秋季激励" : "更新后的秋季激励", reads === 1 ? 1 : 2); }, grantProjectBonus: async (submission) => { view.events.grants.push(submission); if (view.events.grants.length === 1) throw new ApiClientError(409, "BONUS_PROJECT_VERSION_CONFLICT"); return { status: "COMPLETED" }; } });
  try {
    await view.fill();
    await view.createReady();
    await view.click(view.button("确认发放"));
    await tick();
    assert.equal(view.label("项目").value, "");
    assert.match(view.host.textContent, /重新选择项目/);
    assert.equal(view.events.documents.length, 1);
    assert.equal(view.host.querySelectorAll("[data-purpose]").length, 2);
    await view.set(view.label("项目"), "10");
    await view.click(view.button("确认发放"));
    assert.equal(view.events.grants.length, 2);
    assert.notEqual(view.events.grants[0].idempotencyKey, view.events.grants[1].idempotencyKey);
    assert.equal(view.events.grants[1].draft.projectNameVersionId, "project-name-2");
  } finally { await view.close(); }
});

test("项目目录冲突后的刷新失败保持锁定，必须成功重读后才能重新选择", async () => {
  let reads = 0;
  const view = await mount({ listBonusProjects: async () => {
    reads += 1;
    if (reads === 2) throw new Error("directory unavailable");
    return catalog(reads === 3 ? "最新秋季激励" : "秋季激励", reads === 3 ? 2 : 1);
  }, grantProjectBonus: async (submission) => { view.events.grants.push(submission); throw new ApiClientError(409, "BONUS_PROJECT_VERSION_CONFLICT"); } });
  try {
    await view.fill();
    await view.createReady();
    await view.click(view.button("确认发放"));
    await tick();
    assert.match(view.host.textContent, /无法核对最新项目目录/);
    assert.equal(view.host.querySelector("fieldset").disabled, true);
    assert.equal(view.button("确认发放").disabled, true);
    assert.equal(view.events.pending.includes(true), true);
    await view.set(view.label("项目"), "10");
    assert.equal(view.label("项目").value, "10");
    await view.click(view.button("重试读取最新项目"));
    await tick();
    assert.equal(view.label("项目").value, "");
    assert.match(view.host.textContent, /重新选择项目/);
  } finally { await view.close(); }
});

test("来源业务账户失效后重读目录、清空选择并要求重新选择，保留凭证和 READY 原件", async () => {
  let fundReads = 0;
  const view = await mount({
    listBenefitSourceFunds: async () => {
      fundReads += 1;
      return fundReads === 1 ? funds : refreshedFunds;
    },
    grantProjectBonus: async (submission) => {
      view.events.grants.push(submission);
      if (view.events.grants.length === 1) throw new ApiClientError(409, "COMPANY_FUND_INACTIVE");
      return { status: "COMPLETED" };
    },
  });
  try {
    await view.fill();
    await view.createReady();
    await view.click(view.button("确认发放"));
    await tick();
    assert.equal(view.label("支出账户").value, "");
    assert.match(view.host.textContent, /重新选择支出账户/);
    assert.equal(view.events.documents.length, 1);
    assert.equal(view.host.querySelectorAll("[data-purpose]").length, 2);
    assert.equal(view.button("确认发放").disabled, true);
    await view.set(view.label("支出账户"), "fund-b");
    assert.equal(view.button("确认发放").disabled, false);
    await view.click(view.button("确认发放"));
    assert.equal(view.events.grants.length, 2);
    assert.notEqual(view.events.grants[0].idempotencyKey, view.events.grants[1].idempotencyKey);
    assert.equal(view.events.grants[1].draft.sourceFundId, "fund-b");
  } finally { await view.close(); }
});

test("来源业务账户目录重读失败保持锁定，只有成功重读后才能重新选择", async () => {
  let fundReads = 0;
  const view = await mount({
    listBenefitSourceFunds: async () => {
      fundReads += 1;
      if (fundReads === 2) throw new Error("fund directory unavailable");
      return fundReads === 3 ? refreshedFunds : funds;
    },
    grantProjectBonus: async (submission) => {
      view.events.grants.push(submission);
      throw new ApiClientError(409, "COMPANY_FUND_ASSIGNMENT_NOT_FOUND");
    },
  });
  try {
    await view.fill();
    await view.createReady();
    await view.click(view.button("确认发放"));
    await tick();
    assert.match(view.host.textContent, /无法核对最新来源业务账户/);
    assert.equal(view.host.querySelector("fieldset").disabled, true);
    assert.equal(view.button("确认发放").disabled, true);
    assert.equal(view.events.pending.includes(true), true);
    await view.click(view.button("重试读取支出账户"));
    await tick();
    assert.equal(view.label("支出账户").value, "");
    assert.match(view.host.textContent, /重新选择支出账户/);
    assert.equal(view.host.querySelector("fieldset").disabled, false);
  } finally { await view.close(); }
});

test("凭证版本或状态冲突不猜测新版本、不重读项目，并解除导航锁", async () => {
  let projectReads = 0;
  const view = await mount({ listBonusProjects: async () => { projectReads += 1; return catalog(); }, grantProjectBonus: async (submission) => { view.events.grants.push(submission); throw new ApiClientError(409, "VERSION_CONFLICT"); } });
  try {
    await view.fill();
    await view.createReady();
    await view.click(view.button("确认发放"));
    assert.equal(projectReads, 1);
    assert.equal(view.label("项目").value, "10");
    assert.match(view.host.textContent, /凭证状态已变化/);
    assert.equal(view.button("确认发放").disabled, true);
    assert.equal(view.host.querySelectorAll("[data-purpose]").length, 2);
    assert.equal(view.events.pending.at(-1), false);
  } finally { await view.close(); }
});

test("确定性收款成员不可用释放命令并保留凭证和附件以便更正", async () => {
  const view = await mount({ grantProjectBonus: async (submission) => { view.events.grants.push(submission); throw new ApiClientError(404, "PERSONAL_ACCOUNT_NOT_FOUND"); } });
  try {
    await view.fill();
    await view.createReady();
    await view.click(view.button("确认发放"));
    assert.match(view.host.textContent, /收款成员当前不可用/);
    assert.equal(view.button("确认发放").disabled, false);
    assert.equal(view.host.querySelectorAll("[data-purpose]").length, 2);
    await view.set(view.label("收款成员"), "person-b");
    await view.click(view.button("确认发放"));
    assert.equal(view.events.grants.length, 2);
    assert.notEqual(view.events.grants[0].idempotencyKey, view.events.grants[1].idempotencyKey);
  } finally { await view.close(); }
});

test("外部目录写入锁会禁用发放命令，单一上传 pending 也锁定另一用途", async () => {
  const view = await mount();
  try {
    await view.fill();
    await view.render({ busy: true });
    assert.equal(view.button("创建奖金凭证").disabled, true);
    await view.render({ busy: false });
    await view.click(view.button("创建奖金凭证"));
    const pending = view.host.querySelector('[data-pending="SUPPORTING_DOCUMENT"]');
    const other = view.host.querySelector('[data-pending="APPLICATION_SCREENSHOT"]');
    await view.click(pending);
    assert.equal(pending.disabled, false);
    assert.equal(other.disabled, true);
    assert.equal(view.host.querySelector("fieldset").disabled, true);
    await view.click(view.host.querySelector('[data-pending-end="SUPPORTING_DOCUMENT"]'));
    assert.equal(other.disabled, false);
    await view.click(view.host.querySelector('[data-upload-hold="SUPPORTING_DOCUMENT"]'));
    assert.equal(view.host.querySelector('[data-ready="SUPPORTING_DOCUMENT"]').disabled, true);
    assert.equal(view.host.querySelector('[data-ready="APPLICATION_SCREENSHOT"]').disabled, true);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    assert.equal(view.host.querySelector('[data-ready="SUPPORTING_DOCUMENT"]').disabled, false);
    assert.equal(view.host.querySelector('[data-ready="APPLICATION_SCREENSHOT"]').disabled, false);
  } finally { await view.close(); }
});

test("上传网络失败结束后仅原待补用途可实际重试，重试成功才解除 pending", async () => {
  const view = await mount();
  try {
    await view.fill();
    await view.click(view.button("创建奖金凭证"));
    const failedPurpose = view.host.querySelector('[data-upload-fail="SUPPORTING_DOCUMENT"]');
    const otherPurpose = view.host.querySelector('[data-upload-fail="APPLICATION_SCREENSHOT"]');
    await view.click(failedPurpose);
    assert.match(view.host.textContent, /upload failed/);
    assert.equal(failedPurpose.disabled, false);
    assert.equal(otherPurpose.disabled, true);
    assert.equal(view.host.querySelector("fieldset").disabled, true);
    await view.click(failedPurpose);
    assert.equal(failedPurpose.disabled, false);
    assert.equal(otherPurpose.disabled, false);
    assert.equal(view.host.querySelector("fieldset").disabled, false);
  } finally { await view.close(); }
});

test("401/403 与身份切换后迟到响应不会保留旧凭证或回调成功", async () => {
  for (const status of [401, 403]) {
    const denied = await mount({ listBonusProjects: async () => { throw new ApiClientError(status, "FORBIDDEN_SCOPE"); } });
    try { await tick(); assert.equal(denied.events.invalidated, 1); } finally { await denied.close(); }
  }
  const pending = deferred();
  const view = await mount({ grantProjectBonus: () => pending.promise });
  try {
    await view.fill();
    await view.createReady();
    await view.click(view.button("确认发放"));
    assert.equal(view.button("确认发放").disabled, true);
    await view.render({ session: session("SYSTEM_OWNER"), sessionKey: "owner-session" });
    await act(async () => { pending.resolve({ status: "COMPLETED" }); await tick(); });
    assert.equal(view.events.saved, 0);
    assert.equal(view.events.invalidated, 0);
    assert.equal(view.host.textContent.includes("项目奖金已发放"), false);
  } finally { await view.close(); }
});
