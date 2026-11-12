import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
import {createApplication} from '../server-core.js';
import {MercadoPago} from '../payments.js';
import {initializeSystems} from '../systems.js';

test('financeiro: credenciais próprias, checkout, webhook, persistência e isolamento entre filhos',async t=>{
 async function arena(slug){
  const db=new DatabaseSync(':memory:');initializeSystems(db);
  db.prepare("INSERT INTO system_settings VALUES('identity',?)").run(JSON.stringify({slug,parent:'main'}));
  const requests=[];let preference,server,cookie='';
  const mockFetch=async(url,options)=>{
   requests.push({url,authorization:options.headers.Authorization});
   const account=options.headers.Authorization==='Bearer token-'+slug?slug:null;
   if(!account)return Response.json({error:'unauthorized'},{status:401});
   if(url.endsWith('/users/me'))return Response.json({id:account});
   if(url.endsWith('/checkout/preferences')){preference=JSON.parse(options.body);return Response.json({id:'pref-'+slug,sandbox_init_point:'https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id='+slug});}
   if(url.includes('/v1/payments/'))return Response.json({id:slug,external_reference:preference.external_reference,collector_id:account,transaction_amount:100,currency_id:'BRL',transaction_amount_refunded:0,live_mode:false,status:'approved'});
   throw Error('Unexpected mock URL');
  };
  async function start(){const config={ready:false,mode:'test'};({server}=createApplication({db,paymentConfig:config,paymentClient:new MercadoPago(config,mockFetch)}));server.listen(0,'127.0.0.1');await once(server,'listening');cookie='';}
  async function api(path,body,{method='POST',auth=true,headers={}}={}){const r=await fetch(`http://127.0.0.1:${server.address().port}/api/`+path,{method:body===undefined?'GET':method,headers:{'Content-Type':'application/json',...(auth?{Cookie:cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});if(auth&&r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:await r.json()};}
  await start();t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
  await api('setup',{password:'child-password-123'});
  return {db,api,requests,restart:async()=>{await new Promise(resolve=>server.close(resolve));await start();await api('login',{password:'child-password-123'});},get preference(){return preference;}};
 }
 const one=await arena('one'),two=await arena('two');
 const credentials=slug=>({token:'token-'+slug,webhook_secret:'webhook-'+slug,base_url:'https://'+slug+'.example.com',mode:'test'});
 assert.equal((await one.api('payments/config',credentials('one'),{method:'PUT',auth:false})).status,401);
 assert.equal((await one.api('payments/config',credentials('wrong'),{method:'PUT'})).status,502);
 assert.equal((await one.api('payments/config',credentials('one'),{method:'PUT'})).status,200);
 assert.equal((await two.api('payments/config')).data.ready,false);
 await two.api('payments/config',credentials('two'),{method:'PUT'});
 const config=(await one.api('payments/config')).data;
 assert.equal(config.account_id,'one');assert.equal(config.token,undefined);assert.equal(config.webhook_secret,undefined);
 assert.equal(JSON.stringify(config).includes('token-one'),false);
 const court=await one.api('courts',{name:'Quadra',type:'Areia',price:100});
 const booking=await one.api('bookings',{court_id:court.data.id,customer:'Cliente',phone:'11999999999',date:'2026-12-01',start:'18:00',end:'19:00'});
 assert.equal((await one.api(`bookings/${booking.data.id}/checkout`,{})).status,200);
 assert.equal(one.preference.notification_url,'https://one.example.com/api/payments/webhook');
 const {createHmac}=await import('node:crypto');
 const ts='1700000000',requestId='request-one';
 const signature=secret=>createHmac('sha256',secret).update(`id:one;request-id:${requestId};ts:${ts};`).digest('hex');
 async function webhook(secret){
  return one.api('payments/webhook?data.id=one',{type:'payment',data:{id:'one'}},{auth:false,headers:{'x-request-id':requestId,'x-signature':`ts=${ts},v1=${signature(secret)}`}});
 }
 assert.equal((await webhook('webhook-two')).status,401);
 assert.equal((await webhook('webhook-one')).status,200);
 assert.equal((await one.api('bookings')).data[0].paid,1);
 const copied=await one.api('bookings',{court_id:court.data.id,customer:'Histórico',phone:'11999999999',date:'2026-12-02',start:'18:00',end:'19:00'});
 one.db.prepare("INSERT INTO payment_orders VALUES('copied-order',?,'old-pref','https://www.mercadopago.com.br/checkout','pending','2026-12-03','2026-12-02')").run(copied.data.id);
 one.db.prepare("INSERT INTO archived_payment_orders VALUES('copied-order')").run();
 const requestsBefore=one.requests.length;
 assert.equal((await one.api(`bookings/${copied.data.id}/sync-payment`,{})).status,409);
 assert.equal((await one.api(`bookings/${copied.data.id}/checkout`,{})).status,409);
 assert.equal(one.requests.length,requestsBefore);
 assert.equal((await one.api('bookings')).data.find(b=>b.id===copied.data.id).online_archived,1);
 assert.equal((await one.api('payments/config',{...credentials('one'),mode:'production'},{method:'PUT'})).status,409);
 assert.equal((await one.api('payments/config',{...credentials('one'),token:'',webhook_secret:''},{method:'PUT'})).status,200);
 await one.restart();assert.equal((await one.api('payments/config')).data.ready,true);
 assert.equal((await two.api('payments/config')).data.account_id,'two');
 assert.ok(one.requests.every(r=>r.authorization!=='Bearer token-two'));
});
