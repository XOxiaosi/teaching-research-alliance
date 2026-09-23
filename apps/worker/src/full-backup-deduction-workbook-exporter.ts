import {
  FullBackupBusinessFactsWorkbookExporter,
  type FullBackupBusinessFactsWorkbookExportResult,
} from "./full-backup-business-facts-workbook-exporter.js";
import type { XlsxOptions } from "./openxml-xlsx-writer.js";
import type { FullBackupSpoolResult } from "./full-backup-spool.js";

type WorkbookWriter = (options: XlsxOptions) => Promise<void>;

export type FullBackupDeductionWorkbookExportResult = Omit<FullBackupBusinessFactsWorkbookExportResult, "coveredTables"> & Readonly<{
  coveredTables: readonly [6];
}>;

export type FullBackupDeductionWorkbookExporterOptions = Readonly<{
  spoolDirectory: string;
  spool: FullBackupSpoolResult;
  outputRoot: string;
  /** @internal Test seam. Production always uses the OpenXML writer. */
  writeWorkbook?: WorkbookWriter;
  /** @internal Test seam, bounded by the generic exporter's production limit. */
  maxDataRows?: number;
}>;

/** Writes table 6's currently declared stored deduction facts without joins or aggregation. */
export class FullBackupDeductionWorkbookExporter {
  public constructor(private readonly options: FullBackupDeductionWorkbookExporterOptions) {}

  public async export(): Promise<FullBackupDeductionWorkbookExportResult> {
    const result = await new FullBackupBusinessFactsWorkbookExporter({ ...this.options, profile: "DEDUCTION" }).export();
    if (result.coveredTables.length !== 1 || result.coveredTables[0] !== 6 || result.file !== "business-table-6-deduction-facts.xlsx")
      throw new Error("EXPORT_DEDUCTION_WORKBOOK_PROFILE_INVALID");
    return result as FullBackupDeductionWorkbookExportResult;
  }
}
