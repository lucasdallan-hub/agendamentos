import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createApp} from '../server.js';
import {captureSystem} from '../systems.js';

const cpf='529.982.247-25';
const credentials={public_key:'pk_test',secret_key:'sk_test',base_url:'https://arena.example'};
const qr='data:image/png;base64,'+(await readFile(new URL('./fixtures/pix-receipt.png',import.meta.url))).toString('base64');
const copyPaste='00020101021226820014br.gov.bcb.pix';

async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'arena-misticpay-'));
 const provider={creates:[],payments:new Map(),uncertain:false};
 const {server,db}=createApp({dataDir:directory,paymentConfig:{ready:false,mode:'test'},misticpayFetch:async(url,options)=>{
  assert.match(url,/^https:\/\/api\.misticpay\.com\/api\/transactions\/(create|check)$/);
  assert.equal(options.method,'POST');
  assert.equal(options.redirect,'manual');
  assert.match(options.headers.Authorization,/^Basic /);
  const body=JSON.parse(options.body);
  if(provider.accessError){
   const {code,status}=provider.accessError;
   return Response.json({code,message:'provider-private-details'},{status});
  }
  if(options.headers.Authorization!=='Basic '+Buffer.from('pk_test:sk_test').toString('base64')){
   return Response.json({code:'INVALID_API_CREDENTIAL',message:'provider-private-details'},{status:401});
  }
  if(url.endsWith('/create')){
   provider.creates.push(body);
   const payment={transactionId:String(1000+provider.creates.length),value:body.amount,transactionState:'PENDENTE',transactionType:'DEPOSITO',transactionMethod:'PIX'};
   provider.payments.set(body.transactionId,payment);
   if(provider.uncertain)throw new Error('provider-private-details');
   if(provider.waitForCreate)await provider.waitForCreate();
   return Response.json({data:{...payment,payer:{document:body.payerDocument},qrCodeBase64:qr,copyPaste,qrcodeUrl:'https://example.invalid/qr'}});
  }
  const payment=provider.payments.get(body.transactionId);
  return payment?Response.json({transaction:payment}):Response.json({code:'TRANSACTION_NOT_FOUND'},{status:404});
 }});
 server.listen(0,'127.0.0.1');
 await once(server,'listening');
 t.after(async()=>{const closed=once(server,'close');server.close();await closed;db.close();await rm(directory,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port;
 let cookie;
 async function api(route,body,{method=body===undefined?'GET':'POST',auth=true}={}){
  const res=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(auth&&cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const session=res.headers.get('set-cookie');if(session)cookie=session.split(';')[0];
  return {status:res.status,data:await res.json()};
 }
 assert.equal((await api('/api/setup',{password:'fictitious-misticpay-password'})).status,200);
 const court=await api('/api/courts',{name:'Quadra n.º 1',type:'Areia',price:180});
 assert.equal(court.status,201);
 async function reserve(date){
  const booking=await api('/api/bookings',{court_id:court.data.id,customer:'Cliente de teste',phone:'11999999999',date,start:'10:00',end:'11:00'});
  assert.equal(booking.status,201);
  const link=await api(`/api/bookings/${booking.data.id}/misticpay-link`,{});
  assert.equal(link.status,200,JSON.stringify(link.data));
  return {id:booking.data.id,path:'/api/public/bookings/'+link.data.path.split('#')[1]};
 }
 const configure=(body=credentials,auth=true)=>api('/api/misticpay/config',body,{method:'PUT',auth});
 return {api,provider,db,reserve,configure};
}

test('MisticPay: chaves privadas, QR Pix e baixa só após consulta autenticada do valor integral',async t=>{
 const f=await fixture(t);
 assert.equal((await f.configure(credentials,false)).status,401);
 assert.equal((await f.configure({...credentials,base_url:'http://arena.example'})).status,400);
 const legacy=await f.configure({client_id:'ci_expired',client_secret:'cs_expired',base_url:credentials.base_url});
 assert.equal(legacy.status,400);
 assert.match(legacy.data.error,/desativou/);
 for(const [code,status,expected] of [
  ['INVALID_API_CREDENTIAL',401,/inválido ou revogado/],
  ['IP_NOT_ALLOWED',401,/IP de saída/],
  ['API_SCOPE_DENIED',403,/TRANSACTION_READ/]
 ]){
  f.provider.accessError={code,status};
  const denied=await f.configure();
  assert.equal(denied.status,502);
  assert.match(denied.data.error,expected);
  assert.doesNotMatch(denied.data.error,/provider-private-details/);
  assert.equal((await f.api('/api/misticpay/config')).data.ready,false);
 }
 delete f.provider.accessError;
 const config=await f.configure({client_id:' pk_test ',client_secret:'sk_test\n',base_url:credentials.base_url});
 assert.equal(config.status,200);
 assert.equal(config.data.ready,true);
 assert.doesNotMatch(JSON.stringify(config.data),/pk_test|sk_test/);
 assert.equal((await f.configure({client_id:'',client_secret:'',base_url:credentials.base_url})).status,200);
 await f.api('/api/pix/settings',{key:'pix@arena.example',receiver:'Arena de teste'},{method:'PUT'});
 const booking=await f.reserve('2026-12-03');
 assert.equal((await f.api(booking.path,undefined,{auth:false})).data.misticpay_ready,true);
 assert.equal((await f.api(booking.path+'/misticpay',{cpf:'123.456.789-00'},{auth:false})).status,400);
 const created=await f.api(booking.path+'/misticpay',{cpf,total:1},{auth:false});
 assert.deepEqual(created,{status:200,data:{status:'pending',qr_code:qr,copy_paste:copyPaste}});
 const request=f.provider.creates[0];
 assert.equal(request.amount,180);
 assert.equal(request.payerDocument,'52998224725');
 assert.match(request.projectWebhook,/^https:\/\/arena\.example\/api\/misticpay\/webhook\/[a-f0-9]{64}$/);
 assert.equal((await f.api(booking.path,undefined,{auth:false})).data.pix_ready,false);
 assert.equal((await f.api(booking.path+'/misticpay',{cpf},{auth:false})).data.status,'pending');
 assert.equal(f.provider.creates.length,1);
 assert.equal((await f.api(`/api/bookings/${booking.id}/pix-link`,{})).status,409);
 assert.equal((await f.api(`/api/bookings/${booking.id}/checkout`,{})).status,409);
 assert.equal((await f.api(`/api/bookings/${booking.id}/cancel`,{})).status,409);
 const webhook=new URL(request.projectWebhook).pathname;
 const payment=f.provider.payments.get(request.transactionId);
 assert.equal((await f.api('/api/misticpay/webhook/'+'a'.repeat(64),{status:'COMPLETO'},{auth:false})).status,404);
 assert.equal((await f.api(webhook,{status:'COMPLETO',value:18000},{auth:false})).status,200);
 const listed=async()=> (await f.api('/api/bookings')).data.find(row=>row.id===booking.id);
 assert.equal((await listed()).paid,0);
 payment.transactionState='COMPLETO';payment.value=179.99;
 assert.equal((await f.api(webhook,{}, {auth:false})).status,409);
 assert.equal((await listed()).paid,0);
 payment.value=180;
 assert.equal((await f.api(webhook,{}, {auth:false})).status,200);
 const paid=await listed();
 assert.equal(paid.paid,1);
 assert.equal(paid.method,'MisticPay');
 assert.equal(paid.misticpay_status,'approved');
 assert.equal((await f.api(webhook,{}, {auth:false})).status,200);
 assert.equal((await listed()).paid_at,paid.paid_at);
 const snapshot=JSON.stringify(captureSystem(f.db));
 assert.match(snapshot,/approved/);
 assert.doesNotMatch(snapshot,/52998224725|pk_test|sk_test|webhook_token|qr_code/);
 payment.transactionState='DEVOLVIDO';
 assert.equal((await f.api(webhook,{}, {auth:false})).status,200);
 assert.equal((await listed()).misticpay_status,'review');
 assert.equal((await listed()).paid,0);
});

test('MisticPay: criação simultânea e resultado incerto bloqueiam uma segunda cobrança',async t=>{
 const f=await fixture(t);
 assert.equal((await f.configure()).status,200);
 const first=await f.reserve('2026-12-04');
 f.provider.accessError={code:'API_SCOPE_DENIED',status:403};
 const scopeError=await f.api(first.path+'/misticpay',{cpf},{auth:false});
 assert.equal(scopeError.status,502);
 assert.match(scopeError.data.error,/permissão TRANSACTION_CREATE/);
 assert.equal((await f.api(first.path,undefined,{auth:false})).data.misticpay,null);
 delete f.provider.accessError;
 let release,reached;
 const gate=new Promise(resolve=>{release=resolve;});
 const arrived=new Promise(resolve=>{reached=resolve;});
 f.provider.waitForCreate=()=>{reached();return gate;};
 const initial=f.api(first.path+'/misticpay',{cpf},{auth:false});
 await arrived;
 const concurrent=await f.api(first.path+'/misticpay',{cpf},{auth:false});
 assert.equal(concurrent.data.status,'creating');
 release();
 assert.equal((await initial).data.status,'pending');
 assert.equal(f.provider.creates.length,1);
 f.provider.uncertain=true;
 const second=await f.reserve('2026-12-05');
 const failed=await f.api(second.path+'/misticpay',{cpf},{auth:false});
 assert.equal(failed.status,502);
 assert.doesNotMatch(failed.data.error,/provider-private-details/);
 assert.equal((await f.api(second.path+'/misticpay',{cpf},{auth:false})).data.status,'unknown');
 assert.equal(f.provider.creates.length,2);
 const payment=f.provider.payments.get(f.provider.creates[1].transactionId);
 payment.transactionState='COMPLETO';
 assert.equal((await f.api(second.path+'/misticpay/check',{},{auth:false})).data.status,'approved');
});
