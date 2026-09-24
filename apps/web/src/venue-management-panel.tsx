import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiClientError, formatCentsAsBeans, type TeacherApiClient } from "@teaching-research-alliance/client";

export type VenueManagementPerson = Readonly<{ personId: string; nickname: string }>;
export type ManagedVenueGrant = Readonly<{
  id: string;
  granteePersonId: string;
  granteeNickname: string;
  canView: boolean;
  canWithdraw: boolean;
  validFrom: string;
  validTo: string | null;
  version: number;
}>;
export type ManagedVenue = Readonly<{
  id: string;
  name: string;
  status: "ACTIVE" | "INACTIVE";
  defaultForOwner: boolean;
  version: number;
  balanceCents?: string;
  grants?: readonly ManagedVenueGrant[];
}>;

type VenueClient = TeacherApiClient & {
  listOwnVenues: <T = unknown>() => Promise<T>;
  createVenue: (draft: Readonly<{ name: string; makeDefault?: boolean }>, idempotencyKey: string) => Promise<unknown>;
  renameVenue: (venueId: string, draft: Readonly<{ name: string; expectedVersion: number }>, idempotencyKey: string) => Promise<unknown>;
  setVenueStatus: (venueId: string, draft: Readonly<{ status: "ACTIVE" | "INACTIVE"; expectedVersion: number }>, idempotencyKey: string) => Promise<unknown>;
  setDefaultVenue: (venueId: string, draft: Readonly<{ expectedVersion: number }>, idempotencyKey: string) => Promise<unknown>;
  setVenuePermission: (venueId: string, draft: Readonly<{ granteePersonId: string; canView: boolean; canWithdraw: boolean; expectedGrantId?: string | null }>, idempotencyKey: string) => Promise<unknown>;
};

type Props = Readonly<{
  client: VenueClient;
  people?: readonly VenueManagementPerson[];
  busy?: boolean;
  onInvalidated?: () => void;
  onSaved?: () => void;
  /** Parent must block navigation and session changes while a command result is unknown. */
  onUnconfirmedChange?: (unconfirmed: boolean) => void;
}>;

const newCommandKey = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `venue-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export const venueManagementErrorMessage = (error: unknown): string => {
  if (error instanceof ApiClientError) {
    if (error.code === "FORBIDDEN_SCOPE" || error.code === "VENUE_NOT_FOUND") return "当前身份没有管理该场地的权限。";
    if (error.code === "VERSION_CONFLICT") return "场地资料已有新变化，请刷新后重试。";
    if (error.code === "VENUE_NOT_ACTIVE") return "停用场地不能设为默认场地。";
    if (error.code === "PERSON_NOT_FOUND") return "只能邀请有效的授课老师。";
    if (error.code === "INVALID_INPUT") return "请检查填写内容后重试。";
  }
  return "场地操作失败，请稍后重试。";
};

const displayDate = (value: string | null): string => value === null ? "当前有效" : new Date(value).toLocaleString();
const isUnconfirmedError = (error: unknown): boolean => !(error instanceof ApiClientError) || error.status >= 500;

export function VenueManagementPanel({ client, people = [], busy = false, onInvalidated, onSaved, onUnconfirmedChange }: Props): ReactNode {
  const [venues, setVenues] = useState<readonly ManagedVenue[]>([]);
  const [teacherDirectory, setTeacherDirectory] = useState<readonly VenueManagementPerson[]>(people);
  const [selectedId, setSelectedId] = useState("");
  const [newName, setNewName] = useState("");
  const [rename, setRename] = useState("");
  const [inviteId, setInviteId] = useState("");
  const [canView, setCanView] = useState(true);
  const [canWithdraw, setCanWithdraw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [unconfirmedScope, setUnconfirmedScope] = useState<string | null>(null);
  const pendingKeys = useRef(new Map<string, string>());
  const pendingRetry = useRef<(() => Promise<void>) | null>(null);
  const selected = useMemo(() => venues.find((venue) => venue.id === selectedId) ?? null, [selectedId, venues]);

  const refresh = async (): Promise<void> => {
    setLoading(true); setError("");
    try {
      const next = await client.listOwnVenues<readonly ManagedVenue[]>();
      setVenues(next); setSelectedId((current) => next.some((venue) => venue.id === current) ? current : next[0]?.id ?? "");
    } catch (nextError) {
      if (nextError instanceof ApiClientError && (nextError.status === 401 || nextError.status === 403)) onInvalidated?.();
      setError(venueManagementErrorMessage(nextError));
    } finally { setLoading(false); }
  };
  useEffect(() => {
    void refresh();
    void client.listReceivingTeachers().then(setTeacherDirectory).catch(() => setTeacherDirectory(people));
  }, [client]);

  const operationKey = (scope: string): string => {
    const current = pendingKeys.current.get(scope);
    if (current !== undefined) return current;
    const next = newCommandKey(); pendingKeys.current.set(scope, next); return next;
  };
  const run = async (scope: string, operation: () => Promise<unknown>, success: string, confirmed?: () => void): Promise<void> => {
    setLoading(true); setError(""); setMessage(""); setUnconfirmedScope(null); pendingRetry.current = () => run(scope, operation, success, confirmed); onUnconfirmedChange?.(true);
    try { await operation(); setMessage(success); await refresh(); pendingKeys.current.delete(scope); pendingRetry.current = null; onUnconfirmedChange?.(false); onSaved?.(); confirmed?.(); }
    catch (nextError) {
      if (nextError instanceof ApiClientError && (nextError.status === 401 || nextError.status === 403)) onInvalidated?.();
      const uncertain = isUnconfirmedError(nextError); onUnconfirmedChange?.(uncertain); setUnconfirmedScope(uncertain ? scope : null); if (!uncertain) pendingRetry.current = null; setError(venueManagementErrorMessage(nextError));
    }
    finally { setLoading(false); }
  };

  const create = (): void => {
    const name = newName.trim();
    if (name === "") { setError("请填写场地名称。"); return; }
    void run("create", () => client.createVenue({ name }, operationKey("create")), "场地已创建。", () => setNewName(""));
  };
  const renameVenue = (): void => {
    if (!selected || rename.trim() === "") { setError("请填写新的场地名称。"); return; }
    const venue = selected; const name = rename.trim(); const scope = `rename:${venue.id}`;
    void run(scope, () => client.renameVenue(venue.id, { name, expectedVersion: venue.version }, operationKey(scope)), "场地名称已更新。", () => setRename(""));
  };
  const updatePermission = (): void => {
    if (!selected || inviteId === "") { setError("请选择要邀请的授课老师。"); return; }
    const venue = selected; const personId = inviteId; const view = canView; const withdraw = canWithdraw; const current = venue.grants?.find((grant) => grant.granteePersonId === personId && grant.validTo === null); const scope = `permission:${venue.id}:${personId}`;
    void run(scope, () => client.setVenuePermission(venue.id, { granteePersonId: personId, canView: view, canWithdraw: withdraw, expectedGrantId: current?.id ?? null }, operationKey(scope)), view || withdraw ? "授权已更新。" : "授权已撤销。");
  };

  const locked = unconfirmedScope !== null;

  return <section className="panel venue-management-panel" aria-label="我的场地管理">
    <div className="section-title"><div><span className="fee-eyebrow">VENUE MANAGEMENT</span><h2>我的场地</h2></div><button type="button" onClick={() => void refresh()} disabled={busy || loading || locked}>刷新</button></div>
    <p className="venue-board-description">创建和管理自己的场地。查看权与提现权分开授权，撤权只影响之后的新提现，历史记录仍保留。</p>
    {locked && <p className="message" role="alert">上次操作结果尚未确认，请保持原内容并安全重试。</p>}
    <div className="venue-management-create"><label>新场地名称<input aria-label="新场地名称" value={newName} onChange={(event) => setNewName(event.target.value)} disabled={busy || loading || locked} /></label><button type="button" onClick={() => void pendingRetry.current?.()} disabled={busy || loading || !locked}>安全重试</button><button type="button" onClick={create} disabled={busy || loading || locked}>创建场地</button></div>
    {error !== "" && <p className="message" role="alert">{error}</p>}{message !== "" && <p className="message" role="status">{message}</p>}
    {venues.length === 0 && !loading ? <p className="venue-board-empty">暂无自有场地。</p> : <div className="venue-management-layout">
      <label>选择场地<select aria-label="管理场地" value={selectedId} onChange={(event) => setSelectedId(event.target.value)} disabled={busy || loading || locked}><option value="">请选择</option>{venues.map((venue) => <option value={venue.id} key={venue.id}>{venue.name}{venue.defaultForOwner ? "（默认）" : ""}</option>)}</select></label>
      {selected && <article className="venue-management-detail">
        <div className="venue-management-heading"><div><h3>{selected.name}</h3><span>{selected.status === "ACTIVE" ? "启用中" : "已停用"} · 版本 {selected.version}{selected.defaultForOwner ? " · 默认场地" : ""}</span></div>{selected.balanceCents !== undefined && <strong>{formatCentsAsBeans(selected.balanceCents)} 豆</strong>}</div>
        <div className="venue-management-actions"><label>改名<input aria-label="新名称" value={rename} onChange={(event) => setRename(event.target.value)} placeholder={selected.name} disabled={busy || loading || locked} /></label><button type="button" onClick={renameVenue} disabled={busy || loading || locked}>保存名称</button><button type="button" onClick={() => { const venue = selected; const scope = `status:${venue.id}`; const status = venue.status === "ACTIVE" ? "INACTIVE" : "ACTIVE"; void run(scope, () => client.setVenueStatus(venue.id, { status, expectedVersion: venue.version }, operationKey(scope)), status === "ACTIVE" ? "场地已启用。" : "场地已停用。"); }} disabled={busy || loading || locked}>{selected.status === "ACTIVE" ? "停用场地" : "启用场地"}</button><button type="button" onClick={() => { const venue = selected; const scope = `default:${venue.id}`; void run(scope, () => client.setDefaultVenue(venue.id, { expectedVersion: venue.version }, operationKey(scope)), "默认场地已更新。"); }} disabled={busy || loading || locked || selected.status !== "ACTIVE" || selected.defaultForOwner}>设为默认</button></div>
        <div className="venue-management-permissions"><h3>邀请与权限</h3><p>提现权只作用于此场地独立账户；受邀老师不能继续授权他人。</p><div className="venue-management-invite"><label>授课老师<select aria-label="邀请授课老师" value={inviteId} onChange={(event) => { setInviteId(event.target.value); const grant = selected.grants?.find((item) => item.granteePersonId === event.target.value && item.validTo === null); setCanView(grant?.canView ?? true); setCanWithdraw(grant?.canWithdraw ?? false); }} disabled={busy || loading || locked}><option value="">请选择老师</option>{teacherDirectory.map((person) => <option value={person.personId} key={person.personId}>{person.nickname}</option>)}</select></label><label><input type="checkbox" checked={canView} onChange={(event) => setCanView(event.target.checked)} disabled={busy || loading || locked} /> 查看</label><label><input type="checkbox" checked={canWithdraw} onChange={(event) => setCanWithdraw(event.target.checked)} disabled={busy || loading || locked} /> 提现</label><button type="button" onClick={updatePermission} disabled={busy || loading || locked || inviteId === ""}>保存授权</button></div>
        {selected.grants?.length ? <ul>{selected.grants.map((grant) => <li key={grant.id}>{grant.granteeNickname} · {grant.validTo !== null ? "已结束" : grant.canView && grant.canWithdraw ? "查看＋提现" : grant.canView ? "仅查看" : grant.canWithdraw ? "仅提现" : "已撤权"} · 生效 {displayDate(grant.validFrom)} · {displayDate(grant.validTo)}</li>)}</ul> : <p>暂无受邀成员。授权和撤权历史由服务端保留。</p>}
        </div>
      </article>}
    </div>}
  </section>;
}
