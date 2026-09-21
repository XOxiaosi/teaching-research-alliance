import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readdir, readFile, writeFile, symlink, unlink, chmod, open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {LocalAttachmentStore, AttachmentPublicationError} from '../dist/local-attachment-store.js';

const source=resolve(import.meta.dirname,'../../..');
const pdf=Buffer.from('%PDF-1.7\nsynthetic receipt\n%%EOF');
const png=Buffer.from([137,80,78,71,13,10,26,10,0,0]);
const jpeg=Buffer.from([255,216,255,224,0,1]);
async function* parts(bytes){yield bytes.subarray(0,2);yield bytes.subarray(2,7);yield bytes.subarray(7);}
const draft=(bytes=pdf,mediaType='application/pdf')=>({versionId:randomUUID(),originalFilename:'合成凭证.pdf',declaredMediaType:mediaType,declaredSizeBytes:bytes.length});

test('凭证按不可覆盖版本存放，流式校验内容且读取还原原件',async()=>{
 const root=await mkdtemp(join(tmpdir(),'alliance-attachment-'));
 try{
  const store=await LocalAttachmentStore.create(root,source,100);
  for(const [bytes,type] of [[pdf,'application/pdf'],[png,'image/png'],[jpeg,'image/jpeg']]){
   const input=draft(bytes,type);
   const expectedSha256=createHash('sha256').update(bytes).digest('hex');
   const saved=await store.put({...input,expectedSha256},parts(bytes));
   assert.deepEqual(saved,{versionId:input.versionId,mediaType:type,sizeBytes:bytes.length,sha256:expectedSha256});
   assert.deepEqual(await store.readVerified(saved),bytes);
   assert.deepEqual(await store.reconcilePublished({...input,expectedSha256},async content=>{assert.deepEqual(content,bytes);}),saved);
   await assert.rejects(store.put(input,parts(bytes)),/ATTACHMENT_VERSION_EXISTS/);
   assert.deepEqual(await readFile(join(root,'objects',saved.versionId)),bytes);
  }
  assert.deepEqual(await readdir(join(root,'staging')),[]);
  assert.equal((await readdir(join(root,'objects'))).length,3);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('凭证拒绝伪装格式、越界大小、路径名字、断流和摘要不符并清理临时文件',async()=>{
 const root=await mkdtemp(join(tmpdir(),'alliance-attachment-'));
 try{
  const store=await LocalAttachmentStore.create(root,source,100);
  await assert.rejects(store.reconcilePublished(draft(),async()=>{}),/OBJECT_NOT_FOUND/);
  await assert.rejects(store.put({...draft(),originalFilename:'../receipt.pdf'},parts(pdf)),/METADATA_INVALID/);
  await assert.rejects(store.put({...draft(),versionId:'../escape'},parts(pdf)),/VERSION_INVALID/);
  await assert.rejects(store.put({...draft(),expectedSha256:'0'.repeat(64)},parts(pdf)),/HASH_MISMATCH/);
  await assert.rejects(store.put({...draft(),declaredSizeBytes:pdf.length+1},parts(pdf)),/SIZE_MISMATCH/);
  await assert.rejects(store.put({...draft(),declaredSizeBytes:10},parts(pdf)),/TOO_LARGE/);
  await assert.rejects(store.put({...draft(),declaredSizeBytes:101},parts(pdf)),/METADATA_INVALID/);
  const html=Buffer.from('<html>not a receipt</html>');
  await assert.rejects(store.put(draft(html),parts(html)),/TYPE_INVALID/);
  await assert.rejects(store.put(draft(pdf,'image/png'),parts(pdf)),/TYPE_INVALID/);
  async function* broken(){yield pdf.subarray(0,10);throw new Error('INTERRUPTED');}
  await assert.rejects(store.put(draft(),broken()),/INTERRUPTED/);
  assert.deepEqual(await readdir(join(root,'staging')),[]);
  assert.deepEqual(await readdir(join(root,'objects')),[]);
  await assert.rejects(LocalAttachmentStore.create(source,source),/INSIDE_SOURCE/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('同版本并发只有一份原件，读取篡改、缺失和符号链接全部失败',async()=>{
 const root=await mkdtemp(join(tmpdir(),'alliance-attachment-'));
 try{
  const store=await LocalAttachmentStore.create(root,source,100);
  const input=draft();
  const results=await Promise.allSettled([store.put(input,parts(pdf)),store.put(input,parts(pdf))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.match(results.find(r=>r.status==='rejected').reason.message,/VERSION_EXISTS/);
  const saved=results.find(r=>r.status==='fulfilled').value;
  const path=join(root,'objects',saved.versionId);
  const changed=Buffer.from(pdf);changed[12]^=1;
  await writeFile(path,changed);
  await assert.rejects(store.readVerified(saved),/INTEGRITY_FAILED/);
  await unlink(path);
  await assert.rejects(store.readVerified(saved),/UNAVAILABLE/);
  const other=join(root,'outside.pdf');await writeFile(other,pdf);
  await symlink(other,path);
  await assert.rejects(store.readVerified(saved),/UNAVAILABLE/);
  await assert.rejects(store.put(input,parts(pdf)),/VERSION_EXISTS/);
  assert.deepEqual(await readFile(other),pdf);
  assert.deepEqual(await readdir(join(root,'staging')),[]);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('拒绝不私密目录、符号链接目录及不合理的文件上限',async()=>{
 const root=await mkdtemp(join(tmpdir(),'alliance-attachment-'));
 try{
  await chmod(root,0o777);
  await assert.rejects(LocalAttachmentStore.create(root,source),/PERMISSIONS_INVALID/);
  await chmod(root,0o700);
  await assert.rejects(LocalAttachmentStore.create(root,source,Number.MAX_SAFE_INTEGER),/CONFIG_INVALID/);
  const store=await LocalAttachmentStore.create(root,source);
  await chmod(join(root,'objects'),0o755);
  await assert.rejects(store.put(draft(),parts(pdf)),/PERMISSIONS_INVALID/);
  await chmod(join(root,'objects'),0o700);
  const alias=join(root,'alias');await symlink(join(root,'objects'),alias);
  await assert.rejects(LocalAttachmentStore.create(alias,source),/PATH_INVALID/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('关闭失败仍清临时文件，发布后同步失败返回可识别的原件对账状态',async(t)=>{
 const root=await mkdtemp(join(tmpdir(),'alliance-attachment-'));
 try{
  let mode='close';let syncCount=0;
  const openWithFault=async(...args)=>{
   const file=await open(...args);
   const close=file.close.bind(file);const sync=file.sync.bind(file);
   file.close=async()=>{await close();if(mode==='close')throw new Error('SYNTHETIC_CLOSE_FAILURE');};
   file.sync=async()=>{if(mode==='sync'&&++syncCount===2)throw new Error('SYNTHETIC_DIRECTORY_SYNC_FAILURE');return sync();};
   return file;
  };
  const store=await LocalAttachmentStore.create(root,source,100,openWithFault);
  await assert.rejects(store.put(draft(),parts(pdf)),/SYNTHETIC_CLOSE_FAILURE/);
  mode='sync';
  assert.deepEqual(await readdir(join(root,'staging')),[]);
  assert.deepEqual(await readdir(join(root,'objects')),[]);
  let published;
  await assert.rejects(store.put(draft(),parts(pdf)),error=>{
   assert.ok(error instanceof AttachmentPublicationError);
   assert.equal(error.durable,false);assert.equal(error.cleanupRequired,false);
   published=error.stored;return true;
  });
  mode='normal';
  assert.deepEqual(await store.readVerified(published),pdf);
  assert.deepEqual(await readdir(join(root,'staging')),[]);
 }finally{t.mock.restoreAll();await rm(root,{recursive:true,force:true});}
});
