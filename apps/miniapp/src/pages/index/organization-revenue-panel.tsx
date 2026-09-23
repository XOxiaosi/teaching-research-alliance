import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiClientError, RoleSelectionRequiredError, StaleResponseError, formatCentsAsBeans, type OrganizationRevenue, type OrganizationRevenueAmounts, type SessionSnapshot, type TeacherApiClient } from "@teaching-research-alliance/client";
import { Picker, Text, View } from "@tarojs/components";

type Props = Readonly<{ client: TeacherApiClient; session: SessionSnapshot; sessionKey: string; busy?: boolean; onInvalidated?: () => void }>;
type CurrentRoleContext = SessionSnapshot["currentRoleContext"];

const monthAtBeijing = (): string => { const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).formatToParts(new Date()); return `${parts.find((part) => part.type === "year")?.value ?? "2026"}-${parts.find((part) => part.type === "month")?.value ?? "01"}-01`; };
const validMonth = (month: string): boolean => /^\d{4}-(0[1-9]|1[0-2])-01$/.test(month);
const scopeKey = (context: CurrentRoleContext): string => context === null ? "" : `${context.subject}:${context.scope}:${context.regionId ?? ""}:${context.campusId ?? ""}:${context.venueId ?? ""}`;

export const canReadMiniOrganizationRevenue = (context: CurrentRoleContext): boolean => {
  if (context === null) return false;
  const noAdditionalScope = context.regionId === undefined && context.campusId === undefined && context.venueId === undefined;
  if (["SYSTEM_OWNER", "SYSTEM_ADMIN", "HEADQUARTERS_FINANCE"].includes(context.subject)) return context.scope === "GLOBAL" && noAdditionalScope;
  if (context.subject === "REGION_FINANCE") return context.scope === "REGION" && context.regionId !== undefined && context.regionId !== "" && context.campusId === undefined && context.venueId === undefined;
  return context.subject === "CAMPUS_PRINCIPAL" && context.scope === "CAMPUS" && context.campusId !== undefined && context.campusId !== "" && context.regionId === undefined && context.venueId === undefined;
};

export const miniOrganizationRevenueErrorMessage = (error: unknown): string => {
  if (error instanceof ApiClientError) {
    if (error.code === "FORBIDDEN_SCOPE" || error.status === 403) return "当前身份没有读取组织营收的权限。";
    if (error.code === "ORGANIZATION_REVENUE_DATA_UNAVAILABLE") return "该期间存在无法核验的历史结算数据，暂不能展示营收。";
    if (error.code === "INVALID_INPUT") return "请选择合法的起止月份。";
  }
  return "组织营收读取失败，请稍后重试。";
};

function Amounts({ amounts }: Readonly<{ amounts: OrganizationRevenueAmounts }>): ReactNode {
  return <View className="organization-revenue-amounts"><Text>录入课时总额：{formatCentsAsBeans(amounts.recordedGrossRevenueCents)} 欢乐豆</Text><Text>退款额：{formatCentsAsBeans(amounts.refundedGrossRevenueCents)} 欢乐豆</Text><Text>有效营收：{formatCentsAsBeans(amounts.effectiveGrossRevenueCents)} 欢乐豆</Text><Text>校区管理费：{formatCentsAsBeans(amounts.campusManagementFeeCents)} 欢乐豆</Text></View>;
}

function RegionFinanceIncome({ value }: Readonly<{ value: string | undefined }>): ReactNode { return value === undefined ? null : <Text>分区自身分润：{formatCentsAsBeans(value)} 欢乐豆</Text>; }

export function OrganizationRevenuePanel({ client, session, sessionKey, busy = false, onInvalidated }: Props): ReactNode {
  const [fromMonth, setFromMonth] = useState(monthAtBeijing);
  const [toMonth, setToMonth] = useState(monthAtBeijing);
  const [revenue, setRevenue] = useState<OrganizationRevenue | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const context = session.currentRoleContext;
  const canRead = canReadMiniOrganizationRevenue(context);
  const currentScopeKey = scopeKey(context);

  useEffect(() => {
    const current = ++generation.current;
    setRevenue(null); setNotice("");
    if (!canRead) { setLoading(false); return; }
    if (!validMonth(fromMonth) || !validMonth(toMonth) || fromMonth > toMonth) { setLoading(false); setNotice("起始月份不能晚于结束月份。"); return; }
    setLoading(true);
    void client.getOrganizationRevenue({ fromMonth, toMonth }).then((next) => { if (generation.current === current) setRevenue(next); }).catch((error) => { if (generation.current !== current || error instanceof StaleResponseError) return; if (error instanceof RoleSelectionRequiredError || error instanceof ApiClientError && [401,403].includes(error.status) || client.hasRoleContext === false) { setRevenue(null); onInvalidated?.(); } setNotice(miniOrganizationRevenueErrorMessage(error)); }).finally(() => { if (generation.current === current) setLoading(false); });
    return () => { generation.current += 1; };
  }, [client, canRead, currentScopeKey, fromMonth, sessionKey, toMonth]);

  if (!canRead) return <View className="panel"><Text className="panel-title">组织营收</Text><Text>当前身份没有读取组织营收的权限。</Text></View>;
  const showRegionFinance = context?.scope !== "CAMPUS";
  return <View className="panel organization-revenue-panel"><Text className="panel-title">组织营收</Text><Text className="panel-description">课时营收、退款、管理费和分区分润分别统计。</Text><Text className="field-label">起始月份</Text><Picker mode="date" fields="month" value={fromMonth.slice(0, 7)} disabled={busy} onChange={(event) => setFromMonth(`${event.detail.value}-01`)}><View className="picker-value"><Text>{fromMonth.slice(0, 7)}</Text><Text>⌄</Text></View></Picker><Text className="field-label">结束月份</Text><Picker mode="date" fields="month" value={toMonth.slice(0, 7)} disabled={busy} onChange={(event) => setToMonth(`${event.detail.value}-01`)}><View className="picker-value"><Text>{toMonth.slice(0, 7)}</Text><Text>⌄</Text></View></Picker>{loading && <Text className="panel-description">正在读取组织营收…</Text>}{notice !== "" && <View className="notice"><Text>{notice}</Text></View>}{revenue !== null && <><Text className="panel-description">{revenue.period.fromMonth.slice(0, 7)} 至 {revenue.period.toMonth.slice(0, 7)} · 截至 {revenue.period.asOf}</Text><View className="organization-revenue-total"><Text className="panel-title">范围内课时营收汇总</Text><Amounts amounts={revenue.total} />{showRegionFinance && <RegionFinanceIncome value={revenue.total.regionFinanceIncomeCents} />}</View><Text className="panel-title">校区营收</Text>{revenue.campuses.length === 0 ? <Text className="panel-description">该期间暂无校区营收记录。</Text> : revenue.campuses.map((campus) => <View className="venue-board-teacher" key={`${campus.campusId}:${campus.attributedRegionId}`}><Text>{campus.campusName} · 业务期归属：{campus.attributedRegionName}</Text><Amounts amounts={campus} /></View>)}{showRegionFinance && <><Text className="panel-title">分区营收</Text>{revenue.regions.length === 0 ? <Text className="panel-description">当前范围暂无分区营收记录。</Text> : revenue.regions.map((region) => <View className="venue-board-teacher" key={region.regionId}><Text>{region.regionName}</Text><Amounts amounts={region} /><RegionFinanceIncome value={region.regionFinanceIncomeCents} /></View>)}</>}</>}</View>;
}
