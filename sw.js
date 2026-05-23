const CACHE_VERSION = '20260521-pwa-1';
const SHELL_CACHE = `gr-shell-${CACHE_VERSION}`;
const DATA_CACHE = `gr-data-${CACHE_VERSION}`;
const CDN_CACHE = `gr-cdn-${CACHE_VERSION}`;

const APP_SHELL = [
  '/index.html',
  '/gr.html',
  '/style.css',
  '/index.js',
  '/data.js',
  '/gr-metadata.js',
  '/region-geometry.js',
  '/gr-region-cache.js',
  '/gr-route-cache-manifest.js',
  '/stations-sncf.js',
  '/logo.png',
  '/site-logo.svg',
  '/manifest.webmanifest',
  '/offline.html'
];

const APP_SHELL_PATHS = new Set(APP_SHELL);
const CDN_HOSTS = new Set(['unpkg.com']);
const PASSTHROUGH_HOSTS = new Set([
  'api.open-meteo.com',
  'overpass.kumi.systems',
  'overpass.openstreetmap.fr',
  'overpass-api.de'
]);

function normalizePathname(pathname) {
  return pathname === '/' ? '/index.html' : pathname;
}

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function getCacheKey(request) {
  const url = new URL(request.url);
  if (!isSameOrigin(url)) {
    return request;
  }
  return `${self.location.origin}${normalizePathname(url.pathname)}`;
}

function isCacheableResponse(response) {
  return Boolean(response) && (response.ok || response.type === 'opaque');
}

async function putInCache(cacheName, request, response) {
  if (!isCacheableResponse(response)) {
    return;
  }

  const cache = await caches.open(cacheName);
  await cache.put(getCacheKey(request), response.clone());
}

async function readFromCache(cacheName, request) {
  const cache = await caches.open(cacheName);
  const cacheKey = getCacheKey(request);
  return cache.match(cacheKey) || cache.match(request, { ignoreSearch: true });
}

async function matchShellPath(pathname) {
  const cache = await caches.open(SHELL_CACHE);
  const absoluteKey = new URL(pathname, self.location.origin).href;
  return cache.match(absoluteKey) || cache.match(pathname);
}

async function staleWhileRevalidate(request, cacheName) {
  const cachedResponse = await readFromCache(cacheName, request);
  const networkPromise = fetch(request)
    .then(async response => {
      await putInCache(cacheName, request, response);
      return response;
    })
    .catch(() => null);

  if (cachedResponse) {
    return cachedResponse;
  }

  const networkResponse = await networkPromise;
  if (networkResponse) {
    return networkResponse;
  }

  throw new Error('Network unavailable');
}

async function networkWithCacheFallback(request, cacheName) {
  try {
    const response = await fetch(request);
    await putInCache(cacheName, request, response);
    return response;
  } catch (error) {
    const cachedResponse = await readFromCache(cacheName, request);
    if (cachedResponse) {
      return cachedResponse;
    }
    throw error;
  }
}

async function handleNavigation(request) {
  try {
    const response = await fetch(request);
    await putInCache(SHELL_CACHE, request, response);
    return response;
  } catch {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/gr.html') {
      return (await matchShellPath('/gr.html')) || (await matchShellPath('/offline.html'));
    }

    return (await matchShellPath('/index.html')) || (await matchShellPath('/offline.html'));
  }
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  const validCaches = new Set([SHELL_CACHE, DATA_CACHE, CDN_CACHE]);
  event.waitUntil(
    caches.keys()
      .then(cacheNames => Promise.all(
        cacheNames
          .filter(cacheName => !validCaches.has(cacheName))
          .map(cacheName => caches.delete(cacheName))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (PASSTHROUGH_HOSTS.has(url.hostname) || url.hostname.endsWith('.cartocdn.com')) {
    return;
  }

  if (isSameOrigin(url)) {
    if (url.pathname.startsWith('/route-cache/')) {
      event.respondWith(networkWithCacheFallback(request, DATA_CACHE));
      return;
    }

    if (APP_SHELL_PATHS.has(normalizePathname(url.pathname))) {
      event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
      return;
    }

    event.respondWith(networkWithCacheFallback(request, DATA_CACHE));
    return;
  }

  if (CDN_HOSTS.has(url.hostname)) {
    event.respondWith(staleWhileRevalidate(request, CDN_CACHE));
  }
});