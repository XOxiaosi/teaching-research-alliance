import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DEFAULT_RATE_POLICY_VALUES } from "@teaching-research-alliance/domain";
import { PostgresCampusRegionAssignmentService } from "../../dist/postgres-campus-region-assignment-service.js";
import { PostgresWeeklySettlementService } from "../../dist/postgres-weekly-settlement-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const connectionString=process.env.DATABASE_URL;
const context=(personId)=>({subject:"SYSTEM_ADMIN",personId,scope:"GLOBAL"});
const stringify=(value)=>JSON.stringify(value,(_key,item)=>typeof item==="bigint"?item.toString():item);
const seed=async(pool)=>{
  const ids=Object.fromEntries(["admin","one","two","hq","regionFinanceA","regionFinanceB","regionA","regionB","campus"].map(k=>[k,randomUUID()]));
  for(const k of ["admin","one","two","hq","regionFinanceA","regionFinanceB"])await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1,$2,$2,'ACTIVE')",[ids[k],`c2-${k}`]);
  await pool.query("INSERT INTO organization_unit(id,unit_type,name) VALUES($1,'REGION','A'),($2,'REGION','B'),($3,'CAMPUS','C')",[ids.regionA,ids.regionB,ids.campus]);
  await pool.query("INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('COMPANY',$1,$2,'ACTIVE')",[ids.campus,`company:${ids.campus}`]);
  await pool.query("INSERT INTO campus_region_assignment(campus_id,region_id,valid_from,created_by) VALUES($1,$2,'2026-01-01',$3)",[ids.campus,ids.regionA,ids.admin]);
  for(const k of ["one","two"]){await pool.query("INSERT INTO teacher_profile(person_id,business_identity,region_id,campus_id,employment_status) VALUES($1,'TEACHING_TEACHER',$2,$3,'ACTIVE')",[ids[k],ids.regionA,ids.campus]);await pool.query("INSERT INTO person_campus_assignment(person_id,campus_id,region_id,valid_from,created_by) VALUES($1,$2,$3,'2026-01-01',$4)",[ids[k],ids.campus,ids.regionA,ids.admin]);}
  for(const [index,key] of ["hq","regionFinanceA","regionFinanceB"].entries()){
    await pool.query("INSERT INTO user_account(person_id,phone_normalized,password_hash,login_status) VALUES($1,$2,'x','ACTIVE')",[ids[key],`1390000000${index}`]);
    await pool.query("INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('PERSON',$1,$2,'ACTIVE')",[ids[key],`person:${ids[key]}`]);
  }
  await pool.query("INSERT INTO role_assignment(person_id,subject_code,scope_type,scope_id,valid_from,created_by) VALUES($1,'SYSTEM_ADMIN','GLOBAL',NULL,'2026-01-01',$1),($2,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'2026-01-01',$1),($3,'REGION_FINANCE','REGION',$5,'2026-01-01',$1),($4,'REGION_FINANCE','REGION',$6,'2026-01-01',$1)",[ids.admin,ids.hq,ids.regionFinanceA,ids.regionFinanceB,ids.regionA,ids.regionB]);
  return ids;
};

const addSettledFee=async(pool,ids,receiverKey)=>{
  const more=Object.fromEntries(["planner","group","mentor","venue","year","period","week","student","referral"].map(k=>[k,randomUUID()]));
  for(const key of ["planner","group","mentor"]){
    await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1,$2,$2,'ACTIVE')",[more[key],`c2-fee-${key}-${receiverKey}`]);
    await pool.query("INSERT INTO user_account(person_id,phone_normalized,password_hash,login_status) VALUES($1,$2,'x','ACTIVE')",[more[key],`c2-${receiverKey}-${key}-${more[key]}`]);
    await pool.query("INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('PERSON',$1,$2,'ACTIVE')",[more[key],`person:${more[key]}`]);
  }
  const receiver=ids[receiverKey];
  await pool.query("INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('PERSON',$1,$2,'ACTIVE')",[receiver,`person:${receiver}`]);
  await pool.query("INSERT INTO teacher_profile(person_id,business_identity,region_id,campus_id,employment_status) VALUES($1,'ACADEMIC_PLANNER',$2,$3,'ACTIVE')",[more.planner,ids.regionA,ids.campus]);
  await pool.query("INSERT INTO person_campus_assignment(person_id,campus_id,region_id,valid_from,created_by) VALUES($1,$2,$3,'2026-01-01',$4)",[more.planner,ids.campus,ids.regionA,ids.admin]);
  await pool.query("INSERT INTO role_assignment(person_id,subject_code,scope_type,scope_id,valid_from,created_by) VALUES($1,'GROUP_LEADER','ASSOCIATED_TEACHERS',NULL,'2026-01-01',$3),($2,'TEACHING_MENTOR','MENTEES',NULL,'2026-01-01',$3)",[more.group,more.mentor,ids.admin]);
  await pool.query("INSERT INTO person_relationship(teacher_id,relationship_type,related_person_id,valid_from,effective_scope,created_by) VALUES($1,'GROUP_LEADER',$2,'2026-01-01','CURRENT',$4),($1,'TEACHING_MENTOR',$3,'2026-01-01','CURRENT',$4)",[receiver,more.group,more.mentor,ids.admin]);
  await pool.query("INSERT INTO venue(id,owner_person_id,name,status,default_for_owner) VALUES($1,$2,$3,'ACTIVE',true)",[more.venue,receiver,`c2-fee-venue-${receiverKey}`]);
  await pool.query("INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES('VENUE',$1,$2,'ACTIVE')",[more.venue,`venue:${more.venue}`]);
  await pool.query("INSERT INTO academic_year_plan(id,label,starts_on,ends_on,created_by) VALUES($1,'C2','2026-01-01','2026-12-31',$2)",[more.year,ids.admin]);
  await pool.query("INSERT INTO academic_period(id,academic_year_plan_id,label,starts_on,ends_on) VALUES($1,$2,'C2','2026-01-01','2026-12-31')",[more.period,more.year]);
  await pool.query("INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month) VALUES($1,$2,1,'REGULAR','2026-09-25','2026-10-01','2026-09-01')",[more.week,more.period]);
  await pool.query("INSERT INTO rate_policy_version(version,effective_from,policy_json,reason,published_by) VALUES(1,'2026-09-01',$1::jsonb,'c2',$2) ON CONFLICT DO NOTHING",[stringify(DEFAULT_RATE_POLICY_VALUES),ids.admin]);
  await pool.query("INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name) VALUES($1,$2,'c2','c2')",[more.student,receiver]);
  await pool.query("INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,version) VALUES($1,$2,$3,$4,'ACADEMIC_PLANNER','ACCEPTED','2026-09-01',1)",[more.referral,more.student,more.planner,receiver]);
  const assignment=(await pool.query("SELECT id::text FROM person_campus_assignment WHERE person_id=$1",[more.planner])).rows[0];
  await pool.query("INSERT INTO referral_creation_snapshot(referral_case_id,source_subject,business_identity_version,campus_assignment_id,campus_id,class_type,collector_person_id,created_by,created_at) VALUES($1,'ACADEMIC_PLANNER',1,$2,$3,'ONE_TO_ONE',$4,$5,'2026-09-01')",[more.referral,assignment.id,ids.campus,receiver,ids.admin]);
  const fee=await new PostgresWeeklySettlementService(pool).recordAndSettle(receiver,{referralCaseId:more.referral,teachingWeekId:more.week,venueId:more.venue,settlementMonth:"2026-09-01",grossAmountCents:100000n,expectedVersion:0},`c2-fee-${receiverKey}`);
  return {...more,feeId:fee.fee.id,receiverId:receiver};
};

test("真实 PostgreSQL：校区分区调整原子拆分所有人员、有限窗口恢复、审计与幂等",async(t)=>{
  if(!connectionString)return t.skip("DATABASE_URL_REQUIRED");
  const database=await createTestDatabase(connectionString);
  try{
    const ids=await seed(database.pool),service=new PostgresCampusRegionAssignmentService(database.pool),at=new Date("2026-09-20T00:00:00.000Z");
    const preview=await service.preview(context(ids.admin),{campusId:ids.campus,targetRegionId:ids.regionB,effectiveFrom:"2026-09-24T00:00:00.000Z",effectiveTo:"2026-10-01T00:00:00.000Z",reason:"临时区域调整"},at);
    assert.equal(preview.affectedPersonCount,2);assert.equal(preview.affectedAssignmentCount,2);assert.equal(preview.consideredFeeCount,0);
    const published=await service.publish(context(ids.admin),preview.previewId,"c2-finite",at);
    assert.equal(published.replay,false);assert.equal(published.consideredFeeCount,0);
    const replay=await service.publish(context(ids.admin),preview.previewId,"c2-finite",at);assert.equal(replay.replay,true);
    const histories=await database.pool.query("SELECT person_id::text,region_id::text,valid_from::text,valid_to::text FROM person_campus_assignment WHERE campus_id=$1::uuid ORDER BY person_id,valid_from",[ids.campus]);
    assert.equal(histories.rows.length,6);assert.equal(histories.rows.filter(x=>x.region_id===ids.regionB).length,2);assert.equal(histories.rows.filter(x=>new Date(x.valid_from).toISOString()==="2026-10-01T00:00:00.000Z").length,2);
    const regions=await database.pool.query("SELECT region_id::text,valid_from::text,valid_to::text FROM campus_region_assignment WHERE campus_id=$1::uuid ORDER BY valid_from",[ids.campus]);
    assert.equal(regions.rows.length,3);assert.equal(regions.rows[1].region_id,ids.regionB);assert.equal((await database.pool.query("SELECT count(*)::int n FROM campus_region_assignment_person_effect")).rows[0].n,2);
    assert.equal((await database.pool.query("SELECT count(*)::int n FROM audit_event WHERE action_code='CAMPUS_REGION_ASSIGNMENT_CHANGED'")).rows[0].n,1);
    await assert.rejects(service.publish(context(ids.admin),preview.previewId,"c2-other",at),/CAMPUS_REGION_PREVIEW_STALE/);
  }finally{await database.close();}
});

test("真实 PostgreSQL：两个冻结预览只有一个可发布，撤权后原键也不能重放",async(t)=>{
  if(!connectionString)return t.skip("DATABASE_URL_REQUIRED");
  const database=await createTestDatabase(connectionString);
  try{
    const ids=await seed(database.pool),service=new PostgresCampusRegionAssignmentService(database.pool),at=new Date("2026-09-20T00:00:00.000Z");
    const draft={campusId:ids.campus,targetRegionId:ids.regionB,effectiveFrom:"2026-09-24T00:00:00.000Z",reason:"分区变更并发保护"};
    const first=await service.preview(context(ids.admin),draft,at);
    const second=await service.preview(context(ids.admin),draft,at);
    const result=await service.publish(context(ids.admin),first.previewId,"first",at);
    assert.equal(result.replay,false);
    await assert.rejects(service.publish(context(ids.admin),second.previewId,"second",at),/CAMPUS_REGION_(ASSIGNMENT_NO_CHANGE|PREVIEW_STALE|ASSIGNMENT_SOURCE_INVALID)/);
    assert.equal((await database.pool.query("SELECT count(*)::int n FROM campus_region_assignment_change")).rows[0].n,1);
    await database.pool.query("UPDATE role_assignment SET valid_to='2026-09-19T00:00:00Z' WHERE person_id=$1 AND subject_code='SYSTEM_ADMIN'",[ids.admin]);
    await assert.rejects(service.publish(context(ids.admin),first.previewId,"first",at),/FORBIDDEN_SCOPE/);
    assert.equal((await database.pool.query("SELECT count(*)::int n FROM campus_region_assignment_change")).rows[0].n,1);
  }finally{await database.close();}
});

test("真实 PostgreSQL：已结算费用重算追加快照与分区结算 effect，退款费用在预览和发布均排除",async(t)=>{
  if(!connectionString)return t.skip("DATABASE_URL_REQUIRED");
  const database=await createTestDatabase(connectionString);
  try{
    const ids=await seed(database.pool),settled=await addSettledFee(database.pool,ids,"one"),refunded=await addSettledFee(database.pool,ids,"two");
    const at=new Date("2026-09-24T00:00:00.000Z"),refundDocumentId=randomUUID();
    const refundSnapshot=(await database.pool.query("SELECT id::text,snapshot_json FROM weekly_fee_allocation_snapshot WHERE weekly_fee_entry_id=$1 ORDER BY sequence_no DESC LIMIT 1",[refunded.feeId])).rows[0];
    await database.pool.query("INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at) VALUES($1,$2,'REFUND','REFUNDED',1,$3,$3)",[refundDocumentId,ids.two,at.toISOString()]);
    await database.pool.query("ALTER TABLE weekly_fee_refund_effect DISABLE TRIGGER USER");
    try{await database.pool.query("INSERT INTO weekly_fee_refund_effect(weekly_fee_entry_id,finance_document_id,allocation_snapshot_id,source_weekly_fee_version,gross_amount_cents,snapshot_json,created_at) SELECT $1,$2,$3,version,gross_amount_cents,$4::jsonb,$5 FROM weekly_fee_entry WHERE id=$1",[refunded.feeId,refundDocumentId,refundSnapshot.id,JSON.stringify(refundSnapshot.snapshot_json),at.toISOString()]);}
    finally{await database.pool.query("ALTER TABLE weekly_fee_refund_effect ENABLE TRIGGER USER");}
    const beforeSnapshots=(await database.pool.query("SELECT count(*)::int n FROM weekly_fee_allocation_snapshot WHERE weekly_fee_entry_id IN ($1,$2)",[settled.feeId,refunded.feeId])).rows[0].n;
    const relationships=(await database.pool.query("SELECT teacher_id::text,relationship_type,related_person_id::text,valid_from::text,valid_to::text FROM person_relationship WHERE teacher_id IN ($1,$2) ORDER BY teacher_id,relationship_type",[ids.one,ids.two])).rows;
    const venues=(await database.pool.query("SELECT owner_person_id::text,name,status,default_for_owner FROM venue WHERE owner_person_id IN ($1,$2) ORDER BY owner_person_id",[ids.one,ids.two])).rows;
    const service=new PostgresCampusRegionAssignmentService(database.pool),preview=await service.preview(context(ids.admin),{campusId:ids.campus,targetRegionId:ids.regionB,effectiveFrom:"2026-09-24T00:00:00.000Z",reason:"已结算费用分区调整"},at);
    assert.equal(preview.consideredFeeCount,2);assert.equal(preview.changedFeeCount,1);assert.equal(preview.excludedRefundCount,1);
    assert.equal(preview.organizationImpact.recordedGrossRevenueCents,"200000");assert.equal(preview.organizationImpact.refundedGrossRevenueCents,"100000");assert.equal(preview.organizationImpact.effectiveGrossRevenueCents,"100000");
    assert.equal(preview.organizationImpact.sourceRegionId,ids.regionA);assert.equal(preview.organizationImpact.targetRegionId,ids.regionB);assert.ok(preview.accountDeltas.length>0);
    const published=await service.publish(context(ids.admin),preview.previewId,"c2-fee-region",at);
    assert.equal(published.postingStatus,"POSTED");assert.equal(published.consideredFeeCount,2);assert.equal(published.changedFeeCount,1);assert.equal(published.excludedRefundCount,1);
    const change=(await database.pool.query("SELECT id::text,posting_status,considered_fee_count,changed_fee_count,excluded_refund_count,settlement_calculation_run_id::text,ledger_event_id::text FROM campus_region_assignment_change WHERE preview_id=$1",[preview.previewId])).rows[0];
    assert.equal(change.posting_status,"POSTED");assert.equal(change.considered_fee_count,2);assert.equal(change.changed_fee_count,1);assert.equal(change.excluded_refund_count,1);assert.ok(change.settlement_calculation_run_id);
    assert.equal((await database.pool.query("SELECT count(*)::int n FROM campus_region_assignment_settlement_effect WHERE change_id=$1",[change.id])).rows[0].n,1);
    assert.equal((await database.pool.query("SELECT count(*)::int n FROM weekly_fee_allocation_snapshot WHERE weekly_fee_entry_id=$1",[settled.feeId])).rows[0].n,2);
    assert.equal((await database.pool.query("SELECT count(*)::int n FROM weekly_fee_allocation_snapshot WHERE weekly_fee_entry_id=$1",[refunded.feeId])).rows[0].n,1);
    assert.equal((await database.pool.query("SELECT count(*)::int n FROM weekly_fee_allocation_snapshot WHERE weekly_fee_entry_id IN ($1,$2)",[settled.feeId,refunded.feeId])).rows[0].n,beforeSnapshots+1);
    assert.deepEqual((await database.pool.query("SELECT teacher_id::text,relationship_type,related_person_id::text,valid_from::text,valid_to::text FROM person_relationship WHERE teacher_id IN ($1,$2) ORDER BY teacher_id,relationship_type",[ids.one,ids.two])).rows,relationships);
    assert.deepEqual((await database.pool.query("SELECT owner_person_id::text,name,status,default_for_owner FROM venue WHERE owner_person_id IN ($1,$2) ORDER BY owner_person_id",[ids.one,ids.two])).rows,venues);
    const latest=(await database.pool.query("SELECT context_json FROM weekly_fee_allocation_snapshot WHERE weekly_fee_entry_id=$1 ORDER BY sequence_no DESC LIMIT 1",[settled.feeId])).rows[0].context_json;
    assert.equal(latest.organization.receiverCampusAssignment.campus_id,ids.campus);
    assert.equal(latest.organization.receiverCampusAssignment.region_id,ids.regionB);
    const resultSnapshot=(await database.pool.query("SELECT run_id::text,weekly_fee_entry_id::text,source_weekly_fee_version,policy_version_id::text,net_monthly_cents,snapshot_json,context_json FROM weekly_fee_allocation_snapshot WHERE weekly_fee_entry_id=$1 ORDER BY sequence_no DESC LIMIT 1",[settled.feeId])).rows[0];
    await assert.rejects(database.pool.query("INSERT INTO weekly_fee_allocation_snapshot(id,run_id,weekly_fee_entry_id,source_weekly_fee_version,policy_version_id,net_monthly_cents,snapshot_json,context_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)",[randomUUID(),resultSnapshot.run_id,resultSnapshot.weekly_fee_entry_id,resultSnapshot.source_weekly_fee_version,resultSnapshot.policy_version_id,resultSnapshot.net_monthly_cents,JSON.stringify(resultSnapshot.snapshot_json),JSON.stringify(resultSnapshot.context_json),at.toISOString()]),/CAMPUS_REGION_ASSIGNMENT_CHANGE_TERMINAL_IMMUTABLE/);
    const unusedAccount=(await database.pool.query("SELECT id::text FROM settlement_account WHERE owner_id=$1",[ids.hq])).rows[0].id;
    await assert.rejects(database.pool.query("INSERT INTO ledger_entry(event_id,account_id,category_key,amount_cents,created_at) VALUES($1,$2,$3,1,$4)",[change.ledger_event_id,unusedAccount,`terminal-probe-${randomUUID()}`,at.toISOString()]),/CAMPUS_REGION_ASSIGNMENT_CHANGE_TERMINAL_IMMUTABLE/);
  }finally{await database.close();}
});

test("真实 PostgreSQL：直接 SQL 省略未退款费用 effect 时，0041 延迟结算审计拒绝提交并整体回滚",async(t)=>{
  if(!connectionString)return t.skip("DATABASE_URL_REQUIRED");
  const database=await createTestDatabase(connectionString);
  try{
    const ids=await seed(database.pool),settled=await addSettledFee(database.pool,ids,"one"),at=new Date("2026-09-24T00:00:00.000Z");
    assert.ok(settled.feeId);
    const service=new PostgresCampusRegionAssignmentService(database.pool),preview=await service.preview(context(ids.admin),{campusId:ids.campus,targetRegionId:ids.regionB,effectiveFrom:"2026-09-24T00:00:00.000Z",reason:"省略结算 effect 攻击"},at);
    assert.equal(preview.consideredFeeCount,1);
    const tamperedPool={connect:async()=>{
      const client=await database.pool.connect();
      return {query:async(text,params)=>typeof text==="string"&&text.startsWith("INSERT INTO campus_region_assignment_settlement_effect")?{rows:[],rowCount:0}:client.query(text,params),release:()=>client.release()};
    }};
    await assert.rejects(new PostgresCampusRegionAssignmentService(tamperedPool).publish(context(ids.admin),preview.previewId,"c2-missing-effect",at),/CAMPUS_REGION_ASSIGNMENT_CHANGE_SETTLEMENT_SCOPE_INVALID/);
    assert.equal((await database.pool.query("SELECT count(*)::int n FROM campus_region_assignment_change")).rows[0].n,0);
    assert.equal((await database.pool.query("SELECT region_id::text FROM campus_region_assignment WHERE campus_id=$1 AND valid_to IS NULL",[ids.campus])).rows[0].region_id,ids.regionA);
  }finally{await database.close();}
});

test("真实 PostgreSQL：复用旧分区快照或伪造空差额时，0041 重算审计拒绝提交",async(t)=>{
  if(!connectionString)return t.skip("DATABASE_URL_REQUIRED");
  const database=await createTestDatabase(connectionString);
  try{
    const ids=await seed(database.pool),settled=await addSettledFee(database.pool,ids,"one"),at=new Date("2026-09-24T00:00:00.000Z");
    const previous=(await database.pool.query("SELECT snapshot_json,context_json FROM weekly_fee_allocation_snapshot WHERE weekly_fee_entry_id=$1 ORDER BY sequence_no DESC LIMIT 1",[settled.feeId])).rows[0];
    const tamperedPool=(reuseOldSnapshot)=>({connect:async()=>{
      const client=await database.pool.connect();
      return {query:async(text,params)=>{
        if(typeof text==="string"&&text.startsWith("INSERT INTO weekly_fee_allocation_snapshot")&&reuseOldSnapshot){
          const changed=[...params];changed[6]=JSON.stringify(previous.snapshot_json);changed[7]=JSON.stringify(previous.context_json);return client.query(text,changed);
        }
        if(typeof text==="string"&&text.startsWith("INSERT INTO campus_region_assignment_settlement_effect")){
          const changed=[...params];if(!reuseOldSnapshot)changed[8]=JSON.stringify({entries:[]});
          const inserted=await client.query(text,changed);
          await client.query("SET CONSTRAINTS campus_region_assignment_settlement_effect_parent_complete IMMEDIATE");
          return inserted;
        }
        return client.query(text,params);
      },release:()=>client.release()};
    }});
    const service=new PostgresCampusRegionAssignmentService(database.pool);
    const staleSnapshotPreview=await service.preview(context(ids.admin),{campusId:ids.campus,targetRegionId:ids.regionB,effectiveFrom:"2026-09-24T00:00:00.000Z",reason:"伪造旧分区快照"},at);
    await assert.rejects(new PostgresCampusRegionAssignmentService(tamperedPool(true)).publish(context(ids.admin),staleSnapshotPreview.previewId,"c2-stale-snapshot",at),/CAMPUS_REGION_ASSIGNMENT_CHANGE_EFFECT_(CONTEXT_INVALID|TARGET_INVALID|DELTA_MISMATCH)/);
    const emptyDeltaPreview=await service.preview(context(ids.admin),{campusId:ids.campus,targetRegionId:ids.regionB,effectiveFrom:"2026-09-24T00:00:00.000Z",reason:"伪造空结算差额"},at);
    await assert.rejects(new PostgresCampusRegionAssignmentService(tamperedPool(false)).publish(context(ids.admin),emptyDeltaPreview.previewId,"c2-empty-delta",at),/CAMPUS_REGION_ASSIGNMENT_CHANGE_EFFECT_DELTA_MISMATCH/);
    assert.equal((await database.pool.query("SELECT count(*)::int n FROM campus_region_assignment_change")).rows[0].n,0);
    assert.equal((await database.pool.query("SELECT count(*)::int n FROM settlement_calculation_run WHERE request_key LIKE 'campus-region-change:%'")).rows[0].n,0);
  }finally{await database.close();}
});

test("真实 PostgreSQL：人员历史带 campus-region change marker 但省略 person effect 时，0041 延迟审计拒绝提交",async(t)=>{
  if(!connectionString)return t.skip("DATABASE_URL_REQUIRED");
  const database=await createTestDatabase(connectionString),client=await database.pool.connect();
  try{
    const ids=await seed(database.pool),changeId=randomUUID(),previewId=randomUUID(),resultAssignmentId=randomUUID(),sourceAssignment=(await database.pool.query("SELECT id::text FROM campus_region_assignment WHERE campus_id=$1",[ids.campus])).rows[0].id,personAssignment=(await database.pool.query("SELECT id::text FROM person_campus_assignment WHERE person_id=$1",[ids.one])).rows[0].id,actorRole=(await database.pool.query("SELECT id::text FROM role_assignment WHERE person_id=$1 AND subject_code='SYSTEM_ADMIN'",[ids.admin])).rows[0].id,now="2026-09-24T00:00:00.000Z";
    await client.query("BEGIN");
    await client.query("INSERT INTO campus_region_assignment_change_preview(id,campus_id,source_region_id,target_region_id,source_assignment_id,effective_from,reason,base_hash,impact_json,actor_role_assignment_id,created_by_person_id,actor_subject_code,actor_scope_type,created_at) VALUES($1,$2,$3,$4,$5,$6,'伪造 marker 审计',$7,'{}'::jsonb,$8,$9,'SYSTEM_ADMIN','GLOBAL',$6)",[previewId,ids.campus,ids.regionA,ids.regionB,sourceAssignment,now,"a".repeat(64),actorRole,ids.admin]);
    await client.query("UPDATE campus_region_assignment SET valid_to=$2,superseded_by_campus_region_change_id=$3 WHERE id=$1",[sourceAssignment,now,changeId]);
    await client.query("INSERT INTO campus_region_assignment(id,campus_id,region_id,valid_from,created_by,created_at,campus_region_change_id) VALUES($1,$2,$3,$4,$5,$6,$7)",[resultAssignmentId,ids.campus,ids.regionB,now,ids.admin,now,changeId]);
    await client.query("UPDATE person_campus_assignment SET valid_to=$2,superseded_by_campus_region_change_id=$3 WHERE id=$1",[personAssignment,now,changeId]);
    await client.query("INSERT INTO campus_region_assignment_change(id,preview_id,campus_id,source_region_id,target_region_id,source_assignment_id,result_assignment_id,assignment_version,effective_from,reason,idempotency_key,request_hash,base_hash,posting_status,considered_person_count,affected_assignment_count,considered_fee_count,changed_fee_count,excluded_refund_count,before_json,after_json,published_by_person_id,actor_subject_code,actor_scope_type,published_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,'伪造 marker 审计','fake-0041',$9,$9,'NO_BALANCE_CHANGE',0,0,0,0,0,'{}'::jsonb,'{}'::jsonb,$10,'SYSTEM_ADMIN','GLOBAL',$8,$8)",[changeId,previewId,ids.campus,ids.regionA,ids.regionB,sourceAssignment,resultAssignmentId,now,"b".repeat(64),ids.admin]);
    await client.query("INSERT INTO audit_event(actor_person_id,action_code,subject_type,subject_id,before_json,after_json,reason,created_at) VALUES($1,'CAMPUS_REGION_ASSIGNMENT_CHANGED','CAMPUS_REGION_ASSIGNMENT_CHANGE',$2,'{}'::jsonb,'{}'::jsonb,'伪造 marker 审计',$3)",[ids.admin,changeId,now]);
    await assert.rejects(client.query("COMMIT"),/CAMPUS_REGION_ASSIGNMENT_CHANGE_DUAL_SOURCE_INVALID/);
  }finally{await client.query("ROLLBACK").catch(()=>{});client.release();await database.close();}
});
