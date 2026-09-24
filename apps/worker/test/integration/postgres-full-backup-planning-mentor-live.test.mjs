import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PostgresPlanningMentorRelationshipService } from '../../../api/dist/postgres-planning-mentor-relationship-service.js';
import { PostgresWeeklySettlementService } from '../../../api/dist/postgres-weekly-settlement-service.js';
import { createTestDatabase } from '../../../api/test/integration/postgres-test-database.mjs';
import { FullBackupSpool } from '../../dist/full-backup-spool.js';
import { readBackupSpoolDataset } from '../../dist/full-backup-spool-reader.js';
import { FullBackupTransformer } from '../../dist/full-backup-transformer.js';
import { PostgresFullBackupSource } from '../../dist/postgres-full-backup-source.js';
import { validateJsonTransform } from '../../dist/full-backup-transform-schemas.js';

const at = new Date('2026-09-23T08:00:00.000Z');
const connectionString = process.env.DATABASE_URL;
const context = (personId) => ({ personId, subject: 'PLANNING_MENTOR', scope: 'SELF' });
const json = (value) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item);
const policy = {
  plannerBaseRateBasisPoints: 8000n, teacherBaseRateBasisPoints: 0n, planningMentorWeightBasisPoints: 2000n,
  groupLeaderRateBasisPoints: 0n, teachingMentorRateBasisPoints: 0n, venueRateBasisPoints: 0n,
  campusConsultationForPlannerRateBasisPoints: 0n, campusConsultationForTeacherRateBasisPoints: 0n,
  platformFinanceRateBasisPoints: 0n, regionFinanceRateBasisPoints: 0n,
  dynamicTiers: [{ label: 'default', adjustmentBasisPoints: 0n }],
};

async function person(pool, id, nickname, atIso) {
  await pool.query('INSERT INTO person(id,nickname,legal_name,status,created_at,updated_at) VALUES($1,$2,$2,\'ACTIVE\',$3,$3)', [id, nickname, atIso]);
}
async function account(pool, personId, code, atIso) {
  const id = randomUUID();
  await pool.query('INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status,created_at) VALUES($1,\'PERSON\',$2,$3,\'ACTIVE\',$4)', [id, personId, code, atIso]);
  await pool.query('INSERT INTO account_balance_projection(account_id,balance_cents,updated_at) VALUES($1,0,$2)', [id, atIso]);
  return id;
}
async function login(pool, id, atIso) {
  await pool.query('INSERT INTO user_account(id,person_id,phone_normalized,password_hash,login_status,created_at,updated_at) VALUES($1,$2,$3,\'synthetic-hash\',\'ACTIVE\',$4,$4)', [randomUUID(), id, `138${id.replaceAll('-', '').slice(0, 8)}`, atIso]);
}
async function rows(root, spool, name) {
  const dataset = spool.datasets.find((item) => item.tableName === name);
  assert.ok(dataset && !dataset.excluded, name);
  const out = [];
  for await (const row of readBackupSpoolDataset(join(root, 'spool', spool.spoolId), dataset)) out.push(Object.fromEntries(dataset.columns.map((column, index) => [column, row[index]])));
  return out;
}

test('real PG planning-mentor ADD and REMOVE remain non-empty RAW facts with strict transforms', async (t) => {
  if (!connectionString) return t.skip('DATABASE_URL_REQUIRED');
  const database = await createTestDatabase(connectionString);
  const root = await mkdtemp(join(tmpdir(), 'alliance-planning-mentor-backup-pg-'));
  try {
    const ids = Object.fromEntries(['mentor', 'planner', 'region', 'campus', 'year', 'period', 'week', 'student', 'referral', 'venue', 'policy'].map((key) => [key, randomUUID()]));
    const iso = at.toISOString();
    await person(database.pool, ids.mentor, '规划导师', iso); await person(database.pool, ids.planner, '规划师', iso);
    await database.pool.query("INSERT INTO organization_unit(id,unit_type,name,created_at) VALUES($1,'REGION','规划分区',$3),($2,'CAMPUS','规划校区',$3)", [ids.region, ids.campus, iso]);
    await login(database.pool, ids.mentor, iso); await login(database.pool, ids.planner, iso);
    await account(database.pool, ids.mentor, `person:mentor:${ids.mentor}`, iso); await account(database.pool, ids.planner, `person:planner:${ids.planner}`, iso);
    await database.pool.query('INSERT INTO role_assignment(id,person_id,subject_code,scope_type,scope_id,valid_from,created_by,created_at) VALUES($1,$2,\'PLANNING_MENTOR\',\'SELF\',NULL,\'2026-01-01\',$2,$3)', [randomUUID(), ids.mentor, iso]);
    await database.pool.query('INSERT INTO teacher_profile(person_id,business_identity,employment_status,created_at,updated_at) VALUES($1,\'ACADEMIC_PLANNER\',\'ACTIVE\',$2,$2)', [ids.planner, iso]);
    await database.pool.query("INSERT INTO person_campus_assignment(id,person_id,campus_id,region_id,valid_from,created_by,created_at) VALUES($1,$2,$3,$4,'2026-01-01',$2,$5)", [randomUUID(), ids.planner, ids.campus, ids.region, iso]);
    await database.pool.query('INSERT INTO venue(id,owner_person_id,name,status,default_for_owner,created_at,updated_at) VALUES($1,$2,\'规划场地\',\'ACTIVE\',true,$3,$3)', [ids.venue, ids.planner, iso]);
    await database.pool.query('INSERT INTO academic_year_plan(id,label,starts_on,ends_on,created_by,created_at) VALUES($1,\'规划学年\',\'2026-09-01\',\'2027-08-31\',$2,$3)', [ids.year, ids.mentor, iso]);
    await database.pool.query('INSERT INTO academic_period(id,academic_year_plan_id,label,starts_on,ends_on,created_at) VALUES($1,$2,\'规划秋季\',\'2026-09-01\',\'2027-01-31\',$3)', [ids.period, ids.year, iso]);
    await database.pool.query('INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month,status,created_at) VALUES($1,$2,1,\'REGULAR\',\'2026-09-21\',\'2026-09-27\',\'2026-09-01\',\'OPEN\',$3)', [ids.week, ids.period, iso]);
    await database.pool.query('INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name,created_at,updated_at) VALUES($1,$2,\'planning-course\',\'规划学生\',$3,$3)', [ids.student, ids.planner, iso]);
    await database.pool.query('INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,version,created_at,updated_at) VALUES($1,$2,$3,$3,\'ACADEMIC_PLANNER\',\'ACCEPTED\',$4,1,$4,$4)', [ids.referral, ids.student, ids.planner, iso]);
    await database.pool.query("INSERT INTO referral_creation_snapshot(referral_case_id,source_subject,business_identity_version,campus_assignment_id,campus_id,class_type,collector_person_id,created_by,created_at) VALUES($1,'ACADEMIC_PLANNER',1,(SELECT id FROM person_campus_assignment WHERE person_id=$2),$3,'ONE_TO_ONE',$2,$2,$4)", [ids.referral, ids.planner, ids.campus, iso]);
    await database.pool.query('INSERT INTO rate_policy_version(id,version,effective_from,policy_json,reason,published_by,published_at) VALUES($1,1,\'2026-09-01\',$2::jsonb,\'规划导师测试\',$3,$4)', [ids.policy, json(policy), ids.mentor, iso]);
    const weekly = new PostgresWeeklySettlementService(database.pool);
    await weekly.recordAndSettle(ids.planner, { referralCaseId: ids.referral, teachingWeekId: ids.week, venueId: ids.venue, settlementMonth: '2026-09-01', grossAmountCents: 1000n, expectedVersion: 0 }, 'planning-mentor-backup-seed');
    const service = new PostgresPlanningMentorRelationshipService(database.pool);
    const addPreview = await service.preview(context(ids.mentor), { action: 'ADD', plannerPersonId: ids.planner, effectiveTeachingWeekId: ids.week, reason: '加入规划导师名下' }, at);
    const add = await service.publish(context(ids.mentor), addPreview.previewId, 'planning-mentor-backup-add', at);
    const removePreview = await service.preview(context(ids.mentor), { action: 'REMOVE', plannerPersonId: ids.planner, effectiveTeachingWeekId: ids.week, reason: '移除规划导师关系' }, at);
    const remove = await service.publish(context(ids.mentor), removePreview.previewId, 'planning-mentor-backup-remove', at);
    assert.equal(add.action, 'ADD'); assert.equal(remove.action, 'REMOVE');
    const spool = await new FullBackupSpool({ source: new PostgresFullBackupSource(database.pool), transformer: new FullBackupTransformer({ fingerprint: ({ domain, value }) => createHash('sha256').update(`${domain}:${value}`).digest('hex') }), tempRoot: join(root, 'spool'), batchSize: 1 }).create();
    for (const tableName of ['planning_mentor_relationship_change_preview', 'planning_mentor_relationship_change', 'planning_mentor_relationship_change_effect']) assert.ok((await rows(root, spool, tableName)).length > 0, tableName);
    const changes = await rows(root, spool, 'planning_mentor_relationship_change');
    const effects = await rows(root, spool, 'planning_mentor_relationship_change_effect');
    assert.equal(changes.length, 2); assert.equal(effects.length, 2);
    assert.deepEqual(new Set(changes.map((row) => row.action)), new Set(['ADD', 'REMOVE']));
    assert.ok(effects.every((row) => row.previous_snapshot_id && row.result_snapshot_id && row.settlement_calculation_run_id));
    assert.equal(JSON.stringify(changes).includes('planning-mentor-backup-add'), false);
    assert.equal(changes.every((row) => typeof row.idempotency_key_fingerprint === 'string' && row.idempotency_key_fingerprint.length === 64), true);
    const relationships = await rows(root, spool, 'person_relationship');
    const superseded = relationships.find((row) => row.superseded_by_planning_mentor_change_id === remove.changeId);
    assert.ok(superseded, 'same-week ADD relationship is retained and superseded by REMOVE');
    assert.equal(superseded.relationship_type, 'PLANNING_MENTOR');
    const snapshots = await rows(root, spool, 'weekly_fee_allocation_snapshot');
    const snapshotIds = new Set(effects.flatMap((row) => [row.previous_snapshot_id, row.result_snapshot_id]));
    assert.ok([...snapshotIds].every((id) => snapshots.some((row) => row.id === id)), 'effect snapshots are exported');
    const events = await rows(root, spool, 'ledger_event');
    const eventIds = new Set(changes.map((row) => row.ledger_event_id));
    assert.equal(eventIds.size, 2); assert.ok([...eventIds].every((id) => events.some((row) => row.id === id)));
    const ledger = await rows(root, spool, 'ledger_entry');
    assert.equal(ledger.filter((row) => eventIds.has(row.event_id)).reduce((sum, row) => sum + BigInt(row.amount_cents), 0n), 0n, 'each transition ledger remains globally conserved');
    const audits = await rows(root, spool, 'audit_event');
    const relationAudits = audits.filter((row) => row.subject_type === 'PERSON_RELATIONSHIP' && row.action_code.startsWith('PLANNING_MENTOR_RELATIONSHIP_'));
    assert.equal(relationAudits.length, 2);
    assert.ok(relationAudits.some((row) => row.action_code === 'PLANNING_MENTOR_RELATIONSHIP_ADDED' && row.before_json === null && row.after_json !== null));
    assert.ok(relationAudits.some((row) => row.action_code === 'PLANNING_MENTOR_RELATIONSHIP_REMOVED' && row.before_json !== null && row.after_json === null));
    assert.deepEqual(validateJsonTransform({ tableName: 'planning_mentor_relationship_change', columnName: 'before_json', raw: null, row: { action: 'ADD' } }), []);
    assert.throws(() => validateJsonTransform({ tableName: 'planning_mentor_relationship_change', columnName: 'after_json', raw: JSON.stringify({ password: 'secret' }), row: {} }), { message: 'EXPORT_TRANSFORM_SCHEMA_GAP' });
  } finally { await rm(root, { recursive: true, force: true }); await database.close(); }
});
