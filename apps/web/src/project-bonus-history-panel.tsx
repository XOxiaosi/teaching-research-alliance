import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { Button } from "./components/ui/button.js";
import { AttachmentDownload, financeError } from "./finance-shared.js";
import { ReimbursementImagePreview } from "./reimbursement-image-preview.js";

type Props = Readonly<{
  client: TeacherApiClient;
  session: SessionSnapshot;
  sessionKey: string;
  active: boolean;
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

const authError = (error: unknown): boolean => error instanceof StaleResponseError
  || error instanceof RoleSelectionRequiredError
  || error instanceof ApiClientError && [401, 403].includes(error.status);

const timeLabel = (value: string): string => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : value;
};

const currentName = (value: string | null, fallback: string): string => value?.trim() || fallback;

function AttachmentRows({ client, attachments, busy, onInvalidated }: Readonly<{
  client: TeacherApiClient;
  attachments: readonly ProjectBonusAttachment[];
  busy: boolean;
  onInvalidated: (() => void) | undefined;
}>): ReactNode {
  const run = async (action: () => Promise<void>): Promise<void> => {
    try { await action(); } catch (error) { if (authError(error)) onInvalidated?.(); }
  };
  if (attachments.length === 0) return <p className="finance-muted">没有可读取的原件。</p>;
  return <div className="finance-list">{attachments.map((attachment) => <div className="finance-list-row" key={attachment.versionId}>
    <div><strong>{attachment.purpose === "SUPPORTING_DOCUMENT" ? "发放凭证" : "发放截图"}</strong><p>{attachment.originalFilename}</p></div>
    {attachment.mediaType === "image/png" || attachment.mediaType === "image/jpeg"
      ? <ReimbursementImagePreview client={client} versionId={attachment.versionId} filename={attachment.originalFilename} {...(onInvalidated === undefined ? {} : { onInvalidated })} />
      : <AttachmentDownload client={client} versionId={attachment.versionId} filename={attachment.originalFilename} disabled={busy} run={run} />}
  </div>)}</div>;
}

/** Read-only project bonus history. Reversal stays unavailable until its separate command is implemented. */
export function ProjectBonusHistoryPanel({ client, session, sessionKey, active, busy = false, revision = 0, onInvalidated }: Props): ReactNode {
  const canRead = authorized(session);
  const context = session.currentRoleContext;
  const identity = [sessionKey, session.sessionId, session.personId, context?.subject, context?.scope, context?.regionId, context?.campusId, context?.venueId].join("|");
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const generation = useRef(0);
  const loadingRef = useRef(false);
  const [items, setItems] = useState<readonly ProjectBonusPostingSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectBonusPostingDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const invalidate = (error: unknown): void => {
    if (!authError(error) && client.hasRoleContext !== false) {
      setMessage(financeError(error));
      return;
    }
    generation.current += 1;
    loadingRef.current = false;
    setItems([]);
    setNextCursor(null);
    setDetail(null);
    setLoading(false);
    setMessage("登录或身份已失效，请重新登录或选择身份。");
    onInvalidated?.();
  };

  const loadPage = async (cursor?: string): Promise<void> => {
    if (loadingRef.current || !active || !canRead) return;
    const token = generation.current;
    const expectedIdentity = identity;
    loadingRef.current = true;
    setLoading(true);
    setMessage("");
    try {
      const page = await client.listManagedProjectBonuses({ ...(cursor === undefined ? {} : { cursor }), limit: 20 });
      if (token !== generation.current || identityRef.current !== expectedIdentity) return;
      setItems((current) => cursor === undefined ? page.items : [...current, ...page.items.filter((item) => !current.some((old) => old.documentId === item.documentId))]);
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (token === generation.current && identityRef.current === expectedIdentity) invalidate(error);
    } finally {
      if (token === generation.current && identityRef.current === expectedIdentity) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  };

  const readDetail = async (documentId: string): Promise<void> => {
    if (loadingRef.current || !active || !canRead) return;
    const token = generation.current;
    const expectedIdentity = identity;
    loadingRef.current = true;
    setLoading(true);
    setMessage("");
    try {
      const result = await client.getManagedProjectBonusDetail(documentId);
      if (token !== generation.current || identityRef.current !== expectedIdentity) return;
      if (result.documentId !== documentId) throw new Error("BONUS_DETAIL_MISMATCH");
      setDetail(result);
    } catch (error) {
      if (token === generation.current && identityRef.current === expectedIdentity) invalidate(error);
    } finally {
      if (token === generation.current && identityRef.current === expectedIdentity) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    generation.current += 1;
    loadingRef.current = false;
    setItems([]);
    setNextCursor(null);
    setDetail(null);
    setLoading(false);
    setMessage("");
    if (active && canRead) void loadPage();
    return () => { generation.current += 1; loadingRef.current = false; };
  }, [client, identity, active, canRead, revision]);

  if (!canRead) return <section className="panel"><h2>项目奖金历史</h2><p>当前身份没有查看总部项目奖金历史的权限。</p></section>;
  return <section className="panel" aria-label="项目奖金历史">
    <div className="section-heading"><div><h2>项目奖金历史</h2><p>项目名称和金额按发放时事实展示；成员和资金账户名称为当前显示名称。</p></div><Button variant="outline" disabled={busy || loading} onClick={() => void loadPage()}>刷新历史</Button></div>
    {message && <p role="status" className="message">{message}</p>}
    {!loading && items.length === 0 && !message && <p className="finance-empty">暂无已完成的项目奖金。</p>}
    <div className="finance-list">{items.map((item) => <div className="finance-list-row" key={item.documentId}>
      <div><strong>项目{item.projectNo} · {item.projectName} · {formatCentsAsBeans(item.amountCents)} 欢乐豆</strong><p>{currentName(item.recipient.currentDisplayName, "原收款成员（当前名称不可用）")} · {item.status === "REVERSED" ? "已冲回" : "已发放"}</p><p>{timeLabel(item.grantedAt)} · {item.reason}</p></div>
      <Button variant="outline" disabled={busy || loading} onClick={() => void readDetail(item.documentId)}>查看详情</Button>
    </div>)}</div>
    {nextCursor !== null && <Button variant="outline" disabled={busy || loading} onClick={() => void loadPage(nextCursor)}>加载更多</Button>}
    {detail !== null && <div className="finance-detail">
      <div className="section-heading"><h3>奖金详情</h3><Button variant="ghost" disabled={busy || loading} onClick={() => setDetail(null)}>关闭详情</Button></div>
      <dl className="finance-detail"><dt>状态</dt><dd>{detail.status === "REVERSED" ? "已冲回" : "已发放"}</dd><dt>项目</dt><dd>项目{detail.projectNo} · {detail.projectName}</dd><dt>金额</dt><dd>{formatCentsAsBeans(detail.amountCents)} 欢乐豆</dd><dt>收款成员</dt><dd>{currentName(detail.recipient.currentDisplayName, "原收款成员（当前名称不可用）")}</dd><dt>资金来源</dt><dd>{currentName(detail.source.currentDisplayName, detail.source.currentFundCode ?? "原资金账户（当前名称不可用）")}</dd><dt>发放人</dt><dd>{currentName(detail.grantedByCurrentDisplayName, "原发放人（当前名称不可用）")}</dd><dt>发放时间</dt><dd>{timeLabel(detail.grantedAt)}</dd><dt>理由</dt><dd>{detail.reason}</dd><dt>凭证编号</dt><dd>{detail.documentId}</dd></dl>
      <h4>原发放附件</h4><AttachmentRows client={client} attachments={detail.originalAttachments} busy={busy || loading} onInvalidated={onInvalidated} />
      {detail.reversal !== null && <><h4>冲回记录</h4><dl className="finance-detail"><dt>冲回时间</dt><dd>{timeLabel(detail.reversal.reversedAt)}</dd><dt>冲回原因</dt><dd>{detail.reversal.reason}</dd><dt>操作人</dt><dd>{currentName(detail.reversal.reversedByCurrentDisplayName, "原冲回人（当前名称不可用）")}</dd></dl><AttachmentRows client={client} attachments={detail.reversal.attachments} busy={busy || loading} onInvalidated={onInvalidated} /></>}
      {detail.canReverse && <p className="finance-muted">当前记录符合冲回前置条件；冲回操作入口将在原笔冲回命令完成后开放。</p>}
    </div>}
  </section>;
}
