import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ApiClientError,
  formatCentsAsBeans,
  parseBeanAmountToCents,
  type FinanceDocumentAttachment,
  type FinanceDraftMetadata,
  type FinanceDraftSubmission,
  type ReimbursementCommandResult,
  type ReimbursementDetail,
  type ReimbursementReviewSubmission,
  type ReimbursementSubmission,
  type ReimbursementSummary
} from "@teaching-research-alliance/client";
import { Button } from "./components/ui/button.js";
import { Card } from "./components/ui/card.js";
import { AttachmentDownload, AttachmentPicker, financeError, isFinanceAuthError, type FinancePanelProps } from "./finance-shared.js";

type Props = Omit<FinancePanelProps, "onDataMayChange"> & { mode: "personal" | "managed" };
type Command = { kind: "submit"; submission: ReimbursementSubmission }
  | { kind: "review"; submission: ReimbursementReviewSubmission };
const purposes = [
  { purpose: "SUPPORTING_DOCUMENT", label: "报销业务单据" },
  { purpose: "APPLICATION_SCREENSHOT", label: "报销申请截图" }
] as const;
type Purpose = (typeof purposes)[number]["purpose"];
const uncertain = (error: unknown): boolean => !(error instanceof ApiClientError) || error.status >= 500;
const timeLabel = (value: string): string => new Date(value).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
const statusLabel = (status: ReimbursementSummary["status"]): string => ({
  PENDING_APPROVAL: "待审核", APPROVED: "审核通过·待划拨", REJECTED: "已驳回"
})[status];

/** A normal reimbursement is a request and review record; it never represents an automatic self-purchase transfer. */
export function ReimbursementPanel({ client, busy, active, run, onUnconfirmedChange, mode }: Props): ReactNode {
  const personal = mode === "personal";
  const started = useRef(false);
  const pendingUploads = useRef(new Set<Purpose>());
  const [uploadCount, setUploadCount] = useState(0);
  const [drafts, setDrafts] = useState<readonly FinanceDraftMetadata[]>([]);
  const [records, setRecords] = useState<readonly ReimbursementSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [draft, setDraft] = useState<FinanceDraftMetadata | null>(null);
  const [attachments, setAttachments] = useState<readonly FinanceDocumentAttachment[]>([]);
  const [chosen, setChosen] = useState<Partial<Record<Purpose, string>>>({});
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [pendingCreate, setPendingCreate] = useState<FinanceDraftSubmission | null>(null);
  const [pendingCommand, setPendingCommand] = useState<Command | null>(null);
  const [detail, setDetail] = useState<ReimbursementDetail | null>(null);
  const [reviewReason, setReviewReason] = useState("");
  const [notice, setNotice] = useState("");
  const [receipt, setReceipt] = useState("");
  const [validation, setValidation] = useState<{ field: "amount" | "reason" | "attachments" | "review"; message: string } | null>(null);
  const pending = pendingCreate !== null || pendingCommand !== null || uploadCount > 0;
  const locked = busy || pendingCreate !== null || pendingCommand !== null;
  const role = client.currentSession?.currentRoleContext;
  const canReview = !personal && role !== null && role !== undefined && role.subject === "HEADQUARTERS_FINANCE" && role.scope === "GLOBAL"
    && role.regionId === undefined && role.campusId === undefined && role.venueId === undefined;

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
      personal ? client.listOwnReimbursements() : client.listManagedReimbursements(),
      personal ? client.listOwnFinanceDrafts() : Promise.resolve([] as readonly FinanceDraftMetadata[])
    ]);
    setRecords(nextRecords.documents);
    setDrafts(nextDrafts.filter((item) => item.kind === "REIMBURSEMENT"));
    setLoaded(true); setFresh(true);
  };

  const resetForm = (): void => {
    setValidation(null); setAmount(""); setReason(""); setAttachments([]); setChosen({});
    pendingUploads.current.clear(); setUploadCount(0);
  };
  const resetReview = (): void => {
    setReviewReason("");
    setValidation((current) => current?.field === "review" ? null : current);
  };

  const refresh = async (): Promise<void> => {
    if (pendingCommand !== null || pendingCreate !== null || uploadCount > 0) return;
    setNotice(""); setDetail(null); resetReview();
    try { await load(); }
    catch (error) {
      setNotice(`报销记录刷新失败：${financeError(error)}`);
      if (isFinanceAuthError(error)) throw error;
    }
  };
  useEffect(() => {
    if (!active || busy || started.current) return;
    started.current = true;
    void run(refresh);
  }, [active, busy]);

  const openDraft = async (documentId: string): Promise<void> => {
    if (!personal || pending) return;
    setNotice(""); setReceipt(""); setDraft(null); resetForm();
    try {
      const [metadata, recovered] = await Promise.all([
        client.getOwnFinanceDraft(documentId), client.listFinanceDocumentAttachments(documentId)
      ]);
      if (metadata.kind !== "REIMBURSEMENT" || metadata.status !== "DRAFT") {
        setNotice("这笔记录已不能作为报销草稿继续填写，请刷新报销记录后核对。"); return;
      }
      setDraft(metadata); setAttachments(recovered.attachments);
    } catch (error) {
      setNotice(`报销草稿未能打开：${financeError(error)}`);
      if (isFinanceAuthError(error)) throw error;
    }
  };

  const createDraft = async (): Promise<void> => {
    if (!personal || pendingCommand !== null || uploadCount > 0) return;
    setNotice(""); setReceipt("");
    const submission = pendingCreate ?? client.createFinanceDraftSubmission({ kind: "REIMBURSEMENT" });
    setPendingCreate(submission);
    try {
      const created = await client.createFinanceDraft(submission);
      setPendingCreate(null); resetForm(); setDraft(created);
      setDrafts((items) => [created, ...items.filter((item) => item.id !== created.id)]);
      setReceipt("报销草稿已创建，尚未申请、审核或划拨。请填写金额、原因并上传两份申请原件。");
    } catch (error) {
      if (!uncertain(error)) setPendingCreate(null);
      setNotice(uncertain(error) ? "尚不能确认报销草稿是否创建，请安全重试原创建请求，避免重复新建。" : financeError(error));
      if (isFinanceAuthError(error)) throw error;
    }
  };

  const refreshAfterConflict = async (documentId: string, conflict: unknown, includeDetail: boolean): Promise<void> => {
    setDetail(null);
    let listFailure: unknown;
    let detailFailure: unknown;
    try { await load(); }
    catch (error) { listFailure = error; }
    if (includeDetail) {
      try { setDetail(await client.getReimbursementDetail(documentId)); }
      catch (error) { detailFailure = error; }
    }
    if (isFinanceAuthError(listFailure)) throw listFailure;
    if (isFinanceAuthError(detailFailure)) throw detailFailure;
    if (listFailure !== undefined || detailFailure !== undefined) {
      const reads = [
        listFailure !== undefined ? `报销列表未能读取：${financeError(listFailure)}` : "",
        detailFailure !== undefined ? `报销详情未能读取：${financeError(detailFailure)}` : ""
      ].filter(Boolean).join("；");
      setNotice(`${financeError(conflict)} 旧输入已清空；${reads}。请刷新并重新核对，原请求不会自动改写或重发。`);
      return;
    }
    setNotice(includeDetail
      ? "单据状态已发生变化，已重新读取报销列表和详情。旧输入已清空；请核对后重新操作。"
      : "单据状态已发生变化，已重新读取报销草稿和记录。旧输入已清空；请核对后重新操作。");
  };

  const finish = async (command: Command, result: ReimbursementCommandResult): Promise<void> => {
    setPendingCommand(null);
    if (command.kind === "submit") {
      setDraft(null); resetForm();
      setDrafts((items) => items.filter((item) => item.id !== result.id));
      setReceipt("报销申请已提交，等待总部财务人工审核；尚未发生欢乐豆划拨。");
    } else {
      resetReview();
      setReceipt(result.status === "APPROVED"
        ? "报销审核已通过，等待后续财务划拨；本次审核不改变欢乐豆余额。"
        : "报销已驳回，本次未发生欢乐豆划拨。");
    }
    setDetail(null);
    let listFailure: unknown;
    let detailFailure: unknown;
    try { await load(); }
    catch (error) { listFailure = error; }
    if (command.kind === "review") {
      try { setDetail(await client.getReimbursementDetail(result.id)); }
      catch (error) { detailFailure = error; }
    }
    if (isFinanceAuthError(listFailure)) throw listFailure;
    if (isFinanceAuthError(detailFailure)) throw detailFailure;
    if (listFailure !== undefined || detailFailure !== undefined) {
      const reads = [
        listFailure !== undefined ? `报销列表刷新失败：${financeError(listFailure)}` : "",
        detailFailure !== undefined ? `报销详情刷新失败：${financeError(detailFailure)}` : ""
      ].filter(Boolean).join("；");
      setNotice(`本次${command.kind === "submit" ? "报销申请提交" : "报销审核"}结果已确认，但${reads}。请刷新后核对，勿重复提交或审核。`);
    }
  };

  const execute = async (command: Command): Promise<void> => {
    setPendingCommand(command); setNotice(""); setReceipt(""); setFresh(false);
    let result: ReimbursementCommandResult | null = null;
    try {
      result = command.kind === "submit"
        ? await client.submitReimbursement(command.submission)
        : await client.reviewReimbursement(command.submission);
      if (command.kind === "submit" && result.status !== "PENDING_APPROVAL") throw new Error("REIMBURSEMENT_SUBMISSION_RESULT_UNCONFIRMED");
      if (command.kind === "review") {
        const expectedStatus = command.submission.draft.decision === "APPROVE" ? "APPROVED" : "REJECTED";
        if (result.status !== expectedStatus) throw new Error("REIMBURSEMENT_REVIEW_RESULT_UNCONFIRMED");
      }
    } catch (error) {
      if (uncertain(error)) {
        setNotice(command.kind === "submit"
          ? "尚不能确认报销申请结果，可能已经进入待审核。金额、原因与原件已锁定，请安全重试原报销申请。"
          : "尚不能确认审核结果，可能已经处理。审核决定与原因已锁定，请安全重试原审核操作。");
      } else {
        setPendingCommand(null);
        if (error instanceof ApiClientError && error.status === 409) {
          if (command.kind === "submit") { setDraft(null); resetForm(); setDetail(null); }
          else resetReview();
          await refreshAfterConflict(command.submission.draft.documentId, error, command.kind === "review");
        } else {
          setNotice(`${command.kind === "submit" ? "报销申请" : "报销审核"}未执行：${financeError(error)}。请重新读取并核对后再操作。`);
        }
      }
      if (isFinanceAuthError(error)) throw error;
      return;
    }
    if (result !== null) await finish(command, result);
  };

  const submit = async (): Promise<void> => {
    if (!personal || pendingCreate !== null) return;
    if (pendingCommand?.kind === "submit") { await execute(pendingCommand); return; }
    setNotice(""); setValidation(null);
    if (draft === null || !fresh) { setNotice("请先刷新报销记录，再打开草稿核对后提交。"); return; }
    let amountCents: string;
    try { amountCents = parseBeanAmountToCents(amount); }
    catch { setValidation({ field: "amount", message: "报销金额须为正数，最多保留两位小数。" }); return; }
    if (BigInt(amountCents) <= 0n || BigInt(amountCents) > 9_223_372_036_854_775_807n) {
      setValidation({ field: "amount", message: "请填写有效范围内的正数报销金额，最多保留两位小数。" }); return;
    }
    if (!reason.trim() || reason.length > 1000 || /[\x00-\x1f\x7f]/.test(reason)) {
      setValidation({ field: "reason", message: "请填写报销原因，最多1000字，勿包含换行或控制字符。" }); return;
    }
    const supporting = chosen.SUPPORTING_DOCUMENT;
    const screenshot = chosen.APPLICATION_SCREENSHOT;
    if (!supporting || !screenshot || uploadCount > 0) {
      setValidation({ field: "attachments", message: "请上传并选用已就绪的报销业务单据与申请截图，再确认提交。" }); return;
    }
    let submission: ReimbursementSubmission;
    try {
      submission = client.createReimbursementSubmission({ documentId: draft.id, expectedVersion: draft.version, amountCents, reason: reason.trim(), attachmentVersionIds: [supporting, screenshot] });
    } catch (error) {
      setNotice(`无法创建报销申请：${financeError(error)}`);
      if (isFinanceAuthError(error)) throw error;
      return;
    }
    await execute({ kind: "submit", submission });
  };

  const readDetail = async (documentId: string): Promise<void> => {
    if (pending) return;
    setNotice(""); setDetail(null); resetReview();
    try { setDetail(await client.getReimbursementDetail(documentId)); }
    catch (error) {
      setNotice(`报销详情未能读取：${financeError(error)}`);
      if (isFinanceAuthError(error)) throw error;
    }
  };

  const review = async (decision: "APPROVE" | "REJECT"): Promise<void> => {
    if (!canReview || detail === null || detail.status !== "PENDING_APPROVAL" || pending || !fresh) return;
    setNotice(""); setValidation(null);
    const normalizedReason = reviewReason.trim();
    if (!normalizedReason || normalizedReason.length > 1000 || /[\x00-\x1f\x7f]/.test(normalizedReason)) {
      setValidation({ field: "review", message: "请填写审核原因，最多1000字，勿包含换行或控制字符。" }); return;
    }
    let submission: ReimbursementReviewSubmission;
    try {
      submission = client.createReimbursementReviewSubmission({ documentId: detail.id, expectedVersion: detail.version, decision, reason: normalizedReason });
    } catch (error) {
      setNotice(`无法创建审核请求：${financeError(error)}`);
      if (isFinanceAuthError(error)) throw error;
      return;
    }
    await execute({ kind: "review", submission });
  };

  return <section className="finance-panel" data-finance-module="reimbursement" data-mode={mode} aria-label={personal ? "我的报销" : "报销管理记录"} hidden={!active}>
    <div className="section-heading"><div><p className="eyebrow">{personal ? "我的账户" : "财务查询"}</p><h2>{personal ? "普通报销申请" : "普通报销管理"}</h2>
      <p>{personal ? "提交完整申请原件后等待总部财务人工审核；申请本身不划拨欢乐豆。" : "查看普通报销申请、审核结果与原件。仅总部财务可审核，管理员与系统所有者仅可查看。"}</p></div>
      <Button variant="outline" disabled={locked || uploadCount > 0} onClick={() => void run(refresh)}>刷新报销记录</Button>
    </div>
    {receipt && <p className="finance-success" role="status">{receipt}</p>}
    {notice && <p className="finance-notice" role="alert">{notice}</p>}
    {validation && <p className="finance-notice" role="alert">{validation.message}</p>}
    {pendingCreate !== null && <Card className="finance-warning" data-reimbursement-pending="create"><p>草稿创建结果待确认，原请求已保留。</p><Button disabled={busy} onClick={() => void run(createDraft)}>安全重试原创建请求</Button></Card>}
    {pendingCommand !== null && <Card className="finance-warning" data-reimbursement-pending={pendingCommand.kind}><p>{pendingCommand.kind === "submit" ? "报销申请结果待确认。金额、原因与原件已锁定。" : `审核结果待确认。本次审核决定：${pendingCommand.submission.draft.decision === "APPROVE" ? "批准" : "驳回"}；审核原因已锁定。`}</p>
      <Button disabled={busy} onClick={() => void run(() => execute(pendingCommand))}>{pendingCommand.kind === "submit" ? "安全重试原报销申请" : "安全重试原审核操作"}</Button>
    </Card>}
    {!loaded && <p>{busy ? "正在读取报销记录…" : "暂未读取到报销记录，请点击刷新。"}</p>}
    {loaded && !fresh && <p className="finance-muted">记录尚未刷新，请先核对最新结果再发起新操作。</p>}
    {personal && <Card className="finance-card" data-reimbursement-action="personal-application"><div className="section-heading"><div><h3>报销草稿</h3><p>草稿不产生申请、审核或划拨。重新打开草稿需再次填写金额与原因，可选用已上传的原件。</p></div>
      <Button disabled={locked || uploadCount > 0 || !loaded} onClick={() => void run(createDraft)}>{pendingCreate ? "草稿创建结果待确认" : "新建报销申请"}</Button></div>
      {loaded && drafts.length === 0 && <p className="finance-empty">暂无报销草稿。</p>}
      <div className="finance-list">{drafts.map((item) => <div className="finance-list-row" key={item.id}><div><strong>报销草稿</strong><p>{timeLabel(item.createdAt)} · {item.id}</p></div>
        <Button variant="outline" disabled={locked || uploadCount > 0 || draft?.id === item.id} onClick={() => void run(() => openDraft(item.id))}>{draft?.id === item.id ? "正在填写" : "继续填写报销"}</Button>
      </div>)}</div>
    </Card>}
    {personal && draft !== null && <Card className="finance-card"><h3>填写报销申请</h3><form autoComplete="off" onSubmit={(event) => { event.preventDefault(); void run(submit); }}>
      <fieldset className="finance-form-grid" disabled={locked}><label>报销金额（欢乐豆）<input inputMode="decimal" required maxLength={22} value={amount} onChange={(event) => { setAmount(event.target.value); setValidation((current) => current?.field === "amount" ? null : current); }} placeholder="正数，最多两位小数" /></label>
        <label>报销原因<input required maxLength={1000} value={reason} onChange={(event) => { setReason(event.target.value); setValidation((current) => current?.field === "reason" ? null : current); }} placeholder="说明本次报销用途" /></label></fieldset>
      <p className="finance-muted">提交后进入人工审核；审核通过也只表示待后续财务划拨，不会自动增加个人账户欢乐豆。</p>
      <div className="finance-attachments">{purposes.map(({ purpose, label }) => <div className="finance-attachment-slot" key={`${draft.id}:${purpose}`}><AttachmentPicker client={client} documentId={draft.id} purpose={purpose} label={label} disabled={locked} run={run}
        onReady={(versionId) => { setChosen((items) => items[purpose] === versionId ? items : { ...items, [purpose]: versionId }); setValidation((current) => current?.field === "attachments" ? null : current); }}
        onPendingChange={(value) => { if (value) pendingUploads.current.add(purpose); else pendingUploads.current.delete(purpose); setUploadCount(pendingUploads.current.size); }} />
        {attachments.filter((item) => item.purpose === purpose).flatMap((item) => item.versions.filter((version) => version.status === "READY").map((version) => <div className="finance-attachment-row" key={version.versionId}><label><input type="radio" name={`reimbursement-${purpose}`} checked={chosen[purpose] === version.versionId} disabled={locked} onChange={() => { setChosen((items) => ({ ...items, [purpose]: version.versionId })); setValidation((current) => current?.field === "attachments" ? null : current); }} />选用 {version.originalFilename} · 第{version.versionNo}版</label><AttachmentDownload client={client} versionId={version.versionId} filename={version.originalFilename} disabled={busy} run={run} /></div>))}
        <p className="finance-muted">{chosen[purpose] ? `${label}已就绪并选用` : `请上传或选用一份已就绪的${label}`}</p></div>)}</div>
      <Button type="submit" disabled={locked || uploadCount > 0 || !fresh || !chosen.SUPPORTING_DOCUMENT || !chosen.APPLICATION_SCREENSHOT}>{pendingCommand?.kind === "submit" ? "申请结果待确认" : "确认提交报销申请"}</Button>
    </form></Card>}
    <Card className="finance-card"><h3>{personal ? "我的报销记录" : "报销记录"}</h3>{loaded && records.length === 0 && <p className="finance-empty">暂无报销记录。</p>}
      <div className="finance-list">{records.map((item) => <div className="finance-list-row" key={item.id}><div><strong>{formatCentsAsBeans(item.amountCents)} 欢乐豆 · {statusLabel(item.status)}</strong><p>{item.reason}</p>{!personal && <p>申请人：{item.applicantDisplayName}</p>}<p>申请时间：{timeLabel(item.submittedAt)}</p></div>
        <Button variant="outline" disabled={locked || uploadCount > 0} onClick={() => void run(() => readDetail(item.id))}>查看报销详情</Button></div>)}</div>
    </Card>
    {detail !== null && <Card className="finance-card"><div className="section-heading"><h3>报销详情</h3><Button variant="outline" disabled={locked || uploadCount > 0} onClick={() => { setDetail(null); resetReview(); }}>收起报销详情</Button></div>
      <dl className="finance-detail"><dt>状态</dt><dd>{statusLabel(detail.status)}</dd><dt>金额</dt><dd>{formatCentsAsBeans(detail.amountCents)} 欢乐豆</dd><dt>报销原因</dt><dd>{detail.reason}</dd><dt>申请人</dt><dd>{detail.applicantDisplayName}</dd><dt>申请时间</dt><dd>{timeLabel(detail.submittedAt)}</dd><dt>申请编号</dt><dd>{detail.id}</dd>
        {detail.decision && <><dt>审核决定</dt><dd>{detail.decision.decision === "APPROVED" ? "审核通过·待划拨" : "已驳回"}</dd><dt>审核原因</dt><dd>{detail.decision.reason}</dd><dt>审核时间</dt><dd>{timeLabel(detail.decision.decidedAt)}</dd></>}
      </dl>
      <p className="finance-muted">{detail.status === "PENDING_APPROVAL" ? "该申请正在等待总部财务人工审核，尚未发生欢乐豆划拨。" : detail.status === "APPROVED" ? "审核通过，等待财务划拨；尚未增加个人账户余额。" : "该申请已驳回，未发生欢乐豆划拨；原申请和原件保留。"}</p>
      {canReview && detail.status === "PENDING_APPROVAL" && <div className="finance-action-section" data-reimbursement-action="review"><h4>人工审核</h4><p>批准或驳回都会保留审核原因。批准只改变审核状态为待划拨，不会自动增加任何账户余额。</p><label>审核原因<textarea value={reviewReason} maxLength={1000} disabled={locked || uploadCount > 0 || !fresh} onChange={(event) => { setReviewReason(event.target.value); setValidation((current) => current?.field === "review" ? null : current); }} placeholder="填写审核依据或驳回原因" /></label>
        <div className="finance-action-buttons"><Button disabled={locked || uploadCount > 0 || !fresh || reviewReason.trim() === ""} onClick={() => void run(() => review("APPROVE"))}>批准报销申请</Button><Button variant="destructive" disabled={locked || uploadCount > 0 || !fresh || reviewReason.trim() === ""} onClick={() => void run(() => review("REJECT"))}>驳回报销申请</Button></div>
      </div>}
      {detail.attachments.map((item) => <div className="finance-attachment-row" key={item.versionId}><span>{item.purpose === "APPLICATION_SCREENSHOT" ? "报销申请截图" : item.purpose === "INVOICE" ? "发票" : "报销业务单据"} · {item.originalFilename}</span><AttachmentDownload client={client} versionId={item.versionId} filename={item.originalFilename} disabled={busy} run={run} /></div>)}
    </Card>}
  </section>;
}
