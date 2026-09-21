import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ApiClientError,
  formatCentsAsBeans,
  type WithdrawalDetail,
  type WithdrawalMarkTransferredSubmission,
  type WithdrawalRevokeSubmission,
  type WithdrawalSummary
} from "@teaching-research-alliance/client";
import { Button } from "./components/ui/button.js";
import { Card } from "./components/ui/card.js";
import { AttachmentDownload, AttachmentPicker, financeError, isFinanceAuthError, type FinancePanelProps } from "./finance-shared.js";

type Command = { kind: "complete"; submission: WithdrawalMarkTransferredSubmission }
  | { kind: "revoke"; submission: WithdrawalRevokeSubmission };
type Receipt = { versionId: string; filename: string };
const statusLabel = (status: WithdrawalSummary["status"]): string => ({
  PENDING_TRANSFER: "待转账", TRANSFERRED: "已转账", FINANCE_REVOKED: "已撤回"
})[status];
const sourceLabel = (item: WithdrawalSummary): string => item.sourceType === "PERSON" ? "个人账户" : `场地账户 · ${item.venueName ?? item.venueId ?? "场地"}`;
const dateLabel = (value: string): string => new Date(value).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });

/** Only mounted for the GLOBAL headquarters finance context by the parent. */
export function FinanceWithdrawalPanel({ client, busy, active, run, onUnconfirmedChange, onDataMayChange }: FinancePanelProps): ReactNode {
  const started = useRef(false);
  const [pendingRows, setPendingRows] = useState<readonly WithdrawalSummary[]>([]);
  const [historyRows, setHistoryRows] = useState<readonly WithdrawalSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<"pending" | "history">("pending");
  const [detail, setDetail] = useState<WithdrawalDetail | null>(null);
  const [receipts, setReceipts] = useState<readonly Receipt[]>([]);
  const [receiptIds, setReceiptIds] = useState<readonly string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState("");
  const [success, setSuccess] = useState("");
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [command, setCommand] = useState<Command | null>(null);
  const commandRef = useRef<Command | null>(null);
  const uploadPendingRef = useRef(false);
  const [uploadPending, setUploadPending] = useState(false);
  const [pickerEpoch, setPickerEpoch] = useState(0);

  const keepCommand = (next: Command | null): void => {
    commandRef.current = next;
    setCommand(next);
    onUnconfirmedChange(next !== null || uploadPendingRef.current);
  };
  const keepUploadPending = (pending: boolean): void => {
    uploadPendingRef.current = pending;
    setUploadPending(pending);
    onUnconfirmedChange(pending || commandRef.current !== null);
  };
  const unconfirmed = command !== null || uploadPending;
  const locked = busy || unconfirmed;

  useEffect(() => {
    if (!unconfirmed) return;
    const warn = (event: BeforeUnloadEvent): void => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unconfirmed]);

  const readLists = async (): Promise<void> => {
    const [pending, managed] = await Promise.all([client.listPendingTransferWithdrawals(), client.listManagedWithdrawals()]);
    setPendingRows(pending);
    setHistoryRows(managed.filter((item) => item.status !== "PENDING_TRANSFER"));
    setLoaded(true);
  };
  const readDetail = async (id: string): Promise<void> => {
    const [next, metadata] = await Promise.all([client.getWithdrawalDetail(id), client.listFinanceDocumentAttachments(id)]);
    setDetail(next);
    setReceipts(metadata.attachments.filter((slot) => slot.purpose === "PAYMENT_RECEIPT").flatMap((slot) => {
      const latest = [...slot.versions].sort((a, b) => b.versionNo - a.versionNo)[0];
      return latest?.status === "READY" && latest.binding === undefined ? [{ versionId: latest.versionId, filename: latest.originalFilename }] : [];
    }));
    setReceiptIds([]);
    setConfirmed(false);
    setReason("");
    setPickerEpoch((value) => value + 1);
    setRefreshRequired(false);
  };
  const refresh = async (): Promise<void> => {
    setNotice("");
    // While a refresh is incomplete, the previously displayed version cannot be acted upon.
    if (detail !== null) setRefreshRequired(true);
    try {
      await readLists();
      if (detail !== null) await readDetail(detail.id);
    } catch (error) {
      setNotice(`刷新失败，当前显示可能不是最新状态。${financeError(error)}`);
      if (isFinanceAuthError(error)) throw error;
    }
  };
  useEffect(() => {
    if (!active || busy || started.current) return;
    started.current = true;
    void run(refresh);
  }, [active, busy]);

  const openDetail = async (id: string): Promise<void> => {
    if (commandRef.current !== null || uploadPendingRef.current) return;
    setDetail(null);
    setNotice("");
    setSuccess("");
    try { await readDetail(id); }
    catch (error) {
      setNotice(`无法读取申请详情。${financeError(error)}`);
      if (isFinanceAuthError(error)) throw error;
    }
  };

  const execute = async (frozen: Command): Promise<void> => {
    keepCommand(frozen);
    setNotice("");
    setSuccess("");
    let result;
    try {
      result = frozen.kind === "complete"
        ? await client.markWithdrawalTransferred(frozen.submission)
        : await client.revokeWithdrawal(frozen.submission);
    } catch (error) {
      if (error instanceof ApiClientError && error.status >= 400 && error.status < 500) {
        keepCommand(null);
        setConfirmed(false);
        setRefreshRequired(true);
        setNotice(`${financeError(error)} 请重新读取详情并核对后再操作。`);
        if (isFinanceAuthError(error)) throw error;
        if (error.status === 409) {
          try {
            await readDetail(frozen.submission.draft.documentId);
            await readLists();
            setNotice("单据状态或版本已变化，已重新读取。请核对当前详情；原操作未自动改写或重发。");
          } catch (refreshError) {
            setRefreshRequired(true);
            setNotice(`单据状态已变化，但重新读取失败。请刷新并重新核对。${financeError(refreshError)}`);
            if (isFinanceAuthError(refreshError)) throw refreshError;
          }
        }
        return;
      }
      setNotice("本次操作结果尚未确认。请保留此页并重试原操作；不要重复线下转账，也不要改为另一种操作。");
      if (isFinanceAuthError(error)) throw error;
      return;
    }
    keepCommand(null);
    onDataMayChange();
    // The command response is authoritative; never leave actionable pre-command detail behind.
    setDetail(null);
    setReceipts([]);
    setReceiptIds([]);
    setConfirmed(false);
    setReason("");
    setPendingRows((rows) => rows.filter((item) => item.id !== result.id));
    setSuccess(result.status === "TRANSFERRED"
      ? "已记录为已转账。本次仅登记线下转账结果，没有再次扣豆或发起银行支付。"
      : result.status === "FINANCE_REVOKED"
        ? "申请已撤回，已扣欢乐豆已返还至原来源账户。"
        : `操作已确认，当前状态：${statusLabel(result.status)}。`);
    try { await readLists(); }
    catch (error) {
      setNotice(`操作已成功，但列表刷新失败；其余列表可能不是最新状态，请刷新。${financeError(error)}`);
      if (isFinanceAuthError(error)) throw error;
    }
  };
  const createCommand = async (kind: Command["kind"]): Promise<void> => {
    if (detail === null || detail.status !== "PENDING_TRANSFER" || refreshRequired || commandRef.current !== null || uploadPendingRef.current) return;
    if (kind === "complete" && (!confirmed || receiptIds.length === 0)) {
      setNotice("请选择完整付款回执，并勾选已在线下核实转账。");
      return;
    }
    if (kind === "revoke" && reason.trim() === "") { setNotice("请填写撤回原因。"); return; }
    let frozen: Command;
    try {
      frozen = kind === "complete"
        ? { kind, submission: client.createWithdrawalMarkTransferredSubmission({ documentId: detail.id, expectedVersion: detail.version, attachmentVersionIds: receiptIds }) }
        : { kind, submission: client.createWithdrawalRevokeSubmission({ documentId: detail.id, expectedVersion: detail.version, reason: reason.trim() }) };
    } catch (error) { setNotice(financeError(error)); return; }
    await execute(frozen);
  };
  const rows = tab === "pending" ? pendingRows : historyRows;
  const detailLocked = locked || refreshRequired;

  return <section className="finance-panel" aria-label="提现办理" hidden={!active}>
    <div className="finance-header"><div><h2>提现办理</h2><p>申请已自动通过并扣豆。请核对资料后在线下转账，再登记付款回执。</p></div>
      <Button variant="outline" disabled={locked} onClick={() => void run(refresh)}>刷新提现列表</Button>
    </div>
    {success && <p className="finance-success" role="status">{success}</p>}
    {notice && <p className="finance-notice" role="alert">{notice}</p>}
    {command !== null && <Card className="finance-warning"><p>结果待确认：{command.kind === "complete" ? "登记已转账" : "撤回提现"}。原请求已保留。</p>
      <Button disabled={busy} onClick={() => void run(() => execute(command))}>重试原{command.kind === "complete" ? "转账确认" : "撤回"}操作</Button>
    </Card>}
    <div className="finance-tabs" aria-label="提现列表筛选">
      <Button variant={tab === "pending" ? "default" : "outline"} disabled={locked} onClick={() => setTab("pending")}>待转账（{pendingRows.length}）</Button>
      <Button variant={tab === "history" ? "default" : "outline"} disabled={locked} onClick={() => setTab("history")}>办理历史（{historyRows.length}）</Button>
    </div>
    {!loaded ? <p>尚未读取提现列表。</p> : rows.length === 0 ? <p className="finance-empty">{tab === "pending" ? "暂无待转账申请。" : "暂无已转账或撤回记录。"}</p> : <div className="finance-list">
      {rows.map((item) => <Card className="finance-list-item" key={item.id}>
        <div><strong>{item.applicantName}</strong> <span className="finance-status">{statusLabel(item.status)}</span></div>
        <p><strong>{formatCentsAsBeans(item.amountCents)} 欢乐豆</strong> · {sourceLabel(item)}</p>
        <p>银行卡尾号 {item.bankAccountLast4} · 申请于 {dateLabel(item.submittedAt)}</p>
        <Button variant="outline" disabled={locked} onClick={() => void run(() => openDetail(item.id))}>查看{item.applicantName}的提现详情</Button>
      </Card>)}
    </div>}
    {detail !== null && <Card className="finance-detail">
      <div className="finance-header"><h3>提现详情 · {detail.applicantName}</h3><Button variant="ghost" disabled={locked} onClick={() => { setDetail(null); setConfirmed(false); setReceiptIds([]); }}>关闭详情</Button></div>
      <p className="finance-status">{statusLabel(detail.status)}{refreshRequired ? " · 待刷新核对" : ""}</p>
      <dl className="finance-details">
        <dt>申请金额</dt><dd>{formatCentsAsBeans(detail.amountCents)} 欢乐豆（对应 {formatCentsAsBeans(detail.amountCents)} 元）</dd>
        <dt>来源账户</dt><dd>{sourceLabel(detail)}</dd>
        <dt>收款姓名</dt><dd>{detail.recipient.recipientName}</dd>
        <dt>银行卡账户</dt><dd className="finance-account">{detail.recipient.bankAccount}</dd>
        <dt>开户行</dt><dd>{detail.recipient.bankName ?? "未填写"}</dd>
        <dt>申请时间</dt><dd>{dateLabel(detail.submittedAt)}</dd>
      </dl>
      <h4>申请原件</h4>
      <div className="finance-attachments">{detail.attachments.filter((file) => file.stage === "SUBMISSION").map((file) => <div key={file.versionId}>
        <span>{file.purpose === "APPLICATION_SCREENSHOT" ? "申请截图" : "业务单据"} · {file.originalFilename}</span>
        <AttachmentDownload client={client} versionId={file.versionId} filename={file.originalFilename} disabled={busy} run={run} />
      </div>)}</div>
      {detail.attachments.some((file) => file.stage === "COMPLETION") && <><h4>已登记付款回执</h4><div className="finance-attachments">
        {detail.attachments.filter((file) => file.stage === "COMPLETION").map((file) => <div key={file.versionId}><span>{file.originalFilename}</span><AttachmentDownload client={client} versionId={file.versionId} filename={file.originalFilename} disabled={busy} run={run} /></div>)}
      </div></>}
      {detail.status === "PENDING_TRANSFER" && <>
        <div className="finance-action-section"><h4>登记线下转账</h4><p>先核对收款资料并在线下完成转账，再上传付款回执。点击下方按钮只记录转账结果。</p>
          <AttachmentPicker key={`${detail.id}:${pickerEpoch}`} client={client} documentId={detail.id} purpose="PAYMENT_RECEIPT" label="上传付款回执" disabled={busy || command !== null || refreshRequired} run={run}
            onPendingChange={keepUploadPending} onReady={(versionId) => {
              setReceipts((current) => current.some((file) => file.versionId === versionId) ? current : [...current, { versionId, filename: "本次上传的付款回执" }]);
              setReceiptIds((current) => [...new Set([...current, versionId])]);
              setConfirmed(false);
            }} />
          {receipts.length > 0 && <fieldset disabled={detailLocked}><legend>选择本次转账的付款回执</legend>{receipts.map((file) => <div className="finance-receipt-choice" key={file.versionId}>
            <label><input type="checkbox" checked={receiptIds.includes(file.versionId)} onChange={(event) => { setReceiptIds((ids) => event.target.checked ? [...ids, file.versionId] : ids.filter((id) => id !== file.versionId)); setConfirmed(false); }} />{file.filename}</label>
            <AttachmentDownload client={client} versionId={file.versionId} filename={file.filename} disabled={busy} run={run} />
          </div>)}</fieldset>}
          <label className="finance-confirm"><input type="checkbox" disabled={detailLocked || receiptIds.length === 0} checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我已在线下核实，已向以上收款账户转账 {formatCentsAsBeans(detail.amountCents)} 元，所选回执与本次转账一致。</label>
          <Button disabled={detailLocked || !confirmed || receiptIds.length === 0} onClick={() => void run(() => createCommand("complete"))}>登记为已转账</Button>
        </div>
        <div className="finance-action-section"><h4>财务撤回</h4><p>仅在尚未转账时撤回。欢乐豆将全额返还原来源账户；场地提现返还原场地账户。</p>
          <label>撤回原因<textarea value={reason} disabled={detailLocked} onChange={(event) => setReason(event.target.value)} placeholder="填写资料有误等实际撤回原因" /></label>
          <Button variant="destructive" disabled={detailLocked || reason.trim() === ""} onClick={() => void run(() => createCommand("revoke"))}>撤回申请并返还欢乐豆</Button>
        </div>
      </>}
      {detail.status === "TRANSFERRED" && <p>此申请已转账，申请资料及记录不可修改；差错需另行通过人工调账处理。</p>}
      {detail.status === "FINANCE_REVOKED" && <p>此申请已撤回，欢乐豆已返还原来源账户，历史资料保留。</p>}
    </Card>}
  </section>;
}
