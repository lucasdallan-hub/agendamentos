import {randomBytes} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {jpegDimensions} from './image-size.js';
import {transaction} from './storage.js';

const maxPhotos=4;
const maxBytes=350*1024;
const maxDimension=1600;
const maxEncodedLength=Math.ceil(maxBytes/3)*4;
export const courtPhotoBodyLimit=2*1024*1024;
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};

function photoData(value){
 const prefix='data:image/jpeg;base64,';
 if(typeof value!=='string'||!value.startsWith(prefix))fail('Envie uma foto JPEG válida.');
 const encoded=value.slice(prefix.length);
 if(encoded.length>maxEncodedLength)fail('Cada foto deve ter até 350 KB.',413);
 if(!encoded||encoded.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))fail('Envie uma foto JPEG válida.');
 const bytes=Buffer.from(encoded,'base64');
 if(bytes.length>maxBytes)fail('Cada foto deve ter até 350 KB.',413);
 if(bytes.toString('base64')!==encoded)fail('Envie uma foto JPEG válida.');
 const size=jpegDimensions(bytes);
 if(!size||!size.width||!size.height)fail('Envie uma foto JPEG válida.');
 if(size.width>maxDimension||size.height>maxDimension)fail('Cada lado da foto deve ter até 1.600 pixels.',413);
 return encoded;
}

export function createCourtPhotos(db){
 db.exec(`CREATE TABLE IF NOT EXISTS court_photos(
  id TEXT PRIMARY KEY,
  court_id INTEGER NOT NULL REFERENCES courts(id),
  position INTEGER NOT NULL,
  data_base64 TEXT NOT NULL,
  UNIQUE(court_id,position)
 )`);
 const gallery=db.prepare('SELECT id FROM court_photos WHERE court_id=? ORDER BY position');
 function list(courtId,publicView=false){
  const prefix=publicView?'/api/public/courts':'/api/courts';
  return gallery.all(courtId).map(({id})=>({id,url:`${prefix}/${courtId}/photos/${id}`}));
 }
 function image(courtId,id,publicView=false){
  const row=db.prepare(`SELECT p.data_base64 FROM court_photos p JOIN courts c ON c.id=p.court_id
   WHERE p.court_id=? AND p.id=? AND (c.active=1 OR ?=0)`).get(courtId,id,publicView?1:0);
  if(!row)fail('Foto não encontrada.',404);
  return Buffer.from(row.data_base64,'base64');
 }
 function save(courtId,{photos,expected_ids}){
  if(!Array.isArray(photos)||photos.length>maxPhotos)fail('Adicione até quatro fotos por quadra.');
  if(expected_ids!==undefined&&(!Array.isArray(expected_ids)||expected_ids.length>maxPhotos||expected_ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id))))fail('Identificadores de fotos inválidos.');
  const items=photos.map(photo=>{
   if(!photo||typeof photo!=='object'||Array.isArray(photo))fail('Foto inválida.');
   if(photo.id===undefined)return {data_base64:photoData(photo.data_url)};
   if(typeof photo.id!=='string'||!/^[a-f0-9]{32}$/.test(photo.id)||photo.data_url!==undefined)fail('Foto inválida.');
   return {id:photo.id};
  });
  return transaction(db,()=>{
   if(!db.prepare('SELECT id FROM courts WHERE id=?').get(courtId))fail('Quadra não encontrada.',404);
   const current=db.prepare('SELECT id,data_base64 FROM court_photos WHERE court_id=? ORDER BY position').all(courtId);
   const previous=new Map(current.map(photo=>[photo.id,photo.data_base64]));
   if(expected_ids!==undefined&&(expected_ids.length!==current.length||expected_ids.some((id,index)=>id!==current[index].id))){
    fail('As fotos desta quadra foram alteradas. Reabra a galeria para atualizar a lista.',409);
   }
   const retained=new Set();
   const next=items.map(item=>{
    if(!item.id)return {...item,id:randomBytes(16).toString('hex')};
    if(!previous.has(item.id))fail('A foto não está mais disponível nesta quadra.',409);
    if(retained.has(item.id))fail('A mesma foto aparece mais de uma vez.');
    retained.add(item.id);
    return {id:item.id,data_base64:previous.get(item.id)};
   });
   db.prepare('DELETE FROM court_photos WHERE court_id=?').run(courtId);
   const insert=db.prepare('INSERT INTO court_photos(id,court_id,position,data_base64) VALUES(?,?,?,?)');
   for(const [index,photo] of next.entries())insert.run(photo.id,courtId,index,photo.data_base64);
   return {photos:list(courtId)};
  });
 }
 return {list,image,save};
}
