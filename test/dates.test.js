// ideas.date and results.posted_on are real `date` columns, so one bad value
// does not spoil one row — it makes Postgres refuse the whole statement.
//
// This was found by running the fallback for real. OpenRouter answered with
// "date": "2026-10-08 (today)", copied from the placeholder in the prompt, and
// the import failed with:
//
//   Could not save your ideas: invalid input syntax for type date: "2026-10-08 (today)"
//
// Gemini never did that, so a year of using the app would not have found it.
// Two fixes, tested here: the prompt now carries the real date instead of a
// placeholder to copy, and nothing reaches a date column without being one.
const test = require('node:test');
const assert = require('node:assert/strict');
const { dateOnly, ROW, prepare } = require('../shared/contract.mjs');
const { ideasPrompt } = require('../shared/prompts.mjs');

test('a plain date survives untouched', () => {
  assert.equal(dateOnly('2026-10-08'), '2026-10-08');
});

test('a timestamp is cut down to its date', () => {
  assert.equal(dateOnly('2026-10-08T14:30:00Z'), '2026-10-08');
});

test('the exact value that broke the import becomes a usable date', () => {
  // The date part is real and worth keeping; only the commentary is dropped.
  assert.equal(dateOnly('2026-10-08 (today)'), '2026-10-08');
});

test('other trailing noise is survivable the same way', () => {
  assert.equal(dateOnly('2026-10-08 -- guessing'), '2026-10-08');
  assert.equal(dateOnly('2026-10-08, probably'), '2026-10-08');
});

test('a value with no date in it becomes null rather than an error', () => {
  for (const bad of ['today', 'next Tuesday', 'YYYY-MM-DD', 'soon', '??', 'n/a']) {
    assert.equal(dateOnly(bad), null, `${bad} should be dropped`);
  }
});

test('missing stays missing', () => {
  for (const empty of [null, undefined, '']) assert.equal(dateOnly(empty), null);
});

test('an impossible date is refused, not rolled forward', () => {
  // Postgres rejects 2026-02-31; JavaScript would happily call it 3 March.
  assert.equal(dateOnly('2026-02-31'), null);
  assert.equal(dateOnly('2026-13-01'), null);
});

test('a model writing prose into date fields cannot break an import', () => {
  const idea = ROW.idea({ id: 'i1', date: '2026-10-08 (today)', title: 'x' });
  assert.equal(idea.date, '2026-10-08');

  const result = ROW.result({ id: 'r1', posted_on: 'yesterday', title: 'x' });
  assert.equal(result.posted_on, null);
  // The row is still imported, and the UI still has something to sort by.
  assert.ok(result.origin_at, 'origin_at falls back so the row is not undated');
});

test('a real export still imports exactly as before', () => {
  const { entries } = prepare(JSON.stringify({
    app: 'shorts-studio', schema: 1, type: 'ideas',
    items: [{ id: 'i1', date: '2026-10-06', title: 'Shrink a PDF free' }],
  }));
  assert.equal(entries[0].row.date, '2026-10-06');
});

test('the ideas prompt shows a real date, with no placeholder to copy', () => {
  const prompt = ideasPrompt({ today: '2026-10-08' });
  assert.match(prompt, /"date": "2026-10-08"/);
  assert.doesNotMatch(prompt, /YYYY-MM-DD/, 'a placeholder in the shape is a placeholder in the answer');
  assert.doesNotMatch(prompt, /"date": "[^"]*\(/, 'no parenthetical for a model to copy into the value');
});

test('the prompt has a date even when the caller forgets to pass one', () => {
  assert.match(ideasPrompt().match(/"date": "([^"]*)"/)[1], /^\d{4}-\d{2}-\d{2}$/);
  assert.doesNotMatch(ideasPrompt(), /undefined/);
});
