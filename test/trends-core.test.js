// Tests for shared/trends-core.mjs — collecting trends and storing them.
//
// The sources are stubbed, so this runs offline with no API key. What is being
// checked is the part the cloud version adds: that rows carry an owner, that a
// source which failed does not get its section of the radar wiped, that the
// YouTube quota is counted against the usage table, and that old runs are
// dropped.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runRefresh, toRow, usagePort } = require('../shared/trends-core.mjs');

const USER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-07T09:00:00Z'); // 2:30pm IST, so the IST day is the 7th

const item = (url, over = {}) => ({
  url, title: 'A trend ' + url, source: 'hackernews', summary: 's', thumbnail: null,
  views: 10, views_per_hour: null, published_at: '2026-10-07T06:00:00Z', score: 5, ...over,
});

/** A stand-in for the trends and usage tables. */
function fakeStore(usage = {}) {
  const calls = { replaced: [], pruned: [], usageAdds: [] };
  return {
    calls,
    userId: USER,
    async getUsage(provider) { return usage[provider] || { units: 0, requests: 0 }; },
    async addUsage(provider, units, requests) {
      calls.usageAdds.push({ provider, units, requests });
      const current = usage[provider] || { units: 0, requests: 0 };
      usage[provider] = { units: current.units + units, requests: current.requests + requests };
    },
    async replaceDay(day, sources, rows) { calls.replaced.push({ day, sources, rows }); },
    async prune(before) { calls.pruned.push(before); },
  };
}

test('every stored row belongs to the person who ran the refresh', async () => {
  const store = fakeStore();
  await runRefresh(store, {
    now: NOW,
    sources: { hackernews: async () => [item('https://a/1'), item('https://a/2')] },
  });

  const { rows } = store.calls.replaced[0];
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.user_id, USER, 'a trend with no owner could never be read back');
    assert.equal(row.fetched_on, '2026-10-07');
  }
});

test('a row keeps what the radar screen draws', async () => {
  const row = toRow(
    item('https://a/1', { source: 'youtube', views: 12000, views_per_hour: 400, keyword: 'ai tools' }),
    { userId: USER, day: '2026-10-07', fetchedAt: NOW.toISOString() },
  );
  assert.equal(row.views, 12000);
  assert.equal(row.views_per_hour, 400);
  assert.equal(row.score, 5);
  // The keyword has no column of its own; the screen reads it out of extra.
  assert.deepEqual(row.extra, { keyword: 'ai tools' });
  assert.equal(row.published_at, '2026-10-07T06:00:00Z');
});

test('a trend with nothing extra gets an empty object, not null', async () => {
  const row = toRow(item('https://a/1'), { userId: USER, day: '2026-10-07', fetchedAt: NOW.toISOString() });
  assert.deepEqual(row.extra, {}, 'the column is not null, so neither is this');
  assert.equal(row.thumbnail, null);
});

test('only the sources that answered have their rows replaced', async () => {
  const store = fakeStore();
  const summary = await runRefresh(store, {
    now: NOW,
    sources: {
      hackernews: async () => [item('https://a/1')],
      reddit: async () => { throw new Error('HTTP 429 from www.reddit.com'); },
      github: async () => [item('https://g/1', { source: 'github' })],
    },
  });

  const { sources } = store.calls.replaced[0];
  assert.deepEqual(sources.sort(), ['github', 'hackernews']);
  assert.ok(!sources.includes('reddit'),
    'wiping reddit because it rate limited would empty that part of the radar for the day');
  assert.deepEqual(summary.failed, ['reddit']);
  assert.equal(summary.sources.reddit.ok, false);
  assert.match(summary.sources.reddit.error, /429/);
});

test('one source failing does not lose the others', async () => {
  const store = fakeStore();
  const summary = await runRefresh(store, {
    now: NOW,
    sources: {
      hackernews: async () => [item('https://a/1')],
      github: async () => { throw new Error('HTTP 403'); },
    },
  });
  assert.equal(summary.total, 1);
  assert.equal(summary.stored, 1);
});

test('the same story from two sources is stored once, highest score winning', async () => {
  const store = fakeStore();
  await runRefresh(store, {
    now: NOW,
    sources: {
      hackernews: async () => [item('https://www.example.com/post/', { score: 3 })],
      reddit: async () => [item('http://example.com/post?utm_source=x', { source: 'reddit', score: 40 })],
    },
  });
  const { rows } = store.calls.replaced[0];
  assert.equal(rows.length, 1, 'the two spellings of one URL are one trend');
  assert.equal(rows[0].url, 'https://example.com/post');
  assert.equal(rows[0].score, 40);
  assert.equal(rows[0].source, 'reddit');
});

test('runs older than two weeks are dropped', async () => {
  const store = fakeStore();
  await runRefresh(store, { now: NOW, sources: { hackernews: async () => [] } });
  assert.deepEqual(store.calls.pruned, ['2026-09-23'], '14 days before the 7th');
});

test('the YouTube quota is counted against the usage table', async () => {
  const store = fakeStore();
  const port = usagePort(store);
  assert.deepEqual(await port.get(), { units: 0, requests: 0 });

  await port.add(100, 1);
  await port.add(1, 0);
  assert.deepEqual(await port.get(), { units: 101, requests: 1 });
  assert.deepEqual(store.calls.usageAdds, [
    { provider: 'youtube', units: 100, requests: 1 },
    { provider: 'youtube', units: 1, requests: 0 },
  ]);
});

test('yesterday\'s quota does not count against today', async () => {
  // The counter is read per IST day, so a fresh day starts at zero even though
  // the row for yesterday is still there.
  const store = fakeStore({ youtube: { units: 2500, requests: 25 } });
  assert.deepEqual(await usagePort(store).get(), { units: 2500, requests: 25 });
  const empty = fakeStore();
  assert.deepEqual(await usagePort(empty).get(), { units: 0, requests: 0 });
});

test('a refresh that finds nothing still records the run and prunes', async () => {
  const store = fakeStore();
  const summary = await runRefresh(store, { now: NOW, sources: { hackernews: async () => [] } });
  assert.equal(summary.total, 0);
  assert.equal(store.calls.replaced.length, 1, 'the day must still be cleared, or stale rows linger');
  assert.equal(store.calls.pruned.length, 1);
});

test('the IST day is used, not UTC', async () => {
  // 20:00 UTC is already the next day in India, and the radar is an IST thing.
  const store = fakeStore();
  await runRefresh(store, {
    now: new Date('2026-10-07T20:00:00Z'),
    sources: { hackernews: async () => [item('https://a/1')] },
  });
  assert.equal(store.calls.replaced[0].day, '2026-10-08');
});
