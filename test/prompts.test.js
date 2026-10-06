// Tests for shared/prompts.mjs — the prompt rules and the JSON repair the
// "generate" Edge Function depends on. No network, no keys.
const test = require('node:test');
const assert = require('node:assert/strict');
const { RULES, CTAS, ideasPrompt, scriptPrompt, fixJsonPrompt, extractJson } = require('../shared/prompts.mjs');

test('extractJson reads plain JSON, fenced JSON and JSON wrapped in prose', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('```\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! Here you go:\n{"a":1}\nHope that helps.'), { a: 1 });
  assert.deepEqual(extractJson('[{"a":1}]'), [{ a: 1 }]);
  assert.deepEqual(extractJson('Here: [1,2] done'), [1, 2]);
  assert.deepEqual(extractJson('﻿{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"items":[{"title":"x"}]}\n```').items, [{ title: 'x' }]);
});

test('extractJson throws a plain-English error when there is no JSON at all', () => {
  for (const bad of ['', 'I cannot help with that.', '```\nnot json\n```', null]) {
    assert.throws(() => extractJson(bad), /The AI did not return JSON\./);
  }
});

test('the prompt rules carry every rule the app promises', () => {
  const all = RULES.join(' ').toLowerCase();
  assert.match(all, /first 2 seconds/);
  assert.match(all, /result first/);
  assert.match(all, /one idea per video/);
  assert.match(all, /free tools .* under a minute/);
  assert.match(all, /honest claims/);
  for (const cta of CTAS) assert.ok(all.includes(cta), `missing CTA: ${cta}`);
  assert.deepEqual(CTAS, ['save this', 'follow for more', 'comment for link']);
});

test('the ideas prompt carries the niche, language, length and a JSON-only instruction', () => {
  const p = ideasPrompt({ keywords: ['ai tools', 'useful websites'], language: 'Hindi', length: '45s', count: 4, today: '2026-10-07' });
  assert.match(p, /ai tools, useful websites/);
  assert.match(p, /Hindi/);
  assert.match(p, /4 fresh ideas/);
  assert.match(p, /45s/);
  assert.match(p, /2026-10-07/);
  assert.match(p, /Return ONLY valid JSON/);
  assert.match(p, /no code fences/);
  // Every contract field for an idea is described, and "id" is not asked for.
  for (const f of ['title', 'hook', 'tool', 'show', 'why', 'format', 'date']) assert.ok(p.includes(`"${f}"`), `missing field: ${f}`);
  assert.ok(!p.includes('"id"'), 'the model must not invent ids');
});

test('the ideas prompt still works with no keywords set', () => {
  assert.match(ideasPrompt({ today: '2026-10-07' }), /free AI tools and useful websites/);
});

test('the script prompt carries the topic and every contract field', () => {
  const p = scriptPrompt({ topic: 'a free site that removes image backgrounds', language: 'English', length: '30s', today: '2026-10-07' });
  assert.match(p, /removes image backgrounds/);
  assert.match(p, /30s/);
  for (const f of ['topic', 'title', 'beats', 'thumbnail_text', 'yt_title', 'ig_caption', 'fb_caption',
    'hashtags', 'pinned_comment', 'broll', 'audio']) assert.ok(p.includes(`"${f}"`), `missing field: ${f}`);
  for (const f of ['"t"', '"say"', '"screen"']) assert.ok(p.includes(f), `missing beat field: ${f}`);
  assert.ok(!p.includes('"id"'), 'the model must not invent ids');
});

test('the JSON repair prompt includes the broken text and asks for JSON only', () => {
  const p = fixJsonPrompt('{"a": 1,}');
  assert.match(p, /\{"a": 1,\}/);
  assert.match(p, /Return ONLY the corrected JSON/);
});
