import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

export async function fixture() {
  const database = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-refund-review-"));
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

    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const teacherContext = {subject:"TEACHING_TEACHER",personId:ids.teacherA,scope:"SELF"};
    const hqContext = {subject:"HEADQUARTERS_FINANCE",personId:ids.hq,scope:"GLOBAL"};
    const review = new PostgresRefundReviewService(database.pool,store);
    const pending = async (fees=[refundFee.fee.id]) => {
      const document=await new PostgresFinanceDraftService(database.pool).create(teacherContext,{kind:"REFUND"},randomUUID(),at);
      const evidence=await Promise.all(["SUPPORTING_DOCUMENT","APPLICATION_SCREENSHOT"].map(purpose=>addReadyAttachment(database.pool,store,document.id,ids.teacherA,purpose)));
      await new PostgresRefundSubmissionService(database.pool,store).submit(teacherContext,document.id,{expectedVersion:1,reason:"synthetic refund",weeklyFeeEntryIds:fees,attachmentVersionIds:evidence},randomUUID(),at);
      return {...document,evidence};
    };
    const approve=(doc,key=randomUUID())=>review.approve(hqContext,doc.id,{expectedVersion:2,reason:"verified"},key,at);
    const balances=()=>Promise.all([ids.teacherA,ids.teacherB,ids.teacherC].map(id=>accountBalance(database.pool,id)));
    const record=(amount,key=randomUUID())=>weekly.recordAndSettle(ids.teacherA,{referralCaseId:ids.referralRefund,teachingWeekId:ids.weekRefund,venueId:ids.venueA,settlementMonth:effectiveFrom,grossAmountCents:amount,expectedVersion:1},key);
    return {database,pool:database.pool,root,ids,store,weekly,refundFee,activeA,activeB,teacherContext,hqContext,review,pending,approve,balances,record,
      close:async()=>{await database.close();await rm(root,{recursive:true,force:true});}};
  } catch(error) {await database.close();await rm(root,{recursive:true,force:true});throw error;}
}
