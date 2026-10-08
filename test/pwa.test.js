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
  for (const name of ['stats', 'defaults', 'time', 'tokens', 'edit-plan']) {
    assert.ok(shell.includes(`/shared/${name}.mjs`), `shared/${name}.mjs is imported but never cached`);
  }
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
