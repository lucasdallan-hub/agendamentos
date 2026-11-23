import {randomBytes,randomUUID} from 'node:crypto';
import {lookupMisticPayOrder,requestMisticPay,transactionIdPattern} from './misticpay-api.js';
import {transaction} from './storage.js';

const linkLifetime=7*24*60*60*1000;
const firstRetryDelay=3_000;
const retryDelay=20_000;
const retryLimit=4;
const tokenPattern=/^[a-f0-9]{64}$/;
const retryStates=new Set(['COMPLETO','CANCELADO','FALHA','DEVOLVIDO','DEVOLVIDO_PARCIAL']);
const settledStates=new Set(['approved','cancelled','refunded','review']);
const activeCondition="state IN ('creating','pending','unknown','review','approved') OR (state='ready' AND expires_at>?)";
const token=()=>randomBytes(32).toString('hex');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};

export function initializePdvPixOrders(db){
 db.exec(`CREATE TABLE IF NOT EXISTS pdv_pix_orders(
  id TEXT PRIMARY KEY,booking_id INTEGER NOT NULL REFERENCES bookings(id),
  participant_id INTEGER NOT NULL REFERENCES pdv_participants(id),token TEXT NOT NULL UNIQUE,webhook_token TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),shared_cents INTEGER NOT NULL CHECK(shared_cents>=0 AND shared_cents<=amount_cents),
  payer_name TEXT NOT NULL,state TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,
  provider_id TEXT UNIQUE,qr_code TEXT,copy_paste TEXT,checked_at INTEGER,paid_at TEXT,
  provider_state TEXT,provider_updated_at TEXT,retry_state TEXT,retry_attempts INTEGER NOT NULL DEFAULT 0,next_check_at INTEGER
 );
 CREATE INDEX IF NOT EXISTS pdv_pix_orders_by_participant ON pdv_pix_orders(booking_id,participant_id);
 CREATE INDEX IF NOT EXISTS pdv_pix_orders_due ON pdv_pix_orders(next_check_at) WHERE next_check_at IS NOT NULL;`);
}

export function hasPdvPixTransaction(db,id,except=''){
 return !!db.prepare('SELECT 1 FROM pdv_pix_orders WHERE (id=? OR provider_id=?) AND id<>?').get(id,id,except);
}

export function createPdvPix(db,{pdv,connection,fetchImpl,readCharge,validateCpf,schedule}){
 const latest=db.prepare('SELECT * FROM pdv_pix_orders WHERE booking_id=? AND participant_id=? ORDER BY rowid DESC LIMIT 1');
 const active=db.prepare(`SELECT id FROM pdv_pix_orders WHERE booking_id=? AND participant_id=? AND id<>? AND (${activeCondition}) LIMIT 1`);
 const byId=db.prepare('SELECT * FROM pdv_pix_orders WHERE id=?');
 const byToken=db.prepare('SELECT * FROM pdv_pix_orders WHERE token=?');
 const byWebhook=db.prepare('SELECT * FROM pdv_pix_orders WHERE webhook_token=?');
 const unpaidParticipant=db.prepare(`SELECT 1 FROM pdv_participants p JOIN pdv_tabs t USING(booking_id)
  WHERE p.booking_id=? AND p.id=? AND p.removed=0 AND p.paid_at IS NULL AND t.closed_at IS NULL`);
 const fullCharge=db.prepare('SELECT 1 FROM misticpay_orders WHERE id=? OR provider_id=?');
 const splitCharge=db.prepare('SELECT 1 FROM misticpay_split_shares WHERE id=? OR provider_id=?');
 const activeChecks=new Map();

 function findOrder(value){
  const order=typeof value==='string'&&tokenPattern.test(value)?byToken.get(value):null;
  if(!order)fail('Link Pix da subcomanda não encontrado.',404);
  return order;
 }

 function expired(order){
  return order.state==='ready'&&order.expires_at<=Date.now();
 }

 function details(order){
  const status=expired(order)?'cancelled':order.state;
  const receipt=status==='approved'&&order.paid_at?{
   reference:order.provider_id??order.id,amount_cents:order.amount_cents,
   paid_at:order.paid_at,payer_name:order.payer_name,booking_id:order.booking_id
  }:null;
  return {
   status,amount_cents:order.amount_cents,qr_code:status==='pending'?order.qr_code:null,
   copy_paste:status==='pending'?order.copy_paste:null,receipt
  };
 }
 const read=value=>details(findOrder(value));
 const publicLink=order=>({path:`/pagar-comanda#${order.token}`,status:order.state,amount_cents:order.amount_cents});
 const isLatest=order=>latest.get(order.booking_id,order.participant_id)?.id===order.id;

 function openLink(bookingId,participantId,expectedCents){
  if(!Number.isSafeInteger(expectedCents)||expectedCents<=0)fail('Informe um valor de consumo a receber.');
  return transaction(db,()=>{
   const previous=latest.get(bookingId,participantId);
   if(previous&&expired(previous)){
    db.prepare("UPDATE pdv_pix_orders SET state='cancelled' WHERE id=? AND state='ready'").run(previous.id);
   }else if(previous&&!['cancelled','refunded'].includes(previous.state)){
    if(previous.amount_cents!==expectedCents)fail('O valor da cobrança Pix já criada é diferente.',409);
    return publicLink(previous);
   }
   if(active.get(bookingId,participantId,'',Date.now()))fail('A subcomanda já tem uma cobrança Pix em análise.',409);
   if(!connection.settings().ready)fail('Configure a MisticPay antes de gerar o link Pix.',409);
   const {amount_cents,shared_cents,payer_name}=pdv.preparePix(bookingId,participantId,expectedCents);
   const now=Date.now(),id=randomUUID(),linkToken=token();
   db.prepare(`INSERT INTO pdv_pix_orders(id,booking_id,participant_id,token,webhook_token,amount_cents,
    shared_cents,payer_name,state,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,'ready',?,?)`)
    .run(id,bookingId,participantId,linkToken,token(),amount_cents,shared_cents,payer_name,now+linkLifetime,now);
   return publicLink(byId.get(id));
  });
 }

 function cancelLink(bookingId,participantId){
  return transaction(db,()=>{
   const order=latest.get(bookingId,participantId);
   if(!order)fail('A subcomanda ainda não tem um link Pix.',404);
   if(order.state==='cancelled')return {ok:true};
   if(order.state!=='ready')fail('A cobrança já foi solicitada à MisticPay. Consulte a situação na MisticPay antes de cancelar.',409);
   db.prepare("UPDATE pdv_pix_orders SET state='cancelled' WHERE id=?").run(order.id);
   return {ok:true};
  });
 }

 function assertUniqueTransaction(providerId,orderId){
  if(fullCharge.get(providerId,providerId)||splitCharge.get(providerId,providerId)||hasPdvPixTransaction(db,providerId,orderId)){
   fail('A transação pertence a outra cobrança.',409);
  }
 }

 async function create(value,body){
  const initial=findOrder(value);
  if(initial.state!=='ready')return details(initial);
  if(expired(initial))fail('O link Pix expirou. Solicite um novo link ao estabelecimento.',410);
  const cpf=validateCpf(body.cpf);
  const credentials=await connection.active();
  const order=transaction(db,()=>{
   const current=findOrder(value);
   if(current.state!=='ready')return null;
   if(expired(current))fail('O link Pix expirou. Solicite um novo link ao estabelecimento.',410);
   if(!connection.isCurrent(credentials))fail('A configuração MisticPay mudou. Tente novamente.',409);
   if(active.get(current.booking_id,current.participant_id,current.id,Date.now())||
    !unpaidParticipant.get(current.booking_id,current.participant_id)){
    fail('Esta subcomanda não aceita uma nova cobrança Pix.',409);
   }
   db.prepare("UPDATE pdv_pix_orders SET state='creating',created_at=? WHERE id=?").run(Date.now(),current.id);
   return current;
  });
  if(!order)return read(value);
  try{
   const charge=await requestMisticPay(fetchImpl,credentials,'create',{
    amount:order.amount_cents/100,payerName:order.payer_name,payerDocument:cpf,transactionId:order.id,
    description:`Consumo da reserva #${order.booking_id}`,
    projectWebhook:`${credentials.base_url}/api/misticpay/pdv-webhook/${order.webhook_token}`
   },{decode:result=>readCharge(result.data)});
   transaction(db,()=>{
    assertUniqueTransaction(charge.id,order.id);
    db.prepare("UPDATE pdv_pix_orders SET provider_id=?,qr_code=?,copy_paste=?,state=? WHERE id=? AND state='creating'")
     .run(charge.id,charge.qr,charge.copyPaste,charge.state==='PENDENTE'?'pending':'unknown',order.id);
   });
   if(charge.state==='COMPLETO')await queueRetry(order.id,'COMPLETO');
  }catch(error){
   db.prepare("UPDATE pdv_pix_orders SET state=? WHERE id=? AND state='creating'").run(error.definitive?'ready':'unknown',order.id);
   throw error;
  }
  return read(value);
 }

 function paymentState(current,payment){
  const paidAt=current.paid_at;
  if(payment.state==='DEVOLVIDO_PARCIAL')return {state:'review',paidAt};
  if(payment.state==='DEVOLVIDO'){
   return !paidAt||pdv.reversePix(current)?{state:'refunded',paidAt:null}:{state:'review',paidAt};
  }
  if(payment.state==='COMPLETO'){
   if(current.state==='approved'&&paidAt)return {state:'approved',paidAt};
   if(active.get(current.booking_id,current.participant_id,current.id,Date.now()))return {state:'review',paidAt};
   const approvedAt=paidAt??new Date().toISOString();
   try{
    if(pdv.settlePix(current,approvedAt)!==false)return {state:'approved',paidAt:approvedAt};
   }catch(error){
    if(error.status!==409)throw error;
   }
   return {state:'review',paidAt};
  }
  if(payment.state==='PENDENTE')return {state:current.qr_code?'pending':'unknown',paidAt};
  return {state:'cancelled',paidAt:null};
 }

 async function reconcile(id,fromWebhook){
  const order=byId.get(id);
  if(!order||order.state==='ready'||order.state==='cancelled'&&!order.provider_state||!isLatest(order))return;
  const now=Date.now();
  if(order.state==='creating'&&now-order.created_at<15_000||!fromWebhook&&now-(order.checked_at??0)<5_000)return;
  const credentials=await connection.active({allowUnverified:true});
  db.prepare('UPDATE pdv_pix_orders SET checked_at=? WHERE id=?').run(now,id);
  const payment=await lookupMisticPayOrder(fetchImpl,credentials,order);
  if(!payment)fail('A MisticPay ainda não encontrou o Pix desta subcomanda.',409);
  if(payment.cents!==order.amount_cents||order.provider_id&&![order.id,order.provider_id].includes(payment.id)){
   fail('O Pix consultado não corresponde à cobrança desta subcomanda.',409);
  }
  transaction(db,()=>{
   const current=byId.get(id);
   if(!current||current.amount_cents!==payment.cents||!connection.isCurrent(credentials)){
    fail('A cobrança ou a configuração mudou durante a consulta.',409);
   }
   // A provider-confirmed cancellation or refund may already have allowed a new link.
   if(!isLatest(current))return;
   assertUniqueTransaction(payment.id,id);
   connection.recordVerified();
   const previousUpdate=current.provider_updated_at;
   if(payment.updatedAt&&previousUpdate&&payment.updatedAt<previousUpdate)return;
   if(payment.state==='COMPLETO'&&settledStates.has(current.state)&&current.provider_state!=='COMPLETO'&&
    (!payment.updatedAt||!previousUpdate||payment.updatedAt<=previousUpdate))return;
   if(settledStates.has(current.state)&&['PENDENTE','CANCELADO','FALHA'].includes(payment.state))return;
   const {state,paidAt}=paymentState(current,payment);
   const reachedRetry=Number(current.retry_state===payment.state);
   db.prepare(`UPDATE pdv_pix_orders SET state=?,paid_at=?,provider_id=COALESCE(provider_id,?),provider_state=?,
    provider_updated_at=COALESCE(?,provider_updated_at),next_check_at=CASE WHEN ? THEN NULL ELSE next_check_at END,
    retry_state=CASE WHEN ? THEN NULL ELSE retry_state END,retry_attempts=CASE WHEN ? THEN 0 ELSE retry_attempts END WHERE id=?`)
    .run(state,paidAt,payment.id,payment.state,payment.updatedAt,reachedRetry,reachedRetry,reachedRetry,id);
  });
 }

 function checkOrder(id,fromWebhook=false){
  const existing=activeChecks.get(id);
  if(existing)return existing;
  const operation=reconcile(id,fromWebhook);
  activeChecks.set(id,operation);
  const finish=()=>activeChecks.delete(id);
  operation.then(finish,finish);
  return operation;
 }

 async function check(value){
  await checkOrder(findOrder(value).id);
  return read(value);
 }

 async function resume(){
  if(typeof schedule!=='function')return;
  const {next}=db.prepare('SELECT MIN(next_check_at) next FROM pdv_pix_orders WHERE next_check_at IS NOT NULL').get();
  if(next!=null)await schedule(Math.max(Date.now()+1_000,next));
 }

 async function queueRetry(id,state){
  const queued=transaction(db,()=>{
   const current=byId.get(id);
   if(!current||current.provider_state===state||!isLatest(current))return false;
   db.prepare(`UPDATE pdv_pix_orders SET retry_state=?,retry_attempts=0,next_check_at=?
    WHERE id=? AND (retry_state IS NULL OR retry_state<>?)`).run(state,Date.now()+firstRetryDelay,id,state);
   return byId.get(id)?.next_check_at!=null;
  });
  if(queued)await resume();
  return queued;
 }

 async function webhook(secret,body){
  const order=byWebhook.get(secret);
  if(!order||order.state==='ready'||order.state==='cancelled'&&!order.provider_state)fail('Cobrança Pix da subcomanda não encontrada.',404);
  if(!isLatest(order))return {ok:true};
  const hintedId=typeof body.transactionId==='string'||Number.isSafeInteger(body.transactionId)?String(body.transactionId):'';
  const known=[order.id,order.provider_id].includes(hintedId);
  const early=!order.provider_id&&['creating','unknown'].includes(order.state)&&transactionIdPattern.test(hintedId);
  const deposit=body.transactionType==='DEPOSITO'&&body.transactionMethod==='PIX';
  if(known&&deposit&&body.status===order.provider_state&&order.state!=='review')return {ok:true};
  const retry=(known||early)&&deposit&&retryStates.has(body.status);
  try{await checkOrder(order.id,true);}
  catch(error){
   if(retry&&![401,403].includes(error.providerStatus)&&await queueRetry(order.id,body.status))return {ok:true};
   throw error;
  }
  if(retry&&byId.get(order.id)?.provider_state!==body.status)await queueRetry(order.id,body.status);
  return {ok:true};
 }

 async function drain(){
  const due=transaction(db,()=>{
   const now=Date.now();
   const jobs=db.prepare('SELECT id,retry_attempts FROM pdv_pix_orders WHERE next_check_at<=? ORDER BY next_check_at LIMIT 3').all(now);
   const advance=db.prepare('UPDATE pdv_pix_orders SET retry_attempts=?,next_check_at=? WHERE id=?');
   for(const job of jobs){
    const attempt=job.retry_attempts+1;
    advance.run(attempt,attempt<retryLimit?now+retryDelay:null,job.id);
   }
   return jobs;
  });
  await Promise.allSettled(due.map(job=>checkOrder(job.id,true)));
  await resume();
 }

 return {openLink,cancelLink,read,create,check,webhook,drain,resume};
}
