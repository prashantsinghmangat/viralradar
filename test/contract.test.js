// Tests for shared/contract.mjs — the runtime-agnostic half of the importer.
// These assert on the exact values the Supabase "import" function will write,
// without needing a database of any kind.
const test = require('node:test');
const assert = require('node:assert/strict');
const { prepare, ROW, summarize, titleOf, ts, ImportError, SOURCES } = require('../shared/contract.mjs');

const wrap = (type, items, extra = {}) => ({ app: 'shorts-studio', schema: 1, type, exported_at: '2026-10-06T08:00:00Z', items, ...extra });
const one = (type, item) => prepare(wrap(type, [item])).entries[0].row;

test('arrays stay native arrays, ready for Postgres text[] / jsonb', () => {
  const row = one('script', {
    id: 's1', beats: [{ t: '0-3s', say: 'hi' }], hashtags: ['#ai', '#tools'], broll: ['screen recording'],
  });
  assert.ok(Array.isArray(row.beats) && Array.isArray(row.hashtags) && Array.isArray(row.broll));
  assert.deepEqual(row.hashtags, ['#ai', '#tools']);
  assert.equal(row.beats[0].say, 'hi');
  // A single value or a missing value both become an array, never null.
  assert.deepEqual(one('script', { id: 's2', hashtags: '#solo' }).hashtags, ['#solo']);
  assert.deepEqual(one('script', { id: 's3' }).broll, []);
  assert.deepEqual(one('results', { id: 'r1' }).platforms, []);
});

test('origin_at comes from the export, with a per-kind fallback chain', () => {
  assert.equal(one('ideas', { id: 'i1', date: '2026-10-06' }).origin_at, '2026-10-06T00:00:00.000Z');
  assert.equal(one('script', { id: 's1', created_at: '2026-10-05T10:00:00Z' }).origin_at, '2026-10-05T10:00:00.000Z');
  assert.equal(one('results', { id: 'r1', logged_at: '2026-10-06T09:00:00Z' }).origin_at, '2026-10-06T09:00:00.000Z');
  // Fallbacks: a script with only a date, a result with only posted_on.
  assert.equal(one('script', { id: 's2', date: '2026-10-04' }).origin_at, '2026-10-04T00:00:00.000Z');
  assert.equal(one('results', { id: 'r2', posted_on: '2026-10-03' }).origin_at, '2026-10-03T00:00:00.000Z');
});

test('origin_at falls back to import time when the export has no usable date', () => {
  const before = Date.now();
  for (const row of [one('ideas', { id: 'i1' }), one('script', { id: 's1', created_at: 'not a date' })]) {
    const t = Date.parse(row.origin_at);
    assert.ok(t >= before - 1000 && t <= Date.now() + 1000, `${row.origin_at} should be about now`);
  }
});

test('ts() parses dates and timestamps, and rejects junk', () => {
  assert.equal(ts('2026-10-06'), '2026-10-06T00:00:00.000Z');
  assert.equal(ts('2026-10-06T09:00:00Z'), '2026-10-06T09:00:00.000Z');
  for (const bad of [null, undefined, '', 'tomorrow', {}]) assert.equal(ts(bad), null);
});

test('source is kept when known and defaults to shorts-studio otherwise', () => {
  for (const s of SOURCES) assert.equal(one('ideas', { id: 'i', source: s }).source, s);
  assert.equal(one('ideas', { id: 'i' }).source, 'shorts-studio');
  assert.equal(one('ideas', { id: 'i', source: 'hacked' }).source, 'shorts-studio');
  assert.equal(one('script', { id: 's', source: 'gemini' }).source, 'gemini');
});

test('results keep script_id so a result can point at its script', () => {
  assert.equal(one('results', { id: 'r1', script_id: 'scr_001' }).script_id, 'scr_001');
  assert.equal(one('results', { id: 'r2' }).script_id, null);
});

test('numbers survive commas and blanks become null, not zero', () => {
  const row = one('results', { id: 'r1', views: '12,400', likes: '', comments: 0, shares: null });
  assert.equal(row.views, 12400);
  assert.equal(row.likes, null);
  assert.equal(row.comments, 0);
  assert.equal(row.shares, null);
});

test('a byte order mark in front of the JSON is tolerated', () => {
  const text = '﻿' + JSON.stringify(wrap('ideas', [{ id: 'i1', title: 'T' }]));
  assert.equal(prepare(text).entries.length, 1);
});

test('prepare validates everything before shaping anything', () => {
  assert.throws(() => prepare('   '), /Nothing to import/);
  assert.throws(() => prepare(wrap('ideas', [])), /no items in it/);
  assert.throws(() => prepare(wrap('ideas', 'nope')), /no "items" array/);
  assert.throws(() => prepare([1, 2]), /Expected one JSON object/);
});

test('a bundle item of a kind this version does not know is skipped, not refused', () => {
  // Forward compatibility: a newer Shorts Studio sending something this
  // version has never heard of must not sink the items around it in the
  // same file.
  const { entries, skipped } = prepare(wrap('bundle', [
    { id: 'a', kind: 'script', title: 'S' }, { id: 'b', kind: 'video' }, { id: 'c', kind: 'video' },
  ]));
  assert.deepEqual(entries.map((e) => e.kind), ['script']);
  assert.deepEqual(skipped, ['video', 'video']);
});

test('titleOf and summarize produce the message the UI shows', () => {
  assert.equal(titleOf({ id: 'x', title: 'A', yt_title: 'B' }), 'A');
  assert.equal(titleOf({ id: 'x', yt_title: 'B' }), 'B');
  assert.equal(titleOf({ id: 'x', topic: 'C' }), 'C');
  assert.equal(titleOf({ id: 'x', text: 'D' }), 'D');
  assert.equal(titleOf({ id: 'x' }), 'x');
  assert.equal(summarize({ script: { added: 1, updated: 0 } }, ['Free AI site']), 'Imported 1 script: Free AI site');
  assert.equal(summarize({ script: { added: 1, updated: 0 }, result: { added: 2, updated: 0 } }, ['a', 'b', 'c']), 'Imported 1 script, 2 results');
  assert.equal(summarize({ idea: { added: 0, updated: 3 } }, ['a', 'b', 'c']), 'Imported 3 ideas (3 updated)');
  assert.equal(summarize({ research: { added: 1, updated: 0 } }, ['a tool']), 'Imported 1 research pack: a tool');
  assert.equal(summarize({ research: { added: 2, updated: 0 } }, ['a', 'b']), 'Imported 2 research packs');
  assert.equal(summarize({ note: { added: 1, updated: 0 } }, ['hello']), 'Imported 1 note: hello');
});

test('a skipped kind is reported without blocking the rest of the message', () => {
  assert.equal(
    summarize({ script: { added: 1, updated: 0 } }, ['S'], ['video']),
    "Imported 1 script: S. Skipped 1 item of unknown kind 'video'",
  );
  assert.equal(
    summarize({}, [], ['video', 'video', 'audio']),
    "Imported nothing. Skipped 2 items of unknown kind 'video'. Skipped 1 item of unknown kind 'audio'",
  );
});

test('bundle items are resolved to their own kinds and rows', () => {
  const { type, entries } = prepare(wrap('bundle', [
    { id: 's1', kind: 'script', title: 'S' }, { id: 'r1', kind: 'result', views: 10 }, { id: 'i1', kind: 'idea', title: 'I' },
  ]));
  assert.equal(type, 'bundle');
  assert.deepEqual(entries.map((e) => e.kind), ['script', 'result', 'idea']);
  assert.equal(entries[1].row.views, 10);
});

test('a research item keeps its pack, topic and project reference as given', () => {
  const row = one('research', {
    id: 'rp1', topic: 'a background remover', created_at: '2026-10-08T09:00:00Z', source: 'claude-chat',
    project: { title: 'Background remover video' },
    pack: { main_tool: { name: 'Bgless', url: 'https://bgless.example' }, fact_check: [{ claim: 'x', status: 'verified', source_url: 'https://bgless.example' }] },
  });
  assert.equal(row.topic, 'a background remover');
  assert.equal(row.source, 'claude-chat');
  assert.deepEqual(row.project, { title: 'Background remover video' });
  assert.equal(row.pack.main_tool.name, 'Bgless');
});

test('a note item keeps its text, url and project reference as given', () => {
  const row = one('note', { id: 'n1', text: 'check this before recording', url: 'https://example.com', project: { id: 'p1' } });
  assert.equal(row.text, 'check this before recording');
  assert.equal(row.url, 'https://example.com');
  assert.deepEqual(row.project, { id: 'p1' });
});

test('unknown fields are not in the row but the original item is kept for raw', () => {
  const { entries } = prepare(wrap('script', [{ id: 's1', title: 'T', future_field: 'keep me' }]));
  assert.equal(entries[0].row.future_field, undefined);
  assert.equal(entries[0].item.future_field, 'keep me');
});
