import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase } from "../../../api/test/integration/postgres-test-database.mjs";
import { PostgresAccountAccessService } from "../../../api/dist/main.js";
import { EXPORT_SCHEMA_REGISTRY } from "../../dist/export-schema-registry.js";
import { PostgresFullBackupSource } from "../../dist/postgres-full-backup-source.js";

const connectionString = process.env.DATABASE_URL;

const withDatabase = async (work) => {
  const database = await createTestDatabase(connectionString);
  try {
    await work(database);
  } finally {
    await database.close();
  }
};

const sourcePool = (database, options = {}) => {
  const queries = [];
  let releases = 0;
  let captured;
  return {
    queries,
    get releases() {
      return releases;
    },
    get client() {
      return captured;
    },
    pool: {
      connect: async () => {
        const client = await database.pool.connect();
        captured = client;
        return {
          query: async (sql, parameters) => {
            queries.push(sql);
            if (sql.startsWith("DECLARE")) {
              options.onDeclare?.();
              if (options.declareGate) await options.declareGate;
            }
            if (sql.startsWith("FETCH")) {
              options.onFetch?.();
              if (options.fetchGate) await options.fetchGate;
            }
            if (options.failFetch && sql.startsWith("FETCH"))
              throw new Error("SYNTHETIC_FETCH_FAILURE");
            return client.query(sql, parameters);
          },
          release: async () => {
            releases += 1;
            await client.release();
          },
        };
      },
    },
  };
};

const deferred = () => {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

const insertPerson = async (database, nickname) => {
  const result = await database.pool.query(
    "INSERT INTO person(nickname,legal_name,status,created_at,updated_at) VALUES ($1,$2,'ACTIVE',now(),now()) RETURNING id::text AS id",
    [nickname, nickname],
  );
  return result.rows[0].id;
};

const nextBatch = async (stream) => {
  const result = await stream.next();
  assert.equal(result.done, false);
  return result.value;
};

test("全量备份数据源以注册的 101 表、固定主键和统一快照打开", async () => {
  await withDatabase(async (database) => {
    const at = new Date("2026-09-23T02:00:00.000Z");
    const access = new PostgresAccountAccessService(database.pool);
    const owner = await access.register({ nickname: "资料历史管理员", legalName: "资料历史管理员", phoneNormalized: "13800009101", password: "backup-owner-password" }, at);
    const target = await access.register({ nickname: "资料历史当前值", legalName: "资料历史当前值", phoneNormalized: "13800009102", password: "backup-target-password" }, at);
    await database.pool.query(
      "INSERT INTO role_assignment(person_id,subject_code,scope_type,valid_from,created_by) VALUES($1,'SYSTEM_OWNER','GLOBAL',$2,$1)",
      [owner.session.personId, at.toISOString()],
    );
    await access.updatePersonProfile(
      { personId: owner.session.personId, subject: "SYSTEM_OWNER", scope: "GLOBAL" },
      target.session.personId, "资料历史新值", "资料历史实名", "1", "备份测试", "backup-profile-key", at,
    );
    const personId = target.session.personId;
    const observed = sourcePool(database);
    const source = await new PostgresFullBackupSource(observed.pool).open();
    try {
      assert.equal(source.mode, "SOURCE_ONLY");
      assert.equal(source.snapshotId.length > 0, true);
      assert.equal(source.asOf.length > 0, true);
      assert.deepEqual(source.datasets.map((item) => item.tableName), EXPORT_SCHEMA_REGISTRY.map((item) => item.name));
      assert.equal(source.datasets.length, 101);
      assert.equal(await source.countRows("person_profile_change"), 1n);
      const stream = await source.openStream("person_profile_change", 10);
      const batch = await nextBatch(stream);
      assert.equal(batch.rows[0].transformValues.get("idempotency_key"), "backup-profile-key");
      await stream.close();
      for (const dataset of source.datasets) {
        const registry = EXPORT_SCHEMA_REGISTRY.find((item) => item.name === dataset.tableName);
        assert.deepEqual(dataset.orderBy, registry.orderBy);
        assert.equal(dataset.orderBy.length > 0, true);
      }
      assert.equal(observed.queries[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    } finally {
      await source.close();
    }
    assert.equal(observed.releases, 1);
  });
});

test("数据源在快照前拒绝未知表和未注册列", async (context) => {
  await context.test("unknown table", async () => {
    await withDatabase(async (database) => {
      await database.pool.query("CREATE TABLE full_backup_unknown_table(id uuid PRIMARY KEY)");
      await assert.rejects(
        () => new PostgresFullBackupSource(database.pool).open(),
        { message: "EXPORT_SCHEMA_MISMATCH" },
      );
    });
  });
  await context.test("unknown column", async () => {
    await withDatabase(async (database) => {
      await database.pool.query("ALTER TABLE person ADD COLUMN full_backup_unknown_column text");
      await assert.rejects(
        () => new PostgresFullBackupSource(database.pool).open(),
        { message: "EXPORT_SCHEMA_MISMATCH" },
      );
    });
  });
});

test("数据源显式读取文本值、保持精度和 JSON 转换值，并绝不选择秘密列", async () => {
  await withDatabase(async (database) => {
    const personId = await insertPerson(database, "备份源老师");
    const account = await database.pool.query(
      "INSERT INTO settlement_account(owner_type,owner_id,account_code,status,created_at) VALUES ('PERSON',$1,'BACKUP_SOURCE_ACCOUNT','ACTIVE',now()) RETURNING id::text AS id",
      [personId],
    );
    await database.pool.query(
      "INSERT INTO account_balance_projection(account_id,balance_cents,updated_at) VALUES ($1,$2,now())",
      [account.rows[0].id, "9007199254740993"],
    );
    await database.pool.query(
      "INSERT INTO audit_event(action_code,subject_type,before_json,after_json,reason,created_at) VALUES ('BACKUP','PERSON',$1::jsonb,$2::jsonb,'test',now())",
      ['{"before":"value"}', '{"after":"value"}'],
    );
    await database.pool.query(
      "INSERT INTO user_account(person_id,phone_normalized,password_hash,login_status,created_at,updated_at) VALUES ($1,'13800000000','never-select-this','ACTIVE',now(),now())",
      [personId],
    );

    const observed = sourcePool(database);
    const source = await new PostgresFullBackupSource(observed.pool).open();
    try {
      const balances = await source.openStream("account_balance_projection", 2);
      const balance = (await nextBatch(balances)).rows[0];
      assert.equal(balance.exportValues.balance_cents, "9007199254740993");
      await balances.next();

      const audits = await source.openStream("audit_event", 2);
      const audit = (await nextBatch(audits)).rows[0];
      assert.equal(audit.exportValues.before_json, undefined);
      assert.equal(audit.transformValues.get("before_json"), '{"before": "value"}');
      assert.equal(audit.transformValues.get("after_json"), '{"after": "value"}');
      assert.equal(JSON.stringify(audit).includes('"before": "value"'), false);
      await audits.next();

      const accounts = await source.openStream("user_account", 2);
      assert.equal((await nextBatch(accounts)).rows[0].exportValues.password_hash, undefined);
      await accounts.next();
      const declarations = observed.queries.filter((sql) => sql.startsWith("DECLARE"));
      assert.equal(declarations.some((sql) => sql.includes("password_hash") || sql.includes("auth_version")), false);
      assert.equal(declarations.some((sql) => sql.includes("SELECT *")), false);
      for (const tableName of ["user_session", "auth_login_throttle", "auth_password_reset_command"]) {
        await assert.rejects(() => source.openStream(tableName, 1), {
          message: "EXPORT_DATASET_NO_READABLE_COLUMNS",
        });
        await assert.rejects(() => source.countRows(tableName), {
          message: "EXPORT_DATASET_NO_READABLE_COLUMNS",
        });
        assert.equal(observed.queries.some((sql) => sql.includes(`count(*)::text AS row_count FROM "${tableName}"`)), false);
        assert.equal(observed.queries.some((sql) => sql.startsWith("DECLARE") && sql.includes(`FROM "${tableName}"`)), false);
      }
    } finally {
      await source.close();
    }
  });
});

test("数据源按固定键批量稳定读取，并隔离打开后提交的并发写入", async () => {
  await withDatabase(async (database) => {
    const ids = await Promise.all([
      insertPerson(database, "排序甲"),
      insertPerson(database, "排序乙"),
      insertPerson(database, "排序丙"),
    ]);
    const source = await new PostgresFullBackupSource(database.pool).open();
    try {
      const stream = await source.openStream("person", 1);
      const first = await nextBatch(stream);
      await insertPerson(database, "并发写入不应出现");
      // COUNT and the cursor share this one locked repeatable-read snapshot,
      // so neither sees the later committed row.
      assert.equal(await source.countRows("person"), 3n);
      const received = [first.rows[0].exportValues.id];
      for (;;) {
        const next = await stream.next();
        if (next.done) break;
        received.push(next.value.rows[0].exportValues.id);
      }
      assert.deepEqual(received, [...ids].sort());
      assert.equal(received.includes((await database.pool.query("SELECT id::text AS id FROM person WHERE nickname='并发写入不应出现'")).rows[0].id), false);
    } finally {
      await source.close();
    }
  });
});

test("数据源拒绝未知数据集、非法批量和并行消费，并在提前停止后释放连接", async () => {
  await withDatabase(async (database) => {
    await insertPerson(database, "提前停止");
    await insertPerson(database, "提前停止第二行");
    const observed = sourcePool(database);
    const source = await new PostgresFullBackupSource(observed.pool).open();
    try {
      await assert.rejects(() => source.openStream("not_registered", 1), { message: "EXPORT_DATASET_UNKNOWN" });
      await assert.rejects(() => source.countRows("not_registered"), { message: "EXPORT_DATASET_UNKNOWN" });
      for (const batchSize of [0, 1.5, 1001]) {
        await assert.rejects(() => source.openStream("person", batchSize), { message: "INVALID_EXPORT_BATCH_SIZE" });
      }
      const stream = await source.openStream("person", 1);
      const [first, second] = await Promise.allSettled([stream.next(), stream.next()]);
      assert.equal([first, second].filter((result) => result.status === "rejected").length, 1);
      for await (const _batch of stream) break;
      assert.equal(observed.releases, 1);
      await assert.rejects(() => source.openStream("person", 1), { message: "EXPORT_SOURCE_CLOSED" });
      await database.pool.query("SELECT 1");
    } finally {
      await source.close();
    }
  });
});

test("提现源行以隐藏 AAD 上下文携带申请人，不把其混入 EXPORT 或 TRANSFORM 列", async () => {
  await withDatabase(async (database) => {
    const applicantId = await insertPerson(database, "提现备份申请人");
    const account = await database.pool.query(
      "INSERT INTO settlement_account(owner_type,owner_id,account_code,status,created_at) VALUES('PERSON',$1::uuid,'BACKUP_WITHDRAWAL_SOURCE','ACTIVE',now()) RETURNING id::text AS id",
      [applicantId],
    );
    const document = await database.pool.query(
      "INSERT INTO finance_document(applicant_person_id,kind,status,version,created_at,updated_at) VALUES($1::uuid,'WITHDRAWAL','PENDING_TRANSFER',2,now(),now()) RETURNING id::text AS id",
      [applicantId],
    );
    const ledger = await database.pool.query(
      "INSERT INTO ledger_event(event_key,event_type,payload_hash,created_at) VALUES('backup-withdrawal-source-event','WITHDRAWAL_DEBIT','hash',now()) RETURNING id::text AS id",
    );
    await database.pool.query(
      `INSERT INTO finance_withdrawal_submission(
         finance_document_id,source_account_id,source_owner_type,source_owner_id,
         authorization_kind,authorization_grant_id,authorization_snapshot,amount_cents,
         recipient_key_id,recipient_nonce,recipient_ciphertext,recipient_auth_tag,
         bank_account_last4,debit_ledger_event_id,submitted_by_person_id,submitted_at,created_at
       ) VALUES($1::uuid,$2::uuid,'PERSON',$3::uuid,'PERSON_OWNER',NULL,
         $4::jsonb,500,'key','nonce','ciphertext','tag','6789',$5::uuid,$3::uuid,now(),now())`,
      [document.rows[0].id, account.rows[0].id, applicantId, JSON.stringify({ authorizationKind: "PERSON_OWNER", sourceAccountId: account.rows[0].id, personId: applicantId }), ledger.rows[0].id],
    );

    const observed = sourcePool(database);
    const source = await new PostgresFullBackupSource(observed.pool).open();
    try {
      const stream = await source.openStream("finance_withdrawal_submission", 1);
      const withdrawal = (await nextBatch(stream)).rows[0];
      assert.equal(withdrawal.exportValues.applicant_person_id, undefined);
      assert.equal(withdrawal.transformValues.has("applicant_person_id"), false);
      assert.equal(withdrawal.transformContext?.withdrawalRecipient.applicantPersonId, applicantId);
      const declaration = observed.queries.find((sql) => sql.startsWith("DECLARE"));
      assert.equal(declaration.includes('LEFT JOIN "finance_document" AS "document"'), true);
      assert.equal(declaration.includes('AS "__backup_withdrawal_applicant_person_id"'), true);
    } finally {
      await source.close();
    }
  });
});

test("开流、关闭和批读交错时不会产生并行游标或归还连接后的迟到读取", async () => {
  await withDatabase(async (database) => {
    await insertPerson(database, "并发源");
    const declarationStarted = deferred();
    const declarationGate = deferred();
    const openingObserved = sourcePool(database, {
      onDeclare: declarationStarted.resolve,
      declareGate: declarationGate.promise,
    });
    const openingSource = await new PostgresFullBackupSource(openingObserved.pool).open();
    const opening = openingSource.openStream("person", 1);
    await declarationStarted.promise;
    await assert.rejects(() => openingSource.openStream("person", 1), {
      message: "EXPORT_STREAM_BUSY",
    });
    const closingWhileOpening = openingSource.close();
    declarationGate.resolve();
    await assert.rejects(() => opening, { message: "EXPORT_SOURCE_CLOSED" });
    await closingWhileOpening;
    assert.equal(openingObserved.releases, 1);

    const fetchStarted = deferred();
    const fetchGate = deferred();
    const fetchingObserved = sourcePool(database, {
      onFetch: fetchStarted.resolve,
      fetchGate: fetchGate.promise,
    });
    const fetchingSource = await new PostgresFullBackupSource(fetchingObserved.pool).open();
    const stream = await fetchingSource.openStream("person", 1);
    const pendingNext = stream.next();
    await fetchStarted.promise;
    const closingWhileFetching = fetchingSource.close();
    fetchGate.resolve();
    await assert.rejects(() => pendingNext, { message: "EXPORT_SOURCE_CLOSED" });
    await closingWhileFetching;
    assert.equal(fetchingObserved.releases, 1);
    await assert.rejects(() => stream.next(), { message: "EXPORT_SOURCE_CLOSED" });
  });
});

test("读取失败和同一只读连接上的写入尝试都会释放事务与连接", async () => {
  await withDatabase(async (database) => {
    await insertPerson(database, "失败清理");
    const failing = sourcePool(database, { failFetch: true });
    const failedSource = await new PostgresFullBackupSource(failing.pool).open();
    const failedStream = await failedSource.openStream("person", 1);
    await assert.rejects(() => failedStream.next(), { message: "SYNTHETIC_FETCH_FAILURE" });
    assert.equal(failing.releases, 1);
    await failedSource.close();

    const observed = sourcePool(database);
    const source = await new PostgresFullBackupSource(observed.pool).open();
    try {
      await assert.rejects(
        () => observed.client.query("INSERT INTO person(nickname,legal_name,status,created_at,updated_at) VALUES ('readonly-write','readonly-write','ACTIVE',now(),now())"),
        /cannot execute INSERT in a read-only transaction/,
      );
    } finally {
      await source.close();
    }
    assert.equal(observed.releases, 1);
  });
});
