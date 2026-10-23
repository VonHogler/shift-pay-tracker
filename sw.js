// sw.js — Service Worker for ShiftComp
// SW_VERSION is reported to the page (see 'message' handler below) so the
// "Update available" banner/Settings line can show a real version number.
// Bump this alongside APP_VERSION in index.html on every release.
const SW_VERSION = '0.9.2';
const CACHE_NAME = 'shiftpay-v1';
const ASSETS = [
  '/shift-pay-tracker/',
  '/shift-pay-tracker/index.html',
  '/shift-pay-tracker/manifest.json',
  '/shift-pay-tracker/icons/icon-192.png',
  '/shift-pay-tracker/icons/icon-512.png',
  '/shift-pay-tracker/shiftcomp-wordmark.svg',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  // Deliberately NOT calling self.skipWaiting() here. A newly-installed
  // worker now stays in the "waiting" state until the page explicitly
  // tells it to take over (via the SKIP_WAITING message below). That's
  // what lets index.html show an "Update available" prompt and let the
  // user choose when to reload, instead of the app silently swapping out
  // from under an open tab.
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

self.addEventListener('message', event => {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (event.data.type === 'GET_VERSION' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ version: SW_VERSION });
  }
});