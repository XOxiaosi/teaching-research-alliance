import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createTestDatabase } from "./postgres-test-database.mjs";

test("0028 preserves existing closed and current relationships while retaining overlap protection", async () => {
  const database = await createTestDatabase(process.env.DATABASE_URL, { throughMigration: 27 });
  const { pool } = database;
  try {
    const [teacher, oldLeader, currentLeader, mentor] = Array.from({ length: 4 }, () => randomUUID());
    for (const [index, id] of [teacher, oldLeader, currentLeader, mentor].entries()) {
      await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1,$2,$2,'ACTIVE')", [id, `升级合成人员${index}`]);
    }
    await pool.query(`INSERT INTO person_relationship(teacher_id,relationship_type,related_person_id,valid_from,valid_to,effective_scope,created_by)
      VALUES($1,'GROUP_LEADER',$2,'2026-01-01T00:00:00Z','2026-09-01T00:00:00Z','HISTORICAL',$1),
            ($1,'GROUP_LEADER',$3,'2026-09-01T00:00:00Z',NULL,'CURRENT',$1),
            ($1,'TEACHING_MENTOR',$4,'2026-01-01T00:00:00Z',NULL,'CURRENT',$1)`,
    [teacher, oldLeader, currentLeader, mentor]);
    const projection = "id::text,teacher_id::text,relationship_type,related_person_id::text,valid_from::text,valid_to::text,effective_scope,created_by::text,created_at::text";
    const before = (await pool.query(`SELECT ${projection} FROM person_relationship ORDER BY id`)).rows;
    await pool.query(await readFile(new URL("../../../../database/migrations/0028_group_leader_relationship_changes.sql", import.meta.url), "utf8"));
    assert.deepEqual((await pool.query(`SELECT ${projection} FROM person_relationship ORDER BY id`)).rows, before);
    const precisionClient = await pool.connect();
    try {
      for (const timeZone of ["UTC", "Asia/Shanghai", "America/Los_Angeles"]) {
        await precisionClient.query("BEGIN");
        try {
          await precisionClient.query("SELECT set_config('TimeZone',$1,true)", [timeZone]);
          const canonical = (await precisionClient.query(`SELECT
            group_leader_timestamp_text('2026-09-23T08:00:00.123456+08'::timestamptz) AS precise,
            group_leader_timestamp_text('2026-09-23T08:00:00.123457+08'::timestamptz) AS next_microsecond,
            group_leader_timestamp_text(NULL::timestamptz) AS absent`)).rows[0];
          assert.deepEqual(canonical, {
            precise: "2026-09-23T00:00:00.123456Z",
            next_microsecond: "2026-09-23T00:00:00.123457Z",
            absent: null,
          }, timeZone);
        } finally { await precisionClient.query("ROLLBACK"); }
      }
    } finally { precisionClient.release(); }
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM person_relationship WHERE superseded_at IS NULL AND superseded_by_change_id IS NULL")).rows[0].n, 3);
    await assert.rejects(pool.query(`INSERT INTO person_relationship(teacher_id,relationship_type,related_person_id,valid_from,effective_scope,created_by)
      VALUES($1,'GROUP_LEADER',$2,'2026-09-23T00:00:00Z','CURRENT',$1)`, [teacher, oldLeader]),
    error => error.code === "23P01" && error.constraint === "person_relationship_active_period_no_overlap");
    await assert.rejects(pool.query("UPDATE person_relationship SET superseded_at='2026-09-23T00:00:00Z' WHERE teacher_id=$1 AND valid_to IS NULL", [teacher]),
      error => error.code === "23514" && error.constraint === "person_relationship_supersession_pair");
    assert.deepEqual((await pool.query(`SELECT ${projection} FROM person_relationship ORDER BY id`)).rows, before);
  } finally {
    await database.close();
  }
});
