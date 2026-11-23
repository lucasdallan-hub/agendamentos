import {Buffer} from 'node:buffer';
import {crc32,deflateSync} from 'node:zlib';
import {PDFiumLibrary} from '@hyzyla/pdfium';
import pdfium from '@hyzyla/pdfium/pdfium.wasm';
import {receiptAmountCandidates} from '../receipt-amount.js';

const pngSignature=Buffer.from([137,80,78,71,13,10,26,10]);

function pngChunk(name,bytes){
 const chunk=Buffer.alloc(12+bytes.length);
 chunk.writeUInt32BE(bytes.length,0);
 chunk.write(name,4,4,'ascii');
 chunk.set(bytes,8);
 chunk.writeUInt32BE(crc32(chunk.subarray(4,-4)),8+bytes.length);
 return chunk;
}

function grayscalePng({data,width,height}){
 const header=Buffer.alloc(13);
 header.writeUInt32BE(width,0);
 header.writeUInt32BE(height,4);
 header[8]=8;
 const rows=Buffer.alloc((width+1)*height);
 for(let row=0;row<height;row++){
  rows.set(data.subarray(row*width,(row+1)*width),row*(width+1)+1);
 }
 return Buffer.concat([
  pngSignature,pngChunk('IHDR',header),
  pngChunk('IDAT',deflateSync(rows,{level:1})),
  pngChunk('IEND',Buffer.alloc(0))
 ]);
}

export async function readReceiptPdf(bytes){
 if(!ArrayBuffer.isView(bytes)||bytes.byteLength<5||bytes.byteLength>5*1024*1024||
  Buffer.from(bytes.buffer,bytes.byteOffset,5).toString('ascii')!=='%PDF-')return {amount:null,images:[]};
 const library=await PDFiumLibrary.init({
  instantiateWasm(imports,receive){
   const instance=new WebAssembly.Instance(pdfium,imports);
   receive(instance,pdfium);
   return instance.exports;
  }
 });
 let document;
 try{
  try{document=await library.loadDocument(bytes);}
  catch{return {amount:null,images:[]};}
  const pages=Math.min(3,document.getPageCount());
  const text=[];
  for(let index=0;index<pages;index++){
   const page=document.getPage(index);
   try{text.push(page.getText().slice(0,100_000));}
   finally{page.close();}
  }
  const candidates=receiptAmountCandidates(text.join('\n'));
  // A raster read cannot overturn conflicting values already present in the PDF.
  if(candidates.size)return {amount:candidates.size===1?candidates.values().next().value:null,images:[]};

  const images=[];
  for(let index=0;index<Math.min(2,pages);index++){
   const page=document.getPage(index);
   try{
    const {originalWidth,originalHeight}=page.getOriginalSize();
    const scale=Math.min(3,1600/Math.max(originalWidth,originalHeight));
    const width=Math.floor(originalWidth*scale),height=Math.floor(originalHeight*scale);
    if(width>0&&height>0&&width<=1600&&height<=1600){
     images.push(grayscalePng(await page.render({width,height,colorSpace:'Gray',renderFormFields:false})));
    }
   }finally{page.close();}
  }
  return {amount:null,images};
 }finally{
  try{document?.destroy();}
  finally{library.destroy();}
 }
}
