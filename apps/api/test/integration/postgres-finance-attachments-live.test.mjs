import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresFinanceAttachmentService } from "../../dist/postgres-finance-attachment-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const at = new Date("2026-09-21T04:00:00.000Z");
const contextFor = (personId, subject = "TEACHING_TEACHER") => ({ personId, subject });
const draft = (overrides = {}) => ({ purpose: "SUPPORTING_DOCUMENT", originalFilename: "合成单据.pdf", declaredMediaType: "application/pdf", declaredSizeBytes: 40, expectedSha256: "a".repeat(64), ...overrides });

const addDocument = async (pool, personId) => {
  const id = randomUUID();
  await pool.query("INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at) VALUES ($1::uuid,$2::uuid,'REIMBURSEMENT','DRAFT',1,$3::timestamptz,$3::timestamptz)", [id,personId,at.toISOString()]);
  return id;
};

test("真实 PostgreSQL 附件预留仅生成UPLOADING元数据，并发同键和预算均不越限", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const {pool} = db;
  const [teacherId,otherId] = [randomUUID(),randomUUID()];
  try {
    for(const id of [teacherId,otherId]) await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES ($1::uuid,$2,'合成人员','ACTIVE')",[id,`attachment-${id}`]);
    const docId=await addDocument(pool,teacherId);
    const service=new PostgresFinanceAttachmentService(pool,{maxFileBytes:100,maxDocumentBytes:100,maxActiveVersions:2});
    const results=await Promise.all(Array.from({length:4},()=>service.reserve(contextFor(teacherId),docId,draft(),"attachment-same-key",at)));
    assert.equal(results.filter(result=>!result.replay).length,1);
    assert.equal(new Set(results.map(result=>result.versionId)).size,1);
    const reserved=results[0];
    assert.deepEqual(reserved,{attachmentId:reserved.attachmentId,versionId:reserved.versionId,versionNo:1,status:"UPLOADING",purpose:"SUPPORTING_DOCUMENT",originalFilename:"合成单据.pdf",declaredMediaType:"application/pdf",declaredSizeBytes:40,expectedSha256:"a".repeat(64),createdAt:at.toISOString(),replay:reserved.replay});
    const {replay: _replay,...reservedMetadata}=reserved;
    assert.deepEqual(await service.getOwnVersion(contextFor(teacherId),reserved.versionId,at),reservedMetadata);
    const reordered={declaredSizeBytes:40,expectedSha256:"a".repeat(64),declaredMediaType:"application/pdf",originalFilename:"合成单据.pdf",purpose:"SUPPORTING_DOCUMENT",ignoredByService:"not-hashed"};
    assert.deepEqual(await service.reserve(contextFor(teacherId),docId,reordered,"attachment-same-key",at),{...reserved,replay:true});
    await assert.rejects(service.getOwnVersion(contextFor(otherId),reserved.versionId,at),/FINANCE_ATTACHMENT_NOT_FOUND/);
    await assert.rejects(service.reserve(contextFor(teacherId),docId,draft({purpose:"INVOICE"}),"attachment-same-key",at),/IDEMPOTENCY_REPLAY/);
    const budgetRace=await Promise.allSettled([
      service.reserve(contextFor(teacherId),docId,draft({declaredSizeBytes:60}),"attachment-budget-a",at),
      service.reserve(contextFor(teacherId),docId,draft({declaredSizeBytes:60}),"attachment-budget-b",at)
    ]);
    assert.equal(budgetRace.filter(result=>result.status==="fulfilled").length,1);
    assert.match(budgetRace.find(result=>result.status==="rejected").reason.message,/FINANCE_ATTACHMENT_LIMIT_EXCEEDED/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM finance_attachment_version WHERE status='UPLOADING'")).rows[0].n,2);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM finance_attachment_event WHERE event_type='RESERVED'")).rows[0].n,2);
    await assert.rejects(service.reserve({personId:teacherId,subject:"HEADQUARTERS_FINANCE"},docId,draft(),"role-forbidden",at),/FORBIDDEN_SCOPE/);
    await assert.rejects(service.reserve(contextFor(teacherId),docId,draft({originalFilename:"../secret.pdf"}),"bad-path",at),/INVALID_INPUT/);
    await assert.rejects(service.reserve(contextFor(teacherId),docId,draft({declaredSizeBytes:101}),"too-large",at),/INVALID_INPUT/);
    assert.throws(()=>new PostgresFinanceAttachmentService(pool,{maxFileBytes:20*1024*1024+1,maxDocumentBytes:30*1024*1024,maxActiveVersions:1}),/FINANCE_ATTACHMENT_LIMIT_CONFIG_INVALID/);
  } finally { await db.close(); }
});

test("附件预留不泄露他人文档，末端失败回滚，终结版本不可覆盖", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const {pool} = db;
  const [teacherId,otherId] = [randomUUID(),randomUUID()];
  try {
    for(const id of [teacherId,otherId]) await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES ($1::uuid,$2,'合成人员','ACTIVE')",[id,`attachment-failure-${id}`]);
    const ownDoc=await addDocument(pool,teacherId);
    const otherDoc=await addDocument(pool,otherId);
    const service=new PostgresFinanceAttachmentService(pool,{maxFileBytes:100,maxDocumentBytes:100,maxActiveVersions:20});
    await assert.rejects(service.reserve(contextFor(teacherId),otherDoc,draft(),"other-document",at),/FINANCE_DOCUMENT_NOT_FOUND/);
    await pool.query("CREATE FUNCTION fail_attachment_event_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'FORCED_ATTACHMENT_EVENT_FAILURE'; END; $$");
    await pool.query("CREATE TRIGGER fail_attachment_event_insert BEFORE INSERT ON finance_attachment_event FOR EACH ROW EXECUTE FUNCTION fail_attachment_event_insert()");
    await assert.rejects(service.reserve(contextFor(teacherId),ownDoc,draft(),"forced-rollback",at),/FORCED_ATTACHMENT_EVENT_FAILURE/);
    await pool.query("DROP TRIGGER fail_attachment_event_insert ON finance_attachment_event");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM finance_attachment")).rows[0].n,0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM finance_attachment_event")).rows[0].n,0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM finance_attachment_reservation_idempotency")).rows[0].n,0);
    const reserved=await service.reserve(contextFor(teacherId),ownDoc,draft({expectedSha256:"b".repeat(64)}),"terminal",at);
    await assert.rejects(pool.query("UPDATE finance_attachment_version SET status='READY',detected_media_type='image/png',actual_size_bytes=40,sha256=$2,ready_at=$3::timestamptz WHERE id=$1::uuid",[reserved.versionId,"b".repeat(64),at.toISOString()]),/finance_attachment_version_check/);
    await assert.rejects(pool.query("UPDATE finance_attachment_version SET status='READY',detected_media_type='application/pdf',actual_size_bytes=39,sha256=$2,ready_at=$3::timestamptz WHERE id=$1::uuid",[reserved.versionId,"b".repeat(64),at.toISOString()]),/finance_attachment_version_check/);
    await assert.rejects(pool.query("UPDATE finance_attachment_version SET status='READY',detected_media_type='application/pdf',actual_size_bytes=40,sha256=$2,ready_at=$3::timestamptz WHERE id=$1::uuid",[reserved.versionId,"a".repeat(64),at.toISOString()]),/finance_attachment_version_check/);
    await pool.query("UPDATE finance_attachment_version SET status='READY',detected_media_type='application/pdf',actual_size_bytes=40,sha256=$2,ready_at=$3::timestamptz WHERE id=$1::uuid",[reserved.versionId,"b".repeat(64),at.toISOString()]);
    assert.equal((await service.getOwnVersion(contextFor(teacherId),reserved.versionId,at)).status,"READY");
    await assert.rejects(pool.query("UPDATE finance_attachment_version SET failure_code='rewritten' WHERE id=$1",[reserved.versionId]),/FINANCE_ATTACHMENT_VERSION_IMMUTABLE/);
    await assert.rejects(pool.query("DELETE FROM finance_attachment_version WHERE id=$1",[reserved.versionId]),/FINANCE_ATTACHMENT_VERSION_IMMUTABLE/);
    await assert.rejects(pool.query("UPDATE finance_attachment_version SET id=$2::uuid WHERE id=$1::uuid",[reserved.versionId,randomUUID()]),/FINANCE_ATTACHMENT_VERSION_IMMUTABLE/);
    await assert.rejects(pool.query("UPDATE finance_attachment_event SET event_type='RESERVED' WHERE finance_attachment_version_id=$1",[reserved.versionId]),/FINANCE_ATTACHMENT_EVENT_IMMUTABLE/);
    await assert.rejects(pool.query("DELETE FROM finance_attachment_reservation_idempotency WHERE actor_person_id=$1",[teacherId]),/FINANCE_ATTACHMENT_RESERVATION_IDEMPOTENCY_IMMUTABLE/);
  } finally { await db.close(); }
});
