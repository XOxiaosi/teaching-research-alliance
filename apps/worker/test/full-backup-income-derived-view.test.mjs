import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FullBackupDerivedSpoolIndex } from "../dist/full-backup-derived-spool-index.js";
import { FullBackupIncomeDerivedView } from "../dist/full-backup-income-derived-view.js";
import { createFullBackupLayout, FULL_BACKUP_KNOWN_COVERAGE_GAPS } from "../dist/full-backup-layout.js";
import { fullBackupOutputColumns } from "../dist/full-backup-transformer.js";

const digest = (content) => createHash("sha256").update(content, "utf8").digest("hex");
const valuesFor = (columns, record = {}) => columns.map((column) => record[column] ?? null);
const collect = async (stream) => { const rows = []; for await (const row of stream) rows.push(row); return rows; };

const completeSpool = async (records) => {
  const root = await mkdtemp(join(tmpdir(), "income-derived-view-"));
  const directory = join(root, "spool");
  await mkdir(join(directory, "datasets"), { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700); await chmod(join(directory, "datasets"), 0o700);
  const datasets = [];
  for (const [index, layout] of createFullBackupLayout().entries()) {
    if (layout.policy === "AUTH_SECRET_TABLE_EXCLUDED") {
      datasets.push({ tableName: layout.tableName, columns: [], rowCount: null, logicalDigest: null, spoolFile: null, excluded: true });
      continue;
    }
    const columns = fullBackupOutputColumns(layout.tableName);
    const rows = (records[layout.tableName] ?? []).map((record) => valuesFor(columns, record));
    const content = `${JSON.stringify({ columns })}\n${rows.map((row) => `${JSON.stringify(row)}\n`).join("")}`;
    const spoolFile = `datasets/${String(index + 1).padStart(3, "0")}_${layout.tableName}.ndjson`;
    await writeFile(join(directory, spoolFile), content, { mode: 0o600 });
    datasets.push({ tableName: layout.tableName, columns, rowCount: String(rows.length), logicalDigest: digest(content), spoolFile, excluded: false });
  }
  await writeFile(join(directory, "anomalies.ndjson"), "", { mode: 0o600 });
  return { root, directory, spool: {
    mode: "RAW_SOURCE_SPOOL", spoolId: "income-synthetic-spool", snapshotId: "income-synthetic-snapshot", asOf: "2026-09-23T00:00:00.000Z",
    datasets, anomalyFile: "anomalies.ndjson", anomalyCount: "0", coverageGaps: FULL_BACKUP_KNOWN_COVERAGE_GAPS,
  } };
};

const snapshot = ({ feeId, version, month, lines, accounts }) => ({
  snapshot_json: JSON.stringify({ lines: [
    { key: "referrer", cents: "0" }, { key: "planningMentor", cents: "0" }, { key: "groupLeader", cents: String(lines.groupLeader ?? 0) },
    { key: "teachingMentor", cents: "0" }, { key: "venue", cents: "0" }, { key: "campusConsultation", cents: "0" },
    { key: "platformFinance", cents: "0" }, { key: "regionFinance", cents: "0" }, { key: "teachingTeacher", cents: String(lines.teachingTeacher ?? 0) },
  ], accountByKey: Object.fromEntries(Object.entries(accounts).map(([key, account]) => [key, account.accountCode])) }),
  context_json: JSON.stringify({ feeEntryId: feeId, feeVersion: version, settlementMonth: month, accounts }),
});

const account = (id, ownerType, ownerId, accountCode) => ({ accountId: id, ownerType, ownerId, accountCode });

test("keeps the latest all-version snapshot as a PARTIAL anomaly while valid frozen income and refund sources stay traceable", async () => {
  const accounts = {
    leader: account("account-a", "PERSON", "person-a", "person:leader"),
    teacher: account("account-c", "PERSON", "person-c", "person:teacher"),
  };
  const valid = snapshot({ feeId: "fee-valid", version: "1", month: "2026-09-01", lines: { groupLeader: "9007199254740990", teachingTeacher: "3" }, accounts: { groupLeader: accounts.leader, teachingTeacher: accounts.teacher } });
  const old = snapshot({ feeId: "fee-bad", version: "1", month: "2026-09-01", lines: { groupLeader: "30", teachingTeacher: "70" }, accounts: { groupLeader: accounts.leader, teachingTeacher: accounts.teacher } });
  const newestWrongVersion = snapshot({ feeId: "fee-bad", version: "2", month: "2026-09-01", lines: { groupLeader: "30", teachingTeacher: "70" }, accounts: { groupLeader: accounts.leader, teachingTeacher: accounts.teacher } });
  const fixture = await completeSpool({
    settlement_account: [
      { id: "account-a", owner_type: "PERSON", owner_id: "person-a", account_code: "person:leader", status: "ACTIVE" },
      { id: "account-c", owner_type: "PERSON", owner_id: "person-c", account_code: "person:teacher", status: "ACTIVE" },
    ],
    weekly_fee_entry: [
      { id: "fee-valid", version: "1", settlement_month: "2026-09-01", gross_amount_cents: "9007199254740993" },
      { id: "fee-bad", version: "1", settlement_month: "2026-09-01", gross_amount_cents: "100" },
    ],
    weekly_fee_entry_version: [
      { id: "fee-valid-v1", weekly_fee_entry_id: "fee-valid", version: "1", settlement_month: "2026-09-01", gross_amount_cents: "9007199254740993" },
      { id: "fee-bad-v1", weekly_fee_entry_id: "fee-bad", version: "1", settlement_month: "2026-09-01", gross_amount_cents: "100" },
    ],
    weekly_fee_allocation_snapshot: [
      { id: "snapshot-old", sequence_no: "1", run_id: "run-old", weekly_fee_entry_id: "fee-bad", source_weekly_fee_version: "1", policy_version_id: "policy-old", net_monthly_cents: "0", ...old },
      { id: "snapshot-valid", sequence_no: "2", run_id: "run-valid", weekly_fee_entry_id: "fee-valid", source_weekly_fee_version: "1", policy_version_id: "policy-valid", net_monthly_cents: "0", ...valid },
      { id: "snapshot-newest-wrong", sequence_no: "3", run_id: "run-bad", weekly_fee_entry_id: "fee-bad", source_weekly_fee_version: "2", policy_version_id: "policy-new", net_monthly_cents: "0", ...newestWrongVersion },
    ],
    finance_document: [{ id: "refund-doc", kind: "REFUND", status: "REFUNDED", version: "3" }],
    finance_refund_decision: [{ finance_document_id: "refund-doc", decision: "APPROVED", posting_status: "POSTED", ledger_event_id: "refund-event", approved_gross_amount_cents: "9007199254740993" }],
    finance_refund_submission_item: [{ finance_document_id: "refund-doc", weekly_fee_entry_id: "fee-valid", submitted_fee_version: "1", submitted_gross_amount_cents: "9007199254740993", settlement_month: "2026-09-01" }],
    weekly_fee_refund_effect: [{ weekly_fee_entry_id: "fee-valid", finance_document_id: "refund-doc", allocation_snapshot_id: "snapshot-valid", source_weekly_fee_version: "1", gross_amount_cents: "9007199254740993", snapshot_json: valid.snapshot_json }],
    ledger_event: [{ id: "refund-event", event_type: "WEEKLY_FEE_REFUND" }],
    ledger_entry: [
      { id: "refund-ledger-a", event_id: "refund-event", account_id: "account-a", category_key: "groupLeader", amount_cents: "-9007199254740990" },
      { id: "refund-ledger-c", event_id: "refund-event", account_id: "account-c", category_key: "teachingTeacher", amount_cents: "-3" },
    ],
  });
  const indexRoot = join(fixture.root, "index");
  const viewRoot = join(fixture.root, "view");
  let index; let view;
  try {
    index = await FullBackupDerivedSpoolIndex.create({ spoolDirectory: fixture.directory, spool: fixture.spool, attemptRoot: indexRoot });
    view = await FullBackupIncomeDerivedView.create({ index, attemptRoot: viewRoot });
    assert.deepEqual(view.metadata(), {
      mode: "INCOME_DERIVED_VIEW", complete: false, tableNumber: 3, status: "PARTIAL",
      spoolId: "income-synthetic-spool", snapshotId: "income-synthetic-snapshot", asOf: "2026-09-23T00:00:00.000Z", publishedVersion: null,
      gaps: ["SETTLEMENT_PUBLISHED_SNAPSHOTS_NOT_IMPLEMENTED"], anomalyCount: "1", incompleteFeeCount: "1",
      sourceBasis: view.metadata().sourceBasis,
    });
    assert.equal(view.metadata().sourceBasis.contributionDigest.length, 64);
    const anomalies = await collect(view.streamAnomalies());
    assert.equal(anomalies.length, 1);
    assert.equal(anomalies[0].code, "EXPORT_INCOME_DERIVED_LATEST_SNAPSHOT_VERSION_MISMATCH");
    const rows = await collect(view.streamMonthlyRows());
    assert.deepEqual(rows, [
      { accountId: "account-a", ownerType: "PERSON", ownerId: "person-a", accountCode: "person:leader", settlementMonth: "2026-09-01", financeYear: "2026-2027", allocationKey: "groupLeader", positiveCents: 9007199254740990n, refundCents: -9007199254740990n, netCents: 0n, contributionCount: "2" },
      { accountId: "account-c", ownerType: "PERSON", ownerId: "person-c", accountCode: "person:teacher", settlementMonth: "2026-09-01", financeYear: "2026-2027", allocationKey: "teachingTeacher", positiveCents: 3n, refundCents: -3n, netCents: 0n, contributionCount: "2" },
    ]);
    assert.deepEqual(await collect(view.streamContributionSources({ accountId: "account-a", settlementMonth: "2026-09-01", allocationKey: "groupLeader" })), [
      { accountId: "account-a", settlementMonth: "2026-09-01", allocationKey: "groupLeader", signedCents: 9007199254740990n, feeEntryId: "fee-valid", feeVersion: "1", allocationSnapshotId: "snapshot-valid", allocationSnapshotSourceKey: '[["id","snapshot-valid"]]', settlementRunId: "run-valid", policyVersionId: "policy-valid", refundFinanceDocumentId: null, refundEffectSourceKey: null },
      { accountId: "account-a", settlementMonth: "2026-09-01", allocationKey: "groupLeader", signedCents: -9007199254740990n, feeEntryId: "fee-valid", feeVersion: "1", allocationSnapshotId: "snapshot-valid", allocationSnapshotSourceKey: '[["id","snapshot-valid"]]', settlementRunId: "run-valid", policyVersionId: "policy-valid", refundFinanceDocumentId: "refund-doc", refundEffectSourceKey: '[["weekly_fee_entry_id","fee-valid"]]' },
    ]);
    await view.close(); await index.close();
    assert.deepEqual(await readdir(viewRoot), []); assert.deepEqual(await readdir(indexRoot), []);
  } finally {
    await view?.close().catch(() => undefined); await index?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a refund ledger mismatch excludes the affected fee instead of returning invented partial money", async () => {
  const accounts = { teacher: account("account-c", "PERSON", "person-c", "person:teacher") };
  const frozen = snapshot({ feeId: "fee", version: "1", month: "2026-08-01", lines: { teachingTeacher: "100" }, accounts: { teachingTeacher: accounts.teacher } });
  const fixture = await completeSpool({
    settlement_account: [{ id: "account-c", owner_type: "PERSON", owner_id: "person-c", account_code: "person:teacher", status: "ACTIVE" }],
    weekly_fee_entry: [{ id: "fee", version: "1", settlement_month: "2026-08-01", gross_amount_cents: "100" }],
    weekly_fee_entry_version: [{ id: "fee-v1", weekly_fee_entry_id: "fee", version: "1", settlement_month: "2026-08-01", gross_amount_cents: "100" }],
    weekly_fee_allocation_snapshot: [{ id: "snapshot", sequence_no: "1", run_id: "run", weekly_fee_entry_id: "fee", source_weekly_fee_version: "1", policy_version_id: "policy", net_monthly_cents: "0", ...frozen }],
    finance_document: [{ id: "refund-doc", kind: "REFUND", status: "REFUNDED", version: "3" }],
    finance_refund_decision: [{ finance_document_id: "refund-doc", decision: "APPROVED", posting_status: "POSTED", ledger_event_id: "refund-event", approved_gross_amount_cents: "100" }],
    finance_refund_submission_item: [{ finance_document_id: "refund-doc", weekly_fee_entry_id: "fee", submitted_fee_version: "1", submitted_gross_amount_cents: "100", settlement_month: "2026-08-01" }],
    weekly_fee_refund_effect: [{ weekly_fee_entry_id: "fee", finance_document_id: "refund-doc", allocation_snapshot_id: "snapshot", source_weekly_fee_version: "1", gross_amount_cents: "100", snapshot_json: frozen.snapshot_json }],
    ledger_event: [{ id: "refund-event", event_type: "WEEKLY_FEE_REFUND" }],
    ledger_entry: [{ id: "ledger", event_id: "refund-event", account_id: "account-c", category_key: "teachingTeacher", amount_cents: "-99" }],
  });
  let index; let view;
  try {
    index = await FullBackupDerivedSpoolIndex.create({ spoolDirectory: fixture.directory, spool: fixture.spool, attemptRoot: join(fixture.root, "index") });
    view = await FullBackupIncomeDerivedView.create({ index, attemptRoot: join(fixture.root, "view") });
    assert.equal(view.metadata().status, "PARTIAL");
    assert.equal(view.metadata().incompleteFeeCount, "1");
    assert.deepEqual(await collect(view.streamMonthlyRows()), []);
    assert.equal((await collect(view.streamAnomalies())).some((item) => item.code === "REFUND_LEDGER_MISMATCH"), true);
  } finally { await view?.close().catch(() => undefined); await index?.close().catch(() => undefined); await rm(fixture.root, { recursive: true, force: true }); }
});

test("a posted refund document may contain a zero-allocation fee beside a nonzero fee, while a wholly zero document requires NO_BALANCE_CHANGE", async () => {
  const accounts = { teacher: account("account-c", "PERSON", "person-c", "person:teacher") };
  const positive = snapshot({ feeId: "fee-positive", version: "1", month: "2026-09-01", lines: { teachingTeacher: "100" }, accounts: { teachingTeacher: accounts.teacher } });
  const zero = snapshot({ feeId: "fee-zero", version: "1", month: "2026-09-01", lines: {}, accounts: {} });
  const allZero = snapshot({ feeId: "fee-all-zero", version: "1", month: "2026-09-01", lines: {}, accounts: {} });
  const fixture = await completeSpool({
    settlement_account: [{ id: "account-c", owner_type: "PERSON", owner_id: "person-c", account_code: "person:teacher", status: "ACTIVE" }],
    weekly_fee_entry: [
      { id: "fee-positive", version: "1", settlement_month: "2026-09-01", gross_amount_cents: "100" },
      { id: "fee-zero", version: "1", settlement_month: "2026-09-01", gross_amount_cents: "0" },
      { id: "fee-all-zero", version: "1", settlement_month: "2026-09-01", gross_amount_cents: "0" },
    ],
    weekly_fee_entry_version: [
      { id: "fee-positive-v1", weekly_fee_entry_id: "fee-positive", version: "1", settlement_month: "2026-09-01", gross_amount_cents: "100" },
      { id: "fee-zero-v1", weekly_fee_entry_id: "fee-zero", version: "1", settlement_month: "2026-09-01", gross_amount_cents: "0" },
      { id: "fee-all-zero-v1", weekly_fee_entry_id: "fee-all-zero", version: "1", settlement_month: "2026-09-01", gross_amount_cents: "0" },
    ],
    weekly_fee_allocation_snapshot: [
      { id: "snapshot-positive", sequence_no: "1", run_id: "run-positive", weekly_fee_entry_id: "fee-positive", source_weekly_fee_version: "1", policy_version_id: "policy", net_monthly_cents: "0", ...positive },
      { id: "snapshot-zero", sequence_no: "1", run_id: "run-zero", weekly_fee_entry_id: "fee-zero", source_weekly_fee_version: "1", policy_version_id: "policy", net_monthly_cents: "0", ...zero },
      { id: "snapshot-all-zero", sequence_no: "1", run_id: "run-all-zero", weekly_fee_entry_id: "fee-all-zero", source_weekly_fee_version: "1", policy_version_id: "policy", net_monthly_cents: "0", ...allZero },
    ],
    finance_document: [
      { id: "mixed-refund", kind: "REFUND", status: "REFUNDED", version: "3" },
      { id: "all-zero-refund", kind: "REFUND", status: "REFUNDED", version: "3" },
    ],
    finance_refund_decision: [
      { finance_document_id: "mixed-refund", decision: "APPROVED", posting_status: "POSTED", ledger_event_id: "mixed-event", approved_gross_amount_cents: "100" },
      { finance_document_id: "all-zero-refund", decision: "APPROVED", posting_status: "NO_BALANCE_CHANGE", ledger_event_id: null, approved_gross_amount_cents: "0" },
    ],
    finance_refund_submission_item: [
      { finance_document_id: "mixed-refund", weekly_fee_entry_id: "fee-positive", submitted_fee_version: "1", submitted_gross_amount_cents: "100", settlement_month: "2026-09-01" },
      { finance_document_id: "mixed-refund", weekly_fee_entry_id: "fee-zero", submitted_fee_version: "1", submitted_gross_amount_cents: "0", settlement_month: "2026-09-01" },
      { finance_document_id: "all-zero-refund", weekly_fee_entry_id: "fee-all-zero", submitted_fee_version: "1", submitted_gross_amount_cents: "0", settlement_month: "2026-09-01" },
    ],
    weekly_fee_refund_effect: [
      { weekly_fee_entry_id: "fee-positive", finance_document_id: "mixed-refund", allocation_snapshot_id: "snapshot-positive", source_weekly_fee_version: "1", gross_amount_cents: "100", snapshot_json: positive.snapshot_json },
      { weekly_fee_entry_id: "fee-zero", finance_document_id: "mixed-refund", allocation_snapshot_id: "snapshot-zero", source_weekly_fee_version: "1", gross_amount_cents: "0", snapshot_json: zero.snapshot_json },
      { weekly_fee_entry_id: "fee-all-zero", finance_document_id: "all-zero-refund", allocation_snapshot_id: "snapshot-all-zero", source_weekly_fee_version: "1", gross_amount_cents: "0", snapshot_json: allZero.snapshot_json },
    ],
    ledger_event: [{ id: "mixed-event", event_type: "WEEKLY_FEE_REFUND" }],
    ledger_entry: [{ id: "mixed-ledger", event_id: "mixed-event", account_id: "account-c", category_key: "teachingTeacher", amount_cents: "-100" }],
  });
  let index; let view;
  try {
    index = await FullBackupDerivedSpoolIndex.create({ spoolDirectory: fixture.directory, spool: fixture.spool, attemptRoot: join(fixture.root, "index") });
    view = await FullBackupIncomeDerivedView.create({ index, attemptRoot: join(fixture.root, "view") });
    assert.equal(view.metadata().status, "DERIVED_UNPUBLISHED");
    assert.deepEqual(await collect(view.streamAnomalies()), []);
    assert.deepEqual(await collect(view.streamMonthlyRows()), [{ accountId: "account-c", ownerType: "PERSON", ownerId: "person-c", accountCode: "person:teacher", settlementMonth: "2026-09-01", financeYear: "2026-2027", allocationKey: "teachingTeacher", positiveCents: 100n, refundCents: -100n, netCents: 0n, contributionCount: "2" }]);
    assert.deepEqual(await collect(view.streamContributionSources({ accountId: "account-c", settlementMonth: "2026-09-01", allocationKey: "teachingTeacher" })), [
      { accountId: "account-c", settlementMonth: "2026-09-01", allocationKey: "teachingTeacher", signedCents: 100n, feeEntryId: "fee-positive", feeVersion: "1", allocationSnapshotId: "snapshot-positive", allocationSnapshotSourceKey: '[["id","snapshot-positive"]]', settlementRunId: "run-positive", policyVersionId: "policy", refundFinanceDocumentId: null, refundEffectSourceKey: null },
      { accountId: "account-c", settlementMonth: "2026-09-01", allocationKey: "teachingTeacher", signedCents: -100n, feeEntryId: "fee-positive", feeVersion: "1", allocationSnapshotId: "snapshot-positive", allocationSnapshotSourceKey: '[["id","snapshot-positive"]]', settlementRunId: "run-positive", policyVersionId: "policy", refundFinanceDocumentId: "mixed-refund", refundEffectSourceKey: '[["weekly_fee_entry_id","fee-positive"]]' },
    ]);
  } finally { await view?.close().catch(() => undefined); await index?.close().catch(() => undefined); await rm(fixture.root, { recursive: true, force: true }); }
});

test("a wholly zero refund marked POSTED is a visible anomaly", async () => {
  const zero = snapshot({ feeId: "fee-zero", version: "1", month: "2026-09-01", lines: {}, accounts: {} });
  const fixture = await completeSpool({
    weekly_fee_entry: [{ id: "fee-zero", version: "1", settlement_month: "2026-09-01", gross_amount_cents: "0" }],
    weekly_fee_entry_version: [{ id: "fee-zero-v1", weekly_fee_entry_id: "fee-zero", version: "1", settlement_month: "2026-09-01", gross_amount_cents: "0" }],
    weekly_fee_allocation_snapshot: [{ id: "snapshot-zero", sequence_no: "1", run_id: "run-zero", weekly_fee_entry_id: "fee-zero", source_weekly_fee_version: "1", policy_version_id: "policy", net_monthly_cents: "0", ...zero }],
    finance_document: [{ id: "bad-zero-refund", kind: "REFUND", status: "REFUNDED", version: "3" }],
    finance_refund_decision: [{ finance_document_id: "bad-zero-refund", decision: "APPROVED", posting_status: "POSTED", ledger_event_id: "bad-zero-event", approved_gross_amount_cents: "0" }],
    finance_refund_submission_item: [{ finance_document_id: "bad-zero-refund", weekly_fee_entry_id: "fee-zero", submitted_fee_version: "1", submitted_gross_amount_cents: "0", settlement_month: "2026-09-01" }],
    weekly_fee_refund_effect: [{ weekly_fee_entry_id: "fee-zero", finance_document_id: "bad-zero-refund", allocation_snapshot_id: "snapshot-zero", source_weekly_fee_version: "1", gross_amount_cents: "0", snapshot_json: zero.snapshot_json }],
    ledger_event: [{ id: "bad-zero-event", event_type: "WEEKLY_FEE_REFUND" }],
  });
  let index; let view;
  try {
    index = await FullBackupDerivedSpoolIndex.create({ spoolDirectory: fixture.directory, spool: fixture.spool, attemptRoot: join(fixture.root, "index") });
    view = await FullBackupIncomeDerivedView.create({ index, attemptRoot: join(fixture.root, "view") });
    assert.equal(view.metadata().status, "PARTIAL");
    assert.equal((await collect(view.streamAnomalies())).some((item) => item.code === "EXPORT_INCOME_DERIVED_REFUND_LEDGER_INVALID" && item.feeEntryId === "fee-zero"), true);
    assert.deepEqual(await collect(view.streamMonthlyRows()), []);
  } finally { await view?.close().catch(() => undefined); await index?.close().catch(() => undefined); await rm(fixture.root, { recursive: true, force: true }); }
});

test("one malformed refund effect invalidates its whole completed document, including a separately valid fee", async () => {
  const accounts = { teacher: account("account-c", "PERSON", "person-c", "person:teacher") };
  const good = snapshot({ feeId: "fee-good", version: "1", month: "2026-09-01", lines: { teachingTeacher: "100" }, accounts: { teachingTeacher: accounts.teacher } });
  const bad = snapshot({ feeId: "fee-bad", version: "1", month: "2026-09-01", lines: { teachingTeacher: "50" }, accounts: { teachingTeacher: accounts.teacher } });
  const fixture = await completeSpool({
    settlement_account: [{ id: "account-c", owner_type: "PERSON", owner_id: "person-c", account_code: "person:teacher", status: "ACTIVE" }],
    weekly_fee_entry: [
      { id: "fee-good", version: "1", settlement_month: "2026-09-01", gross_amount_cents: "100" },
      { id: "fee-bad", version: "1", settlement_month: "2026-09-01", gross_amount_cents: "50" },
    ],
    weekly_fee_entry_version: [
      { id: "fee-good-v1", weekly_fee_entry_id: "fee-good", version: "1", settlement_month: "2026-09-01", gross_amount_cents: "100" },
      { id: "fee-bad-v1", weekly_fee_entry_id: "fee-bad", version: "1", settlement_month: "2026-09-01", gross_amount_cents: "50" },
    ],
    weekly_fee_allocation_snapshot: [
      { id: "snapshot-good", sequence_no: "1", run_id: "run-good", weekly_fee_entry_id: "fee-good", source_weekly_fee_version: "1", policy_version_id: "policy", net_monthly_cents: "0", ...good },
      { id: "snapshot-bad", sequence_no: "1", run_id: "run-bad", weekly_fee_entry_id: "fee-bad", source_weekly_fee_version: "1", policy_version_id: "policy", net_monthly_cents: "0", ...bad },
    ],
    finance_document: [{ id: "poisoned-refund", kind: "REFUND", status: "REFUNDED", version: "3" }],
    finance_refund_decision: [{ finance_document_id: "poisoned-refund", decision: "APPROVED", posting_status: "POSTED", ledger_event_id: "poisoned-event", approved_gross_amount_cents: "150" }],
    finance_refund_submission_item: [
      { finance_document_id: "poisoned-refund", weekly_fee_entry_id: "fee-good", submitted_fee_version: "1", submitted_gross_amount_cents: "100", settlement_month: "2026-09-01" },
      { finance_document_id: "poisoned-refund", weekly_fee_entry_id: "fee-bad", submitted_fee_version: "1", submitted_gross_amount_cents: "50", settlement_month: "2026-09-01" },
    ],
    weekly_fee_refund_effect: [
      { weekly_fee_entry_id: "fee-good", finance_document_id: "poisoned-refund", allocation_snapshot_id: "snapshot-good", source_weekly_fee_version: "1", gross_amount_cents: "100", snapshot_json: good.snapshot_json },
      { weekly_fee_entry_id: "fee-bad", finance_document_id: "poisoned-refund", allocation_snapshot_id: "snapshot-bad", source_weekly_fee_version: "1", gross_amount_cents: "50", snapshot_json: "{not-json" },
    ],
    ledger_event: [{ id: "poisoned-event", event_type: "WEEKLY_FEE_REFUND" }],
    ledger_entry: [{ id: "poisoned-ledger", event_id: "poisoned-event", account_id: "account-c", category_key: "teachingTeacher", amount_cents: "-150" }],
  });
  let index; let view;
  try {
    index = await FullBackupDerivedSpoolIndex.create({ spoolDirectory: fixture.directory, spool: fixture.spool, attemptRoot: join(fixture.root, "index") });
    view = await FullBackupIncomeDerivedView.create({ index, attemptRoot: join(fixture.root, "view") });
    assert.equal(view.metadata().status, "PARTIAL");
    assert.deepEqual(await collect(view.streamMonthlyRows()), []);
    const anomalies = await collect(view.streamAnomalies());
    assert.equal(anomalies.some((item) => item.code === "SOURCE_ROW_INVALID" && item.sourceTable === "weekly_fee_refund_effect" && item.feeEntryId === "fee-bad"), true);
    assert.equal(anomalies.some((item) => item.code === "EXPORT_INCOME_DERIVED_REFUND_DOCUMENT_INVALID" && item.feeEntryId === "fee-good"), true);
  } finally { await view?.close().catch(() => undefined); await index?.close().catch(() => undefined); await rm(fixture.root, { recursive: true, force: true }); }
});

test("a completed refund requires an exact item-effect fee set and rejects an effect whose fee is absent from the snapshot", async () => {
  const accounts = { teacher: account("account-c", "PERSON", "person-c", "person:teacher") };
  const good = snapshot({ feeId: "fee-good", version: "1", month: "2026-09-01", lines: { teachingTeacher: "100" }, accounts: { teachingTeacher: accounts.teacher } });
  const missing = snapshot({ feeId: "fee-missing", version: "1", month: "2026-09-01", lines: { teachingTeacher: "50" }, accounts: { teachingTeacher: accounts.teacher } });
  const fixture = await completeSpool({
    settlement_account: [{ id: "account-c", owner_type: "PERSON", owner_id: "person-c", account_code: "person:teacher", status: "ACTIVE" }],
    weekly_fee_entry: [{ id: "fee-good", version: "1", settlement_month: "2026-09-01", gross_amount_cents: "100" }],
    weekly_fee_entry_version: [{ id: "fee-good-v1", weekly_fee_entry_id: "fee-good", version: "1", settlement_month: "2026-09-01", gross_amount_cents: "100" }],
    weekly_fee_allocation_snapshot: [{ id: "snapshot-good", sequence_no: "1", run_id: "run-good", weekly_fee_entry_id: "fee-good", source_weekly_fee_version: "1", policy_version_id: "policy", net_monthly_cents: "0", ...good }],
    finance_document: [{ id: "set-mismatch-refund", kind: "REFUND", status: "REFUNDED", version: "3" }],
    finance_refund_decision: [{ finance_document_id: "set-mismatch-refund", decision: "APPROVED", posting_status: "POSTED", ledger_event_id: "set-mismatch-event", approved_gross_amount_cents: "150" }],
    finance_refund_submission_item: [{ finance_document_id: "set-mismatch-refund", weekly_fee_entry_id: "fee-good", submitted_fee_version: "1", submitted_gross_amount_cents: "100", settlement_month: "2026-09-01" }],
    weekly_fee_refund_effect: [{ weekly_fee_entry_id: "fee-missing", finance_document_id: "set-mismatch-refund", allocation_snapshot_id: "missing-snapshot", source_weekly_fee_version: "1", gross_amount_cents: "50", snapshot_json: missing.snapshot_json }],
    ledger_event: [{ id: "set-mismatch-event", event_type: "WEEKLY_FEE_REFUND" }],
    ledger_entry: [{ id: "set-mismatch-ledger", event_id: "set-mismatch-event", account_id: "account-c", category_key: "teachingTeacher", amount_cents: "-150" }],
  });
  let index; let view;
  try {
    index = await FullBackupDerivedSpoolIndex.create({ spoolDirectory: fixture.directory, spool: fixture.spool, attemptRoot: join(fixture.root, "index") });
    view = await FullBackupIncomeDerivedView.create({ index, attemptRoot: join(fixture.root, "view") });
    assert.equal(view.metadata().status, "PARTIAL");
    assert.deepEqual(await collect(view.streamMonthlyRows()), []);
    const anomalies = await collect(view.streamAnomalies());
    assert.equal(anomalies.some((item) => item.code === "REFUND_DOCUMENT_ITEM_EFFECT_SET_MISMATCH" && item.feeEntryId === "fee-good"), true);
    assert.equal(anomalies.some((item) => item.code === "REFUND_DOCUMENT_FEE_UNKNOWN" && item.feeEntryId === "fee-missing"), true);
  } finally { await view?.close().catch(() => undefined); await index?.close().catch(() => undefined); await rm(fixture.root, { recursive: true, force: true }); }
});
