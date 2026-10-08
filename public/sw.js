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

// Where a share from Android's Share menu waits until the page can deal with
// it. Not versioned like the shell cache: something shared seconds before a
// deploy must still be there afterwards.
//
// Cache Storage rather than IndexedDB because both the worker and the page can
// reach it with no helper code at all, and because it stores a Blob as it is —
// which is exactly what a shared image is. See SHARE_PREFIX in app.js: the two
// have to agree on these two strings and nothing else.
const SHARE_CACHE = 'viralradar-shared';
const SHARE_PREFIX = '/shared-inbox/';

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
  '/shared/projects.mjs',
  '/shared/learning.mjs',
  '/shared/sha256.mjs',
  '/shared/transfer.mjs',
  '/shared/research.mjs',
  '/transfer.js',
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
      // Only the shell caches. SHARE_CACHE is deliberately not matched: a
      // share that arrived moments before a deploy must survive it.
      if (name.startsWith('viralradar-shell-') && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

// ---------- Web Share Target ----------
//
// With share_target in the manifest, ViralRadar appears in Android's Share
// menu. Choosing it POSTs here — to this worker, not to a server, because there
// is no server of ours. Netlify would answer a POST to a static site with a
// 405, so if the worker is not installed the share simply does not work; there
// is nothing to break.
//
// The worker cannot do the real work: writing to Supabase needs the signed-in
// session, which lives in the page. So it parks the payload in a cache and
// sends the browser to the app, which drains it. That also means a share while
// the phone has no signal is not lost — it waits until the app next opens.
async function receiveShare(request) {
  const landing = '/#/projects?shared=1';
  try {
    const form = await request.formData();
    const cache = await caches.open(SHARE_CACHE);
    const id = `${Date.now()}-${(crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2))}`;

    // The three text fields the manifest asks for. A shared link arrives in
    // "url" from some apps and buried in "text" from others, so both are kept
    // and the page decides.
    const text = ['title', 'text', 'url']
      .map((field) => String(form.get(field) ?? '').trim())
      .filter(Boolean);

    const files = [];
    for (const file of form.getAll('file')) {
      if (!file || typeof file.arrayBuffer !== 'function' || !file.size) continue;
      const key = `${SHARE_PREFIX}${id}/file/${files.length}`;
      // Stored as a Response so the page gets the bytes back untouched. The
      // name travels in a header because a cache key cannot carry it safely.
      await cache.put(key, new Response(file, {
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-VR-File-Name': encodeURIComponent(file.name || 'shared'),
          'X-VR-File-Size': String(file.size),
        },
      }));
      files.push({ key, name: file.name || 'shared', type: file.type || '', size: file.size });
    }

    if (!text.length && !files.length) {
      return Response.redirect('/#/projects?shared=empty', 303);
    }

    await cache.put(`${SHARE_PREFIX}${id}/meta`, new Response(JSON.stringify({
      id,
      shared_at: new Date().toISOString(),
      text,
      files,
    }), { headers: { 'Content-Type': 'application/json' } }));

    return Response.redirect(landing, 303);
  } catch (e) {
    console.warn('[sw] could not take that share:', e);
    // Still send them to the app: a redirect they can read beats Android's
    // bare "could not share" with nothing to act on.
    return Response.redirect('/#/projects?shared=failed', 303);
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // The only POST this worker ever handles.
  if (request.method === 'POST' && new URL(request.url).pathname === '/share-target') {
    event.respondWith(receiveShare(request));
    return;
  }

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Parked shares are read through caches.match() by the page, never fetched.
  // Letting them fall through to staleWhileRevalidate would send a request to
  // the network for a path that does not exist and cache the 404.
  if (url.pathname.startsWith(SHARE_PREFIX)) {
    event.respondWith((async () => (await caches.match(request)) || new Response(null, { status: 404 }))());
    return;
  }

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
