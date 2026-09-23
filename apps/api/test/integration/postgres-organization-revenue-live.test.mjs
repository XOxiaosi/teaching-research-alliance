import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { PostgresOrganizationRevenueReadService } from "../../dist/postgres-organization-revenue-read-service.js";
import { fixture } from "./refund-review-fixture.mjs";

const at = new Date("2026-09-23T08:30:00.000Z");
const json = (value) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
const lines = (management, regional, managementAccount) => ({
  lines: [
    ["referrer", 0n], ["planningMentor", 0n], ["groupLeader", 0n], ["teachingMentor", 0n], ["venue", 0n],
    ["campusConsultation", management], ["platformFinance", 0n], ["regionFinance", regional], ["teachingTeacher", 100000n - management - regional]
  ].map(([key, cents]) => ({ key, cents: cents.toString() })),
  accountByKey: management === 0n ? {} : { campusConsultation: managementAccount.accountCode }
});

const context = (fee, receiver, assignment, managementAccount) => ({
  businessAt: "2026-09-14T00:00:00+08:00",
  feeEntryId: fee.id,
  feeVersion: String(fee.version),
  receiverPersonId: receiver,
  organization: { receiverCampusAssignment: assignment },
  accounts: managementAccount === undefined ? {} : { campusConsultation: {
    ownerType: "COMPANY", ownerId: managementAccount.campusId,
    accountId: managementAccount.accountId, accountCode: managementAccount.accountCode
  } }
});

const insertSnapshot = async (pool, fee, actor, receiver, assignment, management, regional, managementAccount) => {
  const runId = randomUUID();
  const policy = await pool.query("SELECT id::text AS id FROM rate_policy_version ORDER BY version DESC LIMIT 1");
  await pool.query(
    `INSERT INTO settlement_calculation_run(id,request_key,fee_entry_id,fee_version,actor_person_id,status,ledger_event_id)
     VALUES($1::uuid,$2,$3::uuid,$4::bigint,$5::uuid,'NO_BALANCE_CHANGE',NULL)`,
    [runId, `organization-revenue:${runId}`, fee.id, fee.version, actor]
  );
  await pool.query(
    `INSERT INTO weekly_fee_allocation_snapshot(run_id,weekly_fee_entry_id,source_weekly_fee_version,policy_version_id,net_monthly_cents,snapshot_json,context_json)
     VALUES($1::uuid,$2::uuid,$3::bigint,$4::uuid,100000,$5::jsonb,$6::jsonb)`,
    [runId, fee.id, fee.version, policy.rows[0].id, json(lines(management, regional, managementAccount)), json(context(fee, receiver, assignment, management === 0n ? undefined : managementAccount))]
  );
};

const seedOrganization = async (seeded) => {
  const { pool, ids } = seeded;
  const regionA = randomUUID(), regionB = randomUUID(), campusA = randomUUID(), campusB = randomUUID(), campusZero = randomUUID();
  const assignmentA = randomUUID(), assignmentALater = randomUUID(), assignmentB = randomUUID(), assignmentZero = randomUUID();
  const personA = randomUUID(), personB = randomUUID(), personC = randomUUID();
  // Deliberately make the current parent contradict the history. Revenue must use
  // campus_region_assignment at business time, never organization_unit.parent_id.
  await pool.query(
    `INSERT INTO organization_unit(id,unit_type,name,parent_id) VALUES
      ($1::uuid,'REGION','华北分区',NULL),($2::uuid,'REGION','华东分区',NULL),
      ($3::uuid,'CAMPUS','北校区',$2::uuid),($4::uuid,'CAMPUS','东校区',$2::uuid),($5::uuid,'CAMPUS','零收入校区',$2::uuid)`,
    [regionA, regionB, campusA, campusB, campusZero]
  );
  await pool.query(
    `INSERT INTO campus_region_assignment(id,campus_id,region_id,valid_from,valid_to,created_by) VALUES
      ($1::uuid,$2::uuid,$3::uuid,'2026-01-01T00:00:00Z','2026-09-15T00:00:00Z',$8::uuid),
      ($4::uuid,$2::uuid,$6::uuid,'2026-09-15T00:00:00Z',NULL,$8::uuid),
      ($5::uuid,$7::uuid,$6::uuid,'2026-01-01T00:00:00Z',NULL,$8::uuid),
      ($9::uuid,$10::uuid,$3::uuid,'2026-01-01T00:00:00Z',NULL,$8::uuid)`,
    [assignmentA, campusA, regionA, assignmentALater, assignmentB, regionB, campusB, ids.admin, assignmentZero, campusZero]
  );
  await pool.query(
    `INSERT INTO person_campus_assignment(id,person_id,campus_id,region_id,valid_from,created_by) VALUES
      ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'2026-01-01T00:00:00Z',$5::uuid),
      ($6::uuid,$7::uuid,$8::uuid,$9::uuid,'2026-01-01T00:00:00Z',$5::uuid),
      ($10::uuid,$11::uuid,$8::uuid,$9::uuid,'2026-01-01T00:00:00Z',$5::uuid)`,
    [personA, ids.teacherA, campusA, regionA, ids.admin, personB, ids.teacherB, campusB, regionB, personC, ids.teacherC]
  );
  const managementAccount = { campusId: campusB, accountId: randomUUID(), accountCode: `company:management:${campusB}` };
  await pool.query("INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,'COMPANY',$2::uuid,$3,'ACTIVE')", [managementAccount.accountId, managementAccount.campusId, managementAccount.accountCode]);
  return { regionA, regionB, campusA, campusB, campusZero, assignmentA, assignmentB, managementAccount };
};

test("真实 PostgreSQL 校区与分区营收按历史归属、最新快照和退款净额读取", async () => {
  const seeded = await fixture();
  try {
    const org = await seedOrganization(seeded);
    // The older synthetic snapshot is intentionally superseded; only the newest
    // matching current fee version is reportable.
    await insertSnapshot(seeded.pool, seeded.activeA.fee, seeded.ids.admin, seeded.ids.teacherA,
      { id: org.assignmentA, campus_id: org.campusA, region_id: org.regionA }, 999n, 999n, org.managementAccount);
    await insertSnapshot(seeded.pool, seeded.activeA.fee, seeded.ids.admin, seeded.ids.teacherA,
      { id: org.assignmentA, campus_id: org.campusA, region_id: org.regionA }, 2000n, 1000n, org.managementAccount);
    await insertSnapshot(seeded.pool, seeded.activeB.fee, seeded.ids.admin, seeded.ids.teacherB,
      { id: org.assignmentB, campus_id: org.campusB, region_id: org.regionB }, 3000n, 2000n, org.managementAccount);
    const pending = await seeded.pending();
    await seeded.approve(pending);

    const service = new PostgresOrganizationRevenueReadService(seeded.pool);
    const all = await service.get({ subject: "SYSTEM_OWNER", personId: seeded.ids.admin, scope: "GLOBAL" }, { fromMonth: "2026-09-01", toMonth: "2026-09-01" }, at);
    assert.deepEqual(all.scope, { scope: "GLOBAL" });
    assert.deepEqual(all.period, { fromMonth: "2026-09-01", toMonth: "2026-09-01", asOf: at.toISOString(), mode: "LATEST_EFFECTIVE_SNAPSHOT" });
    const campusRows = new Map(all.campuses.map((row) => [`${row.campusId}:${row.attributedRegionId}`, [row.recordedGrossRevenueCents, row.refundedGrossRevenueCents, row.effectiveGrossRevenueCents, row.campusManagementFeeCents]]));
    assert.deepEqual(campusRows, new Map([
      [`${org.campusA}:${org.regionA}`, [200000n, 100000n, 100000n, 0n]],
      [`${org.campusA}:${org.regionB}`, [0n, 0n, 0n, 0n]],
      [`${org.campusB}:${org.regionB}`, [100000n, 0n, 100000n, 5000n]],
      [`${org.campusZero}:${org.regionA}`, [0n, 0n, 0n, 0n]]
    ]));
    assert.deepEqual(all.regions.map((row) => [row.regionId, row.recordedGrossRevenueCents, row.refundedGrossRevenueCents, row.effectiveGrossRevenueCents, row.campusManagementFeeCents, row.regionFinanceIncomeCents]), [
      [org.regionB, 100000n, 0n, 100000n, 5000n, 2000n],
      [org.regionA, 200000n, 100000n, 100000n, 0n, 1000n]
    ]);
    assert.deepEqual(all.total, {
      recordedGrossRevenueCents: 300000n,
      refundedGrossRevenueCents: 100000n,
      effectiveGrossRevenueCents: 200000n,
      campusManagementFeeCents: 5000n,
      regionFinanceIncomeCents: 3000n
    });
    assert.equal(Object.keys(all.campuses[0]).some((key) => /account|balance|rate|allocation/i.test(key)), false);

    const regional = await service.get({ subject: "REGION_FINANCE", personId: seeded.ids.hq, scope: "REGION", regionId: org.regionA }, { fromMonth: "2026-09-01", toMonth: "2026-09-01" }, at);
    assert.equal(regional.campuses.length, 2);
    assert.equal(regional.campuses.every((row) => row.attributedRegionId === org.regionA), true);
    assert.deepEqual(regional.total, {
      recordedGrossRevenueCents: 200000n,
      refundedGrossRevenueCents: 100000n,
      effectiveGrossRevenueCents: 100000n,
      campusManagementFeeCents: 0n,
      regionFinanceIncomeCents: 1000n
    });
    const campus = await service.get({ subject: "CAMPUS_PRINCIPAL", personId: seeded.ids.teacherB, scope: "CAMPUS", campusId: org.campusB }, { fromMonth: "2026-09-01", toMonth: "2026-09-01" }, at);
    assert.equal(campus.campuses.length, 1);
    assert.equal(campus.campuses[0].campusId, org.campusB);
    assert.deepEqual(campus.regions, []);
    assert.deepEqual(campus.total, {
      recordedGrossRevenueCents: 100000n,
      refundedGrossRevenueCents: 0n,
      effectiveGrossRevenueCents: 100000n,
      campusManagementFeeCents: 5000n
    });
    assert.equal("regionFinanceIncomeCents" in campus.total, false);
    for (const subject of ["SYSTEM_ADMIN", "HEADQUARTERS_FINANCE"]) {
      const result = await service.get({ subject, personId: seeded.ids.hq, scope: "GLOBAL" }, { fromMonth: "2026-09-01", toMonth: "2026-09-01" }, at);
      assert.equal(result.total.effectiveGrossRevenueCents, 200000n);
    }
    await assert.rejects(service.get({ subject: "REGION_FINANCE", personId: seeded.ids.hq, scope: "REGION", regionId: org.regionA, campusId: org.campusA }, { fromMonth: "2026-09-01", toMonth: "2026-09-01" }, at), /FORBIDDEN_SCOPE/);
    await assert.rejects(service.get({ subject: "CAMPUS_PRINCIPAL", personId: seeded.ids.teacherB, scope: "CAMPUS", campusId: org.campusB, regionId: org.regionB }, { fromMonth: "2026-09-01", toMonth: "2026-09-01" }, at), /FORBIDDEN_SCOPE/);
    await assert.rejects(service.get({ subject: "TEACHING_TEACHER", personId: seeded.ids.teacherA, scope: "SELF" }, { fromMonth: "2026-09-01", toMonth: "2026-09-01" }, at), /FORBIDDEN_SCOPE/);
    await assert.rejects(service.get({ subject: "SYSTEM_OWNER", personId: seeded.ids.admin, scope: "GLOBAL" }, { fromMonth: "2026-09-02", toMonth: "2026-09-01" }, at), /INVALID_INPUT/);

    // A refund of the cross-campus planning fee reduces F at the receiver campus
    // and consultation income at the frozen company-account campus independently.
    const crossCampusRefund = await seeded.pending([seeded.activeA.fee.id]);
    const latest = await seeded.pool.query(
      `SELECT snapshot.id::text AS snapshot_id, snapshot.snapshot_json, fee.version::text AS fee_version, fee.gross_amount_cents::text AS gross
         FROM weekly_fee_allocation_snapshot snapshot JOIN weekly_fee_entry fee ON fee.id=snapshot.weekly_fee_entry_id
        WHERE snapshot.weekly_fee_entry_id=$1::uuid ORDER BY snapshot.sequence_no DESC LIMIT 1`, [seeded.activeA.fee.id]
    );
    // This synthetic report fixture intentionally has only the fields consumed by
    // the reader. Insert the immutable approved effect directly to verify the read
    // side's independent gross and company-campus reversal behaviour.
    await seeded.pool.query("ALTER TABLE weekly_fee_refund_effect DISABLE TRIGGER USER");
    await seeded.pool.query(
      `INSERT INTO weekly_fee_refund_effect(weekly_fee_entry_id,finance_document_id,allocation_snapshot_id,source_weekly_fee_version,gross_amount_cents,snapshot_json,created_at)
       VALUES($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::bigint,$6::jsonb,$7::timestamptz)`,
      [seeded.activeA.fee.id, crossCampusRefund.id, latest.rows[0].snapshot_id, latest.rows[0].fee_version, latest.rows[0].gross, json(latest.rows[0].snapshot_json), at.toISOString()]
    );
    const afterCrossCampusRefund = await service.get({ subject: "SYSTEM_OWNER", personId: seeded.ids.admin, scope: "GLOBAL" }, { fromMonth: "2026-09-01", toMonth: "2026-09-01" }, at);
    const refundedRows = new Map(afterCrossCampusRefund.campuses.map((row) => [`${row.campusId}:${row.attributedRegionId}`, row]));
    assert.deepEqual(refundedRows.get(`${org.campusA}:${org.regionA}`), {
      campusId: org.campusA, campusName: "北校区", attributedRegionId: org.regionA, attributedRegionName: "华北分区",
      recordedGrossRevenueCents: 200000n, refundedGrossRevenueCents: 200000n, effectiveGrossRevenueCents: 0n, campusManagementFeeCents: 0n
    });
    assert.equal(refundedRows.get(`${org.campusB}:${org.regionB}`)?.campusManagementFeeCents, 3000n);
  } finally {
    await seeded.close();
  }
});

test("真实 PostgreSQL 组织营收拒绝缺快照、缺历史归属与退款版本不一致", async () => {
  const seeded = await fixture();
  try {
    await seedOrganization(seeded);
    const service = new PostgresOrganizationRevenueReadService(seeded.pool);
    const owner = { subject: "SYSTEM_OWNER", personId: seeded.ids.admin, scope: "GLOBAL" };
    const period = { fromMonth: "2026-09-01", toMonth: "2026-09-01" };
    // Fixture snapshots predate the organization attribution extension. A valid
    // fallback assignment exists for A/B; removing it proves no current parent is used.
    // All fixture allocations have an explicit zero campus-management line. The
    // referrer may therefore have no campus history without invalidating F reads.
    await seeded.pool.query("ALTER TABLE person_campus_assignment DISABLE TRIGGER USER");
    await seeded.pool.query("DELETE FROM person_campus_assignment WHERE person_id=$1::uuid", [seeded.ids.teacherC]);
    assert.equal((await service.get(owner, period, at)).total.effectiveGrossRevenueCents, 300000n);
    await seeded.pool.query("DELETE FROM person_campus_assignment WHERE person_id=$1::uuid", [seeded.ids.teacherA]);
    await assert.rejects(service.get(owner, period, at), /ORGANIZATION_REVENUE_DATA_UNAVAILABLE/);
    await seeded.pool.query("ALTER TABLE person_campus_assignment ENABLE TRIGGER USER");
  } finally {
    await seeded.close();
  }

  const missingSnapshot = await fixture();
  try {
    const org = await seedOrganization(missingSnapshot);
    await missingSnapshot.pool.query("ALTER TABLE weekly_fee_allocation_snapshot DISABLE TRIGGER USER");
    await missingSnapshot.pool.query("DELETE FROM weekly_fee_allocation_snapshot WHERE weekly_fee_entry_id=$1::uuid", [missingSnapshot.activeB.fee.id]);
    const unaffected = await new PostgresOrganizationRevenueReadService(missingSnapshot.pool).get({ subject: "REGION_FINANCE", personId: missingSnapshot.ids.hq, scope: "REGION", regionId: org.regionA }, { fromMonth: "2026-09-01", toMonth: "2026-09-01" }, at);
    assert.equal(unaffected.total.effectiveGrossRevenueCents, 200000n);
    await assert.rejects(new PostgresOrganizationRevenueReadService(missingSnapshot.pool).get({ subject: "SYSTEM_OWNER", personId: missingSnapshot.ids.admin, scope: "GLOBAL" }, { fromMonth: "2026-09-01", toMonth: "2026-09-01" }, at), /ORGANIZATION_REVENUE_DATA_UNAVAILABLE/);
    await missingSnapshot.pool.query("DELETE FROM weekly_fee_allocation_snapshot WHERE weekly_fee_entry_id=$1::uuid", [missingSnapshot.activeA.fee.id]);
    await assert.rejects(new PostgresOrganizationRevenueReadService(missingSnapshot.pool).get({ subject: "SYSTEM_OWNER", personId: missingSnapshot.ids.admin, scope: "GLOBAL" }, { fromMonth: "2026-09-01", toMonth: "2026-09-01" }, at), /ORGANIZATION_REVENUE_DATA_UNAVAILABLE/);
  } finally {
    await missingSnapshot.close();
  }

  const refundMismatch = await fixture();
  try {
    const org = await seedOrganization(refundMismatch);
    const unrelatedRegion = randomUUID();
    await refundMismatch.pool.query("INSERT INTO organization_unit(id,unit_type,name) VALUES($1::uuid,'REGION','无关分区')", [unrelatedRegion]);
    const pending = await refundMismatch.pending();
    await refundMismatch.approve(pending);
    await refundMismatch.pool.query("ALTER TABLE weekly_fee_refund_effect DISABLE TRIGGER USER");
    await refundMismatch.pool.query("UPDATE weekly_fee_refund_effect SET source_weekly_fee_version=source_weekly_fee_version+1 WHERE weekly_fee_entry_id=$1::uuid", [refundMismatch.refundFee.fee.id]);
    const unrelated = await new PostgresOrganizationRevenueReadService(refundMismatch.pool).get({ subject: "REGION_FINANCE", personId: refundMismatch.ids.hq, scope: "REGION", regionId: unrelatedRegion }, { fromMonth: "2026-09-01", toMonth: "2026-09-01" }, at);
    assert.deepEqual(unrelated.total, { recordedGrossRevenueCents: 0n, refundedGrossRevenueCents: 0n, effectiveGrossRevenueCents: 0n, campusManagementFeeCents: 0n, regionFinanceIncomeCents: 0n });
    await assert.rejects(new PostgresOrganizationRevenueReadService(refundMismatch.pool).get({ subject: "REGION_FINANCE", personId: refundMismatch.ids.hq, scope: "REGION", regionId: org.regionA }, { fromMonth: "2026-09-01", toMonth: "2026-09-01" }, at), /ORGANIZATION_REVENUE_DATA_UNAVAILABLE/);
    await assert.rejects(new PostgresOrganizationRevenueReadService(refundMismatch.pool).get({ subject: "SYSTEM_OWNER", personId: refundMismatch.ids.admin, scope: "GLOBAL" }, { fromMonth: "2026-09-01", toMonth: "2026-09-01" }, at), /ORGANIZATION_REVENUE_DATA_UNAVAILABLE/);
  } finally {
    await refundMismatch.close();
  }
});

test("真实规划师结算快照冻结公司校区账户，读取把F与2%管理费归入不同校区", async () => {
  const seeded = await fixture();
  try {
    const org = await seedOrganization(seeded);
    await seeded.pool.query("INSERT INTO teacher_profile(person_id,business_identity,employment_status) VALUES($1::uuid,'ACADEMIC_PLANNER','ACTIVE')", [seeded.ids.teacherC]);
    const plannerPolicy = {
      plannerBaseRateBasisPoints: 0n, teacherBaseRateBasisPoints: 0n, planningMentorWeightBasisPoints: 0n,
      groupLeaderRateBasisPoints: 0n, teachingMentorRateBasisPoints: 0n, venueRateBasisPoints: 0n,
      campusConsultationForPlannerRateBasisPoints: 200n, campusConsultationForTeacherRateBasisPoints: 0n,
      platformFinanceRateBasisPoints: 0n, regionFinanceRateBasisPoints: 0n,
      dynamicTiers: [{ label: "all", adjustmentBasisPoints: 0n }]
    };
    await seeded.pool.query("INSERT INTO rate_policy_version(version,effective_from,policy_json,reason,published_by) VALUES(2,'2026-09-01',$1::jsonb,'规划师校区管理费',$2::uuid)", [json(plannerPolicy), seeded.ids.admin]);
    const studentId = randomUUID(), referralId = randomUUID();
    await seeded.pool.query("INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name) VALUES($1::uuid,$2::uuid,'planning-campus','跨校区规划学生')", [studentId, seeded.ids.teacherA]);
    await seeded.pool.query(
      `INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,version)
       VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'ACADEMIC_PLANNER','ACCEPTED',$5::timestamptz,1)`,
      [referralId, studentId, seeded.ids.teacherC, seeded.ids.teacherA, at.toISOString()]
    );
    const actual = await seeded.weekly.recordAndSettle(seeded.ids.teacherA, {
      referralCaseId: referralId, teachingWeekId: seeded.ids.weekA, venueId: seeded.ids.venueA,
      settlementMonth: "2026-09-01", grossAmountCents: 100000n, expectedVersion: 0
    }, "real-planner-campus-management");
    const raw = await seeded.pool.query(
      `SELECT snapshot.snapshot_json, snapshot.context_json FROM weekly_fee_allocation_snapshot snapshot
        WHERE snapshot.weekly_fee_entry_id=$1::uuid ORDER BY snapshot.sequence_no DESC LIMIT 1`, [actual.fee.id]
    );
    assert.equal(raw.rows[0].snapshot_json.lines.find((line) => line.key === "campusConsultation").cents, "2000");
    assert.deepEqual(raw.rows[0].context_json.accounts.campusConsultation, {
      ownerType: "COMPANY", ownerId: org.campusB, accountId: org.managementAccount.accountId, accountCode: org.managementAccount.accountCode
    });
    assert.equal(raw.rows[0].snapshot_json.accountByKey.campusConsultation, org.managementAccount.accountCode);
    const result = await new PostgresOrganizationRevenueReadService(seeded.pool).get(
      { subject: "SYSTEM_OWNER", personId: seeded.ids.admin, scope: "GLOBAL" }, { fromMonth: "2026-09-01", toMonth: "2026-09-01" }, at
    );
    const rows = new Map(result.campuses.map((row) => [`${row.campusId}:${row.attributedRegionId}`, row]));
    assert.equal(rows.get(`${org.campusA}:${org.regionA}`)?.effectiveGrossRevenueCents, 300000n);
    assert.equal(rows.get(`${org.campusA}:${org.regionA}`)?.campusManagementFeeCents, 0n);
    assert.equal(rows.get(`${org.campusB}:${org.regionB}`)?.campusManagementFeeCents, 2000n);
    await seeded.pool.query("UPDATE settlement_account SET status='INACTIVE' WHERE id=$1::uuid", [org.managementAccount.accountId]);
    const inactiveAccount = await new PostgresOrganizationRevenueReadService(seeded.pool).get(
      { subject: "SYSTEM_OWNER", personId: seeded.ids.admin, scope: "GLOBAL" }, { fromMonth: "2026-09-01", toMonth: "2026-09-01" }, at
    );
    assert.equal(inactiveAccount.campuses.find((row) => row.campusId === org.campusB)?.campusManagementFeeCents, 2000n);

    const bjtFutureCampus = randomUUID(), bjtAssignment = randomUUID();
    await seeded.pool.query("INSERT INTO organization_unit(id,unit_type,name,parent_id) VALUES($1::uuid,'CAMPUS','十月校区',$2::uuid)", [bjtFutureCampus, org.regionA]);
    await seeded.pool.query("INSERT INTO campus_region_assignment(id,campus_id,region_id,valid_from,created_by) VALUES($1::uuid,$2::uuid,$3::uuid,'2026-09-30T20:00:00Z',$4::uuid)", [bjtAssignment, bjtFutureCampus, org.regionA, seeded.ids.admin]);
    const september = await new PostgresOrganizationRevenueReadService(seeded.pool).get(
      { subject: "SYSTEM_OWNER", personId: seeded.ids.admin, scope: "GLOBAL" }, { fromMonth: "2026-09-01", toMonth: "2026-09-01" }, at
    );
    assert.equal(september.campuses.some((row) => row.campusId === bjtFutureCampus), false);
  } finally {
    await seeded.close();
  }
});


test("外区损坏的快照上下文不阻断本区，相关范围仍拒绝不可信数据", async () => {
  const f = await fixture();
  try {
    const org = await seedOrganization(f);
    const service = new PostgresOrganizationRevenueReadService(f.pool);
    const range = { fromMonth: "2026-09-01", toMonth: "2026-09-01" };
    const role = regionId => ({personId: f.ids.hq, subject: "REGION_FINANCE", scope: "REGION", regionId});
    const original = (await f.pool.query("SELECT sequence_no,context_json FROM weekly_fee_allocation_snapshot WHERE weekly_fee_entry_id=$1::uuid ORDER BY sequence_no DESC LIMIT 1", [f.activeB.fee.id])).rows[0];
    await f.pool.query("ALTER TABLE weekly_fee_allocation_snapshot DISABLE TRIGGER USER");
    for (const bad of [
      { ...original.context_json, businessAt: "not-a-time" },
      { ...original.context_json, organization: "broken" },
      { ...original.context_json, organization: {receiverCampusAssignment:{campus_id:"bad"}} },
      { ...original.context_json, organization: {receiverCampusAssignment:{id:randomUUID(),campus_id:org.campusB,region_id:randomUUID()}} }
    ]) {
      await f.pool.query("UPDATE weekly_fee_allocation_snapshot SET context_json=$2::jsonb WHERE sequence_no=$1", [original.sequence_no, JSON.stringify(bad)]);
      assert.equal((await service.get(role(org.regionA), range, at)).total.effectiveGrossRevenueCents, 200000n);
      await assert.rejects(service.get(role(org.regionB), range, at), /ORGANIZATION_REVENUE_DATA_UNAVAILABLE/);
      await assert.rejects(service.get({personId:f.ids.admin,subject:"SYSTEM_OWNER",scope:"GLOBAL"},range,at), /ORGANIZATION_REVENUE_DATA_UNAVAILABLE/);
    }
  } finally { await f.close(); }
});
