import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestDatabase } from "../../../api/test/integration/postgres-test-database.mjs";
import { FullBackupAttachmentExporter } from "../../dist/full-backup-attachment-exporter.js";
import { FullBackupBusinessFactsWorkbookExporter } from "../../dist/full-backup-business-facts-workbook-exporter.js";
import { FullBackupLocalPackageAssembler } from "../../dist/full-backup-local-package-assembler.js";
import { FullBackupSpool } from "../../dist/full-backup-spool.js";
import { FullBackupTransformer } from "../../dist/full-backup-transformer.js";
import { FullBackupWorkbookExporter } from "../../dist/full-backup-workbook-exporter.js";
import { PostgresFullBackupSource } from "../../dist/postgres-full-backup-source.js";

const profiles = [
  ["teacher", "TEACHER"], ["student", "STUDENT"], ["finance", "FINANCE"],
  ["payroll", "PAYROLL"], ["deduction", "DEDUCTION"], ["performanceConfiguration", "PERFORMANCE_CONFIGURATION"],
];
const sha = (value) => createHash("sha256").update(value).digest("hex");

test("real PG snapshot packages all six declared business fact workbooks without claiming a complete F14 backup", async () => {
  const database = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-business-package-pg-"));
  try {
    const personId = randomUUID();
    const fundId = randomUUID();
    const planId = randomUUID();
    const policyId = randomUUID();
    const at = "2026-09-23T00:00:00.000Z";
    await database.pool.query(
      "INSERT INTO person(id,nickname,legal_name,status,created_at,updated_at) VALUES($1::uuid,'备份事实老师','合成用户','INACTIVE',$2::timestamptz,$2::timestamptz)",
      [personId, at],
    );
    await database.pool.query(
      "INSERT INTO user_account(id,person_id,phone_normalized,password_hash,login_status,created_at,updated_at) VALUES($1::uuid,$2::uuid,'13800000079','$argon2id$package-secret-never-exported','REVOKED',$3::timestamptz,$3::timestamptz)",
      [randomUUID(), personId, at],
    );
    await database.pool.query(
      "INSERT INTO company_finance_fund(id,kind,fund_code,display_name,status,version,created_by_person_id,created_at,updated_at) VALUES($1::uuid,'HEADQUARTERS_FINANCE_OPERATING','PACKAGE_FACTS','聚合测试资金','ACTIVE',1,$2::uuid,$3::timestamptz,$3::timestamptz)",
      [fundId, personId, at],
    );
    await database.pool.query(
      "INSERT INTO finance_benefit_plan_version(id,benefit_kind,beneficiary_person_id,benefit_month,version_no,execution_day,amount_cents,source_fund_id,active,changed_by_person_id,changed_at,reason) VALUES($1::uuid,'SOCIAL_INSURANCE',$2::uuid,'2026-09-01',1,5,120,$3::uuid,true,$2::uuid,$4::timestamptz,'聚合测试福利计划')",
      [planId, personId, fundId, at],
    );
    const policy = {
      plannerBaseRateBasisPoints: 0, teacherBaseRateBasisPoints: 0, planningMentorWeightBasisPoints: 0,
      groupLeaderRateBasisPoints: 0, teachingMentorRateBasisPoints: 0, venueRateBasisPoints: 0,
      campusConsultationForPlannerRateBasisPoints: 0, campusConsultationForTeacherRateBasisPoints: 0,
      platformFinanceRateBasisPoints: 0,
      regionFinanceRateBasisPoints: 0,
      dynamicTiers: [{ label: "合成", maxInclusive: 50000, adjustmentBasisPoints: 0 }],
    };
    await database.pool.query(
      "INSERT INTO rate_policy_version(id,version,effective_from,policy_json,reason,published_by,published_at) VALUES($1::uuid,1,'2026-09-01',$2::jsonb,'聚合测试策略',$3::uuid,$4::timestamptz)",
      [policyId, JSON.stringify(policy), personId, at],
    );
    const spool = await new FullBackupSpool({
      source: new PostgresFullBackupSource(database.pool),
      transformer: new FullBackupTransformer({ fingerprint: ({ domain, value }) => sha(`${domain}:${value}`) }),
      tempRoot: join(root, "spool"), batchSize: 1,
    }).create();
    const spoolDirectory = join(root, "spool", spool.spoolId);
    const workbooks = await new FullBackupWorkbookExporter({ spoolDirectory, spool, outputRoot: join(root, "raw-workbooks") }).export();
    const attachments = await new FullBackupAttachmentExporter({
      spoolDirectory, spool, outputRoot: join(root, "attachments"),
      readVerified: async () => { throw new Error("fixture has no READY attachment"); },
    }).export();
    const bundle = {};
    for (const [key, profile] of profiles) {
      const outputRoot = join(root, `fact-${key}`);
      const result = await new FullBackupBusinessFactsWorkbookExporter({ spoolDirectory, spool, outputRoot, profile }).export();
      bundle[key] = { directory: join(outputRoot, result.outputId), result };
    }
    const packaged = await new FullBackupLocalPackageAssembler({
      spoolDirectory, spool,
      workbookDirectory: join(root, "raw-workbooks", workbooks.outputId), workbooks,
      attachmentDirectory: join(root, "attachments", attachments.outputId), attachments,
      outputRoot: join(root, "packages"), businessFacts: bundle,
    }).assemble();
    assert.equal(packaged.mode, "RAW_SOURCE_PACKAGE"); assert.equal(packaged.complete, false);
    assert.deepEqual(packaged.businessFacts.map((item) => item.tableNumber), [1, 2, 4, 5, 6, 8]);
    assert.equal(packaged.incompleteReasons.includes("BUSINESS_TABLES_3_AND_7_DERIVED_PENDING"), true);
    const packageDirectory = join(root, "packages", packaged.outputId);
    const bytes = await readFile(join(packageDirectory, packaged.indexFile));
    assert.equal(sha(bytes), packaged.indexSha256);
    const index = JSON.parse(bytes);
    assert.equal(index.complete, false);
    assert.deepEqual(index.businessFacts.map((item) => item.tableNumber), [1, 2, 4, 5, 6, 8]);
    assert.equal(index.businessFacts.find((item) => item.tableNumber === 6).gaps.includes("PROJECT_DEDUCTION_1_TO_10_NOT_IMPLEMENTED"), true);
    assert.equal(index.businessFacts.find((item) => item.tableNumber === 8).gaps.includes("PER_TEACHER_RATE_OVERRIDE_NOT_IMPLEMENTED"), true);
    assert.equal(index.businessFacts.find((item) => item.tableNumber === 8).gaps.includes("CLASS_TYPE_RATE_CONFIG_NOT_IMPLEMENTED"), true);
    for (const fact of index.businessFacts) {
      assert.equal(fact.schemaVersion, packaged.businessFacts.find((item) => item.tableNumber === fact.tableNumber).schemaVersion);
      const copied = await readFile(join(packageDirectory, fact.file.path));
      assert.equal(String(copied.length), fact.file.sizeBytes);
      assert.equal(sha(copied), fact.file.sha256);
      assert.equal(fact.sources.every((source) => /^[a-f0-9]{64}$/.test(source.logicalDigest)), true);
    }
    assert.equal(index.businessFacts.find((item) => item.tableNumber === 6).sources.find((source) => source.sourceTable === "finance_benefit_plan_version").rowCount, "1");
    assert.equal(index.businessFacts.find((item) => item.tableNumber === 8).sources.find((source) => source.sourceTable === "rate_policy_version").rowCount, "1");
    assert.equal(bytes.includes(Buffer.from("package-secret-never-exported")), false);
    assert.equal(bytes.includes(Buffer.from(root)), false);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
