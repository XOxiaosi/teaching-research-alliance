import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {PDFDocument,PDFName} from 'pdf-lib';
import {validateAttachmentFormat} from '../dist/attachment-format-validator.js';
import {LocalAttachmentStore} from '../dist/local-attachment-store.js';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
const require=createRequire(import.meta.url);
const {PNG}=require('pngjs');
const jpeg=require('jpeg-js');
const makePdf=async(pages=1)=>{const document=await PDFDocument.create();for(let i=0;i<pages;i++)document.addPage([200,200]);return document.save();};
const image={width:2,height:2,data:Buffer.alloc(16,255)};
const png=PNG.sync.write(image);
const jpg=jpeg.encode(image,80).data;

test('合成图片完整解码、PDF解析页数，原字节不变',async()=>{
 const pdf=await makePdf();const original=Buffer.from(pdf);
 assert.deepEqual(await validateAttachmentFormat(pdf,'application/pdf'),{mediaType:'application/pdf',pageCount:1});
 assert.deepEqual(Buffer.from(pdf),original);
 assert.deepEqual(await validateAttachmentFormat(png,'image/png'),{mediaType:'image/png',width:2,height:2});
 assert.deepEqual(await validateAttachmentFormat(jpg,'image/jpeg'),{mediaType:'image/jpeg',width:2,height:2});
});

test('拒绝截断、伪魔数、加密PDF、坏CRC和过大页面/像素',async()=>{
 for(const [bytes,type] of [[Buffer.from('%PDF-1.7\ninvalid\n%%EOF'),'application/pdf'],[png.subarray(0,8),'image/png'],[jpg.subarray(0,3),'image/jpeg'],[png.subarray(0,png.length-5),'image/png'],[jpg.subarray(0,jpg.length-2),'image/jpeg']]){
  await assert.rejects(validateAttachmentFormat(bytes,type),/ATTACHMENT_UNREADABLE/);
 }
 const bad=Buffer.from(png);bad[29]^=1;
 await assert.rejects(validateAttachmentFormat(bad,'image/png'),/UNREADABLE/);
 await assert.rejects(validateAttachmentFormat(png,'image/png',{maxImagePixels:3}),/UNREADABLE/);
 await assert.rejects(validateAttachmentFormat(jpg,'image/jpeg',{maxImagePixels:3}),/UNREADABLE/);
 await assert.rejects(validateAttachmentFormat(await makePdf(2),'application/pdf',{maxPdfPages:1}),/UNREADABLE/);
 const encrypted=await PDFDocument.create();encrypted.addPage();encrypted.context.trailerInfo.Encrypt=encrypted.context.obj({Filter:PDFName.of('Standard')});
 await assert.rejects(validateAttachmentFormat(await encrypted.save(),'application/pdf'),/UNREADABLE/);
});

test('拒绝窄高图与压缩内容远大于扫描线尺寸的PNG',async()=>{
 const tall=Buffer.from(png);tall.writeUInt32BE(1,16);tall.writeUInt32BE(16_000_000,20);
 await assert.rejects(validateAttachmentFormat(tall,'image/png'),/UNREADABLE/);
 const data=deflateSync(Buffer.alloc(1024*1024));
 const type=Buffer.from('IDAT');const chunk=Buffer.alloc(data.length+12);
 chunk.writeUInt32BE(data.length);type.copy(chunk,4);data.copy(chunk,8);
 let crc=0xffffffff;
 for(const byte of Buffer.concat([type,data])){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
 chunk.writeUInt32BE((crc^0xffffffff)>>>0,chunk.length-4);
 const bomb=Buffer.concat([png.subarray(0,33),chunk,png.subarray(-12)]);
 await assert.rejects(validateAttachmentFormat(bomb,'image/png'),/UNREADABLE/);
});

test('工作线程超时/并发限额可恢复，不阻塞后续校验',async()=>{
 await assert.rejects(validateAttachmentFormat(png,'image/png',{timeoutMs:1}),/VALIDATION_TIMEOUT/);
 const first=validateAttachmentFormat(png,'image/png');
 const second=validateAttachmentFormat(jpg,'image/jpeg');
 await assert.rejects(validateAttachmentFormat(png,'image/png'),/VALIDATOR_BUSY/);
 await Promise.all([first,second]);
 assert.equal((await validateAttachmentFormat(png,'image/png')).width,2);
 await assert.rejects(validateAttachmentFormat(Buffer.alloc(0),'image/png'),/INPUT_INVALID/);
 await assert.rejects(validateAttachmentFormat(png,'image/png',{maxImagePixels:Number.MAX_SAFE_INTEGER}),/INPUT_INVALID/);
});

test('格式校验在原件发布前执行，损坏文件不产生永久对象',async()=>{
 const root=await mkdtemp(join(tmpdir(),'alliance-format-upload-'));
 try{
  const store=await LocalAttachmentStore.create(root,resolve(import.meta.dirname,'../../..'));
  const malformed=Buffer.from('%PDF-1.7\nnot a document\n%%EOF');
  async function* chunks(bytes){yield bytes;}
  const draft=bytes=>({versionId:randomUUID(),originalFilename:'receipt.pdf',declaredMediaType:'application/pdf',declaredSizeBytes:bytes.length});
  const validate=async bytes=>{await validateAttachmentFormat(bytes,'application/pdf');};
  await assert.rejects(store.put(draft(malformed),chunks(malformed),validate),/UNREADABLE/);
  assert.deepEqual(await readdir(join(root,'objects')),[]);
  assert.deepEqual(await readdir(join(root,'staging')),[]);
  const pdf=await makePdf();const saved=await store.put(draft(pdf),chunks(pdf),validate);
  assert.deepEqual(await store.readVerified(saved),Buffer.from(pdf));
 }finally{await rm(root,{recursive:true,force:true});}
});
