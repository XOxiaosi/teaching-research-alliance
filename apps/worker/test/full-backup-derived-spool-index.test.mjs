import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FullBackupDerivedSpoolIndex } from "../dist/full-backup-derived-spool-index.js";
import { createFullBackupLayout } from "../dist/full-backup-layout.js";
import { fullBackupOutputColumns } from "../dist/full-backup-transformer.js";

const digest = (content) => createHash("sha256").update(content, "utf8").digest("hex");
const valuesFor = (columns, record = {}) => columns.map((column) => record[column] ?? null);
const collect = async (rows) => { const result = []; for await (const row of rows) result.push(row); return result; };

const createCompleteSpool = async (records = {}) => {
  const root = await mkdtemp(join(tmpdir(), "derived-spool-index-"));
  const directory = join(root, "spool");
  await mkdir(join(directory, "datasets"), { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await chmod(join(directory, "datasets"), 0o700);
  const datasets = [];
  for (const [index, item] of createFullBackupLayout().entries()) {
    if (item.policy === "AUTH_SECRET_TABLE_EXCLUDED") {
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
      mode: "RAW_SOURCE_SPOOL", spoolId: "synthetic-derived-index", snapshotId: "synthetic-snapshot", asOf: "2026-09-23T00:00:00.000Z",
      datasets, anomalyFile: "anomalies.ndjson", anomalyCount: "0", coverageGaps: [
        "MONTHLY_INCOME_PUBLISHED_VERSIONS_NOT_IMPLEMENTED",
        "MANUAL_ADJUSTMENT_WORKFLOW_NOT_IMPLEMENTED",
        "BACKUP_JOB_AND_SCHEDULE_HISTORY_NOT_IMPLEMENTED",
      ],
    },
    datasetFile: (tableName) => join(directory, datasets.find((dataset) => dataset.tableName === tableName).spoolFile),
  };
};

test("indexes each fixed RAW source after integrity-checked EOF while preserving spool order and text", async () => {
  const fixture = await createCompleteSpool({
    person: [
      { id: "0002", nickname: "", legal_name: "第二位", status: "INACTIVE", profile_version: "2", created_at: "2026-09-01T00:00:00.000Z", updated_at: null },
      { id: "0010", nickname: "前导零", legal_name: "第十位", status: "ACTIVE", profile_version: "10", created_at: "2026-09-02T00:00:00.000Z", updated_at: null },
    ],
    referral_acceptance_snapshot: [
      { referral_case_id: "case-001", accepted_referral_version: "0002", venue_id: "venue-001" },
      { referral_case_id: "case-001", accepted_referral_version: "0010", venue_id: "venue-002" },
    ],
    weekly_fee_allocation_snapshot: [
      { id: "snapshot-001", sequence_no: "9007199254740993", net_monthly_cents: "000", snapshot_json: '{"lines":[{"key":"teachingTeacher","cents":"0"}],"accountByKey":{}}', context_json: '{"feeEntryId":"fee-001","leading":"001"}' },
    ],
  });
  const attemptRoot = join(fixture.root, "attempts");
  let index;
  try {
    index = await FullBackupDerivedSpoolIndex.create({ spoolDirectory: fixture.directory, spool: fixture.spool, attemptRoot });
    const metadata = index.metadata();
    assert.deepEqual({ mode: metadata.mode, complete: metadata.complete, spoolId: metadata.spoolId, snapshotId: metadata.snapshotId, asOf: metadata.asOf }, {
      mode: "DERIVED_SPOOL_INDEX", complete: false, spoolId: "synthetic-derived-index", snapshotId: "synthetic-snapshot", asOf: "2026-09-23T00:00:00.000Z",
    });
    assert.equal(JSON.stringify(metadata).includes(fixture.directory), false);
    assert.equal(metadata.sources.find((source) => source.tableName === "person")?.rowCount, "2");
    assert.equal(metadata.sources.some((source) => source.tableName === "user_session"), false);

    const people = await collect(index.stream("person"));
    assert.deepEqual(people.map((row) => ({ key: row.sourceRecordKey, ordinal: row.ordinal, values: row.values })), [
      { key: '[["id","0002"]]', ordinal: "1", values: ["0002", "", "第二位", "INACTIVE", "2", "2026-09-01T00:00:00.000Z", null] },
      { key: '[["id","0010"]]', ordinal: "2", values: ["0010", "前导零", "第十位", "ACTIVE", "10", "2026-09-02T00:00:00.000Z", null] },
    ]);
    assert.deepEqual(await index.lookup("person", [["id", "0010"]]), people[1]);
    assert.deepEqual(await index.lookup("referral_acceptance_snapshot", [["referral_case_id", "case-001"], ["accepted_referral_version", "0002"]]), {
      tableName: "referral_acceptance_snapshot", sourceRecordKey: '[["referral_case_id","case-001"],["accepted_referral_version","0002"]]', ordinal: "1",
      values: ["case-001", "venue-001", null, null, null, "0002", null, null],
    });
    const snapshots = await collect(index.stream("weekly_fee_allocation_snapshot"));
    assert.equal(snapshots[0].values[1], "9007199254740993");
    assert.equal(snapshots[0].values[8], '{"lines":[{"key":"teachingTeacher","cents":"0"}],"accountByKey":{}}');
    assert.equal(snapshots[0].values[9], '{"feeEntryId":"fee-001","leading":"001"}');

    await assert.rejects(index.lookup("referral_acceptance_snapshot", [["accepted_referral_version", "0002"], ["referral_case_id", "case-001"]]), /EXPORT_DERIVED_INDEX_KEY_INVALID/);
    await assert.rejects(collect(index.stream("user_session")), /EXPORT_DERIVED_INDEX_TABLE_UNKNOWN/);
    const afterClose = index.stream("person");
    const explicitlyReturned = index.stream("person");
    assert.equal((await afterClose.next()).value.ordinal, "1");
    assert.equal((await explicitlyReturned.next()).value.ordinal, "1");
    await index.close();
    await assert.rejects(afterClose.next(), /EXPORT_DERIVED_INDEX_CLOSED/);
    assert.deepEqual(await explicitlyReturned.return(), { value: undefined, done: true });
    await index.close();
    assert.deepEqual(await readdir(attemptRoot), []);
    await assert.rejects(index.lookup("person", [["id", "0010"]]), /EXPORT_DERIVED_INDEX_CLOSED/);
  } finally {
    await index?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an early stream break releases its native iterator before idempotent close", async () => {
  const fixture = await createCompleteSpool({
    person: [
      { id: "person-1", nickname: "一", legal_name: "一", status: "ACTIVE" },
      { id: "person-2", nickname: "二", legal_name: "二", status: "ACTIVE" },
    ],
  });
  const attemptRoot = join(fixture.root, "attempts");
  let index;
  try {
    index = await FullBackupDerivedSpoolIndex.create({ spoolDirectory: fixture.directory, spool: fixture.spool, attemptRoot });
    for await (const row of index.stream("person")) {
      assert.equal(row.ordinal, "1");
      break;
    }
    await index.close();
    await index.close();
    assert.deepEqual(await readdir(attemptRoot), []);
  } finally {
    await index?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("keeps an existing attempt parent unchanged and rejects a symbolic-link parent", async () => {
  const fixture = await createCompleteSpool({ person: [{ id: "person-1", nickname: "一", legal_name: "一", status: "ACTIVE" }] });
  const attemptRoot = join(fixture.root, "attempts");
  const symlinkRoot = join(fixture.root, "attempts-link");
  let index;
  try {
    await mkdir(attemptRoot, { mode: 0o700 });
    await chmod(attemptRoot, 0o755);
    index = await FullBackupDerivedSpoolIndex.create({ spoolDirectory: fixture.directory, spool: fixture.spool, attemptRoot });
    assert.equal((await stat(attemptRoot)).mode & 0o777, 0o755);
    await index.close();
    await symlink(attemptRoot, symlinkRoot);
    assert.equal((await lstat(symlinkRoot)).isSymbolicLink(), true);
    await assert.rejects(FullBackupDerivedSpoolIndex.create({ spoolDirectory: fixture.directory, spool: fixture.spool, attemptRoot: symlinkRoot }), /EXPORT_DERIVED_INDEX_ATTEMPT_ROOT_INVALID/);
  } finally {
    await index?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a bad source digest before exposing an index and only cleans its own attempt", async () => {
  const fixture = await createCompleteSpool({ person: [{ id: "person-1", nickname: "原始", legal_name: "合成人员", status: "ACTIVE" }] });
  const attemptRoot = join(fixture.root, "attempts");
  try {
    const person = fixture.spool.datasets.find((dataset) => dataset.tableName === "person");
    const changed = valuesFor(person.columns, { id: "person-1", nickname: "篡改", legal_name: "合成人员", status: "ACTIVE" });
    await writeFile(fixture.datasetFile("person"), `${JSON.stringify({ columns: person.columns })}\n${JSON.stringify(changed)}\n`, { mode: 0o600 });
    await assert.rejects(FullBackupDerivedSpoolIndex.create({ spoolDirectory: fixture.directory, spool: fixture.spool, attemptRoot }), /EXPORT_SPOOL_INTEGRITY_FAILED/);
    assert.deepEqual(await readdir(attemptRoot), []);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
