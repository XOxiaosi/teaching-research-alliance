import {
  FullBackupBusinessFactsWorkbookExporter,
  type FullBackupBusinessFactsWorkbookExportResult,
} from "./full-backup-business-facts-workbook-exporter.js";
import type { XlsxOptions } from "./openxml-xlsx-writer.js";
import type { FullBackupSpoolResult } from "./full-backup-spool.js";

type WorkbookWriter = (options: XlsxOptions) => Promise<void>;

export type FullBackupPerformanceConfigurationWorkbookExportResult = Omit<FullBackupBusinessFactsWorkbookExportResult, "coveredTables"> & Readonly<{
  coveredTables: readonly [8];
}>;

export type FullBackupPerformanceConfigurationWorkbookExporterOptions = Readonly<{
  spoolDirectory: string;
  spool: FullBackupSpoolResult;
  outputRoot: string;
  /** @internal Test seam. Production always uses the OpenXML writer. */
  writeWorkbook?: WorkbookWriter;
  /** @internal Test seam, bounded by the generic exporter's production limit. */
  maxDataRows?: number;
}>;

/** Writes table 8's currently declared stored performance-configuration facts without joins or aggregation. */
export class FullBackupPerformanceConfigurationWorkbookExporter {
  public constructor(private readonly options: FullBackupPerformanceConfigurationWorkbookExporterOptions) {}

  public async export(): Promise<FullBackupPerformanceConfigurationWorkbookExportResult> {
    const result = await new FullBackupBusinessFactsWorkbookExporter({ ...this.options, profile: "PERFORMANCE_CONFIGURATION" }).export();
    if (result.coveredTables.length !== 1 || result.coveredTables[0] !== 8 || result.file !== "business-table-8-performance-configuration-facts.xlsx")
      throw new Error("EXPORT_PERFORMANCE_CONFIGURATION_WORKBOOK_PROFILE_INVALID");
    return result as FullBackupPerformanceConfigurationWorkbookExportResult;
  }
}
