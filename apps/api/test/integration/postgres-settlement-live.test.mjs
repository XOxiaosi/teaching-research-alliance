import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DEFAULT_RATE_POLICY_VALUES, postLedgerEvent } from "@teaching-research-alliance/domain";
import { PostgresWeeklySettlementService } from "../../dist/postgres-weekly-settlement-service.js";
import { PostgresReferralCreationService, createApiServer, SessionService, PostgresWeeklyFeeService, PostgresPersonalReadService, PostgresLedgerRepository } from "../../dist/main.js";
import { resolveSettlementContext } from "../../dist/postgres-settlement-context.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const connectionString = process.env.DATABASE_URL;
const effectiveFrom = "2026-09-01";
const validFrom = "2026-01-01T00:00:00Z";

const stringifyPolicy = (policy) => JSON.stringify(policy, (_, value) => typeof value === "bigint" ? value.toString() : value);

const addPerson = async (pool, id, name) => {
  await pool.query(
    `INSERT INTO person (id, nickname, legal_name, status)
     VALUES ($1::uuid, $2, $2, 'ACTIVE')`,
    [id, name]
  );
};

const addAccount = async (pool, ownerType, ownerId, code) => {
  await pool.query(
    `INSERT INTO settlement_account (owner_type, owner_id, account_code, status)
     VALUES ($1, $2::uuid, $3, 'ACTIVE')`,
    [ownerType, ownerId, code]
  );
};

const balanceFor = async (pool, ownerType, ownerId) => {
  const result = await pool.query(
    `SELECT COALESCE(projection.balance_cents, 0)::text AS balance_cents
       FROM settlement_account account
       LEFT JOIN account_balance_projection projection ON projection.account_id = account.id
      WHERE account.owner_type = $1 AND account.owner_id = $2::uuid`,
    [ownerType, ownerId]
  );
  assert.equal(result.rows.length, 1);
  return BigInt(result.rows[0].balance_cents);
};

const balancesFor = async (pool, ids) => Promise.all(ids.map(({ ownerType, id }) => balanceFor(pool, ownerType, id)));

const addRole = async (pool, personId, subjectCode, scopeType, scopeId, createdBy) => {
  await pool.query(
    `INSERT INTO role_assignment (person_id, subject_code, scope_type, scope_id, valid_from, created_by)
     VALUES ($1::uuid, $2, $3, $4::uuid, $5::timestamptz, $6::uuid)`,
    [personId, subjectCode, scopeType, scopeId, validFrom, createdBy]
  );
};

const addRelationship = async (pool, teacherId, relationshipType, relatedPersonId, from = validFrom) => {
  await pool.query(
    `INSERT INTO person_relationship (teacher_id, relationship_type, related_person_id, valid_from, effective_scope, created_by)
     VALUES ($1::uuid, $2, $3::uuid, $4::timestamptz, 'CURRENT', $1::uuid)`,
    [teacherId, relationshipType, relatedPersonId, from]
  );
};

const addReferral = async (pool, { referralId, studentId, referrerId, receiverId, weekId, teacherId, label, referrerIdentity = "ACADEMIC_PLANNER" }) => {
  await pool.query(
    `INSERT INTO teacher_student_record (id, owner_teacher_id, course_context_id, display_name)
     VALUES ($1::uuid, $2::uuid, $3, $4)`,
    [studentId, receiverId, `course-${label}`, `集成学生-${label}`]
  );
  await pool.query(
    `INSERT INTO referral_case (id, teacher_student_record_id, referrer_person_id, receiver_person_id, referrer_identity, status, submitted_at, version)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'ACCEPTED', now(), 2)`,
    [referralId, studentId, referrerId, receiverId, referrerIdentity]
  );
  await pool.query(
    `INSERT INTO referral_case_event (referral_case_id, event_type, actor_person_id, reason)
     VALUES ($1::uuid, 'ACCEPTED', $2::uuid, 'integration seed')`,
    [referralId, teacherId]
  );
  return { referralCaseId: referralId, teachingWeekId: weekId };
};

const snapshotRows = async (pool, feeEntryId) => {
  const result = await pool.query(
    `SELECT source_weekly_fee_version::text, snapshot_json::text
       FROM weekly_fee_allocation_snapshot
      WHERE weekly_fee_entry_id = $1::uuid
      ORDER BY sequence_no`,
    [feeEntryId]
  );
  return result.rows;
};

const latestSnapshot = async (pool, feeEntryId) => {
  const result = await pool.query(
    `SELECT snapshot_json::text, context_json::text
       FROM weekly_fee_allocation_snapshot
      WHERE weekly_fee_entry_id = $1::uuid
      ORDER BY sequence_no DESC
      LIMIT 1`,
    [feeEntryId]
  );
  assert.equal(result.rows.length, 1);
  return {
    snapshot: JSON.parse(result.rows[0].snapshot_json),
    context: JSON.parse(result.rows[0].context_json)
  };
};

const ledgerCounts = async (pool) => {
  const result = await pool.query(
    `SELECT (SELECT count(*) FROM ledger_event) AS event_count,
            (SELECT count(*) FROM ledger_entry) AS entry_count,
            (SELECT count(*) FROM weekly_fee_idempotency) AS idempotency_count,
            (SELECT count(*) FROM weekly_fee_entry_version) AS fee_version_count,
            (SELECT count(*) FROM weekly_fee_allocation_snapshot) AS snapshot_count`
  );
  return result.rows[0];
};

test("真实PostgreSQL周结算分配、重放、并发与事务回滚", async () => {
  if (connectionString === undefined || connectionString.trim() === "") {
    throw new Error("DATABASE_URL_REQUIRED_FOR_POSTGRES_INTEGRATION");
  }

  const database = await createTestDatabase(connectionString);
  const { pool } = database;
  const suffix = randomUUID();
  const ids = Object.fromEntries([
    "admin", "planner", "planningMentor", "groupLeader", "teachingMentor", "teacher", "teacherB", "platformFinance", "regionFinance",
    "region", "campus", "year", "period", "week", "student", "referral", "venue"
  ].map((key) => [key, randomUUID()]));
  const ownerIds = [
    { ownerType: "PERSON", id: ids.planner },
    { ownerType: "PERSON", id: ids.planningMentor },
    { ownerType: "PERSON", id: ids.groupLeader },
    { ownerType: "PERSON", id: ids.teachingMentor },
    { ownerType: "PERSON", id: ids.teacher },
    { ownerType: "PERSON", id: ids.platformFinance },
    { ownerType: "PERSON", id: ids.regionFinance },
    { ownerType: "COMPANY", id: ids.campus },
    { ownerType: "VENUE", id: ids.venue }
  ];

  try {
    for (const [key, id] of Object.entries(ids)) {
      if (["region", "campus", "year", "period", "week", "student", "referral", "venue"].includes(key)) continue;
      await addPerson(pool, id, `结算测试-${key}-${suffix}`);
    }
    await pool.query(
      `INSERT INTO organization_unit (id, unit_type, name)
       VALUES ($1::uuid, 'REGION', $2), ($3::uuid, 'CAMPUS', $4)`,
      [ids.region, `测试分区-${suffix}`, ids.campus, `测试校区-${suffix}`]
    );
    await pool.query(
      `INSERT INTO teacher_profile (person_id, business_identity, region_id, campus_id, employment_status)
       VALUES ($1::uuid, 'ACADEMIC_PLANNER', $2::uuid, $3::uuid, 'ACTIVE'),
              ($4::uuid, 'TEACHING_TEACHER', $2::uuid, $3::uuid, 'ACTIVE'),
              ($5::uuid, 'TEACHING_TEACHER', $2::uuid, $3::uuid, 'ACTIVE')`,
      [ids.planner, ids.region, ids.campus, ids.teacher, ids.teacherB]
    );
    await pool.query(
      `INSERT INTO person_campus_assignment (person_id, campus_id, region_id, valid_from, created_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::uuid),
              ($6::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::uuid),
              ($7::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::uuid)`,
      [ids.planner, ids.campus, ids.region, validFrom, ids.admin, ids.teacher, ids.teacherB]
    );
    await addRole(pool, ids.planner, "ACADEMIC_PLANNER", "CAMPUS", ids.campus, ids.admin);
    await addRole(pool, ids.planningMentor, "PLANNING_MENTOR", "ASSOCIATED_TEACHERS", ids.planner, ids.admin);
    await addRole(pool, ids.groupLeader, "GROUP_LEADER", "ASSOCIATED_TEACHERS", ids.teacher, ids.admin);
    await addRole(pool, ids.teachingMentor, "TEACHING_MENTOR", "ASSOCIATED_TEACHERS", ids.teacher, ids.admin);
    await addRole(pool, ids.teacher, "TEACHING_TEACHER", "SELF", ids.teacher, ids.admin);
    await addRole(pool, ids.teacherB, "TEACHING_TEACHER", "SELF", ids.teacherB, ids.admin);
    await addRole(pool, ids.platformFinance, "HEADQUARTERS_FINANCE", "GLOBAL", null, ids.admin);
    await addRole(pool, ids.regionFinance, "REGION_FINANCE", "REGION", ids.region, ids.admin);
    await addRelationship(pool, ids.planner, "PLANNING_MENTOR", ids.planningMentor);
    await addRelationship(pool, ids.teacher, "GROUP_LEADER", ids.groupLeader);
    await addRelationship(pool, ids.teacher, "TEACHING_MENTOR", ids.teachingMentor);
    await addRelationship(pool, ids.teacherB, "GROUP_LEADER", ids.groupLeader);
    await addRelationship(pool, ids.teacherB, "TEACHING_MENTOR", ids.teachingMentor);
    await pool.query(
      `INSERT INTO venue (id, owner_person_id, name, status, default_for_owner)
       VALUES ($1::uuid, $2::uuid, $3, 'ACTIVE', true)`,
      [ids.venue, ids.teacher, `自有场地-${suffix}`]
    );
    await pool.query(
      `INSERT INTO academic_year_plan (id, label, starts_on, ends_on, created_by)
       VALUES ($1::uuid, $2, DATE '2026-09-01', DATE '2027-08-31', $3::uuid)`,
      [ids.year, `测试学年-${suffix}`, ids.admin]
    );
    await pool.query(
      `INSERT INTO academic_period (id, academic_year_plan_id, label, starts_on, ends_on)
       VALUES ($1::uuid, $2::uuid, '普通学期', DATE '2026-09-01', DATE '2027-01-31')`,
      [ids.period, ids.year]
    );
    await pool.query(
      `INSERT INTO teaching_week (id, academic_period_id, sequence_no, week_kind, starts_on, ends_on, settlement_month)
       VALUES ($1::uuid, $2::uuid, 1, 'REGULAR', DATE '2026-09-21', DATE '2026-09-27', DATE '2026-09-01')`,
      [ids.week, ids.period]
    );
    await addAccount(pool, "PERSON", ids.planner, `person:planner:${suffix}`);
    await addAccount(pool, "PERSON", ids.planningMentor, `person:planning-mentor:${suffix}`);
    await addAccount(pool, "PERSON", ids.groupLeader, `person:group-leader:${suffix}`);
    await addAccount(pool, "PERSON", ids.teachingMentor, `person:teaching-mentor:${suffix}`);
    await addAccount(pool, "PERSON", ids.teacher, `person:teacher:${suffix}`);
    await addAccount(pool, "PERSON", ids.teacherB, `person:teacher-b:${suffix}`);
    await addAccount(pool, "PERSON", ids.platformFinance, `person:platform-finance:${suffix}`);
    await addAccount(pool, "PERSON", ids.regionFinance, `person:region-finance:${suffix}`);
    await addAccount(pool, "COMPANY", ids.campus, `company:campus:${suffix}`);
    await addAccount(pool, "VENUE", ids.venue, `venue:${suffix}`);
    await pool.query(
      `INSERT INTO rate_policy_version (version, effective_from, policy_json, reason, published_by)
       VALUES (1, $1::date, $2::jsonb, 'SYSTEM_DEFAULT', $3::uuid)`,
      [effectiveFrom, stringifyPolicy(DEFAULT_RATE_POLICY_VALUES), ids.admin]
    );

    const referral = await addReferral(pool, {
      referralId: ids.referral,
      studentId: ids.student,
      referrerId: ids.planner,
      receiverId: ids.teacher,
      weekId: ids.week,
      teacherId: ids.teacher,
      label: "primary"
    });
    const service = new PostgresWeeklySettlementService(pool);
    const draft = {
      ...referral,
      venueId: ids.venue,
      settlementMonth: effectiveFrom,
      grossAmountCents: 100000n
    };
    // F03: an owned pending referral with a valid venue can carry real weekly fees.
    await pool.query("UPDATE referral_case SET status='PENDING' WHERE id=$1", [ids.referral]);
    const first = await service.recordAndSettle(ids.teacher, draft, `settle:first:${suffix}`);
    assert.equal(first.status, "POSTED");
    assert.equal(first.replay, false);
    assert.deepEqual(await balancesFor(pool, ownerIds), [8000n, 2000n, 6000n, 7000n, 72000n, 2000n, 1000n, 2000n, 0n]);

    const replay = await service.recordAndSettle(ids.teacher, draft, `settle:first:${suffix}`);
    assert.equal(replay.replay, true);
    assert.equal(replay.status, "POSTED");
    assert.deepEqual(await balancesFor(pool, ownerIds), [8000n, 2000n, 6000n, 7000n, 72000n, 2000n, 1000n, 2000n, 0n]);

    const sameAmount = await service.recordAndSettle(ids.teacher, draft, `settle:same-amount:${suffix}`);
    assert.equal(sameAmount.replay, false);
    assert.equal(sameAmount.status, "NO_BALANCE_CHANGE");
    assert.deepEqual(await balancesFor(pool, ownerIds), [8000n, 2000n, 6000n, 7000n, 72000n, 2000n, 1000n, 2000n, 0n]);

    const beforeFailure = await ledgerCounts(pool);
    const beforeSnapshots = await snapshotRows(pool, first.fee.id);
    const beforeFee = await pool.query(
      `SELECT gross_amount_cents::text, version::text FROM weekly_fee_entry WHERE id = $1::uuid`,
      [first.fee.id]
    );
    const groupLeaderAccount = await pool.query(
      `UPDATE settlement_account
          SET status = 'INACTIVE'
        WHERE owner_type = 'PERSON' AND owner_id = $1::uuid
      RETURNING id`,
      [ids.groupLeader]
    );
    assert.equal(groupLeaderAccount.rowCount, 1);
    await assert.rejects(
      () => service.recordAndSettle(ids.teacher, { ...draft, grossAmountCents: 130000n }, `settle:missing-group-leader:${suffix}`),
      /SETTLEMENT_ACCOUNT_MISSING:groupLeader/
    );
    assert.deepEqual(await ledgerCounts(pool), beforeFailure);
    assert.deepEqual(await snapshotRows(pool, first.fee.id), beforeSnapshots);
    assert.deepEqual(
      (await pool.query(`SELECT gross_amount_cents::text, version::text FROM weekly_fee_entry WHERE id = $1::uuid`, [first.fee.id])).rows,
      beforeFee.rows
    );
    assert.deepEqual(await balancesFor(pool, ownerIds), [8000n, 2000n, 6000n, 7000n, 72000n, 2000n, 1000n, 2000n, 0n]);
    await pool.query(
      `UPDATE settlement_account
          SET status = 'ACTIVE'
        WHERE owner_type = 'PERSON' AND owner_id = $1::uuid`,
      [ids.groupLeader]
    );
    await pool.query(`CREATE FUNCTION test_fail_snapshot_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST_SNAPSHOT_FAILURE'; END; $$`);
    await pool.query(`CREATE TRIGGER test_fail_snapshot BEFORE INSERT ON weekly_fee_allocation_snapshot FOR EACH ROW EXECUTE FUNCTION test_fail_snapshot_insert()`);
    await assert.rejects(
      () => service.recordAndSettle(ids.teacher, { ...draft, grossAmountCents: 130000n }, `settle:failure:${suffix}`),
      /TEST_SNAPSHOT_FAILURE/
    );
    assert.deepEqual(await ledgerCounts(pool), beforeFailure);
    assert.deepEqual(await snapshotRows(pool, first.fee.id), beforeSnapshots);
    await pool.query("DROP TRIGGER test_fail_snapshot ON weekly_fee_allocation_snapshot");
    await pool.query("DROP FUNCTION test_fail_snapshot_insert()");

    const corrected = await service.recordAndSettle(ids.teacher, { ...draft, grossAmountCents: 130000n }, `settle:failure:${suffix}`);
    assert.equal(corrected.status, "POSTED");
    assert.deepEqual(await balancesFor(pool, ownerIds), [10400n, 2600n, 7800n, 9100n, 93600n, 2600n, 1300n, 2600n, 0n]);

    const concurrentKey = `settle:concurrent:${suffix}`;
    const concurrent = await Promise.all(Array.from({ length: 5 }, () =>
      service.recordAndSettle(ids.teacher, { ...draft, grossAmountCents: 130000n }, concurrentKey)
    ));
    assert.equal(concurrent.filter((result) => result.replay === false).length, 1);
    assert.equal(concurrent.filter((result) => result.replay === true).length, 4);
    assert.deepEqual(await balancesFor(pool, ownerIds), [10400n, 2600n, 7800n, 9100n, 93600n, 2600n, 1300n, 2600n, 0n]);

    const currentFee = await pool.query(
      `SELECT version::int FROM weekly_fee_entry WHERE id = $1::uuid`,
      [first.fee.id]
    );
    const expectedVersion = currentFee.rows[0].version;
    const guardedResults = await Promise.allSettled([
      service.recordAndSettle(
        ids.teacher,
        { ...draft, grossAmountCents: 140000n, expectedVersion },
        `settle:guarded-a:${suffix}`
      ),
      service.recordAndSettle(
        ids.teacher,
        { ...draft, grossAmountCents: 150000n, expectedVersion },
        `settle:guarded-b:${suffix}`
      )
    ]);
    assert.equal(guardedResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(guardedResults.filter((result) => result.status === "rejected" && /VERSION_CONFLICT/.test(String(result.reason))).length, 1);
    const guardedFee = await pool.query(
      `SELECT gross_amount_cents::text, version::int FROM weekly_fee_entry WHERE id = $1::uuid`,
      [first.fee.id]
    );
    assert.equal(guardedFee.rows[0].version, expectedVersion + 1);

    const oldReplay = await service.recordAndSettle(ids.teacher, draft, `settle:first:${suffix}`);
    assert.equal(oldReplay.replay, true);
    assert.equal(oldReplay.status, "POSTED");
    const afterGuardedBalances = await balancesFor(pool, ownerIds);
    assert.ok([
      [11200n, 2800n, 8400n, 9800n, 100800n, 2800n, 1400n, 2800n, 0n],
      [12000n, 3000n, 9000n, 10500n, 108000n, 3000n, 1500n, 3000n, 0n]
    ].some((expected) => expected.every((value, index) => value === afterGuardedBalances[index])));

    const currentBeforeNormalize = await pool.query(
      `SELECT version::int FROM weekly_fee_entry WHERE id = $1::uuid`,
      [first.fee.id]
    );
    await service.recordAndSettle(
      ids.teacher,
      { ...draft, grossAmountCents: 130000n, expectedVersion: currentBeforeNormalize.rows[0].version },
      `settle:normalize:${suffix}`
    );

    await addRelationship(pool, ids.planner, "GROUP_LEADER", ids.groupLeader);
    await addRelationship(pool, ids.planner, "TEACHING_MENTOR", ids.teachingMentor);
    const tierWeekId = randomUUID();
    const recommendationWeekId = randomUUID();
    const tierReferralId = randomUUID();
    const tierStudentId = randomUUID();
    const recommendationReferralId = randomUUID();
    const recommendationStudentId = randomUUID();
    await pool.query(
      `INSERT INTO teaching_week (id, academic_period_id, sequence_no, week_kind, starts_on, ends_on, settlement_month)
       VALUES ($1::uuid, $3::uuid, 2, 'REGULAR', DATE '2026-09-14', DATE '2026-09-20', DATE '2026-09-01'),
              ($2::uuid, $3::uuid, 3, 'REGULAR', DATE '2026-09-28', DATE '2026-10-04', DATE '2026-09-01')`,
      [tierWeekId, recommendationWeekId, ids.period]
    );
    const recommendation = await addReferral(pool, {
      referralId: recommendationReferralId,
      studentId: recommendationStudentId,
      referrerId: ids.teacher,
      receiverId: ids.teacherB,
      weekId: recommendationWeekId,
      teacherId: ids.teacherB,
      label: "recommendation",
      referrerIdentity: "TEACHING_TEACHER"
    });
    const tierEntry = await addReferral(pool, {
      referralId: tierReferralId,
      studentId: tierStudentId,
      referrerId: ids.planner,
      receiverId: ids.teacher,
      weekId: tierWeekId,
      teacherId: ids.teacher,
      label: "tier"
    });
    const recommendationDraft = {
      ...recommendation,
      venueId: ids.venue,
      settlementMonth: effectiveFrom,
      grossAmountCents: 10000n
    };
    await service.recordAndSettle(ids.teacherB, recommendationDraft, `settle:recommendation:${suffix}`);
    const tierDraft = {
      ...tierEntry,
      venueId: ids.venue,
      settlementMonth: effectiveFrom,
      grossAmountCents: 480000n
    };
    const tierCreated = await service.recordAndSettle(ids.teacher, tierDraft, `settle:tier:${suffix}`);
    const neutralPrimary = await latestSnapshot(pool, first.fee.id);
    const neutralTier = await latestSnapshot(pool, tierCreated.fee.id);
    assert.equal(neutralPrimary.context.monthlyNet.receivedCents, "610000");
    assert.equal(neutralPrimary.context.monthlyNet.referredCents, "10000");
    assert.equal(neutralPrimary.context.monthlyNet.netCents, "600000");
    assert.equal(neutralTier.context.monthlyNet.netCents, "600000");
    const primaryNeutralLines = Object.fromEntries(neutralPrimary.snapshot.lines.map((line) => [line.key, line.cents]));
    assert.equal(primaryNeutralLines.referrer, "10400");
    assert.equal(primaryNeutralLines.planningMentor, "2600");

    const tierCorrected = await service.recordAndSettle(
      ids.teacher,
      { ...tierDraft, grossAmountCents: 480100n },
      `settle:tier-corrected:${suffix}`
    );
    const shiftedPrimary = await latestSnapshot(pool, first.fee.id);
    const shiftedTier = await latestSnapshot(pool, tierCorrected.fee.id);
    assert.equal(shiftedPrimary.context.monthlyNet.netCents, "600100");
    assert.equal(shiftedTier.context.monthlyNet.netCents, "600100");
    const primaryShiftedLines = Object.fromEntries(shiftedPrimary.snapshot.lines.map((line) => [line.key, line.cents]));
    assert.equal(primaryShiftedLines.referrer, "10920");
    assert.equal(primaryShiftedLines.planningMentor, "2730");

    const zeroId = randomUUID();
    const zeroStudentId = randomUUID();
    const zeroWeekId = randomUUID();
    const zeroPeriodId = randomUUID();
    const zeroYearId = randomUUID();
    await pool.query(
      `INSERT INTO academic_year_plan (id, label, starts_on, ends_on, created_by)
       VALUES ($1::uuid, $2, DATE '2026-09-01', DATE '2027-08-31', $3::uuid)`,
      [zeroYearId, `零费用学年-${suffix}`, ids.admin]
    );
    await pool.query(
      `INSERT INTO academic_period (id, academic_year_plan_id, label, starts_on, ends_on)
       VALUES ($1::uuid, $2::uuid, '零费用学期', DATE '2026-09-01', DATE '2027-01-31')`,
      [zeroPeriodId, zeroYearId]
    );
    await pool.query(
      `INSERT INTO teaching_week (id, academic_period_id, sequence_no, week_kind, starts_on, ends_on, settlement_month)
       VALUES ($1::uuid, $2::uuid, 1, 'REGULAR', DATE '2026-10-05', DATE '2026-10-11', DATE '2026-10-01')`,
      [zeroWeekId, zeroPeriodId]
    );
    await addReferral(pool, { referralId: zeroId, studentId: zeroStudentId, referrerId: ids.planner, receiverId: ids.teacher, weekId: zeroWeekId, teacherId: ids.teacher, label: "zero" });
    const zero = await service.recordAndSettle(ids.teacher, { referralCaseId: zeroId, teachingWeekId: zeroWeekId, venueId: ids.venue, settlementMonth: "2026-10-01", grossAmountCents: 0n }, `settle:zero:${suffix}`);
    assert.equal(zero.status, "NO_BALANCE_CHANGE");
    assert.equal(zero.fee.grossAmountCents, 0n);
    const octoberBefore = await snapshotRows(pool, zero.fee.id);
    const sessions = new SessionService({
      accounts: [{ accountId: "http-teacher-b", personId: ids.teacherB, phoneNormalized: "13800000002", credentialDigest: "synthetic", status: "ACTIVE" }],
      assignments: [{ personId: ids.teacherB, subject: "TEACHING_TEACHER", scope: "SELF", validFrom: new Date(validFrom) }],
      sessionIdFactory: () => "http-test-session"
    });
    const personal = new PostgresPersonalReadService(pool);
    const server = createApiServer({ personal, sessions, weeklyFees: new PostgresWeeklyFeeService(pool), now: () => new Date("2026-09-28T00:00:00Z") });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    try {
      const url = `http://127.0.0.1:${server.address().port}`;
      const post = async (path, body) => {
        const response = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() };
      };
      assert.equal((await post("/v1/session", { phoneNormalized: "13800000002", credentialDigest: "synthetic" })).status, 200);
      assert.equal((await post("/v1/role-contexts/switch", { sessionId: "http-test-session", subject: "TEACHING_TEACHER" })).status, 200);
      const response = await post(`/v1/referrals/${recommendationReferralId}/weekly-fees`, {
        sessionId: "http-test-session", personId: ids.teacher, teachingWeekId: recommendationWeekId,
        venueId: ids.venue, settlementMonth: effectiveFrom, grossAmountCents: "20000", expectedVersion: 1,
        idempotencyKey: `http-recommendation:${suffix}`
      });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.data.fee.recordedByPersonId, ids.teacherB);
      assert.equal(response.body.data.fee.grossAmountCents, "20000");
      assert.deepEqual(Object.keys(response.body.data).sort(), ["fee", "replay", "runId", "status"]);
      const afterOutputChange = await latestSnapshot(pool, first.fee.id);
      assert.equal(afterOutputChange.context.monthlyNet.referredCents, "20000");
      assert.equal(afterOutputChange.context.monthlyNet.netCents, "590100");
      assert.equal(Object.fromEntries(afterOutputChange.snapshot.lines.map(line => [line.key, line.cents])).referrer, "10400");
      assert.deepEqual(await snapshotRows(pool, zero.fee.id), octoberBefore);
      const own = await fetch(`${url}/v1/me?personId=${ids.teacher}`, { headers: { authorization: "Bearer http-test-session" } });
      assert.equal(own.status, 200);
      const overview = (await own.json()).data;
      assert.equal(overview.personId, ids.teacherB);
      assert.equal(overview.balanceCents, "13400");
      assert.deepEqual(overview.currentYearIncomeByCategory, { teachingTeacher: "13400" });
      assert.deepEqual(Object.keys(overview).sort(), ["balanceCents", "currentYearIncomeByCategory", "nickname", "personId"]);
      const laterYear = await personal.getOwnOverview({ subject: "TEACHING_TEACHER", personId: ids.teacherB }, new Date("2027-09-01T00:00:00Z"));
      assert.equal(laterYear.balanceCents, 13400n);
      assert.deepEqual(laterYear.currentYearIncomeByCategory, {});
      const plannerOverview = await personal.getOwnOverview({ subject: "ACADEMIC_PLANNER", personId: ids.planner }, new Date("2026-09-28T00:00:00Z"));
      assert.deepEqual(Object.keys(plannerOverview.currentYearIncomeByCategory), ["referrer"]);
      await assert.rejects(personal.getOwnOverview({ subject: "REGION_FINANCE", personId: ids.teacherB }, new Date()), /FORBIDDEN_SCOPE/);
      await assert.rejects(personal.listAvailableVenues({ subject: "ACADEMIC_PLANNER", personId: ids.planner }), /FORBIDDEN_SCOPE/);
      await assert.rejects(personal.getOwnOverview({ subject: "TEACHING_TEACHER", personId: ids.admin }, new Date()), /PERSONAL_ACCOUNT_NOT_FOUND/);
      // Synthetic adjustment proves cumulative balance is distinct from lesson income.
      const bAccount = await pool.query("SELECT account_code FROM settlement_account WHERE owner_type = 'PERSON' AND owner_id = $1", [ids.teacherB]);
      await postLedgerEvent(new PostgresLedgerRepository(pool), { eventKey: `test-wage:${suffix}`, eventType: "SYNTHETIC_ADJUSTMENT", payloadHash: "synthetic", deltas: [{ accountKey: bAccount.rows[0].account_code, categoryKey: "cashWageDeduction", amountCents: -20000n }] }, randomUUID);
      const afterDeduction = await personal.getOwnOverview({ subject: "TEACHING_TEACHER", personId: ids.teacherB }, new Date("2026-09-28T00:00:00Z"));
      assert.equal(afterDeduction.balanceCents, -6600n);
      assert.deepEqual(afterDeduction.currentYearIncomeByCategory, { teachingTeacher: 13400n });
      const ownVenueId = randomUUID();
      await pool.query("INSERT INTO venue(id, owner_person_id, name, status) VALUES ($1, $2, 'Visible own venue', 'ACTIVE'), ($3, $2, 'Hidden venue', 'INACTIVE')", [ownVenueId, ids.teacherB, randomUUID()]);
      const directoryResponse = await fetch(`${url}/v1/venues/available`, { headers: { authorization: "Bearer http-test-session" } });
      assert.equal(directoryResponse.status, 200);
      const directory = (await directoryResponse.json()).data;
      assert.equal(directory.length, 2);
      assert.equal(directory.find(venue => venue.id === ids.venue).isOwn, false);
      assert.equal(directory.find(venue => venue.id === ownVenueId).isOwn, true);
      for (const venue of directory) assert.deepEqual(Object.keys(venue).sort(), ["id", "isOwn", "name"]);
      sessions.revokeAccount("http-teacher-b");
      assert.equal((await post(`/v1/referrals/${recommendationReferralId}/weekly-fees`, { sessionId: "http-test-session" })).status, 401);
    } finally {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }


    const legacyBefore = await resolveSettlementContext(pool, first.fee.id);
    await pool.query("INSERT INTO role_assignment(person_id,subject_code,scope_type,valid_from,created_by) VALUES ($1,'PLANNING_MENTOR','SELF','2026-01-01',$1)",[ids.planner]);
    const legacyAfter = await resolveSettlementContext(pool, first.fee.id);
    assert.equal(legacyBefore.contextJson.relationships.referrerIsPlanningMentor,false);
    assert.deepEqual(legacyAfter.contextJson.resolvedRates,legacyBefore.contextJson.resolvedRates);
    assert.equal(legacyAfter.contextJson.sourceProvenance,"LEGACY_IDENTITY_ONLY");
    // A newly created direct mentor referral keeps its source after the duty ends.
    await pool.query("INSERT INTO teacher_profile(person_id,business_identity,employment_status) VALUES ($1,'TEACHING_TEACHER','ACTIVE')", [ids.planningMentor]);
    await pool.query("INSERT INTO person_campus_assignment(person_id,campus_id,region_id,valid_from,created_by) VALUES ($1,$2,$3,'2026-01-01',$4)", [ids.planningMentor,ids.campus,ids.region,ids.admin]);
    const created = await new PostgresReferralCreationService(pool).create(
      {personId:ids.planningMentor,subject:"PLANNING_MENTOR"},
      {receiverPersonId:ids.teacher,studentDisplayName:"Direct mentor student",courseContextId:"direct",classType:"ONE_TO_ONE"},
      "direct-mentor-create",new Date("2026-09-01T04:00:00Z"));
    await pool.query("UPDATE role_assignment SET valid_to='2026-09-02' WHERE person_id=$1 AND subject_code='PLANNING_MENTOR'",[ids.planningMentor]);
    const directFee = await service.recordAndSettle(ids.teacher,{referralCaseId:created.referralId,teachingWeekId:ids.week,venueId:ids.venue,settlementMonth:effectiveFrom,grossAmountCents:100000n,expectedVersion:0},"direct-mentor-fee");
    const directSnapshot = await latestSnapshot(pool,directFee.fee.id);
    assert.equal(directSnapshot.context.relationships.referrerIsPlanningMentor,true);
    assert.equal(directSnapshot.context.resolvedRates.baseIntroRateBasisPoints,"1000");
    assert.equal(directSnapshot.context.resolvedRates.planningMentorWeightBasisPoints,"0");

  } finally {
    await database.close();
  }
});
