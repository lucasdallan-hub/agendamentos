import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {createApplication} from '../server-core.js';
import {captureSystem,installSystem} from '../systems.js';

const dateAfter=days=>{const date=new Date();date.setUTCDate(date.getUTCDate()+days);return date.toISOString().slice(0,10);};
const configuration=(overrides={})=>({enabled:true,base_url:'https://evolution.example.com',api_key:'fake-instance-token',target:'arena',arena_number:'(21) 98888-7777',country_code:'55',...overrides});
async function arena(t,{seed=true,send}={}){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
 const requests=[];let cookie='',server,court;
 const notificationFetch=async(url,options)=>{
  requests.push({url:String(url),headers:new Headers(options.headers),body:options.body?JSON.parse(options.body):undefined,options});
  return send?send(url,options):Response.json({message:'success',data:{Info:{ID:'fake-message-id'}}});
 };
 async function start(){({server}=createApplication({db,notificationFetch,paymentConfig:{ready:false,mode:'test'},receiptReader:async()=>({amount_cents:null})}));server.listen(0,'127.0.0.1');await once(server,'listening');cookie='';}
 async function api(path,body,{method='POST',auth=true}={}){
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/`+path,{method:body===undefined?'GET':method,headers:{'Content-Type':'application/json',...(auth?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  if(auth&&response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
  return {status:response.status,data:await response.json()};
 }
 await start();t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
 if(seed){assert.equal((await api('setup',{password:'notification-test-password'})).status,200);court=(await api('courts',{name:'Quadra WhatsApp',type:'Areia',price:120})).data.id;}
 return {db,api,requests,get court(){return court;},booking:(overrides={})=>({court_id:court,customer:'Cliente Teste',phone:'(11) 99999-8888',date:dateAfter(2),start:'18:00',end:'19:00',notes:'NOTA PRIVADA',...overrides}),restart:async()=>{await new Promise(resolve=>server.close(resolve));await start();assert.equal((await api('login',{password:'notification-test-password'})).status,200);}};
}

test('Evolution Go: configuração autenticada, validação, segredo preservado e nenhuma mensagem ao salvar',async t=>{
 const f=await arena(t);
 assert.equal((await f.api('notifications/config',undefined,{auth:false})).status,401);
 assert.equal((await f.api('notifications/events',undefined,{auth:false})).status,401);
 assert.equal((await f.api('notifications/config',configuration(),{method:'PUT',auth:false})).status,401);
 const initial=await f.api('notifications/config');assert.equal(initial.status,200);assert.equal(initial.data.enabled,false);assert.equal(initial.data.ready,false);
 assert.equal((await f.api('notifications/config',{enabled:false},{method:'PUT'})).status,200);
 for(const body of [configuration({base_url:'http://evolution.example.com'}),configuration({api_key:'bad\nheader'}),configuration({target:'arena',arena_number:'1'}),configuration({country_code:'invalid'}),configuration({target:'client'}),configuration({target:'both'})])assert.equal((await f.api('notifications/config',body,{method:'PUT'})).status,400);
 const saved=await f.api('notifications/config',configuration(),{method:'PUT'});assert.equal(saved.status,200);assert.equal(saved.data.ready,true);assert.equal(saved.data.token_configured,true);
 assert.equal(JSON.stringify(saved.data).includes('fake-instance-token'),false);assert.equal(saved.data.api_key,undefined);
 assert.equal((await f.api('notifications/config',configuration({api_key:''}),{method:'PUT'})).status,200);
 assert.equal(f.requests.length,0);
 await f.restart();const persisted=await f.api('notifications/config');assert.equal(persisted.data.ready,true);assert.equal(persisted.data.token_configured,true);
});

test('Evolution Go: novo agendamento administrativo envia uma única confirmação com protocolo e valor corretos',async t=>{
 const f=await arena(t);
 assert.equal((await f.api('bookings',f.booking())).status,201);assert.equal(f.requests.length,0,'disabled by default');
 assert.equal((await f.api('notifications/config',configuration(),{method:'PUT'})).status,200);
 const booking=await f.api('bookings',f.booking({date:dateAfter(3)}));assert.equal(booking.status,201);assert.equal(f.requests.length,1);
 const request=f.requests[0];assert.equal(request.url,'https://evolution.example.com/send/text');assert.equal(request.headers.get('apikey'),'fake-instance-token');assert.equal(request.headers.get('Content-Type'),'application/json');assert.equal(request.body.number,'5521988887777');assert.notEqual(request.body.number,'5511999998888');assert.equal(request.body.formatJid,true);assert.ok(typeof request.body.id==='string'&&request.body.id.length>0);assert.equal(request.options.method,'POST');assert.equal(request.options.redirect,'error');assert.ok(request.options.signal instanceof AbortSignal);
 assert.match(request.body.text,/Cliente Teste/);assert.match(request.body.text,/Quadra WhatsApp/);assert.match(request.body.text,/18:00/);assert.match(request.body.text,/120,00/);assert.equal(request.body.text.includes('NOTA PRIVADA'),false);
 const events=await f.api('notifications/events');assert.equal(events.status,200);assert.equal(events.data.length,1);assert.equal(events.data[0].status,'accepted');assert.equal(events.data[0].booking_id,booking.data.id);assert.equal(JSON.stringify(events.data).includes('fake-instance-token'),false);
 assert.equal((await f.api('bookings',f.booking({date:dateAfter(3)}))).status,409);assert.equal(f.requests.length,1,'booking conflict must not send notification');
});

test('Evolution Go: reserva pública e repetição idempotente não duplicam mensagens',async t=>{
 const f=await arena(t);await f.api('notifications/config',configuration(),{method:'PUT'});
 const body={...f.booking(),request_key:randomBytes(32).toString('hex')};
 const first=await f.api('public/bookings',body,{auth:false});assert.equal(first.status,201);assert.equal(f.requests.length,1);
 const replay=await f.api('public/bookings',body,{auth:false});assert.equal(replay.status,201);assert.equal(replay.data.token,first.data.token);assert.equal(f.requests.length,1);
 assert.equal((await f.api('notifications/events')).data[0].booking_id,first.data.reservation.id);
});

test('Evolution Go: envia apenas para o administrador cadastrado, sem usar o telefone do cliente',async t=>{
 const f=await arena(t);await f.api('notifications/config',configuration(),{method:'PUT'});
 assert.equal((await f.api('bookings',f.booking())).status,201);
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].body.number,'5521988887777');
 assert.equal((await f.api('notifications/config')).data.target,'arena');
 await f.api('notifications/config',configuration({arena_number:'(31) 97777-6666'}),{method:'PUT'});
 assert.equal((await f.api('bookings',f.booking({date:dateAfter(3),phone:'1'}))).status,201);
 assert.equal(f.requests.length,2);assert.equal(f.requests.at(-1).body.number,'5531977776666');
 assert.ok(f.requests.every(r=>r.body.number!=='5511999998888'));
 const international=await f.api('notifications/config',configuration({arena_number:'+1 (212) 555-1234'}),{method:'PUT'});
 assert.equal(international.data.arena_number,'12125551234');
 const preserved=await f.api('notifications/config',{...international.data,api_key:''},{method:'PUT'});
 assert.equal(preserved.data.arena_number,'12125551234','saving a canonical international number must not prepend Brazil a second time');
});

test('Evolution Go: falha da API ou resposta incerta preserva a reserva e não repete envio automaticamente',async t=>{
 for(const [type,send,expected] of [
  ['rejeitada',async()=>Response.json({error:'raw-provider-secret fake-instance-token'},{status:401}),'failed'],
  ['HTTP 500',async()=>Response.json({error:'raw-provider-secret fake-instance-token'},{status:500}),'unknown'],
  ['HTTP 408',async()=>Response.json({error:'raw-provider-secret fake-instance-token'},{status:408}),'unknown'],
  ['transporte',async()=>{throw Error('raw-provider-secret fake-instance-token');},'unknown'],
  ['JSON inválido em HTTP 200',async()=>new Response('raw-provider-secret fake-instance-token',{status:200}),'unknown'],
  ['envelope inválido em HTTP 200',async()=>Response.json({message:'error',detail:'raw-provider-secret fake-instance-token'}),'unknown']
 ]){
  const f=await arena(t,{send});await f.api('notifications/config',configuration(),{method:'PUT'});
  const body={...f.booking(),request_key:randomBytes(32).toString('hex')};
  const created=await f.api('public/bookings',body,{auth:false});assert.equal(created.status,201,type);assert.equal((await f.api('bookings')).data.length,1,type);
  const events=await f.api('notifications/events');assert.equal(events.data[0].status,expected,type);assert.equal(JSON.stringify(events.data).includes('raw-provider-secret'),false);assert.equal(JSON.stringify(events.data).includes('fake-instance-token'),false);
  assert.equal((await f.api('public/bookings',body,{auth:false})).status,201);assert.equal(f.requests.length,1,type);
 }
 const invalid=await arena(t);await invalid.api('notifications/config',configuration(),{method:'PUT'});
 assert.equal((await invalid.api('bookings',invalid.booking({phone:'1'}))).status,201);assert.equal(invalid.requests.length,1);assert.equal(invalid.requests[0].body.number,'5521988887777');assert.equal((await invalid.api('notifications/events')).data[0].status,'accepted');
});

test('Evolution Go: filhos não herdam conexão nem disparam notificações do histórico copiado',async t=>{
 const mother=await arena(t),child=await arena(t,{seed:false});
 await mother.api('notifications/config',configuration({api_key:'mother-instance-token'}),{method:'PUT'});
 await mother.api('bookings',mother.booking());assert.equal(mother.requests.length,1);
 const snapshot=captureSystem(mother.db);assert.equal(JSON.stringify(snapshot).includes('mother-instance-token'),false);
 installSystem(child.db,{slug:'filho',name:'Arena Filha',password:'child-notification-password',snapshot});
 assert.equal((await child.api('login',{password:'child-notification-password'})).status,200);
 const config=await child.api('notifications/config');assert.equal(config.data.enabled,false);assert.equal(config.data.token_configured,false);assert.equal((await child.api('notifications/events')).data.length,0);assert.equal(child.requests.length,0);
 await child.api('notifications/config',configuration({api_key:'child-instance-token',arena_number:'(31) 97777-6666'}),{method:'PUT'});
 const court=(await child.api('courts')).data[0].id;
 assert.equal((await child.api('bookings',mother.booking({court_id:court,date:dateAfter(3)}))).status,201);
 assert.equal(child.requests.length,1);assert.equal(child.requests[0].headers.get('apikey'),'child-instance-token');assert.equal(child.requests[0].body.number,'5531977776666');assert.equal(mother.requests[0].body.number,'5521988887777');assert.equal(mother.requests.length,1);
 assert.equal((await mother.api('notifications/events')).data.length,1);
});


test('Evolution Go: verificar conexão consulta status da instância sem enviar mensagens',async t=>{
 let connected=true,loggedIn=true;
 const f=await arena(t,{send:async()=>Response.json({message:'success',data:{Connected:connected,LoggedIn:loggedIn}})});
 assert.equal((await f.api('notifications/check',{},{auth:false})).status,401);
 assert.equal((await f.api('notifications/check',{})).status,409);assert.equal(f.requests.length,0);
 await f.api('notifications/config',configuration(),{method:'PUT'});
 for(const state of [[true,true],[false,true],[true,false],[false,false]]){
  [connected,loggedIn]=state;
  const result=await f.api('notifications/check',{});
  assert.equal(result.status,200);assert.deepEqual(result.data,{connected,logged_in:loggedIn});
 }
 assert.equal(f.requests.length,4);
 for(const request of f.requests){
  assert.equal(request.url,'https://evolution.example.com/instance/status');assert.equal(request.options.method,'GET');assert.equal(request.headers.get('apikey'),'fake-instance-token');assert.equal(request.body,undefined);assert.equal(request.options.redirect,'error');assert.ok(request.options.signal instanceof AbortSignal);
 }
 assert.equal((await f.api('notifications/events')).data.length,0);
});

test('Evolution Go: falha ou formato inesperado ao verificar conexão retorna erro seguro',async t=>{
 for(const send of [
  async()=>Response.json({error:'raw-provider-secret fake-instance-token'},{status:401}),
  async()=>Response.json({error:'raw-provider-secret fake-instance-token'},{status:503}),
  async()=>new Response('raw-provider-secret fake-instance-token',{status:200}),
  async()=>Response.json({message:'success',data:{connected:true,loggedIn:true},detail:'raw-provider-secret fake-instance-token'}),
  async()=>Response.json({message:'success',data:{Connected:'true',LoggedIn:'true'},detail:'raw-provider-secret fake-instance-token'}),
  async()=>{throw Error('raw-provider-secret fake-instance-token');}
 ]){
  const f=await arena(t,{send});await f.api('notifications/config',configuration(),{method:'PUT'});
  const result=await f.api('notifications/check',{});assert.equal(result.status,502);
  assert.equal(JSON.stringify(result.data).includes('raw-provider-secret'),false);assert.equal(JSON.stringify(result.data).includes('fake-instance-token'),false);
  assert.equal(f.requests.length,1);assert.equal((await f.api('notifications/events')).data.length,0);
 }
});


test('Evolution Go: retoma apenas envio pendente após reinício, sem repetir resultados anteriores',async t=>{
 const f=await arena(t),rows=[];
 for(let i=0;i<5;i++)rows.push((await f.api('bookings',f.booking({date:dateAfter(i+2)}))).data.id);
 assert.equal(f.requests.length,0);
 await f.api('notifications/config',configuration(),{method:'PUT'});
 const statuses=['pending','unknown','failed','accepted','sending'];
 const ids=statuses.map(()=>randomBytes(16).toString('hex'));
 const timestamp=new Date(Date.now()-60000).toISOString();
 for(let i=0;i<statuses.length;i++)f.db.prepare('INSERT INTO booking_notifications(id,booking_id,recipient,status,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(ids[i],rows[i],'5521988887777',statuses[i],timestamp,timestamp);
 await f.restart();assert.equal(f.requests.length,0,'restarting alone does not send an old uncertain message');
 assert.equal((await f.api('notifications/events',undefined,{auth:false})).status,401);assert.equal(f.requests.length,0);
 const recovered=await f.api('notifications/events');assert.equal(recovered.status,200);assert.equal(f.requests.length,1);
 assert.equal(f.requests[0].body.id,ids[0]);assert.equal(f.requests[0].body.number,'5521988887777');
 const byId=Object.fromEntries(recovered.data.map(event=>[event.id,event]));
 assert.equal(byId[ids[0]].status,'accepted');assert.equal(byId[ids[1]].status,'unknown');assert.equal(byId[ids[2]].status,'failed');assert.equal(byId[ids[3]].status,'accepted');assert.equal(byId[ids[4]].status,'unknown');
 await f.api('notifications/events');assert.equal(f.requests.length,1,'refresh does not resend accepted, unknown, failed or interrupted sends');
});

test('Evolution Go: repetição simultânea de uma reserva não disputa o envio já iniciado',{timeout:5000},async t=>{
 let release,notifyStarted;
 const held=new Promise(resolve=>{release=resolve;});const started=new Promise(resolve=>{notifyStarted=resolve;});
 const f=await arena(t,{send:async()=>{notifyStarted();await held;return Response.json({message:'success',data:{Info:{ID:'fake-concurrent-id'}}});}});
 await f.api('notifications/config',configuration(),{method:'PUT'});
 const body={...f.booking(),request_key:randomBytes(32).toString('hex')};
 const first=f.api('public/bookings',body,{auth:false});let replay;
 try{
  await started;
  replay=await f.api('public/bookings',body,{auth:false});assert.equal(replay.status,201);
  assert.equal(f.requests.length,1);assert.equal(f.db.prepare('SELECT status FROM booking_notifications').get().status,'sending');
 }finally{release();}
 const initial=await first;assert.equal(initial.status,201);assert.equal(initial.data.token,replay.data.token);
 const events=await f.api('notifications/events');assert.equal(events.data.length,1);assert.equal(events.data[0].status,'accepted');assert.equal(f.requests.length,1);
});

test('Evolution Go: atualiza endereço Swagger legado ao reiniciar e preserva credenciais e destinatário',async t=>{
 const f=await arena(t,{send:async()=>Response.json({message:'success',data:{Connected:true,LoggedIn:true}})});
 await f.api('notifications/config',configuration(),{method:'PUT'});
 f.db.prepare('UPDATE notification_connection SET base_url=? WHERE id=1').run('https://evolution.example.com/swagger/index.html');
 await f.restart();
 const config=await f.api('notifications/config');
 assert.equal(config.status,200);assert.equal(config.data.base_url,'https://evolution.example.com');assert.equal(config.data.enabled,true);assert.equal(config.data.token_configured,true);assert.equal(config.data.arena_number,'5521988887777');
 assert.equal(f.db.prepare('SELECT api_key FROM notification_connection WHERE id=1').get().api_key,'fake-instance-token');
 const checked=await f.api('notifications/check',{});assert.equal(checked.status,200);assert.equal(checked.data.logged_in,true);
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].url,'https://evolution.example.com/instance/status');assert.equal(f.requests[0].headers.get('apikey'),'fake-instance-token');
});
