import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FullBackupDerivedSpoolIndex } from "../dist/full-backup-derived-spool-index.js";
import { FullBackupLedgerBusinessPeriodSource } from "../dist/full-backup-ledger-business-period-source.js";
import { FullBackupLedgerDerivedView } from "../dist/full-backup-ledger-derived-view.js";
import {
  FULL_BACKUP_MANIFEST_EVIDENCE_COVERAGE_GAPS,
  FullBackupManifestEvidence,
} from "../dist/full-backup-manifest-evidence.js";
import { createFullBackupLayout } from "../dist/full-backup-layout.js";
import { fullBackupOutputColumns } from "../dist/full-backup-transformer.js";

const layout = createFullBackupLayout();
const sha = (value) => createHash("sha256").update(value).digest("hex");
const valuesFor = (columns, record = {}) =>
  columns.map((column) => record[column] ?? null);

async function createSpool(records = {}) {
  const root = await mkdtemp(join(tmpdir(), "manifest-evidence-"));
  const directory = join(root, "spool");
  await mkdir(join(directory, "datasets"), { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await chmod(join(directory, "datasets"), 0o700);
  const datasets = [];
  for (const [index, item] of layout.entries()) {
    if (item.policy === "AUTH_SECRET_TABLE_EXCLUDED") {
      datasets.push({
        tableName: item.tableName,
        columns: [],
        rowCount: null,
        logicalDigest: null,
        spoolFile: null,
        excluded: true,
      });
      continue;
    }
    const columns = fullBackupOutputColumns(item.tableName);
    const rows = (records[item.tableName] ?? []).map((record) =>
      valuesFor(columns, record),
    );
    const content = `${JSON.stringify({ columns })}\n${rows
      .map((row) => `${JSON.stringify(row)}\n`)
      .join("")}`;
    const spoolFile = `datasets/${String(index + 1).padStart(3, "0")}_${item.tableName}.ndjson`;
    await writeFile(join(directory, spoolFile), content, { mode: 0o600 });
    datasets.push({
      tableName: item.tableName,
      columns,
      rowCount: String(rows.length),
      logicalDigest: sha(content),
      spoolFile,
      excluded: false,
    });
  }
  await writeFile(join(directory, "anomalies.ndjson"), "", { mode: 0o600 });
  return {
    root,
    directory,
    spool: {
      mode: "RAW_SOURCE_SPOOL",
      spoolId: "manifest-evidence-spool",
      snapshotId: "manifest-evidence-snapshot",
      asOf: "2026-09-23T00:00:00.000Z",
      datasets,
      anomalyFile: "anomalies.ndjson",
      anomalyCount: "0",
      coverageGaps: [
        "MONTHLY_INCOME_PUBLISHED_VERSIONS_NOT_IMPLEMENTED",
        "MANUAL_ADJUSTMENT_WORKFLOW_NOT_IMPLEMENTED",
        "BACKUP_JOB_AND_SCHEDULE_HISTORY_NOT_IMPLEMENTED",
      ],
    },
  };
}

async function openViews(f) {
  const index = await FullBackupDerivedSpoolIndex.create({
    spoolDirectory: f.directory,
    spool: f.spool,
    attemptRoot: join(f.root, "index"),
  });
  const ledger = await FullBackupLedgerDerivedView.create({
    index,
    attemptRoot: join(f.root, "ledger"),
  });
  const periods = await FullBackupLedgerBusinessPeriodSource.create({
    index,
    attemptRoot: join(f.root, "periods"),
  });
  return { index, ledger, periods };
}

async function assertViewsStillOpen({ index, ledger, periods }) {
  const people = index.stream("person");
  await people.next();
  await people.return();
  const entries = ledger.streamEntries();
  await entries.next();
  await entries.return();
  const eventPeriods = periods.streamEventPeriods();
  await eventPeriods.next();
  await eventPeriods.return();
}

async function closeViews({ index, ledger, periods }) {
  await periods?.close().catch(() => undefined);
  await ledger?.close().catch(() => undefined);
  await index?.close().catch(() => undefined);
}

test("manifest evidence locks every actual registered RAW table to its index and retains partial money/period evidence", async () => {
  const f = await createSpool({
    person: [
      { id: "person-001", nickname: "first", status: "ACTIVE" },
      { id: "person-002", nickname: "second", status: "ACTIVE" },
    ],
    settlement_account: [
      {
        id: "account-1",
        owner_type: "PERSON",
        owner_id: "person-001",
        account_code: "person-account",
        status: "ACTIVE",
      },
    ],
    ledger_event: [
      {
        id: "event-1",
        event_key_fingerprint: "a".repeat(64),
        event_type: "FUTURE_LEDGER_EVENT",
        payload_hash: "payload",
        created_at: "2026-09-23T00:00:00.000Z",
      },
    ],
    ledger_entry: [
      {
        id: "entry-1",
        event_id: "event-1",
        account_id: "account-1",
        category_key: "TEST",
        amount_cents: "-1",
        created_at: "2026-09-23T00:00:00.000Z",
      },
      {
        id: "entry-2",
        event_id: "event-1",
        account_id: "account-1",
        category_key: "TEST",
        amount_cents: "not-an-integer",
        created_at: "2026-09-23T00:00:00.000Z",
      },
    ],
    account_balance_projection: [
      { account_id: "account-1", balance_cents: "-1" },
    ],
  });
  let index;
  let ledger;
  let periods;
  try {
    index = await FullBackupDerivedSpoolIndex.create({
      spoolDirectory: f.directory,
      spool: f.spool,
      attemptRoot: join(f.root, "index"),
    });
    ledger = await FullBackupLedgerDerivedView.create({
      index,
      attemptRoot: join(f.root, "ledger"),
    });
    periods = await FullBackupLedgerBusinessPeriodSource.create({
      index,
      attemptRoot: join(f.root, "periods"),
    });
    const result = await FullBackupManifestEvidence.collect({
      spoolDirectory: f.directory,
      spool: f.spool,
      index,
      ledger,
      periods,
    });

    assert.equal(result.complete, false);
    assert.equal(result.integrity.status, "VERIFIED_PARTIAL");
    assert.equal(
      result.integrity.scope,
      "REGISTERED_RAW_AND_LEDGER_EVIDENCE_ONLY",
    );
    assert.equal(result.businessCorrectness.status, "NOT_ASSERTED");
    assert.equal(result.raw.registeredDatasetCount, String(layout.length));
    assert.equal(
      result.raw.nonSecretTables.length +
        new Set(
          layout
            .filter((item) => item.policy === "AUTH_SECRET_TABLE_EXCLUDED")
            .map((item) => item.tableName),
        ).size,
      layout.length,
    );
    const people = result.raw.nonSecretTables.find(
      (table) => table.tableName === "person",
    );
    assert.equal(people.rowCount, "2");
    assert.equal(people.firstStableKey, '[["id","person-001"]]');
    assert.equal(people.lastStableKey, '[["id","person-002"]]');
    assert.equal(
      people.logicalDigest,
      f.spool.datasets.find((dataset) => dataset.tableName === "person")
        .logicalDigest,
    );
    assert.equal(
      result.raw.secretExclusions.some(
        (row) =>
          row.tableName === "user_session" &&
          row.reason === "AUTH_SECRET_TABLE_EXCLUDED",
      ),
      true,
    );
    assert.equal(
      result.raw.secretExclusions.some(
        (row) =>
          row.tableName === "user_account" &&
          row.fieldName === "password_hash" &&
          row.reason === "AUTH_SECRET_COLUMN_EXCLUDED",
      ),
      true,
    );
    assert.equal(
      result.raw.secretExclusions.every(
        (row) =>
          Object.keys(row).sort().join(",") ===
          "fieldName,reason,tableName",
      ),
      true,
    );
    assert.deepEqual(
      {
        entries: result.money.ledgerEntryCount,
        valid: result.money.validEntryAmountCount,
        invalid: result.money.invalidEntryAmountCount,
        subtotal: result.money.validEntryCentsSubtotal,
        total: result.money.exactLedgerEntryCents,
      },
      { entries: "2", valid: "1", invalid: "1", subtotal: "-1", total: null },
    );
    assert.equal(
      result.money.reconciliation.statusCounts.LEDGER_TOTAL_INVALID,
      "1",
    );
    assert.equal(result.money.reconciliation.exactLedgerCents, null);
    assert.equal(result.money.reconciliation.exactProjectionCents, "-1");
    assert.deepEqual(result.periods.statusCounts, {
      UNIQUE_LOCKED_SETTLEMENT_MONTH: "0",
      MULTIPLE_BUSINESS_PERIODS: "0",
      UNRESOLVED: "0",
      UNIMPLEMENTED_EVENT_TYPE: "1",
    });
    assert.deepEqual(
      result.coverageGaps,
      FULL_BACKUP_MANIFEST_EVIDENCE_COVERAGE_GAPS,
    );

    const stillOpen = index.stream("person");
    assert.equal((await stillOpen.next()).value.ordinal, "1");
    await stillOpen.return();
  } finally {
    await periods?.close().catch(() => undefined);
    await ledger?.close().catch(() => undefined);
    await index?.close().catch(() => undefined);
    await rm(f.root, { recursive: true, force: true });
  }
});

test("manifest evidence rejects altered RAW bytes or a same-ID index built from different RAW values while leaving caller views open", async (t) => {
  await t.test("altered RAW file", async () => {
    const f = await createSpool({ person: [{ id: "person-1", nickname: "source-a" }] });
    let views;
    try {
      views = await openViews(f);
      const dataset = f.spool.datasets.find((item) => item.tableName === "person");
      const path = join(f.directory, dataset.spoolFile);
      await writeFile(path, Buffer.concat([await readFile(path), Buffer.from(" ")]), {
        mode: 0o600,
      });
      await assert.rejects(
        () =>
          FullBackupManifestEvidence.collect({
            spoolDirectory: f.directory,
            spool: f.spool,
            ...views,
          }),
        /EXPORT_SPOOL_INTEGRITY_FAILED/,
      );
      await assertViewsStillOpen(views);
    } finally {
      await closeViews(views ?? {});
      await rm(f.root, { recursive: true, force: true });
    }
  });

  await t.test("same metadata ID, different indexed source values", async () => {
    const primary = await createSpool({
      person: [{ id: "person-1", nickname: "source-a" }],
    });
    const alternate = await createSpool({
      person: [{ id: "person-1", nickname: "source-b" }],
    });
    let views;
    try {
      alternate.spool.spoolId = primary.spool.spoolId;
      alternate.spool.snapshotId = primary.spool.snapshotId;
      alternate.spool.asOf = primary.spool.asOf;
      views = await openViews(alternate);
      await assert.rejects(
        () =>
          FullBackupManifestEvidence.collect({
            spoolDirectory: primary.directory,
            spool: primary.spool,
            ...views,
          }),
        /EXPORT_MANIFEST_EVIDENCE_INDEX_LOCKSTEP_INVALID/,
      );
      await assertViewsStillOpen(views);
    } finally {
      await closeViews(views ?? {});
      await rm(primary.root, { recursive: true, force: true });
      await rm(alternate.root, { recursive: true, force: true });
    }
  });
});

test("manifest evidence rejects snapshot mismatch, missing datasets, and forged secret metadata without closing caller views", async (t) => {
  const f = await createSpool({ person: [{ id: "person-1", nickname: "source-a" }] });
  let views;
  try {
    views = await openViews(f);
    await t.test("snapshot mismatch", async () => {
      await assert.rejects(
        () =>
          FullBackupManifestEvidence.collect({
            spoolDirectory: f.directory,
            spool: { ...f.spool, snapshotId: "other-snapshot" },
            ...views,
          }),
        /EXPORT_MANIFEST_EVIDENCE_SNAPSHOT_MISMATCH/,
      );
      await assertViewsStillOpen(views);
    });
    await t.test("missing registered dataset", async () => {
      await assert.rejects(
        () =>
          FullBackupManifestEvidence.collect({
            spoolDirectory: f.directory,
            spool: { ...f.spool, datasets: f.spool.datasets.slice(0, -1) },
            ...views,
          }),
        /EXPORT_MANIFEST_EVIDENCE_SPOOL_LAYOUT_INVALID/,
      );
      await assertViewsStillOpen(views);
    });
    await t.test("forged secret metadata", async () => {
      const datasets = f.spool.datasets.map((dataset) =>
        dataset.tableName === "user_session"
          ? {
              ...dataset,
              columns: ["token_hash"],
              rowCount: "0",
              logicalDigest: "0".repeat(64),
              spoolFile: "datasets/forged.ndjson",
            }
          : dataset,
      );
      await assert.rejects(
        () =>
          FullBackupManifestEvidence.collect({
            spoolDirectory: f.directory,
            spool: { ...f.spool, datasets },
            ...views,
          }),
        /EXPORT_MANIFEST_EVIDENCE_SPOOL_LAYOUT_INVALID/,
      );
      await assertViewsStillOpen(views);
    });
  } finally {
    await closeViews(views ?? {});
    await rm(f.root, { recursive: true, force: true });
  }
});
