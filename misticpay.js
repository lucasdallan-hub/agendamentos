import {Buffer} from 'node:buffer';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {transaction} from './storage.js';
import {lookupMisticPay,readTransaction,requestMisticPay} from './misticpay-api.js';
import {createMisticPayConnection} from './misticpay-connection.js';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const invalidResponse=()=>fail('A MisticPay retornou dados inválidos. Consulte a transação no painel do provedor.',502);
const token=()=>randomBytes(32).toString('hex');

function readCharge(row){
 const charge=readTransaction(row);
 const qr=row.qrCodeBase64;
 const encoded=typeof qr==='string'&&qr.length<=200_000&&/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(qr)?qr.slice(22):'';
 const bytes=Buffer.from(encoded,'base64');
 if(bytes.length<24||bytes.toString('base64')!==encoded||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.toString('ascii',12,16)!=='IHDR')invalidResponse();
 const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
 if(!width||!height||width>2048||height>2048||typeof row.copyPaste!=='string'||!/^000201[^\x00-\x1f\x7f]{12,2042}$/.test(row.copyPaste))invalidResponse();
 return {...charge,qr,copyPaste:row.copyPaste};
}

function validateCpf(value){
 const cpf=typeof value==='string'&&/^[0-9.\- ]{11,20}$/.test(value)?value.replace(/\D/g,''):'';
 if(!/^\d{11}$/.test(cpf)||/^(\d)\1{10}$/.test(cpf))fail('Informe um CPF válido.');
 for(const length of [9,10]){
  const sum=Array.from(cpf.slice(0,length)).reduce((total,digit,index)=>total+Number(digit)*(length+1-index),0);
  if((sum*10%11)%10!==Number(cpf[length]))fail('Informe um CPF válido.');
 }
 return cpf;
}

export function createMisticPay(db,{fetchImpl=fetch,encryptionKey,scope='main'}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS misticpay_orders(
  booking_id INTEGER PRIMARY KEY REFERENCES bookings(id),id TEXT NOT NULL UNIQUE,provider_id TEXT UNIQUE,
  amount_cents INTEGER NOT NULL,state TEXT NOT NULL,webhook_token TEXT UNIQUE,qr_code TEXT,copy_paste TEXT,
  checked_at INTEGER,created_at INTEGER NOT NULL,archived INTEGER NOT NULL DEFAULT 0
 );`);
 transaction(db,()=>{
  const columns=new Set(db.prepare('PRAGMA table_info(misticpay_orders)').all().map(column=>column.name));
  if(!columns.has('provider_state'))db.exec('ALTER TABLE misticpay_orders ADD COLUMN provider_state TEXT');
  if(!columns.has('provider_updated_at'))db.exec('ALTER TABLE misticpay_orders ADD COLUMN provider_updated_at TEXT');
  if(!columns.has('last_webhook_digest'))db.exec('ALTER TABLE misticpay_orders ADD COLUMN last_webhook_digest TEXT');
 });
 const getOrder=id=>db.prepare('SELECT * FROM misticpay_orders WHERE booking_id=?').get(id);
 const getBooking=id=>db.prepare('SELECT id,customer,total,status,paid,method FROM bookings WHERE id=?').get(id);
 const activeChecks=new Map();
 const lookup=(credentials,id,options)=>lookupMisticPay(fetchImpl,credentials,id,options);
 const connectionSettings=createMisticPayConnection(db,{encryptionKey,scope,lookup});
 function details(id){
  const order=getOrder(id);
  if(!order)return null;
  if(order.archived)return {status:'archived',qr_code:null,copy_paste:null};
  return {status:order.state,qr_code:order.state==='pending'?order.qr_code:null,copy_paste:order.state==='pending'?order.copy_paste:null};
 }
 async function create(id,body){
  const existing=details(id);
  if(existing)return existing;
  const connection=await connectionSettings.active();
  const claim=transaction(db,()=>{
   if(getOrder(id))return null;
   if(!connectionSettings.isCurrent(connection))fail('A configuração MisticPay mudou. Tente novamente.',409);
   const booking=getBooking(id);
   if(!booking)fail('Agendamento não encontrado.',404);
   if(booking.paid||booking.status!=='confirmed')fail('Esta reserva não aceita uma nova cobrança.',409);
   if(db.prepare('SELECT 1 FROM pix_links WHERE booking_id=?').get(id))fail('Esta reserva já utiliza Pix direto.',409);
   const payerDocument=validateCpf(body.cpf);
   db.prepare("DELETE FROM payment_orders WHERE booking_id=? AND state='failed' AND preference_id IS NULL AND checkout_url IS NULL AND NOT EXISTS(SELECT 1 FROM provider_payments p WHERE p.order_id=payment_orders.id) AND NOT EXISTS(SELECT 1 FROM archived_payment_orders a WHERE a.order_id=payment_orders.id)").run(id);
   if(db.prepare('SELECT 1 FROM payment_orders WHERE booking_id=?').get(id))fail('Esta reserva já possui cobrança Mercado Pago.',409);
   const reference=randomUUID(),webhookToken=token();
   db.prepare("INSERT INTO misticpay_orders(booking_id,id,amount_cents,state,webhook_token,created_at) VALUES(?,?,?,'creating',?,?)").run(id,reference,booking.total,webhookToken,Date.now());
   return {booking,reference,webhookToken,payerDocument};
  });
  if(!claim)return details(id);
  try{
   const charge=await requestMisticPay(fetchImpl,connection,'create',{
    amount:claim.booking.total/100,payerName:claim.booking.customer,payerDocument:claim.payerDocument,
    transactionId:claim.reference,description:`Reserva #${id} · Arena Vôlei`,
    projectWebhook:`${connection.base_url}/api/misticpay/webhook/${claim.webhookToken}`
   },{decode:result=>readCharge(result.data)});
   db.prepare("UPDATE misticpay_orders SET provider_id=?,qr_code=?,copy_paste=?,state=? WHERE id=? AND state='creating'")
    .run(charge.id,charge.qr,charge.copyPaste,charge.state==='PENDENTE'?'pending':'unknown',claim.reference);
  }catch(error){
   if(error.definitive)db.prepare("DELETE FROM misticpay_orders WHERE id=? AND state='creating'").run(claim.reference);
   else db.prepare("UPDATE misticpay_orders SET state='unknown' WHERE id=? AND state='creating'").run(claim.reference);
   throw error;
  }
  return details(id);
 }
 async function reconcile(id,fromWebhook){
  const order=getOrder(id);
  if(!order||order.archived)fail('Cobrança MisticPay não encontrada.',404);
  const now=Date.now();
  if((order.state==='creating'&&now-order.created_at<15_000)||(!fromWebhook&&now-(order.checked_at??0)<5_000))return details(id);
  const connection=await connectionSettings.active({allowUnverified:true});
  db.prepare('UPDATE misticpay_orders SET checked_at=? WHERE booking_id=?').run(now,id);
  const payment=await lookup(connection,order.id);
  if(!payment)fail('A MisticPay ainda não encontrou esta cobrança. Confira o painel do provedor.',409);
  if(payment.cents!==order.amount_cents||(order.provider_id&&payment.id!==order.provider_id&&payment.id!==order.id))fail('A transação consultada não corresponde à cobrança da reserva.',409);
  return transaction(db,()=>{
   const booking=getBooking(id);
   const current=getOrder(id);
   if(!current||current.id!==order.id||!booking||booking.total!==payment.cents||!connectionSettings.isCurrent(connection)){
    fail('A cobrança ou a configuração mudou durante a consulta.',409);
   }
   if(payment.updatedAt&&current.provider_updated_at&&payment.updatedAt<current.provider_updated_at)return details(id);
   const wasPaid=booking.paid&&booking.method==='MisticPay';
   let state=current.state;
   if(payment.state==='COMPLETO'){
    state=booking.status==='confirmed'&&(!booking.paid||wasPaid)?'approved':'review';
    if(state==='approved')db.prepare("UPDATE bookings SET paid=1,method='MisticPay',paid_at=COALESCE(paid_at,?) WHERE id=?").run(new Date().toISOString(),id);
   }else if(payment.state==='DEVOLVIDO'||payment.state==='DEVOLVIDO_PARCIAL'){
    state=payment.state==='DEVOLVIDO'?'refunded':'review';
    if(wasPaid)db.prepare('UPDATE bookings SET paid=0,paid_at=NULL WHERE id=?').run(id);
   }else{
    if(wasPaid||['refunded','review'].includes(current.state))return details(id);
    if(payment.state==='PENDENTE')state=current.qr_code?'pending':'unknown';
    else state=payment.state==='CANCELADO'?'cancelled':'failed';
   }
   db.prepare(`UPDATE misticpay_orders SET state=?,provider_id=COALESCE(provider_id,?),
    provider_state=?,provider_updated_at=COALESCE(?,provider_updated_at),
    last_webhook_digest=CASE WHEN provider_state=? THEN last_webhook_digest ELSE NULL END WHERE id=?`)
    .run(state,payment.id,payment.state,payment.updatedAt??null,payment.state,order.id);
   return details(id);
  });
 }
 function sync(id,fromWebhook=false){
  const previous=activeChecks.get(id);
  if(previous)return previous;
  const operation=reconcile(id,fromWebhook);
  activeChecks.set(id,operation);
  const cleanup=()=>activeChecks.delete(id);
  operation.then(cleanup,cleanup);
  return operation;
 }
 async function webhook(secret,body){
  const order=db.prepare('SELECT * FROM misticpay_orders WHERE webhook_token=? AND archived=0').get(secret);
  if(!order)fail('Cobrança MisticPay não encontrada.',404);
  // The transaction API notification is a hint; only an authenticated lookup can confirm its state.
  const hintedId=typeof body.transactionId==='string'||Number.isSafeInteger(body.transactionId)?String(body.transactionId):'';
  const eventMatches=[order.id,order.provider_id].includes(hintedId)&&body.transactionType==='DEPOSITO'&&body.transactionMethod==='PIX';
  const digest=eventMatches?createHash('sha256').update(JSON.stringify(body)).digest('hex'):null;
  if(digest&&order.provider_state===body.status&&order.last_webhook_digest===digest)return {ok:true};
  await sync(order.booking_id,true);
  if(digest)db.prepare('UPDATE misticpay_orders SET last_webhook_digest=? WHERE id=? AND provider_state=?')
   .run(digest,order.id,typeof body.status==='string'?body.status:'');
  return {ok:true};
 }
 return {
  settings:connectionSettings.settings,configuration:connectionSettings.configuration,
  saveSettings:connectionSettings.saveSettings,verify:connectionSettings.verify,details,create,sync,webhook
 };
}
