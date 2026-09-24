import { createHash, randomUUID } from "node:crypto";
import type { RoleContext } from "@teaching-research-alliance/contracts";
import { allocationDelta, postLedgerEvent, type LedgerDelta } from "@teaching-research-alliance/domain";
import { createPostgresLedgerTransaction, type PostgresClient, type PostgresPool } from "./postgres-ledger-repository.js";
import { prepareLedgerPosting } from "./postgres-ledger-locks.js";
import { lockSettlementAllocationExclusive, lockSettlementAllocationShared } from "./postgres-settlement-allocation-gate.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/;
const ALLOCATION_KEYS = [
  "referrer", "planningMentor", "groupLeader", "teachingMentor", "venue",
  "campusConsultation", "platformFinance", "regionFinance", "teachingTeacher"
] as const;

type JsonObject = Record<string, unknown>;
type RelationshipRow = Readonly<{
  id: string;
  teacher_id: string;
  relationship_type: string;
  related_person_id: string;
  valid_from: string;
  valid_to: string | null;
  effective_scope: string | null;
  created_by: string;
  created_at: string;
  superseded_at: string | null;
  superseded_by_teaching_mentor_change_id: string | null;
}>;
type WeekRow = Readonly<{
  id: string;
  starts_on: string;
  ends_on: string;
  settlement_month: string;
  week_kind: "REGULAR" | "WINTER_SPECIAL" | "SUMMER_SPECIAL";
  contains_publish_date: boolean;
}>;
type CandidateRow = Readonly<{
  person_id: string;
  nickname: string;
  user_account_id: string;
  role_assignment_id: string;
  role_valid_from: string;
  role_valid_to: string | null;
  account_id: string;
  account_code: string;
  active_login_count: number;
  active_account_count: number;
}>;
type AccountRow = Readonly<{
  id: string;
  owner_type: string;
  owner_id: string;
  account_code: string;
  status: string;
}>;
type FeeRow = Readonly<{
  id: string;
  version: string;
  gross_amount_cents: string;
  teaching_week_id: string;
  week_starts_on: string;
  settlement_month: string;
  refund_effect_id: string | null;
  snapshot_id: string | null;
  sequence_no: string | null;
  source_weekly_fee_version: string | null;
  policy_version_id: string | null;
  net_monthly_cents: string | null;
  snapshot_json: unknown | null;
  context_json: unknown | null;
}>;
type PreviewRow = Readonly<{
  id: string;
  teacher_person_id: string;
  source_relationship_id: string | null;
  source_related_person_id: string | null;
  new_related_person_id: string;
  candidate_role_assignment_id: string;
  effective_teaching_week_id: string;
  effective_through_teaching_week_id: string | null;
  effective_at: string;
  next_boundary_at: string | null;
  reason: string;
  base_hash: string;
  impact_json: unknown;
  created_at: string;
}>;
type ChangeReplayRow = Readonly<{
  id: string;
  preview_id: string;
  request_hash: string;
  relationship_version: string;
  result_relationship_id: string;
  posting_status: "POSTED" | "NO_BALANCE_CHANGE";
  considered_fee_count: number;
  moved_fee_count: number;
  excluded_refund_count: number;
  moved_amount_cents: string;
}>;

type DecodedSnapshot = Readonly<{
  lines: readonly { key: string; cents: bigint }[];
  accountByKey: Readonly<Record<string, string>>;
}>;
type FrozenFee = Readonly<{
  feeEntryId: string;
  feeVersion: string;
  grossAmountCents: string;
  teachingWeekId: string;
  weekStartsOn: string;
  settlementMonth: string;
  disposition: "REFUNDED" | "ZERO_SHARE" | "MOVE";
  refundEffectId: string | null;
  previousSnapshotId: string | null;
  previousSnapshotSequence: string | null;
  previousSnapshotHash: string | null;
  policyVersionId: string | null;
  netMonthlyCents: string | null;
  teachingMentorAmountCents: string;
  sourceAccountId: string | null;
  sourceAccountCode: string | null;
}>;
type FrozenImpact = Readonly<{
  schemaVersion: "teaching-mentor-change-preview.v1";
  teacherPersonId: string;
  effectiveWeek: Readonly<{ id: string; startsOn: string; endsOn: string; settlementMonth: string; kind: "REGULAR" }>;
  effectiveAt: string;
  nextBoundaryAt: string | null;
  effectiveThroughTeachingWeekId: string | null;
  sourceRelationship: ReturnType<typeof relationshipFact> | null;
  nextRelationship: ReturnType<typeof relationshipFact> | null;
  candidate: Readonly<{
    personId: string;
    nickname: string;
    userAccountId: string;
    roleAssignmentId: string;
    roleValidFrom: string;
    roleValidTo: string | null;
  }>;
  destinationAccount: Readonly<{ id: string; code: string; ownerType: "PERSON"; ownerId: string; status: "ACTIVE" }>;
  reason: string;
  fees: readonly FrozenFee[];
  totals: Readonly<{
    consideredFeeCount: number;
    movedFeeCount: number;
    zeroShareFeeCount: number;
    excludedRefundCount: number;
    movedAmountCents: string;
  }>;
}>;
type RuntimeFee = Readonly<{
  frozen: FrozenFee;
  rawSnapshot: JsonObject;
  rawContext: JsonObject;
  decoded: DecodedSnapshot;
}>;
type BuiltImpact = Readonly<{
  frozen: FrozenImpact;
  baseHash: string;
  source: RelationshipRow | null;
  sourceRelatedNickname: string | null;
  week: WeekRow;
  candidate: CandidateRow;
  destinationAccount: AccountRow;
  runtimeFees: readonly RuntimeFee[];
}>;

export type TeachingMentorChangePreviewDraft = Readonly<{
  teacherPersonId: string;
  newRelatedPersonId: string;
  effectiveTeachingWeekId: string;
  effectiveThroughTeachingWeekId?: string | null;
  reason: string;
}>;
export type TeachingMentorDirectory = Readonly<{
  teachers: readonly Readonly<{ personId: string; nickname: string; currentMentorPersonId: string | null; currentMentorNickname: string | null; currentRelationshipId: string | null }>[];
  mentors: readonly TeachingMentorCandidate[];
  currentWeeks: readonly Readonly<{ id: string; startsOn: string; endsOn: string; settlementMonth: string }>[];
}>;
export type TeachingMentorChangePreviewResult = Readonly<{
  action: "ADD" | "REPLACE";
  previewId: string;
  baseHash: string;
  newRelatedNickname: string;
  effectiveThroughTeachingWeekId: string | null;
  teacherPersonId: string;
  sourceRelatedPersonId: string | null;
  sourceRelatedNickname: string | null;
  newRelatedPersonId: string;
  effectiveTeachingWeekId: string;
  effectiveAt: string;
  nextBoundaryAt: string | null;
  consideredFeeCount: number;
  movedFeeCount: number;
  zeroShareFeeCount: number;
  excludedRefundCount: number;
  movedAmountCents: string;
}>;
export type TeachingMentorChangePublishResult = Readonly<{
  changeId: string;
  previewId: string;
  relationshipVersion: number;
  resultRelationshipId: string;
  postingStatus: "POSTED" | "NO_BALANCE_CHANGE";
  consideredFeeCount: number;
  movedFeeCount: number;
  excludedRefundCount: number;
  movedAmountCents: string;
  replay: boolean;
}>;
export type TeachingMentorCandidate = Readonly<{
  personId: string;
  nickname: string;
  eligibleTeacherPersonIds?: readonly string[] | null;
}>;

const fail = (code: string): never => { throw new Error(code); };
const jsonObject = (value: unknown): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail("RELATIONSHIP_DATA_UNAVAILABLE");
  return value as JsonObject;
};
const jsonString = (value: unknown): string => typeof value === "string" ? value : fail("RELATIONSHIP_DATA_UNAVAILABLE");
const uuid = (value: string): string => UUID.test(value) ? value.toLowerCase() : fail("INVALID_INPUT");
const storedUuid = (value: unknown): string => {
  const text = jsonString(value);
  return UUID.test(text) ? text.toLowerCase() : fail("RELATIONSHIP_DATA_UNAVAILABLE");
};
const integer = (value: string): number => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number >= Number.MAX_SAFE_INTEGER) return fail("RELATIONSHIP_DATA_UNAVAILABLE");
  return number;
};
const cents = (value: unknown): bigint => {
  const text = jsonString(value);
  if (!/^\d+$/.test(text) || text.length > 19 || BigInt(text) > 9223372036854775807n) return fail("RELATIONSHIP_DATA_UNAVAILABLE");
  return BigInt(text);
};
const instantKey = (value: string): string => {
  const match = UTC_INSTANT.exec(value);
  if (match === null || !Number.isFinite(new Date(value).getTime())) return fail("RELATIONSHIP_DATA_UNAVAILABLE");
  return `${match[1]}.${(match[2] ?? "").padEnd(6, "0")}Z`;
};
const compareInstants = (left: string, right: string): number => {
  const leftKey = instantKey(left);
  const rightKey = instantKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
};
const normalizeJson = (value: unknown): unknown => {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeJson(item)]));
  }
  return value;
};
const encode = (value: unknown): string => JSON.stringify(normalizeJson(value));
const digest = (value: unknown): string => createHash("sha256").update(encode(value)).digest("hex");
const cloneObject = (value: JsonObject): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;

const assertAdmin = (context: RoleContext): void => {
  if (!["SYSTEM_OWNER", "SYSTEM_ADMIN"].includes(context.subject)
    || context.scope !== "GLOBAL" || context.regionId !== undefined
    || context.campusId !== undefined || context.venueId !== undefined || !UUID.test(context.personId)) {
    fail("FORBIDDEN_SCOPE");
  }
};
const cleanReason = (value: string): string => {
  const reason = value.trim();
  if (!reason || reason.length > 1000 || /[\x00-\x1f\x7f]/.test(reason)) return fail("INVALID_INPUT");
  return reason;
};
const cleanKey = (value: string): string => {
  const key = value.trim();
  if (!key || key.length > 200 || /[\x00-\x1f\x7f]/.test(key)) return fail("INVALID_INPUT");
  return key;
};
const assertAt = (at: Date): string => Number.isFinite(at.getTime()) ? at.toISOString() : fail("INVALID_INPUT");

const relationshipFact = (row: RelationshipRow) => ({
  id: row.id,
  teacherPersonId: row.teacher_id,
  relationshipType: row.relationship_type,
  relatedPersonId: row.related_person_id,
  validFrom: row.valid_from,
  validTo: row.valid_to,
  effectiveScope: row.effective_scope,
  createdByPersonId: row.created_by,
  createdAt: row.created_at,
  supersededAt: row.superseded_at,
  supersededByChangeId: row.superseded_by_teaching_mentor_change_id
});

const decodeSnapshot = (value: unknown, grossAmountCents: bigint): DecodedSnapshot => {
  const raw = jsonObject(value);
  const rawLines = raw.lines;
  const rawMap = jsonObject(raw.accountByKey);
  if (!Array.isArray(rawLines) || rawLines.length !== ALLOCATION_KEYS.length) return fail("RELATIONSHIP_DATA_UNAVAILABLE");
  const lines = rawLines.map(item => {
    const line = jsonObject(item);
    return { key: jsonString(line.key), cents: cents(line.cents) };
  });
  const keySet = new Set(lines.map(line => line.key));
  if (keySet.size !== ALLOCATION_KEYS.length || lines.some(line => !ALLOCATION_KEYS.includes(line.key as (typeof ALLOCATION_KEYS)[number]))) {
    return fail("RELATIONSHIP_DATA_UNAVAILABLE");
  }
  const accountByKey: Record<string, string> = {};
  for (const [key, item] of Object.entries(rawMap)) {
    if (!ALLOCATION_KEYS.includes(key as (typeof ALLOCATION_KEYS)[number])) return fail("RELATIONSHIP_DATA_UNAVAILABLE");
    const code = jsonString(item);
    if (!code.trim()) return fail("RELATIONSHIP_DATA_UNAVAILABLE");
    accountByKey[key] = code;
  }
  if (lines.some(line => line.cents !== 0n && accountByKey[line.key] === undefined)
    || lines.reduce((sum, line) => sum + line.cents, 0n) !== grossAmountCents) {
    return fail("RELATIONSHIP_DATA_UNAVAILABLE");
  }
  return { lines, accountByKey };
};

const aggregate = (deltas: readonly LedgerDelta[]): readonly LedgerDelta[] => {
  const aggregated = new Map<string, LedgerDelta>();
  for (const delta of deltas) {
    const key = encode([delta.accountKey, delta.categoryKey]);
    aggregated.set(key, { ...delta, amountCents: (aggregated.get(key)?.amountCents ?? 0n) + delta.amountCents });
  }
  return [...aggregated.values()]
    .filter(delta => delta.amountCents !== 0n)
    .sort((left, right) => encode([left.accountKey, left.categoryKey]).localeCompare(encode([right.accountKey, right.categoryKey])));
};

const readActorAssignment = async (client: PostgresClient, context: RoleContext, at: string): Promise<void> => {
  const rows = (await client.query<{ id: string }>(
    `SELECT id::text FROM role_assignment
      WHERE person_id=$1::uuid AND subject_code=$2 AND scope_type='GLOBAL' AND scope_id IS NULL
        AND valid_from<=$3::timestamptz AND (valid_to IS NULL OR valid_to>$3::timestamptz)
      ORDER BY id LIMIT 2 FOR SHARE`, [context.personId, context.subject, at]
  )).rows;
  if (rows.length !== 1) fail("FORBIDDEN_SCOPE");
};

const readWeek = async (client: PostgresClient, weekId: string, at: string): Promise<WeekRow> => {
  const rows = (await client.query<WeekRow>(
    `SELECT id::text,starts_on::text,ends_on::text,settlement_month::text,week_kind,
            (($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date BETWEEN starts_on AND ends_on) AS contains_publish_date
       FROM teaching_week WHERE id=$1::uuid`, [weekId, at]
  )).rows;
  if (rows.length !== 1) fail("RELATIONSHIP_EFFECTIVE_WEEK_NOT_FOUND");
  const week = rows[0]!;
  if (week.week_kind !== "REGULAR") fail("RELATIONSHIP_SPECIAL_PERIOD_SCOPE_REQUIRED");
  const localDate = new Date(at).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  if (week.ends_on < localDate) fail("RELATIONSHIP_EFFECTIVE_WEEK_NOT_CURRENT");
  return week;
};

const readCandidate = async (
  client: PostgresClient,
  personId: string,
  teacherPersonId: string,
  effectiveAt: string,
  verifiedAt: string
): Promise<CandidateRow> => {
  const rows = (await client.query<CandidateRow>(
    `WITH eligible_role AS (
        SELECT id,person_id,valid_from,valid_to,scope_id
          FROM role_assignment
         WHERE person_id=$1::uuid AND subject_code='TEACHING_MENTOR' AND scope_type='MENTEES'
           AND (scope_id IS NULL OR scope_id=$2::uuid)
           AND valid_from<=$3::timestamptz AND (valid_to IS NULL OR valid_to>$3::timestamptz)
           AND valid_from<=$4::timestamptz AND (valid_to IS NULL OR valid_to>$4::timestamptz)
         FOR SHARE
      ), selected_role AS (
        SELECT * FROM eligible_role WHERE scope_id IS NULL
        UNION ALL
        SELECT * FROM eligible_role WHERE scope_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM eligible_role WHERE scope_id IS NULL)
      ), active_login AS (
        SELECT id FROM user_account WHERE person_id=$1::uuid AND login_status='ACTIVE' FOR SHARE
      ), active_account AS (
        SELECT id,account_code FROM settlement_account
         WHERE owner_type='PERSON' AND owner_id=$1::uuid AND status='ACTIVE' FOR SHARE
      )
      SELECT person.id::text AS person_id,person.nickname,
             (SELECT id::text FROM active_login ORDER BY id LIMIT 1) AS user_account_id,
             role.id::text AS role_assignment_id,teaching_mentor_timestamp_text(role.valid_from) AS role_valid_from,
             teaching_mentor_timestamp_text(role.valid_to) AS role_valid_to,
             (SELECT id::text FROM active_account ORDER BY id LIMIT 1) AS account_id,
             (SELECT account_code FROM active_account ORDER BY id LIMIT 1) AS account_code,
             (SELECT count(*)::integer FROM active_login) AS active_login_count,
             (SELECT count(*)::integer FROM active_account) AS active_account_count
        FROM person JOIN selected_role role ON true
       WHERE person.id=$1::uuid AND person.status='ACTIVE'
       ORDER BY role.scope_id NULLS FIRST,role.id
       FOR SHARE OF person`, [personId, teacherPersonId, effectiveAt, verifiedAt]
  )).rows;
  if (rows.length === 0) fail("TEACHING_MENTOR_CANDIDATE_NOT_ELIGIBLE");
  if (rows.length !== 1 || rows[0]!.active_login_count !== 1 || rows[0]!.active_account_count !== 1
    || rows[0]!.user_account_id === null || rows[0]!.account_id === null || rows[0]!.account_code === null) {
    fail("TEACHING_MENTOR_CANDIDATE_AMBIGUOUS");
  }
  return rows[0]!;
};

const readRelationship = async (
  client: PostgresClient,
  teacherPersonId: string,
  effectiveAt: string,
  lock: boolean
): Promise<{ source: RelationshipRow | null; next: RelationshipRow | null }> => {
  const sourceRows = (await client.query<RelationshipRow>(
    `SELECT id::text,teacher_id::text,relationship_type,related_person_id::text,
            teaching_mentor_timestamp_text(valid_from) AS valid_from,
            teaching_mentor_timestamp_text(valid_to) AS valid_to,
            effective_scope,created_by::text,teaching_mentor_timestamp_text(created_at) AS created_at,
            teaching_mentor_timestamp_text(superseded_at) AS superseded_at,superseded_by_teaching_mentor_change_id::text
       FROM person_relationship
      WHERE teacher_id=$1::uuid AND relationship_type='TEACHING_MENTOR' AND superseded_at IS NULL
        AND valid_from<=$2::timestamptz AND (valid_to IS NULL OR valid_to>$2::timestamptz)
      ORDER BY valid_from DESC,id LIMIT 2 ${lock ? "FOR UPDATE" : "FOR SHARE"}`,
    [teacherPersonId, effectiveAt]
  )).rows;
  if (sourceRows.length > 1) fail("TEACHING_MENTOR_RELATIONSHIP_AMBIGUOUS");
  const nextRows = (await client.query<RelationshipRow>(
    `SELECT id::text,teacher_id::text,relationship_type,related_person_id::text,
            teaching_mentor_timestamp_text(valid_from) AS valid_from,
            teaching_mentor_timestamp_text(valid_to) AS valid_to,
            effective_scope,created_by::text,teaching_mentor_timestamp_text(created_at) AS created_at,
            teaching_mentor_timestamp_text(superseded_at) AS superseded_at,superseded_by_teaching_mentor_change_id::text
       FROM person_relationship
      WHERE teacher_id=$1::uuid AND relationship_type='TEACHING_MENTOR' AND superseded_at IS NULL
        AND valid_from>$2::timestamptz
      ORDER BY valid_from,id LIMIT 1 ${lock ? "FOR UPDATE" : "FOR SHARE"}`,
    [teacherPersonId, effectiveAt]
  )).rows;
  return { source: sourceRows[0] ?? null, next: nextRows[0] ?? null };
};

const readFeeRows = async (
  client: PostgresClient,
  teacherPersonId: string,
  effectiveAt: string,
  nextBoundaryAt: string | null,
  lock: boolean
): Promise<readonly FeeRow[]> => (await client.query<FeeRow>(
  `SELECT fee.id::text,fee.version::text,fee.gross_amount_cents::text,fee.teaching_week_id::text,
          week.starts_on::text AS week_starts_on,fee.settlement_month::text,
          refund.finance_document_id::text AS refund_effect_id,
          snapshot.id::text AS snapshot_id,snapshot.sequence_no::text,
          snapshot.source_weekly_fee_version::text,snapshot.policy_version_id::text,
          snapshot.net_monthly_cents::text,snapshot.snapshot_json,snapshot.context_json
     FROM weekly_fee_entry fee
     JOIN referral_case referral ON referral.id=fee.referral_case_id
     JOIN teaching_week week ON week.id=fee.teaching_week_id
     LEFT JOIN weekly_fee_refund_effect refund ON refund.weekly_fee_entry_id=fee.id
     LEFT JOIN LATERAL (
       SELECT candidate.* FROM weekly_fee_allocation_snapshot candidate
        WHERE candidate.weekly_fee_entry_id=fee.id ORDER BY candidate.sequence_no DESC LIMIT 1
     ) snapshot ON true
    WHERE referral.receiver_person_id=$1::uuid AND week.week_kind='REGULAR'
      AND (week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai') >= $2::timestamptz
      AND ($3::timestamptz IS NULL OR (week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai') < $3::timestamptz)
    ORDER BY fee.id ${lock ? "FOR UPDATE OF fee" : "FOR SHARE OF fee"}`,
  [teacherPersonId, effectiveAt, nextBoundaryAt]
)).rows;

const buildImpact = async (
  client: PostgresClient,
  draft: TeachingMentorChangePreviewDraft,
  at: string,
  lock: boolean
): Promise<BuiltImpact> => {
  const teacherPersonId = uuid(draft.teacherPersonId);
  const newRelatedPersonId = uuid(draft.newRelatedPersonId);
  const effectiveTeachingWeekId = uuid(draft.effectiveTeachingWeekId);
  const reason = cleanReason(draft.reason);
  const teacherRows = (await client.query<{ id: string }>(
    `SELECT person.id::text FROM person JOIN teacher_profile profile ON profile.person_id=person.id
      WHERE person.id=$1::uuid AND person.status='ACTIVE' AND profile.employment_status='ACTIVE'
        AND profile.business_identity='TEACHING_TEACHER'
      ${lock ? "FOR SHARE OF person,profile" : ""}`, [teacherPersonId]
  )).rows;
  if (teacherRows.length !== 1) fail("RELATIONSHIP_TEACHER_NOT_ELIGIBLE");
  const week = await readWeek(client, effectiveTeachingWeekId, at);
  const effectiveAt = new Date(`${week.starts_on}T00:00:00+08:00`).toISOString();
  const { source, next } = await readRelationship(client, teacherPersonId, effectiveAt, lock);
  if (source !== null && source.related_person_id === newRelatedPersonId) fail("RELATIONSHIP_TARGET_UNCHANGED");
  const sourcePersonRows = source === null ? [] : (await client.query<{ nickname: string }>(
    "SELECT nickname FROM person WHERE id=$1::uuid", [source.related_person_id]
  )).rows;
  if (source !== null && sourcePersonRows.length !== 1) fail("RELATIONSHIP_DATA_UNAVAILABLE");
  const sourceRelatedNickname = sourcePersonRows[0]?.nickname ?? null;
  const explicitEnd = draft.effectiveThroughTeachingWeekId ? await readWeek(client, uuid(draft.effectiveThroughTeachingWeekId), at) : null;
  const explicitBoundary = explicitEnd ? new Date(new Date(`${explicitEnd.ends_on}T00:00:00+08:00`).getTime() + 86400000).toISOString() : null;
  if (explicitBoundary !== null && compareInstants(explicitBoundary, effectiveAt) <= 0) fail("INVALID_INPUT");
  const candidate = await readCandidate(client, newRelatedPersonId, teacherPersonId, effectiveAt, at);
  // A selected teaching-mentor assignment is itself a temporal authorization.
  // The result relationship must finish before that assignment ceases to apply.
  const boundaries = [explicitBoundary, source?.valid_to ?? null, next?.valid_from ?? null, candidate.role_valid_to]
    .filter((x): x is string => x !== null);
  const nextBoundaryAt = boundaries.length === 0 ? null : boundaries.sort(compareInstants)[0]!;
  if (next !== null && nextBoundaryAt !== null && compareInstants(next.valid_from, nextBoundaryAt) < 0) {
    fail("TEACHING_MENTOR_RELATIONSHIP_AMBIGUOUS");
  }
  const destinationAccount: AccountRow = {
    id: candidate.account_id,
    owner_type: "PERSON",
    owner_id: candidate.person_id,
    account_code: candidate.account_code,
    status: "ACTIVE"
  };
  const sourceAccountRows = source === null ? [] : (await client.query<AccountRow>(
    `SELECT id::text,owner_type,owner_id::text,account_code,status FROM settlement_account
      WHERE owner_type='PERSON' AND owner_id=$1::uuid LIMIT 2`,
    [source.related_person_id]
  )).rows;
  if (sourceAccountRows.length > 1) fail("RELATIONSHIP_DATA_UNAVAILABLE");
  const sourceAccount = sourceAccountRows[0];
  const rows = await readFeeRows(client, teacherPersonId, effectiveAt, nextBoundaryAt, lock);
  const frozenFees: FrozenFee[] = [];
  const runtimeFees: RuntimeFee[] = [];
  let movedAmount = 0n;
  let movedFeeCount = 0;
  let zeroShareFeeCount = 0;
  let excludedRefundCount = 0;
  for (const row of rows) {
    if (row.refund_effect_id !== null) {
      excludedRefundCount += 1;
      frozenFees.push({
        feeEntryId: row.id, feeVersion: row.version, grossAmountCents: row.gross_amount_cents,
        teachingWeekId: row.teaching_week_id, weekStartsOn: row.week_starts_on,
        settlementMonth: row.settlement_month, disposition: "REFUNDED", refundEffectId: row.refund_effect_id,
        previousSnapshotId: null, previousSnapshotSequence: null, previousSnapshotHash: null,
        policyVersionId: null, netMonthlyCents: null, teachingMentorAmountCents: "0",
        sourceAccountId: null, sourceAccountCode: null
      });
      continue;
    }
    if (row.snapshot_id === null || row.sequence_no === null || row.source_weekly_fee_version === null
      || row.policy_version_id === null || row.net_monthly_cents === null
      || row.snapshot_json === null || row.context_json === null
      || row.source_weekly_fee_version !== row.version) fail("RELATIONSHIP_DATA_UNAVAILABLE");
    const decoded = decodeSnapshot(row.snapshot_json, BigInt(row.gross_amount_cents));
    const groupLine = decoded.lines.find(line => line.key === "teachingMentor")
      ?? fail("RELATIONSHIP_DATA_UNAVAILABLE");
    const rawSnapshot = jsonObject(row.snapshot_json);
    const rawContext = jsonObject(row.context_json);
    const contextRelationships = jsonObject(rawContext.relationships);
    const contextAccounts = jsonObject(rawContext.accounts);
    if (rawContext.feeEntryId !== row.id || String(rawContext.feeVersion) !== row.version
      || rawContext.receiverPersonId !== teacherPersonId || rawContext.settlementMonth !== row.settlement_month) {
      fail("RELATIONSHIP_DATA_UNAVAILABLE");
    }
    let disposition: FrozenFee["disposition"] = "ZERO_SHARE";
    let sourceAccountId: string | null = null;
    let sourceAccountCode: string | null = null;
    if (groupLine.cents > 0n) {
      const requiredSourceAccount = sourceAccount ?? fail("RELATIONSHIP_DATA_UNAVAILABLE");
      const relationship = jsonObject(contextRelationships.teachingMentor);
      const account = jsonObject(contextAccounts.teachingMentor);
      sourceAccountId = storedUuid(account.accountId);
      sourceAccountCode = jsonString(account.accountCode);
      if (source === null || storedUuid(relationship.id) !== source.id || storedUuid(relationship.personId) !== source.related_person_id
        || account.ownerType !== "PERSON" || storedUuid(account.ownerId) !== source.related_person_id
        || sourceAccountId !== requiredSourceAccount.id || sourceAccountCode !== requiredSourceAccount.account_code
        || decoded.accountByKey.teachingMentor !== requiredSourceAccount.account_code) fail("RELATIONSHIP_DATA_UNAVAILABLE");
      disposition = "MOVE";
      movedFeeCount += 1;
      movedAmount += groupLine.cents;
    } else {
      zeroShareFeeCount += 1;
    }
    const frozen: FrozenFee = {
      feeEntryId: row.id, feeVersion: row.version, grossAmountCents: row.gross_amount_cents,
      teachingWeekId: row.teaching_week_id, weekStartsOn: row.week_starts_on,
      settlementMonth: row.settlement_month, disposition, refundEffectId: null,
      previousSnapshotId: row.snapshot_id, previousSnapshotSequence: row.sequence_no,
      previousSnapshotHash: digest({ snapshot: row.snapshot_json, context: row.context_json }),
      policyVersionId: row.policy_version_id, netMonthlyCents: row.net_monthly_cents,
      teachingMentorAmountCents: groupLine.cents.toString(), sourceAccountId, sourceAccountCode
    };
    frozenFees.push(frozen);
    if (disposition === "MOVE") runtimeFees.push({ frozen, rawSnapshot, rawContext, decoded });
  }
  const frozen: FrozenImpact = {
    schemaVersion: "teaching-mentor-change-preview.v1",
    teacherPersonId,
    effectiveWeek: {
      id: week.id, startsOn: week.starts_on, endsOn: week.ends_on,
      settlementMonth: week.settlement_month, kind: "REGULAR"
    },
    effectiveAt,
    nextBoundaryAt,
    effectiveThroughTeachingWeekId: draft.effectiveThroughTeachingWeekId ?? null,
    sourceRelationship: source === null ? null : relationshipFact(source),
    nextRelationship: next === null ? null : relationshipFact(next),
    candidate: {
      personId: candidate.person_id, nickname: candidate.nickname,
      userAccountId: candidate.user_account_id, roleAssignmentId: candidate.role_assignment_id,
      roleValidFrom: candidate.role_valid_from, roleValidTo: candidate.role_valid_to
    },
    destinationAccount: {
      id: destinationAccount.id, code: destinationAccount.account_code,
      ownerType: "PERSON", ownerId: destinationAccount.owner_id, status: "ACTIVE"
    },
    reason,
    fees: frozenFees,
    totals: {
      consideredFeeCount: rows.length - excludedRefundCount,
      movedFeeCount, zeroShareFeeCount, excludedRefundCount,
      movedAmountCents: movedAmount.toString()
    }
  };
  return {
    frozen, baseHash: digest(frozen), source, sourceRelatedNickname,
    week, candidate, destinationAccount, runtimeFees
  };
};

const previewResult = (id: string, impact: BuiltImpact): TeachingMentorChangePreviewResult => ({
  action: impact.source === null ? "ADD" : "REPLACE",
  previewId: id,
  baseHash: impact.baseHash,
  newRelatedNickname: impact.candidate.nickname,
  effectiveThroughTeachingWeekId: impact.frozen.effectiveThroughTeachingWeekId,
  teacherPersonId: impact.frozen.teacherPersonId,
  sourceRelatedPersonId: impact.source?.related_person_id ?? null,
  sourceRelatedNickname: impact.sourceRelatedNickname,
  newRelatedPersonId: impact.candidate.person_id,
  effectiveTeachingWeekId: impact.week.id,
  effectiveAt: impact.frozen.effectiveAt,
  nextBoundaryAt: impact.frozen.nextBoundaryAt,
  consideredFeeCount: impact.frozen.totals.consideredFeeCount,
  movedFeeCount: impact.frozen.totals.movedFeeCount,
  zeroShareFeeCount: impact.frozen.totals.zeroShareFeeCount,
  excludedRefundCount: impact.frozen.totals.excludedRefundCount,
  movedAmountCents: impact.frozen.totals.movedAmountCents
});

const mapReplay = (row: ChangeReplayRow, replay: boolean): TeachingMentorChangePublishResult => ({
  changeId: row.id,
  previewId: row.preview_id,
  relationshipVersion: integer(row.relationship_version),
  resultRelationshipId: row.result_relationship_id,
  postingStatus: row.posting_status,
  consideredFeeCount: row.considered_fee_count,
  movedFeeCount: row.moved_fee_count,
  excludedRefundCount: row.excluded_refund_count,
  movedAmountCents: row.moved_amount_cents,
  replay
});

export class PostgresTeachingMentorRelationshipService {
  public constructor(private readonly pool: PostgresPool) {}

  public async listCandidates(context: RoleContext, at: Date): Promise<readonly TeachingMentorCandidate[]> {
    assertAdmin(context);
    const atIso = assertAt(at);
    const client = await this.pool.connect();
    try {
      await readActorAssignment(client, context, atIso);
      const rows = (await client.query<{ person_id: string; nickname: string; directed_ids: string[] | null }>(
        `SELECT person.id::text AS person_id,person.nickname,
                CASE WHEN bool_or(role.scope_id IS NULL) THEN NULL ELSE array_agg(DISTINCT role.scope_id::text ORDER BY role.scope_id::text) END AS directed_ids
           FROM person
           JOIN user_account login ON login.person_id=person.id AND login.login_status='ACTIVE'
           JOIN settlement_account account ON account.owner_type='PERSON' AND account.owner_id=person.id AND account.status='ACTIVE'
           JOIN role_assignment role ON role.person_id=person.id AND role.subject_code='TEACHING_MENTOR'
             AND role.scope_type='MENTEES' AND role.valid_from<=$1::timestamptz
             AND (role.valid_to IS NULL OR role.valid_to>$1::timestamptz)
          WHERE person.status='ACTIVE'
          GROUP BY person.id,person.nickname
         HAVING count(DISTINCT login.id)=1 AND count(DISTINCT account.id)=1
            AND count(role.id)>=1
          ORDER BY person.nickname,person.id`, [atIso]
      )).rows;
      return rows.map(row => ({ personId: row.person_id, nickname: row.nickname, eligibleTeacherPersonIds: row.directed_ids }));
    } finally { await client.release(); }
  }

  public async listDirectory(context: RoleContext, at: Date): Promise<TeachingMentorDirectory> {
    assertAdmin(context);
    const atIso = assertAt(at);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await readActorAssignment(client, context, atIso);
      const teachers = (await client.query<{ person_id:string; nickname:string; mentor_person_id:string|null; mentor_nickname:string|null; relationship_id:string|null }>(
        `SELECT p.id::text person_id,p.nickname,
                r.related_person_id::text mentor_person_id, mentor.nickname mentor_nickname,r.id::text relationship_id
           FROM person p JOIN teacher_profile profile ON profile.person_id=p.id
           LEFT JOIN LATERAL (SELECT * FROM person_relationship r0 WHERE r0.teacher_id=p.id AND r0.relationship_type='TEACHING_MENTOR' AND r0.superseded_at IS NULL AND r0.valid_from<=$1::timestamptz AND (r0.valid_to IS NULL OR r0.valid_to>$1::timestamptz) ORDER BY r0.valid_from DESC,r0.id LIMIT 1) r ON true
           LEFT JOIN person mentor ON mentor.id=r.related_person_id
          WHERE p.status='ACTIVE' AND profile.employment_status='ACTIVE' AND profile.business_identity='TEACHING_TEACHER'
          ORDER BY p.nickname,p.id`, [atIso])).rows;
      const mentorRows = (await client.query<{ person_id:string; nickname:string; directed_ids:string[]|null }>(
        `SELECT person.id::text person_id,person.nickname,
                CASE WHEN bool_or(role.scope_id IS NULL) THEN NULL ELSE array_agg(DISTINCT role.scope_id::text ORDER BY role.scope_id::text) END directed_ids
           FROM person JOIN user_account login ON login.person_id=person.id AND login.login_status='ACTIVE'
           JOIN settlement_account account ON account.owner_type='PERSON' AND account.owner_id=person.id AND account.status='ACTIVE'
           JOIN role_assignment role ON role.person_id=person.id AND role.subject_code='TEACHING_MENTOR' AND role.scope_type='MENTEES'
             AND role.valid_from<=$1::timestamptz AND (role.valid_to IS NULL OR role.valid_to>$1::timestamptz)
          WHERE person.status='ACTIVE' GROUP BY person.id,person.nickname
         HAVING count(DISTINCT login.id)=1 AND count(DISTINCT account.id)=1 AND count(role.id)>=1
          ORDER BY person.nickname,person.id`, [atIso])).rows;
      const mentors = mentorRows.map(r => ({ personId:r.person_id, nickname:r.nickname, eligibleTeacherPersonIds:r.directed_ids }));
      const weeks = (await client.query<{id:string;starts_on:string;ends_on:string;settlement_month:string}>(
        `SELECT id::text,starts_on::text,ends_on::text,settlement_month::text FROM teaching_week
          WHERE week_kind='REGULAR' AND ends_on >= (($1::timestamptz AT TIME ZONE 'Asia/Shanghai')::date)
          ORDER BY starts_on,id`, [atIso])).rows;
      await client.query("COMMIT");
      return { teachers: teachers.map(r => ({ personId:r.person_id,nickname:r.nickname,currentMentorPersonId:r.mentor_person_id,currentMentorNickname:r.mentor_nickname,currentRelationshipId:r.relationship_id })), mentors, currentWeeks: weeks.map(r => ({id:r.id,startsOn:r.starts_on,endsOn:r.ends_on,settlementMonth:r.settlement_month})) };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { await client.release(); }
  }

  public async preview(
    context: RoleContext,
    draft: TeachingMentorChangePreviewDraft,
    at: Date
  ): Promise<TeachingMentorChangePreviewResult> {
    assertAdmin(context);
    const atIso = assertAt(at);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await lockSettlementAllocationShared(client);
      await readActorAssignment(client, context, atIso);
      const impact = await buildImpact(client, draft, atIso, false);
      const previewId = randomUUID();
      await client.query(
        `INSERT INTO teaching_mentor_relationship_change_preview(
           id,action,relationship_type,teacher_person_id,source_relationship_id,source_related_person_id,new_related_person_id,
           candidate_role_assignment_id,effective_teaching_week_id,effective_through_teaching_week_id,effective_at,next_boundary_at,reason,base_hash,
           impact_json,created_by_person_id,actor_subject_code,actor_scope_type,created_at
         ) VALUES($1,$2,'TEACHING_MENTOR',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,'GLOBAL',$17)`,
        [previewId, impact.source === null ? "ADD" : "REPLACE", impact.frozen.teacherPersonId, impact.source?.id ?? null, impact.source?.related_person_id ?? null,
          impact.candidate.person_id, impact.candidate.role_assignment_id, impact.week.id, impact.frozen.effectiveThroughTeachingWeekId, impact.frozen.effectiveAt,
          impact.frozen.nextBoundaryAt, impact.frozen.reason, impact.baseHash, encode(impact.frozen),
          context.personId, context.subject, atIso]
      );
      await client.query("COMMIT");
      return previewResult(previewId, impact);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { await client.release(); }
  }

  public async publish(
    context: RoleContext,
    previewIdInput: string,
    idempotencyKeyInput: string,
    at: Date
  ): Promise<TeachingMentorChangePublishResult> {
    assertAdmin(context);
    const previewId = uuid(previewIdInput);
    const idempotencyKey = cleanKey(idempotencyKeyInput);
    const atIso = assertAt(at);
    const requestHash = digest(["teaching-mentor-change.publish.v1", context.personId.toLowerCase(), previewId]);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockSettlementAllocationExclusive(client);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`relationship-change:${context.personId}:${idempotencyKey}`]);
      const replay = (await client.query<ChangeReplayRow>(
        `SELECT id::text,preview_id::text,request_hash,relationship_version::text,result_relationship_id::text,
                posting_status,considered_fee_count,moved_fee_count,excluded_refund_count,moved_amount_cents::text
           FROM teaching_mentor_relationship_change WHERE published_by_person_id=$1::uuid AND idempotency_key=$2`,
        [context.personId, idempotencyKey]
      )).rows[0];
      if (replay !== undefined) {
        if (replay.request_hash !== requestHash || replay.preview_id !== previewId) fail("IDEMPOTENCY_REPLAY");
        await client.query("COMMIT");
        return mapReplay(replay, true);
      }
      await readActorAssignment(client, context, atIso);
      const preview = (await client.query<PreviewRow>(
        `SELECT id::text,teacher_person_id::text,source_relationship_id::text,source_related_person_id::text,
                new_related_person_id::text,candidate_role_assignment_id::text,effective_teaching_week_id::text,effective_through_teaching_week_id::text,
                teaching_mentor_timestamp_text(effective_at) AS effective_at,
                teaching_mentor_timestamp_text(next_boundary_at) AS next_boundary_at,
                reason,base_hash,impact_json,teaching_mentor_timestamp_text(created_at) AS created_at
           FROM teaching_mentor_relationship_change_preview WHERE id=$1::uuid FOR SHARE`, [previewId]
      )).rows[0];
      const requiredPreview = preview ?? fail("RELATIONSHIP_PREVIEW_NOT_FOUND");
      if (compareInstants(atIso, requiredPreview.created_at) < 0) fail("INVALID_INPUT");
      const alreadyPublished = (await client.query<{ id: string }>(
        "SELECT id::text FROM teaching_mentor_relationship_change WHERE preview_id=$1::uuid", [previewId]
      )).rows[0];
      if (alreadyPublished !== undefined) fail("RELATIONSHIP_PREVIEW_ALREADY_PUBLISHED");
      const storedImpact = jsonObject(requiredPreview.impact_json);
      const storedFees = storedImpact.fees;
      if (!Array.isArray(storedFees)) fail("RELATIONSHIP_DATA_UNAVAILABLE");
      const previewMonths = (storedFees as unknown[]).map(item => jsonString(jsonObject(item).settlementMonth));
      const currentMonths = (await client.query<{ settlement_month: string }>(
        `SELECT DISTINCT fee.settlement_month::text AS settlement_month
           FROM weekly_fee_entry fee JOIN referral_case referral ON referral.id=fee.referral_case_id
           JOIN teaching_week week ON week.id=fee.teaching_week_id
          WHERE referral.receiver_person_id=$1::uuid AND week.week_kind='REGULAR'
            AND (week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai') >= $2::timestamptz
            AND ($3::timestamptz IS NULL OR (week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai') < $3::timestamptz)
          ORDER BY settlement_month`, [requiredPreview.teacher_person_id, requiredPreview.effective_at, requiredPreview.next_boundary_at]
      )).rows.map(row => row.settlement_month);
      const months = [...new Set([...previewMonths, ...currentMonths])].sort();
      for (const month of months) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`settlement-month:${month}`]);
      }
      let impact: BuiltImpact;
      try {
        impact = await buildImpact(client, {
          teacherPersonId: requiredPreview.teacher_person_id,
          newRelatedPersonId: requiredPreview.new_related_person_id,
          effectiveTeachingWeekId: requiredPreview.effective_teaching_week_id,
          effectiveThroughTeachingWeekId: requiredPreview.effective_through_teaching_week_id,
          reason: requiredPreview.reason
        }, atIso, true);
      } catch (error) {
        if (error instanceof Error && [
          "INVALID_INPUT", "RELATIONSHIP_DATA_UNAVAILABLE", "TEACHING_MENTOR_RELATIONSHIP_MISSING",
          "TEACHING_MENTOR_RELATIONSHIP_AMBIGUOUS", "TEACHING_MENTOR_CANDIDATE_NOT_ELIGIBLE",
          "TEACHING_MENTOR_CANDIDATE_AMBIGUOUS", "RELATIONSHIP_TARGET_UNCHANGED",
          "RELATIONSHIP_EFFECTIVE_WEEK_NOT_CURRENT"
        ].includes(error.message)) fail("RELATIONSHIP_PREVIEW_STALE");
        throw error;
      }
      if (impact.baseHash !== requiredPreview.base_hash || digest(requiredPreview.impact_json) !== requiredPreview.base_hash
        || (impact.source?.id ?? null) !== requiredPreview.source_relationship_id
        || (impact.source?.related_person_id ?? null) !== requiredPreview.source_related_person_id
        || impact.frozen.effectiveThroughTeachingWeekId !== requiredPreview.effective_through_teaching_week_id
        || impact.candidate.role_assignment_id !== requiredPreview.candidate_role_assignment_id
        || compareInstants(impact.frozen.effectiveAt, requiredPreview.effective_at) !== 0
        || (impact.frozen.nextBoundaryAt === null) !== (requiredPreview.next_boundary_at === null)
        || (impact.frozen.nextBoundaryAt !== null && requiredPreview.next_boundary_at !== null
          && compareInstants(impact.frozen.nextBoundaryAt, requiredPreview.next_boundary_at) !== 0)) {
        fail("RELATIONSHIP_PREVIEW_STALE");
      }

      const changeId = randomUUID();
      const resultRelationshipId = randomUUID();
      let continuationRelationshipId: string | null = null;
      const sameBoundary = impact.source !== null && compareInstants(impact.source.valid_from, impact.frozen.effectiveAt) === 0;
      if (impact.source !== null && sameBoundary) {
        const updated = await client.query(
          `UPDATE person_relationship SET valid_to=$2::timestamptz,superseded_at=$3::timestamptz,superseded_by_teaching_mentor_change_id=$4::uuid
            WHERE id=$1::uuid AND superseded_at IS NULL`, [impact.source.id, impact.frozen.nextBoundaryAt, atIso, changeId]
        );
        if (updated.rowCount !== 1) fail("RELATIONSHIP_PREVIEW_STALE");
      } else if (impact.source !== null) {
        const updated = await client.query(
          `UPDATE person_relationship SET valid_to=$2::timestamptz
            WHERE id=$1::uuid AND superseded_at IS NULL AND valid_from<$2::timestamptz
              AND (valid_to IS NULL OR valid_to>$2::timestamptz)`,
          [impact.source.id, impact.frozen.effectiveAt]
        );
        if (updated.rowCount !== 1) fail("RELATIONSHIP_PREVIEW_STALE");
      }
      await client.query(
        `INSERT INTO person_relationship(
           id,teacher_id,relationship_type,related_person_id,valid_from,valid_to,effective_scope,created_by,created_at
         ) VALUES($1,$2,'TEACHING_MENTOR',$3,$4,$5,$6,$7,$8)`,
        [resultRelationshipId, impact.frozen.teacherPersonId, impact.candidate.person_id,
          impact.frozen.effectiveAt, impact.frozen.nextBoundaryAt,
          `REGULAR_WEEK:${impact.week.id}`, context.personId, atIso]
      );
      if (impact.source !== null && impact.frozen.nextBoundaryAt !== null &&
          (impact.source.valid_to === null || compareInstants(impact.source.valid_to, impact.frozen.nextBoundaryAt) > 0)) {
        const existingAtBoundary = (await client.query<{id:string}>(
          `SELECT id::text FROM person_relationship WHERE teacher_id=$1::uuid AND relationship_type='TEACHING_MENTOR'
             AND superseded_at IS NULL AND valid_from=$2::timestamptz LIMIT 1`,
          [impact.frozen.teacherPersonId, impact.frozen.nextBoundaryAt])).rows[0];
        if (existingAtBoundary === undefined) {
          continuationRelationshipId = randomUUID();
          await client.query(
            `INSERT INTO person_relationship(id,teacher_id,relationship_type,related_person_id,valid_from,valid_to,effective_scope,created_by,created_at)
             VALUES($1,$2,'TEACHING_MENTOR',$3,$4,$5,$6,$7,$8)`,
            [continuationRelationshipId, impact.frozen.teacherPersonId, impact.source.related_person_id, impact.frozen.nextBoundaryAt,
              impact.source.valid_to, impact.source.effective_scope, context.personId, atIso]);
        }
      }
      const sourceAfter = impact.source === null ? null : (await client.query<RelationshipRow>(
        `SELECT id::text,teacher_id::text,relationship_type,related_person_id::text,
                teaching_mentor_timestamp_text(valid_from) AS valid_from,
                teaching_mentor_timestamp_text(valid_to) AS valid_to,
                effective_scope,created_by::text,teaching_mentor_timestamp_text(created_at) AS created_at,
                teaching_mentor_timestamp_text(superseded_at) AS superseded_at,superseded_by_teaching_mentor_change_id::text
           FROM person_relationship WHERE id=$1::uuid`, [impact.source.id]
      )).rows[0] ?? null;
      const resultRelationship = (await client.query<RelationshipRow>(
        `SELECT id::text,teacher_id::text,relationship_type,related_person_id::text,
                teaching_mentor_timestamp_text(valid_from) AS valid_from,
                teaching_mentor_timestamp_text(valid_to) AS valid_to,
                effective_scope,created_by::text,teaching_mentor_timestamp_text(created_at) AS created_at,
                teaching_mentor_timestamp_text(superseded_at) AS superseded_at,superseded_by_teaching_mentor_change_id::text
           FROM person_relationship WHERE id=$1::uuid`, [resultRelationshipId]
      )).rows[0];
      const continuationRelationship = continuationRelationshipId === null ? null : (await client.query<RelationshipRow>(
        `SELECT id::text,teacher_id::text,relationship_type,related_person_id::text,
                teaching_mentor_timestamp_text(valid_from) AS valid_from,
                teaching_mentor_timestamp_text(valid_to) AS valid_to,
                effective_scope,created_by::text,teaching_mentor_timestamp_text(created_at) AS created_at,
                teaching_mentor_timestamp_text(superseded_at) AS superseded_at,superseded_by_teaching_mentor_change_id::text
           FROM person_relationship WHERE id=$1::uuid`, [continuationRelationshipId]
      )).rows[0] ?? fail("RELATIONSHIP_DATA_UNAVAILABLE");
      const requiredSourceAfter = sourceAfter;
      const requiredResultRelationship = resultRelationship ?? fail("RELATIONSHIP_DATA_UNAVAILABLE");

      const relationshipVersionRow = (await client.query<{ version: string }>(
        `SELECT (COALESCE(max(relationship_version),0)+1)::text AS version
           FROM teaching_mentor_relationship_change WHERE teacher_person_id=$1::uuid AND relationship_type='TEACHING_MENTOR'`,
        [impact.frozen.teacherPersonId]
      )).rows[0];
      const requiredVersionRow = relationshipVersionRow ?? fail("RELATIONSHIP_DATA_UNAVAILABLE");
      const relationshipVersion = integer(requiredVersionRow.version);
      const effects: Array<{
        runtime: RuntimeFee;
        resultSnapshotId: string;
        nextSnapshot: JsonObject;
        nextContext: JsonObject;
      }> = [];
      const deltas: LedgerDelta[] = [];
      for (const runtime of impact.runtimeFees) {
        const nextSnapshot = cloneObject(runtime.rawSnapshot);
        const accountByKey = jsonObject(nextSnapshot.accountByKey);
        accountByKey.teachingMentor = impact.destinationAccount.account_code;
        const nextContext = cloneObject(runtime.rawContext);
        const relationships = jsonObject(nextContext.relationships);
        relationships.teachingMentor = { id: resultRelationshipId, personId: impact.candidate.person_id };
        const accounts = jsonObject(nextContext.accounts);
        accounts.teachingMentor = {
          ownerType: "PERSON", ownerId: impact.candidate.person_id,
          accountId: impact.destinationAccount.id, accountCode: impact.destinationAccount.account_code
        };
        const nextDecoded = decodeSnapshot(nextSnapshot, BigInt(runtime.frozen.grossAmountCents));
        const feeDeltas = allocationDelta(
          runtime.decoded.lines, nextDecoded.lines, runtime.decoded.accountByKey, nextDecoded.accountByKey
        );
        if (feeDeltas.length !== 2 || feeDeltas.some(delta => delta.categoryKey !== "teachingMentor")) {
          fail("RELATIONSHIP_DATA_UNAVAILABLE");
        }
        deltas.push(...feeDeltas);
        effects.push({ runtime, resultSnapshotId: randomUUID(), nextSnapshot, nextContext });
      }
      const combined = aggregate(deltas);
      if (combined.some(delta => delta.categoryKey !== "teachingMentor")
        || (effects.length === 0) !== (combined.length === 0)) fail("RELATIONSHIP_DATA_UNAVAILABLE");

      let runId: string | null = null;
      let ledgerEventId: string | null = null;
      let postingStatus: "POSTED" | "NO_BALANCE_CHANGE" = "NO_BALANCE_CHANGE";
      if (effects.length > 0) {
        const anchor = effects[0]!.runtime.frozen;
        runId = randomUUID();
        const eventKey = `weekly-settlement:relationship-change:${changeId}`;
        const prepared = await prepareLedgerPosting(client, eventKey, combined.map(delta => delta.accountKey));
        const expectedAccounts = new Map<string, { id: string; ownerId: string; activeRequired: boolean }>();
        for (const effect of effects) {
          const source = effect.runtime.frozen;
          const sourceAccountCode = source.sourceAccountCode ?? fail("RELATIONSHIP_DATA_UNAVAILABLE");
          const sourceAccountId = source.sourceAccountId ?? fail("RELATIONSHIP_DATA_UNAVAILABLE");
          const sourceRelationship = impact.source ?? fail("RELATIONSHIP_DATA_UNAVAILABLE");
          expectedAccounts.set(sourceAccountCode, {
            id: sourceAccountId, ownerId: sourceRelationship.related_person_id, activeRequired: false
          });
        }
        expectedAccounts.set(impact.destinationAccount.account_code, {
          id: impact.destinationAccount.id, ownerId: impact.candidate.person_id, activeRequired: true
        });
        if (prepared.length !== expectedAccounts.size || prepared.some(account => {
          const expected = expectedAccounts.get(account.accountCode);
          return expected === undefined || account.id !== expected.id || account.ownerType !== "PERSON"
            || account.ownerId !== expected.ownerId || (expected.activeRequired && account.status !== "ACTIVE");
        })) fail("RELATIONSHIP_PREVIEW_STALE");
        const bound = createPostgresLedgerTransaction(client);
        const posted = await postLedgerEvent({ transaction: work => work(bound) }, {
          eventKey,
          eventType: "WEEKLY_FEE_SETTLEMENT",
          payloadHash: digest({ changeId, previewId, baseHash: impact.baseHash,
            effects: effects.map(effect => ({
              feeEntryId: effect.runtime.frozen.feeEntryId,
              previousSnapshotId: effect.runtime.frozen.previousSnapshotId,
              resultSnapshotId: effect.resultSnapshotId,
              amountCents: effect.runtime.frozen.teachingMentorAmountCents
            })) }),
          deltas: combined
        }, randomUUID);
        if (posted.status !== "POSTED") fail("RELATIONSHIP_DATA_UNAVAILABLE");
        ledgerEventId = posted.event.eventId;
        postingStatus = "POSTED";
        await client.query(
          `INSERT INTO settlement_calculation_run(
             id,request_key,fee_entry_id,fee_version,actor_person_id,status,ledger_event_id,created_at
           ) VALUES($1,$2,$3,$4,$5,'POSTED',$6,$7)`,
          [runId, `relationship-change:${changeId}`, anchor.feeEntryId, anchor.feeVersion,
            context.personId, ledgerEventId, atIso]
        );
        for (const effect of effects) {
          const source = effect.runtime.frozen;
          await client.query(
            `INSERT INTO weekly_fee_allocation_snapshot(
               id,run_id,weekly_fee_entry_id,source_weekly_fee_version,policy_version_id,
               net_monthly_cents,snapshot_json,context_json,created_at
             ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
            [effect.resultSnapshotId, runId, source.feeEntryId, source.feeVersion,
              source.policyVersionId, source.netMonthlyCents, encode(effect.nextSnapshot),
              encode(effect.nextContext), atIso]
          );
        }
      } else {
        const lockedDestination = (await client.query<AccountRow>(
          `SELECT id::text,owner_type,owner_id::text,account_code,status FROM settlement_account
            WHERE account_code=$1 FOR NO KEY UPDATE`, [impact.destinationAccount.account_code]
        )).rows[0];
        if (lockedDestination === undefined || lockedDestination.id !== impact.destinationAccount.id
          || lockedDestination.owner_type !== "PERSON" || lockedDestination.owner_id !== impact.candidate.person_id
          || lockedDestination.status !== "ACTIVE") fail("RELATIONSHIP_PREVIEW_STALE");
      }
      const movedAmountCents = impact.frozen.totals.movedAmountCents;
      const beforeJson = { sourceRelationship: impact.source === null ? null : relationshipFact(impact.source) };
      const afterJson = {
        sourceRelationship: requiredSourceAfter === null ? null : relationshipFact(requiredSourceAfter),
        resultRelationship: relationshipFact(requiredResultRelationship),
        ...(continuationRelationship === null ? {} : { continuationRelationship: relationshipFact(continuationRelationship) })
      };
      await client.query(
        `INSERT INTO teaching_mentor_relationship_change(
           id,preview_id,action,relationship_type,teacher_person_id,relationship_version,source_relationship_id,
           result_relationship_id,continuation_relationship_id,source_related_person_id,new_related_person_id,candidate_role_assignment_id,
           effective_teaching_week_id,effective_through_teaching_week_id,effective_at,next_boundary_at,reason,idempotency_key,request_hash,base_hash,
           posting_status,settlement_calculation_run_id,ledger_event_id,considered_fee_count,moved_fee_count,
           excluded_refund_count,moved_amount_cents,before_json,after_json,published_by_person_id,
           actor_subject_code,actor_scope_type,published_at,created_at
         ) VALUES($1,$2,$3,'TEACHING_MENTOR',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27::jsonb,$28::jsonb,$29,$30,'GLOBAL',$31,$31)`,
        [changeId, previewId, impact.source === null ? "ADD" : "REPLACE", impact.frozen.teacherPersonId, relationshipVersion, impact.source?.id ?? null,
          resultRelationshipId, continuationRelationshipId, impact.source?.related_person_id ?? null, impact.candidate.person_id,
          impact.candidate.role_assignment_id, impact.week.id, impact.frozen.effectiveThroughTeachingWeekId, impact.frozen.effectiveAt,
          impact.frozen.nextBoundaryAt, impact.frozen.reason, idempotencyKey, requestHash,
          impact.baseHash, postingStatus, runId, ledgerEventId,
          impact.frozen.totals.consideredFeeCount, effects.length,
          impact.frozen.totals.excludedRefundCount, movedAmountCents,
          encode(beforeJson), encode(afterJson), context.personId, context.subject, atIso]
      );
      for (const effect of effects) {
        const source = effect.runtime.frozen;
        if (source.previousSnapshotId === null || source.sourceAccountId === null || runId === null) {
          fail("RELATIONSHIP_DATA_UNAVAILABLE");
        }
        await client.query(
          `INSERT INTO teaching_mentor_relationship_change_effect(
             change_id,weekly_fee_entry_id,source_weekly_fee_version,teaching_week_id,settlement_month,
             previous_snapshot_id,result_snapshot_id,settlement_calculation_run_id,teaching_mentor_amount_cents,
             source_account_id,destination_account_id,created_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [changeId, source.feeEntryId, source.feeVersion, source.teachingWeekId,
            source.settlementMonth, source.previousSnapshotId, effect.resultSnapshotId,
            runId, source.teachingMentorAmountCents, source.sourceAccountId,
            impact.destinationAccount.id, atIso]
        );
      }
      await client.query(
        `INSERT INTO audit_event(actor_person_id,action_code,subject_type,subject_id,before_json,after_json,reason,created_at)
         VALUES($1,'TEACHING_MENTOR_RELATIONSHIP_CHANGED','PERSON_RELATIONSHIP',$2,$3::jsonb,$4::jsonb,$5,$6)`,
        [context.personId, resultRelationshipId, encode(beforeJson), encode(afterJson), impact.frozen.reason, atIso]
      );
      await client.query("COMMIT");
      return {
        changeId, previewId, relationshipVersion, resultRelationshipId, postingStatus,
        consideredFeeCount: impact.frozen.totals.consideredFeeCount,
        movedFeeCount: effects.length,
        excludedRefundCount: impact.frozen.totals.excludedRefundCount,
        movedAmountCents,
        replay: false
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { await client.release(); }
  }
}
