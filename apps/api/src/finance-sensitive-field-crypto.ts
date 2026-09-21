import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

export type FinancialRecipient = Readonly<{ recipientName: string; bankAccount: string; bankName?: string }>;
export type FinancialRecipientContext = Readonly<{
  documentId: string; applicantPersonId: string; sourceAccountId: string; amountCents: string;
}>;
export type EncryptedFinancialRecipient = Readonly<{
  keyId: string; nonce: string; ciphertext: string; authTag: string; bankAccountLast4: string;
}>;

const validText = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
export const validateFinancialRecipient = (recipient: FinancialRecipient): void => {
  if (!validText(recipient.recipientName, 200) || !validText(recipient.bankAccount, 256)
    || (recipient.bankName !== undefined && !validText(recipient.bankName, 200))) throw new Error("INVALID_INPUT");
};
const additionalData = (context: FinancialRecipientContext): Buffer => Buffer.from(JSON.stringify([
  "finance-recipient.v1", context.documentId, context.applicantPersonId, context.sourceAccountId, context.amountCents
]));
const decodeHex = (value: string, length?: number): Buffer => {
  if (!/^(?:[0-9a-f]{2})+$/.test(value) || (length !== undefined && value.length !== length * 2)) throw new Error("FINANCE_RECIPIENT_INTEGRITY_FAILED");
  return Buffer.from(value, "hex");
};

/** Keys are provided by the runtime; no fallback key or bank plaintext is persisted in logs or audit records. */
export class FinanceSensitiveFieldCrypto {
  private readonly keys = new Map<string, Buffer>();
  public constructor(public readonly activeKeyId: string, keys: Readonly<Record<string, string>>) {
    for (const [id, hex] of Object.entries(keys)) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("FINANCE_KEY_CONFIG_INVALID");
      this.keys.set(id, Buffer.from(hex, "hex"));
    }
    if (!this.keys.has(activeKeyId)) throw new Error("FINANCE_KEY_CONFIG_INVALID");
  }
  private key(id: string): Buffer {
    const value = this.keys.get(id);
    if (!value) throw new Error("FINANCE_KEY_UNAVAILABLE");
    return value;
  }
  public encrypt(recipient: FinancialRecipient, context: FinancialRecipientContext): EncryptedFinancialRecipient {
    validateFinancialRecipient(recipient);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(this.activeKeyId), nonce);
    cipher.setAAD(additionalData(context));
    // Select known fields so callers cannot persist extra private values by spreading a request body.
    const plaintext = JSON.stringify([recipient.recipientName, recipient.bankAccount, recipient.bankName ?? null]);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { keyId: this.activeKeyId, nonce: nonce.toString("hex"), ciphertext: ciphertext.toString("hex"),
      authTag: cipher.getAuthTag().toString("hex"), bankAccountLast4: recipient.bankAccount.slice(-4) };
  }
  public decrypt(encrypted: EncryptedFinancialRecipient, context: FinancialRecipientContext): FinancialRecipient {
    const key = this.key(encrypted.keyId);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, decodeHex(encrypted.nonce, 12));
      decipher.setAAD(additionalData(context));
      decipher.setAuthTag(decodeHex(encrypted.authTag, 16));
      const plaintext = Buffer.concat([decipher.update(decodeHex(encrypted.ciphertext)), decipher.final()]);
      const fields: unknown = JSON.parse(plaintext.toString("utf8"));
      if (!Array.isArray(fields) || fields.length !== 3) throw new Error();
      const recipient = { recipientName: fields[0], bankAccount: fields[1], ...(fields[2] === null ? {} : { bankName: fields[2] }) } as FinancialRecipient;
      validateFinancialRecipient(recipient);
      if (recipient.bankAccount.slice(-4) !== encrypted.bankAccountLast4) throw new Error();
      return recipient;
    } catch { throw new Error("FINANCE_RECIPIENT_INTEGRITY_FAILED"); }
  }
  /** Persist the key ID alongside the digest so retries remain comparable after active-key rotation. */
  public requestHmac(canonicalRequest: string, keyId = this.activeKeyId): string {
    const subkey = createHmac("sha256", this.key(keyId)).update("finance-command-idempotency.v1").digest();
    return createHmac("sha256", subkey).update(canonicalRequest).digest("hex");
  }
}
