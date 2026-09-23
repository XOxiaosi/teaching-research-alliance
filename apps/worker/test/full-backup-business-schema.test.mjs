import assert from "node:assert/strict";
import test from "node:test";
import { EXPORT_SCHEMA_REGISTRY } from "../dist/export-schema-registry.js";
import { FULL_BACKUP_KNOWN_COVERAGE_GAPS } from "../dist/full-backup-layout.js";
import { fullBackupOutputColumns } from "../dist/full-backup-transformer.js";
import {
  BUSINESS_BACKUP_COVERAGE_GAPS,
  BUSINESS_BACKUP_SHEETS,
  FULL_BACKUP_BUSINESS_SCHEMA_VERSION,
  createFullBackupBusinessSchema,
  validateBusinessBackupSheets,
} from "../dist/full-backup-business-schema.js";

const cloneSheets = () => JSON.parse(JSON.stringify(BUSINESS_BACKUP_SHEETS));

test("business schema is an explicit, incomplete eight-table audit baseline", () => {
  const schema = createFullBackupBusinessSchema();
  assert.equal(FULL_BACKUP_BUSINESS_SCHEMA_VERSION, "full-backup-business-schema.v5");
  assert.equal(schema.schemaVersion, FULL_BACKUP_BUSINESS_SCHEMA_VERSION);
  assert.equal(schema.mode, "BUSINESS_SCHEMA_ONLY");
  assert.equal(schema.complete, false);
  assert.deepEqual(schema.sheets.map((sheet) => sheet.tableNumber), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(schema.sheets.map((sheet) => sheet.sheetId), [
    "business_table_1", "business_table_2", "business_table_3", "business_table_4",
    "business_table_5", "business_table_6", "business_table_7", "business_table_8",
  ]);
  assert.deepEqual(schema.sheets.filter((sheet) => sheet.mode === "DERIVED_REQUIRED").map((sheet) => sheet.tableNumber), [3, 7]);
  for (const sheet of schema.sheets) {
    assert.equal(sheet.rowModel, sheet.mode === "STORED_FACTS" ? "SOURCE_ROWS_ONLY" : "DERIVED_NOT_GENERATED");
    assert.ok(sheet.rowKeyColumns.length > 0);
    assert.ok(sheet.columns.length > 0);
  }
});

test("every fixed business source and row key is an actual transformed output column, excluding authentication secrets", () => {
  const outputs = new Map(EXPORT_SCHEMA_REGISTRY.map((table) => [table.name, new Set(fullBackupOutputColumns(table.name))]));
  const secretColumns = new Set(EXPORT_SCHEMA_REGISTRY.flatMap((table) => table.columns
    .filter((column) => column.disposition === "SECRET_EXCLUDED")
    .map((column) => `${table.name}.${column.name}`)));
  for (const sheet of BUSINESS_BACKUP_SHEETS) {
    const sourceTables = new Set();
    for (const item of [...sheet.rowKeyColumns, ...sheet.columns]) {
      assert.equal(secretColumns.has(`${item.sourceTable}.${item.sourceColumn}`), false);
      assert.equal(outputs.get(item.sourceTable)?.has(item.sourceColumn), true, `${sheet.sheetId}:${item.sourceTable}.${item.sourceColumn}`);
      sourceTables.add(item.sourceTable);
    }
    const rowKeyTables = new Set(sheet.rowKeyColumns.map((item) => item.sourceTable));
    assert.equal([...sourceTables].every((sourceTable) => rowKeyTables.has(sourceTable)), true);
    for (const sourceTable of rowKeyTables) {
      const expectedKeys = EXPORT_SCHEMA_REGISTRY.find((table) => table.name === sourceTable).orderBy.map((column) => {
        const outputColumns = outputs.get(sourceTable);
        return outputColumns.has(column) ? column : `${column}_fingerprint`;
      });
      assert.deepEqual(sheet.rowKeyColumns.filter((item) => item.sourceTable === sourceTable).map((item) => item.sourceColumn), expectedKeys);
    }
  }
});

test("table 4 maps all ordinary-reimbursement transfer, approval, attachment, and command facts without making a workbook", () => {
  const table4 = BUSINESS_BACKUP_SHEETS.find((sheet) => sheet.tableNumber === 4);
  assert.ok(table4);
  assert.equal(table4.mode, "STORED_FACTS");
  assert.equal(table4.rowModel, "SOURCE_ROWS_ONLY");
  const columnsByTable = Object.fromEntries([...new Set(table4.columns.map((column) => column.sourceTable))].map((sourceTable) => [
    sourceTable,
    table4.columns.filter((column) => column.sourceTable === sourceTable).map((column) => column.sourceColumn),
  ]));
  assert.deepEqual(columnsByTable.finance_reimbursement_transfer, fullBackupOutputColumns("finance_reimbursement_transfer"));
  assert.deepEqual(new Set(columnsByTable.finance_reimbursement_reversal), new Set(fullBackupOutputColumns("finance_reimbursement_reversal")));
  assert.deepEqual(columnsByTable.finance_reimbursement_submission, fullBackupOutputColumns("finance_reimbursement_submission"));
  assert.deepEqual(columnsByTable.finance_reimbursement_decision, fullBackupOutputColumns("finance_reimbursement_decision"));
  assert.deepEqual(columnsByTable.finance_reimbursement_attachment_binding, fullBackupOutputColumns("finance_reimbursement_attachment_binding"));
  assert.deepEqual(columnsByTable.finance_reimbursement_command_idempotency, fullBackupOutputColumns("finance_reimbursement_command_idempotency"));
  assert.deepEqual(table4.rowKeyColumns.filter((key) => key.sourceTable === "finance_reimbursement_transfer").map((key) => key.sourceColumn), ["finance_document_id"]);
  assert.deepEqual(table4.rowKeyColumns.filter((key) => key.sourceTable === "finance_reimbursement_attachment_binding").map((key) => key.sourceColumn), ["finance_document_id", "stage", "finance_attachment_version_id"]);
  assert.deepEqual(table4.rowKeyColumns.filter((key) => key.sourceTable === "finance_reimbursement_command_idempotency").map((key) => key.sourceColumn), ["actor_person_id", "operation", "idempotency_key_fingerprint"]);
  assert.equal(table4.columns.filter((column) => column.sourceTable === "finance_reimbursement_transfer" && column.sourceColumn !== "authorization_snapshot").every((column) => column.relationKeyDescription.includes("同财年普通报销实际划拨事实")), true);
  assert.equal(table4.columns.some((column) => column.sourceTable === "finance_reimbursement_transfer" && column.sourceColumn === "source_after_cents" && column.relationKeyDescription.includes("可为负余额")), true);
  assert.equal(table4.columns.some((column) => column.sourceTable === "finance_reimbursement_command_idempotency" && column.sourceColumn === "idempotency_key_fingerprint"), true);
  assert.equal(table4.columns.some((column) => column.sourceTable === "finance_reimbursement_transfer" && column.sourceColumn === "authorization_snapshot" && column.relationKeyDescription.includes("白名单")), true);
});

test("table 5 maps the stored wage, bonus, document, reversal, and ledger traceability facts", () => {
  const table5 = BUSINESS_BACKUP_SHEETS.find((sheet) => sheet.tableNumber === 5);
  assert.ok(table5);
  const columnsByTable = Object.fromEntries([...new Set(table5.columns.map((column) => column.sourceTable))].map((sourceTable) => [
    sourceTable,
    table5.columns.filter((column) => column.sourceTable === sourceTable).map((column) => column.sourceColumn),
  ]));
  assert.deepEqual(columnsByTable, {
    finance_document: ["id", "applicant_person_id", "kind", "status", "version", "created_at", "updated_at"],
    cash_wage_plan_version: ["teacher_person_id", "salary_month", "version_no", "planned_cash_cents", "planned_deduction_cents", "active", "changed_by_person_id", "changed_at", "reason", "applies_to_future_months"],
    cash_wage_todo: ["teacher_person_id", "salary_month", "plan_version_id", "generated_at"],
    cash_wage_confirmation: ["finance_document_id", "todo_id", "teacher_person_id", "destination_account_id", "salary_month", "cash_paid_cents", "deduction_cents", "paid_at", "reason", "ledger_event_id", "confirmed_by_person_id", "created_at", "correction_of_finance_document_id", "destination_before_cents", "destination_after_cents"],
    project_bonus_transfer: ["finance_document_id", "project_no", "project_name", "recipient_person_id", "destination_account_id", "source_fund_id", "source_account_id", "amount_cents", "reason", "ledger_event_id", "granted_by_person_id", "created_at", "project_name_version_id"],
    bonus_project_name_version: ["project_no", "version_no", "display_name", "changed_by_person_id", "actor_subject_code", "actor_scope_type", "change_source", "reason", "created_at"],
    salary_benefit_reversal: ["reversal_finance_document_id", "original_finance_document_id", "original_ledger_event_id", "reversal_ledger_event_id", "reversed_by_person_id", "reason", "created_at"],
    ledger_entry: ["event_id", "account_id", "category_key", "amount_cents", "created_at"],
  });
  assert.deepEqual(table5.rowKeyColumns.filter((key) => key.sourceTable === "finance_document").map((key) => key.sourceColumn), ["id"]);
  const documentDescriptions = table5.columns.filter((column) => column.sourceTable === "finance_document").map((column) => column.relationKeyDescription);
  const ledgerDescriptions = table5.columns.filter((column) => column.sourceTable === "ledger_entry").map((column) => column.relationKeyDescription);
  assert.equal(documentDescriptions.every((description) => description.includes("完整关联单据事实来源") && (description.includes("不筛选") || description.includes("不声称全部行"))), true);
  assert.equal(ledgerDescriptions.every((description) => description.includes("完整关联账本事实来源") && description.includes("不筛选或聚合")), true);
  assert.equal(table5.columns.some((column) => column.sourceTable === "project_bonus_transfer" && column.sourceColumn === "project_name_version_id" && column.relationKeyDescription.includes("bonus_project_name_version.id")), true);
});

test("validation rejects duplicate sheets, duplicate mapped columns, unknown columns, and secret source columns", () => {
  const duplicateSheet = cloneSheets();
  duplicateSheet[1].sheetId = duplicateSheet[0].sheetId.toUpperCase();
  assert.throws(() => validateBusinessBackupSheets(duplicateSheet), /BUSINESS_SCHEMA_DUPLICATE_SHEET/);

  const duplicateColumn = cloneSheets();
  duplicateColumn[0].columns.push({ ...duplicateColumn[0].columns[0] });
  assert.throws(() => validateBusinessBackupSheets(duplicateColumn), /BUSINESS_SCHEMA_DUPLICATE_SOURCE_COLUMN/);

  const unknownColumn = cloneSheets();
  unknownColumn[0].columns[0].sourceColumn = "not_a_real_export_column";
  assert.throws(() => validateBusinessBackupSheets(unknownColumn), /BUSINESS_SCHEMA_UNKNOWN_SOURCE_COLUMN/);

  const secretColumn = cloneSheets();
  secretColumn[0].columns[0].sourceTable = "user_account";
  secretColumn[0].columns[0].sourceColumn = "password_hash";
  assert.throws(() => validateBusinessBackupSheets(secretColumn), /BUSINESS_SCHEMA_SECRET_SOURCE_COLUMN/);

  const unreviewedExistingColumn = cloneSheets();
  unreviewedExistingColumn[0].columns.push({
    sourceTable: "person", sourceColumn: "legal_name", label: "未审查字段", relationKeyDescription: "person.id 关联",
  });
  assert.throws(() => validateBusinessBackupSheets(unreviewedExistingColumn), /BUSINESS_SCHEMA_FIXED_COLUMN_SET_REQUIRED/);

  const missingCompositeRowKey = cloneSheets();
  missingCompositeRowKey[1].rowKeyColumns = missingCompositeRowKey[1].rowKeyColumns.filter((item) =>
    !(item.sourceTable === "referral_acceptance_snapshot" && item.sourceColumn === "accepted_referral_version"));
  assert.throws(() => validateBusinessBackupSheets(missingCompositeRowKey), /BUSINESS_SCHEMA_ROW_KEY_ORDER_REQUIRED/);
});

test("business gaps remain explicit and separate from the existing raw-source gaps", () => {
  const expected = [
    "TEACHER_PROFILE_HISTORY_NOT_IMPLEMENTED",
    "PER_TEACHER_RATE_OVERRIDE_NOT_IMPLEMENTED",
    "CLASS_TYPE_RATE_CONFIG_NOT_IMPLEMENTED",
    "PROJECT_DEDUCTION_1_TO_10_NOT_IMPLEMENTED",
    "EXTERNAL_PAYMENT_WORKFLOW_NOT_IMPLEMENTED",
    "SETTLEMENT_PUBLISHED_SNAPSHOTS_NOT_IMPLEMENTED",
    "OTHER_RELATIONSHIP_CHANGE_WORKFLOWS_NOT_IMPLEMENTED",
  ];
  assert.deepEqual(BUSINESS_BACKUP_COVERAGE_GAPS.map((gap) => gap.code), expected);
  assert.equal(BUSINESS_BACKUP_COVERAGE_GAPS.some((gap) => FULL_BACKUP_KNOWN_COVERAGE_GAPS.includes(gap.code)), false);
  for (const gap of BUSINESS_BACKUP_COVERAGE_GAPS) {
    assert.ok(gap.tableNumbers.length > 0);
    assert.ok(gap.tableNumbers.every((tableNumber) => Number.isInteger(tableNumber) && tableNumber >= 1 && tableNumber <= 8));
    assert.ok(gap.description.length > 0);
  }
  assert.deepEqual(createFullBackupBusinessSchema().rawCoverageGaps, FULL_BACKUP_KNOWN_COVERAGE_GAPS);
});
