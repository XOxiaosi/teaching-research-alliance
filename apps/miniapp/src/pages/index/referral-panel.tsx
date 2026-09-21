import { useEffect, useRef, useState } from "react";
import Taro from "@tarojs/taro";
import { Button, Input, Picker, Text, View } from "@tarojs/components";
import { ApiClientError, StaleResponseError, formatCentsAsBeans,
  type TeacherApiClient, type ReceivingTeacher, type SentReferral,
  type ReferralCreationSubmission, type ReferralClassType, type ReferralLifecycleCommand,
  type ReferralLifecycleSubmission, type ReferralCopySubmission } from "@teaching-research-alliance/client";

type PendingLifecycleCommand = Readonly<{
  referralId: string;
  studentDisplayName: string;
  command: ReferralLifecycleCommand;
  submission: ReferralLifecycleSubmission;
}>;

const lifecycleCopy: Readonly<Record<ReferralLifecycleCommand, Readonly<{
  action: string; title: string; content: string; success: string; retry: string;
}>>> = {
  ARCHIVE: {
    action: "归档推荐", title: "归档这条推荐？",
    content: "归档后将隐藏为当前推荐，历史记录和已登记费用仍会保留，也不会退款。",
    success: "推荐已归档，历史记录仍可查看。",
    retry: "归档结果尚未确认。请再次点击归档推荐，系统会沿用原请求确认结果。"
  },
  REACTIVATE: {
    action: "重新推送", title: "重新推送这条推荐？",
    content: "将恢复这条原有推荐，并重新开始 21 天等待接收期。",
    success: "推荐已重新推送，新的 21 天等待接收期已开始。",
    retry: "重新推送结果尚未确认。请再次点击重新推送，系统会沿用原请求确认结果。"
  }
};

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
  const [copySource,setCopySource]=useState<SentReferral|null>(null);
  const [copyReceiver,setCopyReceiver]=useState("");
  const [copyCourse,setCopyCourse]=useState("");
  const [copyClassType,setCopyClassType]=useState<ReferralClassType|"">("");
  const [copyUncertain,setCopyUncertain]=useState(false);
  const [notice,setNotice]=useState("");
  const [,setLifecycleRevision]=useState(0);
  const pending=useRef<ReferralCreationSubmission|null>(null);
  const pendingCopy=useRef<{sourceReferralId:string;submission:ReferralCopySubmission}|null>(null);
  const pendingLifecycle=useRef(new Map<string,PendingLifecycleCommand>());
  const lock=useRef(false);
  const mounted=useRef(true);
  const refreshLifecycleCommands=()=>setLifecycleRevision(revision=>revision+1);
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
    try{await load();if(mounted.current)setNotice(uncertain||copyUncertain||pendingLifecycle.current.size>0?"列表已刷新，未确认的操作仍可用原请求重试。":"推荐记录已刷新。");}
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
  const openCopy=(item:SentReferral)=>{
    if(lock.current||pendingLifecycle.current.has(item.referralId))return;
    if(copyUncertain||pendingCopy.current!==null){setNotice("请先确认或重试当前未确认的复制推荐。");return;}
    setCopySource(item);setCopyReceiver(item.receiverPersonId);setCopyCourse(item.courseContextId);setCopyClassType(item.classType==="ONE_TO_ONE"||item.classType==="SMALL_GROUP"?item.classType:"");setNotice("");
  };
  const submitCopy=async()=>{
    if(lock.current)return;
    const source=copySource;
    const selectedClass:ReferralClassType|undefined=copyClassType===""?undefined:copyClassType;
    const selectedCourse=copyCourse.trim();
    if(source===null)return;
    if(pendingCopy.current===null){
      if(!copyReceiver){setNotice("请选择接收老师。");return;}
      if(!selectedCourse){setNotice("请填写课程。");return;}
      if(copyReceiver===source.receiverPersonId&&selectedCourse===source.courseContextId){setNotice("请更换老师或课程；原推荐可重新推送");return;}
      if(selectedClass===undefined){setNotice("这条旧推荐没有班型，请明确选择后再复制。");return;}
    }
    lock.current=true;setBusy(true);setNotice("");
    try{
      if(pendingCopy.current===null){
        const draft={
          sourceReferralId:source.referralId,
          receiverPersonId:copyReceiver,
          courseContextId:selectedCourse,
          classType:selectedClass!
        };
        pendingCopy.current={sourceReferralId:source.referralId,submission:client.createReferralCopySubmission(draft)};
      }
      const result=await client.copyReferral(pendingCopy.current.submission);
      if(!mounted.current)return;
      pendingCopy.current=null;setCopyUncertain(false);setCopySource(null);
      setNotice(result.replay?"复制推荐已确认，未重复创建。":"已为该学生创建一条独立的新推荐。");
      try{await load();}catch(error){if(!(error instanceof StaleResponseError)&&mounted.current)setNotice("复制推荐已提交，列表刷新失败，请稍后刷新查看。");}
    }catch(error){
      if(!mounted.current||error instanceof StaleResponseError)return;
      if(error instanceof ApiClientError&&error.status<500){
        pendingCopy.current=null;setCopyUncertain(false);
        setNotice(error.status===409?"原推荐已有新状态，请刷新后重新选择。":"复制推荐未完成，请检查接收老师、课程和当前身份后重试。");
      }else{setCopyUncertain(true);setNotice("复制结果尚未确认。表单已锁定，请重试同一推荐，避免重复创建。");}
    }finally{lock.current=false;if(mounted.current){setBusy(false);if(!client.hasRoleContext)onSessionInvalidated();}}
  };
  const lifecycleLabel=(command:ReferralLifecycleCommand,pendingCommand:PendingLifecycleCommand|undefined)=>pendingCommand?`重试${lifecycleCopy[command].action}`:lifecycleCopy[command].action;
  const retryLifecycle=async(pendingCommand:PendingLifecycleCommand)=>{
    if(lock.current)return;
    const copy=lifecycleCopy[pendingCommand.command];
    lock.current=true;setBusy(true);setNotice("");
    try{
      const result=await client.changeReferralLifecycle(pendingCommand.submission);
      if(!mounted.current)return;
      pendingLifecycle.current.delete(pendingCommand.referralId);refreshLifecycleCommands();
      setNotice(result.replay?`${copy.success}（已确认之前的操作。）`:copy.success);
      try{await load();}catch(error){if(!(error instanceof StaleResponseError)&&mounted.current)setNotice(`${copy.success} 列表刷新失败，请稍后刷新查看。`);}
    }catch(error){
      if(!mounted.current||error instanceof StaleResponseError)return;
      if(error instanceof ApiClientError&&error.status<500){
        pendingLifecycle.current.delete(pendingCommand.referralId);refreshLifecycleCommands();
        if(error.status===409){
          setNotice("该推荐已有新状态，请刷新后再试。");
          try{await load();}catch{setNotice("该推荐已有新状态，但刷新失败。请稍后刷新后再试。");}
        }else if(error.code==="REFERRAL_STATE_CONFLICT")setNotice("该推荐当前不能执行此操作，请刷新后查看状态。");
        else setNotice("操作未完成，请检查当前身份或刷新后重试。");
      }else setNotice(copy.retry);
    }finally{lock.current=false;if(mounted.current){setBusy(false);if(!client.hasRoleContext)onSessionInvalidated();}}
  };
  const changeLifecycle=async(item:SentReferral,command:ReferralLifecycleCommand)=>{
    const existing=pendingLifecycle.current.get(item.referralId);
    if(existing!==undefined){await retryLifecycle(existing);return;}
    if(lock.current)return;
    const copy=lifecycleCopy[command];
    let confirmation:Awaited<ReturnType<typeof Taro.showModal>>;
    try{confirmation=await Taro.showModal({title:copy.title,content:copy.content,confirmText:copy.action,cancelText:"暂不操作"});}
    catch{if(mounted.current)setNotice("暂时无法打开确认窗口，请稍后再试。");return;}
    if(!mounted.current||!confirmation.confirm||lock.current)return;
    let pendingCommand:PendingLifecycleCommand;
    try{
      pendingCommand={referralId:item.referralId,studentDisplayName:item.studentDisplayName,command,submission:client.createReferralLifecycleSubmission({referralId:item.referralId,expectedVersion:item.version,command})};
      pendingLifecycle.current.set(item.referralId,pendingCommand);
      refreshLifecycleCommands();
    }catch(error){
      if(mounted.current){setNotice("操作未完成，请检查当前身份后重试。");if(!client.hasRoleContext)onSessionInvalidated();}
      return;
    }
    await retryLifecycle(pendingCommand);
  };
  const pendingOutsideList=[...pendingLifecycle.current.values()].filter(command=>!sent.some(item=>item.referralId===command.referralId));
  const copyTeachers=copySource===null?[]:teachers;
  const states:Record<string,string>={PENDING:"待接收",ACCEPTED:"已接收",ARCHIVED:"已归档",REACTIVATED:"待重新接收"};
  return <>
    <View className="panel">
      <Text className="panel-title">推荐学生</Text>
      <Text className="panel-description">每位接收老师和课程分别记录。</Text>
      <Input placeholder="学生名字" maxlength={100} value={student} disabled={busy||uncertain} onInput={e=>setStudent(e.detail.value)}/>
      <Input placeholder="课程" maxlength={100} value={course} disabled={busy||uncertain} onInput={e=>setCourse(e.detail.value)}/>
      <Picker mode="selector" range={["请选择接收老师",...teachers.map(t=>t.nickname)]} value={teachers.findIndex(t=>t.personId===receiver)+1} disabled={busy||uncertain||!teachers.length} onChange={e=>setReceiver(teachers[Number(e.detail.value)-1]?.personId??"")}>
        <View className="picker-value">{teachers.find(t=>t.personId===receiver)?.nickname??"选择接收老师"}</View>
      </Picker>
      <Picker mode="selector" range={["一对一","小班课"]} value={classType==="ONE_TO_ONE"?0:1} disabled={busy||uncertain} onChange={e=>setClassType(Number(e.detail.value)===0?"ONE_TO_ONE":"SMALL_GROUP")}>
        <View className="picker-value">{classType==="ONE_TO_ONE"?"一对一":"小班课"}</View>
      </Picker>
      <Button disabled={busy} onClick={()=>void submit()}>{uncertain?"重试同一推荐":"提交推荐"}</Button>
      {!!notice&&<Text className="panel-description">{notice}</Text>}
    </View>
    {copySource!==null&&<View className="panel">
      <Text className="panel-title">再推给其他老师</Text>
      <Text className="panel-description">学生：{copySource.studentDisplayName}。这会创建一条独立推荐，不会带入原记录的费用、接收或场地。</Text>
      <Input placeholder="课程" maxlength={100} value={copyCourse} disabled={busy||copyUncertain} onInput={event=>setCopyCourse(event.detail.value)}/>
      <Picker mode="selector" range={["请选择接收老师",...copyTeachers.map(teacher=>teacher.nickname)]} value={copyTeachers.findIndex(teacher=>teacher.personId===copyReceiver)+1} disabled={busy||copyUncertain||!copyTeachers.length} onChange={event=>setCopyReceiver(copyTeachers[Number(event.detail.value)-1]?.personId??"")}>
        <View className="picker-value">{copyTeachers.find(teacher=>teacher.personId===copyReceiver)?.nickname??"选择接收老师"}</View>
      </Picker>
      <Picker mode="selector" range={["请选择班型","一对一","小班课"]} value={copyClassType===""?0:copyClassType==="ONE_TO_ONE"?1:2} disabled={busy||copyUncertain} onChange={event=>setCopyClassType(Number(event.detail.value)===1?"ONE_TO_ONE":Number(event.detail.value)===2?"SMALL_GROUP":"")}>
        <View className="picker-value">{copyClassType===""?"选择班型":copyClassType==="ONE_TO_ONE"?"一对一":"小班课"}</View>
      </Picker>
      <Button disabled={busy} onClick={()=>void submitCopy()}>{copyUncertain?"重试同一复制推荐":"创建独立推荐"}</Button>
      {!copyUncertain&&<Button className="quiet-button" disabled={busy} onClick={()=>setCopySource(null)}>取消</Button>}
    </View>}
    <View className="panel">
      <View className="section-heading"><Text className="panel-title">我推荐的学生</Text><Button className="quiet-button" disabled={busy} onClick={()=>void refresh()}>刷新推荐</Button></View>
      {!sent.length&&<Text className="panel-description">暂无推荐记录</Text>}
      {sent.map(item=>{const pendingCommand=pendingLifecycle.current.get(item.referralId);const command:ReferralLifecycleCommand=pendingCommand?.command??(item.referralStatus==="ARCHIVED"?"REACTIVATE":"ARCHIVE");return <View className="student-row" key={item.referralId}><View className="student-detail">
        <Text className="student-name">{item.studentDisplayName}</Text>
        <Text className="student-meta">{item.receiverNickname} · {item.courseContextId} · {states[item.referralStatus]??"状态待确认"}</Text>
        {item.weeklyFees.map(fee=><Text className="student-meta" key={fee.entryId}>{fee.weekStartsOn}—{fee.weekEndsOn}：{formatCentsAsBeans(fee.grossAmountCents)} 欢乐豆</Text>)}
        <Button className="quiet-button" disabled={busy} onClick={()=>void changeLifecycle(item,command)}>{lifecycleLabel(command,pendingCommand)}</Button>
        <Button className="quiet-button" disabled={busy||copyUncertain||pendingCommand!==undefined||(copySource!==null&&copySource.referralId!==item.referralId)} onClick={()=>openCopy(item)}>再推给其他老师</Button>
      </View></View>;})}
      {pendingOutsideList.map(command=><View className="student-row" key={`pending-${command.referralId}`}><View className="student-detail">
        <Text className="student-name">{command.studentDisplayName}</Text>
        <Text className="student-meta">这条推荐的{lifecycleCopy[command.command].action}结果尚未确认。</Text>
        <Button className="quiet-button" disabled={busy} onClick={()=>void retryLifecycle(command)}>重试{lifecycleCopy[command.command].action}</Button>
      </View></View>)}
    </View>
  </>;
}
