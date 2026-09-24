import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ApiClientError,
  StaleResponseError,
  type ReferralAcceptanceSubmission,
  type ReferralCopySubmission,
  type ReferralLifecycleCommand,
  type ReferralLifecycleSubmission,
  type ReceivingTeacher,
  type SentReferral,
  type TeacherApiClient,
} from "@teaching-research-alliance/client";

export type ReferralManagementVenue = Readonly<{ id: string; name: string }>;
export type ReceivedReferral = Readonly<{
  referralId: string;
  studentRecordId: string;
  studentDisplayName: string;
  courseContextId: string;
  referralStatus: "PENDING" | "ACCEPTED" | "ARCHIVED" | "REACTIVATED";
  version: number;
  initialVenueId: string | null;
  submittedAt: string;
  unacceptedExpiresAt: string | null;
  weeklyFees: readonly Readonly<{ entryId: string; venueName?: string }> [];
}>;

type ReferralClient = TeacherApiClient;
type PendingCommand =
  | Readonly<{ kind: "accept"; referralId: string; label: string; submission: ReferralAcceptanceSubmission }>
  | Readonly<{ kind: "lifecycle"; referralId: string; label: string; submission: ReferralLifecycleSubmission }>
  | Readonly<{ kind: "copy"; referralId: string; label: string; submission: ReferralCopySubmission }>;

type Props = Readonly<{
  client: ReferralClient;
  venues: readonly ReferralManagementVenue[];
  sessionKey: string;
  canReceive?: boolean;
  revision?: number;
  busy?: boolean;
  onInvalidated?: () => void;
  onUnconfirmedChange?: (unconfirmed: boolean) => void;
}>;

const labels: Readonly<Record<ReceivedReferral["referralStatus"], string>> = {
  PENDING: "待接收",
  ACCEPTED: "已接收",
  ARCHIVED: "已归档",
  REACTIVATED: "待重新接收",
};

const isInvalidation = (error: unknown): boolean => error instanceof ApiClientError && (error.status === 401 || error.status === 403);
const isUnconfirmed = (error: unknown): boolean => !(error instanceof ApiClientError) || error.status >= 500;

/**
 * Web-specific receiving and sender lifecycle UI. The parent owns role visibility;
 * this component only renders operations exposed by the shared referral contract.
 */
export function ReferralManagementPanel({ client, venues, sessionKey, canReceive = true, revision = 0, busy = false, onInvalidated, onUnconfirmedChange }: Props): ReactNode {
  const [received, setReceived] = useState<readonly ReceivedReferral[]>([]);
  const [sent, setSent] = useState<readonly SentReferral[]>([]);
  const [teachers, setTeachers] = useState<readonly ReceivingTeacher[]>([]);
  const [selectedVenue, setSelectedVenue] = useState<Record<string, string>>({});
  const [copySource, setCopySource] = useState<SentReferral | null>(null);
  const [copyReceiver, setCopyReceiver] = useState("");
  const [pending, setPending] = useState<PendingCommand | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const mounted = useRef(false);

  const invalidate = (): void => {
    setReceived([]); setSent([]); setTeachers([]); setCopySource(null); setPending(null);
    onInvalidated?.();
  };
  const load = async (expected = generation.current): Promise<void> => {
    try {
      const [nextReceived, nextSent, nextTeachers] = await Promise.all([
        canReceive ? client.listReceivedReferrals<readonly ReceivedReferral[]>() : Promise.resolve([] as readonly ReceivedReferral[]),
        client.listSentReferrals(),
        client.listReceivingTeachers(),
      ]);
      if (!mounted.current || generation.current !== expected) return;
      setReceived(nextReceived); setSent(nextSent); setTeachers(nextTeachers);
    } catch (error) {
      if (!mounted.current || generation.current !== expected || error instanceof StaleResponseError) return;
      if (isInvalidation(error)) { invalidate(); setMessage("登录或身份已失效，请重新登录或选择身份。"); return; }
      setMessage("推荐记录暂未加载，请刷新重试。");
    }
  };
  useEffect(() => {
    mounted.current = true;
    generation.current += 1;
    const expected = generation.current;
    setReceived([]); setSent([]); setTeachers([]); setSelectedVenue({}); setCopySource(null); setPending(null); setMessage("");
    void load(expected);
    return () => { generation.current += 1; mounted.current = false; };
  }, [client, sessionKey, canReceive, revision]);
  useEffect(() => { onUnconfirmedChange?.(loading || pending !== null); return () => onUnconfirmedChange?.(false); }, [loading, pending, onUnconfirmedChange]);

  const refresh = async (): Promise<void> => {
    if (loading || pending !== null) return;
    setLoading(true); setMessage("");
    await load(generation.current);
    if (mounted.current) setLoading(false);
  };
  const execute = async (command: PendingCommand): Promise<void> => {
    if (loading) return;
    setLoading(true); setMessage("");
    try {
      if (command.kind === "accept") await client.acceptReferral(command.submission);
      else if (command.kind === "lifecycle") await client.changeReferralLifecycle(command.submission);
      else await client.copyReferral(command.submission);
      if (!mounted.current) return;
      setPending(null); setCopySource(null); setMessage(`${command.label}已完成。`);
      await load(generation.current);
    } catch (error) {
      if (!mounted.current || error instanceof StaleResponseError) return;
      if (isInvalidation(error)) { invalidate(); setMessage("登录或身份已失效，请重新登录或选择身份。"); return; }
      if (!isUnconfirmed(error)) {
        setPending(null);
        if (error instanceof ApiClientError && error.status === 409) { setMessage("该推荐已有新状态，请刷新后查看。 "); await load(generation.current); }
        else setMessage(`${command.label}未完成，请检查当前状态后重试。`);
        return;
      }
      setPending(command); setMessage(`${command.label}结果尚未确认。请安全重试原操作，系统会沿用原命令。`);
    } finally { if (mounted.current) setLoading(false); }
  };
  const accept = (item: ReceivedReferral): void => {
    if (pending !== null) return;
    try {
      const venueId = selectedVenue[item.referralId];
      if (!venueId) { setMessage("请选择实际授课场地后再接收。 "); return; }
      const submission = client.createReferralAcceptanceSubmission({ referralId: item.referralId, venueId, expectedVersion: item.version });
      void execute({ kind: "accept", referralId: item.referralId, label: "接收学生", submission });
    } catch { setMessage("当前身份不能接收该学生，请刷新后重试。"); }
  };
  const lifecycle = (item: SentReferral, command: ReferralLifecycleCommand): void => {
    if (pending !== null) return;
    try {
      const submission = client.createReferralLifecycleSubmission({ referralId: item.referralId, expectedVersion: item.version, command });
      void execute({ kind: "lifecycle", referralId: item.referralId, label: command === "ARCHIVE" ? "归档推荐" : "重新激活推荐", submission });
    } catch { setMessage("当前身份不能操作该推荐，请刷新后重试。"); }
  };
  const startCopy = (item: SentReferral): void => { if (pending === null) { setCopySource(item); setCopyReceiver(""); setMessage(""); } };
  const copy = (): void => {
    if (copySource === null || pending !== null) return;
    if (!copyReceiver || copyReceiver === copySource.receiverPersonId) { setMessage("请选择与原推荐不同的接收老师。 "); return; }
    try {
      const submission = client.createReferralCopySubmission({ sourceReferralId: copySource.referralId, receiverPersonId: copyReceiver });
      void execute({ kind: "copy", referralId: copySource.referralId, label: "创建独立推荐", submission });
    } catch { setMessage("不能创建这条独立推荐，请检查接收老师后重试。"); }
  };
  const locked = busy || loading || pending !== null;
  return <section className="panel referral-management-panel" aria-label="学生接收与推荐管理">
    <div className="section-title"><div><span className="fee-eyebrow">REFERRAL MANAGEMENT</span><h2>学生接收与推荐管理</h2></div><button type="button" onClick={() => void refresh()} disabled={locked}>刷新</button></div>
    <p>接收时选择实际授课场地。归档保留历史和已登记费用；重新激活沿用原推荐，再推给其他老师会创建独立推荐。</p>
    {message !== "" && <p className="message" role={pending === null ? "status" : "alert"}>{message}</p>}
    {pending !== null && <button type="button" onClick={() => void execute(pending)} disabled={loading || busy}>安全重试原操作</button>}
    {canReceive && <section className="referral-received"><h3>待接收学生</h3>
      {received.length === 0 ? <p>暂无可处理的学生。</p> : received.map((item) => <article key={item.referralId} data-referral-id={item.referralId}>
        <div><h4>{item.studentDisplayName}</h4><p>{item.courseContextId} · {labels[item.referralStatus]}</p><small>推荐编号 {item.referralId}</small></div>
        {(item.referralStatus === "PENDING" || item.referralStatus === "REACTIVATED") && <div className="referral-accept-actions"><label>实际授课场地<select aria-label={`接收场地-${item.referralId}`} value={selectedVenue[item.referralId] ?? ""} disabled={locked} onChange={(event) => setSelectedVenue((current) => ({ ...current, [item.referralId]: event.target.value }))}><option value="">请选择场地</option>{venues.map((venue) => <option value={venue.id} key={venue.id}>{venue.name}</option>)}</select></label><button type="button" onClick={() => accept(item)} disabled={locked || venues.length === 0}>接收学生</button></div>}
        {item.referralStatus === "ACCEPTED" && <p>已按所选场地接收，可前往周费用录入。</p>}
      </article>)}
    </section>}
    <section className="referral-sent sent-referrals"><h3>我推荐的学生</h3>
      {sent.length === 0 ? <p>暂无已发送推荐。</p> : sent.map((item) => <article key={item.referralId} data-referral-id={item.referralId}><div><h4>{item.studentDisplayName}</h4><p>{item.receiverNickname} · {item.courseContextId} · {labels[item.referralStatus as ReceivedReferral["referralStatus"]] ?? item.referralStatus}</p><small>推荐编号 {item.referralId}</small></div><div><button type="button" onClick={() => lifecycle(item, item.referralStatus === "ARCHIVED" ? "REACTIVATE" : "ARCHIVE")} disabled={locked}>{item.referralStatus === "ARCHIVED" ? "重新激活" : "归档推荐"}</button><button type="button" onClick={() => startCopy(item)} disabled={locked}>再推给其他老师</button></div></article>)}
    </section>
    {copySource !== null && <section className="referral-copy" aria-label="再推给其他老师"><h3>再推给其他老师</h3><p>{copySource.studentDisplayName} 将创建新的独立推荐，不复制旧费用。</p><label>新的接收老师<select aria-label="新的接收老师" value={copyReceiver} disabled={locked} onChange={(event) => setCopyReceiver(event.target.value)}><option value="">请选择接收老师</option>{teachers.filter((teacher) => teacher.personId !== copySource.receiverPersonId).map((teacher) => <option value={teacher.personId} key={teacher.personId}>{teacher.nickname}</option>)}</select></label><button type="button" onClick={copy} disabled={locked}>创建独立推荐</button><button type="button" onClick={() => setCopySource(null)} disabled={locked}>取消</button></section>}
  </section>;
}
