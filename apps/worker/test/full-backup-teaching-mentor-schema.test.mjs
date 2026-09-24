import test from "node:test";
import assert from "node:assert/strict";
import { EXPORT_SCHEMA_REGISTRY } from "../dist/export-schema-registry.js";
import { createFullBackupLayout } from "../dist/full-backup-layout.js";
import { validateJsonTransform } from "../dist/full-backup-transform-schemas.js";

const table = (name) => EXPORT_SCHEMA_REGISTRY.find((item) => item.name === name);

const relationship = {
  id: "00000000-0000-4000-8000-000000000001", teacherPersonId: "00000000-0000-4000-8000-000000000002",
  relationshipType: "TEACHING_MENTOR", relatedPersonId: "00000000-0000-4000-8000-000000000003",
  validFrom: "2026-09-21T00:00:00.000Z", validTo: null, effectiveScope: "REGULAR_WEEK:week",
  createdByPersonId: "00000000-0000-4000-8000-000000000004", createdAt: "2026-09-21T00:00:00.000Z",
  supersededAt: null, supersededByChangeId: null,
};

test("teaching mentor change tables and supersession key are fixed RAW registry entries", () => {
  for (const [name, orderBy] of [
    ["teaching_mentor_relationship_change_preview", ["id"]],
    ["teaching_mentor_relationship_change", ["id"]],
    ["teaching_mentor_relationship_change_effect", ["change_id", "weekly_fee_entry_id"]],
  ]) {
    const entry = table(name);
    assert.ok(entry, name);
    assert.deepEqual(entry.orderBy, orderBy);
    assert.ok(entry.columns.length > 0);
    assert.ok(createFullBackupLayout().some((item) => item.tableName === name && item.policy === "RAW_SOURCE"));
  }
  assert.equal(table("teaching_mentor_relationship_change").columns.find((column) => column.name === "idempotency_key")?.disposition, "TRANSFORM");
  assert.ok(table("teaching_mentor_relationship_change_preview").columns.some((column) => column.name === "effective_through_teaching_week_id"));
  assert.ok(table("teaching_mentor_relationship_change").columns.some((column) => column.name === "continuation_relationship_id"));
  assert.equal(table("person_relationship").columns.find((column) => column.name === "superseded_by_teaching_mentor_change_id")?.disposition, "EXPORT");
});

test("teaching mentor impact and relationship snapshots allow only known facts", () => {
  const nextRelationship = { ...relationship, id: "00000000-0000-4000-8000-000000000009", relatedPersonId: "00000000-0000-4000-8000-000000000008" };
  const impact = {
    schemaVersion: "teaching-mentor-change-preview.v1", teacherPersonId: relationship.teacherPersonId,
    effectiveWeek: { id: "00000000-0000-4000-8000-000000000005", startsOn: "2026-09-21", endsOn: "2026-09-27", settlementMonth: "2026-09-01", kind: "REGULAR" },
    effectiveAt: "2026-09-20T16:00:00.000Z", nextBoundaryAt: null, effectiveThroughTeachingWeekId: null, sourceRelationship: relationship, nextRelationship: null,
    candidate: { personId: "00000000-0000-4000-8000-000000000008", nickname: "新教学导师", userAccountId: "00000000-0000-4000-8000-000000000006", roleAssignmentId: "00000000-0000-4000-8000-000000000007", roleValidFrom: "2026-01-01T00:00:00.000Z", roleValidTo: null },
    destinationAccount: { id: "00000000-0000-4000-8000-000000000010", code: "mentor-account", ownerType: "PERSON", ownerId: "00000000-0000-4000-8000-000000000008", status: "ACTIVE" },
    reason: "教学导师调整", fees: [{ feeEntryId: "00000000-0000-4000-8000-000000000011", feeVersion: "1", grossAmountCents: "1000", teachingWeekId: "00000000-0000-4000-8000-000000000005", weekStartsOn: "2026-09-21", settlementMonth: "2026-09-01", disposition: "MOVE", refundEffectId: null, previousSnapshotId: "00000000-0000-4000-8000-000000000012", previousSnapshotSequence: "1", previousSnapshotHash: "a".repeat(64), policyVersionId: "00000000-0000-4000-8000-000000000013", netMonthlyCents: "1000", teachingMentorAmountCents: "50", sourceAccountId: "00000000-0000-4000-8000-000000000014", sourceAccountCode: "old-mentor" }],
    totals: { consideredFeeCount: 1, movedFeeCount: 1, zeroShareFeeCount: 0, excludedRefundCount: 0, movedAmountCents: "50" },
  };
  assert.deepEqual(validateJsonTransform({ tableName: "teaching_mentor_relationship_change_preview", columnName: "impact_json", raw: JSON.stringify(impact), row: { action: "REPLACE" } }), []);
  assert.deepEqual(validateJsonTransform({ tableName: "teaching_mentor_relationship_change_preview", columnName: "impact_json", raw: JSON.stringify({ ...impact, sourceRelationship: null }), row: { action: "ADD" } }), []);
  assert.deepEqual(validateJsonTransform({ tableName: "teaching_mentor_relationship_change", columnName: "before_json", raw: JSON.stringify({ sourceRelationship: relationship }), row: { action: "REPLACE" } }), []);
  assert.deepEqual(validateJsonTransform({ tableName: "teaching_mentor_relationship_change", columnName: "after_json", raw: JSON.stringify({ sourceRelationship: { ...relationship, supersededAt: "2026-09-20T16:00:00.000Z", supersededByChangeId: "00000000-0000-4000-8000-000000000015" }, resultRelationship: nextRelationship }), row: { action: "REPLACE" } }), []);
  const continuationId = "00000000-0000-4000-8000-000000000016";
  const continuationRelationship = { ...relationship, id: continuationId, validFrom: "2026-10-04T16:00:00.000Z", validTo: null, createdAt: "2026-09-23T08:00:00.000Z" };
  assert.deepEqual(validateJsonTransform({ tableName: "teaching_mentor_relationship_change", columnName: "after_json", raw: JSON.stringify({ sourceRelationship: relationship, resultRelationship: nextRelationship, continuationRelationship }), row: { action: "REPLACE", continuation_relationship_id: continuationId, teacher_person_id: relationship.teacherPersonId, source_related_person_id: relationship.relatedPersonId, next_boundary_at: "2026-10-04 16:00:00+00", published_by_person_id: relationship.createdByPersonId, published_at: "2026-09-23 08:00:00+00" } }), []);
  assert.deepEqual(validateJsonTransform({ tableName: "teaching_mentor_relationship_change", columnName: "before_json", raw: JSON.stringify({ sourceRelationship: null }), row: { action: "ADD" } }), []);
  assert.deepEqual(validateJsonTransform({ tableName: "teaching_mentor_relationship_change", columnName: "after_json", raw: JSON.stringify({ sourceRelationship: null, resultRelationship: nextRelationship }), row: { action: "ADD" } }), []);
  assert.throws(() => validateJsonTransform({ tableName: "teaching_mentor_relationship_change_preview", columnName: "impact_json", raw: JSON.stringify({ ...impact, password: "secret" }), row: { action: "REPLACE" } }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  assert.throws(() => validateJsonTransform({ tableName: "teaching_mentor_relationship_change", columnName: "after_json", raw: JSON.stringify({ sourceRelationship: relationship, resultRelationship: { ...nextRelationship, token: "secret" } }), row: { action: "REPLACE" } }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  assert.throws(() => validateJsonTransform({ tableName: "teaching_mentor_relationship_change", columnName: "after_json", raw: JSON.stringify({ sourceRelationship: relationship, resultRelationship: nextRelationship, continuationRelationship: { ...continuationRelationship, id: "00000000-0000-4000-8000-000000000017" } }), row: { action: "REPLACE", continuation_relationship_id: continuationId, teacher_person_id: relationship.teacherPersonId, source_related_person_id: relationship.relatedPersonId, next_boundary_at: "2026-10-04 16:00:00+00", published_by_person_id: relationship.createdByPersonId, published_at: "2026-09-23 08:00:00+00" } }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  assert.throws(() => validateJsonTransform({ tableName: "teaching_mentor_relationship_change", columnName: "after_json", raw: JSON.stringify({ sourceRelationship: relationship, resultRelationship: nextRelationship, continuationRelationship: { ...continuationRelationship, relationshipType: "GROUP_LEADER" } }), row: { action: "REPLACE", continuation_relationship_id: continuationId, teacher_person_id: relationship.teacherPersonId, source_related_person_id: relationship.relatedPersonId, next_boundary_at: "2026-10-04 16:00:00+00", published_by_person_id: relationship.createdByPersonId, published_at: "2026-09-23 08:00:00+00" } }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  const continuationRow = { action: "REPLACE", continuation_relationship_id: continuationId, teacher_person_id: relationship.teacherPersonId, source_related_person_id: relationship.relatedPersonId, next_boundary_at: "2026-10-04 16:00:00+00", published_by_person_id: relationship.createdByPersonId, published_at: "2026-09-23 08:00:00+00" };
  for (const changedContinuation of [
    { ...continuationRelationship, teacherPersonId: nextRelationship.relatedPersonId },
    { ...continuationRelationship, relatedPersonId: nextRelationship.relatedPersonId },
    { ...continuationRelationship, validFrom: relationship.validFrom },
    { ...continuationRelationship, validTo: continuationRelationship.validFrom },
    { ...continuationRelationship, effectiveScope: "REGULAR_WEEK:other-week" },
    { ...continuationRelationship, createdByPersonId: nextRelationship.relatedPersonId },
    { ...continuationRelationship, createdAt: relationship.createdAt },
    { ...continuationRelationship, supersededAt: "2026-10-04T16:00:00.000Z" },
    { ...continuationRelationship, supersededByChangeId: "00000000-0000-4000-8000-000000000017" },
  ]) {
    assert.throws(() => validateJsonTransform({ tableName: "teaching_mentor_relationship_change", columnName: "after_json", raw: JSON.stringify({ sourceRelationship: relationship, resultRelationship: nextRelationship, continuationRelationship: changedContinuation }), row: continuationRow }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  }
  assert.throws(() => validateJsonTransform({ tableName: "teaching_mentor_relationship_change", columnName: "before_json", raw: JSON.stringify({ sourceRelationship: { ...relationship, relationshipType: "GROUP_LEADER" } }), row: { action: "REPLACE" } }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  assert.throws(() => validateJsonTransform({ tableName: "teaching_mentor_relationship_change_preview", columnName: "impact_json", raw: JSON.stringify({ ...impact, effectiveWeek: { ...impact.effectiveWeek, kind: "SUMMER_SPECIAL" } }), row: { action: "REPLACE" } }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  assert.equal(validateJsonTransform({ tableName: "teaching_mentor_relationship_change_preview", columnName: "impact_json", raw: JSON.stringify({ ...impact, totals: { ...impact.totals, movedAmountCents: "bad" } }), row: { action: "REPLACE" } })[0].field, "movedAmountCents");
});
