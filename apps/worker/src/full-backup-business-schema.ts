import { EXPORT_SCHEMA_REGISTRY } from "./export-schema-registry.js";
import { FULL_BACKUP_KNOWN_COVERAGE_GAPS } from "./full-backup-layout.js";
import { fullBackupOutputColumns } from "./full-backup-transformer.js";

/**
 * This is an audit mapping for the eight product-facing business tables.  It
 * deliberately does not assemble rows, join source tables, or calculate
 * amounts.  Raw-source workbooks remain the authoritative stored-fact export.
 */
export const FULL_BACKUP_BUSINESS_SCHEMA_VERSION = "full-backup-business-schema.v2";

export type BusinessBackupSheetMode = "STORED_FACTS" | "DERIVED_REQUIRED";
export type BusinessBackupRowModel = "SOURCE_ROWS_ONLY" | "DERIVED_NOT_GENERATED";

export type BusinessBackupSourceReference = Readonly<{
  sourceTable: string;
  sourceColumn: string;
  relationKeyDescription: string;
}>;

export type BusinessBackupSourceColumn = BusinessBackupSourceReference & Readonly<{
  label: string;
}>;

export type BusinessBackupSheet = Readonly<{
  sheetId: string;
  title: string;
  tableNumber: number;
  mode: BusinessBackupSheetMode;
  /** Stored facts are kept as independent source rows; no cross-table product is allowed. */
  rowModel: BusinessBackupRowModel;
  /** Stable keys that identify each contributing raw record before any later view is assembled. */
  rowKeyColumns: readonly BusinessBackupSourceReference[];
  columns: readonly BusinessBackupSourceColumn[];
}>;

export type BusinessCoverageGap = Readonly<{
  code: string;
  tableNumbers: readonly number[];
  description: string;
}>;

export type FullBackupBusinessSchema = Readonly<{
  schemaVersion: typeof FULL_BACKUP_BUSINESS_SCHEMA_VERSION;
  mode: "BUSINESS_SCHEMA_ONLY";
  complete: false;
  sheets: readonly BusinessBackupSheet[];
  /** Existing RAW gaps are referenced, never redefined by this business mapping. */
  rawCoverageGaps: readonly string[];
  businessCoverageGaps: readonly BusinessCoverageGap[];
}>;

const source = (sourceTable: string, sourceColumn: string, label: string, relationKeyDescription: string): BusinessBackupSourceColumn =>
  Object.freeze({ sourceTable, sourceColumn, label, relationKeyDescription });

const key = (sourceTable: string, sourceColumn: string, relationKeyDescription: string): BusinessBackupSourceReference =>
  Object.freeze({ sourceTable, sourceColumn, relationKeyDescription });

const stored = (sheetId: string, title: string, tableNumber: number, rowKeyColumns: readonly BusinessBackupSourceReference[], columns: readonly BusinessBackupSourceColumn[]): BusinessBackupSheet =>
  Object.freeze({ sheetId, title, tableNumber, mode: "STORED_FACTS", rowModel: "SOURCE_ROWS_ONLY", rowKeyColumns, columns });

const derived = (sheetId: string, title: string, tableNumber: number, rowKeyColumns: readonly BusinessBackupSourceReference[], columns: readonly BusinessBackupSourceColumn[]): BusinessBackupSheet =>
  Object.freeze({ sheetId, title, tableNumber, mode: "DERIVED_REQUIRED", rowModel: "DERIVED_NOT_GENERATED", rowKeyColumns, columns });

export const BUSINESS_BACKUP_SHEETS: readonly BusinessBackupSheet[] = Object.freeze([
  stored("business_table_1", "表1_教师信息", 1, Object.freeze([
    key("person", "id", "person.id 为自然人稳定主键"),
    key("user_account", "id", "user_account.person_id 关联自然人；认证秘密未映射"),
    key("teacher_profile", "person_id", "teacher_profile.person_id 关联自然人"),
    key("person_campus_assignment", "id", "person_campus_assignment.person_id 关联自然人"),
    key("role_assignment", "id", "role_assignment.person_id 关联被授予人"),
    key("person_relationship", "id", "person_relationship.teacher_id/related_person_id 关联人员"),
    key("organization_unit", "id", "organization_unit.parent_id 表达组织层级"),
    key("venue", "id", "venue.owner_person_id 关联场地所有人"),
    key("venue_permission_grant", "id", "venue_permission_grant.venue_id 关联场地"),
    key("settlement_account", "id", "settlement_account.owner_id 按 owner_type 关联业务主体"),
  ]), Object.freeze([
    source("person", "id", "人员ID", "person.id 为表1自然人主键"),
    source("person", "nickname", "教师昵称", "由 person.id 关联，昵称更正历史另列 RAW 缺口"),
    source("person", "status", "人员状态", "由 person.id 关联"),
    source("user_account", "login_status", "登录状态", "user_account.person_id 关联 person.id；不导出密码或认证版本"),
    source("teacher_profile", "business_identity", "业务身份", "teacher_profile.person_id 关联 person.id"),
    source("teacher_profile", "campus_id", "当前校区", "teacher_profile.person_id 关联 person.id"),
    source("person_campus_assignment", "valid_from", "校区归属生效日", "person_campus_assignment.person_id 与 campus_id 关联"),
    source("role_assignment", "subject_code", "职责角色", "role_assignment.person_id 关联 person.id"),
    source("person_relationship", "relationship_type", "人员关系类型", "teacher_id/related_person_id 均关联 person.id"),
    source("organization_unit", "parent_id", "组织上级", "organization_unit.id 与 parent_id 形成总部-分区-校区层级"),
    source("venue", "owner_person_id", "场地所有人", "venue.owner_person_id 关联 person.id"),
    source("venue_permission_grant", "can_withdraw", "场地提现授权", "venue_permission_grant.venue_id 与 grantee_person_id 分别关联场地和人员"),
    source("settlement_account", "account_code", "结算账户编号", "settlement_account.owner_type 与 owner_id 指向人员或业务主体"),
  ])),
  stored("business_table_2", "表2_业务流水", 2, Object.freeze([
    key("teacher_student_record", "id", "teacher_student_record.owner_teacher_id 关联老师"),
    key("referral_case", "id", "referral_case.teacher_student_record_id 关联独立学生记录"),
    key("referral_acceptance_snapshot", "referral_case_id", "referral_acceptance_snapshot.referral_case_id 关联推荐流水"),
    key("referral_acceptance_snapshot", "accepted_referral_version", "与 referral_case_id 共同按接收时推荐版本定位快照"),
    key("weekly_fee_entry", "id", "weekly_fee_entry.referral_case_id 关联推荐流水"),
    key("weekly_fee_entry_version", "id", "weekly_fee_entry_version.weekly_fee_entry_id 关联周费用"),
    key("weekly_fee_event", "id", "weekly_fee_event.weekly_fee_entry_id 关联周费用"),
    key("weekly_fee_refund_effect", "weekly_fee_entry_id", "weekly_fee_refund_effect 以周费用和财务单据共同定位退款"),
    key("teaching_week", "id", "teaching_week.academic_period_id 关联期间"),
    key("academic_period", "id", "academic_period.academic_year_plan_id 关联年度计划"),
  ]), Object.freeze([
    source("teacher_student_record", "display_name", "学生记录显示名", "teacher_student_record.id 是老师/课程下独立记录，不按同名合并"),
    source("referral_case", "referrer_person_id", "输出方人员ID", "referral_case.id 关联；人员ID 指向 person.id"),
    source("referral_case", "receiver_person_id", "接收方人员ID", "referral_case.id 关联；人员ID 指向 person.id"),
    source("referral_case", "status", "推荐业务状态", "referral_case.id 关联"),
    source("referral_acceptance_snapshot", "venue_id", "接收时场地ID", "referral_acceptance_snapshot.referral_case_id 关联 referral_case.id"),
    source("weekly_fee_entry", "gross_amount_cents", "周课时费原额", "weekly_fee_entry.referral_case_id 关联 referral_case.id"),
    source("weekly_fee_entry", "settlement_month", "结算月份", "weekly_fee_entry.teaching_week_id 关联 teaching_week.id"),
    source("weekly_fee_entry_version", "version", "课时费版本号", "weekly_fee_entry_version.weekly_fee_entry_id 关联周费用"),
    source("weekly_fee_event", "event_type", "周费用事件", "weekly_fee_event.weekly_fee_entry_id 关联周费用"),
    source("weekly_fee_refund_effect", "finance_document_id", "退款财务单据ID", "weekly_fee_refund_effect.weekly_fee_entry_id 关联周费用"),
    source("teaching_week", "settlement_month", "期间归属月", "teaching_week.academic_period_id 关联 academic_period.id"),
    source("academic_period", "label", "期间标签", "academic_period.id 关联 teaching_week.academic_period_id"),
  ])),
  derived("business_table_3", "表3_月度收入", 3, Object.freeze([
    key("weekly_fee_allocation_snapshot", "id", "分配快照按 weekly_fee_entry_id 关联周费用"),
    key("weekly_fee_refund_effect", "weekly_fee_entry_id", "退款效果关联原周费用和分配快照"),
    key("ledger_entry", "id", "ledger_entry.event_id 关联 ledger_event.id"),
    key("settlement_calculation_run", "id", "计算运行按 fee_entry_id 与 fee_version 关联周费用版本"),
  ]), Object.freeze([
    source("weekly_fee_allocation_snapshot", "weekly_fee_entry_id", "分配来源周费用ID", "关联 weekly_fee_entry.id；尚未按月聚合"),
    source("weekly_fee_allocation_snapshot", "net_monthly_cents", "快照净月额", "关联 weekly_fee_entry_id；仅存储事实，不生成表3汇总"),
    source("weekly_fee_allocation_snapshot", "policy_version_id", "采用费率版本ID", "关联 rate_policy_version.id"),
    source("weekly_fee_refund_effect", "allocation_snapshot_id", "退款对应分配快照", "关联 weekly_fee_allocation_snapshot.id"),
    source("ledger_entry", "amount_cents", "账本金额", "ledger_entry.event_id 关联 ledger_event.id；尚未聚合"),
    source("settlement_calculation_run", "status", "结算计算状态", "fee_entry_id 与 fee_version 对应周费用版本"),
  ])),
  stored("business_table_4", "表4_财务单据", 4, Object.freeze([
    key("finance_document", "id", "所有财务业务单据的稳定主键"),
    key("finance_document_event", "id", "finance_document_event.finance_document_id 关联单据"),
    key("finance_withdrawal_submission", "finance_document_id", "提现提交按 finance_document_id 关联单据"),
    key("finance_withdrawal_transfer", "finance_document_id", "提现外部转账事实按 finance_document_id 关联单据"),
    key("finance_withdrawal_reversal", "finance_document_id", "提现撤回按 finance_document_id 关联单据"),
    key("finance_reimbursement_submission", "finance_document_id", "报销提交按 finance_document_id 关联单据"),
    key("finance_reimbursement_decision", "finance_document_id", "报销审批按 finance_document_id 关联单据"),
    key("finance_self_purchase_transfer", "finance_document_id", "自采买转账按 finance_document_id 关联单据"),
    key("finance_self_purchase_reversal", "finance_document_id", "自采买冲回按 finance_document_id 关联单据"),
    key("finance_refund_submission", "finance_document_id", "退款提交按 finance_document_id 关联单据"),
    key("finance_refund_decision", "finance_document_id", "退款审批按 finance_document_id 关联单据"),
    key("finance_attachment", "id", "附件关联 finance_document_id"),
    key("finance_attachment_version", "id", "附件版本关联 finance_attachment.id"),
  ]), Object.freeze([
    source("finance_document", "kind", "单据类型", "finance_document.id 为各类单据主键"),
    source("finance_document", "status", "单据状态", "finance_document.id 为各类单据主键"),
    source("finance_document_event", "event_type", "单据事件", "finance_document_event.finance_document_id 关联单据"),
    source("finance_withdrawal_submission", "source_account_id", "提现来源账户", "finance_document_id 关联提现单据；完整银行卡密文不作为来源列"),
    source("finance_withdrawal_submission", "amount_cents", "提现金额", "finance_document_id 关联提现单据"),
    source("finance_withdrawal_transfer", "transferred_at", "提现办理时间", "finance_document_id 关联提现单据；不宣称外部到账"),
    source("finance_withdrawal_reversal", "reversal_ledger_event_id", "提现返豆账本事件", "finance_document_id 关联提现单据"),
    source("finance_reimbursement_submission", "amount_cents", "报销申请金额", "finance_document_id 关联报销单据"),
    source("finance_reimbursement_decision", "decision", "报销审批结果", "finance_document_id 关联报销单据"),
    source("finance_self_purchase_transfer", "processing_mode", "自采买处理模式", "finance_document_id 关联自采买单据"),
    source("finance_self_purchase_reversal", "reversal_ledger_event_id", "自采买冲回账本事件", "finance_document_id 关联自采买单据"),
    source("finance_refund_decision", "posting_status", "退款入账状态", "finance_document_id 关联退款单据"),
    source("finance_attachment_version", "status", "附件版本状态", "finance_attachment_version.finance_attachment_id 关联附件"),
  ])),
  stored("business_table_5", "表5_工资奖金", 5, Object.freeze([
    key("finance_document", "id", "财务单据以 id 关联工资确认、奖金和冲回事实"),
    key("cash_wage_plan_version", "id", "工资计划版本按 teacher_person_id 和 salary_month 关联"),
    key("cash_wage_todo", "id", "工资待办按 plan_version_id 关联计划"),
    key("cash_wage_confirmation", "finance_document_id", "工资确认由 finance_document_id 定位"),
    key("project_bonus_transfer", "finance_document_id", "奖金划拨由 finance_document_id 定位"),
    key("bonus_project_name_version", "id", "项目名称版本按 project_no 关联奖金"),
    key("salary_benefit_reversal", "reversal_finance_document_id", "工资/福利冲回关联原财务单据和账本事件"),
    key("ledger_entry", "id", "账本分录按 event_id 关联账本事件"),
  ]), Object.freeze([
    source("finance_document", "id", "财务单据ID", "完整关联单据事实来源；工资/奖金/冲回通过各业务表 finance_document_id 关联，不筛选或汇总为工资支出"),
    source("finance_document", "applicant_person_id", "单据申请人ID", "完整关联单据事实来源；由业务单据ID关联，不声称全部行属于工资或奖金"),
    source("finance_document", "kind", "单据类型", "完整关联单据事实来源；由业务单据ID关联，不筛选或聚合"),
    source("finance_document", "status", "单据状态", "完整关联单据事实来源；由业务单据ID关联，不筛选或聚合"),
    source("finance_document", "version", "单据版本", "完整关联单据事实来源；由业务单据ID关联，不筛选或聚合"),
    source("finance_document", "created_at", "单据创建时间", "完整关联单据事实来源；由业务单据ID关联，不筛选或聚合"),
    source("finance_document", "updated_at", "单据更新时间", "完整关联单据事实来源；由业务单据ID关联，不筛选或聚合"),
    source("cash_wage_plan_version", "teacher_person_id", "工资计划教师ID", "cash_wage_plan_version.id 为计划版本键，teacher_person_id 关联 person.id"),
    source("cash_wage_plan_version", "salary_month", "工资计划月份", "teacher_person_id、salary_month 与 version_no 定位计划事实"),
    source("cash_wage_plan_version", "version_no", "工资计划版本号", "teacher_person_id、salary_month 与 version_no 定位计划事实"),
    source("cash_wage_plan_version", "planned_cash_cents", "工资计划现金金额", "teacher_person_id 与 salary_month 定位计划版本"),
    source("cash_wage_plan_version", "planned_deduction_cents", "工资计划扣豆金额", "teacher_person_id 与 salary_month 定位计划版本"),
    source("cash_wage_plan_version", "active", "工资计划启用状态", "cash_wage_plan_version.id 为计划版本键"),
    source("cash_wage_plan_version", "changed_by_person_id", "工资计划变更人ID", "cash_wage_plan_version.id 为计划版本键，人员ID关联 person.id"),
    source("cash_wage_plan_version", "changed_at", "工资计划变更时间", "cash_wage_plan_version.id 为计划版本键"),
    source("cash_wage_plan_version", "reason", "工资计划变更原因", "cash_wage_plan_version.id 为计划版本键"),
    source("cash_wage_plan_version", "applies_to_future_months", "工资计划适用未来月份标记", "cash_wage_plan_version.id 为计划版本键"),
    source("cash_wage_todo", "teacher_person_id", "工资待办教师ID", "cash_wage_todo.plan_version_id 关联工资计划版本"),
    source("cash_wage_todo", "salary_month", "工资待办月份", "cash_wage_todo.plan_version_id 关联工资计划版本"),
    source("cash_wage_todo", "plan_version_id", "工资待办采用计划版本ID", "关联 cash_wage_plan_version.id"),
    source("cash_wage_todo", "generated_at", "工资待办生成时间", "cash_wage_todo.plan_version_id 关联工资计划版本"),
    source("cash_wage_confirmation", "finance_document_id", "工资确认单据ID", "关联 finance_document.id；todo_id 关联工资待办"),
    source("cash_wage_confirmation", "todo_id", "工资确认待办ID", "关联 cash_wage_todo.id"),
    source("cash_wage_confirmation", "teacher_person_id", "工资确认教师ID", "关联 person.id"),
    source("cash_wage_confirmation", "destination_account_id", "工资确认目标账户ID", "关联 settlement_account.id"),
    source("cash_wage_confirmation", "salary_month", "工资确认月份", "finance_document_id 定位确认事实"),
    source("cash_wage_confirmation", "cash_paid_cents", "确认现金实发金额", "cash_wage_confirmation.todo_id 关联工资待办"),
    source("cash_wage_confirmation", "deduction_cents", "确认个人扣豆金额", "cash_wage_confirmation.destination_account_id 关联教师个人账户"),
    source("cash_wage_confirmation", "paid_at", "工资现金支付时间", "finance_document_id 定位确认事实"),
    source("cash_wage_confirmation", "reason", "工资确认原因", "finance_document_id 定位确认事实"),
    source("cash_wage_confirmation", "ledger_event_id", "工资确认账本事件ID", "关联 ledger_event.id"),
    source("cash_wage_confirmation", "confirmed_by_person_id", "工资确认办理人ID", "关联 person.id"),
    source("cash_wage_confirmation", "created_at", "工资确认创建时间", "finance_document_id 定位确认事实"),
    source("cash_wage_confirmation", "correction_of_finance_document_id", "工资更正原单据ID", "关联被更正的 finance_document.id；空值原样保留"),
    source("cash_wage_confirmation", "destination_before_cents", "工资确认前目标账户余额", "finance_document_id 定位确认事实"),
    source("cash_wage_confirmation", "destination_after_cents", "工资确认后目标账户余额", "finance_document_id 定位确认事实"),
    source("project_bonus_transfer", "finance_document_id", "奖金单据ID", "关联 finance_document.id"),
    source("project_bonus_transfer", "project_no", "奖金项目编号", "与 project_name、project_name_version_id 共同关联奖金名称版本"),
    source("project_bonus_transfer", "project_name", "奖金项目名称快照", "与 project_no、project_name_version_id 共同关联奖金名称版本"),
    source("project_bonus_transfer", "recipient_person_id", "奖金领取人ID", "关联 person.id"),
    source("project_bonus_transfer", "destination_account_id", "奖金目标账户ID", "关联 settlement_account.id"),
    source("project_bonus_transfer", "source_fund_id", "奖金来源资金ID", "关联 company_finance_fund.id"),
    source("project_bonus_transfer", "source_account_id", "奖金来源账户ID", "关联 settlement_account.id"),
    source("project_bonus_transfer", "amount_cents", "项目奖金划拨金额", "project_bonus_transfer 记录职务账户到个人账户的已执行事实"),
    source("project_bonus_transfer", "reason", "奖金发放原因", "finance_document_id 定位奖金事实"),
    source("project_bonus_transfer", "ledger_event_id", "奖金账本事件ID", "关联 ledger_event.id"),
    source("project_bonus_transfer", "granted_by_person_id", "奖金发放人ID", "关联 person.id"),
    source("project_bonus_transfer", "created_at", "奖金发放创建时间", "finance_document_id 定位奖金事实"),
    source("project_bonus_transfer", "project_name_version_id", "奖金项目名称版本ID", "关联 bonus_project_name_version.id，连同 project_no、project_name 保留实际版本关系"),
    source("bonus_project_name_version", "project_no", "项目名称版本项目编号", "bonus_project_name_version.id 为版本键；关联 project_bonus_transfer.project_no"),
    source("bonus_project_name_version", "version_no", "项目名称版本号", "bonus_project_name_version.id 为版本键"),
    source("bonus_project_name_version", "display_name", "项目名称", "bonus_project_name_version.project_no 关联项目1-10名称版本"),
    source("bonus_project_name_version", "changed_by_person_id", "项目名称变更人ID", "人员ID关联 person.id；迁移默认可为空并原样保留"),
    source("bonus_project_name_version", "actor_subject_code", "项目名称变更职责", "bonus_project_name_version.id 为版本键；迁移默认可为空并原样保留"),
    source("bonus_project_name_version", "actor_scope_type", "项目名称变更范围", "bonus_project_name_version.id 为版本键；迁移默认可为空并原样保留"),
    source("bonus_project_name_version", "change_source", "项目名称变更来源", "bonus_project_name_version.id 为版本键"),
    source("bonus_project_name_version", "reason", "项目名称变更原因", "bonus_project_name_version.id 为版本键"),
    source("bonus_project_name_version", "created_at", "项目名称版本创建时间", "bonus_project_name_version.id 为版本键"),
    source("salary_benefit_reversal", "reversal_finance_document_id", "冲回单据ID", "关联 finance_document.id；与 original_finance_document_id 组成原冲回链"),
    source("salary_benefit_reversal", "original_finance_document_id", "原工资或福利单据ID", "关联 finance_document.id；与 reversal_finance_document_id 组成原冲回链"),
    source("salary_benefit_reversal", "original_ledger_event_id", "工资或福利原账本事件", "关联 ledger_event.id"),
    source("salary_benefit_reversal", "reversal_ledger_event_id", "工资或福利冲回账本事件", "关联 ledger_event.id"),
    source("salary_benefit_reversal", "reversed_by_person_id", "冲回办理人ID", "关联 person.id"),
    source("salary_benefit_reversal", "reason", "冲回原因", "reversal_finance_document_id 定位冲回事实"),
    source("salary_benefit_reversal", "created_at", "冲回创建时间", "reversal_finance_document_id 定位冲回事实"),
    source("ledger_entry", "event_id", "账本事件ID", "完整关联账本事实来源；可能含非工资/奖金分录，不筛选或聚合"),
    source("ledger_entry", "account_id", "账务账户ID", "完整关联账本事实来源；可能含非工资/奖金分录，不筛选或聚合"),
    source("ledger_entry", "category_key", "账务类别", "完整关联账本事实来源；可能含非工资/奖金分录，不筛选或聚合"),
    source("ledger_entry", "amount_cents", "相关账本金额", "完整关联账本事实来源；可能含非工资/奖金分录，不筛选或聚合"),
    source("ledger_entry", "created_at", "账本分录创建时间", "完整关联账本事实来源；可能含非工资/奖金分录，不筛选或聚合"),
  ])),
  stored("business_table_6", "表6_扣费", 6, Object.freeze([
    key("finance_benefit_plan_version", "id", "福利计划版本按 beneficiary_person_id 与 benefit_month 关联"),
    key("finance_benefit_todo", "id", "福利待办按 plan_version_id 关联计划"),
    key("finance_benefit_execution", "finance_document_id", "福利执行由 finance_document_id 定位"),
  ]), Object.freeze([
    source("finance_benefit_plan_version", "benefit_kind", "扣费类型", "beneficiary_person_id 与 benefit_month 定位福利计划"),
    source("finance_benefit_plan_version", "amount_cents", "计划扣费金额", "beneficiary_person_id 与 benefit_month 定位福利计划"),
    source("finance_benefit_plan_version", "execution_day", "计划执行日", "beneficiary_person_id 与 benefit_month 定位福利计划"),
    source("finance_benefit_todo", "generated_at", "扣费待办生成时间", "finance_benefit_todo.plan_version_id 关联福利计划版本"),
    source("finance_benefit_execution", "source_account_id", "财务支出账户", "finance_document_id 定位福利执行单据"),
    source("finance_benefit_execution", "amount_cents", "实际执行扣费金额", "finance_document_id 定位福利执行单据"),
  ])),
  derived("business_table_7", "表7_费用结算", 7, Object.freeze([
    key("account_balance_projection", "account_id", "账户余额投影按 account_id 定位"),
    key("ledger_entry", "id", "账本分录按 event_id 关联账本事件"),
    key("ledger_event", "id", "账本事件为分录事实来源"),
  ]), Object.freeze([
    source("account_balance_projection", "balance_cents", "当前账户余额投影", "account_balance_projection.account_id 关联 settlement_account.id；不生成结算快照"),
    source("account_balance_projection", "updated_at", "余额投影更新时间", "account_balance_projection.account_id 关联 settlement_account.id"),
    source("ledger_entry", "account_id", "账务账户ID", "ledger_entry.event_id 关联 ledger_event.id"),
    source("ledger_entry", "category_key", "账务类别", "ledger_entry.event_id 关联 ledger_event.id"),
    source("ledger_entry", "amount_cents", "账务金额", "ledger_entry.event_id 关联 ledger_event.id；尚未聚合"),
    source("ledger_event", "event_type", "账务事件类型", "ledger_event.id 关联 ledger_entry.event_id"),
  ])),
  stored("business_table_8", "表8_绩效配置", 8, Object.freeze([
    key("rate_policy_version", "id", "费率策略版本稳定主键"),
    key("weekly_fee_allocation_snapshot", "id", "逐笔分配快照按 weekly_fee_entry_id 关联周费用"),
  ]), Object.freeze([
    source("rate_policy_version", "version", "费率策略版本号", "rate_policy_version.id 为全局策略版本主键"),
    source("rate_policy_version", "effective_from", "费率生效时间", "rate_policy_version.id 为全局策略版本主键"),
    source("rate_policy_version", "policy_json", "全局费率策略内容", "转换后白名单字段；不把它冒充个别教师覆盖配置"),
    source("rate_policy_version", "published_by", "费率发布人", "rate_policy_version.id 为全局策略版本主键"),
    source("weekly_fee_allocation_snapshot", "policy_version_id", "逐笔采用策略版本", "关联 rate_policy_version.id"),
    source("weekly_fee_allocation_snapshot", "context_json", "逐笔实际比例上下文", "转换后白名单字段；关联 weekly_fee_entry_id 的实际分配上下文"),
    source("weekly_fee_allocation_snapshot", "snapshot_json", "逐笔分配快照", "转换后白名单字段；关联 weekly_fee_entry_id 的分配结果事实"),
  ])),
]);

export const BUSINESS_BACKUP_COVERAGE_GAPS: readonly BusinessCoverageGap[] = Object.freeze([
  Object.freeze({ code: "TEACHER_PROFILE_HISTORY_NOT_IMPLEMENTED", tableNumbers: Object.freeze([1]), description: "教师资料没有独立历史版本模型，不能导出完整资料变更历史。" }),
  Object.freeze({ code: "PER_TEACHER_RATE_OVERRIDE_NOT_IMPLEMENTED", tableNumbers: Object.freeze([8]), description: "尚无按接收方教师保存的费率覆盖模型，不能将全局策略冒充个别配置。" }),
  Object.freeze({ code: "CLASS_TYPE_RATE_CONFIG_NOT_IMPLEMENTED", tableNumbers: Object.freeze([8]), description: "尚无班型费率配置模型，不能从全局策略或逐笔快照反推完整配置。" }),
  Object.freeze({ code: "PROJECT_DEDUCTION_1_TO_10_NOT_IMPLEMENTED", tableNumbers: Object.freeze([6]), description: "项目1至10个人扣费尚无存储模型，不能复用奖金名称或奖金划拨数据。" }),
  Object.freeze({ code: "REIMBURSEMENT_TRANSFER_BUSINESS_MAPPING_PENDING", tableNumbers: Object.freeze([4]), description: "同财年报销划拨已有原始事实模型，尚未纳入表4业务来源映射及工作簿；跨财年归属仍待定。" }),
  Object.freeze({ code: "EXTERNAL_PAYMENT_WORKFLOW_NOT_IMPLEMENTED", tableNumbers: Object.freeze([4]), description: "对外付款工作流尚未建模，不能提现记录替代。" }),
  Object.freeze({ code: "SETTLEMENT_PUBLISHED_SNAPSHOTS_NOT_IMPLEMENTED", tableNumbers: Object.freeze([3, 7]), description: "月度收入和费用结算尚无已发布汇总快照模型，不能由分录即时聚合冒充。" }),
  Object.freeze({ code: "RELATIONSHIP_CHANGE_PREVIEW_BATCH_NOT_IMPLEMENTED", tableNumbers: Object.freeze([1, 4]), description: "关系变更的预览范围与发布批次尚无独立模型，不能由当前关系或分配快照倒推。" }),
]);

const expectedIdentities = new Map<number, Readonly<{ sheetId: string; title: string; mode: BusinessBackupSheetMode }>>([
  [1, { sheetId: "business_table_1", title: "表1_教师信息", mode: "STORED_FACTS" }],
  [2, { sheetId: "business_table_2", title: "表2_业务流水", mode: "STORED_FACTS" }],
  [3, { sheetId: "business_table_3", title: "表3_月度收入", mode: "DERIVED_REQUIRED" }],
  [4, { sheetId: "business_table_4", title: "表4_财务单据", mode: "STORED_FACTS" }],
  [5, { sheetId: "business_table_5", title: "表5_工资奖金", mode: "STORED_FACTS" }],
  [6, { sheetId: "business_table_6", title: "表6_扣费", mode: "STORED_FACTS" }],
  [7, { sheetId: "business_table_7", title: "表7_费用结算", mode: "DERIVED_REQUIRED" }],
  [8, { sheetId: "business_table_8", title: "表8_绩效配置", mode: "STORED_FACTS" }],
]);

const outputColumnsByTable = new Map(EXPORT_SCHEMA_REGISTRY.map((table) => [table.name, new Set(fullBackupOutputColumns(table.name))]));
const registryByTable = new Map(EXPORT_SCHEMA_REGISTRY.map((table) => [table.name, table]));
const secretSourceColumns = new Set(EXPORT_SCHEMA_REGISTRY.flatMap((table) =>
  table.columns.filter((column) => column.disposition === "SECRET_EXCLUDED").map((column) => `${table.name}.${column.name}`),
));

const outputKeyColumns = (sourceTable: string): readonly string[] => {
  const table = registryByTable.get(sourceTable);
  const outputColumns = outputColumnsByTable.get(sourceTable);
  if (table === undefined || outputColumns === undefined) throw new Error("BUSINESS_SCHEMA_REGISTRY_KEY_OUTPUT_GAP");
  return table.orderBy.map((column) => {
    if (outputColumns.has(column)) return column;
    const fingerprintColumn = `${column}_fingerprint`;
    if (outputColumns.has(fingerprintColumn)) return fingerprintColumn;
    throw new Error("BUSINESS_SCHEMA_REGISTRY_KEY_OUTPUT_GAP");
  });
};

const validateSourceReference = (reference: BusinessBackupSourceReference, errorPrefix: string): void => {
  if (!reference.sourceTable || !reference.sourceColumn || !reference.relationKeyDescription.trim())
    throw new Error("BUSINESS_SCHEMA_INVALID_SOURCE_REFERENCE");
  const sourceKey = `${reference.sourceTable}.${reference.sourceColumn}`;
  if (secretSourceColumns.has(sourceKey)) throw new Error("BUSINESS_SCHEMA_SECRET_SOURCE_COLUMN");
  const columns = outputColumnsByTable.get(reference.sourceTable);
  if (columns === undefined || !columns.has(reference.sourceColumn))
    throw new Error(`${errorPrefix}_UNKNOWN_SOURCE_COLUMN`);
};

/**
 * Validates only the fixed audit mapping.  It accepts a candidate solely for
 * negative tests and tooling checks; no export path accepts caller-provided
 * sheets, so it cannot widen the source allow-list.
 */
export const validateBusinessBackupSheets = (sheets: readonly BusinessBackupSheet[]): void => {
  if (sheets.length !== expectedIdentities.size) throw new Error("BUSINESS_SCHEMA_SHEET_COUNT");
  const seenSheetIds = new Set<string>();
  const seenTableNumbers = new Set<number>();
  for (const sheet of sheets) {
    const identity = expectedIdentities.get(sheet.tableNumber);
    if (identity === undefined || seenTableNumbers.has(sheet.tableNumber)) throw new Error("BUSINESS_SCHEMA_DUPLICATE_TABLE_NUMBER");
    seenTableNumbers.add(sheet.tableNumber);
    const normalizedSheetId = sheet.sheetId.toLocaleLowerCase("en-US");
    if (seenSheetIds.has(normalizedSheetId)) throw new Error("BUSINESS_SCHEMA_DUPLICATE_SHEET");
    seenSheetIds.add(normalizedSheetId);
    if (sheet.sheetId !== identity.sheetId || sheet.title !== identity.title || sheet.mode !== identity.mode)
      throw new Error("BUSINESS_SCHEMA_FIXED_SHEET_IDENTITY_REQUIRED");
    const expectedRowModel: BusinessBackupRowModel = sheet.mode === "STORED_FACTS" ? "SOURCE_ROWS_ONLY" : "DERIVED_NOT_GENERATED";
    if (sheet.rowModel !== expectedRowModel) throw new Error("BUSINESS_SCHEMA_ROW_MODEL_REQUIRED");
    if (sheet.rowKeyColumns.length === 0 || sheet.columns.length === 0) throw new Error("BUSINESS_SCHEMA_EMPTY_SHEET");
    const rowKeyTables = new Set<string>();
    const rowKeyReferences = new Set<string>();
    for (const rowKey of sheet.rowKeyColumns) {
      validateSourceReference(rowKey, "BUSINESS_SCHEMA_ROW_KEY");
      const keyId = `${rowKey.sourceTable}.${rowKey.sourceColumn}`;
      if (rowKeyReferences.has(keyId)) throw new Error("BUSINESS_SCHEMA_DUPLICATE_ROW_KEY");
      rowKeyReferences.add(keyId);
      rowKeyTables.add(rowKey.sourceTable);
    }
    const sourceColumns = new Set<string>();
    const sourceTables = new Set<string>();
    for (const column of sheet.columns) {
      if (!column.label.trim()) throw new Error("BUSINESS_SCHEMA_INVALID_COLUMN_LABEL");
      validateSourceReference(column, "BUSINESS_SCHEMA");
      const sourceId = `${column.sourceTable}.${column.sourceColumn}`;
      if (sourceColumns.has(sourceId)) throw new Error("BUSINESS_SCHEMA_DUPLICATE_SOURCE_COLUMN");
      sourceColumns.add(sourceId);
      sourceTables.add(column.sourceTable);
    }
    for (const sourceTable of sourceTables) {
      if (!rowKeyTables.has(sourceTable)) throw new Error("BUSINESS_SCHEMA_SOURCE_ROW_KEY_REQUIRED");
    }
    for (const sourceTable of rowKeyTables) {
      const expectedKeys = outputKeyColumns(sourceTable);
      const actualKeys = sheet.rowKeyColumns
        .filter((rowKey) => rowKey.sourceTable === sourceTable)
        .map((rowKey) => rowKey.sourceColumn);
      if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys))
        throw new Error("BUSINESS_SCHEMA_ROW_KEY_ORDER_REQUIRED");
    }
    // A candidate may be inspected by tooling, but this contract is not an
    // extension point.  Existing raw output columns cannot be added to a
    // business sheet without changing this reviewed fixed mapping.
    const fixedSheet = BUSINESS_BACKUP_SHEETS.find((candidate) => candidate.tableNumber === sheet.tableNumber)!;
    if (
      JSON.stringify(sheet.rowKeyColumns) !== JSON.stringify(fixedSheet.rowKeyColumns) ||
      JSON.stringify(sheet.columns) !== JSON.stringify(fixedSheet.columns)
    ) throw new Error("BUSINESS_SCHEMA_FIXED_COLUMN_SET_REQUIRED");
  }
  if (seenTableNumbers.size !== expectedIdentities.size) throw new Error("BUSINESS_SCHEMA_TABLE_NUMBER_GAP");
};

export const createFullBackupBusinessSchema = (): FullBackupBusinessSchema => {
  validateBusinessBackupSheets(BUSINESS_BACKUP_SHEETS);
  return Object.freeze({
    schemaVersion: FULL_BACKUP_BUSINESS_SCHEMA_VERSION,
    mode: "BUSINESS_SCHEMA_ONLY",
    complete: false,
    sheets: BUSINESS_BACKUP_SHEETS,
    rawCoverageGaps: FULL_BACKUP_KNOWN_COVERAGE_GAPS,
    businessCoverageGaps: BUSINESS_BACKUP_COVERAGE_GAPS,
  });
};
