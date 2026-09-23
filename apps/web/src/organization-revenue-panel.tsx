import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiClientError, RoleSelectionRequiredError, StaleResponseError, formatCentsAsBeans, type OrganizationRevenue, type OrganizationRevenueAmounts, type SessionSnapshot, type TeacherApiClient } from "@teaching-research-alliance/client";

type Props = Readonly<{ client: TeacherApiClient; session: SessionSnapshot; sessionKey: string; busy?: boolean; onInvalidated?: () => void }>;
type CurrentRoleContext = SessionSnapshot["currentRoleContext"];

const monthAtBeijing = (): string => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  return `${parts.find((part) => part.type === "year")?.value ?? "2026"}-${parts.find((part) => part.type === "month")?.value ?? "01"}-01`;
};

const monthInput = (month: string): string => month.slice(0, 7);
const toMonthStart = (month: string): string => `${month}-01`;
const validMonth = (month: string): boolean => /^\d{4}-(0[1-9]|1[0-2])-01$/.test(month);

export const canReadOrganizationRevenue = (context: CurrentRoleContext): boolean => {
  if (context === null) return false;
  const noAdditionalScope = context.regionId === undefined && context.campusId === undefined && context.venueId === undefined;
  if (["SYSTEM_OWNER", "SYSTEM_ADMIN", "HEADQUARTERS_FINANCE"].includes(context.subject)) {
    return context.scope === "GLOBAL" && noAdditionalScope;
  }
  if (context.subject === "REGION_FINANCE") {
    return context.scope === "REGION" && context.regionId !== undefined && context.regionId !== "" && context.campusId === undefined && context.venueId === undefined;
  }
  return context.subject === "CAMPUS_PRINCIPAL"
    && context.scope === "CAMPUS" && context.campusId !== undefined && context.campusId !== ""
    && context.regionId === undefined && context.venueId === undefined;
};

export const organizationRevenueErrorMessage = (error: unknown): string => {
  if (error instanceof ApiClientError) {
    if (error.code === "FORBIDDEN_SCOPE" || error.status === 403) return "当前身份没有读取组织营收的权限。";
    if (error.code === "ORGANIZATION_REVENUE_DATA_UNAVAILABLE") return "该期间存在无法核验的历史结算数据，暂不能展示营收。";
    if (error.code === "INVALID_INPUT") return "请选择合法的起止月份。";
  }
  return "组织营收读取失败，请稍后重试。";
};

const scopeKey = (context: CurrentRoleContext): string => context === null
  ? ""
  : `${context.subject}:${context.scope}:${context.regionId ?? ""}:${context.campusId ?? ""}:${context.venueId ?? ""}`;

function Amounts({ amounts }: Readonly<{ amounts: OrganizationRevenueAmounts }>): ReactNode {
  return <dl className="organization-revenue-amounts">
    <div><dt>录入课时总额</dt><dd>{formatCentsAsBeans(amounts.recordedGrossRevenueCents)} 欢乐豆</dd></div>
    <div><dt>退款额</dt><dd>{formatCentsAsBeans(amounts.refundedGrossRevenueCents)} 欢乐豆</dd></div>
    <div><dt>有效营收</dt><dd>{formatCentsAsBeans(amounts.effectiveGrossRevenueCents)} 欢乐豆</dd></div>
    <div><dt>校区管理费</dt><dd>{formatCentsAsBeans(amounts.campusManagementFeeCents)} 欢乐豆</dd></div>
  </dl>;
}

function RegionFinanceIncome({ value }: Readonly<{ value: string | undefined }>): ReactNode {
  return value === undefined ? null : <p>分区自身分润：{formatCentsAsBeans(value)} 欢乐豆</p>;
}

export function OrganizationRevenuePanel({ client, session, sessionKey, busy = false, onInvalidated }: Props): ReactNode {
  const [fromMonth, setFromMonth] = useState(monthAtBeijing);
  const [toMonth, setToMonth] = useState(monthAtBeijing);
  const [revenue, setRevenue] = useState<OrganizationRevenue | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestGeneration = useRef(0);
  const context = session.currentRoleContext;
  const canRead = canReadOrganizationRevenue(context);
  const currentScopeKey = scopeKey(context);

  useEffect(() => {
    const generation = ++requestGeneration.current;
    setRevenue(null);
    setError("");
    if (!canRead) { setLoading(false); return; }
    if (!validMonth(fromMonth) || !validMonth(toMonth) || fromMonth > toMonth) {
      setLoading(false);
      setError("起始月份不能晚于结束月份。");
      return;
    }
    setLoading(true);
    void client.getOrganizationRevenue({ fromMonth, toMonth })
      .then((next) => { if (requestGeneration.current === generation) setRevenue(next); })
      .catch((cause) => { if (requestGeneration.current !== generation || cause instanceof StaleResponseError) return; if (cause instanceof RoleSelectionRequiredError || cause instanceof ApiClientError && [401,403].includes(cause.status) || client.hasRoleContext === false) { setRevenue(null); onInvalidated?.(); } setError(organizationRevenueErrorMessage(cause)); })
      .finally(() => { if (requestGeneration.current === generation) setLoading(false); });
    return () => { requestGeneration.current += 1; };
  }, [client, canRead, currentScopeKey, fromMonth, sessionKey, toMonth]);

  if (!canRead) return <section className="panel" aria-label="组织营收"><h2>组织营收</h2><p>当前身份没有读取组织营收的权限。</p></section>;
  const showRegionFinance = context?.scope !== "CAMPUS";
  return <section className="panel organization-revenue-panel" aria-label="组织营收">
    <div className="section-title"><div><span className="fee-eyebrow">ORGANIZATION REVENUE</span><h2>组织营收</h2></div><p>课时营收、退款、管理费和分区分润分别统计。</p></div>
    <div className="organization-revenue-filter">
      <label>起始月份<input aria-label="营收起始月份" type="month" value={monthInput(fromMonth)} disabled={busy} onChange={(event) => setFromMonth(toMonthStart(event.target.value))} /></label>
      <label>结束月份<input aria-label="营收结束月份" type="month" value={monthInput(toMonth)} disabled={busy} onChange={(event) => setToMonth(toMonthStart(event.target.value))} /></label>
    </div>
    {loading && <p role="status">正在读取组织营收…</p>}
    {error !== "" && <p className="message" role="alert">{error}</p>}
    {revenue !== null && <>
      <p className="fee-period-note">{revenue.period.fromMonth.slice(0, 7)} 至 {revenue.period.toMonth.slice(0, 7)} · 截至 {revenue.period.asOf}</p>
      <section aria-label="范围总计"><h3>范围内课时营收汇总</h3><Amounts amounts={revenue.total} />{showRegionFinance && <RegionFinanceIncome value={revenue.total.regionFinanceIncomeCents} />}</section>
      <section aria-label="校区营收"><h3>校区营收</h3>{revenue.campuses.length === 0 ? <p>该期间暂无校区营收记录。</p> : <div className="venue-board-teachers">{revenue.campuses.map((campus) => <article key={`${campus.campusId}:${campus.attributedRegionId}`}><div className="venue-board-teacher-heading"><div><h4>{campus.campusName}</h4><span>业务期归属：{campus.attributedRegionName}</span></div></div><Amounts amounts={campus} /></article>)}</div>}</section>
      {showRegionFinance && <section aria-label="分区营收"><h3>分区营收</h3>{revenue.regions.length === 0 ? <p>当前范围暂无分区营收记录。</p> : <div className="venue-board-teachers">{revenue.regions.map((region) => <article key={region.regionId}><h4>{region.regionName}</h4><Amounts amounts={region} /><RegionFinanceIncome value={region.regionFinanceIncomeCents} /></article>)}</div>}</section>}
    </>}
  </section>;
}
