// Tests for shared/edit-plan.mjs, and for the fact that an edit plan survives
// an import untouched.
//
// The plan has no column of its own. It rides along inside `raw`, which the
// contract has always kept whole — so this is really a test that "keep the
// original item" was not just a nice idea.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readEditPlan, editPlanText } = require('../shared/edit-plan.mjs');
const { prepare } = require('../shared/contract.mjs');
const { runImport } = require('../shared/import-core.mjs');

const USER = '11111111-1111-4111-8111-111111111111';
const wrap = (items) => ({ app: 'shorts-studio', schema: 1, type: 'script', exported_at: '2026-10-08T08:00:00Z', items });

const PLAN = {
  total_sec: 32,
  timeline: [
    { at: '0-3s', clip: 'face', action: 'hook straight to camera', text: 'STOP PAYING', sfx: 'whoosh', tip: 'no intro' },
    { at: '3-12s', clip: 'screen record', action: 'show the upload', text: 'drag the PDF in' },
    { at: '12-32s', clip: 'screen record', action: 'show the result' },
  ],
  captions: 'Big, centred, one line at a time',
  music: { mood: 'upbeat lofi', search: 'lofi beat no copyright', volume: '15%' },
  cover: { frame: '0:02', text: 'FREE PDF AI' },
  checklist: ['Trim the dead air at the start', 'Check captions on a phone', 'Export at 1080x1920'],
};

const scriptWith = (plan) => ({
  id: 's1', created_at: '2026-10-07T10:00:00Z', topic: 'pdf tool', title: 'Free AI that edits PDFs',
  beats: [{ t: '0-3s', say: 'Stop paying for PDF editors' }],
  ...(plan === undefined ? {} : { edit_plan: plan }),
});

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

// ---------- the contract keeps it ----------

test('an edit plan survives an import, inside raw', async () => {
  const store = fakeStore();
  await runImport(wrap([scriptWith(PLAN)]), store);

  const row = store.rows[0];
  assert.equal('edit_plan' in row, false, 'it has no column of its own, and needs none');
  assert.deepEqual(row.raw.edit_plan, PLAN, 'the plan must come back exactly as it went in');
  assert.equal(readEditPlan(row).total_sec, 32);
});

test('a script with no edit plan imports exactly as before', async () => {
  const store = fakeStore();
  const r = await runImport(wrap([scriptWith(undefined)]), store);

  assert.equal(r.message, 'Imported 1 script: Free AI that edits PDFs');
  assert.equal(store.rows[0].raw.edit_plan, undefined);
  assert.equal(readEditPlan(store.rows[0]), null, 'nothing to show, and nothing breaks');
});

test('the contract does not validate or reshape the plan', () => {
  // Shorts Studio owns this shape. Rejecting a plan we did not expect would
  // mean a new field there breaks importing here.
  const odd = { total_sec: 20, something_new: ['added later'], timeline: [] };
  const { entries } = prepare(wrap([scriptWith(odd)]));
  assert.deepEqual(entries[0].item.edit_plan, odd);
});

// ---------- reading it ----------

test('a full plan is read field for field', () => {
  const plan = readEditPlan({ raw: { edit_plan: PLAN } });
  assert.equal(plan.total_sec, 32);
  assert.equal(plan.timeline.length, 3);
  assert.deepEqual(plan.timeline[0], {
    at: '0-3s', clip: 'face', action: 'hook straight to camera',
    text: 'STOP PAYING', sfx: 'whoosh', tip: 'no intro',
  });
  // A step with only some fields keeps the rest empty rather than undefined.
  assert.deepEqual(plan.timeline[2], { at: '12-32s', clip: 'screen record', action: 'show the result', text: '', sfx: '', tip: '' });
  assert.equal(plan.captions, 'Big, centred, one line at a time');
  assert.deepEqual(plan.music, { mood: 'upbeat lofi', search: 'lofi beat no copyright', volume: '15%' });
  assert.deepEqual(plan.cover, { frame: '0:02', text: 'FREE PDF AI' });
  assert.equal(plan.checklist.length, 3);
});

test('no plan, an empty plan, or junk all mean "show nothing"', () => {
  for (const script of [
    {}, { raw: {} }, { raw: { edit_plan: null } }, { raw: { edit_plan: {} } },
    { raw: { edit_plan: [] } }, { raw: { edit_plan: 'later' } }, { raw: { edit_plan: 42 } },
    { raw: { edit_plan: { timeline: [], checklist: [] } } },
    null, undefined,
  ]) {
    assert.equal(readEditPlan(script), null, `should be nothing to show: ${JSON.stringify(script)}`);
  }
});

test('a half-written plan still shows what it has', () => {
  // A model writing one of these will not always fill every field.
  const plan = readEditPlan({ raw: { edit_plan: { checklist: ['Trim the start'] } } });
  assert.deepEqual(plan.checklist, ['Trim the start']);
  assert.deepEqual(plan.timeline, []);
  assert.equal(plan.total_sec, null);
  assert.deepEqual(plan.music, { mood: '', search: '', volume: '' });
});

test('wrong types are tidied rather than thrown away or trusted', () => {
  const plan = readEditPlan({
    raw: {
      edit_plan: {
        total_sec: '45',                       // a number as text
        timeline: 'do the thing',              // not an array
        checklist: 'Only one item',            // not an array
        music: 'upbeat',                       // not an object
        cover: null,
        captions: 123,                         // a number
      },
    },
  });
  assert.equal(plan.total_sec, 45);
  assert.deepEqual(plan.timeline, [], 'a string is not a timeline');
  assert.deepEqual(plan.checklist, ['Only one item'], 'but a single string is a one-item list');
  assert.deepEqual(plan.music, { mood: '', search: '', volume: '' });
  assert.deepEqual(plan.cover, { frame: '', text: '' });
  assert.equal(plan.captions, '123');
});

test('a timeline written as plain strings still works', () => {
  const plan = readEditPlan({ raw: { edit_plan: { timeline: ['hook to camera', '', 'show the result'] } } });
  assert.equal(plan.timeline.length, 2, 'empty entries are dropped');
  assert.equal(plan.timeline[0].action, 'hook to camera');
  assert.equal(plan.timeline[0].at, '');
});

test('total_sec only counts when it is a real duration', () => {
  for (const bad of [0, -5, 'soon', null, NaN, {}]) {
    assert.equal(readEditPlan({ raw: { edit_plan: { total_sec: bad, captions: 'x' } } }).total_sec, null, String(bad));
  }
  assert.equal(readEditPlan({ raw: { edit_plan: { total_sec: 30 } } }).total_sec, 30);
});

// ---------- copying it ----------

test('the copy text reads like something you could follow', () => {
  const copied = editPlanText(readEditPlan({ raw: { edit_plan: PLAN } }));
  assert.match(copied, /^EDIT PLAN \(32s\)/);
  assert.match(copied, /TIMELINE/);
  assert.match(copied, /0-3s · face · hook straight to camera/);
  assert.match(copied, /on screen: STOP PAYING/);
  assert.match(copied, /sound: whoosh/);
  assert.match(copied, /tip: no intro/);
  assert.match(copied, /CAPTIONS/);
  assert.match(copied, /MUSIC[\s\S]*mood: upbeat lofi/);
  assert.match(copied, /COVER[\s\S]*text: FREE PDF AI/);
  assert.match(copied, /CHECKLIST[\s\S]*\[ \] Trim the dead air at the start/);
  // Nothing should arrive as "undefined" or "[object Object]".
  assert.ok(!/undefined|\[object/.test(copied), copied);
});

test('the copy text leaves out the parts that are not there', () => {
  const copied = editPlanText(readEditPlan({ raw: { edit_plan: { checklist: ['Trim the start'] } } }));
  assert.match(copied, /CHECKLIST/);
  for (const absent of ['TIMELINE', 'CAPTIONS', 'MUSIC', 'COVER']) {
    assert.ok(!copied.includes(absent), `${absent} has nothing in it and should not appear`);
  }
  assert.equal(editPlanText(null), '');
});
