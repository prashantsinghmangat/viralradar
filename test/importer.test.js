const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../server/db');
const { importExport, ImportError } = require('../server/importer');
const { streaks } = require('../server/routes/results');

const wrap = (type, items, extra = {}) => ({ app: 'shorts-studio', schema: 1, type, exported_at: '2026-10-06T08:00:00Z', items, ...extra });

const script = (id, title = 'Free AI site that edits PDFs') => ({
  id, created_at: '2026-10-05T10:00:00Z', topic: 'pdf tool', title,
  beats: [{ t: '0-3s', say: 'Stop paying for PDF editors', screen: 'Face + logo' }],
  thumbnail_text: 'FREE PDF AI', yt_title: 'This free AI edits any PDF', ig_caption: 'Save this', fb_caption: 'Try it',
  hashtags: ['#ai', '#tools'], pinned_comment: 'Link in bio', broll: ['screen recording'], audio: 'lofi',
});
const result = (id, views = 1000) => ({
  id, logged_at: '2026-10-06T09:00:00Z', title: 'PDF AI', posted_on: '2026-10-05', platforms: ['yt', 'ig'],
  format: 'listicle', hook: 'question', len: '30s', cta: 'save', views, likes: 50, comments: 5, shares: 3, saves: 20, follows: 2,
});

const fresh = () => openDb(':memory:');

test('valid script export is imported with all fields and raw_json kept', () => {
  const db = fresh();
  const item = { ...script('s1'), future_field: 'keep me' };
  const r = importExport(db, JSON.stringify(wrap('script', [item])));
  assert.equal(r.ok, true);
  assert.equal(r.message, 'Imported 1 script: Free AI site that edits PDFs');
  const row = db.prepare('SELECT * FROM scripts WHERE id = ?').get('s1');
  assert.equal(row.yt_title, 'This free AI edits any PDF');
  assert.deepEqual(JSON.parse(row.hashtags), ['#ai', '#tools']);
  assert.equal(row.stage, 'to_shoot');
  assert.equal(JSON.parse(row.raw_json).future_field, 'keep me');
});

test('valid ideas and results exports', () => {
  const db = fresh();
  importExport(db, wrap('ideas', [{ id: 'i1', date: '2026-10-06', title: 'Idea', hook: 'h', tool: 't', show: 's', why: 'w', format: 'f' }]));
  importExport(db, wrap('results', [result('r1')]));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM ideas').get().c, 1);
  assert.equal(db.prepare('SELECT views FROM results WHERE id = ?').get('r1').views, 1000);
});

test('wrong app is rejected with a clear message and nothing is written', () => {
  const db = fresh();
  assert.throws(() => importExport(db, { ...wrap('script', [script('s1')]), app: 'other-tool' }),
    (e) => e instanceof ImportError && /Wrong app/.test(e.message) && /other-tool/.test(e.message));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM scripts').get().c, 0);
  const log = db.prepare('SELECT * FROM imports_log').get();
  assert.equal(log.ok, 0);
});

test('schema mismatch is rejected', () => {
  const db = fresh();
  assert.throws(() => importExport(db, wrap('script', [script('s1')], { schema: 2 })),
    (e) => e instanceof ImportError && /Schema mismatch/.test(e.message));
  assert.throws(() => importExport(db, wrap('script', [script('s1')], { schema: '1' })), /Schema mismatch/);
});

test('invalid JSON, unknown type and missing ids are rejected', () => {
  const db = fresh();
  assert.throws(() => importExport(db, '{ not json'), /not valid JSON/);
  assert.throws(() => importExport(db, wrap('video', [script('s1')])), /Unknown export type/);
  assert.throws(() => importExport(db, wrap('script', [{ title: 'no id' }])), /has no "id"/);
});

test('re-import upserts: no duplicates, newer numbers win, pipeline stage is kept', () => {
  const db = fresh();
  importExport(db, wrap('script', [script('s1', 'Old title')]));
  db.prepare("UPDATE scripts SET stage = 'shot' WHERE id = 's1'").run();
  const r = importExport(db, wrap('script', [script('s1', 'New title')]));
  assert.match(r.message, /1 updated/);
  const rows = db.prepare('SELECT * FROM scripts').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'New title');
  assert.equal(rows[0].stage, 'shot');

  importExport(db, wrap('results', [result('r1', 1000)]));
  importExport(db, wrap('results', [result('r1', 5400)]));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM results').get().c, 1);
  assert.equal(db.prepare('SELECT views FROM results').get().views, 5400);
});

test('bundle imports mixed scripts and results in one go', () => {
  const db = fresh();
  const r = importExport(db, wrap('bundle', [
    { ...script('s1'), kind: 'script' }, { ...result('r1'), kind: 'result' }, { ...result('r2'), kind: 'result' },
  ]));
  assert.deepEqual(r.counts, { script: { added: 1, updated: 0 }, result: { added: 2, updated: 0 } });
  assert.equal(r.message, 'Imported 1 script, 2 results');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM scripts').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM results').get().c, 2);
});

test('bundle with an unknown kind is rejected atomically', () => {
  const db = fresh();
  assert.throws(() => importExport(db, wrap('bundle', [{ ...script('s1'), kind: 'script' }, { id: 'x', kind: 'video' }])), /kind "video"/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM scripts').get().c, 0);
});

test('trend URLs are normalized for dedupe', () => {
  const { normalizeUrl } = require('../server/jobs/radar');
  const a = normalizeUrl('https://mistral.ai/news/mistral-large-4/');
  assert.equal(a, 'https://mistral.ai/news/mistral-large-4');
  assert.equal(normalizeUrl('https://mistral.ai/news/mistral-large-4/\\'), a);
  assert.equal(normalizeUrl('http://www.mistral.ai/news/mistral-large-4?utm_source=hn#x'), a);
  assert.equal(normalizeUrl('https://x.com/'), 'https://x.com/');
  assert.equal(normalizeUrl('https://a.com/p?id=2&ref=hn'), 'https://a.com/p?id=2');
});

test('posting streak counts consecutive days', () => {
  assert.deepEqual(streaks(['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-01'], '2026-10-06'),
    { current: 3, longest: 3, last_posted: '2026-10-06' });
  assert.equal(streaks(['2026-10-04', '2026-10-05'], '2026-10-06').current, 2); // nothing today yet
  assert.equal(streaks(['2026-10-01'], '2026-10-06').current, 0);
});
