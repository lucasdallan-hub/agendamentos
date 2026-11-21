import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createApp} from '../server.js';
import {captureSystem} from '../systems.js';

const cpf='529.982.247-25';
const credentials={client_id:'pk_test',client_secret:'sk_test',base_url:'https://arena.example'};
const encryptionKey='e2'.repeat(32);
const managedEncryptionKey='b4'.repeat(32);
const protectionId=key=>createHash('sha256').update(Buffer.from(key,'hex')).digest('hex').slice(0,32);
const sampleId='31677842';
const samplePayment={transactionId:sampleId,value:57.50,transactionState:'COMPLETO',transactionType:'DEPOSITO',transactionMethod:'PIX'};
const qr='data:image/png;base64,'+(await readFile(new URL('./fixtures/pix-receipt.png',import.meta.url))).toString('base64');
const copyPaste='00020101021226820014br.gov.bcb.pix';
const basicAuth=({client_id,client_secret})=>'Basic '+Buffer.from(client_id+':'+client_secret).toString('base64');

async function fixture(t,{key=encryptionKey,managedKey='',scheduleMisticpayConfirmation}={}){
 const directory=await mkdtemp(join(tmpdir(),'arena-misticpay-'));
 const provider={calls:[],creates:[],checks:[],payments:new Map(),allowedCredentials:new Set([basicAuth(credentials)]),uncertain:false};
 const misticpayFetch=async(url,options)=>{
  assert.match(url,/^https:\/\/api\.misticpay\.com\/api\/transactions\/(create|check)$/);
  assert.equal(options.method,'POST');
  assert.equal(options.redirect,'manual');
  assert.match(options.headers.Authorization,/^Basic /);
  assert.match(options.headers['X-Request-Id'],/^[a-f0-9-]{36}$/);
  const body=JSON.parse(options.body);
  const action=url.endsWith('/create')?'create':'check';
  provider.calls.push({action,requestId:options.headers['X-Request-Id'],body});
  if(action==='check')provider.checks.push(body.transactionId);
  if(provider.respond){
   const response=await provider.respond(action,body,options);
   if(response)return response;
  }
  if(provider.accessError){
   const {code,status}=provider.accessError;
   return Response.json({code,message:'provider-private-details'},{status});
  }
  if(!provider.allowedCredentials.has(options.headers.Authorization)){
   return Response.json({code:'INVALID_API_CREDENTIAL',message:'provider-private-details'},{status:401});
  }
  if(action==='create'){
   provider.creates.push(body);
   const payment={transactionId:String(1000+provider.creates.length),value:body.amount,transactionState:'PENDENTE',transactionType:'DEPOSITO',transactionMethod:'PIX'};
   provider.payments.set(body.transactionId,payment);
   provider.payments.set(payment.transactionId,payment);
   if(provider.uncertain)throw new Error('provider-private-details');
   if(provider.waitForCreate)await provider.waitForCreate();
   return Response.json({data:{...payment,payer:{document:body.payerDocument},qrCodeBase64:qr,copyPaste,qrcodeUrl:'https://example.invalid/qr'}});
  }
  const payment=provider.payments.get(body.transactionId);
  if(payment)return Response.json({transaction:payment});
  return provider.missing?provider.missing(body.transactionId):Response.json({code:'TRANSACTION_NOT_FOUND'},{status:404});
 };
 let server,db,base,cookie,retryMisticpayConfirmations;
 async function start(primary,managed){
  ({server,db,retryMisticpayConfirmations}=createApp({
   dataDir:directory,misticpayEncryptionKey:primary,misticpayManagedEncryptionKey:managed,
   paymentConfig:{ready:false,mode:'test'},misticpayFetch,scheduleMisticpayConfirmation
  }));
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  base='http://127.0.0.1:'+server.address().port;
 }
 async function stop(){
  const closed=once(server,'close');server.close();await closed;db.close();
 }
 await start(key,managedKey);
 t.after(async()=>{await stop();await rm(directory,{recursive:true,force:true});});
 async function api(route,body,{method=body===undefined?'GET':'POST',auth=true,headers={}}={}){
  const options={method,headers:{'Content-Type':'application/json',...(auth&&cookie?{Cookie:cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)};
  const res=headers.Host?await new Promise((resolve,reject)=>{
   const req=httpRequest(base+route,{method,headers:options.headers},response=>{
    const chunks=[];
    response.on('data',chunk=>chunks.push(chunk));
    response.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers:response.headers})));
    response.on('error',reject);
   });
   req.on('error',reject);
   req.end(options.body);
  }):await fetch(base+route,options);
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
 const verify=(transaction_id=sampleId,auth=true)=>api('/api/misticpay/config/verify',{transaction_id},{auth});
 const config=()=>api('/api/misticpay/config');
 const allowVerification=()=>db.prepare('UPDATE misticpay_connection SET last_check_started_at=0 WHERE id=1').run();
 async function activate(){
  assert.equal((await configure()).status,200);
  provider.payments.set(sampleId,{...samplePayment});
  const activated=await verify();
  assert.equal(activated.status,200,JSON.stringify(activated.data));
  assert.equal(activated.data.verification_state,'verified');
  assert.equal(activated.data.ready,true);
 }
 async function restart({key:nextKey=encryptionKey,managedKey:nextManagedKey=''}={}){
  await stop();
  cookie=undefined;
  await start(nextKey,nextManagedKey);
  const login=await api('/api/login',{username:'admin',password:'fictitious-misticpay-password'});
  assert.equal(login.status,200);
 }
 return {api,provider,get db(){return db;},reserve,configure,verify,config,allowVerification,activate,restart,
  runScheduledConfirmations:()=>retryMisticpayConfirmations()};
}

test('MisticPay: guarda as chaves cifradas e verifica um Pix existente sem criar cobrança',async t=>{
 const f=await fixture(t,{key:` \r\n${encryptionKey}\n`});
 assert.equal((await f.api('/api/misticpay/config',undefined,{auth:false})).status,401);
 assert.equal((await f.configure(credentials,false)).status,401);
 assert.equal((await f.verify(sampleId,false)).status,401);
 assert.deepEqual(f.provider.calls,[]);

 const initial=(await f.config()).data;
 assert.equal(initial.storage_ready,true);
 assert.equal(initial.storage_status,'ready');
 assert.equal(initial.verification_state,'unconfigured');
 assert.equal(initial.ready,false);
 assert.equal(initial.public_key_configured,false);
 assert.equal(initial.secret_key_configured,false);
 assert.equal((await f.verify()).status,409);
 assert.equal((await f.configure({...credentials,base_url:'http://arena.example'})).status,400);
 assert.equal((await f.configure({client_id:'',client_secret:'',base_url:credentials.base_url})).status,400);
 const legacy=await f.configure({client_id:'ci_expired',client_secret:'cs_expired',base_url:credentials.base_url});
 assert.equal(legacy.status,400);
 assert.match(legacy.data.error,/desativou/);
 const saved=await f.configure({client_id:' pk_test ',client_secret:'sk_test\n',base_url:credentials.base_url});
 assert.equal(saved.status,200);
 assert.equal(saved.data.ready,true);
 assert.equal(saved.data.verification_state,'configured');
 assert.equal(saved.data.base_url,credentials.base_url);
 assert.equal(saved.data.public_key_configured,true);assert.equal(saved.data.secret_key_configured,true);
 assert.equal(saved.data.last_verified_at,null);assert.equal(saved.data.last_checked_at,null);
 assert.deepEqual(f.provider.calls,[]);
 assert.doesNotMatch(JSON.stringify(saved.data),/pk_test|sk_test/);
 const storedBefore=f.db.prepare('SELECT * FROM misticpay_connection').get();
 assert.ok(storedBefore.active_credentials);
 assert.equal(storedBefore.pending_credentials,null);
 assert.doesNotMatch(JSON.stringify(storedBefore),/pk_test|sk_test/);

 for(const invalid of ['',null,'https://example.invalid']){
  assert.equal((await f.verify(invalid)).status,400);
 }
 assert.equal((await f.api('/api/misticpay/config/verify',{})).status,400);
 assert.deepEqual(f.provider.calls,[]);
 // The provider may return its own ID when the existing Pix was looked up by reference.
 f.provider.payments.set(sampleId,{...samplePayment,transactionId:31677843});
 const verified=await f.verify();
 assert.equal(verified.status,200,JSON.stringify(verified.data));
 assert.equal(verified.data.verification_state,'verified');
 assert.equal(verified.data.ready,true);
 assert.ok(verified.data.last_verified_at);assert.ok(verified.data.last_checked_at);
 assert.equal(verified.data.verification_error,null);
 assert.deepEqual(f.provider.checks,[sampleId]);
 assert.equal(f.provider.creates.length,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM misticpay_orders').get().n,0);
 assert.doesNotMatch(JSON.stringify(verified.data),/pk_test|sk_test|31677842|31677843/);
 const storedAfter=f.db.prepare('SELECT * FROM misticpay_connection').get();
 assert.ok(storedAfter.active_credentials);
 assert.doesNotMatch(JSON.stringify(storedAfter),/pk_test|sk_test/);
 assert.equal((await f.verify()).status,429);
 assert.equal(f.provider.checks.length,1);
});

test('MisticPay: a ausência do segredo de armazenamento impede salvar ou verificar',async t=>{
 const f=await fixture(t,{key:''});
 const initial=await f.config();
 assert.equal(initial.status,200);
 assert.equal(initial.data.storage_ready,false);
 assert.equal(initial.data.storage_status,'secret_missing');
 assert.equal(initial.data.ready,false);
 assert.equal((await f.configure()).status,503);
 assert.equal((await f.verify()).status,503);
 assert.deepEqual(f.provider.calls,[]);
});

test('MisticPay: painel distingue formato inválido do segredo com segurança',async t=>{
 const f=await fixture(t,{key:'invalid-encryption-value'});
 const config=await f.config();
 assert.equal(config.status,200);
 assert.equal(config.data.storage_ready,false);
 assert.equal(config.data.storage_status,'secret_invalid');
 assert.doesNotMatch(JSON.stringify(config.data),/invalid-encryption-value|key_id/i);
 assert.equal((await f.configure()).status,503);
 assert.deepEqual(f.provider.calls,[]);
});

test('MisticPay: aceita só Client ID e Secret, inferindo a origem HTTPS e a chave disponível',async t=>{
 const {client_id,client_secret}=credentials;
 const body={client_id,client_secret};
 for(const [key,expectedKey] of [
  ['',managedEncryptionKey],
  ['invalid-encryption-value',managedEncryptionKey],
  [encryptionKey,encryptionKey]
 ]){
  const f=await fixture(t,{key,managedKey:managedEncryptionKey});
  assert.equal((await f.config()).data.storage_status,'ready');
  assert.equal((await f.api('/api/misticpay/config',body,{
   method:'PUT',headers:{Host:'arena-managed.example','X-Forwarded-Proto':'http'}
  })).status,400);
  const saved=await f.api('/api/misticpay/config',body,{
   method:'PUT',headers:{
    Host:'arena-managed.example','X-Forwarded-Proto':'https','X-Forwarded-Host':'untrusted-alias.example',
    Origin:'https://arena-managed.example'
   }
  });
  assert.equal(saved.status,200);
  assert.equal(saved.data.storage_ready,true);
  assert.equal(saved.data.verification_state,'configured');
  assert.equal(saved.data.base_url,'https://arena-managed.example');
  const stored=f.db.prepare('SELECT credentials_key_id,active_credentials,base_url FROM misticpay_connection').get();
  assert.equal(stored.credentials_key_id,protectionId(expectedKey));
  assert.match(stored.active_credentials,/^v1\./);
  assert.equal(stored.base_url,saved.data.base_url);
  assert.doesNotMatch(JSON.stringify(saved.data),new RegExp([encryptionKey,managedEncryptionKey,stored.credentials_key_id,'pk_test','sk_test'].join('|')));
  const savedAgain=await f.api('/api/misticpay/config',body,{
   method:'PUT',headers:{Host:'temporary-alias.example','X-Forwarded-Proto':'https'}
  });
  assert.equal(savedAgain.status,200);
  assert.equal(savedAgain.data.base_url,saved.data.base_url);
  assert.deepEqual(f.db.prepare('SELECT credentials_key_id,active_credentials,base_url FROM misticpay_connection').get(),stored);
  assert.deepEqual(f.provider.calls,[]);
 }
});

test('MisticPay: dados cifrados pela chave gerenciada exigem essa chave durante a restauração',async t=>{
 const f=await fixture(t,{key:'',managedKey:managedEncryptionKey});
 await f.activate();
 const row=()=>f.db.prepare('SELECT * FROM misticpay_connection').get();
 const original=row();
 assert.equal(original.credentials_key_id,protectionId(managedEncryptionKey));

 await f.restart({key:encryptionKey});
 const blocked=await f.config();
 assert.equal(blocked.status,200);
 assert.equal(blocked.data.storage_ready,false);
 assert.equal(blocked.data.storage_status,'key_mismatch');
 assert.equal(blocked.data.ready,false);
 assert.equal((await f.configure()).status,503);
 assert.equal((await f.verify()).status,503);
 assert.deepEqual(row(),original);
 assert.deepEqual(f.provider.checks,[sampleId]);
 assert.doesNotMatch(JSON.stringify(blocked.data),new RegExp([encryptionKey,managedEncryptionKey,original.credentials_key_id].join('|')));

 await f.restart({key:encryptionKey,managedKey:managedEncryptionKey});
 assert.equal((await f.config()).data.ready,true);
 f.allowVerification();
 const restored=await f.verify();
 assert.equal(restored.status,200);
 assert.equal(restored.data.verification_state,'verified');
 assert.equal(restored.data.ready,true);
 assert.equal(row().active_credentials,original.active_credentials);
 assert.equal(row().credentials_key_id,original.credentials_key_id);
 assert.deepEqual(f.provider.checks,[sampleId,sampleId]);
});

test('MisticPay: migra as chaves antigas para a configuração cifrada pronta para receber',async t=>{
 const f=await fixture(t);
 f.db.prepare('INSERT INTO misticpay_connection(id,public_key,secret_key,base_url) VALUES (1,?,?,?)')
  .run(credentials.client_id,credentials.client_secret,credentials.base_url);
 assert.equal((await f.api('/api/misticpay/config',undefined,{auth:false})).status,401);
 const migrated=await f.config();
 assert.equal(migrated.status,200);
 assert.equal(migrated.data.verification_state,'configured');
 assert.equal(migrated.data.ready,true);
 assert.equal(migrated.data.storage_ready,true);
 assert.equal(migrated.data.last_verified_at,null);
 assert.equal(migrated.data.public_key_configured,true);
 assert.equal(migrated.data.secret_key_configured,true);
 const stored=f.db.prepare('SELECT * FROM misticpay_connection').get();
 assert.equal(stored.public_key,'');
 assert.equal(stored.secret_key,'');
 assert.ok(stored.active_credentials);
 assert.equal(stored.pending_credentials,null);
 assert.doesNotMatch(JSON.stringify(stored),/pk_test|sk_test/);
 assert.deepEqual(f.provider.calls,[]);
 f.provider.payments.set(sampleId,{...samplePayment});
 const verified=await f.verify();
 assert.equal(verified.status,200);
 assert.equal(verified.data.verification_state,'verified');
 assert.equal(verified.data.ready,true);
 assert.deepEqual(f.provider.checks,[sampleId]);
});

test('MisticPay: promove rascunhos antigos sem cobranças na abertura do painel ou na primeira cobrança',async t=>{
 for(const access of ['painel','checkout']){
  const f=await fixture(t);
  assert.equal((await f.configure()).status,200);
  const booking=await f.reserve('2026-12-07');
  const envelope=f.db.prepare('SELECT active_credentials FROM misticpay_connection').get().active_credentials;
  f.db.prepare(`UPDATE misticpay_connection SET pending_credentials=active_credentials,
   pending_base_url=base_url,active_credentials=NULL,base_url='',last_verified_at=NULL WHERE id=1`).run();
  assert.deepEqual(f.provider.calls,[]);
  if(access==='painel'){
   const promoted=await f.config();
   assert.equal(promoted.data.ready,true);
   assert.equal(promoted.data.verification_state,'configured');
   assert.equal(promoted.data.last_verified_at,null);
   assert.deepEqual(f.provider.calls,[]);
  }else{
   const created=await f.api(booking.path+'/misticpay',{cpf},{auth:false});
   assert.equal(created.status,200,JSON.stringify(created.data));
   assert.equal(created.data.status,'pending');
   assert.equal(created.data.qr_code,qr);
   assert.deepEqual(f.provider.calls.map(call=>call.action),['create']);
  }
  const current=f.db.prepare('SELECT active_credentials,pending_credentials,base_url FROM misticpay_connection').get();
  assert.deepEqual({...current},{active_credentials:envelope,pending_credentials:null,base_url:credentials.base_url});
 }
});

test('MisticPay: ambiente com segredo de armazenamento diferente não sobrescreve as chaves',async t=>{
 const f=await fixture(t);
 await f.activate();
 const differentKeyId='f'.repeat(32);
 f.db.prepare('UPDATE misticpay_connection SET credentials_key_id=?').run(differentKeyId);
 const inaccessible=(await f.config()).data;
 assert.equal(inaccessible.storage_ready,false);
 assert.equal(inaccessible.storage_status,'key_mismatch');
 assert.doesNotMatch(JSON.stringify(inaccessible),new RegExp(differentKeyId));
 assert.equal(inaccessible.ready,false);
 const stored=f.db.prepare('SELECT * FROM misticpay_connection').get();
 assert.ok(stored.active_credentials);
 assert.equal((await f.configure()).status,503);
 assert.equal((await f.verify()).status,503);
 assert.deepEqual(f.db.prepare('SELECT * FROM misticpay_connection').get(),stored);
 assert.deepEqual(f.provider.checks,[sampleId]);
});

test('MisticPay: primeiro QR Pix após salvar as chaves e baixa só após consulta autenticada',async t=>{
 const f=await fixture(t);
 const saved=await f.configure();
 assert.equal(saved.status,200);
 assert.equal(saved.data.verification_state,'configured');
 assert.equal(saved.data.ready,true);
 assert.equal(saved.data.last_verified_at,null);
 assert.deepEqual(f.provider.calls,[]);
 await f.api('/api/pix/settings',{key:'pix@arena.example',receiver:'Arena de teste'},{method:'PUT'});
 const booking=await f.reserve('2026-12-03');
 const statusPath=booking.path+'/misticpay';
 const readStatus=()=>f.api(statusPath,undefined,{auth:false});
 assert.equal((await readStatus()).status,404);
 assert.equal((await f.api(`/api/public/bookings/${'a'.repeat(64)}/misticpay`,undefined,{auth:false})).status,404);
 assert.equal((await f.api(booking.path,undefined,{auth:false})).data.misticpay_ready,true);
 assert.equal((await f.api(statusPath,{cpf:'123.456.789-00'},{auth:false})).status,400);
 const created=await f.api(statusPath,{cpf,total:1},{auth:false});
 assert.deepEqual(created,{status:200,data:{status:'pending',qr_code:qr,copy_paste:copyPaste}});
 assert.deepEqual(await readStatus(),{status:200,data:{status:'pending'}});
 assert.deepEqual(f.provider.calls.map(call=>call.action),['create']);
 assert.equal((await f.api(booking.path,undefined,{auth:false})).data.paid,0);
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
 const paidEvent={transactionId:payment.transactionId,transactionType:'DEPOSITO',transactionMethod:'PIX',status:'COMPLETO'};
 f.provider.accessError={code:'API_SCOPE_DENIED',status:403};
 assert.equal((await f.api(webhook,paidEvent,{auth:false})).status,502);
 assert.equal((await f.api(booking.path,undefined,{auth:false})).data.paid,0);
 assert.equal((await f.config()).data.ready,true);
 delete f.provider.accessError;
 assert.equal((await f.api(webhook,{...paidEvent,value:18000},{auth:false})).status,503);
 const listed=async()=> (await f.api('/api/bookings')).data.find(row=>row.id===booking.id);
 assert.equal((await listed()).paid,0);
 payment.transactionState='COMPLETO';payment.value=179.99;
 assert.equal((await f.api(webhook,paidEvent,{auth:false})).status,409);
 assert.equal((await listed()).paid,0);
 payment.value=180;payment.updatedAt='2026-12-03T13:00:00.000Z';
 assert.equal((await f.api(webhook,paidEvent,{auth:false})).status,200);
 const paid=await listed();
 assert.equal(paid.paid,1);
 assert.equal(paid.method,'MisticPay');
 assert.equal(paid.misticpay_status,'approved');
 const observed=await f.config();
 assert.equal(observed.data.verification_state,'verified');
 assert.ok(observed.data.last_verified_at);
 const checksAfterApproval=f.provider.checks.length;
 assert.deepEqual(await readStatus(),{status:200,data:{status:'approved'}});
 assert.equal(f.provider.checks.length,checksAfterApproval);
 assert.equal((await f.api(webhook,paidEvent,{auth:false})).status,200);
 assert.equal(f.provider.checks.length,checksAfterApproval,'Webhook repetido não precisa consultar um estado já confirmado');
 assert.equal((await listed()).paid_at,paid.paid_at);
 const snapshot=JSON.stringify(captureSystem(f.db));
 assert.match(snapshot,/approved/);
 assert.doesNotMatch(snapshot,/52998224725|pk_test|sk_test|webhook_token|qr_code/);
 payment.transactionState='DEVOLVIDO';payment.updatedAt='2026-12-03T13:05:00.000Z';
 assert.equal((await f.api(webhook,{...paidEvent,status:'DEVOLVIDO'},{auth:false})).status,200);
 assert.equal((await listed()).misticpay_status,'refunded');
 assert.equal((await listed()).paid,0);
 payment.transactionState='COMPLETO';payment.updatedAt='2026-12-03T13:00:00.000Z';
 assert.equal((await f.api(webhook,paidEvent,{auth:false})).status,200);
 assert.equal((await listed()).misticpay_status,'refunded');
 assert.equal((await listed()).paid,0);
 const callsBeforeExpiry=f.provider.calls.length;
 f.db.prepare('UPDATE public_booking_requests SET expires_at=0 WHERE booking_id=?').run(booking.id);
 assert.equal((await readStatus()).status,410);
 assert.equal(f.provider.calls.length,callsBeforeExpiry);
});

test('MisticPay: concilia pelo ID vinculado quando a referência local não é encontrada',async t=>{
 const f=await fixture(t);
 assert.equal((await f.configure()).status,200);
 const booking=await f.reserve('2026-12-09');
 const created=await f.api(booking.path+'/misticpay',{cpf},{auth:false});
 assert.equal(created.status,200);
 assert.equal(created.data.status,'pending');
 const reference=f.provider.creates[0].transactionId;
 const linked=f.provider.payments.get(reference).transactionId;
 assert.match(reference,/^[a-f0-9-]{36}$/);
 assert.notEqual(reference,linked);
 const completed={transactionId:linked,value:'180.00',transactionState:'COMPLETO',transactionType:'DEPOSITO',transactionMethod:'PIX'};
 let primaryStatus=403,primaryCode='API_SCOPE_DENIED',payment=completed;
 f.provider.respond=(action,{transactionId})=>{
  assert.equal(action,'check');
  if(transactionId===reference)return Response.json({code:primaryCode},{status:primaryStatus});
  assert.equal(transactionId,linked);
  return Response.json({transaction:payment});
 };
 const check=async()=>{
  f.provider.checks.length=0;
  f.db.prepare('UPDATE misticpay_orders SET checked_at=NULL WHERE booking_id=?').run(booking.id);
  return f.api(booking.path+'/misticpay/check',{transaction_id:'id-nao-vinculado'},{auth:false});
 };
 const state=()=>f.db.prepare('SELECT paid,paid_at FROM bookings WHERE id=?').get(booking.id);

 const denied=await check();
 assert.equal(denied.status,502);
 assert.match(denied.data.error,/TRANSACTION_READ/);
 assert.deepEqual(f.provider.checks,[reference]);
 assert.deepEqual({...state()},{paid:0,paid_at:null});

 primaryStatus=404;
 primaryCode='INTERNAL_ERROR';
 for(const [override,status] of [
  [{value:'179.99'},409],
  [{transactionId:'98765432'},409],
  [{transactionType:'SAQUE'},502],
  [{transactionMethod:'BOLETO'},502]
 ]){
  payment={...completed,...override};
  assert.equal((await check()).status,status,JSON.stringify(override));
  assert.deepEqual(f.provider.checks,[reference,linked]);
  assert.deepEqual({...state()},{paid:0,paid_at:null});
 }

 primaryCode='TRANSACTION_NOT_FOUND';
 payment=completed;
 const approved=await check();
 assert.equal(approved.status,200);
 assert.equal(approved.data.status,'approved');
 assert.deepEqual(f.provider.checks,[reference,linked]);
 assert.equal(state().paid,1);
 assert.ok(state().paid_at);
 assert.equal(f.provider.creates.length,1);
});

test('MisticPay: confirmação pendente do webhook é retomada depois de reiniciar',async t=>{
 const alarms=[];
 const f=await fixture(t,{scheduleMisticpayConfirmation:async when=>{alarms.push(when);}});
 assert.equal((await f.configure()).status,200);
 const booking=await f.reserve('2026-12-10');
 const created=await f.api(booking.path+'/misticpay',{cpf},{auth:false});
 assert.equal(created.data.status,'pending');
 const request=f.provider.creates[0];
 const payment=f.provider.payments.get(request.transactionId);
 const event={transactionId:payment.transactionId,transactionType:'DEPOSITO',transactionMethod:'PIX',status:'COMPLETO'};
 const webhook=new URL(request.projectWebhook).pathname;
 assert.equal((await f.api(webhook,event,{auth:false})).status,200);
 const getJob=()=>f.db.prepare('SELECT attempts,next_at FROM misticpay_retries WHERE booking_id=?').get(booking.id);
 const job=getJob();
 assert.equal(job.attempts,0);
 assert.ok(job.next_at>Date.now());
 assert.deepEqual(alarms,[job.next_at]);
 assert.equal((await f.api(booking.path,undefined,{auth:false})).data.paid,0);
 assert.deepEqual(f.provider.checks,[request.transactionId]);

 const due=Date.now()-1;
 f.db.prepare('UPDATE misticpay_retries SET next_at=? WHERE booking_id=?').run(due,booking.id);
 await f.restart();
 assert.equal(getJob().next_at,due);
 payment.transactionState='COMPLETO';
 payment.value='180.00';
 await f.runScheduledConfirmations();

 const listed=async()=> (await f.api('/api/bookings')).data.find(row=>row.id===booking.id);
 const paid=await listed();
 assert.equal(paid.paid,1);
 assert.equal(paid.method,'MisticPay');
 assert.equal(paid.misticpay_status,'approved');
 assert.ok(paid.paid_at);
 assert.equal(getJob(),undefined);
 await f.runScheduledConfirmations();
 assert.equal((await listed()).paid_at,paid.paid_at);
 assert.deepEqual(f.provider.checks,[request.transactionId,request.transactionId]);
 assert.equal(f.provider.creates.length,1);
});

test('MisticPay: criação simultânea e resultado incerto bloqueiam uma segunda cobrança',async t=>{
 const f=await fixture(t);
 await f.activate();
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

test('MisticPay: falhas de verificação são diagnosticadas e mantêm as chaves guardadas',async t=>{
 const f=await fixture(t);
 const saved=await f.configure();
 assert.equal(saved.status,200);
 for(const [httpStatus,code,expected] of [
  [400,'API_CREDENTIAL_REQUIRED',/credencia|Client ID/i],
  [400,'VALIDATION_ERROR',/dados enviados/i],
  [401,'INVALID_API_CREDENTIAL',/inválid|revog/i],
  [401,'IP_NOT_ALLOWED',/IP/i],
  [403,'API_SCOPE_DENIED',/TRANSACTION_READ/i],
  [404,'TRANSACTION_NOT_FOUND',/Pix|transação/i],
  [404,'ROUTE_NOT_FOUND',/rota|solicitação|endereço/i],
  [404,'INTERNAL_ERROR',/falha interna/i],
  [429,'RATE_LIMIT',/limit/i],
  [500,'INTERNAL_ERROR',/MisticPay/i],
  [200,'INVALID_RESPONSE',/resposta|formato/i],
  [null,'TIMEOUT',/demor|tempo/i]
 ]){
  f.allowVerification();
  f.provider.respond=async(action,{transactionId})=>{
   assert.equal(action,'check');assert.equal(transactionId,sampleId);
   if(code==='INVALID_RESPONSE')return new Response('<html>provider-private-details pk_test sk_test</html>',{status:httpStatus});
   if(code==='TIMEOUT')throw new DOMException('provider-private-details pk_test sk_test','TimeoutError');
   return Response.json({code,message:'provider-private-details pk_test sk_test',details:{secret:'sk_test',id:sampleId}},{status:httpStatus});
  };
  const result=await f.verify();
  assert.equal(result.status,200,code);
  assert.equal(result.data.verification_state,'failed',code);
  if(httpStatus===401||code==='API_CREDENTIAL_REQUIRED')assert.equal(result.data.ready,false);
  assert.equal(result.data.public_key_configured,true);
  assert.equal(result.data.secret_key_configured,true);
  assert.equal(result.data.last_verified_at,null);
  assert.ok(result.data.last_checked_at,code);
  const diagnostic=result.data.verification_error;
  assert.ok(diagnostic,code);
  assert.equal(diagnostic.http_status,httpStatus,code);
  assert.equal(diagnostic.code,code);
  assert.match(diagnostic.operation,/check|TRANSACTION_READ|verific|consult/i);
  assert.equal(diagnostic.request_id,f.provider.calls.at(-1).requestId);
  assert.ok(diagnostic.checked_at);
  assert.match(diagnostic.message,expected);
  assert.doesNotMatch(JSON.stringify(result.data),/provider-private-details|pk_test|sk_test|31677842/);
  assert.deepEqual((await f.config()).data.verification_error,diagnostic);
  const stored=f.db.prepare('SELECT * FROM misticpay_connection').get();
  assert.ok(stored.active_credentials);
  assert.doesNotMatch(JSON.stringify(stored),/pk_test|sk_test|provider-private-details/);
 }
 const attempts=f.provider.checks.length;
 assert.equal((await f.verify()).status,429);
 assert.equal(f.provider.checks.length,attempts);
 f.allowVerification();
 delete f.provider.respond;
 f.provider.payments.set(sampleId,{...samplePayment});
 const recovered=await f.verify();
 assert.equal(recovered.status,200);
 assert.equal(recovered.data.verification_state,'verified');
 assert.equal(recovered.data.ready,true);
 assert.equal(recovered.data.verification_error,null);
 assert.equal(f.provider.creates.length,0);
});

test('MisticPay: troca de chaves confere uma cobrança conhecida sem pedir ID ao administrador',async t=>{
 const f=await fixture(t);
 await f.activate();
 const first=await f.reserve('2026-12-06');
 assert.equal((await f.api(first.path+'/misticpay',{cpf},{auth:false})).data.status,'pending');
 const firstOrder=f.db.prepare('SELECT id,provider_id FROM misticpay_orders WHERE booking_id=?').get(first.id);
 const initial=(await f.config()).data;
 const encrypted=f.db.prepare('SELECT active_credentials FROM misticpay_connection').get().active_credentials;
 const replacement={client_id:'pk_replacement',client_secret:'sk_replacement',base_url:'https://arena-new.example'};
 f.allowVerification();
 const failed=await f.configure(replacement);
 assert.equal(failed.status,200);
 assert.equal(failed.data.verification_state,'failed');
 assert.equal(failed.data.ready,true);
 assert.equal(failed.data.last_verified_at,initial.last_verified_at);
 assert.equal(failed.data.verification_error.http_status,401);
 assert.deepEqual(f.provider.checks,[sampleId,firstOrder.id]);
 const stored=f.db.prepare('SELECT * FROM misticpay_connection').get();
 assert.equal(stored.active_credentials,encrypted);
 assert.ok(stored.pending_credentials);
 assert.doesNotMatch(JSON.stringify(stored),/pk_replacement|sk_replacement|pk_test|sk_test/);
 f.provider.allowedCredentials.add(basicAuth(replacement));
 f.provider.respond=(action,{transactionId})=>{
  assert.equal(action,'check');assert.equal(transactionId,firstOrder.id);
  return Response.json({transaction:{...f.provider.payments.get(transactionId),value:179.99}});
 };
 f.allowVerification();
 const mismatch=await f.configure(replacement);
 assert.equal(mismatch.data.verification_state,'failed');
 assert.equal(mismatch.data.verification_error.code,'ORDER_MISMATCH');
 assert.equal(mismatch.data.ready,true);
 assert.equal(f.db.prepare('SELECT active_credentials FROM misticpay_connection').get().active_credentials,encrypted);
 delete f.provider.respond;
 const booking=await f.reserve('2026-12-07');
 const created=await f.api(booking.path+'/misticpay',{cpf},{auth:false});
 assert.equal(created.status,200);
 assert.equal(created.data.status,'pending');
 assert.equal(f.provider.creates.length,2);
 assert.match(f.provider.creates.at(-1).projectWebhook,/^https:\/\/arena\.example\//);

 f.allowVerification();
 const activated=await f.configure(replacement);
 assert.equal(activated.status,200);
 assert.equal(activated.data.verification_state,'verified');
 assert.equal(activated.data.verification_error,null);
 assert.equal(activated.data.ready,true);
 const latest=f.db.prepare('SELECT id FROM misticpay_orders WHERE archived=0 ORDER BY created_at DESC,id DESC LIMIT 1').get();
 assert.equal(f.provider.checks.at(-1),latest.id);
 assert.equal(f.provider.creates.length,2);
 const rotated=f.db.prepare('SELECT active_credentials,pending_credentials,base_url FROM misticpay_connection').get();
 assert.notEqual(rotated.active_credentials,encrypted);
 assert.equal(rotated.pending_credentials,null);
 assert.equal(rotated.base_url,replacement.base_url);
 f.provider.allowedCredentials.delete(basicAuth(credentials));
 const third=await f.reserve('2026-12-08');
 assert.equal((await f.api(third.path+'/misticpay',{cpf},{auth:false})).data.status,'pending');
 assert.match(f.provider.creates.at(-1).projectWebhook,/^https:\/\/arena-new\.example\//);
});

test('MisticPay: indisponibilidade preserva a configuração e acesso revogado suspende novas cobranças',async t=>{
 const f=await fixture(t);
 await f.activate();
 const stored=f.db.prepare('SELECT active_credentials FROM misticpay_connection').get();
 f.allowVerification();
 f.provider.accessError={code:'INTERNAL_ERROR',status:500};
 const unavailable=await f.verify();
 assert.equal(unavailable.data.verification_state,'failed');
 assert.equal(unavailable.data.ready,true);
 f.allowVerification();
 f.provider.accessError={code:'INVALID_API_CREDENTIAL',status:401};
 const revoked=await f.verify();
 assert.equal(revoked.data.verification_state,'failed');
 assert.equal(revoked.data.ready,false);
 assert.deepEqual(f.db.prepare('SELECT active_credentials FROM misticpay_connection').get(),stored);
 f.allowVerification();
 delete f.provider.accessError;
 const recovered=await f.verify();
 assert.equal(recovered.data.verification_state,'verified');
 assert.equal(recovered.data.ready,true);
 assert.equal(f.provider.creates.length,0);
});
