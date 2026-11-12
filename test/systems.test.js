import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createApplication} from '../server-core.js';
import {captureSystem,createChild,installSystem,branding,saveBranding,updateChildDomain} from '../systems.js';

function database(t){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
 createApplication({db,paymentConfig:{ready:false,mode:'test'},receiptReader:async()=>({amount_cents:null})});
 t.after(()=>db.close());return db;
}
test('sistemas: cópia integral conserva dados financeiros e BLOBs, sem sessões ou senha da mãe',async t=>{
 const mother=database(t),child=database(t);
 mother.exec(`INSERT INTO courts VALUES(1,'Quadra', 'Areia',10000,1);
 INSERT INTO bookings VALUES(1,1,'Cliente','11999999999','2026-12-01','18:00','19:00',10000,'confirmed',1,'Pix','2026-12-01','Observação');
 INSERT INTO payment_orders VALUES('order-1',1,'pref-1','https://www.mercadopago.com.br/checkout','approved','2026-12-02','2026-12-01');
 INSERT INTO provider_payments VALUES('payment-1','order-1','approved',10000,0,'2026-12-01');
 INSERT INTO pix_settings VALUES(1,'pix@example.com','Arena');
 INSERT INTO pix_links VALUES(1,'private-token','2026-12-08','pix@example.com','Arena');
 INSERT INTO admin VALUES(1,'mother-salt','mother-hash');`);
 mother.prepare("INSERT INTO pix_receipts VALUES(1,1,'comprovante.png','image/png',?,'hash',10000,'matched','approved','2026-12-01','Conferido','2026-12-01')").run(Buffer.from([1,2,3]));
 mother.prepare("INSERT INTO financial_connection VALUES(1,'mother-token','mother-webhook','https://mother.example.com','test','mother-account')").run();
 mother.systemProvisioner=async payload=>installSystem(child,payload);
 const original=captureSystem(mother);
 await createChild(mother,{slug:'centro',hostname:'centro.example.com',name:'Filho',password:'password-child-123'},'mae.example.com');
 assert.deepEqual(captureSystem(child).tables,original.tables);
 assert.equal(branding(child).is_mother,false);
 assert.equal(child.prepare('SELECT COUNT(*) AS count FROM financial_connection').get().count,0);
 assert.notEqual(child.prepare('SELECT hash FROM admin').get().hash,'mother-hash');
 child.prepare("UPDATE courts SET name='Só no filho'").run();
 assert.equal(mother.prepare('SELECT name FROM courts').get().name,'Quadra');
 assert.throws(()=>installSystem(mother,{slug:'x',name:'x',password:'123',snapshot:original}),/já contém dados/);
 await assert.rejects(createChild(child,{slug:'neto'},'centro.example.com'),/Somente/);
 await assert.rejects(createChild(mother,{slug:'centro',hostname:'outra.example.com',name:'Outro',password:'password-child-123'},'mae.example.com'),/já foi cadastrado/);
 assert.throws(()=>updateChildDomain(mother,'centro','mae.example.com'),/sistema mãe/);
 assert.equal(updateChildDomain(mother,'centro','nova.example.com').hostname,'nova.example.com');
 assert.throws(()=>saveBranding(child,{name:'Filho',logo:'data:image/svg+xml;base64,PHN2Zz4='}),/PNG ou JPEG/);
 assert.throws(()=>saveBranding(child,{name:'Filho',logo:'data:image/png;base64,YWJj'}),/conteúdo/);
});
