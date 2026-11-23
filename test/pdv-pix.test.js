import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {createApplication} from '../server-core.js';

const credentials={client_id:'pk_pdv_test',client_secret:'sk_pdv_test',base_url:'https://arena.example'};
const cpf='529.982.247-25';
const qr='data:image/png;base64,'+(await readFile(new URL('./fixtures/pix-receipt.png',import.meta.url))).toString('base64');
const copyPaste='00020101021226820014br.gov.bcb.pix';
const checkStatus=(result,status)=>assert.equal(result.status,status,JSON.stringify(result.data));

async function fixture(t,{scheduleMisticpayConfirmation}={}){
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-24T01:30:00Z')});
 const db=new DatabaseSync(':memory:');
 const charges=[],lookups=[],messages=[];
 let cookie='';
 const misticpayFetch=async(url,options)=>{
  assert.equal(options.method,'POST');
  assert.equal(options.headers.Authorization,'Basic '+Buffer.from(`${credentials.client_id}:${credentials.client_secret}`).toString('base64'));
  const body=JSON.parse(options.body);
  if(url==='https://api.misticpay.com/api/transactions/create'){
   const providerId=String(8100+charges.length);
   const transaction={transactionId:providerId,value:body.amount,transactionType:'DEPOSITO',transactionMethod:'PIX',transactionState:'PENDENTE'};
   charges.push({body,providerId,transaction});
   return Response.json({data:{...transaction,qrCodeBase64:qr,copyPaste}});
  }
  assert.equal(url,'https://api.misticpay.com/api/transactions/check');
  lookups.push(body.transactionId);
  const charge=charges.find(({body:created,providerId})=>created.transactionId===body.transactionId||providerId===body.transactionId);
  return charge?Response.json({transaction:charge.transaction}):Response.json({code:'TRANSACTION_NOT_FOUND'},{status:404});
 };
 const {server,retryMisticpayConfirmations}=createApplication({
  db,misticpayFetch,misticpayEncryptionKey:'5a'.repeat(32),paymentConfig:{ready:false,mode:'test'},
  scheduleMisticpayConfirmation,
  notificationFetch:async(_url,options)=>{
   messages.push(JSON.parse(options.body));
   return Response.json({message:'success'});
  }
 });
 server.listen(0,'127.0.0.1');
 await once(server,'listening');
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
 const origin=`http://127.0.0.1:${server.address().port}`;
 async function api(path,body,{method=body===undefined?'GET':'POST',admin=false}={}){
  const response=await fetch(origin+path,{
   method,headers:{'Content-Type':'application/json',...(admin&&cookie?{Cookie:cookie}:{})},
   body:body===undefined?undefined:JSON.stringify(body)
  });
  if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
  return {status:response.status,data:await response.json()};
 }
 const admin=(path,body,method)=>api(path,body,{method,admin:true});
 checkStatus(await api('/api/setup',{password:'pdv-pix-test-password'}),200);
 checkStatus(await admin('/api/misticpay/config',credentials,'PUT'),200);
 checkStatus(await admin('/api/notifications/config',{
  enabled:true,base_url:'https://evolution.example',api_key:'fixture-key',arena_number:'5511998877665'
 },'PUT'),200);
 const court=await admin('/api/courts',{name:'Quadra Teste',type:'Areia',price:120});
 checkStatus(court,201);
 const reservation=await api('/api/public/bookings',{
  court_id:court.data.id,customer:'Responsável privado',phone:'11999887766',date:'2026-11-24',start:'18:00',end:'19:00',
  request_key:randomBytes(32).toString('hex')
 });
 checkStatus(reservation,201);
 const bookingId=reservation.data.reservation.id;
 const bookingPath='/api/public/bookings/'+reservation.data.token;
 const tab='/api/pdv/tabs/'+bookingId;
 for(const [name,whatsapp] of [['Ana','62999998765'],['Bruno','62988888765']]){
  checkStatus(await admin(tab+'/participants',{name,whatsapp,request_key:randomUUID()}),201);
 }
 const [ana,bruno]=(await admin(tab)).data.participants;
 async function item(name,price,participant_id=null){
  const product=await admin('/api/pdv/products',{name,price_cents:price});
  checkStatus(product,201);
  const added=await admin(tab+'/items',{product_id:product.data.id,quantity:1,participant_id,request_key:randomUUID()});
  checkStatus(added,201);
  return added.data.items.find(row=>row.product_id===product.data.id).id;
 }
 const shared=await item('Porção',501);
 const own=await item('Refrigerante',550,ana.id);
 return {api,admin,charges,lookups,messages,bookingId,bookingPath,tab,ana,bruno,shared,own,item,retryMisticpayConfirmations};
}

const memberPath=(f,person=f.ana)=>`${f.tab}/participants/${person.id}`;
async function link(f,expected_cents=801){
 const result=await f.admin(memberPath(f)+'/payment-link',{expected_cents});
 checkStatus(result,200);
 const participant=result.data.participants.find(person=>person.id===f.ana.id);
 const paymentLink=participant.payment_link;
 assert.equal(paymentLink.amount_cents,expected_cents);
 assert.match(paymentLink.path,/^\/pagar-comanda#[a-f0-9]{64}$/);
 return '/api/public/pdv/payments/'+paymentLink.path.split('#')[1];
}

function eventFor(charge){
 return {transactionId:charge.providerId,transactionType:'DEPOSITO',transactionMethod:'PIX',status:'COMPLETO'};
}

test('PDV Pix: link privado fixa a cota, impede dupla cobrança e pode ser retirado antes de gerar o Pix',async t=>{
 const f=await fixture(t),adminLink=memberPath(f)+'/payment-link';
 checkStatus(await f.api(adminLink,{expected_cents:801}),401);
 checkStatus(await f.admin(adminLink,{expected_cents:800}),409);
 assert.equal(f.charges.length,0);
 const page=await link(f);
 assert.equal(await link(f),page,'Geração repetida reutiliza o link ativo');
 const publicPayment=await f.api(page);
 checkStatus(publicPayment,200);
 assert.equal(publicPayment.data.amount_cents,801);
 assert.equal(publicPayment.data.receipt,null);
 assert.doesNotMatch(JSON.stringify(publicPayment.data),/Responsável privado|Bruno|11999887766|5562999998765|52998224725|sk_pdv_test/);
 checkStatus(await f.api('/api/public/pdv/payments/'+'0'.repeat(64)),404);
 assert.equal(f.charges.length,0);

 checkStatus(await f.admin(`${f.tab}/items/${f.own}`,{quantity:2},'PATCH'),409);
 checkStatus(await f.admin(`${f.tab}/items/${f.shared}`,undefined,'DELETE'),409);
 await f.item('Água',150,f.bruno.id);
 const tab=(await f.admin(f.tab)).data;
 assert.deepEqual(tab.participants.map(({amount_cents})=>amount_cents),[801,400]);
 assert.equal((await f.api(page)).data.amount_cents,801);
 assert.equal((await f.admin('/api/pdv')).data.revenue.consumption_cents,0);

 checkStatus(await f.admin(adminLink,undefined,'DELETE'),200);
 const removed=await f.api(page);
 assert.ok([404,410].includes(removed.status)||(removed.status===200&&removed.data.status==='cancelled'),JSON.stringify(removed.data));
 const restored=await f.admin(`${f.tab}/items/${f.own}`,{quantity:2},'PATCH');
 checkStatus(restored,200);
 assert.deepEqual(restored.data.participants.map(({amount_cents})=>amount_cents),[1351,400]);
 assert.notEqual(await link(f,1351),page);
 assert.equal(f.charges.length,0);
});

test('PDV Pix: somente consulta autenticada com o valor exato quita a pessoa e disponibiliza comprovante',async t=>{
 const f=await fixture(t),page=await link(f);
 checkStatus(await f.api(page,{cpf:'00000000000'}),400);
 assert.equal(f.charges.length,0);
 const created=await Promise.all([f.api(page,{cpf,amount_cents:1}),f.api(page,{cpf})]);
 assert.ok(created.some(result=>result.status===200&&result.data.status==='pending'));
 assert.equal(f.charges.length,1);
 const pending=await f.api(page);
 checkStatus(pending,200);
 assert.deepEqual([pending.data.status,pending.data.amount_cents,pending.data.qr_code,pending.data.copy_paste,pending.data.receipt],
  ['pending',801,qr,copyPaste,null]);
 const [charge]=f.charges;
 assert.equal(charge.body.amount,8.01);
 assert.equal(charge.body.payerDocument,'52998224725');
 assert.equal(charge.body.payerName,'Ana');
 assert.match(charge.body.projectWebhook,/^https:\/\/arena\.example\/api\/misticpay\/pdv-webhook\/[a-f0-9]{64}$/);

 const firstMember=memberPath(f);
 checkStatus(await f.admin(firstMember+'/payment',{method:'Dinheiro',expected_cents:801}),409);
 checkStatus(await f.admin(firstMember+'/payment-link',undefined,'DELETE'),409);
 checkStatus(await f.api('/api/misticpay/pdv-webhook/'+'0'.repeat(64),eventFor(charge)),404);
 const webhook=new URL(charge.body.projectWebhook).pathname;
 const hinted=await f.api(webhook,eventFor(charge));
 assert.ok([200,503].includes(hinted.status),JSON.stringify(hinted.data));
 assert.ok(f.lookups.length>0);
 assert.equal((await f.api(page)).data.receipt,null);
 assert.equal((await f.admin(f.tab)).data.participant_paid_cents,0);

 charge.transaction.transactionState='COMPLETO';
 charge.transaction.value=8;
 const beforeMismatchedAmount=f.lookups.length;
 await f.api(webhook,eventFor(charge));
 assert.ok(f.lookups.length>beforeMismatchedAmount);
 assert.equal((await f.api(page)).data.receipt,null);
 assert.equal((await f.admin('/api/pdv')).data.revenue.consumption_cents,0);
 charge.transaction.value=8.01;
 charge.transaction.transactionId='950001';
 await f.api(webhook,eventFor(charge));
 assert.equal((await f.api(page)).data.receipt,null);
 charge.transaction.transactionId=charge.providerId;
 t.mock.timers.setTime(Date.parse('2026-11-24T01:30:10Z'));
 const verified=await f.api(page+'/check',{});
 checkStatus(verified,200);
 assert.equal(verified.data.status,'approved');
 assert.equal(verified.data.qr_code,null);
 const receipt=verified.data.receipt;
 assert.deepEqual({
  amount_cents:receipt.amount_cents,payer_name:receipt.payer_name,booking_id:receipt.booking_id,paid_at:receipt.paid_at
 },{amount_cents:801,payer_name:'Ana',booking_id:f.bookingId,paid_at:'2026-11-24T01:30:10.000Z'});
 assert.ok(typeof receipt.reference==='string'&&receipt.reference.length>0);
 assert.doesNotMatch(JSON.stringify(receipt),/52998224725|5562999998765|Bruno/);
 checkStatus(await f.api(webhook,eventFor(charge)),200);
 checkStatus(await f.api(webhook,eventFor(charge)),200);
 assert.deepEqual((await f.api(page)).data.receipt,receipt);

 const tab=(await f.admin(f.tab)).data;
 assert.equal(tab.status,'open');
 assert.deepEqual(tab.participants.map(person=>[person.status,person.paid_cents]),[['closed',801],['open',0]]);
 assert.equal(tab.consumption_balance_cents,250);
 assert.equal(tab.booking_paid,false);
 assert.deepEqual((await f.admin('/api/pdv')).data.revenue,{courts_cents:0,consumption_cents:801,total_cents:801,open_consumption_cents:0});
 assert.equal(f.messages.length,1,'Pix da subcomanda não envia confirmação de pagamento da quadra');

 checkStatus(await f.admin(memberPath(f,f.bruno)+'/payment',{method:'Dinheiro',expected_cents:250}),200);
 const settled=(await f.admin(f.tab)).data;
 assert.equal(settled.status,'open');
 assert.equal(settled.consumption_balance_cents,0);
 checkStatus(await f.admin(f.tab+'/close',{method:null,expected_total_cents:1051,expected_balance_cents:0}),200);
 assert.equal((await f.admin('/api/pdv')).data.revenue.consumption_cents,1051);

 const courtPix=await f.api(f.bookingPath+'/misticpay',{cpf});
 checkStatus(courtPix,200);
 assert.equal(courtPix.data.status,'pending');
 assert.equal(f.charges[1].body.amount,120);
 f.charges[1].transaction.transactionState='COMPLETO';
 checkStatus(await f.api(new URL(f.charges[1].body.projectWebhook).pathname,eventFor(f.charges[1])),200);
 assert.equal((await f.admin(f.tab)).data.booking_paid,true);
 assert.equal((await f.admin('/api/pdv')).data.revenue.courts_cents,12000);
 assert.equal((await f.admin('/api/pdv')).data.revenue.consumption_cents,1051);
 assert.equal(f.messages.length,2);

 charge.transaction.transactionState='DEVOLVIDO';
 checkStatus(await f.api(webhook,{...eventFor(charge),status:'DEVOLVIDO'}),200);
 const reviewed=(await f.api(page)).data;
 assert.deepEqual([reviewed.status,reviewed.receipt],['review',null]);
 assert.equal((await f.admin(f.tab)).data.status,'closed');
 assert.equal((await f.admin('/api/pdv')).data.revenue.consumption_cents,1051);
});

test('PDV Pix: concilia confirmação atrasada sem o cliente e retira o comprovante após estorno',async t=>{
 const alarms=[];
 const f=await fixture(t,{scheduleMisticpayConfirmation:async when=>alarms.push(when)});
 const page=await link(f);
 checkStatus(await f.api(page,{cpf}),200);
 const [charge]=f.charges;
 const webhook=new URL(charge.body.projectWebhook).pathname;
 checkStatus(await f.api(webhook,eventFor(charge)),200);
 const due=alarms.at(-1);
 assert.ok(due>Date.now(),'O webhook antecipado agendou uma nova consulta');
 assert.deepEqual(await f.api(page).then(({data})=>[data.status,data.receipt]),['pending',null]);

 charge.transaction.transactionState='COMPLETO';
 const previousLookups=f.lookups.length;
 await f.retryMisticpayConfirmations();
 assert.equal(f.lookups.length,previousLookups,'A fila aguarda o prazo agendado');
 t.mock.timers.setTime(due);
 await f.retryMisticpayConfirmations();
 const confirmed=(await f.api(page)).data;
 assert.equal(confirmed.status,'approved');
 assert.equal(confirmed.receipt.amount_cents,801);
 assert.equal(confirmed.receipt.paid_at,new Date(due).toISOString());
 assert.equal((await f.admin(f.tab)).data.participant_paid_cents,801);
 assert.equal((await f.admin('/api/pdv')).data.revenue.consumption_cents,801);
 const settledLookups=f.lookups.length;
 await f.retryMisticpayConfirmations();
 assert.equal(f.lookups.length,settledLookups,'A conclusão tira a cobrança da fila');

 charge.transaction.transactionState='DEVOLVIDO';
 checkStatus(await f.api(webhook,{...eventFor(charge),status:'DEVOLVIDO'}),200);
 const refunded=(await f.api(page)).data;
 assert.deepEqual([refunded.status,refunded.receipt],['refunded',null]);
 const open=(await f.admin(f.tab)).data;
 assert.equal(open.status,'open');
 assert.equal(open.participant_paid_cents,0);
 assert.equal(open.participants[0].status,'open');
 assert.equal(open.consumption_balance_cents,1051);
 assert.equal((await f.admin('/api/pdv')).data.revenue.consumption_cents,0);
});
