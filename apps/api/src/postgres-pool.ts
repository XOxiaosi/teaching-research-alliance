import { Pool } from "pg";

/**
 * 创建 API 使用的 PostgreSQL 连接池。
 * 连接字符串只从调用方或 DATABASE_URL 注入，不写入代码和仓库。
 */
export const createPostgresPool = (connectionString: string | undefined = process.env.DATABASE_URL): Pool => {
  if (connectionString === undefined || connectionString.trim() === "") {
    throw new Error("DATABASE_URL_REQUIRED");
  }
  return new Pool({
    connectionString,
    application_name: "teaching-research-alliance-api"
  });
};
