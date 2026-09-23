import { BACKUP_MAX_DATA_ROWS } from "./full-backup-layout.js";
import {
  FullBackupBusinessFactsWorkbookExporter,
  type FullBackupBusinessFactsWorkbookExportResult,
} from "./full-backup-business-facts-workbook-exporter.js";
import type { XlsxOptions } from "./openxml-xlsx-writer.js";
import type { FullBackupSpoolResult } from "./full-backup-spool.js";

type WorkbookWriter = (options: XlsxOptions) => Promise<void>;

/** The stable table-5 result contract retained for existing package callers. */
export type FullBackupPayrollWorkbookExportResult = Omit<FullBackupBusinessFactsWorkbookExportResult, "coveredTables"> & Readonly<{
  coveredTables: readonly [5];
}>;

export type FullBackupPayrollWorkbookExporterOptions = Readonly<{
  spoolDirectory: string;
  spool: FullBackupSpoolResult;
  outputRoot: string;
  /** @internal Test seam. Production always uses the OpenXML writer. */
  writeWorkbook?: WorkbookWriter;
  /** @internal Test seam, bounded to the production Excel page limit. */
  maxDataRows?: number;
}>;

/**
 * Stable table-5 entry point. The fixed PAYROLL profile preserves its filename,
 * sheet names, result contract, and no-join source-row semantics.
 */
export class FullBackupPayrollWorkbookExporter {
  public constructor(private readonly options: FullBackupPayrollWorkbookExporterOptions) {
    const maxDataRows = options.maxDataRows ?? BACKUP_MAX_DATA_ROWS;
    if (!Number.isInteger(maxDataRows) || maxDataRows < 1 || maxDataRows > BACKUP_MAX_DATA_ROWS)
      throw new Error("EXPORT_PAYROLL_WORKBOOK_PAGE_SIZE_INVALID");
  }

  public async export(): Promise<FullBackupPayrollWorkbookExportResult> {
    const result = await new FullBackupBusinessFactsWorkbookExporter({ ...this.options, profile: "PAYROLL" }).export();
    if (result.coveredTables.length !== 1 || result.coveredTables[0] !== 5 || result.file !== "business-table-5-payroll-facts.xlsx")
      throw new Error("EXPORT_PAYROLL_WORKBOOK_PROFILE_INVALID");
    return result as FullBackupPayrollWorkbookExportResult;
  }
}
