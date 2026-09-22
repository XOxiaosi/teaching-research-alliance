import { useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  ApiClientError,
  formatCentsAsBeans,
  RoleSelectionRequiredError,
  StaleResponseError,
  TeacherApiClient,
  type ReceivingTeacher,
  type ReferralCreationSubmission,
  type SentReferral,
  type SessionSnapshot
} from "@teaching-research-alliance/client";
import { SelfPurchasePanel } from "./self-purchase-panel.js";
import { ReimbursementPanel } from "./reimbursement-panel.js";
import { CompanyFundPanel } from "./company-fund-panel.js";
import { PersonalWithdrawalPanel } from "./personal-withdrawal-panel.js";
import { FinanceWithdrawalPanel } from "./finance-withdrawal-panel.js";
import { WeeklyFeePanel } from "./weekly-fee-panel.js";
import { VenueBoardPanel } from "./venue-board-panel.js";
import { Button } from "./components/ui/button.js";
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
  initialVenueId?: string | null;
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
  regionFinance: "分区财务收入",
  reimbursementIncome: "报销收入"
};

const statusLabels: Readonly<Record<string, string>> = {
  PENDING: "待接收",
  ACCEPTED: "已接收",
  ARCHIVED: "已归档",
  REACTIVATED: "待重新接收"
};

const clientMessages: Readonly<Record<string, string>> = {
  HEADQUARTERS_FINANCE_ASSIGNMENT_REQUIRED: "当前本人没有有效总部财务任职，不能使用本人采买自动划拨。请重新选择已授权身份。",
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
  return role === "TEACHING_TEACHER" || role === "ACADEMIC_PLANNER" || role === "PLANNING_MENTOR";
};

function App(): ReactNode {
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [overviewFresh, setOverviewFresh] = useState(false);
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
  const [activePage, setActivePage] = useState<"fees" | "overview" | "referrals" | "withdrawals" | "finance" | "purchase" | "purchase-history" | "funds" | "reimbursements" | "reimbursement-history" | "venue-board">("fees");
  const [withdrawalUnconfirmed, setWithdrawalUnconfirmed] = useState(false);
  const [purchaseUnconfirmed, setPurchaseUnconfirmed] = useState(false);
  const [fundUnconfirmed, setFundUnconfirmed] = useState(false);
  const [reimbursementUnconfirmed, setReimbursementUnconfirmed] = useState(false);
  const financeUnconfirmed = withdrawalUnconfirmed || purchaseUnconfirmed || fundUnconfirmed || reimbursementUnconfirmed;
  const [feeUnconfirmed, setFeeUnconfirmed] = useState(false);
  const [receiverPersonId, setReceiverPersonId] = useState("");
  const [studentDisplayName, setStudentDisplayName] = useState("");
  const [courseContextId, setCourseContextId] = useState("");
  const [classType, setClassType] = useState<"ONE_TO_ONE" | "SMALL_GROUP">("ONE_TO_ONE");
  const [pendingReferralCount, setPendingReferralCount] = useState(0);
  const pendingReferrals = useRef(new Map<string, ReferralCreationSubmission>());

  const clear = (options: Readonly<{ discardReferral?: boolean }> = {}): void => {
    const discardReferral = options.discardReferral ?? true;
    setDataLoaded(false);
    setOverview(null);
    setOverviewFresh(false);
    setReceivedReferrals([]);
    setSentReferrals([]);
    setWeeks([]);
    setVenues([]);
    setReceivingTeachers([]);
    setFeeUnconfirmed(false);
    setWithdrawalUnconfirmed(false);
    setPurchaseUnconfirmed(false);
    setFundUnconfirmed(false);
    setReimbursementUnconfirmed(false);
    setActivePage("fees");
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
    if (financeUnconfirmed) { setMessage("有一笔财务操作或上传结果待确认，请先安全重试后再切换身份或退出。"); return false; }
    if (feeUnconfirmed) return window.confirm("有一笔费用尚未确认保存结果。建议先安全重试；离开后需重新核对服务器记录。确定切换身份或退出吗？");
    if (pendingReferrals.current.size === 0) return true;
    return window.confirm("有尚未确认的推荐。切换身份或退出会丢失其安全重试信息，确定继续吗？");
  };

  const load = async (): Promise<void> => {
    const currentSession = client.currentSession;
    const role = currentSession?.currentRoleContext?.subject;
    const loadOverview = hasOwnOverview(currentSession);
    const loadReferrals = canCreateReferral(currentSession);
    const loadTeaching = role === "TEACHING_TEACHER";
    const loadVenueBoard = ["TEACHING_TEACHER", "ACADEMIC_PLANNER", "PLANNING_MENTOR"].includes(role ?? "");
    if (!loadOverview && !loadReferrals && !loadVenueBoard) return;

    const [nextOverview, nextReceived, nextWeeks, nextVenues, nextTeachers, nextSent] = await Promise.all([
      loadOverview ? client.getOwnOverview<Overview>() : Promise.resolve(null),
      loadTeaching ? client.listReceivedReferrals<readonly ReceivedReferral[]>() : Promise.resolve([]),
      loadTeaching ? client.listOpenTeachingWeeks<readonly Week[]>() : Promise.resolve([]),
      loadVenueBoard ? client.listAvailableVenues<readonly Venue[]>() : Promise.resolve([]),
      loadReferrals ? client.listReceivingTeachers() : Promise.resolve([]),
      loadReferrals ? client.listSentReferrals() : Promise.resolve([])
    ]);
    setDataLoaded(true);
    setOverview(nextOverview);
    setOverviewFresh(true);
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
        setMessage(clientMessages[error.code] ?? "当前身份需要重新选择。");
      } else if (error instanceof ApiClientError) {
        setMessage(clientMessages[error.code] ?? "操作未完成，请检查当前身份后重试。");
        if (error.status === 409) {
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
  const canReadVenueBoard = ["TEACHING_TEACHER", "ACADEMIC_PLANNER", "PLANNING_MENTOR", "VENUE_OWNER"].includes(currentRole);
  const canWithdraw = ["TEACHING_TEACHER", "ACADEMIC_PLANNER", "PLANNING_MENTOR"].includes(currentRole);
  const canProcessWithdrawal = currentRole === "HEADQUARTERS_FINANCE" && session?.currentRoleContext?.scope === "GLOBAL";
  const globalScope = session?.currentRoleContext?.scope === "GLOBAL";
  const canConfigureFunds = globalScope && ["SYSTEM_ADMIN", "SYSTEM_OWNER"].includes(currentRole);
  const canReadPurchases = canProcessWithdrawal || canConfigureFunds;
  const context = session?.currentRoleContext;
  const canReadReimbursements = globalScope && context?.regionId === undefined && context?.campusId === undefined && context?.venueId === undefined
    && ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"].includes(currentRole);
  const canSelfPurchase = canWithdraw && session?.roleContexts.some((role) => role.subject === "HEADQUARTERS_FINANCE" && role.scope === "GLOBAL");
  const page = activePage === "purchase" && canSelfPurchase ? "purchase"
    : activePage === "purchase-history" && canReadPurchases ? "purchase-history"
    : activePage === "reimbursements" && canWithdraw ? "reimbursements"
    : activePage === "reimbursement-history" && canReadReimbursements ? "reimbursement-history"
    : currentRole === "TEACHING_TEACHER" ? (["fees", "overview", "referrals", "withdrawals", "venue-board"].includes(activePage) ? activePage : "fees")
    : canReadVenueBoard ? "venue-board"
    : canConfigureFunds ? "funds" : canProcessWithdrawal ? "finance"
    : canCreateReferral(session) ? (activePage === "withdrawals" ? "withdrawals" : "referrals") : "overview";
  const pageTitle = { fees: "周费用录入", overview: "教师工作台", referrals: "学生推荐", withdrawals: "我的提现", finance: "提现办理", purchase: "财务本人采买", "purchase-history": "采买记录", funds: "业务账户配置", reimbursements: "我的报销", "reimbursement-history": "报销记录", "venue-board": "共享场地看板" }[page];
  const financeKey = `${session?.sessionId}:${JSON.stringify(session?.currentRoleContext)}`;
  const incomeEntries = overview === null ? [] : Object.entries(overview.currentYearIncomeByCategory).filter(([, value]) => BigInt(value) !== 0n);

  const goPage = (next: typeof activePage): void => { setActivePage(next); setMessage(""); window.scrollTo({top:0}); };
  const navigation = <>
    {currentRole === "TEACHING_TEACHER" && <>
      <button disabled={busy} aria-current={page === "fees" ? "page" : undefined} onClick={() => goPage("fees")}><span aria-hidden="true" className="nav-icon">▤</span>周费用录入</button>
      <button disabled={busy} aria-current={page === "overview" ? "page" : undefined} onClick={() => goPage("overview")}><span aria-hidden="true" className="nav-icon">▦</span>教师工作台</button>
    </>}
    {canCreateReferral(session) && <button disabled={busy} aria-current={page === "referrals" ? "page" : undefined} onClick={() => goPage("referrals")}><span aria-hidden="true" className="nav-icon">↗</span>学生推荐</button>}
    {canWithdraw && <button disabled={busy} aria-current={page === "withdrawals" ? "page" : undefined} onClick={() => goPage("withdrawals")}><span aria-hidden="true" className="nav-icon">↗</span>我的提现</button>}
    {canReadVenueBoard && <button disabled={busy} aria-current={page === "venue-board" ? "page" : undefined} onClick={() => goPage("venue-board")}><span aria-hidden="true" className="nav-icon">▥</span>场地看板</button>}
    {canProcessWithdrawal && <button disabled={busy} aria-current={page === "finance" ? "page" : undefined} onClick={() => goPage("finance")}><span aria-hidden="true" className="nav-icon">▣</span>提现办理</button>}
    {canSelfPurchase && <button disabled={busy} aria-current={page === "purchase" ? "page" : undefined} onClick={() => goPage("purchase")}><span aria-hidden="true" className="nav-icon">▧</span>财务本人采买</button>}
    {canConfigureFunds && <button disabled={busy} aria-current={page === "funds" ? "page" : undefined} onClick={() => goPage("funds")}><span aria-hidden="true" className="nav-icon">▦</span>业务账户配置</button>}
    {canReadPurchases && <button disabled={busy} aria-current={page === "purchase-history" ? "page" : undefined} onClick={() => goPage("purchase-history")}><span aria-hidden="true" className="nav-icon">▤</span>采买记录</button>}
    {canWithdraw && <button disabled={busy} aria-current={page === "reimbursements" ? "page" : undefined} onClick={() => goPage("reimbursements")}><span aria-hidden="true" className="nav-icon">▧</span>我的报销</button>}
    {canReadReimbursements && <button disabled={busy} aria-current={page === "reimbursement-history" ? "page" : undefined} onClick={() => goPage("reimbursement-history")}><span aria-hidden="true" className="nav-icon">▤</span>报销记录</button>}
  </>;
  return (
    <div className="shell">
      <aside>
        <div className="brand"><span className="brand-mark">研</span>教研联盟</div>
        <div className="brand-subtitle">TEACHING ALLIANCE</div>
        <div className="nav-label">个人工作空间</div>
        <nav aria-label="主要导航" className="workspace-nav">{navigation}</nav>
        <div className="aside-note">让每一份教学付出<br />都有清楚的记录。</div>
      </aside>
      <main>
        <header>
          <div><span className="eyebrow">教研联盟 / 个人工作空间</span><h1>{session === null ? "欢迎回来" : pageTitle}</h1><p className="header-subtitle">{session === null ? "登录后，开始记录你的教学工作。" : page === "fees" ? "选好期间，记下每一份教学付出。" : page === "overview" ? "查看个人收入和授课记录。" : page === "referrals" ? "推荐合适的老师，关注学生接收进展。" : page === "withdrawals" ? "查看可用余额，提交提现并关注转账进展。" : page === "finance" ? "核对申请资料，登记线下转账结果。" : page === "funds" ? "设置独立业务账户与财务职责的支出来源。" : page === "reimbursements" ? "提交报销资料，查看审核进展。" : page === "reimbursement-history" ? "核对报销申请与审核结果，审核通过后仍待划拨。" : page === "purchase" ? "凭真实采买单据，将款项划入本人个人账户。" : "查看已完成的采买内部划拨及申请原件。"}</p></div>
          {session !== null && <Button variant="outline" disabled={busy} onClick={() => {
            if (!confirmDiscardPendingReferral()) return;
            void run(async () => {
              clear();
              try { await client.endSession(); } catch { setMessage("已清除此页面的登录状态，服务器注销未确认。"); }
            });
          }}>退出登录</Button>}
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
            <h2>登录你的账户</h2><p>使用手机号与密码，进入你的个人工作台。</p>
            <label>手机号<input autoComplete="username" value={phone} onChange={(event) => setPhone(event.target.value)} required /></label>
            <label>密码<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
            <Button disabled={busy}>{busy ? "正在登录…" : "登录"}</Button>
          </form>
        ) : (
          <>
            <section className="rolebar">
              <span title={overview?.nickname}>{overview?.nickname ?? "我的账户"}</span>
              <label>当前身份<select aria-label="当前身份" disabled={busy} value={currentRole} onChange={(event) => {
                if (!confirmDiscardPendingReferral()) return;
                clear();
                void run(async () => { await client.switchRole(event.target.value as Parameters<typeof client.switchRole>[0]); await load(); });
              }}>
                <option value="" disabled>请选择身份</option>
                {session.roleContexts.map((role) => <option key={role.subject} value={role.subject}>{roleLabels[role.subject] ?? role.subject}</option>)}
              </select></label>
              <Button variant="outline" disabled={busy || feeUnconfirmed || financeUnconfirmed} onClick={() => {
                void run(async () => { await client.refreshSession(); await load(); });
              }}>刷新</Button>
            </section>
            <nav aria-label="手机导航" className="mobile-nav">{navigation}</nav>
            {currentRole === "" && <section className="panel"><p>请选择已授权身份后查看工作台。</p></section>}
            {currentRole === "TEACHING_TEACHER" && <div hidden={page !== "fees"}>
              <WeeklyFeePanel key={`${session.accountId}:${currentRole}`} client={client} referrals={receivedReferrals} weeks={weeks} venues={venues} busy={busy} loaded={dataLoaded} run={run} reload={load} onUnconfirmedChange={setFeeUnconfirmed} onDataMayChange={() => setOverviewFresh(false)} />
              <div className="recording-guide"><span className="guide-mark" aria-hidden="true">i</span><div><h3>填写累计值，不是本次新增金额</h3><p>例如：已录入 1000 豆，后来又产生 200 豆费用，本次应填写 1200 豆。不同课程分别记录，已有费用更正后自动更新结算。</p></div></div>
            </div>}
            {canReadVenueBoard && <div hidden={page !== "venue-board"}><VenueBoardPanel client={client} venues={venues} weeks={weeks} initialVenueId={currentRole === "VENUE_OWNER" ? context?.venueId : undefined} busy={busy} /></div>}
            <div hidden={currentRole === "TEACHING_TEACHER" && page !== "overview" || currentRole !== "TEACHING_TEACHER" && page !== "referrals"}>
            {overview !== null && !overviewFresh && <section className="panel" role="status"><h2>个人余额与收入正在等待更新</h2><p>账户可能已有新收支，最新余额尚未确认。请先确认操作结果，再刷新数据。</p></section>}
            {overview !== null && overviewFresh && <div className="overview">
              <section className="balance"><span>个人可用余额 / 欢乐豆</span><strong>{formatCentsAsBeans(overview.balanceCents)}</strong><small>个人账户余额</small></section>
              <section className="panel income"><h2>当前财年收入</h2>
                {incomeEntries.map(([category, value]) => <div key={category}><span>{incomeLabels[category] ?? "其他课时收入"}</span><b>{formatCentsAsBeans(value)}</b></div>)}
                {incomeEntries.length === 0 && <p>暂无收入记录</p>}
              </section>
            </div>}


            {currentRole === "TEACHING_TEACHER" && <section className="panel"><div className="section-title"><h2>我的生源库</h2><span>{receivedReferrals.length} 条学生课程记录</span></div>
              {receivedReferrals.length === 0 ? <p>暂无学生记录</p> : <div className="students">{receivedReferrals.map((referral) => <article key={referral.referralId}>
                <div><h3>{referral.studentDisplayName}</h3><p>{referral.courseContextId} · {statusLabels[referral.referralStatus] ?? referral.referralStatus}</p></div>
                <Button variant="outline" disabled={busy} onClick={() => { setActivePage("fees"); window.scrollTo({top:0}); }}>前往录费</Button>
              </article>)}</div>}
            </section>}
            </div>
            {canWithdraw && <PersonalWithdrawalPanel key={`personal:${financeKey}`} client={client} busy={busy} active={page === "withdrawals"} run={run} onUnconfirmedChange={setWithdrawalUnconfirmed} onDataMayChange={() => setOverviewFresh(false)} />}
            {canProcessWithdrawal && <FinanceWithdrawalPanel key={`hq:${financeKey}`} client={client} busy={busy} active={page === "finance"} run={run} onUnconfirmedChange={setWithdrawalUnconfirmed} onDataMayChange={() => setOverviewFresh(false)} />}
            {canSelfPurchase && <SelfPurchasePanel key={`purchase:${financeKey}`} mode="personal" client={client} busy={busy} active={page === "purchase"} run={run} onUnconfirmedChange={setPurchaseUnconfirmed} onDataMayChange={() => setOverviewFresh(false)} />}
            {canReadPurchases && <SelfPurchasePanel key={`purchase-history:${financeKey}`} mode="managed" client={client} busy={busy} active={page === "purchase-history"} run={run} onUnconfirmedChange={setPurchaseUnconfirmed} onDataMayChange={() => setOverviewFresh(false)} />}
            {canWithdraw && <ReimbursementPanel key={`reimbursements:${financeKey}`} mode="personal" client={client} busy={busy} active={page === "reimbursements"} run={run} onUnconfirmedChange={setReimbursementUnconfirmed} />}
            {canReadReimbursements && <ReimbursementPanel key={`reimbursement-history:${financeKey}`} mode="managed" client={client} busy={busy} active={page === "reimbursement-history"} run={run} onUnconfirmedChange={setReimbursementUnconfirmed} />}
            {canConfigureFunds && <CompanyFundPanel key={`funds:${financeKey}`} client={client} busy={busy} active={page === "funds"} run={run} onUnconfirmedChange={setFundUnconfirmed} onDataMayChange={() => setOverviewFresh(false)} />}
            {canCreateReferral(session) && <div hidden={page !== "referrals"}>
              <section className="panel referral-form">
                <div className="section-title"><h2>推荐学生</h2><span>提交后由接收老师处理</span></div>
                <p>选择接收老师，填写学生和课程。推荐身份由当前登录身份确定。</p>
                <div className="fields referral-fields">
                  <label>接收老师<select aria-label="接收老师" value={receiverPersonId} disabled={busy || receivingTeachers.length === 0} onChange={(event) => setReceiverPersonId(event.target.value)} required>
                    <option value="">请选择接收老师</option>
                    {receivingTeachers.map((teacher) => <option key={teacher.personId} value={teacher.personId}>{teacher.nickname}</option>)}
                  </select></label>
                  <label>学生名字<input value={studentDisplayName} disabled={busy} onChange={(event) => setStudentDisplayName(event.target.value)} required /></label>
                  <label>课程<input value={courseContextId} disabled={busy} onChange={(event) => setCourseContextId(event.target.value)} required /></label>
                  <label>班型<select aria-label="班型" value={classType} disabled={busy} onChange={(event) => setClassType(event.target.value as "ONE_TO_ONE" | "SMALL_GROUP")}>
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
            </div>}


            {currentRole !== "" && !hasOwnOverview(session) && !canCreateReferral(session) && !canProcessWithdrawal && !canConfigureFunds && <section className="panel"><h2>{roleLabels[currentRole] ?? "职务工作台"}</h2><p>此职务的业务页面尚未接通。请切换至已开放的个人身份办理业务。</p></section>}
          </>
        )}
        <footer>教研联盟 · 教学与费用记录</footer>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
