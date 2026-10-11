// Tests for the cover generator: the prompt it sends, the shape it reads
// back, the cards it draws, and the brief it writes to the local folder.
//
// The rules in thumbnailPrompt() are the feature. A cover that promises a
// result the video does not show, or that puts the creator's face through an
// image generator, is the exact failure this whole thing is shaped to avoid —
// so every one of those rules is pinned here rather than left to read nicely.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  MAX_BRAND_COLORS, FACE_POSITIONS,
  canvaStepsText, coverBriefMarkdown, readBrandKit, readThumbnail,
} = require('../shared/thumbnail.mjs');
const { thumbnailPrompt } = require('../shared/prompts.mjs');
const { wantedFiles, isGeneratedName, diffGeneratedFiles } = require('../shared/localfolder.mjs');
const { prepare } = require('../shared/contract.mjs');
const { runImport } = require('../shared/import-core.mjs');

const USER = '11111111-1111-4111-8111-111111111111';
const wrap = (items) => ({ app: 'shorts-studio', schema: 1, type: 'script', exported_at: '2026-10-11T08:00:00Z', items });

const CONCEPT = {
  name: 'Before / After',
  cover_text: 'FREE PDF AI',
  layout: 'Face bottom-left, screenshot top-right, arrow between, text across the middle',
  colors: ['#ff4d00', '#111111'],
  my_photo: 'Shocked, looking at the screen',
  screenshot: 'The finished export with no watermark',
  image_prompt: 'A dark navy gradient with a soft orange glow, no text, no faces, no interface',
  canva_steps: ['New design, 1080 x 1920', 'Drop the background in', 'Cut out the photo'],
  stitch_prompt: 'A 1080x1920 vertical cover, bold headline centred, photo bottom-left',
};

const THUMBNAIL = {
  safe_area_note: 'Keep every word inside the middle 1080x1440.',
  concepts: [
    CONCEPT,
    { ...CONCEPT, name: 'Shocked reaction + result', cover_text: 'IT DID THIS' },
    { ...CONCEPT, name: 'Big question', cover_text: 'HOW IS THIS FREE' },
  ],
};

const SCRIPT = {
  id: 'scr_1', title: 'Free AI that edits PDFs', topic: 'pdf tool', language: 'Hinglish',
  beats: [
    { t: '0-3s', say: 'Stop paying for PDF editors', screen: 'Face to camera' },
    { t: '3-30s', say: 'Watch this', screen: 'Screen recording' },
  ],
  raw: {
    demo: { tool: 'Bgless', url: 'https://bgless.example', steps: ['Open the site', 'Upload the PDF'], check: ['The export has no watermark'] },
    edit_plan: { cover: { frame: 'The moment the result appears', text: 'FREE PDF AI' } },
  },
};

const BRAND = { brand_colors: ['#ff4d00', '#111111'], brand_font: 'bold sans', brand_handle: '@me', brand_face: 'left' };

/** The same stand-in the import tests use. */
function fakeStore(userId = USER) {
  const rows = [];
  return {
    rows,
    userId,
    async findExisting(table, ids) { return rows.filter((r) => ids.includes(r.id)).map((r) => r.id); },
    async upsert(table, incoming) { for (const r of incoming) rows.push(r); },
  };
}

// ---------- the brand kit ----------

test('an empty brand kit is "not set", so the prompt can leave branding out entirely', () => {
  for (const row of [undefined, null, {}, { brand_colors: [], brand_font: '', brand_handle: '', brand_face: '' }]) {
    const brand = readBrandKit(row);
    assert.equal(brand.set, false, JSON.stringify(row));
    assert.deepEqual(brand.colors, []);
    assert.equal(brand.face, '');
  }
  // One field is enough to count as set.
  assert.equal(readBrandKit({ brand_font: 'bold sans' }).set, true);
  assert.equal(readBrandKit({ brand_face: 'right' }).set, true);
});

test('the brand kit is read field for field, and capped at three colours', () => {
  const brand = readBrandKit({ ...BRAND, brand_colors: ['#a', '#b', '#c', '#d'] });
  assert.equal(brand.colors.length, MAX_BRAND_COLORS);
  assert.deepEqual(brand.colors, ['#a', '#b', '#c']);
  assert.equal(brand.font, 'bold sans');
  assert.equal(brand.handle, '@me');
  assert.equal(brand.face, 'left');
});

test('a face position that is not left or right is dropped rather than passed to a model', () => {
  // It reaches a prompt as an instruction, so "centre" would be an instruction
  // nobody can follow. The database has the same check — see the migration.
  for (const bad of ['centre', 'middle', 'LEFT', 'top', 42, {}, null]) {
    assert.equal(readBrandKit({ brand_face: bad }).face, '', String(bad));
  }
  for (const good of FACE_POSITIONS) assert.equal(readBrandKit({ brand_face: good }).face, good);
});

// ---------- the prompt ----------

test('the cover prompt carries every rule the feature promises', () => {
  const p = thumbnailPrompt({ script: SCRIPT, language: 'Hinglish', today: '2026-10-11' });

  // Only what the video really shows.
  assert.match(p, /REALLY shows/);
  assert.match(p, /No invented results/);
  // The Instagram grid crop, with the actual numbers.
  assert.match(p, /1080x1440/);
  assert.match(p, /Instagram's grid crop/);
  // Readable on a phone, at four words.
  assert.match(p, /High contrast/);
  assert.match(p, /readable on a phone at thumbnail size/);
  assert.match(p, /at most 4 words/);
  // The face is never generated, and neither is the tool's UI.
  assert.match(p, /face is ALWAYS their own real photo/);
  assert.match(p, /Never an AI-generated face/);
  assert.match(p, /ALWAYS a real screenshot/);
  assert.match(p, /Never an AI rendering of a user interface/);
  // The image prompt is the background and nothing else.
  assert.match(p, /BACKGROUND or an effect ONLY/);
  assert.match(p, /no face, no user interface, no logos or brand marks, and no text anywhere in the image/);
  // Canva free, three different concepts, and JSON only.
  assert.match(p, /Canva's free plan alone/);
  assert.match(p, /Give 3 genuinely different concepts/);
  assert.match(p, /Return ONLY valid JSON/);
});

test('the cover prompt asks for the shape the app reads back', () => {
  const p = thumbnailPrompt({ script: SCRIPT, today: '2026-10-11' });
  const shape = p.slice(p.indexOf('Return exactly this shape:'));
  for (const key of [
    'concepts', 'name', 'cover_text', 'layout', 'colors', 'my_photo',
    'screenshot', 'image_prompt', 'canva_steps', 'stitch_prompt', 'safe_area_note',
  ]) {
    assert.ok(shape.includes(`"${key}"`), `the shape never mentions ${key}`);
  }
  // The example has to be parseable: a model copies it, and a model copying
  // broken JSON produces broken JSON.
  assert.doesNotThrow(() => JSON.parse(shape.slice(shape.indexOf('{'))));
});

test('the cover prompt carries the script, its language, the demo and the edit plan\'s chosen frame', () => {
  const p = thumbnailPrompt({ script: SCRIPT, language: 'Hinglish', today: '2026-10-11' });
  assert.match(p, /Free AI that edits PDFs/);
  assert.match(p, /pdf tool/);
  assert.match(p, /Spoken language: Hinglish\./);
  // The hook: there is no hook column on a script, so it is the first beat.
  assert.match(p, /Hook: {2}Stop paying for PDF editors/);
  assert.match(p, /0-3s — Stop paying for PDF editors — \(on screen: Face to camera\)/);
  // What is really on screen, which rule 1 is judged against.
  assert.match(p, /tool: {2}Bgless \(https:\/\/bgless\.example\)/);
  assert.match(p, /Open the site \/ Upload the PDF/);
  // The edit plan already chose the frame; re-choosing it would cover a moment
  // the edit never cuts to.
  assert.match(p, /edit plan already picked the cover frame/);
  assert.match(p, /frame: The moment the result appears/);
});

test('with no brand kit set, the prompt says nothing about branding at all', () => {
  const bare = thumbnailPrompt({ script: SCRIPT, today: '2026-10-11' });
  for (const nothing of [{}, null, readBrandKit({})]) {
    // Byte for byte: an empty heading is a thing a model has to interpret.
    assert.equal(thumbnailPrompt({ script: SCRIPT, today: '2026-10-11', brand: nothing }), bare, JSON.stringify(nothing));
  }
  // Rule 6 legitimately says "no logos or brand marks", so the word itself is
  // expected. What must be absent is the block that states a kit.
  assert.ok(!/brand colours|font preference|handle to put|face usually sits/.test(bare));
  assert.ok(!/Every concept must use it/.test(bare));
});

test('with a brand kit set, every part of it reaches the prompt', () => {
  const p = thumbnailPrompt({ script: SCRIPT, today: '2026-10-11', brand: readBrandKit(BRAND) });
  assert.match(p, /brand colours: #ff4d00, #111111/);
  assert.match(p, /font preference: bold sans/);
  assert.match(p, /handle to put small in a corner: @me/);
  assert.match(p, /face usually sits on the left/);
  assert.match(p, /Every concept must use it/);
});

test('a half-filled brand kit mentions only the halves that are filled', () => {
  const p = thumbnailPrompt({ script: SCRIPT, today: '2026-10-11', brand: readBrandKit({ brand_font: 'bold sans' }) });
  assert.match(p, /font preference: bold sans/);
  assert.ok(!/brand colours/.test(p));
  assert.ok(!/handle to put/.test(p));
  assert.ok(!/face usually sits/.test(p));
});

test('a script with no beats, no demo and no edit plan still produces a usable prompt', () => {
  const p = thumbnailPrompt({ script: { title: 'Just a title' }, today: '2026-10-11' });
  assert.match(p, /no beats; work from the title and topic/);
  assert.ok(!/What is actually on screen/.test(p));
  assert.ok(!/already picked the cover frame/.test(p));
  assert.ok(!/undefined|\[object/.test(p), p);
});

// ---------- reading what came back ----------

test('three concepts are read field for field', () => {
  const thumb = readThumbnail({ raw: { thumbnail: THUMBNAIL } });
  assert.equal(thumb.concepts.length, 3);
  assert.equal(thumb.safe_area_note, 'Keep every word inside the middle 1080x1440.');
  assert.deepEqual(thumb.concepts[0], CONCEPT);
  assert.equal(thumb.concepts[2].name, 'Big question');
});

test('nothing, junk, or no usable concept all mean "show nothing"', () => {
  for (const script of [
    {}, { raw: {} }, { raw: { thumbnail: null } }, { raw: { thumbnail: {} } },
    { raw: { thumbnail: [] } }, { raw: { thumbnail: 'later' } }, { raw: { thumbnail: 42 } },
    { raw: { thumbnail: { concepts: [] } } },
    { raw: { thumbnail: { concepts: 'three of them' } } },
    // A note with no concepts under it is not a cover idea.
    { raw: { thumbnail: { safe_area_note: 'keep it centred' } } },
    // Concepts that are only names: headings with nothing underneath.
    { raw: { thumbnail: { concepts: [{ name: 'Before / After' }, { name: 'Big question' }] } } },
    { raw: { thumbnail: { concepts: [null, 'x', 42, []] } } },
    null, undefined,
  ]) {
    assert.equal(readThumbnail(script), null, `should be nothing to show: ${JSON.stringify(script)}`);
  }
});

test('a thinly answered concept keeps what it has, with the rest empty rather than undefined', () => {
  const thumb = readThumbnail({ raw: { thumbnail: { concepts: [{ name: 'Big question', cover_text: 'HOW IS THIS FREE' }] } } });
  assert.equal(thumb.concepts.length, 1);
  assert.deepEqual(thumb.concepts[0], {
    name: 'Big question', cover_text: 'HOW IS THIS FREE', layout: '', colors: [],
    my_photo: '', screenshot: '', image_prompt: '', canva_steps: [], stitch_prompt: '',
  });
  assert.equal(thumb.safe_area_note, '');
});

test('wrong types are tidied rather than thrown away or trusted', () => {
  const thumb = readThumbnail({
    raw: {
      thumbnail: {
        safe_area_note: 123,
        concepts: [{
          name: { a: 1 },                  // an object where text belongs
          cover_text: 'FREE PDF AI',
          colors: '#ff4d00',               // one colour, not an array
          canva_steps: 'Open Canva',       // one step, not an array
          layout: 7,
        }],
      },
    },
  });
  assert.equal(thumb.safe_area_note, '123');
  assert.equal(thumb.concepts[0].name, '', 'an object is not a name');
  assert.deepEqual(thumb.concepts[0].colors, ['#ff4d00'], 'a single string is a one-item list');
  assert.deepEqual(thumb.concepts[0].canva_steps, ['Open Canva']);
  assert.equal(thumb.concepts[0].layout, '7');
});

test('a fourth colour on a concept is dropped, the same cap the brand kit has', () => {
  const thumb = readThumbnail({ raw: { thumbnail: { concepts: [{ ...CONCEPT, colors: ['a', 'b', 'c', 'd'] }] } } });
  assert.deepEqual(thumb.concepts[0].colors, ['a', 'b', 'c']);
  assert.equal(thumb.concepts[0].colors.length, MAX_BRAND_COLORS);
});

test('the Canva steps copy as a numbered list, and an empty one copies nothing', () => {
  assert.equal(canvaStepsText(CONCEPT), '1. New design, 1080 x 1920\n2. Drop the background in\n3. Cut out the photo');
  assert.equal(canvaStepsText({ canva_steps: [] }), '');
  assert.equal(canvaStepsText(null), '');
});

// ---------- a "thumbnail" field Shorts Studio may export later ----------

test('cover ideas survive an import, inside raw, with no column and no change', () => {
  // Requirement: Shorts Studio may export a "thumbnail" field of this shape
  // later. Nothing has to be added for that — the contract keeps the whole
  // item — and this is the test that says so.
  const store = fakeStore();
  return runImport(wrap([{ id: 'scr_1', title: 'Free AI that edits PDFs', beats: [], thumbnail: THUMBNAIL }]), store)
    .then(() => {
      const row = store.rows[0];
      assert.equal('thumbnail' in row, false, 'it has no column of its own, and needs none');
      assert.deepEqual(row.raw.thumbnail, THUMBNAIL, 'it must come back exactly as it went in');
      assert.equal(readThumbnail(row).concepts.length, 3, 'and it shows straight away');
    });
});

test('the contract does not validate or reshape the cover ideas', () => {
  // Shorts Studio owns this shape. Rejecting a field we did not expect would
  // mean a new one there breaks importing here.
  const odd = { concepts: [{ name: 'x', cover_text: 'y', something_new: ['added later'] }] };
  const { entries } = prepare(wrap([{ id: 'scr_1', title: 't', thumbnail: odd }]));
  assert.deepEqual(entries[0].item.thumbnail, odd);
});

test('a script with no cover ideas imports exactly as before', () => {
  const store = fakeStore();
  return runImport(wrap([{ id: 'scr_1', title: 'Free AI that edits PDFs', beats: [] }]), store).then((r) => {
    assert.equal(r.message, 'Imported 1 script: Free AI that edits PDFs');
    assert.equal(store.rows[0].raw.thumbnail, undefined);
    assert.equal(readThumbnail(store.rows[0]), null);
  });
});

// ---------- the local folder brief ----------

test('the brief holds all three concepts, each part under its own heading', () => {
  const brief = coverBriefMarkdown({ ...SCRIPT, raw: { ...SCRIPT.raw, thumbnail: THUMBNAIL } });

  assert.match(brief, /^# Cover ideas: Free AI that edits PDFs/);
  // The one instruction the whole feature rests on, in the file itself: the
  // brief is read at the desk with the app shut.
  assert.match(brief, /Use your real photo and a real screenshot of the tool/);
  assert.match(brief, /never your face, never the tool's screen/);
  assert.match(brief, /> Keep every word inside the middle 1080x1440\./);

  // All three, numbered and named.
  assert.match(brief, /## 1\. Before \/ After/);
  assert.match(brief, /## 2\. Shocked reaction \+ result/);
  assert.match(brief, /## 3\. Big question/);
  assert.equal(brief.match(/^## \d\./gm).length, 3);

  // Every part of a concept.
  assert.match(brief, /- \*\*Cover text:\*\* FREE PDF AI/);
  assert.match(brief, /- \*\*Layout:\*\* Face bottom-left/);
  assert.match(brief, /- \*\*Colours:\*\* #ff4d00, #111111/);
  assert.match(brief, /- \*\*Your photo:\*\* Shocked, looking at the screen/);
  assert.match(brief, /- \*\*Screenshot:\*\* The finished export with no watermark/);
  assert.match(brief, /### In Canva\n1\. New design, 1080 x 1920\n2\. Drop the background in/);
  assert.match(brief, /### Background image prompt\n```\nA dark navy gradient/);
  assert.match(brief, /### Stitch prompt \(1080x1920\)\n```\nA 1080x1920 vertical cover/);

  assert.ok(!/undefined|\[object/.test(brief), brief);
  assert.ok(brief.endsWith('\n'));
});

test('a thinly answered concept leaves out the headings it has nothing for', () => {
  const brief = coverBriefMarkdown({ title: 't', raw: { thumbnail: { concepts: [{ name: 'Big question', cover_text: 'HOW' }] } } });
  assert.match(brief, /## 1\. Big question/);
  assert.match(brief, /- \*\*Cover text:\*\* HOW/);
  for (const absent of ['### In Canva', '### Background image prompt', '### Stitch prompt', '**Layout:**', '**Colours:**']) {
    assert.ok(!brief.includes(absent), `${absent} has nothing in it and should not appear`);
  }
});

test('no cover ideas means no brief file at all', () => {
  assert.equal(coverBriefMarkdown({ title: 't', raw: {} }), '');
  assert.equal(coverBriefMarkdown(null), '');
  const files = wantedFiles({ items: [], script: { id: 's1', title: 't', beats: [], raw: {} } });
  assert.equal(files.some((f) => f.subfolder === '06-cover'), false, 'an empty brief must not be written');
});

test('the brief is written into 06-cover, next to where the cover image goes', () => {
  const files = wantedFiles({ items: [], script: { ...SCRIPT, raw: { ...SCRIPT.raw, thumbnail: THUMBNAIL } } });
  const brief = files.find((f) => f.subfolder === '06-cover');
  assert.ok(brief, 'the brief should be in 06-cover');
  assert.equal(brief.name, 'cover-brief.md');
  assert.match(brief.content, /## 3\. Big question/);
});

test('a sync can rewrite the brief but can never touch the cover image beside it', () => {
  // The one rule shared/localfolder.mjs is shaped around. 06-cover now has a
  // generated file in it, so this is the test that says the gate still only
  // lets that one name through.
  assert.equal(isGeneratedName('06-cover', 'cover-brief.md'), true);
  for (const mine of ['cover.png', 'cover-final.jpg', 'cover-brief.png', 'my-cover-brief.md', 'thumb.psd', 'notes.md']) {
    assert.equal(isGeneratedName('06-cover', mine), false, `${mine} is not ours to delete`);
  }

  // And in a real diff: the image survives, an orphaned brief is cleaned up.
  const existingNames = ['cover-brief.md', 'cover-final.png', 'attempt-2.png'];
  const kept = diffGeneratedFiles({ subfolder: '06-cover', existingNames, wanted: [{ name: 'cover-brief.md', content: 'x' }] });
  assert.deepEqual(kept.toDelete, []);
  const orphaned = diffGeneratedFiles({ subfolder: '06-cover', existingNames, wanted: [] });
  assert.deepEqual(orphaned.toDelete, ['cover-brief.md'], 'only ever the brief');
});

// ---------- the Cover section on screen ----------
//
// renderThumbnail lives in public/app.js, which cannot be imported in Node —
// it imports ./data.js and reaches for the DOM at module scope. So the one
// function is lifted out of the source and run against stand-ins for the two
// helpers it uses, which is enough to prove it draws three cards, draws an
// empty state for none, and escapes every model-written value on the way.

/** renderThumbnail, lifted out of app.js and made callable. */
function loadRenderThumbnail() {
  const appjs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const start = appjs.indexOf('function renderThumbnail(script) {');
  const end = appjs.indexOf('actions.setStage = async (btn) =>');
  assert.ok(start !== -1 && end > start, 'could not find renderThumbnail in app.js');
  const source = appjs.slice(start, end);

  const copied = [];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const copyBtn = (text, label = 'Copy', cls = 'sm') => {
    copied.push({ text: String(text ?? ''), label });
    return `<button type="button" class="${cls}" data-copy="${copied.length - 1}">${esc(label)}</button>`;
  };
  // The note is defined just above the function, so it comes along by name.
  const COVER_NOTE = 'Use your real photo and a real screenshot of the tool.';
  // eslint-disable-next-line no-new-func
  const make = new Function('esc', 'copyBtn', 'readThumbnail', 'canvaStepsText', 'COVER_NOTE',
    `${source}; return renderThumbnail;`);
  return { render: make(esc, copyBtn, readThumbnail, canvaStepsText, COVER_NOTE), copied };
}

test('with no concepts, the Cover section offers to write some rather than showing nothing', () => {
  const { render } = loadRenderThumbnail();
  const html = render({ id: 'scr_1', raw: {} });

  assert.match(html, /id="cover"/, 'the sticky bar scrolls to this id');
  assert.match(html, /Make cover ideas/);
  assert.match(html, /data-action="makeCoverIdeas" data-id="scr_1"/);
  assert.match(html, /Use your real photo and a real screenshot of the tool\./);
  // Nothing that belongs to a concept.
  for (const absent of ['Copy image prompt', 'Copy Canva steps', 'Copy Stitch prompt', 'cover-concept', 'Redo']) {
    assert.ok(!html.includes(absent), `${absent} has no business in the empty state`);
  }
  assert.ok(!/undefined|\[object/.test(html), html);
});

test('with three concepts, each card shows its parts and its three Copy buttons', () => {
  const { render, copied } = loadRenderThumbnail();
  const html = render({ id: 'scr_1', raw: { thumbnail: THUMBNAIL } });

  assert.match(html, /id="cover"/);
  assert.equal(html.match(/class="card stack cover-concept"/g).length, 3, 'three cards, one per concept');
  assert.match(html, /3 ideas/);
  assert.match(html, /Redo/, 'with ideas already written, the button redoes them');

  // The names, the cover text, and the three notes.
  for (const name of ['Before / After', 'Shocked reaction + result', 'Big question']) {
    assert.ok(html.includes(name), `missing the ${name} card`);
  }
  assert.match(html, /FREE PDF AI/);
  assert.match(html, /Face bottom-left/);
  assert.match(html, /Shocked, looking at the screen/);
  assert.match(html, /The finished export with no watermark/);
  assert.match(html, /#ff4d00/);

  // The note, and the safe area the model wrote.
  assert.match(html, /Use your real photo and a real screenshot of the tool\./);
  assert.match(html, /Keep every word inside the middle 1080x1440\./);

  // Three separate Copy buttons per card: the image prompt, the Canva steps,
  // the Stitch prompt. Each copies its own thing and nothing else.
  for (const label of ['Copy image prompt', 'Copy Canva steps', 'Copy Stitch prompt']) {
    assert.equal(html.match(new RegExp(label, 'g')).length, 3, `${label} should be on all three cards`);
  }
  const copiedFor = (label) => copied.filter((c) => c.label === label).map((c) => c.text);
  assert.deepEqual(copiedFor('Copy image prompt')[0], CONCEPT.image_prompt);
  assert.deepEqual(copiedFor('Copy Canva steps')[0], canvaStepsText(CONCEPT));
  assert.deepEqual(copiedFor('Copy Stitch prompt')[0], CONCEPT.stitch_prompt);

  assert.ok(!/undefined|\[object/.test(html), html);
});

test('a thinly answered concept draws no empty rows and no empty Copy buttons', () => {
  const { render } = loadRenderThumbnail();
  const html = render({ id: 'scr_1', raw: { thumbnail: { concepts: [{ name: 'Big question', cover_text: 'HOW' }] } } });
  assert.equal(html.match(/class="card stack cover-concept"/g).length, 1);
  assert.match(html, /Big question/);
  for (const absent of ['Copy image prompt', 'Copy Canva steps', 'Copy Stitch prompt', 'cover-row']) {
    assert.ok(!html.includes(absent), `${absent} should not be drawn with nothing in it`);
  }
});

test('every model-written value in the Cover section is escaped', () => {
  // All of it comes from a model, and the Copy buttons put it in a <pre>.
  const { render } = loadRenderThumbnail();
  const nasty = '<img src=x onerror=alert(1)>';
  const html = render({
    id: '"><script>bad()</script>',
    raw: {
      thumbnail: {
        safe_area_note: nasty,
        concepts: [{
          name: nasty, cover_text: nasty, layout: nasty, colors: [nasty],
          my_photo: nasty, screenshot: nasty, image_prompt: nasty,
          canva_steps: [nasty], stitch_prompt: nasty,
        }],
      },
    },
  });
  assert.ok(!html.includes('<img src=x'), 'a model-written tag reached the page');
  assert.ok(!html.includes('<script>bad()'), 'the script id reached the page unescaped');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'it should be visible, escaped');
});
