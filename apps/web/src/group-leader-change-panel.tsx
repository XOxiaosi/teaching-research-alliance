import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ApiClientError,
  RoleSelectionRequiredError,
  formatCentsAsBeans,
  type GroupLeaderRelationshipChangeSubmission,
  type SessionSnapshot,
  type TeacherApiClient,
} from "@teaching-research-alliance/client";

type Props = Readonly<{
  client: TeacherApiClient;
  session: SessionSnapshot;
  sessionKey: string;
  busy?: boolean;
  onInvalidated?: () => void;
  onSaved?: () => void;
  onUnconfirmedChange?: (pending: boolean) => void;
}>;

type Directory = Awaited<ReturnType<TeacherApiClient["listGroupLeaderRelationshipCandidates"]>>;
type Preview = Awaited<ReturnType<TeacherApiClient["previewGroupLeaderRelationshipChange"]>>;
type Phase = "idle" | "previewing" | "publishing" | "unknown" | "stale";

const strictGlobalManager = (session: SessionSnapshot): boolean => {
  const context = session.currentRoleContext;
  return context !== null && context.scope === "GLOBAL" && context.regionId === undefined
    && context.campusId === undefined && context.venueId === undefined
    && ["SYSTEM_ADMIN", "SYSTEM_OWNER"].includes(context.subject);
};

const identityKey = (session: SessionSnapshot, sessionKey: string): string => {
  const context = session.currentRoleContext;
  return [sessionKey, context?.personId ?? "", context?.subject ?? "", context?.scope ?? "", context?.regionId ?? "", context?.campusId ?? "", context?.venueId ?? ""].join("|");
};

const authError = (error: unknown): boolean => error instanceof RoleSelectionRequiredError
  || error instanceof ApiClientError && [401, 403].includes(error.status)
  || typeof error === "object" && error !== null && [401, 403].includes((error as { status?: number }).status ?? 0);

const errorMessage = (error: unknown, fallback: string): string => {
  if (!(error instanceof ApiClientError)) return fallback;
  if (["RELATIONSHIP_PREVIEW_STALE", "RELATIONSHIP_PREVIEW_ALREADY_PUBLISHED"].includes(error.code)) return "预览已过期，请重新生成并核对。";
  if (["GROUP_LEADER_RELATIONSHIP_MISSING", "GROUP_LEADER_RELATIONSHIP_AMBIGUOUS", "GROUP_LEADER_CANDIDATE_MISSING"].includes(error.code)) return "当前人员关系或任命无法核验，请先由管理员核对资料。";
  if (["RELATIONSHIP_DATA_UNAVAILABLE", "RELATIONSHIP_SERVICE_UNAVAILABLE"].includes(error.code)) return "关系数据暂不能核验，请稍后重试。";
  return fallback;
};
const bjt = (value: string): string => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

export function GroupLeaderChangePanel({ client, session, sessionKey, busy = false, onInvalidated, onSaved, onUnconfirmedChange }: Props): ReactNode {
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [teacherPersonId, setTeacherPersonId] = useState("");
  const [newRelatedPersonId, setNewRelatedPersonId] = useState("");
  const [effectiveTeachingWeekId, setEffectiveTeachingWeekId] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [submission, setSubmission] = useState<GroupLeaderRelationshipChangeSubmission | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const writing = useRef(false);
  const previousIdentity = useRef("");
  const manageable = strictGlobalManager(session);
  const identity = identityKey(session, sessionKey);

  const reset = (): void => {
    writing.current = false;
    setDirectory(null); setTeacherPersonId(""); setNewRelatedPersonId(""); setEffectiveTeachingWeekId(""); setReason("");
    setPreview(null); setSubmission(null); setPhase("idle");
  };
  const invalidate = (): void => {
    generation.current += 1;
    reset();
    setMessage("登录或身份已失效，请重新登录或选择身份。");
    onUnconfirmedChange?.(false);
    onInvalidated?.();
  };

  const loadDirectory = (): void => {
    const token = ++generation.current;
    writing.current = false;
    setDirectory(null); setPreview(null); setSubmission(null); setPhase("idle"); setMessage("");
    if (!manageable) return;
    void client.listGroupLeaderRelationshipCandidates().then((next) => {
      if (generation.current !== token) return;
      setDirectory(next);
    }).catch((error: unknown) => {
      if (generation.current !== token) return;
      if (authError(error) || client.hasRoleContext === false) invalidate();
      else setMessage(errorMessage(error, "无法读取授课老师、可任命组长或当前普通周。"));
    });
  };

  useEffect(() => {
    const changed = previousIdentity.current !== identity;
    previousIdentity.current = identity;
    if (changed) reset();
    loadDirectory();
    return () => { generation.current += 1; writing.current = false; };
  }, [client, identity, manageable]);

  useEffect(() => {
    onUnconfirmedChange?.(phase === "publishing" || phase === "unknown");
    return () => onUnconfirmedChange?.(false);
  }, [phase, onUnconfirmedChange]);

  const requestPreview = async (): Promise<void> => {
    if (busy || writing.current || !manageable || directory === null) return;
    if (!teacherPersonId || !newRelatedPersonId || !effectiveTeachingWeekId || !reason.trim()) {
      setMessage("请选择授课老师、新组长和当前普通周，并填写变更原因。");
      return;
    }
    const token = generation.current;
    setPhase("previewing"); setSubmission(null); setPreview(null); setMessage("");
    try {
      const next = await client.previewGroupLeaderRelationshipChange({
        teacherPersonId, newRelatedPersonId, effectiveTeachingWeekId, reason: reason.trim(),
      });
      if (generation.current !== token) return;
      setPreview(next); setPhase("idle");
      setMessage("预览已生成。请核对受影响费用与迁移金额后，再明确发布。");
    } catch (error) {
      if (generation.current !== token) return;
      setPhase("idle");
      if (authError(error) || client.hasRoleContext === false) { invalidate(); return; }
      setMessage(errorMessage(error, "无法生成预览，请核对当前普通周和人员后重试。"));
    }
  };

  const publish = async (): Promise<void> => {
    if (busy || writing.current || !manageable || preview === null) return;
    let command = submission;
    if (command === null) {
      try { command = client.createGroupLeaderRelationshipChangeSubmission(preview.previewId); }
      catch (error) { setMessage(errorMessage(error, "无法准备发布请求。")); return; }
      setSubmission(command);
    }
    const token = generation.current;
    writing.current = true;
    setPhase("publishing"); setMessage("");
    try {
      const published = await client.publishGroupLeaderRelationshipChange(command);
      if (generation.current !== token) return;
      writing.current = false;
      setSubmission(null); setPreview(null); setPhase("idle");
      setMessage(published.replay ? "组长变更已确认，未重复发布。" : "组长变更已发布：仅迁移该普通周及后续适用费用的组长份额。");
      onSaved?.();
    } catch (error) {
      if (generation.current !== token) return;
      writing.current = false;
      if (authError(error) || client.hasRoleContext === false) { invalidate(); return; }
      if (error instanceof ApiClientError && error.status === 404 && error.code === "RELATIONSHIP_PREVIEW_NOT_FOUND") {
        setSubmission(null); setPreview(null); setPhase("stale");
        setMessage("预览已失效且未执行发布。请重新生成预览并人工核对。");
        return;
      }
      if (error instanceof ApiClientError && error.status === 409) {
        setSubmission(null); setPreview(null); setPhase("stale");
        setMessage("预览已过期，未自动发布。请重新生成预览并人工核对后再发布。");
        return;
      }
      if (error instanceof ApiClientError && error.status === 400) {
        setSubmission(null); setPhase("idle");
        setMessage(errorMessage(error, "发布被拒绝，请修改后重新预览。"));
        return;
      }
      setPhase("unknown");
      setMessage("发布结果未确认。请使用原发布请求安全重试，避免重复变更。");
    }
  };

  if (!manageable) return <section className="panel group-leader-change-panel" aria-label="普通周组长变更"><h2>普通周组长变更</h2><p>当前身份没有管理员全局关系调整权限。</p></section>;
  const locked = busy || phase === "previewing" || phase === "publishing" || phase === "unknown";
  const people = directory === null ? new Map<string, string>() : new Map([...directory.teachers, ...directory.groupLeaders].map((item) => [item.personId, item.nickname]));
  const sourceName = preview === null ? "" : preview.sourceRelatedNickname || "原组长（历史姓名不可用）";
  return <section className="panel group-leader-change-panel" aria-label="普通周组长变更">
    <div className="section-title"><h2>普通周组长变更</h2><span>先预览，再明确发布</span></div>
    <p>仅适用于当前普通周：本周及后续适用费用的组长份额按差额迁移；不会重算更早周，也不会套用到寒暑假或其他关系。</p>
    {directory === null ? <><p role="status">{message || "正在读取可任命人员与当前普通周…"}</p>{message && <button type="button" disabled={locked} onClick={loadDirectory}>重试读取目录</button>}</> : <>
      {directory.teachers.length === 0 && <p role="status">当前没有可选择的授课老师。</p>}
      {directory.groupLeaders.length === 0 && <p role="status">当前没有可任命的新组长。</p>}
      {directory.currentWeeks.length === 0 && <p role="status">当前没有可用于本功能的普通周；寒暑假不能在此变更。</p>}
      <label>授课老师<select aria-label="授课老师" disabled={locked} value={teacherPersonId} onChange={(event) => { setTeacherPersonId(event.target.value); setPreview(null); setSubmission(null); setPhase("idle"); }}><option value="">请选择授课老师</option>{directory.teachers.map((person) => <option key={person.personId} value={person.personId}>{person.nickname}</option>)}</select></label>
      <label>新组长<select aria-label="新组长" disabled={locked} value={newRelatedPersonId} onChange={(event) => { setNewRelatedPersonId(event.target.value); setPreview(null); setSubmission(null); setPhase("idle"); }}><option value="">请选择新组长</option>{directory.groupLeaders.map((person) => <option key={person.personId} value={person.personId}>{person.nickname}</option>)}</select></label>
      <label>当前普通周<select aria-label="当前普通周" disabled={locked} value={effectiveTeachingWeekId} onChange={(event) => { setEffectiveTeachingWeekId(event.target.value); setPreview(null); setSubmission(null); setPhase("idle"); }}><option value="">请选择当前普通周</option>{directory.currentWeeks.map((week) => <option key={week.id} value={week.id}>{week.startsOn} 至 {week.endsOn}（结算月 {week.settlementMonth}）</option>)}</select></label>
      <label className="group-leader-reason"><span>变更原因</span><textarea aria-label="变更原因" disabled={locked} value={reason} onChange={(event) => { setReason(event.target.value); setPreview(null); setSubmission(null); setPhase("idle"); }} /></label>
      <button type="button" disabled={locked || phase === "stale"} onClick={() => void requestPreview()}>{phase === "previewing" ? "正在生成预览…" : "生成普通周变更预览"}</button>
      {phase === "stale" && <button type="button" disabled={busy} onClick={() => { setPhase("idle"); setMessage("请重新生成预览。"); }}>重新生成预览</button>}
      {preview !== null && <article className="finance-card" aria-label="组长变更预览"><h3>请核对后发布</h3><p>授课老师：{people.get(preview.teacherPersonId) ?? "当前授课老师"}；原组长：{sourceName}；新组长：{people.get(preview.newRelatedPersonId) ?? "当前候选组长"}</p><p>北京时间生效起点：{bjt(preview.effectiveAt)}。{preview.nextBoundaryAt === null ? "后续已发生的适用普通周费用纳入本次变更。" : `仅在下一关系边界 ${bjt(preview.nextBoundaryAt)} 前适用。`}</p><p>纳入核对费用 {preview.consideredFeeCount} 笔；实际迁移 {preview.movedFeeCount} 笔；零组长份额 {preview.zeroShareFeeCount} 笔；已退款排除 {preview.excludedRefundCount} 笔。</p><p>组长份额迁移：{formatCentsAsBeans(preview.movedAmountCents)} 欢乐豆。</p><p>发布会对原组长扣回并给新组长增加同额，不增加新的费用收入。</p><button type="button" data-relationship-action="publish" disabled={locked} onClick={() => void publish()}>{phase === "publishing" ? "正在发布…" : phase === "unknown" ? "结果未确认" : submission !== null ? "使用原发布请求重试" : "确认发布组长变更"}</button>{phase === "unknown" && <button type="button" data-relationship-action="retry-publish" disabled={busy} onClick={() => void publish()}>使用原发布请求重试</button>}</article>}
    </>}
    {message && <p role="status">{message}</p>}
  </section>;
}
