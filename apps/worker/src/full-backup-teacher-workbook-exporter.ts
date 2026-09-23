import {
  FullBackupBusinessFactsWorkbookExporter,
  type FullBackupBusinessFactsWorkbookExportResult,
} from "./full-backup-business-facts-workbook-exporter.js";
import type { XlsxOptions } from "./openxml-xlsx-writer.js";
import type { FullBackupSpoolResult } from "./full-backup-spool.js";

type WorkbookWriter = (options: XlsxOptions) => Promise<void>;

export type FullBackupTeacherWorkbookExportResult = Omit<FullBackupBusinessFactsWorkbookExportResult, "coveredTables"> & Readonly<{
  coveredTables: readonly [1];
}>;

export type FullBackupTeacherWorkbookExporterOptions = Readonly<{
  spoolDirectory: string;
  spool: FullBackupSpoolResult;
  outputRoot: string;
  /** @internal Test seam. Production always uses the OpenXML writer. */
  writeWorkbook?: WorkbookWriter;
  /** @internal Test seam, bounded by the generic exporter's production limit. */
  maxDataRows?: number;
}>;

/** Writes table 1's currently declared stored teacher facts without joins or aggregation. */
export class FullBackupTeacherWorkbookExporter {
  public constructor(private readonly options: FullBackupTeacherWorkbookExporterOptions) {}

  public async export(): Promise<FullBackupTeacherWorkbookExportResult> {
    const result = await new FullBackupBusinessFactsWorkbookExporter({ ...this.options, profile: "TEACHER" }).export();
    if (result.coveredTables.length !== 1 || result.coveredTables[0] !== 1 || result.file !== "business-table-1-teacher-facts.xlsx")
      throw new Error("EXPORT_TEACHER_WORKBOOK_PROFILE_INVALID");
    return result as FullBackupTeacherWorkbookExportResult;
  }
}
