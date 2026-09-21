import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ApiClientError,
  type CompanyFundAssignmentSubmission,
  type CompanyFundCreateSubmission,
  type CompanyFundList,
  type CompanyFundStatusSubmission
} from "@teaching-research-alliance/client";
import { Button } from "./components/ui/button.js";
import { Card } from "./components/ui/card.js";
import { financeError, isFinanceAuthError, type FinancePanelProps } from "./finance-shared.js";

type Command =
  | { kind: "create"; label: string; submission: CompanyFundCreateSubmission }
  | { kind: "assign"; label: string; submission: CompanyFundAssignmentSubmission }
  | { kind: "status"; label: string; submission: CompanyFundStatusSubmission };

function configError(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.code === "COMPANY_FUND_INACTIVE") return "所选账户已停用，请选择正常使用的账户。";
    if (error.code === "COMPANY_FUND_CONFLICT") return "账户编码或状态与现有记录冲突，请核对最新账户列表。";
    if (error.status === 400) return "请检查账户编码、名称及操作原因。";
  }
  return financeError(error);
}

/** Parent renders this panel only for a strictly GLOBAL administrator or system owner. */
export function CompanyFundPanel({ client, busy, active, run, onUnconfirmedChange, onDataMayChange }: FinancePanelProps): ReactNode {
  const started = useRef(false);
  const pendingRef = useRef<Command | null>(null);
  const [pending, setPending] = useState<Command | null>(null);
  const [snapshot, setSnapshot] = useState<CompanyFundList | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(true);
  const [notice, setNotice] = useState("");
  const [success, setSuccess] = useState("");
  const [fundCode, setFundCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [assignmentFundId, setAssignmentFundId] = useState("");
  const [assignmentReason, setAssignmentReason] = useState("");
  const [assignmentConfirmed, setAssignmentConfirmed] = useState(false);
  const [statusFundId, setStatusFundId] = useState("");
  const [statusReason, setStatusReason] = useState("");
  const [statusConfirmed, setStatusConfirmed] = useState(false);
  const funds = snapshot?.funds ?? [];
  const assignedFund = funds.find((fund) => fund.id === snapshot?.currentAssignment?.fundId);
  const assignmentFund = funds.find((fund) => fund.id === assignmentFundId);
  const statusFund = funds.find((fund) => fund.id === statusFundId);
  const locked = busy || pending !== null;
  const formLocked = locked || refreshRequired || snapshot === null;

  const preserve = (command: Command | null): void => {
    pendingRef.current = command;
    setPending(command);
    onUnconfirmedChange(command !== null);
  };
  useEffect(() => {
    if (pending === null) return;
    const warn = (event: BeforeUnloadEvent): void => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);

  const read = async (): Promise<void> => {
    setRefreshRequired(true);
    setAssignmentConfirmed(false);
    setStatusConfirmed(false);
    const result = await client.listCompanyFunds();
    setSnapshot(result);
    setRefreshRequired(false);
    // An explicit new selection prevents a refresh from silently retargeting a pending configuration.
    setAssignmentFundId("");
    setStatusFundId("");
  };
  const refresh = async (): Promise<void> => {
    if (pendingRef.current !== null) return;
    setNotice("");
    try { await read(); }
    catch (error) {
      setNotice(`读取失败，配置操作暂不可用。${configError(error)}`);
      if (isFinanceAuthError(error)) throw error;
    }
  };
  useEffect(() => {
    if (!active || busy || started.current) return;
    started.current = true;
    void run(refresh);
  }, [active, busy]);

  const execute = async (command: Command): Promise<void> => {
    preserve(command);
    setNotice("");
    setSuccess("");
    try {
      if (command.kind === "create") await client.createCompanyFund(command.submission);
      else if (command.kind === "assign") await client.assignCompanyFund(command.submission);
      else await client.setCompanyFundStatus(command.submission);
    } catch (error) {
      if (error instanceof ApiClientError && error.status >= 400 && error.status < 500) {
        preserve(null);
        setAssignmentConfirmed(false);
        setStatusConfirmed(false);
        if (isFinanceAuthError(error)) { setRefreshRequired(true); throw error; }
        if (error.status === 409) {
          setRefreshRequired(true);
          setNotice("账户或职责映射已变化。原操作未自动重发，请重新读取后选择并确认。");
          try {
            await read();
            setNotice("已读取最新账户和职责映射。请重新选择并确认；原请求没有自动改写或重发。");
          } catch (readError) {
            setNotice(`状态冲突后的刷新失败，暂不能继续配置。${configError(readError)}`);
            if (isFinanceAuthError(readError)) throw readError;
          }
        } else setNotice(configError(error));
        return;
      }
      setNotice("本次配置结果尚未确认，原请求已保留。请安全重试原操作，不要另建账户或重复调整映射。");
      if (isFinanceAuthError(error)) throw error;
      return;
    }
    preserve(null);
    onDataMayChange();
    setSnapshot(null);
    setRefreshRequired(true);
    setAssignmentConfirmed(false);
    setStatusConfirmed(false);
    if (command.kind === "create") { setFundCode(""); setDisplayName(""); }
    if (command.kind === "assign") setAssignmentReason("");
    if (command.kind === "status") setStatusReason("");
    setSuccess(command.kind === "create"
      ? `已创建业务账户「${command.submission.draft.displayName}」，开户余额为 0。配置操作未增加资金。`
      : command.kind === "assign"
        ? "总部财务职责支出来源已更新。历史单据和原账户资金归属保持不变。"
        : command.submission.draft.status === "ACTIVE"
          ? "业务账户已启用，账户余额和历史记录保留。"
          : "业务账户已停用，余额和历史记录保留；停用不会退回已有业务款项。");
    try { await read(); }
    catch (error) {
      setNotice(`配置已成功，但账户列表刷新失败。请刷新读取当前状态后继续。${configError(error)}`);
      if (isFinanceAuthError(error)) throw error;
    }
  };

  const submit = async (kind: Command["kind"]): Promise<void> => {
    if (pendingRef.current !== null || refreshRequired || snapshot === null) return;
    let command: Command;
    try {
      if (kind === "create") {
        if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(fundCode.trim()) || !displayName.trim()) {
          setNotice("账户编码须以大写字母开头，仅含大写字母、数字或下划线，最多 64 字符；请填写账户名称。"); return;
        }
        command = { kind, label: `创建 ${displayName.trim()}`, submission: client.createCompanyFundSubmission({ fundCode: fundCode.trim(), displayName: displayName.trim() }) };
      } else if (kind === "assign") {
        if (!assignmentFund || assignmentFund.status !== "ACTIVE" || !assignmentReason.trim() || !assignmentConfirmed) {
          setNotice("请选择启用中的账户，填写调整原因，并确认新的职责支出来源。"); return;
        }
        command = { kind, label: `将总部财务职责支出来源设置为 ${assignmentFund.displayName}`, submission: client.createCompanyFundAssignmentSubmission({ fundId: assignmentFund.id, expectedAssignmentId: snapshot.currentAssignment?.id ?? null, reason: assignmentReason.trim() }) };
      } else {
        if (!statusFund || !statusReason.trim() || !statusConfirmed) {
          setNotice("请选择账户，填写启停原因，并确认操作。"); return;
        }
        const status = statusFund.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
        command = { kind, label: `${status === "ACTIVE" ? "启用" : "停用"} ${statusFund.displayName}`, submission: client.createCompanyFundStatusSubmission({ fundId: statusFund.id, expectedVersion: statusFund.version, status, reason: statusReason.trim() }) };
      }
    } catch (error) {
      setNotice(configError(error));
      if (isFinanceAuthError(error)) throw error;
      return;
    }
    await execute(command);
  };

  return <section className="finance-panel" aria-label="公司资金账户配置" hidden={!active}>
    <div className="finance-header"><div><h2>公司资金账户</h2><p>配置独立业务账户及总部财务支出来源。配置不加款，也不转移历史资金。</p></div>
      <Button variant="outline" disabled={locked} onClick={() => void run(refresh)}>刷新公司资金账户</Button>
    </div>
    {success && <p className="finance-success" role="status">{success}</p>}
    {notice && <p className="finance-notice" role="alert">{notice}</p>}
    {pending && <Card className="finance-warning"><p>结果待确认：{pending.label}。已保留原操作内容。</p><Button disabled={busy} onClick={() => void run(() => execute(pending))}>安全重试原配置操作</Button></Card>}
    <Card className="finance-card"><h3>当前职责支出来源</h3>
      {snapshot === null ? <p>尚未读取当前职责映射。</p> : snapshot.currentAssignment === null ? <p>总部财务尚未配置支出来源。</p> : <>
        <p><strong>总部财务 → {assignedFund?.displayName ?? "当前映射账户暂不可见"}</strong></p>
        <p>{assignedFund ? `${assignedFund.fundCode} · ${assignedFund.status === "ACTIVE" ? "启用中" : "已停用"}` : "请刷新核对账户状态。"}</p>
        <p className="finance-muted">生效时间：{new Date(snapshot.currentAssignment.validFrom).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}</p>
        {assignedFund?.status === "INACTIVE" && <p className="finance-notice">当前支出账户已停用。请核对后启用，或将职责映射至其他启用中的账户。</p>}
      </>}
      {refreshRequired && snapshot !== null && <p className="finance-notice">显示内容待刷新核对，暂不能配置。</p>}
    </Card>
    <Card className="finance-card"><h3>公司资金账户列表</h3>
      {snapshot === null ? <p>尚未读取账户列表。</p> : funds.length === 0 ? <p className="finance-empty">暂无公司资金账户，可先创建账户。</p> : funds.map((fund) => <div className="finance-list-row" key={fund.id}>
        <div><strong>{fund.displayName}</strong><p>{fund.fundCode} · {fund.status === "ACTIVE" ? "启用中" : "已停用"}{snapshot.currentAssignment?.fundId === fund.id ? " · 当前总部财务支出来源" : ""}</p></div>
      </div>)}
      <p className="finance-muted">公司业务资金独立于任职人的个人账户；配置操作不增加或划转资金。</p>
    </Card>
    <Card className="finance-card"><h3>创建公司资金账户</h3><p>新账户开户余额为 0，资金增减由相应业务账务记录。</p>
      <fieldset className="finance-form-grid" disabled={formLocked}>
        <label>账户编码<input aria-label="账户编码" value={fundCode} maxLength={64} placeholder="例如 HQ_OPERATIONS" onChange={(event) => setFundCode(event.target.value)} /></label>
        <label>账户名称<input aria-label="账户名称" value={displayName} maxLength={200} placeholder="例如 总部运营资金" onChange={(event) => setDisplayName(event.target.value)} /></label>
      </fieldset>
      <p className="finance-muted">编码以大写字母开头，仅使用大写字母、数字或下划线，最多 64 字符。</p>
      <Button disabled={formLocked || !fundCode.trim() || !displayName.trim()} onClick={() => void run(() => submit("create"))}>创建公司资金账户</Button>
    </Card>
    <Card className="finance-card"><h3>设置总部财务支出来源</h3><p>更换职责映射不会转移旧账户余额，也不会改写历史单据。</p>
      <fieldset className="finance-form-grid" disabled={formLocked}>
        <label>总部财务支出账户<select aria-label="总部财务支出账户" value={assignmentFundId} onChange={(event) => { setAssignmentFundId(event.target.value); setAssignmentConfirmed(false); }}>
          <option value="">请选择启用中的账户</option>{funds.filter((fund) => fund.status === "ACTIVE").map((fund) => <option value={fund.id} key={fund.id}>{fund.displayName}（{fund.fundCode}）</option>)}
        </select></label>
        <label>职责映射调整原因<textarea aria-label="职责映射调整原因" value={assignmentReason} maxLength={1000} onChange={(event) => { setAssignmentReason(event.target.value); setAssignmentConfirmed(false); }} /></label>
      </fieldset>
      <label className="finance-confirm"><input type="checkbox" disabled={formLocked || !assignmentFund || !assignmentReason.trim()} checked={assignmentConfirmed} onChange={(event) => setAssignmentConfirmed(event.target.checked)} />我已核对，将总部财务支出来源设置为「{assignmentFund?.displayName ?? "待选择账户"}」。</label>
      <Button disabled={formLocked || !assignmentConfirmed || !assignmentFund || assignmentFund.id === snapshot?.currentAssignment?.fundId || !assignmentReason.trim()} onClick={() => void run(() => submit("assign"))}>保存职责支出来源</Button>
    </Card>
    <Card className="finance-card"><h3>启用或停用账户</h3><p>停用保留余额和历史，不代表退回已有款项。</p>
      <fieldset className="finance-form-grid" disabled={formLocked}>
        <label>启停账户<select aria-label="启停账户" value={statusFundId} onChange={(event) => { setStatusFundId(event.target.value); setStatusConfirmed(false); }}>
          <option value="">请选择账户</option>{funds.map((fund) => <option value={fund.id} key={fund.id}>{fund.displayName}（{fund.status === "ACTIVE" ? "启用中" : "已停用"}）</option>)}
        </select></label>
        <label>账户启停原因<textarea aria-label="账户启停原因" value={statusReason} maxLength={1000} onChange={(event) => { setStatusReason(event.target.value); setStatusConfirmed(false); }} /></label>
      </fieldset>
      {statusFund && snapshot?.currentAssignment?.fundId === statusFund.id && statusFund.status === "ACTIVE" && <p className="finance-notice">该账户是当前总部财务支出来源，停用后相关新业务支出将不可用。</p>}
      <label className="finance-confirm"><input type="checkbox" disabled={formLocked || !statusFund || !statusReason.trim()} checked={statusConfirmed} onChange={(event) => setStatusConfirmed(event.target.checked)} />我已核对，确认{statusFund?.status === "ACTIVE" ? "停用" : "启用"}「{statusFund?.displayName ?? "待选择账户"}」，保留余额和历史。</label>
      <Button variant={statusFund?.status === "ACTIVE" ? "destructive" : "default"} disabled={formLocked || !statusFund || !statusReason.trim() || !statusConfirmed} onClick={() => void run(() => submit("status"))}>{statusFund?.status === "ACTIVE" ? "停用账户" : "启用账户"}</Button>
    </Card>
  </section>;
}
