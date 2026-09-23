import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FullBackupDerivedSpoolIndex } from "../dist/full-backup-derived-spool-index.js";
import { FullBackupLedgerBusinessPeriodSource } from "../dist/full-backup-ledger-business-period-source.js";
import { createFullBackupLayout } from "../dist/full-backup-layout.js";
import { fullBackupOutputColumns } from "../dist/full-backup-transformer.js";

const hash = (v) => createHash("sha256").update(v).digest("hex");
const row = (columns, record = {}) =>
  columns.map((column) => record[column] ?? null);
const collect = async (stream) => {
  const rows = [];
  for await (const item of stream) rows.push(item);
  return rows;
};
const spool = async (records) => {
  const root = await mkdtemp(join(tmpdir(), "ledger-period-")),
    dir = join(root, "spool");
  await mkdir(join(dir, "datasets"), { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await chmod(join(dir, "datasets"), 0o700);
  const datasets = [];
  for (const [i, item] of createFullBackupLayout().entries()) {
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
    const columns = fullBackupOutputColumns(item.tableName),
      rows = (records[item.tableName] ?? []).map((x) => row(columns, x)),
      content = `${JSON.stringify({ columns })}\n${rows.map((x) => `${JSON.stringify(x)}\n`).join("")}`,
      spoolFile = `datasets/${String(i + 1).padStart(3, "0")}_${item.tableName}.ndjson`;
    await writeFile(join(dir, spoolFile), content, { mode: 0o600 });
    datasets.push({
      tableName: item.tableName,
      columns,
      rowCount: String(rows.length),
      logicalDigest: hash(content),
      spoolFile,
      excluded: false,
    });
  }
  await writeFile(join(dir, "anomalies.ndjson"), "", { mode: 0o600 });
  return {
    root,
    dir,
    result: {
      mode: "RAW_SOURCE_SPOOL",
      spoolId: "p",
      snapshotId: "s",
      asOf: "2026-09-23T00:00:00.000Z",
      datasets,
      anomalyFile: "anomalies.ndjson",
      anomalyCount: "0",
      coverageGaps: [
        "MONTHLY_INCOME_PUBLISHED_VERSIONS_NOT_IMPLEMENTED",
        "MANUAL_ADJUSTMENT_WORKFLOW_NOT_IMPLEMENTED",
        "BACKUP_JOB_AND_SCHEDULE_HISTORY_NOT_IMPLEMENTED",
        "NICKNAME_CORRECTION_HISTORY_NOT_IMPLEMENTED",
      ],
    },
  };
};

test("uses every settlement snapshot and preserves unresolved refund links without monetary allocation", async () => {
  const f = await spool({
    ledger_event: [
      {
        id: "event-settle",
        event_type: "WEEKLY_FEE_SETTLEMENT",
        payload_hash: "h",
        created_at: "2026-01-01 00:00:00+00",
        event_key_fingerprint: "f",
      },
      {
        id: "event-other",
        event_type: "CASH_WAGE_CONFIRMED",
        payload_hash: "h",
        created_at: "2026-01-01 00:00:00+00",
        event_key_fingerprint: "x",
      },
    ],
    settlement_calculation_run: [
      {
        id: "run",
        request_key_fingerprint: "r",
        fee_entry_id: "anchor-sep",
        fee_version: "1",
        actor_person_id: "a",
        status: "POSTED",
        ledger_event_id: "event-settle",
        created_at: "2026-01-01 00:00:00+00",
      },
    ],
    weekly_fee_allocation_snapshot: [
      {
        id: "s1",
        sequence_no: "1",
        run_id: "run",
        weekly_fee_entry_id: "anchor-sep",
        source_weekly_fee_version: "1",
        policy_version_id: "p",
        net_monthly_cents: "0",
        snapshot_json: "{}",
        context_json: "{}",
        created_at: "2026-01-01 00:00:00+00",
      },
      {
        id: "s2",
        sequence_no: "2",
        run_id: "run",
        weekly_fee_entry_id: "other-oct",
        source_weekly_fee_version: "2",
        policy_version_id: "p",
        net_monthly_cents: "0",
        snapshot_json: "{}",
        context_json: "{}",
        created_at: "2026-01-01 00:00:00+00",
      },
    ],
    weekly_fee_entry_version: [
      {
        id: "v1",
        weekly_fee_entry_id: "anchor-sep",
        referral_case_id: "r",
        teaching_week_id: "w",
        settlement_month: "2026-09-01",
        gross_amount_cents: "1",
        venue_id: "v",
        venue_owner_person_id: "o",
        is_self_use_snapshot: "false",
        source_case_version: "1",
        version: "1",
        recorded_by: "a",
        recorded_at: "2026-01-01 00:00:00+00",
      },
      {
        id: "v2",
        weekly_fee_entry_id: "other-oct",
        referral_case_id: "r",
        teaching_week_id: "w",
        settlement_month: "2026-10-01",
        gross_amount_cents: "1",
        venue_id: "v",
        venue_owner_person_id: "o",
        is_self_use_snapshot: "false",
        source_case_version: "1",
        version: "2",
        recorded_by: "a",
        recorded_at: "2026-01-01 00:00:00+00",
      },
    ],
  });
  let index, source;
  try {
    index = await FullBackupDerivedSpoolIndex.create({
      spoolDirectory: f.dir,
      spool: f.result,
      attemptRoot: join(f.root, "index"),
    });
    source = await FullBackupLedgerBusinessPeriodSource.create({
      index,
      attemptRoot: join(f.root, "period"),
    });
    const periods = await collect(source.streamEventPeriods());
    assert.deepEqual(
      periods.map(
        ({
          eventId,
          status,
          uniqueLockedSettlementMonth,
          distinctMonthCount,
        }) => ({
          eventId,
          status,
          uniqueLockedSettlementMonth,
          distinctMonthCount,
        }),
      ),
      [
        {
          eventId: "event-other",
          status: "UNIMPLEMENTED_EVENT_TYPE",
          uniqueLockedSettlementMonth: null,
          distinctMonthCount: "0",
        },
        {
          eventId: "event-settle",
          status: "MULTIPLE_BUSINESS_PERIODS",
          uniqueLockedSettlementMonth: null,
          distinctMonthCount: "2",
        },
      ],
    );
    const links = await collect(source.streamSourceLinks());
    assert.equal(
      links.some((link) => "grossAmountCents" in link || "amountCents" in link),
      false,
    );
    assert.deepEqual(
      links
        .filter(
          (link) =>
            link.eventId === "event-settle" &&
            link.relation === "WEEKLY_FEE_VERSION",
        )
        .map((link) => link.lockedSettlementMonth),
      ["2026-09-01", "2026-10-01"],
    );
    const open = source.streamEventPeriods();
    await open.next();
    await source.close();
    await assert.rejects(open.next(), /EXPORT_LEDGER_PERIOD_CLOSED/);
    await source.close();
    assert.deepEqual(await readdir(join(f.root, "period")), []);
  } finally {
    await source?.close().catch(() => {});
    await index?.close().catch(() => {});
    await rm(f.root, { recursive: true, force: true });
  }
});

const inspectPeriods = async (records, verify) => {
  const f = await spool(records);
  let index, source;
  try {
    index = await FullBackupDerivedSpoolIndex.create({
      spoolDirectory: f.dir, spool: f.result, attemptRoot: join(f.root, "index"),
    });
    source = await FullBackupLedgerBusinessPeriodSource.create({ index, attemptRoot: join(f.root, "period") });
    await verify({
      periods: await collect(source.streamEventPeriods()),
      links: await collect(source.streamSourceLinks()),
      anomalies: await collect(source.streamAnomalies()),
      metadata: source.metadata(),
    });
  } finally {
    await source?.close();
    await index?.close();
    await rm(f.root, { recursive: true, force: true });
  }
};
const refundRecords = () => ({
  ledger_event: [{ id: "refund-event", event_type: "WEEKLY_FEE_REFUND" }],
  finance_refund_decision: [{ finance_document_id: "doc", ledger_event_id: "refund-event", decision: "APPROVED", posting_status: "POSTED" }],
  finance_refund_submission_item: [{ finance_document_id: "doc", weekly_fee_entry_id: "fee", submitted_fee_version: "2", settlement_month: "2026-09-01" }],
  weekly_fee_refund_effect: [{ finance_document_id: "doc", weekly_fee_entry_id: "fee", source_weekly_fee_version: "2", allocation_snapshot_id: "snapshot" }],
  weekly_fee_allocation_snapshot: [{ id: "snapshot", run_id: "run", sequence_no: "1", weekly_fee_entry_id: "fee", source_weekly_fee_version: "2" }],
  weekly_fee_entry_version: [
    { id: "v1", weekly_fee_entry_id: "fee", version: "1", settlement_month: "2026-08-01" },
    { id: "v2", weekly_fee_entry_id: "fee", version: "2", settlement_month: "2026-09-01" },
    { id: "v3", weekly_fee_entry_id: "fee", version: "3", settlement_month: "2026-10-01" },
  ],
});

test("refund provenance selects the exact historical version and retains its allocation snapshot", async () => {
  await inspectPeriods(refundRecords(), ({ periods, links, anomalies, metadata }) => {
    assert.equal(periods[0].status, "UNIQUE_LOCKED_SETTLEMENT_MONTH");
    assert.equal(periods[0].uniqueLockedSettlementMonth, "2026-09-01");
    assert.equal(periods[0].sourceLinkCount, "5");
    assert.deepEqual(anomalies, []);
    assert.equal(metadata.complete, false);
    assert.equal(metadata.anomalyCount, "0");
    assert.deepEqual(links.filter((x) => x.relation === "WEEKLY_FEE_VERSION").map((x) => x.weeklyFeeVersion), ["2"]);
    assert.equal(links.filter((x) => x.relation === "ALLOCATION_SNAPSHOT")[0].allocationSnapshotId, "snapshot");
  });
});

test("orphan refund items and broken snapshot/version/month links cannot publish a unique period", async (t) => {
  const scenarios = [
    ["same count different member", (r) => { r.finance_refund_submission_item[0].weekly_fee_entry_id = "orphan"; }, "REFUND_ITEM_EFFECT_MISMATCH"],
    ["missing effect", (r) => { r.weekly_fee_refund_effect = []; }, "REFUND_EFFECT_OR_ITEM_MISSING"],
    ["missing snapshot", (r) => { r.weekly_fee_allocation_snapshot = []; }, "REFUND_ALLOCATION_SNAPSHOT_UNRESOLVED"],
    ["wrong historical version", (r) => { r.weekly_fee_refund_effect[0].source_weekly_fee_version = "4"; }, "REFUND_FEE_VERSION_UNRESOLVED"],
    ["wrong submitted month", (r) => { r.finance_refund_submission_item[0].settlement_month = "2026-10-01"; }, "REFUND_MONTH_MISMATCH"],
    ["invalid calendar month", (r) => { r.weekly_fee_entry_version[1].settlement_month = "2026-13-01"; }, "REFUND_FEE_VERSION_UNRESOLVED"],
    ["rejected decision", (r) => { r.finance_refund_decision[0].decision = "REJECTED"; }, "REFUND_DECISION_INVALID"],
  ];
  for (const [name, mutate, code] of scenarios) {
    await t.test(name, async () => {
      const records = refundRecords(); mutate(records);
      await inspectPeriods(records, ({ periods, links, anomalies, metadata }) => {
        assert.equal(periods[0].status, "UNRESOLVED");
        assert.equal(periods[0].uniqueLockedSettlementMonth, null);
        assert.ok(anomalies.some((x) => x.code === code));
        assert.equal(metadata.anomalyCount, String(anomalies.length));
        const items = links.filter((x) => x.relation === "REFUND_SUBMISSION_ITEM");
        assert.equal(items.length, records.finance_refund_submission_item.length);
        assert.equal(items[0].weeklyFeeEntryId, records.finance_refund_submission_item[0].weekly_fee_entry_id);
      });
    });
  }
});
