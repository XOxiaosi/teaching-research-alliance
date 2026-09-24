import { createHash, randomUUID } from "node:crypto";
import type { RoleContext } from "@teaching-research-alliance/contracts";
import {
  allocationDelta,
  allocateRationalCents,
  postLedgerEvent,
  type LedgerDelta,
} from "@teaching-research-alliance/domain";
import {
  createPostgresLedgerTransaction,
  type PostgresClient,
  type PostgresPool,
} from "./postgres-ledger-repository.js";
import { prepareLedgerPosting } from "./postgres-ledger-locks.js";
import {
  lockSettlementAllocationExclusive,
  lockSettlementAllocationShared,
} from "./postgres-settlement-allocation-gate.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEYS = [
  "referrer",
  "planningMentor",
  "groupLeader",
  "teachingMentor",
  "venue",
  "campusConsultation",
  "platformFinance",
  "regionFinance",
  "teachingTeacher",
] as const;
type Json = Record<string, unknown>;
type Action = "ADD" | "REPLACE" | "REMOVE";
type Account = {
  id: string;
  account_code: string;
  owner_id: string;
  status: string;
  nickname?: string;
};
type AccountFact = {
  id: string;
  accountCode: string;
  ownerType: string;
  ownerId: string;
  status: string;
};
type Relationship = {
  id: string;
  teacher_id: string;
  related_person_id: string;
  valid_from: string;
  valid_to: string | null;
  effective_scope: string | null;
  created_by: string;
  created_at: string;
  superseded_at: string | null;
  superseded_by_change_id: string | null;
  superseded_by_planning_mentor_change_id: string | null;
  superseded_by_admin_planning_mentor_change_id: string | null;
};
type Week = {
  id: string;
  starts_on: string;
  ends_on: string;
  settlement_month: string;
  week_kind: string;
  current: boolean;
};
type Fee = {
  id: string;
  version: string;
  gross_amount_cents: string;
  teaching_week_id: string;
  settlement_month: string;
  refund_id: string | null;
  snapshot_id: string | null;
  sequence_no: string | null;
  snapshot_source_weekly_fee_version: string | null;
  policy_version_id: string | null;
  net_monthly_cents: string | null;
  snapshot_json: unknown;
  context_json: unknown;
};
type Decoded = {
  lines: { key: string; cents: bigint }[];
  accountByKey: Record<string, string>;
};
type FeeImpact = {
  feeId: string;
  version: string;
  teachingWeekId: string;
  settlementMonth: string;
  refundId: string | null;
  snapshotId: string | null;
  sequenceNo: string | null;
  snapshotHash: string | null;
  policyVersionId: string | null;
  netMonthlyCents: string | null;
  disposition: "REFUNDED" | "UNCHANGED" | "CHANGE";
};
type Impact = {
  schemaVersion: "admin-planning-mentor-relationship-preview.v1";
  action: Action;
  mentorPersonId: string;
  plannerPersonId: string;
  sourceRelationship: ReturnType<typeof fact> | null;
  resultRelationshipId: string | null;
  continuationRelationshipId: string | null;
  actorRoleAssignmentId: string;
  actorRoleScopeId: string | null;
  destinationMentorAccount: { id: string; code: string; ownerId: string; status: string } | null;
  plannerAccount: { id: string; code: string; ownerId: string; status: string };
  week: {
    id: string;
    startsOn: string;
    endsOn: string;
    settlementMonth: string;
  };
  effectiveAt: string;
  nextBoundaryAt: string | null;
  effectiveThroughTeachingWeekId: string | null;
  reason: string;
  fees: FeeImpact[];
  totals: {
    consideredFeeCount: number;
    changedFeeCount: number;
    zeroShareFeeCount: number;
    excludedRefundCount: number;
    plannerDeltaCents: string;
    sourceMentorDeltaCents: string;
    destinationMentorDeltaCents: string;
  };
};
type Runtime = {
  fee: Fee;
  frozen: FeeImpact;
  snapshot: Json;
  context: Json;
  decoded: Decoded;
};
type Effect = {
  runtime: Runtime;
  next: { snapshot: Json; context: Json };
  id: string;
  nextDecoded: Decoded;
  deltas: readonly LedgerDelta[];
};
type ChangeReplayRow = {
  id: string;
  preview_id: string;
  action: Action;
  relationship_version: string;
  result_relationship_id: string | null;
  posting_status: "POSTED" | "NO_BALANCE_CHANGE";
  considered_fee_count: number;
  changed_fee_count: number;
  excluded_refund_count: number;
  planner_delta_cents: string;
  source_mentor_delta_cents: string;
  destination_mentor_delta_cents: string;
  request_hash: string;
};
type PreviewRow = {
  id: string;
  action: Action;
  mentor_person_id: string;
  planner_person_id: string;
  result_relationship_id: string | null;
  continuation_relationship_id: string | null;
  effective_teaching_week_id: string;
  effective_through_teaching_week_id: string | null;
  reason: string;
  base_hash: string;
  impact_json: unknown;
};
type Built = {
  impact: Impact;
  hash: string;
  source: Relationship | null;
  resultId: string | null;
  continuationId: string | null;
  plannerNickname: string;
  destinationMentorAccount: Account | null;
  sourceMentorNickname: string | null;
  destinationMentorNickname: string | null;
  sourceAccountCodes: readonly string[];
  runtimes: Runtime[];
};

export type AdminPlanningMentorRelationshipPreviewDraft = Readonly<{
  action: Action;
  plannerPersonId: string;
  newMentorPersonId?: string | null;
  effectiveTeachingWeekId: string;
  effectiveThroughTeachingWeekId?: string | null;
  reason: string;
}>;
export type AdminPlanningMentorRelationshipPreviewResult = Readonly<{
  previewId: string;
  action: Action;
  plannerPersonId: string;
  plannerNickname: string;
  sourceMentorPersonId?: string | null;
  sourceMentorNickname?: string | null;
  newMentorPersonId?: string | null;
  newMentorNickname?: string | null;
  effectiveThroughTeachingWeekId?: string | null;
  effectiveTeachingWeekId: string;
  effectiveAt: string;
  nextBoundaryAt: string | null;
  consideredFeeCount: number;
  changedFeeCount: number;
  zeroShareFeeCount: number;
  excludedRefundCount: number;
  plannerDeltaCents: string;
  sourceMentorDeltaCents?: string;
  destinationMentorDeltaCents?: string;
  /** Transitional fields retained while the HTTP adapter is being wired. */
  mentorPersonId?: string;
  mentorDeltaCents?: string;
}>;
export type AdminPlanningMentorRelationshipPublishResult = Readonly<{
  changeId: string;
  previewId: string;
  action: Action;
  relationshipVersion: number;
  resultRelationshipId: string | null;
  postingStatus: "POSTED" | "NO_BALANCE_CHANGE";
  consideredFeeCount: number;
  changedFeeCount: number;
  excludedRefundCount: number;
  plannerDeltaCents: string;
  sourceMentorDeltaCents?: string;
  destinationMentorDeltaCents?: string;
  mentorDeltaCents?: string;
  replay: boolean;
}>;
export type AdminPlanningMentorRelationshipDirectory = Readonly<{
  planners: readonly {
    personId: string;
    nickname: string;
    currentMentorPersonId: string | null;
    currentMentorNickname: string | null;
    currentRelationshipId: string | null;
  }[];
  mentors: readonly { personId: string; nickname: string }[];
  currentWeeks: readonly {
    id: string;
    startsOn: string;
    endsOn: string;
    settlementMonth: string;
  }[];
  mentorPersonId?: string;
  mentorNickname?: string;
  managedPlanners?: readonly { personId: string; nickname: string; relationshipId: string; validFrom: string; validTo: string | null }[];
  availablePlanners?: readonly { personId: string; nickname: string }[];
}>;

const fail = (code: string): never => {
  throw new Error(code);
};
const obj = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : fail("RELATIONSHIP_DATA_UNAVAILABLE");
const str = (value: unknown): string =>
  typeof value === "string" ? value : fail("RELATIONSHIP_DATA_UNAVAILABLE");
const uuid = (value: string): string =>
  UUID.test(value) ? value.toLowerCase() : fail("INVALID_INPUT");
const bigint = (value: unknown): bigint => {
  const text = str(value);
  if (!/^-?\d+$/.test(text)) fail("RELATIONSHIP_DATA_UNAVAILABLE");
  return BigInt(text);
};
const integer = (value: string): number => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0
    ? n
    : fail("RELATIONSHIP_DATA_UNAVAILABLE");
};
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value as Json)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : typeof value === "bigint"
        ? value.toString()
        : value;
const encode = (value: unknown): string => JSON.stringify(canonical(value));
const hash = (value: unknown): string =>
  createHash("sha256").update(encode(value)).digest("hex");
const clone = (value: Json): Json => JSON.parse(JSON.stringify(value)) as Json;
const iso = (at: Date): string =>
  Number.isFinite(at.getTime()) ? at.toISOString() : fail("INVALID_INPUT");
const reason = (value: string): string => {
  const out = value.trim();
  return out && out.length <= 1000 && !/[\x00-\x1f\x7f]/.test(out)
    ? out
    : fail("INVALID_INPUT");
};
const key = (value: string): string => {
  const out = value.trim();
  return out && out.length <= 200 && !/[\x00-\x1f\x7f]/.test(out)
    ? out
    : fail("INVALID_INPUT");
};
const fact = (row: Relationship) => ({
  id: row.id,
  teacherPersonId: row.teacher_id,
  relationshipType: "PLANNING_MENTOR",
  relatedPersonId: row.related_person_id,
  validFrom: row.valid_from,
  validTo: row.valid_to,
  effectiveScope: row.effective_scope,
  createdByPersonId: row.created_by,
  createdAt: row.created_at,
  supersededAt: row.superseded_at,
  supersededByChangeId: row.superseded_by_change_id,
  supersededByPlanningMentorChangeId:
    row.superseded_by_planning_mentor_change_id,
  supersededByAdminPlanningMentorChangeId:
    row.superseded_by_admin_planning_mentor_change_id,
});
const instant = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? parsed
    : fail("RELATIONSHIP_DATA_UNAVAILABLE");
};
const sameInstant = (left: string, right: string): boolean =>
  instant(left) === instant(right);
const activeAt = (from: string, to: string | null, at: string) =>
  instant(from) <= instant(at) && (to === null || instant(to) > instant(at));

const assertContext = (context: RoleContext): void => {
  if (
    !["SYSTEM_OWNER", "SYSTEM_ADMIN"].includes(context.subject) ||
    context.scope !== "GLOBAL" ||
    !UUID.test(context.personId) ||
    context.regionId !== undefined ||
    context.campusId !== undefined ||
    context.venueId !== undefined
  )
    fail("FORBIDDEN_SCOPE");
};
const actor = async (
  client: PostgresClient,
  context: RoleContext,
  at: string,
): Promise<{ id: string; scope_id: string | null }> => {
  const rows = (
    await client.query<{ id: string; scope_id: string | null }>(
      `SELECT id::text,scope_id::text FROM role_assignment WHERE person_id=$1::uuid AND subject_code=$2 AND scope_type='GLOBAL' AND scope_id IS NULL AND valid_from<=$3::timestamptz AND (valid_to IS NULL OR valid_to>$3::timestamptz) ORDER BY id LIMIT 2 FOR SHARE`,
      [context.personId, context.subject, at],
    )
  ).rows;
  if (rows.length !== 1) fail("FORBIDDEN_SCOPE");
  return rows[0]!;
};
const week = async (
  client: PostgresClient,
  id: string,
  at: string,
): Promise<Week> => {
  const rows = (
    await client.query<Week>(
      `SELECT id::text,starts_on::text,ends_on::text,settlement_month::text,week_kind,(($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date BETWEEN starts_on AND ends_on) current FROM teaching_week WHERE id=$1::uuid`,
      [id, at],
    )
  ).rows;
  if (rows.length !== 1) fail("RELATIONSHIP_EFFECTIVE_WEEK_NOT_FOUND");
  if (rows[0]!.week_kind !== "REGULAR")
    fail("RELATIONSHIP_SPECIAL_PERIOD_SCOPE_REQUIRED");
  const localDate = new Date(at).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  if (rows[0]!.ends_on < localDate) fail("RELATIONSHIP_EFFECTIVE_WEEK_NOT_CURRENT");
  return rows[0]!;
};
const decode = (snapshot: unknown, gross: bigint): Decoded => {
  const raw = obj(snapshot),
    map = obj(raw.accountByKey);
  if (!Array.isArray(raw.lines) || raw.lines.length !== KEYS.length)
    fail("RELATIONSHIP_DATA_UNAVAILABLE");
  const rawLines = raw.lines as unknown[];
  const lines: { key: string; cents: bigint }[] = rawLines.map(
    (value: unknown) => {
      const row = obj(value);
      return { key: str(row.key), cents: bigint(row.cents) };
    },
  );
  if (
    new Set(lines.map((x) => x.key)).size !== KEYS.length ||
    lines.some((x) => !KEYS.includes(x.key as (typeof KEYS)[number])) ||
    lines.some((x) => x.cents < 0n) ||
    lines.reduce((sum, x) => sum + x.cents, 0n) !== gross
  )
    fail("RELATIONSHIP_DATA_UNAVAILABLE");
  const accountByKey: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (!KEYS.includes(k as (typeof KEYS)[number]))
      fail("RELATIONSHIP_DATA_UNAVAILABLE");
    accountByKey[k] = str(v);
  }
  if (lines.some((x) => x.cents !== 0n && !accountByKey[x.key]))
    fail("RELATIONSHIP_DATA_UNAVAILABLE");
  return { lines, accountByKey };
};
const aggregate = (deltas: LedgerDelta[]): LedgerDelta[] => {
  const all = new Map<string, LedgerDelta>();
  for (const d of deltas) {
    const k = encode([d.accountKey, d.categoryKey]);
    all.set(k, {
      ...d,
      amountCents: (all.get(k)?.amountCents ?? 0n) + d.amountCents,
    });
  }
  return [...all.values()]
    .filter((d) => d.amountCents !== 0n)
    .sort((a, b) =>
      encode([a.accountKey, a.categoryKey]).localeCompare(
        encode([b.accountKey, b.categoryKey]),
      ),
    );
};

/**
 * A snapshot only carries account codes.  Account ownership and status remain
 * mutable database facts, so freeze their full current rows in the preview
 * hash and share-lock them while publishing.  This prevents posting an old
 * snapshot to an account that has since been disabled or reassigned.
 */
const snapshotAccountFacts = async (
  client: PostgresClient,
  decoded: Decoded,
  lock: boolean,
  allowedInactiveCodes: ReadonlySet<string> = new Set(),
): Promise<readonly AccountFact[]> => {
  const codes = [
    ...new Set(
      decoded.lines
        .filter((line) => line.cents !== 0n)
        .map((line) => decoded.accountByKey[line.key] ?? ""),
    ),
  ].sort();
  if (codes.some((code) => !code)) fail("RELATIONSHIP_DATA_UNAVAILABLE");
  const rows = (
    await client.query<{
      id: string;
      account_code: string;
      owner_type: string;
      owner_id: string;
      status: string;
    }>(
      `SELECT id::text,account_code,owner_type,owner_id::text,status
         FROM settlement_account
        WHERE account_code=ANY($1::text[])
        ORDER BY account_code,id${lock ? " FOR SHARE" : ""}`,
      [codes],
    )
  ).rows;
  if (
    rows.length !== codes.length ||
    new Set(rows.map((row) => row.account_code)).size !== codes.length ||
    rows.some(
      (row) => row.status !== "ACTIVE" && !allowedInactiveCodes.has(row.account_code),
    )
  )
    fail("RELATIONSHIP_DATA_UNAVAILABLE");
  return rows.map((row) => ({
    id: row.id,
    accountCode: row.account_code,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    status: row.status,
  }));
};

const relationAt = async (
  client: PostgresClient,
  planner: string,
  effectiveAt: string,
  lock: boolean,
): Promise<{ current: Relationship | null; next: Relationship | null }> => {
  const suffix = lock ? " FOR UPDATE" : " FOR SHARE";
  const rows = (
    await client.query<Relationship>(
      `SELECT id::text,teacher_id::text,related_person_id::text,
              to_char(valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') valid_from,
              to_char(valid_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') valid_to,
              effective_scope,created_by::text,
              to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_at,
              to_char(superseded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') superseded_at,
              superseded_by_change_id::text,superseded_by_planning_mentor_change_id::text,
              superseded_by_admin_planning_mentor_change_id::text
         FROM person_relationship WHERE teacher_id=$1::uuid AND relationship_type='PLANNING_MENTOR'
           AND superseded_at IS NULL ORDER BY valid_from,id${suffix}`,
      [planner],
    )
  ).rows;
  const current = rows.filter((row) =>
    activeAt(row.valid_from, row.valid_to, effectiveAt),
  );
  if (current.length > 1) fail("PLANNING_MENTOR_RELATIONSHIP_AMBIGUOUS");
  const future = rows.filter(
    (row) => instant(row.valid_from) > instant(effectiveAt),
  );
  return { current: current[0] ?? null, next: future[0] ?? null };
};
const specialPlanningScopeAt = async (
  client: PostgresClient,
  planner: string,
  effectiveAt: string,
  lock: boolean,
): Promise<boolean> => {
  const rows = (
    await client.query<{ id: string }>(
      `SELECT id::text FROM person_relationship
        WHERE teacher_id=$1::uuid AND relationship_type='PLANNING_MENTOR'
          AND superseded_at IS NULL AND valid_from<=$2::timestamptz
          AND (valid_to IS NULL OR valid_to>$2::timestamptz)
          AND (effective_scope !~ '^REGULAR_WEEK:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
               OR NOT EXISTS (SELECT 1 FROM teaching_week scope_week
                               WHERE scope_week.id::text=substring(effective_scope from 14)
                                 AND scope_week.week_kind='REGULAR'))
        LIMIT 1${lock ? " FOR UPDATE" : " FOR SHARE"}`,
      [planner, effectiveAt],
    )
  ).rows;
  return rows.length !== 0;
};
const candidate = async (
  client: PostgresClient,
  planner: string,
  lock: boolean,
): Promise<{ nickname: string; account: Account }> => {
  const rows = (
    await client.query<{
      nickname: string;
      account_id: string;
      account_code: string;
      account_owner_id: string;
      account_status: string;
    }>(
      `SELECT person.nickname,account.id::text account_id,account.account_code,account.owner_id::text account_owner_id,account.status account_status FROM person JOIN teacher_profile profile ON profile.person_id=person.id JOIN user_account login ON login.person_id=person.id AND login.login_status='ACTIVE' JOIN settlement_account account ON account.owner_type='PERSON' AND account.owner_id=person.id AND account.status='ACTIVE' WHERE person.id=$1::uuid AND person.status='ACTIVE' AND profile.employment_status='ACTIVE' AND profile.business_identity='ACADEMIC_PLANNER'${lock ? " FOR SHARE OF person,profile,login,account" : ""}`,
      [planner],
    )
  ).rows;
  if (rows.length !== 1)
    fail(
      rows.length
        ? "PLANNING_MENTOR_CANDIDATE_AMBIGUOUS"
        : "PLANNING_MENTOR_CANDIDATE_NOT_ELIGIBLE",
    );
  const row = rows[0]!;
  return {
    nickname: row.nickname,
    account: {
      id: row.account_id,
      account_code: row.account_code,
      owner_id: row.account_owner_id,
      status: row.account_status,
    },
  };
};
const mentorAccount = async (
  client: PostgresClient,
  mentor: string,
  at: string,
  throughExclusive: string | null,
  lock: boolean,
): Promise<Account> => {
  const rows = (
    await client.query<Account>(
      `SELECT account.id::text,account.account_code,account.owner_id::text,account.status,person.nickname
         FROM settlement_account account JOIN person ON person.id=account.owner_id
        WHERE account.owner_type='PERSON' AND account.owner_id=$1::uuid AND account.status='ACTIVE'
          AND person.status='ACTIVE'
          AND (SELECT count(*) FROM user_account login WHERE login.person_id=account.owner_id AND login.login_status='ACTIVE')=1
          AND (SELECT count(*) FROM role_assignment role WHERE role.person_id=account.owner_id
                 AND role.subject_code='PLANNING_MENTOR' AND role.scope_type='SELF' AND role.scope_id IS NULL
                 AND role.valid_from<=$2::timestamptz AND (role.valid_to IS NULL OR role.valid_to>$2::timestamptz)
                 AND (($3::timestamptz IS NULL AND role.valid_to IS NULL)
                   OR ($3::timestamptz IS NOT NULL AND (role.valid_to IS NULL OR role.valid_to>=$3::timestamptz))))=1${lock ? " FOR SHARE" : ""}`,
      [mentor, at, throughExclusive],
    )
  ).rows;
  if (rows.length !== 1) fail("RELATIONSHIP_DATA_UNAVAILABLE");
  return rows[0]!;
};

const fees = async (
  client: PostgresClient,
  planner: string,
  effectiveAt: string,
  next: string | null,
  lock: boolean,
): Promise<readonly Fee[]> =>
  (
    await client.query<Fee>(
      `SELECT fee.id::text,fee.version::text,fee.gross_amount_cents::text,fee.teaching_week_id::text,fee.settlement_month::text,refund.finance_document_id::text refund_id,snapshot.id::text snapshot_id,snapshot.sequence_no::text,snapshot.source_weekly_fee_version::text snapshot_source_weekly_fee_version,snapshot.policy_version_id::text,snapshot.net_monthly_cents::text,snapshot.snapshot_json,snapshot.context_json FROM weekly_fee_entry fee JOIN referral_case referral ON referral.id=fee.referral_case_id JOIN teaching_week teaching_week ON teaching_week.id=fee.teaching_week_id LEFT JOIN weekly_fee_refund_effect refund ON refund.weekly_fee_entry_id=fee.id LEFT JOIN LATERAL (SELECT x.* FROM weekly_fee_allocation_snapshot x WHERE x.weekly_fee_entry_id=fee.id ORDER BY x.sequence_no DESC LIMIT 1) snapshot ON true WHERE referral.referrer_person_id=$1::uuid AND referral.referrer_identity='ACADEMIC_PLANNER' AND COALESCE((SELECT source_subject FROM referral_creation_snapshot c WHERE c.referral_case_id=referral.id),'') <> 'PLANNING_MENTOR' AND teaching_week.week_kind='REGULAR' AND (teaching_week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai') >= $2::timestamptz AND ($3::timestamptz IS NULL OR (teaching_week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai') < $3::timestamptz) ORDER BY fee.id${lock ? " FOR UPDATE OF fee" : " FOR SHARE OF fee"}`,
      [planner, effectiveAt, next],
    )
  ).rows;

const build = async (
  client: PostgresClient,
  actorRole: { id: string; scope_id: string | null },
  draft: AdminPlanningMentorRelationshipPreviewDraft,
  at: string,
  lock: boolean,
  resultRelationshipId: string | null,
  continuationRelationshipId?: string | null,
): Promise<Built> => {
  const action = draft.action;
  if (action !== "ADD" && action !== "REPLACE" && action !== "REMOVE") fail("INVALID_INPUT");
  const planner = uuid(draft.plannerPersonId),
    w = await week(client, uuid(draft.effectiveTeachingWeekId), at);
  const effectiveAt = new Date(`${w.starts_on}T00:00:00+08:00`).toISOString();
  const through = draft.effectiveThroughTeachingWeekId === undefined || draft.effectiveThroughTeachingWeekId === null
    ? null : await week(client, uuid(draft.effectiveThroughTeachingWeekId), at);
  if (through !== null && through.starts_on < w.starts_on) fail("INVALID_INPUT");
  const explicitBoundary = through === null ? null : new Date(`${through.ends_on}T24:00:00+08:00`).toISOString();
  const expectedScope = `REGULAR_WEEK:${w.id}`;
  const existing = await relationAt(client, planner, effectiveAt, lock);
  if (await specialPlanningScopeAt(client, planner, effectiveAt, lock))
    fail("RELATIONSHIP_SPECIAL_PERIOD_SCOPE_REQUIRED");
  const targetMentor = action === "REMOVE"
    ? (existing.current?.related_person_id ?? fail("PLANNING_MENTOR_RELATIONSHIP_MISSING"))
    : uuid(draft.newMentorPersonId ?? "");
  if (planner === targetMentor) fail("PLANNING_MENTOR_CANDIDATE_NOT_ELIGIBLE");
  const person = await candidate(client, planner, lock);
  if (action === "ADD") {
    if (existing.current?.related_person_id === targetMentor)
      fail("RELATIONSHIP_TARGET_UNCHANGED");
    if (existing.current !== null)
      fail("PLANNING_MENTOR_RELATIONSHIP_CONFLICT");
  }
  if (action === "REPLACE") {
    const current = existing.current ?? fail("PLANNING_MENTOR_RELATIONSHIP_MISSING");
    if (current.related_person_id === targetMentor) fail("RELATIONSHIP_TARGET_UNCHANGED");
  }
  if (action === "REMOVE") {
    const current =
      existing.current ?? fail("PLANNING_MENTOR_RELATIONSHIP_MISSING");
    if (current.related_person_id !== targetMentor) fail("RELATIONSHIP_DATA_UNAVAILABLE");
  }
  const naturalBoundary = action === "ADD" ? (existing.next?.valid_from ?? null) : existing.current!.valid_to;
  const nextBoundary = [explicitBoundary, naturalBoundary, existing.next?.valid_from ?? null]
    .filter((value): value is string => value !== null)
    .sort()[0] ?? null;
  if ((await client.query(
    `SELECT 1 FROM teaching_week special_week
      WHERE special_week.week_kind<>'REGULAR'
        AND ((special_week.ends_on+1)::timestamp AT TIME ZONE 'Asia/Shanghai')>$1::timestamptz
        AND ($2::timestamptz IS NULL OR (special_week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')<$2::timestamptz)
      LIMIT 1`,
    [effectiveAt, nextBoundary],
  )).rowCount) fail("RELATIONSHIP_SPECIAL_PERIOD_SCOPE_REQUIRED");
  const needsContinuation = action !== "ADD" && nextBoundary !== null
    && (existing.current!.valid_to === null
      || instant(existing.current!.valid_to) > instant(nextBoundary));
  const continuationId = needsContinuation
    ? (continuationRelationshipId === undefined ? randomUUID() : continuationRelationshipId)
    : null;
  if (needsContinuation && continuationId === null) fail("RELATIONSHIP_PREVIEW_STALE");
  if (!needsContinuation && continuationRelationshipId != null)
    fail("RELATIONSHIP_PREVIEW_STALE");
  const destinationMentorAccount = action === "REMOVE"
    ? null
    : await mentorAccount(client, targetMentor, effectiveAt, nextBoundary, lock);
  const sourceMentorNickname = existing.current === null ? null : (
    await client.query<{ nickname: string }>(
      `SELECT nickname FROM person WHERE id=$1::uuid${lock ? " FOR SHARE" : ""}`,
      [existing.current.related_person_id],
    )
  ).rows[0]?.nickname ?? fail("RELATIONSHIP_DATA_UNAVAILABLE");
  const list = await fees(client, planner, effectiveAt, nextBoundary, lock);
  const impacts: FeeImpact[] = [];
  const runtimes: Runtime[] = [];
  let excluded = 0,
    considered = 0,
    changed = 0,
    zero = 0,
    plannerDelta = 0n,
    sourceMentorDelta = 0n,
    destinationMentorDelta = 0n;
  const sourceAccountCodes = new Set<string>();
  for (const fee of list) {
    if (fee.refund_id !== null) {
      excluded++;
      impacts.push({
        feeId: fee.id,
        version: fee.version,
        teachingWeekId: fee.teaching_week_id,
        settlementMonth: fee.settlement_month,
        refundId: fee.refund_id,
        snapshotId: null,
        sequenceNo: null,
        snapshotHash: null,
        policyVersionId: null,
        netMonthlyCents: null,
        disposition: "REFUNDED",
      });
      continue;
    }
    considered++;
    if (
      !fee.snapshot_id ||
      !fee.sequence_no ||
      !fee.snapshot_source_weekly_fee_version ||
      !fee.policy_version_id ||
      fee.net_monthly_cents === null ||
      fee.snapshot_json === null ||
      fee.context_json === null
    )
      fail("RELATIONSHIP_DATA_UNAVAILABLE");
    const decoded = decode(fee.snapshot_json, BigInt(fee.gross_amount_cents)),
      context = obj(fee.context_json);
    if (
      context.feeEntryId !== fee.id ||
      String(context.feeVersion) !== fee.version ||
      context.referrerPersonId !== planner ||
      context.referrerIdentity !== "ACADEMIC_PLANNER" ||
      context.sourceSubject === "PLANNING_MENTOR"
      || fee.snapshot_source_weekly_fee_version !== fee.version
    )
      fail("RELATIONSHIP_DATA_UNAVAILABLE");
    const sourceAccountCode = action === "ADD"
      ? null
      : decoded.accountByKey.planningMentor ?? fail("RELATIONSHIP_DATA_UNAVAILABLE");
    if (sourceAccountCode !== null) sourceAccountCodes.add(sourceAccountCode);
    const accountFacts = await snapshotAccountFacts(
      client,
      decoded,
      lock,
      sourceAccountCode === null ? new Set() : new Set([sourceAccountCode]),
    );
    const frozen: FeeImpact = {
      feeId: fee.id,
      version: fee.version,
      teachingWeekId: fee.teaching_week_id,
      settlementMonth: fee.settlement_month,
      refundId: null,
      snapshotId: fee.snapshot_id,
      sequenceNo: fee.sequence_no,
      snapshotHash: hash({
        snapshot: fee.snapshot_json,
        context: fee.context_json,
        accounts: accountFacts,
      }),
      policyVersionId: fee.policy_version_id,
      netMonthlyCents: fee.net_monthly_cents,
      disposition: "CHANGE",
    };
    const nextSnapshot = await nextAllocation(
      client,
      fee,
      obj(fee.snapshot_json),
      context,
      action,
      targetMentor,
      destinationMentorAccount,
    );
    const nextDecoded = decode(
      nextSnapshot.snapshot,
      BigInt(fee.gross_amount_cents),
    );
    const delta = allocationDelta(
      decoded.lines,
      nextDecoded.lines,
      decoded.accountByKey,
      nextDecoded.accountByKey,
    );
    const sumAccount = (code: string | null): bigint => code === null
      ? 0n
      : delta.filter((entry) => entry.accountKey === code)
          .reduce((sum, entry) => sum + entry.amountCents, 0n);
    const pd = sumAccount(decoded.accountByKey.referrer ?? null),
      sourceDelta = sumAccount(sourceAccountCode),
      destinationDelta = sumAccount(destinationMentorAccount?.account_code ?? null);
    plannerDelta += pd;
    sourceMentorDelta += sourceDelta;
    destinationMentorDelta += destinationDelta;
    if (delta.length === 0) {
      zero++;
      frozen.disposition = "UNCHANGED";
    } else {
      changed++;
      runtimes.push({
        fee,
        frozen,
        snapshot: obj(fee.snapshot_json),
        context,
        decoded,
      });
    }
    impacts.push(frozen);
  }
  const impact: Impact = {
    schemaVersion: "admin-planning-mentor-relationship-preview.v1",
    action,
    mentorPersonId: targetMentor,
    plannerPersonId: planner,
    sourceRelationship: existing.current ? fact(existing.current) : null,
    resultRelationshipId,
    continuationRelationshipId: continuationId,
    actorRoleAssignmentId: actorRole.id,
    actorRoleScopeId: actorRole.scope_id,
    destinationMentorAccount: destinationMentorAccount === null ? null : {
      id: destinationMentorAccount.id,
      code: destinationMentorAccount.account_code,
      ownerId: destinationMentorAccount.owner_id,
      status: destinationMentorAccount.status,
    },
    plannerAccount: {
      id: person.account.id,
      code: person.account.account_code,
      ownerId: person.account.owner_id,
      status: person.account.status,
    },
    week: {
      id: w.id,
      startsOn: w.starts_on,
      endsOn: w.ends_on,
      settlementMonth: w.settlement_month,
    },
    effectiveAt,
    nextBoundaryAt: nextBoundary,
    effectiveThroughTeachingWeekId: through?.id ?? null,
    reason: reason(draft.reason),
    fees: impacts,
    totals: {
      consideredFeeCount: considered,
      changedFeeCount: changed,
      zeroShareFeeCount: zero,
      excludedRefundCount: excluded,
      plannerDeltaCents: plannerDelta.toString(),
      sourceMentorDeltaCents: sourceMentorDelta.toString(),
      destinationMentorDeltaCents: destinationMentorDelta.toString(),
    },
  };
  return {
    impact,
    hash: hash(impact),
    source: existing.current,
    resultId: impact.resultRelationshipId,
    continuationId,
    plannerNickname: person.nickname,
    destinationMentorAccount,
    sourceMentorNickname,
    destinationMentorNickname: destinationMentorAccount?.nickname ?? null,
    sourceAccountCodes: [...sourceAccountCodes].sort(),
    runtimes,
  };
};

const nextAllocation = async (
  client: PostgresClient,
  fee: Fee,
  previousSnapshot: Json,
  context: Json,
  action: Action,
  mentor: string,
  mentorAccount: Account | null,
): Promise<{ snapshot: Json; context: Json }> => {
  const out = clone(previousSnapshot),
    nextContext = clone(context),
    rates = obj(nextContext.resolvedRates),
    accounts = obj(nextContext.accounts),
    relationships = obj(nextContext.relationships);
  if (action === "REPLACE") {
    const destination = mentorAccount ?? fail("RELATIONSHIP_DATA_UNAVAILABLE");
    const map = obj(out.accountByKey);
    map.planningMentor = destination.account_code;
    relationships.planningMentor = { id: "PENDING", personId: mentor };
    accounts.planningMentor = {
      ownerType: "PERSON", ownerId: mentor, accountId: destination.id, accountCode: destination.account_code,
    };
    return { snapshot: out, context: nextContext };
  }
  const rate = (name: string) => bigint(rates[name]);
  const policyRows = (
    await client.query<{ policy_json: unknown }>(
      "SELECT policy_json FROM rate_policy_version WHERE id=$1::uuid",
      [fee.policy_version_id],
    )
  ).rows;
  if (policyRows.length !== 1) fail("RELATIONSHIP_DATA_UNAVAILABLE");
  const mentorWeight =
    action === "ADD"
      ? bigint(obj(policyRows[0]!.policy_json).planningMentorWeightBasisPoints)
      : 0n;
  // Carry the exact immutable policy result into the new context.  This is
  // deliberately not a lookup of today's rate or dynamic tier.
  rates.planningMentorWeightBasisPoints = mentorWeight.toString();
  // `actualIntroPoolBasisPoints` is frozen by the original settlement.  Do not
  // call the dynamic-tier selector again: a relationship change must not
  // mutate the fee's already-established monthly tier.
  const pool = rate("actualIntroPoolBasisPoints");
  const fixed = [
    rate("groupLeaderRateBasisPoints"),
    rate("teachingMentorRateBasisPoints"),
    rate("venueRateBasisPoints"),
    rate("campusConsultationRateBasisPoints"),
    rate("platformFinanceRateBasisPoints"),
    rate("regionFinanceRateBasisPoints"),
  ].map((value) => value * 10_000n);
  const numerators = [
    pool * (10_000n - mentorWeight),
    pool * mentorWeight,
    ...fixed,
  ];
  const teacher =
    100_000_000n - numerators.reduce((sum, value) => sum + value, 0n);
  if (teacher < 0n) fail("RELATIONSHIP_DATA_UNAVAILABLE");
  const lines = allocateRationalCents(
    BigInt(fee.gross_amount_cents),
    100_000_000n,
    KEYS.map((entry, index) => ({
      key: entry,
      numerator: [...numerators, teacher][index] ?? 0n,
    })),
  );
  out.lines = lines.map((line) => ({
    key: line.key,
    cents: line.cents.toString(),
  }));
  const map = obj(out.accountByKey);
  if (action === "ADD") {
    const destination = mentorAccount ?? fail("RELATIONSHIP_DATA_UNAVAILABLE");
    map.planningMentor = destination.account_code;
    relationships.planningMentor = { id: "PENDING", personId: mentor };
    accounts.planningMentor = {
      ownerType: "PERSON",
      ownerId: mentor,
      accountId: destination.id,
      accountCode: destination.account_code,
    };
  } else {
    delete map.planningMentor;
    relationships.planningMentor = null;
    delete accounts.planningMentor;
  }
  return { snapshot: out, context: nextContext };
};

export class PostgresAdminPlanningMentorRelationshipService {
  public constructor(private readonly pool: PostgresPool) {}
  public async listDirectory(
    context: RoleContext,
    at: Date,
  ): Promise<AdminPlanningMentorRelationshipDirectory> {
    assertContext(context);
    const now = iso(at),
      client = await this.pool.connect();
    try {
      await actor(client, context, now);
      const mentor = (
        await client.query<{ nickname: string }>(
          "SELECT nickname FROM person WHERE id=$1::uuid",
          [context.personId],
        )
      ).rows[0];
      if (!mentor) fail("FORBIDDEN_SCOPE");
      const managed = (
        await client.query<{
          person_id: string;
          nickname: string;
          relationship_id: string;
          valid_from: string;
          valid_to: string | null;
        }>(
          `SELECT p.id::text person_id,p.nickname,r.id::text relationship_id,r.valid_from::text,r.valid_to::text FROM person_relationship r JOIN person p ON p.id=r.teacher_id WHERE r.related_person_id=$1::uuid AND r.relationship_type='PLANNING_MENTOR' AND r.superseded_at IS NULL AND r.valid_from<=$2::timestamptz AND (r.valid_to IS NULL OR r.valid_to>$2::timestamptz) ORDER BY p.nickname,p.id`,
          [context.personId, now],
        )
      ).rows;
      const available = (
        await client.query<{ person_id: string; nickname: string }>(
          `SELECT p.id::text person_id,p.nickname FROM person p JOIN teacher_profile profile ON profile.person_id=p.id WHERE p.status='ACTIVE' AND profile.business_identity='ACADEMIC_PLANNER' AND profile.employment_status='ACTIVE' AND p.id<>$1::uuid AND (SELECT count(*) FROM user_account login WHERE login.person_id=p.id AND login.login_status='ACTIVE')=1 AND (SELECT count(*) FROM settlement_account account WHERE account.owner_type='PERSON' AND account.owner_id=p.id AND account.status='ACTIVE')=1 AND NOT EXISTS (SELECT 1 FROM person_relationship r WHERE r.teacher_id=p.id AND r.relationship_type='PLANNING_MENTOR' AND r.superseded_at IS NULL AND r.valid_from<=$2::timestamptz AND (r.valid_to IS NULL OR r.valid_to>$2::timestamptz)) ORDER BY p.nickname,p.id`,
          [context.personId, now],
        )
      ).rows;
      const weeks = (
        await client.query<{
          id: string;
          starts_on: string;
          ends_on: string;
          settlement_month: string;
        }>(
          `SELECT id::text,starts_on::text,ends_on::text,settlement_month::text FROM teaching_week WHERE week_kind='REGULAR' AND ends_on >= (($1::timestamptz AT TIME ZONE 'Asia/Shanghai')::date) ORDER BY starts_on`,
          [now],
        )
      ).rows;
      const requiredMentor = mentor ?? fail("FORBIDDEN_SCOPE");
      const planners = (await client.query<{ person_id: string; nickname: string; mentor_person_id: string | null; mentor_nickname: string | null; relationship_id: string | null }>(
        `SELECT p.id::text person_id,p.nickname,r.related_person_id::text mentor_person_id,m.nickname mentor_nickname,r.id::text relationship_id
           FROM person p JOIN teacher_profile profile ON profile.person_id=p.id
           LEFT JOIN LATERAL (SELECT * FROM person_relationship x WHERE x.teacher_id=p.id AND x.relationship_type='PLANNING_MENTOR'
             AND x.superseded_at IS NULL AND x.valid_from<=$1::timestamptz AND (x.valid_to IS NULL OR x.valid_to>$1::timestamptz)
             ORDER BY x.valid_from DESC,x.id LIMIT 1) r ON true
           LEFT JOIN person m ON m.id=r.related_person_id
          WHERE p.status='ACTIVE' AND profile.employment_status='ACTIVE' AND profile.business_identity='ACADEMIC_PLANNER'
          ORDER BY p.nickname,p.id`, [now]
      )).rows;
      const mentors = (await client.query<{ person_id: string; nickname: string }>(
        `SELECT p.id::text person_id,p.nickname FROM person p
           JOIN user_account login ON login.person_id=p.id AND login.login_status='ACTIVE'
           JOIN settlement_account account ON account.owner_type='PERSON' AND account.owner_id=p.id AND account.status='ACTIVE'
           JOIN role_assignment role ON role.person_id=p.id AND role.subject_code='PLANNING_MENTOR' AND role.scope_type='SELF' AND role.scope_id IS NULL
             AND role.valid_from<=$1::timestamptz AND (role.valid_to IS NULL OR role.valid_to>$1::timestamptz)
          WHERE p.status='ACTIVE' GROUP BY p.id,p.nickname
         HAVING count(DISTINCT login.id)=1 AND count(DISTINCT account.id)=1 AND count(DISTINCT role.id)=1
          ORDER BY p.nickname,p.id`, [now]
      )).rows;
      return {
        planners: planners.map((x) => ({
          personId: x.person_id,
          nickname: x.nickname,
          currentMentorPersonId: x.mentor_person_id,
          currentMentorNickname: x.mentor_nickname,
          currentRelationshipId: x.relationship_id,
        })),
        mentors: mentors.map((x) => ({ personId: x.person_id, nickname: x.nickname })),
        mentorPersonId: context.personId,
        mentorNickname: requiredMentor.nickname,
        managedPlanners: managed.map((x) => ({
          personId: x.person_id,
          nickname: x.nickname,
          relationshipId: x.relationship_id,
          validFrom: x.valid_from,
          validTo: x.valid_to,
        })),
        availablePlanners: available.map((x) => ({
          personId: x.person_id,
          nickname: x.nickname,
        })),
        currentWeeks: weeks.map((x) => ({
          id: x.id,
          startsOn: x.starts_on,
          endsOn: x.ends_on,
          settlementMonth: x.settlement_month,
        })),
      };
    } finally {
      await client.release();
    }
  }
  public async preview(
    context: RoleContext,
    draft: AdminPlanningMentorRelationshipPreviewDraft,
    at: Date,
  ): Promise<AdminPlanningMentorRelationshipPreviewResult> {
    assertContext(context);
    const now = iso(at),
      client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await lockSettlementAllocationShared(client);
      const role = await actor(client, context, now);
      const id = randomUUID();
      const built = await build(
        client,
        role,
        draft,
        now,
        false,
        draft.action === "REMOVE" ? null : randomUUID(),
      );
      await client.query(
        `INSERT INTO admin_planning_mentor_relationship_change_preview(id,action,mentor_person_id,planner_person_id,source_relationship_id,result_relationship_id,continuation_relationship_id,actor_role_assignment_id,effective_teaching_week_id,effective_at,next_boundary_at,reason,base_hash,impact_json,created_by_person_id,actor_subject_code,actor_scope_type,created_at,effective_through_teaching_week_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,'GLOBAL',$17,$18)`,
        [
          id,
          built.impact.action,
          built.impact.mentorPersonId,
          built.impact.plannerPersonId,
          built.source?.id ?? null,
          built.resultId,
          built.continuationId,
          role.id,
          built.impact.week.id,
          built.impact.effectiveAt,
          built.impact.nextBoundaryAt,
          built.impact.reason,
          built.hash,
          encode(built.impact),
          context.personId,
          context.subject,
          now,
          built.impact.effectiveThroughTeachingWeekId,
        ],
      );
      await client.query("COMMIT");
      const t = built.impact.totals;
      return {
        previewId: id,
        action: built.impact.action,
        mentorPersonId: context.personId,
        sourceMentorPersonId: built.source?.related_person_id ?? null,
        sourceMentorNickname: built.sourceMentorNickname,
        newMentorPersonId: built.impact.action === "REMOVE" ? null : built.impact.mentorPersonId,
        newMentorNickname: built.destinationMentorNickname,
        effectiveThroughTeachingWeekId: built.impact.effectiveThroughTeachingWeekId,
        plannerPersonId: built.impact.plannerPersonId,
        plannerNickname: built.plannerNickname,
        effectiveTeachingWeekId: built.impact.week.id,
        effectiveAt: built.impact.effectiveAt,
        nextBoundaryAt: built.impact.nextBoundaryAt === null
          ? null
          : new Date(instant(built.impact.nextBoundaryAt)).toISOString(),
        consideredFeeCount: t.consideredFeeCount,
        changedFeeCount: t.changedFeeCount,
        zeroShareFeeCount: t.zeroShareFeeCount,
        excludedRefundCount: t.excludedRefundCount,
        plannerDeltaCents: t.plannerDeltaCents,
        sourceMentorDeltaCents: t.sourceMentorDeltaCents,
        destinationMentorDeltaCents: t.destinationMentorDeltaCents,
        mentorDeltaCents: (
          BigInt(t.sourceMentorDeltaCents) + BigInt(t.destinationMentorDeltaCents)
        ).toString(),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.release();
    }
  }
  public async publish(
    context: RoleContext,
    previewIdInput: string,
    idempotencyKey: string,
    at: Date,
  ): Promise<AdminPlanningMentorRelationshipPublishResult> {
    assertContext(context);
    const previewId = uuid(previewIdInput),
      idem = key(idempotencyKey),
      now = iso(at),
      client = await this.pool.connect(),
      requestHash = hash([
        "admin-planning-mentor-relationship.publish.v1",
        context.personId,
        previewId,
      ]);
    try {
      await client.query("BEGIN");
      await lockSettlementAllocationExclusive(client);
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`planning-mentor:${context.personId}:${idem}`],
      );
      // Re-authorize before *every* return path.  An idempotent receipt is
      // not a capability that survives revocation of the actor's appointment.
      const role = await actor(client, context, now);
      const replay = (
        await client.query<ChangeReplayRow>(
          `SELECT id::text,preview_id::text,action,relationship_version::text,result_relationship_id::text,posting_status,considered_fee_count,changed_fee_count,excluded_refund_count,planner_delta_cents::text,source_mentor_delta_cents::text,destination_mentor_delta_cents::text,request_hash FROM admin_planning_mentor_relationship_change WHERE published_by_person_id=$1::uuid AND idempotency_key=$2`,
          [context.personId, idem],
        )
      ).rows[0];
      if (replay) {
        if (
          replay.request_hash !== requestHash ||
          replay.preview_id !== previewId
        )
          fail("IDEMPOTENCY_REPLAY");
        await client.query("COMMIT");
        return {
          changeId: replay.id,
          previewId,
          replay: true,
          action: replay.action,
          relationshipVersion: integer(replay.relationship_version),
          resultRelationshipId: replay.result_relationship_id,
          postingStatus: replay.posting_status,
          consideredFeeCount: replay.considered_fee_count,
          changedFeeCount: replay.changed_fee_count,
          excludedRefundCount: replay.excluded_refund_count,
          plannerDeltaCents: replay.planner_delta_cents,
          mentorDeltaCents: (
            BigInt(replay.source_mentor_delta_cents)
            + BigInt(replay.destination_mentor_delta_cents)
          ).toString(),
          sourceMentorDeltaCents: replay.source_mentor_delta_cents,
          destinationMentorDeltaCents: replay.destination_mentor_delta_cents,
        };
      }
      const preview = (
        await client.query<PreviewRow>(
          `SELECT id::text,action,mentor_person_id::text,planner_person_id::text,result_relationship_id::text,continuation_relationship_id::text,effective_teaching_week_id::text,effective_through_teaching_week_id::text,reason,base_hash,impact_json FROM admin_planning_mentor_relationship_change_preview WHERE id=$1::uuid AND created_by_person_id=$2::uuid FOR SHARE`,
          [previewId, context.personId],
        )
      ).rows[0];
      const requiredPreview = preview ?? fail("RELATIONSHIP_PREVIEW_NOT_FOUND");
      if (
        (
          await client.query(
            "SELECT 1 FROM admin_planning_mentor_relationship_change WHERE preview_id=$1",
            [previewId],
          )
        ).rowCount
      )
        fail("RELATIONSHIP_PREVIEW_ALREADY_PUBLISHED");
      const stored = obj(requiredPreview.impact_json),
        months = (Array.isArray(stored.fees) ? stored.fees : []).map((x) =>
          str(obj(x).settlementMonth),
        );
      for (const month of [...new Set(months)].sort())
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [`settlement-month:${month}`],
        );
      const built = await build(
          client,
          role,
          {
            action: requiredPreview.action,
            plannerPersonId: requiredPreview.planner_person_id,
            newMentorPersonId: requiredPreview.action === "REMOVE" ? null : requiredPreview.mentor_person_id,
            effectiveTeachingWeekId: requiredPreview.effective_teaching_week_id,
            effectiveThroughTeachingWeekId: requiredPreview.effective_through_teaching_week_id,
            reason: requiredPreview.reason,
          },
          now,
          true,
          requiredPreview.result_relationship_id,
          requiredPreview.continuation_relationship_id,
        ).catch((error: unknown): Built => {
          if (error instanceof Error && error.message === "FORBIDDEN_SCOPE") throw error;
          return fail("RELATIONSHIP_PREVIEW_STALE");
        });
      if (
        built.hash !== requiredPreview.base_hash ||
        hash(requiredPreview.impact_json) !== requiredPreview.base_hash
      )
        fail("RELATIONSHIP_PREVIEW_STALE");
      const changeId = randomUUID(),
        resultId = built.resultId;
      if (built.impact.action === "ADD") {
        await client.query(
          `INSERT INTO person_relationship(id,teacher_id,relationship_type,related_person_id,valid_from,valid_to,effective_scope,created_by,created_at) VALUES($1,$2,'PLANNING_MENTOR',$3,$4,$5,$6,$7,$8)`,
          [
            resultId,
            built.impact.plannerPersonId,
            built.impact.mentorPersonId,
            built.impact.effectiveAt,
            built.impact.nextBoundaryAt,
            `REGULAR_WEEK:${built.impact.week.id}`,
            context.personId,
            now,
          ],
        );
      } else {
        const source = built.source!;
        const same = sameInstant(source.valid_from, built.impact.effectiveAt);
        const result = await client.query(
          same
            ? `UPDATE person_relationship SET superseded_at=$2::timestamptz,superseded_by_admin_planning_mentor_change_id=$3::uuid WHERE id=$1::uuid AND superseded_at IS NULL`
            : `UPDATE person_relationship SET valid_to=$2::timestamptz WHERE id=$1::uuid AND superseded_at IS NULL AND valid_from<$2::timestamptz AND (valid_to IS NULL OR valid_to>$2::timestamptz)`,
          same
            ? [source.id, now, changeId]
            : [source.id, built.impact.effectiveAt],
        );
        if (result.rowCount !== 1) fail("RELATIONSHIP_PREVIEW_STALE");
        if (built.impact.action === "REPLACE") {
          await client.query(
            `INSERT INTO person_relationship(id,teacher_id,relationship_type,related_person_id,valid_from,valid_to,effective_scope,created_by,created_at)
             VALUES($1,$2,'PLANNING_MENTOR',$3,$4,$5,$6,$7,$8)`,
            [resultId, built.impact.plannerPersonId, built.impact.mentorPersonId, built.impact.effectiveAt,
              built.impact.nextBoundaryAt, `REGULAR_WEEK:${built.impact.week.id}`, context.personId, now],
          );
        }
        // A bounded correction creates a fresh continuation of the frozen
        // original fact.  It never edits the historical row back in place.
        if (built.continuationId !== null) {
          await client.query(
            `INSERT INTO person_relationship(id,teacher_id,relationship_type,related_person_id,valid_from,valid_to,effective_scope,created_by,created_at)
             VALUES($1,$2,'PLANNING_MENTOR',$3,$4,$5,$6,$7,$8)`,
            [built.continuationId, built.impact.plannerPersonId, source.related_person_id,
              built.impact.nextBoundaryAt, source.valid_to, source.effective_scope,
              context.personId, now],
          );
        }
      }
      const loadRelationship = async (id: string | null): Promise<Relationship | null> =>
        id === null ? null : (
          await client.query<Relationship>(
                  `SELECT id::text,teacher_id::text,related_person_id::text,
                  to_char(valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') valid_from,
                  to_char(valid_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') valid_to,
                  effective_scope,created_by::text,
                  to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_at,
                  to_char(superseded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') superseded_at,
                  superseded_by_change_id::text,superseded_by_planning_mentor_change_id::text,
                  superseded_by_admin_planning_mentor_change_id::text
             FROM person_relationship WHERE id=$1::uuid`,
            [id],
          )
        ).rows[0] ?? fail("RELATIONSHIP_DATA_UNAVAILABLE");
      const resultRow = await loadRelationship(resultId),
        sourceAfterRow = await loadRelationship(built.source?.id ?? null),
        continuationRow = await loadRelationship(built.continuationId);
      const effects: Effect[] = [],
        deltas: LedgerDelta[] = [];
      for (const runtime of built.runtimes) {
        const next = await nextAllocation(
          client,
          runtime.fee,
          runtime.snapshot,
          runtime.context,
          built.impact.action,
          built.impact.mentorPersonId,
          built.destinationMentorAccount,
        );
        const map = obj(next.snapshot.accountByKey);
        const rel = obj(next.context.relationships);
        if (built.impact.action === "ADD" || built.impact.action === "REPLACE") {
          const destination = built.destinationMentorAccount
            ?? fail("RELATIONSHIP_DATA_UNAVAILABLE");
          map.planningMentor = destination.account_code;
          rel.planningMentor = { id: resultId, personId: built.impact.mentorPersonId };
        }
        const nextDecoded = decode(
            next.snapshot,
            BigInt(runtime.fee.gross_amount_cents),
          ),
          delta = allocationDelta(
            runtime.decoded.lines,
            nextDecoded.lines,
            runtime.decoded.accountByKey,
            nextDecoded.accountByKey,
          );
        if (delta.length) {
          deltas.push(...delta);
          effects.push({
            runtime,
            next,
            id: randomUUID(),
            nextDecoded,
            deltas: delta,
          });
        }
      }
      const combined = aggregate(deltas);
      let runId: string | null = null,
        eventId: string | null = null,
        status: "POSTED" | "NO_BALANCE_CHANGE" = "NO_BALANCE_CHANGE";
      if (combined.length) {
        runId = randomUUID();
        const prepared = await prepareLedgerPosting(
          client,
          `weekly-settlement:admin-planning-mentor-change:${changeId}`,
          combined.map((x) => x.accountKey),
        );
        const expectedAccountCodes = [
          ...new Set(combined.map((delta) => delta.accountKey)),
        ].sort();
        if (
          prepared.length !== expectedAccountCodes.length ||
          prepared.some(
            (account, index) =>
              account.accountCode !== expectedAccountCodes[index] ||
              (account.status !== "ACTIVE" &&
                !built.sourceAccountCodes.includes(account.accountCode)),
          )
        )
          fail("RELATIONSHIP_PREVIEW_STALE");
        const bound = createPostgresLedgerTransaction(client),
          posted = await postLedgerEvent(
            { transaction: (work) => work(bound) },
            {
              eventKey: `weekly-settlement:admin-planning-mentor-change:${changeId}`,
              eventType: "WEEKLY_FEE_SETTLEMENT",
              payloadHash: hash({
                changeId,
                previewId,
                effects: effects.map((x) => x.id),
              }),
              deltas: combined,
            },
            randomUUID,
          );
        if (posted.status !== "POSTED") fail("RELATIONSHIP_DATA_UNAVAILABLE");
        eventId = posted.event.eventId;
        status = "POSTED";
        const anchor = effects[0]!.runtime.fee;
        await client.query(
          `INSERT INTO settlement_calculation_run(id,request_key,fee_entry_id,fee_version,actor_person_id,status,ledger_event_id,created_at) VALUES($1,$2,$3,$4,$5,'POSTED',$6,$7)`,
          [
            runId,
            `admin-planning-mentor-change:${changeId}`,
            anchor.id,
            anchor.version,
            context.personId,
            eventId,
            now,
          ],
        );
        for (const effect of effects)
          await client.query(
            `INSERT INTO weekly_fee_allocation_snapshot(id,run_id,weekly_fee_entry_id,source_weekly_fee_version,policy_version_id,net_monthly_cents,snapshot_json,context_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
            [
              effect.id,
              runId,
              effect.runtime.fee.id,
              effect.runtime.fee.version,
              effect.runtime.fee.policy_version_id,
              effect.runtime.fee.net_monthly_cents,
              encode(effect.next.snapshot),
              encode(effect.next.context),
              now,
            ],
          );
      }
      const versionRow = (
        await client.query<{ v: string }>(
          `SELECT (COALESCE(max(relationship_version),0)+1)::text v FROM admin_planning_mentor_relationship_change WHERE planner_person_id=$1::uuid`,
          [built.impact.plannerPersonId],
        )
      ).rows[0];
      const version = integer(versionRow!.v),
        beforeJson = {
          sourceRelationship: built.source === null ? null : fact(built.source),
        },
        afterJson = {
          sourceRelationship: sourceAfterRow === null ? null : fact(sourceAfterRow),
          resultRelationship: resultRow === null ? null : fact(resultRow),
          continuationRelationship:
            continuationRow === null ? null : fact(continuationRow),
        };
      const totals = built.impact.totals;
      await client.query(
        `INSERT INTO admin_planning_mentor_relationship_change(id,preview_id,action,mentor_person_id,planner_person_id,relationship_version,source_relationship_id,result_relationship_id,continuation_relationship_id,actor_role_assignment_id,effective_teaching_week_id,effective_through_teaching_week_id,effective_at,next_boundary_at,reason,idempotency_key,request_hash,base_hash,posting_status,settlement_calculation_run_id,ledger_event_id,considered_fee_count,changed_fee_count,excluded_refund_count,planner_delta_cents,source_mentor_delta_cents,destination_mentor_delta_cents,before_json,after_json,published_by_person_id,actor_subject_code,actor_scope_type,published_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28::jsonb,$29::jsonb,$30,$31,'GLOBAL',$32,$32)`,
        [
          changeId,
          previewId,
          built.impact.action,
          built.impact.mentorPersonId,
          built.impact.plannerPersonId,
          version,
          built.source?.id ?? null,
          resultId,
          built.continuationId,
          role.id,
          built.impact.week.id,
          built.impact.effectiveThroughTeachingWeekId,
          built.impact.effectiveAt,
          built.impact.nextBoundaryAt,
          built.impact.reason,
          idem,
          requestHash,
          built.hash,
          status,
          runId,
          eventId,
          totals.consideredFeeCount,
          effects.length,
          totals.excludedRefundCount,
          totals.plannerDeltaCents,
          totals.sourceMentorDeltaCents,
          totals.destinationMentorDeltaCents,
          encode(beforeJson),
          encode(afterJson),
          context.personId,
          context.subject,
          now,
        ],
      );
      for (const effect of effects) {
        const before = effect.runtime.decoded.lines;
        const after = effect.nextDecoded.lines;
        const get = (
          set: readonly { key: string; cents: bigint }[],
          name: string,
        ) => set.find((x) => x.key === name)!.cents.toString();
        const sourceAccount = built.impact.action === "ADD" ? null
          : obj(obj(effect.runtime.context.accounts).planningMentor),
          sumFor = (accountCode: string | null): string => (
            accountCode === null ? 0n : effect.deltas
              .filter((entry) => entry.accountKey === accountCode)
              .reduce((sum, entry) => sum + entry.amountCents, 0n)
          ).toString();
        await client.query(
          `INSERT INTO admin_planning_mentor_relationship_change_effect(change_id,weekly_fee_entry_id,source_weekly_fee_version,teaching_week_id,settlement_month,previous_snapshot_id,result_snapshot_id,settlement_calculation_run_id,planner_account_id,source_mentor_account_id,destination_mentor_account_id,planner_before_cents,planner_after_cents,mentor_before_cents,mentor_after_cents,planner_delta_cents,source_mentor_delta_cents,destination_mentor_delta_cents,delta_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20)`,
          [
            changeId,
            effect.runtime.fee.id,
            effect.runtime.fee.version,
            effect.runtime.fee.teaching_week_id,
            effect.runtime.fee.settlement_month,
            effect.runtime.fee.snapshot_id,
            effect.id,
            runId,
            built.impact.plannerAccount.id,
            sourceAccount === null ? null : str(sourceAccount.accountId),
            built.destinationMentorAccount?.id ?? null,
            get(before, "referrer"),
            get(after, "referrer"),
            get(before, "planningMentor"),
            get(after, "planningMentor"),
            sumFor(built.impact.plannerAccount.code),
            sumFor(sourceAccount === null ? null : str(sourceAccount.accountCode)),
            sumFor(built.destinationMentorAccount?.account_code ?? null),
            encode({
              entries: effect.deltas.map((x) => ({
                accountKey: x.accountKey,
                categoryKey: x.categoryKey,
                amountCents: x.amountCents.toString(),
              })),
            }),
            now,
          ],
        );
      }
      await client.query(
        `INSERT INTO audit_event(actor_person_id,action_code,subject_type,subject_id,before_json,after_json,reason,created_at) VALUES($1,$2,'PERSON_RELATIONSHIP',$3,$4::jsonb,$5::jsonb,$6,$7)`,
        [
          context.personId,
          built.impact.action === "ADD"
            ? "PLANNING_MENTOR_RELATIONSHIP_ADDED_BY_ADMIN"
            : built.impact.action === "REPLACE"
              ? "PLANNING_MENTOR_RELATIONSHIP_REPLACED_BY_ADMIN"
              : "PLANNING_MENTOR_RELATIONSHIP_REMOVED_BY_ADMIN",
          resultId ?? built.source!.id,
          encode(beforeJson),
          encode(afterJson),
          built.impact.reason,
          now,
        ],
      );
      await client.query("COMMIT");
      return {
        changeId,
        previewId,
        action: built.impact.action,
        relationshipVersion: version,
        resultRelationshipId: resultId,
        postingStatus: status,
        consideredFeeCount: totals.consideredFeeCount,
        changedFeeCount: effects.length,
        excludedRefundCount: totals.excludedRefundCount,
        plannerDeltaCents: totals.plannerDeltaCents,
        mentorDeltaCents: (
          BigInt(totals.sourceMentorDeltaCents)
          + BigInt(totals.destinationMentorDeltaCents)
        ).toString(),
        sourceMentorDeltaCents: totals.sourceMentorDeltaCents,
        destinationMentorDeltaCents: totals.destinationMentorDeltaCents,
        replay: false,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.release();
    }
  }
}
