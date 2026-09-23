import { useEffect, useRef, useState, type ReactNode } from "react";
import Taro from "@tarojs/taro";
import { View, Text, Picker, Textarea, Button } from "@tarojs/components";
import {
  ApiClientError, RoleSelectionRequiredError, StaleResponseError,
  formatCentsAsBeans,
  type BenefitConfirmationSubmission, type FinanceDocumentAttachments,
  type ManagedBenefitRoster, type SessionSnapshot, type TeacherApiClient,
} from "@teaching-research-alliance/client";
import { readTemporaryFileBytes, uploadFinanceAttachmentBytes } from "../../services";
import { createPickedFinanceAttachment, type PickedFinanceAttachment } from "../../finance-attachment-helpers";

type Purpose = "SUPPORTING_DOCUMENT" | "APPLICATION_SCREENSHOT";
const purposes: Purpose[] = ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT"];
type UploadCommand = { file: PickedFinanceAttachment; submission: ReturnType<TeacherApiClient["createFinanceAttachmentReservationSubmission"]>; versionId?: string };
type Phase = "idle" | "generating" | "generate-unknown" | "creating" | "create-unknown" | "confirming" | "confirm-unknown" | "conflict" | "reconciling";
type Props = { client: TeacherApiClient; session: SessionSnapshot; sessionKey: string; busy?: boolean; onInvalidated?: () => void; onSaved?: () => void; onUnconfirmedChange?: (pending: boolean) => void };

const authorized = (session: SessionSnapshot): boolean => {
  const c = session.currentRoleContext;
  return c?.scope === "GLOBAL" && c.regionId === undefined && c.campusId === undefined && c.venueId === undefined && ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"].includes(c.subject);
};
const authError = (e: unknown): boolean => e instanceof StaleResponseError || e instanceof RoleSelectionRequiredError || e instanceof ApiClientError && [401, 403].includes(e.status);
const definite = (e: unknown): boolean => e instanceof ApiClientError && e.status >= 400 && e.status < 500;
const monthNow = (): string => { const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).formatToParts(new Date()); return `${p.find(x => x.type === "year")?.value ?? "2026"}-${p.find(x => x.type === "month")?.value ?? "01"}-01`; };

export function BenefitConfirmationPanel({ client, session, sessionKey, busy = false, onInvalidated, onSaved, onUnconfirmedChange }: Props): ReactNode {
  const [month, setMonth] = useState(monthNow);
  const [roster, setRoster] = useState<ManagedBenefitRoster | null>(null);
  const [selected, setSelected] = useState("");
  const [document, setDocument] = useState<{ id: string; version: number } | null>(null);
  const [attachments, setAttachments] = useState<FinanceDocumentAttachments | null>(null);
  const [ready, setReady] = useState<Partial<Record<Purpose, string>>>({});
  const [pendingUploads, setPendingUploads] = useState<Partial<Record<Purpose, boolean>>>({});
  const [checked, setChecked] = useState(false);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [writeSuccess, setWriteSuccess] = useState("");
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [criticalRefresh, setCriticalRefresh] = useState(false);
  const [rosterReadFailed, setRosterReadFailed] = useState(false);
  const generation = useRef(0); const running = useRef(false); const refreshLock = useRef(false);
  const createCommand = useRef<ReturnType<TeacherApiClient["createSalaryBenefitDocumentSubmission"]> | null>(null);
  const confirmCommand = useRef<BenefitConfirmationSubmission | null>(null);
  const generateCommand = useRef<ReturnType<TeacherApiClient["createBenefitTodoGenerationSubmission"]> | null>(null);
  const uploadCommands = useRef<Partial<Record<Purpose, UploadCommand>>>({});
  const documentRef = useRef<string | null>(null);
  const context = session.currentRoleContext;
  const identity = [sessionKey, session.sessionId, session.personId, context?.subject, context?.scope, context?.regionId, context?.campusId, context?.venueId].join("|");
  const canRead = authorized(session);
  const actionable = roster?.items.filter(x => x.status === "PENDING" && x.todo !== null && x.execution === null) ?? [];
  const item = actionable.find(x => `${x.beneficiaryPersonId}:${x.benefitKind}` === selected) ?? null;
  const frozenPlan = item?.todo ? item.planVersions.find(plan => plan.id === item.todo?.planVersionId) ?? null : null;
  const hasPendingUpload = purposes.some(p => pendingUploads[p]);
  const navLocked = busy || loading || uploading || refreshFailed || phase !== "idle" || document !== null;
  const formLocked = busy || loading || uploading || phase !== "idle" || document !== null;

  const resetDraft = (): void => { documentRef.current = null; createCommand.current = null; confirmCommand.current = null; generateCommand.current = null; uploadCommands.current = {}; setDocument(null); setAttachments(null); setReady({}); setPendingUploads({}); setChecked(false); setReason(""); setPhase("idle"); };
  const invalidate = (e: unknown): void => { if (authError(e) || client.hasRoleContext === false) { generation.current++; running.current = false; resetDraft(); setRoster(null); setLoading(false); setUploading(false); setCriticalRefresh(false); setRefreshFailed(false); setRosterReadFailed(false); setWriteSuccess(""); setMessage("登录或身份已失效，请重新登录或选择身份。"); onInvalidated?.(); } else setMessage(e instanceof Error ? e.message : "操作未完成，请重试。"); };
  const readRoster = async (token = generation.current): Promise<boolean> => { if (!canRead) return false; const requestSession = client.currentSession; setLoading(true); try { if (client.hasRoleContext === false) throw new ApiClientError(401, "AUTH"); const r = await client.listManagedBenefitRoster(month); if (requestSession && client.currentSession !== requestSession) throw new StaleResponseError(); if (token === generation.current) { setRoster(r); setRosterReadFailed(false); return true; } return false; } catch (e) { if (token === generation.current) { setRoster(null); setRosterReadFailed(true); invalidate(e); } return false; } finally { if (token === generation.current) setLoading(false); } };
  useEffect(() => { generation.current++; running.current = false; resetDraft(); setRoster(null); setSelected(""); setMessage(""); setWriteSuccess(""); setRefreshFailed(false); setCriticalRefresh(false); setRosterReadFailed(false); if (canRead) void readRoster(generation.current); return () => { generation.current++; running.current = false; }; }, [client, identity, month, canRead]);
  useEffect(() => { onUnconfirmedChange?.(phase !== "idle" || uploading || hasPendingUpload || document !== null || criticalRefresh || refreshFailed); return () => onUnconfirmedChange?.(false); }, [phase, uploading, hasPendingUpload, document, criticalRefresh, refreshFailed, onUnconfirmedChange]);

  const generate = async (): Promise<void> => { if (running.current || busy || refreshFailed || documentRef.current || month !== monthNow() || !["idle", "generate-unknown"].includes(phase)) return; const token = generation.current; const requestSession = client.currentSession; running.current = true; try { const sub = generateCommand.current ?? client.createBenefitTodoGenerationSubmission(); generateCommand.current = sub; setPhase("generating"); await client.generateBenefitTodos(sub); if (requestSession && client.currentSession !== requestSession) throw new StaleResponseError(); if (token !== generation.current) return; generateCommand.current = null; setPhase("idle"); setRoster(null); setWriteSuccess("已生成今日到期福利待办；本次不扣豆。"); setRefreshFailed(false); setCriticalRefresh(true); onSaved?.(); if (!await readRoster(token)) setRefreshFailed(true); } catch (e) { if (token !== generation.current) return; if (authError(e)) invalidate(e); else if (definite(e)) { generateCommand.current = null; setPhase("idle"); invalidate(e); } else { setPhase("generate-unknown"); setMessage("生成结果未确认，请使用原提交安全重试。"); } } finally { if (token === generation.current) { running.current = false; setCriticalRefresh(false); } } };
  const readAttachments = async (id: string, token: number): Promise<void> => { const requestSession = client.currentSession; const r = await client.listFinanceDocumentAttachments(id); if (requestSession && client.currentSession !== requestSession) throw new StaleResponseError(); if (token !== generation.current || documentRef.current !== id) return; if (r.documentId !== id) throw new Error("附件所属单据不匹配"); setAttachments(r); };
  const createDocument = async (): Promise<void> => { if (running.current || busy || !item || !frozenPlan || documentRef.current || !["idle", "create-unknown"].includes(phase)) return; const token = generation.current; const requestSession = client.currentSession; running.current = true; setPhase("creating"); try { const sub = createCommand.current ?? client.createSalaryBenefitDocumentSubmission({ kind: "FINANCE_BENEFIT" }); createCommand.current = sub; const r = await client.createSalaryBenefitDocument(sub); if (requestSession && client.currentSession !== requestSession) throw new StaleResponseError(); if (token !== generation.current) return; createCommand.current = null; documentRef.current = r.id; setDocument({ id: r.id, version: r.version }); setPhase("idle"); try { await readAttachments(r.id, token); } catch (e) { if (token === generation.current && authError(e)) invalidate(e); else if (token === generation.current) setMessage("单据已创建，但附件读取失败，可重试读取。"); } } catch (e) { if (token !== generation.current) return; if (authError(e)) invalidate(e); else if (definite(e)) { createCommand.current = null; setPhase("idle"); invalidate(e); } else { setPhase("create-unknown"); setMessage("单据创建结果未确认，请使用原提交安全重试。"); } } finally { if (token === generation.current) running.current = false; } };
  const upload = async (purpose: Purpose): Promise<void> => {
    const id = documentRef.current; if (!id || running.current || busy || phase !== "idle") return; const original = client.currentSession; if (!original) { invalidate(new ApiClientError(401, "AUTH")); return; }
    const token = generation.current; running.current = true; setUploading(true); let command = uploadCommands.current[purpose]; const active = (): boolean => { if (token !== generation.current || documentRef.current !== id) return false; if (client.currentSession !== original) throw new StaleResponseError(); return true; };
    try { if (!command) { const choice = await Taro.showActionSheet({ itemList: ["选择原始图片", "选择 PDF 文件"] }); if (!active()) return; let path = "", name = ""; if (choice.tapIndex === 0) { const r = await Taro.chooseImage({ count: 1, sizeType: ["original"], sourceType: ["album", "camera"] }); path = r.tempFilePaths[0] ?? ""; name = `${purpose}.image`; } else { const r = await Taro.chooseMessageFile({ count: 1, type: "file", extension: ["pdf"] }); path = r.tempFiles[0]?.path ?? ""; name = r.tempFiles[0]?.name ?? ""; } if (!active()) return; const bytes = await readTemporaryFileBytes(path); if (!active()) return; const file = createPickedFinanceAttachment(name, path, bytes); const submission = client.createFinanceAttachmentReservationSubmission({ documentId: id, purpose, originalFilename: file.name, declaredMediaType: file.mediaType, declaredSizeBytes: file.bytes.byteLength }); command = { file, submission }; uploadCommands.current[purpose] = command; setPendingUploads(v => ({ ...v, [purpose]: true })); }
      if (!command.versionId) { const r = await client.reserveFinanceAttachment(command.submission); if (!active()) return; command.versionId = r.versionId; } let meta = await client.getOwnFinanceAttachmentVersion(command.versionId); if (!active()) return; if (meta.status === "FAILED") { delete uploadCommands.current[purpose]; setPendingUploads(v => ({ ...v, [purpose]: false })); setMessage("原件未通过校验，请重新选择正确文件。"); return; } if (meta.status !== "READY") { const r = await uploadFinanceAttachmentBytes(original, command.versionId, command.file.mediaType, command.file.bytes); if (!active()) return; if (r.status === 401 || r.status === 403) throw new RoleSelectionRequiredError("FORBIDDEN_SCOPE"); if (r.status < 200 || r.status >= 300) throw new Error("上传结果未确认"); meta = r.metadata ?? await client.getOwnFinanceAttachmentVersion(command.versionId); if (!active()) return; } if (meta.status === "FAILED") { delete uploadCommands.current[purpose]; setPendingUploads(v => ({ ...v, [purpose]: false })); setMessage("原件未通过校验，请重新选择正确文件。"); return; } if (meta.status !== "READY") throw new Error("上传结果未确认，请使用原文件安全重试"); const list = await client.listFinanceDocumentAttachments(id); if (!active()) return; if (list.documentId !== id || !list.attachments.some(s => s.purpose === purpose && s.versions.some(v => v.versionId === command?.versionId && v.status === "READY"))) throw new Error("原件列表尚未确认"); setAttachments(list); setReady(v => ({ ...v, [purpose]: command?.versionId })); delete uploadCommands.current[purpose]; setPendingUploads(v => ({ ...v, [purpose]: false })); setMessage("原件已完整上传。");
    } catch (e) { if (token === generation.current && documentRef.current === id) { if (command && !command.versionId && definite(e) && !authError(e)) { delete uploadCommands.current[purpose]; setPendingUploads(v => ({ ...v, [purpose]: false })); } invalidate(e); } } finally { if (token === generation.current) { running.current = false; setUploading(false); } }
  };
  const confirm = async (): Promise<void> => { if (running.current || busy || loading || uploading || hasPendingUpload || !item || !frozenPlan || !document || !["idle", "confirm-unknown"].includes(phase)) return; const token = generation.current; const requestSession = client.currentSession; let sub = confirmCommand.current; try { if (!item.todo || !checked || !reason.trim() || !attachments || attachments.documentId !== document.id) throw new Error("请填写理由，并核对对象、计划、账户和两份 READY 原件。"); const ids = purposes.map(p => { const id = ready[p]; if (!id || !attachments.attachments.some(s => s.purpose === p && s.versions.some(v => v.versionId === id && v.status === "READY"))) throw new Error("请上传并选用两份 READY 原件。"); return id; }); sub = sub ?? client.createBenefitConfirmationSubmission({ documentId: document.id, expectedVersion: document.version, todoId: item.todo.id, expectedPlanVersionId: item.currentPlan.id, reason: reason.trim(), attachmentVersionIds: ids }); confirmCommand.current = sub; } catch (e) { if (authError(e)) invalidate(e); else setMessage(e instanceof Error ? e.message : "请核对输入。"); return; } running.current = true; setPhase("confirming"); try { await client.confirmBenefit(sub); if (requestSession && client.currentSession !== requestSession) throw new StaleResponseError(); if (token !== generation.current) return; const next = ++generation.current; resetDraft(); setRoster(null); setWriteSuccess("福利已确认；仅扣财务职务账户，不扣受益人个人账户。"); setRefreshFailed(false); setCriticalRefresh(true); onSaved?.(); running.current = false; if (!await readRoster(next)) setRefreshFailed(true); if (next === generation.current) setCriticalRefresh(false); } catch (e) { if (token !== generation.current) return; if (authError(e)) invalidate(e); else if (e instanceof ApiClientError && e.status === 409) { confirmCommand.current = null; setRoster(null); setSelected(""); setPhase("conflict"); setMessage("福利计划版本已变化，请重新读取并人工核对；需重新创建单据和原件。"); } else if (definite(e)) { confirmCommand.current = null; setPhase("idle"); invalidate(e); } else { setPhase("confirm-unknown"); setMessage("确认结果未确认，请使用原提交安全重试。"); } } finally { if (token === generation.current) { running.current = false; setCriticalRefresh(false); } } };
  const reconcile = async (): Promise<void> => { if (running.current || phase !== "conflict" || refreshLock.current) return; const token = generation.current; const requestSession = client.currentSession; running.current = true; refreshLock.current = true; setPhase("reconciling"); try { const r = await client.listManagedBenefitRoster(month); if (requestSession && client.currentSession !== requestSession) throw new StaleResponseError(); if (token !== generation.current) return; generation.current++; resetDraft(); setRoster(r); setSelected(""); setMessage("最新待办已读取，请重新选择并核对后创建新单据。"); } catch (e) { if (token === generation.current) { setPhase("conflict"); invalidate(e); } } finally { refreshLock.current = false; running.current = false; } };
  const retryLatest = async (): Promise<void> => { if (loading || criticalRefresh || refreshLock.current) return; const token = generation.current; refreshLock.current = true; setRefreshFailed(false); setCriticalRefresh(true); const refreshed = await readRoster(token); if (token === generation.current) { if (!refreshed) setRefreshFailed(true); setCriticalRefresh(false); } refreshLock.current = false; };
  const retryInitialRoster = async (): Promise<void> => { if (loading || refreshLock.current) return; const token = generation.current; refreshLock.current = true; setRosterReadFailed(false); await readRoster(token); refreshLock.current = false; };
  const retryAttachments = async (): Promise<void> => { const id = documentRef.current; const token = generation.current; if (!id || loading || uploading) return; try { await readAttachments(id, token); } catch (e) { if (token === generation.current && documentRef.current === id) invalidate(e); } };
  if (!canRead) return <View className="panel"><Text>当前身份没有福利确认权限。</Text></View>;
  return <View className="panel">
    <Text className="panel-title">福利待办确认</Text><Text>福利月</Text>
    <Picker mode="date" fields="month" value={month.slice(0, 7)} disabled={navLocked} onChange={e => setMonth(`${e.detail.value}-01`)}><View><Text>{month.slice(0, 7)}</Text></View></Picker>
    <Button disabled={busy || loading || uploading || refreshFailed || document !== null || month !== monthNow() || ["generating", "creating", "confirming", "conflict", "reconciling"].includes(phase)} onClick={() => void generate()}>{phase === "generate-unknown" ? "安全重试生成待办" : "生成今日到期福利待办（不扣豆）"}</Button>
    {month !== monthNow() && <Text>仅可生成北京时间当前月的到期待办；历史月仅可读取和核对。</Text>}
    {loading && <Text>正在读取福利待办…</Text>}
    {roster && <>
      <Text>待确认对象</Text>
      <Picker mode="selector" range={actionable.map(x => `${x.beneficiaryDisplayName} · ${x.benefitKind === "SOCIAL_INSURANCE" ? "医社保" : "公积金"}`)} disabled={navLocked} onChange={e => { resetDraft(); const next = actionable[Number(e.detail.value)]; setSelected(next ? `${next.beneficiaryPersonId}:${next.benefitKind}` : ""); }}><View><Text>{item?.beneficiaryDisplayName ?? "请选择待确认对象"}</Text></View></Picker>
      {item?.todo && <>
        <Text>待办冻结计划：v{frozenPlan?.version ?? "?"} · {formatCentsAsBeans(frozenPlan?.amountCents ?? "0")} 欢乐豆 · 账户 {frozenPlan?.sourceFund.displayName ?? "未知"}</Text>
        <Text>当前执行计划：v{item.currentPlan.version} · {formatCentsAsBeans(item.currentPlan.amountCents)} 欢乐豆 · 账户 {item.currentPlan.sourceFund.displayName}</Text>
        {frozenPlan === null && <Text>待办冻结计划缺失，不能创建或确认，请人工核对后重新读取。</Text>}
        {item.todo.planVersionId !== item.currentPlan.id && <Text>计划已变化：本次按当前版本执行。</Text>}
        <Button disabled={formLocked} onClick={() => setChecked(!checked)}>{checked ? "已核对对象、金额、账户和两份原件" : "核对对象、金额、账户和两份原件"}</Button>
        <Textarea placeholder="确认理由（必填）" value={reason} disabled={formLocked} onInput={e => setReason(e.detail.value)} />
        {document === null ? <Button disabled={busy || frozenPlan === null || !["idle", "create-unknown"].includes(phase)} onClick={() => void createDocument()}>{phase === "create-unknown" ? "安全重试创建凭证" : "创建福利确认凭证"}</Button> : <>
          {purposes.map(p => <Button key={p} disabled={busy || uploading && !pendingUploads[p] || phase !== "idle" || purposes.some(other => other !== p && pendingUploads[other])} onClick={() => void upload(p)}>{pendingUploads[p] ? "安全重试上传" : "选择并上传"}{p === "SUPPORTING_DOCUMENT" ? "福利原始凭证" : "福利确认截图"}</Button>)}
          {attachments === null && <Button disabled={busy || loading || uploading || phase !== "idle"} onClick={() => void retryAttachments()}>重新读取凭证附件</Button>}
          <Button disabled={busy || loading || uploading || hasPendingUpload || ["creating", "confirming", "conflict", "reconciling"].includes(phase) || !checked} onClick={() => void confirm()}>{phase === "confirm-unknown" ? "安全重试原确认" : "确认福利并扣财务职务账户"}</Button>
        </>}
      </>}
    </>}
    {(phase === "conflict" || phase === "reconciling") && <Button disabled={phase === "reconciling"} onClick={() => void reconcile()}>重新读取并核对</Button>}
    {writeSuccess && <Text>{writeSuccess}</Text>}
    {message && <Text>{message}</Text>}
    {rosterReadFailed && !refreshFailed && <Button disabled={loading} onClick={() => void retryInitialRoster()}>重新读取福利待办</Button>}
    {refreshFailed && <Button disabled={loading || criticalRefresh} onClick={() => void retryLatest()}>重试读取最新待办</Button>}
  </View>;
}
