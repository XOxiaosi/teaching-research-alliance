import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Input, Picker, Text, Textarea, View } from "@tarojs/components";
import {
  ApiClientError,
  RoleSelectionRequiredError,
  StaleResponseError,
  type AccountDirectoryItem,
  type AccountPasswordResetSubmission,
  type SessionSnapshot,
  type TeacherApiClient,
} from "@teaching-research-alliance/client";

type Props = Readonly<{
  client: TeacherApiClient;
  session: SessionSnapshot;
  sessionKey: string;
  busy?: boolean;
  onUnconfirmedChange: (pending: boolean) => void;
  onInvalidated: () => void;
  onOwnPasswordReset: () => void;
}>;

/** The client repeats this guard, while this export keeps the management UI out of scoped views. */
export const canManageMiniAccountAccess = (session: SessionSnapshot): boolean => {
  const context = session.currentRoleContext;
  return context !== null
    && context.scope === "GLOBAL"
    && context.regionId === undefined
    && context.campusId === undefined
    && context.venueId === undefined
    && ["SYSTEM_OWNER", "SYSTEM_ADMIN"].includes(String(context.subject));
};

const isAccessLoss = (error: unknown): boolean => error instanceof RoleSelectionRequiredError
  || error instanceof ApiClientError && (error.status === 401 || error.status === 403);

/** A 5xx response can follow a committed command, so it deliberately remains retryable. */
const isConfirmedRejection = (error: unknown): boolean => error instanceof ApiClientError
  && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 403;

const directoryLabel = (account: AccountDirectoryItem): string => {
  const authority = account.activeSystemAuthorities.length === 0
    ? "普通账号"
    : account.activeSystemAuthorities.map((item) => item === "SYSTEM_OWNER" ? "开发者" : "系统管理员").join("、");
  return `${account.nickname} · ${account.phoneNormalized} · ${authority} · ${account.loginStatus === "ACTIVE" && account.personStatus === "ACTIVE" ? "可登录" : "已停用"}`;
};

/**
 * Passwords and the frozen idempotent reset command exist only in this mounted component.
 * A network-uncertain result locks the original command so a retry cannot create a second reset.
 */
export function AccountAccessPanel({ client, session, sessionKey, busy = false, onUnconfirmedChange, onInvalidated, onOwnPasswordReset }: Props): ReactNode {
  const [accounts, setAccounts] = useState<readonly AccountDirectoryItem[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const requestGeneration = useRef(0);
  const pending = useRef<AccountPasswordResetSubmission | null>(null);
  const mounted = useRef(false);
  const locked = busy || loading || submitting || pending.current !== null;

  const reportPending = (): void => onUnconfirmedChange(pending.current !== null);
  const clearPasswordFields = (): void => { setNewPassword(""); setConfirmPassword(""); };
  const clearSensitive = (): void => {
    requestGeneration.current += 1;
    pending.current = null;
    setAccounts([]);
    setSelectedAccountId("");
    clearPasswordFields();
    setReason("");
    setLoading(false);
    setSubmitting(false);
    reportPending();
  };
  const invalidate = (): void => {
    clearSensitive();
    onInvalidated();
  };
  const loadDirectory = async (): Promise<void> => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    try {
      const next = await client.listAccounts();
      if (!mounted.current || generation !== requestGeneration.current) return;
      setAccounts(next);
      setSelectedAccountId((current) => next.some((account) => account.accountId === current) ? current : next[0]?.accountId ?? "");
    } catch (error) {
      if (!mounted.current || generation !== requestGeneration.current || error instanceof StaleResponseError) return;
      if (isAccessLoss(error) || !client.hasRoleContext) { invalidate(); return; }
      setNotice("账户目录暂未加载，请稍后刷新。");
    } finally {
      if (mounted.current && generation === requestGeneration.current) setLoading(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    setNotice("");
    clearPasswordFields();
    pending.current = null;
    reportPending();
    if (canManageMiniAccountAccess(session)) void loadDirectory();
    else { setAccounts([]); setLoading(false); }
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
    };
  }, [client, sessionKey]);

  const resetPassword = async (): Promise<void> => {
    if (submitting || pending.current === null && locked) return;
    if (pending.current === null) {
      if (selectedAccountId === "") { setNotice("请先选择需要重置密码的账户。"); return; }
      if (!reason.trim()) { setNotice("请填写密码重置理由。"); return; }
      if (newPassword.length < 8) { setNotice("新密码至少需要 8 位。"); return; }
      if (newPassword !== confirmPassword) { setNotice("两次输入的新密码不一致。"); return; }
      try {
        pending.current = client.createAccountPasswordResetSubmission({ accountId: selectedAccountId, newPassword, reason: reason.trim() });
        reportPending();
      } catch (error) {
        setNotice(error instanceof ApiClientError ? "请检查新密码和重置理由。" : "暂时无法创建重置命令，请稍后重试。");
        return;
      }
    }
    const command = pending.current;
    if (command === null) return;
    const generation = ++requestGeneration.current;
    setSubmitting(true);
    setNotice("");
    try {
      const result = await client.resetAccountPassword(command);
      if (!mounted.current || generation !== requestGeneration.current) return;
      pending.current = null;
      clearPasswordFields();
      reportPending();
      if (result.accountId === session.accountId || client.currentSession === null) {
        clearSensitive();
        onOwnPasswordReset();
        return;
      }
      setNotice(result.replay ? "密码重置已确认，未重复执行。" : "密码已重置，目标账户的旧会话已失效。");
      setSubmitting(false);
      await loadDirectory();
    } catch (error) {
      if (!mounted.current || generation !== requestGeneration.current || error instanceof StaleResponseError) return;
      if (isAccessLoss(error) || !client.hasRoleContext) { invalidate(); return; }
      if (isConfirmedRejection(error)) {
        pending.current = null;
        clearPasswordFields();
        reportPending();
        setNotice(error instanceof ApiClientError && error.code === "ACCOUNT_NOT_FOUND"
          ? "目标账户已不存在，请刷新账户目录。"
          : "密码未重置，请检查当前权限、目标账户和重置理由。");
        return;
      }
      setNotice("重置结果尚未确认。原账户、理由和新密码已锁定，请使用原按钮安全重试。");
    } finally {
      if (mounted.current && generation === requestGeneration.current) setSubmitting(false);
    }
  };

  if (!canManageMiniAccountAccess(session)) return null;
  const selectedIndex = Math.max(accounts.findIndex((account) => account.accountId === selectedAccountId), 0);
  return <View className="panel account-access-panel">
    <Text className="panel-title">账户与密码</Text>
    <Text className="panel-description">仅开发者或系统管理员的全局身份可查看目录并重置密码。重置理由会留在服务端审计记录中。</Text>
    <Button className="quiet-button" disabled={locked} onClick={() => void loadDirectory()}>刷新账户目录</Button>
    {notice !== "" && <View className="notice"><Text>{notice}</Text></View>}
    {loading ? <Text className="panel-description">正在读取账户目录…</Text> : accounts.length === 0 ? <Text className="panel-description">当前没有可重置密码的账户。</Text> : <>
      <Text className="field-label">目标账户</Text>
      <Picker mode="selector" range={accounts.map(directoryLabel)} value={selectedIndex} disabled={locked} onChange={(event) => { setSelectedAccountId(accounts[Number(event.detail.value)]?.accountId ?? ""); setNotice(""); }}>
        <View className="picker-value"><Text>{accounts[selectedIndex] === undefined ? "请选择账户" : directoryLabel(accounts[selectedIndex]!)}</Text><Text>⌄</Text></View>
      </Picker>
      <Text className="field-label">新密码</Text>
      <Input className="text-input" password value={newPassword} disabled={locked} placeholder="至少 8 位" onInput={(event) => setNewPassword(event.detail.value)} />
      <Text className="field-label">确认新密码</Text>
      <Input className="text-input" password value={confirmPassword} disabled={locked} placeholder="再次输入新密码" onInput={(event) => setConfirmPassword(event.detail.value)} />
      <Text className="field-label">重置理由</Text>
      <Textarea className="text-input account-access-reason" value={reason} maxlength={1000} disabled={locked} placeholder="说明本次密码重置的业务原因" onInput={(event) => setReason(event.detail.value)} />
      {pending.current !== null && <Text className="panel-description">结果待确认。目标账户、理由和新密码已锁定；请使用原请求安全重试。</Text>}
      <Button className="primary-button" data-account-access-action={pending.current === null ? "reset" : "retry-reset"} disabled={busy || submitting || loading} onClick={() => void resetPassword()}>{submitting ? "正在确认…" : pending.current === null ? "确认重置密码" : "安全重试原密码重置"}</Button>
    </>}
  </View>;
}
