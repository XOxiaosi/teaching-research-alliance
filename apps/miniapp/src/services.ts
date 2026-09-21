import Taro from "@tarojs/taro";
import type {
  ApiEnvelope,
  TeacherApiTransport,
  TransportRequest
} from "@teaching-research-alliance/client";

declare const __API_BASE_URL__: string;

const apiBaseUrl = __API_BASE_URL__.replace(/\/+$/, "");

if (apiBaseUrl === "") {
  throw new Error("API_BASE_URL_REQUIRED");
}

const urlFor = (path: string): string => `${apiBaseUrl}${path}`;

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
