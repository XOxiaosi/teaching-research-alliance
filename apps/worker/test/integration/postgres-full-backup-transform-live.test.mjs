import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createTestDatabase } from "../../../api/test/integration/postgres-test-database.mjs";
import { PostgresVenueService } from "../../../api/dist/postgres-venue-service.js";
import { PostgresFullBackupSource } from "../../dist/postgres-full-backup-source.js";
import { FullBackupTransformer } from "../../dist/full-backup-transformer.js";

const connectionString = process.env.DATABASE_URL;
const fingerprint = ({ domain, value }) => {
  // Test-only deterministic HMAC-shaped output; it proves transformer validation, not crypto strength.
  assert.equal(domain.includes("full-backup-transform.v1:"), true);
  assert.equal(value.length > 0, true);
  return "b".repeat(64);
};

test("真实 venue 写入器 → 同一只读 source → transformer 保留业务结果且排除命令原键", async () => {
  const database = await createTestDatabase(connectionString);
  try {
    const ownerId = randomUUID();
    const granteeId = randomUUID();
    await database.pool.query(
      "INSERT INTO person(id,nickname,legal_name,status,created_at,updated_at) VALUES($1::uuid,'备份转换所有者','备份转换所有者','ACTIVE',now(),now())",
      [ownerId],
    );
    await database.pool.query(
      "INSERT INTO person(id,nickname,legal_name,status,created_at,updated_at) VALUES($1::uuid,'备份转换获授权人','备份转换获授权人','ACTIVE',now(),now())",
      [granteeId],
    );
    await database.pool.query(
      "INSERT INTO teacher_profile(person_id,business_identity,employment_status,created_at,updated_at) VALUES($1::uuid,'TEACHING_TEACHER','ACTIVE',now(),now())",
      [granteeId],
    );
    const service = new PostgresVenueService(database.pool);
    const created = await service.create(
      { personId: ownerId, subject: "TEACHING_TEACHER", scope: "SELF" },
      { name: "真实写入场地", makeDefault: true },
      "real-writer-command-key",
      new Date("2026-09-23T00:00:00.000Z"),
    );
    const secondary = await service.create(
      { personId: ownerId, subject: "TEACHING_TEACHER", scope: "SELF" },
      { name: "真实默认切换场地", makeDefault: false },
      "real-writer-secondary-key",
      new Date("2026-09-23T00:01:00.000Z"),
    );
    await service.setDefault(
      { personId: ownerId, subject: "TEACHING_TEACHER", scope: "SELF" }, secondary.id,
      { expectedVersion: 1 }, "real-writer-default-key", new Date("2026-09-23T00:02:00.000Z"),
    );
    await service.setPermission(
      { personId: ownerId, subject: "TEACHING_TEACHER", scope: "SELF" }, secondary.id,
      { granteePersonId: granteeId, canView: true, canWithdraw: false }, "real-writer-permission-key", new Date("2026-09-23T00:03:00.000Z"),
    );
    const source = await new PostgresFullBackupSource(database.pool).open();
    try {
      const transformer = new FullBackupTransformer({ fingerprint });
      const commandStream = await source.openStream("venue_command_idempotency", 10);
      const commandBatch = await commandStream.next();
      assert.equal(commandBatch.done, false);
      const commands = commandBatch.value.rows;
      const command = commands.find((row) => row.exportValues.operation === "CREATE");
      assert.notEqual(command, undefined);
      const convertedCommand = await transformer.transformRow({ tableName: "venue_command_idempotency", exportValues: command.exportValues, transformValues: command.transformValues });
      assert.equal(convertedCommand.values.result_json.includes("真实写入场地"), true);
      assert.equal(JSON.stringify(convertedCommand.values).includes("real-writer-command-key"), false);
      assert.equal(convertedCommand.values.idempotency_key, undefined);
      assert.equal(convertedCommand.values.idempotency_key_fingerprint, "b".repeat(64));
      for (const operation of ["DEFAULT", "PERMISSION"]) {
        const row = commands.find((candidate) => candidate.exportValues.operation === operation);
        assert.notEqual(row, undefined);
        const converted = await transformer.transformRow({ tableName: "venue_command_idempotency", exportValues: row.exportValues, transformValues: row.transformValues });
        assert.equal(converted.values.result_json.includes("真实"), operation === "DEFAULT");
        const result = JSON.parse(converted.values.result_json);
        if (operation === "DEFAULT") assert.equal(result.previousDefaultVenueId, created.id);
        if (operation === "PERMISSION") assert.equal(result.venueId, secondary.id);
      }
    } finally {
      await source.close();
    }
    const auditSource = await new PostgresFullBackupSource(database.pool).open();
    try {
      const auditStream = await auditSource.openStream("audit_event", 10);
      const auditBatch = await auditStream.next();
      assert.equal(auditBatch.done, false);
      const audit = auditBatch.value.rows.find((row) => row.exportValues.action_code === "VENUE_PERMISSION_CHANGED");
      assert.notEqual(audit, undefined);
      const convertedAudit = await new FullBackupTransformer({ fingerprint }).transformRow({ tableName: "audit_event", exportValues: audit.exportValues, transformValues: audit.transformValues });
      assert.equal(JSON.parse(convertedAudit.values.after_json).venueId, secondary.id);
      assert.equal(convertedAudit.values.before_json, null);
    } finally {
      await auditSource.close();
    }
  } finally {
    await database.close();
  }
});
