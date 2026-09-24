import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiClientError, type ManagedRoleAssignment, type PersonBusinessIdentityDraft, type PersonProfileDraft, type PersonResponsibilityDirectoryItem, type RoleAssignmentDraft, type SessionSnapshot, type TeacherApiClient } from "@teaching-research-alliance/client";
import { Button } from "./components/ui/button.js";

export type PersonResponsibility = ManagedRoleAssignment;

type Props = Readonly<{ client: TeacherApiClient; session: SessionSnapshot; sessionKey: string; active: boolean; busy?: boolean; onUnconfirmedChange?: (value: boolean) => void; onInvalidated: () => void }>;
type Pending = Readonly<{ label: string; execute: () => Promise<Readonly<{ replay?: boolean }>>; successMessage?: string }>;

const scopeBySubject: Readonly<Record<string, string>> = {
  TEACHER: "SELF", TEACHING_TEACHER: "SELF", ACADEMIC_PLANNER: "SELF",
  GROUP_LEADER: "ASSOCIATED_TEACHERS", TEACHING_MENTOR: "MENTEES", PLANNING_MENTOR: "SELF",
  HEADQUARTERS_FINANCE: "GLOBAL", REGION_FINANCE: "REGION", CAMPUS_PRINCIPAL: "CAMPUS", VENUE_OWNER: "VENUE", SYSTEM_ADMIN: "GLOBAL"
};
const subjectLabel: Readonly<Record<string, string>> = {
  TEACHER: "普通老师", TEACHING_TEACHER: "授课老师", ACADEMIC_PLANNER: "学业规划师", GROUP_LEADER: "教研组长", TEACHING_MENTOR: "指导导师", PLANNING_MENTOR: "学业规划导师", HEADQUARTERS_FINANCE: "总部财务", REGION_FINANCE: "分区财务", CAMPUS_PRINCIPAL: "运营校长", VENUE_OWNER: "场地运营", SYSTEM_ADMIN: "系统管理员", SYSTEM_OWNER: "开发者"
};
const scopeLabel: Readonly<Record<string, string>> = { SELF: "本人", GLOBAL: "全局", REGION: "分区", CAMPUS: "校区", VENUE: "场地", ASSOCIATED_TEACHERS: "关联老师", MENTEES: "指导对象" };
const needsScopeId = (scope: string): boolean => scope === "REGION" || scope === "CAMPUS" || scope === "VENUE";
const canChangeOpenAssignment = (assignment: PersonResponsibility): boolean => assignment.validTo === undefined;
const isFutureAssignment = (assignment: PersonResponsibility): boolean => new Date(assignment.validFrom).getTime() > Date.now();
const hasCurrentSystemIdentity = (person: PersonResponsibilityDirectoryItem): boolean => person.responsibilities.some((assignment) => {
  if (!["SYSTEM_OWNER", "SYSTEM_ADMIN"].includes(assignment.subject)) return false;
  if (assignment.validTo === assignment.validFrom) return false;
  return assignment.validTo === undefined || new Date(assignment.validTo).getTime() > Date.now();
});

export const canManagePersonnel = (session: SessionSnapshot): boolean => {
  const c = session.currentRoleContext;
  return c !== null && c.scope === "GLOBAL" && c.regionId === undefined && c.campusId === undefined && c.venueId === undefined && ["SYSTEM_OWNER", "SYSTEM_ADMIN"].includes(c.subject);
};
const isAccessLoss = (error: unknown): boolean => error instanceof ApiClientError && (error.status === 401 || error.status === 403);
const isConfirmedRejection = (error: unknown): boolean => error instanceof ApiClientError && error.status >= 400 && error.status < 500 && !isAccessLoss(error);
const toInstant = (date: string): string => `${date}T00:00:00.000Z`;
const today = (): string => new Date().toISOString().slice(0, 10);
const identityLabel: Readonly<Record<PersonBusinessIdentityDraft["businessIdentity"], string>> = { TEACHING_TEACHER: "授课老师", ACADEMIC_PLANNER: "学业规划师" };
const blockerLabel: Readonly<Record<string, string>> = { MISSING_GRADE_SUBJECT: "缺少教学学科", PERSON_INACTIVE: "人员已停用", ACCOUNT_INACTIVE: "账户已停用", PROFILE_EMPLOYMENT_INACTIVE: "任职资料已停用", SETTLEMENT_ACCOUNT_MISSING: "缺少结算账户", CAMPUS_ASSIGNMENT_REQUIRED: "需要校区归属", CAMPUS_REGION_MISMATCH: "校区与分区不匹配", PENDING_RECEIVED_REFERRALS: "存在待处理转介", ACTIVE_GROUP_LEADER_RELATIONSHIP: "存在有效教研组长关系", ACTIVE_TEACHING_MENTOR_RELATIONSHIP: "存在有效授课指导关系", ACTIVE_PLANNING_MENTOR_RELATIONSHIP: "存在有效规划指导关系", SYSTEM_IDENTITY_PROTECTED: "系统身份受保护", READINESS_BLOCKED: "前置条件未就绪", ACTIVE_RELATIONSHIPS: "存在有效关系", ACTIVE_SETTLEMENTS: "存在已生效结算" };
const blockersFor = (person: PersonResponsibilityDirectoryItem, target: PersonBusinessIdentityDraft["businessIdentity"]): readonly { code: string; count: number }[] => person.businessIdentityBlockers[target];
const blockerText = (items: readonly { code: string; count: number }[]): string => items.map((item) => `${blockerLabel[item.code] ?? item.code} × ${item.count}`).join("、");

/** Management data deliberately omits every finance and credential field. */
export function PersonResponsibilityPanel({ client, session, sessionKey, active, busy = false, onUnconfirmedChange, onInvalidated }: Props): ReactNode {
  const [people, setPeople] = useState<readonly PersonResponsibilityDirectoryItem[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [subject, setSubject] = useState("HEADQUARTERS_FINANCE");
  const [scopeId, setScopeId] = useState("");
  const [validFrom, setValidFrom] = useState(today());
  const [reason, setReason] = useState("");
  const [nickname, setNickname] = useState("");
  const [legalName, setLegalName] = useState("");
  const [businessIdentity, setBusinessIdentity] = useState<PersonBusinessIdentityDraft["businessIdentity"]>("TEACHING_TEACHER");
  const [gradeSubject, setGradeSubject] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const generation = useRef(0);
  const pending = useRef<Pending | null>(null);
  const allowed = canManagePersonnel(session);
  const owner = session.currentRoleContext?.subject === "SYSTEM_OWNER";
  const selected = useMemo(() => people.find((item) => item.personId === selectedId) ?? null, [people, selectedId]);
  useEffect(() => { setNickname(selected?.nickname ?? ""); setLegalName(selected?.legalName ?? ""); }, [selected]);
  useEffect(() => { setBusinessIdentity(selected?.businessIdentity ?? "TEACHING_TEACHER"); setGradeSubject(selected?.gradeSubject ?? ""); }, [selected]);
  const candidates = Object.keys(scopeBySubject).filter((item) => !["TEACHER", "TEACHING_TEACHER", "ACADEMIC_PLANNER", "VENUE_OWNER"].includes(item) && (owner || item !== "SYSTEM_ADMIN"));
  const scope = scopeBySubject[subject] ?? "SELF";
  const locked = busy || loading || submitting || pending.current !== null;
  const systemIdentityProtected = !owner && selected !== null && hasCurrentSystemIdentity(selected);
  const canEditSelected = selected !== null && !systemIdentityProtected;
  const canChangeSelectedStatus = canEditSelected && !(owner && selected?.personId === session.personId);
  const canRevoke = (assignment: PersonResponsibility): boolean => canEditSelected && canChangeOpenAssignment(assignment) && !["SYSTEM_OWNER", "TEACHER", "TEACHING_TEACHER", "ACADEMIC_PLANNER", "VENUE_OWNER"].includes(assignment.subject) && (owner || assignment.subject !== "SYSTEM_ADMIN");
  useEffect(() => { if (!candidates.includes(subject)) setSubject(candidates[0] ?? "HEADQUARTERS_FINANCE"); }, [owner]);

  const reset = (): void => { generation.current += 1; pending.current = null; onUnconfirmedChange?.(false); setPeople([]); setSelectedId(""); setNotice(""); setLoading(false); setSubmitting(false); };
  const invalidate = (): void => { reset(); onInvalidated(); };
  const load = async (): Promise<void> => {
    if (!active || !allowed) return;
    const token = ++generation.current;
    setLoading(true);
    try {
      const result = await client.listPeople();
      if (token !== generation.current) return;
      setPeople(result);
      setSelectedId((current) => result.some((item) => item.personId === current) ? current : result[0]?.personId ?? "");
    } catch (error) {
      if (token !== generation.current) return;
      if (isAccessLoss(error) || !client.hasRoleContext) { invalidate(); return; }
      setNotice("人员目录暂未加载，请稍后刷新。");
    } finally { if (token === generation.current) setLoading(false); }
  };
  useEffect(() => { reset(); if (active && allowed) void load(); return () => { generation.current += 1; onUnconfirmedChange?.(false); }; }, [client, sessionKey, active, allowed]);

  const execute = async (next: Pending): Promise<void> => {
    const token = generation.current;
    pending.current = next; onUnconfirmedChange?.(true); setSubmitting(true); setNotice("");
    try {
      const result = await next.execute();
      if (token !== generation.current) return;
      pending.current = null; onUnconfirmedChange?.(false); setSubmitting(false); setNotice(result.replay ? next.successMessage ? `${next.successMessage}（请求已确认，未重复执行）` : `${next.label}已确认，未重复执行。` : next.successMessage ?? `${next.label}已保存，相关旧会话已失效。`); setReason(""); await load();
    } catch (error) {
      if (token !== generation.current) return;
      if (isAccessLoss(error) || !client.hasRoleContext) { invalidate(); return; }
      if (isConfirmedRejection(error)) { pending.current = null; onUnconfirmedChange?.(false); setNotice(error instanceof ApiClientError && error.status === 409 ? "资料已被其他操作更新或昵称已冲突，请刷新目录后重新核对。" : "服务器未接受本次变更。请刷新目录，核对人员、职责和生效范围后重新填写。"); }
      else setNotice("操作结果尚未确认。原内容已锁定，请使用原按钮安全重试。");
    } finally { if (token === generation.current) setSubmitting(false); }
  };
  const retry = (): void => { if (pending.current) void execute(pending.current); };
  const assign = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault(); if (!selected || locked) return;
    if (!reason.trim() || (needsScopeId(scope) && !scopeId.trim())) { setNotice(scopeId.trim() ? "请填写任命理由。" : "此职责需要填写对应范围编号和任命理由。"); return; }
    const draft: RoleAssignmentDraft = { personId: selected.personId, subject: subject as RoleAssignmentDraft["subject"], scope: scope as RoleAssignmentDraft["scope"], ...(needsScopeId(scope) ? { scopeId: scopeId.trim() } : {}), validFrom: toInstant(validFrom), reason: reason.trim() };
    const command = client.createRoleAssignmentSubmission(draft);
    void execute({ label: `“${subjectLabel[subject] ?? subject}”任命`, execute: () => client.assignRole(command) });
  };
  const revoke = (assignment: PersonResponsibility): void => {
    if (!selected || locked) return;
    if (!reason.trim()) { setNotice("请先填写撤销理由。 "); return; }
    const future = isFutureAssignment(assignment);
    const command = client.createRoleRevocationSubmission({ assignmentId: assignment.assignmentId, reason: reason.trim() });
    void execute({ label: `“${subjectLabel[assignment.subject] ?? assignment.subject}”${future ? "取消任命" : "撤销"}`, execute: () => client.revokeRole(command) });
  };
  const toggleStatus = (): void => {
    if (!selected || locked) return;
    if (!reason.trim()) { setNotice("请先填写停用或恢复理由。 "); return; }
    const status = selected.personStatus === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    const command = client.createPersonStatusSubmission({ personId: selected.personId, status, reason: reason.trim() });
    void execute({ label: status === "INACTIVE" ? "人员停用" : "人员恢复", execute: () => client.setPersonStatus(command) });
  };
  const correctProfile = (): void => {
    if (!selected || locked) return;
    const nextNickname = nickname.trim(); const nextLegalName = legalName.trim();
    if (!reason.trim()) { setNotice("请填写资料更正理由。"); return; }
    if (!nextNickname || !nextLegalName) { setNotice("请填写昵称和真实姓名。"); return; }
    if (nextNickname === selected.nickname && nextLegalName === selected.legalName) { setNotice("请至少修改昵称或真实姓名一项。"); return; }
    const submission = client.createPersonProfileSubmission({ personId: selected.personId, nickname: nextNickname, legalName: nextLegalName, expectedProfileVersion: selected.profileVersion, reason: reason.trim() } satisfies PersonProfileDraft);
    void execute({ label: "人员资料更正", successMessage: "资料已保存，人员编号、账户和职责未变化。", execute: () => client.updatePersonProfile(submission) });
  };
  const updateBusinessIdentity = (): void => {
    if (!selected || locked) return;
    if (!reason.trim()) { setNotice("请填写业务身份变更理由。"); return; }
    if (businessIdentity === "TEACHING_TEACHER" && !gradeSubject.trim()) { setNotice("授课老师业务身份必须填写教学学科。"); return; }
    const blockers = blockersFor(selected, businessIdentity);
    if (blockers.length > 0) { setNotice(`当前目标身份被阻断（${blockers.reduce((sum, item) => sum + item.count, 0)}项）：${blockerText(blockers)}`); return; }
    if (selected.businessIdentity === businessIdentity) { setNotice("目标业务身份与当前身份相同，无需保存。"); return; }
    const submission = client.createPersonBusinessIdentitySubmission({ personId: selected.personId, businessIdentity, ...(businessIdentity === "TEACHING_TEACHER" ? { gradeSubject: gradeSubject.trim() } : {}), expectedBusinessIdentityVersion: selected.businessIdentityVersion, reason: reason.trim() });
    void execute({ label: "业务身份变更", successMessage: "业务身份已保存，历史推荐和费用不重算。", execute: () => client.updatePersonBusinessIdentity(submission) });
  };

  if (!allowed) return null;
  return <section className="panel person-responsibility-panel" aria-label="人员与职责" hidden={!active}>
    <div className="section-heading"><div><p className="eyebrow">PEOPLE & RESPONSIBILITIES</p><h2>人员与职责</h2><p>维护可登录状态与职责生效范围。此处不展示工资、银行卡、余额或登录凭据。</p></div><Button type="button" variant="outline" disabled={locked} onClick={() => void load()}>刷新目录</Button></div>
    {notice !== "" && <p role="status" className="account-access-notice">{notice}</p>}
    {pending.current !== null && <Button type="button" disabled={submitting || loading} onClick={retry}>安全重试原操作</Button>}
    {loading ? <p>正在读取人员目录…</p> : people.length === 0 ? <p>当前没有可管理人员。</p> : <>
      <label>目标人员<select aria-label="目标人员" disabled={locked} value={selectedId} onChange={(event) => { setSelectedId(event.target.value); setNotice(""); }}><option value="">请选择人员</option>{people.map((item) => <option key={item.personId} value={item.personId}>{item.nickname} · {item.personStatus === "ACTIVE" && item.loginStatus !== "REVOKED" ? "可登录" : "已停用"}</option>)}</select></label>
      {selected && <div className="person-responsibility-layout"><article className="account-directory"><h3>{selected.nickname}</h3><p>人员状态：{selected.personStatus === "ACTIVE" ? "启用" : "已停用"} · 账号：{selected.loginStatus === "REVOKED" ? "不可登录" : "可登录"}</p><h3>当前与历史职责</h3>{selected.responsibilities.length === 0 ? <p>暂无已任命职责。</p> : <ul>{selected.responsibilities.map((item) => <li key={item.assignmentId}><span>{subjectLabel[item.subject] ?? item.subject} · {scopeLabel[item.scope] ?? item.scope}{item.scopeId ? `（${item.scopeId}）` : ""} · {item.validFrom.slice(0, 10)} 至 {item.validTo?.slice(0, 10) ?? "持续有效"}</span>{canRevoke(item) ? <Button type="button" variant="outline" disabled={locked} onClick={() => revoke(item)}>{isFutureAssignment(item) ? "取消任命" : "撤销职责"}</Button> : null}</li>)}</ul>}</article>
        {systemIdentityProtected ? <p className="account-access-notice">仅开发者可管理系统身份。</p> : <div className="person-responsibility-actions"><h3>业务身份</h3><p>当前身份：{(selected.businessIdentity && identityLabel[selected.businessIdentity]) ?? "未配置"}</p><label>目标业务身份<select aria-label="目标业务身份" value={businessIdentity} disabled={locked} onChange={(event) => setBusinessIdentity(event.target.value as PersonBusinessIdentityDraft["businessIdentity"])}>{(Object.keys(identityLabel) as PersonBusinessIdentityDraft["businessIdentity"][]).map((item) => <option key={item} value={item}>{identityLabel[item]}</option>)}</select></label>{businessIdentity === "TEACHING_TEACHER" && <label>教学学科<input aria-label="教学学科" value={gradeSubject} disabled={locked} onChange={(event) => setGradeSubject(event.target.value)} /></label>}<p>阻断项：{blockersFor(selected, businessIdentity).reduce((sum, item) => sum + item.count, 0)} 项{blockersFor(selected, businessIdentity).length > 0 ? `（${blockerText(blockersFor(selected, businessIdentity))}）` : ""}</p><Button type="button" variant="outline" disabled={locked || blockersFor(selected, businessIdentity).length > 0 || selected.businessIdentity === businessIdentity || (businessIdentity === "TEACHING_TEACHER" && !gradeSubject.trim())} onClick={updateBusinessIdentity}>保存业务身份</Button><h3>人员资料</h3><label>展示昵称<input aria-label="展示昵称" value={nickname} disabled={locked} onChange={(event) => setNickname(event.target.value)} /></label><label>真实姓名<input aria-label="真实姓名" value={legalName} disabled={locked} onChange={(event) => setLegalName(event.target.value)} /></label><label>变更理由<textarea aria-label="人员职责变更理由" value={reason} maxLength={1000} disabled={locked} onChange={(event) => setReason(event.target.value)} placeholder="说明本次资料、任命、撤销或停用的业务原因" /></label><Button type="button" variant="outline" disabled={locked} onClick={correctProfile}>保存人员资料</Button>{canChangeSelectedStatus && <Button type="button" variant="outline" disabled={locked} onClick={toggleStatus}>{selected.personStatus === "ACTIVE" ? "停用人员并注销会话" : "恢复人员登录"}</Button>}{selected.personStatus === "INACTIVE" ? <p className="account-access-notice">人员已停用，请先恢复后再任命职责。</p> : <form onSubmit={assign}><h3>任命职责</h3><fieldset disabled={locked}><label>职责<select aria-label="职责" value={subject} onChange={(event) => { setSubject(event.target.value); setScopeId(""); }}>{candidates.map((item) => <option key={item} value={item}>{subjectLabel[item]}</option>)}</select></label><p>生效范围：{scopeLabel[scope] ?? scope}</p>{needsScopeId(scope) && <label>{scopeLabel[scope] ?? scope}编号<input aria-label="职责范围编号" value={scopeId} onChange={(event) => setScopeId(event.target.value)} /></label>}<label>生效日期<input aria-label="职责生效日期" type="date" value={validFrom} onChange={(event) => setValidFrom(event.target.value)} /></label></fieldset><Button type="submit" disabled={locked}>确认任命</Button></form>}</div>}</div>}
    </>}
  </section>;
}
