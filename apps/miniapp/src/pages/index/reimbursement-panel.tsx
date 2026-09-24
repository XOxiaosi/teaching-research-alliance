import { useEffect, useRef, useState, type ReactNode } from "react";
import Taro from "@tarojs/taro";
import { Button, Image, Input, Text, Textarea, View } from "@tarojs/components";
import {
  ApiClientError,
  RoleSelectionRequiredError,
  StaleResponseError,
  formatCentsAsBeans,
  parseBeanAmountToCents,
  type FinanceAttachmentReservationSubmission,
  type FinanceDocumentAttachment,
  type FinanceDocumentAttachmentVersion,
  type FinanceDraftMetadata,
  type FinanceDraftSubmission,
  type ReimbursementCommandResult,
  type ReimbursementDetail,
  type ReimbursementExecuteSubmission,
  type ReimbursementReversalSubmission,
  type ReimbursementReviewSubmission,
  type ReimbursementSubmission,
  type ReimbursementSummary,
  type SessionSnapshot,
  type TeacherApiClient
} from "@teaching-research-alliance/client";
import { createPickedFinanceAttachment, type PickedFinanceAttachment } from "../../finance-attachment-helpers";
import { downloadFinanceAttachmentToTemp, readTemporaryFileBytes, uploadFinanceAttachmentBytes } from "../../services";

const SCREENSHOT_PURPOSE = "APPLICATION_SCREENSHOT";
type PendingUpload = Readonly<{ file: PickedFinanceAttachment; submission: FinanceAttachmentReservationSubmission; attempted: boolean; versionId?: string }>;
type Command = Readonly<{ kind: "submit"; submission: ReimbursementSubmission } | { kind: "review"; submission: ReimbursementReviewSubmission } | { kind: "execute"; submission: ReimbursementExecuteSubmission } | { kind: "reverse"; submission: ReimbursementReversalSubmission }>;
const personalSubjects = ["TEACHING_TEACHER", "ACADEMIC_PLANNER", "PLANNING_MENTOR", "TEACHER"] as const;
const managedSubjects = ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"] as const;

const statusLabel: Record<ReimbursementSummary["status"], string> = {
  PENDING_APPROVAL: "待审核", APPROVED: "审核通过·待划拨", COMPLETED: "已完成", REVERSED: "已撤销", REJECTED: "已驳回"
};
const isAccessLoss = (error: unknown): boolean => error instanceof RoleSelectionRequiredError
  || (error instanceof ApiClientError && (error.status === 401 || error.status === 403));
const uncertain = (error: unknown): boolean => !(error instanceof ApiClientError) || error.status >= 500;
const timeLabel = (value: string): string => new Date(value).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
const sameSessionScope = (left: SessionSnapshot, right: SessionSnapshot | null): boolean =>
  right !== null && left.sessionId === right.sessionId && left.accountId === right.accountId && left.personId === right.personId
  && left.currentRoleContext?.subject === right.currentRoleContext?.subject && left.currentRoleContext?.personId === right.currentRoleContext?.personId
  && left.currentRoleContext?.scope === right.currentRoleContext?.scope && left.currentRoleContext?.regionId === right.currentRoleContext?.regionId
  && left.currentRoleContext?.campusId === right.currentRoleContext?.campusId && left.currentRoleContext?.venueId === right.currentRoleContext?.venueId;
const readyScreenshotVersions = (attachments: readonly FinanceDocumentAttachment[]): readonly FinanceDocumentAttachmentVersion[] => attachments
  .filter((attachment) => attachment.purpose === SCREENSHOT_PURPOSE)
  .flatMap((attachment) => attachment.versions.filter((version) => version.status === "READY" && (version.declaredMediaType === "image/png" || version.declaredMediaType === "image/jpeg"))
    .sort((left, right) => right.versionNo - left.versionNo || right.createdAt.localeCompare(left.createdAt)).slice(0, 1));

/** This component creates, reviews, and explicitly executes approved internal reimbursement transfers. */
export function ReimbursementPanel({ client, session, mode, onInvalidated, onBusyChange, onUnconfirmedChange, onDataMayChange }: {
  client: TeacherApiClient;
  session: SessionSnapshot;
  mode: "personal" | "managed";
  onInvalidated: () => void;
  onBusyChange: (busy: boolean) => void;
  onUnconfirmedChange: (pending: boolean) => void;
  onDataMayChange: () => void;
}): ReactNode {
  const personal = mode === "personal";
  const role = session.currentRoleContext;
  const canApply = personal && personalSubjects.includes(role?.subject as (typeof personalSubjects)[number]);
  const isStrictGlobal = role?.scope === "GLOBAL" && role.regionId === undefined && role.campusId === undefined && role.venueId === undefined;
  const canReadManaged = !personal && managedSubjects.includes(role?.subject as (typeof managedSubjects)[number]) && isStrictGlobal;
  const canReview = !personal && role?.subject === "HEADQUARTERS_FINANCE" && isStrictGlobal;
  const canReverse = !personal && managedSubjects.includes(role?.subject as (typeof managedSubjects)[number]) && isStrictGlobal;
  const mounted = useRef(true); const running = useRef(false);
  const pendingCreate = useRef<FinanceDraftSubmission | null>(null);
  const pendingCommand = useRef<Command | null>(null);
  const pendingUploads = useRef<Readonly<Record<string, PendingUpload>>>({});
  const uploadSerial = useRef(0);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [records, setRecords] = useState<readonly ReimbursementSummary[]>([]);
  const [drafts, setDrafts] = useState<readonly FinanceDraftMetadata[]>([]);
  const [draft, setDraft] = useState<FinanceDraftMetadata | null>(null);
  const [attachments, setAttachments] = useState<readonly FinanceDocumentAttachment[]>([]);
  const [attachmentRefreshRequired, setAttachmentRefreshRequired] = useState(false);
  const [amount, setAmount] = useState(""); const [reason, setReason] = useState("");
  const [detail, setDetail] = useState<ReimbursementDetail | null>(null);
  const [reviewReason, setReviewReason] = useState("");
  const [reversalReason, setReversalReason] = useState("");
  const [notice, setNotice] = useState(""); const [receipt, setReceipt] = useState("");

  const hasUnknownUpload = (): boolean => Object.values(pendingUploads.current).some((item) => item?.attempted);
  const reportPending = (): void => { onUnconfirmedChange(pendingCreate.current !== null || pendingCommand.current !== null || hasUnknownUpload()); setRevision((value) => value + 1); };
  const clearForm = (): void => { setDraft(null); setAttachments([]); setAttachmentRefreshRequired(false); setAmount(""); setReason(""); pendingUploads.current = {}; };
  const clearSensitive = (): void => { clearForm(); setDrafts([]); setRecords([]); setDetail(null); setReviewReason(""); setReversalReason(""); pendingCreate.current = null; pendingCommand.current = null; };
  const invalidate = (): void => { clearSensitive(); onUnconfirmedChange(false); onBusyChange(false); onInvalidated(); };
  const locked = busy || pendingCreate.current !== null || pendingCommand.current !== null || hasUnknownUpload();

  const load = async (): Promise<void> => {
    if (!canApply && !canReadManaged) return;
    // TeacherApiClient invalidates older concurrent reads. Keep this sequence so a valid
    // list read cannot be mistaken for an uncertain command while a draft read finishes.
    const listed = personal ? await client.listOwnReimbursements() : await client.listManagedReimbursements();
    const ownDrafts = personal ? await client.listOwnFinanceDrafts() : [] as readonly FinanceDraftMetadata[];
    if (!mounted.current) return;
    setRecords(listed.documents);
    setDrafts(ownDrafts.filter((item) => item.kind === "REIMBURSEMENT"));
    setLoaded(true);
  };
  useEffect(() => {
    mounted.current = true;
    if (!canApply && !canReadManaged) return () => { mounted.current = false; };
    void load().catch((error) => { if (!mounted.current || error instanceof StaleResponseError) return; if (isAccessLoss(error) || !client.hasRoleContext) { invalidate(); return; } setNotice("报销记录暂未加载，请稍后刷新。"); });
    return () => { mounted.current = false; };
  }, [session.sessionId, mode]);

  const run = async (work: () => Promise<void>): Promise<void> => {
    if (running.current) return;
    running.current = true; setBusy(true); onBusyChange(true); setNotice("");
    try { await work(); }
    catch (error) {
      if (!mounted.current || error instanceof StaleResponseError) return;
      if (isAccessLoss(error) || !client.hasRoleContext) { invalidate(); return; }
      if (error instanceof Error && error.message === "FINANCE_ATTACHMENT_SIZE_INVALID") setNotice("原件必须小于等于 20 MB，且不能为空。");
      else if (error instanceof Error && error.message === "FINANCE_ATTACHMENT_TYPE_INVALID") setNotice("申请截图仅支持真实 PNG 或 JPEG 图片。");
      else if (uncertain(error)) setNotice("结果尚未确认。请保持内容不变并使用原按钮安全重试。");
      else setNotice(error instanceof ApiClientError && error.status === 409 ? "这笔申请已有新状态，旧输入已清空，请刷新后重新核对。" : "操作未完成，请检查当前权限和填写内容。");
    } finally { running.current = false; if (mounted.current) { setBusy(false); onBusyChange(false); reportPending(); } }
  };

  const refresh = async (): Promise<void> => {
    if (locked) return;
    setDetail(null); setReviewReason(""); setReversalReason(""); await load();
    // A successful upload is not submit-ready until the exact READY versions are read again.
    if (draft !== null) {
      const recovered = await client.listFinanceDocumentAttachments(draft.id);
      if (!mounted.current) return;
      setAttachments(recovered.attachments); setAttachmentRefreshRequired(false);
    }
  };
  const createDraft = async (): Promise<void> => {
    if (!canApply || pendingCommand.current !== null || hasUnknownUpload()) return;
    const submission = pendingCreate.current ?? client.createFinanceDraftSubmission({ kind: "REIMBURSEMENT" }); pendingCreate.current = submission; reportPending();
    let created: FinanceDraftMetadata;
    try { created = await client.createFinanceDraft(submission); }
    catch (error) { if (!uncertain(error)) { pendingCreate.current = null; reportPending(); } throw error; }
    if (!mounted.current) return;
    pendingCreate.current = null; clearForm(); setDraft(created); setDrafts((items) => [created, ...items.filter((item) => item.id !== created.id)]);
    setReceipt("报销草稿已创建。请填写金额、原因并上传至少一张完整申请截图。"); reportPending();
  };
  const openDraft = async (documentId: string): Promise<void> => {
    if (!canApply || locked) return;
    setDetail(null); setReceipt(""); clearForm();
    const metadata = await client.getOwnFinanceDraft(documentId);
    const recovered = await client.listFinanceDocumentAttachments(documentId);
    if (metadata.kind !== "REIMBURSEMENT" || metadata.status !== "DRAFT") { setNotice("这笔记录已不能继续作为报销草稿，请刷新后核对。"); return; }
    if (!mounted.current) return;
    setDraft(metadata); setAttachments(recovered.attachments);
  };
  const pick = async (): Promise<void> => {
    if (draft === null || locked) { setNotice("请先打开报销草稿。"); return; }
    const result = await Taro.chooseImage({ count: 9, sizeType: ["original"], sourceType: ["album", "camera"] });
    const paths = result.tempFilePaths.filter((path): path is string => typeof path === "string" && path.length > 0);
    if (paths.length < 1) throw new Error("FINANCE_ATTACHMENT_SIZE_INVALID");
    const files = await Promise.all(paths.map(async (path, index) => createPickedFinanceAttachment(`reimbursement-screenshot-${index + 1}.image`, path, await readTemporaryFileBytes(path))));
    if (files.some((file) => file.mediaType !== "image/png" && file.mediaType !== "image/jpeg")) throw new Error("FINANCE_ATTACHMENT_TYPE_INVALID");
    const current = client.currentSession; if (current === null || !sameSessionScope(session, current)) throw new StaleResponseError();
    const next = { ...pendingUploads.current } as Record<string, PendingUpload>;
    for (const file of files) {
      const key = `screenshot-${++uploadSerial.current}`;
      next[key] = { file, submission: client.createFinanceAttachmentReservationSubmission({ documentId: draft.id, purpose: SCREENSHOT_PURPOSE, originalFilename: file.name, declaredMediaType: file.mediaType, declaredSizeBytes: file.bytes.byteLength }), attempted: false };
    }
    pendingUploads.current = next; setNotice(`已选择 ${files.length} 张申请截图，可逐张预览后上传。`); reportPending();
  };
  const upload = async (key: string): Promise<void> => {
    const item = pendingUploads.current[key]; if (item === undefined || draft === null) { setNotice("请先选择申请截图。"); return; }
    let pending: PendingUpload = { ...item, attempted: true }; pendingUploads.current = { ...pendingUploads.current, [key]: pending }; reportPending();
    if (pending.versionId === undefined) {
      let reservation;
      try { reservation = await client.reserveFinanceAttachment(pending.submission); }
      catch (error) { if (!uncertain(error)) { const next = { ...pendingUploads.current }; delete next[key]; pendingUploads.current = next; reportPending(); } throw error; }
      pending = { ...pending, versionId: reservation.versionId }; pendingUploads.current = { ...pendingUploads.current, [key]: pending };
    }
    const versionId = pending.versionId;
    if (versionId === undefined) throw new Error("FINANCE_ATTACHMENT_RESERVATION_UNCONFIRMED");
    const uploadSession = client.currentSession; if (uploadSession === null) throw new ApiClientError(401, "UNAUTHENTICATED");
    const uploaded = await uploadFinanceAttachmentBytes(uploadSession, versionId, pending.file.mediaType, pending.file.bytes);
    if (!sameSessionScope(uploadSession, client.currentSession)) throw new StaleResponseError();
    if (uploaded.status === 401 || uploaded.status === 403) { client.logout(); throw new RoleSelectionRequiredError("FORBIDDEN_SCOPE"); }
    if (uploaded.status < 200 || uploaded.status >= 300) throw new Error("UPLOAD_UNCONFIRMED");
    const metadata = uploaded.metadata ?? await client.getOwnFinanceAttachmentVersion(versionId);
    if (metadata.status === "FAILED") { const next = { ...pendingUploads.current }; delete next[key]; pendingUploads.current = next; reportPending(); setNotice("申请截图未通过校验，请重新选择正确图片。"); return; }
    if (metadata.status !== "READY") throw new Error("UPLOAD_UNCONFIRMED");
    const next = { ...pendingUploads.current }; delete next[key]; pendingUploads.current = next; setAttachmentRefreshRequired(true); reportPending();
    try {
      const recovered = await client.listFinanceDocumentAttachments(draft.id); if (!mounted.current) return;
      setAttachments(recovered.attachments); setAttachmentRefreshRequired(false); setNotice("申请截图已完整上传。");
    } catch (error) { if (isAccessLoss(error) || !client.hasRoleContext) { invalidate(); return; } setNotice("申请截图已上传，但版本列表刷新失败；请刷新记录后确认提交版本。"); }
  };
  const uploadAll = async (): Promise<void> => {
    const keys = Object.keys(pendingUploads.current);
    if (keys.length < 1) { setNotice("请先选择至少一张申请截图。"); return; }
    for (const key of keys) await upload(key);
  };
  const previewPicked = async (key: string): Promise<void> => {
    const item = pendingUploads.current[key]; if (item === undefined) return;
    const paths = Object.values(pendingUploads.current).map((pending) => pending.file.temporaryPath);
    await Taro.previewImage({ current: item.file.temporaryPath, urls: paths });
  };
  const submit = async (): Promise<void> => {
    if (!canApply || draft === null || pendingCreate.current !== null) { setNotice("请先新建并打开报销草稿。"); return; }
    let command = pendingCommand.current;
    if (command?.kind === "submit") { await execute(command); return; }
    if (locked || attachmentRefreshRequired) { setNotice("请先确认原件上传和版本列表，再提交报销申请。"); return; }
    const screenshots = readyScreenshotVersions(attachments).map((version) => version.versionId);
    let cents: string;
    try { cents = parseBeanAmountToCents(amount); if (BigInt(cents) <= 0n) throw new Error("POSITIVE_REQUIRED"); }
    catch { setNotice("报销金额须为正数，最多保留两位小数。"); return; }
    if (!reason.trim() || reason.length > 1000 || /[\x00-\x1f\x7f]/.test(reason)) { setNotice("请填写报销原因，最多1000字，勿包含换行或控制字符。"); return; }
    if (screenshots.length < 1) { setNotice("请上传至少一张已就绪的 PNG 或 JPEG 申请截图。"); return; }
    command = { kind: "submit", submission: client.createReimbursementSubmission({ documentId: draft.id, expectedVersion: draft.version, amountCents: cents, reason: reason.trim(), attachmentVersionIds: screenshots }) };
    await execute(command);
  };
  const readDetail = async (id: string): Promise<void> => { if (locked) return; setDetail(null); setReviewReason(""); setReversalReason(""); setDetail(await client.getReimbursementDetail(id)); };
  const review = async (decision: "APPROVE" | "REJECT"): Promise<void> => {
    if (!canReview || detail === null || detail.status !== "PENDING_APPROVAL" || locked) return;
    let command = pendingCommand.current;
    if (command?.kind === "review") { await execute(command); return; }
    const normalized = reviewReason.trim();
    if (normalized.length > 1000 || /[\x00-\x1f\x7f]/.test(normalized)) { setNotice("审核意见最多1000字，勿包含换行或控制字符。"); return; }
    command = { kind: "review", submission: client.createReimbursementReviewSubmission({ documentId: detail.id, expectedVersion: detail.version, decision, reason: normalized }) };
    await execute(command);
  };
  const executeTransfer = async (): Promise<void> => {
    if (!canReview || detail === null || detail.status !== "APPROVED" || locked) return;
    const command: Command = { kind: "execute", submission: client.createReimbursementExecuteSubmission({ documentId: detail.id, expectedVersion: detail.version }) };
    await execute(command);
  };
  const reverseTransfer = async (): Promise<void> => {
    if (!canReverse || detail === null || detail.status !== "COMPLETED" || locked) return;
    let command = pendingCommand.current;
    if (command?.kind === "reverse") { await execute(command); return; }
    const normalized = reversalReason.trim();
    if (!normalized || normalized.length > 1000 || /[\x00-\x1f\x7f]/.test(normalized)) { setNotice("请填写撤销原因，最多1000字，勿包含换行或控制字符。"); return; }
    command = { kind: "reverse", submission: client.createReimbursementReversalSubmission({ documentId: detail.id, expectedVersion: detail.version, reason: normalized }) };
    await execute(command);
  };
  const afterConflict = async (command: Command, conflict: unknown): Promise<void> => {
    if (command.kind === "submit") clearForm(); else { setDetail(null); setReviewReason(""); setReversalReason(""); }
    try { await load(); if (command.kind !== "submit") setDetail(await client.getReimbursementDetail(command.submission.draft.documentId)); }
    catch (error) { if (isAccessLoss(error)) throw error; }
    if (command.kind === "execute" && conflict instanceof ApiClientError && conflict.code === "REIMBURSEMENT_CROSS_FINANCE_YEAR_PENDING") {
      setNotice("跨财年报销归属待确认，本次未划拨。已重新读取当前记录；原执行请求不会自动重发。");
      return;
    }
    setNotice("单据状态已发生变化，旧输入已清空。请刷新并重新核对，原请求不会自动改写或重发。");
  };
  const execute = async (command: Command): Promise<void> => {
    pendingCommand.current = command; reportPending(); setReceipt("");
    let result: ReimbursementCommandResult;
    try {
      result = command.kind === "submit" ? await client.submitReimbursement(command.submission)
        : command.kind === "review" ? await client.reviewReimbursement(command.submission)
          : command.kind === "execute" ? await client.executeReimbursement(command.submission)
            : await client.reverseReimbursement(command.submission);
      const expectedStatus = command.kind === "submit" ? "PENDING_APPROVAL"
        : command.kind === "review" ? (command.submission.draft.decision === "APPROVE" ? "APPROVED" : "REJECTED")
          : command.kind === "execute" ? "COMPLETED" : "REVERSED";
      if (result.status !== expectedStatus || result.id !== command.submission.draft.documentId
        || result.version !== command.submission.draft.expectedVersion + 1) throw new Error("REIMBURSEMENT_RESULT_UNCONFIRMED");
    } catch (error) {
      if (uncertain(error)) {
        const message = command.kind === "submit" ? "尚不能确认报销申请结果，金额、原因与原件已锁定。请安全重试原报销申请。"
          : command.kind === "review" ? "尚不能确认审核结果，审核决定与原因已锁定。请安全重试原审核操作。"
            : command.kind === "execute" ? "尚不能确认内部欢乐豆划拨结果，原划拨请求已锁定。请安全重试原内部划拨。"
              : "尚不能确认撤销划拨结果，撤销原因与原请求已锁定。请安全重试原撤销划拨。";
        setNotice(message); return;
      }
      pendingCommand.current = null; reportPending();
      if (error instanceof ApiClientError && error.status === 409) { await afterConflict(command, error); return; }
      throw error;
    }
    pendingCommand.current = null; reportPending();
    if (command.kind === "submit") { clearForm(); setReceipt(result.replay ? "报销申请已确认，未重复提交。" : "报销申请已提交，等待总部财务人工审核；尚未发生欢乐豆划拨。"); }
    else if (command.kind === "review") { setReviewReason(""); setReceipt(result.status === "APPROVED" ? "报销审核已通过，等待后续财务划拨；本次审核不改变欢乐豆余额。" : "报销已驳回，本次未发生欢乐豆划拨。"); }
    else if (command.kind === "execute") { setReviewReason(""); onDataMayChange(); setReceipt(result.replay ? "内部欢乐豆划拨已确认，未重复执行。" : "内部欢乐豆划拨已完成；此记录不表示银行卡到账。"); }
    else { setReversalReason(""); onDataMayChange(); setReceipt(result.replay ? "撤销划拨已确认，未重复执行。" : "撤销划拨已完成：原笔欢乐豆已冲回；这不是银行退款。"); }
    setDetail(null);
    try { await load(); if (command.kind !== "submit") setDetail(await client.getReimbursementDetail(result.id)); }
    catch (error) { if (isAccessLoss(error)) throw error; const action = command.kind === "submit" ? "报销申请提交" : command.kind === "review" ? "报销审核" : command.kind === "execute" ? "内部欢乐豆划拨" : "撤销划拨"; setNotice(`本次${action}结果已确认，但刷新失败。请刷新后核对，勿重复操作。`); }
  };

  const openAttachment = async (versionId: string, filename: string, mediaType: string): Promise<void> => {
    const current = client.currentSession; if (current === null) throw new ApiClientError(401, "UNAUTHENTICATED");
    const result = await downloadFinanceAttachmentToTemp(current, versionId); if (!sameSessionScope(current, client.currentSession)) throw new StaleResponseError();
    if (result.status === 401 || result.status === 403) { client.logout(); throw new RoleSelectionRequiredError("FORBIDDEN_SCOPE"); }
    if (result.status < 200 || result.status >= 300 || !result.temporaryPath) throw new Error("DOWNLOAD_UNCONFIRMED");
    if (mediaType === "application/pdf") await Taro.openDocument({ filePath: result.temporaryPath, fileType: "pdf", showMenu: false }); else await Taro.previewImage({ current: result.temporaryPath, urls: [result.temporaryPath] });
    setNotice(`${filename}已临时打开，未保存为长期文件。`);
  };

  if (!canApply && !canReadManaged) return null;
  const pending = pendingCommand.current;
  const pendingScreenshots = Object.entries(pendingUploads.current);
  const readyScreenshots = readyScreenshotVersions(attachments);
  return <View className="panel finance-panel" data-reimbursement-module="reimbursement" data-mode={mode} data-render-revision={revision}>
    <Text className="panel-title">{personal ? "普通报销申请" : "普通报销管理"}</Text>
    <Text className="panel-description">{personal ? "提交完整原件后等待总部财务人工审核；申请本身不会划拨欢乐豆。" : "查看报销申请、办理结果与原件。总部财务负责审核与划拨；总部财务、管理员和系统所有者可撤销已完成的划拨。"}</Text>
    <Button className="quiet-button" disabled={locked} onClick={() => void run(refresh)}>刷新报销记录</Button>
    {receipt && <View className="notice"><Text>{receipt}</Text></View>}{notice && <View className="notice"><Text>{notice}</Text></View>}
    {pendingCreate.current !== null && <View className="notice" data-reimbursement-pending="create"><Text>草稿创建结果待确认，原请求已保留。</Text><Button className="quiet-button" disabled={busy} onClick={() => void run(createDraft)}>安全重试原创建请求</Button></View>}
    {pendingCommand.current !== null && <View className="notice" data-reimbursement-pending={pendingCommand.current.kind}><Text>{pendingCommand.current.kind === "submit" ? "报销申请结果待确认，金额、原因与原件已锁定。" : pendingCommand.current.kind === "review" ? `审核结果待确认。本次审核决定：${pendingCommand.current.submission.draft.decision === "APPROVE" ? "批准" : "驳回"}；审核原因已锁定。` : pendingCommand.current.kind === "execute" ? "内部欢乐豆划拨结果待确认；原请求已锁定。" : "撤销划拨结果待确认；撤销原因与原请求已锁定。"}</Text><Button className="quiet-button" disabled={busy} onClick={() => void run(() => execute(pendingCommand.current!))}>{pendingCommand.current.kind === "submit" ? "安全重试原报销申请" : pendingCommand.current.kind === "review" ? "安全重试原审核操作" : pendingCommand.current.kind === "execute" ? "安全重试原内部划拨" : "安全重试原撤销划拨"}</Button></View>}
    {personal && <View data-reimbursement-action="personal-application"><Text className="field-label">报销草稿</Text><Button className="primary-button" disabled={locked} onClick={() => void run(createDraft)}>{pendingCreate.current === null ? "新建报销申请" : "安全重试原创建请求"}</Button>
      {loaded && drafts.length === 0 && <Text className="panel-description">暂无报销草稿。</Text>}
      {drafts.map((item) => <View className="student-row" key={item.id}><View className="student-detail"><Text className="student-name">报销草稿</Text><Text className="student-meta">{item.id}</Text></View><Button className="quiet-button student-button" disabled={locked || draft?.id === item.id} onClick={() => void run(() => openDraft(item.id))}>{draft?.id === item.id ? "正在填写" : "继续填写报销"}</Button></View>)}
      {draft !== null && <View className="finance-detail"><Text className="field-label">填写报销申请</Text><Text className="field-label">报销金额 / 欢乐豆</Text><Input className="text-input" type="digit" value={amount} disabled={locked} placeholder="正数，最多两位小数" onInput={(event) => setAmount(event.detail.value)} /><Text className="field-label">报销原因</Text><Input className="text-input" value={reason} maxlength={1000} disabled={locked} placeholder="说明本次报销用途" onInput={(event) => setReason(event.detail.value)} />
        <View className="finance-upload" data-reimbursement-screenshot-upload><Text className="field-label">申请截图</Text><Text className="panel-description">一次可选择多张完整图片。仅支持 PNG 或 JPEG，每张最大 20 MB；至少上传一张后才能提交。</Text><Button className="quiet-button" disabled={locked} onClick={() => void run(pick)}>选择申请截图</Button>{pendingScreenshots.length > 0 && <Button className="quiet-button" disabled={busy || (locked && !pendingScreenshots.some(([, item]) => item.attempted))} onClick={() => void run(uploadAll)}>上传已选图片（{pendingScreenshots.length}张）</Button>}{pendingScreenshots.map(([key, item]) => <View className="finance-upload" key={key}><Image className="finance-attachment-thumbnail" src={item.file.temporaryPath} mode="aspectFill" onClick={() => void run(() => previewPicked(key))} /><Text className="panel-description">{item.file.name}</Text><Button className="quiet-button" disabled={busy} onClick={() => void run(() => previewPicked(key))}>预览图片</Button></View>)}{readyScreenshots.length > 0 && <Text className="panel-description">已就绪申请截图 {readyScreenshots.length} 张。</Text>}</View>
        {attachmentRefreshRequired && <Text className="panel-description">申请截图已上传，请刷新记录确认提交版本。</Text>}<Button className="primary-button" disabled={busy || (locked && pending?.kind !== "submit")} onClick={() => void run(submit)}>{pendingCommand.current?.kind === "submit" ? "安全重试原报销申请" : "确认提交报销申请"}</Button>
      </View>}
    </View>}
    {loaded && records.length === 0 && <Text className="panel-description">暂无报销申请记录。</Text>}
    {records.map((item) => <View className="student-row" key={item.id}><View className="student-detail"><Text className="student-name">{formatCentsAsBeans(item.amountCents)} 豆</Text><Text className="student-meta">{statusLabel[item.status]} · {item.applicantDisplayName}</Text>{item.status === "COMPLETED" && item.completedAt && <Text className="student-meta">内部划拨完成时间：{timeLabel(item.completedAt)}</Text>}{item.status === "REVERSED" && item.reversedAt && <Text className="student-meta">已撤销：{timeLabel(item.reversedAt)}</Text>}</View><Button className="quiet-button student-button" disabled={locked} onClick={() => void run(() => readDetail(item.id))}>查看报销详情</Button></View>)}
    {detail !== null && <View className="finance-detail"><Text className="field-label">报销详情</Text><Text className="panel-description">{statusLabel[detail.status]} · {formatCentsAsBeans(detail.amountCents)} 豆</Text>{detail.completedAt && <Text className="panel-description">内部划拨完成时间：{timeLabel(detail.completedAt)}</Text>}{detail.status === "REVERSED" && detail.reversedAt && <Text className="panel-description">已撤销时间：{timeLabel(detail.reversedAt)}</Text>}{detail.status === "REVERSED" && detail.reversalReason && <Text className="panel-description">撤销原因：{detail.reversalReason}</Text>}<Text className="panel-description">报销原因：{detail.reason}</Text>{detail.decision && <><Text className="panel-description">审核决定：{detail.decision.decision === "APPROVED" ? "审核通过" : "已驳回"}</Text><Text className="panel-description">审核意见：{detail.decision.reason || "未填写"}</Text></>}{!personal && detail.management?.completion && <View className="panel-description"><Text>内部划拨来源账户：{detail.management.completion.sourceAccountId}</Text><Text>内部划拨目标账户：{detail.management.completion.destinationAccountId}</Text><Text>执行人编号：{detail.management.completion.executedByPersonId}</Text></View>}<Text className="panel-description">{detail.status === "COMPLETED" ? "内部欢乐豆划拨已完成；此记录不表示银行卡到账，原申请和原件保留。" : detail.status === "REVERSED" ? "原笔欢乐豆划拨已撤销并冲回；这不是银行退款，原申请和原件保留。" : detail.status === "APPROVED" ? "审核通过，等待财务划拨；尚未增加个人账户余额。" : detail.status === "REJECTED" ? "该申请已驳回，未发生欢乐豆划拨；原申请和原件保留。" : "该申请正在等待总部财务人工审核，尚未发生欢乐豆划拨。"}</Text>{detail.attachments.map((item) => <View className="finance-upload" key={item.versionId}><Text className="panel-description">{item.purpose === "APPLICATION_SCREENSHOT" ? "报销申请截图" : "报销业务单据"} · {item.originalFilename}</Text><Button className="quiet-button" disabled={busy} onClick={() => void run(() => openAttachment(item.versionId, item.originalFilename, item.mediaType))}>打开{item.purpose === "APPLICATION_SCREENSHOT" ? "报销申请截图" : "报销业务单据"}</Button></View>)}
      {canReview && detail.status === "PENDING_APPROVAL" && <View data-reimbursement-action="review"><Text className="field-label">人工审核</Text><Text className="panel-description">审核意见可不填。批准仅改变审核状态为待划拨，不会自动增加任何账户余额。</Text><Textarea className="text-input" value={reviewReason} maxlength={1000} disabled={locked} placeholder="可选：填写审核依据或驳回原因" onInput={(event) => setReviewReason(event.detail.value)} /><Button className="primary-button" disabled={locked} onClick={() => void run(() => review("APPROVE"))}>批准报销申请</Button><Button className="quiet-button" disabled={locked} onClick={() => void run(() => review("REJECT"))}>驳回报销申请</Button></View>}
      {canReview && detail.status === "APPROVED" && <View data-reimbursement-action="execute"><Text className="field-label">执行内部欢乐豆划拨</Text><Text className="panel-description">此操作会按已审核记录从当前有效公司资金账户向申请人欢乐豆账户划拨；不表示银行卡到账。</Text><Button className="primary-button" disabled={locked} onClick={() => void run(executeTransfer)}>执行内部欢乐豆划拨</Button></View>}
      {canReverse && detail.status === "COMPLETED" && <View data-reimbursement-action="reverse"><Text className="field-label">撤销划拨</Text><Text className="panel-description">撤销会冲回原笔欢乐豆划拨，不是银行退款。</Text><Textarea className="text-input" value={reversalReason} maxlength={1000} disabled={locked} placeholder="填写撤销原因" onInput={(event) => setReversalReason(event.detail.value)} /><Button className="primary-button" disabled={locked || reversalReason.trim() === ""} onClick={() => void run(reverseTransfer)}>撤销划拨</Button></View>}
    </View>}
  </View>;
}
