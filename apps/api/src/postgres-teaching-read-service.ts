import type { RoleContext } from "@teaching-research-alliance/contracts";
import type { PostgresPool } from "./postgres-ledger-repository.js";

type ReferralStatus = "PENDING" | "ACCEPTED" | "ARCHIVED" | "REACTIVATED";
type ReferrerIdentity = "TEACHING_TEACHER" | "ACADEMIC_PLANNER";
type WeekKind = "REGULAR" | "WINTER_SPECIAL" | "SUMMER_SPECIAL";

type ReferralFeeRow = Readonly<{
  referral_id: string;
  student_record_id: string;
  student_display_name: string;
  course_context_id: string;
  referral_status: ReferralStatus;
  referral_version: string;
  initial_venue_id: string | null;
  submitted_at: string;
  unaccepted_expires_at: string | null;
  referrer_identity: ReferrerIdentity;
  fee_entry_id: string | null;
  teaching_week_id: string | null;
  week_starts_on: string | null;
  week_ends_on: string | null;
  settlement_month: string | null;
  gross_amount_cents: string | null;
  fee_version: string | null;
  venue_id: string | null;
  venue_name: string | null;
  is_self_use_snapshot: boolean | null;
  refund_status: "REFUNDED" | "ACTIVE" | null;
}>;

type OpenWeekRow = Readonly<{
  week_id: string;
  year_label: string;
  period_label: string;
  sequence_no: number;
  week_kind: WeekKind;
  starts_on: string;
  ends_on: string;
  settlement_month: string;
}>;

export type TeachingWeeklyFeeView = Readonly<{
  entryId: string;
  teachingWeekId: string;
  weekStartsOn: string;
  weekEndsOn: string;
  settlementMonth: string;
  grossAmountCents: bigint;
  version: number;
  venueId: string;
  venueName: string;
  isSelfUseSnapshot: boolean;
  refundStatus: "REFUNDED" | "ACTIVE";
}>;

export type ReceivedReferralView = Readonly<{
  referralId: string;
  studentRecordId: string;
  studentDisplayName: string;
  courseContextId: string;
  referralStatus: ReferralStatus;
  version: number;
  initialVenueId: string | null;
  submittedAt: string;
  unacceptedExpiresAt: string | null;
  referrerIdentity: ReferrerIdentity;
  weeklyFees: readonly TeachingWeeklyFeeView[];
}>;

export type OpenTeachingWeekView = Readonly<{
  weekId: string;
  yearLabel: string;
  periodLabel: string;
  sequenceNo: number;
  weekKind: WeekKind;
  startsOn: string;
  endsOn: string;
  settlementMonth: string;
}>;

const assertTeacher = (context: RoleContext): void => {
  if (context.subject !== "TEACHING_TEACHER") throw new Error("FORBIDDEN_SCOPE");
};

const assertValidDate = (at: Date): void => {
  if (Number.isNaN(at.getTime())) throw new Error("INVALID_INPUT:at");
};

export class PostgresTeachingReadService {
  public constructor(private readonly pool: PostgresPool) {}

  public async listReceivedReferrals(context: RoleContext, at: Date): Promise<readonly ReceivedReferralView[]> {
    assertTeacher(context);
    assertValidDate(at);
    const client = await this.pool.connect();
    try {
      // Older isolated upgrade tests intentionally stop before migration 0021. Keep the
      // teaching read model usable there; a fully migrated database always takes the refund path.
      const refundTable = await client.query<{ present: boolean }>(
        "SELECT to_regclass(current_schema() || '.weekly_fee_refund_effect') IS NOT NULL AS present"
      );
      const hasRefundTable = refundTable.rows[0]?.present === true;
      const refundJoin = hasRefundTable
        ? "LEFT JOIN weekly_fee_refund_effect refund ON refund.weekly_fee_entry_id = fee.id"
        : "";
      const refundStatus = hasRefundTable
        ? "CASE WHEN fee.id IS NULL THEN NULL WHEN refund.weekly_fee_entry_id IS NOT NULL THEN 'REFUNDED' ELSE 'ACTIVE' END"
        : "CASE WHEN fee.id IS NULL THEN NULL ELSE 'ACTIVE' END";
      const result = await client.query<ReferralFeeRow>(
        `SELECT referral.id::text AS referral_id,
                student.id::text AS student_record_id,
                student.display_name AS student_display_name,
                student.course_context_id,
                referral.status AS referral_status,
                referral.version::text AS referral_version,
                acceptance.venue_id::text AS initial_venue_id,
                to_char(referral.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS submitted_at,
                to_char(referral.unaccepted_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS unaccepted_expires_at,
                referral.referrer_identity,
                fee.id::text AS fee_entry_id,
                fee.teaching_week_id::text AS teaching_week_id,
                week.starts_on::text AS week_starts_on,
                week.ends_on::text AS week_ends_on,
                fee.settlement_month::text AS settlement_month,
                fee.gross_amount_cents::text AS gross_amount_cents,
                fee.version::text AS fee_version,
                fee.venue_id::text AS venue_id,
                venue.name AS venue_name,
                fee.is_self_use_snapshot,
                ${refundStatus} AS refund_status
           FROM referral_case referral
           JOIN teacher_student_record student ON student.id = referral.teacher_student_record_id
           LEFT JOIN LATERAL (
             SELECT venue_id FROM referral_acceptance_snapshot
              WHERE referral_case_id=referral.id ORDER BY accepted_referral_version DESC LIMIT 1
           ) acceptance ON true
           LEFT JOIN weekly_fee_entry fee
             ON fee.referral_case_id = referral.id
            AND EXISTS (
              SELECT 1
                FROM teaching_week fee_week
                JOIN academic_period fee_period ON fee_period.id = fee_week.academic_period_id
                JOIN academic_year_plan fee_year ON fee_year.id = fee_period.academic_year_plan_id
               WHERE fee_week.id = fee.teaching_week_id
                 AND ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
                     BETWEEN fee_year.starts_on AND fee_year.ends_on
            )
           LEFT JOIN teaching_week week ON week.id = fee.teaching_week_id
           LEFT JOIN venue ON venue.id = fee.venue_id
           ${refundJoin}
          WHERE referral.receiver_person_id = $1::uuid
            AND (
              referral.status IN ('PENDING', 'ACCEPTED', 'REACTIVATED')
              OR fee.id IS NOT NULL
              OR EXISTS (
                SELECT 1
                  FROM academic_year_plan current_year
                 WHERE ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
                       BETWEEN current_year.starts_on AND current_year.ends_on
                   AND (referral.submitted_at AT TIME ZONE 'Asia/Shanghai')::date
                       BETWEEN current_year.starts_on AND current_year.ends_on
              )
            )
          ORDER BY referral.submitted_at DESC, referral.id, week.starts_on, fee.id`,
        [context.personId, at.toISOString()]
      );
      const referrals = new Map<string, ReceivedReferralView & { weeklyFees: TeachingWeeklyFeeView[] }>();
      for (const row of result.rows) {
        let referral = referrals.get(row.referral_id);
        if (referral === undefined) {
          const version = Number(row.referral_version);
          if (!Number.isSafeInteger(version) || version < 1) throw new Error("REFERRAL_READ_MODEL_CORRUPT");
          referral = {
            referralId: row.referral_id,
            studentRecordId: row.student_record_id,
            studentDisplayName: row.student_display_name,
            courseContextId: row.course_context_id,
            referralStatus: row.referral_status,
            version,
            initialVenueId: row.initial_venue_id,
            submittedAt: row.submitted_at,
            unacceptedExpiresAt: row.unaccepted_expires_at,
            referrerIdentity: row.referrer_identity,
            weeklyFees: []
          };
          referrals.set(row.referral_id, referral);
        }
        if (row.fee_entry_id === null) continue;
        if (
          row.teaching_week_id === null
          || row.week_starts_on === null
          || row.week_ends_on === null
          || row.settlement_month === null
          || row.gross_amount_cents === null
          || row.fee_version === null
          || row.venue_id === null
          || row.venue_name === null
          || row.is_self_use_snapshot === null
          || row.refund_status === null
        ) throw new Error("WEEKLY_FEE_READ_MODEL_CORRUPT");
        referral.weeklyFees.push({
          entryId: row.fee_entry_id,
          teachingWeekId: row.teaching_week_id,
          weekStartsOn: row.week_starts_on,
          weekEndsOn: row.week_ends_on,
          settlementMonth: row.settlement_month,
          grossAmountCents: BigInt(row.gross_amount_cents),
          version: Number(row.fee_version),
          venueId: row.venue_id,
          venueName: row.venue_name,
          isSelfUseSnapshot: row.is_self_use_snapshot,
          refundStatus: row.refund_status
        });
      }
      return [...referrals.values()];
    } finally {
      await client.release();
    }
  }

  public async listOpenTeachingWeeks(context: RoleContext, at: Date): Promise<readonly OpenTeachingWeekView[]> {
    assertTeacher(context);
    assertValidDate(at);
    const client = await this.pool.connect();
    try {
      const result = await client.query<OpenWeekRow>(
        `SELECT week.id::text AS week_id,
                year_plan.label AS year_label,
                period.label AS period_label,
                week.sequence_no,
                week.week_kind,
                week.starts_on::text AS starts_on,
                week.ends_on::text AS ends_on,
                week.settlement_month::text AS settlement_month
           FROM teaching_week week
           JOIN academic_period period ON period.id = week.academic_period_id
           JOIN academic_year_plan year_plan ON year_plan.id = period.academic_year_plan_id
          WHERE week.status = 'OPEN'
            AND ($1::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
                BETWEEN year_plan.starts_on AND year_plan.ends_on
          ORDER BY week.starts_on, week.sequence_no, week.id`,
        [at.toISOString()]
      );
      return result.rows.map((row) => ({
        weekId: row.week_id,
        yearLabel: row.year_label,
        periodLabel: row.period_label,
        sequenceNo: row.sequence_no,
        weekKind: row.week_kind,
        startsOn: row.starts_on,
        endsOn: row.ends_on,
        settlementMonth: row.settlement_month
      }));
    } finally {
      await client.release();
    }
  }
}
