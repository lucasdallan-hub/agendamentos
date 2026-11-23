import {transaction} from './storage.js';
import {normalizeNumber} from './notifications.js';

const paymentMethods=new Set(['Pix','Dinheiro','Cartão de crédito','Cartão de débito','Transferência']);
const dateFormatter=new Intl.DateTimeFormat('en-CA',{
 timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'
});
const requestKeyPattern=/^(?:[a-f0-9]{32,64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
const dayMilliseconds=86_400_000;
const activePix="(state IN ('creating','pending','unknown','review') OR (state='ready' AND expires_at>?))";
const pixMethod='MisticPay';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
function selectedDay(value){
 const date=value??dateFormatter.format(new Date());
 const time=typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)?Date.parse(`${date}T00:00:00.000Z`):NaN;
 if(!Number.isFinite(time)||new Date(time).toISOString().slice(0,10)!==date)fail('Informe uma data válida para o PDV.');
 return {date,time};
}
function productName(value){
 const name=typeof value==='string'?value.trim():'';
 if(!name||name.length>100||/[\u0000-\u001f\u007f]/.test(name))fail('Informe um nome de produto de até 100 caracteres.');
 return name;
}
function participantName(value){
 const name=typeof value==='string'?value.trim():'';
 if(!name||name.length>120||/[\u0000-\u001f\u007f]/.test(name))fail('Informe um nome de até 120 caracteres.');
 return name;
}
function participantWhatsApp(value){
 try{return normalizeNumber(value);}
 catch{fail('Informe um número de WhatsApp válido com DDD.');}
}
function positiveInteger(value,message){
 if(!Number.isSafeInteger(value)||value<1)fail(message);
 return value;
}
const itemQuantity=value=>positiveInteger(value,'Informe uma quantidade inteira maior que zero.');
const productPrice=value=>positiveInteger(value,'Informe um preço maior que zero em centavos.');
function safeAmount(value,message='O total da comanda excede o limite suportado.'){
 if(!Number.isSafeInteger(value))fail(message,409);
 return value;
}

const selectTabs=`SELECT b.id booking_id,b.customer,c.name court_name,b.date,b.start,b.end,
 b.status booking_status,b.total booking_total_cents,b.paid booking_paid,t.closed_at,t.paid_at,t.method,
 COALESCE(t.paid_cents,0) general_paid_cents,
 p.booking_id IS NOT NULL booking_uses_deposit,
 CASE WHEN p.archived=1 THEN p.archived_paid_cents
  WHEN p.booking_id IS NOT NULL THEN (
   SELECT COALESCE(SUM(s.amount_cents),0) FROM misticpay_split_shares s
   WHERE s.booking_id=p.booking_id AND s.state='approved'
  )
  WHEN b.paid=1 THEN b.total ELSE 0 END booking_received_cents,
 COALESCE(SUM(i.price_cents*i.quantity),0) consumption_cents,COALESCE(SUM(i.quantity),0) quantity,
 (SELECT COUNT(*) FROM pdv_participants r WHERE r.booking_id=b.id AND r.removed=0) participant_count,
 (SELECT COALESCE(SUM(r.paid_cents),0) FROM pdv_participants r WHERE r.booking_id=b.id AND r.removed=0) participant_paid_cents
 FROM bookings b JOIN courts c ON c.id=b.court_id
 LEFT JOIN misticpay_split_plans p ON p.booking_id=b.id AND p.mode='deposit'
 LEFT JOIN pdv_tabs t ON t.booking_id=b.id
 LEFT JOIN pdv_items i ON i.booking_id=b.id AND i.removed=0`;

function tabSummary({closed_at,...row}){
 const status=closed_at?'closed':row.booking_status==='cancelled'&&!row.quantity?'cancelled':'open';
 return {...row,booking_paid:!!row.booking_paid,booking_uses_deposit:!!row.booking_uses_deposit,status,
  consumption_balance_cents:closed_at?0:row.consumption_cents-row.participant_paid_cents,
  division_locked:row.participant_paid_cents>0};
}
const productSummary=row=>({...row,active:!!row.active});

export function createPdv(db){
 db.exec(`CREATE TABLE IF NOT EXISTS pdv_products(
  id INTEGER PRIMARY KEY,name TEXT NOT NULL,price_cents INTEGER NOT NULL CHECK(price_cents>0),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
 );
 CREATE TABLE IF NOT EXISTS pdv_tabs(
  booking_id INTEGER PRIMARY KEY REFERENCES bookings(id),opened_at TEXT NOT NULL,
  closed_at TEXT,paid_at TEXT,method TEXT,paid_cents INTEGER NOT NULL DEFAULT 0 CHECK(paid_cents>=0)
 );
 CREATE TABLE IF NOT EXISTS pdv_participants(
  id INTEGER PRIMARY KEY,booking_id INTEGER NOT NULL REFERENCES pdv_tabs(booking_id),
  name TEXT NOT NULL,whatsapp TEXT NOT NULL,
  requested_name TEXT NOT NULL,requested_whatsapp TEXT NOT NULL,request_key TEXT NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0 CHECK(removed IN (0,1)),
  paid_cents INTEGER NOT NULL DEFAULT 0 CHECK(paid_cents>=0),paid_at TEXT,method TEXT,
  UNIQUE(booking_id,request_key)
 );
 CREATE TABLE IF NOT EXISTS pdv_items(
  id INTEGER PRIMARY KEY,booking_id INTEGER NOT NULL REFERENCES pdv_tabs(booking_id),
  product_id INTEGER NOT NULL REFERENCES pdv_products(id),name TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK(price_cents>0),quantity INTEGER NOT NULL CHECK(quantity>0),
  request_key TEXT NOT NULL,requested_quantity INTEGER NOT NULL CHECK(requested_quantity>0),
  removed INTEGER NOT NULL DEFAULT 0 CHECK(removed IN (0,1)),
  participant_id INTEGER REFERENCES pdv_participants(id),requested_participant_id INTEGER REFERENCES pdv_participants(id),
  UNIQUE(booking_id,request_key)
 );
 CREATE INDEX IF NOT EXISTS pdv_items_tab_active ON pdv_items(booking_id) WHERE removed=0;
 CREATE INDEX IF NOT EXISTS pdv_participants_tab_active ON pdv_participants(booking_id) WHERE removed=0;
 CREATE INDEX IF NOT EXISTS pdv_participants_payment_dates ON pdv_participants(paid_at) WHERE paid_at IS NOT NULL;
 CREATE INDEX IF NOT EXISTS pdv_tabs_payment_dates ON pdv_tabs(paid_at) WHERE paid_at IS NOT NULL;
 CREATE INDEX IF NOT EXISTS pdv_booking_payment_dates ON bookings(paid_at) WHERE paid=1;`);
 transaction(db,()=>{
  const columns=new Set(db.prepare('PRAGMA table_info(pdv_items)').all().map(column=>column.name));
  for(const column of ['participant_id','requested_participant_id']){
   if(!columns.has(column))db.exec(`ALTER TABLE pdv_items ADD COLUMN ${column} INTEGER REFERENCES pdv_participants(id)`);
  }
 });

 const insertTab=db.prepare('INSERT INTO pdv_tabs(booking_id,opened_at) VALUES(?,?) ON CONFLICT(booking_id) DO NOTHING');
 const lookupTab=db.prepare(`${selectTabs} WHERE b.id=? GROUP BY b.id`);
 const listTabs=db.prepare(`${selectTabs} WHERE b.date=? GROUP BY b.id ORDER BY b.start,c.name,b.id`);
 const listItems=db.prepare(`SELECT i.id,i.product_id,i.name,i.price_cents,i.quantity,
  i.price_cents*i.quantity total_cents,i.participant_id,p.name participant_name
  FROM pdv_items i LEFT JOIN pdv_participants p ON p.id=i.participant_id AND p.booking_id=i.booking_id
  WHERE i.booking_id=? AND i.removed=0 ORDER BY i.id`);
 const listProducts=db.prepare('SELECT id,name,price_cents,active FROM pdv_products ORDER BY active DESC,name COLLATE NOCASE,id');
 const lookupProduct=db.prepare('SELECT id,name,price_cents,active FROM pdv_products WHERE id=?');
 const lookupItem=db.prepare('SELECT id,price_cents,quantity,removed,participant_id FROM pdv_items WHERE id=? AND booking_id=?');
 const requestItem=db.prepare('SELECT product_id,requested_quantity,requested_participant_id FROM pdv_items WHERE booking_id=? AND request_key=?');
 const listParticipants=db.prepare('SELECT id,name,whatsapp,paid_cents,paid_at,method FROM pdv_participants WHERE booking_id=? AND removed=0 ORDER BY id');
 const lookupParticipant=db.prepare('SELECT id,name,whatsapp,removed,paid_at FROM pdv_participants WHERE id=? AND booking_id=?');
 const requestParticipant=db.prepare('SELECT requested_name,requested_whatsapp FROM pdv_participants WHERE booking_id=? AND request_key=?');
 const tabPixOrders=db.prepare(`SELECT participant_id,token,amount_cents,shared_cents,state,${activePix} active_link
  FROM pdv_pix_orders WHERE booking_id=? AND rowid IN (
   SELECT MAX(rowid) FROM pdv_pix_orders WHERE booking_id=? GROUP BY participant_id
  )`);
 const participantPixLock=db.prepare(`SELECT 1 FROM pdv_pix_orders WHERE booking_id=? AND participant_id=? AND ${activePix}`);
 const lookupPixOrder=db.prepare(`SELECT booking_id,participant_id,amount_cents,shared_cents,state,paid_at
  FROM pdv_pix_orders o WHERE id=? AND rowid=(SELECT MAX(rowid) FROM pdv_pix_orders
   WHERE booking_id=o.booking_id AND participant_id=o.participant_id)`);
 const courtPayments=db.prepare(`SELECT b.total cents,b.paid_at FROM bookings b
  WHERE b.paid=1 AND b.paid_at>=? AND b.paid_at<? AND NOT EXISTS(
   SELECT 1 FROM misticpay_split_plans p WHERE p.booking_id=b.id AND p.mode='deposit' AND p.archived=0
  )
  UNION ALL
  SELECT s.amount_cents cents,s.paid_at FROM misticpay_split_shares s JOIN misticpay_split_plans p USING(booking_id)
  WHERE s.state='approved' AND s.paid_at>=? AND s.paid_at<? AND p.mode='deposit' AND p.archived=0`);
 const consumptionPayments=db.prepare(`SELECT paid_cents cents,paid_at FROM pdv_tabs WHERE paid_at>=? AND paid_at<?
  UNION ALL SELECT paid_cents cents,paid_at FROM pdv_participants WHERE paid_at>=? AND paid_at<?`);

 function open(bookingId){
  insertTab.run(bookingId,new Date().toISOString());
 }

 function tab(bookingId){
  const row=lookupTab.get(bookingId);
  if(!row)fail('Comanda não encontrada.',404);
  const items=listItems.all(bookingId);
  const individualTotals=new Map();
  let shared_consumption_cents=0;
  for(const item of items){
   if(item.participant_id===null)shared_consumption_cents+=item.total_cents;
   else individualTotals.set(item.participant_id,(individualTotals.get(item.participant_id)||0)+item.total_cents);
  }
  const participants=listParticipants.all(bookingId);
  const latestPix=new Map(tabPixOrders.all(Date.now(),bookingId,bookingId).map(order=>[order.participant_id,order]));
  const currentPix=new Map([...latestPix].filter(([,order])=>order.active_link||order.state==='approved'));
  let shared_paid_cents=0,shared_reserved_cents=0,openCount=0;
  for(const participant of participants){
   const order=currentPix.get(participant.id);
   if(participant.paid_at)shared_paid_cents+=participant.paid_cents-(individualTotals.get(participant.id)||0);
   else if(order)shared_reserved_cents+=order.shared_cents;
   else openCount++;
  }
  const remainingShared=shared_consumption_cents-shared_paid_cents-shared_reserved_cents;
  const count=openCount||1;
  const base=Math.floor(remainingShared/count),remainder=remainingShared%count;
  let index=0;
  return {...tabSummary(row),items,shared_consumption_cents,shared_paid_cents,shared_reserved_cents,
   general_balance_cents:row.closed_at||openCount?0:remainingShared,
   participants:participants.map(participant=>{
    const individual_cents=individualTotals.get(participant.id)||0;
    const order=currentPix.get(participant.id),lastOrder=latestPix.get(participant.id);
    const shared_cents=participant.paid_at?participant.paid_cents-individual_cents:
     order?order.shared_cents:base+Number(index++<remainder);
    const status=participant.paid_at||row.closed_at?'closed':'open';
    const payment_link=order?{path:'/pagar-comanda#'+order.token,status:order.state,amount_cents:order.amount_cents}:null;
    const pix_status=lastOrder?.state==='ready'&&!lastOrder.active_link?'expired':lastOrder?.state??null;
    return {...participant,individual_cents,shared_cents,amount_cents:order&&!participant.paid_at?order.amount_cents:individual_cents+shared_cents,status,
     payment_link,pix_status,pix_pending:!!order?.active_link};
   })};
 }

 function receivedForDay(rows,date){
  let cents=0;
  for(const row of rows){
   const paidAt=new Date(row.paid_at);
   if(Number.isFinite(paidAt.getTime())&&dateFormatter.format(paidAt)===date)cents+=row.cents;
  }
  return safeAmount(cents,'O faturamento do dia excede o limite suportado.');
 }
 function daily(value){
  const {date,time}=selectedDay(value);
  const tabs=listTabs.all(date).map(tabSummary);
  // Use an indexed UTC window and check its local dates, including days with a historical offset change.
  const start=new Date(time-dayMilliseconds).toISOString(),end=new Date(time+2*dayMilliseconds).toISOString();
  const courts_cents=receivedForDay(courtPayments.all(start,end,start,end),date);
  const consumption_cents=receivedForDay(consumptionPayments.all(start,end,start,end),date);
  const total_cents=safeAmount(courts_cents+consumption_cents,'O faturamento do dia excede o limite suportado.');
  const open_consumption_cents=safeAmount(tabs.reduce((sum,row)=>sum+(row.status==='open'?row.consumption_balance_cents:0),0));
  return {date,tabs,products:listProducts.all().map(productSummary),revenue:{
   courts_cents,consumption_cents,total_cents,open_consumption_cents
  }};
 }

 function getProduct(id){
  const product=lookupProduct.get(id);
  if(!product)fail('Produto não encontrado.',404);
  return productSummary(product);
 }
 function createProduct(body){
  const name=productName(body.name),price_cents=productPrice(body.price_cents);
  const active=Object.hasOwn(body,'active')?body.active:true;
  if(typeof active!=='boolean')fail('Informe se o produto está ativo.');
  const created=db.prepare('INSERT INTO pdv_products(name,price_cents,active) VALUES(?,?,?)').run(name,price_cents,Number(active));
  return {id:Number(created.lastInsertRowid),name,price_cents,active};
 }
 function updateProduct(id,body){
  return transaction(db,()=>{
   const product=getProduct(id);
   const name=Object.hasOwn(body,'name')?productName(body.name):product.name;
   const price_cents=Object.hasOwn(body,'price_cents')?productPrice(body.price_cents):product.price_cents;
   const active=Object.hasOwn(body,'active')?body.active:product.active;
   if(typeof active!=='boolean')fail('Informe se o produto está ativo.');
   db.prepare('UPDATE pdv_products SET name=?,price_cents=?,active=? WHERE id=?').run(name,price_cents,Number(active),id);
   return {id,name,price_cents,active};
  });
 }

 function requireOpen(current){
  if(current.status!=='open')fail('Esta comanda não está aberta.',409);
 }
 function requireNoPix(bookingId,participantId){
  if(participantPixLock.get(bookingId,participantId,Date.now()))fail('Esta subcomanda tem uma cobrança Pix ativa.',409);
 }
 function verifyOpenAssignee(bookingId,id){
  if(id===null)return;
  const participant=lookupParticipant.get(id,bookingId);
  if(!participant||participant.removed)fail('Participante não encontrado nesta comanda.',404);
  if(participant.paid_at)fail('A subcomanda deste participante já foi fechada.',409);
  requireNoPix(bookingId,id);
 }
 function verifySharedAmount(current,change){
  if(current.shared_consumption_cents+change<current.shared_paid_cents+current.shared_reserved_cents){
   fail('O consumo compartilhado não pode ficar abaixo do valor recebido ou reservado em cobranças Pix.',409);
  }
 }
 const assigneeId=value=>value===null?null:positiveInteger(value,'Selecione um participante ou marque o item como compartilhado.');
 function addItem(bookingId,body){
  const productId=positiveInteger(body.product_id,'Selecione um produto.');
  const quantity=itemQuantity(body.quantity);
  const participantId=assigneeId(body.participant_id??null);
  const key=typeof body.request_key==='string'?body.request_key.toLowerCase():'';
  if(!requestKeyPattern.test(key))fail('Atualize o PDV antes de lançar o consumo.');
  return transaction(db,()=>{
   const current=tab(bookingId);
   const existing=requestItem.get(bookingId,key);
   if(existing){
    if(existing.product_id!==productId||existing.requested_quantity!==quantity||existing.requested_participant_id!==participantId){
     fail('Este lançamento já foi utilizado para outro item.',409);
    }
    return current;
   }
   requireOpen(current);
   if(current.booking_status==='cancelled')fail('A reserva está cancelada e não recebe novos consumos.',409);
   verifyOpenAssignee(bookingId,participantId);
   const product=getProduct(productId);
   if(!product.active)fail('Este produto está desativado.',409);
   safeAmount(current.consumption_cents+safeAmount(product.price_cents*quantity));
   open(bookingId);
   db.prepare(`INSERT INTO pdv_items(booking_id,product_id,name,price_cents,quantity,request_key,requested_quantity,
    participant_id,requested_participant_id) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(bookingId,productId,product.name,product.price_cents,quantity,key,quantity,participantId,participantId);
   return tab(bookingId);
  });
 }
 function updateItem(bookingId,itemId,body){
  return transaction(db,()=>{
   const current=tab(bookingId),item=lookupItem.get(itemId,bookingId);
   if(!item||item.removed)fail('Item não encontrado nesta comanda.',404);
   requireOpen(current);
   const quantity=Object.hasOwn(body,'quantity')?itemQuantity(body.quantity):item.quantity;
   const participantId=Object.hasOwn(body,'participant_id')?assigneeId(body.participant_id):item.participant_id;
   if(current.booking_status==='cancelled'&&quantity>item.quantity)fail('A reserva está cancelada e não recebe novos consumos.',409);
   verifyOpenAssignee(bookingId,item.participant_id);
   if(participantId!==item.participant_id)verifyOpenAssignee(bookingId,participantId);
   const previousTotal=item.price_cents*item.quantity;
   const newTotal=safeAmount(item.price_cents*quantity);
   safeAmount(current.consumption_cents-previousTotal+newTotal);
   const previousShared=item.participant_id===null?previousTotal:0;
   const newShared=participantId===null?newTotal:0;
   verifySharedAmount(current,newShared-previousShared);
   db.prepare('UPDATE pdv_items SET quantity=?,participant_id=? WHERE id=? AND booking_id=?')
    .run(quantity,participantId,itemId,bookingId);
   return tab(bookingId);
  });
 }
 function removeItem(bookingId,itemId){
  return transaction(db,()=>{
   const current=tab(bookingId),item=lookupItem.get(itemId,bookingId);
   if(!item)fail('Item não encontrado nesta comanda.',404);
   if(item.removed)return current;
   requireOpen(current);
   verifyOpenAssignee(bookingId,item.participant_id);
   if(item.participant_id===null)verifySharedAmount(current,-item.price_cents*item.quantity);
   // Preserve the original request key so retrying an earlier add cannot bring this item back.
   db.prepare('UPDATE pdv_items SET removed=1 WHERE id=? AND booking_id=?').run(itemId,bookingId);
   return tab(bookingId);
  });
 }
 function addParticipant(bookingId,body){
  const name=participantName(body.name),whatsapp=participantWhatsApp(body.whatsapp);
  const key=typeof body.request_key==='string'?body.request_key.toLowerCase():'';
  if(!requestKeyPattern.test(key))fail('Atualize o PDV antes de cadastrar o participante.');
  return transaction(db,()=>{
   const current=tab(bookingId),existing=requestParticipant.get(bookingId,key);
   if(existing){
    if(existing.requested_name!==name||existing.requested_whatsapp!==whatsapp)fail('Este cadastro já foi utilizado para outro participante.',409);
    return current;
   }
   requireOpen(current);
   open(bookingId);
   db.prepare(`INSERT INTO pdv_participants(booking_id,name,whatsapp,requested_name,requested_whatsapp,request_key)
    VALUES(?,?,?,?,?,?)`).run(bookingId,name,whatsapp,name,whatsapp,key);
   return tab(bookingId);
  });
 }
 function updateParticipant(bookingId,participantId,body){
  return transaction(db,()=>{
   const current=tab(bookingId),participant=lookupParticipant.get(participantId,bookingId);
   if(!participant||participant.removed)fail('Participante não encontrado nesta comanda.',404);
   requireOpen(current);
   if(participant.paid_at)fail('Este participante já tem um recebimento registrado.',409);
   requireNoPix(bookingId,participantId);
   const name=Object.hasOwn(body,'name')?participantName(body.name):participant.name;
   const whatsapp=Object.hasOwn(body,'whatsapp')?participantWhatsApp(body.whatsapp):participant.whatsapp;
   db.prepare('UPDATE pdv_participants SET name=?,whatsapp=? WHERE id=? AND booking_id=?').run(name,whatsapp,participantId,bookingId);
   return tab(bookingId);
  });
 }
 function removeParticipant(bookingId,participantId){
  return transaction(db,()=>{
   const current=tab(bookingId),participant=lookupParticipant.get(participantId,bookingId);
   if(!participant)fail('Participante não encontrado nesta comanda.',404);
   if(participant.removed)return current;
   requireOpen(current);
   if(participant.paid_at)fail('A subcomanda deste participante já foi fechada.',409);
   requireNoPix(bookingId,participantId);
   db.prepare('UPDATE pdv_items SET participant_id=NULL WHERE booking_id=? AND participant_id=? AND removed=0')
    .run(bookingId,participantId);
   db.prepare('UPDATE pdv_participants SET removed=1 WHERE id=? AND booking_id=?').run(participantId,bookingId);
   return tab(bookingId);
  });
 }
 function payParticipant(bookingId,participantId,body){
  const expected=positiveInteger(body.expected_cents,'Informe um valor de consumo a receber.');
  if(!paymentMethods.has(body.method))fail('Selecione a forma de recebimento do consumo.');
  return transaction(db,()=>{
   const current=tab(bookingId),participant=current.participants.find(row=>row.id===participantId);
   if(!participant)fail('Participante não encontrado nesta comanda.',404);
   if(participant.paid_at){
    if(participant.paid_cents!==expected||participant.method!==body.method)fail('Este recebimento já foi registrado.',409);
    return current;
   }
   requireOpen(current);
   requireNoPix(bookingId,participantId);
   if(participant.amount_cents!==expected)fail('O valor da parte mudou. Confira a divisão e tente novamente.',409);
   const now=new Date().toISOString();
   db.prepare('UPDATE pdv_participants SET paid_cents=?,paid_at=?,method=? WHERE id=? AND booking_id=?')
    .run(expected,now,body.method,participantId,bookingId);
   return tab(bookingId);
  });
 }

 function preparePix(bookingId,participantId,expectedCents){
  const expected=positiveInteger(expectedCents,'Informe um valor de consumo a receber.');
  const current=tab(bookingId),participant=current.participants.find(row=>row.id===participantId);
  if(!participant)fail('Participante não encontrado nesta comanda.',404);
  requireOpen(current);
  verifyOpenAssignee(bookingId,participantId);
  if(participant.amount_cents!==expected)fail('O valor da parte mudou. Confira a divisão e tente novamente.',409);
  return {amount_cents:expected,shared_cents:participant.shared_cents,payer_name:participant.name,whatsapp:participant.whatsapp};
 }

 function matchingPixOrder(order){
  const stored=lookupPixOrder.get(order.id);
  if(stored&&stored.booking_id===order.booking_id&&stored.participant_id===order.participant_id&&
     stored.amount_cents===order.amount_cents&&stored.shared_cents===order.shared_cents)return stored;
 }

 // The Pix service calls these methods inside the same transaction as the provider state update.
 function settlePix(order,paidAt){
  const stored=matchingPixOrder(order);
  if(!stored||!['creating','pending','unknown','review','approved'].includes(stored.state)){
   fail('A cobrança Pix não corresponde a esta subcomanda.',409);
  }
  const {booking_id,participant_id,amount_cents,shared_cents}=stored;
  const current=tab(booking_id),participant=current.participants.find(row=>row.id===participant_id);
  if(!participant)fail('Participante não encontrado nesta comanda.',409);
  if(participant.paid_at){
   if(participant.method===pixMethod&&participant.paid_cents===amount_cents&&participant.paid_at===stored.paid_at)return true;
   fail('Este recebimento já foi registrado.',409);
  }
  requireOpen(current);
  if(participant.individual_cents+shared_cents!==amount_cents||participant.amount_cents!==amount_cents){
   fail('O valor Pix não corresponde ao valor reservado para esta subcomanda.',409);
  }
  db.prepare('UPDATE pdv_participants SET paid_cents=?,paid_at=?,method=? WHERE id=? AND booking_id=?')
   .run(amount_cents,paidAt,pixMethod,participant_id,booking_id);
  return true;
 }

 function reversePix(order){
  const stored=matchingPixOrder(order);
  if(!stored||!['approved','review'].includes(stored.state)||!stored.paid_at)return false;
  const {booking_id,participant_id,amount_cents,paid_at}=stored;
  const current=tab(booking_id),participant=current.participants.find(row=>row.id===participant_id);
  if(current.status!=='open'||participant?.method!==pixMethod||participant.paid_cents!==amount_cents||participant.paid_at!==paid_at)return false;
  db.prepare('UPDATE pdv_participants SET paid_cents=0,paid_at=NULL,method=NULL WHERE id=? AND booking_id=?')
   .run(participant_id,booking_id);
  return true;
 }
 function close(bookingId,body){
  const {expected_total_cents:total,expected_balance_cents:balance}=body;
  const expectedValues=[total,balance].filter(value=>value!==undefined);
  if(!expectedValues.length||expectedValues.some(value=>!Number.isSafeInteger(value)||value<0)){
   fail('Informe o total ou o saldo a receber nesta comanda.');
  }
  return transaction(db,()=>{
   const current=tab(bookingId);
   if(total!==undefined&&current.consumption_cents!==total)fail('O total da comanda mudou. Confira os itens e tente novamente.',409);
   if(current.status==='open'&&current.participants.some(person=>person.pix_pending)){
    fail('Aguarde a confirmação das cobranças Pix para fechar a comanda geral.',409);
   }
   if(current.participants.some(person=>person.status==='open'&&person.amount_cents>0)){
    fail('Feche as subcomandas com saldo para fechar a comanda geral.',409);
   }
   const amount=current.status==='closed'?current.general_paid_cents:current.general_balance_cents;
   if(balance!==undefined&&amount!==balance)fail('O saldo da comanda mudou. Confira os recebimentos e tente novamente.',409);
   const method=amount>0?body.method:null;
   if(current.status==='closed'){
    if(current.method!==method)fail('Esta comanda já foi fechada com outra forma de pagamento.',409);
    return current;
   }
   requireOpen(current);
   if(amount>0&&!paymentMethods.has(method))fail('Selecione a forma de recebimento do consumo.');
   const now=new Date().toISOString();
   open(bookingId);
   db.prepare('UPDATE pdv_tabs SET closed_at=?,paid_at=?,method=?,paid_cents=? WHERE booking_id=?')
    .run(now,amount>0?now:null,method,amount,bookingId);
   return tab(bookingId);
  });
 }

 return {open,daily,tab,createProduct,updateProduct,addItem,updateItem,removeItem,close,
  addParticipant,updateParticipant,removeParticipant,payParticipant,preparePix,settlePix,reversePix};
}
