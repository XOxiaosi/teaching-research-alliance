import test from "node:test";
import assert from "node:assert/strict";
import { MemoryLedgerRepository, postLedgerEvent } from "../dist/index.js";

const delta = (accountKey, categoryKey, amountCents) => ({ accountKey, categoryKey, amountCents });

test("账本事务首次发布更新余额，重复同载荷只重放", async () => {
  const repository = new MemoryLedgerRepository();
  const command = {
    eventKey: "weekly-fee:version-1",
    eventType: "WEEKLY_FEE_ALLOCATION",
    payloadHash: "hash-1",
    deltas: [
      delta("person-teacher", "teachingTeacher", 72000n),
      delta("company-campus", "campusConsultation", 2000n)
    ]
  };
  const posted = await postLedgerEvent(repository, command, () => "event-1");
  assert.equal(posted.status, "POSTED");
  assert.equal(repository.getBalance("person-teacher"), 72000n);
  const replay = await postLedgerEvent(repository, command, () => "event-should-not-be-used");
  assert.equal(replay.status, "REPLAY");
  assert.equal(replay.event.eventId, "event-1");
  assert.equal(repository.getBalance("person-teacher"), 72000n);
});

test("事件载荷或类别变化拒绝重放，余额保持原值", async () => {
  const repository = new MemoryLedgerRepository();
  const command = {
    eventKey: "weekly-fee:version-2",
    eventType: "WEEKLY_FEE_ALLOCATION",
    payloadHash: "hash-2",
    deltas: [delta("person-teacher", "teachingTeacher", 10000n)]
  };
  await postLedgerEvent(repository, command, () => "event-2");
  await assert.rejects(
    () => postLedgerEvent(repository, { ...command, payloadHash: "hash-other" }, () => "event-other"),
    /LEDGER_EVENT_CONFLICT/
  );
  await assert.rejects(
    () => postLedgerEvent(repository, { ...command, deltas: [delta("person-teacher", "bonus", 10000n)] }, () => "event-other"),
    /LEDGER_EVENT_CONFLICT/
  );
  assert.equal(repository.getBalance("person-teacher"), 10000n);
});

test("事务失败时回滚已写入的事件和余额", async () => {
  const repository = new MemoryLedgerRepository();
  await assert.rejects(
    () => repository.transaction(async (transaction) => {
      transaction.insertEvent({
        eventId: "event-rollback",
        eventKey: "rollback",
        eventType: "TEST",
        payloadHash: "hash",
        deltas: [delta("person-teacher", "test", 1n)]
      });
      transaction.applyBalance("person-teacher", 1n);
      throw new Error("FORCE_ROLLBACK");
    }),
    /FORCE_ROLLBACK/
  );
  assert.equal(repository.findEvent("rollback"), undefined);
  assert.equal(repository.getBalance("person-teacher"), 0n);
});

test("空分录、缺类别和缺账户映射直接拒绝", async () => {
  const repository = new MemoryLedgerRepository();
  await assert.rejects(() => postLedgerEvent(repository, {
    eventKey: "empty",
    eventType: "TEST",
    payloadHash: "hash",
    deltas: []
  }), /LEDGER_EMPTY_EVENT/);
  await assert.rejects(() => postLedgerEvent(repository, {
    eventKey: "missing-category",
    eventType: "TEST",
    payloadHash: "hash",
    deltas: [delta("person-teacher", "", 1n)]
  }), /LEDGER_CATEGORY_REQUIRED/);
  await assert.rejects(() => postLedgerEvent(repository, {
    eventKey: "missing-account",
    eventType: "TEST",
    payloadHash: "hash",
    deltas: [delta("", "teachingTeacher", 1n)]
  }), /MISSING_ACCOUNT_MAPPING/);
});
