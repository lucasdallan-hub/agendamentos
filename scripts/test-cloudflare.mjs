import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directory=await mkdtemp(path.join(os.tmpdir(),'arena-cloudflare-test-'));
const withReceipts=true;
console.log('Cloudflare smoke: production Worker, SQLite and manual receipt review');
const password=randomBytes(24).toString('hex');
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
async function makeConfig({bootstrap=false,containers=false,stub=false,local=false}={}){
 const config=JSON.parse(await readFile(path.join(root,'wrangler.jsonc'),'utf8'));
 delete config.$schema;
 config.name='arena-volei-local-smoke';
 config.main=path.join(root,'cloudflare/worker.js');
 config.assets.directory=path.join(root,'public');
 config.assets.html_handling='none';
 config.dev={...config.dev,enable_containers:containers};
 config.observability={enabled:false};
 if(config.containers)config.containers=config.containers.map(item=>({...item,image:path.join(root,'cloudflare/Dockerfile'),image_build_context:root}));
 config.vars={...config.vars,...(bootstrap?{ADMIN_INITIAL_PASSWORD:password}:{})};
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
 worker=spawn(process.execPath,[path.join(root,'node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config',configFile,'--ip','127.0.0.1','--port',String(port),'--inspector-port','0','--persist-to',persist,'--log-level','warn','--show-interactive-dev-session','false'],{cwd:root,detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,XDG_CONFIG_HOME:path.join(directory,'config'),WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:path.join(directory,'wrangler.log')}});
 for(const stream of [worker.stdout,worker.stderr])stream.on('data',chunk=>{output+=chunk.toString();if(output.length>100000)output=output.slice(-80000);});
 const deadline=Date.now()+(options.containers?240000:60000);
 while(Date.now()<deadline){
  if(worker.exitCode!==null)throw Error(`Wrangler exited before readiness (${worker.exitCode})\n${logs()}`);
  try{const response=await fetch(base+'/api/session',{signal:AbortSignal.timeout(1000)});if(response.headers.get('content-type')?.includes('application/json'))return;}catch{}
  await delay(200);
 }
 throw Error('Wrangler did not become ready\n'+logs());
}
async function api(route,body,{auth=true,headers={},method}={}){
 const response=await fetch(base+route,{method:method||(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json',...(auth&&cookie?{Cookie:cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
 const setCookie=response.headers.get('set-cookie');if(setCookie&&auth)cookie=setCookie.split(';')[0];
 const data=response.headers.get('content-type')?.includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer());
 return {status:response.status,headers:response.headers,data};
}

try{
 await start({bootstrap:false,containers:false});
 const unconfigured=await api('/api/session');assert.equal(unconfigured.status,503,JSON.stringify(unconfigured.data));
 passed('public deployment cannot claim an unconfigured administrator');
 await stop();
 await start({bootstrap:true,containers:false});
 for(const route of ['/','/pix','/pagamento','/app.js','/pix.js','/style.css']){
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
 const payer=await api(`/api/pix/payments/${token}`,undefined,{auth:false});assert.equal(payer.status,200);assert.equal(payer.data.total,18000);assert.equal(payer.data.phone,undefined);assert.equal(payer.data.notes,undefined);
 assert.equal((await api(`/api/bookings/${id}/checkout`,{})).status,409);
 passed('private Pix link, payer privacy and payment-provider exclusivity');
 if(withReceipts){
  const proof=await api(`/api/pix/payments/${token}/receipt`,{filename:'pix-receipt.png',content_base64:fixture.toString('base64')},{auth:false});assert.equal(proof.status,201,JSON.stringify(proof.data)+'\n'+logs());assert.equal(proof.data.amount_cents,null);assert.equal(proof.data.match_status,'manual');assert.equal(proof.data.status,'pending');
  assert.equal((await api('/api/bookings')).data.find(b=>b.id===id).paid,0);
  const receiptId=proof.data.id;
  assert.equal((await api(`/api/receipts/${receiptId}/file`,undefined,{auth:false})).status,401);
  const original=await api(`/api/receipts/${receiptId}/file`);assert.equal(original.status,200);assert.deepEqual(original.data,fixture);
  assert.equal((await api(`/api/receipts/${receiptId}/review`,{decision:'approve',confirmed_amount_cents:18000})).status,400);
  assert.equal((await api(`/api/receipts/${receiptId}/review`,{decision:'approve',confirmed_received:true})).status,409);
  assert.equal((await api(`/api/receipts/${receiptId}/review`,{decision:'approve',confirmed_received:true,confirmed_amount_cents:1})).status,409);
  assert.equal((await api(`/api/receipts/${receiptId}/review`,{decision:'approve',confirmed_received:true,confirmed_amount_cents:18000})).status,200);
  assert.equal((await api(`/api/pix/payments/${token}`,undefined,{auth:false})).data.paid,true);
  passed('manual review, durable receipt BLOB, protected original and explicit approval');
  const largeReservation=await api('/api/bookings',{...reservation,date:'2026-12-02'});assert.equal(largeReservation.status,201);
  const largeLink=await api(`/api/bookings/${largeReservation.data.id}/pix-link`,{});assert.equal(largeLink.status,200);
  const largeToken=largeLink.data.path.split('#')[1];
  const large=Buffer.alloc(5*1024*1024);fixture.copy(large);
  const largeProof=await api(`/api/pix/payments/${largeToken}/receipt`,{filename:'large-pix-receipt.png',content_base64:large.toString('base64')},{auth:false});
  assert.equal(largeProof.status,201,JSON.stringify(largeProof.data)+'\n'+logs());assert.equal(largeProof.data.amount_cents,null);
  const largeOriginal=await api(`/api/receipts/${largeProof.data.id}/file`);assert.equal(largeOriginal.status,200);assert.deepEqual(largeOriginal.data,large);
  passed('advertised 5 MiB receipt limit supported by Durable SQLite BLOB storage');
 }else console.log('UNRUN: container OCR and receipt lifecycle (--without-ocr selected).');
 const session=cookie;
 await stop();
 // No bootstrap secret on restart: persisted admin and session must still work.
 await start({bootstrap:false,containers:false});cookie=session;
 assert.equal((await api('/api/session')).data.authenticated,true);
 const persisted=await api('/api/bookings');assert.equal(persisted.status,200);assert.equal(persisted.data.find(b=>b.id===id).total,18000);
 if(withReceipts){assert.equal(persisted.data.find(b=>b.id===id).paid,1);const originals=await api(`/api/bookings/${id}/receipts`);assert.equal(originals.data.length,1);assert.equal(originals.data[0].status,'approved');}
 passed('administrator, session, bookings and receipts persist after runtime restart');
 console.log(`Cloudflare runtime smoke: ${checks} checks passed without Containers.`);
}catch(error){console.error(error);console.error(logs());process.exitCode=1;}
finally{await stop();await rm(directory,{recursive:true,force:true});}
