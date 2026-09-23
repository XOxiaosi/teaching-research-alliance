import type { RoleContext } from "@teaching-research-alliance/contracts";
import type { PostgresClient, PostgresPool } from "./postgres-ledger-repository.js";
import type { GroupLeaderCandidate } from "./postgres-group-leader-relationship-service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PersonRow = Readonly<{ person_id: string; nickname: string }>;
type WeekRow = Readonly<{ id: string; starts_on: string; ends_on: string; settlement_month: string }>;

export type GroupLeaderRelationshipDirectory = Readonly<{
  groupLeaders: readonly GroupLeaderCandidate[];
  teachers: readonly Readonly<{ personId: string; nickname: string }>[];
  currentWeeks: readonly Readonly<{ id: string; startsOn: string; endsOn: string; settlementMonth: string }>[];
}>;

export type GroupLeaderCandidateReader = Readonly<{
  listCandidates: (context: RoleContext, at: Date) => Promise<readonly GroupLeaderCandidate[]>;
}>;

const assertScope = (context: RoleContext): void => {
  if (!UUID.test(context.personId) || !["SYSTEM_OWNER", "SYSTEM_ADMIN"].includes(context.subject)
    || context.scope !== "GLOBAL" || context.regionId !== undefined || context.campusId !== undefined || context.venueId !== undefined) {
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

/**
 * Read-only selector data for the group-leader change writer. The core reader
 * still verifies candidate eligibility; this adapter independently verifies the
 * acting administrator before reading teacher and current-week candidates.
 */
export class PostgresGroupLeaderDirectoryService {
  public constructor(
    private readonly pool: PostgresPool,
    private readonly candidates: GroupLeaderCandidateReader,
  ) {}

  public async list(context: RoleContext, at: Date): Promise<GroupLeaderRelationshipDirectory> {
    assertScope(context);
    if (!Number.isFinite(at.getTime())) throw new Error("INVALID_INPUT");
    const [groupLeaders, values] = await Promise.all([
      this.candidates.listCandidates(context, at),
      readOnly(this.pool, async (client) => {
        const atIso = at.toISOString();
        const assignment = await client.query<{ id: string }>(
          `SELECT id::text FROM role_assignment
             WHERE person_id=$1::uuid AND subject_code=$2 AND scope_type='GLOBAL' AND scope_id IS NULL
               AND valid_from<=$3::timestamptz AND (valid_to IS NULL OR valid_to>$3::timestamptz)
             ORDER BY id LIMIT 2`,
          [context.personId, context.subject, atIso],
        );
        if (assignment.rows.length !== 1) throw new Error("FORBIDDEN_SCOPE");
        const [teachers, weeks] = await Promise.all([
          client.query<PersonRow>(
            `SELECT person.id::text AS person_id,person.nickname
               FROM person JOIN teacher_profile profile ON profile.person_id=person.id
              WHERE person.status='ACTIVE' AND profile.employment_status='ACTIVE'
                AND profile.business_identity='TEACHING_TEACHER'
              ORDER BY person.nickname,person.id`,
          ),
          client.query<WeekRow>(
            `SELECT id::text,starts_on::text,ends_on::text,settlement_month::text
               FROM teaching_week
              WHERE week_kind='REGULAR'
                AND (($1::timestamptz AT TIME ZONE 'Asia/Shanghai')::date BETWEEN starts_on AND ends_on)
              ORDER BY starts_on,id`,
            [atIso],
          ),
        ]);
        return {
          teachers: teachers.rows.map((row) => ({ personId: row.person_id, nickname: row.nickname })),
          currentWeeks: weeks.rows.map((row) => ({ id: row.id, startsOn: row.starts_on, endsOn: row.ends_on, settlementMonth: row.settlement_month })),
        };
      }),
    ]);
    return Object.freeze({
      groupLeaders: Object.freeze([...groupLeaders]),
      teachers: Object.freeze(values.teachers),
      currentWeeks: Object.freeze(values.currentWeeks),
    });
  }
}
