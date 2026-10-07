// Tests for shared/keys.mjs.
//
// This exists because of a real failure. The Edge Function read
// SUPABASE_SECRET_KEYS, took everything before the first comma, and got
// something that was not a key. Nothing complained: the client was simply built
// with no privileges, and every query came back "permission denied for schema
// viralradar" — which looks like a database or a policy problem, and is neither.
//
// So the rule here is: either return a key that really is one, or return
// nothing, so the caller can say so.
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickKey, looksLikeKey } = require('../shared/keys.mjs');

const PUBLISHABLE = 'sb_publishable_' + 'A1b2C3d4'.repeat(5);
const SECRET = 'sb_secret_' + 'Z9y8X7w6'.repeat(5);
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.signature';

test('a plain key is returned as it is', () => {
  assert.equal(pickKey(PUBLISHABLE), PUBLISHABLE);
  assert.equal(pickKey(SECRET), SECRET);
  assert.equal(pickKey(JWT), JWT, 'a legacy JWT is still a key');
  assert.equal(pickKey(`  ${PUBLISHABLE}  `), PUBLISHABLE, 'whitespace should not matter');
});

test('a list of keys gives the first usable one', () => {
  // Both shapes the platform has used for a rotation in progress.
  assert.equal(pickKey(`${SECRET},${JWT}`), SECRET);
  assert.equal(pickKey(JSON.stringify([SECRET, JWT])), SECRET);
  assert.equal(pickKey(JSON.stringify([{ api_key: SECRET }, { api_key: JWT }])), SECRET);
  assert.equal(pickKey(JSON.stringify([{ name: 'secret', key: SECRET }])), SECRET);
});

test('anything that is not a key is skipped rather than returned', () => {
  // This is the whole point: returning a mangled value builds a client with no
  // privileges, and the failure then looks like a database problem.
  assert.equal(pickKey('[{"id":"abc"'), '', 'broken JSON gives nothing, not a fragment');
  assert.equal(pickKey('[]'), '');
  assert.equal(pickKey('null'), '');
  assert.equal(pickKey('not-a-key'), '');
  assert.equal(pickKey(''), '');
  assert.equal(pickKey(undefined, null), '');
  assert.equal(pickKey(JSON.stringify([{ id: 'no key here' }])), '');
  // A JSON array whose first entry is junk should still find the real one.
  assert.equal(pickKey(JSON.stringify(['', 'rubbish', SECRET])), SECRET);
});

test('the values are tried in the order they are given', () => {
  // The new keys come first, the legacy ones only as a fallback, because a
  // project can have the legacy ones switched off entirely.
  assert.equal(pickKey(JSON.stringify([SECRET]), JWT), SECRET);
  assert.equal(pickKey('', JWT), JWT, 'an empty first value falls through');
  assert.equal(pickKey('garbage', JWT), JWT, 'an unusable first value falls through too');
});

test('looksLikeKey knows the three real shapes and nothing else', () => {
  for (const good of [PUBLISHABLE, SECRET, JWT]) assert.equal(looksLikeKey(good), true, good.slice(0, 20));
  for (const bad of ['', '   ', 'sb_publishable_', 'a.b', 'a.b.c.d', 'abc123', null, undefined, '[]']) {
    assert.equal(looksLikeKey(bad), false, `should not look like a key: ${String(bad)}`);
  }
});
