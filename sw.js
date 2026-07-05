/* CRM Адвоката — Service Worker для надёжной офлайн-работы.
   Кладётся РЯДОМ с файлом приложения (index.html) на том же сайте.

   Что делает:
   • При установке кэширует стартовую страницу (по нескольким адресам сразу),
     чтобы приложение точно открывалось без интернета.
   • Навигация (открытие приложения): сначала сеть (свежая версия онлайн),
     при отсутствии сети — стартовая страница из кэша. Адреса с разными
     «хвостами» (?utm=…, /index.html, /) сводятся к одному ключу — поэтому
     офлайн срабатывает независимо от того, как открыли приложение.
   • Остальные запросы (шрифты и пр.): кэш-первым, обновление в фоне.

   При выходе новой версии приложения поднимите число в CACHE.
*/
const CACHE = 'crm-advocate-v5';

// Базовый адрес каталога, где лежит SW (работает и в подпапке, и в корне)
const BASE = new URL('./', self.location).pathname;
const START_URLS = [BASE, BASE + 'index.html'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.allSettled(START_URLS.map((u) => c.add(new Request(u, { cache: 'reload' }))));
    // Новая версия НЕ активируется сама — ждёт подтверждения из приложения
    // (баннер «Доступна новая версия»), чтобы не перезагружать экран посреди работы.
  })());
});

// Активация новой версии по нажатию кнопки «Обновить» в приложении
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.disable(); } catch (e) {}
    }
    await self.clients.claim();
  })());
});

async function cachedStart() {
  const c = await caches.open(CACHE);
  for (const u of START_URLS) {
    const r = await c.match(u);
    if (r) return r;
  }
  const any = await c.match(BASE, { ignoreSearch: true });
  return any || undefined;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  const isNavigation =
    req.mode === 'navigate' ||
    (sameOrigin && (req.headers.get('accept') || '').includes('text/html'));

  if (isNavigation) {
    e.respondWith((async () => {
      try {
        const resp = await fetch(req);
        if (resp && resp.ok) {
          const c = await caches.open(CACHE);
          c.put(BASE, resp.clone()).catch(() => {});
          c.put(BASE + 'index.html', resp.clone()).catch(() => {});
        }
        return resp;
      } catch (err) {
        const cached = await cachedStart();
        if (cached) return cached;
        return new Response(
          '<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:24px;color:#333">Приложение ещё не закэшировано для офлайна. Откройте его один раз при наличии интернета.</body>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
    })());
    return;
  }

  e.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req)
      .then((resp) => {
        if (resp && resp.ok) {
          caches.open(CACHE).then((c) => c.put(req, resp.clone())).catch(() => {});
        }
        return resp;
      })
      .catch(() => cached);
    return cached || network;
  })());
});
