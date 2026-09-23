import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { assertPrivateBackupDirectory } from "./backup-file-io.js";
import {
  FullBackupAttachmentExporter,
  type BackupAttachmentObject,
} from "./full-backup-attachment-exporter.js";
import { FullBackupDeductionWorkbookExporter } from "./full-backup-deduction-workbook-exporter.js";
import { FullBackupDerivedSpoolIndex } from "./full-backup-derived-spool-index.js";
import { FullBackupFinanceWorkbookExporter } from "./full-backup-finance-workbook-exporter.js";
import { FullBackupIncomeDerivedView } from "./full-backup-income-derived-view.js";
import { FullBackupIncomeWorkbook } from "./full-backup-income-workbook.js";
import { FullBackupLedgerBusinessPeriodSource } from "./full-backup-ledger-business-period-source.js";
import { FullBackupLedgerDerivedView } from "./full-backup-ledger-derived-view.js";
import { FullBackupLedgerWorkbook } from "./full-backup-ledger-workbook.js";
import {
  FullBackupLocalPackageAssembler,
  type FullBackupLocalPackage,
} from "./full-backup-local-package-assembler.js";
import { FullBackupManifestEvidence } from "./full-backup-manifest-evidence.js";
import { createFullBackupManifestContext } from "./full-backup-manifest.js";
import { FullBackupPayrollWorkbookExporter } from "./full-backup-payroll-workbook-exporter.js";
import { FullBackupPerformanceConfigurationWorkbookExporter } from "./full-backup-performance-configuration-workbook-exporter.js";
import { FullBackupSpool } from "./full-backup-spool.js";
import { FullBackupStudentWorkbookExporter } from "./full-backup-student-workbook-exporter.js";
import { FullBackupTeacherWorkbookExporter } from "./full-backup-teacher-workbook-exporter.js";
import type { FullBackupTransformer } from "./full-backup-transformer.js";
import { FullBackupWorkbookExporter } from "./full-backup-workbook-exporter.js";
import { PostgresFullBackupSource } from "./postgres-full-backup-source.js";
import type { PostgresExportPool } from "./postgres-export-preflight.js";

export type VerifiedAttachmentReader = (
  expected: BackupAttachmentObject,
) => Promise<Uint8Array>;

export type FullBackupLocalRunnerOptions = Readonly<{
  /** Caller retains pool ownership; the source closes only its own snapshot client. */
  pool: PostgresExportPool;
  /** The caller supplies approved fingerprint/decryption capabilities. */
  transformer: FullBackupTransformer;
  /** Exact immutable attachment bytes; arbitrary storage paths are never accepted. */
  readVerifiedAttachment: VerifiedAttachmentReader;
  /** Private parent for one disposable local run workspace. */
  attemptRoot: string;
  /** Private parent that retains atomically published package directories. */
  packageRoot: string;
  applicationVersion: string;
  generatorVersion: string;
  /** Test seam. Production obtains one timestamp internally for the whole file group. */
  now?: () => Date;
  /** Test seam. Production assigns a new opaque file group identifier. */
  newFileGroupId?: () => string;
}>;

export type FullBackupLocalRunResult = Readonly<{
  mode: "LOCAL_FULL_BACKUP_RUN";
  /** A local package is never a claim that F14 is fully implemented. */
  complete: false;
  backupStatus: "INCOMPLETE_IMPLEMENTATION";
  publication: "LOCAL_PACKAGE_PUBLISHED";
  fileGroupId: string;
  spoolId: string;
  snapshotId: string;
  asOf: string;
  localPackage: FullBackupLocalPackage;
}>;

/** A package survived an after-publication cleanup failure and can be recovered by outputId. */
export class FullBackupLocalRunnerPublishedCleanupError extends AggregateError {
  public readonly localPackage: FullBackupLocalPackage;

  public constructor(
    localPackage: FullBackupLocalPackage,
    errors: readonly unknown[],
  ) {
    super(errors, "EXPORT_LOCAL_RUNNER_PUBLISHED_CLEANUP_FAILED");
    this.name = "FullBackupLocalRunnerPublishedCleanupError";
    this.localPackage = localPackage;
  }
}

const fail = (code: string): never => {
  throw new Error(code);
};

const contains = (parent: string, child: string): boolean => {
  const value = relative(parent, child);
  const upward = `..${process.platform === "win32" ? "\\" : "/"}`;
  return value === "" ||
    (!value.startsWith(upward) && value !== ".." && !isAbsolute(value));
};

const privateRoot = async (path: string): Promise<string> => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  return assertPrivateBackupDirectory(path);
};

const privateChild = async (parent: string, name: string): Promise<string> => {
  const path = join(parent, name);
  await mkdir(path, { mode: 0o700 });
  return assertPrivateBackupDirectory(path);
};

const cleanup = async (
  action: () => Promise<void>,
  errors: unknown[],
): Promise<void> => {
  try {
    await action();
  } catch (error) {
    errors.push(error);
  }
};

/**
 * One local composition of the existing F14 components. It has no task model,
 * download endpoint, scheduler, or authority to mark a backup complete.
 */
export class FullBackupLocalRunner {
  public constructor(private readonly options: FullBackupLocalRunnerOptions) {}

  public async run(): Promise<FullBackupLocalRunResult> {
    const attemptRoot = await privateRoot(this.options.attemptRoot);
    const packageRoot = await privateRoot(this.options.packageRoot);
    if (contains(attemptRoot, packageRoot) || contains(packageRoot, attemptRoot))
      fail("EXPORT_LOCAL_RUNNER_ROOTS_OVERLAP");

    const workspace = await mkdtemp(join(attemptRoot, "full-backup-run-"));
    let index: FullBackupDerivedSpoolIndex | undefined;
    let income: FullBackupIncomeDerivedView | undefined;
    let ledger: FullBackupLedgerDerivedView | undefined;
    let periods: FullBackupLedgerBusinessPeriodSource | undefined;
    let published: FullBackupLocalPackage | undefined;
    let primary: unknown;
    try {
      await assertPrivateBackupDirectory(workspace);
      const spoolRoot = await privateChild(workspace, "spool");
      const indexRoot = await privateChild(workspace, "index");
      const incomeRoot = await privateChild(workspace, "income");
      const ledgerRoot = await privateChild(workspace, "ledger");
      const periodsRoot = await privateChild(workspace, "periods");
      const rawRoot = await privateChild(workspace, "raw");
      const attachmentRoot = await privateChild(workspace, "attachments");
      const teacherRoot = await privateChild(workspace, "teacher");
      const studentRoot = await privateChild(workspace, "student");
      const financeRoot = await privateChild(workspace, "finance");
      const payrollRoot = await privateChild(workspace, "payroll");
      const deductionRoot = await privateChild(workspace, "deduction");
      const performanceRoot = await privateChild(workspace, "performance");
      const incomeWorkbookRoot = await privateChild(workspace, "income-workbook");
      const ledgerWorkbookRoot = await privateChild(workspace, "ledger-workbook");

      const spool = await new FullBackupSpool({
        source: new PostgresFullBackupSource(this.options.pool),
        transformer: this.options.transformer,
        tempRoot: spoolRoot,
      }).create();
      const spoolDirectory = join(spoolRoot, spool.spoolId);
      index = await FullBackupDerivedSpoolIndex.create({
        spoolDirectory,
        spool,
        attemptRoot: indexRoot,
      });
      income = await FullBackupIncomeDerivedView.create({
        index,
        attemptRoot: incomeRoot,
      });
      ledger = await FullBackupLedgerDerivedView.create({
        index,
        attemptRoot: ledgerRoot,
      });
      periods = await FullBackupLedgerBusinessPeriodSource.create({
        index,
        attemptRoot: periodsRoot,
      });

      const evidence = await FullBackupManifestEvidence.collect({
        spoolDirectory,
        spool,
        index,
        ledger,
        periods,
      });
      const generatedAt = (this.options.now ?? (() => new Date()))().toISOString();
      const fileGroupId = (this.options.newFileGroupId ?? randomUUID)();
      const manifestContext = createFullBackupManifestContext({
        evidence,
        fileGroupId,
        generatedAt,
        applicationVersion: this.options.applicationVersion,
        generatorVersion: this.options.generatorVersion,
      });

      const raw = await new FullBackupWorkbookExporter({
        spoolDirectory,
        spool,
        outputRoot: rawRoot,
        manifestContext,
      }).export();
      const teacher = await new FullBackupTeacherWorkbookExporter({
        spoolDirectory,
        spool,
        outputRoot: teacherRoot,
        manifestContext,
      }).export();
      const student = await new FullBackupStudentWorkbookExporter({
        spoolDirectory,
        spool,
        outputRoot: studentRoot,
        manifestContext,
      }).export();
      const finance = await new FullBackupFinanceWorkbookExporter({
        spoolDirectory,
        spool,
        outputRoot: financeRoot,
        manifestContext,
      }).export();
      const payroll = await new FullBackupPayrollWorkbookExporter({
        spoolDirectory,
        spool,
        outputRoot: payrollRoot,
        manifestContext,
      }).export();
      const deduction = await new FullBackupDeductionWorkbookExporter({
        spoolDirectory,
        spool,
        outputRoot: deductionRoot,
        manifestContext,
      }).export();
      const performanceConfiguration = await new FullBackupPerformanceConfigurationWorkbookExporter({
        spoolDirectory,
        spool,
        outputRoot: performanceRoot,
        manifestContext,
      }).export();
      const incomeResult = await new FullBackupIncomeWorkbook({
        index,
        view: income,
        outputRoot: incomeWorkbookRoot,
        manifestContext,
      }).export();
      const ledgerResult = await new FullBackupLedgerWorkbook({
        index,
        ledger,
        periods,
        outputRoot: ledgerWorkbookRoot,
        manifestContext,
      }).export();
      const attachments = await new FullBackupAttachmentExporter({
        spoolDirectory,
        spool,
        outputRoot: attachmentRoot,
        readVerified: this.options.readVerifiedAttachment,
      }).export();

      published = await new FullBackupLocalPackageAssembler({
        spoolDirectory,
        spool,
        workbookDirectory: join(rawRoot, raw.outputId),
        workbooks: raw,
        attachmentDirectory: join(attachmentRoot, attachments.outputId),
        attachments,
        outputRoot: packageRoot,
        businessFacts: {
          teacher: {
            directory: join(teacherRoot, teacher.outputId),
            result: teacher,
          },
          student: {
            directory: join(studentRoot, student.outputId),
            result: student,
          },
          finance: {
            directory: join(financeRoot, finance.outputId),
            result: finance,
          },
          payroll: {
            directory: join(payrollRoot, payroll.outputId),
            result: payroll,
          },
          deduction: {
            directory: join(deductionRoot, deduction.outputId),
            result: deduction,
          },
          performanceConfiguration: {
            directory: join(performanceRoot, performanceConfiguration.outputId),
            result: performanceConfiguration,
          },
        },
        businessDerived: {
          income: {
            directory: join(incomeWorkbookRoot, incomeResult.outputId),
            result: incomeResult,
          },
          ledger: {
            directory: join(ledgerWorkbookRoot, ledgerResult.outputId),
            result: ledgerResult,
          },
        },
        derivedVerificationViews: { income, ledger, periods },
        finalManifest: { context: manifestContext, index },
      }).assemble();
      return Object.freeze({
        mode: "LOCAL_FULL_BACKUP_RUN",
        complete: false,
        backupStatus: "INCOMPLETE_IMPLEMENTATION",
        publication: "LOCAL_PACKAGE_PUBLISHED",
        fileGroupId,
        spoolId: spool.spoolId,
        snapshotId: spool.snapshotId,
        asOf: spool.asOf,
        localPackage: published,
      });
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      await cleanup(async () => periods?.close(), cleanupErrors);
      await cleanup(async () => ledger?.close(), cleanupErrors);
      await cleanup(async () => income?.close(), cleanupErrors);
      await cleanup(async () => index?.close(), cleanupErrors);
      await cleanup(async () => rm(workspace, { recursive: true, force: true }), cleanupErrors);
      if (cleanupErrors.length > 0) {
        if (published !== undefined && primary === undefined)
          throw new FullBackupLocalRunnerPublishedCleanupError(published, cleanupErrors);
        if (primary !== undefined)
          throw new AggregateError(
            [primary, ...cleanupErrors],
            "EXPORT_LOCAL_RUNNER_FAILED_CLEANUP_FAILED",
            { cause: primary },
          );
        throw new AggregateError(cleanupErrors, "EXPORT_LOCAL_RUNNER_CLEANUP_FAILED");
      }
    }
  }
}
