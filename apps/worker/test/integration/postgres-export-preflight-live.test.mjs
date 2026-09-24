import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase } from "../../../api/test/integration/postgres-test-database.mjs";
import { EXPORT_SCHEMA_REGISTRY } from "../../dist/export-schema-registry.js";
import { PostgresExportPreflight } from "../../dist/postgres-export-preflight.js";

const connectionString = process.env.DATABASE_URL;

const withDatabase = async (work) => {
  const database = await createTestDatabase(connectionString);
  try {
    await work(database);
  } finally {
    await database.close();
  }
};

const dataset = (plan, tableName) => {
  const value = plan.datasets.find((candidate) => candidate.tableName === tableName);
  assert.ok(value, `missing dataset ${tableName}`);
  return value;
};

test("export preflight classifies every migrated table and keeps secrets out of export plans", async () => {
  await withDatabase(async (database) => {
    const plan = await new PostgresExportPreflight(database.pool).open();
    try {
      assert.equal(plan.mode, "PRECHECK_ONLY");
      assert.equal(plan.snapshotId.length > 0, true);
      assert.equal(plan.datasets.length, 95);
      assert.deepEqual(plan.datasets.map((item) => item.tableName), EXPORT_SCHEMA_REGISTRY.map((item) => item.name));

      const allExportColumns = plan.datasets.flatMap((item) => item.exportColumns.map((column) => `${item.tableName}.${column}`));
      assert.equal(allExportColumns.includes("user_account.password_hash"), false);
      assert.equal(allExportColumns.includes("user_account.auth_version"), false);
      assert.equal(allExportColumns.some((column) => column.startsWith("user_session.")), false);
      assert.equal(allExportColumns.includes("finance_withdrawal_command_idempotency.request_hmac"), false);
      assert.equal(allExportColumns.includes("finance_withdrawal_command_idempotency.hmac_key_id"), false);
      assert.equal(allExportColumns.includes("ledger_event.payload_hash"), true);
      assert.equal(allExportColumns.includes("finance_attachment_version.sha256"), true);

      const sessions = dataset(plan, "user_session");
      assert.deepEqual(sessions.exportColumns, []);
      assert.equal(sessions.selectSql, undefined);
      assert.equal(sessions.secretExcludedColumns.length, 7);

      for (const tableName of ["auth_login_throttle", "auth_password_reset_command"]) {
        const secretDataset = dataset(plan, tableName);
        const registry = EXPORT_SCHEMA_REGISTRY.find((table) => table.name === tableName);
        assert.ok(registry);
        assert.deepEqual(secretDataset.exportColumns, []);
        assert.equal(secretDataset.selectSql, undefined);
        assert.deepEqual(secretDataset.secretExcludedColumns, registry.columns.map((column) => column.name));
        assert.equal(registry.columns.every((column) => column.disposition === "SECRET_EXCLUDED"), true);
      }

      const withdrawal = dataset(plan, "finance_withdrawal_submission");
      assert.equal(withdrawal.exportColumns.includes("recipient_ciphertext"), false);
      assert.deepEqual(
        withdrawal.transformColumns.filter((column) => column.startsWith("recipient_")),
        ["recipient_key_id", "recipient_nonce", "recipient_ciphertext", "recipient_auth_tag"]
      );

      const audit = dataset(plan, "audit_event");
      assert.equal(audit.exportColumns.includes("before_json"), false);
      assert.equal(audit.exportColumns.includes("after_json"), false);
      assert.deepEqual(audit.transformColumns, ["before_json", "after_json"]);
      assert.equal(dataset(plan, "bonus_project_catalog_command_idempotency").exportColumns.includes("result_json"), false);
      assert.equal(dataset(plan, "weekly_fee_allocation_snapshot").exportColumns.includes("context_json"), false);
      assert.equal(plan.datasets.every((item) => item.selectSql === undefined || !item.selectSql.includes("*")), true);

      const everyJsonColumn = EXPORT_SCHEMA_REGISTRY.flatMap((table) =>
        table.columns
          .filter((column) => column.name.endsWith("_json"))
          .map((column) => `${table.name}.${column.name}:${column.disposition}`)
      );
      assert.equal(everyJsonColumn.some((column) => column.endsWith(":EXPORT")), false);
      const idempotencyColumns = EXPORT_SCHEMA_REGISTRY
        .filter((table) => table.name.includes("idempotency"))
        .flatMap((table) => table.columns.map((column) => `${table.name}.${column.name}:${column.disposition}`));
      assert.equal(idempotencyColumns.some((column) => column.endsWith(".idempotency_key:EXPORT") || column.endsWith(".result_json:EXPORT")), false);
    } finally {
      await plan.close();
    }
  });
});

test("export preflight rejects an unknown table or an unregistered column", async (context) => {
  await context.test("unknown table", async () => {
    await withDatabase(async (database) => {
      await database.pool.query("CREATE TABLE export_unregistered_probe(id uuid PRIMARY KEY)");
      await assert.rejects(
        () => new PostgresExportPreflight(database.pool).open(),
        { message: "EXPORT_SCHEMA_MISMATCH" }
      );
    });
  });

  await context.test("unknown column", async () => {
    await withDatabase(async (database) => {
      await database.pool.query("ALTER TABLE person ADD COLUMN export_unregistered_probe text");
      await assert.rejects(
        () => new PostgresExportPreflight(database.pool).open(),
        { message: "EXPORT_SCHEMA_MISMATCH" }
      );
    });
  });
});

test("export preflight keeps a repeatable-read snapshot while concurrent writes commit", async () => {
  await withDatabase(async (database) => {
    const plan = await new PostgresExportPreflight(database.pool).open();
    try {
      assert.equal(await plan.countRows("person"), 0n);
      await database.pool.query(
        "INSERT INTO person(nickname,legal_name,status,created_at,updated_at) VALUES ($1,$2,$3,now(),now())",
        ["snapshot-check", "snapshot-check", "ACTIVE"]
      );
      assert.equal(await plan.countRows("person"), 0n);
      const committed = await database.pool.query("SELECT count(*)::text AS row_count FROM person");
      assert.equal(committed.rows[0].row_count, "1");
    } finally {
      await plan.close();
    }
  });
});
