import { FinanceSensitiveFieldCrypto } from "@teaching-research-alliance/domain";
import type { FullBackupTransformerOptions } from "./full-backup-transformer.js";

/** Runtime composition injects keys; neither the transformer nor the engine reads environment secrets. */
export function createBackupCryptoAdapters(crypto: FinanceSensitiveFieldCrypto): FullBackupTransformerOptions {
  return {
    fingerprint: ({ domain, value }) => crypto.requestHmac(JSON.stringify(["full-backup-fingerprint.v1", domain, value])),
    decryptWithdrawalRecipient: ({ aad, ...envelope }) => crypto.decrypt(envelope, aad),
  };
}
