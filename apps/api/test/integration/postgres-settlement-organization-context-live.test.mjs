import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./refund-review-fixture.mjs";

test("分区分润为零仍保留有效历史校区归属，不回写旧结算快照", async () => {
  const f = await fixture();
  try {
    const read = async () => (await f.pool.query("SELECT context_json FROM weekly_fee_allocation_snapshot WHERE weekly_fee_entry_id=$1::uuid ORDER BY sequence_no", [f.refundFee.fee.id])).rows;
    const original = await read();
    assert.equal(original.at(-1).context_json.organization.receiverCampusAssignment, null);
    const region = randomUUID(), campus = randomUUID(), assignment = randomUUID();
    await f.pool.query("INSERT INTO organization_unit(id,unit_type,name) VALUES($1::uuid,'REGION','零分润分区'),($2::uuid,'CAMPUS','历史校区')", [region, campus]);
    await f.pool.query("INSERT INTO person_campus_assignment(id,person_id,campus_id,region_id,valid_from,created_by) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'2026-01-01T00:00:00Z',$5::uuid)", [assignment, f.ids.teacherA, campus, region, f.ids.admin]);
    await f.record(120000n, "zero-region-context");
    const snapshots = await read();
    assert.deepEqual(snapshots.slice(0, original.length), original);
    assert.equal(snapshots.at(-1).context_json.resolvedRates.regionFinanceRateBasisPoints, "0");
    assert.deepEqual(snapshots.at(-1).context_json.organization.receiverCampusAssignment, { id: assignment, campus_id: campus, region_id: region });
  } finally { await f.close(); }
});
