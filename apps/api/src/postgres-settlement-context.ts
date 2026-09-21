import {
  calculateReferralRates,
  validateRatePolicyDraft,
  type DynamicTier,
  type RatePolicyValues,
  type SettlementInput
} from "@teaching-research-alliance/domain";
import type { PostgresClient } from "./postgres-ledger-repository.js";

type EntryRow = Readonly<{
  entry_id: string;
  fee_version: string;
  gross_amount_cents: string;
  settlement_month: string;
  venue_id: string;
  venue_owner_person_id: string;
  is_self_use_snapshot: boolean;
  referrer_person_id: string;
  receiver_person_id: string;
  referrer_identity: "TEACHING_TEACHER" | "ACADEMIC_PLANNER";
  week_starts_on: string;
  source_subject: "TEACHING_TEACHER" | "ACADEMIC_PLANNER" | "PLANNING_MENTOR" | null;
}>;

type PolicyRow = Readonly<{
  id: string;
  version: string;
  effective_from: string;
  policy_json: unknown;
  reason: string;
}>;

type RelationshipRow = Readonly<{ id: string; related_person_id: string }>;
type CampusRow = Readonly<{ id: string; campus_id: string; region_id: string }>;
type RoleRow = Readonly<{ id: string; person_id: string }>;
type AccountRow = Readonly<{ id: string; account_code: string }>;
type MonthlyNetRow = Readonly<{ received_cents: string; referred_cents: string }>;

type ResolvedAccount = Readonly<{ id: string; code: string }>;
type ResolvedRelationship = Readonly<{ id: string; personId: string }>;

type JsonObject = Readonly<Record<string, unknown>>;

const SETTLEMENT_KEYS = [
  "referrer",
  "planningMentor",
  "groupLeader",
  "teachingMentor",
  "venue",
  "campusConsultation",
  "platformFinance",
  "regionFinance",
  "teachingTeacher"
] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const bigintString = (value: unknown, field: string): bigint => {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) {
    throw new Error(`RATE_POLICY_FIELD_INVALID:${field}`);
  }
  return BigInt(value);
};

const optionalBigintString = (value: unknown, field: string): bigint | undefined => {
  if (value === undefined || value === null) return undefined;
  return bigintString(value, field);
};

const decodeTier = (value: unknown, index: number): DynamicTier => {
  if (!isObject(value) || typeof value.label !== "string") {
    throw new Error(`RATE_POLICY_TIER_INVALID:${index}`);
  }
  const minExclusive = optionalBigintString(value.minExclusive, `dynamicTiers.${index}.minExclusive`);
  const maxInclusive = optionalBigintString(value.maxInclusive, `dynamicTiers.${index}.maxInclusive`);
  const adjustmentBasisPoints = bigintString(
    value.adjustmentBasisPoints,
    `dynamicTiers.${index}.adjustmentBasisPoints`
  );
  return {
    label: value.label,
    ...(minExclusive === undefined ? {} : { minExclusive }),
    ...(maxInclusive === undefined ? {} : { maxInclusive }),
    adjustmentBasisPoints
  };
};

const decodePolicy = (value: unknown): RatePolicyValues => {
  if (!isObject(value) || !Array.isArray(value.dynamicTiers)) throw new Error("RATE_POLICY_JSON_INVALID");
  return {
    plannerBaseRateBasisPoints: bigintString(value.plannerBaseRateBasisPoints, "plannerBaseRateBasisPoints"),
    teacherBaseRateBasisPoints: bigintString(value.teacherBaseRateBasisPoints, "teacherBaseRateBasisPoints"),
    planningMentorWeightBasisPoints: bigintString(value.planningMentorWeightBasisPoints, "planningMentorWeightBasisPoints"),
    groupLeaderRateBasisPoints: bigintString(value.groupLeaderRateBasisPoints, "groupLeaderRateBasisPoints"),
    teachingMentorRateBasisPoints: bigintString(value.teachingMentorRateBasisPoints, "teachingMentorRateBasisPoints"),
    venueRateBasisPoints: bigintString(value.venueRateBasisPoints, "venueRateBasisPoints"),
    campusConsultationForPlannerRateBasisPoints: bigintString(
      value.campusConsultationForPlannerRateBasisPoints,
      "campusConsultationForPlannerRateBasisPoints"
    ),
    campusConsultationForTeacherRateBasisPoints: bigintString(
      value.campusConsultationForTeacherRateBasisPoints,
      "campusConsultationForTeacherRateBasisPoints"
    ),
    platformFinanceRateBasisPoints: bigintString(value.platformFinanceRateBasisPoints, "platformFinanceRateBasisPoints"),
    regionFinanceRateBasisPoints: bigintString(value.regionFinanceRateBasisPoints, "regionFinanceRateBasisPoints"),
    dynamicTiers: value.dynamicTiers.map(decodeTier)
  };
};

const exactlyOne = <Row>(rows: readonly Row[], missing: string, ambiguous: string): Row => {
  if (rows.length === 0) throw new Error(missing);
  if (rows.length !== 1) throw new Error(ambiguous);
  return rows[0] as Row;
};

const resolveRelationship = async (
  client: PostgresClient,
  teacherId: string,
  relationshipType: "GROUP_LEADER" | "TEACHING_MENTOR" | "PLANNING_MENTOR",
  businessAt: string,
  required: boolean
): Promise<ResolvedRelationship | undefined> => {
  const result = await client.query<RelationshipRow>(
    `SELECT id::text AS id, related_person_id::text AS related_person_id
       FROM person_relationship
      WHERE teacher_id = $1::uuid
        AND relationship_type = $2
        AND valid_from <= $3::timestamptz
        AND (valid_to IS NULL OR valid_to > $3::timestamptz)
      ORDER BY valid_from DESC, id
      LIMIT 2`,
    [teacherId, relationshipType, businessAt]
  );
  if (result.rows.length === 0 && !required) return undefined;
  const row = exactlyOne(
    result.rows,
    `SETTLEMENT_RELATIONSHIP_MISSING:${relationshipType}`,
    `SETTLEMENT_RELATIONSHIP_AMBIGUOUS:${relationshipType}`
  );
  return { id: row.id, personId: row.related_person_id };
};

const resolveCampus = async (
  client: PostgresClient,
  personId: string,
  businessAt: string,
  purpose: string
): Promise<CampusRow> => {
  const result = await client.query<CampusRow>(
    `SELECT id::text AS id, campus_id::text AS campus_id, region_id::text AS region_id
       FROM person_campus_assignment
      WHERE person_id = $1::uuid
        AND valid_from <= $2::timestamptz
        AND (valid_to IS NULL OR valid_to > $2::timestamptz)
      ORDER BY valid_from DESC, id
      LIMIT 2`,
    [personId, businessAt]
  );
  return exactlyOne(
    result.rows,
    `SETTLEMENT_CAMPUS_MISSING:${purpose}`,
    `SETTLEMENT_CAMPUS_AMBIGUOUS:${purpose}`
  );
};

const resolveRole = async (
  client: PostgresClient,
  subjectCode: "HEADQUARTERS_FINANCE" | "REGION_FINANCE",
  scopeType: "GLOBAL" | "REGION",
  scopeId: string | undefined,
  businessAt: string
): Promise<RoleRow> => {
  const result = await client.query<RoleRow>(
    `SELECT id::text AS id, person_id::text AS person_id
       FROM role_assignment
      WHERE subject_code = $1
        AND scope_type = $2
        AND (($3::uuid IS NULL AND scope_id IS NULL) OR scope_id = $3::uuid)
        AND valid_from <= $4::timestamptz
        AND (valid_to IS NULL OR valid_to > $4::timestamptz)
      ORDER BY valid_from DESC, id
      LIMIT 2`,
    [subjectCode, scopeType, scopeId ?? null, businessAt]
  );
  return exactlyOne(
    result.rows,
    `SETTLEMENT_ROLE_MISSING:${subjectCode}`,
    `SETTLEMENT_ROLE_AMBIGUOUS:${subjectCode}`
  );
};

const resolveAccount = async (
  client: PostgresClient,
  ownerType: "PERSON" | "COMPANY" | "VENUE",
  ownerId: string,
  category: string
): Promise<ResolvedAccount> => {
  const result = await client.query<AccountRow>(
    `SELECT id::text AS id, account_code
       FROM settlement_account
      WHERE owner_type = $1 AND owner_id = $2::uuid AND status = 'ACTIVE'
      LIMIT 2`,
    [ownerType, ownerId]
  );
  const row = exactlyOne(
    result.rows,
    `SETTLEMENT_ACCOUNT_MISSING:${category}`,
    `SETTLEMENT_ACCOUNT_AMBIGUOUS:${category}`
  );
  return { id: row.id, code: row.account_code };
};

export type SettlementContext = Readonly<{
  input: SettlementInput;
  accountByKey: Readonly<Record<string, string>>;
  policyVersionId: string;
  contextJson: unknown;
}>;

export const resolveSettlementContext = async (
  client: PostgresClient,
  entryId: string
): Promise<SettlementContext> => {
  const entryResult = await client.query<EntryRow>(
    `SELECT entry.id::text AS entry_id,
            entry.version::text AS fee_version,
            entry.gross_amount_cents::text AS gross_amount_cents,
            entry.settlement_month::text AS settlement_month,
            entry.venue_id::text AS venue_id,
            entry.venue_owner_person_id::text AS venue_owner_person_id,
            entry.is_self_use_snapshot,
            referral.referrer_person_id::text AS referrer_person_id,
            referral.receiver_person_id::text AS receiver_person_id,
            referral.referrer_identity,
            creation.source_subject,
            week.starts_on::text AS week_starts_on
       FROM weekly_fee_entry entry
       JOIN referral_case referral ON referral.id = entry.referral_case_id
       LEFT JOIN referral_creation_snapshot creation ON creation.referral_case_id = referral.id
       JOIN teaching_week week ON week.id = entry.teaching_week_id
      WHERE entry.id = $1::uuid`,
    [entryId]
  );
  const entry = exactlyOne(entryResult.rows, "WEEKLY_FEE_NOT_FOUND", "WEEKLY_FEE_ENTRY_AMBIGUOUS");
  const fixedIdentity = entry.source_subject === null ? entry.referrer_identity
    : entry.source_subject === "TEACHING_TEACHER" ? "TEACHING_TEACHER" : "ACADEMIC_PLANNER";
  const businessAt = `${entry.week_starts_on}T00:00:00+08:00`;

  const policyResult = await client.query<PolicyRow>(
    `SELECT id::text AS id, version::text AS version, effective_from::text AS effective_from,
            policy_json, reason
       FROM rate_policy_version
      WHERE effective_from <= $1::date
      ORDER BY effective_from DESC, version DESC
      LIMIT 1`,
    [entry.week_starts_on]
  );
  const policyRow = exactlyOne(policyResult.rows, "RATE_POLICY_NOT_FOUND", "RATE_POLICY_AMBIGUOUS");
  const policy = decodePolicy(policyRow.policy_json);
  const policyErrors = validateRatePolicyDraft({
    ...policy,
    effectiveFrom: policyRow.effective_from,
    reason: policyRow.reason
  });
  if (policyErrors.length > 0) throw new Error(`RATE_POLICY_INVALID:${policyErrors.join(",")}`);

  const monthlyNetResult = await client.query<MonthlyNetRow>(
    `SELECT COALESCE(sum(entry.gross_amount_cents) FILTER (
              WHERE referral.receiver_person_id = $1::uuid
            ), 0)::text AS received_cents,
            COALESCE(sum(entry.gross_amount_cents) FILTER (
              WHERE referral.referrer_person_id = $1::uuid
            ), 0)::text AS referred_cents
       FROM weekly_fee_entry entry
       JOIN referral_case referral ON referral.id = entry.referral_case_id
      WHERE entry.settlement_month = $2::date
        AND (referral.receiver_person_id = $1::uuid OR referral.referrer_person_id = $1::uuid)`,
    [entry.receiver_person_id, entry.settlement_month]
  );
  const monthlyNet = exactlyOne(monthlyNetResult.rows, "MONTHLY_NET_NOT_FOUND", "MONTHLY_NET_AMBIGUOUS");
  const netMonthlyCents = BigInt(monthlyNet.received_cents) - BigInt(monthlyNet.referred_cents);

  const referrerIsPlanningMentor = entry.source_subject === "PLANNING_MENTOR";
  const planningMentor = fixedIdentity === "ACADEMIC_PLANNER" && !referrerIsPlanningMentor
    ? await resolveRelationship(client, entry.referrer_person_id, "PLANNING_MENTOR", businessAt, false)
    : undefined;
  const mentorWeightBasisPoints = planningMentor === undefined ? 0n : policy.planningMentorWeightBasisPoints;
  const baseIntroRateBasisPoints = fixedIdentity === "ACADEMIC_PLANNER"
    ? policy.plannerBaseRateBasisPoints
    : policy.teacherBaseRateBasisPoints;
  const campusConsultationRateBasisPoints = fixedIdentity === "ACADEMIC_PLANNER"
    ? policy.campusConsultationForPlannerRateBasisPoints
    : policy.campusConsultationForTeacherRateBasisPoints;
  const venueRateBasisPoints = entry.is_self_use_snapshot ? 0n : policy.venueRateBasisPoints;
  const referralRates = calculateReferralRates({
    baseRateBasisPoints: baseIntroRateBasisPoints,
    netMonthlyCents,
    mentorWeightBasisPoints,
    dynamicTiers: policy.dynamicTiers
  });
  const fixedRates = [
    policy.groupLeaderRateBasisPoints,
    policy.teachingMentorRateBasisPoints,
    venueRateBasisPoints,
    campusConsultationRateBasisPoints,
    policy.platformFinanceRateBasisPoints,
    policy.regionFinanceRateBasisPoints
  ];
  const usedNumerator = referralRates.referrerBasisPointsNumerator
    + referralRates.mentorBasisPointsNumerator
    + fixedRates.reduce((sum, rate) => sum + rate * 10_000n, 0n);
  const denominator = 100_000_000n;
  const teachingTeacherNumerator = denominator - usedNumerator;
  if (teachingTeacherNumerator < 0n) throw new Error("ALLOCATION_EXCEEDS_FEE");

  const groupLeader = await resolveRelationship(
    client,
    entry.receiver_person_id,
    "GROUP_LEADER",
    businessAt,
    policy.groupLeaderRateBasisPoints > 0n
  );
  const teachingMentor = await resolveRelationship(
    client,
    entry.receiver_person_id,
    "TEACHING_MENTOR",
    businessAt,
    policy.teachingMentorRateBasisPoints > 0n
  );
  const referrerCampus = campusConsultationRateBasisPoints > 0n
    ? await resolveCampus(client, entry.referrer_person_id, businessAt, "REFERRER")
    : undefined;
  const receiverCampus = policy.regionFinanceRateBasisPoints > 0n
    ? await resolveCampus(client, entry.receiver_person_id, businessAt, "RECEIVER")
    : undefined;
  const headquartersFinance = policy.platformFinanceRateBasisPoints > 0n
    ? await resolveRole(client, "HEADQUARTERS_FINANCE", "GLOBAL", undefined, businessAt)
    : undefined;
  const regionFinance = policy.regionFinanceRateBasisPoints > 0n
    ? await resolveRole(client, "REGION_FINANCE", "REGION", receiverCampus?.region_id, businessAt)
    : undefined;

  const accountByKey: Record<string, string> = {};
  const accountContext: Record<string, JsonObject> = {};
  const addAccount = async (
    key: (typeof SETTLEMENT_KEYS)[number],
    numerator: bigint,
    ownerType: "PERSON" | "COMPANY" | "VENUE",
    ownerId: string | undefined
  ): Promise<void> => {
    if (numerator === 0n) return;
    if (ownerId === undefined) throw new Error(`SETTLEMENT_RECIPIENT_MISSING:${key}`);
    const account = await resolveAccount(client, ownerType, ownerId, key);
    accountByKey[key] = account.code;
    accountContext[key] = { ownerType, ownerId, accountId: account.id, accountCode: account.code };
  };

  await addAccount("referrer", referralRates.referrerBasisPointsNumerator, "PERSON", entry.referrer_person_id);
  await addAccount("planningMentor", referralRates.mentorBasisPointsNumerator, "PERSON", planningMentor?.personId);
  await addAccount("groupLeader", policy.groupLeaderRateBasisPoints * 10_000n, "PERSON", groupLeader?.personId);
  await addAccount("teachingMentor", policy.teachingMentorRateBasisPoints * 10_000n, "PERSON", teachingMentor?.personId);
  await addAccount("venue", venueRateBasisPoints * 10_000n, "VENUE", entry.venue_id);
  await addAccount(
    "campusConsultation",
    campusConsultationRateBasisPoints * 10_000n,
    "COMPANY",
    referrerCampus?.campus_id
  );
  await addAccount(
    "platformFinance",
    policy.platformFinanceRateBasisPoints * 10_000n,
    "PERSON",
    headquartersFinance?.person_id
  );
  await addAccount(
    "regionFinance",
    policy.regionFinanceRateBasisPoints * 10_000n,
    "PERSON",
    regionFinance?.person_id
  );
  await addAccount("teachingTeacher", teachingTeacherNumerator, "PERSON", entry.receiver_person_id);

  const input: SettlementInput = {
    feeCents: BigInt(entry.gross_amount_cents),
    netMonthlyCents,
    baseIntroRateBasisPoints,
    mentorWeightBasisPoints,
    groupLeaderRateBasisPoints: policy.groupLeaderRateBasisPoints,
    teachingMentorRateBasisPoints: policy.teachingMentorRateBasisPoints,
    venueRateBasisPoints,
    campusConsultationRateBasisPoints,
    platformFinanceRateBasisPoints: policy.platformFinanceRateBasisPoints,
    regionFinanceRateBasisPoints: policy.regionFinanceRateBasisPoints,
    dynamicTiers: policy.dynamicTiers
  };
  const contextJson: JsonObject = {
    businessAt,
    weekStartsOn: entry.week_starts_on,
    settlementMonth: entry.settlement_month,
    feeEntryId: entry.entry_id,
    feeVersion: entry.fee_version,
    referrerPersonId: entry.referrer_person_id,
    receiverPersonId: entry.receiver_person_id,
    referrerIdentity: fixedIdentity,
    sourceSubject: entry.source_subject,
    sourceProvenance: entry.source_subject === null ? "LEGACY_IDENTITY_ONLY" : "CREATION_SNAPSHOT",
    venueId: entry.venue_id,
    venueOwnerPersonId: entry.venue_owner_person_id,
    isSelfUseSnapshot: entry.is_self_use_snapshot,
    policy: {
      id: policyRow.id,
      version: policyRow.version,
      effectiveFrom: policyRow.effective_from
    },
    monthlyNet: {
      receivedCents: monthlyNet.received_cents,
      referredCents: monthlyNet.referred_cents,
      netCents: netMonthlyCents.toString()
    },
    resolvedRates: {
      baseIntroRateBasisPoints: baseIntroRateBasisPoints.toString(),
      dynamicAdjustmentBasisPoints: referralRates.adjustmentBasisPoints.toString(),
      actualIntroPoolBasisPoints: referralRates.actualPoolBasisPoints.toString(),
      planningMentorWeightBasisPoints: mentorWeightBasisPoints.toString(),
      groupLeaderRateBasisPoints: policy.groupLeaderRateBasisPoints.toString(),
      teachingMentorRateBasisPoints: policy.teachingMentorRateBasisPoints.toString(),
      venueRateBasisPoints: venueRateBasisPoints.toString(),
      campusConsultationRateBasisPoints: campusConsultationRateBasisPoints.toString(),
      platformFinanceRateBasisPoints: policy.platformFinanceRateBasisPoints.toString(),
      regionFinanceRateBasisPoints: policy.regionFinanceRateBasisPoints.toString()
    },
    relationships: {
      referrerIsPlanningMentor,
      planningMentor: planningMentor ?? null,
      groupLeader: groupLeader ?? null,
      teachingMentor: teachingMentor ?? null
    },
    organization: {
      referrerCampusAssignment: referrerCampus ?? null,
      receiverCampusAssignment: receiverCampus ?? null,
      headquartersFinanceRole: headquartersFinance ?? null,
      regionFinanceRole: regionFinance ?? null
    },
    accounts: accountContext
  };
  return { input, accountByKey, policyVersionId: policyRow.id, contextJson };
};
