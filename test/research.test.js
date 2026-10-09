// Tests for shared/research.mjs — the Research Pack.
//
// The promise of this feature is "grounded in live pages, never invented". Half
// of that is a prompt instruction, which cannot be tested because a model can
// ignore it. The other half is normalisePack(), which can, and these tests are
// mostly about it:
//
//   a claim citing a page that loaded          -> may stay verified
//   a claim citing a page that did not load    -> forced to unverified
//   a claim when nothing loaded at all         -> forced to unverified
//   a URL the model called working             -> reachable comes from the fetch
//
// The fetcher takes its `fetch` as an argument, so a slow page, a 404, a PDF
// and a two-megabyte page are all testable here with no network.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../shared/research.mjs');

/** A stand-in for fetch, with only what fetchPage actually reads. */
function fakeResponse({ status = 200, url = 'https://x.test/', body = '', type = 'text/html', headers = {} } = {}) {
  const map = new Map(Object.entries({ 'content-type': type, ...headers }).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    headers: { get: (k) => map.get(String(k).toLowerCase()) ?? null },
    text: async () => body,
    body: null, // forces the text() path, which is the simpler one to fake
  };
}

const PAGE = `<!doctype html>
<html><head>
  <title>NameForge — turn your name into 3D</title>
  <meta name="description" content="Free 3D name generator. No signup needed.">
  <style>.hero{color:red}</style>
  <script>var pricing = "costs $99 per month";</script>
</head><body>
  <h1>NameForge</h1>
  <p>Type your name and get a 3D animation.</p>
  <p>The free plan exports at 720p and adds no watermark.</p>
  <!-- a comment that mentions $500 -->
</body></html>`;

// ---------- reading a page ----------

test('a page is reduced to its title, description and visible prose', async () => {
  const { readPage } = await load();
  const page = readPage(PAGE);

  assert.equal(page.title, 'NameForge — turn your name into 3D');
  assert.equal(page.description, 'Free 3D name generator. No signup needed.');
  assert.match(page.text, /Type your name and get a 3D animation/);
  assert.match(page.text, /free plan exports at 720p/);

  // A page's own scripts, styles and comments are full of strings that read
  // like facts. "$99 per month" is in the source and must never reach a model
  // that has been told the page text is the truth.
  assert.ok(!page.text.includes('99'), 'script contents must not become page text');
  assert.ok(!page.text.includes('500'), 'comments must not become page text');
  assert.ok(!page.text.includes('color:red'), 'styles must not become page text');
  assert.ok(!page.text.includes('<'), 'no markup should survive');
});

test('the page text is capped, so a huge page cannot fill the prompt', async () => {
  const { readPage, MAX_TEXT_CHARS } = await load();
  const huge = `<html><body><p>${'word '.repeat(200000)}</p></body></html>`;
  const page = readPage(huge);
  assert.equal(page.text.length, MAX_TEXT_CHARS);
  assert.equal(page.chars, MAX_TEXT_CHARS);
  // And a smaller cap is honoured, which is what the per-page budget uses.
  assert.equal(readPage(huge, { maxChars: 50 }).text.length, 50);
});

test('entities are decoded, so a quoted limit reads as a limit', async () => {
  const { readPage } = await load();
  const page = readPage('<html><body><p>Up to 3 exports &amp; no watermark &mdash; it&#39;s free</p></body></html>');
  assert.match(page.text, /3 exports & no watermark — it's free/);
});

// ---------- fetching ----------

test('a page that loads is marked reachable, with its final URL', async () => {
  const { fetchPage } = await load();
  const got = await fetchPage('https://nameforge.test/', {
    // A redirect: the response reports where it actually ended up.
    fetchImpl: async () => fakeResponse({ url: 'https://www.nameforge.test/home', body: PAGE }),
  });

  assert.equal(got.reachable, true);
  assert.equal(got.status, 200);
  assert.equal(got.url, 'https://nameforge.test/');
  assert.equal(got.finalUrl, 'https://www.nameforge.test/home', 'a redirect must be recorded');
  assert.equal(got.title, 'NameForge — turn your name into 3D');
  assert.match(got.text, /720p/);
  assert.equal(got.error, '');
});

test('a URL that fails is never presented as working', async () => {
  const { fetchPage } = await load();

  const cases = [
    ['a 404', async () => fakeResponse({ status: 404, body: 'gone' }), /answered 404/],
    ['a 500', async () => fakeResponse({ status: 500, body: '' }), /answered 500/],
    ['a PDF', async () => fakeResponse({ type: 'application/pdf', body: '%PDF-1.4' }), /not a readable page/],
    ['a dead host', async () => { throw new Error('getaddrinfo ENOTFOUND'); }, /ENOTFOUND/],
  ];

  for (const [what, fetchImpl, expected] of cases) {
    const got = await fetchPage('https://nope.test/', { fetchImpl });
    assert.equal(got.reachable, false, `${what} must not be reachable`);
    assert.equal(got.text, '', `${what} must contribute no text`);
    assert.match(got.error, expected, `${what} should say why`);
  }
});

test('a page that never answers is given up on, and says so', async () => {
  const { fetchPage } = await load();
  // Never resolves: only the timeout can end this.
  const hang = (url, options) => new Promise((resolve, reject) => {
    options.signal?.addEventListener('abort', () => {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      reject(e);
    });
  });

  const started = Date.now();
  const got = await fetchPage('https://slow.test/', { fetchImpl: hang, timeoutMs: 120 });
  const took = Date.now() - started;

  assert.equal(got.reachable, false);
  assert.match(got.error, /no answer within/);
  assert.ok(took < 2000, `it waited ${took}ms; the timeout must actually fire`);
});

test('the default timeout is ten seconds and the page cap is bounded', async () => {
  const { FETCH_TIMEOUT_MS, MAX_PAGE_BYTES, MAX_TEXT_CHARS, MAX_URLS } = await load();
  assert.equal(FETCH_TIMEOUT_MS, 10000);
  assert.equal(MAX_TEXT_CHARS, 10000);
  assert.ok(MAX_PAGE_BYTES <= 4 * 1024 * 1024, 'a page bigger than this is not an article');
  assert.ok(MAX_URLS <= 8, 'each URL is a fetch and a slice of the prompt');
});

test('a page that declares itself enormous is not downloaded', async () => {
  const { fetchPage, MAX_PAGE_BYTES } = await load();
  let read = false;
  const got = await fetchPage('https://huge.test/', {
    fetchImpl: async () => ({
      ...fakeResponse({ headers: { 'content-length': String(MAX_PAGE_BYTES + 1) } }),
      text: async () => { read = true; return 'x'.repeat(MAX_PAGE_BYTES + 1); },
    }),
  });
  assert.equal(read, false, 'the body must not be read once the length is known to be too big');
  assert.equal(got.text, '');
});

test('a site that lies about its size is cut off mid-stream', async () => {
  // Content-Length is a hint, not a promise. A page that declares nothing and
  // then streams forever would otherwise fill the function's memory, so the
  // stream itself is capped and the result says it was truncated.
  const { fetchPage } = await load();
  const maxBytes = 4096;
  let handed = 0;
  let cancelled = false;

  const endless = {
    getReader: () => ({
      read: async () => {
        handed += 1024;
        return { done: false, value: new Uint8Array(1024).fill(0x61) };
      },
      cancel: async () => { cancelled = true; },
    }),
  };

  const got = await fetchPage('https://liar.test/', {
    maxBytes,
    fetchImpl: async () => ({ ...fakeResponse({ body: '' }), body: endless }),
  });

  assert.ok(handed <= maxBytes + 2048, `it read ${handed} bytes against a ${maxBytes} cap`);
  assert.ok(got.chars <= maxBytes, 'nothing beyond the cap can reach the prompt');
  assert.equal(got.truncated, true, 'a cut-off page has to admit it was cut off');
  assert.equal(cancelled, true, 'the rest of the download should be let go of');
});

test('a browser-shaped User-Agent is sent, because a blank one gets blocked', async () => {
  const { fetchPage, USER_AGENT } = await load();
  let sent = null;
  await fetchPage('https://x.test/', {
    fetchImpl: async (url, options) => { sent = options; return fakeResponse({ body: PAGE }); },
  });
  assert.equal(sent.headers['User-Agent'], USER_AGENT);
  assert.match(USER_AGENT, /ViralRadar/, 'it should say who is asking');
  assert.equal(sent.redirect, 'follow', 'an official URL very often redirects');
});

test('only real web URLs are fetched, once each', async () => {
  const { cleanUrls } = await load();
  const got = cleanUrls([
    'https://a.test/x',
    'https://a.test/x',             // the same page twice
    'https://a.test/x/',            // and again, with a slash
    'https://a.test/x#section',     // and again, with a fragment
    'http://b.test/',
    'javascript:alert(1)',          // not a page
    'file:///etc/passwd',           // not ours to read
    'data:text/html,<h1>x',         // not a page
    'not a url at all',
    'https://c.test/p?utm_source=x&id=7',
  ]);
  assert.deepEqual(got, ['https://a.test/x', 'http://b.test/', 'https://c.test/p?id=7']);
});

// ---------- the part that is actually enforceable ----------

const livePage = { url: 'https://nameforge.test/', finalUrl: 'https://nameforge.test/', reachable: true, text: 'free plan exports at 720p', title: 'NameForge', description: '' };
const deadPage = { url: 'https://gone.test/', finalUrl: 'https://gone.test/', reachable: false, text: '', error: 'the page answered 404' };

test('a claim citing a page that loaded may stay verified', async () => {
  const { normalisePack } = await load();
  const pack = normalisePack({
    pages: [livePage],
    pack: {
      main_tool: { name: 'NameForge', url: 'https://nameforge.test/' },
      fact_check: [{ claim: 'The free plan exports at 720p', status: 'verified', source_url: 'https://nameforge.test/' }],
    },
  });

  assert.equal(pack.fact_check[0].status, 'verified');
  assert.equal(pack.fact_check[0].source_url, 'https://nameforge.test/');
  assert.equal(pack.verified_count, 1);
  assert.equal(pack.downgraded_count, 0);
  assert.deepEqual(pack.sources, ['https://nameforge.test/']);
  assert.equal(pack.grounded, true);
});

test('a claim citing a page that did NOT load is forced to unverified', async () => {
  const { normalisePack } = await load();
  // The model claimed it read this off the page. The page returned 404, so it
  // did not. This is the single most important assertion in the file.
  const pack = normalisePack({
    pages: [livePage, deadPage],
    pack: {
      main_tool: { name: 'NameForge', url: 'https://nameforge.test/' },
      fact_check: [
        { claim: 'Exports at 720p', status: 'verified', source_url: 'https://nameforge.test/' },
        { claim: 'Costs nothing forever', status: 'verified', source_url: 'https://gone.test/' },
        { claim: 'Invented from nowhere', status: 'verified', source_url: 'https://never-fetched.test/' },
      ],
    },
  });

  const byClaim = Object.fromEntries(pack.fact_check.map((f) => [f.claim, f.status]));
  assert.equal(byClaim['Exports at 720p'], 'verified');
  assert.equal(byClaim['Costs nothing forever'], 'unverified', 'a 404 cannot have been read');
  assert.equal(byClaim['Invented from nowhere'], 'unverified', 'a URL never fetched cannot have been read');

  assert.equal(pack.verified_count, 1);
  assert.equal(pack.unverified_count, 2);
  assert.equal(pack.downgraded_count, 2, 'it should report how much it had to downgrade');

  // The downgraded claims are still shown — with their links, so they can be
  // checked by hand. Nothing is hidden; it is just no longer called fact.
  assert.equal(pack.fact_check.length, 3);
});

test('with nothing reachable, nothing is verified', async () => {
  const { normalisePack } = await load();
  const pack = normalisePack({
    topic: 'a tool',
    pages: [deadPage],
    pack: {
      main_tool: { name: 'Ghost', url: 'https://gone.test/' },
      fact_check: [
        { claim: 'It is free', status: 'verified', source_url: 'https://gone.test/' },
        { claim: 'It has no watermark', status: 'verified', source_url: 'https://gone.test/' },
      ],
    },
  });

  assert.equal(pack.grounded, false);
  assert.equal(pack.verified_count, 0);
  assert.equal(pack.sources.length, 0);
  for (const f of pack.fact_check) assert.equal(f.status, 'unverified');
  assert.deepEqual(pack.unreachable, [{ url: 'https://gone.test/', error: 'the page answered 404' }]);
});

test('reachable comes from the fetch, never from the model', async () => {
  const { normalisePack } = await load();
  // The model asserts both are live. One is not. A wrong answer here becomes a
  // video recommending a dead site.
  const pack = normalisePack({
    pages: [livePage, deadPage],
    pack: {
      main_tool: { name: 'Ghost', url: 'https://gone.test/', reachable: true },
      alternatives: [
        { name: 'NameForge', url: 'https://nameforge.test/', reachable: false, one_line: 'the live one' },
        { name: 'Ghost2', url: 'https://gone.test/', reachable: true, one_line: 'the dead one' },
      ],
    },
  });

  assert.equal(pack.main_tool.reachable, false, 'the model said true; the fetch said 404');
  assert.equal(pack.alternatives.find((a) => a.name === 'NameForge').reachable, true,
    'the model said false; the fetch succeeded');
  assert.equal(pack.alternatives.find((a) => a.name === 'Ghost2').reachable, false);
});

test('a redirect is still the same source, cited either way', async () => {
  const { normalisePack } = await load();
  const redirected = { url: 'https://nameforge.test/', finalUrl: 'https://www.nameforge.test/home', reachable: true, text: 'x' };
  const pack = normalisePack({
    pages: [redirected],
    pack: {
      main_tool: { name: 'NameForge', url: 'https://www.nameforge.test/home' },
      fact_check: [
        { claim: 'cited as asked', status: 'verified', source_url: 'https://nameforge.test/' },
        { claim: 'cited as landed', status: 'verified', source_url: 'https://www.nameforge.test/home' },
      ],
    },
  });
  assert.equal(pack.main_tool.reachable, true);
  for (const f of pack.fact_check) assert.equal(f.status, 'verified');
  assert.deepEqual(pack.sources, ['https://www.nameforge.test/home'], 'the source is where it ended up');
});

test('rubbish from the model becomes an empty pack, not a crash', async () => {
  const { normalisePack, packIsEmpty } = await load();
  for (const bad of [null, undefined, 'a string', 42, [], {}]) {
    const pack = normalisePack({ pack: bad, pages: [], topic: 'a tool' });
    assert.equal(pack.topic, 'a tool', 'the topic survives even when nothing else does');
    assert.equal(pack.grounded, false);
    assert.deepEqual(pack.fact_check, []);
    assert.deepEqual(pack.main_tool.steps, []);
    assert.equal(packIsEmpty(pack), true);
  }
});

test('lists and strings are bounded, so one answer cannot be a megabyte', async () => {
  const { normalisePack } = await load();
  const pack = normalisePack({
    pages: [livePage],
    pack: {
      main_tool: {
        name: 'x'.repeat(5000),
        steps: Array.from({ length: 500 }, (_, i) => `step ${i} ${'y'.repeat(2000)}`),
        prompts: Array.from({ length: 99 }, () => 'p'),
      },
      fact_check: Array.from({ length: 500 }, (_, i) => ({ claim: `c${i}`, status: 'verified', source_url: livePage.url })),
      recording_checklist: Array.from({ length: 99 }, () => 'check'),
    },
  });

  assert.ok(pack.main_tool.name.length <= 200);
  assert.ok(pack.main_tool.steps.length <= 15);
  assert.ok(pack.main_tool.steps[0].length <= 400);
  assert.ok(pack.main_tool.prompts.length <= 10);
  assert.ok(pack.fact_check.length <= 40);
  assert.ok(pack.recording_checklist.length <= 15);
});

test('empty lists survive as empty, because a tool with no prompt box has none', async () => {
  const { normalisePack } = await load();
  const pack = normalisePack({
    pages: [livePage],
    pack: { main_tool: { name: 'A background remover', url: livePage.url, prompts: [] } },
  });
  assert.deepEqual(pack.main_tool.prompts, [], 'inventing prompts for a tool with no prompt is the classic failure');
});

// ---------- the prompts ----------

test('the research prompt gives the model the page text and forbids the rest', async () => {
  const { researchPrompt } = await load();
  const p = researchPrompt({
    topic: 'a 3D name tool',
    language: 'Hinglish',
    today: '2026-10-08',
    pages: [
      { ...livePage, title: 'NameForge', text: 'free plan exports at 720p' },
      deadPage,
    ],
  });

  // The text itself, so the model is reading rather than remembering.
  assert.match(p, /free plan exports at 720p/);
  assert.match(p, /SOURCE 1: https:\/\/nameforge\.test\//);
  assert.match(p, /ONLY source of fact/);
  assert.match(p, /Hinglish/);

  // The four things a viewer will check, and a model is most likely to invent.
  assert.match(p, /Never invent pricing, free limits, watermark behaviour, export quality/);
  assert.match(p, /better to return ten unverified claims than\s+one invented fact/);
  assert.match(p, /must be one of the sources above/);
  assert.match(p, /the page does not say/);
  assert.match(p, /do not invent prompts for a tool that has no prompt box/);

  // A dead URL is named as dead, so it cannot be written about.
  assert.match(p, /could NOT be read/);
  assert.match(p, /https:\/\/gone\.test\/ \(the page answered 404\)/);
});

test('with nothing fetched, the prompt says so rather than inviting a guess', async () => {
  const { researchPrompt } = await load();
  const p = researchPrompt({ topic: 'a tool', pages: [deadPage], today: '2026-10-08' });
  assert.match(p, /NOTHING could be fetched/);
  assert.match(p, /every claim must be "unverified"/);
  assert.ok(!/ONLY source of fact/.test(p), 'there is no source to call the only one');
});

test('candidates are asked for as names and URLs only, never as facts', async () => {
  const { candidatesPrompt, MAX_CANDIDATES } = await load();
  const p = candidatesPrompt({ topic: 'turn a name into 3D', language: 'English', today: '2026-10-08' });

  assert.match(p, new RegExp(`up to ${MAX_CANDIDATES} specific free tools`));
  assert.match(p, /OFFICIAL homepage URL/);
  assert.match(p, /not a blog post, not a review/);
  // The whole point: a candidate is a thing to go and check.
  assert.match(p, /CANDIDATES to be checked, not facts/);
  assert.match(p, /do\s+not state any limits or pricing/);
  assert.match(p, /do not claim any of them is free/);
  assert.match(p, /leave it out rather than guessing/);
  assert.match(p, /"candidates"/);
});

// ---------- handing the pack on ----------

test('only verified facts reach the script generator', async () => {
  const { normalisePack, packSummary } = await load();
  const pack = normalisePack({
    pages: [livePage],
    pack: {
      main_tool: { name: 'NameForge', url: livePage.url, what_it_does: 'makes a 3D name' },
      fact_check: [
        { claim: 'Exports at 720p free', status: 'verified', source_url: livePage.url },
        { claim: 'Has a secret 4K mode', status: 'unverified', source_url: '' },
      ],
    },
  });
  const summary = packSummary(pack);

  assert.match(summary, /Exports at 720p free/);
  assert.ok(!summary.includes('secret 4K'), 'an unverified claim must never reach a script');
  assert.match(summary, /Use these facts and no others/);
  assert.match(summary, /Do NOT state any limit, price, watermark behaviour or feature/);
  assert.match(summary, /leave it out of the\s+script rather than guessing/);

  // An ungrounded pack hands nothing on at all, rather than a heading with
  // nothing under it.
  assert.equal(packSummary(normalisePack({ pages: [deadPage], pack: {} })), '');
  assert.equal(packSummary(null), '');
});

test('a pack with nothing verified says so instead of looking authoritative', async () => {
  const { normalisePack, packSummary } = await load();
  const pack = normalisePack({
    pages: [livePage],
    pack: { main_tool: { name: 'NameForge', url: livePage.url }, fact_check: [{ claim: 'maybe', status: 'unverified', source_url: '' }] },
  });
  assert.match(packSummary(pack), /nothing could be verified/);
});

test('the label counts what is actually in the pack', async () => {
  const { normalisePack, packLabel } = await load();
  const pack = normalisePack({
    pages: [livePage],
    pack: {
      main_tool: { name: 'x', url: livePage.url },
      fact_check: [
        { claim: 'a', status: 'verified', source_url: livePage.url },
        { claim: 'b', status: 'unverified', source_url: '' },
      ],
    },
  });
  assert.equal(packLabel(pack), '1 source · 1 verified · 1 unverified');
  assert.equal(packLabel(null), '');
});

// ---------- importing a pack nobody here has fetched yet ----------
//
// shared/import-projects.mjs runs an imported pack through normalisePack()
// with no pages at all and checked:false — this is what that produces, and
// what Re-check links (vr-research's `recheck` mode) turns it back into.

test('checked:false marks every claim unchecked rather than trusting what arrived', async () => {
  const { normalisePack } = await load();
  const pack = normalisePack({
    checked: false,
    pack: {
      topic: 'a background remover',
      main_tool: { name: 'Bgless', url: 'https://bgless.example', reachable: true }, // the sender's own claim
      alternatives: [{ name: 'Other', url: 'https://other.example', reachable: true }],
      fact_check: [{ claim: 'free tier gives 5 images a day', status: 'verified', source_url: 'https://bgless.example' }],
      sources: ['https://bgless.example'],
    },
  });

  // Whatever the sender said about reachability is replaced with "not
  // checked", not with its own claim and not with a confident "false".
  assert.equal(pack.main_tool.reachable, null);
  assert.equal(pack.alternatives[0].reachable, null);
  // The claimed status is kept, not overwritten — Re-check links needs to
  // know what was claimed — but the pack as a whole is marked unchecked, and
  // that is what the UI actually displays from (see unchecked_count below).
  assert.equal(pack.fact_check[0].status, 'verified');
  assert.equal(pack.checked, false);
  assert.equal(pack.grounded, false, 'nothing has been fetched, so nothing can be grounded yet');
  assert.equal(pack.unchecked_count, 1);
  assert.equal(pack.verified_count, 0);
  assert.equal(pack.unverified_count, 0);

  // The claim itself survives — only the verdict about it is withheld.
  assert.equal(pack.main_tool.name, 'Bgless');
  assert.equal(pack.fact_check[0].claim, 'free tier gives 5 images a day');
  assert.deepEqual(pack.sources, ['https://bgless.example'], 'the claimed sources are kept, pending a real fetch');
});

test('an unchecked pack contributes nothing to a script prompt until it is rechecked', async () => {
  const { normalisePack, packSummary } = await load();
  const pack = normalisePack({
    checked: false,
    pack: { main_tool: { name: 'x' }, fact_check: [{ claim: 'a', status: 'verified', source_url: 'https://x.example' }] },
  });
  assert.equal(packSummary(pack), '', 'an unchecked claim must never reach the prompt as if it were fact');
});

test('Re-check links is normalisePack() called again, this time with real fetches', async () => {
  const { normalisePack } = await load();
  const imported = normalisePack({
    checked: false,
    pack: {
      topic: 'a background remover',
      main_tool: { name: 'Bgless', url: livePage.url },
      fact_check: [{ claim: 'free tier gives 5 images a day', status: 'verified', source_url: livePage.url }],
    },
  });

  // The recheck re-runs the SAME claims — imported is itself valid input to
  // normalisePack(), because a pack's shape never changes across a recheck.
  const rechecked = normalisePack({ checked: true, pages: [livePage], pack: imported, topic: imported.topic });

  assert.equal(rechecked.main_tool.reachable, true);
  assert.equal(rechecked.fact_check[0].status, 'verified');
  assert.equal(rechecked.grounded, true);
  assert.equal(rechecked.checked, true);
});

test('a claim that fails Re-check links is downgraded, not left looking untouched', async () => {
  const { normalisePack } = await load();
  const imported = normalisePack({
    checked: false,
    pack: { main_tool: { name: 'x' }, fact_check: [{ claim: 'invented limit', status: 'verified', source_url: 'https://dead.example' }] },
  });
  // The recheck fetches real pages, and dead.example is not among them.
  const rechecked = normalisePack({ checked: true, pages: [livePage], pack: imported });
  assert.equal(rechecked.fact_check[0].status, 'unverified', 'a claim citing a page that never loaded stays unverified');
});

test('packLabel says "not checked yet" rather than a false source count', async () => {
  const { normalisePack, packLabel } = await load();
  const pack = normalisePack({
    checked: false,
    pack: { fact_check: [{ claim: 'a', status: 'verified', source_url: 'x' }, { claim: 'b', status: 'verified', source_url: 'y' }] },
  });
  assert.equal(packLabel(pack), '2 claims · not checked yet');
  assert.equal(packLabel(normalisePack({ checked: false, pack: {} })), 'not checked yet');
});

// ---------- building a demo from the pack, not from the model ----------

test('packDemoSource builds the demo straight from the pack, when there is something to build from', async () => {
  const { normalisePack, packDemoSource } = await load();
  const pack = normalisePack({
    pages: [livePage],
    pack: {
      main_tool: {
        name: 'NameForge', url: livePage.url,
        steps: ['Open the site', 'Paste your name'],
        prompts: ['Give me 3D render options for the name "Alex"'],
      },
      test_plan: ['show the 3D render actually changes when the name changes'],
      recording_checklist: ['have a sample name ready'],
    },
  });
  const demo = packDemoSource(pack);
  assert.equal(demo.tool, 'NameForge');
  assert.equal(demo.url, livePage.url);
  assert.deepEqual(demo.steps, ['Open the site', 'Paste your name']);
  assert.deepEqual(demo.prompts, ['Give me 3D render options for the name "Alex"']);
  assert.deepEqual(demo.check, ['show the 3D render actually changes when the name changes']);
  assert.deepEqual(demo.prepare, ['have a sample name ready']);
});

test('packDemoSource is null with nothing fetched, or a pack with no steps or prompts at all', async () => {
  const { normalisePack, packDemoSource } = await load();
  assert.equal(packDemoSource(null), null);
  assert.equal(packDemoSource(normalisePack({ pages: [], pack: { main_tool: { name: 'x' } } })), null, 'ungrounded');
  // Ungrounded specifically — not just "no steps" — even though the pack DOES
  // carry steps and prompts: nothing was fetched, so there is nothing real to
  // build a demo from, whatever the model wrote.
  assert.equal(
    packDemoSource(normalisePack({ pages: [], pack: { main_tool: { name: 'x', steps: ['a'], prompts: ['b'] } } })),
    null,
    'ungrounded, even with steps and prompts present',
  );
  assert.equal(
    packDemoSource(normalisePack({ pages: [livePage], pack: { main_tool: { name: 'x', url: livePage.url } } })),
    null,
    'grounded, but the pack never found a how-to',
  );
});

test('packDemoSource still uses an unchecked pack\'s steps, but marks the demo unchecked', async () => {
  const { normalisePack, packDemoSource } = await load();
  const pack = normalisePack({
    checked: false,
    pack: {
      topic: 'a background remover',
      main_tool: {
        name: 'Bgless', url: 'https://bgless.example',
        steps: ['Open bgless.example', 'Drop the photo'],
        prompts: ['Remove the background from this photo'],
      },
      test_plan: ['the background is actually gone'],
    },
  });
  assert.equal(pack.checked, false);
  assert.equal(pack.grounded, false, 'nothing has been fetched, so this is not confused with a real fetch');

  const demo = packDemoSource(pack);
  // Still built from the pack's own real steps — not thrown away just because
  // nobody has fetched the page for this app yet.
  assert.equal(demo.tool, 'Bgless');
  assert.deepEqual(demo.steps, ['Open bgless.example', 'Drop the photo']);
  assert.deepEqual(demo.prompts, ['Remove the background from this photo']);
  assert.equal(demo.checked, false, 'the confidence, not the content, is what differs from a checked pack');
});

test('packDemoSource marks a rechecked, grounded pack as checked', async () => {
  const { normalisePack, packDemoSource } = await load();
  const pack = normalisePack({
    pages: [livePage],
    pack: {
      main_tool: { name: 'NameForge', url: livePage.url, steps: ['Open the site'], prompts: ['Give me a name'] },
    },
  });
  assert.equal(packDemoSource(pack).checked, true);
});

test('packSummary carries steps and prompts too, so beats are written consistent with the demo', async () => {
  const { normalisePack, packSummary } = await load();
  const pack = normalisePack({
    pages: [livePage],
    pack: {
      main_tool: { name: 'x', url: livePage.url, steps: ['Step one'], prompts: ['Exact prompt text'] },
    },
  });
  const summary = packSummary(pack);
  assert.match(summary, /Steps read off the page:\n- Step one/);
  assert.match(summary, /Exact prompt text/);
});
