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
  type ReimbursementExecuteSubmission,
  type ReimbursementReversalSubmission,
  type ReimbursementReviewSubmission,
  type ReimbursementSubmission,
  type ReimbursementSummary
} from "@teaching-research-alliance/client";
import { Button } from "./components/ui/button.js";
import { Card } from "./components/ui/card.js";
import { AttachmentDownload, AttachmentPicker, financeError, isFinanceAuthError, type FinancePanelProps } from "./finance-shared.js";
import { ReimbursementImagePreview } from "./reimbursement-image-preview.js";

type Props = FinancePanelProps & { mode: "personal" | "managed"; onInvalidated?: () => void };
type Command = { kind: "submit"; submission: ReimbursementSubmission }
  | { kind: "review"; submission: ReimbursementReviewSubmission }
  | { kind: "execute"; submission: ReimbursementExecuteSubmission }
  | { kind: "reverse"; submission: ReimbursementReversalSubmission };
type SelectedImage = Readonly<{ key: string; file: File }>;
const uncertain = (error: unknown): boolean => !(error instanceof ApiClientError) || error.status >= 500;
const timeLabel = (value: string): string => new Date(value).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
const statusLabel = (status: ReimbursementSummary["status"]): string => ({
  PENDING_APPROVAL: "待审核", APPROVED: "审核通过·待划拨", COMPLETED: "已完成", REVERSED: "已撤销", REJECTED: "已驳回"
})[status];

/** The panel submits, reviews, and explicitly executes approved internal reimbursement transfers. */
export function ReimbursementPanel({ client, busy, active, run, onUnconfirmedChange, onDataMayChange, onInvalidated, mode }: Props): ReactNode {
  const personal = mode === "personal";
  const started = useRef(false);
  const pendingUploads = useRef(new Set<string>());
  const [uploadCount, setUploadCount] = useState(0);
  const [drafts, setDrafts] = useState<readonly FinanceDraftMetadata[]>([]);
  const [records, setRecords] = useState<readonly ReimbursementSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [draft, setDraft] = useState<FinanceDraftMetadata | null>(null);
  const [attachments, setAttachments] = useState<readonly FinanceDocumentAttachment[]>([]);
  const [selectedVersionIds, setSelectedVersionIds] = useState<readonly string[]>([]);
  const [selectedImages, setSelectedImages] = useState<readonly SelectedImage[]>([]);
  const [uploadedImageKeys, setUploadedImageKeys] = useState<readonly string[]>([]);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [pendingCreate, setPendingCreate] = useState<FinanceDraftSubmission | null>(null);
  const [pendingCommand, setPendingCommand] = useState<Command | null>(null);
  const [detail, setDetail] = useState<ReimbursementDetail | null>(null);
  const [reviewReason, setReviewReason] = useState("");
  const [reversalReason, setReversalReason] = useState("");
  const [notice, setNotice] = useState("");
  const [receipt, setReceipt] = useState("");
  const [validation, setValidation] = useState<{ field: "amount" | "reason" | "attachments" | "review" | "reversal"; message: string } | null>(null);
  const pending = pendingCreate !== null || pendingCommand !== null || uploadCount > 0;
  const locked = busy || pendingCreate !== null || pendingCommand !== null;
  const role = client.currentSession?.currentRoleContext;
  const canReview = !personal && role !== null && role !== undefined && role.subject === "HEADQUARTERS_FINANCE" && role.scope === "GLOBAL"
    && role.regionId === undefined && role.campusId === undefined && role.venueId === undefined;
  const canReverse = !personal && role !== null && role !== undefined && ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"].includes(role.subject)
    && role.scope === "GLOBAL" && role.regionId === undefined && role.campusId === undefined && role.venueId === undefined;

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
    setValidation(null); setAmount(""); setReason(""); setAttachments([]); setSelectedVersionIds([]); setSelectedImages([]); setUploadedImageKeys([]);
    pendingUploads.current.clear(); setUploadCount(0);
  };
  const resetReview = (): void => {
    setReviewReason("");
    setValidation((current) => current?.field === "review" ? null : current);
  };
  const resetReversal = (): void => { setReversalReason(""); setValidation((current) => current?.field === "reversal" ? null : current); };

  const refresh = async (): Promise<void> => {
    if (pendingCommand !== null || pendingCreate !== null || uploadCount > 0) return;
    setNotice(""); setDetail(null); resetReview(); resetReversal();
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
      setReceipt("报销草稿已创建，尚未申请、审核或划拨。请填写金额、原因并上传至少一张申请截图。");
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
    const crossFinanceYear = conflict instanceof ApiClientError && conflict.code === "REIMBURSEMENT_CROSS_FINANCE_YEAR_PENDING";
    if (listFailure !== undefined || detailFailure !== undefined) {
      const reads = [
        listFailure !== undefined ? `报销列表未能读取：${financeError(listFailure)}` : "",
        detailFailure !== undefined ? `报销详情未能读取：${financeError(detailFailure)}` : ""
      ].filter(Boolean).join("；");
      const prefix = crossFinanceYear ? "跨财年报销归属待确认，本次未划拨。" : `${financeError(conflict)} 旧输入已清空；`;
      setNotice(`${prefix}${reads}。请刷新并重新核对，原请求不会自动改写或重发。`);
      return;
    }
    if (crossFinanceYear) {
      setNotice("跨财年报销归属待确认，本次未划拨。已重新读取当前记录；原执行请求不会自动重发。");
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
    } else if (command.kind === "review") {
      resetReview();
      setReceipt(result.status === "APPROVED"
        ? "报销审核已通过，等待后续财务划拨；本次审核不改变欢乐豆余额。"
        : "报销已驳回，本次未发生欢乐豆划拨。");
    } else if (command.kind === "execute") {
      resetReview(); onDataMayChange();
      setReceipt(result.replay ? "内部欢乐豆划拨已确认，未重复执行。" : "内部欢乐豆划拨已完成；此记录不表示银行卡到账。");
    } else {
      resetReversal(); onDataMayChange();
      setReceipt(result.replay ? "撤销划拨已确认，未重复执行。" : "撤销划拨已完成：原笔欢乐豆已冲回；这不是银行退款。");
    }
    setDetail(null);
    let listFailure: unknown;
    let detailFailure: unknown;
    try { await load(); }
    catch (error) { listFailure = error; }
    if (command.kind !== "submit") {
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
      const action = command.kind === "submit" ? "报销申请提交" : command.kind === "review" ? "报销审核" : command.kind === "execute" ? "内部欢乐豆划拨" : "撤销划拨";
      setNotice(`本次${action}结果已确认，但${reads}。请刷新后核对，勿重复操作。`);
    }
  };

  const execute = async (command: Command): Promise<void> => {
    setPendingCommand(command); setNotice(""); setReceipt(""); setFresh(false);
    let result: ReimbursementCommandResult | null = null;
    try {
      result = command.kind === "submit"
        ? await client.submitReimbursement(command.submission)
        : command.kind === "review"
          ? await client.reviewReimbursement(command.submission)
          : command.kind === "execute" ? await client.executeReimbursement(command.submission) : await client.reverseReimbursement(command.submission);
      const expectedStatus = command.kind === "submit" ? "PENDING_APPROVAL"
        : command.kind === "review" ? (command.submission.draft.decision === "APPROVE" ? "APPROVED" : "REJECTED")
          : command.kind === "execute" ? "COMPLETED" : "REVERSED";
      if (result.status !== expectedStatus || result.id !== command.submission.draft.documentId
        || result.version !== command.submission.draft.expectedVersion + 1) throw new Error("REIMBURSEMENT_RESULT_UNCONFIRMED");
    } catch (error) {
      if (uncertain(error)) {
        const message = command.kind === "submit"
          ? "尚不能确认报销申请结果，可能已经进入待审核。金额、原因与原件已锁定，请安全重试原报销申请。"
          : command.kind === "review"
            ? "尚不能确认审核结果，可能已经处理。审核决定与原因已锁定，请安全重试原审核操作。"
            : command.kind === "execute" ? "尚不能确认内部欢乐豆划拨结果，原划拨请求已锁定，请安全重试原内部划拨。" : "尚不能确认撤销划拨结果，原撤销原因已锁定，请安全重试原撤销划拨。";
        setNotice(message);
      } else {
        setPendingCommand(null);
        if (error instanceof ApiClientError && error.status === 409) {
          if (command.kind === "submit") { setDraft(null); resetForm(); setDetail(null); }
          else { resetReview(); resetReversal(); }
          await refreshAfterConflict(command.submission.draft.documentId, error, command.kind !== "submit");
        } else {
          const action = command.kind === "submit" ? "报销申请" : command.kind === "review" ? "报销审核" : command.kind === "execute" ? "内部欢乐豆划拨" : "撤销划拨";
          setNotice(`${action}未执行：${financeError(error)}。请重新读取并核对后再操作。`);
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
    if (selectedVersionIds.length === 0 || uploadCount > 0 || selectedImages.some((image) => !uploadedImageKeys.includes(image.key))) {
      setValidation({ field: "attachments", message: "请上传并选用至少一张已就绪的申请截图；所选图片均须完成上传。" }); return;
    }
    let submission: ReimbursementSubmission;
    try {
      submission = client.createReimbursementSubmission({ documentId: draft.id, expectedVersion: draft.version, amountCents, reason: reason.trim(), attachmentVersionIds: selectedVersionIds });
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
    if (normalizedReason.length > 1000 || /[\x00-\x1f\x7f]/.test(normalizedReason)) {
      setValidation({ field: "review", message: "审核意见最多1000字，勿包含换行或控制字符。" }); return;
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

  const executeTransfer = async (): Promise<void> => {
    if (!canReview || detail === null || detail.status !== "APPROVED" || pending || !fresh) return;
    const submission = client.createReimbursementExecuteSubmission({ documentId: detail.id, expectedVersion: detail.version });
    await execute({ kind: "execute", submission });
  };

  const reverseTransfer = async (): Promise<void> => {
    if (!canReverse || detail === null || detail.status !== "COMPLETED" || pending || !fresh) return;
    const reason = reversalReason.trim();
    if (!reason || reason.length > 1000 || /[\x00-\x1f\x7f]/.test(reason)) { setValidation({ field: "reversal", message: "请填写撤销原因，最多1000字，勿包含换行或控制字符。" }); return; }
    let submission: ReimbursementReversalSubmission;
    try { submission = client.createReimbursementReversalSubmission({ documentId: detail.id, expectedVersion: detail.version, reason }); }
    catch (error) { setNotice(`无法创建撤销请求：${financeError(error)}`); if (isFinanceAuthError(error)) throw error; return; }
    await execute({ kind: "reverse", submission });
  };

  return <section className="finance-panel" data-finance-module="reimbursement" data-mode={mode} aria-label={personal ? "我的报销" : "报销管理记录"} hidden={!active}>
    <div className="section-heading"><div><p className="eyebrow">{personal ? "我的账户" : "财务查询"}</p><h2>{personal ? "普通报销申请" : "普通报销管理"}</h2>
      <p>{personal ? "提交完整申请原件后等待总部财务人工审核；申请本身不划拨欢乐豆。" : "查看报销申请、办理结果与原件。总部财务负责审核与划拨；总部财务、管理员和系统所有者可撤销已完成的划拨。"}</p></div>
      <Button variant="outline" disabled={locked || uploadCount > 0} onClick={() => void run(refresh)}>刷新报销记录</Button>
    </div>
    {receipt && <p className="finance-success" role="status">{receipt}</p>}
    {notice && <p className="finance-notice" role="alert">{notice}</p>}
    {validation && <p className="finance-notice" role="alert">{validation.message}</p>}
    {pendingCreate !== null && <Card className="finance-warning" data-reimbursement-pending="create"><p>草稿创建结果待确认，原请求已保留。</p><Button disabled={busy} onClick={() => void run(createDraft)}>安全重试原创建请求</Button></Card>}
    {pendingCommand !== null && <Card className="finance-warning" data-reimbursement-pending={pendingCommand.kind}><p>{pendingCommand.kind === "submit" ? "报销申请结果待确认。金额、原因与原件已锁定。" : pendingCommand.kind === "review" ? `审核结果待确认。本次审核决定：${pendingCommand.submission.draft.decision === "APPROVE" ? "批准" : "驳回"}；审核原因已锁定。` : pendingCommand.kind === "execute" ? "内部欢乐豆划拨结果待确认；原请求已锁定。" : "撤销划拨结果待确认；原撤销原因已锁定。"}</p>
      <Button disabled={busy} onClick={() => void run(() => execute(pendingCommand))}>{pendingCommand.kind === "submit" ? "安全重试原报销申请" : pendingCommand.kind === "review" ? "安全重试原审核操作" : pendingCommand.kind === "execute" ? "安全重试原内部划拨" : "安全重试原撤销划拨"}</Button>
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
      <div className="finance-attachments"><div className="finance-attachment-slot">
        <label>上传申请截图（可选多张）<input aria-label="上传申请截图" type="file" multiple accept="image/png,image/jpeg" disabled={locked || uploadCount > 0} onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length > 0) setSelectedImages((items) => [...items, ...files.map((file, index) => ({ key: `${Date.now()}-${index}-${Math.random()}`, file }))]);
          event.target.value = "";
        }} /></label>
        <p className="finance-muted">PNG 或 JPEG，每张不超过 20 MB。选择多张后逐张上传；申请提交前均须上传完成。</p>
        {selectedImages.map(({ key, file }) => <div className="reimbursement-selected-image" key={key}>
          <AttachmentPicker client={client} documentId={draft.id} purpose="APPLICATION_SCREENSHOT" label={file.name} disabled={locked} run={run} initialFile={file} hideFileInput imageOnly
            onReady={(versionId) => {
              setUploadedImageKeys((keys) => keys.includes(key) ? keys : [...keys, key]);
              setSelectedVersionIds((ids) => ids.includes(versionId) ? ids : [...ids, versionId]);
              setValidation((current) => current?.field === "attachments" ? null : current);
              void client.listFinanceDocumentAttachments(draft.id).then((result) => setAttachments(result.attachments)).catch(() => {});
            }}
            onPendingChange={(value) => { if (value) pendingUploads.current.add(key); else pendingUploads.current.delete(key); setUploadCount(pendingUploads.current.size); }} />
          {!uploadedImageKeys.includes(key) && !pendingUploads.current.has(key) && <Button type="button" variant="ghost" disabled={locked} onClick={() => setSelectedImages((items) => items.filter((item) => item.key !== key))}>移除这张</Button>}
        </div>)}
        {attachments.filter((item) => item.purpose === "APPLICATION_SCREENSHOT").flatMap((item) => item.versions.filter((version) => version.status === "READY" && ["image/png", "image/jpeg"].includes(version.declaredMediaType)).map((version) => <div className="finance-attachment-row reimbursement-attachment-row" key={version.versionId}>
          <label><input type="checkbox" checked={selectedVersionIds.includes(version.versionId)} disabled={locked} onChange={(event) => { setSelectedVersionIds((ids) => event.target.checked ? [...new Set([...ids, version.versionId])] : ids.filter((id) => id !== version.versionId)); setValidation((current) => current?.field === "attachments" ? null : current); }} />选用 {version.originalFilename} · 第{version.versionNo}版</label>
          <ReimbursementImagePreview client={client} versionId={version.versionId} filename={version.originalFilename} {...(onInvalidated === undefined ? {} : { onInvalidated })} />
          <AttachmentDownload client={client} versionId={version.versionId} filename={version.originalFilename} disabled={busy} run={run} />
        </div>))}
        {attachments.some((item) => item.purpose !== "APPLICATION_SCREENSHOT") && <p className="finance-muted">旧版业务单据仍保留在草稿附件记录中，新申请无须另选第二类材料。</p>}
        <p className="finance-muted">已选用 {selectedVersionIds.length} 张申请截图。</p>
      </div></div>
      <Button type="submit" disabled={locked || uploadCount > 0 || !fresh || selectedVersionIds.length === 0 || selectedImages.some((image) => !uploadedImageKeys.includes(image.key))}>{pendingCommand?.kind === "submit" ? "申请结果待确认" : "确认提交报销申请"}</Button>
    </form></Card>}
    <Card className="finance-card"><h3>{personal ? "我的报销记录" : "报销记录"}</h3>{loaded && records.length === 0 && <p className="finance-empty">暂无报销记录。</p>}
      <div className="finance-list">{records.map((item) => <div className="finance-list-row" key={item.id}><div><strong>{formatCentsAsBeans(item.amountCents)} 欢乐豆 · {statusLabel(item.status)}</strong><p>{item.reason}</p>{!personal && <p>申请人：{item.applicantDisplayName}</p>}<p>申请时间：{timeLabel(item.submittedAt)}</p>{item.status === "COMPLETED" && item.completedAt && <p>内部划拨完成时间：{timeLabel(item.completedAt)}</p>}{item.status === "REVERSED" && item.reversedAt && <p>已撤销：{timeLabel(item.reversedAt)}</p>}</div>
        <Button variant="outline" disabled={locked || uploadCount > 0} onClick={() => void run(() => readDetail(item.id))}>查看报销详情</Button></div>)}</div>
    </Card>
    {detail !== null && <Card className="finance-card"><div className="section-heading"><h3>报销详情</h3><Button variant="outline" disabled={locked || uploadCount > 0} onClick={() => { setDetail(null); resetReview(); }}>收起报销详情</Button></div>
      <dl className="finance-detail"><dt>状态</dt><dd>{statusLabel(detail.status)}</dd><dt>金额</dt><dd>{formatCentsAsBeans(detail.amountCents)} 欢乐豆</dd><dt>报销原因</dt><dd>{detail.reason}</dd><dt>申请人</dt><dd>{detail.applicantDisplayName}</dd><dt>申请时间</dt><dd>{timeLabel(detail.submittedAt)}</dd>{detail.completedAt && <><dt>内部划拨完成时间</dt><dd>{timeLabel(detail.completedAt)}</dd></>}{detail.status === "REVERSED" && detail.reversedAt && <><dt>撤销划拨时间</dt><dd>{timeLabel(detail.reversedAt)}</dd><dt>撤销原因</dt><dd>{detail.reversalReason}</dd></>}<dt>申请编号</dt><dd>{detail.id}</dd>
        {detail.decision && <><dt>审核决定</dt><dd>{detail.decision.decision === "APPROVED" ? "审核通过" : "已驳回"}</dd>{detail.decision.reason.trim() !== "" && <><dt>审核意见</dt><dd>{detail.decision.reason}</dd></>}<dt>审核时间</dt><dd>{timeLabel(detail.decision.decidedAt)}</dd></>}
        {!personal && detail.management?.completion && <><dt>内部划拨来源账户</dt><dd>{detail.management.completion.sourceAccountId}</dd><dt>内部划拨目标账户</dt><dd>{detail.management.completion.destinationAccountId}</dd><dt>执行人编号</dt><dd>{detail.management.completion.executedByPersonId}</dd></>}
      </dl>
      <p className="finance-muted">{detail.status === "PENDING_APPROVAL" ? "该申请正在等待总部财务人工审核，尚未发生欢乐豆划拨。" : detail.status === "APPROVED" ? "审核通过，等待财务划拨；尚未增加个人账户余额。" : detail.status === "COMPLETED" ? "内部欢乐豆划拨已完成；此记录不表示银行卡到账，原申请和原件保留。" : detail.status === "REVERSED" ? "原笔欢乐豆划拨已撤销并冲回；这不是银行退款，原申请和原件保留。" : "该申请已驳回，未发生欢乐豆划拨；原申请和原件保留。"}</p>
      {canReview && detail.status === "PENDING_APPROVAL" && <div className="finance-action-section" data-reimbursement-action="review"><h4>人工审核</h4><p>审核意见可留空；批准仅改变审核状态为待划拨，不会自动增加任何账户余额。</p><label>审核意见（选填）<textarea value={reviewReason} maxLength={1000} disabled={locked || uploadCount > 0 || !fresh} onChange={(event) => { setReviewReason(event.target.value); setValidation((current) => current?.field === "review" ? null : current); }} placeholder="如有需要，可填写审核意见" /></label>
        <div className="finance-action-buttons"><Button disabled={locked || uploadCount > 0 || !fresh} onClick={() => void run(() => review("APPROVE"))}>批准报销申请</Button><Button variant="destructive" disabled={locked || uploadCount > 0 || !fresh} onClick={() => void run(() => review("REJECT"))}>驳回报销申请</Button></div>
      </div>}
      {canReview && detail.status === "APPROVED" && <div className="finance-action-section" data-reimbursement-action="execute"><h4>执行内部欢乐豆划拨</h4><p>此操作会按已审核记录从当前有效公司资金账户向申请人欢乐豆账户划拨；不表示银行卡到账。</p><Button disabled={locked || uploadCount > 0 || !fresh} onClick={() => void run(executeTransfer)}>执行内部欢乐豆划拨</Button></div>}
      {canReverse && detail.status === "COMPLETED" && <div className="finance-action-section" data-reimbursement-action="reverse"><h4>撤销划拨</h4><p>撤销会冲回原笔欢乐豆划拨，不是银行退款。</p><label>撤销原因<textarea value={reversalReason} maxLength={1000} disabled={locked || uploadCount > 0 || !fresh} onChange={(event) => { setReversalReason(event.target.value); setValidation((current) => current?.field === "reversal" ? null : current); }} /></label><Button variant="destructive" disabled={locked || uploadCount > 0 || !fresh || reversalReason.trim() === ""} onClick={() => void run(reverseTransfer)}>撤销划拨</Button></div>}
      {detail.attachments.map((item) => <div className="finance-attachment-row reimbursement-attachment-row" key={item.versionId}><span>{item.purpose === "APPLICATION_SCREENSHOT" ? "报销申请截图" : item.purpose === "INVOICE" ? "发票" : "报销业务单据"} · {item.originalFilename}</span>{["image/png", "image/jpeg"].includes(item.mediaType) && <ReimbursementImagePreview client={client} versionId={item.versionId} filename={item.originalFilename} {...(onInvalidated === undefined ? {} : { onInvalidated })} />}<AttachmentDownload client={client} versionId={item.versionId} filename={item.originalFilename} disabled={busy} run={run} /></div>)}
    </Card>}
  </section>;
}
