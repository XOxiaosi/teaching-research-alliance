import {
  FullBackupBusinessFactsWorkbookExporter,
  type FullBackupBusinessFactsWorkbookExportResult,
} from "./full-backup-business-facts-workbook-exporter.js";
import type { XlsxOptions } from "./openxml-xlsx-writer.js";
import type { FullBackupSpoolResult } from "./full-backup-spool.js";

type WorkbookWriter = (options: XlsxOptions) => Promise<void>;

export type FullBackupStudentWorkbookExportResult = Omit<FullBackupBusinessFactsWorkbookExportResult, "coveredTables"> & Readonly<{
  coveredTables: readonly [2];
}>;

export type FullBackupStudentWorkbookExporterOptions = Readonly<{
  spoolDirectory: string;
  spool: FullBackupSpoolResult;
  outputRoot: string;
  /** @internal Test seam. Production always uses the OpenXML writer. */
  writeWorkbook?: WorkbookWriter;
  /** @internal Test seam, bounded by the generic exporter's production limit. */
  maxDataRows?: number;
}>;

/** Writes table 2's currently declared stored student-flow facts without joins or aggregation. */
export class FullBackupStudentWorkbookExporter {
  public constructor(private readonly options: FullBackupStudentWorkbookExporterOptions) {}

  public async export(): Promise<FullBackupStudentWorkbookExportResult> {
    const result = await new FullBackupBusinessFactsWorkbookExporter({ ...this.options, profile: "STUDENT" }).export();
    if (result.coveredTables.length !== 1 || result.coveredTables[0] !== 2 || result.file !== "business-table-2-student-facts.xlsx")
      throw new Error("EXPORT_STUDENT_WORKBOOK_PROFILE_INVALID");
    return result as FullBackupStudentWorkbookExportResult;
  }
}
