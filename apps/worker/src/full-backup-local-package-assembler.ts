import { constants, type Dirent } from "node:fs";
import { createReadStream } from "node:fs";
import { mkdir, open, opendir, rename, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  assertPrivateBackupDirectory,
  copyVerifiedBackupFile,
  hashBackupFile,
  openPrivateBackupFile,
  syncBackupDirectory,
  writeBackupBytes,
} from "./backup-file-io.js";
import type { BackupAttachmentFiles } from "./full-backup-attachment-exporter.js";
import { BUSINESS_BACKUP_COVERAGE_GAPS } from "./full-backup-business-schema.js";
import { FullBackupBusinessFactsView } from "./full-backup-business-facts-view.js";
import type { FullBackupBusinessFactsWorkbookExportResult } from "./full-backup-business-facts-workbook-exporter.js";
import { FULL_BACKUP_KNOWN_COVERAGE_GAPS, FULL_BACKUP_LAYOUT_VERSION, createFullBackupLayout } from "./full-backup-layout.js";
import { readBackupSpoolDataset } from "./full-backup-spool-reader.js";
import type { FullBackupSpoolResult } from "./full-backup-spool.js";
import { fullBackupOutputColumns } from "./full-backup-transformer.js";
import type { FullBackupWorkbookExportResult } from "./full-backup-workbook-exporter.js";
import { FullBackupManifestEvidence } from "./full-backup-manifest-evidence.js";
import { createFullBackupManifestContext, type FullBackupManifestContext } from "./full-backup-manifest.js";
import type { FullBackupDerivedSpoolIndex } from "./full-backup-derived-spool-index.js";
import { verifyWorkbookManifest } from "./full-backup-workbook-manifest-reader.js";


import {
  verifyDerivedComponents,
  type FullBackupDerivedBundle,
  type FullBackupDerivedVerificationViews,
  type DerivedPackageMetadata,
} from "./full-backup-derived-package-validation.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const EXTENSIONS = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg" } as const;
const FIXED_WORKBOOKS = ["01", "02", "03", "04", "06", "07", "08", "09", "10", "11", "12", "13"] as const;
const INCOMPLETE_REASONS = [
  "BUSINESS_VIEWS_NOT_IMPLEMENTED",
  "00_MANIFEST_NOT_IMPLEMENTED",
  "FINAL_PACKAGE_MANIFEST_NOT_IMPLEMENTED",
] as const;
const BUSINESS_FACTS_INCOMPLETE_REASONS = [
  "BUSINESS_TABLES_3_AND_7_DERIVED_PENDING",
  "BUSINESS_FACTS_DECLARED_FIELDS_ONLY",
  "00_MANIFEST_NOT_IMPLEMENTED",
  "FINAL_PACKAGE_MANIFEST_NOT_IMPLEMENTED",
] as const;
const BUSINESS_DERIVED_INCOMPLETE_REASONS = [
  "BUSINESS_DERIVED_VIEWS_UNPUBLISHED",
  "BUSINESS_FACTS_DECLARED_FIELDS_ONLY",
  "00_MANIFEST_NOT_IMPLEMENTED",
  "FINAL_PACKAGE_MANIFEST_NOT_IMPLEMENTED",
] as const;
const FIXED_BUSINESS_FACTS = [
  { key: "teacher", tableNumber: 1, file: "business-table-1-teacher-facts.xlsx" },
  { key: "student", tableNumber: 2, file: "business-table-2-student-facts.xlsx" },
  { key: "finance", tableNumber: 4, file: "business-table-4-finance-facts.xlsx" },
  { key: "payroll", tableNumber: 5, file: "business-table-5-payroll-facts.xlsx" },
  { key: "deduction", tableNumber: 6, file: "business-table-6-deduction-facts.xlsx" },
  { key: "performanceConfiguration", tableNumber: 8, file: "business-table-8-performance-configuration-facts.xlsx" },
] as const;
const BUSINESS_FACT_TABLE_SCOPE_GAPS: Readonly<Record<BusinessFactTableNumber, string>> = Object.freeze({
  1: "BUSINESS_TABLES_2_TO_8_NOT_INCLUDED",
  2: "BUSINESS_TABLES_1_3_TO_8_NOT_INCLUDED",
  4: "BUSINESS_TABLES_1_TO_3_5_TO_8_NOT_INCLUDED",
  5: "BUSINESS_TABLES_1_TO_4_6_TO_8_NOT_INCLUDED",
  6: "BUSINESS_TABLES_1_TO_5_7_TO_8_NOT_INCLUDED",
  8: "BUSINESS_TABLES_1_TO_7_NOT_INCLUDED",
});
const DERIVED_SCOPE_GAP = "DERIVED_TABLES_3_AND_7_NOT_GENERATED";

type AttachmentMediaType = keyof typeof EXTENSIONS;
type JsonRecord = Record<string, unknown>;

export type RawSourcePackageFile = Readonly<{ path: string; sizeBytes: string; sha256: string }>;
type BusinessFactTableNumber = typeof FIXED_BUSINESS_FACTS[number]["tableNumber"];
export type FullBackupBusinessFactInput = Readonly<{
  directory: string;
  result: FullBackupBusinessFactsWorkbookExportResult;
}>;
export type FullBackupBusinessFactsBundle = Readonly<{
  teacher: FullBackupBusinessFactInput;
  student: FullBackupBusinessFactInput;
  finance: FullBackupBusinessFactInput;
  payroll: FullBackupBusinessFactInput;
  deduction: FullBackupBusinessFactInput;
  performanceConfiguration: FullBackupBusinessFactInput;
}>;
export type RawSourcePackageBusinessFact = Readonly<{
  tableNumber: BusinessFactTableNumber;
  file: RawSourcePackageFile;
  schemaVersion: string;
  gaps: readonly string[];
  sources: readonly Readonly<{
    sourceTable: string;
    columns: readonly string[];
    rowCount: string;
    logicalDigest: string;
  }>[];
}>;
export type RawSourcePackageDerived = DerivedPackageMetadata & Readonly<{ file: RawSourcePackageFile }>;
export type FullBackupLocalPackage = Readonly<{
  mode: "RAW_SOURCE_PACKAGE";
  complete: false;
  outputId: string;
  snapshotId: string;
  asOf: string;
  workbooks: readonly RawSourcePackageFile[];
  attachmentIndex: RawSourcePackageFile;
  anomalies: RawSourcePackageFile;
  indexFile: "raw-source-package-index.json";
  indexSha256: string;
  payloadFileCount: string;
  totalBytes: string;
  readyAttachmentCount: string;
  unreadyAttachmentCount: string;
  coverageGaps: readonly string[];
  incompleteReasons: readonly string[];
  /** Present only when all six fixed stored-fact business workbooks were verified and copied. */
  businessFacts?: readonly RawSourcePackageBusinessFact[];
  businessDerived?: readonly RawSourcePackageDerived[];
  /** External file manifest excludes itself from payload counts and hashes. */
  packageManifest?: RawSourcePackageFile;
}>;
export type FullBackupLocalPackageAssemblerOptions = Readonly<{
  spoolDirectory: string;
  spool: FullBackupSpoolResult;
  workbookDirectory: string;
  workbooks: FullBackupWorkbookExportResult;
  attachmentDirectory: string;
  attachments: BackupAttachmentFiles;
  outputRoot: string;
  /** All-or-nothing fixed stored-fact bundle. Omission preserves the legacy RAW-only package. */
  businessFacts?: FullBackupBusinessFactsBundle;
  /** Optional all-or-nothing derived pair, only alongside all six stored-fact workbooks. */
  businessDerived?: FullBackupDerivedBundle;
  /** Same-spool trusted readers remain caller-owned and open until assembly finishes. */
  derivedVerificationViews?: FullBackupDerivedVerificationViews;
  /** Opt-in final file inventory, still an incomplete implementation artifact. */
  finalManifest?: Readonly<{ context: FullBackupManifestContext; index: FullBackupDerivedSpoolIndex }>;
}>;

function fail(code: string): never { throw new Error(code); }
const same = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);
const own = (value: unknown): JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : fail("EXPORT_PACKAGE_INVALID_INDEX");

async function countDirectory(root: string, expected: (name: string, entry: Dirent) => boolean): Promise<number> {
  const directory = await opendir(root);
  let count = 0;
  try {
    for await (const entry of directory) {
      if (!expected(entry.name, entry)) fail("EXPORT_PACKAGE_EXTRA_FILE");
      count += 1;
    }
  } finally { await directory.close().catch(() => undefined); }
  return count;
}

async function* lines(root: string, relative: string): AsyncGenerator<string> {
  const handle = await openPrivateBackupFile(root, relative);
  const stream = handle.createReadStream({ autoClose: false, encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try { for await (const line of reader) yield line; }
  finally { reader.close(); stream.destroy(); await handle.close(); }
}

async function createPrivateDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: false, mode: 0o700 });
  return assertPrivateBackupDirectory(path);
}

async function openOutput(root: string, relative: string): Promise<FileHandle> {
  const parts = relative.split("/");
  if (!relative || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) fail("EXPORT_PACKAGE_INVALID_PATH");
  const path = join(root, ...parts);
  return open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
}

async function writeLine(file: FileHandle, value: string): Promise<void> {
  await writeBackupBytes(file, Buffer.from(`${value}\n`, "utf8"));
}

function assertSnapshots(options: FullBackupLocalPackageAssemblerOptions): void {
  const { spool, workbooks, attachments } = options;
  if (spool.mode !== "RAW_SOURCE_SPOOL" || workbooks.mode !== "RAW_SOURCE_WORKBOOKS" || attachments.mode !== "ATTACHMENT_FILES" ||
      workbooks.spoolId !== spool.spoolId || workbooks.snapshotId !== spool.snapshotId || attachments.snapshotId !== spool.snapshotId ||
      workbooks.asOf !== spool.asOf || attachments.asOf !== spool.asOf || !same(workbooks.coverageGaps, spool.coverageGaps) ||
      !same(spool.coverageGaps, FULL_BACKUP_KNOWN_COVERAGE_GAPS)) fail("EXPORT_PACKAGE_SNAPSHOT_MISMATCH");
  const layout = createFullBackupLayout();
  if (spool.datasets.length !== layout.length) fail("EXPORT_PACKAGE_SPOOL_LAYOUT_INVALID");
  for (const [index, item] of layout.entries()) {
    const dataset = spool.datasets[index];
    const expectedExcluded = item.policy === "AUTH_SECRET_TABLE_EXCLUDED";
    const expectedColumns = expectedExcluded ? [] : fullBackupOutputColumns(item.tableName);
    const expectedFile = expectedExcluded ? null : `datasets/${String(index + 1).padStart(3, "0")}_${item.tableName}.ndjson`;
    if (dataset === undefined || dataset.tableName !== item.tableName || dataset.excluded !== expectedExcluded || !same(dataset.columns, expectedColumns) || dataset.spoolFile !== expectedFile ||
        (expectedExcluded ? dataset.rowCount !== null || dataset.logicalDigest !== null : dataset.rowCount === null || !/^(0|[1-9]\d*)$/.test(dataset.rowCount) || dataset.logicalDigest === null || !SHA256.test(dataset.logicalDigest)))
      fail("EXPORT_PACKAGE_SPOOL_LAYOUT_INVALID");
  }
  const ids = workbooks.workbooks.map((item) => item.workbookId);
  const expectedCounts = new Map<string, number>();
  for (const item of createFullBackupLayout()) if (item.policy === "RAW_SOURCE") expectedCounts.set(item.workbookId, (expectedCounts.get(item.workbookId) ?? 0) + 1);
  if (!same(ids, FIXED_WORKBOOKS) || new Set(workbooks.workbooks.map((item) => item.file)).size !== FIXED_WORKBOOKS.length ||
      workbooks.workbooks.some((item) => item.file !== `workbook-${item.workbookId}.xlsx` || item.datasetCount !== String(expectedCounts.get(item.workbookId)) ||
        typeof item.sizeBytes !== "string" || !/^[1-9]\d*$/.test(item.sizeBytes) || typeof item.sha256 !== "string" || !SHA256.test(item.sha256))) fail("EXPORT_PACKAGE_WORKBOOKS_INVALID");
}

type VerifiedBusinessFactComponent = Readonly<{
  key: typeof FIXED_BUSINESS_FACTS[number]["key"];
  tableNumber: BusinessFactTableNumber;
  file: string;
  directory: string;
  schemaVersion: string;
  gaps: readonly string[];
  sources: RawSourcePackageBusinessFact["sources"];
  expectedBytes: bigint;
  expectedSha256: string;
}>;

const exactKeys = (value: JsonRecord, expected: readonly string[]): boolean =>
  same(Object.keys(value).sort(), [...expected].sort());

/**
 * Reconstructs the allowed fact metadata from the same validated spool instead
 * of serializing producer-supplied nested values.  The producer receipt is
 * still checked against that reconstruction before any output directory opens.
 */
function verifyBusinessFacts(options: FullBackupLocalPackageAssemblerOptions): readonly VerifiedBusinessFactComponent[] {
  const bundle = options.businessFacts;
  if (bundle === undefined) return [];
  const bundleRecord = own(bundle);
  if (!exactKeys(bundleRecord, FIXED_BUSINESS_FACTS.map((item) => item.key))) fail("EXPORT_PACKAGE_BUSINESS_FACTS_INVALID");
  const view = new FullBackupBusinessFactsView({ spoolDirectory: options.spoolDirectory, spool: options.spool });
  return Object.freeze(FIXED_BUSINESS_FACTS.map((fixed) => {
    const input = own(bundleRecord[fixed.key]);
    if (!exactKeys(input, ["directory", "result"]) || typeof input.directory !== "string" || input.directory.length === 0)
      fail("EXPORT_PACKAGE_BUSINESS_FACTS_INVALID");
    const result = own(input.result);
    const sourceRows = result.sourceRows;
    if (result.mode !== "BUSINESS_FACTS_WORKBOOK" || result.complete !== false || result.spoolId !== options.spool.spoolId ||
        result.snapshotId !== options.spool.snapshotId || result.asOf !== options.spool.asOf || result.file !== fixed.file ||
        !Array.isArray(result.coveredTables) || result.coveredTables.length !== 1 || result.coveredTables[0] !== fixed.tableNumber ||
        typeof result.sizeBytes !== "string" || !/^[1-9]\d*$/.test(result.sizeBytes) || typeof result.sha256 !== "string" || !SHA256.test(result.sha256) ||
        !Array.isArray(sourceRows) || !Array.isArray(result.gaps))
      fail("EXPORT_PACKAGE_BUSINESS_FACTS_INVALID");
    const description = view.describe(fixed.tableNumber);
    if (result.schemaVersion !== description.schemaVersion) fail("EXPORT_PACKAGE_BUSINESS_FACT_SCHEMA_MISMATCH");
    if (sourceRows.length !== description.sources.length) fail("EXPORT_PACKAGE_BUSINESS_FACT_SOURCE_MISMATCH");
    const sources = Object.freeze(description.sources.map((source, index) => {
      const receipt = own(sourceRows[index]);
      if (!exactKeys(receipt, ["sourceTable", "rowCount", "logicalDigest"]) || receipt.sourceTable !== source.sourceTable ||
          typeof receipt.rowCount !== "string" || typeof receipt.logicalDigest !== "string")
        fail("EXPORT_PACKAGE_BUSINESS_FACT_SOURCE_MISMATCH");
      const dataset = options.spool.datasets.find((item) => item.tableName === source.sourceTable);
      if (dataset === undefined || dataset.excluded || receipt.rowCount !== dataset.rowCount || receipt.logicalDigest !== dataset.logicalDigest)
        fail("EXPORT_PACKAGE_BUSINESS_FACT_SOURCE_MISMATCH");
      return Object.freeze({
        sourceTable: source.sourceTable,
        columns: Object.freeze(source.columns.map((column) => column.sourceColumn)),
        rowCount: dataset.rowCount,
        logicalDigest: dataset.logicalDigest,
      });
    }));
    return Object.freeze({
      key: fixed.key,
      tableNumber: fixed.tableNumber,
      file: fixed.file,
      directory: input.directory,
      schemaVersion: description.schemaVersion,
      gaps: Object.freeze([
        BUSINESS_FACT_TABLE_SCOPE_GAPS[fixed.tableNumber],
        DERIVED_SCOPE_GAP,
        ...options.spool.coverageGaps,
        ...BUSINESS_BACKUP_COVERAGE_GAPS.filter((gap) => gap.tableNumbers.includes(fixed.tableNumber)).map((gap) => gap.code),
      ]),
      sources,
      expectedBytes: BigInt(result.sizeBytes),
      expectedSha256: result.sha256,
    });
  }));
}

function attachmentDataset(spool: FullBackupSpoolResult) {
  const dataset = spool.datasets.find((item) => item.tableName === "finance_attachment_version");
  if (dataset === undefined || dataset.excluded) fail("EXPORT_PACKAGE_ATTACHMENT_DATASET_INVALID");
  return dataset!;
}

function expectedAttachment(row: JsonRecord): Readonly<{ id: string; status: string; media?: AttachmentMediaType; bytes?: bigint; hash?: string }> {
  const id = row.id;
  const status = row.status;
  if (typeof id !== "string" || !UUID.test(id) || (status !== "READY" && status !== "UPLOADING" && status !== "FAILED"))
    fail("EXPORT_PACKAGE_INVALID_INDEX");
  const validId: string = id;
  const validStatus: "READY" | "UPLOADING" | "FAILED" = status;
  if (validStatus !== "READY") return { id: validId, status: validStatus };
  const media = row.detected_media_type;
  const bytes = row.actual_size_bytes;
  const hash = row.sha256;
  if (typeof media !== "string" || !Object.hasOwn(EXTENSIONS, media) || typeof bytes !== "string" || !/^[1-9]\d*$/.test(bytes) ||
      typeof hash !== "string" || !SHA256.test(hash)) fail("EXPORT_PACKAGE_INVALID_INDEX");
  return { id: validId, status: validStatus, media: media as AttachmentMediaType, bytes: BigInt(bytes), hash };
}

function safeAnomaly(value: unknown): void {
  const row = own(value);
  const keys = Object.keys(row).sort();
  if (!same(keys, row.field === undefined ? ["code", "columnName", "rowNumber", "tableName"] : ["code", "columnName", "field", "rowNumber", "tableName"]) ||
      row.code !== "TRANSFORM_VALUE_ANOMALY" || typeof row.tableName !== "string" || typeof row.columnName !== "string" ||
      typeof row.rowNumber !== "string" || !/^[a-z_][a-z0-9_]*$/.test(row.tableName) || !/^[a-z_][a-z0-9_]*$/.test(row.columnName) ||
      !/^(0|[1-9]\d*)$/.test(row.rowNumber) || (row.field !== undefined && (typeof row.field !== "string" || !SAFE_FIELD.test(row.field))))
    fail("EXPORT_PACKAGE_ANOMALY_INVALID");
}

/** Assembles already-verified raw components; it never represents a complete F14 backup. */
export class FullBackupLocalPackageAssembler {
  public constructor(private readonly options: FullBackupLocalPackageAssemblerOptions) {}

  public async assemble(): Promise<FullBackupLocalPackage> {
    assertSnapshots(this.options);
    const businessFactComponents = verifyBusinessFacts(this.options);
    if (this.options.finalManifest !== undefined &&
        (businessFactComponents.length !== 6 || this.options.businessDerived === undefined || this.options.derivedVerificationViews === undefined))
      fail("EXPORT_PACKAGE_MANIFEST_REQUIRES_ALL_WORKBOOKS");
    const derivedComponents = await verifyDerivedComponents(this.options.spool, this.options.businessDerived,
      this.options.derivedVerificationViews, businessFactComponents.length === FIXED_BUSINESS_FACTS.length);
    let manifestContext: FullBackupManifestContext | undefined;
    if (this.options.finalManifest !== undefined) {
      if (businessFactComponents.length !== 6 || derivedComponents.length !== 2 || this.options.derivedVerificationViews === undefined)
        fail("EXPORT_PACKAGE_MANIFEST_REQUIRES_ALL_WORKBOOKS");
      const supplied = this.options.finalManifest.context;
      const evidence = await FullBackupManifestEvidence.collect({
        spoolDirectory: this.options.spoolDirectory, spool: this.options.spool,
        index: this.options.finalManifest.index,
        ledger: this.options.derivedVerificationViews.ledger,
        periods: this.options.derivedVerificationViews.periods,
      });
      manifestContext = createFullBackupManifestContext({
        evidence, fileGroupId: supplied.fileGroupId, generatedAt: supplied.generatedAt,
        applicationVersion: supplied.applicationVersion, generatorVersion: supplied.generatorVersion,
      });
      if (JSON.stringify(supplied) !== JSON.stringify(manifestContext))
        fail("EXPORT_PACKAGE_MANIFEST_CONTEXT_MISMATCH");
    }
    const workbookRoot = await assertPrivateBackupDirectory(this.options.workbookDirectory);
    const attachmentRoot = await assertPrivateBackupDirectory(this.options.attachmentDirectory);
    const spoolRoot = await assertPrivateBackupDirectory(this.options.spoolDirectory);
    const businessFactRoots = await Promise.all(businessFactComponents.map((component) => assertPrivateBackupDirectory(component.directory)));
    const derivedRoots = await Promise.all(derivedComponents.map((component) => assertPrivateBackupDirectory(component.directory)));
    await mkdir(this.options.outputRoot, { recursive: true, mode: 0o700 });
    const outputRoot = await assertPrivateBackupDirectory(this.options.outputRoot);
    const stageName = `.raw-source-package-stage-${crypto.randomUUID()}`;
    const finalName = `raw-source-package-${crypto.randomUUID()}`;
    const stage = await createPrivateDirectory(join(outputRoot, stageName));
    const finalDirectory = join(outputRoot, finalName);
    let renamed = false;
    let published = false;
    let payloadIndex: FileHandle | undefined;
    let outputIndex: FileHandle | undefined;
    let outputAnomalies: FileHandle | undefined;
    let sourceRows: AsyncIterator<readonly (string | null)[]> | undefined;
    let primaryError: unknown;
    try {
      const workbookFiles = new Map(this.options.workbooks.workbooks.map((item) => [item.file, item]));
      if (await countDirectory(workbookRoot, (name, entry) => entry.isFile() && workbookFiles.has(name)) !== FIXED_WORKBOOKS.length)
        fail("EXPORT_PACKAGE_EXTRA_FILE");
      const destinationWorkbooks = await createPrivateDirectory(join(stage, "workbooks"));
      const metadataDirectory = await createPrivateDirectory(join(stage, "metadata"));
      const payloadIndexPath = "metadata/.payloads.ndjson";
      payloadIndex = await openOutput(stage, payloadIndexPath);
      let payloadFileCount = 0n, totalBytes = 0n;
      const addPayload = async (file: RawSourcePackageFile): Promise<void> => {
        await writeLine(payloadIndex!, JSON.stringify(file));
        payloadFileCount += 1n;
        totalBytes += BigInt(file.sizeBytes);
      };
      const workbookResults: RawSourcePackageFile[] = [];
      for (const id of FIXED_WORKBOOKS) {
        const file = `workbook-${id}.xlsx`;
        const expected = workbookFiles.get(file)!;
        const copied = await copyVerifiedBackupFile({ sourceRoot: workbookRoot, sourcePath: file, destinationRoot: stage, destinationPath: `workbooks/${file}`,
          expectedBytes: BigInt(expected.sizeBytes), expectedSha256: expected.sha256 });
        if (manifestContext !== undefined) await verifyWorkbookManifest({
          root: stage, relativePath: copied.path, context: manifestContext,
          file, workbookRole: "RAW", tableNumbers: [],
        });
        workbookResults.push(copied);
        await addPayload(copied);
      }
      await syncBackupDirectory(destinationWorkbooks);

      const businessFacts: RawSourcePackageBusinessFact[] = [];
      if (businessFactComponents.length > 0) {
        const destinationBusinessFacts = await createPrivateDirectory(join(stage, "business-facts"));
        for (const [index, component] of businessFactComponents.entries()) {
          const sourceRoot = businessFactRoots[index]!;
          if (await countDirectory(sourceRoot, (name, entry) => entry.isFile() && name === component.file) !== 1)
            fail("EXPORT_PACKAGE_BUSINESS_FACT_FILE_INVALID");
          const destinationPath = `business-facts/${component.file}`;
          const copied = await copyVerifiedBackupFile({
            sourceRoot,
            sourcePath: component.file,
            destinationRoot: stage,
            destinationPath,
            expectedBytes: component.expectedBytes,
            expectedSha256: component.expectedSha256,
          });
          if (manifestContext !== undefined) await verifyWorkbookManifest({
            root: stage, relativePath: copied.path, context: manifestContext,
            file: component.file, workbookRole: "BUSINESS_FACT", tableNumbers: [component.tableNumber],
          });
          await addPayload(copied);
          businessFacts.push(Object.freeze({
            tableNumber: component.tableNumber,
            file: copied,
            schemaVersion: component.schemaVersion,
            gaps: component.gaps,
            sources: component.sources,
          }));
        }
        await syncBackupDirectory(destinationBusinessFacts);
      }

      const businessDerived: RawSourcePackageDerived[] = [];
      if (derivedComponents.length > 0) {
        const destinationDerived = await createPrivateDirectory(join(stage, "business-derived"));
        for (const [index, component] of derivedComponents.entries()) {
          const sourceRoot = derivedRoots[index]!;
          if (await countDirectory(sourceRoot, (name, entry) => entry.isFile() && name === component.file) !== 1)
            fail("EXPORT_PACKAGE_DERIVED_FILE_INVALID");
          const copied = await copyVerifiedBackupFile({
            sourceRoot, sourcePath: component.file, destinationRoot: stage,
            destinationPath: `business-derived/${component.file}`,
            expectedBytes: component.expectedBytes, expectedSha256: component.expectedSha256,
          });
          const verified = await hashBackupFile(stage, copied.path);
          if (verified.sha256 !== copied.sha256 || verified.sizeBytes !== copied.sizeBytes)
            fail("EXPORT_PACKAGE_DERIVED_COPY_MISMATCH");
          if (manifestContext !== undefined) await verifyWorkbookManifest({
            root: stage, relativePath: copied.path, context: manifestContext,
            file: component.file, workbookRole: "BUSINESS_DERIVED", tableNumbers: [component.metadata.tableNumber],
          });
          await addPayload(copied);
          businessDerived.push(Object.freeze({ ...component.metadata, file: copied }));
        }
        await syncBackupDirectory(destinationDerived);
      }
      const incompleteReasons = manifestContext !== undefined
        ? ["BUSINESS_DERIVED_VIEWS_UNPUBLISHED", "BUSINESS_FACTS_DECLARED_FIELDS_ONLY", "PRIMARY_SHEET_SUMMARIES_ONLY"]
        : businessDerived.length > 0 ? BUSINESS_DERIVED_INCOMPLETE_REASONS :
        businessFacts.length === 0 ? INCOMPLETE_REASONS : BUSINESS_FACTS_INCOMPLETE_REASONS;
      const packageCoverageGaps = [...new Set([
        ...this.options.spool.coverageGaps,
        ...businessDerived.flatMap((component) => component.gaps),
        ...(businessDerived.some((component) => component.status === "PARTIAL") ? ["DERIVED_SOURCE_ANOMALIES_OR_UNRESOLVED_PERIODS"] : []),
      ])];

      if (await countDirectory(attachmentRoot, (name, entry) => (name === this.options.attachments.indexFile && entry.isFile()) || (name === "attachments" && entry.isDirectory())) !== 2)
        fail("EXPORT_PACKAGE_EXTRA_FILE");
      const sourceAttachments = await assertPrivateBackupDirectory(join(attachmentRoot, "attachments"));
      const destinationAttachments = await createPrivateDirectory(join(stage, "attachments"));
      const dataset = attachmentDataset(this.options.spool);
      sourceRows = readBackupSpoolDataset(spoolRoot, dataset)[Symbol.asyncIterator]();
      const indexHash = await hashBackupFile(attachmentRoot, this.options.attachments.indexFile);
      if (indexHash.sha256 !== this.options.attachments.indexSha256) fail("EXPORT_PACKAGE_ATTACHMENT_INDEX_HASH");
      outputIndex = await openOutput(stage, "metadata/attachment-index.ndjson");
      let ready = 0n, unready = 0n, readyBytes = 0n, previousId = "";
      try {
        for await (const line of lines(attachmentRoot, this.options.attachments.indexFile)) {
          let indexRow!: JsonRecord;
          try { indexRow = own(JSON.parse(line)); } catch { fail("EXPORT_PACKAGE_INVALID_INDEX"); }
          const source = await sourceRows!.next();
          if (source.done) fail("EXPORT_PACKAGE_ATTACHMENT_LOCKSTEP");
          const sourceRow = Object.fromEntries(dataset.columns.map((column, index) => [column, source.value[index]]));
          const expectedKeys = [...dataset.columns, "backup_anomalies", "backup_file", "backup_state"].sort();
          if (!same(Object.keys(indexRow).sort(), expectedKeys) || dataset.columns.some((column) => indexRow[column] !== sourceRow[column]))
            fail("EXPORT_PACKAGE_ATTACHMENT_LOCKSTEP");
          const expected = expectedAttachment(sourceRow);
          if (expected.id <= previousId) fail("EXPORT_PACKAGE_ATTACHMENT_ORDER");
          previousId = expected.id;
          if (!Array.isArray(indexRow.backup_anomalies) || indexRow.backup_anomalies.some((item) => typeof item !== "string" || !/^[A-Z_]+$/.test(item)))
            fail("EXPORT_PACKAGE_INVALID_INDEX");
          if (expected.status === "READY") {
            const sourceFile = `attachments/${expected.id}.${EXTENSIONS[expected.media!]}`;
            if (indexRow.backup_state !== "COPIED" || indexRow.backup_file !== sourceFile) fail("EXPORT_PACKAGE_ATTACHMENT_LOCKSTEP");
            const copied = await copyVerifiedBackupFile({ sourceRoot: attachmentRoot, sourcePath: sourceFile, destinationRoot: stage, destinationPath: sourceFile,
              expectedBytes: expected.bytes!, expectedSha256: expected.hash!, expectedMediaType: expected.media! });
            if (copied.path !== sourceFile) fail("EXPORT_PACKAGE_ATTACHMENT_LOCKSTEP");
            await addPayload(copied);
            readyBytes += BigInt(copied.sizeBytes);
            ready += 1n;
          } else {
            if (indexRow.backup_state !== "UNREADY" || indexRow.backup_file !== null) fail("EXPORT_PACKAGE_ATTACHMENT_LOCKSTEP");
            unready += 1n;
          }
          await writeLine(outputIndex!, line);
        }
        const trailing = await sourceRows!.next();
        if (!trailing.done) fail("EXPORT_PACKAGE_ATTACHMENT_LOCKSTEP");
      } finally {
        if (outputIndex !== undefined) { await outputIndex.sync(); await outputIndex.close(); outputIndex = undefined; }
        if (sourceRows?.return !== undefined) { await sourceRows.return(undefined as never); sourceRows = undefined; }
      }
      if (ready.toString() !== this.options.attachments.readyCount || unready.toString() !== this.options.attachments.unreadyCount ||
          readyBytes.toString() !== this.options.attachments.totalBytes)
        fail("EXPORT_PACKAGE_ATTACHMENT_LOCKSTEP");
      if (await countDirectory(sourceAttachments, (name, entry) => entry.isFile() && UUID.test(name.slice(0, 36)) && /\.(pdf|png|jpg)$/.test(name)) !== Number(ready))
        fail("EXPORT_PACKAGE_EXTRA_FILE");
      if (await countDirectory(destinationAttachments, (name, entry) => entry.isFile() && UUID.test(name.slice(0, 36)) && /\.(pdf|png|jpg)$/.test(name)) !== Number(ready))
        fail("EXPORT_PACKAGE_EXTRA_FILE");
      const outputIndexHash = await hashBackupFile(stage, "metadata/attachment-index.ndjson");
      if (outputIndexHash.sha256 !== indexHash.sha256) fail("EXPORT_PACKAGE_ATTACHMENT_INDEX_HASH");
      const attachmentIndex: RawSourcePackageFile = { path: "metadata/attachment-index.ndjson", ...outputIndexHash };
      await addPayload(attachmentIndex);
      await syncBackupDirectory(destinationAttachments);

      outputAnomalies = await openOutput(stage, "metadata/transform-anomalies.ndjson");
      let anomalyCount = 0n;
      try {
        for await (const line of lines(spoolRoot, this.options.spool.anomalyFile)) {
          let value: unknown;
          try { value = JSON.parse(line); } catch { fail("EXPORT_PACKAGE_ANOMALY_INVALID"); }
          safeAnomaly(value);
          await writeLine(outputAnomalies!, line);
          anomalyCount += 1n;
        }
      } finally {
        if (outputAnomalies !== undefined) { await outputAnomalies.sync(); await outputAnomalies.close(); outputAnomalies = undefined; }
      }
      if (anomalyCount.toString() !== this.options.spool.anomalyCount) fail("EXPORT_PACKAGE_ANOMALY_COUNT");
      const anomalyHash = await hashBackupFile(stage, "metadata/transform-anomalies.ndjson");
      const anomalies: RawSourcePackageFile = { path: "metadata/transform-anomalies.ndjson", ...anomalyHash };
      await addPayload(anomalies);
      await payloadIndex.sync();
      const finalIndex = await openOutput(stage, "raw-source-package-index.json");
      try {
        const datasetSummary = this.options.spool.datasets.map((item) => ({ tableName: item.tableName, rowCount: item.rowCount, logicalDigest: item.logicalDigest, excluded: item.excluded }));
        const businessFactsSection = businessFacts.length === 0 ? "" : `,"businessFacts":${JSON.stringify(businessFacts)}`;
        const derivedSection = businessDerived.length === 0 ? "" : `,"businessDerived":${JSON.stringify(businessDerived)}`;
        const prefix = `{"mode":"RAW_SOURCE_PACKAGE","complete":false,"snapshotId":${JSON.stringify(this.options.spool.snapshotId)},"asOf":${JSON.stringify(this.options.spool.asOf)},"sourceIds":${JSON.stringify({ spoolId: this.options.spool.spoolId, workbookOutputId: this.options.workbooks.outputId, attachmentOutputId: this.options.attachments.outputId })},"layoutVersion":${JSON.stringify(FULL_BACKUP_LAYOUT_VERSION)},"datasets":${JSON.stringify(datasetSummary)},"attachmentIndex":${JSON.stringify(attachmentIndex)},"readyAttachmentCount":${JSON.stringify(ready.toString())},"unreadyAttachmentCount":${JSON.stringify(unready.toString())},"anomalyCount":${JSON.stringify(anomalyCount.toString())},"coverageGaps":${JSON.stringify(packageCoverageGaps)},"incompleteReasons":${JSON.stringify(incompleteReasons)}${businessFactsSection}${derivedSection},"files":[`;
        await writeBackupBytes(finalIndex, Buffer.from(prefix));
        let first = true;
        for await (const line of lines(stage, payloadIndexPath)) {
          JSON.parse(line);
          await writeBackupBytes(finalIndex, Buffer.from(`${first ? "" : ","}${line}`));
          first = false;
        }
        await writeBackupBytes(finalIndex, Buffer.from("]}"));
        await finalIndex.sync();
      } finally { await finalIndex.close(); }
      const packageIndexHash = await hashBackupFile(stage, "raw-source-package-index.json");
      let packageManifest: RawSourcePackageFile | undefined;
      if (manifestContext !== undefined) {
        await addPayload({ path: "raw-source-package-index.json", ...packageIndexHash });
        await payloadIndex.sync();
        const manifest = await openOutput(stage, "package-manifest.json");
        try {
          const header = {
            mode: "FULL_BACKUP_PACKAGE_MANIFEST", schemaVersion: "full-backup-package-manifest.v1",
            complete: false, backupStatus: "INCOMPLETE_IMPLEMENTATION", context: manifestContext,
            integrityScope: "REGISTERED_SNAPSHOT_AND_COPIED_PAYLOAD_BYTES",
            businessCorrectness: "NOT_ASSERTED", coverageGaps: packageCoverageGaps, incompleteReasons,
            workbookCount: "20", readyAttachmentCount: ready.toString(), unreadyAttachmentCount: unready.toString(),
            payloadFileCount: payloadFileCount.toString(), payloadBytes: totalBytes.toString(),
            inventoryOrder: "FIXED_WORKBOOKS_THEN_ORDERED_ATTACHMENTS_THEN_CONTROLS",
            selfHashPolicy: "MANIFEST_EXCLUDED_FROM_FILES_HASH_RETURNED_SEPARATELY",
          };
          await writeBackupBytes(manifest, Buffer.from(`${JSON.stringify(header).slice(0, -1)},"files":[`));
          let first = true;
          for await (const line of lines(stage, payloadIndexPath)) {
            await writeBackupBytes(manifest, Buffer.from(`${first ? "" : ","}${line}`));
            first = false;
          }
          await writeBackupBytes(manifest, Buffer.from("]}"));
          await manifest.sync();
        } finally { await manifest.close(); }
        packageManifest = { path: "package-manifest.json", ...await hashBackupFile(stage, "package-manifest.json") };
      }
      await payloadIndex.close();
      payloadIndex = undefined;
      await rm(join(stage, payloadIndexPath), { force: true });
      await syncBackupDirectory(metadataDirectory);
      await syncBackupDirectory(stage);
      try { await open(finalDirectory, constants.O_RDONLY | constants.O_NOFOLLOW).then((handle) => handle.close().then(() => fail("EXPORT_PACKAGE_TARGET_EXISTS"))).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
      catch { fail("EXPORT_PACKAGE_TARGET_EXISTS"); }
      await rename(stage, finalDirectory);
      renamed = true;
      await syncBackupDirectory(outputRoot);
      published = true;
      return { mode: "RAW_SOURCE_PACKAGE", complete: false, outputId: finalName, snapshotId: this.options.spool.snapshotId, asOf: this.options.spool.asOf,
        workbooks: workbookResults, attachmentIndex, anomalies, indexFile: "raw-source-package-index.json", indexSha256: packageIndexHash.sha256,
        payloadFileCount: payloadFileCount.toString(), totalBytes: totalBytes.toString(), readyAttachmentCount: ready.toString(), unreadyAttachmentCount: unready.toString(),
        coverageGaps: packageCoverageGaps, incompleteReasons: [...incompleteReasons],
        ...(businessFacts.length === 0 ? {} : { businessFacts: Object.freeze(businessFacts) }),
        ...(businessDerived.length === 0 ? {} : { businessDerived: Object.freeze(businessDerived) }),
        ...(packageManifest === undefined ? {} : { packageManifest }) };
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      const cleanup = await Promise.allSettled([
        ...(payloadIndex === undefined ? [] : [payloadIndex.close()]),
        ...(outputIndex === undefined ? [] : [outputIndex.close()]),
        ...(outputAnomalies === undefined ? [] : [outputAnomalies.close()]),
        ...(sourceRows?.return === undefined ? [] : [sourceRows.return(undefined as never)]),
      ]);
      if (!published) {
        await rm(stage, { recursive: true, force: true });
        if (renamed) await rm(finalDirectory, { recursive: true, force: true });
      }
      if (primaryError === undefined && cleanup.some((result) => result.status === "rejected"))
        throw new AggregateError(cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason), "EXPORT_PACKAGE_RESOURCE_CLEANUP_FAILED");
    }
  }
}
