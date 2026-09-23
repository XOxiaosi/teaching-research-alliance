import { useEffect, useRef, useState, type ReactNode } from "react";
import Taro from "@tarojs/taro";
import { Button, Input, Picker, Text, Textarea, View } from "@tarojs/components";
import {
  ApiClientError,
  RoleSelectionRequiredError,
  StaleResponseError,
  formatCentsAsBeans,
  parseBeanAmountToCents,
  type FinanceAttachmentReservationSubmission,
  type FinanceAttachmentVersionSubmission,
  type FinanceDocumentAttachment,
  type FinanceDocumentAttachmentVersion,
  type FinanceDraftMetadata,
  type FinanceDraftSubmission,
  type ReimbursementCommandResult,
  type ReimbursementDetail,
  type ReimbursementReviewSubmission,
  type ReimbursementSubmission,
  type ReimbursementSummary,
  type SessionSnapshot,
  type TeacherApiClient
} from "@teaching-research-alliance/client";
import { createPickedFinanceAttachment, type PickedFinanceAttachment } from "../../finance-attachment-helpers";
import { downloadFinanceAttachmentToTemp, readTemporaryFileBytes, uploadFinanceAttachmentBytes } from "../../services";

const purposes = [
  { value: "SUPPORTING_DOCUMENT", label: "报销业务单据" },
  { value: "APPLICATION_SCREENSHOT", label: "报销申请截图" }
] as const;
type Purpose = (typeof purposes)[number]["value"];
type AttachmentSubmission = FinanceAttachmentReservationSubmission | FinanceAttachmentVersionSubmission;
type PendingUpload = Readonly<{ file: PickedFinanceAttachment; submission: AttachmentSubmission; attempted: boolean; versionId?: string }>;
type Command = Readonly<{ kind: "submit"; submission: ReimbursementSubmission } | { kind: "review"; submission: ReimbursementReviewSubmission }>;
const personalSubjects = ["TEACHING_TEACHER", "ACADEMIC_PLANNER", "PLANNING_MENTOR"] as const;
const managedSubjects = ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"] as const;

const statusLabel: Record<ReimbursementSummary["status"], string> = {
  PENDING_APPROVAL: "待审核", APPROVED: "审核通过·待划拨", COMPLETED: "已完成", REJECTED: "已驳回"
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
const isVersionSubmission = (submission: AttachmentSubmission): submission is FinanceAttachmentVersionSubmission => "attachmentId" in submission.draft;
const readyVersions = (attachments: readonly FinanceDocumentAttachment[], purpose: Purpose): readonly Readonly<{ attachmentId: string; version: FinanceDocumentAttachmentVersion }>[] =>
  attachments.filter((item) => item.purpose === purpose).flatMap((item) => item.versions.filter((version) => version.status === "READY").map((version) => ({ attachmentId: item.attachmentId, version })))
    .sort((left, right) => right.version.versionNo - left.version.versionNo || right.version.createdAt.localeCompare(left.version.createdAt));
const defaultVersions = (attachments: readonly FinanceDocumentAttachment[]): Readonly<Partial<Record<Purpose, string>>> => Object.fromEntries(purposes.flatMap((purpose) => {
  const version = readyVersions(attachments, purpose.value)[0]?.version.versionId;
  return version === undefined ? [] : [[purpose.value, version]];
})) as Partial<Record<Purpose, string>>;

/** This component creates and reviews requests only; completed internal transfers are read-only. */
export function ReimbursementPanel({ client, session, mode, onInvalidated, onBusyChange, onUnconfirmedChange }: {
  client: TeacherApiClient;
  session: SessionSnapshot;
  mode: "personal" | "managed";
  onInvalidated: () => void;
  onBusyChange: (busy: boolean) => void;
  onUnconfirmedChange: (pending: boolean) => void;
}): ReactNode {
  const personal = mode === "personal";
  const role = session.currentRoleContext;
  const canApply = personal && personalSubjects.includes(role?.subject as (typeof personalSubjects)[number]);
  const isStrictGlobal = role?.scope === "GLOBAL" && role.regionId === undefined && role.campusId === undefined && role.venueId === undefined;
  const canReadManaged = !personal && managedSubjects.includes(role?.subject as (typeof managedSubjects)[number]) && isStrictGlobal;
  const canReview = !personal && role?.subject === "HEADQUARTERS_FINANCE" && isStrictGlobal;
  const mounted = useRef(true); const running = useRef(false);
  const pendingCreate = useRef<FinanceDraftSubmission | null>(null);
  const pendingCommand = useRef<Command | null>(null);
  const pendingUploads = useRef<Partial<Record<Purpose, PendingUpload>>>({});
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [records, setRecords] = useState<readonly ReimbursementSummary[]>([]);
  const [drafts, setDrafts] = useState<readonly FinanceDraftMetadata[]>([]);
  const [draft, setDraft] = useState<FinanceDraftMetadata | null>(null);
  const [attachments, setAttachments] = useState<readonly FinanceDocumentAttachment[]>([]);
  const [chosen, setChosen] = useState<Readonly<Partial<Record<Purpose, string>>>>({});
  const [attachmentRefreshRequired, setAttachmentRefreshRequired] = useState(false);
  const [amount, setAmount] = useState(""); const [reason, setReason] = useState("");
  const [detail, setDetail] = useState<ReimbursementDetail | null>(null);
  const [reviewReason, setReviewReason] = useState("");
  const [notice, setNotice] = useState(""); const [receipt, setReceipt] = useState("");

  const hasUnknownUpload = (): boolean => Object.values(pendingUploads.current).some((item) => item?.attempted);
  const reportPending = (): void => { onUnconfirmedChange(pendingCreate.current !== null || pendingCommand.current !== null || hasUnknownUpload()); setRevision((value) => value + 1); };
  const clearForm = (): void => { setDraft(null); setAttachments([]); setChosen({}); setAttachmentRefreshRequired(false); setAmount(""); setReason(""); pendingUploads.current = {}; };
  const clearSensitive = (): void => { clearForm(); setDrafts([]); setRecords([]); setDetail(null); setReviewReason(""); pendingCreate.current = null; pendingCommand.current = null; };
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
      else if (error instanceof Error && error.message === "FINANCE_ATTACHMENT_TYPE_INVALID") setNotice("仅支持真实 PDF、PNG 或 JPEG 原件。");
      else if (uncertain(error)) setNotice("结果尚未确认。请保持内容不变并使用原按钮安全重试。");
      else setNotice(error instanceof ApiClientError && error.status === 409 ? "这笔申请已有新状态，旧输入已清空，请刷新后重新核对。" : "操作未完成，请检查当前权限和填写内容。");
    } finally { running.current = false; if (mounted.current) { setBusy(false); onBusyChange(false); reportPending(); } }
  };

  const refresh = async (): Promise<void> => {
    if (locked) return;
    setDetail(null); setReviewReason(""); await load();
    // A successful upload is not submit-ready until the exact READY versions are read again.
    if (draft !== null) {
      const recovered = await client.listFinanceDocumentAttachments(draft.id);
      if (!mounted.current) return;
      setAttachments(recovered.attachments); setChosen(defaultVersions(recovered.attachments)); setAttachmentRefreshRequired(false);
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
    setReceipt("报销草稿已创建。请填写金额、原因并上传两份申请原件。"); reportPending();
  };
  const openDraft = async (documentId: string): Promise<void> => {
    if (!canApply || locked) return;
    setDetail(null); setReceipt(""); clearForm();
    const metadata = await client.getOwnFinanceDraft(documentId);
    const recovered = await client.listFinanceDocumentAttachments(documentId);
    if (metadata.kind !== "REIMBURSEMENT" || metadata.status !== "DRAFT") { setNotice("这笔记录已不能继续作为报销草稿，请刷新后核对。"); return; }
    if (!mounted.current) return;
    setDraft(metadata); setAttachments(recovered.attachments); setChosen(defaultVersions(recovered.attachments));
  };
  const pick = async (purpose: Purpose): Promise<void> => {
    if (draft === null || locked) { setNotice("请先打开报销草稿。"); return; }
    const source = await Taro.showActionSheet({ itemList: ["选择原始图片", "选择 PDF 文件"] }); let path = ""; let name = "";
    if (source.tapIndex === 0) { const result = await Taro.chooseImage({ count: 1, sizeType: ["original"], sourceType: ["album", "camera"] }); path = result.tempFilePaths[0] ?? ""; name = `${purpose.toLowerCase()}.image`; }
    else { const result = await Taro.chooseMessageFile({ count: 1, type: "file", extension: ["pdf"] }); path = result.tempFiles[0]?.path ?? ""; name = result.tempFiles[0]?.name ?? ""; }
    if (!path || !name) throw new Error("FINANCE_ATTACHMENT_SIZE_INVALID");
    const file = createPickedFinanceAttachment(name, path, await readTemporaryFileBytes(path));
    const current = client.currentSession; if (current === null || !sameSessionScope(session, current)) throw new StaleResponseError();
    const existing = attachments.find((item) => item.purpose === purpose);
    const submission = existing === undefined
      ? client.createFinanceAttachmentReservationSubmission({ documentId: draft.id, purpose, originalFilename: file.name, declaredMediaType: file.mediaType, declaredSizeBytes: file.bytes.byteLength })
      : client.createFinanceAttachmentVersionSubmission({ attachmentId: existing.attachmentId, originalFilename: file.name, declaredMediaType: file.mediaType, declaredSizeBytes: file.bytes.byteLength });
    pendingUploads.current[purpose] = { file, submission, attempted: false }; setNotice(existing === undefined ? "原件已选择，请上传。" : "原件已选择，将作为新版本上传。"); reportPending();
  };
  const upload = async (purpose: Purpose): Promise<void> => {
    const item = pendingUploads.current[purpose]; if (item === undefined || draft === null) { setNotice("请先选择原件。"); return; }
    let pending: PendingUpload = { ...item, attempted: true }; pendingUploads.current[purpose] = pending; reportPending();
    if (pending.versionId === undefined) {
      let reservation;
      try { reservation = isVersionSubmission(pending.submission) ? await client.reserveFinanceAttachmentVersion(pending.submission) : await client.reserveFinanceAttachment(pending.submission); }
      catch (error) { if (!uncertain(error)) { delete pendingUploads.current[purpose]; reportPending(); } throw error; }
      pending = { ...pending, versionId: reservation.versionId }; pendingUploads.current[purpose] = pending;
    }
    const versionId = pending.versionId;
    if (versionId === undefined) throw new Error("FINANCE_ATTACHMENT_RESERVATION_UNCONFIRMED");
    const uploadSession = client.currentSession; if (uploadSession === null) throw new ApiClientError(401, "UNAUTHENTICATED");
    const uploaded = await uploadFinanceAttachmentBytes(uploadSession, versionId, pending.file.mediaType, pending.file.bytes);
    if (!sameSessionScope(uploadSession, client.currentSession)) throw new StaleResponseError();
    if (uploaded.status === 401 || uploaded.status === 403) { client.logout(); throw new RoleSelectionRequiredError("FORBIDDEN_SCOPE"); }
    if (uploaded.status < 200 || uploaded.status >= 300) throw new Error("UPLOAD_UNCONFIRMED");
    const metadata = uploaded.metadata ?? await client.getOwnFinanceAttachmentVersion(versionId);
    if (metadata.status === "FAILED") { delete pendingUploads.current[purpose]; reportPending(); setNotice("原件未通过校验，请重新选择正确文件。"); return; }
    if (metadata.status !== "READY") throw new Error("UPLOAD_UNCONFIRMED");
    delete pendingUploads.current[purpose]; setAttachmentRefreshRequired(true); reportPending();
    try {
      const recovered = await client.listFinanceDocumentAttachments(draft.id); if (!mounted.current) return;
      setAttachments(recovered.attachments); setChosen(defaultVersions(recovered.attachments)); setAttachmentRefreshRequired(false); setNotice("原件已完整上传，已选中最新修订版本。");
    } catch (error) { if (isAccessLoss(error) || !client.hasRoleContext) { invalidate(); return; } setNotice("原件已上传，但版本列表刷新失败；请刷新记录后确认提交版本。"); }
  };
  const submit = async (): Promise<void> => {
    if (!canApply || draft === null || pendingCreate.current !== null) { setNotice("请先新建并打开报销草稿。"); return; }
    let command = pendingCommand.current;
    if (command?.kind === "submit") { await execute(command); return; }
    if (locked || attachmentRefreshRequired) { setNotice("请先确认原件上传和版本列表，再提交报销申请。"); return; }
    const supporting = chosen.SUPPORTING_DOCUMENT; const screenshot = chosen.APPLICATION_SCREENSHOT;
    let cents: string;
    try { cents = parseBeanAmountToCents(amount); if (BigInt(cents) <= 0n) throw new Error("POSITIVE_REQUIRED"); }
    catch { setNotice("报销金额须为正数，最多保留两位小数。"); return; }
    if (!reason.trim() || reason.length > 1000 || /[\x00-\x1f\x7f]/.test(reason)) { setNotice("请填写报销原因，最多1000字，勿包含换行或控制字符。"); return; }
    if (!supporting || !screenshot) { setNotice("请上传并选用已就绪的报销业务单据与申请截图。"); return; }
    command = { kind: "submit", submission: client.createReimbursementSubmission({ documentId: draft.id, expectedVersion: draft.version, amountCents: cents, reason: reason.trim(), attachmentVersionIds: [supporting, screenshot] }) };
    await execute(command);
  };
  const readDetail = async (id: string): Promise<void> => { if (locked) return; setDetail(null); setReviewReason(""); setDetail(await client.getReimbursementDetail(id)); };
  const review = async (decision: "APPROVE" | "REJECT"): Promise<void> => {
    if (!canReview || detail === null || detail.status !== "PENDING_APPROVAL" || locked) return;
    let command = pendingCommand.current;
    if (command?.kind === "review") { await execute(command); return; }
    const normalized = reviewReason.trim();
    if (!normalized || normalized.length > 1000 || /[\x00-\x1f\x7f]/.test(normalized)) { setNotice("请填写审核原因，最多1000字，勿包含换行或控制字符。"); return; }
    command = { kind: "review", submission: client.createReimbursementReviewSubmission({ documentId: detail.id, expectedVersion: detail.version, decision, reason: normalized }) };
    await execute(command);
  };
  const afterConflict = async (command: Command): Promise<void> => {
    if (command.kind === "submit") clearForm(); else { setDetail(null); setReviewReason(""); }
    try { await load(); if (command.kind === "review") setDetail(await client.getReimbursementDetail(command.submission.draft.documentId)); }
    catch (error) { if (isAccessLoss(error)) throw error; }
    setNotice("单据状态已发生变化，旧输入已清空。请刷新并重新核对，原请求不会自动改写或重发。");
  };
  const execute = async (command: Command): Promise<void> => {
    pendingCommand.current = command; reportPending(); setReceipt("");
    let result: ReimbursementCommandResult;
    try {
      result = command.kind === "submit" ? await client.submitReimbursement(command.submission) : await client.reviewReimbursement(command.submission);
      if ((command.kind === "submit" && result.status !== "PENDING_APPROVAL") || (command.kind === "review" && result.status !== (command.submission.draft.decision === "APPROVE" ? "APPROVED" : "REJECTED"))) throw new Error("REIMBURSEMENT_RESULT_UNCONFIRMED");
    } catch (error) {
      if (uncertain(error)) { setNotice(command.kind === "submit" ? "尚不能确认报销申请结果，金额、原因与原件已锁定。请安全重试原报销申请。" : "尚不能确认审核结果，审核决定与原因已锁定。请安全重试原审核操作。"); return; }
      pendingCommand.current = null; reportPending();
      if (error instanceof ApiClientError && error.status === 409) { await afterConflict(command); return; }
      throw error;
    }
    pendingCommand.current = null; reportPending();
    if (command.kind === "submit") { clearForm(); setReceipt(result.replay ? "报销申请已确认，未重复提交。" : "报销申请已提交，等待总部财务人工审核；尚未发生欢乐豆划拨。"); }
    else { setReviewReason(""); setReceipt(result.status === "APPROVED" ? "报销审核已通过，等待后续财务划拨；本次审核不改变欢乐豆余额。" : "报销已驳回，本次未发生欢乐豆划拨。"); }
    setDetail(null);
    try { await load(); if (command.kind === "review") setDetail(await client.getReimbursementDetail(result.id)); }
    catch (error) { if (isAccessLoss(error)) throw error; setNotice(`本次${command.kind === "submit" ? "报销申请提交" : "报销审核"}结果已确认，但刷新失败。请刷新后核对，勿重复操作。`); }
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
  return <View className="panel finance-panel" data-reimbursement-module="reimbursement" data-mode={mode} data-render-revision={revision}>
    <Text className="panel-title">{personal ? "普通报销申请" : "普通报销管理"}</Text>
    <Text className="panel-description">{personal ? "提交完整原件后等待总部财务人工审核；申请本身不会划拨欢乐豆。" : "查看普通报销申请、审核结果与原件。仅全局总部财务可审核，管理员和系统所有者仅可查看。"}</Text>
    <Button className="quiet-button" disabled={locked} onClick={() => void run(refresh)}>刷新报销记录</Button>
    {receipt && <View className="notice"><Text>{receipt}</Text></View>}{notice && <View className="notice"><Text>{notice}</Text></View>}
    {pendingCreate.current !== null && <View className="notice" data-reimbursement-pending="create"><Text>草稿创建结果待确认，原请求已保留。</Text><Button className="quiet-button" disabled={busy} onClick={() => void run(createDraft)}>安全重试原创建请求</Button></View>}
    {pendingCommand.current !== null && <View className="notice" data-reimbursement-pending={pendingCommand.current.kind}><Text>{pendingCommand.current.kind === "submit" ? "报销申请结果待确认，金额、原因与原件已锁定。" : `审核结果待确认。本次审核决定：${pendingCommand.current.submission.draft.decision === "APPROVE" ? "批准" : "驳回"}；审核原因已锁定。`}</Text><Button className="quiet-button" disabled={busy} onClick={() => void run(() => execute(pendingCommand.current!))}>{pendingCommand.current.kind === "submit" ? "安全重试原报销申请" : "安全重试原审核操作"}</Button></View>}
    {personal && <View data-reimbursement-action="personal-application"><Text className="field-label">报销草稿</Text><Button className="primary-button" disabled={locked} onClick={() => void run(createDraft)}>{pendingCreate.current === null ? "新建报销申请" : "安全重试原创建请求"}</Button>
      {loaded && drafts.length === 0 && <Text className="panel-description">暂无报销草稿。</Text>}
      {drafts.map((item) => <View className="student-row" key={item.id}><View className="student-detail"><Text className="student-name">报销草稿</Text><Text className="student-meta">{item.id}</Text></View><Button className="quiet-button student-button" disabled={locked || draft?.id === item.id} onClick={() => void run(() => openDraft(item.id))}>{draft?.id === item.id ? "正在填写" : "继续填写报销"}</Button></View>)}
      {draft !== null && <View className="finance-detail"><Text className="field-label">填写报销申请</Text><Text className="field-label">报销金额 / 欢乐豆</Text><Input className="text-input" type="digit" value={amount} disabled={locked} placeholder="正数，最多两位小数" onInput={(event) => setAmount(event.detail.value)} /><Text className="field-label">报销原因</Text><Input className="text-input" value={reason} maxlength={1000} disabled={locked} placeholder="说明本次报销用途" onInput={(event) => setReason(event.detail.value)} />
        {purposes.map((item) => { const versions = readyVersions(attachments, item.value); const chosenId = chosen[item.value]; const selected = Math.max(versions.findIndex((entry) => entry.version.versionId === chosenId), 0); const pendingUpload = pendingUploads.current[item.value]; return <View className="finance-upload" key={item.value}><Text className="field-label">{item.label}</Text><Text className="panel-description">PDF、PNG 或 JPEG，最大 20 MB。</Text><Button className="quiet-button" disabled={locked && !pendingUpload?.attempted} onClick={() => void run(() => pick(item.value))}>选择原件</Button><Button className="quiet-button" disabled={busy || pendingUpload === undefined || (locked && !pendingUpload.attempted)} onClick={() => void run(() => upload(item.value))}>{pendingUpload?.versionId ? `重试上传${item.label}` : `上传${item.label}`}</Button>{versions.length > 0 && <Picker mode="selector" range={versions.map((entry) => `修订版 ${entry.version.versionNo} · ${entry.version.originalFilename}`)} value={selected} disabled={locked} onChange={(event) => setChosen((current) => ({ ...current, [item.value]: versions[Number(event.detail.value)]?.version.versionId ?? chosenId }))}><View className="picker-value"><Text>{versions[selected] === undefined ? "请选择已上传版本" : `修订版 ${versions[selected].version.versionNo} · ${versions[selected].version.originalFilename}`}</Text><Text>⌄</Text></View></Picker>}</View>; })}
        {attachmentRefreshRequired && <Text className="panel-description">原件已上传，请刷新记录确认提交版本。</Text>}<Button className="primary-button" disabled={busy || (locked && pending?.kind !== "submit")} onClick={() => void run(submit)}>{pendingCommand.current?.kind === "submit" ? "安全重试原报销申请" : "确认提交报销申请"}</Button>
      </View>}
    </View>}
    {loaded && records.length === 0 && <Text className="panel-description">暂无报销申请记录。</Text>}
    {records.map((item) => <View className="student-row" key={item.id}><View className="student-detail"><Text className="student-name">{formatCentsAsBeans(item.amountCents)} 豆</Text><Text className="student-meta">{statusLabel[item.status]} · {item.applicantDisplayName}</Text>{item.status === "COMPLETED" && item.completedAt && <Text className="student-meta">内部划拨完成时间：{timeLabel(item.completedAt)}</Text>}</View><Button className="quiet-button student-button" disabled={locked} onClick={() => void run(() => readDetail(item.id))}>查看报销详情</Button></View>)}
    {detail !== null && <View className="finance-detail"><Text className="field-label">报销详情</Text><Text className="panel-description">{statusLabel[detail.status]} · {formatCentsAsBeans(detail.amountCents)} 豆</Text>{detail.status === "COMPLETED" && detail.completedAt && <Text className="panel-description">内部划拨完成时间：{timeLabel(detail.completedAt)}</Text>}<Text className="panel-description">报销原因：{detail.reason}</Text>{detail.decision && <><Text className="panel-description">审核决定：{detail.decision.decision === "APPROVED" ? "审核通过" : "已驳回"}</Text><Text className="panel-description">审核原因：{detail.decision.reason}</Text></>}{!personal && detail.management?.completion && <View className="panel-description"><Text>内部划拨来源账户：{detail.management.completion.sourceAccountId}</Text><Text>内部划拨目标账户：{detail.management.completion.destinationAccountId}</Text><Text>执行人编号：{detail.management.completion.executedByPersonId}</Text><Text>执行账本事件编号：{detail.management.completion.ledgerEventId}</Text><Text>角色任命编号：{detail.management.completion.roleAssignmentId}</Text><Text>公司资金任命编号：{detail.management.completion.companyFundAssignmentId}</Text></View>}<Text className="panel-description">{detail.status === "COMPLETED" ? "内部欢乐豆划拨已完成；此记录不表示银行卡到账，原申请和原件保留。" : detail.status === "APPROVED" ? "审核通过，等待财务划拨；尚未增加个人账户余额。" : detail.status === "REJECTED" ? "该申请已驳回，未发生欢乐豆划拨；原申请和原件保留。" : "该申请正在等待总部财务人工审核，尚未发生欢乐豆划拨。"}</Text>{detail.attachments.map((item) => <View className="finance-upload" key={item.versionId}><Text className="panel-description">{item.purpose === "APPLICATION_SCREENSHOT" ? "报销申请截图" : "报销业务单据"} · {item.originalFilename}</Text><Button className="quiet-button" disabled={busy} onClick={() => void run(() => openAttachment(item.versionId, item.originalFilename, item.mediaType))}>打开{item.purpose === "APPLICATION_SCREENSHOT" ? "报销申请截图" : "报销业务单据"}</Button></View>)}
      {canReview && detail.status === "PENDING_APPROVAL" && <View data-reimbursement-action="review"><Text className="field-label">人工审核</Text><Text className="panel-description">批准仅改变审核状态为待划拨，不会自动增加任何账户余额。</Text><Textarea className="text-input" value={reviewReason} maxlength={1000} disabled={locked} placeholder="填写审核依据或驳回原因" onInput={(event) => setReviewReason(event.detail.value)} /><Button className="primary-button" disabled={locked || reviewReason.trim() === ""} onClick={() => void run(() => review("APPROVE"))}>批准报销申请</Button><Button className="quiet-button" disabled={locked || reviewReason.trim() === ""} onClick={() => void run(() => review("REJECT"))}>驳回报销申请</Button></View>}
    </View>}
  </View>;
}
