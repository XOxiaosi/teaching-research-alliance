import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { ApiClientError } from "@teaching-research-alliance/client";

const roster = { salaryMonth: "2026-09-01", items: [{ teacherPersonId: "teacher-a", teacherDisplayName: "王老师", plan: { id: "p", sourceMonth: "2026-09-01", version: 1, plannedCashCents: "1000", plannedDeductionCents: "1000", active: true, appliesToFutureMonths: false, reason: "", changedAt: "", changedByPersonId: "" }, todo: { id: "todo", generatedAt: "", planVersionId: "p" }, confirmedCashCents: "0", confirmedDeductionCents: "0", remainingCashCents: "1000", remainingDeductionCents: "1000", overageCashCents: "0", overageDeductionCents: "0", status: "PENDING" }] };
const session = { sessionId: "s", accountId: "a", personId: "p", currentRoleContext: { subject: "HEADQUARTERS_FINANCE", scope: "GLOBAL" }, roleContexts: [] };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const props = element => element[Object.keys(element).find(key => key.startsWith("__reactProps$"))];
const apiError = status => new ApiClientError(status, status === 409 ? "STATE_CONFLICT" : "INVALID_INPUT");
let Panel, dir;

before(async () => {
  dir = await mkdtemp(resolve(import.meta.dirname, ".cash-confirm-mini-")); const out = resolve(dir, "panel.mjs");
  const plugin = { name: "mini-confirm-stubs", setup(api) {
    api.onResolve({ filter: /^@tarojs\/taro$/ }, () => ({ path: "taro", namespace: "mini" }));
    api.onLoad({ filter: /^taro$/, namespace: "mini" }, () => ({ loader: "js", contents: `export default { showActionSheet: async options => globalThis.__showActionSheet ? globalThis.__showActionSheet(options) : ({ tapIndex: 0 }), chooseImage: async options => globalThis.__chooseImage ? globalThis.__chooseImage(options) : ({ tempFilePaths: ["/tmp/fake.png"] }), chooseMessageFile: async options => globalThis.__chooseMessageFile ? globalThis.__chooseMessageFile(options) : ({ tempFiles: [{ path: "/tmp/fake.pdf", name: "fake.pdf" }] }) };` }));
    api.onResolve({ filter: /^@tarojs\/components$/ }, () => ({ path: "components", namespace: "mini" }));
    api.onLoad({ filter: /^components$/, namespace: "mini" }, () => ({ loader: "js", contents: `import React from "react"; export const View=({children,...p})=>React.createElement("div",p,children); export const Text=({children,...p})=>React.createElement("span",p,children); export const Button=({children,...p})=>React.createElement("button",p,children); export const Input=({onInput,...p})=>React.createElement("input",{...p,onInput}); export const Textarea=({onInput,...p})=>React.createElement("textarea",{...p,onInput}); export const Picker=({children,range=[],value=0,onChange,...p})=>React.createElement(React.Fragment,null,React.createElement("select",{...p,value:String(value),onChange:e=>onChange?.({detail:{value:e.currentTarget.value}})},range.map((x,i)=>React.createElement("option",{key:i,value:String(i)},x))),children);` }));
    api.onResolve({ filter: /services$/ }, () => ({ path: "services", namespace: "mini" }));
    api.onLoad({ filter: /^services$/, namespace: "mini" }, () => ({ loader: "js", contents: `export const readTemporaryFileBytes=async path => (path.endsWith(".pdf") ? new Uint8Array([0x25,0x50,0x44,0x46,0x2d,0x31]) : new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])).buffer; export const uploadFinanceAttachmentBytes=async(...args)=>globalThis.__upload ? globalThis.__upload(...args) : ({status:200});` }));
  }};
  await build({ entryPoints: [resolve(import.meta.dirname, "../src/pages/index/cash-wage-confirmation-panel.tsx")], bundle: true, format: "esm", platform: "node", outfile: out, external: ["react", "@teaching-research-alliance/client"], plugins: [plugin] });
  Panel = (await import(`file://${out}?${Date.now()}`)).CashWageConfirmationPanel;
});
after(async () => { await rm(dir, { recursive: true, force: true }); });

async function mount(overrides = {}, taro = {}) {
  const dom = new JSDOM("<div id=host></div>", { url: "http://localhost" }); Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.querySelector("#host"), { createRoot } = await import("react-dom/client"), root = createRoot(host); const events = { docs: [], confirms: [], saved: 0, invalidated: 0, locks: [] };
  const attachments = { documentId: "doc-1", attachments: [{ attachmentId: "a1", purpose: "SUPPORTING_DOCUMENT", versions: [{ versionId: "v1", versionNo: 1, status: "READY" }] }, { attachmentId: "a2", purpose: "APPLICATION_SCREENSHOT", versions: [{ versionId: "v2", versionNo: 1, status: "READY" }] }] };
  let currentSession = session;
  const client = { hasRoleContext: true, currentSession, listManagedCashWageRoster: async () => roster, createSalaryBenefitDocumentSubmission: () => ({ draft: { kind: "CASH_WAGE" }, idempotencyKey: `doc-${events.docs.length}` }), createSalaryBenefitDocument: async sub => { events.docs.push(sub); return { id: "doc-1", version: 1 }; }, listFinanceDocumentAttachments: async () => attachments, createFinanceAttachmentReservationSubmission: draft => ({ draft, idempotencyKey: "attach-key" }), reserveFinanceAttachment: async submission => ({ versionId: submission.draft.purpose === "APPLICATION_SCREENSHOT" ? "v2" : "v1" }), getOwnFinanceAttachmentVersion: async versionId => ({ versionId, status: "READY" }), logout: () => { events.invalidated++; }, createCashWageConfirmationSubmission: draft => ({ draft, idempotencyKey: `confirm-${events.confirms.length}` }), confirmCashWage: async sub => { events.confirms.push(sub); return { status: "COMPLETED" }; }, ...overrides };
  globalThis.__showActionSheet = taro.showActionSheet; globalThis.__chooseImage = taro.chooseImage; globalThis.__chooseMessageFile = taro.chooseMessageFile; globalThis.__upload = taro.upload;
  const render = async key => { await act(async () => { root.render(React.createElement(Panel, { client, session: currentSession, sessionKey: key, onSaved: () => events.saved++, onInvalidated: () => events.invalidated++, onUnconfirmedChange: value => events.locks.push(value) })); await tick(); }); };
  await render("one");
  const click = async element => { assert.ok(element); await act(async () => { element.click(); await tick(); }); };
  const input = async (element, value) => { await act(async () => { props(element).onInput?.({ detail: { value } }); await tick(); }); };
  const buttons = text => [...host.querySelectorAll("button")].filter(e => e.textContent.includes(text));
  const fill = async () => { await act(async () => { props(host.querySelectorAll("select")[1]).onChange({ currentTarget: { value: "0" } }); await tick(); }); const fields = [...host.querySelectorAll("input")]; await input(fields[0], "10"); await input(fields[1], "10"); await input(host.querySelector("textarea"), "现金已发放"); await click(buttons("确认现金已线下发放")[0]); };
  return { dom, root, host, client, events, render, click, input, buttons, fill, setCurrentSession: next => { currentSession = next; client.currentSession = next; }, close: async () => { await act(async () => root.unmount()); dom.window.close(); } };
}

test("todo名单与创建 unknown 重试必须复用同一 submission", async () => { let first = true; const view = await mount({ createSalaryBenefitDocument: async sub => { view.events.docs.push(sub); if (first) { first = false; throw new Error("network"); } return { id: "doc-1", version: 1 }; } }); try { assert.ok(view.host.textContent.includes("王老师")); await view.fill(); await view.click(view.buttons("创建工资确认凭证")[0]); await view.click(view.buttons("安全重试创建凭证")[0]); assert.equal(view.events.docs.length, 2); assert.equal(view.events.docs[0], view.events.docs[1]); } finally { await view.close(); } });

test("双用途上传 pending 锁定表单，失败释放并读取 READY", async () => { const wait = deferred(); const view = await mount({}, { chooseImage: () => wait.promise }); try { await view.fill(); await view.click(view.buttons("创建工资确认凭证")[0]); const uploads = view.buttons("上传"); await view.click(uploads[0]); assert.equal(view.buttons("上传")[0].disabled, true); assert.equal(view.events.locks.at(-1), true); await act(async () => { wait.resolve({ tempFilePaths: ["/tmp/fake.png"] }); await tick(); await tick(); }); assert.equal(view.buttons("上传")[0].disabled, false); } finally { await view.close(); } });

test("READY 两用途才能确认，确认 unknown 复用同 submission", async () => { let first = true; const view = await mount({ confirmCashWage: async sub => { view.events.confirms.push(sub); if (first) { first = false; throw new Error("network"); } return { status: "COMPLETED" }; } }); try { await view.fill(); await view.click(view.buttons("创建工资确认凭证")[0]); await view.click(view.buttons("选择并上传工资发放凭证")[0]); await act(async () => { await tick(); await tick(); await tick(); }); await view.click(view.buttons("选择并上传工资确认截图")[0]); await act(async () => { await tick(); await tick(); await tick(); }); await view.click(view.buttons("确认现金已发放并记录扣豆")[0]); assert.equal(view.events.confirms.length, 1); await view.click(view.buttons("安全重试原确认")[0]); assert.equal(view.events.confirms.length, 2); assert.equal(view.events.confirms[0], view.events.confirms[1]); } finally { await view.close(); } });

test("401/403、409 核对与 session 迟到不污染", async () => { for (const status of [401, 403]) { const view = await mount({ listManagedCashWageRoster: async () => { throw apiError(status); } }); try { await tick(); assert.equal(view.events.invalidated, 1); } finally { await view.close(); } } const wait = deferred(); const view = await mount({ confirmCashWage: () => wait.promise }); try { await view.fill(); await view.click(view.buttons("创建工资确认凭证")[0]); await view.click(view.buttons("确认现金已发放并记录扣豆")[0]); await view.render("two"); await act(async () => { wait.resolve({ status: "COMPLETED" }); await tick(); }); assert.equal(view.events.saved, 0); } finally { await view.close(); } });

test("上传 await 期间 session 变化必须中止、不读取附件、不设 READY 并通知失效", async () => {
  const wait = deferred(); let attachmentReads = 0;
  const view = await mount({
    listFinanceDocumentAttachments: async () => { attachmentReads++; return { documentId: "doc-1", attachments: [{ attachmentId: "a1", purpose: "SUPPORTING_DOCUMENT", versions: [] }, { attachmentId: "a2", purpose: "APPLICATION_SCREENSHOT", versions: [] }] }; },
  }, { chooseImage: () => wait.promise });
  try {
    await view.fill(); await view.click(view.buttons("创建工资确认凭证")[0]);
    const upload = view.buttons("选择并上传工资发放凭证")[0]; await view.click(upload);
    const initialReads = attachmentReads;
    view.client.currentSession = { ...session, sessionId: "new-session" };
    await act(async () => { wait.resolve({ tempFilePaths: ["/tmp/fake.png"] }); await tick(); await tick(); await tick(); });
    assert.equal(attachmentReads, initialReads);
    assert.equal(view.events.invalidated, 1);
    assert.equal(view.host.textContent.includes("原件已完整上传"), false);
  } finally { await view.close(); }
});

test("reserve 未知结果保留原 submission，重试不重新选择文件", async () => {
  let first = true; let choices = 0; const reservations = [];
  const view = await mount({ reserveFinanceAttachment: async submission => { reservations.push(submission); if (first) { first = false; throw new Error("reservation unknown"); } return { versionId: "v1" }; } }, { chooseImage: async () => { choices++; return { tempFilePaths: ["/tmp/fake.png"] }; } });
  try { await view.fill(); await view.click(view.buttons("创建工资确认凭证")[0]); await view.click(view.buttons("选择并上传工资发放凭证")[0]); await act(async () => { await tick(); await tick(); }); assert.equal(choices, 1); assert.equal(view.buttons("安全重试上传工资发放凭证").length, 1); await view.click(view.buttons("安全重试上传工资发放凭证")[0]); await act(async () => { await tick(); await tick(); await tick(); }); assert.equal(choices, 1); assert.equal(reservations.length, 2); assert.equal(reservations[0], reservations[1]); assert.equal(reservations[0].idempotencyKey, reservations[1].idempotencyKey); } finally { await view.close(); }
});

test("binary response 丢失时读取 READY，不重复上传", async () => {
  let uploads = 0; let metadataReads = 0; const view = await mount({ getOwnFinanceAttachmentVersion: async versionId => ({ versionId, status: metadataReads++ === 0 ? "PROCESSING" : "READY" }) }, { upload: async () => { uploads++; return { status: 200 }; } });
  try { await view.fill(); await view.click(view.buttons("创建工资确认凭证")[0]); await view.click(view.buttons("选择并上传工资发放凭证")[0]); await act(async () => { await tick(); await tick(); await tick(); }); assert.equal(uploads, 1); assert.equal(view.host.textContent.includes("原件已完整上传"), true); } finally { await view.close(); }
});

test("409 首次核对读取失败保持 conflict，第二次成功重置草稿", async () => {
  let reads = 0; const view = await mount({ listManagedCashWageRoster: async () => { reads++; if (reads === 2) throw new Error("read offline"); return roster; }, confirmCashWage: async () => { throw apiError(409); } });
  try { await view.fill(); await view.click(view.buttons("创建工资确认凭证")[0]); await view.click(view.buttons("选择并上传工资发放凭证")[0]); await act(async () => { await tick(); await tick(); await tick(); }); await view.click(view.buttons("选择并上传工资确认截图")[0]); await act(async () => { await tick(); await tick(); await tick(); }); await view.click(view.buttons("确认现金已发放并记录扣豆")[0]); assert.equal(view.buttons("重新读取并核对").length, 1); await view.click(view.buttons("重新读取并核对")[0]); assert.equal(view.buttons("重新读取并核对").length, 1); await view.click(view.buttons("重新读取并核对")[0]); assert.equal(view.buttons("创建工资确认凭证").length, 0); } finally { await view.close(); }
});

test("binary upload 网络未知后重试只读取 READY，不重复 POST", async () => {
  let metadataReads = 0; let posts = 0; let first = true;
  const view = await mount({
    getOwnFinanceAttachmentVersion: async versionId => ({ versionId, status: metadataReads++ === 0 ? "PROCESSING" : "READY" }),
  }, { upload: async () => { posts++; if (first) { first = false; throw new Error("upload network"); } return { status: 200 }; } });
  try { await view.fill(); await view.click(view.buttons("创建工资确认凭证")[0]); await view.click(view.buttons("选择并上传工资发放凭证")[0]); await act(async () => { await tick(); await tick(); await tick(); }); assert.equal(posts, 1); assert.equal(view.buttons("安全重试上传工资发放凭证").length, 1); await view.click(view.buttons("安全重试上传工资发放凭证")[0]); await act(async () => { await tick(); await tick(); await tick(); }); assert.equal(posts, 1); assert.equal(view.host.textContent.includes("原件已完整上传"), true); } finally { await view.close(); }
});

test("文件选择使用真实 magic bytes 推导 PNG/PDF mediaType", async () => {
  const submissions = []; const view = await mount({ createFinanceAttachmentReservationSubmission: draft => { submissions.push(draft); return { draft, idempotencyKey: `attach-${submissions.length}` }; } }, { showActionSheet: async () => ({ tapIndex: 1 }), chooseMessageFile: async () => ({ tempFiles: [{ path: "/tmp/real.pdf", name: "real.pdf" }] }) });
  try { await view.fill(); await view.click(view.buttons("创建工资确认凭证")[0]); await view.click(view.buttons("选择并上传工资发放凭证")[0]); await act(async () => { await tick(); await tick(); await tick(); }); assert.equal(submissions[0].declaredMediaType, "application/pdf"); assert.equal(submissions[0].originalFilename, "real.pdf"); } finally { await view.close(); }
});

test("真实二进制上传 await 期间切换 currentSession 会中止，不读取列表、不设 READY", async () => {
  const waitUpload = deferred(); let uploads = 0; let attachmentReads = 0;
  const view = await mount({ getOwnFinanceAttachmentVersion: async versionId => ({ versionId, status: "PROCESSING" }), listFinanceDocumentAttachments: async () => { attachmentReads++; return { documentId: "doc-1", attachments: [] }; } }, { upload: async () => { uploads++; return waitUpload.promise; } });
  try { await view.fill(); await view.click(view.buttons("创建工资确认凭证")[0]); await view.click(view.buttons("选择并上传工资发放凭证")[0]); await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); }); const readsBefore = attachmentReads; assert.equal(uploads, 1); view.client.currentSession = { ...session, sessionId: "switched" }; await act(async () => { waitUpload.resolve({ status: 200, metadata: { versionId: "v1", status: "READY" } }); await tick(); await tick(); }); assert.equal(attachmentReads, readsBefore); assert.equal(view.events.invalidated, 1); assert.equal(view.host.textContent.includes("原件已完整上传"), false); } finally { await view.close(); }
});

test("metadata 读取迟到时切换 currentSession 不读取附件列表也不设 READY", async () => {
  const waitMetadata = deferred(); let attachmentReads = 0; let metadataStarted = 0;
  const view = await mount({ getOwnFinanceAttachmentVersion: async () => { metadataStarted++; return waitMetadata.promise; }, listFinanceDocumentAttachments: async () => { attachmentReads++; return { documentId: "doc-1", attachments: [] }; } });
  try { await view.fill(); await view.click(view.buttons("创建工资确认凭证")[0]); await view.click(view.buttons("选择并上传工资发放凭证")[0]); await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); }); assert.equal(metadataStarted, 1); const readsBefore = attachmentReads; view.client.currentSession = { ...session, sessionId: "metadata-switched" }; await act(async () => { waitMetadata.resolve({ versionId: "v1", status: "READY" }); await tick(); await tick(); }); assert.equal(attachmentReads, readsBefore); assert.equal(view.events.invalidated, 1); assert.equal(view.host.textContent.includes("原件已完整上传"), false); } finally { await view.close(); }
});

test("附件列表迟到时切换 currentSession 不设 READY", async () => {
  const waitList = deferred(); let attachmentReads = 0; let listCalls = 0;
  const view = await mount({ getOwnFinanceAttachmentVersion: async versionId => ({ versionId, status: "READY" }), listFinanceDocumentAttachments: async () => { listCalls++; if (listCalls === 1) return { documentId: "doc-1", attachments: [] }; attachmentReads++; return waitList.promise; } });
  try { await view.fill(); await view.click(view.buttons("创建工资确认凭证")[0]); await view.click(view.buttons("选择并上传工资发放凭证")[0]); await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); }); assert.equal(listCalls, 2); const readsBefore = attachmentReads; view.client.currentSession = { ...session, sessionId: "list-switched" }; await act(async () => { waitList.resolve({ documentId: "doc-1", attachments: [{ attachmentId: "a1", purpose: "SUPPORTING_DOCUMENT", versions: [{ versionId: "v1", versionNo: 1, status: "READY" }] }] }); await tick(); await tick(); }); assert.equal(attachmentReads, readsBefore); assert.equal(view.events.invalidated, 1); assert.equal(view.host.textContent.includes("原件已完整上传"), false); } finally { await view.close(); }
});

test("附件列表 documentId 错误时保持待重试，不错误标记 READY", async () => {
  const view = await mount({ getOwnFinanceAttachmentVersion: async versionId => ({ versionId, status: "READY" }), listFinanceDocumentAttachments: async () => ({ documentId: "wrong-document", attachments: [] }) });
  try { await view.fill(); await view.click(view.buttons("创建工资确认凭证")[0]); await view.click(view.buttons("选择并上传工资发放凭证")[0]); await tick(); await tick(); await tick(); assert.equal(view.buttons("安全重试上传工资发放凭证").length, 1); assert.equal(view.host.textContent.includes("原件已完整上传"), false); } finally { await view.close(); }
});

test("FAILED 上传释放原命令并允许重新选择文件", async () => {
  let choices = 0; let reservations = 0; let metadataReads = 0; let uploads = 0;
  const view = await mount({ createFinanceAttachmentReservationSubmission: draft => { reservations++; return { draft, idempotencyKey: `retry-${reservations}` }; }, getOwnFinanceAttachmentVersion: async versionId => ({ versionId, status: metadataReads++ === 0 ? "FAILED" : "READY" }), listFinanceDocumentAttachments: async () => ({ documentId: "doc-1", attachments: [{ attachmentId: "a1", purpose: "SUPPORTING_DOCUMENT", versions: [{ versionId: "v1", versionNo: 1, status: "READY" }] }] }) }, { chooseImage: async () => { choices++; return { tempFilePaths: [`/tmp/file-${choices}.png`] }; }, upload: async () => { uploads++; return { status: 200 }; } });
  try { await view.fill(); await view.click(view.buttons("创建工资确认凭证")[0]); await view.click(view.buttons("选择并上传工资发放凭证")[0]); await tick(); await tick(); await tick(); assert.equal(view.buttons("选择并上传工资发放凭证").length, 1); assert.equal(view.host.textContent.includes("原件未通过校验"), true); await view.click(view.buttons("选择并上传工资发放凭证")[0]); await tick(); await tick(); await tick(); assert.equal(choices, 2); assert.equal(reservations, 2); assert.equal(uploads, 0); assert.equal(view.host.textContent.includes("原件已完整上传"), true); } finally { await view.close(); }
});
