// GENERATED FILE - DO NOT EDIT.
// Copied from shared/sha256.mjs by scripts/sync-shared.mjs.
// Edit the original and run: npm run sync:shared
// SHA-256, computed a chunk at a time.
//
// WHY THIS EXISTS WHEN WEB CRYPTO ALREADY DOES SHA-256
//   crypto.subtle.digest() takes the whole message at once. A 2 GB video would
//   have to be in memory, as one ArrayBuffer, before a digest could begin — on
//   a phone that is the end of the tab. This one is fed 16 KB at a time as the
//   file streams past, so the memory it needs does not depend on the file size.
//
// WHY NOT A HASH OF HASHES
//   Hashing each chunk and hashing the results would also stream, and would be
//   a few lines. But it would not be the file's SHA-256, so it could not be
//   compared against anything outside this app. The whole point of showing a
//   digest is that it can be checked independently:
//     Windows   certutil -hashfile video.mp4 SHA256
//     macOS     shasum -a 256 video.mp4
//     Linux     sha256sum video.mp4
//   A number that only ViralRadar can produce would prove nothing.
//
// IS IT RIGHT?
//   Not a matter of opinion: test/sha256.test.js runs the published FIPS test
//   vectors through it, and then checks it against crypto.subtle.digest() on
//   random data at hundreds of random lengths, fed in random chunk sizes — so
//   the streaming path and the one-shot path have to agree byte for byte. The
//   padding edge cases (exactly 55, 56, 63, 64 bytes) are where a hand-written
//   SHA-256 goes wrong, and they are checked by name.

// The first 32 bits of the fractional parts of the cube roots of the first 64
// primes, as the standard specifies.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

// The first 32 bits of the fractional parts of the square roots of the first
// eight primes.
const INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

export const BLOCK_BYTES = 64;

/**
 * The message length, in BITS, as the eight big-endian bytes that end the
 * final block.
 *
 * Exported so it can be tested on its own, which is the only practical way:
 * the high word only stops being zero at 512 MB, and the alternative to a unit
 * test here is hashing half a gigabyte to find out. A silent mistake in this
 * one line would make every digest of a video wrong — and video is the only
 * thing that gets anywhere near that size.
 *
 * total * 8 passes 2^53 only at a petabyte, so the arithmetic is exact; what it
 * does not fit in is one 32-bit word, hence the split.
 */
export function encodeBitLength(total) {
  const bytes = new Uint8Array(8);
  const hi = Math.floor(total / 0x20000000);          // total * 8 / 2^32
  const lo = ((total % 0x20000000) * 8) >>> 0;        // the remaining low bits
  bytes[0] = (hi >>> 24) & 0xff;
  bytes[1] = (hi >>> 16) & 0xff;
  bytes[2] = (hi >>> 8) & 0xff;
  bytes[3] = hi & 0xff;
  bytes[4] = (lo >>> 24) & 0xff;
  bytes[5] = (lo >>> 16) & 0xff;
  bytes[6] = (lo >>> 8) & 0xff;
  bytes[7] = lo & 0xff;
  return bytes;
}

/**
 * A digest in progress. Feed it bytes with update(), ask for the answer once
 * with digest().
 *
 * It keeps one 64-byte block and eight 32-bit words, whatever the file size.
 */
export function createSha256() {
  const h = INIT.slice();
  const block = new Uint8Array(BLOCK_BYTES);
  const w = new Uint32Array(64);
  let blockLen = 0;
  // Bytes seen so far. A Number is exact to 2^53, which is nine petabytes:
  // past anything that could be sent over a data channel in one lifetime.
  let total = 0;
  let finished = null;

  function compress(bytes, offset) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h[0]; let b = h[1]; let c = h[2]; let d = h[3];
    let e = h[4]; let f = h[5]; let g = h[6]; let hh = h[7];

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }

  return {
    /** Add some bytes. Accepts a Uint8Array, an ArrayBuffer or any DataView. */
    update(data) {
      if (finished) throw new Error('This digest is already finished; make another.');
      const bytes = data instanceof Uint8Array
        ? data
        : new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer, data.byteOffset ?? 0, data.byteLength ?? undefined);
      total += bytes.length;

      let offset = 0;
      // Finish the partial block first, if there is one.
      if (blockLen > 0) {
        const want = Math.min(BLOCK_BYTES - blockLen, bytes.length);
        block.set(bytes.subarray(0, want), blockLen);
        blockLen += want;
        offset = want;
        if (blockLen < BLOCK_BYTES) return;
        compress(block, 0);
        blockLen = 0;
      }
      // Then whole blocks straight out of the input, with no copying.
      while (offset + BLOCK_BYTES <= bytes.length) {
        compress(bytes, offset);
        offset += BLOCK_BYTES;
      }
      // Whatever is left over waits for the next call.
      if (offset < bytes.length) {
        block.set(bytes.subarray(offset), 0);
        blockLen = bytes.length - offset;
      }
      return undefined;
    },

    /** The digest, as 64 lowercase hex characters. Safe to call more than once. */
    digest() {
      if (finished) return finished;

      // A single 1 bit, then zeros, then the length in bits as 64 big-endian
      // bits. The padding has to leave room for those eight bytes, which is why
      // a leftover of exactly 56 bytes needs a whole extra block rather than a
      // shorter pad — the case a hand-written SHA-256 gets wrong.
      const padLen = blockLen < 56 ? 56 - blockLen : 120 - blockLen;
      const tail = new Uint8Array(blockLen + padLen + 8);
      tail.set(block.subarray(0, blockLen), 0);
      tail[blockLen] = 0x80;

      // The length in bits, as 64 of them. Past 512 MB this needs both words,
      // which is why it is its own tested function.
      tail.set(encodeBitLength(total), tail.length - 8);

      for (let offset = 0; offset < tail.length; offset += BLOCK_BYTES) compress(tail, offset);

      let hex = '';
      for (let i = 0; i < 8; i++) hex += h[i].toString(16).padStart(8, '0');
      finished = hex;
      return finished;
    },

    /** Bytes hashed so far. The transfer UI shows this as progress. */
    get bytes() {
      return total;
    },
  };
}

/** The digest of one lot of bytes, for when there is no streaming involved. */
export function sha256Of(data) {
  const hash = createSha256();
  hash.update(data);
  return hash.digest();
}

/** Is this something that could be a SHA-256 digest at all? */
export const isDigest = (value) => /^[0-9a-f]{64}$/.test(String(value ?? ''));
