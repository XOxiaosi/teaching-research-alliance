import test from "node:test";
import assert from "node:assert/strict";
import { EXPORT_SCHEMA_REGISTRY } from "../dist/export-schema-registry.js";
import { createFullBackupLayout } from "../dist/full-backup-layout.js";
import { validateJsonTransform } from "../dist/full-backup-transform-schemas.js";

const table = (name) => EXPORT_SCHEMA_REGISTRY.find((item) => item.name === name);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const campus = { id: id(1), campusId: id(2), regionId: id(3), validFrom: "2026-09-01T00:00:00.000Z", validTo: null, createdByPersonId: id(4), createdAt: "2026-09-01T00:00:00.000Z" };
const personAssignment = { id: id(5), personId: id(6), campusId: campus.campusId, regionId: campus.regionId, validFrom: campus.validFrom, validTo: null, createdByPersonId: id(4), createdAt: campus.createdAt };
const impact = {
  schemaVersion: "campus-region-assignment-preview.v1",
  campusId: campus.campusId,
  sourceAssignment: campus,
  targetRegionId: id(7),
  effectiveFrom: campus.validFrom,
  effectiveTo: null,
  people: [{ sourceAssignment: personAssignment, effectiveFrom: campus.validFrom, effectiveTo: null }],
  fees: [{ feeId: id(8), version: "1", teachingWeekId: id(9), settlementMonth: "2026-09-01", refunded: false, snapshotId: id(10), receiverAtCampus: true, referrerAtCampus: true }],
  reason: "校区大区归属纠正",
  financial: {
    consideredFeeCount: 1,
    changedFeeCount: 1,
    excludedRefundCount: 0,
    accountDeltas: [{ accountCode: "REGION:B", categoryKey: "regionFinance", amountCents: "100" }],
    fees: [{ feeId: id(8), version: "1", refundId: null, snapshotHash: "a".repeat(64), disposition: "CHANGE", nextContextHash: "b".repeat(64) }],
    organizationImpact: { sourceRegionId: campus.regionId, targetRegionId: id(7), recordedGrossRevenueCents: "1000", refundedGrossRevenueCents: "0", effectiveGrossRevenueCents: "1000", campusManagementFeeCents: "0" },
  },
};

test("campus region assignment tables are fixed RAW organization workbook entries", () => {
  for (const [name, orderBy] of [
    ["campus_region_assignment_change_preview", ["id"]],
    ["campus_region_assignment_change", ["id"]],
    ["campus_region_assignment_person_effect", ["change_id", "source_assignment_id"]],
    ["campus_region_assignment_settlement_effect", ["change_id", "weekly_fee_entry_id"]],
  ]) {
    assert.deepEqual(table(name)?.orderBy, orderBy);
    assert.ok(createFullBackupLayout().some((item) => item.tableName === name && item.workbookId === "01" && item.policy === "RAW_SOURCE"));
  }
  assert.equal(table("campus_region_assignment_change")?.columns.find((column) => column.name === "idempotency_key")?.disposition, "TRANSFORM");
  assert.equal(table("campus_region_assignment_settlement_effect")?.columns.find((column) => column.name === "delta_json")?.disposition, "TRANSFORM");
  assert.equal(table("campus_region_assignment")?.columns.find((column) => column.name === "superseded_by_campus_region_change_id")?.disposition, "EXPORT");
  assert.equal(table("campus_region_assignment")?.columns.find((column) => column.name === "campus_region_change_id")?.disposition, "EXPORT");
  assert.equal(table("person_campus_assignment")?.columns.find((column) => column.name === "campus_region_change_id")?.disposition, "EXPORT");
  assert.equal(table("person_campus_assignment")?.columns.find((column) => column.name === "superseded_by_campus_region_change_id")?.disposition, "EXPORT");
});

test("campus region JSON transforms reject unknown structure and retain malformed approved scalars as anomalies", () => {
  assert.deepEqual(validateJsonTransform({ tableName: "campus_region_assignment_change_preview", columnName: "impact_json", raw: JSON.stringify(impact), row: {} }), []);
  assert.deepEqual(validateJsonTransform({ tableName: "campus_region_assignment_change", columnName: "before_json", raw: JSON.stringify({ campusRegionAssignment: campus }), row: {} }), []);
  assert.deepEqual(validateJsonTransform({ tableName: "campus_region_assignment_change", columnName: "after_json", raw: JSON.stringify({ campusRegionAssignment: { id: id(11), campusId: campus.campusId, regionId: id(7), validFrom: campus.validFrom, validTo: null } }), row: {} }), []);
  assert.deepEqual(validateJsonTransform({ tableName: "campus_region_assignment_person_effect", columnName: "before_json", raw: JSON.stringify(personAssignment), row: {} }), []);
  assert.deepEqual(validateJsonTransform({ tableName: "campus_region_assignment_person_effect", columnName: "after_json", raw: JSON.stringify({ id: id(12), personId: personAssignment.personId, campusId: campus.campusId, regionId: id(7), validFrom: campus.validFrom, validTo: null }), row: {} }), []);
  assert.deepEqual(validateJsonTransform({ tableName: "campus_region_assignment_settlement_effect", columnName: "delta_json", raw: JSON.stringify({ entries: [{ accountKey: "region:B", categoryKey: "regionFinance", amountCents: "10" }] }), row: {} }), []);
  assert.deepEqual(validateJsonTransform({ tableName: "campus_region_assignment_change_preview", columnName: "impact_json", raw: JSON.stringify({ ...impact, effectiveFrom: 1 }), row: {} }), [{ code: "TRANSFORM_VALUE_ANOMALY", tableName: "campus_region_assignment_change_preview", columnName: "impact_json", field: "effectiveFrom" }]);
  assert.throws(() => validateJsonTransform({ tableName: "campus_region_assignment_change_preview", columnName: "impact_json", raw: JSON.stringify({ ...impact, password: "secret" }), row: {} }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  assert.throws(() => validateJsonTransform({ tableName: "campus_region_assignment_person_effect", columnName: "after_json", raw: JSON.stringify({ id: id(12), personId: personAssignment.personId, campusId: campus.campusId, regionId: id(7), validFrom: campus.validFrom, validTo: null, token: "secret" }), row: {} }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  assert.throws(() => validateJsonTransform({ tableName: "campus_region_assignment_settlement_effect", columnName: "delta_json", raw: JSON.stringify({ entries: [{ accountKey: "region:B", categoryKey: "ARBITRARY", amountCents: "10" }] }), row: {} }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
});
