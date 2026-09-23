import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DEFAULT_RATE_POLICY_VALUES } from "@teaching-research-alliance/domain";
import { PostgresGroupLeaderRelationshipService } from "../../dist/postgres-group-leader-relationship-service.js";
import { PostgresWeeklySettlementService } from "../../dist/postgres-weekly-settlement-service.js";
import { PostgresRefundReviewService } from "../../dist/postgres-refund-review-service.js";
import { resolveSettlementContext } from "../../dist/postgres-settlement-context.js";
import { createTestDatabase } from "./postgres-test-database.mjs";
import { fixture as createRefundFixture } from "./refund-review-fixture.mjs";

const connectionString = process.env.DATABASE_URL;
const stringify = value => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);
const adminContext = personId => ({ subject: "SYSTEM_ADMIN", personId, scope: "GLOBAL" });

const seed = async pool => {
  const keys = [
    "admin", "planner", "teacher", "teacherZero", "leaderA", "leaderB", "leaderC",
    "mentor", "platformFinance", "regionFinance", "region", "campus", "venue",
    "year", "period", "previousWeek", "currentWeek", "nextWeek", "octoberWeek", "novemberWeek",
    "student", "studentZero", "referral", "referralZero"
  ];
  const ids = Object.fromEntries(keys.map(key => [key, randomUUID()]));
  const people = ["admin", "planner", "teacher", "teacherZero", "leaderA", "leaderB", "leaderC", "mentor", "platformFinance", "regionFinance"];
  for (const key of people) {
    await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1,$2,$2,'ACTIVE')", [ids[key], `group-change-${key}-${ids[key]}`]);
  }
  for (const [index, key] of people.entries()) {
    await pool.query(
      "INSERT INTO user_account(person_id,phone_normalized,password_hash,login_status) VALUES($1,$2,$3,'ACTIVE')",
      [ids[key], `1888${String(index).padStart(7, "0")}`, `synthetic-${key}`]
    );
    await pool.query(
      "INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('PERSON',$1,$2,'ACTIVE')",
      [ids[key], `person:${ids[key]}`]
    );
  }
  await pool.query(
    "INSERT INTO organization_unit(id,unit_type,name) VALUES($1,'REGION',$2),($3,'CAMPUS',$4)",
    [ids.region, `region-${ids.region}`, ids.campus, `campus-${ids.campus}`]
  );
  await pool.query(
    "INSERT INTO campus_region_assignment(campus_id,region_id,valid_from,created_by) VALUES($1,$2,'2026-01-01T00:00:00Z',$3)",
    [ids.campus, ids.region, ids.admin]
  );
  await pool.query(
    `INSERT INTO teacher_profile(person_id,business_identity,region_id,campus_id,employment_status)
     VALUES($1,'ACADEMIC_PLANNER',$2,$3,'ACTIVE'),($4,'TEACHING_TEACHER',$2,$3,'ACTIVE'),
           ($5,'TEACHING_TEACHER',$2,$3,'ACTIVE')`,
    [ids.planner, ids.region, ids.campus, ids.teacher, ids.teacherZero]
  );
  for (const personId of [ids.planner, ids.teacher, ids.teacherZero]) {
    await pool.query(
      "INSERT INTO person_campus_assignment(person_id,campus_id,region_id,valid_from,created_by) VALUES($1,$2,$3,'2026-01-01T00:00:00Z',$4)",
      [personId, ids.campus, ids.region, ids.admin]
    );
  }
  const addRole = async (personId, subject, scope, scopeId, validFrom = "2026-01-01T00:00:00Z") => {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO role_assignment(id,person_id,subject_code,scope_type,scope_id,valid_from,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [id, personId, subject, scope, scopeId, validFrom, ids.admin]
    );
    return id;
  };
  await addRole(ids.admin, "SYSTEM_ADMIN", "GLOBAL", null);
  await addRole(ids.platformFinance, "HEADQUARTERS_FINANCE", "GLOBAL", null);
  await addRole(ids.regionFinance, "REGION_FINANCE", "REGION", ids.region);
  // The appointment starts on Wednesday; allocation still backdates to this teaching week's start.
  ids.leaderBRole = await addRole(ids.leaderB, "GROUP_LEADER", "ASSOCIATED_TEACHERS", null, "2026-09-23T03:00:00Z");
  ids.leaderCRole = await addRole(ids.leaderC, "GROUP_LEADER", "ASSOCIATED_TEACHERS", null, "2026-09-23T03:00:00Z");
  await pool.query(
    `INSERT INTO person_relationship(teacher_id,relationship_type,related_person_id,valid_from,effective_scope,created_by)
     VALUES($1,'GROUP_LEADER',$2,'2026-01-01T00:00:00Z','CURRENT',$3),
           ($1,'TEACHING_MENTOR',$4,'2026-01-01T00:00:00Z','CURRENT',$3),
           ($5,'GROUP_LEADER',$2,'2026-09-20T15:59:59.999999Z','CURRENT',$3),
           ($5,'TEACHING_MENTOR',$4,'2026-01-01T00:00:00Z','CURRENT',$3)`,
    [ids.teacher, ids.leaderA, ids.admin, ids.mentor, ids.teacherZero]
  );
  await pool.query(
    "INSERT INTO venue(id,owner_person_id,name,status,default_for_owner) VALUES($1,$2,$3,'ACTIVE',true)",
    [ids.venue, ids.teacher, `venue-${ids.venue}`]
  );
  await pool.query("INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('VENUE',$1,$2,'ACTIVE')", [ids.venue, `venue:${ids.venue}`]);
  await pool.query("INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('COMPANY',$1,$2,'ACTIVE')", [ids.campus, `company:${ids.campus}`]);
  await pool.query(
    "INSERT INTO academic_year_plan(id,label,starts_on,ends_on,created_by) VALUES($1,'2026','2026-01-01','2026-12-31',$2)",
    [ids.year, ids.admin]
  );
  await pool.query(
    "INSERT INTO academic_period(id,academic_year_plan_id,label,starts_on,ends_on) VALUES($1,$2,'regular','2026-09-01','2026-12-31')",
    [ids.period, ids.year]
  );
  const weeks = [
    [ids.previousWeek, 1, "2026-09-14", "2026-09-20", "2026-09-01"],
    [ids.currentWeek, 2, "2026-09-21", "2026-09-27", "2026-09-01"],
    [ids.nextWeek, 3, "2026-09-28", "2026-10-04", "2026-09-01"],
    [ids.octoberWeek, 4, "2026-10-05", "2026-10-11", "2026-10-01"],
    [ids.novemberWeek, 5, "2026-11-02", "2026-11-08", "2026-11-01"]
  ];
  for (const [id, sequence, starts, ends, month] of weeks) {
    await pool.query(
      "INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month,status) VALUES($1,$2,$3,'REGULAR',$4,$5,$6,'OPEN')",
      [id, ids.period, sequence, starts, ends, month]
    );
  }
  await pool.query(
    "INSERT INTO rate_policy_version(version,effective_from,policy_json,reason,published_by) VALUES(1,'2026-09-01',$1::jsonb,'synthetic',$2)",
    [stringify(DEFAULT_RATE_POLICY_VALUES), ids.admin]
  );
  const addReferral = async (referralId, studentId, receiverId, label) => {
    await pool.query(
      "INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name) VALUES($1,$2,$3,$4)",
      [studentId, receiverId, `course-${label}`, `student-${label}`]
    );
    await pool.query(
      `INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,version)
       VALUES($1,$2,$3,$4,'ACADEMIC_PLANNER','ACCEPTED','2026-09-01T00:00:00Z',2)`,
      [referralId, studentId, ids.planner, receiverId]
    );
  };
  await addReferral(ids.referral, ids.student, ids.teacher, "main");
  await addReferral(ids.referralZero, ids.studentZero, ids.teacherZero, "zero");
  return ids;
};

const latest = async (pool, feeId) => (await pool.query(
  `SELECT id::text,run_id::text,sequence_no::text,snapshot_json,context_json
     FROM weekly_fee_allocation_snapshot snapshot WHERE weekly_fee_entry_id=$1
     ORDER BY snapshot.sequence_no DESC LIMIT 1`, [feeId]
)).rows[0];
const balance = async (pool, personId) => BigInt((await pool.query(
  `SELECT COALESCE(projection.balance_cents,0)::text AS value FROM settlement_account account
   LEFT JOIN account_balance_projection projection ON projection.account_id=account.id
   WHERE account.owner_type='PERSON' AND account.owner_id=$1`, [personId]
)).rows[0].value);

const relationshipFact = row => ({
  id: row.id,
  teacherPersonId: row.teacher_id,
  relationshipType: row.relationship_type,
  relatedPersonId: row.related_person_id,
  validFrom: row.valid_from,
  validTo: row.valid_to,
  effectiveScope: row.effective_scope,
  createdByPersonId: row.created_by,
  createdAt: row.created_at,
  supersededAt: row.superseded_at,
  supersededByChangeId: row.superseded_by_change_id
});

const relationshipRow = async (client, id) => (await client.query(
  `SELECT id::text,teacher_id::text,relationship_type,related_person_id::text,
          group_leader_timestamp_text(valid_from) AS valid_from,
          group_leader_timestamp_text(valid_to) AS valid_to,
          effective_scope,created_by::text,group_leader_timestamp_text(created_at) AS created_at,
          group_leader_timestamp_text(superseded_at) AS superseded_at,superseded_by_change_id::text
     FROM person_relationship WHERE id=$1`, [id]
)).rows[0];

const assertZeroChangeGuard = async (pool, previewId, {
  publisherId, actorSubject = "SYSTEM_ADMIN", sourceRelatedPersonId,
  replacementPreview
}) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let preview = (await client.query("SELECT * FROM person_relationship_change_preview WHERE id=$1", [previewId])).rows[0];
    if (replacementPreview) {
      const id = randomUUID();
      const impact = structuredClone(preview.impact_json);
      impact.effectiveWeek.id = replacementPreview.weekId;
      impact.effectiveWeek.startsOn = replacementPreview.startsOn;
      impact.effectiveWeek.endsOn = replacementPreview.endsOn;
      impact.effectiveAt = replacementPreview.effectiveAt;
      await client.query(
        `INSERT INTO person_relationship_change_preview(
           id,relationship_type,teacher_person_id,source_relationship_id,source_related_person_id,new_related_person_id,
           candidate_role_assignment_id,effective_teaching_week_id,effective_at,next_boundary_at,reason,base_hash,
           impact_json,created_by_person_id,actor_subject_code,actor_scope_type,created_at
         ) SELECT $1,relationship_type,teacher_person_id,source_relationship_id,source_related_person_id,new_related_person_id,
                  candidate_role_assignment_id,$2,$3,next_boundary_at,reason,$4,$5::jsonb,
                  created_by_person_id,actor_subject_code,actor_scope_type,created_at
             FROM person_relationship_change_preview WHERE id=$6`,
        [id, replacementPreview.weekId, replacementPreview.effectiveAt, "c".repeat(64), stringify(impact), previewId]
      );
      preview = (await client.query("SELECT * FROM person_relationship_change_preview WHERE id=$1", [id])).rows[0];
    }
    const changeId = randomUUID();
    const resultRelationshipId = randomUUID();
    const beforeSource = preview.impact_json.sourceRelationship;
    if (new Date(beforeSource.validFrom).getTime() === new Date(preview.effective_at).getTime()) {
      await client.query(
        "UPDATE person_relationship SET superseded_at=$2,superseded_by_change_id=$3 WHERE id=$1",
        [preview.source_relationship_id, preview.created_at, changeId]
      );
    } else {
      await client.query("UPDATE person_relationship SET valid_to=$2 WHERE id=$1", [preview.source_relationship_id, preview.effective_at]);
    }
    await client.query(
      `INSERT INTO person_relationship(
         id,teacher_id,relationship_type,related_person_id,valid_from,valid_to,effective_scope,created_by,created_at
       ) VALUES($1,$2,'GROUP_LEADER',$3,$4,$5,$6,$7,$8)`,
      [resultRelationshipId, preview.teacher_person_id, preview.new_related_person_id,
        preview.effective_at, preview.next_boundary_at, `REGULAR_WEEK:${preview.effective_teaching_week_id}`,
        publisherId, preview.created_at]
    );
    const sourceAfter = await relationshipRow(client, preview.source_relationship_id);
    const result = await relationshipRow(client, resultRelationshipId);
    const totals = preview.impact_json.totals;
    await client.query(
      `INSERT INTO person_relationship_change(
         id,preview_id,relationship_type,teacher_person_id,relationship_version,source_relationship_id,
         result_relationship_id,source_related_person_id,new_related_person_id,candidate_role_assignment_id,
         effective_teaching_week_id,effective_at,next_boundary_at,reason,idempotency_key,request_hash,base_hash,
         posting_status,settlement_calculation_run_id,ledger_event_id,considered_fee_count,moved_fee_count,
         excluded_refund_count,moved_amount_cents,before_json,after_json,published_by_person_id,
         actor_subject_code,actor_scope_type,published_at,created_at
       ) VALUES($1,$2,'GROUP_LEADER',$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                'NO_BALANCE_CHANGE',NULL,NULL,$16,0,$17,0,$18::jsonb,$19::jsonb,$20,$21,'GLOBAL',$22,$22)`,
      [changeId, preview.id, preview.teacher_person_id, preview.source_relationship_id,
        resultRelationshipId, sourceRelatedPersonId ?? preview.source_related_person_id,
        preview.new_related_person_id, preview.candidate_role_assignment_id,
        preview.effective_teaching_week_id, preview.effective_at, preview.next_boundary_at,
        preview.reason, randomUUID(), "d".repeat(64), preview.base_hash,
        totals.consideredFeeCount, totals.excludedRefundCount,
        stringify({ sourceRelationship: beforeSource }),
        stringify({ sourceRelationship: relationshipFact(sourceAfter), resultRelationship: relationshipFact(result) }),
        publisherId, actorSubject, preview.created_at]
    );
    await assert.rejects(client.query("SET CONSTRAINTS ALL IMMEDIATE"), /PERSON_RELATIONSHIP_CHANGE_INCOMPLETE/);
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { await client.release(); }
};

const trackServiceConnection = pool => {
  let resolvePid;
  const pid = new Promise(resolve => { resolvePid = resolve; });
  let connected = false;
  return {
    pid,
    pool: {
      connect: async () => {
        if (connected) throw new Error("TRACKED_SERVICE_OPENED_MULTIPLE_CONNECTIONS");
        connected = true;
        const client = await pool.connect();
        resolvePid(client.processID);
        return client;
      }
    }
  };
};

const poolAtTimeZone = (pool, timeZone) => ({
  connect: async () => {
    const client = await pool.connect();
    let originalTimeZone;
    try {
      originalTimeZone = String(Object.values((await client.query("SHOW TimeZone")).rows[0])[0]);
      await client.query("SELECT set_config('TimeZone',$1,false)", [timeZone]);
    } catch (error) {
      client.release(error);
      throw error;
    }
    let released = false;
    return new Proxy(client, {
      get(target, property) {
        if (property === "release") {
          return async error => {
            if (released) return;
            released = true;
            if (error !== undefined) {
              target.release(error);
              return;
            }
            try {
              await target.query("SELECT set_config('TimeZone',$1,false)", [originalTimeZone]);
              target.release();
            } catch (resetError) {
              target.release(resetError);
              throw resetError;
            }
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  }
});

const waitForGateHolder = async (pool, blockerPid, holderPid) => {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const ready = (await pool.query(
      `WITH gate AS (SELECT hashtextextended('settlement-allocation-gate:v1',0) AS value)
       SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity activity
          WHERE activity.pid=$2::int AND $1::int=ANY(pg_blocking_pids(activity.pid))
            AND EXISTS (
              SELECT 1 FROM pg_locks advisory,gate
               WHERE advisory.pid=activity.pid AND advisory.locktype='advisory'
                 AND advisory.classid::bigint=((gate.value >> 32) & 4294967295)
                 AND advisory.objid::bigint=(gate.value & 4294967295)
                 AND advisory.objsubid=1 AND advisory.mode='ExclusiveLock' AND advisory.granted
            )
       ) AS ready`, [blockerPid, holderPid]
    )).rows[0].ready;
    if (ready) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error("TARGET_EXCLUSIVE_GATE_HOLDER_NOT_OBSERVED");
};

const waitForGateFollower = async (pool, holderPid, followerPid) => {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const ready = (await pool.query(
      `WITH gate AS (SELECT hashtextextended('settlement-allocation-gate:v1',0) AS value)
       SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity activity
          WHERE activity.pid=$2::int AND $1::int=ANY(pg_blocking_pids(activity.pid))
            AND EXISTS (
              SELECT 1 FROM pg_locks advisory,gate
               WHERE advisory.pid=activity.pid AND advisory.locktype='advisory'
                 AND advisory.classid::bigint=((gate.value >> 32) & 4294967295)
                 AND advisory.objid::bigint=(gate.value & 4294967295)
                 AND advisory.objsubid=1 AND advisory.mode='ShareLock' AND NOT advisory.granted
            )
       ) AS ready`, [holderPid, followerPid]
    )).rows[0].ready;
    if (ready) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error("TARGET_SHARED_GATE_FOLLOWER_NOT_OBSERVED");
};

test("真实PostgreSQL普通周组长预览/发布、同周再换、零额与终态防篡改", async t => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const database = await createTestDatabase(connectionString);
  const { pool } = database;
  try {
    const ids = await seed(pool);
    const weekly = new PostgresWeeklySettlementService(pool);
    const service = new PostgresGroupLeaderRelationshipService(pool);
    const at = new Date("2026-09-23T04:00:00Z");
    const guardPreview = await service.preview(adminContext(ids.admin), {
      teacherPersonId: ids.teacher, newRelatedPersonId: ids.leaderB,
      effectiveTeachingWeekId: ids.currentWeek, reason: "数据库约束反例基线"
    }, at);
    await assertZeroChangeGuard(pool, guardPreview.previewId, {
      publisherId: ids.admin,
      sourceRelatedPersonId: ids.leaderC
    });
    await assertZeroChangeGuard(pool, guardPreview.previewId, {
      publisherId: ids.leaderA,
      actorSubject: "SYSTEM_ADMIN"
    });
    await assertZeroChangeGuard(pool, guardPreview.previewId, {
      publisherId: ids.admin,
      replacementPreview: {
        weekId: ids.previousWeek,
        startsOn: "2026-09-14",
        endsOn: "2026-09-20",
        effectiveAt: "2026-09-13T16:00:00.000Z"
      }
    });
    const feeByWeek = new Map();
    for (const [weekId, month] of [
      [ids.previousWeek, "2026-09-01"], [ids.currentWeek, "2026-09-01"],
      [ids.nextWeek, "2026-09-01"], [ids.octoberWeek, "2026-10-01"]
    ]) {
      const result = await weekly.recordAndSettle(ids.teacher, {
        referralCaseId: ids.referral, teachingWeekId: weekId, venueId: ids.venue,
        settlementMonth: month, grossAmountCents: 100000n, expectedVersion: 0
      }, randomUUID());
      feeByWeek.set(weekId, result.fee.id);
    }
    const beforeSnapshots = new Map();
    for (const [weekId, feeId] of feeByWeek) beforeSnapshots.set(weekId, await latest(pool, feeId));
    assert.equal(await balance(pool, ids.leaderA), 24000n);
    assert.equal(await balance(pool, ids.leaderB), 0n);

    const candidates = await service.listCandidates(adminContext(ids.admin), at);
    assert.deepEqual(candidates.map(item => item.personId).sort(), [ids.leaderB, ids.leaderC].sort());
    const asiaShanghaiService = new PostgresGroupLeaderRelationshipService(poolAtTimeZone(pool, "Asia/Shanghai"));
    const utcService = new PostgresGroupLeaderRelationshipService(poolAtTimeZone(pool, "UTC"));
    const preview = await asiaShanghaiService.preview(adminContext(ids.admin), {
      teacherPersonId: ids.teacher, newRelatedPersonId: ids.leaderB,
      effectiveTeachingWeekId: ids.currentWeek, reason: "本周组长交接"
    }, at);
    assert.equal(preview.movedFeeCount, 3);
    assert.equal(preview.movedAmountCents, "18000");
    assert.equal(preview.excludedRefundCount, 0);
    const published = await utcService.publish(adminContext(ids.admin), preview.previewId, "leader-a-to-b", at);
    assert.equal(published.postingStatus, "POSTED");
    assert.equal(published.movedFeeCount, 3);
    assert.equal((await service.publish(adminContext(ids.admin), preview.previewId, "leader-a-to-b", at)).replay, true);
    assert.equal(await balance(pool, ids.leaderA), 6000n);
    assert.equal(await balance(pool, ids.leaderB), 18000n);

    const previousAfter = await latest(pool, feeByWeek.get(ids.previousWeek));
    assert.equal(previousAfter.id, beforeSnapshots.get(ids.previousWeek).id);
    for (const [label, weekId] of [["current", ids.currentWeek], ["next", ids.nextWeek], ["october", ids.octoberWeek]]) {
      const before = beforeSnapshots.get(weekId);
      const after = await latest(pool, feeByWeek.get(weekId));
      const trace = (await pool.query(
        `SELECT id::text,run_id::text,sequence_no::text FROM weekly_fee_allocation_snapshot snapshot
          WHERE weekly_fee_entry_id=$1 ORDER BY snapshot.sequence_no`,
        [feeByWeek.get(weekId)]
      )).rows;
      assert.notEqual(after.id, before.id, `latest snapshot should move for ${label}:${weekId}:${JSON.stringify(trace)}`);
      assert.deepEqual(after.snapshot_json.lines, before.snapshot_json.lines);
      const beforeWithoutGroup = structuredClone(before.snapshot_json);
      const afterWithoutGroup = structuredClone(after.snapshot_json);
      delete beforeWithoutGroup.accountByKey.groupLeader;
      delete afterWithoutGroup.accountByKey.groupLeader;
      assert.deepEqual(afterWithoutGroup, beforeWithoutGroup);
      assert.equal(after.context_json.relationships.groupLeader.personId, ids.leaderB);
      assert.equal(after.context_json.accounts.groupLeader.ownerId, ids.leaderB);
    }
    const firstChange = (await pool.query(
      "SELECT settlement_calculation_run_id::text run_id,ledger_event_id::text event_id FROM person_relationship_change WHERE id=$1",
      [published.changeId]
    )).rows[0];
    assert.equal((await pool.query("SELECT count(*)::int n FROM weekly_fee_allocation_snapshot WHERE run_id=$1", [firstChange.run_id])).rows[0].n, 3);
    assert.equal((await pool.query("SELECT count(*)::int n FROM person_relationship_change_effect WHERE change_id=$1", [published.changeId])).rows[0].n, 3);
    const refundVerifier = new PostgresRefundReviewService(pool, undefined);
    const verifyClient = await pool.connect();
    try {
      await refundVerifier.verifyHistoricalRuns(verifyClient, [...feeByWeek.values()]);
    } finally { await verifyClient.release(); }

    const secondPreview = await utcService.preview(adminContext(ids.admin), {
      teacherPersonId: ids.teacher, newRelatedPersonId: ids.leaderC,
      effectiveTeachingWeekId: ids.currentWeek, reason: "同周纠正组长"
    }, new Date("2026-09-23T05:00:00Z"));
    const second = await asiaShanghaiService.publish(
      adminContext(ids.admin), secondPreview.previewId, "leader-b-to-c", new Date("2026-09-23T05:00:00Z")
    );
    assert.equal(second.relationshipVersion, 2);
    assert.equal(await balance(pool, ids.leaderA), 6000n);
    assert.equal(await balance(pool, ids.leaderB), 0n);
    assert.equal(await balance(pool, ids.leaderC), 18000n);
    const relationshipRows = (await pool.query(
      `SELECT id::text,related_person_id::text,valid_from::text,valid_to::text,superseded_at::text
         FROM person_relationship WHERE teacher_id=$1 AND relationship_type='GROUP_LEADER'
         ORDER BY created_at,id`, [ids.teacher]
    )).rows;
    assert.equal(relationshipRows.length, 3);
    const leaderARow = relationshipRows.find(row => row.related_person_id === ids.leaderA);
    const leaderBRow = relationshipRows.find(row => row.related_person_id === ids.leaderB);
    const leaderCRow = relationshipRows.find(row => row.related_person_id === ids.leaderC);
    assert.equal(new Date(leaderARow.valid_to).toISOString(), "2026-09-20T16:00:00.000Z");
    assert.notEqual(leaderBRow.superseded_at, null);
    assert.equal(leaderCRow.superseded_at, null);
    await assert.rejects(
      pool.query("UPDATE person_relationship SET related_person_id=$2 WHERE id=$1", [leaderCRow.id, ids.leaderA]),
      /PUBLISHED_PERSON_RELATIONSHIP_IMMUTABLE/
    );
    await assert.rejects(
      pool.query("UPDATE person_relationship SET valid_to='2026-12-31T00:00:00Z' WHERE id=$1", [leaderCRow.id]),
      /PUBLISHED_PERSON_RELATIONSHIP_IMMUTABLE/
    );
    await assert.rejects(
      pool.query("UPDATE person_relationship SET effective_scope='CURRENT' WHERE id=$1", [leaderCRow.id]),
      /PUBLISHED_PERSON_RELATIONSHIP_IMMUTABLE/
    );
    await assert.rejects(
      pool.query("UPDATE person_relationship SET valid_to='2026-09-20T15:59:59Z' WHERE id=$1", [leaderARow.id]),
      /PUBLISHED_PERSON_RELATIONSHIP_IMMUTABLE/
    );
    await assert.rejects(
      pool.query("UPDATE person_relationship SET superseded_at=superseded_at + interval '1 second' WHERE id=$1", [leaderBRow.id]),
      /PUBLISHED_PERSON_RELATIONSHIP_IMMUTABLE/
    );
    await assert.rejects(
      pool.query("DELETE FROM person_relationship WHERE id=$1", [leaderBRow.id]),
      /PUBLISHED_PERSON_RELATIONSHIP_IMMUTABLE/
    );
    const contextClient = await pool.connect();
    try {
      const context = await resolveSettlementContext(contextClient, feeByWeek.get(ids.currentWeek));
      assert.equal(context.contextJson.relationships.groupLeader.personId, ids.leaderC);
    } finally { await contextClient.release(); }
    const verifyAgain = await pool.connect();
    try {
      await refundVerifier.verifyHistoricalRuns(verifyAgain, [...feeByWeek.values()]);
    } finally { await verifyAgain.release(); }

    const zeroFee = await weekly.recordAndSettle(ids.teacherZero, {
      referralCaseId: ids.referralZero, teachingWeekId: ids.currentWeek, venueId: ids.venue,
      settlementMonth: "2026-09-01", grossAmountCents: 0n, expectedVersion: 0
    }, randomUUID());
    const zeroPreview = await service.preview(adminContext(ids.admin), {
      teacherPersonId: ids.teacherZero, newRelatedPersonId: ids.leaderB,
      effectiveTeachingWeekId: ids.currentWeek, reason: "零额周仍更新未来关系"
    }, new Date("2026-09-23T06:00:00Z"));
    assert.equal(zeroPreview.movedFeeCount, 0);
    assert.equal(zeroPreview.zeroShareFeeCount, 1);
    const zeroChange = await service.publish(adminContext(ids.admin), zeroPreview.previewId, "zero-relation-change", new Date("2026-09-23T06:00:00Z"));
    assert.equal(zeroChange.postingStatus, "NO_BALANCE_CHANGE");
    const zeroStored = (await pool.query(
      "SELECT settlement_calculation_run_id,ledger_event_id FROM person_relationship_change WHERE id=$1", [zeroChange.changeId]
    )).rows[0];
    assert.equal(zeroStored.settlement_calculation_run_id, null);
    assert.equal(zeroStored.ledger_event_id, null);
    assert.equal((await pool.query("SELECT count(*)::int n FROM person_relationship_change_effect WHERE change_id=$1", [zeroChange.changeId])).rows[0].n, 0);
    const zeroSource = (await pool.query(
      `SELECT group_leader_timestamp_text(valid_from) AS valid_from,
              group_leader_timestamp_text(valid_to) AS valid_to,superseded_at
         FROM person_relationship
        WHERE teacher_id=$1 AND relationship_type='GROUP_LEADER' AND related_person_id=$2
        ORDER BY created_at,id LIMIT 1`, [ids.teacherZero, ids.leaderA]
    )).rows[0];
    assert.equal(zeroSource.valid_from, "2026-09-20T15:59:59.999999Z");
    assert.equal(zeroSource.valid_to, "2026-09-20T16:00:00.000000Z");
    assert.equal(zeroSource.superseded_at, null);
    const zeroLatest = await latest(pool, zeroFee.fee.id);
    assert.equal(zeroLatest.context_json.relationships.groupLeader.personId, ids.leaderA);
    const future = await weekly.recordAndSettle(ids.teacherZero, {
      referralCaseId: ids.referralZero, teachingWeekId: ids.nextWeek, venueId: ids.venue,
      settlementMonth: "2026-09-01", grossAmountCents: 100000n, expectedVersion: 0
    }, randomUUID());
    assert.equal((await latest(pool, future.fee.id)).context_json.relationships.groupLeader.personId, ids.leaderB);
    const concurrentPreview = await service.preview(adminContext(ids.admin), {
      teacherPersonId: ids.teacherZero, newRelatedPersonId: ids.leaderC,
      effectiveTeachingWeekId: ids.currentWeek, reason: "发布期间验证未来空月份首笔费用"
    }, new Date("2026-09-23T07:00:00Z"));
    const monthBlocker = await pool.connect();
    let monthBlockerOpen = false;
    let concurrentPublish;
    let novemberFee;
    try {
      await monthBlocker.query("BEGIN");
      monthBlockerOpen = true;
      await monthBlocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('settlement-month:2026-09-01',0))"
      );
      const publishConnection = trackServiceConnection(pool);
      const concurrentRelationship = new PostgresGroupLeaderRelationshipService(publishConnection.pool);
      concurrentPublish = concurrentRelationship.publish(
        adminContext(ids.admin), concurrentPreview.previewId, "exclusive-gate-future-month",
        new Date("2026-09-23T07:00:00Z")
      );
      const publishPid = await publishConnection.pid;
      await waitForGateHolder(pool, monthBlocker.processID, publishPid);
      const feeConnection = trackServiceConnection(pool);
      const concurrentWeekly = new PostgresWeeklySettlementService(feeConnection.pool);
      novemberFee = concurrentWeekly.recordAndSettle(ids.teacherZero, {
        referralCaseId: ids.referralZero, teachingWeekId: ids.novemberWeek, venueId: ids.venue,
        settlementMonth: "2026-11-01", grossAmountCents: 100000n, expectedVersion: 0
      }, randomUUID());
      const feePid = await feeConnection.pid;
      await waitForGateFollower(pool, publishPid, feePid);
      await monthBlocker.query("COMMIT");
      monthBlockerOpen = false;
      const [concurrentChange, novemberResult] = await Promise.all([concurrentPublish, novemberFee]);
      assert.equal(concurrentChange.postingStatus, "POSTED");
      assert.equal((await latest(pool, novemberResult.fee.id)).context_json.relationships.groupLeader.personId, ids.leaderC);
    } finally {
      if (monthBlockerOpen) await monthBlocker.query("ROLLBACK").catch(() => {});
      await monthBlocker.release();
      await Promise.allSettled([concurrentPublish, novemberFee].filter(Boolean));
    }

    const firstEffect = (await pool.query(
      `SELECT effect.*,effect.previous_snapshot_id::text,effect.result_snapshot_id::text,
              effect.settlement_calculation_run_id::text,effect.source_account_id::text,
              effect.destination_account_id::text,effect.created_at::text
         FROM person_relationship_change_effect effect
        WHERE effect.change_id=$1 ORDER BY effect.weekly_fee_entry_id LIMIT 1`, [published.changeId]
    )).rows[0];
    const previousFeeId = feeByWeek.get(ids.previousWeek);
    const previousSnapshot = await latest(pool, previousFeeId);
    const effectAttack = async values => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await assert.rejects(client.query(
          `INSERT INTO person_relationship_change_effect(
             change_id,weekly_fee_entry_id,source_weekly_fee_version,teaching_week_id,settlement_month,
             previous_snapshot_id,result_snapshot_id,settlement_calculation_run_id,group_leader_amount_cents,
             source_account_id,destination_account_id,created_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, values
        ), /PERSON_RELATIONSHIP_CHANGE_EFFECT_INVALID/);
        await client.query("ROLLBACK");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally { await client.release(); }
    };
    await effectAttack([
      zeroChange.changeId, firstEffect.weekly_fee_entry_id, firstEffect.source_weekly_fee_version,
      firstEffect.teaching_week_id, firstEffect.settlement_month, firstEffect.previous_snapshot_id,
      firstEffect.result_snapshot_id, firstEffect.settlement_calculation_run_id,
      firstEffect.group_leader_amount_cents, firstEffect.source_account_id,
      firstEffect.destination_account_id, firstEffect.created_at
    ]);
    await effectAttack([
      published.changeId, previousFeeId, "999", ids.previousWeek, "2026-09-01",
      previousSnapshot.id, firstEffect.result_snapshot_id, firstEffect.settlement_calculation_run_id,
      firstEffect.group_leader_amount_cents, firstEffect.source_account_id,
      firstEffect.destination_account_id, firstEffect.created_at
    ]);
    const duplicatePreview = await service.preview(adminContext(ids.admin), {
      teacherPersonId: ids.teacher, newRelatedPersonId: ids.leaderB,
      effectiveTeachingWeekId: ids.currentWeek, reason: "验证重复组长分润行被数据库拒绝"
    }, new Date("2026-09-23T07:30:00Z"));
    const snapshotsBeforeDuplicateAttack = new Map();
    for (const [weekId, feeId] of feeByWeek) snapshotsBeforeDuplicateAttack.set(weekId, (await latest(pool, feeId)).id);
    let corruptedFeeId = null;
    let corruptedPreviousSnapshotId = null;
    const corruptingPool = {
      connect: async () => {
        const client = await pool.connect();
        const query = client.query.bind(client);
        return new Proxy(client, {
          get(target, property) {
            if (property === "query") {
              return async (statement, values = []) => {
                if (typeof statement === "string"
                  && statement.includes("INSERT INTO weekly_fee_allocation_snapshot(")
                  && corruptedPreviousSnapshotId === null) {
                  const feeId = values[2];
                  const previousFacts = (await query(
                    `SELECT source_weekly_fee_version::text,policy_version_id::text,
                            net_monthly_cents::text,snapshot_json,context_json
                       FROM weekly_fee_allocation_snapshot
                      WHERE weekly_fee_entry_id=$1 ORDER BY sequence_no DESC LIMIT 1`, [feeId]
                  )).rows[0];
                  const duplicatePreviousJson = structuredClone(previousFacts.snapshot_json);
                  const previousGroupLine = duplicatePreviousJson.lines.find(line => line.key === "groupLeader");
                  duplicatePreviousJson.lines.push(structuredClone(previousGroupLine));
                  const duplicateRunId = randomUUID();
                  const duplicateSnapshotId = randomUUID();
                  await query(
                    `INSERT INTO settlement_calculation_run(
                       id,request_key,fee_entry_id,fee_version,actor_person_id,status,ledger_event_id,created_at
                     ) VALUES($1,$2,$3,$4,$5,'NO_BALANCE_CHANGE',NULL,$6)`,
                    [duplicateRunId, `malicious-duplicate:${duplicateRunId}`, feeId,
                      previousFacts.source_weekly_fee_version, ids.admin, values[8]]
                  );
                  await query(
                    `INSERT INTO weekly_fee_allocation_snapshot(
                       id,run_id,weekly_fee_entry_id,source_weekly_fee_version,policy_version_id,
                       net_monthly_cents,snapshot_json,context_json,created_at
                     ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
                    [duplicateSnapshotId, duplicateRunId, feeId, previousFacts.source_weekly_fee_version,
                      previousFacts.policy_version_id, previousFacts.net_monthly_cents,
                      stringify(duplicatePreviousJson), stringify(previousFacts.context_json), values[8]]
                  );
                  const duplicateResultJson = JSON.parse(values[6]);
                  const resultGroupLine = duplicateResultJson.lines.find(line => line.key === "groupLeader");
                  duplicateResultJson.lines.push(structuredClone(resultGroupLine));
                  corruptedFeeId = feeId;
                  corruptedPreviousSnapshotId = duplicateSnapshotId;
                  const corruptedValues = [...values];
                  corruptedValues[6] = stringify(duplicateResultJson);
                  return query(statement, corruptedValues);
                }
                if (typeof statement === "string"
                  && statement.includes("INSERT INTO person_relationship_change_effect(")
                  && values[1] === corruptedFeeId) {
                  const corruptedValues = [...values];
                  corruptedValues[5] = corruptedPreviousSnapshotId;
                  return query(statement, corruptedValues);
                }
                return query(statement, values);
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      }
    };
    const corruptingService = new PostgresGroupLeaderRelationshipService(corruptingPool);
    await assert.rejects(
      corruptingService.publish(
        adminContext(ids.admin), duplicatePreview.previewId, "duplicate-group-line-attack",
        new Date("2026-09-23T07:30:00Z")
      ),
      /PERSON_RELATIONSHIP_CHANGE_EFFECT_INVALID/
    );
    assert.notEqual(corruptedFeeId, null);
    for (const [weekId, feeId] of feeByWeek) {
      assert.equal((await latest(pool, feeId)).id, snapshotsBeforeDuplicateAttack.get(weekId));
    }

    const laterWeekPreview = await service.preview(adminContext(ids.admin), {
      teacherPersonId: ids.teacher, newRelatedPersonId: ids.leaderB,
      effectiveTeachingWeekId: ids.octoberWeek, reason: "下一普通周边界合法闭合已发布关系"
    }, new Date("2026-10-07T04:00:00Z"));
    assert.equal(laterWeekPreview.movedFeeCount, 1);
    const laterWeekChange = await service.publish(
      adminContext(ids.admin), laterWeekPreview.previewId, "later-week-leader-change",
      new Date("2026-10-07T04:00:00Z")
    );
    assert.equal(laterWeekChange.relationshipVersion, 3);
    const closedLeaderC = (await pool.query(
      "SELECT valid_to::text FROM person_relationship WHERE id=$1", [leaderCRow.id]
    )).rows[0];
    assert.equal(new Date(closedLeaderC.valid_to).toISOString(), "2026-10-04T16:00:00.000Z");
    assert.equal((await latest(pool, feeByWeek.get(ids.currentWeek))).context_json.relationships.groupLeader.personId, ids.leaderC);
    assert.equal((await latest(pool, feeByWeek.get(ids.octoberWeek))).context_json.relationships.groupLeader.personId, ids.leaderB);
    const verifyLaterWeek = await pool.connect();
    try {
      await refundVerifier.verifyHistoricalRuns(verifyLaterWeek, [...feeByWeek.values()]);
    } finally { await verifyLaterWeek.release(); }

    const secondStored = (await pool.query(
      "SELECT settlement_calculation_run_id::text run_id,ledger_event_id::text event_id FROM person_relationship_change WHERE id=$1",
      [second.changeId]
    )).rows[0];
    const attackClient = await pool.connect();
    try {
      await attackClient.query("BEGIN");
      await attackClient.query("SET CONSTRAINTS ALL IMMEDIATE");
      await assert.rejects(
        attackClient.query(
          `INSERT INTO ledger_entry(event_id,account_id,category_key,amount_cents)
           SELECT $1,account.id,'groupLeader',1 FROM settlement_account account
            WHERE account.owner_type='PERSON' AND account.owner_id=$2`,
          [secondStored.event_id, ids.teacher]
        ),
        /PERSON_RELATIONSHIP_CHANGE_TERMINAL_IMMUTABLE/
      );
      await attackClient.query("ROLLBACK");
      await attackClient.query("BEGIN");
      await attackClient.query("SET CONSTRAINTS ALL IMMEDIATE");
      const excluded = await latest(pool, feeByWeek.get(ids.previousWeek));
      await assert.rejects(
        attackClient.query(
          `INSERT INTO weekly_fee_allocation_snapshot(
             id,run_id,weekly_fee_entry_id,source_weekly_fee_version,policy_version_id,
             net_monthly_cents,snapshot_json,context_json,created_at)
           SELECT $1,$2,weekly_fee_entry_id,source_weekly_fee_version,policy_version_id,
                  net_monthly_cents,snapshot_json,context_json,now()
             FROM weekly_fee_allocation_snapshot WHERE id=$3`,
          [randomUUID(), secondStored.run_id, excluded.id]
        ),
        /PERSON_RELATIONSHIP_CHANGE_TERMINAL_IMMUTABLE/
      );
      await attackClient.query("ROLLBACK");
    } finally { await attackClient.release(); }
  } finally {
    await database.close();
  }
});

test("组长发布独占门闩先完成，等待中的退款批准只冲回新组长最新快照", async t => {
  if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
  const f = await createRefundFixture();
  try {
    const oldLeader = randomUUID();
    const newLeader = randomUUID();
    for (const [id, label] of [[oldLeader, "old"], [newLeader, "new"]]) {
      await f.pool.query(
        "INSERT INTO person(id,nickname,legal_name,status) VALUES($1,$2,$2,'ACTIVE')",
        [id, `refund-group-${label}-${id}`]
      );
      await f.pool.query(
        "INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('PERSON',$1,$2,'ACTIVE')",
        [id, `person:${id}`]
      );
    }
    await f.pool.query(
      "INSERT INTO user_account(person_id,phone_normalized,password_hash,login_status) VALUES($1,'18889999999','synthetic','ACTIVE')",
      [newLeader]
    );
    await f.pool.query(
      `INSERT INTO role_assignment(person_id,subject_code,scope_type,scope_id,valid_from,created_by)
       VALUES($1,'SYSTEM_ADMIN','GLOBAL',NULL,'2026-01-01T00:00:00Z',$1),
             ($2,'GROUP_LEADER','ASSOCIATED_TEACHERS',NULL,'2026-09-10T03:00:00Z',$1)`,
      [f.ids.admin, newLeader]
    );
    await f.pool.query(
      "INSERT INTO teacher_profile(person_id,business_identity,employment_status) VALUES($1,'TEACHING_TEACHER','ACTIVE')",
      [f.ids.teacherA]
    );
    for (const teacherId of [f.ids.teacherA, f.ids.teacherB]) {
      await f.pool.query(
        `INSERT INTO person_relationship(
           teacher_id,relationship_type,related_person_id,valid_from,effective_scope,created_by
         ) VALUES($1,'GROUP_LEADER',$2,'2026-01-01T00:00:00Z','CURRENT',$3)`,
        [teacherId, oldLeader, f.ids.admin]
      );
    }
    await f.pool.query(
      `INSERT INTO rate_policy_version(version,effective_from,policy_json,reason,published_by)
       SELECT 2,effective_from,jsonb_set(policy_json,'{groupLeaderRateBasisPoints}','"500"'::jsonb),
              'group leader refund concurrency',$1 FROM rate_policy_version WHERE version=1`,
      [f.ids.admin]
    );
    await f.record(100000n, "refund-group-rate-correction");
    assert.equal(await balance(f.pool, oldLeader), 15000n);
    const document = await f.pending();
    const relationship = new PostgresGroupLeaderRelationshipService(f.pool);
    const preview = await relationship.preview(adminContext(f.ids.admin), {
      teacherPersonId: f.ids.teacherA,
      newRelatedPersonId: newLeader,
      effectiveTeachingWeekId: f.ids.weekRefund,
      reason: "退款批准并发前的组长交接"
    }, new Date("2026-09-10T04:00:00Z"));
    assert.equal(preview.movedFeeCount, 2);

    const monthBlocker = await f.pool.connect();
    let monthBlockerOpen = false;
    let publishing;
    let approving;
    try {
      await monthBlocker.query("BEGIN");
      monthBlockerOpen = true;
      await monthBlocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('settlement-month:2026-09-01',0))"
      );
      const publishConnection = trackServiceConnection(f.pool);
      const concurrentRelationship = new PostgresGroupLeaderRelationshipService(publishConnection.pool);
      publishing = concurrentRelationship.publish(
        adminContext(f.ids.admin), preview.previewId, "refund-vs-relationship-publish",
        new Date("2026-09-10T04:00:00Z")
      );
      const publishPid = await publishConnection.pid;
      await waitForGateHolder(f.pool, monthBlocker.processID, publishPid);
      const approvalConnection = trackServiceConnection(f.pool);
      const concurrentReview = new PostgresRefundReviewService(approvalConnection.pool, f.store);
      approving = concurrentReview.approve(
        f.hqContext, document.id, { expectedVersion: 2, reason: "verified" },
        "refund-after-relationship-gate", new Date("2026-09-21T09:00:00.000Z")
      );
      const approvalPid = await approvalConnection.pid;
      await waitForGateFollower(f.pool, publishPid, approvalPid);
      await monthBlocker.query("COMMIT");
      monthBlockerOpen = false;
      const [change, approval] = await Promise.all([publishing, approving]);
      assert.equal(change.postingStatus, "POSTED");
      assert.equal(approval.status, "REFUNDED");
    } finally {
      if (monthBlockerOpen) await monthBlocker.query("ROLLBACK").catch(() => {});
      await monthBlocker.release();
      await Promise.allSettled([publishing, approving].filter(Boolean));
    }
    assert.equal(await balance(f.pool, oldLeader), 5000n);
    assert.equal(await balance(f.pool, newLeader), 5000n);
    const refundGroupLines = (await f.pool.query(
      `SELECT account.owner_id::text AS owner,entry.amount_cents::text AS amount
         FROM ledger_event event JOIN ledger_entry entry ON entry.event_id=event.id
         JOIN settlement_account account ON account.id=entry.account_id
        WHERE event.event_key=$1 AND entry.category_key='groupLeader'`,
      [`weekly-fee-refund:${document.id}`]
    )).rows;
    assert.deepEqual(refundGroupLines, [{ owner: newLeader, amount: "-5000" }]);
  } finally { await f.close(); }
});
