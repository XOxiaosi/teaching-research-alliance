import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LocalAttachmentStore } from "../../dist/local-attachment-store.js";
import { PostgresFinanceDraftService } from "../../dist/postgres-finance-draft-service.js";
import { PostgresPersonalReadService } from "../../dist/postgres-personal-read-service.js";
import { PostgresRefundReviewService } from "../../dist/postgres-refund-review-service.js";
import { PostgresRefundSubmissionService } from "../../dist/postgres-refund-submission-service.js";
import { PostgresTeachingReadService } from "../../dist/postgres-teaching-read-service.js";
import { PostgresWeeklySettlementService } from "../../dist/postgres-weekly-settlement-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const at = new Date("2026-09-21T09:00:00.000Z");
const effectiveFrom = "2026-09-01";
const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 73) });
const digest = createHash("sha256").update(png).digest("hex");
const chunks = async function* () { yield png; };
const json = (value) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);

const policy = {
  plannerBaseRateBasisPoints: 1000n,
  teacherBaseRateBasisPoints: 1200n,
  planningMentorWeightBasisPoints: 0n,
  groupLeaderRateBasisPoints: 0n,
  teachingMentorRateBasisPoints: 0n,
  venueRateBasisPoints: 0n,
  campusConsultationForPlannerRateBasisPoints: 0n,
  campusConsultationForTeacherRateBasisPoints: 0n,
  platformFinanceRateBasisPoints: 0n,
  regionFinanceRateBasisPoints: 0n,
  dynamicTiers: [
    { label: "low", maxInclusive: 50000n, adjustmentBasisPoints: 0n },
    { label: "middle", minExclusive: 50000n, maxInclusive: 150000n, adjustmentBasisPoints: 100n },
    { label: "high", minExclusive: 150000n, adjustmentBasisPoints: 200n }
  ]
};

const addReadyAttachment = async (pool, store, documentId, personId, purpose) => {
  const attachmentId = randomUUID();
  const versionId = randomUUID();
  await store.put({
    versionId,
    originalFilename: `${purpose}.png`,
    declaredMediaType: "image/png",
    declaredSizeBytes: png.length,
    expectedSha256: digest
  }, chunks());
  await pool.query(
    `INSERT INTO finance_attachment(id,finance_document_id,purpose,created_by_person_id,created_at)
     VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5::timestamptz)`,
    [attachmentId, documentId, purpose, personId, at.toISOString()]
  );
  await pool.query(
    `INSERT INTO finance_attachment_version(
       id,finance_attachment_id,version_no,status,original_filename,declared_media_type,
       declared_size_bytes,expected_sha256,detected_media_type,actual_size_bytes,sha256,
       uploaded_by_person_id,created_at,ready_at
     ) VALUES($1::uuid,$2::uuid,1,'READY',$3,'image/png',$4::bigint,$5,'image/png',$4::bigint,$5,$6::uuid,$7::timestamptz,$7::timestamptz)`,
    [versionId, attachmentId, `${purpose}.png`, png.length, digest, personId, at.toISOString()]
  );
  return versionId;
};

const accountBalance = async (pool, personId) => BigInt((await pool.query(
  `SELECT COALESCE(projection.balance_cents,0)::text AS balance
     FROM settlement_account account
     LEFT JOIN account_balance_projection projection ON projection.account_id=account.id
    WHERE account.owner_type='PERSON' AND account.owner_id=$1::uuid`,
  [personId]
)).rows[0].balance);

const snapshotState = async (pool, feeId) => {
  const result = await pool.query(
    `SELECT snapshot.id::text AS id,snapshot.sequence_no::text AS sequence_no,
            snapshot.snapshot_json,snapshot.context_json
       FROM weekly_fee_allocation_snapshot snapshot
      WHERE snapshot.weekly_fee_entry_id=$1::uuid
      ORDER BY snapshot.sequence_no`,
    [feeId]
  );
  return result.rows;
};

test("退款当次只冲回选中周费，下一次正常月重算排除退款并覆盖收课与转介绍两侧", async () => {
  const database = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-refund-settlement-"));
  try {
    const ids = Object.fromEntries([
      "admin", "hq", "teacherA", "teacherB", "teacherC", "year", "period",
      "weekRefund", "weekA", "weekB", "venueA", "venueB", "venueC",
      "studentRefund", "studentA", "studentB", "referralRefund", "referralA", "referralB"
    ].map((key) => [key, randomUUID()]));
    for (const key of ["admin", "hq", "teacherA", "teacherB", "teacherC"]) {
      await database.pool.query(
        "INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,$2,'ACTIVE')",
        [ids[key], `退款结算-${key}-${ids[key]}`]
      );
    }
    for (const key of ["teacherA", "teacherB", "teacherC"]) {
      await database.pool.query(
        "INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('PERSON',$1::uuid,$2,'ACTIVE')",
        [ids[key], `person:${key}:${ids[key]}`]
      );
      await database.pool.query(
        `INSERT INTO role_assignment(person_id,subject_code,scope_type,scope_id,valid_from,created_by)
         VALUES($1::uuid,'TEACHING_TEACHER','SELF',$1::uuid,'2026-01-01T00:00:00Z',$2::uuid)`,
        [ids[key], ids.admin]
      );
    }
    await database.pool.query(
      `INSERT INTO role_assignment(person_id,subject_code,scope_type,scope_id,valid_from,created_by)
       VALUES($1::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'2026-01-01T00:00:00Z',$2::uuid)`,
      [ids.hq, ids.admin]
    );
    await database.pool.query(
      `INSERT INTO venue(id,owner_person_id,name,status,default_for_owner) VALUES
       ($1::uuid,$4::uuid,'A场地','ACTIVE',true),
       ($2::uuid,$5::uuid,'B场地','ACTIVE',true),
       ($3::uuid,$6::uuid,'C场地','ACTIVE',true)`,
      [ids.venueA, ids.venueB, ids.venueC, ids.teacherA, ids.teacherB, ids.teacherC]
    );
    await database.pool.query(
      `INSERT INTO academic_year_plan(id,label,starts_on,ends_on,created_by)
       VALUES($1::uuid,'退款结算学年','2026-09-01','2027-08-31',$2::uuid)`,
      [ids.year, ids.admin]
    );
    await database.pool.query(
      `INSERT INTO academic_period(id,academic_year_plan_id,label,starts_on,ends_on)
       VALUES($1::uuid,$2::uuid,'秋季','2026-09-01','2027-01-31')`,
      [ids.period, ids.year]
    );
    await database.pool.query(
      `INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month,status) VALUES
       ($1::uuid,$4::uuid,1,'REGULAR','2026-09-07','2026-09-13',$5::date,'OPEN'),
       ($2::uuid,$4::uuid,2,'REGULAR','2026-09-14','2026-09-20',$5::date,'OPEN'),
       ($3::uuid,$4::uuid,3,'REGULAR','2026-09-21','2026-09-27',$5::date,'OPEN')`,
      [ids.weekRefund, ids.weekA, ids.weekB, ids.period, effectiveFrom]
    );
    const referrals = [
      [ids.studentRefund, ids.teacherA, "退款学生", ids.referralRefund, ids.teacherB, ids.teacherA],
      [ids.studentA, ids.teacherA, "A学生", ids.referralA, ids.teacherC, ids.teacherA],
      [ids.studentB, ids.teacherB, "B学生", ids.referralB, ids.teacherC, ids.teacherB]
    ];
    for (const [studentId, ownerId, displayName, referralId, referrerId, receiverId] of referrals) {
      await database.pool.query(
        `INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name)
         VALUES($1::uuid,$2::uuid,$3,$4)`,
        [studentId, ownerId, `course:${studentId}`, displayName]
      );
      await database.pool.query(
        `INSERT INTO referral_case(
           id,teacher_student_record_id,referrer_person_id,receiver_person_id,
           referrer_identity,status,submitted_at,version
         ) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'TEACHING_TEACHER','ACCEPTED',$5::timestamptz,2)`,
        [referralId, studentId, referrerId, receiverId, at.toISOString()]
      );
    }
    await database.pool.query(
      `INSERT INTO rate_policy_version(version,effective_from,policy_json,reason,published_by)
       VALUES(1,$1::date,$2::jsonb,'退款结算测试',$3::uuid)`,
      [effectiveFrom, json(policy), ids.admin]
    );

    const weekly = new PostgresWeeklySettlementService(database.pool);
    const refundFee = await weekly.recordAndSettle(ids.teacherA, {
      referralCaseId: ids.referralRefund, teachingWeekId: ids.weekRefund, venueId: ids.venueA,
      settlementMonth: effectiveFrom, grossAmountCents: 100000n, expectedVersion: 0
    }, "refund-settlement:fee-refund");
    const activeA = await weekly.recordAndSettle(ids.teacherA, {
      referralCaseId: ids.referralA, teachingWeekId: ids.weekA, venueId: ids.venueA,
      settlementMonth: effectiveFrom, grossAmountCents: 100000n, expectedVersion: 0
    }, "refund-settlement:fee-a");
    const activeB = await weekly.recordAndSettle(ids.teacherB, {
      referralCaseId: ids.referralB, teachingWeekId: ids.weekB, venueId: ids.venueB,
      settlementMonth: effectiveFrom, grossAmountCents: 100000n, expectedVersion: 0
    }, "refund-settlement:fee-b");
    assert.deepEqual(await Promise.all([ids.teacherA, ids.teacherB, ids.teacherC].map(id => accountBalance(database.pool, id))), [172000n, 102000n, 26000n]);
    const beforeRefund = {
      refunded: await snapshotState(database.pool, refundFee.fee.id),
      activeA: await snapshotState(database.pool, activeA.fee.id),
      activeB: await snapshotState(database.pool, activeB.fee.id)
    };

    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const teacherContext = { subject: "TEACHING_TEACHER", personId: ids.teacherA, scope: "SELF" };
    const document = await new PostgresFinanceDraftService(database.pool).create(
      teacherContext, { kind: "REFUND" }, "refund-settlement:document", at
    );
    const evidence = await Promise.all([
      addReadyAttachment(database.pool, store, document.id, ids.teacherA, "SUPPORTING_DOCUMENT"),
      addReadyAttachment(database.pool, store, document.id, ids.teacherA, "APPLICATION_SCREENSHOT")
    ]);
    const submitted = await new PostgresRefundSubmissionService(database.pool, store).submit(
      teacherContext,
      document.id,
      { expectedVersion: 1, reason: "家长线下退款", weeklyFeeEntryIds: [refundFee.fee.id], attachmentVersionIds: evidence },
      "refund-settlement:submit",
      at
    );
    assert.equal(submitted.status, "PENDING_APPROVAL");
    const review = new PostgresRefundReviewService(database.pool, store);
    const approved = await review.approve(
      { subject: "HEADQUARTERS_FINANCE", personId: ids.hq, scope: "GLOBAL" },
      document.id,
      { expectedVersion: 2, reason: "凭证核对通过" },
      "refund-settlement:approve",
      at
    );
    assert.equal(approved.status, "REFUNDED");
    assert.deepEqual(await Promise.all([ids.teacherA, ids.teacherB, ids.teacherC].map(id => accountBalance(database.pool, id))), [86000n, 88000n, 26000n]);
    assert.deepEqual(await snapshotState(database.pool, refundFee.fee.id), beforeRefund.refunded);
    assert.deepEqual(await snapshotState(database.pool, activeA.fee.id), beforeRefund.activeA);
    assert.deepEqual(await snapshotState(database.pool, activeB.fee.id), beforeRefund.activeB);

    const effect = (await database.pool.query(
      `SELECT allocation_snapshot_id::text AS snapshot_id,source_weekly_fee_version::text AS fee_version,
              gross_amount_cents::text AS gross
         FROM weekly_fee_refund_effect WHERE weekly_fee_entry_id=$1::uuid`,
      [refundFee.fee.id]
    )).rows[0];
    assert.deepEqual(effect, {
      snapshot_id: beforeRefund.refunded.at(-1).id,
      fee_version: "1",
      gross: "100000"
    });
    const oldReplay = await weekly.recordAndSettle(ids.teacherA, {
      referralCaseId: ids.referralRefund, teachingWeekId: ids.weekRefund, venueId: ids.venueA,
      settlementMonth: effectiveFrom, grossAmountCents: 100000n, expectedVersion: 0
    }, "refund-settlement:fee-refund");
    assert.equal(oldReplay.replay, true);
    await assert.rejects(weekly.recordAndSettle(ids.teacherA, {
      referralCaseId: ids.referralRefund, teachingWeekId: ids.weekRefund, venueId: ids.venueA,
      settlementMonth: effectiveFrom, grossAmountCents: 120000n, expectedVersion: 1
    }, "refund-settlement:refunded-correction"), /WEEKLY_FEE_REFUNDED/);

    const teaching = await new PostgresTeachingReadService(database.pool).listReceivedReferrals(teacherContext, at);
    const displayedRefund = teaching.flatMap(item => item.weeklyFees).find(item => item.entryId === refundFee.fee.id);
    assert.equal(displayedRefund?.grossAmountCents, 100000n);
    assert.equal(displayedRefund?.version, 1);
    assert.equal(displayedRefund?.refundStatus, "REFUNDED");
    const personal = new PostgresPersonalReadService(database.pool);
    assert.deepEqual((await personal.getOwnOverview(teacherContext, at)).currentYearIncomeByCategory, { teachingTeacher: 86000n });
    assert.deepEqual((await personal.getOwnOverview({ subject: "TEACHING_TEACHER", personId: ids.teacherB, scope: "SELF" }, at)).currentYearIncomeByCategory, { teachingTeacher: 88000n });

    const corrected = await weekly.recordAndSettle(ids.teacherA, {
      referralCaseId: ids.referralA, teachingWeekId: ids.weekA, venueId: ids.venueA,
      settlementMonth: effectiveFrom, grossAmountCents: 110000n, expectedVersion: 1
    }, "refund-settlement:normal-correction");
    assert.equal(corrected.replay, false);
    assert.deepEqual(await Promise.all([ids.teacherA, ids.teacherB, ids.teacherC].map(id => accountBalance(database.pool, id))), [95700n, 87000n, 27300n]);
    const afterRefunded = await snapshotState(database.pool, refundFee.fee.id);
    const afterA = await snapshotState(database.pool, activeA.fee.id);
    const afterB = await snapshotState(database.pool, activeB.fee.id);
    assert.deepEqual(afterRefunded, beforeRefund.refunded);
    assert.equal(afterA.length, beforeRefund.activeA.length + 1);
    assert.equal(afterB.length, beforeRefund.activeB.length + 1);
    assert.deepEqual(afterA.at(-1).context_json.monthlyNet, { receivedCents: "110000", referredCents: "0", netCents: "110000" });
    assert.deepEqual(afterB.at(-1).context_json.monthlyNet, { receivedCents: "100000", referredCents: "0", netCents: "100000" });
    assert.deepEqual((await personal.getOwnOverview(teacherContext, at)).currentYearIncomeByCategory, { teachingTeacher: 95700n });
    assert.deepEqual((await personal.getOwnOverview({ subject: "TEACHING_TEACHER", personId: ids.teacherB, scope: "SELF" }, at)).currentYearIncomeByCategory, { teachingTeacher: 87000n });
    assert.deepEqual((await personal.getOwnOverview({ subject: "TEACHING_TEACHER", personId: ids.teacherC, scope: "SELF" }, at)).currentYearIncomeByCategory, { referrer: 27300n });

    // Approval and a correction of the same fee share the month→fee lock protocol.
    // Either serial order is valid, but the approved effect must freeze exactly the version that won.
    const raceWeek = randomUUID(), raceStudent = randomUUID(), raceReferral = randomUUID();
    await database.pool.query(
      `INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month,status)
       VALUES($1::uuid,$2::uuid,4,'REGULAR','2026-09-28','2026-10-04',$3::date,'OPEN')`,
      [raceWeek, ids.period, effectiveFrom]
    );
    await database.pool.query(
      `INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name)
       VALUES($1::uuid,$2::uuid,$3,'并发退款学生')`,
      [raceStudent, ids.teacherA, `course:${raceStudent}`]
    );
    await database.pool.query(
      `INSERT INTO referral_case(
         id,teacher_student_record_id,referrer_person_id,receiver_person_id,
         referrer_identity,status,submitted_at,version
       ) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'TEACHING_TEACHER','ACCEPTED',$5::timestamptz,2)`,
      [raceReferral, raceStudent, ids.teacherC, ids.teacherA, at.toISOString()]
    );
    const raceFee = await weekly.recordAndSettle(ids.teacherA, {
      referralCaseId: raceReferral, teachingWeekId: raceWeek, venueId: ids.venueA,
      settlementMonth: effectiveFrom, grossAmountCents: 50000n, expectedVersion: 0
    }, "refund-settlement:race-fee");
    const raceDocument = await new PostgresFinanceDraftService(database.pool).create(
      teacherContext, { kind: "REFUND" }, "refund-settlement:race-document", at
    );
    const raceEvidence = await Promise.all([
      addReadyAttachment(database.pool, store, raceDocument.id, ids.teacherA, "SUPPORTING_DOCUMENT"),
      addReadyAttachment(database.pool, store, raceDocument.id, ids.teacherA, "APPLICATION_SCREENSHOT")
    ]);
    await new PostgresRefundSubmissionService(database.pool, store).submit(
      teacherContext,
      raceDocument.id,
      { expectedVersion: 1, reason: "并发退款", weeklyFeeEntryIds: [raceFee.fee.id], attachmentVersionIds: raceEvidence },
      "refund-settlement:race-submit",
      at
    );
    const raced = await Promise.allSettled([
      review.approve(
        { subject: "HEADQUARTERS_FINANCE", personId: ids.hq, scope: "GLOBAL" },
        raceDocument.id,
        { expectedVersion: 2, reason: "并发审批" },
        "refund-settlement:race-approve",
        at
      ),
      weekly.recordAndSettle(ids.teacherA, {
        referralCaseId: raceReferral, teachingWeekId: raceWeek, venueId: ids.venueA,
        settlementMonth: effectiveFrom, grossAmountCents: 60000n, expectedVersion: 1
      }, "refund-settlement:race-correction")
    ]);
    assert.equal(raced[0].status, "fulfilled");
    assert.ok(raced[1].status === "fulfilled" || /WEEKLY_FEE_REFUNDED/.test(String(raced[1].reason)));
    const racedEffect = (await database.pool.query(
      `SELECT source_weekly_fee_version::text AS version,gross_amount_cents::text AS gross
         FROM weekly_fee_refund_effect WHERE weekly_fee_entry_id=$1::uuid`,
      [raceFee.fee.id]
    )).rows[0];
    assert.deepEqual(racedEffect, raced[1].status === "fulfilled"
      ? { version: "2", gross: "60000" }
      : { version: "1", gross: "50000" });
    const currentRaceVersion = Number((await database.pool.query(
      "SELECT version::text FROM weekly_fee_entry WHERE id=$1::uuid",
      [raceFee.fee.id]
    )).rows[0].version);
    await assert.rejects(weekly.recordAndSettle(ids.teacherA, {
      referralCaseId: raceReferral, teachingWeekId: raceWeek, venueId: ids.venueA,
      settlementMonth: effectiveFrom, grossAmountCents: 70000n, expectedVersion: currentRaceVersion
    }, "refund-settlement:race-after-refund"), /WEEKLY_FEE_REFUNDED/);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
