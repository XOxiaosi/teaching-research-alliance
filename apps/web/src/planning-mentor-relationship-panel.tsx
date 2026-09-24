import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ApiClientError,
  RoleSelectionRequiredError,
  formatCentsAsBeans,
  type PlanningMentorRelationshipChangeSubmission,
  type SessionSnapshot,
  type TeacherApiClient,
} from "@teaching-research-alliance/client";

type Props = Readonly<{ client: TeacherApiClient; session: SessionSnapshot; sessionKey: string; busy?: boolean; onInvalidated?: () => void; onSaved?: () => void; onUnconfirmedChange?: (pending: boolean) => void }>;
type Directory = Awaited<ReturnType<TeacherApiClient["listPlanningMentorRelationships"]>>;
type Preview = Awaited<ReturnType<TeacherApiClient["previewPlanningMentorRelationshipChange"]>>;
type Phase = "idle" | "previewing" | "publishing" | "unknown" | "stale";

const allowed = (session: SessionSnapshot): boolean => {
  const context = session.currentRoleContext;
  return context?.subject === "PLANNING_MENTOR" && context.scope === "SELF"
    && context.regionId === undefined && context.campusId === undefined && context.venueId === undefined;
};
const identity = (session: SessionSnapshot, key: string): string => { const c = session.currentRoleContext; return [key, c?.personId ?? "", c?.subject ?? "", c?.scope ?? "", c?.regionId ?? "", c?.campusId ?? "", c?.venueId ?? ""].join("|"); };
const authError = (error: unknown): boolean => error instanceof RoleSelectionRequiredError
  || error instanceof ApiClientError && [401, 403].includes(error.status)
  || typeof error === "object" && error !== null && [401, 403].includes((error as { status?: number }).status ?? 0);
const explain = (error: unknown, fallback: string): string => {
  if (!(error instanceof ApiClientError)) return fallback;
  if (["RELATIONSHIP_PREVIEW_STALE", "RELATIONSHIP_PREVIEW_ALREADY_PUBLISHED"].includes(error.code)) return "预览已过期，请重新生成并核对。";
  if (["PLANNING_MENTOR_RELATIONSHIP_CONFLICT", "PLANNING_MENTOR_RELATIONSHIP_NOT_OWNED"].includes(error.code)) return "该规划师的导师关系已变化，请刷新目录后重新处理。";
  if (["PLANNING_MENTOR_CANDIDATE_NOT_ELIGIBLE", "PLANNING_MENTOR_CANDIDATE_AMBIGUOUS"].includes(error.code)) return "当前规划师身份或账户无法核验，请由管理员先核对人员资料。";
  if (["RELATIONSHIP_DATA_UNAVAILABLE", "RELATIONSHIP_SERVICE_UNAVAILABLE"].includes(error.code)) return "关系数据暂不能核验，请稍后重试。";
  return fallback;
};
const bjt = (value: string): string => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

export function PlanningMentorRelationshipPanel({ client, session, sessionKey, busy = false, onInvalidated, onSaved, onUnconfirmedChange }: Props): ReactNode {
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [action, setAction] = useState<"ADD" | "REMOVE">("ADD");
  const [plannerPersonId, setPlannerPersonId] = useState("");
  const [weekId, setWeekId] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [submission, setSubmission] = useState<PlanningMentorRelationshipChangeSubmission | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const generation = useRef(0); const writing = useRef(false); const previousIdentity = useRef("");
  const canManage = allowed(session); const identityKey = identity(session, sessionKey);
  const reset = (): void => { writing.current = false; setDirectory(null); setAction("ADD"); setPlannerPersonId(""); setWeekId(""); setReason(""); setPreview(null); setSubmission(null); setPhase("idle"); };
  const invalidate = (): void => { generation.current += 1; reset(); setMessage("登录或身份已失效，请重新登录或选择身份。"); onUnconfirmedChange?.(false); onInvalidated?.(); };
  const load = (successMessage = ""): void => {
    const token = ++generation.current; writing.current = false; setDirectory(null); setPreview(null); setSubmission(null); setPhase("idle"); setMessage(successMessage);
    if (!canManage) return;
    void client.listPlanningMentorRelationships().then(next => { if (generation.current === token) { setDirectory(next); if (successMessage) setMessage(successMessage); } }).catch((error: unknown) => {
      if (generation.current !== token) return;
      if (authError(error) || client.hasRoleContext === false) invalidate(); else setMessage(explain(error, "无法读取本人规划师关系和当前普通周。"));
    });
  };
  useEffect(() => { const changed = previousIdentity.current !== identityKey; previousIdentity.current = identityKey; if (changed) reset(); load(); return () => { generation.current += 1; writing.current = false; }; }, [client, identityKey, canManage]);
  useEffect(() => { onUnconfirmedChange?.(phase === "publishing" || phase === "unknown"); return () => onUnconfirmedChange?.(false); }, [phase, onUnconfirmedChange]);
  const clearPreview = (): void => { setPreview(null); setSubmission(null); setPhase("idle"); };
  const requestPreview = async (): Promise<void> => {
    if (busy || writing.current || !canManage || directory === null) return;
    if (!plannerPersonId || !weekId || !reason.trim()) { setMessage("请选择操作、规划师和当前普通周，并填写变更原因。"); return; }
    const token = generation.current; setPhase("previewing"); setPreview(null); setSubmission(null); setMessage("");
    try {
      const next = await client.previewPlanningMentorRelationshipChange({ action, plannerPersonId, effectiveTeachingWeekId: weekId, reason: reason.trim() });
      if (generation.current !== token) return; setPreview(next); setPhase("idle"); setMessage("预览已生成。请核对关系与差额后，再明确发布。");
    } catch (error) {
      if (generation.current !== token) return; setPhase("idle");
      if (authError(error) || client.hasRoleContext === false) { invalidate(); return; }
      setMessage(explain(error, "无法生成预览，请核对当前普通周和规划师后重试。"));
    }
  };
  const publish = async (): Promise<void> => {
    if (busy || writing.current || !canManage || preview === null) return;
    let command = submission;
    if (command === null) { try { command = client.createPlanningMentorRelationshipChangeSubmission(preview.previewId); } catch (error) { setMessage(explain(error, "无法准备发布请求。")); return; } setSubmission(command); }
    const token = generation.current; writing.current = true; setPhase("publishing"); setMessage("");
    try {
      const result = await client.publishPlanningMentorRelationshipChange(command);
      if (generation.current !== token) return; writing.current = false; setSubmission(null); setPreview(null); setPhase("idle");
      const success = result.replay ? "规划导师关系已确认，未重复发布。" : "规划导师关系已发布：只影响本普通周及后续适用费用。";
      onSaved?.(); load(success);
    } catch (error) {
      if (generation.current !== token) return; writing.current = false;
      if (authError(error) || client.hasRoleContext === false) { invalidate(); return; }
      if (error instanceof ApiClientError && [404, 409].includes(error.status)) { setSubmission(null); setPreview(null); setPhase("stale"); setMessage("预览已失效，未自动发布。请重新生成并人工核对。"); return; }
      if (error instanceof ApiClientError && error.status === 400) { setSubmission(null); setPhase("idle"); setMessage(explain(error, "发布被拒绝，请修改后重新预览。")); return; }
      setPhase("unknown"); setMessage("发布结果未确认。请使用原发布请求安全重试，避免重复关系或账务变更。");
    }
  };
  if (!canManage) return <section className="panel planning-mentor-relationship-panel" aria-label="我的规划师关系"><h2>我的规划师关系</h2><p>请切换到学业规划导师本人身份后办理。</p></section>;
  const locked = busy || ["previewing", "publishing", "unknown"].includes(phase);
  const planners = action === "ADD" ? directory?.availablePlanners ?? [] : directory?.managedPlanners ?? [];
  return <section className="panel planning-mentor-relationship-panel" aria-label="我的规划师关系">
    <div className="section-title"><h2>我的规划师关系</h2><span>普通周先预览，再发布</span></div>
    <p>你只能增减自己名下的规划师。变更从当前普通周起调整介绍池拆分，更早周和已退款费用保持原事实；寒暑假请交管理员处理。</p>
    {directory === null ? <><p role="status">{message || "正在读取本人关系与当前普通周…"}</p>{message && <button type="button" disabled={locked} onClick={() => load()}>重试读取目录</button>}</> : <>
      <p>当前管理 {directory.managedPlanners.length} 名规划师。</p>
      <label>关系操作<select aria-label="关系操作" disabled={locked} value={action} onChange={event => { setAction(event.target.value as "ADD" | "REMOVE"); setPlannerPersonId(""); clearPreview(); }}><option value="ADD">新增本人管理关系</option><option value="REMOVE">移除本人管理关系</option></select></label>
      <label>规划师<select aria-label="规划师" disabled={locked} value={plannerPersonId} onChange={event => { setPlannerPersonId(event.target.value); clearPreview(); }}><option value="">请选择规划师</option>{planners.map(person => <option key={person.personId} value={person.personId}>{person.nickname}</option>)}</select></label>
      {planners.length === 0 && <p role="status">{action === "ADD" ? "当前没有可新增的规划师。" : "当前没有可移除的本人规划师关系。"}</p>}
      <label>当前普通周<select aria-label="当前普通周" disabled={locked} value={weekId} onChange={event => { setWeekId(event.target.value); clearPreview(); }}><option value="">请选择当前普通周</option>{directory.currentWeeks.map(week => <option key={week.id} value={week.id}>{week.startsOn} 至 {week.endsOn}（结算月 {week.settlementMonth}）</option>)}</select></label>
      {directory.currentWeeks.length === 0 && <p role="status">当前没有可办理的普通周；特殊期间不能在此变更。</p>}
      <label><span>变更原因</span><textarea aria-label="变更原因" disabled={locked} value={reason} onChange={event => { setReason(event.target.value); clearPreview(); }} /></label>
      <button type="button" disabled={locked || phase === "stale"} onClick={() => void requestPreview()}>{phase === "previewing" ? "正在生成预览…" : "生成关系影响预览"}</button>
      {phase === "stale" && <button type="button" disabled={busy} onClick={() => { setPhase("idle"); setMessage("请重新生成预览。"); }}>重新生成预览</button>}
      {preview !== null && <article className="finance-card" aria-label="规划导师关系预览"><h3>请核对后发布</h3><p>{preview.action === "ADD" ? "新增" : "移除"}规划师：{preview.plannerNickname}</p><p>北京时间生效起点：{bjt(preview.effectiveAt)}。{preview.nextBoundaryAt === null ? "后续已发生的适用普通周费用纳入本次变更。" : `仅在下一关系边界 ${bjt(preview.nextBoundaryAt)} 前适用。`}</p><p>纳入核对 {preview.consideredFeeCount} 笔；实际变化 {preview.changedFeeCount} 笔；零导师份额 {preview.zeroShareFeeCount} 笔；已退款排除 {preview.excludedRefundCount} 笔。</p><p>规划师差额：{formatCentsAsBeans(preview.plannerDeltaCents)}；规划导师差额：{formatCentsAsBeans(preview.mentorDeltaCents)} 欢乐豆。介绍池总额不增加。</p><button type="button" data-planning-mentor-action="publish" disabled={locked} onClick={() => void publish()}>{phase === "publishing" ? "正在发布…" : submission !== null ? "使用原发布请求重试" : "确认发布关系变更"}</button>{phase === "unknown" && <button type="button" data-planning-mentor-action="retry-publish" disabled={busy} onClick={() => void publish()}>使用原发布请求重试</button>}</article>}
    </>}
    {message && <p role="status">{message}</p>}
  </section>;
}
