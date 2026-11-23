import {transaction} from './storage.js';

const readTimeout=60_000;
const leaseDuration=90_000;
const maxAttempts=2;

export function receiptReads(db,reader){
 db.exec(`CREATE TABLE IF NOT EXISTS pix_receipt_reads(
  receipt_id INTEGER PRIMARY KEY REFERENCES pix_receipts(id) ON DELETE CASCADE,
  lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0
 );`);
 const finish=db.prepare(`UPDATE pix_receipts SET amount_cents=?,match_status=?
  WHERE id=? AND status='pending' AND match_status='processing'`);
 const remove=db.prepare('DELETE FROM pix_receipt_reads WHERE receipt_id=?');
 const current=db.prepare('SELECT attempts,lease_until FROM pix_receipt_reads WHERE receipt_id=?');

 function enqueue(receiptId){
  db.prepare('INSERT INTO pix_receipt_reads(receipt_id) VALUES(?)').run(receiptId);
 }

 async function read(receiptId){
  if(!reader)return;
  const claimed=transaction(db,()=>{
   const now=Date.now(),job=current.get(receiptId);
   if(!job||job.lease_until>now)return null;
   if(job.attempts>=maxAttempts){
    finish.run(null,'unreadable',receiptId);
    remove.run(receiptId);
    return null;
   }
   // Keep at most one document in memory and one OCR request in flight per arena.
   if(db.prepare('SELECT 1 FROM pix_receipt_reads WHERE lease_until>? LIMIT 1').get(now))return null;
   const receipt=db.prepare(`SELECT r.content,r.mime_type,b.total FROM pix_receipts r JOIN bookings b ON b.id=r.booking_id
    WHERE r.id=? AND r.status='pending' AND r.match_status='processing'`).get(receiptId);
   if(!receipt){remove.run(receiptId);return null;}
   const attempt=job.attempts+1;
   db.prepare('UPDATE pix_receipt_reads SET lease_until=?,attempts=? WHERE receipt_id=?')
    .run(now+leaseDuration,attempt,receiptId);
   return {...receipt,attempt};
  });
  if(!claimed)return;

  let amount=null,timer;
  try{
   const timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve(null),readTimeout);});
   const detected=await Promise.race([reader(claimed.content,claimed.mime_type),timeout]);
   if(Number.isSafeInteger(detected)&&detected>0)amount=detected;
  }catch{
   // Preserve the saved file for manual review if the reader is unavailable.
  }finally{clearTimeout(timer);}

  transaction(db,()=>{
   if(current.get(receiptId)?.attempts!==claimed.attempt)return;
   const result=amount===null?'unreadable':amount===claimed.total?'exact':'different';
   finish.run(amount,result,receiptId);
   remove.run(receiptId);
  });
 }

 async function process(){
  if(!reader)return;
  const jobs=db.prepare('SELECT receipt_id FROM pix_receipt_reads WHERE lease_until<=? ORDER BY receipt_id LIMIT 2').all(Date.now());
  for(const {receipt_id} of jobs)await read(receipt_id);
 }
 return {enqueue,read,process,remove:receiptId=>remove.run(receiptId)};
}
