import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ZipStoreWriter } from '../dist/zip-store-writer.js';
import { writeXlsx } from '../dist/openxml-xlsx-writer.js';

async function workspace(work){const dir=await fs.mkdtemp(join(tmpdir(),'alliance-zip-fault-'));try{await work(dir);}finally{await fs.rm(dir,{recursive:true,force:true});}}
function verify(file,expected){const result=JSON.parse(execFileSync('python3',['-c',`import zipfile,json,sys\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert z.testzip() is None\n print(json.dumps({n:z.read(n).decode('utf8') for n in z.namelist()}))`,file],{encoding:'utf8'}));assert.deepEqual(result,expected);}
test('ZIP发布竞态不覆盖别人刚写入的文件',async()=>workspace(async dir=>{
 const file=join(dir,'out.zip');const zip=await ZipStoreWriter.create(file);await zip.addEntry('业务.txt',['本次']);await fs.writeFile(file,'外部文件');await assert.rejects(zip.close(),{code:'EEXIST'});assert.equal(await fs.readFile(file,'utf8'),'外部文件');assert.deepEqual(await fs.readdir(dir),['out.zip']);
}));
test('ZIP短写循环后CRC和内容正确，零写立即失败并可清理',async()=>workspace(async dir=>{
 for(const zero of [false,true]){
  const original=fs.open;let writes=0;
  fs.open=async(...args)=>{const handle=await original(...args);return new Proxy(handle,{get(target,key){if(key==='write')return async(buffer,offset=0,length=buffer.length)=>{writes++;if(zero)return {bytesWritten:0,buffer};return target.write(buffer,offset,Math.min(length,3));};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});};
  const file=join(dir,zero?'zero.zip':'short.zip');let zip;
  try{zip=await ZipStoreWriter.create(file);if(zero){await assert.rejects(zip.addEntry('文本.txt',['完整文本']),/no progress/);await zip.abort();assert.equal((await fs.readdir(dir)).includes('zero.zip'),false);}else{await zip.addEntry('文本.txt',['完整文本']);await zip.close();assert.ok(writes>10);verify(file,{'文本.txt':'完整文本'});}}finally{fs.open=original;}
 }
}));
test('ZIP完整发布后临时清理故障仍返回成功，产物可独立校验',async()=>workspace(async dir=>{
 const file=join(dir,'success.zip');const zip=await ZipStoreWriter.create(file);await zip.addEntry('a.txt',['完整']);const original=fs.unlink;fs.unlink=async()=>{throw Object.assign(new Error('injected'),{code:'EIO'});};try{await zip.close();}finally{fs.unlink=original;}verify(file,{'a.txt':'完整'});assert.equal((await fs.stat(file)).mode&0o777,0o600);
}));
test('ZIP严格拒绝路径歧义与重复条目',async()=>workspace(async dir=>{
 const zip=await ZipStoreWriter.create(join(dir,'paths.zip'));try{for(const name of ['/absolute','C:/escape','a\\b','a/../b','a/./b','a//b','a/','\0bad','a\nb','.','../x'])await assert.rejects(zip.addEntry(name,['x']),/invalid ZIP/);await zip.addEntry('valid/file.txt',['ok']);await assert.rejects(zip.addEntry('valid/file.txt',['new']),/duplicate/);await zip.close();verify(join(dir,'paths.zip'),{'valid/file.txt':'ok'});}finally{await zip.abort();}
}));
test('Excel数据流中途失败不发布且清理所有临时文件',async()=>workspace(async dir=>{
 const file=join(dir,'failed.xlsx');async function* rows(){yield ['已读行'];throw new Error('SOURCE_READ_FAILED');}await assert.rejects(writeXlsx({outputPath:file,sheets:[{name:'sheet',rows:rows()}]}),/SOURCE_READ_FAILED/);assert.deepEqual(await fs.readdir(dir),[]);
}));
