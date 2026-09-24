import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPORT_SCHEMA_REGISTRY } from '../dist/export-schema-registry.js';
import { createFullBackupLayout } from '../dist/full-backup-layout.js';
import { validateJsonTransform } from '../dist/full-backup-transform-schemas.js';

const table = (name) => EXPORT_SCHEMA_REGISTRY.find((item) => item.name === name);

test('planning mentor relationship tables are fixed RAW/F14 registry entries', () => {
  for (const [name, orderBy] of [
    ['planning_mentor_relationship_change_preview', ['id']],
    ['planning_mentor_relationship_change', ['id']],
    ['planning_mentor_relationship_change_effect', ['change_id', 'weekly_fee_entry_id']],
  ]) {
    const entry = table(name);
    assert.ok(entry, name);
    assert.deepEqual(entry.orderBy, orderBy);
    assert.ok(entry.columns.length > 0);
    assert.ok(createFullBackupLayout().some((item) => item.tableName === name && item.policy === 'RAW_SOURCE'));
  }
  assert.equal(table('planning_mentor_relationship_change').columns.find((column) => column.name === 'idempotency_key')?.disposition, 'TRANSFORM');
  assert.equal(table('planning_mentor_relationship_change_effect').columns.find((column) => column.name === 'delta_json')?.disposition, 'TRANSFORM');
  assert.equal(table('person_relationship').columns.find((column) => column.name === 'superseded_by_planning_mentor_change_id')?.disposition, 'EXPORT');
});

const relationship = {
  id: '00000000-0000-4000-8000-000000000001', teacherPersonId: '00000000-0000-4000-8000-000000000002',
  relationshipType: 'PLANNING_MENTOR', relatedPersonId: '00000000-0000-4000-8000-000000000003',
  validFrom: '2026-09-21T00:00:00.000Z', validTo: null, effectiveScope: 'REGULAR_WEEK:week',
  createdByPersonId: '00000000-0000-4000-8000-000000000003', createdAt: '2026-09-21T00:00:00.000Z',
  supersededAt: null, supersededByChangeId: null, supersededByPlanningMentorChangeId: null,
};

test('planning mentor JSON transforms preserve known facts and fail closed on unknown keys', () => {
  const impact = {
    schemaVersion: 'planning-mentor-relationship-preview.v1', action: 'ADD',
    mentorPersonId: relationship.relatedPersonId, plannerPersonId: relationship.teacherPersonId,
    sourceRelationship: null, resultRelationshipId: '00000000-0000-4000-8000-000000000004',
    actorRoleAssignmentId: '00000000-0000-4000-8000-000000000005', actorRoleScopeId: null,
    mentorAccount: { id: '00000000-0000-4000-8000-000000000007', code: 'mentor-account', ownerId: relationship.relatedPersonId, status: 'ACTIVE' },
    plannerAccount: { id: '00000000-0000-4000-8000-000000000008', code: 'planner-account', ownerId: relationship.teacherPersonId, status: 'ACTIVE' },
    week: { id: '00000000-0000-4000-8000-000000000006', startsOn: '2026-09-21', endsOn: '2026-09-27', settlementMonth: '2026-09-01' },
    effectiveAt: '2026-09-20T16:00:00.000Z', nextBoundaryAt: null, reason: 'synthetic', fees: [],
    totals: { consideredFeeCount: 0, changedFeeCount: 0, zeroShareFeeCount: 0, excludedRefundCount: 0, plannerDeltaCents: '0', mentorDeltaCents: '0' },
  };
  assert.deepEqual(validateJsonTransform({ tableName: 'planning_mentor_relationship_change_preview', columnName: 'impact_json', raw: JSON.stringify(impact), row: { action: 'ADD' } }), []);
  assert.deepEqual(validateJsonTransform({ tableName: 'planning_mentor_relationship_change_preview', columnName: 'impact_json', raw: JSON.stringify({ ...impact, action: 'REMOVE', sourceRelationship: relationship, resultRelationshipId: null }), row: { action: 'REMOVE' } }), []);
  assert.deepEqual(validateJsonTransform({ tableName: 'planning_mentor_relationship_change', columnName: 'before_json', raw: null, row: { action: 'ADD' } }), []);
  assert.deepEqual(validateJsonTransform({ tableName: 'planning_mentor_relationship_change', columnName: 'after_json', raw: JSON.stringify(relationship), row: { action: 'ADD' } }), []);
  assert.deepEqual(validateJsonTransform({ tableName: 'planning_mentor_relationship_change', columnName: 'before_json', raw: JSON.stringify(relationship), row: { action: 'REMOVE' } }), []);
  assert.deepEqual(validateJsonTransform({ tableName: 'planning_mentor_relationship_change', columnName: 'after_json', raw: null, row: { action: 'REMOVE' } }), []);
  assert.deepEqual(validateJsonTransform({ tableName: 'planning_mentor_relationship_change_effect', columnName: 'delta_json', raw: JSON.stringify({ entries: [{ accountKey: 'planningMentor', categoryKey: 'planningMentor', amountCents: '10' }] }), row: {} }), []);
  assert.throws(() => validateJsonTransform({ tableName: 'planning_mentor_relationship_change_effect', columnName: 'delta_json', raw: JSON.stringify({ entries: [{ accountKey: 'planningMentor', categoryKey: 'planningMentor', amountCents: '10', password: 'secret' }] }), row: {} }), { message: 'EXPORT_TRANSFORM_SCHEMA_GAP' });
  assert.throws(() => validateJsonTransform({ tableName: 'planning_mentor_relationship_change_effect', columnName: 'delta_json', raw: JSON.stringify({ entries: [{ accountKey: 'planningMentor', categoryKey: 'ARBITRARY', amountCents: '10' }] }), row: {} }), { message: 'EXPORT_TRANSFORM_SCHEMA_GAP' });
  assert.equal(validateJsonTransform({ tableName: 'planning_mentor_relationship_change_effect', columnName: 'delta_json', raw: JSON.stringify({ entries: [{ accountKey: 'planningMentor', categoryKey: 'planningMentor', amountCents: 'oops' }] }), row: {} })[0].field, 'amountCents');
  assert.throws(() => validateJsonTransform({ tableName: 'planning_mentor_relationship_change_preview', columnName: 'impact_json', raw: JSON.stringify({ ...impact, action: 'TAKEOVER' }), row: { action: 'ADD' } }), { message: 'EXPORT_TRANSFORM_SCHEMA_GAP' });
  assert.throws(() => validateJsonTransform({ tableName: 'planning_mentor_relationship_change_preview', columnName: 'impact_json', raw: JSON.stringify({ ...impact, password: 'secret' }), row: { action: 'ADD' } }), { message: 'EXPORT_TRANSFORM_SCHEMA_GAP' });
  assert.throws(() => validateJsonTransform({ tableName: 'planning_mentor_relationship_change_preview', columnName: 'impact_json', raw: JSON.stringify({ ...impact, action: 'REMOVE' }), row: { action: 'ADD' } }), { message: 'EXPORT_TRANSFORM_SCHEMA_GAP' });
  assert.throws(() => validateJsonTransform({ tableName: 'planning_mentor_relationship_change_preview', columnName: 'impact_json', raw: JSON.stringify({ ...impact, sourceRelationship: relationship }), row: { action: 'ADD' } }), { message: 'EXPORT_TRANSFORM_SCHEMA_GAP' });
  assert.throws(() => validateJsonTransform({ tableName: 'planning_mentor_relationship_change_preview', columnName: 'impact_json', raw: JSON.stringify({ ...impact, action: 'REMOVE', resultRelationshipId: null, sourceRelationship: null }), row: { action: 'REMOVE' } }), { message: 'EXPORT_TRANSFORM_SCHEMA_GAP' });
  assert.equal(validateJsonTransform({ tableName: 'planning_mentor_relationship_change_preview', columnName: 'impact_json', raw: JSON.stringify({ ...impact, totals: { ...impact.totals, plannerDeltaCents: 'bad' } }), row: { action: 'ADD' } })[0].field, 'plannerDeltaCents');
  assert.throws(() => validateJsonTransform({ tableName: 'planning_mentor_relationship_change', columnName: 'after_json', raw: JSON.stringify({ ...relationship, password: 'secret' }), row: {} }), { message: 'EXPORT_TRANSFORM_SCHEMA_GAP' });
  assert.throws(() => validateJsonTransform({ tableName: 'planning_mentor_relationship_change', columnName: 'before_json', raw: null, row: { action: 'TAKEOVER' } }), { message: 'EXPORT_TRANSFORM_SCHEMA_GAP' });
  assert.throws(() => validateJsonTransform({ tableName: 'planning_mentor_relationship_change', columnName: 'before_json', raw: JSON.stringify(relationship), row: { action: 'ADD' } }), { message: 'EXPORT_TRANSFORM_SCHEMA_GAP' });
  assert.throws(() => validateJsonTransform({ tableName: 'planning_mentor_relationship_change', columnName: 'after_json', raw: JSON.stringify(relationship), row: { action: 'REMOVE' } }), { message: 'EXPORT_TRANSFORM_SCHEMA_GAP' });
  assert.deepEqual(validateJsonTransform({ tableName: 'audit_event', columnName: 'before_json', raw: null, row: { subject_type: 'PERSON_RELATIONSHIP', action_code: 'PLANNING_MENTOR_RELATIONSHIP_ADDED' } }), []);
  assert.deepEqual(validateJsonTransform({ tableName: 'audit_event', columnName: 'after_json', raw: JSON.stringify(relationship), row: { subject_type: 'PERSON_RELATIONSHIP', action_code: 'PLANNING_MENTOR_RELATIONSHIP_ADDED' } }), []);
  assert.throws(() => validateJsonTransform({ tableName: 'audit_event', columnName: 'after_json', raw: JSON.stringify({ ...relationship, password: 'secret' }), row: { subject_type: 'PERSON_RELATIONSHIP', action_code: 'PLANNING_MENTOR_RELATIONSHIP_ADDED' } }), { message: 'EXPORT_TRANSFORM_SCHEMA_GAP' });
  assert.throws(() => validateJsonTransform({ tableName: 'audit_event', columnName: 'after_json', raw: JSON.stringify({ ...relationship, relationshipType: 'GROUP_LEADER' }), row: { subject_type: 'PERSON_RELATIONSHIP', action_code: 'PLANNING_MENTOR_RELATIONSHIP_ADDED' } }), { message: 'EXPORT_TRANSFORM_SCHEMA_GAP' });
  assert.throws(() => validateJsonTransform({ tableName: 'planning_mentor_relationship_change', columnName: 'after_json', raw: JSON.stringify({ ...relationship, relationshipType: 'GROUP_LEADER' }), row: { action: 'ADD' } }), { message: 'EXPORT_TRANSFORM_SCHEMA_GAP' });
  assert.equal(validateJsonTransform({ tableName: 'planning_mentor_relationship_change_preview', columnName: 'impact_json', raw: JSON.stringify({ ...impact, schemaVersion: 'future.v2' }), row: { action: 'ADD' } })[0].field, 'schemaVersion');
});
