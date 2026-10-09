// The browser half of device-to-device video transfer.
//
// This file is deliberately thin, and deliberately dull. RTCPeerConnection,
// Realtime presence and the File System Access API cannot run in Node, so
// nothing written next to them can be tested — which is precisely why every
// decision lives in shared/transfer.mjs instead, behind four ports, where
// test/transfer.test.js runs whole transfers including a corrupted byte and a
// cancel half way.
//
// What is left here is wiring:
//   presence       which of my devices are online, and can they stream to disk
//   signalling     offers, answers and ICE candidates over a private channel
//   the channel    an RTCDataChannel wrapped to look like the port
//   the source     a File wrapped to look like the port
//   the sink       disk via File System Access, or a Blob as the fallback
//
// If you are looking for "how does it decide X", it is not in this file.

import {
  CONNECT_TIMEOUT_MS, ICE_SERVERS, LOW_WATER, SIGNAL, TransferCancelled,
  connectionFailureMessage, createReceiver, deviceTopic, invite, readSignal, sendFile,
} from './shared/transfer.mjs';

// How often a stop is noticed while nothing is arriving. A transfer waiting on
// a connection, or on a sender that has gone quiet, has no other moment at
// which it could check — and a Stop button that does nothing until the next
// chunk is a Stop button that looks broken.
const STOP_POLL_MS = 200;

/** Run `onStop` once, as soon as `cancelled()` becomes true. Returns a clear-up. */
function watchForStop(cancelled, onStop) {
  if (!cancelled) return () => {};
  const timer = setInterval(() => {
    if (!cancelled()) return;
    clearInterval(timer);
    onStop();
  }, STOP_POLL_MS);
  return () => clearInterval(timer);
}

/** Can this browser write a file straight to disk, without holding it all first? */
export const canStreamToDisk = () => typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';

/**
 * A random id for this tab, for the length of this session.
 *
 * Not the device name: two tabs on the same laptop are two peers and have to be
 * told apart, and the name is a label a person chose and may well have typed on
 * both. The id is what the protocol addresses; the name is what it shows.
 */
export function newPeerId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- the ports ----------

/** A File, as the source port. */
export function fileSource(file) {
  return {
    name: file.name,
    mime: file.type || 'video/mp4',
    size: file.size,
    // A slice is read only when it is about to be sent, so a 2 GB file is never
    // in memory — this is the half of "no memory blowup" that the sender owns.
    slice: async (from, to) => new Uint8Array(await file.slice(from, to).arrayBuffer()),
  };
}

/** An RTCDataChannel, as the channel port. */
export function channelPort(dc) {
  dc.bufferedAmountLowThreshold = LOW_WATER;
  return {
    send: (data) => dc.send(data),
    get bufferedAmount() {
      return dc.bufferedAmount;
    },
    // Resolves when the channel has drained enough to take more. Without this
    // the send loop queues a whole file in memory, because send() never blocks.
    drain: () => new Promise((resolve, reject) => {
      if (dc.readyState !== 'open') {
        reject(new Error('The connection to the other device dropped part way through.'));
        return;
      }
      const done = () => {
        dc.removeEventListener('bufferedamountlow', done);
        resolve();
      };
      dc.addEventListener('bufferedamountlow', done, { once: true });
    }),
  };
}

/**
 * Where a received file lands.
 *
 * Two completely different mechanisms, picked by what the browser can do:
 *
 *   showSaveFilePicker   on a desktop. Each chunk is written straight to the
 *                        file the person chose, so a 4 GB video needs no more
 *                        memory than a 4 KB one. Abandoning the transfer calls
 *                        abort(), and the browser removes the partial file.
 *
 *   a Blob               on Android, where the API does not exist. The pieces
 *                        are collected and assembled at the end, which means
 *                        the whole file is in memory at least once. That is why
 *                        the sender warns before sending anything over 1 GB to
 *                        a device that reports it cannot stream.
 */
export async function pickSink(suggestedName) {
  if (canStreamToDisk()) {
    // Asked for before the transfer starts, because a file picker needs a
    // gesture and there will not be one twenty minutes later.
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'Video', accept: { 'video/*': ['.mp4', '.mov', '.mkv', '.webm'] } }],
    });
    let writable = null;
    return {
      kind: 'disk',
      async open() {
        writable = await handle.createWritable();
      },
      write: (chunk) => writable.write(chunk),
      async close() {
        await writable.close();
        return handle.name;
      },
      async abort() {
        // Leaves no partial file behind, which is what makes "nothing was
        // saved" true rather than merely said.
        if (writable) await writable.abort().catch(() => {});
        writable = null;
      },
    };
  }

  const parts = [];
  return {
    kind: 'memory',
    async open() {},
    async write(chunk) {
      // A copy, because the chunk came off the channel and is not ours to keep.
      parts.push(new Blob([chunk]));
    },
    async close(meta) {
      const blob = new Blob(parts, { type: meta.mime || 'video/mp4' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = meta.name || suggestedName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      parts.length = 0;
      return meta.name;
    },
    async abort() {
      parts.length = 0;
    },
  };
}

// ---------- the connection ----------

/**
 * Open a data channel to the other device.
 *
 * `polite` decides which side makes the offer: the sender does, because it is
 * the one that knows there is a file. Both ends trickle ICE candidates over the
 * signalling channel as they are found.
 *
 * Gives up after CONNECT_TIMEOUT_MS. On mobile data it usually will: carrier
 * NAT needs a relay, and there is no free TURN server. That is a real limit of
 * the design rather than a bug, so it is reported as one.
 */
export function connect({ signaling, transferId, me, peer, offering, cancelled, onState = () => {} }) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  let settled = false;
  let timer = null;
  let stopWatching = () => {};
  let resolveChannel;
  let rejectChannel;
  // A candidate can genuinely arrive before the description it belongs to —
  // trickle ICE starts the moment a local description is set, which on a fast
  // local network can be before this device has even sent its own offer, let
  // alone before the other device has processed it. addIceCandidate() throws
  // if there is no remote description yet, and the fix is not to ignore that
  // (losing the candidate for good, which can be the one candidate the two
  // devices actually needed) but to hold it until setRemoteDescription()
  // resolves, exactly as both SDP messages below do when they arrive.
  const pendingIce = [];

  const channel = new Promise((resolve, reject) => { resolveChannel = resolve; rejectChannel = reject; });

  const finish = (dc) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    stopWatching();
    resolveChannel(dc);
  };
  const fail = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    stopWatching();
    try { pc.close(); } catch { /* already closing */ }
    rejectChannel(error);
  };

  timer = setTimeout(() => fail(new Error(connectionFailureMessage())), CONNECT_TIMEOUT_MS);
  // Fifteen seconds is a long time to watch a Stop button do nothing, and this
  // is the phase most likely to be stopped: it is the one that often fails.
  stopWatching = watchForStop(cancelled, () => {
    signaling.send({ type: SIGNAL.CANCEL, transferId, from: me, to: peer });
    fail(new TransferCancelled('You stopped the transfer.'));
  });

  pc.addEventListener('icecandidate', (event) => {
    if (!event.candidate) return;
    signaling.send({ type: SIGNAL.ICE, transferId, from: me, to: peer, ice: event.candidate.toJSON() });
  });

  pc.addEventListener('connectionstatechange', () => {
    onState(pc.connectionState);
    if (['failed', 'closed'].includes(pc.connectionState)) {
      fail(new Error(connectionFailureMessage()));
    }
  });

  let dc = null;
  if (offering) {
    dc = pc.createDataChannel('vr-file', { ordered: true });
    dc.binaryType = 'arraybuffer';
    dc.addEventListener('open', () => finish(dc));
    dc.addEventListener('error', () => fail(new Error('The connection to the other device failed.')));
  } else {
    pc.addEventListener('datachannel', (event) => {
      dc = event.channel;
      dc.binaryType = 'arraybuffer';
      if (dc.readyState === 'open') finish(dc);
      else dc.addEventListener('open', () => finish(dc));
    });
  }

  /** Any ICE candidate that arrived before there was a remote description to add it to. */
  const flushPendingIce = async () => {
    while (pendingIce.length) {
      await pc.addIceCandidate(pendingIce.shift()).catch(() => {});
    }
  };

  /** Signalling messages for this transfer, handed in by the caller. */
  const handle = async (message) => {
    try {
      if (message.type === SIGNAL.OFFER && message.sdp) {
        await pc.setRemoteDescription(message.sdp);
        await flushPendingIce();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        signaling.send({ type: SIGNAL.ANSWER, transferId, from: me, to: peer, sdp: pc.localDescription.toJSON() });
        return;
      }
      if (message.type === SIGNAL.ANSWER && message.sdp) {
        await pc.setRemoteDescription(message.sdp);
        await flushPendingIce();
        return;
      }
      if (message.type === SIGNAL.ICE && message.ice) {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(message.ice).catch(() => {});
        } else {
          // Held until the offer or answer it arrived ahead of is applied —
          // see pendingIce above. Dropping it here is how a connection that
          // would otherwise have worked quietly never does.
          pendingIce.push(message.ice);
        }
        return;
      }
      if (message.type === SIGNAL.CANCEL) {
        fail(new Error('The other device stopped the transfer.'));
      }
    } catch (e) {
      fail(e);
    }
  };

  const start = async () => {
    if (!offering) return;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signaling.send({ type: SIGNAL.OFFER, transferId, from: me, to: peer, sdp: pc.localDescription.toJSON() });
  };

  return {
    channel,
    handle,
    start,
    close() {
      clearTimeout(timer);
      try { pc.close(); } catch { /* already closing */ }
    },
    get state() {
      return pc.connectionState;
    },
  };
}

// ---------- the two whole jobs ----------

/**
 * Send one file to one device, from the invite to the verified digest.
 *
 * Everything that decides anything — chunk size, backpressure, the digest
 * comparison — is in shared/transfer.mjs. This sequences it.
 */
export async function sendTo({ signaling, me, peer, file, onProgress = () => {}, onStage = () => {}, cancelled = () => false }) {
  const transferId = newPeerId();
  const source = fileSource(file);

  onStage('asking');
  signaling.send(invite({
    transferId, from: me, to: peer.id, name: file.name, size: file.size, mime: file.type, canStream: canStreamToDisk(),
  }));

  // Wait for the other device to say yes. Nothing is connected until it does,
  // so a declined offer costs nothing at all.
  const reply = await signaling.waitFor(
    (m) => m.transferId === transferId && [SIGNAL.ACCEPT, SIGNAL.DECLINE].includes(m.type),
    CONNECT_TIMEOUT_MS,
    () => `${peer.device} did not answer. Is ViralRadar open on it?`,
  );
  if (reply.type === SIGNAL.DECLINE) {
    throw new Error(reply.reason || `${peer.device} declined.`);
  }
  if (cancelled()) {
    signaling.send({ type: SIGNAL.CANCEL, transferId, from: me, to: peer.id });
    throw new TransferCancelled('You stopped the transfer.');
  }

  onStage('connecting');
  const session = connect({ signaling, transferId, me, peer: peer.id, offering: true, cancelled });
  const unsubscribe = signaling.onMessage((m) => {
    if (m.transferId === transferId) session.handle(m);
  });

  try {
    await session.start();
    const dc = await session.channel;
    onStage('sending');
    const result = await sendFile({
      source,
      channel: channelPort(dc),
      onProgress,
      cancelled,
    });
    // Let the last chunks actually leave before the channel is torn down.
    await waitForDrain(dc);
    return { ...result, transferId };
  } finally {
    unsubscribe();
    session.close();
  }
}

/**
 * Receive one file, after this device has already said yes.
 *
 * The sink is chosen BEFORE the accept is sent, because showSaveFilePicker()
 * needs a user gesture and there will not be one twenty minutes into a
 * transfer. Choosing where it goes is part of saying yes.
 */
export async function receiveFrom({
  signaling, me, peer, transferId, sink, expect,
  onProgress = () => {}, onStage = () => {}, cancelled = () => false,
}) {
  onStage('connecting');
  const session = connect({ signaling, transferId, me, peer, offering: false, cancelled });
  const unsubscribe = signaling.onMessage((m) => {
    if (m.transferId === transferId) session.handle(m);
  });

  // Sent only once there is somewhere for the file to go and someone listening
  // for the offer, so the sender's offer is never the first thing to arrive.
  signaling.send({ type: SIGNAL.ACCEPT, transferId, from: me, to: peer, canStream: canStreamToDisk() });

  let stopWatching = () => {};
  try {
    const dc = await session.channel;
    onStage('receiving');
    const receiver = createReceiver({ sink, onProgress, expect });
    dc.addEventListener('message', (event) => receiver.onMessage(event.data));
    dc.addEventListener('close', () => receiver.stop('The connection to the other device dropped.'));
    // A receiver only ever acts on a message, so a sender that has gone quiet
    // would leave Stop doing nothing at all. This is what makes it immediate —
    // and stop() aborts the sink, so no partial file is left behind.
    stopWatching = watchForStop(cancelled, () => {
      signaling.send({ type: SIGNAL.CANCEL, transferId, from: me, to: peer });
      receiver.stop(new TransferCancelled('You stopped the transfer.'));
    });
    return await receiver.finished;
  } finally {
    stopWatching();
    unsubscribe();
    session.close();
  }
}

/** Give the channel a moment to flush, so the last chunk is not cut off. */
function waitForDrain(dc, ms = 4000) {
  if (dc.bufferedAmount === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (dc.bufferedAmount === 0 || dc.readyState !== 'open' || Date.now() - started > ms) resolve();
      else setTimeout(tick, 50);
    };
    tick();
  });
}

export { deviceTopic, readSignal, SIGNAL };
