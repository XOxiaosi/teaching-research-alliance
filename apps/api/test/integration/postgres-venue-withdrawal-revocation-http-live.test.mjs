import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import {
  createApiServer,
  FinanceSensitiveFieldCrypto,
  LocalAttachmentStore,
  PostgresFinanceAttachmentReadService,
  PostgresFinanceAttachmentService,
  PostgresFinanceAttachmentUploadService,
  PostgresFinanceDraftService,
  PostgresVenueBoardReadService,
  PostgresVenueReadService,
  PostgresVenueService,
  PostgresWithdrawalReadService,
  PostgresWithdrawalService,
  SessionService,
} from "../../dist/main.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const teacherContext = (personId) => ({ personId, subject: "TEACHING_TEACHER", scope: "SELF" });

test("场地撤权即时收回旧会话读取和新提现，已提交幂等回放及财务撤回仍可追溯", async () => {
  const database = await createTestDatabase(process.env.DATABASE_URL);
  const { pool } = database;
  const root = await mkdtemp(join(tmpdir(), "alliance-venue-withdrawal-revocation-"));
  const initialAt = new Date("2026-09-23T04:00:00.000Z");
  let now = initialAt;
  const [ownerId, inviteeId, financeId] = [randomUUID(), randomUUID(), randomUUID()];
  let server;

  try {
    for (const [personId, label] of [[ownerId, "owner"], [inviteeId, "invitee"], [financeId, "finance"]]) {
      await pool.query(
        "INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,$2,'ACTIVE')",
        [personId, `venue-revoke-${label}`],
      );
    }
    for (const personId of [ownerId, inviteeId]) {
      await pool.query(
        "INSERT INTO teacher_profile(person_id,business_identity,employment_status) VALUES($1::uuid,'TEACHING_TEACHER','ACTIVE')",
        [personId],
      );
    }

    const venueService = new PostgresVenueService(pool);
    const venue = await venueService.create(
      teacherContext(ownerId),
      { name: "合成撤权场地", makeDefault: true },
      "venue-create",
      now,
    );
    await pool.query(
      "UPDATE account_balance_projection SET balance_cents=100000 WHERE account_id=$1::uuid",
      [venue.accountId],
    );
    const grant = await venueService.setPermission(
      teacherContext(ownerId),
      venue.id,
      { granteePersonId: inviteeId, canView: true, canWithdraw: true },
      "invitee-view-withdraw",
      now,
    );

    const tokens = ["venue-owner-old-token", "venue-invitee-old-token", "venue-finance-old-token"];
    let tokenIndex = 0;
    const sessions = new SessionService({
      accounts: [ownerId, inviteeId, financeId].map((personId, index) => ({
        accountId: personId,
        personId,
        phoneNormalized: `1390000010${index}`,
        credentialDigest: "synthetic-only",
        status: "ACTIVE",
      })),
      assignments: [
        { personId: ownerId, subject: "TEACHING_TEACHER", scope: "SELF", validFrom: new Date("2026-01-01T00:00:00.000Z") },
        { personId: inviteeId, subject: "TEACHING_TEACHER", scope: "SELF", validFrom: new Date("2026-01-01T00:00:00.000Z") },
        { personId: financeId, subject: "HEADQUARTERS_FINANCE", scope: "GLOBAL", validFrom: new Date("2026-01-01T00:00:00.000Z") },
      ],
      sessionIdFactory: () => tokens[tokenIndex++],
    });
    for (const [index, subject] of ["TEACHING_TEACHER", "TEACHING_TEACHER", "HEADQUARTERS_FINANCE"].entries()) {
      sessions.login(`1390000010${index}`, "synthetic-only", now);
      sessions.switchRole(tokens[index], subject, now);
    }

    const store = await LocalAttachmentStore.create(root, fileURLToPath(new URL("../../../../", import.meta.url)));
    const crypto = new FinanceSensitiveFieldCrypto("synthetic", { synthetic: randomBytes(32).toString("hex") });
    server = createApiServer({
      sessions,
      weeklyFees: {},
      venues: venueService,
      venueReads: new PostgresVenueReadService(pool),
      venueBoards: new PostgresVenueBoardReadService(pool),
      financeDrafts: new PostgresFinanceDraftService(pool),
      financeAttachments: new PostgresFinanceAttachmentService(pool),
      financeAttachmentUploads: new PostgresFinanceAttachmentUploadService(pool, store),
      financeAttachmentReads: new PostgresFinanceAttachmentReadService(pool, store),
      withdrawals: new PostgresWithdrawalService(pool, store, crypto),
      withdrawalReads: new PostgresWithdrawalReadService(pool, crypto),
      now: () => now,
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const base = `http://127.0.0.1:${server.address().port}/v1`;
    const request = (path, body, token = tokens[1]) => fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const success = async (response) => {
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
      return (await response.json()).data;
    };

    // 同一枚受邀人旧 token 在撤权前，可读目录、看板和可提现资金来源。
    assert.equal((await success(await request("/venues/visible"))).some((item) => item.id === venue.id), true);
    assert.equal((await success(await request(`/venues/${venue.id}/board?startsOn=2026-09-01&endsOn=2026-09-30`))).venue.id, venue.id);
    assert.equal((await success(await request("/finance/withdrawals/sources"))).some((item) => item.accountId === venue.accountId), true);

    const frozenDraft = await success(await request("/finance/drafts", { kind: "WITHDRAWAL", idempotencyKey: "frozen-draft" }));
    const payableDraft = await success(await request("/finance/drafts", { kind: "WITHDRAWAL", idempotencyKey: "payable-draft" }));
    const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
    const reserveAndUpload = async (purpose, key) => {
      const reservation = await success(await request(
        `/finance/drafts/${payableDraft.id}/attachment-uploads`,
        { purpose, originalFilename: "合成凭证.png", declaredMediaType: "image/png", declaredSizeBytes: png.length, idempotencyKey: key },
      ));
      const upload = await fetch(`${base}/finance/attachment-uploads/${reservation.versionId}/content`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokens[1]}`, "content-type": "image/png" },
        body: png,
      });
      await success(upload);
      return reservation.versionId;
    };
    const [supporting, screenshot] = await Promise.all([
      reserveAndUpload("SUPPORTING_DOCUMENT", "supporting"),
      reserveAndUpload("APPLICATION_SCREENSHOT", "screenshot"),
    ]);
    const submit = {
      expectedVersion: 1,
      sourceAccountId: venue.accountId,
      amountCents: "60000",
      recipientName: "合成收款人",
      bankAccount: "00123400",
      bankName: "合成银行",
      attachmentVersionIds: [supporting, screenshot],
      idempotencyKey: "payable-submit-response-lost",
    };
    // 服务端已成功提交；测试刻意不读取响应体，模拟客户端在收到响应前断开。
    const firstSubmit = await request(`/finance/drafts/${payableDraft.id}/withdrawal-submit`, submit);
    assert.equal(firstSubmit.status, 200);
    assert.equal((await pool.query("SELECT balance_cents::text AS amount FROM account_balance_projection WHERE account_id=$1::uuid", [venue.accountId])).rows[0].amount, "40000");
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM ledger_event WHERE event_type='WITHDRAWAL_DEBIT'")).rows[0].count, 1);

    now = new Date(initialAt.getTime() + 1_000);
    await venueService.setPermission(
      teacherContext(ownerId),
      venue.id,
      { granteePersonId: inviteeId, canView: false, canWithdraw: false, expectedGrantId: grant.id },
      "invitee-revoked",
      now,
    );

    // 撤权只改变当前授权：旧 token 仍有效，但已不能看见场地或以其账户新提交。
    assert.equal((await success(await request("/venues/visible"))).some((item) => item.id === venue.id), false);
    assert.equal((await request(`/venues/${venue.id}/board?startsOn=2026-09-01&endsOn=2026-09-30`)).status, 404);
    assert.equal((await success(await request("/finance/withdrawals/sources"))).some((item) => item.accountId === venue.accountId), false);
    const frozenAttempt = await request(`/finance/drafts/${frozenDraft.id}/withdrawal-submit`, {
      ...submit,
      idempotencyKey: "frozen-submit-after-revoke",
      attachmentVersionIds: [randomUUID(), randomUUID()],
    });
    assert.equal(frozenAttempt.status, 403);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM finance_withdrawal_submission WHERE finance_document_id=$1::uuid", [frozenDraft.id])).rows[0].count, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM ledger_event WHERE event_type='WITHDRAWAL_DEBIT'")).rows[0].count, 1);

    // 已承诺的同键命令优先幂等回放；重新鉴权不能引发第二次扣款。
    const replay = await success(await request(`/finance/drafts/${payableDraft.id}/withdrawal-submit`, submit));
    assert.equal(replay.replay, true);
    assert.equal(replay.status, "PENDING_TRANSFER");
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM ledger_event WHERE event_type='WITHDRAWAL_DEBIT'")).rows[0].count, 1);
    assert.equal((await pool.query("SELECT balance_cents::text AS amount FROM account_balance_projection WHERE account_id=$1::uuid", [venue.accountId])).rows[0].amount, "40000");

    // 撤权不抹掉申请人的历史凭证；但受邀人也绝无总部财务办理权。
    assert.equal((await success(await request(`/finance/withdrawals/${payableDraft.id}`))).id, payableDraft.id);
    assert.equal((await request(`/finance/withdrawals/${payableDraft.id}/finance-revoke`, {
      expectedVersion: 2,
      reason: "受邀人越权撤回",
      idempotencyKey: "invitee-finance-revoke",
    })).status, 403);

    const revoked = await success(await request(`/finance/withdrawals/${payableDraft.id}/finance-revoke`, {
      expectedVersion: 2,
      reason: "场地授权已撤回，退还原场地账户",
      idempotencyKey: "finance-revoke-after-venue-revoke",
    }, tokens[2]));
    assert.equal(revoked.status, "FINANCE_REVOKED");
    assert.equal((await pool.query("SELECT balance_cents::text AS amount FROM account_balance_projection WHERE account_id=$1::uuid", [venue.accountId])).rows[0].amount, "100000");
    assert.equal((await pool.query("SELECT source_owner_type FROM finance_withdrawal_submission WHERE finance_document_id=$1::uuid", [payableDraft.id])).rows[0].source_owner_type, "VENUE");
    assert.equal((await request(`/finance/withdrawals/${payableDraft.id}/mark-transferred`, {
      expectedVersion: 3,
      attachmentVersionIds: [randomUUID()],
      idempotencyKey: "transfer-after-revoke",
    }, tokens[2])).status, 409);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
