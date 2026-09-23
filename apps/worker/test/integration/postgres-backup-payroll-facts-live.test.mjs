import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTestDatabase } from '../../../api/test/integration/postgres-test-database.mjs';
import { LocalAttachmentStore, PostgresFinanceAttachmentService, PostgresFinanceAttachmentUploadService, PostgresSalaryBenefitsService } from '../../../api/dist/main.js';
import { FullBackupSpool } from '../../dist/full-backup-spool.js';
import { FullBackupTransformer } from '../../dist/full-backup-transformer.js';
import { PostgresFullBackupSource } from '../../dist/postgres-full-backup-source.js';
import { FullBackupBusinessFactsView } from '../../dist/full-backup-business-facts-view.js';
import { FullBackupPayrollWorkbookExporter } from '../../dist/full-backup-payroll-workbook-exporter.js';

test('payroll backup preserves plan, cash posting, bonus and reversal relationships at one snapshot', async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), 'alliance-payroll-backup-pg-'));
  try {
    const [financeId, teacherId, fundId, sourceAccount, personalAccount] = Array.from({ length: 5 }, () => randomUUID());
    const at = new Date('2026-09-23T00:00:00.000Z');
    const context = { personId: financeId, subject: 'HEADQUARTERS_FINANCE', scope: 'GLOBAL' };
    for (const [id, name] of [[financeId, 'backup-finance'], [teacherId, 'backup-teacher']])
      await db.pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1,$2,$2,'ACTIVE')", [id, name]);
    await db.pool.query("INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1,'COMPANY',$2,$3,'ACTIVE'),($4,'PERSON',$5,$6,'ACTIVE')", [sourceAccount, fundId, `company:${fundId}`, personalAccount, teacherId, `person:${teacherId}`]);
    await db.pool.query('INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1,20000),($2,6000)', [sourceAccount, personalAccount]);
    await db.pool.query("INSERT INTO company_finance_fund(id,kind,fund_code,display_name,status,version,created_by_person_id,created_at,updated_at) VALUES($1,'HEADQUARTERS_FINANCE_OPERATING','BACKUP_PAYROLL','Synthetic fund','ACTIVE',1,$2,$3,$3)", [fundId, financeId, at]);
    await db.pool.query("INSERT INTO company_finance_fund_assignment(id,fund_id,duty_subject,scope_type,responsibility_code,valid_from,created_by_person_id,created_at) VALUES($1,$2,'HEADQUARTERS_FINANCE','GLOBAL','FINANCE_OPERATING_SOURCE',$3,$4,$3)", [randomUUID(), fundId, new Date(at.getTime() - 1000), financeId]);
    const store = await LocalAttachmentStore.create(join(root, 'attachments'), resolve(import.meta.dirname, '../../../..'));
    const service = new PostgresSalaryBenefitsService(db.pool, store);
    const attachments = new PostgresFinanceAttachmentService(db.pool);
    const uploads = new PostgresFinanceAttachmentUploadService(db.pool, store);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4AWP8DwQMQMDEAAUAPfgEADYYS7QAAAAASUVORK5CYII=', 'base64');
    const evidence = async documentId => {
      const ids = [];
      for (const purpose of ['SUPPORTING_DOCUMENT', 'APPLICATION_SCREENSHOT']) {
        const file = await attachments.reserve(context, documentId, { purpose, originalFilename: `${purpose}.png`, declaredMediaType: 'image/png', declaredSizeBytes: png.length }, `${documentId}-${purpose}`, at);
        await uploads.upload(context, file.versionId, (async function* () { yield png; })(), at);
        ids.push(file.versionId);
      }
      return ids;
    };
    const plan = await service.setCashWagePlan(context, { teacherPersonId: teacherId, salaryMonth: '2026-09-01', plannedCashCents: '4900', plannedDeductionCents: '4900', active: true, reason: 'September wage' }, 'plan', at);
    const futurePlan = await service.setCashWagePlan(context, { teacherPersonId: teacherId, salaryMonth: '2026-10-01', plannedCashCents: '5300', plannedDeductionCents: '5300', active: true, reason: 'Future plan only' }, 'future-plan', at);
    const todos = await service.generateCashWageTodos(context, 'generate', at);
    assert.equal(todos.length, 1);
    const wage = await service.createEvidenceDocument(context, 'CASH_WAGE', 'wage-doc', at);
    await service.confirmCashWage(context, { documentId: wage.id, expectedVersion: 1, todoId: todos[0].id, cashPaidCents: '4900', deductionCents: '4900', paidAt: at.toISOString(), reason: 'Cash paid', attachmentVersionIds: await evidence(wage.id) }, 'wage-confirm', at);
    const project = (await db.pool.query('SELECT id,display_name FROM bonus_project_name_version WHERE project_no=1 ORDER BY version_no DESC LIMIT 1')).rows[0];
    const bonus = await service.createEvidenceDocument(context, 'PROJECT_BONUS', 'bonus-doc', at);
    await service.grantBonus(context, { documentId: bonus.id, expectedVersion: 1, projectNo: 1, projectName: project.display_name, projectNameVersionId: project.id, recipientPersonId: teacherId, sourceFundId: fundId, amountCents: '100', reason: 'Bonus', attachmentVersionIds: await evidence(bonus.id) }, 'bonus', at);
    const reversal = await service.createEvidenceDocument(context, 'PROJECT_BONUS', 'reversal-doc', at);
    await service.reversePosting(context, { originalDocumentId: bonus.id, reversalDocumentId: reversal.id, expectedOriginalVersion: 2, expectedReversalVersion: 1, reason: 'Correction', attachmentVersionIds: await evidence(reversal.id) }, 'reverse', at);
    const spool = await new FullBackupSpool({ source: new PostgresFullBackupSource(db.pool), transformer: new FullBackupTransformer({ fingerprint: ({ domain, value }) => createHash('sha256').update(`${domain}:${value}`).digest('hex') }), tempRoot: join(root, 'spool'), batchSize: 1 }).create();
    // A subsequent plan version must not be included in the frozen business view.
    await service.setCashWagePlan(context, { teacherPersonId: teacherId, salaryMonth: '2026-10-01', plannedCashCents: '9999', plannedDeductionCents: '9999', active: true, reason: 'After snapshot' }, 'later-plan', at);
    const view = new FullBackupBusinessFactsView({ spoolDirectory: join(root, 'spool', spool.spoolId), spool });
    const description = view.describe(5);
    const read = async sourceTable => {
      const source = description.sources.find(row => row.sourceTable === sourceTable);
      assert.ok(source, sourceTable);
      const result = [];
      for await (const row of view.readSourceRows(5, sourceTable)) result.push(Object.fromEntries(source.columns.map((column, index) => [column.sourceColumn, row.values[index]])));
      return result;
    };
    const plans = await read('cash_wage_plan_version');
    assert.equal(plans.length, 2);
    assert.equal(plans.find(row => row.id === futurePlan.planVersionId).planned_cash_cents, '5300');
    const exportedTodos = await read('cash_wage_todo');
    assert.equal(exportedTodos.length, 1);
    assert.equal(exportedTodos[0].plan_version_id, plan.planVersionId);
    const confirmations = await read('cash_wage_confirmation');
    assert.equal(confirmations.length, 1, 'A future plan is not a cash payment');
    assert.equal(confirmations[0].finance_document_id, wage.id);
    assert.equal(confirmations[0].todo_id, todos[0].id);
    assert.equal(confirmations[0].teacher_person_id, teacherId);
    assert.equal(confirmations[0].destination_account_id, personalAccount);
    const bonuses = await read('project_bonus_transfer');
    assert.equal(bonuses.length, 1);
    assert.equal(bonuses[0].source_account_id, sourceAccount);
    assert.equal(bonuses[0].destination_account_id, personalAccount);
    assert.equal(bonuses[0].project_name_version_id, project.id);
    const reversals = await read('salary_benefit_reversal');
    assert.equal(reversals.length, 1);
    assert.equal(reversals[0].original_finance_document_id, bonus.id);
    assert.equal(reversals[0].reversal_finance_document_id, reversal.id);
    assert.equal(reversals[0].original_ledger_event_id, bonuses[0].ledger_event_id);
    const documents = await read('finance_document');
    assert.equal(documents.find(row => row.id === bonus.id).status, 'REVERSED');
    assert.equal(documents.find(row => row.id === wage.id).status, 'COMPLETED');
    const entries = await read('ledger_entry');
    assert.deepEqual(entries.filter(row => row.event_id === bonuses[0].ledger_event_id).map(row => row.amount_cents).sort(), ['-100', '100']);
    assert.deepEqual(entries.filter(row => row.event_id === reversals[0].reversal_ledger_event_id).map(row => row.amount_cents).sort(), ['-100', '100']);
    assert.equal(entries.filter(row => row.event_id === confirmations[0].ledger_event_id).reduce((sum, row) => sum + BigInt(row.amount_cents), 0n), -4900n);
    const workbook = await new FullBackupPayrollWorkbookExporter({ spoolDirectory: join(root, 'spool', spool.spoolId), spool, outputRoot: join(root, 'workbooks') }).export();
    assert.equal(workbook.mode, 'BUSINESS_FACTS_WORKBOOK');
    assert.equal(workbook.complete, false);
    assert.deepEqual(workbook.coveredTables, [5]);
    assert.equal(workbook.snapshotId, spool.snapshotId);
    assert.equal(workbook.asOf, spool.asOf);
    assert.equal(workbook.schemaVersion, description.schemaVersion);
    assert.equal(JSON.stringify(workbook).includes(root), false);
    const directory = join(root, 'workbooks', workbook.outputId);
    assert.deepEqual(await readdir(directory), [workbook.file]);
    const path = join(directory, workbook.file);
    const bytes = await readFile(path);
    assert.equal(workbook.sizeBytes, String(bytes.length));
    assert.equal(workbook.sha256, createHash('sha256').update(bytes).digest('hex'));
    const { stdout } = await promisify(execFile)('python3', ['-c', `import zipfile,xml.etree.ElementTree as E,json,sys
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
book=E.fromstring(z.read('xl/workbook.xml')); rels=E.fromstring(z.read('xl/_rels/workbook.xml.rels'))
targets={r.attrib['Id']:r.attrib['Target'] for r in rels}; out={}
for s in book.findall('.//m:sheet',ns):
 root=E.fromstring(z.read('xl/'+targets[s.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]))
 assert not root.findall('.//m:f',ns)
 rows=[]
 for row in root.findall('.//m:row',ns):
  cells=row.findall('m:c',ns); assert all(c.attrib.get('t')=='inlineStr' for c in cells)
  rows.append([c.find('.//m:t',ns).text or '' for c in cells])
 out[s.attrib['name']]=rows
print(json.dumps(out,ensure_ascii=False))`, path], { maxBuffer: 8 * 1024 * 1024 });
    const sheets = JSON.parse(stdout);
    for (const source of description.sources) {
      const header = ['源记录键', '源行号', ...source.columns.map(column => `${column.label} [${column.sourceColumn}]`)];
      const sheet = Object.values(sheets).find(rows => JSON.stringify(rows[0]) === JSON.stringify(header));
      assert.ok(sheet, source.sourceTable);
      const expected = [];
      for await (const row of view.readSourceRows(5, source.sourceTable)) expected.push([row.sourceRecordKey, row.rowNumber, ...row.values.map(value => value ?? '')]);
      assert.deepEqual(sheet.slice(1), expected, source.sourceTable);
      assert.equal(workbook.sourceRows.find(row => row.sourceTable === source.sourceTable).rowCount, String(expected.length));
      assert.equal(workbook.sourceRows.find(row => row.sourceTable === source.sourceTable).logicalDigest, spool.datasets.find(row => row.tableName === source.sourceTable).logicalDigest);
    }
    assert.ok(JSON.stringify(sheets['00_说明']).includes('未按工资或奖金筛选'));
    assert.equal(JSON.stringify(sheets).includes('After snapshot'), false);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});
