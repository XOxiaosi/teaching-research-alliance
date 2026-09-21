import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createTestDatabase} from './postgres-test-database.mjs';

test('到期任务独立进程执行、重复运行与失败退出码',async()=>{
 const db=await createTestDatabase(process.env.DATABASE_URL);
 const {pool}=db;
 const person=randomUUID(),student=randomUUID(),referral=randomUUID();
 try{
  await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES ($1,'独立任务合成人员','合成','ACTIVE')",[person]);
  await pool.query("INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name) VALUES ($1,$2,'任务课程','合成学生')",[student,person]);
  await pool.query("INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,unaccepted_expires_at) VALUES ($1,$2,$3,$3,'TEACHING_TEACHER','PENDING','2000-01-01','2000-01-22')",[referral,student,person]);
  const url=new URL(process.env.DATABASE_URL);
  url.searchParams.set('options',`-c search_path=${db.schemaName},public`);
  const worker=fileURLToPath(new URL('../../../worker/run-referral-expiry.mjs',import.meta.url));
  const run=()=>promisify(execFile)(process.execPath,[worker,'--once'],{env:{...process.env,DATABASE_URL:url.toString()},timeout:15000});
  const first=await run();
  assert.deepEqual(JSON.parse(first.stdout),{job:'REFERRAL_EXPIRY',archivedCount:1});
  assert.equal((await run()).stdout,'');
  const row=(await pool.query('SELECT status,version::text FROM referral_case WHERE id=$1',[referral])).rows[0];
  assert.deepEqual(row,{status:'ARCHIVED',version:'2'});
  const event=(await pool.query('SELECT actor_type,actor_person_id,reason FROM referral_case_event WHERE referral_case_id=$1',[referral])).rows;
  assert.deepEqual(event,[{actor_type:'SYSTEM',actor_person_id:null,reason:'UNACCEPTED_EXPIRED'}]);
  // A worker failure must be visible to its scheduler and must not log database details.
  await pool.query("UPDATE referral_case SET status='PENDING' WHERE id=$1",[referral]);
  await pool.query("CREATE FUNCTION fail_expiry_worker_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_DATABASE_DETAIL'; END; $$; CREATE TRIGGER fail_expiry_worker_fixture BEFORE UPDATE ON referral_case FOR EACH ROW EXECUTE FUNCTION fail_expiry_worker_fixture();");
  await assert.rejects(run(),error=>error.code===1 && error.stderr.trim()==='REFERRAL_EXPIRY_FAILED');
 }finally{await db.close();}
});
