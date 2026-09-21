import {parentPort,workerData} from "node:worker_threads";
import {createRequire} from "node:module";
import {inflateSync} from "node:zlib";
import {PDFDocument} from "pdf-lib";
import type {AttachmentMediaType} from "./local-attachment-store.js";
const require=createRequire(import.meta.url);
const {PNG}=require("pngjs") as {PNG:{sync:{read:(bytes:Buffer,options:{checkCRC:boolean})=>{width:number;height:number;data:Buffer}}}};
const jpeg=require("jpeg-js") as {decode:(bytes:Buffer,options:Record<string,unknown>)=>{width:number;height:number;data:Uint8Array}};
const input=workerData as {bytes:Uint8Array;mediaType:AttachmentMediaType;maxImagePixels:number;maxPdfPages:number};
const bytes=Buffer.from(input.bytes);
const validSize=(width:number,height:number):void=>{
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>65535||height>65535||width*height>input.maxImagePixels)throw new Error("dimensions");
};
try {
  if(input.mediaType==="application/pdf"){
    if(!bytes.subarray(0,5).equals(Buffer.from("%PDF-"))||!/%%EOF\s*$/.test(bytes.subarray(-1024).toString("latin1")))throw new Error("pdf framing");
    const document=await PDFDocument.load(bytes,{throwOnInvalidObject:true,updateMetadata:false});
    const pages=document.getPages();
    if(pages.length<1||pages.length>input.maxPdfPages)throw new Error("pages");
    for(const page of pages){const {width,height}=page.getSize();if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw new Error("page dimensions");}
    parentPort!.postMessage({ok:true,summary:{mediaType:input.mediaType,pageCount:pages.length}});
  }else if(input.mediaType==="image/png"){
    if(bytes.length<45||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.readUInt32BE(8)!==13||bytes.toString("ascii",12,16)!=="IHDR")throw new Error("png framing");
    const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);validSize(width,height);
    const depth=bytes[24]!,colour=bytes[25]!,interlace=bytes[28]!;
    const channels=({0:1,2:3,3:1,4:2,6:4} as Record<number,number>)[colour];
    if(channels===undefined||![1,2,4,8,16].includes(depth)||interlace>1)throw new Error("png format");
    const passes=interlace===0?[[0,0,1,1]]:[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]];
    let scanlineBytes=0;
    for(const [x,y,dx,dy] of passes){
      const passWidth=Math.max(0,Math.ceil((width-x!)/dx!)),passHeight=Math.max(0,Math.ceil((height-y!)/dy!));
      if(passWidth&&passHeight)scanlineBytes+=(Math.ceil(passWidth*channels*depth/8)+1)*passHeight;
    }
    // Typed-array/zlib allocations are outside the V8 heap limit, so bound them explicitly.
    if(scanlineBytes>64*1024*1024)throw new Error("png decoded size");
    // pngjs's interlaced path inflates without a cap; bound its exact input before decoding.
    const compressed:Buffer[]=[];let offset=8;let ended=false;
    while(offset<bytes.length){
      if(offset+12>bytes.length)throw new Error("chunk");
      const length=bytes.readUInt32BE(offset),type=bytes.toString("ascii",offset+4,offset+8);
      if(length>bytes.length-offset-12)throw new Error("chunk");
      if(type==="IDAT")compressed.push(bytes.subarray(offset+8,offset+8+length));
      offset+=length+12;
      if(type==="IEND"){if(length!==0||offset!==bytes.length)throw new Error("png end");ended=true;break;}
    }
    if(!ended||compressed.length===0)throw new Error("png data");
    const inflated=inflateSync(Buffer.concat(compressed),{maxOutputLength:scanlineBytes});
    if(inflated.byteLength!==scanlineBytes)throw new Error("png scanlines");
    const decoded=PNG.sync.read(bytes,{checkCRC:true});validSize(decoded.width,decoded.height);
    parentPort!.postMessage({ok:true,summary:{mediaType:input.mediaType,width:decoded.width,height:decoded.height}});
  }else{
    if(bytes.length<4||bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217)throw new Error("jpeg framing");
    const decoded=jpeg.decode(bytes,{useTArray:true,tolerantDecoding:false,maxResolutionInMP:input.maxImagePixels/1_000_000,maxMemoryUsageInMB:96});
    validSize(decoded.width,decoded.height);
    parentPort!.postMessage({ok:true,summary:{mediaType:input.mediaType,width:decoded.width,height:decoded.height}});
  }
}catch{parentPort!.postMessage({ok:false});}
