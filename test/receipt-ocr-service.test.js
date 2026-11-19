import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {createOCRServer} from '../cloudflare/ocr-server.js';
import {workerReceiptReader} from '../cloudflare/receipt-reader.js';

test('serviço OCR exige credencial e devolve somente o valor lido',async t=>{
 const token='test-private-ocr-token';
 let reads=0;
 const server=createOCRServer({token,reader:async(buffer,mime)=>{
  reads++;
  assert.equal(mime,'image/png');
  assert.equal(buffer[0],137);
  return {text:'Informação privada do comprovante',amount_cents:18000,candidates:[18000]};
 }});
 server.listen(0,'127.0.0.1');
 await once(server,'listening');
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const png=await readFile(new URL('./fixtures/pix-receipt.png',import.meta.url));
 const request=authorization=>fetch(origin+'/read',{method:'POST',headers:{'Content-Type':'image/png',...(authorization&&{Authorization:authorization})},body:png});
 assert.equal((await fetch(origin+'/health')).status,200);
 assert.equal((await request()).status,401);
 assert.equal((await request('Bearer incorreto')).status,401);
 assert.equal(reads,0);
 const authorized=await request(`Bearer ${token}`);
 assert.equal(authorized.status,200);
 assert.deepEqual(await authorized.json(),{amount_cents:18000});
 assert.equal(reads,1);
});

test('adaptador do Worker usa HTTPS autenticado e classifica respostas sem valor ou indisponíveis',async()=>{
 const env={RECEIPT_OCR_URL:'https://ocr.example',RECEIPT_OCR_TOKEN:'private-test-token'};
 let response;
 const reader=workerReceiptReader(env,async(url,options)=>{
  assert.equal(url,'https://ocr.example/read');
  assert.equal(options.method,'POST');
  assert.equal(options.redirect,'manual');
  assert.equal(options.headers.Authorization,'Bearer private-test-token');
  assert.equal(options.headers['Content-Type'],'application/pdf');
  assert.deepEqual(options.body,Buffer.from('%PDF-'));
  return response;
 });
 assert.equal(workerReceiptReader({RECEIPT_OCR_URL:'https://ocr.example'}),null);
 assert.equal(workerReceiptReader({...env,RECEIPT_OCR_URL:'http://ocr.example'}),null);
 response=Response.json({amount_cents:6000});
 assert.deepEqual(await reader(Buffer.from('%PDF-'),'application/pdf'),{amount_cents:6000});
 response=new Response(null,{status:422});
 assert.deepEqual(await reader(Buffer.from('%PDF-'),'application/pdf'),{amount_cents:null});
 for(const invalid of [Response.json({amount_cents:'60,00'}),Response.json({}),new Response(null,{status:503}),Response.redirect('https://another.example')]){
  response=invalid;
  await assert.rejects(reader(Buffer.from('%PDF-'),'application/pdf'),{status:503});
 }
});
