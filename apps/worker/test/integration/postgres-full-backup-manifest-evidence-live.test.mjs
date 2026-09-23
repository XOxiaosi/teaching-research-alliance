import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fixture } from "../../../api/test/integration/refund-review-fixture.mjs";
import { FullBackupDerivedSpoolIndex } from "../../dist/full-backup-derived-spool-index.js";
import { FullBackupLedgerBusinessPeriodSource } from "../../dist/full-backup-ledger-business-period-source.js";
import { FullBackupLedgerDerivedView } from "../../dist/full-backup-ledger-derived-view.js";
import { FullBackupManifestEvidence } from "../../dist/full-backup-manifest-evidence.js";
import { createFullBackupLayout } from "../../dist/full-backup-layout.js";
import { FullBackupSpool } from "../../dist/full-backup-spool.js";
import { FullBackupTransformer } from "../../dist/full-backup-transformer.js";
import { PostgresFullBackupSource } from "../../dist/postgres-full-backup-source.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");

test("real PostgreSQL approved refund yields same-snapshot bounded manifest evidence without a complete-backup claim", async () => {
  const f = await fixture();
  const root = await mkdtemp(join(tmpdir(), "manifest-evidence-pg-"));
  let index;
  let ledger;
  let periods;
  try {
    const document = await f.pending();
    await f.approve(document, "manifest-evidence-refund-approval");
    const spool = await new FullBackupSpool({
      source: new PostgresFullBackupSource(f.pool),
      transformer: new FullBackupTransformer({
        fingerprint: ({ domain, value }) => hash(`${domain}\0${value}`),
      }),
      tempRoot: join(root, "spool"),
      batchSize: 1,
    }).create();
    const spoolDirectory = join(root, "spool", spool.spoolId);
    index = await FullBackupDerivedSpoolIndex.create({
      spoolDirectory,
      spool,
      attemptRoot: join(root, "index"),
    });
    ledger = await FullBackupLedgerDerivedView.create({
      index,
      attemptRoot: join(root, "ledger"),
    });
    periods = await FullBackupLedgerBusinessPeriodSource.create({
      index,
      attemptRoot: join(root, "periods"),
    });

    const evidence = await FullBackupManifestEvidence.collect({
      spoolDirectory,
      spool,
      index,
      ledger,
      periods,
    });
    assert.deepEqual(
      {
        mode: evidence.mode,
        complete: evidence.complete,
        spoolId: evidence.spoolId,
        snapshotId: evidence.snapshotId,
        asOf: evidence.asOf,
      },
      {
        mode: "FULL_BACKUP_MANIFEST_EVIDENCE",
        complete: false,
        spoolId: spool.spoolId,
        snapshotId: spool.snapshotId,
        asOf: spool.asOf,
      },
    );
    assert.equal(
      evidence.raw.registeredDatasetCount,
      String(createFullBackupLayout().length),
    );
    assert.equal(
      evidence.raw.nonSecretTables.some(
        (table) =>
          table.tableName === "ledger_entry" &&
          BigInt(table.rowCount) > 0n &&
          table.firstStableKey !== null &&
          table.lastStableKey !== null,
      ),
      true,
    );
    assert.equal(
      evidence.raw.secretExclusions.some(
        (row) =>
          row.tableName === "user_account" &&
          row.fieldName === "password_hash" &&
          row.reason === "AUTH_SECRET_COLUMN_EXCLUDED",
      ),
      true,
    );
    assert.equal(
      evidence.raw.secretExclusions.every(
        (row) => Object.keys(row).sort().join(",") === "fieldName,reason,tableName",
      ),
      true,
    );
    assert.ok(BigInt(evidence.money.ledgerEntryCount) > 0n);
    assert.equal(evidence.money.invalidEntryAmountCount, "0");
    assert.notEqual(evidence.money.exactLedgerEntryCents, null);
    const reconciliationCount = Object.values(
      evidence.money.reconciliation.statusCounts,
    ).reduce((total, value) => total + BigInt(value), 0n);
    assert.equal(
      reconciliationCount,
      BigInt(evidence.money.reconciliation.accountCount),
    );
    const periodCount = Object.values(evidence.periods.statusCounts).reduce(
      (total, value) => total + BigInt(value),
      0n,
    );
    assert.equal(periodCount, BigInt(evidence.periods.eventCount));
    assert.equal(evidence.integrity.status, "VERIFIED_PARTIAL");
    assert.equal(evidence.integrity.completeBackup, false);
    assert.equal(evidence.businessCorrectness.status, "NOT_ASSERTED");
  } finally {
    await periods?.close().catch(() => undefined);
    await ledger?.close().catch(() => undefined);
    await index?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await f.close();
  }
});
