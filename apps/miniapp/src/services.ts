import Taro from "@tarojs/taro";
import type {
  ApiEnvelope,
  FinanceAttachmentVersionMetadata,
  SessionSnapshot,
  TeacherApiTransport,
  TransportRequest
} from "@teaching-research-alliance/client";

declare const __API_BASE_URL__: string;

const apiBaseUrl = __API_BASE_URL__.replace(/\/+$/, "");

if (apiBaseUrl === "") {
  throw new Error("API_BASE_URL_REQUIRED");
}

const urlFor = (path: string): string => `${apiBaseUrl}${path}`;

const authorization = (session: SessionSnapshot): Readonly<Record<string, string>> => ({
  authorization: `Bearer ${session.sessionId}`
});

/** Taro's request implementation is injected into the shared client, keeping session rules identical to web. */
export const taroTransport: TeacherApiTransport = async <T>(request: TransportRequest) => {
  const response = await Taro.request<ApiEnvelope<T>>({
    url: urlFor(request.path),
    method: request.method,
    header: request.headers,
    ...(request.body === undefined ? {} : { data: request.body })
  });
  return { status: response.statusCode, body: response.data };
};

/** Uploads the selected ArrayBuffer as the original content; paths are used only to read bytes locally. */
export const uploadFinanceAttachmentBytes = async (
  session: SessionSnapshot,
  versionId: string,
  mediaType: string,
  bytes: ArrayBuffer
): Promise<Readonly<{ status: number; metadata?: FinanceAttachmentVersionMetadata }>> => {
  const response = await Taro.request<ApiEnvelope<FinanceAttachmentVersionMetadata>, ArrayBuffer>({
    url: urlFor(`/v1/finance/attachment-uploads/${encodeURIComponent(versionId)}/content`),
    method: "POST",
    header: { ...authorization(session), "content-type": mediaType },
    data: bytes,
    dataType: "json",
    responseType: "text"
  });
  return {
    status: response.statusCode,
    ...(response.data?.data === undefined ? {} : { metadata: response.data.data })
  };
};

/** Returns an ephemeral download path; it is not promoted into permanent miniapp storage. */
export const downloadFinanceAttachmentToTemp = async (
  session: SessionSnapshot,
  versionId: string
): Promise<Readonly<{ status: number; temporaryPath?: string }>> => {
  const response = await Taro.downloadFile({
    url: urlFor(`/v1/finance/attachments/${encodeURIComponent(versionId)}/content`),
    header: authorization(session)
  });
  return {
    status: response.statusCode,
    ...(response.tempFilePath ? { temporaryPath: response.tempFilePath } : {})
  };
};

export const readTemporaryFileBytes = async (temporaryPath: string): Promise<ArrayBuffer> => new Promise((resolve, reject) => {
  Taro.getFileSystemManager().readFile({
    filePath: temporaryPath,
    success: (result) => {
      if (!(result.data instanceof ArrayBuffer)) {
        reject(new Error("FINANCE_ATTACHMENT_BYTES_UNAVAILABLE"));
        return;
      }
      resolve(result.data);
    },
    fail: () => reject(new Error("FINANCE_ATTACHMENT_BYTES_UNAVAILABLE"))
  });
});
