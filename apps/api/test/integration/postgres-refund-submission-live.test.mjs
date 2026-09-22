import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LocalAttachmentStore } from "../../dist/local-attachment-store.js";
import { PostgresRefundSubmissionService } from "../../dist/postgres-refund-submission-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const at = new Date("2026-09-21T09:00:00.000Z");
const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 83) });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const chunks = bytes => (async function* () { yield bytes; })();
const teacher = personId => ({ subject: "TEACHING_TEACHER", personId, scope: "CAMPUS", campusId: randomUUID() });
const addPerson = (pool, id, name) => pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,$2,'ACTIVE')", [id, name]);

async function addAcademicFee(pool, { ownerId, receiverId, plannerId, suffix, startsOn = "2026-09-01", endsOn = "2027-08-31", weekStart = "2026-09-21", weekEnd = "2026-09-27", settlementMonth = "2026-09-01", referralId, studentId, sequence = 1 }) {
  const yearId = randomUUID(), periodId = randomUUID(), weekId = randomUUID(), venueId = randomUUID();
  const resolvedStudent = studentId ?? randomUUID(), resolvedReferral = referralId ?? randomUUID(), feeId = randomUUID();
  await pool.query("INSERT INTO academic_year_plan(id,label,starts_on,ends_on,created_by) VALUES($1::uuid,$2,$3::date,$4::date,$5::uuid)", [yearId, `year-${suffix}-${sequence}`, startsOn, endsOn, ownerId]);
  await pool.query("INSERT INTO academic_period(id,academic_year_plan_id,label,starts_on,ends_on) VALUES($1::uuid,$2::uuid,$3,$4::date,$5::date)", [periodId, yearId, `period-${suffix}-${sequence}`, startsOn, endsOn]);
  await pool.query("INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month) VALUES($1::uuid,$2::uuid,$3,'REGULAR',$4::date,$5::date,$6::date)", [weekId, periodId, sequence, weekStart, weekEnd, settlementMonth]);
  if (studentId === undefined) await pool.query("INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name) VALUES($1::uuid,$2::uuid,$3,'退款学生')", [resolvedStudent, receiverId, `course-${suffix}`]);
  if (referralId === undefined) await pool.query("INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'ACADEMIC_PLANNER','ACCEPTED',$5::timestamptz)", [resolvedReferral, resolvedStudent, plannerId, receiverId, at.toISOString()]);
  await pool.query("INSERT INTO venue(id,owner_person_id,name,status) VALUES($1::uuid,$2::uuid,$3,'ACTIVE')", [venueId, receiverId, `venue-${suffix}-${sequence}`]);
  await pool.query(
    `INSERT INTO weekly_fee_entry(id,referral_case_id,teaching_week_id,settlement_month,gross_amount_cents,venue_id,venue_owner_person_id,is_self_use_snapshot,source_case_version,version,created_by,created_at,updated_at)
     VALUES($1::uuid,$2::uuid,$3::uuid,$4::date,1000,$5::uuid,$6::uuid,true,1,1,$6::uuid,$7::timestamptz,$7::timestamptz)`,
    [feeId, resolvedReferral, weekId, settlementMonth, venueId, receiverId, at.toISOString()]
  );
  return { feeId, referralId: resolvedReferral, studentId: resolvedStudent, weekId, yearId };
}

const addDocument = async (pool, personId, createdAt = at) => {
  const id = randomUUID();
  await pool.query("INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at) VALUES($1::uuid,$2::uuid,'REFUND','DRAFT',1,$3::timestamptz,$3::timestamptz)", [id, personId, createdAt.toISOString()]);
  return id;
};
const addReady = async (pool, store, documentId, purpose, slotId = randomUUID(), versionNo = 1) => {
  const versionId = randomUUID(), sha = digest(png);
  await store.put({ versionId, originalFilename: `${purpose}-${versionNo}.png`, declaredMediaType: "image/png", declaredSizeBytes: png.length, expectedSha256: sha }, chunks(png));
  if (versionNo === 1) await pool.query("INSERT INTO finance_attachment(id,finance_document_id,purpose,created_by_person_id,created_at) SELECT $1::uuid,$2::uuid,$3,applicant_person_id,$4::timestamptz FROM finance_document WHERE id=$2::uuid", [slotId, documentId, purpose, at.toISOString()]);
  await pool.query(
    `INSERT INTO finance_attachment_version(id,finance_attachment_id,version_no,status,original_filename,declared_media_type,declared_size_bytes,expected_sha256,detected_media_type,actual_size_bytes,sha256,uploaded_by_person_id,created_at,ready_at)
     SELECT $1::uuid,$2::uuid,$3,'READY',$4,'image/png',$5::bigint,$6,'image/png',$5::bigint,$6,applicant_person_id,$7::timestamptz,$7::timestamptz FROM finance_document WHERE id=$8::uuid`,
    [versionId, slotId, versionNo, `${purpose}-${versionNo}.png`, png.length, sha, at.toISOString(), documentId]
  );
  return { slotId, versionId };
};
const requiredEvidence = async (pool, store, documentId) => [
  (await addReady(pool, store, documentId, "SUPPORTING_DOCUMENT")).versionId,
  (await addReady(pool, store, documentId, "APPLICATION_SCREENSHOT")).versionId
];
const draft = (fees, attachments, reason = "家长线下退款") => ({ expectedVersion: 1, reason, weeklyFeeEntryIds: fees, attachmentVersionIds: attachments });

async function injectRefundEffect(pool, feeId, documentId, actorId) {
  const policyId = randomUUID(), runId = randomUUID(), snapshotId = randomUUID();
  await pool.query("INSERT INTO rate_policy_version(id,version,effective_from,policy_json,reason,published_by,published_at) VALUES($1::uuid,(SELECT COALESCE(MAX(version),-1)+1 FROM rate_policy_version),DATE '2026-09-01','{}'::jsonb,'test',$2::uuid,$3::timestamptz)", [policyId, actorId, at.toISOString()]);
  await pool.query("INSERT INTO settlement_calculation_run(id,request_key,fee_entry_id,fee_version,actor_person_id,status,ledger_event_id,created_at) SELECT $1::uuid,$2,id,version,$3::uuid,'NO_BALANCE_CHANGE',NULL,$4::timestamptz FROM weekly_fee_entry WHERE id=$5::uuid", [runId, `effect-${randomUUID()}`, actorId, at.toISOString(), feeId]);
  await pool.query(`INSERT INTO weekly_fee_allocation_snapshot(id,run_id,weekly_fee_entry_id,source_weekly_fee_version,policy_version_id,net_monthly_cents,snapshot_json,context_json,created_at)
    SELECT $1::uuid,$2::uuid,id,version,$3::uuid,1000,'{"lines":[],"accountByKey":{}}'::jsonb,'{}'::jsonb,$4::timestamptz FROM weekly_fee_entry WHERE id=$5::uuid`, [snapshotId, runId, policyId, at.toISOString(), feeId]);
  await pool.query("ALTER TABLE weekly_fee_refund_effect DISABLE TRIGGER USER");
  try {
    await pool.query(`INSERT INTO weekly_fee_refund_effect(weekly_fee_entry_id,finance_document_id,allocation_snapshot_id,source_weekly_fee_version,gross_amount_cents,snapshot_json,created_at)
      SELECT id,$1::uuid,$2::uuid,version,gross_amount_cents,'{"lines":[],"accountByKey":{}}'::jsonb,$3::timestamptz FROM weekly_fee_entry WHERE id=$4::uuid`, [documentId, snapshotId, at.toISOString(), feeId]);
  } finally { await pool.query("ALTER TABLE weekly_fee_refund_effect ENABLE TRIGGER USER"); }
}

test("退款提交冻结同一学生课程的周费、真实附件、上下文和原始ID集合，不动账本", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-refund-submission-"));
  try {
    const teacherId = randomUUID(), plannerId = randomUUID();
    await addPerson(db.pool, teacherId, "refund-teacher"); await addPerson(db.pool, plannerId, "refund-planner");
    const first = await addAcademicFee(db.pool, { ownerId: teacherId, receiverId: teacherId, plannerId, suffix: "submit" });
    const second = await addAcademicFee(db.pool, { ownerId: teacherId, receiverId: teacherId, plannerId, suffix: "submit-two", referralId: first.referralId, studentId: first.studentId, sequence: 2, weekStart: "2026-10-05", weekEnd: "2026-10-11", settlementMonth: "2026-10-01" });
    const documentId = await addDocument(db.pool, teacherId);
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const evidence = await requiredEvidence(db.pool, store, documentId);
    const optional = await addReady(db.pool, store, documentId, "INVOICE");
    const service = new PostgresRefundSubmissionService(db.pool, store);
    const firstResult = await service.submit(teacher(teacherId), documentId, draft([second.feeId, first.feeId], evidence), "submit", at);
    assert.deepEqual(firstResult, { id: documentId, status: "PENDING_APPROVAL", version: 2, replay: false });
    assert.deepEqual(await service.submit(teacher(teacherId), documentId, draft([first.feeId, second.feeId], [...evidence].reverse()), "submit", new Date("2027-09-01T00:00:00Z")), { ...firstResult, replay: true });
    await assert.rejects(service.submit(teacher(teacherId), documentId, draft([first.feeId, second.feeId], evidence, "different"), "submit", at), /IDEMPOTENCY_REPLAY/);
    const submission = (await db.pool.query("SELECT referral_case_id::text AS referral,student_record_id::text AS student,source_document_version::text AS source,result_document_version::text AS result,applicant_context_snapshot FROM finance_refund_submission WHERE finance_document_id=$1::uuid", [documentId])).rows[0];
    assert.deepEqual([submission.referral, submission.student, submission.source, submission.result], [first.referralId, first.studentId, "1", "2"]);
    assert.equal(submission.applicant_context_snapshot.applicantPersonId, teacherId);
    assert.equal(submission.applicant_context_snapshot.applicantContextScope, "CAMPUS");
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM finance_refund_submission_item WHERE finance_document_id=$1::uuid", [documentId])).rows[0].count, 2);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM finance_refund_attachment_binding WHERE finance_document_id=$1::uuid", [documentId])).rows[0].count, 2);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM finance_document_event WHERE finance_document_id=$1::uuid AND event_type='REFUND_SUBMITTED'", [documentId])).rows[0].count, 1);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM ledger_event")).rows[0].count, 0);
    await assert.rejects(db.pool.query("INSERT INTO finance_refund_attachment_binding(finance_document_id,stage,purpose,finance_attachment_version_id,document_version,bound_by_person_id,bound_at,created_at) VALUES($1::uuid,'SUBMISSION','INVOICE',$2::uuid,2,$3::uuid,$4::timestamptz,$4::timestamptz)", [documentId, optional.versionId, teacherId, at.toISOString()]), /FINANCE_REFUND_ATTACHMENT_INVALID/);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("退款提交拒绝坏原件、已退款费用、跨学年特殊周与跨人课程，失败不留下部分申请", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-refund-submission-invalid-"));
  try {
    const teacherId = randomUUID(), plannerId = randomUUID(), otherId = randomUUID();
    await addPerson(db.pool, teacherId, "refund-invalid-teacher"); await addPerson(db.pool, plannerId, "refund-invalid-planner"); await addPerson(db.pool, otherId, "refund-invalid-other");
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const service = new PostgresRefundSubmissionService(db.pool, store);
    const current = await addAcademicFee(db.pool, { ownerId: teacherId, receiverId: teacherId, plannerId, suffix: "bad" });
    const brokenDoc = await addDocument(db.pool, teacherId), brokenEvidence = await requiredEvidence(db.pool, store, brokenDoc);
    await rm(join(root, "objects", brokenEvidence[0]));
    await assert.rejects(service.submit(teacher(teacherId), brokenDoc, draft([current.feeId], brokenEvidence), "broken", at), /ATTACHMENT_INTEGRITY_FAILED/);
    assert.equal((await db.pool.query("SELECT status FROM finance_document WHERE id=$1::uuid", [brokenDoc])).rows[0].status, "DRAFT");

    const effectDoc = await addDocument(db.pool, teacherId);
    await injectRefundEffect(db.pool, current.feeId, effectDoc, teacherId);
    const repeatedDoc = await addDocument(db.pool, teacherId), repeatedEvidence = await requiredEvidence(db.pool, store, repeatedDoc);
    await assert.rejects(service.submit(teacher(teacherId), repeatedDoc, draft([current.feeId], repeatedEvidence), "already-refunded", at), /WEEKLY_FEE_REFUNDED/);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM finance_refund_submission WHERE finance_document_id=$1::uuid", [repeatedDoc])).rows[0].count, 0);

    const oldWeek = await addAcademicFee(db.pool, { ownerId: teacherId, receiverId: teacherId, plannerId, suffix: "old-week", startsOn: "2025-09-01", endsOn: "2026-08-31", weekStart: "2026-08-31", weekEnd: "2026-09-06", settlementMonth: "2026-09-01" });
    const oldDoc = await addDocument(db.pool, teacherId), oldEvidence = await requiredEvidence(db.pool, store, oldDoc);
    await assert.rejects(service.submit(teacher(teacherId), oldDoc, draft([oldWeek.feeId], oldEvidence), "old-week", at), /FORBIDDEN_SCOPE/);

    const other = await addAcademicFee(db.pool, { ownerId: otherId, receiverId: otherId, plannerId, suffix: "other" });
    const mixedDoc = await addDocument(db.pool, teacherId), mixedEvidence = await requiredEvidence(db.pool, store, mixedDoc);
    await assert.rejects(service.submit(teacher(teacherId), mixedDoc, draft([other.feeId], mixedEvidence), "other-fee", at), /FORBIDDEN_SCOPE/);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("退款提交同键并发只冻结一次，直接伪造提交与退款效果都被数据库拒绝", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-refund-submission-concurrent-"));
  try {
    const teacherId = randomUUID(), plannerId = randomUUID();
    await addPerson(db.pool, teacherId, "refund-concurrent-teacher"); await addPerson(db.pool, plannerId, "refund-concurrent-planner");
    const fee = await addAcademicFee(db.pool, { ownerId: teacherId, receiverId: teacherId, plannerId, suffix: "concurrent" });
    const documentId = await addDocument(db.pool, teacherId);
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const evidence = await requiredEvidence(db.pool, store, documentId);
    const service = new PostgresRefundSubmissionService(db.pool, store);
    const pair = await Promise.all([
      service.submit(teacher(teacherId), documentId, draft([fee.feeId], evidence), "same", at),
      service.submit(teacher(teacherId), documentId, draft([fee.feeId], [...evidence].reverse()), "same", at)
    ]);
    assert.equal(new Set(pair.map(value => value.id)).size, 1);
    assert.deepEqual(pair.map(value => value.replay).sort(), [false, true]);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM finance_refund_submission WHERE finance_document_id=$1::uuid", [documentId])).rows[0].count, 1);
    await assert.rejects(db.pool.query("INSERT INTO finance_refund_submission_item(finance_document_id,weekly_fee_entry_id,submitted_fee_version,submitted_gross_amount_cents,teaching_week_id,settlement_month) SELECT $1::uuid,id,version,gross_amount_cents,teaching_week_id,settlement_month FROM weekly_fee_entry WHERE id=$2::uuid", [documentId, fee.feeId]), /FINANCE_REFUND_SUBMISSION_ITEM_INVALID/);
    await assert.rejects(db.pool.query("INSERT INTO weekly_fee_refund_effect(weekly_fee_entry_id,finance_document_id,allocation_snapshot_id,source_weekly_fee_version,gross_amount_cents,snapshot_json,created_at) VALUES($1::uuid,$2::uuid,$3::uuid,1,1000,'{}'::jsonb,$4::timestamptz)", [fee.feeId, documentId, randomUUID(), at.toISOString()]), /WEEKLY_FEE_REFUND_EFFECT_INVALID/);
    const selfPurchase = randomUUID(), reimbursement = randomUUID();
    await db.pool.query("INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at) VALUES($1::uuid,$3::uuid,'SELF_PURCHASE','DRAFT',1,$4::timestamptz,$4::timestamptz),($2::uuid,$3::uuid,'REIMBURSEMENT','DRAFT',1,$4::timestamptz,$4::timestamptz)", [selfPurchase, reimbursement, teacherId, at.toISOString()]);
    await assert.rejects(db.pool.query("UPDATE finance_document SET status='COMPLETED' WHERE id=$1::uuid", [selfPurchase]), /FINANCE_DOCUMENT_SELF_PURCHASE_TRANSITION_INVALID/);
    await assert.rejects(db.pool.query("UPDATE finance_document SET status='PENDING_APPROVAL' WHERE id=$1::uuid", [reimbursement]), /FINANCE_DOCUMENT_REIMBURSEMENT_TRANSITION_INVALID/);
    await assert.rejects(db.pool.query("UPDATE finance_document SET version=0 WHERE id=$1::uuid", [documentId]), /FINANCE_DOCUMENT_REFUND_TRANSITION_INVALID/);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
