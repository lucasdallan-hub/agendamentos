import {Buffer} from 'node:buffer';
import {randomBytes,scryptSync} from 'node:crypto';
import {transaction} from './storage.js';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const tables=['courts','bookings','payment_orders','provider_payments','pix_settings','pix_links','pix_receipts'];
export function initializeSystems(db){
 db.exec(`CREATE TABLE IF NOT EXISTS system_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS child_systems(slug TEXT PRIMARY KEY,hostname TEXT NOT NULL UNIQUE,name TEXT NOT NULL,created_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'provisioning');`);
}
export function setting(db,key,fallback=null){const row=db.prepare('SELECT value FROM system_settings WHERE key=?').get(key);return row?JSON.parse(row.value):fallback;}
function save(db,key,value){db.prepare('INSERT INTO system_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
export function branding(db){return {...setting(db,'branding',{name:'Arena Vôlei',logo:''}),is_mother:!setting(db,'identity'),systems_available:!!db.systemProvisioner};}
export function saveBranding(db,body){
 if(typeof body.name!=='string'||!body.name.trim()||body.name.trim().length>80)fail('Informe um nome de até 80 caracteres.');
 const logo=body.logo??'';
 if(typeof logo!=='string'||logo.length>350000)fail('A logo deve ter no máximo 250 KB.');
 if(logo){
  const match=/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(logo);
  if(!match)fail('Envie a logo em PNG ou JPEG.');
  const bytes=Buffer.from(match[2],'base64');
  if(bytes.length>250*1024||bytes.toString('base64')!==match[2])fail('Logo inválida ou maior que 250 KB.');
  if(match[1]==='png'?!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):!(bytes[0]===255&&bytes[1]===216&&bytes[2]===255))fail('O conteúdo da logo não corresponde ao formato.');
 }
 save(db,'branding',{name:body.name.trim(),logo});return branding(db);
}
export function hostname(value){
 if(typeof value!=='string')fail('Informe um subdomínio completo, como unidade.seudominio.com.br.');
 const host=value.trim().toLowerCase();
 if(host.length>253||!host.includes('.')||host.split('.').some(label=>!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))||/^\d+(?:\.\d+){3}$/.test(host)||host.endsWith('.workers.dev'))fail('Use um subdomínio do seu domínio próprio, sem https, porta ou caminho.');
 return host;
}
export function captureSystem(db){
 const snapshot={catalog:setting(db,'catalog',{enabled:true,open:'06:00',close:'23:00'}),branding:setting(db,'branding',{name:'Arena Vôlei',logo:''}),tables:{}};
 for(const table of tables)snapshot.tables[table]=db.prepare(`SELECT * FROM ${table}`).all();
 // Bound the transfer before provisioning; never silently create a partial copy.
 if(Buffer.byteLength(JSON.stringify(snapshot))>20*1024*1024)fail('A cópia ultrapassa 20 MB. Solicite uma migração assistida para copiar todos os comprovantes.',413);
 return snapshot;
}
export function installSystem(db,{slug,name,password,snapshot}){
 if(setting(db,'identity'))return;
 transaction(db,()=>{
  if(db.prepare('SELECT id FROM admin').get()||db.prepare('SELECT id FROM courts').get())fail('O destino já contém dados e não pode ser sobrescrito.',409);
  for(const table of tables)for(const row of snapshot.tables[table]){
   const columns=Object.keys(row);
   db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(key=>row[key]));
  }
  save(db,'identity',{slug,parent:'main'});
  if(snapshot.catalog)save(db,'catalog',snapshot.catalog);
  save(db,'branding',{...snapshot.branding,name});
  const salt=randomBytes(16).toString('hex');
  db.prepare('INSERT INTO admin(id,salt,hash) VALUES(1,?,?)').run(salt,scryptSync(password,salt,64).toString('hex'));
 });
}
export async function createChild(db,body,motherHost){
 if(setting(db,'identity'))fail('Somente o sistema mãe pode criar sistemas filhos.',403);
 if(!db.systemProvisioner)fail('A criação de sistemas filhos está disponível no ambiente Cloudflare.',503);
 const slug=typeof body.slug==='string'?body.slug.trim().toLowerCase():'';
 if(!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(slug)||['main','www','admin','api'].includes(slug))fail('Use um identificador de 1 a 40 letras minúsculas, números ou hífens.');
 const host=hostname(body.hostname);
 if(host===motherHost)fail('O subdomínio do filho precisa ser diferente do endereço do sistema mãe.');
 if(typeof body.name!=='string'||!body.name.trim()||body.name.trim().length>80)fail('Informe o nome do sistema filho (até 80 caracteres).');
 if(typeof body.password!=='string'||body.password.length<10||body.password.length>200)fail('Defina uma senha do filho entre 10 e 200 caracteres.');
 if(db.prepare('SELECT slug FROM child_systems WHERE slug=? OR hostname=?').get(slug,host))fail('Este identificador ou subdomínio já foi cadastrado.',409);
 const snapshot=captureSystem(db),name=body.name.trim(),created_at=new Date().toISOString();
 if(!setting(db,'mother_host'))save(db,'mother_host',motherHost);
 db.prepare('INSERT INTO child_systems(slug,hostname,name,created_at) VALUES(?,?,?,?)').run(slug,host,name,created_at);
 try{await db.systemProvisioner({slug,name,password:body.password,snapshot});}
 catch{fail('A cópia não foi concluída. O identificador foi reservado para evitar sobrescrever dados; consulte o suporte antes de tentar novamente.',503);}
 db.prepare("UPDATE child_systems SET status='ready' WHERE slug=?").run(slug);
 return {slug,hostname:host,name,created_at,status:'ready',url:`https://${host}`};
}

export function updateChildDomain(db,slug,value,motherHost){
 const host=hostname(value);
 if(host===motherHost||host===setting(db,'mother_host'))fail('Este endereço pertence ao sistema mãe.');
 const record=db.prepare("SELECT * FROM child_systems WHERE slug=? AND status='ready'").get(slug);
 if(!record)fail('Sistema filho não encontrado.',404);
 const duplicate=db.prepare('SELECT slug FROM child_systems WHERE hostname=? AND slug<>?').get(host,slug);
 if(duplicate)fail('Este subdomínio já pertence a outro sistema.',409);
 db.prepare('UPDATE child_systems SET hostname=? WHERE slug=?').run(host,slug);
 return {hostname:host,url:`https://${host}`};
}
