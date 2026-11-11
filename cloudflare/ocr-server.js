import http from 'node:http';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {readReceipt} from '../receipt-ocr.js';

const MAX_BYTES=5*1024*1024;
const supported=new Set(['image/png','image/jpeg','application/pdf']);
const json=(res,status,data)=>{
 res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
 res.end(JSON.stringify(data));
};

/** Internal-only service reached through the ReceiptOCR Durable Object binding. */
export function createOCRServer({reader=readReceipt}={}){
 return http.createServer({requestTimeout:90_000,headersTimeout:15_000},async(req,res)=>{
  try{
   const url=new URL(req.url,'http://container');
   if(req.method==='GET'&&url.pathname==='/health')return json(res,200,{ok:true});
   if(url.pathname!=='/read')return json(res,404,{error:'Não encontrado.'});
   if(req.method!=='POST')return json(res,405,{error:'Método não permitido.'});
   const mime=String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();
   if(!supported.has(mime))return json(res,415,{error:'Envie um comprovante PNG, JPG ou PDF.'});
   const declared=Number(req.headers['content-length']);
   if(Number.isFinite(declared)&&declared>MAX_BYTES)return json(res,413,{error:'O comprovante deve ter até 5 MB.'});
   let size=0;const chunks=[];
   for await(const chunk of req){size+=chunk.length;if(size>MAX_BYTES)return json(res,413,{error:'O comprovante deve ter até 5 MB.'});chunks.push(chunk);}
   if(!size)return json(res,422,{error:'Envie um comprovante válido.'});
   const result=await reader(Buffer.concat(chunks,size),mime);
   // Extracted text can contain personal data; return only the required numbers.
   return json(res,200,{amount_cents:result.amount_cents,candidates:result.candidates});
  }catch(error){
   const status=Number.isInteger(error.status)&&error.status>=400&&error.status<600?error.status:500;
   return json(res,status,{error:status===500?'Falha interna ao ler o comprovante.':error.message});
  }
 });
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const server=createOCRServer();
 server.listen(Number(process.env.PORT||8080),process.env.HOST||'0.0.0.0',()=>console.log('Leitor de comprovantes disponível.'));
}
