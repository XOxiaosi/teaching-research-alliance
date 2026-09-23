import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ApiClientError,
  RoleSelectionRequiredError,
  StaleResponseError,
  formatCentsAsBeans,
  type BenefitConfirmationSubmission,
  type BenefitRosterItem,
  type FinanceDocumentAttachments,
  type ManagedBenefitRoster,
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
type Phase =
  | "idle"
  | "generating"
  | "generate-unknown"
  | "creating"
  | "create-unknown"
  | "confirming"
  | "confirm-unknown"
  | "conflict"
  | "reconciling"
  | "refresh-recovery";
type Purpose = "SUPPORTING_DOCUMENT" | "APPLICATION_SCREENSHOT";
const purposes: Purpose[] = ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT"];
const kindLabel = (kind: BenefitRosterItem["benefitKind"]): string =>
  kind === "SOCIAL_INSURANCE" ? "医社保" : "公积金";
const beans = (v: string): string => `${formatCentsAsBeans(v)} 欢乐豆`;
const authError = (e: unknown): boolean =>
  e instanceof StaleResponseError ||
  e instanceof RoleSelectionRequiredError ||
  (e instanceof ApiClientError && [401, 403].includes(e.status));
const definite = (e: unknown): boolean =>
  e instanceof ApiClientError && e.status >= 400 && e.status < 500;

export function BenefitConfirmationPanel({
  client,
  session,
  sessionKey,
  busy = false,
  onInvalidated,
  onSaved,
  onUnconfirmedChange,
}: Props): ReactNode {
  const context = session.currentRoleContext;
  const authorized =
    context?.scope === "GLOBAL" &&
    context.regionId === undefined &&
    context.campusId === undefined &&
    context.venueId === undefined &&
    ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"].includes(
      context.subject,
    );
  const identity = `${sessionKey}:${session.sessionId}:${session.accountId}:${session.personId}:${JSON.stringify(context)}`;
  const currentMonth =
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
    }).format(new Date()) + "-01";
  const [month, setMonth] = useState(currentMonth);
  const [roster, setRoster] = useState<ManagedBenefitRoster | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState("");
  const [document, setDocument] = useState<{
    id: string;
    version: number;
  } | null>(null);
  const [attachments, setAttachments] =
    useState<FinanceDocumentAttachments | null>(null);
  const [ready, setReady] = useState<Partial<Record<Purpose, string>>>({});
  const [uploads, setUploads] = useState<Partial<Record<Purpose, boolean>>>({});
  const [uploadingAction, setUploadingAction] = useState(false);
  const [checked, setChecked] = useState(false);
  const [reason, setReason] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const running = useRef(false);
  const documentRef = useRef<string | null>(null);
  const generateCommand = useRef<{ idempotencyKey: string } | null>(null);
  const createCommand = useRef<SalaryBenefitDocumentSubmission | null>(null);
  const confirmCommand = useRef<BenefitConfirmationSubmission | null>(null);
  const actionable =
    roster?.items.filter(
      (item) =>
        item.status === "PENDING" &&
        item.todo !== null &&
        item.execution === null,
    ) ?? [];
  const item =
    actionable.find(
      (row) => `${row.beneficiaryPersonId}:${row.benefitKind}` === selected,
    ) ?? null;
  const todoPlan = item?.todo
    ? (item.planVersions.find((plan) => plan.id === item.todo!.planVersionId) ??
      null)
    : null;
  const planDataError = Boolean(item?.todo && !todoPlan);
  const uploading = uploadingAction || purposes.some((p) => uploads[p]);
  const locked =
    busy || loading || uploading || running.current || phase !== "idle";
  const viewToken = generation.current;
  const clearDraft = (): void => {
    documentRef.current = null;
    generateCommand.current = null;
    createCommand.current = null;
    confirmCommand.current = null;
    setDocument(null);
    setAttachments(null);
    setReady({});
    setUploads({});
    setChecked(false);
    setReason("");
    setPhase("idle");
  };
  const invalidate = (e: unknown): void => {
    if (authError(e) || client.hasRoleContext === false) {
      generation.current++;
      running.current = false;
      clearDraft();
      setRoster(null);
      setLoading(false);
      setMessage("登录或身份已失效，请重新登录或选择身份。");
      onInvalidated?.();
    } else setMessage(financeError(e));
  };
  const readRoster = async (
    token = generation.current,
    preserveFact = false,
  ): Promise<void> => {
    setLoading(true);
    try {
      const next = await client.listManagedBenefitRoster(month);
      if (token === generation.current) {
        setRoster(next);
        if (preserveFact) {
          setPhase("idle");
          setMessage("此前操作已提交，最新福利待办已读取；未重复执行。");
        }
      }
    } catch (e) {
      if (token === generation.current) {
        setRoster(null);
        if (authError(e) || client.hasRoleContext === false) invalidate(e);
        else if (preserveFact) {
          setPhase("refresh-recovery");
          setMessage("操作已提交但列表刷新失败；请只重读列表，勿重新提交。");
        } else invalidate(e);
      }
    } finally {
      if (token === generation.current) setLoading(false);
    }
  };
  useEffect(() => {
    const token = ++generation.current;
    running.current = false;
    clearDraft();
    setSelected("");
    setRoster(null);
    setMessage("");
    if (authorized) void readRoster(token);
    return () => {
      generation.current++;
      running.current = false;
    };
  }, [client, identity, month, authorized]);
  useEffect(() => {
    onUnconfirmedChange?.(
      loading || phase !== "idle" || uploading || document !== null,
    );
    return () => onUnconfirmedChange?.(false);
  }, [loading, phase, uploading, document, onUnconfirmedChange]);
  const generate = async (): Promise<void> => {
    if (month !== currentMonth) {
      setMessage("待办生成仅针对北京时间当前月；历史月份请读取已有待办。");
      return;
    }
    if (
      running.current ||
      busy ||
      !["idle", "generate-unknown"].includes(phase)
    )
      return;
    const token = generation.current;
    running.current = true;
    try {
      const command =
        generateCommand.current ??
        client.createBenefitTodoGenerationSubmission();
      generateCommand.current = command;
      setPhase("generating");
      await client.generateBenefitTodos(command);
      if (token !== generation.current) return;
      generateCommand.current = null;
      setPhase("idle");
      setMessage("已生成今日到期福利待办（不扣豆）；正在刷新列表。");
      onSaved?.();
      await readRoster(token, true);
    } catch (e) {
      if (token !== generation.current) return;
      if (authError(e)) invalidate(e);
      else if (definite(e)) {
        generateCommand.current = null;
        setPhase("idle");
        invalidate(e);
      } else {
        setPhase("generate-unknown");
        invalidate(e);
      }
    } finally {
      if (token === generation.current) running.current = false;
    }
  };
  const readAttachments = async (id: string, token: number): Promise<void> => {
    const result = await client.listFinanceDocumentAttachments(id);
    if (token !== generation.current || documentRef.current !== id) return;
    if (result.documentId !== id)
      throw new Error("附件所属单据不匹配，请重新读取。");
    setAttachments(result);
  };
  const recoverRoster = async (): Promise<void> => {
    if (running.current || busy) return;
    await readRoster(generation.current, true);
  };
  const createDocument = async (): Promise<void> => {
    if (
      running.current ||
      busy ||
      !item ||
      planDataError ||
      documentRef.current ||
      !["idle", "create-unknown"].includes(phase)
    )
      return;
    const token = generation.current;
    running.current = true;
    setPhase("creating");
    try {
      const command =
        createCommand.current ??
        (() => {
          try {
            return client.createSalaryBenefitDocumentSubmission({
              kind: "FINANCE_BENEFIT",
            });
          } catch (e) {
            invalidate(e);
            throw e;
          }
        })();
      createCommand.current = command;
      const result = await client.createSalaryBenefitDocument(command);
      if (token !== generation.current) return;
      createCommand.current = null;
      documentRef.current = result.id;
      setDocument({ id: result.id, version: result.version });
      setPhase("idle");
      try {
        await readAttachments(result.id, token);
      } catch (e) {
        if (token === generation.current) invalidate(e);
      }
    } catch (e) {
      if (token !== generation.current) return;
      if (authError(e)) invalidate(e);
      else if (definite(e)) {
        createCommand.current = null;
        setPhase("idle");
        invalidate(e);
      } else {
        setPhase("create-unknown");
        invalidate(e);
      }
    } finally {
      if (token === generation.current) running.current = false;
    }
  };
  const upload = async (
    action: () => Promise<unknown>,
    id: string,
  ): Promise<void> => {
    if (
      running.current ||
      busy ||
      phase !== "idle" ||
      documentRef.current !== id
    )
      return;
    const token = generation.current;
    running.current = true;
    setUploadingAction(true);
    try {
      await action();
      if (token === generation.current) await readAttachments(id, token);
    } catch (e) {
      if (token === generation.current) invalidate(e);
    } finally {
      if (token === generation.current) {
        running.current = false;
        setUploadingAction(false);
      }
    }
  };
  const confirm = async (): Promise<void> => {
    if (
      running.current ||
      busy ||
      loading ||
      uploading ||
      !item ||
      planDataError ||
      !document ||
      !checked ||
      !reason.trim() ||
      !["idle", "confirm-unknown"].includes(phase)
    ) {
      if (!checked || !reason.trim())
        setMessage("请核对对象、金额、账户和两份原件，并填写确认理由。");
      return;
    }
    const token = generation.current;
    let command = confirmCommand.current;
    if (!command) {
      const ids = purposes.map((p) => ready[p]);
      const complete = purposes.every((purpose, index) => {
        const id = ids[index];
        return Boolean(
          id &&
          attachments?.attachments.some(
            (a) =>
              a.purpose === purpose &&
              a.versions.some(
                (v) => v.versionId === id && v.status === "READY",
              ),
          ),
        );
      });
      if (!complete) {
        setMessage("请上传并选用同一单据下两份 READY 原件。");
        return;
      }
      try {
        command = client.createBenefitConfirmationSubmission({
          documentId: document.id,
          expectedVersion: document.version,
          todoId: item.todo!.id,
          expectedPlanVersionId: item.currentPlan.id,
          reason: reason.trim(),
          attachmentVersionIds: ids as string[],
        });
      } catch (e) {
        invalidate(e);
        return;
      }
      confirmCommand.current = command;
    }
    running.current = true;
    setPhase("confirming");
    try {
      await client.confirmBenefit(command);
      if (token !== generation.current) return;
      const next = ++generation.current;
      running.current = false;
      clearDraft();
      setRoster(null);
      setMessage("已完成福利扣豆确认；仅扣财务职务账户，不扣个人账户。");
      onSaved?.();
      await readRoster(next, true);
    } catch (e) {
      if (token !== generation.current) return;
      if (authError(e)) invalidate(e);
      else if (e instanceof ApiClientError && e.status === 409) {
        confirmCommand.current = null;
        setRoster(null);
        setSelected("");
        setPhase("conflict");
        setMessage(
          "计划版本已变化，当前旧视图未视为最新；请重新读取并人工核对。确认冲突后必须新建单据和两份原件。",
        );
      } else if (definite(e)) {
        confirmCommand.current = null;
        setPhase("idle");
        invalidate(e);
      } else {
        setPhase("confirm-unknown");
        invalidate(e);
      }
    } finally {
      if (token === generation.current) running.current = false;
    }
  };
  const reconcile = async (): Promise<void> => {
    if (running.current || phase !== "conflict") return;
    const token = generation.current;
    running.current = true;
    setPhase("reconciling");
    try {
      const latest = await client.listManagedBenefitRoster(month);
      if (token !== generation.current) return;
      generation.current++;
      running.current = false;
      clearDraft();
      setSelected("");
      setRoster(latest);
      setMessage("最新待办已读取；请重新选择对象、核对当前计划并创建新凭证。");
    } catch (e) {
      if (token === generation.current) {
        setPhase("conflict");
        invalidate(e);
        running.current = false;
      }
    }
  };
  if (!authorized)
    return (
      <section className="panel" aria-label="福利扣豆确认">
        <h2>福利扣豆确认</h2>
        <p>当前身份没有福利扣豆确认权限。</p>
      </section>
    );
  return (
    <section className="panel" aria-label="福利扣豆确认">
      <h2>福利扣豆确认</h2>
      <label>
        福利月
        <input
          aria-label="确认福利月"
          type="month"
          value={month.slice(0, 7)}
          disabled={locked || document !== null}
          onChange={(e) => setMonth(`${e.target.value}-01`)}
        />
      </label>
      <button
        type="button"
        disabled={
          busy ||
          loading ||
          uploading ||
          document !== null ||
          month !== currentMonth ||
          (phase !== "idle" && phase !== "generate-unknown")
        }
        onClick={() => void generate()}
      >
        {phase === "generate-unknown"
          ? "安全重试生成待办"
          : "生成今日到期福利待办（不扣豆）"}
      </button>
      {loading && <p role="status">正在读取福利待办…</p>}
      {!loading &&
        roster === null &&
        phase !== "refresh-recovery" &&
        phase !== "conflict" && (
          <button type="button" onClick={() => void readRoster()}>
            重新读取福利待办
          </button>
        )}
      {roster && (
        <>
          <label>
            福利对象
            <select
              aria-label="确认福利对象"
              value={selected}
              disabled={locked || document !== null}
              onChange={(e) => {
                generation.current++;
                clearDraft();
                setSelected(e.target.value);
                setMessage("");
              }}
            >
              <option value="">请选择待确认对象</option>
              {actionable.map((row) => (
                <option
                  key={`${row.beneficiaryPersonId}:${row.benefitKind}`}
                  value={`${row.beneficiaryPersonId}:${row.benefitKind}`}
                >
                  {row.beneficiaryDisplayName} · {kindLabel(row.benefitKind)} ·{" "}
                  {beans(row.currentPlan.amountCents)}
                </option>
              ))}
            </select>
          </label>
          {item && (
            <>
              <p>
                待办冻结计划：v{todoPlan?.version ?? "?"} ·{" "}
                {todoPlan ? beans(todoPlan.amountCents) : "数据异常"} ·
                承担账户：{todoPlan?.sourceFund.displayName ?? "数据异常"}
              </p>
              <p>
                当前执行计划：v{item.currentPlan.version} ·{" "}
                {beans(item.currentPlan.amountCents)} · 承担账户：{" "}
                {item.currentPlan.sourceFund.displayName}。
              </p>
              {planDataError && (
                <p role="alert">待办冻结计划数据异常，禁止创建或确认。</p>
              )}
              {item.todo!.planVersionId !== item.currentPlan.id && (
                <p role="alert">待办与当前计划不同，本次按当前版本执行。</p>
              )}
              <label>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={locked}
                  onChange={(e) => setChecked(e.target.checked)}
                />
                我已核对对象、金额、账户和两份原件；确认后仅扣财务职务账户
              </label>
              <label>
                确认理由
                <textarea
                  value={reason}
                  disabled={locked}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              {document === null ? (
                <button
                  type="button"
                  disabled={
                    busy ||
                    running.current ||
                    !["idle", "create-unknown"].includes(phase) ||
                    planDataError
                  }
                  onClick={() => void createDocument()}
                >
                  {phase === "create-unknown"
                    ? "安全重试创建福利凭证"
                    : "创建福利扣豆凭证"}
                </button>
              ) : (
                <>
                  {purposes.map((p) => (
                    <AttachmentPicker
                      key={`${document.id}:${p}`}
                      client={client}
                      documentId={document.id}
                      purpose={p}
                      label={
                        p === "SUPPORTING_DOCUMENT"
                          ? "福利支持原件"
                          : "福利申请截图"
                      }
                      disabled={
                        busy ||
                        uploadingAction ||
                        purposes.some(
                          (other) => other !== p && Boolean(uploads[other]),
                        ) ||
                        phase !== "idle"
                      }
                      run={(a) => upload(a, document.id)}
                      onReady={(id) => {
                        if (
                          viewToken === generation.current &&
                          documentRef.current === document.id
                        )
                          setReady((v) => ({ ...v, [p]: id }));
                      }}
                      onPendingChange={(pending) => {
                        if (
                          viewToken === generation.current &&
                          documentRef.current === document.id
                        )
                          setUploads((v) => ({ ...v, [p]: pending }));
                      }}
                    />
                  ))}
                  {attachments === null && (
                    <button
                      type="button"
                      disabled={busy || uploading || phase !== "idle"}
                      onClick={() => {
                        const token = generation.current;
                        void readAttachments(document.id, token).catch((e) => {
                          if (
                            token === generation.current &&
                            documentRef.current === document.id
                          )
                            invalidate(e);
                        });
                      }}
                    >
                      重新读取凭证附件
                    </button>
                  )}
                  {phase === "conflict" || phase === "reconciling" ? (
                    <button
                      type="button"
                      disabled={phase === "reconciling"}
                      onClick={() => void reconcile()}
                    >
                      重新读取并人工核对
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={
                        busy ||
                        uploading ||
                        !["idle", "confirm-unknown"].includes(phase)
                      }
                      onClick={() => void confirm()}
                    >
                      {phase === "confirm-unknown"
                        ? "安全重试原确认"
                        : "确认福利扣豆"}
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}
      {(phase === "conflict" || phase === "reconciling") && (
        <button
          type="button"
          disabled={phase === "reconciling"}
          onClick={() => void reconcile()}
        >
          重新读取并人工核对
        </button>
      )}
      {phase === "refresh-recovery" && (
        <button
          type="button"
          disabled={loading || busy}
          onClick={() => void recoverRoster()}
        >
          只重读福利待办列表
        </button>
      )}
      {message && <p role="alert">{message}</p>}
    </section>
  );
}
