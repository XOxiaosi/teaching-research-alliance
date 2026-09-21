import { useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import { TeacherApiClient, parseBeanAmountToCents, formatCentsAsBeans, ApiClientError, StaleResponseError, type SessionSnapshot, type WeeklyFeeSubmission } from "@teaching-research-alliance/client";
import "./style.css";

const client = new TeacherApiClient({ transport: async (request) => {
  const response = await fetch(request.path, { method: request.method, headers: request.headers,
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) });
  return {status: response.status, body: await response.json()};
}});
type Overview = {nickname:string;balanceCents:string;currentYearIncomeByCategory:Record<string,string>};
type Fee = {teachingWeekId:string;grossAmountCents:string;version:number;venueId:string};
type Referral = {referralId:string;studentDisplayName:string;courseContextId:string;referralStatus:string;weeklyFees:Fee[]};
type Week = {weekId:string;periodLabel:string;startsOn:string;endsOn:string;settlementMonth:string};
type Venue = {id:string;name:string;isOwn:boolean};
const money = formatCentsAsBeans;
const cents = (value:string) => {try{return parseBeanAmountToCents(value);}catch{throw new Error("请填写非负金额，最多两位小数。");}};
const labels:Record<string,string> = {TEACHING_TEACHER:"授课老师",ACADEMIC_PLANNER:"学业规划师",GROUP_LEADER:"教研组长",TEACHING_MENTOR:"指导导师",PLANNING_MENTOR:"学业规划导师",HEADQUARTERS_FINANCE:"总部财务",REGION_FINANCE:"分区财务",SYSTEM_ADMIN:"管理员",SYSTEM_OWNER:"开发者",CAMPUS_PRINCIPAL:"运营校长",VENUE_OWNER:"场地运营"};
const incomeLabels:Record<string,string> = {teachingTeacher:"授课收入",referrer:"转介绍收入",planningMentor:"规划导师收入",groupLeader:"教研组长收入",teachingMentor:"指导导师收入",platformFinance:"平台财务收入",regionFinance:"分区财务收入"};
const statusLabels:Record<string,string>={PENDING:"待接收",ACCEPTED:"已接收",ARCHIVED:"已归档",REACTIVATED:"待重新接收"};
function App(){
  const [session,setSession]=useState<SessionSnapshot|null>(null);
  const [overview,setOverview]=useState<Overview|null>(null);
  const [referrals,setReferrals]=useState<Referral[]>([]),[weeks,setWeeks]=useState<Week[]>([]),[venues,setVenues]=useState<Venue[]>([]);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState("");
  const [phone,setPhone]=useState(""),[password,setPassword]=useState("");
  const [selected,setSelected]=useState(""),[weekId,setWeekId]=useState(""),[venueId,setVenueId]=useState(""),[amount,setAmount]=useState("");
  const pending=useRef<{signature:string;submission:WeeklyFeeSubmission}|null>(null);
  const clear=()=>{setOverview(null);setReferrals([]);setWeeks([]);setVenues([]);setSelected("");setWeekId("");setVenueId("");setAmount("");pending.current=null;};
  const load=async()=>{
    const role=client.currentSession?.currentRoleContext?.subject;
    if(role!=="TEACHING_TEACHER"&&role!=="ACADEMIC_PLANNER") return;
    const me=await client.getMe<Overview>();
    if(role==="TEACHING_TEACHER"){
      const [rs,ws,vs]=await Promise.all([client.listReceivedReferrals<Referral[]>(),client.listOpenTeachingWeeks<Week[]>(),client.listAvailableVenues<Venue[]>()]);
      setReferrals(rs);setWeeks(ws);setVenues(vs);
    }
    setOverview(me);
  };
  const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);setMessage("");try{await action();}catch(error){
    if(error instanceof StaleResponseError)return;
    if(error instanceof ApiClientError){
      const messages:Record<string,string>={UNAUTHENTICATED:"手机号或密码不正确，或登录已失效，请重新登录。",VERSION_CONFLICT:"这笔费用已有新版本，请刷新后重新填写。",PERIOD_LOCKED:"该期间已关闭，暂时不能修改。",FORBIDDEN_SCOPE:"当前身份没有访问权限，请重新选择身份。",REFERRAL_ARCHIVED:"该生源已归档，请重新激活后登记新费用。",INVALID_INPUT:"请检查金额、教学周及场地后重试。",INTERNAL_ERROR:"暂时无法完成，请稍后重试。"};
      setMessage(messages[error.code]??"操作未完成，请检查当前身份后重试。");
      if(error.status===409){pending.current=null;setSelected("");try{await load();}catch{setMessage("已有新版本，但刷新失败。请点击刷新后重新填写。");}}
    }else setMessage(error instanceof Error&&error.message.startsWith("请填写")?error.message:"网络未确认结果。保持内容不变，再次保存可安全重试。");
    if(!client.hasRoleContext)clear();
  }finally{setSession(client.currentSession);setBusy(false);}};
  const choose=(referralId:string,chosenWeek:string)=>{
    setSelected(referralId);setWeekId(chosenWeek);pending.current=null;
    const fee=referrals.find(r=>r.referralId===referralId)?.weeklyFees.find(f=>f.teachingWeekId===chosenWeek);
    setAmount(fee?money(fee.grossAmountCents):"");setVenueId(fee?.venueId??venues.find(v=>v.isOwn)?.id??"");
  };
  const save=async()=>{
    const week=weeks.find(w=>w.weekId===weekId);if(!week||!selected||!venueId)throw new Error("请填写学生、教学周和场地。");
    const fee=referrals.find(r=>r.referralId===selected)?.weeklyFees.find(f=>f.teachingWeekId===weekId);
    const draft={referralCaseId:selected,teachingWeekId:weekId,venueId,settlementMonth:week.settlementMonth,grossAmountCents:cents(amount),expectedVersion:fee?.version??0};
    const signature=JSON.stringify(draft);
    if(pending.current?.signature!==signature)pending.current={signature,submission:client.createWeeklyFeeSubmission(draft)};
    await client.recordWeeklyFee(pending.current.submission);await load();pending.current=null;setMessage("已保存，本周累计费用和个人余额已更新。");
  };
  return <div className="shell"><aside><div className="brand">研<span>教研联盟</span></div><p>让每一份教学付出<br/>都有清楚的记录。</p><div className="nav">我的教学</div><small>个人账户 · 费用记录</small></aside><main>
    <header><div><span className="eyebrow">TEACHING ALLIANCE</span><h1>{session?"我的教学":"欢迎回来"}</h1></div>{session&&<button className="quiet" disabled={busy} onClick={()=>void run(async()=>{clear();try{await client.endSession();}catch{setMessage("已清除此页面的登录状态，服务器注销未确认。");}})}>退出登录</button>}</header>
    {message&&<p role="status" className="message">{message}</p>}
    {!session?<form className="panel login" onSubmit={e=>{e.preventDefault();void run(async()=>{await client.login({phoneNormalized:phone,password});setPassword("");setSession(client.currentSession);await load();});}}><h2>登录你的账户</h2><p>使用手机号与密码，进入你的个人工作台。</p><label>手机号<input autoComplete="username" value={phone} onChange={e=>setPhone(e.target.value)} required/></label><label>密码<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required/></label><button disabled={busy}>{busy?"正在登录…":"登录"}</button></form>:<>
    <section className="rolebar"><span>{overview?.nickname??"我的账户"}</span><label>当前身份 <select disabled={busy} value={session.currentRoleContext?.subject??""} onChange={e=>{const subject=e.target.value as Parameters<typeof client.switchRole>[0];clear();void run(async()=>{await client.switchRole(subject);await load();});}}><option value="" disabled>请选择身份</option>{session.roleContexts.map((r,i)=><option key={i} value={r.subject}>{labels[r.subject]??r.subject}</option>)}</select></label><button className="quiet" disabled={busy} onClick={()=>void run(async()=>{clear();await client.refreshSession();await load();})}>刷新</button></section>
    {overview&&<div className="overview"><section className="balance"><span>个人可用余额 / 欢乐豆</span><strong>{money(overview.balanceCents)}</strong><small>个人账户余额</small></section><section className="panel income"><h2>当前财年课时分润</h2>{Object.entries(overview.currentYearIncomeByCategory).filter(([,v])=>BigInt(v)!==0n).map(([key,v])=><div key={key}><span>{incomeLabels[key]??"其他课时收入"}</span><b>{money(v)}</b></div>)}{Object.values(overview.currentYearIncomeByCategory).every(v=>BigInt(v)===0n)&&<p>暂无收入记录</p>}</section></div>}
    {session.currentRoleContext?.subject==="TEACHING_TEACHER"&&<><section className="panel"><div className="section-title"><h2>我的生源库</h2><span>{referrals.length} 位学生</span></div>{referrals.length===0?<p>暂无学生记录</p>:<div className="students">{referrals.map(r=><article key={r.referralId}><div><h3>{r.studentDisplayName}</h3><p>{r.courseContextId} · {statusLabels[r.referralStatus]}</p></div><button className="quiet" disabled={busy||!weeks.length} onClick={()=>choose(r.referralId,weeks[0]?.weekId??"")}>登记周费用</button></article>)}</div>}</section>
    {selected&&<form className="panel" onSubmit={e=>{e.preventDefault();void run(save);}}><h2>{referrals.find(r=>r.referralId===selected)?.studentDisplayName} · 周累计费用</h2><p>填写本周所有课程的累计金额。修改后，系统按新旧金额的差额更新账户。</p><div className="fields"><label>教学周<select disabled={busy} value={weekId} onChange={e=>choose(selected,e.target.value)}>{weeks.map(w=><option key={w.weekId} value={w.weekId}>{w.startsOn} 至 {w.endsOn}</option>)}</select></label><label>授课场地<select disabled={busy} value={venueId} onChange={e=>setVenueId(e.target.value)}><option value="">请选择场地</option>{venues.map(v=><option key={v.id} value={v.id}>{v.name}{v.isOwn?"（本人场地，免费）":""}</option>)}</select></label><label>本周累计 / 欢乐豆<input disabled={busy} inputMode="decimal" value={amount} placeholder="例如 1000.00" onChange={e=>setAmount(e.target.value)} required/></label></div><button disabled={busy}>{busy?"正在保存…":"保存周累计费用"}</button></form>}</>}
    </>}
    <footer>本地开发预览 · 当前提供教师录费与个人概览，完整业务仍在开发。</footer>
  </main></div>;
}
createRoot(document.getElementById("root")!).render(<App/>);
