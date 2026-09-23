import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresVenueService } from "../../dist/postgres-venue-service.js";
import { PostgresVenueReadService } from "../../dist/postgres-venue-read-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const at = new Date("2026-09-21T04:00:00.000Z");
const context = personId => ({ personId, subject: "TEACHING_TEACHER", scope: "SELF" });
const insertTeacher = async (pool, id, label) => {
  await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,$2,'ACTIVE')", [id, `venue-${label}-${id}`]);
  await pool.query("INSERT INTO teacher_profile(person_id,business_identity,employment_status) VALUES($1,'TEACHING_TEACHER','ACTIVE')", [id]);
};

test("场地创建建立独立账户，默认切换、权限历史和幂等均由事务保证", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL); const { pool } = db;
  const owner = randomUUID(); const guest = randomUUID(); const outsider = randomUUID();
  try {
    await insertTeacher(pool, owner, "owner"); await insertTeacher(pool, guest, "guest"); await insertTeacher(pool, outsider, "outsider");
    const service = new PostgresVenueService(pool); const reads = new PostgresVenueReadService(pool);
    const first = await service.create(context(owner), { name: "刘老师场地", makeDefault: true }, "create-1", at);
    assert.equal(first.defaultForOwner, true); assert.equal(first.accountCode, `venue:${first.id}`); assert.equal(first.replay, false);
    assert.equal((await pool.query("SELECT balance_cents::text AS balance FROM account_balance_projection WHERE account_id=$1", [first.accountId])).rows[0].balance, "0");
    assert.deepEqual(await service.create(context(owner), { name: "刘老师场地", makeDefault: true }, "create-1", new Date(at.getTime() + 1000)), { ...first, replay: true });
    const second = await service.create(context(owner), { name: "周老师场地", makeDefault: true }, "create-2", new Date(at.getTime() + 2000));
    assert.equal(second.defaultForOwner, true); assert.equal((await pool.query("SELECT default_for_owner,version FROM venue WHERE id=$1", [first.id])).rows[0].default_for_owner, false);
    const renamed = await service.rename(context(owner), first.id, { name: "刘老师新场地", expectedVersion: first.version + 1 }, "rename-1", new Date(at.getTime() + 3000));
    assert.equal(renamed.name, "刘老师新场地");
    await assert.rejects(service.rename(context(outsider), first.id, { name: "越权", expectedVersion: renamed.version }, "bad", new Date(at.getTime() + 4000)), /VENUE_NOT_FOUND/);
    const grant = await service.setPermission(context(owner), first.id, { granteePersonId: guest, canView: true, canWithdraw: false }, "grant-1", new Date(at.getTime() + 5000));
    assert.equal(grant.canView, true); assert.equal(grant.canWithdraw, false);
    const listed = await reads.list(context(guest), new Date(at.getTime() + 6000)); assert.equal(listed.some(row => row.id === first.id), true);
    assert.equal("accountId" in listed.find(row => row.id === first.id), false);
    assert.equal(listed.find(row => row.id === first.id).canView, true);
    assert.equal(listed.find(row => row.id === first.id).canWithdraw, false);
    for (const subject of ["ACADEMIC_PLANNER", "PLANNING_MENTOR"]) {
      const personalBoards = await reads.list({ ...context(guest), subject }, new Date(at.getTime() + 6000));
      assert.equal(personalBoards.length, 1);
      assert.equal(personalBoards[0].id, first.id);
      assert.equal("balanceCents" in personalBoards[0], false);
    }
    assert.deepEqual(await reads.list(context(outsider), new Date(at.getTime() + 6000)), []);

    assert.equal("accountId" in (await reads.get(context(owner), first.id, new Date(at.getTime() + 6000))), true);
    await assert.rejects(reads.get(context(outsider), first.id, new Date(at.getTime() + 6000)), /VENUE_NOT_FOUND/);
    const revoked = await service.setPermission(context(owner), first.id, { granteePersonId: guest, canView: false, canWithdraw: false, expectedGrantId: grant.id }, "grant-2", new Date(at.getTime() + 7000));
    assert.equal(revoked.canView, false); assert.equal((await reads.list(context(guest), new Date(at.getTime() + 8000))).some(row => row.id === first.id), false);
    await service.setStatus(context(owner), first.id, { status: "INACTIVE", expectedVersion: renamed.version }, "off-1", new Date(at.getTime() + 9000));
    assert.equal((await reads.listOwned(context(owner), new Date(at.getTime() + 10000))).find(row => row.id === first.id).status, "INACTIVE");
    await service.setPermission(context(owner), first.id, { granteePersonId: guest, canView: true, canWithdraw: true }, "grant-3", new Date(at.getTime() + 11000));
    assert.deepEqual(await reads.list(context(guest), new Date(at.getTime() + 10000)), []);
    const sharedWithdrawal = await reads.list(context(guest), new Date(at.getTime() + 12000));
    assert.equal(sharedWithdrawal[0].id, first.id);
    assert.equal(sharedWithdrawal[0].status, "INACTIVE");
    assert.equal(sharedWithdrawal[0].canView, true);
    assert.equal(sharedWithdrawal[0].canWithdraw, true);
    assert.equal(sharedWithdrawal[0].accountId, first.accountId);
    assert.equal(sharedWithdrawal[0].balanceCents, "0");
  } finally { await db.close(); }
});
