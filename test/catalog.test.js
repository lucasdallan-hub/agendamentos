import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {createApplication} from '../server-core.js';
const key=()=>randomBytes(32).toString('hex');
const future=(days=2)=>{const d=new Date();d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);};
async function fixture(t){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
 const {server}=createApplication({db,paymentConfig:{ready:false,mode:'test'},receiptReader:async()=>({amount_cents:null})});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});let cookie='';
 async function api(route,body,{auth=true,method='POST',headers={}}={}){const r=await fetch(`http://127.0.0.1:${server.address().port}/api/`+route,{method:body===undefined?'GET':method,headers:{'Content-Type':'application/json',...(auth?{Cookie:cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});if(auth&&r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:await r.json()};}
 await api('setup',{password:'catalog-admin-password'});
 const court=(await api('courts',{name:'Quadra pública',type:'Areia',price:120})).data.id;
 return {api,db,court,body:(overrides={})=>({court_id:court,date:future(),start:'18:00',end:'19:00',customer:'Cliente catálogo',phone:'11999887766',request_key:key(),...overrides})};
}
test('catálogo: horários públicos sem dados pessoais, reserva automática, preço do servidor e repetição segura',async t=>{
 const f=await fixture(t),date=future();
 const inactive=(await f.api('courts',{name:'Inativa',type:'Areia',price:90})).data.id;
 await f.api(`courts/${inactive}`,{active:false},{method:'PATCH'});
 await f.api('bookings',f.body({date,start:'17:00',end:'18:00',customer:'CLIENTE PRIVADO',phone:'11900000000',notes:'NOTA PRIVADA'}));
 const catalog=await f.api(`public/catalog?date=${date}&duration=60`,undefined,{auth:false});
 assert.equal(catalog.status,200);assert.equal(catalog.data.courts.length,1);
 assert.equal(JSON.stringify(catalog).includes('CLIENTE PRIVADO'),false);assert.equal(JSON.stringify(catalog).includes('11900000000'),false);assert.equal(JSON.stringify(catalog).includes('NOTA PRIVADA'),false);
 assert.equal(catalog.data.courts[0].slots.some(s=>s.start==='17:00'),false);
 const body=f.body({total:1,paid:1,status:'cancelled',notes:'inject'});
 const created=await f.api('public/bookings',body,{auth:false});assert.equal(created.status,201);
 assert.equal(created.data.reservation.total,12000);assert.equal(created.data.reservation.paid,0);assert.equal(created.data.reservation.status,'confirmed');
 assert.equal((await f.api('public/bookings',body,{auth:false})).data.token,created.data.token);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM bookings').get().count,2);
 assert.equal(f.db.prepare('SELECT notes FROM bookings WHERE id=?').get(created.data.reservation.id).notes,'');
 const own=await f.api('public/bookings/'+created.data.token,undefined,{auth:false});assert.equal(own.status,200);assert.equal(own.data.phone,undefined);assert.equal(own.data.notes,undefined);
 assert.equal((await f.api('bookings',undefined,{auth:false})).status,401);
 await f.api('pix/settings',{key:'pix@example.com',receiver:'Arena'},{method:'PUT'});
 const pix=await f.api(`public/bookings/${created.data.token}/pix`,{},{auth:false});assert.equal(pix.status,200);assert.match(pix.data.path,/^\/pix#[a-f0-9]{64}$/);
 assert.equal((await f.api(`public/bookings/${created.data.token}/checkout`,{},{auth:false})).status,409);
});
test('catálogo: concorrência, horários inválidos, autenticação das configurações e pausa do agendamento',async t=>{
 const f=await fixture(t);
 const results=await Promise.all([f.api('public/bookings',f.body(),{auth:false}),f.api('public/bookings',f.body(),{auth:false})]);
 assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
 assert.equal((await f.api('public/bookings',f.body({date:'2020-01-01'}),{auth:false})).status,400);
 assert.equal((await f.api('public/bookings',f.body({start:'04:00',end:'05:00'}),{auth:false})).status,409);
 assert.equal((await f.api('public/bookings',f.body({start:'12:00',end:'12:15'}),{auth:false})).status,400);
 assert.equal((await f.api('public/bookings',f.body({phone:'1',start:'12:00',end:'13:00'}),{auth:false})).status,400);
 assert.equal((await f.api('public/bookings',f.body(),{auth:false,headers:{Origin:'https://evil.example'}})).status,403);
 assert.equal((await f.api('catalog/settings',{enabled:false,open:'06:00',close:'23:00'},{auth:false,method:'PUT'})).status,401);
 assert.equal((await f.api('catalog/settings',{enabled:true,open:'23:00',close:'06:00'},{method:'PUT'})).status,400);
 await f.api('catalog/settings',{enabled:false,open:'06:00',close:'23:00'},{method:'PUT'});
 assert.equal((await f.api(`public/catalog?date=${future()}`,undefined,{auth:false})).status,503);
 assert.equal((await f.api('public/bookings',f.body({date:future(3)}),{auth:false})).status,503);
 assert.equal((await f.api('public/bookings/'+results.find(r=>r.status===201).data.token,undefined,{auth:false})).status,200);
});
test('catálogo: limite de reservas públicas por origem preserva o painel administrativo',async t=>{
 const f=await fixture(t);
 for(let i=0;i<10;i++)assert.equal((await f.api('public/bookings',f.body({date:future(i+2)}),{auth:false})).status,201);
 assert.equal((await f.api('public/bookings',f.body({date:future(20)}),{auth:false})).status,429);
 assert.equal((await f.api('bookings',f.body({date:future(20)}))).status,201);
});
