import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiClientError, StaleResponseError, type TeacherApiClient, type FinanceAttachmentPurpose, type FinanceAttachmentReservationSubmission, type FinanceAttachmentReservation, type FinanceAttachmentMediaType } from "@teaching-research-alliance/client";
import { Button } from "./components/ui/button.js";

export type FinancePanelProps = {
  client: TeacherApiClient; busy: boolean; active: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
  onUnconfirmedChange: (pending: boolean) => void;
  onDataMayChange: () => void;
};
export const isFinanceAuthError = (error: unknown): boolean => error instanceof StaleResponseError || error instanceof ApiClientError && (error.status === 401 || error.status === 403);
export function financeError(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 401 || error.status === 403) return "登录或访问权限已失效，请重新登录或选择身份。";
    if (error.code.includes("INSUFFICIENT")) return "超出可用金额，请刷新余额后核对。";
    if (error.status === 409) return "记录状态已发生变化，请重新读取并核对。";
    if (error.status === 413) return "文件不能超过 20 MB。";
    if (error.status === 415 || error.status === 400) return "请检查填写内容及文件格式（PDF、PNG 或 JPEG）。";
    if (error.status === 404) return "未找到当前可访问的记录，请刷新核对。";
  }
  return "网络尚未确认结果，请保留本次内容并安全重试。";
}

/** Binary originals use the same in-memory session as JSON requests. Never expose tokens in URLs. */
export async function attachmentFetch(client: TeacherApiClient, path: string, options: RequestInit = {}): Promise<Response> {
  const session = client.currentSession;
  if (!session?.currentRoleContext) throw new ApiClientError(401, "UNAUTHENTICATED");
  const response = await fetch(path, { ...options, cache: "no-store", headers: { ...options.headers, authorization: `Bearer ${session.sessionId}` } });
  if (client.currentSession !== session) throw new StaleResponseError();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) client.logout();
    throw new ApiClientError(response.status, "ATTACHMENT_REQUEST_FAILED");
  }
  return response;
}

type Upload = { file: File; submission: FinanceAttachmentReservationSubmission; reservation?: FinanceAttachmentReservation };
type PickerProps = { client: TeacherApiClient; documentId: string; purpose: FinanceAttachmentPurpose; label: string; disabled: boolean; run: FinancePanelProps["run"]; onReady: (versionId: string) => void; onPendingChange: (pending: boolean) => void; initialFile?: File; hideFileInput?: boolean; imageOnly?: boolean };

export function AttachmentPicker({ client, documentId, purpose, label, disabled, run, onReady, onPendingChange, initialFile, hideFileInput = false, imageOnly = false }: PickerProps): ReactNode {
  const [file, setFile] = useState<File | null>(initialFile ?? null);
  const [pending, setPending] = useState<Upload | null>(null);
  const [message, setMessage] = useState("");
  const [ready, setReady] = useState(false);

  const upload = async (): Promise<void> => {
    setMessage("");
    let frozen = pending;
    try {
      if (frozen === null) {
        if (!file || file.size === 0 || file.size > 20 * 1024 * 1024 || !(imageOnly ? ["image/png", "image/jpeg"] : ["application/pdf", "image/png", "image/jpeg"]).includes(file.type)) {
          setMessage(imageOnly ? "请选择不超过 20 MB 的非空 PNG 或 JPEG 图片。" : "请选择不超过 20 MB 的非空 PDF、PNG 或 JPEG 文件。"); return;
        }
        const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
        const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        frozen = { file, submission: client.createFinanceAttachmentReservationSubmission({ documentId, purpose, originalFilename: file.name, declaredMediaType: file.type as FinanceAttachmentMediaType, declaredSizeBytes: file.size, expectedSha256: sha256 }) };
        setPending(frozen); onPendingChange(true);
      }
      if (!frozen.reservation) {
        frozen = { ...frozen, reservation: await client.reserveFinanceAttachment(frozen.submission) };
        setPending(frozen);
      }
      const versionId = frozen.reservation!.versionId;
      const current = await client.getOwnFinanceAttachmentVersion(versionId);
      if (current.status === "FAILED") {
        setPending(null); onPendingChange(false); setMessage("本次文件未通过校验，请重新选择正确文件后上传。"); return;
      }
      if (current.status !== "READY") {
        const response = await attachmentFetch(client, `/v1/finance/attachment-uploads/${encodeURIComponent(versionId)}/content`, { method: "POST", headers: { "content-type": frozen.file.type }, body: frozen.file });
        const body = await response.json();
        if (body.data?.status !== "READY") throw new Error("UPLOAD_NOT_READY");
      }
      setPending(null); onPendingChange(false); setReady(true); onReady(versionId); setMessage(`${frozen.file.name} 已完整上传。`);
    } catch (error) {
      setMessage(financeError(error));
      if (isFinanceAuthError(error)) throw error;
      if (frozen && !frozen.reservation && error instanceof ApiClientError && error.status >= 400 && error.status < 500) {
        setPending(null); onPendingChange(false);
      }
      // Even a failed follow-up read does not prove that the reservation or bytes were not stored.
      // Keep the exact file, version and key until the server confirms READY or FAILED.
    }
  };

  return <div className="finance-upload">
    {hideFileInput ? <p>{file?.name ?? label}</p> : <label>{label}<input aria-label={label} type="file" accept={imageOnly ? "image/png,image/jpeg" : "application/pdf,image/png,image/jpeg"} disabled={disabled || pending !== null || ready} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setMessage(""); }} /></label>}
    <p className="finance-muted">{imageOnly ? "PNG 或 JPEG" : "PDF、PNG 或 JPEG"}，最大 20 MB。原件将随申请保留。</p>
    {!ready && <Button type="button" variant="outline" disabled={disabled || (!file && !pending)} onClick={() => void run(upload)}>{pending ? `安全重试上传${label}` : `上传${label}`}</Button>}
    {message && <p role="status">{message}</p>}
  </div>;
}

export function AttachmentDownload({ client, versionId, filename, disabled, run }: { client: TeacherApiClient; versionId: string; filename: string; disabled: boolean; run: FinancePanelProps["run"] }): ReactNode {
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  useEffect(() => { generation.current += 1; setMessage(""); return () => { generation.current += 1; }; }, [client, versionId, filename]);
  const download = async (): Promise<void> => {
    setMessage("");
    const current = generation.current;
    try {
      const session = client.currentSession;
      const response = await attachmentFetch(client, `/v1/finance/attachments/${encodeURIComponent(versionId)}/content`);
      const blob = await response.blob();
      if (generation.current !== current) return;
      if (client.currentSession !== session) throw new StaleResponseError();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { if (generation.current !== current) return; setMessage(`下载失败。${financeError(error)}`); if (isFinanceAuthError(error)) throw error; }
  };
  return <span className="finance-download"><Button type="button" variant="ghost" disabled={disabled} onClick={() => void run(download)}>下载原件</Button>{message && <span role="alert">{message}</span>}</span>;
}
