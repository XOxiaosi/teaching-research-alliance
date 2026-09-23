import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestDatabase } from "../../../api/test/integration/postgres-test-database.mjs";
import { FullBackupDerivedSpoolIndex } from "../../dist/full-backup-derived-spool-index.js";
import { FullBackupLedgerDerivedView } from "../../dist/full-backup-ledger-derived-view.js";
import { FullBackupSpool } from "../../dist/full-backup-spool.js";
import { FullBackupTransformer } from "../../dist/full-backup-transformer.js";
import { PostgresFullBackupSource } from "../../dist/postgres-full-backup-source.js";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const collect = async (rows) => { const result = []; for await (const row of rows) result.push(row); return result; };

test("real PostgreSQL ledger facts preserve Shanghai posting boundaries and bigint reconciliation in a private derived view", async () => {
  const database = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-ledger-derived-pg-"));
  let index;
  let view;
  try {
    const ownerA = randomUUID();
    const ownerB = randomUUID();
    const accountA = randomUUID();
    const accountB = randomUUID();
    const eventAugust = randomUUID();
    const eventSeptember = randomUUID();
    const at = "2026-09-23T00:00:00.000Z";
    await database.pool.query(
      "INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status,created_at) VALUES($1::uuid,'PERSON',$2::uuid,$3,'ACTIVE',$5::timestamptz),($4::uuid,'PERSON',$6::uuid,$7,'ACTIVE',$5::timestamptz)",
      [accountA, ownerA, `ledger:${accountA}`, accountB, at, ownerB, `ledger:${accountB}`],
    );
    await database.pool.query(
      "INSERT INTO ledger_event(id,event_key,event_type,payload_hash,created_at) VALUES($1::uuid,$2,'T7_TEST',$3,'2026-08-31 15:59:59+00'),($4::uuid,$5,'T7_TEST',$6,'2026-08-31 16:00:00+00')",
      [eventAugust, `event:${eventAugust}`, sha(eventAugust), eventSeptember, `event:${eventSeptember}`, sha(eventSeptember)],
    );
    await database.pool.query(
      "INSERT INTO ledger_entry(id,event_id,account_id,category_key,amount_cents,created_at) VALUES($1::uuid,$2::uuid,$3::uuid,'POSTED',$4::bigint,'2020-01-01 00:00:00+00'),($5::uuid,$6::uuid,$3::uuid,'POSTED',$7::bigint,'2020-01-01 00:00:00+00')",
      [randomUUID(), eventAugust, accountA, "-9007199254740993", randomUUID(), eventSeptember, "9007199254740994"],
    );
    await database.pool.query(
      "INSERT INTO account_balance_projection(account_id,balance_cents,updated_at) VALUES($1::uuid,1,$3::timestamptz),($2::uuid,0,$3::timestamptz)",
      [accountA, accountB, at],
    );

    const spool = await new FullBackupSpool({
      source: new PostgresFullBackupSource(database.pool),
      transformer: new FullBackupTransformer({ fingerprint: ({ domain, value }) => sha(`${domain}\u0000${value}`) }),
      tempRoot: join(root, "spool"), batchSize: 1,
    }).create();
    const spoolDirectory = join(root, "spool", spool.spoolId);
    index = await FullBackupDerivedSpoolIndex.create({ spoolDirectory, spool, attemptRoot: join(root, "index") });
    view = await FullBackupLedgerDerivedView.create({ index, attemptRoot: join(root, "view") });
    assert.deepEqual({ mode: view.metadata().mode, complete: view.metadata().complete, anomalyCount: view.metadata().anomalyCount, invalidMonthlyRowCount: view.metadata().invalidMonthlyRowCount }, {
      mode: "DERIVED_POSTED_LEDGER_VIEW", complete: false, anomalyCount: "0", invalidMonthlyRowCount: "0",
    });

    const entries = await collect(view.streamEntries());
    const tested = entries.filter((row) => row.accountId === accountA);
    assert.deepEqual(tested.map(({ amountCents, postMonth, fiscalYearStart, entryCreatedAt, eventCreatedAt }) => ({ amountCents, postMonth, fiscalYearStart, entryCreatedAt, eventCreatedAt })).sort((left, right) => left.eventCreatedAt.localeCompare(right.eventCreatedAt)), [
      { amountCents: "-9007199254740993", postMonth: "2026-08-01", fiscalYearStart: "2025-09-01", entryCreatedAt: "2020-01-01 00:00:00+00", eventCreatedAt: "2026-08-31 15:59:59+00" },
      { amountCents: "9007199254740994", postMonth: "2026-09-01", fiscalYearStart: "2026-09-01", entryCreatedAt: "2020-01-01 00:00:00+00", eventCreatedAt: "2026-08-31 16:00:00+00" },
    ]);
    assert.deepEqual((await collect(view.streamMonthlyRows())).filter((row) => row.accountId === accountA), [
      { accountId: accountA, postMonth: "2026-08-01", fiscalYearStart: "2025-09-01", categoryKey: "POSTED", signedNetCents: "-9007199254740993", entryCount: "1", invalidAmountCount: "0", status: "VALID" },
      { accountId: accountA, postMonth: "2026-09-01", fiscalYearStart: "2026-09-01", categoryKey: "POSTED", signedNetCents: "9007199254740994", entryCount: "1", invalidAmountCount: "0", status: "VALID" },
    ]);
    assert.deepEqual((await collect(view.streamReconciliations())).filter((row) => row.accountId === accountA || row.accountId === accountB).map(({ accountId, ledgerNetCents, projectionBalanceCents, status }) => ({ accountId, ledgerNetCents, projectionBalanceCents, status })), [
      { accountId: accountA, ledgerNetCents: "1", projectionBalanceCents: "1", status: "MATCH" },
      { accountId: accountB, ledgerNetCents: "0", projectionBalanceCents: "0", status: "MATCH" },
    ].sort((left, right) => left.accountId.localeCompare(right.accountId)));
    assert.deepEqual(await collect(view.streamAnomalies()), []);

    await view.close();
    await index.close();
    assert.deepEqual(await readdir(join(root, "view")), []);
    assert.deepEqual(await readdir(join(root, "index")), []);
  } finally {
    await view?.close().catch(() => undefined);
    await index?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await database.close();
  }
});
