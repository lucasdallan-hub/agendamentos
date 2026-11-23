import http from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { MercadoPago, paymentConfiguration, createPayments, verifyWebhook } from './payments.js';
import {createPix} from './pix.js';
import {Buffer} from 'node:buffer';
import {transaction} from './storage.js';
import {bookingNotifications,normalizeNumber} from './notifications.js';
import {publicCatalog} from './public-catalog.js';
import {createCourtPhotos,courtPhotoBodyLimit} from './court-photos.js';
import {financialSettings} from './financial-settings.js';
import {createMisticPay} from './misticpay.js';
import {createPdv,pdvOnlyCourtId} from './pdv.js';
import {createPdvReceipt} from './pdv-receipt.js';
import {initializeSystems,branding,saveBranding,setting,createChild} from './systems.js';

export function createApplication({db,paymentConfig=paymentConfiguration(),paymentClient=new MercadoPago(paymentConfig),serveStatic,sessionStore=new Map(),attemptStore=new Map(),cookieSecure=false,clientKey=req=>req.socket.remoteAddress,notificationFetch=fetch,misticpayFetch=fetch,misticpayEncryptionKey,misticpayManagedEncryptionKey,scheduleMisticpayConfirmation,keepNotificationAlive,receiptReader,keepReceiptAlive=keepNotificationAlive}={}) {
db.exec(`CREATE TABLE IF NOT EXISTS admin(id INTEGER PRIMARY KEY CHECK(id=1), salt TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS courts(id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, price INTEGER NOT NULL CHECK(price>0), active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS bookings(id INTEGER PRIMARY KEY, court_id INTEGER NOT NULL REFERENCES courts(id), customer TEXT NOT NULL, phone TEXT NOT NULL, date TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, total INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'confirmed', paid INTEGER NOT NULL DEFAULT 0, method TEXT, paid_at TEXT, notes TEXT NOT NULL DEFAULT '');`);
initializeSystems(db);
// The payment modules call these hooks only after the application is initialized.
function deliverNotification(delivery){
 if(keepNotificationAlive)keepNotificationAlive(delivery);
 else return delivery;
}
const paidClientNotification={
 enqueuePaidClient:id=>notifications.enqueuePaidClient(id),
 // Payment status responses can return while the Worker delivers a message.
 dispatchPaidClient:id=>deliverNotification(notifications.dispatchPaidClient(id)),
 enqueueDepositClient:id=>notifications.enqueueDepositClient(id),
 dispatchDepositClient:id=>deliverNotification(notifications.dispatchDepositClient(id))
};
const payments=createPayments(db,paymentConfig,paymentClient,paidClientNotification);
const financial=financialSettings(db,paymentConfig);
const arenaIdentity=setting(db,'identity');
const misticpay=createMisticPay(db,{
 fetchImpl:misticpayFetch,encryptionKey:misticpayEncryptionKey,managedEncryptionKey:misticpayManagedEncryptionKey,
 scope:arenaIdentity?`child:${arenaIdentity.slug}`:'main',scheduleConfirmation:scheduleMisticpayConfirmation,
 ...paidClientNotification
});
const pix=createPix(db,{...paidClientNotification,receiptReader});
const courtPhotos=createCourtPhotos(db);
const pdv=createPdv(db,{depositBalance:misticpay.depositBalance});
const pdvPix=misticpay.createPdvPix(pdv);
const notifications=bookingNotifications(db,{fetchImpl:notificationFetch});
const pdvLinkDeliveries=new Set();
const pdvReceiptDeliveries=new Set();
const pdvMoney=new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'});
const sessions = sessionStore;
const attempts = attemptStore;
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
const fail = (message, status=400) => { throw Object.assign(new Error(message), { status }); };
const str = (v, max=120) => typeof v === 'string' && v.trim().length && v.trim().length<=max ? v.trim() : fail('Preencha os campos obrigatórios corretamente.');
function courtPrice(value){
 const price=typeof value==='number'||typeof value==='string'?Number(value):NaN;
 if(!Number.isFinite(price)||price<1||price>100000)fail('Informe um valor por hora entre R$ 1 e R$ 100.000.');
 return Math.round(price*100);
}
const minutes = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? Number(t.slice(0,2))*60+Number(t.slice(3)) : fail('Horário inválido.');
function booking(body) {
 const court = db.prepare('SELECT * FROM courts WHERE id=? AND active=1 AND id<>?').get(Number(body.court_id),pdvOnlyCourtId);
 if(!court) fail('Selecione uma quadra ativa.');
 const customer=str(body.customer), phone=str(body.phone,30), date=str(body.date,10), start=str(body.start,5), end=str(body.end,5);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date) fail('Data inválida.');
 const duration=minutes(end)-minutes(start);
 if(duration<30) fail('A reserva deve durar pelo menos 30 minutos, no mesmo dia.');
 if(db.prepare("SELECT id FROM bookings WHERE court_id=? AND date=? AND status='confirmed' AND start<? AND end>?").get(court.id,date,end,start)) fail('Este horário já está reservado nesta quadra.',409);
 const total=Math.round(court.price*duration/60);
 const result=db.prepare('INSERT INTO bookings(court_id,customer,phone,date,start,end,total,notes) VALUES(?,?,?,?,?,?,?,?)').run(court.id,customer,phone,date,start,end,total,typeof body.notes==='string'?body.notes.slice(0,1000):'');
 const id=Number(result.lastInsertRowid);
 pdv.open(id);
 notifications.enqueue(id);
 return {id};
}
const catalog=publicCatalog(db,{book:booking,pix,payments,misticpay,paymentConfig,attempts,courtPhotos});
function sendCourtPhoto(res,route,publicView){
 const bytes=courtPhotos.image(Number(route[1]),route[2],publicView);
 res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'no-store','Content-Length':bytes.length,'Content-Security-Policy':"sandbox; default-src 'none'"});
 return res.end(bytes);
}
const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('X-Frame-Options','DENY');
 res.setHeader('Referrer-Policy','same-origin');
 res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
 try {
  const url=new URL(req.url,'http://localhost');
  if(!url.pathname.startsWith('/api/')) {
   if(req.method!=='GET') return json(res,405,{error:'Método não permitido.'});
   if(serveStatic)return serveStatic(req,res,url);
   return json(res,404,{error:'Não encontrado.'});
  }
  const misticWebhook=/^\/api\/misticpay\/webhook\/([a-f0-9]{64})$/.exec(url.pathname);
  const splitWebhook=/^\/api\/misticpay\/split-webhook\/([a-f0-9]{64})$/.exec(url.pathname);
  const pdvWebhook=/^\/api\/misticpay\/pdv-webhook\/([a-f0-9]{64})$/.exec(url.pathname);
  const requestOrigin=`${req.headers['x-forwarded-proto']==='https'?'https':'http'}://${req.headers.host}`;
  if(url.pathname!=='/api/payments/webhook' && !misticWebhook && !splitWebhook && !pdvWebhook && req.headers.origin && req.headers.origin!==requestOrigin) fail('Origem não permitida.',403);
  const courtGallery=/^\/api\/courts\/(\d+)\/photos$/.exec(url.pathname);
  let body={};
  if(['POST','PATCH','PUT'].includes(req.method)) { let raw=''; const maxBody=courtGallery&&req.method==='PUT'?courtPhotoBodyLimit:url.pathname==='/api/system/branding'?400000:/^\/api\/pix\/payments\/[a-f0-9]{64}\/receipt$/.test(url.pathname)?7*1024*1024:16000;for await(const chunk of req) { raw+=chunk; if(Buffer.byteLength(raw)>maxBody) fail('Requisição muito grande.',413); } try { body=JSON.parse(raw||'{}'); } catch { fail('JSON inválido.'); } if(!body||typeof body!=='object'||Array.isArray(body)) fail('Corpo inválido.'); }
  if(req.method==='POST'&&url.pathname==='/api/payments/webhook') {
   if(!paymentConfig.ready)fail('Integração não ativada.',503);
   if(!verifyWebhook({url,headers:req.headers,secret:paymentConfig.webhookSecret}))fail('Assinatura de notificação inválida.',401);
   if((body.type||url.searchParams.get('type'))!=='payment')return json(res,200,{ignored:true});
   const id=url.searchParams.get('data.id');
   if(body.data?.id!==undefined&&String(body.data.id).toLowerCase()!==id.toLowerCase())fail('Identificador da notificação inválido.',400);
   return json(res,200,await payments.reconcile(id));
  }
  if(req.method==='POST'&&misticWebhook)return json(res,200,await misticpay.webhook(misticWebhook[1],body));
  if(req.method==='POST'&&splitWebhook)return json(res,200,await misticpay.splitWebhook(splitWebhook[1],body));
  if(req.method==='POST'&&pdvWebhook)return json(res,200,await pdvPix.webhook(pdvWebhook[1],body));
  const token=/arena_session=([a-f0-9]+)/.exec(req.headers.cookie||'')?.[1];
  const authenticated=token && sessions.get(token)>Date.now();
  const publicPix=/^\/api\/pix\/payments\/([^/]+)(\/receipt)?$/.exec(url.pathname);
  if(publicPix){
   if(req.method==='GET'&&!publicPix[2])return json(res,200,pix.publicPayment(publicPix[1]));
   if(req.method==='POST'&&publicPix[2]){
    const saved=pix.upload(publicPix[1],body);
    if(saved.match_status!=='processing')return json(res,201,saved);
    const reading=pix.readReceipt(saved.id).catch(()=>console.warn('Não foi possível concluir a leitura do comprovante.'));
    if(keepReceiptAlive){keepReceiptAlive(reading);return json(res,201,saved);}
    await reading;
    return json(res,201,pix.receiptResult(saved.id)||saved);
   }
   fail('Método não permitido.',405);
  }
  const publicPhoto=/^\/api\/public\/courts\/(\d+)\/photos\/([a-f0-9]{32})$/.exec(url.pathname);
  if(publicPhoto&&req.method==='GET'){
   if(!catalog.settings().enabled)fail('Foto não encontrada.',404);
   return sendCourtPhoto(res,publicPhoto,true);
  }
  if(url.pathname==='/api/public/catalog'&&req.method==='GET')return json(res,200,catalog.catalog(url.searchParams.get('date'),url.searchParams.get('duration')||60));
  if(url.pathname==='/api/public/bookings'&&req.method==='POST'){
   const result=catalog.reserve(body,clientKey(req));
   await notifications.dispatch(result.reservation.id);
   return json(res,201,result);
  }
  const publicBooking=/^\/api\/public\/bookings\/([a-f0-9]{64})(?:\/(pix|checkout))?$/.exec(url.pathname);
  if(publicBooking){
   if(req.method==='GET'&&!publicBooking[2])return json(res,200,catalog.confirmation(publicBooking[1]));
   if(req.method==='POST'&&publicBooking[2])return json(res,200,await catalog.payment(publicBooking[1],publicBooking[2],body.payment_method));
  }
  const publicMistic=/^\/api\/public\/bookings\/([a-f0-9]{64})\/misticpay(\/check)?$/.exec(url.pathname);
  if(req.method==='GET'&&publicMistic&&!publicMistic[2]){
   const status=misticpay.status(catalog.reservationId(publicMistic[1]));
   if(!status)fail('Cobrança MisticPay não encontrada.',404);
   return json(res,200,{status});
  }
  if(req.method==='POST'&&publicMistic){
   const id=catalog.reservationId(publicMistic[1]);
   return json(res,200,publicMistic[2]?await misticpay.sync(id):await misticpay.create(id,body));
  }
  const publicSplit=/^\/api\/public\/bookings\/([a-f0-9]{64})\/split$/.exec(url.pathname);
  if(publicSplit){
   const id=catalog.reservationId(publicSplit[1]);
   if(req.method==='POST')return json(res,200,await misticpay.splitPlan(id,body.count,body.mode));
   if(req.method==='GET'){
    const result=misticpay.splitBooking(id,Number(url.searchParams.get('page')??1));
    if(!result)fail('Divisão Pix não encontrada.',404);
    return json(res,200,result);
   }
   if(req.method==='DELETE')return json(res,200,misticpay.cancelSplit(id));
   fail('Método não permitido.',405);
  }
  const publicShare=/^\/api\/public\/split\/([^/]+)(\/check)?$/.exec(url.pathname);
  if(publicShare){
   const [,shareToken,check]=publicShare;
   if(req.method==='GET')return json(res,200,check?{status:misticpay.shareStatus(shareToken)}:misticpay.share(shareToken));
   if(req.method==='POST')return json(res,200,check?await misticpay.syncShare(shareToken):await misticpay.createShare(shareToken,body));
   fail('Método não permitido.',405);
  }
  const publicPdvPayment=/^\/api\/public\/pdv\/payments\/([^/]+)(\/check)?$/.exec(url.pathname);
  if(publicPdvPayment){
   const [,paymentToken,check]=publicPdvPayment;
   if(!/^[a-f0-9]{64}$/.test(paymentToken))fail('Link de pagamento não encontrado.',404);
   if(req.method==='GET'&&!check)return json(res,200,pdvPix.read(paymentToken));
   if(req.method==='POST')return json(res,200,check?await pdvPix.check(paymentToken):await pdvPix.create(paymentToken,body));
   fail('Método não permitido.',405);
  }
  if(req.method==='GET'&&url.pathname==='/api/system/branding')return json(res,200,branding(db));
  if(req.method==='GET' && url.pathname==='/api/session') return json(res,200,{authenticated:!!authenticated,setup:!db.prepare('SELECT id FROM admin').get()});
  if(req.method==='POST' && ['/api/setup','/api/login'].includes(url.pathname)) {
   const key=clientKey(req), attempt=attempts.get(key);
   if(attempt && attempt.count>=10 && attempt.until>Date.now()) fail('Muitas tentativas. Aguarde 15 minutos.',429);
   const password=str(body.password,200); const admin=db.prepare('SELECT * FROM admin').get();
   if(url.pathname==='/api/setup') {
    if(admin) fail('Administrador já configurado.',409);
    if(password.length<10) fail('Use uma senha com pelo menos 10 caracteres.');
    const salt=randomBytes(16).toString('hex'); db.prepare('INSERT INTO admin VALUES(1,?,?)').run(salt,scryptSync(password,salt,64).toString('hex'));
   } else if((body.username!==undefined&&body.username!=='admin') || !admin || !timingSafeEqual(scryptSync(password,admin.salt,64),Buffer.from(admin.hash,'hex'))) {
    attempts.set(key,{count:attempt?.until>Date.now()?attempt.count+1:1,until:Date.now()+900000}); fail('Senha incorreta.',401);
   }
   attempts.delete(key); const session=randomBytes(32).toString('hex'); sessions.set(session,Date.now()+12*3600000);
   res.setHeader('Set-Cookie',`arena_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${cookieSecure?'; Secure':''}`);
   return json(res,200,{ok:true});
  }
  if(!authenticated) fail('Entre como administrador.',401);
  const bookingRoute=/^\/api\/bookings\/(\d+)(?:\/|$)/.exec(url.pathname);
  if(bookingRoute&&db.prepare("SELECT 1 FROM bookings WHERE id=? AND status='pdv'").get(Number(bookingRoute[1]))){
   fail('Agendamento não encontrado.',404);
  }
  const privateCourt=/^\/api\/courts\/(\d+)(?:\/|$)/.exec(url.pathname);
  if(privateCourt&&Number(privateCourt[1])===pdvOnlyCourtId)fail('Quadra não encontrada.',404);
  if(req.method==='GET'&&url.pathname==='/api/pdv')return json(res,200,pdv.daily(url.searchParams.get('date')??undefined));
  if(req.method==='POST'&&url.pathname==='/api/pdv/tabs')return json(res,201,pdv.openStandalone(body));
  if(req.method==='POST'&&url.pathname==='/api/pdv/tabs/archive')return json(res,200,pdv.archiveDay(body.date));
  const depositLink=/^\/api\/pdv\/tabs\/(\d+)\/deposit-balance\/send$/.exec(url.pathname);
  if(req.method==='POST'&&depositLink){
   const id=Number(depositLink[1]),tab=pdv.tab(id),balance=tab.booking_deposit_balance;
   if(!balance?.can_send)fail('O link do saldo da quadra está indisponível. Confira a situação da entrada e do saldo.',409);
   const deliveryKey=`deposit:${id}`;
   if(pdvLinkDeliveries.has(deliveryKey))fail('Já existe um envio em andamento para esta comanda.',409);
   const participantId=body.participant_id??null;
   const participant=participantId===null?null:tab.participants.find(person=>person.id===participantId);
   if(participantId!==null&&!participant)fail('Selecione uma pessoa cadastrada nesta comanda.',400);
   let phone=participant?.whatsapp;
   if(!participant){
    try{phone=normalizeNumber(db.prepare('SELECT phone FROM bookings WHERE id=?').get(id).phone);}
    catch{fail('O titular da reserva precisa ter um WhatsApp válido com DDD.');}
   }
   const send=notifications.preparePdvLinkDelivery(phone);
   // Renew the reservation link when expired so the signed balance link can still be opened.
   catalog.misticpayLink(id);
   const share=misticpay.splitBooking(id).shares.find(part=>part.index===2);
   const paymentUrl=new URL(share.path,requestOrigin).href;
   const amount=pdvMoney.format(balance.amount_cents/100);
   pdvLinkDeliveries.add(deliveryKey);
   try{
    await send(`Olá, ${participant?.name??tab.customer}! 👋

🧾 *Comanda #${id}*
📍 *Quadra:* ${tab.court_name}
💰 *Saldo da quadra:* ${amount}

📲 *Pague o saldo por Pix pelo link abaixo*
${paymentUrl}`);
   }finally{
    pdvLinkDeliveries.delete(deliveryKey);
   }
   return json(res,200,pdv.tab(id));
  }
  const pdvReceipt=/^\/api\/pdv\/tabs\/(\d+)(?:\/participants\/(\d+))?\/receipt\/send$/.exec(url.pathname);
  if(req.method==='POST'&&pdvReceipt){
   const bookingId=Number(pdvReceipt[1]),participantId=pdvReceipt[2]===undefined?undefined:Number(pdvReceipt[2]);
   const deliveryKey=`${bookingId}/${participantId??''}`;
   if(pdvReceiptDeliveries.has(deliveryKey))fail('Já existe um envio de comprovante em andamento.',409);
   const receipt=pdv.receipt(bookingId,participantId);
   const send=notifications.preparePdvReceiptDelivery(receipt.phone);
   const suffix=participantId===undefined?'':`-subcomanda-${participantId}`;
   pdvReceiptDeliveries.add(deliveryKey);
   try{
    const bytes=await createPdvReceipt(receipt,branding(db).name);
    await send(bytes,`comprovante-comanda-${bookingId}${suffix}.pdf`);
   }finally{
    pdvReceiptDeliveries.delete(deliveryKey);
   }
   return json(res,200,pdv.tab(bookingId));
  }
  if(req.method==='POST'&&url.pathname==='/api/pdv/products')return json(res,201,pdv.createProduct(body));
  const pdvProduct=/^\/api\/pdv\/products\/(\d+)$/.exec(url.pathname);
  if(req.method==='PATCH'&&pdvProduct)return json(res,200,pdv.updateProduct(Number(pdvProduct[1]),body));
  const pdvPaymentLink=/^\/api\/pdv\/tabs\/(\d+)\/participants\/(\d+)\/payment-link(\/send)?$/.exec(url.pathname);
  if(pdvPaymentLink){
   const bookingId=Number(pdvPaymentLink[1]),participantId=Number(pdvPaymentLink[2]);
   const deliveryKey=`${bookingId}/${participantId}`;
   if(pdvPaymentLink[3]){
    if(req.method!=='POST')fail('Método não permitido.',405);
    if(pdvLinkDeliveries.has(deliveryKey))fail('Já existe um envio em andamento para esta pessoa.',409);
    const tab=pdv.tab(bookingId),person=tab.participants.find(row=>row.id===participantId);
    if(!person)fail('Participante não encontrado nesta comanda.',404);
    if(tab.status!=='open'||person.status!=='open'||person.payment_link?.status==='review'){
     fail('Esta subcomanda não está disponível para envio do link Pix.',409);
    }
    const send=notifications.preparePdvLinkDelivery(person.whatsapp);
    const link=pdvPix.openLink(bookingId,participantId,body.expected_cents);
    const paymentUrl=new URL(link.path,requestOrigin).href;
    const amount=pdvMoney.format(link.amount_cents/100);
    pdvLinkDeliveries.add(deliveryKey);
    try{
     await send(`Olá, ${person.name}! 👋

🧾 *Comanda #${bookingId}*
📍 ${tab.standalone?'*Comanda avulsa*':`*Quadra:* ${tab.court_name}`}
💰 *Sua parte:* ${amount}

📲 *Pague por Pix pelo link abaixo*
${paymentUrl}

✅ Após a confirmação do pagamento, seu recibo fica disponível no mesmo link.`);
    }finally{
     pdvLinkDeliveries.delete(deliveryKey);
    }
    return json(res,200,pdv.tab(bookingId));
   }
   if(req.method==='POST')await pdvPix.openLink(bookingId,participantId,body.expected_cents);
   else if(req.method==='DELETE'){
    if(pdvLinkDeliveries.has(deliveryKey))fail('Aguarde o envio do link antes de cancelar.',409);
    pdvPix.cancelLink(bookingId,participantId);
   }
   else fail('Método não permitido.',405);
   return json(res,200,pdv.tab(bookingId));
  }
  const pdvParticipant=/^\/api\/pdv\/tabs\/(\d+)\/participants(?:\/(\d+)(\/payment)?)?$/.exec(url.pathname);
  if(pdvParticipant){
   const [,bookingId,participantId,payment]=pdvParticipant;
   const id=Number(bookingId),participant=Number(participantId);
   if(req.method==='POST'&&!participantId)return json(res,201,pdv.addParticipant(id,body));
   if(req.method==='POST'&&payment)return json(res,200,pdv.payParticipant(id,participant,body));
   if(participantId&&!payment){
    if(req.method==='PATCH')return json(res,200,pdv.updateParticipant(id,participant,body));
    if(req.method==='DELETE')return json(res,200,pdv.removeParticipant(id,participant));
   }
   fail('Método não permitido.',405);
  }
  const pdvTab=/^\/api\/pdv\/tabs\/(\d+)(?:\/(items|close)(?:\/(\d+))?)?$/.exec(url.pathname);
  if(pdvTab){
   const [,bookingId,action,itemId]=pdvTab;
   const id=Number(bookingId);
   if(req.method==='GET'&&!action)return json(res,200,pdv.tab(id));
   if(req.method==='POST'&&action==='items'&&!itemId)return json(res,201,pdv.addItem(id,body));
   if(action==='items'&&itemId){
    if(req.method==='PATCH')return json(res,200,pdv.updateItem(id,Number(itemId),body));
    if(req.method==='DELETE')return json(res,200,pdv.removeItem(id,Number(itemId)));
   }
   if(req.method==='POST'&&action==='close'&&!itemId){
    const {tab,closedAt}=pdv.close(id,body);
    if(!closedAt||tab.booking_status!=='confirmed')return json(res,200,tab);
    let closing_notice='accepted';
    try{
     const bookingReceived=misticpay.splitSummary(id)?.paid_cents??tab.booking_received_cents;
     const receipt=pdv.closingReceipt(tab,closedAt,bookingReceived);
     const send=notifications.preparePdvReceiptDelivery(receipt.phone);
     const total=pdvMoney.format(receipt.amount/100);
     const pending=receipt.closure.pending;
     const status=pending>0
      ? `Ainda há ${pdvMoney.format(pending/100)} em aberto.`
      : 'Tudo certo. Os pagamentos estão confirmados!';
     await send(await createPdvReceipt(receipt,branding(db).name),`fechamento-comanda-${id}.pdf`,
      `Olá, ${receipt.name}! 👋\n\n🧾 A comanda #${id} foi fechada.\n💰 Total recebido: ${total}\n${status}\n\n📎 Confira os detalhes no PDF em anexo.`);
    }catch{
     closing_notice='failed';
    }
    return json(res,200,{...tab,closing_notice});
   }
   fail('Método não permitido.',405);
  }
  const whatsappProvider=url.searchParams.get('provider')??'evolution';
  if(url.pathname==='/api/notifications/config'){
   if(req.method==='GET')return json(res,200,notifications.summary(whatsappProvider));
   if(req.method==='PUT')return json(res,200,await notifications.save(body,whatsappProvider));
  }
  if(url.pathname==='/api/notifications/events'&&req.method==='GET')return json(res,200,await notifications.recoverPending());
  if(url.pathname==='/api/notifications/webhook'&&req.method==='POST')return json(res,200,await notifications.syncWebhook(body));
  if(url.pathname==='/api/notifications/connect'&&req.method==='POST')return json(res,200,await notifications.connect(whatsappProvider));
  if(url.pathname==='/api/notifications/check'&&req.method==='POST')return json(res,200,await notifications.check(whatsappProvider));
  if(url.pathname==='/api/catalog/settings'){
   if(req.method==='GET')return json(res,200,catalog.settings());
   if(req.method==='PUT')return json(res,200,catalog.saveSettings(body));
  }
  if(url.pathname==='/api/system/domain'&&req.method==='PUT'){
   if(!setting(db,'identity')||!db.systemDomainUpdater)fail('Esta opção está disponível no sistema filho.',403);
   return json(res,200,await db.systemDomainUpdater(body.hostname));
  }
  if(url.pathname==='/api/system/branding'&&req.method==='PUT')return json(res,200,saveBranding(db,body));
  if(url.pathname==='/api/systems'){
   if(setting(db,'identity'))fail('Somente o sistema mãe pode gerenciar sistemas filhos.',403);
   if(req.method==='GET')return json(res,200,db.prepare('SELECT * FROM child_systems ORDER BY created_at DESC,slug').all());
   if(req.method==='POST')return json(res,201,await createChild(db,body,req.headers.host?.split(':')[0]));
  }
  if(url.pathname==='/api/pix/settings'){
   if(req.method==='GET')return json(res,200,pix.settings());
   if(req.method==='PUT')return json(res,200,pix.saveSettings(body));
  }
  const pixBooking=/^\/api\/bookings\/(\d+)\/(pix-link|receipts)$/.exec(url.pathname);
  if(pixBooking){if(req.method==='POST'&&pixBooking[2]==='pix-link')return json(res,200,pix.createLink(Number(pixBooking[1])));if(req.method==='GET'&&pixBooking[2]==='receipts')return json(res,200,pix.list(Number(pixBooking[1])));}
  const receiptRoute=/^\/api\/receipts\/(\d+)\/(file|review)$/.exec(url.pathname);
  if(receiptRoute){
   if(req.method==='POST'&&receiptRoute[2]==='review')return json(res,200,await pix.review(Number(receiptRoute[1]),body));
   if(req.method==='GET'&&receiptRoute[2]==='file'){const file=pix.file(Number(receiptRoute[1]));const ext={'image/png':'png','image/jpeg':'jpg','application/pdf':'pdf'}[file.mime_type];res.writeHead(200,{'Content-Type':file.mime_type,'Content-Disposition':`${ext==='pdf'?'attachment':'inline'}; filename="comprovante-${file.id}.${ext}"`,'Cache-Control':'no-store','Content-Security-Policy':"sandbox; default-src 'none'"});return res.end(file.content);}
  }
  if(url.pathname==='/api/payments/config'){
   if(req.method==='GET')return json(res,200,financial.summary());
   if(req.method==='PUT'){
    const next=financial.candidate(body);
    const account=await new MercadoPago(next,paymentClient.fetch).getAccount();
    if(financial.hasOrders()){
     const current=await paymentClient.getAccount();
     if(String(current.id)!==String(account.id)||paymentConfig.mode!==next.mode)fail('Esta arena já possui cobranças. Mantenha a mesma conta e ambiente para preservar a conciliação.',409);
    }
    return json(res,200,financial.save(next,account.id));
   }
  }
  if(url.pathname==='/api/misticpay/config'){
   if(req.method==='GET')return json(res,200,await misticpay.configuration());
   if(req.method==='PUT')return json(res,200,await misticpay.saveSettings(body,requestOrigin));
  }
  if(req.method==='POST'&&url.pathname==='/api/misticpay/config/verify')return json(res,200,await misticpay.verify(body));
  const misticBooking=/^\/api\/bookings\/(\d+)\/(misticpay-link|sync-misticpay)$/.exec(url.pathname);
  if(req.method==='POST'&&misticBooking){
   const id=Number(misticBooking[1]);
   return json(res,200,misticBooking[2]==='misticpay-link'?catalog.misticpayLink(id):await misticpay.sync(id));
  }
  const checkoutMatch=/^\/api\/bookings\/(\d+)\/(checkout|sync-payment)$/.exec(url.pathname);
  if(req.method==='POST'&&checkoutMatch){const id=Number(checkoutMatch[1]);return json(res,200,checkoutMatch[2]==='checkout'?await payments.checkout(id,body.payment_method):await payments.sync(id));}
  if(req.method==='POST' && url.pathname==='/api/logout') { sessions.delete(token); res.setHeader('Set-Cookie','arena_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return json(res,200,{ok:true}); }
  if(courtGallery&&req.method==='PUT')return json(res,200,courtPhotos.save(Number(courtGallery[1]),body));
  const adminPhoto=/^\/api\/courts\/(\d+)\/photos\/([a-f0-9]{32})$/.exec(url.pathname);
  if(adminPhoto&&req.method==='GET')return sendCourtPhoto(res,adminPhoto,false);
  if(req.method==='GET' && url.pathname==='/api/courts'){
   const courts=db.prepare('SELECT * FROM courts WHERE id<>? ORDER BY id').all(pdvOnlyCourtId);
   return json(res,200,courts.map(court=>({...court,photos:courtPhotos.list(court.id)})));
  }
  if(req.method==='POST' && url.pathname==='/api/courts') {
   const result=db.prepare('INSERT INTO courts(name,type,price) VALUES(?,?,?)').run(str(body.name,80),str(body.type,40),courtPrice(body.price));
   return json(res,201,{id:Number(result.lastInsertRowid)});
  }
  const courtMatch=/^\/api\/courts\/(\d+)$/.exec(url.pathname);
  if(req.method==='PATCH' && courtMatch){
   const name=Object.hasOwn(body,'name')?str(body.name,80):null;
   const type=Object.hasOwn(body,'type')?str(body.type,40):null;
   const price=Object.hasOwn(body,'price')?courtPrice(body.price):null;
   let active=null;
   if(Object.hasOwn(body,'active')){
    if(typeof body.active!=='boolean')fail('Estado inválido.');
    active=Number(body.active);
   }
   if(name===null&&type===null&&price===null&&active===null)fail('Informe os dados da quadra para atualizar.');
   const result=db.prepare(`UPDATE courts SET name=COALESCE(?,name),type=COALESCE(?,type),
    price=COALESCE(?,price),active=COALESCE(?,active) WHERE id=?`).run(name,type,price,active,Number(courtMatch[1]));
   if(!result.changes)fail('Quadra não encontrada.',404);
   return json(res,200,{ok:true});
  }
  if(req.method==='GET' && url.pathname==='/api/bookings'){
   await misticpay.resumeConfirmations().catch(()=>console.warn('MisticPay: não foi possível agendar a conciliação.'));
   return json(res,200,db.prepare(`SELECT b.*,c.name court_name,c.type court_type,o.state online_status,o.checkout_url,o.expires_at,o.checkout_method,
   EXISTS(SELECT 1 FROM archived_payment_orders a WHERE a.order_id=o.id) online_archived,
   EXISTS(SELECT 1 FROM pix_links p WHERE p.booking_id=b.id) pix_link,
   r.status receipt_status,r.match_status receipt_match,r.amount_cents receipt_amount,
   CASE WHEN m.archived=1 THEN 'archived' ELSE m.state END misticpay_status,
   s.share_count split_count,s.archived split_archived,s.mode split_mode,
   CASE WHEN s.archived=1 THEN s.archived_paid_count ELSE
    (SELECT COUNT(*) FROM misticpay_split_shares c WHERE c.booking_id=s.booking_id AND c.state='approved') END split_paid_count,
   CASE WHEN s.archived=1 THEN s.archived_paid_cents ELSE
    (SELECT COALESCE(SUM(c.amount_cents),0) FROM misticpay_split_shares c WHERE c.booking_id=s.booking_id AND c.state='approved') END split_paid_cents,
   s.mode='deposit' AND s.archived=0 AND EXISTS(SELECT 1 FROM misticpay_split_shares c
    WHERE c.booking_id=s.booking_id AND c.share_index=1 AND c.state='approved') deposit_confirmed
   FROM bookings b JOIN courts c ON c.id=b.court_id
   LEFT JOIN payment_orders o ON o.booking_id=b.id
   LEFT JOIN misticpay_orders m ON m.booking_id=b.id
   LEFT JOIN misticpay_split_plans s ON s.booking_id=b.id
   LEFT JOIN pix_receipts r ON r.id=(SELECT id FROM pix_receipts WHERE booking_id=b.id ORDER BY id DESC LIMIT 1)
   WHERE b.status<>'pdv' ORDER BY date,start,b.id`).all());
  }
  if(req.method==='POST' && url.pathname==='/api/bookings'){
   const result=transaction(db,()=>booking(body));
   await notifications.dispatch(result.id);
   return json(res,201,result);
  }
  const match=/^\/api\/bookings\/(\d+)\/(payment|cancel)$/.exec(url.pathname);
  if(req.method==='POST' && match) {
   const bookingId=Number(match[1]),registerPayment=match[2]==='payment';
   transaction(db,()=>{
    const b=db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId); if(!b) fail('Agendamento não encontrado.',404);
    if(b.status==='cancelled') fail('Agendamento cancelado.');
    if(misticpay.splitSummary(b.id))fail('Esta reserva possui uma divisão Pix. Gerencie as cotas antes de alterar a reserva.',409);
    if(db.prepare('SELECT 1 FROM misticpay_orders WHERE booking_id=?').get(b.id))fail('Esta reserva possui cobrança MisticPay. Consulte a cobrança antes de alterar a reserva.',409);
    if(db.prepare('SELECT id FROM payment_orders WHERE booking_id=?').get(b.id)) fail('Esta reserva possui cobrança online. Gerencie o pagamento ou estorno no Mercado Pago antes de alterar a reserva.',409);
    if(registerPayment&&db.prepare('SELECT booking_id FROM pix_links WHERE booking_id=?').get(b.id))fail('Analise o comprovante Pix antes de confirmar o recebimento.',409);
    if(!registerPayment&&db.prepare("SELECT id FROM pix_receipts WHERE booking_id=? AND status='pending'").get(b.id))fail('Analise o comprovante pendente antes de cancelar a reserva.',409);
    if(registerPayment){
     if(b.paid)fail('Pagamento já registrado.',409);
     if(!['Pix','Dinheiro','Cartão','Transferência'].includes(body.method))fail('Selecione a forma de pagamento.');
     db.prepare('UPDATE bookings SET paid=1,method=?,paid_at=? WHERE id=?').run(body.method,new Date().toISOString(),b.id);
     notifications.enqueuePaidClient(bookingId);
    }
    else { if(b.paid) fail('Não é possível cancelar uma reserva paga. Resolva o estorno antes de cancelar.'); db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(b.id); }
   });
   if(registerPayment)await paidClientNotification.dispatchPaidClient(bookingId);
   return json(res,200,{ok:true});
  }
  return json(res,404,{error:'Não encontrado.'});
 } catch(error) { if(!error.status) console.error(error); return json(res,error.status||500,{error:error.status?error.message:'Erro interno do servidor.'}); }
});
return {server,db,retryMisticpayConfirmations:misticpay.retryConfirmations,drainSplitChecks:misticpay.drainSplitChecks,processBookingAlerts:notifications.processBookingAlerts,processReceiptReads:pix.processReceiptReads};
}
