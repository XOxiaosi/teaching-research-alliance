import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createTestDatabase } from "../../../api/test/integration/postgres-test-database.mjs";
import { PostgresAccountAccessService, PostgresSessionService } from "../../../api/dist/main.js";
import { FullBackupSpool } from "../../dist/full-backup-spool.js";
import { FullBackupTransformer } from "../../dist/full-backup-transformer.js";
import { FullBackupWorkbookExporter } from "../../dist/full-backup-workbook-exporter.js";
import { PostgresFullBackupSource } from "../../dist/postgres-full-backup-source.js";
import { readBackupSpoolDataset } from "../../dist/full-backup-spool-reader.js";

const connectionString = process.env.DATABASE_URL;

test("真实95表只读快照可流式spool，资料历史幂等键只保留指纹", async () => {
  const database = await createTestDatabase(connectionString);
  const tempRoot = await mkdtemp(join(tmpdir(), "alliance-spool-pg-"));
  try {
    const at = new Date("2026-09-23T01:00:00.000Z");
    const later = new Date("2026-09-23T01:01:00.000Z");
    const access = new PostgresAccountAccessService(database.pool);
    const owner = await access.register({
      nickname: "spool所有者",
      legalName: "spool所有者",
      phoneNormalized: "13800002901",
      password: "owner-spool-password",
    }, at);
    const target = await access.register({
      nickname: "spool普通成员",
      legalName: "spool普通成员",
      phoneNormalized: "13800002902",
      password: "target-spool-password",
    }, at);
    await database.pool.query(
      `INSERT INTO role_assignment(
         person_id,subject_code,scope_type,scope_id,valid_from,created_by,created_at
       ) VALUES($1::uuid,'SYSTEM_OWNER','GLOBAL',NULL,$2::timestamptz,$1::uuid,$2::timestamptz)`,
      [owner.session.personId, at.toISOString()],
    );
    const sessions = new PostgresSessionService(database.pool);
    const ownerSession = await sessions.switchRole(owner.session.sessionId, "SYSTEM_OWNER", later);
    await access.updatePersonProfile(ownerSession.currentRoleContext, target.session.personId, "spool普通成员新昵称", "spool普通成员新实名", "1", "备份资料更正", "spool-profile-command", later);
    await access.resetPassword(
      ownerSession.currentRoleContext,
      target.session.accountId,
      "replacement-spool-password",
      "合成备份重置",
      "spool-reset-command",
      later,
    );
    await assert.rejects(
      sessions.login("13900002999", "missing-spool-password", later, "192.0.2.29"),
      /UNAUTHENTICATED/,
    );
    const spool = await new FullBackupSpool({
      source: new PostgresFullBackupSource(database.pool),
      transformer: new FullBackupTransformer({
        fingerprint: ({ domain, value }) => createHash("sha256").update(`${domain}\u0000${value}`).digest("hex"),
      }),
      tempRoot,
      batchSize: 1,
    }).create();
    assert.equal(spool.mode, "RAW_SOURCE_SPOOL");
    assert.equal(spool.datasets.length, 95);
    for (const tableName of ["user_session", "auth_login_throttle", "auth_password_reset_command"]) {
      assert.deepEqual(spool.datasets.find((dataset) => dataset.tableName === tableName), {
        tableName, columns: [], rowCount: null, logicalDigest: null, spoolFile: null, excluded: true,
      });
    }
    const people = spool.datasets.find((dataset) => dataset.tableName === "person");
    assert.equal(people.rowCount, "2");
    const text = await readFile(join(tempRoot, spool.spoolId, people.spoolFile), "utf8");
    assert.equal(text.includes("spool所有者"), true);
    assert.equal(text.includes("spool普通成员"), true);
    assert.equal(text.split("\n").length, 4, "header plus two data rows");
    const profileHistory = spool.datasets.find((dataset) => dataset.tableName === "person_profile_change");
    assert.equal(profileHistory.rowCount, "1");
    const profileText = await readFile(join(tempRoot, spool.spoolId, profileHistory.spoolFile), "utf8");
    assert.equal(profileText.includes("spool-profile-command"), false);
    assert.equal(profileText.includes("idempotency_key_fingerprint"), true);
    const rawWorkbooks = await new FullBackupWorkbookExporter({
      spoolDirectory: join(tempRoot, spool.spoolId), spool, outputRoot: join(tempRoot, "workbooks"),
    }).export();
    const teacherWorkbook = rawWorkbooks.workbooks.find((workbook) => workbook.workbookId === "02");
    assert.ok(teacherWorkbook, "教师信息 RAW workbook must exist");
    const teacherWorkbookBytes = await readFile(join(tempRoot, "workbooks", rawWorkbooks.outputId, teacherWorkbook.file));
    assert.equal(teacherWorkbookBytes.includes(Buffer.from("spool-profile-command")), false);
    assert.equal(teacherWorkbookBytes.includes(Buffer.from("idempotency_key_fingerprint")), true);

    const auditDataset = spool.datasets.find((dataset) => dataset.tableName === "audit_event");
    const auditText = await readFile(join(tempRoot, spool.spoolId, auditDataset.spoolFile), "utf8");
    const [auditHeader, ...auditLines] = auditText.trimEnd().split("\n");
    const auditColumns = JSON.parse(auditHeader).columns;
    const audits = auditLines.map((line) => Object.fromEntries(
      auditColumns.map((column, index) => [column, JSON.parse(line)[index]]),
    ));
    const registrations = audits.filter((audit) => audit.action_code === "ACCOUNT_REGISTERED");
    assert.equal(registrations.length, 2);
    for (const registration of registrations) {
      assert.equal(registration.before_json, null);
      assert.deepEqual(JSON.parse(registration.after_json), { baseSubject: "TEACHER", scope: "SELF" });
    }
    const reset = audits.find((audit) => audit.action_code === "ACCOUNT_PASSWORD_RESET");
    assert.deepEqual(JSON.parse(reset.before_json), { authVersion: "1" });
    assert.deepEqual(JSON.parse(reset.after_json), { authVersion: "2" });
    for (const secret of ["owner-spool-password", "target-spool-password", "replacement-spool-password", "missing-spool-password", "spool-reset-command", "passwordHash", "password_hash"]) {
      assert.equal(auditText.includes(secret), false, `${secret} must not enter RAW audit output`);
    }
    for (const dataset of spool.datasets) {
      if (dataset.excluded) continue;
      let count = 0n;
      for await (const row of readBackupSpoolDataset(join(tempRoot, spool.spoolId), dataset)) {
        assert.equal(row.length, dataset.columns.length);
        count += 1n;
      }
      assert.equal(count.toString(), dataset.rowCount);
    }

    await database.pool.query(
      `INSERT INTO audit_event(
         actor_person_id,action_code,subject_type,subject_id,before_json,after_json,reason,created_at
       ) VALUES($1::uuid,'ACCOUNT_PASSWORD_RESET','USER_ACCOUNT',$2::uuid,
         '{"authVersion":"2"}'::jsonb,'{"authVersion":"3","passwordHash":"synthetic-secret"}'::jsonb,
         '恶意形状探针',$3::timestamptz)`,
      [owner.session.personId, target.session.accountId, later.toISOString()],
    );
    await assert.rejects(
      () => new FullBackupSpool({
        source: new PostgresFullBackupSource(database.pool),
        transformer: new FullBackupTransformer({
          fingerprint: ({ domain, value }) => createHash("sha256").update(`${domain}\u0000${value}`).digest("hex"),
        }),
        tempRoot,
        batchSize: 1,
      }).create(),
      { message: "EXPORT_TRANSFORM_SCHEMA_GAP" },
    );
    assert.equal((await readdir(tempRoot)).length, 2, "failed secret-bearing export leaves the successful spool and workbook output");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await database.close();
  }
});
