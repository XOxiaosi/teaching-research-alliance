import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import {
  ApiClientError,
  RoleSelectionRequiredError,
  StaleResponseError,
  formatCentsAsBeans,
  type ProjectBonusAttachment,
  type ProjectBonusPostingDetail,
  type ProjectBonusPostingSummary,
  type SessionSnapshot,
  type TeacherApiClient,
} from "@teaching-research-alliance/client";
import { downloadFinanceAttachmentToTemp } from "../../services";

type Props = Readonly<{
  client: TeacherApiClient;
  session: SessionSnapshot;
  sessionKey: string;
  busy?: boolean;
  revision?: number;
  onInvalidated?: () => void;
}>;

const authorized = (session: SessionSnapshot): boolean => {
  const context = session.currentRoleContext;
  return context !== null
    && context.scope === "GLOBAL"
    && context.regionId === undefined
    && context.campusId === undefined
    && context.venueId === undefined
    && ["HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER"].includes(context.subject);
};
const accessLost = (error: unknown, client: TeacherApiClient): boolean =>
  error instanceof RoleSelectionRequiredError
  || error instanceof ApiClientError && [401, 403].includes(error.status)
  || client.hasRoleContext === false;
const displayName = (value: string | null, fallback: string): string => value?.trim() || fallback;
const timeLabel = (value: string): string => {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date)}（北京时间）`
    : value;
};

/** Read-only project bonus history. Reversal remains a separate command. */
export function ProjectBonusHistoryPanel({
  client,
  session,
  sessionKey,
  busy = false,
  revision = 0,
  onInvalidated,
}: Props): ReactNode {
  const canRead = authorized(session);
  const context = session.currentRoleContext;
  const identity = [sessionKey, session.sessionId, session.personId, context?.subject, context?.scope, context?.regionId, context?.campusId, context?.venueId].join("|");
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const generation = useRef(0);
  const loadingRef = useRef(false);
  const downloadRequest = useRef(0);
  const [items, setItems] = useState<readonly ProjectBonusPostingSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectBonusPostingDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const invalidate = (): void => {
    generation.current += 1;
    downloadRequest.current += 1;
    loadingRef.current = false;
    setItems([]);
    setNextCursor(null);
    setDetail(null);
    setLoading(false);
    setMessage("登录或身份已失效，请重新登录或选择身份。");
    onInvalidated?.();
  };
  const fail = (error: unknown, fallback: string): void => {
    if (error instanceof StaleResponseError) return;
    if (accessLost(error, client)) {
      invalidate();
      return;
    }
    setMessage(error instanceof Error && error.message ? error.message : fallback);
  };

  const loadPage = async (cursor?: string): Promise<void> => {
    if (loadingRef.current || !canRead) return;
    const token = generation.current;
    const expectedIdentity = identity;
    loadingRef.current = true;
    setLoading(true);
    setMessage("");
    try {
      const page = await client.listManagedProjectBonuses({ ...(cursor === undefined ? {} : { cursor }), limit: 20 });
      if (token !== generation.current || identityRef.current !== expectedIdentity) return;
      setItems((current) => cursor === undefined
        ? page.items
        : [...current, ...page.items.filter((item) => !current.some((old) => old.documentId === item.documentId))]);
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (token === generation.current && identityRef.current === expectedIdentity) fail(error, "项目奖金历史读取失败，请稍后重试。");
    } finally {
      if (token === generation.current && identityRef.current === expectedIdentity) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  };

  const readDetail = async (documentId: string): Promise<void> => {
    if (loadingRef.current || !canRead) return;
    const token = generation.current;
    const expectedIdentity = identity;
    loadingRef.current = true;
    setLoading(true);
    setMessage("");
    setDetail(null);
    downloadRequest.current += 1;
    try {
      const result = await client.getManagedProjectBonusDetail(documentId);
      if (token !== generation.current || identityRef.current !== expectedIdentity) return;
      if (result.documentId !== documentId) throw new Error("项目奖金详情与所选记录不匹配。");
      setDetail(result);
    } catch (error) {
      if (token === generation.current && identityRef.current === expectedIdentity) fail(error, "项目奖金详情读取失败，请稍后重试。");
    } finally {
      if (token === generation.current && identityRef.current === expectedIdentity) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  };

  const openAttachment = (file: ProjectBonusAttachment): void => {
    const current = client.currentSession;
    const token = generation.current;
    const expectedIdentity = identity;
    const request = ++downloadRequest.current;
    if (current === null) {
      invalidate();
      return;
    }
    void downloadFinanceAttachmentToTemp(current, file.versionId)
      .then(async (result) => {
        if (client.currentSession !== current || generation.current !== token || identityRef.current !== expectedIdentity || downloadRequest.current !== request) throw new StaleResponseError();
        if (result.status === 401 || result.status === 403) {
          client.logout();
          throw new ApiClientError(result.status, "FORBIDDEN_SCOPE");
        }
        if (result.status < 200 || result.status >= 300 || !result.temporaryPath) throw new Error("DOWNLOAD_FAILED");
        if (file.mediaType === "application/pdf") await Taro.openDocument({ filePath: result.temporaryPath, fileType: "pdf", showMenu: false });
        else await Taro.previewImage({ current: result.temporaryPath, urls: [result.temporaryPath] });
      })
      .catch((error) => {
        if (generation.current === token && identityRef.current === expectedIdentity) fail(error, "原件下载失败，请重试。");
      });
  };

  useEffect(() => {
    generation.current += 1;
    downloadRequest.current += 1;
    loadingRef.current = false;
    setItems([]);
    setNextCursor(null);
    setDetail(null);
    setLoading(false);
    setMessage("");
    if (canRead) void loadPage();
    return () => {
      generation.current += 1;
      downloadRequest.current += 1;
      loadingRef.current = false;
    };
  }, [client, identity, canRead, revision]);

  if (!canRead) return <View className="panel"><Text className="panel-title">项目奖金历史</Text><Text>当前身份没有查看总部项目奖金历史的权限。</Text></View>;
  return <View className="panel">
    <Text className="panel-title">项目奖金历史</Text>
    <Text className="panel-description">项目名称和金额按发放时事实展示；成员和资金账户名称为当前显示名称。</Text>
    <Button className="quiet-button" disabled={busy || loading} onClick={() => void loadPage()}>刷新历史</Button>
    {message && <View className="notice"><Text>{message}</Text></View>}
    {!loading && items.length === 0 && !message && <Text className="panel-description">暂无已完成的项目奖金。</Text>}
    {items.map((item) => <View className="venue-board-fee" key={item.documentId}>
      <Text>项目{item.projectNo} · {item.projectName} · {formatCentsAsBeans(item.amountCents)} 欢乐豆</Text>
      <Text>{displayName(item.recipient.currentDisplayName, "原收款成员（当前名称不可用）")} · {item.status === "REVERSED" ? "已冲回" : "已发放"}</Text>
      <Text>{timeLabel(item.grantedAt)} · {item.reason}</Text>
      <Button className="quiet-button" disabled={busy || loading} onClick={() => void readDetail(item.documentId)}>查看详情</Button>
    </View>)}
    {nextCursor !== null && <Button className="quiet-button" disabled={busy || loading} onClick={() => void loadPage(nextCursor)}>加载更多</Button>}
    {detail !== null && <View className="finance-detail">
      <Text className="panel-title">奖金详情</Text>
      <Button className="quiet-button" disabled={busy || loading} onClick={() => { downloadRequest.current += 1; setDetail(null); }}>关闭详情</Button>
      <Text>状态：{detail.status === "REVERSED" ? "已冲回" : "已发放"}</Text>
      <Text>项目：项目{detail.projectNo} · {detail.projectName}</Text>
      <Text>金额：{formatCentsAsBeans(detail.amountCents)} 欢乐豆</Text>
      <Text>收款成员：{displayName(detail.recipient.currentDisplayName, "原收款成员（当前名称不可用）")}</Text>
      <Text>资金来源：{displayName(detail.source.currentDisplayName, detail.source.currentFundCode ?? "原资金账户（当前名称不可用）")}</Text>
      <Text>发放人：{displayName(detail.grantedByCurrentDisplayName, "原发放人（当前名称不可用）")}</Text>
      <Text>发放时间：{timeLabel(detail.grantedAt)}</Text>
      <Text>理由：{detail.reason}</Text>
      <Text>凭证编号：{detail.documentId}</Text>
      <AttachmentGroup title="原发放附件" files={detail.originalAttachments} onOpen={openAttachment} />
      {detail.reversal !== null && <View>
        <Text className="field-label">冲回记录</Text>
        <Text>冲回时间：{timeLabel(detail.reversal.reversedAt)}</Text>
        <Text>冲回原因：{detail.reversal.reason}</Text>
        <Text>操作人：{displayName(detail.reversal.reversedByCurrentDisplayName, "原冲回人（当前名称不可用）")}</Text>
        <AttachmentGroup title="冲回附件" files={detail.reversal.attachments} onOpen={openAttachment} />
      </View>}
      {detail.canReverse && <Text className="panel-description">当前记录符合冲回前置条件；冲回操作入口将在原笔冲回命令完成后开放。</Text>}
    </View>}
  </View>;
}

function AttachmentGroup({ title, files, onOpen }: Readonly<{
  title: string;
  files: readonly ProjectBonusAttachment[];
  onOpen: (file: ProjectBonusAttachment) => void;
}>): ReactNode {
  return <View>
    <Text>{title}（{files.length}份）</Text>
    {files.map((file) => <Button key={file.versionId} size="mini" onClick={() => onOpen(file)}>下载{file.originalFilename}</Button>)}
  </View>;
}
