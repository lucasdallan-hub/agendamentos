import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
import {createApplication} from '../server-core.js';
import {captureSystem,installSystem} from '../systems.js';

const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/F6cAAAAASUVORK5CYII=';
const RAW_SECRET='fake-raw-whatsapp-pairing-secret';
const status=(connected=false,loggedIn=false)=>Response.json({message:'success',data:{Connected:connected,LoggedIn:loggedIn}});
async function fixture(t,{seed=true,respond}={}){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');const requests=[];let cookie='';
 const notificationFetch=async(url,options)=>{
  const request={url:String(url),headers:new Headers(options.headers),method:options.method,body:options.body,options};requests.push(request);
  if(respond)return respond(request);
  if(request.url.endsWith('/instance/status'))return status();
  if(request.url.endsWith('/instance/qr'))return Response.json({message:'success',data:{qrcode:PNG,code:RAW_SECRET}});
  throw Error('Unexpected fake endpoint');
 };
 const {server}=createApplication({db,notificationFetch,paymentConfig:{ready:false,mode:'test'},receiptReader:async()=>({amount_cents:null})});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
 async function api(route,body,{auth=true,method='POST'}={}){
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/`+route,{method:body===undefined?'GET':method,headers:{'Content-Type':'application/json',...(auth?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  if(auth&&response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
  return {status:response.status,data:await response.json()};
 }
 if(seed)assert.equal((await api('setup',{password:'qr-flow-password-123'})).status,200);
 const configure=(overrides={})=>api('notifications/config',{enabled:false,target:'arena',api_key:'qr-instance-token',...overrides},{method:'PUT'});
 return {db,api,requests,configure};
}

test('Evolution Go QR: URL padrão e Swagger normalizados, conexão independente da ativação de envios',async t=>{
 const f=await fixture(t,{respond:async()=>status(true,true)});
 const initial=await f.api('notifications/config');assert.equal(initial.data.base_url,'https://api.dallan.pro');assert.equal(initial.data.connection_ready,false);
 assert.equal((await f.api('notifications/connect',{},{auth:false})).status,401);assert.equal((await f.api('notifications/connect',{})).status,409);assert.equal(f.requests.length,0);
 for(const base_url of ['https://api.dallan.pro/swagger/index.html','/swagger/index.html']){
  const saved=await f.configure({base_url});assert.equal(saved.status,200);assert.equal(saved.data.base_url,'https://api.dallan.pro');assert.equal(saved.data.enabled,false);assert.equal(saved.data.ready,false);assert.equal(saved.data.connection_ready,true);
 }
 assert.equal(f.requests.length,0,'saving never pairs or sends');
 const checked=await f.api('notifications/check',{});assert.equal(checked.status,200);assert.deepEqual(checked.data,{connected:true,logged_in:true});
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].url,'https://api.dallan.pro/instance/status');
 assert.equal((await f.api('notifications/events')).data.length,0);assert.equal(f.requests.length,1);
});

test('Evolution Go QR: consulta a sessão primeiro e não reinicia uma instância já autenticada',async t=>{
 for(const connected of [true,false]){
  const f=await fixture(t,{respond:async request=>{assert.ok(request.url.endsWith('/instance/status'),'logged in instance must not call QR route');return status(connected,true);}});
  await f.configure();const result=await f.api('notifications/connect',{});
  assert.equal(result.status,200);assert.equal(result.data.connected,connected);assert.equal(result.data.logged_in,true);assert.equal(result.data.qr_code,undefined);
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].method,'GET');assert.equal(f.requests[0].body,undefined);
 }
});

test('Evolution Go QR: obtém PNG temporário por GET sem expor código bruto nem guardar QR',async t=>{
 const f=await fixture(t);await f.configure();const before=Date.now();
 const result=await f.api('notifications/connect',{});const after=Date.now();
 assert.equal(result.status,200);assert.equal(result.data.connected,false);assert.equal(result.data.logged_in,false);assert.equal(result.data.qr_code,PNG);
 const expires=Date.parse(result.data.expires_at);assert.ok(expires>=before+19000&&expires<=after+21000,'QR has local lifetime of about twenty seconds');
 assert.equal(result.data.code,undefined);assert.equal(JSON.stringify(result.data).includes(RAW_SECRET),false);assert.equal(JSON.stringify(result.data).includes('qr-instance-token'),false);
 assert.deepEqual(f.requests.map(r=>r.url),['https://api.dallan.pro/instance/status','https://api.dallan.pro/instance/qr']);
 for(const request of f.requests){assert.equal(request.method,'GET');assert.equal(request.headers.get('apikey'),'qr-instance-token');assert.equal(request.body,undefined);assert.equal(request.options.redirect,'error');assert.ok(request.options.signal instanceof AbortSignal);}
 const summary=await f.api('notifications/config');assert.equal(JSON.stringify(summary.data).includes(PNG),false);assert.equal(JSON.stringify(summary.data).includes(RAW_SECRET),false);
 assert.equal(JSON.stringify((await f.api('notifications/events')).data).includes(PNG),false);
 const snapshot=JSON.stringify(captureSystem(f.db));assert.equal(snapshot.includes(PNG),false);assert.equal(snapshot.includes(RAW_SECRET),false);assert.equal(snapshot.includes('qr-instance-token'),false);
 assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM notification_connection').get()).includes(PNG),false);
});

test('Evolution Go QR: exige verificação adicional sem repassar passkey, códigos ou links do provedor',async t=>{
 const f=await fixture(t,{respond:async request=>request.url.endsWith('/instance/status')?status():Response.json({message:'success',data:{passkeyStage:'verification',code:RAW_SECRET,url:'https://provider.example/'+RAW_SECRET,passkeyCode:RAW_SECRET}})});
 await f.configure();const result=await f.api('notifications/connect',{});
 assert.equal(result.status,200);assert.equal(result.data.state,'additional_verification');assert.equal(result.data.qr_code,undefined);
 for(const property of ['code','url','passkeyCode','passkeyStage'])assert.equal(result.data[property],undefined);
 assert.equal(JSON.stringify(result.data).includes(RAW_SECRET),false);
});

test('Evolution Go QR: rejeita QR remoto, SVG, base64 inválido, tamanho excessivo e erro do provedor',async t=>{
 const oversized='data:image/png;base64,'+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(512*1024)]).toString('base64');
 for(const qrResponse of [
  async()=>Response.json({message:'success',data:{qrcode:'https://provider.example/qr.png',code:RAW_SECRET}}),
  async()=>Response.json({message:'success',data:{qrcode:'data:image/svg+xml;base64,PHN2Zz4=',code:RAW_SECRET}}),
  async()=>Response.json({message:'success',data:{qrcode:'data:image/png;base64,YWJj',code:RAW_SECRET}}),
  async()=>Response.json({message:'success',data:{qrcode:PNG.slice(0,-1),code:RAW_SECRET}}),
  async()=>Response.json({message:'success',data:{qrcode:oversized,code:RAW_SECRET}}),
  async()=>Response.json({message:'success',data:{code:RAW_SECRET}}),
  async()=>Response.json({message:'error',data:{qrcode:PNG},error:RAW_SECRET}),
  async()=>Response.json({error:RAW_SECRET},{status:401}),
  async()=>new Response(RAW_SECRET,{status:200}),
  async()=>{throw Error(RAW_SECRET);}
 ]){
  const f=await fixture(t,{respond:async request=>request.url.endsWith('/instance/status')?status():qrResponse()});await f.configure();
  const result=await f.api('notifications/connect',{});assert.equal(result.status,502);
  assert.equal(result.data.qr_code,undefined);assert.equal(JSON.stringify(result.data).includes(RAW_SECRET),false);assert.equal(JSON.stringify(result.data).includes('qr-instance-token'),false);assert.equal(JSON.stringify(result.data).includes(PNG),false);
  assert.equal(f.requests.length,2);assert.ok(f.requests.every(r=>r.method==='GET'));
 }
});

test('Evolution Go QR: resposta inválida do status interrompe o fluxo antes da geração do QR',async t=>{
 const f=await fixture(t,{respond:async()=>Response.json({message:'success',data:{connected:false,loggedIn:false},error:RAW_SECRET})});await f.configure();
 const result=await f.api('notifications/connect',{});assert.equal(result.status,502);assert.equal(f.requests.length,1);assert.equal(JSON.stringify(result.data).includes(RAW_SECRET),false);
});

test('Evolution Go QR: filhos têm sessão própria e não herdam token ou QR da mãe',async t=>{
 const mother=await fixture(t),child=await fixture(t,{seed:false});await mother.configure({api_key:'mother-qr-token'});
 assert.equal((await mother.api('notifications/connect',{})).status,200);
 installSystem(child.db,{slug:'filho-qr',name:'Filho QR',password:'child-qr-password-123',snapshot:captureSystem(mother.db)});
 assert.equal((await child.api('login',{password:'child-qr-password-123'})).status,200);
 const config=await child.api('notifications/config');assert.equal(config.data.connection_ready,false);assert.equal(config.data.token_configured,false);
 assert.equal((await child.api('notifications/connect',{})).status,409);assert.equal(child.requests.length,0);
 await child.configure({api_key:'child-qr-token',base_url:'https://child-evolution.example.com'});
 assert.equal((await child.api('notifications/connect',{})).status,200);
 assert.ok(mother.requests.every(r=>r.headers.get('apikey')==='mother-qr-token'));assert.ok(child.requests.every(r=>r.headers.get('apikey')==='child-qr-token'));assert.equal(child.requests[1].url,'https://child-evolution.example.com/instance/qr');
});

test('Evolution Go diagnóstico: identifica HTTP de autenticação, rota, limite e indisponibilidade sem expor a resposta',async t=>{
 for(const [httpStatus,expected] of [[401,/token/i],[403,/acesso|permiss/i],[404,/rota/i],[429,/limite/i],[500,/API|Evolution/i],[503,/API|Evolution/i]]){
  for(const endpoint of ['status','qr']){
   const f=await fixture(t,{respond:async request=>endpoint==='qr'&&request.url.endsWith('/instance/status')?status():Response.json({error:RAW_SECRET,token:'qr-instance-token'},{status:httpStatus})});
   await f.configure();
   const result=await f.api(endpoint==='status'?'notifications/check':'notifications/connect',{});
   assert.equal(result.status,502,`upstream ${httpStatus}, ${endpoint}`);assert.match(result.data.error,new RegExp(String(httpStatus)));assert.match(result.data.error,expected);
   if(httpStatus===404)assert.ok(result.data.error.includes('/instance/'+endpoint),'route failure identifies the exact upstream path');
   assert.equal(JSON.stringify(result.data).includes(RAW_SECRET),false);assert.equal(JSON.stringify(result.data).includes('qr-instance-token'),false);
   assert.equal(f.requests.length,endpoint==='qr'?2:1);
  }
 }
});

test('Evolution Go diagnóstico: diferencia DNS, conexão recusada, TLS e timeout sem copiar erros privados',async t=>{
 const networkError=code=>new TypeError(RAW_SECRET,{cause:{code,message:RAW_SECRET}});
 const scenarios=[
  [()=>networkError('ENOTFOUND'),502,/DNS/i],
  [()=>networkError('ECONNREFUSED'),502,/conexão|conexao/i],
  ...['CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','DEPTH_ZERO_SELF_SIGNED_CERT','ERR_TLS_CERT_ALTNAME_INVALID'].map(code=>[()=>networkError(code),502,/TLS|certificado/i]),
  [()=>new DOMException(RAW_SECRET,'TimeoutError'),504,/tempo|demor|timeout/i],
  [()=>new DOMException(RAW_SECRET,'AbortError'),504,/tempo|demor|timeout/i],
  [()=>new TypeError(RAW_SECRET),502,/endereço|acesso|rede|servidor/i]
 ];
 for(const [error,statusCode,expected] of scenarios){
  const f=await fixture(t,{respond:async()=>{throw error();}});await f.configure();
  const result=await f.api('notifications/check',{});assert.equal(result.status,statusCode);assert.match(result.data.error,expected);
  assert.equal(JSON.stringify(result.data).includes(RAW_SECRET),false);assert.equal(JSON.stringify(result.data).includes('qr-instance-token'),false);assert.equal(f.requests.length,1);
 }
});

test('Evolution Go diagnóstico: HTTP 200 com corpo não JSON informa erro de formato, sem classificá-lo como falha de rede',async t=>{
 for(const endpoint of ['status','qr']){
  const f=await fixture(t,{respond:async request=>endpoint==='qr'&&request.url.endsWith('/instance/status')?status():new Response('<html>'+RAW_SECRET+'</html>',{status:200,headers:{'Content-Type':'text/html'}})});await f.configure();
  const result=await f.api(endpoint==='status'?'notifications/check':'notifications/connect',{});
  assert.equal(result.status,502);assert.match(result.data.error,/JSON/i);assert.equal(JSON.stringify(result.data).includes(RAW_SECRET),false);assert.equal(JSON.stringify(result.data).includes('qr-instance-token'),false);
 }
});
