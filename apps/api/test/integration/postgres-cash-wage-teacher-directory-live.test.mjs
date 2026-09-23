import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PostgresCashWageTeacherDirectoryService } from "../../dist/postgres-cash-wage-teacher-directory-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const global = (personId, subject = "HEADQUARTERS_FINANCE", extra = {}) => ({ personId, subject, scope: "GLOBAL", ...extra });

const addPerson = async (pool, id, nickname, status = "ACTIVE") => {
  await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,$3,$4)", [id, nickname, `姓名-${nickname}`, status]);
};

test("工资候选目录对三类严格 GLOBAL 管理者返回所有 ACTIVE 人员，包含规划师", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  try {
    const ids = { owner: randomUUID(), admin: randomUUID(), finance: randomUUID(), teacher: randomUUID(), planner: randomUUID(), inactive: randomUUID() };
    await addPerson(db.pool, ids.owner, "Zulu-owner");
    await addPerson(db.pool, ids.admin, "Alpha-admin");
    await addPerson(db.pool, ids.finance, "Bravo-finance");
    await addPerson(db.pool, ids.teacher, "Delta-teacher");
    await addPerson(db.pool, ids.planner, "Charlie-planner");
    await addPerson(db.pool, ids.inactive, "Echo-inactive", "INACTIVE");
    await db.pool.query(
      "INSERT INTO teacher_profile(person_id,business_identity,employment_status) VALUES($1::uuid,'TEACHING_TEACHER','ACTIVE'),($2::uuid,'ACADEMIC_PLANNER','ACTIVE')",
      [ids.teacher, ids.planner],
    );
    const directory = new PostgresCashWageTeacherDirectoryService(db.pool);
    const expected = [ids.owner, ids.admin, ids.finance, ids.teacher, ids.planner]
      .map((personId) => ({ personId, nickname: ({ [ids.owner]: "Zulu-owner", [ids.admin]: "Alpha-admin", [ids.finance]: "Bravo-finance", [ids.teacher]: "Delta-teacher", [ids.planner]: "Charlie-planner" })[personId] }))
      .sort((left, right) => left.nickname.localeCompare(right.nickname) || left.personId.localeCompare(right.personId));
    for (const [personId, subject] of [[ids.owner, "SYSTEM_OWNER"], [ids.admin, "SYSTEM_ADMIN"], [ids.finance, "HEADQUARTERS_FINANCE"]]) {
      const result = await directory.list(global(personId, subject));
      assert.deepEqual(result.items, expected);
      assert.ok(result.items.some((item) => item.personId === ids.teacher));
      assert.ok(result.items.some((item) => item.personId === ids.planner));
      assert.equal(result.items.some((item) => item.personId === ids.inactive), false);
      assert.deepEqual(Object.keys(result.items[0]).sort(), ["nickname", "personId"]);
    }
  } finally {
    await db.close();
  }
});

test("工资候选目录拒绝个人角色、局部范围及 GLOBAL 夹带范围", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  try {
    const operator = randomUUID();
    await addPerson(db.pool, operator, "operator");
    const directory = new PostgresCashWageTeacherDirectoryService(db.pool);
    const forbidden = [
      { personId: operator, subject: "TEACHING_TEACHER", scope: "SELF" },
      { personId: operator, subject: "ACADEMIC_PLANNER", scope: "SELF" },
      { personId: operator, subject: "REGION_FINANCE", scope: "REGION", regionId: randomUUID() },
      { personId: operator, subject: "CAMPUS_PRINCIPAL", scope: "CAMPUS", campusId: randomUUID() },
      global(operator, "HEADQUARTERS_FINANCE", { regionId: randomUUID() }),
      global(operator, "SYSTEM_ADMIN", { campusId: randomUUID() }),
      global(operator, "SYSTEM_OWNER", { venueId: randomUUID() }),
    ];
    for (const context of forbidden) await assert.rejects(directory.list(context), /FORBIDDEN_SCOPE/);
  } finally {
    await db.close();
  }
});
