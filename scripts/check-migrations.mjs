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
const organizationMigration = await readFile(join(directory.pathname, "0002_organization_relationships.sql"), "utf8");
for (const required of ["person_campus_assignment", "btree_gist", "EXCLUDE USING gist", "one_default_venue_per_owner"]) {
  if (!organizationMigration.includes(required)) throw new Error(`MIGRATION_CONSTRAINT:${required}`);
}
console.log(`checked ${files.length} migration(s)`);
