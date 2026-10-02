/* Next GPT: isolated offline shell, no customer data cached. */
const PREFIX = 'crm-next-gpt-v';
const CACHE = PREFIX + '1';
const BASE = new URL('./', self.location.href);
const START = new URL('index.html', BASE).href;
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const response = await fetch(new Request(START, { cache: 'reload', credentials: 'omit' }));
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) throw new Error('Next GPT shell unavailable');
    const cache = await caches.open(CACHE);
    await cache.put(START, response);
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    if (!await cache.match(START)) throw new Error('Next GPT offline shell missing');
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const req = event.request, url = new URL(req.url);
  if (req.method !== 'GET' || req.mode !== 'navigate' || url.origin !== BASE.origin || ![BASE.pathname, new URL(START).pathname].includes(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(req);
      if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
        const copy = response.clone();
        event.waitUntil(cache.put(START, copy));
        return response;
      }
      return await cache.match(START) || response;
    } catch (error) {
      return await cache.match(START) || new Response('Next GPT: откройте приложение с интернетом для первой загрузки.', { status: 503, headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
    }
  })());
});
