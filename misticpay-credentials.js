import {Buffer} from 'node:buffer';
import {createHash} from 'node:crypto';

const version = 'v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});
const scopePattern = /^(?:main|child:[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)$/;

function unavailable() {
 return Object.assign(new Error('Não foi possível acessar as credenciais da MisticPay. Confira a chave de proteção no servidor.'), {status: 503});
}

function credentialPair(value) {
 const publicKey = value?.public_key;
 const secretKey = value?.secret_key;
 if (typeof publicKey !== 'string' || !/^pk_[A-Za-z0-9_-]{1,252}$/.test(publicKey) || publicKey.trim() !== publicKey
     || typeof secretKey !== 'string' || !/^sk_[A-Za-z0-9_-]{1,252}$/.test(secretKey) || secretKey.trim() !== secretKey) {
  throw unavailable();
 }
 return {public_key: publicKey, secret_key: secretKey};
}

function decodeBase64Url(value) {
 if (!/^[A-Za-z0-9_-]+$/.test(value)) throw unavailable();
 const bytes = Buffer.from(value, 'base64url');
 if (bytes.toString('base64url') !== value) throw unavailable();
 return bytes;
}

export function misticpayCredentials(key, scope) {
 const secret = typeof key === 'string' ? key.trim() : '';
 let status = 'ready';
 if (!secret) status = 'secret_missing';
 else if (!/^[a-fA-F0-9]{64}$/.test(secret)) status = 'secret_invalid';
 else if (typeof scope !== 'string' || !scopePattern.test(scope) || scope.trim() !== scope) status = 'arena_scope_invalid';
 const ready = status === 'ready';
 const keyBytes = ready ? Buffer.from(secret, 'hex') : null;
 const keyId = keyBytes ? createHash('sha256').update(keyBytes).digest('hex').slice(0,32) : null;
 const additionalData = ready ? encoder.encode(`agendamentos:misticpay:${version}:${scope}`) : null;
 let cipherKey;

 function getCipherKey() {
  if (!ready) throw unavailable();
  cipherKey ??= crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return cipherKey;
 }

 async function seal(credentials) {
  try {
   const encryptionKey = await getCipherKey();
   const plaintext = encoder.encode(JSON.stringify(credentialPair(credentials)));
   const iv = crypto.getRandomValues(new Uint8Array(12));
   const ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData, tagLength: 128}, encryptionKey, plaintext);
   return [version, Buffer.from(iv).toString('base64url'), Buffer.from(ciphertext).toString('base64url')].join('.');
  } catch {
   throw unavailable();
  }
 }

 async function open(envelope) {
  try {
   if (typeof envelope !== 'string' || envelope.length > 1024) throw unavailable();
   const parts = envelope.split('.');
   if (parts.length !== 3 || parts[0] !== version) throw unavailable();
   const iv = decodeBase64Url(parts[1]);
   const ciphertext = decodeBase64Url(parts[2]);
   if (iv.length !== 12 || ciphertext.length <= 16) throw unavailable();
   const plaintext = await crypto.subtle.decrypt(
    {name: 'AES-GCM', iv, additionalData, tagLength: 128}, await getCipherKey(), ciphertext
   );
   return credentialPair(JSON.parse(decoder.decode(plaintext)));
  } catch {
   throw unavailable();
  }
 }

 return {ready, status, keyId, seal, open};
}
