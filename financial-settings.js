import {paymentConfiguration} from './payments.js';
import {setting} from './systems.js';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
export function financialSettings(db,config){
 db.exec(`CREATE TABLE IF NOT EXISTS financial_connection(id INTEGER PRIMARY KEY CHECK(id=1),token TEXT NOT NULL,webhook_secret TEXT NOT NULL,base_url TEXT NOT NULL,mode TEXT NOT NULL,account_id TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS archived_payment_orders(order_id TEXT PRIMARY KEY);`);
 // Existing child systems were previously unable to create their own provider orders.
 if(setting(db,'identity')&&!setting(db,'financial_ownership_initialized')){
  db.prepare('INSERT OR IGNORE INTO archived_payment_orders SELECT id FROM payment_orders').run();
  db.prepare("INSERT INTO system_settings(key,value) VALUES('financial_ownership_initialized','true') ON CONFLICT(key) DO UPDATE SET value='true'").run();
 }
 const stored=()=>db.prepare('SELECT * FROM financial_connection WHERE id=1').get();
 const toConfig=row=>paymentConfiguration({MERCADOPAGO_ACCESS_TOKEN:row.token,MERCADOPAGO_WEBHOOK_SECRET:row.webhook_secret,APP_BASE_URL:row.base_url,MERCADOPAGO_MODE:row.mode});
 if(stored())Object.assign(config,toConfig(stored()));
 function summary(){const row=stored();return {provider:'Mercado Pago',ready:!!config.ready,mode:config.mode,base_url:config.baseUrl||'',token_configured:!!config.token,webhook_configured:!!config.webhookSecret,account_id:row?.account_id||null};}
 function candidate(body){
  const token=body.token===''||body.token===undefined?config.token:body.token;
  const secret=body.webhook_secret===''||body.webhook_secret===undefined?config.webhookSecret:body.webhook_secret;
  if(typeof token!=='string'||!token.trim()||token.length>2000||/[\r\n]/.test(token)||typeof secret!=='string'||!secret.trim()||secret.length>2000)fail('Informe o Access Token e o segredo do webhook desta arena.');
  const next=paymentConfiguration({MERCADOPAGO_ACCESS_TOKEN:token.trim(),MERCADOPAGO_WEBHOOK_SECRET:secret.trim(),APP_BASE_URL:body.base_url,MERCADOPAGO_MODE:body.mode});
  if(!next.ready)fail('Informe uma origem HTTPS válida e escolha teste ou produção.');
  return next;
 }
 function save(next,accountId){
  if(!accountId)fail('O Mercado Pago não confirmou a conta recebedora.',502);
  db.prepare('INSERT INTO financial_connection VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,webhook_secret=excluded.webhook_secret,base_url=excluded.base_url,mode=excluded.mode,account_id=excluded.account_id').run(next.token,next.webhookSecret,next.baseUrl,next.mode,String(accountId));
  Object.assign(config,next);return summary();
 }
 function hasOrders(){return !!db.prepare('SELECT id FROM payment_orders WHERE id NOT IN(SELECT order_id FROM archived_payment_orders) LIMIT 1').get();}
 return {summary,candidate,save,hasOrders};
}
