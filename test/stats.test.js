// Tests for shared/stats.mjs. These numbers are drawn by the Results screen,
// which computes them in the browser in the cloud build, so they must not
// depend on a server or a database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { groupStats, streaks, resultStats } = require('../shared/stats.mjs');

const r = (o) => ({ id: 'x', views: 0, likes: 0, comments: 0, shares: 0, saves: 0, follows: 0, ...o });

test('groupStats averages views and computes save rate per group', () => {
  const rows = [
    r({ format: 'demo', views: 1000, saves: 100 }),
    r({ format: 'demo', views: 3000, saves: 100 }),
    r({ format: 'listicle', views: 500, saves: 50 }),
  ];
  const by = groupStats(rows, 'format');
  assert.deepEqual(by.map((g) => g.label), ['demo', 'listicle'], 'sorted by average views, highest first');
  assert.equal(by[0].count, 2);
  assert.equal(by[0].avg_views, 2000);
  assert.equal(by[0].save_rate, 5, '200 saves on 4000 views is 5%');
  assert.equal(by[1].save_rate, 10);
});

test('groupStats labels blank and missing values as (none) and never divides by zero', () => {
  const by = groupStats([r({ format: '  ' }), r({ views: 0, saves: 0 })], 'format');
  assert.equal(by.length, 1);
  assert.equal(by[0].label, '(none)');
  assert.equal(by[0].count, 2);
  assert.equal(by[0].save_rate, 0);
  assert.equal(by[0].avg_views, 0);
});

test('streaks counts consecutive days, today or ending yesterday', () => {
  assert.deepEqual(streaks(['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-01'], '2026-10-06'),
    { current: 3, longest: 3, last_posted: '2026-10-06' });
  assert.equal(streaks(['2026-10-04', '2026-10-05'], '2026-10-06').current, 2, 'nothing posted today yet');
  assert.equal(streaks(['2026-10-01'], '2026-10-06').current, 0, 'the streak is broken');
  assert.deepEqual(streaks([], '2026-10-06'), { current: 0, longest: 0, last_posted: null });
  assert.deepEqual(streaks([null, '', 'not-a-date', '2026-10-06'], '2026-10-06'),
    { current: 1, longest: 1, last_posted: '2026-10-06' }, 'junk dates are ignored');
  // Two posts on the same day count once.
  assert.equal(streaks(['2026-10-06', '2026-10-06', '2026-10-05'], '2026-10-06').current, 2);
  // A month boundary is still consecutive.
  assert.equal(streaks(['2026-09-30', '2026-10-01'], '2026-10-01').current, 2);
});

test('resultStats returns the whole Results payload', () => {
  const rows = [
    r({ id: 'a', title: 'A', views: 10000, saves: 500, posted_on: '2026-10-06', format: 'demo', hook: 'question', len: '30s', cta: 'save' }),
    r({ id: 'b', title: 'B', views: 2000, saves: 40, posted_on: '2026-10-05', format: 'listicle', hook: 'claim', len: '45s', cta: 'follow' }),
  ];
  const st = resultStats(rows, '2026-10-06');
  assert.equal(st.count, 2);
  assert.equal(st.total_views, 12000);
  assert.equal(st.avg_views, 6000);
  assert.equal(st.save_rate, 4.5);
  assert.deepEqual(Object.keys(st.by), ['format', 'hook', 'len', 'cta']);
  assert.equal(st.streak.current, 2);
  assert.equal(st.top[0].id, 'a', 'top videos are sorted by views');
  assert.deepEqual(Object.keys(st.top[0]), ['id', 'title', 'views', 'saves', 'posted_on', 'format']);
});

test('resultStats on an empty list returns zeros, not NaN', () => {
  const st = resultStats([], '2026-10-06');
  assert.equal(st.count, 0);
  assert.equal(st.avg_views, 0);
  assert.equal(st.save_rate, 0);
  assert.deepEqual(st.top, []);
  assert.equal(st.streak.current, 0);
  for (const v of Object.values(st)) assert.ok(!Number.isNaN(v), 'no NaN anywhere');
});
