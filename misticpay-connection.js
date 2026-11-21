import {transaction} from './storage.js';
import {misticpayCredentials} from './misticpay-credentials.js';
import {misticpayDiagnostic,transactionIdPattern} from './misticpay-api.js';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const fields={
 active_credentials:'TEXT',pending_credentials:'TEXT',pending_base_url:'TEXT',credentials_key_id:'TEXT',
 active_auth_failed:'INTEGER NOT NULL DEFAULT 0',
 last_verified_at:'TEXT',last_checked_at:'TEXT',last_check_started_at:'INTEGER NOT NULL DEFAULT 0',
 verification_error:'TEXT'
};
const verificationDelay=10_000;

function credential(input,stored){
 const value=typeof input==='string'?input.trim():input;
 return value===undefined||value===''?stored:value;
}

function validatedConfiguration(body,stored,baseUrl){
 const publicKey=credential(body.client_id??body.public_key,stored?.public_key);
 const secretKey=credential(body.client_secret??body.secret_key,stored?.secret_key);
 if((typeof publicKey==='string'&&publicKey.startsWith('ci_'))||(typeof secretKey==='string'&&secretKey.startsWith('cs_'))){
  fail('A MisticPay desativou as credenciais ci_ e cs_. Em API → Chaves de Acesso, crie um par pk_ e sk_.');
 }
 if(typeof publicKey!=='string'||!/^pk_[A-Za-z0-9_-]{1,252}$/.test(publicKey)||
    typeof secretKey!=='string'||!/^sk_[A-Za-z0-9_-]{1,252}$/.test(secretKey)){
  fail('Informe o Client ID (pk_) e o Client Secret (sk_) da mesma chave de acesso da MisticPay.');
 }
 let url;
 try{url=new URL(baseUrl);}catch{fail('Informe o endereço HTTPS público da arena.');}
 if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!url.hostname.includes('.')){
  fail('Informe somente a origem HTTPS pública da arena.');
 }
 return {public_key:publicKey,secret_key:secretKey,base_url:url.origin};
}

function configurationMatches(first,second){
 return first?.active_credentials===second?.active_credentials&&first?.pending_credentials===second?.pending_credentials
  &&first?.base_url===second?.base_url&&first?.pending_base_url===second?.pending_base_url
  &&first?.credentials_key_id===second?.credentials_key_id&&first?.last_verified_at===second?.last_verified_at
  &&first?.active_auth_failed===second?.active_auth_failed;
}

export function createMisticPayConnection(db,{encryptionKey,managedEncryptionKey,scope,lookup}){
 const originalVault=misticpayCredentials(encryptionKey,scope);
 const managedVault=misticpayCredentials(managedEncryptionKey,scope);
 const vaults=[originalVault,managedVault].filter(vault=>vault.ready);
 transaction(db,()=>{
  db.exec("CREATE TABLE IF NOT EXISTS misticpay_connection(id INTEGER PRIMARY KEY CHECK(id=1),public_key TEXT NOT NULL,secret_key TEXT NOT NULL,base_url TEXT NOT NULL)");
  const installed=new Set(db.prepare('PRAGMA table_info(misticpay_connection)').all().map(column=>column.name));
  for(const [name,type] of Object.entries(fields)){
   if(!installed.has(name))db.exec(`ALTER TABLE misticpay_connection ADD COLUMN ${name} ${type}`);
  }
 });
 const read=()=>db.prepare('SELECT * FROM misticpay_connection WHERE id=1').get();
 const latestOrder=()=>db.prepare('SELECT id,provider_id,amount_cents FROM misticpay_orders WHERE archived=0 ORDER BY created_at DESC,id DESC LIMIT 1').get();
 const hasCiphertext=row=>row?.active_credentials!=null||row?.pending_credentials!=null;
 function vaultFor(row){
  if(row?.credentials_key_id)return vaults.find(vault=>vault.keyId===row.credentials_key_id);
  if(!hasCiphertext(row))return vaults[0];
 }
 function storageStatus(row){
  if(vaultFor(row))return 'ready';
  if(vaults.length)return 'key_mismatch';
  return originalVault.status==='secret_missing'?managedVault.status:originalVault.status;
 }
 const storageReady=row=>storageStatus(row)==='ready';
 const ready=row=>storageReady(row)&&!!(
  (row?.active_credentials&&!row.active_auth_failed)||(row?.pending_credentials&&!latestOrder())
 );
 const requireStorage=row=>{
  const vault=vaultFor(row);
  if(!vault)fail('O armazenamento de chaves da MisticPay está indisponível. Confira o segredo do Worker.',503);
  return vault;
 };
 function settings(){
  const row=read();
  const configured=!!(row?.pending_credentials||row?.active_credentials||row?.public_key&&row.secret_key);
  const error=row?.verification_error?JSON.parse(row.verification_error):null;
  const pendingRotation=!!(row?.pending_credentials&&latestOrder());
  return {
   ready:ready(row),storage_ready:storageReady(row),storage_status:storageStatus(row),
   public_key_configured:configured,secret_key_configured:configured,
   base_url:row?.pending_base_url??row?.base_url??'',
   verification_state:!configured?'unconfigured':error?'failed':pendingRotation?'pending':row.last_verified_at?'verified':'configured',
   last_checked_at:row?.last_checked_at??null,last_verified_at:row?.last_verified_at??null,verification_error:error
  };
 }
 async function migrateLegacy(){
  const row=read();
  if(!row?.public_key||!row?.secret_key||hasCiphertext(row))return;
  const vault=vaultFor(row);
  if(!vault)return;
  const envelope=await vault.seal({public_key:row.public_key,secret_key:row.secret_key});
  transaction(db,()=>{
   const current=read();
   if(current?.public_key!==row.public_key||current?.secret_key!==row.secret_key||!configurationMatches(row,current))return;
   db.prepare(`UPDATE misticpay_connection SET public_key='',secret_key='',active_credentials=?,
    credentials_key_id=? WHERE id=1`).run(envelope,vault.keyId);
  });
 }
 async function prepareConfiguration(){
  await migrateLegacy();
  const row=read();
  if(!row?.pending_credentials||!storageReady(row))return;
  transaction(db,()=>{
   if(!configurationMatches(row,read())||latestOrder())return;
   // A draft can become active without proof when no reservation is tied to the previous keys.
   db.prepare(`UPDATE misticpay_connection SET active_credentials=pending_credentials,base_url=pending_base_url,
    pending_credentials=NULL,pending_base_url=NULL,last_verified_at=NULL,last_checked_at=NULL,
    verification_error=NULL,active_auth_failed=0 WHERE id=1`).run();
  });
 }
 async function configuration(){
  await prepareConfiguration();
  return settings();
 }
 async function verifySavedRotation(){
  const row=read();
  if(!row?.pending_credentials||Date.now()-row.last_check_started_at<verificationDelay)return settings();
  const previous=latestOrder();
  if(!previous?.provider_id)return settings();
  try{return await verify({transaction_id:previous.id});}
  catch(error){
   if(error.status===409||error.status===429)return settings();
   throw error;
  }
 }
 async function saveSettings(body,requestOrigin){
  await migrateLegacy();
  const row=read();
  const vault=requireStorage(row);
  const currentEnvelope=row?.pending_credentials??row?.active_credentials;
  const stored=currentEnvelope==null?null:await vault.open(currentEnvelope);
  const baseUrl=body.base_url===undefined?(row?.pending_base_url||row?.base_url||requestOrigin):body.base_url;
  const next=validatedConfiguration(body,stored,baseUrl);
  const unchanged=stored?.public_key===next.public_key&&stored?.secret_key===next.secret_key&&
   (row.pending_base_url??row.base_url)===next.base_url;
  if(unchanged){
   if(!configurationMatches(row,read()))fail('A configuração mudou. Reabra a tela e tente novamente.',409);
   await prepareConfiguration();
   return verifySavedRotation();
  }
  const envelope=await vault.seal({public_key:next.public_key,secret_key:next.secret_key});
  transaction(db,()=>{
   if(!configurationMatches(row,read()))fail('A configuração mudou. Reabra a tela e tente novamente.',409);
   if(latestOrder()){
    db.prepare(`INSERT INTO misticpay_connection(id,public_key,secret_key,base_url,pending_credentials,pending_base_url,credentials_key_id)
     VALUES(1,'','','',?,?,?) ON CONFLICT(id) DO UPDATE SET pending_credentials=excluded.pending_credentials,
     pending_base_url=excluded.pending_base_url,credentials_key_id=excluded.credentials_key_id,
     last_checked_at=NULL,verification_error=NULL`).run(envelope,next.base_url,vault.keyId);
   }else{
    db.prepare(`INSERT INTO misticpay_connection(id,public_key,secret_key,base_url,active_credentials,credentials_key_id)
     VALUES(1,'','',?,?,?) ON CONFLICT(id) DO UPDATE SET active_credentials=excluded.active_credentials,
     base_url=excluded.base_url,credentials_key_id=excluded.credentials_key_id,pending_credentials=NULL,
     pending_base_url=NULL,last_verified_at=NULL,last_checked_at=NULL,verification_error=NULL,active_auth_failed=0`)
     .run(next.base_url,envelope,vault.keyId);
   }
  });
  return verifySavedRotation();
 }
 async function verify(body){
  const id=typeof body.transaction_id==='string'?body.transaction_id.trim():'';
  if(!transactionIdPattern.test(id))fail('Informe o ID de uma transação Pix existente na sua conta MisticPay.');
  await prepareConfiguration();
  const original=read();
  const vault=requireStorage(original);
  const envelope=original?.pending_credentials??original?.active_credentials;
  if(!envelope)fail('Salve a configuração da MisticPay antes de verificar.',409);
  const credentials=await vault.open(envelope);
  const attempt=transaction(db,()=>{
   const current=read();
   if(!configurationMatches(original,current))fail('A configuração mudou. Tente verificar novamente.',409);
   const started=Date.now();
   if(started-current.last_check_started_at<verificationDelay)fail('Aguarde 10 segundos entre verificações da MisticPay.',429);
   db.prepare('UPDATE misticpay_connection SET last_check_started_at=? WHERE id=1').run(started);
   return {started,latest:current.pending_credentials?latestOrder():null};
  });
  let error;
  try{
   const payment=await lookup(credentials,id,{requireExisting:true});
   if(attempt.latest){
    const order=attempt.latest;
    const proof=[order.id,order.provider_id].includes(id)?payment:await lookup(credentials,order.id,{requireExisting:true});
    if(proof.cents!==order.amount_cents||![order.id,order.provider_id].includes(proof.id)){
     const mismatch=new Error('As novas chaves precisam dar acesso às cobranças já criadas nesta arena.');
     throw Object.assign(mismatch,{diagnosticCode:'ORDER_MISMATCH'});
    }
   }
  }catch(cause){error=cause;}
  const completed=new Date().toISOString();
  const diagnostic=error?misticpayDiagnostic(error,'transactions/check',completed):null;
  return transaction(db,()=>{
   const current=read();
   if(!configurationMatches(original,current)||current?.last_check_started_at!==attempt.started||
      (current.pending_credentials&&latestOrder()?.id!==attempt.latest?.id)){
    fail('A configuração ou as cobranças mudaram. Verifique novamente.',409);
   }
   if(diagnostic){
    const activeAuthFailed=!current.pending_credentials&&(
     diagnostic.http_status===401||diagnostic.code==='API_CREDENTIAL_REQUIRED'
    );
    db.prepare(`UPDATE misticpay_connection SET last_checked_at=?,verification_error=?,
     active_auth_failed=CASE WHEN ? THEN 1 ELSE active_auth_failed END WHERE id=1`)
     .run(completed,JSON.stringify(diagnostic),activeAuthFailed?1:0);
   }else{
    db.prepare(`UPDATE misticpay_connection SET active_credentials=?,base_url=?,pending_credentials=NULL,
     pending_base_url=NULL,last_verified_at=?,last_checked_at=?,verification_error=NULL,active_auth_failed=0 WHERE id=1`)
     .run(envelope,current.pending_base_url??current.base_url,completed,completed);
   }
   return settings();
  });
 }
 async function active({allowUnverified=false}={}){
  await prepareConfiguration();
  const row=read();
  const vault=requireStorage(row);
  if(!row?.active_credentials||(!allowUnverified&&!ready(row))){
   fail('A configuração MisticPay está indisponível. Confira as chaves no painel financeiro da arena.',503);
  }
  return {...await vault.open(row.active_credentials),base_url:row.base_url,version:row.active_credentials};
 }
 function isCurrent(connection){
  const row=read();
  return row?.active_credentials===connection.version&&row.base_url===connection.base_url;
 }
 function recordVerified(){
  db.prepare(`UPDATE misticpay_connection SET last_verified_at=COALESCE(last_verified_at,?),active_auth_failed=0,
   verification_error=CASE WHEN pending_credentials IS NULL THEN NULL ELSE verification_error END
   WHERE id=1 AND (last_verified_at IS NULL OR active_auth_failed=1 OR pending_credentials IS NULL AND verification_error IS NOT NULL)`)
   .run(new Date().toISOString());
 }
 return {settings,configuration,saveSettings,verify,active,isCurrent,recordVerified};
}
