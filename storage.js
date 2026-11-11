// Keep synchronous business transactions atomic on both Node SQLite and Durable Objects.
export function transaction(db,callback){
 if(typeof db.transaction==='function')return db.transaction(callback);
 db.exec('BEGIN IMMEDIATE');
 try{const result=callback();db.exec('COMMIT');return result;}
 catch(error){db.exec('ROLLBACK');throw error;}
}
