import {randomBytes} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {branding} from './systems.js';
import {transaction} from './storage.js';

const DEFAULT_URL='https://api.dallan.pro';
const PROVIDERS={
 evolution:{name:'Evolution Go',url:DEFAULT_URL,table:'notification_connection',header:'apikey',status:'/instance/status',send:'/send/text'},
 wuzapi:{name:'WUZAPI',url:'https://api.dallanspace.com.br',table:'notification_wuzapi',header:'Token',status:'/session/status',send:'/chat/send/text'}
};
const WEBHOOK_EVENTS=['CONNECTION'];
const reminderLeadMinutes=10;
const alertBatchSize=6;
const scheduledRoles=new Set(['arena_start','arena_reminder','reminder']);
const customerRoles=new Set(['client','reminder']);
const confirmedPayment=`b.status='confirmed' AND b.paid=1 AND (
 b.method IS NOT 'Mercado Pago' OR EXISTS(
  SELECT 1 FROM payment_orders p WHERE p.booking_id=b.id AND p.state='approved'
 ))`;
const depositRecord=`misticpay_split_plans p
 JOIN misticpay_split_shares s ON s.booking_id=p.booking_id AND s.share_index=1`;
const verifiedDeposit=`p.archived=0 AND p.mode='deposit' AND p.share_count=2
 AND p.amount_cents=b.total AND s.amount_cents=(b.total+1)/2
 AND s.state='approved' AND s.provider_state='COMPLETO'`;
const confirmedDeposit=`b.status='confirmed' AND EXISTS(
 SELECT 1 FROM ${depositRecord} WHERE p.booking_id=b.id AND ${verifiedDeposit}
)`;
const eligiblePending=`n.status='pending'
 AND (n.role NOT IN ('client','reminder') OR (${confirmedPayment}))
 AND (n.role<>'client_deposit' OR (${confirmedDeposit}))`;
const arenaClock=new Intl.DateTimeFormat('en-CA',{
 timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',
 hour:'2-digit',minute:'2-digit',hourCycle:'h23'
});

const minutesOfDay=time=>Number(time.slice(0,2))*60+Number(time.slice(3));
function alertWindow(){
 const parts=arenaClock.formatToParts(Date.now());
 const {year,month,day,hour,minute}=Object.fromEntries(parts.map(({type,value})=>[type,value]));
 const time=`${hour}:${minute}`;
 const lastMinute=Math.min(minutesOfDay(time)+reminderLeadMinutes,23*60+59);
 const cutoff=String(Math.floor(lastMinute/60)).padStart(2,'0')+':'+String(lastMinute%60).padStart(2,'0');
 return {date:`${year}-${month}-${day}`,time,cutoff};
}

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
export function normalizeNumber(value,country='55'){
 if(typeof value!=='string'||value.length>30||/[^\d\s()+.-]/.test(value))fail('Informe o WhatsApp do administrador com DDD e código do país.');
 let digits=value.replace(/\D/g,'');
 const international=value.trim().startsWith('+')||digits.startsWith('00');
 if(digits.startsWith('00'))digits=digits.slice(2);
 if(!international){
  if(country==='55'){
   if(digits.length===10||digits.length===11)digits=country+digits;
   else if(!digits.startsWith(country)||![12,13].includes(digits.length))fail('Informe um número brasileiro com DDD válido.');
  }else if(!(digits.startsWith(country)&&digits.length>10))digits=country+digits.replace(/^0/,'');
 }
 if(!/^[1-9]\d{7,14}$/.test(digits))fail('Informe o WhatsApp do administrador com DDD e código do país.');
 return digits;
}
function baseURL(value){
 if(/^\/swagger(?:\/index\.html)?\/?$/i.test(value))value=DEFAULT_URL+value;
 let url;try{url=new URL(value);}catch{fail('Informe a URL HTTPS do seu servidor Evolution Go.');}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.hostname==='localhost'||url.hostname.endsWith('.localhost')||url.hostname.endsWith('.local')||url.hostname.includes(':')||/^\d+(\.\d+){3}$/.test(url.hostname))fail('Use uma URL HTTPS pública para o servidor Evolution Go, sem usuário, senha ou parâmetros.');
 url.pathname=url.pathname.replace(/\/swagger(?:\/index\.html)?\/?$/i,'')||'/';
 return url.href.replace(/\/+$/,'');
}

function initializeOutbox(db){
 transaction(db,()=>{
  if(db.prepare('PRAGMA index_list(booking_notifications)').all().some(index=>index.name==='booking_notifications_by_role'))return;
  const columns=db.prepare('PRAGMA table_info(booking_notifications)').all();
  if(columns.length)db.exec('ALTER TABLE booking_notifications RENAME TO legacy_booking_notifications');
  db.exec(`CREATE TABLE booking_notifications(
   id TEXT PRIMARY KEY,
   booking_id INTEGER NOT NULL REFERENCES bookings(id),
   recipient TEXT NOT NULL,
   role TEXT NOT NULL DEFAULT 'arena',
   status TEXT NOT NULL,
   created_at TEXT NOT NULL,
   updated_at TEXT NOT NULL,
   error TEXT NOT NULL DEFAULT '',
   provider TEXT NOT NULL DEFAULT 'evolution'
  );
  CREATE UNIQUE INDEX booking_notifications_by_role ON booking_notifications(booking_id,role);`);
  if(!columns.length)return;
  const provider=columns.some(column=>column.name==='provider')?'provider':"'evolution'";
  db.exec(`INSERT INTO booking_notifications(id,booking_id,recipient,role,status,created_at,updated_at,error,provider)
   SELECT id,booking_id,recipient,role,status,created_at,updated_at,error,${provider} FROM legacy_booking_notifications;
   DROP TABLE legacy_booking_notifications;`);
 });
}

/** Per-arena settings and durable outbox. Neither is part of the system clone. */
export function bookingNotifications(db,{fetchImpl=fetch}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS notification_connection(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL,base_url TEXT NOT NULL,api_key TEXT NOT NULL,arena_number TEXT NOT NULL,country_code TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS notification_wuzapi(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL,base_url TEXT NOT NULL,api_key TEXT NOT NULL,arena_number TEXT NOT NULL,country_code TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS notification_webhook(id INTEGER PRIMARY KEY CHECK(id=1),url TEXT NOT NULL);`);
 initializeOutbox(db);
 db.exec(`CREATE INDEX IF NOT EXISTS bookings_confirmed_end ON bookings(date,end) WHERE status='confirmed';
 CREATE INDEX IF NOT EXISTS bookings_confirmed_start ON bookings(date,start) WHERE status='confirmed';
 DROP INDEX IF EXISTS booking_notifications_pending_clients;
 CREATE INDEX IF NOT EXISTS booking_notifications_pending_payments ON booking_notifications(created_at)
  WHERE status='pending' AND role IN ('client','client_deposit');`);
 const dueStarts=db.prepare(`SELECT b.id FROM bookings b
  WHERE b.status='confirmed' AND b.date=? AND b.start=? AND b.end>?
  AND NOT EXISTS(SELECT 1 FROM booking_notifications n WHERE n.booking_id=b.id AND n.role='arena_start')
  ORDER BY b.id`);
 const paidCustomer=db.prepare(`SELECT b.phone FROM bookings b WHERE b.id=? AND ${confirmedPayment}`);
 const depositedCustomer=db.prepare(`SELECT b.phone,s.amount_cents deposit_cents,
  CASE WHEN b.paid=1 THEN 0 ELSE b.total-s.amount_cents END remaining_cents
  FROM ${depositRecord} JOIN bookings b ON b.id=p.booking_id
  WHERE b.id=? AND b.status='confirmed' AND ${verifiedDeposit}`);
 const dueReminders=db.prepare(`SELECT b.id,b.phone,
  NOT EXISTS(SELECT 1 FROM booking_notifications n WHERE n.booking_id=b.id AND n.role='arena_reminder') AS arena_due,
  (${confirmedPayment}) AND NOT EXISTS(
   SELECT 1 FROM booking_notifications n WHERE n.booking_id=b.id AND n.role='reminder'
  ) AS client_due
  FROM bookings b
  WHERE b.status='confirmed' AND b.date=? AND b.start<=? AND b.end>? AND b.end<=?
  ORDER BY b.end,b.id`);
 const insertEvent=db.prepare(`INSERT INTO booking_notifications(id,booking_id,recipient,role,status,created_at,updated_at,error,provider)
  VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(booking_id,role) DO NOTHING`);
 // Earlier versions accepted the Swagger page as a base URL. Repair only
 // that stored address; preserve the instance token and notification settings.
 const legacy=db.prepare('SELECT base_url FROM notification_connection WHERE id=1').get();
 if(legacy?.base_url){
  let normalized;
  try{normalized=baseURL(legacy.base_url);}catch{}
  if(normalized&&normalized!==legacy.base_url)db.prepare('UPDATE notification_connection SET base_url=? WHERE id=1').run(normalized);
 }
 const providerFor=(id='evolution')=>{
  if(!Object.hasOwn(PROVIDERS,id))fail('Provedor de WhatsApp inválido.');
  return PROVIDERS[id];
 };
 const stored=(id='evolution')=>{
  const provider=providerFor(id);
  return db.prepare(`SELECT * FROM ${provider.table} WHERE id=1`).get()||{enabled:0,base_url:provider.url,api_key:'',arena_number:'',country_code:'55'};
 };
 const sendingProvider=()=>stored('wuzapi').enabled?'wuzapi':'evolution';
 const webhookURL=()=>db.prepare('SELECT url FROM notification_webhook WHERE id=1').get()?.url||'';
 const summary=(id='evolution')=>{const c=stored(id);return {enabled:!!c.enabled,base_url:c.base_url,token_configured:!!c.api_key,webhook_configured:id==='evolution'&&!!webhookURL(),target:'both',connection_ready:!!(c.base_url&&c.api_key),arena_number:c.arena_number,country_code:c.country_code,ready:!!(c.enabled&&c.base_url&&c.api_key&&c.arena_number)};};
 async function resolveWuzapiToken(adminToken,sessionId){
  if(typeof adminToken!=='string'||!adminToken||adminToken.length>2000||/[\s\x00-\x1f\x7f]/.test(adminToken))fail('Informe um token administrativo válido da WUZAPI.');
  let response;
  try{
   response=await fetchImpl(PROVIDERS.wuzapi.url+'/admin/users',{method:'GET',headers:{Authorization:adminToken},redirect:'manual',signal:AbortSignal.timeout(8000)});
  }catch{
   fail('Não foi possível consultar as sessões administrativas da WUZAPI.',502);
  }
  if(response.status===401||response.status===403)fail('A WUZAPI recusou o token administrativo.',502);
  if(!response.ok)fail(`A consulta administrativa da WUZAPI retornou HTTP ${response.status}.`,502);
  const result=await response.json().catch(()=>null);
  if(result?.success!==true||!Array.isArray(result.data))fail('A WUZAPI respondeu em um formato inesperado ao listar as sessões.',502);
  const id=sessionId.trim();
  const matches=id?result.data.filter(user=>user?.id===id):result.data;
  if(!matches.length)fail('Nenhuma sessão correspondente foi encontrada na WUZAPI.');
  if(matches.length!==1)fail('Informe o ID da sessão desejada. A WUZAPI retornou mais de uma sessão.');
  const token=matches[0]?.token;
  if(typeof token!=='string'||!token||token===adminToken||token.length>2000||/[\s\x00-\x1f\x7f]/.test(token))fail('A WUZAPI não retornou um token válido para a sessão selecionada.',502);
  return token;
 }
 async function save(body,id='evolution'){
  const provider=providerFor(id);
  if(typeof body.enabled!=='boolean'||(body.target!==undefined&&!['arena','both'].includes(body.target)))fail('As notificações são destinadas ao cliente da reserva e ao administrador.');
  const previous=stored(id);
  const country=body.country_code||previous.country_code||'55';
  if(typeof country!=='string'||!/^[1-9]\d{0,2}$/.test(country))fail('Informe um código de país válido, como 55.');
  let url=body.base_url??previous.base_url;
  if(typeof url!=='string'||url.length>2000)fail('Informe a URL HTTPS do servidor.');
  url=url.trim();
  if(id==='wuzapi'){
   if(url.replace(/\/$/,'')!==provider.url)fail('Use o servidor WUZAPI https://api.dallanspace.com.br.');
   url=provider.url;
  }else if(url)url=baseURL(url);
  const adminToken=id==='wuzapi'?body.admin_token??'':'';
  const sessionId=id==='wuzapi'?body.session_id??'':'';
  if(typeof sessionId!=='string'||sessionId.length>200)fail('Informe um ID de sessão válido da WUZAPI.');
  if(sessionId.trim()&&!adminToken)fail('Informe o token administrativo para selecionar outra sessão.');
  let token=body.api_key===''||body.api_key===undefined?previous.api_key:body.api_key;
  if(typeof token!=='string'||token.length>2000||/[\s\x00-\x1f\x7f]/.test(token))fail('Informe um token de instância válido, sem espaços ou quebras de linha.');
  let number=body.arena_number??previous.arena_number;
  if(typeof number!=='string')fail('Informe o WhatsApp do administrador.');
  number=number.trim();if(number&&(number!==previous.arena_number||country!==previous.country_code))number=normalizeNumber(number,country);
  if(adminToken!==''){
   token=await resolveWuzapiToken(adminToken,sessionId);
   if(JSON.stringify(stored(id))!==JSON.stringify(previous))fail('A configuração WUZAPI foi alterada durante a consulta. Tente novamente.',409);
  }
  if(body.enabled&&(!url||!token||!number))fail('Para ativar, informe o servidor, o token da instância e o WhatsApp do administrador.');
  transaction(db,()=>{
   db.prepare(`INSERT INTO ${provider.table} VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,base_url=excluded.base_url,api_key=excluded.api_key,arena_number=excluded.arena_number,country_code=excluded.country_code`).run(body.enabled?1:0,url,token,number,country);
   if(body.enabled){
    const other=providerFor(id==='evolution'?'wuzapi':'evolution');
    db.exec(`UPDATE ${other.table} SET enabled=0 WHERE id=1`);
   }
   if(id==='evolution'&&(url!==previous.base_url||token!==previous.api_key))db.exec('DELETE FROM notification_webhook');
  });
  return summary(id);
 }
 function recordEvent(bookingId,recipient,role,provider,status){
  const id=randomBytes(16).toString('hex');
  const now=new Date().toISOString();
  const error=recipient?'':'O telefone do cliente não é um número válido para envio pelo WhatsApp.';
  const result=insertEvent.run(id,bookingId,recipient,role,recipient?status:'failed',now,now,error,provider);
  return recipient&&result.changes?{id,booking_id:bookingId,recipient,role,provider}:null;
 }
 function customerNumber(phone,country){
  try{return normalizeNumber(phone,country);}catch{return '';}
 }
 function enqueue(bookingId){
  const provider=sendingProvider(),c=stored(provider);
  if(!c.enabled||!c.base_url||!c.api_key||!c.arena_number)return;
  recordEvent(bookingId,c.arena_number,'arena',provider,'pending');
 }
 function enqueueClientPayment(bookingId,role,eligibleCustomer){
  const provider=sendingProvider(),c=stored(provider);
  if(!c.enabled||!c.base_url||!c.api_key||!c.arena_number)return;
  const booking=eligibleCustomer.get(bookingId);
  if(!booking)return;
  const recipient=customerNumber(booking.phone,c.country_code);
  // Reuse a pending row with the current WhatsApp connection.
  const updated=db.prepare(`UPDATE booking_notifications SET recipient=?,provider=?,status=?,error=?,updated_at=?
   WHERE booking_id=? AND role=? AND status='pending'`)
   .run(recipient,provider,recipient?'pending':'failed',recipient?'':'O telefone do cliente não é um número válido para envio pelo WhatsApp.',new Date().toISOString(),bookingId,role);
  if(!updated.changes)recordEvent(bookingId,recipient,role,provider,'pending');
 }
 const enqueuePaidClient=bookingId=>enqueueClientPayment(bookingId,'client',paidCustomer);
 const enqueueDepositClient=bookingId=>enqueueClientPayment(bookingId,'client_deposit',depositedCustomer);
 function mark(id,status,error=''){
  db.prepare('UPDATE booking_notifications SET status=?,updated_at=?,error=? WHERE id=?').run(status,new Date().toISOString(),error,id);
 }
 function events(){
  const stale=new Date(Date.now()-30000).toISOString();
  db.prepare("UPDATE booking_notifications SET status='unknown',updated_at=?,error='O envio foi interrompido. Confira o provedor antes de tentar novamente.' WHERE status='sending' AND updated_at<?").run(new Date().toISOString(),stale);
  return db.prepare('SELECT id,booking_id,recipient,role,status,created_at,updated_at,error FROM booking_notifications ORDER BY created_at DESC,id DESC LIMIT 30').all();
 }
 function message(bookingId,role,deposit){
  const b=db.prepare('SELECT b.customer,b.phone,b.date,b.start,b.end,b.total,b.status,c.name court_name FROM bookings b JOIN courts c ON c.id=b.court_id WHERE b.id=?').get(bookingId);
  if(!b||b.status!=='confirmed')return null;
  const arenaName=branding(db).name;
  if(scheduledRoles.has(role)){
   const {date,time,cutoff}=alertWindow();
   if(b.date!==date||b.start>time||b.end<=time)return null;
   if(role==='arena_start'?b.start!==time:b.end>cutoff)return null;
   if(role==='reminder')return `⏳ *Seu horário está acabando!*
🏐 ${arenaName}

Olá, ${b.customer}!

🎟️ *Reserva #${bookingId}*
📍 *Quadra:* ${b.court_name}
🕒 *Término: ${b.end}*`;

   const title=role==='arena_start'?'▶️ *Horário iniciado!*':'⏳ *Horário da quadra terminando!*';
   const remaining=minutesOfDay(b.end)-minutesOfDay(time);
   return `${title}
🏐 ${arenaName} · Reserva #${bookingId}

📍 *Quadra:* ${b.court_name}
👤 *Cliente:* ${b.customer}
🕒 *Início:* ${b.start} · *Término:* ${b.end}
⏱️ *Tempo restante: ${remaining} ${remaining===1?'minuto':'minutos'}*`;
  }
  const date=new Date(b.date+'T12:00:00Z').toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'});
  const money=new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'});
  if(role==='client_deposit'){
   return `✅ *Entrada confirmada!*
🏐 ${arenaName}

Olá, ${b.customer}! Sua reserva #${bookingId} está confirmada.
📍 ${b.court_name}
📅 ${date} · ${b.start} às ${b.end}

💰 *Entrada recebida* ${money.format(deposit.deposit_cents/100)}
💳 *Saldo da quadra* ${money.format(deposit.remaining_cents/100)}`;
  }
  const amount=money.format(b.total/100);
  if(role==='client'){
   return `✅ *Reserva confirmada!*
🏐 ${arenaName}

Olá, ${b.customer}! 👋

🎟️ *Reserva #${bookingId}*
📍 *Quadra:* ${b.court_name}
📅 *Data:* ${date}
🕒 *Horário: ${b.start} às ${b.end}*

💰 *Valor da reserva: ${amount}*`;
  }
  return `🏐 *Novo agendamento*
${arenaName} · Reserva #${bookingId}

👤 *Cliente:* ${b.customer}
*Telefone:* ${b.phone}

📍 *Quadra:* ${b.court_name}
📅 *Data:* ${date}
🕒 *Horário:* ${b.start} às ${b.end}

💰 *Valor da reserva:* ${amount}

📋 Acompanhe a reserva e o pagamento no painel.`;
 }
 async function deliver(event){
  try{
   if(customerRoles.has(event.role)&&!paidCustomer.get(event.booking_id)){
    if(event.role==='client')mark(event.id,'pending');
    else mark(event.id,'failed','A confirmação do pagamento foi retirada antes do envio do lembrete.');
    return;
   }
   const deposit=event.role==='client_deposit'?depositedCustomer.get(event.booking_id):null;
   if(event.role==='client_deposit'&&!deposit){
    mark(event.id,'pending');
    return;
   }
   const provider=providerFor(event.provider),c=stored(event.provider),text=message(event.booking_id,event.role,deposit);
   if(!text||!c.enabled){
    const reason=scheduledRoles.has(event.role)
     ? 'O horário deste aviso passou, a reserva foi cancelada ou as notificações foram desativadas.'
     : 'Envio não realizado: a reserva ou as notificações foram desativadas.';
    mark(event.id,'failed',reason);
    return;
   }
   let response;
   try{
    const body=event.provider==='wuzapi'
     ? {Phone:event.recipient,Body:text,Id:event.id}
     : {number:event.recipient,text,id:event.id,formatJid:true};
    response=await fetchImpl(c.base_url+provider.send,{method:'POST',headers:{'Content-Type':'application/json',[provider.header]:c.api_key},body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(8000)});
   }catch{mark(event.id,'unknown','Não foi possível confirmar o envio. Confira o provedor antes de tentar novamente.');return;}
   if(!response.ok){
    const uncertain=response.status>=500||response.status===408||(response.status>=300&&response.status<400);
    mark(event.id,uncertain?'unknown':'failed',uncertain?`O provedor retornou HTTP ${response.status} sem confirmar o resultado. Confira o provedor antes de tentar novamente.`:`O provedor retornou HTTP ${response.status}. Verifique a conexão e a configuração.`);return;
   }
   let result;try{result=await response.json();}catch{mark(event.id,'unknown','A API respondeu sem confirmação válida. Confira o provedor.');return;}
   if(!(event.provider==='wuzapi'?result?.success===true:result?.message==='success')){mark(event.id,'unknown','A API não confirmou a aceitação da mensagem. Confira o provedor.');return;}
   mark(event.id,'accepted');
  }catch{
   // Do not fail a committed booking or expose provider errors/credentials.
  }
 }
 async function dispatchEvent(event){
  // Claim each recipient independently after the booking transaction commits.
  try{
   const claim=db.prepare(`UPDATE booking_notifications AS n SET status='sending',updated_at=? WHERE id=? AND EXISTS(
    SELECT 1 FROM bookings b WHERE b.id=n.booking_id AND ${eligiblePending}
   )`).run(new Date().toISOString(),event.id);
   if(claim.changes)await deliver(event);
  }catch{
   // Leave the event in the outbox if the claim could not be recorded.
  }
 }
 async function processBookingAlerts(){
  const provider=sendingProvider(),c=stored(provider);
  if(!c.enabled||!c.base_url||!c.api_key||!c.arena_number)return;
  const {date,time,cutoff}=alertWindow();
  // Claim before calling the provider. An interrupted send might already have
  // reached WhatsApp and must not be repeated automatically.
  const claimed=transaction(db,()=>{
   const events=dueStarts.all(date,time,time).map(b=>
    recordEvent(b.id,c.arena_number,'arena_start',provider,'sending')
   );
   for(const b of dueReminders.all(date,time,time,cutoff)){
    if(b.arena_due)events.push(recordEvent(b.id,c.arena_number,'arena_reminder',provider,'sending'));
    if(b.client_due)events.push(recordEvent(b.id,customerNumber(b.phone,c.country_code),'reminder',provider,'sending'));
   }
   return events.filter(Boolean);
  });
  for(let index=0;index<claimed.length;index+=alertBatchSize){
   await Promise.all(claimed.slice(index,index+alertBatchSize).map(deliver));
  }
  const confirmations=db.prepare(`SELECT n.* FROM booking_notifications n JOIN bookings b ON b.id=n.booking_id
   WHERE n.role IN ('client','client_deposit') AND ${eligiblePending} ORDER BY n.created_at LIMIT ?`).all(alertBatchSize);
  await Promise.all(confirmations.map(dispatchEvent));
 }
 async function dispatch(bookingId){
  try{
   const pending=db.prepare(`SELECT n.* FROM booking_notifications n JOIN bookings b ON b.id=n.booking_id
    WHERE n.booking_id=? AND ${eligiblePending}`).all(bookingId);
   await Promise.all(pending.map(dispatchEvent));
  }catch{
   // A failure reading the notification queue must not fail a saved booking.
  }
 }
 async function dispatchClientPayment(bookingId,role){
  try{
   const pending=db.prepare(`SELECT n.* FROM booking_notifications n JOIN bookings b ON b.id=n.booking_id
    WHERE n.booking_id=? AND n.role=? AND ${eligiblePending}`).get(bookingId,role);
   if(pending)await dispatchEvent(pending);
  }catch{
   // The periodic job can recover a confirmed payment's pending message.
  }
 }
 const dispatchPaidClient=bookingId=>dispatchClientPayment(bookingId,'client');
 const dispatchDepositClient=bookingId=>dispatchClientPayment(bookingId,'client_deposit');
 async function recoverPending(){
  const pending=db.prepare(`SELECT n.* FROM booking_notifications n JOIN bookings b ON b.id=n.booking_id
   WHERE ${eligiblePending} ORDER BY n.created_at LIMIT 3`).all();
  await Promise.all(pending.map(dispatchEvent));
  return events();
 }
 async function instanceData(path,timeout=8000,body,c=stored(),id='evolution'){
  const provider=providerFor(id);
  if(!c.base_url||!c.api_key)fail('Salve o endereço do servidor e o token da instância antes de conectar o WhatsApp.',409);
  let response;
  try{
   const request=body===undefined
    ? {method:'GET',headers:{[provider.header]:c.api_key}}
    : {method:'POST',headers:{[provider.header]:c.api_key,'Content-Type':'application/json'},body:JSON.stringify(body)};
   response=await fetchImpl(c.base_url+path,{...request,redirect:'manual',signal:AbortSignal.timeout(timeout)});
  }catch(error){
   const code=error?.cause?.code||error?.code||error?.cause?.errors?.[0]?.code;
   if(['TimeoutError','AbortError'].includes(error?.name)||['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT'].includes(code))fail(`A ${provider.name} não respondeu dentro do tempo limite. Verifique a disponibilidade do servidor e tente novamente.`,504);
   if(['ENOTFOUND','EAI_AGAIN'].includes(code))fail(`Não foi possível resolver o domínio da ${provider.name} (DNS). Confira a URL e o DNS do servidor.`,502);
   if(['CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','DEPTH_ZERO_SELF_SIGNED_CERT','ERR_TLS_CERT_ALTNAME_INVALID','UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(code))fail(`A conexão HTTPS da ${provider.name} falhou na validação do certificado TLS. Corrija o certificado do servidor.`,502);
   if(code==='ECONNREFUSED')fail(`O servidor ${provider.name} recusou a conexão. Verifique se o serviço está em execução e aceita conexões HTTPS.`,502);
   fail(`Não foi possível alcançar a ${provider.name}. Confira a URL HTTPS e a saída de rede do servidor que hospeda esta arena.`,502);
  }
  if(!response.ok){
   if(id==='wuzapi'&&path==='/session/connect'&&response.status===409)return {};
   if(id==='wuzapi'&&response.status===500&&['/session/status','/session/qr'].includes(path)){
    const result=await response.json().catch(()=>null);
    if(typeof result?.error==='string'){
     const reason=result.error.trim();
     if(/^(?:no session|not connected)$/i.test(reason))return null;
     if(path==='/session/qr'&&/^already logged in$/i.test(reason))return {alreadyLoggedIn:true};
    }
   }
   if(path==='/instance/qr'&&[400,500].includes(response.status)){
    const result=await response.json().catch(()=>null);
    if(typeof result?.error==='string'&&/^(?:no (?:qr code|client) available|no client found|(?:instance|client) (?:is )?not connected|client not found)\b/i.test(result.error))return null;
    if(result?.error==='session already logged in')return {alreadyLoggedIn:true};
   }
   if(response.status===401)fail(`A ${provider.name} recusou o token da instância (HTTP 401). Cadastre o token da instância correta, não a chave administrativa global.`,502);
   if(response.status===403)fail(`A ${provider.name} negou o acesso (HTTP 403). Verifique as permissões do token e as regras de acesso do servidor da API.`,502);
   if(response.status===404)fail(`A rota ${path} não foi encontrada na ${provider.name} (HTTP 404). Confira a URL base e a versão da API.`,502);
   if(response.status===429)fail(`A ${provider.name} atingiu o limite de consultas (HTTP 429). Aguarde antes de consultar novamente.`,502);
   const error=Object.assign(new Error(`A ${provider.name} retornou HTTP ${response.status} na rota ${path}. Verifique o serviço da API e a instância.`),{status:502,upstreamStatus:response.status});
   throw error;
  }
  let result;
  try{result=await response.json();}catch{fail(`A rota ${path} respondeu sem JSON válido. Confira se a URL aponta para a API em vez de uma página ou proxy de autenticação.`,502);}
  if(!(id==='wuzapi'?result?.success===true:result?.message==='success')||!result.data||typeof result.data!=='object')fail(`A ${provider.name} respondeu em um formato incompatível com a integração. Confira a versão da API.`,502);
  return result.data;
 }
 let instanceUpdateInProgress=false;
 async function updateInstance(action){
  if(instanceUpdateInProgress)fail('Já há uma atualização da instância em andamento. Aguarde e tente novamente.',409);
  instanceUpdateInProgress=true;
  try{return await action();}finally{instanceUpdateInProgress=false;}
 }
 async function syncWebhook(body){
  if(typeof body?.url!=='string'||body.url.length>2000)fail('Informe a URL HTTPS pública do webhook.');
  let url;
  try{url=new URL(body.url.trim());}catch{fail('Informe a URL HTTPS pública do webhook.');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||!url.hostname.includes('.')||url.hostname.endsWith('.localhost')||url.hostname.endsWith('.local')||/^\d+(\.\d+){3}$/.test(url.hostname))fail('Use uma URL HTTPS pública para o webhook, sem credenciais na URL ou fragmento.');
  const config=stored();
  return updateInstance(async()=>{
   const data=await instanceData('/instance/connect',8000,{webhookUrl:url.href,subscribe:WEBHOOK_EVENTS},config);
   if(data.webhookUrl!==url.href||data.eventString!==WEBHOOK_EVENTS.join(','))fail('A Evolution Go não confirmou a URL e os eventos do webhook.',502);
   const current=stored();
   if(current.base_url!==config.base_url||current.api_key!==config.api_key)fail('A instância foi alterada durante a sincronização. Confira a configuração e tente novamente.',409);
   db.prepare('INSERT INTO notification_webhook VALUES(1,?) ON CONFLICT(id) DO UPDATE SET url=excluded.url').run(url.href);
   return {webhook_configured:true};
  });
 }
 async function check(id='evolution',config=stored(id),probeQR=true){
  const provider=providerFor(id);
  let data;
  try{data=await instanceData(provider.status,8000,undefined,config,id);}
  catch(error){
   if(id!=='wuzapi'||!probeQR||error.upstreamStatus!==500)throw error;
   // The QR endpoint can prove an authenticated session even if status fails.
   const qr=await instanceData('/session/qr',8000,undefined,config,id).catch(()=>null);
   if(qr?.alreadyLoggedIn)return {connected:true,logged_in:true};
   throw error;
  }
  if(id==='wuzapi'&&!data)return {connected:false,logged_in:false};
  const connected=id==='wuzapi'?(data.connected??data.Connected):data.Connected;
  const logged_in=id==='wuzapi'?(data.loggedIn??data.LoggedIn):data.LoggedIn;
  if(typeof connected!=='boolean'||typeof logged_in!=='boolean')fail(`A ${provider.name} não confirmou a sessão. Verifique o token e a conexão.`,502);
  return {connected,logged_in};
 }
 async function connectWuzapi(){
  const id='wuzapi',config=stored(id);
  let session={connected:false,logged_in:false};
  try{session=await check(id,config,false);}
  catch(error){
   // A status failure must not block an explicit start on WUZAPI versions
   // that cannot report the state of a session before it is initialized.
   if(error.upstreamStatus!==500)throw error;
  }
  if(session.connected&&session.logged_in)return session;
  if(!session.connected)await updateInstance(()=>instanceData('/session/connect',8000,{Immediate:true},config,id));
  for(let attempt=0;attempt<3;attempt++){
   const data=await instanceData('/session/qr',8000,undefined,config,id);
   // WUZAPI emits this only when the client is connected and authenticated.
   if(data?.alreadyLoggedIn)return {connected:true,logged_in:true};
   if(data?.passkeyPending===true)return {...session,state:'additional_verification'};
   const code=data?.QRCode??data?.qrcode;
   if(code)return qrResult(session,code,'WUZAPI');
   if(attempt<2)await new Promise(resolve=>setTimeout(resolve,750));
  }
  return {...session,state:'qr_pending'};
 }
 async function connect(id='evolution'){
  if(id==='wuzapi')return connectWuzapi();
  const session=await check(id);
  // Prefer the QR endpoint, which starts the client on current Evolution Go
  // versions and preserves the instance's existing delivery settings.
  if(session.logged_in)return session;
  let data=await instanceData('/instance/qr',12000);
  if(data?.alreadyLoggedIn)return check();
  if(!data&&!session.connected){
   const latest=await check();
   if(latest.logged_in)return latest;
   if(!latest.connected)await updateInstance(()=>{
    const url=webhookURL();
    return instanceData('/instance/connect',8000,url?{webhookUrl:url,subscribe:WEBHOOK_EVENTS}:{});
   });
   data=await instanceData('/instance/qr',12000);
   if(data?.alreadyLoggedIn)return check();
  }
  if(!data)return {...session,state:'qr_pending'};
  if(!data.qrcode&&typeof data.passkeyStage==='string'&&data.passkeyStage)return {...session,state:'additional_verification'};
  return qrResult(session,data.qrcode,'Evolution Go');
 }
 function qrResult(session,code,provider){
  if(typeof code!=='string'||code.length>710000)fail(`A ${provider} não retornou um QR Code válido. Tente atualizar o código.`,502);
  const match=/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(code);
  if(!match)fail(`A ${provider} não retornou uma imagem PNG válida para o QR Code.`,502);
  const bytes=Buffer.from(match[1],'base64');
  if(bytes.length>512*1024||bytes.toString('base64')!==match[1]||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))fail('A Evolution Go não retornou um QR Code válido. Tente atualizar o código.',502);
  // QR codes rotate at the provider. This is a conservative display deadline,
  // not a guarantee of validity; the user may request a fresh code at any time.
  return {...session,qr_code:code,expires_at:new Date(Date.now()+20000).toISOString()};
 }
 return {summary,save,enqueue,dispatch,enqueuePaidClient,dispatchPaidClient,enqueueDepositClient,dispatchDepositClient,events,recoverPending,processBookingAlerts,check,connect,syncWebhook};
}
