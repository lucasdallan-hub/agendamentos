import {resolve} from 'node:path';
import {unstable_startWorker} from 'wrangler';

const worker = await unstable_startWorker({
 config: resolve('wrangler.jsonc'),
 dev: {
  server: {
   hostname: process.env.ARENA_HOST || '127.0.0.1',
   port: Number(process.env.ARENA_PORT || 8787)
  },
  persist: resolve(process.env.ARENA_PERSIST_TO || '.wrangler/state'),
  watch: true,
  inspector: false,
  async outboundService(request) {
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
