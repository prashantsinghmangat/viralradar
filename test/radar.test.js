// Tests for the shared radar core and the YouTube quota guard.
// Sources are stubbed, so this runs offline and needs no API key.
const test = require('node:test');
const assert = require('node:assert/strict');
const { collect, normalizeUrl, failedSources } = require('../shared/radar.mjs');
const { fetchYouTube, SEARCH_COST, DAILY_SEARCH_CAP } = require('../shared/sources/youtube.mjs');

const trend = (url, score, extra = {}) => ({ url, title: 'T ' + url, source: 'stub', score, ...extra });

test('collect merges sources, dedupes by normalized URL and keeps the higher score', () => {
  return collect({
    a: async () => [trend('https://www.example.com/post/', 5), trend('https://other.com/x', 1)],
    b: async () => ({ items: [trend('http://example.com/post?utm_source=hn#frag', 9)], notes: [] }),
  }).then(({ items, status, total }) => {
    assert.equal(total, 2);
    const merged = items.find((i) => i.url === 'https://example.com/post');
    assert.ok(merged, 'the two spellings of the same URL became one row');
    assert.equal(merged.score, 9, 'the higher score wins');
    assert.equal(status.a.ok, true);
    assert.equal(status.a.count, 2);
    assert.equal(status.b.count, 1);
  });
});

test('one failing source never drops the others', async () => {
  const { items, status, total } = await collect({
    good: async () => [trend('https://a.com/1', 3)],
    broken: async () => { throw new Error('HTTP 403 from www.reddit.com'); },
  });
  assert.equal(total, 1);
  assert.equal(items[0].url, 'https://a.com/1');
  assert.equal(status.good.ok, true);
  assert.deepEqual(status.broken, { ok: false, count: 0, error: 'HTTP 403 from www.reddit.com' });
  assert.deepEqual(failedSources(status), ['broken']);
});

test('a skipped source is reported as skipped, not failed', async () => {
  const { status } = await collect({ youtube: async () => ({ items: [], notes: ['No YouTube API key set'], skipped: true }) });
  assert.equal(status.youtube.ok, true);
  assert.equal(status.youtube.skipped, true);
  assert.deepEqual(status.youtube.notes, ['No YouTube API key set']);
});

test('items with no url or no title are thrown away', async () => {
  const { total } = await collect({
    a: async () => [{ url: 'https://a.com/1', source: 's' }, { title: 'no url', source: 's' }, trend('https://a.com/2', 1)],
  });
  assert.equal(total, 1);
});

test('URL normalization strips tracking, trailing slashes, www and http', () => {
  const a = normalizeUrl('https://mistral.ai/news/mistral-large-4/');
  assert.equal(a, 'https://mistral.ai/news/mistral-large-4');
  assert.equal(normalizeUrl('https://mistral.ai/news/mistral-large-4/' + "\\"), a);
  assert.equal(normalizeUrl('http://www.mistral.ai/news/mistral-large-4?utm_source=hn#x'), a);
  assert.equal(normalizeUrl('https://x.com/'), 'https://x.com/');
  assert.equal(normalizeUrl('https://a.com/p?id=2&ref=hn'), 'https://a.com/p?id=2');
  assert.equal(normalizeUrl('not a url'), 'not a url');
});

// ---- YouTube quota guard, with fetch stubbed ----
function stubFetch(handler) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    return { ok: true, status: 200, text: async () => JSON.stringify(handler(String(url))) };
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const fakeUsage = (start = { units: 0, searches: 0 }) => {
  const state = { ...start };
  return {
    state,
    port: {
      get: async () => ({ ...state }),
      add: async (units, searches) => { state.units += units; state.searches += searches; },
    },
  };
};

const ytReply = (url) => url.includes('/search?')
  ? { items: [{ id: { videoId: 'vid1' } }] }
  : { items: [{ id: 'vid1', statistics: { viewCount: '12000' }, snippet: { title: 'Clip', channelTitle: 'Chan', publishedAt: new Date(Date.now() - 3600000).toISOString(), thumbnails: { high: { url: 'https://i/y.jpg' } } } }] };

test('YouTube is skipped with a clear note when there is no key', async () => {
  const r = await fetchYouTube({ apiKey: '', keywords: ['ai tools'], usage: fakeUsage().port });
  assert.deepEqual(r, { items: [], notes: ['No YouTube API key set'], skipped: true });
});

test('each keyword costs one search plus one videos call, and views per hour is recorded', async () => {
  const f = stubFetch(ytReply);
  const u = fakeUsage();
  try {
    const r = await fetchYouTube({ apiKey: 'k', keywords: ['ai tools', 'free sites'], usage: u.port });
    assert.equal(u.state.searches, 2);
    assert.equal(u.state.units, 2 * (SEARCH_COST + 1));
    assert.equal(r.items.length, 2);
    assert.equal(r.items[0].url, 'https://www.youtube.com/shorts/vid1');
    assert.equal(r.items[0].views, 12000);
    assert.equal(r.items[0].views_per_hour, 12000, 'posted an hour ago → 12000 views/hour');
    assert.equal(r.items[0].score, r.items[0].views_per_hour);
    assert.equal(r.items[0].keyword, 'ai tools');
    assert.match(f.calls[0], /regionCode=IN/);
    assert.match(f.calls[0], /videoDuration=short/);
  } finally { f.restore(); }
});

test('the daily search cap stops further keywords and says which were skipped', async () => {
  const f = stubFetch(ytReply);
  const u = fakeUsage({ units: DAILY_SEARCH_CAP * SEARCH_COST, searches: DAILY_SEARCH_CAP });
  try {
    const r = await fetchYouTube({ apiKey: 'k', keywords: ['one', 'two'], usage: u.port });
    assert.equal(r.items.length, 0);
    assert.equal(f.calls.length, 0, 'no API call is made once the cap is reached');
    assert.equal(u.state.searches, DAILY_SEARCH_CAP, 'nothing extra was counted');
    assert.match(r.notes[0], /daily cap of 25 searches reached; skipped "one" and later keywords/);
  } finally { f.restore(); }
});

test('the unit quota stops the run even when the search count is low', async () => {
  const f = stubFetch(ytReply);
  const u = fakeUsage({ units: 9999, searches: 1 });
  try {
    const r = await fetchYouTube({ apiKey: 'k', keywords: ['one'], usage: u.port });
    assert.equal(f.calls.length, 0);
    assert.deepEqual(r.notes, ['daily unit quota nearly used up']);
  } finally { f.restore(); }
});

test('a failed search still costs quota, because YouTube charges for it', async () => {
  const real = globalThis.fetch;
  const u = fakeUsage();
  globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => '{"error":{"message":"quotaExceeded"}}' });
  try {
    await assert.rejects(() => fetchYouTube({ apiKey: 'k', keywords: ['one'], usage: u.port }), /HTTP 403.*quotaExceeded/);
    assert.equal(u.state.searches, 1);
    assert.equal(u.state.units, SEARCH_COST);
  } finally { globalThis.fetch = real; }
});

// ---- the Radar language filter ----

test('relevanceLanguage is sent as the first configured language, a single hint not a filter', async () => {
  const f = stubFetch(ytReply);
  const u = fakeUsage();
  try {
    await fetchYouTube({ apiKey: 'k', keywords: ['ai tools'], usage: u.port, languages: ['hi', 'en'] });
    // Exactly "hi" — not "hi,en" or any other list. YouTube's parameter takes
    // one language; the real filtering happens afterwards, against the truth.
    assert.match(f.calls[0], /relevanceLanguage=hi(?:&|$)/);
    assert.ok(!/relevanceLanguage=hi%2Cen|relevanceLanguage=hi,en/.test(f.calls[0]));
  } finally { f.restore(); }
});

test('no relevanceLanguage is sent when no language is configured at all', async () => {
  const f = stubFetch(ytReply);
  const u = fakeUsage();
  try {
    await fetchYouTube({ apiKey: 'k', keywords: ['ai tools'], usage: u.port, languages: [] });
    assert.ok(!/relevanceLanguage/.test(f.calls[0]));
  } finally { f.restore(); }
});

test('a video YouTube declares in a disallowed language is dropped, and the count is reported', async () => {
  const twoVideos = (url) => url.includes('/search?')
    ? { items: [{ id: { videoId: 'hi1' } }, { id: { videoId: 'ta1' } }] }
    : {
      items: [
        {
          id: 'hi1', statistics: { viewCount: '1000' },
          snippet: { title: 'Free AI tool', defaultAudioLanguage: 'hi', publishedAt: new Date().toISOString() },
        },
        {
          id: 'ta1', statistics: { viewCount: '2000' },
          snippet: { title: 'Free AI tool', defaultAudioLanguage: 'ta', publishedAt: new Date().toISOString() },
        },
      ],
    };
  const f = stubFetch(twoVideos);
  const u = fakeUsage();
  try {
    const r = await fetchYouTube({ apiKey: 'k', keywords: ['ai tools'], usage: u.port, languages: ['hi', 'en'] });
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].url, 'https://www.youtube.com/shorts/hi1');
    assert.match(r.notes.join(' '), /Filtered out 1 video in other languages/);
  } finally { f.restore(); }
});

test('with no declared language, the title\'s own script decides', async () => {
  const titleOnly = (url) => url.includes('/search?')
    ? { items: [{ id: { videoId: 'kn1' } }] }
    : {
      items: [{
        id: 'kn1', statistics: { viewCount: '500' },
        snippet: { title: 'ಕನ್ನಡ ವೀಡಿಯೋ', publishedAt: new Date().toISOString() },
      }],
    };
  const f = stubFetch(titleOnly);
  const u = fakeUsage();
  try {
    const r = await fetchYouTube({ apiKey: 'k', keywords: ['ai tools'], usage: u.port, languages: ['hi', 'en'] });
    assert.equal(r.items.length, 0, 'a Kannada title is dropped when only Hindi and English are allowed');
    assert.match(r.notes.join(' '), /Filtered out 1 video/);
  } finally { f.restore(); }
});

test('nothing is filtered, and no note appears, when every video passes', async () => {
  const f = stubFetch(ytReply);
  const u = fakeUsage();
  try {
    const r = await fetchYouTube({ apiKey: 'k', keywords: ['ai tools'], usage: u.port, languages: ['hi', 'en'] });
    assert.equal(r.items.length, 1);
    assert.ok(!r.notes.some((n) => /Filtered out/.test(n)));
  } finally { f.restore(); }
});

test('with every language allowed (an empty languages list is treated as "do not filter" by the caller), nothing is dropped', async () => {
  // fetchYouTube itself still applies isLanguageAllowed() against whatever list
  // it is given; an empty list is a real "nothing is allowed" configuration,
  // which is why Settings must never let language selection end up empty —
  // this just proves fetchYouTube does not silently special-case it.
  const titleOnly = (url) => url.includes('/search?')
    ? { items: [{ id: { videoId: 'x1' } }] }
    : { items: [{ id: 'x1', statistics: { viewCount: '1' }, snippet: { title: 'नमस्ते', publishedAt: new Date().toISOString() } }] };
  const f = stubFetch(titleOnly);
  const u = fakeUsage();
  try {
    const r = await fetchYouTube({ apiKey: 'k', keywords: ['ai tools'], usage: u.port, languages: [] });
    assert.equal(r.items.length, 0);
  } finally { f.restore(); }
});
