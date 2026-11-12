import {randomBytes} from 'node:crypto';
import {transaction} from './storage.js';
import {branding,setting} from './systems.js';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const localNow=()=>{const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).map(p=>[p.type,p.value]));return {date:`${parts.year}-${parts.month}-${parts.day}`,minute:Number(parts.hour)*60+Number(parts.minute)};};
const minutes=value=>{if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(value||''))fail('Horário inválido.');return Number(value.slice(0,2))*60+Number(value.slice(3));};
const time=value=>`${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`;
export function publicCatalog(db,{book,pix,payments,paymentConfig,attempts}){
 db.exec('CREATE TABLE IF NOT EXISTS public_booking_requests(request_key TEXT PRIMARY KEY,booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id),token TEXT NOT NULL UNIQUE,expires_at INTEGER NOT NULL)');
 const settings=()=>setting(db,'catalog',{enabled:true,open:'06:00',close:'23:00'});
 function saveSettings(body){
  if(typeof body.enabled!=='boolean')fail('Informe se o catálogo está ativo.');
  const open=minutes(body.open),close=minutes(body.close);
  if(close-open<30||open%30||close%30)fail('Use horários em intervalos de 30 minutos, com fechamento após a abertura.');
  const config={enabled:body.enabled,open:body.open,close:body.close};
  db.prepare("INSERT INTO system_settings(key,value) VALUES('catalog',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(config));return config;
 }
 function validateDate(date){
  const now=localNow();
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date)fail('Selecione uma data válida.');
  const maximum=new Date(now.date+'T12:00:00Z');maximum.setUTCDate(maximum.getUTCDate()+180);
  if(date<now.date||date>maximum.toISOString().slice(0,10))fail('Escolha uma data entre hoje e os próximos 180 dias.');
  return now;
 }
 function enabled(){const config=settings();if(!config.enabled)fail('O agendamento online está temporariamente indisponível.',503);return config;}
 function catalog(date,duration){
  const config=enabled(),now=validateDate(date);duration=Number(duration);
  if(!Number.isInteger(duration)||duration<30||duration>240||duration%30)fail('Escolha uma duração de 30 minutos a 4 horas, em intervalos de 30 minutos.');
  const courts=db.prepare('SELECT id,name,type,price FROM courts WHERE active=1 ORDER BY id').all();
  for(const court of courts){
   const busy=db.prepare("SELECT start,end FROM bookings WHERE court_id=? AND date=? AND status='confirmed'").all(court.id,date);
   court.slots=[];
   for(let start=minutes(config.open);start+duration<=minutes(config.close);start+=30){
    const end=start+duration;
    if(date===now.date&&start<=now.minute)continue;
    if(busy.some(b=>minutes(b.start)<end&&minutes(b.end)>start))continue;
    court.slots.push({start:time(start),end:time(end),total:Math.round(court.price*duration/60)});
   }
  }
  const identity=branding(db);return {name:identity.name,logo:identity.logo,date,duration,open:config.open,close:config.close,courts};
 }
 function confirmation(token){
  if(!/^[a-f0-9]{64}$/.test(token||''))fail('Reserva não encontrada.',404);
  const request=db.prepare('SELECT * FROM public_booking_requests WHERE token=?').get(token);
  if(!request)fail('Reserva não encontrada.',404);
  if(request.expires_at<=Date.now())fail('O link desta reserva expirou. Entre em contato com a arena.',410);
  const b=db.prepare('SELECT b.id,b.customer,b.date,b.start,b.end,b.total,b.status,b.paid,c.name court_name FROM bookings b JOIN courts c ON c.id=b.court_id WHERE b.id=?').get(request.booking_id);
  return {...b,pix_ready:pix.settings().ready&&!db.prepare('SELECT id FROM payment_orders WHERE booking_id=?').get(b.id),checkout_ready:!!paymentConfig.ready&&!db.prepare('SELECT booking_id FROM pix_links WHERE booking_id=?').get(b.id)};
 }
 function reserve(body,key){
  enabled();
  if(!/^[a-f0-9]{64}$/.test(body.request_key||''))fail('Atualize a página e tente novamente.');
  const previous=db.prepare('SELECT token FROM public_booking_requests WHERE request_key=?').get(body.request_key);
  if(previous)return {token:previous.token,reservation:confirmation(previous.token)};
  validateDate(body.date);const duration=minutes(body.end)-minutes(body.start);
  const available=catalog(body.date,duration).courts.find(c=>c.id===Number(body.court_id));
  if(!available?.slots.some(s=>s.start===body.start&&s.end===body.end))fail('Este horário não está mais disponível. Escolha outro.',409);
  if(typeof body.phone!=='string'||body.phone.replace(/\D/g,'').length<10||body.phone.replace(/\D/g,'').length>15)fail('Informe um telefone com DDD válido.');
  const throttleKey='public-booking:'+key,attempt=attempts.get(throttleKey);
  if(attempt?.until>Date.now()&&attempt.count>=10)fail('Limite de reservas atingido. Tente novamente em uma hora ou fale com a arena.',429);
  const result=transaction(db,()=>{
   const booking=book({...body,notes:''}),token=randomBytes(32).toString('hex');
   const expires=new Date(body.date+'T23:59:59-03:00').getTime()+86400000;
   db.prepare('INSERT INTO public_booking_requests VALUES(?,?,?,?)').run(body.request_key,booking.id,token,expires);
   return {token,reservation:confirmation(token)};
  });
  attempts.set(throttleKey,{count:attempt?.until>Date.now()?attempt.count+1:1,until:attempt?.until>Date.now()?attempt.until:Date.now()+3600000});
  return result;
 }
 async function payment(token,kind){
  const b=confirmation(token);
  if(kind==='pix')return pix.createLink(b.id);
  if(db.prepare('SELECT booking_id FROM pix_links WHERE booking_id=?').get(b.id))fail('Esta reserva já utiliza Pix direto. Abra o link Pix existente.',409);
  return payments.checkout(b.id);
 }
 return {settings,saveSettings,catalog,reserve,confirmation,payment};
}
