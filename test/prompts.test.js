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
  // The exact list is pinned in "the script rules say where to cut and how to
  // close" below, along with the condition on the one that promises something.
  assert.equal(CTAS.length, 3);
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

test('the script rules say where to cut and how to close', () => {
  // Cutting on a rhythm is what makes a short feel padded in the middle; the
  // cut should land where the viewer learns something.
  const rules = RULES.join(' ');
  assert.match(rules, /Cut when the information changes, not on a beat/);

  // Exactly one CTA, from a fixed list. "Comment for the link" is a promise,
  // and one nobody keeps costs more than no call to action at all.
  assert.deepEqual(CTAS, ['save this', 'follow for a new tool every day', 'comment for the link']);
  assert.match(rules, /Exactly one call to action/);
  for (const cta of CTAS) assert.ok(rules.includes(cta), `the rules never offer "${cta}"`);
  assert.match(rules, /Only use "comment for the link" if a link really will be sent/);
  // The old wording invited a different CTA every video regardless of whether
  // it made sense, which is how "comment for link" got promised and not kept.
  assert.ok(!/Vary the call to action/.test(rules));
});

test('the angles prompt asks for five different videos, not five titles', () => {
  const { anglesPrompt, ANGLE_TYPES } = require('../shared/prompts.mjs');
  const p = anglesPrompt({ topic: 'a site that turns your name into 3D', language: 'Hinglish', length: '30s', today: '2026-10-08', count: 5 });

  assert.match(p, /a site that turns your name into 3D/);
  assert.match(p, /Hinglish/);
  assert.match(p, /30s/);
  assert.match(p, /Give 5 genuinely different ways/);

  // Every type is offered, with a word on what it means — a bare list of names
  // produced five variations on "Discovery".
  assert.ok(ANGLE_TYPES.length >= 5);
  for (const [name, what] of ANGLE_TYPES) {
    assert.ok(p.includes(name), `the angle type "${name}" is never offered`);
    assert.ok(p.includes(what), `"${name}" is offered with no explanation of what it is`);
  }
  assert.match(p, /Every angle must use a DIFFERENT type/);
  assert.match(p, /not\nthe same video with a different title/);
  assert.match(p, /replace one of them/);

  // The script's rules are included, because an angle that cannot be scripted
  // under them is not an angle worth picking.
  assert.match(p, /Stop the scroll in the first 2 seconds/);
  assert.match(p, /"angles": \[/);
  assert.match(p, /"twist"/);
  assert.match(p, /ONLY valid JSON/);
});

test('a chosen angle becomes the spine of the script, not a note on it', () => {
  const { scriptPrompt } = require('../shared/prompts.mjs');
  const angle = { type: 'Reaction/Skeptic', title: 'I thought this was fake', hook: 'I did not believe this was real', twist: 'tests it live, on camera, expecting failure' };
  const p = scriptPrompt({ topic: 'a 3D name site', language: 'English', length: '30s', today: '2026-10-08', angle });

  assert.match(p, /a 3D name site/, 'the topic says what');
  assert.match(p, /Reaction\/Skeptic/, 'the angle says how');
  assert.match(p, /I thought this was fake/);
  assert.match(p, /I did not believe this was real/);
  assert.match(p, /tests it live, on camera/);
  assert.match(p, /Keep the angle's twist as the spine/);

  // With no angle the prompt must be exactly what it always was: picking a
  // trend and pressing "Write script" has to keep working.
  const plain = scriptPrompt({ topic: 'a 3D name site', language: 'English', length: '30s', today: '2026-10-08' });
  assert.ok(!/chosen this angle/.test(plain));
  assert.ok(!/twist/.test(plain));
});

test('what has worked reaches every prompt that could use it, and nothing else', async () => {
  const { ideasPrompt, anglesPrompt, scriptPrompt, editPlanPrompt } = require('../shared/prompts.mjs');
  const { resultsLesson } = await import('../shared/learning.mjs');

  const rows = [
    { format: 'demo', hook: 'I found', len: '30s', cta: 'save this', views: 12000, saves: 100 },
    { format: 'demo', hook: 'I found', len: '30s', cta: 'save this', views: 8000, saves: 90 },
    { format: 'listicle', hook: 'top 3', len: '60s', cta: 'comment for the link', views: 600, saves: 2 },
    { format: 'listicle', hook: 'top 3', len: '60s', cta: 'comment for the link', views: 400, saves: 1 },
    { format: 'story', hook: 'maybe', len: '45s', cta: 'follow for a new tool every day', views: 3000, saves: 20 },
  ];
  const lesson = resultsLesson(rows);
  assert.equal(lesson.active, true);

  const args = { topic: 'a tool', language: 'English', length: '30s', today: '2026-10-08' };
  for (const [name, prompt] of [
    ['ideas', ideasPrompt({ ...args, lesson })],
    ['angles', anglesPrompt({ ...args, lesson })],
    ['script', scriptPrompt({ ...args, lesson })],
  ]) {
    assert.match(prompt, /What has actually worked for this creator/, `${name} does not carry the lesson`);
    assert.match(prompt, /"demo" does best/, `${name} does not name the winner`);
    assert.match(prompt, /one suggestion in 5/, `${name} does not keep room for an experiment`);
  }

  // An edit plan is about a script that already exists; past results have
  // nothing to say about how to film it, so it is deliberately left alone.
  const plan = editPlanPrompt({ script: { title: 'x', beats: [] }, ...args });
  assert.ok(!/What has actually worked/.test(plan));
});

test('with nothing learned yet, the prompts are byte-for-byte what they were', async () => {
  const { ideasPrompt, anglesPrompt, scriptPrompt } = require('../shared/prompts.mjs');
  const { resultsLesson } = await import('../shared/learning.mjs');
  const args = { topic: 'a tool', language: 'English', length: '30s', today: '2026-10-08' };

  // A new channel has no results. Personalisation must then be invisible
  // rather than an empty heading the model has to interpret.
  for (const build of [ideasPrompt, anglesPrompt, scriptPrompt]) {
    const none = build({ ...args });
    assert.equal(build({ ...args, lesson: resultsLesson([]) }), none, 'an inactive lesson must change nothing');
    assert.equal(build({ ...args, lesson: null }), none);
    assert.ok(!/What has actually worked/.test(none));
  }
});

test('the JSON repair prompt includes the broken text and asks for JSON only', () => {
  const p = fixJsonPrompt('{"a": 1,}');
  assert.match(p, /\{"a": 1,\}/);
  assert.match(p, /Return ONLY the corrected JSON/);
});
