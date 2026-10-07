// Tests for scripts/db-url.mjs: the check that runs before anything tries to
// connect, so a wrong connection string is explained in one sentence instead of
// failing with a timeout.
const test = require('node:test');
const assert = require('node:assert/strict');
const { describe, explain, WHERE_TO_FIND } = require('../scripts/db-url.mjs');

const SESSION = 'postgresql://postgres.abcdefghijkl:s3cret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres';
const TRANSACTION = 'postgresql://postgres.abcdefghijkl:s3cret@aws-0-ap-south-1.pooler.supabase.com:6543/postgres';
const DIRECT = 'postgresql://postgres:s3cret@db.abcdefghijkl.supabase.co:5432/postgres';

test('the session pooler string is accepted', () => {
  const i = describe(SESSION);
  assert.equal(i.ok, true, explain(i));
  assert.equal(i.kind, 'session-pooler');
  assert.equal(i.host, 'aws-0-ap-south-1.pooler.supabase.com');
  assert.equal(i.port, '5432');
  assert.equal(i.user, 'postgres.abcdefghijkl');
  assert.deepEqual(i.warnings, []);
});

test('the direct connection is rejected, because it is IPv6 only', () => {
  const i = describe(DIRECT);
  assert.equal(i.ok, false);
  assert.equal(i.kind, 'direct');
  assert.match(explain(i), /Direct connection/);
  assert.match(explain(i), /IPv6-only/);
  assert.match(explain(i), /Session pooler/);
});

test('the transaction pooler is accepted with a note, since every statement runs in a transaction', () => {
  const i = describe(TRANSACTION);
  assert.equal(i.ok, true, explain(i));
  assert.equal(i.kind, 'transaction-pooler');
  assert.match(explain(i), /6543/);
  assert.match(explain(i), /should still work/);
  assert.match(explain(i), /Session pooler/);
});

test('a string with the placeholder password still in it is rejected', () => {
  for (const pw of ['[YOUR-PASSWORD]', 'your-password', 'YOUR-DB-PASSWORD']) {
    const i = describe(SESSION.replace('s3cret', encodeURIComponent(pw)));
    assert.equal(i.ok, false, pw);
    assert.match(explain(i), /placeholder/);
  }
});

test('a missing password is explained', () => {
  const i = describe('postgresql://postgres.abc@aws-0-ap-south-1.pooler.supabase.com:5432/postgres');
  assert.equal(i.ok, false);
  assert.match(explain(i), /no password/);
});

test('a # in the password is refused with the encoding table, because it cannot be parsed at all', () => {
  const i = describe('postgresql://postgres.abcdefghijkl:pa#ss@aws-0-ap-south-1.pooler.supabase.com:5432/postgres');
  assert.equal(i.ok, false);
  assert.match(explain(i), /percent-encoded/);
  assert.match(explain(i), /%23/);
  assert.match(explain(i), /Reset database password/);
});

test('a stray % in the password warns instead of crashing', () => {
  // decodeURIComponent throws on "pa%ss"; the check must survive it.
  const i = describe('postgresql://postgres.abcdefghijkl:pa%ss@aws-0-ap-south-1.pooler.supabase.com:5432/postgres');
  assert.equal(i.kind, 'session-pooler');
  assert.match(explain(i), /%25/);
});

test('an already-encoded password is fine and reads back correctly', () => {
  const i = describe('postgresql://postgres.abcdefghijkl:pa%40ss@aws-0-ap-south-1.pooler.supabase.com:5432/postgres');
  assert.equal(i.ok, true, explain(i));
  assert.deepEqual(i.warnings, []);
});

test('empty, truncated and non-postgres strings are explained plainly', () => {
  assert.match(explain(describe('')), /empty/);
  assert.match(explain(describe(undefined)), /empty/);
  assert.match(explain(describe('postgres.abcdefghijkl:s3cret@aws-0.pooler.supabase.com:5432/postgres')), /must start with postgresql/);
  assert.match(explain(describe('https://abcdefghijkl.supabase.co')), /must start with postgresql/);
});

test('the project URL pasted by mistake is caught', () => {
  const i = describe('postgresql://abcdefghijkl.supabase.co');
  assert.equal(i.ok, false);
});

test('a hand-edited pooler username is flagged', () => {
  const i = describe('postgresql://postgres:s3cret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres');
  assert.equal(i.kind, 'session-pooler');
  assert.match(explain(i), /postgres.<project-ref>/);
});

test('the instructions name the button to click and the shape to expect', () => {
  assert.match(WHERE_TO_FIND, /Connect/);
  assert.match(WHERE_TO_FIND, /Direct \/ Connection string/);
  // The dashboard calls the pooled string "Shared pooler"; it used to say
  // "Session pooler", so both namings are spelled out for whoever reads this.
  assert.match(WHERE_TO_FIND, /Shared pooler/);
  assert.match(WHERE_TO_FIND, /Session[\s\S]{0,6}pooler/);
  assert.match(WHERE_TO_FIND, /pooler.supabase.com:5432/);
  assert.match(WHERE_TO_FIND, /postgres.<project-ref>/);
});
