import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PDFDocument } from "pdf-lib";
import { LocalAttachmentStore } from "../../dist/local-attachment-store.js";
import { PostgresFinanceAttachmentReadService } from "../../dist/postgres-finance-attachment-read-service.js";
import { PostgresFinanceAttachmentService } from "../../dist/postgres-finance-attachment-service.js";
import { PostgresFinanceAttachmentUploadService } from "../../dist/postgres-finance-attachment-upload-service.js";
import { PostgresFinanceDraftService } from "../../dist/postgres-finance-draft-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const at = new Date("2026-09-21T08:00:00.000Z");
const sourceRoot = resolve(import.meta.dirname, "../../../..");
const context = (personId, subject, scope, extra = {}) => ({ personId, subject, ...(scope === undefined ? {} : { scope }), ...extra });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const chunks = async function* (bytes) { yield bytes; };
/** Fails immediately if an upload denial tries to lease a second connection before releasing its first transaction. */
const oneConnectionPool = (pool) => {
  let checkedOut = 0;
  return {
    connect: async () => {
      assert.equal(checkedOut, 0, "上传拒绝审计不得在业务连接仍占用时再申请连接");
      const client = await pool.connect();
      checkedOut += 1;
      let released = false;
      return {
        query: (sql, values) => client.query(sql, values),
        release: async () => {
          if (!released) {
            released = true;
            checkedOut -= 1;
            client.release();
          }
        }
      };
    }
  };
};
const receiptDraft = (bytes) => ({
  purpose: "PAYMENT_RECEIPT",
  originalFilename: "付款回执.pdf",
  declaredMediaType: "application/pdf",
  declaredSizeBytes: bytes.length,
  expectedSha256: sha256(bytes)
});
const supportingDraft = (bytes) => ({ ...receiptDraft(bytes), purpose: "SUPPORTING_DOCUMENT" });

const createPdf = async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  return Buffer.from(await pdf.save());
};

const transitionToPending = async (pool, documentId) => {
  await pool.query(
    "UPDATE finance_document SET status='PENDING_TRANSFER',version=version+1,updated_at=$2::timestamptz WHERE id=$1::uuid",
    [documentId, at.toISOString()]
  );
};

test("真实 PostgreSQL：GLOBAL 总部财务独占待转账回执，个人和全局只读均受边界约束", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-finance-receipt-"));
  const { pool } = db;
  const ids = Object.fromEntries(["applicant", "other", "hqA", "hqB", "region", "admin", "owner"].map((name) => [name, randomUUID()]));
  try {
    for (const [name, id] of Object.entries(ids)) {
      await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES ($1::uuid,$2,'合成人员','ACTIVE')", [id, `receipt-${name}-${id}`]);
    }
    const applicant = context(ids.applicant, "TEACHING_TEACHER", "SELF");
    const other = context(ids.other, "TEACHING_TEACHER", "SELF");
    const hqA = context(ids.hqA, "HEADQUARTERS_FINANCE", "GLOBAL");
    const hqB = context(ids.hqB, "HEADQUARTERS_FINANCE", "GLOBAL");
    const hqSelf = context(ids.hqA, "HEADQUARTERS_FINANCE", "SELF");
    const hqRegion = context(ids.region, "HEADQUARTERS_FINANCE", "REGION", { regionId: randomUUID() });
    const admin = context(ids.admin, "SYSTEM_ADMIN", "GLOBAL");
    const owner = context(ids.owner, "SYSTEM_OWNER", "GLOBAL");
    const bytes = await createPdf();
    const store = await LocalAttachmentStore.create(root, sourceRoot);
    const drafts = new PostgresFinanceDraftService(pool);
    const attachments = new PostgresFinanceAttachmentService(pool, {
      maxFileBytes: bytes.length,
      maxDocumentBytes: bytes.length,
      maxActiveVersions: 1
    });
    const uploader = new PostgresFinanceAttachmentUploadService(oneConnectionPool(pool), store);
    const reader = new PostgresFinanceAttachmentReadService(pool, store);
    const ledgerBefore = (await pool.query("SELECT count(*)::int AS n FROM ledger_event")).rows[0].n;

    const withdrawal = await drafts.create(applicant, { kind: "WITHDRAWAL" }, "receipt-draft", at);
    const applicationEvidence = await attachments.reserve(applicant, withdrawal.id, supportingDraft(bytes), "application-evidence", at);
    await transitionToPending(pool, withdrawal.id);
    const receipt = await attachments.reserve(hqA, withdrawal.id, receiptDraft(bytes), "payment-receipt", at);
    await assert.rejects(
      attachments.reserve(hqA, withdrawal.id, receiptDraft(bytes), "payment-receipt-over-budget", at),
      /FINANCE_ATTACHMENT_LIMIT_EXCEEDED/
    );
    assert.equal(applicationEvidence.purpose, "SUPPORTING_DOCUMENT", "申请阶段额度满不阻塞独立的回执阶段");

    let forbiddenInputConsumed = false;
    const forbiddenInput = async function* () { forbiddenInputConsumed = true; yield bytes; };
    await assert.rejects(uploader.upload(hqRegion, receipt.versionId, forbiddenInput(), at), /FORBIDDEN_SCOPE/);
    assert.equal(forbiddenInputConsumed, false, "非法总部范围在查询文档和读取上传流之前拒绝");
    await assert.rejects(uploader.upload(applicant, receipt.versionId, chunks(bytes), at), /FINANCE_ATTACHMENT_NOT_FOUND/);
    await assert.rejects(uploader.upload(hqB, receipt.versionId, chunks(bytes), at), /FINANCE_ATTACHMENT_NOT_FOUND/);
    await assert.rejects(attachments.reserve(hqSelf, withdrawal.id, receiptDraft(bytes), "hq-self", at), /FORBIDDEN_SCOPE/);
    await assert.rejects(attachments.reserve(hqRegion, withdrawal.id, receiptDraft(bytes), "hq-region", at), /FORBIDDEN_SCOPE/);
    await assert.rejects(attachments.reserve(applicant, withdrawal.id, receiptDraft(bytes), "personal-receipt", at), /FORBIDDEN_SCOPE/);

    const ready = await uploader.upload(hqA, receipt.versionId, chunks(bytes), at);
    assert.equal(ready.status, "READY");
    assert.deepEqual(await reader.readOwn(applicant, receipt.versionId, at), {
      bytes,
      mediaType: "application/pdf",
      originalFilename: "付款回执.pdf",
      sha256: sha256(bytes),
      sizeBytes: bytes.length
    });
    assert.equal((await attachments.getOwnVersion(admin, receipt.versionId, at)).status, "READY");
    assert.equal((await reader.readOwn(owner, receipt.versionId, at)).sizeBytes, bytes.length);
    await assert.rejects(attachments.getOwnVersion(hqRegion, receipt.versionId, at), /FORBIDDEN_SCOPE/);
    await assert.rejects(reader.readOwn(hqRegion, receipt.versionId, at), /FORBIDDEN_SCOPE/);
    await assert.rejects(reader.readOwn(other, receipt.versionId, at), /FINANCE_ATTACHMENT_NOT_FOUND/);
    await assert.rejects(attachments.reserve(admin, withdrawal.id, receiptDraft(bytes), "admin-write", at), /FORBIDDEN_SCOPE/);

    const blocked = await drafts.create(applicant, { kind: "WITHDRAWAL" }, "blocked-receipt-draft", at);
    await transitionToPending(pool, blocked.id);
    const blockedReceipt = await attachments.reserve(hqA, blocked.id, receiptDraft(bytes), "blocked-receipt", at);
    await pool.query(
      "UPDATE finance_document SET status='TRANSFERRED',version=version+1,updated_at=$2::timestamptz WHERE id=$1::uuid",
      [blocked.id, at.toISOString()]
    );
    await assert.rejects(uploader.upload(hqA, blockedReceipt.versionId, chunks(bytes), at), /FINANCE_ATTACHMENT_NOT_READY/);

    const audit = await pool.query(
      "SELECT actor_person_id::text AS actor_person_id,action_code,subject_id::text AS subject_id,after_json,reason FROM audit_event WHERE subject_type='FINANCE_ATTACHMENT_VERSION' ORDER BY created_at,id"
    );
    assert.ok(audit.rows.some((row) => row.action_code === "ATTACHMENT_DOWNLOAD_SUCCEEDED" && row.reason === "READY_OBJECT_VERIFIED"));
    assert.ok(audit.rows.some((row) => row.action_code === "ATTACHMENT_DOWNLOAD_DENIED" && row.reason === "NOT_FOUND_OR_FORBIDDEN"));
    assert.ok(audit.rows.some((row) => row.action_code === "ATTACHMENT_DOWNLOAD_DENIED" && row.reason === "FORBIDDEN_SCOPE"));
    assert.deepEqual(audit.rows.find((row) => row.action_code === "ATTACHMENT_UPLOAD_DENIED" && row.reason === "FORBIDDEN_SCOPE"), {
      actor_person_id: ids.region, action_code: "ATTACHMENT_UPLOAD_DENIED", subject_id: receipt.versionId, after_json: {}, reason: "FORBIDDEN_SCOPE"
    });
    assert.ok(audit.rows.some((row) => row.action_code === "ATTACHMENT_UPLOAD_DENIED" && row.reason === "FINANCE_ATTACHMENT_NOT_FOUND"));
    assert.ok(audit.rows.some((row) => row.action_code === "ATTACHMENT_UPLOAD_DENIED" && row.reason === "FINANCE_ATTACHMENT_NOT_READY"));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM ledger_event")).rows[0].n, ledgerBefore);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("个人附件按北京财年隔离，GLOBAL 读取不受历史归档影响", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-finance-year-"));
  const { pool } = db;
  const applicantId = randomUUID();
  const adminId = randomUUID();
  const oldAt = new Date("2025-09-01T00:00:00.000Z");
  try {
    for (const [id, nickname] of [[applicantId, "finance-year-applicant"], [adminId, "finance-year-admin"]]) {
      await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES ($1::uuid,$2,'合成人员','ACTIVE')", [id, nickname]);
    }
    const applicant = context(applicantId, "TEACHING_TEACHER", "SELF");
    const admin = context(adminId, "SYSTEM_ADMIN", "GLOBAL");
    const bytes = await createPdf();
    const store = await LocalAttachmentStore.create(root, sourceRoot);
    const attachments = new PostgresFinanceAttachmentService(pool);
    const uploader = new PostgresFinanceAttachmentUploadService(pool, store);
    const reader = new PostgresFinanceAttachmentReadService(pool, store);
    const drafts = new PostgresFinanceDraftService(pool);
    const historical = await drafts.create(applicant, { kind: "REIMBURSEMENT" }, "historical-draft", oldAt);
    const reserved = await attachments.reserve(applicant, historical.id, supportingDraft(bytes), "historical-attachment", oldAt);
    await uploader.upload(applicant, reserved.versionId, chunks(bytes), oldAt);

    await assert.rejects(attachments.getOwnVersion(applicant, reserved.versionId, at), /FINANCE_ATTACHMENT_NOT_FOUND/);
    await assert.rejects(reader.readOwn(applicant, reserved.versionId, at), /FINANCE_ATTACHMENT_NOT_FOUND/);
    await assert.rejects(uploader.upload(applicant, reserved.versionId, chunks(bytes), at), /FINANCE_ATTACHMENT_NOT_FOUND/);
    assert.equal((await attachments.getOwnVersion(admin, reserved.versionId, at)).status, "READY");
    assert.equal((await reader.readOwn(admin, reserved.versionId, at)).sizeBytes, bytes.length);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});
