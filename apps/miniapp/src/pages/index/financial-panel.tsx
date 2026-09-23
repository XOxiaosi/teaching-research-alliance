import { useEffect, useRef, useState, type ReactNode } from "react";
import Taro from "@tarojs/taro";
import { Button, Input, Picker, Text, View } from "@tarojs/components";
import { ApiClientError, RoleSelectionRequiredError, StaleResponseError, formatCentsAsBeans, parseBeanAmountToCents, type FinanceAttachmentReservationSubmission, type FinanceAttachmentVersionSubmission, type FinanceDocumentAttachment, type FinanceDocumentAttachmentVersion, type FinanceDraftMetadata, type FinanceDraftSubmission, type SessionSnapshot, type TeacherApiClient, type WithdrawalDetail, type WithdrawalSource, type WithdrawalSubmitSubmission, type WithdrawalSummary } from "@teaching-research-alliance/client";
import { downloadFinanceAttachmentToTemp, readTemporaryFileBytes, uploadFinanceAttachmentBytes } from "../../services";
import { createPickedFinanceAttachment, type PickedFinanceAttachment } from "../../finance-attachment-helpers";

const purposes = [{ value: "SUPPORTING_DOCUMENT", label: "业务单据" }, { value: "APPLICATION_SCREENSHOT", label: "申请截图" }] as const;
type Purpose = (typeof purposes)[number]["value"];
type AttachmentReservationSubmission = FinanceAttachmentReservationSubmission | FinanceAttachmentVersionSubmission;
type PendingUpload = Readonly<{ file: PickedFinanceAttachment; submission: AttachmentReservationSubmission; attempted?: boolean; versionId?: string }>;
const personalSubjects = ["TEACHING_TEACHER", "ACADEMIC_PLANNER", "PLANNING_MENTOR", "TEACHER"] as const;
const statusLabel: Record<string, string> = { PENDING_TRANSFER: "已提交，等待转账", TRANSFERRED: "已转账", FINANCE_REVOKED: "财务已撤回" };
const sourceLabel = (source: WithdrawalSource, balanceUnconfirmed = false): string => `${source.sourceType === "PERSON" ? "个人账户" : "场地账户"} · ${source.label} · ${balanceUnconfirmed ? "余额待确认" : `可用 ${formatCentsAsBeans(source.balanceCents)} 豆`}`;
const sameSessionScope = (left: SessionSnapshot, right: SessionSnapshot | null): boolean =>
  right !== null && left.sessionId === right.sessionId && left.accountId === right.accountId && left.personId === right.personId
  && left.currentRoleContext?.subject === right.currentRoleContext?.subject && left.currentRoleContext?.personId === right.currentRoleContext?.personId
  && left.currentRoleContext?.scope === right.currentRoleContext?.scope && left.currentRoleContext?.regionId === right.currentRoleContext?.regionId
  && left.currentRoleContext?.campusId === right.currentRoleContext?.campusId && left.currentRoleContext?.venueId === right.currentRoleContext?.venueId;

export type ReadyAttachmentVersion = Readonly<{
  attachmentId: string;
  version: FinanceDocumentAttachmentVersion;
}>;

/** Versions are explicit submission choices. The newest READY revision is the safe refresh default. */
export const readyAttachmentVersions = (
  attachments: readonly FinanceDocumentAttachment[], purpose: Purpose
): readonly ReadyAttachmentVersion[] => Object.freeze(
  attachments
    .filter((attachment) => attachment.purpose === purpose)
    .flatMap((attachment) => attachment.versions
      .filter((version) => version.status === "READY")
      .map((version) => ({ attachmentId: attachment.attachmentId, version })))
    .sort((left, right) => right.version.versionNo - left.version.versionNo || right.version.createdAt.localeCompare(left.version.createdAt))
);

export const latestReadyAttachmentSelections = (
  attachments: readonly FinanceDocumentAttachment[]
): Readonly<Partial<Record<Purpose, string>>> => Object.freeze(
  Object.fromEntries(purposes.flatMap((purpose) => {
    const latest = readyAttachmentVersions(attachments, purpose.value)[0];
    return latest === undefined ? [] : [[purpose.value, latest.version.versionId]];
  })) as Partial<Record<Purpose, string>>
);

const isAccessLoss = (error: unknown): boolean => error instanceof RoleSelectionRequiredError
  || (error instanceof ApiClientError && (error.status === 401 || error.status === 403));

const isVersionReservation = (
  submission: AttachmentReservationSubmission
): submission is FinanceAttachmentVersionSubmission => "attachmentId" in submission.draft;

/** Sensitive bank fields and original bytes stay in this mounted component only. */
export function FinancialPanel({ client, session, onInvalidated, onSubmitted, onBusyChange, onUnconfirmedChange, onDataMayChange }: { client: TeacherApiClient; session: SessionSnapshot; onInvalidated: () => void; onSubmitted: () => Promise<void>; onBusyChange:(busy:boolean)=>void; onUnconfirmedChange:(pending:boolean)=>void; onDataMayChange:()=>void }): ReactNode {
  const [sources, setSources] = useState<readonly WithdrawalSource[]>([]);
  const [withdrawals, setWithdrawals] = useState<readonly WithdrawalSummary[]>([]);
  const [draft, setDraft] = useState<FinanceDraftMetadata | null>(null);
  const [attachments, setAttachments] = useState<readonly FinanceDocumentAttachment[]>([]);
  const [selectedReadyVersionIds, setSelectedReadyVersionIds] = useState<Readonly<Partial<Record<Purpose, string>>>>({});
  const [attachmentRefreshRequired, setAttachmentRefreshRequired] = useState(false);
  const [sourceBalanceUnconfirmed, setSourceBalanceUnconfirmed] = useState(false);
  const [sourceId, setSourceId] = useState(""); const [amount, setAmount] = useState("");
  const [recipientName, setRecipientName] = useState(""); const [bankAccount, setBankAccount] = useState(""); const [bankName, setBankName] = useState("");
  const [detail, setDetail] = useState<WithdrawalDetail | null>(null); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const pendingCreate = useRef<FinanceDraftSubmission | null>(null); const pendingSubmit = useRef<WithdrawalSubmitSubmission | null>(null);
  const pendingUploads = useRef<Partial<Record<Purpose, PendingUpload>>>({}); const mounted = useRef(true); const running = useRef(false);
  const reportPending = (): void => onUnconfirmedChange(pendingCreate.current !== null || pendingSubmit.current !== null || Object.values(pendingUploads.current).some(item=>item.attempted));
  const clearSensitive = (): void => { setDraft(null); setAttachments([]); setSelectedReadyVersionIds({}); setAttachmentRefreshRequired(false); setSourceBalanceUnconfirmed(false); setSourceId(""); setAmount(""); setRecipientName(""); setBankAccount(""); setBankName(""); setDetail(null); pendingCreate.current = null; pendingSubmit.current = null; pendingUploads.current = {}; };
  const invalidate = (): void => { clearSensitive(); setSources([]);setWithdrawals([]);onUnconfirmedChange(false);onBusyChange(false);onInvalidated(); };
  const load = async (preferredId: string | null = draft?.id ?? null): Promise<void> => {
    const [nextSources, nextDrafts, nextWithdrawals] = await Promise.all([client.listWithdrawalSources(), client.listOwnFinanceDrafts(), client.listOwnWithdrawals()]);
    // A draft merely matching the kind cannot confirm an unknown create command. Keep its original key retryable.
    const restoredDraft = pendingSubmit.current !== null || pendingCreate.current !== null
      ? draft
      : nextDrafts.find(item=>item.kind==="WITHDRAWAL"&&item.id===preferredId) ?? nextDrafts.find((item) => item.kind === "WITHDRAWAL") ?? null;
    const restoredAttachments = restoredDraft === null ? [] : (await client.listFinanceDocumentAttachments(restoredDraft.id)).attachments;
    if (!mounted.current) return;
    setSources(nextSources); setWithdrawals(nextWithdrawals); setDraft(restoredDraft); setAttachments(restoredAttachments);
    setSelectedReadyVersionIds(latestReadyAttachmentSelections(restoredAttachments));
    setAttachmentRefreshRequired(false);
    if (pendingSubmit.current === null) setSourceBalanceUnconfirmed(false);
  };
  useEffect(() => { mounted.current = true; void load().catch((error) => { if (error instanceof StaleResponseError || !mounted.current) return; if(!client.hasRoleContext || (error instanceof ApiClientError && (error.status===401||error.status===403))) { invalidate();return; } setNotice("提现资料暂未加载，请稍后刷新。"); }); return () => { mounted.current = false; }; }, []);
  const run = async (work: () => Promise<void>): Promise<void> => {
    if (running.current) return; running.current=true;setBusy(true);onBusyChange(true);setNotice("");
    try { await work(); } catch (error) {
      if (!mounted.current || error instanceof StaleResponseError) return;
      if (isAccessLoss(error)) { invalidate(); return; }
      if (error instanceof Error && error.message === "FINANCE_ATTACHMENT_SIZE_INVALID") setNotice("原件必须小于等于 20 MB，且不能为空。");
      else if (error instanceof Error && error.message === "FINANCE_ATTACHMENT_TYPE_INVALID") setNotice("仅支持真实 PDF、PNG 或 JPEG 原件。");
      else if(error instanceof ApiClientError && error.code==="INSUFFICIENT_BALANCE")setNotice("超出可用金额，请减少金额后重新提交。");
      else if (!(error instanceof ApiClientError) || error.status >= 500) setNotice("结果尚未确认。请保持内容不变并使用原按钮重试。");
      else setNotice(error.status === 409 ? "这笔申请已有新状态，请刷新后重新处理。" : "操作未完成，请检查填写内容与当前权限。");
    } finally { running.current=false;if (mounted.current) {setBusy(false);onBusyChange(false);reportPending();} }
  };
  const startDraft = async (): Promise<void> => {
    const submission = pendingCreate.current ?? client.createFinanceDraftSubmission({ kind: "WITHDRAWAL" }); pendingCreate.current = submission;
    let created:FinanceDraftMetadata;
    try { created=await client.createFinanceDraft(submission); } catch(error) { if(error instanceof ApiClientError&&error.status<500)pendingCreate.current=null; throw error; }
    if (!mounted.current) return; pendingCreate.current = null; setDraft(created); setNotice("提现草稿已创建，请上传两份原件。");
    try { await load(created.id); } catch(error) { if(isAccessLoss(error)||!client.hasRoleContext){invalidate();return;}setNotice("提现草稿已创建，列表刷新失败；可继续上传原件。"); }
  };
  const pick = async (purpose: Purpose): Promise<void> => {
    if(pendingSubmit.current!==null || pendingUploads.current[purpose]?.attempted)return;
    if (draft === null) { setNotice("请先创建提现草稿。"); return; }
    const originalSession=client.currentSession;if(originalSession===null)throw new ApiClientError(401,"UNAUTHENTICATED");
    const choice = await Taro.showActionSheet({ itemList: ["选择原始图片", "选择 PDF 文件"] }); let path = ""; let name = "";
    if (choice.tapIndex === 0) { const result = await Taro.chooseImage({ count: 1, sizeType: ["original"], sourceType: ["album", "camera"] }); path = result.tempFilePaths[0] ?? ""; name = `${purpose.toLowerCase()}.image`; }
    else { const result = await Taro.chooseMessageFile({ count: 1, type: "file", extension: ["pdf"] }); const file = result.tempFiles[0]; path = file?.path ?? ""; name = file?.name ?? ""; }
    if (!path || !name) throw new Error("FINANCE_ATTACHMENT_SIZE_INVALID"); const file = createPickedFinanceAttachment(name, path, await readTemporaryFileBytes(path));
    if(!mounted.current||!sameSessionScope(originalSession,client.currentSession))throw new StaleResponseError();
    const existingSlot = attachments.find((attachment) => attachment.purpose === purpose);
    const submission = existingSlot === undefined
      ? client.createFinanceAttachmentReservationSubmission({ documentId: draft.id, purpose, originalFilename: file.name, declaredMediaType: file.mediaType, declaredSizeBytes: file.bytes.byteLength })
      : client.createFinanceAttachmentVersionSubmission({ attachmentId: existingSlot.attachmentId, originalFilename: file.name, declaredMediaType: file.mediaType, declaredSizeBytes: file.bytes.byteLength });
    pendingUploads.current[purpose] = { file, submission };
    setNotice(existingSlot === undefined ? "原件已选择，请上传。" : "原件已选择，将作为这份原件的新版本上传。");
  };
  const upload = async (purpose: Purpose): Promise<void> => {
    const pending = pendingUploads.current[purpose]; if (pending === undefined || draft === null) { setNotice("请先选择原件。"); return; }
    let current:PendingUpload = {...pending,attempted:true};pendingUploads.current[purpose]=current;
    if (current.versionId === undefined) {
      let reservation;
      try {
        reservation = isVersionReservation(current.submission)
          ? await client.reserveFinanceAttachmentVersion(current.submission)
          : await client.reserveFinanceAttachment(current.submission);
      } catch(error) {
        // A known client/API error may be corrected. Permission loss still propagates to run().
        if(error instanceof ApiClientError&&error.status<500)delete pendingUploads.current[purpose];
        throw error;
      }
      current = { ...current, versionId: reservation.versionId };
      pendingUploads.current[purpose] = current;
    }
    const uploadSession = client.currentSession; if (uploadSession === null) throw new ApiClientError(401, "UNAUTHENTICATED");
    const uploaded = await uploadFinanceAttachmentBytes(uploadSession, current.versionId!, current.file.mediaType, current.file.bytes);
    if (!sameSessionScope(uploadSession, client.currentSession)) throw new StaleResponseError();
    if (uploaded.status === 401 || uploaded.status === 403) { client.logout(); invalidate(); throw new RoleSelectionRequiredError("FORBIDDEN_SCOPE"); }
    let metadata;
    try {
      metadata = uploaded.metadata ?? await client.getOwnFinanceAttachmentVersion(current.versionId!);
    } catch(error) {
      if(error instanceof ApiClientError&&error.status<500)delete pendingUploads.current[purpose];
      throw error;
    }
    if (metadata.status === "FAILED") { delete pendingUploads.current[purpose]; setNotice("原件未通过校验，请重新选择正确文件。"); return; }
    if (metadata.status !== "READY") throw new Error("UPLOAD_UNCONFIRMED");
    delete pendingUploads.current[purpose];
    // A stale list can still point at v1. Hold submission until the READY v2 list is recovered.
    setAttachmentRefreshRequired(true);
    try {
      const listed=await client.listFinanceDocumentAttachments(draft.id);
      if(!mounted.current)return;
      setAttachments(listed.attachments);
      setSelectedReadyVersionIds(latestReadyAttachmentSelections(listed.attachments));
      setAttachmentRefreshRequired(false);
      setNotice("原件已完整上传，已选中最新修订版本。");
    } catch(error) {
      if(isAccessLoss(error)||!client.hasRoleContext){invalidate();return;}
      setNotice("原件已完整上传，但列表刷新失败，请刷新记录恢复原件。");
    }
  };
  const readyVersionsFor = (purpose: Purpose): readonly ReadyAttachmentVersion[] => readyAttachmentVersions(attachments, purpose);
  const readyVersion = (purpose: Purpose): string | undefined => {
    const selected = selectedReadyVersionIds[purpose];
    return selected !== undefined && readyVersionsFor(purpose).some((item) => item.version.versionId === selected) ? selected : undefined;
  };
  const submit = async (): Promise<void> => {
    if (draft === null) { setNotice("请先创建提现草稿。"); return; }
    if(Object.values(pendingUploads.current).some(item=>item.attempted)){setNotice("请先确认原件上传结果。");return;}
    if(attachmentRefreshRequired){setNotice("原件已上传，请先刷新提现记录确认提交版本。");return;}
    let submission=pendingSubmit.current;
    if(submission===null){const supporting = readyVersion("SUPPORTING_DOCUMENT"); const screenshot = readyVersion("APPLICATION_SCREENSHOT");
    if (!supporting || !screenshot || !sourceId || !recipientName.trim() || !bankAccount.trim()) { setNotice("请选择来源、收款姓名和卡号，并上传业务单据与申请截图。"); return; }
    let cents: string; try { cents = parseBeanAmountToCents(amount);if(BigInt(cents)<=0n)throw new Error("POSITIVE_REQUIRED"); } catch { setNotice("金额须大于零，最多两位小数。"); return; }
    submission=client.createWithdrawalSubmitSubmission({ documentId: draft.id, expectedVersion: draft.version, sourceAccountId: sourceId, amountCents: cents, recipientName: recipientName.trim(), bankAccount: bankAccount.trim(), ...(bankName.trim() ? { bankName: bankName.trim() } : {}), attachmentVersionIds: [supporting, screenshot] }); pendingSubmit.current=submission;}
    setSourceBalanceUnconfirmed(true);
    onDataMayChange();let result;
    try { result=await client.submitWithdrawal(submission); } catch(error) {
      if(error instanceof ApiClientError&&error.status<500) {
        pendingSubmit.current=null;
        if(error.code==="VERSION_CONFLICT"||error.code==="FINANCE_WITHDRAWAL_STATE_CONFLICT") {
          clearSensitive();
          try { await load(null); } catch(refreshError) {
            if(isAccessLoss(refreshError)||!client.hasRoleContext){invalidate();return;}
          }
        }
      }
      throw error;
    }
    if (!mounted.current) return; pendingSubmit.current = null; clearSensitive();
    setNotice(result.replay ? "提现已确认，未重复提交。余额已按申请更新。" : "提现已提交，余额已按申请更新。本人不能撤回，请等待财务办理。");
    try { await Promise.all([load(null), onSubmitted()]); } catch(error) { if(isAccessLoss(error)||!client.hasRoleContext){invalidate();return;}setNotice("提现已提交，余额已更新；刷新失败，请稍后点击刷新确认记录。"); }
  };
  const openAttachment = async (versionId: string, filename: string, mediaType: string): Promise<void> => {
    const current = client.currentSession; if (current === null) throw new ApiClientError(401, "UNAUTHENTICATED"); const downloaded = await downloadFinanceAttachmentToTemp(current, versionId);
    if (!sameSessionScope(current, client.currentSession)) throw new StaleResponseError(); if (downloaded.status === 401 || downloaded.status === 403) { client.logout(); invalidate(); throw new RoleSelectionRequiredError("FORBIDDEN_SCOPE"); }
    if (downloaded.status < 200 || downloaded.status >= 300 || !downloaded.temporaryPath) throw new Error("DOWNLOAD_UNCONFIRMED");
    if (mediaType === "application/pdf") await Taro.openDocument({ filePath: downloaded.temporaryPath, fileType: "pdf", showMenu: false }); else await Taro.previewImage({ current: downloaded.temporaryPath, urls: [downloaded.temporaryPath] }); setNotice(`${filename}已临时打开，未保存为长期文件。`);
  };
  if (!personalSubjects.includes(session.currentRoleContext?.subject as (typeof personalSubjects)[number])) return null;
  const sourceIndex = Math.max(sources.findIndex((item) => item.accountId === sourceId), 0);
  return <View className="panel finance-panel"><Text className="panel-title">我的提现</Text><Text className="panel-description">提交后将即时扣减来源账户余额；本人不能撤回申请。</Text><Button className="quiet-button" disabled={busy} onClick={() => void run(()=>load())}>刷新提现记录</Button>
    {draft === null ? <Button className="primary-button" disabled={busy} onClick={() => void run(startDraft)}>{pendingCreate.current === null ? "创建提现草稿" : "安全重试创建提现草稿"}</Button> : <>
      <Text className="field-label">提现来源</Text><Picker mode="selector" range={sources.map((source) => sourceLabel(source, sourceBalanceUnconfirmed))} value={sourceIndex} disabled={busy || pendingSubmit.current !== null || sources.length === 0} onChange={(event) => setSourceId(sources[Number(event.detail.value)]?.accountId ?? "")}><View className="picker-value"><Text>{sources.find((item) => item.accountId === sourceId) ? sourceLabel(sources.find((item) => item.accountId === sourceId)!, sourceBalanceUnconfirmed) : "请选择本人或已授权场地来源"}</Text><Text>⌄</Text></View></Picker>
      <Text className="field-label">金额 / 欢乐豆</Text><Input className="text-input" type="digit" value={amount} disabled={busy || pendingSubmit.current !== null} placeholder="例如 1000.00" onInput={(event) => setAmount(event.detail.value)} />
      <Text className="field-label">收款姓名</Text><Input className="text-input" value={recipientName} disabled={busy || pendingSubmit.current !== null} onInput={(event) => setRecipientName(event.detail.value)} />
      <Text className="field-label">收款卡号</Text><Input className="text-input" value={bankAccount} disabled={busy || pendingSubmit.current !== null} onInput={(event) => setBankAccount(event.detail.value)} />
      <Text className="field-label">开户行（可选）</Text><Input className="text-input" value={bankName} disabled={busy || pendingSubmit.current !== null} onInput={(event) => setBankName(event.detail.value)} />
      {purposes.map((item) => {
        const versions = readyVersionsFor(item.value);
        const selectedVersionId = readyVersion(item.value);
        const selectedIndex = Math.max(versions.findIndex((entry) => entry.version.versionId === selectedVersionId), 0);
        return <View className="finance-upload" key={item.value}><Text className="field-label">{item.label}</Text><Text className="panel-description">PDF、PNG 或 JPEG，最大 20 MB。</Text><Button className="quiet-button" disabled={busy || pendingSubmit.current !== null || Boolean(pendingUploads.current[item.value]?.attempted)} onClick={() => void run(() => pick(item.value))}>选择原件</Button><Button className="quiet-button" disabled={busy || pendingSubmit.current !== null || pendingUploads.current[item.value] === undefined} onClick={() => void run(() => upload(item.value))}>{pendingUploads.current[item.value]?.versionId ? `重试上传${item.label}` : `上传${item.label}`}</Button>{versions.length > 0 && <><Text className="field-label">提交版本</Text><Picker mode="selector" range={versions.map((entry) => `修订版 ${entry.version.versionNo} · ${entry.version.originalFilename}`)} value={selectedIndex} disabled={busy || pendingSubmit.current !== null} onChange={(event) => setSelectedReadyVersionIds((current) => ({ ...current, [item.value]: versions[Number(event.detail.value)]?.version.versionId ?? selectedVersionId }))}><View className="picker-value"><Text>{versions[selectedIndex] === undefined ? "请选择已上传版本" : `修订版 ${versions[selectedIndex].version.versionNo} · ${versions[selectedIndex].version.originalFilename}`}</Text><Text>⌄</Text></View></Picker></>}{selectedVersionId && <Text className="upload-ready">已选中提交版本</Text>}</View>;
      })}
      <Button className="primary-button" disabled={busy} onClick={() => void run(submit)}>{pendingSubmit.current ? "安全重试提交" : "提交提现申请"}</Button>
    </>}
    {withdrawals.length > 0 && <View className="finance-history"><Text className="field-label">我的申请记录</Text>{withdrawals.map((item) => <View className="student-row" key={item.id}><View className="student-detail"><Text className="student-name">{formatCentsAsBeans(item.amountCents)} 豆</Text><Text className="student-meta">{statusLabel[item.status] ?? item.status} · 卡号尾号 {item.bankAccountLast4}</Text></View><Button className="quiet-button student-button" disabled={busy} onClick={() => void run(async () => setDetail(await client.getWithdrawalDetail(item.id)))}>查看</Button></View>)}</View>}
    {detail !== null && <View className="finance-detail"><Text className="field-label">申请详情</Text><Text className="panel-description">{statusLabel[detail.status] ?? detail.status} · {formatCentsAsBeans(detail.amountCents)} 豆</Text>{detail.attachments.map((item) => <Button className="quiet-button" key={item.versionId} disabled={busy} onClick={() => void run(() => openAttachment(item.versionId, item.originalFilename, item.mediaType))}>打开{item.purpose === "SUPPORTING_DOCUMENT" ? "业务单据" : item.purpose === "APPLICATION_SCREENSHOT" ? "申请截图" : "原件"}</Button>)}</View>}
    {notice && <View className="notice"><Text>{notice}</Text></View>}</View>;
}
