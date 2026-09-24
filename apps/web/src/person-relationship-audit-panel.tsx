import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiClientError, type PersonRelationshipAuditFilter, type PersonRelationshipAuditAnomalyCode, type PersonRelationshipAuditItemDto, type PersonRelationshipAuditPageDto, type PersonRelationshipAuditRepairability, type PersonRelationshipAuditStatus, type PersonRelationshipAuditType, type SessionSnapshot, type TeacherApiClient } from "@teaching-research-alliance/client";
import { Button } from "./components/ui/button.js";

type Props = Readonly<{ client: TeacherApiClient; session: SessionSnapshot; sessionKey: string; active?: boolean; busy?: boolean; onInvalidated?: () => void }>;
const types: readonly ["", ...PersonRelationshipAuditType[]] = ["", "CAMPUS_PRINCIPAL", "GROUP_LEADER", "TEACHING_MENTOR", "PLANNING_MENTOR"];
const statuses: readonly ["", ...PersonRelationshipAuditStatus[]] = ["", "CURRENT", "FUTURE", "ENDED", "SUPERSEDED", "ANOMALOUS"];
const anomalyCodes: readonly ["", ...PersonRelationshipAuditAnomalyCode[]] = ["", "RELATIONSHIP_INTERVAL_INVALID", "RELATIONSHIP_OVERLAP", "MEMBER_PERSON_INACTIVE", "RELATED_PERSON_INACTIVE", "RELATED_ROLE_INVALID", "RELATED_ROLE_SCOPE_MISMATCH", "SUBJECT_IDENTITY_INVALID", "RECIPIENT_ACCOUNT_INVALID", "NONZERO_RECIPIENT_MISSING", "CAMPUS_PRINCIPAL_MISSING", "CAMPUS_PRINCIPAL_MISMATCH", "SPECIAL_PERIOD_SCOPE_REQUIRED", "HISTORICAL_REFERENCE_MISSING", "SUPERSESSION_SOURCE_INVALID"];
const repairabilities: readonly ["", ...PersonRelationshipAuditRepairability[]] = ["", "GROUP_LEADER_REGULAR_WEEK_PREVIEW", "TEACHING_MENTOR_REGULAR_WEEK_PREVIEW", "READ_ONLY", "REQUIRES_RELATIONSHIP_CORRECTION", "REQUIRES_P27", "REQUIRES_SPECIAL_PERIOD_SCOPE"];
const typeLabel: Record<string, string> = { CAMPUS_PRINCIPAL: "校长关系", GROUP_LEADER: "组长关系", TEACHING_MENTOR: "授课导师关系", PLANNING_MENTOR: "规划导师关系" };
const statusLabel: Record<string, string> = { CURRENT: "当前", FUTURE: "未来", ENDED: "已结束", SUPERSEDED: "已被替代", ANOMALOUS: "异常" };
const anomalyLabel: Record<string, string> = { RELATIONSHIP_INTERVAL_INVALID: "关系时间区间无效", RELATIONSHIP_OVERLAP: "关系时间重叠", MEMBER_PERSON_INACTIVE: "成员已停用", RELATED_PERSON_INACTIVE: "关联人已停用", RELATED_ROLE_INVALID: "关联职责无效", RELATED_ROLE_SCOPE_MISMATCH: "关联职责范围不匹配", SUBJECT_IDENTITY_INVALID: "主体身份无效", RECIPIENT_ACCOUNT_INVALID: "接收账户无效", NONZERO_RECIPIENT_MISSING: "非零分润缺少接收关系", CAMPUS_PRINCIPAL_MISSING: "校区缺少校长关系", CAMPUS_PRINCIPAL_MISMATCH: "校长与校区不匹配", SPECIAL_PERIOD_SCOPE_REQUIRED: "需要特殊期间范围", HISTORICAL_REFERENCE_MISSING: "历史引用缺失", SUPERSESSION_SOURCE_INVALID: "替代来源无效" };
const repairLabel: Record<string, string> = { GROUP_LEADER_REGULAR_WEEK_PREVIEW: "可在普通周组长变更办理", TEACHING_MENTOR_REGULAR_WEEK_PREVIEW: "可在普通周教学导师变更办理", READ_ONLY: "仅可查看", REQUIRES_RELATIONSHIP_CORRECTION: "需关系纠正流程", REQUIRES_P27: "需按 P27 处理", REQUIRES_SPECIAL_PERIOD_SCOPE: "需特殊期间范围" };
const canManage = (session: SessionSnapshot): boolean => { const c = session.currentRoleContext; return c !== null && c.scope === "GLOBAL" && c.regionId === undefined && c.campusId === undefined && c.venueId === undefined && (c.subject === "SYSTEM_OWNER" || c.subject === "SYSTEM_ADMIN"); };
const identityKey = (session: SessionSnapshot, key: string): string => { const c = session.currentRoleContext; return [key, c?.personId ?? "", c?.subject ?? "", c?.scope ?? "", c?.regionId ?? "", c?.campusId ?? "", c?.venueId ?? ""].join("|"); };
const authLoss = (error: unknown): boolean => error instanceof ApiClientError && (error.status === 401 || error.status === 403);
const date = (value: string | null): string => value === null ? "持续有效" : value.slice(0, 10);
const errorText = (error: unknown): string => error instanceof ApiClientError && error.status === 403 ? "当前身份没有关系审计权限。" : error instanceof ApiClientError && error.status === 401 ? "登录已失效，请重新登录或选择身份。" : error instanceof ApiClientError && error.code === "VERSION_CONFLICT" ? "审计数据已有变化，请刷新审计后继续。" : "关系审计暂未加载，请稍后重试。";

export function PersonRelationshipAuditPanel({ client, session, sessionKey, active = true, busy = false, onInvalidated }: Props): ReactNode {
  const [type, setType] = useState<PersonRelationshipAuditType | "">("");
  const [status, setStatus] = useState<PersonRelationshipAuditStatus | "">(""); const [anomalyCode, setAnomalyCode] = useState<PersonRelationshipAuditAnomalyCode | "">(""); const [repairability, setRepairability] = useState<PersonRelationshipAuditRepairability | "">("");
  const [personId, setPersonId] = useState("");
  const [page, setPage] = useState<PersonRelationshipAuditPageDto | null>(null);
  const [items, setItems] = useState<readonly PersonRelationshipAuditItemDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const generation = useRef(0);
  const appliedFilter = useRef<PersonRelationshipAuditFilter>({ limit: 50 });
  const identity = identityKey(session, sessionKey);
  const allowed = canManage(session) && active;
  const draftFilter = (): PersonRelationshipAuditFilter => ({ ...(type ? { relationshipType: type } : {}), ...(status ? { status } : {}), ...(anomalyCode ? { anomalyCode } : {}), ...(repairability ? { repairability } : {}), ...(personId.trim() ? { personId: personId.trim() } : {}), limit: 50 });
  const load = (nextCursor?: string, baseFilter: PersonRelationshipAuditFilter = appliedFilter.current): void => {
    const token = ++generation.current; setLoading(true); setNotice("");
    const filter: PersonRelationshipAuditFilter = { ...baseFilter, ...(nextCursor ? { cursor: nextCursor } : {}) };
    void client.listPersonRelationshipAudit(filter).then((result) => {
      if (token !== generation.current) return;
      setPage(result); setItems((current) => nextCursor ? [...current, ...result.items] : result.items); setCursor(result.nextCursor);
    }).catch((error: unknown) => {
      if (token !== generation.current) return;
      if (authLoss(error) || client.hasRoleContext === false) { onInvalidated?.(); return; }
      if (error instanceof ApiClientError && error.code === "VERSION_CONFLICT") setCursor(null);
      setNotice(errorText(error));
    }).finally(() => { if (token === generation.current) setLoading(false); });
  };
  useEffect(() => { generation.current += 1; setPage(null); setItems([]); setCursor(null); const initial: PersonRelationshipAuditFilter = { limit: 50 }; appliedFilter.current = initial; if (allowed) load(undefined, initial); return () => { generation.current += 1; }; }, [client, identity, allowed]);
  const apply = (): void => { const nextFilter = draftFilter(); appliedFilter.current = nextFilter; generation.current += 1; setItems([]); setPage(null); setCursor(null); load(undefined, nextFilter); };
  if (!allowed) return null;
  return <section className="panel person-relationship-audit-panel" aria-label="人员关系审计">
    <div className="section-heading"><div><p className="eyebrow">RELATIONSHIP AUDIT</p><h2>人员关系审计</h2><p>只读核对当前与历史关系，不显示手机号、余额、工资、银行卡或凭据。</p></div><Button variant="outline" disabled={busy || loading} onClick={() => apply()}>刷新审计</Button></div>
    <div className="audit-filters"><label>关系类型<select aria-label="关系类型" value={type} disabled={loading} onChange={(event) => setType(event.target.value as PersonRelationshipAuditType | "")}>{types.map((value) => <option key={value} value={value}>{value ? typeLabel[value] : "全部关系类型"}</option>)}</select></label><label>关系状态<select aria-label="关系状态" value={status} disabled={loading} onChange={(event) => setStatus(event.target.value as PersonRelationshipAuditStatus | "")}>{statuses.map((value) => <option key={value} value={value}>{value ? statusLabel[value] : "全部状态"}</option>)}</select></label><label>异常码<select aria-label="异常码" value={anomalyCode} disabled={loading} onChange={(event) => setAnomalyCode(event.target.value as PersonRelationshipAuditAnomalyCode | "")}>{anomalyCodes.map((value) => <option key={value} value={value}>{value ? anomalyLabel[value] ?? value : "全部异常"}</option>)}</select></label><label>可纠正性<select aria-label="可纠正性" value={repairability} disabled={loading} onChange={(event) => setRepairability(event.target.value as PersonRelationshipAuditRepairability | "")}>{repairabilities.map((value) => <option key={value} value={value}>{value ? repairLabel[value] ?? value : "全部处理状态"}</option>)}</select></label><label>人员编号<input aria-label="人员编号" value={personId} disabled={loading} onChange={(event) => setPersonId(event.target.value)} /></label><Button disabled={busy || loading} onClick={apply}>应用筛选</Button></div>
    {notice && <p role="alert" className="account-access-notice">{notice}</p>}{page && <p role="status">快照时间：{page.snapshotAt} · 数据版本：{page.dataVersion}</p>}
    {loading && items.length === 0 ? <p role="status">正在读取关系审计…</p> : items.length === 0 ? <p role="status">当前筛选没有关系记录。</p> : <div className="audit-list">{items.map((item) => <article key={item.auditItemId} className="finance-card"><h3>{typeLabel[item.relationshipType] ?? item.relationshipType} · {statusLabel[item.status] ?? item.status}</h3><p>成员：{item.member.nickname}（{item.member.personId}） · 关联人：{item.relatedPerson === null ? "缺失" : `${item.relatedPerson.nickname}（${item.relatedPerson.personId}）`}</p><p>有效期：{date(item.validFrom)} 至 {date(item.validTo)} · 范围：{item.effectiveScope ?? "未指定"}</p><p>引用：周费用 {item.referenceCounts.weeklyFees} · 分配快照 {item.referenceCounts.allocationSnapshots} · 推荐 {item.referenceCounts.referrals}</p><p>创建人：{item.createdBy?.nickname ?? "系统审计"} · 创建时间：{item.createdAt === null ? "不适用" : date(item.createdAt)}</p><p>异常：{item.anomalyCodes.length ? item.anomalyCodes.map((code) => anomalyLabel[code] ?? code).join("、") : "无"}</p><p>处理状态：{repairLabel[item.repairability] ?? item.repairability}{item.repairBlockedReason ? `（${item.repairBlockedReason}）` : ""}</p></article>)}</div>}
    {cursor && <Button variant="outline" disabled={busy || loading} onClick={() => load(cursor)}>加载下一页</Button>}
  </section>;
}
