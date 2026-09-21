import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, open, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PDFDocument } from "pdf-lib";
import { PostgresFinanceAttachmentService } from "../../dist/postgres-finance-attachment-service.js";
import { PostgresFinanceAttachmentUploadService } from "../../dist/postgres-finance-attachment-upload-service.js";
import { LocalAttachmentStore } from "../../dist/local-attachment-store.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const at = new Date("2026-09-21T05:00:00.000Z");
const contextFor = (personId, subject = "TEACHING_TEACHER") => ({ personId, subject });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
const makePdf = async () => {
  const document = await PDFDocument.create();
  document.addPage([200, 200]);
  return Buffer.from(await document.save());
};
const trackedChunks = (bytes, tracker) => (async function* () {
  tracker.count++;
  yield bytes;
})();
const unreadChunks = (tracker) => (async function* () {
  tracker.count++;
  throw new Error("CHUNKS_MUST_NOT_BE_READ");
})();

const addDocument = async (pool, personId) => {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at) VALUES ($1::uuid,$2::uuid,'REIMBURSEMENT','DRAFT',1,$3::timestamptz,$3::timestamptz)",
    [id, personId, at.toISOString()]
  );
  return id;
};
const reserve = async (attachments, context, documentId, bytes, key, overrides = {}) => attachments.reserve(context, documentId, {
  purpose: "SUPPORTING_DOCUMENT",
  originalFilename: "receipt.bin",
  declaredMediaType: "image/png",
  declaredSizeBytes: bytes.length,
  expectedSha256: sha256(bytes),
  ...overrides
}, key, at);
const eventCount = async (pool, versionId, eventType) => Number((await pool.query(
  "SELECT count(*)::int AS n FROM finance_attachment_event WHERE finance_attachment_version_id=$1::uuid AND event_type=$2",
  [versionId, eventType]
)).rows[0].n);

test("真实 PostgreSQL 上传完成 PNG/PDF；重复与并发仅记录一次 READY，且不入账", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-attachment-upload-"));
  const { pool } = db;
  const personId = randomUUID();
  try {
    await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES ($1::uuid,'upload-owner','合成人员','ACTIVE')", [personId]);
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const attachments = new PostgresFinanceAttachmentService(pool);
    const uploader = new PostgresFinanceAttachmentUploadService(pool, store);
    const context = contextFor(personId);
    const documentId = await addDocument(pool, personId);
    const pngVersion = await reserve(attachments, context, documentId, png, "upload-png");
    const firstTracker = { count: 0 };
    const first = await uploader.upload(context, pngVersion.versionId, trackedChunks(png, firstTracker), at);
    assert.deepEqual(first, {
      versionId: pngVersion.versionId,
      status: "READY",
      detectedMediaType: "image/png",
      actualSizeBytes: png.length,
      sha256: sha256(png),
      readyAt: at.toISOString(),
      replay: false
    });
    assert.equal(firstTracker.count, 1);
    const replayTracker = { count: 0 };
    assert.deepEqual(await uploader.upload(context, pngVersion.versionId, unreadChunks(replayTracker), at), { ...first, replay: true });
    assert.equal(replayTracker.count, 0);
    assert.equal(await eventCount(pool, pngVersion.versionId, "READY"), 1);

    const pdf = await makePdf();
    const pdfVersion = await reserve(attachments, context, documentId, pdf, "upload-pdf", {
      originalFilename: "receipt.pdf",
      declaredMediaType: "application/pdf",
      declaredSizeBytes: pdf.length,
      expectedSha256: sha256(pdf)
    });
    const pdfResult = await uploader.upload(context, pdfVersion.versionId, trackedChunks(pdf, { count: 0 }), at);
    assert.equal(pdfResult.detectedMediaType, "application/pdf");
    assert.equal(pdfResult.actualSizeBytes, pdf.length);

    const concurrent = await reserve(attachments, context, documentId, png, "upload-concurrent");
    const race = await Promise.all([
      uploader.upload(context, concurrent.versionId, trackedChunks(png, { count: 0 }), at),
      uploader.upload(context, concurrent.versionId, trackedChunks(png, { count: 0 }), at)
    ]);
    assert.equal(race.filter((result) => !result.replay).length, 1);
    assert.equal(race.filter((result) => result.replay).length, 1);
    assert.equal(await eventCount(pool, concurrent.versionId, "READY"), 1);
    assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM ledger_event")).rows[0].n), 0);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("上传拒绝越权且不读流；格式、哈希失败终结为 FAILED 且没有永久对象", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-attachment-upload-"));
  const { pool } = db;
  const [ownerId, otherId] = [randomUUID(), randomUUID()];
  try {
    for (const id of [ownerId, otherId]) await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES ($1::uuid,$2,'合成人员','ACTIVE')", [id, `upload-${id}`]);
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const attachments = new PostgresFinanceAttachmentService(pool);
    const uploader = new PostgresFinanceAttachmentUploadService(pool, store);
    const owner = contextFor(ownerId);
    const documentId = await addDocument(pool, ownerId);
    const owned = await reserve(attachments, owner, documentId, png, "upload-owner-check");
    const denied = { count: 0 };
    await assert.rejects(uploader.upload(contextFor(otherId), owned.versionId, unreadChunks(denied), at), /FINANCE_ATTACHMENT_NOT_FOUND/);
    assert.equal(denied.count, 0);

    const invalidPdf = Buffer.from("%PDF-1.7\nnot a document\n%%EOF");
    const malformed = await reserve(attachments, owner, documentId, invalidPdf, "upload-malformed", {
      originalFilename: "bad.pdf",
      declaredMediaType: "application/pdf",
      declaredSizeBytes: invalidPdf.length,
      expectedSha256: sha256(invalidPdf)
    });
    await assert.rejects(uploader.upload(owner, malformed.versionId, trackedChunks(invalidPdf, { count: 0 }), at), /FINANCE_ATTACHMENT_UPLOAD_FAILED/);
    assert.deepEqual((await pool.query("SELECT status,failure_code FROM finance_attachment_version WHERE id=$1::uuid", [malformed.versionId])).rows[0], {
      status: "FAILED", failure_code: "UPLOAD_VALIDATION_FAILED"
    });
    assert.equal(await eventCount(pool, malformed.versionId, "FAILED"), 1);
    assert.equal((await readdir(join(root, "objects"))).includes(malformed.versionId), false);
    const failedRetry = { count: 0 };
    await assert.rejects(uploader.upload(owner, malformed.versionId, unreadChunks(failedRetry), at), /FINANCE_ATTACHMENT_FAILED/);
    assert.equal(failedRetry.count, 0);

    const hashMismatch = await reserve(attachments, owner, documentId, png, "upload-hash-mismatch", { expectedSha256: "a".repeat(64) });
    await assert.rejects(uploader.upload(owner, hashMismatch.versionId, trackedChunks(png, { count: 0 }), at), /FINANCE_ATTACHMENT_UPLOAD_FAILED/);
    assert.deepEqual((await pool.query("SELECT status,failure_code FROM finance_attachment_version WHERE id=$1::uuid", [hashMismatch.versionId])).rows[0], {
      status: "FAILED", failure_code: "UPLOAD_VALIDATION_FAILED"
    });
    assert.equal((await readdir(join(root, "objects"))).includes(hashMismatch.versionId), false);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("数据库完成失败后原件可恢复；READY 原件缺失或篡改不会伪装为重放成功", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-attachment-upload-"));
  const { pool } = db;
  const personId = randomUUID();
  try {
    await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES ($1::uuid,'recover-owner','合成人员','ACTIVE')", [personId]);
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const attachments = new PostgresFinanceAttachmentService(pool);
    const uploader = new PostgresFinanceAttachmentUploadService(pool, store);
    const context = contextFor(personId);
    const documentId = await addDocument(pool, personId);
    const recover = await reserve(attachments, context, documentId, png, "upload-recover");
    await pool.query("CREATE FUNCTION fail_ready_attachment_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='READY' THEN RAISE EXCEPTION 'FORCED_READY_EVENT_FAILURE'; END IF; RETURN NEW; END; $$");
    await pool.query("CREATE TRIGGER fail_ready_attachment_event BEFORE INSERT ON finance_attachment_event FOR EACH ROW EXECUTE FUNCTION fail_ready_attachment_event()");
    await assert.rejects(uploader.upload(context, recover.versionId, trackedChunks(png, { count: 0 }), at), /FORCED_READY_EVENT_FAILURE/);
    await pool.query("DROP TRIGGER fail_ready_attachment_event ON finance_attachment_event");
    assert.equal((await pool.query("SELECT status FROM finance_attachment_version WHERE id=$1::uuid", [recover.versionId])).rows[0].status, "UPLOADING");
    await store.readVerified({ versionId: recover.versionId, mediaType: "image/png", sizeBytes: png.length, sha256: sha256(png) });
    const recoveryReplay = { count: 0 };
    const recovered = await uploader.upload(context, recover.versionId, unreadChunks(recoveryReplay), at);
    assert.equal(recovered.replay, false);
    assert.equal(recoveryReplay.count, 0);
    assert.equal(await eventCount(pool, recover.versionId, "READY"), 1);

    const missing = await reserve(attachments, context, documentId, png, "upload-missing");
    await uploader.upload(context, missing.versionId, trackedChunks(png, { count: 0 }), at);
    await unlink(join(root, "objects", missing.versionId));
    const missingRetry = { count: 0 };
    await assert.rejects(uploader.upload(context, missing.versionId, unreadChunks(missingRetry), at), /ATTACHMENT_INTEGRITY_FAILED/);
    assert.equal(missingRetry.count, 0);

    const tampered = await reserve(attachments, context, documentId, png, "upload-tampered");
    await uploader.upload(context, tampered.versionId, trackedChunks(png, { count: 0 }), at);
    await writeFile(join(root, "objects", tampered.versionId), Buffer.from("tampered"));
    const tamperedRetry = { count: 0 };
    await assert.rejects(uploader.upload(context, tampered.versionId, unreadChunks(tamperedRetry), at), /ATTACHMENT_INTEGRITY_FAILED/);
    assert.equal(tamperedRetry.count, 0);
    assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM ledger_event")).rows[0].n), 0);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("READY 重放只校验原件完整性；流校验失败与基础设施失败采用不同终结策略", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-attachment-upload-"));
  const { pool } = db;
  const personId = randomUUID();
  try {
    await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES ($1::uuid,'failure-owner','合成人员','ACTIVE')", [personId]);
    const sourceRoot = resolve(import.meta.dirname, "../../../..");
    const normalStore = await LocalAttachmentStore.create(root, sourceRoot);
    const attachments = new PostgresFinanceAttachmentService(pool);
    const normalUploader = new PostgresFinanceAttachmentUploadService(pool, normalStore);
    const context = contextFor(personId);
    const documentId = await addDocument(pool, personId);

    const syntacticOnlyPng = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("not-a-valid-png")]);
    const legacyReady = await reserve(attachments, context, documentId, syntacticOnlyPng, "ready-integrity-only");
    await normalStore.put({
      versionId: legacyReady.versionId,
      originalFilename: "legacy.png",
      declaredMediaType: "image/png",
      declaredSizeBytes: syntacticOnlyPng.length,
      expectedSha256: sha256(syntacticOnlyPng)
    }, trackedChunks(syntacticOnlyPng, { count: 0 }));
    await pool.query(
      "UPDATE finance_attachment_version SET status='READY',detected_media_type='image/png',actual_size_bytes=$2::bigint,sha256=$3,ready_at=$4::timestamptz WHERE id=$1::uuid",
      [legacyReady.versionId, syntacticOnlyPng.length, sha256(syntacticOnlyPng), at.toISOString()]
    );
    const readyReplayTracker = { count: 0 };
    assert.equal((await normalUploader.upload(context, legacyReady.versionId, unreadChunks(readyReplayTracker), at)).replay, true);
    assert.equal(readyReplayTracker.count, 0);

    const interrupted = await reserve(attachments, context, documentId, png, "stream-interrupted");
    const interruptedChunks = (async function* () {
      throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    })();
    await assert.rejects(normalUploader.upload(context, interrupted.versionId, interruptedChunks, at), /FINANCE_ATTACHMENT_UPLOAD_FAILED/);
    assert.deepEqual((await pool.query("SELECT status,failure_code FROM finance_attachment_version WHERE id=$1::uuid", [interrupted.versionId])).rows[0], {
      status: "FAILED", failure_code: "UPLOAD_VALIDATION_FAILED"
    });

    let injectedCode = "ENOSPC";
    const failingOpen = async (path, flags, ...rest) => {
      if ((flags & constants.O_WRONLY) === constants.O_WRONLY) {
        const error = Object.assign(new Error(injectedCode), { code: injectedCode });
        throw error;
      }
      return open(path, flags, ...rest);
    };
    const failingStore = await LocalAttachmentStore.create(join(root, "failing"), sourceRoot, 20 * 1024 * 1024, failingOpen);
    const failingUploader = new PostgresFinanceAttachmentUploadService(pool, failingStore);
    const storage = await reserve(attachments, context, documentId, png, "storage-unavailable");
    for (const code of ["ENOSPC", "EACCES", "EIO"]) {
      injectedCode = code;
      await assert.rejects(failingUploader.upload(context, storage.versionId, trackedChunks(png, { count: 0 }), at), /ATTACHMENT_STORAGE_UNAVAILABLE/);
      assert.equal((await pool.query("SELECT status FROM finance_attachment_version WHERE id=$1::uuid", [storage.versionId])).rows[0].status, "UPLOADING");
      assert.equal(await eventCount(pool, storage.versionId, "FAILED"), 0);
    }
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});
