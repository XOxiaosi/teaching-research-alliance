import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ApiClientError,
  formatCentsAsBeans,
  RoleSelectionRequiredError,
  StaleResponseError,
  type BenefitDetail,
  type BenefitRosterItem,
  type ManagedBenefitRoster,
  type SessionSnapshot,
  type TeacherApiClient,
} from "@teaching-research-alliance/client";
import { AttachmentDownload } from "./finance-shared.js";

type Props = {
  client: TeacherApiClient;
  session: SessionSnapshot;
  sessionKey: string;
  busy?: boolean;
  onInvalidated?: () => void;
};
const labels: Record<string, string> = {
  INACTIVE: "未启用",
  SCHEDULED: "已排期",
  DUE_NOT_GENERATED: "待生成待办",
  PENDING: "待执行",
  COMPLETED: "已执行",
  REVERSED: "已撤销",
};
const kinds: Record<string, string> = {
  SOCIAL_INSURANCE: "医社保",
  HOUSING_FUND: "公积金",
};
const monthNow = (): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  return `${parts.find((p) => p.type === "year")?.value ?? "2026"}-${parts.find((p) => p.type === "month")?.value ?? "01"}-01`;
};
const date = (value: string): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(value));
  const get = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
};
const todoPlanLabel = (item: BenefitRosterItem): string => {
  const plan = item.planVersions.find(
    (version) => version.id === item.todo?.planVersionId,
  );
  return plan ? `计划 v${plan.version}` : "计划版本不可识别";
};

export function BenefitPanel({
  client,
  session,
  sessionKey,
  busy = false,
  onInvalidated,
}: Props): ReactNode {
  const [month, setMonth] = useState(monthNow);
  const [roster, setRoster] = useState<ManagedBenefitRoster | null>(null);
  const [detail, setDetail] = useState<BenefitDetail | null>(null);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const detailGeneration = useRef(0);
  const context = session.currentRoleContext;
  const canRead =
    context?.scope === "GLOBAL" &&
    context.regionId === undefined &&
    context.campusId === undefined &&
    context.venueId === undefined &&
    ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"].includes(
      context.subject,
    );
  const invalid = (cause: unknown): boolean =>
    cause instanceof RoleSelectionRequiredError ||
    (cause instanceof ApiClientError && [401, 403].includes(cause.status)) ||
    client.hasRoleContext === false;
  const fail = (cause: unknown, message: string): void => {
    if (cause instanceof StaleResponseError) return;
    if (invalid(cause)) {
      generation.current += 1;
      detailGeneration.current += 1;
      setRoster(null);
      setDetail(null);
      setError("登录或身份已失效，请重新登录或选择身份。");
      onInvalidated?.();
      return;
    }
    setError(message);
  };
  useEffect(() => {
    const current = ++generation.current;
    detailGeneration.current += 1;
    setRoster(null);
    setDetail(null);
    setError("");
    if (!canRead)
      return () => {
        generation.current += 1;
        detailGeneration.current += 1;
      };
    void client
      .listManagedBenefitRoster(month)
      .then((next) => {
        if (generation.current === current) setRoster(next);
      })
      .catch((cause) => {
        if (generation.current === current)
          fail(cause, "福利数据读取失败，请稍后重试。");
      });
    return () => {
      generation.current += 1;
      detailGeneration.current += 1;
    };
  }, [client, month, sessionKey, canRead]);
  if (!canRead)
    return (
      <section className="panel" aria-label="福利管理">
        <h2>福利管理</h2>
        <p>当前身份没有读取总部福利数据的权限。</p>
      </section>
    );
  const openDetail = (documentId: string): void => {
    setDetail(null);
    setError("");
    const current = ++detailGeneration.current;
    void client
      .getManagedBenefitDetail(documentId)
      .then((next) => {
        if (detailGeneration.current === current) setDetail(next);
      })
      .catch((cause) => {
        if (detailGeneration.current === current)
          fail(cause, "福利详情读取失败，请稍后重试。");
      });
  };
  const attachmentGroup = (
    title: string,
    files: BenefitDetail["attachments"],
  ): ReactNode => (
    <div>
      <h5>{title}</h5>
      {files.length === 0 ? (
        <p>暂无原件。</p>
      ) : (
        <ul>
          {files.map((file) => (
            <li key={file.versionId}>
              {file.originalFilename}{" "}
              <AttachmentDownload
                client={client}
                versionId={file.versionId}
                filename={file.originalFilename}
                disabled={busy}
                run={async (action) => {
                  const current = generation.current;
                  try {
                    await action();
                  } catch (cause) {
                    if (generation.current === current)
                      fail(cause, "原件下载失败，请重试。");
                  }
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
  return (
    <section className="panel" aria-label="福利管理">
      <div className="section-title">
        <div>
          <span className="fee-eyebrow">BENEFITS</span>
          <h2>福利管理</h2>
        </div>
        <label>
          福利月份
          <input
            aria-label="福利月份"
            type="month"
            value={month.slice(0, 7)}
            disabled={busy}
            onInput={(event) => setMonth(`${event.currentTarget.value}-01`)}
            onChange={(event) => setMonth(`${event.currentTarget.value}-01`)}
          />
        </label>
      </div>
      <p className="fee-period-note">
        仅展示总部财务职务账户的福利扣费信息，不展示个人余额或工资。
      </p>
      {error && (
        <p className="message" role="alert">
          {error}
        </p>
      )}
      {roster === null && !error && <p role="status">正在读取福利名单…</p>}
      {roster && (
        <>
          <p className="fee-period-note">
            {roster.benefitMonth.slice(0, 7)} · 计划、待办与执行状态
          </p>
          <div className="venue-board-teachers">
            {roster.items.length === 0 && <p>本月暂无有效福利计划。</p>}
            {roster.items.map((item) => (
              <article key={`${item.benefitKind}-${item.beneficiaryPersonId}`}>
                <div className="venue-board-teacher-heading">
                  <div>
                    <h3>
                      {item.beneficiaryDisplayName} · {kinds[item.benefitKind]}
                    </h3>
                    <span>
                      {labels[item.status] ?? item.status}
                      {item.todo
                        ? ` · 待办已生成（${todoPlanLabel(item)}）`
                        : ""}
                    </span>
                  </div>
                  <strong>
                    {formatCentsAsBeans(item.currentPlan.amountCents)} 欢乐豆
                  </strong>
                </div>
                <p>计划/待办不会扣豆，仅确认后从财务职务账户扣除。</p>
                <div aria-label="当前计划">
                  <h4>当前计划 v{item.currentPlan.version}</h4>
                  <p>
                    执行日：每月 {item.currentPlan.executionDay} 日 ·{" "}
                    {formatCentsAsBeans(item.currentPlan.amountCents)} 欢乐豆 ·
                    资金账户：{item.currentPlan.sourceFund.displayName}（
                    {item.currentPlan.sourceFund.code}）·{" "}
                    {item.currentPlan.active ? "启用" : "停用"}
                  </p>
                  <p>
                    原因：{item.currentPlan.reason} · 北京时间：
                    {date(item.currentPlan.changedAt)} · 变更办理人编号：
                    {item.currentPlan.changedByPersonId}
                  </p>
                </div>
                <div aria-label="计划历史">
                  <h4>完整计划历史</h4>
                  <ul>
                    {item.planVersions.map((version) => (
                      <li key={version.id}>
                        v{version.version} · 执行日 {version.executionDay} 日 ·{" "}
                        {formatCentsAsBeans(version.amountCents)} 欢乐豆 ·
                        资金账户：{version.sourceFund.displayName}（
                        {version.sourceFund.code}）·{" "}
                        {version.active ? "启用" : "停用"} · {version.reason} ·
                        北京时间 {date(version.changedAt)} · 变更办理人编号：
                        {version.changedByPersonId}
                      </li>
                    ))}
                  </ul>
                </div>
                {item.execution && (
                  <button
                    type="button"
                    className="quiet-button"
                    onClick={() => openDetail(item.execution!.documentId)}
                  >
                    查看实际执行：
                    {labels[item.execution.status] ??
                      item.execution.status} · {date(item.execution.executedAt)}
                  </button>
                )}
              </article>
            ))}
          </div>
        </>
      )}
      {detail && (
        <div className="panel" aria-label="福利执行详情">
          <h3>
            {detail.beneficiaryDisplayName} · {kinds[detail.benefitKind]} ·
            执行详情
          </h3>
          <p>
            状态：{labels[detail.status] ?? detail.status} · 金额：
            {formatCentsAsBeans(detail.amountCents)} 欢乐豆
          </p>
          <p>
            办理人：{detail.executedByDisplayName} · 时间：
            {date(detail.executedAt)}
          </p>
          <p>原执行原因：{detail.reason}</p>
          <section>
            <h4>计划版本核对</h4>
            <p>
              待办计划：v{detail.todoPlan.version}，执行日{" "}
              {detail.todoPlan.executionDay} 日，
              {formatCentsAsBeans(detail.todoPlan.amountCents)} 欢乐豆 ·
              资金账户：
              {detail.todoPlan.sourceFund.displayName}（
              {detail.todoPlan.sourceFund.code}）·{" "}
              {detail.todoPlan.active ? "启用" : "停用"} · 原因：
              {detail.todoPlan.reason} · 北京时间{" "}
              {date(detail.todoPlan.changedAt)} · 变更办理人编号：
              {detail.todoPlan.changedByPersonId} · 待办生成：北京时间{" "}
              {date(detail.todo.generatedAt)}
            </p>
            <p>
              实际执行计划：v{detail.executionPlan.version}，执行日{" "}
              {detail.executionPlan.executionDay} 日，
              {formatCentsAsBeans(detail.executionPlan.amountCents)} 欢乐豆 ·
              资金账户：
              {detail.executionPlan.sourceFund.displayName}（
              {detail.executionPlan.sourceFund.code}）·{" "}
              {detail.executionPlan.active ? "启用" : "停用"} · 原因：
              {detail.executionPlan.reason} · 北京时间{" "}
              {date(detail.executionPlan.changedAt)} · 变更办理人编号：
              {detail.executionPlan.changedByPersonId}
            </p>
          </section>
          {detail.reversal && (
            <section>
              <h4>撤销记录</h4>
              <p>撤销原因：{detail.reversal.reason}</p>
              <p>
                撤销办理人编号：{detail.reversal.reversedByPersonId} · 时间：
                {date(detail.reversal.reversedAt)}
              </p>
            </section>
          )}
          <section aria-label="原执行原件">
            {attachmentGroup("原执行原件", detail.attachments)}
          </section>
          {detail.reversal && (
            <section aria-label="撤销原件">
              {attachmentGroup("撤销原件", detail.reversalAttachments)}
            </section>
          )}
        </div>
      )}
    </section>
  );
}
