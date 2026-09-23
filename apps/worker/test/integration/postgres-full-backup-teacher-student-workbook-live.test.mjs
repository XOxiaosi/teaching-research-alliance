import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { createTestDatabase } from "../../../api/test/integration/postgres-test-database.mjs";
import { FullBackupStudentWorkbookExporter } from "../../dist/full-backup-student-workbook-exporter.js";
import { FullBackupTeacherWorkbookExporter } from "../../dist/full-backup-teacher-workbook-exporter.js";
import { FullBackupSpool } from "../../dist/full-backup-spool.js";
import { FullBackupTransformer } from "../../dist/full-backup-transformer.js";
import { PostgresFullBackupSource } from "../../dist/postgres-full-backup-source.js";

const run = promisify(execFile);
const at = "2026-09-21T09:00:00.000Z";
const addPerson = (pool, id, nickname, status = "ACTIVE") => pool.query(
  "INSERT INTO person(id,nickname,legal_name,status,created_at,updated_at) VALUES($1::uuid,$2,$3,$4,$5::timestamptz,$5::timestamptz)", [id, nickname, "合成姓名", status, at],
);
const workbookSheets = async (workbook) => {
  const { stdout } = await run("python3", ["-c", `import zipfile,xml.etree.ElementTree as E,json,sys
z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None
ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
b=E.fromstring(z.read('xl/workbook.xml'));rels=E.fromstring(z.read('xl/_rels/workbook.xml.rels'));t={r.attrib['Id']:r.attrib['Target'] for r in rels};out={}
for s in b.findall('.//m:sheet',ns):
 root=E.fromstring(z.read('xl/'+t[s.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]))
 rows=[]
 for row in root.findall('.//m:row',ns): rows.append([(c.find('.//m:t',ns).text or '') for c in row.findall('m:c',ns)])
 out[s.attrib['name']]=rows
print(json.dumps(out,ensure_ascii=False))`, workbook]);
  return JSON.parse(stdout);
};
const sourceSheet = (sheets, prefix, index) => Object.entries(sheets).find(([name]) => name.startsWith(`${prefix}_${String(index).padStart(2, "0")}_`))?.[1];
const createSpool = async (pool, root) => new FullBackupSpool({
  source: new PostgresFullBackupSource(pool),
  transformer: new FullBackupTransformer({ fingerprint: ({ domain, value }) => createHash("sha256").update(`${domain}:${value}`).digest("hex") }),
  tempRoot: join(root, "spool"), batchSize: 1,
}).create();

test("real PG table-1 teacher XLSX preserves independent declared facts, NULL and long text while excluding account secrets", async () => {
  const database = await createTestDatabase(process.env.DATABASE_URL); const root = await mkdtemp(join(tmpdir(), "alliance-teacher-workbook-pg-"));
  try {
    const teacher = randomUUID(), leader = randomUUID(), region = randomUUID(), campus = randomUUID(), venue = randomUUID();
    const longNickname = `教师-${"甲".repeat(33_000)}`;
    await addPerson(database.pool, teacher, longNickname, "INACTIVE"); await addPerson(database.pool, leader, "负责人");
    await database.pool.query("INSERT INTO user_account(id,person_id,phone_normalized,password_hash,login_status,created_at,updated_at) VALUES($1::uuid,$2::uuid,'13800000071','$argon2id$secret-never-exported','REVOKED',$3::timestamptz,$3::timestamptz)", [randomUUID(), teacher, at]);
    await database.pool.query("INSERT INTO organization_unit(id,unit_type,name,parent_id,created_at) VALUES($1::uuid,'REGION','真实区域',NULL,$3::timestamptz),($2::uuid,'CAMPUS','真实校区',$1::uuid,$3::timestamptz)", [region, campus, at]);
    await database.pool.query("INSERT INTO teacher_profile(person_id,business_identity,region_id,campus_id,employment_status,created_at,updated_at) VALUES($1::uuid,'TEACHING_TEACHER',$2::uuid,NULL,'INACTIVE',$3::timestamptz,$3::timestamptz)", [teacher, region, at]);
    await database.pool.query("INSERT INTO person_campus_assignment(id,person_id,campus_id,region_id,valid_from,created_by,created_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::timestamptz,$2::uuid,$5::timestamptz)", [randomUUID(), teacher, campus, region, at]);
    await database.pool.query("INSERT INTO role_assignment(id,person_id,subject_code,scope_type,scope_id,valid_from,created_by,created_at) VALUES($1::uuid,$2::uuid,'TEACHING_TEACHER','SELF',NULL,$3::timestamptz,$2::uuid,$3::timestamptz)", [randomUUID(), teacher, at]);
    await database.pool.query("INSERT INTO person_relationship(id,teacher_id,relationship_type,related_person_id,valid_from,created_by,created_at) VALUES($1::uuid,$2::uuid,'GROUP_LEADER',$3::uuid,$4::timestamptz,$2::uuid,$4::timestamptz)", [randomUUID(), teacher, leader, at]);
    await database.pool.query("INSERT INTO venue(id,owner_person_id,name,status,created_at,updated_at) VALUES($1::uuid,$2::uuid,'真实场地','ACTIVE',$3::timestamptz,$3::timestamptz)", [venue, teacher, at]);
    await database.pool.query("INSERT INTO venue_permission_grant(id,venue_id,grantee_person_id,can_view,can_withdraw,valid_from,granted_by,created_at) VALUES($1::uuid,$2::uuid,$3::uuid,true,true,$4::timestamptz,$3::uuid,$4::timestamptz)", [randomUUID(), venue, teacher, at]);
    await database.pool.query("INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status,created_at) VALUES($1::uuid,'PERSON',$2::uuid,'teacher-account-001','INACTIVE',$3::timestamptz)", [randomUUID(), teacher, at]);
    const spool = await createSpool(database.pool, root);
    const result = await new FullBackupTeacherWorkbookExporter({ spoolDirectory: join(root, "spool", spool.spoolId), spool, outputRoot: join(root, "out"), maxDataRows: 1 }).export();
    assert.equal(result.complete, false); assert.deepEqual(result.coveredTables, [1]); assert.equal(result.file, "business-table-1-teacher-facts.xlsx");
    const sheets = await workbookSheets(join(root, "out", result.outputId, result.file));
    assert.equal(sheets["00_说明"].some((row) => row[0] === "完整备份" && row[1] === "false"), true);
    assert.equal(sheets["00_说明"].some((row) => row[0] === "完整关联来源" && row[1].includes("user_account 不含密码")), true);
    const personRows = sourceSheet(sheets, "T1", 1); assert.ok(personRows); assert.equal(personRows[0].includes("教师昵称 [nickname]"), true);
    assert.equal(JSON.stringify(sheets).includes("secret-never-exported"), false);
    assert.equal(Object.entries(sheets).filter(([name]) => name.startsWith("14_长文本")).some(([, rows]) => rows.length > 1), true);
    assert.equal(Object.entries(sheets).filter(([name]) => name.startsWith("15_NULL坐标")).some(([, rows]) => rows.some((row) => row.includes("campus_id"))), true);
    assert.equal(result.sourceRows.find((source) => source.sourceTable === "person")?.rowCount, "2");
  } finally { await rm(root, { recursive: true, force: true }); await database.close(); }
});

test("real PG table-2 student XLSX preserves separate student, referral-acceptance composite key and weekly-fee version facts", async () => {
  const database = await createTestDatabase(process.env.DATABASE_URL); const root = await mkdtemp(join(tmpdir(), "alliance-student-workbook-pg-"));
  try {
    const teacher = randomUUID(), studentRecord = randomUUID(), studentRecordTwo = randomUUID(), referral = randomUUID(), referralTwo = randomUUID(), venue = randomUUID(), year = randomUUID(), period = randomUUID(), week = randomUUID(), fee = randomUUID();
    await addPerson(database.pool, teacher, "学生流水老师");
    await database.pool.query("INSERT INTO venue(id,owner_person_id,name,status,created_at,updated_at) VALUES($1::uuid,$2::uuid,'学生流水场地','ACTIVE',$3::timestamptz,$3::timestamptz)", [venue, teacher, at]);
    await database.pool.query("INSERT INTO academic_year_plan(id,label,starts_on,ends_on,created_by,created_at) VALUES($1::uuid,'2026学年','2026-09-01','2027-08-31',$2::uuid,$3::timestamptz)", [year, teacher, at]);
    await database.pool.query("INSERT INTO academic_period(id,academic_year_plan_id,label,starts_on,ends_on,created_at) VALUES($1::uuid,$2::uuid,'秋季','2026-09-01','2026-12-31',$3::timestamptz)", [period, year, at]);
    await database.pool.query("INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month,created_at) VALUES($1::uuid,$2::uuid,1,'REGULAR','2026-09-01','2026-09-07','2026-09-01',$3::timestamptz)", [week, period, at]);
    await database.pool.query("INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name,created_at,updated_at) VALUES($1::uuid,$2::uuid,'course-independent-a','同名独立学生',$3::timestamptz,$3::timestamptz),($4::uuid,$2::uuid,'course-independent-b','同名独立学生',$3::timestamptz,$3::timestamptz)", [studentRecord, teacher, at, studentRecordTwo]);
    await database.pool.query("INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,version,created_at,updated_at) VALUES($1::uuid,$2::uuid,$3::uuid,$3::uuid,'TEACHING_TEACHER','ACCEPTED',$4::timestamptz,2,$4::timestamptz,$4::timestamptz)", [referral, studentRecord, teacher, at]);
    await database.pool.query("INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,version,created_at,updated_at) VALUES($1::uuid,$2::uuid,$3::uuid,$3::uuid,'TEACHING_TEACHER','ACCEPTED',$4::timestamptz,3,$4::timestamptz,$4::timestamptz)", [referralTwo, studentRecordTwo, teacher, at]);
    await database.pool.query("INSERT INTO referral_acceptance_snapshot(referral_case_id,venue_id,venue_owner_person_id,is_self_use,selection_source,accepted_referral_version,accepted_by_person_id,accepted_at) VALUES($1::uuid,$2::uuid,$3::uuid,true,'EXPLICIT',2,$3::uuid,$4::timestamptz)", [referral, venue, teacher, at]);
    await database.pool.query("INSERT INTO referral_acceptance_snapshot(referral_case_id,venue_id,venue_owner_person_id,is_self_use,selection_source,accepted_referral_version,accepted_by_person_id,accepted_at) VALUES($1::uuid,$2::uuid,$3::uuid,false,'EXPLICIT',3,$3::uuid,$4::timestamptz)", [referralTwo, venue, teacher, at]);
    await database.pool.query("INSERT INTO weekly_fee_entry(id,referral_case_id,teaching_week_id,settlement_month,gross_amount_cents,venue_id,venue_owner_person_id,is_self_use_snapshot,source_case_version,version,created_by,created_at,updated_at) VALUES($1::uuid,$2::uuid,$3::uuid,'2026-09-01',12345,$4::uuid,$5::uuid,true,2,1,$5::uuid,$6::timestamptz,$6::timestamptz)", [fee, referral, week, venue, teacher, at]);
    await database.pool.query("INSERT INTO weekly_fee_event(id,weekly_fee_entry_id,event_type,actor_person_id,reason,created_at) VALUES($1::uuid,$2::uuid,'CREATED',$3::uuid,'真实周费',$4::timestamptz)", [randomUUID(), fee, teacher, at]);
    const spool = await createSpool(database.pool, root);
    const result = await new FullBackupStudentWorkbookExporter({ spoolDirectory: join(root, "spool", spool.spoolId), spool, outputRoot: join(root, "out") }).export();
    assert.equal(result.complete, false); assert.deepEqual(result.coveredTables, [2]); assert.equal(result.file, "business-table-2-student-facts.xlsx");
    const sheets = await workbookSheets(join(root, "out", result.outputId, result.file));
    assert.equal(sheets["00_说明"].some((row) => row[0] === "完整备份" && row[1] === "false"), true);
    assert.equal(sheets["00_说明"].some((row) => row[0] === "完整关联来源" && row[1].includes("不按学生名合并")), true);
    const students = sourceSheet(sheets, "T2", 1); assert.ok(students); assert.equal(students.length, 3);
    assert.deepEqual(students.slice(1).map((row) => row[0]).sort(), [`[["id","${studentRecord}"]]`, `[["id","${studentRecordTwo}"]]`].sort());
    const acceptance = sourceSheet(sheets, "T2", 3); assert.ok(acceptance); assert.equal(acceptance.length, 3);
    assert.equal(acceptance.some((row) => row[0] === `[["referral_case_id","${referral}"],["accepted_referral_version","2"]]`), true);
    assert.equal(acceptance.some((row) => row[0] === `[["referral_case_id","${referralTwo}"],["accepted_referral_version","3"]]`), true);
    const feeVersions = sourceSheet(sheets, "T2", 5); assert.ok(feeVersions); assert.equal(feeVersions.length, 2); assert.equal(feeVersions[0].includes("课时费版本号 [version]"), true);
    assert.equal(result.sourceRows.find((source) => source.sourceTable === "teacher_student_record")?.rowCount, "2");
    assert.equal(result.sourceRows.find((source) => source.sourceTable === "referral_acceptance_snapshot")?.rowCount, "2");
    assert.equal(result.sourceRows.find((source) => source.sourceTable === "weekly_fee_entry_version")?.rowCount, "1");
  } finally { await rm(root, { recursive: true, force: true }); await database.close(); }
});
