import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiClientError, RoleSelectionRequiredError, StaleResponseError,
  type CashWageConfirmationSubmission, type ManagedCashWageRoster,
  type SessionSnapshot, type TeacherApiClient, type FinanceDocumentAttachments,
  type SalaryBenefitDocumentSubmission, type FinanceAttachmentReservationSubmission } from "@teaching-research-alliance/client";
import Taro from "@tarojs/taro";
import { View, Text, Picker, Input, Textarea, Button } from "@tarojs/components";
import { readTemporaryFileBytes, uploadFinanceAttachmentBytes } from "../../services";
import { createPickedFinanceAttachment, type PickedFinanceAttachment } from "../../finance-attachment-helpers";
const financeError = (error: unknown): string => error instanceof Error ? error.message : "操作未完成，请重试。";
type UploadCommand = { file: PickedFinanceAttachment; submission: FinanceAttachmentReservationSubmission; versionId?: string };

type Props = { client: TeacherApiClient; session: SessionSnapshot; sessionKey: string; busy?: boolean;
  onInvalidated?: () => void; onSaved?: () => void; onUnconfirmedChange?: (pending: boolean) => void };
type Phase = "idle" | "creating" | "create-unknown" | "confirming" | "confirm-unknown" | "conflict" | "reconciling";
type Purpose = "SUPPORTING_DOCUMENT" | "APPLICATION_SCREENSHOT";
const purposes: Purpose[] = ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT"];
const yuan = (value: string): string => { const n = BigInt(value); return `${n / 100n}.${(n % 100n).toString().padStart(2, "0")}`; };
const cents = (value: string): string => {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) throw new Error("金额需为非负数字，最多两位小数");
  const [a = "0", b = ""] = value.trim().split("."); return `${BigInt(a) * 100n + BigInt(b.padEnd(2, "0"))}`;
};
const authError = (error: unknown): boolean => error instanceof StaleResponseError || error instanceof RoleSelectionRequiredError || error instanceof ApiClientError && [401, 403].includes(error.status);
const definite = (error: unknown): boolean => error instanceof ApiClientError && error.status >= 400 && error.status < 500;

export function CashWageConfirmationPanel({ client, session, sessionKey, busy = false, onInvalidated, onSaved, onUnconfirmedChange }: Props): ReactNode {
  const context = session.currentRoleContext;
  const authorized = context?.scope === "GLOBAL" && context.regionId === undefined && context.campusId === undefined && context.venueId === undefined && ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"].includes(context.subject);
  const identity = `${sessionKey}:${JSON.stringify(context)}`;
  const [month, setMonth] = useState(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).format(new Date()) + "-01");
  const [roster, setRoster] = useState<ManagedCashWageRoster | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState("");
  const [cash, setCash] = useState("");
  const [deduction, setDeduction] = useState("");
  const [reason, setReason] = useState("");
  const [paid, setPaid] = useState(false);
  const [document, setDocument] = useState<{ id: string; version: number } | null>(null);
  const [attachments, setAttachments] = useState<FinanceDocumentAttachments | null>(null);
  const [ready, setReady] = useState<Partial<Record<Purpose, string>>>({});
  const [pendingUploads, setPendingUploads] = useState<Partial<Record<Purpose, boolean>>>({});
  const [uploading, setUploading] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const uploadCommands = useRef<Partial<Record<Purpose, UploadCommand>>>({});
  const generation = useRef(0);
  const documentRef = useRef<string | null>(null);
  const running = useRef(false);
  const createCommand = useRef<SalaryBenefitDocumentSubmission | null>(null);
  const confirmCommand = useRef<CashWageConfirmationSubmission | null>(null);
  const item = roster?.items.find(row => row.teacherPersonId === selected) ?? null;
  const hasPendingUpload = purposes.some(purpose => pendingUploads[purpose]);
  const locked = busy || loading || uploading || hasPendingUpload || phase !== "idle";

  const resetDraft = (): void => {
    uploadCommands.current = {}; documentRef.current = null; createCommand.current = null; confirmCommand.current = null;
    setDocument(null); setAttachments(null); setReady({}); setPendingUploads({}); setUploading(false);
    setSelected(""); setCash(""); setDeduction(""); setReason(""); setPaid(false); setPhase("idle");
  };
  const fail = (error: unknown): void => {
    if (authError(error) || client.hasRoleContext === false) {
      generation.current += 1; running.current = false; resetDraft(); setRoster(null); setLoading(false);
      setMessage("登录或身份已失效，请重新登录或选择身份。"); onInvalidated?.();
    } else setMessage(financeError(error));
  };
  const readRoster = async (token: number): Promise<void> => {
    setLoading(true);
    try { const result = await client.listManagedCashWageRoster(month); if (token === generation.current) setRoster(result); }
    catch (error) { if (token === generation.current) { setRoster(null); fail(error); } }
    finally { if (token === generation.current) setLoading(false); }
  };
  useEffect(() => {
    const token = ++generation.current; running.current = false; resetDraft(); setRoster(null); setMessage(""); setLoading(false);
    if (authorized) void readRoster(token);
    return () => { generation.current += 1; running.current = false; };
  }, [client, identity, month, authorized]);
  useEffect(() => {
    onUnconfirmedChange?.(phase !== "idle" || uploading || hasPendingUpload);
    return () => onUnconfirmedChange?.(false);
  }, [phase, uploading, hasPendingUpload, onUnconfirmedChange]);

  const readAttachments = async (id: string, token: number): Promise<void> => {
    const result = await client.listFinanceDocumentAttachments(id);
    if (generation.current === token && documentRef.current === id) {
      if (result.documentId !== id) throw new Error("附件所属单据不匹配，请重新读取。");
      setAttachments(result);
    }
  };
  const createDocument = async (): Promise<void> => {
    if (running.current || busy || !item || documentRef.current !== null || !["idle", "create-unknown"].includes(phase)) return;
    const token = generation.current; running.current = true;
    try {
      const submission = createCommand.current ?? client.createSalaryBenefitDocumentSubmission({ kind: "CASH_WAGE" });
      createCommand.current = submission; setPhase("creating");
      const result = await client.createSalaryBenefitDocument(submission);
      if (token !== generation.current) return;
      createCommand.current = null; documentRef.current = result.id; setDocument({ id: result.id, version: result.version }); setReady({}); setPhase("idle");
      try { await readAttachments(result.id, token); } catch (error) { if (token === generation.current) fail(error); }
    } catch (error) {
      if (token !== generation.current) return;
      if (authError(error)) fail(error);
      else if (definite(error) || createCommand.current === null) { createCommand.current = null; setPhase("idle"); fail(error); }
      else { setPhase("create-unknown"); fail(error); }
    } finally { if (token === generation.current) running.current = false; }
  };
  const upload = async (purpose: Purpose): Promise<void> => {
    const id = documentRef.current;
    if (!id || running.current || busy || phase !== "idle" || purposes.some(other => other !== purpose && pendingUploads[other])) return;
    const originalSession = client.currentSession;
    if (!originalSession) { fail(new ApiClientError(401, "UNAUTHENTICATED")); return; }
    const token = generation.current; running.current = true; setUploading(true);
    const active = (): boolean => {
      if (generation.current !== token || documentRef.current !== id) return false;
      if (client.currentSession !== originalSession) throw new StaleResponseError();
      return true;
    };
    let command = uploadCommands.current[purpose];
    try {
      if (!command) {
        const choice = await Taro.showActionSheet({ itemList: ["选择原始图片", "选择 PDF 文件"] });
        if (!active()) return;
        let path = "", name = "";
        if (choice.tapIndex === 0) {
          const picked = await Taro.chooseImage({ count: 1, sizeType: ["original"], sourceType: ["album", "camera"] });
          path = picked.tempFilePaths[0] ?? ""; name = `${purpose.toLowerCase()}.image`;
        } else {
          const picked = await Taro.chooseMessageFile({ count: 1, type: "file", extension: ["pdf"] });
          path = picked.tempFiles[0]?.path ?? ""; name = picked.tempFiles[0]?.name ?? "";
        }
        if (!active()) return;
        const bytes = await readTemporaryFileBytes(path);
        if (!active()) return;
        const file = createPickedFinanceAttachment(name, path, bytes);
        const submission = client.createFinanceAttachmentReservationSubmission({ documentId: id, purpose, originalFilename: file.name, declaredMediaType: file.mediaType, declaredSizeBytes: file.bytes.byteLength });
        command = { file, submission }; uploadCommands.current[purpose] = command;
        setPendingUploads(current => ({ ...current, [purpose]: true }));
      }
      if (!command.versionId) {
        const reservation = await client.reserveFinanceAttachment(command.submission);
        if (!active()) return;
        command.versionId = reservation.versionId;
      }
      let metadata = await client.getOwnFinanceAttachmentVersion(command.versionId);
      if (!active()) return;
      if (metadata.status === "FAILED") {
        delete uploadCommands.current[purpose]; setPendingUploads(current => ({ ...current, [purpose]: false }));
        setMessage("原件未通过校验，请重新选择正确文件。"); return;
      }
      if (metadata.status !== "READY") {
        const current = client.currentSession;
        if (!current) throw new ApiClientError(401, "UNAUTHENTICATED");
        const result = await uploadFinanceAttachmentBytes(current, command.versionId, command.file.mediaType, command.file.bytes);
        if (!active()) return;
        if (client.currentSession !== current) throw new StaleResponseError();
        if (result.status === 401 || result.status === 403) { client.logout(); throw new RoleSelectionRequiredError("FORBIDDEN_SCOPE"); }
        if (result.status < 200 || result.status >= 300) throw new Error("上传结果未确认，请使用原文件安全重试。");
        metadata = result.metadata ?? await client.getOwnFinanceAttachmentVersion(command.versionId);
        if (!active()) return;
      }
      if (metadata.status === "FAILED") {
        delete uploadCommands.current[purpose]; setPendingUploads(current => ({ ...current, [purpose]: false }));
        setMessage("原件未通过校验，请重新选择正确文件。"); return;
      }
      if (metadata.status !== "READY") throw new Error("上传结果未确认，请使用原文件安全重试。");
      const list = await client.listFinanceDocumentAttachments(id);
      if (!active()) return;
      const versionId = command.versionId;
      if (list.documentId !== id || !list.attachments.some(slot => slot.purpose === purpose && slot.versions.some(version => version.versionId === versionId && version.status === "READY"))) throw new Error("原件列表尚未确认，请安全重试读取。");
      setAttachments(list); setReady(current => ({ ...current, [purpose]: versionId }));
      delete uploadCommands.current[purpose]; setPendingUploads(current => ({ ...current, [purpose]: false })); setMessage("原件已完整上传。");
    } catch (error) {
      if (generation.current !== token || documentRef.current !== id) return;
      if (command && !command.versionId && definite(error) && !authError(error)) {
        delete uploadCommands.current[purpose]; setPendingUploads(current => ({ ...current, [purpose]: false }));
      }
      fail(error);
    } finally { if (token === generation.current) { running.current = false; setUploading(false); } }
  };
  const confirm = async (): Promise<void> => {
    if (running.current || busy || loading || uploading || hasPendingUpload || !["idle", "confirm-unknown"].includes(phase)) return;
    const token = generation.current;
    let submission = confirmCommand.current;
    if (submission === null) {
      try {
        if (!item?.todo || !paid || !document || attachments?.documentId !== document.id) throw new Error("请选择老师、确认现金已发放，并读取当前凭证附件。");
        const ids = purposes.map(purpose => {
          const id = ready[purpose];
          if (!id || !attachments.attachments.some(slot => slot.purpose === purpose && slot.versions.some(version => version.versionId === id && version.status === "READY"))) throw new Error("请上传并选用两份 READY 原件。");
          return id;
        });
        const cashCents = cents(cash), deductionCents = cents(deduction);
        if (cashCents !== deductionCents || !reason.trim()) throw new Error("现金与扣豆必须等额，并填写理由。");
        submission = client.createCashWageConfirmationSubmission({ documentId: document.id, expectedVersion: document.version, todoId: item.todo.id, cashPaidCents: cashCents, deductionCents, reason: reason.trim(), attachmentVersionIds: ids });
      } catch (error) { setMessage(error instanceof Error ? error.message : "请核对输入。"); return; }
      confirmCommand.current = submission;
    }
    running.current = true; setPhase("confirming");
    try {
      await client.confirmCashWage(submission);
      if (token !== generation.current) return;
      const next = ++generation.current; running.current = false; resetDraft(); setRoster(null);
      setMessage("已记录现金工资确认；系统仅扣老师个人欢乐豆，不执行银行转账。"); onSaved?.(); await readRoster(next);
    } catch (error) {
      if (token !== generation.current) return;
      if (authError(error)) fail(error);
      else if (error instanceof ApiClientError && error.status === 409) { confirmCommand.current = null; setPhase("conflict"); setMessage("记录状态已发生变化，请重新读取并核对；核对后需要重新创建凭证。"); }
      else if (definite(error)) { confirmCommand.current = null; setPhase("idle"); fail(error); }
      else { setPhase("confirm-unknown"); fail(error); }
    } finally { if (token === generation.current) running.current = false; }
  };
  const reconcile = async (): Promise<void> => {
    if (running.current || phase !== "conflict") return;
    const token = generation.current; running.current = true; setPhase("reconciling");
    try {
      const latest = await client.listManagedCashWageRoster(month);
      if (token !== generation.current) return;
      generation.current += 1; running.current = false; resetDraft(); setRoster(latest);
      setMessage("最新待办已读取，请重新选择老师、核对金额并创建凭证。");
    } catch (error) { if (token === generation.current) { setPhase("conflict"); fail(error); } }
    finally { if (token === generation.current) running.current = false; }
  };
  if (!authorized) return <View className="panel"><Text>当前身份没有确认现金工资的权限。</Text></View>;
  const teachers = roster?.items.filter(row => row.todo !== null) ?? [];
  return <View className="panel"><Text className="panel-title">现金工资确认</Text>
    <Text>工资月</Text><Picker mode="date" fields="month" value={month.slice(0, 7)} disabled={locked} onChange={event => setMonth(`${event.detail.value}-01`)}><View><Text>{month.slice(0, 7)}</Text></View></Picker>
    {loading && <Text>正在读取工资待办…</Text>}
    {!loading && roster === null && <Button onClick={() => void readRoster(generation.current)}>重新读取工资待办</Button>}
    {roster !== null && <><Text>老师</Text><Picker mode="selector" range={teachers.map(row => row.teacherDisplayName)} disabled={locked} onChange={event => {
      generation.current += 1; running.current = false; resetDraft(); setSelected(teachers[Number(event.detail.value)]?.teacherPersonId ?? ""); setMessage("");
    }}><View><Text>{item?.teacherDisplayName ?? "请选择有待办的老师"}</Text></View></Picker>
    {item && <><Text>计划现金 {yuan(item.plan.plannedCashCents)} 元；已确认 {yuan(item.confirmedCashCents)} 元；剩余 {yuan(item.remainingCashCents)} 元。</Text>
      <Text>实际现金（元）</Text><Input placeholder="实际现金（元）" value={cash} disabled={locked} onInput={event => setCash(event.detail.value)} />
      <Text>扣豆（欢乐豆）</Text><Input placeholder="扣豆（欢乐豆）" value={deduction} disabled={locked} onInput={event => setDeduction(event.detail.value)} />
      <Button disabled={locked} onClick={() => setPaid(!paid)}>{paid ? "已确认现金线下发放" : "确认现金已线下发放"}</Button>
      <Text>理由</Text><Textarea placeholder="理由" value={reason} disabled={locked} onInput={event => setReason(event.detail.value)} />
      {document === null ? <Button disabled={busy || !["idle", "create-unknown"].includes(phase)} onClick={() => void createDocument()}>{phase === "create-unknown" ? "安全重试创建凭证" : "创建工资确认凭证"}</Button> : <>
        {purposes.map(purpose => <Button key={`${document.id}:${purpose}`} disabled={busy || uploading || phase !== "idle" || purposes.some(other => other !== purpose && pendingUploads[other])} onClick={() => void upload(purpose)}>
          {pendingUploads[purpose] ? "安全重试上传" : "选择并上传"}{purpose === "SUPPORTING_DOCUMENT" ? "工资发放凭证" : "工资确认截图"}
        </Button>)}
        {attachments === null && <Button disabled={locked} onClick={() => { const current = generation.current; void readAttachments(document.id, current).catch(error => { if (current === generation.current) fail(error); }); }}>重新读取凭证附件</Button>}
        {["conflict", "reconciling"].includes(phase) ? <Button disabled={phase === "reconciling" || busy} onClick={() => void reconcile()}>重新读取并核对</Button> : <Button disabled={busy || loading || uploading || hasPendingUpload || !["idle", "confirm-unknown"].includes(phase)} onClick={() => void confirm()}>{phase === "confirm-unknown" ? "安全重试原确认" : "确认现金已发放并记录扣豆"}</Button>}
      </>}
    </>}
    </>}
    {message && <Text>{message}</Text>}
  </View>;
}
