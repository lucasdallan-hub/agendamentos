import {randomBytes} from 'node:crypto';
import {branding} from './systems.js';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
function normalizeNumber(value,country='55'){
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
 let url;try{url=new URL(value);}catch{fail('Informe a URL HTTPS do seu servidor Evolution Go.');}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.hostname==='localhost'||url.hostname.endsWith('.localhost')||url.hostname.endsWith('.local')||url.hostname.includes(':')||/^\d+(\.\d+){3}$/.test(url.hostname))fail('Use uma URL HTTPS pública para o servidor Evolution Go, sem usuário, senha ou parâmetros.');
 return url.href.replace(/\/+$/,'');
}

/** Per-arena settings and durable outbox. Neither is part of the system clone. */
export function bookingNotifications(db,{fetchImpl=fetch}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS notification_connection(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL,base_url TEXT NOT NULL,api_key TEXT NOT NULL,arena_number TEXT NOT NULL,country_code TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS booking_notifications(id TEXT PRIMARY KEY,booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id),recipient TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'arena',status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,error TEXT NOT NULL DEFAULT '');`);
 const stored=()=>db.prepare('SELECT * FROM notification_connection WHERE id=1').get()||{enabled:0,base_url:'',api_key:'',arena_number:'',country_code:'55'};
 const summary=()=>{const c=stored();return {enabled:!!c.enabled,base_url:c.base_url,token_configured:!!c.api_key,target:'arena',arena_number:c.arena_number,country_code:c.country_code,ready:!!(c.enabled&&c.base_url&&c.api_key&&c.arena_number)};};
 function save(body){
  if(typeof body.enabled!=='boolean'||body.target!==undefined&&body.target!=='arena')fail('As notificações devem ser destinadas ao administrador cadastrado.');
  const previous=stored();
  const country=body.country_code||previous.country_code||'55';
  if(typeof country!=='string'||!/^[1-9]\d{0,2}$/.test(country))fail('Informe um código de país válido, como 55.');
  let url=body.base_url??previous.base_url;
  if(typeof url!=='string'||url.length>2000)fail('Informe a URL HTTPS do seu servidor Evolution Go.');
  url=url.trim();if(url)url=baseURL(url);
  const token=body.api_key===''||body.api_key===undefined?previous.api_key:body.api_key;
  if(typeof token!=='string'||token.length>2000||/[\s\x00-\x1f\x7f]/.test(token))fail('Informe um token de instância válido, sem espaços ou quebras de linha.');
  let number=body.arena_number??previous.arena_number;
  if(typeof number!=='string')fail('Informe o WhatsApp do administrador.');
  number=number.trim();if(number&&(number!==previous.arena_number||country!==previous.country_code))number=normalizeNumber(number,country);
  if(body.enabled&&(!url||!token||!number))fail('Para ativar, informe o servidor, o token da instância e o WhatsApp do administrador.');
  db.prepare('INSERT INTO notification_connection VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,base_url=excluded.base_url,api_key=excluded.api_key,arena_number=excluded.arena_number,country_code=excluded.country_code').run(body.enabled?1:0,url,token,number,country);
  return summary();
 }
 function enqueue(bookingId){
  const c=stored();if(!c.enabled||!c.base_url||!c.api_key||!c.arena_number)return;
  const now=new Date().toISOString();
  db.prepare("INSERT OR IGNORE INTO booking_notifications(id,booking_id,recipient,status,created_at,updated_at) VALUES(?,?,?,'pending',?,?)").run(randomBytes(16).toString('hex'),bookingId,c.arena_number,now,now);
 }
 function mark(id,status,error=''){
  db.prepare('UPDATE booking_notifications SET status=?,updated_at=?,error=? WHERE id=?').run(status,new Date().toISOString(),error,id);
 }
 function events(){
  const stale=new Date(Date.now()-30000).toISOString();
  db.prepare("UPDATE booking_notifications SET status='unknown',updated_at=?,error='O envio foi interrompido. Confira a Evolution Go antes de tentar novamente.' WHERE status='sending' AND updated_at<?").run(new Date().toISOString(),stale);
  return db.prepare('SELECT id,booking_id,recipient,role,status,created_at,updated_at,error FROM booking_notifications ORDER BY created_at DESC,id DESC LIMIT 30').all();
 }
 function message(bookingId){
  const b=db.prepare('SELECT b.customer,b.phone,b.date,b.start,b.end,b.total,b.status,c.name court_name FROM bookings b JOIN courts c ON c.id=b.court_id WHERE b.id=?').get(bookingId);
  if(!b||b.status!=='confirmed')return null;
  const date=new Date(b.date+'T12:00:00Z').toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'});
  const amount=new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(b.total/100);
  return `Novo agendamento · ${branding(db).name}\nReserva #${bookingId}\nCliente: ${b.customer}\nTelefone: ${b.phone}\nQuadra: ${b.court_name}\nData: ${date}\nHorário: ${b.start} às ${b.end}\nValor: ${amount}\nConsulte o painel para acompanhar a reserva e o pagamento.`;
 }
 async function dispatch(bookingId){
  // This operation runs only after the booking transaction commits. A replay
  // claims pending rows atomically; accepted or uncertain sends are never retried.
  try{
   const event=db.prepare("SELECT * FROM booking_notifications WHERE booking_id=? AND status='pending'").get(bookingId);
   if(!event)return;
   const c=stored(),text=message(bookingId);
   if(!text||!c.enabled){mark(event.id,'failed','Envio não realizado: a reserva ou as notificações foram desativadas.');return;}
   const claim=db.prepare("UPDATE booking_notifications SET status='sending',updated_at=? WHERE id=? AND status='pending'").run(new Date().toISOString(),event.id);
   if(!claim.changes)return;
   let response;
   try{
    response=await fetchImpl(c.base_url+'/send/text',{method:'POST',headers:{'Content-Type':'application/json',apikey:c.api_key},body:JSON.stringify({number:event.recipient,text,id:event.id,formatJid:true}),redirect:'error',signal:AbortSignal.timeout(8000)});
   }catch{mark(event.id,'unknown','Não foi possível confirmar o envio. Confira a Evolution Go antes de tentar novamente.');return;}
   if(!response.ok){
    const uncertain=response.status>=500||response.status===408;
    mark(event.id,uncertain?'unknown':'failed',uncertain?`A Evolution Go retornou HTTP ${response.status} sem confirmar o resultado. Confira o provedor antes de tentar novamente.`:`A Evolution Go retornou HTTP ${response.status}. Verifique a conexão e a configuração.`);return;
   }
   let result;try{result=await response.json();}catch{mark(event.id,'unknown','A API respondeu sem confirmação válida. Confira a Evolution Go.');return;}
   if(result?.message!=='success'){mark(event.id,'unknown','A API não confirmou a aceitação da mensagem. Confira a Evolution Go.');return;}
   mark(event.id,'accepted');
  }catch{
   // Do not fail a committed booking or expose provider errors/credentials.
  }
 }
 async function recoverPending(){
  const pending=db.prepare("SELECT booking_id FROM booking_notifications WHERE status='pending' ORDER BY created_at LIMIT 3").all();
  await Promise.all(pending.map(event=>dispatch(event.booking_id)));
  return events();
 }
 async function check(){
  const c=stored();if(!summary().ready)fail('Ative e salve a configuração da Evolution Go antes de verificar a conexão.',409);
  let response,result;
  try{response=await fetchImpl(c.base_url+'/instance/status',{method:'GET',headers:{apikey:c.api_key},redirect:'error',signal:AbortSignal.timeout(8000)});if(response.ok)result=await response.json();}catch{fail('Não foi possível consultar a Evolution Go. Verifique o endereço e o acesso ao servidor.',502);}
  if(!response.ok||result?.message!=='success'||typeof result?.data?.Connected!=='boolean'||typeof result?.data?.LoggedIn!=='boolean')fail('A Evolution Go não confirmou a sessão. Verifique o token da instância e a conexão.',502);
  return {connected:result.data.Connected,logged_in:result.data.LoggedIn};
 }
 return {summary,save,enqueue,dispatch,events,recoverPending,check};
}
