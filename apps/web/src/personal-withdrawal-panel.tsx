import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ApiClientError,
  formatCentsAsBeans,
  parseBeanAmountToCents,
  type FinanceDraftMetadata,
  type FinanceDraftSubmission,
  type FinanceDocumentAttachment,
  type WithdrawalDetail,
  type WithdrawalSource,
  type WithdrawalSubmitSubmission,
  type WithdrawalSummary
} from "@teaching-research-alliance/client";
import { Button } from "./components/ui/button.js";
import { Card } from "./components/ui/card.js";
import { AttachmentDownload, AttachmentPicker, financeError, isFinanceAuthError, type FinancePanelProps } from "./finance-shared.js";

const statusLabels = {
  PENDING_TRANSFER: "已通过 · 待转账",
  TRANSFERRED: "已转账",
  FINANCE_REVOKED: "财务已撤回 · 已退回原账户"
} as const;
const purposes = [
  { purpose: "SUPPORTING_DOCUMENT", label: "业务单据" },
  { purpose: "APPLICATION_SCREENSHOT", label: "申请截图" }
] as const;
type Purpose = (typeof purposes)[number]["purpose"];
const unknownResult = (error: unknown): boolean => !(error instanceof ApiClientError) || error.status >= 500;
const timeLabel = (value: string): string => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });

/** Drafts contain metadata and uploaded originals only; banking form text stays in this mounted session. */
export function PersonalWithdrawalPanel({ client, busy, active, run, onUnconfirmedChange, onDataMayChange }: FinancePanelProps): ReactNode {
  const started = useRef(false);
  const uploadPending = useRef(new Set<Purpose>());
  const [uploadPendingCount, setUploadPendingCount] = useState(0);
  const [sources, setSources] = useState<readonly WithdrawalSource[]>([]);
  const [drafts, setDrafts] = useState<readonly FinanceDraftMetadata[]>([]);
  const [withdrawals, setWithdrawals] = useState<readonly WithdrawalSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [draft, setDraft] = useState<FinanceDraftMetadata | null>(null);
  const [attachments, setAttachments] = useState<readonly FinanceDocumentAttachment[]>([]);
  const [selectedAttachments, setSelectedAttachments] = useState<Partial<Record<Purpose, string>>>({});
  const [sourceId, setSourceId] = useState("");
  const [amount, setAmount] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [bankAccount, setBankAccount] = useState("");
  const [bankName, setBankName] = useState("");
  const [pendingCreate, setPendingCreate] = useState<FinanceDraftSubmission | null>(null);
  const [pendingSubmit, setPendingSubmit] = useState<WithdrawalSubmitSubmission | null>(null);
  const [detail, setDetail] = useState<WithdrawalDetail | null>(null);
  const [notice, setNotice] = useState("");
  const [receipt, setReceipt] = useState("");
  const pending = pendingCreate !== null || pendingSubmit !== null || uploadPendingCount > 0;
  const source = sources.find((item) => item.accountId === sourceId);
  const locked = busy || pendingSubmit !== null;

  useEffect(() => { onUnconfirmedChange(pending); }, [pending, onUnconfirmedChange]);
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent): void => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);

  const load = async (): Promise<void> => {
    setFresh(false);
    const [nextSources, nextDrafts, nextWithdrawals] = await Promise.all([
      client.listWithdrawalSources(), client.listOwnFinanceDrafts(), client.listOwnWithdrawals()
    ]);
    setSources(nextSources);
    setDrafts(nextDrafts.filter((item) => item.kind === "WITHDRAWAL"));
    setWithdrawals(nextWithdrawals);
    setLoaded(true);
    setFresh(true);
  };

  const refresh = async (): Promise<void> => {
    setNotice("");
    setDetail(null);
    try { await load(); }
    catch (error) {
      setNotice(`列表未能刷新：${financeError(error)}`);
      if (isFinanceAuthError(error)) throw error;
    }
  };

  useEffect(() => {
    if (!active || busy || started.current) return;
    started.current = true;
    void run(refresh);
  }, [active, busy]);

  const resetForm = (): void => {
    setSourceId(""); setAmount(""); setRecipientName(""); setBankAccount(""); setBankName("");
    setSelectedAttachments({}); setAttachments([]);
    uploadPending.current.clear(); setUploadPendingCount(0);
  };

  const openDraft = async (documentId: string): Promise<void> => {
    setNotice(""); setReceipt(""); setDraft(null); resetForm();
    try {
      const [metadata, recovered] = await Promise.all([
        client.getOwnFinanceDraft(documentId), client.listFinanceDocumentAttachments(documentId)
      ]);
      setDraft(metadata);
      setAttachments(recovered.attachments);
    } catch (error) {
      setNotice(`草稿未能打开：${financeError(error)} 请刷新申请记录后核对。`);
      if (isFinanceAuthError(error)) throw error;
    }
  };

  const createDraft = async (): Promise<void> => {
    setNotice(""); setReceipt("");
    const submission = pendingCreate ?? client.createFinanceDraftSubmission({ kind: "WITHDRAWAL" });
    setPendingCreate(submission);
    try {
      const created = await client.createFinanceDraft(submission);
      setPendingCreate(null);
      resetForm(); setDraft(created);
      setDrafts((items) => [created, ...items.filter((item) => item.id !== created.id)]);
      setReceipt("提现草稿已创建。填写收款资料并上传两类原件后，再确认提交。");
    } catch (error) {
      if (!unknownResult(error)) setPendingCreate(null);
      setNotice(unknownResult(error) ? "尚不能确认草稿是否创建，请安全重试创建，避免重复新建。" : financeError(error));
      if (isFinanceAuthError(error)) throw error;
    }
  };

  const send = async (submission: WithdrawalSubmitSubmission): Promise<void> => {
    setNotice(""); setReceipt(""); setPendingSubmit(submission);
    setFresh(false);
    onDataMayChange();
    let result;
    try {
      result = await client.submitWithdrawal(submission);
    } catch (error) {
      if (unknownResult(error)) {
        setNotice("尚不能确认提交结果，可能已经扣豆。填写内容已锁定，请安全重试原申请，不要重复新建。");
      } else {
        setPendingSubmit(null);
        if (error instanceof ApiClientError && error.status === 409 && !error.code.includes("INSUFFICIENT")) {
          setDraft(null); resetForm(); setFresh(false);
          setNotice("申请状态或版本已变化，旧输入已清空。请刷新记录；如仍为草稿，请重新打开、填写并确认提交。");
        } else {
          setNotice(financeError(error));
          setFresh(false);
        }
      }
      if (isFinanceAuthError(error)) throw error;
      return;
    }
    setPendingSubmit(null); setDraft(null); resetForm(); setDetail(null);
    setDrafts((items) => items.filter((item) => item.id !== result.id));
    setReceipt(result.status === "PENDING_TRANSFER"
      ? "提现申请已通过，已从所选账户扣除欢乐豆，待财务线下转账；银行卡尚未确认到账。"
      : `申请状态已确认：${statusLabels[result.status]}。`);
    try { await load(); }
    catch (error) {
      setNotice("提交结果已确认，但余额和记录刷新失败。请刷新列表，勿重复提交。");
      if (isFinanceAuthError(error)) throw error;
    }
  };

  const submit = async (): Promise<void> => {
    setNotice("");
    if (pendingSubmit !== null) { await send(pendingSubmit); return; }
    if (draft === null || source === undefined || !fresh) { setNotice("请刷新可提现账户并明确选择本次支出来源。"); return; }
    let amountCents: string;
    try { amountCents = parseBeanAmountToCents(amount); }
    catch { setNotice("请输入正数欢乐豆金额，最多保留两位小数。"); return; }
    if (BigInt(amountCents) <= 0n) { setNotice("提现金额必须大于0。"); return; }
    if (BigInt(amountCents) > BigInt(source.balanceCents)) { setNotice("超出所选账户的可用金额。"); return; }
    const supporting = selectedAttachments.SUPPORTING_DOCUMENT;
    const screenshot = selectedAttachments.APPLICATION_SCREENSHOT;
    if (!supporting || !screenshot || uploadPendingCount > 0) { setNotice("请等待业务单据和申请截图均上传完成，并选择用于提交的原件。"); return; }
    let submission: WithdrawalSubmitSubmission;
    try {
      submission = client.createWithdrawalSubmitSubmission({
        documentId: draft.id, expectedVersion: draft.version, sourceAccountId: source.accountId,
        amountCents, recipientName, bankAccount, ...(bankName.trim() ? { bankName } : {}),
        attachmentVersionIds: [supporting, screenshot]
      });
    } catch (error) { setNotice(financeError(error)); return; }
    await send(submission);
  };

  const readDetail = async (documentId: string): Promise<void> => {
    setNotice(""); setDetail(null);
    try { setDetail(await client.getWithdrawalDetail(documentId)); }
    catch (error) {
      setNotice(`详情未能读取：${financeError(error)}`);
      if (isFinanceAuthError(error)) throw error;
    }
  };

  return <section className="finance-panel" aria-label="我的提现" hidden={!active}>
    <div className="section-heading"><div><p className="eyebrow">我的账户</p><h2>提现申请</h2><p>足额提交即扣豆并通过，银行转账由财务线下办理。</p></div>
      <Button variant="outline" disabled={busy} onClick={() => void run(refresh)}>刷新提现记录</Button></div>
    {receipt && <p className="finance-success" role="status">{receipt}</p>}
    {notice && <p className="finance-notice" role="alert">{notice}</p>}
    {!loaded && <p>{busy ? "正在读取提现账户和申请…" : "暂未读取到数据，请点击刷新。"}</p>}
    <div className="finance-source-grid">{sources.map((item) => <Card className="finance-source-card" key={item.accountId}>
      <span>{item.sourceType === "PERSON" ? "个人账户" : "场地账户"}</span><h3>{item.label}</h3>
      <strong>{fresh ? `${formatCentsAsBeans(item.balanceCents)} 欢乐豆` : "余额待刷新"}</strong>
    </Card>)}</div>
    {loaded && sources.length === 0 && <p className="finance-empty">当前没有可提现账户；场地账户需具备明确提现权限。</p>}
    <Card className="finance-card">
      <div className="section-heading"><div><h3>申请草稿</h3><p>草稿尚未扣豆；收款资料只在本次填写中保留，重新打开需再次填写。</p></div>
        <Button disabled={busy || (pending && pendingCreate === null) || !loaded} onClick={() => void run(createDraft)}>{pendingCreate ? "安全重试创建草稿" : "新建提现申请"}</Button></div>
      {drafts.length === 0 && <p className="finance-empty">暂无提现草稿。</p>}
      <div className="finance-list">{drafts.map((item) => <div className="finance-list-row" key={item.id}>
        <div><strong>提现草稿</strong><p>{timeLabel(item.createdAt)} · {item.id}</p></div>
        <Button variant="outline" disabled={busy || pending || draft?.id === item.id} onClick={() => void run(() => openDraft(item.id))}>{draft?.id === item.id ? "正在填写" : "继续填写"}</Button>
      </div>)}</div>
    </Card>
    {draft !== null && <Card className="finance-card"><h3>填写提现申请</h3>
      <form autoComplete="off" onSubmit={(event) => { event.preventDefault(); void run(submit); }}>
        <fieldset className="finance-form-grid" disabled={locked}>
          <label>支出来源<select aria-label="支出来源" value={sourceId} required onChange={(event) => setSourceId(event.target.value)}>
            <option value="">请选择个人或具体场地账户</option>
            {sources.map((item) => <option value={item.accountId} key={item.accountId}>{item.sourceType === "PERSON" ? "个人" : "场地"} · {item.label}{fresh ? ` · 可用 ${formatCentsAsBeans(item.balanceCents)} 豆` : " · 余额待刷新"}</option>)}
          </select></label>
          <label>提现金额（欢乐豆）<input inputMode="decimal" value={amount} required maxLength={22} onChange={(event) => setAmount(event.target.value)} placeholder="最多两位小数" /></label>
          <label>收款姓名<input value={recipientName} required maxLength={200} onChange={(event) => setRecipientName(event.target.value)} /></label>
          <label>银行卡账户<input inputMode="numeric" value={bankAccount} required maxLength={256} autoComplete="off" onChange={(event) => setBankAccount(event.target.value)} /></label>
          <label>开户行（选填）<input value={bankName} maxLength={200} onChange={(event) => setBankName(event.target.value)} /></label>
        </fieldset>
        <p className="finance-muted">仅使用所选账户余额，不合并个人与场地余额。提交时将再次核验权限和可用金额。</p>
        <div className="finance-attachments">{purposes.map(({ purpose, label }) => <div className="finance-attachment-slot" key={`${draft.id}:${purpose}`}>
          <AttachmentPicker client={client} documentId={draft.id} purpose={purpose} label={label} disabled={locked} run={run}
            onReady={(versionId) => setSelectedAttachments((items) => items[purpose] === versionId ? items : ({ ...items, [purpose]: versionId }))}
            onPendingChange={(value) => { if (value) uploadPending.current.add(purpose); else uploadPending.current.delete(purpose); setUploadPendingCount(uploadPending.current.size); }} />
          {attachments.filter((item) => item.purpose === purpose).flatMap((item) => item.versions.filter((version) => version.status === "READY").map((version) => <div className="finance-attachment-row" key={version.versionId}>
            <label><input type="radio" name={`attachment-${purpose}`} checked={selectedAttachments[purpose] === version.versionId} disabled={locked} onChange={() => setSelectedAttachments((items) => ({ ...items, [purpose]: version.versionId }))} />选用 {version.originalFilename} · 第{version.versionNo}版</label>
            <AttachmentDownload client={client} versionId={version.versionId} filename={version.originalFilename} disabled={busy} run={run} />
          </div>))}
          <p className="finance-muted">{selectedAttachments[purpose] ? `${label}已就绪并选用` : `请上传或选用一份已就绪的${label}`}</p>
        </div>)}</div>
        <Button type="submit" disabled={busy || uploadPendingCount > 0 || (pendingSubmit === null && (!fresh || !selectedAttachments.SUPPORTING_DOCUMENT || !selectedAttachments.APPLICATION_SCREENSHOT))}>
          {pendingSubmit !== null ? "安全重试原提现申请" : "确认提交并扣豆"}
        </Button>
      </form>
    </Card>}
    <Card className="finance-card"><h3>我的提现记录</h3>
      {loaded && withdrawals.length === 0 && <p className="finance-empty">暂无已提交的提现申请。</p>}
      <div className="finance-list">{withdrawals.map((item) => <div className="finance-list-row" key={item.id}>
        <div><strong>{formatCentsAsBeans(item.amountCents)} 欢乐豆</strong><p>{item.sourceType === "PERSON" ? "个人账户" : `场地 · ${item.venueName ?? item.venueId}`} · 银行卡尾号 {item.bankAccountLast4}</p><p>{timeLabel(item.submittedAt)} · {statusLabels[item.status]}</p></div>
        <Button variant="outline" disabled={busy} onClick={() => void run(() => readDetail(item.id))}>查看收款及凭证</Button>
      </div>)}</div>
    </Card>
    {detail !== null && <Card className="finance-card"><div className="section-heading"><h3>提现详情</h3><Button variant="outline" onClick={() => setDetail(null)}>收起详情</Button></div>
      <p>{statusLabels[detail.status]} · {formatCentsAsBeans(detail.amountCents)} 欢乐豆</p>
      <dl className="finance-detail"><dt>收款人</dt><dd>{detail.recipient.recipientName}</dd><dt>银行卡账户</dt><dd>{detail.recipient.bankAccount}</dd><dt>开户行</dt><dd>{detail.recipient.bankName ?? "未填写"}</dd></dl>
      {detail.attachments.map((item) => <div className="finance-attachment-row" key={item.versionId}><span>{item.purpose === "PAYMENT_RECEIPT" ? "转账回执" : item.purpose === "APPLICATION_SCREENSHOT" ? "申请截图" : "业务单据"} · {item.originalFilename}</span><AttachmentDownload client={client} versionId={item.versionId} filename={item.originalFilename} disabled={busy} run={run} /></div>)}
    </Card>}
  </section>;
}
