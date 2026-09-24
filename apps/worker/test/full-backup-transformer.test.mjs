import assert from "node:assert/strict";
import test from "node:test";
import { EXPORT_SCHEMA_REGISTRY } from "../dist/export-schema-registry.js";
import { FULL_BACKUP_TRANSFORM_MANIFEST, FullBackupTransformer, fullBackupOutputColumns } from "../dist/full-backup-transformer.js";

const hex = "a".repeat(64);
const table = (name) => EXPORT_SCHEMA_REGISTRY.find((item) => item.name === name);
const transforms = (name) => table(name).columns.filter((column) => column.disposition === "TRANSFORM").map((column) => column.name);
const exported = (name, supplied = {}) => Object.assign(Object.fromEntries(table(name).columns.filter((column) => column.disposition === "EXPORT").map((column) => [column.name, null])), supplied);
const transformer = (overrides = {}) => new FullBackupTransformer({
  fingerprint: () => hex,
  decryptWithdrawalRecipient: () => ({ recipientName: "张三", bankAccount: "=0012345678901234", bankName: "中国银行" }),
  ...overrides,
});
const row = (tableName, transformValues, exportValues = {}, options = {}) => transformer(options).transformRow({
  tableName, exportValues: exported(tableName, exportValues), transformValues: new Map(Object.entries(transformValues)), context: options.context,
});

test("普通报销执行授权快照按已知字段保真，秘密或未知嵌套不能进入备份", async () => {
  const snapshot = {
    executorPersonId: "finance", executorSubjectCode: "HEADQUARTERS_FINANCE", executorScopeType: "GLOBAL",
    roleAssignmentId: "role", roleValidFrom: "2026-09-01T00:00:00Z", roleValidTo: null,
    companyFundAssignmentId: "assignment", fundAssignmentValidFrom: "2026-09-01T00:00:00Z", fundAssignmentValidTo: null,
    sourceFundId: "fund", sourceFundCode: "00001", sourceAccountId: "company", destinationAccountId: "personal",
    applicantPersonId: "teacher", submittedAt: "2026-09-02T00:00:00Z", approvedAt: "2026-09-03T00:00:00Z",
    submissionDocumentVersion: 2, decisionDocumentVersion: 3,
  };
  const reversal = { originalTransferAuthorization: snapshot, originalLedgerEventId: "original-ledger", originalExecutedByPersonId: "finance", actorPersonId: "admin", actorSubjectCode: "SYSTEM_ADMIN", actorScopeType: "GLOBAL", processingMode: "MANUAL" };
  const reversed = await row("finance_reimbursement_reversal", { authorization_snapshot: JSON.stringify(reversal) }, { destination_after_cents: "-5300" });
  assert.equal(reversed.values.authorization_snapshot, JSON.stringify(reversal));
  assert.equal(reversed.values.destination_after_cents, "-5300");
  assert.deepEqual(reversed.anomalies, []);
  for (const bad of [{ ...reversal, accessToken: "secret" }, { ...reversal, originalTransferAuthorization: { ...snapshot, password: "secret" } }, { ...reversal, actorScopeType: { token: "secret" } }]) {
    await assert.rejects(row("finance_reimbursement_reversal", { authorization_snapshot: JSON.stringify(bad) }), /EXPORT_TRANSFORM_SCHEMA_GAP/);
  }
  const reverseDetails = JSON.stringify({ processingMode: "MANUAL", reason: "原笔更正", originalLedgerEventId: "original-ledger", actorSubjectCode: "SYSTEM_ADMIN", actorScopeType: "GLOBAL" });
  const reverseEvent = await row("finance_document_event", { details_json: reverseDetails }, { event_type: "REIMBURSEMENT_REVERSED" });
  assert.equal(reverseEvent.values.details_json, reverseDetails);
  assert.deepEqual(reverseEvent.anomalies, []);
  const raw = JSON.stringify(snapshot);
  const result = await row("finance_reimbursement_transfer", { authorization_snapshot: raw }, { amount_cents: "5300", source_after_cents: "-100" });
  assert.equal(result.values.authorization_snapshot, raw);
  assert.equal(result.values.source_after_cents, "-100");
  assert.deepEqual(result.anomalies, []);
  for (const bad of [{ ...snapshot, accessToken: "secret" }, { ...snapshot, sourceFundCode: { password: "secret" } }])
    await assert.rejects(row("finance_reimbursement_transfer", { authorization_snapshot: JSON.stringify(bad) }), /EXPORT_TRANSFORM_SCHEMA_GAP/);
  const oldMalformed = JSON.stringify({ ...snapshot, submissionDocumentVersion: "old-value" });
  const preserved = await row("finance_reimbursement_transfer", { authorization_snapshot: oldMalformed });
  assert.equal(preserved.values.authorization_snapshot, oldMalformed);
  assert.ok(preserved.anomalies.some(item => item.field === "submissionDocumentVersion"));
  const details = JSON.stringify({ processingMode: "MANUAL", amountCents: "5300", sourceAccountId: "company", destinationAccountId: "personal" });
  const event = await row("finance_document_event", { details_json: details }, { event_type: "REIMBURSEMENT_COMPLETED" });
  assert.equal(event.values.details_json, details);
  assert.deepEqual(event.anomalies, []);
  await assert.rejects(row("finance_document_event", { details_json: JSON.stringify({ processingMode: "MANUAL", apiToken: "secret" }) }, { event_type: "REIMBURSEMENT_COMPLETED" }), /EXPORT_TRANSFORM_SCHEMA_GAP/);
});

const realWeeklyContext = JSON.stringify({
  businessAt: "2026-09-01T00:00:00+08:00", weekStartsOn: "2026-09-01", settlementMonth: "2026-09-01", feeEntryId: "fee", feeVersion: "1",
  referrerPersonId: "referrer", receiverPersonId: "receiver", referrerIdentity: "ACADEMIC_PLANNER", sourceSubject: null, sourceProvenance: "LEGACY_IDENTITY_ONLY",
  venueId: "venue", venueOwnerPersonId: "owner", isSelfUseSnapshot: false,
  policy: { id: "policy", version: "1", effectiveFrom: "2026-01-01" }, monthlyNet: { receivedCents: "100", referredCents: "0", netCents: "100" },
  resolvedRates: { baseIntroRateBasisPoints: "1", dynamicAdjustmentBasisPoints: "0", actualIntroPoolBasisPoints: "1", planningMentorWeightBasisPoints: "0", groupLeaderRateBasisPoints: "0", teachingMentorRateBasisPoints: "0", venueRateBasisPoints: "0", campusConsultationRateBasisPoints: "0", platformFinanceRateBasisPoints: "0", regionFinanceRateBasisPoints: "0" },
  relationships: { referrerIsPlanningMentor: false, planningMentor: null, groupLeader: null, teachingMentor: null }, organization: { referrerCampusAssignment: null, receiverCampusAssignment: null, headquartersFinanceRole: null, regionFinanceRole: null },
  accounts: { teachingTeacher: { ownerType: "PERSON", ownerId: "receiver", accountId: "account", accountCode: "person:receiver" } },
});

test("真实结算上下文、退款及自购写入结构可转换，业务 JSON 字节保持", async () => {
  const weekly = await row("weekly_fee_allocation_snapshot", { snapshot_json: JSON.stringify({ lines: [], accountByKey: {} }), context_json: realWeeklyContext });
  assert.equal(weekly.values.context_json, realWeeklyContext);
  const refund = JSON.stringify({ reviewerPersonId: "reviewer", reviewerSubjectCode: "HEADQUARTERS_FINANCE", reviewerScopeType: "GLOBAL", reviewerContextRegionId: null, reviewerContextCampusId: null, reviewerContextVenueId: null, submissionDocumentVersion: 2, submissionSnapshot: {} });
  await row("finance_refund_decision", { authorization_snapshot: refund });
  const selfPurchase = JSON.stringify({ roleAssignmentId: "role", rolePersonId: "actor", roleSubjectCode: "HEADQUARTERS_FINANCE", roleScopeType: "GLOBAL", roleScopeId: null, roleValidFrom: "2026-01-01T00:00:00Z", roleValidTo: null, companyFundAssignmentId: "assignment", fundAssignmentValidFrom: "2026-01-01T00:00:00Z", fundAssignmentValidTo: null, sourceFundId: "fund", sourceFundCode: "OPERATING", sourceAccountId: "source", destinationPersonId: "actor", destinationAccountId: "destination", applicantContextSubject: "HEADQUARTERS_FINANCE", applicantContextScope: "GLOBAL", applicantContextRegionId: null, applicantContextCampusId: null, applicantContextVenueId: null });
  await row("finance_self_purchase_transfer", { authorization_snapshot: selfPurchase });
});

test("提现、事件、命令结果和审计使用真实 writer 形状", async () => {
  const envelope = { authorization_snapshot: JSON.stringify({ authorizationKind: "PERSON_OWNER", sourceAccountId: "source", personId: "applicant" }), recipient_key_id: "key", recipient_nonce: "nonce", recipient_ciphertext: "cipher", recipient_auth_tag: "tag" };
  const withdrawal = await row("finance_withdrawal_submission", envelope, { finance_document_id: "document", source_account_id: "source", amount_cents: "50", bank_account_last4: "1234", authorization_kind: "PERSON_OWNER" }, { context: { withdrawalRecipient: { applicantPersonId: "applicant" } } });
  assert.equal(withdrawal.values.bank_account, "=0012345678901234");
  await row("finance_document_event", { details_json: JSON.stringify({ approvalMode: "MANUAL", sourceAccountId: "source", sourceOwnerType: "PERSON", amountCents: "5", authorizationKind: "PERSON_OWNER" }) }, { event_type: "SUBMITTED" });
  await row("finance_document_event", { details_json: JSON.stringify({ completionAttachmentCount: 2 }) }, { event_type: "TRANSFERRED" });
  await row("finance_document_event", { details_json: JSON.stringify({ reason: "业务 token 字样原样保留", amountCents: "5" }) }, { event_type: "REVOKED" });
  await row("company_finance_fund_command_idempotency", { idempotency_key: "command", result_json: JSON.stringify({ id: "assignment", fundId: "fund", validFrom: "2026-01-01T00:00:00Z", previousAssignmentId: null, replay: false }) }, { operation: "ASSIGN" });
  await row("venue_command_idempotency", { idempotency_key: "command", result_json: JSON.stringify({ id: "venue", ownerPersonId: "owner", name: "教室", status: "ACTIVE", defaultForOwner: false, version: 1, accountId: "account", accountCode: "venue:venue", replay: false }) }, { operation: "CREATE" });
  await row("salary_benefit_command_idempotency", { idempotency_key: "command", result_json: JSON.stringify([{ id: "todo", planVersionId: "plan", subjectPersonId: "teacher", month: "2026-09-01", kind: "CASH_WAGE" }]) }, { operation: "GENERATE_WAGE_TODOS" });
  const permissionAudit = await row("audit_event", { before_json: JSON.stringify({ id: "grant", venue_id: "venue", grantee_person_id: "person", can_view: true, can_withdraw: false, valid_from: "2026-01-01T00:00:00Z", valid_to: null, version: "1" }), after_json: JSON.stringify({ id: "grant", venueId: "venue", granteePersonId: "person", canView: true, canWithdraw: false, validFrom: "2026-01-01T00:00:00Z", validTo: null, version: 2, replay: false }) }, { subject_type: "VENUE", action_code: "VENUE_PERMISSION_CHANGED" });
  assert.equal(permissionAudit.anomalies.length, 0);
  await row("audit_event", { before_json: null, after_json: JSON.stringify({ contextSubject: "HEADQUARTERS_FINANCE" }) }, { subject_type: "FINANCE_REIMBURSEMENT", action_code: "REIMBURSEMENT_DETAIL_READ" });
});

test("账号注册与密码重置审计只接受固定 USER_ACCOUNT 业务形状", async () => {
  const registration = JSON.stringify({ baseSubject: "TEACHER", scope: "SELF" });
  const registered = await row(
    "audit_event",
    { before_json: null, after_json: registration },
    { subject_type: "USER_ACCOUNT", action_code: "ACCOUNT_REGISTERED" },
  );
  assert.equal(registered.values.after_json, registration);
  assert.deepEqual(registered.anomalies, []);

  const before = JSON.stringify({ authVersion: "1" });
  const after = JSON.stringify({ authVersion: "2" });
  const reset = await row(
    "audit_event",
    { before_json: before, after_json: after },
    { subject_type: "USER_ACCOUNT", action_code: "ACCOUNT_PASSWORD_RESET" },
  );
  assert.equal(reset.values.before_json, before);
  assert.equal(reset.values.after_json, after);
  assert.deepEqual(reset.anomalies, []);

  const malformedRegistration = await row(
    "audit_event",
    { before_json: null, after_json: JSON.stringify({ baseSubject: "SYSTEM_ADMIN", scope: "GLOBAL" }) },
    { subject_type: "USER_ACCOUNT", action_code: "ACCOUNT_REGISTERED" },
  );
  assert.deepEqual(malformedRegistration.anomalies.map((item) => item.field).sort(), ["baseSubject", "scope"]);
  const malformedReset = await row(
    "audit_event",
    { before_json: JSON.stringify({ authVersion: "0" }), after_json: JSON.stringify({ authVersion: "not-a-version" }) },
    { subject_type: "USER_ACCOUNT", action_code: "ACCOUNT_PASSWORD_RESET" },
  );
  assert.equal(malformedReset.anomalies.filter((item) => item.field === "authVersion").length, 2);
  await assert.rejects(
    row("audit_event", { before_json: null, after_json: registration }, { subject_type: "PERSON", action_code: "ACCOUNT_REGISTERED" }),
    { message: "EXPORT_TRANSFORM_SCHEMA_GAP" },
  );
});

test("未知判别、空 JSON 绕过与嵌套未知字段均 fail closed", async () => {
  await assert.rejects(row("finance_document_event", { details_json: null }, { event_type: "FUTURE_EVENT" }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  await assert.rejects(row("audit_event", { before_json: null, after_json: null }, { subject_type: "PERSON", action_code: "FUTURE" }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  await assert.rejects(row("audit_event", { before_json: null, after_json: JSON.stringify({ contextSubject: "SYSTEM_OWNER" }) }, { subject_type: "FINANCE_REFUND", action_code: "FUTURE" }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  await assert.rejects(row("venue_command_idempotency", { idempotency_key: "key", result_json: null }, { operation: "FUTURE" }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  const policy = { plannerBaseRateBasisPoints: "1", teacherBaseRateBasisPoints: "1", planningMentorWeightBasisPoints: "1", groupLeaderRateBasisPoints: "1", teachingMentorRateBasisPoints: "1", venueRateBasisPoints: "1", campusConsultationForPlannerRateBasisPoints: "1", campusConsultationForTeacherRateBasisPoints: "1", platformFinanceRateBasisPoints: "1", regionFinanceRateBasisPoints: "1", dynamicTiers: [{ label: "正常", minExclusive: "0", adjustmentBasisPoints: "0", apiToken: "leak" }] };
  await assert.rejects(row("rate_policy_version", { policy_json: JSON.stringify(policy) }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  const refundDecision = { reviewerPersonId: "reviewer", reviewerSubjectCode: "HEADQUARTERS_FINANCE", reviewerScopeType: "GLOBAL", reviewerContextRegionId: null, reviewerContextCampusId: null, reviewerContextVenueId: null, submissionDocumentVersion: "2", submissionSnapshot: { applicantPersonId: "applicant", applicantContextSubject: "TEACHING_TEACHER", applicantContextScope: "SELF", applicantContextRegionId: null, applicantContextCampusId: null, applicantContextVenueId: null, referralCaseId: "referral", studentRecordId: "student", password_hash: "leak" } };
  await assert.rejects(row("finance_refund_decision", { authorization_snapshot: JSON.stringify(refundDecision) }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  const context = JSON.parse(realWeeklyContext);
  context.relationships.groupLeader = { id: "relationship", personId: "leader", apiToken: "leak" };
  await assert.rejects(row("weekly_fee_allocation_snapshot", { snapshot_json: JSON.stringify({ lines: [], accountByKey: {} }), context_json: JSON.stringify(context) }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  await assert.rejects(row("weekly_fee_allocation_snapshot", { snapshot_json: JSON.stringify({ lines: [{ key: { apiToken: "leak" }, cents: "1" }], accountByKey: {} }), context_json: realWeeklyContext }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  await assert.rejects(row("weekly_fee_allocation_snapshot", { snapshot_json: JSON.stringify({ lines: [], accountByKey: { teachingTeacher: { apiToken: "leak" } } }), context_json: realWeeklyContext }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  // A malformed sibling must not stop validation before a later secret-bearing
  // field is inspected.
  await assert.rejects(row("weekly_fee_allocation_snapshot", { snapshot_json: JSON.stringify({ lines: "legacy-bad", accountByKey: { teachingTeacher: { apiToken: "leak" } } }), context_json: realWeeklyContext }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  const dynamicScalarContainer = { ...policy, dynamicTiers: [{ label: { apiToken: "leak" }, minExclusive: "0", maxInclusive: "100", adjustmentBasisPoints: "0" }] };
  await assert.rejects(row("rate_policy_version", { policy_json: JSON.stringify(dynamicScalarContainer) }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  await assert.rejects(row("finance_document_event", { details_json: JSON.stringify({ amountCents: "1", reason: "x", destinationAccountId: "account", applicantContext: { applicantPersonId: "person", applicantContextSubject: "TEACHING_TEACHER", applicantContextScope: "SELF", applicantContextRegionId: null, applicantContextCampusId: null, applicantContextVenueId: null, destinationAccountId: "account", apiToken: "leak" } }) }, { event_type: "REIMBURSEMENT_SUBMITTED" }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  const reversal = { actorPersonId: "actor", actorSubjectCode: "SYSTEM_ADMIN", actorScopeType: "GLOBAL", processingMode: "MANUAL", originalLedgerEventId: "event", originalTransferAuthorization: { roleAssignmentId: "role", rolePersonId: "actor", roleSubjectCode: "HEADQUARTERS_FINANCE", roleScopeType: "GLOBAL", roleScopeId: null, roleValidFrom: "now", roleValidTo: null, companyFundAssignmentId: "assignment", fundAssignmentValidFrom: "now", fundAssignmentValidTo: null, sourceFundId: "fund", sourceFundCode: "code", sourceAccountId: "source", destinationPersonId: "actor", destinationAccountId: "destination", applicantContextSubject: "HEADQUARTERS_FINANCE", applicantContextScope: "GLOBAL", applicantContextRegionId: null, applicantContextCampusId: null, applicantContextVenueId: null, apiToken: "leak" } };
  await assert.rejects(row("finance_self_purchase_reversal", { authorization_snapshot: JSON.stringify(reversal) }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  await assert.rejects(row("finance_document_event", { details_json: JSON.stringify({ reason: "退款", referralCaseId: "referral", studentRecordId: "student", weeklyFeeEntryIds: [{ apiToken: "leak" }], applicantContext: { applicantPersonId: "person", applicantContextSubject: "TEACHING_TEACHER", applicantContextScope: "SELF", applicantContextRegionId: null, applicantContextCampusId: null, applicantContextVenueId: null, referralCaseId: "referral", studentRecordId: "student" } }) }, { event_type: "REFUND_SUBMITTED" }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  await assert.rejects(row("salary_benefit_command_idempotency", { idempotency_key: "command", result_json: JSON.stringify([{ id: { apiToken: "leak" }, planVersionId: "plan", subjectPersonId: "person", month: "2026-09-01", kind: "CASH_WAGE" }]) }, { operation: "GENERATE_WAGE_TODOS" }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  const nullKnown = await row("finance_document_event", { details_json: null }, { event_type: "REIMBURSEMENT_SUBMITTED" });
  assert.equal(nullKnown.anomalies.length, 1);
});

test("真实费率阶梯键可保留，且每行必须精确提供注册的 TRANSFORM 列", async () => {
  const policy = { plannerBaseRateBasisPoints: "1", teacherBaseRateBasisPoints: "1", planningMentorWeightBasisPoints: "1", groupLeaderRateBasisPoints: "1", teachingMentorRateBasisPoints: "1", venueRateBasisPoints: "1", campusConsultationForPlannerRateBasisPoints: "1", campusConsultationForTeacherRateBasisPoints: "1", platformFinanceRateBasisPoints: "1", regionFinanceRateBasisPoints: "1", dynamicTiers: [{ label: "(0,100]", minExclusive: "0", maxInclusive: "100", adjustmentBasisPoints: "0" }] };
  const original = JSON.stringify(policy);
  const transformed = await row("rate_policy_version", { policy_json: original });
  assert.equal(transformed.values.policy_json, original);
  await assert.rejects(row("ledger_event", {}, { id: "event", event_type: "x", payload_hash: "x", created_at: "x" }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  await assert.rejects(row("ledger_event", { event_key: "key", unexpected: "x" }, { id: "event", event_type: "x", payload_hash: "x", created_at: "x" }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
});

test("旧版本已知字段缺失保留原文并标业务异常，未知结构仍拒绝", async () => {
  const contextWithoutOrganization = JSON.parse(realWeeklyContext);
  delete contextWithoutOrganization.organization;
  const weekly = await row("weekly_fee_allocation_snapshot", {
    snapshot_json: JSON.stringify({ lines: [], accountByKey: {} }),
    context_json: JSON.stringify(contextWithoutOrganization),
  });
  assert.equal(weekly.values.context_json, JSON.stringify(contextWithoutOrganization));
  assert.equal(weekly.anomalies.some((item) => item.field === "organization"), true);

  const incompleteDecision = {
    reviewerPersonId: "reviewer", reviewerSubjectCode: "HEADQUARTERS_FINANCE", reviewerScopeType: "GLOBAL",
    reviewerContextRegionId: null, reviewerContextCampusId: null, reviewerContextVenueId: null,
    submissionDocumentVersion: 2,
  };
  const decision = await row("finance_refund_decision", { authorization_snapshot: JSON.stringify(incompleteDecision) });
  assert.equal(decision.anomalies.some((item) => item.field === "submissionSnapshot"), true);

  const reimbursementEvent = await row("finance_document_event", {
    details_json: JSON.stringify({ amountCents: "5", reason: "旧记录", destinationAccountId: "destination" }),
  }, { event_type: "REIMBURSEMENT_SUBMITTED" });
  assert.equal(reimbursementEvent.anomalies.some((item) => item.field === "applicantContext"), true);

  const incompleteWithdrawalEvent = await row("finance_document_event", {
    details_json: JSON.stringify({ approvalMode: "MANUAL", sourceAccountId: "source", amountCents: "5", authorizationKind: "PERSON_OWNER" }),
  }, { event_type: "SUBMITTED" });
  assert.equal(incompleteWithdrawalEvent.anomalies.some((item) => item.field === "sourceOwnerType"), true);

  const incompleteResult = await row("venue_command_idempotency", {
    idempotency_key: "command",
    result_json: JSON.stringify({ ownerPersonId: "owner", name: "旧场地", status: "ACTIVE", defaultForOwner: false, version: 1, accountId: "account", accountCode: "venue:old" }),
  }, { operation: "CREATE" });
  assert.equal(incompleteResult.anomalies.some((item) => item.field === "id"), true);
});

test("已知标量类型异常和 JSON literal null 会保留并标异常", async () => {
  const numericPolicy = {
    plannerBaseRateBasisPoints: 1, teacherBaseRateBasisPoints: "1", planningMentorWeightBasisPoints: "1",
    groupLeaderRateBasisPoints: "1", teachingMentorRateBasisPoints: "1", venueRateBasisPoints: "1",
    campusConsultationForPlannerRateBasisPoints: "1", campusConsultationForTeacherRateBasisPoints: "1",
    platformFinanceRateBasisPoints: "1", regionFinanceRateBasisPoints: "1", dynamicTiers: [],
  };
  const policy = await row("rate_policy_version", { policy_json: JSON.stringify(numericPolicy) });
  assert.equal(policy.anomalies.some((item) => item.field === "plannerBaseRateBasisPoints"), true);

  const cents = await row("weekly_fee_allocation_snapshot", {
    snapshot_json: JSON.stringify({ lines: [{ key: "teachingTeacher", cents: 1 }], accountByKey: {} }), context_json: realWeeklyContext,
  });
  assert.equal(cents.anomalies.some((item) => item.field === "cents"), true);

  const context = JSON.parse(realWeeklyContext);
  context.policy.version = 1;
  context.organization.referrerCampusAssignment = { id: "assignment", campus_id: 1, region_id: "region" };
  const weekly = await row("weekly_fee_allocation_snapshot", {
    snapshot_json: JSON.stringify({ lines: [], accountByKey: {} }), context_json: JSON.stringify(context),
  });
  assert.equal(weekly.anomalies.some((item) => item.field === "version"), true);
  assert.equal(weekly.anomalies.some((item) => item.field === "campus_id"), true);

  const knownEventNull = await row("finance_document_event", { details_json: "null" }, { event_type: "CREATED" });
  assert.equal(knownEventNull.anomalies.length, 1);
  const knownAuditNull = await row("audit_event", { before_json: null, after_json: "null" }, {
    subject_type: "FINANCE_REFUND", action_code: "REFUND_DETAIL_READ",
  });
  assert.equal(knownAuditNull.anomalies.length, 1);
});

test("输出严格投影注册 EXPORT，原始幂等键和结算 event key 从不出现", async () => {
  await assert.rejects(transformer().transformRow({ tableName: "user_account", exportValues: { id: "id", nickname: "n", password_hash: "leak" }, transformValues: new Map() }), { message: "EXPORT_TRANSFORM_SCHEMA_GAP" });
  const ledger = await row("ledger_event", { event_key: "weekly-settlement:user-request-key" }, { id: "event", event_type: "WEEKLY_FEE_SETTLEMENT", payload_hash: "hash", created_at: "2026-01-01T00:00:00Z" });
  assert.equal(ledger.values.event_key, undefined); assert.equal(ledger.values.event_key_fingerprint, hex); assert.equal(JSON.stringify(ledger.values).includes("user-request-key"), false);
  const run = await row("settlement_calculation_run", { request_key: "request-key" });
  assert.equal(JSON.stringify(run.values).includes("request-key"), false);
});

test("指纹必须是域隔离的小写 64 位 hex，错误或回显原文失败", async () => {
  await assert.rejects(row("ledger_event", { event_key: "same" }, {}, { fingerprint: () => "same" }), { message: "EXPORT_TRANSFORM_FINGERPRINT_FAILED" });
  await assert.rejects(row("ledger_event", { event_key: "same" }, {}, { fingerprint: () => "F".repeat(64) }), { message: "EXPORT_TRANSFORM_FINGERPRINT_FAILED" });
});

test("manifest 声明转换版本、排除和指纹编码", () => {
  assert.equal(FULL_BACKUP_TRANSFORM_MANIFEST.transformSchemaVersion, "full-backup-transform.v11");
  assert.equal(FULL_BACKUP_TRANSFORM_MANIFEST.ledgerEventKeysFingerprinted, true);
  assert.equal(FULL_BACKUP_TRANSFORM_MANIFEST.fingerprintAlgorithm, "HMAC-SHA-256");
  assert.equal(FULL_BACKUP_TRANSFORM_MANIFEST.fingerprintEncoding, "lowercase-hex");
});

test("空数据集和实际转换行共用固定输出列布局", async () => {
  assert.deepEqual(fullBackupOutputColumns("user_session"), []);
  const ledger = await row("ledger_event", { event_key: "weekly-settlement:request" }, {
    id: "event", event_type: "WEEKLY_FEE_SETTLEMENT", payload_hash: "hash", created_at: "2026-01-01T00:00:00Z",
  });
  assert.deepEqual(Object.keys(ledger.values), fullBackupOutputColumns("ledger_event"));
  assert.deepEqual(fullBackupOutputColumns("ledger_event"), ["id", "event_type", "payload_hash", "created_at", "event_key_fingerprint"]);

  const withdrawal = await row("finance_withdrawal_submission", {
    authorization_snapshot: JSON.stringify({ authorizationKind: "PERSON_OWNER", sourceAccountId: "source", personId: "applicant" }),
    recipient_key_id: "key", recipient_nonce: "nonce", recipient_ciphertext: "cipher", recipient_auth_tag: "tag",
  }, {
    finance_document_id: "document", source_account_id: "source", amount_cents: "50", bank_account_last4: "1234", authorization_kind: "PERSON_OWNER",
  }, { context: { withdrawalRecipient: { applicantPersonId: "applicant" } } });
  assert.deepEqual(Object.keys(withdrawal.values), fullBackupOutputColumns("finance_withdrawal_submission"));
  assert.equal(fullBackupOutputColumns("finance_withdrawal_submission").includes("recipient_ciphertext"), false);
  assert.deepEqual(fullBackupOutputColumns("finance_withdrawal_submission").slice(-4), ["authorization_snapshot", "recipient_name", "bank_account", "bank_name"]);
});

test("人员资料更正历史只输出幂等指纹，不输出原始命令键", async () => {
  const result = await row("person_profile_change", { idempotency_key: "raw-profile-key" }, {
    id: "profile-change-1", person_id: "person-1", source_profile_version: "1", result_profile_version: "2",
    before_nickname: "旧昵称", before_legal_name: "旧实名", after_nickname: "新昵称", after_legal_name: "新实名",
    actor_person_id: "admin-1", actor_subject_code: "SYSTEM_OWNER", reason: "纠正", changed_at: "2026-09-23T00:00:00.000Z", created_at: "2026-09-23T00:00:00.000Z",
  });
  assert.equal(result.values.idempotency_key, undefined);
  assert.equal(result.values.idempotency_key_fingerprint, "a".repeat(64));
});

test("业务身份历史只输出幂等指纹，不输出原始命令键", async () => {
  const result = await row("teacher_profile_identity_change", { idempotency_key: "raw-business-identity-key" }, {
    id: "identity-change-1", audit_event_id: "audit-1", person_id: "person-1", source_business_identity_version: null,
    result_business_identity_version: "1", before_business_identity: null, after_business_identity: "TEACHING_TEACHER",
    before_grade_subject: null, after_grade_subject: "数学", before_role_assignment_id: null, result_role_assignment_id: "role-1",
    before_auth_version: "1", result_auth_version: "2", actor_person_id: "admin-1", actor_subject_code: "SYSTEM_OWNER",
    reason: "首配", requested_grade_subject: "数学", changed_at: "2026-09-23T00:00:00.000Z", created_at: "2026-09-23T00:00:00.000Z",
  });
  assert.equal(result.values.idempotency_key, undefined);
  assert.match(result.values.idempotency_key_fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(result.values).includes("raw-business-identity-key"), false);
});

test("管理员规划导师变更只输出幂等指纹，不输出原始命令键", async () => {
  const result = await row("admin_planning_mentor_relationship_change", {
    idempotency_key: "raw-admin-planning-mentor-command",
    before_json: JSON.stringify({ sourceRelationship: null }),
    after_json: JSON.stringify({ sourceRelationship: null, continuationRelationship: null, resultRelationship: {
      id: "00000000-0000-4000-8000-000000000001", teacherPersonId: "00000000-0000-4000-8000-000000000002",
      relationshipType: "PLANNING_MENTOR", relatedPersonId: "00000000-0000-4000-8000-000000000003",
      validFrom: "2026-09-21T00:00:00.000Z", validTo: null, effectiveScope: "REGULAR_WEEK:week",
      createdByPersonId: "00000000-0000-4000-8000-000000000004", createdAt: "2026-09-21T00:00:00.000Z",
      supersededAt: null, supersededByChangeId: null, supersededByPlanningMentorChangeId: null,
      supersededByAdminPlanningMentorChangeId: null,
    } }),
  }, { action: "ADD" });
  assert.equal(result.values.idempotency_key, undefined);
  assert.equal(result.values.idempotency_key_fingerprint, hex);
  assert.equal(JSON.stringify(result.values).includes("raw-admin-planning-mentor-command"), false);
});
