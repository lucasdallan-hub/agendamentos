import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {Buffer} from 'node:buffer';
import {transaction} from './storage.js';

const failure=(message,status=400)=>Object.assign(new Error(message),{status});

export function paymentConfiguration(env=process.env) {
 let baseUrl;
 try { const url=new URL(env.APP_BASE_URL); if(url.protocol==='https:'&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash) baseUrl=url.origin; } catch {}
 const mode=env.MERCADOPAGO_MODE||'test';
 return {token:env.MERCADOPAGO_ACCESS_TOKEN,webhookSecret:env.MERCADOPAGO_WEBHOOK_SECRET,baseUrl,mode,
  ready:!!(env.MERCADOPAGO_ACCESS_TOKEN&&env.MERCADOPAGO_WEBHOOK_SECRET&&baseUrl&&['test','production'].includes(mode))};
}

export class MercadoPago {
 constructor(config,fetchImpl=fetch) { this.config=config; this.fetch=fetchImpl; }
 async request(endpoint,body) {
  let response;
  try { response=await this.fetch(`https://api.mercadopago.com${endpoint}`,{
   method:body?'POST':'GET',headers:{Authorization:`Bearer ${this.config.token}`,'Content-Type':'application/json'},
   body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)
  }); } catch { throw failure('Não foi possível confirmar a resposta do Mercado Pago. Consulte o status antes de tentar novamente.',502); }
  if(!response.ok) {
   const error=failure('O Mercado Pago não autorizou a operação. Verifique a conta e a configuração da integração.',502);
   error.definitive=[400,401,403,404,422].includes(response.status); throw error;
  }
  try { return await response.json(); } catch { throw failure('Resposta inválida do Mercado Pago.',502); }
 }
 createPreference(body) {return this.request('/checkout/preferences',body);}
 getPayment(id) {return this.request(`/v1/payments/${encodeURIComponent(id)}`);}
 getAccount() {return this.request('/users/me');}
 searchPayments(reference) {return this.request(`/v1/payments/search?external_reference=${encodeURIComponent(reference)}&sort=date_created&criteria=desc&limit=100`);}
}

// Signature format documented by Mercado Pago: id + request-id + ts.
export function verifyWebhook({url,headers,secret}) {
 const id=url.searchParams.get('data.id');
 const requestId=headers['x-request-id'];
 const signature=headers['x-signature'];
 if(!secret||!id||!/^[a-zA-Z0-9-]{1,100}$/.test(id)||typeof requestId!=='string'||requestId.length>200||typeof signature!=='string') return false;
 const parts=signature.split(',').map(s=>s.trim().split('='));
 const ts=parts.find(([k])=>k==='ts')?.[1];
 const hashes=parts.filter(([k])=>k==='v1').map(([,v])=>v);
 if(!/^\d{1,20}$/.test(ts||'')) return false;
 const digest=createHmac('sha256',secret).update(`id:${id.toLowerCase()};request-id:${requestId};ts:${ts};`).digest();
 return hashes.some(hash=>/^[a-fA-F0-9]{64}$/.test(hash||'')&&timingSafeEqual(digest,Buffer.from(hash,'hex')));
}

export function createPayments(db,config,client) {
 const queues=new Map();
 db.exec('CREATE TABLE IF NOT EXISTS archived_payment_orders(order_id TEXT PRIMARY KEY)');
 const archived=id=>!!db.prepare('SELECT order_id FROM archived_payment_orders WHERE order_id=?').get(id);
 const copiedOrder=()=>{throw failure('Esta cobrança pertence ao histórico copiado do sistema mãe e só pode ser conciliada na origem.',409);};
 db.exec(`CREATE TABLE IF NOT EXISTS payment_orders(
  id TEXT PRIMARY KEY,booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id),preference_id TEXT,checkout_url TEXT,
  state TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS provider_payments(
  id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES payment_orders(id),status TEXT NOT NULL,
  amount INTEGER NOT NULL,refunded INTEGER NOT NULL,updated_at TEXT NOT NULL);`);
 function requireReady(){if(!config.ready)throw failure('A cobrança online ainda não foi ativada. Configure o Mercado Pago e o endereço público da arena.',503);}
 function getBooking(id){const b=db.prepare('SELECT b.*,c.name court_name FROM bookings b JOIN courts c ON c.id=b.court_id WHERE b.id=?').get(id);if(!b)throw failure('Agendamento não encontrado.',404);return b;}
 async function checkout(id){
  requireReady();const b=getBooking(id);
  if(b.paid||b.status!=='confirmed')throw failure('Esta reserva não pode receber uma nova cobrança.',409);
  let order=db.prepare('SELECT * FROM payment_orders WHERE booking_id=?').get(id);
  if(order&&archived(order.id))copiedOrder();
  if(order && order.state!=='failed'){
   if(order.checkout_url && new Date(order.expires_at)>new Date()&&['open','pending','rejected'].includes(order.state))return {checkout_url:order.checkout_url,expires_at:order.expires_at};
   throw failure(order.state==='creating'||order.state==='unknown'?'A criação da cobrança está em verificação. Consulte o Mercado Pago antes de gerar outra cobrança.':'Esta cobrança não permite um novo checkout. Consulte o status no Mercado Pago.',409);
  }
  const now=new Date(), expires=new Date(now.getTime()+24*3600000).toISOString();
  if(!order){const ref=randomUUID();db.prepare("INSERT INTO payment_orders(id,booking_id,state,expires_at,created_at) VALUES(?,?,'creating',?,?)").run(ref,id,expires,now.toISOString());order=db.prepare('SELECT * FROM payment_orders WHERE id=?').get(ref);}
  else db.prepare("UPDATE payment_orders SET state='creating',expires_at=? WHERE id=?").run(expires,order.id);
  try{
   const preference=await client.createPreference({
    items:[{id:String(b.id),title:`${b.court_name} · ${b.date} · ${b.start}–${b.end}`,quantity:1,currency_id:'BRL',unit_price:b.total/100}],
    external_reference:order.id,notification_url:`${config.baseUrl}/api/payments/webhook`,
    back_urls:{success:`${config.baseUrl}/pagamento`,pending:`${config.baseUrl}/pagamento`,failure:`${config.baseUrl}/pagamento`},
    auto_return:'approved',binary_mode:true,expires:true,expiration_date_from:now.toISOString(),expiration_date_to:expires,
    payment_methods:{excluded_payment_types:[{id:'ticket'},{id:'atm'}],installments:1}
   });
   const link=config.mode==='production'?preference.init_point:preference.sandbox_init_point;
   let parsed;try{parsed=new URL(link);}catch{}
   if(!preference.id||!parsed||parsed.protocol!=='https:'||!['www.mercadopago.com.br','sandbox.mercadopago.com.br'].includes(parsed.hostname))throw failure('O Mercado Pago não retornou um link de pagamento válido.',502);
   db.prepare("UPDATE payment_orders SET preference_id=?,checkout_url=?,expires_at=?,state=CASE WHEN state='creating' THEN 'open' ELSE state END WHERE id=?").run(String(preference.id),link,expires,order.id);
   return {checkout_url:link,expires_at:expires};
  }catch(error){db.prepare("UPDATE payment_orders SET state=? WHERE id=? AND state='creating'").run(error.definitive?'failed':'unknown',order.id);throw error;}
 }
 async function reconcilePayment(paymentId,expectedReference){
  requireReady();const payment=await client.getPayment(paymentId);
  const order=db.prepare('SELECT * FROM payment_orders WHERE id=?').get(typeof payment.external_reference==='string'?payment.external_reference:'');
  if(!order){if(expectedReference)throw failure('O pagamento não pertence a esta reserva.',409);return {ignored:true};}
  if(archived(order.id))return {ignored:true};
  if(expectedReference && order.id!==expectedReference)throw failure('O pagamento não pertence a esta reserva.',409);
  const b=getBooking(order.booking_id),account=await client.getAccount();
  const amount=Math.round(Number(payment.transaction_amount)*100),refunded=Math.round(Number(payment.transaction_amount_refunded||0)*100);
  if(String(payment.id)!==String(paymentId)||!account.id||String(payment.collector_id)!==String(account.id)||payment.currency_id!=='BRL'||amount!==b.total||payment.live_mode!==(config.mode==='production')||!Number.isSafeInteger(refunded)||refunded<0||refunded>amount)throw failure('O pagamento recebido não corresponde à conta, ao valor ou ao ambiente desta reserva.',409);
  const statuses=['approved','pending','in_process','authorized','rejected','cancelled','refunded','charged_back','in_mediation'];
  if(!statuses.includes(payment.status))throw failure('Status de pagamento não reconhecido.',409);
  return transaction(db,()=>{
   const previous=db.prepare('SELECT order_id FROM provider_payments WHERE id=?').get(String(payment.id));
   if(previous&&previous.order_id!==order.id)throw failure('Pagamento já associado a outra reserva.',409);
   db.prepare('INSERT INTO provider_payments(id,order_id,status,amount,refunded,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,refunded=excluded.refunded,updated_at=excluded.updated_at').run(String(payment.id),order.id,payment.status,amount,refunded,new Date().toISOString());
   const all=db.prepare('SELECT * FROM provider_payments WHERE order_id=?').all(order.id);
   const approved=all.filter(p=>p.status==='approved'&&p.refunded===0);
   const net=all.filter(p=>p.status==='approved').reduce((sum,p)=>sum+p.amount-p.refunded,0);
   let state=approved.length>1||net>b.total?'review':approved.length===1?'approved':all.some(p=>p.status==='charged_back')?'charged_back':all.some(p=>p.refunded>0||p.status==='refunded')?'refunded':all.some(p=>p.status==='in_mediation')?'review':all.some(p=>['pending','in_process','authorized'].includes(p.status))?'pending':'rejected';
   if(all.some(p=>p.refunded>0&&p.refunded<p.amount))state='review';
   if(b.status==='cancelled')state='review';
   db.prepare('UPDATE payment_orders SET state=? WHERE id=?').run(state,order.id);
   const paid=approved.length>0&&b.status==='confirmed';
   db.prepare("UPDATE bookings SET paid=?,method=?,paid_at=CASE WHEN ?=1 THEN COALESCE(paid_at,?) ELSE NULL END WHERE id=?").run(paid?1:0,'Mercado Pago',paid?1:0,new Date().toISOString(),b.id);
   return {ok:true,status:state};
  });
 }
 function reconcile(paymentId,expectedReference){
  const key=String(paymentId);
  const operation=(queues.get(key)||Promise.resolve()).catch(()=>{}).then(()=>reconcilePayment(key,expectedReference));
  queues.set(key,operation);
  const cleanup=()=>{if(queues.get(key)===operation)queues.delete(key);};
  operation.then(cleanup,cleanup);
  return operation;
 }
 async function sync(id){
  requireReady();const b=getBooking(id);const order=db.prepare('SELECT * FROM payment_orders WHERE booking_id=?').get(b.id);if(!order)throw failure('Esta reserva ainda não tem cobrança online.',404);
  if(archived(order.id))copiedOrder();
  const result=await client.searchPayments(order.id);
  if(!Array.isArray(result.results)||result.paging?.total>100)throw failure('Não foi possível consultar todos os pagamentos. Verifique a cobrança no Mercado Pago.',502);
  for(const payment of result.results) {if(!payment.id)throw failure('Resposta de pagamento inválida.',502);await reconcile(String(payment.id),order.id);}
  return {ok:true,status:db.prepare('SELECT state FROM payment_orders WHERE id=?').get(order.id).state};
 }
 return {checkout,reconcile,sync};
}
