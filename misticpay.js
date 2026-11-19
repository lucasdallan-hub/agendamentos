import {Buffer} from 'node:buffer';
import {randomBytes,randomInt,randomUUID} from 'node:crypto';
import {transaction} from './storage.js';

const apiOrigin='https://api.misticpay.com/api';
const states=new Set(['PENDENTE','COMPLETO','FALHA','CANCELADO','DEVOLVIDO','DEVOLVIDO_PARCIAL']);
const definitiveErrors=new Map([
 ['INVALID_API_CREDENTIAL',401],['IP_NOT_ALLOWED',401],['API_SCOPE_DENIED',403],
 ['API_CREDENTIAL_REQUIRED',400],['INVALID_JSON',400],['VALIDATION_ERROR',400],['AMOUNT_BELOW_MINIMUM',400]
]);
const missingTransactionMessages=new Set(['transacao nao encontrada','transacao nao localizada','transaction not found']);
const transactionAbsent=Symbol('transaction absent');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const invalidResponse=()=>fail('A MisticPay retornou dados inválidos. Consulte a transação no painel do provedor.',502);
const token=()=>randomBytes(32).toString('hex');

function missingTransaction({status,data}){
 if(status!==404&&status!==400)return false;
 if(data?.code!==undefined&&data.code!==null)return data.code==='TRANSACTION_NOT_FOUND';
 if(data?.statusCode!==undefined&&data.statusCode!==status)return false;
 if(typeof data?.message!=='string'||data.message.length>80)return false;
 const message=data.message.normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase().replace(/[.!]+$/,'');
 return missingTransactionMessages.has(message);
}

async function request(fetchImpl,credentials,action,body){
 const requestId=randomUUID();
 let result,providerStatus;
 try{
  const response=await fetchImpl(`${apiOrigin}/transactions/${action}`,{
   method:'POST',redirect:'manual',signal:AbortSignal.timeout(12_000),
   headers:{Authorization:'Basic '+Buffer.from(credentials.public_key+':'+credentials.secret_key).toString('base64'),'Content-Type':'application/json','X-Request-Id':requestId},
   body:JSON.stringify(body)
  });
  providerStatus=response.status;
  if(!response.body||Number(response.headers.get('content-length'))>300_000)throw new Error();
  const chunks=[];let size=0;
  for await(const chunk of response.body){
   size+=chunk.byteLength;
   if(size>300_000)throw new Error();
   chunks.push(chunk);
  }
  result={status:response.status,ok:response.ok,data:JSON.parse(Buffer.concat(chunks,size).toString('utf8'))};
 }catch{
  const message=providerStatus?'A MisticPay respondeu em um formato inesperado.':'Não foi possível consultar a MisticPay. Confira a conexão e tente novamente.';
  throw Object.assign(new Error(message),{status:502,providerStatus,requestId});
 }
 if(result.ok)return result.data;
 if(action==='check'&&missingTransaction(result))return transactionAbsent;
 const code=result.data?.code;
 const definitive=definitiveErrors.get(code)===result.status;
 let message='A MisticPay recusou a solicitação.';
 if(result.status===401||result.status===403)message='A MisticPay recusou o acesso. Confira o Client ID e o Client Secret em API → Chaves de Acesso.';
 if(definitive&&code==='INVALID_API_CREDENTIAL')message='Client ID ou Client Secret inválido ou revogado. Copie o par ativo em API → Chaves de Acesso da MisticPay.';
 if(definitive&&code==='IP_NOT_ALLOWED')message='A MisticPay bloqueou o IP de saída do servidor. Confira a lista de IPs autorizados na conta MisticPay.';
 if(definitive&&code==='API_CREDENTIAL_REQUIRED')message='A MisticPay não reconheceu as credenciais enviadas. Use o Client ID pk_ e o Client Secret sk_ da mesma chave de acesso.';
 if(definitive&&code==='API_SCOPE_DENIED'){
  const scope=action==='check'?'TRANSACTION_READ':'TRANSACTION_CREATE';
  message=`A chave de acesso precisa da permissão ${scope}. Crie uma chave com TRANSACTION_READ e TRANSACTION_CREATE na MisticPay.`;
 }
 if(result.status===429)message='A MisticPay limitou as consultas. Aguarde um momento e tente novamente.';
 const providerCode=typeof code==='string'&&/^[A-Z][A-Z0-9_]{1,63}$/.test(code)?code:undefined;
 throw Object.assign(new Error(message),{status:502,definitive,providerStatus,providerCode,requestId});
}

function readTransaction(row){
 const id=typeof row?.transactionId==='string'?row.transactionId:
  Number.isSafeInteger(row?.transactionId)?String(row.transactionId):'';
 if(!/^[A-Za-z0-9._:-]{1,128}$/.test(id)||row?.transactionType!=='DEPOSITO'||row?.transactionMethod!=='PIX'||!states.has(row?.transactionState))invalidResponse();
 return {id,state:row.transactionState};
}

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

function readPayment(row){
 const payment=readTransaction(row);
 const cents=Math.round(row.value*100);
 if(!Number.isSafeInteger(cents)||cents<=0||cents/100!==row.value)invalidResponse();
 return {...payment,cents};
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

function credential(next,stored){
 const value=typeof next==='string'?next.trim():next;
 return value===undefined||value===''?stored:value;
}

export function createMisticPay(db,{fetchImpl=fetch}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS misticpay_connection(
  id INTEGER PRIMARY KEY CHECK(id=1),public_key TEXT NOT NULL,secret_key TEXT NOT NULL,base_url TEXT NOT NULL
 );
 CREATE TABLE IF NOT EXISTS misticpay_orders(
  booking_id INTEGER PRIMARY KEY REFERENCES bookings(id),id TEXT NOT NULL UNIQUE,provider_id TEXT UNIQUE,
  amount_cents INTEGER NOT NULL,state TEXT NOT NULL,webhook_token TEXT UNIQUE,qr_code TEXT,copy_paste TEXT,
  checked_at INTEGER,created_at INTEGER NOT NULL,archived INTEGER NOT NULL DEFAULT 0
 );`);
 const getConnection=()=>db.prepare('SELECT public_key,secret_key,base_url FROM misticpay_connection WHERE id=1').get();
 const getOrder=id=>db.prepare('SELECT * FROM misticpay_orders WHERE booking_id=?').get(id);
 const getBooking=id=>db.prepare('SELECT id,customer,total,status,paid,method FROM bookings WHERE id=?').get(id);
 const activeChecks=new Map();
 const settings=()=>{
  const stored=getConnection();
  return {ready:!!stored,public_key_configured:!!stored,secret_key_configured:!!stored,base_url:stored?.base_url??''};
 };
 async function lookup(connection,id){
  const result=await request(fetchImpl,connection,'check',{transactionId:id});
  return result===transactionAbsent?null:readPayment(result?.transaction);
 }
 async function verifyNewConnection(connection){
  // The API accepts a numeric identifier as text or as a number.
  const reference=randomInt(1_800_000_000,2_000_000_000);
  try{return await lookup(connection,String(reference));}
  catch(error){
   if(error.providerStatus!==400||error.providerCode!=='VALIDATION_ERROR')throw error;
   return lookup(connection,reference);
  }
 }
 async function saveSettings(body){
  const stored=getConnection();
  const publicKey=credential(body.client_id??body.public_key,stored?.public_key);
  const secretKey=credential(body.client_secret??body.secret_key,stored?.secret_key);
  if((typeof publicKey==='string'&&publicKey.startsWith('ci_'))||(typeof secretKey==='string'&&secretKey.startsWith('cs_'))){
   fail('A MisticPay desativou as credenciais ci_ e cs_. Em API → Chaves de Acesso, crie um par pk_ e sk_.');
  }
  if(typeof publicKey!=='string'||!/^pk_[A-Za-z0-9_-]{1,252}$/.test(publicKey)||typeof secretKey!=='string'||!/^sk_[A-Za-z0-9_-]{1,252}$/.test(secretKey)){
   fail('Informe o Client ID (pk_) e o Client Secret (sk_) da mesma chave de acesso da MisticPay.');
  }
  let url;
  try{url=new URL(body.base_url);}catch{fail('Informe o endereço HTTPS público da arena.');}
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!url.hostname.includes('.'))fail('Informe somente a origem HTTPS pública da arena.');
  const next={public_key:publicKey,secret_key:secretKey,base_url:url.origin};
  const changingKeys=!stored||stored.public_key!==publicKey||stored.secret_key!==secretKey;
  const findLatest=()=>db.prepare('SELECT * FROM misticpay_orders WHERE archived=0 ORDER BY created_at DESC,id DESC LIMIT 1').get();
  const latest=findLatest();
  if(changingKeys){
   let payment;
   try{payment=latest?await lookup(next,latest.id):await verifyNewConnection(next);}
   catch(error){
    if(!error.requestId)throw error;
    const status=error.providerStatus?` HTTP ${error.providerStatus}`:'';
    const code=error.providerCode?` ${error.providerCode}`:'';
    fail(`${error.message}${status}${code} · Referência ${error.requestId}`,502);
   }
   if(latest&&(!payment||!latest.provider_id||![latest.provider_id,latest.id].includes(payment.id)||payment.cents!==latest.amount_cents))fail('As novas chaves precisam dar acesso às cobranças já criadas nesta arena.',409);
  }
  return transaction(db,()=>{
   const current=getConnection();
   if(current?.public_key!==stored?.public_key||current?.secret_key!==stored?.secret_key||current?.base_url!==stored?.base_url||(changingKeys&&latest?.id!==findLatest()?.id)){
    fail('A conexão ou as cobranças mudaram durante a configuração. Tente novamente.',409);
   }
   db.prepare('INSERT INTO misticpay_connection VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET public_key=excluded.public_key,secret_key=excluded.secret_key,base_url=excluded.base_url')
    .run(publicKey,secretKey,next.base_url);
   return settings();
  });
 }
 function details(id){
  const order=getOrder(id);
  if(!order)return null;
  if(order.archived)return {status:'archived',qr_code:null,copy_paste:null};
  return {status:order.state,qr_code:order.state==='pending'?order.qr_code:null,copy_paste:order.state==='pending'?order.copy_paste:null};
 }
 async function create(id,body){
  const claim=transaction(db,()=>{
   const existing=details(id);
   if(existing)return null;
   const connection=getConnection();
   if(!connection)fail('O Pix via MisticPay ainda não foi configurado.',503);
   const booking=getBooking(id);
   if(!booking)fail('Agendamento não encontrado.',404);
   if(booking.paid||booking.status!=='confirmed')fail('Esta reserva não aceita uma nova cobrança.',409);
   if(db.prepare('SELECT 1 FROM pix_links WHERE booking_id=?').get(id))fail('Esta reserva já utiliza Pix direto.',409);
   const payerDocument=validateCpf(body.cpf);
   db.prepare("DELETE FROM payment_orders WHERE booking_id=? AND state='failed' AND preference_id IS NULL AND checkout_url IS NULL AND NOT EXISTS(SELECT 1 FROM provider_payments p WHERE p.order_id=payment_orders.id) AND NOT EXISTS(SELECT 1 FROM archived_payment_orders a WHERE a.order_id=payment_orders.id)").run(id);
   if(db.prepare('SELECT 1 FROM payment_orders WHERE booking_id=?').get(id))fail('Esta reserva já possui cobrança Mercado Pago.',409);
   const reference=randomUUID(),webhookToken=token();
   db.prepare("INSERT INTO misticpay_orders(booking_id,id,amount_cents,state,webhook_token,created_at) VALUES(?,?,?,'creating',?,?)").run(id,reference,booking.total,webhookToken,Date.now());
   return {connection,booking,reference,webhookToken,payerDocument};
  });
  if(!claim)return details(id);
  try{
   const result=await request(fetchImpl,claim.connection,'create',{
    amount:claim.booking.total/100,payerName:claim.booking.customer,payerDocument:claim.payerDocument,
    transactionId:claim.reference,description:`Reserva #${id} · Arena Vôlei`,
    projectWebhook:`${claim.connection.base_url}/api/misticpay/webhook/${claim.webhookToken}`
   });
   const charge=readCharge(result?.data);
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
  const connection=getConnection();
  if(!connection)fail('Conecte a MisticPay para consultar a cobrança.',503);
  if((order.state==='creating'&&now-order.created_at<15_000)||(!fromWebhook&&now-(order.checked_at??0)<5_000))return details(id);
  db.prepare('UPDATE misticpay_orders SET checked_at=? WHERE booking_id=?').run(now,id);
  const payment=await lookup(connection,order.id);
  if(!payment)fail('A MisticPay ainda não encontrou esta cobrança. Confira o painel do provedor.',409);
  if(payment.cents!==order.amount_cents||(order.provider_id&&payment.id!==order.provider_id&&payment.id!==order.id))fail('A transação consultada não corresponde à cobrança da reserva.',409);
  return transaction(db,()=>{
   const booking=getBooking(id);
   const current=getOrder(id);
   if(!current||current.id!==order.id||!booking||booking.total!==payment.cents)fail('A cobrança da reserva mudou durante a consulta.',409);
   const wasPaid=booking.paid&&booking.method==='MisticPay';
   let state=current.state;
   if(payment.state==='COMPLETO'){
    state=booking.status==='confirmed'&&(!booking.paid||wasPaid)?'approved':'review';
    if(state==='approved')db.prepare("UPDATE bookings SET paid=1,method='MisticPay',paid_at=COALESCE(paid_at,?) WHERE id=?").run(new Date().toISOString(),id);
   }else if(payment.state==='DEVOLVIDO'||payment.state==='DEVOLVIDO_PARCIAL'){
    state='review';
    if(wasPaid)db.prepare('UPDATE bookings SET paid=0,paid_at=NULL WHERE id=?').run(id);
   }else if(!wasPaid&&current.state!=='review'){
    state=payment.state==='PENDENTE'?(current.qr_code?'pending':'unknown'):'failed';
   }
   db.prepare('UPDATE misticpay_orders SET state=?,provider_id=COALESCE(provider_id,?) WHERE id=?').run(state,payment.id,order.id);
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
 async function webhook(secret){
  const order=db.prepare('SELECT booking_id FROM misticpay_orders WHERE webhook_token=? AND archived=0').get(secret);
  if(!order)fail('Cobrança MisticPay não encontrada.',404);
  await sync(order.booking_id,true);
  return {ok:true};
 }
 return {settings,saveSettings,details,create,sync,webhook};
}
