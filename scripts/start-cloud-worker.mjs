import {resolve} from 'node:path';
import {unstable_startWorker} from 'wrangler';
import {handleReceiptRequest} from '../cloudflare/ocr-server.js';
import {nativeOCRAvailable} from '../receipt-ocr.js';

const localOCR=nativeOCRAvailable();
const localOCROrigin='https://receipt-ocr.invalid';
const bindings=localOCR?{
 RECEIPT_OCR_URL:{type:'plain_text',value:localOCROrigin},
 RECEIPT_OCR_TOKEN:{type:'secret_text',value:'local-receipt-ocr'}
}:{};


const worker = await unstable_startWorker({
 config: resolve('wrangler.jsonc'),
 bindings,
 dev: {
  server: {
   hostname: process.env.ARENA_HOST || '127.0.0.1',
   port: Number(process.env.ARENA_PORT || 8787)
  },
  persist: resolve(process.env.ARENA_PERSIST_TO || '.wrangler/state'),
  watch: true,
  inspector: false,
  async outboundService(request) {
   if(localOCR&&request.url===localOCROrigin+'/read')return handleReceiptRequest(request);
   // Node uses the environment's HTTPS proxy. Keep redirects visible to the
   // Worker so provider credentials stay on the configured origin.
   return fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    duplex: 'half',
    redirect: 'manual',
    signal: request.signal
   });
  }
 }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
 process.once(signal, async () => {
  await worker.dispose();
 });
}
await worker.ready;
console.log('Worker local:', (await worker.url).origin);
