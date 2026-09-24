import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_RATE_POLICY_VALUES,
  allocateRationalCents,
  postLedgerEvent,
} from "@teaching-research-alliance/domain";
import { PostgresPlanningMentorRelationshipService } from "../../dist/postgres-planning-mentor-relationship-service.js";
import { createPostgresLedgerTransaction } from "../../dist/postgres-ledger-repository.js";
import { PostgresWeeklySettlementService } from "../../dist/postgres-weekly-settlement-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const connectionString = process.env.DATABASE_URL;
const stringify = (value) => JSON.stringify(value, (_, item) =>
  typeof item === "bigint" ? item.toString() : item,
);
const mentorContext = (personId) => ({
  subject: "PLANNING_MENTOR",
  personId,
  scope: "SELF",
});

const seed = async (pool) => {
  const keys = [
    "admin", "mentor", "planner", "receiver", "groupLeader", "teachingMentor",
    "platformFinance", "regionFinance", "region", "campus", "venue", "year",
    "period", "previousWeek", "currentWeek", "nextWeek", "student", "referral",
  ];
  const ids = Object.fromEntries(keys.map((key) => [key, randomUUID()]));
  const people = [
    "admin", "mentor", "planner", "receiver", "groupLeader", "teachingMentor",
    "platformFinance", "regionFinance",
  ];
  for (const key of people) {
    await pool.query(
      "INSERT INTO person(id,nickname,legal_name,status) VALUES($1,$2,$2,'ACTIVE')",
      [ids[key], `mentor-live-${key}-${ids[key]}`],
    );
    await pool.query(
      "INSERT INTO user_account(person_id,phone_normalized,password_hash,login_status) VALUES($1,$2,$3,'ACTIVE')",
      [ids[key], `137${String(people.indexOf(key)).padStart(8, "0")}`, `synthetic-${key}`],
    );
    await pool.query(
      "INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('PERSON',$1,$2,'ACTIVE')",
      [ids[key], `person:${ids[key]}`],
    );
  }
  await pool.query(
    "INSERT INTO organization_unit(id,unit_type,name) VALUES($1,'REGION',$2),($3,'CAMPUS',$4)",
    [ids.region, `region-${ids.region}`, ids.campus, `campus-${ids.campus}`],
  );
  await pool.query(
    "INSERT INTO campus_region_assignment(campus_id,region_id,valid_from,created_by) VALUES($1,$2,'2026-01-01T00:00:00Z',$3)",
    [ids.campus, ids.region, ids.admin],
  );
  await pool.query(
    `INSERT INTO teacher_profile(person_id,business_identity,region_id,campus_id,employment_status)
       VALUES($1,'ACADEMIC_PLANNER',$2,$3,'ACTIVE'),($4,'TEACHING_TEACHER',$2,$3,'ACTIVE')`,
    [ids.planner, ids.region, ids.campus, ids.receiver],
  );
  await pool.query(
    `INSERT INTO person_campus_assignment(person_id,campus_id,region_id,valid_from,created_by)
       VALUES($1,$2,$3,'2026-01-01T00:00:00Z',$4),($5,$2,$3,'2026-01-01T00:00:00Z',$4)`,
    [ids.planner, ids.campus, ids.region, ids.admin, ids.receiver],
  );
  await pool.query(
    `INSERT INTO role_assignment(person_id,subject_code,scope_type,scope_id,valid_from,created_by)
       VALUES($1,'PLANNING_MENTOR','SELF',NULL,'2026-01-01T00:00:00Z',$2),
             ($3,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'2026-01-01T00:00:00Z',$2),
             ($4,'REGION_FINANCE','REGION',$5,'2026-01-01T00:00:00Z',$2)`,
    [ids.mentor, ids.admin, ids.platformFinance, ids.regionFinance, ids.region],
  );
  await pool.query(
    `INSERT INTO person_relationship(teacher_id,relationship_type,related_person_id,valid_from,effective_scope,created_by)
       VALUES($1,'GROUP_LEADER',$2,'2026-01-01T00:00:00Z','CURRENT',$3),
             ($1,'TEACHING_MENTOR',$4,'2026-01-01T00:00:00Z','CURRENT',$3)`,
    [ids.receiver, ids.groupLeader, ids.admin, ids.teachingMentor],
  );
  await pool.query(
    "INSERT INTO venue(id,owner_person_id,name,status,default_for_owner) VALUES($1,$2,$3,'ACTIVE',true)",
    [ids.venue, ids.receiver, `venue-${ids.venue}`],
  );
  await pool.query(
    "INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('VENUE',$1,$2,'ACTIVE'),('COMPANY',$3,$4,'ACTIVE')",
    [ids.venue, `venue:${ids.venue}`, ids.campus, `company:${ids.campus}`],
  );
  await pool.query(
    "INSERT INTO academic_year_plan(id,label,starts_on,ends_on,created_by) VALUES($1,'DEV-007','2026-01-01','2026-12-31',$2)",
    [ids.year, ids.admin],
  );
  await pool.query(
    "INSERT INTO academic_period(id,academic_year_plan_id,label,starts_on,ends_on) VALUES($1,$2,'regular','2026-09-01','2026-12-31')",
    [ids.period, ids.year],
  );
  for (const [key, sequence, startsOn, endsOn] of [
    ["previousWeek", 1, "2026-09-14", "2026-09-20"],
    ["currentWeek", 2, "2026-09-21", "2026-09-27"],
    ["nextWeek", 3, "2026-09-28", "2026-10-04"],
  ]) {
    await pool.query(
      "INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month,status) VALUES($1,$2,$3,'REGULAR',$4,$5,'2026-09-01','OPEN')",
      [ids[key], ids.period, sequence, startsOn, endsOn],
    );
  }
  await pool.query(
    "INSERT INTO rate_policy_version(version,effective_from,policy_json,reason,published_by) VALUES(1,'2026-09-01',$1::jsonb,'synthetic',$2)",
    [stringify(DEFAULT_RATE_POLICY_VALUES), ids.admin],
  );
  await pool.query(
    "INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name) VALUES($1,$2,'dev-007-course','DEV-007 student')",
    [ids.student, ids.receiver],
  );
  await pool.query(
    `INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,version)
       VALUES($1,$2,$3,$4,'ACADEMIC_PLANNER','ACCEPTED','2026-09-01T00:00:00Z',2)`,
    [ids.referral, ids.student, ids.planner, ids.receiver],
  );
  return ids;
};

const latest = async (pool, feeId) => (await pool.query(
  `SELECT id::text,run_id::text,sequence_no::text,snapshot_json,context_json
     FROM weekly_fee_allocation_snapshot snapshot
    WHERE snapshot.weekly_fee_entry_id=$1
    ORDER BY snapshot.sequence_no DESC LIMIT 1`,
  [feeId],
)).rows[0];

const balance = async (pool, personId) => BigInt((await pool.query(
  `SELECT COALESCE(projection.balance_cents,0)::text AS value
     FROM settlement_account account
     LEFT JOIN account_balance_projection projection ON projection.account_id=account.id
    WHERE account.owner_type='PERSON' AND account.owner_id=$1`,
  [personId],
)).rows[0].value);

const recordReferralSource = async (pool, ids, sourceSubject) => {
  const assignment = (await pool.query(
    "SELECT id::text FROM person_campus_assignment WHERE person_id=$1",
    [ids.planner],
  )).rows[0];
  await pool.query(
    `INSERT INTO referral_creation_snapshot(
       referral_case_id,source_subject,business_identity_version,campus_assignment_id,campus_id,
       planning_mentor_relationship_id,class_type,collector_person_id,created_by,created_at
     ) VALUES($1,$2,1,$3,$4,NULL,'ONE_TO_ONE',$5,$6,'2026-09-01T00:00:00Z')`,
    [ids.referral, sourceSubject, assignment.id, ids.campus, ids.receiver, ids.admin],
  );
};

const addPlanningMentor = async (pool, ids, label) => {
  const personId = randomUUID();
  await pool.query(
    "INSERT INTO person(id,nickname,legal_name,status) VALUES($1,$2,$2,'ACTIVE')",
    [personId, `planning-mentor-${label}`],
  );
  await pool.query(
    "INSERT INTO user_account(person_id,phone_normalized,password_hash,login_status) VALUES($1,$2,'synthetic','ACTIVE')",
    [personId, `136${label === "conflict" ? "00000001" : "00000002"}`],
  );
  await pool.query(
    "INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('PERSON',$1,$2,'ACTIVE')",
    [personId, `person:${personId}`],
  );
  await pool.query(
    `INSERT INTO role_assignment(person_id,subject_code,scope_type,valid_from,created_by)
     VALUES($1,'PLANNING_MENTOR','SELF','2026-01-01T00:00:00Z',$2)`,
    [personId, ids.admin],
  );
  return personId;
};

const settle = (pool, ids, weekId, amount, key = randomUUID()) =>
  new PostgresWeeklySettlementService(pool).recordAndSettle(ids.receiver, {
    referralCaseId: ids.referral,
    teachingWeekId: weekId,
    venueId: ids.venue,
    settlementMonth: "2026-09-01",
    grossAmountCents: amount,
    expectedVersion: 0,
  }, key);

const artifactCounts = async (pool) => (await pool.query(
  `SELECT
     (SELECT count(*)::int FROM planning_mentor_relationship_change) AS changes,
     (SELECT count(*)::int FROM planning_mentor_relationship_change_effect) AS effects,
     (SELECT count(*)::int FROM settlement_calculation_run
       WHERE request_key LIKE 'planning-mentor-change:%') AS runs,
     (SELECT count(*)::int FROM ledger_event
       WHERE event_key LIKE 'weekly-settlement:planning-mentor-change:%') AS events,
     (SELECT count(*)::int FROM person_relationship
       WHERE relationship_type='PLANNING_MENTOR') AS relationships`,
)).rows[0];

const assertProjectionMatchesLedger = async (pool, accountId) => {
  const row = (await pool.query(
    `SELECT COALESCE((SELECT sum(amount_cents) FROM ledger_entry WHERE account_id=$1),0)::text AS ledger,
            COALESCE((SELECT balance_cents FROM account_balance_projection WHERE account_id=$1),0)::text AS projection`,
    [accountId],
  )).rows[0];
  assert.equal(row.projection, row.ledger, "projection must equal the entire immutable ledger");
};

const personAccountId = async (pool, personId) => (await pool.query(
  "SELECT id::text FROM settlement_account WHERE owner_type='PERSON' AND owner_id=$1",
  [personId],
)).rows[0].id;

test("GAP-005-B3 migration creates immutable planning-mentor evidence and terminal guards", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  try {
    const result = await database.pool.query(`
      SELECT
        (SELECT count(*)::int FROM information_schema.tables
          WHERE table_schema=current_schema()
            AND table_name IN ('planning_mentor_relationship_change_preview',
                               'planning_mentor_relationship_change',
                               'planning_mentor_relationship_change_effect')) AS tables,
        (SELECT count(*)::int FROM information_schema.columns
          WHERE table_schema=current_schema() AND table_name='person_relationship'
            AND column_name='superseded_by_planning_mentor_change_id') AS supersession_column,
        (SELECT count(*)::int FROM pg_trigger trigger
          JOIN pg_class relation ON relation.oid=trigger.tgrelid
         WHERE relation.relnamespace=current_schema()::regnamespace
           AND trigger.tgname IN ('planning_mentor_relationship_change_preview_immutable',
                                  'planning_mentor_relationship_change_immutable',
                                  'planning_mentor_relationship_change_effect_immutable',
                                  'planning_mentor_published_relationship_update_complete',
                                  'planning_mentor_change_complete',
                                  'planning_mentor_snapshot_terminal',
                                  'planning_mentor_ledger_terminal')) AS guards,
        planning_mentor_timestamp_text('2026-09-23T01:02:03.004005Z'::timestamptz) AS utc
    `);
    assert.deepEqual(result.rows[0], {
      tables: 3,
      supersession_column: 1,
      guards: 7,
      utc: "2026-09-23T01:02:03.004005Z",
    });
  } finally {
    await database.close();
  }
});

test("0035 升级不改写既有组长 supersession 来源", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString, { throughMigration: 34 });
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  try {
    for (const [index, id] of ids.entries()) {
      await database.pool.query(
        "INSERT INTO person(id,nickname,legal_name,status) VALUES($1,$2,$2,'ACTIVE')",
        [id, `upgrade-${index}-${id}`],
      );
    }
    const relation = (await database.pool.query(
      `INSERT INTO person_relationship(teacher_id,relationship_type,related_person_id,valid_from,effective_scope,created_by)
       VALUES($1,'GROUP_LEADER',$2,'2026-01-01T00:00:00Z','CURRENT',$3) RETURNING id::text`,
      [ids[0], ids[1], ids[2]],
    )).rows[0];
    const migration = await readFile(
      new URL("../../../../database/migrations/0035_planning_mentor_relationship_changes.sql", import.meta.url),
      "utf8",
    );
    await database.pool.query(migration);
    assert.deepEqual((await database.pool.query(
      `SELECT superseded_by_change_id,superseded_by_planning_mentor_change_id
         FROM person_relationship WHERE id=$1`,
      [relation.id],
    )).rows[0], {
      superseded_by_change_id: null,
      superseded_by_planning_mentor_change_id: null,
    });
  } finally {
    await database.close();
  }
});

test("0035 的规划导师关系守卫不干扰未发布组长关系的合法更新", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  try {
    for (const [index, id] of ids.entries()) {
      await database.pool.query(
        "INSERT INTO person(id,nickname,legal_name,status) VALUES($1,$2,$2,'ACTIVE')",
        [id, `scope-${index}-${id}`],
      );
    }
    const relation = (await database.pool.query(
      `INSERT INTO person_relationship(teacher_id,relationship_type,related_person_id,valid_from,effective_scope,created_by)
       VALUES($1,'GROUP_LEADER',$2,'2026-01-01T00:00:00Z','CURRENT',$3) RETURNING id::text`,
      [ids[0], ids[1], ids[2]],
    )).rows[0];
    await assert.doesNotReject(database.pool.query(
      "UPDATE person_relationship SET valid_to='2026-06-01T00:00:00Z' WHERE id=$1",
      [relation.id],
    ));
  } finally {
    await database.close();
  }
});

test("规划导师唯一 SELF 任命可 ADD，并在规划师失活后 REMOVE 留下不可变关系证据", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  const ids = Object.fromEntries(
    ["mentor", "planner", "year", "period", "week"].map((key) => [
      key,
      randomUUID(),
    ]),
  );
  const at = new Date("2026-09-23T01:02:03.004Z");
  const context = {
    subject: "PLANNING_MENTOR",
    personId: ids.mentor,
    scope: "SELF",
  };
  try {
    for (const person of ["mentor", "planner"]) {
      await database.pool.query(
        "INSERT INTO person(id,nickname,legal_name,status) VALUES($1,$2,$2,'ACTIVE')",
        [ids[person], `planning-mentor-${person}-${ids[person]}`],
      );
      await database.pool.query(
        "INSERT INTO user_account(person_id,phone_normalized,password_hash,login_status) VALUES($1,$2,$3,'ACTIVE')",
        [
          ids[person],
          `139${person === "mentor" ? "00000001" : "00000002"}`,
          "synthetic-password",
        ],
      );
      await database.pool.query(
        "INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('PERSON',$1,$2,'ACTIVE')",
        [ids[person], `person:${ids[person]}`],
      );
    }
    await database.pool.query(
      "INSERT INTO teacher_profile(person_id,business_identity,employment_status) VALUES($1,'ACADEMIC_PLANNER','ACTIVE')",
      [ids.planner],
    );
    await database.pool.query(
      "INSERT INTO role_assignment(person_id,subject_code,scope_type,valid_from,created_by) VALUES($1,'PLANNING_MENTOR','SELF','2026-01-01T00:00:00Z',$1)",
      [ids.mentor],
    );
    await database.pool.query(
      "INSERT INTO academic_year_plan(id,label,starts_on,ends_on,created_by) VALUES($1,'DEV-007 year','2026-01-01','2026-12-31',$2)",
      [ids.year, ids.mentor],
    );
    await database.pool.query(
      "INSERT INTO academic_period(id,academic_year_plan_id,label,starts_on,ends_on) VALUES($1,$2,'DEV-007 period','2026-09-01','2026-09-30')",
      [ids.period, ids.year],
    );
    await database.pool.query(
      "INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month) VALUES($1,$2,1,'REGULAR','2026-09-21','2026-09-27','2026-09-01')",
      [ids.week, ids.period],
    );
    const service = new PostgresPlanningMentorRelationshipService(
      database.pool,
    );
    const addedPreview = await service.preview(
      context,
      {
        action: "ADD",
        plannerPersonId: ids.planner,
        effectiveTeachingWeekId: ids.week,
        reason: "普通周新纳入规划导师管理",
      },
      at,
    );
    const added = await service.publish(
      context,
      addedPreview.previewId,
      "dev-007-add",
      at,
    );
    assert.equal(added.postingStatus, "NO_BALANCE_CHANGE");
    assert.ok(added.resultRelationshipId);
    await database.pool.query("UPDATE person SET status='INACTIVE' WHERE id=$1", [ids.planner]);
    await database.pool.query("UPDATE teacher_profile SET employment_status='INACTIVE' WHERE person_id=$1", [ids.planner]);
    await database.pool.query("UPDATE user_account SET login_status='REVOKED' WHERE person_id=$1", [ids.planner]);
    await database.pool.query("UPDATE settlement_account SET status='INACTIVE' WHERE owner_type='PERSON' AND owner_id=$1", [ids.planner]);
    assert.equal((await service.listDirectory(context, at)).managedPlanners[0]?.personId, ids.planner);
    const removedPreview = await service.preview(
      context,
      {
        action: "REMOVE",
        plannerPersonId: ids.planner,
        effectiveTeachingWeekId: ids.week,
        reason: "普通周移出规划导师管理",
      },
      at,
    );
    const removed = await service.publish(
      context,
      removedPreview.previewId,
      "dev-007-remove",
      at,
    );
    assert.equal(removed.postingStatus, "NO_BALANCE_CHANGE");
    assert.equal(removed.resultRelationshipId, null);
    const facts = await database.pool.query(
      `SELECT
         (SELECT count(*)::int FROM planning_mentor_relationship_change) AS changes,
         (SELECT count(*)::int FROM person_relationship
           WHERE relationship_type='PLANNING_MENTOR' AND superseded_by_planning_mentor_change_id IS NOT NULL) AS superseded,
         (SELECT count(*)::int FROM audit_event
           WHERE action_code IN ('PLANNING_MENTOR_RELATIONSHIP_ADDED','PLANNING_MENTOR_RELATIONSHIP_REMOVED')) AS audits`,
    );
    assert.deepEqual(facts.rows[0], { changes: 2, superseded: 1, audits: 2 });
  } finally {
    await database.close();
  }
});

test("真实 PostgreSQL：普通周 ADD/REMOVE 重算完整九分类、保留前周且同周 supersession", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  const { pool } = database;
  try {
    const ids = await seed(pool);
    const at = new Date("2026-09-23T04:00:00.000Z");
    const service = new PostgresPlanningMentorRelationshipService(pool);
    const weekly = new PostgresWeeklySettlementService(pool);
    const feeByWeek = new Map();
    for (const weekId of [ids.previousWeek, ids.currentWeek, ids.nextWeek]) {
      const settled = await weekly.recordAndSettle(
        ids.receiver,
        {
          referralCaseId: ids.referral,
          teachingWeekId: weekId,
          venueId: ids.venue,
          settlementMonth: "2026-09-01",
          grossAmountCents: 100_003n,
          expectedVersion: 0,
        },
        `dev-007-${weekId}`,
      );
      feeByWeek.set(weekId, settled.fee.id);
    }
    const before = new Map();
    for (const [weekId, feeId] of feeByWeek) before.set(weekId, await latest(pool, feeId));
    const initialMentorBalance = await balance(pool, ids.mentor);
    const initialPlannerBalance = await balance(pool, ids.planner);

    const directory = await service.listDirectory(mentorContext(ids.mentor), at);
    assert.equal(directory.mentorPersonId, ids.mentor);
    assert.deepEqual(directory.managedPlanners, []);
    assert.deepEqual(directory.availablePlanners.map((person) => person.personId), [ids.planner]);
    assert.equal(directory.currentWeeks[0].id, ids.currentWeek);

    const preview = await service.preview(mentorContext(ids.mentor), {
      action: "ADD",
      plannerPersonId: ids.planner,
      effectiveTeachingWeekId: ids.currentWeek,
      reason: "普通周纳入规划导师并重算既有介绍费",
    }, at);
    assert.equal(preview.consideredFeeCount, 2);
    assert.equal(preview.changedFeeCount, 2);
    assert.equal(preview.excludedRefundCount, 0);
    assert.equal(preview.mentorDeltaCents, "4000");
    assert.equal(preview.plannerDeltaCents, "-4000");

    const published = await service.publish(
      mentorContext(ids.mentor), preview.previewId, "dev-007-add-posting", at,
    );
    assert.equal(published.postingStatus, "POSTED");
    assert.ok(published.resultRelationshipId);
    assert.equal(published.changedFeeCount, 2);
    assert.equal((await service.publish(
      mentorContext(ids.mentor), preview.previewId, "dev-007-add-posting", at,
    )).replay, true);
    assert.equal(await balance(pool, ids.mentor), initialMentorBalance + 4000n);
    assert.equal(await balance(pool, ids.planner), initialPlannerBalance - 4000n);

    assert.equal((await latest(pool, feeByWeek.get(ids.previousWeek))).id, before.get(ids.previousWeek).id);
    for (const weekId of [ids.currentWeek, ids.nextWeek]) {
      const prior = before.get(weekId);
      const after = await latest(pool, feeByWeek.get(weekId));
      assert.notEqual(after.id, prior.id);
      assert.equal(after.snapshot_json.lines.length, 9);
      assert.equal(after.snapshot_json.lines.find((line) => line.key === "planningMentor").cents, "2000");
      assert.equal(after.context_json.relationships.planningMentor.personId, ids.mentor);
      assert.equal(after.context_json.accounts.planningMentor.ownerId, ids.mentor);
    }
    const addEffects = (await pool.query(
      `SELECT effect.*, change.settlement_calculation_run_id::text AS run_id
         FROM planning_mentor_relationship_change_effect effect
         JOIN planning_mentor_relationship_change change ON change.id=effect.change_id
        WHERE effect.change_id=$1 ORDER BY effect.weekly_fee_entry_id`,
      [published.changeId],
    )).rows;
    assert.equal(addEffects.length, 2);
    for (const effect of addEffects) {
      assert.equal(effect.delta_json.entries.reduce((total, row) => total + BigInt(row.amountCents), 0n), 0n);
      assert.ok(effect.delta_json.entries.some((row) => row.categoryKey === "planningMentor"));
      assert.ok(effect.delta_json.entries.some((row) => row.categoryKey === "referrer"));
      assert.equal(effect.run_id, (await latest(pool, effect.weekly_fee_entry_id)).run_id);
    }
    const expectedLedger = new Map();
    for (const effect of addEffects) for (const entry of effect.delta_json.entries) {
      const key = `${entry.accountKey}\u0000${entry.categoryKey}`;
      expectedLedger.set(key, (expectedLedger.get(key) ?? 0n) + BigInt(entry.amountCents));
    }
    const addChange = (await pool.query(
      "SELECT ledger_event_id::text FROM planning_mentor_relationship_change WHERE id=$1", [published.changeId],
    )).rows[0];
    const actualLedger = (await pool.query(
      `SELECT account.account_code,entry.category_key,entry.amount_cents::text
         FROM ledger_entry entry JOIN settlement_account account ON account.id=entry.account_id
        WHERE entry.event_id=$1 ORDER BY account.account_code,entry.category_key`,
      [addChange.ledger_event_id],
    )).rows;
    const actualLedgerByKey = new Map(actualLedger.map((entry) => [
      `${entry.account_code}\u0000${entry.category_key}`, BigInt(entry.amount_cents),
    ]));
    assert.deepEqual(actualLedgerByKey, expectedLedger, "ledger must equal the aggregate of every local effect delta");
    for (const accountCode of new Set(actualLedger.map((entry) => entry.account_code))) {
      const account = (await pool.query("SELECT id::text FROM settlement_account WHERE account_code=$1", [accountCode])).rows[0];
      await assertProjectionMatchesLedger(pool, account.id);
    }
    assert.equal((await pool.query(
      "SELECT count(*)::int AS n FROM weekly_fee_allocation_snapshot WHERE run_id=$1",
      [addEffects[0].run_id],
    )).rows[0].n, 2);

    const removePreview = await service.preview(mentorContext(ids.mentor), {
      action: "REMOVE",
      plannerPersonId: ids.planner,
      effectiveTeachingWeekId: ids.currentWeek,
      reason: "同一普通周移出规划导师关系",
    }, at);
    const removed = await service.publish(
      mentorContext(ids.mentor), removePreview.previewId, "dev-007-remove-posting", at,
    );
    assert.equal(removed.postingStatus, "POSTED");
    assert.equal(removed.resultRelationshipId, null);
    assert.equal(await balance(pool, ids.mentor), initialMentorBalance);
    assert.equal(await balance(pool, ids.planner), initialPlannerBalance);
    const relation = (await pool.query(
      `SELECT superseded_at,superseded_by_planning_mentor_change_id::text AS change_id
         FROM person_relationship WHERE id=$1`,
      [published.resultRelationshipId],
    )).rows[0];
    assert.notEqual(relation.superseded_at, null);
    assert.equal(relation.change_id, removed.changeId);
    assert.equal((await latest(pool, feeByWeek.get(ids.previousWeek))).id, before.get(ids.previousWeek).id);
    for (const weekId of [ids.currentWeek, ids.nextWeek]) {
      const afterRemove = await latest(pool, feeByWeek.get(weekId));
      assert.equal(afterRemove.snapshot_json.lines.length, 9);
      assert.equal(
        afterRemove.snapshot_json.lines.find((line) => line.key === "planningMentor").cents,
        "0",
        `REMOVE must append zero-mentor snapshot for ${weekId}: ${JSON.stringify(afterRemove)}`,
      );
      assert.equal(afterRemove.context_json.relationships.planningMentor, null);
      assert.equal(afterRemove.context_json.accounts.planningMentor, undefined);
    }
    const changes = await pool.query(
      `SELECT action,before_json,after_json,posting_status
         FROM planning_mentor_relationship_change ORDER BY relationship_version`,
    );
    assert.deepEqual(changes.rows.map((row) => row.action), ["ADD", "REMOVE"]);
    assert.equal(changes.rows[0].before_json, null);
    assert.equal(changes.rows[0].after_json.relationshipType, "PLANNING_MENTOR");
    assert.equal(changes.rows[1].before_json.relationshipType, "PLANNING_MENTOR");
    assert.equal(changes.rows[1].after_json, null);
  } finally {
    await database.close();
  }
});

test("真实 PostgreSQL：零额不伪造分录，重叠导师任命由数据库守卫拒绝", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  const { pool } = database;
  try {
    const ids = await seed(pool);
    const service = new PostgresPlanningMentorRelationshipService(pool);
    const weekly = new PostgresWeeklySettlementService(pool);
    const at = new Date("2026-09-23T04:00:00.000Z");
    const zero = await weekly.recordAndSettle(ids.receiver, {
      referralCaseId: ids.referral,
      teachingWeekId: ids.currentWeek,
      venueId: ids.venue,
      settlementMonth: "2026-09-01",
      grossAmountCents: 0n,
      expectedVersion: 0,
    }, "dev-007-zero");
    const preview = await service.preview(mentorContext(ids.mentor), {
      action: "ADD",
      plannerPersonId: ids.planner,
      effectiveTeachingWeekId: ids.currentWeek,
      reason: "零额费用仅变关系不产生虚假账本",
    }, at);
    assert.equal(preview.consideredFeeCount, 1);
    assert.equal(preview.changedFeeCount, 0);
    assert.equal(preview.zeroShareFeeCount, 1);
    const published = await service.publish(
      mentorContext(ids.mentor), preview.previewId, "dev-007-zero-add", at,
    );
    assert.equal(published.postingStatus, "NO_BALANCE_CHANGE");
    const persisted = (await pool.query(
      `SELECT settlement_calculation_run_id,ledger_event_id FROM planning_mentor_relationship_change WHERE id=$1`,
      [published.changeId],
    )).rows[0];
    assert.equal(persisted.settlement_calculation_run_id, null);
    assert.equal(persisted.ledger_event_id, null);
    assert.equal((await pool.query(
      "SELECT count(*)::int AS n FROM planning_mentor_relationship_change_effect WHERE change_id=$1",
      [published.changeId],
    )).rows[0].n, 0);
    assert.equal((await latest(pool, zero.fee.id)).snapshot_json.lines.find((line) => line.key === "planningMentor").cents, "0");

    await assert.rejects(
      pool.query(
        `INSERT INTO role_assignment(person_id,subject_code,scope_type,valid_from,created_by)
           VALUES($1,'PLANNING_MENTOR','SELF','2026-01-01T00:00:00Z',$2)`,
        [ids.mentor, ids.admin],
      ),
      (error) => error?.code === "23P01",
    );
    assert.equal((await service.listDirectory(mentorContext(ids.mentor), at)).mentorPersonId, ids.mentor);
  } finally {
    await database.close();
  }
});

test("真实 PostgreSQL：幂等重放仍须重新验证当前导师任命", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  const { pool } = database;
  try {
    const ids = await seed(pool);
    const service = new PostgresPlanningMentorRelationshipService(pool);
    const at = new Date("2026-09-23T04:00:00.000Z");
    const preview = await service.preview(mentorContext(ids.mentor), {
      action: "ADD",
      plannerPersonId: ids.planner,
      effectiveTeachingWeekId: ids.currentWeek,
      reason: "幂等重放也必须遵循当前授权",
    }, at);
    await service.publish(mentorContext(ids.mentor), preview.previewId, "dev-007-replay-role", at);
    await pool.query(
      `UPDATE role_assignment SET valid_to='2026-09-23T04:30:00.000Z'
        WHERE person_id=$1 AND subject_code='PLANNING_MENTOR'`,
      [ids.mentor],
    );
    await assert.rejects(
      service.publish(
        mentorContext(ids.mentor), preview.previewId, "dev-007-replay-role",
        new Date("2026-09-23T05:00:00.000Z"),
      ),
      /FORBIDDEN_SCOPE/,
    );
  } finally {
    await database.close();
  }
});

test("真实 PostgreSQL：legacy 与明确学业规划来源纳入，规划导师来源必须排除", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const legacyDatabase = await createTestDatabase(connectionString);
  const explicitDatabase = await createTestDatabase(connectionString);
  const mentorDatabase = await createTestDatabase(connectionString);
  try {
    const at = new Date("2026-09-23T04:00:00.000Z");
    const cases = [
      [legacyDatabase.pool, await seed(legacyDatabase.pool), null, 1],
      [explicitDatabase.pool, await seed(explicitDatabase.pool), "ACADEMIC_PLANNER", 1],
      [mentorDatabase.pool, await seed(mentorDatabase.pool), "PLANNING_MENTOR", 0],
    ];
    for (const [pool, ids, sourceSubject, expected] of cases) {
      if (sourceSubject !== null) await recordReferralSource(pool, ids, sourceSubject);
      await new PostgresWeeklySettlementService(pool).recordAndSettle(ids.receiver, {
        referralCaseId: ids.referral,
        teachingWeekId: ids.currentWeek,
        venueId: ids.venue,
        settlementMonth: "2026-09-01",
        grossAmountCents: 100_000n,
        expectedVersion: 0,
      }, `dev-007-source-${sourceSubject ?? "legacy"}`);
      const preview = await new PostgresPlanningMentorRelationshipService(pool).preview(
        mentorContext(ids.mentor), {
          action: "ADD",
          plannerPersonId: ids.planner,
          effectiveTeachingWeekId: ids.currentWeek,
          reason: "来源身份决定是否允许规划导师分润",
        }, at,
      );
      assert.equal(preview.consideredFeeCount, expected, `${sourceSubject ?? "legacy"} source`);
    }
  } finally {
    await Promise.all([legacyDatabase.close(), explicitDatabase.close(), mentorDatabase.close()]);
  }
});

test("真实 PostgreSQL：预览后任何冻结收款账户变化必须使发布失效且零副作用", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  const { pool } = database;
  try {
    const ids = await seed(pool);
    const at = new Date("2026-09-23T04:00:00.000Z");
    await new PostgresWeeklySettlementService(pool).recordAndSettle(ids.receiver, {
      referralCaseId: ids.referral,
      teachingWeekId: ids.currentWeek,
      venueId: ids.venue,
      settlementMonth: "2026-09-01",
      grossAmountCents: 100_000n,
      expectedVersion: 0,
    }, "dev-007-stale-account-fee");
    const service = new PostgresPlanningMentorRelationshipService(pool);
    const preview = await service.preview(mentorContext(ids.mentor), {
      action: "ADD",
      plannerPersonId: ids.planner,
      effectiveTeachingWeekId: ids.currentWeek,
      reason: "账户状态变化必须让既有预览过期",
    }, at);
    await pool.query(
      "UPDATE settlement_account SET status='INACTIVE' WHERE owner_type='PERSON' AND owner_id=$1",
      [ids.groupLeader],
    );
    await assert.rejects(
      service.publish(mentorContext(ids.mentor), preview.previewId, "dev-007-stale-account", at),
      /RELATIONSHIP_PREVIEW_STALE|RELATIONSHIP_DATA_UNAVAILABLE/,
    );
    assert.equal((await pool.query(
      "SELECT count(*)::int AS n FROM planning_mentor_relationship_change",
    )).rows[0].n, 0);
    assert.equal((await pool.query(
      "SELECT count(*)::int AS n FROM person_relationship WHERE relationship_type='PLANNING_MENTOR'",
    )).rows[0].n, 0);
  } finally {
    await database.close();
  }
});

test("真实 PostgreSQL：关系冲突、所有权、未变化及时间范围错误保持稳定且无发布副作用", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  const { pool } = database;
  try {
    const ids = await seed(pool);
    const at = new Date("2026-09-23T04:00:00.000Z");
    const service = new PostgresPlanningMentorRelationshipService(pool);
    const otherMentor = await addPlanningMentor(pool, ids, "conflict");
    const draft = {
      plannerPersonId: ids.planner,
      effectiveTeachingWeekId: ids.currentWeek,
      reason: "稳定业务错误不得产生关系发布",
    };
    const otherService = new PostgresPlanningMentorRelationshipService(pool);
    const otherAdd = await otherService.preview(mentorContext(otherMentor), { ...draft, action: "ADD" }, at);
    await otherService.publish(mentorContext(otherMentor), otherAdd.previewId, "dev-007-other-mentor-add", at);
    await assert.rejects(service.preview(mentorContext(ids.mentor), { ...draft, action: "ADD" }, at), /PLANNING_MENTOR_RELATIONSHIP_CONFLICT/);
    await assert.rejects(service.preview(mentorContext(ids.mentor), { ...draft, action: "REMOVE" }, at), /PLANNING_MENTOR_RELATIONSHIP_NOT_OWNED/);
    const otherRemove = await otherService.preview(mentorContext(otherMentor), { ...draft, action: "REMOVE" }, at);
    await otherService.publish(mentorContext(otherMentor), otherRemove.previewId, "dev-007-other-mentor-remove", at);
    await assert.rejects(service.preview(mentorContext(ids.mentor), { ...draft, action: "REMOVE" }, at), /PLANNING_MENTOR_RELATIONSHIP_MISSING/);
    const ownAdd = await service.preview(mentorContext(ids.mentor), { ...draft, action: "ADD" }, at);
    await service.publish(mentorContext(ids.mentor), ownAdd.previewId, "dev-007-own-mentor-add", at);
    await assert.rejects(service.preview(mentorContext(ids.mentor), { ...draft, action: "ADD" }, at), /RELATIONSHIP_TARGET_UNCHANGED/);
    await assert.rejects(service.preview(mentorContext(ids.mentor), {
      ...draft, action: "REMOVE", effectiveTeachingWeekId: ids.previousWeek,
    }, at), /RELATIONSHIP_EFFECTIVE_WEEK_NOT_CURRENT/);
    await pool.query("UPDATE teaching_week SET week_kind='WINTER_SPECIAL' WHERE id=$1", [ids.currentWeek]);
    await assert.rejects(service.preview(mentorContext(ids.mentor), { ...draft, action: "REMOVE" }, at), /RELATIONSHIP_SPECIAL_PERIOD_SCOPE_REQUIRED/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM planning_mentor_relationship_change")).rows[0].n, 3);
  } finally {
    await database.close();
  }
});

test("真实 PostgreSQL：同一幂等键不可替换为另一张预览", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  try {
    const ids = await seed(database.pool);
    const service = new PostgresPlanningMentorRelationshipService(database.pool);
    const at = new Date("2026-09-23T04:00:00.000Z");
    const draft = {
      action: "ADD",
      plannerPersonId: ids.planner,
      effectiveTeachingWeekId: ids.currentWeek,
      reason: "同一键只允许精确重放同一预览",
    };
    const first = await service.preview(mentorContext(ids.mentor), draft, at);
    const second = await service.preview(mentorContext(ids.mentor), draft, at);
    assert.notEqual(first.previewId, second.previewId);
    await service.publish(mentorContext(ids.mentor), first.previewId, "dev-007-preview-identity", at);
    await assert.rejects(
      service.publish(mentorContext(ids.mentor), second.previewId, "dev-007-preview-identity", at),
      /IDEMPOTENCY_REPLAY/,
    );
    assert.equal((await artifactCounts(database.pool)).changes, 1);
  } finally {
    await database.close();
  }
});

test("真实 PostgreSQL：预览后的费版本、退款、关系或任命变化均原子拒绝", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const variants = ["fee-version", "refund", "relationship", "assignment"];
  for (const variant of variants) {
    const database = await createTestDatabase(connectionString);
    try {
      const { pool } = database;
      const ids = await seed(pool);
      const at = new Date("2026-09-23T04:00:00.000Z");
      const settled = await settle(pool, ids, ids.currentWeek, 100_000n, `dev-007-stale-${variant}`);
      const service = new PostgresPlanningMentorRelationshipService(pool);
      const preview = await service.preview(mentorContext(ids.mentor), {
        action: "ADD",
        plannerPersonId: ids.planner,
        effectiveTeachingWeekId: ids.currentWeek,
        reason: `发布前${variant}变化必须使冻结预览失效`,
      }, at);
      if (variant === "fee-version") {
        await new PostgresWeeklySettlementService(pool).recordAndSettle(ids.receiver, {
          referralCaseId: ids.referral,
          teachingWeekId: ids.currentWeek,
          venueId: ids.venue,
          settlementMonth: "2026-09-01",
          grossAmountCents: 100_001n,
          expectedVersion: 1,
        }, "dev-007-stale-fee-version-replace");
      } else if (variant === "refund") {
        const snapshot = await latest(pool, settled.fee.id);
        const documentId = randomUUID();
        await pool.query(
          `INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at)
           VALUES($1,$2,'REFUND','REFUNDED',1,$3,$3)`,
          [documentId, ids.receiver, at.toISOString()],
        );
        // The refund workflow owns creation of this evidence.  This test only
        // constructs an already-approved, isolated refund fact so DEV-007 can
        // prove it refuses a preview frozen before that fact existed.
        await pool.query("ALTER TABLE weekly_fee_refund_effect DISABLE TRIGGER USER");
        try {
          await pool.query(
            `INSERT INTO weekly_fee_refund_effect(weekly_fee_entry_id,finance_document_id,allocation_snapshot_id,source_weekly_fee_version,gross_amount_cents,snapshot_json,created_at)
             VALUES($1,$2,$3,1,100000,'{}'::jsonb,$4)`,
            [settled.fee.id, documentId, snapshot.id, at.toISOString()],
          );
        } finally {
          await pool.query("ALTER TABLE weekly_fee_refund_effect ENABLE TRIGGER USER");
        }
      } else if (variant === "relationship") {
        const other = await addPlanningMentor(pool, ids, "stale");
        const otherService = new PostgresPlanningMentorRelationshipService(pool);
        const otherPreview = await otherService.preview(mentorContext(other), {
          action: "ADD", plannerPersonId: ids.planner, effectiveTeachingWeekId: ids.currentWeek,
          reason: "其他导师的已发布关系使原预览过期",
        }, at);
        await otherService.publish(mentorContext(other), otherPreview.previewId, "dev-007-stale-other-publish", at);
      } else {
        await pool.query(
          `UPDATE role_assignment SET valid_to='2026-09-23T03:30:00.000Z'
            WHERE person_id=$1 AND subject_code='PLANNING_MENTOR'`,
          [ids.mentor],
        );
      }
      const beforePublish = await artifactCounts(pool);
      await assert.rejects(
        service.publish(mentorContext(ids.mentor), preview.previewId, `dev-007-stale-publish-${variant}`, at),
        /RELATIONSHIP_PREVIEW_STALE|FORBIDDEN_SCOPE|RELATIONSHIP_DATA_UNAVAILABLE|PLANNING_MENTOR_RELATIONSHIP_CONFLICT/,
      );
      assert.deepEqual(await artifactCounts(pool), beforePublish, variant);
    } finally {
      await database.close();
    }
  }
});

test("真实 PostgreSQL：关系变更始终使用费用快照的不可变策略版本", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  try {
    const { pool } = database;
    const ids = await seed(pool);
    const at = new Date("2026-09-23T04:00:00.000Z");
    const settled = await settle(pool, ids, ids.currentWeek, 100_000n, "dev-007-immutable-policy-fee");
    const before = await latest(pool, settled.fee.id);
    const originalPolicy = (await pool.query(
      "SELECT policy_json FROM rate_policy_version WHERE id=(SELECT policy_version_id FROM weekly_fee_allocation_snapshot WHERE id=$1)",
      [before.id],
    )).rows[0].policy_json;
    const newerPolicy = { ...DEFAULT_RATE_POLICY_VALUES, planningMentorWeightBasisPoints: 0n };
    await pool.query(
      `INSERT INTO rate_policy_version(version,effective_from,policy_json,reason,published_by)
       VALUES(2,'2026-09-22',$1::jsonb,'new current policy must not retier old fee',$2)`,
      [stringify(newerPolicy), ids.admin],
    );
    const service = new PostgresPlanningMentorRelationshipService(pool);
    const preview = await service.preview(mentorContext(ids.mentor), {
      action: "ADD", plannerPersonId: ids.planner, effectiveTeachingWeekId: ids.currentWeek,
      reason: "旧费用必须保留其结算时的规划导师策略权重",
    }, at);
    await service.publish(mentorContext(ids.mentor), preview.previewId, "dev-007-immutable-policy", at);
    const after = await latest(pool, settled.fee.id);
    assert.equal(
      after.context_json.resolvedRates.planningMentorWeightBasisPoints,
      String(originalPolicy.planningMentorWeightBasisPoints),
    );
    assert.notEqual(after.context_json.resolvedRates.planningMentorWeightBasisPoints, "0");
  } finally {
    await database.close();
  }
});

test("真实 PostgreSQL：负余额不阻止关系发布，投影持续等于全账本", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  const client = await database.pool.connect();
  try {
    const ids = await seed(database.pool);
    const plannerAccount = await personAccountId(database.pool, ids.planner);
    const mentorAccount = await personAccountId(database.pool, ids.mentor);
    const accounts = (await database.pool.query(
      "SELECT owner_id::text,account_code FROM settlement_account WHERE id=ANY($1::uuid[])",
      [[plannerAccount, mentorAccount]],
    )).rows;
    const plannerCode = accounts.find((row) => row.owner_id === ids.planner).account_code;
    const mentorCode = accounts.find((row) => row.owner_id === ids.mentor).account_code;
    await client.query("BEGIN");
    await postLedgerEvent({ transaction: (work) => work(createPostgresLedgerTransaction(client)) }, {
      eventKey: `dev-007-negative-opening:${ids.planner}`,
      eventType: "WEEKLY_FEE_SETTLEMENT",
      payloadHash: "0".repeat(64),
      deltas: [
        { accountKey: plannerCode, categoryKey: "opening", amountCents: -1_000_000n },
        { accountKey: mentorCode, categoryKey: "opening", amountCents: 1_000_000n },
      ],
    }, randomUUID);
    await client.query("COMMIT");
    const settled = await settle(database.pool, ids, ids.currentWeek, 100_000n, "dev-007-negative-fee");
    const service = new PostgresPlanningMentorRelationshipService(database.pool);
    const at = new Date("2026-09-23T04:00:00.000Z");
    const preview = await service.preview(mentorContext(ids.mentor), {
      action: "ADD", plannerPersonId: ids.planner, effectiveTeachingWeekId: ids.currentWeek,
      reason: "历史负余额不应阻止普通周关系结算",
    }, at);
    const published = await service.publish(mentorContext(ids.mentor), preview.previewId, "dev-007-negative-balance", at);
    assert.equal(published.postingStatus, "POSTED");
    assert.ok((await balance(database.pool, ids.planner)) < 0n);
    await assertProjectionMatchesLedger(database.pool, plannerAccount);
    await assertProjectionMatchesLedger(database.pool, mentorAccount);
    assert.ok((await latest(database.pool, settled.fee.id)).run_id);
  } finally {
    await client.release();
    await database.close();
  }
});

test("真实 PostgreSQL：最大余数尾差的第三分类变化仍完整落入逐 effect 与总账本", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  try {
    const { pool } = database;
    const ids = await seed(pool);
    const initial = await settle(pool, ids, ids.currentWeek, 1n, "dev-007-largest-remainder-probe");
    const probe = await latest(pool, initial.fee.id);
    const rates = probe.context_json.resolvedRates;
    const rate = (name) => BigInt(rates[name]);
    const allocate = (gross, mentorWeight) => {
      const poolRate = rate("actualIntroPoolBasisPoints");
      const numerators = [
        poolRate * (10_000n - mentorWeight), poolRate * mentorWeight,
        rate("groupLeaderRateBasisPoints") * 10_000n,
        rate("teachingMentorRateBasisPoints") * 10_000n,
        rate("venueRateBasisPoints") * 10_000n,
        rate("campusConsultationRateBasisPoints") * 10_000n,
        rate("platformFinanceRateBasisPoints") * 10_000n,
        rate("regionFinanceRateBasisPoints") * 10_000n,
      ];
      numerators.push(100_000_000n - numerators.reduce((total, value) => total + value, 0n));
      return allocateRationalCents(gross, 100_000_000n, numerators.map((numerator, index) => ({
        key: ["referrer", "planningMentor", "groupLeader", "teachingMentor", "venue", "campusConsultation", "platformFinance", "regionFinance", "teachingTeacher"][index],
        numerator,
      })));
    };
    const mentorWeight = BigInt(DEFAULT_RATE_POLICY_VALUES.planningMentorWeightBasisPoints);
    const gross = Array.from({ length: 200_000 }, (_, offset) => BigInt(offset + 1)).find((candidate) => {
      const beforeLines = new Map(allocate(candidate, 0n).map((line) => [line.key, line.cents]));
      return allocate(candidate, mentorWeight).some((line) => !["referrer", "planningMentor"].includes(line.key)
        && line.cents !== beforeLines.get(line.key));
    });
    assert.ok(gross, "fixture must be derived from the actual largest-remainder algorithm");
    await new PostgresWeeklySettlementService(pool).recordAndSettle(ids.receiver, {
      referralCaseId: ids.referral, teachingWeekId: ids.currentWeek, venueId: ids.venue,
      settlementMonth: "2026-09-01", grossAmountCents: gross, expectedVersion: 1,
    }, "dev-007-largest-remainder-final");
    const before = await latest(pool, initial.fee.id);
    const service = new PostgresPlanningMentorRelationshipService(pool);
    const at = new Date("2026-09-23T04:00:00.000Z");
    const preview = await service.preview(mentorContext(ids.mentor), {
      action: "ADD", plannerPersonId: ids.planner, effectiveTeachingWeekId: ids.currentWeek,
      reason: "最大余数尾差必须同样被完整守恒入账",
    }, at);
    const published = await service.publish(mentorContext(ids.mentor), preview.previewId, "dev-007-largest-remainder", at);
    const after = await latest(pool, initial.fee.id);
    const beforeByKey = new Map(before.snapshot_json.lines.map((line) => [line.key, BigInt(line.cents)]));
    const afterByKey = new Map(after.snapshot_json.lines.map((line) => [line.key, BigInt(line.cents)]));
    const thirdCategoryDeltas = [...afterByKey]
      .filter(([key, cents]) => !["referrer", "planningMentor"].includes(key) && cents !== beforeByKey.get(key))
      .map(([key, cents]) => ({ key, amount: cents - beforeByKey.get(key) }));
    assert.ok(thirdCategoryDeltas.some((delta) => delta.amount === 1n || delta.amount === -1n), thirdCategoryDeltas);
    const effect = (await pool.query(
      "SELECT delta_json FROM planning_mentor_relationship_change_effect WHERE change_id=$1",
      [published.changeId],
    )).rows[0];
    for (const delta of thirdCategoryDeltas) {
      assert.ok(effect.delta_json.entries.some((entry) =>
        entry.categoryKey === delta.key && BigInt(entry.amountCents) === delta.amount,
      ), `effect must preserve ${delta.key} tail delta`);
    }
    const ledger = (await pool.query(
      `SELECT account.account_code,entry.category_key,entry.amount_cents::text
         FROM ledger_entry entry JOIN settlement_account account ON account.id=entry.account_id
        WHERE event_id=(SELECT ledger_event_id FROM planning_mentor_relationship_change WHERE id=$1)`,
      [published.changeId],
    )).rows;
    assert.equal(ledger.reduce((total, entry) => total + BigInt(entry.amount_cents), 0n), 0n);
    assert.ok(ledger.some((entry) => thirdCategoryDeltas.some((delta) => entry.category_key === delta.key)));
  } finally {
    await database.close();
  }
});

test("真实 PostgreSQL：UTC 与 Asia/Shanghai 会话时区得到相同普通周预览与发布金额", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const run = async (zone) => {
    const database = await createTestDatabase(connectionString);
    try {
      await database.pool.query(`SET TIME ZONE '${zone}'`);
      const ids = await seed(database.pool);
      await settle(database.pool, ids, ids.currentWeek, 100_003n, `dev-007-zone-${zone}`);
      const service = new PostgresPlanningMentorRelationshipService(database.pool);
      const at = new Date("2026-09-23T04:00:00.000Z");
      const preview = await service.preview(mentorContext(ids.mentor), {
        action: "ADD", plannerPersonId: ids.planner, effectiveTeachingWeekId: ids.currentWeek,
        reason: "会话时区不能改变普通周结算边界",
      }, at);
      const published = await service.publish(mentorContext(ids.mentor), preview.previewId, `dev-007-zone-publish-${zone}`, at);
      return {
        effectiveAt: preview.effectiveAt,
        counts: [preview.consideredFeeCount, preview.changedFeeCount, preview.excludedRefundCount],
        deltas: [preview.plannerDeltaCents, preview.mentorDeltaCents],
        published: [published.plannerDeltaCents, published.mentorDeltaCents, published.postingStatus],
      };
    } finally {
      await database.close();
    }
  };
  assert.deepEqual(await run("UTC"), await run("Asia/Shanghai"));
});

test("真实 PostgreSQL：第 1 周 ADD 后第 2 周 REMOVE 只重算第 2 周起，首周快照保持历史", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  try {
    const { pool } = database;
    const ids = await seed(pool);
    const weekly = new PostgresWeeklySettlementService(pool);
    const fees = new Map();
    for (const weekId of [ids.previousWeek, ids.currentWeek, ids.nextWeek]) {
      const settled = await weekly.recordAndSettle(ids.receiver, {
        referralCaseId: ids.referral, teachingWeekId: weekId, venueId: ids.venue,
        settlementMonth: "2026-09-01", grossAmountCents: 100_000n, expectedVersion: 0,
      }, `dev-007-cross-week-${weekId}`);
      fees.set(weekId, settled.fee.id);
    }
    const service = new PostgresPlanningMentorRelationshipService(pool);
    const weekOneAt = new Date("2026-09-15T04:00:00.000Z");
    const addPreview = await service.preview(mentorContext(ids.mentor), {
      action: "ADD", plannerPersonId: ids.planner, effectiveTeachingWeekId: ids.previousWeek,
      reason: "第一普通周纳入规划导师",
    }, weekOneAt);
    const added = await service.publish(mentorContext(ids.mentor), addPreview.previewId, "dev-007-week-one-add", weekOneAt);
    assert.equal(added.postingStatus, "POSTED");
    assert.equal((await latest(pool, fees.get(ids.previousWeek))).snapshot_json.lines.find((line) => line.key === "planningMentor").cents, "2000");
    const weekOneAfterAdd = await latest(pool, fees.get(ids.previousWeek));
    const weekTwoAt = new Date("2026-09-23T04:00:00.000Z");
    const removePreview = await service.preview(mentorContext(ids.mentor), {
      action: "REMOVE", plannerPersonId: ids.planner, effectiveTeachingWeekId: ids.currentWeek,
      reason: "第二普通周起移出规划导师",
    }, weekTwoAt);
    assert.equal(removePreview.consideredFeeCount, 2);
    const removed = await service.publish(mentorContext(ids.mentor), removePreview.previewId, "dev-007-week-two-remove", weekTwoAt);
    assert.equal(removed.postingStatus, "POSTED");
    assert.equal((await latest(pool, fees.get(ids.previousWeek))).id, weekOneAfterAdd.id);
    for (const weekId of [ids.currentWeek, ids.nextWeek]) {
      assert.equal((await latest(pool, fees.get(weekId))).snapshot_json.lines.find((line) => line.key === "planningMentor").cents, "0");
    }
    const source = (await pool.query(
      `SELECT to_char(valid_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS valid_to,
              superseded_by_planning_mentor_change_id
         FROM person_relationship WHERE id=$1`,
      [added.resultRelationshipId],
    )).rows[0];
    assert.equal(source.valid_to, "2026-09-20T16:00:00.000Z");
    assert.equal(source.superseded_by_planning_mentor_change_id, null);
  } finally {
    await database.close();
  }
});

test("真实 PostgreSQL：发布后证据、逐 effect delta、终态快照和账本均拒绝直接篡改", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  try {
    const { pool } = database;
    const ids = await seed(pool);
    await settle(pool, ids, ids.currentWeek, 100_000n, "dev-007-direct-guard-fee");
    const service = new PostgresPlanningMentorRelationshipService(pool);
    const at = new Date("2026-09-23T04:00:00.000Z");
    const preview = await service.preview(mentorContext(ids.mentor), {
      action: "ADD", plannerPersonId: ids.planner, effectiveTeachingWeekId: ids.currentWeek,
      reason: "直接 SQL 也不可改变已发布证据",
    }, at);
    const published = await service.publish(mentorContext(ids.mentor), preview.previewId, "dev-007-direct-guard", at);
    const effect = (await pool.query(
      "SELECT * FROM planning_mentor_relationship_change_effect WHERE change_id=$1",
      [published.changeId],
    )).rows[0];
    const change = (await pool.query(
      "SELECT * FROM planning_mentor_relationship_change WHERE id=$1",
      [published.changeId],
    )).rows[0];
    const audit = (await pool.query(
      `SELECT id::text FROM audit_event WHERE subject_type='PERSON_RELATIONSHIP' AND subject_id=$1
       ORDER BY created_at DESC LIMIT 1`,
      [published.resultRelationshipId],
    )).rows[0];
    const snapshot = (await pool.query(
      "SELECT * FROM weekly_fee_allocation_snapshot WHERE id=$1",
      [effect.result_snapshot_id],
    )).rows[0];
    const plannerAccount = await personAccountId(pool, ids.planner);

    for (const [table, id] of [
      ["planning_mentor_relationship_change_preview", preview.previewId],
      ["planning_mentor_relationship_change", published.changeId],
      ["planning_mentor_relationship_change_effect", published.changeId],
    ]) {
      const column = table.endsWith("effect") ? "change_id" : "id";
      await assert.rejects(pool.query(`UPDATE ${table} SET created_at=created_at WHERE ${column}=$1`, [id]), /IMMUTABLE/);
      await assert.rejects(pool.query(`DELETE FROM ${table} WHERE ${column}=$1`, [id]), /IMMUTABLE/);
    }
    await assert.rejects(pool.query(
      `INSERT INTO planning_mentor_relationship_change_effect(
         change_id,weekly_fee_entry_id,source_weekly_fee_version,teaching_week_id,settlement_month,
         previous_snapshot_id,result_snapshot_id,settlement_calculation_run_id,
         planner_before_cents,planner_after_cents,mentor_before_cents,mentor_after_cents,delta_json,created_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'{"entries":[]}'::jsonb,$13)`,
      [effect.change_id, effect.weekly_fee_entry_id, effect.source_weekly_fee_version,
        effect.teaching_week_id, effect.settlement_month, effect.previous_snapshot_id,
        effect.result_snapshot_id, effect.settlement_calculation_run_id,
        effect.planner_before_cents, effect.planner_after_cents,
        effect.mentor_before_cents, effect.mentor_after_cents, at.toISOString()],
    ), /PLANNING_MENTOR_RELATIONSHIP_CHANGE_EFFECT_INVALID/);
    await assert.rejects(pool.query(
      `INSERT INTO weekly_fee_allocation_snapshot(
         id,run_id,weekly_fee_entry_id,source_weekly_fee_version,policy_version_id,net_monthly_cents,snapshot_json,context_json,created_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [randomUUID(), snapshot.run_id, snapshot.weekly_fee_entry_id, snapshot.source_weekly_fee_version,
        snapshot.policy_version_id, snapshot.net_monthly_cents, snapshot.snapshot_json, snapshot.context_json, at.toISOString()],
    ), /PLANNING_MENTOR_RELATIONSHIP_CHANGE_TERMINAL_IMMUTABLE/);
    await assert.rejects(pool.query(
      "INSERT INTO ledger_entry(event_id,account_id,category_key,amount_cents) VALUES($1,$2,'direct-sql',1)",
      [change.ledger_event_id, plannerAccount],
    ), /PLANNING_MENTOR_RELATIONSHIP_CHANGE_TERMINAL_IMMUTABLE/);
    await assert.rejects(pool.query(
      "DELETE FROM person_relationship WHERE id=$1",
      [published.resultRelationshipId],
    ), /PLANNING_MENTOR_PUBLISHED_RELATIONSHIP_IMMUTABLE/);
    await pool.query("BEGIN");
    try {
      await pool.query(
        "UPDATE person_relationship SET superseded_at=$2,superseded_by_change_id=$3 WHERE id=$1",
        [published.resultRelationshipId, at.toISOString(), published.changeId],
      );
      await assert.rejects(pool.query("COMMIT"), /person_relationship_supersession_pair|PLANNING_MENTOR_PUBLISHED_RELATIONSHIP_IMMUTABLE|foreign key/);
    } finally {
      await pool.query("ROLLBACK");
    }
    // A planning-mentor audit is part of the immutable evidence set.  This
    // assertion is intentionally direct SQL: a service-only guarantee would
    // leave an operator able to rewrite the business fact afterwards.
    await assert.rejects(
      pool.query("UPDATE audit_event SET reason='tampered' WHERE id=$1", [audit.id]),
      /IMMUTABLE|PLANNING_MENTOR/,
    );
  } finally {
    await database.close();
  }
});

test("真实 PostgreSQL：不能直接插入未经 ADD 变更发布的规划导师关系", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  try {
    const ids = await seed(database.pool);
    await database.pool.query("BEGIN");
    try {
      await database.pool.query(
        `INSERT INTO person_relationship(teacher_id,relationship_type,related_person_id,valid_from,effective_scope,created_by)
         VALUES($1,'PLANNING_MENTOR',$2,'2026-09-20T16:00:00Z',$3,$4)`,
        [ids.planner, ids.mentor, `REGULAR_WEEK:${ids.currentWeek}`, ids.mentor],
      );
      await assert.rejects(
        database.pool.query("COMMIT"),
        /PLANNING_MENTOR.*(INSERT|RELATIONSHIP).*INVALID|PLANNING_MENTOR.*UNPUBLISHED/i,
      );
    } finally {
      await database.pool.query("ROLLBACK");
    }
  } finally {
    await database.close();
  }
});

test("真实 PostgreSQL：既有非普通周规划导师关系不能被当前普通周的 REMOVE 接管", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString, { throughMigration: 34 });
  try {
    const ids = await seed(database.pool);
    await database.pool.query(
      `INSERT INTO person_relationship(teacher_id,relationship_type,related_person_id,valid_from,effective_scope,created_by)
       VALUES($1,'PLANNING_MENTOR',$2,'2026-09-20T16:00:00Z','SPECIAL_PERIOD:fall-break',$3)`,
      [ids.planner, ids.mentor, ids.admin],
    );
    const migration = await readFile(
      new URL("../../../../database/migrations/0035_planning_mentor_relationship_changes.sql", import.meta.url),
      "utf8",
    );
    await database.pool.query(migration);
    await assert.rejects(
      new PostgresPlanningMentorRelationshipService(database.pool).preview(mentorContext(ids.mentor), {
        action: "REMOVE", plannerPersonId: ids.planner, effectiveTeachingWeekId: ids.currentWeek,
        reason: "普通周不能改变特殊时段关系",
      }, new Date("2026-09-23T04:00:00.000Z")),
      /RELATIONSHIP_SPECIAL_PERIOD_SCOPE_REQUIRED/,
    );
  } finally {
    await database.close();
  }
});

test("真实 PostgreSQL：未来特殊时段关系成为普通周 ADD 的下一边界，不与其重叠", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString, { throughMigration: 34 });
  try {
    const ids = await seed(database.pool);
    await database.pool.query(
      `INSERT INTO person_relationship(teacher_id,relationship_type,related_person_id,valid_from,effective_scope,created_by)
       VALUES($1,'PLANNING_MENTOR',$2,'2026-09-27T16:00:00Z','SPECIAL_PERIOD:national-day',$3)`,
      [ids.planner, ids.mentor, ids.admin],
    );
    const migration = await readFile(
      new URL("../../../../database/migrations/0035_planning_mentor_relationship_changes.sql", import.meta.url),
      "utf8",
    );
    await database.pool.query(migration);
    const service = new PostgresPlanningMentorRelationshipService(database.pool);
    const preview = await service.preview(mentorContext(ids.mentor), {
        action: "ADD", plannerPersonId: ids.planner, effectiveTeachingWeekId: ids.currentWeek,
        reason: "普通周不能截断未来特殊时段关系",
      }, new Date("2026-09-23T04:00:00.000Z"));
    assert.equal(preview.nextBoundaryAt, "2026-09-27T16:00:00.000Z");
    await service.publish(
      mentorContext(ids.mentor), preview.previewId, "dev-007-future-special-boundary",
      new Date("2026-09-23T04:00:00.000Z"),
    );
    const relation = (await database.pool.query(
      `SELECT to_char(valid_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS valid_to,effective_scope FROM person_relationship
        WHERE id=(SELECT result_relationship_id FROM planning_mentor_relationship_change
                  ORDER BY created_at DESC LIMIT 1)`,
    )).rows[0];
    assert.equal(relation.valid_to, "2026-09-27T16:00:00.000Z");
    assert.equal(relation.effective_scope, `REGULAR_WEEK:${ids.currentWeek}`);
  } finally {
    await database.close();
  }
});

test("真实 PostgreSQL：历史非规划导师审计不得被直接改写为规划导师审计", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  try {
    const ids = await seed(database.pool);
    const audit = (await database.pool.query(
      `INSERT INTO audit_event(actor_person_id,action_code,subject_type,subject_id,reason,created_at)
       VALUES($1,'UNRELATED_ACTION','PERSON',$2,'历史普通审计','2026-09-23T04:00:00Z') RETURNING id::text`,
      [ids.admin, ids.planner],
    )).rows[0];
    await assert.rejects(
      database.pool.query(
        "UPDATE audit_event SET action_code='PLANNING_MENTOR_RELATIONSHIP_ADDED' WHERE id=$1",
        [audit.id],
      ),
      /IMMUTABLE|PLANNING_MENTOR/,
    );
    await database.pool.query("BEGIN");
    try {
      await database.pool.query(
        `INSERT INTO audit_event(actor_person_id,action_code,subject_type,subject_id,reason,created_at)
         VALUES($1,'PLANNING_MENTOR_RELATIONSHIP_ADDED','PERSON_RELATIONSHIP',$2,'伪造规划导师审计','2026-09-23T04:00:00Z')`,
        [ids.admin, ids.planner],
      );
      await assert.rejects(database.pool.query("COMMIT"), /IMMUTABLE|PLANNING_MENTOR/);
    } finally {
      await database.pool.query("ROLLBACK");
    }
  } finally {
    await database.close();
  }
});

test("真实 PostgreSQL：直接写入的预览不得绕过费用清单、计数与退款证据完整性", async (t) => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const insertClone = async (pool, sourcePreviewId, impact) => {
    await pool.query(
      `INSERT INTO planning_mentor_relationship_change_preview(
         id,action,mentor_person_id,planner_person_id,source_relationship_id,result_relationship_id,
         actor_role_assignment_id,effective_teaching_week_id,effective_at,next_boundary_at,reason,
         base_hash,impact_json,created_by_person_id,actor_subject_code,actor_scope_type,created_at
       ) SELECT $1,action,mentor_person_id,planner_person_id,source_relationship_id,result_relationship_id,
                actor_role_assignment_id,effective_teaching_week_id,effective_at,next_boundary_at,reason,
                $2,$3::jsonb,created_by_person_id,actor_subject_code,actor_scope_type,created_at
           FROM planning_mentor_relationship_change_preview WHERE id=$4`,
      [randomUUID(), "0".repeat(64), JSON.stringify(impact), sourcePreviewId],
    );
  };
  const assertBadPreviewCommit = async (pool, sourcePreviewId, impact) => {
    await pool.query("BEGIN");
    try {
      await insertClone(pool, sourcePreviewId, impact);
      await assert.rejects(pool.query("COMMIT"), /PREVIEW.*(INVALID|INCOMPLETE)|PLANNING_MENTOR.*PREVIEW/i);
    } finally {
      await pool.query("ROLLBACK");
    }
  };
  const database = await createTestDatabase(connectionString);
  try {
    const { pool } = database;
    const ids = await seed(pool);
    const at = new Date("2026-09-23T04:00:00.000Z");
    await settle(pool, ids, ids.currentWeek, 100_000n, "dev-007-preview-shape-fee");
    const service = new PostgresPlanningMentorRelationshipService(pool);
    const preview = await service.preview(mentorContext(ids.mentor), {
      action: "ADD", plannerPersonId: ids.planner, effectiveTeachingWeekId: ids.currentWeek,
      reason: "预览费用清单必须保持一费一事实",
    }, at);
    const source = (await pool.query(
      "SELECT impact_json FROM planning_mentor_relationship_change_preview WHERE id=$1", [preview.previewId],
    )).rows[0].impact_json;
    const duplicated = structuredClone(source);
    duplicated.fees.push(structuredClone(duplicated.fees[0]));
    duplicated.totals.changedFeeCount += 1;
    await assertBadPreviewCommit(pool, preview.previewId, duplicated);
    const wrongConsidered = structuredClone(source);
    wrongConsidered.totals.consideredFeeCount += 1;
    await assertBadPreviewCommit(pool, preview.previewId, wrongConsidered);
    const wrongZero = structuredClone(source);
    wrongZero.totals.zeroShareFeeCount = 1;
    await assertBadPreviewCommit(pool, preview.previewId, wrongZero);
    const unknownFeeKey = structuredClone(source);
    unknownFeeKey.fees[0].unexpected = "must-not-pass";
    await assertBadPreviewCommit(pool, preview.previewId, unknownFeeKey);
    const missingFeeKey = structuredClone(source);
    delete missingFeeKey.fees[0].version;
    await assertBadPreviewCommit(pool, preview.previewId, missingFeeKey);
    const unknownTotalsKey = structuredClone(source);
    unknownTotalsKey.totals.unexpected = 1;
    await assertBadPreviewCommit(pool, preview.previewId, unknownTotalsKey);
    const missingPlannerDelta = structuredClone(source);
    delete missingPlannerDelta.totals.plannerDeltaCents;
    await assertBadPreviewCommit(pool, preview.previewId, missingPlannerDelta);
    const missingMentorDelta = structuredClone(source);
    delete missingMentorDelta.totals.mentorDeltaCents;
    await assertBadPreviewCommit(pool, preview.previewId, missingMentorDelta);
    for (const field of ["version", "disposition", "snapshotHash", "netMonthlyCents"]) {
      const nullFeeField = structuredClone(source);
      nullFeeField.fees[0][field] = null;
      await assertBadPreviewCommit(pool, preview.previewId, nullFeeField);
    }
    for (const field of ["consideredFeeCount", "changedFeeCount", "zeroShareFeeCount", "excludedRefundCount", "plannerDeltaCents", "mentorDeltaCents"]) {
      const nullTotal = structuredClone(source);
      nullTotal.totals[field] = null;
      await assertBadPreviewCommit(pool, preview.previewId, nullTotal);
    }

    const refundedDatabase = await createTestDatabase(connectionString);
    try {
      const refundIds = await seed(refundedDatabase.pool);
      const refunded = await settle(refundedDatabase.pool, refundIds, refundIds.currentWeek, 100_000n, "dev-007-preview-refund-fee");
      const snapshot = await latest(refundedDatabase.pool, refunded.fee.id);
      const documentId = randomUUID();
      await refundedDatabase.pool.query(
        `INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at)
         VALUES($1,$2,'REFUND','REFUNDED',1,$3,$3)`,
        [documentId, refundIds.receiver, at.toISOString()],
      );
      await refundedDatabase.pool.query("ALTER TABLE weekly_fee_refund_effect DISABLE TRIGGER USER");
      try {
        await refundedDatabase.pool.query(
          `INSERT INTO weekly_fee_refund_effect(weekly_fee_entry_id,finance_document_id,allocation_snapshot_id,source_weekly_fee_version,gross_amount_cents,snapshot_json,created_at)
           VALUES($1,$2,$3,1,100000,'{}'::jsonb,$4)`,
          [refunded.fee.id, documentId, snapshot.id, at.toISOString()],
        );
      } finally {
        await refundedDatabase.pool.query("ALTER TABLE weekly_fee_refund_effect ENABLE TRIGGER USER");
      }
      const refundPreview = await new PostgresPlanningMentorRelationshipService(refundedDatabase.pool).preview(
        mentorContext(refundIds.mentor), {
          action: "ADD", plannerPersonId: refundIds.planner, effectiveTeachingWeekId: refundIds.currentWeek,
          reason: "退款项必须保留可核验退款事实",
        }, at,
      );
      const refundSource = (await refundedDatabase.pool.query(
        "SELECT impact_json FROM planning_mentor_relationship_change_preview WHERE id=$1", [refundPreview.previewId],
      )).rows[0].impact_json;
      const badRefund = structuredClone(refundSource);
      badRefund.fees[0].refundId = null;
      await assertBadPreviewCommit(refundedDatabase.pool, refundPreview.previewId, badRefund);
      const mappedElsewhere = structuredClone(refundSource);
      mappedElsewhere.fees[0].refundId = randomUUID();
      await assertBadPreviewCommit(refundedDatabase.pool, refundPreview.previewId, mappedElsewhere);
    } finally {
      await refundedDatabase.close();
    }
  } finally {
    await database.close();
  }
});
