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
const repositoryDirectory = resolve(miniappDirectory, "../..");
const clientModule = await import(pathToFileURL(resolve(repositoryDirectory, "packages/client/dist/index.js")).href);

const success = (data) => ({ status: 200, body: { version: "test", data } });
const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer;
const draft = { id: "reimbursement-draft-1", kind: "REIMBURSEMENT", status: "DRAFT", version: 1, createdAt: "2026-09-21T00:00:00.000Z", updatedAt: "2026-09-21T00:00:00.000Z" };
const summary = { id: "reimbursement-1", status: "PENDING_APPROVAL", version: 2, amountCents: "1200", reason: "合成教材", applicantPersonId: "person-1", applicantDisplayName: "合成老师", submittedAt: "2026-09-21T00:00:00.000Z" };
const attachment = (attachmentId, purpose, versions) => ({ attachmentId, purpose, createdAt: "2026-09-21T00:00:00.000Z", versions });
const ready = (versionId, versionNo, originalFilename) => ({ versionId, versionNo, status: "READY", originalFilename, declaredMediaType: "image/png", declaredSizeBytes: 8, createdAt: `2026-09-2${versionNo}T00:00:00.000Z` });

const snapshot = (subject, scope = "SELF") => ({
  sessionId: `mini-${subject}-${scope}`, accountId: "account-1", personId: "person-1",
  roleContexts: [{ subject, personId: "person-1", scope }],
  currentRoleContext: { subject, personId: "person-1", scope }
});

const taroPlugin = {
  name: "miniapp-reimbursement-test-taro",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@tarojs\/taro$/ }, () => ({ path: "miniapp-test-taro", namespace: "miniapp-reimbursement-test" }));
    pluginBuild.onResolve({ filter: /^@tarojs\/components$/ }, () => ({ path: "miniapp-test-components", namespace: "miniapp-reimbursement-test" }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "miniapp-reimbursement-test" }, (args) => ({
      loader: "js",
      contents: args.path === "miniapp-test-taro"
        ? "const taro=new Proxy({}, {get: (_target,key) => (...args) => globalThis.__miniappTaro[key](...args)}); export default taro;"
        : `import React from "react";
           export const View=({children,...props})=>React.createElement("div",props,children);
           export const Text=({children,...props})=>React.createElement("span",props,children);
           export const Button=({children,...props})=>React.createElement("button",props,children);
           export const Input=({password,maxlength,onInput,...props})=>React.createElement("input",{...props,...(maxlength===undefined?{}:{maxLength:maxlength}),onInput:(event)=>onInput?.({detail:{value:event.currentTarget.value}})});
           export const Textarea=({maxlength,onInput,...props})=>React.createElement("textarea",{...props,...(maxlength===undefined?{}:{maxLength:maxlength}),onInput:(event)=>onInput?.({detail:{value:event.currentTarget.value}})});
           export const Picker=({children,range=[],value=0,onChange,disabled,...props})=>React.createElement("div",props,React.createElement("select",{disabled,value:String(value),onChange:(event)=>onChange?.({detail:{value:event.currentTarget.value}})},range.map((item,index)=>React.createElement("option",{key:index,value:String(index)},String(item)))),children);
           export const ScrollView=({children,scrollY,...props})=>React.createElement("div",props,children);`
    }));
  }
};

const bundlePanel = async () => {
  // Keep the bundle under miniapp so Node resolves its React dependency exactly as it does for the existing adapter tests.
  const directory = await mkdtemp(resolve(testDirectory, ".reimbursement-panel-test-"));
  const output = resolve(directory, "reimbursement-panel.mjs");
  await build({
    entryPoints: [resolve(miniappDirectory, "src/pages/index/reimbursement-panel.tsx")], bundle: true, format: "esm", platform: "node", outfile: output,
    define: { __API_BASE_URL__: JSON.stringify("http://127.0.0.1:3100") }, external: ["react", "@teaching-research-alliance/client"], loader: { ".css": "empty" }, plugins: [taroPlugin]
  });
  return { module: await import(`${pathToFileURL(output).href}?${Date.now()}`), directory };
};

const flush = async () => { await act(async () => { await Promise.resolve(); await new Promise((done) => setTimeout(done, 0)); }); };
const button = (container, label) => {
  const found = [...container.querySelectorAll("button")].find((element) => element.textContent === label);
  assert.ok(found, `button ${label} should exist`);
  return found;
};
const click = async (element) => { await act(async () => { element.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); }); await flush(); };
const input = async (element, value) => { await act(async () => { element.value = value; element.dispatchEvent(new window.Event("input", { bubbles: true })); }); await flush(); };
const withDom = async (work) => {
  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
  try { await work(dom.window.document.querySelector("#app")); } finally { dom.window.close(); }
};

let bundled;
const getBundled = async () => {
  if (bundled === undefined) bundled = await bundlePanel();
  return bundled;
};
test.after(async () => { if (bundled !== undefined) await rm(bundled.directory, { recursive: true, force: true }); });

const mountPanel = async ({ subject = "TEACHING_TEACHER", scope = "SELF", mode = "personal", attachments = [], drafts = [draft], records = [], detailRecord = undefined, createFirstUnknown = false, submitFirstUnknown = false, reviewFirstUnknown = false, submitStatus = 200, attachmentStatus = 200, listFailsAfterUpload = false, failReadsAfterSuccess = false } = {}) => {
  const { ReimbursementPanel } = (await getBundled()).module;
  const currentSession = snapshot(subject, scope);
  const requests = [];
  let currentAttachments = attachments;
  let creates = 0; let submits = 0; let reviews = 0; let uploadedAttachmentReads = 0; let invalidations = 0;
  let busyChanges = 0; let unconfirmedChanges = 0;
  globalThis.__miniappTaro = {
    showActionSheet: async () => ({ tapIndex: 0 }), chooseImage: async () => ({ tempFilePaths: ["wxfile://reimbursement.png"] }), chooseMessageFile: async () => ({ tempFiles: [] }),
    getFileSystemManager: () => ({ readFile: ({ success }) => success({ data: pngBytes }) }),
    request: async (request) => {
      if (request.url.includes("/attachment-uploads/upload-version/content")) {
        currentAttachments = [attachment("support-slot", "SUPPORTING_DOCUMENT", [ready("support-v1", 1, "support.png"), ready("upload-version", 2, "reimbursement.png")]), attachment("screenshot-slot", "APPLICATION_SCREENSHOT", [ready("screenshot-v1", 1, "screenshot.png")])];
        return { statusCode: 200, data: { version: "test", data: { attachmentId: "support-slot", versionId: "upload-version", versionNo: 2, status: "READY", purpose: "SUPPORTING_DOCUMENT", originalFilename: "reimbursement.png", declaredMediaType: "image/png", declaredSizeBytes: 8, createdAt: "2026-09-22T00:00:00.000Z" } } };
      }
      throw new Error(`unexpected binary request ${request.url}`);
    }
  };
  const client = new clientModule.TeacherApiClient({
    idempotencyKeyFactory: (() => { let sequence = 0; return () => `reimbursement-key-${++sequence}`; })(),
    transport: async (request) => {
      requests.push(request);
      if (request.path === "/v1/session") return success(currentSession);
      if (request.path === "/v1/finance/reimbursements/mine") {
        if (failReadsAfterSuccess && submits > 0) throw new Error("read unavailable");
        return success({ documents: records });
      }
      if (request.path === "/v1/finance/reimbursements/managed") {
        if (failReadsAfterSuccess && reviews > 0) throw new Error("read unavailable");
        return success({ documents: records });
      }
      if (request.path === "/v1/finance/drafts/mine") return success(drafts);
      if (request.path === `/v1/finance/drafts/${draft.id}`) return success(draft);
      if (request.path === `/v1/finance/documents/${draft.id}/attachments`) {
        if (attachmentStatus !== 200) return { status: attachmentStatus, body: { error: { code: attachmentStatus === 403 ? "FORBIDDEN_SCOPE" : "INVALID_INPUT", message: "attachment failed" } } };
        if (listFailsAfterUpload && currentAttachments.some((item) => item.versions.some((version) => version.versionId === "upload-version")) && uploadedAttachmentReads++ === 0) throw new Error("attachment list unavailable");
        return success({ documentId: draft.id, attachments: currentAttachments });
      }
      if (request.path === "/v1/finance/attachments/support-slot/versions") return success({ attachmentId: "support-slot", versionId: "upload-version", versionNo: 2, status: "UPLOADING", purpose: "SUPPORTING_DOCUMENT", originalFilename: "reimbursement.png", declaredMediaType: "image/png", declaredSizeBytes: 8, createdAt: "2026-09-22T00:00:00.000Z", replay: false });
      if (request.path === "/v1/finance/drafts") {
        creates += 1;
        if (createFirstUnknown && creates === 1) throw new Error("network uncertain");
        return success({ ...draft, replay: creates > 1 });
      }
      if (request.path === `/v1/finance/drafts/${draft.id}/reimbursement-submit`) {
        submits += 1;
        if (submitFirstUnknown && submits === 1) throw new Error("network uncertain");
        if (submitStatus !== 200) return { status: submitStatus, body: { error: { code: "VERSION_CONFLICT", message: "changed" } } };
        return success({ id: draft.id, status: "PENDING_APPROVAL", version: 2, replay: submits > 1 });
      }
      if (request.path === "/v1/finance/reimbursements/reimbursement-1") {
        return success(detailRecord ?? { ...summary, attachments: [
          { versionId: "support-v2", purpose: "SUPPORTING_DOCUMENT", originalFilename: "new-support.png", mediaType: "image/png", sizeBytes: 8, sha256: "a".repeat(64) },
          { versionId: "screenshot-v2", purpose: "APPLICATION_SCREENSHOT", originalFilename: "screen.png", mediaType: "image/png", sizeBytes: 8, sha256: "b".repeat(64) }
        ] });
      }
      if (request.path === "/v1/finance/reimbursements/reimbursement-1/approve" || request.path === "/v1/finance/reimbursements/reimbursement-1/reject") {
        reviews += 1;
        if (reviewFirstUnknown && reviews === 1) throw new Error("network uncertain");
        return success({ id: "reimbursement-1", status: request.path.endsWith("approve") ? "APPROVED" : "REJECTED", version: 3, replay: reviews > 1 });
      }
      throw new Error(`unexpected ${request.method} ${request.path}`);
    }
  });
  await client.login({ phoneNormalized: "13800000000", password: "password" });
  return {
    client, currentSession, requests, invalidations: () => invalidations, busyChanges: () => busyChanges, unconfirmedChanges: () => unconfirmedChanges,
    mount: async (container) => {
      const root = createRoot(container);
      await act(async () => { root.render(React.createElement(ReimbursementPanel, {
        client, session: currentSession, mode, onInvalidated: () => { invalidations += 1; }, onBusyChange: () => { busyChanges += 1; }, onUnconfirmedChange: () => { unconfirmedChanges += 1; }
      })); });
      await flush();
      return root;
    }
  };
};

test("三个个人身份都只读取自己的普通报销并可新建申请", async () => {
  for (const subject of ["TEACHING_TEACHER", "ACADEMIC_PLANNER", "PLANNING_MENTOR"]) {
    const fixture = await mountPanel({ subject });
    await withDom(async (container) => {
      const root = await fixture.mount(container);
      assert.ok(container.querySelector('[data-reimbursement-module="reimbursement"][data-mode="personal"]'));
      assert.ok(button(container, "新建报销申请"));
      assert.equal(fixture.requests.filter((request) => request.path === "/v1/finance/reimbursements/mine").length, 1);
      assert.equal(fixture.requests.filter((request) => request.path === "/v1/finance/reimbursements/managed").length, 0);
      assert.equal(fixture.requests.some((request) => request.path === "/v1/me"), false, "报销的读取和操作不得读取或清空余额概览");
      await act(async () => root.unmount());
    });
  }
});

test("草稿恢复时默认选用每类最新 READY 原件；未知提交冻结原金额、原因、版本和请求键", async () => {
  const fixture = await mountPanel({
    attachments: [
      attachment("support-slot", "SUPPORTING_DOCUMENT", [ready("support-v1", 1, "old-support.png"), ready("support-v2", 2, "new-support.png")]),
      attachment("screenshot-slot", "APPLICATION_SCREENSHOT", [ready("screenshot-v1", 1, "old-screen.png"), ready("screenshot-v2", 2, "new-screen.png")])
    ], submitFirstUnknown: true
  });
  await withDom(async (container) => {
    const root = await fixture.mount(container);
    await click(button(container, "继续填写报销"));
    assert.match(container.textContent, /new-support\.png/);
    assert.match(container.textContent, /new-screen\.png/);
    const fields = [...container.querySelectorAll("input")].filter((element) => element.type !== "radio");
    await input(fields[0], "12.00"); await input(fields[1], "合成教材报销");
    await click(button(container, "确认提交报销申请"));
    assert.equal(container.querySelector('[data-reimbursement-pending="submit"]') === null, false);
    assert.equal(fields[0].disabled, true);
    await click(button(container, "安全重试原报销申请"));
    const submits = fixture.requests.filter((request) => request.path.endsWith("/reimbursement-submit"));
    assert.deepEqual(submits.map((request) => request.body), [
      { expectedVersion: 1, amountCents: "1200", reason: "合成教材报销", attachmentVersionIds: ["support-v2", "screenshot-v2"], idempotencyKey: "reimbursement-key-1" },
      { expectedVersion: 1, amountCents: "1200", reason: "合成教材报销", attachmentVersionIds: ["support-v2", "screenshot-v2"], idempotencyKey: "reimbursement-key-1" }
    ]);
    await act(async () => root.unmount());
  });
});

test("未知草稿创建不会从同类草稿推断成功，安全重试保持原请求键", async () => {
  const fixture = await mountPanel({ drafts: [], createFirstUnknown: true });
  await withDom(async (container) => {
    const root = await fixture.mount(container);
    await click(button(container, "新建报销申请"));
    assert.ok(container.querySelector('[data-reimbursement-pending="create"]'));
    await click(button(container, "刷新报销记录"));
    await click(button(container, "安全重试原创建请求"));
    const creates = fixture.requests.filter((request) => request.path === "/v1/finance/drafts");
    assert.deepEqual(creates.map((request) => request.body), [
      { kind: "REIMBURSEMENT", idempotencyKey: "reimbursement-key-1" },
      { kind: "REIMBURSEMENT", idempotencyKey: "reimbursement-key-1" }
    ]);
    await act(async () => root.unmount());
  });
});

test("严格 GLOBAL 总部财务可审核且未知审核保持原键；管理员和所有者只能查看", async () => {
  const hq = await mountPanel({ subject: "HEADQUARTERS_FINANCE", scope: "GLOBAL", mode: "managed", records: [summary], reviewFirstUnknown: true });
  await withDom(async (container) => {
    const root = await hq.mount(container);
    await click(button(container, "查看报销详情"));
    const reviewBox = container.querySelector('[data-reimbursement-action="review"]');
    assert.ok(reviewBox);
    await input(reviewBox.querySelector("textarea"), "资料齐全");
    await click(button(container, "批准报销申请"));
    assert.ok(container.querySelector('[data-reimbursement-pending="review"]'));
    assert.match(container.textContent, /本次审核决定：批准；审核原因已锁定/);
    await click(button(container, "安全重试原审核操作"));
    const reviews = hq.requests.filter((request) => request.path.endsWith("/approve"));
    assert.deepEqual(reviews.map((request) => request.body), [
      { expectedVersion: 2, reason: "资料齐全", idempotencyKey: "reimbursement-key-1" },
      { expectedVersion: 2, reason: "资料齐全", idempotencyKey: "reimbursement-key-1" }
    ]);
    await act(async () => root.unmount());
  });
  for (const subject of ["SYSTEM_ADMIN", "SYSTEM_OWNER"]) {
    const readonly = await mountPanel({ subject, scope: "GLOBAL", mode: "managed", records: [summary] });
    await withDom(async (container) => {
      const root = await readonly.mount(container);
      await click(button(container, "查看报销详情"));
      assert.equal(container.querySelector('[data-reimbursement-action="review"]'), null, `${subject} must stay readonly`);
      assert.equal([...container.querySelectorAll("button")].some((element) => /批准报销申请|驳回报销申请/.test(element.textContent)), false);
      await act(async () => root.unmount());
    });
  }
});

test("原件读取 403 清除敏感草稿状态并向父层报告失效", async () => {
  const fixture = await mountPanel({ attachmentStatus: 403 });
  await withDom(async (container) => {
    const root = await fixture.mount(container);
    await click(button(container, "继续填写报销"));
    assert.equal(fixture.invalidations(), 1);
    assert.equal(container.querySelector("textarea"), null, "权限失效后不得继续保留报销原因等敏感输入");
    await act(async () => root.unmount());
  });
});

test("同一原件槽上传修订版后重新读取并提交该精确 READY 版本", async () => {
  const fixture = await mountPanel({
    attachments: [attachment("support-slot", "SUPPORTING_DOCUMENT", [ready("support-v1", 1, "support.png")]), attachment("screen-slot", "APPLICATION_SCREENSHOT", [ready("screen-v1", 1, "screen.png")])]
  });
  await withDom(async (container) => {
    const root = await fixture.mount(container);
    await click(button(container, "继续填写报销"));
    await click(button(container, "选择原件"));
    await click(button(container, "上传报销业务单据"));
    assert.match(container.textContent, /修订版 2 · reimbursement\.png/);
    const fields = [...container.querySelectorAll("input")].filter((element) => element.type !== "radio");
    await input(fields[0], "20.00"); await input(fields[1], "新版本原件");
    await click(button(container, "确认提交报销申请"));
    const submit = fixture.requests.find((request) => request.path.endsWith("/reimbursement-submit"));
    assert.deepEqual(submit.body.attachmentVersionIds, ["upload-version", "screenshot-v1"]);
    await act(async () => root.unmount());
  });
});

test("上传后原件列表首次读取失败时禁止提交，刷新后才恢复最新 READY 版本", async () => {
  const fixture = await mountPanel({
    attachments: [attachment("support-slot", "SUPPORTING_DOCUMENT", [ready("support-v1", 1, "support.png")]), attachment("screen-slot", "APPLICATION_SCREENSHOT", [ready("screen-v1", 1, "screen.png")])],
    listFailsAfterUpload: true
  });
  await withDom(async (container) => {
    const root = await fixture.mount(container);
    await click(button(container, "继续填写报销"));
    await click(button(container, "选择原件"));
    await click(button(container, "上传报销业务单据"));
    assert.match(container.textContent, /原件已上传，但版本列表刷新失败/);
    const fields = [...container.querySelectorAll("input")].filter((element) => element.type !== "radio");
    await input(fields[0], "20.00"); await input(fields[1], "须刷新后提交");
    await click(button(container, "确认提交报销申请"));
    assert.equal(fixture.requests.filter((request) => request.path.endsWith("/reimbursement-submit")).length, 0);
    await click(button(container, "刷新报销记录"));
    assert.match(container.textContent, /修订版 2 · reimbursement\.png/);
    await click(button(container, "确认提交报销申请"));
    assert.equal(fixture.requests.filter((request) => request.path.endsWith("/reimbursement-submit")).length, 1);
    await act(async () => root.unmount());
  });
});

test("409 重新读取但不会自动重发", async () => {
  const conflict = await mountPanel({
    attachments: [attachment("support-slot", "SUPPORTING_DOCUMENT", [ready("support-v1", 1, "support.png")]), attachment("screen-slot", "APPLICATION_SCREENSHOT", [ready("screen-v1", 1, "screen.png")])], submitStatus: 409
  });
  await withDom(async (container) => {
    const root = await conflict.mount(container);
    await click(button(container, "继续填写报销"));
    const fields = [...container.querySelectorAll("input")].filter((element) => element.type !== "radio");
    await input(fields[0], "10.00"); await input(fields[1], "冲突测试"); await click(button(container, "确认提交报销申请"));
    assert.equal(conflict.requests.filter((request) => request.path.endsWith("/reimbursement-submit")).length, 1);
    assert.match(container.textContent, /旧输入已清空|重新读取/);
    await act(async () => root.unmount());
  });
});

test("提交结果已确认但后续读取失败时，不会再次提交或清空余额", async () => {
  const fixture = await mountPanel({
    attachments: [attachment("support-slot", "SUPPORTING_DOCUMENT", [ready("support-v1", 1, "support.png")]), attachment("screen-slot", "APPLICATION_SCREENSHOT", [ready("screen-v1", 1, "screen.png")])],
    failReadsAfterSuccess: true
  });
  await withDom(async (container) => {
    const root = await fixture.mount(container);
    await click(button(container, "继续填写报销"));
    const fields = [...container.querySelectorAll("input")].filter((element) => element.type !== "radio");
    await input(fields[0], "10.00"); await input(fields[1], "读失败后已确认"); await click(button(container, "确认提交报销申请"));
    assert.match(container.textContent, /结果已确认，但刷新失败/);
    assert.equal(fixture.requests.filter((request) => request.path.endsWith("/reimbursement-submit")).length, 1);
    assert.equal(fixture.requests.some((request) => request.path === "/v1/me"), false);
    await act(async () => root.unmount());
  });
});


test("已完成报销保留两份原件和内部划拨时间；个人不会看到来源账户或审核操作", async () => {
  const completed = {
    ...summary, status: "COMPLETED", version: 4, completedAt: "2026-09-21T00:00:00.000Z",
    attachments: [
      { versionId: "support-completed", purpose: "SUPPORTING_DOCUMENT", originalFilename: "completed-support.png", mediaType: "image/png", sizeBytes: 8, sha256: "a".repeat(64) },
      { versionId: "screen-completed", purpose: "APPLICATION_SCREENSHOT", originalFilename: "completed-screen.png", mediaType: "image/png", sizeBytes: 8, sha256: "b".repeat(64) }
    ],
    decision: { decision: "APPROVED", reason: "审核通过", decidedAt: "2026-09-20T00:00:00.000Z" },
    management: { destinationAccountId: "destination-account", submittedByPersonId: "person-1", applicantContextSubject: "TEACHING_TEACHER", applicantContextScope: "SELF", completion: {
      roleAssignmentId: "role-assignment", companyFundAssignmentId: "fund-assignment", sourceAccountId: "source-account", destinationAccountId: "destination-account", ledgerEventId: "ledger-event", executedByPersonId: "executor-person", executedAt: "2026-09-21T00:00:00.000Z"
    } }
  };
  const managed = await mountPanel({ subject: "HEADQUARTERS_FINANCE", scope: "GLOBAL", mode: "managed", records: [completed], detailRecord: completed });
  await withDom(async (container) => {
    const root = await managed.mount(container);
    await click(button(container, "查看报销详情"));
    assert.match(container.textContent, /已完成/);
    assert.match(container.textContent, /审核决定：审核通过/);
    assert.equal(container.textContent.includes("审核通过·待划拨"), false);
    assert.match(container.textContent, /内部划拨完成时间：.*08:00:00/);
    assert.match(container.textContent, /completed-support\.png/); assert.match(container.textContent, /completed-screen\.png/);
    assert.match(container.textContent, /source-account/); assert.match(container.textContent, /destination-account/);
    assert.equal(container.querySelector('[data-reimbursement-action="review"]'), null);
    assert.equal([...container.querySelectorAll("button")].some((element) => /批准报销申请|驳回报销申请|划拨|转账|执行/.test(element.textContent)), false);
    await act(async () => root.unmount());
  });
  const personal = await mountPanel({ records: [completed], detailRecord: completed });
  await withDom(async (container) => {
    const root = await personal.mount(container);
    await click(button(container, "查看报销详情"));
    assert.match(container.textContent, /已完成/); assert.match(container.textContent, /completed-support\.png/); assert.match(container.textContent, /completed-screen\.png/);
    assert.equal(container.textContent.includes("source-account"), false, "个人视图不得渲染总部来源账户");
    assert.equal(container.textContent.includes("destination-account"), false, "个人视图不得渲染执行关系账户");
    assert.equal(container.querySelector('[data-reimbursement-action="review"]'), null);
    await act(async () => root.unmount());
  });
});
