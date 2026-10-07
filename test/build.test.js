// Tests for scripts/build.mjs — the thing that produces what Netlify serves.
//
// The important property is negative: whatever is in the environment, a secret
// must never end up in dist/. A mistake here is public the moment it deploys,
// so the guard is tested by actually making it trigger.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const GOOD = {
  SUPABASE_URL: 'https://examplerefabcdefghij.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_' + 'x'.repeat(40),
};

test('a good configuration is accepted', async () => {
  const { readConfig } = await import('../scripts/build.mjs');
  const c = readConfig(GOOD);
  assert.deepEqual(c.problems, []);
  assert.equal(c.url, GOOD.SUPABASE_URL);
});

test('a trailing slash on the URL is tidied away', async () => {
  const { readConfig } = await import('../scripts/build.mjs');
  assert.equal(readConfig({ ...GOOD, SUPABASE_URL: GOOD.SUPABASE_URL + '/' }).url, GOOD.SUPABASE_URL);
});

test('a missing or wrong-looking configuration is refused with a readable reason', async () => {
  const { readConfig } = await import('../scripts/build.mjs');
  const cases = [
    [{ ...GOOD, SUPABASE_URL: '' }, /SUPABASE_URL is not set/],
    [{ ...GOOD, SUPABASE_URL: 'examplerefabcdefghij.supabase.co' }, /does not look right/],
    [{ ...GOOD, SUPABASE_URL: 'http://examplerefabcdefghij.supabase.co' }, /does not look right/],
    [{ ...GOOD, SUPABASE_URL: 'https://ytshortradar.netlify.app' }, /does not look right/],
    [{ ...GOOD, SUPABASE_ANON_KEY: '' }, /SUPABASE_ANON_KEY is not set/],
    [{ ...GOOD, SUPABASE_ANON_KEY: 'short' }, /too short/],
  ];
  for (const [env, expected] of cases) {
    const { problems } = readConfig(env);
    assert.ok(problems.length, `should have been refused: ${JSON.stringify(env).slice(0, 60)}`);
    assert.match(problems.join(' '), expected);
  }
});

test('the SECRET key pasted in by mistake is refused, not shipped', async () => {
  const { readConfig, keyRole } = await import('../scripts/build.mjs');
  const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  // A real service_role key hides the role inside the base64 middle section of
  // the JWT, so the raw text contains nothing suspicious. Checking the text
  // alone would miss the exact key this is meant to catch.
  const serviceJwt = 'eyJhbGciOiJIUzI1NiJ9.' + b64url({ iss: 'supabase', role: 'service_role' }) + '.sig';
  assert.ok(!serviceJwt.includes('service_role'), 'the point of this test: the raw key does not say so');
  assert.equal(keyRole(serviceJwt), 'service_role');

  for (const key of [serviceJwt, 'sb_secret_' + 'y'.repeat(40)]) {
    const { problems } = readConfig({ ...GOOD, SUPABASE_ANON_KEY: key });
    assert.ok(problems.length, 'the secret key must never be accepted');
    assert.match(problems.join(' '), /must never be in a browser/);
  }

  // The keys that ARE meant to be in a browser must still be accepted.
  const anonJwt = 'eyJhbGciOiJIUzI1NiJ9.' + b64url({ iss: 'supabase', role: 'anon' }) + '.sig';
  assert.equal(keyRole(anonJwt), 'anon');
  assert.deepEqual(readConfig({ ...GOOD, SUPABASE_ANON_KEY: anonJwt }).problems, []);
  assert.deepEqual(readConfig(GOOD).problems, [], 'a publishable key is not a JWT at all');
  assert.equal(keyRole('not-a-jwt'), null);
  assert.equal(keyRole('a.b.c'), null, 'rubbish in the middle section must not throw');
});

test('env.js carries the two public values and nothing else', async () => {
  const { envScript } = await import('../scripts/build.mjs');
  const js = envScript({ url: GOOD.SUPABASE_URL, anonKey: GOOD.SUPABASE_ANON_KEY }, '2026-10-07T00:00:00.000Z');
  const parsed = JSON.parse(js.slice(js.indexOf('{'), js.lastIndexOf('}') + 1));
  assert.deepEqual(Object.keys(parsed).sort(), ['BUILT_AT', 'SUPABASE_ANON_KEY', 'SUPABASE_URL']);
  assert.equal(parsed.SUPABASE_URL, GOOD.SUPABASE_URL);
  assert.match(js, /window\.__VR_ENV/);
  assert.match(js, /Object\.freeze/, 'the page should not be able to change its own configuration');
});

test('a real build produces the app, the configuration and the vendored library', async () => {
  const { build } = await import('../scripts/build.mjs');
  const { files } = build({ env: GOOD, builtAt: '2026-10-07T00:00:00.000Z' });

  for (const expected of ['index.html', 'app.js', 'styles.css', 'env.js', 'vendor/supabase.js']) {
    assert.ok(files.includes(expected), `dist/${expected} is missing`);
  }
  const env = fs.readFileSync(path.join(DIST, 'env.js'), 'utf8');
  assert.ok(env.includes(GOOD.SUPABASE_URL));
  assert.ok(env.includes(GOOD.SUPABASE_ANON_KEY));

  // The library is vendored, not fetched: nothing in the output may point at a CDN.
  for (const f of files.filter((x) => x.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(DIST, f), 'utf8');
    assert.ok(!/src=["']https?:\/\//.test(html), `${f} loads a script from another host`);
  }
  const lib = fs.readFileSync(path.join(DIST, 'vendor', 'supabase.js'), 'utf8');
  assert.ok(lib.length > 100000, 'the supabase bundle looks truncated');
  assert.match(lib.slice(0, 200), /supabase/);
});

test('a secret that somehow reaches the output stops the build and deletes it', async () => {
  const { build } = await import('../scripts/build.mjs');
  // "ViralRadar" really is in index.html, so this stands in for a secret whose
  // value happens to appear in a built file. The guard must notice and refuse.
  assert.throws(
    () => build({ env: { ...GOOD, GEMINI_API_KEY: 'ViralRadar' }, builtAt: '2026-10-07T00:00:00.000Z' }),
    /Refusing to publish.*GEMINI_API_KEY appears in dist/s,
  );
  assert.equal(fs.existsSync(DIST), false, 'a build that leaked must not be left on disk');
});

test('an incomplete configuration fails the build rather than deploying a broken site', async () => {
  const { build } = await import('../scripts/build.mjs');
  assert.throws(() => build({ env: { SUPABASE_URL: '', SUPABASE_ANON_KEY: '' } }), /Cannot build the site/);
  // On Netlify the message should point at the Netlify UI, not at a local file.
  assert.throws(() => build({ env: { NETLIFY: 'true' } }), /Netlify: Site configuration/);
  assert.throws(() => build({ env: {} }), /your \.env file/);
});

test('netlify.toml matches how the build actually works', () => {
  const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  assert.match(toml, /command = "npm run build"/);
  assert.ok(pkg.scripts.build, 'netlify.toml calls npm run build, so it has to exist');
  assert.match(toml, /publish = "dist"/, 'the build writes to dist/');
  // Pinned to the version this was developed with, as agreed.
  assert.match(toml, /NODE_VERSION = "24\.\d+\.\d+"/);
  // Direct links must land on the app, not a 404.
  assert.match(toml, /from = "\/\*"[\s\S]*?to = "\/index\.html"[\s\S]*?status = 200/);
  // Configuration must not be cached, or a key change would not take effect.
  assert.match(toml, /for = "\/env\.js"[\s\S]*?Cache-Control = "no-store"/);
});

test('the build output is never committed', () => {
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /^dist\/$/m, 'dist/ holds a generated env.js and must stay out of git');
});

test('the shared modules the browser gets are self-contained', async () => {
  // There is no bundler: the browser fetches these files exactly as they are.
  // If one of them imports something that was not copied, the page 404s at
  // runtime with nothing useful in the console, so check it here instead.
  const { BROWSER_SHARED } = await import('../scripts/build.mjs');
  assert.ok(BROWSER_SHARED.length >= 3);
  for (const name of BROWSER_SHARED) {
    const source = fs.readFileSync(path.join(ROOT, 'shared', name), 'utf8');
    const relative = [...source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
    assert.deepEqual(relative, [], `shared/${name} imports ${relative.join(', ')}, which the browser would not have`);
  }
});

test('the page loads the configuration and the library before the app', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const order = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(order.includes('/env.js'), 'the page needs its Supabase configuration');
  assert.ok(order.includes('/vendor/supabase.js'), 'the library is vendored, not loaded from a CDN');
  // app.js is a module, so it is deferred and runs after the two plain scripts
  // above it whatever the order in the file; being explicit anyway.
  assert.ok(order.indexOf('/env.js') < order.indexOf('/app.js'));
  assert.ok(order.indexOf('/vendor/supabase.js') < order.indexOf('/app.js'));
  assert.match(html, /<script type="module" src="\/app\.js">/, 'app.js imports data.js, so it has to be a module');
});

test('secret scanning is narrowed, not switched off', () => {
  // Netlify treats every environment variable as a secret and fails the build
  // if it appears in the output. The two public ones have to appear there, so
  // they are exempted by name. Exempting them is fine; turning the scanner off
  // would also stop it catching a service_role key, which is the whole point.
  // Comments are stripped first: this file explains in prose why scanning must
  // not be turned off, and the explanation itself names the setting.
  const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  const omit = toml.match(/SECRETS_SCAN_OMIT_KEYS = "([^"]*)"/);
  assert.ok(omit, 'the two public variables must be exempted, or every build fails');
  assert.deepEqual(omit[1].split(',').map((s) => s.trim()).sort(), ['SUPABASE_ANON_KEY', 'SUPABASE_URL'],
    'only the two deliberately-public variables may be exempt');
  assert.ok(!/SECRETS_SCAN_ENABLED\s*=\s*"?false/i.test(toml),
    'scanning must stay on: it is what would catch a service_role key reaching the build');
  assert.ok(!/SECRETS_SCAN_OMIT_PATHS/.test(toml),
    'exempting whole paths would hide real leaks; exempt the two known-public keys instead');
});

test('no real project address is hard-coded in the tests', () => {
  // A real project ref in a test file is not a secret, but Netlify's scanner
  // flags it and the build stops. Fixtures use an obviously fake ref.
  const self = fs.readFileSync(__filename, 'utf8');
  const refs = [...self.matchAll(/https:\/\/([a-z0-9-]+)\.supabase\.co/g)].map((m) => m[1]);
  assert.ok(refs.length > 0, 'the fixtures should still exercise a realistic URL');
  for (const ref of refs) {
    assert.match(ref, /example/, `"${ref}" looks like a real project ref; use an obviously fake one`);
  }
});
