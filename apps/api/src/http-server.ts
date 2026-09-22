import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { API_CONTRACT_VERSION, type HttpMethod } from "@teaching-research-alliance/contracts";
import { handleRequest, failure, type ApiServices } from "./http-handler.js";

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

const queryFrom = (url: URL): Readonly<Record<string, string>> => {
  const query: Record<string, string> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1) throw new Error("INVALID_INPUT");
    query[key] = values[0]!;
  }
  return query;
};

export type ApiServerOptions = Readonly<{
  maxBodyBytes?: number;
}>;

export const createApiServer = (services: ApiServices, options: ApiServerOptions = {}): Server => {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const pathname = url.pathname;
      if(pathname.startsWith("/v1/finance/")||pathname.startsWith("/v1/admin/company-funds")){
        response.setHeader("cache-control","private, no-store");
        response.setHeader("x-content-type-options","nosniff");
      }
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
      const authorization = request.headers.authorization;
      const bearer = authorization?.match(/^Bearer ([^\s]+)$/i);
      if (authorization !== undefined && !bearer) {
        writeJson(response, 401, { version: API_CONTRACT_VERSION, error: { code: "UNAUTHENTICATED", message: "UNAUTHENTICATED" } });
        return;
      }
      const contentPath=pathname.match(/^\/v1\/finance\/attachment-uploads\/([^/]+)\/content$/);
      if(method==="POST"&&contentPath!==null){
        // This binary route bypasses the JSON parser and its separate 1 MiB limit.
        response.setHeader("connection","close");
        const deadline=setTimeout(()=>request.destroy(new Error("ATTACHMENT_UPLOAD_TIMEOUT")),30_000);
        try{
          if(!bearer?.[1])throw new Error("UNAUTHENTICATED");
          const at=services.now();
          const session=await services.sessions.get(bearer[1],at);
          if(!session.currentRoleContext)throw new Error("ROLE_CONTEXT_REQUIRED");
          if(!services.financeAttachmentUploads)throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
          const contentType=request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
          if(!["application/octet-stream","application/pdf","image/png","image/jpeg"].includes(contentType??""))throw new Error("INVALID_INPUT");
          const data=await services.financeAttachmentUploads.upload(session.currentRoleContext,contentPath[1]!,request,at);
          writeJson(response,200,{version:API_CONTRACT_VERSION,data});
        }catch(error){
          const result=failure(error);
          if(!response.destroyed)writeJson(response,result.status,result.body);
        }finally{clearTimeout(deadline);}
        return;
      }
      const downloadPath=pathname.match(/^\/v1\/finance\/attachments\/([^/]+)\/content$/);
      if(method==="GET"&&downloadPath!==null){
        response.setHeader("cache-control","private, no-store");
        response.setHeader("x-content-type-options","nosniff");
        try{
          if(!bearer?.[1])throw new Error("UNAUTHENTICATED");
          const at=services.now();
          const session=await services.sessions.get(bearer[1],at);
          if(!session.currentRoleContext)throw new Error("ROLE_CONTEXT_REQUIRED");
          if(!services.financeAttachmentReads)throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
          const data=await services.financeAttachmentReads.readOwn(session.currentRoleContext,downloadPath[1]!,at);
          const filename=encodeURIComponent(data.originalFilename).replace(/['()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`);
          response.statusCode=200;
          response.setHeader("content-type",data.mediaType);
          response.setHeader("content-length",data.bytes.length);
          response.setHeader("content-disposition",`attachment; filename*=UTF-8''${filename}`);
          response.end(data.bytes);
        }catch(error){const result=failure(error);writeJson(response,result.status,result.body);}
        return;
      }
      const result = await handleRequest({ method, path: pathname, query: queryFrom(url), body: await readJson(request, maxBodyBytes),
        ...(bearer?.[1] === undefined ? {} : { sessionId: bearer[1] }) }, services);
      writeJson(response, result.status, result.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const code = ["INVALID_JSON", "REQUEST_BODY_TOO_LARGE", "INVALID_INPUT"].includes(message) ? message : "INTERNAL_ERROR";
      writeJson(response, code === "INTERNAL_ERROR" ? 500 : 400, {
        version: API_CONTRACT_VERSION,
        error: { code, message: code }
      });
    }
  });
};
