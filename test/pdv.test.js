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
const participantsPath=id=>`${tabPath(id)}/participants`;
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

test('PDV: protege os participantes da comanda e divide os centavos igualmente',async t=>{
 const {request,reserve,product,add}=await fixture(t);
 const booking=await reserve();
 const path=participantsPath(booking);
 const drink=await product({price_cents:1000});
 status(await add(booking,drink.id),201);
 const initial=(await request(tabPath(booking))).data;
 assert.deepEqual(initial.participants,[]);
 assert.equal(initial.participant_count,0);
 assert.equal(initial.participant_paid_cents,0);
 assert.equal(initial.consumption_balance_cents,1000);
 assert.equal(initial.division_locked,false);

 const first={name:'  Ana  ',whatsapp:'(62) 99999-8765',request_key:randomUUID()};
 status(await request(path,first,{auth:false}),401);
 status(await request(path,{...first,whatsapp:'telefone inválido'}),400);
 status(await request(path,{...first,name:'   '}),400);
 const concurrent=await Promise.all([request(path,first),request(path,first)]);
 for(const result of concurrent)assert.ok([200,201].includes(result.status),JSON.stringify(result.data));
 let tab=(await request(tabPath(booking))).data;
 assert.equal(tab.participant_count,1);
 const [ana]=tab.participants;
 assert.equal(ana.name,'Ana');
 assert.equal(ana.whatsapp,'5562999998765');
 assert.equal(ana.amount_cents,1000);
 assert.equal(ana.paid_cents,0);
 assert.equal(ana.paid_at,null);
 status(await request(path,{...first,name:'Nome diferente'}),409);

 const second={name:'Bruno',whatsapp:'+55 (62) 99999-8765',request_key:randomUUID()};
 status(await request(path,second),201);
 const third={name:'Caio',whatsapp:'62988888765',request_key:randomUUID()};
 status(await request(path,third),201);
 tab=(await request(tabPath(booking))).data;
 assert.equal(tab.participant_count,3);
 assert.deepEqual(tab.participants.map(person=>person.amount_cents).sort((a,b)=>a-b),[333,333,334]);
 assert.deepEqual(tab.participants.filter(person=>person.whatsapp===ana.whatsapp).map(person=>person.name),['Ana','Bruno']);
 assert.equal(tab.participant_paid_cents,0);
 assert.equal(tab.consumption_balance_cents,1000);
 assert.equal(tab.division_locked,false);

 const [,,caio]=tab.participants;
 const person=path+'/'+caio.id;
 status(await request(person,{name:'Carlos'},{method:'PATCH',auth:false}),401);
 status(await request(person,undefined,{method:'DELETE',auth:false}),401);
 status(await request(person+'/payment',{method:'Pix',expected_cents:caio.amount_cents},{auth:false}),401);
 status(await request(person,{name:' Carlos ',whatsapp:'+55 62 98888-8765'},{method:'PATCH'}),200);
 const edited=(await request(tabPath(booking))).data.participants.find(row=>row.id===caio.id);
 assert.deepEqual([edited.name,edited.whatsapp],['Carlos','5562988888765']);
 status(await request(person,undefined,{method:'DELETE'}),200);
 const deletedReplay=await request(path,third);
 assert.ok([200,201].includes(deletedReplay.status),JSON.stringify(deletedReplay.data));
 tab=(await request(tabPath(booking))).data;
 assert.equal(tab.participant_count,2);
 assert.deepEqual(tab.participants.map(person=>person.amount_cents),[500,500]);
});

test('PDV: lança cada baixa no dia do recebimento e fecha a comanda apenas mediante confirmação geral',async t=>{
 const {db,request,reserve,product,add}=await fixture(t);
 const booking=await reserve(),path=tabPath(booking),participants=participantsPath(booking);
 const drink=await product({price_cents:1001});
 status(await add(booking,drink.id),201);
 const person=(name,whatsapp)=>({name,whatsapp,request_key:randomUUID()});
 status(await request(participants,person('Ana','62999998765')),201);
 status(await request(participants,person('Bruno','62988888765')),201);
 const divided=(await request(path)).data;
 const [first,last]=divided.participants;
 const firstPath=`${participants}/${first.id}/payment`;
 const closePath=path+'/close';
 assert.equal(divided.consumption_balance_cents,1001);
 assert.equal(divided.participant_paid_cents,0);
 assert.deepEqual((await request(dayPath(tomorrow))).data.revenue,revenue(0,0,1001));
 assert.deepEqual([first.amount_cents,last.amount_cents].sort((a,b)=>a-b),[500,501]);

 status(await request(firstPath,{method:'Pix',expected_cents:first.amount_cents-1}),409);
 assert.deepEqual((await request(dayPath(today))).data.revenue,revenue());
 const payment={method:'Pix',expected_cents:first.amount_cents};
 const repeated=await Promise.all([request(firstPath,payment),request(firstPath,payment)]);
 for(const result of repeated)status(result,200);
 const partial=(await request(path)).data;
 const firstPaid=partial.participants.find(person=>person.id===first.id);
 assert.equal(firstPaid.method,'Pix');
 assert.equal(firstPaid.paid_cents,first.amount_cents);
 assert.equal(firstPaid.paid_at,'2026-11-24T01:30:00.000Z');
 assert.equal(firstPaid.status,'closed');
 assert.equal(partial.participants.find(person=>person.id===last.id).status,'open');
 assert.equal(partial.status,'open');
 assert.equal(partial.participant_paid_cents,first.amount_cents);
 assert.equal(partial.consumption_balance_cents,last.amount_cents);
 assert.equal(partial.booking_paid,false);
 assert.deepEqual((await request(dayPath(today))).data.revenue,revenue(0,first.amount_cents));
 assert.deepEqual((await request(dayPath(tomorrow))).data.revenue,revenue(0,0,last.amount_cents));

 status(await request(firstPath,{...payment,method:'Dinheiro'}),409);
 status(await request(`${participants}/${first.id}`,{name:'Novo nome'},{method:'PATCH'}),409);
 const corrected=await request(`${participants}/${last.id}`,{name:'Bruno Silva'},{method:'PATCH'});
 status(corrected,200);
 const unpaid=corrected.data.participants.find(person=>person.id===last.id);
 assert.equal(unpaid.name,'Bruno Silva');
 assert.equal(unpaid.amount_cents,last.amount_cents);
 status(await request(closePath,{method:'Pix',expected_total_cents:1001,expected_balance_cents:last.amount_cents}),409);
 assert.equal(db.prepare('SELECT paid FROM bookings WHERE id=?').get(booking).paid,0);

 t.mock.timers.setTime(Date.parse('2026-11-24T03:05:00Z'));
 const lastPath=`${participants}/${last.id}/payment`;
 const finalPayment={method:'Cartão de débito',expected_cents:last.amount_cents};
 status(await request(lastPath,finalPayment),200);
 status(await request(lastPath,finalPayment),200);
 const settled=(await request(path)).data;
 assert.equal(settled.status,'open');
 assert.equal(settled.consumption_balance_cents,0);
 assert.deepEqual(settled.participants.map(({status})=>status),['closed','closed']);
 assert.deepEqual((await request(dayPath(tomorrow))).data.revenue,revenue(0,last.amount_cents));

 const closing={method:null,expected_total_cents:1001,expected_balance_cents:0};
 status(await request(closePath,{...closing,expected_balance_cents:1}),409);
 status(await request(closePath,closing),200);
 status(await request(closePath,closing),200);
 status(await request(firstPath,payment),200);
 const closed=(await request(path)).data;
 assert.equal(closed.status,'closed');
 assert.equal(closed.participant_paid_cents,1001);
 assert.equal(closed.consumption_balance_cents,0);
 assert.equal(closed.booking_paid,false);
 assert.equal(closed.method,null);
 assert.deepEqual(closed.participants.map(({paid_cents,method})=>[paid_cents,method]),[
  [first.amount_cents,'Pix'],[last.amount_cents,'Cartão de débito']
 ]);
 assert.deepEqual((await request(dayPath(today))).data.revenue,revenue(0,first.amount_cents));
 assert.deepEqual((await request(dayPath(tomorrow))).data.revenue,revenue(0,last.amount_cents));
 assert.equal(db.prepare('SELECT paid FROM bookings WHERE id=?').get(booking).paid,0);

 status(await request(`/api/bookings/${booking}/payment`,{method:'Pix'}),200);
 assert.deepEqual((await request(dayPath(tomorrow))).data.revenue,revenue(12000,last.amount_cents));
});

test('PDV: cota zerada não gera recebimento nem impede o fechamento geral',async t=>{
 const {request,reserve,product,add}=await fixture(t);
 const booking=await reserve(),path=participantsPath(booking);
 const item=await product({name:'Item de teste',price_cents:1});
 status(await add(booking,item.id),201);
 for(const name of ['Ana','Bruno','Caio']){
  status(await request(path,{name,whatsapp:'62999998765',request_key:randomUUID()}),201);
 }
 const open=(await request(tabPath(booking))).data;
 assert.deepEqual(open.participants.map(person=>person.amount_cents).sort((a,b)=>a-b),[0,0,1]);
 const zero=open.participants.find(person=>person.amount_cents===0);
 const invalid=await request(path+'/'+zero.id+'/payment',{method:'Pix',expected_cents:0});
 assert.ok([400,409].includes(invalid.status),JSON.stringify(invalid.data));
 const positive=open.participants.find(person=>person.amount_cents===1);
 const paid=await request(path+'/'+positive.id+'/payment',{method:'Pix',expected_cents:1});
 status(paid,200);
 assert.equal(paid.data.status,'open');
 assert.equal(paid.data.consumption_balance_cents,0);
 assert.equal(paid.data.participants.filter(person=>person.paid_at!==null).length,1);
 const closed=await request(tabPath(booking)+'/close',{method:null,expected_total_cents:1,expected_balance_cents:0});
 status(closed,200);
 assert.equal(closed.data.status,'closed');
 assert.deepEqual((await request(dayPath(today))).data.revenue,revenue(0,1));
});

test('PDV: cobra itens individuais e rateia apenas os itens compartilhados',async t=>{
 const {db,request,reserve,product,add}=await fixture(t);
 const booking=await reserve();
 const other=await reserve({start:'19:00',end:'20:00'});
 const path=tabPath(booking),participants=participantsPath(booking),items=path+'/items';
 for(const [tab,names] of [[booking,['Ana','Bruno','Caio']],[other,['Dora']]]){
  for(const name of names){
   status(await request(participantsPath(tab),{name,whatsapp:'62999998765',request_key:randomUUID()}),201);
  }
 }
 const [ana,bruno,caio]=(await request(path)).data.participants;
 const [dora]=(await request(tabPath(other))).data.participants;
 const shared=await product({name:'Porção',price_cents:502});
 const individual=await product({name:'Água',price_cents:275});
 const reassigned=await product({name:'Suco',price_cents:341});
 const unassigned=await product({name:'Refrigerante',price_cents:201});
 status(await add(booking,shared.id),201);

 const water={product_id:individual.id,quantity:2,request_key:randomUUID(),participant_id:ana.id};
 const added=await request(items,water);
 status(added,201);
 const waterLine=added.data.items.find(item=>item.product_id===individual.id);
 assert.deepEqual([waterLine.participant_id,waterLine.participant_name,waterLine.total_cents],[ana.id,'Ana',550]);
 status(await request(items,water),201);
 status(await request(items,{...water,participant_id:bruno.id}),409);
 const crossTab=await request(items,{...water,request_key:randomUUID(),participant_id:dora.id});
 assert.ok([400,404,409].includes(crossTab.status),JSON.stringify(crossTab.data));

 const juice=await request(items,{product_id:reassigned.id,quantity:1,request_key:randomUUID(),participant_id:bruno.id});
 status(juice,201);
 const juiceLine=juice.data.items.find(item=>item.product_id===reassigned.id);
 status(await request(items,{product_id:unassigned.id,quantity:1,request_key:randomUUID(),participant_id:caio.id}),201);
 const amounts=tab=>tab.participants.map(({name,individual_cents,shared_cents,amount_cents})=>[name,individual_cents,shared_cents,amount_cents]);
 const initial=(await request(path)).data;
 assert.deepEqual(amounts(initial),[['Ana',550,168,718],['Bruno',341,167,508],['Caio',201,167,368]]);
 assert.equal(initial.consumption_cents,1594);
 assert.equal(initial.items.filter(item=>item.product_id===individual.id).length,1);

 const unlinked=await request(`${items}/${juiceLine.id}`,{quantity:1,participant_id:null},{method:'PATCH'});
 status(unlinked,200);
 assert.equal(unlinked.data.items.find(item=>item.id===juiceLine.id).participant_id,null);
 assert.deepEqual(amounts(unlinked.data),[['Ana',550,281,831],['Bruno',0,281,281],['Caio',201,281,482]]);
 const moved=await request(`${items}/${juiceLine.id}`,{quantity:1,participant_id:ana.id},{method:'PATCH'});
 status(moved,200);
 assert.equal(moved.data.items.find(item=>item.id===juiceLine.id).participant_id,ana.id);
 assert.deepEqual(amounts(moved.data),[['Ana',891,168,1059],['Bruno',0,167,167],['Caio',201,167,368]]);
 const crossTabPatch=await request(`${items}/${juiceLine.id}`,{quantity:1,participant_id:dora.id},{method:'PATCH'});
 assert.ok([400,404,409].includes(crossTabPatch.status),JSON.stringify(crossTabPatch.data));

 const removed=await request(`${participants}/${caio.id}`,undefined,{method:'DELETE'});
 status(removed,200);
 const sharedLine=removed.data.items.find(item=>item.product_id===unassigned.id);
 assert.deepEqual([sharedLine.participant_id,sharedLine.participant_name],[null,null]);
 assert.deepEqual(amounts(removed.data),[['Ana',891,352,1243],['Bruno',0,351,351]]);
 assert.equal(removed.data.consumption_balance_cents,1594);
 assert.equal(removed.data.booking_paid,false);
 assert.deepEqual((await request(dayPath(today))).data.revenue,revenue());
 assert.deepEqual((await request(dayPath(tomorrow))).data.revenue,revenue(0,0,1594));

 const paid=await request(`${participants}/${ana.id}/payment`,{method:'Pix',expected_cents:1243});
 status(paid,200);
 assert.equal(paid.data.consumption_balance_cents,351);
 assert.equal(paid.data.participants.find(person=>person.id===ana.id).status,'closed');
 status(await request(`${items}/${juiceLine.id}`,{quantity:1,participant_id:null},{method:'PATCH'}),409);
 status(await request(`${items}/${juiceLine.id}`,undefined,{method:'DELETE'}),409);
 status(await request(`${participants}/${ana.id}`,undefined,{method:'DELETE'}),409);
 status(await request(items,{...water,request_key:randomUUID()}),409);
 // A retry of the original launch must not charge Ana again.
 const retry=await request(items,water);
 status(retry,201);
 assert.equal(retry.data.consumption_cents,1594);

 const brunoWater=await request(items,{...water,quantity:1,request_key:randomUUID(),participant_id:bruno.id});
 status(brunoWater,201);
 const brunoLine=brunoWater.data.items.find(item=>item.product_id===individual.id&&item.participant_id===bruno.id);
 assert.deepEqual(amounts(brunoWater.data),[['Ana',891,352,1243],['Bruno',275,351,626]]);
 const adjusted=await request(`${items}/${brunoLine.id}`,{quantity:2},{method:'PATCH'});
 status(adjusted,200);
 assert.deepEqual(amounts(adjusted.data),[['Ana',891,352,1243],['Bruno',550,351,901]]);
 status(await request(`${items}/${brunoLine.id}`,{quantity:2,participant_id:ana.id},{method:'PATCH'}),409);

 const joined=await request(participants,{name:'Elisa',whatsapp:'62991111111',request_key:randomUUID()});
 status(joined,201);
 assert.deepEqual(amounts(joined.data),[['Ana',891,352,1243],['Bruno',550,176,726],['Elisa',0,175,175]]);
 const originalShared=joined.data.items.find(item=>item.product_id===shared.id);
 // After Ana's receipt, at least her settled 352 cents must remain in the shared pool.
 status(await request(`${items}/${originalShared.id}`,undefined,{method:'DELETE'}),409);
 status(await request(`${items}/${originalShared.id}`,{quantity:1,participant_id:bruno.id},{method:'PATCH'}),409);
 assert.equal(db.prepare('SELECT paid FROM bookings WHERE id=?').get(booking).paid,0);
 assert.equal((await request(path)).data.consumption_cents,2144);
 assert.deepEqual((await request(dayPath(today))).data.revenue,revenue(0,1243));
 assert.deepEqual((await request(dayPath(tomorrow))).data.revenue,revenue(0,0,901));
});

test('PDV: fecha o saldo geral sem repetir os recebimentos individuais',async t=>{
 const {request,reserve,product,add}=await fixture(t);
 const booking=await reserve(),path=tabPath(booking),participants=participantsPath(booking);
 const item=await product({price_cents:900});
 status(await add(booking,item.id),201);
 const named=await request(participants,{name:'Ana',whatsapp:'62999998765',request_key:randomUUID()});
 status(named,201);
 const [ana]=named.data.participants;
 const payment={method:'Pix',expected_cents:900};
 status(await request(`${participants}/${ana.id}/payment`,payment),200);
 const extra=await product({name:'Gelo',price_cents:101});
 const pending=await add(booking,extra.id);
 status(pending,201);
 assert.equal(pending.data.status,'open');
 assert.equal(pending.data.consumption_cents,1001);
 assert.equal(pending.data.general_balance_cents,101);
 assert.equal(pending.data.consumption_balance_cents,101);
 assert.deepEqual(pending.data.participants.map(person=>[person.status,person.amount_cents,person.paid_cents]),[['closed',900,900]]);

 const closing={method:'Dinheiro',expected_total_cents:1001,expected_balance_cents:101};
 status(await request(path+'/close',{...closing,expected_balance_cents:0}),409);
 status(await request(path+'/close',{...closing,expected_total_cents:900}),409);
 const closed=await request(path+'/close',closing);
 status(closed,200);
 assert.equal(closed.data.status,'closed');
 assert.equal(closed.data.general_paid_cents,101);
 assert.equal(closed.data.participant_paid_cents,900);
 assert.equal(closed.data.consumption_balance_cents,0);
 status(await request(path+'/close',closing),200);
 status(await request(`${participants}/${ana.id}/payment`,payment),200);
 assert.deepEqual((await request(dayPath(today))).data.revenue,revenue(0,1001));
});

test('PDV: conserva cotas pagas e faturamento das comandas fechadas pelo fluxo anterior',async t=>{
 const {db,request,reserve,product,add}=await fixture(t);
 const booking=await reserve(),path=tabPath(booking),participants=participantsPath(booking);
 const item=await product({price_cents:1001});
 status(await add(booking,item.id),201);
 for(const name of ['Ana','Bruno']){
  status(await request(participants,{name,whatsapp:'62999998765',request_key:randomUUID()}),201);
 }
 const recordedAt='2026-11-24T01:15:00.000Z';
 const oldPayments=db.prepare('UPDATE pdv_participants SET paid_cents=?,paid_at=?,method=? WHERE id=?');
 const original=(await request(path)).data;
 for(const person of original.participants)oldPayments.run(person.amount_cents,recordedAt,'Pix',person.id);
 db.prepare('UPDATE pdv_tabs SET closed_at=? WHERE booking_id=?').run(recordedAt,booking);
 const legacy=(await request(path)).data;
 assert.equal(legacy.status,'closed');
 assert.equal(legacy.participant_paid_cents,1001);
 assert.deepEqual(legacy.participants.map(person=>[person.status,person.individual_cents,person.shared_cents,person.amount_cents,person.paid_cents]),[
  ['closed',0,501,501,501],['closed',0,500,500,500]
 ]);
 assert.equal(legacy.general_paid_cents,0);
 assert.deepEqual((await request(dayPath(today))).data.revenue,revenue(0,1001));
});
