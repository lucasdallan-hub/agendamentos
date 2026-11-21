import {transaction} from './storage.js';

const retryInterval=20_000;
const retryLimit=4;
const batchLimit=3;
const recoveryLimit=12;
const recoveryWindow=24*60*60*1000;
const minimumAlarmDelay=1_000;
const awaitingPayment="archived=0 AND state IN ('creating','unknown','pending')";

export function createMisticPayRetry(db,{schedule,sync}={}){
 if(typeof schedule!=='function')return {queue:async()=>false,drain:async()=>{},resumeRecent:async()=>{}};

 db.exec(`CREATE TABLE IF NOT EXISTS misticpay_retries(
  booking_id INTEGER PRIMARY KEY REFERENCES misticpay_orders(booking_id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER
 );
 CREATE INDEX IF NOT EXISTS misticpay_retries_due ON misticpay_retries(next_at) WHERE next_at IS NOT NULL;`);

 const enqueue=db.prepare(`INSERT INTO misticpay_retries(booking_id,next_at)
  SELECT booking_id,? FROM misticpay_orders WHERE booking_id=? AND ${awaitingPayment}
  ON CONFLICT(booking_id) DO NOTHING`);
 const queuedAt=db.prepare(`SELECT next_at FROM misticpay_retries r JOIN misticpay_orders o USING(booking_id)
  WHERE r.booking_id=? AND ${awaitingPayment}`);
 const recover=db.prepare(`INSERT INTO misticpay_retries(booking_id,next_at)
  SELECT booking_id,? FROM misticpay_orders o WHERE ${awaitingPayment} AND provider_id IS NOT NULL AND checked_at>=?
  AND NOT EXISTS(SELECT 1 FROM misticpay_retries r WHERE r.booking_id=o.booking_id)
  ORDER BY checked_at DESC,booking_id LIMIT ?`);
 const dueAt=db.prepare(`SELECT MIN(next_at) AS time FROM misticpay_retries r JOIN misticpay_orders o USING(booking_id)
  WHERE next_at IS NOT NULL AND ${awaitingPayment}`);
 const dueJobs=db.prepare(`SELECT r.booking_id,attempts FROM misticpay_retries r JOIN misticpay_orders o USING(booking_id)
  WHERE next_at<=? AND ${awaitingPayment} ORDER BY next_at,r.booking_id LIMIT ?`);
 const advance=db.prepare('UPDATE misticpay_retries SET attempts=?,next_at=? WHERE booking_id=?');
 const removeTerminal=db.prepare(`DELETE FROM misticpay_retries WHERE NOT EXISTS(
  SELECT 1 FROM misticpay_orders o WHERE o.booking_id=misticpay_retries.booking_id AND ${awaitingPayment}
 )`);
 let alarmUpdate=Promise.resolve();

 function scheduleNext(delayOverdue=false){
  // Serialize updates so a later alarm cannot overwrite an earlier one from another request.
  alarmUpdate=alarmUpdate.catch(()=>{}).then(async()=>{
   const {time}=dueAt.get();
   if(time!=null)await schedule(delayOverdue?Math.max(time,Date.now()+minimumAlarmDelay):time);
  });
  return alarmUpdate;
 }

 async function queue(bookingId){
  const scheduled=transaction(db,()=>{
   enqueue.run(Date.now()+retryInterval,bookingId);
   return queuedAt.get(bookingId)?.next_at!=null;
  });
  if(scheduled)await scheduleNext();
  return scheduled;
 }

 async function resumeRecent(){
  const now=Date.now();
  recover.run(now+minimumAlarmDelay,now-recoveryWindow,recoveryLimit);
  await scheduleNext();
 }

 async function drain(){
  const claimed=transaction(db,()=>{
   removeTerminal.run();
   const now=Date.now();
   const jobs=dueJobs.all(now,batchLimit);
   for(const job of jobs){
    const attempts=job.attempts+1;
    // Keep exhausted pending rows so repeated notifications cannot reset the attempt budget.
    advance.run(attempts,attempts<retryLimit?now+retryInterval:null,job.booking_id);
   }
   return jobs;
  });
  await Promise.allSettled(claimed.map(async job=>sync(job.booking_id,true)));
  removeTerminal.run();
  await scheduleNext(true);
 }

 return {queue,drain,resumeRecent};
}
