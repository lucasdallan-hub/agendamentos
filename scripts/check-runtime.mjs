import assert from 'node:assert/strict';
const origin=process.env.ARENA_ORIGIN||'http://127.0.0.1:8787';
try{
 const url=new URL(origin);
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('invalid origin');
 async function request(path){const response=await fetch(url.origin+path,{redirect:'error',signal:AbortSignal.timeout(10000)});assert.equal(response.status,200,`HTTP inesperado em ${path}: ${response.status}`);return response;}
 const session=await (await request('/api/session')).json();
 assert.equal(session.authenticated,false);assert.equal(session.setup,false);
 const page=await (await request('/catalogo')).text();assert.ok(page.includes('/catalog.js'));
 const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const catalog=await (await request(`/api/public/catalog?date=${date}&duration=60`)).json();
 assert.ok(Array.isArray(catalog.courts));
 console.log('PASS: sessão, página do catálogo e consulta de horários.');
}catch{
 console.error('FAIL: o servidor local não confirmou o fluxo esperado. Inicie npm run dev:cloud; confira a porta e ARENA_ORIGIN. O teste espera o catálogo habilitado.');process.exitCode=1;
}
