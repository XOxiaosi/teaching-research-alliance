import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FullBackupBusinessFactsView } from "../dist/full-backup-business-facts-view.js";
import { createFullBackupLayout } from "../dist/full-backup-layout.js";
import { fullBackupOutputColumns } from "../dist/full-backup-transformer.js";

const digest = (content) => createHash("sha256").update(content, "utf8").digest("hex");
const valuesFor = (columns, record = {}) => columns.map((column) => record[column] ?? null);

const createCompleteSpool = async (records = {}) => {
  const root = await mkdtemp(join(tmpdir(), "business-facts-view-"));
  const directory = join(root, "spool");
  await mkdir(join(directory, "datasets"), { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await chmod(join(directory, "datasets"), 0o700);
  const datasets = [];
  for (const [index, item] of createFullBackupLayout().entries()) {
    const excluded = item.policy === "AUTH_SECRET_TABLE_EXCLUDED";
    if (excluded) {
      datasets.push({ tableName: item.tableName, columns: [], rowCount: null, logicalDigest: null, spoolFile: null, excluded: true });
      continue;
    }
    const columns = fullBackupOutputColumns(item.tableName);
    const rows = (records[item.tableName] ?? []).map((record) => valuesFor(columns, record));
    const content = `${JSON.stringify({ columns })}\n${rows.map((row) => `${JSON.stringify(row)}\n`).join("")}`;
    const spoolFile = `datasets/${String(index + 1).padStart(3, "0")}_${item.tableName}.ndjson`;
    await writeFile(join(directory, spoolFile), content, { mode: 0o600 });
    datasets.push({ tableName: item.tableName, columns, rowCount: String(rows.length), logicalDigest: digest(content), spoolFile, excluded: false });
  }
  await writeFile(join(directory, "anomalies.ndjson"), "", { mode: 0o600 });
  return {
    root,
    directory,
    spool: {
      mode: "RAW_SOURCE_SPOOL", spoolId: "synthetic-spool", snapshotId: "synthetic-snapshot", asOf: "2026-09-23T00:00:00.000Z",
      datasets, anomalyFile: "anomalies.ndjson", anomalyCount: "0", coverageGaps: [
        "MONTHLY_INCOME_PUBLISHED_VERSIONS_NOT_IMPLEMENTED",
        "MANUAL_ADJUSTMENT_WORKFLOW_NOT_IMPLEMENTED",
        "BACKUP_JOB_AND_SCHEDULE_HISTORY_NOT_IMPLEMENTED",
      ],
    },
    datasetFile: (tableName) => join(directory, datasets.find((dataset) => dataset.tableName === tableName).spoolFile),
  };
};

const rows = async (view, tableNumber, sourceTable) => {
  const result = [];
  for await (const row of view.readSourceRows(tableNumber, sourceTable)) result.push(row);
  return result;
};

test("projects fixed stored facts from a complete spool without joining or coercing text values", async () => {
  const fixture = await createCompleteSpool({
    person: [{ id: "001", nickname: "", legal_name: "合成姓名", status: "INACTIVE", profile_version: "7", created_at: "2026-09-23T00:00:00.000Z", updated_at: null }],
    weekly_fee_entry: [{ id: "fee-001", gross_amount_cents: "0", settlement_month: null }],
    referral_acceptance_snapshot: [{ referral_case_id: "case-001", accepted_referral_version: "0002", venue_id: "venue-001" }],
    finance_attachment_version: [
      { id: "attachment-v-ready", status: "READY" },
      { id: "attachment-v-uploading", status: "UPLOADING" },
    ],
  });
  try {
    const view = new FullBackupBusinessFactsView({ spoolDirectory: fixture.directory, spool: fixture.spool });
    const description = view.describe(1);
    assert.equal(description.mode, "BUSINESS_FACTS_VIEW");
    assert.equal(description.complete, false);
    assert.equal(description.snapshotId, "synthetic-snapshot");
    assert.equal(JSON.stringify(description).includes(fixture.directory), false);
    assert.deepEqual(description.sources.find((source) => source.sourceTable === "person"), {
      sourceTable: "person", rowKeyColumns: ["id"], columns: [
        { sourceColumn: "id", label: "人员ID" },
        { sourceColumn: "nickname", label: "教师昵称" },
        { sourceColumn: "legal_name", label: "真实姓名" },
        { sourceColumn: "profile_version", label: "资料版本" },
        { sourceColumn: "status", label: "人员状态" },
      ],
    });
    const accountSource = description.sources.find((source) => source.sourceTable === "user_account");
    assert.equal(accountSource.columns.some((column) => ["password_hash", "auth_version"].includes(column.sourceColumn)), false);
    for (const sourceTable of ["auth_login_throttle", "auth_password_reset_command"]) {
      const source = description.sources.find((item) => item.sourceTable === sourceTable);
      assert.equal(source, undefined, `${sourceTable} is excluded from business facts`);
    }
    assert.deepEqual(await rows(view, 1, "person"), [{
      sourceTable: "person", sourceRecordKey: '[["id","001"]]', rowNumber: "1", values: ["001", "", "合成姓名", "7", "INACTIVE"],
    }]);
    assert.deepEqual(await rows(view, 2, "weekly_fee_entry"), [{
      sourceTable: "weekly_fee_entry", sourceRecordKey: '[["id","fee-001"]]', rowNumber: "1", values: ["fee-001", "0", null],
    }]);
    assert.deepEqual(await rows(view, 2, "referral_acceptance_snapshot"), [{
      sourceTable: "referral_acceptance_snapshot",
      sourceRecordKey: '[["referral_case_id","case-001"],["accepted_referral_version","0002"]]',
      rowNumber: "1", values: ["case-001", "0002", "venue-001"],
    }]);
    assert.deepEqual(await rows(view, 4, "finance_attachment_version"), [
      { sourceTable: "finance_attachment_version", sourceRecordKey: '[["id","attachment-v-ready"]]', rowNumber: "1", values: ["attachment-v-ready", null, null, "READY", null, null, null, null, null, null, null, null, null, null, null] },
      { sourceTable: "finance_attachment_version", sourceRecordKey: '[["id","attachment-v-uploading"]]', rowNumber: "2", values: ["attachment-v-uploading", null, null, "UPLOADING", null, null, null, null, null, null, null, null, null, null, null] },
    ]);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("rejects undeclared sources and derived tables instead of returning empty business data", async () => {
  const fixture = await createCompleteSpool();
  try {
    const view = new FullBackupBusinessFactsView({ spoolDirectory: fixture.directory, spool: fixture.spool });
    assert.throws(() => view.describe(3), /EXPORT_BUSINESS_FACTS_DERIVED_REQUIRED/);
    assert.throws(() => view.describe(7), /EXPORT_BUSINESS_FACTS_DERIVED_REQUIRED/);
    await assert.rejects(async () => rows(view, 1, "weekly_fee_entry"), /EXPORT_BUSINESS_FACTS_SOURCE_NOT_DECLARED/);
    await assert.rejects(async () => rows(view, 99, "person"), /EXPORT_BUSINESS_FACTS_UNKNOWN_TABLE/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("does not accept bad complete-spool metadata, digest failures, or row-count failures", async () => {
  const fixture = await createCompleteSpool({ person: [{ id: "person-1", nickname: "初值", status: "ACTIVE" }] });
  try {
    const reordered = { ...fixture.spool, datasets: [...fixture.spool.datasets] };
    [reordered.datasets[0], reordered.datasets[1]] = [reordered.datasets[1], reordered.datasets[0]];
    assert.throws(() => new FullBackupBusinessFactsView({ spoolDirectory: fixture.directory, spool: reordered }), /EXPORT_BUSINESS_FACTS_SPOOL_METADATA_INVALID/);

    const person = fixture.spool.datasets.find((dataset) => dataset.tableName === "person");
    const changedValues = valuesFor(person.columns, { id: "person-1", nickname: "篡改", status: "ACTIVE" });
    await writeFile(fixture.datasetFile("person"), `${JSON.stringify({ columns: person.columns })}\n${JSON.stringify(changedValues)}\n`, { mode: 0o600 });
    const digestBad = new FullBackupBusinessFactsView({ spoolDirectory: fixture.directory, spool: fixture.spool });
    await assert.rejects(async () => rows(digestBad, 1, "person"), /EXPORT_SPOOL_INTEGRITY_FAILED/);

    const originalValues = valuesFor(person.columns, { id: "person-1", nickname: "初值", status: "ACTIVE" });
    await writeFile(fixture.datasetFile("person"), `${JSON.stringify({ columns: person.columns })}\n${JSON.stringify(originalValues)}\n`, { mode: 0o600 });
    const countBadSpool = { ...fixture.spool, datasets: fixture.spool.datasets.map((dataset) =>
      dataset.tableName === "person" ? { ...dataset, rowCount: "2" } : dataset) };
    const countBad = new FullBackupBusinessFactsView({ spoolDirectory: fixture.directory, spool: countBadSpool });
    await assert.rejects(async () => rows(countBad, 1, "person"), /EXPORT_SPOOL_INTEGRITY_FAILED/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("closing an early consumer closes the downstream reader", async () => {
  const fixture = await createCompleteSpool();
  let closed = false;
  const personColumns = fullBackupOutputColumns("person");
  const readDataset = async function* () {
    try { yield valuesFor(personColumns, { id: "person-early", nickname: "早退", status: "ACTIVE" }); }
    finally { closed = true; }
  };
  try {
    const view = new FullBackupBusinessFactsView({ spoolDirectory: fixture.directory, spool: fixture.spool, readDataset });
    const iterator = view.readSourceRows(1, "person");
    assert.equal((await iterator.next()).value.sourceRecordKey, '[["id","person-early"]]');
    await iterator.return();
    assert.equal(closed, true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("preserves a reader failure when downstream cleanup also fails", async () => {
  const fixture = await createCompleteSpool();
  const primary = new Error("injected-reader-next-failure");
  const cleanup = new Error("injected-reader-return-failure");
  const readDataset = () => ({
    async next() { throw primary; },
    async return() { throw cleanup; },
    [Symbol.asyncIterator]() { return this; },
  });
  try {
    const view = new FullBackupBusinessFactsView({ spoolDirectory: fixture.directory, spool: fixture.spool, readDataset });
    await assert.rejects(async () => rows(view, 1, "person"), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, "EXPORT_BUSINESS_FACTS_READER_CLEANUP_FAILED");
      assert.equal(error.cause, primary);
      assert.deepEqual(error.errors, [primary, cleanup]);
      return true;
    });
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("surfaces a cleanup failure when reader completion had no primary error", async () => {
  const fixture = await createCompleteSpool();
  const cleanup = new Error("injected-return-only-failure");
  const readDataset = () => ({
    async next() { return { done: true }; },
    async return() { throw cleanup; },
    [Symbol.asyncIterator]() { return this; },
  });
  try {
    const view = new FullBackupBusinessFactsView({ spoolDirectory: fixture.directory, spool: fixture.spool, readDataset });
    await assert.rejects(async () => rows(view, 1, "person"), (error) => {
      assert.equal(error, cleanup);
      return true;
    });
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
