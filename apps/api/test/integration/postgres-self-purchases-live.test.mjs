import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LocalAttachmentStore } from "../../dist/local-attachment-store.js";
import { PostgresSelfPurchaseService } from "../../dist/postgres-self-purchase-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const at = new Date("2026-09-21T09:00:00.000Z");
const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const chunks = (bytes) => (async function* () { yield bytes; })();
const self = (personId) => ({ subject: "TEACHING_TEACHER", personId, scope: "SELF" });

const addPerson = (pool, id, nickname) => pool.query(
  "INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,'合成人员','ACTIVE')", [id, nickname]
);
const addDocument = async (pool, personId, createdAt = at) => {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at) VALUES($1::uuid,$2::uuid,'SELF_PURCHASE','DRAFT',1,$3::timestamptz,$3::timestamptz)",
    [id, personId, createdAt.toISOString()]
  );
  return id;
};
const addAccount = async (pool, ownerType, ownerId, accountCode, balance, status = "ACTIVE") => {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,$2,$3::uuid,$4,$5)",
    [id, ownerType, ownerId, accountCode, status]
  );
  await pool.query("INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1::uuid,$2::bigint)", [id, String(balance)]);
  return id;
};
const addReadyAttachment = async (pool, store, documentId, purpose, bytes = png) => {
  const attachmentId = randomUUID();
  const versionId = randomUUID();
  const sha = digest(bytes);
  await store.put({ versionId, originalFilename: `${purpose}.png`, declaredMediaType: "image/png", declaredSizeBytes: bytes.length, expectedSha256: sha }, chunks(bytes));
  await pool.query(
    "INSERT INTO finance_attachment(id,finance_document_id,purpose,created_by_person_id,created_at) SELECT $1::uuid,$2::uuid,$3,applicant_person_id,$4::timestamptz FROM finance_document WHERE id=$2::uuid",
    [attachmentId, documentId, purpose, at.toISOString()]
  );
  await pool.query(
    `INSERT INTO finance_attachment_version(id,finance_attachment_id,version_no,status,original_filename,declared_media_type,declared_size_bytes,expected_sha256,detected_media_type,actual_size_bytes,sha256,uploaded_by_person_id,created_at,ready_at)
     SELECT $1::uuid,$2::uuid,1,'READY',$3,'image/png',$4::bigint,$5,'image/png',$4::bigint,$5,applicant_person_id,$6::timestamptz,$6::timestamptz FROM finance_document WHERE id=$7::uuid`,
    [versionId, attachmentId, `${purpose}.png`, bytes.length, sha, at.toISOString(), documentId]
  );
  return versionId;
};
const addFinanceConfiguration = async (pool, personId, { companyBalance = 1_000, personBalance = 20, roleValidTo = null, fundActive = true, includeFundAssignment = true } = {}) => {
  const roleId = randomUUID();
  await pool.query(
    "INSERT INTO role_assignment(id,person_id,subject_code,scope_type,scope_id,valid_from,valid_to,created_by,created_at) VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,$3::timestamptz,$4::timestamptz,$2::uuid,$3::timestamptz)",
    [roleId, personId, new Date(at.getTime() - 1_000).toISOString(), roleValidTo]
  );
  const fundId = randomUUID();
  await pool.query(
    "INSERT INTO company_finance_fund(id,kind,fund_code,display_name,organization_unit_id,status,version,created_by_person_id,created_at,updated_at) VALUES($1::uuid,'HEADQUARTERS_FINANCE_OPERATING',$2,'合成财务业务账户',NULL,$3,1,$4::uuid,$5::timestamptz,$5::timestamptz)",
    [fundId, `FUND${fundId.replaceAll("-", "").slice(0, 20).toUpperCase()}`, fundActive ? "ACTIVE" : "INACTIVE", personId, at.toISOString()]
  );
  const sourceAccountId = await addAccount(pool, "COMPANY", fundId, `company:fund:${fundId}`, companyBalance, fundActive ? "ACTIVE" : "INACTIVE");
  const destinationAccountId = await addAccount(pool, "PERSON", personId, `person:${personId}`, personBalance);
  let fundAssignmentId = null;
  if (includeFundAssignment) {
    fundAssignmentId = randomUUID();
    await pool.query(
      "INSERT INTO company_finance_fund_assignment(id,fund_id,duty_subject,scope_type,scope_id,responsibility_code,valid_from,valid_to,created_by_person_id,created_at) VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'FINANCE_OPERATING_SOURCE',$3::timestamptz,NULL,$4::uuid,$3::timestamptz)",
      [fundAssignmentId, fundId, new Date(at.getTime() - 1_000).toISOString(), personId]
    );
  }
  return { roleId, fundId, fundAssignmentId, sourceAccountId, destinationAccountId };
};
const draft = (attachmentVersionIds, overrides = {}) => ({ expectedVersion: 1, amountCents: "100", reason: "采购教学物资", attachmentVersionIds, ...overrides });
const balance = async (pool, accountId) => (await pool.query("SELECT balance_cents::text AS value FROM account_balance_projection WHERE account_id=$1::uuid", [accountId])).rows[0].value;

test("财务本人采买自动完成：双侧划转、冻结证据、负公司余额与精确重放", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-self-purchase-"));
  try {
    const personId = randomUUID();
    await addPerson(db.pool, personId, "self-purchase-finance");
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const service = new PostgresSelfPurchaseService(db.pool, store);
    const accounts = await addFinanceConfiguration(db.pool, personId);
    const documentId = await addDocument(db.pool, personId);
    const supporting = await addReadyAttachment(db.pool, store, documentId, "SUPPORTING_DOCUMENT");
    const screenshot = await addReadyAttachment(db.pool, store, documentId, "APPLICATION_SCREENSHOT");
    const invoice = await addReadyAttachment(db.pool, store, documentId, "INVOICE");
    const unselectedInvoice = await addReadyAttachment(db.pool, store, documentId, "INVOICE");
    const completed = await service.submit(self(personId), documentId, draft([invoice, screenshot.toUpperCase(), supporting]), "purchase-1", at);
    assert.deepEqual(completed, { id: documentId, status: "COMPLETED", version: 2, replay: false });
    assert.equal(await balance(db.pool, accounts.sourceAccountId), "900");
    assert.equal(await balance(db.pool, accounts.destinationAccountId), "120");
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM ledger_event WHERE event_type='SELF_PURCHASE_AUTO_COMPLETED'")).rows[0].n, 1);
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM finance_self_purchase_attachment_binding WHERE finance_document_id=$1::uuid", [documentId])).rows[0].n, 3);
    const transfer = (await db.pool.query("SELECT processing_mode,reason,source_before_cents::text AS source_before,source_after_cents::text AS source_after,destination_before_cents::text AS destination_before,destination_after_cents::text AS destination_after,authorization_snapshot FROM finance_self_purchase_transfer WHERE finance_document_id=$1::uuid", [documentId])).rows[0];
    assert.deepEqual(transfer, { processing_mode: "SYSTEM_RULE", reason: "采购教学物资", source_before: "1000", source_after: "900", destination_before: "20", destination_after: "120", authorization_snapshot: {
      roleAssignmentId: accounts.roleId, roleValidFrom: new Date(at.getTime() - 1_000).toISOString(), roleValidTo: null,
      rolePersonId: personId, roleSubjectCode: "HEADQUARTERS_FINANCE", roleScopeType: "GLOBAL", roleScopeId: null,
      companyFundAssignmentId: accounts.fundAssignmentId, fundAssignmentValidFrom: new Date(at.getTime() - 1_000).toISOString(), fundAssignmentValidTo: null,
      sourceFundId: accounts.fundId, sourceFundCode: transfer.authorization_snapshot.sourceFundCode,
      sourceAccountId: accounts.sourceAccountId, destinationPersonId: personId, destinationAccountId: accounts.destinationAccountId,
      applicantContextSubject: "TEACHING_TEACHER", applicantContextScope: "SELF", applicantContextRegionId: null, applicantContextCampusId: null, applicantContextVenueId: null
    } });
    assert.deepEqual(await service.submit(self(personId), documentId.toUpperCase(), draft([supporting, invoice, screenshot]), "purchase-1", new Date("2027-09-01T00:00:00.000Z")), { ...completed, replay: true });
    await assert.rejects(service.submit(self(personId), documentId, draft([supporting, screenshot, invoice], { reason: "篡改重放" }), "purchase-1", at), /IDEMPOTENCY_REPLAY/);
    await assert.rejects(db.pool.query("UPDATE finance_self_purchase_transfer SET reason='改写' WHERE finance_document_id=$1::uuid", [documentId]), /FINANCE_SELF_PURCHASE_IMMUTABLE/);
    const bindingCount = (await db.pool.query("SELECT count(*)::int AS n FROM finance_self_purchase_attachment_binding WHERE finance_document_id=$1::uuid", [documentId])).rows[0].n;
    const anotherPerson = randomUUID();
    await addPerson(db.pool, anotherPerson, "self-purchase-binding-attacker");
    const bind = (versionId, purpose, documentVersion, actorId) => db.pool.query(
      "INSERT INTO finance_self_purchase_attachment_binding(finance_document_id,finance_attachment_version_id,purpose,document_version,bound_by_person_id,bound_at,created_at) VALUES($1::uuid,$2::uuid,$3,$4::bigint,$5::uuid,$6::timestamptz,$6::timestamptz)",
      [documentId, versionId, purpose, documentVersion, actorId, at.toISOString()]
    );
    await assert.rejects(bind(unselectedInvoice, "INVOICE", 2, personId), /FINANCE_SELF_PURCHASE_ATTACHMENT_INVALID/, "完成后不得追加未选READY版本");
    await assert.rejects(bind(unselectedInvoice, "INVOICE", 1, personId), /FINANCE_SELF_PURCHASE_ATTACHMENT_INVALID/, "完成后不得伪造旧单据版本");
    await assert.rejects(bind(unselectedInvoice, "INVOICE", 2, anotherPerson), /FINANCE_SELF_PURCHASE_ATTACHMENT_INVALID/, "完成后不得伪造绑定人");
    await assert.rejects(bind(supporting, "SUPPORTING_DOCUMENT", 2, personId), /FINANCE_SELF_PURCHASE_ATTACHMENT_INVALID/, "完成后不得追加同逻辑槽版本");
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM finance_self_purchase_attachment_binding WHERE finance_document_id=$1::uuid", [documentId])).rows[0].n, bindingCount);

    const negativeDocument = await addDocument(db.pool, personId);
    const negativeSupporting = await addReadyAttachment(db.pool, store, negativeDocument, "SUPPORTING_DOCUMENT");
    const negativeScreenshot = await addReadyAttachment(db.pool, store, negativeDocument, "APPLICATION_SCREENSHOT");
    await db.pool.query("UPDATE account_balance_projection SET balance_cents=50 WHERE account_id=$1::uuid", [accounts.sourceAccountId]);
    await service.submit(self(personId), negativeDocument, draft([negativeSupporting, negativeScreenshot]), "purchase-negative", at);
    assert.equal(await balance(db.pool, accounts.sourceAccountId), "-50");
    assert.equal(await balance(db.pool, accounts.destinationAccountId), "220");

    // A pre-existing matching ledger event is not this document's command replay.
    // It must not let the document complete with balances that the event did not change.
    const orphanDocument = await addDocument(db.pool, personId);
    const orphanSupporting = await addReadyAttachment(db.pool, store, orphanDocument, "SUPPORTING_DOCUMENT");
    const orphanScreenshot = await addReadyAttachment(db.pool, store, orphanDocument, "APPLICATION_SCREENSHOT");
    const orphanEventId = randomUUID();
    const orphanPayload = {
      financeDocumentId: orphanDocument,
      sourceFundId: accounts.fundId,
      sourceAccountId: accounts.sourceAccountId,
      destinationPersonId: personId,
      destinationAccountId: accounts.destinationAccountId,
      amountCents: "100",
      processingMode: "SYSTEM_RULE"
    };
    await db.pool.query("INSERT INTO ledger_event(id,event_key,event_type,payload_hash) VALUES($1::uuid,$2,'SELF_PURCHASE_AUTO_COMPLETED',$3)", [orphanEventId, `self-purchase:${orphanDocument}`, digest(Buffer.from(JSON.stringify(orphanPayload)))]);
    await db.pool.query("INSERT INTO ledger_entry(event_id,account_id,category_key,amount_cents) VALUES($1::uuid,$2::uuid,'selfPurchaseExpense',-100),($1::uuid,$3::uuid,'selfPurchaseIncome',100)", [orphanEventId, accounts.sourceAccountId, accounts.destinationAccountId]);
    await assert.rejects(service.submit(self(personId), orphanDocument, draft([orphanSupporting, orphanScreenshot]), "orphan-event", at), /FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE/);
    assert.equal((await db.pool.query("SELECT status FROM finance_document WHERE id=$1::uuid", [orphanDocument])).rows[0].status, "DRAFT");
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM finance_self_purchase_transfer WHERE finance_document_id=$1::uuid", [orphanDocument])).rows[0].n, 0);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("财务本人采买拒绝无效任职、资金配置和不可用证据，且没有部分入账", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-self-purchase-invalid-"));
  try {
    const personId = randomUUID();
    await addPerson(db.pool, personId, "self-purchase-invalid");
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const service = new PostgresSelfPurchaseService(db.pool, store);
    const noRoleDocument = await addDocument(db.pool, personId);
    await assert.rejects(service.submit(self(personId), noRoleDocument, draft([]), "no-role", at), /INVALID_INPUT/);
    const noRoleSupporting = await addReadyAttachment(db.pool, store, noRoleDocument, "SUPPORTING_DOCUMENT");
    const noRoleScreenshot = await addReadyAttachment(db.pool, store, noRoleDocument, "APPLICATION_SCREENSHOT");
    await assert.rejects(service.submit(self(personId), noRoleDocument, draft([noRoleSupporting, noRoleScreenshot]), "no-role", at), /HEADQUARTERS_FINANCE_ASSIGNMENT_REQUIRED/);

    const missingFundPerson = randomUUID();
    await addPerson(db.pool, missingFundPerson, "self-purchase-no-fund");
    await db.pool.query("INSERT INTO role_assignment(id,person_id,subject_code,scope_type,scope_id,valid_from,valid_to,created_by,created_at) VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,$3::timestamptz,NULL,$2::uuid,$3::timestamptz)", [randomUUID(), missingFundPerson, new Date(at.getTime() - 1_000).toISOString()]);
    await addAccount(db.pool, "PERSON", missingFundPerson, `person:${missingFundPerson}`, 0);
    const missingFundDocument = await addDocument(db.pool, missingFundPerson);
    const missingFundSupporting = await addReadyAttachment(db.pool, store, missingFundDocument, "SUPPORTING_DOCUMENT");
    const missingFundScreenshot = await addReadyAttachment(db.pool, store, missingFundDocument, "APPLICATION_SCREENSHOT");
    await assert.rejects(service.submit(self(missingFundPerson), missingFundDocument, draft([missingFundSupporting, missingFundScreenshot]), "no-fund", at), /COMPANY_FUND_ASSIGNMENT_NOT_FOUND/);

    const accounts = await addFinanceConfiguration(db.pool, personId);
    const expiredRolePerson = randomUUID();
    await addPerson(db.pool, expiredRolePerson, "self-purchase-expired-role");
    await db.pool.query("INSERT INTO role_assignment(id,person_id,subject_code,scope_type,scope_id,valid_from,valid_to,created_by,created_at) VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,$3::timestamptz,$4::timestamptz,$2::uuid,$3::timestamptz)", [randomUUID(), expiredRolePerson, new Date(at.getTime() - 2_000).toISOString(), new Date(at.getTime() - 1_000).toISOString()]);
    await addAccount(db.pool, "PERSON", expiredRolePerson, `person:${expiredRolePerson}`, 0);
    const expiredRoleDocument = await addDocument(db.pool, expiredRolePerson);
    const expiredRoleSupporting = await addReadyAttachment(db.pool, store, expiredRoleDocument, "SUPPORTING_DOCUMENT");
    const expiredRoleScreenshot = await addReadyAttachment(db.pool, store, expiredRoleDocument, "APPLICATION_SCREENSHOT");
    await assert.rejects(service.submit(self(expiredRolePerson), expiredRoleDocument, draft([expiredRoleSupporting, expiredRoleScreenshot]), "expired-role", at), /HEADQUARTERS_FINANCE_ASSIGNMENT_REQUIRED/);
    const missingDocument = await addDocument(db.pool, personId);
    const onlySupporting = await addReadyAttachment(db.pool, store, missingDocument, "SUPPORTING_DOCUMENT");
    const receipt = await addReadyAttachment(db.pool, store, missingDocument, "PAYMENT_RECEIPT");
    await assert.rejects(service.submit(self(personId), missingDocument, draft([onlySupporting, receipt]), "bad-purpose", at), /FINANCE_ATTACHMENT_NOT_READY/);
    assert.equal(await balance(db.pool, accounts.sourceAccountId), "1000");
    assert.equal(await balance(db.pool, accounts.destinationAccountId), "20");

    const duplicateSlotDocument = await addDocument(db.pool, personId);
    const firstSupporting = await addReadyAttachment(db.pool, store, duplicateSlotDocument, "SUPPORTING_DOCUMENT");
    const duplicateSlotScreenshot = await addReadyAttachment(db.pool, store, duplicateSlotDocument, "APPLICATION_SCREENSHOT");
    const secondSupporting = randomUUID();
    const secondSupportingDigest = digest(png);
    await store.put({ versionId: secondSupporting, originalFilename: "supporting-v2.png", declaredMediaType: "image/png", declaredSizeBytes: png.length, expectedSha256: secondSupportingDigest }, chunks(png));
    await db.pool.query(
      `INSERT INTO finance_attachment_version(id,finance_attachment_id,version_no,status,original_filename,declared_media_type,declared_size_bytes,expected_sha256,detected_media_type,actual_size_bytes,sha256,uploaded_by_person_id,created_at,ready_at)
       SELECT $1::uuid,attachment.id,2,'READY','supporting-v2.png','image/png',$2::bigint,$3,'image/png',$2::bigint,$3,document.applicant_person_id,$4::timestamptz,$4::timestamptz
         FROM finance_attachment attachment JOIN finance_document document ON document.id=attachment.finance_document_id
        WHERE attachment.finance_document_id=$5::uuid AND attachment.purpose='SUPPORTING_DOCUMENT'`,
      [secondSupporting, png.length, secondSupportingDigest, at.toISOString(), duplicateSlotDocument]
    );
    await assert.rejects(service.submit(self(personId), duplicateSlotDocument, draft([firstSupporting, secondSupporting, duplicateSlotScreenshot]), "same-slot", at), /FINANCE_ATTACHMENT_NOT_READY/);
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM finance_self_purchase_transfer WHERE finance_document_id=$1::uuid", [duplicateSlotDocument])).rows[0].n, 0);

    const integrityDocument = await addDocument(db.pool, personId);
    const integritySupporting = await addReadyAttachment(db.pool, store, integrityDocument, "SUPPORTING_DOCUMENT");
    const integrityScreenshot = await addReadyAttachment(db.pool, store, integrityDocument, "APPLICATION_SCREENSHOT");
    await rm(join(root, "objects", integritySupporting));
    await assert.rejects(service.submit(self(personId), integrityDocument, draft([integritySupporting, integrityScreenshot]), "missing-original", at), /ATTACHMENT_INTEGRITY_FAILED/);
    assert.equal((await db.pool.query("SELECT status FROM finance_document WHERE id=$1::uuid", [integrityDocument])).rows[0].status, "DRAFT");
    assert.equal(await balance(db.pool, accounts.sourceAccountId), "1000");

    const rollbackDocument = await addDocument(db.pool, personId);
    const rollbackSupporting = await addReadyAttachment(db.pool, store, rollbackDocument, "SUPPORTING_DOCUMENT");
    const rollbackScreenshot = await addReadyAttachment(db.pool, store, rollbackDocument, "APPLICATION_SCREENSHOT");
    await db.pool.query("CREATE FUNCTION fail_self_purchase_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='AUTO_COMPLETED' THEN RAISE EXCEPTION 'FORCED_SELF_PURCHASE_EVENT_FAILURE'; END IF; RETURN NEW; END; $$");
    await db.pool.query("CREATE TRIGGER fail_self_purchase_event BEFORE INSERT ON finance_document_event FOR EACH ROW EXECUTE FUNCTION fail_self_purchase_event()");
    await assert.rejects(service.submit(self(personId), rollbackDocument, draft([rollbackSupporting, rollbackScreenshot]), "forced-failure", at), /FORCED_SELF_PURCHASE_EVENT_FAILURE/);
    await db.pool.query("DROP TRIGGER fail_self_purchase_event ON finance_document_event");
    assert.equal((await db.pool.query("SELECT status FROM finance_document WHERE id=$1::uuid", [rollbackDocument])).rows[0].status, "DRAFT");
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM finance_self_purchase_transfer WHERE finance_document_id=$1::uuid", [rollbackDocument])).rows[0].n, 0);
    assert.equal(await balance(db.pool, accounts.sourceAccountId), "1000");
    assert.equal(await balance(db.pool, accounts.destinationAccountId), "20");

    const ambiguousDocument = await addDocument(db.pool, personId);
    const ambiguousSupporting = await addReadyAttachment(db.pool, store, ambiguousDocument, "SUPPORTING_DOCUMENT");
    const ambiguousScreenshot = await addReadyAttachment(db.pool, store, ambiguousDocument, "APPLICATION_SCREENSHOT");
    const secondRole = randomUUID();
    await db.pool.query("INSERT INTO role_assignment(id,person_id,subject_code,scope_type,scope_id,valid_from,valid_to,created_by,created_at) VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,$3::timestamptz,NULL,$2::uuid,$3::timestamptz)", [secondRole, personId, new Date(at.getTime() - 500).toISOString()]);
    await assert.rejects(service.submit(self(personId), ambiguousDocument, draft([ambiguousSupporting, ambiguousScreenshot]), "ambiguous-role", at), /HEADQUARTERS_FINANCE_ASSIGNMENT_AMBIGUOUS/);
    await db.pool.query("UPDATE role_assignment SET valid_to=$2::timestamptz WHERE id=$1::uuid", [secondRole, at.toISOString()]);

    const inactiveDocument = await addDocument(db.pool, personId);
    const inactiveSupporting = await addReadyAttachment(db.pool, store, inactiveDocument, "SUPPORTING_DOCUMENT");
    const inactiveScreenshot = await addReadyAttachment(db.pool, store, inactiveDocument, "APPLICATION_SCREENSHOT");
    await db.pool.query("UPDATE company_finance_fund SET status='INACTIVE',version=2,updated_at=$2::timestamptz WHERE id=$1::uuid", [accounts.fundId, at.toISOString()]);
    await db.pool.query("UPDATE settlement_account SET status='INACTIVE' WHERE id=$1::uuid", [accounts.sourceAccountId]);
    await assert.rejects(service.submit(self(personId), inactiveDocument, draft([inactiveSupporting, inactiveScreenshot]), "inactive-fund", at), /COMPANY_FUND_INACTIVE/);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("财务本人采买对同一命令和同一单据并发只划转一次", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-self-purchase-race-"));
  try {
    const personId = randomUUID();
    await addPerson(db.pool, personId, "self-purchase-race");
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const service = new PostgresSelfPurchaseService(db.pool, store);
    const accounts = await addFinanceConfiguration(db.pool, personId);
    const documentId = await addDocument(db.pool, personId);
    const supporting = await addReadyAttachment(db.pool, store, documentId, "SUPPORTING_DOCUMENT");
    const screenshot = await addReadyAttachment(db.pool, store, documentId, "APPLICATION_SCREENSHOT");
    const attempts = await Promise.all([
      service.submit(self(personId), documentId, draft([supporting, screenshot]), "same-command", at),
      service.submit(self(personId), documentId, draft([screenshot, supporting]), "same-command", at)
    ]);
    assert.equal(attempts.filter(item => item.replay).length, 1);
    assert.deepEqual(attempts.map(item => item.id), [documentId, documentId]);
    assert.equal(await balance(db.pool, accounts.sourceAccountId), "900");
    assert.equal(await balance(db.pool, accounts.destinationAccountId), "120");
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM ledger_event WHERE event_type='SELF_PURCHASE_AUTO_COMPLETED'")).rows[0].n, 1);
    await assert.rejects(service.submit(self(personId), documentId, draft([supporting, screenshot]), "new-command", at), /SELF_PURCHASE_STATE_CONFLICT/);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
