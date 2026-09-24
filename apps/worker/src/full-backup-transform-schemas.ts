export const FULL_BACKUP_TRANSFORM_SCHEMA_VERSION = "full-backup-transform.v11";

export type TransformAnomaly = Readonly<{ code: "TRANSFORM_VALUE_ANOMALY"; tableName: string; columnName: string; field?: string }>;
export type JsonTransformInput = Readonly<{ tableName: string; columnName: string; raw: string | null; row: Readonly<Record<string, string | null>> }>;

const gap = (): never => { throw new Error("EXPORT_TRANSFORM_SCHEMA_GAP"); };
const anomaly = (input: JsonTransformInput, field?: string): TransformAnomaly => ({ code: "TRANSFORM_VALUE_ANOMALY", tableName: input.tableName, columnName: input.columnName, ...(field === undefined ? {} : { field }) });
const object = (value: unknown): Record<string, unknown> | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const parseObject = (input: JsonTransformInput): Record<string, unknown> => {
  if (input.raw === null) return gap();
  try { return object(JSON.parse(input.raw)) ?? gap(); } catch { return gap(); }
};

type ExactValueTypes = Readonly<{
  strings?: readonly string[];
  numbers?: readonly string[];
  booleans?: readonly string[];
}>;

const exactKeys = (input: JsonTransformInput, value: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = allowed, types: ExactValueTypes = {}): TransformAnomaly[] => {
  if (Object.keys(value).some((key) => !allowed.includes(key))) gap();
  const anomalies = required.filter((key) => !(key in value)).map((field) => anomaly(input, field));
  for (const [field, candidate] of Object.entries(value)) {
    const array = ["lines", "dynamicTiers", "weeklyFeeEntryIds", "selectedFeeIds"].includes(field);
    const nested = ["accountByKey", "accounts", "relationships", "organization", "resolvedRates", "applicantContext", "reviewerContext", "originalTransferAuthorization", "policy", "monthlyNet", "submissionSnapshot", "planningMentor", "groupLeader", "teachingMentor", "referrerCampusAssignment", "receiverCampusAssignment", "headquartersFinanceRole", "regionFinanceRole"].includes(field);
    const bool = types.booleans?.includes(field) ?? ["canView", "canWithdraw", "grantCanWithdraw", "defaultForOwner", "isSelfUseSnapshot", "referrerIsPlanningMentor", "replay"].includes(field);
    const text = types.strings?.includes(field) ?? (field.endsWith("Id") || field.endsWith("Code") || field.endsWith("Scope") || field.endsWith("Subject") || field.endsWith("At") || field.endsWith("Cents") || field.endsWith("From") || field.endsWith("To") || ["processingMode", "reason", "status", "decision", "authorizationKind", "name", "displayName", "kind", "sourceProvenance", "referrerIdentity", "fundCode"].includes(field));
    const number = types.numbers?.includes(field) ?? false;
    // A container at a scalar position is an unmodelled structure, never a
    // recoverable business-value anomaly: retaining it could retain a secret.
    if ((Array.isArray(candidate) && !array) || (object(candidate) !== undefined && !nested)) gap();
    if ((array && !Array.isArray(candidate)) || (nested && candidate !== null && object(candidate) === undefined) || (bool && typeof candidate !== "boolean") || (text && candidate !== null && typeof candidate !== "string") || (number && typeof candidate !== "number")) anomalies.push(anomaly(input, field));
  }
  return anomalies;
};

const validateDynamicTiers = (input: JsonTransformInput, root: Record<string, unknown>): TransformAnomaly[] => {
  const tiers = root.dynamicTiers;
  if (!Array.isArray(tiers)) return [anomaly(input, "dynamicTiers")];
  const allowed = ["label", "minExclusive", "maxInclusive", "adjustmentBasisPoints"];
  const anomalies: TransformAnomaly[] = [];
  for (const tier of tiers) {
    const item = object(tier);
    if (item === undefined) { anomalies.push(anomaly(input, "dynamicTiers")); continue; }
    // Reuse the same scalar/container contract as every other persisted
    // object.  An object in e.g. `label` is not a recoverable malformed
    // business scalar: retaining it could retain a secret.
    anomalies.push(...exactKeys(input, item, allowed, [], { strings: allowed }));
  }
  return anomalies;
};

const validateScalarArray = (input: JsonTransformInput, value: unknown, field: string): TransformAnomaly[] => {
  // The parent exact-key check already records missing/wrong primitive array
  // fields.  This helper only inspects items, so it does not duplicate that
  // anomaly or turn an old incomplete record into an export failure.
  if (!Array.isArray(value)) return [];
  const anomalies: TransformAnomaly[] = [];
  for (const item of value) {
    if (Array.isArray(item) || object(item) !== undefined) gap();
    if (typeof item !== "string") anomalies.push(anomaly(input, field));
  }
  return anomalies;
};

const validateSnapshot = (input: JsonTransformInput, root: Record<string, unknown>): TransformAnomaly[] => {
  return validateSnapshotNested(input, root);
};

const validateWeeklyContext = (input: JsonTransformInput, root: Record<string, unknown>): TransformAnomaly[] => {
  const allowed = ["businessAt", "weekStartsOn", "settlementMonth", "feeEntryId", "feeVersion", "referrerPersonId", "receiverPersonId", "referrerIdentity", "sourceSubject", "sourceProvenance", "venueId", "venueOwnerPersonId", "isSelfUseSnapshot", "policy", "monthlyNet", "resolvedRates", "relationships", "organization", "accounts"];
  const anomalies = exactKeys(input, root, allowed, undefined, {
    strings: ["businessAt", "weekStartsOn", "settlementMonth", "feeEntryId", "feeVersion", "referrerPersonId", "receiverPersonId", "referrerIdentity", "sourceSubject", "sourceProvenance", "venueId", "venueOwnerPersonId"],
    booleans: ["isSelfUseSnapshot"],
  });
  return [...anomalies, ...validateWeeklyNested(input, root)];
};

const applicantKeys = ["applicantPersonId", "applicantContextSubject", "applicantContextScope", "applicantContextRegionId", "applicantContextCampusId", "applicantContextVenueId"];
const policyKeys = ["plannerBaseRateBasisPoints", "teacherBaseRateBasisPoints", "planningMentorWeightBasisPoints", "groupLeaderRateBasisPoints", "teachingMentorRateBasisPoints", "venueRateBasisPoints", "campusConsultationForPlannerRateBasisPoints", "campusConsultationForTeacherRateBasisPoints", "platformFinanceRateBasisPoints", "regionFinanceRateBasisPoints", "dynamicTiers"];
const settlementKeys = ["referrer", "planningMentor", "groupLeader", "teachingMentor", "venue", "campusConsultation", "platformFinance", "regionFinance", "teachingTeacher"];

const nestedObject = (value: unknown): Record<string, unknown> => object(value) ?? gap();
const validateRequiredObject = (input: JsonTransformInput, value: unknown, allowed: readonly string[], field?: string, types: ExactValueTypes = {}): TransformAnomaly[] => {
  const candidate = object(value);
  if (candidate !== undefined) return exactKeys(input, candidate, allowed, allowed, types);
  // Missing and primitive values have already been recorded by the caller's
  // exact-key pass.  A present null needs its own anomaly, but is still a
  // historical business record to preserve rather than a schema gap.
  return value === null ? [anomaly(input, field)] : [];
};
const validateApplicantSnapshot = (input: JsonTransformInput, value: unknown, kind: "REFUND" | "REIMBURSEMENT"): TransformAnomaly[] =>
  validateRequiredObject(input, value, kind === "REFUND" ? [...applicantKeys, "referralCaseId", "studentRecordId"] : [...applicantKeys, "destinationAccountId"], undefined, kind === "REFUND" ? { strings: [...applicantKeys, "referralCaseId", "studentRecordId"] } : { strings: [...applicantKeys, "destinationAccountId"] });
const validateReviewerDecision = (input: JsonTransformInput, value: unknown, kind: "REFUND" | "REIMBURSEMENT"): TransformAnomaly[] => {
  const snapshot = object(value);
  if (snapshot === undefined) return value === null ? [anomaly(input)] : [];
  const fields = ["reviewerPersonId", "reviewerSubjectCode", "reviewerScopeType", "reviewerContextRegionId", "reviewerContextCampusId", "reviewerContextVenueId", "submissionDocumentVersion", "submissionSnapshot"];
  return [...exactKeys(input, snapshot, fields, fields, { strings: fields.filter((field) => field !== "submissionSnapshot" && field !== "submissionDocumentVersion"), numbers: ["submissionDocumentVersion"] }), ...validateApplicantSnapshot(input, snapshot.submissionSnapshot, kind)];
};
const validateSelfPurchaseAuthorization = (input: JsonTransformInput, value: unknown): TransformAnomaly[] =>
  validateRequiredObject(input, value, ["roleAssignmentId", "rolePersonId", "roleSubjectCode", "roleScopeType", "roleScopeId", "roleValidFrom", "roleValidTo", "companyFundAssignmentId", "fundAssignmentValidFrom", "fundAssignmentValidTo", "sourceFundId", "sourceFundCode", "sourceAccountId", "destinationPersonId", "destinationAccountId", "applicantContextSubject", "applicantContextScope", "applicantContextRegionId", "applicantContextCampusId", "applicantContextVenueId"], undefined, { strings: ["roleAssignmentId", "rolePersonId", "roleSubjectCode", "roleScopeType", "roleScopeId", "roleValidFrom", "roleValidTo", "companyFundAssignmentId", "fundAssignmentValidFrom", "fundAssignmentValidTo", "sourceFundId", "sourceFundCode", "sourceAccountId", "destinationPersonId", "destinationAccountId", "applicantContextSubject", "applicantContextScope", "applicantContextRegionId", "applicantContextCampusId", "applicantContextVenueId"] });

const reimbursementTransferAuthorizationKeys = ["executorPersonId", "executorSubjectCode", "executorScopeType", "roleAssignmentId", "roleValidFrom", "roleValidTo", "companyFundAssignmentId", "fundAssignmentValidFrom", "fundAssignmentValidTo", "sourceFundId", "sourceFundCode", "sourceAccountId", "destinationAccountId", "applicantPersonId", "submittedAt", "approvedAt", "submissionDocumentVersion", "decisionDocumentVersion"];
const reimbursementTransferVersionKeys = ["submissionDocumentVersion", "decisionDocumentVersion"];
const validateReimbursementTransferAuthorization = (input: JsonTransformInput, value: unknown): TransformAnomaly[] =>
  validateRequiredObject(input, value, reimbursementTransferAuthorizationKeys, undefined, {
    strings: reimbursementTransferAuthorizationKeys.filter(field => !reimbursementTransferVersionKeys.includes(field)),
    numbers: reimbursementTransferVersionKeys,
  });

const validateWeeklyNested = (input: JsonTransformInput, root: Record<string, unknown>): TransformAnomaly[] => {
  const anomalies: TransformAnomaly[] = [];
  const policyFields = ["id", "version", "effectiveFrom"];
  const monthlyNetFields = ["receivedCents", "referredCents", "netCents"];
  const resolvedRateFields = ["baseIntroRateBasisPoints", "dynamicAdjustmentBasisPoints", "actualIntroPoolBasisPoints", "planningMentorWeightBasisPoints", "groupLeaderRateBasisPoints", "teachingMentorRateBasisPoints", "venueRateBasisPoints", "campusConsultationRateBasisPoints", "platformFinanceRateBasisPoints", "regionFinanceRateBasisPoints"];
  const requiredObjectWithStrings = (value: unknown, fields: readonly string[], field: string): TransformAnomaly[] => {
    const candidate = object(value);
    return candidate === undefined ? validateRequiredObject(input, value, fields, field) : exactKeys(input, candidate, fields, fields, { strings: fields });
  };
  anomalies.push(...requiredObjectWithStrings(root.policy, policyFields, "policy"));
  anomalies.push(...requiredObjectWithStrings(root.monthlyNet, monthlyNetFields, "monthlyNet"));
  anomalies.push(...requiredObjectWithStrings(root.resolvedRates, resolvedRateFields, "resolvedRates"));
  const relationships = object(root.relationships);
  if (relationships !== undefined) {
    anomalies.push(...exactKeys(input, relationships, ["referrerIsPlanningMentor", "planningMentor", "groupLeader", "teachingMentor"]));
    for (const key of ["planningMentor", "groupLeader", "teachingMentor"]) {
      const relation = object(relationships[key]);
      if (relation !== undefined) anomalies.push(...exactKeys(input, relation, ["id", "personId"], undefined, { strings: ["id", "personId"] }));
    }
  } else if (root.relationships === null) anomalies.push(anomaly(input, "relationships"));
  const organization = object(root.organization);
  if (organization !== undefined) {
    anomalies.push(...exactKeys(input, organization, ["referrerCampusAssignment", "receiverCampusAssignment", "headquartersFinanceRole", "regionFinanceRole"]));
    for (const key of ["referrerCampusAssignment", "receiverCampusAssignment"]) {
      const assignment = object(organization[key]);
      if (assignment !== undefined) anomalies.push(...exactKeys(input, assignment, ["id", "campus_id", "region_id"], undefined, { strings: ["id", "campus_id", "region_id"] }));
    }
    for (const key of ["headquartersFinanceRole", "regionFinanceRole"]) {
      const role = object(organization[key]);
      if (role !== undefined) anomalies.push(...exactKeys(input, role, ["id", "person_id"], undefined, { strings: ["id", "person_id"] }));
    }
  } else if (root.organization === null) anomalies.push(anomaly(input, "organization"));
  const accounts = object(root.accounts);
  if (accounts !== undefined) {
    if (Object.keys(accounts).some((key) => !settlementKeys.includes(key))) gap();
    for (const account of Object.values(accounts)) {
      const candidate = object(account);
      anomalies.push(...(candidate === undefined
        ? validateRequiredObject(input, account, ["ownerType", "ownerId", "accountId", "accountCode"])
        : exactKeys(input, candidate, ["ownerType", "ownerId", "accountId", "accountCode"], undefined, { strings: ["ownerType", "ownerId", "accountId", "accountCode"] })));
    }
  } else if (root.accounts === null) anomalies.push(anomaly(input, "accounts"));
  return anomalies;
};

const validateSnapshotNested = (input: JsonTransformInput, root: Record<string, unknown>): TransformAnomaly[] => {
  const anomalies = exactKeys(input, root, ["lines", "accountByKey"]);
  if (!Array.isArray(root.lines)) {
    anomalies.push(anomaly(input, "lines"));
  } else {
    for (const line of root.lines) anomalies.push(...exactKeys(input, nestedObject(line), ["key", "cents"], undefined, { strings: ["key", "cents"] }));
  }
  const accounts = object(root.accountByKey);
  if (accounts !== undefined) {
    if (Object.keys(accounts).some((key) => !settlementKeys.includes(key))) gap();
    for (const value of Object.values(accounts)) {
      if (Array.isArray(value) || object(value) !== undefined) gap();
      if (typeof value !== "string") anomalies.push(anomaly(input, "accountByKey"));
    }
  } else if (root.accountByKey === null) {
    anomalies.push(anomaly(input, "accountByKey"));
  }
  return anomalies;
};

type RelationshipJsonShape = "text" | "nullableText" | "count" | "boolean" | Readonly<{
  fields: Readonly<Record<string, RelationshipJsonShape>>;
  nullable?: boolean;
}> | Readonly<{ items: RelationshipJsonShape }>;
const relationshipShape: RelationshipJsonShape = { fields: {
  id: "text", teacherPersonId: "text", relationshipType: "text", relatedPersonId: "text",
  validFrom: "text", validTo: "nullableText", effectiveScope: "nullableText", createdByPersonId: "text",
  createdAt: "text", supersededAt: "nullableText", supersededByChangeId: "nullableText",
} };
const relationshipImpactShape: RelationshipJsonShape = { fields: {
  schemaVersion: "text", teacherPersonId: "text",
  effectiveWeek: { fields: { id: "text", startsOn: "text", endsOn: "text", settlementMonth: "text", kind: "text" } },
  effectiveAt: "text", nextBoundaryAt: "nullableText", sourceRelationship: relationshipShape,
  nextRelationship: { ...relationshipShape, nullable: true },
  candidate: { fields: { personId: "text", nickname: "text", userAccountId: "text", roleAssignmentId: "text", roleValidFrom: "text", roleValidTo: "nullableText" } },
  destinationAccount: { fields: { id: "text", code: "text", ownerType: "text", ownerId: "text", status: "text" } },
  reason: "text",
  fees: { items: { fields: {
    feeEntryId: "text", feeVersion: "text", grossAmountCents: "text", teachingWeekId: "text", weekStartsOn: "text",
    settlementMonth: "text", disposition: "text", refundEffectId: "nullableText", previousSnapshotId: "nullableText",
    previousSnapshotSequence: "nullableText", previousSnapshotHash: "nullableText", policyVersionId: "nullableText",
    netMonthlyCents: "nullableText", groupLeaderAmountCents: "text", sourceAccountId: "nullableText", sourceAccountCode: "nullableText",
  } } },
  totals: { fields: { consideredFeeCount: "count", movedFeeCount: "count", zeroShareFeeCount: "count", excludedRefundCount: "count", movedAmountCents: "text" } },
} };
const planningMentorRelationshipObjectShape: RelationshipJsonShape = { fields: {
  id: "text", teacherPersonId: "text", relationshipType: "text", relatedPersonId: "text",
  validFrom: "text", validTo: "nullableText", effectiveScope: "nullableText", createdByPersonId: "text",
  createdAt: "text", supersededAt: "nullableText", supersededByChangeId: "nullableText",
  supersededByPlanningMentorChangeId: "nullableText",
} };
const planningMentorRelationshipShape: RelationshipJsonShape = { ...planningMentorRelationshipObjectShape, nullable: true };
const adminPlanningMentorRelationshipObjectShape: RelationshipJsonShape = { fields: {
  id: "text", teacherPersonId: "text", relationshipType: "text", relatedPersonId: "text",
  validFrom: "text", validTo: "nullableText", effectiveScope: "nullableText", createdByPersonId: "text",
  createdAt: "text", supersededAt: "nullableText", supersededByChangeId: "nullableText",
  supersededByPlanningMentorChangeId: "nullableText", supersededByAdminPlanningMentorChangeId: "nullableText",
} };
const adminPlanningMentorRelationshipShape: RelationshipJsonShape = { ...adminPlanningMentorRelationshipObjectShape, nullable: true };
const personCampusAssignmentShape: RelationshipJsonShape = { fields: {
  id: "text", personId: "text", campusId: "text", regionId: "text", validFrom: "text", validTo: "nullableText",
  createdByPersonId: "text", createdAt: "text",
} };
const personCampusPrincipalShape: RelationshipJsonShape = { fields: {
  id: "text", teacherPersonId: "text", relatedPersonId: "text", relationshipType: "text", validFrom: "text", validTo: "nullableText",
  effectiveScope: "nullableText", createdByPersonId: "text", createdAt: "text",
} };
const personCampusResultAssignmentShape: RelationshipJsonShape = { fields: {
  id: "text", personId: "text", campusId: "text", regionId: "text", validFrom: "text", validTo: "nullableText",
} };
const personCampusResultPrincipalShape: RelationshipJsonShape = { fields: { id: "text", relatedPersonId: "text" } };
const campusRegionAssignmentShape: RelationshipJsonShape = { fields: {
  id: "text", campusId: "text", regionId: "text", validFrom: "text", validTo: "nullableText",
  createdByPersonId: "text", createdAt: "text",
} };
const campusRegionResultAssignmentShape: RelationshipJsonShape = { fields: {
  id: "text", campusId: "text", regionId: "text", validFrom: "text", validTo: "nullableText",
} };
const campusRegionAssignmentImpactShape: RelationshipJsonShape = { fields: {
  schemaVersion: "text", campusId: "text", sourceAssignment: campusRegionAssignmentShape,
  targetRegionId: "text", effectiveFrom: "text", effectiveTo: "nullableText",
  people: { items: { fields: { sourceAssignment: personCampusAssignmentShape, effectiveFrom: "text", effectiveTo: "nullableText" } } },
  fees: { items: { fields: { feeId: "text", version: "text", teachingWeekId: "text", settlementMonth: "text", refunded: "boolean", snapshotId: "nullableText", receiverAtCampus: "boolean", referrerAtCampus: "boolean" } } },
  reason: "text",
  financial: { fields: {
    consideredFeeCount: "count", changedFeeCount: "count", excludedRefundCount: "count",
    accountDeltas: { items: { fields: { accountCode: "text", categoryKey: "text", amountCents: "text" } } },
    fees: { items: { fields: { feeId: "text", version: "text", refundId: "nullableText", snapshotHash: "nullableText", disposition: "text", nextContextHash: "nullableText" } } },
    organizationImpact: { fields: { sourceRegionId: "text", targetRegionId: "text", recordedGrossRevenueCents: "text", refundedGrossRevenueCents: "text", effectiveGrossRevenueCents: "text", campusManagementFeeCents: "text" } },
  } },
} };
const personCampusAssignmentImpactShape: RelationshipJsonShape = { fields: {
  schemaVersion: "text", action: "text", personId: "text", sourceAssignment: personCampusAssignmentShape,
  sourceCampusPrincipalRelationship: { ...personCampusPrincipalShape, nullable: true }, targetCampusId: "text", targetRegionId: "text",
  targetPrincipal: { fields: { personId: "text", nickname: "text", roleAssignmentId: "text", validFrom: "text", validTo: "nullableText" } },
  effectiveFrom: "text", effectiveTo: "nullableText",
  fees: { items: { fields: { feeId: "text", version: "text", teachingWeekId: "text", settlementMonth: "text", refunded: "boolean", snapshotId: "nullableText" } } },
  reason: "text",
  financial: { fields: {
    consideredFeeCount: "count", changedFeeCount: "count", excludedRefundCount: "count",
    accountDeltas: { items: { fields: { accountCode: "text", categoryKey: "text", amountCents: "text" } } },
    fees: { items: { fields: { feeId: "text", version: "text", refundId: "nullableText", snapshotHash: "nullableText", disposition: "text", nextContextHash: "nullableText" } } },
    organizationImpact: { fields: {
      sourceCampusId: "text", sourceRegionId: "text", targetCampusId: "text", targetRegionId: "text",
      recordedGrossRevenueCents: "text", refundedGrossRevenueCents: "text", effectiveGrossRevenueCents: "text", campusManagementFeeCents: "text",
    } },
  } },
} };
const planningMentorImpactShape: RelationshipJsonShape = { fields: {
  schemaVersion: "text", action: "text", mentorPersonId: "text", plannerPersonId: "text",
  sourceRelationship: planningMentorRelationshipShape, resultRelationshipId: "nullableText",
  actorRoleAssignmentId: "text", actorRoleScopeId: "nullableText",
  mentorAccount: { fields: { id: "text", code: "text", ownerId: "text", status: "text" } },
  plannerAccount: { fields: { id: "text", code: "text", ownerId: "text", status: "text" } },
  week: { fields: { id: "text", startsOn: "text", endsOn: "text", settlementMonth: "text" } },
  effectiveAt: "text", nextBoundaryAt: "nullableText", reason: "text",
  fees: { items: { fields: {
    feeId: "text", version: "text", teachingWeekId: "text", settlementMonth: "text", refundId: "nullableText",
    snapshotId: "nullableText", sequenceNo: "nullableText", snapshotHash: "nullableText", policyVersionId: "nullableText",
    netMonthlyCents: "nullableText", disposition: "text",
  } } },
  totals: { fields: { consideredFeeCount: "count", changedFeeCount: "count", zeroShareFeeCount: "count", excludedRefundCount: "count", plannerDeltaCents: "text", mentorDeltaCents: "text" } },
} };
const planningMentorDeltaShape: RelationshipJsonShape = { fields: {
  entries: { items: { fields: { accountKey: "text", categoryKey: "text", amountCents: "text" } } },
} };
const adminPlanningMentorImpactShape: RelationshipJsonShape = { fields: {
  schemaVersion: "text", action: "text", mentorPersonId: "text", plannerPersonId: "text",
  sourceRelationship: adminPlanningMentorRelationshipShape, resultRelationshipId: "nullableText", continuationRelationshipId: "nullableText",
  actorRoleAssignmentId: "text", actorRoleScopeId: "nullableText",
  destinationMentorAccount: { fields: { id: "text", code: "text", ownerId: "text", status: "text" }, nullable: true },
  plannerAccount: { fields: { id: "text", code: "text", ownerId: "text", status: "text" } },
  week: { fields: { id: "text", startsOn: "text", endsOn: "text", settlementMonth: "text" } },
  effectiveAt: "text", nextBoundaryAt: "nullableText", effectiveThroughTeachingWeekId: "nullableText", reason: "text",
  fees: { items: { fields: {
    feeId: "text", version: "text", teachingWeekId: "text", settlementMonth: "text", refundId: "nullableText",
    snapshotId: "nullableText", sequenceNo: "nullableText", snapshotHash: "nullableText", policyVersionId: "nullableText",
    netMonthlyCents: "nullableText", disposition: "text",
  } } },
  totals: { fields: { consideredFeeCount: "count", changedFeeCount: "count", zeroShareFeeCount: "count", excludedRefundCount: "count", plannerDeltaCents: "text", sourceMentorDeltaCents: "text", destinationMentorDeltaCents: "text" } },
} };
const teachingMentorImpactShape: RelationshipJsonShape = { fields: {
  schemaVersion: "text", teacherPersonId: "text",
  effectiveWeek: { fields: { id: "text", startsOn: "text", endsOn: "text", settlementMonth: "text", kind: "text" } },
  effectiveAt: "text", nextBoundaryAt: "nullableText", effectiveThroughTeachingWeekId: "nullableText", sourceRelationship: { ...relationshipShape, nullable: true },
  nextRelationship: { ...relationshipShape, nullable: true },
  candidate: { fields: { personId: "text", nickname: "text", userAccountId: "text", roleAssignmentId: "text", roleValidFrom: "text", roleValidTo: "nullableText" } },
  destinationAccount: { fields: { id: "text", code: "text", ownerType: "text", ownerId: "text", status: "text" } },
  reason: "text",
  fees: { items: { fields: {
    feeEntryId: "text", feeVersion: "text", grossAmountCents: "text", teachingWeekId: "text", weekStartsOn: "text",
    settlementMonth: "text", disposition: "text", refundEffectId: "nullableText", previousSnapshotId: "nullableText",
    previousSnapshotSequence: "nullableText", previousSnapshotHash: "nullableText", policyVersionId: "nullableText",
    netMonthlyCents: "nullableText", teachingMentorAmountCents: "text", sourceAccountId: "nullableText", sourceAccountCode: "nullableText",
  } } },
  totals: { fields: { consideredFeeCount: "count", movedFeeCount: "count", zeroShareFeeCount: "count", excludedRefundCount: "count", movedAmountCents: "text" } },
} };
const sameInstant = (left: unknown, right: unknown): boolean => {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftTime = Date.parse(left); const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime;
};
const validInstantRange = (start: unknown, end: unknown): boolean => {
  if (end === null) return typeof start === "string" && Number.isFinite(Date.parse(start));
  if (typeof start !== "string" || typeof end !== "string") return false;
  const startTime = Date.parse(start); const endTime = Date.parse(end);
  return Number.isFinite(startTime) && Number.isFinite(endTime) && endTime > startTime;
};

const validatePlanningMentorRelationship = (input: JsonTransformInput): TransformAnomaly[] => {
  const action = input.row.action;
  if (action !== "ADD" && action !== "REMOVE") gap();
  const expectsNull = (action === "ADD" && input.columnName === "before_json") || (action === "REMOVE" && input.columnName === "after_json");
  if (expectsNull) {
    if (input.raw === null) return [];
    gap();
  }
  if (input.raw === null) gap();
  const root = parseObject(input);
  const anomalies = validateRelationshipJson(input, root, planningMentorRelationshipObjectShape);
  if (root.relationshipType !== "PLANNING_MENTOR") gap();
  return anomalies;
};

const validatePlanningMentorImpact = (input: JsonTransformInput, root: Record<string, unknown>): TransformAnomaly[] => {
  const anomalies = validateRelationshipJson(input, root, planningMentorImpactShape);
  if (root.action !== "ADD" && root.action !== "REMOVE") gap();
  if (input.row.action !== "ADD" && input.row.action !== "REMOVE") gap();
  if (input.row.action !== root.action) gap();
  const source = object(root.sourceRelationship);
  if (root.action === "ADD" && (root.sourceRelationship !== null || typeof root.resultRelationshipId !== "string" || root.resultRelationshipId.length === 0)) gap();
  if (root.action === "REMOVE" && (source === undefined || root.resultRelationshipId !== null)) gap();
  if (root.schemaVersion !== "planning-mentor-relationship-preview.v1") anomalies.push(anomaly(input, "schemaVersion"));
  if (source !== undefined && source.relationshipType !== "PLANNING_MENTOR") gap();
  if (Array.isArray(root.fees)) {
    for (const fee of root.fees) {
      const item = object(fee);
      if (item === undefined) continue;
      if (!["REFUNDED", "UNCHANGED", "CHANGE"].includes(String(item.disposition))) anomalies.push(anomaly(input, "disposition"));
    }
  }
  const totals = object(root.totals);
  if (totals !== undefined) {
    for (const field of ["plannerDeltaCents", "mentorDeltaCents"]) {
      if (typeof totals[field] !== "string" || !/^-?\d+$/.test(totals[field])) anomalies.push(anomaly(input, field));
    }
  }
  return anomalies;
};

const validatePlanningMentorDelta = (input: JsonTransformInput, root: Record<string, unknown>): TransformAnomaly[] => {
  const anomalies = validateRelationshipJson(input, root, planningMentorDeltaShape);
  const entries = root.entries;
  if (!Array.isArray(entries)) return anomalies;
  for (const entry of entries) {
    const item = object(entry);
    if (item === undefined) continue;
    if (typeof item.accountKey !== "string" || item.accountKey.length === 0) anomalies.push(anomaly(input, "accountKey"));
    if (typeof item.categoryKey !== "string" || !settlementKeys.includes(item.categoryKey)) gap();
    if (typeof item.amountCents !== "string" || !/^-?\d+$/.test(item.amountCents)) anomalies.push(anomaly(input, "amountCents"));
  }
  return anomalies;
};

const validateAdminPlanningMentorRelationship = (input: JsonTransformInput): TransformAnomaly[] => {
  const action = input.row.action;
  if (action !== "ADD" && action !== "REPLACE" && action !== "REMOVE") gap();
  if (input.raw === null) gap();
  const root = parseObject(input);
  const shape: RelationshipJsonShape = input.columnName === "before_json"
    ? { fields: { sourceRelationship: adminPlanningMentorRelationshipShape } }
    : { fields: { sourceRelationship: adminPlanningMentorRelationshipShape, resultRelationship: adminPlanningMentorRelationshipShape, continuationRelationship: adminPlanningMentorRelationshipShape } };
  const anomalies = validateRelationshipJson(input, root, shape);
  const source = object(root.sourceRelationship);
  const result = object(root.resultRelationship);
  const continuation = object(root.continuationRelationship);
  if ((action === "ADD" && input.columnName === "before_json" && root.sourceRelationship !== null)
    || ((action === "REPLACE" || action === "REMOVE") && source === undefined)
    || (input.columnName === "after_json" && ((action === "ADD" || action === "REPLACE") && result === undefined || (action === "REMOVE" && root.resultRelationship !== null)))) gap();
  for (const fact of [source, result, continuation]) if (fact !== undefined && fact.relationshipType !== "PLANNING_MENTOR") gap();
  return anomalies;
};

const validateAdminPlanningMentorImpact = (input: JsonTransformInput, root: Record<string, unknown>): TransformAnomaly[] => {
  const anomalies = validateRelationshipJson(input, root, adminPlanningMentorImpactShape);
  if (root.action !== "ADD" && root.action !== "REPLACE" && root.action !== "REMOVE") gap();
  if (input.row.action !== "ADD" && input.row.action !== "REPLACE" && input.row.action !== "REMOVE") gap();
  if (input.row.action !== root.action) gap();
  if (root.effectiveThroughTeachingWeekId !== (input.row.effective_through_teaching_week_id ?? null)) gap();
  const source = object(root.sourceRelationship);
  if ((root.action === "ADD" || root.action === "REPLACE") && (typeof root.resultRelationshipId !== "string" || root.resultRelationshipId.length === 0)) gap();
  if (root.action === "ADD" && root.sourceRelationship !== null) gap();
  if ((root.action === "REPLACE" || root.action === "REMOVE") && source === undefined) gap();
  if (root.action === "REMOVE" && root.resultRelationshipId !== null) gap();
  if (root.schemaVersion !== "admin-planning-mentor-relationship-preview.v1") anomalies.push(anomaly(input, "schemaVersion"));
  if (source !== undefined && source.relationshipType !== "PLANNING_MENTOR") gap();
  if (Array.isArray(root.fees)) {
    for (const fee of root.fees) {
      const item = object(fee);
      if (item === undefined) continue;
      if (!["REFUNDED", "UNCHANGED", "CHANGE"].includes(String(item.disposition))) anomalies.push(anomaly(input, "disposition"));
    }
  }
  const totals = object(root.totals);
  if (totals !== undefined) for (const field of ["plannerDeltaCents", "sourceMentorDeltaCents", "destinationMentorDeltaCents"])
    if (typeof totals[field] !== "string" || !/^-?\d+$/.test(totals[field])) anomalies.push(anomaly(input, field));
  return anomalies;
};

const validatePersonCampusAssignment = (input: JsonTransformInput): TransformAnomaly[] => {
  if (input.raw === null) gap();
  const root = parseObject(input);
  const shape: RelationshipJsonShape = input.columnName === "before_json"
    ? { fields: { assignment: personCampusAssignmentShape, campusPrincipalRelationship: { ...personCampusPrincipalShape, nullable: true } } }
    : { fields: { assignment: personCampusResultAssignmentShape, campusPrincipalRelationship: personCampusResultPrincipalShape } };
  const anomalies = validateRelationshipJson(input, root, shape);
  const assignment = object(root.assignment);
  const relationship = object(root.campusPrincipalRelationship);
  if (assignment === undefined || (input.columnName === "before_json" && relationship !== undefined && relationship.relationshipType !== "CAMPUS_PRINCIPAL")) gap();
  return anomalies;
};

const validatePersonCampusAssignmentImpact = (input: JsonTransformInput, root: Record<string, unknown>): TransformAnomaly[] => {
  const anomalies = validateRelationshipJson(input, root, personCampusAssignmentImpactShape);
  if (root.schemaVersion !== "person-campus-assignment-preview.v1") anomalies.push(anomaly(input, "schemaVersion"));
  const source = object(root.sourceCampusPrincipalRelationship);
  if (source !== undefined && source.relationshipType !== "CAMPUS_PRINCIPAL") gap();
  return anomalies;
};

const validatePersonCampusAssignmentDelta = (input: JsonTransformInput, root: Record<string, unknown>): TransformAnomaly[] => {
  const anomalies = validateRelationshipJson(input, root, planningMentorDeltaShape);
  const entries = root.entries;
  if (!Array.isArray(entries)) return anomalies;
  for (const entry of entries) {
    const item = object(entry);
    if (item === undefined) continue;
    if (typeof item.accountKey !== "string" || item.accountKey.length === 0) anomalies.push(anomaly(input, "accountKey"));
    if (typeof item.categoryKey !== "string" || !settlementKeys.includes(item.categoryKey)) gap();
    if (typeof item.amountCents !== "string" || !/^-?\d+$/.test(item.amountCents)) anomalies.push(anomaly(input, "amountCents"));
  }
  return anomalies;
};

const validateCampusRegionAssignment = (input: JsonTransformInput): TransformAnomaly[] => {
  if (input.raw === null) gap();
  const root = parseObject(input);
  const shape: RelationshipJsonShape = { fields: { campusRegionAssignment: input.columnName === "before_json" ? campusRegionAssignmentShape : campusRegionResultAssignmentShape } };
  return validateRelationshipJson(input, root, shape);
};

const validateCampusRegionPersonEffect = (input: JsonTransformInput): TransformAnomaly[] => {
  if (input.raw === null) gap();
  return validateRelationshipJson(input, parseObject(input), input.columnName === "before_json" ? personCampusAssignmentShape : personCampusResultAssignmentShape);
};

const validateCampusRegionAssignmentImpact = (input: JsonTransformInput, root: Record<string, unknown>): TransformAnomaly[] => {
  const anomalies = validateRelationshipJson(input, root, campusRegionAssignmentImpactShape);
  if (root.schemaVersion !== "campus-region-assignment-preview.v1") anomalies.push(anomaly(input, "schemaVersion"));
  const financial = object(root.financial);
  if (financial !== undefined) {
    for (const collection of [financial.accountDeltas, financial.fees]) if (Array.isArray(collection)) {
      for (const item of collection) {
        const fact = object(item);
        if (fact !== undefined && typeof fact.amountCents === "string" && !/^-?\d+$/.test(fact.amountCents)) anomalies.push(anomaly(input, "amountCents"));
      }
    }
  }
  return anomalies;
};

const validateCampusRegionAssignmentDelta = (input: JsonTransformInput, root: Record<string, unknown>): TransformAnomaly[] =>
  validatePersonCampusAssignmentDelta(input, root);

const validateTeachingMentorRelationship = (input: JsonTransformInput): TransformAnomaly[] => {
  const action = input.row.action;
  if (action !== "ADD" && action !== "REPLACE") gap();
  if (input.raw === null) gap();
  const root = parseObject(input);
  const continuationId = input.row.continuation_relationship_id ?? null;
  const shape: RelationshipJsonShape = input.columnName === "before_json"
    ? { fields: { sourceRelationship: { ...relationshipShape, nullable: true } } }
      : { fields: continuationId === null
      ? { sourceRelationship: { ...relationshipShape, nullable: true }, resultRelationship: relationshipShape }
      : { sourceRelationship: { ...relationshipShape, nullable: true }, resultRelationship: relationshipShape, continuationRelationship: relationshipShape } };
  const anomalies = validateRelationshipJson(input, root, shape);
  const source = object(root.sourceRelationship);
  const result = object(root.resultRelationship);
  const continuation = object(root.continuationRelationship);
  const invalidContinuation = continuationId === null
    ? continuation !== undefined
    : continuation === undefined
      || continuation.id !== continuationId
      || continuation.teacherPersonId !== input.row.teacher_person_id
      || continuation.relationshipType !== "TEACHING_MENTOR"
      || continuation.relatedPersonId !== input.row.source_related_person_id
      || !sameInstant(continuation.validFrom, input.row.next_boundary_at)
      || !validInstantRange(continuation.validFrom, continuation.validTo)
      || continuation.effectiveScope !== source?.effectiveScope
      || continuation.createdByPersonId !== input.row.published_by_person_id
      || !sameInstant(continuation.createdAt, input.row.published_at)
      || continuation.supersededAt !== null
      || continuation.supersededByChangeId !== null;
  if ((action === "ADD" && root.sourceRelationship !== null)
    || (action === "REPLACE" && source === undefined)
    || (input.columnName === "before_json" && continuation !== undefined)
    || (input.columnName === "after_json" && invalidContinuation)
    || (source !== undefined && source.relationshipType !== "TEACHING_MENTOR")
    || (result !== undefined && result.relationshipType !== "TEACHING_MENTOR")) gap();
  return anomalies;
};

const validateTeachingMentorImpact = (input: JsonTransformInput, root: Record<string, unknown>): TransformAnomaly[] => {
  const anomalies = validateRelationshipJson(input, root, teachingMentorImpactShape);
  if (root.schemaVersion !== "teaching-mentor-change-preview.v1") anomalies.push(anomaly(input, "schemaVersion"));
  const source = object(root.sourceRelationship);
  const next = object(root.nextRelationship);
  if ((input.row.action === "ADD" && root.sourceRelationship !== null) || (input.row.action === "REPLACE" && source === undefined)
    || (input.row.action !== "ADD" && input.row.action !== "REPLACE")
    || root.effectiveThroughTeachingWeekId !== (input.row.effective_through_teaching_week_id ?? null)
    || (input.row.effective_through_teaching_week_id !== null && input.row.effective_through_teaching_week_id !== undefined && root.nextBoundaryAt === null)
    || (source !== undefined && source.relationshipType !== "TEACHING_MENTOR")
    || (next !== undefined && next.relationshipType !== "TEACHING_MENTOR")) gap();
  const week = object(root.effectiveWeek);
  if (week?.kind !== "REGULAR") gap();
  if (Array.isArray(root.fees)) {
    for (const fee of root.fees) {
      const item = object(fee);
      if (item === undefined) continue;
      if (!["REFUNDED", "ZERO_SHARE", "MOVE"].includes(String(item.disposition))) anomalies.push(anomaly(input, "disposition"));
      if (typeof item.teachingMentorAmountCents !== "string" || !/^\d+$/.test(item.teachingMentorAmountCents)) anomalies.push(anomaly(input, "teachingMentorAmountCents"));
    }
  }
  const totals = object(root.totals);
  if (totals !== undefined && (typeof totals.movedAmountCents !== "string" || !/^\d+$/.test(totals.movedAmountCents))) {
    anomalies.push(anomaly(input, "movedAmountCents"));
  }
  return anomalies;
};

/** Unknown structure fails closed; malformed known business scalars remain exportable with an anomaly. */
const validateRelationshipJson = (input: JsonTransformInput, value: unknown, shape: RelationshipJsonShape, field?: string): TransformAnomaly[] => {
  if (typeof shape === "string") {
    if (Array.isArray(value) || object(value) !== undefined) gap();
    const valid = shape === "count"
      ? typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      : shape === "boolean"
        ? typeof value === "boolean"
      : typeof value === "string" || (shape === "nullableText" && value === null);
    return valid ? [] : [anomaly(input, field)];
  }
  if ("items" in shape) {
    if (object(value) !== undefined) gap();
    if (!Array.isArray(value)) return [anomaly(input, field)];
    return value.flatMap(item => validateRelationshipJson(input, item, shape.items, field));
  }
  if (value === null && shape.nullable) return [];
  if (Array.isArray(value)) gap();
  const candidate = object(value);
  if (candidate === undefined) return [anomaly(input, field)];
  if (Object.keys(candidate).some(key => !Object.hasOwn(shape.fields, key))) gap();
  return Object.entries(shape.fields).flatMap(([key, child]) => validateRelationshipJson(input, candidate[key], child, key));
};

const knownJson = (input: JsonTransformInput): TransformAnomaly[] => {
  if (input.tableName === "campus_region_assignment_change_preview" && input.columnName === "impact_json")
    return validateCampusRegionAssignmentImpact(input, parseObject(input));
  if (input.tableName === "campus_region_assignment_change" && (input.columnName === "before_json" || input.columnName === "after_json"))
    return validateCampusRegionAssignment(input);
  if (input.tableName === "campus_region_assignment_person_effect" && (input.columnName === "before_json" || input.columnName === "after_json"))
    return validateCampusRegionPersonEffect(input);
  if (input.tableName === "campus_region_assignment_settlement_effect" && input.columnName === "delta_json")
    return validateCampusRegionAssignmentDelta(input, parseObject(input));
  if (input.tableName === "person_campus_assignment_change_preview" && input.columnName === "impact_json")
    return validatePersonCampusAssignmentImpact(input, parseObject(input));
  if (input.tableName === "person_campus_assignment_change" && (input.columnName === "before_json" || input.columnName === "after_json"))
    return validatePersonCampusAssignment(input);
  if (input.tableName === "person_campus_assignment_change_effect" && input.columnName === "delta_json")
    return validatePersonCampusAssignmentDelta(input, parseObject(input));
  const key = `${input.tableName}.${input.columnName}`;
  if (key === "admin_planning_mentor_relationship_change.before_json" || key === "admin_planning_mentor_relationship_change.after_json")
    return validateAdminPlanningMentorRelationship(input);
  if (key === "planning_mentor_relationship_change.before_json" || key === "planning_mentor_relationship_change.after_json")
    return validatePlanningMentorRelationship(input);
  if (key === "teaching_mentor_relationship_change.before_json" || key === "teaching_mentor_relationship_change.after_json")
    return validateTeachingMentorRelationship(input);
  const root = parseObject(input);
  switch (`${input.tableName}.${input.columnName}`) {
    case "person_relationship_change_preview.impact_json": return validateRelationshipJson(input, root, relationshipImpactShape);
    case "person_relationship_change.before_json": return validateRelationshipJson(input, root, { fields: { sourceRelationship: relationshipShape } });
    case "person_relationship_change.after_json": return validateRelationshipJson(input, root, { fields: { sourceRelationship: relationshipShape, resultRelationship: relationshipShape } });
    case "admin_planning_mentor_relationship_change_preview.impact_json": return validateAdminPlanningMentorImpact(input, root);
    case "admin_planning_mentor_relationship_change_effect.delta_json": return validatePlanningMentorDelta(input, root);
    case "planning_mentor_relationship_change_preview.impact_json": return validatePlanningMentorImpact(input, root);
    case "planning_mentor_relationship_change_effect.delta_json": return validatePlanningMentorDelta(input, root);
    case "teaching_mentor_relationship_change_preview.impact_json": return validateTeachingMentorImpact(input, root);
    case "weekly_fee_allocation_snapshot.snapshot_json": case "weekly_fee_refund_effect.snapshot_json": return validateSnapshot(input, root);
    case "weekly_fee_allocation_snapshot.context_json": return validateWeeklyContext(input, root);
    case "rate_policy_version.policy_json": return [...exactKeys(input, root, policyKeys, undefined, { strings: policyKeys.filter((field) => field !== "dynamicTiers") }), ...validateDynamicTiers(input, root)];
    case "finance_refund_submission.applicant_context_snapshot": return validateApplicantSnapshot(input, root, "REFUND");
    case "finance_reimbursement_submission.applicant_context_snapshot": return validateApplicantSnapshot(input, root, "REIMBURSEMENT");
    case "finance_refund_decision.authorization_snapshot": return validateReviewerDecision(input, root, "REFUND");
    case "finance_reimbursement_decision.authorization_snapshot": return validateReviewerDecision(input, root, "REIMBURSEMENT");
    case "finance_reimbursement_transfer.authorization_snapshot": return validateReimbursementTransferAuthorization(input, root);
    case "finance_reimbursement_reversal.authorization_snapshot": return [...exactKeys(input, root, ["originalTransferAuthorization", "originalLedgerEventId", "originalExecutedByPersonId", "actorPersonId", "actorSubjectCode", "actorScopeType", "processingMode"], undefined, { strings: ["originalLedgerEventId", "originalExecutedByPersonId", "actorPersonId", "actorSubjectCode", "actorScopeType", "processingMode"] }), ...validateReimbursementTransferAuthorization(input, root.originalTransferAuthorization)];
    case "finance_self_purchase_transfer.authorization_snapshot": return validateSelfPurchaseAuthorization(input, root);
    case "finance_self_purchase_reversal.authorization_snapshot": return [...exactKeys(input, root, ["actorPersonId", "actorSubjectCode", "actorScopeType", "processingMode", "originalLedgerEventId", "originalTransferAuthorization"], undefined, { strings: ["actorPersonId", "actorSubjectCode", "actorScopeType", "processingMode", "originalLedgerEventId"] }), ...validateSelfPurchaseAuthorization(input, root.originalTransferAuthorization)];
    case "finance_withdrawal_submission.authorization_snapshot": {
      if (input.row.authorization_kind === "PERSON_OWNER") return exactKeys(input, root, ["authorizationKind", "sourceAccountId", "personId"], undefined, { strings: ["authorizationKind", "sourceAccountId", "personId"] });
      if (input.row.authorization_kind === "VENUE_OWNER") return exactKeys(input, root, ["authorizationKind", "venueId", "venueOwnerPersonId"], undefined, { strings: ["authorizationKind", "venueId", "venueOwnerPersonId"] });
      if (input.row.authorization_kind === "VENUE_GRANT") return exactKeys(input, root, ["authorizationKind", "venueId", "venueOwnerPersonId", "grantId", "granteePersonId", "validFrom", "validTo"], undefined, { strings: ["authorizationKind", "venueId", "venueOwnerPersonId", "grantId", "granteePersonId", "validFrom", "validTo"] });
      return gap();
    }
    default: return gap();
  }
};

export const KNOWN_FINANCE_EVENT_SCHEMAS: Readonly<Record<string, readonly string[] | null>> = {
  CREATED: null, SALARY_BENEFIT_COMPLETED: null, SALARY_BENEFIT_REVERSED: null,
  SUBMITTED: ["approvalMode", "sourceAccountId", "sourceOwnerType", "amountCents", "authorizationKind"], TRANSFERRED: ["completionAttachmentCount"], REVOKED: ["reason", "amountCents"],
  REIMBURSEMENT_SUBMITTED: ["amountCents", "reason", "destinationAccountId", "applicantContext"], REIMBURSEMENT_APPROVED: ["processingMode", "decision", "reason", "reviewerContext"], REIMBURSEMENT_REJECTED: ["processingMode", "decision", "reason", "reviewerContext"],
  REIMBURSEMENT_REVERSED: ["processingMode", "reason", "originalLedgerEventId", "actorSubjectCode", "actorScopeType"],
  REIMBURSEMENT_COMPLETED: ["processingMode", "amountCents", "sourceAccountId", "destinationAccountId"],
  REFUND_SUBMITTED: ["reason", "referralCaseId", "studentRecordId", "weeklyFeeEntryIds", "applicantContext"], REFUND_APPROVED: ["reason", "processingMode", "approvedGrossAmountCents"], REFUND_REJECTED: ["reason", "processingMode", "approvedGrossAmountCents"],
  AUTO_COMPLETED: ["processingMode", "amountCents", "sourceAccountId", "destinationAccountId", "applicantContextSubject", "applicantContextScope", "applicantContextRegionId", "applicantContextCampusId", "applicantContextVenueId"], TRANSFER_REVERSED: ["processingMode", "reason", "originalLedgerEventId", "actorSubjectCode", "actorScopeType"],
};
const eventJson = (input: JsonTransformInput): TransformAnomaly[] => {
  const eventType = input.row.event_type ?? "";
  const allowed = KNOWN_FINANCE_EVENT_SCHEMAS[eventType];
  if (allowed === undefined) return gap();
  if (allowed === null) return input.raw === null ? [] : input.raw === "null" ? [anomaly(input)] : gap();
  // The event type is known before this branch, so a missing details value is a
  // historical value anomaly.  It must not make an unknown event acceptable.
  if (input.raw === null || input.raw === "null") return [anomaly(input)];
  const root = parseObject(input);
  const nested = ["applicantContext", "reviewerContext"];
  const scalarArrays = ["weeklyFeeEntryIds"];
  const numericFields = eventType === "TRANSFERRED" ? ["completionAttachmentCount"] : [];
  const anomalies = exactKeys(input, root, allowed, undefined, {
    strings: allowed.filter((field) => !nested.includes(field) && !scalarArrays.includes(field) && !numericFields.includes(field)),
    numbers: numericFields,
  });
  if (eventType === "REIMBURSEMENT_SUBMITTED") anomalies.push(...validateApplicantSnapshot(input, root.applicantContext, "REIMBURSEMENT"));
  if (eventType === "REFUND_SUBMITTED") anomalies.push(...validateApplicantSnapshot(input, root.applicantContext, "REFUND"));
  if (eventType === "REFUND_SUBMITTED") anomalies.push(...validateScalarArray(input, root.weeklyFeeEntryIds, "weeklyFeeEntryIds"));
  if (eventType === "REIMBURSEMENT_APPROVED" || eventType === "REIMBURSEMENT_REJECTED") anomalies.push(...validateReviewerDecision(input, root.reviewerContext, "REIMBURSEMENT"));
  return anomalies;
};

export const KNOWN_RESULT_OPERATIONS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  bonus_project_catalog_command_idempotency: { RENAME: ["projectNo", "nameVersionId", "nameVersion", "displayName", "changedByPersonId", "changeSource", "changedAt", "replay"] },
  company_finance_fund_command_idempotency: { CREATE: ["id", "accountId", "accountCode", "fundCode", "displayName", "status", "version", "replay"], ASSIGN: ["id", "fundId", "validFrom", "previousAssignmentId", "replay"], SET_STATUS: ["id", "accountId", "accountCode", "fundCode", "displayName", "status", "version", "replay"] },
  venue_command_idempotency: { CREATE: ["id", "ownerPersonId", "name", "status", "defaultForOwner", "version", "accountId", "accountCode", "replay"], RENAME: ["id", "ownerPersonId", "name", "status", "defaultForOwner", "version", "accountId", "accountCode", "replay"], STATUS: ["id", "ownerPersonId", "name", "status", "defaultForOwner", "version", "accountId", "accountCode", "replay"], DEFAULT: ["id", "ownerPersonId", "name", "status", "defaultForOwner", "version", "accountId", "accountCode", "previousDefaultVenueId", "replay"], PERMISSION: ["id", "venueId", "granteePersonId", "canView", "canWithdraw", "validFrom", "validTo", "version", "replay"] },
  salary_benefit_command_idempotency: { CREATE_DOCUMENT: ["id", "kind", "version", "replay"], SET_WAGE_PLAN: ["id", "planVersionId", "subjectPersonId", "month", "kind", "replay"], GENERATE_WAGE_TODOS: [], CONFIRM_WAGE: ["id", "status", "version", "replay"], GRANT_BONUS: ["id", "status", "version", "replay"], SET_BENEFIT_PLAN: ["id", "planVersionId", "subjectPersonId", "month", "kind", "replay"], GENERATE_BENEFIT_TODOS: [], CONFIRM_BENEFIT: ["id", "status", "version", "replay"], REVERSE_POSTING: ["id", "status", "version", "replay"] },
};
const resultJson = (input: JsonTransformInput): TransformAnomaly[] => {
  const operation = input.row.operation ?? ""; const allowed = KNOWN_RESULT_OPERATIONS[input.tableName]?.[operation]; if (allowed === undefined) return gap();
  if (operation === "GENERATE_WAGE_TODOS" || operation === "GENERATE_BENEFIT_TODOS") {
    if (input.raw === null) return [anomaly(input)];
    try {
      const parsed: unknown = JSON.parse(input.raw);
      const list: unknown[] = Array.isArray(parsed) ? parsed : gap();
      const itemKeys = ["id", "planVersionId", "subjectPersonId", "month", "kind"];
      return list.flatMap((item) => exactKeys(input, nestedObject(item), itemKeys, undefined, { strings: itemKeys }));
    } catch (error) {
      if (error instanceof Error && error.message === "EXPORT_TRANSFORM_SCHEMA_GAP") throw error;
      return gap();
    }
  }
  const booleans = ["defaultForOwner", "canView", "canWithdraw", "can_view", "can_withdraw", "replay"];
  const numbers = ["version", "nameVersion", "projectNo"];
  return exactKeys(input, parseObject(input), allowed, allowed.filter((field) => field !== "replay"), {
    strings: allowed.filter((field) => !booleans.includes(field) && !numbers.includes(field)),
    booleans,
    numbers,
  });
};

const auditExact = (input: JsonTransformInput, value: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = [], numericFields: readonly string[] = ["version", "nameVersion", "projectNo"]): TransformAnomaly[] => {
  const booleans = ["defaultForOwner", "canView", "canWithdraw", "can_view", "can_withdraw", "replay"];
  return exactKeys(input, value, allowed, required, {
    strings: allowed.filter((field) => !booleans.includes(field) && !numericFields.includes(field)),
    booleans,
    numbers: numericFields,
  });
};

const auditJson = (input: JsonTransformInput): TransformAnomaly[] => {
  if (input.row.action_code === "CAMPUS_REGION_ASSIGNMENT_CHANGED" && input.row.subject_type === "CAMPUS_REGION_ASSIGNMENT_CHANGE") {
    if (input.raw === null) return [];
    return validateCampusRegionAssignment(input);
  }
  if (input.row.action_code === "PERSON_CAMPUS_ASSIGNMENT_CHANGED"
    && (input.row.subject_type === "PERSON_CAMPUS_ASSIGNMENT_CHANGE" || input.row.subject_type === "PERSON_CAMPUS_ASSIGNMENT")) {
    if (input.raw === null) return [];
    return validatePersonCampusAssignment(input);
  }
  if (input.row.subject_type === "PERSON_RELATIONSHIP" && input.row.action_code === "GROUP_LEADER_RELATIONSHIP_CHANGED") {
    if (input.raw === null) return [];
    return validateRelationshipJson(input, parseObject(input), { fields: input.columnName === "before_json"
      ? { sourceRelationship: relationshipShape }
      : { sourceRelationship: relationshipShape, resultRelationship: relationshipShape } });
  }
  if (input.row.subject_type === "PERSON_RELATIONSHIP" && input.row.action_code === "TEACHING_MENTOR_RELATIONSHIP_CHANGED") {
    if (input.raw === null) return [];
    const root = parseObject(input);
    const continuation = object(root.continuationRelationship);
    const shape: RelationshipJsonShape = input.columnName === "before_json"
      ? { fields: { sourceRelationship: { ...relationshipShape, nullable: true } } }
      : { fields: continuation === undefined
        ? { sourceRelationship: { ...relationshipShape, nullable: true }, resultRelationship: relationshipShape }
        : { sourceRelationship: { ...relationshipShape, nullable: true }, resultRelationship: relationshipShape, continuationRelationship: relationshipShape } };
    const anomalies = validateRelationshipJson(input, root, shape);
    const source = object(root.sourceRelationship);
    const result = object(root.resultRelationship);
    if ((source !== undefined && source.relationshipType !== "TEACHING_MENTOR") || (result !== undefined && result.relationshipType !== "TEACHING_MENTOR")
      || (continuation !== undefined && (continuation.relationshipType !== "TEACHING_MENTOR" || continuation.supersededAt !== null || continuation.supersededByChangeId !== null))) gap();
    return anomalies;
  }
  if (input.row.subject_type === "PERSON_RELATIONSHIP" && (input.row.action_code === "PLANNING_MENTOR_RELATIONSHIP_ADDED" || input.row.action_code === "PLANNING_MENTOR_RELATIONSHIP_REMOVED")) {
    const action = input.row.action_code === "PLANNING_MENTOR_RELATIONSHIP_ADDED" ? "ADD" : "REMOVE";
    const expectsNull = (action === "ADD" && input.columnName === "before_json") || (action === "REMOVE" && input.columnName === "after_json");
    if (expectsNull) { if (input.raw === null) return []; gap(); }
    if (input.raw === null) gap();
    const root = parseObject(input);
    if (root.relationshipType !== "PLANNING_MENTOR") gap();
    return validateRelationshipJson(input, root, planningMentorRelationshipObjectShape);
  }
  if (input.row.subject_type === "PERSON_RELATIONSHIP" && [
    "PLANNING_MENTOR_RELATIONSHIP_ADDED_BY_ADMIN",
    "PLANNING_MENTOR_RELATIONSHIP_REPLACED_BY_ADMIN",
    "PLANNING_MENTOR_RELATIONSHIP_REMOVED_BY_ADMIN",
  ].includes(input.row.action_code ?? "")) {
    const action = input.row.action_code === "PLANNING_MENTOR_RELATIONSHIP_ADDED_BY_ADMIN"
      ? "ADD"
      : input.row.action_code === "PLANNING_MENTOR_RELATIONSHIP_REPLACED_BY_ADMIN"
        ? "REPLACE"
        : "REMOVE";
    return validateAdminPlanningMentorRelationship({ ...input, row: { ...input.row, action } });
  }
  const subject = input.row.subject_type; const action = input.row.action_code; const venueActions = ["VENUE_CREATED", "VENUE_RENAMED", "VENUE_STATUS_CHANGED", "VENUE_DEFAULT_CHANGED", "VENUE_PERMISSION_CHANGED"];
  if (subject === "USER_ACCOUNT" && action === "ACCOUNT_REGISTERED") {
    if (input.columnName === "before_json") {
      if (input.raw === null) return [];
      if (input.raw === "null") return [anomaly(input)];
      return gap();
    }
    if (input.raw === null || input.raw === "null") return [anomaly(input)];
    const root = parseObject(input);
    const anomalies = auditExact(input, root, ["baseSubject", "scope"], ["baseSubject", "scope"], []);
    if (typeof root.baseSubject === "string" && root.baseSubject !== "TEACHER")
      anomalies.push(anomaly(input, "baseSubject"));
    if (typeof root.scope === "string" && root.scope !== "SELF")
      anomalies.push(anomaly(input, "scope"));
    return anomalies;
  }
  if (subject === "USER_ACCOUNT" && action === "ACCOUNT_PASSWORD_RESET") {
    if (input.raw === null || input.raw === "null") return [anomaly(input)];
    const root = parseObject(input);
    const anomalies = auditExact(input, root, ["authVersion"], ["authVersion"], []);
    if (typeof root.authVersion === "string" && !/^[1-9]\d*$/.test(root.authVersion))
      anomalies.push(anomaly(input, "authVersion"));
    return anomalies;
  }
  if (subject === "PERSON" && action === "PERSON_PROFILE_CHANGED") {
    if (input.raw === null || input.raw === "null") return [anomaly(input)];
    const root = parseObject(input);
    const anomalies = auditExact(input, root, ["nickname", "legalName", "profileVersion"], ["nickname", "legalName", "profileVersion"], []);
    if (typeof root.nickname === "string" && root.nickname.trim() === "") anomalies.push(anomaly(input, "nickname"));
    if (typeof root.legalName === "string" && root.legalName.trim() === "") anomalies.push(anomaly(input, "legalName"));
    if (typeof root.profileVersion === "string" && !/^[1-9][0-9]*$/.test(root.profileVersion)) anomalies.push(anomaly(input, "profileVersion"));
    return anomalies;
  }
  if (subject === "VENUE" && venueActions.includes(action ?? "")) { if (input.raw === null) return []; if (input.raw === "null") return [anomaly(input)]; if (action === "VENUE_PERMISSION_CHANGED" && input.columnName === "before_json") return auditExact(input, parseObject(input), ["id", "venue_id", "grantee_person_id", "can_view", "can_withdraw", "valid_from", "valid_to", "version"], [], []); return auditExact(input, parseObject(input), ["id", "venueId", "ownerPersonId", "name", "status", "defaultForOwner", "version", "accountId", "accountCode", "previousDefaultVenueId", "granteePersonId", "canView", "canWithdraw", "validFrom", "validTo", "replay"]); }
  const companyActions = ["COMPANY_FUND_CREATED", "COMPANY_FUND_ASSIGNMENT_CONFIRMED", "COMPANY_FUND_ASSIGNED", "COMPANY_FUND_STATUS_SET"];
  if (subject === "COMPANY_FINANCE_FUND" && companyActions.includes(action ?? "")) { if (input.raw === null) return []; if (input.raw === "null") return [anomaly(input)]; return auditExact(input, parseObject(input), ["id", "fundId", "accountId", "accountCode", "fundCode", "displayName", "status", "version", "validFrom", "previousAssignmentId"]); }
  if (subject === "BONUS_PROJECT_NAME_VERSION" && action === "BONUS_PROJECT_NAME_SET") { if (input.raw === null) return []; if (input.raw === "null") return [anomaly(input)]; return auditExact(input, parseObject(input), ["projectNo", "nameVersionId", "nameVersion", "displayName", "changedByPersonId", "changeSource", "changedAt", "replay"]); }
  const readAuditActions: Readonly<Record<string, readonly string[]>> = {
    FINANCE_ATTACHMENT_VERSION: ["ATTACHMENT_DOWNLOAD_SUCCEEDED", "ATTACHMENT_DOWNLOAD_DENIED", "ATTACHMENT_INTEGRITY_FAILED", "ATTACHMENT_UPLOAD_DENIED"],
    FINANCE_WITHDRAWAL: ["WITHDRAWAL_DETAIL_READ", "WITHDRAWAL_DETAIL_DENIED", "WITHDRAWAL_DETAIL_INTEGRITY_FAILED"],
    FINANCE_REFUND: ["REFUND_DETAIL_READ", "REFUND_DETAIL_DENIED", "REFUND_DETAIL_INTEGRITY_FAILED"],
    FINANCE_SELF_PURCHASE: ["SELF_PURCHASE_DETAIL_READ", "SELF_PURCHASE_DETAIL_DENIED", "SELF_PURCHASE_DETAIL_INTEGRITY_FAILED"],
    FINANCE_REIMBURSEMENT: ["REIMBURSEMENT_DETAIL_READ", "REIMBURSEMENT_DETAIL_DENIED", "REIMBURSEMENT_DETAIL_INTEGRITY_FAILED"],
  };
  if (readAuditActions[subject ?? ""]?.includes(action ?? "")) { if (input.raw === null) return []; if (input.raw === "null") return [anomaly(input)]; return auditExact(input, parseObject(input), ["contextSubject"]); }
  return gap();
};

/** Validates recognized persisted structures and leaves valid business JSON text unchanged. */
export const validateJsonTransform = (input: JsonTransformInput): readonly TransformAnomaly[] => {
  if (input.tableName === "finance_document_event" && input.columnName === "details_json") return eventJson(input);
  if (input.tableName === "audit_event") return auditJson(input);
  if (input.columnName === "result_json") return resultJson(input);
  return knownJson(input);
};
