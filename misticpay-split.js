import {Buffer} from 'node:buffer';
import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {lookupMisticPayOrder,requestMisticPay,transactionIdPattern} from './misticpay-api.js';
import {transaction} from './storage.js';

export const splitShareTokenPattern=/^[a-f0-9]{32}\.[1-9]\d{0,15}\.[a-f0-9]{64}$/;
const pageSize=20;
const firstRetryDelay=3_000;
const retryInterval=20_000;
const maxAttempts=4;
const retryStates=new Set(['COMPLETO','DEVOLVIDO','DEVOLVIDO_PARCIAL']);
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const hex=bytes=>randomBytes(bytes).toString('hex');
const shareAmount=(plan,index)=>Math.floor(plan.amount_cents/plan.share_count)+(index<=plan.amount_cents%plan.share_count?1:0);

function shareSignature(plan,index){
 return createHmac('sha256',Buffer.from(plan.secret,'hex')).update(plan.id+'.'+index).digest('hex');
}

export function createMisticPaySplit(db,{connection,fetchImpl,readCharge,validateCpf,schedule,enqueuePaidClient,dispatchPaidClient}){
 db.exec(`CREATE TABLE IF NOT EXISTS misticpay_split_plans(
  booking_id INTEGER PRIMARY KEY REFERENCES bookings(id),id TEXT NOT NULL UNIQUE,secret TEXT NOT NULL,
  share_count INTEGER NOT NULL CHECK(share_count>=2),amount_cents INTEGER NOT NULL CHECK(amount_cents>=share_count),
  archived INTEGER NOT NULL DEFAULT 0,archived_paid_count INTEGER NOT NULL DEFAULT 0,archived_paid_cents INTEGER NOT NULL DEFAULT 0
 );
 CREATE TABLE IF NOT EXISTS misticpay_split_shares(
  booking_id INTEGER NOT NULL REFERENCES misticpay_split_plans(booking_id),share_index INTEGER NOT NULL,
  id TEXT NOT NULL UNIQUE,provider_id TEXT UNIQUE,amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  state TEXT NOT NULL,webhook_token TEXT NOT NULL UNIQUE,qr_code TEXT,copy_paste TEXT,
  created_at INTEGER NOT NULL,checked_at INTEGER,provider_state TEXT,provider_updated_at TEXT,last_webhook_digest TEXT,
  retry_state TEXT,retry_attempts INTEGER NOT NULL DEFAULT 0,next_check_at INTEGER,
  PRIMARY KEY(booking_id,share_index)
 );
 CREATE INDEX IF NOT EXISTS misticpay_split_due ON misticpay_split_shares(next_check_at) WHERE next_check_at IS NOT NULL;
 CREATE INDEX IF NOT EXISTS misticpay_split_created ON misticpay_split_shares(created_at DESC,id DESC);`);
 const getPlan=db.prepare('SELECT * FROM misticpay_split_plans WHERE booking_id=?');
 const getCharge=db.prepare('SELECT * FROM misticpay_split_shares WHERE booking_id=? AND share_index=?');
 const getChargeState=db.prepare('SELECT state FROM misticpay_split_shares WHERE booking_id=? AND share_index=?');
 const getChargeById=db.prepare('SELECT * FROM misticpay_split_shares WHERE id=?');
 const anyCharge=db.prepare('SELECT 1 FROM misticpay_split_shares WHERE booking_id=? LIMIT 1');
 const getBooking=db.prepare('SELECT id,total,status,paid,method FROM bookings WHERE id=?');
 const fullCharge=db.prepare('SELECT 1 FROM misticpay_orders WHERE booking_id=?');
 const totals=db.prepare(`SELECT COUNT(*) AS paid_count,COALESCE(SUM(amount_cents),0) AS paid_cents
  FROM misticpay_split_shares WHERE booking_id=? AND state='approved'`);
 const hasSplitTransaction=db.prepare('SELECT 1 FROM misticpay_split_shares WHERE (id=? OR provider_id=?) AND id<>?');
 const activeChecks=new Map();

 const hasSplitPlan=id=>!!getPlan.get(id);
 const hasTransaction=(id,except='')=>!!hasSplitTransaction.get(id,id,except);
 const rejectArchived=plan=>{
  if(plan?.archived)fail('A divisão pertence ao histórico copiado e só pode ser gerenciada na arena original.',409);
 };

 function assertFreePaymentLane(bookingId){
  if(fullCharge.get(bookingId)||db.prepare('SELECT 1 FROM pix_links WHERE booking_id=?').get(bookingId)){
   fail('Esta reserva já possui uma cobrança Pix integral.',409);
  }
  const checkout=db.prepare(`SELECT 1 FROM payment_orders o WHERE o.booking_id=? AND NOT(
   o.state='failed' AND o.preference_id IS NULL AND o.checkout_url IS NULL
   AND NOT EXISTS(SELECT 1 FROM provider_payments p WHERE p.order_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM archived_payment_orders a WHERE a.order_id=o.id)
  )`).get(bookingId);
  if(checkout)fail('Esta reserva já possui cobrança Mercado Pago.',409);
 }

 function summary(plan){
  const {paid_count,paid_cents}=plan.archived
   ? {paid_count:plan.archived_paid_count,paid_cents:plan.archived_paid_cents}
   : totals.get(plan.booking_id);
  const booking=getBooking.get(plan.booking_id);
  const editable=!plan.archived&&booking?.status==='confirmed'&&!booking.paid&&!anyCharge.get(plan.booking_id);
  const paid=paid_count===plan.share_count&&paid_cents===plan.amount_cents;
  return {
   count:plan.share_count,total:plan.amount_cents,paid_count,paid_cents,
   status:plan.archived?'archived':paid?'approved':'pending',
   editable,can_change:editable
  };
 }

 function splitSummary(bookingId){
  const plan=getPlan.get(bookingId);
  return plan?summary(plan):null;
 }

 function splitBooking(bookingId,page=1){
  const plan=getPlan.get(bookingId);
  if(!plan)return null;
  rejectArchived(plan);
  if(!Number.isSafeInteger(page)||page<1)fail('Informe uma página válida de cotas.');
  const pages=Math.ceil(plan.share_count/pageSize);
  page=Math.min(page,pages);
  const start=(page-1)*pageSize+1,end=Math.min(plan.share_count,start+pageSize-1);
  const charges=db.prepare(`SELECT share_index,state FROM misticpay_split_shares
   WHERE booking_id=? AND share_index BETWEEN ? AND ?`).all(bookingId,start,end);
  const states=new Map(charges.map(charge=>[charge.share_index,charge.state]));
  const shares=[];
  for(let index=start;index<=end;index++){
   shares.push({
    index,amount_cents:shareAmount(plan,index),status:states.get(index)??'uncreated',
    path:`/catalogo#cota:${plan.id}.${index}.${shareSignature(plan,index)}`
   });
  }
  return {...summary(plan),page,pages,shares};
 }

 async function splitPlan(bookingId,count){
  const booking=getBooking.get(bookingId);
  if(!booking)fail('Reserva não encontrada.',404);
  if(!Number.isSafeInteger(count)||count<2||count>booking.total){
   fail('Informe pelo menos duas cotas, com no mínimo um centavo por cota.');
  }
  const previous=getPlan.get(bookingId);
  rejectArchived(previous);
  if(previous?.share_count===count)return splitBooking(bookingId);
  const currentConnection=await connection.active();
  transaction(db,()=>{
   const current=getBooking.get(bookingId),plan=getPlan.get(bookingId);
   rejectArchived(plan);
   if(!connection.isCurrent(currentConnection))fail('A configuração MisticPay mudou. Tente novamente.',409);
   if(!current||current.paid||current.status!=='confirmed'||current.total!==booking.total){
    fail('Esta reserva não aceita uma divisão de pagamento.',409);
   }
   assertFreePaymentLane(bookingId);
   if(plan?.share_count===count)return;
   if(plan&&anyCharge.get(bookingId))fail('A quantidade de cotas fica fixa após a primeira cobrança.',409);
   db.prepare(`INSERT INTO misticpay_split_plans(booking_id,id,secret,share_count,amount_cents)
    VALUES(?,?,?,?,?) ON CONFLICT(booking_id) DO UPDATE SET id=excluded.id,secret=excluded.secret,
    share_count=excluded.share_count,amount_cents=excluded.amount_cents`).run(bookingId,hex(16),hex(32),count,booking.total);
  });
  return splitBooking(bookingId);
 }

 function cancelSplit(bookingId){
  return transaction(db,()=>{
   rejectArchived(getPlan.get(bookingId));
   if(anyCharge.get(bookingId))fail('A divisão fica fixa após a primeira cobrança.',409);
   db.prepare('DELETE FROM misticpay_split_plans WHERE booking_id=?').run(bookingId);
   return {ok:true};
  });
 }

 function sharePlan(token){
  if(typeof token!=='string'||!splitShareTokenPattern.test(token))fail('Cota não encontrada.',404);
  const [id,position,signature]=token.split('.');
  const index=Number(position);
  const plan=db.prepare(`SELECT p.*,b.status booking_status,b.date,b.start,b.end,c.name court_name,
   r.expires_at FROM misticpay_split_plans p JOIN bookings b ON b.id=p.booking_id
   JOIN courts c ON c.id=b.court_id LEFT JOIN public_booking_requests r ON r.booking_id=b.id WHERE p.id=? AND p.archived=0`).get(id);
  if(!plan||!Number.isSafeInteger(index)||index>plan.share_count||
   !timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(shareSignature(plan,index),'hex'))){
   fail('Cota não encontrada.',404);
  }
  if(plan.expires_at==null||plan.expires_at<=Date.now())fail('O link desta cota expirou. Consulte a arena.',410);
  if(plan.booking_status!=='confirmed')fail('Esta reserva não está mais disponível.',410);
  return {plan,index};
 }

 function shareDetails(plan,index){
  const charge=getCharge.get(plan.booking_id,index);
  const status=charge?.state??'uncreated';
  return {
   index,count:plan.share_count,amount_cents:shareAmount(plan,index),status,
   qr_code:status==='pending'?charge.qr_code:null,copy_paste:status==='pending'?charge.copy_paste:null,
   court_name:plan.court_name,date:plan.date,start:plan.start,end:plan.end
  };
 }

 function share(token){
  const {plan,index}=sharePlan(token);
  return shareDetails(plan,index);
 }
 function shareStatus(token){
  const {plan,index}=sharePlan(token);
  return getChargeState.get(plan.booking_id,index)?.state??'uncreated';
 }

 const fullTransaction=db.prepare('SELECT 1 FROM misticpay_orders WHERE id=? OR provider_id=?');
 function assertUniqueTransaction(providerId,shareId){
  if(hasTransaction(providerId,shareId)||fullTransaction.get(providerId,providerId)){
   fail('A transação consultada pertence a outra cobrança.',409);
  }
 }

 async function createShare(token,body){
  const initial=sharePlan(token);
  const {booking_id}=initial.plan;
  const index=initial.index;
  if(getCharge.get(booking_id,index))return shareDetails(initial.plan,index);
  const name=typeof body.name==='string'?body.name.trim():'';
  if(name.length<2||name.length>120||/[\x00-\x1f\x7f]/.test(name))fail('Informe seu nome para gerar o Pix.');
  const cpf=validateCpf(body.cpf);
  const currentConnection=await connection.active();
  const claim=transaction(db,()=>{
   const {plan}=sharePlan(token);
   if(getCharge.get(booking_id,index))return null;
   const booking=getBooking.get(booking_id);
   if(!booking||booking.paid||booking.status!=='confirmed'||booking.total!==plan.amount_cents){
    fail('Esta reserva não aceita uma nova cobrança.',409);
   }
   if(!connection.isCurrent(currentConnection))fail('A configuração MisticPay mudou. Tente novamente.',409);
   assertFreePaymentLane(booking_id);
   const id=randomUUID(),webhook=hex(32),amount=shareAmount(plan,index);
   db.prepare(`INSERT INTO misticpay_split_shares(booking_id,share_index,id,amount_cents,state,webhook_token,created_at)
    VALUES(?,?,?,?,'creating',?,?)`).run(booking_id,index,id,amount,webhook,Date.now());
   return {id,webhook,amount,count:plan.share_count};
  });
  if(!claim)return share(token);
  try{
   const charge=await requestMisticPay(fetchImpl,currentConnection,'create',{
    amount:claim.amount/100,payerName:name,payerDocument:cpf,transactionId:claim.id,
    description:`Reserva #${booking_id} · Cota ${index} de ${claim.count}`,
    projectWebhook:`${currentConnection.base_url}/api/misticpay/split-webhook/${claim.webhook}`
   },{decode:result=>readCharge(result.data)});
   transaction(db,()=>{
    assertUniqueTransaction(charge.id,claim.id);
    db.prepare(`UPDATE misticpay_split_shares SET provider_id=?,qr_code=?,copy_paste=?,state=?
     WHERE id=? AND state='creating'`).run(charge.id,charge.qr,charge.copyPaste,
      charge.state==='PENDENTE'?'pending':'unknown',claim.id);
   });
  }catch(error){
   if(error.definitive)db.prepare("DELETE FROM misticpay_split_shares WHERE id=? AND state='creating'").run(claim.id);
   else db.prepare("UPDATE misticpay_split_shares SET state='unknown' WHERE id=? AND state='creating'").run(claim.id);
   throw error;
  }
  return share(token);
 }

 async function reconcile(id,fromWebhook){
  const order=getChargeById.get(id);
  if(!order)fail('Cobrança da cota não encontrada.',404);
  const now=Date.now();
  if((order.state==='creating'&&now-order.created_at<15_000)||(!fromWebhook&&now-(order.checked_at??0)<5_000))return;
  const currentConnection=await connection.active({allowUnverified:true});
  db.prepare('UPDATE misticpay_split_shares SET checked_at=? WHERE id=?').run(now,id);
  const payment=await lookupMisticPayOrder(fetchImpl,currentConnection,order);
  if(!payment)fail('A MisticPay ainda não encontrou esta cota.',409);
  if(payment.cents!==order.amount_cents||(order.provider_id&&![order.id,order.provider_id].includes(payment.id))){
   fail('A transação consultada não corresponde ao valor e à referência da cota.',409);
  }
  const paidNow=transaction(db,()=>{
   const current=getChargeById.get(id),plan=getPlan.get(order.booking_id),booking=getBooking.get(order.booking_id);
   if(!current||!plan||!booking||booking.total!==plan.amount_cents||
    shareAmount(plan,current.share_index)!==payment.cents||!connection.isCurrent(currentConnection)){
    fail('A cobrança, a reserva ou a configuração mudou durante a consulta.',409);
   }
   assertUniqueTransaction(payment.id,id);
   connection.recordVerified();
   if(payment.updatedAt&&current.provider_updated_at&&payment.updatedAt<current.provider_updated_at)return false;
   let state;
   if(payment.state==='COMPLETO'){
    if(['refunded','review'].includes(current.state)&&(!payment.updatedAt||!current.provider_updated_at||payment.updatedAt<=current.provider_updated_at))return false;
    state=booking.status==='confirmed'?'approved':'review';
   }else if(payment.state==='DEVOLVIDO'||payment.state==='DEVOLVIDO_PARCIAL'){
    state=payment.state==='DEVOLVIDO'?'refunded':'review';
   }else{
    if(['approved','refunded','review'].includes(current.state))return false;
    state=payment.state==='PENDENTE'?(current.qr_code?'pending':'unknown'):payment.state==='CANCELADO'?'cancelled':'failed';
   }
   const reachedRetry=current.retry_state===payment.state;
   db.prepare(`UPDATE misticpay_split_shares SET state=?,provider_id=COALESCE(provider_id,?),
    provider_state=?,provider_updated_at=COALESCE(?,provider_updated_at),
    last_webhook_digest=CASE WHEN provider_state=? THEN last_webhook_digest ELSE NULL END,
    next_check_at=CASE WHEN ? THEN NULL ELSE next_check_at END,
    retry_state=CASE WHEN ? THEN NULL ELSE retry_state END,
    retry_attempts=CASE WHEN ? THEN 0 ELSE retry_attempts END WHERE id=?`)
    .run(state,payment.id,payment.state,payment.updatedAt,payment.state,reachedRetry?1:0,reachedRetry?1:0,reachedRetry?1:0,id);
   const {paid_count,paid_cents}=totals.get(plan.booking_id);
   const complete=booking.status==='confirmed'&&paid_count===plan.share_count&&paid_cents===plan.amount_cents;
   if(complete&&!booking.paid){
    db.prepare("UPDATE bookings SET paid=1,method='MisticPay',paid_at=? WHERE id=?")
     .run(new Date().toISOString(),plan.booking_id);
    enqueuePaidClient?.(plan.booking_id);
    return true;
   }
   if(!complete&&booking.paid&&booking.method==='MisticPay'){
    db.prepare("UPDATE bookings SET paid=0,paid_at=NULL WHERE id=?").run(plan.booking_id);
   }
   return false;
  });
  if(paidNow)await dispatchPaidClient?.(order.booking_id);
 }

 function checkCharge(id,fromWebhook=false){
  const existing=activeChecks.get(id);
  if(existing)return existing;
  const operation=reconcile(id,fromWebhook);
  activeChecks.set(id,operation);
  const cleanup=()=>activeChecks.delete(id);
  operation.then(cleanup,cleanup);
  return operation;
 }

 async function syncShare(token){
  const {plan,index}=sharePlan(token);
  const charge=getCharge.get(plan.booking_id,index);
  if(charge)await checkCharge(charge.id);
  return share(token);
 }

 async function armRetries(){
  if(typeof schedule!=='function')return;
  const {next}=db.prepare('SELECT MIN(next_check_at) AS next FROM misticpay_split_shares WHERE next_check_at IS NOT NULL').get();
  if(next!=null)await schedule(Math.max(Date.now()+1_000,next));
 }

 async function queueRetry(id,state){
  const scheduled=transaction(db,()=>{
   const current=getChargeById.get(id);
   if(!current||current.provider_state===state)return false;
   db.prepare(`UPDATE misticpay_split_shares SET retry_state=?,retry_attempts=0,next_check_at=?
    WHERE id=? AND (retry_state IS NULL OR retry_state<>?)`).run(state,Date.now()+firstRetryDelay,id,state);
   return getChargeById.get(id)?.next_check_at!=null;
  });
  if(scheduled)await armRetries();
  return scheduled;
 }

 async function splitWebhook(secret,body){
  const order=db.prepare('SELECT * FROM misticpay_split_shares WHERE webhook_token=?').get(secret);
  if(!order)fail('Cobrança da cota não encontrada.',404);
  const hintedId=typeof body.transactionId==='string'||Number.isSafeInteger(body.transactionId)?String(body.transactionId):'';
  const deposit=body.transactionType==='DEPOSITO'&&body.transactionMethod==='PIX';
  const eventMatches=deposit&&[order.id,order.provider_id].includes(hintedId);
  const canBeEarly=deposit&&!order.provider_id&&['creating','unknown'].includes(order.state)&&transactionIdPattern.test(hintedId);
  const expectsRetry=(eventMatches||canBeEarly)&&retryStates.has(body.status);
  const digest=eventMatches?createHash('sha256').update(JSON.stringify(body)).digest('hex'):null;
  if(digest&&order.provider_state===body.status&&order.last_webhook_digest===digest)return {ok:true};
  try{await checkCharge(order.id,true);}
  catch(error){
   if(expectsRetry&&![401,403].includes(error.providerStatus)&&await queueRetry(order.id,body.status))return {ok:true};
   throw error;
  }
  const current=getChargeById.get(order.id);
  if(expectsRetry&&current?.provider_state!==body.status&&await queueRetry(order.id,body.status))return {ok:true};
  if(digest)db.prepare('UPDATE misticpay_split_shares SET last_webhook_digest=? WHERE id=? AND provider_state=?')
   .run(digest,order.id,typeof body.status==='string'?body.status:'');
  return {ok:true};
 }

 async function drainSplitChecks(){
  const jobs=transaction(db,()=>{
   const now=Date.now();
   const ready=db.prepare(`SELECT id,retry_attempts FROM misticpay_split_shares
    WHERE next_check_at<=? ORDER BY next_check_at LIMIT 3`).all(now);
   const advance=db.prepare('UPDATE misticpay_split_shares SET retry_attempts=?,next_check_at=? WHERE id=?');
   for(const job of ready){
    const attempt=job.retry_attempts+1;
    advance.run(attempt,attempt<maxAttempts?now+retryInterval:null,job.id);
   }
   return ready;
  });
  await Promise.allSettled(jobs.map(({id})=>checkCharge(id,true)));
  await armRetries();
 }

 return {hasSplitPlan,hasTransaction,splitPlan,splitBooking,splitSummary,cancelSplit,share,shareStatus,createShare,syncShare,splitWebhook,
  drainSplitChecks,resumeSplitChecks:armRetries};
}
