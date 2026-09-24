import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ApiClientError } from "@teaching-research-alliance/client";

let Panel; let canManagePersonnel; let directory;
const flush = () => act(async () => { await new Promise((done) => setTimeout(done, 0)); });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const propsOf = (node) => node[Object.keys(node).find((key) => key.startsWith("__reactProps$"))];
const session = (subject = "SYSTEM_ADMIN", patch = {}) => ({ sessionId: "s", accountId: "a", personId: "actor", currentRoleContext: { subject, scope: "GLOBAL", personId: "actor", ...patch }, roleContexts: [] });
const person = (nickname = "成员甲") => ({ accountId: "a2", personId: "p2", nickname, legalName: "真实姓名", profileVersion: "1", phoneNormalized: "13800000000", loginStatus: "ACTIVE", personStatus: "ACTIVE", responsibilities: [] });

test.before(async () => { directory = await mkdtemp(resolve(import.meta.dirname, ".people-panel-")); const outfile = resolve(directory, "panel.mjs"); await build({ entryPoints: [resolve(import.meta.dirname, "../src/person-responsibility-panel.tsx")], bundle: true, platform: "node", format: "esm", outfile, external: ["react", "react-dom", "@teaching-research-alliance/client"] }); ({ PersonResponsibilityPanel: Panel, canManagePersonnel } = await import(outfile)); });
test.after(async () => { await rm(directory, { recursive: true, force: true }); });

async function mount(element) { const dom = new JSDOM("<div id='host'></div>", { url: "http://localhost" }); Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true }); const host = document.querySelector("#host"); const root = createRoot(host); await act(async () => root.render(element)); await flush(); return { host, render: async (next) => { await act(async () => root.render(next)); await flush(); }, input: async (label, value) => { const node = host.querySelector(`[aria-label='${label}']`); assert.ok(node); await act(async () => propsOf(node).onChange({ target: { value } })); }, submit: async () => { const form = host.querySelector("form"); await act(async () => propsOf(form).onSubmit({ preventDefault() {} })); await flush(); }, close: async () => { await act(async () => root.unmount()); dom.window.close(); } }; }

test("严格 GLOBAL 管理身份可见；管理员不显示管理员任命，开发者可见", () => {
  assert.equal(canManagePersonnel(session("SYSTEM_ADMIN")), true);
  assert.equal(canManagePersonnel(session("SYSTEM_OWNER")), true);
  assert.equal(canManagePersonnel(session("SYSTEM_ADMIN", { scope: "REGION", regionId: "r" })), false);
});

test("迟到目录不会覆盖新身份的目录", async () => {
  const old = deferred();
  const client = { hasRoleContext: true, listPeople: async () => old.promise };
  const ui = await mount(React.createElement(Panel, { client, session: session(), sessionKey: "old", active: true, onInvalidated() {} }));
  try {
    client.listPeople = async () => [person("新身份成员")];
    await ui.render(React.createElement(Panel, { client, session: session(), sessionKey: "new", active: true, onInvalidated() {} }));
    old.resolve([person("旧身份成员")]); await flush();
    assert.match(ui.host.textContent, /新身份成员/); assert.doesNotMatch(ui.host.textContent, /旧身份成员/);
  } finally { await ui.close(); }
});

test("5xx 后以同一冻结任命提交重试", async () => {
  const frozen = { draft: { personId: "p2", subject: "HEADQUARTERS_FINANCE", scope: "GLOBAL", validFrom: "2026-09-23T00:00:00.000Z", reason: "排班" }, idempotencyKey: "same" };
  const received = []; let attempts = 0;
  const client = { hasRoleContext: true, listPeople: async () => [person()], createRoleAssignmentSubmission: (draft) => { received.push(draft); return frozen; }, assignRole: async (submission) => { assert.equal(submission, frozen); attempts += 1; if (attempts === 1) throw new ApiClientError(500, "INTERNAL_ERROR"); return { replay: true }; } };
  const ui = await mount(React.createElement(Panel, { client, session: session("SYSTEM_OWNER"), sessionKey: "owner", active: true, onInvalidated() {} }));
  try {
    await ui.input("人员职责变更理由", "排班"); await ui.submit();
    assert.match(ui.host.textContent, /结果尚未确认/);
    const retry = [...ui.host.querySelectorAll("button")].find((node) => node.textContent === "安全重试原操作"); assert.ok(retry); await act(async () => retry.click()); await flush();
    assert.equal(attempts, 2); assert.equal(received.length, 1); assert.match(received[0].validFrom, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/); assert.deepEqual({ ...received[0], validFrom: undefined }, { ...frozen.draft, validFrom: undefined }); assert.match(ui.host.textContent, /未重复执行/);
  } finally { await ui.close(); }
});

test("管理员可查看系统身份但没有编辑路径；派生和业务身份仅只读", async () => {
  const assignment = (subject) => ({ assignmentId: subject, subject, scope: "GLOBAL", validFrom: "2000-01-01T00:00:00.000Z", reason: null, createdByPersonId: "owner" });
  const target = { ...person("系统成员"), responsibilities: [assignment("SYSTEM_ADMIN"), assignment("TEACHER"), assignment("TEACHING_TEACHER"), assignment("ACADEMIC_PLANNER"), assignment("VENUE_OWNER")] };
  const ui = await mount(React.createElement(Panel, { client: { hasRoleContext: true, listPeople: async () => [target] }, session: session("SYSTEM_ADMIN"), sessionKey: "protected", active: true, onInvalidated() {} }));
  try {
    assert.match(ui.host.textContent, /系统管理员/); assert.match(ui.host.textContent, /仅开发者可管理系统身份/);
    for (const text of ["撤销职责", "停用人员并注销会话", "确认任命"]) assert.equal([...ui.host.querySelectorAll("button")].some((node) => node.textContent === text), false);
  } finally { await ui.close(); }
});

test("任命候选不包含基础、授课、规划或场地派生身份", async () => {
  const ui = await mount(React.createElement(Panel, { client: { hasRoleContext: true, listPeople: async () => [person()] }, session: session("SYSTEM_OWNER"), sessionKey: "candidates", active: true, onInvalidated() {} }));
  try {
    const choices = [...ui.host.querySelector('[aria-label="职责"]').options].map((option) => option.textContent);
    for (const label of ["普通老师", "授课老师", "学业规划师", "场地运营"]) assert.equal(choices.includes(label), false);
  } finally { await ui.close(); }
});

test("未来系统任命仍保护目标，零长度已取消记录不保护", async () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const later = new Date(Date.now() + 172800000).toISOString();
  const system = (validTo) => ({ assignmentId: "admin", subject: "SYSTEM_ADMIN", scope: "GLOBAL", validFrom: future, ...(validTo === undefined ? {} : { validTo }), reason: null, createdByPersonId: "owner" });
  const client = { hasRoleContext: true, listPeople: async () => [{ ...person("系统成员"), responsibilities: [system(later)] }] };
  const ui = await mount(React.createElement(Panel, { client, session: session("SYSTEM_ADMIN"), sessionKey: "future-system", active: true, onInvalidated() {} }));
  try {
    assert.match(ui.host.textContent, /仅开发者可管理系统身份/);
    client.listPeople = async () => [{ ...person("已取消成员"), responsibilities: [system(future)] }];
    await ui.render(React.createElement(Panel, { client, session: session("SYSTEM_ADMIN"), sessionKey: "cancelled-system", active: true, onInvalidated() {} }));
    assert.equal([...ui.host.querySelectorAll("button")].some((node) => node.textContent === "确认任命"), true);
  } finally { await ui.close(); }
});

test("资料更正入口最小化字段，并在未知结果时重试同一 submission", async () => {
  const frozen = { draft: { personId: "p2", nickname: "新昵称", legalName: "新姓名", expectedProfileVersion: "1", reason: "资料核对" }, idempotencyKey: "profile-key" };
  const submissions = []; let attempts = 0;
  const client = { hasRoleContext: true, listPeople: async () => [person()], createPersonProfileSubmission: (draft) => { submissions.push(draft); return frozen; }, updatePersonProfile: async (submission) => { assert.equal(submission, frozen); if (++attempts === 1) throw new ApiClientError(500, "INTERNAL_ERROR"); return { replay: true }; } };
  const ui = await mount(React.createElement(Panel, { client, session: session("SYSTEM_OWNER"), sessionKey: "profile", active: true, onInvalidated() {} }));
  try {
    assert.match(ui.host.textContent, /人员资料/); assert.doesNotMatch(ui.host.textContent, /13800000000/);
    await ui.input("展示昵称", "新昵称"); await ui.input("真实姓名", "新姓名"); await ui.input("人员职责变更理由", "资料核对");
    const save = [...ui.host.querySelectorAll("button")].find((node) => node.textContent === "保存人员资料"); assert.ok(save); await act(async () => save.click()); await flush();
    assert.match(ui.host.textContent, /结果尚未确认/); const retry = [...ui.host.querySelectorAll("button")].find((node) => node.textContent === "安全重试原操作"); assert.ok(retry); await act(async () => retry.click()); await flush();
    assert.equal(attempts, 2); assert.equal(submissions.length, 1); assert.match(ui.host.textContent, /人员编号、账户和职责未变化/); assert.equal(ui.host.querySelector("[aria-label='展示昵称']").disabled, false); assert.equal([...ui.host.querySelectorAll("button")].find((node) => node.textContent === "保存人员资料").disabled, false);
  } finally { await ui.close(); }
});
