import {Buffer} from 'node:buffer';
import {gunzipSync} from 'node:zlib';
import tesseractCore from 'tesseract.js-core/tesseract-core-lstm.js';
import tesseractWasm from 'tesseract.js-core/tesseract-core-lstm.wasm';
import portugueseData from '@tesseract.js-data/por/4.0.0_best_int/por.traineddata.gz';
import {jpegDimensions} from '../image-size.js';

const maxPixels=5_000_000;
const maxEdge=4096;
const pngSignature=Buffer.from([137,80,78,71,13,10,26,10]);
let engine;

async function createEngine(){
 const core=await tesseractCore({
  print(){},
  printErr(){},
  instantiateWasm(imports,receive){
   const instance=new WebAssembly.Instance(tesseractWasm,imports);
   receive(instance,tesseractWasm);
   return instance.exports;
  }
 });
 core.FS.writeFile('/por.traineddata',gunzipSync(new Uint8Array(portugueseData)));
 return core;
}

function imageDimensions(bytes,mime){
 if(mime==='image/jpeg')return jpegDimensions(bytes);
 if(mime==='image/png'&&bytes.length>=24&&bytes.subarray(0,8).equals(pngSignature)&&bytes.toString('ascii',12,16)==='IHDR'){
  return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
 }
 return null;
}

export async function readReceiptImage(bytes,mime){
 const input=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 const size=imageDimensions(input,mime);
 if(!size?.width||!size.height||size.width>maxEdge||size.height>maxEdge||size.width*size.height>maxPixels)return '';
 const core=await (engine??=createEngine().catch(error=>{engine=undefined;throw error;}));
 // Access to the engine's temporary file is synchronous and isolated per call.
 const api=new core.TessBaseAPI();
 try{
  if(api.Init('/','por',1)!==0)return '';
  api.SetPageSegMode(6);
  core.FS.writeFile('/input',input);
  if(api.SetImageFile(1,0)!==0)return '';
  return api.GetUTF8Text();
 }finally{
  try{core.FS.unlink('/input');}catch{}
  try{api.End();}finally{core.destroy(api);}
 }
}
