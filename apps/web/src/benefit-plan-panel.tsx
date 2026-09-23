import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ApiClientError,
  formatCentsAsBeans,
  parseBeanAmountToCents,
  RoleSelectionRequiredError,
  type BenefitPlanSubmission,
  type ManagedBenefitRoster,
  type SessionSnapshot,
  type TeacherApiClient,
} from "@teaching-research-alliance/client";

type Props = {
  client: TeacherApiClient;
  session: SessionSnapshot;
  sessionKey: string;
  onInvalidated?: () => void;
  onSaved?: () => void;
  onUnconfirmedChange?: (pending: boolean) => void;
};

const monthNow = (): string => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  return `${parts.find((part) => part.type === "year")?.value ?? "2026"}-${parts.find((part) => part.type === "month")?.value ?? "01"}-01`;
};
const daysInMonth = (month: string): number => {
  const [year, value] = month.slice(0, 7).split("-").map(Number);
  return Number.isInteger(year) && Number.isInteger(value) ? new Date(Date.UTC(year ?? 2026, value ?? 1, 0)).getUTCDate() : 31;
};
const authorized = (session: SessionSnapshot): boolean => {
  const context = session.currentRoleContext;
  return context?.scope === "GLOBAL" && context.regionId === undefined && context.campusId === undefined && context.venueId === undefined && ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"].includes(context.subject);
};
const authError = (cause: unknown): boolean => cause instanceof RoleSelectionRequiredError || cause instanceof ApiClientError && [401, 403].includes(cause.status) || typeof cause === "object" && cause !== null && [401, 403].includes((cause as { status?: number }).status ?? 0);

export function BenefitPlanPanel({ client, session, sessionKey, onInvalidated, onSaved, onUnconfirmedChange }: Props): ReactNode {
  const [month, setMonth] = useState(monthNow);
  const [people, setPeople] = useState<readonly { id: string; nickname: string }[] | null>(null);
  const [funds, setFunds] = useState<readonly { fundId: string; code: string; displayName: string }[] | null>(null);
  const [roster, setRoster] = useState<ManagedBenefitRoster | null>(null);
  const [kind, setKind] = useState<"SOCIAL_INSURANCE" | "HOUSING_FUND">("SOCIAL_INSURANCE");
  const [personId, setPersonId] = useState("");
  const [executionDay, setExecutionDay] = useState("1");
  const [amount, setAmount] = useState("");
  const [fundId, setFundId] = useState("");
  const [active, setActive] = useState(true);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "pending" | "unknown">("idle");
  const [submission, setSubmission] = useState<BenefitPlanSubmission | null>(null);
  const [conflict, setConflict] = useState(false);
  const [conflictReady, setConflictReady] = useState(false);
  const [conflictTarget, setConflictTarget] = useState<{ kind: string; personId: string; month: string } | null>(null);
  const [refreshingRoster, setRefreshingRoster] = useState(false);
  const [postSaveRefreshError, setPostSaveRefreshError] = useState(false);
  const [directoryRevision, setDirectoryRevision] = useState(0);
  const generation = useRef(0);
  const writeLock = useRef(false);
  const refreshLock = useRef(false);
  const context = session.currentRoleContext;
  const identitySignature = [sessionKey, context?.personId ?? "", context?.subject ?? "", context?.scope ?? "", context?.regionId ?? "", context?.campusId ?? "", context?.venueId ?? ""].join("|");
  const canRead = authorized(session);
  const maxDay = daysInMonth(month);

  const reset = (): void => {
    generation.current += 1;
    writeLock.current = false;
    refreshLock.current = false;
    setPeople(null); setFunds(null); setRoster(null); setKind("SOCIAL_INSURANCE"); setPersonId(""); setExecutionDay("1"); setAmount(""); setFundId(""); setActive(true); setReason(""); setSubmission(null); setState("idle"); setConflict(false); setConflictReady(false); setConflictTarget(null); setRefreshingRoster(false); setPostSaveRefreshError(false); setMessage("");
  };
  const invalidate = (cause: unknown): void => {
    if (authError(cause)) {
      reset();
      setMessage("登录或身份已失效，请重新登录或选择身份。");
      onInvalidated?.();
    } else setMessage(cause instanceof Error ? cause.message : "福利计划读取失败，请重试。");
  };
  const load = (): void => {
    const token = ++generation.current;
    writeLock.current = false;
    refreshLock.current = false;
    setPeople(null); setFunds(null); setRoster(null); setKind("SOCIAL_INSURANCE"); setPersonId(""); setExecutionDay("1"); setAmount(""); setFundId(""); setActive(true); setReason(""); setSubmission(null); setState("idle"); setConflict(false); setConflictReady(false); setConflictTarget(null); setRefreshingRoster(false); setPostSaveRefreshError(false); setMessage("");
    if (!canRead) return;
    if (client.hasRoleContext === false) { invalidate(new ApiClientError(401, "AUTH")); return; }
    void Promise.all([client.listManagedCashWageTeachers(), client.listBenefitSourceFunds(), client.listManagedBenefitRoster(month)])
      .then(([nextPeople, nextFunds, nextRoster]) => { if (generation.current !== token) return; setPeople(nextPeople.items); setFunds(nextFunds.items); setRoster(nextRoster); })
      .catch((cause) => { if (generation.current === token) invalidate(cause); });
  };
  useEffect(() => { load(); return () => { generation.current += 1; writeLock.current = false; refreshLock.current = false; }; }, [client, identitySignature, canRead, month, directoryRevision]);
  useEffect(() => { onUnconfirmedChange?.(state !== "idle" || conflict || refreshingRoster); return () => onUnconfirmedChange?.(false); }, [state, conflict, refreshingRoster, onUnconfirmedChange]);

  const refreshRoster = async (token: number): Promise<void> => {
    if (refreshLock.current) return;
    refreshLock.current = true;
    setRefreshingRoster(true);
    setConflictReady(false);
    try {
      const latest = await client.listManagedBenefitRoster(month);
      if (generation.current === token) { setRoster(latest); setConflictReady(true); setMessage("福利计划版本已变化，最新计划已读取，请人工核对后再提交。"); }
    } catch (cause) {
      if (generation.current !== token) return;
      setConflictReady(false);
      if (authError(cause)) invalidate(cause); else setMessage("无法读取最新福利计划，请重试读取。");
    } finally {
      if (generation.current === token) { refreshLock.current = false; setRefreshingRoster(false); }
    }
  };
  const refreshAfterSave = async (token: number): Promise<void> => {
    if (refreshLock.current) return;
    refreshLock.current = true;
    setRefreshingRoster(true);
    try {
      const latest = await client.listManagedBenefitRoster(month);
      if (generation.current === token) { setRoster(latest); setPostSaveRefreshError(false); setMessage("福利计划已保存；本次仅保存计划，不扣豆。"); }
    } catch (cause) {
      if (generation.current !== token) return;
      if (authError(cause)) invalidate(cause);
      else { setPostSaveRefreshError(true); setMessage("福利计划已保存，但最新名单刷新失败，可重试读取。"); }
    } finally {
      if (generation.current === token) { refreshLock.current = false; setRefreshingRoster(false); }
    }
  };
  const save = async (): Promise<void> => {
    if (writeLock.current || refreshLock.current || state === "pending" || conflict) return;
    const token = generation.current;
    let next = submission;
    try {
      if (!next) {
        if (!personId || !fundId || !reason.trim()) throw new Error("请选择受益人、资金账户并填写理由。");
        const day = Number(executionDay);
        if (!Number.isSafeInteger(day) || day < 1 || day > maxDay) throw new Error("请输入该月合法执行日。");
        next = client.createBenefitPlanSubmission({ benefitKind: kind, beneficiaryPersonId: personId, benefitMonth: month, executionDay: day, amountCents: parseBeanAmountToCents(amount.trim()), sourceFundId: fundId, active, reason: reason.trim() });
        setSubmission(next);
      }
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "输入不符合要求，请修改后重试。"); return; }
    writeLock.current = true; setState("pending"); setMessage("");
    try {
      await client.setBenefitPlan(next);
      if (generation.current !== token) return;
      writeLock.current = false; setSubmission(null); setState("idle"); setConflict(false); setConflictReady(false); setConflictTarget(null); setPostSaveRefreshError(false); setMessage("福利计划已保存；本次仅保存计划，不扣豆。"); onSaved?.();
      void refreshAfterSave(token);
    } catch (cause) {
      if (generation.current !== token) return;
      writeLock.current = false;
      if (authError(cause)) { setState("idle"); invalidate(cause); return; }
      if (cause instanceof ApiClientError && cause.status === 400) { setSubmission(null); setState("idle"); setMessage(cause.message || "输入不符合要求，请修改后重试。"); return; }
      if (cause instanceof ApiClientError && cause.status === 409) { setConflictTarget({ kind: next.draft.benefitKind, personId: next.draft.beneficiaryPersonId, month: next.draft.benefitMonth }); setSubmission(null); setState("idle"); setConflict(true); setConflictReady(false); setMessage("福利计划版本已变化，正在读取最新计划，请人工核对。"); void refreshRoster(token); return; }
      setState("unknown"); setMessage("福利计划结果未确认，请使用原提交重试。");
    }
  };

  if (!canRead) return <section className="panel" aria-label="福利计划维护"><h2>福利计划</h2><p>当前身份没有维护总部福利计划的权限。</p></section>;
  const locked = state !== "idle" || conflict || refreshingRoster || people?.length === 0 || funds?.length === 0;
  const matchedConflict = conflictTarget && roster?.items.find((item) => item.benefitKind === conflictTarget.kind && item.beneficiaryPersonId === conflictTarget.personId && item.benefitMonth === conflictTarget.month);
  return <section className="panel" aria-label="福利计划维护"><h2>福利计划维护</h2>{people === null || funds === null || roster === null ? <><p role="status">{message || "正在读取福利计划目录…"}</p>{message && <button type="button" onClick={() => setDirectoryRevision((value) => value + 1)}>重试读取目录</button>}</> : <><div aria-label="最新福利计划"><h3>当前月计划</h3>{conflict ? conflictReady ? matchedConflict ? <p>{matchedConflict.beneficiaryDisplayName} · {matchedConflict.benefitMonth.slice(0, 7)} · v{matchedConflict.currentPlan.version} · {matchedConflict.currentPlan.executionDay}日 · {formatCentsAsBeans(matchedConflict.currentPlan.amountCents)} 欢乐豆 · 账户 {matchedConflict.currentPlan.sourceFund.displayName}（{matchedConflict.currentPlan.sourceFund.code}）· {matchedConflict.currentPlan.active ? "启用" : "停用"}</p> : <p role="alert">最新名单中无该计划，请确认后再提交。</p> : <p role="status">正在读取最新福利计划，请勿提交。</p> : roster.items.length === 0 ? <p>当前月暂无计划。</p> : roster.items.map((item) => <p key={`${item.benefitKind}:${item.beneficiaryPersonId}`}>{item.beneficiaryDisplayName} · {item.benefitKind === "SOCIAL_INSURANCE" ? "医社保" : "公积金"} · v{item.currentPlan.version} · {item.currentPlan.executionDay}日 · {formatCentsAsBeans(item.currentPlan.amountCents)} 欢乐豆</p>)}</div>{people.length === 0 && <p role="alert">当前身份下暂无可选受益人。</p>}{funds.length === 0 && <p role="alert">当前业务时点暂无可用福利扣费账户。</p>}{(people.length === 0 || funds.length === 0) && <button type="button" onClick={() => setDirectoryRevision((value) => value + 1)}>重试读取目录</button>}<form onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <label>福利类型<select aria-label="福利类型" value={kind} disabled={locked} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="SOCIAL_INSURANCE">医社保</option><option value="HOUSING_FUND">公积金</option></select></label>
    <label>受益人<select aria-label="受益人" value={personId} disabled={locked} onChange={(event) => setPersonId(event.target.value)}><option value="">请选择</option>{people.map((person) => <option value={person.id} key={person.id}>{person.nickname}</option>)}</select></label>
    <label>福利月份<input aria-label="福利月份" type="month" value={month.slice(0, 7)} disabled={locked} onChange={(event) => { setMonth(`${event.target.value}-01`); setExecutionDay("1"); }} /></label>
    <label>执行日<input aria-label="执行日" type="number" min="1" max={maxDay} value={executionDay} disabled={locked} onChange={(event) => setExecutionDay(event.target.value)} /></label>
    <label>金额（欢乐豆）<input aria-label="金额（欢乐豆）" inputMode="decimal" value={amount} disabled={locked} onChange={(event) => setAmount(event.target.value)} /></label>
    <label>扣费账户<select aria-label="扣费账户" value={fundId} disabled={locked} onChange={(event) => setFundId(event.target.value)}><option value="">请选择</option>{funds.map((fund) => <option value={fund.fundId} key={fund.fundId}>{fund.displayName}（{fund.code}）</option>)}</select></label>
    <label><input type="checkbox" checked={active} disabled={locked} onChange={(event) => setActive(event.target.checked)} />启用福利计划</label>
    <label>理由<textarea aria-label="理由" required value={reason} disabled={locked} onChange={(event) => setReason(event.target.value)} /></label>
    {conflict && <>{conflictReady ? <><p role="alert">请核对最新计划与版本后再提交。</p><button type="button" disabled={state !== "idle"} onClick={() => { setConflict(false); setConflictTarget(null); }}>已核对最新版本</button></> : <><p role="status">{message || "正在读取最新福利计划，请勿提交。"}</p><button type="button" onClick={() => { const token = generation.current; void refreshRoster(token); }}>重试读取最新计划</button></>}</>}
    {postSaveRefreshError && !conflict && <button type="button" disabled={refreshingRoster} onClick={() => { setPostSaveRefreshError(false); const token = generation.current; void refreshAfterSave(token); }}>{refreshingRoster ? "读取中…" : "重试读取最新计划/名单"}</button>}
    <button type="submit" disabled={locked}>{state === "pending" ? "保存中…" : state === "unknown" ? "结果未确认" : "保存计划"}</button>
    {state === "unknown" && <button type="button" onClick={() => void save()}>使用原提交重试</button>}
    <p>保存计划，不扣豆。</p>{message && <p role="status">{message}</p>}
  </form></>}</section>;
}
