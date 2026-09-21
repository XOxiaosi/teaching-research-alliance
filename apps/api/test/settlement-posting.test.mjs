import test from "node:test";
import assert from "node:assert/strict";
import { MemoryLedgerRepository } from "@teaching-research-alliance/domain";
import { SettlementPostingService } from "../dist/main.js";

const snapshot = (referrerAccount, teacherAccount, referrerCents, teacherCents) => ({
  lines: [
    { key: "referrer", cents: referrerCents },
    { key: "teachingTeacher", cents: teacherCents }
  ],
  accountByKey: {
    referrer: referrerAccount,
    teachingTeacher: teacherAccount
  }
});

test("周费用结算服务只提交新旧分配差额并支持事件重放", async () => {
  const repository = new MemoryLedgerRepository();
  const service = new SettlementPostingService(repository, () => "settlement-event-1");
  const first = await service.post({
    eventKey: "weekly-fee:settlement-1:v1",
    payloadHash: "payload-v1",
    next: snapshot("person-planner", "person-teacher", 8000n, 92000n)
  });
  assert.equal(first.status, "POSTED");
  assert.equal(repository.getBalance("person-planner"), 8000n);
  assert.equal(repository.getBalance("person-teacher"), 92000n);

  const corrected = await service.post({
    eventKey: "weekly-fee:settlement-1:v2",
    payloadHash: "payload-v2",
    previous: snapshot("person-planner", "person-teacher", 8000n, 92000n),
    next: snapshot("person-planner", "person-teacher", 9600n, 110400n)
  });
  assert.equal(corrected.status, "POSTED");
  assert.equal(repository.getBalance("person-planner"), 9600n);
  assert.equal(repository.getBalance("person-teacher"), 110400n);

  const replay = await service.post({
    eventKey: "weekly-fee:settlement-1:v2",
    payloadHash: "payload-v2",
    previous: snapshot("person-planner", "person-teacher", 8000n, 92000n),
    next: snapshot("person-planner", "person-teacher", 9600n, 110400n)
  });
  assert.equal(replay.status, "REPLAY");
  assert.equal(repository.getBalance("person-teacher"), 110400n);
});

test("结算收款人变化时同时冲旧账户并增加新账户", async () => {
  const repository = new MemoryLedgerRepository();
  const service = new SettlementPostingService(repository);
  await service.post({
    eventKey: "weekly-fee:settlement-recipient:v1",
    payloadHash: "recipient-v1",
    next: snapshot("planner-old", "person-teacher", 8000n, 92000n)
  });
  await service.post({
    eventKey: "weekly-fee:settlement-recipient:v2",
    payloadHash: "recipient-v2",
    previous: snapshot("planner-old", "person-teacher", 8000n, 92000n),
    next: snapshot("planner-new", "person-teacher", 8000n, 92000n)
  });
  assert.equal(repository.getBalance("planner-old"), 0n);
  assert.equal(repository.getBalance("planner-new"), 8000n);
});
