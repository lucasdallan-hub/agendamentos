import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {createApplication} from '../server-core.js';
import {captureSystem,installSystem} from '../systems.js';

const credentials={client_id:'pk_split_test',client_secret:'sk_split_test',base_url:'https://arena.example'};
const payer={name:'Pessoa de teste',cpf:'529.982.247-25'};
const qr='data:image/png;base64,'+(await readFile(new URL('./fixtures/pix-receipt.png',import.meta.url))).toString('base64');
const copyPaste='00020101021226820014br.gov.bcb.pix';

async function fixture(t){
 const db=new DatabaseSync(':memory:');
 const charges=[],messages=[],checked=[];
 let cookie='',preferenceCalls=0;
 const misticpayFetch=async(url,options)=>{
  assert.equal(options.method,'POST');
  assert.equal(options.headers.Authorization,'Basic '+Buffer.from(`${credentials.client_id}:${credentials.client_secret}`).toString('base64'));
  const body=JSON.parse(options.body);
  if(url==='https://api.misticpay.com/api/transactions/create'){
   const data={transactionId:String(6001+charges.length),value:body.amount,transactionType:'DEPOSITO',transactionMethod:'PIX',transactionState:'PENDENTE'};
   charges.push({body,data});
   return Response.json({data:{...data,qrCodeBase64:qr,copyPaste}});
  }
  assert.equal(url,'https://api.misticpay.com/api/transactions/check');
  checked.push(body.transactionId);
  const charge=charges.find(({body:created,data})=>created.transactionId===body.transactionId||data.transactionId===body.transactionId);
  return charge?Response.json({transaction:charge.data}):Response.json({code:'TRANSACTION_NOT_FOUND'},{status:404});
 };
 const {server}=createApplication({
  db,misticpayFetch,misticpayEncryptionKey:'5a'.repeat(32),
  paymentConfig:{ready:true,token:'test-token',webhookSecret:'test-secret',baseUrl:credentials.base_url,mode:'test'},
  paymentClient:{async createPreference(){preferenceCalls++;throw Error('Cobrança integral inesperada');}},
  notificationFetch:async(_url,options)=>{
   const message=JSON.parse(options.body);
   messages.push({...message,isTransaction:db.isTransaction});
   return Response.json({message:'success'});
  }
 });
 server.listen(0,'127.0.0.1');
 await once(server,'listening');
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
 const origin=`http://127.0.0.1:${server.address().port}`;
 async function api(path,body,{method=body===undefined?'GET':'POST',auth=false}={}){
  const response=await fetch(origin+path,{
   method,headers:{'Content-Type':'application/json',...(auth&&cookie?{cookie}:{})},
   body:body===undefined?undefined:JSON.stringify(body)
  });
  if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
  return {status:response.status,data:await response.json()};
 }
 assert.equal((await api('/api/setup',{password:'split-integration-password'})).status,200);
 assert.equal((await api('/api/misticpay/config',credentials,{method:'PUT',auth:true})).status,200);
 assert.equal((await api('/api/pix/settings',{key:'pix@example.com',receiver:'Arena Teste'},{method:'PUT',auth:true})).status,200);
 assert.equal((await api('/api/notifications/config',{
  enabled:true,base_url:'https://evolution.example',api_key:'fixture-key',arena_number:'5511998877665'
 },{method:'PUT',auth:true})).status,200);
 let courts=0;
 async function reserve(price){
  const court=await api('/api/courts',{name:`Quadra Teste ${++courts}`,type:'Areia',price},{auth:true});
  assert.equal(court.status,201);
  const date=new Date(Date.now()+7*86400000).toISOString().slice(0,10);
  const booking=await api('/api/public/bookings',{
   court_id:court.data.id,customer:'Responsável da reserva',phone:'11999887766',date,start:'18:00',end:'19:00',
   request_key:randomBytes(32).toString('hex')
  });
  assert.equal(booking.status,201,JSON.stringify(booking.data));
  return {id:booking.data.reservation.id,path:'/api/public/bookings/'+booking.data.token};
 }
 return {api,db,charges,checked,messages,reserve,preferenceCalls:()=>preferenceCalls};
}

function sharePath(share){
 assert.match(share.path,/^\/catalogo#cota:[a-f0-9]{32}\.\d+\.[a-f0-9]{64}$/);
 return '/api/public/split/'+share.path.split('#cota:')[1];
}

function eventFor(charge,status='COMPLETO'){
 return {transactionId:charge.data.transactionId,transactionType:'DEPOSITO',transactionMethod:'PIX',status};
}

test('Pix dividido: separa centavos e links e só confirma a reserva quando todas as cotas forem pagas',async t=>{
 const f=await fixture(t),booking=await f.reserve(180.01);
 const planPath=booking.path+'/split';
 assert.equal((await f.api(booking.path)).data.split_ready,true);
 assert.equal((await f.api('/api/public/bookings/'+'0'.repeat(64)+'/split',{count:3})).status,404);
 assert.equal(f.messages.length,1,'Ao reservar, apenas a arena é avisada');
 const created=await f.api(planPath,{count:3,amount_cents:1});
 assert.ok([200,201].includes(created.status),JSON.stringify(created.data));
 const {shares,count,total,paid_count,paid_cents}=created.data;
 assert.deepEqual({count,total,paid_count,paid_cents},{count:3,total:18001,paid_count:0,paid_cents:0});
 assert.deepEqual(shares.map(({index,amount_cents,status})=>[index,amount_cents,status]),[
  [1,6001,'uncreated'],[2,6000,'uncreated'],[3,6000,'uncreated']
 ]);
 const [first,second,last]=shares.map(sharePath);
 const refreshed=await f.api(planPath);
 assert.equal(refreshed.status,200);
 assert.deepEqual(refreshed.data.shares,shares,'Cada cota mantém o próprio link');
 assert.equal(f.charges.length,0);
 assert.equal((await f.api(first.slice(0,-1)+(first.endsWith('0')?'1':'0'))).status,404);
 assert.doesNotMatch(JSON.stringify((await f.api(second)).data),/Responsável da reserva|11999887766|52998224725/);
 assert.equal((await f.api(booking.path+'/misticpay',{cpf:payer.cpf})).status,409);
 assert.equal((await f.api(booking.path+'/checkout',{})).status,409);
 assert.equal((await f.api(booking.path+'/pix',{})).status,409);
 assert.equal((await f.api(`/api/bookings/${booking.id}/payment`,{method:'Pix'},{auth:true})).status,409);
 assert.equal(f.preferenceCalls(),0);

 assert.equal((await f.api(first,{...payer,cpf:'00000000000'})).status,400);
 assert.equal(f.charges.length,0);
 const firstCharge=await f.api(first,{...payer,amount_cents:1});
 assert.ok([200,201].includes(firstCharge.status),JSON.stringify(firstCharge.data));
 assert.equal(firstCharge.data.amount_cents,6001);
 assert.equal(firstCharge.data.status,'pending');
 assert.equal(firstCharge.data.qr_code,qr);
 assert.equal(firstCharge.data.copy_paste,copyPaste);
 assert.equal(f.charges[0].body.amount,60.01);
 assert.match(f.charges[0].body.projectWebhook,/^https:\/\/arena\.example\/api\/misticpay\/split-webhook\/[a-f0-9]{64}$/);
 assert.notEqual(first.split('/').at(-1),f.charges[0].body.projectWebhook.split('/').at(-1));
 assert.equal((await f.api(first,payer)).data.qr_code,qr);
 assert.equal((await f.api(second)).data.status,'uncreated');
 assert.equal(f.charges.length,1);
 assert.equal((await f.api(planPath,{count:4})).status,409);

 const firstWebhook=new URL(f.charges[0].body.projectWebhook).pathname;
 assert.equal((await f.api('/api/misticpay/split-webhook/'+'0'.repeat(64),eventFor(f.charges[0]))).status,404);
 const hinted=await f.api(firstWebhook,eventFor(f.charges[0]));
 assert.ok([200,503].includes(hinted.status),JSON.stringify(hinted.data));
 assert.ok(f.checked.length>0,'Uma confirmação precisa ser conferida na API da MisticPay');
 assert.equal((await f.api(planPath)).data.paid_count,0);
 assert.equal((await f.api(booking.path)).data.paid,0);
 f.charges[0].data.transactionState='COMPLETO';
 f.charges[0].data.value=60.00;
 const checkedBeforeMismatch=f.checked.length;
 await f.api(firstWebhook,eventFor(f.charges[0]));
 assert.ok(f.checked.length>checkedBeforeMismatch);
 assert.equal((await f.api(planPath)).data.paid_count,0);
 f.charges[0].data.value=60.01;
 assert.equal((await f.api(firstWebhook,eventFor(f.charges[0]))).status,200);
 const progress=(await f.api(planPath)).data;
 assert.deepEqual([progress.paid_count,progress.paid_cents],[1,6001]);
 assert.equal((await f.api(booking.path)).data.paid,0);
 assert.equal(f.messages.length,1);

 for(const [index,path] of [second,last].entries()){
  assert.equal((await f.api(path,payer)).data.status,'pending');
  const charge=f.charges[index+1];
  assert.equal(charge.body.amount,60);
  charge.data.transactionState='COMPLETO';
  const hook=new URL(charge.body.projectWebhook).pathname;
  if(index===0){
   const check=await f.api(path+'/check',{});
   assert.equal(check.status,200);
   assert.equal(check.data.status,'approved');
  }
  assert.equal((await f.api(hook,eventFor(charge))).status,200);
  assert.equal((await f.api(hook,eventFor(charge))).status,200);
  const state=(await f.api(planPath)).data;
  assert.deepEqual([state.paid_count,state.paid_cents],[index+2,12001+6000*index]);
  assert.equal((await f.api(booking.path)).data.paid,index===0?0:1);
 }
 assert.equal(f.charges.length,3);
 assert.equal(new Set(f.charges.map(charge=>charge.body.transactionId)).size,3);
 assert.deepEqual(f.messages.map(({number})=>number),['5511998877665','5511999887766']);
 assert.match(f.messages[1].text,/Reserva confirmada/);
 assert.equal(f.messages[1].isTransaction,false);

 const refunded=f.charges[1];
 refunded.data.transactionState='DEVOLVIDO';
 assert.equal((await f.api(new URL(refunded.body.projectWebhook).pathname,eventFor(refunded,'DEVOLVIDO'))).status,200);
 const returned=(await f.api(planPath)).data;
 assert.deepEqual([returned.paid_count,returned.paid_cents],[2,12001]);
 assert.equal((await f.api(booking.path)).data.paid,0);
 assert.equal(f.messages.length,2);
 const snapshot=captureSystem(f.db);
 const [archived]=snapshot.tables.misticpay_split_plans;
 assert.equal(archived.secret,'');
 assert.deepEqual([archived.archived,archived.archived_paid_count,archived.archived_paid_cents],[1,2,12001]);
 assert.equal(snapshot.tables.misticpay_split_shares,undefined,'QR codes and webhook secrets stay on the original arena');
 const clone=new DatabaseSync(':memory:');
 try{
  createApplication({db:clone});
  installSystem(clone,{slug:'split-clone',name:'Split Clone',password:'fixture-password',snapshot});
  assert.equal(clone.prepare('SELECT archived FROM misticpay_split_plans WHERE booking_id=?').get(booking.id).archived,1);
  assert.equal(clone.prepare('SELECT COUNT(*) AS count FROM misticpay_split_shares').get().count,0);
 }finally{clone.close();}
 f.db.prepare('UPDATE public_booking_requests SET expires_at=0 WHERE booking_id=?').run(booking.id);
 assert.equal((await f.api(first)).status,410);
});

test('Pix dividido: pagina milhares de cotas sem emitir cobranças antecipadas',async t=>{
 const f=await fixture(t),booking=await f.reserve(9000.07);
 const path=booking.path+'/split',total=900007,count=7777;
 for(const invalid of [0,1,-1,2.5,total+1]){
  const result=await f.api(path,{count:invalid});
  assert.ok(result.status>=400&&result.status<500,JSON.stringify(result.data));
 }
 const plan=await f.api(path,{count});
 assert.ok([200,201].includes(plan.status),JSON.stringify(plan.data));
 assert.equal(plan.data.count,count);
 assert.equal(plan.data.total,total);
 assert.equal(plan.data.page,1);
 assert.equal(plan.data.pages,Math.ceil(count/20));
 assert.equal(plan.data.shares.length,20);
 assert.equal(plan.data.shares[0].amount_cents,Math.ceil(total/count));
 const page=await f.api(`${path}?page=${plan.data.pages}`);
 assert.equal(page.status,200,JSON.stringify(page.data));
 const final=page.data;
 assert.equal(final.shares.length,count%20);
 assert.equal(final.shares.at(-1).index,count);
 assert.equal(final.shares.at(-1).amount_cents,Math.floor(total/count));
 assert.equal((await f.api(sharePath(final.shares.at(-1)))).data.status,'uncreated');
 assert.equal(f.charges.length,0);
 assert.equal(f.db.prepare('SELECT count(*) c FROM misticpay_split_shares').get().c,0);

 assert.equal((await f.api(path,undefined,{method:'DELETE'})).status,200);
 assert.equal((await f.api(sharePath(final.shares.at(-1)))).status,404);
 assert.equal((await f.api(booking.path)).data.split,null);
 assert.equal((await f.api(booking.path+'/misticpay',{cpf:payer.cpf})).data.status,'pending');
 assert.equal(f.charges[0].body.amount,9000.07);
 assert.equal((await f.api(path,{count:2})).status,409);
});
