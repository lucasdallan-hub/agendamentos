import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {readReceipt,parseReceiptAmount} from '../receipt-ocr.js';

test('reconhece valor Pix em centavos, com milhares e acentos',()=>{
 assert.deepEqual(parseReceiptAmount('PIX\nValor da transferência\nR$ 1.234,56'),{amount_cents:123456,candidates:[123456]});
 assert.deepEqual(parseReceiptAmount('VALOR DO PIX: 180,00'),{amount_cents:18000,candidates:[18000]});
 assert.equal(parseReceiptAmount('Valor enviado\n\nR$ 45,90').amount_cents,4590);
 assert.equal(parseReceiptAmount('Valor pago: R$\u00a0180,00').amount_cents,18000);
});

test('não confunde taxas, saldo e datas com valor transferido',()=>{
 const text='Comprovante de Pix\n12/11/2026 18:30\nSaldo disponível R$ 1.000,00\nValor pago: R$ 180,00\nTaxa: R$ 3,00';
 assert.deepEqual(parseReceiptAmount(text),{amount_cents:18000,candidates:[18000]});
 assert.deepEqual(parseReceiptAmount('Saldo: R$ 100,00\nTaxa: R$ 1,00'),{amount_cents:null,candidates:[]});
 assert.equal(parseReceiptAmount('Quantidade 180,00\nReferência 12,34').amount_cents,null);
});

test('valores distintos ambíguos exigem conferência; repetições iguais não criam conflito',()=>{
 assert.deepEqual(parseReceiptAmount('Valor pago R$ 180,00\nTotal R$ 150,00'),{amount_cents:null,candidates:[15000,18000]});
 assert.deepEqual(parseReceiptAmount('Pix R$ 180,00\nR$ 100,00'),{amount_cents:null,candidates:[10000,18000]});
 assert.deepEqual(parseReceiptAmount('Valor pago: R$ 180,00\nValor da transferência: R$ 180,00'),{amount_cents:18000,candidates:[18000]});
});

test('mantém ambiguidade de dados malformados e não interpreta números negativos',()=>{
 for(const value of ['Valor R$ 12.34,56','Valor R$ 180,000','Valor R$ -180,00','Valor 0,00','Valor 180.00','Valor 180,00.50'])assert.equal(parseReceiptAmount(value).amount_cents,null,value);
 assert.deepEqual(parseReceiptAmount('Texto ilegível sem valor.'),{amount_cents:null,candidates:[]});
});

test('rejeita arquivo não suportado, MIME incompatível, tamanho excessivo e dimensões perigosas',async()=>{
 await assert.rejects(()=>readReceipt(Buffer.from('not a receipt'),'image/png'),error=>error.status===422);
 const png=await readFile(new URL('./fixtures/pix-receipt.png',import.meta.url));
 await assert.rejects(()=>readReceipt(png,'application/pdf'),error=>error.status===422);
 await assert.rejects(()=>readReceipt(Buffer.alloc(5*1024*1024+1),'image/png'),error=>error.status===413);
 const huge=Buffer.from(png);huge.writeUInt32BE(100000,16);huge.writeUInt32BE(100000,20);
 await assert.rejects(()=>readReceipt(huge,'image/png'),error=>error.status===422);
 await assert.rejects(()=>readReceipt(Buffer.from('%PDF-1.4\ninvalid'),'application/pdf'),error=>error.status===422);
});

test('OCR real lê valor de comprovantes PNG e JPEG fictícios',async()=>{
 for(const [extension,mime] of [['png','image/png'],['jpg','image/jpeg']]){
  const result=await readReceipt(await readFile(new URL(`./fixtures/pix-receipt.${extension}`,import.meta.url)),mime);
  assert.equal(result.amount_cents,18000);
  assert.deepEqual(result.candidates,[18000]);
  assert.match(result.text,/180,00/);
 }
});

test('PDF real: lê texto e usa OCR para documento escaneado',async()=>{
 for(const name of ['pix-receipt.pdf','pix-scanned.pdf']){
  const result=await readReceipt(await readFile(new URL(`./fixtures/${name}`,import.meta.url)),'application/pdf');
  assert.equal(result.amount_cents,18000);
  assert.deepEqual(result.candidates,[18000]);
 }
});
