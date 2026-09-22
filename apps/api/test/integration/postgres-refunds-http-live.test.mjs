import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PNG } from "pngjs";
import {
  createApiServer,
  SessionService,
  PostgresFinanceAttachmentReadService,
  PostgresFinanceAttachmentService,
  PostgresFinanceAttachmentUploadService,
  PostgresFinanceDraftService,
  PostgresRefundReadService,
  PostgresRefundReviewService,
  PostgresRefundSubmissionService
} from "../../dist/main.js";
import { fixture } from "./refund-review-fixture.mjs";

test("退款真实HTTP：本人提交原件、总部审核冲回、严格读取与跨年幂等恢复", async () => {
  const seeded = await fixture();
  let server;
  let now = seeded.at ?? new Date("2026-09-21T09:00:00.000Z");
  try {
    const people = [seeded.ids.teacherA, seeded.ids.hq, seeded.ids.admin, seeded.ids.teacherB];
    const subjects = ["TEACHING_TEACHER", "HEADQUARTERS_FINANCE", "SYSTEM_ADMIN", "TEACHING_TEACHER"];
    let sequence = 0;
    const sessions = new SessionService({
      accounts: people.map((personId, index) => ({
        accountId: personId,
        personId,
        phoneNormalized: `1360000000${index}`,
        credentialDigest: "synthetic-only",
        status: "ACTIVE"
      })),
      assignments: people.map((personId, index) => ({
        personId,
        subject: subjects[index],
        scope: index === 1 || index === 2 ? "GLOBAL" : "SELF",
        validFrom: new Date("2026-01-01T00:00:00Z")
      })),
      sessionIdFactory: () => `refund-token-${++sequence}`
    });
    for (let index = 0; index < people.length; index += 1) {
      sessions.login(`1360000000${index}`, "synthetic-only", now);
      sessions.switchRole(`refund-token-${index + 1}`, subjects[index], now);
    }
    server = createApiServer({
      sessions,
      weeklyFees: {},
      financeDrafts: new PostgresFinanceDraftService(seeded.pool),
      financeAttachments: new PostgresFinanceAttachmentService(seeded.pool),
      financeAttachmentUploads: new PostgresFinanceAttachmentUploadService(seeded.pool, seeded.store),
      financeAttachmentReads: new PostgresFinanceAttachmentReadService(seeded.pool, seeded.store),
      refunds: new PostgresRefundSubmissionService(seeded.pool, seeded.store),
      refundReviews: new PostgresRefundReviewService(seeded.pool, seeded.store),
      refundReads: new PostgresRefundReadService(seeded.pool),
      now: () => now
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}/v1/finance`;
    const request = (path, body, who = 1) => fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer refund-token-${who}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const success = async (response) => {
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
      return (await response.json()).data;
    };
    const bytes = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 141) });
    const create = async (key) => {
      const draft = await success(await request("/drafts", { kind: "REFUND", idempotencyKey: key }));
      const versions = [];
      for (const purpose of ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT"]) {
        const reserved = await success(await request(`/drafts/${draft.id}/attachment-uploads`, {
          purpose,
          originalFilename: "合成退款凭证.png",
          declaredMediaType: "image/png",
          declaredSizeBytes: bytes.length,
          idempotencyKey: `${key}:${purpose}`
        }));
        await success(await fetch(`${base}/attachment-uploads/${reserved.versionId}/content`, {
          method: "POST",
          headers: { authorization: "Bearer refund-token-1", "content-type": "image/png" },
          body: bytes
        }));
        versions.push(reserved.versionId);
      }
      return { draft, versions };
    };

    const { draft, versions } = await create("refund-http:approve-draft");
    const command = {
      expectedVersion: 1,
      weeklyFeeEntryIds: [seeded.refundFee.fee.id],
      reason: "家长线下退款",
      attachmentVersionIds: versions,
      idempotencyKey: "refund-http:submit"
    };
    const submitPath = `/drafts/${draft.id}/refund-submit`;
    assert.equal((await fetch(base + submitPath, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command)
    })).status, 401);
    for (const extra of ["amountCents", "bankAccount", "personId", "sourceAccountId"]) {
      assert.equal((await request(submitPath, { ...command, [extra]: "1" })).status, 400);
    }
    assert.equal((await request(submitPath, { ...command, weeklyFeeEntryIds: seeded.refundFee.fee.id })).status, 400);
    assert.equal((await request(submitPath, command, 4)).status, 404);
    const submitted = await success(await request(submitPath, command));
    assert.equal(submitted.status, "PENDING_APPROVAL");
    assert.equal((await success(await request(submitPath, command))).replay, true);
    assert.equal((await request(submitPath, { ...command, reason: "同key篡改" })).status, 409);

    const mine = await success(await request("/refunds/mine"));
    assert.equal(mine.documents.length, 1);
    assert.equal(mine.documents[0].submittedGrossAmountCents, "100000");
    const ownDetail = await success(await request(`/refunds/${draft.id}`));
    assert.equal(ownDetail.attachments.length, 2);
    assert.equal(ownDetail.selectedFees[0].refundStatus, "ACTIVE");
    assert.equal(ownDetail.management, undefined);
    assert.equal((await request(`/refunds/${draft.id}`, undefined, 4)).status, 404);
    assert.equal((await request("/refunds/managed")).status, 403);
    assert.equal((await success(await request("/refunds/managed", undefined, 3))).documents.length, 1);
    const attachmentList = await success(await request(`/documents/${draft.id}/attachments`));
    assert.deepEqual(
      attachmentList.attachments.flatMap(slot => slot.versions).map(version => version.binding.stage),
      ["SUBMISSION", "SUBMISSION"]
    );
    const download = await fetch(`${base}/attachments/${versions[0]}/content`, {
      headers: { authorization: "Bearer refund-token-2" }
    });
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);

    const review = { expectedVersion: 2, reason: "原件核对通过", idempotencyKey: "refund-http:approve" };
    const approvePath = `/refunds/${draft.id}/approve`;
    assert.equal((await request(approvePath, review)).status, 403);
    assert.equal((await request(approvePath, review, 3)).status, 403);
    assert.equal((await request(approvePath, { ...review, amountCents: "1" }, 2)).status, 400);
    const before = await seeded.balances();
    const approved = await success(await request(approvePath, review, 2));
    assert.equal(approved.status, "REFUNDED");
    const after = await seeded.balances();
    assert.notDeepEqual(after, before);
    assert.equal((await success(await request(approvePath, review, 2))).replay, true);
    assert.deepEqual(await seeded.balances(), after);
    assert.equal((await request(`/refunds/${draft.id}/reject`, {
      expectedVersion: 2, reason: "过期驳回", idempotencyKey: "refund-http:late-reject"
    }, 2)).status, 409);
    assert.equal((await seeded.pool.query(
      "SELECT count(*)::int AS count FROM ledger_event WHERE event_type='WEEKLY_FEE_REFUND'"
    )).rows[0].count, 1);
    assert.equal((await seeded.pool.query(
      "SELECT count(*)::int AS count FROM weekly_fee_refund_effect WHERE finance_document_id=$1::uuid",
      [draft.id]
    )).rows[0].count, 1);
    const managedDetail = await success(await request(`/refunds/${draft.id}`, undefined, 2));
    assert.equal(managedDetail.decision.decision, "APPROVED");
    assert.equal(managedDetail.selectedFees[0].refundStatus, "REFUNDED");
    assert.equal(managedDetail.management.decisionActorSubject, "HEADQUARTERS_FINANCE");
    assert.ok(managedDetail.management.ledgerEventId);

    now = new Date("2027-09-01T00:00:00.000Z");
    assert.equal((await success(await request("/refunds/mine"))).documents.length, 0);
    assert.equal((await request(`/refunds/${draft.id}`)).status, 404);
    assert.equal((await request(`/documents/${draft.id}/attachments`)).status, 404);
    assert.equal((await success(await request(submitPath, command))).replay, true);
    assert.equal((await success(await request(approvePath, review, 2))).replay, true);
    assert.equal((await success(await request(`/refunds/${draft.id}`, undefined, 3))).decision.decision, "APPROVED");
    assert.equal((await success(await request(`/documents/${draft.id}/attachments`, undefined, 3))).attachments.length, 2);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await seeded.close();
  }
});
