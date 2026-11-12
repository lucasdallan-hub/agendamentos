import {createHash,randomBytes} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {transaction} from './storage.js';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const maximum=5*1024*1024;
const summaryColumns='id,filename,mime_type,amount_cents,match_status,status,created_at,review_note';

function decodeUpload(body){
 if(typeof body.filename!=='string'||!body.filename.trim()||body.filename.length>180)fail('Informe o nome do comprovante.');
 if(typeof body.content_base64!=='string'||!body.content_base64.length)fail('Selecione um comprovante.');
 if(body.content_base64.length>Math.ceil(maximum/3)*4)fail('O comprovante deve ter até 5 MB.',413);
 const encoded=body.content_base64,padding=encoded.endsWith('==')?2:encoded.endsWith('=')?1:0;
 if(encoded.length/4*3-padding>maximum)fail('O comprovante deve ter até 5 MB.',413);
 const firstPadding=encoded.indexOf('=');
 if(encoded.length%4!==0||/[^A-Za-z0-9+/=]/.test(encoded)||(firstPadding!==-1&&firstPadding!==encoded.length-padding))fail('Arquivo inválido.');
 const buffer=Buffer.from(body.content_base64,'base64');
 if(buffer.length>maximum)fail('O comprovante deve ter até 5 MB.',413);
 let mime;
 if(buffer.length>=24&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))mime='image/png';
 else if(buffer.length>=4&&buffer[0]===255&&buffer[1]===216&&buffer[2]===255)mime='image/jpeg';
 else if(buffer.subarray(0,5).toString('ascii')==='%PDF-')mime='application/pdf';
 else fail('Envie um arquivo JPG, PNG ou PDF válido.',415);
 return {buffer,mime,filename:body.filename.trim()};
}

export function createPix(db,{receiptReader,ocrReady=false,manualReceiptReview=false}){
 db.exec(`CREATE TABLE IF NOT EXISTS pix_settings(id INTEGER PRIMARY KEY CHECK(id=1),key TEXT NOT NULL,receiver TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS pix_links(booking_id INTEGER PRIMARY KEY REFERENCES bookings(id),token TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,pix_key TEXT NOT NULL,receiver TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS pix_receipts(id INTEGER PRIMARY KEY,booking_id INTEGER NOT NULL REFERENCES bookings(id),filename TEXT NOT NULL,mime_type TEXT NOT NULL,content BLOB NOT NULL,file_hash TEXT NOT NULL UNIQUE,amount_cents INTEGER,match_status TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL,review_note TEXT NOT NULL DEFAULT '',reviewed_at TEXT);`);
 const inFlight=new Set(),attempts=new Map();let processing=0;
 const booking=id=>{const b=db.prepare('SELECT b.*,c.name court_name FROM bookings b JOIN courts c ON c.id=b.court_id WHERE b.id=?').get(id);if(!b)fail('Agendamento não encontrado.',404);return b;};
 const latest=id=>db.prepare(`SELECT ${summaryColumns} FROM pix_receipts WHERE booking_id=? ORDER BY id DESC LIMIT 1`).get(id)||null;
 const orderExists=id=>!!db.prepare('SELECT id FROM payment_orders WHERE booking_id=?').get(id);
 const available=b=>{if(b.status!=='confirmed'||b.paid)fail('Esta reserva não aceita novos comprovantes.',409);if(orderExists(b.id))fail('Esta reserva já possui cobrança Mercado Pago. Use o checkout existente.',409);};
 const linkFor=token=>{if(!/^[a-f0-9]{64}$/.test(token))fail('Link Pix não encontrado.',404);const link=db.prepare('SELECT * FROM pix_links WHERE token=?').get(token);if(!link)fail('Link Pix não encontrado.',404);if(new Date(link.expires_at)<=new Date())fail('Este link Pix expirou. Peça um novo link à arena.',410);return link;};
 function settings(){const current=db.prepare('SELECT key,receiver FROM pix_settings WHERE id=1').get()||{key:'',receiver:''};return {...current,ready:!!(current.key&&current.receiver),ocr_ready:ocrReady,manual_review:manualReceiptReview};}
 function saveSettings(body){
  if(typeof body.key!=='string'||!body.key.trim()||body.key.trim().length>140||/[\x00-\x1f]/.test(body.key))fail('Informe uma chave Pix válida.');
  if(typeof body.receiver!=='string'||!body.receiver.trim()||body.receiver.trim().length>120||/[\x00-\x1f]/.test(body.receiver))fail('Informe o nome do recebedor.');
  db.prepare('INSERT INTO pix_settings(id,key,receiver) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET key=excluded.key,receiver=excluded.receiver').run(body.key.trim(),body.receiver.trim());return settings();
 }
 function createLink(id){
  const b=booking(id);const current=settings();if(!current.ready)fail('Cadastre a chave Pix e o nome do recebedor no financeiro.',409);
  // Only a definitive rejection with no external preference or payment can change lanes.
  db.prepare("DELETE FROM payment_orders WHERE booking_id=? AND state='failed' AND preference_id IS NULL AND checkout_url IS NULL AND NOT EXISTS(SELECT 1 FROM provider_payments WHERE order_id=payment_orders.id)").run(id);
  available(b);
  const existing=db.prepare('SELECT * FROM pix_links WHERE booking_id=?').get(id);
  if(existing&&new Date(existing.expires_at)>new Date())return {path:`/pix#${existing.token}`,expires_at:existing.expires_at};
  const token=randomBytes(32).toString('hex'),expires_at=new Date(Date.now()+7*24*3600000).toISOString();
  db.prepare('INSERT INTO pix_links(booking_id,token,expires_at,pix_key,receiver) VALUES(?,?,?,?,?) ON CONFLICT(booking_id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at,pix_key=excluded.pix_key,receiver=excluded.receiver').run(id,token,expires_at,current.key,current.receiver);
  return {path:`/pix#${token}`,expires_at};
 }
 function publicPayment(token){const link=linkFor(token),b=booking(link.booking_id);if(b.status!=='confirmed')fail('Esta reserva não está mais disponível.',410);return {customer:b.customer,court_name:b.court_name,date:b.date,start:b.start,end:b.end,total:b.total,key:link.pix_key,receiver:link.receiver,paid:!!b.paid,expires_at:link.expires_at,receipt:latest(b.id)};}
 async function upload(token,body){
  const link=linkFor(token),b=booking(link.booking_id);available(b);
  const last=latest(b.id);if(last?.status==='pending')fail('Seu comprovante já está em análise. Aguarde a avaliação da arena.',409);
  if(inFlight.has(b.id))fail('Já existe um comprovante sendo lido para esta reserva.',409);
  if(processing>=2)fail('Há comprovantes sendo lidos. Tente novamente em instantes.',429);
  const data=decodeUpload(body),hash=createHash('sha256').update(data.buffer).digest('hex');
  if(db.prepare('SELECT id FROM pix_receipts WHERE file_hash=?').get(hash))fail('Este comprovante já foi enviado. Envie um comprovante diferente.',409);
  const now=Date.now(),limit=attempts.get(b.id);
  if(limit&&limit.until>now&&limit.count>=10)fail('Limite de envios atingido. Aguarde uma hora para tentar novamente.',429);
  attempts.set(b.id,{count:limit?.until>now?limit.count+1:1,until:limit?.until>now?limit.until:now+3600000});
  inFlight.add(b.id);processing++;
  try{
   let result;
   try{result=await receiptReader(data.buffer,data.mime);}catch(error){if(error.status===422)result={amount_cents:null};else throw error;}
   const fresh=booking(b.id);available(fresh);linkFor(token);
   if(latest(b.id)?.status==='pending')fail('Já existe um comprovante em análise.',409);
   if(db.prepare('SELECT id FROM pix_receipts WHERE file_hash=?').get(hash))fail('Este comprovante já foi enviado.',409);
   const value=Number.isSafeInteger(result?.amount_cents)&&result.amount_cents>0?result.amount_cents:null;
   const match=manualReceiptReview?'manual':value===null?'unreadable':value===fresh.total?'matched':'mismatch';
   const inserted=db.prepare('INSERT INTO pix_receipts(booking_id,filename,mime_type,content,file_hash,amount_cents,match_status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(b.id,data.filename,data.mime,data.buffer,hash,value,match,new Date().toISOString());
   return db.prepare(`SELECT ${summaryColumns} FROM pix_receipts WHERE id=?`).get(Number(inserted.lastInsertRowid));
  }finally{inFlight.delete(b.id);processing--;}
 }
 function list(id){booking(id);return db.prepare(`SELECT ${summaryColumns} FROM pix_receipts WHERE booking_id=? ORDER BY id DESC`).all(id);}
 function file(id){const receipt=db.prepare('SELECT id,mime_type,content FROM pix_receipts WHERE id=?').get(id);if(!receipt)fail('Comprovante não encontrado.',404);return receipt;}
 function review(id,body){
  const receipt=db.prepare('SELECT * FROM pix_receipts WHERE id=?').get(id);if(!receipt)fail('Comprovante não encontrado.',404);
  if(receipt.status!=='pending')fail('Este comprovante já foi analisado.',409);
  if(!['approve','reject'].includes(body.decision))fail('Escolha aprovar ou rejeitar o comprovante.');
  const b=booking(receipt.booking_id);available(b);
  if(body.decision==='approve'){
   if(manualReceiptReview){
    if(!Number.isSafeInteger(body.confirmed_amount_cents)||body.confirmed_amount_cents!==b.total)fail('Informe o valor recebido; ele deve corresponder ao total da reserva.',409);
   }else if(receipt.match_status!=='matched'||receipt.amount_cents!==b.total)fail('O valor lido não confere com a reserva. Solicite outro comprovante.',409);
   if(body.confirmed_received!==true)fail('Confirme que conferiu o recebimento na conta antes de aprovar.');
  }
  const note=typeof body.note==='string'?body.note.trim().slice(0,1000):'';
  transaction(db,()=>{
   db.prepare('UPDATE pix_receipts SET status=?,review_note=?,reviewed_at=? WHERE id=?').run(body.decision==='approve'?'approved':'rejected',note,new Date().toISOString(),id);
   if(body.decision==='approve')db.prepare("UPDATE bookings SET paid=1,method='Pix',paid_at=? WHERE id=?").run(new Date().toISOString(),b.id);
  });
  return db.prepare(`SELECT ${summaryColumns} FROM pix_receipts WHERE id=?`).get(id);
 }
 return {settings,saveSettings,createLink,publicPayment,upload,list,file,review};
}
