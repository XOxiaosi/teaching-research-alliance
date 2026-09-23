import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ApiClientError,
  StaleResponseError,
  TeacherApiClient,
  type AccountDirectoryItem,
  type AccountPasswordResetSubmission,
  type SessionSnapshot,
} from "@teaching-research-alliance/client";
import { Button } from "./components/ui/button.js";

export const canManageAccounts = (session: SessionSnapshot | null): boolean => {
  const context = session?.currentRoleContext;
  return (context?.subject === "SYSTEM_OWNER" || context?.subject === "SYSTEM_ADMIN")
    && context.scope === "GLOBAL"
    && context.regionId === undefined
    && context.campusId === undefined
    && context.venueId === undefined;
};

type AuthenticationProps = Readonly<{
  client: TeacherApiClient;
  busy: boolean;
  run: (action: () => Promise<void>) => void;
  onAuthenticated: () => Promise<void>;
}>;

/** Password fields live only in this mounted form and are never copied into parent state. */
export function AccountAuthenticationPanel({ client, busy, run, onAuthenticated }: AuthenticationProps): ReactNode {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [phoneNormalized, setPhoneNormalized] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [legalName, setLegalName] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [validation, setValidation] = useState("");
  const [registrationUnconfirmed, setRegistrationUnconfirmed] = useState(false);

  const resetPasswords = (): void => {
    setPassword("");
    setPasswordConfirmation("");
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setValidation("");
    if (mode === "register" && registrationUnconfirmed) {
      setValidation("注册结果尚未确认。请先使用已填写的手机号和密码尝试登录，避免重复注册。");
      return;
    }
    if (mode === "register" && password !== passwordConfirmation) {
      setValidation("两次输入的密码不一致，请重新确认。");
      return;
    }
    run(async () => {
      try {
        if (mode === "register") {
          await client.registerAccount({ nickname, legalName, phoneNormalized, password });
        } else {
          await client.login({ phoneNormalized, password });
          setRegistrationUnconfirmed(false);
        }
        resetPasswords();
        await onAuthenticated();
      } catch (error) {
        if (mode === "register" && (!(error instanceof ApiClientError) || error.status >= 500)) {
          setRegistrationUnconfirmed(true);
          setMode("login");
          setValidation("注册结果尚未确认。请使用当前手机号和密码尝试登录；请勿再次提交注册。");
        }
        throw error;
      }
    });
  };

  return <section className="panel login account-authentication" aria-label="账户登录或注册">
    <div className="account-authentication-tabs" role="tablist" aria-label="账户操作">
      <Button type="button" role="tab" aria-selected={mode === "login"} variant={mode === "login" ? "default" : "outline"} disabled={busy} onClick={() => {
        setMode("login");
        // A registration 5xx can follow a committed account creation. Keep the
        // same credentials available for the required login confirmation.
        if (!registrationUnconfirmed) {
          setValidation("");
          resetPasswords();
        }
      }}>登录</Button>
      <Button type="button" role="tab" aria-selected={mode === "register"} variant={mode === "register" ? "default" : "outline"} disabled={busy || registrationUnconfirmed} onClick={() => { if (!registrationUnconfirmed) { setMode("register"); setValidation(""); resetPasswords(); } }}>注册普通老师账户</Button>
    </div>
    <form onSubmit={submit}>
      <h2>{mode === "login" ? "登录你的账户" : "注册普通老师账户"}</h2>
      <p>{mode === "login" ? "使用手机号与密码，进入你的个人工作台。" : "注册后仅获得普通老师本人功能；授课、推荐和管理权限须由后续任命取得。"}</p>
      {mode === "register" && <>
        <label>昵称<input aria-label="注册昵称" autoComplete="nickname" value={nickname} disabled={busy} onChange={(event) => setNickname(event.target.value)} required /></label>
        <label>姓名<input aria-label="注册姓名" autoComplete="name" value={legalName} disabled={busy} onChange={(event) => setLegalName(event.target.value)} required /></label>
      </>}
      <label>手机号<input aria-label="手机号" autoComplete="username" value={phoneNormalized} disabled={busy} onChange={(event) => setPhoneNormalized(event.target.value)} required /></label>
      <label>密码<input aria-label="密码" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} required /></label>
      {mode === "register" && <label>确认密码<input aria-label="确认密码" type="password" autoComplete="new-password" value={passwordConfirmation} disabled={busy} onChange={(event) => setPasswordConfirmation(event.target.value)} required /></label>}
      {validation !== "" && <p role="alert" className="account-access-notice">{validation}</p>}
      <Button disabled={busy}>{busy ? "正在提交…" : mode === "login" ? "登录" : "注册并进入工作台"}</Button>
    </form>
  </section>;
}

type AccountAccessPanelProps = Readonly<{
  client: TeacherApiClient;
  session: SessionSnapshot;
  sessionKey: string;
  busy?: boolean;
  active: boolean;
  onUnconfirmedChange?: (value: boolean) => void;
  onInvalidated: () => void;
  onSelfPasswordReset: () => void;
}>;

type Phase = "idle" | "loading" | "submitting" | "unknown";

const isAuthorizationError = (error: unknown): boolean => error instanceof ApiClientError
  && (error.status === 401 || error.status === 403);

const accountLabel = (item: AccountDirectoryItem): string => `${item.nickname} · ${item.phoneNormalized}`;

/** GLOBAL owners and administrators can inspect accounts and issue one frozen password-reset command. */
export function AccountAccessPanel({
  client,
  session,
  sessionKey,
  busy = false,
  active,
  onUnconfirmedChange,
  onInvalidated,
  onSelfPasswordReset,
}: AccountAccessPanelProps): ReactNode {
  const [items, setItems] = useState<readonly AccountDirectoryItem[] | null>(null);
  const [accountId, setAccountId] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [reason, setReason] = useState("");
  const [submission, setSubmission] = useState<AccountPasswordResetSubmission | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const requestGeneration = useRef(0);
  const previousKey = useRef("");
  const allowed = canManageAccounts(session);
  const fieldsLocked = busy || phase === "loading" || phase === "submitting" || phase === "unknown";
  const commandsLocked = busy || phase === "loading" || phase === "submitting";

  const clearSensitive = (): void => {
    setNewPassword("");
    setPasswordConfirmation("");
    setSubmission(null);
  };

  const reset = (): void => {
    requestGeneration.current += 1;
    setItems(null);
    setAccountId("");
    setReason("");
    clearSensitive();
    setPhase("idle");
    setMessage("");
  };

  const invalidate = (): void => {
    reset();
    onUnconfirmedChange?.(false);
    onInvalidated();
  };

  const load = (clearMessage = true): void => {
    if (!active || !allowed) return;
    const generation = ++requestGeneration.current;
    setPhase("loading");
    if (clearMessage) setMessage("");
    void client.listAccounts().then((next) => {
      if (requestGeneration.current !== generation) return;
      setItems(next);
      setAccountId((current) => current && next.some((item) => item.accountId === current) ? current : (next[0]?.accountId ?? ""));
      setPhase("idle");
    }).catch((error: unknown) => {
      if (requestGeneration.current !== generation) return;
      setPhase("idle");
      if (isAuthorizationError(error) || client.hasRoleContext === false) {
        invalidate();
        return;
      }
      setMessage("无法读取账号目录，请稍后重试。");
    });
  };

  useEffect(() => {
    const changed = previousKey.current !== sessionKey;
    previousKey.current = sessionKey;
    if (changed) reset();
    load();
    return () => { requestGeneration.current += 1; };
  }, [active, allowed, client, sessionKey]);

  useEffect(() => {
    onUnconfirmedChange?.(phase === "submitting" || phase === "unknown");
    return () => onUnconfirmedChange?.(false);
  }, [phase, onUnconfirmedChange]);

  const submit = async (): Promise<void> => {
    if (!allowed || commandsLocked) return;
    setMessage("");
    if (newPassword !== passwordConfirmation) {
      setMessage("两次输入的密码不一致，请重新确认。");
      return;
    }
    let command = submission;
    if (command === null) {
      try {
        command = client.createAccountPasswordResetSubmission({ accountId, newPassword, reason });
        setSubmission(command);
      } catch (error) {
        setMessage(error instanceof ApiClientError && error.code === "INVALID_INPUT" ? "请填写目标账号、重置理由和至少 8 位的新密码。" : "无法准备密码重置请求。");
        return;
      }
    }
    const generation = requestGeneration.current;
    setPhase("submitting");
    try {
      const result = await client.resetAccountPassword(command);
      if (requestGeneration.current !== generation) return;
      clearSensitive();
      setPhase("idle");
      setMessage(result.replay ? "密码重置已确认，未重复执行。" : "密码已重置，旧登录会话已失效。");
      if (client.currentSession === null || result.accountId === session.accountId) {
        onSelfPasswordReset();
        return;
      }
      load(false);
    } catch (error) {
      if (requestGeneration.current !== generation) return;
      if (isAuthorizationError(error) || client.hasRoleContext === false) {
        invalidate();
        return;
      }
      if (error instanceof ApiClientError && error.status >= 400 && error.status < 500) {
        clearSensitive();
        setPhase("idle");
        setMessage(error.status === 409 ? "请求已被服务器拒绝，请重新填写后再提交。" : "密码重置未完成，请检查填写内容后重试。");
        return;
      }
      setPhase("unknown");
      setMessage("重置结果尚未确认。请使用原请求安全重试，避免重复重置。");
    }
  };

  if (!allowed) return null;
  return <section className="panel account-access-panel" aria-label="账号管理" hidden={!active}>
    <div className="section-heading"><div><p className="eyebrow">账号与权限</p><h2>账号管理</h2><p>查看账号状态，或为指定账号重置密码。系统管理员不能重置系统所有者或其他系统管理员。</p></div><Button variant="outline" disabled={fieldsLocked} onClick={() => load()}>刷新目录</Button></div>
    {message !== "" && <p role="status" className={phase === "unknown" ? "account-access-notice" : "finance-success"}>{message}</p>}
    {items === null ? <p role="status">{phase === "loading" ? "正在读取账号目录…" : "账号目录尚未读取。"}</p> : <>
      {items.length === 0 ? <p>当前没有可管理的账号。</p> : <div className="account-directory" aria-label="账号目录">
        {items.map((item) => <article key={item.accountId}><div><strong>{item.nickname}</strong><p>{item.phoneNormalized} · {item.loginStatus === "ACTIVE" ? "可登录" : "已停用"}</p>{item.activeSystemAuthorities.length > 0 && <small>{item.activeSystemAuthorities.map((role) => role === "SYSTEM_OWNER" ? "系统所有者" : "系统管理员").join("、")}</small>}</div></article>)}
      </div>}
      <form className="account-reset-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <h3>重置指定账号密码</h3>
        <fieldset disabled={fieldsLocked}>
          <label>目标账号<select aria-label="目标账号" value={accountId} required onChange={(event) => setAccountId(event.target.value)}><option value="">请选择账号</option>{items.map((item) => <option key={item.accountId} value={item.accountId}>{accountLabel(item)}</option>)}</select></label>
          <label>新密码<input aria-label="新密码" type="password" autoComplete="new-password" value={newPassword} required onChange={(event) => setNewPassword(event.target.value)} /></label>
          <label>确认新密码<input aria-label="确认新密码" type="password" autoComplete="new-password" value={passwordConfirmation} required onChange={(event) => setPasswordConfirmation(event.target.value)} /></label>
          <label>重置理由<textarea aria-label="重置理由" value={reason} required maxLength={1000} onChange={(event) => setReason(event.target.value)} /></label>
        </fieldset>
        <Button type="submit" disabled={commandsLocked || items.length === 0}>{phase === "unknown" ? "安全重试原密码重置" : phase === "submitting" ? "正在提交…" : "确认重置密码"}</Button>
      </form>
    </>}
  </section>;
}
