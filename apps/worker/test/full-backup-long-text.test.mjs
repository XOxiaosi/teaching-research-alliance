import test from 'node:test';
import assert from 'node:assert/strict';
import {splitBackupLongText,restoreBackupLongText} from '../dist/full-backup-long-text.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeXlsx} from '../dist/openxml-xlsx-writer.js';

test('large audit JSON survives chunks without splitting emoji or normalizing its text',()=>{
  const raw='x'.repeat(31999)+'😀'+JSON.stringify({text:'原文\r\n'.repeat(10000),number:'00001234567890123456'});
  const split=splitBackupLongText(raw);
  assert.ok(split);
  assert.equal(split.chunks[0].length,31999);
  assert.equal(split.chunks[1].startsWith('😀'),true);
  assert.equal(restoreBackupLongText(split),raw);
  assert.deepEqual(splitBackupLongText(raw),split);
  for(const changed of [{...split,chunks:[...split.chunks].reverse()},{...split,utf16Length:1},{...split,reference:'wrong'},{...split,chunks:split.chunks.slice(1)}])
    assert.throws(()=>restoreBackupLongText(changed),/EXPORT_LONG_TEXT_INTEGRITY_FAILED/);
});
test('normal text remains inline while XML-invalid text fails instead of losing characters',()=>{
  assert.equal(splitBackupLongText('0'.repeat(32000)),null);
  assert.ok(splitBackupLongText('0'.repeat(32001)));
  for(const raw of ['bad\u0000text','\ud800','\udfff','\uffff']) assert.throws(()=>splitBackupLongText(raw),/EXPORT_ILLEGAL_XML_TEXT/);
  assert.equal(splitBackupLongText('=SUM(A1)\t\r\n_x0000_😀'),null);
});
test('real XLSX long-text sheet reads back all chunks in order',async()=>{
  const raw='x'.repeat(31999)+'😀'+('原文\r\n<>="'.repeat(12000));
  const value=splitBackupLongText(raw);
  const dir=await mkdtemp(join(tmpdir(),'backup-long-text-'));
  try {
    const path=join(dir,'long.xlsx');
    await writeXlsx({outputPath:path,sheets:[
      {name:'source',columns:['id','memo'],rows:[['0001',value.reference]]},
      {name:'14_长文本分片',columns:['ref','table','id','field','part_no','part_text'],rows:value.chunks.map((chunk,i)=>[value.reference,'source','0001','memo',String(i+1),chunk])},
    ]});
    const {stdout}=await promisify(execFile)('python3',['-c',`import zipfile,xml.etree.ElementTree as E,sys,json
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
r=E.fromstring(z.read('xl/worksheets/sheet2.xml'))
assert not r.findall('.//m:f',ns)
rows=r.findall('.//m:row',ns)[1:]
parts=[]
for i,row in enumerate(rows):
 cells=row.findall('m:c',ns); assert all(c.get('t')=='inlineStr' for c in cells)
 assert cells[4].find('.//m:t',ns).text==str(i+1)
 parts.append(cells[5].find('.//m:t',ns).text)
print(json.dumps(parts))`,path],{maxBuffer:4*1024*1024});
    assert.equal(restoreBackupLongText({...value,chunks:JSON.parse(stdout)}),raw);
  } finally {await rm(dir,{recursive:true,force:true});}
});
