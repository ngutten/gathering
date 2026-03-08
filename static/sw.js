// sw.js — Code integrity service worker
// Pins SHA-256 hashes of JS files on first load.
// On subsequent loads, warns if any file has changed.

const CACHE_NAME = 'gathering-integrity-v1';
const HASH_STORE = 'gathering-code-hashes';

// Files to integrity-check (core application code)
const MONITORED_PATTERNS = [
  /\.js$/,
];

// Files to skip (vendor libs that update independently)
const SKIP_PATTERNS = [
  /vendor\//,
  /sw\.js$/,
];

function shouldMonitor(url) {
  const path = new URL(url).pathname;
  if (SKIP_PATTERNS.some(p => p.test(path))) return false;
  return MONITORED_PATTERNS.some(p => p.test(path));
}

async function sha256(data) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getStoredHashes() {
  const cache = await caches.open(HASH_STORE);
  const resp = await cache.match('hashes');
  if (!resp) return null;
  return resp.json();
}

async function storeHashes(hashes) {
  const cache = await caches.open(HASH_STORE);
  await cache.put('hashes', new Response(JSON.stringify(hashes)));
}

// On install, don't wait — activate immediately
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  if (!shouldMonitor(url)) return;

  event.respondWith(handleMonitoredFetch(event.request));
});

async function handleMonitoredFetch(request) {
  const response = await fetch(request);
  if (!response.ok) return response;

  const cloned = response.clone();
  const body = await cloned.arrayBuffer();
  const hash = await sha256(body);
  const path = new URL(request.url).pathname;

  const hashes = await getStoredHashes() || {};
  const isFirstRun = Object.keys(hashes).length === 0;

  if (!hashes[path]) {
    // First time seeing this file — pin it
    hashes[path] = hash;
    await storeHashes(hashes);
  } else if (hashes[path] !== hash) {
    // Hash mismatch — code has changed since we first pinned it
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      client.postMessage({
        type: 'integrity-violation',
        path,
        expected: hashes[path],
        actual: hash,
      });
    }
  }

  return response;
}

// Handle messages from the client
self.addEventListener('message', async (event) => {
  if (event.data && event.data.type === 'accept-update') {
    // User acknowledged the code change — re-pin all current hashes
    const hashes = await getStoredHashes() || {};
    if (event.data.path) {
      // Accept a single file
      hashes[event.data.path] = event.data.hash;
    } else {
      // Accept all — clear and re-pin on next load
      await storeHashes({});
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) {
        client.postMessage({ type: 'hashes-reset' });
      }
      return;
    }
    await storeHashes(hashes);
  } else if (event.data && event.data.type === 'get-hashes') {
    const hashes = await getStoredHashes() || {};
    event.source.postMessage({ type: 'stored-hashes', hashes });
  }
});
