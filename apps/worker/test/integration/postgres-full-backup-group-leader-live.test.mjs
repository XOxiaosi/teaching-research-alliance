import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PostgresGroupLeaderRelationshipService } from "../../../api/dist/postgres-group-leader-relationship-service.js";
import { PostgresWeeklySettlementService } from "../../../api/dist/postgres-weekly-settlement-service.js";
import { createTestDatabase } from "../../../api/test/integration/postgres-test-database.mjs";
import { FullBackupBusinessFactsView } from "../../dist/full-backup-business-facts-view.js";
import { FullBackupSpool } from "../../dist/full-backup-spool.js";
import { readBackupSpoolDataset } from "../../dist/full-backup-spool-reader.js";
import { FullBackupTeacherWorkbookExporter } from "../../dist/full-backup-teacher-workbook-exporter.js";
import { FullBackupTransformer, fullBackupOutputColumns } from "../../dist/full-backup-transformer.js";
import { PostgresFullBackupSource } from "../../dist/postgres-full-backup-source.js";

const at = new Date("2026-09-23T08:00:00.000Z");
const month = "2026-09-01";
const admin = (personId) => ({ personId, subject: "SYSTEM_ADMIN", scope: "GLOBAL" });
const json = (value) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);

const policy = {
  plannerBaseRateBasisPoints: 0n,
  teacherBaseRateBasisPoints: 0n,
  planningMentorWeightBasisPoints: 0n,
  groupLeaderRateBasisPoints: 600n,
  teachingMentorRateBasisPoints: 0n,
  venueRateBasisPoints: 0n,
  campusConsultationForPlannerRateBasisPoints: 0n,
  campusConsultationForTeacherRateBasisPoints: 0n,
  platformFinanceRateBasisPoints: 0n,
  regionFinanceRateBasisPoints: 0n,
  dynamicTiers: [
    { label: "低", maxInclusive: 50000n, adjustmentBasisPoints: 0n },
    { label: "中", minExclusive: 50000n, maxInclusive: 150000n, adjustmentBasisPoints: 0n },
    { label: "高", minExclusive: 150000n, adjustmentBasisPoints: 0n },
  ],
};

const addPerson = (pool, id, nickname) => pool.query(
  "INSERT INTO person(id,nickname,legal_name,status,created_at,updated_at) VALUES($1::uuid,$2,$2,'ACTIVE',$3::timestamptz,$3::timestamptz)",
  [id, nickname, at.toISOString()],
);

const addPersonalAccount = async (pool, personId, name) => {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status,created_at) VALUES($1::uuid,'PERSON',$2::uuid,$3,'ACTIVE',$4::timestamptz)",
    [id, personId, `person:${name}:${personId}`, at.toISOString()],
  );
  await pool.query("INSERT INTO account_balance_projection(account_id,balance_cents,updated_at) VALUES($1::uuid,0,$2::timestamptz)", [id, at.toISOString()]);
  return id;
};

const addGroupLeaderCandidate = async (pool, id, nickname, adminId) => {
  await addPerson(pool, id, nickname);
  const accountId = await addPersonalAccount(pool, id, nickname);
  const userId = randomUUID();
  const roleId = randomUUID();
  await pool.query(
    "INSERT INTO user_account(id,person_id,phone_normalized,password_hash,login_status,created_at,updated_at) VALUES($1::uuid,$2::uuid,$3,$4,'ACTIVE',$5::timestamptz,$5::timestamptz)",
    [userId, id, `1380000${Math.floor(Math.random() * 900 + 100)}`, `$argon2id$${nickname}-secret`, at.toISOString()],
  );
  await pool.query(
    "INSERT INTO role_assignment(id,person_id,subject_code,scope_type,scope_id,valid_from,created_by,created_at) VALUES($1::uuid,$2::uuid,'GROUP_LEADER','ASSOCIATED_TEACHERS',NULL,'2026-01-01T00:00:00.000Z',$3::uuid,$4::timestamptz)",
    [roleId, id, adminId, at.toISOString()],
  );
  return { accountId, userId, roleId };
};

const spoolRows = async (root, spool, tableName) => {
  const dataset = spool.datasets.find((item) => item.tableName === tableName);
  assert.ok(dataset && !dataset.excluded, tableName);
  const rows = [];
  for await (const row of readBackupSpoolDataset(join(root, "spool", spool.spoolId), dataset)) {
    rows.push(Object.fromEntries(dataset.columns.map((column, index) => [column, row[index]])));
  }
  return rows;
};

const viewRows = async (view, sourceTable) => {
  const description = view.describe(1);
  const source = description.sources.find((item) => item.sourceTable === sourceTable);
  assert.ok(source, `table 1 must declare ${sourceTable}`);
  const rows = [];
  for await (const row of view.readSourceRows(1, sourceTable)) {
    rows.push({ key: row.sourceRecordKey, values: Object.fromEntries(source.columns.map((column, index) => [column.sourceColumn, row.values[index]])) });
  }
  return rows;
};

test("real group-leader A-to-B-to-C changes remain exportable as RAW facts and table-1 facts", async () => {
  const database = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-group-leader-backup-pg-"));
  try {
    const ids = Object.fromEntries(["admin", "teacher", "leaderA", "leaderB", "leaderC", "venue", "year", "period", "week", "student", "referral", "policy"].map((key) => [key, randomUUID()]));
    await addPerson(database.pool, ids.admin, "组长变更管理员");
    await database.pool.query(
      "INSERT INTO role_assignment(id,person_id,subject_code,scope_type,scope_id,valid_from,created_by,created_at) VALUES($1::uuid,$2::uuid,'SYSTEM_ADMIN','GLOBAL',NULL,'2026-01-01T00:00:00.000Z',$2::uuid,$3::timestamptz)",
      [randomUUID(), ids.admin, at.toISOString()],
    );
    await addPerson(database.pool, ids.teacher, "被调组教师");
    const teacherAccountId = await addPersonalAccount(database.pool, ids.teacher, "teacher");
    const leaderA = await addGroupLeaderCandidate(database.pool, ids.leaderA, "组长A", ids.admin);
    const leaderB = await addGroupLeaderCandidate(database.pool, ids.leaderB, "组长B", ids.admin);
    const leaderC = await addGroupLeaderCandidate(database.pool, ids.leaderC, "组长C", ids.admin);
    await database.pool.query(
      "INSERT INTO teacher_profile(person_id,business_identity,employment_status,created_at,updated_at) VALUES($1::uuid,'TEACHING_TEACHER','ACTIVE',$2::timestamptz,$2::timestamptz)",
      [ids.teacher, at.toISOString()],
    );
    const oldRelationshipId = randomUUID();
    await database.pool.query(
      "INSERT INTO person_relationship(id,teacher_id,relationship_type,related_person_id,valid_from,effective_scope,created_by,created_at) VALUES($1::uuid,$2::uuid,'GROUP_LEADER',$3::uuid,'2026-01-01T00:00:00.000Z','REGULAR_WEEK:legacy',$4::uuid,$5::timestamptz)",
      [oldRelationshipId, ids.teacher, ids.leaderA, ids.admin, at.toISOString()],
    );
    await database.pool.query("INSERT INTO venue(id,owner_person_id,name,status,default_for_owner,created_at,updated_at) VALUES($1::uuid,$2::uuid,'组长变更场地','ACTIVE',true,$3::timestamptz,$3::timestamptz)", [ids.venue, ids.teacher, at.toISOString()]);
    await database.pool.query("INSERT INTO academic_year_plan(id,label,starts_on,ends_on,created_by,created_at) VALUES($1::uuid,'组长变更学年','2026-09-01','2027-08-31',$2::uuid,$3::timestamptz)", [ids.year, ids.admin, at.toISOString()]);
    await database.pool.query("INSERT INTO academic_period(id,academic_year_plan_id,label,starts_on,ends_on,created_at) VALUES($1::uuid,$2::uuid,'组长变更秋季','2026-09-01','2027-01-31',$3::timestamptz)", [ids.period, ids.year, at.toISOString()]);
    await database.pool.query("INSERT INTO teaching_week(id,academic_period_id,sequence_no,week_kind,starts_on,ends_on,settlement_month,status,created_at) VALUES($1::uuid,$2::uuid,1,'REGULAR','2026-09-21','2026-09-27',$3::date,'OPEN',$4::timestamptz)", [ids.week, ids.period, month, at.toISOString()]);
    await database.pool.query("INSERT INTO teacher_student_record(id,owner_teacher_id,course_context_id,display_name,created_at,updated_at) VALUES($1::uuid,$2::uuid,'group-leader-course','组长变更学生',$3::timestamptz,$3::timestamptz)", [ids.student, ids.teacher, at.toISOString()]);
    await database.pool.query("INSERT INTO referral_case(id,teacher_student_record_id,referrer_person_id,receiver_person_id,referrer_identity,status,submitted_at,version,created_at,updated_at) VALUES($1::uuid,$2::uuid,$3::uuid,$3::uuid,'TEACHING_TEACHER','ACCEPTED',$4::timestamptz,2,$4::timestamptz,$4::timestamptz)", [ids.referral, ids.student, ids.teacher, at.toISOString()]);
    await database.pool.query("INSERT INTO rate_policy_version(id,version,effective_from,policy_json,reason,published_by,published_at) VALUES($1::uuid,1,$2::date,$3::jsonb,'组长变更费率',$4::uuid,$5::timestamptz)", [ids.policy, month, json(policy), ids.admin, at.toISOString()]);

    const weekly = new PostgresWeeklySettlementService(database.pool);
    const settled = await weekly.recordAndSettle(ids.teacher, {
      referralCaseId: ids.referral, teachingWeekId: ids.week, venueId: ids.venue, settlementMonth: month,
      grossAmountCents: 1000n, expectedVersion: 0,
    }, "group-leader-initial-settlement");
    assert.equal(settled.replay, false);

    const service = new PostgresGroupLeaderRelationshipService(database.pool);
    assert.deepEqual((await service.listCandidates(admin(ids.admin), at)).map((item) => item.personId).sort(), [ids.leaderA, ids.leaderB, ids.leaderC].sort());
    const previewOne = await service.preview(admin(ids.admin), {
      teacherPersonId: ids.teacher, newRelatedPersonId: ids.leaderB, effectiveTeachingWeekId: ids.week, reason: "同周改为组长B",
    }, at);
    assert.deepEqual([previewOne.consideredFeeCount, previewOne.movedFeeCount, previewOne.movedAmountCents], [1, 1, "60"]);
    const first = await service.publish(admin(ids.admin), previewOne.previewId, "group-leader-original-key-one", at);
    assert.equal(first.postingStatus, "POSTED");
    assert.equal((await service.publish(admin(ids.admin), previewOne.previewId, "group-leader-original-key-one", at)).replay, true);
    const previewTwo = await service.preview(admin(ids.admin), {
      teacherPersonId: ids.teacher, newRelatedPersonId: ids.leaderC, effectiveTeachingWeekId: ids.week, reason: "同周改为组长C",
    }, at);
    const second = await service.publish(admin(ids.admin), previewTwo.previewId, "group-leader-original-key-two", at);
    assert.equal(second.postingStatus, "POSTED");

    const storedJson = await database.pool.query(
      "SELECT 'preview' AS kind, id::text, impact_json::text AS payload FROM person_relationship_change_preview UNION ALL SELECT 'change-before', id::text, before_json::text FROM person_relationship_change UNION ALL SELECT 'change-after', id::text, after_json::text FROM person_relationship_change ORDER BY kind, id",
    );
    const jsonBytes = new Map(storedJson.rows.map((row) => [`${row.kind}:${row.id}`, row.payload]));
    const spool = await new FullBackupSpool({
      source: new PostgresFullBackupSource(database.pool),
      transformer: new FullBackupTransformer({ fingerprint: ({ domain, value }) => createHash("sha256").update(`${domain}:${value}`).digest("hex") }),
      tempRoot: join(root, "spool"), batchSize: 1,
    }).create();

    for (const table of ["person_relationship_change_preview", "person_relationship_change", "person_relationship_change_effect"]) {
      assert.equal(fullBackupOutputColumns(table).includes("idempotency_key"), false, `${table} never exposes a raw idempotency key`);
    }
    assert.equal(fullBackupOutputColumns("person_relationship_change").includes("idempotency_key_fingerprint"), true);
    const previews = await spoolRows(root, spool, "person_relationship_change_preview");
    const changes = await spoolRows(root, spool, "person_relationship_change");
    const effects = await spoolRows(root, spool, "person_relationship_change_effect");
    assert.equal(previews.length, 2); assert.equal(changes.length, 2); assert.equal(effects.length, 2);
    assert.equal(new Set(previews.map((row) => row.id)).size, 2, "preview PKs remain independent");
    assert.equal(new Set(changes.map((row) => row.id)).size, 2, "change PKs remain independent");
    assert.equal(new Set(effects.map((row) => `${row.change_id}:${row.weekly_fee_entry_id}`)).size, 2, "effect composite PK remains independent");
    assert.equal(JSON.stringify({ previews, changes, effects }).includes("group-leader-original-key"), false);
    assert.equal(changes.every((row) => typeof row.idempotency_key_fingerprint === "string" && row.idempotency_key_fingerprint.length === 64), true);
    const firstChange = changes.find((row) => row.id === first.changeId);
    const secondChange = changes.find((row) => row.id === second.changeId);
    assert.ok(firstChange && secondChange);
    assert.equal(previews.find((row) => row.id === previewOne.previewId)?.impact_json, jsonBytes.get(`preview:${previewOne.previewId}`), "preview JSON bytes are retained");
    assert.equal(previews.find((row) => row.id === previewTwo.previewId)?.impact_json, jsonBytes.get(`preview:${previewTwo.previewId}`), "second preview JSON bytes are retained");
    assert.equal(firstChange.before_json, jsonBytes.get(`change-before:${first.changeId}`), "before JSON bytes are retained");
    assert.equal(firstChange.after_json, jsonBytes.get(`change-after:${first.changeId}`), "after JSON bytes are retained");
    assert.equal(secondChange.before_json, jsonBytes.get(`change-before:${second.changeId}`), "second before JSON bytes are retained");
    assert.equal(secondChange.after_json, jsonBytes.get(`change-after:${second.changeId}`), "second after JSON bytes are retained");
    assert.deepEqual(JSON.parse(firstChange.before_json).sourceRelationship.id, oldRelationshipId);
    assert.deepEqual(JSON.parse(firstChange.after_json).resultRelationship.id, first.resultRelationshipId);
    assert.deepEqual(JSON.parse(secondChange.before_json).sourceRelationship.id, first.resultRelationshipId);
    assert.deepEqual(JSON.parse(secondChange.after_json).resultRelationship.id, second.resultRelationshipId);
    const previewJson = JSON.parse(previews.find((row) => row.id === previewOne.previewId).impact_json);
    assert.deepEqual([previewJson.candidate.personId, previewJson.fees[0].sourceAccountId, previewJson.fees[0].groupLeaderAmountCents], [ids.leaderB, leaderA.accountId, "60"]);
    assert.equal(previewJson.reason, "同周改为组长B");
    assert.deepEqual(effects.map((row) => ({ change: row.change_id, source: row.source_account_id, destination: row.destination_account_id, amount: row.group_leader_amount_cents })).sort((left, right) => left.change.localeCompare(right.change)), [
      { change: first.changeId, source: leaderA.accountId, destination: leaderB.accountId, amount: "60" },
      { change: second.changeId, source: leaderB.accountId, destination: leaderC.accountId, amount: "60" },
    ].sort((left, right) => left.change.localeCompare(right.change)));
    const ledger = await spoolRows(root, spool, "ledger_entry");
    const changeEvents = new Set(changes.map((row) => row.ledger_event_id));
    const balances = Object.fromEntries([leaderA.accountId, leaderB.accountId, leaderC.accountId, teacherAccountId].map((accountId) => [accountId, ledger.filter((row) => changeEvents.has(row.event_id) && row.account_id === accountId && row.category_key === "groupLeader").reduce((sum, row) => sum + BigInt(row.amount_cents), 0n)]));
    assert.deepEqual(balances, { [leaderA.accountId]: -60n, [leaderB.accountId]: 0n, [leaderC.accountId]: 60n, [teacherAccountId]: 0n });
    const cumulativeBalances = Object.fromEntries([leaderA.accountId, leaderB.accountId, leaderC.accountId].map((accountId) => [accountId, ledger.filter((row) => row.account_id === accountId).reduce((sum, row) => sum + BigInt(row.amount_cents), 0n)]));
    assert.deepEqual(cumulativeBalances, { [leaderA.accountId]: 0n, [leaderB.accountId]: 0n, [leaderC.accountId]: 60n }, "initial settlement and both changes produce the expected final ledger balances");
    const projections = await spoolRows(root, spool, "account_balance_projection");
    const projectedBalances = Object.fromEntries([leaderA.accountId, leaderB.accountId, leaderC.accountId].map((accountId) => [accountId, projections.find((row) => row.account_id === accountId)?.balance_cents]));
    assert.deepEqual(projectedBalances, { [leaderA.accountId]: "0", [leaderB.accountId]: "0", [leaderC.accountId]: "60" }, "exported balance projections retain final balances");
    const databaseBalances = await database.pool.query(
      "SELECT account_id::text,balance_cents::text FROM account_balance_projection WHERE account_id = ANY($1::uuid[]) ORDER BY account_id",
      [[leaderA.accountId, leaderB.accountId, leaderC.accountId]],
    );
    assert.deepEqual(Object.fromEntries(databaseBalances.rows.map((row) => [row.account_id, row.balance_cents])), { [leaderA.accountId]: "0", [leaderB.accountId]: "0", [leaderC.accountId]: "60" }, "database projections agree with exported facts");

    const rawRelationships = await spoolRows(root, spool, "person_relationship");
    const rawOldRelationship = rawRelationships.find((row) => row.id === oldRelationshipId);
    const rawSupersededRelationship = rawRelationships.find((row) => row.id === first.resultRelationshipId);
    const rawCurrentRelationship = rawRelationships.find((row) => row.id === second.resultRelationshipId);
    assert.ok(rawOldRelationship && rawSupersededRelationship && rawCurrentRelationship);
    assert.equal(rawOldRelationship.related_person_id, ids.leaderA);
    assert.notEqual(rawOldRelationship.valid_to, null, "the prior leader relationship closes at the selected boundary");
    assert.equal(rawSupersededRelationship.related_person_id, ids.leaderB);
    assert.notEqual(rawSupersededRelationship.superseded_at, null, "the middle relationship remains as a superseded RAW fact");
    assert.equal(rawSupersededRelationship.superseded_by_change_id, second.changeId);
    assert.equal(rawCurrentRelationship.related_person_id, ids.leaderC);
    assert.equal(rawCurrentRelationship.superseded_at, null);
    assert.equal(rawCurrentRelationship.superseded_by_change_id, null);

    const view = new FullBackupBusinessFactsView({ spoolDirectory: join(root, "spool", spool.spoolId), spool });
    const relationRows = await viewRows(view, "person_relationship");
    const oldRelationship = relationRows.find((row) => row.values.id === oldRelationshipId);
    const supersededRelationship = relationRows.find((row) => row.values.id === first.resultRelationshipId);
    const currentRelationship = relationRows.find((row) => row.values.id === second.resultRelationshipId);
    assert.ok(oldRelationship && supersededRelationship && currentRelationship, "old, superseded, and current relationship facts remain visible");
    assert.equal(oldRelationship.values.relationship_type, "GROUP_LEADER");
    assert.equal(supersededRelationship.values.relationship_type, "GROUP_LEADER");
    assert.notEqual(supersededRelationship.values.superseded_at, null, "the middle relationship remains as a superseded table-1 fact");
    assert.equal(supersededRelationship.values.superseded_by_change_id, second.changeId);
    assert.equal(currentRelationship.values.relationship_type, "GROUP_LEADER");
    assert.equal(currentRelationship.values.superseded_at, null);
    assert.equal(currentRelationship.values.superseded_by_change_id, null);
    for (const sourceTable of ["person_relationship_change_preview", "person_relationship_change", "person_relationship_change_effect"]) {
      const rows = await viewRows(view, sourceTable);
      assert.equal(rows.length, 2, `table 1 retains both ${sourceTable} rows`);
    }
    const workbook = await new FullBackupTeacherWorkbookExporter({
      spoolDirectory: join(root, "spool", spool.spoolId), spool, outputRoot: join(root, "workbooks"),
    }).export();
    assert.equal(workbook.complete, false);
    assert.equal(workbook.sourceRows.find((row) => row.sourceTable === "person_relationship_change_preview")?.rowCount, "2");
    assert.equal(workbook.sourceRows.find((row) => row.sourceTable === "person_relationship_change")?.rowCount, "2");
    assert.equal(workbook.sourceRows.find((row) => row.sourceTable === "person_relationship_change_effect")?.rowCount, "2");
  } finally {
    await rm(root, { recursive: true, force: true });
    await database.close();
  }
});
