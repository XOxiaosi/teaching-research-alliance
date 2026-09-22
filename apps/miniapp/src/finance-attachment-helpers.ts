export const MAX_FINANCE_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export type FinanceAttachmentMediaType = "application/pdf" | "image/png" | "image/jpeg";

export type PickedFinanceAttachment = Readonly<{
  name: string;
  temporaryPath: string;
  bytes: ArrayBuffer;
  mediaType: FinanceAttachmentMediaType;
}>;

const startsWith = (bytes: Uint8Array, prefix: readonly number[]): boolean =>
  bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);

export const detectFinanceAttachmentMediaType = (bytes: ArrayBuffer): FinanceAttachmentMediaType | null => {
  const view = new Uint8Array(bytes);
  if (startsWith(view, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(view, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(view, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  return null;
};

/** Validate actual bytes, never a local path, filename extension, or base64 representation. */
export const createPickedFinanceAttachment = (
  name: string,
  temporaryPath: string,
  bytes: ArrayBuffer
): PickedFinanceAttachment => {
  if (!name.trim() || !temporaryPath || bytes.byteLength < 1 || bytes.byteLength > MAX_FINANCE_ATTACHMENT_BYTES) {
    throw new Error("FINANCE_ATTACHMENT_SIZE_INVALID");
  }
  const mediaType = detectFinanceAttachmentMediaType(bytes);
  if (mediaType === null) throw new Error("FINANCE_ATTACHMENT_TYPE_INVALID");
  return Object.freeze({ name, temporaryPath, bytes, mediaType });
};
