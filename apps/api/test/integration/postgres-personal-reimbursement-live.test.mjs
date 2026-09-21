import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PNG} from 'pngjs';
import {PostgresPersonalReadService,PostgresCompanyFundService,PostgresSelfPurchaseService,
  PostgresFinanceDraftService,PostgresFinanceAttachmentService,PostgresFinanceAttachmentUploadService,
  PostgresLedgerRepository,PostgresSelfPurchaseReversalService,LocalAttachmentStore} from '../../dist/main.js';
import {postLedgerEvent} from '@teaching-research-alliance/domain';
import {createTestDatabase} from './postgres-test-database.mjs';

test('个人概览按采买完成财年计报销收入，累计余额独立，规划导师及数据损坏边界正确',async()=>{
  const db=await createTestDatabase(process.env.DATABASE_URL),pool=db.pool;
  const root=await mkdtemp(join(tmpdir(),'alliance-personal-reimbursement-'));
  const [person,admin,other]=[randomUUID(),randomUUID(),randomUUID()],account=randomUUID();
  const previousYear=new Date('2026-08-31T15:59:59Z'),currentYear=new Date('2026-08-31T16:00:00Z');
  const personal={personId:person,subject:'PLANNING_MENTOR',scope:'ASSOCIATED_TEACHERS'};
  const adminContext={personId:admin,subject:'SYSTEM_ADMIN',scope:'GLOBAL'};
  try{
    for(const id of [person,admin,other])await pool.query("INSERT INTO person(id,nickname,legal_name,status) VALUES($1,$2,'合成人员','ACTIVE')",[id,`overview-${id}`]);
    await pool.query("INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1,'PERSON',$2,$3,'ACTIVE')",[account,person,`person:${person}`]);
    await pool.query('INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1,2000)',[account]);
    await pool.query("INSERT INTO role_assignment(person_id,subject_code,scope_type,valid_from,created_by) VALUES($1,'HEADQUARTERS_FINANCE','GLOBAL','2026-01-01',$2)",[person,admin]);
    const funds=new PostgresCompanyFundService(pool);
    const fund=await funds.create(adminContext,{fundCode:'HQ_OVERVIEW_TEST',displayName:'合成资金'},'overview-fund',previousYear);
    await funds.assign(adminContext,{fundId:fund.id,expectedAssignmentId:null,reason:'合成配置'},'overview-map',previousYear);
    const store=await LocalAttachmentStore.create(root,fileURLToPath(new URL('../../../../',import.meta.url)));
    const drafts=new PostgresFinanceDraftService(pool),attachments=new PostgresFinanceAttachmentService(pool),uploads=new PostgresFinanceAttachmentUploadService(pool,store),purchases=new PostgresSelfPurchaseService(pool,store);
    const bytes=PNG.sync.write({width:2,height:2,data:Buffer.alloc(16,150)});
    const purchase=async(label,amountCents,at)=>{
      const document=await drafts.create(personal,{kind:'SELF_PURCHASE'},`${label}-draft`,at),ids=[];
      for(const purpose of ['SUPPORTING_DOCUMENT','APPLICATION_SCREENSHOT']){
        const version=await attachments.reserve(personal,document.id,{purpose,originalFilename:'synthetic.png',declaredMediaType:'image/png',declaredSizeBytes:bytes.length},`${label}-${purpose}`,at);
        await uploads.upload(personal,version.versionId,(async function*(){yield bytes;})(),at);ids.push(version.versionId);
      }
      await purchases.submit(personal,document.id,{expectedVersion:1,amountCents,reason:'合成采买',attachmentVersionIds:ids},`${label}-submit`,at);
      return document.id;
    };
    const oldDocument=await purchase('old','1000',previousYear),newDocument=await purchase('new','10000',currentYear);
    const reversals=new PostgresSelfPurchaseReversalService(pool);
    const oldVersion=(await pool.query('SELECT version::int AS version FROM finance_document WHERE id=$1',[oldDocument])).rows[0].version;
    await reversals.reverse(adminContext,oldDocument,{expectedVersion:oldVersion,reason:'跨财年撤销'},'old-reverse',currentYear);
    const reads=new PostgresPersonalReadService(pool);
    for(const subject of ['PLANNING_MENTOR','TEACHING_TEACHER','ACADEMIC_PLANNER']){
      const current=await reads.getOwnOverview({...personal,subject},currentYear);
      assert.equal(current.balanceCents,12000n);assert.deepEqual(current.currentYearIncomeByCategory,{reimbursementIncome:10000n},'旧财年撤销不能生成本年负收入');
    }
    const old=await reads.getOwnOverview(personal,previousYear);assert.equal(old.balanceCents,12000n);assert.deepEqual(old.currentYearIncomeByCategory,{});
    const next=await reads.getOwnOverview(personal,new Date('2027-08-31T16:00:00Z'));assert.equal(next.balanceCents,12000n);assert.deepEqual(next.currentYearIncomeByCategory,{});
    await assert.rejects(reads.getOwnOverview({...personal,subject:'HEADQUARTERS_FINANCE',scope:'GLOBAL'},currentYear),/FORBIDDEN_SCOPE/);
    await assert.rejects(reads.getOwnOverview({...personal,personId:other},currentYear),/PERSONAL_ACCOUNT_NOT_FOUND/);
    await postLedgerEvent(new PostgresLedgerRepository(pool),{eventKey:'synthetic-wage-deduction',eventType:'SYNTHETIC_DEDUCTION',payloadHash:'synthetic',deltas:[{accountKey:`person:${person}`,categoryKey:'cashWageDeduction',amountCents:-500n}]},randomUUID);
    const after=await reads.getOwnOverview(personal,currentYear);assert.equal(after.balanceCents,11500n);assert.deepEqual(after.currentYearIncomeByCategory,{reimbursementIncome:10000n},'个人概览不展示工资项目或公司支出');
    // A current-year mismatched recipient must not disappear silently when its actual account is still ours.
    await pool.query('ALTER TABLE finance_self_purchase_transfer DISABLE TRIGGER USER');
    await pool.query('UPDATE finance_self_purchase_transfer SET destination_person_id=$2,submitted_by_person_id=$2 WHERE finance_document_id=$1',[newDocument,other]);
    await pool.query('ALTER TABLE finance_self_purchase_transfer ENABLE TRIGGER USER');
    await assert.rejects(reads.getOwnOverview(personal,currentYear),/FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE/);
    await pool.query('ALTER TABLE finance_self_purchase_transfer DISABLE TRIGGER USER');
    await pool.query('UPDATE finance_self_purchase_transfer SET destination_person_id=$2,submitted_by_person_id=$2 WHERE finance_document_id=$1',[newDocument,person]);
    await pool.query('ALTER TABLE finance_self_purchase_transfer ENABLE TRIGGER USER');
    await pool.query('ALTER TABLE ledger_entry DISABLE TRIGGER USER');
    await pool.query("UPDATE ledger_entry SET category_key='corrupt' WHERE event_id=(SELECT ledger_event_id FROM finance_self_purchase_transfer WHERE finance_document_id=$1) AND amount_cents>0",[oldDocument]);
    await pool.query('ALTER TABLE ledger_entry ENABLE TRIGGER USER');
    assert.deepEqual((await reads.getOwnOverview(personal,currentYear)).currentYearIncomeByCategory,{reimbursementIncome:10000n},'旧财年损坏不得阻断当前财年收入');
    await assert.rejects(reads.getOwnOverview(personal,previousYear),/FINANCE_SELF_PURCHASE_DATA_UNAVAILABLE/);
  }finally{await db.close();await rm(root,{recursive:true,force:true});}
});
