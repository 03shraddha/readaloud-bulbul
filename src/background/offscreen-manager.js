/**
 * src/background/offscreen-manager.js
 *
 * Guarantees exactly one offscreen document (audio playback surface) exists
 * whenever background needs to talk to it, per shared_contracts §3/§9:
 *  - has-document check + a creation lock so concurrent callers never race
 *    chrome.offscreen.createDocument (which throws if one is already being
 *    created).
 *  - Waits for OFFSCREEN_READY before the first enqueue.
 *  - Recreates transparently if the document was torn down behind our back.
 *  - Closes it on session end.
 *
 * This module owns no session state; callers pass sessionId/rate for
 * OFFSCREEN_INIT re-sends whenever a (re)creation happens.
 */

import { OFFSCREEN_URL } from '../shared/constants.js';
import { MSG, TARGET, makeEnvelope, safeSendRuntimeMessage } from '../shared/messages.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('background:offscreen');

const READY_TIMEOUT_MS = 5000;

/** @type {Promise<void>|null} guards concurrent createDocument calls */
let creatingPromise = null;

/** @type {{resolve:Function}|null} */
let pendingReady = null;

/** @type {Promise<void>|null} */
let readyPromise = null;

/** Last {sessionId, rate} we sent as OFFSCREEN_INIT, so we know whether a
 * fresh document needs (re-)initializing. */
let lastInit = null;

/**
 * Bumped every time an OFFSCREEN_INIT actually goes out. OFFSCREEN_INIT
 * calls AudioQueue.reset(), which drops every blob the queue was holding --
 * including sentences background already counts as `dispatched` and will
 * therefore never fetch again. Callers compare this counter across an
 * `await ensureOffscreenReady()` to notice "the document I was talking to is
 * not the one I am talking to now" and re-seed it. See
 * Session.offscreenWasReinitialized().
 */
let initGeneration = 0;

/**
 * @returns {number} how many OFFSCREEN_INITs have been sent in this
 *   service-worker lifetime. Only differences matter, never the value.
 */
export function getOffscreenGeneration() {
  return initGeneration;
}

/** Single-flight guard for ensureOffscreenReady(), keyed by sessionId. */
let ensurePromise = null;
let ensureSessionId = null;

/**
 * @returns {Promise<boolean>}
 */
async function hasDocument() {
  if (!chrome.offscreen || typeof chrome.offscreen.hasDocument !== 'function') {
    log.warn('chrome.offscreen.hasDocument unavailable');
    return false;
  }
  try {
    return await chrome.offscreen.hasDocument();
  } catch (err) {
    log.error('hasDocument() failed', err);
    return false;
  }
}

function armReadyWait() {
  readyPromise = new Promise((resolve) => {
    pendingReady = { resolve };
  });
}

/**
 * Called by service-worker.js when the offscreen document announces
 * OFFSCREEN_READY.
 */
export function notifyOffscreenReady() {
  log.debug('OFFSCREEN_READY received');
  if (pendingReady) {
    pendingReady.resolve();
    pendingReady = null;
  }
}

/**
 * Wait for the current readyPromise to settle, or time out. A timeout is
 * non-fatal — callers proceed optimistically rather than deadlock the
 * session if the offscreen document is slow (or the ready message got lost).
 * @returns {Promise<void>}
 */
async function waitUntilReady() {
  if (!readyPromise) return;
  await Promise.race([
    readyPromise,
    new Promise((resolve) => setTimeout(resolve, READY_TIMEOUT_MS)),
  ]);
}

/**
 * Creates the offscreen document if one does not already exist. Safe to call
 * concurrently — races are serialized behind `creatingPromise`.
 * @returns {Promise<void>}
 */
async function createDocumentIfNeeded() {
  if (creatingPromise) {
    await creatingPromise;
    return;
  }

  creatingPromise = (async () => {
    if (await hasDocument()) return;
    armReadyWait();
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Plays synthesized sentence audio for read-aloud playback.',
      });
    } catch (err) {
      // Another context may have won the race between our hasDocument()
      // check and createDocument() call; that's fine as long as a document
      // now exists.
      const stillMissing = !(await hasDocument());
      if (stillMissing) {
        log.error('createDocument failed and no document exists', err);
        throw err;
      }
      log.debug('createDocument raced with another creator; document exists now');
    }
  })();

  try {
    await creatingPromise;
  } finally {
    creatingPromise = null;
  }
}

/**
 * Ensures exactly one offscreen document exists and has been sent an
 * OFFSCREEN_INIT for the given session. Idempotent and safe to call before
 * every enqueue — cheap when nothing needs to change.
 * @param {string} sessionId
 * @param {number} rate
 * @param {number} [startIndex] - the Sentence.index this session starts at;
 *   forwarded on OFFSCREEN_INIT so the audio queue seeds its cursor rather
 *   than inferring it from whichever sentence happens to synthesize first.
 * @returns {Promise<void>}
 */
export async function ensureOffscreenReady(sessionId, rate, startIndex) {
  // Session start fires several concurrent calls (one per in-flight prefetch
  // plus one from handleControlPlay). Without this single-flight guard each
  // one would independently observe "no document yet" and send its own
  // OFFSCREEN_INIT — and every OFFSCREEN_INIT resets the AudioQueue
  // (clearing the queue and wantsPlay), which can silently kill playback
  // right after it starts. This guard only dedupes calls that land while a
  // check is genuinely IN FLIGHT (see the `finally` below, which clears it
  // once settled) — it must never cache a stale "already checked" result
  // across calls, because chrome.offscreen documents can disappear on their
  // own (idle/memory-pressure teardown) without this module hearing about
  // it. A resume-from-pause that trusted a stale resolved promise here
  // would skip recreating a dead document and silently vanish the
  // subsequent AUDIO_PLAY into safeSendRuntimeMessage's ignored
  // "Receiving end does not exist" — status stuck on 'playing' forever with
  // no audio and no error surfaced anywhere.
  if (ensurePromise && ensureSessionId === sessionId) {
    return ensurePromise;
  }

  ensureSessionId = sessionId;
  ensurePromise = (async () => {
    const existed = await hasDocument();

    const safeStartIndex = Number.isFinite(startIndex) ? Math.max(0, Math.floor(startIndex)) : 0;

    if (!existed) {
      await createDocumentIfNeeded();
      await waitUntilReady();
      lastInit = { sessionId, rate };
      initGeneration += 1;
      await safeSendRuntimeMessage(
        makeEnvelope(MSG.OFFSCREEN_INIT, TARGET.OFFSCREEN, sessionId, {
          sessionId,
          rate,
          startIndex: safeStartIndex,
        })
      );
      return;
    }

    if (!lastInit || lastInit.sessionId !== sessionId) {
      lastInit = { sessionId, rate };
      initGeneration += 1;
      await safeSendRuntimeMessage(
        makeEnvelope(MSG.OFFSCREEN_INIT, TARGET.OFFSCREEN, sessionId, {
          sessionId,
          rate,
          startIndex: safeStartIndex,
        })
      );
    }
  })();

  try {
    await ensurePromise;
  } finally {
    // Always clear, success or failure — see the comment above the guard.
    // The next call (even for the same sessionId) must re-verify
    // hasDocument() rather than trust this result forever.
    ensurePromise = null;
    ensureSessionId = null;
  }
}

/**
 * Fire-and-forget send to the offscreen document. Does NOT ensure the
 * document exists — callers that need that guarantee should call
 * ensureOffscreenReady() first (prefetch-queue does, before every dispatch).
 * @param {object} envelope
 * @returns {Promise<any>}
 */
export async function sendToOffscreen(envelope) {
  return safeSendRuntimeMessage(envelope);
}

/**
 * Closes the offscreen document, if any. Call on session end so audio
 * resources (blobs, decoders) are released between reading sessions.
 * @returns {Promise<void>}
 */
export async function closeOffscreenDocument() {
  lastInit = null;
  ensurePromise = null;
  ensureSessionId = null;
  if (await hasDocument()) {
    try {
      await chrome.offscreen.closeDocument();
    } catch (err) {
      log.warn('closeDocument failed', err);
    }
  }
}
