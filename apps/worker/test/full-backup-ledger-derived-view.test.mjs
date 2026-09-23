import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FullBackupDerivedSpoolIndex } from "../dist/full-backup-derived-spool-index.js";
import { FullBackupLedgerDerivedView } from "../dist/full-backup-ledger-derived-view.js";
import { createFullBackupLayout } from "../dist/full-backup-layout.js";
import { fullBackupOutputColumns } from "../dist/full-backup-transformer.js";

const digest = (content) => createHash("sha256").update(content, "utf8").digest("hex");
const valuesFor = (columns, record = {}) => columns.map((column) => record[column] ?? null);
const collect = async (rows) => { const result = []; for await (const row of rows) result.push(row); return result; };

const createCompleteSpool = async (records = {}) => {
  const root = await mkdtemp(join(tmpdir(), "ledger-derived-view-"));
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
    root, directory,
    spool: {
      mode: "RAW_SOURCE_SPOOL", spoolId: "ledger-synthetic", snapshotId: "ledger-snapshot", asOf: "2026-09-23T00:00:00.000Z",
      datasets, anomalyFile: "anomalies.ndjson", anomalyCount: "0", coverageGaps: [
        "MONTHLY_INCOME_PUBLISHED_VERSIONS_NOT_IMPLEMENTED",
        "MANUAL_ADJUSTMENT_WORKFLOW_NOT_IMPLEMENTED",
        "BACKUP_JOB_AND_SCHEDULE_HISTORY_NOT_IMPLEMENTED",
        "NICKNAME_CORRECTION_HISTORY_NOT_IMPLEMENTED",
      ],
    },
  };
};

const account = (id, code) => ({ id, owner_type: "PERSON", owner_id: `owner-${id}`, account_code: code, status: "ACTIVE", created_at: "2026-01-01 00:00:00+00" });
const event = (id, createdAt) => ({ id, event_key_fingerprint: `${id}-fingerprint`, event_type: "KNOWN_OR_FUTURE_EVENT", payload_hash: `${id}-payload`, created_at: createdAt });

test("derives Shanghai posting months and exact BigInt ledger reconciliation without inferring a business period", async () => {
  const fixture = await createCompleteSpool({
    settlement_account: [account("a", "A"), account("b", "B"), account("c", "C"), account("d", "D"), account("e", "E"), account("f", "F"), account("g", "G")],
    ledger_event: [event("aug", "2026-08-31 15:59:59+00"), event("sep", "2026-08-31 16:00:00+00"), event("later", "2026-09-02 00:00:00+00"), event("bad-time", "not-a-timestamp"), event("no-zone", "2026-09-03 00:00:00")],
    ledger_entry: [
      { id: "01", event_id: "aug", account_id: "a", category_key: "POSTED", amount_cents: "-9007199254740993", created_at: "2020-01-01 00:00:00+00" },
      { id: "02", event_id: "sep", account_id: "a", category_key: "POSTED", amount_cents: "9007199254740994", created_at: "2020-01-01 00:00:00+00" },
      { id: "03", event_id: "missing-event", account_id: "a", category_key: "POSTED", amount_cents: "5", created_at: "2020-01-01 00:00:00+00" },
      { id: "04", event_id: "later", account_id: "d", category_key: "POSTED", amount_cents: "5", created_at: "2020-01-01 00:00:00+00" },
      { id: "05", event_id: "later", account_id: "missing-account", category_key: "POSTED", amount_cents: "1", created_at: "2020-01-01 00:00:00+00" },
      { id: "06", event_id: "later", account_id: "e", category_key: "POSTED", amount_cents: "not-integer", created_at: "2020-01-01 00:00:00+00" },
      { id: "07", event_id: "bad-time", account_id: "a", category_key: "POSTED", amount_cents: "2", created_at: "2020-01-01 00:00:00+00" },
      { id: "08", event_id: "later", account_id: "e", category_key: "POSTED", amount_cents: "3", created_at: "2020-01-01 00:00:00+00" },
      { id: "09", event_id: "no-zone", account_id: "d", category_key: "POSTED", amount_cents: "2", created_at: "2020-01-01 00:00:00+00" },
    ],
    account_balance_projection: [
      { account_id: "a", balance_cents: "8", updated_at: "2026-09-01 00:00:00+00" },
      { account_id: "b", balance_cents: "0", updated_at: "2026-09-01 00:00:00+00" },
      { account_id: "c", balance_cents: "7", updated_at: "2026-09-01 00:00:00+00" },
      { account_id: "e", balance_cents: "0", updated_at: "2026-09-01 00:00:00+00" },
      { account_id: "f", balance_cents: "bad-projection", updated_at: "2026-09-01 00:00:00+00" },
      { account_id: "ghost", balance_cents: "0", updated_at: "2026-09-01 00:00:00+00" },
    ],
  });
  let index;
  let view;
  try {
    index = await FullBackupDerivedSpoolIndex.create({ spoolDirectory: fixture.directory, spool: fixture.spool, attemptRoot: join(fixture.root, "index") });
    view = await FullBackupLedgerDerivedView.create({ index, attemptRoot: join(fixture.root, "view") });
    assert.deepEqual(view.metadata(), {
      mode: "DERIVED_POSTED_LEDGER_VIEW", complete: false, spoolId: "ledger-synthetic", snapshotId: "ledger-snapshot", asOf: "2026-09-23T00:00:00.000Z",
      coverageGaps: ["SETTLEMENT_PUBLISHED_SNAPSHOTS_NOT_IMPLEMENTED", "BUSINESS_PERIOD_NOT_RESOLVED", "LEDGER_SOURCE_CHAIN_NOT_VERIFIED"],
      anomalyCount: "7", invalidMonthlyRowCount: "1",
      sourceValidation: "LEDGER_EVENT_AND_ACCOUNT_REFERENCE_ONLY",
    });

    const entries = await collect(view.streamEntries());
    assert.equal(entries.length, 9);
    assert.deepEqual(entries.slice(0, 2).map(({ amountCents, entryCreatedAt, postMonth, fiscalYearStart }) => ({ amountCents, entryCreatedAt, postMonth, fiscalYearStart })), [
      { amountCents: "-9007199254740993", entryCreatedAt: "2020-01-01 00:00:00+00", postMonth: "2026-08-01", fiscalYearStart: "2025-09-01" },
      { amountCents: "9007199254740994", entryCreatedAt: "2020-01-01 00:00:00+00", postMonth: "2026-09-01", fiscalYearStart: "2026-09-01" },
    ]);
    assert.equal(entries[0].eventKeyFingerprint, "aug-fingerprint");
    assert.equal("eventKey" in entries[0], false);
    assert.deepEqual(entries.find((row) => row.entryId === "03")?.sourceChainStatus, "EVENT_UNRESOLVED");
    assert.deepEqual(entries.find((row) => row.entryId === "05")?.sourceChainStatus, "ACCOUNT_UNRESOLVED");
    assert.equal(entries.find((row) => row.entryId === "07")?.postMonth, null);
    assert.equal(entries.find((row) => row.entryId === "09")?.postMonth, null);

    assert.deepEqual(await collect(view.streamMonthlyRows()), [
      { accountId: "a", postMonth: "2026-08-01", fiscalYearStart: "2025-09-01", categoryKey: "POSTED", signedNetCents: "-9007199254740993", entryCount: "1", invalidAmountCount: "0", status: "VALID" },
      { accountId: "a", postMonth: "2026-09-01", fiscalYearStart: "2026-09-01", categoryKey: "POSTED", signedNetCents: "9007199254740994", entryCount: "1", invalidAmountCount: "0", status: "VALID" },
      { accountId: "d", postMonth: "2026-09-01", fiscalYearStart: "2026-09-01", categoryKey: "POSTED", signedNetCents: "5", entryCount: "1", invalidAmountCount: "0", status: "VALID" },
      { accountId: "e", postMonth: "2026-09-01", fiscalYearStart: "2026-09-01", categoryKey: "POSTED", signedNetCents: null, entryCount: "2", invalidAmountCount: "1", status: "AMOUNT_INVALID" },
      { accountId: "missing-account", postMonth: "2026-09-01", fiscalYearStart: "2026-09-01", categoryKey: "POSTED", signedNetCents: "1", entryCount: "1", invalidAmountCount: "0", status: "VALID" },
    ]);

    const reconciliations = await collect(view.streamReconciliations());
    assert.deepEqual(reconciliations.map(({ accountId, ledgerNetCents, projectionBalanceCents, status }) => ({ accountId, ledgerNetCents, projectionBalanceCents, status })), [
      { accountId: "a", ledgerNetCents: "8", projectionBalanceCents: "8", status: "MATCH" },
      { accountId: "b", ledgerNetCents: "0", projectionBalanceCents: "0", status: "MATCH" },
      { accountId: "c", ledgerNetCents: "0", projectionBalanceCents: "7", status: "MISMATCH" },
      { accountId: "d", ledgerNetCents: "7", projectionBalanceCents: null, status: "MISSING_PROJECTION" },
      { accountId: "e", ledgerNetCents: null, projectionBalanceCents: "0", status: "LEDGER_TOTAL_INVALID" },
      { accountId: "f", ledgerNetCents: "0", projectionBalanceCents: "bad-projection", status: "PROJECTION_INVALID" },
      { accountId: "g", ledgerNetCents: "0", projectionBalanceCents: null, status: "MISSING_PROJECTION" },
      { accountId: "ghost", ledgerNetCents: "0", projectionBalanceCents: "0", status: "ACCOUNT_UNRESOLVED" },
      { accountId: "missing-account", ledgerNetCents: "1", projectionBalanceCents: null, status: "ACCOUNT_UNRESOLVED" },
    ]);

    const anomalies = await collect(view.streamAnomalies());
    assert.deepEqual(anomalies.map(({ code, sourceTable, field }) => ({ code, sourceTable, field })), [
      { code: "LEDGER_EVENT_UNRESOLVED", sourceTable: "ledger_entry", field: "event_id" },
      { code: "LEDGER_ACCOUNT_UNRESOLVED", sourceTable: "ledger_entry", field: "account_id" },
      { code: "LEDGER_ENTRY_AMOUNT_INVALID", sourceTable: "ledger_entry", field: "amount_cents" },
      { code: "LEDGER_EVENT_TIMESTAMP_INVALID", sourceTable: "ledger_entry", field: "event_created_at" },
      { code: "LEDGER_EVENT_TIMESTAMP_INVALID", sourceTable: "ledger_entry", field: "event_created_at" },
      { code: "ACCOUNT_PROJECTION_AMOUNT_INVALID", sourceTable: "account_balance_projection", field: "balance_cents" },
      { code: "ACCOUNT_PROJECTION_ACCOUNT_UNRESOLVED", sourceTable: "account_balance_projection", field: "account_id" },
    ]);
    assert.equal(JSON.stringify(anomalies).includes("not-integer"), false);
    assert.equal(JSON.stringify(anomalies).includes("missing-event"), false);

    const active = view.streamEntries();
    assert.equal((await active.next()).done, false);
    await view.close();
    await assert.rejects(active.next(), /EXPORT_LEDGER_DERIVED_CLOSED/);
    await view.close();
    assert.deepEqual(await readdir(join(fixture.root, "view")), []);
    // Closing the derived view cannot close the caller-owned index.
    assert.equal((await index.stream("ledger_entry").next()).done, false);
  } finally {
    await view?.close().catch(() => undefined);
    await index?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects normalized invalid calendar dates while preserving ledger amounts and real leap days", async () => {
  const timestamps = ["2026-02-30 00:00:00+00", "2026-02-29T00:00:00Z", "2026-09-01T24:00:00Z", "2024-02-29 16:00:00.123456+00"];
  const fixture = await createCompleteSpool({
    settlement_account: [account("calendar", "CALENDAR")],
    ledger_event: timestamps.map((timestamp, i) => event(`calendar-${i}`, timestamp)),
    ledger_entry: timestamps.map((_, i) => ({ id: String(i + 1), event_id: `calendar-${i}`, account_id: "calendar", category_key: "POSTED", amount_cents: "1", created_at: "2026-01-01 00:00:00+00" })),
    account_balance_projection: [{ account_id: "calendar", balance_cents: "4", updated_at: "2026-09-01 00:00:00+00" }],
  });
  let index;
  let view;
  try {
    index = await FullBackupDerivedSpoolIndex.create({ spoolDirectory: fixture.directory, spool: fixture.spool, attemptRoot: join(fixture.root, "index") });
    view = await FullBackupLedgerDerivedView.create({ index, attemptRoot: join(fixture.root, "view") });
    const entries = await collect(view.streamEntries());
    assert.deepEqual(entries.map(row => row.eventCreatedAt), timestamps);
    assert.deepEqual(entries.map(row => row.postMonth), [null, null, null, "2024-03-01"]);
    assert.equal((await collect(view.streamMonthlyRows()))[0].signedNetCents, "1");
    const [reconciliation] = await collect(view.streamReconciliations());
    assert.equal(reconciliation.ledgerNetCents, "4");
    assert.equal(reconciliation.status, "MATCH");
    assert.equal(view.metadata().anomalyCount, "3");
    assert.ok((await collect(view.streamAnomalies())).every(row => row.code === "LEDGER_EVENT_TIMESTAMP_INVALID"));
  } finally {
    await view?.close();
    await index?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
