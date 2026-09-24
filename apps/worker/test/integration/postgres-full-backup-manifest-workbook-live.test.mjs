import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { fixture } from '../../../api/test/integration/refund-review-fixture.mjs';
import { FullBackupDerivedSpoolIndex } from '../../dist/full-backup-derived-spool-index.js';
import { FullBackupLedgerBusinessPeriodSource } from '../../dist/full-backup-ledger-business-period-source.js';
import { FullBackupLedgerDerivedView } from '../../dist/full-backup-ledger-derived-view.js';
import { FullBackupManifestEvidence } from '../../dist/full-backup-manifest-evidence.js';
import { createFullBackupManifestContext } from '../../dist/full-backup-manifest.js';
import { FullBackupWorkbookExporter } from '../../dist/full-backup-workbook-exporter.js';
import { FullBackupSpool } from '../../dist/full-backup-spool.js';
import { FullBackupTransformer } from '../../dist/full-backup-transformer.js';
import { PostgresFullBackupSource } from '../../dist/postgres-full-backup-source.js';
const run=promisify(execFile);
test('real PG microsecond cutoff and approved refund survive all RAW workbook manifests',async()=>{
 const f=await fixture();const root=await mkdtemp(join(tmpdir(),'manifest-workbook-pg-'));
 let index,ledger,periods;
 try{
  const document=await f.pending();await f.approve(document,'manifest-workbook-refund');
  const spool=await new FullBackupSpool({source:new PostgresFullBackupSource(f.pool),transformer:new FullBackupTransformer({fingerprint:({domain,value})=>createHash('sha256').update(`${domain}\0${value}`).digest('hex')}),tempRoot:join(root,'spool'),batchSize:1}).create();
  const spoolDirectory=join(root,'spool',spool.spoolId);
  index=await FullBackupDerivedSpoolIndex.create({spoolDirectory,spool,attemptRoot:join(root,'index')});
  ledger=await FullBackupLedgerDerivedView.create({index,attemptRoot:join(root,'ledger')});
  periods=await FullBackupLedgerBusinessPeriodSource.create({index,attemptRoot:join(root,'periods')});
  const evidence=await FullBackupManifestEvidence.collect({spoolDirectory,spool,index,ledger,periods});
  const context=createFullBackupManifestContext({evidence,fileGroupId:'real-pg-manifest-group',generatedAt:new Date().toISOString(),applicationVersion:'0.1.0',generatorVersion:'test-1'});
  assert.equal(context.asOf,spool.asOf);
  assert.ok(BigInt(context.money.ledgerEntryCount)>0n);
  const result=await new FullBackupWorkbookExporter({spoolDirectory,spool,outputRoot:join(root,'books'),manifestContext:context}).export();
  assert.equal(result.workbooks.length,13);
  const {stdout}=await run('python3',['-c',`import json,sys,zipfile,hashlib,pathlib,xml.etree.ElementTree as E
root=pathlib.Path(sys.argv[1]); cutoff=sys.argv[2];snapshot=sys.argv[3]
ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'};out=[]
for p in sorted(root.glob('*.xlsx')):
 z=zipfile.ZipFile(p); assert z.testzip() is None
 book=E.fromstring(z.read('xl/workbook.xml'));assert book.find('.//m:sheet',ns).attrib['name']=='00_manifest'
 sheet=E.fromstring(z.read('xl/worksheets/sheet1.xml'))
 values=[t.text or '' for t in sheet.findall('.//m:t',ns)]
 assert cutoff in values and snapshot in values
 assert 'INCOMPLETE_IMPLEMENTATION' in values and 'NOT_ASSERTED' in values
 assert not sheet.findall('.//m:f',ns)
 out.append({'file':p.name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'sizeBytes':str(p.stat().st_size)})
print(json.dumps(out))`,join(root,'books',result.outputId),spool.asOf,spool.snapshotId]);
  for(const actual of JSON.parse(stdout)){
   const expected=result.workbooks.find(x=>x.file===actual.file);
   assert.equal(actual.sha256,expected.sha256);assert.equal(actual.sizeBytes,expected.sizeBytes);
  }
 }finally{await periods?.close();await ledger?.close();await index?.close();await rm(root,{recursive:true,force:true});await f.close();}
});
