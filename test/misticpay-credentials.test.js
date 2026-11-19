import assert from 'node:assert/strict';
import test from 'node:test';
import {misticpayCredentials} from '../misticpay-credentials.js';

const key = 'a1'.repeat(32);
const pair = {public_key: 'pk_public_fixture', secret_key: 'sk_private_fixture'};

function protectsCredentials(error) {
 assert.equal(error.status, 503);
 assert.doesNotMatch(error.message, /public_fixture|private_fixture/);
 return true;
}

test('MisticPay: protege as duas credenciais com envelopes diferentes para o mesmo par', async () => {
 const store = misticpayCredentials(key, 'main');
 assert.equal(store.ready, true);
 const first = await store.seal(pair);
 const second = await store.seal(pair);
 assert.match(first, /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
 assert.doesNotMatch(first, /public_fixture|private_fixture/);
 assert.notEqual(first.split('.')[1], second.split('.')[1]);
 assert.deepEqual(await store.open(first), pair);
 assert.deepEqual(await store.open(second), pair);
});

test('MisticPay: rejeita adulteração, chave errada e envelope de outra arena', async () => {
 const store = misticpayCredentials(key, 'child:arena-1');
 const envelope = await store.seal(pair);
 const [version, iv, ciphertext] = envelope.split('.');
 const changed = (ciphertext[0] === 'A' ? 'B' : 'A') + ciphertext.slice(1);
 await assert.rejects(store.open([version, iv, changed].join('.')), protectsCredentials);
 await assert.rejects(store.open(['v2', iv, ciphertext].join('.')), protectsCredentials);
 await assert.rejects(misticpayCredentials('b2'.repeat(32), 'child:arena-1').open(envelope), protectsCredentials);
 await assert.rejects(misticpayCredentials(key, 'child:arena-2').open(envelope), protectsCredentials);
});

test('MisticPay: exige chave hexadecimal de 32 bytes, escopo e credenciais válidas', async () => {
 const store = misticpayCredentials(key, 'main');
 const envelope = await store.seal(pair);
 for (const invalidKey of [undefined, '', 'a'.repeat(63), 'g'.repeat(64), key + '\n']) {
  const invalid = misticpayCredentials(invalidKey, 'main');
  assert.equal(invalid.ready, false);
  await assert.rejects(invalid.seal(pair), protectsCredentials);
  await assert.rejects(invalid.open(envelope), protectsCredentials);
 }
 assert.equal(misticpayCredentials(key, 'child:').ready, false);
 await assert.rejects(store.seal({...pair, secret_key: pair.secret_key + '\n'}), protectsCredentials);
 await assert.rejects(store.open(JSON.stringify(pair)), protectsCredentials);
});
