import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {workerReceiptReader} from '../cloudflare/receipt-reader.js';
import {parseReceiptAmount} from '../receipt-amount.js';
import {nativeReceiptReader} from '../receipt-ocr.js';

test('extrai o valor Pix rotulado em centavos e ignora saldo, taxas e referências',()=>{
 assert.equal(parseReceiptAmount('Valor da transferência\nR$ 1.234,56\nSaldo R$ 5.000,00\nTarifa R$ 3,00'),123456);
 assert.equal(parseReceiptAmount('Data: 12/11/2026 18:30\nValor do Pix: 180,00\nR$ 2.000,00'),18000);
 assert.equal(parseReceiptAmount('Valor pago R$\u00a0180,00\nValor enviado R$ 180,00'),18000);
 assert.equal(parseReceiptAmount('Saldo: R$ 500,00 Valor pago: R$ 40,00 Taxa: R$ 1,00'),4000);
 assert.equal(parseReceiptAmount('R$\n160,00'),16000);
 assert.equal(parseReceiptAmount('Saldo\nR$ 180,00\nTarifa: R$ 3,00'),null);
 assert.equal(parseReceiptAmount('R$ 2,00 de tarifa'),null);
});

test('mantém valores ambíguos ou malformados como ilegíveis',()=>{
 for(const text of [
  'Valor pago: R$ 180,00\nTotal: R$ 150,00',
  'R$ 180,00\nR$ 100,00',
  'Valor: R$ 12.34,56',
  'Valor: R$ 180,001',
  'Valor: R$ -180,00',
  'Valor: R$ 0,00',
  'Valor: R$ 180.00',
  'Valor: R$ 180,00.50',
  'Valor: EUR 180,00',
  'PIX sem valor visível'
 ])assert.equal(parseReceiptAmount(text),null,text);
});

test('Worker extrai valores de imagens e PDFs sem usar o preço da reserva',async()=>{
 const image=Buffer.from([137,80,78,71]);
 const pdf=Buffer.from('%PDF- fixture');
 let answer='R$ 1.234,56',amount=6000;
 let calls=0;
 const reader=workerReceiptReader({
  async readImage(bytes,mime){
   calls++;
   assert.deepEqual(bytes,image);
   assert.equal(mime,'image/png');
   return answer;
  },
  async readPdf(bytes){
   assert.deepEqual(bytes,pdf);
   return {amount,images:[]};
  }
 });
 assert.equal(await reader(image,'image/png'),123456);
 assert.equal(await reader(pdf,'application/pdf'),6000);
 answer='R$ 600,00 ou R$ 60,00';
 assert.equal(await reader(image,'image/png'),null);
 answer='ILEGÍVEL';
 assert.equal(await reader(image,'image/png'),null);
 amount=null;
 assert.equal(await reader(pdf,'application/pdf'),null);
 assert.equal(await reader(image,'image/webp'),null);
 assert.equal(calls,3);
});

test('Worker lê imagens renderizadas de PDF sem texto e rejeita valores conflitantes',async()=>{
 const images=[Buffer.of(1),Buffer.of(2)];
 let answers=['R$ 80,00','ILEGÍVEL'];
 const reader=workerReceiptReader({
  async readImage(bytes,mime){
   assert.ok(images.includes(bytes));
   assert.equal(mime,'image/png');
   return answers.shift();
  },
  async readPdf(){return {amount:null,images};}
 });
 assert.equal(await reader(Buffer.of(1),'application/pdf'),8000);
 answers=['R$ 80,00','R$ 90,00'];
 assert.equal(await reader(Buffer.of(1),'application/pdf'),null);
});

test('Worker reporta falha da leitura sem expor o conteúdo do comprovante',async()=>{
 const reader=workerReceiptReader({
  async readImage(){throw new Error('conteúdo privado do comprovante');}
 });
 await assert.rejects(reader(Buffer.of(1),'image/png'),/^Error: Leitura automática temporariamente indisponível\.$/);
});

const native=nativeReceiptReader();
const fixture=name=>readFile(new URL(`./fixtures/${name}`,import.meta.url));

test('OCR nativo lê comprovantes fictícios PNG e JPEG', {skip:!native}, async()=>{
 assert.equal(await native(await fixture('pix-receipt.png'),'image/png'),18000);
 assert.equal(await native(await fixture('pix-receipt.jpg'),'image/jpeg'),18000);
});

test('OCR nativo lê PDF textual e PDF escaneado', {
 skip:!native||['pdftotext','pdftoppm'].some(cmd=>spawnSync(cmd,['-v'],{stdio:'ignore',timeout:3000}).status!==0)
},async()=>{
 assert.equal(await native(await fixture('pix-receipt.pdf'),'application/pdf'),18000);
 assert.equal(await native(await fixture('pix-scanned.pdf'),'application/pdf'),18000);
 assert.equal(await native(Buffer.from('%PDF- corrupto'),'application/pdf'),null);
});
