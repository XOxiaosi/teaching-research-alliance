import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { ApiClientError } from "@teaching-research-alliance/client";

const roster = { salaryMonth: "2026-09-01", items: [{ teacherPersonId: "teacher-a", teacherDisplayName: "王老师", plan: { id: "plan-1", sourceMonth: "2026-09-01", version: 1, plannedCashCents: "1000", plannedDeductionCents: "1000", active: true, appliesToFutureMonths: false, reason: "", changedAt: "", changedByPersonId: "" }, todo: { id: "todo-1", generatedAt: "", planVersionId: "plan-1" }, confirmedCashCents: "0", confirmedDeductionCents: "0", remainingCashCents: "1000", remainingDeductionCents: "1000", overageCashCents: "0", overageDeductionCents: "0", status: "PENDING" }] };
const session = { sessionId: "s", accountId: "a", personId: "p", currentRoleContext: { subject: "HEADQUARTERS_FINANCE", scope: "GLOBAL" }, roleContexts: [] };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const props = element => element[Object.keys(element).find(key => key.startsWith("__reactProps\$"))];
const apiError = status => new ApiClientError(status, status === 409 ? "STATE_CONFLICT" : status === 403 ? "FORBIDDEN_SCOPE" : "INVALID_INPUT");

let Panel;
let tempDir;

before(async () => {
  tempDir = await mkdtemp(resolve(import.meta.dirname, ".wage-confirm-test-"));
  const output = resolve(tempDir, "panel.mjs");
  const plugin = { name: "finance-shared-test-double", setup(api) {
    api.onResolve({ filter: /finance-shared\.js$/ }, () => ({ path: "finance-shared-test-double", namespace: "finance-test" }));
    api.onLoad({ filter: /.*/, namespace: "finance-test" }, () => ({ loader: "js", contents: `
      import React from "react";
      export const financeError = error => error instanceof Error ? error.message : "error";
      export const isFinanceAuthError = error => error && (error.status === 401 || error.status === 403);
      export const AttachmentPicker = ({ purpose, label, disabled, onReady, onPendingChange, run }) => React.createElement("div", { "data-purpose": purpose },
        React.createElement("span", null, label),
        React.createElement("button", { type: "button", "data-upload-start": purpose, disabled, onClick: () => onPendingChange(true) }, "开始上传"),
        React.createElement("button", { type: "button", "data-upload-fail": purpose, disabled, onClick: async () => { onPendingChange(true); try { await run(async () => { throw new Error("upload failed"); }); } catch (_) {} finally { onPendingChange(false); } } }, "上传失败"),
        React.createElement("button", { type: "button", "data-ready": purpose, disabled, onClick: () => onReady(purpose === "SUPPORTING_DOCUMENT" ? "supporting-v2" : "screenshot-v4") }, "选用 READY 原件"),
        React.createElement("button", { type: "button", "data-upload-retry": purpose, disabled, onClick: () => onPendingChange(true) }, "重试上传"),
        React.createElement("button", { type: "button", "data-upload-end": purpose, disabled, onClick: () => onPendingChange(false) }, "上传完成"));
    ` }));
  }};
  await build({ entryPoints: [resolve(import.meta.dirname, "../src/cash-wage-confirmation-panel.tsx")], bundle: true, format: "esm", platform: "node", outfile: output, external: ["react", "@teaching-research-alliance/client"], plugins: [plugin] });
  Panel = (await import(`file://${output}?${Date.now()}`)).CashWageConfirmationPanel;
});
after(async () => { await rm(tempDir, { recursive: true, force: true }); });

async function mount(overrides = {}) {
  const dom = new JSDOM("<div id=host></div>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const host = dom.window.document.querySelector("#host");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  const events = { createDocuments: [], confirms: [], saved: 0, invalidated: 0, locks: [] };
  const attachments = { documentId: "document-1", attachments: [{ attachmentId: "attachment-supporting", purpose: "SUPPORTING_DOCUMENT", versions: [{ versionId: "supporting-v2", versionNo: 2, status: "READY", originalFilename: "supporting.pdf", mediaType: "application/pdf", sizeBytes: 1, sha256: "" }] }, { attachmentId: "attachment-screenshot", purpose: "APPLICATION_SCREENSHOT", versions: [{ versionId: "screenshot-v4", versionNo: 4, status: "READY", originalFilename: "screenshot.png", mediaType: "image/png", sizeBytes: 1, sha256: "" }] }] };
  const client = { hasRoleContext: true, listManagedCashWageRoster: async () => roster, createSalaryBenefitDocumentSubmission: () => ({ draft: { kind: "CASH_WAGE" }, idempotencyKey: `doc-${events.createDocuments.length}` }), createSalaryBenefitDocument: async submission => { events.createDocuments.push(submission); return { id: "document-1", kind: "CASH_WAGE", version: 1 }; }, listFinanceDocumentAttachments: async () => attachments, createCashWageConfirmationSubmission: draft => ({ draft, idempotencyKey: `confirm-${events.confirms.length}` }), confirmCashWage: async submission => { events.confirms.push(submission); return { status: "COMPLETED" }; }, ...overrides };
  const render = async sessionKey => { await act(async () => { root.render(React.createElement(Panel, { client, session, sessionKey, onSaved: () => { events.saved++; }, onInvalidated: () => { events.invalidated++; }, onUnconfirmedChange: locked => { events.locks.push(locked); } })); await tick(); }); };
  await render("session-1");
  const input = async (element, value) => { assert.ok(element); await act(async () => { props(element).onChange({ target: { value } }); await tick(); }); };
  const click = async element => { assert.ok(element); await act(async () => { props(element).onClick({ preventDefault() {} }); await tick(); }); };
  const button = text => [...host.querySelectorAll("button")].find(element => element.textContent === text);
  const fill = async (amount = "10") => { await input(host.querySelector("select"), "teacher-a"); const fields = [...host.querySelectorAll("input")].filter(element => !["month", "checkbox"].includes(element.type)); await input(fields[0], amount); await input(fields[1], amount); await input(host.querySelector("textarea"), "现金已按计划发放"); };
  const createReady = async () => { await click(button("创建工资确认凭证")); await click(host.querySelector('[data-ready="SUPPORTING_DOCUMENT"]')); await click(host.querySelector('[data-ready="APPLICATION_SCREENSHOT"]')); };
  return { dom, root, host, client, events, render, input, click, button, fill, createReady, close: async () => { await act(async () => root.unmount()); dom.window.close(); } };
}

test("创建凭证未知结果锁定并用同一 submission 重试", async () => {
  let first = true; const view = await mount({ createSalaryBenefitDocument: async submission => { view.events.createDocuments.push(submission); if (first) { first = false; throw new Error("network"); } return { id: "document-1", version: 1 }; } });
  try { await view.fill(); await view.click(view.button("创建工资确认凭证")); assert.equal(view.events.createDocuments.length, 1); assert.equal(view.events.locks.at(-1), true); assert.ok([...view.host.querySelectorAll("input,select,textarea")].every(element => element.disabled)); await view.click(view.button("安全重试创建凭证")); assert.equal(view.events.createDocuments.length, 2); assert.equal(view.events.createDocuments[0], view.events.createDocuments[1]); } finally { await view.close(); }
});

test("上传在途锁定父级，失败后释放并可选择两个用途 READY 原件", async () => {
  const view = await mount();
  try { await view.fill(); await view.click(view.button("创建工资确认凭证")); await view.click(view.host.querySelector('[data-upload-start="SUPPORTING_DOCUMENT"]')); assert.equal(view.events.locks.at(-1), true); await view.click(view.host.querySelector('[data-upload-end="SUPPORTING_DOCUMENT"]')); await view.click(view.host.querySelector('[data-upload-fail="APPLICATION_SCREENSHOT"]')); assert.equal(view.events.locks.at(-1), false); await view.click(view.host.querySelector('[data-ready="SUPPORTING_DOCUMENT"]')); await view.click(view.host.querySelector('[data-ready="APPLICATION_SCREENSHOT"]')); assert.ok(view.host.querySelector('[data-purpose="SUPPORTING_DOCUMENT"]')); assert.ok(view.host.querySelector('[data-purpose="APPLICATION_SCREENSHOT"]')); } finally { await view.close(); }
});

test("确认未知结果锁定并复用同一确认 submission，成功刷新 roster 一次", async () => {
  let first = true; let rosterReads = 0; const view = await mount({ listManagedCashWageRoster: async () => { rosterReads++; return roster; }, confirmCashWage: async submission => { view.events.confirms.push(submission); if (first) { first = false; throw new Error("network"); } return { status: "COMPLETED" }; } });
  try { await view.fill(); await view.createReady(); await act(async () => { props(view.host.querySelector('input[type="checkbox"]')).onChange({ target: { checked: true } }); await tick(); }); await view.click(view.button("确认现金已发放并记录扣豆")); assert.equal(view.events.confirms.length, 1); assert.equal(view.events.locks.at(-1), true); await view.click(view.button("安全重试原确认")); assert.equal(view.events.confirms.length, 2); assert.equal(view.events.confirms[0], view.events.confirms[1]); assert.equal(view.events.saved, 1); assert.equal(rosterReads, 2); } finally { await view.close(); }
});

test("确认确定性 400 可编辑，409 锁定并要求重新读取核对", async () => {
  for (const status of [400, 409]) { const view = await mount({ confirmCashWage: async submission => { view.events.confirms.push(submission); throw apiError(status); } }); try { await view.fill(); await view.createReady(); await act(async () => { props(view.host.querySelector('input[type="checkbox"]')).onChange({ target: { checked: true } }); await tick(); }); await view.click(view.button("确认现金已发放并记录扣豆")); assert.equal(view.events.confirms.length, 1); assert.equal(view.events.saved, 0); assert.ok(view.host.textContent.includes(status === 409 ? "重新读取并核对" : "INVALID_INPUT")); if (status === 409) { assert.equal(view.events.locks.at(-1), true); await view.click(view.button("重新读取并核对")); assert.equal(view.events.locks.at(-1), false); } else assert.equal(view.events.locks.at(-1), false); } finally { await view.close(); } }
});

test("401/403 目录和写入都会通知父级失效", async () => {
  for (const status of [401, 403]) { const denied = async () => { throw apiError(status); }; const view = await mount({ listManagedCashWageRoster: denied }); try { await tick(); assert.equal(view.events.invalidated, 1); } finally { await view.close(); } const write = await mount({ createSalaryBenefitDocument: denied }); try { await write.fill(); await write.click(write.button("创建工资确认凭证")); assert.equal(write.events.invalidated, 1); } finally { await write.close(); } }
});


test("单用途 pending 保持本用途重试可用、锁定另一用途与表单，结束后全部解锁", async () => {
  const view = await mount();
  try {
    await view.fill(); await view.click(view.button("创建工资确认凭证"));
    const supportingStart = view.host.querySelector('[data-upload-start="SUPPORTING_DOCUMENT"]');
    const supportingRetry = view.host.querySelector('[data-upload-retry="SUPPORTING_DOCUMENT"]');
    const screenshotStart = view.host.querySelector('[data-upload-start="APPLICATION_SCREENSHOT"]');
    await view.click(supportingStart);
    assert.equal(supportingRetry.disabled, false);
    assert.equal(screenshotStart.disabled, true);
    assert.equal(view.host.querySelector('input[type="month"]').disabled, true);
    assert.equal(view.events.locks.at(-1), true);
    await view.click(view.host.querySelector('[data-upload-end="SUPPORTING_DOCUMENT"]'));
    assert.equal(supportingRetry.disabled, false); assert.equal(screenshotStart.disabled, false);
  } finally { await view.close(); }
});

test("身份切换后旧确认成功或 401 不污染新上下文，卸载也不回调", async () => {
  for (const mode of ["success", "auth"]) { const wait = deferred(); const view = await mount({ confirmCashWage: () => wait.promise }); try { await view.fill(); await view.createReady(); await act(async () => { props(view.host.querySelector('input[type="checkbox"]')).onChange({ target: { checked: true } }); await tick(); }); await view.click(view.button("确认现金已发放并记录扣豆")); await view.render("session-2"); await act(async () => { mode === "auth" ? wait.reject(apiError(401)) : wait.resolve({ status: "COMPLETED" }); await tick(); }); assert.equal(view.events.saved, 0); assert.equal(view.events.invalidated, 0); } finally { await view.close(); } }
  const wait = deferred(); const view = await mount({ confirmCashWage: () => wait.promise }); await view.fill(); await view.createReady(); await act(async () => { props(view.host.querySelector('input[type="checkbox"]')).onChange({ target: { checked: true } }); await tick(); }); await view.click(view.button("确认现金已发放并记录扣豆")); await view.close(); await act(async () => { wait.resolve({ status: "COMPLETED" }); await tick(); }); assert.equal(view.events.saved, 0); assert.equal(view.events.invalidated, 0);
});
