/* CRM Адвоката — Service Worker для офлайн-работы.
   Кладётся РЯДОМ с файлом приложения (index.html) на том же сайте.
   Кэширует приложение и отдаёт его без интернета.

   Стратегия:
   • Навигация (открытие приложения): сеть-первым → при отсутствии сети
     отдаём страницу из кэша. Так онлайн всегда свежая версия, а офлайн
     приложение всё равно открывается.
   • Остальные GET-запросы (шрифты и т.п.): кэш-первым, обновление в фоне.

   При выходе новой версии приложения поднимите число в CACHE — старый
   кэш очистится автоматически.
*/
const CACHE = 'crm-advocate-v3';
const APP = './';            // index.html (стартовая страница)

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll([APP, './sw.js']).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const isNavigation =
    req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  if (isNavigation) {
    // Сеть-первым: свежая страница онлайн, кэш — запасной вариант офлайн
    e.respondWith(
      fetch(req)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(APP, copy)).catch(() => {});
          return resp;
        })
        .catch(() =>
          caches.match(req).then((r) => r || caches.match(APP))
        )
    );
    return;
  }

  // Прочее: кэш-первым с фоновым обновлением
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((resp) => {
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
