import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directory=await mkdtemp(path.join(os.tmpdir(),'arena-cloudflare-test-'));
console.log('Cloudflare smoke: production Worker, SQLite, receipt OCR and split Pix');
const password='admin';
const misticpayTestKey=` \r\n${randomBytes(32).toString('hex')}\n`;
const configFile=path.join(directory,'wrangler.json');
const persist=path.join(directory,'state');
let worker,output='',cookie='',checks=0;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const freePort=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const port=await freePort();
const base=`http://127.0.0.1:${port}`;
const fixture=await readFile(path.join(root,'test/fixtures/pix-receipt.png'));
function passed(label){checks++;console.log('PASS:',label);}
function logs(){return output.split('\n').slice(-70).join('\n').replaceAll(password,'[test password]');}
async function makeConfig({bootstrap=false}={}){
 const config=JSON.parse(await readFile(path.join(root,'wrangler.jsonc'),'utf8'));
 delete config.$schema;
 config.name='arena-volei-local-smoke';
 config.main=path.join(root,'cloudflare/worker.js');
 config.assets.directory=path.join(root,'public');
 config.assets.html_handling='none';
 config.dev={...config.dev,enable_containers:false};
 config.observability={enabled:false};
 config.vars={
  ...config.vars,MISTICPAY_CREDENTIALS_KEY:'invalid-local-key',MISTICPAY_MANAGED_CREDENTIALS_KEY:misticpayTestKey,
  ...(bootstrap?{ADMIN_INITIAL_PASSWORD:password}:{})
 };
 await writeFile(configFile,JSON.stringify(config,null,2),{mode:0o600});
}
async function stop(){
 if(!worker)return;
 const child=worker;worker=undefined;
 if(child.exitCode!==null)return;
 const exited=new Promise(resolve=>child.once('exit',resolve));
 try{process.kill(-child.pid,'SIGTERM');}catch{}
 await Promise.race([exited,delay(5000)]);
 if(child.exitCode===null){try{process.kill(-child.pid,'SIGKILL');}catch{}await exited;}
}
async function start(options){
 await makeConfig(options);output='';
 worker=spawn(process.execPath,[path.join(root,'node_modules/wrangler/bin/wrangler.js'),'dev','--local','--test-scheduled','--config',configFile,'--ip','127.0.0.1','--port',String(port),'--inspector-port','0','--persist-to',persist,'--log-level','warn','--show-interactive-dev-session','false'],{cwd:root,detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,XDG_CONFIG_HOME:path.join(directory,'config'),WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:path.join(directory,'wrangler.log')}});
 for(const stream of [worker.stdout,worker.stderr])stream.on('data',chunk=>{output+=chunk.toString();if(output.length>100000)output=output.slice(-80000);});
 const deadline=Date.now()+60000;
 while(Date.now()<deadline){
  if(worker.exitCode!==null)throw Error(`Wrangler exited before readiness (${worker.exitCode})\n${logs()}`);
  try{const response=await fetch(base+'/api/session',{signal:AbortSignal.timeout(1000)});if(response.headers.get('content-type')?.includes('application/json'))return;}catch{}
  await delay(200);
 }
 throw Error('Wrangler did not become ready\n'+logs());
}
async function api(route,body,{auth=true,headers={},method}={}){
 const requestFetch=headers.Host?async(url,options)=>new Promise((resolve,reject)=>{const request=http.request(url,{method:options.method,headers:options.headers},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers:response.headers})));});request.on('error',reject);request.end(options.body);}):fetch;
 const response=await requestFetch(base+route,{method:method||(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json',...(auth&&cookie?{Cookie:cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
 const setCookie=response.headers.get('set-cookie');if(setCookie&&auth)cookie=setCookie.split(';')[0];
 const data=response.headers.get('content-type')?.includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer());
 return {status:response.status,headers:response.headers,data};
}
async function readReceiptResult(token){
 const deadline=Date.now()+25_000;
 while(Date.now()<deadline){
  const result=await api(`/api/pix/payments/${token}`,undefined,{auth:false});
  assert.equal(result.status,200,JSON.stringify(result.data));
  if(result.data.receipt?.match_status!=='processing')return result.data;
  await delay(300);
 }
 throw Error('A leitura do comprovante não terminou.\n'+logs());
}

try{
 await start({bootstrap:false});
 const unconfigured=await api('/api/session');assert.equal(unconfigured.status,200,JSON.stringify(unconfigured.data));
 assert.equal(unconfigured.data.setup,false);
 assert.equal((await api('/api/login',{username:'other',password})).status,401);
 assert.equal((await api('/api/login',{username:'admin',password})).status,200);
 cookie='';
 passed('default admin login works without a bootstrap secret and rejects other usernames');
 await stop();
 await start({bootstrap:true});
 for(const route of ['/','/catalogo','/pix','/pagamento','/theme.js','/sidebar.js','/app.js','/pdv.js','/pix.js','/style.css','/refresh.css','/refresh-public.css','/arena-hero.webp']){
  const response=await api(route);assert.equal(response.status,200,`Asset ${route}: ${response.status}`);assert.equal(response.headers.get('x-content-type-options'),'nosniff');
 }
 assert.equal((await api('/missing')).status,404);
 passed('static pages, JavaScript and security headers served without redirect loops');
 assert.equal((await api('/api/session')).data.setup,false);
 assert.equal((await api('/api/setup',{password:'intruder-password'})).status,409);
 assert.equal((await api('/api/bookings',undefined,{auth:false})).status,401);
 const login=await api('/api/login',{password});assert.equal(login.status,200,JSON.stringify(login.data));
 assert.match(login.headers.get('set-cookie'),/; Secure/);assert.match(login.headers.get('set-cookie'),/HttpOnly/);
 passed('bootstrap login, authorization and secure session cookie');
 const misticpayConfigPath='/api/misticpay/config';
 assert.equal((await api(misticpayConfigPath,undefined,{auth:false})).status,401);
 assert.equal((await api(misticpayConfigPath)).data.storage_status,'ready');
 const misticpayDraft=await api(misticpayConfigPath,{
  client_id:'pk_local_fixture',client_secret:'sk_local_fixture',base_url:'https://arena.example'
 },{method:'PUT'});
 assert.equal(misticpayDraft.status,200,JSON.stringify(misticpayDraft.data));
 assert.equal(misticpayDraft.data.verification_state,'configured');
 assert.equal(misticpayDraft.data.ready,true);
 assert.equal(misticpayDraft.data.last_verified_at,null);
 assert.doesNotMatch(JSON.stringify(misticpayDraft.data),/local_fixture/);
 assert.equal((await api(misticpayConfigPath+'/verify',{})).status,400);
 passed('MisticPay credentials save inside Durable SQLite and enable Pix without a preliminary lookup');
 const cross=await api('/api/courts',{name:'Nope',type:'Areia',price:120},{headers:{Origin:'https://attacker.example'}});assert.equal(cross.status,403);
 const sameOrigin=await api('/api/courts',{name:'Areia CF',type:'Vôlei de areia',price:120},{headers:{Origin:base}});assert.equal(sameOrigin.status,201,JSON.stringify(sameOrigin.data));
 const court=sameOrigin.data.id;
 passed('same-origin requests accepted and cross-origin mutation blocked');
 const reservation={court_id:court,customer:'Cliente Cloudflare',phone:'11999000000',date:'2026-12-01',start:'18:00',end:'19:30',notes:'Notas privadas'};
 const created=await api('/api/bookings',reservation);assert.equal(created.status,201,JSON.stringify(created.data));const id=created.data.id;
 assert.equal((await api('/api/bookings',{...reservation,start:'19:00',end:'20:00'})).status,409);
 assert.equal((await api('/api/bookings')).data.find(b=>b.id===id).total,18000);
 passed('Durable SQLite court, booking, proportional amount and overlap prevention');
 const settings=await api('/api/pix/settings',{key:'pix@arena.example',receiver:'Arena de teste'},{method:'PUT'});assert.equal(settings.status,200,JSON.stringify(settings.data));
 const link=await api(`/api/bookings/${id}/pix-link`,{});assert.equal(link.status,200,JSON.stringify(link.data));
 const token=link.data.path.split('#')[1];
 const payer=await api(`/api/pix/payments/${token}`,undefined,{auth:false});assert.equal(payer.status,200);assert.equal(payer.data.total,18000);assert.equal(payer.data.phone,undefined);assert.equal(payer.data.notes,undefined);assert.equal(payer.data.ocr_ready,true);
 assert.equal((await api(`/api/bookings/${id}/checkout`,{})).status,409);
 passed('private Pix link, payer privacy and payment-provider exclusivity');
 const proof=await api(`/api/pix/payments/${token}/receipt`,{filename:'pix-receipt.png',content_base64:fixture.toString('base64')},{auth:false});
 assert.equal(proof.status,201,JSON.stringify(proof.data)+'\n'+logs());assert.equal(proof.data.status,'pending');
 const analyzed=await readReceiptResult(token);
 assert.equal(analyzed.receipt.amount_cents,18000,JSON.stringify(analyzed.receipt)+'\n'+logs());
 assert.equal(analyzed.receipt.match_status,'exact');
 assert.equal(analyzed.paid,false);
 assert.equal((await api('/api/bookings')).data.find(b=>b.id===id).paid,0);
 const receiptId=proof.data.id;
 assert.equal((await api(`/api/receipts/${receiptId}/file`,undefined,{auth:false})).status,401);
 const original=await api(`/api/receipts/${receiptId}/file`);assert.equal(original.status,200);assert.deepEqual(original.data,fixture);
 assert.equal((await api(`/api/receipts/${receiptId}/review`,{decision:'approve',confirmed_amount_cents:18000})).status,400);
 assert.equal((await api(`/api/receipts/${receiptId}/review`,{decision:'approve',confirmed_received:true})).status,409);
 assert.equal((await api(`/api/receipts/${receiptId}/review`,{decision:'approve',confirmed_received:true,confirmed_amount_cents:1})).status,409);
 assert.equal((await api(`/api/receipts/${receiptId}/review`,{decision:'approve',confirmed_received:true,confirmed_amount_cents:18000})).status,200);
 assert.equal((await api(`/api/pix/payments/${token}`,undefined,{auth:false})).data.paid,true);
 passed('offline OCR recognizes a matching PNG amount and bank credit still requires approval');
 const tabRoute=`/api/pdv/tabs/${id}`;
 assert.equal((await api(tabRoute,undefined,{auth:false})).status,401);
 const initialTab=await api(tabRoute);
 assert.equal(initialTab.status,200,JSON.stringify(initialTab.data));
 assert.deepEqual([initialTab.data.status,initialTab.data.consumption_cents],['open',0]);
 const product=await api('/api/pdv/products',{name:'Água',price_cents:800,active:true});
 assert.equal(product.status,201,JSON.stringify(product.data));
 const item={product_id:product.data.id,quantity:2,request_key:randomBytes(16).toString('hex')};
 assert.equal((await api(tabRoute+'/items',item)).data.consumption_cents,1600);
 assert.equal((await api(tabRoute+'/items',item)).data.consumption_cents,1600);
 const tabClose=await api(tabRoute+'/close',{method:'Pix',expected_total_cents:1600});
 assert.equal(tabClose.status,200,JSON.stringify(tabClose.data));
 assert.equal(tabClose.data.status,'closed');
 const pdvDashboard=await api('/api/pdv');
 assert.equal(pdvDashboard.status,200,JSON.stringify(pdvDashboard.data));
 assert.deepEqual([pdvDashboard.data.revenue.courts_cents,pdvDashboard.data.revenue.consumption_cents,pdvDashboard.data.revenue.total_cents],[18000,1600,19600]);
 passed('automatic PDV tab, replay-safe item entry and separate court and consumption revenue');
 const scannedReservation=await api('/api/bookings',{...reservation,date:'2026-12-03',end:'19:00'});assert.equal(scannedReservation.status,201);
 const scannedLink=await api(`/api/bookings/${scannedReservation.data.id}/pix-link`,{});assert.equal(scannedLink.status,200);
 const scannedToken=scannedLink.data.path.split('#')[1];
 const scannedFixture=await readFile(path.join(root,'test/fixtures/pix-scanned.pdf'));
 const scan=await api(`/api/pix/payments/${scannedToken}/receipt`,{filename:'pix-scanned.pdf',content_base64:scannedFixture.toString('base64')},{auth:false});
 assert.equal(scan.status,201,JSON.stringify(scan.data)+'\n'+logs());
 const analyzedScan=await readReceiptResult(scannedToken);
 assert.equal(analyzedScan.receipt.amount_cents,18000,JSON.stringify(analyzedScan.receipt)+'\n'+logs());
 assert.equal(analyzedScan.receipt.match_status,'different');
 assert.equal(analyzedScan.paid,false);
 passed('offline PDF rasterization and OCR detect the exact difference without changing payment state');
 const largeReservation=await api('/api/bookings',{...reservation,date:'2026-12-02'});assert.equal(largeReservation.status,201);
 const largeLink=await api(`/api/bookings/${largeReservation.data.id}/pix-link`,{});assert.equal(largeLink.status,200);
 const largeToken=largeLink.data.path.split('#')[1];
 const large=Buffer.alloc(5*1024*1024);fixture.copy(large);
 const largeProof=await api(`/api/pix/payments/${largeToken}/receipt`,{filename:'large-pix-receipt.png',content_base64:large.toString('base64')},{auth:false});
 assert.equal(largeProof.status,201,JSON.stringify(largeProof.data)+'\n'+logs());assert.equal(largeProof.data.amount_cents,null);
 const largeOriginal=await api(`/api/receipts/${largeProof.data.id}/file`);assert.equal(largeOriginal.status,200);assert.deepEqual(largeOriginal.data,large);
 await readReceiptResult(largeToken);
 passed('advertised 5 MiB receipt limit supported by Durable SQLite BLOB storage');
 const publicDate=new Date(Date.now()+4*86400000).toISOString().slice(0,10);
 const onlineCatalog=await api(`/api/public/catalog?date=${publicDate}`,undefined,{auth:false});
 assert.equal(onlineCatalog.status,200);assert.equal(onlineCatalog.data.courts.length,1);
 const publicReservation=await api('/api/public/bookings',{court_id:court,date:publicDate,start:'10:00',end:'11:00',customer:'Cliente público',phone:'11999887766',request_key:randomBytes(32).toString('hex')},{auth:false});
 assert.equal(publicReservation.status,201,JSON.stringify(publicReservation.data));
 passed('public catalog and automatic booking run without administrator authentication');
 const splitRoute='/api/public/bookings/'+publicReservation.data.token+'/split';
 const split=await api(splitRoute,{count:21},{auth:false});
 assert.equal(split.status,200,JSON.stringify(split.data));
 assert.deepEqual([split.data.total,split.data.count,split.data.paid_count,split.data.shares.length],[12000,21,0,20]);
 const lastShare=(await api(splitRoute+'?page=2',undefined,{auth:false})).data.shares[0];
 const share=await api('/api/public/split/'+lastShare.path.split('#cota:')[1],undefined,{auth:false});
 assert.deepEqual([share.status,share.data.index,share.data.amount_cents,share.data.status],[200,21,571,'uncreated']);
 assert.equal((await api(splitRoute,undefined,{auth:false,method:'DELETE'})).status,200);
 passed('public split payment in Durable SQLite issues private links without charging');
 const deposit=await api(splitRoute,{mode:'deposit'},{auth:false});
 assert.equal(deposit.status,200,JSON.stringify(deposit.data));
 assert.deepEqual([deposit.data.mode,deposit.data.deposit_confirmed,deposit.data.deposit_cents,deposit.data.remaining_cents],['deposit',false,6000,12000]);
 const balanceRoute='/api/public/split/'+deposit.data.shares[1].path.split('#cota:')[1];
 const balance=await api(balanceRoute,undefined,{auth:false});
 assert.deepEqual([balance.status,balance.data.mode,balance.data.amount_cents,balance.data.locked],[200,'deposit',6000,true]);
 assert.equal((await api(splitRoute,undefined,{auth:false,method:'DELETE'})).status,200);
 passed('50 percent deposit plan keeps the balance locked until confirmed payment');
 assert.equal((await api('/api/notifications/config',undefined,{auth:false})).status,401);
 const notificationConfig={enabled:false,base_url:'https://evolution.example.com',api_key:'fake-smoke-instance-key',target:'arena',arena_number:'(21) 98888-7777',country_code:'55'};
 assert.equal((await api('/api/notifications/check',{})).status,409);
 const notificationSaved=await api('/api/notifications/config',notificationConfig,{method:'PUT'});
 assert.equal(notificationSaved.status,200);assert.equal(notificationSaved.data.token_configured,true);
 assert.equal(JSON.stringify(notificationSaved.data).includes('fake-smoke-instance-key'),false);
 assert.equal(notificationSaved.data.connection_ready,true);
 assert.equal((await api('/api/notifications/events')).data.length,0);
 passed('Evolution Go settings persist privately without sending messages while disabled');
 const motherCookie=cookie;
 const beforeCopy=(await api('/api/bookings')).data;
 const logo='data:image/png;base64,'+fixture.toString('base64');
 assert.equal((await api('/api/system/branding',{name:'Arena Mãe',logo}, {method:'PUT'})).status,200);
 assert.equal((await api('/api/systems',{slug:'centro',hostname:'centro.arena.example',name:'Arena Centro',password:'child-password-123'},{auth:false})).status,401);
 const child=await api('/api/systems',{slug:'centro',hostname:'centro.arena.example',name:'Arena Centro',password:'child-password-123'});
 assert.equal(child.status,201,JSON.stringify(child.data)+'\n'+logs());
 assert.equal((await api('/api/systems',{slug:'centro',hostname:'outra.arena.example',name:'Duplicado',password:'child-password-123'})).status,409);
 const childHeaders={Host:'centro.arena.example'};
 const childBrand=await api('/api/system/branding',undefined,{auth:false,headers:childHeaders});
 assert.equal(childBrand.data.name,'Arena Centro');
 assert.equal(childBrand.data.logo,logo);
 assert.equal((await api('/api/bookings',undefined,{headers:childHeaders})).status,401,'mother session must not authenticate in child');
 assert.equal((await api('/api/login',{username:'admin',password:'child-password-123'},{headers:childHeaders})).status,200);
 assert.deepEqual((await api('/api/bookings',undefined,{headers:childHeaders})).data,beforeCopy);
 assert.equal((await api('/api/public/bookings/'+publicReservation.data.token,undefined,{auth:false,headers:childHeaders})).status,404);
 const childPublicDate=new Date(Date.now()+5*86400000).toISOString().slice(0,10);
 assert.equal((await api('/api/public/bookings',{court_id:court,date:childPublicDate,start:'10:00',end:'11:00',customer:'Cliente só no filho',phone:'11999887766',request_key:randomBytes(32).toString('hex')},{auth:false,headers:childHeaders})).status,201);
 assert.equal((await api('/api/systems',undefined,{headers:childHeaders})).status,403);
 assert.equal((await api('/api/notifications/config',undefined,{headers:childHeaders})).data.token_configured,false);
 assert.equal((await api('/api/notifications/events',undefined,{headers:childHeaders})).data.length,0);
 assert.equal((await api('/api/payments/config',undefined,{headers:childHeaders})).data.ready,false);
 assert.equal((await api(misticpayConfigPath,undefined,{headers:childHeaders})).data.verification_state,'unconfigured');
 const childOriginal=await api(`/api/receipts/1/file`,undefined,{headers:childHeaders});
 assert.equal(childOriginal.status,200);assert.deepEqual(childOriginal.data,fixture);
 const childTab=await api(tabRoute,undefined,{headers:childHeaders});
 assert.equal(childTab.status,200,JSON.stringify(childTab.data));
 assert.deepEqual(childTab.data,tabClose.data);
 assert.equal((await api('/api/courts',{name:'Só no filho',type:'Vôlei',price:50},{headers:childHeaders})).status,201);
 assert.equal((await api('/api/system/branding',{name:'Logo do filho',logo:''},{headers:childHeaders,method:'PUT'})).status,200);
 assert.equal((await api('/api/system/domain',{hostname:'mae.example.com'},{auth:false,headers:childHeaders,method:'PUT'})).status,401);
 assert.equal((await api('/api/system/domain',{hostname:'https://invalid.example/path'},{headers:childHeaders,method:'PUT'})).status,400);
 assert.equal((await api('/api/system/domain',{hostname:'novo.arena.example'},{headers:childHeaders,method:'PUT'})).status,200);
 assert.equal((await api('/api/system/branding',undefined,{auth:false,headers:childHeaders})).status,404);
 childHeaders.Host='novo.arena.example';
 assert.equal((await api('/api/system/branding',undefined,{headers:childHeaders})).data.name,'Logo do filho');
 const childCookie=cookie;
 assert.equal((await api('/api/bookings')).status,401,'child session must not authenticate in mother');
 cookie=motherCookie;
 assert.equal((await api('/api/courts')).data.some(c=>c.name==='Só no filho'),false);
 assert.equal((await api('/api/system/branding')).data.name,'Arena Mãe');
 passed('full child clone, receipts, independent credentials, branding and database isolation');
 const scheduled=await fetch(base+'/__scheduled?cron='+encodeURIComponent('* * * * *'));
 const scheduledBody=await scheduled.text();
 assert.equal(scheduled.status,200,scheduledBody+'\n'+logs());
 assert.equal(scheduledBody,'Ran scheduled event');
 assert.deepEqual((await api('/api/notifications/events')).data,[]);
 assert.deepEqual((await api('/api/notifications/events',undefined,{headers:{...childHeaders,Cookie:childCookie}})).data,[]);
 passed('scheduled WhatsApp reminder handler runs with a ready child and respects disabled notifications');
 const session=cookie;
 await stop();
 // No bootstrap secret on restart: persisted admin and session must still work.
 await start({bootstrap:false});cookie=session;
 assert.equal((await api('/api/session')).data.authenticated,true);
 const persisted=await api('/api/bookings');assert.equal(persisted.status,200);assert.equal(persisted.data.find(b=>b.id===id).total,18000);
 assert.equal(persisted.data.find(b=>b.id===id).paid,1);
 const originals=await api(`/api/bookings/${id}/receipts`);assert.equal(originals.data.length,1);assert.equal(originals.data[0].status,'approved');
 assert.equal((await api('/api/bookings',undefined,{headers:{...childHeaders,Cookie:childCookie}})).data.length,beforeCopy.length+1);
 assert.equal((await api('/api/system/branding',undefined,{headers:childHeaders})).data.name,'Logo do filho');
 assert.equal((await api('/api/notifications/config')).data.token_configured,true);
 passed('administrator, session, bookings and receipts persist after runtime restart');

 console.log(`Cloudflare runtime smoke: ${checks} checks passed without Containers.`);
}catch(error){console.error(error);console.error(logs());process.exitCode=1;}
finally{await stop();await rm(directory,{recursive:true,force:true});}
