import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {once} from 'node:events';
import {createApp} from '../server.js';
import {createPix} from '../pix.js';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/F6cAAAAASUVORK5CYII=','base64');
const file=(suffix='')=>({filename:'comprovante.png',content_base64:Buffer.concat([PNG,Buffer.from(suffix)]).toString('base64')});
const rejected=r=>assert.ok(r.status>=400&&r.status<500,`Esperava rejeição 4xx, recebeu ${r.status}: ${JSON.stringify(r.data)}`);

async function fixture(t,{ready=false,preferenceError}={}){
 const dataDir=mkdtempSync('/tmp/arena-pix-test-');
 let preferences=0;
 const paymentClient={async createPreference(){preferences++;if(preferenceError)throw preferenceError;return{id:'test-preference',sandbox_init_point:'https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=test-preference'};}};
 const paymentConfig={ready,token:'test-token',webhookSecret:'test-secret',baseUrl:'https://arena.example',mode:'test'};
 const {server,db}=createApp({dataDir,paymentClient,paymentConfig});
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
 return{db,request,bookingId,reserve,settings,link,stats:()=>({preferences})};
}

test('Pix: configurações administrativas, link privado e dados públicos mínimos',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request('/api/pix/settings',undefined,{auth:false})).status,401);
 assert.equal((await f.request('/api/pix/settings')).data.ready,false);
 rejected(await f.request(`/api/bookings/${f.bookingId}/pix-link`,{}));
 rejected(await f.request('/api/pix/settings',{key:'',receiver:'Arena'},{method:'PUT'}));
 const settings=await f.settings();
 assert.equal(settings.data.manual_review,true);
 assert.equal(settings.data.ocr_ready,undefined);
 const l=await f.link(f.bookingId);
 assert.equal((await f.link(f.bookingId)).path,l.path,'Reutiliza o link da reserva');
 const publicData=await f.request(`/api/pix/payments/${l.token}`,undefined,{auth:false});
 assert.equal(publicData.status,200);assert.equal(publicData.data.total,18000);assert.equal(publicData.data.key,'pix@arena.example');assert.equal(publicData.data.receiver,'Arena Teste');assert.equal(publicData.data.paid,false);
 assert.equal(publicData.data.ocr_ready,undefined);
 assert.equal(publicData.data.phone,undefined);assert.equal(publicData.data.notes,undefined);
 assert.ok(!JSON.stringify(publicData.data).includes('11999887766'));
 assert.ok(!JSON.stringify(publicData.data).includes('NOTA PRIVADA'));
 assert.equal((await f.request('/api/pix/payments/'+'0'.repeat(64),undefined,{auth:false})).status,404);
 assert.equal((await f.request(`/api/bookings/${f.bookingId}/pix-link`,{},{auth:false})).status,401);
});

test('Pix: avisa somente depois de confirmar o recebimento e persistir a aprovação',async t=>{
 const f=await fixture(t);
 await f.settings();
 const {token}=await f.link(f.bookingId);
 const notifications=[];
 const booking=f.db.prepare('SELECT paid FROM bookings WHERE id=?');
 const pix=createPix(f.db,{
  enqueuePaidClient(id){
   assert.equal(f.db.isTransaction,true);
   assert.equal(booking.get(id).paid,1);
   notifications.push(['enqueue',id]);
  },
  async dispatchPaidClient(id){
   assert.equal(f.db.isTransaction,false);
   assert.equal(pix.list(id)[0].status,'approved');
   await new Promise(resolve=>setImmediate(resolve));
   notifications.push(['dispatch',id]);
  }
 });
 const first=pix.upload(token,file('recusado'));
 await assert.rejects(pix.review(first.id,{decision:'approve',confirmed_received:false,confirmed_amount_cents:18000}),{status:400});
 assert.equal((await pix.review(first.id,{decision:'reject'})).status,'rejected');
 assert.equal(booking.get(f.bookingId).paid,0);
 assert.deepEqual(notifications,[]);

 const second=pix.upload(token,file('aprovado'));
 const reviewed=await pix.review(second.id,{decision:'approve',confirmed_received:true,confirmed_amount_cents:18000,note:'Crédito conferido'});
 assert.deepEqual({...reviewed},{...second,status:'approved',review_note:'Crédito conferido'});
 assert.deepEqual(notifications,[['enqueue',f.bookingId],['dispatch',f.bookingId]]);
});

test('Pix: guarda comprovante pendente e só aprova após conferência bancária pelo admin',async t=>{
 const f=await fixture(t);await f.settings();const l=await f.link(f.bookingId);
 const uploaded=await f.request(`/api/pix/payments/${l.token}/receipt`,{...file(),amount_cents:18000,match_status:'matched',status:'approved'},{auth:false});
 assert.equal(uploaded.status,201);assert.equal(uploaded.data.amount_cents,null);assert.equal(uploaded.data.match_status,'manual');assert.equal(uploaded.data.status,'pending');
 const id=uploaded.data.id;
 let b=f.db.prepare('SELECT paid FROM bookings WHERE id=?').get(f.bookingId);assert.equal(b.paid,0);
 const listed=await f.request('/api/bookings');const row=listed.data.find(b=>b.id===f.bookingId);assert.equal(Boolean(row.pix_link),true);assert.equal(row.receipt_status,'pending');assert.equal(row.receipt_match,'manual');assert.equal(row.receipt_amount,null);
 assert.equal((await f.request(`/api/bookings/${f.bookingId}/receipts`,undefined,{auth:false})).status,401);
 assert.equal((await f.request(`/api/receipts/${id}/file`,undefined,{auth:false})).status,401);
 const original=await f.request(`/api/receipts/${id}/file`);assert.equal(original.status,200);assert.equal(original.headers.get('content-type'),'image/png');assert.deepEqual(original.data,PNG);
 const review=`/api/receipts/${id}/review`,confirmed={decision:'approve',confirmed_received:true,confirmed_amount_cents:18000};
 assert.equal((await f.request(review,confirmed,{auth:false})).status,401);
 rejected(await f.request(review,{decision:'approve'}));
 assert.equal((await f.request(review,{...confirmed,confirmed_received:false})).status,400);
 assert.equal((await f.request(review,{decision:'approve',confirmed_received:true})).status,409);
 assert.equal((await f.request(review,{...confirmed,confirmed_amount_cents:1})).status,409);
 assert.equal(f.db.prepare('SELECT paid FROM bookings WHERE id=?').get(f.bookingId).paid,0);
 assert.equal((await f.request(review,confirmed)).status,200);
 b=f.db.prepare('SELECT paid,method,paid_at FROM bookings WHERE id=?').get(f.bookingId);assert.equal(b.paid,1);assert.match(b.method,/Pix/i);assert.ok(b.paid_at);
 rejected(await f.request(review,confirmed));
 rejected(await f.request(`/api/pix/payments/${l.token}/receipt`,file('second'),{auth:false}));
});

test('Pix: comprovantes antigos preservam a leitura original e exigem conferência bancária',async t=>{
 const f=await fixture(t);await f.settings();
 for(const [match,amount] of [['mismatch',9000],['unreadable',null],['unknown',null]]){
  const bookingId=await f.reserve();
  const {token}=await f.link(bookingId);
  const path=`/api/pix/payments/${token}`;
  const uploaded=await f.request(path+'/receipt',file(match),{auth:false});
  assert.equal(uploaded.status,201);
  const {id}=uploaded.data;
  f.db.prepare('UPDATE pix_receipts SET amount_cents=?,match_status=? WHERE id=?').run(amount,match,id);
  const historical=(await f.request(path,undefined,{auth:false})).data;
  assert.equal(historical.receipt.amount_cents,amount);
  assert.equal(historical.receipt.match_status,match);
  assert.equal(historical.paid,false);
  const review=`/api/receipts/${id}/review`;
  assert.equal((await f.request(review,{decision:'approve',confirmed_amount_cents:18000})).status,400);
  assert.equal((await f.request(review,{decision:'approve',confirmed_received:true,confirmed_amount_cents:9000})).status,409);
  assert.equal(f.db.prepare('SELECT paid FROM bookings WHERE id=?').get(bookingId).paid,0);
  const approved=await f.request(review,{decision:'approve',confirmed_received:true,confirmed_amount_cents:18000});
  assert.equal(approved.status,200);
  assert.equal(approved.data.status,'approved');
  assert.equal(approved.data.amount_cents,amount);
  assert.equal(approved.data.match_status,match);
  assert.equal(f.db.prepare('SELECT paid FROM bookings WHERE id=?').get(bookingId).paid,1);
 }
});

test('Pix: aceita originais PNG, JPEG e PDF para análise manual',async t=>{
 const f=await fixture(t);await f.settings();
 for(const [extension,mime] of [['png','image/png'],['jpg','image/jpeg'],['pdf','application/pdf']]){
  const bookingId=await f.reserve();
  const {token}=await f.link(bookingId);
  const filename=`pix-receipt.${extension}`;
  const bytes=await readFile(new URL(`./fixtures/${filename}`,import.meta.url));
  const uploaded=await f.request(`/api/pix/payments/${token}/receipt`,{filename,content_base64:bytes.toString('base64')},{auth:false});
  assert.equal(uploaded.status,201,extension);
  assert.equal(uploaded.data.match_status,'manual');
  assert.equal(uploaded.data.amount_cents,null);
  assert.equal(uploaded.data.status,'pending');
  const original=await f.request(`/api/receipts/${uploaded.data.id}/file`);
  assert.equal(original.status,200);
  assert.equal(original.headers.get('content-type'),mime);
  assert.deepEqual(original.data,bytes);
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

test('Pix: valida assinatura, base64, tamanho e dimensões antes de guardar comprovante',async t=>{
 const f=await fixture(t);await f.settings();const l=await f.link(f.bookingId);
 const submit=(filename,content_base64)=>f.request(`/api/pix/payments/${l.token}/receipt`,{filename,content_base64},{auth:false});
 assert.equal((await submit('comprovante.png',Buffer.from('<html>arquivo falso</html>').toString('base64'))).status,415);
 rejected(await submit('comprovante.png','%%%não-é-base64%%%'));
 const large=Buffer.alloc(5*1024*1024+1);PNG.copy(large);
 assert.equal((await submit('grande.png',large.toString('base64'))).status,413);
 const hugePng=Buffer.from(PNG);
 hugePng.writeUInt32BE(65535,16);hugePng.writeUInt32BE(65535,20);
 assert.equal((await submit('dimensoes.png',hugePng.toString('base64'))).status,422);
 const hugeJpeg=await readFile(new URL('./fixtures/pix-receipt.jpg',import.meta.url));
 const frame=hugeJpeg.indexOf(Buffer.from([0xff,0xc0]));
 assert.ok(frame>=0);
 hugeJpeg.writeUInt16BE(65535,frame+5);hugeJpeg.writeUInt16BE(65535,frame+7);
 assert.equal((await submit('dimensoes.jpg',hugeJpeg.toString('base64'))).status,422);
 assert.deepEqual((await f.request(`/api/bookings/${f.bookingId}/receipts`)).data,[]);
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

test('Pix: envios e aprovações simultâneos não duplicam o comprovante nem a baixa',async t=>{
 const f=await fixture(t);
 await f.settings();const l=await f.link(f.bookingId);
 const path=`/api/pix/payments/${l.token}/receipt`;
 const attempts=await Promise.all(['primeiro','segundo'].map(variant=>f.request(path,file(variant),{auth:false})));
 assert.deepEqual(attempts.map(({status})=>status).sort(),[201,409]);
 const {id}=attempts.find(({status})=>status===201).data;
 const confirmed={decision:'approve',confirmed_received:true,confirmed_amount_cents:18000};
 const reviews=await Promise.all([confirmed,confirmed].map(body=>f.request(`/api/receipts/${id}/review`,body)));
 assert.deepEqual(reviews.map(({status})=>status).sort(),[200,409]);
 const receipts=(await f.request(`/api/bookings/${f.bookingId}/receipts`)).data;
 assert.equal(receipts.length,1);assert.equal(receipts[0].status,'approved');
 assert.equal(f.db.prepare('SELECT paid FROM bookings WHERE id=?').get(f.bookingId).paid,1);
});
