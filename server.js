import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createApplication} from './server-core.js';
import {readReceipt} from './receipt-ocr.js';

const root=path.dirname(fileURLToPath(import.meta.url));
const files={'/sidebar.js':['sidebar.js','text/javascript; charset=utf-8'],'/theme.js':['theme.js','text/javascript; charset=utf-8'],'/catalogo':['catalog.html','text/html; charset=utf-8'],'/catalog.js':['catalog.js','text/javascript; charset=utf-8'],'/branding.js':['branding.js','text/javascript; charset=utf-8'],'/':['index.html','text/html; charset=utf-8'],'/pagamento':['payment.html','text/html; charset=utf-8'],'/pix':['pix.html','text/html; charset=utf-8'],'/pix.js':['pix.js','text/javascript; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
function serveStatic(req,res,url){
 const file=files[url.pathname];
 if(!file){res.writeHead(404,{'Content-Type':'application/json; charset=utf-8'});return res.end(JSON.stringify({error:'Não encontrado.'}));}
 res.writeHead(200,{'Content-Type':file[1]});return res.end(readFileSync(path.join(root,'public',file[0])));
}
export function createApp({dataDir=process.env.DATA_DIR||path.join(root,'data'),receiptReader=readReceipt,...options}={}){
 mkdirSync(dataDir,{recursive:true});
 const db=new DatabaseSync(path.join(dataDir,'arena.sqlite'));
 db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
 const ocrReady=spawnSync('tesseract',['--version'],{stdio:'ignore',timeout:3000}).status===0;
 return createApplication({db,receiptReader,ocrReady,serveStatic,cookieSecure:process.env.COOKIE_SECURE==='1',...options});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const {server}=createApp();
 server.listen(Number(process.env.PORT||3000),process.env.HOST||'0.0.0.0',()=>console.log(`Arena Vôlei na porta ${process.env.PORT||3000}`));
}
