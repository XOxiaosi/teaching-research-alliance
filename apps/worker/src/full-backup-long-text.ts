import { createHash } from "node:crypto";

export const BACKUP_TEXT_CHUNK_UNITS = 32_000;
export type BackupLongText = Readonly<{
  reference: string;
  sha256: string;
  utf16Length: number;
  chunks: readonly string[];
}>;

/** Excel cannot preserve illegal XML code points; fail rather than strip them. */
export function assertBackupXmlText(text: string): void {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u.test(text) ||
      /[\uD800-\uDFFF]/u.test(text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, ""))) {
    throw new Error("EXPORT_ILLEGAL_XML_TEXT");
  }
}

/** A content reference is accompanied by coordinates in the caller's long-text sheet. */
export function splitBackupLongText(text: string): BackupLongText | null {
  assertBackupXmlText(text);
  if (text.length <= BACKUP_TEXT_CHUNK_UNITS) return null;
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  const chunks: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + BACKUP_TEXT_CHUNK_UNITS, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return { reference: `long_text_ref:sha256:${sha256}`, sha256, utf16Length: text.length, chunks };
}

export function restoreBackupLongText(value: BackupLongText): string {
  if (value.chunks.length === 0 || value.chunks.some(chunk => chunk.length === 0 || chunk.length > BACKUP_TEXT_CHUNK_UNITS)) {
    throw new Error("EXPORT_LONG_TEXT_INTEGRITY_FAILED");
  }
  for (const chunk of value.chunks) assertBackupXmlText(chunk);
  const text = value.chunks.join("");
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  if (text.length !== value.utf16Length || digest !== value.sha256 || value.reference !== `long_text_ref:sha256:${digest}`) {
    throw new Error("EXPORT_LONG_TEXT_INTEGRITY_FAILED");
  }
  return text;
}
