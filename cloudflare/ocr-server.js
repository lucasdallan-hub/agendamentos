import http from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {nativeOCRAvailable,readReceipt} from '../receipt-ocr.js';

const maxBytes=5*1024*1024;
const supported=new Set(['image/png','image/jpeg','application/pdf']);
const json=(status,data)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const digest=value=>createHash('sha256').update(value).digest();

/** Private read handler usable by the local Worker binding and the authenticated service. */
export async function handleReceiptRequest(request,reader=readReceipt){
 try{
  if(new URL(request.url).pathname!=='/read')return json(404,{error:'Não encontrado.'});
  if(request.method!=='POST')return json(405,{error:'Método não permitido.'});
  const mime=request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if(!supported.has(mime))return json(415,{error:'Envie um comprovante PNG, JPG ou PDF.'});
  if(Number(request.headers.get('content-length'))>maxBytes)return json(413,{error:'O comprovante deve ter até 5 MB.'});
  let size=0;
  const chunks=[];
  if(request.body)for await(const chunk of request.body){
   size+=chunk.byteLength;
   if(size>maxBytes)return json(413,{error:'O comprovante deve ter até 5 MB.'});
   chunks.push(chunk);
  }
  if(!size)return json(422,{error:'Envie um comprovante válido.'});
  const result=await reader(Buffer.concat(chunks,size),mime);
  return json(200,{amount_cents:result.amount_cents});
 }catch(error){
  const status=[413,422,429,503].includes(error?.status)?error.status:500;
  return json(status,{error:'Falha ao ler o comprovante.'});
 }
}

export function createOCRServer({reader=readReceipt,token=process.env.RECEIPT_OCR_TOKEN}={}){
 const credential=typeof token==='string'&&token&&!/[\s\x00-\x1f\x7f]/.test(token)?digest(`Bearer ${token}`):null;
 const ready=!!credential&&(reader!==readReceipt||nativeOCRAvailable());
 return http.createServer({requestTimeout:90_000,headersTimeout:15_000},async(req,res)=>{
  let response;
  if(req.method==='GET'&&req.url==='/health')response=json(ready?200:503,{ok:ready});
  else if(!ready)response=json(503,{error:'Leitor indisponível.'});
  else if(!timingSafeEqual(credential,digest(req.headers.authorization||'')))response=json(401,{error:'Acesso não autorizado.'});
  else {
   try{
    const body=req.method!=='GET'&&req.method!=='HEAD'?Readable.toWeb(req):undefined;
    const request=new Request(new URL(req.url,'http://receipt-ocr.internal'),{method:req.method,headers:req.headers,body,duplex:'half'});
    response=await handleReceiptRequest(request,reader);
   }catch{response=json(400,{error:'Solicitação inválida.'});}
  }
  res.writeHead(response.status,Object.fromEntries(response.headers));
  res.end(await response.text());
 });
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const server=createOCRServer();
 server.listen(Number(process.env.PORT||8080),process.env.HOST||'127.0.0.1',()=>console.log('Serviço de leitura de comprovantes iniciado.'));
}
