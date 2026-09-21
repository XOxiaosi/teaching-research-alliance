import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ApiClientError,
  formatCentsAsBeans,
  parseBeanAmountToCents,
  type FinanceDocumentAttachment,
  type FinanceDraftMetadata,
  type FinanceDraftSubmission,
  type SelfPurchaseDetail,
  type SelfPurchaseSubmission,
  type SelfPurchaseSummary
} from "@teaching-research-alliance/client";
import { Button } from "./components/ui/button.js";
import { Card } from "./components/ui/card.js";
import { AttachmentDownload, AttachmentPicker, financeError, isFinanceAuthError, type FinancePanelProps } from "./finance-shared.js";

type Props = FinancePanelProps & { mode: "personal" | "managed" };
const purposes = [
  { purpose: "SUPPORTING_DOCUMENT", label: "采买业务单据" },
  { purpose: "APPLICATION_SCREENSHOT", label: "采买申请截图" }
] as const;
type Purpose = (typeof purposes)[number]["purpose"];
const uncertain = (error: unknown): boolean => !(error instanceof ApiClientError) || error.status >= 500;
const timeLabel = (value: string): string => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
const statusLabel = (status: string): string => status === "COMPLETED" ? "已完成" : status === "REVERSED" ? "已撤销" : "状态待核对";
const purchaseError = (error: unknown): string => {
  if (error instanceof ApiClientError) {
    if (error.code === "HEADQUARTERS_FINANCE_ASSIGNMENT_REQUIRED") return "当前本人没有有效总部财务任职，不能使用本人采买自动划拨。请核对任职后重新选择身份。";
    if (error.code === "HEADQUARTERS_FINANCE_ASSIGNMENT_AMBIGUOUS") return "当前财务任职不明确，请联系管理员核对后再提交。";
    if (error.code === "COMPANY_FUND_ASSIGNMENT_NOT_FOUND") return "当前财务职责尚未关联可用业务账户，请联系管理员配置后再提交。";
  }
  return financeError(error);
};

/** The server resolves both accounts and verifies the real finance appointment at submission time. */
export function SelfPurchasePanel({ client, busy, active, run, onUnconfirmedChange, onDataMayChange, mode }: Props): ReactNode {
  const personal = mode === "personal";
  const started = useRef(false);
  const pendingUploads = useRef(new Set<Purpose>());
  const [uploadCount, setUploadCount] = useState(0);
  const [drafts, setDrafts] = useState<readonly FinanceDraftMetadata[]>([]);
  const [records, setRecords] = useState<readonly SelfPurchaseSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [draft, setDraft] = useState<FinanceDraftMetadata | null>(null);
  const [attachments, setAttachments] = useState<readonly FinanceDocumentAttachment[]>([]);
  const [chosen, setChosen] = useState<Partial<Record<Purpose, string>>>({});
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [pendingCreate, setPendingCreate] = useState<FinanceDraftSubmission | null>(null);
  const [pendingSubmit, setPendingSubmit] = useState<SelfPurchaseSubmission | null>(null);
  const [detail, setDetail] = useState<SelfPurchaseDetail | null>(null);
  const [notice, setNotice] = useState("");
  const [validation, setValidation] = useState<{ field: "amount" | "reason" | "attachments"; message: string } | null>(null);
  const [receipt, setReceipt] = useState("");
  const pending = pendingCreate !== null || pendingSubmit !== null || uploadCount > 0;
  const locked = busy || pendingCreate !== null || pendingSubmit !== null;

  useEffect(() => { onUnconfirmedChange(pending); }, [pending, onUnconfirmedChange]);
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent): void => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);

  const load = async (): Promise<void> => {
    setFresh(false);
    const [nextRecords, nextDrafts] = await Promise.all([
      personal ? client.listOwnSelfPurchases() : client.listManagedSelfPurchases(),
      personal ? client.listOwnFinanceDrafts() : Promise.resolve([] as readonly FinanceDraftMetadata[])
    ]);
    setRecords(nextRecords.documents);
    setDrafts(nextDrafts.filter((item) => item.kind === "SELF_PURCHASE"));
    setLoaded(true); setFresh(true);
  };

  const refresh = async (): Promise<void> => {
    setNotice(""); setDetail(null);
    try { await load(); }
    catch (error) {
      setNotice(`采买记录刷新失败：${purchaseError(error)}`);
      if (isFinanceAuthError(error)) throw error;
    }
  };

  useEffect(() => {
    if (!active || busy || started.current) return;
    started.current = true;
    void run(refresh);
  }, [active, busy]);

  const clearForm = (): void => {
    setValidation(null);
    setAmount(""); setReason(""); setAttachments([]); setChosen({});
    pendingUploads.current.clear(); setUploadCount(0);
  };

  const openDraft = async (documentId: string): Promise<void> => {
    if (!personal || pending) return;
    setNotice(""); setReceipt(""); setDraft(null); clearForm();
    try {
      const [metadata, recovered] = await Promise.all([
        client.getOwnFinanceDraft(documentId), client.listFinanceDocumentAttachments(documentId)
      ]);
      if (metadata.kind !== "SELF_PURCHASE" || metadata.status !== "DRAFT") {
        setNotice("这笔记录已不能作为采买草稿继续填写，请刷新采买记录核对。"); return;
      }
      setDraft(metadata); setAttachments(recovered.attachments);
    } catch (error) {
      setNotice(`采买草稿未能打开：${purchaseError(error)}`);
      if (isFinanceAuthError(error)) throw error;
    }
  };

  const createDraft = async (): Promise<void> => {
    if (!personal || pendingSubmit !== null || uploadCount > 0) return;
    setNotice(""); setReceipt("");
    const submission = pendingCreate ?? client.createFinanceDraftSubmission({ kind: "SELF_PURCHASE" });
    setPendingCreate(submission);
    try {
      const created = await client.createFinanceDraft(submission);
      setPendingCreate(null); clearForm(); setDraft(created);
      setDrafts((items) => [created, ...items.filter((item) => item.id !== created.id)]);
      setReceipt("采买草稿已创建，尚未划拨。请填写金额、原因，并上传业务单据与申请截图。");
    } catch (error) {
      if (!uncertain(error)) setPendingCreate(null);
      setNotice(uncertain(error) ? "尚不能确认采买草稿是否创建，请安全重试创建，避免重复新建。" : purchaseError(error));
      if (isFinanceAuthError(error)) throw error;
    }
  };

  const send = async (submission: SelfPurchaseSubmission): Promise<void> => {
    if (!personal) return;
    setNotice(""); setReceipt(""); setPendingSubmit(submission); setFresh(false);
    onDataMayChange();
    try {
      const result = await client.submitSelfPurchase(submission);
      if (result.status !== "COMPLETED") throw new Error("SELF_PURCHASE_RESULT_UNCONFIRMED");
    }
    catch (error) {
      if (uncertain(error)) {
        setNotice("尚不能确认划拨结果，可能已经完成。金额、原因与原件已锁定，请安全重试原采买申请，勿重复新建。");
      } else {
        setPendingSubmit(null);
        if (error instanceof ApiClientError && error.status === 409) {
          setDraft(null); clearForm();
          setNotice(`${purchaseError(error)} 旧输入已清空，请核对最新记录；如仍为草稿，请重新打开、填写并确认。`);
          try { await load(); }
          catch (refreshError) {
            setNotice(`${purchaseError(error)} 最新记录也未能读取，请点击刷新采买记录后核对。`);
            if (isFinanceAuthError(refreshError)) throw refreshError;
          }
        } else { setNotice(purchaseError(error)); }
      }
      if (isFinanceAuthError(error)) throw error;
      return;
    }
    setPendingSubmit(null); setDraft(null); clearForm(); setDetail(null);
    setDrafts((items) => items.filter((item) => item.id !== submission.draft.documentId));
    const beans = formatCentsAsBeans(submission.draft.amountCents);
    setReceipt(`采买已完成：财务业务账户扣除 ${beans} 欢乐豆，本人个人账户增加 ${beans} 欢乐豆。由系统规则自动处理，无需再次审批或执行。`);
    try { await load(); }
    catch (error) {
      setNotice("本次划拨结果已确认，但采买记录刷新失败。请刷新记录，勿重复提交。");
      if (isFinanceAuthError(error)) throw error;
    }
  };

  const submit = async (): Promise<void> => {
    if (!personal || pendingCreate !== null) return;
    if (pendingSubmit !== null) { await send(pendingSubmit); return; }
    setNotice(""); setValidation(null);
    if (draft === null || !fresh) { setNotice("请先刷新采买记录，再打开草稿核对后提交。"); return; }
    let amountCents: string;
    try { amountCents = parseBeanAmountToCents(amount); }
    catch { setValidation({ field: "amount", message: "采买金额须为正数，最多保留两位小数。" }); return; }
    if (BigInt(amountCents) <= 0n || BigInt(amountCents) > 9_223_372_036_854_775_807n) {
      setValidation({ field: "amount", message: "请填写有效范围内的正数采买金额，最多保留两位小数。" }); return;
    }
    if (!reason.trim() || reason.length > 1000 || /[\x00-\x1f\x7f]/.test(reason)) {
      setValidation({ field: "reason", message: "请填写采买原因，最多1000字，勿包含换行或控制字符。" }); return;
    }
    const supporting = chosen.SUPPORTING_DOCUMENT;
    const screenshot = chosen.APPLICATION_SCREENSHOT;
    if (!supporting || !screenshot || uploadCount > 0) {
      setValidation({ field: "attachments", message: "请上传并选用已就绪的采买业务单据与申请截图，再确认提交。" }); return;
    }
    let submission: SelfPurchaseSubmission;
    try {
      submission = client.createSelfPurchaseSubmission({
        documentId: draft.id, expectedVersion: draft.version, amountCents, reason,
        attachmentVersionIds: [supporting, screenshot]
      });
    } catch (error) { setNotice(purchaseError(error)); return; }
    await send(submission);
  };

  const readDetail = async (documentId: string): Promise<void> => {
    setNotice(""); setDetail(null);
    try { setDetail(await client.getSelfPurchaseDetail(documentId)); }
    catch (error) {
      setNotice(`采买详情未能读取：${purchaseError(error)}`);
      if (isFinanceAuthError(error)) throw error;
    }
  };

  return <section className="finance-panel" aria-label={personal ? "本人采买" : "采买管理记录"} hidden={!active}>
    <div className="section-heading"><div><p className="eyebrow">{personal ? "我的账户" : "财务查询"}</p><h2>{personal ? "本人采买" : "采买管理记录"}</h2>
      <p>{personal ? "仅具有有效总部财务任职的本人可申请。提交后自动完成业务账户扣豆、本人账户加豆。" : "查看本人采买、撤销记录、处理结果与原件。"}</p></div>
      <Button variant="outline" disabled={busy} onClick={() => void run(refresh)}>刷新采买记录</Button>
    </div>
    {receipt && <p className="finance-success" role="status">{receipt}</p>}
    {notice && <p className="finance-notice" role="alert">{notice}</p>}
    {validation && <p className="finance-notice" role="alert">{validation.message}</p>}
    {!loaded && <p>{busy ? "正在读取采买记录…" : "暂未读取到采买记录，请点击刷新。"}</p>}
    {loaded && !fresh && <p className="finance-muted">记录尚未刷新，请先核对最新结果再发起新申请。</p>}
    {personal && <Card className="finance-card">
      <div className="section-heading"><div><h3>采买草稿</h3><p>草稿不产生划拨。重新打开草稿需再次填写金额与原因，可选用已上传的原件。</p></div>
        <Button disabled={busy || !loaded || (pending && pendingCreate === null)} onClick={() => void run(createDraft)}>{pendingCreate ? "安全重试创建采买草稿" : "新建采买申请"}</Button></div>
      {loaded && drafts.length === 0 && <p className="finance-empty">暂无采买草稿。</p>}
      <div className="finance-list">{drafts.map((item) => <div className="finance-list-row" key={item.id}>
        <div><strong>采买草稿</strong><p>{timeLabel(item.createdAt)} · {item.id}</p></div>
        <Button variant="outline" disabled={busy || pending || draft?.id === item.id} onClick={() => void run(() => openDraft(item.id))}>{draft?.id === item.id ? "正在填写" : "继续填写采买"}</Button>
      </div>)}</div>
    </Card>}
    {personal && draft !== null && <Card className="finance-card"><h3>填写采买申请</h3>
      <form autoComplete="off" onSubmit={(event) => { event.preventDefault(); void run(submit); }}>
        <fieldset className="finance-form-grid" disabled={locked}>
          <label>采买金额（欢乐豆）<input inputMode="decimal" required maxLength={22} value={amount} onChange={(event) => { setAmount(event.target.value); setValidation((current) => current?.field === "amount" ? null : current); }} placeholder="正数，最多两位小数" /></label>
          <label>采买原因<input required maxLength={1000} value={reason} onChange={(event) => { setReason(event.target.value); setValidation((current) => current?.field === "reason" ? null : current); }} placeholder="说明本次采买用途" /></label>
        </fieldset>
        <p className="finance-muted">资金从当前财务职责对应的业务账户划入本人个人账户；业务账户可记负余额。提交时核验任职和账户配置。</p>
        <div className="finance-attachments">{purposes.map(({ purpose, label }) => <div className="finance-attachment-slot" key={`${draft.id}:${purpose}`}>
          <AttachmentPicker client={client} documentId={draft.id} purpose={purpose} label={label} disabled={locked} run={run}
            onReady={(versionId) => { setChosen((items) => items[purpose] === versionId ? items : { ...items, [purpose]: versionId }); setValidation((current) => current?.field === "attachments" ? null : current); }}
            onPendingChange={(value) => { if (value) pendingUploads.current.add(purpose); else pendingUploads.current.delete(purpose); setUploadCount(pendingUploads.current.size); }} />
          {attachments.filter((item) => item.purpose === purpose).flatMap((item) => item.versions.filter((version) => version.status === "READY").map((version) => <div className="finance-attachment-row" key={version.versionId}>
            <label><input type="radio" name={`self-purchase-${purpose}`} checked={chosen[purpose] === version.versionId} disabled={locked} onChange={() => { setChosen((items) => ({ ...items, [purpose]: version.versionId })); setValidation((current) => current?.field === "attachments" ? null : current); }} />选用 {version.originalFilename} · 第{version.versionNo}版</label>
            <AttachmentDownload client={client} versionId={version.versionId} filename={version.originalFilename} disabled={busy} run={run} />
          </div>))}
          <p className="finance-muted">{chosen[purpose] ? `${label}已就绪并选用` : `请上传或选用一份已就绪的${label}`}</p>
        </div>)}</div>
        <Button type="submit" disabled={busy || pendingCreate !== null || uploadCount > 0 || (pendingSubmit === null && (!fresh || !chosen.SUPPORTING_DOCUMENT || !chosen.APPLICATION_SCREENSHOT))}>
          {pendingSubmit ? "安全重试原采买申请" : "确认采买并划拨"}
        </Button>
      </form>
    </Card>}
    <Card className="finance-card"><h3>{personal ? "我的采买记录" : "采买记录"}</h3>
      {loaded && records.length === 0 && <p className="finance-empty">暂无采买记录。</p>}
      <div className="finance-list">{records.map((item) => <div className="finance-list-row" key={item.id}>
        <div><strong>{formatCentsAsBeans(item.amountCents)} 欢乐豆 · {statusLabel(item.status)}</strong><p>{item.reason}</p><p>支出：{item.sourceFund.displayName} · 原划拨由系统规则自动处理</p>
          {!personal && <p>申请人：{item.applicantDisplayName}</p>}<p>原划拨时间：{timeLabel(item.completedAt)}</p></div>
        <Button variant="outline" disabled={busy} onClick={() => void run(() => readDetail(item.id))}>查看采买详情</Button>
      </div>)}</div>
    </Card>
    {detail !== null && <Card className="finance-card"><div className="section-heading"><h3>采买详情</h3><Button variant="outline" onClick={() => setDetail(null)}>收起采买详情</Button></div>
      <dl className="finance-detail"><dt>状态</dt><dd>{statusLabel(detail.status)}</dd>
        <dt>原划拨处理</dt><dd>系统规则自动处理</dd>
        <dt>金额</dt><dd>{formatCentsAsBeans(detail.amountCents)} 欢乐豆</dd><dt>原因</dt><dd>{detail.reason}</dd>
        <dt>支出业务账户</dt><dd>{detail.sourceFund.displayName}</dd><dt>申请人</dt><dd>{detail.applicantDisplayName}</dd>
        <dt>原划拨时间</dt><dd>{timeLabel(detail.completedAt)}</dd><dt>申请编号</dt><dd>{detail.id}</dd>
        {detail.status === "REVERSED" && detail.reversal && <><dt>撤销原因</dt><dd>{detail.reversal.reason}</dd><dt>撤销时间</dt><dd>{timeLabel(detail.reversal.reversedAt)}</dd></>}
      </dl>
      <p className="finance-muted">{detail.status === "COMPLETED"
        ? "已完成业务账户扣豆与申请人个人账户加豆。"
        : detail.status === "REVERSED"
          ? "原采买已撤销，该笔欢乐豆已退回原业务账户，并从原个人收款账户扣回；原申请与凭证保留。"
          : "暂不能确认当前处理状态，请刷新后核对。"}</p>
      {detail.attachments.map((item) => <div className="finance-attachment-row" key={item.versionId}>
        <span>{item.purpose === "APPLICATION_SCREENSHOT" ? "采买申请截图" : item.purpose === "INVOICE" ? "发票" : "采买业务单据"} · {item.originalFilename}</span>
        <AttachmentDownload client={client} versionId={item.versionId} filename={item.originalFilename} disabled={busy} run={run} />
      </div>)}
    </Card>}
  </section>;
}
