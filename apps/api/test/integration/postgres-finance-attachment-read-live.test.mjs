import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PDFDocument } from "pdf-lib";
import { LocalAttachmentStore } from "../../dist/local-attachment-store.js";
import { validateAttachmentFormat } from "../../dist/attachment-format-validator.js";
import { PostgresFinanceAttachmentService } from "../../dist/postgres-finance-attachment-service.js";
import { PostgresFinanceAttachmentReadService } from "../../dist/postgres-finance-attachment-read-service.js";
import { PostgresFinanceDraftService } from "../../dist/postgres-finance-draft-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const at = new Date("2026-09-21T08:00:00.000Z");
const sourceRoot = resolve(import.meta.dirname, "../../..");
const contextFor = (personId, subject = "TEACHING_TEACHER") => ({ personId, subject });

async function* chunks(bytes) {
  yield bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2)));
  yield bytes.subarray(Math.max(1, Math.floor(bytes.length / 2)));
}

const createPdf = async () => {
  const document = await PDFDocument.create();
  document.addPage([200, 200]);
  return Buffer.from(await document.save());
};

test("本人只读已就绪附件，拒绝越权和未就绪，并将下载审计持久化", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-attachment-read-"));
  const { pool } = db;
  const [ownerId, otherId] = [randomUUID(), randomUUID()];
  try {
    for (const id of [ownerId, otherId]) {
      await pool.query(
        "INSERT INTO person(id,nickname,legal_name,status) VALUES ($1::uuid,$2,'合成人员','ACTIVE')",
        [id, `attachment-read-${id}`]
      );
    }
    const store = await LocalAttachmentStore.create(root, sourceRoot);
    const drafts = new PostgresFinanceDraftService(pool);
    const reservations = new PostgresFinanceAttachmentService(pool);
    const document = await drafts.create(contextFor(ownerId), { kind: "REIMBURSEMENT" }, "read-document", at);
    const bytes = await createPdf();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const reserved = await reservations.reserve(contextFor(ownerId), document.id, {
      purpose: "SUPPORTING_DOCUMENT",
      originalFilename: "合成凭证.pdf",
      declaredMediaType: "application/pdf",
      declaredSizeBytes: bytes.length,
      expectedSha256: sha256
    }, "read-reservation", at);
    const stored = await store.put({
      versionId: reserved.versionId,
      originalFilename: "合成凭证.pdf",
      declaredMediaType: "application/pdf",
      declaredSizeBytes: bytes.length,
      expectedSha256: sha256
    }, chunks(bytes), async (content) => {
      await validateAttachmentFormat(content, "application/pdf");
    });
    await pool.query(
      `UPDATE finance_attachment_version
          SET status='READY',detected_media_type=$2,actual_size_bytes=$3::bigint,sha256=$4,ready_at=$5::timestamptz
        WHERE id=$1::uuid`,
      [reserved.versionId, stored.mediaType, stored.sizeBytes, stored.sha256, at.toISOString()]
    );

    const readOriginal = store.readVerified.bind(store);
    let reads = 0;
    store.readVerified = async (expected) => {
      reads++;
      return readOriginal(expected);
    };
    const reader = new PostgresFinanceAttachmentReadService(pool, store);
    const ledgerBefore = (await pool.query(
      `SELECT (SELECT count(*)::int FROM ledger_event) AS events,
              (SELECT count(*)::int FROM ledger_entry) AS entries,
              (SELECT count(*)::int FROM account_balance_projection) AS projections`
    )).rows[0];

    const own = await reader.readOwn(contextFor(ownerId), reserved.versionId, at);
    assert.deepEqual(own, {
      bytes,
      mediaType: "application/pdf",
      originalFilename: "合成凭证.pdf",
      sha256,
      sizeBytes: bytes.length
    });
    assert.equal(reads, 1);

    await assert.rejects(
      reader.readOwn(contextFor(otherId), reserved.versionId, at),
      /FINANCE_ATTACHMENT_NOT_FOUND/
    );
    const missingVersionId = randomUUID();
    await assert.rejects(
      reader.readOwn(contextFor(ownerId), missingVersionId, at),
      /FINANCE_ATTACHMENT_NOT_FOUND/
    );
    assert.equal(reads, 1, "越权或不存在的版本不得读取原件");

    const uploadingDocument = await drafts.create(contextFor(ownerId), { kind: "REFUND" }, "read-uploading-document", at);
    const uploading = await reservations.reserve(contextFor(ownerId), uploadingDocument.id, {
      purpose: "INVOICE",
      originalFilename: "尚未上传.pdf",
      declaredMediaType: "application/pdf",
      declaredSizeBytes: bytes.length,
      expectedSha256: sha256
    }, "read-uploading-reservation", at);
    await assert.rejects(
      reader.readOwn(contextFor(ownerId), uploading.versionId, at),
      /FINANCE_ATTACHMENT_NOT_READY/
    );
    await assert.rejects(
      reader.readOwn(contextFor(ownerId, "HEADQUARTERS_FINANCE"), reserved.versionId, at),
      /FORBIDDEN_SCOPE/
    );
    assert.equal(reads, 1, "未就绪或不允许的身份不得读取原件");

    const beforeInvalidInput = (await pool.query("SELECT count(*)::int AS n FROM audit_event")).rows[0].n;
    await assert.rejects(reader.readOwn(contextFor(ownerId), "not-a-uuid", at), /INVALID_INPUT/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_event")).rows[0].n, beforeInvalidInput);

    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 1] ^= 1;
    await writeFile(join(root, "objects", stored.versionId), tampered);
    await assert.rejects(
      reader.readOwn(contextFor(ownerId), reserved.versionId, at),
      /ATTACHMENT_INTEGRITY_FAILED/
    );
    assert.equal(reads, 2, "完整性失败只在通过本人及READY检查后读取一次");

    let releases = 0;
    const trackedPool = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: client.query.bind(client),
          release: () => {
            releases++;
            client.release();
          }
        };
      }
    };
    const auditCountBeforeFailure = (await pool.query("SELECT count(*)::int AS n FROM audit_event")).rows[0].n;
    await pool.query(
      "CREATE FUNCTION fail_attachment_download_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'FORCED_DOWNLOAD_AUDIT_FAILURE'; END; $$"
    );
    await pool.query(
      "CREATE TRIGGER fail_attachment_download_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION fail_attachment_download_audit()"
    );
    const trackedReader = new PostgresFinanceAttachmentReadService(trackedPool, store);
    await assert.rejects(
      trackedReader.readOwn(contextFor(ownerId), randomUUID(), at),
      /FORCED_DOWNLOAD_AUDIT_FAILURE/
    );
    assert.equal(releases, 1, "审计写入失败后连接仍会释放");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_event")).rows[0].n, auditCountBeforeFailure);
    await pool.query("DROP TRIGGER fail_attachment_download_audit ON audit_event");
    await pool.query("DROP FUNCTION fail_attachment_download_audit()");

    const auditRows = (await pool.query(
      `SELECT action_code,subject_type,subject_id::text AS subject_id,reason,
              after_json->>'contextSubject' AS context_subject
         FROM audit_event
        WHERE subject_type='FINANCE_ATTACHMENT_VERSION'
        ORDER BY created_at,id`
    )).rows;
    assert.ok(auditRows.some((row) => row.action_code === "ATTACHMENT_DOWNLOAD_SUCCEEDED" && row.reason === "READY_OBJECT_VERIFIED"));
    assert.ok(auditRows.some((row) => row.action_code === "ATTACHMENT_DOWNLOAD_DENIED" && row.reason === "NOT_FOUND_OR_FORBIDDEN"));
    assert.ok(auditRows.some((row) => row.action_code === "ATTACHMENT_DOWNLOAD_DENIED" && row.reason === "ATTACHMENT_NOT_READY"));
    assert.ok(auditRows.some((row) => row.action_code === "ATTACHMENT_INTEGRITY_FAILED" && row.reason === "OBJECT_VERIFICATION_FAILED"));
    for (const row of auditRows) {
      assert.equal(row.subject_type, "FINANCE_ATTACHMENT_VERSION");
      assert.ok([reserved.versionId, uploading.versionId, missingVersionId].includes(row.subject_id));
      assert.ok(["TEACHING_TEACHER", "HEADQUARTERS_FINANCE"].includes(row.context_subject));
    }
    assert.deepEqual((await pool.query(
      `SELECT (SELECT count(*)::int FROM ledger_event) AS events,
              (SELECT count(*)::int FROM ledger_entry) AS entries,
              (SELECT count(*)::int FROM account_balance_projection) AS projections`
    )).rows[0], ledgerBefore);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});
