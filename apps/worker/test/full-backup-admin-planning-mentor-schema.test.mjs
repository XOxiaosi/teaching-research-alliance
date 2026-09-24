import test from "node:test";
import assert from "node:assert/strict";
import { EXPORT_SCHEMA_REGISTRY } from "../dist/export-schema-registry.js";
import { createFullBackupLayout } from "../dist/full-backup-layout.js";
import { validateJsonTransform } from "../dist/full-backup-transform-schemas.js";

const table = (name) => EXPORT_SCHEMA_REGISTRY.find((item) => item.name === name);
const relationship = {
  id: "00000000-0000-4000-8000-000000000001", teacherPersonId: "00000000-0000-4000-8000-000000000002",
  relationshipType: "PLANNING_MENTOR", relatedPersonId: "00000000-0000-4000-8000-000000000003",
  validFrom: "2026-09-21T00:00:00.000Z", validTo: null, effectiveScope: "REGULAR_WEEK:week",
  createdByPersonId: "00000000-0000-4000-8000-000000000004", createdAt: "2026-09-21T00:00:00.000Z",
  supersededAt: null, supersededByChangeId: null, supersededByPlanningMentorChangeId: null,
  supersededByAdminPlanningMentorChangeId: null,
};

const impact = {
  schemaVersion: "admin-planning-mentor-relationship-preview.v1", action: "REPLACE",
  mentorPersonId: relationship.relatedPersonId, plannerPersonId: relationship.teacherPersonId,
  sourceRelationship: relationship, resultRelationshipId: "00000000-0000-4000-8000-000000000005", continuationRelationshipId: "00000000-0000-4000-8000-000000000011",
  actorRoleAssignmentId: "00000000-0000-4000-8000-000000000006", actorRoleScopeId: null,
  destinationMentorAccount: { id: "00000000-0000-4000-8000-000000000007", code: "mentor-account", ownerId: relationship.relatedPersonId, status: "ACTIVE" },
  plannerAccount: { id: "00000000-0000-4000-8000-000000000008", code: "planner-account", ownerId: relationship.teacherPersonId, status: "ACTIVE" },
  week: { id: "00000000-0000-4000-8000-000000000009", startsOn: "2026-09-21", endsOn: "2026-09-27", settlementMonth: "2026-09-01" },
  effectiveAt: "2026-09-20T16:00:00.000Z", nextBoundaryAt: "2026-10-04T16:00:00.000Z",
  effectiveThroughTeachingWeekId: "00000000-0000-4000-8000-000000000010", reason: "管理员更换规划导师", fees: [],
  totals: { consideredFeeCount: 0, changedFeeCount: 0, zeroShareFeeCount: 0, excludedRefundCount: 0, plannerDeltaCents: "0", sourceMentorDeltaCents: "0", destinationMentorDeltaCents: "0" },
};

test("admin planning mentor relationship tables are fixed RAW/F01 registry entries", () => {
  for (const [name, orderBy] of [
    ["admin_planning_mentor_relationship_change_preview", ["id"]],
    ["admin_planning_mentor_relationship_change", ["id"]],
    ["admin_planning_mentor_relationship_change_effect", ["change_id", "weekly_fee_entry_id"]],
  ]) {
    const entry = table(name);
    assert.ok(entry, name);
    assert.deepEqual(entry.orderBy, orderBy);
    assert.ok(createFullBackupLayout().some((item) => item.tableName === name && item.workbookId === "01" && item.policy === "RAW_SOURCE"));
  }
  assert.equal(table("admin_planning_mentor_relationship_change").columns.find((column) => column.name === "idempotency_key")?.disposition, "TRANSFORM");
  assert.equal(table("admin_planning_mentor_relationship_change_effect").columns.find((column) => column.name === "delta_json")?.disposition, "TRANSFORM");
  assert.equal(table("person_relationship").columns.find((column) => column.name === "superseded_by_admin_planning_mentor_change_id")?.disposition, "EXPORT");
});

test("admin planning mentor JSON and idempotency transforms preserve known facts and reject unmodelled data", () => {
  const previewRow = { action: "REPLACE", effective_through_teaching_week_id: impact.effectiveThroughTeachingWeekId };
  assert.deepEqual(validateJsonTransform({ tableName: "admin_planning_mentor_relationship_change_preview", columnName: "impact_json", raw: JSON.stringify(impact), row: previewRow }), []);
  assert.deepEqual(validateJsonTransform({ tableName: "admin_planning_mentor_relationship_change", columnName: "before_json", raw: JSON.stringify({ sourceRelationship: relationship }), row: { action: "REPLACE" } }), []);
  assert.deepEqual(validateJsonTransform({ tableName: "admin_planning_mentor_relationship_change", columnName: "after_json", raw: JSON.stringify({ sourceRelationship: relationship, resultRelationship: relationship, continuationRelationship: null }), row: { action: "REPLACE" } }), []);
  assert.deepEqual(validateJsonTransform({ tableName: "admin_planning_mentor_relationship_change", columnName: "before_json", raw: JSON.stringify({ sourceRelationship: null }), row: { action: "ADD" } }), []);
  assert.deepEqual(validateJsonTransform({ tableName: "admin_planning_mentor_relationship_change", columnName: "after_json", raw: JSON.stringify({ sourceRelationship: null, resultRelationship: relationship, continuationRelationship: null }), row: { action: "ADD" } }), []);
  assert.deepEqual(validateJsonTransform({ tableName: "admin_planning_mentor_relationship_change_effect", columnName: "delta_json", raw: JSON.stringify({ entries: [{ accountKey: "planningMentor", categoryKey: "planningMentor", amountCents: "10" }] }), row: {} }), []);
  assert.deepEqual(validateJsonTransform({ tableName: "audit_event", columnName: "before_json", raw: JSON.stringify({ sourceRelationship: null }), row: { subject_type: "PERSON_RELATIONSHIP", action_code: "PLANNING_MENTOR_RELATIONSHIP_ADDED_BY_ADMIN" } }), []);
  assert.deepEqual(validateJsonTransform({ tableName: "audit_event", columnName: "after_json", raw: JSON.stringify({ sourceRelationship: null, resultRelationship: relationship, continuationRelationship: null }), row: { subject_type: "PERSON_RELATIONSHIP", action_code: "PLANNING_MENTOR_RELATIONSHIP_ADDED_BY_ADMIN" } }), []);
  assert.deepEqual(validateJsonTransform({ tableName: "audit_event", columnName: "before_json", raw: JSON.stringify({ sourceRelationship: relationship }), row: { subject_type: "PERSON_RELATIONSHIP", action_code: "PLANNING_MENTOR_RELATIONSHIP_REPLACED_BY_ADMIN" } }), []);
  assert.deepEqual(validateJsonTransform({ tableName: "audit_event", columnName: "after_json", raw: JSON.stringify({ sourceRelationship: relationship, resultRelationship: relationship, continuationRelationship: null }), row: { subject_type: "PERSON_RELATIONSHIP", action_code: "PLANNING_MENTOR_RELATIONSHIP_REPLACED_BY_ADMIN" } }), []);
  assert.deepEqual(validateJsonTransform({ tableName: "audit_event", columnName: "before_json", raw: JSON.stringify({ sourceRelationship: relationship }), row: { subject_type: "PERSON_RELATIONSHIP", action_code: "PLANNING_MENTOR_RELATIONSHIP_REMOVED_BY_ADMIN" } }), []);
  assert.deepEqual(validateJsonTransform({ tableName: "audit_event", columnName: "after_json", raw: JSON.stringify({ sourceRelationship: relationship, resultRelationship: null, continuationRelationship: null }), row: { subject_type: "PERSON_RELATIONSHIP", action_code: "PLANNING_MENTOR_RELATIONSHIP_REMOVED_BY_ADMIN" } }), []);
  assert.throws(() => validateJsonTransform({ tableName: "admin_planning_mentor_relationship_change_preview", columnName: "impact_json", raw: JSON.stringify({ ...impact, password: "secret" }), row: previewRow }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  assert.throws(() => validateJsonTransform({ tableName: "admin_planning_mentor_relationship_change_preview", columnName: "impact_json", raw: JSON.stringify({ ...impact, effectiveThroughTeachingWeekId: null }), row: previewRow }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  assert.throws(() => validateJsonTransform({ tableName: "admin_planning_mentor_relationship_change", columnName: "after_json", raw: JSON.stringify({ ...relationship, token: "secret" }), row: { action: "REPLACE" } }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  assert.throws(() => validateJsonTransform({ tableName: "admin_planning_mentor_relationship_change_effect", columnName: "delta_json", raw: JSON.stringify({ entries: [{ accountKey: "planningMentor", categoryKey: "ARBITRARY", amountCents: "10" }] }), row: {} }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
});
