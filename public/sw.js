// The service worker. Its whole job is making the app open instantly, and open
// at all on a bad connection.
//
// It caches the shell — the HTML, the scripts, the stylesheet, the icons — and
// nothing else. Your ideas, scripts, results and trends are NEVER cached: every
// one of those goes to Supabase over the network, every time. Showing yesterday's
// results because the phone was in a lift would be worse than showing nothing.
//
// VERSION is replaced at build time, so every deploy makes a new cache and the
// old one is deleted. Without that, a stale shell can outlive several releases.

const VERSION = '__VR_BUILD__';
const CACHE = `viralradar-shell-${VERSION}`;

// Everything needed to draw the app before any network call happens.
const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/data.js',
  '/styles.css',
  '/vendor/supabase.js',
  '/shared/stats.mjs',
  '/shared/defaults.mjs',
  '/shared/time.mjs',
  '/shared/tokens.mjs',
  '/shared/edit-plan.mjs',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// env.js is deliberately not in that list. It carries the Supabase address and
// key, and a cached copy would survive a deploy that changed them, leaving the
// app pointing somewhere that no longer answers.

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One missing file must not sink the whole install, so they are added one
    // at a time rather than with addAll.
    await Promise.all(SHELL.map(async (path) => {
      try {
        await cache.add(new Request(path, { cache: 'reload' }));
      } catch (e) {
        console.warn(`[sw] could not cache ${path}:`, e);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('viralradar-shell-') && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Anything on another host is Supabase: data, authentication, Realtime,
  // the Edge Functions. None of it is ours to cache or to interfere with.
  if (url.origin !== self.location.origin) return;

  // Configuration is read fresh, falling back to a cached copy only if there is
  // genuinely no network — better a slightly old address than a dead page.
  if (url.pathname === '/env.js') {
    event.respondWith(networkFirst(request));
    return;
  }

  // A navigation should always produce the app, even with no connection.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        return (await caches.match('/index.html')) || Response.error();
      }
    })());
    return;
  }

  // Everything else from this origin is shell: serve it immediately and quietly
  // fetch a newer copy for next time.
  event.respondWith(staleWhileRevalidate(request));
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
    return response;
  } catch {
    return (await caches.match(request)) || Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const fresh = fetch(request).then(async (response) => {
    if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
    return response;
  }).catch(() => null);
  return cached || (await fresh) || Response.error();
}

// The page asks for this after a new version is deployed, so the user does not
// have to close every tab to get it.
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
