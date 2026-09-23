import { useEffect, useRef, useState, type ReactNode } from "react";
import Taro from "@tarojs/taro";
import { Button, Input, Picker, Text, Textarea, View } from "@tarojs/components";
import {
  ApiClientError,
  RoleSelectionRequiredError,
  StaleResponseError,
  type BonusGrantSubmission,
  type BonusProjectCatalog,
  type FinanceDocumentAttachments,
  type FinanceAttachmentReservationSubmission,
  type SalaryBenefitDocumentSubmission,
  type SessionSnapshot,
  type TeacherApiClient,
} from "@teaching-research-alliance/client";
import { readTemporaryFileBytes, uploadFinanceAttachmentBytes } from "../../services";
import { createPickedFinanceAttachment, type PickedFinanceAttachment } from "../../finance-attachment-helpers";

type Purpose = "SUPPORTING_DOCUMENT" | "APPLICATION_SCREENSHOT";
const purposes: readonly Purpose[] = ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT"];
type UploadCommand = Readonly<{
  file: PickedFinanceAttachment;
  submission: FinanceAttachmentReservationSubmission;
  versionId?: string;
}>;
type Phase = "idle" | "creating" | "create-unknown" | "granting" | "grant-unknown" | "refreshing-directories" | "document-conflict";
type Props = Readonly<{
  client: TeacherApiClient;
  session: SessionSnapshot;
  sessionKey: string;
  busy?: boolean;
  onInvalidated?: () => void;
  onSaved?: () => void;
  onUnconfirmedChange?: (pending: boolean) => void;
}>;

const strictGlobalFinance = (session: SessionSnapshot): boolean => {
  const context = session.currentRoleContext;
  return context !== null
    && context.scope === "GLOBAL"
    && context.regionId === undefined
    && context.campusId === undefined
    && context.venueId === undefined
    && ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"].includes(context.subject);
};
const authError = (error: unknown): boolean =>
  error instanceof StaleResponseError
  || error instanceof RoleSelectionRequiredError
  || (error instanceof ApiClientError && [401, 403].includes(error.status));
const definiteClientError = (error: unknown): boolean =>
  error instanceof ApiClientError && error.status >= 400 && error.status < 500;
const projectCatalogConflict = (error: unknown): boolean =>
  error instanceof ApiClientError && error.status === 409 && error.code === "BONUS_PROJECT_VERSION_CONFLICT";
const documentConflict = (error: unknown): boolean =>
  error instanceof ApiClientError && error.status === 409 && ["VERSION_CONFLICT", "SALARY_BENEFIT_STATE_CONFLICT"].includes(error.code);
const sourceFundConflict = (error: unknown): boolean =>
  error instanceof ApiClientError && error.status === 409 && ["COMPANY_FUND_INACTIVE", "COMPANY_FUND_ASSIGNMENT_NOT_FOUND"].includes(error.code);
const grantErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof ApiClientError && ["PERSONAL_ACCOUNT_NOT_FOUND", "PERSON_NOT_FOUND"].includes(error.code)
    ? "该收款成员当前不可用，请选择其他收款成员后再确认发放。"
    : error instanceof Error && error.message ? error.message : fallback;
const cents = (value: string): string => {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) throw new Error("奖金金额需为正数，最多两位小数。");
  const [whole = "0", fraction = ""] = trimmed.split(".");
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (result <= 0n) throw new Error("奖金金额必须大于 0。");
  return result.toString();
};
const purposeLabel = (purpose: Purpose): string =>
  purpose === "SUPPORTING_DOCUMENT" ? "奖金发放凭证" : "奖金发放截图";

/** F09: one evidenced, immutable project-bonus command. It never presents a wage or bank-payment flow. */
export function ProjectBonusGrantPanel({
  client,
  session,
  sessionKey,
  busy = false,
  onInvalidated,
  onSaved,
  onUnconfirmedChange,
}: Props): ReactNode {
  const [projects, setProjects] = useState<readonly BonusProjectCatalog["projects"][number][] | null>(null);
  const [funds, setFunds] = useState<readonly { fundId: string; code: string; displayName: string }[] | null>(null);
  const [members, setMembers] = useState<readonly { id: string; nickname: string }[] | null>(null);
  const [selectedProjectNo, setSelectedProjectNo] = useState("");
  const [selectedFundId, setSelectedFundId] = useState("");
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [document, setDocument] = useState<Readonly<{ id: string; version: number }> | null>(null);
  const [attachments, setAttachments] = useState<FinanceDocumentAttachments | null>(null);
  const [ready, setReady] = useState<Partial<Record<Purpose, string>>>({});
  const [pendingUploads, setPendingUploads] = useState<Partial<Record<Purpose, boolean>>>({});
  const [phase, setPhase] = useState<Phase>("idle");
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [projectRefreshPending, setProjectRefreshPending] = useState(false);
  const [projectReselectionRequired, setProjectReselectionRequired] = useState(false);
  const [fundRefreshPending, setFundRefreshPending] = useState(false);
  const [fundReselectionRequired, setFundReselectionRequired] = useState(false);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const running = useRef(false);
  const documentRef = useRef<string | null>(null);
  const createCommand = useRef<SalaryBenefitDocumentSubmission | null>(null);
  const grantCommand = useRef<BonusGrantSubmission | null>(null);
  const uploadCommands = useRef<Partial<Record<Purpose, UploadCommand>>>({});
  const authorized = strictGlobalFinance(session);
  const context = session.currentRoleContext;
  const identity = [sessionKey, session.sessionId, session.personId, context?.subject, context?.scope, context?.regionId, context?.campusId, context?.venueId].join("|");
  const selectedProject = projects?.find((item) => String(item.projectNo) === selectedProjectNo) ?? null;
  const selectedFund = funds?.find((item) => item.fundId === selectedFundId) ?? null;
  const selectedMember = members?.find((item) => item.id === selectedMemberId) ?? null;
  const hasPendingUpload = purposes.some((purpose) => pendingUploads[purpose]);
  const unconfirmed = ["creating", "create-unknown", "granting", "grant-unknown", "refreshing-directories"].includes(phase) || uploading || hasPendingUpload;
  const locked = busy || loading || uploading || hasPendingUpload || phase !== "idle";
  const clearGrantCommand = (): void => {
    if (phase === "idle") grantCommand.current = null;
  };

  const resetDraft = (): void => {
    documentRef.current = null;
    createCommand.current = null;
    grantCommand.current = null;
    uploadCommands.current = {};
    setSelectedProjectNo("");
    setSelectedFundId("");
    setSelectedMemberId("");
    setAmount("");
    setReason("");
    setDocument(null);
    setAttachments(null);
    setReady({});
    setPendingUploads({});
    setPhase("idle");
    setProjectRefreshPending(false);
    setProjectReselectionRequired(false);
    setFundRefreshPending(false);
    setFundReselectionRequired(false);
  };
  const invalidate = (): void => {
    generation.current += 1;
    running.current = false;
    resetDraft();
    setProjects(null);
    setFunds(null);
    setMembers(null);
    setLoading(false);
    setUploading(false);
    setMessage("登录或身份已失效，请重新登录或选择身份。");
    client.logout();
    onUnconfirmedChange?.(false);
    onInvalidated?.();
  };
  const fail = (error: unknown, fallback: string): void => {
    if (authError(error) || client.hasRoleContext === false) {
      invalidate();
      return;
    }
    setMessage(error instanceof Error && error.message ? error.message : fallback);
  };

  const loadDirectories = async (token = generation.current): Promise<boolean> => {
    if (!authorized || busy) return false;
    const requestSession = client.currentSession;
    setLoading(true);
    try {
      const [catalog, sourceFunds, people] = await Promise.all([
        client.listBonusProjects(),
        client.listBenefitSourceFunds(),
        client.listManagedCashWageTeachers(),
      ]);
      if (requestSession !== client.currentSession) throw new StaleResponseError();
      if (token !== generation.current) return false;
      setProjects(catalog.projects);
      setFunds(sourceFunds.items);
      setMembers(people.items);
      return true;
    } catch (error) {
      if (token === generation.current) fail(error, "奖金所需目录读取失败，请重试。");
      return false;
    } finally {
      if (token === generation.current) setLoading(false);
    }
  };
  const refreshProjectsAfterConflict = async (token: number): Promise<void> => {
    const requestSession = client.currentSession;
    try {
      const catalog = await client.listBonusProjects();
      if (requestSession !== client.currentSession) throw new StaleResponseError();
      if (token !== generation.current) return;
      setProjects(catalog.projects);
      setSelectedProjectNo("");
      setProjectRefreshPending(false);
      setProjectReselectionRequired(true);
      setPhase("idle");
      setMessage("项目目录已有更新，请重新选择项目后再确认发放。凭证和原件已保留。");
    } catch (error) {
      if (token !== generation.current) return;
      if (authError(error)) invalidate();
      else {
        setProjectRefreshPending(true);
        setProjectReselectionRequired(true);
        setPhase("idle");
        setMessage("最新项目目录读取失败，请重试读取后重新选择项目。凭证和原件已保留。");
      }
    }
  };
  const refreshFundsAfterConflict = async (token: number): Promise<void> => {
    const requestSession = client.currentSession;
    try {
      const sourceFunds = await client.listBenefitSourceFunds();
      if (requestSession !== client.currentSession) throw new StaleResponseError();
      if (token !== generation.current) return;
      setFunds(sourceFunds.items);
      setSelectedFundId("");
      setFundRefreshPending(false);
      setFundReselectionRequired(true);
      setPhase("idle");
      setMessage("来源账户目录已有更新，请重新选择来源账户后再确认发放。凭证和原件已保留。");
    } catch (error) {
      if (token !== generation.current) return;
      if (authError(error)) invalidate();
      else {
        setFundRefreshPending(true);
        setFundReselectionRequired(true);
        setPhase("idle");
        setMessage("最新来源账户目录读取失败，请重试读取后重新选择来源账户。凭证和原件已保留。");
      }
    }
  };

  useEffect(() => {
    const token = ++generation.current;
    running.current = false;
    resetDraft();
    setProjects(null);
    setFunds(null);
    setMembers(null);
    setMessage("");
    if (authorized) void loadDirectories(token);
    return () => {
      generation.current += 1;
      running.current = false;
    };
  }, [client, identity, authorized]);
  useEffect(() => {
    onUnconfirmedChange?.(unconfirmed);
    return () => onUnconfirmedChange?.(false);
  }, [unconfirmed, onUnconfirmedChange]);

  const readAttachments = async (id: string, token: number): Promise<void> => {
    const requestSession = client.currentSession;
    const current = (): boolean => token === generation.current && documentRef.current === id && requestSession === client.currentSession;
    let next: FinanceDocumentAttachments;
    try {
      next = await client.listFinanceDocumentAttachments(id);
    } catch (error) {
      if (current()) throw error;
      return;
    }
    if (!current()) return;
    if (next.documentId !== id) throw new Error("奖金凭证附件归属不一致，请重新读取。");
    setAttachments(next);
  };
  const createDocument = async (): Promise<void> => {
    if (running.current || busy || loading || uploading || hasPendingUpload || projectRefreshPending || projectReselectionRequired || fundRefreshPending || fundReselectionRequired || documentRef.current !== null || !selectedProject || !selectedFund || !selectedMember || !amount.trim() || !reason.trim() || !["idle", "create-unknown"].includes(phase)) return;
    try { cents(amount); } catch (error) { fail(error, "请核对奖金金额。"); return; }
    const token = generation.current;
    const requestSession = client.currentSession;
    running.current = true;
    setPhase("creating");
    try {
      const submission = createCommand.current ?? client.createSalaryBenefitDocumentSubmission({ kind: "PROJECT_BONUS" });
      createCommand.current = submission;
      const result = await client.createSalaryBenefitDocument(submission);
      if (requestSession !== client.currentSession) throw new StaleResponseError();
      if (token !== generation.current) return;
      createCommand.current = null;
      documentRef.current = result.id;
      setDocument({ id: result.id, version: result.version });
      setPhase("idle");
      try { await readAttachments(result.id, token); } catch (error) {
        if (token === generation.current) fail(error, "奖金凭证已创建，但附件读取失败，可重试读取。");
      }
    } catch (error) {
      if (token !== generation.current) return;
      if (authError(error)) invalidate();
      else if (definiteClientError(error)) {
        createCommand.current = null;
        setPhase("idle");
        fail(error, "创建奖金凭证被拒绝，请修改后重试。");
      } else {
        setPhase("create-unknown");
        setMessage("奖金凭证创建结果未确认，请使用原提交安全重试。");
      }
    } finally {
      if (token === generation.current) running.current = false;
    }
  };
  const upload = async (purpose: Purpose): Promise<void> => {
    const id = documentRef.current;
    if (!id || running.current || busy || phase !== "idle" || projectRefreshPending || projectReselectionRequired || fundRefreshPending || fundReselectionRequired) return;
    const requestSession = client.currentSession;
    if (!requestSession) { invalidate(); return; }
    const token = generation.current;
    running.current = true;
    setUploading(true);
    let command = uploadCommands.current[purpose];
    const active = (): boolean => {
      if (token !== generation.current || documentRef.current !== id) return false;
      if (client.currentSession !== requestSession) throw new StaleResponseError();
      return true;
    };
    try {
      if (!command) {
        const choice = await Taro.showActionSheet({ itemList: ["选择原始图片", "选择 PDF 文件"] });
        if (!active()) return;
        let temporaryPath = "";
        let name = "";
        if (choice.tapIndex === 0) {
          const result = await Taro.chooseImage({ count: 1, sizeType: ["original"], sourceType: ["album", "camera"] });
          temporaryPath = result.tempFilePaths[0] ?? "";
          name = `${purpose}.image`;
        } else {
          const result = await Taro.chooseMessageFile({ count: 1, type: "file", extension: ["pdf"] });
          temporaryPath = result.tempFiles[0]?.path ?? "";
          name = result.tempFiles[0]?.name ?? "";
        }
        if (!active()) return;
        const file = createPickedFinanceAttachment(name, temporaryPath, await readTemporaryFileBytes(temporaryPath));
        if (!active()) return;
        command = {
          file,
          submission: client.createFinanceAttachmentReservationSubmission({
            documentId: id,
            purpose,
            originalFilename: file.name,
            declaredMediaType: file.mediaType,
            declaredSizeBytes: file.bytes.byteLength,
          }),
        };
        uploadCommands.current[purpose] = command;
        setPendingUploads((current) => ({ ...current, [purpose]: true }));
      }
      if (!command.versionId) {
        const reservation = await client.reserveFinanceAttachment(command.submission);
        if (!active()) return;
        command = { ...command, versionId: reservation.versionId };
        uploadCommands.current[purpose] = command;
      }
      const versionId = command.versionId;
      if (!versionId) throw new Error("原件预留版本缺失，请使用原文件安全重试。");
      let metadata = await client.getOwnFinanceAttachmentVersion(versionId);
      if (!active()) return;
      if (metadata.status === "FAILED") {
        delete uploadCommands.current[purpose];
        setPendingUploads((current) => ({ ...current, [purpose]: false }));
        setMessage("原件未通过校验，请重新选择正确文件。");
        return;
      }
      if (metadata.status !== "READY") {
        const uploaded = await uploadFinanceAttachmentBytes(requestSession, versionId, command.file.mediaType, command.file.bytes);
        if (!active()) return;
        if (uploaded.status === 401 || uploaded.status === 403) throw new RoleSelectionRequiredError("FORBIDDEN_SCOPE");
        if (uploaded.status < 200 || uploaded.status >= 300) throw new Error("上传结果未确认，请使用原文件安全重试。");
        metadata = uploaded.metadata ?? await client.getOwnFinanceAttachmentVersion(versionId);
        if (!active()) return;
      }
      if (metadata.status === "FAILED") {
        delete uploadCommands.current[purpose];
        setPendingUploads((current) => ({ ...current, [purpose]: false }));
        setMessage("原件未通过校验，请重新选择正确文件。");
        return;
      }
      if (metadata.status !== "READY") throw new Error("上传结果未确认，请使用原文件安全重试。");
      const latest = await client.listFinanceDocumentAttachments(id);
      if (!active()) return;
      if (latest.documentId !== id || !latest.attachments.some((slot) => slot.purpose === purpose && slot.versions.some((version) => version.versionId === command?.versionId && version.status === "READY"))) throw new Error("原件列表尚未确认，请使用原文件安全重试。");
      setAttachments(latest);
      setReady((current) => ({ ...current, [purpose]: command?.versionId }));
      delete uploadCommands.current[purpose];
      setPendingUploads((current) => ({ ...current, [purpose]: false }));
      setMessage(`${purposeLabel(purpose)}已完整上传。`);
    } catch (error) {
      if (token !== generation.current || documentRef.current !== id) return;
      if (authError(error)) invalidate();
      else {
        if (command && !command.versionId && definiteClientError(error)) {
          delete uploadCommands.current[purpose];
          setPendingUploads((current) => ({ ...current, [purpose]: false }));
        }
        fail(error, "原件上传失败，请重试。");
      }
    } finally {
      if (token === generation.current) {
        running.current = false;
        setUploading(false);
      }
    }
  };
  const grant = async (): Promise<void> => {
    if (running.current || busy || loading || uploading || hasPendingUpload || projectRefreshPending || projectReselectionRequired || fundRefreshPending || fundReselectionRequired || !document || !selectedProject || !selectedFund || !selectedMember || !["idle", "grant-unknown"].includes(phase)) return;
    const token = generation.current;
    const requestSession = client.currentSession;
    let submission = grantCommand.current;
    try {
      const attachmentVersionIds = purposes.map((purpose) => {
        const versionId = ready[purpose];
        if (!versionId || !attachments?.attachments.some((slot) => slot.purpose === purpose && slot.versions.some((version) => version.versionId === versionId && version.status === "READY"))) throw new Error("请上传两份不同用途的 READY 原件。");
        return versionId;
      });
      submission = submission ?? client.createBonusGrantSubmission({
        documentId: document.id,
        expectedVersion: document.version,
        projectNo: selectedProject.projectNo,
        projectName: selectedProject.displayName,
        projectNameVersionId: selectedProject.nameVersionId,
        recipientPersonId: selectedMember.id,
        sourceFundId: selectedFund.fundId,
        amountCents: cents(amount),
        reason: reason.trim(),
        attachmentVersionIds,
      });
      grantCommand.current = submission;
    } catch (error) {
      fail(error, "请核对项目、收款成员、来源账户、金额、理由和原件。");
      return;
    }
    running.current = true;
    setPhase("granting");
    try {
      await client.grantProjectBonus(submission);
      if (requestSession !== client.currentSession) throw new StaleResponseError();
      if (token !== generation.current) return;
      resetDraft();
      setMessage("项目奖金已发放：所选财务业务账户已扣款，收款成员个人账户已入账；这不是工资或银行转账。");
      onSaved?.();
      void loadDirectories(token);
    } catch (error) {
      if (token !== generation.current) return;
      if (authError(error)) {
        invalidate();
      } else if (projectCatalogConflict(error)) {
        grantCommand.current = null;
        setPhase("refreshing-directories");
        setSelectedProjectNo("");
        setProjectRefreshPending(true);
        setProjectReselectionRequired(true);
        setMessage("项目目录已有更新，正在读取最新项目。凭证和原件已保留。");
        void refreshProjectsAfterConflict(token);
      } else if (sourceFundConflict(error)) {
        grantCommand.current = null;
        setPhase("refreshing-directories");
        setSelectedFundId("");
        setFundRefreshPending(true);
        setFundReselectionRequired(true);
        setMessage("来源账户目录已有更新，正在读取最新来源账户。凭证和原件已保留。");
        void refreshFundsAfterConflict(token);
      } else if (documentConflict(error)) {
        grantCommand.current = null;
        setPhase("document-conflict");
        setMessage("奖金凭证状态已变化，请核查当前凭证状态后重新发起发放；此凭证不能再次提交。");
      } else if (definiteClientError(error)) {
        grantCommand.current = null;
        setPhase("idle");
        setMessage(`${grantErrorMessage(error, "奖金发放被拒绝，请修改后重新提交。")}凭证和原件已保留。`);
      } else {
        setPhase("grant-unknown");
        setMessage("奖金发放结果未确认，请使用原提交安全重试。");
      }
    } finally {
      if (token === generation.current) running.current = false;
    }
  };

  if (!authorized) return <View className="panel"><Text className="panel-title">项目奖金发放</Text><Text>当前身份没有发放项目奖金的权限。</Text></View>;
  const projectIndex = selectedProject === null ? 0 : (projects?.findIndex((item) => String(item.projectNo) === selectedProjectNo) ?? -1) + 1;
  const fundIndex = selectedFund === null ? 0 : (funds?.findIndex((item) => item.fundId === selectedFundId) ?? -1) + 1;
  const memberIndex = selectedMember === null ? 0 : (members?.findIndex((item) => item.id === selectedMemberId) ?? -1) + 1;
  const canCreate = !locked && document === null && selectedProject !== null && selectedFund !== null && selectedMember !== null && amount.trim() !== "" && reason.trim() !== "";
  return <View className="panel project-bonus-grant-panel">
    <Text className="panel-title">项目奖金发放</Text>
    <Text>从所选财务业务账户扣款，并记入收款成员个人账户；不属于工资或银行转账。</Text>
    {loading && <Text>正在读取项目、来源账户和收款成员…</Text>}
    {message && <Text className="notice">{message}</Text>}
    {projects && funds && members && <>
      <Text>项目</Text>
      <Picker mode="selector" range={["请选择项目", ...projects.map((item) => `项目${item.projectNo} · ${item.displayName} · 当前版本 ${item.nameVersion}`)]} value={projectIndex} disabled={locked || projectRefreshPending || (document !== null && !projectReselectionRequired)} onChange={(event) => { if (document === null || (projectReselectionRequired && !projectRefreshPending)) { clearGrantCommand(); setSelectedProjectNo(String(projects[Number(event.detail.value) - 1]?.projectNo ?? "")); setProjectReselectionRequired(false); setMessage(""); } }}><View className="picker-value"><Text>{selectedProject ? `项目${selectedProject.projectNo} · ${selectedProject.displayName}` : "请选择项目"}</Text></View></Picker>
      <Text>来源财务业务账户</Text>
      <Picker mode="selector" range={["请选择来源账户", ...funds.map((item) => `${item.displayName}（${item.code}）`)]} value={fundIndex} disabled={locked || fundRefreshPending} onChange={(event) => { if (!fundRefreshPending) { clearGrantCommand(); setSelectedFundId(funds[Number(event.detail.value) - 1]?.fundId ?? ""); setFundReselectionRequired(false); } }}><View className="picker-value"><Text>{selectedFund ? `${selectedFund.displayName}（${selectedFund.code}）` : "请选择来源账户"}</Text></View></Picker>
      <Text>收款成员</Text>
      <Picker mode="selector" range={["请选择收款成员", ...members.map((item) => item.nickname)]} value={memberIndex} disabled={locked} onChange={(event) => { clearGrantCommand(); setSelectedMemberId(members[Number(event.detail.value) - 1]?.id ?? ""); }}><View className="picker-value"><Text>{selectedMember?.nickname ?? "请选择收款成员"}</Text></View></Picker>
      <Text>奖金金额（欢乐豆）</Text>
      <Input type="digit" value={amount} disabled={locked} onInput={(event) => { clearGrantCommand(); setAmount(event.detail.value); }} />
      <Text>发放理由</Text>
      <Textarea value={reason} disabled={locked} onInput={(event) => { clearGrantCommand(); setReason(event.detail.value); }} />
      {document === null ? <Button disabled={!canCreate && phase !== "create-unknown"} onClick={() => void createDocument()}>{phase === "create-unknown" ? "安全重试创建奖金凭证" : "创建奖金凭证"}</Button> : <>
        <Text>奖金凭证已创建，请上传两份不同用途的原件后确认发放。</Text>
        {purposes.map((purpose) => <View key={purpose} className="finance-upload"><Text>{purposeLabel(purpose)}：{ready[purpose] ? "已 READY" : "待上传"}</Text><Button disabled={busy || loading || uploading || phase !== "idle" || projectRefreshPending || projectReselectionRequired || fundRefreshPending || fundReselectionRequired || (hasPendingUpload && uploadCommands.current[purpose] === undefined) || ready[purpose] !== undefined} onClick={() => void upload(purpose)}>{uploadCommands.current[purpose] ? `安全重试上传${purposeLabel(purpose)}` : `选择并上传${purposeLabel(purpose)}`}</Button></View>)}
        {attachments === null && <Button disabled={locked} onClick={() => { const id = documentRef.current; const token = generation.current; if (id) void readAttachments(id, token).catch((error) => { if (token === generation.current && documentRef.current === id) fail(error, "奖金凭证附件读取失败。"); }); }}>重新读取奖金凭证附件</Button>}
        {phase === "grant-unknown" ? <Button disabled={busy || uploading || hasPendingUpload} onClick={() => void grant()}>安全重试原奖金发放</Button> : <Button disabled={locked || purposes.some((purpose) => !ready[purpose]) || projectRefreshPending || projectReselectionRequired || fundRefreshPending || fundReselectionRequired} onClick={() => void grant()}>确认项目奖金发放</Button>}
      </>}
      {(projectRefreshPending || projectReselectionRequired) && <Button disabled={loading || phase !== "idle"} onClick={() => { void refreshProjectsAfterConflict(generation.current); }}>重试读取最新项目目录</Button>}
      {(fundRefreshPending || fundReselectionRequired) && <Button disabled={loading || phase !== "idle"} onClick={() => { void refreshFundsAfterConflict(generation.current); }}>重试读取最新来源账户目录</Button>}
    </>}
    {!loading && (!projects || !funds || !members) && <Button disabled={busy} onClick={() => void loadDirectories(generation.current)}>重试读取奖金所需目录</Button>}
  </View>;
}
