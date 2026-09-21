import type { RoleContext } from "@teaching-research-alliance/contracts";
import type { PostgresPool } from "./postgres-ledger-repository.js";

type SentRow = {
  referral_id: string; student_record_id: string; student_name: string;
  course: string; receiver_id: string; receiver_name: string; status: string;
  submitted_at: string; source_subject: string | null; class_type: string | null;
  fee_id: string | null; week_id: string | null; starts_on: string | null;
  ends_on: string | null; amount: string | null;
};

export class PostgresSentReferralReadService {
  public constructor(private readonly pool: PostgresPool) {}

  public async list(context: RoleContext, at: Date) {
    if (!["TEACHING_TEACHER", "ACADEMIC_PLANNER", "PLANNING_MENTOR"].includes(context.subject)) throw new Error("FORBIDDEN_SCOPE");
    if (!Number.isFinite(at.getTime())) throw new Error("INVALID_INPUT");
    const client = await this.pool.connect();
    try {
      const result = await client.query<SentRow>(
        `SELECT referral.id::text AS referral_id, student.id::text AS student_record_id,
                student.display_name AS student_name, student.course_context_id AS course,
                receiver.id::text AS receiver_id, receiver.nickname AS receiver_name,
                referral.status, to_char(referral.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS submitted_at,
                snapshot.source_subject, snapshot.class_type,
                fee.id::text AS fee_id, week.id::text AS week_id,
                week.starts_on::text, week.ends_on::text, fee.gross_amount_cents::text AS amount
           FROM referral_case referral
           JOIN teacher_student_record student ON student.id=referral.teacher_student_record_id
           JOIN person receiver ON receiver.id=referral.receiver_person_id
           LEFT JOIN referral_creation_snapshot snapshot ON snapshot.referral_case_id=referral.id
           LEFT JOIN weekly_fee_entry fee ON fee.referral_case_id=referral.id AND EXISTS (
             SELECT 1 FROM teaching_week fee_week
             JOIN academic_period period ON period.id=fee_week.academic_period_id
             JOIN academic_year_plan year ON year.id=period.academic_year_plan_id
             WHERE fee_week.id=fee.teaching_week_id
               AND ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date BETWEEN year.starts_on AND year.ends_on
           )
           LEFT JOIN teaching_week week ON week.id=fee.teaching_week_id
          WHERE referral.referrer_person_id=$1
            AND (referral.status IN ('PENDING','ACCEPTED','REACTIVATED') OR fee.id IS NOT NULL OR EXISTS (
              SELECT 1 FROM academic_year_plan year
               WHERE ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date BETWEEN year.starts_on AND year.ends_on
                 AND (referral.submitted_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN year.starts_on AND year.ends_on
            ))
          ORDER BY referral.submitted_at DESC,referral.id,week.starts_on,fee.id`,
        [context.personId, at.toISOString()]
      );
      const records = new Map<string, {
        referralId: string; studentRecordId: string; studentDisplayName: string;
        courseContextId: string; receiverPersonId: string; receiverNickname: string;
        referralStatus: string; submittedAt: string; sourceSubject: string | null; classType: string | null;
        weeklyFees: { entryId: string; teachingWeekId: string; weekStartsOn: string; weekEndsOn: string; grossAmountCents: bigint }[];
      }>();
      for (const row of result.rows) {
        let record = records.get(row.referral_id);
        if (!record) {
          record = { referralId: row.referral_id, studentRecordId: row.student_record_id,
            studentDisplayName: row.student_name, courseContextId: row.course,
            receiverPersonId: row.receiver_id, receiverNickname: row.receiver_name,
            referralStatus: row.status, submittedAt: row.submitted_at,
            sourceSubject: row.source_subject, classType: row.class_type, weeklyFees: [] };
          records.set(row.referral_id, record);
        }
        if (row.fee_id) {
          if (!row.week_id || !row.starts_on || !row.ends_on || row.amount === null) throw new Error("SENT_REFERRAL_READ_MODEL_CORRUPT");
          record.weeklyFees.push({ entryId: row.fee_id, teachingWeekId: row.week_id,
            weekStartsOn: row.starts_on, weekEndsOn: row.ends_on, grossAmountCents: BigInt(row.amount) });
        }
      }
      return [...records.values()];
    } finally { await client.release(); }
  }
}
