import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {createMisticPayRetry} from '../misticpay-retry.js';

function fixture(t){
 t.mock.timers.enable({apis:['Date'],now:1_000_000});
 const db=new DatabaseSync(':memory:');
 t.after(()=>db.close());
 db.exec('CREATE TABLE misticpay_orders(booking_id INTEGER PRIMARY KEY,state TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0,provider_id TEXT,checked_at INTEGER)');
 const insert=db.prepare('INSERT INTO misticpay_orders(booking_id,state,archived) VALUES(?,?,?)');
 const scheduleTimes=[];
 return {db,insert,scheduleTimes,schedule:async time=>scheduleTimes.push(time)};
}

test('MisticPay: retry is disabled without an alarm scheduler',async()=>{
 const retry=createMisticPayRetry(null,{sync:()=>assert.fail('unexpected lookup')});
 assert.equal(await retry.queue(1),false);
 await retry.drain();
});

test('MisticPay: retries survive a restart and duplicate notices cannot extend the budget',async t=>{
 const {db,insert,schedule,scheduleTimes}=fixture(t);
 insert.run(1,'pending',0);
 insert.run(2,'approved',0);
 insert.run(3,'pending',1);
 const checks=[];
 const sync=async(id,fromWebhook)=>{
  checks.push([id,fromWebhook]);
  throw new Error('simulated provider outage');
 };
 let retry=createMisticPayRetry(db,{schedule,sync});
 assert.equal(await retry.queue(1),true);
 assert.equal(await retry.queue(2),false);
 assert.equal(await retry.queue(3),false);
 assert.equal(await retry.queue(4),false);
 t.mock.timers.tick(1_000);
 retry=createMisticPayRetry(db,{schedule,sync});
 assert.equal(await retry.queue(1),true);
 assert.deepEqual(scheduleTimes,[1_003_000,1_003_000]);
 await retry.drain();
 assert.deepEqual(checks,[]);
 t.mock.timers.tick(2_000);
 for(let attempt=0;attempt<4;attempt++){
  await retry.drain();
  assert.equal(checks.length,attempt+1);
  t.mock.timers.tick(20_000);
 }
 assert.deepEqual(checks,[[1,true],[1,true],[1,true],[1,true]]);
 assert.equal(await retry.queue(1),false);
 await retry.drain();
 assert.equal(checks.length,4);
});

test('MisticPay: claims at most three due retries and removes settled orders',async t=>{
 const {db,insert,schedule,scheduleTimes}=fixture(t);
 const checks=[];
 const retry=createMisticPayRetry(db,{schedule,sync:async id=>{
  checks.push(id);
  db.prepare("UPDATE misticpay_orders SET state='approved' WHERE booking_id=?").run(id);
 }});
 for(let id=1;id<=5;id++){
  insert.run(id,'pending',0);
  assert.equal(await retry.queue(id),true);
 }
 t.mock.timers.tick(3_000);
 await retry.drain();
 assert.deepEqual(checks,[1,2,3]);
 assert.equal(scheduleTimes.at(-1),1_004_000);
 t.mock.timers.tick(1_000);
 await retry.drain();
 assert.deepEqual(checks,[1,2,3,4,5]);
 assert.equal(await retry.queue(1),false);
 assert.equal(db.prepare('SELECT COUNT(*) AS count FROM misticpay_retries').get().count,0);
 t.mock.timers.tick(100_000);
 await retry.drain();
 assert.equal(checks.length,5);
});

test('MisticPay: opening bookings recovers recent attempted confirmations once',async t=>{
 const {db,insert,schedule,scheduleTimes}=fixture(t);
 for(let id=1;id<=5;id++)insert.run(id,id===5?'approved':'pending',id===4?1:0);
 const mark=db.prepare('UPDATE misticpay_orders SET provider_id=?,checked_at=? WHERE booking_id=?');
 mark.run('linked-recent',Date.now()-1_000,1);
 mark.run('linked-old',Date.now()-25*60*60*1000,2);
 mark.run('linked-untouched',null,3);
 mark.run('linked-archived',Date.now(),4);
 mark.run('linked-terminal',Date.now(),5);
 const checked=[];
 const retry=createMisticPayRetry(db,{schedule,sync:async id=>checked.push(id)});
 await retry.resumeRecent();
 await retry.resumeRecent();
 assert.deepEqual(scheduleTimes,[1_001_000,1_001_000]);
 t.mock.timers.tick(1_000);
 await retry.drain();
 assert.deepEqual(checked,[1]);
});
