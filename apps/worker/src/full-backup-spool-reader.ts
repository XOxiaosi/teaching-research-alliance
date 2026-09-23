import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createFullBackupLayout } from "./full-backup-layout.js";
import { fullBackupOutputColumns } from "./full-backup-transformer.js";
import type { FullBackupSpoolDataset } from "./full-backup-spool.js";

const invalid = (): never => { throw new Error("EXPORT_SPOOL_INTEGRITY_FAILED"); };

/** Consumers must exhaust this stream before accepting output: count/hash checks finish at EOF. */
export async function* readBackupSpoolDataset(directory: string, dataset: FullBackupSpoolDataset): AsyncGenerator<readonly (string | null)[]> {
  const index = createFullBackupLayout().findIndex(item => item.tableName === dataset.tableName && item.policy === "RAW_SOURCE");
  const expectedFile = `datasets/${String(index + 1).padStart(3, "0")}_${dataset.tableName}.ndjson`;
  if (index < 0 || dataset.excluded || dataset.spoolFile !== expectedFile ||
      dataset.rowCount === null || !/^(0|[1-9]\d*)$/.test(dataset.rowCount) ||
      dataset.logicalDigest === null || !/^[a-f0-9]{64}$/.test(dataset.logicalDigest) ||
      dataset.columns.length === 0 || new Set(dataset.columns).size !== dataset.columns.length) invalid();
  const expectedColumns = fullBackupOutputColumns(dataset.tableName);
  if (JSON.stringify(dataset.columns) !== JSON.stringify(expectedColumns)) invalid();
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0) invalid();
  const folder = await lstat(join(directory, "datasets"));
  if (!folder.isDirectory() || folder.isSymbolicLink() || (folder.mode & 0o077) !== 0) invalid();
  const file = await open(join(directory, expectedFile), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) invalid();
    const hash = createHash("sha256");
    const stream = file.createReadStream({ autoClose: false });
    stream.on("data", chunk => hash.update(chunk));
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let header = true, count = 0n;
    try {
      for await (const line of lines) {
        if (header) {
          if (line !== JSON.stringify({ columns: dataset.columns })) invalid();
          header = false; continue;
        }
        let values: unknown;
        try { values = JSON.parse(line); } catch { invalid(); }
        if (!Array.isArray(values) || values.length !== dataset.columns.length ||
            values.some(value => value !== null && typeof value !== "string") || JSON.stringify(values) !== line) invalid();
        count += 1n;
        if (count > BigInt(dataset.rowCount!)) invalid();
        yield values as readonly (string | null)[];
      }
      if (header || count !== BigInt(dataset.rowCount!) || hash.digest("hex") !== dataset.logicalDigest) invalid();
    } finally { lines.close(); stream.destroy(); }
  } finally { await file.close(); }
}
