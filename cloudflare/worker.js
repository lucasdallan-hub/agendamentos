import {DurableObject} from 'cloudflare:workers';
import {httpServerHandler} from 'cloudflare:node';
import {randomBytes,scryptSync} from 'node:crypto';
import {createApplication} from '../server-core.js';
import {MercadoPago,paymentConfiguration} from '../payments.js';
import {DurableDatabase,DurableMap} from './database.js';
import {initializeSystems,setting,installSystem,updateChildDomain} from '../systems.js';

const securityHeaders={
 'X-Content-Type-Options':'nosniff',
 'X-Frame-Options':'DENY',
 'Referrer-Policy':'same-origin',
 'Content-Security-Policy':"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'"
};
const json=(status,data)=>Response.json(data,{status,headers:{...securityHeaders,'Cache-Control':'no-store'}});
/** All arena business data, originals and sessions use durable SQLite storage. */
export class Arena extends DurableObject {
 constructor(ctx,env) {
  super(ctx,env);
  this.db=new DurableDatabase(ctx.storage);
  initializeSystems(this.db);
  this.configure();
 }
 configure(){
  const db=this.db;
  const child=!!setting(db,'identity');
  db.systemProvisioner=child?null:async payload=>this.env.ARENA.getByName('child:'+payload.slug).initializeChild(payload);
  db.systemDomainUpdater=child?async host=>{
   const response=await this.env.ARENA.getByName('main').changeChildDomain(setting(db,'identity').slug,host);
   if(response.error)throw Object.assign(new Error(response.error),{status:response.status});
   return response;
  }:null;
  // Children retain financial history but never inherit the mother's provider credentials.
  const paymentConfig=child?{ready:false,mode:'test'}:paymentConfiguration(this.env);
  const {server}=createApplication({
   db,paymentConfig,paymentClient:new MercadoPago(paymentConfig),
   receiptReader:async()=>({amount_cents:null,candidates:[]}),ocrReady:false,manualReceiptReview:true,
   sessionStore:new DurableMap(db,'session'),attemptStore:new DurableMap(db,'login-attempt'),cookieSecure:true,
   clientKey:req=>req.headers['cf-connecting-ip']||req.socket.remoteAddress
  });
  this.nodeHandler=httpServerHandler(server);
 }
 async initializeChild(payload){
  installSystem(this.db,payload);
  this.configure();
 }
 changeChildDomain(slug,host){
  try{return updateChildDomain(this.db,slug,host,this.env.MOTHER_HOST);}
  catch(error){if(error.status)return {error:error.message,status:error.status};throw error;}
 }
 resolveHost(host){
  if(setting(this.db,'identity'))throw new Error('Only the mother resolves systems.');
  const child=this.db.prepare("SELECT slug FROM child_systems WHERE hostname=? AND status='ready'").get(host);
  if(child)return 'child:'+child.slug;
  const mother=this.env.MOTHER_HOST||setting(this.db,'mother_host');
  if(mother&&host!==mother)return null;
  return 'main';
 }
 bootstrap(){
  const db=this.db;
  if(!db.prepare('SELECT id FROM admin WHERE id=1').get()) {
   const password=typeof this.env.ADMIN_INITIAL_PASSWORD==='string'?this.env.ADMIN_INITIAL_PASSWORD.trim():'admin';
   if((password!=='admin'&&password.length<10)||password.length>200)this.configurationError='Configure a senha inicial do administrador nos segredos da Cloudflare (10 a 200 caracteres).';
   else {
    const salt=randomBytes(16).toString('hex');
    db.prepare('INSERT INTO admin(id,salt,hash) VALUES(1,?,?)').run(salt,scryptSync(password,salt,64).toString('hex'));
   }
  }

 }
 fetch(request) {
  this.bootstrap();
  if(this.configurationError)return json(503,{error:this.configurationError});
  // Forward trusted origin information from the actual Worker URL, rather than
  // accepting a client-provided proxy protocol or Host value.
  const headers=new Headers(request.headers),url=new URL(request.url);
  headers.set('Host',url.host);headers.set('X-Forwarded-Proto',url.protocol.slice(0,-1));
  const forwarded=new Request(request,{headers});
  return this.nodeHandler.fetch(forwarded,this.env,this.ctx);
 }
}

// Preserve the class introduced by migration v1 without provisioning Containers.
// Existing deployments may already have applied that migration.
export class ReceiptOCR extends DurableObject {
 fetch(){return json(410,{error:'A conferência de comprovantes agora é manual.'});}
}

const publicFiles=new Map([
 ['/sidebar.js','/sidebar.js'],
 ['/theme.js','/theme.js'],
 ['/catalogo','/catalog.html'],['/catalog.js','/catalog.js'],['/','/index.html'],['/pix','/pix.html'],['/pagamento','/payment.html'],
 ['/branding.js','/branding.js'],['/app.js','/app.js'],['/pix.js','/pix.js'],['/style.css','/style.css']
]);

export default {
 async fetch(request,env) {
  const url=new URL(request.url);
  if(url.pathname.startsWith('/api/')) {
   try{
    const system=await env.ARENA.getByName('main').resolveHost(url.hostname);
    if(!system)return json(404,{error:'Sistema não encontrado para este subdomínio.'});
    return await env.ARENA.getByName(system).fetch(request);
   }
   catch{return json(503,{error:'A arena está temporariamente indisponível. Tente novamente em instantes.'});}
  }
  if(!['GET','HEAD'].includes(request.method))return json(405,{error:'Método não permitido.'});
  const filename=publicFiles.get(url.pathname);
  if(!filename)return json(404,{error:'Não encontrado.'});
  url.pathname=filename;
  const response=await env.ASSETS.fetch(new Request(url,request));
  const headers=new Headers(response.headers);
  for(const [name,value]of Object.entries(securityHeaders))headers.set(name,value);
  if(filename.endsWith('.html'))headers.set('Cache-Control','no-store');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
 }
};
