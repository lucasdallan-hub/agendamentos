import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createApplication} from './server-core.js';
import {nativeReceiptReader} from './receipt-ocr.js';

const root=path.dirname(fileURLToPath(import.meta.url));
const files={'/sidebar.js':['sidebar.js','text/javascript; charset=utf-8'],'/theme.js':['theme.js','text/javascript; charset=utf-8'],'/catalogo':['catalog.html','text/html; charset=utf-8'],'/catalog.js':['catalog.js','text/javascript; charset=utf-8'],'/branding.js':['branding.js','text/javascript; charset=utf-8'],'/':['index.html','text/html; charset=utf-8'],'/pagamento':['payment.html','text/html; charset=utf-8'],'/pix':['pix.html','text/html; charset=utf-8'],'/pix.js':['pix.js','text/javascript; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8'],
 '/pdv.js':['pdv.js','text/javascript; charset=utf-8'],
 '/refresh.css':['refresh.css','text/css; charset=utf-8'],
 '/refresh-public.css':['refresh-public.css','text/css; charset=utf-8'],
 '/arena-hero.webp':['arena-hero.webp','image/webp']};
function serveStatic(req,res,url){
 const file=files[url.pathname];
 if(!file){res.writeHead(404,{'Content-Type':'application/json; charset=utf-8'});return res.end(JSON.stringify({error:'Não encontrado.'}));}
 res.writeHead(200,{'Content-Type':file[1]});return res.end(readFileSync(path.join(root,'public',file[0])));
}
export function createApp({dataDir=process.env.DATA_DIR||path.join(root,'data'),...options}={}){
 mkdirSync(dataDir,{recursive:true});
 const db=new DatabaseSync(path.join(dataDir,'arena.sqlite'));
 db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
 const app=createApplication({
  db,serveStatic,cookieSecure:process.env.COOKIE_SECURE==='1',
  misticpayEncryptionKey:process.env.MISTICPAY_CREDENTIALS_KEY,
  misticpayManagedEncryptionKey:process.env.MISTICPAY_MANAGED_CREDENTIALS_KEY,
  receiptReader:nativeReceiptReader(),...options
 });
 let alertTimer;
 const runScheduledWork=async()=>{
  const results=await Promise.allSettled([app.processBookingAlerts(),app.processReceiptReads(),app.drainSplitChecks()]);
  if(results.some(result=>result.status==='rejected'))console.warn('Não foi possível concluir uma tarefa agendada da arena.');
 };
 app.server.on('listening',()=>{
  void runScheduledWork();
  alertTimer=setInterval(runScheduledWork,60_000).unref();
 });
 app.server.on('close',()=>clearInterval(alertTimer));
 return app;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const {server}=createApp();
 server.listen(Number(process.env.PORT||3000),process.env.HOST||'0.0.0.0',()=>console.log(`Arena Vôlei na porta ${process.env.PORT||3000}`));
}
