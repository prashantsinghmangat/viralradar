// Boots the real app against the fake data layer.
//
// Nothing in public/ is modified: the request for /data.js is intercepted in
// the browser and answered with qa/fake-data.js instead, and the two build-time
// scripts index.html expects (/env.js, /vendor/supabase.js) are answered with
// stubs, because they only exist in dist/.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const FAKE_DATA = fileURLToPath(new URL('../fake-data.js', import.meta.url));

/** A URL that is allowed to fail — the fixtures use one on purpose. */
export const EXPECTED_FAILURES = [/qa-missing-thumbnail\.png/];

export const WIDTHS = [
  { w: 360, h: 780, phone: true },
  { w: 390, h: 844, phone: true },
  { w: 412, h: 915, phone: true },
  { w: 768, h: 1024, phone: false },
  { w: 1024, h: 800, phone: false },
  { w: 1280, h: 900, phone: false },
  { w: 1440, h: 900, phone: false },
];

export const THEMES = ['dark', 'light'];

/**
 * Prepare a page: fake data, fake config, a pinned clock and a fixed theme.
 * Returns collectors for console errors and failed requests.
 */
export async function bootApp(page, { theme = 'dark', scenario = 'default', signedOut = false } = {}) {
  const fake = await readFile(FAKE_DATA, 'utf8');

  await page.route('**/data.js', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: fake }));
  await page.route('**/env.js', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: '/* qa stub */' }));
  await page.route('**/vendor/supabase.js', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: '/* qa stub */' }));
  await page.route('**/sw.js', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: '/* qa stub */' }));

  await page.addInitScript(({ theme: t, scenario: s, signedOut: out }) => {
    window.__QA = { scenario: s, now: '2026-10-10T12:00:00+05:30', signedOut: out };
    window.__VR_ENV = { SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_ANON_KEY: 'x'.repeat(60), BUILT_AT: '2026-10-10T06:30:00.000Z' };
    try {
      localStorage.setItem('vr-theme', t);
      localStorage.setItem('vr-device-name', 'Laptop');
    } catch { /* ignore */ }
    // Keep the real service worker out of it — a cached shell would make a run
    // depend on what a previous run happened to store — but keep the shape the
    // app checks for, so registerServiceWorker() takes its normal path.
    try {
      const registration = { addEventListener() {}, installing: null, waiting: null, update() {} };
      Object.defineProperty(Navigator.prototype, 'serviceWorker', {
        configurable: true,
        get: () => ({
          register: () => Promise.resolve(registration),
          addEventListener() {},
          ready: Promise.resolve(registration),
          controller: null,
          getRegistrations: () => Promise.resolve([]),
        }),
      });
    } catch { /* ignore */ }
  }, { theme, scenario, signedOut });

  // Pinned so "5h ago" and "Created 10 Oct 2026" never drift between runs.
  await page.clock.setFixedTime(new Date('2026-10-10T12:00:00+05:30'));

  const consoleErrors = [];
  const failedRequests = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // The fixtures include one deliberately missing image, to prove the
    // fallback; its 404 is the expected result, not a finding.
    if (/Failed to load resource/.test(text) && /404/.test(text)) return;
    consoleErrors.push(text);
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => {
    if (!EXPECTED_FAILURES.some((re) => re.test(r.url()))) failedRequests.push(`${r.url()} — ${r.failure()?.errorText}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !EXPECTED_FAILURES.some((re) => re.test(r.url()))) {
      failedRequests.push(`${r.url()} — HTTP ${r.status()}`);
    }
  });

  return { consoleErrors, failedRequests };
}

/** Go to a hash route and wait for the screen to have actually drawn. */
export async function gotoScreen(page, hash) {
  await page.goto(`/index.html${hash}`, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const v = document.querySelector('#view');
    return v && v.children.length > 0;
  }, null, { timeout: 15_000 });
  // Let fonts settle so text metrics (and so overlap checks) are final.
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForTimeout(150);
}

/** Every screen and state the suite walks. `setup` runs after the screen loads. */
export const SCREENS = [
  { name: 'radar', hash: '#/radar' },
  { name: 'radar-empty', hash: '#/radar', scenario: 'empty' },
  { name: 'radar-single', hash: '#/radar', scenario: 'single' },
  { name: 'radar-many', hash: '#/radar', scenario: 'many' },
  { name: 'ideas', hash: '#/ideas' },
  { name: 'ideas-empty', hash: '#/ideas', scenario: 'empty' },
  { name: 'scripts', hash: '#/scripts' },
  { name: 'scripts-empty', hash: '#/scripts', scenario: 'empty' },
  { name: 'script-detail', hash: '#/scripts/scr_full' },
  { name: 'script-detail-bare', hash: '#/scripts/scr_bare' },
  { name: 'script-detail-hindi', hash: '#/scripts/scr_hindi' },
  { name: 'projects', hash: '#/projects' },
  { name: 'projects-empty', hash: '#/projects', scenario: 'empty' },
  { name: 'project-detail', hash: '#/projects/proj_1' },
  { name: 'project-detail-empty', hash: '#/projects/proj_empty' },
  { name: 'results', hash: '#/results' },
  { name: 'results-empty', hash: '#/results', scenario: 'empty' },
  { name: 'import', hash: '#/import' },
  { name: 'settings', hash: '#/settings' },
  { name: 'login', hash: '#/radar', signedOut: true },
  {
    name: 'hook-sheet',
    hash: '#/radar',
    async setup(page) {
      await page.locator('[data-action="findHooks"]').first().click();
      await page.waitForSelector('#hookSheet[open] .angle-hook', { timeout: 10_000 });
    },
  },
  {
    name: 'more-sheet',
    hash: '#/radar',
    phoneOnly: true,
    async setup(page) {
      await page.locator('#moreBtn').click();
      await page.waitForSelector('#moreSheet[open]', { timeout: 10_000 });
    },
  },
  {
    name: 'angles',
    hash: '#/radar',
    async setup(page) {
      await page.locator('[data-action="findAngles"]').first().click();
      // The language sheet comes first.
      await page.waitForSelector('#genSheet[open]', { timeout: 10_000 });
      await page.locator('#genSheet button[value="go"]').click();
      await page.waitForSelector('.angles-block', { timeout: 10_000 });
    },
  },
  {
    name: 'language-sheet',
    hash: '#/radar',
    async setup(page) {
      await page.locator('[data-action="findAngles"]').first().click();
      await page.waitForSelector('#genSheet[open]', { timeout: 10_000 });
    },
  },
  {
    name: 'research-pack',
    hash: '#/radar',
    async setup(page) {
      await page.locator('[data-action="researchPack"]').first().click();
      await page.waitForSelector('.pack-block .fact, .pack-block .notice', { timeout: 15_000 });
    },
  },
  {
    name: 'toast',
    hash: '#/radar',
    async setup(page) {
      await page.evaluate(() => {
        const box = document.querySelector('#toasts');
        const el = document.createElement('div');
        el.className = 'toast';
        el.textContent = 'Found 7 trends · Filtered out 2 videos in other languages';
        box.appendChild(el);
      });
    },
  },
  { name: 'error-state', hash: '#/radar', scenario: 'error' },
  { name: 'script-unfinished', hash: '#/scripts/scr_missing' },
];
