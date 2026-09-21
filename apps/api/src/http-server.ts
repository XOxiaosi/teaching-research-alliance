import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { API_CONTRACT_VERSION, type HttpMethod } from "@teaching-research-alliance/contracts";
import { handleRequest, type ApiServices } from "./http-handler.js";

const DEFAULT_MAX_BODY_BYTES = 1_048_576;

const jsonReplacer = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

const writeJson = (response: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body, jsonReplacer);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(payload));
  response.end(payload);
};

const readJson = async (request: IncomingMessage, maxBodyBytes: number): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBodyBytes) throw new Error("REQUEST_BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("INVALID_JSON");
  }
};

const methodFrom = (method: string | undefined): HttpMethod | undefined => {
  if (method === "GET" || method === "POST" || method === "PATCH") return method;
  return undefined;
};

export type ApiServerOptions = Readonly<{
  maxBodyBytes?: number;
}>;

export const createApiServer = (services: ApiServices, options: ApiServerOptions = {}): Server => {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  return createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "GET" && pathname === "/health") {
        writeJson(response, 200, { service: "teaching-research-alliance-api", status: "ok" });
        return;
      }
      const method = methodFrom(request.method);
      if (method === undefined) {
        writeJson(response, 405, {
          version: API_CONTRACT_VERSION,
          error: { code: "METHOD_NOT_ALLOWED", message: "METHOD_NOT_ALLOWED" }
        });
        return;
      }
      const result = await handleRequest({ method, path: pathname, body: await readJson(request, maxBodyBytes) }, services);
      writeJson(response, result.status, result.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : "INVALID_INPUT";
      const code = message.split(":", 1)[0] ?? "INVALID_INPUT";
      writeJson(response, 400, {
        version: API_CONTRACT_VERSION,
        error: { code, message }
      });
    }
  });
};
