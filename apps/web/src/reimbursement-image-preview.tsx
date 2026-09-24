import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiClientError, type TeacherApiClient } from "@teaching-research-alliance/client";
import { attachmentFetch } from "./finance-shared.js";

type Props = Readonly<{
  client: TeacherApiClient;
  versionId: string;
  filename: string;
  onInvalidated?: () => void;
}>;

/** Fetches private original bytes through the active session and releases the temporary URL. */
export function ReimbursementImagePreview({ client, versionId, filename, onInvalidated }: Props): ReactNode {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const invalidatedCallback = useRef(onInvalidated);
  invalidatedCallback.current = onInvalidated;

  useEffect(() => {
    let canceled = false;
    let url: string | null = null;
    setImageUrl(null);
    setOpen(false);
    setFailed(false);
    void (async () => {
      try {
        const response = await attachmentFetch(client, `/v1/finance/attachments/${encodeURIComponent(versionId)}/content`);
        if (!["image/png", "image/jpeg"].includes(response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "")) throw new Error("NOT_IMAGE");
        const blob = await response.blob();
        if (canceled) return;
        url = URL.createObjectURL(blob);
        setImageUrl(url);
      } catch (error) {
        if (!canceled) {
          if (error instanceof ApiClientError && (error.status === 401 || error.status === 403) && client.currentSession === null) invalidatedCallback.current?.();
          setFailed(true);
        }
      }
    })();
    return () => {
      canceled = true;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [client, versionId]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent): void => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  return <span className="reimbursement-image-preview">
    {imageUrl !== null
      ? <button type="button" className="reimbursement-thumbnail" onClick={() => setOpen(true)} aria-label={`放大查看${filename}`}><img src={imageUrl} alt={`${filename}缩略图`} /></button>
      : <span className="finance-muted">{failed ? "图片预览不可用" : "图片预览加载中…"}</span>}
    {open && imageUrl !== null && <div className="reimbursement-lightbox" role="dialog" aria-modal="true" aria-label={`${filename}大图预览`}>
      <button type="button" className="reimbursement-lightbox-close" onClick={() => setOpen(false)} aria-label="关闭图片预览">关闭</button>
      <img src={imageUrl} alt={filename} />
    </div>}
  </span>;
}
