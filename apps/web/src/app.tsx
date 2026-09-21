import { useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  ApiClientError,
  formatCentsAsBeans,
  parseBeanAmountToCents,
  RoleSelectionRequiredError,
  StaleResponseError,
  TeacherApiClient,
  type ReceivingTeacher,
  type ReferralCreationSubmission,
  type SentReferral,
  type SessionSnapshot,
  type WeeklyFeeSubmission
} from "@teaching-research-alliance/client";
import "./style.css";

const client = new TeacherApiClient({
  transport: async (request) => {
    const response = await fetch(request.path, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) })
    });
    return { status: response.status, body: await response.json() };
  }
});

type Overview = Readonly<{
  nickname: string;
  balanceCents: string;
  currentYearIncomeByCategory: Readonly<Record<string, string>>;
}>;

type Fee = Readonly<{
  teachingWeekId: string;
  grossAmountCents: string;
  version: number;
  venueId: string;
}>;

type ReceivedReferral = Readonly<{
  referralId: string;
  studentDisplayName: string;
  courseContextId: string;
  referralStatus: string;
  version: number;
  weeklyFees: readonly Fee[];
}>;

type Week = Readonly<{
  weekId: string;
  periodLabel: string;
  startsOn: string;
  endsOn: string;
  settlementMonth: string;
}>;

type Venue = Readonly<{
  id: string;
  name: string;
  isOwn: boolean;
}>;

const roleLabels: Readonly<Record<string, string>> = {
  TEACHING_TEACHER: "授课老师",
  ACADEMIC_PLANNER: "学业规划师",
  GROUP_LEADER: "教研组长",
  TEACHING_MENTOR: "指导导师",
  PLANNING_MENTOR: "学业规划导师",
  HEADQUARTERS_FINANCE: "总部财务",
  REGION_FINANCE: "分区财务",
  SYSTEM_ADMIN: "系统管理员",
  SYSTEM_OWNER: "开发者",
  CAMPUS_PRINCIPAL: "运营校长",
  VENUE_OWNER: "场地运营"
};

const incomeLabels: Readonly<Record<string, string>> = {
  teachingTeacher: "授课收入",
  referrer: "转介绍收入",
  planningMentor: "规划导师收入",
  groupLeader: "教研组长收入",
  teachingMentor: "指导导师收入",
  platformFinance: "平台财务收入",
  regionFinance: "分区财务收入"
};

const statusLabels: Readonly<Record<string, string>> = {
  PENDING: "待接收",
  ACCEPTED: "已接收",
  ARCHIVED: "已归档",
  REACTIVATED: "待重新接收"
};

const clientMessages: Readonly<Record<string, string>> = {
  UNAUTHENTICATED: "手机号或密码不正确，或登录已失效，请重新登录。",
  VERSION_CONFLICT: "这笔费用已有新版本，请刷新后重新填写。",
  PERIOD_LOCKED: "该期间已关闭，暂时不能修改。",
  FORBIDDEN_SCOPE: "当前身份没有访问权限，请重新选择身份。",
  INVALID_INPUT: "请检查填写内容后重试。",
  INTERNAL_ERROR: "暂时无法完成，请稍后重试。"
};

const canCreateReferral = (session: SessionSnapshot | null): boolean => {
  const role = session?.currentRoleContext?.subject;
  return role === "TEACHING_TEACHER" || role === "ACADEMIC_PLANNER" || role === "PLANNING_MENTOR";
};

const hasOwnOverview = (session: SessionSnapshot | null): boolean => {
  const role = session?.currentRoleContext?.subject;
  return role === "TEACHING_TEACHER" || role === "ACADEMIC_PLANNER";
};

function App(): ReactNode {
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [receivedReferrals, setReceivedReferrals] = useState<readonly ReceivedReferral[]>([]);
  const [sentReferrals, setSentReferrals] = useState<readonly SentReferral[]>([]);
  const [weeks, setWeeks] = useState<readonly Week[]>([]);
  const [venues, setVenues] = useState<readonly Venue[]>([]);
  const [receivingTeachers, setReceivingTeachers] = useState<readonly ReceivingTeacher[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [selectedReferralId, setSelectedReferralId] = useState("");
  const [weekId, setWeekId] = useState("");
  const [venueId, setVenueId] = useState("");
  const [amount, setAmount] = useState("");
  const [receiverPersonId, setReceiverPersonId] = useState("");
  const [studentDisplayName, setStudentDisplayName] = useState("");
  const [courseContextId, setCourseContextId] = useState("");
  const [classType, setClassType] = useState<"ONE_TO_ONE" | "SMALL_GROUP">("ONE_TO_ONE");
  const [pendingReferralCount, setPendingReferralCount] = useState(0);
  const pendingWeeklyFee = useRef<{ signature: string; submission: WeeklyFeeSubmission } | null>(null);
  const pendingReferrals = useRef(new Map<string, ReferralCreationSubmission>());

  const clear = (options: Readonly<{ discardReferral?: boolean }> = {}): void => {
    const discardReferral = options.discardReferral ?? true;
    setOverview(null);
    setReceivedReferrals([]);
    setSentReferrals([]);
    setWeeks([]);
    setVenues([]);
    setReceivingTeachers([]);
    setSelectedReferralId("");
    setWeekId("");
    setVenueId("");
    setAmount("");
    pendingWeeklyFee.current = null;
    if (discardReferral) {
      setReceiverPersonId("");
      setStudentDisplayName("");
      setCourseContextId("");
      setClassType("ONE_TO_ONE");
      pendingReferrals.current.clear();
      setPendingReferralCount(0);
    }
  };

  const confirmDiscardPendingReferral = (): boolean => {
    if (pendingReferrals.current.size === 0) return true;
    return window.confirm("有尚未确认的推荐。切换身份或退出会丢失其安全重试信息，确定继续吗？");
  };

  const load = async (): Promise<void> => {
    const currentSession = client.currentSession;
    const role = currentSession?.currentRoleContext?.subject;
    const loadOverview = hasOwnOverview(currentSession);
    const loadReferrals = canCreateReferral(currentSession);
    const loadTeaching = role === "TEACHING_TEACHER";
    if (!loadOverview && !loadReferrals) return;

    const [nextOverview, nextReceived, nextWeeks, nextVenues, nextTeachers, nextSent] = await Promise.all([
      loadOverview ? client.getOwnOverview<Overview>() : Promise.resolve(null),
      loadTeaching ? client.listReceivedReferrals<readonly ReceivedReferral[]>() : Promise.resolve([]),
      loadTeaching ? client.listOpenTeachingWeeks<readonly Week[]>() : Promise.resolve([]),
      loadTeaching ? client.listAvailableVenues<readonly Venue[]>() : Promise.resolve([]),
      loadReferrals ? client.listReceivingTeachers() : Promise.resolve([]),
      loadReferrals ? client.listSentReferrals() : Promise.resolve([])
    ]);
    setOverview(nextOverview);
    setReceivedReferrals(nextReceived);
    setWeeks(nextWeeks);
    setVenues(nextVenues);
    setReceivingTeachers(nextTeachers);
    setSentReferrals(nextSent);
  };

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (error) {
      if (error instanceof StaleResponseError) return;
      if (error instanceof RoleSelectionRequiredError) {
        setMessage("当前身份需要重新选择。");
      } else if (error instanceof ApiClientError) {
        setMessage(clientMessages[error.code] ?? "操作未完成，请检查当前身份后重试。");
        if (error.status === 409) {
          pendingWeeklyFee.current = null;
          setSelectedReferralId("");
          try {
            await load();
          } catch {
            setMessage("已有新版本，但刷新失败。请点击刷新后重新填写。");
          }
        }
      } else if (error instanceof Error && error.message === "WEEKLY_FEE_REQUIRED") {
        setMessage("请填写学生、教学周、场地和非负金额，金额最多两位小数。");
      } else if (error instanceof Error && error.message === "REFERRAL_REQUIRED") {
        setMessage("请完整选择接收老师，并填写学生和课程。");
      } else {
        setMessage("网络未确认结果。保持填写内容不变，再次提交可安全重试。");
      }
      if (!client.hasRoleContext) clear();
    } finally {
      setSession(client.currentSession);
      setBusy(false);
    }
  };

  const chooseWeeklyFee = (referralId: string, chosenWeekId: string): void => {
    setSelectedReferralId(referralId);
    setWeekId(chosenWeekId);
    pendingWeeklyFee.current = null;
    const fee = receivedReferrals
      .find((referral) => referral.referralId === referralId)
      ?.weeklyFees.find((item) => item.teachingWeekId === chosenWeekId);
    setAmount(fee === undefined ? "" : formatCentsAsBeans(fee.grossAmountCents));
    setVenueId(fee?.venueId ?? venues.find((venue) => venue.isOwn)?.id ?? "");
  };

  const saveWeeklyFee = async (): Promise<void> => {
    const week = weeks.find((item) => item.weekId === weekId);
    if (week === undefined || selectedReferralId === "" || venueId === "") throw new Error("WEEKLY_FEE_REQUIRED");
    const fee = receivedReferrals
      .find((referral) => referral.referralId === selectedReferralId)
      ?.weeklyFees.find((item) => item.teachingWeekId === weekId);
    let grossAmountCents: string;
    try {
      grossAmountCents = parseBeanAmountToCents(amount);
    } catch {
      throw new Error("WEEKLY_FEE_REQUIRED");
    }
    const draft = { referralCaseId: selectedReferralId, teachingWeekId: weekId, venueId, settlementMonth: week.settlementMonth, grossAmountCents, expectedVersion: fee?.version ?? 0 };
    const signature = JSON.stringify(draft);
    if (pendingWeeklyFee.current?.signature !== signature) {
      pendingWeeklyFee.current = { signature, submission: client.createWeeklyFeeSubmission(draft) };
    }
    await client.recordWeeklyFee(pendingWeeklyFee.current.submission);
    await load();
    pendingWeeklyFee.current = null;
    setMessage("已保存，本周累计费用和个人余额已更新。");
  };

  const saveReferral = async (): Promise<void> => {
    if (receiverPersonId === "" || studentDisplayName.trim() === "" || courseContextId.trim() === "") {
      throw new Error("REFERRAL_REQUIRED");
    }
    const draft = { receiverPersonId, studentDisplayName, courseContextId, classType };
    const signature = JSON.stringify(draft);
    let submission = pendingReferrals.current.get(signature);
    if (submission === undefined) {
      submission = client.createReferralSubmission(draft);
      pendingReferrals.current.set(signature, submission);
      setPendingReferralCount(pendingReferrals.current.size);
    }
    const result = await client.createReferral(submission);
    await load();
    pendingReferrals.current.delete(signature);
    setPendingReferralCount(pendingReferrals.current.size);
    setMessage(result.replay ? "推荐已确认，未重复创建。" : "推荐已提交，等待接收老师处理。");
  };

  const currentRole = session?.currentRoleContext?.subject ?? "";
  const selectedReceivedReferral = receivedReferrals.find((referral) => referral.referralId === selectedReferralId);
  const incomeEntries = overview === null ? [] : Object.entries(overview.currentYearIncomeByCategory).filter(([, value]) => BigInt(value) !== 0n);

  return (
    <div className="shell">
      <aside>
        <div className="brand">研<span>教研联盟</span></div>
        <p>让每一份教学付出<br />都有清楚的记录。</p>
        <div className="nav">我的教学</div>
        <small>个人账户 · 推荐与费用记录</small>
      </aside>
      <main>
        <header>
          <div><span className="eyebrow">TEACHING ALLIANCE</span><h1>{session === null ? "欢迎回来" : "我的教学"}</h1></div>
          {session !== null && <button className="quiet" disabled={busy} onClick={() => {
            if (!confirmDiscardPendingReferral()) return;
            void run(async () => {
              clear();
              try { await client.endSession(); } catch { setMessage("已清除此页面的登录状态，服务器注销未确认。"); }
            });
          }}>退出登录</button>}
        </header>

        {message !== "" && <p role="status" className="message">{message}</p>}

        {session === null ? (
          <form className="panel login" onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await client.login({ phoneNormalized: phone, password });
              setPassword("");
              setSession(client.currentSession);
              await load();
            });
          }}>
            <h2>登录你的账户</h2>
            <p>使用手机号与密码，进入你的个人工作台。</p>
            <label>手机号<input autoComplete="username" value={phone} onChange={(event) => setPhone(event.target.value)} required /></label>
            <label>密码<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
            <button disabled={busy}>{busy ? "正在登录…" : "登录"}</button>
          </form>
        ) : (
          <>
            <section className="rolebar">
              <span>{overview?.nickname ?? "我的账户"}</span>
              <label>当前身份<select disabled={busy} value={currentRole} onChange={(event) => {
                if (!confirmDiscardPendingReferral()) return;
                clear();
                void run(async () => {
                  await client.switchRole(event.target.value as Parameters<typeof client.switchRole>[0]);
                  await load();
                });
              }}>
                <option value="" disabled>请选择身份</option>
                {session.roleContexts.map((role) => <option key={role.subject} value={role.subject}>{roleLabels[role.subject] ?? role.subject}</option>)}
              </select></label>
              <button className="quiet" disabled={busy} onClick={() => {
                clear({ discardReferral: false });
                void run(async () => {
                  await client.refreshSession();
                  await load();
                });
              }}>刷新</button>
            </section>

            {currentRole === "" && <section className="panel"><p>请选择已授权身份后查看工作台。</p></section>}

            {overview !== null && <div className="overview">
              <section className="balance"><span>个人可用余额 / 欢乐豆</span><strong>{formatCentsAsBeans(overview.balanceCents)}</strong><small>个人账户余额</small></section>
              <section className="panel income"><h2>当前财年课时分润</h2>
                {incomeEntries.map(([category, value]) => <div key={category}><span>{incomeLabels[category] ?? "其他课时收入"}</span><b>{formatCentsAsBeans(value)}</b></div>)}
                {incomeEntries.length === 0 && <p>暂无收入记录</p>}
              </section>
            </div>}

            {canCreateReferral(session) && <>
              <section className="panel referral-form">
                <div className="section-title"><h2>推荐学生</h2><span>提交后由接收老师处理</span></div>
                <p>选择接收老师，填写学生和课程。推荐身份由当前登录身份确定。</p>
                <div className="fields referral-fields">
                  <label>接收老师<select value={receiverPersonId} disabled={busy || receivingTeachers.length === 0} onChange={(event) => setReceiverPersonId(event.target.value)} required>
                    <option value="">请选择接收老师</option>
                    {receivingTeachers.map((teacher) => <option key={teacher.personId} value={teacher.personId}>{teacher.nickname}</option>)}
                  </select></label>
                  <label>学生名字<input value={studentDisplayName} disabled={busy} onChange={(event) => setStudentDisplayName(event.target.value)} required /></label>
                  <label>课程<input value={courseContextId} disabled={busy} onChange={(event) => setCourseContextId(event.target.value)} required /></label>
                  <label>班型<select value={classType} disabled={busy} onChange={(event) => setClassType(event.target.value as "ONE_TO_ONE" | "SMALL_GROUP")}>
                    <option value="ONE_TO_ONE">一对一</option><option value="SMALL_GROUP">小班课</option>
                  </select></label>
                </div>
                {receivingTeachers.length === 0 && <p>暂未读取到可接收老师，请刷新后重试。</p>}
                {pendingReferralCount > 0 && <p className="pending-note">有未确认的推荐；保持相同填写内容再次提交会安全核对，不会重复创建。</p>}
                <button disabled={busy || receivingTeachers.length === 0} onClick={() => void run(saveReferral)}>{busy ? "正在提交…" : "提交推荐"}</button>
              </section>

              <section className="panel sent-referrals">
                <div className="section-title"><h2>我推荐的学生</h2><span>{sentReferrals.length} 条记录</span></div>
                {sentReferrals.length === 0 ? <p>暂无推荐记录</p> : sentReferrals.map((referral) => <article key={referral.referralId}>
                  <div><h3>{referral.studentDisplayName}</h3><p>{referral.receiverNickname} · {referral.courseContextId} · {statusLabels[referral.referralStatus] ?? referral.referralStatus}</p><small>{referral.submittedAt.slice(0, 10)} 提交</small></div>
                  <div className="sent-fees">{referral.weeklyFees.length === 0 ? <small>暂无周费用</small> : referral.weeklyFees.map((fee) => <span key={fee.entryId}>{fee.weekStartsOn}：{formatCentsAsBeans(fee.grossAmountCents)} 豆</span>)}</div>
                </article>)}
              </section>
            </>}

            {currentRole === "TEACHING_TEACHER" && <>
              <section className="panel"><div className="section-title"><h2>我的生源库</h2><span>{receivedReferrals.length} 位学生</span></div>
                {receivedReferrals.length === 0 ? <p>暂无学生记录</p> : <div className="students">{receivedReferrals.map((referral) => <article key={referral.referralId}>
                  <div><h3>{referral.studentDisplayName}</h3><p>{referral.courseContextId} · {statusLabels[referral.referralStatus] ?? referral.referralStatus}</p></div>
                  <button className="quiet" disabled={busy || weeks.length === 0} onClick={() => chooseWeeklyFee(referral.referralId, weeks[0]?.weekId ?? "")}>登记周费用</button>
                </article>)}</div>}
              </section>
              {selectedReceivedReferral !== undefined && <form className="panel" onSubmit={(event) => { event.preventDefault(); void run(saveWeeklyFee); }}>
                <h2>{selectedReceivedReferral.studentDisplayName} · 周累计费用</h2><p>填写本周所有课程的累计金额。修改后，系统按新旧金额的差额更新账户。</p>
                <div className="fields">
                  <label>教学周<select disabled={busy} value={weekId} onChange={(event) => chooseWeeklyFee(selectedReferralId, event.target.value)}>{weeks.map((week) => <option key={week.weekId} value={week.weekId}>{week.startsOn} 至 {week.endsOn}</option>)}</select></label>
                  <label>授课场地<select disabled={busy} value={venueId} onChange={(event) => setVenueId(event.target.value)}><option value="">请选择场地</option>{venues.map((venue) => <option key={venue.id} value={venue.id}>{venue.name}{venue.isOwn ? "（本人场地，免费）" : ""}</option>)}</select></label>
                  <label>本周累计 / 欢乐豆<input disabled={busy} inputMode="decimal" value={amount} placeholder="例如 1000.00" onChange={(event) => setAmount(event.target.value)} required /></label>
                </div>
                <button disabled={busy}>{busy ? "正在保存…" : "保存周累计费用"}</button>
              </form>}
            </>}
          </>
        )}
        <footer>本地开发预览 · 当前提供推荐、教师录费与个人概览，完整业务仍在开发。</footer>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
