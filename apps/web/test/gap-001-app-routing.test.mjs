import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

let directory;
let defaultPageForSession;

const componentStub = `import React from "react";
const Empty = () => null;
export const SelfPurchasePanel = Empty;
export const ReimbursementPanel = Empty;
export const CompanyFundPanel = Empty;
export const PersonalWithdrawalPanel = Empty;
export const FinanceWithdrawalPanel = Empty;
export const WeeklyFeePanel = Empty;
export const VenueBoardPanel = Empty;
export const VenueManagementPanel = Empty;
export const RefundPanel = Empty;
export const CashWagePanel = Empty;
export const CashWageConfirmationPanel = Empty;
export const CashWagePlanPanel = Empty;
export const BonusProjectPanel = Empty;
export const ProjectBonusGrantPanel = Empty;
export const ProjectBonusHistoryPanel = Empty;
export const ReferralManagementPanel = Empty;
export const ManagedReferralCompletionPanel = Empty;
export const BenefitPlanPanel = Empty;
export const BenefitConfirmationPanel = Empty;
export const BenefitPanel = Empty;
export const GroupLeaderChangePanel = Empty;
export const TeachingMentorChangePanel = Empty;
export const PersonRelationshipAuditPanel = Empty;
export const PlanningMentorRelationshipPanel = Empty;
export const AccountAccessPanel = Empty;
export const PersonResponsibilityPanel = Empty;
export const AccountAuthenticationPanel = Empty;
export const OrganizationRevenuePanel = Empty;
export const DashboardIcon = Empty;
export const Button = Empty;
export const canManageAccounts = () => false;
export const canManagePersonnel = () => false;
export const canReadOrganizationRevenue = (context) => context?.scope === "GLOBAL" && ["SYSTEM_OWNER", "SYSTEM_ADMIN", "HEADQUARTERS_FINANCE"].includes(context.subject);
`;

test.before(async () => {
  directory = await mkdtemp(resolve(import.meta.dirname, ".gap-001-routing-"));
  const output = resolve(directory, "app.mjs");
  await build({
    entryPoints: [resolve(import.meta.dirname, "../src/app.tsx")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: output,
    external: ["react", "react-dom/client", "@teaching-research-alliance/client"],
    plugins: [{
      name: "gap-001-panel-stubs",
      setup(api) {
        api.onResolve({ filter: /^\.\/.*\.js$/ }, () => ({ path: "panels", namespace: "gap-001" }));
        api.onLoad({ filter: /.*/, namespace: "gap-001" }, () => ({ loader: "js", contents: componentStub }));
        api.onResolve({ filter: /style\.css$/ }, () => ({ path: "style", namespace: "gap-001" }));
      },
    }],
  });
  ({ defaultPageForSession } = await import(output));
});

test.after(async () => { await rm(directory, { recursive: true, force: true }); });

const session = (subject, patch = {}) => ({
  sessionId: "session-1",
  accountId: "account-1",
  personId: "person-1",
  currentRoleContext: { subject, scope: "GLOBAL", ...patch },
  roleContexts: [],
});

test("GAP-001 登录和切换身份进入该身份允许的首个页面", () => {
  assert.equal(defaultPageForSession(session("TEACHER", { scope: "SELF" })), "overview");
  assert.equal(defaultPageForSession(session("TEACHING_TEACHER", { scope: "SELF" })), "fees");
  assert.equal(defaultPageForSession(session("HEADQUARTERS_FINANCE")), "finance");
  assert.equal(defaultPageForSession(session("SYSTEM_ADMIN")), "funds");
  assert.equal(defaultPageForSession(session("SYSTEM_OWNER")), "funds");
});
