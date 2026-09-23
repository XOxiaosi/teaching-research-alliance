import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ApiClientError,
  formatCentsAsBeans,
  RoleSelectionRequiredError,
  StaleResponseError,
  type BenefitAttachment,
  type BenefitDetail,
  type BenefitPlanVersion,
  type BenefitRosterItem,
  type ManagedBenefitRoster,
  type SessionSnapshot,
  type TeacherApiClient,
} from "@teaching-research-alliance/client";
import { Button, Picker, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { downloadFinanceAttachmentToTemp } from "../../services";

type Props = {
  client: TeacherApiClient;
  session: SessionSnapshot;
  sessionKey: string;
  busy?: boolean;
  onInvalidated?: () => void;
};

const BENEFIT_LABEL: Record<BenefitRosterItem["benefitKind"], string> = {
  SOCIAL_INSURANCE: "医社保",
  HOUSING_FUND: "公积金",
};
const STATUS_LABEL: Record<BenefitRosterItem["status"], string> = {
  INACTIVE: "未启用",
  SCHEDULED: "已排期",
  DUE_NOT_GENERATED: "待生成待办",
  PENDING: "待执行",
  COMPLETED: "已执行",
  REVERSED: "已撤销",
};

const beans = (cents: string): string => formatCentsAsBeans(cents);
const beijingTime = (value: string): string =>
  `${new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value))}（北京时间）`;
const currentBeijingMonth = (): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}-01`;
};

const isGlobalManager = (session: SessionSnapshot): boolean => {
  const context = session.currentRoleContext;
  return (
    context?.scope === "GLOBAL" &&
    context.regionId === undefined &&
    context.campusId === undefined &&
    context.venueId === undefined &&
    ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"].includes(
      context.subject,
    )
  );
};

const planText = (plan: BenefitPlanVersion): string =>
  `第 ${plan.version} 版 · ${plan.executionDay} 日执行 · ${beans(plan.amountCents)} 欢乐豆 · 资金 ${plan.sourceFund.displayName}（${plan.sourceFund.code}） · ${plan.active ? "启用" : "停用"} · ${plan.reason} · ${beijingTime(plan.changedAt)} · 变更办理人编号 ${plan.changedByPersonId}`;

const isInvalidated = (cause: unknown, client: TeacherApiClient): boolean =>
  cause instanceof RoleSelectionRequiredError ||
  (cause instanceof ApiClientError && [401, 403].includes(cause.status)) ||
  client.hasRoleContext === false;

export function BenefitPanel({
  client,
  session,
  sessionKey,
  busy = false,
  onInvalidated,
}: Props): ReactNode {
  const [month, setMonth] = useState(currentBeijingMonth);
  const [roster, setRoster] = useState<ManagedBenefitRoster | null>(null);
  const [detail, setDetail] = useState<BenefitDetail | null>(null);
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const detailRequest = useRef(0);
  const downloadRequest = useRef(0);
  const context = session.currentRoleContext;
  const canRead = isGlobalManager(session);

  const invalidate = (): void => {
    generation.current += 1;
    detailRequest.current += 1;
    downloadRequest.current += 1;
    setRoster(null);
    setDetail(null);
    setNotice("登录或身份已失效，请重新登录或选择身份。");
    onInvalidated?.();
  };
  const fail = (cause: unknown, message: string): void => {
    if (cause instanceof StaleResponseError) return;
    if (isInvalidated(cause, client)) {
      invalidate();
      return;
    }
    setNotice(message);
  };

  useEffect(() => {
    const requestGeneration = ++generation.current;
    detailRequest.current += 1;
    downloadRequest.current += 1;
    setRoster(null);
    setDetail(null);
    setNotice("");
    if (!canRead)
      return () => {
        generation.current += 1;
        detailRequest.current += 1;
        downloadRequest.current += 1;
      };
    void client
      .listManagedBenefitRoster(month)
      .then((next) => {
        if (generation.current === requestGeneration) setRoster(next);
      })
      .catch((cause) => {
        if (generation.current === requestGeneration)
          fail(cause, "福利数据读取失败，请稍后重试。");
      });
    return () => {
      generation.current += 1;
      detailRequest.current += 1;
      downloadRequest.current += 1;
    };
  }, [client, canRead, month, sessionKey]);

  const openDetail = (documentId: string): void => {
    setDetail(null);
    setNotice("");
    const request = ++detailRequest.current;
    downloadRequest.current += 1;
    const requestGeneration = generation.current;
    void client
      .getManagedBenefitDetail(documentId)
      .then((next) => {
        if (
          detailRequest.current === request &&
          generation.current === requestGeneration
        )
          setDetail(next);
      })
      .catch((cause) => {
        if (
          detailRequest.current === request &&
          generation.current === requestGeneration
        )
          fail(cause, "福利执行详情读取失败。");
      });
  };

  const openAttachment = (file: BenefitAttachment): void => {
    const current = client.currentSession;
    const requestGeneration = generation.current;
    const request = ++downloadRequest.current;
    if (!current) {
      invalidate();
      return;
    }
    void downloadFinanceAttachmentToTemp(current, file.versionId)
      .then(async (result) => {
        if (
          client.currentSession !== current ||
          generation.current !== requestGeneration ||
          downloadRequest.current !== request
        )
          throw new StaleResponseError();
        if (result.status === 401 || result.status === 403) {
          client.logout();
          throw new ApiClientError(result.status, "FORBIDDEN_SCOPE");
        }
        if (
          result.status < 200 ||
          result.status >= 300 ||
          !result.temporaryPath
        )
          throw new Error("DOWNLOAD_FAILED");
        if (file.mediaType === "application/pdf")
          await Taro.openDocument({
            filePath: result.temporaryPath,
            fileType: "pdf",
            showMenu: false,
          });
        else if (file.mediaType.startsWith("image/"))
          await Taro.previewImage({
            current: result.temporaryPath,
            urls: [result.temporaryPath],
          });
      })
      .catch((cause) => {
        if (generation.current === requestGeneration)
          fail(cause, "原件下载失败，请重试。");
      });
  };

  if (!canRead)
    return (
      <View className="panel">
        <Text className="panel-title">医社保与公积金</Text>
        <Text>当前身份没有读取总部福利数据的权限。</Text>
      </View>
    );
  return (
    <View className="panel">
      <Text className="panel-title">医社保与公积金</Text>
      <Text className="field-label">福利月份</Text>
      <Picker
        mode="date"
        fields="month"
        value={month.slice(0, 7)}
        disabled={busy}
        onChange={(event) => setMonth(`${event.detail.value}-01`)}
      >
        <View className="picker-value">
          <Text>{month.slice(0, 7)}</Text>
          <Text>⌄</Text>
        </View>
      </Picker>
      {notice && (
        <View className="notice">
          <Text>{notice}</Text>
        </View>
      )}
      {roster === null && !notice && (
        <Text className="panel-description">正在读取福利计划和执行状态…</Text>
      )}
      {roster &&
        (roster.items.length === 0 ? (
          <Text className="panel-description">本月暂无有效福利计划。</Text>
        ) : (
          roster.items.map((item) => (
            <View
              className="venue-board-fee"
              key={`${item.benefitKind}:${item.beneficiaryPersonId}`}
              onClick={() =>
                item.execution && openDetail(item.execution.documentId)
              }
            >
              <Text>
                {BENEFIT_LABEL[item.benefitKind]} ·{" "}
                {item.beneficiaryDisplayName} · {STATUS_LABEL[item.status]}
              </Text>
              <Text>当前计划：{planText(item.currentPlan)}</Text>
              <Text>
                计划历史：
                {item.planVersions.map((plan) => planText(plan)).join("；")}
              </Text>
              <Text>
                待办：
                {item.todo
                  ? `已生成（计划第${item.planVersions.find((plan) => plan.id === item.todo?.planVersionId)?.version ?? "?"}版）`
                  : "未生成"}
              </Text>
              <Text>
                实际执行：
                {item.execution
                  ? `${item.execution.status === "REVERSED" ? "已撤销" : "已执行"} · ${beans(item.execution.amountCents)} 欢乐豆 · ${item.execution.executedByDisplayName} · ${beijingTime(item.execution.executedAt)}`
                  : "尚未执行"}
              </Text>
              <Text>计划与待办本身不扣豆；确认后仅扣减财务职务账户。</Text>
            </View>
          ))
        ))}
      {detail && (
        <View className="panel">
          <Text className="panel-title">
            {BENEFIT_LABEL[detail.benefitKind]} ·{" "}
            {detail.beneficiaryDisplayName} · 执行详情
          </Text>
          <Text>
            执行状态：{detail.status === "REVERSED" ? "已撤销" : "已执行"} ·{" "}
            {beans(detail.amountCents)} 欢乐豆 · 办理人{" "}
            {detail.executedByDisplayName} · {beijingTime(detail.executedAt)}
          </Text>
          <Text>待办计划：{planText(detail.todoPlan)}</Text>
          <Text>实际执行计划：{planText(detail.executionPlan)}</Text>
          <Text>
            待办与执行计划：
            {detail.todoPlan.id === detail.executionPlan.id
              ? "一致"
              : "不同版本，以上分别展示"}
          </Text>
          <Text>待办生成：{beijingTime(detail.todo.generatedAt)}</Text>
          <Text>原执行原因：{detail.reason}</Text>
          <AttachmentGroup
            title="原执行原件"
            files={detail.attachments}
            onOpen={openAttachment}
          />
          {detail.reversal ? (
            <>
              <Text>
                撤销原因：{detail.reversal.reason} · 撤销办理人编号{" "}
                {detail.reversal.reversedByPersonId} ·{" "}
                {beijingTime(detail.reversal.reversedAt)}
              </Text>
              <AttachmentGroup
                title="撤销原件"
                files={detail.reversalAttachments}
                onOpen={openAttachment}
              />
            </>
          ) : (
            <Text>撤销：暂无</Text>
          )}
        </View>
      )}
    </View>
  );
}

function AttachmentGroup({
  title,
  files,
  onOpen,
}: {
  title: string;
  files: readonly BenefitAttachment[];
  onOpen: (file: BenefitAttachment) => void;
}): ReactNode {
  return (
    <View>
      <Text>
        {title}（{files.length}份）
      </Text>
      {files.map((file) => (
        <Button
          key={file.versionId}
          size="mini"
          onClick={(event) => {
            event.stopPropagation();
            onOpen(file);
          }}
        >
          下载{file.originalFilename}
        </Button>
      ))}
    </View>
  );
}
