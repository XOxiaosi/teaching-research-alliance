import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { LocalAttachmentStore } from "../../dist/local-attachment-store.js";
import { PostgresReimbursementSubmissionService } from "../../dist/postgres-reimbursement-submission-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const at = new Date("2026-09-21T09:00:00.000Z");
const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 91) });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const chunks = (bytes) => (async function* () { yield bytes; })();
const applicant = (personId, scope = "CAMPUS") => ({ subject: "TEACHING_TEACHER", personId, scope, campusId: scope === "CAMPUS" ? randomUUID() : undefined });
const addPerson = (pool, id, nickname) => pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,'合成人员','ACTIVE')", [id, nickname]);
const addAccount = async (pool, personId, status = "ACTIVE") => {
  const id = randomUUID();
  await pool.query("INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,'PERSON',$2::uuid,$3,$4)", [id, personId, `person:${personId}`, status]);
  await pool.query("INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1::uuid,20)", [id]);
  return id;
};
const addDocument = async (pool, personId, createdAt = at) => {
  const id = randomUUID();
  await pool.query("INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at) VALUES($1::uuid,$2::uuid,'REIMBURSEMENT','DRAFT',1,$3::timestamptz,$3::timestamptz)", [id, personId, createdAt.toISOString()]);
  return id;
};
const addReadyAttachment = async (pool, store, documentId, purpose, slotId = randomUUID(), versionNo = 1) => {
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
const addReadyPdfScreenshot = async (pool, store, documentId) => {
  const attachmentId = randomUUID(), versionId = randomUUID();
  const pdf = await PDFDocument.create(); pdf.addPage([8, 8]);
  const bytes = await pdf.save(); const sha = digest(bytes);
  await store.put({ versionId, originalFilename: "application-screenshot.pdf", declaredMediaType: "application/pdf", declaredSizeBytes: bytes.length, expectedSha256: sha }, chunks(bytes));
  await pool.query("INSERT INTO finance_attachment(id,finance_document_id,purpose,created_by_person_id,created_at) SELECT $1::uuid,$2::uuid,'APPLICATION_SCREENSHOT',applicant_person_id,$3::timestamptz FROM finance_document WHERE id=$2::uuid", [attachmentId, documentId, at.toISOString()]);
  await pool.query(
    `INSERT INTO finance_attachment_version(id,finance_attachment_id,version_no,status,original_filename,declared_media_type,declared_size_bytes,expected_sha256,detected_media_type,actual_size_bytes,sha256,uploaded_by_person_id,created_at,ready_at)
     SELECT $1::uuid,$2::uuid,1,'READY','application-screenshot.pdf','application/pdf',$3::bigint,$4,'application/pdf',$3::bigint,$4,applicant_person_id,$5::timestamptz,$5::timestamptz FROM finance_document WHERE id=$6::uuid`,
    [versionId, attachmentId, bytes.length, sha, at.toISOString(), documentId]
  );
  return versionId;
};
const addRequiredEvidence = async (pool, store, documentId) => {
  const supporting = await addReadyAttachment(pool, store, documentId, "SUPPORTING_DOCUMENT");
  const screenshot = await addReadyAttachment(pool, store, documentId, "APPLICATION_SCREENSHOT");
  return [supporting.versionId, screenshot.versionId];
};
const draft = (attachmentVersionIds, amountCents = "100", reason = "普通报销申请") => ({ expectedVersion: 1, amountCents, reason, attachmentVersionIds });

test("普通报销提交冻结本人目的账户、证据和上下文，不改变账本或余额", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-reimbursement-submit-"));
  try {
    const [personId, otherId] = [randomUUID(), randomUUID()];
    await addPerson(db.pool, personId, "reimbursement-applicant"); await addPerson(db.pool, otherId, "reimbursement-other");
    const destination = await addAccount(db.pool, personId);
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const service = new PostgresReimbursementSubmissionService(db.pool, store);
    const documentId = await addDocument(db.pool, personId), evidence = await addRequiredEvidence(db.pool, store, documentId);
    const context = applicant(personId);
    const before = await db.pool.query("SELECT balance_cents::text AS balance FROM account_balance_projection WHERE account_id=$1::uuid", [destination]);
    const submitted = await service.submit(context, documentId, draft(evidence), "submit", at);
    assert.deepEqual(submitted, { id: documentId, status: "PENDING_APPROVAL", version: 2, replay: false });
    assert.deepEqual(await service.submit(context, documentId, draft([...evidence].reverse()), "submit", new Date("2027-09-01T00:00:00Z")), { ...submitted, replay: true });
    await assert.rejects(service.submit(context, documentId, draft(evidence, "101"), "submit", at), /IDEMPOTENCY_REPLAY/);
    const submission = (await db.pool.query("SELECT source_document_version::text AS source,result_document_version::text AS result,destination_account_id::text AS destination,amount_cents::text AS amount,reason,applicant_context_snapshot FROM finance_reimbursement_submission WHERE finance_document_id=$1::uuid", [documentId])).rows[0];
    assert.deepEqual([submission.source, submission.result, submission.destination, submission.amount, submission.reason], ["1", "2", destination, "100", "普通报销申请"]);
    assert.equal(submission.applicant_context_snapshot.applicantPersonId, personId);
    assert.equal(submission.applicant_context_snapshot.applicantContextScope, "CAMPUS");
    assert.equal(submission.applicant_context_snapshot.applicantContextRegionId, null);
    assert.equal(submission.applicant_context_snapshot.destinationAccountId, destination);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM finance_reimbursement_attachment_binding WHERE finance_document_id=$1::uuid", [documentId])).rows[0].count, 2);
    assert.deepEqual(await db.pool.query("SELECT balance_cents::text AS balance FROM account_balance_projection WHERE account_id=$1::uuid", [destination]), before);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM ledger_event")).rows[0].count, 0);
    await assert.rejects(db.pool.query("UPDATE finance_reimbursement_submission SET amount_cents=101 WHERE finance_document_id=$1::uuid", [documentId]), /FINANCE_REIMBURSEMENT_IMMUTABLE/);
    await assert.rejects(db.pool.query("INSERT INTO finance_reimbursement_attachment_binding(finance_document_id,stage,purpose,finance_attachment_version_id,document_version,bound_by_person_id,bound_at,created_at) VALUES($1::uuid,'SUBMISSION','SUPPORTING_DOCUMENT',$2::uuid,2,$3::uuid,$4::timestamptz,$4::timestamptz)", [documentId, evidence[0], personId, at.toISOString()]), /FINANCE_REIMBURSEMENT_ATTACHMENT_INVALID/);
    await assert.rejects(service.submit(applicant(otherId), documentId, draft(evidence), "other", at), /FINANCE_DOCUMENT_NOT_FOUND/);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("普通报销只需一张完整申请截图，也可冻结多张截图", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-reimbursement-submit-p43-"));
  try {
    const personId = randomUUID(); await addPerson(db.pool, personId, "reimbursement-p43"); await addAccount(db.pool, personId);
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const service = new PostgresReimbursementSubmissionService(db.pool, store), context = applicant(personId, "SELF");
    const singleDocument = await addDocument(db.pool, personId);
    const single = await addReadyAttachment(db.pool, store, singleDocument, "APPLICATION_SCREENSHOT");
    assert.equal((await service.submit(context, singleDocument, draft([single.versionId]), "p43-single", at)).status, "PENDING_APPROVAL");
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM finance_reimbursement_attachment_binding WHERE finance_document_id=$1::uuid", [singleDocument])).rows[0].count, 1);

    const multipleDocument = await addDocument(db.pool, personId);
    const screenshots = await Promise.all([
      addReadyAttachment(db.pool, store, multipleDocument, "APPLICATION_SCREENSHOT"),
      addReadyAttachment(db.pool, store, multipleDocument, "APPLICATION_SCREENSHOT"),
    ]);
    assert.equal((await service.submit(context, multipleDocument, draft(screenshots.map((attachment) => attachment.versionId)), "p43-multiple", at)).status, "PENDING_APPROVAL");
    const bindings = await db.pool.query(
      "SELECT purpose FROM finance_reimbursement_attachment_binding WHERE finance_document_id=$1::uuid ORDER BY purpose",
      [multipleDocument]
    );
    assert.deepEqual(bindings.rows.map((binding) => binding.purpose), ["APPLICATION_SCREENSHOT", "APPLICATION_SCREENSHOT"]);

    const pdfDocument = await addDocument(db.pool, personId);
    const pdfScreenshot = await addReadyPdfScreenshot(db.pool, store, pdfDocument);
    await assert.rejects(service.submit(context, pdfDocument, draft([pdfScreenshot]), "p43-pdf", at), /FINANCE_ATTACHMENT_NOT_READY/);
    assert.equal((await db.pool.query("SELECT status FROM finance_document WHERE id=$1::uuid", [pdfDocument])).rows[0].status, "DRAFT");
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("普通报销拒绝缺证据、同槽多版本和非本人当前财年，失败不留下部分申请", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-reimbursement-submit-invalid-"));
  try {
    const personId = randomUUID(); await addPerson(db.pool, personId, "reimbursement-invalid"); await addAccount(db.pool, personId);
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const service = new PostgresReimbursementSubmissionService(db.pool, store), context = applicant(personId, "SELF");
    const missing = await addDocument(db.pool, personId); const onlySupporting = await addReadyAttachment(db.pool, store, missing, "SUPPORTING_DOCUMENT");
    await assert.rejects(service.submit(context, missing, draft([onlySupporting.versionId]), "missing", at), /FINANCE_ATTACHMENT_NOT_READY/);
    assert.equal((await db.pool.query("SELECT status FROM finance_document WHERE id=$1::uuid", [missing])).rows[0].status, "DRAFT");
    const duplicate = await addDocument(db.pool, personId);
    const supportOne = await addReadyAttachment(db.pool, store, duplicate, "SUPPORTING_DOCUMENT");
    const supportTwo = await addReadyAttachment(db.pool, store, duplicate, "SUPPORTING_DOCUMENT", supportOne.slotId, 2);
    const screen = await addReadyAttachment(db.pool, store, duplicate, "APPLICATION_SCREENSHOT");
    await assert.rejects(service.submit(context, duplicate, draft([supportOne.versionId, supportTwo.versionId, screen.versionId]), "same-slot", at), /FINANCE_ATTACHMENT_NOT_READY/);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM finance_reimbursement_submission WHERE finance_document_id=$1::uuid", [duplicate])).rows[0].count, 0);
    const concurrent = await addDocument(db.pool, personId); const concurrentEvidence = await addRequiredEvidence(db.pool, store, concurrent);
    const concurrentResults = await Promise.all([
      service.submit(context, concurrent, draft(concurrentEvidence), "concurrent", at),
      service.submit(context, concurrent, draft([...concurrentEvidence].reverse()), "concurrent", at)
    ]);
    assert.equal(new Set(concurrentResults.map((value) => value.id)).size, 1);
    assert.deepEqual(concurrentResults.map((value) => value.replay).sort(), [false, true]);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM finance_reimbursement_submission WHERE finance_document_id=$1::uuid", [concurrent])).rows[0].count, 1);
    const old = await addDocument(db.pool, personId, new Date("2025-09-01T00:00:00Z")); const oldEvidence = await addRequiredEvidence(db.pool, store, old);
    await assert.rejects(service.submit(context, old, draft(oldEvidence), "old", at), /FINANCE_DOCUMENT_NOT_FOUND/);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("0020 升级保留 0019 已完成和已撤销的本人采买状态", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL, { throughMigration: 19 });
  try {
    const personId = randomUUID(); await addPerson(db.pool, personId, "reimbursement-upgrade-owner");
    const completedId = randomUUID(), reversedId = randomUUID();
    for (const [id, status] of [[completedId, "COMPLETED"], [reversedId, "REVERSED"]]) {
      await db.pool.query("INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at) VALUES($1::uuid,$2::uuid,'SELF_PURCHASE',$3,3,$4::timestamptz,$4::timestamptz)", [id, personId, status, at.toISOString()]);
    }
    await db.pool.query(await readFile(new URL("../../../../database/migrations/0020_finance_reimbursement_review.sql", import.meta.url), "utf8"));
    const statuses = await db.pool.query("SELECT id::text AS id,status FROM finance_document WHERE id=ANY($1::uuid[]) ORDER BY id", [[completedId, reversedId]]);
    assert.deepEqual(new Map(statuses.rows.map((row) => [row.id, row.status])), new Map([[completedId, "COMPLETED"], [reversedId, "REVERSED"]]));
  } finally { await db.close(); }
});
