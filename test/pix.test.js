import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {once} from 'node:events';
import {createApp} from '../server.js';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/F6cAAAAASUVORK5CYII=','base64');
const file=(suffix='')=>({filename:'comprovante.png',content_base64:Buffer.concat([PNG,Buffer.from(suffix)]).toString('base64')});
const rejected=r=>assert.ok(r.status>=400&&r.status<500,`Esperava rejeição 4xx, recebeu ${r.status}: ${JSON.stringify(r.data)}`);

async function fixture(t,{reader,ready=false,preferenceError}={}){
 const dataDir=mkdtempSync('/tmp/arena-pix-test-');
 let result={text:'Comprovante Pix\nValor pago R$ 180,00',amount_cents:18000,candidates:[18000]};
 const receiptReader=reader||(async()=>structuredClone(result));
 let preferences=0;
 const paymentClient={async createPreference(){preferences++;if(preferenceError)throw preferenceError;return{id:'test-preference',sandbox_init_point:'https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=test-preference'};}};
 const paymentConfig={ready,token:'test-token',webhookSecret:'test-secret',baseUrl:'https://arena.example',mode:'test'};
 const {server,db}=createApp({dataDir,receiptReader,paymentClient,paymentConfig});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();rmSync(dataDir,{recursive:true,force:true});});
 let cookie='';
 const origin=`http://127.0.0.1:${server.address().port}`;
 async function request(endpoint,body,{auth=true,method,headers={}}={}){
  const r=await fetch(origin+endpoint,{method:method||(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json',...(auth?{cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
  return{status:r.status,headers:r.headers,data:r.headers.get('content-type')?.includes('application/json')?await r.json():Buffer.from(await r.arrayBuffer())};
 }
 assert.equal((await request('/api/setup',{password:'pix-integration-test-password'})).status,200);
 const c=await request('/api/courts',{name:'Quadra teste',type:'Vôlei de areia',price:120});
 const courtId=c.data.id;
 let day=1;
 async function reserve(){
  const r=await request('/api/bookings',{court_id:courtId,customer:'Cliente Pix',phone:'11999887766',date:`2026-12-${String(day++).padStart(2,'0')}`,start:'18:00',end:'19:30',notes:'NOTA PRIVADA DO ADMIN'});
  assert.equal(r.status,201);return r.data.id;
 }
 async function settings(){const r=await request('/api/pix/settings',{key:'pix@arena.example',receiver:'Arena Teste'},{method:'PUT'});assert.equal(r.status,200);return r;}
 async function link(id){const r=await request(`/api/bookings/${id}/pix-link`,{});assert.equal(r.status,200);assert.match(r.data.path,/^\/pix#[a-f0-9]{64}$/);return{...r.data,token:r.data.path.split('#')[1]};}
 const bookingId=await reserve();
 return{db,request,bookingId,reserve,settings,link,setResult:value=>result=value,stats:()=>({preferences})};
}

test('Pix: configurações administrativas, link privado e dados públicos mínimos',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request('/api/pix/settings',undefined,{auth:false})).status,401);
 assert.equal((await f.request('/api/pix/settings')).data.ready,false);
 rejected(await f.request(`/api/bookings/${f.bookingId}/pix-link`,{}));
 rejected(await f.request('/api/pix/settings',{key:'',receiver:'Arena'},{method:'PUT'}));
 await f.settings();
 const l=await f.link(f.bookingId);
 assert.equal((await f.link(f.bookingId)).path,l.path,'Reutiliza o link da reserva');
 const publicData=await f.request(`/api/pix/payments/${l.token}`,undefined,{auth:false});
 assert.equal(publicData.status,200);assert.equal(publicData.data.total,18000);assert.equal(publicData.data.key,'pix@arena.example');assert.equal(publicData.data.receiver,'Arena Teste');assert.equal(publicData.data.paid,false);
 assert.equal(publicData.data.phone,undefined);assert.equal(publicData.data.notes,undefined);
 assert.ok(!JSON.stringify(publicData.data).includes('11999887766'));
 assert.ok(!JSON.stringify(publicData.data).includes('NOTA PRIVADA'));
 assert.equal((await f.request('/api/pix/payments/'+'0'.repeat(64),undefined,{auth:false})).status,404);
 assert.equal((await f.request(`/api/bookings/${f.bookingId}/pix-link`,{},{auth:false})).status,401);
});

test('Pix: reconhece valor sem dar baixa; apenas admin com conferência explícita aprova',async t=>{
 const f=await fixture(t);await f.settings();const l=await f.link(f.bookingId);
 const uploaded=await f.request(`/api/pix/payments/${l.token}/receipt`,file(),{auth:false});
 assert.equal(uploaded.status,201);assert.equal(uploaded.data.amount_cents,18000);assert.equal(uploaded.data.match_status,'matched');assert.equal(uploaded.data.status,'pending');
 const id=uploaded.data.id;
 let b=f.db.prepare('SELECT paid FROM bookings WHERE id=?').get(f.bookingId);assert.equal(b.paid,0);
 const listed=await f.request('/api/bookings');const row=listed.data.find(b=>b.id===f.bookingId);assert.equal(Boolean(row.pix_link),true);assert.equal(row.receipt_status,'pending');assert.equal(row.receipt_match,'matched');assert.equal(row.receipt_amount,18000);
 assert.equal((await f.request(`/api/bookings/${f.bookingId}/receipts`,undefined,{auth:false})).status,401);
 assert.equal((await f.request(`/api/receipts/${id}/file`,undefined,{auth:false})).status,401);
 const original=await f.request(`/api/receipts/${id}/file`);assert.equal(original.status,200);assert.equal(original.headers.get('content-type'),'image/png');assert.deepEqual(original.data,PNG);
 assert.equal((await f.request(`/api/receipts/${id}/review`,{decision:'approve',confirmed_received:true},{auth:false})).status,401);
 rejected(await f.request(`/api/receipts/${id}/review`,{decision:'approve'}));
 rejected(await f.request(`/api/receipts/${id}/review`,{decision:'approve',confirmed_received:false}));
 assert.equal(f.db.prepare('SELECT paid FROM bookings WHERE id=?').get(f.bookingId).paid,0);
 assert.equal((await f.request(`/api/receipts/${id}/review`,{decision:'approve',confirmed_received:true})).status,200);
 b=f.db.prepare('SELECT paid,method,paid_at FROM bookings WHERE id=?').get(f.bookingId);assert.equal(b.paid,1);assert.match(b.method,/Pix/i);assert.ok(b.paid_at);
 rejected(await f.request(`/api/receipts/${id}/review`,{decision:'approve',confirmed_received:true}));
 rejected(await f.request(`/api/pix/payments/${l.token}/receipt`,file('second'),{auth:false}));
});

test('Pix: valor divergente ou ilegível nunca pode aprovar automaticamente nem pelo review',async t=>{
 const f=await fixture(t);await f.settings();const l=await f.link(f.bookingId);
 for(const [i,value,expected]of [[1,9000,'mismatch'],[2,null,'unreadable']]){
  f.setResult({text:value?'Valor R$ 90,00':'Imagem sem valor legível',amount_cents:value,candidates:value?[value]:[]});
  const r=await f.request(`/api/pix/payments/${l.token}/receipt`,file('variant'+i),{auth:false});assert.equal(r.status,201);assert.equal(r.data.match_status,expected);
  rejected(await f.request(`/api/receipts/${r.data.id}/review`,{decision:'approve',confirmed_received:true}));
  assert.equal(f.db.prepare('SELECT paid FROM bookings WHERE id=?').get(f.bookingId).paid,0);
  assert.equal((await f.request(`/api/receipts/${r.data.id}/review`,{decision:'reject',note:'Envie comprovante com o valor correto.'})).status,200);
 }
});

test('Pix: impede reenvio pendente, mantém histórico após rejeição e detecta reuso entre reservas',async t=>{
 const f=await fixture(t);await f.settings();const l=await f.link(f.bookingId);
 const first=await f.request(`/api/pix/payments/${l.token}/receipt`,file(),{auth:false});assert.equal(first.status,201);
 assert.equal((await f.request(`/api/pix/payments/${l.token}/receipt`,file('pending'),{auth:false})).status,409);
 assert.equal((await f.request(`/api/receipts/${first.data.id}/review`,{decision:'reject',note:'Confirme o destinatário.'})).status,200);
 const second=await f.request(`/api/pix/payments/${l.token}/receipt`,file('replacement'),{auth:false});assert.equal(second.status,201);
 const history=await f.request(`/api/bookings/${f.bookingId}/receipts`);assert.equal(history.data.length,2);assert.ok(history.data.some(r=>r.status==='rejected'&&r.review_note==='Confirme o destinatário.'));
 const otherId=await f.reserve(),other=await f.link(otherId);
 assert.equal((await f.request(`/api/pix/payments/${other.token}/receipt`,file('replacement'),{auth:false})).status,409);
 assert.equal(f.db.prepare('SELECT paid FROM bookings WHERE id=?').get(otherId).paid,0);
});

test('Pix: valida assinatura do arquivo, base64 e limite de 5 MiB antes da leitura',async t=>{
 let reads=0;const f=await fixture(t,{reader:async()=>{reads++;return{text:'',amount_cents:18000,candidates:[18000]};}});await f.settings();const l=await f.link(f.bookingId);
 rejected(await f.request(`/api/pix/payments/${l.token}/receipt`,{filename:'comprovante.png',content_base64:Buffer.from('<html>arquivo falso</html>').toString('base64')},{auth:false}));
 rejected(await f.request(`/api/pix/payments/${l.token}/receipt`,{filename:'comprovante.png',content_base64:'%%%não-é-base64%%%'},{auth:false}));
 const large=Buffer.alloc(5*1024*1024+1);PNG.copy(large);
 assert.equal((await f.request(`/api/pix/payments/${l.token}/receipt`,{filename:'grande.png',content_base64:large.toString('base64')},{auth:false})).status,413);
 assert.equal(reads,0);
});

test('Pix e Mercado Pago não criam cobranças concorrentes para a mesma reserva',async t=>{
 const f=await fixture(t,{ready:true});await f.settings();await f.link(f.bookingId);
 assert.equal((await f.request(`/api/bookings/${f.bookingId}/checkout`,{})).status,409);assert.equal(f.stats().preferences,0);
 const otherId=await f.reserve();assert.equal((await f.request(`/api/bookings/${otherId}/checkout`,{})).status,200);
 assert.equal((await f.request(`/api/bookings/${otherId}/pix-link`,{})).status,409);
});

test('Pix: link expirado bloqueia leitura e upload; renovação invalida token antigo',async t=>{
 const f=await fixture(t);await f.settings();const l=await f.link(f.bookingId);
 assert.equal((await f.request('/api/pix/settings',{key:'nova@arena.example',receiver:'Nova conta da arena'},{method:'PUT'})).status,200);
 assert.equal((await f.request(`/api/pix/payments/${l.token}`,undefined,{auth:false})).data.key,'pix@arena.example','Link já compartilhado preserva o destino original');
 f.db.prepare('UPDATE pix_links SET expires_at=? WHERE booking_id=?').run('2000-01-01T00:00:00.000Z',f.bookingId);
 assert.equal((await f.request(`/api/pix/payments/${l.token}`,undefined,{auth:false})).status,410);
 assert.equal((await f.request(`/api/pix/payments/${l.token}/receipt`,file(),{auth:false})).status,410);
 const replacement=await f.link(f.bookingId);assert.notEqual(replacement.token,l.token);
 assert.equal((await f.request(`/api/pix/payments/${l.token}`,undefined,{auth:false})).status,404);
 const current=await f.request(`/api/pix/payments/${replacement.token}`,undefined,{auth:false});assert.equal(current.status,200);assert.equal(current.data.key,'nova@arena.example');
});

test('Pix: troca de provedor apenas após rejeição definitiva sem preferência externa',async t=>{
 const rejectedOrder=await fixture(t,{ready:true,preferenceError:Object.assign(new Error('Rejeição definitiva'),{status:502,definitive:true})});
 await rejectedOrder.settings();
 assert.equal((await rejectedOrder.request(`/api/bookings/${rejectedOrder.bookingId}/checkout`,{})).status,502);
 await rejectedOrder.link(rejectedOrder.bookingId);
 assert.equal(rejectedOrder.db.prepare('SELECT count(*) n FROM payment_orders').get().n,0);
 const uncertain=await fixture(t,{ready:true,preferenceError:Object.assign(new Error('Resposta incerta'),{status:502})});
 await uncertain.settings();
 assert.equal((await uncertain.request(`/api/bookings/${uncertain.bookingId}/checkout`,{})).status,502);
 assert.equal((await uncertain.request(`/api/bookings/${uncertain.bookingId}/pix-link`,{})).status,409);
});

test('Pix: reserva cancelada deixa de receber comprovantes',async t=>{
 const f=await fixture(t);await f.settings();const l=await f.link(f.bookingId);
 assert.equal((await f.request(`/api/bookings/${f.bookingId}/cancel`,{})).status,200);
 assert.equal((await f.request(`/api/pix/payments/${l.token}`,undefined,{auth:false})).status,410);
 assert.equal((await f.request(`/api/pix/payments/${l.token}/receipt`,file(),{auth:false})).status,409);
});

test('Pix: não salva comprovante se a reserva muda enquanto a leitura está em andamento',async t=>{
 let release,reading;
 const started=new Promise(r=>reading=r);
 const gate=new Promise(r=>release=r);
 const f=await fixture(t,{reader:async()=>{reading();await gate;return{text:'Valor R$ 180,00',amount_cents:18000,candidates:[18000]};}});
 await f.settings();const l=await f.link(f.bookingId);
 const upload=f.request(`/api/pix/payments/${l.token}/receipt`,file(),{auth:false});
 try{
  await Promise.race([started,upload.then(r=>{throw new Error(`Upload terminou antes de iniciar OCR: ${r.status}`);})]);
  // Simulate a concurrent settlement arriving independently during OCR.
  f.db.prepare("UPDATE bookings SET paid=1,method='Pix' WHERE id=?").run(f.bookingId);release();
  assert.equal((await upload).status,409);
  const receipts=await f.request(`/api/bookings/${f.bookingId}/receipts`);assert.equal(receipts.data.length,0);
 }finally{release();await upload.catch(()=>{});}
});
