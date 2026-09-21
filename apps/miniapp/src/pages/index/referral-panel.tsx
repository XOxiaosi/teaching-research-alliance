import { useEffect, useRef, useState } from "react";
import { Button, Input, Picker, Text, View } from "@tarojs/components";
import { ApiClientError, StaleResponseError, formatCentsAsBeans,
  type TeacherApiClient, type ReceivingTeacher, type SentReferral,
  type ReferralCreationSubmission, type ReferralClassType } from "@teaching-research-alliance/client";

/** The parent remounts this panel whenever the authenticated person or role changes. */
export function ReferralPanel({ client, onSessionInvalidated }: {client: TeacherApiClient; onSessionInvalidated:()=>void}) {
  const [teachers,setTeachers]=useState<readonly ReceivingTeacher[]>([]);
  const [sent,setSent]=useState<readonly SentReferral[]>([]);
  const [receiver,setReceiver]=useState("");
  const [student,setStudent]=useState("");
  const [course,setCourse]=useState("");
  const [classType,setClassType]=useState<ReferralClassType>("ONE_TO_ONE");
  const [busy,setBusy]=useState(false);
  const [uncertain,setUncertain]=useState(false);
  const [notice,setNotice]=useState("");
  const pending=useRef<ReferralCreationSubmission|null>(null);
  const lock=useRef(false);
  const mounted=useRef(true);
  const load=async()=>{
    const [nextTeachers,nextSent]=await Promise.all([client.listReceivingTeachers(),client.listSentReferrals()]);
    if(!mounted.current)return;
    setTeachers(nextTeachers);setSent(nextSent);
  };
  useEffect(()=>{
    mounted.current=true;
    void load().catch(error=>{if(mounted.current && !(error instanceof StaleResponseError)){setNotice("推荐记录暂未加载，请刷新重试。");if(!client.hasRoleContext)onSessionInvalidated();}});
    return()=>{mounted.current=false;};
  },[client]);
  const refresh=async()=>{
    if(lock.current)return;lock.current=true;setBusy(true);
    try{await load();if(mounted.current)setNotice(uncertain?"列表已刷新，未确认的推荐仍可用原请求重试。":"推荐记录已刷新。");}
    catch(error){if(mounted.current && !(error instanceof StaleResponseError))setNotice("刷新失败，请稍后再试。");}
    finally{lock.current=false;if(mounted.current){setBusy(false);if(!client.hasRoleContext)onSessionInvalidated();}}
  };
  const submit=async()=>{
    if(lock.current)return;
    if(!pending.current && (!receiver || !student.trim() || !course.trim())){setNotice("请填写学生、课程并选择接收老师。");return;}
    lock.current=true;setBusy(true);setNotice("");
    try{
      pending.current??=client.createReferralSubmission({receiverPersonId:receiver,studentDisplayName:student.trim(),courseContextId:course.trim(),classType});
      await client.createReferral(pending.current);
      if(!mounted.current)return;
      pending.current=null;setUncertain(false);setStudent("");setCourse("");
      setNotice("推荐已提交，等待老师接收。");
      try{await load();}catch(error){if(!(error instanceof StaleResponseError)&&mounted.current)setNotice("推荐已提交，列表刷新失败，请稍后刷新查看。");}
    }catch(error){
      if(!mounted.current || error instanceof StaleResponseError)return;
      if(error instanceof ApiClientError && error.status<500){
        pending.current=null;setUncertain(false);
        setNotice(error.code==="REFERRER_CAMPUS_REQUIRED"?"请联系管理员完善本人校区资料。":error.code==="RECEIVER_NOT_ACTIVE"?"该老师当前无法接收，请刷新后重新选择。":"提交未通过，请检查填写内容和当前身份。");
      }else{setUncertain(true);setNotice("尚未确认提交结果。内容已保留，请点击重试同一推荐，避免重复创建。");}
    }finally{lock.current=false;if(mounted.current){setBusy(false);if(!client.hasRoleContext)onSessionInvalidated();}}
  };
  const states:Record<string,string>={PENDING:"待接收",ACCEPTED:"已接收",ARCHIVED:"已归档",REACTIVATED:"待重新接收"};
  return <>
    <View className="panel">
      <Text className="panel-title">推荐学生</Text>
      <Text className="panel-description">每位接收老师和课程分别记录。</Text>
      <Input placeholder="学生名字" maxlength={100} value={student} disabled={busy||uncertain} onInput={e=>setStudent(e.detail.value)}/>
      <Input placeholder="课程" maxlength={100} value={course} disabled={busy||uncertain} onInput={e=>setCourse(e.detail.value)}/>
      <Picker mode="selector" range={teachers.map(t=>t.nickname)} value={Math.max(0,teachers.findIndex(t=>t.personId===receiver))} disabled={busy||uncertain||!teachers.length} onChange={e=>setReceiver(teachers[Number(e.detail.value)]?.personId??"")}>
        <View className="picker-value">{teachers.find(t=>t.personId===receiver)?.nickname??"选择接收老师"}</View>
      </Picker>
      <Picker mode="selector" range={["一对一","小班课"]} value={classType==="ONE_TO_ONE"?0:1} disabled={busy||uncertain} onChange={e=>setClassType(Number(e.detail.value)===0?"ONE_TO_ONE":"SMALL_GROUP")}>
        <View className="picker-value">{classType==="ONE_TO_ONE"?"一对一":"小班课"}</View>
      </Picker>
      <Button disabled={busy} onClick={()=>void submit()}>{uncertain?"重试同一推荐":"提交推荐"}</Button>
      {!!notice&&<Text className="panel-description">{notice}</Text>}
    </View>
    <View className="panel">
      <View className="section-heading"><Text className="panel-title">我推荐的学生</Text><Button className="quiet-button" disabled={busy} onClick={()=>void refresh()}>刷新推荐</Button></View>
      {!sent.length&&<Text className="panel-description">暂无推荐记录</Text>}
      {sent.map(item=><View className="student-row" key={item.referralId}><View className="student-detail">
        <Text className="student-name">{item.studentDisplayName}</Text>
        <Text className="student-meta">{item.receiverNickname} · {item.courseContextId} · {states[item.referralStatus]??"状态待确认"}</Text>
        {item.weeklyFees.map(fee=><Text className="student-meta" key={fee.entryId}>{fee.weekStartsOn}—{fee.weekEndsOn}：{formatCentsAsBeans(fee.grossAmountCents)} 欢乐豆</Text>)}
      </View></View>)}
    </View>
  </>;
}
