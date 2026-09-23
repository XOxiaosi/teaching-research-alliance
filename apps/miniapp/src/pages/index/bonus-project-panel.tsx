import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Input, Text, Textarea, View } from "@tarojs/components";
import {
  ApiClientError,
  RoleSelectionRequiredError,
  type BonusProjectRenameSubmission,
  type BonusProjectSummary,
  type SessionSnapshot,
  type TeacherApiClient,
} from "@teaching-research-alliance/client";

type Props = Readonly<{
  client: TeacherApiClient;
  session: SessionSnapshot;
  sessionKey: string;
  onInvalidated?: () => void;
  onSaved?: () => void;
  onUnconfirmedChange?: (pending: boolean) => void;
}>;

type Draft = Readonly<{ displayName: string; reason: string }>;
type Drafts = Readonly<Record<string, Draft>>;
type Submissions = Readonly<Record<string, BonusProjectRenameSubmission>>;

const strictGlobal = (session: SessionSnapshot): boolean => {
  const context = session.currentRoleContext;
  return context !== null && context.scope === "GLOBAL" && context.regionId === undefined && context.campusId === undefined && context.venueId === undefined;
};
const canRead = (session: SessionSnapshot): boolean => strictGlobal(session) && ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"].includes(session.currentRoleContext?.subject ?? "");
const canWrite = (session: SessionSnapshot): boolean => strictGlobal(session) && ["SYSTEM_ADMIN", "SYSTEM_OWNER"].includes(session.currentRoleContext?.subject ?? "");
const authError = (error: unknown): boolean => error instanceof RoleSelectionRequiredError || (error instanceof ApiClientError && (error.status === 401 || error.status === 403));
const key = (projectNo: number): string => String(projectNo);
const formatBjt = (value: string): string => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const roleSignature = (session: SessionSnapshot): string => { const context = session.currentRoleContext; return context === null ? "none" : [context.personId, context.subject, context.scope, context.regionId ?? "", context.campusId ?? "", context.venueId ?? ""].join("|"); };

export function BonusProjectPanel({ client, session, sessionKey, onInvalidated, onSaved, onUnconfirmedChange }: Props): ReactNode {
  const [projects, setProjects] = useState<readonly BonusProjectSummary[] | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [submissions, setSubmissions] = useState<Submissions>({});
  const [unknown, setUnknown] = useState<ReadonlySet<string>>(new Set());
  const [conflicts, setConflicts] = useState<ReadonlySet<string>>(new Set());
  const [refreshing, setRefreshing] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const identity = useRef("");
  const commandLock = useRef<BonusProjectRenameSubmission | null>(null);
  const activeAttempt = useRef(false);
  const writable = canWrite(session);
  const readable = canRead(session);
  const currentIdentity = `${sessionKey}:${roleSignature(session)}`;

  const invalidate = (): void => {
    generation.current += 1;
    commandLock.current = null;
    activeAttempt.current = false;
    setProjects(null); setDrafts({}); setSubmissions({}); setUnknown(new Set()); setConflicts(new Set()); setRefreshing(new Set());
    onUnconfirmedChange?.(false); onInvalidated?.();
  };
  useEffect(() => {
    const token = ++generation.current;
    let live = true;
    const changedIdentity = identity.current !== currentIdentity;
    identity.current = currentIdentity;
    if (changedIdentity) { commandLock.current = null; activeAttempt.current = false; setProjects(null); setDrafts({}); setSubmissions({}); setUnknown(new Set()); setConflicts(new Set()); setRefreshing(new Set()); setMessage(""); }
    if (!readable) return () => { generation.current += 1; };
    void client.listBonusProjects().then((catalog) => {
      if (live && generation.current === token) {
        setProjects(catalog.projects);
        setRefreshing((current) => { if (current.size > 0) setMessage("最新目录已读取，请核对后再提交。"); return new Set(); });
      }
    }).catch((error: unknown) => {
      if (!live || generation.current !== token) return;
      if (authError(error)) { invalidate(); setMessage("登录或身份已失效，请重新登录或选择身份。"); }
      else setMessage(error instanceof Error ? error.message : "奖金项目目录读取失败，请重试。");
    });
    return () => { live = false; generation.current += 1; activeAttempt.current = false; commandLock.current = null; };
  }, [client, currentIdentity, readable, revision]);
  useEffect(() => {
    onUnconfirmedChange?.(Object.keys(submissions).length > 0 || unknown.size > 0);
    return () => onUnconfirmedChange?.(false);
  }, [submissions, unknown, onUnconfirmedChange]);

  const reload = (): void => setRevision((value) => value + 1);
  const updateDraft = (projectNo: number, patch: Partial<Draft>): void => {
    const id = key(projectNo);
    setDrafts((current) => ({ ...current, [id]: { displayName: current[id]?.displayName ?? projects?.find((item) => item.projectNo === projectNo)?.displayName ?? "", reason: current[id]?.reason ?? "", ...patch } }));
  };
  const save = async (project: BonusProjectSummary): Promise<void> => {
    if (!writable) return;
    const id = key(project.projectNo);
    if (activeAttempt.current) return;
    if (commandLock.current !== null && commandLock.current.draft.projectNo !== project.projectNo) return;
    if (unknown.has(id)) { await retry(project); return; }
    const draft = drafts[id] ?? { displayName: project.displayName, reason: "" };
    if (!draft.displayName.trim() || !draft.reason.trim()) { setMessage(`项目${project.projectNo}请填写名称和变更理由。`); return; }
    let submission: BonusProjectRenameSubmission;
    try {
      submission = client.createBonusProjectRenameSubmission({ projectNo: project.projectNo, expectedVersion: project.nameVersion, displayName: draft.displayName.trim(), reason: draft.reason.trim() });
    } catch (error) { setMessage(error instanceof Error ? error.message : "输入不符合要求。"); return; }
    commandLock.current = submission;
    activeAttempt.current = true;
    setSubmissions((current) => ({ ...current, [id]: submission }));
    setConflicts((current) => { const next = new Set(current); next.delete(id); return next; });
    await execute(project, submission);
  };
  const retry = async (project: BonusProjectSummary): Promise<void> => {
    const submission = submissions[key(project.projectNo)];
    if (activeAttempt.current) return;
    if (!submission || (commandLock.current !== null && commandLock.current !== submission)) return;
    activeAttempt.current = true;
    await execute(project, submission);
  };
  const execute = async (project: BonusProjectSummary, submission: BonusProjectRenameSubmission): Promise<void> => {
    const token = generation.current;
    if (commandLock.current !== submission) return;
    try {
      await client.renameBonusProject(submission);
      if (generation.current !== token) return;
      activeAttempt.current = false;
      commandLock.current = null;
      setSubmissions((current) => { const next = { ...current }; delete next[key(project.projectNo)]; return next; });
      setUnknown((current) => { const next = new Set(current); next.delete(key(project.projectNo)); return next; });
      setConflicts((current) => { const next = new Set(current); next.delete(key(project.projectNo)); return next; });
      setMessage(`项目${project.projectNo}名称已保存。`); onSaved?.(); reload();
    } catch (error) {
      if (generation.current !== token) return;
      activeAttempt.current = false;
      if (authError(error)) { invalidate(); setMessage("登录或身份已失效，请重新登录或选择身份。"); return; }
      if (error instanceof ApiClientError && error.status === 409) {
        commandLock.current = null;
        setSubmissions((current) => { const next = { ...current }; delete next[key(project.projectNo)]; return next; });
        setConflicts((current) => new Set(current).add(key(project.projectNo)));
        setRefreshing((current) => new Set(current).add(key(project.projectNo)));
        setMessage(`项目${project.projectNo}目录版本已变化，正在读取最新版本，请稍候。`); reload(); return;
      }
      if (error instanceof ApiClientError && error.status === 400) {
        commandLock.current = null;
        setSubmissions((current) => { const next = { ...current }; delete next[key(project.projectNo)]; return next; });
        setUnknown((current) => { const next = new Set(current); next.delete(key(project.projectNo)); return next; });
        setMessage(`项目${project.projectNo}提交被拒绝，请修改后重新提交。`); return;
      }
      setUnknown((current) => new Set(current).add(key(project.projectNo)));
      setMessage(`项目${project.projectNo}结果未确认，请使用原提交重试。`);
    }
  };

  if (!readable) return <View className="panel"><Text>当前身份没有查看奖金项目目录的权限。</Text></View>;
  if (projects === null) return <View className="panel"><Text>{message || "正在读取奖金项目目录…"}</Text>{message && <Button onClick={(event) => { event.stopPropagation(); reload(); }}>重试读取目录</Button>}</View>;
  return <View className="panel" data-bonus-project-panel="true">
    <Text className="panel-title">奖金项目名称目录</Text>
    {projects.map((project) => {
      const id = key(project.projectNo); const draft = drafts[id] ?? { displayName: project.displayName, reason: "" }; const pending = submissions[id] !== undefined; const waitingLatest = refreshing.has(id); const locked = Object.keys(submissions).length > 0 || unknown.size > 0 || refreshing.size > 0;
      return <View key={id} className="bonus-project-row" data-project-no={id}>
        <Text>项目{project.projectNo}：{project.displayName}（版本 {project.nameVersion}）</Text>
        <Text>最近变更：{formatBjt(project.changedAt)}（北京时间）；办理人：{project.changedByPersonId ?? "迁移默认"}</Text>
        {writable && <><Input value={draft.displayName} disabled={locked} onInput={(event) => updateDraft(project.projectNo, { displayName: event.detail.value })} /><Textarea value={draft.reason} disabled={locked} onInput={(event) => updateDraft(project.projectNo, { reason: event.detail.value })} /><Button disabled={locked} onClick={(event) => { event.stopPropagation(); void save(project); }}>{pending ? "保存中…" : conflicts.has(id) ? "核对后重新提交" : "保存项目名称"}</Button>{waitingLatest && <Button onClick={(event) => { event.stopPropagation(); reload(); }}>重试读取最新版本</Button>}{unknown.has(id) && <Button onClick={(event) => { event.stopPropagation(); void retry(project); }}>使用原提交重试</Button>}</>}
        {conflicts.has(id) && <Text>版本冲突：请核对最新名称和版本后再提交。</Text>}
      </View>;
    })}
    {message && <Text>{message}</Text>}
  </View>;
}
