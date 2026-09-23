import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiClientError, RoleSelectionRequiredError, type BonusProjectCatalog, type BonusProjectRenameSubmission, type SessionSnapshot, type TeacherApiClient } from "@teaching-research-alliance/client";

type Props = { client: TeacherApiClient; session: SessionSnapshot; sessionKey: string; externalBusy?: boolean; onInvalidated?: () => void; onSaved?: () => void; onUnconfirmedChange?: (pending: boolean) => void };
type Row = BonusProjectCatalog["projects"][number];

const reader = (session: SessionSnapshot): boolean => {
  const c = session.currentRoleContext;
  return c !== null && c.scope === "GLOBAL" && c.regionId === undefined && c.campusId === undefined && c.venueId === undefined && ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"].includes(c.subject);
};
const writer = (session: SessionSnapshot): boolean => {
  const c = session.currentRoleContext;
  return c !== null && c.scope === "GLOBAL" && c.regionId === undefined && c.campusId === undefined && c.venueId === undefined && ["SYSTEM_ADMIN", "SYSTEM_OWNER"].includes(c.subject);
};
const authError = (error: unknown): boolean => error instanceof RoleSelectionRequiredError || error instanceof ApiClientError && (error.status === 401 || error.status === 403) || typeof error === "object" && error !== null && [401, 403].includes((error as { status?: number }).status ?? 0);
const messageFor = (error: unknown): string => authError(error) ? "登录或身份已失效，请重新登录或选择身份。" : error instanceof ApiClientError && error.status === 409 ? "目录已被其他人修改，正在读取最新版本，请稍后核对。" : "网络尚未确认结果，请保留本次内容并安全重试。";

export function BonusProjectPanel({ client, session, sessionKey, externalBusy = false, onInvalidated, onSaved, onUnconfirmedChange }: Props): ReactNode {
  const [projects, setProjects] = useState<readonly Row[] | null>(null);
  const [names, setNames] = useState<Record<number, string>>({});
  const [reasons, setReasons] = useState<Record<number, string>>({});
  const [commands, setCommands] = useState<Record<number, BonusProjectRenameSubmission>>({});
  const [unknown, setUnknown] = useState<Record<number, boolean>>({});
  const [conflict, setConflict] = useState<Record<number, boolean>>({});
  const [conflictReady, setConflictReady] = useState<Record<number, boolean>>({});
  const [inFlight, setInFlight] = useState<Record<number, boolean>>({});
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const activeWrite = useRef<number | null>(null);
  const commandOwner = useRef<number | null>(null);
  const canRead = reader(session);
  const canWrite = writer(session);
  const context = session.currentRoleContext;
  const identitySignature = [sessionKey, context?.personId ?? "", context?.subject ?? "", context?.scope ?? "", context?.regionId ?? "", context?.campusId ?? "", context?.venueId ?? ""].join("|");

  const invalidate = (error: unknown): void => { if (authError(error)) { generation.current += 1; activeWrite.current = null; commandOwner.current = null; setProjects(null); setNames({}); setReasons({}); setCommands({}); setUnknown({}); setConflict({}); setConflictReady({}); setInFlight({}); setMessage(messageFor(error)); onInvalidated?.(); } else setMessage(messageFor(error)); };
  const load = (): void => {
    const token = ++generation.current; activeWrite.current = null; commandOwner.current = null; setLoading(true); setProjects(null); setNames({}); setReasons({}); setCommands({}); setUnknown({}); setConflict({}); setConflictReady({}); setInFlight({}); setMessage("");
    if (!canRead) { setLoading(false); return; }
    void client.listBonusProjects().then(result => { if (generation.current !== token) return; setProjects(result.projects.slice(0, 10)); const next: Record<number, string> = {}; result.projects.forEach(project => { next[project.projectNo] = project.displayName; }); setNames(next); setLoading(false); }).catch(error => { if (generation.current !== token) return; setLoading(false); invalidate(error); });
  };
  useEffect(() => { load(); return () => { generation.current += 1; }; }, [client, identitySignature, canRead]);
  useEffect(() => { const pending = Object.keys(commands).some(key => unknown[Number(key)] || inFlight[Number(key)]); onUnconfirmedChange?.(pending); return () => onUnconfirmedChange?.(false); }, [commands, unknown, inFlight, onUnconfirmedChange]);

  const save = async (project: Row): Promise<void> => {
    const number = project.projectNo;
    if (externalBusy || !canWrite || conflict[number] || activeWrite.current !== null || commandOwner.current !== null && commandOwner.current !== number) return;
    const token = generation.current;
    let submission = commands[number];
    try {
      if (!submission) { const displayName = (names[number] ?? "").trim(); const reason = (reasons[number] ?? "").trim(); if (!displayName || !reason) { setMessage("请填写项目名称和变更理由。"); return; } submission = client.createBonusProjectRenameSubmission({ projectNo: number, expectedVersion: project.nameVersion, displayName, reason }); commandOwner.current = number; setCommands(current => ({ ...current, [number]: submission! })); }
      activeWrite.current = number;
      setInFlight(current => ({ ...current, [number]: true }));
      await client.renameBonusProject(submission);
      if (generation.current !== token) return;
      activeWrite.current = null; commandOwner.current = null;
      setInFlight(current => ({ ...current, [number]: false })); setCommands(current => { const next = { ...current }; delete next[number]; return next; }); setUnknown(current => ({ ...current, [number]: false })); setConflict(current => ({ ...current, [number]: false })); setMessage(`项目${number}名称已保存。`); onSaved?.(); load();
    } catch (error) {
      if (generation.current !== token) return;
      if (authError(error)) { invalidate(error); return; }
      activeWrite.current = null;
      setInFlight(current => ({ ...current, [number]: false }));
      if (error instanceof ApiClientError && error.status === 409) { commandOwner.current = null; setCommands(current => { const next = { ...current }; delete next[number]; return next; }); setConflict(current => ({ ...current, [number]: true })); setConflictReady(current => ({ ...current, [number]: false })); setMessage(messageFor(error)); void client.listBonusProjects().then(result => { if (generation.current === token) { setProjects(result.projects.slice(0, 10)); setConflictReady(current => ({ ...current, [number]: true })); setMessage("最新目录已读取，请核对后再提交。"); } }).catch(refreshError => { if (generation.current === token) { if (authError(refreshError)) invalidate(refreshError); else setMessage(`无法读取最新目录，暂不能确认版本。${messageFor(refreshError)}`); } }); return; }
      if (error instanceof ApiClientError && error.status === 400) { commandOwner.current = null; setCommands(current => { const next = { ...current }; delete next[number]; return next; }); setUnknown(current => ({ ...current, [number]: false })); setMessage(error.message || "输入不符合要求，请修改后重试。"); return; }
      setUnknown(current => ({ ...current, [number]: true })); setMessage(messageFor(error));
    }
  };

  if (!canRead) return <section className="panel" aria-label="奖金项目名称维护"><h2>奖金项目名称</h2><p>当前身份没有查看总部奖金项目目录的权限。</p></section>;
  const owner = activeWrite.current ?? Object.keys(commands).map(Number).find(number => unknown[number] || inFlight[number] || commandOwner.current === number) ?? null;
  return <section className="panel" aria-label="奖金项目名称维护"><h2>奖金项目名称</h2>{loading && <p role="status">正在读取项目目录…</p>}{!loading && projects !== null && <div>{projects.map(project => { const number = project.projectNo; const rowLocked = owner !== null && owner !== number; const locked = externalBusy || rowLocked || unknown[number] === true || inFlight[number] === true; const retryLocked = externalBusy || rowLocked; return <article key={number} className="finance-card"><h3>项目{number}</h3><p>当前名称：{project.displayName}（版本 {project.nameVersion}）</p>{canWrite && <><label>新名称<input aria-label={`项目${number}新名称`} value={names[number] ?? project.displayName} disabled={locked} onChange={event => setNames(current => ({ ...current, [number]: event.target.value }))} /></label><label>变更理由<textarea aria-label={`项目${number}变更理由`} value={reasons[number] ?? ""} disabled={locked} onChange={event => setReasons(current => ({ ...current, [number]: event.target.value }))} /></label><button type="button" disabled={locked || conflict[number] === true} onClick={() => void save(project)}>{unknown[number] ? "结果未确认" : inFlight[number] ? "保存中…" : commands[number] ? "使用原提交重试" : "保存名称"}</button>{unknown[number] && <button type="button" disabled={retryLocked} onClick={() => void save(project)}>使用原提交重试</button>}{conflict[number] && <>{conflictReady[number] ? <><p role="alert">请核对最新目录（当前版本 {project.nameVersion}）后再提交。</p><button type="button" disabled={retryLocked} onClick={() => setConflict(current => ({ ...current, [number]: false }))}>已核对最新版本</button></> : <><p role="alert">无法读取最新目录，暂不能确认版本。</p><button type="button" disabled={retryLocked} onClick={() => { if (externalBusy) return; const token = generation.current; void client.listBonusProjects().then(result => { if (generation.current === token) { setProjects(result.projects.slice(0, 10)); setConflictReady(current => ({ ...current, [number]: true })); } }).catch(error => { if (generation.current === token) { if (authError(error)) invalidate(error); else setMessage(`无法读取最新目录，暂不能确认版本。${messageFor(error)}`); } }); }}>重试读取最新目录</button></>}</>}</>}</article>; })}</div>}{message && <p role="status">{message}</p>}</section>;
}
