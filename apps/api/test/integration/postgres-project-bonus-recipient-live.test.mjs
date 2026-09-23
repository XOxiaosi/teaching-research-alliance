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
  PostgresFinanceAttachmentService,
  PostgresFinanceAttachmentUploadService,
  PostgresSalaryBenefitsService,
  PostgresBonusProjectCatalogService,
} from "../../dist/main.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const at = new Date("2026-09-23T04:00:00.000Z");

const finance = (personId) => ({
  personId,
  subject: "HEADQUARTERS_FINANCE",
  scope: "GLOBAL",
});

const balance = async (pool, accountId) =>
  BigInt(
    (
      await pool.query(
        "SELECT balance_cents::text AS value FROM account_balance_projection WHERE account_id=$1::uuid",
        [accountId],
      )
    ).rows[0].value,
  );

test("奖金按数字选取第11版项目且仅向ACTIVE收款人发放；失败不改草稿，重放和冲回保留历史链", async () => {
  const database = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-bonus-recipient-"));
  try {
    const financeId = randomUUID();
    const recipientId = randomUUID();
    const fundId = randomUUID();
    const sourceAccountId = randomUUID();
    const destinationAccountId = randomUUID();
    await database.pool.query(
      "INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,'bonus-recipient-finance','奖金财务','ACTIVE'),($2::uuid,'bonus-recipient-target','奖金收款人','INACTIVE')",
      [financeId, recipientId],
    );
    await database.pool.query(
      "INSERT INTO company_finance_fund(id,kind,fund_code,display_name,status,version,created_by_person_id,created_at,updated_at) VALUES($1::uuid,'HEADQUARTERS_FINANCE_OPERATING','BONUS_RECIPIENT','奖金来源','ACTIVE',1,$2::uuid,$3,$3)",
      [fundId, financeId, at.toISOString()],
    );
    await database.pool.query(
      "INSERT INTO company_finance_fund_assignment(id,fund_id,duty_subject,scope_type,scope_id,responsibility_code,valid_from,valid_to,created_by_person_id,created_at) VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'FINANCE_OPERATING_SOURCE',$3,NULL,$4::uuid,$3)",
      [
        randomUUID(),
        fundId,
        new Date(at.getTime() - 1_000).toISOString(),
        financeId,
      ],
    );
    await database.pool.query(
      "INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,'COMPANY',$2::uuid,$3,'ACTIVE'),($4::uuid,'PERSON',$5::uuid,$6,'ACTIVE')",
      [
        sourceAccountId,
        fundId,
        `company:bonus-recipient:${fundId}`,
        destinationAccountId,
        recipientId,
        `person:bonus-recipient:${recipientId}`,
      ],
    );
    await database.pool.query(
      "INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1::uuid,1000),($2::uuid,0)",
      [sourceAccountId, destinationAccountId],
    );

    const store = await LocalAttachmentStore.create(
      root,
      resolve(fileURLToPath(new URL("../../../../", import.meta.url))),
    );
    const salary = new PostgresSalaryBenefitsService(database.pool, store);
    const attachments = new PostgresFinanceAttachmentService(database.pool);
    const uploads = new PostgresFinanceAttachmentUploadService(database.pool, store);
    const bytes = PNG.sync.write({
      width: 2,
      height: 2,
      data: Buffer.alloc(16, 120),
    });
    const originals = async (documentId, prefix) => {
      const ids = [];
      for (const purpose of ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT"]) {
        const reserved = await attachments.reserve(
          finance(financeId),
          documentId,
          {
            purpose,
            originalFilename: `${prefix}-${purpose}.png`,
            declaredMediaType: "image/png",
            declaredSizeBytes: bytes.length,
          },
          `${prefix}-${purpose}`,
          at,
        );
        await uploads.upload(
          finance(financeId),
          reserved.versionId,
          (async function* () {
            yield bytes;
          })(),
          at,
        );
        ids.push(reserved.versionId);
      }
      return ids;
    };

    const catalog = new PostgresBonusProjectCatalogService(database.pool);
    const administrator = { personId: financeId, subject: "SYSTEM_ADMIN", scope: "GLOBAL" };
    const versions = [];
    for (let expectedVersion = 1; expectedVersion <= 10; expectedVersion++) {
      versions.push(await catalog.rename(administrator, 1, {
        expectedVersion,
        displayName: `数值顺序奖金第${expectedVersion + 1}版`,
        reason: "跨过单数位版本边界",
      }, `bonus-version-${expectedVersion + 1}`, at));
    }
    const project = (await catalog.list(finance(financeId))).projects.find(item => item.projectNo === 1);
    assert.equal(project.nameVersion, 11);
    const bonus = await salary.createEvidenceDocument(
      finance(financeId),
      "PROJECT_BONUS",
      "bonus-recipient-document",
      at,
    );
    const bonusAttachments = await originals(bonus.id, "bonus-recipient");
    const draft = {
      documentId: bonus.id,
      expectedVersion: 1,
      projectNo: 1,
      projectName: project.displayName,
      projectNameVersionId: project.nameVersionId,
      recipientPersonId: recipientId,
      sourceFundId: fundId,
      amountCents: "100",
      reason: "停用收款人不得发放",
      attachmentVersionIds: bonusAttachments,
    };

    const beforeRejected = {
      source: await balance(database.pool, sourceAccountId),
      destination: await balance(database.pool, destinationAccountId),
      events: Number(
        (
          await database.pool.query(
            "SELECT count(*)::text AS value FROM ledger_event WHERE event_key=$1",
            [`project-bonus:${bonus.id}`],
          )
        ).rows[0].value,
      ),
    };
    for (const oldVersion of versions.filter(item => [9, 10].includes(item.nameVersion))) {
      await assert.rejects(salary.grantBonus(finance(financeId), {
        ...draft,
        projectName: oldVersion.displayName,
        projectNameVersionId: oldVersion.nameVersionId,
      }, `bonus-old-version-${oldVersion.nameVersion}`, at), /BONUS_PROJECT_VERSION_CONFLICT/);
    }
    await assert.rejects(
      salary.grantBonus(
        finance(financeId),
        draft,
        "bonus-recipient-inactive",
        at,
      ),
      /PERSON_NOT_FOUND/,
    );
    assert.equal(await balance(database.pool, sourceAccountId), beforeRejected.source);
    assert.equal(
      await balance(database.pool, destinationAccountId),
      beforeRejected.destination,
    );
    assert.equal(
      Number(
        (
          await database.pool.query(
            "SELECT count(*)::text AS value FROM ledger_event WHERE event_key=$1",
            [`project-bonus:${bonus.id}`],
          )
        ).rows[0].value,
      ),
      beforeRejected.events,
    );
    assert.deepEqual(
      (
        await database.pool.query(
          "SELECT status,version::text AS version FROM finance_document WHERE id=$1::uuid",
          [bonus.id],
        )
      ).rows[0],
      { status: "DRAFT", version: "1" },
      "被拒绝的奖金不得完成或推进文档版本",
    );

    await database.pool.query("UPDATE person SET status='ACTIVE' WHERE id=$1::uuid", [recipientId]);
    const posted = await salary.grantBonus(
      finance(financeId),
      draft,
      "bonus-recipient-active",
      at,
    );
    assert.deepEqual(posted, {
      id: bonus.id,
      status: "COMPLETED",
      version: 2,
      replay: false,
    });
    assert.equal(await balance(database.pool, sourceAccountId), 900n);
    assert.equal(await balance(database.pool, destinationAccountId), 100n);

    await database.pool.query("UPDATE person SET status='INACTIVE' WHERE id=$1::uuid", [recipientId]);
    assert.deepEqual(
      await salary.grantBonus(
        finance(financeId),
        draft,
        "bonus-recipient-active",
        new Date(at.getTime() + 1_000),
      ),
      { ...posted, replay: true },
      "成功的原请求必须在收款人随后停用后优先重放",
    );
    assert.equal(await balance(database.pool, sourceAccountId), 900n);
    assert.equal(await balance(database.pool, destinationAccountId), 100n);
    assert.equal(
      Number(
        (
          await database.pool.query(
            "SELECT count(*)::text AS value FROM ledger_event WHERE event_key=$1",
            [`project-bonus:${bonus.id}`],
          )
        ).rows[0].value,
      ),
      1,
      "同键重放不得再次记账",
    );

    const reversal = await salary.createEvidenceDocument(
      finance(financeId),
      "PROJECT_BONUS",
      "bonus-recipient-reversal-document",
      new Date(at.getTime() + 2_000),
    );
    const reversalAttachments = await originals(reversal.id, "bonus-recipient-reversal");
    const reversed = await salary.reversePosting(
      finance(financeId),
      {
        originalDocumentId: bonus.id,
        reversalDocumentId: reversal.id,
        expectedOriginalVersion: 2,
        expectedReversalVersion: 1,
        reason: "已停用收款人的历史奖金冲回",
        attachmentVersionIds: reversalAttachments,
      },
      "bonus-recipient-reversal",
      new Date(at.getTime() + 2_000),
    );
    assert.equal(reversed.status, "COMPLETED");
    assert.equal(await balance(database.pool, sourceAccountId), 1000n);
    assert.equal(await balance(database.pool, destinationAccountId), 0n);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
