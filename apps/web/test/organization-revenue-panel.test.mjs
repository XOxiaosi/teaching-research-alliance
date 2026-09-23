import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import test from "node:test";
import { canReadOrganizationRevenue, organizationRevenueErrorMessage } from "../dist/organization-revenue-panel.js";
import { ApiClientError } from "../../../packages/client/dist/index.js";

const rootDir = resolve(import.meta.dirname, "..");
let bundled;
const panel = async () => {
  if (bundled) return bundled;
  const dir = await mkdtemp(resolve(import.meta.dirname, ".organization-revenue-"));
  const out = resolve(dir, "panel.mjs");
  await build({ entryPoints: [resolve(rootDir, "src/organization-revenue-panel.tsx")], bundle: true, format: "esm", platform: "node", outfile: out, external: ["react", "react-dom/client", "@teaching-research-alliance/client"] });
  bundled = { dir, module: await import(`file://${out}?${Date.now()}`) };
  return bundled;
};

const session = (context) => ({ sessionId: "session", accountId: "account", personId: "person", currentRoleContext: context, roleContexts: context === null ? [] : [context] });
const globalContext = { subject: "SYSTEM_ADMIN", scope: "GLOBAL" };
const campusContext = { subject: "CAMPUS_PRINCIPAL", scope: "CAMPUS", campusId: "campus-1" };
const revenue = (scope, campusName, management = "200", regionIncome = "100") => ({
  scope,
  period: { fromMonth: "2026-10-01", toMonth: "2026-10-01", asOf: "2026-10-31T00:00:00.000Z", mode: "LATEST_EFFECTIVE_SNAPSHOT" },
  campuses: [{ campusId: "campus-1", campusName, attributedRegionId: "region-1", attributedRegionName: "华东区", recordedGrossRevenueCents: "10000", refundedGrossRevenueCents: "2000", effectiveGrossRevenueCents: "8000", campusManagementFeeCents: management }],
  regions: [{ regionId: "region-1", regionName: "华东区", recordedGrossRevenueCents: "10000", refundedGrossRevenueCents: "2000", effectiveGrossRevenueCents: "8000", campusManagementFeeCents: management, regionFinanceIncomeCents: regionIncome }],
  total: { recordedGrossRevenueCents: "10000", refundedGrossRevenueCents: "2000", effectiveGrossRevenueCents: "8000", campusManagementFeeCents: management, regionFinanceIncomeCents: regionIncome }
});
const deferred = () => { let resolveRequest; let rejectRequest; return { promise: new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; }), resolve: resolveRequest, reject: rejectRequest }; };
const flush = async (act) => act(async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); });
const changeMonth = async (act, element, value, dom) => act(async () => {
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(element, value);
  element._valueTracker?.setValue("");
  element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  element.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
});

test.after(async () => { if (bundled) await rm(bundled.dir, { recursive: true, force: true }); });

test("组织营收只接受严格的总部、分区或校区范围", () => {
  assert.equal(canReadOrganizationRevenue(globalContext), true);
  assert.equal(canReadOrganizationRevenue({ subject: "HEADQUARTERS_FINANCE", scope: "GLOBAL", campusId: "extra" }), false);
  assert.equal(canReadOrganizationRevenue({ subject: "REGION_FINANCE", scope: "REGION", regionId: "region-1" }), true);
  assert.equal(canReadOrganizationRevenue({ subject: "REGION_FINANCE", scope: "REGION", regionId: "region-1", campusId: "extra" }), false);
  assert.equal(canReadOrganizationRevenue(campusContext), true);
  assert.equal(canReadOrganizationRevenue({ subject: "CAMPUS_PRINCIPAL", scope: "CAMPUS", campusId: "campus-1", regionId: "extra" }), false);
  assert.equal(canReadOrganizationRevenue({ subject: "TEACHING_TEACHER", scope: "PERSON" }), false);
  assert.equal(organizationRevenueErrorMessage(new ApiClientError(403, "FORBIDDEN_SCOPE")), "当前身份没有读取组织营收的权限。");
  assert.equal(organizationRevenueErrorMessage(new Error("network")), "组织营收读取失败，请稍后重试。");
});

test("组织营收加载时清空旧期间，迟到响应不能越过新期间或校区视角", async () => {
  const { module } = await panel();
  const requests = [];
  const client = { getOrganizationRevenue: (filter) => { const request = deferred(); requests.push({ filter, request }); return request.promise; } };
  const dom = new JSDOM("<div id=app></div>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const { default: React, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const host = document.querySelector("#app");
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(module.OrganizationRevenuePanel, { client, session: session(globalContext), sessionKey: "global" })));
    await flush(act);
    assert.equal(requests.length, 1);
    assert.ok(host.textContent.includes("正在读取组织营收"));
    const from = host.querySelector('[aria-label="营收起始月份"]');
    const to = host.querySelector('[aria-label="营收结束月份"]');
    const nextMonth = requests[0].filter.fromMonth === "2026-10-01" ? "2026-11" : "2026-10";
    await changeMonth(act, from, nextMonth, dom);
    await changeMonth(act, to, nextMonth, dom);
    await flush(act);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].filter, { fromMonth: `${nextMonth}-01`, toMonth: `${nextMonth}-01` });
    await act(async () => requests[0].request.resolve(revenue({ scope: "GLOBAL" }, "过期校区")));
    await flush(act);
    assert.equal(host.textContent.includes("过期校区"), false);
    await act(async () => requests[1].request.resolve(revenue({ scope: "GLOBAL" }, "新校区")));
    await flush(act);
    assert.ok(host.textContent.includes("新校区"));
    assert.ok(host.textContent.includes("录入课时总额100.00 欢乐豆"));
    assert.ok(host.textContent.includes("退款额20.00 欢乐豆"));
    assert.ok(host.textContent.includes("有效营收80.00 欢乐豆"));
    assert.ok(host.textContent.includes("校区管理费2.00 欢乐豆"));
    assert.ok(host.textContent.includes("分区自身分润：1.00 欢乐豆"));

    await act(async () => root.render(React.createElement(module.OrganizationRevenuePanel, { client, session: session(campusContext), sessionKey: "campus" })));
    await flush(act);
    assert.equal(host.textContent.includes("新校区"), false);
    assert.equal(requests.length, 3);
    await act(async () => requests[2].request.resolve(revenue({ scope: "GLOBAL" }, "校区数据", "200", "99900")));
    await flush(act);
    assert.ok(host.textContent.includes("校区数据"));
    assert.equal(host.textContent.includes("分区营收"), false);
    assert.equal(host.textContent.includes("999.00"), false);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("组织营收权限失效通知父界面并清理数据", async () => {
  const { module } = await panel();
  const dom = new JSDOM("<div id=auth></div>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const { default: React, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { RoleSelectionRequiredError } = await import("@teaching-research-alliance/client");
  const host = document.querySelector("#auth"); const root = createRoot(host); let invalidated = 0;
  const client = { hasRoleContext: false, getOrganizationRevenue: async () => { throw new RoleSelectionRequiredError("FORBIDDEN_SCOPE"); } };
  try {
    await act(async () => root.render(React.createElement(module.OrganizationRevenuePanel, { client, session: session(campusContext), sessionKey: "expired", onInvalidated: () => { invalidated++; } })));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(invalidated, 1); assert.equal(host.textContent.includes("范围内课时营收汇总"), false);
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});
