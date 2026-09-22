import type { RoleContext } from "@teaching-research-alliance/contracts";
import type { PostgresClient, PostgresPool } from "./postgres-ledger-repository.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CENTS = /^\d+$/;
const BOARD_SUBJECTS = ["TEACHING_TEACHER", "ACADEMIC_PLANNER", "PLANNING_MENTOR", "VENUE_OWNER"] as const;
const SETTLEMENT_KEYS = ["referrer", "planningMentor", "groupLeader", "teachingMentor", "venue", "campusConsultation", "platformFinance", "regionFinance", "teachingTeacher"] as const;

export type VenueBoardFilter = Readonly<{
  teachingWeekId?: string;
  startsOn?: string;
  endsOn?: string;
}>;

export type VenueBoard = Readonly<{
  venue: Readonly<{
    id: string;
    name: string;
    status: "ACTIVE" | "INACTIVE";
    ownerPersonId: string;
    ownerNickname: string;
    canView: true;
    canWithdraw: boolean;
    accountId?: string;
    balanceCents?: bigint;
  }>;
  period: Readonly<{ teachingWeekId?: string; startsOn?: string; endsOn?: string }>;
  members: readonly Readonly<{
    personId: string;
    nickname: string;
    canView: boolean;
    canWithdraw: boolean;
    isOwner: boolean;
  }>[];
  teachers: readonly Readonly<{
    teacherPersonId: string;
    teacherNickname: string;
    totalVenueFeeCents: bigint;
    weeklyFees: readonly Readonly<{
      weeklyFeeEntryId: string;
      teachingWeekId: string;
      weekStartsOn: string;
      weekEndsOn: string;
      studentRecordId: string;
      studentDisplayName: string;
      courseContextId: string;
      venueFeeCents: bigint;
    }>[];
  }>[];
  totalVenueFeeCents: bigint;
}>;

type AccessRow = Readonly<{
  id: string;
  name: string;
  status: string;
  owner_person_id: string;
  owner_nickname: string;
  account_id: string;
  balance_cents: string;
  can_withdraw: boolean;
}>;

type MemberRow = Readonly<{
  person_id: string;
  nickname: string;
  can_view: boolean;
  can_withdraw: boolean;
  is_owner: boolean;
}>;

type FeeRow = Readonly<{
  weekly_fee_entry_id: string;
  teaching_week_id: string;
  week_starts_on: string;
  week_ends_on: string;
  teacher_person_id: string;
  teacher_nickname: string;
  student_record_id: string;
  student_display_name: string;
  course_context_id: string;
  snapshot_json: unknown;
  context_json: unknown;
}>;

const invalid = (): never => { throw new Error("INVALID_INPUT"); };
const dataUnavailable = (): never => { throw new Error("VENUE_DATA_UNAVAILABLE"); };
const validDate = (value: string): boolean => {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const asObject = (value: unknown): Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) dataUnavailable();
  return value as Readonly<Record<string, unknown>>;
};

const assertContext = (context: RoleContext, venueId: string): void => {
  if (!(BOARD_SUBJECTS as readonly string[]).includes(context.subject)) throw new Error("FORBIDDEN_SCOPE");
  if (context.subject === "VENUE_OWNER" && (context.scope !== "VENUE" || context.venueId !== venueId)) {
    throw new Error("FORBIDDEN_SCOPE");
  }
};

const normalizeFilter = (filter: VenueBoardFilter): VenueBoardFilter => {
  const { teachingWeekId, startsOn, endsOn } = filter;
  if (teachingWeekId !== undefined) {
    if (!UUID.test(teachingWeekId) || startsOn !== undefined || endsOn !== undefined) invalid();
    return { teachingWeekId };
  }
  if (startsOn === undefined || endsOn === undefined || !validDate(startsOn) || !validDate(endsOn) || startsOn > endsOn) invalid();
  return { startsOn: startsOn as string, endsOn: endsOn as string };
};

const parseVenueCents = (snapshotValue: unknown, contextValue: unknown, venueId: string, accountId: string): bigint => {
  const snapshot = asObject(snapshotValue);
  const lines = snapshot.lines;
  const accountByKey = asObject(snapshot.accountByKey);
  const context = asObject(contextValue);
  const accounts = asObject(context.accounts);
  if (!Array.isArray(lines) || lines.length !== SETTLEMENT_KEYS.length) dataUnavailable();
  const byKey = new Map<string, unknown>();
  for (const value of lines as unknown[]) {
    const line = asObject(value);
    const key = line.key;
    const cents = line.cents;
    if (typeof key !== "string" || byKey.has(key) || typeof cents !== "string" || !CENTS.test(cents)) dataUnavailable();
    byKey.set(key as string, cents as string);
  }
  if (byKey.size !== SETTLEMENT_KEYS.length || SETTLEMENT_KEYS.some((key) => !byKey.has(key))) dataUnavailable();
  const venueCents = BigInt(byKey.get("venue") as string);
  if (context.venueId !== venueId || typeof context.isSelfUseSnapshot !== "boolean") dataUnavailable();
  const resolvedRates = asObject(context.resolvedRates);
  const noVenueAccountExpected = venueCents === 0n && (context.isSelfUseSnapshot || resolvedRates.venueRateBasisPoints === "0");
  if (noVenueAccountExpected) {
    if (accountByKey.venue !== undefined || accounts.venue !== undefined) dataUnavailable();
    return venueCents;
  }
  const venueAccount = asObject(accounts.venue);
  if (venueAccount.accountId !== accountId || typeof venueAccount.accountCode !== "string" || accountByKey.venue !== venueAccount.accountCode) dataUnavailable();
  return venueCents;
};

const mapAccess = (row: AccessRow): VenueBoard["venue"] => {
  if (!UUID.test(row.id) || !UUID.test(row.owner_person_id) || !UUID.test(row.account_id)
    || typeof row.name !== "string" || row.name.length === 0 || typeof row.owner_nickname !== "string"
    || !["ACTIVE", "INACTIVE"].includes(row.status) || !CENTS.test(row.balance_cents)) dataUnavailable();
  const venue = {
    id: row.id,
    name: row.name,
    status: row.status as "ACTIVE" | "INACTIVE",
    ownerPersonId: row.owner_person_id,
    ownerNickname: row.owner_nickname,
    canView: true as const,
    canWithdraw: row.can_withdraw
  };
  return row.can_withdraw ? { ...venue, accountId: row.account_id, balanceCents: BigInt(row.balance_cents) } : venue;
};

const mapMember = (row: MemberRow): VenueBoard["members"][number] => {
  if (!UUID.test(row.person_id) || typeof row.nickname !== "string" || typeof row.can_view !== "boolean"
    || typeof row.can_withdraw !== "boolean" || typeof row.is_owner !== "boolean") dataUnavailable();
  return { personId: row.person_id, nickname: row.nickname, canView: row.can_view, canWithdraw: row.can_withdraw, isOwner: row.is_owner };
};

/** Read-only shared-venue board. It always resolves the latest effective venue allocation, never gross lesson fees. */
export class PostgresVenueBoardReadService {
  public constructor(private readonly pool: PostgresPool) {}

  private async readOnly<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.release();
    }
  }

  public async get(context: RoleContext, venueId: string, filter: VenueBoardFilter, at: Date): Promise<VenueBoard> {
    if (!UUID.test(venueId) || !Number.isFinite(at.getTime())) invalid();
    assertContext(context, venueId);
    const period = normalizeFilter(filter);
    const now = at.toISOString();
    return this.readOnly(async (client) => {
      const accessResult = await client.query<AccessRow>(
        `SELECT venue.id::text AS id, venue.name, venue.status, venue.owner_person_id::text AS owner_person_id,
                owner.nickname AS owner_nickname, account.id::text AS account_id,
                COALESCE(balance.balance_cents, 0)::text AS balance_cents,
                (venue.owner_person_id=$1::uuid OR EXISTS (
                  SELECT 1 FROM venue_permission_grant grant_row
                   WHERE grant_row.venue_id=venue.id AND grant_row.grantee_person_id=$1::uuid
                     AND grant_row.can_withdraw AND grant_row.valid_from <= $3::timestamptz
                     AND (grant_row.valid_to IS NULL OR $3::timestamptz < grant_row.valid_to)
                )) AS can_withdraw
           FROM venue
           JOIN person owner ON owner.id=venue.owner_person_id
           JOIN settlement_account account ON account.owner_type='VENUE' AND account.owner_id=venue.id
           LEFT JOIN account_balance_projection balance ON balance.account_id=account.id
          WHERE venue.id=$2::uuid
            AND (venue.owner_person_id=$1::uuid OR EXISTS (
              SELECT 1 FROM venue_permission_grant grant_row
               WHERE grant_row.venue_id=venue.id AND grant_row.grantee_person_id=$1::uuid
                 AND grant_row.can_view AND grant_row.valid_from <= $3::timestamptz
                 AND (grant_row.valid_to IS NULL OR $3::timestamptz < grant_row.valid_to)
            ))
          LIMIT 2`,
        [context.personId, venueId, now]
      );
      if (accessResult.rows.length === 0) throw new Error("VENUE_NOT_FOUND");
      if (accessResult.rows.length !== 1) dataUnavailable();
      const access = accessResult.rows[0]!;
      const venue = mapAccess(access);

      const membersResult = await client.query<MemberRow>(
        `SELECT venue.owner_person_id::text AS person_id, owner.nickname, true AS can_view, true AS can_withdraw, true AS is_owner
           FROM venue JOIN person owner ON owner.id=venue.owner_person_id WHERE venue.id=$1::uuid
         UNION ALL
         SELECT grant_row.grantee_person_id::text AS person_id, grantee.nickname, grant_row.can_view, grant_row.can_withdraw, false AS is_owner
           FROM venue_permission_grant grant_row JOIN person grantee ON grantee.id=grant_row.grantee_person_id
          WHERE grant_row.venue_id=$1::uuid AND grant_row.valid_from <= $2::timestamptz
            AND (grant_row.valid_to IS NULL OR $2::timestamptz < grant_row.valid_to)
          ORDER BY is_owner DESC, nickname, person_id`,
        [venueId, now]
      );
      const members = membersResult.rows.map(mapMember);

      const periodSql = period.teachingWeekId !== undefined
        ? "fee.teaching_week_id=$2::uuid"
        : "week.starts_on >= $2::date AND week.ends_on <= $3::date";
      const periodValues: readonly unknown[] = period.teachingWeekId !== undefined
        ? [venueId, period.teachingWeekId]
        : [venueId, period.startsOn, period.endsOn];
      const feesResult = await client.query<FeeRow>(
        `WITH latest_snapshot AS (
           SELECT DISTINCT ON (snapshot.weekly_fee_entry_id)
                  snapshot.weekly_fee_entry_id, snapshot.source_weekly_fee_version, snapshot.snapshot_json, snapshot.context_json
             FROM weekly_fee_allocation_snapshot snapshot
             JOIN weekly_fee_entry current_fee ON current_fee.id=snapshot.weekly_fee_entry_id
            WHERE snapshot.source_weekly_fee_version=current_fee.version
            ORDER BY snapshot.weekly_fee_entry_id, snapshot.sequence_no DESC
         )
         SELECT fee.id::text AS weekly_fee_entry_id, week.id::text AS teaching_week_id,
                week.starts_on::text AS week_starts_on, week.ends_on::text AS week_ends_on,
                teacher.id::text AS teacher_person_id, teacher.nickname AS teacher_nickname,
                student.id::text AS student_record_id, student.display_name AS student_display_name,
                student.course_context_id, snapshot.snapshot_json, snapshot.context_json
           FROM weekly_fee_entry fee
           JOIN latest_snapshot snapshot ON snapshot.weekly_fee_entry_id=fee.id
           JOIN teaching_week week ON week.id=fee.teaching_week_id
           JOIN referral_case referral ON referral.id=fee.referral_case_id
           JOIN person teacher ON teacher.id=referral.receiver_person_id
           JOIN teacher_student_record student ON student.id=referral.teacher_student_record_id
           LEFT JOIN weekly_fee_refund_effect refund ON refund.weekly_fee_entry_id=fee.id
          WHERE fee.venue_id=$1::uuid AND refund.weekly_fee_entry_id IS NULL AND ${periodSql}
          ORDER BY teacher.nickname, teacher.id, week.starts_on, fee.id`,
        periodValues
      );

      const teachers = new Map<string, { teacherPersonId: string; teacherNickname: string; totalVenueFeeCents: bigint; weeklyFees: VenueBoard["teachers"][number]["weeklyFees"][number][] }>();
      let totalVenueFeeCents = 0n;
      for (const row of feesResult.rows) {
        if (!UUID.test(row.weekly_fee_entry_id) || !UUID.test(row.teaching_week_id) || !UUID.test(row.teacher_person_id)
          || !UUID.test(row.student_record_id) || typeof row.teacher_nickname !== "string" || typeof row.student_display_name !== "string"
          || typeof row.course_context_id !== "string" || !DATE.test(row.week_starts_on) || !DATE.test(row.week_ends_on)) dataUnavailable();
        const venueFeeCents = parseVenueCents(row.snapshot_json, row.context_json, venueId, access.account_id);
        const teacher = teachers.get(row.teacher_person_id) ?? {
          teacherPersonId: row.teacher_person_id,
          teacherNickname: row.teacher_nickname,
          totalVenueFeeCents: 0n,
          weeklyFees: []
        };
        teacher.totalVenueFeeCents += venueFeeCents;
        teacher.weeklyFees.push({
          weeklyFeeEntryId: row.weekly_fee_entry_id,
          teachingWeekId: row.teaching_week_id,
          weekStartsOn: row.week_starts_on,
          weekEndsOn: row.week_ends_on,
          studentRecordId: row.student_record_id,
          studentDisplayName: row.student_display_name,
          courseContextId: row.course_context_id,
          venueFeeCents
        });
        teachers.set(row.teacher_person_id, teacher);
        totalVenueFeeCents += venueFeeCents;
      }
      return {
        venue,
        period,
        members,
        teachers: [...teachers.values()],
        totalVenueFeeCents
      };
    });
  }
}
