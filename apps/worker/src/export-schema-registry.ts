export type ExportColumnDisposition = "EXPORT" | "TRANSFORM" | "SECRET_EXCLUDED";

export type ExportColumn = Readonly<{ name: string; disposition: ExportColumnDisposition }>;
export type ExportTable = Readonly<{
  name: string;
  columns: readonly ExportColumn[];
  /** Fixed primary-key order; never derive this from the live catalog. */
  orderBy: readonly string[];
}>;

const columns = (value: string): readonly string[] => value.split(",");

// This is intentionally a fixed allow-list generated from migrations 0001–0035.
// It is not a schema discovery mechanism: pg_catalog is checked against it at runtime.
const TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  academic_period: columns("id,academic_year_plan_id,label,starts_on,ends_on,created_at"),
  academic_year_plan: columns("id,label,starts_on,ends_on,timezone,created_by,created_at"),
  account_balance_projection: columns("account_id,balance_cents,updated_at"),
  auth_login_throttle: columns("dimension_type,dimension_key,window_started_at,failure_count,blocked_until,updated_at,created_at"),
  auth_password_reset_command: columns("actor_person_id,idempotency_key,target_account_id,reason,password_hash,result_auth_version,actor_subject_code,actor_scope_type,created_at"),
  background_task: columns("id,task_type,idempotency_key,payload,status,attempt_count,max_attempts,available_at,lease_token,lease_expires_at,last_failure_code,last_failure_reason,completed_at,created_at,updated_at"),
  background_task_attempt: columns("task_id,attempt_no,lease_token,claimed_at,lease_expires_at,finished_at,outcome,failure_code,failure_reason"),
  audit_event: columns("id,actor_person_id,action_code,subject_type,subject_id,before_json,after_json,reason,created_at"),
  bonus_project_catalog_command_idempotency: columns("actor_person_id,idempotency_key,operation,request_hash,result_json,created_at"),
  bonus_project_name_version: columns("id,project_no,version_no,display_name,changed_by_person_id,actor_subject_code,actor_scope_type,change_source,reason,created_at"),
  bonus_project_slot: columns("project_no,created_at"),
  campus_region_assignment: columns("id,campus_id,region_id,valid_from,valid_to,created_by,created_at"),
  cash_wage_confirmation: columns("finance_document_id,todo_id,teacher_person_id,destination_account_id,salary_month,cash_paid_cents,deduction_cents,paid_at,reason,ledger_event_id,confirmed_by_person_id,created_at,correction_of_finance_document_id,destination_before_cents,destination_after_cents"),
  cash_wage_plan_version: columns("id,teacher_person_id,salary_month,version_no,planned_cash_cents,planned_deduction_cents,active,changed_by_person_id,changed_at,reason,applies_to_future_months"),
  cash_wage_todo: columns("id,teacher_person_id,salary_month,plan_version_id,generated_at"),
  company_finance_fund: columns("id,kind,fund_code,display_name,organization_unit_id,status,version,created_by_person_id,created_at,updated_at"),
  company_finance_fund_assignment: columns("id,fund_id,duty_subject,scope_type,scope_id,responsibility_code,valid_from,valid_to,created_by_person_id,created_at"),
  company_finance_fund_command_idempotency: columns("actor_person_id,idempotency_key,operation,request_hash,result_json,created_at"),
  finance_attachment: columns("id,finance_document_id,purpose,created_by_person_id,created_at"),
  finance_attachment_event: columns("id,finance_attachment_version_id,event_type,actor_person_id,result_version_no,created_at,error_code"),
  finance_attachment_reservation_idempotency: columns("actor_person_id,idempotency_key,request_hash,finance_attachment_id,finance_attachment_version_id,result_version_no,created_at"),
  finance_attachment_version: columns("id,finance_attachment_id,version_no,status,original_filename,declared_media_type,declared_size_bytes,expected_sha256,detected_media_type,actual_size_bytes,sha256,failure_code,uploaded_by_person_id,created_at,ready_at"),
  finance_benefit_execution: columns("finance_document_id,todo_id,plan_version_id,source_fund_id,source_account_id,amount_cents,ledger_event_id,executed_by_person_id,reason,created_at"),
  finance_benefit_plan_version: columns("id,benefit_kind,beneficiary_person_id,benefit_month,version_no,execution_day,amount_cents,source_fund_id,active,changed_by_person_id,changed_at,reason"),
  finance_benefit_todo: columns("id,plan_version_id,generated_at,benefit_kind,beneficiary_person_id,benefit_month"),
  finance_document: columns("id,applicant_person_id,kind,status,version,created_at,updated_at"),
  finance_document_event: columns("id,finance_document_id,event_type,actor_person_id,result_document_version,created_at,ledger_event_id,details_json"),
  finance_draft_idempotency: columns("actor_person_id,idempotency_key,request_hash,finance_document_id,result_document_version,created_at"),
  finance_refund_attachment_binding: columns("finance_document_id,stage,purpose,finance_attachment_version_id,document_version,bound_by_person_id,bound_at,created_at"),
  finance_refund_command_idempotency: columns("actor_person_id,operation,idempotency_key,request_hash,finance_document_id,result_status,result_document_version,created_at"),
  finance_refund_decision: columns("finance_document_id,source_document_version,result_document_version,decision,reason,decided_by_person_id,actor_subject_code,actor_scope_type,authorization_snapshot,decided_at,created_at,posting_status,ledger_event_id,approved_gross_amount_cents"),
  finance_refund_submission: columns("finance_document_id,referral_case_id,student_record_id,source_document_version,result_document_version,reason,applicant_context_snapshot,submitted_by_person_id,submitted_at,created_at"),
  finance_refund_submission_item: columns("finance_document_id,weekly_fee_entry_id,submitted_fee_version,submitted_gross_amount_cents,teaching_week_id,settlement_month"),
  finance_reimbursement_attachment_binding: columns("finance_document_id,stage,purpose,finance_attachment_version_id,document_version,bound_by_person_id,bound_at,created_at"),
  finance_reimbursement_command_idempotency: columns("actor_person_id,operation,idempotency_key,request_hash,finance_document_id,result_status,result_document_version,created_at"),
  finance_reimbursement_decision: columns("finance_document_id,source_document_version,result_document_version,decision,reason,decided_by_person_id,actor_subject_code,actor_scope_type,authorization_snapshot,decided_at,created_at"),
  finance_reimbursement_submission: columns("finance_document_id,source_document_version,result_document_version,destination_account_id,amount_cents,reason,applicant_context_snapshot,submitted_by_person_id,submitted_at,created_at"),
  finance_reimbursement_reversal: columns("finance_document_id,source_document_version,result_document_version,source_account_id,destination_account_id,amount_cents,original_ledger_event_id,reversal_ledger_event_id,reason,reversed_by_person_id,actor_subject_code,actor_scope_type,authorization_snapshot,reversed_at,created_at,source_before_cents,source_after_cents,destination_before_cents,destination_after_cents"),
  finance_reimbursement_transfer: columns("finance_document_id,source_document_version,result_document_version,role_assignment_id,company_fund_assignment_id,source_fund_id,source_account_id,destination_account_id,amount_cents,reason,authorization_snapshot,ledger_event_id,executed_by_person_id,executed_at,created_at,source_before_cents,source_after_cents,destination_before_cents,destination_after_cents"),
  finance_self_purchase_attachment_binding: columns("finance_document_id,finance_attachment_version_id,purpose,document_version,bound_by_person_id,bound_at,created_at"),
  finance_self_purchase_command_idempotency: columns("actor_person_id,operation,idempotency_key,request_hash,finance_document_id,result_status,result_document_version,created_at"),
  finance_self_purchase_reversal: columns("finance_document_id,source_document_version,result_document_version,source_account_id,destination_account_id,amount_cents,reason,reversal_ledger_event_id,reversed_by_person_id,actor_subject_code,actor_scope_type,authorization_snapshot,reversed_at,created_at,source_before_cents,source_after_cents,destination_before_cents,destination_after_cents"),
  finance_self_purchase_transfer: columns("finance_document_id,role_assignment_id,company_fund_assignment_id,source_fund_id,source_account_id,destination_person_id,destination_account_id,amount_cents,reason,authorization_snapshot,ledger_event_id,processing_mode,submitted_by_person_id,submitted_at,completed_at,created_at,source_before_cents,source_after_cents,destination_before_cents,destination_after_cents"),
  finance_withdrawal_attachment_binding: columns("finance_document_id,stage,purpose,finance_attachment_version_id,document_version,bound_by_person_id,bound_at,created_at"),
  finance_withdrawal_command_idempotency: columns("actor_person_id,operation,idempotency_key,request_hmac,hmac_key_id,finance_document_id,result_status,result_document_version,created_at"),
  finance_withdrawal_reversal: columns("finance_document_id,reversal_ledger_event_id,reason,revoked_by_person_id,revoked_at,created_at"),
  finance_withdrawal_submission: columns("finance_document_id,source_account_id,source_owner_type,source_owner_id,authorization_kind,authorization_grant_id,authorization_snapshot,amount_cents,recipient_key_id,recipient_nonce,recipient_ciphertext,recipient_auth_tag,bank_account_last4,debit_ledger_event_id,submitted_by_person_id,submitted_at,created_at"),
  finance_withdrawal_transfer: columns("finance_document_id,transferred_by_person_id,transferred_at,created_at"),
  ledger_entry: columns("id,event_id,account_id,category_key,amount_cents,created_at"),
  ledger_event: columns("id,event_key,event_type,payload_hash,created_at"),
  organization_unit: columns("id,unit_type,name,parent_id,created_at"),
  person: columns("id,nickname,legal_name,status,profile_version,created_at,updated_at"),
  person_profile_change: columns("id,audit_event_id,person_id,source_profile_version,result_profile_version,before_nickname,before_legal_name,after_nickname,after_legal_name,actor_person_id,actor_subject_code,reason,idempotency_key,changed_at,created_at"),
  teacher_profile_identity_change: columns("id,audit_event_id,person_id,source_business_identity_version,result_business_identity_version,before_business_identity,after_business_identity,before_grade_subject,after_grade_subject,before_role_assignment_id,result_role_assignment_id,before_auth_version,result_auth_version,actor_person_id,actor_subject_code,reason,requested_grade_subject,idempotency_key,changed_at,created_at"),
  person_campus_assignment: columns("id,person_id,campus_id,region_id,valid_from,valid_to,created_by,created_at"),
  person_responsibility_command: columns("actor_person_id,idempotency_key,command_kind,target_person_id,role_assignment_id,subject_code,scope_type,scope_id,valid_from,valid_to,next_person_status,reason,result_auth_version,actor_subject_code,created_at"),
  person_relationship: columns("id,teacher_id,relationship_type,related_person_id,valid_from,valid_to,effective_scope,created_by,created_at,superseded_at,superseded_by_change_id,superseded_by_planning_mentor_change_id"),
  planning_mentor_relationship_change: columns("id,preview_id,action,mentor_person_id,planner_person_id,relationship_version,source_relationship_id,result_relationship_id,actor_role_assignment_id,effective_teaching_week_id,effective_at,next_boundary_at,reason,idempotency_key,request_hash,base_hash,posting_status,settlement_calculation_run_id,ledger_event_id,considered_fee_count,changed_fee_count,excluded_refund_count,planner_delta_cents,mentor_delta_cents,before_json,after_json,published_by_person_id,actor_subject_code,actor_scope_type,published_at,created_at"),
  planning_mentor_relationship_change_effect: columns("change_id,weekly_fee_entry_id,source_weekly_fee_version,teaching_week_id,settlement_month,previous_snapshot_id,result_snapshot_id,settlement_calculation_run_id,planner_before_cents,planner_after_cents,mentor_before_cents,mentor_after_cents,delta_json,created_at"),
  planning_mentor_relationship_change_preview: columns("id,action,mentor_person_id,planner_person_id,source_relationship_id,result_relationship_id,actor_role_assignment_id,effective_teaching_week_id,effective_at,next_boundary_at,reason,base_hash,impact_json,created_by_person_id,actor_subject_code,actor_scope_type,created_at"),
  person_relationship_change: columns("id,preview_id,relationship_type,teacher_person_id,relationship_version,source_relationship_id,result_relationship_id,source_related_person_id,new_related_person_id,candidate_role_assignment_id,effective_teaching_week_id,effective_at,next_boundary_at,reason,idempotency_key,request_hash,base_hash,posting_status,settlement_calculation_run_id,ledger_event_id,considered_fee_count,moved_fee_count,excluded_refund_count,moved_amount_cents,before_json,after_json,published_by_person_id,actor_subject_code,actor_scope_type,published_at,created_at"),
  person_relationship_change_effect: columns("change_id,weekly_fee_entry_id,source_weekly_fee_version,teaching_week_id,settlement_month,previous_snapshot_id,result_snapshot_id,settlement_calculation_run_id,group_leader_amount_cents,source_account_id,destination_account_id,created_at"),
  person_relationship_change_preview: columns("id,relationship_type,teacher_person_id,source_relationship_id,source_related_person_id,new_related_person_id,candidate_role_assignment_id,effective_teaching_week_id,effective_at,next_boundary_at,reason,base_hash,impact_json,created_by_person_id,actor_subject_code,actor_scope_type,created_at"),
  project_bonus_transfer: columns("finance_document_id,project_no,project_name,recipient_person_id,destination_account_id,source_fund_id,source_account_id,amount_cents,reason,ledger_event_id,granted_by_person_id,created_at,project_name_version_id"),
  rate_policy_version: columns("id,version,effective_from,policy_json,reason,published_by,published_at"),
  referral_acceptance_idempotency: columns("actor_person_id,idempotency_key,request_hash,referral_case_id,created_at,accepted_referral_version"),
  referral_acceptance_snapshot: columns("referral_case_id,venue_id,venue_owner_person_id,is_self_use,selection_source,accepted_referral_version,accepted_by_person_id,accepted_at"),
  referral_case: columns("id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,unaccepted_expires_at,copied_from_referral_id,version,created_at,updated_at"),
  referral_case_event: columns("id,referral_case_id,event_type,actor_person_id,reason,created_at,actor_type,result_referral_version"),
  referral_creation_idempotency: columns("actor_person_id,idempotency_key,request_hash,referral_case_id,created_at"),
  referral_creation_snapshot: columns("referral_case_id,source_subject,business_identity_version,campus_assignment_id,campus_id,planning_mentor_relationship_id,class_type,collector_person_id,created_by,created_at"),
  referral_lifecycle_idempotency: columns("actor_person_id,idempotency_key,operation,request_hash,referral_case_id,result_status,result_referral_version,result_unaccepted_expires_at,created_at"),
  role_assignment: columns("id,person_id,subject_code,scope_type,scope_id,valid_from,valid_to,created_by,created_at,reason"),
  salary_benefit_attachment_binding: columns("finance_document_id,finance_attachment_version_id,purpose,document_version,bound_by_person_id,bound_at"),
  salary_benefit_command_idempotency: columns("actor_person_id,operation,idempotency_key,request_hash,result_json,created_at"),
  salary_benefit_reversal: columns("reversal_finance_document_id,original_finance_document_id,original_ledger_event_id,reversal_ledger_event_id,reversed_by_person_id,reason,created_at"),
  settlement_account: columns("id,owner_type,owner_id,account_code,status,created_at"),
  settlement_calculation_run: columns("id,request_key,fee_entry_id,fee_version,actor_person_id,status,ledger_event_id,created_at"),
  teacher_profile: columns("person_id,business_identity,region_id,campus_id,grade_subject,employment_status,created_at,updated_at,business_identity_version"),
  teacher_student_record: columns("id,owner_teacher_id,course_context_id,display_name,created_at,updated_at"),
  teaching_week: columns("id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month,created_at,status"),
  user_account: columns("id,person_id,phone_normalized,password_hash,login_status,created_at,updated_at,auth_version"),
  user_session: columns("id,token_hash,account_id,auth_version,current_subject,expires_at,created_at"),
  venue: columns("id,owner_person_id,name,status,default_for_owner,created_at,updated_at,version"),
  venue_command_idempotency: columns("actor_person_id,operation,idempotency_key,request_hash,venue_id,result_json,created_at"),
  venue_permission_grant: columns("id,venue_id,grantee_person_id,can_view,can_withdraw,valid_from,valid_to,granted_by,created_at,version"),
  weekly_fee_allocation_snapshot: columns("id,sequence_no,run_id,weekly_fee_entry_id,source_weekly_fee_version,policy_version_id,net_monthly_cents,snapshot_json,context_json,created_at"),
  weekly_fee_entry: columns("id,referral_case_id,teaching_week_id,settlement_month,gross_amount_cents,venue_id,venue_owner_person_id,is_self_use_snapshot,source_case_version,version,created_by,created_at,updated_at"),
  weekly_fee_entry_version: columns("id,weekly_fee_entry_id,referral_case_id,teaching_week_id,settlement_month,gross_amount_cents,venue_id,venue_owner_person_id,is_self_use_snapshot,source_case_version,version,recorded_by,recorded_at"),
  weekly_fee_event: columns("id,weekly_fee_entry_id,event_type,actor_person_id,reason,created_at"),
  weekly_fee_idempotency: columns("id,idempotency_key,request_hash,actor_person_id,referral_case_id,teaching_week_id,weekly_fee_entry_id,version,created_at"),
  weekly_fee_refund_effect: columns("weekly_fee_entry_id,finance_document_id,allocation_snapshot_id,source_weekly_fee_version,gross_amount_cents,snapshot_json,created_at")
};

// These are primary keys from migrations 0001–0035. Keeping them alongside the
// fixed column allow-list makes the stream order deterministic without trusting
// a possibly changed live index definition.
const TABLE_ORDER_KEYS: Readonly<Record<string, readonly string[]>> = {
  academic_period: ["id"], academic_year_plan: ["id"], account_balance_projection: ["account_id"], auth_login_throttle: ["dimension_type", "dimension_key"], auth_password_reset_command: ["actor_person_id", "idempotency_key"], audit_event: ["id"], background_task: ["id"], background_task_attempt: ["task_id", "attempt_no"],
  bonus_project_catalog_command_idempotency: ["actor_person_id", "idempotency_key"], bonus_project_name_version: ["id"], bonus_project_slot: ["project_no"], campus_region_assignment: ["id"],
  cash_wage_confirmation: ["finance_document_id"], cash_wage_plan_version: ["id"], cash_wage_todo: ["id"], company_finance_fund: ["id"],
  company_finance_fund_assignment: ["id"], company_finance_fund_command_idempotency: ["actor_person_id", "idempotency_key"], finance_attachment: ["id"], finance_attachment_event: ["id"],
  finance_attachment_reservation_idempotency: ["actor_person_id", "idempotency_key"], finance_attachment_version: ["id"], finance_benefit_execution: ["finance_document_id"], finance_benefit_plan_version: ["id"],
  finance_benefit_todo: ["id"], finance_document: ["id"], finance_document_event: ["id"], finance_draft_idempotency: ["actor_person_id", "idempotency_key"],
  finance_refund_attachment_binding: ["finance_document_id", "finance_attachment_version_id"], finance_refund_command_idempotency: ["actor_person_id", "operation", "idempotency_key"], finance_refund_decision: ["finance_document_id"], finance_refund_submission: ["finance_document_id"],
  finance_refund_submission_item: ["finance_document_id", "weekly_fee_entry_id"], finance_reimbursement_attachment_binding: ["finance_document_id", "stage", "finance_attachment_version_id"], finance_reimbursement_command_idempotency: ["actor_person_id", "operation", "idempotency_key"], finance_reimbursement_decision: ["finance_document_id"],
  finance_reimbursement_submission: ["finance_document_id"], finance_reimbursement_transfer: ["finance_document_id"], finance_reimbursement_reversal: ["finance_document_id"], finance_self_purchase_attachment_binding: ["finance_document_id", "finance_attachment_version_id"], finance_self_purchase_command_idempotency: ["actor_person_id", "operation", "idempotency_key"], finance_self_purchase_reversal: ["finance_document_id"],
  finance_self_purchase_transfer: ["finance_document_id"], finance_withdrawal_attachment_binding: ["finance_document_id", "stage", "finance_attachment_version_id"], finance_withdrawal_command_idempotency: ["actor_person_id", "operation", "idempotency_key"], finance_withdrawal_reversal: ["finance_document_id"],
  finance_withdrawal_submission: ["finance_document_id"], finance_withdrawal_transfer: ["finance_document_id"], ledger_entry: ["id"], ledger_event: ["id"], organization_unit: ["id"], person: ["id"],
  person_campus_assignment: ["id"], person_profile_change: ["id"], teacher_profile_identity_change: ["id"], person_responsibility_command: ["actor_person_id", "idempotency_key"], person_relationship: ["id"], person_relationship_change: ["id"], person_relationship_change_effect: ["change_id", "weekly_fee_entry_id"], person_relationship_change_preview: ["id"], planning_mentor_relationship_change: ["id"], planning_mentor_relationship_change_effect: ["change_id", "weekly_fee_entry_id"], planning_mentor_relationship_change_preview: ["id"], project_bonus_transfer: ["finance_document_id"], rate_policy_version: ["id"], referral_acceptance_idempotency: ["actor_person_id", "idempotency_key"],
  referral_acceptance_snapshot: ["referral_case_id", "accepted_referral_version"], referral_case: ["id"], referral_case_event: ["id"], referral_creation_idempotency: ["actor_person_id", "idempotency_key"], referral_creation_snapshot: ["referral_case_id"],
  referral_lifecycle_idempotency: ["actor_person_id", "idempotency_key"], role_assignment: ["id"], salary_benefit_attachment_binding: ["finance_document_id", "finance_attachment_version_id"], salary_benefit_command_idempotency: ["actor_person_id", "operation", "idempotency_key"], salary_benefit_reversal: ["reversal_finance_document_id"],
  settlement_account: ["id"], settlement_calculation_run: ["id"], teacher_profile: ["person_id"], teacher_student_record: ["id"], teaching_week: ["id"], user_account: ["id"],
  user_session: ["id"], venue: ["id"], venue_command_idempotency: ["actor_person_id", "operation", "idempotency_key"], venue_permission_grant: ["id"], weekly_fee_allocation_snapshot: ["id"],
  weekly_fee_entry: ["id"], weekly_fee_entry_version: ["id"], weekly_fee_event: ["id"], weekly_fee_idempotency: ["id"], weekly_fee_refund_effect: ["weekly_fee_entry_id"]
};

const SECRET_COLUMNS = new Set([
  "auth_login_throttle.dimension_type", "auth_login_throttle.dimension_key", "auth_login_throttle.window_started_at", "auth_login_throttle.failure_count", "auth_login_throttle.blocked_until", "auth_login_throttle.updated_at", "auth_login_throttle.created_at",
  "auth_password_reset_command.actor_person_id", "auth_password_reset_command.idempotency_key", "auth_password_reset_command.target_account_id", "auth_password_reset_command.reason", "auth_password_reset_command.password_hash", "auth_password_reset_command.result_auth_version", "auth_password_reset_command.actor_subject_code", "auth_password_reset_command.actor_scope_type", "auth_password_reset_command.created_at",
  "user_account.password_hash", "user_account.auth_version", "user_session.id", "user_session.token_hash", "user_session.account_id",
  "user_session.auth_version", "user_session.current_subject", "user_session.expires_at", "user_session.created_at",
  "finance_withdrawal_command_idempotency.request_hmac", "finance_withdrawal_command_idempotency.hmac_key_id"
]);
const TRANSFORM_COLUMNS = new Set([
  "person_relationship_change_preview.impact_json", "person_relationship_change.before_json", "person_relationship_change.after_json",
  "planning_mentor_relationship_change_preview.impact_json", "planning_mentor_relationship_change.before_json", "planning_mentor_relationship_change.after_json", "planning_mentor_relationship_change_effect.delta_json",
  "person_responsibility_command.idempotency_key", "person_profile_change.idempotency_key", "teacher_profile_identity_change.idempotency_key", "person_relationship_change.idempotency_key", "planning_mentor_relationship_change.idempotency_key",
  "audit_event.before_json", "audit_event.after_json", "finance_document_event.details_json",
  "finance_refund_decision.authorization_snapshot", "finance_refund_submission.applicant_context_snapshot",
  "finance_reimbursement_decision.authorization_snapshot", "finance_reimbursement_submission.applicant_context_snapshot",
  "finance_reimbursement_transfer.authorization_snapshot",
  "finance_reimbursement_reversal.authorization_snapshot",
  "finance_self_purchase_reversal.authorization_snapshot", "finance_self_purchase_transfer.authorization_snapshot",
  "finance_withdrawal_submission.authorization_snapshot", "weekly_fee_allocation_snapshot.snapshot_json", "weekly_fee_allocation_snapshot.context_json",
  "weekly_fee_refund_effect.snapshot_json", "rate_policy_version.policy_json",
  "settlement_calculation_run.request_key", "ledger_event.event_key",
  "finance_withdrawal_submission.recipient_key_id", "finance_withdrawal_submission.recipient_nonce",
  "finance_withdrawal_submission.recipient_ciphertext", "finance_withdrawal_submission.recipient_auth_tag",
  "bonus_project_catalog_command_idempotency.idempotency_key", "bonus_project_catalog_command_idempotency.result_json",
  "company_finance_fund_command_idempotency.idempotency_key", "company_finance_fund_command_idempotency.result_json",
  "finance_attachment_reservation_idempotency.idempotency_key", "finance_draft_idempotency.idempotency_key",
  "finance_refund_command_idempotency.idempotency_key", "finance_reimbursement_command_idempotency.idempotency_key",
  "finance_self_purchase_command_idempotency.idempotency_key", "finance_withdrawal_command_idempotency.idempotency_key",
  "referral_acceptance_idempotency.idempotency_key", "referral_creation_idempotency.idempotency_key",
  "referral_lifecycle_idempotency.idempotency_key", "salary_benefit_command_idempotency.idempotency_key",
  "salary_benefit_command_idempotency.result_json", "venue_command_idempotency.idempotency_key", "venue_command_idempotency.result_json",
  "weekly_fee_idempotency.idempotency_key"
]);

const dispositionFor = (table: string, column: string): ExportColumnDisposition => {
  const key = `${table}.${column}`;
  if (SECRET_COLUMNS.has(key)) return "SECRET_EXCLUDED";
  if (TRANSFORM_COLUMNS.has(key)) return "TRANSFORM";
  return "EXPORT";
};

const assertSecurityPolicyKeysAreRegistered = (): void => {
  for (const key of [...SECRET_COLUMNS, ...TRANSFORM_COLUMNS]) {
    const separator = key.indexOf(".");
    const tableName = key.slice(0, separator);
    const columnName = key.slice(separator + 1);
    if (separator <= 0 || !TABLE_COLUMNS[tableName]?.includes(columnName)) {
      throw new Error("EXPORT_SCHEMA_REGISTRY_INVALID");
    }
  }
  for (const [tableName, columnNames] of Object.entries(TABLE_COLUMNS)) {
    const orderBy = TABLE_ORDER_KEYS[tableName];
    if (orderBy === undefined || orderBy.length === 0 || orderBy.some((columnName) => !columnNames.includes(columnName))) {
      throw new Error("EXPORT_SCHEMA_REGISTRY_INVALID");
    }
  }
  if (Object.keys(TABLE_ORDER_KEYS).length !== Object.keys(TABLE_COLUMNS).length) {
    throw new Error("EXPORT_SCHEMA_REGISTRY_INVALID");
  }
};

assertSecurityPolicyKeysAreRegistered();

export const EXPORT_SCHEMA_REGISTRY: readonly ExportTable[] = Object.entries(TABLE_COLUMNS)
  .map(([tableName, columnNames]) => ({
    name: tableName,
    columns: columnNames.map((columnName) => ({
      name: columnName,
      disposition: dispositionFor(tableName, columnName)
    })),
    orderBy: TABLE_ORDER_KEYS[tableName]!
  }))
  .sort((left, right) => left.name.localeCompare(right.name));

// Kept separate from the registry so an accidental policy rule cannot make the source
// table or column names dynamic.
export const exportColumnsFor = (table: ExportTable): readonly string[] => table.columns.filter((column) => column.disposition === "EXPORT").map((column) => column.name);

export const readableColumnsFor = (table: ExportTable): readonly ExportColumn[] =>
  table.columns.filter((column) => column.disposition !== "SECRET_EXCLUDED");
