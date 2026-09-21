import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PostgresFinanceAttachmentService } from "../../dist/postgres-finance-attachment-service.js";
import { PostgresFinanceDraftService } from "../../dist/postgres-finance-draft-service.js";
import { PostgresFinanceAttachmentUploadService } from "../../dist/postgres-finance-attachment-upload-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const at = new Date("2026-09-21T08:00:00.000Z");
const oldAt = new Date("2025-09-01T08:00:00.000Z");
const context = (personId, subject, scope, extra = {}) => ({ personId, subject, scope, ...extra });
const draft = (name, size, hash = "a".repeat(64)) => ({ originalFilename: name, declaredMediaType: "application/pdf", declaredSizeBytes: size, expectedSha256: hash });
const receipt = (name, size, hash = "a".repeat(64)) => ({ purpose: "PAYMENT_RECEIPT", ...draft(name, size, hash) });

const markReady = async (pool, versionId, size, hash, time = at) => {
  await pool.query(
    `UPDATE finance_attachment_version
        SET status='READY',detected_media_type='application/pdf',actual_size_bytes=$2::bigint,sha256=$3,ready_at=$4::timestamptz
      WHERE id=$1::uuid`, [versionId, size, hash, time.toISOString()]
  );
};
const markFailed = async (pool, versionId) => {
  await pool.query("UPDATE finance_attachment_version SET status='FAILED',failure_code='TEST_FAILURE' WHERE id=$1::uuid", [versionId]);
};
const transitionPending = async (pool, documentId) => {
  await pool.query("UPDATE finance_document SET status='PENDING_TRANSFER',version=version+1,updated_at=$2::timestamptz WHERE id=$1::uuid", [documentId, at.toISOString()]);
};

/**
 * Version slots preserve every prior version. The test uses direct READY/FAILED transitions only
 * to isolate reservation/list behavior; binary upload has its own integration coverage.
 */
test("真实 PostgreSQL：附件槽版本、共同幂等与恢复列表保持不可变历史", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const { pool } = db;
  const ids = Object.fromEntries(["teacher", "other", "hqA", "hqB", "admin"].map((name) => [name, randomUUID()]));
  try {
    for (const [name, id] of Object.entries(ids)) {
      await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES ($1::uuid,$2,'合成人员','ACTIVE')", [id, `version-${name}`]);
    }
    const teacher = context(ids.teacher, "TEACHING_TEACHER", "CAMPUS", { campusId: randomUUID() });
    const other = context(ids.other, "ACADEMIC_PLANNER", "ASSOCIATED_TEACHERS");
    const hqA = context(ids.hqA, "HEADQUARTERS_FINANCE", "GLOBAL");
    const hqB = context(ids.hqB, "HEADQUARTERS_FINANCE", "GLOBAL");
    const admin = context(ids.admin, "SYSTEM_ADMIN", "GLOBAL");
    const drafts = new PostgresFinanceDraftService(pool);
    const attachments = new PostgresFinanceAttachmentService(pool);

    const document = await drafts.create(teacher, { kind: "REIMBURSEMENT" }, "version-draft", at);
    const v1 = await attachments.reserve(teacher, document.id, { purpose: "INVOICE", ...draft("v1.pdf", 10) }, "version-v1", at);
    await markReady(pool, v1.versionId, 10, "a".repeat(64));
    const v2 = await attachments.reserveNextVersion(teacher, v1.attachmentId, draft("v2.pdf", 11, "b".repeat(64)), "version-v2", at);
    assert.deepEqual({ attachmentId: v2.attachmentId, versionNo: v2.versionNo, replay: v2.replay }, { attachmentId: v1.attachmentId, versionNo: 2, replay: false });
    await markFailed(pool, v2.versionId);
    const v3 = await attachments.reserveNextVersion(teacher, v1.attachmentId, draft("v3.pdf", 12, "c".repeat(64)), "version-v3", at);
    assert.equal(v3.versionNo, 3);
    assert.equal((await pool.query("SELECT sha256 FROM finance_attachment_version WHERE id=$1::uuid", [v1.versionId])).rows[0].sha256, "a".repeat(64));
    assert.equal((await pool.query("SELECT status FROM finance_attachment_version WHERE id=$1::uuid", [v2.versionId])).rows[0].status, "FAILED");

    const replay = await attachments.reserveNextVersion(teacher, v1.attachmentId, draft("v3.pdf", 12, "c".repeat(64)), "version-v3", at);
    assert.deepEqual(replay, { ...v3, replay: true });
    await assert.rejects(attachments.reserveNextVersion(teacher, v1.attachmentId, draft("rewritten.pdf", 12, "c".repeat(64)), "version-v3", at), /IDEMPOTENCY_REPLAY/);
    await assert.rejects(attachments.reserve(teacher, document.id, { purpose: "INVOICE", ...draft("collision.pdf", 1) }, "version-v3", at), /IDEMPOTENCY_REPLAY/);

    const [sameOne, sameTwo] = await Promise.all([
      attachments.reserveNextVersion(teacher, v1.attachmentId, draft("same-key.pdf", 1, "d".repeat(64)), "version-same", at),
      attachments.reserveNextVersion(teacher, v1.attachmentId, draft("same-key.pdf", 1, "d".repeat(64)), "version-same", at)
    ]);
    assert.equal(sameOne.versionNo, 4);
    assert.equal(sameTwo.versionId, sameOne.versionId);
    assert.equal(sameTwo.versionNo, sameOne.versionNo);
    assert.deepEqual([sameOne.replay, sameTwo.replay].sort(), [false, true]);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM finance_attachment_version WHERE finance_attachment_id=$1::uuid", [v1.attachmentId])).rows[0].n, 4);

    const [parallelOne, parallelTwo] = await Promise.all([
      attachments.reserveNextVersion(teacher, v1.attachmentId, draft("v4.pdf", 1, "d".repeat(64)), "version-v4", at),
      attachments.reserveNextVersion(teacher, v1.attachmentId, draft("v5.pdf", 1, "e".repeat(64)), "version-v5", at)
    ]);
    assert.deepEqual([parallelOne.versionNo, parallelTwo.versionNo].sort((left, right) => left - right), [5, 6]);
    const parallel = [
      { result: parallelOne, originalFilename: "v4.pdf", expectedSha256: "d".repeat(64) },
      { result: parallelTwo, originalFilename: "v5.pdf", expectedSha256: "e".repeat(64) }
    ].sort((left, right) => left.result.versionNo - right.result.versionNo);

    const listed = await attachments.listDocument(teacher, document.id, at);
    assert.deepEqual(listed, {
      documentId: document.id,
      attachments: [{
        attachmentId: v1.attachmentId, purpose: "INVOICE", createdAt: v1.createdAt,
        versions: [
          { versionId: v1.versionId, versionNo: 1, status: "READY", originalFilename: "v1.pdf", declaredMediaType: "application/pdf", declaredSizeBytes: 10, expectedSha256: "a".repeat(64), createdAt: v1.createdAt },
          { versionId: v2.versionId, versionNo: 2, status: "FAILED", originalFilename: "v2.pdf", declaredMediaType: "application/pdf", declaredSizeBytes: 11, expectedSha256: "b".repeat(64), createdAt: v2.createdAt },
          { versionId: v3.versionId, versionNo: 3, status: "UPLOADING", originalFilename: "v3.pdf", declaredMediaType: "application/pdf", declaredSizeBytes: 12, expectedSha256: "c".repeat(64), createdAt: v3.createdAt },
          { versionId: sameOne.versionId, versionNo: 4, status: "UPLOADING", originalFilename: "same-key.pdf", declaredMediaType: "application/pdf", declaredSizeBytes: 1, expectedSha256: "d".repeat(64), createdAt: sameOne.createdAt },
          { versionId: parallel[0].result.versionId, versionNo: 5, status: "UPLOADING", originalFilename: parallel[0].originalFilename, declaredMediaType: "application/pdf", declaredSizeBytes: 1, expectedSha256: parallel[0].expectedSha256, createdAt: parallel[0].result.createdAt },
          { versionId: parallel[1].result.versionId, versionNo: 6, status: "UPLOADING", originalFilename: parallel[1].originalFilename, declaredMediaType: "application/pdf", declaredSizeBytes: 1, expectedSha256: parallel[1].expectedSha256, createdAt: parallel[1].result.createdAt }
        ]
      }]
    });
    await assert.rejects(attachments.listDocument(other, document.id, at), /FINANCE_DOCUMENT_NOT_FOUND/);

    const old = await drafts.create(teacher, { kind: "REIMBURSEMENT" }, "old-version-draft", oldAt);
    const oldVersion = await attachments.reserve(teacher, old.id, { purpose: "INVOICE", ...draft("old.pdf", 1) }, "old-version", oldAt);
    await assert.rejects(attachments.reserveNextVersion(teacher, oldVersion.attachmentId, draft("too-late.pdf", 1), "old-next", at), /FINANCE_ATTACHMENT_NOT_FOUND/);
    await assert.rejects(attachments.listDocument(teacher, old.id, at), /FINANCE_DOCUMENT_NOT_FOUND/);

    const submitted = await drafts.create(teacher, { kind: "WITHDRAWAL" }, "submitted-version-draft", at);
    const submittedV1 = await attachments.reserve(teacher, submitted.id, { purpose: "INVOICE", ...draft("submitted-v1.pdf", 1) }, "submitted-v1", at);
    await transitionPending(pool, submitted.id);
    await assert.rejects(attachments.reserveNextVersion(teacher, submittedV1.attachmentId, draft("submitted-v2.pdf", 1), "submitted-v2", at), /FINANCE_ATTACHMENT_NOT_READY/);

    const withdrawal = await drafts.create(teacher, { kind: "WITHDRAWAL" }, "receipt-version-draft", at);
    await transitionPending(pool, withdrawal.id);
    const receiptV1 = await attachments.reserve(hqA, withdrawal.id, receipt("receipt-v1.pdf", 3), "receipt-v1", at);
    await markReady(pool, receiptV1.versionId, 3, "a".repeat(64));
    const receiptV2 = await attachments.reserveNextVersion(hqB, receiptV1.attachmentId, draft("receipt-v2.pdf", 4, "b".repeat(64)), "receipt-v2", at);
    assert.equal(receiptV2.versionNo, 2);
    assert.equal((await pool.query("SELECT uploaded_by_person_id::text AS uploaded_by_person_id FROM finance_attachment_version WHERE id=$1::uuid", [receiptV2.versionId])).rows[0].uploaded_by_person_id, ids.hqB);
    assert.deepEqual(await attachments.reserveNextVersion(hqB, receiptV1.attachmentId, draft("receipt-v2.pdf", 4, "b".repeat(64)), "receipt-v2", at), { ...receiptV2, replay: true });
    let consumed = false;
    const forbiddenChunks = async function* () { consumed = true; yield Buffer.from("never read"); };
    const uploader = new PostgresFinanceAttachmentUploadService(pool, new Proxy({}, { get: () => { throw new Error("UNAUTHORIZED_STORAGE_ACCESS"); } }));
    await assert.rejects(uploader.upload(hqB, receiptV1.versionId, forbiddenChunks(), at), /FINANCE_ATTACHMENT_NOT_FOUND/);
    await assert.rejects(uploader.upload(hqA, receiptV2.versionId, forbiddenChunks(), at), /FINANCE_ATTACHMENT_NOT_FOUND/);
    assert.equal(consumed, false);
    // Metadata fixture: revisions belong to PENDING_TRANSFER; bind the chosen READY
    // version only after the transfer is recorded, exactly as the business service does.
    await pool.query("UPDATE finance_document SET status='TRANSFERRED',version=3 WHERE id=$1::uuid", [withdrawal.id]);
    await pool.query(
      "INSERT INTO finance_withdrawal_transfer(finance_document_id,transferred_by_person_id,transferred_at,created_at) VALUES($1,$2,$3,$3)",
      [withdrawal.id,ids.hqA,at.toISOString()]
    );
    await pool.query(
      `INSERT INTO finance_withdrawal_attachment_binding(finance_document_id,stage,purpose,finance_attachment_version_id,document_version,bound_by_person_id,bound_at,created_at)
       VALUES($1::uuid,'COMPLETION','PAYMENT_RECEIPT',$2::uuid,3,$3::uuid,$4::timestamptz,$4::timestamptz)`,
      [withdrawal.id,receiptV1.versionId,ids.hqA,at.toISOString()]
    );
    await assert.rejects(attachments.reserveNextVersion(hqB,receiptV1.attachmentId,draft("receipt-v3.pdf",1),"completed-revision",at),/FINANCE_ATTACHMENT_NOT_READY/);
    const hqList = await attachments.listDocument(admin, withdrawal.id, at);
    assert.deepEqual(hqList.attachments[0].versions[0].binding, { stage: "COMPLETION", documentVersion: 3, boundAt: at.toISOString() });
    assert.equal(hqList.attachments[0].versions[1].binding,undefined);

    const limitedDocument = await drafts.create(teacher, { kind: "REIMBURSEMENT" }, "limited-version-draft", at);
    const limited = new PostgresFinanceAttachmentService(pool, { maxFileBytes: 10, maxDocumentBytes: 10, maxActiveVersions: 2 });
    const limitedV1 = await limited.reserve(teacher, limitedDocument.id, { purpose: "INVOICE", ...draft("limited-v1.pdf", 10) }, "limited-v1", at);
    await markReady(pool, limitedV1.versionId, 10, "a".repeat(64));
    await assert.rejects(limited.reserveNextVersion(teacher, limitedV1.attachmentId, draft("limited-v2.pdf", 1), "limited-v2", at), /FINANCE_ATTACHMENT_LIMIT_EXCEEDED/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM finance_attachment_version WHERE finance_attachment_id=$1::uuid", [limitedV1.attachmentId])).rows[0].n, 1);
  } finally {
    await db.close();
  }
});
