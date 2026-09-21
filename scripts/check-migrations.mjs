import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const directory = new URL("../database/migrations/", import.meta.url);
const files = (await readdir(directory)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
if (files.length === 0) throw new Error("NO_MIGRATIONS");
let previous = -1;
for (const file of files) {
  const match = /^(\d+)_/.exec(file);
  const number = Number(match?.[1]);
  if (!Number.isInteger(number) || number <= previous) throw new Error(`MIGRATION_ORDER:${file}`);
  previous = number;
  const sql = await readFile(join(directory.pathname, file), "utf8");
  const createsTable = /\bCREATE\s+TABLE\b/i.test(sql);
  const altersTable = /\bALTER\s+TABLE\b/i.test(sql);
  if ((!createsTable && !altersTable) || (createsTable && !sql.includes("created_at"))) {
    throw new Error(`MIGRATION_SHAPE:${file}`);
  }
}
const organizationMigration = await readFile(join(directory.pathname, "0002_organization_relationships.sql"), "utf8");
for (const required of ["person_campus_assignment", "btree_gist", "EXCLUDE USING gist", "one_default_venue_per_owner"]) {
  if (!organizationMigration.includes(required)) throw new Error(`MIGRATION_CONSTRAINT:${required}`);
}
const weeklyFeeMigration = await readFile(join(directory.pathname, "0003_referrals_periods_weekly_fees.sql"), "utf8");
for (const required of ["teacher_student_record", "referral_case", "teaching_week", "weekly_fee_entry", "UNIQUE (referral_case_id, teaching_week_id)", "weekly_fee_settlement_month_guard", "WEEKLY_FEE_SETTLEMENT_MONTH_MISMATCH"]) {
  if (!weeklyFeeMigration.includes(required)) throw new Error(`MIGRATION_SHAPE:${required}`);
}
const ledgerMigration = await readFile(join(directory.pathname, "0004_ledger.sql"), "utf8");
for (const required of ["ledger_event", "ledger_entry", "account_balance_projection", "payload_hash", "ledger_event_immutable", "ledger_entry_immutable", "LEDGER_IMMUTABLE"]) {
  if (!ledgerMigration.includes(required)) throw new Error(`MIGRATION_SHAPE:${required}`);
}
const weeklyFeeHistoryMigration = await readFile(join(directory.pathname, "0005_weekly_fee_history.sql"), "utf8");
for (const required of ["weekly_fee_entry_version", "weekly_fee_idempotency", "weekly_fee_entry_version_snapshot", "snapshot_weekly_fee_entry_version", "status IN ('OPEN', 'LOCKED')"]) {
  if (!weeklyFeeHistoryMigration.includes(required)) throw new Error(`MIGRATION_SHAPE:${required}`);
}
const settlementMigration = await readFile(join(directory.pathname, "0006_settlement_snapshots.sql"), "utf8");
for (const required of ["rate_policy_version", "settlement_calculation_run", "weekly_fee_allocation_snapshot", "sequence_no", "snapshot_json", "context_json"]) {
  if (!settlementMigration.includes(required)) throw new Error(`MIGRATION_SHAPE:${required}`);
}
const systemEventsMigration = await readFile(join(directory.pathname, "0010_referral_system_events.sql"), "utf8");
for (const required of ["referral_case_event_actor_consistency", "actor_type = 'SYSTEM' AND actor_person_id IS NULL", "referral_case_event_immutable", "referral_case_unaccepted_expiry_lookup"]) {
  if (!systemEventsMigration.includes(required)) throw new Error(`MIGRATION_CONSTRAINT:${required}`);
}
console.log(`checked ${files.length} migration(s)`);
