const CACHE_NAME = 'milo-pwa-v1';
const PRECACHE_ASSETS = [
  '/offline.html',
  '/assets/logo.png',
  '/js/login-phrase.js',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {

          if (!response.ok && response.status >= 500) {
            return caches.match('/offline.html');
          }
          return response;
        })
        .catch(() => caches.match('/offline.html')) 
    );
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (!response.ok && response.status >= 500) {
            throw new Error("Proxy Server Error");
          }
          return response;
        })
        .catch(() => 
          new Response(
            JSON.stringify({ error: 'Network unavailable', offline: true }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          )
        )
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const fetchPromise = fetch(request)
        .then((networkResponse) => {
          if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, responseToCache));
          }
          return networkResponse;
        })
        .catch(() => {

          if (cachedResponse) return cachedResponse;
          return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
        });

      return cachedResponse || fetchPromise;
    })
  );
});
