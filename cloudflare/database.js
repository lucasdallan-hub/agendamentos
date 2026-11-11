import {Buffer} from 'node:buffer';

function binding(value) {
 if(value instanceof ArrayBuffer)return value;
 if(ArrayBuffer.isView(value))return value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength);
 if(value===undefined)return null;
 return value;
}

function row(value) {
 if(!value)return undefined;
 return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,item instanceof ArrayBuffer?Buffer.from(item):item]));
}

/** DatabaseSync-compatible synchronous surface backed by durable SQLite. */
export class DurableDatabase {
 constructor(storage) {this.storage=storage;this.sql=storage.sql;}
 exec(query) {this.sql.exec(query).toArray();}
 prepare(query) {
  const execute=(values)=>this.sql.exec(query,...values.map(binding));
  return {
   get:(...values)=>row(execute(values).toArray()[0]),
   all:(...values)=>execute(values).toArray().map(row),
   run:(...values)=>{
    execute(values).toArray();
    const result=this.sql.exec('SELECT changes() AS changes,last_insert_rowid() AS lastInsertRowid').one();
    return {changes:result.changes,lastInsertRowid:result.lastInsertRowid};
   }
  };
 }
 transaction(callback) {return this.storage.transactionSync(callback);}
}

/** Sessions and login throttles survive eviction of the Durable Object. */
export class DurableMap {
 constructor(db,kind) {
  this.db=db;this.kind=kind;
  db.exec('CREATE TABLE IF NOT EXISTS edge_state(kind TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(kind,key))');
 }
 get(key) {
  const entry=this.db.prepare('SELECT value,expires_at FROM edge_state WHERE kind=? AND key=?').get(this.kind,String(key));
  if(!entry)return undefined;
  if(entry.expires_at<=Date.now()){this.delete(key);return undefined;}
  return JSON.parse(entry.value);
 }
 set(key,value) {
  const expires=typeof value==='number'?value:value.until;
  this.db.prepare('DELETE FROM edge_state WHERE expires_at<=?').run(Date.now());
  this.db.prepare('INSERT INTO edge_state(kind,key,value,expires_at) VALUES(?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at').run(this.kind,String(key),JSON.stringify(value),expires);
  return this;
 }
 delete(key) {return this.db.prepare('DELETE FROM edge_state WHERE kind=? AND key=?').run(this.kind,String(key)).changes>0;}
}
