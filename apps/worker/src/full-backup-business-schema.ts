import { EXPORT_SCHEMA_REGISTRY } from "./export-schema-registry.js";
import { FULL_BACKUP_KNOWN_COVERAGE_GAPS } from "./full-backup-layout.js";
import { fullBackupOutputColumns } from "./full-backup-transformer.js";

/**
 * This is an audit mapping for the eight product-facing business tables.  It
 * deliberately does not assemble rows, join source tables, or calculate
 * amounts.  Raw-source workbooks remain the authoritative stored-fact export.
 */
export const FULL_BACKUP_BUSINESS_SCHEMA_VERSION = "full-backup-business-schema.v8";

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
    key("person_profile_change", "id", "不可变人员资料更正历史主键"),
    key("teacher_profile_identity_change", "id", "不可变业务身份更正历史主键"),
    key("organization_unit", "id", "organization_unit.parent_id 表达组织层级"),
    key("venue", "id", "venue.owner_person_id 关联场地所有人"),
    key("venue_permission_grant", "id", "venue_permission_grant.venue_id 关联场地"),
    key("settlement_account", "id", "settlement_account.owner_id 按 owner_type 关联业务主体"),
    key("person_relationship_change_preview", "id", "教研组长普通周变更预览主键"),
    key("person_relationship_change", "id", "教研组长普通周发布批次主键"),
    key("person_relationship_change_effect", "change_id", "发布批次与周费用共同定位迁移影响"),
    key("person_relationship_change_effect", "weekly_fee_entry_id", "发布批次与周费用共同定位迁移影响"),
    key("planning_mentor_relationship_change_preview", "id", "规划导师关系变更预览主键"),
    key("planning_mentor_relationship_change", "id", "规划导师关系变更发布批次主键"),
    key("planning_mentor_relationship_change_effect", "change_id", "规划导师批次与周费用共同定位迁移影响"),
    key("planning_mentor_relationship_change_effect", "weekly_fee_entry_id", "规划导师批次与周费用共同定位迁移影响"),
    key("teaching_mentor_relationship_change_preview", "id", "教学导师普通周变更预览主键"),
    key("teaching_mentor_relationship_change", "id", "教学导师普通周发布批次主键"),
    key("teaching_mentor_relationship_change_effect", "change_id", "教学导师批次与周费用共同定位迁移影响"),
    key("teaching_mentor_relationship_change_effect", "weekly_fee_entry_id", "教学导师批次与周费用共同定位迁移影响"),
  ]), Object.freeze([
    source("person", "id", "人员ID", "person.id 为表1自然人主键"),
    source("person", "nickname", "教师昵称", "由 person.id 关联，当前展示值"),
    source("person", "legal_name", "真实姓名", "由 person.id 关联，当前展示值"),
    source("person", "profile_version", "资料版本", "资料更正的乐观并发版本"),
    source("person_profile_change", "before_nickname", "更正前昵称", "不可变资料更正历史"),
    source("person_profile_change", "audit_event_id", "关联审计事件", "人员资料更正历史与 PERSON_PROFILE_CHANGED 审计的一对一关联"),
    source("person_profile_change", "after_nickname", "更正后昵称", "不可变资料更正历史"),
    source("person_profile_change", "before_legal_name", "更正前真实姓名", "不可变资料更正历史"),
    source("person_profile_change", "after_legal_name", "更正后真实姓名", "不可变资料更正历史"),
    source("person_profile_change", "actor_person_id", "更正操作者", "管理员操作人"),
    source("person_profile_change", "reason", "更正原因", "管理员填写原因"),
    source("person_profile_change", "changed_at", "更正时间", "可信服务端时间"),
    source("teacher_profile_identity_change", "before_business_identity", "业务身份变更前身份", "不可变业务身份历史"),
    source("teacher_profile_identity_change", "after_business_identity", "业务身份变更后身份", "不可变业务身份历史"),
    source("teacher_profile_identity_change", "before_grade_subject", "业务身份变更前学科", "不可变业务身份历史"),
    source("teacher_profile_identity_change", "after_grade_subject", "业务身份变更后学科", "不可变业务身份历史"),
    source("teacher_profile_identity_change", "requested_grade_subject", "业务身份请求学科", "规范化请求参数历史"),
    source("teacher_profile_identity_change", "actor_person_id", "业务身份变更操作者", "管理员操作人"),
    source("teacher_profile_identity_change", "reason", "业务身份变更原因", "管理员填写原因"),
    source("teacher_profile_identity_change", "changed_at", "业务身份变更时间", "可信服务端时间"),
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
    source("person_relationship", "superseded_at", "同周版本替代时间", "被替代关系保留历史，新关系由批次关联"),
    source("person_relationship", "superseded_by_change_id", "同周替代批次", "关联 person_relationship_change.id"),
    source("person_relationship", "superseded_by_planning_mentor_change_id", "规划导师同周替代批次", "关联 planning_mentor_relationship_change.id"),
    source("person_relationship", "superseded_by_teaching_mentor_change_id", "教学导师同周替代批次", "关联 teaching_mentor_relationship_change.id"),
    source("planning_mentor_relationship_change_preview", "action", "规划导师关系操作", "ADD/REMOVE 操作事实"),
    source("planning_mentor_relationship_change_preview", "mentor_person_id", "规划导师ID", "关系变更操作人对应导师"),
    source("planning_mentor_relationship_change_preview", "planner_person_id", "规划师ID", "关系变更目标规划师"),
    source("planning_mentor_relationship_change_preview", "source_relationship_id", "原关系ID", "REMOVE 时关联原规划导师关系"),
    source("planning_mentor_relationship_change_preview", "result_relationship_id", "结果关系ID", "ADD 时关联新规划导师关系"),
    source("planning_mentor_relationship_change_preview", "actor_role_assignment_id", "导师任命ID", "操作时重新核验的 PLANNING_MENTOR 任命"),
    source("planning_mentor_relationship_change_preview", "effective_teaching_week_id", "生效教学周ID", "仅普通周关系边界"),
    source("planning_mentor_relationship_change_preview", "effective_at", "生效时间", "当周北京时间起点"),
    source("planning_mentor_relationship_change_preview", "next_boundary_at", "下一边界", "关系下一有效边界"),
    source("planning_mentor_relationship_change_preview", "reason", "变更原因", "操作人填写的原因"),
    source("planning_mentor_relationship_change_preview", "base_hash", "预览内容摘要", "发布前 stale 检查摘要"),
    source("planning_mentor_relationship_change_preview", "impact_json", "冻结预览影响", "严格 transform 的事实快照"),
    source("planning_mentor_relationship_change_preview", "created_by_person_id", "预览创建人", "规划导师本人"),
    source("planning_mentor_relationship_change_preview", "actor_subject_code", "操作职责", "固定 PLANNING_MENTOR"),
    source("planning_mentor_relationship_change_preview", "actor_scope_type", "授权范围", "固定 SELF"),
    source("planning_mentor_relationship_change_preview", "created_at", "创建时间", "预览创建时间"),
    source("planning_mentor_relationship_change", "id", "记录ID", "规划导师关系变更批次"),
    source("planning_mentor_relationship_change", "preview_id", "预览ID", "唯一关联已冻结预览"),
    source("planning_mentor_relationship_change", "action", "规划导师关系操作", "ADD/REMOVE 操作事实"),
    source("planning_mentor_relationship_change", "mentor_person_id", "规划导师ID", "关系变更导师"),
    source("planning_mentor_relationship_change", "planner_person_id", "规划师ID", "关系变更规划师"),
    source("planning_mentor_relationship_change", "relationship_version", "关系版本", "同一规划师关系版本"),
    source("planning_mentor_relationship_change", "source_relationship_id", "原关系ID", "REMOVE 时原关系"),
    source("planning_mentor_relationship_change", "result_relationship_id", "结果关系ID", "ADD 时结果关系"),
    source("planning_mentor_relationship_change", "actor_role_assignment_id", "导师任命ID", "发布时有效任命"),
    source("planning_mentor_relationship_change", "effective_teaching_week_id", "生效教学周ID", "普通周重算边界"),
    source("planning_mentor_relationship_change", "effective_at", "生效时间", "关系生效时间"),
    source("planning_mentor_relationship_change", "next_boundary_at", "下一边界", "关系下一边界"),
    source("planning_mentor_relationship_change", "reason", "变更原因", "发布原因"),
    source("planning_mentor_relationship_change", "idempotency_key_fingerprint", "请求幂等指纹", "只保留不可逆指纹"),
    source("planning_mentor_relationship_change", "request_hash", "请求内容摘要", "请求摘要"),
    source("planning_mentor_relationship_change", "base_hash", "预览内容摘要", "发布前事实摘要"),
    source("planning_mentor_relationship_change", "posting_status", "入账状态", "POSTED 或 NO_BALANCE_CHANGE"),
    source("planning_mentor_relationship_change", "settlement_calculation_run_id", "分配运行ID", "重算运行事实"),
    source("planning_mentor_relationship_change", "ledger_event_id", "账本事件ID", "差额账本事件"),
    source("planning_mentor_relationship_change", "considered_fee_count", "有效费用笔数", "范围内未退款费用"),
    source("planning_mentor_relationship_change", "changed_fee_count", "变化费用笔数", "实际快照发生变化的费用"),
    source("planning_mentor_relationship_change", "excluded_refund_count", "已退款排除笔数", "退款费用不重算"),
    source("planning_mentor_relationship_change", "planner_delta_cents", "规划师差额分", "规划师账户聚合差额"),
    source("planning_mentor_relationship_change", "mentor_delta_cents", "导师差额分", "导师账户聚合差额"),
    source("planning_mentor_relationship_change", "before_json", "原关系快照", "严格关系对象或 null"),
    source("planning_mentor_relationship_change", "after_json", "变更后关系快照", "严格关系对象或 null"),
    source("planning_mentor_relationship_change", "published_by_person_id", "发布人", "规划导师本人"),
    source("planning_mentor_relationship_change", "actor_subject_code", "操作职责", "固定 PLANNING_MENTOR"),
    source("planning_mentor_relationship_change", "actor_scope_type", "授权范围", "固定 SELF"),
    source("planning_mentor_relationship_change", "published_at", "发布时间", "发布事务时间"),
    source("planning_mentor_relationship_change", "created_at", "创建时间", "批次创建时间"),
    source("planning_mentor_relationship_change_effect", "change_id", "发布批次ID", "关联规划导师变更批次"),
    source("planning_mentor_relationship_change_effect", "weekly_fee_entry_id", "周费用ID", "受影响费用"),
    source("planning_mentor_relationship_change_effect", "source_weekly_fee_version", "原周费用版本", "重算来源版本"),
    source("planning_mentor_relationship_change_effect", "teaching_week_id", "教学周ID", "普通周范围"),
    source("planning_mentor_relationship_change_effect", "settlement_month", "业务结算月", "费用结算月"),
    source("planning_mentor_relationship_change_effect", "previous_snapshot_id", "原分配快照ID", "冻结前快照"),
    source("planning_mentor_relationship_change_effect", "result_snapshot_id", "新分配快照ID", "重算后快照"),
    source("planning_mentor_relationship_change_effect", "settlement_calculation_run_id", "分配运行ID", "重算运行事实"),
    source("planning_mentor_relationship_change_effect", "planner_before_cents", "规划师原份额分", "原快照规划师份额"),
    source("planning_mentor_relationship_change_effect", "planner_after_cents", "规划师新份额分", "新快照规划师份额"),
    source("planning_mentor_relationship_change_effect", "mentor_before_cents", "导师原份额分", "原快照导师份额"),
    source("planning_mentor_relationship_change_effect", "mentor_after_cents", "导师新份额分", "新快照导师份额"),
    source("planning_mentor_relationship_change_effect", "delta_json", "全量差额", "严格账户/分类差额事实"),
    source("planning_mentor_relationship_change_effect", "created_at", "创建时间", "效果记录创建时间"),
    source("teaching_mentor_relationship_change_preview", "id", "记录ID", "教学导师普通周变更的已冻结预览事实；按记录键关联，不重算或补造"),
    source("teaching_mentor_relationship_change_preview", "action", "关系操作", "ADD 为新增教学导师关系，REPLACE 为替代既有关系"),
    source("teaching_mentor_relationship_change_preview", "relationship_type", "关系类型", "固定 TEACHING_MENTOR"),
    source("teaching_mentor_relationship_change_preview", "teacher_person_id", "授课老师ID", "被调整教学导师关系的授课老师"),
    source("teaching_mentor_relationship_change_preview", "source_relationship_id", "原关系ID", "生效前教学导师关系"),
    source("teaching_mentor_relationship_change_preview", "source_related_person_id", "原教学导师ID", "生效前教学导师"),
    source("teaching_mentor_relationship_change_preview", "new_related_person_id", "新教学导师ID", "拟生效教学导师"),
    source("teaching_mentor_relationship_change_preview", "candidate_role_assignment_id", "新教学导师任命ID", "候选人的 TEACHING_MENTOR 任命"),
    source("teaching_mentor_relationship_change_preview", "effective_teaching_week_id", "生效教学周ID", "仅普通周关系边界"),
    source("teaching_mentor_relationship_change_preview", "effective_through_teaching_week_id", "生效截止教学周ID", "可空；指定时关系在该普通周结束后恢复原教学导师"),
    source("teaching_mentor_relationship_change_preview", "effective_at", "生效时间", "当周北京时间起点"),
    source("teaching_mentor_relationship_change_preview", "next_boundary_at", "下一关系边界", "后续既有关系的开始时间；为空表示持续有效"),
    source("teaching_mentor_relationship_change_preview", "reason", "变更原因", "管理员填写原因"),
    source("teaching_mentor_relationship_change_preview", "base_hash", "预览内容摘要", "发布前 stale 检查摘要"),
    source("teaching_mentor_relationship_change_preview", "impact_json", "冻结预览影响", "严格白名单转换的费用和账户影响事实"),
    source("teaching_mentor_relationship_change_preview", "created_by_person_id", "预览创建人", "SYSTEM_OWNER 或 SYSTEM_ADMIN"),
    source("teaching_mentor_relationship_change_preview", "actor_subject_code", "操作职责", "固定 SYSTEM_OWNER 或 SYSTEM_ADMIN"),
    source("teaching_mentor_relationship_change_preview", "actor_scope_type", "授权范围", "固定 GLOBAL"),
    source("teaching_mentor_relationship_change_preview", "created_at", "创建时间", "预览创建时间"),
    source("teaching_mentor_relationship_change", "id", "记录ID", "教学导师普通周变更发布批次"),
    source("teaching_mentor_relationship_change", "preview_id", "预览ID", "唯一关联已冻结预览"),
    source("teaching_mentor_relationship_change", "action", "关系操作", "ADD 为新增教学导师关系，REPLACE 为替代既有关系"),
    source("teaching_mentor_relationship_change", "relationship_type", "关系类型", "固定 TEACHING_MENTOR"),
    source("teaching_mentor_relationship_change", "teacher_person_id", "授课老师ID", "被调整教学导师关系的授课老师"),
    source("teaching_mentor_relationship_change", "relationship_version", "关系变更版本", "同一授课老师教学导师关系版本"),
    source("teaching_mentor_relationship_change", "source_relationship_id", "原关系ID", "生效前教学导师关系"),
    source("teaching_mentor_relationship_change", "result_relationship_id", "新关系ID", "生效后的教学导师关系"),
    source("teaching_mentor_relationship_change", "continuation_relationship_id", "续接关系ID", "可空；有截止周时原教学导师恢复后的续接关系"),
    source("teaching_mentor_relationship_change", "source_related_person_id", "原教学导师ID", "生效前教学导师"),
    source("teaching_mentor_relationship_change", "new_related_person_id", "新教学导师ID", "生效后的教学导师"),
    source("teaching_mentor_relationship_change", "candidate_role_assignment_id", "新教学导师任命ID", "发布时重新核验的有效任命"),
    source("teaching_mentor_relationship_change", "effective_teaching_week_id", "生效教学周ID", "普通周重算边界"),
    source("teaching_mentor_relationship_change", "effective_through_teaching_week_id", "生效截止教学周ID", "可空；指定时关系在该普通周结束后恢复原教学导师"),
    source("teaching_mentor_relationship_change", "effective_at", "生效时间", "关系生效时间"),
    source("teaching_mentor_relationship_change", "next_boundary_at", "下一关系边界", "后续既有关系的开始时间；为空表示持续有效"),
    source("teaching_mentor_relationship_change", "reason", "变更原因", "发布原因"),
    source("teaching_mentor_relationship_change", "idempotency_key_fingerprint", "请求幂等指纹", "只保留不可逆指纹"),
    source("teaching_mentor_relationship_change", "request_hash", "请求内容摘要", "请求摘要"),
    source("teaching_mentor_relationship_change", "base_hash", "预览内容摘要", "发布前事实摘要"),
    source("teaching_mentor_relationship_change", "posting_status", "入账状态", "POSTED 或 NO_BALANCE_CHANGE"),
    source("teaching_mentor_relationship_change", "settlement_calculation_run_id", "分配运行ID", "重算运行事实；无余额变化时为空"),
    source("teaching_mentor_relationship_change", "ledger_event_id", "账本事件ID", "教学导师份额迁移账本事件；无余额变化时为空"),
    source("teaching_mentor_relationship_change", "considered_fee_count", "有效费用笔数", "范围内未退款费用"),
    source("teaching_mentor_relationship_change", "moved_fee_count", "迁移费用笔数", "教学导师份额实际迁移的费用"),
    source("teaching_mentor_relationship_change", "excluded_refund_count", "已退款排除笔数", "退款费用不重算"),
    source("teaching_mentor_relationship_change", "moved_amount_cents", "迁移金额分", "教学导师份额迁移总额"),
    source("teaching_mentor_relationship_change", "before_json", "原关系快照", "严格白名单转换的发布前关系事实"),
    source("teaching_mentor_relationship_change", "after_json", "变更后关系快照", "严格白名单转换的原关系和结果关系事实"),
    source("teaching_mentor_relationship_change", "published_by_person_id", "发布人", "SYSTEM_OWNER 或 SYSTEM_ADMIN"),
    source("teaching_mentor_relationship_change", "actor_subject_code", "操作职责", "固定 SYSTEM_OWNER 或 SYSTEM_ADMIN"),
    source("teaching_mentor_relationship_change", "actor_scope_type", "授权范围", "固定 GLOBAL"),
    source("teaching_mentor_relationship_change", "published_at", "发布时间", "发布事务时间"),
    source("teaching_mentor_relationship_change", "created_at", "创建时间", "批次创建时间"),
    source("teaching_mentor_relationship_change_effect", "change_id", "发布批次ID", "关联教学导师变更批次"),
    source("teaching_mentor_relationship_change_effect", "weekly_fee_entry_id", "周费用ID", "受影响费用"),
    source("teaching_mentor_relationship_change_effect", "source_weekly_fee_version", "原周费用版本", "重算来源版本"),
    source("teaching_mentor_relationship_change_effect", "teaching_week_id", "教学周ID", "普通周范围"),
    source("teaching_mentor_relationship_change_effect", "settlement_month", "业务结算月", "费用结算月"),
    source("teaching_mentor_relationship_change_effect", "previous_snapshot_id", "原分配快照ID", "冻结前快照"),
    source("teaching_mentor_relationship_change_effect", "result_snapshot_id", "新分配快照ID", "重算后快照"),
    source("teaching_mentor_relationship_change_effect", "settlement_calculation_run_id", "分配运行ID", "重算运行事实"),
    source("teaching_mentor_relationship_change_effect", "teaching_mentor_amount_cents", "原教学导师份额分", "原快照教学导师份额"),
    source("teaching_mentor_relationship_change_effect", "source_account_id", "原教学导师账户ID", "原教学导师个人结算账户"),
    source("teaching_mentor_relationship_change_effect", "destination_account_id", "新教学导师账户ID", "新教学导师个人结算账户"),
    source("teaching_mentor_relationship_change_effect", "created_at", "创建时间", "效果记录创建时间"),
    source("person_relationship_change_preview", "id", "记录ID", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_preview", "relationship_type", "关系类型", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_preview", "teacher_person_id", "授课老师ID", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_preview", "source_relationship_id", "原关系ID", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_preview", "source_related_person_id", "原组长ID", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_preview", "new_related_person_id", "新组长ID", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_preview", "candidate_role_assignment_id", "新组长任命ID", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_preview", "effective_teaching_week_id", "生效教学周ID", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_preview", "effective_at", "生效时间", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_preview", "next_boundary_at", "下一关系边界", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_preview", "reason", "原因", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_preview", "base_hash", "预览内容摘要", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_preview", "impact_json", "冻结预览影响", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_preview", "created_by_person_id", "预览创建人", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_preview", "actor_subject_code", "操作职责", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_preview", "actor_scope_type", "授权范围", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_preview", "created_at", "创建时间", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "id", "记录ID", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "preview_id", "预览ID", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "relationship_type", "关系类型", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "teacher_person_id", "授课老师ID", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "relationship_version", "关系变更版本", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "source_relationship_id", "原关系ID", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "result_relationship_id", "新关系ID", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "source_related_person_id", "原组长ID", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "new_related_person_id", "新组长ID", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "candidate_role_assignment_id", "新组长任命ID", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "effective_teaching_week_id", "生效教学周ID", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "effective_at", "生效时间", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "next_boundary_at", "下一关系边界", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "reason", "原因", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "idempotency_key_fingerprint", "请求幂等指纹", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "request_hash", "请求内容摘要", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "base_hash", "预览内容摘要", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "posting_status", "入账状态", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "settlement_calculation_run_id", "分配运行ID", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "ledger_event_id", "账本事件ID", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "considered_fee_count", "有效费用笔数", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "moved_fee_count", "迁移费用笔数", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "excluded_refund_count", "已退款排除笔数", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "moved_amount_cents", "迁移金额分", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "before_json", "原关系快照", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "after_json", "变更后关系快照", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "published_by_person_id", "发布人", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "actor_subject_code", "操作职责", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "actor_scope_type", "授权范围", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "published_at", "发布时间", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change", "created_at", "创建时间", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_effect", "change_id", "发布批次ID", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_effect", "weekly_fee_entry_id", "周费用ID", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_effect", "source_weekly_fee_version", "原周费用版本", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_effect", "teaching_week_id", "教学周ID", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_effect", "settlement_month", "业务结算月", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_effect", "previous_snapshot_id", "原分配快照ID", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_effect", "result_snapshot_id", "新分配快照ID", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_effect", "settlement_calculation_run_id", "分配运行ID", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_effect", "group_leader_amount_cents", "原组长份额分", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_effect", "source_account_id", "原组长账户ID", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_effect", "destination_account_id", "新组长账户ID", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
    source("person_relationship_change_effect", "created_at", "创建时间", "普通周教研组长变更的已存事实；按记录键关联，不重算或补造"),
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
    key("finance_reimbursement_submission", "finance_document_id", "普通报销提交按 finance_document_id 关联单据"),
    key("finance_reimbursement_decision", "finance_document_id", "普通报销审批按 finance_document_id 关联单据"),
    key("finance_reimbursement_attachment_binding", "finance_document_id", "普通报销附件绑定的复合键第1项，关联单据"),
    key("finance_reimbursement_attachment_binding", "stage", "普通报销附件绑定的复合键第2项，区分提交阶段"),
    key("finance_reimbursement_attachment_binding", "finance_attachment_version_id", "普通报销附件绑定的复合键第3项，关联附件版本"),
    key("finance_reimbursement_command_idempotency", "actor_person_id", "普通报销命令封口的复合键第1项，关联办理人员"),
    key("finance_reimbursement_command_idempotency", "operation", "普通报销命令封口的复合键第2项"),
    key("finance_reimbursement_command_idempotency", "idempotency_key_fingerprint", "普通报销命令封口的复合键第3项，仅保留原始幂等键指纹"),
    key("finance_reimbursement_reversal", "finance_document_id", "普通报销原笔撤销关联原划拨与单据"),
    key("finance_reimbursement_transfer", "finance_document_id", "同财年普通报销实际划拨按 finance_document_id 关联单据"),
    key("finance_self_purchase_transfer", "finance_document_id", "自采买转账按 finance_document_id 关联单据"),
    key("finance_self_purchase_reversal", "finance_document_id", "自采买冲回按 finance_document_id 关联单据"),
    key("finance_refund_submission", "finance_document_id", "退款提交按 finance_document_id 关联单据"),
    key("finance_refund_decision", "finance_document_id", "退款审批按 finance_document_id 关联单据"),
    key("finance_attachment", "id", "附件关联 finance_document_id"),
    key("finance_attachment_version", "id", "附件版本关联 finance_attachment.id"),
  ]), Object.freeze([
    source("finance_document", "id", "单据ID", "完整关联单据事实来源；由业务单据ID关联，不筛选或汇总为普通报销"),
    source("finance_document", "applicant_person_id", "单据申请人ID", "完整关联单据事实来源；由业务单据ID关联，不声称全部行属于普通报销"),
    source("finance_document", "kind", "单据类型", "完整关联单据事实来源；由业务单据ID关联，不筛选或汇总为普通报销"),
    source("finance_document", "status", "单据状态", "完整关联单据事实来源；由业务单据ID关联，不筛选或汇总为普通报销"),
    source("finance_document", "version", "单据版本", "完整关联单据事实来源；由业务单据ID关联，不筛选或汇总为普通报销"),
    source("finance_document", "created_at", "单据创建时间", "完整关联单据事实来源；由业务单据ID关联，不筛选或汇总为普通报销"),
    source("finance_document", "updated_at", "单据更新时间", "完整关联单据事实来源；由业务单据ID关联，不筛选或汇总为普通报销"),
    source("finance_document_event", "id", "单据事件ID", "完整关联单据事件事实来源；finance_document_id 关联单据，不筛选或聚合"),
    source("finance_document_event", "finance_document_id", "事件单据ID", "完整关联单据事件事实来源；关联 finance_document.id，不筛选或聚合"),
    source("finance_document_event", "event_type", "单据事件类型", "完整关联单据事件事实来源；finance_document_id 关联单据，不筛选或聚合"),
    source("finance_document_event", "actor_person_id", "事件办理人ID", "完整关联单据事件事实来源；关联 person.id，不筛选或聚合"),
    source("finance_document_event", "result_document_version", "事件结果单据版本", "完整关联单据事件事实来源；关联 finance_document.version，不筛选或聚合"),
    source("finance_document_event", "created_at", "事件发生时间", "完整关联单据事件事实来源；finance_document_id 关联单据，不筛选或聚合"),
    source("finance_document_event", "ledger_event_id", "事件账本ID", "完整关联单据事件事实来源；关联 ledger_event.id，不筛选或聚合"),
    source("finance_document_event", "details_json", "事件业务详情", "转换后白名单字段；完整关联单据事件事实来源，不筛选或聚合"),
    source("finance_withdrawal_submission", "source_account_id", "提现来源账户", "finance_document_id 关联提现单据；完整银行卡密文不作为来源列"),
    source("finance_withdrawal_submission", "amount_cents", "提现金额", "finance_document_id 关联提现单据"),
    source("finance_withdrawal_transfer", "transferred_at", "提现办理时间", "finance_document_id 关联提现单据；不宣称外部到账"),
    source("finance_withdrawal_reversal", "reversal_ledger_event_id", "提现返豆账本事件", "finance_document_id 关联提现单据"),
    source("finance_reimbursement_submission", "finance_document_id", "普通报销申请单据ID", "普通报销提交事实；关联 finance_document.id"),
    source("finance_reimbursement_submission", "source_document_version", "报销申请来源单据版本", "普通报销提交事实；与 result_document_version 形成版本链"),
    source("finance_reimbursement_submission", "result_document_version", "报销申请结果单据版本", "普通报销提交事实；与 source_document_version 形成版本链"),
    source("finance_reimbursement_submission", "destination_account_id", "报销申请收款账户ID", "普通报销提交事实；关联 settlement_account.id"),
    source("finance_reimbursement_submission", "amount_cents", "报销申请金额", "普通报销提交事实；关联 finance_document_id"),
    source("finance_reimbursement_submission", "reason", "报销申请原因", "普通报销提交事实；关联 finance_document_id"),
    source("finance_reimbursement_submission", "submitted_by_person_id", "报销申请提交人ID", "普通报销提交事实；关联 person.id"),
    source("finance_reimbursement_submission", "submitted_at", "报销申请提交时间", "普通报销提交事实；关联 finance_document_id"),
    source("finance_reimbursement_submission", "created_at", "报销申请创建时间", "普通报销提交事实；关联 finance_document_id"),
    source("finance_reimbursement_submission", "applicant_context_snapshot", "报销申请人权限快照", "转换后白名单字段；普通报销提交时的申请人上下文"),
    source("finance_reimbursement_decision", "finance_document_id", "普通报销审批单据ID", "普通报销审批事实；关联 finance_document.id"),
    source("finance_reimbursement_decision", "source_document_version", "报销审批来源单据版本", "普通报销审批事实；关联提交结果版本"),
    source("finance_reimbursement_decision", "result_document_version", "报销审批结果单据版本", "普通报销审批事实；关联 finance_document.version"),
    source("finance_reimbursement_decision", "decision", "报销审批结果", "普通报销审批事实；关联 finance_document_id"),
    source("finance_reimbursement_decision", "reason", "报销审批原因", "普通报销审批事实；关联 finance_document_id"),
    source("finance_reimbursement_decision", "decided_by_person_id", "报销审批人ID", "普通报销审批事实；关联 person.id"),
    source("finance_reimbursement_decision", "actor_subject_code", "审批职责角色", "普通报销审批事实；关联审批人职责"),
    source("finance_reimbursement_decision", "actor_scope_type", "审批职责范围", "普通报销审批事实；关联审批人职责"),
    source("finance_reimbursement_decision", "decided_at", "报销审批时间", "普通报销审批事实；关联 finance_document_id"),
    source("finance_reimbursement_decision", "created_at", "报销审批创建时间", "普通报销审批事实；关联 finance_document_id"),
    source("finance_reimbursement_decision", "authorization_snapshot", "报销审批授权快照", "转换后白名单字段；普通报销审批时的授权上下文"),
    source("finance_reimbursement_attachment_binding", "finance_document_id", "报销附件绑定单据ID", "普通报销附件绑定事实；复合键关联 finance_document.id"),
    source("finance_reimbursement_attachment_binding", "stage", "报销附件绑定阶段", "普通报销附件绑定事实；复合键区分申请阶段"),
    source("finance_reimbursement_attachment_binding", "purpose", "报销附件用途", "普通报销附件绑定事实；关联附件用途"),
    source("finance_reimbursement_attachment_binding", "finance_attachment_version_id", "报销附件版本ID", "普通报销附件绑定事实；复合键关联 finance_attachment_version.id"),
    source("finance_reimbursement_attachment_binding", "document_version", "报销附件绑定单据版本", "普通报销附件绑定事实；关联申请结果版本"),
    source("finance_reimbursement_attachment_binding", "bound_by_person_id", "报销附件绑定人ID", "普通报销附件绑定事实；关联 person.id"),
    source("finance_reimbursement_attachment_binding", "bound_at", "报销附件绑定时间", "普通报销附件绑定事实；关联 finance_document_id"),
    source("finance_reimbursement_attachment_binding", "created_at", "报销附件绑定创建时间", "普通报销附件绑定事实；关联 finance_document_id"),
    source("finance_reimbursement_command_idempotency", "actor_person_id", "报销命令办理人ID", "普通报销命令封口事实；复合键关联 person.id"),
    source("finance_reimbursement_command_idempotency", "operation", "报销命令操作", "普通报销命令封口事实；复合键区分提交、审批、拒绝、执行与撤销"),
    source("finance_reimbursement_command_idempotency", "request_hash", "报销命令请求摘要", "普通报销命令封口事实；关联操作、单据和结果版本"),
    source("finance_reimbursement_command_idempotency", "finance_document_id", "报销命令单据ID", "普通报销命令封口事实；关联 finance_document.id"),
    source("finance_reimbursement_command_idempotency", "result_status", "报销命令结果状态", "普通报销命令封口事实；关联操作与单据版本"),
    source("finance_reimbursement_command_idempotency", "result_document_version", "报销命令结果单据版本", "普通报销命令封口事实；关联 finance_document.version"),
    source("finance_reimbursement_command_idempotency", "created_at", "报销命令封口时间", "普通报销命令封口事实；关联 finance_document_id"),
    source("finance_reimbursement_command_idempotency", "idempotency_key_fingerprint", "报销命令幂等键指纹", "普通报销命令封口事实；仅导出原始幂等键指纹"),
    source("finance_reimbursement_reversal", "finance_document_id", "报销撤销单据ID", "普通报销原笔撤销事实；按原单据与账户关联，余额允许为负；不聚合或删除原划拨"),
    source("finance_reimbursement_reversal", "source_document_version", "报销撤销来源版本", "普通报销原笔撤销事实；按原单据与账户关联，余额允许为负；不聚合或删除原划拨"),
    source("finance_reimbursement_reversal", "result_document_version", "报销撤销结果版本", "普通报销原笔撤销事实；按原单据与账户关联，余额允许为负；不聚合或删除原划拨"),
    source("finance_reimbursement_reversal", "source_account_id", "报销撤销原支出账户ID", "普通报销原笔撤销事实；按原单据与账户关联，余额允许为负；不聚合或删除原划拨"),
    source("finance_reimbursement_reversal", "destination_account_id", "报销撤销原收款账户ID", "普通报销原笔撤销事实；按原单据与账户关联，余额允许为负；不聚合或删除原划拨"),
    source("finance_reimbursement_reversal", "amount_cents", "报销撤销金额", "普通报销原笔撤销事实；按原单据与账户关联，余额允许为负；不聚合或删除原划拨"),
    source("finance_reimbursement_reversal", "original_ledger_event_id", "报销原划拨账本事件ID", "普通报销原笔撤销事实；按原单据与账户关联，余额允许为负；不聚合或删除原划拨"),
    source("finance_reimbursement_reversal", "reversal_ledger_event_id", "报销撤销账本事件ID", "普通报销原笔撤销事实；按原单据与账户关联，余额允许为负；不聚合或删除原划拨"),
    source("finance_reimbursement_reversal", "reason", "报销撤销原因", "普通报销原笔撤销事实；按原单据与账户关联，余额允许为负；不聚合或删除原划拨"),
    source("finance_reimbursement_reversal", "reversed_by_person_id", "报销撤销办理人ID", "普通报销原笔撤销事实；按原单据与账户关联，余额允许为负；不聚合或删除原划拨"),
    source("finance_reimbursement_reversal", "actor_subject_code", "报销撤销办理人身份", "普通报销原笔撤销事实；按原单据与账户关联，余额允许为负；不聚合或删除原划拨"),
    source("finance_reimbursement_reversal", "actor_scope_type", "报销撤销办理人范围", "普通报销原笔撤销事实；按原单据与账户关联，余额允许为负；不聚合或删除原划拨"),
    source("finance_reimbursement_reversal", "authorization_snapshot", "报销撤销授权快照", "转换后白名单字段；保留原划拨授权和撤销办理授权"),
    source("finance_reimbursement_reversal", "reversed_at", "报销撤销时间", "普通报销原笔撤销事实；按原单据与账户关联，余额允许为负；不聚合或删除原划拨"),
    source("finance_reimbursement_reversal", "created_at", "报销撤销记录创建时间", "普通报销原笔撤销事实；按原单据与账户关联，余额允许为负；不聚合或删除原划拨"),
    source("finance_reimbursement_reversal", "source_before_cents", "报销撤销前支出账户余额", "普通报销原笔撤销事实；按原单据与账户关联，余额允许为负；不聚合或删除原划拨"),
    source("finance_reimbursement_reversal", "source_after_cents", "报销撤销后支出账户余额", "普通报销原笔撤销事实；按原单据与账户关联，余额允许为负；不聚合或删除原划拨"),
    source("finance_reimbursement_reversal", "destination_before_cents", "报销撤销前收款账户余额", "普通报销原笔撤销事实；按原单据与账户关联，余额允许为负；不聚合或删除原划拨"),
    source("finance_reimbursement_reversal", "destination_after_cents", "报销撤销后收款账户余额", "普通报销原笔撤销事实；按原单据与账户关联，余额允许为负；不聚合或删除原划拨"),
    source("finance_reimbursement_transfer", "finance_document_id", "报销划拨单据ID", "同财年普通报销实际划拨事实；关联 finance_document.id，按独立事实行导出，不生成汇总"),
    source("finance_reimbursement_transfer", "source_document_version", "报销划拨来源单据版本", "同财年普通报销实际划拨事实；与 result_document_version 形成版本链"),
    source("finance_reimbursement_transfer", "result_document_version", "报销划拨结果单据版本", "同财年普通报销实际划拨事实；关联 finance_document.version"),
    source("finance_reimbursement_transfer", "role_assignment_id", "报销划拨财务角色ID", "同财年普通报销实际划拨事实；关联 role_assignment.id"),
    source("finance_reimbursement_transfer", "company_fund_assignment_id", "报销划拨资金授权ID", "同财年普通报销实际划拨事实；关联 company_finance_fund_assignment.id"),
    source("finance_reimbursement_transfer", "source_fund_id", "报销划拨来源资金ID", "同财年普通报销实际划拨事实；关联 company_finance_fund.id"),
    source("finance_reimbursement_transfer", "source_account_id", "报销划拨来源账户ID", "同财年普通报销实际划拨事实；关联 settlement_account.id"),
    source("finance_reimbursement_transfer", "destination_account_id", "报销划拨收款账户ID", "同财年普通报销实际划拨事实；关联 settlement_account.id"),
    source("finance_reimbursement_transfer", "amount_cents", "报销划拨金额", "同财年普通报销实际划拨事实；不按金额聚合"),
    source("finance_reimbursement_transfer", "reason", "报销划拨原因", "同财年普通报销实际划拨事实；关联 finance_document_id"),
    source("finance_reimbursement_transfer", "ledger_event_id", "报销划拨账本事件ID", "同财年普通报销实际划拨事实；关联 ledger_event.id"),
    source("finance_reimbursement_transfer", "executed_by_person_id", "报销划拨执行人ID", "同财年普通报销实际划拨事实；关联 person.id"),
    source("finance_reimbursement_transfer", "executed_at", "报销划拨执行时间", "同财年普通报销实际划拨事实；关联 finance_document_id"),
    source("finance_reimbursement_transfer", "created_at", "报销划拨创建时间", "同财年普通报销实际划拨事实；与 executed_at 为同一持久化事实"),
    source("finance_reimbursement_transfer", "source_before_cents", "报销划拨前来源账户余额", "同财年普通报销实际划拨事实；关联 source_account_id，不限制负余额"),
    source("finance_reimbursement_transfer", "source_after_cents", "报销划拨后来源账户余额", "同财年普通报销实际划拨事实；关联 source_account_id，可为负余额"),
    source("finance_reimbursement_transfer", "destination_before_cents", "报销划拨前收款账户余额", "同财年普通报销实际划拨事实；关联 destination_account_id"),
    source("finance_reimbursement_transfer", "destination_after_cents", "报销划拨后收款账户余额", "同财年普通报销实际划拨事实；关联 destination_account_id"),
    source("finance_reimbursement_transfer", "authorization_snapshot", "报销划拨执行授权快照", "转换后白名单字段；同财年普通报销实际划拨时的授权上下文"),
    source("finance_self_purchase_transfer", "processing_mode", "自采买处理模式", "finance_document_id 关联自采买单据"),
    source("finance_self_purchase_reversal", "reversal_ledger_event_id", "自采买冲回账本事件", "finance_document_id 关联自采买单据"),
    source("finance_refund_decision", "posting_status", "退款入账状态", "finance_document_id 关联退款单据"),
    source("finance_attachment", "id", "附件ID", "完整关联附件事实来源；关联 finance_document.id，不筛选或聚合"),
    source("finance_attachment", "finance_document_id", "附件单据ID", "完整关联附件事实来源；关联 finance_document.id，不筛选或聚合"),
    source("finance_attachment", "purpose", "附件用途", "完整关联附件事实来源；关联 finance_document.id，不筛选或聚合"),
    source("finance_attachment", "created_by_person_id", "附件创建人ID", "完整关联附件事实来源；关联 person.id，不筛选或聚合"),
    source("finance_attachment", "created_at", "附件创建时间", "完整关联附件事实来源；关联 finance_document.id，不筛选或聚合"),
    source("finance_attachment_version", "id", "附件版本ID", "完整关联附件版本事实来源；关联 finance_attachment.id，不筛选或聚合"),
    source("finance_attachment_version", "finance_attachment_id", "附件所属ID", "完整关联附件版本事实来源；关联 finance_attachment.id，不筛选或聚合"),
    source("finance_attachment_version", "version_no", "附件版本号", "完整关联附件版本事实来源；关联 finance_attachment.id，不筛选或聚合"),
    source("finance_attachment_version", "status", "附件版本状态", "完整关联附件版本事实来源；关联 finance_attachment.id，不筛选或聚合"),
    source("finance_attachment_version", "original_filename", "附件原始文件名", "完整关联附件版本事实来源；关联 finance_attachment.id，不筛选或聚合"),
    source("finance_attachment_version", "declared_media_type", "附件申报媒体类型", "完整关联附件版本事实来源；关联 finance_attachment.id，不筛选或聚合"),
    source("finance_attachment_version", "declared_size_bytes", "附件申报字节数", "完整关联附件版本事实来源；关联 finance_attachment.id，不筛选或聚合"),
    source("finance_attachment_version", "expected_sha256", "附件申报摘要", "完整关联附件版本事实来源；关联 finance_attachment.id，不筛选或聚合"),
    source("finance_attachment_version", "detected_media_type", "附件实测媒体类型", "完整关联附件版本事实来源；关联 finance_attachment.id，不筛选或聚合"),
    source("finance_attachment_version", "actual_size_bytes", "附件实测字节数", "完整关联附件版本事实来源；关联 finance_attachment.id，不筛选或聚合"),
    source("finance_attachment_version", "sha256", "附件实测摘要", "完整关联附件版本事实来源；关联 finance_attachment.id，不筛选或聚合"),
    source("finance_attachment_version", "failure_code", "附件失败代码", "完整关联附件版本事实来源；关联 finance_attachment.id，不筛选或聚合"),
    source("finance_attachment_version", "uploaded_by_person_id", "附件上传人ID", "完整关联附件版本事实来源；关联 person.id，不筛选或聚合"),
    source("finance_attachment_version", "created_at", "附件版本创建时间", "完整关联附件版本事实来源；关联 finance_attachment.id，不筛选或聚合"),
    source("finance_attachment_version", "ready_at", "附件就绪时间", "完整关联附件版本事实来源；关联 finance_attachment.id，不筛选或聚合"),
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
  Object.freeze({ code: "EXTERNAL_PAYMENT_WORKFLOW_NOT_IMPLEMENTED", tableNumbers: Object.freeze([4]), description: "对外付款工作流尚未建模，不能提现记录替代。" }),
  Object.freeze({ code: "SETTLEMENT_PUBLISHED_SNAPSHOTS_NOT_IMPLEMENTED", tableNumbers: Object.freeze([3, 7]), description: "月度收入和费用结算尚无已发布汇总快照模型，不能由分录即时聚合冒充。" }),
  Object.freeze({ code: "OTHER_RELATIONSHIP_CHANGE_WORKFLOWS_NOT_IMPLEMENTED", tableNumbers: Object.freeze([1, 4]), description: "仅普通周教研组长变更已有预览与发布批次；其他关系及特殊期间完整变更流程仍未实现，不能由当前关系或分配快照倒推。" }),
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
