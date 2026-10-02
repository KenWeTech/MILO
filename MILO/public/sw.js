const CACHE_NAME = 'milo-pwa-v2';
const PRECACHE_ASSETS = [
  '/offline.html',
  '/assets/logo.png',
  '/js/login-phrase.js',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(PRECACHE_ASSETS);

      try {
        const twReq = new Request('https://cdn.tailwindcss.com', { mode: 'no-cors' });
        const twRes = await fetch(twReq);
        if (twRes) await cache.put(twReq, twRes);
      } catch (e) {
        console.warn('Tailwind precache skipped.', e);
      }
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET' && request.method !== 'HEAD') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => {
          return caches.match('/offline.html');
        })
    );
    return;
  }

  if (request.url.includes('/api/')) {
    event.respondWith(
      fetch(request).catch(() => {
        return new Response(
          JSON.stringify({ error: 'Network unavailable', offline: true }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const fetchPromise = fetch(request).then((networkResponse) => {
        if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
          caches.open(CACHE_NAME).then((cache) => cache.put(request, networkResponse.clone()));
        }
        return networkResponse;
      });

      return cachedResponse || fetchPromise.catch(() => new Response('Offline', { status: 503 }));
    })
  );
});
