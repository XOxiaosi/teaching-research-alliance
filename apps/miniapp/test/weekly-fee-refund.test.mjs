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
const session = {
  sessionId: "refund-mini-session", accountId: "refund-account", personId: "refund-person",
  roleContexts: [{ subject: "TEACHING_TEACHER", personId: "refund-person", scope: "SELF" }],
  currentRoleContext: { subject: "TEACHING_TEACHER", personId: "refund-person", scope: "SELF" }
};
const weeks = [
  { weekId: "week-1", periodLabel: "第 1 周", startsOn: "2026-09-01", endsOn: "2026-09-07", settlementMonth: "2026-09-01" },
  { weekId: "week-2", periodLabel: "第 2 周", startsOn: "2026-09-08", endsOn: "2026-09-14", settlementMonth: "2026-09-01" }
];
const venues = [{ id: "venue-1", name: "演示场地", isOwn: true }];
const response = (data) => ({ statusCode: 200, data: { version: "test", data } });

const taroPlugin = {
  name: "weekly-fee-refund-taro",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@tarojs\/taro$/ }, () => ({ path: "refund-test-taro", namespace: "refund-test" }));
    pluginBuild.onResolve({ filter: /^@tarojs\/components$/ }, () => ({ path: "refund-test-components", namespace: "refund-test" }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "refund-test" }, (args) => ({
      loader: "js",
      contents: args.path === "refund-test-taro"
        ? "const taro=new Proxy({}, {get: (_target,key) => (...args) => globalThis.__refundTaro[key](...args)}); export default taro;"
        : `import React from "react";
           export const View=({children,...props})=>React.createElement("div",props,children);
           export const Text=({children,...props})=>React.createElement("span",props,children);
           export const Image=({src,...props})=>React.createElement("img",{...props,src});
           export const Button=({children,...props})=>React.createElement("button",props,children);
           export const Input=({password,maxlength,onInput,...props})=>React.createElement("input",{...props,...(maxlength===undefined?{}:{maxLength:maxlength}),onInput:(event)=>onInput?.({detail:{value:event.currentTarget.value}})});
           export const Textarea=({maxlength,onInput,...props})=>React.createElement("textarea",{...props,...(maxlength===undefined?{}:{maxLength:maxlength}),onInput:(event)=>onInput?.({detail:{value:event.currentTarget.value}})});
           export const Picker=({children,range=[],value=0,onChange,disabled,...props})=>React.createElement("div",props,React.createElement("select",{disabled,value:String(value),onChange:(event)=>onChange?.({detail:{value:event.currentTarget.value}})},range.map((item,index)=>React.createElement("option",{key:index,value:String(index)},String(item)))),children);
           export const ScrollView=({children,scrollY,...props})=>React.createElement("div",props,children);`
    }));
  }
};

const bundleIndex = async () => {
  const directory = await mkdtemp(resolve(testDirectory, ".weekly-fee-refund-test-"));
  const output = resolve(directory, "index-page.mjs");
  await build({
    entryPoints: [resolve(miniappDirectory, "src/pages/index/index.tsx")], bundle: true, format: "esm", platform: "node", outfile: output,
    define: { __API_BASE_URL__: JSON.stringify("http://127.0.0.1:3100") }, external: ["react", "@teaching-research-alliance/client"],
    loader: { ".css": "empty" }, plugins: [taroPlugin]
  });
  return { directory, module: await import(`${pathToFileURL(output).href}?${Date.now()}`) };
};
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
  });
};
const button = (container, label, index = 0) => {
  const matches = [...container.querySelectorAll("button")].filter((element) => element.textContent === label);
  assert.ok(matches[index], `button ${label} should exist`);
  return matches[index];
};
const click = async (element) => {
  await act(async () => { element.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
  await flush();
};
const input = async (element, value) => {
  await act(async () => { element.value = value; element.dispatchEvent(new window.Event("input", { bubbles: true })); });
  await flush();
};
const withDom = async (work) => {
  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
  try { await work(dom.window.document.querySelector("#app")); } finally { dom.window.close(); }
};
const feeInput = (container) => {
  const field = [...container.querySelectorAll("input")].find((element) => element.value === "1234.00");
  assert.ok(field, "refunded fee amount should be visible");
  return field;
};

const mountIndex = async ({ initiallyRefunded, refundOnSave, roleContext = session.currentRoleContext, venueList = venues, feeVenueId = "venue-1" }) => {
  const bundled = await bundleIndex();
  let refunded = initiallyRefunded;
  let saves = 0;
  const submissions = [];
  const activeSession = { ...session, roleContexts: [roleContext], currentRoleContext: roleContext };
  const referrals = () => [
    { referralId: "referral-refunded", studentDisplayName: "退款学生", courseContextId: "数学", referralStatus: "ACCEPTED", version: 1, initialVenueId: feeVenueId, weeklyFees: [{ teachingWeekId: "week-1", grossAmountCents: "123400", version: 7, venueId: feeVenueId, ...(refunded ? { refundStatus: "REFUNDED" } : {}) }] },
    { referralId: "referral-other", studentDisplayName: "另一学生", courseContextId: "英语", referralStatus: "ACCEPTED", version: 1, initialVenueId: "venue-1", weeklyFees: [] }
  ];
  globalThis.__refundTaro = {
    request: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/v1/session" && request.method === "POST") return response(activeSession);
      if (path === "/v1/session" && request.method === "GET") return response(activeSession);
      if (path === "/v1/session/logout") return response({});
      if (path === "/v1/me") return response({ nickname: "退款测试老师", balanceCents: "10000", currentYearIncomeByCategory: {} });
      if (path === "/v1/teaching/referrals") return response(referrals());
      if (path === "/v1/teaching/weeks") return response(weeks);
      if (path === "/v1/venues/available") return response(venueList);
      if (path === "/v1/venues/visible") return response(venueList);
      if (path === "/v1/finance/withdrawals/sources" || path === "/v1/finance/withdrawals/mine" || path === "/v1/finance/drafts/mine") return response([]);
      if (path === "/v1/finance/reimbursements/mine" || path === "/v1/finance/reimbursements/managed") return response({ documents: [] });
      if (path === "/v1/referrals/referral-refunded/weekly-fees" && request.method === "POST") {
        saves += 1;
        submissions.push(request.data);
        if (refundOnSave) {
          refunded = true;
          return { statusCode: 409, data: { version: "test", error: { code: "WEEKLY_FEE_REFUNDED", message: "WEEKLY_FEE_REFUNDED" } } };
        }
      }
      throw new Error(`unexpected ${request.method} ${path}`);
    },
    showActionSheet: async () => ({ tapIndex: 0 }), chooseImage: async () => ({ tempFilePaths: [] }), chooseMessageFile: async () => ({ tempFiles: [] }),
    getFileSystemManager: () => ({ readFile: () => {} }), downloadFile: async () => ({ statusCode: 500 })
  };
  return { bundled, saves: () => saves, submissions };
};

const loginAndChooseRefundedFee = async (container) => {
  const loginInputs = [...container.querySelectorAll("input")];
  await input(loginInputs[0], "13800000000"); await input(loginInputs[1], "password");
  await click(button(container, "登录"));
  await click(button(container, "登记周费用", 0));
};

test("小程序退款周费用保留原金额，金额和场地锁定但学生与教学周仍可切换", async () => {
  const fixture = await mountIndex({ initiallyRefunded: true, refundOnSave: false });
  try {
    await withDom(async (container) => {
      const root = createRoot(container);
      await act(async () => { root.render(React.createElement(fixture.bundled.module.default)); });
      await flush();
      await loginAndChooseRefundedFee(container);
      const amount = feeInput(container);
      assert.equal(amount.disabled, true);
      assert.match(container.textContent, /这笔周费用已退款，保留原登记金额供核对，不能再修改。/);
      assert.equal(button(container, "已退款，不可修改").disabled, true);
      const weeklyPicker = [...container.querySelectorAll("select")].find((element) => element.textContent.includes("2026-09-01 至 2026-09-07"));
      const venuePicker = [...container.querySelectorAll("select")].find((element) => element.textContent.includes("演示场地"));
      assert.ok(weeklyPicker); assert.ok(venuePicker);
      assert.equal(weeklyPicker.disabled, false, "教学周可继续切换");
      assert.equal(venuePicker.disabled, true, "退款记录的场地不可改写");
      assert.equal(button(container, "登记周费用", 1).disabled, false, "仍可切换另一名学生");
      await act(async () => root.unmount());
    });
  } finally { await rm(fixture.bundled.directory, { recursive: true, force: true }); }
});

test("小程序历史场地更正提交与正常场地、占位选项切换", async () => {
  const activeFixture = await mountIndex({ initiallyRefunded: false, refundOnSave: false, venueList: [{ id: "venue-active", name: "新场地", isOwn: false }], feeVenueId: "venue-retired" });
  try {
    await withDom(async (container) => {
      const root = createRoot(container);
      await act(async () => { root.render(React.createElement(activeFixture.bundled.module.default)); });
      await flush(); await loginAndChooseRefundedFee(container);
      const venuePicker = [...container.querySelectorAll("select")].find((element) => element.textContent.includes("原登记场地"));
      assert.ok(venuePicker); assert.equal(venuePicker.value, "1");
      await click(button(container, "保存周累计费用"));
      assert.equal(activeFixture.submissions.at(-1).venueId, "venue-retired");
      await act(async () => { venuePicker.value = "2"; venuePicker.dispatchEvent(new window.Event("change", { bubbles: true })); });
      await flush(); assert.equal(venuePicker.value, "2"); assert.ok(container.textContent.includes("新场地"));
      await act(async () => { venuePicker.value = "0"; venuePicker.dispatchEvent(new window.Event("change", { bubbles: true })); });
      await flush(); assert.equal(venuePicker.value, "0");
      const savedCount = activeFixture.submissions.length;
      await click(button(container, "保存周累计费用"));
      assert.equal(activeFixture.submissions.length, savedCount, "选择占位符不能保存历史场地");
      await act(async () => root.unmount());
    });
  } finally { await rm(activeFixture.bundled.directory, { recursive: true, force: true }); }
});

test("小程序保存遇合成 WEEKLY_FEE_REFUNDED 后刷新退款状态并禁编辑", async () => {
  const fixture = await mountIndex({ initiallyRefunded: false, refundOnSave: true });
  try {
    await withDom(async (container) => {
      const root = createRoot(container);
      await act(async () => { root.render(React.createElement(fixture.bundled.module.default)); });
      await flush();
      await loginAndChooseRefundedFee(container);
      assert.equal(feeInput(container).disabled, false);
      await click(button(container, "保存周累计费用"));
      assert.equal(fixture.saves(), 1);
      assert.match(container.textContent, /这笔周费用已退款，不能再修改。/);
      await click(button(container, "登记周费用", 0));
      assert.equal(feeInput(container).disabled, true);
      assert.equal(button(container, "已退款，不可修改").disabled, true);
      await act(async () => root.unmount());
    });
  } finally { await rm(fixture.bundled.directory, { recursive: true, force: true }); }
});

test("小程序报销管理入口只对严格 GLOBAL 总部财务、管理员和系统所有者可见", async () => {
  const visible = ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"].map((subject) => ({ subject, personId: "refund-person", scope: "GLOBAL" }));
  const hidden = [
    { subject: "HEADQUARTERS_FINANCE", personId: "refund-person", scope: "REGION", regionId: "region-1" },
    { subject: "SYSTEM_ADMIN", personId: "refund-person", scope: "GLOBAL", regionId: "region-1" }
  ];
  for (const roleContext of visible) {
    const fixture = await mountIndex({ initiallyRefunded: false, refundOnSave: false, roleContext });
    try {
      await withDom(async (container) => {
        const root = createRoot(container);
        await act(async () => { root.render(React.createElement(fixture.bundled.module.default)); }); await flush();
        const inputs = [...container.querySelectorAll("input")]; await input(inputs[0], "13800000000"); await input(inputs[1], "password"); await click(button(container, "登录"));
        const panel = container.querySelector('[data-reimbursement-module="reimbursement"]');
        assert.ok(panel, `${roleContext.subject} GLOBAL should see reimbursement management`);
        assert.equal(panel.getAttribute("data-mode"), "managed");
        await act(async () => root.unmount());
      });
    } finally { await rm(fixture.bundled.directory, { recursive: true, force: true }); }
  }
  for (const roleContext of hidden) {
    const fixture = await mountIndex({ initiallyRefunded: false, refundOnSave: false, roleContext });
    try {
      await withDom(async (container) => {
        const root = createRoot(container);
        await act(async () => { root.render(React.createElement(fixture.bundled.module.default)); }); await flush();
        const inputs = [...container.querySelectorAll("input")]; await input(inputs[0], "13800000000"); await input(inputs[1], "password"); await click(button(container, "登录"));
        assert.equal(container.querySelector('[data-reimbursement-module="reimbursement"]'), null, `${roleContext.subject} non-strict scope must not see reimbursement management`);
        await act(async () => root.unmount());
      });
    } finally { await rm(fixture.bundled.directory, { recursive: true, force: true }); }
  }
});


test("小程序已有周费用可保留历史停用场地用于本笔更正", async () => {
  const fixture = await mountIndex({ initiallyRefunded: false, refundOnSave: false, venueList: [], feeVenueId: "venue-retired" });
  try {
    await withDom(async (container) => {
      const root = createRoot(container);
      await act(async () => { root.render(React.createElement(fixture.bundled.module.default)); });
      await flush();
      await loginAndChooseRefundedFee(container);
      const venuePicker = [...container.querySelectorAll("select")].find((element) => element.textContent.includes("原登记场地"));
      assert.ok(venuePicker);
      assert.match(venuePicker.textContent, /原登记场地（仅更正本笔）/);
      assert.equal(venuePicker.value, "1");
      assert.ok(container.textContent.includes("原登记场地（仅更正本笔）"));
      const weekPicker = [...container.querySelectorAll("select")].find((element) => element.textContent.includes("2026-09-08 至 2026-09-14"));
      assert.ok(weekPicker);
      await act(async () => { weekPicker.value = "1"; weekPicker.dispatchEvent(new window.Event("change", { bubbles: true })); });
      await flush();
      assert.equal(container.textContent.includes("原登记场地（仅更正本笔）"), false, "切换教学周清除历史场地选项");
      assert.equal(venuePicker.value, "0");
      await input(container.querySelector('input[placeholder="例如 1000.00"]'), "1500");
      await click(button(container, "保存周累计费用"));
      assert.equal(fixture.submissions.length, 0, "切换到无历史费用的新周并点击保存也不得带旧停用场地提交");
      await act(async () => root.unmount());
    });
  } finally { await rm(fixture.bundled.directory, { recursive: true, force: true }); }
});
