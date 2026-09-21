import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const directory = new URL("../database/migrations/", import.meta.url);
const files = (await readdir(directory)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
if (files.length === 0) throw new Error("NO_MIGRATIONS");
let previous = -1;
for (const file of files) {
  const match = /^(\d+)_/.exec(file);
  const number = Number(match?.[1]);
  if (!Number.isInteger(number) || number <= previous) throw new Error(`MIGRATION_ORDER:${file}`);
  previous = number;
  const sql = await readFile(join(directory.pathname, file), "utf8");
  if (!sql.includes("CREATE TABLE") || !sql.includes("created_at")) throw new Error(`MIGRATION_SHAPE:${file}`);
}
console.log(`checked ${files.length} migration(s)`);
