'use strict';

const CACHE_PREFIX = 'milo-pwa-';
const CACHE_NAME = `${CACHE_PREFIX}v2`;
const OFFLINE_PAGE = '/offline.html';
const NAVIGATION_TIMEOUT_MS = 4000;
const PRECACHE_TIMEOUT_MS = 4000;
const PRECACHE_ASSETS = [
  OFFLINE_PAGE,
  '/assets/logo.png',
  '/js/login-phrase.js',
  '/manifest.json'
];

function fallbackOfflineResponse() {

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#000012">
  <title>MILO Offline</title>
</head>
<body style="margin:0;min-height:100vh;box-sizing:border-box;display:flex;align-items:center;justify-content:center;background:#000;color:#f1f2f6;font:16px system-ui,sans-serif;padding:1.5rem">
  <main style="width:100%;max-width:26rem;box-sizing:border-box;text-align:center;background:#000012;border:1px solid #216281;border-radius:1rem;padding:2rem">
    <h1 style="margin:0 0 1rem;font-size:1.5rem">MILO is offline</h1>
    <p id="offline-status" aria-live="polite" style="color:#b4b7c5;line-height:1.6">The server could not be reached. Check your network, then try again.</p>
    <button id="offline-retry" type="button" style="margin-top:1rem;background:#2c53ca;color:#fff;border:0;border-radius:.5rem;padding:.8rem 1.2rem;font:inherit;cursor:pointer">Try Again</button>
  </main>
  <script>
    (() => {
      const status = document.getElementById('offline-status');
      const button = document.getElementById('offline-retry');
      let checking = false;
      async function checkConnection() {
        if (checking) return;
        checking = true;
        button.disabled = true;
        button.style.opacity = '.65';
        status.textContent = 'Trying to connect again…';
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2500);
        try {
          const response = await fetch('/?ping=' + Date.now(), {
            method: 'HEAD', cache: 'no-store', signal: controller.signal
          });
          if (response.ok || response.status < 500) {
            status.textContent = 'Reconnected. Loading MILO…';
            window.location.replace('/');
            return;
          }
          throw new Error('Server unavailable');
        } catch (_) {
          status.textContent = 'Still offline. Check your network and try again.';
        } finally {
          clearTimeout(timeoutId);
          checking = false;
          button.disabled = false;
          button.style.opacity = '1';
        }
      }
      button.addEventListener('click', checkConnection);
      window.addEventListener('online', checkConnection);
    })();
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

async function fetchWithTimeout(input, timeoutMs, init = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function findOfflinePage() {
  try {
    return await caches.match(OFFLINE_PAGE);
  } catch (_) {
    return undefined;
  }
}

async function getOfflinePage() {
  const cachedPage = await findOfflinePage();
  return cachedPage || fallbackOfflineResponse();
}

async function precacheAsset(cache, asset) {
  try {
    const response = await fetchWithTimeout(asset, PRECACHE_TIMEOUT_MS, { cache: 'reload' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await cache.put(asset, response);
    return true;
  } catch (error) {

    try {
      const priorResponse = await caches.match(asset);
      if (priorResponse) {
        await cache.put(asset, priorResponse.clone());
        return true;
      }
    } catch (_) {

    }
    console.warn(`[MILO SW] Could not precache ${asset}: ${error && error.message ? error.message : error}`);
    return false;
  }
}

function isLocalStaticAsset(request, url) {
  if (url.origin !== self.location.origin) return false;
  if (request.method !== 'GET' || request.mode === 'navigate') return false;
  if (url.pathname.startsWith('/api/')) return false;

  if (url.pathname === '/manifest.json' || url.pathname === '/favicon.ico') return true;

  const inStaticDirectory = ['/assets/', '/js/', '/css/', '/fonts/']
    .some((prefix) => url.pathname.startsWith(prefix));
  const hasStaticExtension = /\.(?:css|mjs|js|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|avif)$/i
    .test(url.pathname);

  return inStaticDirectory && hasStaticExtension;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    await Promise.all(PRECACHE_ASSETS.map((asset) => precacheAsset(cache, asset)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const currentCache = await caches.open(CACHE_NAME);
    const currentOfflinePage = await currentCache.match(OFFLINE_PAGE);

    if (currentOfflinePage) {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
        .map((name) => caches.delete(name)));
    } else {
      console.warn('[MILO SW] Keeping older MILO caches because offline.html is not in the new cache.');
    }

    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  let url;
  try {
    url = new URL(request.url);
  } catch (_) {
    return;
  }

  if (url.origin !== self.location.origin) return;

  if (request.method !== 'GET') {
    if (url.pathname.startsWith('/api/')) {
      event.respondWith(fetch(request).catch(() => new Response(
        JSON.stringify({
          success: false,
          message: 'Action failed: You are currently offline.',
          offline: true
        }),
        {
          status: 503,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
          }
        }
      )));
    }
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetchWithTimeout(request, NAVIGATION_TIMEOUT_MS);
        if (!response.ok && response.status >= 500) return getOfflinePage();
        return response;
      } catch (_) {
        return getOfflinePage();
      }
    })());
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request)
      .then((response) => {
        if (!response.ok && response.status >= 500) throw new Error('Server unavailable');
        return response;
      })
      .catch(() => new Response(
        JSON.stringify({ success: false, error: 'Network unavailable', offline: true }),
        {
          status: 503,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
          }
        }
      )));
    return;
  }

  if (!isLocalStaticAsset(request, url)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cachedResponse = await cache.match(request);
    const refreshPromise = fetch(request).then(async (networkResponse) => {
      if (networkResponse && networkResponse.ok && networkResponse.type === 'basic') {
        try {
          await cache.put(request, networkResponse.clone());
        } catch (error) {
          console.warn(`[MILO SW] Could not cache ${url.pathname}: ${error && error.message ? error.message : error}`);
        }
      }
      return networkResponse;
    });

    if (cachedResponse) {
      event.waitUntil(refreshPromise.then(() => undefined).catch(() => undefined));
      return cachedResponse;
    }

    try {
      return await refreshPromise;
    } catch (_) {
      return new Response('Offline', {
        status: 503,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store'
        }
      });
    }
  })());
});
