import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {createApplication} from '../server-core.js';

const today='2026-11-23';
const tomorrow='2026-11-24';
const productPath='/api/pdv/products';
const tabPath=id=>`/api/pdv/tabs/${id}`;
const dayPath=date=>`/api/pdv?date=${encodeURIComponent(date)}`;
const revenue=(courts=0,consumption=0,open=0)=>({
 courts_cents:courts,consumption_cents:consumption,total_cents:courts+consumption,open_consumption_cents:open
});
const status=(response,expected)=>assert.equal(response.status,expected,JSON.stringify(response.data));

async function fixture(t){
 // Nov 24 in UTC is still Nov 23 in São Paulo.
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-24T01:30:00Z')});
 const db=new DatabaseSync(':memory:');
 db.exec('PRAGMA foreign_keys=ON');
 const {server}=createApplication({db,paymentConfig:{ready:false,mode:'test'}});
 server.listen(0,'127.0.0.1');
 await once(server,'listening');
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
 const base=`http://127.0.0.1:${server.address().port}`;
 let cookie='';

 async function request(path,body,{method=body===undefined?'GET':'POST',auth=true}={}){
  const response=await fetch(base+path,{
   method,
   headers:{'Content-Type':'application/json',...(auth?{Cookie:cookie}:{})},
   body:body===undefined?undefined:JSON.stringify(body)
  });
  if(auth&&response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
  return {status:response.status,data:await response.json()};
 }

 status(await request('/api/setup',{password:'pdv-integration-password'}),200);
 const court=await request('/api/courts',{name:'Quadra PDV',type:'Areia',price:120});
 status(court,201);
 const reservation=overrides=>({
  court_id:court.data.id,customer:'Cliente da Arena',phone:'11999887766',
  date:tomorrow,start:'18:00',end:'19:00',...overrides
 });
 async function reserve(overrides){
  const result=await request('/api/bookings',reservation(overrides));
  status(result,201);
  return result.data.id;
 }
 async function product(overrides){
  const result=await request(productPath,{name:'Água',price_cents:500,active:true,...overrides});
  status(result,201);
  return result.data;
 }
 function add(id,productId,quantity=1,requestKey=randomUUID()){
  return request(tabPath(id)+'/items',{product_id:productId,quantity,request_key:requestKey});
 }
 return {db,request,reservation,reserve,product,add};
}

test('PDV: abre uma comanda por reserva e restringe o acesso ao administrador',async t=>{
 const {db,request,reservation,reserve}=await fixture(t);
 const first=await reserve({customer:'Admin da arena'});
 const publicBody=reservation({customer:'Cliente público',start:'19:00',end:'20:00',request_key:randomBytes(32).toString('hex')});
 const publicBooking=await request('/api/public/bookings',publicBody,{auth:false});
 status(publicBooking,201);
 const second=publicBooking.data.reservation.id;
 const replay=await request('/api/public/bookings',publicBody,{auth:false});
 status(replay,201);
 assert.equal(replay.data.reservation.id,second);
 assert.equal(db.prepare('SELECT COUNT(*) count FROM pdv_tabs').get().count,2);
 assert.equal(publicBooking.data.reservation.items,undefined);

 for(const [path,method,body] of [
  [dayPath(tomorrow),'GET',undefined],
  [tabPath(first),'GET',undefined],
  [productPath,'POST',{name:'Produto',price_cents:500}],
  [tabPath(first)+'/items','POST',{product_id:1,quantity:1,request_key:randomUUID()}],
  [tabPath(first)+'/close','POST',{expected_total_cents:0,method:null}]
 ])status(await request(path,body,{auth:false,method}),401);

 const daily=await request(dayPath(tomorrow));
 status(daily,200);
 assert.equal(daily.data.date,tomorrow);
 assert.deepEqual(daily.data.revenue,revenue());
 assert.deepEqual(daily.data.tabs.map(row=>[row.booking_id,row.status,row.booking_total_cents,row.booking_paid,row.consumption_cents]),[
  [first,'open',12000,false,0],[second,'open',12000,false,0]
 ]);
 for(const id of [first,second]){
  const detail=await request(tabPath(id));
  status(detail,200);
  assert.deepEqual(detail.data.items,[]);
 }
});

test('PDV: preserva o preço cadastrado no lançamento e recupera repetições sem duplicar itens',async t=>{
 const {request,reserve,product,add}=await fixture(t);
 const booking=await reserve();
 status(await request(productPath,{name:'Produto inválido',price_cents:10.5}),400);
 const water=await product();
 const key=randomUUID();
 const results=await Promise.all([add(booking,water.id,2,key),add(booking,water.id,2,key)]);
 for(const result of results){
  assert.ok([200,201].includes(result.status),JSON.stringify(result.data));
  assert.equal(result.data.quantity,2);
  assert.equal(result.data.consumption_cents,1000);
  assert.equal(result.data.items.length,1);
 }
 const firstItem=results[0].data.items[0];
 assert.equal(results[1].data.items[0].id,firstItem.id);
 status(await add(booking,water.id,3,key),409);
 status(await request(productPath+'/'+water.id,{name:'Água mineral',price_cents:575},{method:'PATCH'}),200);
 status(await add(booking,water.id,0),400);
 assert.ok([200,201].includes((await add(booking,water.id)).status));

 const lines=(await request(tabPath(booking))).data.items;
 assert.deepEqual(lines.map(line=>[line.name,line.price_cents,line.quantity,line.total_cents]),[
  ['Água',500,2,1000],['Água mineral',575,1,575]
 ]);
 status(await request(productPath+'/'+water.id,{active:false},{method:'PATCH'}),200);
 const inactive=await add(booking,water.id);
 assert.ok([400,409].includes(inactive.status),JSON.stringify(inactive.data));
 const linePath=tabPath(booking)+'/items/'+firstItem.id;
 let result=await request(linePath,{quantity:3},{method:'PATCH'});
 status(result,200);
 assert.equal(result.data.consumption_cents,2075);
 result=await request(linePath,undefined,{method:'DELETE'});
 status(result,200);
 assert.equal(result.data.consumption_cents,575);
 assert.deepEqual(result.data.items.map(line=>line.id),[lines[1].id]);
 const replay=await add(booking,water.id,2,key);
 assert.ok([200,201].includes(replay.status),JSON.stringify(replay.data));
 assert.deepEqual(replay.data.items.map(line=>line.id),[lines[1].id]);
 assert.deepEqual((await request(dayPath(tomorrow))).data.revenue,revenue(0,0,575));
});

test('PDV: fecha consumo uma vez e separa recebimento da quadra no dia de São Paulo',async t=>{
 const {db,request,reserve,product,add}=await fixture(t);
 const booking=await reserve();
 const item=await product();
 const added=await add(booking,item.id,2);
 assert.ok([200,201].includes(added.status),JSON.stringify(added.data));
 assert.deepEqual((await request(dayPath(tomorrow))).data.revenue,revenue(0,0,1000));
 const closePath=tabPath(booking)+'/close';
 status(await request(closePath,{method:'Pix',expected_total_cents:500}),409);
 assert.deepEqual((await request('/api/pdv')).data.revenue,revenue());
 assert.equal((await request('/api/pdv')).data.date,today);

 const settlement={method:'Cartão de débito',expected_total_cents:1000};
 const closed=await Promise.all([request(closePath,settlement),request(closePath,settlement)]);
 for(const response of closed){
  status(response,200);
  assert.equal(response.data.status,'closed');
  assert.equal(response.data.method,settlement.method);
  assert.ok(response.data.paid_at);
  assert.equal(response.data.booking_paid,false);
 }
 assert.equal(closed[0].data.paid_at,closed[1].data.paid_at);
 assert.equal(db.prepare('SELECT paid FROM bookings WHERE id=?').get(booking).paid,0);
 assert.deepEqual((await request(dayPath(today))).data.revenue,revenue(0,1000));
 assert.deepEqual((await request(dayPath(tomorrow))).data.revenue,revenue());
 status(await add(booking,item.id),409);
 status(await request(tabPath(booking)+'/items/'+added.data.items[0].id,{quantity:4},{method:'PATCH'}),409);
 status(await request(closePath,{...settlement,method:'Dinheiro'}),409);

 status(await request(`/api/bookings/${booking}/payment`,{method:'Pix'}),200);
 assert.deepEqual((await request(dayPath(today))).data.revenue,revenue(12000,1000));
 assert.equal((await request(tabPath(booking))).data.booking_paid,true);
 for(const date of ['2026-02-29','2026-11-31','2026/11/23','2026-13-01'])status(await request(dayPath(date)),400);
});

test('PDV: preserva o consumo ao cancelar e permite fechar uma reserva anterior ao recurso',async t=>{
 const {db,request,reserve,reservation,product,add}=await fixture(t);
 const empty=await reserve();
 const spent=await reserve({start:'19:00',end:'20:00'});
 const item=await product();
 assert.ok([200,201].includes((await add(spent,item.id)).status));
 status(await request(`/api/bookings/${empty}/cancel`,{}),200);
 status(await request(`/api/bookings/${spent}/cancel`,{}),200);
 assert.equal((await request(tabPath(empty))).data.status,'cancelled');
 status(await add(empty,item.id),409);
 const pending=(await request(tabPath(spent))).data;
 assert.equal(pending.booking_status,'cancelled');
 assert.equal(pending.status,'open');
 status(await add(spent,item.id),409);
 status(await request(tabPath(spent)+'/close',{method:'Dinheiro',expected_total_cents:500}),200);
 assert.deepEqual((await request(dayPath(today))).data.revenue,revenue(0,500));

 const old=reservation({date:'2026-11-22'});
 const inserted=db.prepare('INSERT INTO bookings(court_id,customer,phone,date,start,end,total) VALUES(?,?,?,?,?,?,?)')
  .run(old.court_id,old.customer,old.phone,old.date,old.start,old.end,12000);
 const legacy=Number(inserted.lastInsertRowid);
 assert.equal((await request(tabPath(legacy))).data.status,'open');
 const zero=await request(tabPath(legacy)+'/close',{method:null,expected_total_cents:0});
 status(zero,200);
 assert.equal(zero.data.status,'closed');
 assert.deepEqual((await request(dayPath(today))).data.revenue,revenue(0,500));
});
