import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Input, Picker, Text, Textarea, View } from "@tarojs/components";
import {
  ApiClientError,
  RoleSelectionRequiredError,
  formatCentsAsBeans,
  parseBeanAmountToCents,
  type BenefitPlanSubmission,
  type BenefitRosterItem,
  type BenefitSourceFund,
  type ManagedBenefitRoster,
  type ManagedCashWageTeacherDirectory,
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
type Kind = "SOCIAL_INSURANCE" | "HOUSING_FUND";
const kindLabel: Record<Kind, string> = { SOCIAL_INSURANCE: "医社保", HOUSING_FUND: "公积金" };
const global = (s: SessionSnapshot): boolean => {
  const c = s.currentRoleContext;
  return c !== null && c.scope === "GLOBAL" && c.regionId === undefined && c.campusId === undefined && c.venueId === undefined;
};
const readable = (s: SessionSnapshot): boolean => global(s) && ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"].includes(s.currentRoleContext?.subject ?? "");
const authError = (e: unknown): boolean => e instanceof RoleSelectionRequiredError || (e instanceof ApiClientError && [401, 403].includes(e.status));
const monthNow = (): string => { const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).formatToParts(new Date()); return `${p.find(x => x.type === "year")?.value}-${p.find(x => x.type === "month")?.value}-01`; };
const days = (month: string): number => new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
const roleSignature = (s: SessionSnapshot): string => { const c = s.currentRoleContext; return c === null ? "none" : [c.personId, c.subject, c.scope, c.regionId ?? "", c.campusId ?? "", c.venueId ?? ""].join("|"); };
const amount = (value: string): string => parseBeanAmountToCents(value.trim());

export function BenefitPlanPanel({ client, session, sessionKey, onInvalidated, onSaved, onUnconfirmedChange }: Props): ReactNode {
  const [people, setPeople] = useState<ManagedCashWageTeacherDirectory["items"] | null>(null);
  const [funds, setFunds] = useState<readonly BenefitSourceFund[] | null>(null);
  const [month, setMonth] = useState(monthNow);
  const [kind, setKind] = useState<Kind>("SOCIAL_INSURANCE");
  const [personId, setPersonId] = useState("");
  const [executionDay, setExecutionDay] = useState("1");
  const [amountText, setAmountText] = useState("");
  const [fundId, setFundId] = useState("");
  const [active, setActive] = useState(true);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [roster, setRoster] = useState<ManagedBenefitRoster | null>(null);
  const [conflictDraft, setConflictDraft] = useState<BenefitPlanSubmission["draft"] | null>(null);
  const [submission, setSubmission] = useState<BenefitPlanSubmission | null>(null);
  const [phase, setPhase] = useState<"idle" | "pending" | "unknown" | "conflict">("idle");
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const command = useRef<BenefitPlanSubmission | null>(null);
  const activeAttempt = useRef(false);
  const refreshAttempt = useRef(false);
  const currentIdentity = `${sessionKey}:${roleSignature(session)}`;
  const canRead = readable(session);

  const invalidate = (): void => { generation.current += 1; activeAttempt.current = false; refreshAttempt.current = false; command.current = null; setPeople(null); setFunds(null); setRoster(null); setSubmission(null); setConflictDraft(null); setPhase("idle"); onUnconfirmedChange?.(false); onInvalidated?.(); setMessage("登录或身份已失效，请重新登录或选择身份。"); };
  const fail = (e: unknown, fallback: string): void => { if (authError(e) || client.hasRoleContext === false) { invalidate(); return; } setMessage(e instanceof Error ? e.message : fallback); };

  useEffect(() => {
    const token = ++generation.current;
    activeAttempt.current = false; refreshAttempt.current = false; setPeople(null); setFunds(null); setRoster(null); setSubmission(null); setConflictDraft(null); command.current = null; setKind("SOCIAL_INSURANCE"); setMonth(monthNow()); setPersonId(""); setExecutionDay("1"); setAmountText(""); setFundId(""); setActive(true); setReason(""); setPhase("idle"); setMessage("");
    if (!canRead) return () => { generation.current += 1; };
    let live = true;
    Promise.all([client.listManagedCashWageTeachers(), client.listBenefitSourceFunds()]).then(([nextPeople, nextFunds]) => {
      if (!live || generation.current !== token) return;
      setPeople(nextPeople.items); setFunds(nextFunds.items); setPersonId(nextPeople.items[0]?.id ?? ""); setFundId(nextFunds.items[0]?.fundId ?? "");
    }).catch(e => { if (live && generation.current === token) fail(e, "福利计划目录读取失败，请重试。"); });
    return () => { live = false; generation.current += 1; activeAttempt.current = false; refreshAttempt.current = false; };
  }, [client, currentIdentity, canRead, revision]);
  useEffect(() => { onUnconfirmedChange?.(phase !== "idle"); return () => onUnconfirmedChange?.(false); }, [phase, onUnconfirmedChange]);

  const refreshRoster = async (): Promise<void> => {
    if (refreshAttempt.current) return;
    refreshAttempt.current = true;
    const token = generation.current;
    setPhase("conflict"); setRoster(null);
    try { const latest = await client.listManagedBenefitRoster(month); if (generation.current === token) { setRoster(latest); setMessage("计划版本已更新，请核对匹配的最新计划后再提交。"); } }
    catch (e) { if (generation.current === token) { setRoster(null); if (authError(e) || client.hasRoleContext === false) invalidate(); else setMessage(e instanceof Error ? e.message : "最新福利计划读取失败，请重试。"); } }
    finally { if (generation.current === token) refreshAttempt.current = false; }
  };
  const save = async (): Promise<void> => {
    if (activeAttempt.current) return;
    if (phase !== "idle" && submission !== null) { if (phase === "unknown") void execute(submission); return; }
    setMessage("");
    let next: BenefitPlanSubmission;
    try {
      if (!personId || !fundId || !reason.trim()) throw new Error("请选择受益人、资金账户并填写理由。");
      const day = Number(executionDay); if (!Number.isInteger(day) || day < 1 || day > days(month)) throw new Error("执行日必须是该月合法日期。");
      next = client.createBenefitPlanSubmission({ benefitKind: kind, beneficiaryPersonId: personId, benefitMonth: month, executionDay: day, amountCents: amount(amountText), sourceFundId: fundId, active, reason: reason.trim() });
    } catch (e) { fail(e, "输入不符合要求，请修改后重试。"); return; }
    command.current = next; setSubmission(next); setPhase("pending"); await execute(next);
  };
  const execute = async (next: BenefitPlanSubmission): Promise<void> => {
    if (command.current !== next) return;
    const token = generation.current;
    activeAttempt.current = true;
    try { await client.setBenefitPlan(next); if (generation.current !== token || command.current !== next) return; activeAttempt.current = false; command.current = null; setSubmission(null); setPhase("idle"); setMessage("福利计划已保存；本次仅保存计划，不产生已发或已扣豆记录。"); onSaved?.(); }
    catch (e) {
      if (generation.current !== token) return;
      activeAttempt.current = false;
      if (authError(e)) { invalidate(); return; }
      if (e instanceof ApiClientError && e.status === 400) { command.current = null; setSubmission(null); setConflictDraft(null); setPhase("idle"); setMessage(e.message || "输入不符合要求，请修改后重试。"); return; }
      if (e instanceof ApiClientError && e.status === 409) { command.current = null; setSubmission(null); setConflictDraft(next.draft); await refreshRoster(); return; }
      setPhase("unknown"); setMessage("福利计划结果未确认，请使用原提交重试。");
    }
  };

  if (!canRead) return <View className="panel"><Text>当前身份没有维护总部福利计划的权限。</Text></View>;
  const locked = phase !== "idle";
  const selectedRoster: readonly BenefitRosterItem[] = roster?.items ?? [];
  const matchingRoster = conflictDraft === null ? [] : selectedRoster.filter(item => item.benefitKind === conflictDraft.benefitKind && item.beneficiaryPersonId === conflictDraft.beneficiaryPersonId && item.benefitMonth === conflictDraft.benefitMonth);
  if (people === null || funds === null) return <View className="panel"><Text>{message || "正在读取福利计划目录…"}</Text>{message && <Button onClick={() => setRevision(v => v + 1)}>重试读取目录</Button>}</View>;
  if (people.length === 0 || funds.length === 0) return <View className="panel"><Text>{people.length === 0 ? "当前身份下没有可维护的人员名单。" : "当前没有有效的福利扣费资金账户。"}</Text><Button onClick={() => setRevision(v => v + 1)}>重试读取目录</Button></View>;
  return <View className="panel" data-benefit-plan-panel="true">
    <Text className="panel-title">福利计划</Text>
    <Text>福利类型</Text><Picker mode="selector" range={Object.values(kindLabel)} value={Object.keys(kindLabel).indexOf(kind)} disabled={locked} onChange={e => setKind(Object.keys(kindLabel)[Number(e.detail.value)] as Kind)}><View><Text>{kindLabel[kind]}</Text></View></Picker>
    <Text>受益人</Text><Picker mode="selector" range={people.map(x => x.nickname)} value={Math.max(0, people.findIndex(x => x.id === personId))} disabled={locked} onChange={e => setPersonId(people[Number(e.detail.value)]?.id ?? "")}><View><Text>{people.find(x => x.id === personId)?.nickname ?? "请选择"}</Text></View></Picker>
    <Text>福利月份</Text><Picker mode="date" fields="month" value={month.slice(0, 7)} disabled={locked} onChange={e => setMonth(`${e.detail.value}-01`)}><View><Text>{month.slice(0, 7)}</Text></View></Picker>
    <Text>当月执行日</Text><Input value={executionDay} disabled={locked} onInput={e => setExecutionDay(e.detail.value)} />
    <Text>金额（欢乐豆）</Text><Input value={amountText} disabled={locked} onInput={e => setAmountText(e.detail.value)} />
    <Text>扣豆资金账户</Text><Picker mode="selector" range={funds.map(x => `${x.displayName}（${x.code}）`)} value={Math.max(0, funds.findIndex(x => x.fundId === fundId))} disabled={locked} onChange={e => setFundId(funds[Number(e.detail.value)]?.fundId ?? "")}><View><Text>{funds.find(x => x.fundId === fundId)?.displayName ?? "请选择"}</Text></View></Picker>
    <Text>启用</Text><Button size="mini" disabled={locked} onClick={() => setActive(v => !v)}>{active ? "已启用" : "已停用"}</Button>
    <Text>理由</Text><Textarea value={reason} disabled={locked} onInput={e => setReason(e.detail.value)} />
    <Button disabled={locked} onClick={() => void save()}>{phase === "pending" ? "保存中…" : phase === "unknown" ? "结果未确认" : "保存福利计划"}</Button>
    {phase === "unknown" && <Button onClick={() => void save()}>使用原提交重试</Button>}
    {message && <Text>{message}</Text>}
    {phase === "conflict" && roster === null && <Button onClick={() => void refreshRoster()}>重试读取最新计划</Button>}
    {conflictDraft !== null && roster !== null && <View className="benefit-plan-latest"><Text>当前月匹配计划（请人工核对）</Text>{matchingRoster.length === 0 && <Text>最新名单中无该计划，请确认后再建立新计划。</Text>}{matchingRoster.map(item => <View key={`${item.benefitKind}:${item.beneficiaryPersonId}`}><Text>{kindLabel[item.benefitKind]} · {item.beneficiaryDisplayName} · 第 {item.currentPlan.version} 版 · {item.currentPlan.executionDay} 日 · {formatCentsAsBeans(item.currentPlan.amountCents)} 欢乐豆 · {item.currentPlan.sourceFund.displayName}（{item.currentPlan.sourceFund.code}）· {item.currentPlan.active ? "启用" : "停用"}</Text></View>)}<Button onClick={() => { setConflictDraft(null); setRoster(null); setPhase("idle"); setMessage("已完成人工核对，请修改或重新提交。"); }}>我已核对，允许重新提交</Button></View>}
  </View>;
}
