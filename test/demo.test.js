// Tests for shared/demo.mjs, and for the fact that a demo walkthrough
// survives an import untouched.
//
// Same story as edit-plan.test.js: the demo has no column of its own, rides
// along inside `raw`, and this is really a test that "keep the original
// item" already covers it rather than needing anything new.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readDemo } = require('../shared/demo.mjs');
const { prepare } = require('../shared/contract.mjs');
const { runImport } = require('../shared/import-core.mjs');

const USER = '11111111-1111-4111-8111-111111111111';
const wrap = (items) => ({ app: 'shorts-studio', schema: 1, type: 'script', exported_at: '2026-10-08T08:00:00Z', items });

const DEMO = {
  tool: 'NameForge', url: 'https://nameforge.example',
  prepare: ['have a sample name ready', 'be signed out, to show the free flow'],
  steps: ['Open nameforge.example', 'Type the name', 'Press Generate'],
  prompts: ['Give me 3D render options for the name "Alex"'],
  check: ['the render actually changes when the name changes'],
};

const scriptWith = (demo) => ({
  id: 's1', created_at: '2026-10-07T10:00:00Z', topic: 'name generator', title: 'Free AI that 3D-renders your name',
  beats: [{ t: '0-3s', say: 'Stop paying for this' }],
  ...(demo === undefined ? {} : { demo }),
});

/** The same stand-in shared/edit-plan.mjs's tests use. */
function fakeStore(userId = USER) {
  const rows = [];
  return {
    rows,
    userId,
    async findExisting(table, ids) { return rows.filter((r) => ids.includes(r.id)).map((r) => r.id); },
    async upsert(table, incoming) { for (const r of incoming) rows.push(r); },
  };
}

// ---------- the contract keeps it ----------

test('a demo survives an import, inside raw', async () => {
  const store = fakeStore();
  await runImport(wrap([scriptWith(DEMO)]), store);

  const row = store.rows[0];
  assert.equal('demo' in row, false, 'it has no column of its own, and needs none');
  assert.deepEqual(row.raw.demo, DEMO, 'the demo must come back exactly as it went in');
  assert.equal(readDemo(row).tool, 'NameForge');
});

test('a script with no demo imports exactly as before', async () => {
  const store = fakeStore();
  const r = await runImport(wrap([scriptWith(undefined)]), store);

  assert.equal(r.message, 'Imported 1 script: Free AI that 3D-renders your name');
  assert.equal(store.rows[0].raw.demo, undefined);
  assert.equal(readDemo(store.rows[0]), null, 'nothing to show, and nothing breaks');
});

test('the contract does not validate or reshape the demo', () => {
  // Shorts Studio owns this shape just as much as it owns edit_plan's.
  const odd = { tool: 'x', something_new: ['added later'] };
  const { entries } = prepare(wrap([scriptWith(odd)]));
  assert.deepEqual(entries[0].item.demo, odd);
});

// ---------- reading it ----------

test('a full demo is read field for field', () => {
  const demo = readDemo({ raw: { demo: DEMO } });
  assert.equal(demo.tool, 'NameForge');
  assert.equal(demo.url, 'https://nameforge.example');
  assert.deepEqual(demo.prepare, DEMO.prepare);
  assert.deepEqual(demo.steps, DEMO.steps);
  assert.deepEqual(demo.prompts, DEMO.prompts);
  assert.deepEqual(demo.check, DEMO.check);
});

test('a prompt is kept exactly, word for word — no trimming beyond surrounding whitespace', () => {
  const demo = readDemo({ raw: { demo: { prompts: ['  Give me 3D render options for the name "Alex"  '] } } });
  assert.equal(demo.prompts[0], 'Give me 3D render options for the name "Alex"');
});

test('no demo, an empty demo, or junk all mean "show nothing"', () => {
  for (const script of [
    {}, { raw: {} }, { raw: { demo: null } }, { raw: { demo: {} } },
    { raw: { demo: [] } }, { raw: { demo: 'later' } }, { raw: { demo: 42 } },
    { raw: { demo: { prepare: [], steps: [], prompts: [], check: [] } } },
    null, undefined,
  ]) {
    assert.equal(readDemo(script), null, `should be nothing to show: ${JSON.stringify(script)}`);
  }
});

test('readDemo also reads a demo placed directly on the row, not only inside raw', () => {
  // The same fallback readEditPlan has, for a script object built in the
  // browser rather than read back from the database.
  assert.equal(readDemo({ demo: DEMO }).tool, 'NameForge');
});

// ---------- checked ----------
//
// Not part of the Shorts Studio contract — DEMO above has no such field, and
// the contract test below confirms that shape still reads correctly. Only
// vr-generate ever writes `checked`, and only true when the demo came from a
// Research Pack this app has itself fetched (Re-checked). Every other source
// — Shorts Studio, a Claude chat import, or a model writing a demo with no
// pack behind it — cannot browse, so none of them can vouch for a URL or a
// step, and all default to not checked.

test('a demo with no checked field at all defaults to not checked — none of its sources can browse', () => {
  assert.equal(readDemo({ raw: { demo: DEMO } }).checked, false);
  assert.equal(readDemo({ raw: { demo: { ...DEMO, checked: false } } }).checked, false);
  assert.equal(readDemo({ raw: { demo: { ...DEMO, checked: 'yes' } } }).checked, false, 'only an explicit true means anything');
});

test('a demo explicitly marked checked:true reads that way', () => {
  assert.equal(readDemo({ raw: { demo: { ...DEMO, checked: true } } }).checked, true);
});

test('a demo imported from Shorts Studio defaults to not checked', async () => {
  const store = fakeStore();
  await runImport(wrap([scriptWith(DEMO)]), store);
  assert.equal(readDemo(store.rows[0]).checked, false, 'Shorts Studio cannot browse, so it cannot vouch for a demo');
});

test('a demo imported from a Claude chat defaults to not checked', async () => {
  const store = fakeStore();
  const item = { ...scriptWith(DEMO), source: 'claude-chat' };
  await runImport(wrap([item]), store);
  assert.equal(readDemo(store.rows[0]).checked, false, 'a Claude chat cannot browse either');
});

// ---------- the exact Shorts Studio contract shape ----------

test('the contract shape Shorts Studio exports — demo { tool, url, prepare[], steps[], prompts[], check[] } — survives import and read unchanged', async () => {
  assert.deepEqual(Object.keys(DEMO).sort(), ['check', 'prepare', 'prompts', 'steps', 'tool', 'url'].sort());

  const store = fakeStore();
  await runImport(wrap([scriptWith(DEMO)]), store);
  const row = store.rows[0];

  assert.deepEqual(row.raw.demo, DEMO, 'exactly the shape Shorts Studio sent, byte for byte');
  const demo = readDemo(row);
  assert.equal(demo.tool, DEMO.tool);
  assert.equal(demo.url, DEMO.url);
  assert.deepEqual(demo.prepare, DEMO.prepare);
  assert.deepEqual(demo.steps, DEMO.steps);
  assert.deepEqual(demo.prompts, DEMO.prompts);
  assert.deepEqual(demo.check, DEMO.check);
  assert.equal(demo.checked, false, 'Shorts Studio never writes checked, and never writes a checked one either');
});
