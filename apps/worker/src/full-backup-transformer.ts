import { EXPORT_SCHEMA_REGISTRY } from "./export-schema-registry.js";
import {
  FULL_BACKUP_TRANSFORM_SCHEMA_VERSION,
  validateJsonTransform,
  type TransformAnomaly,
} from "./full-backup-transform-schemas.js";

type TextValue = string | null;

export type FullBackupFingerprint = (
  input: Readonly<{ domain: string; value: string }>,
) => string | Promise<string>;

export type WithdrawalRecipientDecryptor = (
  input: Readonly<{
    keyId: string;
    nonce: string;
    ciphertext: string;
    authTag: string;
    bankAccountLast4: string;
    aad: Readonly<{
      documentId: string;
      applicantPersonId: string;
      sourceAccountId: string;
      amountCents: string;
    }>;
  }>,
) =>
  | Readonly<{ recipientName: string; bankAccount: string; bankName?: string }>
  | Promise<Readonly<{ recipientName: string; bankAccount: string; bankName?: string }>>;

export type FullBackupTransformContext = Readonly<{
  withdrawalRecipient?: Readonly<{ applicantPersonId: string }>;
}>;

export type FullBackupTransformResult = Readonly<{
  values: Readonly<Record<string, TextValue>>;
  anomalies: readonly TransformAnomaly[];
  consumedTransformColumns: readonly string[];
}>;

export type FullBackupTransformerOptions = Readonly<{
  fingerprint: FullBackupFingerprint;
  decryptWithdrawalRecipient?: WithdrawalRecipientDecryptor;
}>;

const fingerprintColumns = new Set([
  "ledger_event.event_key",
  "settlement_calculation_run.request_key",
  "bonus_project_catalog_command_idempotency.idempotency_key",
  "company_finance_fund_command_idempotency.idempotency_key",
  "finance_attachment_reservation_idempotency.idempotency_key",
  "finance_draft_idempotency.idempotency_key",
  "finance_refund_command_idempotency.idempotency_key",
  "finance_reimbursement_command_idempotency.idempotency_key",
  "finance_self_purchase_command_idempotency.idempotency_key",
  "finance_withdrawal_command_idempotency.idempotency_key",
  "person_responsibility_command.idempotency_key",
  "person_profile_change.idempotency_key",
  "teacher_profile_identity_change.idempotency_key",
  "person_relationship_change.idempotency_key",
  "planning_mentor_relationship_change.idempotency_key",
  "referral_acceptance_idempotency.idempotency_key",
  "referral_creation_idempotency.idempotency_key",
  "referral_lifecycle_idempotency.idempotency_key",
  "salary_benefit_command_idempotency.idempotency_key",
  "venue_command_idempotency.idempotency_key",
  "weekly_fee_idempotency.idempotency_key",
]);

const withdrawalEnvelopeColumns = [
  "recipient_key_id",
  "recipient_nonce",
  "recipient_ciphertext",
  "recipient_auth_tag",
] as const;

const schemaGap = (): never => {
  throw new Error("EXPORT_TRANSFORM_SCHEMA_GAP");
};

const recipientFailure = (): never => {
  throw new Error("EXPORT_RECIPIENT_DECRYPT_FAILED");
};

const tableTransforms = (tableName: string): readonly string[] => {
  const found = EXPORT_SCHEMA_REGISTRY.find((candidate) => candidate.name === tableName);
  if (found === undefined) return schemaGap();
  return found.columns
    .filter((column) => column.disposition === "TRANSFORM")
    .map((column) => column.name);
};

const tableExportColumns = (tableName: string): readonly string[] => {
  const found = EXPORT_SCHEMA_REGISTRY.find((candidate) => candidate.name === tableName);
  if (found === undefined) return schemaGap();
  return found.columns
    .filter((column) => column.disposition === "EXPORT")
    .map((column) => column.name);
};

/**
 * Fixed row layout for an export dataset, including an empty dataset.  The
 * layout writer uses this rather than observing a first row, so transformed
 * columns have the same order whether or not the table has records.
 */
export const fullBackupOutputColumns = (tableName: string): readonly string[] => {
  const columns = [...tableExportColumns(tableName)];
  for (const column of tableTransforms(tableName)) {
    if (withdrawalEnvelopeColumns.includes(column as (typeof withdrawalEnvelopeColumns)[number])) {
      if (column === withdrawalEnvelopeColumns[0])
        columns.push("recipient_name", "bank_account", "bank_name");
      continue;
    }
    columns.push(fingerprintColumns.has(`${tableName}.${column}`) ? `${column}_fingerprint` : column);
  }
  return columns;
};

export const FULL_BACKUP_TRANSFORM_MANIFEST = Object.freeze({
  transformSchemaVersion: FULL_BACKUP_TRANSFORM_SCHEMA_VERSION,
  idempotencyOriginalValuesExcluded: true,
  idempotencyValuesFingerprinted: true,
  ledgerEventKeysFingerprinted: true,
  fingerprintAlgorithm: "HMAC-SHA-256",
  fingerprintEncoding: "lowercase-hex",
  withdrawalEncryptionEnvelopeExcluded: true,
  withdrawalRecipientFieldsRequireDecrypt: true,
  unknownTransformSchemaMustBeZero: true,
});

/**
 * Pure per-row transformer. It has no database or file access and cannot make a
 * backup complete; callers must provide all transform values and explicit AAD.
 */
export class FullBackupTransformer {
  public constructor(private readonly options: FullBackupTransformerOptions) {}

  public async transformRow(input: Readonly<{
    tableName: string;
    exportValues: Readonly<Record<string, TextValue>>;
    transformValues: ReadonlyMap<string, TextValue>;
    context?: FullBackupTransformContext;
  }>): Promise<FullBackupTransformResult> {
    const expected = tableTransforms(input.tableName);
    if (
      input.transformValues.size !== expected.length ||
      expected.some((column) => !input.transformValues.has(column)) ||
      [...input.transformValues.keys()].some((column) => !expected.includes(column))
    )
      schemaGap();

    const exportColumns = tableExportColumns(input.tableName);
    if (
      Object.keys(input.exportValues).length !== exportColumns.length ||
      exportColumns.some((column) => !(column in input.exportValues)) ||
      Object.keys(input.exportValues).some((column) => !exportColumns.includes(column))
    ) schemaGap();
    // Never spread caller-controlled output: only fixed registry EXPORT columns enter it.
    const values: Record<string, TextValue> = Object.fromEntries(
      exportColumns.map((column) => [column, input.exportValues[column]!]),
    );
    const anomalies: TransformAnomaly[] = [];
    const consumed: string[] = [];
    const rawRow = { ...input.exportValues };
    for (const [column, value] of input.transformValues) rawRow[column] = value;

    for (const column of expected) {
      const value = input.transformValues.get(column)!;
      const key = `${input.tableName}.${column}`;
      if (withdrawalEnvelopeColumns.includes(column as (typeof withdrawalEnvelopeColumns)[number])) {
        if (input.tableName !== "finance_withdrawal_submission") schemaGap();
        if (column !== withdrawalEnvelopeColumns[0]) continue;
        const context = input.context?.withdrawalRecipient;
        if (context === undefined || this.options.decryptWithdrawalRecipient === undefined)
          throw new Error("EXPORT_WITHDRAWAL_AAD_CONTEXT_REQUIRED");
        const envelope = Object.fromEntries(
          withdrawalEnvelopeColumns.map((name) => [name, input.transformValues.get(name)]),
        ) as Record<(typeof withdrawalEnvelopeColumns)[number], TextValue>;
        if (Object.values(envelope).some((item) => typeof item !== "string")) recipientFailure();
        const documentId = rawRow.finance_document_id;
        const sourceAccountId = rawRow.source_account_id;
        const amountCents = rawRow.amount_cents;
        if (![documentId, sourceAccountId, amountCents, context.applicantPersonId].every((item) => typeof item === "string" && item.length > 0))
          throw new Error("EXPORT_WITHDRAWAL_AAD_CONTEXT_REQUIRED");
        const recipient = await (async (): Promise<Readonly<{ recipientName: string; bankAccount: string; bankName?: string }>> => {
          try {
            return await this.options.decryptWithdrawalRecipient!({
            keyId: envelope.recipient_key_id!, nonce: envelope.recipient_nonce!,
            ciphertext: envelope.recipient_ciphertext!, authTag: envelope.recipient_auth_tag!,
            bankAccountLast4: rawRow.bank_account_last4!,
            aad: { documentId: documentId!, applicantPersonId: context.applicantPersonId, sourceAccountId: sourceAccountId!, amountCents: amountCents! },
            });
          } catch {
            return recipientFailure();
          }
        })();
        if (!recipient.recipientName || !recipient.bankAccount || recipient.bankAccount.slice(-4) !== rawRow.bank_account_last4)
          recipientFailure();
        values.recipient_name = recipient.recipientName;
        values.bank_account = recipient.bankAccount;
        values.bank_name = recipient.bankName ?? null;
        consumed.push(...withdrawalEnvelopeColumns);
        continue;
      }
      if (withdrawalEnvelopeColumns.includes(column as (typeof withdrawalEnvelopeColumns)[number])) continue;
      if (fingerprintColumns.has(key)) {
        if (typeof value !== "string") schemaGap();
        let fingerprint: string;
        try {
          fingerprint = await this.options.fingerprint({
            domain: `full-backup-transform.v1:${input.tableName}:${column}`,
            value,
          });
        } catch {
          throw new Error("EXPORT_TRANSFORM_FINGERPRINT_FAILED");
        }
        if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint) || fingerprint === value)
          throw new Error("EXPORT_TRANSFORM_FINGERPRINT_FAILED");
        values[`${column}_fingerprint`] = fingerprint;
        consumed.push(column);
        continue;
      }
      anomalies.push(...validateJsonTransform({
        tableName: input.tableName,
        columnName: column,
        raw: value,
        row: rawRow,
      }));
      values[column] = value;
      consumed.push(column);
    }
    if (consumed.length !== expected.length || new Set(consumed).size !== expected.length) schemaGap();
    return { values, anomalies, consumedTransformColumns: consumed };
  }
}
