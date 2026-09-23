import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ApiClientError } from "@teaching-research-alliance/client";

const dirs = [];
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const session = (subject = "HEADQUARTERS_FINANCE", extra = {}) => ({
  sessionId: `s-${subject}`,
  personId: "finance",
  currentRoleContext: { subject, scope: "GLOBAL", ...extra },
});
const plan = (
  version,
  amount = version === 1 ? "70000" : "80000",
  sourceFund = { id: "fund", code: "FUND", displayName: "总部福利资金" },
) => ({
  id: `plan-${version}`,
  version,
  executionDay: version === 1 ? 5 : 6,
  amountCents: amount,
  sourceFund,
  active: true,
  reason: `计划${version}`,
  changedAt: version === 2 ? "2026-09-06T17:00:00Z" : "2026-09-01T00:00:00Z",
  changedByPersonId: "finance",
});
const attachment = (id, purpose) => ({
  versionId: id,
  purpose,
  originalFilename: `${id}.png`,
  mediaType: "image/png",
  sizeBytes: 4,
  sha256: "a".repeat(64),
});
const item = (status = "REVERSED", execution = true) => ({
  benefitKind: "SOCIAL_INSURANCE",
  beneficiaryPersonId: "teacher",
  beneficiaryDisplayName: "张老师",
  benefitMonth: "2026-09-01",
  planVersions: [plan(1), plan(2)],
  currentPlan: plan(2),
  todo: {
    id: "todo",
    planVersionId: "plan-1",
    generatedAt: "2026-09-05T00:00:00Z",
  },
  execution: execution
    ? {
        documentId: "doc",
        status,
        version: 1,
        planVersionId: "plan-2",
        sourceFund: { id: "fund", code: "FUND", displayName: "总部福利资金" },
        amountCents: "80000",
        executedByPersonId: "finance",
        executedByDisplayName: "财务",
        executedAt: "2026-09-06T17:00:00Z",
        reason: "原执行",
        reversal:
          status === "REVERSED"
            ? {
                documentId: "rev",
                reason: "撤销原因",
                reversedAt: "2026-09-07T17:00:00Z",
                reversedByPersonId: "owner",
              }
            : null,
      }
    : null,
  status,
});
const detail = {
  ...item("REVERSED").execution,
  ...item("REVERSED"),
  todo: {
    id: "todo",
    planVersionId: "plan-1",
    generatedAt: "2026-09-05T00:00:00Z",
  },
  todoPlan: plan(1),
  executionPlan: plan(2),
  attachments: [
    attachment("original", "SUPPORTING_DOCUMENT"),
    attachment("original-shot", "APPLICATION_SCREENSHOT"),
  ],
  reversalAttachments: [
    attachment("reversal", "SUPPORTING_DOCUMENT"),
    attachment("reversal-shot", "APPLICATION_SCREENSHOT"),
  ],
};
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
async function load() {
  const dir = await mkdtemp(resolve(import.meta.dirname, ".benefit-test-"));
  dirs.push(dir);
  const out = resolve(dir, "panel.mjs");
  await build({
    entryPoints: [resolve(import.meta.dirname, "../src/benefit-panel.tsx")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: out,
    external: ["react", "react-dom", "@teaching-research-alliance/client"],
  });
  return (await import(out)).BenefitPanel;
}
async function mount(client, currentSession = session()) {
  const dom = new JSDOM("<div id=host></div>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.querySelector("#host"));
  const Panel = await load();
  let value = currentSession;
  let invalidations = 0;
  const render = async (next = value, key = "k") => {
    value = next;
    client.currentSession = next;
    await act(async () =>
      root.render(
        React.createElement(Panel, {
          client,
          session: next,
          sessionKey: key,
          onInvalidated: () => {
            invalidations += 1;
          },
        }),
      ),
    );
    await flush();
  };
  await render();
  return {
    dom,
    root,
    host: document.querySelector("#host"),
    render,
    invalidations: () => invalidations,
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
    },
  };
}
const baseClient = () => ({
  currentSession: null,
  hasRoleContext: true,
  listManagedBenefitRoster: async () => ({
    benefitMonth: "2026-09-01",
    items: [item()],
  }),
  getManagedBenefitDetail: async () => detail,
  logout() {
    this.currentSession = null;
  },
});
const click = async (host, text) => {
  const node = [...host.querySelectorAll("button")].find((button) =>
    button.textContent.includes(text),
  );
  assert.ok(node, text);
  await act(async () => node.click());
  await flush();
};
const clickNth = async (host, text, index) => {
  const nodes = [...host.querySelectorAll("button")].filter((button) =>
    button.textContent.includes(text),
  );
  assert.ok(nodes[index], `${text} #${index}`);
  await act(async () => nodes[index].click());
  await flush();
};
const changeMonth = async (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  ).set;
  setter.call(input, value);
  await act(async () => {
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await flush();
};

test.after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

test("福利面板严格限制总部身份，并传递 YYYY-MM-01", async () => {
  const client = baseClient();
  const months = [];
  client.listManagedBenefitRoster = async (month) => {
    months.push(month);
    return { benefitMonth: month, items: [] };
  };
  const view = await mount(client);
  try {
    assert.ok(view.host.textContent.includes("2026-"));
    await act(async () =>
      view.host
        .querySelector("input[type=month]")
        .dispatchEvent(new window.Event("change", { bubbles: true })),
    );
    assert.equal(months[0], "2026-09-01");
    await view.render(
      session("SYSTEM_ADMIN", { campusId: "campus" }),
      "narrow",
    );
    assert.ok(view.host.textContent.includes("没有读取总部福利"));
    assert.equal(client.listManagedBenefitRoster.callCount, undefined);
  } finally {
    await view.close();
  }
});

test("月切换、计划历史、todoPlan 与 executionPlan 差异和双侧原件可见", async () => {
  const client = baseClient();
  const calls = [];
  const currentItem = {
    ...item("COMPLETED"),
    currentPlan: {
      ...plan(2),
      sourceFund: {
        id: "current",
        code: "CURRENT",
        displayName: "当前计划账户",
      },
    },
  };
  client.listManagedBenefitRoster = async (month) => {
    calls.push(month);
    return { benefitMonth: month, items: [currentItem] };
  };
  client.getManagedBenefitDetail = async () => ({
    ...detail,
    status: "COMPLETED",
    reversal: null,
    reversalAttachments: [],
    todoPlan: {
      ...plan(1),
      active: false,
      sourceFund: { id: "todo", code: "TODO", displayName: "待办历史账户" },
    },
    executionPlan: {
      ...plan(2),
      sourceFund: { id: "frozen", code: "FROZEN", displayName: "执行冻结账户" },
      changedByPersonId: "executor",
    },
  });
  const view = await mount(client);
  try {
    const input = view.host.querySelector("input[type=month]");
    await changeMonth(input, "2026-10");
    assert.equal(calls.at(-1), "2026-10-01");
    assert.ok(view.host.textContent.includes("完整计划历史"));
    assert.ok(view.host.textContent.includes("v1 · 执行日 5 日"));
    assert.ok(view.host.textContent.includes("v2 · 执行日 6 日"));
    assert.ok(view.host.textContent.includes("北京时间：2026-09-07 01:00"));
    assert.ok(view.host.textContent.includes("当前计划账户"));
    assert.ok(view.host.textContent.includes("变更办理人编号：finance"));
    await click(view.host, "查看实际执行");
    assert.ok(view.host.textContent.includes("待办计划：v1"));
    assert.ok(view.host.textContent.includes("北京时间 2026-09-05 08:00"));
    assert.ok(view.host.textContent.includes("实际执行计划：v2"));
    assert.ok(view.host.textContent.includes("执行冻结账户（FROZEN）"));
    assert.ok(view.host.textContent.includes("变更办理人编号：executor"));
    assert.ok(view.host.textContent.includes("待办历史账户（TODO）"));
    assert.ok(view.host.textContent.includes("停用"));
    assert.ok(view.host.textContent.includes("北京时间 2026-09-07 01:00"));
    assert.ok(view.host.textContent.includes("原执行原件"));
    assert.equal(view.host.textContent.includes("撤销原件"), false);
  } finally {
    await view.close();
  }
});

test("迟到列表和详情响应不会污染新月份或新身份", async () => {
  const oldRoster = deferred();
  const oldDetail = deferred();
  const client = baseClient();
  client.listManagedBenefitRoster = (month) =>
    month === "2026-09-01"
      ? oldRoster.promise
      : Promise.resolve({ benefitMonth: month, items: [] });
  client.getManagedBenefitDetail = () => oldDetail.promise;
  const view = await mount(client);
  try {
    const input = view.host.querySelector("input[type=month]");
    await changeMonth(input, "2026-10");
    oldRoster.resolve({ benefitMonth: "2026-09-01", items: [item()] });
    oldDetail.resolve(detail);
    await flush();
    assert.equal(view.host.textContent.includes("张老师"), false);
    await view.render(session("SYSTEM_ADMIN"), "admin");
    assert.equal(view.host.textContent.includes("张老师"), false);
  } finally {
    await view.close();
  }
});

test("401/403 清空页面并通知父会话", async () => {
  const client = baseClient();
  client.listManagedBenefitRoster = async () => {
    throw new ApiClientError(403, "FORBIDDEN");
  };
  const view = await mount(client);
  try {
    assert.equal(view.invalidations(), 1);
    assert.ok(view.host.textContent.includes("身份已失效"));
    assert.equal(view.host.textContent.includes("张老师"), false);
  } finally {
    await view.close();
  }
});

test("详情读取401同样清空已选详情并通知父会话", async () => {
  const client = baseClient();
  client.getManagedBenefitDetail = async () => {
    throw new ApiClientError(401, "UNAUTHENTICATED");
  };
  const view = await mount(client);
  try {
    await click(view.host, "查看实际执行");
    assert.equal(view.invalidations(), 1);
    assert.ok(view.host.textContent.includes("身份已失效"));
    assert.equal(view.host.textContent.includes("执行详情"), false);
  } finally {
    await view.close();
  }
});

test("附件下载在身份切换后不触发旧会话下载", async () => {
  const pending = deferred();
  const client = baseClient();
  client.listManagedBenefitRoster = async () =>
    client.currentSession?.currentRoleContext.subject === "SYSTEM_ADMIN"
      ? { benefitMonth: "2026-09-01", items: [] }
      : { benefitMonth: "2026-09-01", items: [item()] };
  client.getManagedBenefitDetail = async () => detail;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    await pending.promise;
    return new Response(new Uint8Array([1]), { status: 200 });
  };
  const view = await mount(client);
  try {
    await click(view.host, "查看实际执行");
    assert.ok(view.host.textContent.includes("撤销办理人编号：owner"));
    await click(view.host, "下载原件");
    await view.render(session("SYSTEM_ADMIN"), "new");
    pending.resolve();
    await flush();
    assert.equal(view.host.textContent.includes("张老师"), false);
  } finally {
    globalThis.fetch = previousFetch;
    await view.close();
  }
});

test("同月切换详情后，旧详情的迟到附件不得触发下载", async () => {
  const pending = deferred();
  const fetchStarted = deferred();
  const client = baseClient();
  client.listManagedBenefitRoster = async () => {
    return {
      benefitMonth: "2026-09-01",
      items: [
        {
          ...item("COMPLETED"),
          beneficiaryDisplayName: "A老师",
          execution: { ...item("COMPLETED").execution, documentId: "doc-a" },
        },
        {
          ...item("COMPLETED"),
          beneficiaryPersonId: "teacher-b",
          beneficiaryDisplayName: "B老师",
          execution: { ...item("COMPLETED").execution, documentId: "doc-b" },
        },
      ],
    };
  };
  client.getManagedBenefitDetail = async (documentId) => {
    return {
      ...detail,
      documentId,
      beneficiaryDisplayName: documentId === "doc-a" ? "A老师" : "B老师",
      execution: {
        ...detail.execution,
        documentId,
      },
      attachments: [attachment(`file-${documentId}`, "SUPPORTING_DOCUMENT")],
      reversalAttachments: [],
    };
  };
  const previousFetch = globalThis.fetch;
  const previousCreateObjectURL = URL.createObjectURL;
  const previousRevokeObjectURL = URL.revokeObjectURL;
  const previousAnchorClick = window.HTMLAnchorElement.prototype.click;
  let anchorClicks = 0;
  window.HTMLAnchorElement.prototype.click = () => {
    anchorClicks += 1;
  };
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => {};
  globalThis.fetch = async () => {
    fetchStarted.resolve();
    await pending.promise;
    return new Response(new Uint8Array([1]), { status: 200 });
  };
  const view = await mount(client);
  try {
    await clickNth(view.host, "查看实际执行", 0);
    await click(view.host, "下载原件");
    await fetchStarted.promise;
    await clickNth(view.host, "查看实际执行", 1);
    assert.ok(view.host.textContent.includes("B老师 · 医社保 · 执行详情"));
    pending.resolve();
    await flush();
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(anchorClicks, 0);
  } finally {
    window.HTMLAnchorElement.prototype.click = previousAnchorClick;
    URL.createObjectURL = previousCreateObjectURL;
    URL.revokeObjectURL = previousRevokeObjectURL;
    globalThis.fetch = previousFetch;
    await view.close();
  }
});
