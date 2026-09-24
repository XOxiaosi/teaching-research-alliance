import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createFullBackupLayout } from "../dist/full-backup-layout.js";
import { FullBackupSpool } from "../dist/full-backup-spool.js";

const layout = createFullBackupLayout();
const secretTables = new Set(layout.filter((item) => item.policy === "AUTH_SECRET_TABLE_EXCLUDED").map((item) => item.tableName));
const columnsFor = (tableName) => {
  if (secretTables.has(tableName)) return [];
  if (tableName === "person") return ["id", "nickname"];
  if (tableName === "finance_withdrawal_submission") return ["finance_document_id", "recipient_name", "bank_account"];
  return ["id"];
};

const row = (exportValues, { transformValues = {}, transformContext } = {}) => ({
  exportValues,
  transformValues: new Map(Object.entries(transformValues)),
  ...(transformContext === undefined ? {} : { transformContext }),
});

const stream = (datasetName, batches) => {
  let index = 0;
  let closed = false;
  return {
    async next() {
      if (closed || index === batches.length) return { done: true, value: undefined };
      return { done: false, value: { datasetName, rows: batches[index++] } };
    },
    async return() { closed = true; return { done: true, value: undefined }; },
    async close() { closed = true; },
    [Symbol.asyncIterator]() { return this; },
  };
};

const mockSource = ({ rowsByTable = {}, counts = {} } = {}) => {
  const calls = { count: [], stream: [], close: 0 };
  const snapshot = {
    mode: "SOURCE_ONLY",
    snapshotId: "snapshot-fixed",
    asOf: "2026-09-23T00:00:00.000Z",
    datasets: layout.map((item) => ({ tableName: item.tableName })),
    async countRows(tableName) {
      calls.count.push(tableName);
      return BigInt(counts[tableName] ?? (rowsByTable[tableName] ?? []).flat().length);
    },
    async openStream(tableName) {
      calls.stream.push(tableName);
      return stream(tableName, rowsByTable[tableName] ?? []);
    },
    async close() { calls.close += 1; },
  };
  return { calls, source: { async open() { return snapshot; } } };
};

const withTemp = async (work) => {
  const root = await mkdtemp(join(tmpdir(), "alliance-spool-"));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
};

const transformer = (options = {}) => ({
  async transformRow(input) {
    options.onInput?.(input);
    if (options.fail?.(input)) throw new Error("SYNTHETIC_TRANSFORM_FAILURE");
    if (options.missing?.(input)) return { values: { id: input.exportValues.id ?? null }, anomalies: [], consumedTransformColumns: [] };
    const values = {};
    for (const column of columnsFor(input.tableName)) {
      if (column === "recipient_name") values[column] = "张三";
      else if (column === "bank_account") values[column] = "=0012345678901234";
      else values[column] = input.exportValues[column] ?? null;
    }
    return {
      values,
      anomalies: options.anomaly?.(input) ?? [],
      consumedTransformColumns: [],
    };
  },
});

test("固定91表按多批稳定NDJSON流式写入，摘要和异常清单不含原始敏感输入", async () => {
  await withTemp(async (root) => {
    const rowsByTable = {
      person: [
        [row({ id: "person-a", nickname: "甲" })],
        [row({ id: "person-b", nickname: "乙" })],
      ],
    };
    const first = mockSource({ rowsByTable });
    const firstResult = await new FullBackupSpool({ source: first.source, transformer: transformer({
      anomaly: (input) => input.exportValues.id === "person-b" ? [{ code: "TRANSFORM_VALUE_ANOMALY", tableName: "person", columnName: "nickname", field: "nickname" }] : [],
    }), tempRoot: root, batchSize: 1, columnsFor }).create();
    const firstPerson = firstResult.datasets.find((item) => item.tableName === "person");
    assert.equal(firstResult.mode, "RAW_SOURCE_SPOOL");
    assert.equal(firstResult.snapshotId, "snapshot-fixed");
    assert.equal(firstResult.anomalyCount, "1");
    assert.deepEqual(firstPerson.columns, ["id", "nickname"]);
    assert.equal(firstPerson.rowCount, "2");
    const directory = join(root, firstResult.spoolId);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, firstPerson.spoolFile))).mode & 0o777, 0o600);
    assert.equal(await readFile(join(directory, firstPerson.spoolFile), "utf8"), '{"columns":["id","nickname"]}\n["person-a","甲"]\n["person-b","乙"]\n');
    const anomalyText = await readFile(join(directory, firstResult.anomalyFile), "utf8");
    assert.equal(anomalyText.includes("person-a"), false);
    assert.equal(anomalyText.includes("person-b"), false);
    assert.equal(anomalyText.includes("TRANSFORM_VALUE_ANOMALY"), true);
    assert.deepEqual(JSON.parse(anomalyText), {
      code: "TRANSFORM_VALUE_ANOMALY", tableName: "person", columnName: "nickname", rowNumber: "2", field: "nickname",
    });
    for (const tableName of secretTables) {
      assert.equal(first.calls.count.includes(tableName), false);
      assert.equal(first.calls.stream.includes(tableName), false);
    }
    assert.equal(first.calls.close, 1);

    const second = mockSource({ rowsByTable });
    const secondResult = await new FullBackupSpool({ source: second.source, transformer: transformer(), tempRoot: root, batchSize: 2, columnsFor }).create();
    const secondPerson = secondResult.datasets.find((item) => item.tableName === "person");
    assert.equal(firstPerson.logicalDigest, secondPerson.logicalDigest);
    assert.equal(await readFile(join(root, secondResult.spoolId, secondPerson.spoolFile), "utf8"), '{"columns":["id","nickname"]}\n["person-a","甲"]\n["person-b","乙"]\n');
  });
});

test("提现 AAD 上下文逐行转交，缺少转换列不会静默补 null", async () => {
  await withTemp(async (root) => {
    const context = { withdrawalRecipient: { applicantPersonId: "applicant-only-in-context" } };
    const observed = [];
    const source = mockSource({ rowsByTable: {
      finance_withdrawal_submission: [[row({ finance_document_id: "document" }, { transformContext: context })]],
    } });
    await new FullBackupSpool({ source: source.source, transformer: transformer({ onInput: (input) => observed.push(input.context) }), tempRoot: root, columnsFor }).create();
    assert.deepEqual(observed, [context]);

    const missing = mockSource({ rowsByTable: { person: [[row({ id: "person", nickname: "n" })]] } });
    await assert.rejects(
      () => new FullBackupSpool({ source: missing.source, transformer: transformer({ missing: (input) => input.tableName === "person" }), tempRoot: root, columnsFor }).create(),
      { message: "EXPORT_SPOOL_OUTPUT_COLUMNS_MISMATCH" },
    );
    assert.equal((await readdir(root)).length, 1, "only the successful spool remains after failed cleanup");
    assert.equal(missing.calls.close, 1);
  });
});

test("计数不符或转换失败会关闭快照并只清理本次临时目录", async () => {
  await withTemp(async (root) => {
    const mismatch = mockSource({
      rowsByTable: { person: [[row({ id: "person", nickname: "n" })]] },
      counts: { person: 2 },
    });
    await assert.rejects(
      () => new FullBackupSpool({ source: mismatch.source, transformer: transformer(), tempRoot: root, columnsFor }).create(),
      { message: "EXPORT_SPOOL_ROW_COUNT_MISMATCH" },
    );
    assert.equal((await readdir(root)).length, 0);
    assert.equal(mismatch.calls.close, 1);

    const failed = mockSource({ rowsByTable: { person: [[row({ id: "person", nickname: "n" })]] } });
    await assert.rejects(
      () => new FullBackupSpool({ source: failed.source, transformer: transformer({ fail: (input) => input.tableName === "person" }), tempRoot: root, columnsFor }).create(),
      { message: "SYNTHETIC_TRANSFORM_FAILURE" },
    );
    assert.equal((await readdir(root)).length, 0);
    assert.equal(failed.calls.close, 1);
  });
});
