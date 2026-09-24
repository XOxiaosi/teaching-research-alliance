import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import {
  LocalAttachmentStore,
  PostgresBonusProjectCatalogService,
  PostgresFinanceAttachmentService,
  PostgresFinanceAttachmentUploadService,
  PostgresSalaryBenefitsService,
} from "../../dist/main.js";
import { PostgresProjectBonusReadService } from "../../dist/postgres-project-bonus-read-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const baseAt = new Date("2026-09-23T04:00:00.000Z");
const global = (personId, subject = "HEADQUARTERS_FINANCE", extra = {}) => ({
  personId, subject, scope: "GLOBAL", ...extra,
});

const balance = async (pool, accountId) => BigInt((await pool.query(
  "SELECT balance_cents::text AS value FROM account_balance_projection WHERE account_id=$1::uuid", [accountId],
)).rows[0].value);

async function harness() {
  const database = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-project-bonus-read-"));
  const ids = {
    finance: randomUUID(), recipient: randomUUID(), fund: randomUUID(),
    sourceAccount: randomUUID(), destinationAccount: randomUUID(),
  };
  try {
    await database.pool.query(
      "INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,'bonus-read-finance','奖金财务','ACTIVE'),($2::uuid,'bonus-read-recipient','奖金收款人','ACTIVE')",
      [ids.finance, ids.recipient],
    );
    await database.pool.query(
      "INSERT INTO company_finance_fund(id,kind,fund_code,display_name,status,version,created_by_person_id,created_at,updated_at) VALUES($1::uuid,'HEADQUARTERS_FINANCE_OPERATING','BONUS_READ','奖金读取来源','ACTIVE',1,$2::uuid,$3,$3)",
      [ids.fund, ids.finance, baseAt.toISOString()],
    );
    await database.pool.query(
      "INSERT INTO company_finance_fund_assignment(id,fund_id,duty_subject,scope_type,scope_id,responsibility_code,valid_from,valid_to,created_by_person_id,created_at) VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'FINANCE_OPERATING_SOURCE',$3,NULL,$4::uuid,$3)",
      [randomUUID(), ids.fund, new Date(baseAt.getTime() - 1_000).toISOString(), ids.finance],
    );
    await database.pool.query(
      "INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,'COMPANY',$2::uuid,$3,'ACTIVE'),($4::uuid,'PERSON',$5::uuid,$6,'ACTIVE')",
      [ids.sourceAccount, ids.fund, `company:bonus-read:${ids.fund}`, ids.destinationAccount, ids.recipient, `person:bonus-read:${ids.recipient}`],
    );
    await database.pool.query(
      "INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1::uuid,10000),($2::uuid,0)",
      [ids.sourceAccount, ids.destinationAccount],
    );
    const store = await LocalAttachmentStore.create(root, resolve(fileURLToPath(new URL("../../../../", import.meta.url))));
    const salary = new PostgresSalaryBenefitsService(database.pool, store);
    const attachments = new PostgresFinanceAttachmentService(database.pool);
    const uploads = new PostgresFinanceAttachmentUploadService(database.pool, store);
    const reads = new PostgresProjectBonusReadService(database.pool);
    const catalog = new PostgresBonusProjectCatalogService(database.pool);
    const bytes = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 80) });
    const originals = async (documentId, prefix, at) => {
      const attachmentIds = [];
      for (const purpose of ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT"]) {
        const reserved = await attachments.reserve(global(ids.finance), documentId, {
          purpose, originalFilename: `${prefix}-${purpose}.png`, declaredMediaType: "image/png", declaredSizeBytes: bytes.length,
        }, `${prefix}-${purpose}`, at);
        await uploads.upload(global(ids.finance), reserved.versionId, (async function* () { yield bytes; })(), at);
        attachmentIds.push(reserved.versionId);
      }
      return attachmentIds;
    };
    const grant = async (prefix, at, amount = "150") => {
      const project = (await catalog.list(global(ids.finance))).projects.find((item) => item.projectNo === 1);
      assert.ok(project);
      const document = await salary.createEvidenceDocument(global(ids.finance), "PROJECT_BONUS", `${prefix}-document`, at);
      const attachmentVersionIds = await originals(document.id, prefix, at);
      const posting = await salary.grantBonus(global(ids.finance), {
        documentId: document.id, expectedVersion: 1, projectNo: 1,
        projectName: project.displayName, projectNameVersionId: project.nameVersionId,
        recipientPersonId: ids.recipient, sourceFundId: ids.fund, amountCents: amount,
        reason: `${prefix} 原因`, attachmentVersionIds,
      }, `${prefix}-grant`, at);
      assert.equal(posting.replay, false);
      return { document, posting, project, attachmentVersionIds };
    };
    return { database, root, ids, salary, attachments, uploads, originals, reads, catalog, grant };
  } catch (error) {
    await database.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

const dispose = async (fixture) => {
  await fixture.database.close();
  await rm(fixture.root, { recursive: true, force: true });
};

test("项目奖金历史只读服务保留冻结项目名、精确双账本、微秒分页、停用历史与完整冲回原件", async () => {
  const f = await harness();
  try {
    const original = await f.grant("frozen-original", new Date("2026-09-23T04:00:00.000Z"));
    const renamed = await f.catalog.rename(global(f.ids.finance, "SYSTEM_ADMIN"), 1, {
      expectedVersion: original.project.nameVersion, displayName: "已改名的项目目录", reason: "目录更新",
    }, "bonus-read-rename", new Date("2026-09-23T04:00:01.000Z"));
    assert.equal(renamed.replay, false);
    const second = await f.grant("same-time-a", new Date("2026-09-23T04:00:02.000Z"), "151");
    const third = await f.grant("same-time-b", new Date("2026-09-23T04:00:03.000Z"), "152");
    const fourth = await f.grant("same-time-c", new Date("2026-09-23T04:00:04.000Z"), "153");

    // Each is a genuine writer-produced posting. Only the immutable display sort key is
    // varied under its test trigger to prove a six-microsecond keyset boundary.
    await f.database.pool.query("ALTER TABLE project_bonus_transfer DISABLE TRIGGER project_bonus_transfer_immutable");
    await f.database.pool.query(
      "UPDATE project_bonus_transfer SET created_at=CASE finance_document_id WHEN $1::uuid THEN '2026-09-23T05:00:00.123001Z'::timestamptz WHEN $2::uuid THEN '2026-09-23T05:00:00.123999Z'::timestamptz WHEN $3::uuid THEN '2026-09-23T05:00:00.123999Z'::timestamptz ELSE created_at END WHERE finance_document_id=ANY($4::uuid[])",
      [second.document.id, third.document.id, fourth.document.id, [second.document.id, third.document.id, fourth.document.id]],
    );
    await f.database.pool.query("ALTER TABLE project_bonus_transfer ENABLE TRIGGER project_bonus_transfer_immutable");

    const all = [];
    let cursor;
    do {
      const page = await f.reads.list(global(f.ids.finance), { limit: 1, cursor });
      all.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    assert.equal(new Set(all.map((item) => item.documentId)).size, 4, "keyset must not skip or duplicate equal-timestamp or different-microsecond rows");
    assert.deepEqual(all.map((item) => item.grantedAt), [
      "2026-09-23T05:00:00.123999Z", "2026-09-23T05:00:00.123999Z",
      "2026-09-23T05:00:00.123001Z", "2026-09-23T04:00:00.000000Z",
    ]);
    await assert.rejects(f.reads.list(global(f.ids.finance), {
      cursor: Buffer.from(JSON.stringify({ createdAt: "2026-09-23T05:00:00.123Z", documentId: original.document.id })).toString("base64url"),
    }), /INVALID_INPUT/);
    await assert.rejects(f.reads.list(global(f.ids.finance), {
      cursor: Buffer.from(JSON.stringify({ createdAt: "2026-02-30T05:00:00.123000Z", documentId: original.document.id })).toString("base64url"),
    }), /INVALID_INPUT/, "invalid calendar dates must not reach PostgreSQL as normalized timestamps");

    const detail = await f.reads.getDetail(global(f.ids.finance), original.document.id);
    assert.equal(detail.projectName, original.project.displayName, "catalog rename cannot rewrite frozen transfer name");
    assert.equal(detail.status, "COMPLETED");
    assert.equal(detail.version, 2);
    assert.equal(detail.amountCents, "150");
    assert.equal(detail.source.accountId, f.ids.sourceAccount);
    assert.equal(detail.recipient.accountId, f.ids.destinationAccount);
    assert.equal(detail.originalAttachments.length, 2);
    assert.equal(detail.reversal, null);
    assert.equal(detail.canReverse, true);
    assert.deepEqual((await f.database.pool.query(
      "SELECT category_key,amount_cents::text AS amount FROM ledger_entry WHERE event_id=(SELECT ledger_event_id FROM project_bonus_transfer WHERE finance_document_id=$1::uuid) ORDER BY category_key", [original.document.id],
    )).rows, [
      { category_key: "projectBonusExpense", amount: "-150" },
      { category_key: "projectBonusIncome", amount: "150" },
    ]);

    // The receiver spent value after grant; the writer's legal inverse can therefore go negative.
    await f.database.pool.query("UPDATE account_balance_projection SET balance_cents=10 WHERE account_id=$1::uuid", [f.ids.destinationAccount]);
    const reversalDocument = await f.salary.createEvidenceDocument(global(f.ids.finance), "PROJECT_BONUS", "frozen-reversal-document", new Date("2026-09-23T06:00:00.000Z"));
    const reversalAttachments = await f.originals(reversalDocument.id, "frozen-reversal", new Date("2026-09-23T06:00:00.000Z"));
    const reversal = await f.salary.reversePosting(global(f.ids.finance), {
      originalDocumentId: original.document.id, reversalDocumentId: reversalDocument.id,
      expectedOriginalVersion: 2, expectedReversalVersion: 1, reason: "项目奖金原笔冲回", attachmentVersionIds: reversalAttachments,
    }, "frozen-reversal", new Date("2026-09-23T06:00:00.000Z"));
    assert.equal(reversal.replay, false);
    assert.equal(await balance(f.database.pool, f.ids.destinationAccount), -140n);
    assert.deepEqual(await f.salary.reversePosting(global(f.ids.finance), {
      originalDocumentId: original.document.id, reversalDocumentId: reversalDocument.id,
      expectedOriginalVersion: 2, expectedReversalVersion: 1, reason: "项目奖金原笔冲回", attachmentVersionIds: reversalAttachments,
    }, "frozen-reversal", new Date("2026-09-23T06:00:01.000Z")), { ...reversal, replay: true });

    await f.database.pool.query("UPDATE person SET status='INACTIVE' WHERE id=$1::uuid", [f.ids.recipient]);
    await f.database.pool.query("UPDATE settlement_account SET status='INACTIVE' WHERE id=ANY($1::uuid[])", [[f.ids.sourceAccount, f.ids.destinationAccount]]);
    const reversed = await f.reads.getDetail(global(f.ids.finance), original.document.id);
    assert.equal(reversed.status, "REVERSED");
    assert.equal(reversed.version, 3);
    assert.equal(reversed.canReverse, false);
    assert.equal(reversed.reversal?.documentId, reversalDocument.id);
    assert.equal(reversed.reversal?.version, 2);
    assert.equal(reversed.reversal?.attachments.length, 2);
    assert.equal((await f.database.pool.query(
      "SELECT count(*)::text AS count FROM ledger_entry WHERE event_id=(SELECT reversal_ledger_event_id FROM salary_benefit_reversal WHERE original_finance_document_id=$1::uuid)", [original.document.id],
    )).rows[0].count, "2");
    await assert.rejects(f.reads.list({ personId: f.ids.finance, subject: "HEADQUARTERS_FINANCE", scope: "CAMPUS", campusId: randomUUID() }), /FORBIDDEN_SCOPE/);
  } finally {
    await dispose(f);
  }
});

test("项目奖金历史读取对实际已完成链的账本、事件和附件破坏失败关闭", async () => {
  const f = await harness();
  try {
    const posting = await f.grant("corrupt", baseAt);
    await assert.rejects(f.reads.getDetail(global(f.ids.finance), randomUUID()), /FINANCE_DOCUMENT_NOT_FOUND/);
    await f.database.pool.query("ALTER TABLE finance_document_event DISABLE TRIGGER finance_document_event_immutable");
    await f.database.pool.query(
      "UPDATE finance_document_event SET actor_person_id=$2::uuid WHERE finance_document_id=$1::uuid AND event_type='SALARY_BENEFIT_COMPLETED'",
      [posting.document.id, f.ids.recipient],
    );
    await f.database.pool.query("ALTER TABLE finance_document_event ENABLE TRIGGER finance_document_event_immutable");
    await assert.rejects(f.reads.list(global(f.ids.finance)), /SALARY_BENEFIT_DATA_UNAVAILABLE/);
  } finally {
    await dispose(f);
  }
});

test("没有冲回行的项目奖金若出现任意伪造逆转事件，历史列表必须失败关闭", async () => {
  const f = await harness();
  try {
    const posting = await f.grant("hidden-reversal", baseAt);
    const ledgerEventId = (await f.database.pool.query(
      "SELECT ledger_event_id::text AS id FROM project_bonus_transfer WHERE finance_document_id=$1::uuid", [posting.document.id],
    )).rows[0].id;
    await f.database.pool.query(
      "INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,ledger_event_id,created_at) VALUES($1::uuid,'SALARY_BENEFIT_REVERSED',$2::uuid,3,$3::uuid,$4::timestamptz)",
      [posting.document.id, f.ids.finance, ledgerEventId, baseAt.toISOString()],
    );
    await assert.rejects(f.reads.list(global(f.ids.finance)), /SALARY_BENEFIT_DATA_UNAVAILABLE/);
    await assert.rejects(f.reads.getDetail(global(f.ids.finance), posting.document.id), /SALARY_BENEFIT_DATA_UNAVAILABLE/);
  } finally {
    await dispose(f);
  }
});

test("项目奖金详情要求绑定用途与实际原件槽位用途精确一致", async () => {
  const f = await harness();
  try {
    const posting = await f.grant("attachment-purpose", baseAt);
    await f.database.pool.query("ALTER TABLE finance_attachment DISABLE TRIGGER finance_attachment_immutable");
    await f.database.pool.query(
      "UPDATE finance_attachment SET purpose='APPLICATION_SCREENSHOT' WHERE finance_document_id=$1::uuid AND purpose='SUPPORTING_DOCUMENT'",
      [posting.document.id],
    );
    await f.database.pool.query("ALTER TABLE finance_attachment ENABLE TRIGGER finance_attachment_immutable");
    await assert.rejects(f.reads.getDetail(global(f.ids.finance), posting.document.id), /SALARY_BENEFIT_DATA_UNAVAILABLE/);
  } finally {
    await dispose(f);
  }
});
