import {
  FullBackupBusinessFactsWorkbookExporter,
  type FullBackupBusinessFactsWorkbookExportResult,
} from "./full-backup-business-facts-workbook-exporter.js";
import type { XlsxOptions } from "./openxml-xlsx-writer.js";
import type { FullBackupManifestContext } from "./full-backup-manifest.js";
import type { FullBackupSpoolResult } from "./full-backup-spool.js";

type WorkbookWriter = (options: XlsxOptions) => Promise<void>;

export type FullBackupFinanceWorkbookExportResult = Omit<FullBackupBusinessFactsWorkbookExportResult, "coveredTables"> & Readonly<{
  coveredTables: readonly [4];
}>;

export type FullBackupFinanceWorkbookExporterOptions = Readonly<{
  spoolDirectory: string;
  spool: FullBackupSpoolResult;
  outputRoot: string;
  manifestContext?: FullBackupManifestContext;
  /** @internal Test seam. Production always uses the OpenXML writer. */
  writeWorkbook?: WorkbookWriter;
  /** @internal Test seam, bounded to the production Excel page limit. */
  maxDataRows?: number;
}>;

/** Writes table 4's currently declared stored financial facts without joins or aggregation. */
export class FullBackupFinanceWorkbookExporter {
  public constructor(private readonly options: FullBackupFinanceWorkbookExporterOptions) {}

  public async export(): Promise<FullBackupFinanceWorkbookExportResult> {
    const result = await new FullBackupBusinessFactsWorkbookExporter({ ...this.options, profile: "FINANCE" }).export();
    if (result.coveredTables.length !== 1 || result.coveredTables[0] !== 4 || result.file !== "business-table-4-finance-facts.xlsx")
      throw new Error("EXPORT_FINANCE_WORKBOOK_PROFILE_INVALID");
    return result as FullBackupFinanceWorkbookExportResult;
  }
}
