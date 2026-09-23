import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  createApiServer,
  LocalAttachmentStore,
  PostgresReimbursementReadService,
  PostgresReimbursementReversalService,
  PostgresReimbursementReviewService,
  PostgresReimbursementSubmissionService,
  PostgresReimbursementTransferService,
  SessionService,
} from "../../dist/main.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 77) });
const sha256 = createHash("sha256").update(png).digest("hex");
const chunks = (bytes) => (async function* () { yield bytes; })();
const personal = (personId) => ({ personId, subject: "TEACHING_TEACHER", scope: "SELF" });
const hq = (personId) => ({ personId, subject: "HEADQUARTERS_FINANCE", scope: "GLOBAL" });

const addPerson = (pool, id, nickname) => pool.query(
  "INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,'合成人员','ACTIVE')",
  [id, nickname],
);

const addAttachment = async (pool, store, documentId, purpose, at) => {
  const attachmentId = randomUUID();
  const versionId = randomUUID();
  await store.put({
    versionId,
    originalFilename: `${purpose}.png`,
    declaredMediaType: "image/png",
    declaredSizeBytes: png.length,
    expectedSha256: sha256,
  }, chunks(png));
  await pool.query(
    `INSERT INTO finance_attachment(id,finance_document_id,purpose,created_by_person_id,created_at)
       SELECT $1::uuid,$2::uuid,$3,applicant_person_id,$4::timestamptz
         FROM finance_document WHERE id=$2::uuid`,
    [attachmentId, documentId, purpose, at.toISOString()],
  );
  await pool.query(
    `INSERT INTO finance_attachment_version(
       id,finance_attachment_id,version_no,status,original_filename,declared_media_type,declared_size_bytes,
       expected_sha256,detected_media_type,actual_size_bytes,sha256,uploaded_by_person_id,created_at,ready_at
     ) SELECT $1::uuid,$2::uuid,1,'READY',$3,'image/png',$4::bigint,$5,'image/png',$4::bigint,$5,
              applicant_person_id,$6::timestamptz,$6::timestamptz
         FROM finance_document WHERE id=$7::uuid`,
    [versionId, attachmentId, `${purpose}.png`, png.length, sha256, at.toISOString(), documentId],
  );
  return versionId;
};

const createCompleted = async ({ pool, store, applicantId, financeId, at, serial }) => {
  const documentId = randomUUID();
  await pool.query(
    `INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at)
     VALUES($1::uuid,$2::uuid,'REIMBURSEMENT','DRAFT',1,$3::timestamptz,$3::timestamptz)`,
    [documentId, applicantId, at.toISOString()],
  );
  await pool.query(
    `INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,created_at)
     VALUES($1::uuid,'CREATED',$2::uuid,1,$3::timestamptz)`,
    [documentId, applicantId, at.toISOString()],
  );
  const attachmentVersionIds = await Promise.all([
    addAttachment(pool, store, documentId, "SUPPORTING_DOCUMENT", at),
    addAttachment(pool, store, documentId, "APPLICATION_SCREENSHOT", at),
  ]);
  await new PostgresReimbursementSubmissionService(pool, store).submit(
    personal(applicantId), documentId,
    { expectedVersion: 1, amountCents: "100", reason: `HTTP撤销测试-${serial}`, attachmentVersionIds },
    `http-reverse-submit-${serial}`, at,
  );
  await new PostgresReimbursementReviewService(pool, store).approve(
    hq(financeId), documentId,
    { expectedVersion: 2, reason: "总部审核通过" }, `http-reverse-approve-${serial}`, at,
  );
  await new PostgresReimbursementTransferService(pool, store).execute(
    hq(financeId), documentId, { expectedVersion: 3 }, `http-reverse-execute-${serial}`, at,
  );
  return documentId;
};

test("普通报销撤销真实HTTP：严格身份和请求白名单、重放与反向两侧账务", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-reimbursement-reversal-http-"));
  let server;
  let unavailableServer;
  let at = new Date("2026-09-22T09:00:00.000Z");
  try {
    const [applicantId, financeId, adminId, ownerId, regionId, expiredId] = Array.from({ length: 6 }, () => randomUUID());
    for (const [id, name] of [[applicantId, "reverse-http-applicant"], [financeId, "reverse-http-hq"], [adminId, "reverse-http-admin"], [ownerId, "reverse-http-owner"], [regionId, "reverse-http-region"], [expiredId, "reverse-http-expired"]]) {
      await addPerson(db.pool, id, name);
    }
    const destinationAccountId = randomUUID();
    const sourceAccountId = randomUUID();
    const fundId = randomUUID();
    await db.pool.query(
      `INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status)
       VALUES($1::uuid,'PERSON',$2::uuid,$3,'ACTIVE'),($4::uuid,'COMPANY',$5::uuid,$6,'ACTIVE')`,
      [destinationAccountId, applicantId, `person:${applicantId}`, sourceAccountId, fundId, `company:fund:${fundId}`],
    );
    await db.pool.query(
      "INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1::uuid,20),($2::uuid,1000)",
      [destinationAccountId, sourceAccountId],
    );
    const assignmentId = randomUUID();
    for (const [personId, subject] of [[financeId, "HEADQUARTERS_FINANCE"], [adminId, "SYSTEM_ADMIN"], [ownerId, "SYSTEM_OWNER"]]) {
      await db.pool.query(
        `INSERT INTO role_assignment(id,person_id,subject_code,scope_type,scope_id,valid_from,valid_to,created_by,created_at)
         VALUES($1::uuid,$2::uuid,$3,'GLOBAL',NULL,$4::timestamptz,NULL,$2::uuid,$4::timestamptz)`,
        [randomUUID(), personId, subject, new Date("2026-01-01T00:00:00.000Z").toISOString()],
      );
    }
    await db.pool.query(
      `INSERT INTO company_finance_fund(id,kind,fund_code,display_name,status,version,created_by_person_id,created_at,updated_at)
       VALUES($1::uuid,'HEADQUARTERS_FINANCE_OPERATING','HQ_REVERSE_HTTP','撤销HTTP资金','ACTIVE',1,$2::uuid,$3::timestamptz,$3::timestamptz)`,
      [fundId, financeId, at.toISOString()],
    );
    await db.pool.query(
      `INSERT INTO company_finance_fund_assignment(id,fund_id,duty_subject,scope_type,scope_id,responsibility_code,valid_from,created_by_person_id,created_at)
       VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'FINANCE_OPERATING_SOURCE',$3::timestamptz,$4::uuid,$3::timestamptz)`,
      [assignmentId, fundId, new Date("2026-01-01T00:00:00.000Z").toISOString(), financeId],
    );
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    let sequence = 0;
    const sessions = new SessionService({
      accounts: [applicantId, financeId, adminId, ownerId, regionId, expiredId].map((personId, index) => ({
        accountId: personId, personId, phoneNormalized: `1390000000${index}`, credentialDigest: "synthetic-only", status: "ACTIVE",
      })),
      assignments: [
        { personId: applicantId, subject: "TEACHING_TEACHER", scope: "SELF", validFrom: new Date("2026-01-01") },
        { personId: financeId, subject: "HEADQUARTERS_FINANCE", scope: "GLOBAL", validFrom: new Date("2026-01-01") },
        { personId: adminId, subject: "SYSTEM_ADMIN", scope: "GLOBAL", validFrom: new Date("2026-01-01") },
        { personId: ownerId, subject: "SYSTEM_OWNER", scope: "GLOBAL", validFrom: new Date("2026-01-01") },
        { personId: regionId, subject: "REGION_FINANCE", scope: "REGION", regionId: randomUUID(), validFrom: new Date("2026-01-01") },
        { personId: expiredId, subject: "HEADQUARTERS_FINANCE", scope: "GLOBAL", validFrom: new Date("2026-01-01"), validTo: new Date("2026-09-22T09:00:00.000Z") },
      ],
      sessionIdFactory: () => `reverse-http-token-${++sequence}`,
    });
    for (let index = 0; index < 6; index += 1) {
      sessions.login(`1390000000${index}`, "synthetic-only", new Date("2026-09-21T09:00:00.000Z"));
    }
    for (const [index, subject] of ["TEACHING_TEACHER", "HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "SYSTEM_OWNER", "REGION_FINANCE", "HEADQUARTERS_FINANCE"].entries()) {
      sessions.switchRole(`reverse-http-token-${index + 1}`, subject, new Date("2026-09-21T09:00:00.000Z"));
    }
    const reversalService = new PostgresReimbursementReversalService(db.pool);
    server = createApiServer({
      sessions,
      weeklyFees: {},
      reimbursementReads: new PostgresReimbursementReadService(db.pool),
      reimbursementReversals: reversalService,
      now: () => at,
    });
    await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise); });
    const base = `http://127.0.0.1:${server.address().port}/v1/finance`;
    const request = (path, body, who = 2) => fetch(base + path, {
      method: "POST",
      headers: { ...(who === null ? {} : { authorization: `Bearer reverse-http-token-${who}` }), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const read = (path, who = 2) => fetch(base + path, {
      headers: who === null ? {} : { authorization: `Bearer reverse-http-token-${who}` },
    });
    const response = async (value) => ({ status: value.status, body: await value.json() });
    const success = async (value) => {
      const result = await response(value);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.body.data;
    };
    const documentId = await createCompleted({ pool: db.pool, store, applicantId, financeId, at, serial: "primary" });
    const path = `/reimbursements/${documentId}/reverse`;
    const command = { expectedVersion: 4, reason: "原内部划拨更正", idempotencyKey: "reverse-primary" };

    assert.equal((await request(path, command, null)).status, 401);
    assert.equal((await request(path, command, 1)).status, 403, "个人身份不可撤销");
    assert.equal((await request(path, command, 5)).status, 403, "分区身份不可撤销");
    for (const field of ["actorPersonId", "sourceAccountId", "destinationAccountId", "amountCents", "bankAccount"]) {
      assert.equal((await request(path, { ...command, [field]: randomUUID() }, 2)).status, 400, `${field} 不能由请求伪造`);
    }
    unavailableServer = createApiServer({ sessions, weeklyFees: {}, now: () => at });
    await new Promise((resolvePromise, reject) => { unavailableServer.once("error", reject); unavailableServer.listen(0, "127.0.0.1", resolvePromise); });
    const unavailable = await response(await fetch(`http://127.0.0.1:${unavailableServer.address().port}/v1/finance${path}`, {
      method: "POST", headers: { authorization: "Bearer reverse-http-token-2", "content-type": "application/json" }, body: JSON.stringify(command),
    }));
    assert.equal(unavailable.status, 503); assert.equal(unavailable.body.error.code, "FINANCE_SERVICE_UNAVAILABLE");
    await new Promise(resolvePromise => unavailableServer.close(resolvePromise)); unavailableServer = undefined;

    assert.deepEqual(await success(await request(path, command)), { id: documentId, status: "REVERSED", version: 5, replay: false });
    assert.deepEqual(await success(await request(path, command)), { id: documentId, status: "REVERSED", version: 5, replay: true });
    const managementDetail = await success(await read(`/reimbursements/${documentId}`, 2));
    assert.deepEqual({
      status: managementDetail.status,
      version: managementDetail.version,
      completedAt: managementDetail.completedAt,
      reversedAt: managementDetail.reversedAt,
      reversalReason: managementDetail.reversalReason,
    }, {
      status: "REVERSED",
      version: 5,
      completedAt: "2026-09-22T09:00:00.000Z",
      reversedAt: "2026-09-22T09:00:00.000Z",
      reversalReason: "原内部划拨更正",
    });
    assert.equal(managementDetail.management?.reversal?.sourceAccountId, sourceAccountId);
    assert.equal(managementDetail.management?.reversal?.destinationAccountId, destinationAccountId);
    const personalDetail = await success(await read(`/reimbursements/${documentId}`, 1));
    assert.deepEqual({
      status: personalDetail.status,
      version: personalDetail.version,
      reversedAt: personalDetail.reversedAt,
      reversalReason: personalDetail.reversalReason,
      attachmentPurposes: personalDetail.attachments.map((attachment) => attachment.purpose).sort(),
    }, {
      status: "REVERSED",
      version: 5,
      reversedAt: "2026-09-22T09:00:00.000Z",
      reversalReason: "原内部划拨更正",
      attachmentPurposes: ["APPLICATION_SCREENSHOT", "SUPPORTING_DOCUMENT"],
    });
    assert.equal(personalDetail.management, undefined, "个人详情不能看到执行或反向资金关系");
    assert.equal(JSON.stringify(personalDetail).includes(sourceAccountId), false, "个人详情不能泄露来源账户");
    assert.equal(JSON.stringify(personalDetail).includes(financeId), false, "个人详情不能泄露办理人");
    const ownList = await success(await read("/reimbursements/mine", 1));
    assert.deepEqual(ownList.documents.map(({ id, status, version, reversedAt, reversalReason }) => ({ id, status, version, reversedAt, reversalReason })), [{
      id: documentId,
      status: "REVERSED",
      version: 5,
      reversedAt: "2026-09-22T09:00:00.000Z",
      reversalReason: "原内部划拨更正",
    }]);
    const conflict = await response(await request(path, { ...command, reason: "同键篡改原因" }));
    assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, "IDEMPOTENCY_REPLAY");
    assert.equal((await request(path, { ...command, idempotencyKey: "reverse-secondary" })).status, 409, "新键不得二次撤销");
    const balances = await db.pool.query(
      "SELECT account_id::text AS id,balance_cents::text AS balance FROM account_balance_projection WHERE account_id=ANY($1::uuid[]) ORDER BY account_id",
      [[destinationAccountId, sourceAccountId]],
    );
    assert.deepEqual(Object.fromEntries(balances.rows.map(row => [row.id, row.balance])), { [sourceAccountId]: "1000", [destinationAccountId]: "20" });
    assert.deepEqual((await db.pool.query(
      "SELECT category_key,amount_cents::text AS amount FROM ledger_entry WHERE event_id=(SELECT reversal_ledger_event_id FROM finance_reimbursement_reversal WHERE finance_document_id=$1::uuid) ORDER BY category_key",
      [documentId],
    )).rows, [
      { category_key: "reimbursementExpenseReversal", amount: "100" },
      { category_key: "reimbursementIncomeReversal", amount: "-100" },
    ]);

    const adminDocument = await createCompleted({ pool: db.pool, store, applicantId, financeId, at, serial: "admin" });
    assert.equal((await success(await request(`/reimbursements/${adminDocument}/reverse`, { expectedVersion: 4, reason: "管理员更正", idempotencyKey: "reverse-admin" }, 3))).status, "REVERSED");
    const ownerDocument = await createCompleted({ pool: db.pool, store, applicantId, financeId, at, serial: "owner" });
    assert.equal((await success(await request(`/reimbursements/${ownerDocument}/reverse`, { expectedVersion: 4, reason: "开发者更正", idempotencyKey: "reverse-owner" }, 4))).status, "REVERSED");

    at = new Date("2026-09-22T09:00:01.000Z");
    const expiredDocument = await createCompleted({ pool: db.pool, store, applicantId, financeId, at, serial: "expired" });
    assert.equal((await request(`/reimbursements/${expiredDocument}/reverse`, { expectedVersion: 4, reason: "失效角色不得办理", idempotencyKey: "reverse-expired" }, 6)).status, 403);
  } finally {
    if (unavailableServer) await new Promise(resolvePromise => unavailableServer.close(resolvePromise));
    if (server) await new Promise(resolvePromise => server.close(resolvePromise));
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});
