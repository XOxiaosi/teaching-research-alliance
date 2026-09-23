import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ApiClientError } from "@teaching-research-alliance/client";

let AuthenticationPanel;
let AccountAccessPanel;
let canManageAccounts;
let tempDirectory;

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const deferred = () => { let resolve; let reject; const promise = new Promise((accept, refuse) => { resolve = accept; reject = refuse; }); return { promise, resolve, reject }; };
const propsOf = (node) => node[Object.keys(node).find((key) => key.startsWith("__reactProps$"))];
const session = (subject = "SYSTEM_ADMIN", patch = {}) => ({
  sessionId: "session-1",
  accountId: "account-1",
  personId: "person-1",
  roleContexts: [{ subject, scope: "GLOBAL", personId: "person-1", ...patch }],
  currentRoleContext: { subject, scope: "GLOBAL", personId: "person-1", ...patch },
});
const account = (id, nickname = "成员甲") => ({
  accountId: id,
  personId: `person-${id}`,
  nickname,
  phoneNormalized: "13800000000",
  loginStatus: "ACTIVE",
  personStatus: "ACTIVE",
  activeSystemAuthorities: [],
});

test.before(async () => {
  tempDirectory = await mkdtemp(resolve(import.meta.dirname, ".account-access-web-"));
  const output = resolve(tempDirectory, "panel.mjs");
  await build({
    entryPoints: [resolve(import.meta.dirname, "../src/account-access-panel.tsx")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: output,
    external: ["react", "react-dom", "@teaching-research-alliance/client"],
  });
  ({ AccountAuthenticationPanel: AuthenticationPanel, AccountAccessPanel, canManageAccounts } = await import(output));
});
test.after(async () => { await rm(tempDirectory, { recursive: true, force: true }); });

async function mount(element) {
  const dom = new JSDOM("<div id='host'></div>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const host = dom.window.document.querySelector("#host");
  const root = createRoot(host);
  await act(async () => root.render(element));
  await flush();
  return {
    host,
    render: async (next) => { await act(async () => root.render(next)); await flush(); },
    input: async (label, value) => {
      const node = host.querySelector(`[aria-label="${label}"]`);
      assert.ok(node, label);
      await act(async () => propsOf(node).onChange({ target: { value } }));
    },
    submit: async () => {
      const form = host.querySelector("form");
      assert.ok(form);
      await act(async () => propsOf(form).onSubmit({ preventDefault() {} }));
      await flush();
    },
    close: async () => { await act(async () => root.unmount()); dom.window.close(); },
  };
}

test("注册只调用普通字段，确认密码在前端阻止不一致请求", async () => {
  const registrations = [];
  const loggedIn = [];
  const client = {
    registerAccount: async (draft) => { registrations.push(draft); return session("TEACHER", { scope: "SELF" }); },
    login: async () => { throw new Error("not used"); },
  };
  const ui = await mount(React.createElement(AuthenticationPanel, {
    client,
    busy: false,
    run: (action) => { void action().catch(() => {}); },
    onAuthenticated: async () => { loggedIn.push(true); },
  }));
  try {
    await act(async () => [...ui.host.querySelectorAll("button")].find((node) => node.textContent === "注册普通老师账户").click());
    await ui.input("注册昵称", "新老师");
    await ui.input("注册姓名", "合成姓名");
    await ui.input("手机号", "13800000000");
    await ui.input("密码", "pass1234");
    await ui.input("确认密码", "different");
    await ui.submit();
    assert.equal(registrations.length, 0);
    assert.match(ui.host.textContent, /两次输入的密码不一致/);
    await ui.input("确认密码", "pass1234");
    await ui.submit();
    await flush();
    assert.deepEqual(registrations, [{ nickname: "新老师", legalName: "合成姓名", phoneNormalized: "13800000000", password: "pass1234" }]);
    assert.equal(loggedIn.length, 1);
    assert.equal(ui.host.querySelector('[aria-label="密码"]').value, "");
    assert.equal(ui.host.querySelector('[aria-label="确认密码"]').value, "");
  } finally { await ui.close(); }
});

test("注册 5xx 结果未确认不重复注册，保留填写内容供同凭据登录确认", async () => {
  let registrations = 0;
  let logins = 0;
  const client = {
    registerAccount: async () => { registrations += 1; throw new ApiClientError(500, "INTERNAL_ERROR"); },
    login: async () => { logins += 1; return session("TEACHER", { scope: "SELF" }); },
  };
  const ui = await mount(React.createElement(AuthenticationPanel, {
    client,
    busy: false,
    run: (action) => { void action().catch(() => {}); },
    onAuthenticated: async () => {},
  }));
  try {
    await act(async () => [...ui.host.querySelectorAll("button")].find((node) => node.textContent === "注册普通老师账户").click());
    await ui.input("注册昵称", "新老师");
    await ui.input("注册姓名", "合成姓名");
    await ui.input("手机号", "13800000000");
    await ui.input("密码", "pass1234");
    await ui.input("确认密码", "pass1234");
    await ui.submit();
    await flush();
    assert.equal(registrations, 1);
    assert.match(ui.host.textContent, /注册结果尚未确认/);
    assert.equal(ui.host.querySelector('[aria-label="手机号"]').value, "13800000000");
    assert.equal(ui.host.querySelector('[aria-label="密码"]').value, "pass1234");
    const registerButton = [...ui.host.querySelectorAll("button")].find((node) => node.textContent === "注册普通老师账户");
    assert.equal(registerButton.disabled, true);
    await act(async () => [...ui.host.querySelectorAll("button")].find((node) => node.textContent === "登录").click());
    assert.equal(ui.host.querySelector('[aria-label="手机号"]').value, "13800000000");
    assert.equal(ui.host.querySelector('[aria-label="密码"]').value, "pass1234");
    await ui.submit();
    await flush();
    assert.equal(registrations, 1);
    assert.equal(logins, 1);
  } finally { await ui.close(); }
});

test("账号管理仅对无附加范围的 GLOBAL 系统所有者或管理员可见", async () => {
  assert.equal(canManageAccounts(session("SYSTEM_ADMIN")), true);
  assert.equal(canManageAccounts(session("SYSTEM_OWNER")), true);
  assert.equal(canManageAccounts(session("TEACHER", { scope: "SELF" })), false);
  assert.equal(canManageAccounts(session("SYSTEM_ADMIN", { scope: "REGION", regionId: "region" })), false);
  assert.equal(canManageAccounts(session("SYSTEM_OWNER", { campusId: "campus" })), false);

  let loads = 0;
  const ui = await mount(React.createElement(AccountAccessPanel, {
    client: { hasRoleContext: true, listAccounts: async () => { loads += 1; return [account("target")]; } },
    session: session("SYSTEM_ADMIN", { scope: "REGION", regionId: "region" }),
    sessionKey: "scoped",
    active: true,
    onInvalidated() {},
    onSelfPasswordReset() {},
  }));
  try {
    assert.equal(ui.host.textContent, "");
    assert.equal(loads, 0);
  } finally { await ui.close(); }
});

test("未知重置结果锁定字段并以同一冻结命令重试，确定拒绝才释放", async () => {
  const commands = [];
  let attempts = 0;
  const frozen = { draft: Object.freeze({ accountId: "target", newPassword: "new-password", reason: "现场核验" }), idempotencyKey: "same-key" };
  const client = {
    hasRoleContext: true,
    currentSession: session(),
    listAccounts: async () => [account("target")],
    createAccountPasswordResetSubmission: (draft) => {
      assert.deepEqual(draft, frozen.draft);
      return frozen;
    },
    resetAccountPassword: async (command) => {
      commands.push(command);
      if (++attempts === 1) throw new ApiClientError(500, "INTERNAL_ERROR");
      return { accountId: "target", personId: "person-target", authVersion: "2", resetAt: "now", replay: true };
    },
  };
  const ui = await mount(React.createElement(AccountAccessPanel, {
    client, session: session(), sessionKey: "one", active: true, onInvalidated() {}, onSelfPasswordReset() {},
  }));
  try {
    await ui.input("目标账号", "target");
    await ui.input("新密码", "new-password");
    await ui.input("确认新密码", "new-password");
    await ui.input("重置理由", "现场核验");
    await ui.submit();
    assert.match(ui.host.textContent, /结果尚未确认/);
    assert.equal(ui.host.querySelector("fieldset").disabled, true);
    await ui.submit();
    assert.equal(commands.length, 2);
    assert.strictEqual(commands[0], commands[1]);
    assert.match(ui.host.textContent, /未重复执行/);
    assert.equal(ui.host.querySelector('[aria-label="新密码"]').value, "");
  } finally { await ui.close(); }
});

test("重置 4xx 为确定拒绝，清空密码并释放后续新提交", async () => {
  const submissions = [];
  const client = {
    hasRoleContext: true,
    currentSession: session(),
    listAccounts: async () => [account("target")],
    createAccountPasswordResetSubmission: (draft) => {
      const command = { draft: Object.freeze({ ...draft }), idempotencyKey: `key-${submissions.length + 1}` };
      submissions.push(command);
      return command;
    },
    resetAccountPassword: async () => { throw new ApiClientError(409, "IDEMPOTENCY_REPLAY"); },
  };
  const ui = await mount(React.createElement(AccountAccessPanel, {
    client, session: session(), sessionKey: "one", active: true, onInvalidated() {}, onSelfPasswordReset() {},
  }));
  try {
    await ui.input("目标账号", "target");
    await ui.input("新密码", "new-password");
    await ui.input("确认新密码", "new-password");
    await ui.input("重置理由", "现场核验");
    await ui.submit();
    assert.match(ui.host.textContent, /请求已被服务器拒绝/);
    assert.equal(ui.host.querySelector('[aria-label="新密码"]').value, "");
    assert.equal(ui.host.querySelector("fieldset").disabled, false);
    await ui.input("新密码", "new-password-2");
    await ui.input("确认新密码", "new-password-2");
    await ui.submit();
    assert.equal(submissions.length, 2);
    assert.notEqual(submissions[0].idempotencyKey, submissions[1].idempotencyKey);
  } finally { await ui.close(); }
});

test("本人重置清空会话回调，身份切换不保留旧目录或密码", async () => {
  const oldDirectory = deferred();
  const newDirectory = deferred();
  let reads = 0;
  const selfResets = [];
  const client = {
    hasRoleContext: true,
    currentSession: session(),
    listAccounts: () => ++reads === 1 ? oldDirectory.promise : newDirectory.promise,
    createAccountPasswordResetSubmission: (draft) => ({ draft: Object.freeze({ ...draft }), idempotencyKey: "self-key" }),
    resetAccountPassword: async () => {
      client.currentSession = null;
      return { accountId: "account-1", personId: "person-1", authVersion: "2", resetAt: "now", replay: false };
    },
  };
  const props = (activeSession, key) => React.createElement(AccountAccessPanel, {
    client, session: activeSession, sessionKey: key, active: true, onInvalidated() {}, onSelfPasswordReset: () => selfResets.push(true),
  });
  const ui = await mount(props(session(), "old"));
  try {
    await ui.render(props(session("SYSTEM_OWNER", { personId: "owner" }), "new"));
    await act(async () => oldDirectory.resolve([account("old", "旧管理员")])) ; await flush();
    assert.equal(ui.host.textContent.includes("旧管理员"), false);
    await act(async () => newDirectory.resolve([account("account-1", "新所有者")])) ; await flush();
    assert.match(ui.host.textContent, /新所有者/);
    await ui.input("目标账号", "account-1");
    await ui.input("新密码", "self-password");
    await ui.input("确认新密码", "self-password");
    await ui.input("重置理由", "本人重新设置密码");
    await ui.submit();
    assert.equal(selfResets.length, 1);
    assert.equal(ui.host.querySelector('[aria-label="新密码"]').value, "");
    assert.equal(ui.host.querySelector('[aria-label="确认新密码"]').value, "");
  } finally { await ui.close(); }
});
