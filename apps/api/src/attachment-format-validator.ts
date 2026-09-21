import { Worker } from "node:worker_threads";
import type { AttachmentMediaType } from "./local-attachment-store.js";

export type AttachmentFormatSummary = Readonly<{mediaType: AttachmentMediaType; width?: number; height?: number; pageCount?: number}>;
export type AttachmentFormatLimits = Readonly<{timeoutMs?: number; maxImagePixels?: number; maxPdfPages?: number}>;
let activeWorkers = 0;

/** Parsing only: this neither renders a PDF nor executes its scripts or follows external links. */
export async function validateAttachmentFormat(bytes: Uint8Array, mediaType: AttachmentMediaType, limits: AttachmentFormatLimits = {}): Promise<AttachmentFormatSummary> {
  const timeoutMs = limits.timeoutMs ?? 10_000;
  const maxImagePixels = limits.maxImagePixels ?? 16_000_000;
  const maxPdfPages = limits.maxPdfPages ?? 200;
  if (bytes.byteLength < 1 || bytes.byteLength > 20 * 1024 * 1024
    || !["application/pdf","image/png","image/jpeg"].includes(mediaType)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
    || !Number.isSafeInteger(maxImagePixels) || maxImagePixels < 1 || maxImagePixels > 16_000_000
    || !Number.isSafeInteger(maxPdfPages) || maxPdfPages < 1 || maxPdfPages > 200) throw new Error("ATTACHMENT_VALIDATION_INPUT_INVALID");
  if (activeWorkers >= 2) throw new Error("ATTACHMENT_VALIDATOR_BUSY");
  activeWorkers++;
  let worker: Worker | undefined;
  try {
    worker = new Worker(new URL("./attachment-format-worker.js", import.meta.url), {
      workerData: {bytes,mediaType,maxImagePixels,maxPdfPages},
      resourceLimits: {maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16,stackSizeMb:4},
      stdout: true, stderr: true
    });
    // Parser diagnostics can include content; never forward them to application logs.
    worker.stdout.resume();worker.stderr.resume();
    const running = worker;
    return await new Promise<AttachmentFormatSummary>((resolve,reject)=>{
      const timeout = setTimeout(()=>reject(new Error("ATTACHMENT_VALIDATION_TIMEOUT")),timeoutMs);
      running.once("message",(result:{ok:boolean;summary?:AttachmentFormatSummary})=>{
        clearTimeout(timeout);
        if(result.ok && result.summary)resolve(result.summary);
        else reject(new Error("ATTACHMENT_UNREADABLE"));
      });
      running.once("error",()=>{clearTimeout(timeout);reject(new Error("ATTACHMENT_UNREADABLE"));});
      running.once("exit",()=>{clearTimeout(timeout);reject(new Error("ATTACHMENT_UNREADABLE"));});
    });
  } finally {
    try { if(worker)await worker.terminate(); } finally { activeWorkers--; }
  }
}
