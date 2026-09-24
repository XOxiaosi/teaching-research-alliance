import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTestDatabase} from './postgres-test-database.mjs';
import {PostgresReferralCreationService,PostgresSentReferralReadService,PostgresReferralAcceptanceService,PostgresReferralLifecycleService,createApiServer,SessionService} from '../../dist/main.js';
const at=new Date('2026-09-21T04:00:00Z');

test('推荐创建固定来源身份，同名独立、幂等并发且拒绝无效接收人',async()=>{
 const db=await createTestDatabase(process.env.DATABASE_URL);
 const {pool}=db;
 const [planner,teacher,mentor,campus,region]=Array.from({length:5},()=>randomUUID());
 try {
  for(const id of [planner,teacher,mentor])await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES ($1,$2,'合成人员','ACTIVE')",[id,`synthetic-${id}`]);
  await pool.query("INSERT INTO organization_unit(id,unit_type,name) VALUES ($1,'REGION','合成分区'),($2,'CAMPUS','合成校区')",[region,campus]);
  for(const [id,identity] of [[planner,'ACADEMIC_PLANNER'],[teacher,'TEACHING_TEACHER'],[mentor,'TEACHING_TEACHER']]){
   await pool.query("INSERT INTO teacher_profile(person_id,business_identity,employment_status) VALUES ($1,$2,'ACTIVE')",[id,identity]);
   await pool.query("INSERT INTO person_campus_assignment(person_id,campus_id,region_id,valid_from,created_by) VALUES ($1,$2,$3,'2026-01-01',$1)",[id,campus,region]);
  }
  await pool.query("INSERT INTO role_assignment(person_id,subject_code,scope_type,valid_from,created_by) VALUES ($1,'PLANNING_MENTOR','SELF','2026-01-01',$1)",[mentor]);
  const service=new PostgresReferralCreationService(pool);
  const context={personId:planner,subject:'ACADEMIC_PLANNER'};
  const draft={receiverPersonId:teacher,studentDisplayName:'同名学生',courseContextId:'数学',classType:'ONE_TO_ONE'};
  const results=await Promise.all(Array.from({length:4},()=>service.create(context,draft,'same-key',at)));
  assert.equal(new Set(results.map(r=>r.referralId)).size,1);
  assert.equal(results.filter(r=>!r.replay).length,1);
  const second=await service.create(context,draft,'another-key',at);
  assert.notEqual(second.studentRecordId,results[0].studentRecordId);
  await assert.rejects(service.create(context,{...draft,studentDisplayName:'另一个'},'same-key',at),/IDEMPOTENCY_REPLAY/);
  await assert.rejects(service.create(context,{...draft,receiverPersonId:planner},'bad-receiver',at),/RECEIVER_NOT_ACTIVE/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM teacher_student_record')).rows[0].n,2);
  const direct=await service.create({personId:mentor,subject:'TEACHING_TEACHER'},draft,'mentor-direct',at);
  const snap=(await pool.query('SELECT * FROM referral_creation_snapshot WHERE referral_case_id=$1',[direct.referralId])).rows[0];
  assert.equal(snap.source_subject,'PLANNING_MENTOR');
  assert.equal(snap.collector_person_id,teacher);
  await pool.query("UPDATE role_assignment SET valid_to=$2 WHERE person_id=$1",[mentor,at]);
  assert.equal((await pool.query('SELECT source_subject FROM referral_creation_snapshot WHERE referral_case_id=$1',[direct.referralId])).rows[0].source_subject,'PLANNING_MENTOR');
  await assert.rejects(pool.query("UPDATE referral_creation_snapshot SET source_subject='TEACHING_TEACHER' WHERE referral_case_id=$1",[direct.referralId]),/REFERRAL_CREATION_IMMUTABLE/);
  const record=(await pool.query('SELECT submitted_at,unaccepted_expires_at FROM referral_case WHERE id=$1',[direct.referralId])).rows[0];
  assert.equal(record.unaccepted_expires_at.getTime()-record.submitted_at.getTime(),21*86400000);
  const directory=await service.listReceivingTeachers(context);
  assert.equal(directory.some(r=>r.personId===planner),false);
  assert.ok(directory.every(r=>Object.keys(r).sort().join(',')==='nickname,personId'));
  assert.deepEqual(await service.listReceivingTeachers({personId:planner,subject:'TEACHER'}),directory);
  await assert.rejects(service.create({personId:planner,subject:'TEACHER'},draft,'basic-not-yet-authorized',at),/FORBIDDEN_SCOPE/);
  await assert.rejects(service.create({personId:teacher,subject:'REGION_FINANCE'},draft,'forbidden',at),/FORBIDDEN_SCOPE/);

  let sessionNumber=0;
  const sessions=new SessionService({accounts:[{accountId:'synthetic',personId:planner,phoneNormalized:'13800000000',credentialDigest:'synthetic',status:'ACTIVE'},{accountId:'synthetic-teacher',personId:teacher,phoneNormalized:'13800000001',credentialDigest:'synthetic',status:'ACTIVE'}],assignments:[{personId:planner,subject:'ACADEMIC_PLANNER',scope:'SELF',validFrom:new Date('2026-01-01')},{personId:teacher,subject:'TEACHING_TEACHER',scope:'SELF',validFrom:new Date('2026-01-01')}],sessionIdFactory:()=> ++sessionNumber===1?'synthetic-referral-token':'synthetic-teacher-token'});
  sessions.login('13800000000','synthetic',at);
  sessions.switchRole('synthetic-referral-token','ACADEMIC_PLANNER',at);
  const server=createApiServer({sessions,weeklyFees:{},referrals:service,sentReferrals:new PostgresSentReferralReadService(pool),referralAcceptance:new PostgresReferralAcceptanceService(pool),referralLifecycle:new PostgresReferralLifecycleService(pool),now:()=>at});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try {
    const url=`http://127.0.0.1:${server.address().port}/v1/referrals`;
    const post=body=>fetch(url,{method:'POST',headers:{authorization:'Bearer synthetic-referral-token','content-type':'application/json'},body:JSON.stringify(body)});
    for(const field of ['referrerPersonId','referrerIdentity','sourceSubject','campusId','planningMentorPersonId']) {
      assert.equal((await post({...draft,idempotencyKey:'forged', [field]:mentor})).status,400);
    }
    const response=await post({...draft,idempotencyKey:'http-created'});
    assert.equal(response.status,200);
    const result=(await response.json()).data;
    const saved=(await pool.query('SELECT referrer_person_id FROM referral_case WHERE id=$1',[result.referralId])).rows[0];
    assert.equal(saved.referrer_person_id,planner);
    const sentResponse=await fetch(`${url}/sent?personId=${mentor}`,{headers:{authorization:'Bearer synthetic-referral-token'}});
    assert.equal(sentResponse.status,200);
    const sent=(await sentResponse.json()).data;
    assert.equal(sent.length,3);
    assert.ok(sent.every(item=>item.sourceSubject==='ACADEMIC_PLANNER'));
    assert.equal(sent.some(item=>item.referralId===direct.referralId),false);
    assert.equal((await fetch(`${url}/sent`)).status,401);
    const copy=body=>fetch(`${url}/${result.referralId}/copy`,{method:'POST',headers:{authorization:'Bearer synthetic-referral-token','content-type':'application/json'},body:JSON.stringify(body)});
    const copyDraft={receiverPersonId:teacher,courseContextId:'另一课程',idempotencyKey:'http-copy'};
    for(const field of ['studentDisplayName','referrerPersonId','sourceSubject','campusId','status','venueId'])assert.equal((await copy({...copyDraft,[field]:'forged'})).status,400);
    const copiedResponse=await copy(copyDraft);
    assert.equal(copiedResponse.status,200);
    const copied=(await copiedResponse.json()).data;
    assert.equal(copied.copiedFromReferralId,result.referralId);
    assert.notEqual(copied.referralId,result.referralId);
    assert.notEqual(copied.studentRecordId,result.studentRecordId);
    assert.equal((await (await copy(copyDraft)).json()).data.replay,true);
    assert.equal((await copy({...copyDraft,courseContextId:draft.courseContextId,idempotencyKey:'same-target'})).status,400);
    const venueId=randomUUID();
    await pool.query("INSERT INTO venue(id,owner_person_id,name,status) VALUES ($1,$2,'HTTP合成场地','ACTIVE')",[venueId,teacher]);
    await pool.query("INSERT INTO settlement_account(owner_type,owner_id,account_code,status) VALUES ('VENUE',$1,$2,'ACTIVE')",[venueId,`venue:${venueId}`]);
    sessions.login('13800000001','synthetic',at);
    sessions.switchRole('synthetic-teacher-token','TEACHING_TEACHER',at);
    const accept=body=>fetch(`${url}/${result.referralId}/accept`,{method:'POST',headers:{authorization:'Bearer synthetic-teacher-token','content-type':'application/json'},body:JSON.stringify(body)});
    const acceptance={venueId,expectedVersion:1,idempotencyKey:'http-accept'};
    assert.equal((await accept({venueId,idempotencyKey:'missing-version'})).status,400);
    for(const field of ['personId','receiverPersonId','venueOwnerPersonId','isSelfUse','acceptedBy'])assert.equal((await accept({...acceptance,[field]:planner})).status,400);
    const accepted=await accept(acceptance);
    assert.equal(accepted.status,200);
    assert.equal((await accepted.json()).data.isSelfUse,true);
    assert.equal((await (await accept(acceptance)).json()).data.replay,true);
    assert.equal((await accept({...acceptance,idempotencyKey:'another-command'})).status,409);
    const lifecycle=(operation,body,token='synthetic-referral-token')=>fetch(`${url}/${result.referralId}/${operation}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});
    const archiveCommand={expectedVersion:2,idempotencyKey:'http-archive'};
    assert.equal((await lifecycle('archive',archiveCommand,'synthetic-teacher-token')).status,403);
    for(const field of ['status','actor','expiresAt','receiverPersonId','venueId'])assert.equal((await lifecycle('archive',{...archiveCommand,[field]:'forged'})).status,400);
    const archived=await lifecycle('archive',archiveCommand);
    assert.equal(archived.status,200);
    assert.equal((await archived.json()).data.version,3);
    const restored=await lifecycle('reactivate',{expectedVersion:3,idempotencyKey:'http-reactivate'});
    assert.equal(restored.status,200);
    assert.equal((await restored.json()).data.status,'REACTIVATED');
    const oldArchive=(await (await lifecycle('archive',archiveCommand)).json()).data;
    assert.equal(oldArchive.status,'ARCHIVED');
    assert.equal(oldArchive.version,3);
    assert.equal(oldArchive.replay,true);
    assert.equal((await (await accept(acceptance)).json()).data.version,2);
    assert.equal((await (await accept({...acceptance,expectedVersion:4,idempotencyKey:'accept-again'})).json()).data.version,5);
  }finally{await new Promise(resolve=>server.close(resolve));}
 }finally{await db.close();}
});
