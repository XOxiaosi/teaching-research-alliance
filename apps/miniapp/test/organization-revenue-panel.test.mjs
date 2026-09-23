import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import test from "node:test";

const rootDir = resolve(import.meta.dirname, "..");
let bundled;
const plugin = { name: "organization-revenue-taro", setup(buildOptions) {
  buildOptions.onResolve({ filter: /^@tarojs\/components$/ }, () => ({ path: "components", namespace: "organization-revenue" }));
  buildOptions.onLoad({ filter: /.*/, namespace: "organization-revenue" }, () => ({ loader: "js", contents: `import React from 'react'; export const View=({children,...props})=>React.createElement('div',props,children); export const Text=({children,...props})=>React.createElement('span',props,children); export const Picker=({children,onChange,...props})=>React.createElement('div',props,React.createElement('button',{type:'button',onClick:()=>onChange?.({detail:{value:'2026-10'}})},children));` }));
} };
const panel = async () => {
  if (bundled) return bundled;
  const dir = await mkdtemp(resolve(import.meta.dirname, ".organization-revenue-"));
  const out = resolve(dir, "panel.mjs");
  await build({ entryPoints: [resolve(rootDir, "src/pages/index/organization-revenue-panel.tsx")], bundle: true, format: "esm", platform: "node", outfile: out, external: ["react", "react-dom/client", "@teaching-research-alliance/client"], plugins: [plugin] });
  bundled = { dir, module: await import(`file://${out}?${Date.now()}`) };
  return bundled;
};

const session = (context) => ({ sessionId: "session", accountId: "account", personId: "person", currentRoleContext: context, roleContexts: [context] });
const campusContext = { subject: "CAMPUS_PRINCIPAL", scope: "CAMPUS", campusId: "campus-1" };
const campusRevenue = { scope: { scope: "GLOBAL" }, period: { fromMonth: "2026-09-01", toMonth: "2026-09-01", asOf: "2026-09-30T00:00:00.000Z", mode: "LATEST_EFFECTIVE_SNAPSHOT" }, campuses: [{ campusId: "campus-1", campusName: "校区数据", attributedRegionId: "region-1", attributedRegionName: "华东区", recordedGrossRevenueCents: "10000", refundedGrossRevenueCents: "0", effectiveGrossRevenueCents: "10000", campusManagementFeeCents: "200" }], regions: [], total: { recordedGrossRevenueCents: "10000", refundedGrossRevenueCents: "0", effectiveGrossRevenueCents: "10000", campusManagementFeeCents: "200", regionFinanceIncomeCents: "99900" } };
const flush = async () => act(async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); });

test.after(async () => { if (bundled) await rm(bundled.dir, { recursive: true, force: true }); });

test("小程序组织营收只允许严格管理范围", async () => {
  const { module } = await panel();
  assert.equal(module.canReadMiniOrganizationRevenue({ subject: "SYSTEM_OWNER", scope: "GLOBAL" }), true);
  assert.equal(module.canReadMiniOrganizationRevenue({ subject: "SYSTEM_OWNER", scope: "GLOBAL", venueId: "extra" }), false);
  assert.equal(module.canReadMiniOrganizationRevenue({ subject: "REGION_FINANCE", scope: "REGION", regionId: "region-1" }), true);
  assert.equal(module.canReadMiniOrganizationRevenue({ subject: "REGION_FINANCE", scope: "REGION", regionId: "region-1", campusId: "extra" }), false);
  assert.equal(module.canReadMiniOrganizationRevenue(campusContext), true);
});

test("小程序校区视角加载后不显示分区自身分润，也不保留无权旧数据", async () => {
  const { module } = await panel();
  let resolveRequest;
  const client = { getOrganizationRevenue: () => new Promise((resolve) => { resolveRequest = resolve; }) };
  const dom = new JSDOM("<div id=app></div>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.querySelector("#app");
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(module.OrganizationRevenuePanel, { client, session: session(campusContext), sessionKey: "campus" })));
    await flush();
    assert.ok(host.textContent.includes("正在读取组织营收"));
    await act(async () => resolveRequest(campusRevenue));
    await flush();
    assert.ok(host.textContent.includes("校区数据"));
    assert.ok(host.textContent.includes("校区管理费：2.00 欢乐豆"));
    assert.equal(host.textContent.includes("分区营收"), false);
    assert.equal(host.textContent.includes("999.00"), false);
    await act(async () => root.render(React.createElement(module.OrganizationRevenuePanel, { client, session: session({ subject: "TEACHING_TEACHER", scope: "PERSON" }), sessionKey: "teacher" })));
    await flush();
    assert.ok(host.textContent.includes("当前身份没有读取组织营收的权限"));
    assert.equal(host.textContent.includes("校区数据"), false);
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
