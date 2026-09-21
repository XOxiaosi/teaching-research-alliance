import { createHash } from "node:crypto";
import type { RoleContext } from "@teaching-research-alliance/contracts";
import type { PostgresPool } from "./postgres-ledger-repository.js";

export type ReferralCreationDraft = Readonly<{
  receiverPersonId: string;
  studentDisplayName: string;
  courseContextId: string;
  classType: "ONE_TO_ONE" | "SMALL_GROUP";
}>;
export type ReferralCopyDraft = Readonly<{
  receiverPersonId: string;
  courseContextId?: string;
  classType?: "ONE_TO_ONE" | "SMALL_GROUP";
}>;
export type ReferralCopyResult = Readonly<{
  referralId: string;
  studentRecordId: string;
  version: number;
  replay: boolean;
  copiedFromReferralId: string;
}>;
type CopySourceRow = Readonly<{
  referral_id: string;
  referrer_person_id: string;
  receiver_person_id: string;
  display_name: string;
  course_context_id: string;
  class_type: "ONE_TO_ONE" | "SMALL_GROUP" | null;
}>;
type CopyReplayRow = Readonly<{
  request_hash: string;
  referral_case_id: string;
  student_id: string;
  copied_source_reason: string | null;
}>;
const allowed = ["TEACHING_TEACHER", "ACADEMIC_PLANNER", "PLANNING_MENTOR"];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const assertContext = (context: RoleContext): void => {
  if (!allowed.includes(context.subject)) throw new Error("FORBIDDEN_SCOPE");
};
const single = <T>(rows: readonly T[], code: string): T => {
  if (rows.length !== 1) throw new Error(code);
  return rows[0]!;
};
const validClassType = (value: string): value is "ONE_TO_ONE" | "SMALL_GROUP" =>
  ["ONE_TO_ONE", "SMALL_GROUP"].includes(value);

export class PostgresReferralCreationService {
  public constructor(private readonly pool: PostgresPool) {}

  public async listReceivingTeachers(context: RoleContext): Promise<readonly {personId:string;nickname:string}[]> {
    assertContext(context);
    const client = await this.pool.connect();
    try {
      const result = await client.query<{person_id:string;nickname:string}>(
        `SELECT person.id::text AS person_id, person.nickname
           FROM person JOIN teacher_profile profile ON profile.person_id=person.id
          WHERE person.status='ACTIVE' AND profile.employment_status='ACTIVE'
            AND profile.business_identity='TEACHING_TEACHER'
          ORDER BY person.nickname,person.id`);
      return result.rows.map(row=>({personId:row.person_id,nickname:row.nickname}));
    } finally { await client.release(); }
  }

  public async create(context: RoleContext, draft: ReferralCreationDraft, key: string, at: Date): Promise<{referralId:string;studentRecordId:string;version:number;replay:boolean}> {
    assertContext(context);
    if (!Number.isFinite(at.getTime()) || !key.trim() || key.length>200
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(draft.receiverPersonId)
      || !draft.studentDisplayName.trim() || draft.studentDisplayName.length>100
      || !draft.courseContextId.trim() || draft.courseContextId.length>100
      || !["ONE_TO_ONE","SMALL_GROUP"].includes(draft.classType)) throw new Error("INVALID_INPUT");
    const hash = createHash("sha256").update(JSON.stringify([draft.receiverPersonId,draft.studentDisplayName,draft.courseContextId,draft.classType])).digest("hex");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`referral-create:${context.personId}:${key}`]);
      const previous = await client.query<{request_hash:string;referral_case_id:string;student_id:string}>(
        `SELECT command.request_hash,command.referral_case_id::text,referral.teacher_student_record_id::text AS student_id
           FROM referral_creation_idempotency command JOIN referral_case referral ON referral.id=command.referral_case_id
          WHERE command.actor_person_id=$1 AND command.idempotency_key=$2`, [context.personId,key]);
      if (previous.rows[0]) {
        const row=previous.rows[0];
        if(row.request_hash!==hash)throw new Error("IDEMPOTENCY_REPLAY");
        await client.query("COMMIT");
        return {referralId:row.referral_case_id,studentRecordId:row.student_id,version:1,replay:true};
      }
      const source = single((await client.query<{business_identity:string;business_identity_version:string}>(
        `SELECT profile.business_identity,profile.business_identity_version::text
           FROM teacher_profile profile JOIN person ON person.id=profile.person_id
          WHERE profile.person_id=$1 AND profile.employment_status='ACTIVE' AND person.status='ACTIVE'
          FOR SHARE OF profile,person`,[context.personId])).rows,"REFERRER_NOT_ACTIVE");
      const mentor = await client.query<{id:string}>(
        `SELECT id::text FROM role_assignment WHERE person_id=$1 AND subject_code='PLANNING_MENTOR'
          AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2) FOR SHARE`,[context.personId,at.toISOString()]);
      const sourceSubject = mentor.rows.length ? "PLANNING_MENTOR" : source.business_identity;
      const identity = sourceSubject === "PLANNING_MENTOR" ? "ACADEMIC_PLANNER" : sourceSubject;
      single((await client.query<{id:string}>(
        `SELECT person.id::text FROM teacher_profile profile JOIN person ON person.id=profile.person_id
          WHERE person.id=$1 AND profile.business_identity='TEACHING_TEACHER'
          AND profile.employment_status='ACTIVE' AND person.status='ACTIVE' FOR SHARE OF profile,person`,[draft.receiverPersonId])).rows,"RECEIVER_NOT_ACTIVE");
      const campus = single((await client.query<{id:string;campus_id:string}>(
        `SELECT id::text,campus_id::text FROM person_campus_assignment WHERE person_id=$1
          AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2) FOR SHARE`,[context.personId,at.toISOString()])).rows,"REFERRER_CAMPUS_REQUIRED");
      const relationship = sourceSubject === "ACADEMIC_PLANNER" ? await client.query<{id:string}>(
        `SELECT id::text FROM person_relationship WHERE teacher_id=$1 AND relationship_type='PLANNING_MENTOR'
          AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2) FOR SHARE`,[context.personId,at.toISOString()]) : {rows:[]};
      const student = single((await client.query<{id:string}>(
        `INSERT INTO teacher_student_record(owner_teacher_id,course_context_id,display_name,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$4) RETURNING id::text`,[draft.receiverPersonId,draft.courseContextId,draft.studentDisplayName,at.toISOString()])).rows,"REFERRAL_CREATE_FAILED");
      const referral = single((await client.query<{id:string}>(
        `INSERT INTO referral_case(teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,unaccepted_expires_at,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'PENDING',$5,$6,$5,$5) RETURNING id::text`,[student.id,context.personId,draft.receiverPersonId,identity,at.toISOString(),new Date(at.getTime()+21*86400000).toISOString()])).rows,"REFERRAL_CREATE_FAILED");
      await client.query(
        `INSERT INTO referral_creation_snapshot(referral_case_id,source_subject,business_identity_version,campus_assignment_id,campus_id,planning_mentor_relationship_id,class_type,collector_person_id,created_by,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[referral.id,sourceSubject,source.business_identity_version,campus.id,campus.campus_id,relationship.rows[0]?.id??null,draft.classType,draft.receiverPersonId,context.personId,at.toISOString()]);
      await client.query(`INSERT INTO referral_case_event(referral_case_id,event_type,actor_person_id,reason,created_at) VALUES ($1,'SUBMITTED',$2,'INITIAL_REFERRAL',$3)`,[referral.id,context.personId,at.toISOString()]);
      await client.query(`INSERT INTO referral_creation_idempotency(actor_person_id,idempotency_key,request_hash,referral_case_id,created_at) VALUES ($1,$2,$3,$4,$5)`,[context.personId,key,hash,referral.id,at.toISOString()]);
      await client.query("COMMIT");
      return {referralId:referral.id,studentRecordId:student.id,version:1,replay:false};
    } catch(error) { await client.query("ROLLBACK"); throw error; }
    finally { await client.release(); }
  }

  /** Copies only source registration fields. It deliberately does not copy fee, acceptance, or venue state. */
  public async copy(
    context: RoleContext,
    sourceReferralId: string,
    draft: ReferralCopyDraft,
    key: string,
    at: Date
  ): Promise<ReferralCopyResult> {
    assertContext(context);
    if (!Number.isFinite(at.getTime()) || !key.trim() || key.length > 200
      || !uuidPattern.test(sourceReferralId) || !uuidPattern.test(draft.receiverPersonId)
      || (draft.courseContextId !== undefined && (!draft.courseContextId.trim() || draft.courseContextId.length > 100))
      || (draft.classType !== undefined && !validClassType(draft.classType))) throw new Error("INVALID_INPUT");
    // This has a COPY namespace and only user input, so it cannot collide with legacy create keys or drift with source edits.
    const hash = createHash("sha256").update(JSON.stringify([
      "COPY", sourceReferralId, draft.receiverPersonId, draft.courseContextId ?? null, draft.classType ?? null
    ])).digest("hex");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`referral-create:${context.personId}:${key}`]);
      const previous = await client.query<CopyReplayRow>(
        `SELECT command.request_hash,command.referral_case_id::text,referral.teacher_student_record_id::text AS student_id,
                copied_event.reason AS copied_source_reason
           FROM referral_creation_idempotency command JOIN referral_case referral ON referral.id=command.referral_case_id
           LEFT JOIN LATERAL (
             SELECT reason FROM referral_case_event
              WHERE referral_case_id=referral.id AND event_type='COPIED'
              ORDER BY created_at,id LIMIT 1
           ) copied_event ON true
          WHERE command.actor_person_id=$1 AND command.idempotency_key=$2
          FOR SHARE OF command,referral`, [context.personId,key]);
      if (previous.rows[0]) {
        const row=previous.rows[0];
        const copiedFromReferralId=row.copied_source_reason?.startsWith("COPIED_FROM_REFERRAL:")
          ? row.copied_source_reason.slice("COPIED_FROM_REFERRAL:".length) : undefined;
        if(row.request_hash!==hash || copiedFromReferralId===undefined || !uuidPattern.test(copiedFromReferralId))throw new Error("IDEMPOTENCY_REPLAY");
        await client.query("COMMIT");
        return {referralId:row.referral_case_id,studentRecordId:row.student_id,version:1,replay:true,copiedFromReferralId};
      }
      const original=single((await client.query<CopySourceRow>(
        `SELECT referral.id::text AS referral_id,referral.referrer_person_id::text AS referrer_person_id,
                referral.receiver_person_id::text AS receiver_person_id,student.display_name,student.course_context_id,
                snapshot.class_type
           FROM referral_case referral
           JOIN teacher_student_record student ON student.id=referral.teacher_student_record_id
           LEFT JOIN referral_creation_snapshot snapshot ON snapshot.referral_case_id=referral.id
          WHERE referral.id=$1::uuid
          FOR SHARE OF referral,student`,[sourceReferralId])).rows,"REFERRAL_NOT_FOUND");
      if(original.referrer_person_id!==context.personId)throw new Error("FORBIDDEN_SCOPE");
      const courseContextId=draft.courseContextId??original.course_context_id;
      const classType=draft.classType??original.class_type;
      if(classType===null)throw new Error("INVALID_INPUT");
      if(original.receiver_person_id===draft.receiverPersonId.toLowerCase()&&original.course_context_id===courseContextId)throw new Error("REFERRAL_COPY_TARGET_UNCHANGED");

      // Resolve the new record's identity and organization at copy time, rather than inheriting historical source pricing.
      const source = single((await client.query<{business_identity:string;business_identity_version:string}>(
        `SELECT profile.business_identity,profile.business_identity_version::text
           FROM teacher_profile profile JOIN person ON person.id=profile.person_id
          WHERE profile.person_id=$1 AND profile.employment_status='ACTIVE' AND person.status='ACTIVE'
          FOR SHARE OF profile,person`,[context.personId])).rows,"REFERRER_NOT_ACTIVE");
      const mentor = await client.query<{id:string}>(
        `SELECT id::text FROM role_assignment WHERE person_id=$1 AND subject_code='PLANNING_MENTOR'
          AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2) FOR SHARE`,[context.personId,at.toISOString()]);
      const sourceSubject = mentor.rows.length ? "PLANNING_MENTOR" : source.business_identity;
      const identity = sourceSubject === "PLANNING_MENTOR" ? "ACADEMIC_PLANNER" : sourceSubject;
      single((await client.query<{id:string}>(
        `SELECT person.id::text FROM teacher_profile profile JOIN person ON person.id=profile.person_id
          WHERE person.id=$1 AND profile.business_identity='TEACHING_TEACHER'
            AND profile.employment_status='ACTIVE' AND person.status='ACTIVE' FOR SHARE OF profile,person`,[draft.receiverPersonId])).rows,"RECEIVER_NOT_ACTIVE");
      const campus = single((await client.query<{id:string;campus_id:string}>(
        `SELECT id::text,campus_id::text FROM person_campus_assignment WHERE person_id=$1
          AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2) FOR SHARE`,[context.personId,at.toISOString()])).rows,"REFERRER_CAMPUS_REQUIRED");
      const relationship = sourceSubject === "ACADEMIC_PLANNER" ? await client.query<{id:string}>(
        `SELECT id::text FROM person_relationship WHERE teacher_id=$1 AND relationship_type='PLANNING_MENTOR'
          AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2) FOR SHARE`,[context.personId,at.toISOString()]) : {rows:[]};
      const student = single((await client.query<{id:string}>(
        `INSERT INTO teacher_student_record(owner_teacher_id,course_context_id,display_name,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$4) RETURNING id::text`,[draft.receiverPersonId,courseContextId,original.display_name,at.toISOString()])).rows,"REFERRAL_CREATE_FAILED");
      const referral = single((await client.query<{id:string}>(
        `INSERT INTO referral_case(teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,unaccepted_expires_at,copied_from_referral_id,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'PENDING',$5,$6,$7,$5,$5) RETURNING id::text`,[student.id,context.personId,draft.receiverPersonId,identity,at.toISOString(),new Date(at.getTime()+21*86400000).toISOString(),sourceReferralId])).rows,"REFERRAL_CREATE_FAILED");
      await client.query(
        `INSERT INTO referral_creation_snapshot(referral_case_id,source_subject,business_identity_version,campus_assignment_id,campus_id,planning_mentor_relationship_id,class_type,collector_person_id,created_by,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[referral.id,sourceSubject,source.business_identity_version,campus.id,campus.campus_id,relationship.rows[0]?.id??null,classType,draft.receiverPersonId,context.personId,at.toISOString()]);
      await client.query(
        `INSERT INTO referral_case_event(referral_case_id,event_type,actor_person_id,reason,result_referral_version,created_at)
         VALUES ($1,'COPIED',$2,$3,1,$4)`,
        [referral.id,context.personId,`COPIED_FROM_REFERRAL:${sourceReferralId}`,at.toISOString()]
      );
      await client.query(`INSERT INTO referral_creation_idempotency(actor_person_id,idempotency_key,request_hash,referral_case_id,created_at) VALUES ($1,$2,$3,$4,$5)`,[context.personId,key,hash,referral.id,at.toISOString()]);
      await client.query("COMMIT");
      return {referralId:referral.id,studentRecordId:student.id,version:1,replay:false,copiedFromReferralId:sourceReferralId};
    } catch(error) { await client.query("ROLLBACK"); throw error; }
    finally { await client.release(); }
  }
}
