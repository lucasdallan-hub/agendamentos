import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const execute=promisify(execFile);
const MAX_BYTES=5*1024*1024;
const MAX_PIXELS=20_000_000;
let activeReads=0;
const failure=(message,status=422)=>Object.assign(new Error(message),{status});
const normalize=text=>String(text||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\u00a0/g,' ').toLowerCase();

/** Extracts a value without comparing to the expected booking amount. Ambiguity is retained. */
export function parseReceiptAmount(text) {
 const lines=normalize(text).split(/\r?\n/);
 const preferred=[],fallback=[];
 const excluded=/\b(?:saldo|tarifa|taxa|limite|juros|encargos|desconto|cashback)\b/;
 const label=/(?:\bvalor(?:\s+(?:pago|enviado|transferido|recebido|total|do pix|da transferencia|da transacao|da operacao))?|\btotal(?:\s+(?:pago|da transferencia|do pix|enviado|transferido|recebido|da transacao))?)\s*[:=]?\s*$/;
 for(let index=0;index<lines.length;index++){
  const line=lines[index];
  const pattern=/(r\$\s*)?((?:\d{1,3}(?:\.\d{3})+|\d+)),(\d{2})(?!\d)/g;
  for(const match of line.matchAll(pattern)){
   const before=line.slice(0,match.index),after=line.slice(match.index+match[0].length);
   if(/[\d.,]$/.test(before)||/^[.,]\d/.test(after)||/[-−]\s*$/.test(before))continue;
   let previous='';
   for(let back=index-1;back>=Math.max(0,index-2);back--){if(lines[back].trim()){previous=lines[back];break;}}
   const context=before.trim()?before:previous;
   if(excluded.test(context)||excluded.test(line))continue;
   const cents=Number(match[2].replaceAll('.',''))*100+Number(match[3]);
   if(!Number.isSafeInteger(cents)||cents<=0||cents>1_000_000_000_000)continue;
   if(label.test(context))preferred.push(cents);
   else if(match[1])fallback.push(cents);
  }
 }
 const candidates=[...new Set([...preferred,...fallback])].sort((a,b)=>a-b);
 const selected=[...new Set(preferred.length?preferred:fallback)];
 return {amount_cents:selected.length===1?selected[0]:null,candidates};
}

function validateFile(buffer,mime){
 if(!Buffer.isBuffer(buffer)||!buffer.length)throw failure('Envie um comprovante PNG, JPEG ou PDF.');
 if(buffer.length>MAX_BYTES)throw failure('O comprovante deve ter no máximo 5 MB.',413);
 let type;
 if(buffer.length>=24&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&buffer.toString('ascii',12,16)==='IHDR'){
  type='image/png';const width=buffer.readUInt32BE(16),height=buffer.readUInt32BE(20);
  if(!width||!height||width*height>MAX_PIXELS)throw failure('A imagem é grande demais. Envie uma imagem de até 20 megapixels.');
 }else if(buffer.length>=4&&buffer[0]===0xff&&buffer[1]===0xd8&&buffer[buffer.length-2]===0xff&&buffer[buffer.length-1]===0xd9){
  type='image/jpeg';let foundDimensions=false;
  // Validate frame dimensions before handing the image to a native decoder.
  for(let offset=2;offset+4<buffer.length;){
   if(buffer[offset]!==0xff)break;
   while(buffer[offset]===0xff)offset++;
   const marker=buffer[offset++];
   if(marker===0xda||marker===0xd9)break;
   if(marker===0x01||marker>=0xd0&&marker<=0xd7)continue;
   if(offset+2>buffer.length)break;
   const length=buffer.readUInt16BE(offset);if(length<2||offset+length>buffer.length)break;
   if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
    if(length<8)break;
    const height=buffer.readUInt16BE(offset+3),width=buffer.readUInt16BE(offset+5);
    if(!width||!height||width*height>MAX_PIXELS)throw failure('A imagem é grande demais. Envie uma imagem de até 20 megapixels.');
    foundDimensions=true;break;
   }
   offset+=length;
  }
  if(!foundDimensions)throw failure('Não foi possível ler esta imagem JPEG.');
 }else if(buffer.subarray(0,5).toString('ascii')==='%PDF-')type='application/pdf';
 else throw failure('Arquivo inválido. Envie uma imagem PNG, JPEG ou um PDF.');
 const declared=String(mime||'').split(';')[0].trim().toLowerCase();
 if(declared!==type)throw failure('O tipo do arquivo não corresponde ao comprovante enviado.');
 return type;
}

async function command(binary,args,timeout=15_000){
 try{return (await execute(binary,args,{timeout,maxBuffer:256*1024,env:{...process.env,OMP_THREAD_LIMIT:'1'},windowsHide:true})).stdout;}
 catch(error){
  if(error.code==='ENOENT')throw failure('O leitor de comprovantes não está disponível neste ambiente.',503);
  throw failure(error.killed?'A leitura demorou demais. Envie uma imagem menor e nítida.':'Não foi possível ler o comprovante. Envie um arquivo válido e nítido, sem senha.');
 }
}
const recognize=file=>command('tesseract',[file,'stdout','-l','eng','--psm','6']);

export async function readReceipt(buffer,mime){
 const type=validateFile(buffer,mime);
 if(activeReads>=2)throw failure('O leitor está ocupado. Aguarde um momento e envie novamente.',429);
 activeReads++;
 let directory;
 try{
  directory=await mkdtemp(path.join(tmpdir(),'arena-receipt-'));
  const input=path.join(directory,type==='application/pdf'?'receipt.pdf':type==='image/png'?'receipt.png':'receipt.jpg');
  await writeFile(input,buffer,{mode:0o600});
  let text='';
  if(type==='application/pdf'){
   text=await command('pdftotext',['-f','1','-l','3','-layout','-nopgbrk',input,'-']);
   if(parseReceiptAmount(text).amount_cents===null){
    const prefix=path.join(directory,'page');
    await command('pdftoppm',['-f','1','-l','2','-scale-to','1600','-r','144','-png',input,prefix]);
    const images=(await readdir(directory)).filter(name=>/^page-\d+\.png$/.test(name)).sort().slice(0,2);
    const scanned=[];
    for(const image of images)scanned.push(await recognize(path.join(directory,image)));
    text=[text,...scanned].filter(Boolean).join('\n');
   }
  }else text=await recognize(input);
  text=text.replace(/\u0000/g,'').trim().slice(0,100_000);
  if(!text)throw failure('Não foi possível identificar texto. Envie um comprovante mais nítido.');
  return {text,...parseReceiptAmount(text)};
 }finally{
  if(directory)await rm(directory,{recursive:true,force:true});
  activeReads--;
 }
}
