import { useEffect, useRef, useState, type ReactNode } from "react";
import { AttachmentDownload } from "./finance-shared.js";
import { ApiClientError, RoleSelectionRequiredError, StaleResponseError, formatCentsAsBeans, type ManagedCashWageConfirmationPage, type ManagedCashWageDetail, type ManagedCashWageRoster, type SessionSnapshot, type TeacherApiClient } from "@teaching-research-alliance/client";

type Props = { client: TeacherApiClient; session: SessionSnapshot; sessionKey: string; busy?: boolean; onInvalidated?: () => void };
const beijingMonth = (): string => { const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).formatToParts(new Date()); const year = parts.find(p => p.type === "year")?.value ?? "2026"; const month = parts.find(p => p.type === "month")?.value ?? "01"; return `${year}-${month}-01`; };
const yuan = (cents: string): string => { const value = BigInt(cents); return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`; };
const statuses: Record<string, string> = { INACTIVE: "未启用", NOT_GENERATED: "待生成", PENDING: "待发放", PARTIALLY_CONFIRMED: "部分确认", CONFIRMED: "已确认", OVER_CONFIRMED: "超计划", COMPLETED: "已完成", REVERSED: "已冲回" };

export function CashWagePanel({ client, session, sessionKey, busy = false, onInvalidated }: Props): ReactNode {
  const [month, setMonth] = useState(beijingMonth);
  const [roster, setRoster] = useState<ManagedCashWageRoster | null>(null);
  const [history, setHistory] = useState<ManagedCashWageConfirmationPage | null>(null);
  const [detail, setDetail] = useState<ManagedCashWageDetail | null>(null);
  const [error, setError] = useState("");
  const historyRequest = useRef(0);
  const detailRequest = useRef(0);
  const generation = useRef(0);
  const context = session.currentRoleContext;
  const canRead = context?.scope === "GLOBAL" && context.regionId === undefined && context.campusId === undefined && context.venueId === undefined && ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"].includes(context.subject);

  const fail = (cause: unknown, message: string): void => {
    if (cause instanceof StaleResponseError) return;
    if (cause instanceof RoleSelectionRequiredError || cause instanceof ApiClientError && [401, 403].includes(cause.status) || client.hasRoleContext === false) {
      generation.current += 1; historyRequest.current += 1; detailRequest.current += 1;
      setRoster(null); setHistory(null); setDetail(null); setError("登录或身份已失效，请重新登录或选择身份。");
      onInvalidated?.(); return;
    }
    setError(message);
  };

  useEffect(() => {
    const current = ++generation.current;
    setRoster(null); setHistory(null); setDetail(null); setError(""); historyRequest.current += 1; detailRequest.current += 1;
    if (!canRead) return;
    setRoster(null); setHistory(null);
    void Promise.all([client.listManagedCashWageRoster(month), client.listManagedCashWageConfirmations({ month, limit: 50 })])
      .then(([nextRoster, nextHistory]) => { if (generation.current !== current) return; setRoster(nextRoster); setHistory(nextHistory); })
      .catch((cause) => { if (generation.current !== current) return; fail(cause, "工资数据读取失败，请稍后重试。"); });
    return () => { generation.current += 1; historyRequest.current += 1; detailRequest.current += 1; };
  }, [client, canRead, month, sessionKey]);

  if (!canRead) return <section className="panel" aria-label="工资管理"><h2>工资管理</h2><p>当前身份没有读取总部工资数据的权限。</p></section>;
  return <section className="panel" aria-label="工资管理">
    <div className="section-title"><div><span className="fee-eyebrow">CASH WAGES</span><h2>工资管理</h2></div><label>工资月份<input aria-label="工资月份" type="month" value={month.slice(0, 7)} disabled={busy} onChange={event => setMonth(`${event.target.value}-01`)} /></label></div>
    {error !== "" && <p className="message" role="alert">{error}</p>}
    {roster === null && error === "" && <p role="status">正在读取工资名单和确认历史…</p>}
    {roster !== null && <><p className="fee-period-note">{roster.salaryMonth.slice(0, 7)} · 计划、待办、已确认与剩余金额</p><div className="venue-board-teachers">{roster.items.length === 0 && <p>本月暂无有效工资计划。</p>}{roster.items.map(item => <article key={item.teacherPersonId}><div className="venue-board-teacher-heading"><div><h3>{item.teacherDisplayName}</h3><span>{statuses[item.status] ?? item.status}{item.todo ? " · 已生成待办" : ""}</span></div><strong>{yuan(item.plan.plannedCashCents)} 元</strong></div><p>已确认 {yuan(item.confirmedCashCents)} 元 · 剩余 {yuan(item.remainingCashCents)} 元 · 扣减计划 {formatCentsAsBeans(item.plan.plannedDeductionCents)} 欢乐豆 · 扣减已确认 {formatCentsAsBeans(item.confirmedDeductionCents)} 欢乐豆{item.overageCashCents !== "0" ? ` · 超计划 ${yuan(item.overageCashCents)} 元` : ""}</p></article>)}</div></>}
    {history !== null && <><h3>确认历史</h3>{history.items.length === 0 ? <p>暂无工资确认记录。</p> : <div className="venue-board-fees">{history.items.map(item => <button type="button" className="quiet-button" key={item.documentId} onClick={() => { setDetail(null); setError(""); const current = ++detailRequest.current; void client.getManagedCashWageDetail(item.documentId).then(next => { if (detailRequest.current === current) setDetail(next); }).catch(cause => { if (detailRequest.current === current) fail(cause, "工资详情读取失败。"); }); }}>{item.teacherDisplayName} · {item.salaryMonth.slice(0, 7)} · {yuan(item.cashPaidCents)} 元 · {statuses[item.status] ?? item.status}</button>)}</div>}{history.nextCursor && <button type="button" className="quiet-button" onClick={() => { setError(""); const current = ++historyRequest.current; void client.listManagedCashWageConfirmations({ month, cursor: history.nextCursor!, limit: 50 }).then(next => { if (historyRequest.current !== current) return; setHistory({ items: [...history.items, ...next.items], nextCursor: next.nextCursor });  }).catch(cause => { if (historyRequest.current === current) fail(cause, "工资历史翻页读取失败。"); }); }}>加载更多确认记录</button>}</>}
    {detail && <div className="panel" aria-label="工资确认详情"><h3>{detail.teacherDisplayName} · 详情</h3><p>现金：{yuan(detail.cashPaidCents)} 元；欢乐豆扣减：{formatCentsAsBeans(detail.deductionCents)} 豆</p><p>前余额：{detail.balanceBeforeCents === null ? "暂无" : formatCentsAsBeans(detail.balanceBeforeCents) + " 欢乐豆"} · 后余额：{detail.balanceAfterCents === null ? "暂无" : formatCentsAsBeans(detail.balanceAfterCents) + " 欢乐豆"}</p><p>支付日期：{detail.paidAt.slice(0, 10)} · 状态：{statuses[detail.status] ?? detail.status}</p><p>原件 {detail.attachments.length} 份{detail.attachments.length > 0 && <>：{detail.attachments.map(file => <span key={file.versionId}> {file.originalFilename} <AttachmentDownload client={client} versionId={file.versionId} filename={file.originalFilename} disabled={busy} run={async action => { const current = generation.current; try { await action(); } catch (cause) { if (generation.current === current) fail(cause, "原件下载失败，请重试。"); } }} /></span>)}</>}</p><p>{detail.reason}</p>{detail.reversal && <p>冲回原因：{detail.reversal.reason}</p>}</div>}
  </section>;
}
