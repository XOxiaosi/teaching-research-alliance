import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { ApiClientError } from "@teaching-research-alliance/client";

const plan = (
  id,
  version = 1,
  amountCents = "120",
  fund = { id: "fund", code: "HQ", displayName: "总部福利账户" },
) => ({
  id,
  version,
  executionDay: 1,
  amountCents,
  sourceFund: fund,
  active: true,
  reason: "",
  changedAt: "",
  changedByPersonId: "admin",
});
const roster = {
  benefitMonth: "2026-09-01",
  items: [
    {
      benefitKind: "SOCIAL_INSURANCE",
      beneficiaryPersonId: "person-a",
      beneficiaryDisplayName: "王老师",
      benefitMonth: "2026-09-01",
      planVersions: [
        plan("plan-old", 2, "120", {
          id: "fund-a",
          code: "HQ-A",
          displayName: "总部医社保账户",
        }),
        plan("plan-current", 7, "345", {
          id: "fund-b",
          code: "HQ-B",
          displayName: "总部公积金账户",
        }),
      ],
      currentPlan: plan("plan-current", 7, "345", {
        id: "fund-b",
        code: "HQ-B",
        displayName: "总部公积金账户",
      }),
      todo: { id: "todo-a", planVersionId: "plan-old", generatedAt: "" },
      execution: null,
      status: "PENDING",
    },
    {
      benefitKind: "HOUSING_FUND",
      beneficiaryPersonId: "person-a",
      beneficiaryDisplayName: "王老师",
      benefitMonth: "2026-09-01",
      planVersions: [
        plan("plan-b", 3, "567", {
          id: "fund-c",
          code: "HQ-C",
          displayName: "总部公积金账户",
        }),
      ],
      currentPlan: plan("plan-b", 3, "567", {
        id: "fund-c",
        code: "HQ-C",
        displayName: "总部公积金账户",
      }),
      todo: { id: "todo-b", planVersionId: "plan-b", generatedAt: "" },
      execution: null,
      status: "PENDING",
    },
    {
      benefitKind: "HOUSING_FUND",
      beneficiaryPersonId: "person-b",
      beneficiaryDisplayName: "李老师",
      benefitMonth: "2026-09-01",
      planVersions: [plan("plan-d")],
      currentPlan: plan("plan-d"),
      todo: null,
      execution: null,
      status: "DUE_NOT_GENERATED",
    },
  ],
};
const session = {
  sessionId: "s",
  accountId: "a",
  personId: "p",
  currentRoleContext: { subject: "HEADQUARTERS_FINANCE", scope: "GLOBAL" },
  roleContexts: [],
};
const attachments = {
  documentId: "doc-1",
  attachments: [
    {
      attachmentId: "a",
      purpose: "SUPPORTING_DOCUMENT",
      versions: [
        {
          versionId: "support-v1",
          versionNo: 1,
          status: "READY",
          originalFilename: "a.pdf",
          mediaType: "application/pdf",
          sizeBytes: 1,
          sha256: "",
        },
      ],
    },
    {
      attachmentId: "b",
      purpose: "APPLICATION_SCREENSHOT",
      versions: [
        {
          versionId: "screen-v1",
          versionNo: 1,
          status: "READY",
          originalFilename: "b.png",
          mediaType: "image/png",
          sizeBytes: 1,
          sha256: "",
        },
      ],
    },
  ],
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const props = (element) =>
  element &&
  element[Object.keys(element).find((key) => key.startsWith("__reactProps$"))];
const error = (status) =>
  new ApiClientError(
    status,
    status === 409 ? "STATE_CONFLICT" : "INVALID_INPUT",
  );
let Panel, tempDir;

before(async () => {
  tempDir = await mkdtemp(
    resolve(import.meta.dirname, ".benefit-confirm-test-"),
  );
  const output = resolve(tempDir, "panel.mjs");
  const plugin = {
    name: "shared-double",
    setup(api) {
      api.onResolve({ filter: /finance-shared\.js$/ }, () => ({
        path: "shared-double",
        namespace: "test",
      }));
      api.onLoad({ filter: /.*/, namespace: "test" }, () => ({
        loader: "js",
        contents: `import React from "react"; export const financeError=e=>e instanceof Error?e.message:"error"; export const AttachmentPicker=({purpose,disabled,onReady,onPendingChange,run})=>React.createElement("div",{"data-purpose":purpose},React.createElement("button",{type:"button",disabled,"data-ready":purpose,onClick:()=>onReady(purpose==="SUPPORTING_DOCUMENT"?"support-v1":"screen-v1")},"READY"),React.createElement("button",{type:"button",disabled,"data-pending":purpose,onClick:()=>onPendingChange(true)},"pending"),React.createElement("button",{type:"button",disabled,"data-end":purpose,onClick:()=>onPendingChange(false)},"end"));`,
      }));
    },
  };
  await build({
    entryPoints: [
      resolve(import.meta.dirname, "../src/benefit-confirmation-panel.tsx"),
    ],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: output,
    external: ["react", "@teaching-research-alliance/client"],
    plugins: [plugin],
  });
  Panel = (await import(`file://${output}?${Date.now()}`))
    .BenefitConfirmationPanel;
});
after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function mount(overrides = {}) {
  const dom = new JSDOM("<div id=host></div>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.querySelector("#host");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  const events = {
    generates: [],
    creates: [],
    confirms: [],
    saved: 0,
    invalidated: 0,
    locks: [],
  };
  let reads = 0;
  const { session: sessionOverride, ...clientOverrides } = overrides;
  const activeSession = sessionOverride ?? session;
  const client = {
    hasRoleContext: true,
    listManagedBenefitRoster: async () => {
      reads++;
      return roster;
    },
    createBenefitTodoGenerationSubmission: () => ({
      idempotencyKey: `generate-${events.generates.length}`,
    }),
    generateBenefitTodos: async (c) => {
      events.generates.push(c);
    },
    createSalaryBenefitDocumentSubmission: () => ({
      draft: { kind: "FINANCE_BENEFIT" },
      idempotencyKey: `document-${events.creates.length}`,
    }),
    createSalaryBenefitDocument: async (c) => {
      events.creates.push(c);
      return { id: "doc-1", kind: "FINANCE_BENEFIT", version: 1 };
    },
    listFinanceDocumentAttachments: async () => attachments,
    createBenefitConfirmationSubmission: (draft) => ({
      draft,
      idempotencyKey: `confirm-${events.confirms.length}`,
    }),
    confirmBenefit: async (c) => {
      events.confirms.push(c);
      return { status: "COMPLETED" };
    },
    ...clientOverrides,
  };
  const render = async (key) => {
    await act(async () => {
      root.render(
        React.createElement(Panel, {
          client,
          session: activeSession,
          sessionKey: key,
          onSaved: () => events.saved++,
          onInvalidated: () => events.invalidated++,
          onUnconfirmedChange: (value) => events.locks.push(value),
        }),
      );
      await tick();
    });
  };
  await render("session-1");
  const click = async (el) => {
    assert.ok(el);
    await act(async () => {
      props(el).onClick({ preventDefault() {} });
      await tick();
      await tick();
    });
  };
  const input = async (el, value) => {
    await act(async () => {
      props(el).onChange({ target: { value } });
      await tick();
    });
  };
  const button = (text) =>
    [...host.querySelectorAll("button")].find((e) => e.textContent === text);
  const select = async () =>
    input(host.querySelector("select"), "person-a:SOCIAL_INSURANCE");
  const prepare = async () => {
    await select();
    await click(button("创建福利扣豆凭证"));
    await click(host.querySelector('[data-ready="SUPPORTING_DOCUMENT"]'));
    await click(host.querySelector('[data-ready="APPLICATION_SCREENSHOT"]'));
    await act(async () => {
      props(host.querySelector('input[type="checkbox"]')).onChange({
        target: { checked: true },
      });
      props(host.querySelector("textarea")).onChange({
        target: { value: "已核对" },
      });
      await tick();
    });
  };
  return {
    dom,
    root,
    host,
    client,
    events,
    get reads() {
      return reads;
    },
    render,
    click,
    button,
    select,
    prepare,
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
    },
  };
}

test("无权限不读取目录", async () => {
  const view = await mount({
    session: {
      ...session,
      currentRoleContext: {
        subject: "CAMPUS_FINANCE",
        scope: "CAMPUS",
        campusId: "campus",
      },
    },
    listManagedBenefitRoster: async () => {
      throw new Error("should not read");
    },
  });
  try {
    assert.match(view.host.textContent, /没有福利扣豆确认权限/);
  } finally {
    await view.close();
  }
});
test("只呈现 PENDING 且未执行对象，并展示两套计划", async () => {
  const view = await mount();
  try {
    assert.equal(view.host.querySelectorAll("select option").length, 3);
    await view.select();
    assert.match(view.host.textContent, /待办冻结计划/);
    assert.match(view.host.textContent, /当前执行计划/);
    assert.match(view.host.textContent, /按当前版本执行/);
    assert.match(view.host.textContent, /医社保/);
    assert.match(view.host.textContent, /总部医社保账户/);
    assert.match(view.host.textContent, /总部公积金账户/);
  } finally {
    await view.close();
  }
});
test("生成不扣豆并用同一 command 重试", async () => {
  let first = true;
  const view = await mount({
    generateBenefitTodos: async (c) => {
      view.events.generates.push(c);
      if (first) {
        first = false;
        throw new Error("network");
      }
    },
  });
  try {
    await view.click(view.button("生成今日到期福利待办（不扣豆）"));
    assert.equal(view.events.generates.length, 1);
    await view.click(view.button("安全重试生成待办"));
    assert.equal(view.events.generates.length, 2);
    assert.equal(view.events.generates[0], view.events.generates[1]);
  } finally {
    await view.close();
  }
});
test("建单未知结果使用同一 submission", async () => {
  let first = true;
  const view = await mount({
    createSalaryBenefitDocument: async (submission) => {
      view.events.creates.push(submission);
      if (first) {
        first = false;
        throw new Error("network");
      }
      return { id: "doc-1", kind: "FINANCE_BENEFIT", version: 1 };
    },
  });
  try {
    await view.select();
    await view.click(view.button("创建福利扣豆凭证"));
    await view.click(view.button("安全重试创建福利凭证"));
    assert.equal(view.events.creates.length, 2);
    assert.equal(view.events.creates[0], view.events.creates[1]);
  } finally {
    await view.close();
  }
});
test("冻结计划缺失明确异常并阻止建单", async () => {
  const broken = {
    ...roster,
    items: [{ ...roster.items[0], planVersions: [] }],
  };
  const view = await mount({ listManagedBenefitRoster: async () => broken });
  try {
    await view.select();
    assert.match(view.host.textContent, /数据异常/);
    assert.equal(view.button("创建福利扣豆凭证").disabled, true);
    assert.equal(view.events.creates.length, 0);
  } finally {
    await view.close();
  }
});
test("生成成功后普通刷新失败进入只重读恢复态且不再生成", async () => {
  let reads = 0;
  const view = await mount({
    listManagedBenefitRoster: async () => {
      reads++;
      if (reads === 2) throw new Error("refresh");
      return roster;
    },
  });
  try {
    await view.click(view.button("生成今日到期福利待办（不扣豆）"));
    assert.equal(
      view.button("生成今日到期福利待办（不扣豆）").disabled,
      true,
    );
    await view.click(view.button("只重读福利待办列表"));
    assert.ok(view.button("只重读福利待办列表") === undefined);
    assert.equal(
      view.button("生成今日到期福利待办（不扣豆）").disabled,
      false,
    );
  } finally {
    await view.close();
  }
});
test("成功写入后刷新 401 仍通知身份失效", async () => {
  let reads = 0;
  const view = await mount({
    listManagedBenefitRoster: async () => {
      reads++;
      if (reads > 1) throw error(401);
      return roster;
    },
  });
  try {
    await view.click(view.button("生成今日到期福利待办（不扣豆）"));
    assert.equal(view.events.invalidated, 1);
    assert.ok(view.button("只重读福利待办列表") === undefined);
  } finally {
    await view.close();
  }
});
test("手动重读附件失败可见错误且不污染身份", async () => {
  const view = await mount({
    listFinanceDocumentAttachments: async () => {
      throw new Error("attachment refresh");
    },
  });
  try {
    await view.select();
    await view.click(view.button("创建福利扣豆凭证"));
    const retry = view.button("重新读取凭证附件");
    assert.ok(retry);
    await view.click(retry);
    assert.match(view.host.textContent, /attachment refresh/);
  } finally {
    await view.close();
  }
});
test("建单和确认携带固定 kind、两份 READY 与当前 plan id", async () => {
  const view = await mount();
  try {
    await view.prepare();
    assert.deepEqual(view.events.creates[0].draft, { kind: "FINANCE_BENEFIT" });
    await view.click(view.button("确认福利扣豆"));
    const draft = view.events.confirms[0].draft;
    assert.equal(draft.expectedPlanVersionId, "plan-current");
    assert.deepEqual(draft.attachmentVersionIds, ["support-v1", "screen-v1"]);
    assert.equal(view.events.saved, 1);
  } finally {
    await view.close();
  }
});
test("确认未知结果复用同一 submission", async () => {
  let first = true;
  const view = await mount({
    confirmBenefit: async (c) => {
      view.events.confirms.push(c);
      if (first) {
        first = false;
        throw new Error("network");
      }
    },
  });
  try {
    await view.prepare();
    await view.click(view.button("确认福利扣豆"));
    await view.click(view.button("安全重试原确认"));
    assert.equal(view.events.confirms.length, 2);
    assert.equal(view.events.confirms[0], view.events.confirms[1]);
  } finally {
    await view.close();
  }
});
test("确认成功但列表刷新失败不重发确认", async () => {
  let reads = 0;
  const view = await mount({
    listManagedBenefitRoster: async () => {
      reads++;
      if (reads > 1) throw new Error("refresh failed");
      return roster;
    },
  });
  try {
    await view.prepare();
    await view.click(view.button("确认福利扣豆"));
    assert.equal(view.events.confirms.length, 1);
    assert.match(view.host.textContent, /操作已提交但列表刷新失败/);
    assert.match(view.host.textContent, /勿重新提交/);
  } finally {
    await view.close();
  }
});
test("同步双击建单只发出一次命令", async () => {
  const view = await mount();
  try {
    await view.select();
    const create = view.button("创建福利扣豆凭证");
    await act(async () => {
      props(create).onClick({ preventDefault() {} });
      props(create).onClick({ preventDefault() {} });
      await tick();
    });
    assert.equal(view.events.creates.length, 1);
  } finally {
    await view.close();
  }
});
test("409 不自动确认，重载后要求新建单据", async () => {
  const view = await mount({
    confirmBenefit: async (c) => {
      view.events.confirms.push(c);
      throw error(409);
    },
  });
  try {
    await view.prepare();
    await view.click(view.button("确认福利扣豆"));
    assert.equal(view.events.confirms.length, 1);
    assert.match(view.host.textContent, /未视为最新/);
    await view.click(view.button("重新读取并人工核对"));
    await view.select();
    assert.match(view.host.textContent, /创建福利扣豆凭证/);
    assert.equal(view.events.creates.length, 1);
  } finally {
    await view.close();
  }
});
test("401/403 写入通知失效", async () => {
  for (const status of [401, 403]) {
    const view = await mount({
      createSalaryBenefitDocument: async () => {
        throw error(status);
      },
    });
    try {
      await view.select();
      await view.click(view.button("创建福利扣豆凭证"));
      assert.equal(view.events.invalidated, 1);
    } finally {
      await view.close();
    }
  }
});
test("身份切换后迟到确认不触发保存", async () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  const view = await mount({ confirmBenefit: () => promise });
  try {
    await view.prepare();
    await view.click(view.button("确认福利扣豆"));
    await view.render("session-2");
    resolve({ status: "COMPLETED" });
    await act(async () => {
      await tick();
    });
    assert.equal(view.events.saved, 0);
  } finally {
    await view.close();
  }
});
