import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LocalAttachmentStore } from "../../dist/local-attachment-store.js";
import { PostgresFinanceDraftService } from "../../dist/postgres-finance-draft-service.js";
import { PostgresRefundReadService } from "../../dist/postgres-refund-read-service.js";
import { PostgresRefundReviewService } from "../../dist/postgres-refund-review-service.js";
import { PostgresRefundSubmissionService } from "../../dist/postgres-refund-submission-service.js";
import { PostgresWeeklySettlementService } from "../../dist/postgres-weekly-settlement-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";
import { fixture } from "./refund-review-fixture.mjs";

const at = new Date("2026-09-21T09:00:00.000Z");
const month = "2026-09-01";
const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 99) });
const digest = createHash("sha256").update(png).digest("hex");
const chunks = async function* () { yield png; };
const json = (value) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);
const teacher = (personId, scope = "SELF") => ({ personId, subject: "TEACHING_TEACHER", scope });
const global = (personId, subject = "HEADQUARTERS_FINANCE", extra = {}) => ({ personId, subject, scope: "GLOBAL", ...extra });

const policy = {
  plannerBaseRateBasisPoints: 0n, teacherBaseRateBasisPoints: 1200n, planningMentorWeightBasisPoints: 0n,
  groupLeaderRateBasisPoints: 0n, teachingMentorRateBasisPoints: 0n, venueRateBasisPoints: 0n,
  campusConsultationForPlannerRateBasisPoints: 0n, campusConsultationForTeacherRateBasisPoints: 0n,
  platformFinanceRateBasisPoints: 0n, regionFinanceRateBasisPoints: 0n,
  dynamicTiers: [
    { label: "low", maxInclusive: 50000n, adjustmentBasisPoints: 0n },
    { label: "middle", minExclusive: 50000n, maxInclusive: 150000n, adjustmentBasisPoints: 0n },
    { label: "high", minExclusive: 150000n, adjustmentBasisPoints: 0n }
  ]
};

const readyAttachment = async (pool, store, documentId, personId, purpose) => {
  const attachmentId = randomUUID();
  const versionId = randomUUID();
  await store.put({ versionId, originalFilename: `${purpose}.png`, declaredMediaType: "image/png", declaredSizeBytes: png.length, expectedSha256: digest }, chunks());
  await pool.query(
    "INSERT INTO finance_attachment(id,finance_document_id,purpose,created_by_person_id,created_at) VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5)",
    [attachmentId, documentId, purpose, personId, at]
  );
  await pool.query(
    `INSERT INTO finance_attachment_version(id,finance_attachment_id,version_no,status,original_filename,declared_media_type,declared_size_bytes,expected_sha256,detected_media_type,actual_size_bytes,sha256,uploaded_by_person_id,created_at,ready_at)
     VALUES($1::uuid,$2::uuid,1,'READY',$3,'image/png',$4,$5,'image/png',$4,$5,$6::uuid,$7,$7)`,
    [versionId, attachmentId, `${purpose}.png`, png.length, digest, personId, at]
  );
  return versionId;
};

const submit = async ({ pool, store, reads, context, feeId, key, decision }) => {
  const draft = await new PostgresFinanceDraftService(pool).create(context, { kind: "REFUND" }, `${key}:draft`, at);
  const attachments = await Promise.all([
    readyAttachment(pool, store, draft.id, context.personId, "SUPPORTING_DOCUMENT"),
    readyAttachment(pool, store, draft.id, context.personId, "APPLICATION_SCREENSHOT")
  ]);
  const submission = await new PostgresRefundSubmissionService(pool, store).submit(context, draft.id, {
    expectedVersion: draft.version, reason: `${key} 退款事由`, weeklyFeeEntryIds: [feeId], attachmentVersionIds: attachments
  }, `${key}:submit`, at);
  const pending = await reads.getDetail(context, draft.id, at);
  assert.equal(pending.status, "PENDING_APPROVAL");
  assert.equal(pending.selectedFees[0].submittedGrossAmountCents, "100000");
  const result = await new PostgresRefundReviewService(pool, store)[decision](global(context.hqId), draft.id, {
    expectedVersion: submission.version, reason: `${key} 审核`
  }, `${key}:${decision}`, at);
  return { id: draft.id, result, pending };
};

test("退款读取按提交快照展示、本人财年隔离、全局管理可读并对损坏与拒绝详情审计", async () => {
  const database = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-refund-read-"));
  try {
    const ids = Object.fromEntries(["admin", "hq", "teacher", "other", "year", "period", "weekOne", "weekTwo", "venue", "student", "referral"].map((key) => [key, randomUUID()]));
    for (const key of ["admin", "hq", "teacher", "other"]) {
      await database.pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,$2,'ACTIVE')", [ids[key], `退款读取-${key}`]);
    }
    for (const key of ["teacher", "other"]) {
      await database.pool.query("INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('PERSON',$1::uuid,$2,'ACTIVE')", [ids[key], `person:${ids[key]}`]);
      await database.pool.query(
        "INSERT INTO role_assignment(person_id,subject_code,scope_type,scope_id,valid_from,created_by) VALUES($1::uuid,'TEACHING_TEACHER','SELF',$1::uuid,'2026-01-01',$2::uuid)",
        [ids[key], ids.admin]
      );
    }
    await database.pool.query("INSERT INTO role_assignment(person_id,subject_code,scope_type,scope_id,valid_from,created_by) VALUES($1::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'2026-01-01',$2::uuid)", [ids.hq, ids.admin]);
    await database.pool.query("INSERT INTO venue(id,owner_person_id,name,status,default_for_owner) VALUES($1::uuid,$2::uuid,'读取场地','ACTIVE',true)", [ids.venue, ids.teacher]);
    await database.pool.query("INSERT INTO academic_year_plan(id,label,starts_on,ends_on,created_by) VALUES($1::uuid,'读取学年','2026-09-01','2027-08-31',$2::uuid)", [ids.year, ids.admin]);
    await database.pool.query("INSERT INTO academic_period(id,academic_year_plan_id,label,starts_on,ends_on) VALUES($1::uuid,$2::uuid,'秋季','2026-09-01','2027-01-31')", [ids.period, ids.year]);
    await database.pool.query(
      `INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month,status) VALUES
       ($1::uuid,$3::uuid,1,'REGULAR','2026-09-07','2026-09-13',$4::date,'OPEN'),
       ($2::uuid,$3::uuid,2,'REGULAR','2026-09-14','2026-09-20',$4::date,'OPEN')`,
      [ids.weekOne, ids.weekTwo, ids.period, month]
    );
    await database.pool.query("INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name) VALUES($1::uuid,$2::uuid,'refund-course','退款学生')", [ids.student, ids.teacher]);
    await database.pool.query(
      "INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,version) VALUES($1::uuid,$2::uuid,$3::uuid,$3::uuid,'TEACHING_TEACHER','ACCEPTED',$4,2)",
      [ids.referral, ids.student, ids.teacher, at]
    );
    await database.pool.query("INSERT INTO rate_policy_version(version,effective_from,policy_json,reason,published_by) VALUES(1,$1::date,$2::jsonb,'读取规则',$3::uuid)", [month, json(policy), ids.admin]);

    const weekly = new PostgresWeeklySettlementService(database.pool);
    const feeOne = await weekly.recordAndSettle(ids.teacher, { referralCaseId: ids.referral, teachingWeekId: ids.weekOne, venueId: ids.venue, settlementMonth: month, grossAmountCents: 100000n, expectedVersion: 0 }, "refund-read:fee-one");
    const feeTwo = await weekly.recordAndSettle(ids.teacher, { referralCaseId: ids.referral, teachingWeekId: ids.weekTwo, venueId: ids.venue, settlementMonth: month, grossAmountCents: 100000n, expectedVersion: 0 }, "refund-read:fee-two");
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const reads = new PostgresRefundReadService(database.pool);
    const context = { ...teacher(ids.teacher), hqId: ids.hq };
    const approved = await submit({ pool: database.pool, store, reads, context, feeId: feeOne.fee.id, key: "refund-read-approved", decision: "approve" });
    const rejected = await submit({ pool: database.pool, store, reads, context, feeId: feeTwo.fee.id, key: "refund-read-rejected", decision: "reject" });

    const mine = await reads.listOwn(teacher(ids.teacher), at);
    assert.equal(mine.documents.length, 2);
    assert.deepEqual(mine.documents.map((document) => document.status).sort(), ["REFUNDED", "REJECTED"]);
    const approvedDetail = await reads.getDetail(teacher(ids.teacher), approved.id, at);
    assert.equal(approvedDetail.status, "REFUNDED");
    assert.equal(approvedDetail.applicantDisplayName, "退款读取-teacher");
    assert.equal(approvedDetail.selectedFees[0].refundStatus, "REFUNDED");
    assert.equal(approvedDetail.selectedFees[0].submittedGrossAmountCents, "100000");
    assert.equal(approvedDetail.decision?.decision, "APPROVED");
    assert.equal(approvedDetail.management, undefined);
    const rejectedDetail = await reads.getDetail(global(ids.hq), rejected.id, at);
    assert.equal(rejectedDetail.status, "REJECTED");
    assert.equal(rejectedDetail.selectedFees[0].refundStatus, "ACTIVE");
    assert.deepEqual(rejectedDetail.management, { submittedByPersonId: ids.teacher, decidedByPersonId: ids.hq, decisionActorSubject: "HEADQUARTERS_FINANCE", decisionActorScope: "GLOBAL" });
    assert.equal((await reads.listManaged(global(ids.hq))).documents.length, 2);
    await assert.rejects(reads.getDetail(teacher(ids.other), approved.id, at), /FINANCE_DOCUMENT_NOT_FOUND/);
    await assert.rejects(reads.listManaged(global(ids.hq, "HEADQUARTERS_FINANCE", { regionId: randomUUID() })), /FORBIDDEN_SCOPE/);
    await assert.rejects(reads.listOwn({ personId: ids.teacher, subject: "ACADEMIC_PLANNER", scope: "SELF" }, at), /FORBIDDEN_SCOPE/);
    const nextYear = new Date("2027-09-01T00:00:00.000Z");
    assert.deepEqual(await reads.listOwn(teacher(ids.teacher), nextYear), { documents: [] });
    await assert.rejects(reads.getDetail(teacher(ids.teacher), approved.id, nextYear), /FINANCE_DOCUMENT_NOT_FOUND/);
    assert.equal((await reads.getDetail(global(ids.hq), approved.id, nextYear)).id, approved.id);

    await database.pool.query("ALTER TABLE finance_refund_decision DISABLE TRIGGER USER");
    await database.pool.query(
      "UPDATE finance_refund_decision SET authorization_snapshot=jsonb_set(authorization_snapshot,'{submissionSnapshot,applicantContextScope}','\"GLOBAL\"'::jsonb,true) WHERE finance_document_id=$1::uuid",
      [approved.id]
    );
    await database.pool.query("ALTER TABLE finance_refund_decision ENABLE TRIGGER USER");
    await assert.rejects(reads.getDetail(global(ids.hq), approved.id, at), /FINANCE_REFUND_DATA_UNAVAILABLE/);

    await database.pool.query("ALTER TABLE finance_document_event DISABLE TRIGGER USER");
    await database.pool.query("UPDATE finance_document_event SET created_at=created_at + interval '1 second' WHERE finance_document_id=$1::uuid AND event_type='REFUND_REJECTED'", [rejected.id]);
    await database.pool.query("ALTER TABLE finance_document_event ENABLE TRIGGER USER");
    await assert.rejects(reads.getDetail(global(ids.hq), rejected.id, at), /FINANCE_REFUND_DATA_UNAVAILABLE/);

    await database.pool.query("ALTER TABLE finance_refund_submission_item DISABLE TRIGGER USER");
    await database.pool.query("UPDATE finance_refund_submission_item SET submitted_gross_amount_cents=1 WHERE finance_document_id=$1::uuid", [approved.id]);
    await database.pool.query("ALTER TABLE finance_refund_submission_item ENABLE TRIGGER USER");
    await assert.rejects(reads.getDetail(global(ids.hq), approved.id, at), /FINANCE_REFUND_DATA_UNAVAILABLE/);
    const audits = await database.pool.query("SELECT action_code,reason FROM audit_event WHERE subject_type='FINANCE_REFUND' AND subject_id=$1::uuid ORDER BY created_at", [approved.id]);
    assert.ok(audits.rows.some((row) => row.action_code === "REFUND_DETAIL_READ"));
    assert.ok(audits.rows.some((row) => row.action_code === "REFUND_DETAIL_DENIED" && row.reason === "NOT_FOUND_OR_FORBIDDEN"));
    assert.ok(audits.rows.some((row) => row.action_code === "REFUND_DETAIL_INTEGRITY_FAILED"));
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("同一周费先被批准后，较早待审或被拒绝的另一申请仍可读取原提交快照与已退款状态", async () => {
  const setup = await fixture();
  try {
    const reads = new PostgresRefundReadService(setup.pool);
    const first = await setup.pending();
    const second = await setup.pending();
    await setup.approve(first, "refund-read-overlap-approve");

    const pending = await reads.getDetail(setup.teacherContext, second.id, at);
    assert.equal(pending.status, "PENDING_APPROVAL");
    assert.equal(pending.selectedFees[0].refundStatus, "REFUNDED");
    assert.equal(pending.selectedFees[0].submittedGrossAmountCents, "100000");

    await setup.review.reject(setup.hqContext, second.id, { expectedVersion: 2, reason: "该周费用已完成退款" }, "refund-read-overlap-reject", at);
    const rejected = await reads.getDetail(setup.teacherContext, second.id, at);
    assert.equal(rejected.status, "REJECTED");
    assert.equal(rejected.selectedFees[0].refundStatus, "REFUNDED");
    assert.equal(rejected.decision?.postingStatus, "REJECTED");
  } finally {
    await setup.close();
  }
});
