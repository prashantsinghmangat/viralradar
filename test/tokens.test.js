// Tests for shared/tokens.mjs — the import tokens the folder watcher uses.
// Hashes are cross-checked against Node's own crypto, so "we store only a
// SHA-256" is verified rather than assumed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { newToken, hashToken, looksLikeToken, readAuthorization, tokenHint, TOKEN_PREFIX } = require('../shared/tokens.mjs');

test('a new token is prefixed, long, and url-safe', () => {
  const token = newToken();
  assert.ok(token.startsWith(TOKEN_PREFIX), `expected a ${TOKEN_PREFIX} prefix, got ${token}`);
  assert.match(token, /^vr_[A-Za-z0-9_-]+$/, 'must survive being pasted into a header or an .env file');
  // 32 bytes in base64 with no padding.
  assert.equal(token.length, TOKEN_PREFIX.length + 43);
  assert.ok(!token.includes('+') && !token.includes('/') && !token.includes('='), 'base64url only');
});

test('tokens do not repeat', () => {
  const many = new Set(Array.from({ length: 500 }, () => newToken()));
  assert.equal(many.size, 500);
});

test('hashToken is a real SHA-256, matching Node crypto', async () => {
  for (const value of ['vr_example', newToken(), '', 'a longer value with spaces and ünicode']) {
    const expected = createHash('sha256').update(value, 'utf8').digest('hex');
    assert.equal(await hashToken(value), expected, `hash mismatch for ${JSON.stringify(value.slice(0, 20))}`);
  }
});

test('the hash is stable, 64 hex characters, and different for different tokens', async () => {
  const a = newToken();
  const b = newToken();
  const hashA = await hashToken(a);
  assert.match(hashA, /^[0-9a-f]{64}$/);
  assert.equal(hashA, await hashToken(a), 'the same token must always hash the same');
  assert.notEqual(hashA, await hashToken(b));
  // The hash must not give the token away.
  assert.ok(!hashA.includes(a.slice(3, 12)));
});

test('looksLikeToken tells our tokens apart from a JWT', () => {
  assert.equal(looksLikeToken(newToken()), true);
  // A JWT is what the browser sends; it must never be mistaken for a token.
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.4Adcj3UFYzPUVaVF43FmMab6RlaQD8A9V8wFzzht-KQ';
  assert.equal(looksLikeToken(jwt), false, 'a JWT has dots, and no vr_ prefix');
  for (const bad of ['', null, undefined, 'vr_', 'vr_short', 'bearer vr_x', 'VR_' + 'a'.repeat(40), 42, {}]) {
    assert.equal(looksLikeToken(bad), false, `should not look like a token: ${String(bad)}`);
  }
});

test('readAuthorization handles Bearer, a bare value, and nothing at all', () => {
  const token = newToken();
  assert.deepEqual(readAuthorization(`Bearer ${token}`), { kind: 'token', value: token });
  assert.deepEqual(readAuthorization(`bearer ${token}`), { kind: 'token', value: token });
  assert.deepEqual(readAuthorization(`  Bearer   ${token}  `), { kind: 'token', value: token });
  assert.deepEqual(readAuthorization(token), { kind: 'token', value: token });

  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig';
  assert.deepEqual(readAuthorization(`Bearer ${jwt}`), { kind: 'jwt', value: jwt });

  for (const empty of ['', '   ', null, undefined, 'Bearer', 'Bearer   ']) {
    assert.equal(readAuthorization(empty).kind, 'none', `should be none: ${JSON.stringify(empty)}`);
  }
});

test('tokenHint shows only the last few characters', () => {
  const token = newToken();
  const hint = tokenHint(token);
  assert.equal(hint.length, 4);
  assert.ok(token.endsWith(hint));
  assert.equal(tokenHint(''), '');
});
