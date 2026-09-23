import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PostgresGroupLeaderDirectoryService } from "../../dist/postgres-group-leader-directory-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const at = new Date("2026-09-23T12:00:00.000Z");
const addPerson = (pool, id, nickname, status = "ACTIVE") => pool.query(
  "INSERT INTO person(id,nickname,legal_name,status,created_at,updated_at) VALUES($1::uuid,$2,$2,$3,$4,$4)",
  [id, nickname, status, at.toISOString()],
);
const global = (personId, subject = "SYSTEM_OWNER", extra = {}) => ({ personId, subject, scope: "GLOBAL", ...extra });

test("组长关系目录以真实 GLOBAL 任职读取教学老师和所有当前普通周，并只投影安全字段", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  try {
    const ids = { owner: randomUUID(), teacher: randomUUID(), planner: randomUUID(), inactive: randomUUID(), week: randomUUID(), special: randomUUID(), period: randomUUID(), year: randomUUID() };
    await addPerson(db.pool, ids.owner, "目录所有者");
    await addPerson(db.pool, ids.teacher, "Alpha教师");
    await addPerson(db.pool, ids.planner, "Beta规划师");
    await addPerson(db.pool, ids.inactive, "Gamma停用", "INACTIVE");
    await db.pool.query("INSERT INTO role_assignment(person_id,subject_code,scope_type,valid_from,created_by,created_at) VALUES($1::uuid,'SYSTEM_OWNER','GLOBAL',$2::timestamptz,$1::uuid,$2::timestamptz)", [ids.owner, at.toISOString()]);
    await db.pool.query("INSERT INTO teacher_profile(person_id,business_identity,employment_status) VALUES($1::uuid,'TEACHING_TEACHER','ACTIVE'),($2::uuid,'ACADEMIC_PLANNER','ACTIVE'),($3::uuid,'TEACHING_TEACHER','ACTIVE')", [ids.teacher, ids.planner, ids.inactive]);
    await db.pool.query("INSERT INTO academic_year_plan(id,label,starts_on,ends_on,created_by,created_at) VALUES($1::uuid,'目录学年','2026-09-01','2027-08-31',$2::uuid,$3::timestamptz)", [ids.year, ids.owner, at.toISOString()]);
    await db.pool.query("INSERT INTO academic_period(id,academic_year_plan_id,label,starts_on,ends_on,created_at) VALUES($1::uuid,$2::uuid,'目录学期','2026-09-01','2026-12-31',$3::timestamptz)", [ids.period, ids.year, at.toISOString()]);
    await db.pool.query("INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month,status,created_at) VALUES($1::uuid,$2::uuid,1,'REGULAR','2026-09-21','2026-09-27','2026-09-01','OPEN',$3::timestamptz),($4::uuid,$2::uuid,2,'SUMMER_SPECIAL','2026-09-21','2026-09-27','2026-09-01','OPEN',$3::timestamptz)", [ids.week, ids.period, at.toISOString(), ids.special]);
    const calls = [];
    const directory = new PostgresGroupLeaderDirectoryService(db.pool, { listCandidates: async (context, receivedAt) => {
      calls.push([context, receivedAt]); return [{ personId: ids.owner, nickname: "组长候选" }];
    }});
    const result = await directory.list(global(ids.owner), at);
    assert.deepEqual(result.groupLeaders, [{ personId: ids.owner, nickname: "组长候选" }]);
    assert.deepEqual(result.teachers, [{ personId: ids.teacher, nickname: "Alpha教师" }]);
    assert.deepEqual(result.currentWeeks, [{ id: ids.week, startsOn: "2026-09-21", endsOn: "2026-09-27", settlementMonth: "2026-09-01" }]);
    assert.deepEqual(Object.keys(result.teachers[0]).sort(), ["nickname", "personId"]);
    assert.deepEqual(Object.keys(result.currentWeeks[0]).sort(), ["endsOn", "id", "settlementMonth", "startsOn"]);
    assert.deepEqual(calls, [[global(ids.owner), at]]);
    await assert.rejects(directory.list(global(ids.owner, "SYSTEM_OWNER", { regionId: randomUUID() }), at), /FORBIDDEN_SCOPE/);
    await assert.rejects(directory.list(global(ids.teacher, "TEACHING_TEACHER"), at), /FORBIDDEN_SCOPE/);
  } finally { await db.close(); }
});
