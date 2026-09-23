import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ApiClientError,
  RoleSelectionRequiredError,
  StaleResponseError,
  parseBeanAmountToCents,
  type BenefitSourceFundDirectory,
  type BonusGrantSubmission,
  type BonusProjectCatalog,
  type FinanceDocumentAttachments,
  type ManagedCashWageTeacherDirectory,
  type SalaryBenefitDocumentSubmission,
  type SessionSnapshot,
  type TeacherApiClient,
} from "@teaching-research-alliance/client";
import { AttachmentPicker, financeError } from "./finance-shared.js";

type Props = {
  client: TeacherApiClient;
  session: SessionSnapshot;
  sessionKey: string;
  busy?: boolean;
  onInvalidated?: () => void;
  onSaved?: () => void;
  onUnconfirmedChange?: (pending: boolean) => void;
};
type Purpose = "SUPPORTING_DOCUMENT" | "APPLICATION_SCREENSHOT";
type Phase = "idle" | "creating" | "create-unknown" | "granting" | "grant-unknown" | "refreshing-projects" | "project-refresh-failed" | "refreshing-funds" | "fund-refresh-failed" | "document-conflict";
type Project = BonusProjectCatalog["projects"][number];
type Recipient = ManagedCashWageTeacherDirectory["items"][number];
type Fund = BenefitSourceFundDirectory["items"][number];

const purposes: readonly Purpose[] = ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT"];

const isAuthorized = (session: SessionSnapshot): boolean => {
  const context = session.currentRoleContext;
  return context !== null
    && context.scope === "GLOBAL"
    && context.regionId === undefined
    && context.campusId === undefined
    && context.venueId === undefined
    && ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"].includes(context.subject);
};

const isAuthError = (error: unknown): boolean => error instanceof StaleResponseError
  || error instanceof RoleSelectionRequiredError
  || error instanceof ApiClientError && [401, 403].includes(error.status)
  || typeof error === "object" && error !== null && [401, 403].includes((error as { status?: number }).status ?? 0);

const isDefiniteClientError = (error: unknown): boolean => error instanceof ApiClientError
  && error.status >= 400
  && error.status < 500;

const isProjectCatalogConflict = (error: unknown): boolean => error instanceof ApiClientError
  && error.status === 409
  && error.code === "BONUS_PROJECT_VERSION_CONFLICT";

const isDocumentConflict = (error: unknown): boolean => error instanceof ApiClientError
  && error.status === 409
  && ["VERSION_CONFLICT", "SALARY_BENEFIT_STATE_CONFLICT"].includes(error.code);

const isFundConflict = (error: unknown): boolean => error instanceof ApiClientError
  && error.status === 409
  && ["COMPANY_FUND_INACTIVE", "COMPANY_FUND_ASSIGNMENT_NOT_FOUND"].includes(error.code);

const grantErrorMessage = (error: unknown): string => error instanceof ApiClientError
  && ["PERSONAL_ACCOUNT_NOT_FOUND", "PERSON_NOT_FOUND"].includes(error.code)
  ? "该收款成员当前不可用，请选择其他收款成员后再确认发放。"
  : financeError(error);

const positiveAmountCents = (value: string): string => {
  const cents = parseBeanAmountToCents(value.trim());
  if (BigInt(cents) <= 0n) throw new Error("BONUS_AMOUNT_MUST_BE_POSITIVE");
  return cents;
};

const hasPositiveAmount = (value: string): boolean => {
  try {
    positiveAmountCents(value);
    return true;
  } catch {
    return false;
  }
};

const sourceAttachment = (attachments: FinanceDocumentAttachments | null, purpose: Purpose, versionId: string | undefined): string | undefined => {
  if (attachments === null || versionId === undefined) return undefined;
  return attachments.attachments.find((attachment) => attachment.purpose === purpose)?.versions
    .find((version) => version.versionId === versionId && version.status === "READY")?.versionId;
};

export function ProjectBonusGrantPanel({ client, session, sessionKey, busy = false, onInvalidated, onSaved, onUnconfirmedChange }: Props): ReactNode {
  const context = session.currentRoleContext;
  const authorized = isAuthorized(session);
  const identity = `${sessionKey}:${context?.personId ?? ""}:${context?.subject ?? ""}:${context?.scope ?? ""}:${context?.regionId ?? ""}:${context?.campusId ?? ""}:${context?.venueId ?? ""}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const generation = useRef(0);
  const running = useRef(false);
  const refreshingProjects = useRef(false);
  const refreshingFunds = useRef(false);
  const documentRef = useRef<string | null>(null);
  const createCommand = useRef<SalaryBenefitDocumentSubmission | null>(null);
  const grantCommand = useRef<BonusGrantSubmission | null>(null);

  const [projects, setProjects] = useState<readonly Project[] | null>(null);
  const [recipients, setRecipients] = useState<readonly Recipient[] | null>(null);
  const [funds, setFunds] = useState<readonly Fund[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [projectNo, setProjectNo] = useState("");
  const [recipientPersonId, setRecipientPersonId] = useState("");
  const [sourceFundId, setSourceFundId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [document, setDocument] = useState<{ id: string; version: number } | null>(null);
  const [attachments, setAttachments] = useState<FinanceDocumentAttachments | null>(null);
  const [ready, setReady] = useState<Partial<Record<Purpose, string>>>({});
  const [pendingUploads, setPendingUploads] = useState<Partial<Record<Purpose, boolean>>>({});
  const [uploading, setUploading] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [projectReselectionRequired, setProjectReselectionRequired] = useState(false);
  const [fundReselectionRequired, setFundReselectionRequired] = useState(false);
  const [message, setMessage] = useState("");

  const project = projects?.find((entry) => String(entry.projectNo) === projectNo) ?? null;
  const recipient = recipients?.find((entry) => entry.id === recipientPersonId) ?? null;
  const fund = funds?.find((entry) => entry.fundId === sourceFundId) ?? null;
  const hasPendingUpload = purposes.some((purpose) => pendingUploads[purpose]);
  const formLocked = busy || loading || uploading || hasPendingUpload || phase !== "idle";

  const resetDraft = (): void => {
    documentRef.current = null;
    createCommand.current = null;
    grantCommand.current = null;
    setDocument(null);
    setAttachments(null);
    setReady({});
    setPendingUploads({});
    setUploading(false);
    setProjectNo("");
    setRecipientPersonId("");
    setSourceFundId("");
    setAmount("");
    setReason("");
    setProjectReselectionRequired(false);
    setFundReselectionRequired(false);
    setPhase("idle");
  };

  const invalidate = (error: unknown): void => {
    if (!isAuthError(error) && client.hasRoleContext !== false) {
      setMessage(financeError(error));
      return;
    }
    generation.current += 1;
    running.current = false;
    refreshingProjects.current = false;
    refreshingFunds.current = false;
    resetDraft();
    setProjects(null);
    setRecipients(null);
    setFunds(null);
    setLoading(false);
    setMessage("登录或身份已失效，请重新登录或选择身份。");
    onInvalidated?.();
  };

  const readAttachments = async (id: string, token: number, expectedIdentity: string): Promise<void> => {
    const result = await client.listFinanceDocumentAttachments(id);
    if (token !== generation.current || identityRef.current !== expectedIdentity || documentRef.current !== id) return;
    if (result.documentId !== id) throw new Error("附件所属凭证不匹配，请重新读取。");
    setAttachments(result);
  };

  const loadDirectories = async (token: number, expectedIdentity: string): Promise<void> => {
    setLoading(true);
    try {
      const [nextProjects, nextRecipients, nextFunds] = await Promise.all([
        client.listBonusProjects(),
        client.listManagedCashWageTeachers(),
        client.listBenefitSourceFunds(),
      ]);
      if (token !== generation.current || identityRef.current !== expectedIdentity) return;
      setProjects(nextProjects.projects);
      setRecipients(nextRecipients.items);
      setFunds(nextFunds.items);
    } catch (error) {
      if (token !== generation.current || identityRef.current !== expectedIdentity) return;
      setProjects(null);
      setRecipients(null);
      setFunds(null);
      invalidate(error);
    } finally {
      if (token === generation.current && identityRef.current === expectedIdentity) setLoading(false);
    }
  };

  useEffect(() => {
    const token = ++generation.current;
    running.current = false;
    refreshingProjects.current = false;
    refreshingFunds.current = false;
    resetDraft();
    setProjects(null);
    setRecipients(null);
    setFunds(null);
    setMessage("");
    setLoading(false);
    if (authorized) void loadDirectories(token, identity);
    return () => {
      generation.current += 1;
      running.current = false;
      refreshingProjects.current = false;
      refreshingFunds.current = false;
    };
  }, [client, identity, authorized]);

  useEffect(() => {
    onUnconfirmedChange?.(phase === "creating" || phase === "create-unknown" || phase === "granting" || phase === "grant-unknown" || phase === "refreshing-projects" || phase === "project-refresh-failed" || phase === "refreshing-funds" || phase === "fund-refresh-failed" || uploading || hasPendingUpload);
    return () => onUnconfirmedChange?.(false);
  }, [phase, uploading, hasPendingUpload, onUnconfirmedChange]);

  const createDocument = async (): Promise<void> => {
    if (running.current || busy || documentRef.current !== null || !project || !recipient || !fund || projectReselectionRequired || fundReselectionRequired || !["idle", "create-unknown"].includes(phase)) return;
    try {
      positiveAmountCents(amount);
    } catch {
      setMessage("奖金金额必须大于 0，且最多两位小数。");
      return;
    }
    if (reason.trim() === "") {
      setMessage("请填写发放理由。");
      return;
    }
    const token = generation.current;
    const expectedIdentity = identity;
    running.current = true;
    try {
      const submission = createCommand.current ?? client.createSalaryBenefitDocumentSubmission({ kind: "PROJECT_BONUS" });
      createCommand.current = submission;
      setPhase("creating");
      const result = await client.createSalaryBenefitDocument(submission);
      if (token !== generation.current || identityRef.current !== expectedIdentity) return;
      if (result.kind !== "PROJECT_BONUS") throw new Error("奖金凭证类型不匹配，请重新创建。");
      createCommand.current = null;
      documentRef.current = result.id;
      setDocument({ id: result.id, version: result.version });
      setReady({});
      setPhase("idle");
      try {
        await readAttachments(result.id, token, expectedIdentity);
      } catch (error) {
        if (token === generation.current && identityRef.current === expectedIdentity) invalidate(error);
      }
    } catch (error) {
      if (token !== generation.current || identityRef.current !== expectedIdentity) return;
      if (isAuthError(error)) invalidate(error);
      else if (isDefiniteClientError(error) || createCommand.current === null) {
        createCommand.current = null;
        setPhase("idle");
        setMessage(grantErrorMessage(error));
      } else {
        setPhase("create-unknown");
        setMessage("创建奖金凭证的结果尚未确认，请使用原提交安全重试。");
      }
    } finally {
      if (token === generation.current && identityRef.current === expectedIdentity) running.current = false;
    }
  };

  const upload = async (action: () => Promise<unknown>, id: string, expectedIdentity: string): Promise<void> => {
    if (running.current || busy || phase !== "idle" || documentRef.current !== id || identityRef.current !== expectedIdentity) return;
    const token = generation.current;
    running.current = true;
    setUploading(true);
    try {
      await action();
      if (token !== generation.current || identityRef.current !== expectedIdentity || documentRef.current !== id) return;
      await readAttachments(id, token, expectedIdentity);
    } catch (error) {
      if (token === generation.current && identityRef.current === expectedIdentity) invalidate(error);
      throw error;
    } finally {
      if (token === generation.current && identityRef.current === expectedIdentity) {
        running.current = false;
        setUploading(false);
      }
    }
  };

  const refreshProjectsAfterConflict = async (token: number, expectedIdentity: string): Promise<void> => {
    if (refreshingProjects.current) return;
    refreshingProjects.current = true;
    setPhase("refreshing-projects");
    try {
      const result = await client.listBonusProjects();
      if (token !== generation.current || identityRef.current !== expectedIdentity) return;
      setProjects(result.projects);
      setProjectNo("");
      setProjectReselectionRequired(true);
      setPhase("idle");
      setMessage("项目目录已有更新，请重新选择项目后再确认发放。");
    } catch (error) {
      if (token !== generation.current || identityRef.current !== expectedIdentity) return;
      if (isAuthError(error)) invalidate(error);
      else {
        setProjectReselectionRequired(true);
        setPhase("project-refresh-failed");
        setMessage(`无法读取最新项目目录。${financeError(error)}`);
      }
    } finally {
      refreshingProjects.current = false;
    }
  };

  const refreshFundsAfterConflict = async (token: number, expectedIdentity: string): Promise<void> => {
    if (refreshingFunds.current) return;
    refreshingFunds.current = true;
    setPhase("refreshing-funds");
    try {
      const result = await client.listBenefitSourceFunds();
      if (token !== generation.current || identityRef.current !== expectedIdentity) return;
      setFunds(result.items);
      setSourceFundId("");
      setFundReselectionRequired(true);
      setPhase("idle");
      setMessage("来源业务账户目录已有更新，请重新选择支出账户后再确认发放。");
    } catch (error) {
      if (token !== generation.current || identityRef.current !== expectedIdentity) return;
      if (isAuthError(error)) invalidate(error);
      else {
        setFundReselectionRequired(true);
        setPhase("fund-refresh-failed");
        setMessage(`无法读取最新来源业务账户。${financeError(error)}`);
      }
    } finally {
      refreshingFunds.current = false;
    }
  };

  const grant = async (): Promise<void> => {
    if (running.current || busy || !document || !project || !recipient || !fund || projectReselectionRequired || fundReselectionRequired || !["idle", "grant-unknown"].includes(phase)) return;
    const supporting = ready.SUPPORTING_DOCUMENT;
    const screenshot = ready.APPLICATION_SCREENSHOT;
    if (!supporting || !screenshot) {
      setMessage("请先选择两份已 READY 的奖金原件。");
      return;
    }
    if (attachments !== null && (!sourceAttachment(attachments, "SUPPORTING_DOCUMENT", supporting) || !sourceAttachment(attachments, "APPLICATION_SCREENSHOT", screenshot))) {
      setMessage("奖金原件尚未核验为 READY，请重新读取凭证附件。");
      return;
    }
    let amountCents: string;
    try {
      amountCents = positiveAmountCents(amount);
    } catch {
      setMessage("奖金金额必须大于 0，且最多两位小数。");
      return;
    }
    if (reason.trim() === "") {
      setMessage("请填写发放理由。");
      return;
    }
    const token = generation.current;
    const expectedIdentity = identity;
    running.current = true;
    try {
      const submission = grantCommand.current ?? client.createBonusGrantSubmission({
        documentId: document.id,
        expectedVersion: document.version,
        projectNo: project.projectNo,
        projectName: project.displayName,
        projectNameVersionId: project.nameVersionId,
        recipientPersonId: recipient.id,
        sourceFundId: fund.fundId,
        amountCents,
        reason: reason.trim(),
        attachmentVersionIds: [supporting, screenshot],
      });
      grantCommand.current = submission;
      setPhase("granting");
      await client.grantProjectBonus(submission);
      if (token !== generation.current || identityRef.current !== expectedIdentity) return;
      grantCommand.current = null;
      resetDraft();
      setMessage("项目奖金已发放，来源业务账户已扣减，收款成员个人账户已增加。");
      onSaved?.();
      void loadDirectories(token, expectedIdentity);
    } catch (error) {
      if (token !== generation.current || identityRef.current !== expectedIdentity) return;
      if (isAuthError(error)) {
        invalidate(error);
      } else if (isProjectCatalogConflict(error)) {
        grantCommand.current = null;
        setMessage("项目目录已有更新，正在读取最新项目名称。");
        void refreshProjectsAfterConflict(token, expectedIdentity);
      } else if (isFundConflict(error)) {
        grantCommand.current = null;
        setMessage("来源业务账户状态已变化，正在读取最新可用账户。");
        void refreshFundsAfterConflict(token, expectedIdentity);
      } else if (isDocumentConflict(error)) {
        grantCommand.current = null;
        setPhase("document-conflict");
        setMessage("奖金凭证状态已变化，请核查当前凭证状态后重新发起发放；此凭证不能再次提交。");
      } else if (isDefiniteClientError(error) || grantCommand.current === null) {
        grantCommand.current = null;
        setPhase("idle");
        setMessage(grantErrorMessage(error));
      } else {
        setPhase("grant-unknown");
        setMessage("发放结果尚未确认，请使用原提交安全重试。");
      }
    } finally {
      if (token === generation.current && identityRef.current === expectedIdentity) running.current = false;
    }
  };

  const markReady = (purpose: Purpose, versionId: string, callbackIdentity: string): void => {
    if (callbackIdentity !== identityRef.current || phase !== "idle" || documentRef.current === null) return;
    setReady((current) => ({ ...current, [purpose]: versionId }));
  };

  const markPending = (purpose: Purpose, pending: boolean, callbackIdentity: string): void => {
    if (callbackIdentity !== identityRef.current || documentRef.current === null) return;
    setPendingUploads((current) => ({ ...current, [purpose]: pending }));
  };

  if (!authorized) {
    return <section className="panel finance-panel" aria-label="项目奖金发放"><h2>项目奖金发放</h2><p>当前身份没有查看总部项目奖金的权限。</p></section>;
  }

  const canUsePurpose = (purpose: Purpose): boolean => !busy
    && phase === "idle"
    && !uploading
    && (!hasPendingUpload || pendingUploads[purpose] === true);
  const amountIsPositive = hasPositiveAmount(amount);
  const selectedAttachmentsReady = purposes.every((purpose) => ready[purpose] !== undefined)
    && (attachments === null || purposes.every((purpose) => sourceAttachment(attachments, purpose, ready[purpose]) !== undefined));
  return <section className="panel finance-panel" aria-label="项目奖金发放">
    <div className="finance-header"><div><h2>项目奖金发放</h2><p>从所选业务账户扣减奖金，收款成员的个人账户同步增加。</p></div></div>
    {loading && <p role="status">正在读取项目、收款成员和支出账户目录…</p>}
    {!loading && projects !== null && recipients !== null && funds !== null && <>
      <fieldset className="finance-form-grid" disabled={formLocked}>
        <label>项目<select aria-label="项目" value={projectNo} onChange={(event) => { if (formLocked) return; setProjectNo(event.target.value); setProjectReselectionRequired(false); setMessage(""); }}><option value="">请选择项目</option>{projects.map((entry) => <option key={entry.projectNo} value={entry.projectNo}>{entry.displayName}</option>)}</select></label>
        <label>收款成员<select aria-label="收款成员" value={recipientPersonId} onChange={(event) => { if (!formLocked) setRecipientPersonId(event.target.value); }}><option value="">请选择收款成员</option>{recipients.map((entry) => <option key={entry.id} value={entry.id}>{entry.nickname}</option>)}</select></label>
        <label>支出账户<select aria-label="支出账户" value={sourceFundId} onChange={(event) => { if (formLocked) return; setSourceFundId(event.target.value); setFundReselectionRequired(false); setMessage(""); }}><option value="">请选择支出账户</option>{funds.map((entry) => <option key={entry.fundId} value={entry.fundId}>{entry.displayName}</option>)}</select></label>
        <label>奖金金额<input aria-label="奖金金额" inputMode="decimal" value={amount} onChange={(event) => { if (!formLocked) setAmount(event.target.value); }} placeholder="例如 100.00" /></label>
      </fieldset>
      <label>发放理由<textarea aria-label="发放理由" disabled={formLocked} value={reason} onChange={(event) => { if (!formLocked) setReason(event.target.value); }} /></label>
      {projectReselectionRequired && phase !== "project-refresh-failed" && <p className="finance-notice" role="alert">项目名称目录已更新，请重新选择项目后再确认发放。</p>}
      {phase === "project-refresh-failed" && <><p className="finance-notice" role="alert">无法核对最新项目目录，请重试读取后再重新选择项目。</p><button type="button" disabled={busy || refreshingProjects.current} onClick={() => { const token = generation.current; void refreshProjectsAfterConflict(token, identity); }}>重试读取最新项目</button></>}
      {fundReselectionRequired && phase !== "fund-refresh-failed" && <p className="finance-notice" role="alert">来源业务账户目录已更新，请重新选择支出账户后再确认发放。</p>}
      {phase === "fund-refresh-failed" && <><p className="finance-notice" role="alert">无法核对最新来源业务账户，请重试读取后再重新选择支出账户。</p><button type="button" disabled={busy || refreshingFunds.current} onClick={() => { const token = generation.current; void refreshFundsAfterConflict(token, identity); }}>重试读取支出账户</button></>}
      {document === null ? <button type="button" disabled={busy || loading || phase === "creating" || !project || !recipient || !fund || !amountIsPositive || reason.trim() === "" || projectReselectionRequired || fundReselectionRequired} onClick={() => void createDocument()}>{phase === "create-unknown" ? "安全重试创建凭证" : "创建奖金凭证"}</button> : <>
        <div className="finance-attachments">
          <AttachmentPicker client={client} documentId={document.id} purpose="SUPPORTING_DOCUMENT" label="奖金支持原件" disabled={!canUsePurpose("SUPPORTING_DOCUMENT")} run={(action) => upload(action, document.id, identity)} onReady={(versionId) => markReady("SUPPORTING_DOCUMENT", versionId, identity)} onPendingChange={(pending) => markPending("SUPPORTING_DOCUMENT", pending, identity)} />
          <AttachmentPicker client={client} documentId={document.id} purpose="APPLICATION_SCREENSHOT" label="奖金申请截图" disabled={!canUsePurpose("APPLICATION_SCREENSHOT")} run={(action) => upload(action, document.id, identity)} onReady={(versionId) => markReady("APPLICATION_SCREENSHOT", versionId, identity)} onPendingChange={(pending) => markPending("APPLICATION_SCREENSHOT", pending, identity)} />
        </div>
        {attachments === null && <button type="button" disabled={formLocked} onClick={() => { const token = generation.current; void readAttachments(document.id, token, identity).catch((error) => { if (token === generation.current && identityRef.current === identity) invalidate(error); }); }}>重新读取凭证附件</button>}
        <button type="button" disabled={busy || loading || uploading || hasPendingUpload || phase === "creating" || phase === "granting" || phase === "refreshing-projects" || phase === "project-refresh-failed" || phase === "refreshing-funds" || phase === "fund-refresh-failed" || phase === "document-conflict" || !project || !recipient || !fund || !amountIsPositive || reason.trim() === "" || !selectedAttachmentsReady || projectReselectionRequired || fundReselectionRequired} onClick={() => void grant()}>{phase === "grant-unknown" ? "安全重试原发放" : "确认发放"}</button>
      </>}
    </>}
    {message && <p role="alert">{message}</p>}
  </section>;
}
