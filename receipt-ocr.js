import {execFile,spawnSync} from 'node:child_process';
import {mkdtemp,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {parseReceiptAmount} from './receipt-amount.js';

const execute=promisify(execFile);
const filenames={'image/jpeg':'receipt.jpg','image/png':'receipt.png','application/pdf':'receipt.pdf'};
let activeReads=0;

async function run(command,args){
 return (await execute(command,args,{
  timeout:15_000,maxBuffer:256*1024,
  env:{...process.env,OMP_THREAD_LIMIT:'1'},windowsHide:true
 })).stdout;
}

export function nativeReceiptReader(){
 const languages=spawnSync('tesseract',['--list-langs'],{encoding:'utf8',timeout:3000});
 if(languages.status!==0)return null;
 const available=new Set(languages.stdout.split(/\r?\n/).map(line=>line.trim()));
 const language=available.has('por')?'por':available.has('eng')?'eng':null;
 if(!language)return null;
 const recognize=file=>run('tesseract',[file,'stdout','-l',language,'--psm','6']);
 return async(bytes,mime)=>{
  if(!Object.hasOwn(filenames,mime)||!bytes?.length||bytes.length>5*1024*1024||activeReads>=2)return null;
  activeReads++;
  let directory;
  try{
   directory=await mkdtemp(path.join(tmpdir(),'arena-receipt-'));
   const input=path.join(directory,filenames[mime]);
   await writeFile(input,bytes,{mode:0o600});
   if(mime!=='application/pdf')return parseReceiptAmount(await recognize(input));

   const text=await run('pdftotext',['-f','1','-l','3','-layout','-nopgbrk',input,'-']);
   const amount=parseReceiptAmount(text);
   if(amount!==null)return amount;

   // Render only the first pages, scaled down to bound native OCR work.
   await run('pdftoppm',['-f','1','-l','2','-scale-to','1600','-png',input,path.join(directory,'page')]);
   const pages=(await readdir(directory)).filter(filename=>/^page-\d+\.png$/.test(filename)).sort();
   const scanned=[];
   for(const page of pages)scanned.push(await recognize(path.join(directory,page)));
   return parseReceiptAmount([text,...scanned].join('\n'));
  }catch{
   // A corrupt, protected or unreadable document can still be reviewed manually.
   return null;
  }finally{
   try{if(directory)await rm(directory,{recursive:true,force:true});}
   finally{activeReads--;}
  }
 };
}
