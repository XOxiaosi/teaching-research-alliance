import { useEffect, useRef, useState } from "react";
import { Button, Text, View } from "@tarojs/components";
import { ApiClientError, StaleResponseError, type ManagedReferral, type ReferralLifecycleSubmission, type TeacherApiClient } from "@teaching-research-alliance/client";

type Props = Readonly<{ client: TeacherApiClient; sessionKey: string; busy: boolean; onUnconfirmedChange: (value: boolean) => void; onInvalidated: () => void }>;
const label: Readonly<Record<ManagedReferral["referralStatus"], string>> = { ACCEPTED: "已接收", COMPLETED: "已完结" };
const authFailure = (error: unknown): boolean => error instanceof ApiClientError && (error.status === 401 || error.status === 403);
const uncertain = (error: unknown): boolean => !(error instanceof ApiClientError) || error.status >= 500;

/** Strict GLOBAL administrators get a separate directory so ordinary referral pages never expose cross-person actions. */
export function ManagedReferralCompletionPanel({ client, sessionKey, busy, onUnconfirmedChange, onInvalidated }: Props) {
  const [items, setItems] = useState<readonly ManagedReferral[]>([]);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<ReferralLifecycleSubmission | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const load = async (expected = generation.current): Promise<void> => {
    try {
      const next = await client.listManagedReferrals();
      if (mounted.current && expected === generation.current) setItems(next);
    } catch (error) {
      if (!mounted.current || expected !== generation.current || error instanceof StaleResponseError) return;
      if (authFailure(error)) { setItems([]); onInvalidated(); return; }
      setNotice("管理员推荐目录暂未加载，请刷新重试。");
    }
  };
  useEffect(() => { mounted.current = true; generation.current += 1; const expected = generation.current; setItems([]); setNotice(""); setPending(null); void load(expected); return () => { mounted.current = false; generation.current += 1; }; }, [client, sessionKey]);
  useEffect(() => { onUnconfirmedChange(pending !== null); return () => onUnconfirmedChange(false); }, [pending, onUnconfirmedChange]);
  const execute = async (submission: ReferralLifecycleSubmission): Promise<void> => {
    const expected = generation.current;
    setLoading(true); setNotice("");
    try {
      await client.changeReferralLifecycle(submission);
      if (!mounted.current || expected !== generation.current) return;
      setPending(null); setNotice("学生课程已完结，后续不能新增周费用。"); await load(expected);
    } catch (error) {
      if (!mounted.current || expected !== generation.current || error instanceof StaleResponseError) return;
      if (authFailure(error)) { setItems([]); setPending(null); onInvalidated(); return; }
      if (error instanceof ApiClientError && error.status === 409) { setPending(null); setNotice("该推荐已有新状态，旧命令已清空。请刷新后核对。"); await load(expected); return; }
      if (uncertain(error)) { setPending(submission); setNotice("完结结果尚未确认。请使用原命令安全重试。"); return; }
      setPending(null); setNotice("完结未完成，请刷新后核对当前状态。");
    } finally { if (mounted.current && expected === generation.current) setLoading(false); }
  };
  const complete = (item: ManagedReferral): void => {
    if (pending !== null || loading) return;
    try { void execute(client.createReferralLifecycleSubmission({ referralId: item.referralId, expectedVersion: item.version, command: "COMPLETE" })); }
    catch { setNotice("当前管理员身份不能完结推荐，请重新选择身份。"); }
  };
  const locked = busy || loading || pending !== null;
  return <View className="panel" data-managed-referral-completion="true">
    <View className="section-heading"><Text className="panel-title">管理员推荐完结</Text><Button className="quiet-button" disabled={locked} onClick={() => void load()}>刷新</Button></View>
    <Text className="panel-description">仅显示全局管理员可处理的推荐。完结后停止新增周费用，历史费用仍可查看和更正。</Text>
    {notice && <Text className="panel-description">{notice}</Text>}
    {pending && <Button className="primary-button" disabled={busy || loading} onClick={() => void execute(pending)}>安全重试原完结操作</Button>}
    {!items.length && !loading && <Text className="panel-description">暂无推荐记录。</Text>}
    {items.map((item) => <View className="student-row" key={item.referralId}><View className="student-detail"><Text className="student-name">{item.studentDisplayName}</Text><Text className="student-meta">接收：{item.receiverNickname} · 推荐：{item.referrerNickname}</Text><Text className="student-meta">{item.courseContextId} · {label[item.referralStatus]}</Text></View>{item.referralStatus === "ACCEPTED" ? <Button className="quiet-button student-button" disabled={locked} onClick={() => complete(item)}>完结课程</Button> : item.referralStatus === "COMPLETED" ? <Text className="student-meta">完结撒花</Text> : null}</View>)}
  </View>;
}
