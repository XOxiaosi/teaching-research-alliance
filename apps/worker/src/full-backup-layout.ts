import { EXPORT_SCHEMA_REGISTRY } from "./export-schema-registry.js";

export const FULL_BACKUP_LAYOUT_VERSION = "raw-source-layout.v4";
export const BACKUP_MAX_DATA_ROWS = 1_000_000;

// An explicit inventory prevents a new table from silently entering an arbitrary workbook.
const groups = [
  ["01", "组织账户与权限", "organization_unit campus_region_assignment person_campus_assignment person_relationship person_relationship_change person_relationship_change_effect person_relationship_change_preview role_assignment settlement_account company_finance_fund company_finance_fund_assignment company_finance_fund_command_idempotency user_account user_session venue venue_command_idempotency venue_permission_grant"],
  ["02", "教师信息", "person teacher_profile"],
  ["03", "业务流水", "teacher_student_record referral_case referral_case_event referral_creation_snapshot referral_acceptance_snapshot referral_creation_idempotency referral_acceptance_idempotency referral_lifecycle_idempotency weekly_fee_entry weekly_fee_entry_version weekly_fee_event weekly_fee_idempotency"],
  ["04", "分配明细", "weekly_fee_allocation_snapshot weekly_fee_refund_effect settlement_calculation_run"],
  ["06", "财务单据", "finance_document finance_document_event finance_draft_idempotency finance_refund_command_idempotency finance_refund_decision finance_refund_submission finance_refund_submission_item finance_reimbursement_command_idempotency finance_reimbursement_decision finance_reimbursement_submission finance_reimbursement_transfer finance_reimbursement_reversal finance_self_purchase_command_idempotency finance_self_purchase_reversal finance_self_purchase_transfer finance_withdrawal_command_idempotency finance_withdrawal_reversal finance_withdrawal_submission finance_withdrawal_transfer"],
  ["07", "工资奖金", "cash_wage_confirmation cash_wage_plan_version cash_wage_todo bonus_project_catalog_command_idempotency bonus_project_name_version bonus_project_slot project_bonus_transfer salary_benefit_command_idempotency salary_benefit_reversal"],
  ["08", "财务扣费", "finance_benefit_execution finance_benefit_plan_version finance_benefit_todo"],
  ["09", "结算账本", "account_balance_projection ledger_entry ledger_event"],
  ["10", "绩效费率", "rate_policy_version"],
  ["11", "年度期间", "academic_period academic_year_plan teaching_week"],
  ["12", "审计记录", "audit_event"],
  ["13", "附件清单", "finance_attachment finance_attachment_event finance_attachment_reservation_idempotency finance_attachment_version finance_refund_attachment_binding finance_reimbursement_attachment_binding finance_self_purchase_attachment_binding finance_withdrawal_attachment_binding salary_benefit_attachment_binding"],
] as const;

export type FullBackupLayoutItem = Readonly<{
  tableName: string;
  workbookId: string;
  logicalGroupName: string;
  sheetId: string | null;
  policy: "RAW_SOURCE" | "AUTH_SECRET_TABLE_EXCLUDED";
  excludedColumns: readonly string[];
}>;

export function createFullBackupLayout(): readonly FullBackupLayoutItem[] {
  const mapping = new Map<string, { workbookId: string; logicalGroupName: string }>();
  for (const [workbookId, logicalGroupName, names] of groups) {
    for (const name of names.split(" ")) {
      if (mapping.has(name)) throw new Error("EXPORT_LAYOUT_DUPLICATE_TABLE");
      mapping.set(name, { workbookId, logicalGroupName });
    }
  }
  if (mapping.size !== EXPORT_SCHEMA_REGISTRY.length || EXPORT_SCHEMA_REGISTRY.some(table => !mapping.has(table.name))) {
    throw new Error("EXPORT_LAYOUT_SCHEMA_GAP");
  }
  return EXPORT_SCHEMA_REGISTRY.map((table, index) => {
    const excludedColumns = table.columns.filter(column => column.disposition === "SECRET_EXCLUDED").map(column => column.name);
    const excluded = excludedColumns.length === table.columns.length;
    return {
      tableName: table.name, ...mapping.get(table.name)!,
      sheetId: excluded ? null : `t${String(index + 1).padStart(2, "0")}_${table.name.slice(0, 22)}`,
      policy: excluded ? "AUTH_SECRET_TABLE_EXCLUDED" : "RAW_SOURCE",
      excludedColumns,
    };
  });
}

export function backupSheetPartId(item: FullBackupLayoutItem, part: number): string {
  if (item.sheetId === null || !Number.isSafeInteger(part) || part < 1 || part > 9999) throw new Error("EXPORT_INVALID_SHEET_PART");
  return `${item.sheetId}_${String(part).padStart(4, "0")}`;
}

// These source tables do not exist yet. Never synthesize empty sheets and claim product coverage.
export const FULL_BACKUP_KNOWN_COVERAGE_GAPS = [
  "MONTHLY_INCOME_PUBLISHED_VERSIONS_NOT_IMPLEMENTED",
  "MANUAL_ADJUSTMENT_WORKFLOW_NOT_IMPLEMENTED",
  "BACKUP_JOB_AND_SCHEDULE_HISTORY_NOT_IMPLEMENTED",
  "NICKNAME_CORRECTION_HISTORY_NOT_IMPLEMENTED",
] as const;
