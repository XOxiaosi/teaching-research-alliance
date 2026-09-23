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
    "REIMBURSEMENT_TRANSFER_NOT_IMPLEMENTED",
    "EXTERNAL_PAYMENT_WORKFLOW_NOT_IMPLEMENTED",
    "SETTLEMENT_PUBLISHED_SNAPSHOTS_NOT_IMPLEMENTED",
    "RELATIONSHIP_CHANGE_PREVIEW_BATCH_NOT_IMPLEMENTED",
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
