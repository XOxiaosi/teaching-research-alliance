import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { LocalAttachmentStore } from "../../dist/local-attachment-store.js";
import { PostgresCompanyFundService } from "../../dist/postgres-company-fund-service.js";
import { PostgresFinanceAttachmentService } from "../../dist/postgres-finance-attachment-service.js";
import { PostgresFinanceAttachmentUploadService } from "../../dist/postgres-finance-attachment-upload-service.js";
import { PostgresFinanceDraftService } from "../../dist/postgres-finance-draft-service.js";
import { PostgresSelfPurchaseReadService } from "../../dist/postgres-self-purchase-read-service.js";
import { PostgresSelfPurchaseReversalService } from "../../dist/postgres-self-purchase-reversal-service.js";
import { PostgresPersonalReadService } from "../../dist/postgres-personal-read-service.js";
import { PostgresSelfPurchaseService } from "../../dist/postgres-self-purchase-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const at = new Date("2026-09-21T04:00:00.000Z");
const personal = (personId) => ({ personId, subject: "TEACHING_TEACHER", scope: "SELF" });
const managed = (personId, subject = "HEADQUARTERS_FINANCE", extra = {}) => ({ personId, subject, scope: "GLOBAL", ...extra });

const chunks = async function* (bytes) { yield bytes; };

test("SELF_PURCHASE 仅本人当财年或严格全局财务读取，详情核对双侧账本、授权快照与READY绑定", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-self-purchase-read-"));
  const { pool } = db;
  const [financeId, otherId, hqId, adminId, ownerId, plannerId] = Array.from({ length: 6 }, () => randomUUID());
  try {
    for (const [id, label] of [[financeId, "finance"], [otherId, "other"], [hqId, "hq"], [adminId, "admin"], [ownerId, "owner"], [plannerId, "planner"]]) {
      await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,'合成人员','ACTIVE')", [id, `self-read-${label}-${id}`]);
    }
    const personalAccountId = randomUUID();
    await pool.query(
      "INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,'PERSON',$2::uuid,$3,'ACTIVE')",
      [personalAccountId, financeId, `person:${financeId}`]
    );
    await pool.query("INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1::uuid,2000)", [personalAccountId]);
    const plannerAccountId = randomUUID();
    await pool.query(
      "INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,'PERSON',$2::uuid,$3,'ACTIVE')",
      [plannerAccountId, plannerId, `person:${plannerId}`]
    );
    await pool.query("INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1::uuid,0)", [plannerAccountId]);
    const funds = new PostgresCompanyFundService(pool);
    const admin = managed(adminId, "SYSTEM_ADMIN");
    const fund = await funds.create(admin, { fundCode: "HQ_SELF_READ", displayName: "合成采买业务资金" }, "read-fund", at);
    await funds.assign(admin, { fundId: fund.id, expectedAssignmentId: null, reason: "合成业务资金职责" }, "read-assign", at);
    await pool.query("UPDATE account_balance_projection SET balance_cents=5000 WHERE account_id=$1::uuid", [fund.accountId]);
    await pool.query(
      "INSERT INTO role_assignment(person_id,subject_code,scope_type,scope_id,valid_from,created_by) VALUES($1::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'2026-01-01',$2::uuid)",
      [financeId, adminId]
    );

    const store = await LocalAttachmentStore.create(root, fileURLToPath(new URL("../../../../", import.meta.url)));
    const drafts = new PostgresFinanceDraftService(pool);
    const reservations = new PostgresFinanceAttachmentService(pool);
    const uploads = new PostgresFinanceAttachmentUploadService(pool, store);
    const purchases = new PostgresSelfPurchaseService(pool, store);
    const reads = new PostgresSelfPurchaseReadService(pool);
    const personalReads = new PostgresPersonalReadService(pool);
    const draft = await drafts.create(personal(financeId), { kind: "SELF_PURCHASE" }, "read-draft", at);
    const bytes = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 120) });
    const versions = [];
    for (const purpose of ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT"]) {
      const reserved = await reservations.reserve(personal(financeId), draft.id, {
        purpose, originalFilename: `${purpose}.png`, declaredMediaType: "image/png", declaredSizeBytes: bytes.length
      }, `read-${purpose}`, at);
      await uploads.upload(personal(financeId), reserved.versionId, chunks(bytes), at);
      versions.push(reserved.versionId);
    }
    const completed = await purchases.submit(personal(financeId), draft.id, {
      expectedVersion: draft.version, amountCents: "10000", reason: "合成教具采购", attachmentVersionIds: versions
    }, "read-submit", at);
    assert.equal(completed.status, "COMPLETED");

    const mine = await reads.listOwn(personal(financeId), at);
    assert.equal(mine.documents.length, 1);
    assert.deepEqual(mine.documents[0], {
      id: draft.id, status: "COMPLETED", version: completed.version, amountCents: "10000", reason: "合成教具采购",
      applicantPersonId: financeId, applicantDisplayName: `self-read-finance-${financeId}`,
      sourceFund: { id: fund.id, displayName: "合成采买业务资金" },
      processingMode: "SYSTEM_RULE", submittedAt: at.toISOString(), completedAt: at.toISOString()
    });
    const ownDetail = await reads.getDetail(personal(financeId), draft.id, at);
    assert.equal(ownDetail.attachments.length, 2);
    assert.equal(ownDetail.management, undefined);
    assert.deepEqual(ownDetail.attachments.map((attachment) => attachment.purpose).sort(), ["APPLICATION_SCREENSHOT", "SUPPORTING_DOCUMENT"]);
    await assert.rejects(reads.getDetail(personal(otherId), draft.id, at), /FINANCE_DOCUMENT_NOT_FOUND/);
    assert.deepEqual(await reads.listOwn(personal(otherId), at), { documents: [] });
    await assert.rejects(reads.listManaged(managed(hqId, "HEADQUARTERS_FINANCE", { regionId: randomUUID() })), /FORBIDDEN_SCOPE/);

    for (const context of [managed(hqId), managed(adminId, "SYSTEM_ADMIN"), managed(ownerId, "SYSTEM_OWNER")]) {
      const list = await reads.listManaged(context);
      assert.equal(list.documents.length, 1);
      const detail = await reads.getDetail(context, draft.id, at);
      assert.deepEqual(detail.management, {
        roleAssignmentId: (await pool.query("SELECT id::text AS id FROM role_assignment WHERE person_id=$1::uuid AND subject_code='HEADQUARTERS_FINANCE'", [financeId])).rows[0].id,
        companyFundAssignmentId: (await pool.query("SELECT id::text AS id FROM company_finance_fund_assignment")).rows[0].id,
        sourceAccountId: fund.accountId, destinationAccountId: personalAccountId,
        ledgerEventId: (await pool.query("SELECT ledger_event_id::text AS id FROM finance_self_purchase_transfer WHERE finance_document_id=$1::uuid", [draft.id])).rows[0].id
      });
    }
    const nextYear = new Date("2027-08-31T16:00:00.000Z");
    assert.deepEqual(await reads.listOwn(personal(financeId), nextYear), { documents: [] });
    await assert.rejects(reads.getDetail(personal(financeId), draft.id, nextYear), /FINANCE_DOCUMENT_NOT_FOUND/);
    assert.equal((await reads.getDetail(managed(hqId), draft.id, nextYear)).id, draft.id);

    const plannerCampusId = randomUUID();
    const plannerContext = { personId: plannerId, subject: "ACADEMIC_PLANNER", scope: "CAMPUS", campusId: plannerCampusId };
    await pool.query(
      "INSERT INTO role_assignment(person_id,subject_code,scope_type,scope_id,valid_from,created_by) VALUES($1::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'2026-01-01',$2::uuid)",
      [plannerId, adminId]
    );
    const plannerDraft = await drafts.create(plannerContext, { kind: "SELF_PURCHASE" }, "planner-draft", at);
    const plannerVersions = [];
    for (const purpose of ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT"]) {
      const reserved = await reservations.reserve(plannerContext, plannerDraft.id, {
        purpose, originalFilename: `planner-${purpose}.png`, declaredMediaType: "image/png", declaredSizeBytes: bytes.length
      }, `planner-${purpose}`, at);
      await uploads.upload(plannerContext, reserved.versionId, chunks(bytes), at);
      plannerVersions.push(reserved.versionId);
    }
    await purchases.submit(plannerContext, plannerDraft.id, {
      expectedVersion: plannerDraft.version, amountCents: "1", reason: "规划师组织范围采买", attachmentVersionIds: plannerVersions
    }, "planner-submit", at);
    assert.equal((await reads.listOwn(plannerContext, at)).documents.length, 1);
    assert.equal((await reads.getDetail(plannerContext, plannerDraft.id, at)).applicantPersonId, plannerId);
    // Role-assignment rows are administrative history, not the authorization fact for an already-completed transfer.
    await pool.query("UPDATE role_assignment SET valid_to='2026-09-20T00:00:00.000Z' WHERE person_id=$1::uuid AND subject_code='HEADQUARTERS_FINANCE'", [financeId]);
    await funds.setStatus(admin, fund.id, { expectedVersion: fund.version, status: "INACTIVE", reason: "已完成记录仍可查" }, "read-fund-inactive", at);
    assert.equal((await reads.getDetail(personal(financeId), draft.id, at)).id, draft.id);
    assert.equal((await reads.getDetail(managed(hqId), draft.id, at)).id, draft.id);

    const reversals = new PostgresSelfPurchaseReversalService(pool);
    const reversed = await reversals.reverse(managed(hqId), draft.id, {
      expectedVersion: completed.version, reason: "采购取消"
    }, "read-reverse", at);
    assert.deepEqual(reversed, { id: draft.id, status: "REVERSED", version: completed.version + 1, replay: false });
    assert.equal((await reversals.reverse(managed(hqId), draft.id, {
      expectedVersion: completed.version, reason: "采购取消"
    }, "read-reverse", at)).replay, true);
    const reversedSummary = (await reads.listOwn(personal(financeId), at)).documents.find((document) => document.id === draft.id);
    assert.deepEqual(reversedSummary, {
      id: draft.id, status: "REVERSED", version: completed.version + 1, amountCents: "10000", reason: "合成教具采购",
      applicantPersonId: financeId, applicantDisplayName: `self-read-finance-${financeId}`,
      sourceFund: { id: fund.id, displayName: "合成采买业务资金" }, processingMode: "SYSTEM_RULE",
      submittedAt: at.toISOString(), completedAt: at.toISOString()
    });
    const reversedDetail = await reads.getDetail(managed(hqId), draft.id, at);
    assert.deepEqual(reversedDetail.reversal, { reason: "采购取消", reversedAt: at.toISOString() });
    assert.equal(reversedDetail.attachments.length, 2, "撤销仍读取原完成版本附件");
    assert.deepEqual(reversedDetail.management, {
      roleAssignmentId: (await pool.query("SELECT id::text AS id FROM role_assignment WHERE person_id=$1::uuid AND subject_code='HEADQUARTERS_FINANCE'", [financeId])).rows[0].id,
      companyFundAssignmentId: (await pool.query("SELECT id::text AS id FROM company_finance_fund_assignment")).rows[0].id,
      sourceAccountId: fund.accountId, destinationAccountId: personalAccountId,
      ledgerEventId: (await pool.query("SELECT ledger_event_id::text AS id FROM finance_self_purchase_transfer WHERE finance_document_id=$1::uuid", [draft.id])).rows[0].id,
      reversedByPersonId: hqId, reversalActorSubject: "HEADQUARTERS_FINANCE",
      reversalLedgerEventId: (await pool.query("SELECT reversal_ledger_event_id::text AS id FROM finance_self_purchase_reversal WHERE finance_document_id=$1::uuid", [draft.id])).rows[0].id
    });
    const bindings = await pool.query("SELECT document_version::text AS version FROM finance_self_purchase_attachment_binding WHERE finance_document_id=$1::uuid ORDER BY document_version", [draft.id]);
    assert.deepEqual(bindings.rows.map((binding) => binding.version), [String(completed.version), String(completed.version)]);
    assert.deepEqual((await personalReads.getOwnOverview(personal(financeId), at)).currentYearIncomeByCategory, {}, "撤销即时冲回本人当年采买收入");
    await pool.query("ALTER TABLE finance_document DISABLE TRIGGER USER");
    await pool.query("UPDATE finance_document SET status='COMPLETED' WHERE id=$1::uuid", [draft.id]);
    await assert.rejects(reads.getDetail(managed(hqId), draft.id, at), /FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE/, "完成状态不得隐藏反向账");
    await pool.query("UPDATE finance_document SET status='REVERSED' WHERE id=$1::uuid", [draft.id]);
    await pool.query("UPDATE finance_document SET status='REVERSED',version=version+1 WHERE id=$1::uuid", [plannerDraft.id]);
    await assert.rejects(reads.getDetail(managed(hqId), plannerDraft.id, at), /FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE/, "撤销状态不得缺失反向账");
    await pool.query("UPDATE finance_document SET status='COMPLETED',version=version-1 WHERE id=$1::uuid", [plannerDraft.id]);
    await pool.query("ALTER TABLE finance_document ENABLE TRIGGER USER");

    await pool.query("CREATE FUNCTION fail_self_purchase_read_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'FORCED_SELF_PURCHASE_AUDIT_FAILURE'; END; $$");
    await pool.query("CREATE TRIGGER fail_self_purchase_read_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION fail_self_purchase_read_audit()");
    await assert.rejects(reads.getDetail(managed(hqId), draft.id, at), /FORCED_SELF_PURCHASE_AUDIT_FAILURE/);
    await pool.query("DROP TRIGGER fail_self_purchase_read_audit ON audit_event");

    const originalSnapshot = (await pool.query(
      "SELECT authorization_snapshot FROM finance_self_purchase_transfer WHERE finance_document_id=$1::uuid", [draft.id]
    )).rows[0].authorization_snapshot;
    await pool.query("ALTER TABLE finance_self_purchase_transfer DISABLE TRIGGER USER");
    await pool.query(
      "UPDATE finance_self_purchase_transfer SET authorization_snapshot=jsonb_set(authorization_snapshot,'{roleValidFrom}','\"not-a-time\"'::jsonb,true) WHERE finance_document_id=$1::uuid",
      [draft.id]
    );
    await pool.query("ALTER TABLE finance_self_purchase_transfer ENABLE TRIGGER USER");
    await assert.rejects(reads.getDetail(managed(hqId), draft.id, at), /FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE/);
    await pool.query("ALTER TABLE finance_self_purchase_transfer DISABLE TRIGGER USER");
    await pool.query("UPDATE finance_self_purchase_transfer SET authorization_snapshot=$2::jsonb WHERE finance_document_id=$1::uuid", [draft.id, JSON.stringify(originalSnapshot)]);
    await pool.query("ALTER TABLE finance_self_purchase_transfer ENABLE TRIGGER USER");

    const reversalSnapshot = (await pool.query(
      "SELECT authorization_snapshot FROM finance_self_purchase_reversal WHERE finance_document_id=$1::uuid", [draft.id]
    )).rows[0].authorization_snapshot;
    await pool.query("ALTER TABLE finance_self_purchase_reversal DISABLE TRIGGER USER");
    await pool.query(
      "UPDATE finance_self_purchase_reversal SET authorization_snapshot=jsonb_set(authorization_snapshot,'{actorPersonId}','\"00000000-0000-4000-8000-000000000000\"'::jsonb,true) WHERE finance_document_id=$1::uuid",
      [draft.id]
    );
    await assert.rejects(reads.getDetail(managed(hqId), draft.id, at), /FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE/);
    await assert.rejects(personalReads.getOwnOverview(personal(financeId), at), /FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE/);
    await pool.query("UPDATE finance_self_purchase_reversal SET authorization_snapshot=$2::jsonb WHERE finance_document_id=$1::uuid", [draft.id, JSON.stringify(reversalSnapshot)]);
    const reversalTime = (await pool.query("SELECT reversed_at::text AS reversed_at FROM finance_self_purchase_reversal WHERE finance_document_id=$1::uuid", [draft.id])).rows[0].reversed_at;
    await pool.query("UPDATE finance_self_purchase_reversal SET reversed_at='2025-01-01',created_at='2025-01-01' WHERE finance_document_id=$1::uuid", [draft.id]);
    await assert.rejects(reads.getDetail(managed(hqId), draft.id, at), /FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE/);
    await assert.rejects(personalReads.getOwnOverview(personal(financeId), at), /FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE/);
    await pool.query("UPDATE finance_self_purchase_reversal SET reversed_at=$2::timestamptz,created_at=$2::timestamptz WHERE finance_document_id=$1::uuid", [draft.id,reversalTime]);
    await pool.query(
      "UPDATE finance_self_purchase_reversal SET authorization_snapshot=jsonb_set(authorization_snapshot,'{originalTransferAuthorization,roleValidFrom}','\"not-a-time\"'::jsonb,true) WHERE finance_document_id=$1::uuid",
      [draft.id]
    );
    await assert.rejects(reads.getDetail(managed(hqId), draft.id, at), /FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE/);
    await pool.query("UPDATE finance_self_purchase_reversal SET authorization_snapshot=$2::jsonb WHERE finance_document_id=$1::uuid", [draft.id, JSON.stringify(reversalSnapshot)]);
    await pool.query("ALTER TABLE finance_self_purchase_reversal ENABLE TRIGGER USER");

    await pool.query("ALTER TABLE ledger_entry DISABLE TRIGGER USER");
    await pool.query("UPDATE ledger_entry SET category_key='corruptedCategory' WHERE event_id=(SELECT ledger_event_id FROM finance_self_purchase_transfer WHERE finance_document_id=$1::uuid) AND amount_cents < 0", [draft.id]);
    await pool.query("ALTER TABLE ledger_entry ENABLE TRIGGER USER");
    await assert.rejects(reads.getDetail(managed(hqId), draft.id, at), /FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE/);
    const audits = await pool.query(
      "SELECT action_code,reason FROM audit_event WHERE subject_type='FINANCE_SELF_PURCHASE' AND subject_id=$1::uuid ORDER BY created_at,action_code",
      [draft.id]
    );
    assert.ok(audits.rows.some((event) => event.action_code === "SELF_PURCHASE_DETAIL_READ"));
    assert.ok(audits.rows.some((event) => event.action_code === "SELF_PURCHASE_DETAIL_DENIED" && event.reason === "NOT_FOUND_OR_FORBIDDEN"));
    assert.ok(audits.rows.some((event) => event.action_code === "SELF_PURCHASE_DETAIL_INTEGRITY_FAILED"));
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});
