/* FinBoard v2 app shell.
   Navigations and index.html are network-first so a deploy is not stuck on a stale page.
   GitHub Gist responses, decrypted payloads, and other personal API calls are never cached. */
'use strict';
const CACHE = 'finboard-v2-shell-2';
const SHELL = [
  './',
  './index.html',
  './lookthrough.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  '../assets/finboard-crypto.js'
];

function sensitive(url) {
  const h = url.hostname;
  if (h === 'api.github.com' || h === 'gist.githubusercontent.com') return true;
  if (h.endsWith('githubusercontent.com')) return true;
  if (h === 'generativelanguage.googleapis.com') return true;
  if (h === 'spoo.me' || h === 'api.coingecko.com' || h === 'open.er-api.com' || h === 'data.gov.il') return true;
  return false;
}

function isDocument(req, url) {
  if (req.mode === 'navigate') return true;
  const p = url.pathname;
  return /\/index\.html$/.test(p) || /\/v2\/?$/.test(p);
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Cache keys never keep a URL fragment. Tzofik share payloads live in the hash and must not be stored. */
function normalized(req) {
  const u = new URL(req.url);
  u.hash = '';
  u.searchParams.delete('s');
  return new Request(u.toString(), { method: 'GET' });
}

async function networkFirst(req, fallbackDoc) {
  const cache = await caches.open(CACHE);
  const key = normalized(req);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok && fresh.type !== 'opaque') cache.put(key, fresh.clone());
    return fresh;
  } catch (e) {
    const hit = (await cache.match(key))
      || (fallbackDoc ? await cache.match('./index.html') : null)
      || (fallbackDoc ? await cache.match('./') : null);
    if (hit) return hit;
    throw e;
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const fetching = fetch(req).then(res => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  }).catch(() => hit);
  return hit || fetching;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (sensitive(url)) return;
  if (url.origin === self.location.origin) {
    if (url.pathname.endsWith('.json')) return;
    event.respondWith(networkFirst(req, isDocument(req, url)));
    return;
  }
  if (/(^|\.)jsdelivr\.net$|(^|\.)fonts\.googleapis\.com$|(^|\.)fonts\.gstatic\.com$/.test(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req));
  }
});
