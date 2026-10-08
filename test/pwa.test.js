// Tests for the parts that make this installable: the manifest, the icons and
// the service worker.
//
// A service worker is the one thing here that can break the app for someone and
// keep it broken, because it can go on serving an old copy long after a fix is
// deployed. So most of this is about what it must NOT cache.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'));
const sw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

test('the manifest has what a phone needs to install it', () => {
  assert.equal(manifest.name, 'ViralRadar');
  assert.ok(manifest.short_name.length <= 12, 'a long short_name is truncated under the icon');
  assert.equal(manifest.display, 'standalone', 'otherwise it opens in a browser tab, not as an app');
  assert.match(manifest.start_url, /^\//);
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);
});

test('the page points at the manifest and matches its theme colour', () => {
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(html, /<link rel="apple-touch-icon"/, 'iOS ignores the manifest and wants its own');
  const theme = html.match(/<meta name="theme-color" content="([^"]+)"/);
  assert.ok(theme, 'the address bar colour comes from here');
  assert.equal(theme[1].toLowerCase(), manifest.theme_color.toLowerCase(),
    'two different theme colours means the bar changes colour as the app loads');
});

test('every icon the manifest promises is really there, and is a real PNG', () => {
  assert.ok(manifest.icons.length >= 2);
  for (const icon of manifest.icons) {
    const file = path.join(PUBLIC, icon.src.replace(/^\//, ''));
    assert.ok(fs.existsSync(file), `the manifest promises ${icon.src}, which does not exist`);

    const bytes = fs.readFileSync(file);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${icon.src} is not a PNG`);
    // The size in the header has to match what the manifest claims, or a phone
    // quietly picks a different icon.
    const [width, height] = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
    assert.equal(`${width}x${height}`, icon.sizes, `${icon.src} is ${width}x${height} but the manifest says ${icon.sizes}`);
    assert.equal(icon.type, 'image/png');
  }
});

test('there is a maskable icon, or Android crops the artwork', () => {
  const maskable = manifest.icons.filter((i) => i.purpose === 'maskable');
  assert.ok(maskable.length >= 1, 'without one, launchers crop a square icon to a circle and cut the edges off');
  assert.ok(maskable.some((i) => i.sizes === '512x512'));
});

test('the icons are generated, not hand-drawn, so they can be remade', async () => {
  const { ICONS, drawIcon, encodePng } = await import('../scripts/make-icons.mjs');
  const promised = new Set(manifest.icons.map((i) => i.src.replace('/icons/', '')));
  for (const { file } of ICONS) assert.ok(promised.has(file), `${file} is generated but the manifest never uses it`);

  // Redrawing one must produce the same bytes, or "generated" is not true.
  const existing = fs.readFileSync(path.join(PUBLIC, 'icons', 'icon-192.png'));
  const redrawn = encodePng(192, 192, drawIcon(192, { maskable: false }));
  assert.ok(existing.equals(redrawn), 'icon-192.png differs from what the script draws; run: npm run icons');
});

test('the service worker caches the shell and nothing else', () => {
  const shell = sw.slice(sw.indexOf('const SHELL'), sw.indexOf('];', sw.indexOf('const SHELL')));
  for (const needed of ['/index.html', '/app.js', '/data.js', '/styles.css', '/vendor/supabase.js']) {
    assert.ok(shell.includes(needed), `${needed} is part of the app shell and should be cached`);
  }
  // Every shared module the browser imports has to be in there too, or the app
  // will not start with no connection.
  for (const name of ['stats', 'defaults', 'time', 'tokens', 'edit-plan', 'projects', 'sha256', 'transfer', 'learning']) {
    assert.ok(shell.includes(`/shared/${name}.mjs`), `shared/${name}.mjs is imported but never cached`);
  }
  // app.js imports this one directly, so it is part of the shell too.
  assert.ok(shell.includes('/transfer.js'), 'transfer.js is imported by app.js but never cached');
});

// ---------- Web Share Target ----------
//
// This is the only part of the app that depends on the service worker for
// something other than speed: without it there is nothing to answer the POST
// Android makes, because the site is static and has no server.

test('the manifest puts ViralRadar in Android\'s Share menu', () => {
  const target = manifest.share_target;
  assert.ok(target, 'without share_target the app never appears in the Share sheet');
  assert.equal(target.method, 'POST', 'GET cannot carry a shared image');
  assert.equal(target.enctype, 'multipart/form-data', 'files need a multipart body');
  assert.match(target.action, /^\//, 'the action has to be a path on this origin');

  // Different apps put a shared link in different fields, so all three text
  // fields are asked for and the page decides which it got.
  for (const field of ['title', 'text', 'url']) {
    assert.equal(target.params[field], field, `a share may arrive in "${field}"`);
  }
  const files = target.params.files;
  assert.ok(Array.isArray(files) && files.length >= 1, 'images are the main thing worth sharing in');
  assert.ok(files[0].accept.some((a) => /^image\//.test(a)), 'images must be accepted');
  // Video is deliberately absent: it is far bigger than the 25 MB limit, and
  // accepting it would put ViralRadar in the Share sheet for something it then
  // refuses.
  assert.ok(!files.some((f) => f.accept.some((a) => /^video\//.test(a))),
    'raw video is never uploaded, so it must not be offered in the Share sheet');
});

test('the worker is what answers the share, since there is no server', () => {
  // Netlify answers a POST to a static site with a 405. If the worker did not
  // intercept it, choosing ViralRadar from the Share sheet would simply fail.
  assert.match(sw, /request\.method === 'POST'/, 'the worker has to handle a POST, which it otherwise ignores');
  const action = manifest.share_target.action;
  assert.ok(sw.includes(`'${action}'`), `the worker must handle ${action}, the path the manifest names`);
  assert.match(sw, /request\.formData\(\)/, 'a multipart body is read as form data');
  // 303 is what turns the POST into a GET, so a reload does not re-share.
  assert.match(sw, /Response\.redirect\([^)]*303\)/, 'the share has to end as a redirect, or the browser shows a blank POST response');
});

test('a share waits in its own cache, which a deploy does not clear', () => {
  // The session lives in the page, not in the worker, so the worker cannot
  // write to Supabase. It parks the payload instead, which also means a share
  // made with no signal is delivered the next time the app opens.
  assert.match(sw, /const SHARE_CACHE = 'viralradar-shared'/);
  assert.match(sw, /caches\.open\(SHARE_CACHE\)/);

  // The activate handler deletes old shell caches. If it matched the share
  // cache too, a share made moments before a deploy would be thrown away.
  // The activate handler alone, ending at its own closing brace rather than at
  // the next listener — the share-handling function sits between the two.
  const activateStart = sw.indexOf("addEventListener('activate'");
  const activate = sw.slice(activateStart, sw.indexOf('\n});', activateStart))
    // Comments stripped, so this is about what the worker does rather than
    // about what it says it does.
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(activate, /viralradar-shell-/, 'only the shell caches are versioned');
  assert.ok(!/SHARE_CACHE/.test(activate), 'a deploy must not throw away a share that has not been delivered yet');

  // The page and the worker have to agree on where it is parked.
  const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  for (const name of ['SHARE_CACHE', 'SHARE_PREFIX']) {
    const inSw = sw.match(new RegExp(`const ${name} = '([^']+)'`));
    const inApp = app.match(new RegExp(`const ${name} = '([^']+)'`));
    assert.ok(inSw && inApp, `${name} has to be defined in both the worker and the page`);
    assert.equal(inApp[1], inSw[1], `${name} differs between the worker and the page, so a share is parked where nothing looks`);
  }
});

test('a share that brought nothing, or failed, still says so', () => {
  // Android gives no feedback beyond closing the Share sheet, so a share that
  // failed looks exactly like one that worked unless the app says otherwise.
  assert.match(sw, /shared=empty/, 'a share with no content is its own case');
  assert.match(sw, /shared=failed/, 'a share that could not be read must not look like success');
  assert.match(sw, /catch/, 'a malformed body must not leave the Share sheet hanging');

  const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const report = app.slice(app.indexOf('function reportShare'), app.indexOf('// ================= IMPORT'));
  for (const outcome of ['empty', 'failed']) {
    assert.ok(report.includes(`'${outcome}'`), `the page never tells anyone about shared=${outcome}`);
  }
  assert.match(report, /replaceState/, 'a reload must not report the same share again');
});

test('a shared file is checked against the 25 MB limit like any other', () => {
  const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const drain = app.slice(app.indexOf('async function drainShares'), app.indexOf('function reportShare'));
  assert.match(drain, /checkUpload\(/, 'a share is an upload, and the same limits apply');
  assert.match(drain, /inbox/i, 'a share with no folder chosen goes to the Inbox');
  // One failed item must not stop the rest, and nothing may be left in the
  // cache to be delivered twice.
  assert.match(drain, /cache\.delete\(/, 'a delivered share has to be cleared, or it arrives again on every boot');
  assert.match(drain, /catch/);
});

test('the Projects screen is reachable from the app and from the home screen', () => {
  assert.match(html, /href="#\/projects" data-route="projects"/, 'there has to be a way in from the nav');
  assert.ok(manifest.shortcuts.some((s) => s.url.includes('/projects')),
    'a long-press on the icon should reach the folders, which is where a phone share lands');
});

test('configuration is never served from the cache without trying the network', () => {
  // A cached env.js would outlive a deploy that changed the Supabase address or
  // key, leaving the app pointing at something that no longer answers.
  const shell = sw.slice(sw.indexOf('const SHELL'), sw.indexOf('];', sw.indexOf('const SHELL')));
  assert.ok(!shell.includes('env.js'), 'env.js must not be precached');
  assert.match(sw, /env\.js[\s\S]*networkFirst/, 'env.js should be fetched first and cached only as a fallback');
});

test('nothing from Supabase is cached or intercepted', () => {
  // Showing yesterday's results because the phone lost signal would be worse
  // than showing nothing at all.
  assert.match(sw, /url\.origin !== self\.location\.origin/);
  assert.match(sw, /return;/);
  const guard = sw.slice(sw.indexOf('url.origin !== self.location.origin'));
  assert.match(guard.slice(0, 120), /return/, 'a cross-origin request must be left entirely alone');
  assert.ok(!/supabase\.co/.test(sw), 'the worker should not know or care where the data lives');
});

test('a deploy replaces the cache rather than adding to it', () => {
  assert.match(sw, /const VERSION = '__VR_BUILD__'/, 'the build stamps this; without it the shell never updates');
  assert.match(sw, /caches\.delete\(name\)/, 'old caches must be cleared, or they accumulate forever');
  assert.match(sw, /skipWaiting/);
  assert.match(sw, /clients\.claim/);
});

test('the build stamps the worker and ships the manifest', async () => {
  const { build } = await import('../scripts/build.mjs');
  const { files } = await build({
    env: { SUPABASE_URL: 'https://examplerefabcdefghij.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_' + 'x'.repeat(40) },
    builtAt: '2026-10-08T12:34:56.000Z',
    check: false,
  });

  for (const expected of ['manifest.webmanifest', 'sw.js', 'icons/icon-192.png', 'icons/icon-maskable-512.png']) {
    assert.ok(files.includes(expected), `dist/${expected} is missing`);
  }
  const built = fs.readFileSync(path.join(ROOT, 'dist', 'sw.js'), 'utf8');
  assert.ok(!built.includes('__VR_BUILD__'), 'the placeholder survived the build, so the cache would never change');
  assert.match(built, /const VERSION = '20261008123456'/);
});

test('the app registers the worker, but never depends on it', () => {
  const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function registerServiceWorker'), app.indexOf('async function boot'));
  assert.match(fn, /serviceWorker' in navigator/, 'older browsers have none');
  assert.match(fn, /catch/, 'a failure to register must not stop the app loading');
  assert.match(fn, /https:/, 'browsers refuse to register one over plain http');
  assert.match(fn, /new version is ready/i, 'people need telling when a reload would help');
});
