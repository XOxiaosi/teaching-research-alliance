import { useEffect, useRef, useState } from "react";
import { Button, Text, View } from "@tarojs/components";
import { ApiClientError, StaleResponseError, type ReferralLifecycleSubmission, type TeacherApiClient } from "@teaching-research-alliance/client";

type Referral = Readonly<{ referralId: string; studentDisplayName: string; courseContextId: string; referralStatus: string; version: number }>;
type Props = Readonly<{ client: TeacherApiClient; referrals: readonly Referral[]; sessionKey: string; busy: boolean; onChanged: () => Promise<void>; onUnconfirmedChange: (value: boolean) => void; onInvalidated: () => void }>;
const uncertain = (error: unknown): boolean => !(error instanceof ApiClientError) || error.status >= 500;

/** Completion command remains local and immutable while its network result is unknown. */
export function ReceivedReferralCompletionPanel({ client, referrals, sessionKey, busy, onChanged, onUnconfirmedChange, onInvalidated }: Props) {
  const [pending, setPending] = useState<ReferralLifecycleSubmission | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);
  const generation = useRef(0);
  useEffect(() => { mounted.current = true; generation.current += 1; setPending(null); setLoading(false); setNotice(""); return () => { mounted.current = false; generation.current += 1; }; }, [sessionKey]);
  useEffect(() => { onUnconfirmedChange(pending !== null); return () => onUnconfirmedChange(false); }, [pending, onUnconfirmedChange]);
  const execute = async (submission: ReferralLifecycleSubmission): Promise<void> => {
    const expected = generation.current;
    setLoading(true); setNotice("");
    try { await client.changeReferralLifecycle(submission); if (!mounted.current || expected !== generation.current) return; setPending(null); setNotice("学生课程已完结，后续不能新增周费用。"); await onChanged(); }
    catch (error) {
      if (!mounted.current || expected !== generation.current || error instanceof StaleResponseError) return;
      if (error instanceof ApiClientError && (error.status === 401 || error.status === 403)) { setPending(null); onInvalidated(); return; }
      if (error instanceof ApiClientError && error.status === 409) { setPending(null); setNotice("该推荐已有新状态，旧命令已清空。请刷新后核对。"); await onChanged(); return; }
      if (uncertain(error)) { setPending(submission); setNotice("完结结果尚未确认。请安全重试原操作。"); return; }
      setPending(null); setNotice("完结未完成，请刷新后核对。");
    } finally { if (mounted.current && expected === generation.current) setLoading(false); }
  };
  const start = (item: Referral): void => { if (pending || loading) return; try { void execute(client.createReferralLifecycleSubmission({ referralId: item.referralId, expectedVersion: item.version, command: "COMPLETE" })); } catch { setNotice("当前身份不能完结该学生课程。"); } };
  const accepted = referrals.filter((item) => item.referralStatus === "ACCEPTED"); const locked = busy || loading || pending !== null;
  return <>{accepted.map((item) => <View className="student-row" key={`complete-${item.referralId}`} data-referral-completion={item.referralId}><View className="student-detail"><Text className="student-name">{item.studentDisplayName}</Text><Text className="student-meta">{item.courseContextId} · 已接收，可完结</Text></View><Button className="quiet-button student-button" disabled={locked} onClick={() => start(item)}>完结课程</Button></View>)}{pending && <Button className="quiet-button" disabled={busy || loading} onClick={() => void execute(pending)}>安全重试原完结操作</Button>}{notice && <Text className="panel-description">{notice}</Text>}</>;
}
