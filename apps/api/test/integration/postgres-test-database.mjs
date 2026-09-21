import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool } from "pg";

const migrationsDirectory = new URL("../../../../database/migrations/", import.meta.url);

const quoteIdentifier = (identifier) => `"${identifier.replaceAll('"', '""')}"`;

/**
 * 创建一个只属于当前集成测试的 PostgreSQL schema，并在其中执行全部迁移。
 *
 * 返回的 pool 默认将该 schema 放在 search_path 首位；close() 只删除该 schema，
 * 不会触碰同一个数据库中的其他 schema、表或测试数据。
 */
export const createTestDatabase = async (connectionString) => {
  if (connectionString === undefined || connectionString.trim() === "") {
    throw new Error("DATABASE_URL_REQUIRED_FOR_POSTGRES_INTEGRATION");
  }

  const schemaName = `integration_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({
    connectionString,
    options: `-c search_path=${schemaName},public`
  });

  try {
    // Extensions belong to public, never to a disposable test schema.
    const bootstrap = await pool.connect();
    try {
      await bootstrap.query("BEGIN");
      await bootstrap.query("SELECT pg_advisory_xact_lock(hashtextextended('integration-extension-bootstrap', 0))");
      await bootstrap.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
      await bootstrap.query("CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public");
      await bootstrap.query("COMMIT");
    } catch (error) {
      await bootstrap.query("ROLLBACK");
      throw error;
    } finally {
      bootstrap.release();
    }
    await pool.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    const files = (await readdir(migrationsDirectory))
      .filter((file) => /^\d+_.+\.sql$/.test(file))
      .sort();
    if (files.length === 0) throw new Error("NO_MIGRATIONS");
    for (const file of files) {
      await pool.query(await readFile(new URL(file, migrationsDirectory), "utf8"));
    }
  } catch (error) {
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`).catch(() => {});
    await pool.end();
    throw error;
  }

  let closed = false;
  return {
    pool,
    schemaName,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
      } finally {
        await pool.end();
      }
    }
  };
};
