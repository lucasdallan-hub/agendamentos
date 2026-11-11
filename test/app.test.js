import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

test('admin, quadras, conflitos, pagamentos, cancelamento e persistência',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'arena-test-'));
 let process;
 const start=async()=>{process=spawn(global.process.execPath,['server.js'],{env:{...global.process.env,DATA_DIR:dir,PORT:'3217',HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']}); await Promise.race([once(process.stdout,'data'),once(process,'exit').then(()=>{throw Error('Servidor não iniciou');})]);};
 const stop=async()=>{if(process.exitCode===null){process.kill();await once(process,'exit');}};
 let cookie='';
 const request=async(url,body,method='POST')=>{const r=await fetch('http://127.0.0.1:3217/api/'+url,{method:body===undefined?'GET':method,headers:{Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:await r.json()};};
 try{
  await start();
  assert.equal((await request('bookings')).status,401);
  assert.equal((await request('session')).data.setup,true);
  assert.equal((await request('setup',{password:'senha-segura-123'})).status,200);
  assert.equal((await request('setup',{password:'outra-senha-123'})).status,409);
  const court=(await request('courts',{name:'Quadra 1',type:'Vôlei de areia',price:120})).data.id;
  const body={court_id:court,customer:'Ana <teste>',phone:'11999999999',date:'2026-12-10',start:'18:00',end:'19:30'};
  const b=await request('bookings',body);assert.equal(b.status,201);
  assert.equal((await request('bookings',{...body,start:'19:00',end:'20:00'})).status,409);
  assert.equal((await request('bookings',{...body,date:'2026-02-30'})).status,400);
  const adjacent=await request('bookings',{...body,start:'19:30',end:'20:30'});assert.equal(adjacent.status,201);
  assert.equal((await request('bookings')).data[0].total,18000);
  assert.equal((await request(`bookings/${b.data.id}/payment`,{method:'Pix'})).status,200);
  assert.equal((await request(`bookings/${b.data.id}/payment`,{method:'Pix'})).status,409);
  assert.equal((await request(`bookings/${b.data.id}/cancel`,{})).status,400);
  assert.equal((await request(`bookings/${adjacent.data.id}/cancel`,{})).status,200);
  assert.equal((await request('bookings',{...body,start:'19:30',end:'20:30'})).status,201);
  assert.equal((await request(`courts/${court}`,{active:false},'PATCH')).status,200);
  assert.equal((await request('bookings',{...body,date:'2026-12-11'})).status,400);
  await stop();await start();cookie='';
  assert.equal((await request('session')).data.setup,false);
  assert.equal((await request('login',{password:'errada-123456'})).status,401);
  assert.equal((await request('login',{password:'senha-segura-123'})).status,200);
  const saved=await request('bookings');assert.equal(saved.data.length,3);assert.equal(saved.data.find(row=>row.id===b.data.id).paid,1);
  assert.equal((await request('logout',{})).status,200);
  assert.equal((await request('bookings')).status,401);
 } finally{await stop();rmSync(dir,{recursive:true,force:true});}
});
