import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DEFAULT_RATE_POLICY_VALUES } from "@teaching-research-alliance/domain";
import { PostgresTeachingMentorRelationshipService } from "../../dist/postgres-teaching-mentor-relationship-service.js";
import { PostgresWeeklySettlementService } from "../../dist/postgres-weekly-settlement-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";
const connectionString = process.env.DATABASE_URL;
const at = new Date("2026-09-24T12:00:00.000Z");
const adminContext = personId => ({ subject:"SYSTEM_ADMIN", personId, scope:"GLOBAL" });
test("teaching mentor ADD publish and directory", async t => {
 if (!connectionString) return t.skip("DATABASE_URL_REQUIRED");
 const db=await createTestDatabase(connectionString); t.after(()=>db.close());
 const ids={admin:randomUUID(),teacher:randomUUID(),mentor:randomUUID(),region:randomUUID(),campus:randomUUID(),year:randomUUID(),period:randomUUID(),week:randomUUID()};
 for(const [id,n] of [[ids.admin,"tm-admin"],[ids.teacher,"tm-teacher"],[ids.mentor,"tm-mentor"]]){
  await db.pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1,$2,$2,'ACTIVE')",[id,n]);
  await db.pool.query("INSERT INTO user_account(person_id,phone_normalized,password_hash,login_status) VALUES($1,$2,'synthetic','ACTIVE')",[id,`1777${id.replaceAll('-','').slice(0,8)}`]);
  await db.pool.query("INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('PERSON',$1,$2,'ACTIVE')",[id,`person:${id}`]);
 }
 await db.pool.query("INSERT INTO organization_unit(id,unit_type,name) VALUES($1,'REGION','tm-region'),($2,'CAMPUS','tm-campus')",[ids.region,ids.campus]);
 await db.pool.query("INSERT INTO teacher_profile(person_id,business_identity,region_id,campus_id,employment_status) VALUES($1,'TEACHING_TEACHER',$2,$3,'ACTIVE'),($4,'TEACHING_TEACHER',$2,$3,'ACTIVE')",[ids.teacher,ids.region,ids.campus,ids.mentor]);
 await db.pool.query("INSERT INTO role_assignment(id,person_id,subject_code,scope_type,scope_id,valid_from,created_by) VALUES($1,$2,'SYSTEM_ADMIN','GLOBAL',NULL,'2026-01-01',$2),($3,$4,'TEACHING_MENTOR','MENTEES',$5,'2026-01-01',$2)",[randomUUID(),ids.admin,randomUUID(),ids.mentor,ids.teacher]);
 await db.pool.query("INSERT INTO academic_year_plan(id,label,starts_on,ends_on,created_by) VALUES($1,'2026','2026-01-01','2026-12-31',$2)",[ids.year,ids.admin]);
 await db.pool.query("INSERT INTO academic_period(id,academic_year_plan_id,label,starts_on,ends_on) VALUES($1,$2,'regular','2026-01-01','2026-12-31')",[ids.period,ids.year]);
 await db.pool.query("INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month,status) VALUES($1,$2,1,'REGULAR','2026-09-21','2026-09-27','2026-09-01','OPEN')",[ids.week,ids.period]);
 const service=new PostgresTeachingMentorRelationshipService(db.pool);
 const dir=await service.listDirectory(adminContext(ids.admin),at); assert.equal(dir.teachers.length,2); assert.deepEqual(dir.mentors[0].eligibleTeacherPersonIds,[ids.teacher]);
 const preview=await service.preview(adminContext(ids.admin),{teacherPersonId:ids.teacher,newRelatedPersonId:ids.mentor,effectiveTeachingWeekId:ids.week,reason:"initial teaching mentor"},at);
 assert.equal(preview.action,"ADD"); assert.equal(preview.sourceRelatedPersonId,null);
 const published=await service.publish(adminContext(ids.admin),preview.previewId,`tm-${randomUUID()}`,at); assert.equal(published.replay,false);
 const relation=(await db.pool.query("SELECT relationship_type,teacher_id::text,related_person_id::text FROM person_relationship WHERE id=$1",[published.resultRelationshipId])).rows[0];
 assert.deepEqual(relation,{relationship_type:"TEACHING_MENTOR",teacher_id:ids.teacher,related_person_id:ids.mentor});
});

const json = value => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);
const readLatest = async (pool, feeId) => (await pool.query(
 `SELECT id::text,sequence_no::text,snapshot_json,context_json,policy_version_id::text,net_monthly_cents::text
    FROM weekly_fee_allocation_snapshot snapshot WHERE weekly_fee_entry_id=$1::uuid ORDER BY snapshot.sequence_no DESC LIMIT 1`, [feeId]
)).rows[0];
const balance = async (pool, personId) => BigInt((await pool.query(
 `SELECT COALESCE(projection.balance_cents,0)::text value FROM settlement_account account
    LEFT JOIN account_balance_projection projection ON projection.account_id=account.id
   WHERE account.owner_type='PERSON' AND account.owner_id=$1::uuid`, [personId]
)).rows[0].value);
const mentorCents = snapshot => BigInt(snapshot.snapshot_json.lines.find(line => line.key === "teachingMentor").cents);
const omitMentor = snapshot => {
  const copy=structuredClone(snapshot); delete copy.snapshot_json.accountByKey.teachingMentor;
 delete copy.context_json.relationships.teachingMentor; delete copy.context_json.accounts.teachingMentor;
 delete copy.id; delete copy.sequence_no; return copy;
};

const seedSettlement = async pool => {
 const ids=Object.fromEntries(["admin","planner","teacher","mentorA","mentorB","leader","platform","regionFinance","region","campus","venue","year","period","previous","current","next","studentPrevious","studentCurrent","studentRefund","studentNext","referralPrevious","referralCurrent","referralRefund","referralNext"].map(key=>[key,randomUUID()]));
 const people=["admin","planner","teacher","mentorA","mentorB","leader","platform","regionFinance"];
 for(const key of people){
  await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,$2,'ACTIVE')",[ids[key],`tm-matrix-${key}-${ids[key]}`]);
  await pool.query("INSERT INTO user_account(person_id,phone_normalized,password_hash,login_status) VALUES($1::uuid,$2,'synthetic','ACTIVE')",[ids[key],`175${String(people.indexOf(key)).padStart(8,"0")}`]);
  await pool.query("INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('PERSON',$1::uuid,$2,'ACTIVE')",[ids[key],`person:${ids[key]}`]);
 }
 await pool.query("INSERT INTO organization_unit(id,unit_type,name) VALUES($1::uuid,'REGION',$2),($3::uuid,'CAMPUS',$4)",[ids.region,`region-${ids.region}`,ids.campus,`campus-${ids.campus}`]);
 await pool.query("INSERT INTO campus_region_assignment(campus_id,region_id,valid_from,created_by) VALUES($1::uuid,$2::uuid,'2026-01-01T00:00:00Z',$3::uuid)",[ids.campus,ids.region,ids.admin]);
 await pool.query(`INSERT INTO teacher_profile(person_id,business_identity,region_id,campus_id,employment_status) VALUES
   ($1::uuid,'ACADEMIC_PLANNER',$3::uuid,$4::uuid,'ACTIVE'),($2::uuid,'TEACHING_TEACHER',$3::uuid,$4::uuid,'ACTIVE')`,[ids.planner,ids.teacher,ids.region,ids.campus]);
 for(const personId of [ids.planner,ids.teacher]) await pool.query("INSERT INTO person_campus_assignment(person_id,campus_id,region_id,valid_from,created_by) VALUES($1::uuid,$2::uuid,$3::uuid,'2026-01-01T00:00:00Z',$4::uuid)",[personId,ids.campus,ids.region,ids.admin]);
 const role=async(personId,subject,scope,scopeId=null)=>{const id=randomUUID();await pool.query("INSERT INTO role_assignment(id,person_id,subject_code,scope_type,scope_id,valid_from,created_by) VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,'2026-01-01T00:00:00Z',$6::uuid)",[id,personId,subject,scope,scopeId,ids.admin]);return id;};
 await role(ids.admin,"SYSTEM_ADMIN","GLOBAL"); await role(ids.platform,"HEADQUARTERS_FINANCE","GLOBAL"); await role(ids.regionFinance,"REGION_FINANCE","REGION",ids.region); await role(ids.leader,"GROUP_LEADER","ASSOCIATED_TEACHERS");
 ids.mentorARole=await role(ids.mentorA,"TEACHING_MENTOR","MENTEES"); ids.mentorBRole=await role(ids.mentorB,"TEACHING_MENTOR","MENTEES");
 await pool.query(`INSERT INTO person_relationship(teacher_id,relationship_type,related_person_id,valid_from,effective_scope,created_by) VALUES
   ($1::uuid,'GROUP_LEADER',$2::uuid,'2026-01-01T00:00:00Z','CURRENT',$3::uuid),($1::uuid,'TEACHING_MENTOR',$4::uuid,'2026-01-01T00:00:00Z','CURRENT',$3::uuid)`,[ids.teacher,ids.leader,ids.admin,ids.mentorA]);
 await pool.query("INSERT INTO venue(id,owner_person_id,name,status,default_for_owner) VALUES($1::uuid,$2::uuid,$3,'ACTIVE',true)",[ids.venue,ids.teacher,`venue-${ids.venue}`]);
 await pool.query("INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('VENUE',$1::uuid,$2,'ACTIVE'),('COMPANY',$3::uuid,$4,'ACTIVE')",[ids.venue,`venue:${ids.venue}`,ids.campus,`company:${ids.campus}`]);
 await pool.query("INSERT INTO academic_year_plan(id,label,starts_on,ends_on,created_by) VALUES($1::uuid,'2026','2026-01-01','2026-12-31',$2::uuid)",[ids.year,ids.admin]);
 await pool.query("INSERT INTO academic_period(id,academic_year_plan_id,label,starts_on,ends_on) VALUES($1::uuid,$2::uuid,'regular','2026-09-01','2026-12-31')",[ids.period,ids.year]);
 for(const [key,n,start,end] of [["previous",1,"2026-09-14","2026-09-20"],["current",2,"2026-09-21","2026-09-27"],["next",3,"2026-09-28","2026-10-04"]]) await pool.query("INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month,status) VALUES($1::uuid,$2::uuid,$3,'REGULAR',$4::date,$5::date,'2026-09-01','OPEN')",[ids[key],ids.period,n,start,end]);
 await pool.query("INSERT INTO rate_policy_version(version,effective_from,policy_json,reason,published_by) VALUES(1,'2026-09-01',$1::jsonb,'teaching mentor matrix',$2::uuid)",[json(DEFAULT_RATE_POLICY_VALUES),ids.admin]);
 for(const key of ["Previous","Current","Refund","Next"]){
  await pool.query("INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name) VALUES($1::uuid,$2::uuid,$3,$4)",[ids[`student${key}`],ids.teacher,`course:${key}`,`student:${key}`]);
  await pool.query("INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,version) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'ACADEMIC_PLANNER','ACCEPTED','2026-09-01T00:00:00Z',2)",[ids[`referral${key}`],ids[`student${key}`],ids.planner,ids.teacher]);
 }
 return ids;
};
const settle=(weekly,ids,key,referral,week)=>weekly.recordAndSettle(ids.teacher,{referralCaseId:ids[referral],teachingWeekId:ids[week],venueId:ids.venue,settlementMonth:"2026-09-01",grossAmountCents:100000n,expectedVersion:0},key);
const freezeRefund=async(pool,ids,feeId)=>{
 const snapshot=await readLatest(pool,feeId), documentId=randomUUID();
 await pool.query("INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at) VALUES($1::uuid,$2::uuid,'REFUND','REFUNDED',1,$3::timestamptz,$3::timestamptz)",[documentId,ids.teacher,at.toISOString()]);
 await pool.query("ALTER TABLE weekly_fee_refund_effect DISABLE TRIGGER USER");
 try { await pool.query(`INSERT INTO weekly_fee_refund_effect(weekly_fee_entry_id,finance_document_id,allocation_snapshot_id,source_weekly_fee_version,gross_amount_cents,snapshot_json,created_at)
  SELECT $1::uuid,$2::uuid,$3::uuid,version,gross_amount_cents,$4::jsonb,$5::timestamptz FROM weekly_fee_entry WHERE id=$1::uuid`,[feeId,documentId,snapshot.id,json(snapshot.snapshot_json),at.toISOString()]); }
 finally { await pool.query("ALTER TABLE weekly_fee_refund_effect ENABLE TRIGGER USER"); }
 return snapshot;
};

test("真实 PostgreSQL：教学导师 A→B 的单普通周变更只迁移导师分配并续接 A",async t=>{
 if(!connectionString)return t.skip("DATABASE_URL_REQUIRED");
 const database=await createTestDatabase(connectionString);
 try{
  const {pool}=database,ids=await seedSettlement(pool),weekly=new PostgresWeeklySettlementService(pool),service=new PostgresTeachingMentorRelationshipService(pool);
  // A later scheduled relationship can coexist only when the current relationship
  // already ends at that boundary. The bounded change must preserve that end on
  // its continuation instead of overlapping the scheduled B relationship.
  await pool.query("UPDATE person_relationship SET valid_to='2026-10-04T16:00:00.000Z' WHERE teacher_id=$1::uuid AND relationship_type='TEACHING_MENTOR'",[ids.teacher]);
  await pool.query("INSERT INTO person_relationship(teacher_id,relationship_type,related_person_id,valid_from,effective_scope,created_by) VALUES($1::uuid,'TEACHING_MENTOR',$2::uuid,'2026-10-04T16:00:00.000Z','SCHEDULED',$3::uuid)",[ids.teacher,ids.mentorB,ids.admin]);
  const previous=await settle(weekly,ids,"tm-matrix-previous","referralPrevious","previous");
  const current=await settle(weekly,ids,"tm-matrix-current","referralCurrent","current");
  const refund=await settle(weekly,ids,"tm-matrix-refund","referralRefund","current");
  const next=await settle(weekly,ids,"tm-matrix-next","referralNext","next");
  const before={previous:await readLatest(pool,previous.fee.id),current:await readLatest(pool,current.fee.id),next:await readLatest(pool,next.fee.id)};
  const refundedBefore=await freezeRefund(pool,ids,refund.fee.id);
  const beforeBalances={a:await balance(pool,ids.mentorA),b:await balance(pool,ids.mentorB)};
  const preview=await service.preview(adminContext(ids.admin),{teacherPersonId:ids.teacher,newRelatedPersonId:ids.mentorB,effectiveTeachingWeekId:ids.current,effectiveThroughTeachingWeekId:ids.current,reason:"仅当前普通周交接给 B"},at);
  assert.deepEqual({action:preview.action,considered:preview.consideredFeeCount,moved:preview.movedFeeCount,refunds:preview.excludedRefundCount,through:preview.effectiveThroughTeachingWeekId},{action:"REPLACE",considered:1,moved:1,refunds:1,through:ids.current});
  const published=await service.publish(adminContext(ids.admin),preview.previewId,"tm-matrix-a-b-current",at);
  assert.equal(published.postingStatus,"POSTED"); assert.equal(published.replay,false);
  assert.equal((await service.publish(adminContext(ids.admin),preview.previewId,"tm-matrix-a-b-current",at)).replay,true);
  const after={previous:await readLatest(pool,previous.fee.id),current:await readLatest(pool,current.fee.id),refund:await readLatest(pool,refund.fee.id),next:await readLatest(pool,next.fee.id)};
  assert.equal(after.previous.id,before.previous.id); assert.equal(after.next.id,before.next.id); assert.equal(after.refund.id,refundedBefore.id);
  assert.notEqual(after.current.id,before.current.id,"current fee should have a migrated snapshot");
  assert.deepEqual(after.current.snapshot_json.lines,before.current.snapshot_json.lines);
  assert.deepEqual(omitMentor(after.current),omitMentor(before.current));
  assert.equal(after.current.context_json.relationships.teachingMentor.personId,ids.mentorB);
  assert.equal(after.current.context_json.accounts.teachingMentor.ownerId,ids.mentorB);
  assert.equal(after.current.snapshot_json.accountByKey.teachingMentor,`person:${ids.mentorB}`);
  assert.equal(after.current.policy_version_id,before.current.policy_version_id); assert.equal(after.current.net_monthly_cents,before.current.net_monthly_cents);
  assert.deepEqual(after.refund.snapshot_json,refundedBefore.snapshot_json); assert.equal(after.refund.context_json.relationships.teachingMentor.personId,ids.mentorA);
  const moved=mentorCents(before.current);
  assert.equal(await balance(pool,ids.mentorA),beforeBalances.a-moved); assert.equal(await balance(pool,ids.mentorB),beforeBalances.b+moved);
  assert.equal((await balance(pool,ids.mentorA))+(await balance(pool,ids.mentorB)),beforeBalances.a+beforeBalances.b);
  const change=(await pool.query(`SELECT source_relationship_id::text,result_relationship_id::text,continuation_relationship_id::text,settlement_calculation_run_id::text,ledger_event_id::text,excluded_refund_count,moved_amount_cents::text,after_json FROM teaching_mentor_relationship_change WHERE id=$1::uuid`,[published.changeId])).rows[0];
  assert.equal(change.excluded_refund_count,1);assert.equal(change.moved_amount_cents,moved.toString());assert.notEqual(change.continuation_relationship_id,null);assert.equal(change.after_json.continuationRelationship.id,change.continuation_relationship_id);
  const relationAudit=(await pool.query("SELECT id::text,related_person_id::text FROM person_relationship WHERE id=ANY($1::uuid[]) ORDER BY id",[[change.source_relationship_id,change.result_relationship_id]])).rows;
  assert.deepEqual(new Map(relationAudit.map(row=>[row.id,row.related_person_id])).get(change.source_relationship_id),ids.mentorA);
  assert.deepEqual(new Map(relationAudit.map(row=>[row.id,row.related_person_id])).get(change.result_relationship_id),ids.mentorB);
  const continuation=(await pool.query("SELECT related_person_id::text,valid_from::text,valid_to::text FROM person_relationship WHERE id=$1::uuid",[change.continuation_relationship_id])).rows[0];
  assert.equal(continuation.related_person_id,ids.mentorA);assert.equal(new Date(continuation.valid_from).toISOString(),"2026-09-27T16:00:00.000Z");assert.equal(new Date(continuation.valid_to).toISOString(),"2026-10-04T16:00:00.000Z");
  assert.equal((await pool.query("SELECT count(*)::int n FROM person_relationship current_relation JOIN person_relationship next_relation ON next_relation.teacher_id=current_relation.teacher_id AND next_relation.relationship_type=current_relation.relationship_type AND next_relation.id<>current_relation.id AND tstzrange(current_relation.valid_from,COALESCE(current_relation.valid_to,'infinity'),'[)') && tstzrange(next_relation.valid_from,COALESCE(next_relation.valid_to,'infinity'),'[)') WHERE current_relation.teacher_id=$1::uuid AND current_relation.superseded_at IS NULL AND next_relation.superseded_at IS NULL",[ids.teacher])).rows[0].n,0);
  assert.equal(after.next.context_json.relationships.teachingMentor.personId,ids.mentorA);
  const nextCorrected=await weekly.recordAndSettle(ids.teacher,{referralCaseId:ids.referralNext,teachingWeekId:ids.next,venueId:ids.venue,settlementMonth:"2026-09-01",grossAmountCents:100000n,expectedVersion:1},"tm-matrix-next-after-continuation");
  const nextResolved=await readLatest(pool,nextCorrected.fee.id);
  assert.notEqual(nextResolved.id,before.next.id);
  assert.equal(nextResolved.context_json.relationships.teachingMentor.personId,ids.mentorA);
  assert.equal(nextResolved.context_json.relationships.teachingMentor.id,change.continuation_relationship_id);
  const effects=(await pool.query(`SELECT weekly_fee_entry_id::text,previous_snapshot_id::text,result_snapshot_id::text,teaching_mentor_amount_cents::text,settlement_calculation_run_id::text,source_account_id::text,destination_account_id::text FROM teaching_mentor_relationship_change_effect WHERE change_id=$1::uuid`,[published.changeId])).rows;
  const accounts=(await pool.query("SELECT owner_id::text,id::text FROM settlement_account WHERE owner_type='PERSON' AND owner_id=ANY($1::uuid[])",[[ids.mentorA,ids.mentorB]])).rows;
  const accountFor=personId=>accounts.find(row=>row.owner_id===personId).id;
  assert.equal(effects.length,1);assert.deepEqual(effects[0],{weekly_fee_entry_id:current.fee.id,previous_snapshot_id:before.current.id,result_snapshot_id:after.current.id,teaching_mentor_amount_cents:moved.toString(),settlement_calculation_run_id:change.settlement_calculation_run_id,source_account_id:accountFor(ids.mentorA),destination_account_id:accountFor(ids.mentorB)});
  assert.equal((await pool.query("SELECT count(*)::int n FROM weekly_fee_allocation_snapshot WHERE run_id=$1::uuid",[change.settlement_calculation_run_id])).rows[0].n,1);
  const later=await service.preview(adminContext(ids.admin),{teacherPersonId:ids.teacher,newRelatedPersonId:ids.mentorB,effectiveTeachingWeekId:ids.next,reason:"同键冲突"},new Date("2026-09-28T04:00:00Z"));
  await assert.rejects(service.publish(adminContext(ids.admin),later.previewId,"tm-matrix-a-b-current",new Date("2026-09-28T04:00:00Z")),/IDEMPOTENCY_REPLAY/);
 }finally{await database.close();}
});

test("真实 PostgreSQL：候选任命变动使教学导师预览失效，竞争发布只写一个终态",async t=>{
 if(!connectionString)return t.skip("DATABASE_URL_REQUIRED");
 const database=await createTestDatabase(connectionString);
 try{
  const {pool}=database,ids=await seedSettlement(pool),weekly=new PostgresWeeklySettlementService(pool),service=new PostgresTeachingMentorRelationshipService(pool);
  await settle(weekly,ids,"tm-matrix-stale","referralCurrent","current");
  const stale=await service.preview(adminContext(ids.admin),{teacherPersonId:ids.teacher,newRelatedPersonId:ids.mentorB,effectiveTeachingWeekId:ids.current,reason:"候选资格变化必须失效"},at);
  await pool.query("UPDATE role_assignment SET valid_to='2026-09-20T15:00:00.000Z' WHERE id=$1::uuid",[ids.mentorBRole]);
  await assert.rejects(service.publish(adminContext(ids.admin),stale.previewId,"tm-matrix-stale",at),/RELATIONSHIP_PREVIEW_STALE/);
  assert.equal((await pool.query("SELECT count(*)::int n FROM teaching_mentor_relationship_change")).rows[0].n,0);
  await pool.query("UPDATE role_assignment SET valid_to=NULL WHERE id=$1::uuid",[ids.mentorBRole]);
  const preview=await service.preview(adminContext(ids.admin),{teacherPersonId:ids.teacher,newRelatedPersonId:ids.mentorB,effectiveTeachingWeekId:ids.current,reason:"并发发布必须串行"},at);
  const results=await Promise.allSettled([service.publish(adminContext(ids.admin),preview.previewId,"tm-matrix-concurrent-1",at),service.publish(adminContext(ids.admin),preview.previewId,"tm-matrix-concurrent-2",at)]);
  assert.equal(results.filter(result=>result.status==="fulfilled").length,1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM teaching_mentor_relationship_change WHERE preview_id=$1::uuid",[preview.previewId])).rows[0].n,1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM teaching_mentor_relationship_change_effect")).rows[0].n,1);
  assert.match(String(results.find(result=>result.status==="rejected")?.reason),/RELATIONSHIP_PREVIEW_ALREADY_PUBLISHED/);
 }finally{await database.close();}
});
