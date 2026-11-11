import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import {once} from 'node:events';
import {createApp} from '../server.js';
import {paymentConfiguration,MercadoPago,verifyWebhook} from '../payments.js';

const config={ready:true,token:'mock-token',webhookSecret:'local-test-secret',baseUrl:'https://arena.example',mode:'test'};
async function fixture(t,ready=true){
 const dataDir=mkdtempSync('/tmp/arena-payments-');
 const provider=new Map();let creates=0,reads=0,payload,creationFailure;
 const client={
  async createPreference(body){creates++;payload=body;if(creationFailure)throw creationFailure;return{id:'pref-1',init_point:'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-1',sandbox_init_point:'https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-1'};},
  async getPayment(id){reads++;assert.ok(provider.has(String(id)),'Pagamento de teste existe');return structuredClone(provider.get(String(id)));},
  async getAccount(){return{id:123};},
  async searchPayments(reference){return{results:[...provider.values()].filter(p=>p.external_reference===reference),paging:{total:[...provider.values()].filter(p=>p.external_reference===reference).length}};}
 };
 const {server,db}=createApp({dataDir,paymentConfig:{...config,ready},paymentClient:client});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{await new Promise(r=>server.close(r));db.close();rmSync(dataDir,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${server.address().port}`;let cookie='';
 async function request(endpoint,body,{auth=true,headers={},method}={}){
  const r=await fetch(`${origin}${endpoint}`,{method:method||(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json',...(auth?{cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
  return{status:r.status,data:r.headers.get('content-type')?.includes('application/json')?await r.json():await r.text()};
 }
 await request('/api/setup',{password:'local-tests-password'});
 const court=await request('/api/courts',{name:'Areia central',type:'Vôlei de areia',price:120});
 const reservation=await request('/api/bookings',{court_id:court.data.id,customer:'Cliente de teste',phone:'11999990000',date:'2026-12-01',start:'18:00',end:'19:30'});
 const id=reservation.data.id;
 function payment(paymentId='101',overrides={}){const reference=db.prepare('SELECT id FROM payment_orders WHERE booking_id=?').get(id)?.id;const p={id:paymentId,external_reference:reference,collector_id:123,currency_id:'BRL',transaction_amount:180,transaction_amount_refunded:0,live_mode:false,status:'approved',...overrides};provider.set(String(paymentId),p);return p;}
 async function webhook(paymentId='101',overrides={}){
  const ts=String(Date.now()),requestId='request-fixture';const signature=createHmac('sha256',config.webhookSecret).update(`id:${paymentId.toLowerCase()};request-id:${requestId};ts:${ts};`).digest('hex');
  return request(`/api/payments/webhook?data.id=${paymentId}&type=payment`,{type:'payment',data:{id:paymentId}},{auth:false,headers:{'x-request-id':requestId,'x-signature':`ts=${ts},v1=${signature}`,...overrides}});
 }
 return{db,request,payment,webhook,id,stats:()=>({creates,reads,payload}),setFailure:e=>creationFailure=e};
}

test('configuração e assinatura: não aceita URL insegura ou assinatura forjada',()=>{
 assert.equal(paymentConfiguration({}).ready,false);
 assert.equal(paymentConfiguration({APP_BASE_URL:'http://arena.example',MERCADOPAGO_ACCESS_TOKEN:'x',MERCADOPAGO_WEBHOOK_SECRET:'x'}).ready,false);
 assert.equal(paymentConfiguration({APP_BASE_URL:'https://arena.example',MERCADOPAGO_ACCESS_TOKEN:'x',MERCADOPAGO_WEBHOOK_SECRET:'x'}).ready,true);
 const url=new URL('https://arena.example/api/payments/webhook?data.id=ABC123');
 const digest=createHmac('sha256','secret').update('id:abc123;request-id:req;ts:123;').digest('hex');
 assert.equal(verifyWebhook({url,secret:'secret',headers:{'x-request-id':'req','x-signature':`ts=123,v1=${digest}`}}),true);
 url.searchParams.set('data.id','OTHER');
 assert.equal(verifyWebhook({url,secret:'secret',headers:{'x-request-id':'req','x-signature':`ts=123,v1=${digest}`}}),false);
});

test('sem configuração: bloqueia checkout e não cria cobrança',async t=>{
 const f=await fixture(t,false);
 assert.equal((await f.request('/api/payments/config')).data.ready,false);
 assert.equal((await f.request(`/api/bookings/${f.id}/checkout`,{})).status,503);
 assert.equal(f.stats().creates,0);
});

test('checkout: autenticação, valor do servidor, reuso e bloqueio de cancelamento manual',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request(`/api/bookings/${f.id}/checkout`,{total:1},{auth:false})).status,401);
 const first=await f.request(`/api/bookings/${f.id}/checkout`,{total:1});
 assert.equal(first.status,200);assert.match(first.data.checkout_url,/sandbox\.mercadopago/);
 assert.equal(f.stats().payload.items[0].unit_price,180);
 assert.equal(f.stats().payload.items[0].currency_id,'BRL');
 assert.equal(f.stats().payload.notification_url,'https://arena.example/api/payments/webhook');
 assert.equal(f.stats().payload.back_urls.success,'https://arena.example/pagamento');
 assert.equal((await f.request(`/api/bookings/${f.id}/checkout`,{})).data.checkout_url,first.data.checkout_url);
 assert.equal(f.stats().creates,1);
 assert.equal((await f.request(`/api/bookings/${f.id}/cancel`,{})).status,409);
 assert.equal((await f.request(`/api/bookings/${f.id}/payment`,{method:'Pix'})).status,409);
 // The return page never changes payment state, regardless of query parameters.
 const r=await f.request('/pagamento?status=approved&payment_id=101');assert.equal(r.status,200);
 assert.equal(f.db.prepare('SELECT paid FROM bookings WHERE id=?').get(f.id).paid,0);
});

test('webhook: assinatura, pagamento pendente, aprovação repetida e estorno',async t=>{
 const f=await fixture(t);await f.request(`/api/bookings/${f.id}/checkout`,{});
 f.payment('101',{status:'pending'});
 assert.equal((await f.webhook('101',{'x-signature':'ts=1,v1='+'0'.repeat(64)})).status,401);
 assert.equal(f.stats().reads,0);
 assert.equal((await f.webhook()).status,200);assert.equal(f.db.prepare('SELECT paid FROM bookings').get().paid,0);
 f.payment();assert.equal((await f.webhook()).status,200);assert.equal((await f.webhook()).status,200);
 assert.equal(f.db.prepare('SELECT paid FROM bookings').get().paid,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM provider_payments').get().n,1);
 f.payment('101',{status:'refunded',transaction_amount_refunded:180});
 assert.equal((await f.webhook()).data.status,'refunded');
 assert.equal(f.db.prepare('SELECT paid FROM bookings').get().paid,0);
 assert.equal((await f.request(`/api/bookings/${f.id}/checkout`,{})).status,409);
});

test('webhook: rejeita valor, conta e ambiente divergentes; identifica pagamento duplicado',async t=>{
 const f=await fixture(t);await f.request(`/api/bookings/${f.id}/checkout`,{});
 for(const overrides of [{transaction_amount:1},{collector_id:999},{currency_id:'USD'},{live_mode:true}]){
  f.payment('101',overrides);assert.equal((await f.webhook()).status,409);assert.equal(f.db.prepare('SELECT paid FROM bookings').get().paid,0);
 }
 f.payment();assert.equal((await f.webhook()).data.status,'approved');
 f.payment('102');assert.equal((await f.webhook('102')).data.status,'review');
 assert.equal(f.db.prepare('SELECT paid FROM bookings').get().paid,1);
 assert.equal((await f.request(`/api/bookings/${f.id}/sync-payment`,{})).data.status,'review');
});

test('resposta incerta: não gera nova preferência',async t=>{
 const f=await fixture(t);f.setFailure(Object.assign(new Error('Resposta incerta'),{status:502}));
 assert.equal((await f.request(`/api/bookings/${f.id}/checkout`,{})).status,502);
 assert.equal((await f.request(`/api/bookings/${f.id}/checkout`,{})).status,409);assert.equal(f.stats().creates,1);

});

test('falha definitiva permite corrigir a configuração e tentar novamente',async t=>{
 const f=await fixture(t);f.setFailure(Object.assign(new Error('Token inválido'),{status:502,definitive:true}));
 assert.equal((await f.request(`/api/bookings/${f.id}/checkout`,{})).status,502);
 f.setFailure(undefined);
 assert.equal((await f.request(`/api/bookings/${f.id}/checkout`,{})).status,200);assert.equal(f.stats().creates,2);
});

test('cliente Mercado Pago: usa endpoint oficial e não expõe conteúdo de erro',async()=>{
 let captured;
 const client=new MercadoPago(config,async(url,options)=>{captured={url,options};return{ok:true,json:async()=>({id:123})};});
 await client.getAccount();assert.equal(captured.url,'https://api.mercadopago.com/users/me');assert.equal(captured.options.headers.Authorization,'Bearer mock-token');
 const failed=new MercadoPago(config,async()=>({ok:false,status:401,json:async()=>({message:'secret'})}));
 await assert.rejects(()=>failed.getAccount(),e=>e.definitive===true&&!e.message.includes('secret'));
});
