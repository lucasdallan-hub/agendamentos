import http from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { MercadoPago, paymentConfiguration, createPayments, verifyWebhook } from './payments.js';
import {createPix} from './pix.js';
import {Buffer} from 'node:buffer';
import {publicCatalog} from './public-catalog.js';
import {financialSettings} from './financial-settings.js';
import {initializeSystems,branding,saveBranding,setting,createChild} from './systems.js';

export function createApplication({db,receiptReader,ocrReady=false,manualReceiptReview=false,paymentConfig=paymentConfiguration(),paymentClient=new MercadoPago(paymentConfig),serveStatic,sessionStore=new Map(),attemptStore=new Map(),cookieSecure=false,clientKey=req=>req.socket.remoteAddress}={}) {
db.exec(`CREATE TABLE IF NOT EXISTS admin(id INTEGER PRIMARY KEY CHECK(id=1), salt TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS courts(id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, price INTEGER NOT NULL CHECK(price>0), active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS bookings(id INTEGER PRIMARY KEY, court_id INTEGER NOT NULL REFERENCES courts(id), customer TEXT NOT NULL, phone TEXT NOT NULL, date TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, total INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'confirmed', paid INTEGER NOT NULL DEFAULT 0, method TEXT, paid_at TEXT, notes TEXT NOT NULL DEFAULT '');`);
initializeSystems(db);
const payments=createPayments(db,paymentConfig,paymentClient);
const financial=financialSettings(db,paymentConfig);
const pix=createPix(db,{receiptReader,ocrReady,manualReceiptReview});
const sessions = sessionStore;
const attempts = attemptStore;
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
const fail = (message, status=400) => { throw Object.assign(new Error(message), { status }); };
const str = (v, max=120) => typeof v === 'string' && v.trim().length && v.trim().length<=max ? v.trim() : fail('Preencha os campos obrigatórios corretamente.');
const minutes = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? Number(t.slice(0,2))*60+Number(t.slice(3)) : fail('Horário inválido.');
function booking(body) {
 const court = db.prepare('SELECT * FROM courts WHERE id=? AND active=1').get(Number(body.court_id));
 if(!court) fail('Selecione uma quadra ativa.');
 const customer=str(body.customer), phone=str(body.phone,30), date=str(body.date,10), start=str(body.start,5), end=str(body.end,5);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date) fail('Data inválida.');
 const duration=minutes(end)-minutes(start);
 if(duration<30) fail('A reserva deve durar pelo menos 30 minutos, no mesmo dia.');
 if(db.prepare("SELECT id FROM bookings WHERE court_id=? AND date=? AND status='confirmed' AND start<? AND end>?").get(court.id,date,end,start)) fail('Este horário já está reservado nesta quadra.',409);
 const total=Math.round(court.price*duration/60);
 const result=db.prepare('INSERT INTO bookings(court_id,customer,phone,date,start,end,total,notes) VALUES(?,?,?,?,?,?,?,?)').run(court.id,customer,phone,date,start,end,total,typeof body.notes==='string'?body.notes.slice(0,1000):'');
 return {id:Number(result.lastInsertRowid)};
}
const catalog=publicCatalog(db,{book:booking,pix,payments,paymentConfig,attempts});
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
  if(url.pathname!=='/api/payments/webhook' && req.headers.origin && req.headers.origin!==`${req.headers['x-forwarded-proto']==='https'?'https':'http'}://${req.headers.host}`) fail('Origem não permitida.',403);
  let body={};
  if(['POST','PATCH','PUT'].includes(req.method)) { let raw=''; const maxBody=url.pathname==='/api/system/branding'?400000:/^\/api\/pix\/payments\/[a-f0-9]{64}\/receipt$/.test(url.pathname)?7*1024*1024:16000;for await(const chunk of req) { raw+=chunk; if(Buffer.byteLength(raw)>maxBody) fail('Requisição muito grande.',413); } try { body=JSON.parse(raw||'{}'); } catch { fail('JSON inválido.'); } if(!body||typeof body!=='object'||Array.isArray(body)) fail('Corpo inválido.'); }
  if(req.method==='POST'&&url.pathname==='/api/payments/webhook') {
   if(!paymentConfig.ready)fail('Integração não ativada.',503);
   if(!verifyWebhook({url,headers:req.headers,secret:paymentConfig.webhookSecret}))fail('Assinatura de notificação inválida.',401);
   if((body.type||url.searchParams.get('type'))!=='payment')return json(res,200,{ignored:true});
   const id=url.searchParams.get('data.id');
   if(body.data?.id!==undefined&&String(body.data.id).toLowerCase()!==id.toLowerCase())fail('Identificador da notificação inválido.',400);
   return json(res,200,await payments.reconcile(id));
  }
  const token=/arena_session=([a-f0-9]+)/.exec(req.headers.cookie||'')?.[1];
  const authenticated=token && sessions.get(token)>Date.now();
  const publicPix=/^\/api\/pix\/payments\/([^/]+)(\/receipt)?$/.exec(url.pathname);
  if(publicPix){
   if(req.method==='GET'&&!publicPix[2])return json(res,200,pix.publicPayment(publicPix[1]));
   if(req.method==='POST'&&publicPix[2])return json(res,201,await pix.upload(publicPix[1],body));
   fail('Método não permitido.',405);
  }
  if(url.pathname==='/api/public/catalog'&&req.method==='GET')return json(res,200,catalog.catalog(url.searchParams.get('date'),url.searchParams.get('duration')||60));
  if(url.pathname==='/api/public/bookings'&&req.method==='POST')return json(res,201,catalog.reserve(body,clientKey(req)));
  const publicBooking=/^\/api\/public\/bookings\/([a-f0-9]{64})(?:\/(pix|checkout))?$/.exec(url.pathname);
  if(publicBooking){
   if(req.method==='GET'&&!publicBooking[2])return json(res,200,catalog.confirmation(publicBooking[1]));
   if(req.method==='POST'&&publicBooking[2])return json(res,200,await catalog.payment(publicBooking[1],publicBooking[2]));
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
   if(req.method==='POST'&&receiptRoute[2]==='review')return json(res,200,pix.review(Number(receiptRoute[1]),body));
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
  const checkoutMatch=/^\/api\/bookings\/(\d+)\/(checkout|sync-payment)$/.exec(url.pathname);
  if(req.method==='POST'&&checkoutMatch){const id=Number(checkoutMatch[1]);if(checkoutMatch[2]==='checkout'&&db.prepare('SELECT booking_id FROM pix_links WHERE booking_id=?').get(id))fail('Esta reserva possui um link Pix direto. Use o fluxo Pix existente.',409);return json(res,200,checkoutMatch[2]==='checkout'?await payments.checkout(id):await payments.sync(id));}
  if(req.method==='POST' && url.pathname==='/api/logout') { sessions.delete(token); res.setHeader('Set-Cookie','arena_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return json(res,200,{ok:true}); }
  if(req.method==='GET' && url.pathname==='/api/courts') return json(res,200,db.prepare('SELECT * FROM courts ORDER BY id').all());
  if(req.method==='POST' && url.pathname==='/api/courts') {
   const price=Number(body.price); if(!Number.isFinite(price)||price<1||price>100000) fail('Informe um valor por hora entre R$ 1 e R$ 100.000.');
   const result=db.prepare('INSERT INTO courts(name,type,price) VALUES(?,?,?)').run(str(body.name,80),str(body.type,40),Math.round(price*100)); return json(res,201,{id:Number(result.lastInsertRowid)});
  }
  const courtMatch=/^\/api\/courts\/(\d+)$/.exec(url.pathname);
  if(req.method==='PATCH' && courtMatch) { if(typeof body.active!=='boolean') fail('Estado inválido.'); const r=db.prepare('UPDATE courts SET active=? WHERE id=?').run(body.active?1:0,Number(courtMatch[1])); if(!r.changes) fail('Quadra não encontrada.',404); return json(res,200,{ok:true}); }
  if(req.method==='GET' && url.pathname==='/api/bookings') return json(res,200,db.prepare('SELECT b.*, c.name court_name,c.type court_type,o.state online_status,o.checkout_url,o.expires_at,EXISTS(SELECT 1 FROM archived_payment_orders a WHERE a.order_id=o.id) online_archived,EXISTS(SELECT 1 FROM pix_links p WHERE p.booking_id=b.id) pix_link,r.status receipt_status,r.match_status receipt_match,r.amount_cents receipt_amount FROM bookings b JOIN courts c ON c.id=b.court_id LEFT JOIN payment_orders o ON o.booking_id=b.id LEFT JOIN pix_receipts r ON r.id=(SELECT id FROM pix_receipts WHERE booking_id=b.id ORDER BY id DESC LIMIT 1) ORDER BY date,start,b.id').all());
  if(req.method==='POST' && url.pathname==='/api/bookings') return json(res,201,booking(body));
  const match=/^\/api\/bookings\/(\d+)\/(payment|cancel)$/.exec(url.pathname);
  if(req.method==='POST' && match) {
   const b=db.prepare('SELECT * FROM bookings WHERE id=?').get(Number(match[1])); if(!b) fail('Agendamento não encontrado.',404);
   if(b.status==='cancelled') fail('Agendamento cancelado.');
   if(db.prepare('SELECT id FROM payment_orders WHERE booking_id=?').get(b.id)) fail('Esta reserva possui cobrança online. Gerencie o pagamento ou estorno no Mercado Pago antes de alterar a reserva.',409);
   if(match[2]==='payment'&&db.prepare('SELECT booking_id FROM pix_links WHERE booking_id=?').get(b.id))fail('Analise o comprovante Pix antes de confirmar o recebimento.',409);
   if(match[2]==='cancel'&&db.prepare("SELECT id FROM pix_receipts WHERE booking_id=? AND status='pending'").get(b.id))fail('Analise o comprovante pendente antes de cancelar a reserva.',409);
   if(match[2]==='payment') { if(b.paid) fail('Pagamento já registrado.',409); if(!['Pix','Dinheiro','Cartão','Transferência'].includes(body.method)) fail('Selecione a forma de pagamento.'); db.prepare("UPDATE bookings SET paid=1,method=?,paid_at=? WHERE id=?").run(body.method,new Date().toISOString(),b.id); }
   else { if(b.paid) fail('Não é possível cancelar uma reserva paga. Resolva o estorno antes de cancelar.'); db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(b.id); }
   return json(res,200,{ok:true});
  }
  return json(res,404,{error:'Não encontrado.'});
 } catch(error) { if(!error.status) console.error(error); return json(res,error.status||500,{error:error.status?error.message:'Erro interno do servidor.'}); }
});
return {server,db};
}
