import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
  readFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FullBackupAttachmentExporter } from "../dist/full-backup-attachment-exporter.js";
import { FullBackupBusinessFactsWorkbookExporter } from "../dist/full-backup-business-facts-workbook-exporter.js";
import { FullBackupLocalPackageAssembler } from "../dist/full-backup-local-package-assembler.js";
import {
  FULL_BACKUP_KNOWN_COVERAGE_GAPS,
  createFullBackupLayout,
} from "../dist/full-backup-layout.js";
import { FullBackupWorkbookExporter } from "../dist/full-backup-workbook-exporter.js";
import { fullBackupOutputColumns } from "../dist/full-backup-transformer.js";

const layout = createFullBackupLayout();
const sha = (value) => createHash("sha256").update(value).digest("hex");
const profiles = [
  ["teacher", "TEACHER"],
  ["student", "STUDENT"],
  ["finance", "FINANCE"],
  ["payroll", "PAYROLL"],
  ["deduction", "DEDUCTION"],
  ["performanceConfiguration", "PERFORMANCE_CONFIGURATION"],
];

async function createSpool(root) {
  const spoolId = `business-package-${randomUUID()}`;
  const directory = join(root, spoolId);
  await mkdir(join(directory, "datasets"), { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await chmod(join(directory, "datasets"), 0o700);
  const datasets = [];
  for (const [index, item] of layout.entries()) {
    const excluded = item.policy === "AUTH_SECRET_TABLE_EXCLUDED";
    if (excluded) {
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
    const content = `${JSON.stringify({ columns })}\n`;
    const spoolFile = `datasets/${String(index + 1).padStart(3, "0")}_${item.tableName}.ndjson`;
    await writeFile(join(directory, spoolFile), content, { mode: 0o600 });
    datasets.push({
      tableName: item.tableName,
      columns,
      rowCount: "0",
      logicalDigest: sha(content),
      spoolFile,
      excluded: false,
    });
  }
  await writeFile(join(directory, "anomalies.ndjson"), "", { mode: 0o600 });
  return {
    directory,
    spool: {
      mode: "RAW_SOURCE_SPOOL",
      spoolId,
      snapshotId: `snapshot-${randomUUID()}`,
      asOf: "2026-09-23T00:00:00.000Z",
      datasets,
      anomalyFile: "anomalies.ndjson",
      anomalyCount: "0",
      coverageGaps: [...FULL_BACKUP_KNOWN_COVERAGE_GAPS],
    },
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "alliance-business-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { directory: spoolDirectory, spool } = await createSpool(
    join(root, "spools"),
  );
  const workbooks = await new FullBackupWorkbookExporter({
    spoolDirectory,
    spool,
    outputRoot: join(root, "raw-workbooks"),
  }).export();
  const attachments = await new FullBackupAttachmentExporter({
    spoolDirectory,
    spool,
    outputRoot: join(root, "attachments"),
    readVerified: async () => {
      throw new Error("no READY attachment in fixture");
    },
  }).export();
  const bundle = {};
  for (const [key, profile] of profiles) {
    const outputRoot = join(root, `fact-${key}`);
    const result = await new FullBackupBusinessFactsWorkbookExporter({
      spoolDirectory,
      spool,
      outputRoot,
      profile,
    }).export();
    bundle[key] = { directory: join(outputRoot, result.outputId), result };
  }
  const outputRoot = join(root, "packages");
  const options = {
    spoolDirectory,
    spool,
    workbookDirectory: join(root, "raw-workbooks", workbooks.outputId),
    workbooks,
    attachmentDirectory: join(root, "attachments", attachments.outputId),
    attachments,
    outputRoot,
  };
  return {
    root,
    outputRoot,
    bundle,
    options,
    assemble: (businessFacts) =>
      new FullBackupLocalPackageAssembler({
        ...options,
        ...(businessFacts === undefined ? {} : { businessFacts }),
      }).assemble(),
  };
}

async function previous(outputRoot) {
  await mkdir(join(outputRoot, "previous-success"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(join(outputRoot, "previous-success", "keep.txt"), "keep", {
    mode: 0o600,
  });
}
const assertOnlyPrevious = async (outputRoot) =>
  assert.deepEqual((await readdir(outputRoot)).sort(), ["previous-success"]);

async function replaceSpoolDataset(spoolDirectory, spool, tableName, records) {
  const dataset = spool.datasets.find((item) => item.tableName === tableName);
  assert.ok(dataset && !dataset.excluded && dataset.spoolFile !== null);
  const content = `${[
    JSON.stringify({ columns: dataset.columns }),
    ...records.map((record) =>
      JSON.stringify(
        dataset.columns.map((column) =>
          Object.hasOwn(record, column) ? record[column] : null,
        ),
      ),
    ),
  ].join("\n")}\n`;
  await writeFile(join(spoolDirectory, dataset.spoolFile), content, {
    mode: 0o600,
  });
  return {
    ...spool,
    datasets: spool.datasets.map((item) =>
      item.tableName === tableName
        ? {
            ...item,
            rowCount: String(records.length),
            logicalDigest: sha(content),
          }
        : item,
    ),
  };
}

async function createDerivedFixture(t) {
  const f = await fixture(t);
  const { FullBackupDerivedSpoolIndex } =
    await import("../dist/full-backup-derived-spool-index.js");
  const { FullBackupIncomeDerivedView } =
    await import("../dist/full-backup-income-derived-view.js");
  const { FullBackupLedgerDerivedView } =
    await import("../dist/full-backup-ledger-derived-view.js");
  const { FullBackupLedgerBusinessPeriodSource } =
    await import("../dist/full-backup-ledger-business-period-source.js");
  const { FullBackupIncomeWorkbook } =
    await import("../dist/full-backup-income-workbook.js");
  const { FullBackupLedgerWorkbook } =
    await import("../dist/full-backup-ledger-workbook.js");
  const index = await FullBackupDerivedSpoolIndex.create({
    spoolDirectory: f.options.spoolDirectory,
    spool: f.options.spool,
    attemptRoot: join(f.root, "index"),
  });
  const income = await FullBackupIncomeDerivedView.create({
    index,
    attemptRoot: join(f.root, "income-view"),
  });
  const ledger = await FullBackupLedgerDerivedView.create({
    index,
    attemptRoot: join(f.root, "ledger-view"),
  });
  const periods = await FullBackupLedgerBusinessPeriodSource.create({
    index,
    attemptRoot: join(f.root, "period-view"),
  });
  const incomeResult = await new FullBackupIncomeWorkbook({
    index,
    view: income,
    outputRoot: join(f.root, "income-book"),
  }).export();
  const ledgerResult = await new FullBackupLedgerWorkbook({
    index,
    ledger,
    periods,
    outputRoot: join(f.root, "ledger-book"),
  }).export();
  const derived = {
    income: {
      directory: join(f.root, "income-book", incomeResult.outputId),
      result: incomeResult,
    },
    ledger: {
      directory: join(f.root, "ledger-book", ledgerResult.outputId),
      result: ledgerResult,
    },
  };
  return {
    f,
    index,
    income,
    ledger,
    periods,
    derived,
    views: { income, ledger, periods },
    incomeResult,
    ledgerResult,
  };
}

test("derived pair rejects forged or unsafe inputs and preserves an old package", async (t) => {
  const d = await createDerivedFixture(t);
  const close = async () => {
    await d.periods.close().catch(() => undefined);
    await d.ledger.close().catch(() => undefined);
    await d.income.close().catch(() => undefined);
    await d.index.close().catch(() => undefined);
  };
  const reject = async (label, overrides, expected) => {
    const outputRoot = join(d.f.root, `reject-${label}`);
    await previous(outputRoot);
    await assert.rejects(
      () =>
        new FullBackupLocalPackageAssembler({
          ...d.f.options,
          outputRoot,
          businessFacts: d.f.bundle,
          businessDerived: d.derived,
          derivedVerificationViews: d.views,
          ...overrides,
        }).assemble(),
      expected,
    );
    await assertOnlyPrevious(outputRoot);
  };
  try {
    await t.test(
      "copies exactly two derived workbooks with rebuilt safe metadata",
      async () => {
        const packaged = await new FullBackupLocalPackageAssembler({
          ...d.f.options,
          businessFacts: d.f.bundle,
          businessDerived: d.derived,
          derivedVerificationViews: d.views,
        }).assemble();
        assert.equal(packaged.complete, false);
        assert.deepEqual(
          packaged.businessDerived.map((item) => item.tableNumber),
          [3, 7],
        );
        const packageDir = join(d.f.outputRoot, packaged.outputId);
        const indexBytes = await readFile(join(packageDir, packaged.indexFile));
        const packageIndex = JSON.parse(indexBytes);
        assert.equal(packageIndex.complete, false);
        assert.equal(indexBytes.includes(Buffer.from(d.f.root)), false);
        assert.deepEqual(
          packageIndex.businessDerived.map((item) => item.tableNumber),
          [3, 7],
        );
        for (const item of packaged.businessDerived) {
          assert.equal(item.file.path.startsWith("business-derived/"), true);
          assert.match(item.file.sha256, /^[a-f0-9]{64}$/);
          const bytes = await readFile(join(packageDir, item.file.path));
          assert.equal(String(bytes.length), item.file.sizeBytes);
          assert.equal(sha(bytes), item.file.sha256);
          assert.equal(item.complete, false);
          assert.equal(item.publishedVersion, null);
          assert.equal(
            item.sourceRows.every(
              (source) =>
                Object.keys(source).sort().join(",") ===
                "columns,logicalDigest,rowCount,tableName",
            ),
            true,
          );
        }
      },
    );

    await t.test(
      "requires both derived keys and exactly six stored facts",
      async () => {
        await reject(
          "missing-derived-key",
          { businessDerived: { income: d.derived.income } },
          /EXPORT_PACKAGE_DERIVED_INVALID/,
        );
        await reject(
          "extra-derived-key",
          {
            businessDerived: {
              ...d.derived,
              unexpected: d.derived.income,
            },
          },
          /EXPORT_PACKAGE_DERIVED_INVALID/,
        );
        await reject(
          "without-six-facts",
          { businessFacts: undefined },
          /EXPORT_PACKAGE_DERIVED_INVALID/,
        );
      },
    );

    await t.test(
      "rejects snapshot, row-count, and source-metadata receipt changes",
      async () => {
        await reject(
          "cross-snapshot",
          {
            businessDerived: {
              ...d.derived,
              income: {
                ...d.derived.income,
                result: { ...d.incomeResult, snapshotId: "other-snapshot" },
              },
            },
          },
          /EXPORT_PACKAGE_DERIVED_INVALID/,
        );
        await reject(
          "changed-count",
          {
            businessDerived: {
              ...d.derived,
              income: {
                ...d.derived.income,
                result: { ...d.incomeResult, monthlyRowCount: "999" },
              },
            },
          },
          /EXPORT_PACKAGE_DERIVED_INVALID/,
        );
        await reject(
          "changed-metadata",
          {
            businessDerived: {
              ...d.derived,
              income: {
                ...d.derived.income,
                result: {
                  ...d.incomeResult,
                  sourceBasis: {
                    ...d.incomeResult.sourceBasis,
                    contributionDigest: "0".repeat(64),
                  },
                },
              },
            },
          },
          /EXPORT_PACKAGE_DERIVED_INVALID/,
        );
      },
    );

    await t.test(
      "marks a zero-ledger nonzero-projection account PARTIAL without changing exact raw amounts",
      async (t) => {
        const f = await fixture(t);
        const accountId = randomUUID();
        const ownerId = randomUUID();
        let spool = await replaceSpoolDataset(
          f.options.spoolDirectory,
          f.options.spool,
          "settlement_account",
          [
            {
              id: accountId,
              owner_type: "PERSON",
              owner_id: ownerId,
              account_code: "projection-only-account",
              status: "ACTIVE",
              created_at: "2026-09-23T00:00:00.000Z",
            },
          ],
        );
        spool = await replaceSpoolDataset(
          f.options.spoolDirectory,
          spool,
          "account_balance_projection",
          [
            {
              account_id: accountId,
              balance_cents: "60",
              updated_at: "2026-09-23T00:00:00.000Z",
            },
          ],
        );
        let index;
        let income;
        let ledger;
        let periods;
        try {
          const raw = await new FullBackupWorkbookExporter({
            spoolDirectory: f.options.spoolDirectory,
            spool,
            outputRoot: join(f.root, "mismatch-raw"),
          }).export();
          const attachments = await new FullBackupAttachmentExporter({
            spoolDirectory: f.options.spoolDirectory,
            spool,
            outputRoot: join(f.root, "mismatch-attachments"),
            readVerified: async () => {
              throw new Error("no READY attachment in fixture");
            },
          }).export();
          const facts = {};
          for (const [key, profile] of profiles) {
            const outputRoot = join(f.root, `mismatch-fact-${key}`);
            const result = await new FullBackupBusinessFactsWorkbookExporter({
              spoolDirectory: f.options.spoolDirectory,
              spool,
              outputRoot,
              profile,
            }).export();
            facts[key] = {
              directory: join(outputRoot, result.outputId),
              result,
            };
          }
          index = await (
            await import("../dist/full-backup-derived-spool-index.js")
          ).FullBackupDerivedSpoolIndex.create({
            spoolDirectory: f.options.spoolDirectory,
            spool,
            attemptRoot: join(f.root, "mismatch-index"),
          });
          income = await (
            await import("../dist/full-backup-income-derived-view.js")
          ).FullBackupIncomeDerivedView.create({
            index,
            attemptRoot: join(f.root, "mismatch-income"),
          });
          ledger = await (
            await import("../dist/full-backup-ledger-derived-view.js")
          ).FullBackupLedgerDerivedView.create({
            index,
            attemptRoot: join(f.root, "mismatch-ledger"),
          });
          periods = await (
            await import("../dist/full-backup-ledger-business-period-source.js")
          ).FullBackupLedgerBusinessPeriodSource.create({
            index,
            attemptRoot: join(f.root, "mismatch-periods"),
          });
          const incomeResult = await new (
            await import("../dist/full-backup-income-workbook.js")
          ).FullBackupIncomeWorkbook({
            index,
            view: income,
            outputRoot: join(f.root, "mismatch-income-book"),
          }).export();
          const ledgerResult = await new (
            await import("../dist/full-backup-ledger-workbook.js")
          ).FullBackupLedgerWorkbook({
            index,
            ledger,
            periods,
            outputRoot: join(f.root, "mismatch-ledger-book"),
          }).export();
          const reconciliations = [];
          for await (const row of ledger.streamReconciliations())
            reconciliations.push(row);
          assert.deepEqual(reconciliations, [
            {
              accountId,
              accountSourceRecordKey: JSON.stringify([["id", accountId]]),
              accountOwnerType: "PERSON",
              accountOwnerId: ownerId,
              accountCode: "projection-only-account",
              ledgerNetCents: "0",
              projectionBalanceCents: "60",
              status: "MISMATCH",
            },
          ]);
          const packaged = await new FullBackupLocalPackageAssembler({
            spoolDirectory: f.options.spoolDirectory,
            spool,
            workbookDirectory: join(f.root, "mismatch-raw", raw.outputId),
            workbooks: raw,
            attachmentDirectory: join(
              f.root,
              "mismatch-attachments",
              attachments.outputId,
            ),
            attachments,
            outputRoot: join(f.root, "mismatch-packages"),
            businessFacts: facts,
            businessDerived: {
              income: {
                directory: join(
                  f.root,
                  "mismatch-income-book",
                  incomeResult.outputId,
                ),
                result: incomeResult,
              },
              ledger: {
                directory: join(
                  f.root,
                  "mismatch-ledger-book",
                  ledgerResult.outputId,
                ),
                result: ledgerResult,
              },
            },
            derivedVerificationViews: { income, ledger, periods },
          }).assemble();
          const derivedLedger = packaged.businessDerived.find(
            (item) => item.tableNumber === 7,
          );
          assert.equal(derivedLedger.status, "PARTIAL");
          assert.equal(derivedLedger.reconciliationStatusCounts.MISMATCH, "1");
          assert.equal(derivedLedger.rowCounts.entryRowCount, "0");
          assert.equal(derivedLedger.rowCounts.reconciliationRowCount, "1");
        } finally {
          await periods?.close().catch(() => undefined);
          await ledger?.close().catch(() => undefined);
          await income?.close().catch(() => undefined);
          await index?.close().catch(() => undefined);
        }
      },
    );

    await t.test(
      "rejects tampered content, extra file, and symbolic link",
      async () => {
        const incomeFile = join(
          d.derived.income.directory,
          d.incomeResult.file,
        );
        const original = await readFile(incomeFile);
        try {
          const altered = Buffer.from(original);
          altered[altered.length - 1] ^= 1;
          await writeFile(incomeFile, altered, { mode: 0o600 });
          await reject(
            "changed-file",
            {},
            /BACKUP_FILE_INVALID|EXPORT_PACKAGE_DERIVED_COPY_MISMATCH/,
          );
        } finally {
          await writeFile(incomeFile, original, { mode: 0o600 });
        }

        const unexpected = join(d.derived.ledger.directory, "unexpected.xlsx");
        try {
          await writeFile(unexpected, "extra", { mode: 0o600 });
          await reject("extra-file", {}, /EXPORT_PACKAGE_EXTRA_FILE/);
        } finally {
          await rm(unexpected, { force: true });
        }

        const linked = join(d.derived.ledger.directory, "linked.xlsx");
        try {
          await symlink(d.ledgerResult.file, linked);
          await reject("symbolic-link", {}, /EXPORT_PACKAGE_EXTRA_FILE/);
        } finally {
          await rm(linked, { force: true });
        }
      },
    );
  } finally {
    await close();
  }
});
