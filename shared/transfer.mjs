// Sending a video straight from one of your devices to the other.
//
// WHY THIS IS NOT AN UPLOAD
//   A video export is hundreds of megabytes to a few gigabytes. This Supabase
//   project has about 1 GB of file storage for two apps, and ViralRadar keeps
//   to 300 MB of it (see shared/projects.mjs). One video would eat the lot. So
//   the video never goes to a server at all: the two devices open a WebRTC data
//   channel and the bytes go between them. All that reaches the database is a
//   row saying the video exists and which devices have it.
//
// WHY THERE IS A PROTOCOL HERE RATHER THAN IN THE BROWSER FILE
//   RTCPeerConnection cannot run in Node, so anything written next to it cannot
//   be tested. Everything that makes a decision therefore lives here, behind
//   four ports, and public/transfer.js is only the wiring:
//
//     signaling   send(msg) / onMessage(cb)   — Supabase Realtime broadcast
//     channel     send(data) / bufferedAmount / drain()  — the data channel
//     source      size / slice(from, to)      — the chosen File
//     sink        write(chunk) / close() / abort()  — disk, or a Blob
//
//   test/transfer.test.js wires a sender and a receiver together through fake
//   ports and runs whole transfers in Node, including a corrupted byte, a
//   cancel half way, and a stalled channel. That is the same trick the import
//   path uses with its storage port.
//
// WHAT IS PROMISED, AND WHAT IS NOT
//   Promised: the bytes that arrive are the bytes that left, and that is proved
//   rather than asserted — both ends compute the file's real SHA-256 as it
//   streams past and the digests are compared. Nothing is re-encoded, resized
//   or compressed; a chunk is a verbatim slice of the file.
//   Not promised: resuming. Cancelling is clean — the partial file is thrown
//   away and no row is written — but starting again starts from the beginning.

import { createSha256, isDigest } from './sha256.mjs';
import { formatBytes, safeFileName } from './projects.mjs';

// 16 KiB. The SCTP layer under a data channel will carry 64 KiB on current
// browsers and 16 KiB everywhere, and a transfer that corrupts or stalls on one
// device is worth far less than one that is slightly slower on all of them.
// With backpressure the channel stays full regardless, so this is not the limit
// on throughput.
export const CHUNK_BYTES = 16 * 1024;

// Stop filling the channel once a megabyte is queued, start again when it falls
// below a quarter of that. Without this, a loop that sends a 2 GB file as fast
// as it can queues the whole thing in memory and the tab dies — the send() call
// does not block.
export const HIGH_WATER = 1024 * 1024;
export const LOW_WATER = 256 * 1024;

// How long to wait for the two devices to find each other. On mobile data they
// often never will: carrier NAT needs a relay (TURN), and there is no free one.
export const CONNECT_TIMEOUT_MS = 15000;

// Above this, a phone that cannot stream to disk has to hold the whole file in
// memory before it can be saved.
export const BIG_FILE_BYTES = 1024 * 1024 * 1024;

// Google's public STUN servers. They only ever help the two devices work out
// their own addresses; no video goes anywhere near them. There is deliberately
// no TURN server: a relay would have to be paid for, and would carry every byte
// of every video.
export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/** The channel both devices sign in to. One per user, and private. */
export const deviceTopic = (userId) => `vr-devices-${String(userId ?? '')}`;

// ---------- the messages ----------
//
// Signalling goes over Supabase Realtime broadcast; these are its shapes. Every
// one is validated on arrival. The channel is private — only this user's own
// session can read or write it — but a malformed message from an older version
// of the app must not be able to take a screen down either.

export const SIGNAL = {
  INVITE: 'invite',
  ACCEPT: 'accept',
  DECLINE: 'decline',
  OFFER: 'offer',
  ANSWER: 'answer',
  ICE: 'ice',
  CANCEL: 'cancel',
};

/** Messages that travel on the data channel itself, alongside the chunks. */
export const WIRE = {
  META: 'meta',
  DONE: 'done',
  ABORT: 'abort',
};

const str = (v) => (typeof v === 'string' ? v : '');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Is this a signalling message worth acting on, and is it for me?
 *
 * Returns the message with its fields coerced, or null. Anything addressed to
 * another device is dropped here rather than in four separate handlers.
 */
export function readSignal(raw, myDeviceId) {
  if (!raw || typeof raw !== 'object') return null;
  const type = str(raw.type);
  if (!Object.values(SIGNAL).includes(type)) return null;

  const from = str(raw.from);
  const to = str(raw.to);
  const transferId = str(raw.transferId);
  if (!from || !transferId) return null;
  // Broadcast reaches every device on the channel, including the one that sent
  // it. Neither of those is a message for us.
  if (from === myDeviceId) return null;
  if (to && to !== myDeviceId) return null;

  return {
    type,
    from,
    to,
    transferId,
    name: str(raw.name),
    size: num(raw.size),
    mime: str(raw.mime),
    reason: str(raw.reason),
    canStream: raw.canStream === true,
    // Which project this video is for, if the sender attached one to it — an
    // id, never a folder name. The receiver looks up its OWN copy of that
    // project (the same row, since both devices share one account) and reads
    // ITS OWN local_folder_name off it; nothing about where the file lands on
    // this device is ever taken from the signal itself. See
    // shared/localfolder.mjs and actions.acceptVideo in public/app.js.
    projectId: str(raw.projectId),
    // sdp and ice are handed to the browser as they are; there is nothing
    // useful to validate about them here beyond their being present.
    sdp: raw.sdp && typeof raw.sdp === 'object' ? raw.sdp : null,
    ice: raw.ice && typeof raw.ice === 'object' ? raw.ice : null,
  };
}

/** The offer of a file, which the other device has to accept before anything else happens. */
export const invite = ({ transferId, from, to, name, size, mime, canStream, projectId }) => ({
  type: SIGNAL.INVITE,
  transferId,
  from,
  to,
  name: safeFileName(name),
  size: num(size),
  mime: str(mime),
  canStream: canStream === true,
  projectId: str(projectId),
});

/**
 * What the receiving device should ask before it says yes.
 *
 * Returns { ask, warning }. The warning is the one case where saying yes is a
 * genuinely bad idea: a file bigger than this device can stream to disk has to
 * be held in memory in one piece first, and on a phone that is how a tab dies
 * two minutes into a transfer with nothing to show for it.
 */
export function acceptPrompt({ name, size, from, canStream }) {
  const file = safeFileName(name) || 'a file';
  const ask = `${from || 'Your other device'} wants to send “${file}” (${formatBytes(size)}). Accept?`;
  if (!canStream && num(size) > BIG_FILE_BYTES) {
    return {
      ask,
      warning: `This browser cannot write a file straight to disk, so all ${formatBytes(size)} has to be held in memory`
        + ' before it can be saved. On a phone that usually fails near the end. Send it to a laptop instead,'
        + ' or use LocalSend over the same Wi-Fi.',
    };
  }
  return { ask, warning: '' };
}

/**
 * Should the SENDER warn before starting? Same question from the other side,
 * asked before anyone has waited for a transfer that cannot finish.
 */
export function sendWarning({ size, target }) {
  if (!target) return 'Pick a device to send it to.';
  if (target.canStream) return '';
  if (num(size) <= BIG_FILE_BYTES) return '';
  return `${target.device} cannot write a file straight to disk, so it has to hold all ${formatBytes(size)}`
    + ` in memory before saving. Files over ${formatBytes(BIG_FILE_BYTES)} usually fail that way.`
    + ' Send it to a laptop instead, or use LocalSend over the same Wi-Fi.';
}

// ---------- progress ----------

/**
 * Where a transfer has got to, in the words a person needs.
 *
 * Speed comes from a rolling window rather than from the average since the
 * start, because the useful question during a transfer is "is it still moving",
 * and an average over ten minutes answers that far too slowly.
 */
export function createProgress({ total, clock = Date.now, windowMs = 4000 }) {
  const samples = [];
  let done = 0;
  const startedAt = clock();

  return {
    add(bytes) {
      done += bytes;
      const now = clock();
      samples.push([now, done]);
      while (samples.length > 2 && now - samples[0][0] > windowMs) samples.shift();
    },
    get bytes() {
      return done;
    },
    read() {
      const now = clock();
      const span = samples.length >= 2 ? samples[samples.length - 1][0] - samples[0][0] : 0;
      const moved = samples.length >= 2 ? samples[samples.length - 1][1] - samples[0][1] : 0;
      const perSecond = span > 0 ? (moved / span) * 1000 : 0;
      const left = Math.max(0, num(total) - done);
      // No speed yet means no estimate, rather than an estimate of forever.
      const secondsLeft = perSecond > 0 ? Math.round(left / perSecond) : null;
      return {
        bytes: done,
        total: num(total),
        percent: num(total) > 0 ? Math.min(100, (done / num(total)) * 100) : 0,
        bytesPerSecond: perSecond,
        secondsLeft,
        elapsedMs: now - startedAt,
        text: progressText({ done, total: num(total), perSecond, secondsLeft }),
      };
    },
  };
}

/** "412 MB of 1.80 GB · 11 MB/s · about 2 min left" */
export function progressText({ done, total, perSecond, secondsLeft }) {
  const parts = [`${formatBytes(done)} of ${formatBytes(total)}`];
  if (perSecond > 0) parts.push(`${formatBytes(perSecond)}/s`);
  if (secondsLeft !== null && secondsLeft !== undefined) parts.push(`${formatDuration(secondsLeft)} left`);
  return parts.join(' · ');
}

/** Rounded the way a person would say it, not to the second. */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(num(seconds)));
  if (s < 10) return 'a few seconds';
  if (s < 60) return `${s} sec`;
  if (s < 90) return 'about a minute';
  if (s < 3600) return `about ${Math.round(s / 60)} min`;
  const hours = Math.floor(s / 3600);
  const mins = Math.round((s % 3600) / 60);
  return mins ? `about ${hours} h ${mins} min` : `about ${hours} h`;
}

// ---------- the two ends ----------

/**
 * Send a file down an open channel, and return its digest.
 *
 * The loop is the whole of it: slice, hash, send, and wait if the channel is
 * full. The hash is computed from the same bytes that are sent, in the same
 * order, so the digest describes what actually went out rather than what was
 * on disk when the transfer started.
 */
export async function sendFile({
  source,
  channel,
  onProgress = () => {},
  clock = Date.now,
  chunkBytes = CHUNK_BYTES,
  highWater = HIGH_WATER,
  cancelled = () => false,
}) {
  const total = num(source.size);
  const hash = createSha256();
  const progress = createProgress({ total, clock });

  channel.send(JSON.stringify({
    type: WIRE.META,
    name: safeFileName(source.name),
    size: total,
    mime: str(source.mime),
    chunkBytes,
  }));

  let at = 0;
  while (at < total) {
    if (cancelled()) {
      // Say so on the channel, so the other end throws its partial file away
      // rather than waiting for bytes that are not coming.
      channel.send(JSON.stringify({ type: WIRE.ABORT, reason: 'cancelled' }));
      throw new TransferCancelled('You stopped the transfer.');
    }

    // Backpressure. send() does not block, so without this the whole file is
    // queued in memory in a few seconds and the tab is gone.
    while (channel.bufferedAmount > highWater) {
      await channel.drain();
      if (cancelled()) {
        channel.send(JSON.stringify({ type: WIRE.ABORT, reason: 'cancelled' }));
        throw new TransferCancelled('You stopped the transfer.');
      }
    }

    const end = Math.min(at + chunkBytes, total);
    const chunk = await source.slice(at, end);
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    hash.update(bytes);
    channel.send(bytes);
    at = end;

    progress.add(bytes.length);
    onProgress(progress.read());
  }

  const sha256 = hash.digest();
  channel.send(JSON.stringify({ type: WIRE.DONE, sha256, size: total }));
  return { bytes: at, sha256 };
}

/**
 * Receive a file, writing it out as it arrives and hashing it on the way past.
 *
 * Nothing is kept in memory beyond one chunk: the sink either streams to disk
 * (File System Access) or collects the pieces for a Blob, and which of those it
 * is belongs to the browser wiring, not here.
 */
export function createReceiver({ sink, onProgress = () => {}, clock = Date.now, expect = null }) {
  const hash = createSha256();
  let meta = null;
  let progress = null;
  let settled = false;
  let resolve;
  let reject;
  const finished = new Promise((res, rej) => { resolve = res; reject = rej; });

  const fail = async (error) => {
    if (settled) return;
    settled = true;
    // Abort rather than close: a half-written file must not be left on disk
    // looking like a finished one.
    try { await sink.abort(error); } catch { /* the sink is already gone */ }
    reject(error);
  };

  return {
    finished,
    get meta() {
      return meta;
    },

    /** One message off the channel: a JSON control message, or a chunk. */
    async onMessage(data) {
      if (settled) return;
      try {
        if (typeof data === 'string') {
          const message = JSON.parse(data);

          if (message.type === WIRE.META) {
            meta = {
              name: safeFileName(message.name),
              size: num(message.size),
              mime: str(message.mime),
            };
            if (expect && expect.size && meta.size !== expect.size) {
              // The size agreed at invite time is what the person said yes to.
              throw new TransferFailed('The sending device changed the file half way through. Nothing was saved.');
            }
            progress = createProgress({ total: meta.size, clock });
            await sink.open(meta);
            onProgress(progress.read());
            return;
          }

          if (message.type === WIRE.ABORT) {
            throw new TransferCancelled(message.reason === 'cancelled'
              ? 'The sending device stopped the transfer.'
              : 'The sending device could not finish.');
          }

          if (message.type === WIRE.DONE) {
            if (!meta) throw new TransferFailed('The transfer ended before it started.');
            const received = hash.bytes;
            if (received !== meta.size) {
              throw new TransferFailed(
                `Only ${formatBytes(received)} of ${formatBytes(meta.size)} arrived. Nothing was saved.`,
              );
            }
            const mine = hash.digest();
            const verdict = compareDigests(message.sha256, mine);
            if (!verdict.ok) {
              // The bytes are wrong, so the file is wrong. Throwing it away is
              // the only honest outcome: a video that is 99.9% right is a video
              // that fails to play half way through.
              throw new TransferFailed(verdict.message);
            }
            settled = true;
            const saved = await sink.close(meta);
            resolve({ ...meta, sha256: mine, bytes: received, saved: saved ?? null });
            return;
          }
          return;
        }

        // Anything that is not a string is a piece of the file.
        if (!meta) throw new TransferFailed('Bytes arrived before the file was described. Nothing was saved.');
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (hash.bytes + bytes.length > meta.size) {
          throw new TransferFailed('More bytes arrived than the file is supposed to have. Nothing was saved.');
        }
        hash.update(bytes);
        await sink.write(bytes);
        progress.add(bytes.length);
        onProgress(progress.read());
      } catch (e) {
        await fail(e);
      }
    },

    /** The channel dropped, or the person pressed stop. */
    async stop(reason) {
      await fail(reason instanceof Error ? reason : new TransferCancelled(str(reason) || 'The transfer was stopped.'));
    },
  };
}

// ---------- the verdict ----------

export class TransferCancelled extends Error {}
export class TransferFailed extends Error {}

/**
 * The two digests, compared, with the answer in words.
 *
 * This is the one thing the feature exists to be able to say, so it says it
 * plainly and it never says it when it is not true. A missing digest is a
 * failure, not a pass: "we could not check" must never read as "it is fine".
 */
export function compareDigests(theirs, mine) {
  if (!isDigest(mine)) {
    return { ok: false, message: 'This device could not work out the file\'s digest, so the copy cannot be trusted. Nothing was saved.' };
  }
  if (!isDigest(theirs)) {
    return { ok: false, message: 'The sending device did not say what the file\'s digest should be, so the copy cannot be checked. Nothing was saved.' };
  }
  if (theirs !== mine) {
    return {
      ok: false,
      message: 'The copy does not match the original — some bytes arrived wrong. Nothing was saved. Try again.',
      expected: theirs,
      actual: mine,
    };
  }
  return { ok: true, message: '✓ Identical to original', digest: mine };
}

/** What to say when the two devices never managed to find each other. */
export function connectionFailureMessage(seconds = Math.round(CONNECT_TIMEOUT_MS / 1000)) {
  return `Could not connect the two devices within ${seconds} seconds.`
    + ' This usually means they are on different networks — mobile data in particular almost never works,'
    + ' because it needs a relay server and there is no free one.'
    // The fix for "no Wi-Fi to share": the hotspot becomes the network, so the
    // two devices are on the same one by definition — and the transfer still
    // goes straight between them, so turning this on spends none of the data
    // the hotspot itself runs on.
    + ' Turn on your phone\'s hotspot and connect the laptop to it, then try again — that still uses none of your mobile data.'
    // The other fix is for when they cannot share a network at all — two
    // locations, not two devices in one room — where no local-network trick
    // helps. LocalSend does not either: it has the same same-network
    // requirement this transfer does, so naming it here would send someone
    // straight back to this message with a second app installed.
    + ' If the devices are too far apart for that, send it to yourself instead: on Telegram, send it as a File, not as a video'
    + ' (a video gets compressed) — or upload it through the Google Drive app.';
}

/** The row that records a video exists, without the video. */
export function videoRefRow({ projectId, name, size, sha256, devices, fromDevice }) {
  if (!isDigest(sha256)) throw new Error('A video can only be recorded once its digest is known.');
  const held = [...new Set((devices || []).map((d) => String(d ?? '').trim()).filter(Boolean))].sort();
  return {
    project_id: projectId,
    kind: 'video_ref',
    file_name: safeFileName(name),
    size_bytes: num(size),
    sha256,
    devices: held,
    from_device: fromDevice || null,
  };
}

/** "1.80 GB · on Laptop and Phone · verified identical" */
export function videoRefSummary(item) {
  const i = item || {};
  const devices = Array.isArray(i.devices) ? i.devices.filter(Boolean) : [];
  const where = devices.length === 0 ? 'nowhere recorded'
    : devices.length === 1 ? `on ${devices[0]}`
      : `on ${devices.slice(0, -1).join(', ')} and ${devices[devices.length - 1]}`;
  return [formatBytes(i.size_bytes), where, isDigest(i.sha256) ? 'verified identical' : 'not verified'].join(' · ');
}
