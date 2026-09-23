import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LocalAttachmentStore } from "../../../api/dist/local-attachment-store.js";
import { PostgresReimbursementSubmissionService } from "../../../api/dist/postgres-reimbursement-submission-service.js";
import { PostgresReimbursementReviewService } from "../../../api/dist/postgres-reimbursement-review-service.js";
import { PostgresReimbursementTransferService } from "../../../api/dist/postgres-reimbursement-transfer-service.js";
import { PostgresReimbursementReversalService } from "../../../api/dist/postgres-reimbursement-reversal-service.js";
import { createTestDatabase } from "../../../api/test/integration/postgres-test-database.mjs";
import { FullBackupBusinessFactsView } from "../../dist/full-backup-business-facts-view.js";
import { FullBackupFinanceWorkbookExporter } from "../../dist/full-backup-finance-workbook-exporter.js";
import { FullBackupSpool } from "../../dist/full-backup-spool.js";
import { FullBackupTransformer, fullBackupOutputColumns } from "../../dist/full-backup-transformer.js";
import { PostgresFullBackupSource } from "../../dist/postgres-full-backup-source.js";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const image = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 164) });
const imageSha256 = createHash("sha256").update(image).digest("hex");
const chunks = (bytes) => (async function* () { yield bytes; })();
const at = new Date("2026-09-21T09:00:00.000Z");
const hq = (personId) => ({ subject: "HEADQUARTERS_FINANCE", personId, scope: "GLOBAL" });
const personal = (personId) => ({ subject: "TEACHING_TEACHER", personId, scope: "SELF" });

const addPerson = (pool, id, nickname) => pool.query(
  "INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,'合成人员','ACTIVE')", [id, nickname],
);
const addAccount = async (pool, ownerType, ownerId, code, balance) => {
  const id = randomUUID();
  await pool.query("INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,$2,$3::uuid,$4,'ACTIVE')", [id, ownerType, ownerId, code]);
  await pool.query("INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1::uuid,$2::bigint)", [id, String(balance)]);
  return id;
};
const addEvidence = async (pool, store, documentId, purpose) => {
  const attachmentId = randomUUID(), versionId = randomUUID();
  await store.put({ versionId, originalFilename: `${purpose}.png`, declaredMediaType: "image/png", declaredSizeBytes: image.length, expectedSha256: imageSha256 }, chunks(image));
  await pool.query(
    "INSERT INTO finance_attachment(id,finance_document_id,purpose,created_by_person_id,created_at) SELECT $1::uuid,$2::uuid,$3,applicant_person_id,$4::timestamptz FROM finance_document WHERE id=$2::uuid",
    [attachmentId, documentId, purpose, at.toISOString()],
  );
  await pool.query(
    `INSERT INTO finance_attachment_version(id,finance_attachment_id,version_no,status,original_filename,declared_media_type,declared_size_bytes,expected_sha256,detected_media_type,actual_size_bytes,sha256,uploaded_by_person_id,created_at,ready_at)
     SELECT $1::uuid,$2::uuid,1,'READY',$3,'image/png',$4::bigint,$5,'image/png',$4::bigint,$5,applicant_person_id,$6::timestamptz,$6::timestamptz FROM finance_document WHERE id=$7::uuid`,
    [versionId, attachmentId, `${purpose}.png`, image.length, imageSha256, at.toISOString(), documentId],
  );
  return versionId;
};

const createCompletedReimbursement = async (pool, store) => {
  const applicantId = randomUUID(), financeId = randomUUID(), fundId = randomUUID();
  await addPerson(pool, applicantId, "facts-view-applicant");
  await addPerson(pool, financeId, "facts-view-finance");
  const destinationAccountId = await addAccount(pool, "PERSON", applicantId, `person:${applicantId}`, 20);
  const sourceAccountId = await addAccount(pool, "COMPANY", fundId, `company:fund:${fundId}`, 100);
  const roleAssignmentId = randomUUID();
  await pool.query(
    "INSERT INTO role_assignment(id,person_id,subject_code,scope_type,scope_id,valid_from,valid_to,created_by,created_at) VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'2026-01-01T00:00:00.000Z',NULL,$2::uuid,'2026-01-01T00:00:00.000Z')",
    [roleAssignmentId, financeId],
  );
  await pool.query(
    "INSERT INTO company_finance_fund(id,kind,fund_code,display_name,organization_unit_id,status,version,created_by_person_id,created_at,updated_at) VALUES($1::uuid,'HEADQUARTERS_FINANCE_OPERATING','HQ_FACTS_VIEW','普通报销财务账户',NULL,'ACTIVE',1,$2::uuid,$3::timestamptz,$3::timestamptz)",
    [fundId, financeId, at.toISOString()],
  );
  const fundAssignmentId = randomUUID();
  await pool.query(
    "INSERT INTO company_finance_fund_assignment(id,fund_id,duty_subject,scope_type,scope_id,responsibility_code,valid_from,valid_to,created_by_person_id,created_at) VALUES($1::uuid,$2::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'FINANCE_OPERATING_SOURCE','2026-01-01T00:00:00.000Z',NULL,$3::uuid,$4::timestamptz)",
    [fundAssignmentId, fundId, financeId, at.toISOString()],
  );
  const documentId = randomUUID();
  await pool.query(
    "INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at) VALUES($1::uuid,$2::uuid,'REIMBURSEMENT','DRAFT',1,$3::timestamptz,$3::timestamptz)",
    [documentId, applicantId, at.toISOString()],
  );
  await pool.query(
    `INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,created_at)
     VALUES($1::uuid,'CREATED',$2::uuid,1,$3::timestamptz)`, [documentId, applicantId, at.toISOString()],
  );
  const attachmentVersionIds = await Promise.all([
    addEvidence(pool, store, documentId, "SUPPORTING_DOCUMENT"),
    addEvidence(pool, store, documentId, "APPLICATION_SCREENSHOT"),
  ]);
  const submissions = new PostgresReimbursementSubmissionService(pool, store);
  const reviews = new PostgresReimbursementReviewService(pool, store);
  const transfer = new PostgresReimbursementTransferService(pool, store);
  await submissions.submit(personal(applicantId), documentId, {
    expectedVersion: 1, amountCents: "150", reason: "facts view ordinary reimbursement", attachmentVersionIds,
  }, `submit-${documentId}`, at);
  await reviews.approve(hq(financeId), documentId, { expectedVersion: 2, reason: "approved for facts view" }, `approve-${documentId}`, at);
  await transfer.execute(hq(financeId), documentId, { expectedVersion: 3 }, `execute-${documentId}`, at);
  return { applicantId, financeId, fundId, fundAssignmentId, roleAssignmentId, sourceAccountId, destinationAccountId, documentId };
};

const sourceRows = async (view, sourceTable) => {
  const rows = [];
  for await (const row of view.readSourceRows(4, sourceTable)) rows.push(row);
  return rows;
};
const valuesByColumn = (source, row) => Object.fromEntries(source.columns.map((column, index) => [column.sourceColumn, row.values[index]]));

const workbookSheets = async (workbook) => {
  const { stdout } = await run("python3", ["-c", `import zipfile,xml.etree.ElementTree as E,json,sys
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
book=E.fromstring(z.read('xl/workbook.xml')); rels=E.fromstring(z.read('xl/_rels/workbook.xml.rels')); targets={r.attrib['Id']:r.attrib['Target'] for r in rels}; out={}
for s in book.findall('.//m:sheet',ns):
 root=E.fromstring(z.read('xl/'+targets[s.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]))
 assert not root.findall('.//m:f',ns); rows=[]
 for row in root.findall('.//m:row',ns):
  cells=row.findall('m:c',ns); assert all(c.attrib.get('t')=='inlineStr' for c in cells); rows.append([c.find('.//m:t',ns).text or '' for c in cells])
 out[s.attrib['name']]=rows
print(json.dumps(out,ensure_ascii=False))`, workbook]);
  return JSON.parse(stdout);
};

const workbookSource = (sheets, sourceIndex) => Object.entries(sheets).find(([name]) => name.startsWith(`T4_${String(sourceIndex + 1).padStart(2, "0")}_`))?.[1];

for (const reverseOriginal of [false, true]) test(`real ordinary-reimbursement table-4 XLSX preserves transfer and reversal=${reverseOriginal}`, async () => {
  const database = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "alliance-business-facts-view-pg-"));
  try {
    const store = await LocalAttachmentStore.create(root, resolve(import.meta.dirname, "../../../.."));
    const expected = await createCompletedReimbursement(database.pool, store);
    if (reverseOriginal) {
      await new PostgresReimbursementReversalService(database.pool).reverse(hq(expected.financeId), expected.documentId,
        { expectedVersion: 4, reason: "原笔报销更正" }, `reverse-${expected.documentId}`, new Date(at.getTime() + 1000));
    }
    const spool = await new FullBackupSpool({
      source: new PostgresFullBackupSource(database.pool),
      transformer: new FullBackupTransformer({ fingerprint: ({ domain, value }) => createHash("sha256").update(`${domain}:${value}`).digest("hex") }),
      tempRoot: join(root, "spool"), batchSize: 1,
    }).create();
    const view = new FullBackupBusinessFactsView({ spoolDirectory: join(root, "spool", spool.spoolId), spool });
    const description = view.describe(4);
    assert.equal(description.mode, "BUSINESS_FACTS_VIEW");
    assert.equal(description.complete, false);
    assert.equal(description.schemaVersion, "full-backup-business-schema.v4");
    assert.equal(description.rowModel, "SOURCE_ROWS_ONLY");
    assert.equal(JSON.stringify(description).includes(root), false);
    assert.equal(new Set(description.sources.map((source) => source.sourceTable)).size, description.sources.length, "sources are independent, never joined");
    const transferSource = description.sources.find((source) => source.sourceTable === "finance_reimbursement_transfer");
    assert.deepEqual(transferSource.rowKeyColumns, ["finance_document_id"]);
    assert.deepEqual(transferSource.columns.map((column) => column.sourceColumn), fullBackupOutputColumns("finance_reimbursement_transfer"));
    const transferRows = await sourceRows(view, "finance_reimbursement_transfer");
    assert.equal(transferRows.length, 1, "one persisted transfer remains one source row");
    assert.equal(transferRows[0].sourceRecordKey, `[["finance_document_id","${expected.documentId}"]]`);
    const transfer = valuesByColumn(transferSource, transferRows[0]);
    assert.deepEqual({
      finance_document_id: transfer.finance_document_id,
      role_assignment_id: transfer.role_assignment_id,
      company_fund_assignment_id: transfer.company_fund_assignment_id,
      source_fund_id: transfer.source_fund_id,
      source_account_id: transfer.source_account_id,
      destination_account_id: transfer.destination_account_id,
      amount_cents: transfer.amount_cents,
      source_before_cents: transfer.source_before_cents,
      source_after_cents: transfer.source_after_cents,
      destination_before_cents: transfer.destination_before_cents,
      destination_after_cents: transfer.destination_after_cents,
    }, {
      finance_document_id: expected.documentId,
      role_assignment_id: expected.roleAssignmentId,
      company_fund_assignment_id: expected.fundAssignmentId,
      source_fund_id: expected.fundId,
      source_account_id: expected.sourceAccountId,
      destination_account_id: expected.destinationAccountId,
      amount_cents: "150",
      source_before_cents: "100",
      source_after_cents: "-50",
      destination_before_cents: "20",
      destination_after_cents: "170",
    });
    const authorization = JSON.parse(transfer.authorization_snapshot);
    assert.deepEqual([authorization.executorPersonId, authorization.sourceAccountId, authorization.destinationAccountId], [expected.financeId, expected.sourceAccountId, expected.destinationAccountId]);

    const bindingSource = description.sources.find((source) => source.sourceTable === "finance_reimbursement_attachment_binding");
    assert.deepEqual(bindingSource.rowKeyColumns, ["finance_document_id", "stage", "finance_attachment_version_id"]);
    const bindings = await sourceRows(view, "finance_reimbursement_attachment_binding");
    assert.equal(bindings.length, 2);
    assert.equal(new Set(bindings.map((row) => row.sourceRecordKey)).size, 2, "each attachment binding remains a separate source row");
    assert.equal(bindings.every((row) => valuesByColumn(bindingSource, row).document_version === "2"), true);

    const commandSource = description.sources.find((source) => source.sourceTable === "finance_reimbursement_command_idempotency");
    assert.deepEqual(commandSource.rowKeyColumns, ["actor_person_id", "operation", "idempotency_key_fingerprint"]);
    const commands = await sourceRows(view, "finance_reimbursement_command_idempotency");
    assert.equal(commands.length, reverseOriginal ? 4 : 3);
    assert.deepEqual(commands.map((row) => valuesByColumn(commandSource, row).operation).sort(), reverseOriginal ? ["APPROVE", "EXECUTE", "REVERSE", "SUBMIT"] : ["APPROVE", "EXECUTE", "SUBMIT"]);
    assert.equal(commands.every((row) => valuesByColumn(commandSource, row).finance_document_id === expected.documentId), true);
    assert.equal(commands.every((row) => valuesByColumn(commandSource, row).idempotency_key_fingerprint?.length === 64), true);
    await assert.rejects(async () => sourceRows(view, "ledger_entry"), /EXPORT_BUSINESS_FACTS_SOURCE_NOT_DECLARED/);

    const workbook = await new FullBackupFinanceWorkbookExporter({
      spoolDirectory: join(root, "spool", spool.spoolId), spool, outputRoot: join(root, "workbooks"),
    }).export();
    assert.equal(workbook.mode, "BUSINESS_FACTS_WORKBOOK");
    assert.equal(workbook.complete, false);
    assert.deepEqual(workbook.coveredTables, [4]);
    assert.equal(workbook.file, "business-table-4-finance-facts.xlsx");
    assert.equal(workbook.snapshotId, spool.snapshotId);
    assert.equal(workbook.asOf, spool.asOf);
    assert.equal(workbook.sourceRows.find((source) => source.sourceTable === "finance_reimbursement_transfer")?.rowCount, "1");
    const sheets = await workbookSheets(join(root, "workbooks", workbook.outputId, workbook.file));
    assert.equal(sheets["00_说明"].some((row) => row[0] === "完整备份" && row[1] === "false"), true);
    assert.equal(sheets["00_说明"].some((row) => row[0] === "处理边界" && row[1].includes("不跨源关联")), true);
    for (const [index, source] of description.sources.entries()) {
      const rows = workbookSource(sheets, index);
      assert.ok(rows, `${source.sourceTable} has an independent table-4 XLSX sheet`);
      assert.deepEqual(rows[0], ["源记录键", "源行号", ...source.columns.map((column) => `${column.label} [${column.sourceColumn}]`)]);
    }
    if (reverseOriginal) {
      const reverseIndex = description.sources.findIndex((source) => source.sourceTable === "finance_reimbursement_reversal");
      const reverseRows = await sourceRows(view, "finance_reimbursement_reversal");
      assert.equal(reverseRows.length, 1);
      const reversed = valuesByColumn(description.sources[reverseIndex], reverseRows[0]);
      assert.equal(reversed.finance_document_id, expected.documentId);
      assert.equal(reversed.original_ledger_event_id, transfer.ledger_event_id);
      assert.notEqual(reversed.reversal_ledger_event_id, transfer.ledger_event_id);
      assert.deepEqual([reversed.amount_cents, reversed.source_before_cents, reversed.source_after_cents,
        reversed.destination_before_cents, reversed.destination_after_cents], ["150", "-50", "100", "170", "20"]);
      assert.deepEqual(JSON.parse(reversed.authorization_snapshot).originalTransferAuthorization, authorization);
      const reverseSheet = workbookSource(sheets, reverseIndex);
      assert.equal(reverseSheet.length, 2);
      for (const [column, value] of Object.entries(reversed)) {
        const index = reverseSheet[0].findIndex((header) => header.endsWith(`[${column}]`));
        assert.ok(index >= 0);
        assert.equal(reverseSheet[1][index], value ?? "", column);
      }
      assert.equal(workbook.sourceRows.find((source) => source.sourceTable === "finance_reimbursement_reversal").rowCount, "1");
    }
    const transferIndex = description.sources.findIndex((source) => source.sourceTable === "finance_reimbursement_transfer");
    const transferSheet = workbookSource(sheets, transferIndex);
    assert.ok(transferSheet);
    const transferHeader = transferSheet[0];
    const transferRow = transferSheet[1];
    const spreadsheetValue = (column) => transferRow[transferHeader.findIndex((header) => header.endsWith(`[${column}]`))];
    assert.equal(transferRow[0], transferRows[0].sourceRecordKey);
    assert.deepEqual({
      finance_document_id: spreadsheetValue("finance_document_id"), role_assignment_id: spreadsheetValue("role_assignment_id"),
      company_fund_assignment_id: spreadsheetValue("company_fund_assignment_id"), source_fund_id: spreadsheetValue("source_fund_id"),
      source_account_id: spreadsheetValue("source_account_id"), destination_account_id: spreadsheetValue("destination_account_id"),
      amount_cents: spreadsheetValue("amount_cents"), source_before_cents: spreadsheetValue("source_before_cents"),
      source_after_cents: spreadsheetValue("source_after_cents"), destination_before_cents: spreadsheetValue("destination_before_cents"),
      destination_after_cents: spreadsheetValue("destination_after_cents"),
    }, {
      finance_document_id: expected.documentId, role_assignment_id: expected.roleAssignmentId,
      company_fund_assignment_id: expected.fundAssignmentId, source_fund_id: expected.fundId,
      source_account_id: expected.sourceAccountId, destination_account_id: expected.destinationAccountId,
      amount_cents: "150", source_before_cents: "100", source_after_cents: "-50",
      destination_before_cents: "20", destination_after_cents: "170",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await database.close();
  }
});
