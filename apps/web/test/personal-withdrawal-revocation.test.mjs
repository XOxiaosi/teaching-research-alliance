import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

let compiled;
test.before(async () => {
  const directory = await mkdtemp(resolve(import.meta.dirname, ".withdrawal-revocation-"));
  const output = resolve(directory, "panel.mjs");
  await build({ entryPoints: [resolve(import.meta.dirname, "../src/personal-withdrawal-panel.tsx")], bundle: true, platform: "node", format: "esm", outfile: output, external: ["react", "react-dom", "@teaching-research-alliance/client"] });
  compiled = { directory, module: await import(`${pathToFileURL(output).href}?${Date.now()}`) };
});
test.after(async () => { if (compiled) await rm(compiled.directory, { recursive: true, force: true }); });

const flush = async () => { await act(async () => { await Promise.resolve(); await new Promise((done) => setTimeout(done, 0)); }); };
const click = async (node) => { await act(async () => node.click()); await flush(); };
const change = async (node, value) => {
  const prototype = node instanceof window.HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(node, value);
  const propsKey = Object.keys(node).find((key) => key.startsWith("__reactProps$"));
  assert.ok(propsKey, "React props should be attached to the form control");
  await act(async () => {
    node[propsKey].onChange({ target: node, currentTarget: node });
  });
  await flush();
};

test("Web 场地提现结果未知后遇到撤权刷新，清除旧来源但仍以原冻结命令安全重试", async () => {
  const dom = new JSDOM("<!doctype html><div id=app></div>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Event: dom.window.Event,
    InputEvent: dom.window.InputEvent,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true
  });
  const personal = { accountId: "personal", sourceType: "PERSON", label: "个人账户", balanceCents: "10000" };
  const venue = { accountId: "venue", sourceType: "VENUE", venueId: "venue-1", label: "已授权场地", balanceCents: "5000" };
  const draft = { id: "draft-1", kind: "WITHDRAWAL", status: "DRAFT", version: 1, createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z" };
  const attachments = [
    { attachmentId: "support", purpose: "SUPPORTING_DOCUMENT", createdAt: draft.createdAt, versions: [{ versionId: "support-v1", versionNo: 1, status: "READY", originalFilename: "support.png", declaredMediaType: "image/png", declaredSizeBytes: 8, createdAt: draft.createdAt }] },
    { attachmentId: "screenshot", purpose: "APPLICATION_SCREENSHOT", createdAt: draft.createdAt, versions: [{ versionId: "screenshot-v1", versionNo: 1, status: "READY", originalFilename: "screenshot.png", declaredMediaType: "image/png", declaredSizeBytes: 8, createdAt: draft.createdAt }] }
  ];
  let sourceReads = 0;
  let submits = 0;
  const submitBodies = [];
  const client = {
    listWithdrawalSources: async () => sourceReads++ === 0 ? [personal, venue] : [personal],
    listOwnFinanceDrafts: async () => [draft],
    listOwnWithdrawals: async () => [],
    getOwnFinanceDraft: async () => draft,
    listFinanceDocumentAttachments: async () => ({ documentId: draft.id, attachments }),
    createWithdrawalSubmitSubmission: (input) => ({ ...input, idempotencyKey: "web-key-1" }),
    submitWithdrawal: async (submission) => {
      submitBodies.push(submission);
      submits += 1;
      if (submits === 1) throw new Error("network uncertain");
      return { id: draft.id, status: "PENDING_TRANSFER", version: 2, replay: true };
    }
  };
  const root = createRoot(document.querySelector("#app"));
  try {
    const { PersonalWithdrawalPanel } = compiled.module;
    await act(async () => root.render(React.createElement(PersonalWithdrawalPanel, { client, active: true, busy: false, run: async (work) => work(), onUnconfirmedChange() {}, onDataMayChange() {} })));
    await flush();
    assert.match(document.body.textContent, /已授权场地/);
    await click([...document.querySelectorAll("button")].find((node) => node.textContent === "继续填写"));
    const source = document.querySelector('[aria-label="支出来源"]');
    await change(source, "venue");
    assert.equal(source.value, "venue");
    const textInputs = [...document.querySelectorAll('input:not([type="radio"]):not([type="file"])')];
    await change(textInputs[0], "20.00");
    await change(textInputs[1], "张老师");
    await change(textInputs[2], "6222020000000000");
    for (const radio of document.querySelectorAll('input[type="radio"]')) await click(radio);
    await act(async () => document.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
    await flush();
    assert.match(document.body.textContent, /尚不能确认提交结果/);
    await click([...document.querySelectorAll("button")].find((node) => node.textContent === "刷新提现记录"));
    assert.equal(source.value, "");
    assert.equal([...source.options].some((option) => option.textContent.includes("已授权场地")), false);
    await click([...document.querySelectorAll("button")].find((node) => node.textContent === "安全重试原提现申请"));
    assert.deepEqual(submitBodies, [
      { documentId: "draft-1", expectedVersion: 1, sourceAccountId: "venue", amountCents: "2000", recipientName: "张老师", bankAccount: "6222020000000000", attachmentVersionIds: ["support-v1", "screenshot-v1"], idempotencyKey: "web-key-1" },
      { documentId: "draft-1", expectedVersion: 1, sourceAccountId: "venue", amountCents: "2000", recipientName: "张老师", bankAccount: "6222020000000000", attachmentVersionIds: ["support-v1", "screenshot-v1"], idempotencyKey: "web-key-1" }
    ]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
