import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PostgresFinanceDraftService } from "../../../api/dist/postgres-finance-draft-service.js";
import { PostgresGroupLeaderRelationshipService } from "../../../api/dist/postgres-group-leader-relationship-service.js";
import { LocalAttachmentStore } from "../../../api/dist/local-attachment-store.js";
import { PostgresRefundReviewService } from "../../../api/dist/postgres-refund-review-service.js";
import { PostgresRefundSubmissionService } from "../../../api/dist/postgres-refund-submission-service.js";
import { PostgresWeeklySettlementService } from "../../../api/dist/postgres-weekly-settlement-service.js";
import { createTestDatabase } from "../../../api/test/integration/postgres-test-database.mjs";
import { FullBackupDerivedSpoolIndex } from "../../dist/full-backup-derived-spool-index.js";
import { FullBackupLedgerBusinessPeriodSource } from "../../dist/full-backup-ledger-business-period-source.js";
import { FullBackupSpool } from "../../dist/full-backup-spool.js";
import { FullBackupTransformer } from "../../dist/full-backup-transformer.js";
import { PostgresFullBackupSource } from "../../dist/postgres-full-backup-source.js";

const at = new Date("2026-09-23T09:00:00.000Z");
const json = (value) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const admin = (personId) => ({ personId, subject: "SYSTEM_ADMIN", scope: "GLOBAL" });
const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 91) });
const pngDigest = sha(png);
const chunks = async function* () { yield png; };

const policy = {
  plannerBaseRateBasisPoints: 0n,
  teacherBaseRateBasisPoints: 9400n,
  planningMentorWeightBasisPoints: 0n,
  groupLeaderRateBasisPoints: 600n,
  teachingMentorRateBasisPoints: 0n,
  venueRateBasisPoints: 0n,
  campusConsultationForPlannerRateBasisPoints: 0n,
  campusConsultationForTeacherRateBasisPoints: 0n,
  platformFinanceRateBasisPoints: 0n,
  regionFinanceRateBasisPoints: 0n,
  dynamicTiers: [
    { label: "low", maxInclusive: 50000n, adjustmentBasisPoints: 0n },
    { label: "middle", minExclusive: 50000n, maxInclusive: 150000n, adjustmentBasisPoints: 0n },
    { label: "high", minExclusive: 150000n, adjustmentBasisPoints: 0n },
  ],
};

const addAttachment = async (pool, store, documentId, personId, purpose) => {
  const attachmentId = randomUUID(), versionId = randomUUID();
  await store.put({ versionId, originalFilename: `${purpose}.png`, declaredMediaType: "image/png", declaredSizeBytes: png.length, expectedSha256: pngDigest }, chunks());
  await pool.query("INSERT INTO finance_attachment(id,finance_document_id,purpose,created_by_person_id,created_at) VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5::timestamptz)", [attachmentId, documentId, purpose, personId, at]);
  await pool.query(
    `INSERT INTO finance_attachment_version(
       id,finance_attachment_id,version_no,status,original_filename,declared_media_type,
       declared_size_bytes,expected_sha256,detected_media_type,actual_size_bytes,sha256,
       uploaded_by_person_id,created_at,ready_at
     ) VALUES($1::uuid,$2::uuid,1,'READY',$3,'image/png',$4::bigint,$5,'image/png',$4::bigint,$5,$6::uuid,$7::timestamptz,$7::timestamptz)`,
    [versionId, attachmentId, `${purpose}.png`, png.length, pngDigest, personId, at],
  );
  return versionId;
};

const collect = async (stream) => {
  const rows = [];
  for await (const row of stream) rows.push(row);
  return rows;
};

test("real PostgreSQL F14 period sources preserve cross-month group-leader settlement and approved refund history", async () => {
  const database = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "ledger-period-pg-"));
  let index, source;
  try {
    const ids = Object.fromEntries(["admin", "teacher", "leaderA", "leaderB", "finance", "venue", "year", "period", "septemberWeek", "octoberWeek", "student", "referral", "policy"].map((key) => [key, randomUUID()]));
    for (const key of ["admin", "teacher", "leaderA", "leaderB", "finance"]) {
      await database.pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,$2,'ACTIVE')", [ids[key], `period-source-${key}-${ids[key]}`]);
    }
    for (const key of ["teacher", "leaderA", "leaderB"]) {
      await database.pool.query("INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('PERSON',$1::uuid,$2,'ACTIVE')", [ids[key], `person:${key}:${ids[key]}`]);
    }
    await database.pool.query(
      `INSERT INTO role_assignment(person_id,subject_code,scope_type,scope_id,valid_from,created_by) VALUES
         ($1::uuid,'SYSTEM_ADMIN','GLOBAL',NULL,'2026-01-01T00:00:00Z',$1::uuid),
         ($2::uuid,'TEACHING_TEACHER','SELF',$2::uuid,'2026-01-01T00:00:00Z',$1::uuid),
         ($3::uuid,'GROUP_LEADER','ASSOCIATED_TEACHERS',NULL,'2026-01-01T00:00:00Z',$1::uuid),
         ($4::uuid,'GROUP_LEADER','ASSOCIATED_TEACHERS',NULL,'2026-01-01T00:00:00Z',$1::uuid),
         ($5::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'2026-01-01T00:00:00Z',$1::uuid)`,
      [ids.admin, ids.teacher, ids.leaderA, ids.leaderB, ids.finance],
    );
    for (const [index, key] of ["leaderA", "leaderB"].entries()) {
      await database.pool.query(
        "INSERT INTO user_account(person_id,phone_normalized,password_hash,login_status) VALUES($1::uuid,$2,$3,'ACTIVE')",
        [ids[key], `1390000${String(index + 1).padStart(3, "0")}`, `period-source-${key}`],
      );
    }
    await database.pool.query("INSERT INTO teacher_profile(person_id,business_identity,employment_status) VALUES($1::uuid,'TEACHING_TEACHER','ACTIVE')", [ids.teacher]);
    await database.pool.query("INSERT INTO person_relationship(teacher_id,relationship_type,related_person_id,valid_from,effective_scope,created_by) VALUES($1::uuid,'GROUP_LEADER',$2::uuid,'2026-01-01T00:00:00Z','CURRENT',$3::uuid)", [ids.teacher, ids.leaderA, ids.admin]);
    await database.pool.query("INSERT INTO venue(id,owner_person_id,name,status,default_for_owner) VALUES($1::uuid,$2::uuid,'跨月来源场地','ACTIVE',true)", [ids.venue, ids.teacher]);
    await database.pool.query("INSERT INTO academic_year_plan(id,label,starts_on,ends_on,created_by) VALUES($1::uuid,'F14 跨月学年','2026-09-01','2027-08-31',$2::uuid)", [ids.year, ids.admin]);
    await database.pool.query("INSERT INTO academic_period(id,academic_year_plan_id,label,starts_on,ends_on) VALUES($1::uuid,$2::uuid,'秋季','2026-09-01','2027-01-31')", [ids.period, ids.year]);
    await database.pool.query(
      `INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month,status) VALUES
       ($1::uuid,$3::uuid,1,'REGULAR','2026-09-21','2026-09-27','2026-09-01','OPEN'),
       ($2::uuid,$3::uuid,2,'REGULAR','2026-10-05','2026-10-11','2026-10-01','OPEN')`,
      [ids.septemberWeek, ids.octoberWeek, ids.period],
    );
    await database.pool.query("INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name) VALUES($1::uuid,$2::uuid,'period-source-course','同一学生跨月费用')", [ids.student, ids.teacher]);
    await database.pool.query("INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,version) VALUES($1::uuid,$2::uuid,$3::uuid,$3::uuid,'TEACHING_TEACHER','ACCEPTED','2026-09-01T00:00:00Z',2)", [ids.referral, ids.student, ids.teacher]);
    await database.pool.query("INSERT INTO rate_policy_version(id,version,effective_from,policy_json,reason,published_by,published_at) VALUES($1::uuid,1,'2026-09-01',$2::jsonb,'F14 跨月来源',$3::uuid,$4::timestamptz)", [ids.policy, json(policy), ids.admin, at]);

    const weekly = new PostgresWeeklySettlementService(database.pool);
    const september = await weekly.recordAndSettle(ids.teacher, { referralCaseId: ids.referral, teachingWeekId: ids.septemberWeek, venueId: ids.venue, settlementMonth: "2026-09-01", grossAmountCents: 100000n, expectedVersion: 0 }, "period-source-september");
    const october = await weekly.recordAndSettle(ids.teacher, { referralCaseId: ids.referral, teachingWeekId: ids.octoberWeek, venueId: ids.venue, settlementMonth: "2026-10-01", grossAmountCents: 100000n, expectedVersion: 0 }, "period-source-october");

    const relationships = new PostgresGroupLeaderRelationshipService(database.pool);
    const preview = await relationships.preview(admin(ids.admin), { teacherPersonId: ids.teacher, newRelatedPersonId: ids.leaderB, effectiveTeachingWeekId: ids.septemberWeek, reason: "当前普通周起覆盖两个月" }, at);
    assert.deepEqual([preview.consideredFeeCount, preview.movedFeeCount], [2, 2]);
    const change = await relationships.publish(admin(ids.admin), preview.previewId, "period-source-group-leader-a-to-b", at);
    assert.equal(change.postingStatus, "POSTED");
    const changeRun = (await database.pool.query("SELECT settlement_calculation_run_id::text AS run_id,ledger_event_id::text AS event_id FROM person_relationship_change WHERE id=$1::uuid", [change.changeId])).rows[0];
    assert.ok(changeRun?.run_id && changeRun.event_id);
    assert.deepEqual((await database.pool.query("SELECT settlement_month::text AS month FROM person_relationship_change_effect WHERE change_id=$1::uuid ORDER BY settlement_month", [change.changeId])).rows.map((row) => row.month), ["2026-09-01", "2026-10-01"]);
    assert.deepEqual((await database.pool.query("SELECT DISTINCT version.settlement_month::text AS month FROM weekly_fee_allocation_snapshot snapshot JOIN weekly_fee_entry_version version ON version.weekly_fee_entry_id=snapshot.weekly_fee_entry_id AND version.version=snapshot.source_weekly_fee_version WHERE snapshot.run_id=$1::uuid ORDER BY month", [changeRun.run_id])).rows.map((row) => row.month), ["2026-09-01", "2026-10-01"]);

    const attachmentStore = await LocalAttachmentStore.create(join(root, "attachments"), resolve(import.meta.dirname, "../../../.."));
    const teacherContext = { personId: ids.teacher, subject: "TEACHING_TEACHER", scope: "SELF" };
    const financeContext = { personId: ids.finance, subject: "HEADQUARTERS_FINANCE", scope: "GLOBAL" };
    const document = await new PostgresFinanceDraftService(database.pool).create(teacherContext, { kind: "REFUND" }, "period-source-refund-draft", at);
    const attachmentVersionIds = await Promise.all(["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT"].map((purpose) => addAttachment(database.pool, attachmentStore, document.id, ids.teacher, purpose)));
    await new PostgresRefundSubmissionService(database.pool, attachmentStore).submit(teacherContext, document.id, { expectedVersion: 1, reason: "跨月周费退款", weeklyFeeEntryIds: [september.fee.id, october.fee.id], attachmentVersionIds }, "period-source-refund-submit", at);
    const approved = await new PostgresRefundReviewService(database.pool, attachmentStore).approve(financeContext, document.id, { expectedVersion: 2, reason: "附件与历史版本已核验" }, "period-source-refund-approve", at);
    assert.deepEqual({ status: approved.status, version: approved.version, replay: approved.replay }, { status: "REFUNDED", version: 3, replay: false });
    const refundEvent = (await database.pool.query("SELECT ledger_event_id::text AS event_id FROM finance_refund_decision WHERE finance_document_id=$1::uuid", [document.id])).rows[0];
    assert.ok(refundEvent?.event_id);
    assert.equal((await database.pool.query("SELECT count(*)::text AS count FROM weekly_fee_refund_effect WHERE finance_document_id=$1::uuid", [document.id])).rows[0].count, "2");

    // Compatibility sentinel only: no allocation is invented for a future event type.
    const futureEventId = randomUUID();
    await database.pool.query("INSERT INTO ledger_event(id,event_key,event_type,payload_hash) VALUES($1::uuid,$2,'FUTURE_F14_EVENT',$3)", [futureEventId, `future-f14:${futureEventId}`, sha("future-f14")]);

    const spool = await new FullBackupSpool({ source: new PostgresFullBackupSource(database.pool), transformer: new FullBackupTransformer({ fingerprint: ({ domain, value }) => sha(`${domain}\0${value}`) }), tempRoot: join(root, "spool"), batchSize: 1 }).create();
    index = await FullBackupDerivedSpoolIndex.create({ spoolDirectory: join(root, "spool", spool.spoolId), spool, attemptRoot: join(root, "index") });
    source = await FullBackupLedgerBusinessPeriodSource.create({ index, attemptRoot: join(root, "period") });
    const periods = await collect(source.streamEventPeriods());
    const byEvent = new Map(periods.map((row) => [row.eventId, row]));
    const periodSummary = (eventId) => {
      const row = byEvent.get(eventId);
      return row && { status: row.status, uniqueLockedSettlementMonth: row.uniqueLockedSettlementMonth, distinctMonthCount: row.distinctMonthCount };
    };
    assert.deepEqual([periodSummary(changeRun.event_id), periodSummary(refundEvent.event_id)], [
      { status: "MULTIPLE_BUSINESS_PERIODS", uniqueLockedSettlementMonth: null, distinctMonthCount: "2" },
      { status: "MULTIPLE_BUSINESS_PERIODS", uniqueLockedSettlementMonth: null, distinctMonthCount: "2" },
    ]);
    const ordinaryEvents = await Promise.all([september.runId, october.runId].map(async (runId) => (await database.pool.query("SELECT ledger_event_id::text AS event_id FROM settlement_calculation_run WHERE id=$1::uuid", [runId])).rows[0].event_id));
    assert.deepEqual(ordinaryEvents.map(periodSummary), [
      { status: "UNIQUE_LOCKED_SETTLEMENT_MONTH", uniqueLockedSettlementMonth: "2026-09-01", distinctMonthCount: "1" },
      { status: "UNIQUE_LOCKED_SETTLEMENT_MONTH", uniqueLockedSettlementMonth: "2026-10-01", distinctMonthCount: "1" },
    ]);
    assert.deepEqual(periodSummary(futureEventId), { status: "UNIMPLEMENTED_EVENT_TYPE", uniqueLockedSettlementMonth: null, distinctMonthCount: "0" });

    const links = await collect(source.streamSourceLinks());
    const expectedVersions = (await database.pool.query("SELECT weekly_fee_entry_id::text AS fee_id,version::text AS fee_version,settlement_month::text AS month FROM weekly_fee_entry_version WHERE weekly_fee_entry_id=ANY($1::uuid[]) AND version=1 ORDER BY settlement_month", [[september.fee.id, october.fee.id]])).rows;
    for (const eventId of [changeRun.event_id, refundEvent.event_id]) {
      const versionLinks = links.filter((link) => link.eventId === eventId && link.relation === "WEEKLY_FEE_VERSION");
      assert.deepEqual(versionLinks.map((link) => ({ fee_id: link.weeklyFeeEntryId, fee_version: link.weeklyFeeVersion, month: link.lockedSettlementMonth })).sort((left, right) => left.month.localeCompare(right.month)), expectedVersions);
      assert.equal(versionLinks.some((link) => Object.keys(link).some((key) => /amount|cents/i.test(key))), false, "period source links only identify historical versions and never distribute money");
    }
  } finally {
    await source?.close().catch(() => {});
    await index?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
    await database.close();
  }
});
