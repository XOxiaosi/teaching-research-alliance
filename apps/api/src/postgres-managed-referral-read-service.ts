import type { RoleContext } from "@teaching-research-alliance/contracts";
import type { PostgresClient, PostgresPool } from "./postgres-ledger-repository.js";

type ManagedReferralRow = Readonly<{
  referral_id: string;
  student_display_name: string;
  course_context_id: string;
  referrer_person_id: string;
  referrer_nickname: string;
  receiver_person_id: string;
  receiver_nickname: string;
  referral_status: "ACCEPTED" | "COMPLETED";
  version: string;
  submitted_at: string;
}>;

export type ManagedReferralView = Readonly<{
  referralId: string;
  studentDisplayName: string;
  courseContextId: string;
  referrerPersonId: string;
  referrerNickname: string;
  receiverPersonId: string;
  receiverNickname: string;
  referralStatus: "ACCEPTED" | "COMPLETED";
  version: number;
  submittedAt: string;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const assertGlobalAuthority = (context: RoleContext): void => {
  if (!UUID.test(context.personId)
    || (context.subject !== "SYSTEM_OWNER" && context.subject !== "SYSTEM_ADMIN")
    || context.scope !== "GLOBAL"
    || context.regionId !== undefined
    || context.campusId !== undefined
    || context.venueId !== undefined) {
    throw new Error("FORBIDDEN_SCOPE");
  }
};

const readOnly = async <T>(pool: PostgresPool, work: (client: PostgresClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  let open = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    open = true;
    const value = await work(client);
    await client.query("COMMIT");
    open = false;
    return value;
  } catch (error) {
    if (open) await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.release();
  }
};

/** A global completion list, scoped to accepted and completed cases only. */
export class PostgresManagedReferralReadService {
  public constructor(private readonly pool: PostgresPool) {}

  public async list(context: RoleContext, at: Date): Promise<readonly ManagedReferralView[]> {
    assertGlobalAuthority(context);
    if (!Number.isFinite(at.getTime())) throw new Error("INVALID_INPUT");
    return readOnly(this.pool, async (client) => {
      // A SessionView is a transport assertion. Recheck the active GLOBAL authority
      // in the same snapshot as the directory so a stale role cannot read all cases.
      const assignment = await client.query<{ id: string }>(
        `SELECT assignment.id::text AS id
           FROM role_assignment assignment
           JOIN person actor ON actor.id=assignment.person_id
           JOIN user_account account ON account.person_id=assignment.person_id
          WHERE assignment.person_id=$1::uuid
            AND assignment.subject_code=$2
            AND assignment.scope_type='GLOBAL'
            AND assignment.scope_id IS NULL
            AND actor.status='ACTIVE'
            AND account.login_status='ACTIVE'
            AND assignment.valid_from <= $3::timestamptz
            AND (assignment.valid_to IS NULL OR assignment.valid_to > $3::timestamptz)
          ORDER BY assignment.id
          LIMIT 2`,
        [context.personId, context.subject, at.toISOString()]
      );
      if (assignment.rows.length !== 1) throw new Error("FORBIDDEN_SCOPE");
      const referrals = await client.query<ManagedReferralRow>(
        `SELECT referral.id::text AS referral_id,
                student.display_name AS student_display_name,
                student.course_context_id,
                referrer.id::text AS referrer_person_id,
                referrer.nickname AS referrer_nickname,
                receiver.id::text AS receiver_person_id,
                receiver.nickname AS receiver_nickname,
                referral.status AS referral_status,
                referral.version::text AS version,
                to_char(referral.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS submitted_at
           FROM referral_case referral
           JOIN teacher_student_record student ON student.id=referral.teacher_student_record_id
           JOIN person referrer ON referrer.id=referral.referrer_person_id
           JOIN person receiver ON receiver.id=referral.receiver_person_id
          WHERE referral.status IN ('ACCEPTED','COMPLETED')
          ORDER BY referral.submitted_at DESC,referral.id`
      );
      return Object.freeze(referrals.rows.map((row) => {
          const version = Number(row.version);
          if (!UUID.test(row.referral_id) || !UUID.test(row.referrer_person_id) || !UUID.test(row.receiver_person_id)
            || !Number.isSafeInteger(version) || version < 1) throw new Error("REFERRAL_READ_MODEL_CORRUPT");
          return Object.freeze({
            referralId: row.referral_id,
            studentDisplayName: row.student_display_name,
            courseContextId: row.course_context_id,
            referrerPersonId: row.referrer_person_id,
            referrerNickname: row.referrer_nickname,
            receiverPersonId: row.receiver_person_id,
            receiverNickname: row.receiver_nickname,
            referralStatus: row.referral_status,
            version,
            submittedAt: row.submitted_at,
          });
        }));
    });
  }
}
