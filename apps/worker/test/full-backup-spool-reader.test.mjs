import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {readBackupSpoolDataset} from '../dist/full-backup-spool-reader.js';
import {fullBackupOutputColumns} from '../dist/full-backup-transformer.js';
import {createFullBackupLayout} from '../dist/full-backup-layout.js';
const collect=async iterable=>{const values=[];for await(const row of iterable)values.push(row);return values;};
async function fixture(work){
 const dir=await mkdtemp(join(tmpdir(),'spool-reader-'));
 try {
   await mkdir(join(dir,'datasets'),{mode:0o700});
   const index=createFullBackupLayout().findIndex(item=>item.tableName==='person');
   const file=`datasets/${String(index+1).padStart(3,'0')}_person.ndjson`;
   const columns=fullBackupOutputColumns('person');const rows=[['000000123','中文😀\r\n'],['-1',null]];
   for(const row of rows)while(row.length<columns.length)row.push(null);
   const text=JSON.stringify({columns})+'\n'+rows.map(row=>JSON.stringify(row)+'\n').join('');
   const data={tableName:'person',columns,rowCount:'2',logicalDigest:createHash('sha256').update(text).digest('hex'),spoolFile:file,excluded:false};
   await writeFile(join(dir,file),text,{mode:0o600});await work({dir,file,data,text,rows});
 } finally {await rm(dir,{recursive:true,force:true});}
}
test('streams exact source text and validates count plus byte digest at EOF',async()=>fixture(async({dir,data,rows})=>{
 assert.deepEqual(await collect(readBackupSpoolDataset(dir,data)),rows);
 for(const change of [{rowCount:'1'},{rowCount:'3'},{logicalDigest:'0'.repeat(64)},{columns:['nickname','id']},{spoolFile:'../private'},{excluded:true}])
   await assert.rejects(collect(readBackupSpoolDataset(dir,{...data,...change})),/EXPORT_SPOOL_INTEGRITY_FAILED/);
}));
test('rejects truncated/corrupt bytes and non-text cells even when supplied hash matches',async()=>fixture(async({dir,file,data,text})=>{
 await writeFile(join(dir,file),text.slice(0,-1));await assert.rejects(collect(readBackupSpoolDataset(dir,data)),/EXPORT_SPOOL_INTEGRITY_FAILED/);
 const corrupt=JSON.stringify({columns:data.columns})+'\n[123,"name"]\n';await writeFile(join(dir,file),corrupt);
 await assert.rejects(collect(readBackupSpoolDataset(dir,{...data,rowCount:'1',logicalDigest:createHash('sha256').update(corrupt).digest('hex')})),/EXPORT_SPOOL_INTEGRITY_FAILED/);
}));
test('does not follow a replaced spool file symlink',async()=>fixture(async({dir,file,data,text})=>{
 await rm(join(dir,file));await writeFile(join(dir,'other'),text,{mode:0o600});await symlink(join(dir,'other'),join(dir,file));
 await assert.rejects(collect(readBackupSpoolDataset(dir,data)));
}));
test('rejects self-consistent omitted columns and a symlink root',async()=>fixture(async({dir,file,data})=>{
 const columns=['nickname']; const text=JSON.stringify({columns})+'\n["name"]\n';
 await writeFile(join(dir,file),text);
 await assert.rejects(collect(readBackupSpoolDataset(dir,{...data,columns,rowCount:'1',logicalDigest:createHash('sha256').update(text).digest('hex')})),/EXPORT_SPOOL_INTEGRITY_FAILED/);
 const link=dir+'-link';
 try {await symlink(dir,link);await assert.rejects(collect(readBackupSpoolDataset(link,data)),/EXPORT_SPOOL_INTEGRITY_FAILED/);}
 finally {await rm(link,{force:true});}
}));
