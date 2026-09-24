import test from "node:test";
import assert from "node:assert/strict";
import { EXPORT_SCHEMA_REGISTRY } from "../dist/export-schema-registry.js";
import { createFullBackupLayout } from "../dist/full-backup-layout.js";
import { validateJsonTransform } from "../dist/full-backup-transform-schemas.js";

const table = (name) => EXPORT_SCHEMA_REGISTRY.find((item) => item.name === name);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const assignment = { id: id(1), personId: id(2), campusId: id(3), regionId: id(4), validFrom: "2026-09-01T00:00:00.000Z", validTo: null, createdByPersonId: id(2), createdAt: "2026-09-01T00:00:00.000Z" };
const principal = { id: id(5), teacherPersonId: id(2), relatedPersonId: id(6), relationshipType: "CAMPUS_PRINCIPAL", validFrom: assignment.validFrom, validTo: null, effectiveScope: "CAMPUS", createdByPersonId: id(7), createdAt: assignment.createdAt };
const impact = {
  schemaVersion: "person-campus-assignment-preview.v1",
  action: "TRANSFER",
  personId: id(2),
  sourceAssignment: assignment,
  sourceCampusPrincipalRelationship: principal,
  targetCampusId: id(8),
  targetRegionId: id(9),
  targetPrincipal: { personId: id(10), nickname: "校长", roleAssignmentId: id(11), validFrom: assignment.validFrom, validTo: null },
  effectiveFrom: assignment.validFrom,
  effectiveTo: null,
  fees: [{ feeId: id(12), version: "1", teachingWeekId: id(13), settlementMonth: "2026-09-01", refunded: false, snapshotId: null }],
  reason: "归属纠正",
  financial: {
    consideredFeeCount: 1,
    changedFeeCount: 1,
    excludedRefundCount: 0,
    accountDeltas: [{ accountCode: "CAMPUS:B", categoryKey: "campusManagement", amountCents: "100" }],
    fees: [{ feeId: id(12), version: "1", refundId: null, snapshotHash: null, disposition: "CHANGE", nextContextHash: "a".repeat(64) }],
    organizationImpact: {
      sourceCampusId: id(3),
      sourceRegionId: id(4),
      targetCampusId: id(8),
      targetRegionId: id(9),
      recordedGrossRevenueCents: "1000",
      refundedGrossRevenueCents: "0",
      effectiveGrossRevenueCents: "1000",
      campusManagementFeeCents: "100",
    },
  },
};

test("person campus assignment tables are fixed RAW organization workbook entries", () => {
  for (const [name, orderBy] of [["person_campus_assignment_change_preview", ["id"]], ["person_campus_assignment_change", ["id"]], ["person_campus_assignment_change_effect", ["change_id", "weekly_fee_entry_id"]]]) {
    assert.deepEqual(table(name)?.orderBy, orderBy);
    assert.ok(createFullBackupLayout().some((item) => item.tableName === name && item.workbookId === "01" && item.policy === "RAW_SOURCE"));
  }
  assert.equal(table("person_campus_assignment_change")?.columns.find((column) => column.name === "idempotency_key")?.disposition, "TRANSFORM");
  assert.equal(table("person_campus_assignment_change_effect")?.columns.find((column) => column.name === "delta_json")?.disposition, "TRANSFORM");
  assert.equal(table("person_campus_assignment")?.columns.find((column) => column.name === "superseded_by_person_campus_change_id")?.disposition, "EXPORT");
  assert.equal(table("person_relationship")?.columns.find((column) => column.name === "person_campus_change_id")?.disposition, "EXPORT");
});

test("person campus JSON transforms are strict and preserve only approved facts", () => {
  assert.deepEqual(validateJsonTransform({ tableName: "person_campus_assignment_change_preview", columnName: "impact_json", raw: JSON.stringify(impact), row: {} }), []);
  assert.deepEqual(validateJsonTransform({ tableName: "person_campus_assignment_change", columnName: "before_json", raw: JSON.stringify({ assignment, campusPrincipalRelationship: principal }), row: {} }), []);
  assert.deepEqual(validateJsonTransform({ tableName: "person_campus_assignment_change_effect", columnName: "delta_json", raw: JSON.stringify({ entries: [{ accountKey: "planner", categoryKey: "planningMentor", amountCents: "10" }] }), row: {} }), []);
  assert.deepEqual(validateJsonTransform({
    tableName: "audit_event",
    columnName: "after_json",
    raw: JSON.stringify({
      assignment: { id: id(14), personId: id(2), campusId: id(8), regionId: id(9), validFrom: assignment.validFrom, validTo: null },
      campusPrincipalRelationship: { id: id(15), relatedPersonId: id(10) },
    }),
    row: { subject_type: "PERSON_CAMPUS_ASSIGNMENT_CHANGE", action_code: "PERSON_CAMPUS_ASSIGNMENT_CHANGED" },
  }), []);
  assert.throws(() => validateJsonTransform({ tableName: "person_campus_assignment_change_preview", columnName: "impact_json", raw: JSON.stringify({ ...impact, password: "secret" }), row: {} }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  assert.throws(() => validateJsonTransform({ tableName: "person_campus_assignment_change", columnName: "after_json", raw: JSON.stringify({ assignment, campusPrincipalRelationship: principal, token: "secret" }), row: {} }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  assert.throws(() => validateJsonTransform({ tableName: "person_campus_assignment_change_effect", columnName: "delta_json", raw: JSON.stringify({ entries: [{ accountKey: "planner", categoryKey: "ARBITRARY", amountCents: "10" }] }), row: {} }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
});
