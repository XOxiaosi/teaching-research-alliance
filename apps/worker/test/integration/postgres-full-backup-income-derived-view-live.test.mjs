import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalAttachmentStore } from "../../../api/dist/local-attachment-store.js";
import { PostgresFinanceDraftService } from "../../../api/dist/postgres-finance-draft-service.js";
import { PostgresGroupLeaderRelationshipService } from "../../../api/dist/postgres-group-leader-relationship-service.js";
import { PostgresRefundSubmissionService } from "../../../api/dist/postgres-refund-submission-service.js";
import { fixture } from "../../../api/test/integration/refund-review-fixture.mjs";
import { FullBackupDerivedSpoolIndex } from "../../dist/full-backup-derived-spool-index.js";
import { FullBackupIncomeDerivedView } from "../../dist/full-backup-income-derived-view.js";
import { FullBackupSpool } from "../../dist/full-backup-spool.js";
import { FullBackupTransformer } from "../../dist/full-backup-transformer.js";
import { PostgresFullBackupSource } from "../../dist/postgres-full-backup-source.js";

const at = new Date("2026-09-23T08:00:00.000Z");
const month = "2026-09-01";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);
const collect = async (stream) => { const rows = []; for await (const row of stream) rows.push(row); return rows; };

const policy = {
  plannerBaseRateBasisPoints: 0n, teacherBaseRateBasisPoints: 0n, planningMentorWeightBasisPoints: 0n,
  groupLeaderRateBasisPoints: 600n, teachingMentorRateBasisPoints: 0n, venueRateBasisPoints: 0n,
  campusConsultationForPlannerRateBasisPoints: 0n, campusConsultationForTeacherRateBasisPoints: 0n,
  platformFinanceRateBasisPoints: 0n, regionFinanceRateBasisPoints: 0n,
  dynamicTiers: [{ label: "all", adjustmentBasisPoints: 0n }],
};

const readyAttachment = async (pool, store, documentId, personId, purpose) => {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4AWP8DwQMQMDEAAUAPfgEADYYS7QAAAAASUVORK5CYII=", "base64");
  const expectedSha256 = hash(bytes);
  const attachmentId = randomUUID(); const versionId = randomUUID();
  await store.put({ versionId, originalFilename: `${purpose}.png`, declaredMediaType: "image/png", declaredSizeBytes: bytes.length, expectedSha256 }, (async function* () { yield bytes; })());
  await pool.query("INSERT INTO finance_attachment(id,finance_document_id,purpose,created_by_person_id,created_at) VALUES($1,$2,$3,$4,$5)", [attachmentId, documentId, purpose, personId, at]);
  await pool.query(`INSERT INTO finance_attachment_version(id,finance_attachment_id,version_no,status,original_filename,declared_media_type,declared_size_bytes,expected_sha256,detected_media_type,actual_size_bytes,sha256,uploaded_by_person_id,created_at,ready_at)
    VALUES($1,$2,1,'READY',$3,'image/png',$4,$5,'image/png',$4,$5,$6,$7,$7)`, [versionId, attachmentId, `${purpose}.png`, bytes.length, expectedSha256, personId, at]);
  return versionId;
};

const setUpGroupLeaderRefund = async (f) => {
  const { pool, ids } = f;
  await pool.query("INSERT INTO role_assignment(person_id,subject_code,scope_type,scope_id,valid_from,created_by) VALUES($1,'SYSTEM_ADMIN','GLOBAL',NULL,'2026-01-01',$1)", [ids.admin]);
  for (const personId of [ids.teacherA, ids.teacherB, ids.teacherC]) {
    await pool.query("INSERT INTO user_account(person_id,phone_normalized,password_hash,login_status) VALUES($1,$2,$3,'ACTIVE')", [personId, `1899${personId.replaceAll("-", "").slice(0, 7)}`, `income-derived-${personId}`]);
    await pool.query("INSERT INTO role_assignment(person_id,subject_code,scope_type,scope_id,valid_from,created_by) VALUES($1,'GROUP_LEADER','ASSOCIATED_TEACHERS',NULL,'2026-01-01',$2)", [personId, ids.admin]);
  }
  await pool.query("INSERT INTO teacher_profile(person_id,business_identity,employment_status) VALUES($1,'TEACHING_TEACHER','ACTIVE')", [ids.teacherC]);
  await pool.query("INSERT INTO person_relationship(id,teacher_id,relationship_type,related_person_id,valid_from,effective_scope,created_by,created_at) VALUES($1,$2,'GROUP_LEADER',$3,'2026-01-01','REGULAR_WEEK:seed',$4,$5)", [randomUUID(), ids.teacherC, ids.teacherA, ids.admin, at]);
  await pool.query("INSERT INTO rate_policy_version(version,effective_from,policy_json,reason,published_by,published_at) VALUES(2,'2026-09-20',$1::jsonb,'T3 group policy',$2,$3)", [json(policy), ids.admin, at]);
  const student = randomUUID(); const referral = randomUUID();
  await pool.query("INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name) VALUES($1,$2,'T3-group-course','T3组长学生')", [student, ids.teacherC]);
  await pool.query("INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,version) VALUES($1,$2,$3,$3,'TEACHING_TEACHER','ACCEPTED',$4,2)", [referral, student, ids.teacherC, at]);
  const settled = await f.weekly.recordAndSettle(ids.teacherC, {
    referralCaseId: referral, teachingWeekId: ids.weekB, venueId: ids.venueC, settlementMonth: month,
    grossAmountCents: 9007199254740993n, expectedVersion: 0,
  }, "income-derived-group-settle");
  const group = new PostgresGroupLeaderRelationshipService(pool);
  const context = { personId: ids.admin, subject: "SYSTEM_ADMIN", scope: "GLOBAL" };
  const toB = await group.preview(context, { teacherPersonId: ids.teacherC, newRelatedPersonId: ids.teacherB, effectiveTeachingWeekId: ids.weekB, reason: "A到B" }, at);
  const first = await group.publish(context, toB.previewId, "income-derived-A-B", at);
  const toC = await group.preview(context, { teacherPersonId: ids.teacherC, newRelatedPersonId: ids.teacherC, effectiveTeachingWeekId: ids.weekB, reason: "B到C" }, at);
  const second = await group.publish(context, toC.previewId, "income-derived-B-C", at);
  const finalRunId = (await pool.query("SELECT run_id::text AS run_id FROM weekly_fee_allocation_snapshot WHERE weekly_fee_entry_id=$1 ORDER BY sequence_no DESC LIMIT 1", [settled.fee.id])).rows[0].run_id;
  const teacherContext = { personId: ids.teacherC, subject: "TEACHING_TEACHER", scope: "SELF" };
  const draft = await new PostgresFinanceDraftService(pool).create(teacherContext, { kind: "REFUND" }, "income-derived-refund-draft", at);
  const store = f.store;
  const attachmentVersionIds = await Promise.all(["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT"].map((purpose) => readyAttachment(pool, store, draft.id, ids.teacherC, purpose)));
  await new PostgresRefundSubmissionService(pool, store).submit(teacherContext, draft.id, {
    expectedVersion: 1, reason: "T3退款", weeklyFeeEntryIds: [settled.fee.id], attachmentVersionIds,
  }, "income-derived-refund-submit", at);
  const approved = await f.review.approve(f.hqContext, draft.id, { expectedVersion: 2, reason: "T3批准" }, "income-derived-refund-approve", at);
  return { feeId: settled.fee.id, first, second, finalRunId, refundDocumentId: draft.id };
};

const corruptHighestSnapshotVersion = async (root, spool, feeId) => {
  const dataset = spool.datasets.find((item) => item.tableName === "weekly_fee_allocation_snapshot");
  assert.ok(dataset && !dataset.excluded);
  const path = join(root, "spool", spool.spoolId, dataset.spoolFile);
  const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
  const header = JSON.parse(lines[0]);
  const sourceVersionIndex = header.columns.indexOf("source_weekly_fee_version");
  const sequenceIndex = header.columns.indexOf("sequence_no");
  const feeIndex = header.columns.indexOf("weekly_fee_entry_id");
  const highest = lines.slice(1).map((line, index) => ({ index: index + 1, values: JSON.parse(line) }))
    .filter((item) => item.values[feeIndex] === feeId)
    .sort((a, b) => BigInt(b.values[sequenceIndex]) > BigInt(a.values[sequenceIndex]) ? 1 : -1)[0];
  assert.ok(highest, "the target fee must have an allocation snapshot to corrupt");
  highest.values[sourceVersionIndex] = "999";
  lines[highest.index] = JSON.stringify(highest.values);
  const content = `${lines.join("\n")}\n`;
  await writeFile(path, content, { mode: 0o600 });
  return {
    ...spool,
    datasets: spool.datasets.map((item) => item.tableName === dataset.tableName ? { ...item, logicalDigest: hash(content) } : item),
  };
};

test("real PostgreSQL T3 derives frozen A-to-B-to-C refund income, then marks a corrupted highest snapshot PARTIAL without fallback", async () => {
  const f = await fixture();
  const root = await mkdtemp(join(tmpdir(), "alliance-income-derived-pg-"));
  let index; let view; let corruptIndex; let partial;
  try {
    const setup = await setUpGroupLeaderRefund(f);
    const spool = await new FullBackupSpool({
      source: new PostgresFullBackupSource(f.pool),
      transformer: new FullBackupTransformer({ fingerprint: ({ domain, value }) => hash(`${domain}\u0000${value}`) }),
      tempRoot: join(root, "spool"), batchSize: 1,
    }).create();
    const spoolDirectory = join(root, "spool", spool.spoolId);
    index = await FullBackupDerivedSpoolIndex.create({ spoolDirectory, spool, attemptRoot: join(root, "index") });
    view = await FullBackupIncomeDerivedView.create({ index, attemptRoot: join(root, "view") });
    assert.equal(view.metadata().status, "DERIVED_UNPUBLISHED");
    assert.equal(view.metadata().publishedVersion, null);
    const rows = await collect(view.streamMonthlyRows());
    const group = rows.find((row) => row.allocationKey === "groupLeader" && row.netCents === 0n && row.positiveCents > 0n);
    assert.ok(group, "the final C group-leader allocation and its stored refund reversal both remain");
    const trace = await collect(view.streamContributionSources({ accountId: group.accountId, settlementMonth: group.settlementMonth, allocationKey: "groupLeader" }));
    assert.equal(trace.filter((row) => row.feeEntryId === setup.feeId).length, 2);
    assert.equal(trace.find((row) => row.refundFinanceDocumentId === setup.refundDocumentId)?.settlementRunId, setup.finalRunId);
    assert.equal(trace.find((row) => row.refundFinanceDocumentId === setup.refundDocumentId)?.signedCents < 0n, true);
    await view.close(); await index.close(); view = undefined; index = undefined;

    const corrupted = await corruptHighestSnapshotVersion(root, spool, setup.feeId);
    corruptIndex = await FullBackupDerivedSpoolIndex.create({ spoolDirectory, spool: corrupted, attemptRoot: join(root, "corrupt-index") });
    partial = await FullBackupIncomeDerivedView.create({ index: corruptIndex, attemptRoot: join(root, "partial-view") });
    assert.equal(partial.metadata().status, "PARTIAL");
    assert.equal(partial.metadata().incompleteFeeCount !== "0", true);
    assert.equal((await collect(partial.streamAnomalies())).some((item) => item.code === "EXPORT_INCOME_DERIVED_LATEST_SNAPSHOT_VERSION_MISMATCH"), true);
    const partialRows = await collect(partial.streamMonthlyRows());
    assert.equal((await collect(partial.streamAnomalies())).some((item) => item.feeEntryId === setup.feeId), true);
    assert.equal(partialRows.some((row) => row.accountId === group.accountId && row.allocationKey === "groupLeader"), false, "it must not fall back to a lower valid snapshot");
  } finally {
    await partial?.close().catch(() => undefined); await corruptIndex?.close().catch(() => undefined);
    await view?.close().catch(() => undefined); await index?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }); await f.close();
  }
});
