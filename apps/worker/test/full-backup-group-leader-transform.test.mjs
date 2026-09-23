import assert from "node:assert/strict";
import test from "node:test";
import { EXPORT_SCHEMA_REGISTRY } from "../dist/export-schema-registry.js";
import { FullBackupTransformer } from "../dist/full-backup-transformer.js";
import { validateJsonTransform } from "../dist/full-backup-transform-schemas.js";

const relationship = {
  id: "old-relation", teacherPersonId: "teacher", relationshipType: "GROUP_LEADER", relatedPersonId: "old-leader",
  validFrom: "2026-09-21T00:00:00+08:00", validTo: null, effectiveScope: null, createdByPersonId: "admin",
  createdAt: "2026-09-01T00:00:00Z", supersededAt: null, supersededByChangeId: null,
};
const impact = {
  schemaVersion: "group-leader-change-preview.v1", teacherPersonId: "teacher",
  effectiveWeek: { id: "week", startsOn: "2026-09-21", endsOn: "2026-09-27", settlementMonth: "2026-09-01", kind: "REGULAR" },
  effectiveAt: "2026-09-21T00:00:00+08:00", nextBoundaryAt: null, sourceRelationship: relationship, nextRelationship: null,
  candidate: { personId: "new-leader", nickname: "0007", userAccountId: "account", roleAssignmentId: "role", roleValidFrom: "2026-09-23T00:00:00+08:00", roleValidTo: null },
  destinationAccount: { id: "new-account", code: "person:0007", ownerType: "PERSON", ownerId: "new-leader", status: "ACTIVE" },
  reason: "same-week replacement",
  fees: [{ feeEntryId: "fee", feeVersion: "1", grossAmountCents: "1000", teachingWeekId: "week", weekStartsOn: "2026-09-21", settlementMonth: "2026-09-01",
    disposition: "MOVE", refundEffectId: null, previousSnapshotId: "snapshot", previousSnapshotSequence: "1", previousSnapshotHash: "a".repeat(64),
    policyVersionId: "policy", netMonthlyCents: "-200", groupLeaderAmountCents: "60", sourceAccountId: "old-account", sourceAccountCode: "person:old" }],
  totals: { consideredFeeCount: 1, movedFeeCount: 1, zeroShareFeeCount: 0, excludedRefundCount: 0, movedAmountCents: "60" },
};
const transform = (tableName, values) => new FullBackupTransformer({ fingerprint: () => "a".repeat(64) }).transformRow({
  tableName,
  exportValues: Object.fromEntries(EXPORT_SCHEMA_REGISTRY.find(table => table.name === tableName).columns
    .filter(column => column.disposition === "EXPORT").map(column => [column.name, null])),
  transformValues: new Map(Object.entries({
    ...(tableName === "person_relationship_change" ? {
      before_json: JSON.stringify({ sourceRelationship: relationship }),
      after_json: JSON.stringify({ sourceRelationship: relationship, resultRelationship: relationship }),
      idempotency_key: "private-command",
    } : {}),
    ...values,
  })),
});

test("group-leader audit uses the same exact relationship shapes and rejects unknown actions", () => {
  const check = (columnName, value, action = "GROUP_LEADER_RELATIONSHIP_CHANGED") => validateJsonTransform({
    tableName: "audit_event", columnName, raw: value === null ? null : JSON.stringify(value),
    row: { subject_type: "PERSON_RELATIONSHIP", action_code: action },
  });
  assert.deepEqual(check("before_json", { sourceRelationship: relationship }), []);
  assert.deepEqual(check("after_json", { sourceRelationship: relationship, resultRelationship: relationship }), []);
  assert.deepEqual(check("before_json", null), []);
  assert.throws(() => check("before_json", { sourceRelationship: { ...relationship, password: "secret" } }), /EXPORT_TRANSFORM_SCHEMA_GAP/);
  assert.throws(() => check("after_json", { sourceRelationship: relationship, resultRelationship: { ...relationship, id: { password: "secret" } } }), /EXPORT_TRANSFORM_SCHEMA_GAP/);
  assert.throws(() => check("before_json", null, "UNKNOWN_ACTION"), /EXPORT_TRANSFORM_SCHEMA_GAP/);
});

test("group-leader preview and supersession history preserve frozen business JSON and fingerprint command keys", async () => {
  const raw = JSON.stringify(impact);
  const preview = await transform("person_relationship_change_preview", { impact_json: raw });
  assert.equal(preview.values.impact_json, raw);
  assert.deepEqual(preview.anomalies, []);
  const before = JSON.stringify({ sourceRelationship: relationship });
  const after = JSON.stringify({
    sourceRelationship: { ...relationship, supersededAt: "2026-09-23T01:00:00Z", supersededByChangeId: "change" },
    resultRelationship: { ...relationship, id: "new-relation", relatedPersonId: "new-leader" },
  });
  const change = await transform("person_relationship_change", { before_json: before, after_json: after, idempotency_key: "raw-private-command" });
  assert.equal(change.values.before_json, before);
  assert.equal(change.values.after_json, after);
  assert.equal(change.values.idempotency_key, undefined);
  assert.equal(change.values.idempotency_key_fingerprint, "a".repeat(64));
  assert.deepEqual(change.anomalies, []);
  const refunded = structuredClone(impact);
  Object.assign(refunded.fees[0], { disposition: "REFUNDED", refundEffectId: "refund", previousSnapshotId: null,
    previousSnapshotSequence: null, previousSnapshotHash: null, policyVersionId: null, netMonthlyCents: null,
    groupLeaderAmountCents: "0", sourceAccountId: null, sourceAccountCode: null });
  assert.deepEqual((await transform("person_relationship_change_preview", { impact_json: JSON.stringify(refunded) })).anomalies, []);
});

test("every nested group-leader object rejects unknown fields and scalar containers", async () => {
  for (const mutate of [
    value => { value.accessToken = "secret"; },
    value => { value.candidate.password = "secret"; },
    value => { value.effectiveWeek.session = "secret"; },
    value => { value.sourceRelationship.privateKey = "secret"; },
    value => { value.nextRelationship = { ...relationship, password: "secret" }; },
    value => { value.destinationAccount.bankSecret = "secret"; },
    value => { value.fees[0].token = "secret"; },
    value => { value.totals.secret = "secret"; },
    value => { value.candidate.nickname = { secret: "hidden" }; },
    value => { value.fees = { secret: "hidden" }; },
    value => { value.fees = [[{ secret: "hidden" }]]; },
  ]) {
    const value = structuredClone(impact); mutate(value);
    await assert.rejects(transform("person_relationship_change_preview", { impact_json: JSON.stringify(value) }), /EXPORT_TRANSFORM_SCHEMA_GAP/);
  }
  await assert.rejects(transform("person_relationship_change", { before_json: JSON.stringify({ sourceRelationship: { ...relationship, apiToken: "secret" } }) }), /EXPORT_TRANSFORM_SCHEMA_GAP/);
  await assert.rejects(transform("person_relationship_change", { after_json: JSON.stringify({ sourceRelationship: relationship, resultRelationship: { ...relationship, id: { secret: "hidden" } } }) }), /EXPORT_TRANSFORM_SCHEMA_GAP/);
});

test("malformed known group-leader scalars remain byte-exact with visible anomalies", async () => {
  const value = structuredClone(impact);
  value.totals.movedFeeCount = "legacy-invalid";
  delete value.candidate.roleAssignmentId;
  const raw = JSON.stringify(value);
  const result = await transform("person_relationship_change_preview", { impact_json: raw });
  assert.equal(result.values.impact_json, raw);
  assert.ok(result.anomalies.some(item => item.field === "movedFeeCount"));
  assert.ok(result.anomalies.some(item => item.field === "roleAssignmentId"));
});
