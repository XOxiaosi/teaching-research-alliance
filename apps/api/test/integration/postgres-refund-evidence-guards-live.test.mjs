import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fixture } from "./refund-review-fixture.mjs";

const at = new Date("2026-09-21T09:00:00.000Z");

test("退款终态事件必须精确绑定审核决定，驳回单不产生退款effect", async () => {
  const f = await fixture();
  try {
    const approved = await f.pending();
    await f.approve(approved, "approved-guard");
    const decision = (await f.pool.query(
      `SELECT decided_by_person_id::text AS actor,decided_at::text AS decided_at,
              result_document_version::text AS version,ledger_event_id::text AS ledger_event_id
         FROM finance_refund_decision WHERE finance_document_id=$1::uuid`, [approved.id]
    )).rows[0];
    await f.pool.query("ALTER TABLE finance_document_event DISABLE TRIGGER finance_document_event_immutable");
    try { await f.pool.query("DELETE FROM finance_document_event WHERE finance_document_id=$1::uuid AND event_type='REFUND_APPROVED'", [approved.id]); }
    finally { await f.pool.query("ALTER TABLE finance_document_event ENABLE TRIGGER finance_document_event_immutable"); }
    const insertEvent = (actor, createdAt, ledgerEventId) => f.pool.query(
      `INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,ledger_event_id,details_json,created_at)
       VALUES($1::uuid,'REFUND_APPROVED',$2::uuid,$3::bigint,$4::uuid,'{}'::jsonb,$5::timestamptz)`,
      [approved.id, actor, decision.version, ledgerEventId, createdAt]
    );
    await assert.rejects(insertEvent(randomUUID(), decision.decided_at, decision.ledger_event_id), /FINANCE_REFUND_APPROVAL_EVENT_INVALID/);
    await assert.rejects(insertEvent(decision.actor, new Date(at.getTime() + 1).toISOString(), decision.ledger_event_id), /FINANCE_REFUND_APPROVAL_EVENT_INVALID/);
    await assert.rejects(insertEvent(decision.actor, decision.decided_at, null), /FINANCE_REFUND_APPROVAL_EVENT_INVALID/);
    await insertEvent(decision.actor, decision.decided_at, decision.ledger_event_id);
    await assert.rejects(insertEvent(decision.actor, decision.decided_at, decision.ledger_event_id), /FINANCE_REFUND_APPROVAL_EVENT_INVALID/);

    const rejected = await f.pending([f.activeA.fee.id]);
    await f.review.reject(f.hqContext, rejected.id, { expectedVersion: 2, reason: "凭证无法通过" }, "rejected-guard", at);
    assert.equal((await f.pool.query("SELECT count(*)::int AS count FROM weekly_fee_refund_effect WHERE finance_document_id=$1::uuid", [rejected.id])).rows[0].count, 0);
    const rejectedDecision = (await f.pool.query("SELECT decided_by_person_id::text AS actor,decided_at::text AS decided_at,result_document_version::text AS version FROM finance_refund_decision WHERE finance_document_id=$1::uuid", [rejected.id])).rows[0];
    await f.pool.query("ALTER TABLE finance_document_event DISABLE TRIGGER finance_document_event_immutable");
    try { await f.pool.query("DELETE FROM finance_document_event WHERE finance_document_id=$1::uuid AND event_type='REFUND_REJECTED'", [rejected.id]); }
    finally { await f.pool.query("ALTER TABLE finance_document_event ENABLE TRIGGER finance_document_event_immutable"); }
    const insertRejected = actor => f.pool.query(
      `INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,ledger_event_id,details_json,created_at)
       VALUES($1::uuid,'REFUND_REJECTED',$2::uuid,$3::bigint,NULL,'{}'::jsonb,$4::timestamptz)`,
      [rejected.id, actor, rejectedDecision.version, rejectedDecision.decided_at]
    );
    await assert.rejects(insertRejected(randomUUID()), /FINANCE_REFUND_APPROVAL_EVENT_INVALID/);
    await insertRejected(rejectedDecision.actor);
    await assert.rejects(insertRejected(rejectedDecision.actor), /FINANCE_REFUND_APPROVAL_EVENT_INVALID/);
  } finally { await f.close(); }
});
