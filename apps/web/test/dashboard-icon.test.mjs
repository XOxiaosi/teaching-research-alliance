import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const names = [
  "fees",
  "overview",
  "referrals",
  "withdrawals",
  "venue-board",
  "organization-revenue",
  "group-leader-change",
  "salary",
  "salary-confirmation",
  "bonus-projects",
  "benefits",
  "finance",
  "purchase",
  "funds",
  "accounts",
  "purchase-history",
  "reimbursements",
  "reimbursement-history",
  "refunds",
  "refund-history",
];

let bundled;
async function load() {
  if (bundled) return bundled;
  const dir = await mkdtemp(resolve(import.meta.dirname, ".dashboard-icon-test-"));
  bundled = resolve(dir, "dashboard-icon.mjs");
  await build({
    entryPoints: [resolve(import.meta.dirname, "../src/components/dashboard-icon.tsx")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundled,
    external: ["react", "@remixicon/react"],
  });
  return (await import(bundled)).DashboardIcon;
}

test.after(async () => {
  if (bundled) await rm(resolve(bundled, ".."), { recursive: true, force: true });
});

test("all dashboard icon semantics render decorative nav SVGs", async () => {
  const DashboardIcon = await load();
  const dom = new JSDOM("<div id=host></div>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.querySelector("#host"));

  await act(async () => {
    root.render(
      React.createElement(
        "div",
        null,
        ...names.map((name) =>
          React.createElement(DashboardIcon, { key: name, name }),
        ),
      ),
    );
  });

  const icons = [...document.querySelectorAll("svg")];
  assert.equal(icons.length, names.length);
  for (const icon of icons) {
    assert.equal(icon.getAttribute("aria-hidden"), "true");
    assert.equal(icon.getAttribute("focusable"), "false");
    assert.match(icon.getAttribute("class") ?? "", /(?:^| )nav-icon(?: |$)/);
    assert.equal(icon.getAttribute("aria-label"), null);
    assert.equal(icon.textContent, "");
  }

  await act(async () => root.unmount());
  dom.window.close();
});
