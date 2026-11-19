import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {createApplication} from '../server-core.js';
const key=()=>randomBytes(32).toString('hex');
const future=(days=2)=>{const d=new Date();d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);};
async function fixture(t,{checkout=false}={}){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
 const preferences=[];
 const paymentClient={
  async getPaymentMethods(){
   return [
    {id:'visa',payment_type_id:'credit_card',status:'active'},
    {id:'debvisa',payment_type_id:'debit_card',status:'active'},
    {id:'pix',payment_type_id:'bank_transfer',status:'active'}
   ];
  },
  async createPreference(body){
   preferences.push(body);
   const id=String(preferences.length);
   return {id,sandbox_init_point:`https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=${id}`};
  }
 };
 const {server}=createApplication({db,paymentConfig:{ready:checkout,mode:'test',baseUrl:'https://arena.example'},paymentClient});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});let cookie='';
 async function api(route,body,{auth=true,method='POST',headers={}}={}){const r=await fetch(`http://127.0.0.1:${server.address().port}/api/`+route,{method:body===undefined?'GET':method,headers:{'Content-Type':'application/json',...(auth?{Cookie:cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});if(auth&&r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,headers:r.headers,data:r.headers.get('content-type')==='image/jpeg'?Buffer.from(await r.arrayBuffer()):await r.json()};}
 await api('setup',{password:'catalog-admin-password'});
 const court=(await api('courts',{name:'Quadra pública',type:'Areia',price:120})).data.id;
 return {api,db,court,preferences,body:(overrides={})=>({court_id:court,date:future(),start:'18:00',end:'19:00',customer:'Cliente catálogo',phone:'11999887766',request_key:key(),...overrides})};
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
 assert.equal((await f.api(`public/bookings/${created.data.token}/checkout`,{payment_method:'pix'},{auth:false})).status,409);
 assert.equal(f.preferences.length,0);
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

test('catálogo: escolhe forma de pagamento no checkout, preserva a escolha e reaproveita o link',async t=>{
 const f=await fixture(t,{checkout:true});
 await f.api('pix/settings',{key:'pix@example.com',receiver:'Arena'},{method:'PUT'});
 const created=await f.api('public/bookings',f.body(),{auth:false});
 assert.equal(created.status,201);
 const path='public/bookings/'+created.data.token;
 const publicRequest={auth:false};
 const initial=(await f.api(path,undefined,publicRequest)).data;
 assert.equal(initial.pix_ready,true);
 assert.equal(initial.checkout_ready,true);
 assert.equal(initial.checkout_method,null);
 assert.equal((await f.api(path+'/checkout',{payment_method:'boleto'},publicRequest)).status,400);
 assert.equal(f.preferences.length,0);

 const first=await f.api(path+'/checkout',{payment_method:'credit_card'},publicRequest);
 assert.equal(first.status,200);
 assert.equal(first.data.checkout_method,'credit_card');
 assert.match(first.data.checkout_url,/^https:\/\/sandbox\.mercadopago\.com\.br\//);
 const reservation=(await f.api(path,undefined,publicRequest)).data;
 assert.equal(reservation.checkout_ready,true);
 assert.equal(reservation.checkout_method,'credit_card');
 assert.equal(reservation.pix_ready,false);
 assert.equal(reservation.paid,0);
 assert.equal((await f.api(path+'/checkout',{payment_method:'credit_card'},publicRequest)).data.checkout_url,first.data.checkout_url);
 assert.equal((await f.api(path+'/checkout',{},publicRequest)).data.checkout_url,first.data.checkout_url);
 assert.equal((await f.api(path+'/checkout',{payment_method:'debit_card'},publicRequest)).status,409);
 assert.equal((await f.api(`bookings/${created.data.reservation.id}/checkout`,{payment_method:'pix'})).status,409);
 assert.equal((await f.api(path+'/pix',{},publicRequest)).status,409);
 assert.equal(f.preferences.length,1);
});

test('catálogo: checkout anterior sem uma forma selecionada continua disponível',async t=>{
 const f=await fixture(t,{checkout:true});
 const created=await f.api('public/bookings',f.body(),{auth:false});
 assert.equal(created.status,201);
 const path='public/bookings/'+created.data.token;
 const publicRequest={auth:false};
 const legacy=await f.api(path+'/checkout',{},publicRequest);
 assert.equal(legacy.status,200);
 assert.equal(legacy.data.checkout_method,null);
 const reservation=(await f.api(path,undefined,publicRequest)).data;
 assert.equal(reservation.checkout_ready,true);
 assert.equal(reservation.checkout_method,null);
 const reused=await f.api(path+'/checkout',{payment_method:'pix'},publicRequest);
 assert.equal(reused.status,200);
 assert.equal(reused.data.checkout_method,null);
 assert.equal(reused.data.checkout_url,legacy.data.checkout_url);
 assert.equal(f.preferences.length,1);
});

test('catálogo: galeria ordenada, atualização atômica e acesso público só para quadras ativas',async t=>{
 const f=await fixture(t);
 const route=`courts/${f.court}/photos`;
 const other=(await f.api('courts',{name:'Outra quadra',type:'Areia',price:100})).data.id;
 const bytes=await readFile(new URL('./fixtures/pix-receipt.jpg',import.meta.url));
 const photo={data_url:`data:image/jpeg;base64,${bytes.toString('base64')}`};
 const save=(photos,expected_ids,auth=true)=>f.api(route,{photos,expected_ids},{method:'PUT',auth});
 const catalog=async()=> (await f.api(`public/catalog?date=${future()}`,undefined,{auth:false})).data;
 assert.deepEqual((await catalog()).courts[0].photos,[]);
 assert.equal((await save([photo],[],false)).status,401);
 assert.equal((await save(Array(5).fill(photo),[])).status,400);
 assert.equal((await save([{data_url:'data:image/jpeg;base64,PHN2Zz4='}],[])).status,400);

 const inserted=await save([photo,photo],[]);
 assert.equal(inserted.status,200);
 const [first,second]=inserted.data.photos;
 assert.notEqual(first.id,second.id);
 assert.equal((await f.api(first.url.slice(5),undefined,{auth:false})).status,401);
 const initial=await catalog();
 assert.deepEqual(initial.courts[0].photos.map(({id})=>id),[first.id,second.id]);
 assert.equal(JSON.stringify(initial).includes(photo.data_url),false);
 const exposed=initial.courts[0].photos[0].url.slice(5);
 const image=await f.api(exposed,undefined,{auth:false});
 assert.equal(image.status,200);
 assert.equal(image.headers.get('content-type'),'image/jpeg');
 assert.deepEqual(image.data,bytes);
 assert.equal((await f.api(`public/courts/${other}/photos/${first.id}`,undefined,{auth:false})).status,404);
 assert.equal((await save([{id:first.id},{id:first.id}],[first.id,second.id])).status,400);
 assert.equal((await save([{id:second.id}],[])).status,409);
 assert.deepEqual((await f.api('courts')).data[0].photos.map(({id})=>id),[first.id,second.id]);

 const updated=await save([{id:second.id},{id:first.id}],[first.id,second.id]);
 assert.equal(updated.status,200);
 assert.deepEqual((await catalog()).courts[0].photos.map(({id})=>id),[second.id,first.id]);
 await f.api(`courts/${f.court}`,{active:false},{method:'PATCH'});
 assert.equal((await f.api(exposed,undefined,{auth:false})).status,404);
 assert.equal((await f.api(first.url.slice(5))).status,200);
 await f.api(`courts/${f.court}`,{active:true},{method:'PATCH'});
 await f.api('catalog/settings',{enabled:false,open:'06:00',close:'23:00'},{method:'PUT'});
 assert.equal((await f.api(exposed,undefined,{auth:false})).status,404);
 await f.api('catalog/settings',{enabled:true,open:'06:00',close:'23:00'},{method:'PUT'});
 assert.equal((await save([],[second.id,first.id])).status,200);
 assert.equal((await f.api(exposed,undefined,{auth:false})).status,404);
 assert.deepEqual((await catalog()).courts[0].photos,[]);
});
