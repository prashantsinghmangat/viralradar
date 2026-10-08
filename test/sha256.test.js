// Tests for shared/sha256.mjs.
//
// This module exists so a 2 GB video can be hashed as it streams past, without
// ever being in memory as one buffer. That means it is hand-written SHA-256,
// and hand-written SHA-256 is exactly the kind of thing that is 99% right and
// therefore useless: a digest that is wrong in one case would report
// "✓ Identical to original" on a file that is not, which is worse than not
// checking at all.
//
// So it is not trusted, it is checked:
//   1. against the published FIPS 180-4 vectors
//   2. against crypto.subtle.digest() — the platform's own SHA-256 — on random
//      data, at hundreds of lengths, fed in random chunk sizes
//   3. at the padding boundaries by name, which is where the mistakes live
const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');

const load = () => import('../shared/sha256.mjs');

/** The platform's own SHA-256, as the thing to be measured against. */
async function reference(bytes) {
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const bytesOf = (text) => new TextEncoder().encode(text);

test('the published FIPS 180-4 vectors come out right', async () => {
  const { sha256Of } = await load();
  // These are the documented answers, not something this code produced.
  assert.equal(sha256Of(bytesOf('')),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Of(bytesOf('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Of(bytesOf('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('the one-million-a vector comes out right', async () => {
  // The fourth published vector. Compared against crypto.subtle rather than a
  // 64-character string typed in here, because a typo in one of those would
  // read as a bug in the implementation and send someone hunting for it.
  const { sha256Of } = await load();
  const million = bytesOf('a'.repeat(1000000));
  assert.equal(sha256Of(million), await reference(million));
});

test('it agrees with the platform at every length around a block boundary', async () => {
  const { sha256Of } = await load();
  // 0 to 200 bytes covers three blocks and every padding case there is.
  for (let length = 0; length <= 200; length++) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = (i * 37 + 11) & 0xff;
    assert.equal(sha256Of(bytes), await reference(bytes), `length ${length} differs from crypto.subtle`);
  }
});

test('the padding boundaries that break a hand-written SHA-256 are right', async () => {
  const { sha256Of } = await load();
  // 55 bytes is the longest message that still fits its length in the same
  // block. 56 needs a whole extra block. 64 is exactly one block with nothing
  // left over. Getting any of these wrong is the classic mistake.
  for (const length of [54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128]) {
    const bytes = new Uint8Array(length).fill(0xab);
    assert.equal(sha256Of(bytes), await reference(bytes), `${length} bytes: the padding is wrong`);
  }
});

test('feeding the same data in different chunk sizes gives the same digest', async () => {
  const { createSha256 } = await load();
  const bytes = new Uint8Array(5000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 97) & 0xff;
  const expected = await reference(bytes);

  // The real thing arrives in 16 KB pieces, but a slice at the end of a file is
  // short, and a chunk boundary can land anywhere inside a 64-byte block.
  for (const size of [1, 2, 3, 7, 16, 31, 63, 64, 65, 100, 127, 128, 1000, 4096, 5000, 9999]) {
    const hash = createSha256();
    for (let at = 0; at < bytes.length; at += size) hash.update(bytes.subarray(at, at + size));
    assert.equal(hash.digest(), expected, `chunks of ${size} bytes gave a different answer`);
  }
});

test('it agrees with the platform on random data at random chunk sizes', async () => {
  const { createSha256 } = await load();
  // The case the other tests cannot cover: arbitrary lengths split at arbitrary
  // points, which is what a real file streaming over a data channel looks like.
  for (let round = 0; round < 60; round++) {
    const length = Math.floor(Math.random() * 3000);
    const bytes = new Uint8Array(length);
    webcrypto.getRandomValues(bytes);

    const hash = createSha256();
    let at = 0;
    while (at < length) {
      const take = 1 + Math.floor(Math.random() * 300);
      hash.update(bytes.subarray(at, Math.min(at + take, length)));
      at += take;
    }
    assert.equal(hash.digest(), await reference(bytes),
      `round ${round}: ${length} bytes in random chunks differs from crypto.subtle`);
  }
});

test('it accepts the shapes a file actually arrives in', async () => {
  const { createSha256, sha256Of } = await load();
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const expected = await reference(bytes);

  // A data channel hands over an ArrayBuffer; a file slice gives one too; a
  // subarray is a view with a non-zero offset, which is the easy one to get
  // wrong because its .buffer is the whole thing.
  assert.equal(sha256Of(bytes), expected);
  assert.equal(sha256Of(bytes.buffer), expected);

  const bigger = new Uint8Array([99, 99, 1, 2, 3, 4, 5, 6, 7, 8, 99]);
  const view = bigger.subarray(2, 10);
  assert.equal(view.length, 8);
  assert.equal(sha256Of(view), expected, 'a Uint8Array view must hash only its own bytes');

  const whole = createSha256();
  whole.update(new DataView(bytes.buffer));
  assert.equal(whole.digest(), expected);

  // A DataView over part of a larger buffer. This is the one that catches a
  // module reaching for .buffer and hashing everything behind the view — the
  // Uint8Array case above cannot, because it is passed straight through.
  const partial = createSha256();
  partial.update(new DataView(bigger.buffer, 2, 8));
  assert.equal(partial.digest(), expected, 'a DataView with an offset must hash only its own bytes');
});

test('the byte count is the file size, which the progress bar reads', async () => {
  const { createSha256 } = await load();
  const hash = createSha256();
  assert.equal(hash.bytes, 0);
  hash.update(new Uint8Array(100));
  assert.equal(hash.bytes, 100);
  hash.update(new Uint8Array(23));
  assert.equal(hash.bytes, 123);
});

test('asking for the digest twice gives the same answer, and adding more does not', async () => {
  const { createSha256 } = await load();
  const hash = createSha256();
  hash.update(bytesOf('abc'));
  const first = hash.digest();
  assert.equal(hash.digest(), first, 'a second call must not keep hashing the padding');
  // Quietly carrying on after the digest would produce a number that is not
  // the SHA-256 of anything.
  assert.throws(() => hash.update(bytesOf('more')), /already finished/);
});

test('a single changed byte changes the digest', async () => {
  const { sha256Of } = await load();
  // This is the whole promise of the feature: "identical to the original" has
  // to be able to come out false.
  const a = new Uint8Array(100000).fill(7);
  const b = a.slice();
  b[99999] = 8;
  assert.notEqual(sha256Of(a), sha256Of(b));
  // And a byte flipped in the middle, not just at the end.
  const c = a.slice();
  c[50000] ^= 1;
  assert.notEqual(sha256Of(a), sha256Of(c));
});

test('the length is encoded as 64 bits, so a file over 512 MB still hashes right', async () => {
  const { encodeBitLength } = await load();
  // At 512 MB (0x20000000 bytes) the bit count passes 2^32 and the high word
  // stops being zero. Every other test in this file hashes a few kilobytes, so
  // none of them would notice the high word being dropped — and the only thing
  // that ever gets near this size is video, which is the whole feature.
  //
  // Hashing 512 MB to find out would dominate the suite, so the arithmetic is
  // the unit under test. Reading the eight bytes back has to give the true bit
  // count, whatever the size.
  const read = (bytes) => {
    let n = 0;
    for (const b of bytes) n = n * 256 + b;
    return n;
  };

  const BOUNDARY = 0x20000000;
  for (const total of [0, 1, 55, 56, 64, 1000000, BOUNDARY - 1, BOUNDARY, BOUNDARY + 1,
    2 * BOUNDARY, 3 * BOUNDARY + 12345, 8 * BOUNDARY]) {
    assert.equal(read(encodeBitLength(total)), total * 8,
      `${total} bytes: the bit length does not survive being encoded`);
  }

  // Specifically: the high word must be used, and must be right.
  assert.deepEqual([...encodeBitLength(BOUNDARY).subarray(0, 4)], [0, 0, 0, 1],
    'at 512 MB the high word must be 1, not 0');
  assert.deepEqual([...encodeBitLength(BOUNDARY - 1).subarray(0, 4)], [0, 0, 0, 0]);
  assert.deepEqual([...encodeBitLength(4 * BOUNDARY).subarray(0, 4)], [0, 0, 0, 4],
    'a 2 GB video needs a high word of 4');
  // And the low word still carries the rest.
  assert.deepEqual([...encodeBitLength(BOUNDARY + 1)], [0, 0, 0, 1, 0, 0, 0, 8]);
  assert.equal(encodeBitLength(0).every((b) => b === 0), true);
});

test('a half-gigabyte file hashes the same as the platform says it should', async (t) => {
  // The test above checks the length arithmetic on its own; this one puts it
  // through the whole implementation at the size where it actually matters.
  // Node's own streaming SHA-256 is the reference, because crypto.subtle would
  // need the entire 512 MB as one buffer — which is the reason this module
  // exists at all.
  //
  // It is slow, and skipped unless asked for: VR_SLOW_TESTS=1 npm test
  if (process.env.VR_SLOW_TESTS !== '1') {
    t.skip('set VR_SLOW_TESTS=1 to hash 512 MB (takes a few seconds)');
    return;
  }
  const { createSha256 } = await load();
  const { createHash } = require('node:crypto');

  const TOTAL = 0x20000000; // exactly 512 MiB: the first size needing a high word
  const chunk = new Uint8Array(65536);
  for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 31 + 7) & 0xff;

  const mine = createSha256();
  const theirs = createHash('sha256');
  for (let at = 0; at < TOTAL; at += chunk.length) {
    mine.update(chunk);
    theirs.update(chunk);
  }
  assert.equal(mine.bytes, TOTAL);
  assert.equal(mine.digest(), theirs.digest('hex'),
    'a file over 512 MB hashes differently from the platform, so no video digest can be trusted');
});

test('isDigest accepts what the database accepts, and nothing else', async () => {
  const { isDigest, sha256Of } = await load();
  assert.equal(isDigest(sha256Of(bytesOf('abc'))), true);
  // The CHECK on project_items.sha256 is ^[0-9a-f]{64}$ — uppercase would be
  // refused by the database and would never compare equal anyway.
  assert.equal(isDigest('BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD'), false);
  assert.equal(isDigest('abc'), false);
  assert.equal(isDigest(''), false);
  assert.equal(isDigest(null), false);
  assert.equal(isDigest(`${'a'.repeat(63)}g`), false);
});
